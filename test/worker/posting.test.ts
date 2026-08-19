import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { findUnpostedPeriods, runDuesPosting } from "../../src/lib/posting";
import { insertMember, listMembersWithBalances } from "../../src/lib/db";
import type { StatusCode } from "../../src/types";

const db = env.DB;

async function addMember(
  id: string,
  status: StatusCode,
  duesStart = "2026-01",
): Promise<void> {
  await insertMember(db, {
    id,
    display_name: id,
    first_name: null,
    last_name: null,
    nickname: null,
    email: null,
    phone: null,
    status,
    dues_start_period: duesStart,
    joined_on: null,
    notes: null,
    archived_at: null,
  });
}

async function duesCount(memberId?: string): Promise<number> {
  const sql = memberId
    ? "SELECT COUNT(*) AS n FROM transactions WHERE kind='dues_charge' AND voided_at IS NULL AND member_id = ?"
    : "SELECT COUNT(*) AS n FROM transactions WHERE kind='dues_charge' AND voided_at IS NULL";
  const stmt = memberId ? db.prepare(sql).bind(memberId) : db.prepare(sql);
  const row = await stmt.first<{ n: number }>();
  return row?.n ?? 0;
}

async function balanceOf(memberId: string): Promise<number> {
  const members = await listMembersWithBalances(db);
  return members.find((m) => m.id === memberId)!.balance_cents;
}

beforeEach(async () => {
  await db.prepare("DELETE FROM transactions").run();
  await db.prepare("DELETE FROM posting_runs").run();
  await db.prepare("DELETE FROM members").run();
  await db.prepare("DELETE FROM audit_log").run();
});

describe("idempotency — the guarantee the whole design rests on", () => {
  it("posts exactly one charge per member per period, however many times it runs", async () => {
    await addMember("alice", "active", "2026-08");

    for (let i = 0; i < 3; i++) {
      await runDuesPosting(db, { triggeredBy: "cron", today: "2026-08-06" });
    }

    expect(await duesCount("alice")).toBe(1);
    expect(await balanceOf("alice")).toBe(2500);
  });

  it("reports zero work on the second run", async () => {
    await addMember("alice", "active", "2026-06");

    const first = await runDuesPosting(db, { triggeredBy: "cron", today: "2026-08-06" });
    const second = await runDuesPosting(db, { triggeredBy: "cron", today: "2026-08-06" });

    expect(first.chargesCreated).toBe(3); // Jun, Jul, Aug
    expect(second.chargesCreated).toBe(0);
    expect(second.periodsPosted).toEqual([]);
  });

  it("survives concurrent runs without double-charging", async () => {
    await addMember("alice", "active", "2026-08");

    await Promise.all([
      runDuesPosting(db, { triggeredBy: "cron", today: "2026-08-06" }),
      runDuesPosting(db, { triggeredBy: "manual", today: "2026-08-06" }),
    ]);

    expect(await duesCount("alice")).toBe(1);
  });
});

describe("catch-up", () => {
  it("posts 20 months for a member 20 months behind, then nothing", async () => {
    await addMember("dave", "active", "2025-01");

    const first = await runDuesPosting(db, { triggeredBy: "manual", today: "2026-08-06" });
    expect(first.chargesCreated).toBe(20);
    expect(await balanceOf("dave")).toBe(50_000); // 20 months

    const second = await runDuesPosting(db, { triggeredBy: "manual", today: "2026-08-06" });
    expect(second.chargesCreated).toBe(0);
  });

  it("dates each charge on the meeting it belongs to, not the run date", async () => {
    await addMember("dave", "active", "2026-06");
    await runDuesPosting(db, { triggeredBy: "manual", today: "2026-08-06" });

    const { results } = await db
      .prepare(
        "SELECT period, occurred_on FROM transactions WHERE kind='dues_charge' ORDER BY period",
      )
      .all<{ period: string; occurred_on: string }>();

    expect(results).toEqual([
      { period: "2026-06", occurred_on: "2026-06-11" },
      { period: "2026-07", occurred_on: "2026-07-09" },
      { period: "2026-08", occurred_on: "2026-08-06" },
    ]);
  });

  // Void and delete mean different things, and the difference is what makes
  // waiving a month possible at all.
  it("does NOT re-post a voided (waived) month", async () => {
    await addMember("dave", "active", "2026-06");
    await runDuesPosting(db, { triggeredBy: "cron", today: "2026-08-06" });

    await db
      .prepare(
        "UPDATE transactions SET voided_at = datetime('now'), void_reason = 'Waived' WHERE period = '2026-07'",
      )
      .run();

    const rerun = await runDuesPosting(db, { triggeredBy: "cron", today: "2026-08-06" });
    expect(rerun.chargesCreated).toBe(0);
    expect(await duesCount("dave")).toBe(2); // Jun and Aug only
    expect(await balanceOf("dave")).toBe(5000); // July genuinely forgiven
  });

  it("DOES re-post a hard-deleted month", async () => {
    await addMember("dave", "active", "2026-06");
    await runDuesPosting(db, { triggeredBy: "cron", today: "2026-08-06" });
    await db.prepare("DELETE FROM transactions WHERE period = '2026-07'").run();

    const rerun = await runDuesPosting(db, { triggeredBy: "cron", today: "2026-08-06" });
    expect(rerun.chargesCreated).toBe(1);
    expect(await balanceOf("dave")).toBe(7500);
  });

  it("fills a gap left by a missed cron", async () => {
    await addMember("dave", "active", "2026-06");
    await runDuesPosting(db, { triggeredBy: "cron", today: "2026-08-06" });

    await db
      .prepare("DELETE FROM transactions WHERE period = '2026-07'")
      .run();
    expect(await duesCount("dave")).toBe(2);

    const repair = await runDuesPosting(db, { triggeredBy: "cron", today: "2026-08-06" });
    expect(repair.chargesCreated).toBe(1);
    expect(repair.periodsPosted).toEqual(["2026-07"]);
    expect(await duesCount("dave")).toBe(3);
  });
});

