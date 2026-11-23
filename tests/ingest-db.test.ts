import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setDbForTesting, getDb, type Db } from "@/db";
import * as schema from "@/db/schema";
import { applyIngest, NotFoundError } from "@/lib/ingest/apply";
import type { IngestEvent } from "@/lib/ingest/schema";

const { users, repos, flows, scans, runs, runSteps, events } = schema;

let client: PGlite;
let scanId: string;
let repoId: string;
let userId: string;
let flowA: string;
let flowB: string;
let flowC: string;

const ev = (e: Record<string, unknown>) => e as unknown as IngestEvent;

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "src/db/migrations" });
  setDbForTesting(db as unknown as Db);

  const d = getDb();
  [{ id: userId }] = await d.insert(users).values({ githubId: 1, login: "tester", accessTokenEnc: "x" }).returning({ id: users.id });
  [{ id: repoId }] = await d
    .insert(repos)
    .values({ userId, fullName: "tester/shop", prodUrl: "https://shop.test" })
    .returning({ id: repos.id });
  const f = await d
    .insert(flows)
    .values([
      { repoId, name: "A", objective: "a" },
      { repoId, name: "B", objective: "b" },
      { repoId, name: "C", objective: "c" },
    ])
    .returning({ id: flows.id });
  [flowA, flowB, flowC] = f.map((x) => x.id);
  [{ id: scanId }] = await d
    .insert(scans)
    .values({ repoId, trigger: "manual", targetUrl: "https://shop.test" })
    .returning({ id: scans.id });
});

afterAll(async () => {
  setDbForTesting(undefined);
  await client.close();
});

describe("applyIngest against real Postgres", () => {
  it("marks the scan running on scan_start", async () => {
    await applyIngest(ev({ kind: "scan_start", scanId, workflowRunId: 42 }));
    const [s] = await getDb().select().from(scans).where(eq(scans.id, scanId));
    expect(s).toMatchObject({ status: "running", workflowRunId: 42 });
  });

  it("stores each step once even when the runner retries a post", async () => {
    const step = { kind: "step", scanId, flowId: flowA, idx: 1, status: "done", remark: "Page loaded" };
    await applyIngest(ev(step));
    await applyIngest(ev(step));
    await applyIngest(ev({ ...step, idx: 2 }));
    const rows = await getDb().select().from(runSteps);
    expect(rows).toHaveLength(2);
  });

  it("records pass, fail and unknown verdicts from exit codes", async () => {
    await applyIngest(ev({ kind: "run_end", scanId, flowId: flowA, exitCode: 0, end: { status: "passed" } }));
    await applyIngest(
      ev({
        kind: "run_end",
        scanId,
        flowId: flowB,
        exitCode: 1,
        end: { status: "failed", oneLiner: "Login redirect broke" },
        failingStep: "Expected dashboard, saw error page",
        networkErrors: ["POST /api/auth -> 500"],
        consoleErrors: ["TypeError: x"],
        triage: { category: "application_issue/ui_data_defect", rootCause: "Login redirects to an error page", severity: "major" },
      }),
    );
    await applyIngest(ev({ kind: "run_end", scanId, flowId: flowC, exitCode: 2 }));

    const rows = await getDb().select().from(runs).where(eq(runs.scanId, scanId));
    const by = (id: string) => rows.find((r) => r.flowId === id)!;
    expect(by(flowA).verdict).toBe("pass");
    expect(by(flowB)).toMatchObject({
      verdict: "fail",
      oneLiner: "Login redirect broke",
      failingStep: "Expected dashboard, saw error page",
      networkErrors: ["POST /api/auth -> 500"],
      triage: { category: "application_issue/ui_data_defect", severity: "major" },
    });
    expect(by(flowC).verdict).toBe("unknown");
  });

  it("scan_end excludes unknown from the score and updates the repo and the feed", async () => {
    await applyIngest(ev({ kind: "scan_end", scanId }));
    const [s] = await getDb().select().from(scans).where(eq(scans.id, scanId));
    expect(s).toMatchObject({ status: "done", passed: 1, failed: 1, unknown: 1, score: 50 });
    const [r] = await getDb().select().from(repos).where(eq(repos.id, repoId));
    expect(r.lastScore).toBe(50);
    const feed = await getDb().select().from(events).where(eq(events.repoId, repoId));
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ kind: "scan_done", userId });
  });

  it("turns a flow that never reported an end into unknown, not a pass", async () => {
    const [s2] = await getDb()
      .insert(scans)
      .values({ repoId, trigger: "manual", targetUrl: "https://shop.test" })
      .returning({ id: scans.id });
    await applyIngest(ev({ kind: "run_start", scanId: s2.id, flowId: flowA }));
    await applyIngest(ev({ kind: "scan_end", scanId: s2.id }));
    const [run] = await getDb().select().from(runs).where(eq(runs.scanId, s2.id));
    expect(run.verdict).toBe("unknown");
    const [scan] = await getDb().select().from(scans).where(eq(scans.id, s2.id));
    expect(scan).toMatchObject({ score: null, unknown: 1 });
  });

  it("downgrades exit 0 with a failed run_end to unknown", async () => {
    const [s3] = await getDb()
      .insert(scans)
      .values({ repoId, trigger: "manual", targetUrl: "https://shop.test" })
      .returning({ id: scans.id });
    await applyIngest(ev({ kind: "run_end", scanId: s3.id, flowId: flowA, exitCode: 0, end: { status: "failed" } }));
    const [run] = await getDb().select().from(runs).where(eq(runs.scanId, s3.id));
    expect(run.verdict).toBe("unknown");
  });

  it("answers 404-style for unknown scans and for flows from another repo", async () => {
    await expect(
      applyIngest(ev({ kind: "run_start", scanId: "00000000-0000-4000-8000-000000000000", flowId: flowA })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(applyIngest(ev({ kind: "scan_start", scanId: "00000000-0000-4000-8000-000000000000" }))).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const [other] = await getDb().insert(repos).values({ userId, fullName: "tester/other" }).returning({ id: repos.id });
    const [foreign] = await getDb().insert(flows).values({ repoId: other.id, name: "F", objective: "f" }).returning({ id: flows.id });
    await expect(applyIngest(ev({ kind: "run_start", scanId, flowId: foreign.id }))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("marks a scan as error on scan_error", async () => {
    const [s4] = await getDb()
      .insert(scans)
      .values({ repoId, trigger: "manual", targetUrl: "https://shop.test" })
      .returning({ id: scans.id });
    await applyIngest(ev({ kind: "scan_error", scanId: s4.id, message: "boom" }));
    const [scan] = await getDb().select().from(scans).where(eq(scans.id, s4.id));
    expect(scan.status).toBe("error");
  });
});
