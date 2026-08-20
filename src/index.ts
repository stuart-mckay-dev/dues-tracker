/**
 * Worker entry point.
 *
 * Serves the SPA, mounts the JSON API behind Cloudflare Access, and runs two
 * crons: the daily dues-posting check and the weekly backup.
 */

import { Hono } from "hono";
import { requireAccess, type AppBindings } from "./middleware/access";
import { api } from "./routes/api";
import { runDuesPosting } from "./lib/posting";
import { runWeeklyBackup } from "./lib/backup";
import type { Env } from "./types";

const app = new Hono<AppBindings>();

app.use("/api/*", requireAccess());
app.route("/api", api);

// Everything else is the SPA. Access protects the route as a whole, so the
// static assets sit behind the same policy as the API.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Weekly backup fires Monday; the daily dues check runs every day and
    // no-ops unless this period's meeting date has passed. Distinguishing by
    // cron expression keeps both on one handler.
    if (event.cron === "0 16 * * 1") {
      ctx.waitUntil(runWeeklyBackup(env));
      return;
    }

    ctx.waitUntil(
      runDuesPosting(env.DB, { triggeredBy: "cron", actorEmail: null }).then(
        (result) => {
          if (result.chargesCreated > 0) {
            console.log(
              `Posted ${result.chargesCreated} dues charge(s) for ${result.periodsPosted.join(", ")}`,
            );
          }
        },
      ),
    );
  },
} satisfies ExportedHandler<Env>;
