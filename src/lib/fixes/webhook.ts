import { z } from "zod";
import { startPushScans } from "@/lib/autoscan/push";
import { normalizeSiteUrl } from "@/lib/url";
import { startRecheckForFix, type RecheckDeps } from "./recheck";
import { findOpenFix } from "./store";

const deploymentStatusEvent = z.object({
  deployment_status: z.object({
    state: z.string(),
    environment_url: z.string().nullish(),
    target_url: z.string().nullish(),
  }),
  deployment: z.object({ sha: z.string(), ref: z.string(), environment: z.string().nullish() }),
  repository: z.object({ full_name: z.string() }),
});

/**
 * GitHub's `status` event. Vercel reports many projects' deploys this way: context "Vercel", state success,
 * "Deployment has completed", with no site address. `branches` lists the branches that contain the commit.
 */
const commitStatusEvent = z.object({
  state: z.string(),
  context: z.string(),
  sha: z.string(),
  branches: z.array(z.object({ name: z.string() })).default([]),
  repository: z.object({ full_name: z.string(), default_branch: z.string().nullish() }),
});

export type WebhookOutcome = "pong" | "ignored" | "no_matching_fix" | "recheck_started" | "recheck_not_started" | "scan_started";

/**
 * Reacts to GitHub events. Two matter (a Vercel deploy arrives as `deployment_status` or as a commit `status`): a deployment of a fix branch became ready, so Kane re-checks the preview;
 * and a production deployment became ready, so Kane scans the live site for repos with auto-scan on.
 * Everything else (other events, failed deployments, branches Blomp did not open) is ignored.
 */
export async function handleGithubEvent(eventName: string | null, payload: unknown, deps: RecheckDeps = {}): Promise<WebhookOutcome> {
  if (eventName === "ping") return "pong";
  if (eventName === "status") return handleCommitStatus(payload, deps);
  if (eventName !== "deployment_status") return "ignored";

  const parsed = deploymentStatusEvent.safeParse(payload);
  if (!parsed.success) return "ignored";
  const { deployment_status: status, deployment, repository } = parsed.data;
  if (status.state !== "success") return "ignored";
  if (/^production/i.test(deployment.environment ?? "")) {
    const { started } = await startPushScans(repository.full_name, deployment.sha, { dispatch: deps.dispatch });
    return started > 0 ? "scan_started" : "ignored";
  }

  const previewUrl = normalizeSiteUrl(status.environment_url || status.target_url);
  if (!previewUrl) return "ignored";

  const fix = await findOpenFix(repository.full_name, deployment.ref, deployment.sha);
  if (!fix) return "no_matching_fix";

  const result = await startRecheckForFix(fix.id, { previewUrl, sha: deployment.sha }, deps);
  return result.ok ? "recheck_started" : "recheck_not_started";
}

/** A Vercel deploy finished for a commit that is on the repo's default branch: that is a production deploy. */
async function handleCommitStatus(payload: unknown, deps: RecheckDeps): Promise<WebhookOutcome> {
  const parsed = commitStatusEvent.safeParse(payload);
  if (!parsed.success) return "ignored";
  const { state, context, sha, branches, repository } = parsed.data;
  if (state !== "success" || context.trim().toLowerCase() !== "vercel") return "ignored";
  const defaultBranch = repository.default_branch;
  if (!defaultBranch || !branches.some((b) => b.name === defaultBranch)) return "ignored";
  const { started } = await startPushScans(repository.full_name, sha, { dispatch: deps.dispatch });
  return started > 0 ? "scan_started" : "ignored";
}
