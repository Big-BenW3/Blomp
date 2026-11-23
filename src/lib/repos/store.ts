import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { flows, repos, runs } from "@/db/schema";
import type { FlowProposal } from "@/lib/agent/discover";
import { MAX_ENABLED_FLOWS, type FlowForm } from "./schema";

export type RepoRow = typeof repos.$inferSelect;
export type FlowRow = typeof flows.$inferSelect;

/** Flows the user removed but that already have run history are kept with this source, hidden from the UI. */
const ARCHIVED = "archived";

export class FlowLimitError extends Error {}

export async function upsertRepo(
  userId: string,
  repo: { fullName: string; defaultBranch: string },
): Promise<RepoRow> {
  const db = getDb();
  await db
    .insert(repos)
    .values({ userId, fullName: repo.fullName, defaultBranch: repo.defaultBranch })
    .onConflictDoUpdate({ target: [repos.userId, repos.fullName], set: { defaultBranch: repo.defaultBranch } });
  const [row] = await db
    .select()
    .from(repos)
    .where(and(eq(repos.userId, userId), eq(repos.fullName, repo.fullName)));
  return row;
}

/** The user's own row for a repo, or undefined when they have never opened it (or it is someone else's). */
export async function findRepoRow(userId: string, fullName: string): Promise<RepoRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(repos)
    .where(and(eq(repos.userId, userId), eq(repos.fullName, fullName)));
  return row;
}

export async function listRepoRows(userId: string): Promise<RepoRow[]> {
  return getDb().select().from(repos).where(eq(repos.userId, userId));
}

export async function setProdUrl(userId: string, repoId: string, url: string | null): Promise<void> {
  await getDb()
    .update(repos)
    .set({ prodUrl: url })
    .where(and(eq(repos.id, repoId), eq(repos.userId, userId)));
}

export async function listFlows(repoId: string): Promise<FlowRow[]> {
  return getDb()
    .select()
    .from(flows)
    .where(and(eq(flows.repoId, repoId), ne(flows.source, ARCHIVED)))
    .orderBy(asc(flows.createdAt), asc(flows.id));
}

async function idsWithRuns(flowIds: string[]): Promise<Set<string>> {
  if (flowIds.length === 0) return new Set();
  const rows = await getDb().select({ flowId: runs.flowId }).from(runs).where(inArray(runs.flowId, flowIds));
  return new Set(rows.map((r) => r.flowId));
}

/** Deletes flows nobody has run; flows with history are archived instead so past scans keep their results. */
async function removeFlows(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  const withRuns = await idsWithRuns(ids);
  const archive = ids.filter((id) => withRuns.has(id));
  const drop = ids.filter((id) => !withRuns.has(id));
  if (archive.length) await db.update(flows).set({ source: ARCHIVED, enabled: false }).where(inArray(flows.id, archive));
  if (drop.length) await db.delete(flows).where(inArray(flows.id, drop));
}

/** Saves the edit screen: updates known flows, adds new ones, and removes the ones left out. */
export async function saveFlows(repoId: string, inputs: FlowForm[]): Promise<void> {
  if (inputs.filter((f) => f.enabled).length > MAX_ENABLED_FLOWS) {
    throw new FlowLimitError(`At most ${MAX_ENABLED_FLOWS} flows can be on`);
  }
  const db = getDb();
  const existing = await listFlows(repoId);
  const known = new Set(existing.map((f) => f.id));
  const kept = new Set<string>();

  for (const f of inputs) {
    if (f.id && known.has(f.id)) {
      kept.add(f.id);
      await db
        .update(flows)
        .set({ name: f.name, objective: f.objective, path: f.path, enabled: f.enabled })
        .where(and(eq(flows.id, f.id), eq(flows.repoId, repoId)));
    } else {
      await db
        .insert(flows)
        .values({ repoId, name: f.name, objective: f.objective, path: f.path, enabled: f.enabled, source: "user" });
    }
  }
  await removeFlows(existing.filter((f) => !kept.has(f.id)).map((f) => f.id));
}

/** Replaces the AI-proposed flows with a fresh proposal; flows the user wrote themselves are left alone. */
export async function applyDiscovery(repoId: string, proposals: FlowProposal[]): Promise<void> {
  const db = getDb();
  const existing = await listFlows(repoId);
  await removeFlows(existing.filter((f) => f.source === "ai").map((f) => f.id));

  const userEnabled = existing.filter((f) => f.source !== "ai" && f.enabled).length;
  const room = Math.max(0, MAX_ENABLED_FLOWS - userEnabled);
  // One INSERT gives every row the same now(), so stamp increasing times to keep the model's ranking as the order.
  const base = Date.now();
  const rows = proposals.map((p, i) => ({
    repoId,
    createdAt: new Date(base + i),
    name: p.name,
    objective: p.objective,
    path: p.path,
    source: "ai",
    enabled: i < room,
  }));
  if (rows.length) await db.insert(flows).values(rows);
}
