/**
 * Money handling.
 *
 * Everything is integer cents. Floats never touch a stored amount: `0.1 + 0.2`
 * is a rounding bug waiting to become a member dispute.
 *
 * Club policy is whole dollars only (docs/DECISIONS.md D6), enforced in the
 * database by `CHECK (amount_cents % 100 = 0)`. Rounding happens exactly once,
 * here, at entry — and the UI previews the result before saving, so an amount
 * is never silently adjusted.
 */

export const CENTS_PER_DOLLAR = 100;

/**
 * Parse user input into whole-dollar cents, rounding to the nearest dollar.
 *
 *   '47.83' -> 4800   ('$47.83 → $48')
 *   '47.49' -> 4700
 *   '$50'   -> 5000
 *
 * Returns null for anything unparseable or non-positive, so callers can show a
 * validation message rather than storing a surprise.
 */
export function parseAmountToCents(input: string | number): number | null {
  const raw = typeof input === "number" ? String(input) : input;
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;

  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;

  // Validate AFTER rounding: '0.40' is a positive number that rounds to $0,
  // and letting it through would reach the database as a zero-amount insert
  // and fail the CHECK constraint with an opaque error instead of a clear
  // "enter an amount" message.
  const cents = Math.round(dollars) * CENTS_PER_DOLLAR;
  return cents > 0 ? cents : null;
}

/**
 * What the entry form shows before saving. `rounded` is true when the typed
 * value differs from what will be stored, which is the cue to display
 * '$47.83 → $48' rather than adjusting quietly.
 */
export function previewAmount(input: string | number): {
  cents: number;
  rounded: boolean;
  typed: string;
} | null {
  const cents = parseAmountToCents(input);
  if (cents === null) return null;

  const raw = typeof input === "number" ? String(input) : input;
  const cleaned = raw.replace(/[$,\s]/g, "");
  const typedDollars = Number(cleaned);

  return {
    cents,
    rounded: Math.round(typedDollars) !== typedDollars,
    typed: formatDollars(Math.round(typedDollars * CENTS_PER_DOLLAR)),
  };
}

/** Cents -> '$450'. Shows decimals only if a non-whole amount ever appears. */
export function formatDollars(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const body =
    abs % CENTS_PER_DOLLAR === 0
      ? `$${(abs / CENTS_PER_DOLLAR).toLocaleString("en-US")}`
      : `$${(abs / CENTS_PER_DOLLAR).toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`;
  return negative ? `-${body}` : body;
}

/** Cents -> '180.00', for CSV export where a bare number is wanted. */
export function centsToDecimalString(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / CENTS_PER_DOLLAR)}.${String(
    abs % CENTS_PER_DOLLAR,
  ).padStart(2, "0")}`;
}

/** Months' worth of dues, in cents. Used by the months↔dollars toggle. */
export function monthsToCents(months: number, duesCents: number): number {
  return Math.max(0, Math.round(months)) * duesCents;
}
