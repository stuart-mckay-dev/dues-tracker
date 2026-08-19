import { describe, expect, it } from "vitest";
import {
  centsToDecimalString,
  formatDollars,
  monthsToCents,
  parseAmountToCents,
  previewAmount,
} from "../../src/lib/money";

describe("parseAmountToCents — rounds to whole dollars", () => {
  it.each([
    ["47.83", 4800],
    ["47.49", 4700],
    ["47.50", 4800], // banker's rounding is NOT used; .5 rounds up
    ["50", 5000],
    ["$50", 5000],
    ["$1,250", 125000],
    [" 25 ", 2500],
    [25, 2500],
  ])("%s -> %i cents", (input, expected) => {
    expect(parseAmountToCents(input)).toBe(expected);
  });

  it.each([["", null], ["abc", null], ["0", null], ["-5", null], ["0.4", null]])(
    "rejects %s",
    (input, expected) => {
      // 0.4 rounds to $0, which is not a valid entry.
      expect(parseAmountToCents(input as string)).toBe(expected);
    },
  );

  it("always yields a whole number of dollars, satisfying the DB constraint", () => {
    for (const raw of ["1.01", "99.99", "3.5", "0.51", "12345.678"]) {
      const cents = parseAmountToCents(raw)!;
      expect(cents % 100, raw).toBe(0);
    }
  });
});

describe("previewAmount — the '$47.83 → $48' cue", () => {
  it("flags a value that will be rounded", () => {
    const p = previewAmount("47.83")!;
    expect(p.cents).toBe(4800);
    expect(p.rounded).toBe(true);
  });

  it("does not flag an already-whole value", () => {
    const p = previewAmount("50")!;
    expect(p.cents).toBe(5000);
    expect(p.rounded).toBe(false);
  });

  it("returns null for unparseable input so the form can show an error", () => {
    expect(previewAmount("nope")).toBeNull();
  });
});

describe("formatDollars", () => {
  it.each([
    [0, "$0"],
    [2500, "$25"],
    [45000, "$450"],
    [125000, "$1,250"],
    [-5000, "-$50"],
  ])("%i -> %s", (cents, expected) => {
    expect(formatDollars(cents)).toBe(expected);
  });

  it("shows decimals only if a non-whole amount ever appears", () => {
    expect(formatDollars(4783)).toBe("$47.83");
  });
});

describe("centsToDecimalString — CSV numbers", () => {
  it.each([
    [2500, "25.00"],
    [4800, "48.00"],
    [-5000, "-50.00"],
    [5, "0.05"],
  ])("%i -> %s", (cents, expected) => {
    expect(centsToDecimalString(cents)).toBe(expected);
  });
});

describe("monthsToCents", () => {
  it("multiplies by the dues rate", () => {
    expect(monthsToCents(2, 2500)).toBe(5000);
    expect(monthsToCents(12, 2500)).toBe(30000);
  });

  it("never goes negative", () => {
    expect(monthsToCents(-3, 2500)).toBe(0);
  });
});
