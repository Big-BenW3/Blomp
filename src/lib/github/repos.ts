import type { Octokit } from "@octokit/rest";
import { normalizeSiteUrl } from "@/lib/url";

export interface GhRepo {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  pushedAt: string | null;
  homepage: string | null;
}

const MAX_REPOS = 200;

function toRepo(r: {
  full_name: string;
  owner: { login: string };
  name: string;
  default_branch?: string;
  description?: string | null;
  private: boolean;
  fork: boolean;
  pushed_at?: string | null;
  homepage?: string | null;
}): GhRepo {
  return {
    fullName: r.full_name,
    owner: r.owner.login,
    name: r.name,
    defaultBranch: r.default_branch ?? "main",
    description: r.description ?? null,
    private: r.private,
    fork: r.fork,
    pushedAt: r.pushed_at ?? null,
    homepage: r.homepage ?? null,
  };
}

/** The repos the signed-in user can see, most recently pushed first. Archived repos are left out. */
export async function listUserRepos(octokit: Octokit): Promise<GhRepo[]> {
  const out: GhRepo[] = [];
  for (let page = 1; out.length < MAX_REPOS; page++) {
    const { data } = await octokit.rest.repos.listForAuthenticatedUser({
      per_page: 100,
      page,
      sort: "pushed",
      direction: "desc",
      affiliation: "owner,collaborator,organization_member",
    });
    for (const r of data) if (!r.archived && !r.disabled) out.push(toRepo(r));
    if (data.length < 100) break;
  }
  return out.slice(0, MAX_REPOS);
}

/** Fetches one repo as the user. Throws a 404-shaped error when the user cannot see it. */
export async function getRepo(octokit: Octokit, owner: string, name: string): Promise<GhRepo> {
  const { data } = await octokit.rest.repos.get({ owner, repo: name });
  return toRepo(data);
}

/**
 * Finds the live production URL. Vercel reports every deploy to GitHub as a deployment with a status that carries
 * the site URL, so the newest successful Production status is the best guess; the repo's homepage is the fallback.
 * Always a guess: the user can edit it.
 */
export async function findProductionUrl(octokit: Octokit, repo: GhRepo): Promise<string | undefined> {
  try {
    const { data: deployments } = await octokit.rest.repos.listDeployments({
      owner: repo.owner,
      repo: repo.name,
      per_page: 20,
    });
    const production = deployments.filter((d) => /^production/i.test(d.environment ?? "")).slice(0, 5);
    for (const d of production) {
      const { data: statuses } = await octokit.rest.repos.listDeploymentStatuses({
        owner: repo.owner,
        repo: repo.name,
        deployment_id: d.id,
        per_page: 10,
      });
      const ok = statuses.find((s) => s.state === "success");
      const url = normalizeSiteUrl(ok?.environment_url || ok?.target_url);
      if (url) return url;
    }
  } catch {
    // no deployments API access or none yet: fall through to the homepage
  }
  return normalizeSiteUrl(repo.homepage);
}

/** File paths on the default branch (blobs only). `truncated` is true when GitHub cut the tree off. */
export async function listRepoFiles(
  octokit: Octokit,
  repo: GhRepo,
): Promise<{ paths: string[]; truncated: boolean }> {
  const { data } = await octokit.rest.git.getTree({
    owner: repo.owner,
    repo: repo.name,
    tree_sha: repo.defaultBranch,
    recursive: "true",
  });
  return {
    paths: data.tree.filter((e) => e.type === "blob" && e.path).map((e) => e.path as string),
    truncated: Boolean(data.truncated),
  };
}

/** Reads a text file from the default branch, capped at `maxChars`. Returns undefined if it cannot be read. */
export async function readRepoFile(
  octokit: Octokit,
  repo: GhRepo,
  path: string,
  maxChars: number,
): Promise<string | undefined> {
  try {
    const res = await octokit.rest.repos.getContent({
      owner: repo.owner,
      repo: repo.name,
      path,
      ref: repo.defaultBranch,
      mediaType: { format: "raw" },
    });
    const body = res.data as unknown;
    const text =
      typeof body === "string"
        ? body
        : Array.isArray(body)
          ? undefined
          : typeof (body as { content?: string }).content === "string"
            ? Buffer.from((body as { content: string }).content, "base64").toString("utf8")
            : undefined;
    return text?.slice(0, maxChars);
  } catch {
    return undefined;
  }
}
