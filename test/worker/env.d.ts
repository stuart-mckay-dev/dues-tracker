import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Injected by vitest.workers.config.ts for the migration setup step. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
