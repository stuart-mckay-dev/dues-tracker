/**
 * Typed D1 access.
 *
 * Balances are computed by aggregate on every read — there is deliberately no
 * cached balance column. A stored balance must be updated in lockstep with
 * every insert, edit, void, and delete, and the first path that misses makes
 * the roster silently lie about who owes money. At club scale the aggregate is
 * instantaneous. (docs/DECISIONS.md D4)
 */

import type {
  ClubSettings,
  Direction,
  LedgerEntry,
  MemberRow,
  MemberWithBalance,
  StatusRow,
  TransactionKind,
  TransactionRow,
} from "../types";
import type { DateStr, Period } from "./period";

/** `direction` follows from `kind`; opening balances are the one free choice. */
export function directionFor(kind: TransactionKind, explicit?: Direction): Direction {
  switch (kind) {
    case "dues_charge":
    case "misc_debit":
      return "debit";
    case "payment":
    case "reimbursement_credit":
      return "credit";
    case "opening_balance":
      return explicit ?? "debit";
  }
}

export function signedAmount(direction: Direction, amountCents: number): number {
  return direction === "debit" ? amountCents : -amountCents;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SETTING_DEFAULTS: ClubSettings = {
  monthlyDuesCents: 2500, // placeholder; the real rate is set in Settings
  warnThresholdCents: 15000, // 6 months at the placeholder rate
  badStandingThresholdCents: 45000, // 18 months at the placeholder rate
  clubTimezone: "America/Los_Angeles",
  clubName: "",
};

export async function loadSettings(db: D1Database): Promise<ClubSettings> {
  const { results } = await db
    .prepare("SELECT key, value FROM settings")
    .all<{ key: string; value: string }>();

  const map = new Map(results.map((r) => [r.key, r.value]));
  const int = (key: string, fallback: number) => {
    const raw = map.get(key);
    const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    monthlyDuesCents: int("monthly_dues_cents", SETTING_DEFAULTS.monthlyDuesCents),
    warnThresholdCents: int("warn_threshold_cents", SETTING_DEFAULTS.warnThresholdCents),
    badStandingThresholdCents: int(
      "bad_standing_threshold_cents",
      SETTING_DEFAULTS.badStandingThresholdCents,
    ),
    clubTimezone: map.get("club_timezone") || SETTING_DEFAULTS.clubTimezone,
    clubName: map.get("club_name") ?? SETTING_DEFAULTS.clubName,
  };
}

export async function updateSettings(
  db: D1Database,
  updates: Record<string, string>,
): Promise<void> {
  const statements = Object.entries(updates).map(([key, value]) =>
    db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, value),
  );
  if (statements.length > 0) await db.batch(statements);
}

export async function listStatuses(db: D1Database): Promise<StatusRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM statuses ORDER BY sort_order")
    .all<StatusRow>();
  return results;
}

// ---------------------------------------------------------------------------
// Members + balances
// ---------------------------------------------------------------------------

/**
 * The single query behind the roster, the dashboard, and every report.
 *
 * One pass gives each member their status, their balance, and the latest
 * period they were charged for — which is exactly the input `computeStanding`
 * needs, so no screen has to issue per-member follow-up queries.
 */
const MEMBER_BALANCE_SQL = `
  SELECT
    m.*,
    s.label        AS status_label,
    s.accrues_dues AS accrues_dues,
    COALESCE(SUM(CASE WHEN t.direction = 'debit' THEN t.amount_cents
                      ELSE -t.amount_cents END), 0) AS balance_cents,
    MAX(CASE WHEN t.kind = 'dues_charge' THEN t.period END) AS last_posted_period
  FROM members m
  JOIN statuses s ON s.code = m.status
  LEFT JOIN transactions t
    ON t.member_id = m.id AND t.voided_at IS NULL
`;

export async function listMembersWithBalances(
  db: D1Database,
  opts: { includeArchived?: boolean } = {},
): Promise<MemberWithBalance[]> {
  const where = opts.includeArchived ? "" : "WHERE m.archived_at IS NULL";
  const { results } = await db
    .prepare(`${MEMBER_BALANCE_SQL} ${where} GROUP BY m.id ORDER BY m.display_name COLLATE NOCASE`)
    .all<MemberWithBalance>();
  return results;
}

export async function getMemberWithBalance(
  db: D1Database,
  memberId: string,
): Promise<MemberWithBalance | null> {
  return db
    .prepare(`${MEMBER_BALANCE_SQL} WHERE m.id = ? GROUP BY m.id`)
    .bind(memberId)
    .first<MemberWithBalance>();
}

export async function insertMember(
  db: D1Database,
  member: Omit<MemberRow, "created_at" | "updated_at">,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO members
         (id, display_name, first_name, last_name, nickname, email, phone,
          status, dues_start_period, joined_on, notes, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      member.id,
      member.display_name,
      member.first_name,
      member.last_name,
      member.nickname,
      member.email,
      member.phone,
      member.status,
      member.dues_start_period,
      member.joined_on,
      member.notes,
      member.archived_at,
    )
    .run();
}

const MEMBER_UPDATABLE = [
  "display_name",
  "first_name",
  "last_name",
  "nickname",
  "email",
  "phone",
  "status",
  "dues_start_period",
  "joined_on",
  "notes",
  "archived_at",
] as const;

