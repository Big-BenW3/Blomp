"use server";

import { after } from "next/server";
import { z } from "zod";
import { loadFixContext, createFix, getFixView, toView, type FixView } from "@/lib/fixes/store";
import { runFix } from "@/lib/fixes/run";
import { startRecheckForFix } from "@/lib/fixes/recheck";
import { getUserOctokit } from "@/lib/github/octokit";
import { findPreviewUrl } from "@/lib/github/pr";
import { isAppIssue } from "@/lib/ingest/triage";
import { requireUserId } from "@/lib/repos/load";
import { getRunDetail } from "@/lib/scans/queries";

export type FixActionResult = { ok: true; fix: FixView } | { ok: false; message: string };

/** Starts writing a fix for a failed run. The work continues after this returns; the screen polls for progress. */
export async function startFixAction(runId: string): Promise<FixActionResult> {
  const id = z.uuid().safeParse(runId);
  if (!id.success) return { ok: false, message: "Run not found. Reload and try again." };
  const userId = await requireUserId();
  const run = await getRunDetail(userId, id.data);
  if (!run) return { ok: false, message: "Run not found. Reload and try again." };
  if (run.verdict !== "fail") return { ok: false, message: "Only a failed flow can be fixed." };
  if (run.triage?.category && !isAppIssue(run.triage)) {
    return { ok: false, message: "Kane thinks this flow needs a rewrite, not a code fix." };
  }

  const { fix, created } = await createFix(run.id);
  if (created) after(() => runFix(fix.id));
  return { ok: true, fix: toView(fix) };
}

/** Re-checks the fix's preview now, for when Blomp missed the "preview is ready" event. */
export async function recheckNowAction(fixId: string): Promise<FixActionResult> {
  const id = z.uuid().safeParse(fixId);
  if (!id.success) return { ok: false, message: "Fix not found. Reload and try again." };
  const userId = await requireUserId();
  const view = await getFixView(userId, id.data);
  if (!view) return { ok: false, message: "Fix not found. Reload and try again." };

  const ctx = await loadFixContext(view.id);
  if (!ctx?.fix.headSha || !view.prNumber) return { ok: false, message: "This fix has no pull request yet." };

  let previewUrl: string | undefined;
  try {
    const [owner, name] = ctx.repo.fullName.split("/");
    previewUrl = await findPreviewUrl(await getUserOctokit(userId), { owner, name, sha: ctx.fix.headSha });
  } catch (err) {
    console.error("could not look up the preview", err);
    return { ok: false, message: "Could not reach GitHub. Try again in a moment." };
  }
  if (!previewUrl) return { ok: false, message: "The preview is not ready yet. Try again in a minute." };

  const result = await startRecheckForFix(view.id, { previewUrl, sha: ctx.fix.headSha });
  if (!result.ok) return { ok: false, message: result.message };
  const fresh = await getFixView(userId, view.id);
  return fresh ? { ok: true, fix: fresh } : { ok: false, message: "Reload to see the re-check." };
}
