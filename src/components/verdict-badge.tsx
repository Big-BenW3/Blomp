import type { Verdict } from "@/lib/scans/queries";

const TEXT: Record<Verdict, string> = { pass: "PASS", fail: "FAIL", unknown: "UNKNOWN", pending: "WAITING" };

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <span className={`ui-badge ${verdict === "pass" || verdict === "fail" ? verdict : ""}`}>{TEXT[verdict]}</span>;
}
