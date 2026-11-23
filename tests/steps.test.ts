import { describe, expect, it } from "vitest";
import { collapseSteps, stepText } from "@/lib/scans/steps";

const step = (id: number, idx: number, status: string, remark: string, runId = "r1") => ({ id, runId, idx, status, remark });

describe("collapseSteps", () => {
  it("keeps one line per step: the newest, in the step's original position", () => {
    const out = collapseSteps([
      step(1, 2, "running", "Step 1"),
      step(2, 2, "done", "navigate: Navigate to https://x.dev/"),
      step(3, 3, "running", "Step 2"),
    ]);
    expect(out.map((s) => [s.idx, s.status])).toEqual([
      [2, "done"],
      [3, "running"],
    ]);
  });

  it("does not merge steps from different runs", () => {
    expect(collapseSteps([step(1, 2, "done", "a", "r1"), step(2, 2, "done", "b", "r2")])).toHaveLength(2);
  });
});

describe("stepText", () => {
  it("shortens navigation to the address", () => {
    expect(stepText("navigate: Navigate to https://blomp.vercel.app/signin", 2)).toBe("Opened blomp.vercel.app/signin");
  });
  it("labels checks and drops Kane's PRIMARY marker", () => {
    expect(stepText("analyze: a Continue with GitHub button is visible", 4)).toBe("Checked: a Continue with GitHub button is visible");
    expect(stepText("wait: PRIMARY: Open the page", 3)).toBe("Open the page");
  });
  it("falls back to the step number when there is nothing to say", () => {
    expect(stepText("", 5)).toBe("Step 5");
    expect(stepText("Step 1", 2)).toBe("Step 1");
  });
});
