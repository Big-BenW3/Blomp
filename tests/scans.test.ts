import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, setDbForTesting, type Db } from "@/db";
import * as schema from "@/db/schema";
import { applyIngest } from "@/lib/ingest/apply";
import type { IngestEvent } from "@/lib/ingest/schema";
import { getRunDetail, getScanSnapshot, getSteps, latestScanForRepo } from "@/lib/scans/queries";
import { createWorkflowDispatcher, ingestBase } from "@/lib/scans/dispatch";
import { ScanStartError, startScan, STALE_MS, type Dispatcher } from "@/lib/scans/start";
import { saveFlows, upsertRepo } from "@/lib/repos/store";

const { users, scans, runs } = schema;
let client: PGlite;
let userA: string;
let userB: string;

const ev = (e: Record<string, unknown>) => e as unknown as IngestEvent;
const form = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  objective: `Check that ${name} works fine`,
  path: "/",
  enabled: true,
  ...over,
});

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "src/db/migrations" });
  setDbForTesting(db as unknown as Db);
  const d = getDb();
  [{ id: userA }] = await d.insert(users).values({ githubId: 11, login: "a", accessTokenEnc: "x" }).returning({ id: users.id });
  [{ id: userB }] = await d.insert(users).values({ githubId: 12, login: "b", accessTokenEnc: "x" }).returning({ id: users.id });
});
afterAll(async () => {
  setDbForTesting(undefined);
  await client.close();
});

async function repoWithFlows(name: string, opts: { url?: string | null; flows?: ReturnType<typeof form>[] } = {}) {
  const repo = await upsertRepo(userA, { fullName: `a/${name}`, defaultBranch: "main" });
  if (opts.url !== null) await getDb().update(schema.repos).set({ prodUrl: opts.url ?? "https://shop.example.com" }).where(eq(schema.repos.id, repo.id));
  await saveFlows(repo.id, opts.flows ?? [form("Sign up"), form("Log in"), form("Search", { enabled: false })]);
  return (await upsertRepo(userA, { fullName: `a/${name}`, defaultBranch: "main" }));
}

