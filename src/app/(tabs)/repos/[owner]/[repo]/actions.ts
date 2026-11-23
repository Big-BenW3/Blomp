"use server";

import { revalidatePath } from "next/cache";
import { createNvidiaChat } from "@/lib/agent/llm";
import { discoverFlows } from "@/lib/agent/discover";
import { listRepoFiles, readRepoFile } from "@/lib/github/repos";
import type { ActionState } from "@/lib/repos/action-state";
import { friendlyError } from "@/lib/repos/errors";
import { loadOwnedRepo, requireUserId } from "@/lib/repos/load";
import { flowsFormSchema, repoParamSchema } from "@/lib/repos/schema";
import { applyDiscovery, FlowLimitError, findRepoRow, saveFlows, setProdUrl } from "@/lib/repos/store";
import { normalizeSiteUrl } from "@/lib/url";

const back = (owner: string, name: string) => revalidatePath(`/repos/${owner}/${name}`);

/** Saves the live site address Kane will test. An empty box clears it. */
export async function saveSiteUrl(owner: string, name: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const typed = String(formData.get("url") ?? "").trim();
  let url: string | null = null;
  if (typed) {
    url = normalizeSiteUrl(typed) ?? null;
    if (!url) return { ok: false, message: "Enter a public web address, like my-app.vercel.app" };
  }
  const { userId, row } = await loadOwnedRepo(owner, name);
  await setProdUrl(userId, row.id, url);
  back(owner, name);
  return { ok: true, message: "Saved" };
}

/** Saves the flow list after edits: names, what to check, start page and on/off. */
export async function saveFlowsAction(owner: string, name: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  const params = repoParamSchema.safeParse({ owner, repo: name });
  if (!params.success) return { ok: false, message: "Repo not found. Reload and try again." };

  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("flows") ?? "[]"));
  } catch {
    return { ok: false, message: "Could not read the flows. Reload and try again." };
  }
  const parsed = flowsFormSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the flows and try again." };

  const row = await findRepoRow(userId, `${params.data.owner}/${params.data.repo}`);
  if (!row) return { ok: false, message: "Repo not found. Reload and try again." };
  try {
    await saveFlows(row.id, parsed.data);
  } catch (err) {
    if (err instanceof FlowLimitError) return { ok: false, message: err.message };
    return { ok: false, message: friendlyError(err) };
  }
  back(owner, name);
  return { ok: true, message: "Saved" };
}

/** Reads the repo's code and asks the model for the flows most worth checking. */
export async function runDiscovery(owner: string, name: string): Promise<ActionState> {
  const { octokit, gh, row } = await loadOwnedRepo(owner, name);
  try {
    const { paths } = await listRepoFiles(octokit, gh);
    const proposals = await discoverFlows({
      fullName: gh.fullName,
      prodUrl: row.prodUrl ?? undefined,
      paths,
      readFile: (p) => readRepoFile(octokit, gh, p, 5000),
      chat: createNvidiaChat(),
    });
    await applyDiscovery(row.id, proposals);
  } catch (err) {
    return { ok: false, message: friendlyError(err) };
  }
  back(owner, name);
  return { ok: true };
}
