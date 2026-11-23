import { describe, expect, it } from "vitest";
import { scoreZone } from "@/lib/kane/score";
import { timeAgo } from "@/lib/time";

describe("scoreZone", () => {
  it("bands scores", () => {
    expect([100, 80, 79, 50, 49, 0].map(scoreZone)).toEqual(["pass", "pass", "warn", "warn", "fail", "fail"]);
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-11-23T12:00:00Z");
  const ago = (s: number) => timeAgo(new Date(now.getTime() - s * 1000), now);
  it("reads naturally", () => {
    expect(ago(5)).toBe("just now");
    expect(ago(60)).toBe("1 minute ago");
    expect(ago(14 * 60 + 20)).toBe("14 minutes ago");
    expect(ago(59 * 60 + 59)).toBe("59 minutes ago");
    expect(ago(3600)).toBe("1 hour ago");
    expect(ago(5 * 3600)).toBe("5 hours ago");
    expect(ago(2 * 86400)).toBe("2 days ago");
  });
  it("never goes negative for a clock that is slightly ahead", () => {
    expect(timeAgo(new Date(now.getTime() + 5000), now)).toBe("just now");
  });
});
