import { describe, expect, it } from "vitest";
import { summarize } from "@/lib/kane/score";

describe("summarize", () => {
  it("scores passed over decided flows", () => {
    expect(summarize(["pass", "pass", "fail"])).toMatchObject({ passed: 2, failed: 1, unknown: 0, score: 67, complete: true });
  });

  it("never counts unknown or pending as a pass", () => {
    const s = summarize(["pass", "unknown", "pending"]);
    expect(s).toMatchObject({ passed: 1, failed: 0, unknown: 2, score: 100, complete: false });
  });

  it("gives no score when nothing was decided", () => {
    expect(summarize(["unknown", "pending"]).score).toBeNull();
    expect(summarize([]).score).toBeNull();
    expect(summarize([]).complete).toBe(false);
  });

  it("reaches 100 only when every decided flow passed", () => {
    expect(summarize(["pass", "pass"]).score).toBe(100);
    expect(summarize(["pass", "fail"]).score).toBe(50);
  });
});
