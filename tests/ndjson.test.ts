import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseKaneLine, resolveVerdict, RunCollector } from "@/lib/kane/ndjson";

const fixture = (name: string) => readFileSync(`tests/fixtures/kane/${name}.ndjson`, "utf8").split("\n");

describe("parseKaneLine", () => {
  it("parses step lines", () => {
    expect(parseKaneLine('{"v":1,"step":3,"status":"done","remark":"Clicked"}')).toEqual({
      kind: "step",
      idx: 3,
      status: "done",
      remark: "Clicked",
    });
  });

  it("maps unknown step statuses to info", () => {
    expect(parseKaneLine('{"step":1,"status":"weird"}')).toMatchObject({ kind: "step", status: "info" });
  });

  it("parses run_end and both credit field names", () => {
    const a = parseKaneLine('{"type":"run_end","status":"passed","credits_consumed":2}');
    const b = parseKaneLine('{"type":"run_end","status":"failed","credits":4,"run_dir":"/x"}');
    expect(a).toMatchObject({ kind: "run_end", end: { status: "passed", credits: 2 } });
    expect(b).toMatchObject({ kind: "run_end", end: { credits: 4, sessionDir: "/x" } });
  });

  it("ignores junk, arrays, blank lines and bad step numbers", () => {
    for (const line of ["", "hello", "[1,2]", "{broken", '{"step":"abc"}', '{"step":-1}', '{"no":"match"}']) {
      expect(parseKaneLine(line).kind).toBe("ignored");
    }
  });

  it("reports unknown typed events without failing", () => {
    expect(parseKaneLine('{"type":"bifurcation","count":2}')).toEqual({ kind: "other", type: "bifurcation" });
  });
});

describe("resolveVerdict", () => {
  const passed = { status: "passed" };
  const failed = { status: "failed", reason: "Saw a 500" };

  it("passes only when exit 0 and run_end agree", () => {
    expect(resolveVerdict(0, passed).verdict).toBe("pass");
    expect(resolveVerdict(0, undefined).verdict).toBe("pass");
    expect(resolveVerdict(0, failed).verdict).toBe("unknown");
  });

  it("fails only when exit 1 and run_end says failed", () => {
    expect(resolveVerdict(1, failed)).toEqual({ verdict: "fail", reason: "Saw a 500" });
    expect(resolveVerdict(1, passed).verdict).toBe("unknown");
    expect(resolveVerdict(1, undefined).verdict).toBe("unknown");
  });

  it("treats exit 2, 3 and anything unexpected as unknown", () => {
    for (const code of [2, 3, 4, 137, -1]) expect(resolveVerdict(code, passed).verdict).toBe("unknown");
  });
});

describe("RunCollector on fixtures", () => {
  it("collects a passing run and skips junk lines", () => {
    const c = new RunCollector();
    fixture("pass").forEach((l) => c.push(l));
    expect(c.end?.status).toBe("passed");
    expect(c.end?.oneLiner).toBe("Page loads and shows the heading");
    expect(c.failingStep).toBeUndefined();
    expect(c.stepCount).toBe(2);
  });

  it("records the failing step", () => {
    const c = new RunCollector();
    fixture("fail").forEach((l) => c.push(l));
    expect(c.failingStep).toBe("Welcome page did not appear after submit");
    expect(resolveVerdict(1, c.end).verdict).toBe("fail");
  });
});

describe("real kane-cli 0.10.8 recording (passing run, trimmed)", () => {
  it("is parsed into a pass: exit 0 and run_end passed agree", () => {
    const c = new RunCollector();
    for (const line of fixture("real-pass")) c.push(line);
    expect(c.end).toMatchObject({
      status: "passed",
      oneLiner: "verified the Learn more link on example.com",
      credits: 5.24296,
      sessionDir: "/home/runner/.testmuai/kaneai/sessions/b41a26a0-ac37-48ee-ab54-54606a196b72",
    });
    expect(c.failingStep).toBeUndefined();
    expect(c.stepCount).toBe(3);
    expect(resolveVerdict(0, c.end).verdict).toBe("pass");
  });

  it("never turns that same recording into a pass if the exit code disagrees", () => {
    const c = new RunCollector();
    for (const line of fixture("real-pass")) c.push(line);
    expect(resolveVerdict(1, c.end).verdict).toBe("unknown");
    expect(resolveVerdict(2, c.end).verdict).toBe("unknown");
  });
});
