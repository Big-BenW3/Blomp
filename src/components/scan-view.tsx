"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronBack, ChevronRight } from "@/components/icons";
import { Gauge } from "@/components/gauge";
import { VerdictBadge } from "@/components/verdict-badge";
import type { RunView, ScanSnapshot, StepView } from "@/lib/scans/queries";
import { timeAgo } from "@/lib/time";

const isOpen = (s: ScanSnapshot) => s.status === "queued" || s.status === "running";

/** Keeps the scan up to date from the live stream. The server sends a full refresh each time it (re)connects. */
function useScanStream(initial: { state: ScanSnapshot; steps: StepView[] }) {
  const [state, setState] = useState(initial.state);
  const [steps, setSteps] = useState(initial.steps);
  const id = initial.state.id;
  const open = isOpen(initial.state);

  useEffect(() => {
    if (!open) return;
    const es = new EventSource(`/api/scans/${id}/stream`);
    es.addEventListener("init", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { state: ScanSnapshot; steps: StepView[] };
      setState(d.state);
      setSteps(d.steps);
    });
    es.addEventListener("state", (e) => setState(JSON.parse((e as MessageEvent).data) as ScanSnapshot));
    es.addEventListener("steps", (e) => {
      const more = JSON.parse((e as MessageEvent).data) as StepView[];
      setSteps((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return [...prev, ...more.filter((s) => !seen.has(s.id))].slice(-200);
      });
    });
    es.addEventListener("end", () => es.close());
    return () => es.close();
  }, [id, open]);

  return { state, steps };
}

function glyph(status: string): { g: string; cls: string } {
  if (status === "done") return { g: "✓", cls: "ok" };
  if (status === "failed") return { g: "✗", cls: "bad" };
  return { g: "›", cls: "" };
}

function FlowState({ run, current }: { run: RunView; current: boolean }) {
  if (run.verdict === "pass") return <span className="text-pass text-[13px] font-semibold">Passed</span>;
  if (run.verdict === "fail") return <span className="text-fail text-[13px] font-semibold">Failed</span>;
  if (run.verdict === "unknown") return <span className="text-muted text-[13px]">Unknown</span>;
  return current ? <span className="text-accent text-[13px] font-semibold">Running</span> : <span className="text-muted text-[13px]">Waiting</span>;
}

export function ScanView({
  initial,
  owner,
  name,
}: {
  initial: { state: ScanSnapshot; steps: StepView[] };
  owner: string;
  name: string;
}) {
  const { state, steps } = useScanStream(initial);
  const [now, setNow] = useState(() => Date.now());
  const open = isOpen(state);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [open]);

  const base = `/repos/${owner}/${name}`;
  const pending = state.runs.filter((r) => r.verdict === "pending");
  const current = state.status === "running" ? (pending.find((r) => steps.some((s) => s.runId === r.id)) ?? pending[0]) : undefined;
  const lines = current ? steps.filter((s) => s.runId === current.id).slice(-4) : [];
  const slowStart = state.status === "queued" && now - new Date(state.createdAt).getTime() > 60_000;
  const host = state.targetUrl.replace(/^https?:\/\//, "");

  const title = open ? "Scanning" : state.status === "done" ? "Scan result" : "Scan stopped";
  const sub = open ? (
    host
  ) : (
    <span suppressHydrationWarning>
      {state.commitSha ? `${state.commitSha.slice(0, 7)} · ` : ""}
      {timeAgo(state.createdAt)}
    </span>
  );

  return (
    <main className="flex flex-col gap-3.5">
      <nav className="-ml-2">
        <Link href={base} className="inline-flex min-h-11 items-center gap-0.5 text-base text-accent">
          <ChevronBack size={22} />
          {name}
        </Link>
      </nav>
      <header>
        <h1 className="ui-h">{title}</h1>
        <p className="ui-sub">{sub}</p>
      </header>

      {state.status === "done" ? (
        <>
          <Gauge score={state.score} />
          <p className="-mt-1.5 text-center text-sm text-muted">
            <b className="font-semibold text-pass">{state.passed} passed</b> · <b className="font-semibold text-fail">{state.failed} failed</b> ·{" "}
            <b className="font-semibold">{state.unknown} unknown</b>
          </p>
          {state.score === null ? <p className="ui-note text-center">Kane could not finish any flow, so there is no score.</p> : null}
        </>
      ) : null}

      {state.status === "error" ? (
        <p className="ui-note" role="alert">
          {state.stalled
            ? "Kane stopped reporting, so this scan was closed. Run it again."
            : "The runner hit a problem before it finished. Run it again."}
        </p>
      ) : null}

      <ul className="ui-list split">
        {state.runs.map((r) => (
          <li key={r.id}>
            {open ? (
              <div className="ui-row">
                <p className="ui-rt ui-body">{r.name}</p>
                <FlowState run={r} current={current?.id === r.id} />
              </div>
            ) : (
              <Link href={`${base}/scans/${state.id}/${r.id}`} className="ui-row">
                <div className="ui-body">
                  <p className="ui-rt">{r.name}</p>
                  <p className="ui-rs">{r.oneLiner ?? (r.verdict === "unknown" ? "Kane did not finish" : r.path)}</p>
                </div>
                <VerdictBadge verdict={r.verdict} />
                <ChevronRight size={16} className="shrink-0 text-muted" />
              </Link>
            )}
          </li>
        ))}
      </ul>

      {open ? (
        <div className="ui-term" role="log" aria-label="Kane output">
          <p className="ui-term-h">KANE</p>
          <div className="ui-term-b">
            {state.status === "queued" ? (
              <>
                <div className="ui-tl now">
                  <span className="g">›</span>
                  <span>Starting a browser…</span>
                </div>
                {slowStart ? (
                  <div className="ui-tl">
                    <span className="g"> </span>
                    <span>GitHub is taking a while to start the runner.</span>
                  </div>
                ) : null}
              </>
            ) : lines.length === 0 ? (
              <div className="ui-tl now">
                <span className="g">›</span>
                <span>Opening {host}</span>
              </div>
            ) : (
              lines.map((s, i) => {
                const { g, cls } = glyph(s.status);
                const last = i === lines.length - 1 && s.status !== "done" && s.status !== "failed";
                return (
                  <div key={s.id} className={`ui-tl ${cls} ${last ? "now" : ""}`}>
                    <span className="g">{g}</span>
                    <span>{s.remark || `Step ${s.idx}`}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </main>
  );
}
