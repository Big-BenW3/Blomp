import { describe, expect, it } from "vitest";
import { ingestEvent } from "@/lib/ingest/schema";

const id = "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90";
const id2 = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";

describe("ingest event schema", () => {
  it("accepts a valid step and fills defaults", () => {
    const e = ingestEvent.parse({ kind: "step", scanId: id, flowId: id2, idx: 1, status: "done" });
    expect(e).toMatchObject({ kind: "step", remark: "" });
  });

  it("accepts a run_end with evidence", () => {
    const e = ingestEvent.parse({
      kind: "run_end",
      scanId: id,
      flowId: id2,
      exitCode: 1,
      end: { status: "failed", oneLiner: "x" },
      networkErrors: ["POST /api/auth -> 500"],
    });
    expect(e.kind).toBe("run_end");
  });

  it("rejects unknown kinds, bad ids and bad statuses", () => {
    expect(ingestEvent.safeParse({ kind: "drop_tables" }).success).toBe(false);
    expect(ingestEvent.safeParse({ kind: "scan_end", scanId: "not-a-uuid" }).success).toBe(false);
    expect(ingestEvent.safeParse({ kind: "step", scanId: id, flowId: id2, idx: 1, status: "boom" }).success).toBe(false);
  });

  it("rejects oversized lists and negative step indexes", () => {
    const many = Array.from({ length: 51 }, (_, i) => `e${i}`);
    expect(
      ingestEvent.safeParse({ kind: "run_end", scanId: id, flowId: id2, exitCode: 1, consoleErrors: many }).success,
    ).toBe(false);
    expect(ingestEvent.safeParse({ kind: "step", scanId: id, flowId: id2, idx: -1, status: "done" }).success).toBe(false);
  });
});
