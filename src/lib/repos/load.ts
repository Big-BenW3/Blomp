import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { getUserOctokit } from "@/lib/github/octokit";
import { getRepo, type GhRepo } from "@/lib/github/repos";
import { repoParamSchema } from "./schema";
import { upsertRepo } from "./store";

export async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  return session.user.id;
}

/**
 * Resolves a repo from URL params for the signed-in user. GitHub is asked as the user, so a repo they cannot
 * see is a 404 here no matter what the URL says. Creates the Blomp row the first time a repo is opened.
 */
export async function loadOwnedRepo(owner: string, name: string) {
  const parsed = repoParamSchema.safeParse({ owner, repo: name });
  if (!parsed.success) notFound();
  const userId = await requireUserId();
  const octokit = await getUserOctokit(userId);
  let gh: GhRepo;
  try {
    gh = await getRepo(octokit, parsed.data.owner, parsed.data.repo);
  } catch (err) {
    if ((err as { status?: number }).status === 404) notFound();
    throw err;
  }
  const row = await upsertRepo(userId, { fullName: gh.fullName, defaultBranch: gh.defaultBranch });
  return { userId, octokit, gh, row };
}
