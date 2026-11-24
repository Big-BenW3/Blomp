import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { commentOnPullRequest, ensureDeploymentWebhook, findPreviewUrl, openFixPullRequest } from "@/lib/github/pr";

function fakeOctokit(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const track = <T,>(name: string, value: T) =>
    vi.fn(async (args?: unknown) => {
      calls.push(name);
      return { data: typeof value === "function" ? (value as (a: unknown) => unknown)(args) : value };
    });
  const git = {
    getRef: track("getRef", { object: { sha: "base-sha" } }),
    getCommit: track("getCommit", { tree: { sha: "base-tree" } }),
    createBlob: track("createBlob", (a: unknown) => ({ sha: `blob-${(a as { content: string }).content.length}` })),
    createTree: track("createTree", { sha: "new-tree" }),
    createCommit: track("createCommit", { sha: "new-commit" }),
    createRef: track("createRef", {}),
  };
  const pulls = { create: track("pulls.create", { number: 7, html_url: "https://github.com/a/shop/pull/7" }) };
  const octokit = { rest: { git, pulls, ...over } } as unknown as Octokit;
  return { octokit, git, pulls, calls };
}

const input = {
  owner: "a",
  name: "shop",
  defaultBranch: "main",
  branch: "blomp/fix-1234abcd",
  title: "Fix: Checkout",
  body: "body",
  commitMessage: "fix: Checkout",
  files: [{ path: "src/lib/validation.ts", content: "new content" }],
};

describe("openFixPullRequest", () => {
  it("builds blobs, a tree, a commit and a branch on the default branch, then opens the PR", async () => {
    const { octokit, git, pulls, calls } = fakeOctokit();
    const pr = await openFixPullRequest(octokit, input);
    expect(pr).toEqual({ branch: "blomp/fix-1234abcd", prNumber: 7, prUrl: "https://github.com/a/shop/pull/7", headSha: "new-commit" });
    expect(calls).toEqual(["getRef", "getCommit", "createBlob", "createTree", "createCommit", "createRef", "pulls.create"]);
    expect(git.createTree).toHaveBeenCalledWith(expect.objectContaining({ base_tree: "base-tree", tree: [expect.objectContaining({ path: "src/lib/validation.ts", mode: "100644" })] }));
    expect(git.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parents: ["base-sha"], tree: "new-tree" }));
    expect(pulls.create).toHaveBeenCalledWith(expect.objectContaining({ head: "blomp/fix-1234abcd", base: "main", title: "Fix: Checkout" }));
  });

  it("picks another branch name when the first is taken", async () => {
    const { octokit, git } = fakeOctokit();
    git.createRef.mockRejectedValueOnce(Object.assign(new Error("Reference already exists"), { status: 422 }));
    const pr = await openFixPullRequest(octokit, input);
    expect(pr.branch).toBe("blomp/fix-1234abcd-2");
  });

  it("does not hide other GitHub errors", async () => {
    const { octokit, git } = fakeOctokit();
    git.getRef.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));
    await expect(openFixPullRequest(octokit, input)).rejects.toMatchObject({ status: 404 });
  });
});

describe("ensureDeploymentWebhook", () => {
  const opts = { owner: "a", name: "shop", url: "https://blomp.app/api/webhooks/github", secret: "s" };

  it("creates the webhook when none points at Blomp", async () => {
    const repos = {
      listWebhooks: vi.fn(async () => ({ data: [{ id: 1, config: { url: "https://other" }, events: ["push"] }] })),
      createWebhook: vi.fn(async () => ({ data: { id: 42 } })),
      updateWebhook: vi.fn(),
    };
    const { octokit } = fakeOctokit({ repos });
    await expect(ensureDeploymentWebhook(octokit, opts)).resolves.toBe(42);
    expect(repos.createWebhook).toHaveBeenCalledWith(expect.objectContaining({ events: ["deployment_status"], config: expect.objectContaining({ url: opts.url, content_type: "json" }) }));
  });

  it("reuses an existing webhook and adds the deployment event if it was missing", async () => {
    const repos = {
      listWebhooks: vi.fn(async () => ({ data: [{ id: 9, config: { url: opts.url }, events: ["push"] }] })),
      createWebhook: vi.fn(),
      updateWebhook: vi.fn(async () => ({})),
    };
    const { octokit } = fakeOctokit({ repos });
    await expect(ensureDeploymentWebhook(octokit, opts)).resolves.toBe(9);
    expect(repos.createWebhook).not.toHaveBeenCalled();
    expect(repos.updateWebhook).toHaveBeenCalledWith(expect.objectContaining({ hook_id: 9, events: ["push", "deployment_status"] }));
  });
});

describe("findPreviewUrl", () => {
  it("returns the live address of the first successful non-production deployment", async () => {
    const repos = {
      listDeployments: vi.fn(async () => ({
        data: [
          { id: 1, environment: "Production" },
          { id: 2, environment: "Preview" },
        ],
      })),
      listDeploymentStatuses: vi.fn(async () => ({
        data: [{ state: "pending" }, { state: "success", environment_url: "https://shop-git-fix.vercel.app", target_url: "https://vercel.com/inspect" }],
      })),
    };
    const { octokit } = fakeOctokit({ repos });
    await expect(findPreviewUrl(octokit, { owner: "a", name: "shop", sha: "abc" })).resolves.toBe("https://shop-git-fix.vercel.app");
    expect(repos.listDeploymentStatuses).toHaveBeenCalledTimes(1); // production was skipped
  });

  it("is undefined while no preview is ready", async () => {
    const repos = { listDeployments: vi.fn(async () => ({ data: [] })), listDeploymentStatuses: vi.fn() };
    const { octokit } = fakeOctokit({ repos });
    await expect(findPreviewUrl(octokit, { owner: "a", name: "shop", sha: "abc" })).resolves.toBeUndefined();
  });
});

describe("commentOnPullRequest", () => {
  it("posts on the pull request's issue thread", async () => {
    const issues = { createComment: vi.fn(async () => ({})) };
    const { octokit } = fakeOctokit({ issues });
    await commentOnPullRequest(octokit, { owner: "a", name: "shop", number: 7, body: "hi" });
    expect(issues.createComment).toHaveBeenCalledWith({ owner: "a", repo: "shop", issue_number: 7, body: "hi" });
  });
});
