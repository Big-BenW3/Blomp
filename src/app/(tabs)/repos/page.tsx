import { ReconnectCard } from "@/components/reconnect-card";
import { RepoList, type RepoItem } from "@/components/repo-list";
import { EmptyState } from "@/components/empty-state";
import { getUserOctokit, isAuthError } from "@/lib/github/octokit";
import { listUserRepos, type GhRepo } from "@/lib/github/repos";
import { requireUserId } from "@/lib/repos/load";
import { listRepoRows } from "@/lib/repos/store";

function host(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

export default async function ReposPage() {
  const userId = await requireUserId();
  let gh: GhRepo[];
  try {
    gh = await listUserRepos(await getUserOctokit(userId));
  } catch (err) {
    if (isAuthError(err)) return <ReconnectCard />;
    throw err;
  }
  const known = new Map((await listRepoRows(userId)).map((r) => [r.fullName, r]));
  const items: RepoItem[] = gh.map((r) => {
    const row = known.get(r.fullName);
    return { owner: r.owner, name: r.name, site: host(row?.prodUrl ?? null), score: row?.lastScore ?? null };
  });

  return (
    <main className="flex flex-col gap-3.5">
      <h1 className="ui-title">Repos</h1>
      {items.length === 0 ? (
        <EmptyState title="No repos found" body="Blomp could not see any repos on your GitHub account." />
      ) : (
        <RepoList items={items} />
      )}
    </main>
  );
}
