import { and, asc, desc, eq, gt } from "drizzle-orm";
import { getDb } from "@/db";
import { flows, repos, runSteps, runs, scans } from "@/db/schema";
import type { Triage } from "@/lib/ingest/triage";
import { STALE_MS } from "./start";

export type ScanStatus = "queued" | "running" | "done" | "error";
export type Verdict = "pending" | "pass" | "fail" | "unknown";

export interface RunView {
  id: string;
  flowId: string;
  name: string;
  path: string;
  verdict: Verdict;
  oneLiner: string | null;
}

/** Everything the scan screen draws. Plain JSON, so it can cross to the browser and ride the live stream. */
export interface ScanSnapshot {
  id: string;
  repoFullName: string;
  status: ScanStatus;
  /** True when the scan stopped reporting and was written off, as opposed to failing on GitHub's side. */
  stalled: boolean;
  score: number | null;
  passed: number;
  failed: number;
  unknown: number;
  targetUrl: string;
  commitSha: string | null;
  createdAt: string;
  runs: RunView[];
}

export interface StepView {
  id: number;
  runId: string;
  idx: number;
  status: string;
  remark: string;
}

/** The scan with its runs, but only if it belongs to this user. */
export async function getScanSnapshot(userId: string, scanId: string, now: Date = new Date()): Promise<ScanSnapshot | undefined> {
  const db = getDb();
  const [row] = await db
    .select({ scan: scans, fullName: repos.fullName })
    .from(scans)
    .innerJoin(repos, eq(repos.id, scans.repoId))
    .where(and(eq(scans.id, scanId), eq(repos.userId, userId)));
  if (!row) return undefined;

  const runRows = await db
    .select({
      id: runs.id,
      flowId: runs.flowId,
      verdict: runs.verdict,
      oneLiner: runs.oneLiner,
      name: flows.name,
      path: flows.path,
    })
    .from(runs)
    .innerJoin(flows, eq(flows.id, runs.flowId))
    .where(eq(runs.scanId, scanId))
    .orderBy(asc(flows.createdAt), asc(flows.id));

  const open = row.scan.status === "queued" || row.scan.status === "running";
  const stalled = open && now.getTime() - row.scan.createdAt.getTime() > STALE_MS;
  return {
    id: row.scan.id,
    repoFullName: row.fullName,
    status: stalled ? "error" : (row.scan.status as ScanStatus),
    stalled,
    score: row.scan.score,
    passed: row.scan.passed,
    failed: row.scan.failed,
    unknown: row.scan.unknown,
    targetUrl: row.scan.targetUrl,
    commitSha: row.scan.commitSha,
    createdAt: row.scan.createdAt.toISOString(),
    runs: runRows.map((r) => ({
      id: r.id,
      flowId: r.flowId,
      name: r.name,
      path: r.path,
      verdict: r.verdict as Verdict,
      oneLiner: r.oneLiner,
    })),
  };
}

const stepCols = { id: runSteps.id, runId: runSteps.runId, idx: runSteps.idx, status: runSteps.status, remark: runSteps.remark };

/** Steps for a scan after a given step id, oldest first. `afterId` 0 returns the most recent `tail` steps. */
export async function getSteps(scanId: string, afterId = 0, tail = 60): Promise<StepView[]> {
  const db = getDb();
  const base = db
    .select(stepCols)
    .from(runSteps)
    .innerJoin(runs, eq(runs.id, runSteps.runId))
    .where(and(eq(runs.scanId, scanId), gt(runSteps.id, afterId)));
  if (afterId > 0) return base.orderBy(asc(runSteps.id)).limit(200);
  const latest = await base.orderBy(desc(runSteps.id)).limit(tail);
  return latest.reverse();
}

export interface RunDetail {
  id: string;
  scanId: string;
  repoFullName: string;
  flowName: string;
  flowPath: string;
  verdict: Verdict;
  oneLiner: string | null;
  reason: string | null;
  failingStep: string | null;
  triage: Triage | null;
  credits: number | null;
  testUrl: string | null;
  evidenceUrl: string | null;
  consoleErrors: string[];
  networkErrors: string[];
}

/** One run's evidence, only for the user who owns the repo. */
export async function getRunDetail(userId: string, runId: string): Promise<RunDetail | undefined> {
  const [r] = await getDb()
    .select({ run: runs, flowName: flows.name, flowPath: flows.path, fullName: repos.fullName })
    .from(runs)
    .innerJoin(flows, eq(flows.id, runs.flowId))
    .innerJoin(scans, eq(scans.id, runs.scanId))
    .innerJoin(repos, eq(repos.id, scans.repoId))
    .where(and(eq(runs.id, runId), eq(repos.userId, userId)));
  if (!r) return undefined;
  return {
    id: r.run.id,
    scanId: r.run.scanId,
    repoFullName: r.fullName,
    flowName: r.flowName,
    flowPath: r.flowPath,
    verdict: r.run.verdict as Verdict,
    oneLiner: r.run.oneLiner,
    reason: r.run.reason,
    failingStep: r.run.failingStep,
    triage: r.run.triage ?? null,
    credits: r.run.credits,
    testUrl: r.run.testUrl,
    evidenceUrl: r.run.evidenceUrl,
    consoleErrors: r.run.consoleErrors,
    networkErrors: r.run.networkErrors,
  };
}

export interface LastScan {
  id: string;
  status: ScanStatus;
  score: number | null;
  createdAt: Date;
}

/** The repo's newest scan, for the "Last scan" row. */
export async function latestScanForRepo(repoId: string, now: Date = new Date()): Promise<LastScan | undefined> {
  const [s] = await getDb().select().from(scans).where(eq(scans.repoId, repoId)).orderBy(desc(scans.createdAt)).limit(1);
  if (!s) return undefined;
  const open = s.status === "queued" || s.status === "running";
  const stalled = open && now.getTime() - s.createdAt.getTime() > STALE_MS;
  return { id: s.id, status: stalled ? "error" : (s.status as ScanStatus), score: s.score, createdAt: s.createdAt };
}

