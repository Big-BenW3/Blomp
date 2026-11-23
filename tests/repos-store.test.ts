import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, setDbForTesting, type Db } from "@/db";
import * as schema from "@/db/schema";
import { applyDiscovery, findRepoRow, FlowLimitError, listFlows, saveFlows, setProdUrl, upsertRepo } from "@/lib/repos/store";
import { flowsFormSchema } from "@/lib/repos/schema";

const { users, flows, scans, runs } = schema;
let client: PGlite;
let userA: string;
let userB: string;

const proposal = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `Flow ${i + 1}`, objective: `Do the thing number ${i + 1} and check`, path: "/" }));
const form = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  objective: `Check that ${name} works fine`,
  path: "/",
  enabled: true,
  ...over,
});

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "src/db/migrations" });
  setDbForTesting(db as unknown as Db);
  const d = getDb();
  [{ id: userA }] = await d.insert(users).values({ githubId: 1, login: "a", accessTokenEnc: "x" }).returning({ id: users.id });
  [{ id: userB }] = await d.insert(users).values({ githubId: 2, login: "b", accessTokenEnc: "x" }).returning({ id: users.id });
});

afterAll(async () => {
  setDbForTesting(undefined);
  await client.close();
});

describe("upsertRepo / setProdUrl", () => {
  it("creates once, keeps one row per user and repo, and tracks the default branch", async () => {
    const a = await upsertRepo(userA, { fullName: "a/shop", defaultBranch: "main" });
    const again = await upsertRepo(userA, { fullName: "a/shop", defaultBranch: "trunk" });
    expect(again.id).toBe(a.id);
    expect(again.defaultBranch).toBe("trunk");
    const other = await upsertRepo(userB, { fullName: "a/shop", defaultBranch: "main" });
    expect(other.id).not.toBe(a.id); // the same GitHub repo seen by another user is a separate row
  });

  it("sets and clears the production URL, and only for the owner", async () => {
    const r = await upsertRepo(userA, { fullName: "a/url", defaultBranch: "main" });
    await setProdUrl(userA, r.id, "https://a.example.com");
    expect((await upsertRepo(userA, { fullName: "a/url", defaultBranch: "main" })).prodUrl).toBe("https://a.example.com");
    await setProdUrl(userB, r.id, "https://evil.example.com"); // not the owner: no effect
    expect((await upsertRepo(userA, { fullName: "a/url", defaultBranch: "main" })).prodUrl).toBe("https://a.example.com");
    await setProdUrl(userA, r.id, null);
    expect((await upsertRepo(userA, { fullName: "a/url", defaultBranch: "main" })).prodUrl).toBeNull();
  });
});

describe("applyDiscovery", () => {
  it("stores proposals as enabled AI flows and replaces them on a second run", async () => {
    const r = await upsertRepo(userA, { fullName: "a/disc", defaultBranch: "main" });
    await applyDiscovery(r.id, proposal(3));
    expect((await listFlows(r.id)).map((f) => f.name)).toEqual(["Flow 1", "Flow 2", "Flow 3"]);
    expect((await listFlows(r.id)).every((f) => f.source === "ai" && f.enabled)).toBe(true);
    await applyDiscovery(r.id, [{ name: "Fresh", objective: "A completely new flow to check", path: "/new" }]);
    expect((await listFlows(r.id)).map((f) => f.name)).toEqual(["Fresh"]);
  });

  it("keeps flows the user wrote and does not push the enabled total past 5", async () => {
    const r = await upsertRepo(userA, { fullName: "a/mix", defaultBranch: "main" });
    await saveFlows(r.id, [form("Mine one"), form("Mine two"), form("Mine three")]);
    await applyDiscovery(r.id, proposal(5));
    const all = await listFlows(r.id);
    expect(all.filter((f) => f.source === "user")).toHaveLength(3);
    expect(all.filter((f) => f.enabled)).toHaveLength(5);
    expect(all.filter((f) => f.source === "ai" && !f.enabled)).toHaveLength(3);
  });

  it("archives (hides) an old AI flow that already has run history, so past scans survive", async () => {
    const d = getDb();
    const r = await upsertRepo(userA, { fullName: "a/hist", defaultBranch: "main" });
    await applyDiscovery(r.id, proposal(3));
    const [first] = await listFlows(r.id);
    const [scan] = await d.insert(scans).values({ repoId: r.id, trigger: "manual", targetUrl: "https://x.test" }).returning({ id: scans.id });
    await d.insert(runs).values({ scanId: scan.id, flowId: first.id, verdict: "pass" });

    await applyDiscovery(r.id, proposal(3));
    const visible = await listFlows(r.id);
    expect(visible.some((f) => f.id === first.id)).toBe(false);
    const [kept] = await d.select().from(flows).where(eq(flows.id, first.id));
    expect(kept).toMatchObject({ source: "archived", enabled: false });
    expect(await d.select().from(runs).where(eq(runs.flowId, first.id))).toHaveLength(1);
  });
});

