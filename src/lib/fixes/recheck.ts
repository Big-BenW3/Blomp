import type { Octokit } from "@octokit/rest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { events, flows, runs } from "@/db/schema";
import { getUserOctokit } from "@/lib/github/octokit";
import { commentOnPullRequest } from "@/lib/github/pr";
import { createWorkflowDispatcher, ingestBase } from "@/lib/scans/dispatch";
import { ScanStartError, startScan, type Dispatcher } from "@/lib/scans/start";
import { findFixByRecheckScan, loadFixContext, transitionFix, updateFix } from "./store";

export interface RecheckDeps {
  dispatch?: Dispatcher;
  octokit?: Octokit;
}

export type RecheckResult = { ok: true; scanId: string } | { ok: false; message: string };

/**
 * Starts Kane on the pull request's preview, for the one flow the fix is about. The state change comes first and
 * only one caller wins it, so a repeated webhook or a double tap cannot start two re-checks.
 */
export async function startRecheckForFix(
  fixId: string,
  target: { previewUrl: string; sha?: string | null },
  deps: RecheckDeps = {},
): Promise<RecheckResult> {
  const ctx = await loadFixContext(fixId);
  if (!ctx || !ctx.fix.prNumber) return { ok: false, message: "This fix has no pull request to re-check yet." };

  const claimed = await transitionFix(fixId, ["pr_open", "failed"], {
    status: "verifying",
    previewUrl: target.previewUrl,
    headSha: target.sha ?? ctx.fix.headSha,
    error: null,
  });
  if (!claimed) return { ok: false, message: "A re-check is already running or finished." };

  try {
    const { scanId } = await startScan({
      userId: ctx.repo.userId,
      repo: ctx.repo,
      dispatch: deps.dispatch ?? createWorkflowDispatcher(),
      trigger: "recheck",
      commitSha: target.sha ?? ctx.fix.headSha,
      targetUrl: target.previewUrl,
      flowIds: [ctx.run.flowId],
      allowConcurrent: true,
    });
    await updateFix(fixId, { recheckScanId: scanId });
    return { ok: true, scanId };
  } catch (err) {
    const message = err instanceof ScanStartError ? err.message : "Could not start the re-check. Try again in a moment.";
    if (!(err instanceof ScanStartError)) console.error("recheck failed to start", fixId, err);
    await updateFix(fixId, { status: "failed", error: message });
    return { ok: false, message };
  }
}

/**
 * Called when a scan ends. If it was a fix's re-check, record the result and tell the pull request:
 * all green means "Kane verified". Safe to call for any scan: it does nothing for the rest.
 */
export async function finalizeRecheck(scanId: string, deps: RecheckDeps = {}): Promise<void> {
  const fix = await findFixByRecheckScan(scanId);
  if (!fix || fix.status !== "verifying") return;

  const rows = await getDb().select({ verdict: runs.verdict }).from(runs).where(eq(runs.scanId, scanId));
  const passed = rows.length > 0 && rows.every((r) => r.verdict === "pass");
  const sawFail = rows.some((r) => r.verdict === "fail");
  const error = passed
    ? null
    : sawFail
      ? "Kane re-checked the preview and the flow still fails."
      : "Kane could not finish the re-check on the preview.";

  const done = await transitionFix(fix.id, ["verifying"], passed ? { status: "verified", error: null } : { status: "failed", error });
  if (!done) return;

  const ctx = await loadFixContext(fix.id);
  if (!ctx) return;
  const db = getDb();
  const [flow] = await db.select({ name: flows.name }).from(flows).where(eq(flows.id, ctx.run.flowId));
  const flowName = flow?.name ?? "the flow";

  if (passed) {
    await db.insert(events).values({
      userId: ctx.repo.userId,
      repoId: ctx.repo.id,
      kind: "fix_verified",
      payload: { fixId: fix.id, runId: ctx.run.id, prUrl: fix.prUrl, scanId },
    });
  }

  if (!fix.prNumber) return;
  try {
    const octokit = deps.octokit ?? (await getUserOctokit(ctx.repo.userId));
    const [owner, name] = ctx.repo.fullName.split("/");
    const base = ingestBase();
    const link = base ? `\n\n[See the re-check](${base}/repos/${ctx.repo.fullName}/scans/${scanId})` : "";
    await commentOnPullRequest(octokit, {
      owner,
      name,
      number: fix.prNumber,
      body: passed
        ? `✅ **Kane verified.** Kane re-ran "${flowName}" on this pull request's preview and it passed.${link}`
        : `❌ Kane re-ran "${flowName}" on this pull request's preview and it did not pass.${link}`,
    });
  } catch (err) {
    console.error("could not comment on the pull request", fix.id, err);
  }
}
