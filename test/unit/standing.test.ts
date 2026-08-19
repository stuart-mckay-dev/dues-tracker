import { describe, expect, it } from "vitest";
import { computeStanding, flagFor, type StandingInput } from "../../src/lib/standing";

const DUES = 2500; // illustrative rate: $25
const WARN = 15000; // 6 months
const BAD = 45000; // 18 months

function standing(overrides: Partial<StandingInput> = {}) {
  return computeStanding({
    balanceCents: 0,
    duesCents: DUES,
    lastPostedPeriod: "2026-08",
    duesStartPeriod: "2026-01",
    currentPeriod: "2026-08",
    accruesDues: true,
    warnThresholdCents: WARN,
    badStandingThresholdCents: BAD,
    ...overrides,
  });
}

describe("the worked example from the spec", () => {
  it("August 2026, 2 months of credit -> 3 more months, next due November", () => {
    const s = standing({ balanceCents: -5000, lastPostedPeriod: "2026-08" });

    expect(s.state).toBe("current");
    if (s.state !== "current") return;

    expect(s.creditCents).toBe(5000);
    expect(s.coveredThrough).toBe("2026-10");
    expect(s.monthsRemaining).toBe(3);
    expect(s.nextDue).toBe("2026-11");
    expect(s.summary).toBe(
      "Paid ahead $50 · good for 3 more months · next payment due November 2026",
    );
  });
});

describe("stability across the posting date", () => {
  // Posting advances lastPosted by one month AND consumes one month of
  // credit; the two cancel. A member asking on the 5th and on the 7th must
  // get the same answer. (docs/DECISIONS.md D8)
  it("gives an identical answer before and after the cron runs", () => {
    const before = standing({ balanceCents: -7500, lastPostedPeriod: "2026-07" });
    const after = standing({ balanceCents: -5000, lastPostedPeriod: "2026-08" });

    expect(before.state).toBe("current");
    expect(after.state).toBe("current");
    if (before.state !== "current" || after.state !== "current") return;

    expect(before.coveredThrough).toBe(after.coveredThrough);
    expect(before.monthsRemaining).toBe(after.monthsRemaining);
    expect(before.nextDue).toBe(after.nextDue);
    expect(before.monthsRemaining).toBe(3);
    expect(before.nextDue).toBe("2026-11");
  });

  it("holds across a year of prepayment levels", () => {
    for (let months = 0; months <= 12; months++) {
      const before = standing({
        balanceCents: -(months + 1) * DUES,
        lastPostedPeriod: "2026-07",
      });
      const after = standing({
        balanceCents: -months * DUES,
        lastPostedPeriod: "2026-08",
      });
      if (before.state !== "current" || after.state !== "current") throw new Error("state");
      expect(after.monthsRemaining, `${months} months prepaid`).toBe(
        before.monthsRemaining,
      );
      expect(after.nextDue, `${months} months prepaid`).toBe(before.nextDue);
    }
  });
});

describe("square", () => {
  it("covers the current month with nothing owed", () => {
    const s = standing({ balanceCents: 0, lastPostedPeriod: "2026-08" });
    if (s.state !== "current") throw new Error("expected current");

    expect(s.creditCents).toBe(0);
    expect(s.coveredThrough).toBe("2026-08");
    expect(s.monthsRemaining).toBe(1);
    expect(s.nextDue).toBe("2026-09");
    expect(s.summary).toBe(
      "Square · good for 1 more month · next payment due September 2026",
    );
  });

  it("reads 'due now' when this month has not posted and there is no credit", () => {
    const s = standing({ balanceCents: 0, lastPostedPeriod: "2026-07" });
    if (s.state !== "current") throw new Error("expected current");

    expect(s.monthsRemaining).toBe(0);
    expect(s.nextDue).toBe("2026-08");
    expect(s.summary).toBe("Due now · payment due August 2026");
  });
});

describe("partial credit", () => {
  it("2.6 months of credit buys 2 months and carries the rest", () => {
    const s = standing({ balanceCents: -6500, lastPostedPeriod: "2026-08" });
    if (s.state !== "current") throw new Error("expected current");

    expect(s.coveredThrough).toBe("2026-10");
    expect(s.monthsRemaining).toBe(3);
    expect(s.nextDue).toBe("2026-11");
    expect(s.leftoverCents).toBe(1500);
    expect(s.summary).toContain("$15 carried");
  });
});

