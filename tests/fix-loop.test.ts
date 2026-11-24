import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Octokit } from "@octokit/rest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, setDbForTesting, type Db } from "@/db";
import * as schema from "@/db/schema";
import { LlmError } from "@/lib/agent/llm";
import { finalizeRecheck, startRecheckForFix } from "@/lib/fixes/recheck";
import { fixErrorMessage, runFix } from "@/lib/fixes/run";
import { createFix, findOpenFix, getFixForRun, getFixView } from "@/lib/fixes/store";
import { handleGithubEvent } from "@/lib/fixes/webhook";
import { applyIngest } from "@/lib/ingest/apply";
import type { IngestEvent } from "@/lib/ingest/schema";
import type { Dispatcher } from "@/lib/scans/start";

const { users, repos, flows, scans, runs, fixes, events } = schema;
let client: PGlite;
let me: string;
let other: string;

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "src/db/migrations" });
  setDbForTesting(db as unknown as Db);
  const d = getDb();
  [{ id: me }] = await d.insert(users).values({ githubId: 71, login: "me", accessTokenEnc: "x" }).returning({ id: users.id });
  [{ id: other }] = await d.insert(users).values({ githubId: 72, login: "other", accessTokenEnc: "x" }).returning({ id: users.id });
  process.env.AUTH_URL = "https://blomp.test";
});
afterAll(async () => {
  setDbForTesting(undefined);
  await client.close();
});

let n = 0;
/** A repo with one flow and a finished scan whose run failed, the way a real failure is stored. */
async function failedRun(over: { triage?: schema.Run["triage"] } = {}) {
  const d = getDb();
  n++;
  const [repo] = await d.insert(repos).values({ userId: me, fullName: `me/shop${n}`, prodUrl: "https://shop.example.com" }).returning();
  const [flow] = await d.insert(flows).values({ repoId: repo.id, name: "Checkout", objective: "Add a product, pay with the test card and see the order confirmation" }).returning();
  const [scan] = await d.insert(scans).values({ repoId: repo.id, trigger: "manual", targetUrl: "https://shop.example.com", status: "done", score: 0 }).returning();
  const [run] = await d
    .insert(runs)
    .values({
      scanId: scan.id,
      flowId: flow.id,
      verdict: "fail",
      oneLiner: 'The page showed "Enter a valid 16-digit card number" for a valid card',
      failingStep: "Place order",
      triage: over.triage ?? { category: "application_issue", rootCause: "Card validation rejects 16 digit numbers" },
    })
    .returning();
  return { repo, flow, scan, run };
}

const FILES: Record<string, string> = {
  "src/lib/validation.ts": "export function isValidCard(card: string) {\n  const digits = card.replace(/\\s/g, '');\n  return digits.length > 16;\n}\n",
  "src/app/checkout/page.tsx": "export default function Checkout() {\n  if (!isValidCard(card)) return setError('Enter a valid 16-digit card number');\n  return null;\n}\n",
};
const GOOD_ANSWER = JSON.stringify({
  summary: "The card check rejected 16 digit numbers; it now accepts exactly 16 digits.",
  files: [{ path: "src/lib/validation.ts", content: "export function isValidCard(card: string) {\n  const digits = card.replace(/\\s/g, '');\n  return digits.length === 16;\n}\n" }],
});

