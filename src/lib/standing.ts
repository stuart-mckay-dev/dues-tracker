/**
 * "How many months am I still good for?"
 *
 * The question members actually ask at meetings, answered as a first-class
 * computed value rather than arithmetic done in the treasurer's head from a
 * dollar figure.
 *
 * Pure — no database, no clock. See docs/ACCRUAL-RULES.md part 2.
 */

import { formatDollars } from "./money";
import {
  addMonths,
  formatPeriodLong,
  maxPeriod,
  monthsBetween,
  type Period,
} from "./period";

export type StandingFlag = "bad_standing" | "warning" | "ok";

export interface StandingInput {
  /** Signed: positive = member owes the club, negative = paid ahead. */
  balanceCents: number;
  duesCents: number;
  /** Latest period with a live dues charge; null if never charged. */
  lastPostedPeriod: Period | null;
  duesStartPeriod: Period;
  currentPeriod: Period;
  accruesDues: boolean;
  warnThresholdCents: number;
  badStandingThresholdCents: number;
}

interface StandingBase {
  balanceCents: number;
  flag: StandingFlag;
  accruing: boolean;
  /** The sentence to show the member. */
  summary: string;
}

export type Standing =
  | (StandingBase & {
      state: "behind";
      monthsBehind: number;
      remainderCents: number;
    })
  | (StandingBase & {
      state: "current";
      creditCents: number;
      coveredThrough: Period;
      monthsRemaining: number;
      nextDue: Period;
      leftoverCents: number;
    })
  | (StandingBase & { state: "exempt"; monthsBehind: number });

/**
 * Flags are evaluated on dollars, never months, so they stay correct when a
 * reimbursement or misc debit moves a balance off an exact multiple of dues.
 * Thresholds are inclusive: a balance of exactly the bad-standing threshold is bad standing.
 *
 * Status is deliberately not consulted. The flag describes money owed, not
 * participation — a member who ran up 20 months of debt and was then moved to
 * Lifetime still owes it. (docs/DECISIONS.md D10)
 */
export function flagFor(
  balanceCents: number,
  warnThresholdCents: number,
  badStandingThresholdCents: number,
): StandingFlag {
  if (balanceCents >= badStandingThresholdCents) return "bad_standing";
  if (balanceCents >= warnThresholdCents) return "warning";
  return "ok";
}

export function computeStanding(input: StandingInput): Standing {
  const {
    balanceCents,
    duesCents,
    lastPostedPeriod,
    duesStartPeriod,
    currentPeriod,
    accruesDues,
    warnThresholdCents,
    badStandingThresholdCents,
  } = input;

  const flag = flagFor(
    balanceCents,
    warnThresholdCents,
    badStandingThresholdCents,
  );

  // --- Non-accruing (Lifetime / Inactive) --------------------------------
  // No future dues, so months-remaining is meaningless. An outstanding
  // balance still shows, because the debt survives the status change.
  if (!accruesDues) {
    const monthsBehind =
      balanceCents > 0 ? Math.floor(balanceCents / duesCents) : 0;
    return {
      state: "exempt",
      balanceCents,
      flag,
      accruing: false,
      monthsBehind,
      summary:
        balanceCents > 0
          ? `Owes ${formatDollars(balanceCents)} · exempt from future dues`
          : "Exempt — no dues accruing",
    };
  }

  // --- Behind ------------------------------------------------------------
  // floor(), not ceil(), with the remainder shown separately — symmetric with
  // the prepaid side. A balance of 18 months plus a few dollars reads "18 months behind · $5", not
  // "19 months behind", which would overstate a debt nudged off a round
  // number by a misc debit.
  if (balanceCents > 0) {
    const monthsBehind = Math.floor(balanceCents / duesCents);
    const remainderCents = balanceCents % duesCents;
    const parts = [`Owes ${formatDollars(balanceCents)}`];
    if (monthsBehind > 0) {
      parts.push(`${monthsBehind} month${monthsBehind === 1 ? "" : "s"} behind`);
    }
    if (remainderCents > 0 && monthsBehind > 0) {
      parts.push(`${formatDollars(remainderCents)} over`);
    }
    return {
      state: "behind",
      balanceCents,
      flag,
      accruing: true,
      monthsBehind,
      remainderCents,
      summary: parts.join(" · "),
    };
  }

  // --- Square or paid ahead ----------------------------------------------
  // Math.abs, not negation: balanceCents is <= 0 here, and `-0` would leak
  // out into JSON and comparisons.
  const creditCents = Math.abs(balanceCents);
  const monthsOfCredit = Math.floor(creditCents / duesCents);
  const leftoverCents = creditCents % duesCents;

  // Anchor on the member's last dues charge, NOT on the calendar. When the
  // posting job runs it advances lastPosted by one month and consumes one
  // month of credit; the two cancel exactly, so the answer does not jump on
  // the meeting date. Anchoring on currentPeriod would make a member asking
  // on the 5th and the 7th get different answers. (docs/DECISIONS.md D8)
  //
  // Never charged yet: fall back to the month before their dues start, so a
  // member who prepays before their first charge still reads correctly.
  const anchor = lastPostedPeriod ?? addMonths(duesStartPeriod, -1);
  const coveredThrough = addMonths(anchor, monthsOfCredit);

  // Inclusive of the current month: a member asking "am I good?" wants to
  // know whether they owe anything today, and this month is covered.
  // (docs/DECISIONS.md D7)
  const monthsRemaining = Math.max(
    0,
    monthsBetween(currentPeriod, coveredThrough) + 1,
  );

  // Clamp forward: if the posting job has not run for months, coveredThrough
  // can sit in the past. Reporting a due date that has already gone by would
  // be nonsense, so the answer becomes "due now" and the dashboard's unposted
  // banner explains why.
  const nextDue = maxPeriod(addMonths(coveredThrough, 1), currentPeriod);

  const summary = buildCurrentSummary({
    creditCents,
    monthsRemaining,
    nextDue,
    leftoverCents,
  });

  return {
    state: "current",
    balanceCents,
    flag,
    accruing: true,
    creditCents,
    coveredThrough,
    monthsRemaining,
    nextDue,
    leftoverCents,
    summary,
  };
}

function buildCurrentSummary(args: {
  creditCents: number;
  monthsRemaining: number;
  nextDue: Period;
  leftoverCents: number;
}): string {
  const { creditCents, monthsRemaining, nextDue, leftoverCents } = args;

  if (monthsRemaining === 0) {
    return `Due now · payment due ${formatPeriodLong(nextDue)}`;
  }

  const head =
    creditCents > 0 ? `Paid ahead ${formatDollars(creditCents)}` : "Square";

  const parts = [
    head,
    `good for ${monthsRemaining} more month${monthsRemaining === 1 ? "" : "s"}`,
    `next payment due ${formatPeriodLong(nextDue)}`,
  ];

  if (leftoverCents > 0) {
    parts.push(`${formatDollars(leftoverCents)} carried`);
  }

  return parts.join(" · ");
}

/** Compact form for roster rows, where space is tight. */
export function shortStanding(standing: Standing): string {
  switch (standing.state) {
    case "behind":
      return `${formatDollars(standing.balanceCents)} · ${standing.monthsBehind} mo behind`;
    case "exempt":
      return standing.balanceCents > 0
        ? `${formatDollars(standing.balanceCents)} · exempt`
        : "Exempt";
    case "current":
      if (standing.monthsRemaining === 0) return "Due now";
      if (standing.creditCents === 0) return `Square · thru ${standing.coveredThrough}`;
      return `${formatDollars(standing.creditCents)} · ${standing.monthsRemaining} mo left`;
  }
}
