"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { ChevronRight } from "@/components/icons";
import type { FixView } from "@/lib/fixes/store";

type Result = { ok: true; fix: FixView } | { ok: false; message: string };

const LABEL: Record<FixView["status"], { title: string; hint?: string }> = {
  drafting: { title: "Writing a fix", hint: "Blomp is reading your code and preparing a pull request." },
  pr_open: { title: "Pull request opened", hint: "Waiting for the preview to deploy, then Kane re-checks it." },
  verifying: { title: "Kane is re-checking", hint: "Running the flow again on the pull request's preview." },
  verified: { title: "Kane verified" },
  failed: { title: "Could not finish" },
};

const POLL_MS = 3000;
const MAX_POLLS = 200;
const settled = (s: FixView["status"]) => s === "verified" || s === "failed";

export function FixPanel({
  initial,
  repoPath,
  canFix,
  reason,
  start,
  recheck,
}: {
  initial: FixView | null;
  repoPath: string;
  canFix: boolean;
  reason?: string;
  start: () => Promise<Result>;
  recheck: (fixId: string) => Promise<Result>;
}) {
  const [fix, setFix] = useState(initial);
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const polls = useRef(0);
  const id = fix?.id;
  const status = fix?.status;

  useEffect(() => {
    if (!id || !status || settled(status)) return;
    const timer = setInterval(async () => {
      if (++polls.current > MAX_POLLS) return clearInterval(timer);
      try {
        const res = await fetch(`/api/fixes/${id}`, { cache: "no-store" });
        if (res.ok) setFix((await res.json()) as FixView);
      } catch {
        // offline for a moment: the next tick tries again
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [id, status]);

  const run = (action: () => Promise<Result>) =>
    startTransition(async () => {
      setMessage("");
      polls.current = 0;
      const res = await action();
      if (res.ok) setFix(res.fix);
      else setMessage(res.message);
    });

  if (!fix) {
    if (!canFix) return reason ? <p className="ui-note">{reason}</p> : null;
    return (
      <div className="flex flex-col gap-2">
        <button type="button" className="ui-btn" disabled={pending} onClick={() => run(start)}>
          {pending ? "Starting…" : "Fix this with Blomp"}
        </button>
        <p className="ui-note">Blomp writes a fix, opens a pull request, and Kane re-checks it before it says verified.</p>
        {message ? (
          <p className="ui-note error" role="alert">
            {message}
          </p>
        ) : null}
      </div>
    );
  }

  const label = LABEL[fix.status];
  const canRecheck = Boolean(fix.prNumber) && (fix.status === "pr_open" || fix.status === "failed");
  return (
    <div className="flex flex-col gap-2">
      <ul className="ui-list split">
        <li className="ui-row">
          <div className="ui-body">
            <p className="ui-rt">{label.title}</p>
            {label.hint ? (
              <p className="ui-rs" style={{ whiteSpace: "normal" }}>
                {label.hint}
              </p>
            ) : null}
          </div>
          {fix.status === "verified" ? <span className="ui-badge pass">PASS</span> : null}
        </li>
        {fix.summary ? (
          <li className="ui-row">
            <p className="ui-body text-sm leading-snug" style={{ whiteSpace: "normal" }}>
              {fix.summary}
            </p>
          </li>
        ) : null}
        {fix.prUrl ? (
          <li>
            <a href={fix.prUrl} target="_blank" rel="noopener noreferrer" className="ui-row">
              <p className="ui-rt ui-body">Pull request #{fix.prNumber}</p>
              <ChevronRight size={16} className="shrink-0 text-muted" />
            </a>
          </li>
        ) : null}
        {fix.recheckScanId ? (
          <li>
            <Link href={`${repoPath}/scans/${fix.recheckScanId}`} className="ui-row">
              <p className="ui-rt ui-body">Kane&apos;s re-check</p>
              <ChevronRight size={16} className="shrink-0 text-muted" />
            </Link>
          </li>
        ) : null}
      </ul>
      {fix.error ? (
        <p className="ui-note error" role="alert">
          {fix.error}
        </p>
      ) : null}
      {message ? (
        <p className="ui-note error" role="alert">
          {message}
        </p>
      ) : null}
      {canRecheck ? (
        <button type="button" className="ui-text-btn self-start" disabled={pending} onClick={() => run(() => recheck(fix.id))}>
          {pending ? "Starting…" : "Re-check now"}
        </button>
      ) : null}
      {fix.status === "failed" && !fix.prNumber ? (
        <button type="button" className="ui-text-btn self-start" disabled={pending} onClick={() => run(start)}>
          {pending ? "Starting…" : "Try again"}
        </button>
      ) : null}
    </div>
  );
}
