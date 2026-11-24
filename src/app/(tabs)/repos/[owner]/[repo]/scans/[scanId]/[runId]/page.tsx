import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ChevronBack, ChevronRight } from "@/components/icons";
import { FixPanel } from "@/components/fix-panel";
import { VerdictBadge } from "@/components/verdict-badge";
import { getFixForRun } from "@/lib/fixes/store";
import { isAppIssue } from "@/lib/ingest/triage";
import { requireUserId } from "@/lib/repos/load";
import { getRunDetail, getRunSteps } from "@/lib/scans/queries";
import { collapseSteps, stepText } from "@/lib/scans/steps";
import { recheckNowAction, startFixAction } from "./actions";

export const dynamic = "force-dynamic";
/** Writing a fix with the model can take minutes, and the work continues after the tap returns. */
export const maxDuration = 300;

const SHOWN = 3;

export default async function EvidencePage({ params }: { params: Promise<{ owner: string; repo: string; scanId: string; runId: string }> }) {
  const { owner, repo, scanId, runId } = await params;
  const id = z.uuid().safeParse(runId);
  if (!id.success) notFound();
  const userId = await requireUserId();
  const run = await getRunDetail(userId, id.data);
  if (!run || run.scanId !== scanId || run.repoFullName !== `${owner}/${repo}`) notFound();

  const steps = collapseSteps(await getRunSteps(run.id));
  const fix = run.verdict === "fail" ? ((await getFixForRun(userId, run.id)) ?? null) : null;
  const t = run.triage;
  const oneLiner = run.oneLiner ?? run.reason;
  const seen = [run.failingStep, ...run.networkErrors.slice(0, SHOWN), ...run.consoleErrors.slice(0, SHOWN)].filter(
    (x): x is string => Boolean(x),
  );
  const cause = t?.rootCause ?? t?.title;
  const showChip = run.verdict === "fail" && t?.category;
  const canFix = run.verdict === "fail" && (!t?.category || isAppIssue(t));
  const noFixReason = run.verdict === "fail" && !canFix ? "Kane thinks this flow needs a rewrite rather than a code fix. Edit the flow and scan again." : undefined;

  return (
    <main className="flex flex-col gap-3.5">
      <nav className="-ml-2">
        <Link href={`/repos/${owner}/${repo}/scans/${scanId}`} className="inline-flex min-h-11 items-center gap-0.5 text-base text-accent">
          <ChevronBack size={22} />
          Scan result
        </Link>
      </nav>
      <header>
        <h1 className="ui-h">{run.flowName}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <VerdictBadge verdict={run.verdict} />
          {showChip ? <span className="ui-chip">{isAppIssue(t) ? "App bug" : "Flow needs a rewrite"}</span> : null}
        </div>
      </header>

      {oneLiner ? <p className="text-lg font-semibold leading-snug tracking-tight">{oneLiner}</p> : null}

      {run.evidenceUrl ? (
        <div className="ui-list p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={run.evidenceUrl} alt={`What Kane saw when ${run.flowName} failed`} className="w-full rounded-xl" />
        </div>
      ) : null}

      {steps.length > 0 ? (
        <div className="ui-term" aria-label="What Kane did">
          <p className="ui-term-h">WHAT KANE DID</p>
          <div className="ui-term-b">
            {steps.map((x) => {
              const g = x.status === "done" ? ["✓", "ok"] : x.status === "failed" ? ["✗", "bad"] : ["›", ""];
              return (
                <div key={x.id} className={`ui-tl ${g[1]}`}>
                  <span className="g">{g[0]}</span>
                  <span>{stepText(x.remark, x.idx)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {seen.length > 0 || cause ? (
        <ul className="ui-list split">
          {seen.length > 0 ? (
            <li className="ui-row">
              <div className="ui-body" style={{ whiteSpace: "normal" }}>
                <p className="text-xs uppercase tracking-wide text-muted">Kane saw</p>
                {seen.map((line, i) => (
                  <p key={i} className="ui-code">
                    {line}
                  </p>
                ))}
              </div>
            </li>
          ) : null}
          {cause ? (
            <li className="ui-row">
              <div className="ui-body" style={{ whiteSpace: "normal" }}>
                <p className="text-xs uppercase tracking-wide text-muted">Likely cause</p>
                <p className="mt-0.5 text-sm leading-snug">{cause}</p>
              </div>
            </li>
          ) : null}
        </ul>
      ) : null}

      {run.verdict === "fail" ? (
        <FixPanel
          initial={fix}
          repoPath={`/repos/${owner}/${repo}`}
          canFix={canFix}
          reason={noFixReason}
          start={startFixAction.bind(null, run.id)}
          recheck={recheckNowAction}
        />
      ) : null}

      {run.testUrl ? (
        <ul className="ui-list">
          <li>
            <a href={run.testUrl} target="_blank" rel="noopener noreferrer" className="ui-row">
              <div className="ui-body">
                <p className="ui-rt">Watch the recording</p>
                <p className="ui-rs">See exactly what Kane saw</p>
              </div>
              <ChevronRight size={16} className="shrink-0 text-muted" />
            </a>
          </li>
        </ul>
      ) : null}
    </main>
  );
}