function fakeOctokit(repoName: string, over: { createRef?: () => Promise<unknown>; getRef?: () => Promise<unknown> } = {}) {
  const git = {
    getTree: vi.fn(async () => ({ data: { tree: Object.keys(FILES).map((path) => ({ type: "blob", path })), truncated: false } })),
    getRef: vi.fn(over.getRef ?? (async () => ({ data: { object: { sha: "base" } } }))),
    getCommit: vi.fn(async () => ({ data: { tree: { sha: "t0" } } })),
    createBlob: vi.fn(async () => ({ data: { sha: "blob1" } })),
    createTree: vi.fn(async () => ({ data: { sha: "t1" } })),
    createCommit: vi.fn(async () => ({ data: { sha: "commit1" } })),
    createRef: vi.fn(over.createRef ?? (async () => ({ data: {} }))),
  };
  const reposApi = {
    get: vi.fn(async () => ({ data: { full_name: `me/${repoName}`, owner: { login: "me" }, name: repoName, default_branch: "main", private: false, fork: false } })),
    getContent: vi.fn(async ({ path }: { path: string }) => {
      if (!(path in FILES)) throw Object.assign(new Error("Not Found"), { status: 404 });
      return { data: FILES[path] };
    }),
    listWebhooks: vi.fn(async () => ({ data: [] })),
    createWebhook: vi.fn(async () => ({ data: { id: 555 } })),
    updateWebhook: vi.fn(),
  };
  const pulls = { create: vi.fn(async () => ({ data: { number: 12, html_url: `https://github.com/me/${repoName}/pull/12` } })) };
  const issues = { createComment: vi.fn(async () => ({ data: {} })) };
  const octokit = { rest: { git, repos: reposApi, pulls, issues } } as unknown as Octokit;
  return { octokit, git, repos: reposApi, pulls, issues };
}

const deps = (octokit: Octokit, chat: () => Promise<string>) => ({
  octokit,
  chat,
  webhookUrl: "https://blomp.test/api/webhooks/github",
  webhookSecret: "whsec",
});

describe("createFix", () => {
  it("returns the same fix for a second tap, so one failure never opens two pull requests", async () => {
    const { run } = await failedRun();
    const a = await createFix(run.id);
    const b = await createFix(run.id);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.fix.id).toBe(a.fix.id);
  });

  it("is only visible to the repo's owner", async () => {
    const { run } = await failedRun();
    const { fix } = await createFix(run.id);
    expect((await getFixForRun(me, run.id))?.id).toBe(fix.id);
    expect(await getFixForRun(other, run.id)).toBeUndefined();
    expect(await getFixView(other, fix.id)).toBeUndefined();
  });
});

describe("runFix", () => {
  it("writes a fix, sets up the webhook, opens the pull request and records it", async () => {
    const { repo, run } = await failedRun();
    const { fix } = await createFix(run.id);
    const gh = fakeOctokit(repo.fullName.split("/")[1]);

    await runFix(fix.id, deps(gh.octokit, async () => GOOD_ANSWER));

    const [row] = await getDb().select().from(fixes).where(eq(fixes.id, fix.id));
    expect(row).toMatchObject({ status: "pr_open", prNumber: 12, headSha: "commit1", error: null });
    expect(row.branch).toBe(`blomp/fix-${fix.id.slice(0, 8)}`);
    expect(row.summary).toMatch(/16 digits/);

    expect(gh.git.createBlob).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("=== 16") }));
    expect(gh.pulls.create).toHaveBeenCalledWith(expect.objectContaining({ base: "main", title: "Fix: Checkout" }));
    expect(gh.repos.createWebhook).toHaveBeenCalledTimes(1);
    const [r] = await getDb().select().from(repos).where(eq(repos.id, repo.id));
    expect(r.webhookId).toBe(555);

    const [ev] = await getDb().select().from(events).where(and(eq(events.repoId, repo.id), eq(events.kind, "fix_opened")));
    expect(ev.payload).toMatchObject({ prNumber: 12 });
  });

  it("marks the fix failed with a readable reason when the model times out", async () => {
    const { repo, run } = await failedRun();
    const { fix } = await createFix(run.id);
    const gh = fakeOctokit(repo.fullName.split("/")[1]);
    await runFix(
      fix.id,
      deps(gh.octokit, async () => {
        throw new LlmError("The model took too long to answer", "timeout");
      }),
    );
    const [row] = await getDb().select().from(fixes).where(eq(fixes.id, fix.id));
    expect(row).toMatchObject({ status: "failed", error: "The model took too long to answer", prNumber: null });
    expect(gh.pulls.create).not.toHaveBeenCalled();
  });

  it("explains a GitHub permission problem in plain words", async () => {
    const { repo, run } = await failedRun();
    const { fix } = await createFix(run.id);
    const gh = fakeOctokit(repo.fullName.split("/")[1], { getRef: async () => Promise.reject(Object.assign(new Error("Forbidden"), { status: 403 })) });
    await runFix(fix.id, deps(gh.octokit, async () => GOOD_ANSWER));
    const [row] = await getDb().select().from(fixes).where(eq(fixes.id, fix.id));
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/would not let Blomp open a pull request/);
  });

  it("does nothing for a fix that already moved on", async () => {
    const { repo, run } = await failedRun();
    const { fix } = await createFix(run.id);
    await getDb().update(fixes).set({ status: "verified" }).where(eq(fixes.id, fix.id));
    const gh = fakeOctokit(repo.fullName.split("/")[1]);
    await runFix(fix.id, deps(gh.octokit, async () => GOOD_ANSWER));
    expect(gh.pulls.create).not.toHaveBeenCalled();
  });

  it("maps unexpected errors to a generic line", () => {
    expect(fixErrorMessage(new Error("boom"))).toBe("Something went wrong while writing the fix. Try again.");
    expect(fixErrorMessage(Object.assign(new Error("x"), { status: 401 }))).toMatch(/sign back in/);
  });
});

