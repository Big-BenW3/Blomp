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

export type WebhookOutcome = "pong" | "ignored" | "no_matching_fix" | "recheck_started" | "recheck_not_started" | "scan_started";

/**
 * Reacts to GitHub events. Two matter: a deployment of a fix branch became ready, so Kane re-checks the preview;
 * and a production deployment became ready, so Kane scans the live site for repos with auto-scan on.
 * Everything else (other events, failed deployments, branches Blomp did not open) is ignored.
 */
export async function handleGithubEvent(eventName: string | null, payload: unknown, deps: RecheckDeps = {}): Promise<WebhookOutcome> {
  if (eventName === "ping") return "pong";
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