describe("startScan", () => {
  it("creates a queued scan with one pending run per enabled flow, and dispatches them", async () => {
    const repo = await repoWithFlows("start");
    const dispatch = vi.fn<Dispatcher>(async () => {});
    const { scanId, reused } = await startScan({ userId: userA, repo, dispatch, commitSha: "abc1234" });
    expect(reused).toBe(false);

    const [scan] = await getDb().select().from(scans).where(eq(scans.id, scanId));
    expect(scan).toMatchObject({ status: "queued", trigger: "manual", targetUrl: "https://shop.example.com", commitSha: "abc1234" });
    const rows = await getDb().select().from(runs).where(eq(runs.scanId, scanId));
    expect(rows).toHaveLength(2); // the disabled flow is left out
    expect(rows.every((r) => r.verdict === "pending")).toBe(true);

    expect(dispatch).toHaveBeenCalledOnce();
    const call = dispatch.mock.calls[0][0];
    expect(call.scanId).toBe(scanId);
    expect(call.flows.map((f) => f.name)).toEqual(["Sign up", "Log in"]);
  });

  it("does not start a second scan while one is running", async () => {
    const repo = await repoWithFlows("double");
    const dispatch = vi.fn<Dispatcher>(async () => {});
    const first = await startScan({ userId: userA, repo, dispatch });
    const second = await startScan({ userId: userA, repo, dispatch });
    expect(second).toEqual({ scanId: first.scanId, reused: true });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("starts a new scan once the old one has gone stale", async () => {
    const repo = await repoWithFlows("stale");
    const dispatch = vi.fn<Dispatcher>(async () => {});
    const first = await startScan({ userId: userA, repo, dispatch });
    const later = new Date(Date.now() + STALE_MS + 1000);
    const second = await startScan({ userId: userA, repo, dispatch, now: later });
    expect(second.reused).toBe(false);
    expect(second.scanId).not.toBe(first.scanId);
  });

  it("asks for a site address and for a flow before doing anything", async () => {
    const dispatch = vi.fn<Dispatcher>(async () => {});
    const noUrl = await repoWithFlows("nourl", { url: null });
    await expect(startScan({ userId: userA, repo: noUrl, dispatch })).rejects.toThrow(/live site address/);
    const noFlows = await repoWithFlows("noflows", { flows: [form("Sign up", { enabled: false })] });
    await expect(startScan({ userId: userA, repo: noFlows, dispatch })).rejects.toThrow(/at least one flow/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("marks the scan as errored when GitHub refuses the dispatch, and says why", async () => {
    const repo = await repoWithFlows("refused");
    const dispatch: Dispatcher = async () => {
      throw new ScanStartError("GitHub refused the scan request.");
    };
    await expect(startScan({ userId: userA, repo, dispatch })).rejects.toThrow(/refused/);
    const last = await latestScanForRepo(repo.id);
    expect(last?.status).toBe("error");
    // the failed scan no longer counts as running, so a retry can start
    const ok = await startScan({ userId: userA, repo, dispatch: async () => {} });
    expect(ok.reused).toBe(false);
  });
});

describe("scan snapshot and steps", () => {
  it("follows a scan from queued to done and keeps results private to the owner", async () => {
    const repo = await repoWithFlows("snap");
    const { scanId } = await startScan({ userId: userA, repo, dispatch: async () => {} });
    const queued = await getScanSnapshot(userA, scanId);
    expect(queued).toMatchObject({ status: "queued", score: null, repoFullName: "a/snap", stalled: false });
    expect(queued?.runs.map((r) => [r.name, r.verdict])).toEqual([["Sign up", "pending"], ["Log in", "pending"]]);
    expect(await getScanSnapshot(userB, scanId)).toBeUndefined();

    const [signUp, logIn] = queued!.runs;
    await applyIngest(ev({ kind: "scan_start", scanId }));
    await applyIngest(ev({ kind: "step", scanId, flowId: signUp.flowId, idx: 1, status: "done", remark: "Opened the page" }));
    await applyIngest(ev({ kind: "step", scanId, flowId: signUp.flowId, idx: 2, status: "running", remark: "Typing the email" }));
    const first = await getSteps(scanId);
    expect(first.map((s) => s.remark)).toEqual(["Opened the page", "Typing the email"]);

    await applyIngest(ev({ kind: "step", scanId, flowId: signUp.flowId, idx: 3, status: "done", remark: "Submitted" }));
    const more = await getSteps(scanId, first[first.length - 1].id);
    expect(more.map((s) => s.remark)).toEqual(["Submitted"]);

    await applyIngest(ev({ kind: "run_end", scanId, flowId: signUp.flowId, exitCode: 0, end: { status: "passed", oneLiner: "Signed up" } }));
    await applyIngest(ev({ kind: "run_end", scanId, flowId: logIn.flowId, exitCode: 1, end: { status: "failed", oneLiner: "Login did nothing" } }));
    await applyIngest(ev({ kind: "scan_end", scanId }));

    const done = await getScanSnapshot(userA, scanId);
    expect(done).toMatchObject({ status: "done", score: 50, passed: 1, failed: 1, unknown: 0 });
    expect(done?.runs.map((r) => r.verdict)).toEqual(["pass", "fail"]);
  });

  it("shows a scan that never reports back as stopped", async () => {
    const repo = await repoWithFlows("stalled");
    const { scanId } = await startScan({ userId: userA, repo, dispatch: async () => {} });
    const later = new Date(Date.now() + STALE_MS + 1000);
    expect(await getScanSnapshot(userA, scanId, later)).toMatchObject({ status: "error", stalled: true });
    expect((await latestScanForRepo(repo.id, later))?.status).toBe("error");
  });

  it("returns a run's evidence only to the owner", async () => {
    const repo = await repoWithFlows("evidence");
    const { scanId } = await startScan({ userId: userA, repo, dispatch: async () => {} });
    const snap = await getScanSnapshot(userA, scanId);
    const run = snap!.runs[0];
    await applyIngest(
      ev({
        kind: "run_end",
        scanId,
        flowId: run.flowId,
        exitCode: 1,
        end: { status: "failed", oneLiner: "Place order did nothing" },
        triage: { category: "application_issue/logic", rootCause: "Reads the total too early" },
        networkErrors: ["POST /api/checkout -> 500"],
      }),
    );
    const detail = await getRunDetail(userA, run.id);
    expect(detail).toMatchObject({
      flowName: "Sign up",
      verdict: "fail",
      oneLiner: "Place order did nothing",
      networkErrors: ["POST /api/checkout -> 500"],
    });
    expect(detail?.triage?.rootCause).toBe("Reads the total too early");
    expect(await getRunDetail(userB, run.id)).toBeUndefined();
  });
});

describe("dispatcher", () => {
  const flows = [{ id: "f1", name: "Sign up", objective: "Sign up and see a welcome message", path: "/" }];
  it("explains missing setup instead of calling GitHub", async () => {
    await expect(createWorkflowDispatcher({})({ scanId: "s", targetUrl: "https://x.test", flows })).rejects.toThrow(/GITHUB_DISPATCH_TOKEN/);
    await expect(
      createWorkflowDispatcher({ GITHUB_DISPATCH_TOKEN: "t", GITHUB_REPOSITORY: "o/r" })({ scanId: "s", targetUrl: "https://x.test", flows }),
    ).rejects.toThrow(/AUTH_URL/);
  });
  it("finds the ingest base from the environment", () => {
    expect(ingestBase({ AUTH_URL: "https://blomp.vercel.app/" })).toBe("https://blomp.vercel.app");
    expect(ingestBase({ INGEST_BASE_URL: "https://x.test", AUTH_URL: "https://y.test" })).toBe("https://x.test");
    expect(ingestBase({ VERCEL_PROJECT_PRODUCTION_URL: "blomp.vercel.app" })).toBe("https://blomp.vercel.app");
    expect(ingestBase({ AUTH_URL: "not a url" })).toBeUndefined();
  });
});