describe("eligibility by status", () => {
  it("charges active, prospect and suspended; skips inactive and lifetime", async () => {
    await addMember("act", "active", "2026-08");
    await addMember("pro", "prospect", "2026-08");
    await addMember("sus", "suspended", "2026-08");
    await addMember("ina", "inactive", "2026-08");
    await addMember("life", "lifetime", "2026-08");

    await runDuesPosting(db, { triggeredBy: "cron", today: "2026-08-06" });

    expect(await balanceOf("act")).toBe(2500);
    expect(await balanceOf("pro")).toBe(2500);
    expect(await balanceOf("sus")).toBe(2500);
    expect(await balanceOf("ina")).toBe(0);
    expect(await balanceOf("life")).toBe(0);
  });

  it("skips archived members", async () => {
    await addMember("gone", "active", "2026-08");
    await db
      .prepare("UPDATE members SET archived_at = datetime('now') WHERE id = 'gone'")
      .run();

    const result = await runDuesPosting(db, { triggeredBy: "cron", today: "2026-08-06" });
    expect(result.chargesCreated).toBe(0);
  });
});

describe("the posting-date guard", () => {
  it("does not charge for a month whose meeting has not happened", async () => {
    await addMember("alice", "active", "2026-08");

    // August 2026 posts on the 6th.
    const early = await runDuesPosting(db, { triggeredBy: "cron", today: "2026-08-05" });
    expect(early.chargesCreated).toBe(0);

    const onTime = await runDuesPosting(db, { triggeredBy: "cron", today: "2026-08-06" });
    expect(onTime.chargesCreated).toBe(1);
  });

  it("does not charge a member before their dues start", async () => {
    await addMember("newbie", "active", "2026-09");
    const result = await runDuesPosting(db, { triggeredBy: "cron", today: "2026-08-06" });
    expect(result.chargesCreated).toBe(0);
  });
});

describe("bookkeeping", () => {
  it("records one posting_run row per period with correct totals", async () => {
    await addMember("a", "active", "2026-07");
    await addMember("b", "active", "2026-07");
    await runDuesPosting(db, { triggeredBy: "manual", today: "2026-08-06" });

    const { results } = await db
      .prepare("SELECT period, member_count, total_cents, triggered_by FROM posting_runs ORDER BY period")
      .all<{ period: string; member_count: number; total_cents: number; triggered_by: string }>();

    expect(results).toEqual([
      { period: "2026-07", member_count: 2, total_cents: 5000, triggered_by: "manual" },
      { period: "2026-08", member_count: 2, total_cents: 5000, triggered_by: "manual" },
    ]);
  });

  it("writes an audit row only when work was done", async () => {
    await addMember("a", "active", "2026-08");
    await runDuesPosting(db, { triggeredBy: "cron", today: "2026-08-06", actorEmail: "t@club" });
    await runDuesPosting(db, { triggeredBy: "cron", today: "2026-08-06", actorEmail: "t@club" });

    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='post_dues'")
      .first<{ n: number }>();
    expect(row!.n).toBe(1);
  });
});

describe("unposted-period detection", () => {
  it("is quiet when everything is posted", async () => {
    await addMember("a", "active", "2026-07");
    await runDuesPosting(db, { triggeredBy: "cron", today: "2026-08-06" });

    const { unposted } = await findUnpostedPeriods(db, "2026-08-06");
    expect(unposted).toEqual([]);
  });

  it("surfaces months the job never ran for", async () => {
    await addMember("a", "active", "2026-06");

    const { unposted } = await findUnpostedPeriods(db, "2026-08-06");
    expect(unposted).toEqual(["2026-06", "2026-07", "2026-08"]);
  });

  it("ignores the current month before its meeting date", async () => {
    await addMember("a", "active", "2026-08");
    const { unposted, latestPostable } = await findUnpostedPeriods(db, "2026-08-05");
    expect(latestPostable).toBe("2026-07");
    expect(unposted).not.toContain("2026-08");
  });
});

describe("whole-dollar constraint is enforced by the database", () => {
  it("rejects a non-whole-dollar amount", async () => {
    await addMember("a", "active", "2026-08");
    await expect(
      db
        .prepare(
          `INSERT INTO transactions (id, member_id, kind, direction, amount_cents, occurred_on)
           VALUES ('x','a','payment','credit',4783,'2026-08-07')`,
        )
        .run(),
    ).rejects.toThrow();
  });
});
