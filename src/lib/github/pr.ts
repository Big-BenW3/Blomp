import type { Octokit } from "@octokit/rest";
import { normalizeSiteUrl } from "@/lib/url";

export interface PullRequestInput {
  owner: string;
  name: string;
  defaultBranch: string;
  branch: string;
  title: string;
  body: string;
  commitMessage: string;
  files: { path: string; content: string }[];
}

export interface OpenedPullRequest {
  branch: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
}

const isStatus = (err: unknown, code: number) => typeof err === "object" && err !== null && (err as { status?: number }).status === code;

/**
 * Opens a pull request with the Git Data API, so no clone is needed: blobs, a tree on top of the default
 * branch, a commit, a branch, then the PR. The commit is authored by the user whose token Blomp holds.
 */
export async function openFixPullRequest(octokit: Octokit, input: PullRequestInput): Promise<OpenedPullRequest> {
  const { owner, name: repo } = input;
  const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${input.defaultBranch}` });
  const baseSha = ref.object.sha;
  const { data: baseCommit } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: baseSha });

  const tree = await Promise.all(
    input.files.map(async (f) => {
      const { data: blob } = await octokit.rest.git.createBlob({ owner, repo, content: f.content, encoding: "utf-8" });
      return { path: f.path, mode: "100644" as const, type: "blob" as const, sha: blob.sha };
    }),
  );
  const { data: newTree } = await octokit.rest.git.createTree({ owner, repo, base_tree: baseCommit.tree.sha, tree });
  const { data: commit } = await octokit.rest.git.createCommit({ owner, repo, message: input.commitMessage, tree: newTree.sha, parents: [baseSha] });

  // A retry after a half-finished attempt may find the branch name taken, so try a few suffixes.
  let branch = input.branch;
  for (let attempt = 0; ; attempt++) {
    try {
      await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: commit.sha });
      break;
    } catch (err) {
      if (!isStatus(err, 422) || attempt >= 3) throw err;
      branch = `${input.branch}-${attempt + 2}`;
    }
  }

  const { data: pr } = await octokit.rest.pulls.create({
    owner,
    repo,
    title: input.title,
    head: branch,
    base: input.defaultBranch,
    body: input.body,
  });
  return { branch, prNumber: pr.number, prUrl: pr.html_url, headSha: commit.sha };
}

/** Makes sure the repo reports deployments to Blomp. Returns the webhook id; reuses one that already points here. */
export async function ensureDeploymentWebhook(
  octokit: Octokit,
  opts: { owner: string; name: string; url: string; secret: string; events?: string[] },
): Promise<number> {
  const { owner, name: repo } = opts;
  const wanted = opts.events ?? ["deployment_status"];
  const { data: hooks } = await octokit.rest.repos.listWebhooks({ owner, repo, per_page: 100 });
  const existing = hooks.find((h) => h.config?.url === opts.url);
  if (existing) {
    if (wanted.some((e) => !existing.events.includes(e))) {
      await octokit.rest.repos.updateWebhook({
        owner,
        repo,
        hook_id: existing.id,
        events: [...new Set([...existing.events, ...wanted])],
        config: { url: opts.url, content_type: "json", secret: opts.secret },
      });
    }
    return existing.id;
  }
  const { data } = await octokit.rest.repos.createWebhook({
    owner,
    repo,
    events: wanted,
    active: true,
    config: { url: opts.url, content_type: "json", secret: opts.secret },
  });
  return data.id;
}

export async function commentOnPullRequest(octokit: Octokit, opts: { owner: string; name: string; number: number; body: string }): Promise<void> {
  await octokit.rest.issues.createComment({ owner: opts.owner, repo: opts.name, issue_number: opts.number, body: opts.body });
}

/** The live preview address for a commit, from the deployment statuses Vercel reports to GitHub. */
export async function findPreviewUrl(octokit: Octokit, opts: { owner: string; name: string; sha: string }): Promise<string | undefined> {
  const { data: deployments } = await octokit.rest.repos.listDeployments({ owner: opts.owner, repo: opts.name, sha: opts.sha, per_page: 10 });
  for (const d of deployments) {
    if (/^production/i.test(d.environment ?? "")) continue;
    const { data: statuses } = await octokit.rest.repos.listDeploymentStatuses({ owner: opts.owner, repo: opts.name, deployment_id: d.id, per_page: 10 });
    const ok = statuses.find((s) => s.state === "success");
    const url = normalizeSiteUrl(ok?.environment_url || ok?.target_url);
    if (url) return url;
  }
  return undefined;
}
