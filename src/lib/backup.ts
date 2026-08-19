/**
 * Weekly backup to R2.
 *
 * Two formats in one bundle: JSON for exact restoration, CSV for a human — and
 * for the next treasurer, who may not have this app at all. The CSV is the one
 * that matters in five years.
 *
 * D1 Time Travel already gives 30 days of point-in-time restore for free, so
 * this is about portability and long-horizon retention rather than being the
 * first line of recovery. (docs/DEPLOYMENT.md)
 */

import { transactionsCsv, toCsv, type ExportRow } from "./csv";
import { loadSettings } from "./db";
import { todayInTz } from "./period";
import type { Env } from "../types";

const RETENTION_WEEKS = 26;

export interface BackupResult {
  key: string;
  bytes: number;
  tables: Record<string, number>;
  pruned: number;
}

const TABLES = [
  "members",
  "transactions",
  "statuses",
  "settings",
  "posting_runs",
  "audit_log",
] as const;

export async function buildBackup(
  env: Env,
): Promise<{ json: string; csv: string; counts: Record<string, number>; date: string }> {
  const db = env.DB;
  const settings = await loadSettings(db);
  const date = todayInTz(settings.clubTimezone);

  const dump: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};

  for (const table of TABLES) {
    const { results } = await db.prepare(`SELECT * FROM ${table}`).all();
    dump[table] = results;
    counts[table] = results.length;
  }

  const { results: exportRows } = await db
    .prepare(
      `SELECT t.*, m.display_name AS member_name
       FROM transactions t JOIN members m ON m.id = t.member_id
       ORDER BY t.occurred_on, t.created_at`,
    )
    .all<ExportRow>();

  const json = JSON.stringify(
    { version: 1, generatedAt: new Date().toISOString(), date, settings, data: dump },
    null,
    2,
  );

  const memberCsv = toCsv(
    ["id", "name", "status", "dues_start_period", "joined_on", "archived"],
    (dump.members as Record<string, unknown>[]).map((m) => [
      m.id,
      m.display_name,
      m.status,
      m.dues_start_period,
      m.joined_on,
      m.archived_at ? "yes" : "",
    ]),
  );

  return {
    json,
    csv: `# Members\r\n${memberCsv}\r\n# Transactions\r\n${transactionsCsv(exportRows)}`,
    counts,
    date,
  };
}

export async function runWeeklyBackup(env: Env): Promise<BackupResult> {
  const { json, csv, counts, date } = await buildBackup(env);
  const prefix = `backups/${date}`;

  await Promise.all([
    env.BACKUPS.put(`${prefix}/dues-tracker.json`, json, {
      httpMetadata: { contentType: "application/json" },
    }),
    env.BACKUPS.put(`${prefix}/dues-tracker.csv`, csv, {
      httpMetadata: { contentType: "text/csv" },
    }),
  ]);

  const pruned = await pruneOldBackups(env);

  return {
    key: prefix,
    bytes: json.length + csv.length,
    tables: counts,
    pruned,
  };
}

/** Keep the most recent RETENTION_WEEKS dated folders. */
async function pruneOldBackups(env: Env): Promise<number> {
  const listed = await env.BACKUPS.list({ prefix: "backups/" });

  const dates = [...new Set(listed.objects.map((o) => o.key.split("/")[1]))]
    .filter((d): d is string => Boolean(d))
    .sort();

  const stale = dates.slice(0, Math.max(0, dates.length - RETENTION_WEEKS));
  if (stale.length === 0) return 0;

  const staleKeys = listed.objects
    .filter((o) => stale.includes(o.key.split("/")[1] ?? ""))
    .map((o) => o.key);

  if (staleKeys.length > 0) await env.BACKUPS.delete(staleKeys);
  return stale.length;
}
