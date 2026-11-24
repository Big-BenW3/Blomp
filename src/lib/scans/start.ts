import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { events, runs, scans } from "@/db/schema";
import { listFlows, type RepoRow } from "@/lib/repos/store";
import { MAX_ENABLED_FLOWS } from "@/lib/repos/schema";
import { normalizeSiteUrl } from "@/lib/url";

/** A scan that never reports back for this long is shown as stopped. */
export const STALE_MS = 20 * 60 * 1000;

/** Something the user can act on: add a site address, turn on a flow, fix the Actions setup. */
export class ScanStartError extends Error {}

export interface DispatchInput {
  scanId: string;
  targetUrl: string;
  flows: Array<{ id: string; name: string; objective: string; path: string }>;
}
export type Dispatcher = (input: DispatchInput) => Promise<void>;

export interface StartScanOptions {
  userId: string;
  repo: RepoRow;
  dispatch: Dispatcher;
  trigger?: "manual" | "push" | "recheck";
  commitSha?: string | null;
  /** Test this address instead of the repo's live site (a fix's preview deployment). */
  targetUrl?: string;
  /** Run only these flows, on or off. Used to re-check the flow a fix is for. */
  flowIds?: string[];
  /** Start even if another scan is in flight: a re-check must not be swallowed by an unrelated scan. */
  allowConcurrent?: boolean;
  now?: Date;
}

/**
 * Creates the scan and one pending run per enabled flow, then asks GitHub Actions to run Kane.
 * A scan already in flight for the repo is returned instead of starting a second one, so a double tap
 * cannot spend Kane credits twice.
 */
export async function startScan(opts: StartScanOptions): Promise<{ scanId: string; reused: boolean }> {
  const { userId, repo, dispatch } = opts;
  const db = getDb();
  const now = opts.now ?? new Date();

  const targetUrl = normalizeSiteUrl(opts.targetUrl ?? repo.prodUrl);
  if (!targetUrl) throw new ScanStartError("Add your live site address first, so Kane knows what to open.");

  const all = await listFlows(repo.id);
  const flows = opts.flowIds
    ? all.filter((f) => opts.flowIds?.includes(f.id)).slice(0, MAX_ENABLED_FLOWS)
    : all.filter((f) => f.enabled).slice(0, MAX_ENABLED_FLOWS);
  if (flows.length === 0) throw new ScanStartError("Turn on at least one flow for Kane to check.");

  const [active] = opts.allowConcurrent
    ? []
    : await db
        .select({ id: scans.id })
        .from(scans)
        .where(
          and(
            eq(scans.repoId, repo.id),
            inArray(scans.status, ["queued", "running"]),
            gt(scans.createdAt, new Date(now.getTime() - STALE_MS)),
          ),
        )
        .orderBy(desc(scans.createdAt))
        .limit(1);
  if (active) return { scanId: active.id, reused: true };

  const [scan] = await db
    .insert(scans)
    .values({ repoId: repo.id, trigger: opts.trigger ?? "manual", commitSha: opts.commitSha ?? null, targetUrl })
    .returning({ id: scans.id });
  await db.insert(runs).values(flows.map((f) => ({ scanId: scan.id, flowId: f.id })));
  await db.insert(events).values({ userId, repoId: repo.id, kind: "scan_started", payload: { scanId: scan.id } });

  try {
    await dispatch({
      scanId: scan.id,
      targetUrl,
      flows: flows.map((f) => ({ id: f.id, name: f.name, objective: f.objective, path: f.path })),
    });
  } catch (err) {
    await db.update(scans).set({ status: "error", finishedAt: new Date() }).where(eq(scans.id, scan.id));
    if (err instanceof ScanStartError) throw err;
    console.error("scan dispatch failed", err);
    throw new ScanStartError("Could not start the scan. Try again in a moment.");
  }
  return { scanId: scan.id, reused: false };
}
