import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { events, repos, scans } from "@/db/schema";
import { createWorkflowDispatcher } from "@/lib/scans/dispatch";
import { ScanStartError, startScan, type Dispatcher } from "@/lib/scans/start";

export interface PushScanDeps {
  dispatch?: Dispatcher;
}

/**
 * A production deploy of `fullName` finished at commit `sha`. Starts Kane for every Blomp user who turned on
 * auto-scan for that repo. The same commit is never scanned twice, and a scan already running is left alone,
 * so a repeated webhook cannot spend Kane credits twice.
 */
export async function startPushScans(fullName: string, sha: string, deps: PushScanDeps = {}): Promise<{ started: number; skipped: number }> {
  const db = getDb();
  const rows = await db
    .select()
    .from(repos)
    .where(and(sql`lower(${repos.fullName}) = ${fullName.toLowerCase()}`, eq(repos.autoScan, true)));

  let started = 0;
  let skipped = 0;
  for (const repo of rows) {
    const [seen] = await db
      .select({ id: scans.id })
      .from(scans)
      .where(and(eq(scans.repoId, repo.id), eq(scans.trigger, "push"), eq(scans.commitSha, sha)))
      .limit(1);
    if (seen) {
      skipped++;
      continue;
    }
    try {
      const { scanId, reused } = await startScan({
        userId: repo.userId,
        repo,
        dispatch: deps.dispatch ?? createWorkflowDispatcher(),
        trigger: "push",
        commitSha: sha,
      });
      if (reused) {
        skipped++;
        continue;
      }
      await db.insert(events).values({ userId: repo.userId, repoId: repo.id, kind: "push_scan", payload: { scanId, sha } });
      started++;
    } catch (err) {
      // Nothing to scan with (no site address, no flows on) is a setup matter, not an error worth retrying.
      if (!(err instanceof ScanStartError)) console.error("push scan failed to start", repo.fullName, err);
      skipped++;
    }
  }
  return { started, skipped };
}
