/**
 * The JSON API. Every route here sits behind `requireAccess()`.
 */

import { Hono } from "hono";
import type { AppBindings } from "../middleware/access";
import {
  deleteTransaction,
  directionFor,
  getMemberRaw,
  getMemberWithBalance,
  getTransaction,
  insertMember,
  insertTransaction,
  listMembersWithBalances,
  listStatuses,
  listTransactionsForMember,
  loadSettings,
  updateMember,
  updateSettings,
  voidTransaction,
  withRunningBalance,
  writeAudit,
} from "../lib/db";
import { findUnpostedPeriods, runDuesPosting } from "../lib/posting";
import { nextPostingDate, postingDateFor } from "../lib/accrual";
import {
  currentPeriodFor,
  inBadStanding,
  inWarning,
  paidAhead,
  sortForRoster,
  toRosterEntry,
} from "../lib/roster";
import { addMonths, periodOfDate, todayInTz, type Period } from "../lib/period";
import { parseAmountToCents } from "../lib/money";
import { transactionsCsv } from "../lib/csv";
import { buildBackup, runWeeklyBackup } from "../lib/backup";
import type { Direction, PaymentMethod, TransactionKind } from "../types";

const KINDS: TransactionKind[] = [
  "dues_charge",
  "misc_debit",
  "payment",
  "reimbursement_credit",
  "opening_balance",
];
const METHODS: PaymentMethod[] = ["cash", "venmo", "zelle", "check", "other"];

export const api = new Hono<AppBindings>();

class BadRequest extends Error {}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequest(`${field} is required`);
  }
  return value.trim();
}

