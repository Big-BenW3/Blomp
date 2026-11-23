import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // PGlite boots a WASM Postgres, which is slow on a cold CI runner.
  test: { environment: "node", include: ["tests/**/*.test.ts"], hookTimeout: 90_000, testTimeout: 30_000 },
});
