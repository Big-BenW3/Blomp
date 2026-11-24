import { z } from "zod";
import { extractJson, LlmError, type ChatFn, type ChatMessage } from "./llm";

export const MAX_FIX_FILES = 3;
const MAX_FILE_BYTES = 60_000;
const MAX_CANDIDATES = 60;
const MAX_CANDIDATE_CHARS = 20_000;
const SHOWN_FILES = 4;
const MAX_PROMPT_CHARS = 36_000;

export const fixSchema = z.object({
  summary: z.string().trim().min(10).max(500),
  files: z
    .array(z.object({ path: z.string().trim().min(1).max(300), content: z.string().min(1).max(MAX_FILE_BYTES) }))
    .min(1)
    .max(MAX_FIX_FILES),
});
export type FixProposal = z.infer<typeof fixSchema>;

export class FixError extends Error {
  constructor(
    message: string,
    readonly kind: "bad_output" | "llm" | "no_files" | "guard",
  ) {
    super(message);
    this.name = "FixError";
  }
}

/** What Kane learned about the failure; everything the model gets to see besides the code. */
export interface FixEvidence {
  flowName: string;
  objective?: string;
  oneLiner?: string | null;
  failingStep?: string | null;
  rootCause?: string | null;
  suggestedFix?: string | null;
  consoleErrors: string[];
  networkErrors: string[];
}

