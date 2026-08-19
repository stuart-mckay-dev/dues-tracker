import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { buildBackup, runWeeklyBackup } from "../../src/lib/backup";
import { insertMember, insertTransaction } from "../../src/lib/db";
import { runDuesPosting } from "../../src/lib/posting";

const db = env.DB;

beforeEach(async () => {
  await db.prepare("DELETE FROM transactions").run();
  await db.prepare("DELETE FROM posting_runs").run();
  await db.prepare("DELETE FROM members").run();
  await db.prepare("DELETE FROM audit_log").run();

  const existing = await env.BACKUPS.list({ prefix: "backups/" });
  if (existing.objects.length) {
    await env.BACKUPS.delete(existing.objects.map((o) => o.key));
  }

  await insertMember(db, {
    id: "dave",
    display_name: "Dave Rankin",
    first_name: null,
    last_name: null,
    nickname: "Tank",
    email: null,
    phone: null,
    status: "active",
    dues_start_period: "2026-07",
    joined_on: null,
    notes: null,
    archived_at: null,
  });
  await runDuesPosting(db, { triggeredBy: "cron", today: "2026-08-06" });
  await insertTransaction(db, {
    id: "pay1",
    member_id: "dave",
    kind: "payment",
    direction: "credit",
    amount_cents: 3000,
    occurred_on: "2026-08-07",
    method: "cash",
  });
});

describe("backup bundle", () => {
  it("captures every table", async () => {
    const { counts } = await buildBackup(env);
    expect(counts.members).toBe(1);
    expect(counts.transactions).toBe(3); // 2 dues + 1 payment
    expect(counts.statuses).toBe(5);
    expect(counts.settings).toBeGreaterThan(0);
    expect(counts.posting_runs).toBe(2);
  });

  it("produces JSON that round-trips", async () => {
    const { json } = await buildBackup(env);
    const parsed = JSON.parse(json) as {
      version: number;
      data: { members: { display_name: string }[] };
    };
    expect(parsed.version).toBe(1);
    expect(parsed.data.members[0]!.display_name).toBe("Dave Rankin");
  });

  it("produces a CSV a future treasurer can read without this app", async () => {
    const { csv } = await buildBackup(env);
    expect(csv).toContain("# Members");
    expect(csv).toContain("# Transactions");
    expect(csv).toContain("Dave Rankin");
    expect(csv).toContain("30.00"); // the payment, in a plain money column
  });
});

describe("weekly backup to R2", () => {
  it("writes both formats under a dated prefix", async () => {
    const result = await runWeeklyBackup(env);
    expect(result.key).toMatch(/^backups\/\d{4}-\d{2}-\d{2}$/);

    const listed = await env.BACKUPS.list({ prefix: "backups/" });
    const keys = listed.objects.map((o) => o.key).sort();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/dues-tracker\.csv$/);
    expect(keys[1]).toMatch(/dues-tracker\.json$/);
  });

  it("is safe to run twice in one week", async () => {
    await runWeeklyBackup(env);
    await runWeeklyBackup(env);
    const listed = await env.BACKUPS.list({ prefix: "backups/" });
    expect(listed.objects).toHaveLength(2); // overwritten, not duplicated
  });

  it("prunes beyond the retention window", async () => {
    // 30 weekly folders, oldest first; only the newest 26 should survive.
    for (let i = 0; i < 30; i++) {
      const date = `2020-01-${String(i + 1).padStart(2, "0")}`;
      await env.BACKUPS.put(`backups/${date}/dues-tracker.json`, "{}");
    }
    const result = await runWeeklyBackup(env);
    expect(result.pruned).toBeGreaterThan(0);

    const listed = await env.BACKUPS.list({ prefix: "backups/" });
    const dates = new Set(listed.objects.map((o) => o.key.split("/")[1]));
    expect(dates.size).toBe(26);
  });
});
