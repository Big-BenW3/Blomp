import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, setDbForTesting, type Db } from "@/db";
import * as schema from "@/db/schema";
import { buildFeedItems, dayLabel, groupFeed, shortAgo, type FeedContext, type FeedEventRow } from "@/lib/feed/build";
import { loadFeed } from "@/lib/feed/load";

const NOW = new Date("2026-11-25T12:00:00Z");
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);
const emptyCtx = (): FeedContext => ({ scanTrigger: new Map(), failedFlows: new Map(), flowByRun: new Map() });
const row = (kind: string, payload: Record<string, unknown>, minutesAgo = 1, repoName: string | null = "me/shop"): FeedEventRow => ({
  id: `${kind}-${minutesAgo}-${JSON.stringify(payload).length}`,
  kind,
  payload,
  createdAt: at(minutesAgo),
  repoName,
});

describe("shortAgo and day labels", () => {
  it("reads like the right edge of a row", () => {
    expect(shortAgo(at(0), NOW)).toBe("now");
    expect(shortAgo(at(2), NOW)).toBe("2m");
    expect(shortAgo(at(59), NOW)).toBe("59m");
    expect(shortAgo(at(180), NOW)).toBe("3h");
    expect(shortAgo(at(3 * 24 * 60), NOW)).toBe("3d");
    expect(shortAgo(at(10 * 24 * 60), NOW)).toBe("15 Nov");
  });
  it("names today and yesterday, then the day", () => {
    expect(dayLabel(at(5), NOW)).toBe("Today");
    expect(dayLabel(new Date("2026-11-24T20:00:00Z"), NOW)).toBe("Yesterday");
    expect(dayLabel(new Date("2026-11-20T09:00:00Z"), NOW)).toBe("Friday 20 Nov");
  });
});

describe("buildFeedItems", () => {
  it("shows a scan with a failure by the flow that broke, with the score", () => {
    const ctx = emptyCtx();
    ctx.scanTrigger.set("s1", "manual");
    ctx.failedFlows.set("s1", ["Checkout"]);
    const [item] = buildFeedItems([row("scan_done", { scanId: "s1", score: 75, passed: 3, failed: 1, unknown: 0 })], ctx, NOW);
    expect(item).toMatchObject({ title: "Checkout is broken", detail: "shop · score 75", tone: "bad", icon: "x", href: "/repos/me/shop/scans/s1", external: false });
  });

  it("names the first broken flow and counts the rest", () => {
    const ctx = emptyCtx();
    ctx.failedFlows.set("s1", ["Checkout", "Log in", "Search"]);
    const [item] = buildFeedItems([row("scan_done", { scanId: "s1", score: 25, passed: 1, failed: 3, unknown: 0 })], ctx, NOW);
    expect(item.title).toBe("Checkout and 2 more are broken");
  });

  it("falls back to a count when the failed flows are gone", () => {
    const [item] = buildFeedItems([row("scan_done", { scanId: "s1", score: 50, passed: 1, failed: 1, unknown: 0 })], emptyCtx(), NOW);
    expect(item.title).toBe("1 flow is broken");
  });

  it("shows a clean scan as all passed, and says when it came from a push", () => {
    const ctx = emptyCtx();
    ctx.scanTrigger.set("s2", "push");
    const [item] = buildFeedItems([row("scan_done", { scanId: "s2", score: 100, passed: 4, failed: 0, unknown: 0 })], ctx, NOW);
    expect(item).toMatchObject({ title: "All flows passed", detail: "shop · score 100 · after a push", tone: "good", icon: "check" });
  });

  it("never calls an unknown a pass", () => {
    const [decided] = buildFeedItems([row("scan_done", { scanId: "s", score: 100, passed: 3, failed: 0, unknown: 1 })], emptyCtx(), NOW);
    expect(decided).toMatchObject({ title: "Kane could not decide 1 flow", tone: "warn" });
    const [none] = buildFeedItems([row("scan_done", { scanId: "s", score: null, passed: 0, failed: 0, unknown: 2 })], emptyCtx(), NOW);
    expect(none).toMatchObject({ title: "Kane could not finish the scan", tone: "warn", detail: "shop" });
  });

  it("hides a passing re-check (the fix line tells it) and shows one that did not pass", () => {
    const ctx = emptyCtx();
    ctx.scanTrigger.set("r1", "recheck");
    ctx.scanTrigger.set("r2", "recheck");
    expect(buildFeedItems([row("scan_done", { scanId: "r1", score: 100, passed: 1, failed: 0, unknown: 0 })], ctx, NOW)).toEqual([]);
    const [bad] = buildFeedItems([row("scan_done", { scanId: "r2", score: 0, passed: 0, failed: 1, unknown: 0 })], ctx, NOW);
    expect(bad).toMatchObject({ title: "Re-check did not pass", tone: "bad" });
  });

  it("shows a fix opened and a fix verified, linking to the pull request", () => {
    const ctx = emptyCtx();
    ctx.flowByRun.set("run1", "Checkout");
    const items = buildFeedItems(
      [
        row("fix_verified", { runId: "run1", prUrl: "https://github.com/me/shop/pull/12" }, 2),
        row("fix_opened", { runId: "run1", prUrl: "https://github.com/me/shop/pull/12", prNumber: 12 }, 9),
      ],
      ctx,
      NOW,
    );
    expect(items[0]).toMatchObject({ title: "Checkout fix verified", detail: "shop · PR #12", tone: "good", icon: "shield", external: true, href: "https://github.com/me/shop/pull/12" });
    expect(items[1]).toMatchObject({ title: "Fix proposed for Checkout", detail: "shop · PR #12", tone: "info", icon: "pr", external: true });
  });

  it("shows a push scan with the short commit, and skips bookkeeping events and events without a repo", () => {
    const items = buildFeedItems(
      [
        row("push_scan", { scanId: "s9", sha: "abcdef1234567" }),
        row("scan_started", { scanId: "s9" }),
        row("scan_done", { scanId: "x", score: 100, passed: 1, failed: 0, unknown: 0 }, 1, null),
      ],
      emptyCtx(),
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "Scan started after a push", detail: "shop · abcdef1", icon: "bolt", href: "/repos/me/shop/scans/s9" });
  });

  it("copes with a payload that is missing or odd", () => {
    expect(() => buildFeedItems([row("scan_done", {}), row("fix_opened", { runId: 5 }), row("push_scan", { sha: 3 })], emptyCtx(), NOW)).not.toThrow();
  });
});

