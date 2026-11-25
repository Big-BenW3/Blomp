import type { Octokit } from "@octokit/rest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { repos } from "@/db/schema";
import { ensureDeploymentWebhook } from "@/lib/github/pr";
import { ingestBase } from "@/lib/scans/dispatch";
import type { RepoRow } from "@/lib/repos/store";

/** Something the user can act on, in words they can read. */
export class AutoScanError extends Error {}

export interface AutoScanOptions {
  userId: string;
  row: RepoRow;
  enabled: boolean;
  octokit: Octokit;
  /** Tests pass these; in the app they come from the environment. */
  url?: string;
  secret?: string;
}

/**
 * Turns scan-on-push on or off for one repo. Turning it on makes sure GitHub reports this repo's deployments to
 * Blomp (the same webhook fixes use). Turning it off only stops scanning: the webhook stays because fix re-checks need it.
 */
export async function setAutoScan(opts: AutoScanOptions): Promise<void> {
  const { userId, row, enabled, octokit } = opts;
  const db = getDb();

  if (!enabled) {
    await db.update(repos).set({ autoScan: false }).where(and(eq(repos.id, row.id), eq(repos.userId, userId)));
    return;
  }

  if (!row.prodUrl) throw new AutoScanError("Add your live site address first, so Blomp knows what to scan.");
  const secret = opts.secret ?? process.env.WEBHOOK_SECRET;
  const base = ingestBase();
  const url = opts.url ?? (base ? `${base}/api/webhooks/github` : undefined);
  if (!secret || !url) throw new AutoScanError("Auto-scan is not set up yet. Add WEBHOOK_SECRET and AUTH_URL in Vercel, then redeploy.");

  const [owner, name] = row.fullName.split("/");
  let webhookId: number;
  try {
    webhookId = await ensureDeploymentWebhook(octokit, { owner, name, url, secret });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401) throw new AutoScanError("GitHub no longer accepts your sign-in. Sign out, sign back in and try again.");
    if (status === 403 || status === 404) {
      throw new AutoScanError("GitHub would not let Blomp add a webhook to this repo. Check that you own it, then try again.");
    }
    throw err;
  }
  await db.update(repos).set({ autoScan: true, webhookId }).where(and(eq(repos.id, row.id), eq(repos.userId, userId)));
}