export async function updateMember(
  db: D1Database,
  memberId: string,
  patch: Partial<MemberRow>,
): Promise<void> {
  const entries = MEMBER_UPDATABLE.filter((k) => k in patch).map(
    (k) => [k, patch[k] ?? null] as const,
  );
  if (entries.length === 0) return;

  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  await db
    .prepare(`UPDATE members SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...entries.map(([, v]) => v), memberId)
    .run();
}

export async function getMemberRaw(
  db: D1Database,
  memberId: string,
): Promise<MemberRow | null> {
  return db.prepare("SELECT * FROM members WHERE id = ?").bind(memberId).first<MemberRow>();
}

/** Earliest dues start across the roster — the left edge for gap detection. */
export async function earliestDuesStart(db: D1Database): Promise<Period | null> {
  const row = await db
    .prepare(
      `SELECT MIN(m.dues_start_period) AS p
       FROM members m JOIN statuses s ON s.code = m.status
       WHERE m.archived_at IS NULL AND s.accrues_dues = 1`,
    )
    .first<{ p: Period | null }>();
  return row?.p ?? null;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export async function listTransactionsForMember(
  db: D1Database,
  memberId: string,
): Promise<TransactionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM transactions WHERE member_id = ?
       ORDER BY occurred_on, created_at, id`,
    )
    .bind(memberId)
    .all<TransactionRow>();
  return results;
}

/**
 * Attach a running balance to each row, oldest first — the Balance column of
 * the two-column ledger. Voided rows are shown (struck through) but do not
 * move the running total, so a corrected entry stays visible without
 * distorting history.
 */
export function withRunningBalance(rows: TransactionRow[]): LedgerEntry[] {
  let running = 0;
  return rows.map((row) => {
    if (!row.voided_at) running += signedAmount(row.direction, row.amount_cents);
    return { ...row, running_balance_cents: running };
  });
}

export async function getTransaction(
  db: D1Database,
  id: string,
): Promise<TransactionRow | null> {
  return db.prepare("SELECT * FROM transactions WHERE id = ?").bind(id).first<TransactionRow>();
}

export interface NewTransaction {
  id: string;
  member_id: string;
  kind: TransactionKind;
  direction: Direction;
  amount_cents: number;
  occurred_on: DateStr;
  period?: Period | null;
  method?: string | null;
  memo?: string | null;
  entered_as_months?: number | null;
}

export function insertTransactionStatement(
  db: D1Database,
  tx: NewTransaction,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO transactions
         (id, member_id, kind, direction, amount_cents, occurred_on,
          period, method, memo, entered_as_months)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      tx.id,
      tx.member_id,
      tx.kind,
      tx.direction,
      tx.amount_cents,
      tx.occurred_on,
      tx.period ?? null,
      tx.method ?? null,
      tx.memo ?? null,
      tx.entered_as_months ?? null,
    );
}

export async function insertTransaction(
  db: D1Database,
  tx: NewTransaction,
): Promise<void> {
  await insertTransactionStatement(db, tx).run();
}

export async function deleteTransaction(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM transactions WHERE id = ?").bind(id).run();
}

export async function voidTransaction(
  db: D1Database,
  id: string,
  reason: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE transactions SET voided_at = datetime('now'), void_reason = ? WHERE id = ?",
    )
    .bind(reason, id)
    .run();
}

/**
 * Dues periods a member has already been charged for — the catch-up input.
 *
 * Deliberately INCLUDES voided charges, which is what gives void and delete
 * distinct meanings:
 *
 *   void   = "this month is waived" — the charge stops counting toward the
 *            balance, and catch-up will not bring it back.
 *   delete = "this never happened" — the period looks missing again, so the
 *            next run re-posts it. That is what repairs a bad import or a
 *            mistakenly removed row.
 *
 * Without this, a waived month would silently reappear on the next cron and
 * the treasurer would have no way to forgive a charge at all.
 */
export async function duesPeriodsByMember(
  db: D1Database,
): Promise<Map<string, Period[]>> {
  const { results } = await db
    .prepare(`SELECT member_id, period FROM transactions WHERE kind = 'dues_charge'`)
    .all<{ member_id: string; period: Period }>();

  const map = new Map<string, Period[]>();
  for (const row of results) {
    const list = map.get(row.member_id);
    if (list) list.push(row.period);
    else map.set(row.member_id, [row.period]);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Posting runs + audit
// ---------------------------------------------------------------------------

export async function listPostedPeriods(db: D1Database): Promise<Period[]> {
  const { results } = await db
    .prepare("SELECT DISTINCT period FROM posting_runs ORDER BY period")
    .all<{ period: Period }>();
  return results.map((r) => r.period);
}

export function recordPostingRunStatement(
  db: D1Database,
  run: {
    id: string;
    period: Period;
    posting_date: DateStr;
    member_count: number;
    total_cents: number;
    triggered_by: "cron" | "manual";
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO posting_runs
         (id, period, posting_date, member_count, total_cents, triggered_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      run.id,
      run.period,
      run.posting_date,
      run.member_count,
      run.total_cents,
      run.triggered_by,
    );
}

export function auditStatement(
  db: D1Database,
  entry: {
    id: string;
    actor_email: string | null;
    action: string;
    entity: string;
    entity_id: string | null;
    before?: unknown;
    after?: unknown;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (id, actor_email, action, entity, entity_id, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      entry.id,
      entry.actor_email,
      entry.action,
      entry.entity,
      entry.entity_id,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
    );
}

export async function writeAudit(
  db: D1Database,
  entry: Parameters<typeof auditStatement>[1],
): Promise<void> {
  await auditStatement(db, entry).run();
}
