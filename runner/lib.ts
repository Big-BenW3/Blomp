import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { RunCollector } from "../src/lib/kane/ndjson";
import type { IngestEventInput } from "../src/lib/ingest/schema";
import { findEvidencePack, readEvidence, type Evidence } from "./evidence";

export interface FlowInput {
  id: string;
  name: string;
  objective: string;
  path: string;
}

export interface RunScanOptions {
  scanId: string;
  targetUrl: string;
  flows: FlowInput[];
  post: (event: IngestEventInput) => Promise<void>;
  kaneBin?: string;
  maxSteps?: number;
  timeoutSec?: number;
  workflowRunId?: number;
  log?: (msg: string) => void;
}

/** Hard ceiling on one Kane process: its own --timeout plus a grace period for start-up and teardown. */
const GRACE_MS = 60_000;

export function flowUrl(targetUrl: string, path: string): string {
  return new URL(path || "/", targetUrl).toString();
}

export async function runFlow(
  flow: FlowInput,
  opts: Required<Pick<RunScanOptions, "scanId" | "targetUrl" | "post" | "kaneBin" | "maxSteps" | "timeoutSec">> &
    Pick<RunScanOptions, "log">,
): Promise<void> {
  const { scanId, post, log } = opts;
  await post({ kind: "run_start", scanId, flowId: flow.id });

  const args = [
    "run",
    flow.objective,
    "--url",
    flowUrl(opts.targetUrl, flow.path),
    "--agent",
    "--headless",
    "--max-steps",
    String(opts.maxSteps),
    "--timeout",
    String(opts.timeoutSec),
    "--name",
    `blomp-${scanId.slice(0, 8)}-${flow.id.slice(0, 8)}`,
  ];
  // No shell: the objective is one argv entry, so nothing in it can be interpreted as a command.
  const child = spawn(opts.kaneBin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stderrTail: string[] = [];
  child.stderr.on("data", (d: Buffer) => {
    stderrTail.push(...d.toString("utf8").split(/\r?\n/).filter(Boolean));
    if (stderrTail.length > 20) stderrTail.splice(0, stderrTail.length - 20);
  });

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    child.kill("SIGKILL");
  }, opts.timeoutSec * 1000 + GRACE_MS);

  const exited = new Promise<number>((resolve) => {
    child.on("error", () => resolve(2)); // could not start kane at all
    child.on("close", (code) => resolve(killed ? 3 : (code ?? 3)));
  });

  const collector = new RunCollector();
  const rl = createInterface({ input: child.stdout });
  for await (const line of rl) {
    const parsed = collector.push(line);
    if (parsed.kind === "step") {
      await post({
        kind: "step",
        scanId,
        flowId: flow.id,
        idx: parsed.idx,
        status: parsed.status,
        remark: parsed.remark,
      });
    }
  }
  const exitCode = await exited;
  clearTimeout(timer);

  let evidence: Evidence | undefined;
  if (collector.end?.sessionDir) {
    try {
      const pack = findEvidencePack(collector.end.sessionDir);
      if (pack) evidence = readEvidence(pack);
    } catch (err) {
      log?.(`could not read evidence: ${(err as Error).message}`);
    }
  }
  if (evidence) log?.(`evidence entries: ${evidence.entryNames.join(", ")}`);
  if (exitCode === 2 && stderrTail.length) log?.(`kane stderr: ${stderrTail.join(" | ")}`);

  await post({
    kind: "run_end",
    scanId,
    flowId: flow.id,
    exitCode,
    end: collector.end,
    failingStep: collector.failingStep,
    consoleErrors: evidence?.consoleErrors ?? [],
    networkErrors: evidence?.networkErrors ?? [],
  });
  log?.(`${flow.name}: exit ${exitCode} (${collector.end?.status ?? "no run_end"})`);
}

/** Runs each flow one after another (parallel runs would burn credits faster than the demo can afford). */
export async function runScan(opts: RunScanOptions): Promise<void> {
  const { scanId, post, log } = opts;
  await post({ kind: "scan_start", scanId, workflowRunId: opts.workflowRunId });
  try {
    for (const flow of opts.flows) {
      await runFlow(flow, {
        scanId,
        targetUrl: opts.targetUrl,
        post,
        log,
        kaneBin: opts.kaneBin ?? "kane-cli",
        maxSteps: opts.maxSteps ?? 25,
        timeoutSec: opts.timeoutSec ?? 180,
      });
    }
    await post({ kind: "scan_end", scanId });
  } catch (err) {
    await post({ kind: "scan_error", scanId, message: (err as Error).message.slice(0, 1000) });
    throw err;
  }
}
