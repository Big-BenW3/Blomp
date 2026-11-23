/**
 * Parser for `kane-cli run --agent` NDJSON output.
 * Contract (https://www.testmuai.com/docs/kane-cli-agent-mode): every line has `v` and `ts`;
 * step lines have no `type` and carry `step`, `status`, `remark`; the final event is typed `run_end`.
 * Rules: skip non-JSON lines, ignore unknown fields and event types, pick `run_end` by type.
 */

export type Verdict = "pass" | "fail" | "unknown";
export type StepStatus = "running" | "done" | "failed" | "info";

export interface KaneRunEnd {
  status: string; // "passed" | "failed" (anything else is treated as not-passed)
  summary?: string;
  oneLiner?: string;
  reason?: string;
  durationSec?: number;
  credits?: number;
  testUrl?: string;
  sessionDir?: string;
  resultCode?: number;
}

export type KaneLine =
  | { kind: "step"; idx: number; status: StepStatus; remark: string }
  | { kind: "run_end"; end: KaneRunEnd }
  | { kind: "other"; type: string }
  | { kind: "ignored" };

const IGNORED: KaneLine = { kind: "ignored" };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function parseKaneLine(line: string): KaneLine {
  const text = line.trim();
  if (!text.startsWith("{")) return IGNORED;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return IGNORED;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return IGNORED;
  const o = obj as Record<string, unknown>;

  if (typeof o.type === "string") {
    if (o.type !== "run_end") return { kind: "other", type: o.type };
    return {
      kind: "run_end",
      end: {
        status: str(o.status) ?? "unknown",
        summary: str(o.summary),
        oneLiner: str(o.one_liner),
        reason: str(o.reason),
        durationSec: num(o.duration),
        credits: num(o.credits_consumed) ?? num(o.credits),
        testUrl: str(o.test_url),
        sessionDir: str(o.session_dir) ?? str(o.run_dir),
        resultCode: num(o.result_code),
      },
    };
  }

  if ("step" in o) {
    const idx = typeof o.step === "number" ? o.step : Number(o.step);
    if (!Number.isInteger(idx) || idx < 0) return IGNORED;
    const s = o.status;
    const status: StepStatus = s === "running" || s === "done" || s === "failed" ? s : "info";
    return { kind: "step", idx, status, remark: typeof o.remark === "string" ? o.remark : "" };
  }
  return IGNORED;
}

/**
 * Exit codes from the docs: 0 passed, 1 did not pass (or upload failed), 2 did not start (no credits used),
 * 3 cancelled or timed out. The exit code is read first; `run_end` can only confirm it.
 * A verdict is `pass` or `fail` only when the exit code and `run_end` agree. Anything else is `unknown`,
 * and unknown is never counted as a pass.
 */
export function resolveVerdict(
  exitCode: number,
  end: KaneRunEnd | undefined,
): { verdict: Verdict; reason: string } {
  const endPassed = end?.status === "passed";
  const endFailed = end?.status === "failed";

  if (exitCode === 0) {
    if (!end || endPassed) return { verdict: "pass", reason: end?.reason ?? "Kane passed" };
    return { verdict: "unknown", reason: "Kane exited 0 but run_end did not say passed" };
  }
  if (exitCode === 1) {
    if (endFailed) return { verdict: "fail", reason: end?.reason ?? end?.oneLiner ?? "Kane did not pass" };
    if (endPassed) return { verdict: "unknown", reason: "Kane reported passed but exited 1 (upload failure?)" };
    return { verdict: "unknown", reason: "Kane exited 1 without a run_end event" };
  }
  if (exitCode === 2) return { verdict: "unknown", reason: "Kane did not start (auth, setup, Chrome or network)" };
  if (exitCode === 3) return { verdict: "unknown", reason: "Kane was cancelled or hit its timeout" };
  return { verdict: "unknown", reason: `Unexpected Kane exit code ${exitCode}` };
}

/** Collects what a flow's run produced, line by line. */
export class RunCollector {
  end: KaneRunEnd | undefined;
  failingStep: string | undefined;
  stepCount = 0;

  push(line: string): KaneLine {
    const parsed = parseKaneLine(line);
    if (parsed.kind === "step") {
      if (parsed.status === "done" || parsed.status === "failed") this.stepCount += 1;
      if (parsed.status === "failed" && parsed.remark) this.failingStep = parsed.remark;
    } else if (parsed.kind === "run_end") {
      this.end = parsed.end;
    }
    return parsed;
  }
}
