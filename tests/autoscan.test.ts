import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Octokit } from "@octokit/rest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, setDbForTesting, type Db } from "@/db";
import * as schema from "@/db/schema";
import { AutoScanError, setAutoScan } from "@/lib/autoscan/enable";
import { startPushScans } from "@/lib/autoscan/push";
import { handleGithubEvent } from "@/lib/fixes/webhook";

const { users, repos, flows, scans, events } = schema;
let client: PGlite;
let me: string;
let n = 0;

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "src/db/migrations" });
  setDbForTesting(db as unknown as Db);
  [{ id: me }] = await getDb().insert(users).values({ githubId: 90, login: "me", accessTokenEnc: "x" }).returning({ id: users.id });
  process.env.AUTH_URL = "https://blomp.test";
});
afterAll(async () => {
  setDbForTesting(undefined);
  await client.close();
});

async function shop(over: Partial<typeof repos.$inferInsert> = {}, withFlow = true) {
  n++;
  const d = getDb();
  const [repo] = await d
    .insert(repos)
    .values({ userId: me, fullName: `me/shop${n}`, prodUrl: "https://shop.example.com", autoScan: true, ...over })
    .returning();
  if (withFlow) await d.insert(flows).values({ repoId: repo.id, name: "Checkout", objective: "Pay and see Order confirmed" });
  return repo;
}

const deployment = (fullName: string, over: { state?: string; environment?: string; sha?: string; ref?: string } = {}) => ({
  deployment_status: { state: over.state ?? "success", environment_url: "https://shop.example.com", target_url: null },
  deployment: { sha: over.sha ?? "a".repeat(40), ref: over.ref ?? "main", environment: over.environment ?? "Production" },
  repository: { full_name: fullName },
});

