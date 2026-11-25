import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { events, flows, repos, runs, scans } from "@/db/schema";
import { buildFeedItems, groupFeed, type FeedContext, type FeedEventRow, type FeedGroup } from "./build";

const ids = (rows: FeedEventRow[], key: string): string[] => [
  ...new Set(rows.map((r) => r.payload?.[key]).filter((v): v is string => typeof v === "string" && v.length > 0)),
];

/** The signed-in user's recent history, read from the events table. Never another user's rows. */
export async function loadFeed(userId: string, now: Date = new Date(), limit = 80): Promise<FeedGroup[]> {
  const db = getDb();
  const rows: FeedEventRow[] = await db
    .select({ id: events.id, kind: events.kind, payload: events.payload, createdAt: events.createdAt, repoName: repos.fullName })
    .from(events)
    .leftJoin(repos, eq(events.repoId, repos.id))
    .where(eq(events.userId, userId))
    .orderBy(desc(events.createdAt))
    .limit(limit);

  const scanIds = ids(rows, "scanId");
  const runIds = ids(rows, "runId");

  const scanRows = scanIds.length ? await db.select({ id: scans.id, trigger: scans.trigger }).from(scans).where(inArray(scans.id, scanIds)) : [];
  const failedRows = scanIds.length
    ? await db
        .select({ scanId: runs.scanId, name: flows.name })
        .from(runs)
        .innerJoin(flows, eq(runs.flowId, flows.id))
        .where(and(inArray(runs.scanId, scanIds), eq(runs.verdict, "fail")))
        .orderBy(asc(flows.createdAt), asc(flows.id))
    : [];
  const flowRows = runIds.length
    ? await db.select({ runId: runs.id, name: flows.name }).from(runs).innerJoin(flows, eq(runs.flowId, flows.id)).where(inArray(runs.id, runIds))
    : [];

  const ctx: FeedContext = {
    scanTrigger: new Map(scanRows.map((s) => [s.id, s.trigger])),
    failedFlows: new Map(),
    flowByRun: new Map(flowRows.map((f) => [f.runId, f.name])),
  };
  for (const f of failedRows) ctx.failedFlows.set(f.scanId, [...(ctx.failedFlows.get(f.scanId) ?? []), f.name]);

  return groupFeed(buildFeedItems(rows, ctx, now).slice(0, 50), now);
}
