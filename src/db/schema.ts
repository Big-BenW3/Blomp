import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    githubId: bigint("github_id", { mode: "number" }).notNull(),
    login: text("login").notNull(),
    avatarUrl: text("avatar_url"),
    accessTokenEnc: text("access_token_enc").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_github_id_idx").on(t.githubId)],
);

export const repos = pgTable(
  "repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    prodUrl: text("prod_url"),
    lastScore: integer("last_score"),
    autoScan: boolean("auto_scan").notNull().default(false),
    webhookId: bigint("webhook_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("repos_user_full_name_idx").on(t.userId, t.fullName)],
);

export const flows = pgTable(
  "flows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    objective: text("objective").notNull(),
    path: text("path").notNull().default("/"),
    source: text("source").notNull().default("ai"), // ai | user
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("flows_repo_idx").on(t.repoId)],
);

export const scans = pgTable(
  "scans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    trigger: text("trigger").notNull(), // manual | push | recheck
    commitSha: text("commit_sha"),
    targetUrl: text("target_url").notNull(),
    status: text("status").notNull().default("queued"), // queued | running | done | error
    score: integer("score"),
    passed: integer("passed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    unknown: integer("unknown").notNull().default(0),
    workflowRunId: bigint("workflow_run_id", { mode: "number" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("scans_repo_idx").on(t.repoId)],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scanId: uuid("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    verdict: text("verdict").notNull().default("pending"), // pending | pass | fail | unknown
    exitCode: integer("exit_code"),
    oneLiner: text("one_liner"),
    reason: text("reason"),
    failingStep: text("failing_step"),
    credits: doublePrecision("credits"),
    testUrl: text("test_url"),
    evidenceUrl: text("evidence_url"),
    consoleErrors: jsonb("console_errors").$type<string[]>().notNull().default([]),
    networkErrors: jsonb("network_errors").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("runs_scan_idx").on(t.scanId), uniqueIndex("runs_scan_flow_idx").on(t.scanId, t.flowId)],
);

export const runSteps = pgTable(
  "run_steps",
  {
    id: serial("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    status: text("status").notNull(), // running | done | failed | info
    remark: text("remark").notNull().default(""),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  // One row per (run, step index, status): re-posting the same line from the runner is a no-op.
  (t) => [uniqueIndex("run_steps_dedupe_idx").on(t.runId, t.idx, t.status)],
);

export const fixes = pgTable(
  "fixes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    branch: text("branch"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    summary: text("summary"),
    status: text("status").notNull().default("drafting"), // drafting | pr_open | verifying | verified | failed
    recheckScanId: uuid("recheck_scan_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("fixes_run_idx").on(t.runId)],
);

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id").references(() => repos.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // scan_started | scan_done | flow_failed | fix_opened | fix_verified | push_scan
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("events_user_created_idx").on(t.userId, t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type Repo = typeof repos.$inferSelect;
export type Flow = typeof flows.$inferSelect;
export type Scan = typeof scans.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type RunStep = typeof runSteps.$inferSelect;
export type Fix = typeof fixes.$inferSelect;
export type AppEvent = typeof events.$inferSelect;
