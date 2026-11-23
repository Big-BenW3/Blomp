import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { events, flows, repos, runSteps, runs, scans } from "@/db/schema";
import { resolveVerdict } from "@/lib/kane/ndjson";
import { summarize, type RunVerdict } from "@/lib/kane/score";
import type { IngestEvent } from "./schema";

export class NotFoundError extends Error {}

async function ensureRun(scanId: string, flowId: string): Promise<string> {
  const db = getDb();
  const [scan] = await db.select({ repoId: scans.repoId }).from(scans).where(eq(scans.id, scanId));
  if (!scan) throw new NotFoundError("scan not found");
  const [flow] = await db
    .select({ id: flows.id })
    .from(flows)
    .where(and(eq(flows.id, flowId), eq(flows.repoId, scan.repoId)));
  if (!flow) throw new NotFoundError("flow not found for this scan's repo");

  await db.insert(runs).values({ scanId, flowId }).onConflictDoNothing();
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.scanId, scanId), eq(runs.flowId, flowId)));
  return row.id;
}

/** Applies one signed, validated runner event. Every branch is idempotent: the runner may retry. */
export async function applyIngest(event: IngestEvent): Promise<void> {
  const db = getDb();

  switch (event.kind) {
    case "scan_start": {
      const updated = await db
        .update(scans)
        .set({ status: "running", startedAt: new Date(), workflowRunId: event.workflowRunId ?? null })
        .where(eq(scans.id, event.scanId))
        .returning({ id: scans.id });
      if (updated.length === 0) throw new NotFoundError("scan not found");
      return;
    }

    case "run_start": {
      await ensureRun(event.scanId, event.flowId);
      return;
    }

    case "step": {
      const runId = await ensureRun(event.scanId, event.flowId);
      await db
        .insert(runSteps)
        .values({ runId, idx: event.idx, status: event.status, remark: event.remark })
        .onConflictDoNothing();
      return;
    }

    case "run_end": {
      const runId = await ensureRun(event.scanId, event.flowId);
      const { verdict, reason } = resolveVerdict(event.exitCode, event.end);
      await db
        .update(runs)
        .set({
          verdict,
          exitCode: event.exitCode,
          oneLiner: event.end?.oneLiner ?? null,
          reason: event.end?.reason ?? reason,
          failingStep: verdict === "fail" ? (event.failingStep ?? null) : null,
          credits: event.end?.credits ?? null,
          testUrl: event.end?.testUrl ?? null,
          consoleErrors: event.consoleErrors,
          networkErrors: event.networkErrors,
          finishedAt: new Date(),
        })
        .where(eq(runs.id, runId));
      return;
    }

    case "scan_end": {
      // A flow that never reported an end (runner crash) is unknown, never a silent pass.
      await db
        .update(runs)
        .set({ verdict: "unknown", reason: "Runner ended before this flow finished", finishedAt: new Date() })
        .where(and(eq(runs.scanId, event.scanId), eq(runs.verdict, "pending")));

      const rows = await db.select({ verdict: runs.verdict }).from(runs).where(eq(runs.scanId, event.scanId));
      const s = summarize(rows.map((r) => r.verdict as RunVerdict));

      const [scan] = await db
        .update(scans)
        .set({
          status: "done",
          score: s.score,
          passed: s.passed,
          failed: s.failed,
          unknown: s.unknown,
          finishedAt: new Date(),
        })
        .where(eq(scans.id, event.scanId))
        .returning({ repoId: scans.repoId });
      if (!scan) throw new NotFoundError("scan not found");

      const [repo] = await db.select({ userId: repos.userId }).from(repos).where(eq(repos.id, scan.repoId));
      if (repo) {
        if (s.score !== null) await db.update(repos).set({ lastScore: s.score }).where(eq(repos.id, scan.repoId));
        await db.insert(events).values({
          userId: repo.userId,
          repoId: scan.repoId,
          kind: "scan_done",
          payload: { scanId: event.scanId, ...s },
        });
      }
      return;
    }

    case "scan_error": {
      const updated = await db
        .update(scans)
        .set({ status: "error", finishedAt: new Date() })
        .where(eq(scans.id, event.scanId))
        .returning({ id: scans.id });
      if (updated.length === 0) throw new NotFoundError("scan not found");
      return;
    }
  }
}
