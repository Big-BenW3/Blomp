import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

// No top-level await: tsx runs this file as CommonJS.
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (add it as a GitHub Actions secret)");
    process.exit(1);
  }
  await migrate(drizzle(neon(url)), { migrationsFolder: "src/db/migrations" });
  console.log("migrations applied");
}

main().catch((err) => {
  console.error("migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
