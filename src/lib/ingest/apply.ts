import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { events, flows, repos, runSteps, runs, scans } from "@/db/schema";
import { decodeImage, uploadEvidenceImage, type UploadImage } from "@/lib/evidence/image";
import { resolveVerdict } from "@/lib/kane/ndjson";
import { summarize, type RunVerdict } from "@/lib/kane/score";
import { finalizeRecheck } from "@/lib/fixes/recheck";
import type { IngestEvent } from "./schema";

export class NotFoundError extends Error {}

export interface IngestDeps {
  /** Where failure screenshots go. Defaults to Vercel Blob; tests pass a fake. */
  uploadImage?: UploadImage;
  /** Runs after a scan ends or fails; defaults to closing out a fix's re-check. Tests pass a fake. */
  onScanFinished?: (scanId: string) => Promise<void>;
}

async function scanFinished(scanId: string, deps: IngestDeps): Promise<void> {
  try {
    await (deps.onScanFinished ?? finalizeRecheck)(scanId);
  } catch (err) {
    // The scan result is already saved; a failed follow-up must not make the runner retry it.
    console.error("follow-up after scan failed", scanId, err);
  }
}

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
export async function applyIngest(event: IngestEvent, deps: IngestDeps = {}): Promise<void> {
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

      // A screenshot is a nice-to-have: if it cannot be stored, the verdict is still recorded.
      let evidenceUrl: string | undefined;
      const image = event.screenshot && verdict !== "pass" ? decodeImage(event.screenshot) : undefined;
      if (image) {
        try {
          evidenceUrl = await (deps.uploadImage ?? uploadEvidenceImage)(`evidence/${event.scanId}/${event.flowId}.jpg`, image);
        } catch (err) {
          console.error("screenshot upload failed", err);
        }
      }

      await db
        .update(runs)
        .set({
          verdict,
          exitCode: event.exitCode,
          oneLiner: event.end?.oneLiner ?? null,
          reason: event.end?.reason ?? reason,
          failingStep: verdict === "fail" ? (event.failingStep ?? event.triage?.errorMessage ?? null) : null,
          triage: event.triage ?? null,
          credits: event.end?.credits ?? null,
          testUrl: event.end?.testUrl ?? null,
          ...(evidenceUrl ? { evidenceUrl } : {}),
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
        .returning({ repoId: scans.repoId, trigger: scans.trigger });
      if (!scan) throw new NotFoundError("scan not found");

      const [repo] = await db.select({ userId: repos.userId }).from(repos).where(eq(repos.id, scan.repoId));
      if (repo) {
        // A re-check covers one flow on a preview, so it must not replace the repo's score for the live site.
        if (s.score !== null && scan.trigger !== "recheck") await db.update(repos).set({ lastScore: s.score }).where(eq(repos.id, scan.repoId));
        await db.insert(events).values({
          userId: repo.userId,
          repoId: scan.repoId,
          kind: "scan_done",
          payload: { scanId: event.scanId, ...s },
        });
      }
      await scanFinished(event.scanId, deps);
      return;
    }

    case "scan_error": {
      const updated = await db
        .update(scans)
        .set({ status: "error", finishedAt: new Date() })
        .where(eq(scans.id, event.scanId))
        .returning({ id: scans.id });
      if (updated.length === 0) throw new NotFoundError("scan not found");
      await scanFinished(event.scanId, deps);
      return;
    }
  }
}
