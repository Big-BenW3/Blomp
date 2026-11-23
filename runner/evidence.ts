import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { parse as parseYaml } from "yaml";

/** Kane's own root-cause analysis of a failed run (from the evidence pack's failure.yaml). */
export interface Triage {
  title?: string;
  /** e.g. application_issue/ui_data_defect (a real bug) or automation_bug/config_issue (the flow itself is wrong) */
  category?: string;
  rootCause?: string;
  severity?: string;
  suggestedFix?: string;
  confidence?: number;
  errorMessage?: string;
}

export interface Evidence {
  consoleErrors: string[];
  networkErrors: string[];
  triage?: Triage;
  entryNames: string[];
  packPath?: string;
}

const MAX_ITEMS = 50;

/** Finds the newest `.evidence` pack under a Kane session folder (depth <= 4). */
export function findEvidencePack(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const found: { path: string; mtime: number }[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, depth + 1);
      else if (name.endsWith(".evidence")) found.push({ path: p, mtime: st.mtimeMs });
    }
  };
  walk(dir, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.path;
}

function records(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const whole = JSON.parse(trimmed);
    return Array.isArray(whole) ? whole : [whole];
  } catch {
    // not one JSON document: try NDJSON, falling back to plain lines
    return trimmed.split(/\r?\n/).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return line;
      }
    });
  }
}

const field = (o: Record<string, unknown>, ...keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined);

function consoleError(rec: unknown): string | undefined {
  if (typeof rec === "string") return /\berror\b|uncaught|exception/i.test(rec) ? rec.slice(0, 500) : undefined;
  if (typeof rec !== "object" || rec === null) return undefined;
  const o = rec as Record<string, unknown>;
  const level = String(field(o, "level", "type", "severity") ?? "");
  if (!/error/i.test(level)) return undefined;
  const msg = field(o, "text", "message", "msg");
  return (typeof msg === "string" ? msg : JSON.stringify(o)).slice(0, 500);
}

function harErrors(text: string): string[] {
  let har: { log?: { entries?: Array<{ request?: { method?: string; url?: string }; response?: Record<string, unknown> }> } };
  try {
    har = JSON.parse(text);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of har.log?.entries ?? []) {
    const status = Number(e.response?.status ?? 0);
    const failed = status === 0 && Boolean(e.response?._error ?? e.response?._failureText);
    if (status >= 400 || failed) {
      out.push(`${e.request?.method ?? "GET"} ${e.request?.url ?? "unknown url"} -> ${failed ? "failed" : status}`.slice(0, 500));
    }
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ") : undefined;
}

/** Reads Kane's triage from the first step-level failure.yaml in a pack. */
function readTriage(zip: AdmZip): Triage | undefined {
  const entry = zip
    .getEntries()
    .filter((e) => !e.isDirectory && /(^|\/)steps\/[^/]+\/failure\.yaml$/.test(e.entryName))
    .sort((a, b) => a.entryName.localeCompare(b.entryName))[0];
  if (!entry) return undefined;
  try {
    const y = parseYaml(entry.getData().toString("utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const rca = y?.triage?.rca ?? {};
    const triage: Triage = {
      title: str(y?.title),
      category: str(rca.category),
      rootCause: str(rca.root_cause),
      severity: str(y?.triage?.severity),
      suggestedFix: str(y?.triage?.suggested_fix?.summary),
      confidence: typeof rca.confidence === "number" ? rca.confidence : undefined,
      errorMessage: str(y?.error?.message),
    };
    return Object.values(triage).some((v) => v !== undefined) ? triage : undefined;
  } catch {
    return undefined;
  }
}

function networkError(rec: unknown): string | undefined {
  if (typeof rec !== "object" || rec === null) return undefined;
  const o = rec as Record<string, unknown>;
  const status = Number(field(o, "status", "statusCode", "status_code") ?? 0);
  const failed = Boolean(field(o, "failed", "errorText", "error"));
  if (!(status >= 400) && !failed) return undefined;
  const method = String(field(o, "method") ?? "GET");
  const url = String(field(o, "url", "request_url") ?? "unknown url");
  return `${method} ${url} -> ${status > 0 ? status : "failed"}`.slice(0, 500);
}

/**
 * Best-effort extraction of console and network errors from an `.evidence` zip. The exact file layout is only
 * documented loosely (per-step console and network logs), so this matches entries by name and tolerates JSON,
 * NDJSON or plain text. `entryNames` is returned so the first real run can be inspected and this tightened.
 */
export function readEvidence(packPath: string): Evidence {
  const zip = new AdmZip(packPath);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  const out: Evidence = { consoleErrors: [], networkErrors: [], entryNames: entries.map((e) => e.entryName), packPath };
  const seen = { c: new Set<string>(), n: new Set<string>() };

  for (const e of entries) {
    const name = e.entryName.toLowerCase();
    const isConsole = name.includes("console");
    const isNetwork = name.includes("network");
    if (!isConsole && !isNetwork) continue;
    const isHar = name.endsWith(".har");
    let text: string;
    try {
      text = e.getData().toString("utf8");
    } catch {
      continue;
    }
    if (isHar) {
      for (const m of harErrors(text)) {
        if (!seen.n.has(m) && out.networkErrors.length < MAX_ITEMS) {
          seen.n.add(m);
          out.networkErrors.push(m);
        }
      }
      continue;
    }
    for (const rec of records(text)) {
      if (isConsole) {
        const m = consoleError(rec);
        if (m && !seen.c.has(m) && out.consoleErrors.length < MAX_ITEMS) {
          seen.c.add(m);
          out.consoleErrors.push(m);
        }
      }
      if (isNetwork) {
        const m = networkError(rec);
        if (m && !seen.n.has(m) && out.networkErrors.length < MAX_ITEMS) {
          seen.n.add(m);
          out.networkErrors.push(m);
        }
      }
    }
  }
  out.triage = readTriage(zip);
  return out;
}
