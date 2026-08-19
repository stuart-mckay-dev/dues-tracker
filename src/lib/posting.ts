/**
 * The dues-posting job.
 *
 * Thin: all the rules live in the pure functions in accrual.ts. This file's
 * only job is to read the current state, ask the planner what is missing, and
 * write it.
 *
 * Safe to run at any frequency. Every insert is `ON CONFLICT DO NOTHING`
 * against the partial unique index `ux_dues_once`, so duplicates are
 * impossible at the storage layer rather than merely avoided by careful code.
 * That is what lets the job be a naive "post everything missing" loop, and
 * what makes catch-up self-healing after a missed cron.
 * (docs/DECISIONS.md D5)
 */

import {
  latestPostablePeriod,
  planCatchUp,
  postingDateFor,
  unpostedPeriods,
} from "./accrual";
import {
  auditStatement,
  duesPeriodsByMember,
  earliestDuesStart,
  insertTransactionStatement,
  listMembersWithBalances,
  listPostedPeriods,
  loadSettings,
  recordPostingRunStatement,
} from "./db";
import { todayInTz, type DateStr, type Period } from "./period";

export interface PostingResult {
  today: DateStr;
  latestPostable: Period;
  /** Periods that gained at least one charge on this run. */
  periodsPosted: Period[];
  chargesCreated: number;
  totalCents: number;
  membersCharged: number;
}

export async function runDuesPosting(
  db: D1Database,
  opts: {
    triggeredBy: "cron" | "manual";
    actorEmail?: string | null;
    /** Override for tests; otherwise derived from the club timezone. */
    today?: DateStr;
  },
): Promise<PostingResult> {
  const settings = await loadSettings(db);
  const today = opts.today ?? todayInTz(settings.clubTimezone);
  const latestPostable = latestPostablePeriod(today);

  const [members, existingByMember] = await Promise.all([
    listMembersWithBalances(db),
    duesPeriodsByMember(db),
  ]);

  const eligible = members.filter((m) => m.accrues_dues === 1);

  const statements: D1PreparedStatement[] = [];
  const perPeriod = new Map<string, { members: number; cents: number }>();
  let chargesCreated = 0;
  const chargedMembers = new Set<string>();

  for (const member of eligible) {
    const missing = planCatchUp({
      duesStartPeriod: member.dues_start_period,
      latestPostable,
      existingPeriods: existingByMember.get(member.id) ?? [],
    });

    for (const period of missing) {
      statements.push(
        insertTransactionStatement(db, {
          id: crypto.randomUUID(),
          member_id: member.id,
          kind: "dues_charge",
          direction: "debit",
          amount_cents: settings.monthlyDuesCents,
          // Dated the meeting day, not today, so a catch-up run posting
          // twenty months of history lands each charge on the meeting it
          // belongs to and the ledger reads chronologically.
          occurred_on: postingDateFor(period),
          period,
          memo: "Monthly dues",
        }),
      );

      const bucket = perPeriod.get(period) ?? { members: 0, cents: 0 };
      bucket.members += 1;
      bucket.cents += settings.monthlyDuesCents;
      perPeriod.set(period, bucket);

      chargesCreated += 1;
      chargedMembers.add(member.id);
    }
  }

  const periodsPosted = [...perPeriod.keys()].sort();

  for (const period of periodsPosted) {
    const bucket = perPeriod.get(period)!;
    statements.push(
      recordPostingRunStatement(db, {
        id: crypto.randomUUID(),
        period,
        posting_date: postingDateFor(period),
        member_count: bucket.members,
        total_cents: bucket.cents,
        triggered_by: opts.triggeredBy,
      }),
    );
  }

  if (statements.length > 0) {
    statements.push(
      auditStatement(db, {
        id: crypto.randomUUID(),
        actor_email: opts.actorEmail ?? null,
        action: "post_dues",
        entity: "posting_run",
        entity_id: null,
        after: { today, latestPostable, periodsPosted, chargesCreated },
      }),
    );
    await db.batch(statements);
  }

  return {
    today,
    latestPostable,
    periodsPosted,
    chargesCreated,
    totalCents: chargesCreated * settings.monthlyDuesCents,
    membersCharged: chargedMembers.size,
  };
}

/**
 * Periods that are due but have never been posted — the dashboard banner.
 *
 * An accrual job that silently stops running produces a roster where everyone
 * looks current, which is the failure mode most likely to go unnoticed. It has
 * to be visible on the screen the treasurer opens first.
 */
export async function findUnpostedPeriods(
  db: D1Database,
  today?: DateStr,
): Promise<{ today: DateStr; latestPostable: Period; unposted: Period[] }> {
  const settings = await loadSettings(db);
  const resolvedToday = today ?? todayInTz(settings.clubTimezone);
  const latestPostable = latestPostablePeriod(resolvedToday);

  const [postedPeriods, start] = await Promise.all([
    listPostedPeriods(db),
    earliestDuesStart(db),
  ]);

  return {
    today: resolvedToday,
    latestPostable,
    unposted: unpostedPeriods({
      latestPostable,
      postedPeriods,
      earliestDuesStart: start,
    }),
  };
}
