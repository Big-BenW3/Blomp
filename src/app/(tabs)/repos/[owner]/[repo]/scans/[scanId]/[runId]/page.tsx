import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ChevronBack } from "@/components/icons";
import { VerdictBadge } from "@/components/verdict-badge";
import { isAppIssue } from "@/lib/ingest/triage";
import { requireUserId } from "@/lib/repos/load";
import { getRunDetail } from "@/lib/scans/queries";

export const dynamic = "force-dynamic";

const SHOWN = 3;

export default async function EvidencePage({ params }: { params: Promise<{ owner: string; repo: string; scanId: string; runId: string }> }) {
  const { owner, repo, scanId, runId } = await params;
  const id = z.uuid().safeParse(runId);
  if (!id.success) notFound();
  const userId = await requireUserId();
  const run = await getRunDetail(userId, id.data);
  if (!run || run.scanId !== scanId || run.repoFullName !== `${owner}/${repo}`) notFound();

  const t = run.triage;
  const oneLiner = run.oneLiner ?? run.reason;
  const seen = [run.failingStep, ...run.networkErrors.slice(0, SHOWN), ...run.consoleErrors.slice(0, SHOWN)].filter(
    (x): x is string => Boolean(x),
  );
  const cause = t?.rootCause ?? t?.title;
  const showChip = run.verdict === "fail" && t?.category;

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

      {run.testUrl ? (
        <a href={run.testUrl} target="_blank" rel="noopener noreferrer" className="ui-text-btn self-start">
          View full Kane run
        </a>
      ) : null}
      {run.credits !== null ? <p className="ui-note">Used {run.credits.toFixed(1)} Kane credits.</p> : null}
    </main>
  );
}
