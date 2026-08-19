/**
 * When dues post, and which periods a member is missing.
 *
 * Everything in this file is pure — no database, no clock. The caller passes
 * in "today" and the periods already on record. That is what lets the posting
 * rule be tested across every calendar shape without freezing time.
 *
 * See docs/ACCRUAL-RULES.md.
 */

import {
  addMonths,
  comparePeriods,
  maxPeriod,
  monthsBetween,
  periodOfDate,
  periodRange,
  weekdayOfFirst,
  type DateStr,
  type Period,
} from "./period";

const SATURDAY = 6;

/**
 * Day-of-month of the first Saturday. Always 1..7.
 */
export function firstSaturdayOf(period: Period): number {
  const dow = weekdayOfFirst(period);
  const daysUntilSaturday = (SATURDAY - dow + 7) % 7;
  return 1 + daysUntilSaturday;
}

/**
 * The date dues post: the first Thursday AFTER the first Saturday.
 *
 * Meetings fall on the Thursday after the first Saturday. Saturday to
 * Thursday is exactly five days, so no weekday searching is needed and the
 * result always lands between the 6th and the 12th.
 *
 * Note this is NOT "the first Thursday of the month". When the 1st falls on a
 * Thursday the answer is the 8th, not the 1st — that Thursday comes before the
 * first Saturday, so it is not the meeting.
 */
export function postingDateFor(period: Period): DateStr {
  const day = firstSaturdayOf(period) + 5;
  return `${period}-${String(day).padStart(2, "0")}`;
}

/** Has this period's meeting date arrived, as of `today` in club time? */
export function hasPostingPassed(period: Period, today: DateStr): boolean {
  return today >= postingDateFor(period);
}

/**
 * The most recent period it is legitimate to charge for.
 *
 * This is the guard that stops dues being charged for a month whose meeting
 * has not happened yet: on August 3rd the answer is still July.
 */
export function latestPostablePeriod(today: DateStr): Period {
  const current = periodOfDate(today);
  return hasPostingPassed(current, today) ? current : addMonths(current, -1);
}

/**
 * Which periods still need a dues charge for one member.
 *
 * Deliberately a plain set difference over the whole eligible range rather
 * than "just post this month". Combined with the unique index in the schema,
 * that makes the job self-healing: a missed cron, an outage, or a member
 * entered with a backdated start date all resolve on the next run, and running
 * it twice changes nothing.
 */
export function planCatchUp(args: {
  duesStartPeriod: Period;
  latestPostable: Period;
  existingPeriods: readonly Period[];
}): Period[] {
  const { duesStartPeriod, latestPostable, existingPeriods } = args;
  if (comparePeriods(duesStartPeriod, latestPostable) > 0) return [];

  const already = new Set(existingPeriods);
  return periodRange(duesStartPeriod, latestPostable).filter(
    (p) => !already.has(p),
  );
}

/**
 * Periods that are due but not yet posted for anyone — drives the dashboard
 * banner. An accrual job that silently stops running produces a roster where
 * everyone looks current, so the absence of postings has to be visible.
 */
export function unpostedPeriods(args: {
  latestPostable: Period;
  postedPeriods: readonly Period[];
  earliestDuesStart: Period | null;
}): Period[] {
  const { latestPostable, postedPeriods, earliestDuesStart } = args;
  if (!earliestDuesStart) return [];

  const posted = new Set(postedPeriods);
  // Look back at most a year; older gaps are history, not an alert.
  const from = maxPeriod(earliestDuesStart, addMonths(latestPostable, -11));
  return periodRange(from, latestPostable).filter((p) => !posted.has(p));
}

/** Convenience for the dashboard: the next meeting/posting date from today. */
export function nextPostingDate(today: DateStr): DateStr {
  const current = periodOfDate(today);
  const thisMonth = postingDateFor(current);
  return today <= thisMonth ? thisMonth : postingDateFor(addMonths(current, 1));
}

export { monthsBetween };