const SOURCE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|html|css|py|rb|php)$/i;
const SKIP = /(^|\/)(node_modules|\.next|dist|build|coverage|\.git|\.github|public|\.vercel)\//;
const LOCK = /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;
/** Paths the fixer must never touch, even if the model asks: CI, secrets, lockfiles, git internals. */
const FORBIDDEN = /(^|\/)(\.github|\.git|node_modules)(\/|$)|(^|\/)\.env|(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;

const STOP = new Set(["that", "this", "with", "from", "have", "should", "would", "could", "page", "when", "then", "into", "after", "before", "does", "were", "there", "their", "which", "about", "visible", "shown", "button", "click", "confirm"]);

/** Words worth looking for in source files, plus longer phrases quoted in the evidence. */
export function evidenceTerms(evidence: FixEvidence): { words: string[]; phrases: string[] } {
  const text = [
    evidence.flowName,
    evidence.objective,
    evidence.oneLiner,
    evidence.failingStep,
    evidence.rootCause,
    evidence.suggestedFix,
    ...evidence.consoleErrors.slice(0, 3),
    ...evidence.networkErrors.slice(0, 3),
  ]
    .filter(Boolean)
    .join("\n");
  const phrases = [...text.matchAll(/["'“‘`]([^"'”’`\n]{8,80})["'”’`]/g)].map((m) => m[1].trim().toLowerCase());
  const words = [...new Set(text.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [])].filter((w) => !STOP.has(w));
  return { words: words.slice(0, 60), phrases: [...new Set(phrases)].slice(0, 10) };
}

/** Which files look related to the failure: quoted messages found in code count most, then shared words. */
export function scoreFile(path: string, content: string, terms: { words: string[]; phrases: string[] }): number {
  const lower = content.toLowerCase();
  const lowerPath = path.toLowerCase();
  let score = 0;
  for (const phrase of terms.phrases) if (lower.includes(phrase)) score += 12;
  for (const word of terms.words) {
    const hits = lower.split(word).length - 1;
    if (hits > 0) score += Math.min(hits, 3);
    if (lowerPath.includes(word)) score += 2;
  }
  return score;
}

export interface FixInput {
  fullName: string;
  paths: string[];
  readFile: (path: string) => Promise<string | undefined>;
  evidence: FixEvidence;
  chat: ChatFn;
}

/** Reads the likeliest source files and keeps the best matches for the evidence. */
export async function pickRelevantFiles(input: Pick<FixInput, "paths" | "readFile" | "evidence">): Promise<Array<{ path: string; text: string }>> {
  const candidates = input.paths
    .filter((p) => SOURCE.test(p) && !SKIP.test(p) && !LOCK.test(p))
    .sort((a, b) => Number(/^src\/|^app\//.test(b)) - Number(/^src\/|^app\//.test(a)) || a.split("/").length - b.split("/").length || a.localeCompare(b))
    .slice(0, MAX_CANDIDATES);
  const terms = evidenceTerms(input.evidence);

  const read = await Promise.all(
    candidates.map(async (path) => {
      const text = await input.readFile(path);
      return text ? { path, text } : undefined;
    }),
  );
  const files = read.filter((f): f is { path: string; text: string } => Boolean(f) && (f as { text: string }).text.length <= MAX_CANDIDATE_CHARS);
  const ranked = files
    .map((f) => ({ ...f, score: scoreFile(f.path, f.text, terms) }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const picked: Array<{ path: string; text: string }> = [];
  let total = 0;
  for (const f of ranked) {
    if (picked.length >= SHOWN_FILES || total + f.text.length > MAX_PROMPT_CHARS) continue;
    picked.push({ path: f.path, text: f.text });
    total += f.text.length;
  }
  return picked;
}

/** Normalises a model-supplied path, or returns undefined when it could point outside the repo. */
export function cleanPath(path: string): string | undefined {
  const p = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p || p.startsWith("/") || p.split("/").some((seg) => seg === ".." || seg === "")) return undefined;
  return p;
}

/**
 * The safety net between the model and the user's repo: only files we showed it may change, never CI or secrets,
 * never a no-op, and a file that shrank to a fragment is treated as a cut-off answer.
 */
export function checkEdits(proposal: FixProposal, originals: Map<string, string>): { path: string; content: string }[] {
  if (proposal.files.length > MAX_FIX_FILES) throw new FixError(`The fix changed more than ${MAX_FIX_FILES} files`, "guard");
  const seen = new Set<string>();
  const out: { path: string; content: string }[] = [];
  for (const f of proposal.files) {
    const path = cleanPath(f.path);
    if (!path) throw new FixError(`The fix used an unsafe path (${f.path})`, "guard");
    if (FORBIDDEN.test(path)) throw new FixError(`The fix tried to change ${path}, which is off limits`, "guard");
    const original = originals.get(path);
    if (original === undefined) throw new FixError(`The fix changed ${path}, which was not one of the files it was given`, "guard");
    if (seen.has(path)) throw new FixError(`The fix listed ${path} twice`, "guard");
    seen.add(path);
    if (f.content === original) throw new FixError(`The fix left ${path} unchanged`, "guard");
    if (original.length > 500 && f.content.length < original.length * 0.4) {
      throw new FixError(`The fix cut ${path} down to a fragment`, "guard");
    }
    out.push({ path, content: f.content });
  }
  return out;
}

const SYSTEM = `You are a careful senior engineer. An automated browser test (Kane) ran a user journey on a live website and it failed. You are given what Kane saw and the source files most likely involved. Fix the bug with the smallest change that works.

Rules:
- Change at most ${MAX_FIX_FILES} files, and only files you were given. Never add, rename or delete files.
- Return the COMPLETE new content of every file you change, not a diff and not a fragment. Keep the existing style and everything you did not need to change.
- Never touch CI workflows, lockfiles, environment files or tests.
- If the test itself looks wrong rather than the app, still make the most defensible small fix in the app.
- "summary" is one or two plain sentences for the site owner: what was wrong and what you changed.
- Answer with JSON only, no prose, exactly: {"summary":"...","files":[{"path":"...","content":"..."}]}`;

function evidenceBlock(e: FixEvidence): string {
  const lines = [
    `Flow that failed: ${e.flowName}`,
    e.objective ? `What the flow does: ${e.objective}` : "",
    e.oneLiner ? `Kane's summary: ${e.oneLiner}` : "",
    e.failingStep ? `Failing step: ${e.failingStep}` : "",
    e.rootCause ? `Kane's root cause: ${e.rootCause}` : "",
    e.suggestedFix ? `Kane's suggested fix: ${e.suggestedFix}` : "",
    e.consoleErrors.length ? `Browser console errors:\n${e.consoleErrors.slice(0, 5).join("\n")}` : "",
    e.networkErrors.length ? `Failed network requests:\n${e.networkErrors.slice(0, 5).join("\n")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** Reads the likely files, asks the model for whole-file edits, checks them, and retries once on a bad answer. */
export async function generateFix(input: FixInput): Promise<{ summary: string; edits: { path: string; content: string }[] }> {
  const files = await pickRelevantFiles(input);
  if (files.length === 0) {
    throw new FixError("Blomp could not find the code behind this failure in the repo.", "no_files");
  }
  const originals = new Map(files.map((f) => [f.path, f.text]));
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: [`Repository: ${input.fullName}`, "", evidenceBlock(input.evidence), ...files.map((f) => `\n--- ${f.path} ---\n${f.text}`)].join("\n"),
    },
  ];

  let lastProblem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let answer: string;
    try {
      answer = await input.chat(messages);
    } catch (err) {
      if (err instanceof LlmError) throw new FixError(err.message, "llm");
      throw err;
    }
    try {
      const parsed = fixSchema.safeParse(extractJson(answer));
      if (parsed.success) return { summary: parsed.data.summary, edits: checkEdits(parsed.data, originals) };
      lastProblem = parsed.error.issues.map((i) => `${i.path.join(".") || "answer"}: ${i.message}`).join("; ");
    } catch (err) {
      lastProblem = (err as Error).message;
    }
    messages.push(
      { role: "assistant", content: answer },
      { role: "user", content: `That answer was not usable (${lastProblem}). Reply again with only the JSON object in the required shape.` },
    );
  }
  throw new FixError(`The model did not return a usable fix (${lastProblem}). Try again.`, "bad_output");
}
