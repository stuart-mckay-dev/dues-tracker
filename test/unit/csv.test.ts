import { describe, expect, it } from "vitest";
import { toCsv, transactionsCsv } from "../../src/lib/csv";

describe("CSV quoting", () => {
  it("quotes delimiters, quotes and newlines", () => {
    expect(toCsv(["a"], [['say "hi", ok']])).toContain('"say ""hi"", ok"');
    expect(toCsv(["a"], [["line1\nline2"]])).toContain('"line1\nline2"');
  });

  it("neutralises spreadsheet formula injection in a memo", () => {
    // A memo starting with = or + would otherwise be evaluated by Excel.
    const csv = toCsv(["memo"], [["=SUM(A1:A9)"]]);
    expect(csv).toContain('"=SUM(A1:A9)"');
  });

  it("puts debits and credits in separate columns", () => {
    const csv = transactionsCsv([
      {
        id: "t1",
        member_id: "m1",
        member_name: "Dave Rankin",
        kind: "payment",
        direction: "credit",
        amount_cents: 3000,
        occurred_on: "2026-08-17",
        period: null,
        method: "cash",
        memo: null,
        entered_as_months: null,
        voided_at: null,
        void_reason: null,
        created_at: "2026-08-17",
      },
    ]);
    const [, row] = csv.trim().split("\r\n");
    expect(row).toBe("2026-08-17,Dave Rankin,payment,,30.00,,cash,,,t1");
  });
});
