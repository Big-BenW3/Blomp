import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, setDbForTesting, type Db } from "@/db";
import * as schema from "@/db/schema";
import { createNvidiaChat } from "@/lib/agent/llm";
import { createFix, FIX_STALE_MS, STALE_FIX_ERROR, toView } from "@/lib/fixes/store";
import { friendlyError, isRateLimited } from "@/lib/repos/errors";

const env = { NVIDIA_API_KEY: "k", NVIDIA_MODEL: "m" };
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 });
const status = (s: number) => new Response("busy", { status: s });

describe("the model client retries once", () => {
  it("recovers from a rate limit or a brief outage", async () => {
    for (const first of [429, 502, 503, 504]) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(status(first)).mockResolvedValueOnce(ok());
      const answer = await createNvidiaChat({ env, retryDelayMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch })([]);
      expect(answer).toBe("hello");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it("gives up after the second rate limit, with the rate-limit message", async () => {
    const fetchImpl = vi.fn(async () => status(429));
    await expect(createNvidiaChat({ env, retryDelayMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch })([])).rejects.toMatchObject({
      kind: "rate_limit",
      message: expect.stringMatching(/try again in a minute/i),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry errors a second try cannot fix", async () => {
    for (const s of [400, 401, 500]) {
      const fetchImpl = vi.fn(async () => status(s));
      await expect(createNvidiaChat({ env, retryDelayMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch })([])).rejects.toMatchObject({ kind: "http" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("does not retry a timeout", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    await expect(createNvidiaChat({ env, retryDelayMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch })([])).rejects.toMatchObject({ kind: "timeout" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("GitHub error messages", () => {
  const limited = { status: 403, message: "API rate limit exceeded for user", response: { headers: { "x-ratelimit-remaining": "0" } } };
  it("tells a rate limit apart from missing access", () => {
    expect(isRateLimited(limited)).toBe(true);
    expect(isRateLimited({ status: 403, message: "Resource not accessible by integration" })).toBe(false);
    expect(friendlyError(limited)).toMatch(/limiting requests/);
    expect(friendlyError({ status: 403, message: "Resource not accessible by integration" })).toMatch(/approve the Blomp app/);
  });
  it("says GitHub is having trouble on a server error", () => {
    expect(friendlyError({ status: 503 })).toMatch(/trouble/);
  });
  it("still never leaks raw errors", () => {
    expect(friendlyError(new Error("connect ECONNREFUSED 10.0.0.1"))).toBe("Something went wrong. Try again.");
    expect(isRateLimited(null)).toBe(false);
    expect(isRateLimited("x")).toBe(false);
  });
});

describe("a fix that was stopped midway", () => {
  let client: PGlite;
  let runId: string;

  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "src/db/migrations" });
    setDbForTesting(db as unknown as Db);
    const d = getDb();
    const [user] = await d.insert(schema.users).values({ githubId: 7, login: "h", accessTokenEnc: "x" }).returning();
    const [repo] = await d.insert(schema.repos).values({ userId: user.id, fullName: "h/shop", prodUrl: "https://shop.example.com" }).returning();
    const [flow] = await d.insert(schema.flows).values({ repoId: repo.id, name: "Checkout", objective: "Pay and see Order confirmed" }).returning();
    const [scan] = await d.insert(schema.scans).values({ repoId: repo.id, trigger: "manual", targetUrl: "https://shop.example.com", status: "done" }).returning();
    [{ id: runId }] = await d.insert(schema.runs).values({ scanId: scan.id, flowId: flow.id, verdict: "fail" }).returning({ id: schema.runs.id });
  });
  afterAll(async () => {
    setDbForTesting(undefined);
    await client.close();
  });

  it("shows a fix that has been drafting too long as failed, so Try again appears", () => {
    const now = new Date("2026-11-25T12:00:00Z");
    const row = (ageMs: number, status = "drafting") =>
      ({ id: "f", runId: "r", status, summary: null, prUrl: null, prNumber: null, error: null, recheckScanId: null, createdAt: new Date(now.getTime() - ageMs) }) as never;
    expect(toView(row(60_000), now)).toMatchObject({ status: "drafting", error: null });
    expect(toView(row(FIX_STALE_MS + 1000), now)).toMatchObject({ status: "failed", error: STALE_FIX_ERROR });
    expect(toView(row(FIX_STALE_MS + 1000, "pr_open"), now).status).toBe("pr_open");
  });

  it("starts a new fix instead of reusing the stopped one, and keeps reusing a live one", async () => {
    const d = getDb();
    const [stale] = await d.insert(schema.fixes).values({ runId, createdAt: new Date(Date.now() - FIX_STALE_MS - 60_000) }).returning();
    const first = await createFix(runId);
    expect(first.created).toBe(true);
    expect(first.fix.id).not.toBe(stale.id);
    const [old] = await d.select().from(schema.fixes).where(eq(schema.fixes.id, stale.id));
    expect(old).toMatchObject({ status: "failed", error: STALE_FIX_ERROR });

    const again = await createFix(runId);
    expect(again).toMatchObject({ created: false });
    expect(again.fix.id).toBe(first.fix.id);
  });
});