api.onError((err, c) => {
  if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
  console.error("API error:", err);
  return c.json({ error: "Internal error" }, 500);
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

api.get("/bootstrap", async (c) => {
  const [settings, statuses] = await Promise.all([
    loadSettings(c.env.DB),
    listStatuses(c.env.DB),
  ]);
  const today = todayInTz(settings.clubTimezone);
  return c.json({
    settings,
    statuses,
    actorEmail: c.var.actorEmail,
    today,
    currentPeriod: periodOfDate(today),
    nextPostingDate: nextPostingDate(today),
    methods: METHODS,
  });
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

api.get("/dashboard", async (c) => {
  const db = c.env.DB;
  const settings = await loadSettings(db);
  const today = todayInTz(settings.clubTimezone);
  const currentPeriod = periodOfDate(today);

  const [members, unposted] = await Promise.all([
    listMembersWithBalances(db),
    findUnpostedPeriods(db, today),
  ]);

  const entries = members.map((m) => toRosterEntry(m, settings, currentPeriod));

  const collected = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN occurred_on >= ?1 THEN amount_cents END), 0) AS month_cents,
         COALESCE(SUM(CASE WHEN occurred_on >= ?2 THEN amount_cents END), 0) AS year_cents
       FROM transactions
       WHERE kind = 'payment' AND voided_at IS NULL`,
    )
    .bind(`${currentPeriod}-01`, `${currentPeriod.slice(0, 4)}-01-01`)
    .first<{ month_cents: number; year_cents: number }>();

  const outstandingCents = entries
    .filter((e) => e.balanceCents > 0)
    .reduce((sum, e) => sum + e.balanceCents, 0);
  const prepaidCents = entries
    .filter((e) => e.balanceCents < 0)
    .reduce((sum, e) => sum - e.balanceCents, 0);

  return c.json({
    today,
    currentPeriod,
    nextPostingDate: nextPostingDate(today),
    thisMonthPostingDate: postingDateFor(currentPeriod),
    collectedThisMonthCents: collected?.month_cents ?? 0,
    collectedThisYearCents: collected?.year_cents ?? 0,
    outstandingCents,
    prepaidCents,
    memberCount: entries.length,
    badStanding: inBadStanding(entries),
    warning: inWarning(entries),
    paidAhead: paidAhead(entries),
    unpostedPeriods: unposted.unposted,
  });
});

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

api.get("/members", async (c) => {
  const db = c.env.DB;
  const includeArchived = c.req.query("archived") === "1";
  const settings = await loadSettings(db);
  const currentPeriod = currentPeriodFor(settings);
  const members = await listMembersWithBalances(db, { includeArchived });
  return c.json({
    members: sortForRoster(members.map((m) => toRosterEntry(m, settings, currentPeriod))),
  });
});

api.post("/members", async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<Record<string, unknown>>();
  const settings = await loadSettings(db);
  const today = todayInTz(settings.clubTimezone);

  const statuses = await listStatuses(db);
  const status = typeof body.status === "string" ? body.status : "active";
  if (!statuses.some((s) => s.code === status)) {
    throw new BadRequest(`Unknown status: ${status}`);
  }

  // Default a new member to NEXT month, so joining mid-cycle never produces a
  // retroactive or prorated charge. (docs/PLANNING.md)
  const duesStart =
    typeof body.duesStartPeriod === "string" && /^\d{4}-\d{2}$/.test(body.duesStartPeriod)
      ? body.duesStartPeriod
      : addMonths(periodOfDate(today), 1);

  const id = crypto.randomUUID();
  await insertMember(db, {
    id,
    display_name: requireString(body.displayName, "displayName"),
    first_name: (body.firstName as string) ?? null,
    last_name: (body.lastName as string) ?? null,
    nickname: (body.nickname as string) ?? null,
    email: (body.email as string) ?? null,
    phone: (body.phone as string) ?? null,
    status: status as never,
    dues_start_period: duesStart,
    joined_on: (body.joinedOn as string) ?? today,
    notes: (body.notes as string) ?? null,
    archived_at: null,
  });

  // Optional opening balance for a member entered with existing history.
  const openingCents =
    body.openingBalance == null ? null : parseAmountToCents(body.openingBalance as string);
  if (openingCents) {
    const owes = body.openingBalanceOwes !== false;
    await insertTransaction(db, {
      id: crypto.randomUUID(),
      member_id: id,
      kind: "opening_balance",
      direction: owes ? "debit" : "credit",
      amount_cents: openingCents,
      occurred_on: today,
      memo: "Opening balance",
    });
  }

  await writeAudit(db, {
    id: crypto.randomUUID(),
    actor_email: c.var.actorEmail,
    action: "create",
    entity: "member",
    entity_id: id,
    after: { displayName: body.displayName, status, duesStart },
  });

  const created = await getMemberWithBalance(db, id);
  const currentPeriod = periodOfDate(today);
  return c.json({ member: toRosterEntry(created!, settings, currentPeriod) }, 201);
});

api.get("/members/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const settings = await loadSettings(db);
  const currentPeriod = currentPeriodFor(settings);

  const member = await getMemberWithBalance(db, id);
  if (!member) return c.json({ error: "Member not found" }, 404);

  const ledger = withRunningBalance(await listTransactionsForMember(db, id));

  return c.json({
    member: toRosterEntry(member, settings, currentPeriod),
    // Newest first for display; the running balance was computed oldest-first.
    ledger: ledger.slice().reverse(),
  });
});

api.patch("/members/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const before = await getMemberRaw(db, id);
  if (!before) return c.json({ error: "Member not found" }, 404);

  const body = await c.req.json<Record<string, unknown>>();
  const patch: Record<string, unknown> = {};
  const map: Record<string, string> = {
    displayName: "display_name",
    firstName: "first_name",
    lastName: "last_name",
    nickname: "nickname",
    email: "email",
    phone: "phone",
    status: "status",
    duesStartPeriod: "dues_start_period",
    joinedOn: "joined_on",
    notes: "notes",
  };
  for (const [from, to] of Object.entries(map)) {
    if (from in body) patch[to] = body[from];
  }

  await updateMember(db, id, patch);
  await writeAudit(db, {
    id: crypto.randomUUID(),
    actor_email: c.var.actorEmail,
    action: "update",
    entity: "member",
    entity_id: id,
    before,
    after: patch,
  });

  const settings = await loadSettings(db);
  const updated = await getMemberWithBalance(db, id);
  return c.json({ member: toRosterEntry(updated!, settings, currentPeriodFor(settings)) });
});

api.post("/members/:id/archive", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const body = await c.req
    .json<{ archived?: boolean }>()
    .catch((): { archived?: boolean } => ({}));
  const archive = body.archived !== false;

  await updateMember(db, id, {
    archived_at: archive ? new Date().toISOString() : null,
  });
  await writeAudit(db, {
    id: crypto.randomUUID(),
    actor_email: c.var.actorEmail,
    action: archive ? "archive" : "unarchive",
    entity: "member",
    entity_id: id,
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

api.post("/transactions", async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<Record<string, unknown>>();
  const settings = await loadSettings(db);
  const today = todayInTz(settings.clubTimezone);

  const memberId = requireString(body.memberId, "memberId");
  const member = await getMemberRaw(db, memberId);
  if (!member) return c.json({ error: "Member not found" }, 404);

  const kind = requireString(body.kind, "kind") as TransactionKind;
  if (!KINDS.includes(kind)) throw new BadRequest(`Unknown kind: ${kind}`);

  // Amount may arrive as dollars or as a number of months; either way it is
  // rounded to whole dollars exactly once, here.
  const months =
    body.months == null ? null : Math.max(1, Math.round(Number(body.months)));
  const amountCents =
    months !== null
      ? months * settings.monthlyDuesCents
      : parseAmountToCents(body.amount as string);

  if (!amountCents || amountCents <= 0) throw new BadRequest("A positive amount is required");

  const direction = directionFor(kind, body.direction as Direction | undefined);

  const method =
    kind === "payment" && typeof body.method === "string" && METHODS.includes(body.method as PaymentMethod)
      ? (body.method as PaymentMethod)
      : null;

  const occurredOn =
    typeof body.occurredOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.occurredOn)
      ? body.occurredOn
      : today;

  // Only dues charges carry a period, and the schema enforces it.
  const period: Period | null =
    kind === "dues_charge"
      ? typeof body.period === "string" && /^\d{4}-\d{2}$/.test(body.period)
        ? body.period
        : periodOfDate(occurredOn)
      : null;

  const id = crypto.randomUUID();
  await insertTransaction(db, {
    id,
    member_id: memberId,
    kind,
    direction,
    amount_cents: amountCents,
    occurred_on: occurredOn,
    period,
    method,
    memo: typeof body.memo === "string" ? body.memo : null,
    entered_as_months: months,
  });

  await writeAudit(db, {
    id: crypto.randomUUID(),
    actor_email: c.var.actorEmail,
    action: "create",
    entity: "transaction",
    entity_id: id,
    after: { memberId, kind, amountCents, occurredOn, method },
  });

  // Return the member's NEW standing so the UI can confirm on the spot --
  // "Dave is now good for 4 more months, next due December" -- without the
  // treasurer navigating anywhere.
  const updated = await getMemberWithBalance(db, memberId);
  return c.json(
    {
      transactionId: id,
      member: toRosterEntry(updated!, settings, periodOfDate(today)),
    },
    201,
  );
});

api.patch("/transactions/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const before = await getTransaction(db, id);
  if (!before) return c.json({ error: "Transaction not found" }, 404);

  const body = await c.req.json<Record<string, unknown>>();
  const settings = await loadSettings(db);

  const amountCents =
    body.amount == null ? before.amount_cents : parseAmountToCents(body.amount as string);
  if (!amountCents || amountCents <= 0) throw new BadRequest("A positive amount is required");

  const occurredOn =
    typeof body.occurredOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.occurredOn)
      ? body.occurredOn
      : before.occurred_on;

  const method =
    before.kind === "payment"
      ? typeof body.method === "string" && METHODS.includes(body.method as PaymentMethod)
        ? body.method
        : before.method
      : null;

  await db
    .prepare(
      `UPDATE transactions SET amount_cents = ?, occurred_on = ?, method = ?, memo = ?
       WHERE id = ?`,
    )
    .bind(
      amountCents,
      occurredOn,
      method,
      typeof body.memo === "string" ? body.memo : before.memo,
      id,
    )
    .run();

  await writeAudit(db, {
    id: crypto.randomUUID(),
    actor_email: c.var.actorEmail,
    action: "update",
    entity: "transaction",
    entity_id: id,
    before,
    after: { amountCents, occurredOn, method, memo: body.memo },
  });

  const updated = await getMemberWithBalance(db, before.member_id);
  return c.json({ member: toRosterEntry(updated!, settings, currentPeriodFor(settings)) });
});

/**
 * Void — used to waive a month's dues. Distinct from delete: a voided dues
 * charge stops counting toward the balance AND is not re-posted by catch-up,
 * whereas a deleted one looks missing and comes back on the next run.
 */
api.post("/transactions/:id/void", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const before = await getTransaction(db, id);
  if (!before) return c.json({ error: "Transaction not found" }, 404);

  const body = await c.req.json<{ reason?: string }>().catch((): { reason?: string } => ({}));
  const reason = body.reason?.trim() || "Waived";

  await voidTransaction(db, id, reason);
  await writeAudit(db, {
    id: crypto.randomUUID(),
    actor_email: c.var.actorEmail,
    action: "void",
    entity: "transaction",
    entity_id: id,
    before,
    after: { reason },
  });

  const settings = await loadSettings(db);
  const updated = await getMemberWithBalance(db, before.member_id);
  return c.json({ member: toRosterEntry(updated!, settings, currentPeriodFor(settings)) });
});

api.delete("/transactions/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const before = await getTransaction(db, id);
  if (!before) return c.json({ error: "Transaction not found" }, 404);

  await deleteTransaction(db, id);
  await writeAudit(db, {
    id: crypto.randomUUID(),
    actor_email: c.var.actorEmail,
    action: "delete",
    entity: "transaction",
    entity_id: id,
    before,
  });

  const settings = await loadSettings(db);
  const updated = await getMemberWithBalance(db, before.member_id);
  return c.json({ member: toRosterEntry(updated!, settings, currentPeriodFor(settings)) });
});

/** Club-wide ledger, newest first, with optional filters. */
api.get("/transactions", async (c) => {
  const db = c.env.DB;
  const memberId = c.req.query("memberId");
  const kind = c.req.query("kind");
  const from = c.req.query("from");
  const to = c.req.query("to");

  const where: string[] = [];
  const binds: unknown[] = [];
  if (memberId) { where.push("t.member_id = ?"); binds.push(memberId); }
  if (kind) { where.push("t.kind = ?"); binds.push(kind); }
  if (from) { where.push("t.occurred_on >= ?"); binds.push(from); }
  if (to) { where.push("t.occurred_on <= ?"); binds.push(to); }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { results } = await db
    .prepare(
      `SELECT t.*, m.display_name AS member_name
       FROM transactions t JOIN members m ON m.id = t.member_id
       ${clause}
       ORDER BY t.occurred_on DESC, t.created_at DESC
       LIMIT 1000`,
    )
    .bind(...binds)
    .all();

  return c.json({ transactions: results });
});

// ---------------------------------------------------------------------------
// Dues posting
// ---------------------------------------------------------------------------

api.post("/dues/post", async (c) => {
  const result = await runDuesPosting(c.env.DB, {
    triggeredBy: "manual",
    actorEmail: c.var.actorEmail,
  });
  return c.json(result);
});

api.get("/dues/status", async (c) => {
  return c.json(await findUnpostedPeriods(c.env.DB));
});

// ---------------------------------------------------------------------------
// Reports and export
// ---------------------------------------------------------------------------

api.get("/reports/delinquency", async (c) => {
  const db = c.env.DB;
  const settings = await loadSettings(db);
  const currentPeriod = currentPeriodFor(settings);
  const entries = (await listMembersWithBalances(db)).map((m) =>
    toRosterEntry(m, settings, currentPeriod),
  );

  return c.json({
    clubName: settings.clubName,
    generatedOn: todayInTz(settings.clubTimezone),
    badStanding: inBadStanding(entries),
    warning: inWarning(entries),
    totalOwedCents: entries
      .filter((e) => e.balanceCents > 0)
      .reduce((s, e) => s + e.balanceCents, 0),
  });
});

api.get("/export/transactions.csv", async (c) => {
  const db = c.env.DB;
  const { results } = await db
    .prepare(
      `SELECT t.*, m.display_name AS member_name
       FROM transactions t JOIN members m ON m.id = t.member_id
       ORDER BY t.occurred_on, t.created_at`,
    )
    .all();

  const settings = await loadSettings(db);
  const filename = `dues-transactions-${todayInTz(settings.clubTimezone)}.csv`;

  return new Response(transactionsCsv(results as never[]), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

/** On-demand snapshot — the same bundle the weekly cron writes to R2. */
api.get("/backup/download", async (c) => {
  const { json, date } = await buildBackup(c.env);
  return new Response(json, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="dues-tracker-backup-${date}.json"`,
    },
  });
});

