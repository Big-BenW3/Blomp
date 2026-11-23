import { z } from "zod";

const runEnd = z.object({
  status: z.string().max(40),
  summary: z.string().max(4000).optional(),
  oneLiner: z.string().max(1000).optional(),
  reason: z.string().max(2000).optional(),
  durationSec: z.number().optional(),
  credits: z.number().optional(),
  testUrl: z.url().max(1000).optional(),
});

const base = { scanId: z.uuid() };
const flowBase = { ...base, flowId: z.uuid() };

/** Everything the GitHub Actions runner may tell the app. Anything else is rejected. */
export const ingestEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("scan_start"), ...base, workflowRunId: z.number().int().optional() }),
  z.object({ kind: z.literal("run_start"), ...flowBase }),
  z.object({
    kind: z.literal("step"),
    ...flowBase,
    idx: z.number().int().min(0).max(10_000),
    status: z.enum(["running", "done", "failed", "info"]),
    remark: z.string().max(2000).default(""),
  }),
  z.object({
    kind: z.literal("run_end"),
    ...flowBase,
    exitCode: z.number().int(),
    end: runEnd.optional(),
    failingStep: z.string().max(2000).optional(),
    consoleErrors: z.array(z.string().max(1000)).max(50).default([]),
    networkErrors: z.array(z.string().max(1000)).max(50).default([]),
  }),
  z.object({ kind: z.literal("scan_end"), ...base }),
  z.object({ kind: z.literal("scan_error"), ...base, message: z.string().max(2000) }),
]);

export type IngestEvent = z.infer<typeof ingestEvent>;
export type IngestEventInput = z.input<typeof ingestEvent>;
