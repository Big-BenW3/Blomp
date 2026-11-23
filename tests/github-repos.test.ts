import type { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { findProductionUrl, getRepo, listRepoFiles, listUserRepos, readRepoFile, type GhRepo } from "@/lib/github/repos";

const gh = (over: Partial<GhRepo> = {}): GhRepo => ({
  fullName: "me/shop",
  owner: "me",
  name: "shop",
  defaultBranch: "main",
  description: null,
  private: false,
  fork: false,
  pushedAt: null,
  homepage: null,
  ...over,
});

const raw = (name: string, extra: Record<string, unknown> = {}) => ({
  full_name: `me/${name}`,
  owner: { login: "me" },
  name,
  default_branch: "main",
  private: false,
  fork: false,
  archived: false,
  disabled: false,
  ...extra,
});

const fake = (rest: Record<string, Record<string, unknown>>) => ({ rest }) as unknown as Octokit;

describe("listUserRepos", () => {
  it("maps repos and leaves out archived and disabled ones", async () => {
    const octokit = fake({
      repos: {
        listForAuthenticatedUser: vi.fn(async () => ({
          data: [raw("a"), raw("old", { archived: true }), raw("off", { disabled: true }), raw("b", { private: true, description: "hi" })],
        })),
      },
    });
    const repos = await listUserRepos(octokit);
    expect(repos.map((r) => r.fullName)).toEqual(["me/a", "me/b"]);
    expect(repos[1]).toMatchObject({ private: true, description: "hi", defaultBranch: "main" });
  });

  it("pages through results and stops at the cap", async () => {
    const page = (n: number) => Array.from({ length: 100 }, (_, i) => raw(`r${n}-${i}`));
    const listForAuthenticatedUser = vi.fn(async ({ page: p }: { page: number }) => ({ data: page(p) }));
    const repos = await listUserRepos(fake({ repos: { listForAuthenticatedUser } }));
    expect(repos).toHaveLength(200);
    expect(listForAuthenticatedUser).toHaveBeenCalledTimes(2);
  });
});

describe("getRepo", () => {
  it("returns the repo or throws what GitHub threw", async () => {
    const ok = fake({ repos: { get: vi.fn(async () => ({ data: raw("shop") })) } });
    expect((await getRepo(ok, "me", "shop")).fullName).toBe("me/shop");
    const nope = fake({ repos: { get: vi.fn(async () => Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }))) } });
    await expect(getRepo(nope, "me", "x")).rejects.toMatchObject({ status: 404 });
  });
});

describe("findProductionUrl", () => {
  const deployments = [
    { id: 1, environment: "Preview" },
    { id: 2, environment: "Production" },
    { id: 3, environment: "Production" },
  ];

  it("uses the newest successful Production status and ignores Preview deployments", async () => {
    const listDeploymentStatuses = vi.fn(async ({ deployment_id }: { deployment_id: number }) => ({
      data:
        deployment_id === 2
          ? [{ state: "failure", environment_url: "https://bad.vercel.app" }]
          : [
              { state: "pending" },
              { state: "success", environment_url: "https://shop-abc.vercel.app/", target_url: "https://vercel.com/inspect" },
            ],
    }));
    const octokit = fake({ repos: { listDeployments: vi.fn(async () => ({ data: deployments })), listDeploymentStatuses } });
    expect(await findProductionUrl(octokit, gh())).toBe("https://shop-abc.vercel.app");
    expect(listDeploymentStatuses).not.toHaveBeenCalledWith(expect.objectContaining({ deployment_id: 1 }));
  });

  it("falls back to target_url, then to the repo homepage", async () => {
    const withTarget = fake({
      repos: {
        listDeployments: vi.fn(async () => ({ data: [{ id: 2, environment: "Production" }] })),
        listDeploymentStatuses: vi.fn(async () => ({ data: [{ state: "success", target_url: "https://t.vercel.app" }] })),
      },
    });
    expect(await findProductionUrl(withTarget, gh())).toBe("https://t.vercel.app");

    const none = fake({ repos: { listDeployments: vi.fn(async () => ({ data: [] })), listDeploymentStatuses: vi.fn() } });
    expect(await findProductionUrl(none, gh({ homepage: "https://shop.example.com/" }))).toBe("https://shop.example.com");
    expect(await findProductionUrl(none, gh())).toBeUndefined();
  });

  it("does not throw when the deployments API is unavailable, and never returns an unusable URL", async () => {
    const broken = fake({ repos: { listDeployments: vi.fn(async () => Promise.reject(new Error("403"))) } });
    expect(await findProductionUrl(broken, gh({ homepage: "https://shop.example.com" }))).toBe("https://shop.example.com");
    expect(await findProductionUrl(broken, gh({ homepage: "http://localhost:3000" }))).toBeUndefined();
  });
});

describe("listRepoFiles / readRepoFile", () => {
  it("lists blobs only and reports truncation", async () => {
    const octokit = fake({
      git: {
        getTree: vi.fn(async () => ({
          data: {
            truncated: true,
            tree: [
              { type: "tree", path: "src" },
              { type: "blob", path: "src/app/page.tsx" },
              { type: "blob", path: "package.json" },
            ],
          },
        })),
      },
    });
    expect(await listRepoFiles(octokit, gh())).toEqual({ paths: ["src/app/page.tsx", "package.json"], truncated: true });
  });

  it("reads raw text, decodes base64 content, caps length, and returns undefined on failure", async () => {
    const raw = fake({ repos: { getContent: vi.fn(async () => ({ data: "abcdefghij" })) } });
    expect(await readRepoFile(raw, gh(), "a.ts", 4)).toBe("abcd");
    const b64 = fake({ repos: { getContent: vi.fn(async () => ({ data: { content: Buffer.from("hello").toString("base64") } })) } });
    expect(await readRepoFile(b64, gh(), "a.ts", 100)).toBe("hello");
    const dir = fake({ repos: { getContent: vi.fn(async () => ({ data: [{ name: "x" }] })) } });
    expect(await readRepoFile(dir, gh(), "src", 100)).toBeUndefined();
    const err = fake({ repos: { getContent: vi.fn(async () => Promise.reject(new Error("404"))) } });
    expect(await readRepoFile(err, gh(), "gone", 100)).toBeUndefined();
  });
});
