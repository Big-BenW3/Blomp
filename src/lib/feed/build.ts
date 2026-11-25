/** One line in the Feed. Built only from rows in the events table, plus the names and trigger of what they point at. */
export type Tone = "good" | "bad" | "warn" | "info";
export type FeedIconName = "check" | "x" | "alert" | "pr" | "bolt" | "shield";

export interface FeedItem {
  id: string;
  tone: Tone;
  icon: FeedIconName;
  title: string;
  detail: string;
  at: Date;
  /** "2m", "3h", "Mon": the short time on the right of the row. */
  ago: string;
  href: string;
  /** True for links that leave Blomp (a pull request on GitHub). */
  external: boolean;
}

export interface FeedGroup {
  label: string;
  items: FeedItem[];
}

export interface FeedEventRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  /** "owner/name" of the repo the event belongs to, when it still exists. */
  repoName: string | null;
}

export interface FeedContext {
  /** Scan id to how it was started (manual, push, recheck). */
  scanTrigger: Map<string, string>;
  /** Scan id to the names of the flows that failed in it, in the order they were added. */
  failedFlows: Map<string, string[]>;
  /** Run id to its flow's name. */
  flowByRun: Map<string, string>;
}

const str = (p: Record<string, unknown>, k: string): string | undefined => (typeof p[k] === "string" && p[k] ? (p[k] as string) : undefined);
const num = (p: Record<string, unknown>, k: string): number | undefined => (typeof p[k] === "number" && Number.isFinite(p[k]) ? (p[k] as number) : undefined);

/** "3m", "5h", "2d", then a date: short enough for the right edge of a row. */
export function shortAgo(from: Date, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000));
  if (s < 45) return "now";
  const m = Math.max(1, Math.floor(s / 60));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return from.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export function dayLabel(at: Date, now: Date): string {
  const today = dayKey(now);
  if (dayKey(at) === today) return "Today";
  const yesterday = dayKey(new Date(now.getTime() - 24 * 3600 * 1000));
  if (dayKey(at) === yesterday) return "Yesterday";
  const weekday = at.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const month = at.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  return `${weekday} ${at.getUTCDate()} ${month}`;
}

/** The pull request number from an event, or from the end of its address (".../pull/12"). */
function prNumber(p: Record<string, unknown>): number | undefined {
  const n = num(p, "prNumber");
  if (n) return n;
  const m = str(p, "prUrl")?.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

const shortName = (fullName: string) => fullName.split("/")[1] ?? fullName;

function scanTitle(failed: number, unknown: number, passed: number, score: number | null, names: string[]): { title: string; tone: Tone; icon: FeedIconName } | null {
  if (failed > 0) {
    const title =
      names.length === 0
        ? `${failed} flow${failed === 1 ? " is" : "s are"} broken`
        : names.length === 1
          ? `${names[0]} is broken`
          : `${names[0]} and ${names.length - 1} more are broken`;
    return { title, tone: "bad", icon: "x" };
  }
  if (unknown > 0) {
    return score === null
      ? { title: "Kane could not finish the scan", tone: "warn", icon: "alert" }
      : { title: `Kane could not decide ${unknown} flow${unknown === 1 ? "" : "s"}`, tone: "warn", icon: "alert" };
  }
  if (passed > 0) return { title: "All flows passed", tone: "good", icon: "check" };
  return null;
}

/** Turns event rows into Feed lines, newest first as given. Events that are only bookkeeping produce no line. */
export function buildFeedItems(rows: FeedEventRow[], ctx: FeedContext, now: Date): FeedItem[] {
  const items: FeedItem[] = [];
  for (const row of rows) {
    if (!row.repoName) continue;
    const p = row.payload ?? {};
    const repo = shortName(row.repoName);
    const base = { id: row.id, at: row.createdAt, ago: shortAgo(row.createdAt, now) };
    const scanId = str(p, "scanId");
    const scanHref = scanId ? `/repos/${row.repoName}/scans/${scanId}` : `/repos/${row.repoName}`;

    if (row.kind === "scan_done") {
      const trigger = (scanId && ctx.scanTrigger.get(scanId)) || "manual";
      const failed = num(p, "failed") ?? 0;
      const unknown = num(p, "unknown") ?? 0;
      const passed = num(p, "passed") ?? 0;
      const score = num(p, "score") ?? null;

      if (trigger === "recheck") {
        // A re-check that passed is already told by "fix verified"; only a re-check that did not pass is news.
        if (failed === 0 && unknown === 0) continue;
        items.push({
          ...base,
          tone: failed > 0 ? "bad" : "warn",
          icon: failed > 0 ? "x" : "alert",
          title: failed > 0 ? "Re-check did not pass" : "Re-check could not finish",
          detail: `${repo} · pull request preview`,
          href: scanHref,
          external: false,
        });
        continue;
      }

      const names = (scanId && ctx.failedFlows.get(scanId)) || [];
      const t = scanTitle(failed, unknown, passed, score, names);
      if (!t) continue;
      const parts = [repo, score === null ? null : `score ${score}`, trigger === "push" ? "after a push" : null].filter(Boolean);
      items.push({ ...base, ...t, detail: parts.join(" · "), href: scanHref, external: false });
      continue;
    }

    if (row.kind === "push_scan") {
      const sha = str(p, "sha");
      items.push({
        ...base,
        tone: "info",
        icon: "bolt",
        title: "Scan started after a push",
        detail: [repo, sha ? sha.slice(0, 7) : null].filter(Boolean).join(" · "),
        href: scanHref,
        external: false,
      });
      continue;
    }

    if (row.kind === "fix_opened" || row.kind === "fix_verified") {
      const runId = str(p, "runId");
      const flow = runId ? ctx.flowByRun.get(runId) : undefined;
      const n = prNumber(p);
      const prUrl = str(p, "prUrl");
      const detail = [repo, n ? `PR #${n}` : null].filter(Boolean).join(" · ");
      const verified = row.kind === "fix_verified";
      items.push({
        ...base,
        tone: verified ? "good" : "info",
        icon: verified ? "shield" : "pr",
        title: verified ? `${flow ?? "Flow"} fix verified` : flow ? `Fix proposed for ${flow}` : "Fix proposed",
        detail,
        href: prUrl ?? `/repos/${row.repoName}`,
        external: Boolean(prUrl),
      });
    }
  }
  return items;
}

/** Groups lines under Today, Yesterday and then one heading per day. Order within and between groups is kept. */
export function groupFeed(items: FeedItem[], now: Date): FeedGroup[] {
  const groups: FeedGroup[] = [];
  for (const item of items) {
    const label = dayLabel(item.at, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}