describe("groupFeed", () => {
  it("groups by day in the order given", () => {
    const ctx = emptyCtx();
    const items = buildFeedItems(
      [
        row("push_scan", { scanId: "a", sha: "1" }, 5),
        row("push_scan", { scanId: "b", sha: "2" }, 10),
        row("push_scan", { scanId: "c", sha: "3" }, 24 * 60 + 30),
      ],
      ctx,
      NOW,
    );
    const groups = groupFeed(items, NOW);
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
    ]);
  });
});

describe("loadFeed", () => {
  let client: PGlite;
  let me: string;
  let other: string;
  let repoId: string;
  let otherRepoId: string;

  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "src/db/migrations" });
    setDbForTesting(db as unknown as Db);
    const d = getDb();
    [{ id: me }] = await d.insert(schema.users).values({ githubId: 1, login: "me", accessTokenEnc: "x" }).returning({ id: schema.users.id });
    [{ id: other }] = await d.insert(schema.users).values({ githubId: 2, login: "other", accessTokenEnc: "x" }).returning({ id: schema.users.id });
    [{ id: repoId }] = await d.insert(schema.repos).values({ userId: me, fullName: "me/shop", prodUrl: "https://shop.example.com" }).returning({ id: schema.repos.id });
    [{ id: otherRepoId }] = await d.insert(schema.repos).values({ userId: other, fullName: "other/site" }).returning({ id: schema.repos.id });
  });
  afterAll(async () => {
    setDbForTesting(undefined);
    await client.close();
  });

  it("reads only the user's own history, newest first, with flow names filled in from the database", async () => {
    const d = getDb();
    const [flow] = await d.insert(schema.flows).values({ repoId, name: "Checkout", objective: "Pay and see Order confirmed" }).returning();
    const [scan] = await d.insert(schema.scans).values({ repoId, trigger: "push", targetUrl: "https://shop.example.com", status: "done", score: 0, failed: 1 }).returning();
    const [run] = await d.insert(schema.runs).values({ scanId: scan.id, flowId: flow.id, verdict: "fail" }).returning();
    const t = (m: number) => new Date(Date.now() - m * 60_000);
    await d.insert(schema.events).values([
      { userId: me, repoId, kind: "scan_started", payload: { scanId: scan.id }, createdAt: t(30) },
      { userId: me, repoId, kind: "scan_done", payload: { scanId: scan.id, score: 0, passed: 0, failed: 1, unknown: 0 }, createdAt: t(20) },
      { userId: me, repoId, kind: "fix_opened", payload: { runId: run.id, prUrl: "https://github.com/me/shop/pull/3", prNumber: 3 }, createdAt: t(10) },
      { userId: other, repoId: otherRepoId, kind: "scan_done", payload: { scanId: "00000000-0000-4000-8000-000000000000", score: 100, passed: 1, failed: 0, unknown: 0 }, createdAt: t(5) },
    ]);

    const groups = await loadFeed(me);
    const lines = groups.flatMap((g) => g.items.map((i) => i.title));
    expect(lines).toEqual(["Fix proposed for Checkout", "Checkout is broken"]);
    const scanLine = groups.flatMap((g) => g.items).find((i) => i.title === "Checkout is broken");
    expect(scanLine?.detail).toBe("shop · score 0 · after a push");

    const theirs = await loadFeed(other);
    expect(theirs.flatMap((g) => g.items.map((i) => i.detail))).toEqual(["site · score 100"]);
  });

  it("is empty for a user with no history", async () => {
    const d = getDb();
    const [{ id: nobody }] = await d.insert(schema.users).values({ githubId: 3, login: "nobody", accessTokenEnc: "x" }).returning({ id: schema.users.id });
    expect(await loadFeed(nobody)).toEqual([]);
  });
});