describe("saveFlows", () => {
  it("edits known flows, adds new ones and removes the ones left out", async () => {
    const r = await upsertRepo(userA, { fullName: "a/edit", defaultBranch: "main" });
    await applyDiscovery(r.id, proposal(3));
    const [f1, f2] = await listFlows(r.id);
    await saveFlows(r.id, [
      form("Renamed", { id: f1.id, path: "/renamed", enabled: false }),
      form(f2.name, { id: f2.id, objective: f2.objective }),
      form("Brand new"),
    ]);
    const after = await listFlows(r.id);
    expect(after.map((f) => f.name).sort()).toEqual(["Brand new", "Renamed", f2.name].sort());
    expect(after.find((f) => f.id === f1.id)).toMatchObject({ name: "Renamed", path: "/renamed", enabled: false });
    expect(after.find((f) => f.name === "Brand new")?.source).toBe("user");
  });

  it("refuses more than 5 enabled flows", async () => {
    const r = await upsertRepo(userA, { fullName: "a/limit", defaultBranch: "main" });
    const six = Array.from({ length: 6 }, (_, i) => form(`Flow ${i}`));
    await expect(saveFlows(r.id, six)).rejects.toBeInstanceOf(FlowLimitError);
    expect(await listFlows(r.id)).toHaveLength(0);
  });

  it("ignores ids that belong to another repo instead of editing them", async () => {
    const mine = await upsertRepo(userA, { fullName: "a/mine", defaultBranch: "main" });
    const theirs = await upsertRepo(userB, { fullName: "b/theirs", defaultBranch: "main" });
    await applyDiscovery(theirs.id, proposal(3));
    const [victim] = await listFlows(theirs.id);
    await saveFlows(mine.id, [form("Sneaky", { id: victim.id })]);
    expect((await listFlows(theirs.id)).find((f) => f.id === victim.id)?.name).toBe(victim.name); // untouched
    expect((await listFlows(mine.id)).map((f) => f.name)).toEqual(["Sneaky"]); // inserted as a new flow here
  });
});

describe("flowsFormSchema", () => {
  it("validates name, objective, path and the 5-enabled / 10-total limits", () => {
    expect(flowsFormSchema.safeParse([form("Good flow")]).success).toBe(true);
    expect(flowsFormSchema.safeParse([form("ab")]).success).toBe(false);
    expect(flowsFormSchema.safeParse([form("Good flow", { objective: "short" })]).success).toBe(false);
    expect(flowsFormSchema.safeParse([form("Good flow", { path: "no-slash" })]).success).toBe(false);
    expect(flowsFormSchema.safeParse([form("Good flow", { id: "not-a-uuid" })]).success).toBe(false);
    const six = Array.from({ length: 6 }, (_, i) => form(`Flow ${i}`));
    expect(flowsFormSchema.safeParse(six).success).toBe(false);
    expect(flowsFormSchema.safeParse(six.map((f, i) => ({ ...f, enabled: i < 5 }))).success).toBe(true);
    expect(flowsFormSchema.safeParse(Array.from({ length: 11 }, (_, i) => form(`Flow ${i}`, { enabled: false }))).success).toBe(false);
  });
});

describe("findRepoRow", () => {
  it("finds only the signed-in user's own row", async () => {
    const mine = await upsertRepo(userA, { fullName: "a/find", defaultBranch: "main" });
    expect((await findRepoRow(userA, "a/find"))?.id).toBe(mine.id);
    expect(await findRepoRow(userB, "a/find")).toBeUndefined();
    expect(await findRepoRow(userA, "a/never-opened")).toBeUndefined();
  });
});