describe("behind", () => {
  it("exactly 18 months and trips bad standing", () => {
    const s = standing({ balanceCents: 45000 });
    if (s.state !== "behind") throw new Error("expected behind");

    expect(s.monthsBehind).toBe(18);
    expect(s.remainderCents).toBe(0);
    expect(s.flag).toBe("bad_standing");
    expect(s.summary).toBe("Owes $450 · 18 months behind");
  });

  it("uses floor with a remainder rather than overstating the debt", () => {
    const s = standing({ balanceCents: 45500 });
    if (s.state !== "behind") throw new Error("expected behind");

    expect(s.monthsBehind).toBe(18); // not 19
    expect(s.remainderCents).toBe(500);
    expect(s.summary).toBe("Owes $455 · 18 months behind · $5 over");
  });

  it("singularises one month", () => {
    const s = standing({ balanceCents: 2500 });
    expect(s.summary).toBe("Owes $25 · 1 month behind");
  });

  it("reports no prepaid figure", () => {
    const s = standing({ balanceCents: 12500 });
    expect(s.state).toBe("behind");
    expect(s).not.toHaveProperty("monthsRemaining");
  });
});

describe("thresholds", () => {
  it.each([
    [0, "ok"],
    [14900, "ok"],
    [15000, "warning"], // inclusive
    [42500, "warning"],
    [44900, "warning"],
    [45000, "bad_standing"], // inclusive
    [62500, "bad_standing"],
  ])("$%i cents -> %s", (balance, expected) => {
    expect(flagFor(balance, WARN, BAD)).toBe(expected);
    expect(standing({ balanceCents: balance }).flag).toBe(expected);
  });

  it("treats a credit balance as ok", () => {
    expect(standing({ balanceCents: -12500 }).flag).toBe("ok");
  });
});

describe("never charged yet", () => {
  it("anchors on the month before dues start", () => {
    // Added in August, dues start September, prepaid 2 months on the spot.
    const s = standing({
      balanceCents: -5000,
      lastPostedPeriod: null,
      duesStartPeriod: "2026-09",
      currentPeriod: "2026-08",
    });
    if (s.state !== "current") throw new Error("expected current");

    expect(s.coveredThrough).toBe("2026-10"); // Sep and Oct prepaid
    expect(s.nextDue).toBe("2026-11");
    expect(s.monthsRemaining).toBe(3);
  });

  it("handles a brand-new member with no transactions at all", () => {
    const s = standing({
      balanceCents: 0,
      lastPostedPeriod: null,
      duesStartPeriod: "2026-09",
      currentPeriod: "2026-08",
    });
    if (s.state !== "current") throw new Error("expected current");
    expect(s.nextDue).toBe("2026-09");
  });
});

describe("non-accruing statuses", () => {
  it("reports exempt with no month math", () => {
    const s = standing({ accruesDues: false, balanceCents: 0 });
    expect(s.state).toBe("exempt");
    expect(s.summary).toBe("Exempt — no dues accruing");
  });

  it("still shows a debt carried into exempt status", () => {
    // Ran up 20 months of debt, then moved to Lifetime. The status stops future accrual;
    // it does not forgive the balance. (docs/DECISIONS.md D10)
    const s = standing({ accruesDues: false, balanceCents: 50000 });
    if (s.state !== "exempt") throw new Error("expected exempt");

    expect(s.flag).toBe("bad_standing");
    expect(s.monthsBehind).toBe(20);
    expect(s.summary).toBe("Owes $500 · exempt from future dues");
  });
});

describe("degenerate state — posting job stalled for months", () => {
  it("clamps the next due month forward instead of naming a past month", () => {
    const s = standing({
      balanceCents: 0,
      lastPostedPeriod: "2026-05",
      currentPeriod: "2026-08",
    });
    if (s.state !== "current") throw new Error("expected current");

    expect(s.monthsRemaining).toBe(0);
    expect(s.nextDue).toBe("2026-08"); // not 2026-06
  });
});
