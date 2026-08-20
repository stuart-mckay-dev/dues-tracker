/**
 * Display helpers. Money formatting is re-used from the shared lib so the UI
 * and the CSV export can never disagree about what an amount looks like.
 */

import { formatDollars } from "../../src/lib/money";
import type { Standing } from "../../src/lib/standing";

export { formatDollars };
export { formatPeriodLong, formatPeriodMonth } from "../../src/lib/period";

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const DATE_SHORT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** 'YYYY-MM-DD' -> 'Aug 6, 2026'. Parsed as UTC so the date never shifts. */
export function formatDate(date: string): string {
  return DATE_FMT.format(new Date(`${date}T00:00:00Z`));
}

export function formatDateShort(date: string): string {
  return DATE_SHORT.format(new Date(`${date}T00:00:00Z`));
}

export const KIND_LABELS: Record<string, string> = {
  dues_charge: "Monthly dues",
  misc_debit: "Charge",
  payment: "Payment",
  reimbursement_credit: "Reimbursement",
  opening_balance: "Opening balance",
};

export const METHOD_LABELS: Record<string, string> = {
  cash: "Cash",
  venmo: "Venmo",
  zelle: "Zelle",
  check: "Check",
  other: "Other",
};

/** Maps a standing flag to the badge class, plus the prepaid case. */
export function rowClass(standing: Standing): string {
  if (standing.flag !== "ok") return `flag-${standing.flag}`;
  if (standing.state === "current" && standing.creditCents > 0) return "prepaid";
  return "";
}

/**
 * The compact right-hand column of a roster row: the dollar figure, with the
 * month count underneath. Both, always — the dollars are what gets collected,
 * the months are what gets said out loud.
 */
export function rowAmount(standing: Standing): { primary: string; secondary: string } {
  switch (standing.state) {
    case "behind":
      return {
        primary: formatDollars(standing.balanceCents),
        secondary: `${standing.monthsBehind} mo behind`,
      };
    case "exempt":
      return {
        primary: standing.balanceCents > 0 ? formatDollars(standing.balanceCents) : "—",
        secondary: "exempt",
      };
    case "current":
      if (standing.monthsRemaining === 0) return { primary: "Due", secondary: "this month" };
      if (standing.creditCents === 0)
        return { primary: "Square", secondary: `${standing.monthsRemaining} mo left` };
      return {
        primary: formatDollars(standing.creditCents),
        secondary: `${standing.monthsRemaining} mo left`,
      };
  }
}
