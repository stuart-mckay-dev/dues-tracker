import { useEffect, useState } from "preact/hooks";
import { api, type LedgerEntry } from "../api";
import { KIND_LABELS, formatDate, formatDollars } from "../format";
import { navigate } from "../router";

type Row = LedgerEntry & { member_name: string };

export function ClubLedger() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    const params: Record<string, string> = {};
    if (kind) params.kind = kind;
    if (from) params.from = from;
    if (to) params.to = to;

    api
      .transactions(params)
      .then((r) => setRows(r.transactions as Row[]))
      .catch((e: Error) => setError(e.message));
  }, [kind, from, to]);

  if (error) return <div class="empty">{error}</div>;

  const totals = (rows ?? []).reduce(
    (acc, r) => {
      if (r.voided_at) return acc;
      if (r.direction === "debit") acc.debit += r.amount_cents;
      else acc.credit += r.amount_cents;
      return acc;
    },
    { debit: 0, credit: 0 },
  );

  return (
    <>
      <div class="card no-print">
        <div class="card-body">
          <div class="field">
            <label for="f-kind">Type</label>
            <select
              id="f-kind"
              value={kind}
              onChange={(e) => setKind((e.target as HTMLSelectElement).value)}
            >
              <option value="">All types</option>
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {/* Grid rather than flex: native date inputs carry an intrinsic
              width that flex items will not shrink below, which made these two
              overlap on iOS Safari at every orientation. */}
          <div class="field-row">
            <div>
              <label for="f-from">From</label>
              <input
                id="f-from"
                type="date"
                value={from}
                onInput={(e) => setFrom((e.target as HTMLInputElement).value)}
              />
            </div>
            <div>
              <label for="f-to">To</label>
              <input
                id="f-to"
                type="date"
                value={to}
                onInput={(e) => setTo((e.target as HTMLInputElement).value)}
              />
            </div>
          </div>

          <div class="spacer" />
          <a class="btn block" href="/api/export/transactions.csv">
            Export all to CSV
          </a>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>All entries</h2>
          <span class="muted" style="font-size:.78rem">
            {rows?.length ?? 0} shown
          </span>
        </div>
        <div class="card-body tight">
          {!rows ? (
            <div class="empty">Loading…</div>
          ) : rows.length === 0 ? (
            <div class="empty">Nothing recorded yet.</div>
          ) : (
            <div class="ledger-wrap">
              <table class="ledger">
                <thead>
                  <tr>
                    <th class="left">Date</th>
                    <th class="left">Member</th>
                    <th class="left col-memo">Type</th>
                    <th>Debit</th>
                    <th>Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} class={r.voided_at ? "voided" : ""}>
                      <td class="left date">{formatDate(r.occurred_on)}</td>
                      <td class="left">
                        <button
                          class="linkish"
                          style="background:none;border:0;padding:0;color:inherit;font:inherit;text-align:left;cursor:pointer;text-decoration:underline"
                          onClick={() => navigate(`/member/${r.member_id}`)}
                        >
                          {r.member_name}
                        </button>
                        <span class="memo-inline">{KIND_LABELS[r.kind] ?? r.kind}</span>
                      </td>
                      <td class="left col-memo">{KIND_LABELS[r.kind] ?? r.kind}</td>
                      <td class="debit">
                        {r.direction === "debit" ? formatDollars(r.amount_cents) : ""}
                      </td>
                      <td class="credit">
                        {r.direction === "credit" ? formatDollars(r.amount_cents) : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td class="left" colSpan={3}>
                      <strong>Totals</strong>
                    </td>
                    <td class="debit">
                      <strong>{formatDollars(totals.debit)}</strong>
                    </td>
                    <td class="credit">
                      <strong>{formatDollars(totals.credit)}</strong>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>

      <div class="spacer" />
    </>
  );
}
