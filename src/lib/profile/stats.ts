import { and, count, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { repos, runs, scans, users } from "@/db/schema";

export interface ProfileStats {
  memberSince: Date | null;
  repos: number;
  scans: number;
  /** Flows that passed, across every finished scan. */
  passed: number;
}

export async function getProfileStats(userId: string): Promise<ProfileStats> {
  const db = getDb();
  const [u] = await db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId));
  const [r] = await db.select({ n: count() }).from(repos).where(eq(repos.userId, userId));
  const [s] = await db
    .select({ n: count() })
    .from(scans)
    .innerJoin(repos, eq(repos.id, scans.repoId))
    .where(and(eq(repos.userId, userId), eq(scans.status, "done")));
  const [x] = await db
    .select({
      passed: sql<number>`count(*) filter (where ${runs.verdict} = 'pass')`.mapWith(Number),
    })
    .from(runs)
    .innerJoin(scans, eq(scans.id, runs.scanId))
    .innerJoin(repos, eq(repos.id, scans.repoId))
    .where(eq(repos.userId, userId));
  return { memberSince: u?.createdAt ?? null, repos: r?.n ?? 0, scans: s?.n ?? 0, passed: x?.passed ?? 0 };
}
