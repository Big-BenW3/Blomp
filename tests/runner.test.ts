import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { flowUrl, runScan, type FlowInput } from "../runner/lib";
import { findEvidencePack, readEvidence } from "../runner/evidence";
import type { IngestEventInput } from "@/lib/ingest/schema";

const SCAN = "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90";
const FLOW: FlowInput = { id: "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", name: "Signup", objective: "Sign up", path: "/signup" };
const FAKE = resolve("tests/fixtures/fake-kane.mjs");
const fx = (n: string) => resolve(`tests/fixtures/kane/${n}.ndjson`);

async function run(fixture: string | undefined, exit: number) {
  const events: IngestEventInput[] = [];
  process.env.FAKE_KANE_EXIT = String(exit);
  if (fixture) process.env.FAKE_KANE_FIXTURE = fx(fixture);
  else delete process.env.FAKE_KANE_FIXTURE;
  await runScan({
    scanId: SCAN,
    targetUrl: "https://shop.example.com",
    flows: [FLOW],
    kaneBin: FAKE,
    timeoutSec: 20,
    post: async (e) => void events.push(e),
  });
  return events;
}

describe("runner", () => {
  it("builds the flow URL from the target and the flow path", () => {
    expect(flowUrl("https://shop.example.com", "/signup")).toBe("https://shop.example.com/signup");
    expect(flowUrl("https://shop.example.com/app/", "")).toBe("https://shop.example.com/");
  });

  it("posts scan_start, run_start, steps, run_end, scan_end in order for a passing flow", async () => {
    const events = await run("pass", 0);
    expect(events.map((e) => e.kind)).toEqual(["scan_start", "run_start", "step", "step", "step", "run_end", "scan_end"]);
    expect(events.find((e) => e.kind === "run_end")).toMatchObject({ exitCode: 0, end: { status: "passed" } });
  });

  it("saves Kane's raw stdout and exit code when a raw directory is given", async () => {
    const rawDir = join(mkdtempSync(join(tmpdir(), "raw-")), "blomp-raw");
    process.env.FAKE_KANE_EXIT = "0";
    process.env.FAKE_KANE_FIXTURE = fx("pass");
    await runScan({
      scanId: SCAN,
      targetUrl: "https://shop.example.com",
      flows: [FLOW],
      kaneBin: FAKE,
      timeoutSec: 20,
      rawDir,
      post: async () => {},
    });
    const lines = readFileSync(join(rawDir, "kane-stdout.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.every((l) => l.flowId === FLOW.id)).toBe(true);
    expect(lines.some((l) => typeof l.stdout === "string" && l.stdout.includes("run_end"))).toBe(true);
    expect(lines.at(-1)).toMatchObject({ exitCode: 0 });
  });

  it("reports the failing step and exit code for a failing flow", async () => {
    const events = await run("fail", 1);
    expect(events.find((e) => e.kind === "run_end")).toMatchObject({
      exitCode: 1,
      failingStep: "Welcome page did not appear after submit",
      end: { status: "failed" },
    });
  });

  it("reports exit 2 when kane produces no output, never a pass", async () => {
    const events = await run(undefined, 2);
    const end = events.find((e) => e.kind === "run_end");
    expect(end).toMatchObject({ exitCode: 2 });
    expect(end && "end" in end ? end.end : undefined).toBeUndefined();
  });

  it("reports exit 2 when the kane binary does not exist", async () => {
    const events: IngestEventInput[] = [];
    await runScan({
      scanId: SCAN,
      targetUrl: "https://shop.example.com",
      flows: [FLOW],
      kaneBin: "/definitely/not/kane-cli",
      post: async (e) => void events.push(e),
    });
    expect(events.find((e) => e.kind === "run_end")).toMatchObject({ exitCode: 2 });
  });

  it("does not interpret shell characters in an objective", async () => {
    const events: IngestEventInput[] = [];
    process.env.FAKE_KANE_EXIT = "0";
    delete process.env.FAKE_KANE_FIXTURE;
    await runScan({
      scanId: SCAN,
      targetUrl: "https://shop.example.com",
      flows: [{ ...FLOW, objective: 'x"; touch /tmp/pwned; echo "' }],
      kaneBin: FAKE,
      post: async (e) => void events.push(e),
    });
    expect(events.at(-1)?.kind).toBe("scan_end");
  });
});

describe("evidence extraction", () => {
  function pack() {
    const dir = mkdtempSync(join(tmpdir(), "blomp-ev-"));
    const zip = new AdmZip();
    zip.addFile("result.json", Buffer.from("{}"));
    zip.addFile(
      "steps/2/console.json",
      Buffer.from(JSON.stringify([{ level: "error", text: "TypeError: x is undefined" }, { level: "log", text: "hi" }])),
    );
    zip.addFile(
      "steps/2/network.ndjson",
      Buffer.from('{"method":"POST","url":"https://s.test/api/auth","status":500}\n{"method":"GET","url":"/ok","status":200}\n'),
    );
    zip.addFile("steps/2/screenshot.png", Buffer.from([1, 2, 3]));
    writeFileSync(join(dir, "run.evidence"), zip.toBuffer());
    return dir;
  }

  it("finds the pack and keeps only real errors", () => {
    const dir = pack();
    const path = findEvidencePack(dir);
    expect(path).toMatch(/run\.evidence$/);
    const ev = readEvidence(path!);
    expect(ev.consoleErrors).toEqual(["TypeError: x is undefined"]);
    expect(ev.networkErrors).toEqual(["POST https://s.test/api/auth -> 500"]);
    expect(ev.entryNames).toContain("steps/2/screenshot.png");
  });

  it("returns undefined when there is no pack", () => {
    expect(findEvidencePack("/nonexistent/dir")).toBeUndefined();
  });
});
