import { describe, expect, it } from "vitest";
import {
  firstSaturdayOf,
  hasPostingPassed,
  latestPostablePeriod,
  nextPostingDate,
  planCatchUp,
  postingDateFor,
  unpostedPeriods,
} from "../../src/lib/accrual";
import { addMonths, periodRange, weekdayOfFirst } from "../../src/lib/period";

const THURSDAY = 4;

function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/** Every month from 2024-01 through 2030-12 — all calendar shapes, leap years included. */
const ALL_PERIODS = periodRange("2024-01", "2030-12");

describe("posting date — first Thursday after the first Saturday", () => {
  it("always lands on a Thursday", () => {
    for (const period of ALL_PERIODS) {
      expect(weekdayOf(postingDateFor(period)), `${period}`).toBe(THURSDAY);
    }
  });

  it("always lands between the 6th and the 12th", () => {
    for (const period of ALL_PERIODS) {
      const day = Number(postingDateFor(period).slice(8, 10));
      expect(day, `${period}`).toBeGreaterThanOrEqual(6);
      expect(day, `${period}`).toBeLessThanOrEqual(12);
    }
  });

  it("is always exactly 5 days after the first Saturday", () => {
    for (const period of ALL_PERIODS) {
      const day = Number(postingDateFor(period).slice(8, 10));
      expect(day - firstSaturdayOf(period), `${period}`).toBe(5);
    }
  });

  it("covers all seven possible starting weekdays", () => {
    const seen = new Set(ALL_PERIODS.map(weekdayOfFirst));
    expect(seen.size).toBe(7);
  });

  it("maps each starting weekday to the documented posting day", () => {
    // 1st falls on … -> posting day of month
    const expected: Record<number, number> = {
      6: 6, // Saturday  -> 6th
      0: 12, // Sunday   -> 12th
      1: 11, // Monday   -> 11th
      2: 10, // Tuesday  -> 10th
      3: 9, // Wednesday -> 9th
      4: 8, // Thursday  -> 8th
      5: 7, // Friday    -> 7th
    };
    for (const period of ALL_PERIODS) {
      const day = Number(postingDateFor(period).slice(8, 10));
      expect(day, `${period}`).toBe(expected[weekdayOfFirst(period)]);
    }
  });

  it("does NOT return the first Thursday when the 1st is a Thursday", () => {
    // The trap a naive "first Thursday of the month" implementation falls
    // into: that Thursday precedes the first Saturday, so it is not the
    // meeting.
    const thursdayFirsts = ALL_PERIODS.filter((p) => weekdayOfFirst(p) === THURSDAY);
    expect(thursdayFirsts.length).toBeGreaterThan(0);
    for (const period of thursdayFirsts) {
      expect(postingDateFor(period)).toBe(`${period}-08`);
      expect(postingDateFor(period)).not.toBe(`${period}-01`);
    }
  });

  it("matches hand-checked real months", () => {
    // 2026-08-01 is a Saturday -> first Saturday the 1st, meeting Thursday the 6th.
    expect(postingDateFor("2026-08")).toBe("2026-08-06");
    // 2026-02-01 is a Sunday -> first Saturday the 7th, meeting the 12th.
    expect(postingDateFor("2026-02")).toBe("2026-02-12");
    // 2026-11-01 is a Sunday -> the 12th.
    expect(postingDateFor("2026-11")).toBe("2026-11-12");
  });
});

describe("hasPostingPassed / latestPostablePeriod", () => {
  it("will not charge for a month whose meeting has not happened", () => {
    // August 2026 posts on the 6th.
    expect(hasPostingPassed("2026-08", "2026-08-05")).toBe(false);
    expect(hasPostingPassed("2026-08", "2026-08-06")).toBe(true);

    expect(latestPostablePeriod("2026-08-03")).toBe("2026-07");
    expect(latestPostablePeriod("2026-08-06")).toBe("2026-08");
    expect(latestPostablePeriod("2026-08-31")).toBe("2026-08");
  });

  it("rolls back to the previous month on the 1st", () => {
    expect(latestPostablePeriod("2026-08-01")).toBe("2026-07");
  });
});

describe("nextPostingDate", () => {
  it("returns this month's date before it, next month's after", () => {
    expect(nextPostingDate("2026-08-01")).toBe("2026-08-06");
    expect(nextPostingDate("2026-08-06")).toBe("2026-08-06");
    expect(nextPostingDate("2026-08-07")).toBe("2026-09-10");
  });
});

describe("planCatchUp", () => {
  it("posts nothing when fully caught up", () => {
    expect(
      planCatchUp({
        duesStartPeriod: "2026-06",
        latestPostable: "2026-08",
        existingPeriods: ["2026-06", "2026-07", "2026-08"],
      }),
    ).toEqual([]);
  });

  it("posts every missing month for a member 20 months behind", () => {
    const plan = planCatchUp({
      duesStartPeriod: "2025-01",
      latestPostable: "2026-08",
      existingPeriods: [],
    });
    expect(plan).toHaveLength(20);
    expect(plan[0]).toBe("2025-01");
    expect(plan.at(-1)).toBe("2026-08");
  });

  it("fills interior gaps left by a missed cron", () => {
    expect(
      planCatchUp({
        duesStartPeriod: "2026-05",
        latestPostable: "2026-08",
        existingPeriods: ["2026-05", "2026-08"],
      }),
    ).toEqual(["2026-06", "2026-07"]);
  });

  it("never reaches back before the member's dues start", () => {
    const plan = planCatchUp({
      duesStartPeriod: "2026-08",
      latestPostable: "2026-08",
      existingPeriods: [],
    });
    expect(plan).toEqual(["2026-08"]);
  });

  it("posts nothing for a member starting next month", () => {
    expect(
      planCatchUp({
        duesStartPeriod: "2026-09",
        latestPostable: "2026-08",
        existingPeriods: [],
      }),
    ).toEqual([]);
  });

  it("is idempotent — replanning after posting yields nothing", () => {
    const first = planCatchUp({
      duesStartPeriod: "2025-01",
      latestPostable: "2026-08",
      existingPeriods: [],
    });
    const second = planCatchUp({
      duesStartPeriod: "2025-01",
      latestPostable: "2026-08",
      existingPeriods: first,
    });
    expect(second).toEqual([]);
  });
});

describe("unpostedPeriods", () => {
  it("is empty when every due period has been posted", () => {
    expect(
      unpostedPeriods({
        latestPostable: "2026-08",
        postedPeriods: periodRange("2026-01", "2026-08"),
        earliestDuesStart: "2026-01",
      }),
    ).toEqual([]);
  });

  it("surfaces a month the cron silently missed", () => {
    const posted = periodRange("2026-01", "2026-08").filter((p) => p !== "2026-06");
    expect(
      unpostedPeriods({
        latestPostable: "2026-08",
        postedPeriods: posted,
        earliestDuesStart: "2026-01",
      }),
    ).toEqual(["2026-06"]);
  });

  it("looks back at most a year", () => {
    const result = unpostedPeriods({
      latestPostable: "2026-08",
      postedPeriods: [],
      earliestDuesStart: "2015-01",
    });
    expect(result).toHaveLength(12);
    expect(result[0]).toBe(addMonths("2026-08", -11));
  });

  it("is empty with no members on the books", () => {
    expect(
      unpostedPeriods({
        latestPostable: "2026-08",
        postedPeriods: [],
        earliestDuesStart: null,
      }),
    ).toEqual([]);
  });
});
