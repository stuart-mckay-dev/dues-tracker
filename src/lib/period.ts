/**
 * Calendar arithmetic for dues periods.
 *
 * A `Period` is a month, 'YYYY-MM'. A `DateStr` is a plain calendar date,
 * 'YYYY-MM-DD'. Both are plain strings so they compare and sort lexically,
 * survive JSON, and store in SQLite without conversion.
 *
 * Everything here is pure and timezone-free EXCEPT `todayInTz`, which is the
 * single place a wall clock enters the system. Keeping it to one function is
 * what makes the rest of the date logic testable without freezing time.
 */

export type Period = string; // 'YYYY-MM'
export type DateStr = string; // 'YYYY-MM-DD'

const PERIOD_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isPeriod(value: string): value is Period {
  return PERIOD_RE.test(value);
}

export function assertPeriod(value: string): Period {
  if (!isPeriod(value)) throw new Error(`Invalid period: ${value}`);
  return value;
}

export function parsePeriod(period: Period): { year: number; month: number } {
  if (!PERIOD_RE.test(period)) throw new Error(`Invalid period: ${period}`);
  return {
    year: Number(period.slice(0, 4)),
    month: Number(period.slice(5, 7)),
  };
}

export function makePeriod(year: number, month: number): Period {
  // Normalise out-of-range months so callers can do arithmetic freely.
  const zeroBased = year * 12 + (month - 1);
  const y = Math.floor(zeroBased / 12);
  const m = (zeroBased % 12) + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

export function addMonths(period: Period, delta: number): Period {
  const { year, month } = parsePeriod(period);
  return makePeriod(year, month + delta);
}

/** Signed month distance: `to` minus `from`. */
export function monthsBetween(from: Period, to: Period): number {
  const a = parsePeriod(from);
  const b = parsePeriod(to);
  return (b.year - a.year) * 12 + (b.month - a.month);
}

export function comparePeriods(a: Period, b: Period): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maxPeriod(a: Period, b: Period): Period {
  return a >= b ? a : b;
}

/** Inclusive list of every period from `from` to `to`. Empty if `to < from`. */
export function periodRange(from: Period, to: Period): Period[] {
  const count = monthsBetween(from, to);
  if (count < 0) return [];
  const out: Period[] = [];
  for (let i = 0; i <= count; i++) out.push(addMonths(from, i));
  return out;
}

export function periodOfDate(date: DateStr): Period {
  if (!DATE_RE.test(date)) throw new Error(`Invalid date: ${date}`);
  return date.slice(0, 7);
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** '2026-11' -> 'November 2026'. */
export function formatPeriodLong(period: Period): string {
  const { year, month } = parsePeriod(period);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** '2026-11' -> 'November' — for when the year is obvious from context. */
export function formatPeriodMonth(period: Period): string {
  return MONTH_NAMES[parsePeriod(period).month - 1]!;
}

/**
 * Today's calendar date in a named timezone, as 'YYYY-MM-DD'.
 *
 * The 'en-CA' locale formats dates as YYYY-MM-DD, which is exactly the shape
 * we store. Going through Intl rather than Date getters is what keeps the
 * answer correct regardless of where the Worker isolate happens to run: a
 * cron firing at 08:00 UTC is the previous evening in California, and using
 * a UTC date would post dues a day early every month.
 */
export function todayInTz(timeZone: string, now: Date = new Date()): DateStr {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Day of week for the 1st of a period. 0 = Sunday … 6 = Saturday. */
export function weekdayOfFirst(period: Period): number {
  const { year, month } = parsePeriod(period);
  // Date.UTC avoids the host timezone shifting the result.
  return new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
}
