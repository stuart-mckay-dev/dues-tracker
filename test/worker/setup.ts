import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

// Applied once at the outermost level; isolated storage rolls back each
// test's own writes, so every test starts from a freshly migrated database.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
