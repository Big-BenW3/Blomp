export type RunVerdict = "pending" | "pass" | "fail" | "unknown";

export interface ScanSummary {
  passed: number;
  failed: number;
  unknown: number;
  /** passed / (passed + failed) as a whole percent. null when no flow reached a verdict. */
  score: number | null;
  /** true only when every flow reached pass or fail. */
  complete: boolean;
}

/**
 * Unknown (and still-pending) flows are never counted as passes. They are excluded from the score and
 * reported beside it, so a scan where Kane could not check a flow cannot look healthier than it is.
 */
export function summarize(verdicts: RunVerdict[]): ScanSummary {
  const passed = verdicts.filter((v) => v === "pass").length;
  const failed = verdicts.filter((v) => v === "fail").length;
  const unknown = verdicts.length - passed - failed;
  const decided = passed + failed;
  return {
    passed,
    failed,
    unknown,
    score: decided === 0 ? null : Math.round((passed / decided) * 100),
    complete: verdicts.length > 0 && unknown === 0,
  };
}
