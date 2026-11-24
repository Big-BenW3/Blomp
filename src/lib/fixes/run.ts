import type { Octokit } from "@octokit/rest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { events, flows, repos } from "@/db/schema";
import { FixError, generateFix } from "@/lib/agent/fix";
import { createNvidiaChat, LlmError, type ChatFn } from "@/lib/agent/llm";
import { getUserOctokit } from "@/lib/github/octokit";
import { ensureDeploymentWebhook, openFixPullRequest } from "@/lib/github/pr";
import { getRepo, listRepoFiles, readRepoFile } from "@/lib/github/repos";
import { ingestBase } from "@/lib/scans/dispatch";
import { loadFixContext, updateFix } from "./store";

export interface RunFixDeps {
  chat?: ChatFn;
  octokit?: Octokit;
  /** Where GitHub should send deployment events. Defaults to the app's own /api/webhooks/github. */
  webhookUrl?: string;
  webhookSecret?: string;
}

/** A readable reason for the user; anything unexpected becomes a generic line and is logged in full. */
export function fixErrorMessage(err: unknown): string {
  if (err instanceof FixError || err instanceof LlmError) return err.message;
  const status = (err as { status?: number })?.status;
  if (status === 401) return "GitHub no longer accepts your sign-in. Sign out, sign back in and try again.";
  if (status === 403 || status === 404) return "GitHub would not let Blomp open a pull request on this repo. Check that you can push to it, then try again.";
  if (status === 422) return "GitHub rejected the pull request. Try again in a moment.";
  return "Something went wrong while writing the fix. Try again.";
}

const webhookUrl = (): string | undefined => {
  const base = ingestBase();
  return base ? `${base}/api/webhooks/github` : undefined;
};

/** The whole fix: write it with the model, open the pull request, and wait for the preview. */
export async function runFix(fixId: string, deps: RunFixDeps = {}): Promise<void> {
  const ctx = await loadFixContext(fixId);
  if (!ctx || ctx.fix.status !== "drafting") return;
  const { fix, run, repo } = ctx;
  const db = getDb();

  try {
    const octokit = deps.octokit ?? (await getUserOctokit(repo.userId));
    const [owner, name] = repo.fullName.split("/");
    const gh = await getRepo(octokit, owner, name);
    const [flow] = await db.select().from(flows).where(eq(flows.id, run.flowId));

    const { paths } = await listRepoFiles(octokit, gh);
    const { summary, edits } = await generateFix({
      fullName: gh.fullName,
      paths,
      readFile: (p) => readRepoFile(octokit, gh, p, 20_000),
      chat: deps.chat ?? createNvidiaChat(),
      evidence: {
        flowName: flow?.name ?? "this flow",
        objective: flow?.objective,
        oneLiner: run.oneLiner,
        failingStep: run.failingStep,
        rootCause: run.triage?.rootCause ?? run.triage?.title,
        suggestedFix: run.triage?.suggestedFix,
        consoleErrors: run.consoleErrors,
        networkErrors: run.networkErrors,
      },
    });

    // Set the webhook up before the pull request exists, so the preview's "deployed" event cannot be missed.
    const hookUrl = deps.webhookUrl ?? webhookUrl();
    const secret = deps.webhookSecret ?? process.env.WEBHOOK_SECRET;
    if (hookUrl && secret) {
      try {
        const id = await ensureDeploymentWebhook(octokit, { owner: gh.owner, name: gh.name, url: hookUrl, secret });
        if (id !== repo.webhookId) await db.update(repos).set({ webhookId: id }).where(eq(repos.id, repo.id));
      } catch (err) {
        console.error("could not set up the deployment webhook", gh.fullName, err);
      }
    }

    const flowName = flow?.name ?? "a flow";
    const seen = run.oneLiner ?? run.failingStep ?? "the flow did not pass";
    const pr = await openFixPullRequest(octokit, {
      owner: gh.owner,
      name: gh.name,
      defaultBranch: gh.defaultBranch,
      branch: `blomp/fix-${fix.id.slice(0, 8)}`,
      title: `Fix: ${flowName}`,
      commitMessage: `fix: ${flowName} (found by Kane)\n\n${summary}`,
      files: edits,
      body: [
        "Blomp opened this because Kane found a failing flow on the live site.",
        "",
        `**Flow:** ${flowName}`,
        `**What Kane saw:** ${seen}`,
        `**What changed:** ${summary}`,
        "",
        "Blomp will re-check this pull request's preview with Kane and comment here when it passes.",
      ].join("\n"),
    });

    await updateFix(fix.id, { status: "pr_open", branch: pr.branch, prNumber: pr.prNumber, prUrl: pr.prUrl, headSha: pr.headSha, summary, error: null });
    await db.insert(events).values({
      userId: repo.userId,
      repoId: repo.id,
      kind: "fix_opened",
      payload: { fixId: fix.id, runId: run.id, prUrl: pr.prUrl, prNumber: pr.prNumber },
    });
  } catch (err) {
    console.error("fix failed", fixId, err);
    await updateFix(fixId, { status: "failed", error: fixErrorMessage(err) });
  }
}