describe("scan on push", () => {
  it("scans the live site when a production deploy succeeds for a repo with auto-scan on", async () => {
    const repo = await shop();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const outcome = await handleGithubEvent("deployment_status", deployment(repo.fullName, { sha: "b".repeat(40) }), { dispatch });

    expect(outcome).toBe("scan_started");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ targetUrl: "https://shop.example.com" });
    const [scan] = await getDb().select().from(scans).where(eq(scans.repoId, repo.id));
    expect(scan).toMatchObject({ trigger: "push", commitSha: "b".repeat(40), targetUrl: "https://shop.example.com" });
    const feedEvents = await getDb().select().from(events).where(eq(events.repoId, repo.id));
    expect(feedEvents.map((e) => e.kind).sort()).toEqual(["push_scan", "scan_started"]);
    expect(feedEvents.find((e) => e.kind === "push_scan")?.payload).toMatchObject({ scanId: scan.id, sha: "b".repeat(40) });
  });

  it("matches the repo name whatever its letter case", async () => {
    const repo = await shop();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    expect(await handleGithubEvent("deployment_status", deployment(repo.fullName.toUpperCase()), { dispatch })).toBe("scan_started");
  });

  it("scans a commit only once, even if GitHub sends the event again", async () => {
    const repo = await shop();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const event = deployment(repo.fullName, { sha: "c".repeat(40) });
    expect(await handleGithubEvent("deployment_status", event, { dispatch })).toBe("scan_started");
    expect(await handleGithubEvent("deployment_status", event, { dispatch })).toBe("ignored");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("leaves a scan that is already running alone", async () => {
    const repo = await shop();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    await handleGithubEvent("deployment_status", deployment(repo.fullName, { sha: "1".repeat(40) }), { dispatch });
    const second = await handleGithubEvent("deployment_status", deployment(repo.fullName, { sha: "2".repeat(40) }), { dispatch });
    expect(second).toBe("ignored");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await getDb().select().from(scans).where(eq(scans.repoId, repo.id))).toHaveLength(1);
  });

  it("does nothing for repos with auto-scan off, unknown repos, preview or failed deployments", async () => {
    const off = await shop({ autoScan: false });
    const on = await shop();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    expect(await handleGithubEvent("deployment_status", deployment(off.fullName), { dispatch })).toBe("ignored");
    expect(await handleGithubEvent("deployment_status", deployment("nobody/nothing"), { dispatch })).toBe("ignored");
    expect(await handleGithubEvent("deployment_status", deployment(on.fullName, { state: "failure" }), { dispatch })).toBe("ignored");
    expect(await handleGithubEvent("deployment_status", deployment(on.fullName, { state: "pending" }), { dispatch })).toBe("ignored");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not scan when there is no site address or no flow on, and does not throw", async () => {
    const noUrl = await shop({ prodUrl: null });
    const noFlows = await shop({}, false);
    const dispatch = vi.fn().mockResolvedValue(undefined);
    expect(await handleGithubEvent("deployment_status", deployment(noUrl.fullName), { dispatch })).toBe("ignored");
    expect(await handleGithubEvent("deployment_status", deployment(noFlows.fullName), { dispatch })).toBe("ignored");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("survives a dispatch failure and records the scan as stopped", async () => {
    const repo = await shop();
    const dispatch = vi.fn().mockRejectedValue(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await handleGithubEvent("deployment_status", deployment(repo.fullName), { dispatch })).toBe("ignored");
    spy.mockRestore();
    const [scan] = await getDb().select().from(scans).where(eq(scans.repoId, repo.id));
    expect(scan.status).toBe("error");
    expect(await getDb().select().from(events).where(eq(events.kind, "push_scan"))).not.toContainEqual(expect.objectContaining({ repoId: repo.id }));
  });

  it("startPushScans reports what it did", async () => {
    const repo = await shop();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    expect(await startPushScans(repo.fullName, "d".repeat(40), { dispatch })).toEqual({ started: 1, skipped: 0 });
    expect(await startPushScans(repo.fullName, "d".repeat(40), { dispatch })).toEqual({ started: 0, skipped: 1 });
  });
});

function fakeOctokit(over: { createWebhook?: () => Promise<unknown>; listWebhooks?: () => Promise<unknown> } = {}) {
  const repos = {
    listWebhooks: vi.fn(over.listWebhooks ?? (async () => ({ data: [] }))),
    createWebhook: vi.fn(over.createWebhook ?? (async () => ({ data: { id: 4242 } }))),
    updateWebhook: vi.fn(),
  };
  return { octokit: { rest: { repos } } as unknown as Octokit, repos };
}
const hook = { url: "https://blomp.test/api/webhooks/github", secret: "s3cret" };

describe("turning auto-scan on and off", () => {
  it("adds the deployment webhook, remembers its id and switches auto-scan on", async () => {
    const row = await shop({ autoScan: false });
    const { octokit, repos: api } = fakeOctokit();
    await setAutoScan({ userId: me, row, enabled: true, octokit, ...hook });
    expect(api.createWebhook).toHaveBeenCalledWith(expect.objectContaining({ events: ["deployment_status"], config: expect.objectContaining({ url: hook.url, secret: hook.secret }) }));
    const [after] = await getDb().select().from(repos).where(eq(repos.id, row.id));
    expect(after).toMatchObject({ autoScan: true, webhookId: 4242 });
  });

  it("reuses a webhook that already points at Blomp", async () => {
    const row = await shop({ autoScan: false });
    const { octokit, repos: api } = fakeOctokit({ listWebhooks: async () => ({ data: [{ id: 7, events: ["deployment_status"], config: { url: hook.url } }] }) });
    await setAutoScan({ userId: me, row, enabled: true, octokit, ...hook });
    expect(api.createWebhook).not.toHaveBeenCalled();
    const [after] = await getDb().select().from(repos).where(eq(repos.id, row.id));
    expect(after).toMatchObject({ autoScan: true, webhookId: 7 });
  });

  it("switches off without touching GitHub", async () => {
    const row = await shop({ autoScan: true, webhookId: 7 });
    const { octokit, repos: api } = fakeOctokit();
    await setAutoScan({ userId: me, row, enabled: false, octokit, ...hook });
    expect(api.listWebhooks).not.toHaveBeenCalled();
    const [after] = await getDb().select().from(repos).where(eq(repos.id, row.id));
    expect(after).toMatchObject({ autoScan: false, webhookId: 7 });
  });

  it("refuses with a readable reason, and stays off", async () => {
    const noUrl = await shop({ autoScan: false, prodUrl: null });
    const { octokit } = fakeOctokit();
    await expect(setAutoScan({ userId: me, row: noUrl, enabled: true, octokit, ...hook })).rejects.toThrow(/live site address/);

    const row = await shop({ autoScan: false });
    await expect(setAutoScan({ userId: me, row, enabled: true, octokit, url: hook.url, secret: "" })).rejects.toThrow(/WEBHOOK_SECRET/);

    const denied = fakeOctokit({ listWebhooks: async () => Promise.reject(Object.assign(new Error("Not Found"), { status: 404 })) });
    await expect(setAutoScan({ userId: me, row, enabled: true, octokit: denied.octokit, ...hook })).rejects.toBeInstanceOf(AutoScanError);
    const [after] = await getDb().select().from(repos).where(eq(repos.id, row.id));
    expect(after.autoScan).toBe(false);
  });

  it("cannot change another user's repo", async () => {
    const row = await shop({ autoScan: false });
    const { octokit } = fakeOctokit();
    const [{ id: stranger }] = await getDb().insert(users).values({ githubId: 91, login: "stranger", accessTokenEnc: "x" }).returning({ id: users.id });
    await setAutoScan({ userId: stranger, row, enabled: true, octokit, ...hook });
    const [after] = await getDb().select().from(repos).where(eq(repos.id, row.id));
    expect(after.autoScan).toBe(false);
  });
});
