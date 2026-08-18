import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

/**
 * Database-backed tests, run inside workerd against a real local D1 with the
 * project's own migrations applied.
 *
 * Mocking the database here would defeat the purpose: the constraints in
 * migrations/0001_init.sql are load-bearing — the whole-dollar CHECK and the
 * partial unique index behind dues idempotency — so they have to be the thing
 * under test, not something a fake reimplements.
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      name: "worker",
      include: ["test/worker/**/*.test.ts"],
      setupFiles: ["./test/worker/setup.ts"],
    },
  };
});
