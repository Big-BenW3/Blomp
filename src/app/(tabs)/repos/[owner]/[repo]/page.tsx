import Link from "next/link";
import { ChevronBack } from "@/components/icons";
import { DiscoverButton } from "@/components/discover-button";
import { FlowEditor } from "@/components/flow-editor";
import { ReconnectCard } from "@/components/reconnect-card";
import { SiteUrlForm } from "@/components/site-url-form";
import { findProductionUrl, type GhRepo } from "@/lib/github/repos";
import { isAuthError } from "@/lib/github/octokit";
import { loadOwnedRepo } from "@/lib/repos/load";
import { MAX_ENABLED_FLOWS, MAX_TOTAL_FLOWS } from "@/lib/repos/schema";
import { listFlows, setProdUrl, type RepoRow } from "@/lib/repos/store";
import { saveFlowsAction, saveSiteUrl, runDiscovery } from "./actions";

// Finding flows reads the repo and waits on the model, which can take most of a minute.
export const maxDuration = 60;

export default async function RepoPage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const { owner, repo } = await params;

  let ctx: Awaited<ReturnType<typeof loadOwnedRepo>>;
  try {
    ctx = await loadOwnedRepo(owner, repo);
  } catch (err) {
    if (isAuthError(err)) return <ReconnectCard />;
    throw err;
  }
  const { userId, octokit, gh } = ctx;
  let row: RepoRow = ctx.row;

  // First visit: guess the live site from the repo's production deployments, and the user can fix it.
  if (!row.prodUrl) {
    const guess = await guessSite(octokit, gh);
    if (guess) {
      await setProdUrl(userId, row.id, guess);
      row = { ...row, prodUrl: guess };
    }
  }

  const flows = await listFlows(row.id);
  const items = flows.map((f) => ({ id: f.id, name: f.name, objective: f.objective, path: f.path, enabled: f.enabled }));
  const site = (row.prodUrl ?? "").replace(/^https:\/\//, "");

  return (
    <main className="flex flex-col gap-3.5">
      <nav className="-ml-2">
        <Link href="/repos" className="inline-flex min-h-11 items-center gap-0.5 text-base text-accent">
          <ChevronBack size={22} />
          Repos
        </Link>
      </nav>
      <h1 className="ui-h">{gh.name}</h1>

      <SiteUrlForm key={site} initial={site} action={saveSiteUrl.bind(null, gh.owner, gh.name)} />

      {items.length > 0 ? (
        <FlowEditor
          key={JSON.stringify(items)}
          initial={items}
          action={saveFlowsAction.bind(null, gh.owner, gh.name)}
          maxEnabled={MAX_ENABLED_FLOWS}
          maxTotal={MAX_TOTAL_FLOWS}
        />
      ) : (
        <div className="ui-list px-6 py-8 text-center">
          <p className="text-base font-semibold">No flows yet</p>
          <p className="mx-auto mt-1.5 max-w-xs text-sm text-muted">
            Blomp reads your code and suggests 3 to 5 things worth checking on your live site.
          </p>
        </div>
      )}

      <DiscoverButton action={runDiscovery.bind(null, gh.owner, gh.name)} hasFlows={items.length > 0} />
    </main>
  );
}

async function guessSite(octokit: Awaited<ReturnType<typeof loadOwnedRepo>>["octokit"], gh: GhRepo) {
  return findProductionUrl(octokit, gh);
}
