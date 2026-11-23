import { Octokit } from "@octokit/rest";
import { ScanStartError, type Dispatcher } from "./start";

type Env = Record<string, string | undefined>;

/** Where the runner posts results: the app's own public address. */
export function ingestBase(env: Env = process.env): string | undefined {
  const raw = env.INGEST_BASE_URL || env.AUTH_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
  const base = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(base) ? base : undefined;
}

/** Starts `kane-scan.yml` in the Blomp repo with the scan's flows. Needs a token with Actions read and write on that repo. */
export function createWorkflowDispatcher(env: Env = process.env): Dispatcher {
  return async ({ scanId, targetUrl, flows }) => {
    const token = env.GITHUB_DISPATCH_TOKEN;
    const slug = env.GITHUB_REPOSITORY;
    if (!token || !slug || !slug.includes("/")) {
      throw new ScanStartError("Scans are not set up yet. Add GITHUB_DISPATCH_TOKEN and GITHUB_REPOSITORY in Vercel, then redeploy.");
    }
    const base = ingestBase(env);
    if (!base) throw new ScanStartError("Scans are not set up yet. Add AUTH_URL (your app's address) in Vercel, then redeploy.");

    const [owner, repo] = slug.split("/");
    try {
      await new Octokit({ auth: token, userAgent: "blomp" }).rest.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: "kane-scan.yml",
        ref: env.GITHUB_WORKFLOW_REF || "main",
        inputs: {
          scan_id: scanId,
          target_url: targetUrl,
          flows: JSON.stringify(flows),
          ingest_url: `${base}/api/ingest`,
        },
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403 || status === 404) {
        throw new ScanStartError(`GitHub refused the scan request. Check that GITHUB_DISPATCH_TOKEN can run Actions on ${slug}.`);
      }
      if (status === 422) {
        throw new ScanStartError("GitHub could not start kane-scan.yml. Check that the workflow is on the main branch.");
      }
      throw err;
    }
  };
}
