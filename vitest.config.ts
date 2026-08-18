import { defineConfig } from "vitest/config";

/**
 * Two projects:
 *
 *   unit   — pure logic (posting dates, standing math, money). Plain Node, no
 *            workerd, so the suite that runs on every save stays fast.
 *   worker — anything touching D1. Runs inside workerd against a real local
 *            database so migrations, CHECK constraints, and the partial unique
 *            index are exercised for real. The idempotency guarantee is only
 *            meaningful if the actual index is the thing under test.
 *
 * The worker project is registered in vitest.workers.config.ts and only loads
 * once there are tests in test/worker.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      "./vitest.workers.config.ts",
    ],
  },
});
