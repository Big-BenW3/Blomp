import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let cached: Db | undefined;

/** Lazy so `next build` works without DATABASE_URL; it only throws when a query is actually made. */
export function getDb(): Db {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    cached = drizzle(neon(url), { schema }) as unknown as Db;
  }
  return cached;
}

/** Tests swap in an in-process Postgres (PGlite) so database logic runs against real SQL. */
export function setDbForTesting(db: Db | undefined): void {
  cached = db;
}
