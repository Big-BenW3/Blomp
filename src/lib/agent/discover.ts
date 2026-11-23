import { z } from "zod";
import { extractJson, LlmError, type ChatFn, type ChatMessage } from "./llm";

export const MAX_FLOWS = 5;
export const MIN_FLOWS = 3;

export const flowProposal = z.object({
  name: z.string().trim().min(3).max(60),
  objective: z.string().trim().min(15).max(400),
  path: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^\/[^\s]*$/, "path must start with / and contain no spaces"),
});

export const proposalSchema = z
  .object({ flows: z.array(flowProposal).min(MIN_FLOWS).max(MAX_FLOWS) })
  .refine((v) => new Set(v.flows.map((f) => f.name.toLowerCase())).size === v.flows.length, {
    message: "flow names must be different from each other",
  });

export type FlowProposal = z.infer<typeof flowProposal>;

export class DiscoveryError extends Error {
  constructor(
    message: string,
    readonly kind: "bad_output" | "llm" | "no_files",
  ) {
    super(message);
    this.name = "DiscoveryError";
  }
}

const MAX_FILES = 14;
const MAX_FILE_CHARS = 5000;
const MAX_TOTAL_CHARS = 42_000;
const MAX_TREE_LINES = 150;

const SKIP = /(^|\/)(node_modules|\.next|dist|build|coverage|\.git|\.github|public|__tests__|tests?|e2e)\//;
const LOCK = /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;

/**
 * Chooses the files most likely to say what the site does: manifest and readme first, then route files
 * (the pages and API handlers), then layout, middleware and config. Shallower routes rank higher.
 */
export function pickKeyFiles(paths: string[]): string[] {
  const usable = paths.filter((p) => !SKIP.test(p) && !LOCK.test(p));
  const score = (p: string): number => {
    const depth = p.split("/").length;
    if (p === "package.json") return 0;
    if (/^readme(\.md)?$/i.test(p)) return 1;
    if (/(^|\/)(app|pages)\/.*(page|index)\.(tsx|jsx|ts|js|mdx)$/.test(p)) return 10 + depth;
    if (/(^|\/)(app|pages)\/.*route\.(ts|js)$/.test(p)) return 30 + depth;
    if (/(^|\/)(middleware|proxy)\.(ts|js)$/.test(p)) return 45;
    if (/(^|\/)(app|pages)\/(_app|layout)\.(tsx|jsx|ts|js)$/.test(p) || /(^|\/)app\/layout\.(tsx|jsx)$/.test(p)) return 50;
    if (/(^|\/)(index|main|app)\.(html|tsx|jsx|vue|svelte)$/.test(p)) return 55;
    if (/(^|\/)src\/.*\.(tsx|jsx|vue|svelte)$/.test(p) && /(login|signup|sign-up|signin|checkout|cart|auth|form)/i.test(p)) return 60 + depth;
    return Infinity;
  };
  return usable
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => Number.isFinite(x.s))
    .sort((a, b) => a.s - b.s || a.p.localeCompare(b.p))
    .slice(0, MAX_FILES)
    .map((x) => x.p);
}

export interface DiscoverInput {
  fullName: string;
  prodUrl?: string;
  paths: string[];
  readFile: (path: string) => Promise<string | undefined>;
  chat: ChatFn;
}

const SYSTEM = `You are a senior QA engineer. You read a web app's source and propose the user journeys most worth checking in a real browser against the live site.

Rules:
- Propose between ${MIN_FLOWS} and ${MAX_FLOWS} flows, most important first (sign-up, login, checkout, search, creating something, and so on). Only flows the code shows really exist.
- "objective" is one plain-English instruction a browser agent can carry out, ending with what must be visible when it works. Example: "Sign up with a new email and password, then confirm a welcome message is shown."
- Never invent credentials, API keys or accounts. If a flow needs an account, have it create one.
- "path" is the page the flow starts on, starting with "/".
- Do not propose flows that need email links, file uploads, payments with real cards, captchas or a mobile device.
- Answer with JSON only, no prose, exactly: {"flows":[{"name":"...","objective":"...","path":"/..."}]}`;

function buildUserPrompt(input: DiscoverInput, files: Array<{ path: string; text: string }>): string {
  const tree = input.paths.filter((p) => !SKIP.test(p) && !LOCK.test(p)).slice(0, MAX_TREE_LINES);
  const parts = [
    `Repository: ${input.fullName}`,
    input.prodUrl ? `Live site: ${input.prodUrl}` : "Live site: unknown",
    `\nFile tree (${tree.length} of ${input.paths.length} files shown):\n${tree.join("\n")}`,
    ...files.map((f) => `\n--- ${f.path} ---\n${f.text}`),
  ];
  return parts.join("\n");
}

/** Reads the repo's key files, asks the model for 3 to 5 flows, validates, and retries once on bad output. */
export async function discoverFlows(input: DiscoverInput): Promise<FlowProposal[]> {
  const picked = pickKeyFiles(input.paths);
  if (picked.length === 0) {
    throw new DiscoveryError(
      "No pages or app files found in this repo. Blomp works on web apps (for example a Next.js site).",
      "no_files",
    );
  }

  const files: Array<{ path: string; text: string }> = [];
  let total = 0;
  for (const path of picked) {
    if (total >= MAX_TOTAL_CHARS) break;
    const text = await input.readFile(path);
    if (!text) continue;
    const clipped = text.slice(0, Math.min(MAX_FILE_CHARS, MAX_TOTAL_CHARS - total));
    files.push({ path, text: clipped });
    total += clipped.length;
  }

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: buildUserPrompt(input, files) },
  ];

  let lastProblem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let answer: string;
    try {
      answer = await input.chat(messages);
    } catch (err) {
      if (err instanceof LlmError) throw new DiscoveryError(err.message, "llm");
      throw err;
    }

    try {
      const parsed = proposalSchema.safeParse(extractJson(answer));
      if (parsed.success) return parsed.data.flows;
      lastProblem = parsed.error.issues.map((i) => `${i.path.join(".") || "answer"}: ${i.message}`).join("; ");
    } catch (err) {
      lastProblem = (err as Error).message;
    }
    messages.push(
      { role: "assistant", content: answer },
      {
        role: "user",
        content: `That answer was not usable (${lastProblem}). Reply again with only the JSON object in the required shape.`,
      },
    );
  }
  throw new DiscoveryError(`The model did not return usable flows (${lastProblem}). Try again.`, "bad_output");
}
