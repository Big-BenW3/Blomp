import { and, desc, eq, inArray, or } from "drizzle-orm";
import { getDb } from "@/db";
import { fixes, repos, runs, scans } from "@/db/schema";

export type FixStatus = "drafting" | "pr_open" | "verifying" | "verified" | "failed";
export type FixRow = typeof fixes.$inferSelect;

/** What the screen needs, as plain JSON. */
export interface FixView {
  id: string;
  runId: string;
  status: FixStatus;
  summary: string | null;
  prUrl: string | null;
  prNumber: number | null;
  error: string | null;
  recheckScanId: string | null;
}

export const toView = (f: FixRow): FixView => ({
  id: f.id,
  runId: f.runId,
  status: f.status as FixStatus,
  summary: f.summary,
  prUrl: f.prUrl,
  prNumber: f.prNumber,
  error: f.error,
  recheckScanId: f.recheckScanId,
});

/** A fix that is still going, or already done, is reused so a double tap never opens two pull requests. */
const KEEP: FixStatus[] = ["drafting", "pr_open", "verifying", "verified"];

export async function createFix(runId: string): Promise<{ fix: FixRow; created: boolean }> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(fixes)
    .where(and(eq(fixes.runId, runId), inArray(fixes.status, KEEP)))
    .orderBy(desc(fixes.createdAt))
    .limit(1);
  if (existing) return { fix: existing, created: false };
  const [fix] = await db.insert(fixes).values({ runId }).returning();
  return { fix, created: true };
}

export async function updateFix(id: string, patch: Partial<Omit<FixRow, "id" | "runId" | "createdAt">>): Promise<void> {
  await getDb().update(fixes).set(patch).where(eq(fixes.id, id));
}

/** Moves a fix between states only if it is still in `from`, so a repeated webhook or tap acts once. */
export async function transitionFix(id: string, from: FixStatus[], patch: Partial<Omit<FixRow, "id" | "runId" | "createdAt">>): Promise<FixRow | undefined> {
  const [row] = await getDb()
    .update(fixes)
    .set(patch)
    .where(and(eq(fixes.id, id), inArray(fixes.status, from)))
    .returning();
  return row;
}

/** The newest fix for a run, for the run screen. Only the repo's owner gets it. */
export async function getFixForRun(userId: string, runId: string): Promise<FixView | undefined> {
  const [row] = await getDb()
    .select({ fix: fixes })
    .from(fixes)
    .innerJoin(runs, eq(runs.id, fixes.runId))
    .innerJoin(scans, eq(scans.id, runs.scanId))
    .innerJoin(repos, eq(repos.id, scans.repoId))
    .where(and(eq(fixes.runId, runId), eq(repos.userId, userId)))
    .orderBy(desc(fixes.createdAt))
    .limit(1);
  return row ? toView(row.fix) : undefined;
}

export async function getFixView(userId: string, fixId: string): Promise<FixView | undefined> {
  const [row] = await getDb()
    .select({ fix: fixes })
    .from(fixes)
    .innerJoin(runs, eq(runs.id, fixes.runId))
    .innerJoin(scans, eq(scans.id, runs.scanId))
    .innerJoin(repos, eq(repos.id, scans.repoId))
    .where(and(eq(fixes.id, fixId), eq(repos.userId, userId)));
  return row ? toView(row.fix) : undefined;
}

/** Everything the orchestrator needs about a fix: the run, its flow's repo and who owns it. */
export async function loadFixContext(fixId: string) {
  const [row] = await getDb()
    .select({ fix: fixes, run: runs, scan: scans, repo: repos })
    .from(fixes)
    .innerJoin(runs, eq(runs.id, fixes.runId))
    .innerJoin(scans, eq(scans.id, runs.scanId))
    .innerJoin(repos, eq(repos.id, scans.repoId))
    .where(eq(fixes.id, fixId));
  return row;
}

/** The open fix a deployment belongs to, matched by branch or by commit. */
export async function findOpenFix(fullName: string, ref: string, sha: string): Promise<FixRow | undefined> {
  const [row] = await getDb()
    .select({ fix: fixes })
    .from(fixes)
    .innerJoin(runs, eq(runs.id, fixes.runId))
    .innerJoin(scans, eq(scans.id, runs.scanId))
    .innerJoin(repos, eq(repos.id, scans.repoId))
    .where(and(eq(repos.fullName, fullName), eq(fixes.status, "pr_open"), or(eq(fixes.branch, ref), eq(fixes.headSha, sha))))
    .orderBy(desc(fixes.createdAt))
    .limit(1);
  return row?.fix;
}

export async function findFixByRecheckScan(scanId: string): Promise<FixRow | undefined> {
  const [row] = await getDb().select().from(fixes).where(eq(fixes.recheckScanId, scanId));
  return row;
}