api.post("/backup/run", async (c) => {
  const result = await runWeeklyBackup(c.env);
  await writeAudit(c.env.DB, {
    id: crypto.randomUUID(),
    actor_email: c.var.actorEmail,
    action: "backup",
    entity: "backup",
    entity_id: result.key,
    after: result,
  });
  return c.json(result);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

api.get("/settings", async (c) => {
  const [settings, statuses] = await Promise.all([
    loadSettings(c.env.DB),
    listStatuses(c.env.DB),
  ]);
  return c.json({ settings, statuses });
});

api.put("/settings", async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<Record<string, unknown>>();
  const updates: Record<string, string> = {};

  const numeric: Record<string, string> = {
    monthlyDuesCents: "monthly_dues_cents",
    warnThresholdCents: "warn_threshold_cents",
    badStandingThresholdCents: "bad_standing_threshold_cents",
  };
  for (const [from, to] of Object.entries(numeric)) {
    if (from in body) {
      const n = Number(body[from]);
      if (!Number.isFinite(n) || n < 0) throw new BadRequest(`${from} must be a positive number`);
      // Thresholds are money, so they obey the same whole-dollar rule.
      updates[to] = String(Math.round(n / 100) * 100);
    }
  }
  if (typeof body.clubTimezone === "string") updates.club_timezone = body.clubTimezone;
  if (typeof body.clubName === "string") updates.club_name = body.clubName;

  await updateSettings(db, updates);

  if (Array.isArray(body.statuses)) {
    const statements = (body.statuses as { code: string; accruesDues: boolean }[]).map((s) =>
      db
        .prepare("UPDATE statuses SET accrues_dues = ? WHERE code = ?")
        .bind(s.accruesDues ? 1 : 0, s.code),
    );
    if (statements.length) await db.batch(statements);
  }

  await writeAudit(db, {
    id: crypto.randomUUID(),
    actor_email: c.var.actorEmail,
    action: "update",
    entity: "settings",
    entity_id: null,
    after: updates,
  });

  return c.json({ settings: await loadSettings(db) });
});
