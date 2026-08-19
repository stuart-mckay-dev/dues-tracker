/**
 * CSV export. Hand-rolled rather than a dependency — the whole format is one
 * quoting rule, and the export is meant to outlive the app.
 */

import { centsToDecimalString } from "./money";
import type { TransactionRow } from "../types";

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  // Quote when the value contains a delimiter, a quote, or a newline. A
  // leading-character guard also stops spreadsheets treating a memo starting
  // with = or + as a formula.
  const needsQuote = /[",\n\r]/.test(s) || /^[=+\-@]/.test(s);
  return needsQuote ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(cell).join(",")];
  for (const row of rows) lines.push(row.map(cell).join(","));
  // CRLF: what Excel expects, and harmless everywhere else.
  return lines.join("\r\n") + "\r\n";
}

export type ExportRow = TransactionRow & { member_name: string };

export function transactionsCsv(rows: ExportRow[]): string {
  return toCsv(
    [
      "date",
      "member",
      "kind",
      "debit",
      "credit",
      "period",
      "method",
      "memo",
      "voided",
      "transaction_id",
    ],
    rows.map((r) => [
      r.occurred_on,
      r.member_name,
      r.kind,
      r.direction === "debit" ? centsToDecimalString(r.amount_cents) : "",
      r.direction === "credit" ? centsToDecimalString(r.amount_cents) : "",
      r.period ?? "",
      r.method ?? "",
      r.memo ?? "",
      r.voided_at ? "yes" : "",
      r.id,
    ]),
  );
}
