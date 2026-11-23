/** Kane reports a step when it starts and again when it ends. The log shows one line per step: the newest. */
export interface StepLike {
  id: number;
  runId: string;
  idx: number;
  status: string;
  remark: string;
}

export function collapseSteps<T extends StepLike>(steps: T[]): T[] {
  const byStep = new Map<string, T>();
  for (const s of steps) byStep.set(`${s.runId}:${s.idx}`, s); // re-setting keeps the step's original place in the list
  return [...byStep.values()];
}

const LABELS: Record<string, string> = {
  analyze: "Checked",
  assert: "Confirmed",
  click: "Clicked",
  type: "Typed",
};

/** Turns Kane's "kind: detail" remark into a plain line for the log. */
export function stepText(remark: string, idx: number): string {
  const text = remark.trim();
  const m = /^([a-z_]+):\s*(.+)$/i.exec(text);
  if (!m) return text || `Step ${idx}`;
  const kind = m[1].toLowerCase();
  const rest = m[2].replace(/^PRIMARY:\s*/i, "").trim();
  if (kind === "navigate") return `Opened ${rest.replace(/^Navigate to\s+/i, "").replace(/^https?:\/\//, "")}`;
  const label = LABELS[kind];
  return label ? `${label}: ${rest}` : rest;
}
