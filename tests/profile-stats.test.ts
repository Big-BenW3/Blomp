import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, setDbForTesting, type Db } from "@/db";
import * as schema from "@/db/schema";
import { getProfileStats } from "@/lib/profile/stats";

const { users, repos, flows, scans, runs } = schema;
let client: PGlite;
let me: string;
let other: string;

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "src/db/migrations" });
  setDbForTesting(db as unknown as Db);
  const d = getDb();
  [{ id: me }] = await d.insert(users).values({ githubId: 51, login: "me", accessTokenEnc: "x" }).returning({ id: users.id });
  [{ id: other }] = await d.insert(users).values({ githubId: 52, login: "other", accessTokenEnc: "x" }).returning({ id: users.id });
});
afterAll(async () => {
  setDbForTesting(undefined);
  await client.close();
});

async function scanWith(userId: string, fullName: string, status: string, verdicts: [string, number | null][]) {
  const d = getDb();
  const [repo] = await d.insert(repos).values({ userId, fullName }).returning();
  const [scan] = await d.insert(scans).values({ repoId: repo.id, trigger: "manual", targetUrl: "https://x.dev", status }).returning();
  for (const [i, [verdict, credits]] of verdicts.entries()) {
    const [flow] = await d.insert(flows).values({ repoId: repo.id, name: `Flow ${i}`, objective: "Check the page works" }).returning();
    await d.insert(runs).values({ scanId: scan.id, flowId: flow.id, verdict, credits });
  }
  return scan.id;
}

describe("getProfileStats", () => {
  it("is all zeros for a new user", async () => {
    const s = await getProfileStats(other);
    expect(s).toMatchObject({ repos: 0, scans: 0, passed: 0 });
    expect(s.memberSince).toBeInstanceOf(Date);
  });

  it("counts finished scans and passed flows for this user only", async () => {
    await scanWith(me, "me/a", "done", [["pass", 15.2], ["fail", 8]]);
    await scanWith(me, "me/b", "running", [["pending", null]]);
    await scanWith(other, "other/a", "done", [["pass", 99]]);
    const s = await getProfileStats(me);
    expect(s.repos).toBe(2);
    expect(s.scans).toBe(1); // the running scan is not counted
    expect(s.passed).toBe(1);
  });
});