/** A fix whose pull request is open, ready for its preview to be re-checked. */
async function openFix() {
  const ctx = await failedRun();
  const { fix } = await createFix(ctx.run.id);
  const branch = `blomp/fix-${fix.id.slice(0, 8)}`;
  await getDb().update(fixes).set({ status: "pr_open", branch, prNumber: 12, prUrl: "https://github.com/x/pull/12", headSha: "commit1" }).where(eq(fixes.id, fix.id));
  return { ...ctx, fixId: fix.id, branch };
}

describe("startRecheckForFix", () => {
  it("re-runs only the failed flow, on the preview address, once", async () => {
    const { fixId, flow, repo } = await openFix();
    const dispatch = vi.fn<Dispatcher>(async () => {});

    const first = await startRecheckForFix(fixId, { previewUrl: "https://shop-git-fix.vercel.app", sha: "commit1" }, { dispatch });
    expect(first.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ targetUrl: "https://shop-git-fix.vercel.app", flows: [expect.objectContaining({ id: flow.id })] });

    const [scan] = await getDb().select().from(scans).where(eq(scans.id, (first as { scanId: string }).scanId));
    expect(scan).toMatchObject({ trigger: "recheck", repoId: repo.id, commitSha: "commit1" });
    const [row] = await getDb().select().from(fixes).where(eq(fixes.id, fixId));
    expect(row).toMatchObject({ status: "verifying", recheckScanId: scan.id, previewUrl: "https://shop-git-fix.vercel.app" });

    const again = await startRecheckForFix(fixId, { previewUrl: "https://shop-git-fix.vercel.app" }, { dispatch });
    expect(again.ok).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("is not blocked by an unrelated scan that is already running", async () => {
    const { fixId, repo } = await openFix();
    await getDb().insert(scans).values({ repoId: repo.id, trigger: "manual", targetUrl: "https://shop.example.com", status: "running" });
    const dispatch = vi.fn<Dispatcher>(async () => {});
    const res = await startRecheckForFix(fixId, { previewUrl: "https://preview.example.com" }, { dispatch });
    expect(res.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("marks the fix failed, and keeps the pull request, when GitHub Actions refuses", async () => {
    const { fixId } = await openFix();
    const dispatch = vi.fn<Dispatcher>(async () => {
      throw new Error("down");
    });
    const res = await startRecheckForFix(fixId, { previewUrl: "https://preview.example.com" }, { dispatch });
    expect(res.ok).toBe(false);
    const [row] = await getDb().select().from(fixes).where(eq(fixes.id, fixId));
    expect(row).toMatchObject({ status: "failed", prNumber: 12 });
    expect(row.error).toMatch(/Could not start/);
  });

  it("refuses a fix that has no pull request", async () => {
    const { run } = await failedRun();
    const { fix } = await createFix(run.id);
    const res = await startRecheckForFix(fix.id, { previewUrl: "https://preview.example.com" }, { dispatch: vi.fn() });
    expect(res).toMatchObject({ ok: false });
  });
});

describe("finalizeRecheck", () => {
  async function recheckingFix() {
    const o = await openFix();
    const res = await startRecheckForFix(o.fixId, { previewUrl: "https://preview.example.com", sha: "commit1" }, { dispatch: async () => {} });
    return { ...o, scanId: (res as { scanId: string }).scanId };
  }

  it("marks the fix verified and tells the pull request when the flow passes", async () => {
    const { fixId, scanId } = await recheckingFix();
    await getDb().update(runs).set({ verdict: "pass" }).where(eq(runs.scanId, scanId));
    const gh = fakeOctokit("x");

    await finalizeRecheck(scanId, { octokit: gh.octokit });

    const [row] = await getDb().select().from(fixes).where(eq(fixes.id, fixId));
    expect(row).toMatchObject({ status: "verified", error: null });
    expect(gh.issues.createComment).toHaveBeenCalledTimes(1);
    const body = (gh.issues.createComment.mock.calls[0] as unknown as [{ body: string; issue_number: number }])[0];
    expect(body.issue_number).toBe(12);
    expect(body.body).toContain("Kane verified");
    expect(body.body).toContain(`https://blomp.test/repos/`);
    const [ev] = await getDb().select().from(events).where(eq(events.kind, "fix_verified"));
    expect(ev.payload).toMatchObject({ fixId });
  });

  it("says the flow still fails when it does, and does not call it verified", async () => {
    const { fixId, scanId } = await recheckingFix();
    await getDb().update(runs).set({ verdict: "fail" }).where(eq(runs.scanId, scanId));
    const gh = fakeOctokit("x");
    await finalizeRecheck(scanId, { octokit: gh.octokit });
    const [row] = await getDb().select().from(fixes).where(eq(fixes.id, fixId));
    expect(row).toMatchObject({ status: "failed", error: "Kane re-checked the preview and the flow still fails." });
    expect((gh.issues.createComment.mock.calls[0] as unknown as [{ body: string }])[0].body).not.toContain("Kane verified");
  });

  it("treats an unfinished re-check as failed, never as a pass", async () => {
    const { fixId, scanId } = await recheckingFix();
    const gh = fakeOctokit("x");
    await finalizeRecheck(scanId, { octokit: gh.octokit }); // the run is still pending
    const [row] = await getDb().select().from(fixes).where(eq(fixes.id, fixId));
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/could not finish/);
  });

  it("acts once, and ignores scans that are not a re-check", async () => {
    const { scanId } = await recheckingFix();
    await getDb().update(runs).set({ verdict: "pass" }).where(eq(runs.scanId, scanId));
    const gh = fakeOctokit("x");
    await finalizeRecheck(scanId, { octokit: gh.octokit });
    await finalizeRecheck(scanId, { octokit: gh.octokit });
    expect(gh.issues.createComment).toHaveBeenCalledTimes(1);

    const { scan } = await failedRun();
    await finalizeRecheck(scan.id, { octokit: gh.octokit });
    expect(gh.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it("still records the result when the comment cannot be posted", async () => {
    const { fixId, scanId } = await recheckingFix();
    await getDb().update(runs).set({ verdict: "pass" }).where(eq(runs.scanId, scanId));
    const gh = fakeOctokit("x");
    gh.issues.createComment.mockRejectedValueOnce(new Error("rate limited"));
    await finalizeRecheck(scanId, { octokit: gh.octokit });
    const [row] = await getDb().select().from(fixes).where(eq(fixes.id, fixId));
    expect(row.status).toBe("verified");
  });
});

describe("ingest hooks the re-check up", () => {
  it("closes out the fix when the re-check scan ends, and leaves the repo's score alone", async () => {
    const { fixId, scanId, repo } = await (async () => {
      const o = await openFix();
      const res = await startRecheckForFix(o.fixId, { previewUrl: "https://preview.example.com", sha: "commit1" }, { dispatch: async () => {} });
      return { ...o, scanId: (res as { scanId: string }).scanId };
    })();
    await getDb().update(repos).set({ lastScore: 40 }).where(eq(repos.id, repo.id));
    await getDb().update(runs).set({ verdict: "pass" }).where(eq(runs.scanId, scanId));

    const onScanFinished = vi.fn(async (id: string) => finalizeRecheck(id, { octokit: fakeOctokit("x").octokit }));
    await applyIngest({ kind: "scan_end", scanId } as IngestEvent, { onScanFinished });

    expect(onScanFinished).toHaveBeenCalledWith(scanId);
    const [row] = await getDb().select().from(fixes).where(eq(fixes.id, fixId));
    expect(row.status).toBe("verified");
    const [r] = await getDb().select().from(repos).where(eq(repos.id, repo.id));
    expect(r.lastScore).toBe(40);
  });

  it("a failing follow-up never makes the runner's post fail", async () => {
    const { scan } = await failedRun();
    await getDb().update(scans).set({ status: "running" }).where(eq(scans.id, scan.id));
    const onScanFinished = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(applyIngest({ kind: "scan_end", scanId: scan.id } as IngestEvent, { onScanFinished })).resolves.toBeUndefined();
  });
});

describe("handleGithubEvent", () => {
  const payload = (over: Record<string, unknown> = {}, status: Record<string, unknown> = {}) => ({
    deployment_status: { state: "success", environment_url: "https://shop-git-fix.vercel.app", target_url: "https://vercel.com/inspect", ...status },
    deployment: { sha: "commit1", ref: "main", environment: "Preview", ...over },
    repository: { full_name: "me/shop" },
  });

  it("answers GitHub's ping", async () => {
    expect(await handleGithubEvent("ping", {})).toBe("pong");
  });

  it("starts a re-check when the fix branch's preview is ready", async () => {
    const { repo, branch } = await openFix();
    const dispatch = vi.fn<Dispatcher>(async () => {});
    const outcome = await handleGithubEvent("deployment_status", { ...payload({ ref: branch }), repository: { full_name: repo.fullName } }, { dispatch });
    expect(outcome).toBe("recheck_started");
    expect(dispatch.mock.calls[0][0].targetUrl).toBe("https://shop-git-fix.vercel.app");
  });

  it("matches by commit when the deployment's ref is not the branch name", async () => {
    const { repo } = await openFix();
    const dispatch = vi.fn<Dispatcher>(async () => {});
    const outcome = await handleGithubEvent("deployment_status", { ...payload({ ref: "something-else" }), repository: { full_name: repo.fullName } }, { dispatch });
    expect(outcome).toBe("recheck_started");
  });

  it("ignores everything that is not a ready preview of a fix", async () => {
    const { repo, branch } = await openFix();
    const dispatch = vi.fn<Dispatcher>(async () => {});
    const repository = { full_name: repo.fullName };
    expect(await handleGithubEvent("push", {}, { dispatch })).toBe("ignored");
    expect(await handleGithubEvent("deployment_status", { ...payload({ ref: branch }, { state: "pending" }), repository }, { dispatch })).toBe("ignored");
    expect(await handleGithubEvent("deployment_status", { ...payload({ ref: branch, environment: "Production" }), repository }, { dispatch })).toBe("ignored");
    expect(await handleGithubEvent("deployment_status", { nonsense: true }, { dispatch })).toBe("ignored");
    expect(await handleGithubEvent("deployment_status", { ...payload({ ref: "main", sha: "zzz" }), repository }, { dispatch })).toBe("no_matching_fix");
    expect(dispatch).not.toHaveBeenCalled();
    expect(await findOpenFix(repo.fullName, branch, "commit1")).toBeTruthy(); // still waiting for a real preview
  });

  it("does not start a second re-check when GitHub repeats the event", async () => {
    const { repo, branch } = await openFix();
    const dispatch = vi.fn<Dispatcher>(async () => {});
    const body = { ...payload({ ref: branch }), repository: { full_name: repo.fullName } };
    expect(await handleGithubEvent("deployment_status", body, { dispatch })).toBe("recheck_started");
    expect(await handleGithubEvent("deployment_status", body, { dispatch })).toBe("no_matching_fix");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
