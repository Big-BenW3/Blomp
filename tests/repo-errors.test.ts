import { describe, expect, it } from "vitest";
import { DiscoveryError } from "@/lib/agent/discover";
import { LlmError } from "@/lib/agent/llm";
import { friendlyError } from "@/lib/repos/errors";

describe("friendlyError", () => {
  it("explains a missing model key", () => {
    const msg = friendlyError(new DiscoveryError("NVIDIA_API_KEY and NVIDIA_MODEL must be set", "llm"));
    expect(msg).toMatch(/not set up/);
    expect(msg).not.toMatch(/must be set/);
  });
  it("passes model errors through", () => {
    expect(friendlyError(new LlmError("The model took too long to answer", "timeout"))).toBe("The model took too long to answer");
  });
  it("maps GitHub statuses", () => {
    expect(friendlyError({ status: 401 })).toMatch(/sign in again/);
    expect(friendlyError({ status: 403 })).toMatch(/limiting/);
    expect(friendlyError({ status: 404 })).toMatch(/cannot see/);
  });
  it("falls back to a generic line and never leaks the raw error", () => {
    expect(friendlyError(new Error("connect ECONNREFUSED 10.0.0.1"))).toBe("Something went wrong. Try again.");
  });
});
