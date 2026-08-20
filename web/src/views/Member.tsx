import { useEffect, useState } from "preact/hooks";
import { api, type Bootstrap, type LedgerEntry, type RosterEntry } from "../api";
import {
  KIND_LABELS,
  METHOD_LABELS,
  formatDate,
  formatDollars,
  formatPeriodLong,
} from "../format";
import type { ToastState } from "../components/Toast";
import { EditMemberSheet } from "../components/EditMemberSheet";
import { EditEntrySheet } from "../components/EditEntrySheet";

export function Member({
  id,
  boot,
  onAddEntry,
  onChanged,
  toast,
}: {
  id: string;
  boot: Bootstrap;
  onAddEntry: () => void;
  onChanged: () => void;
  toast: ToastState;
}) {
  const [member, setMember] = useState<RosterEntry | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editingEntry, setEditingEntry] = useState<LedgerEntry | null>(null);

  function load() {
    api
      .member(id)
      .then((r) => {
        setMember(r.member);
        setLedger(r.ledger);
      })
      .catch((e: Error) => setError(e.message));
  }

  useEffect(load, [id]);

  if (error) return <div class="empty">{error}</div>;
  if (!member) return <div class="empty">Loading…</div>;

  const owes = member.balanceCents > 0;
  const ahead = member.balanceCents < 0;

  function afterEntryChange(message: string) {
    setEditingEntry(null);
    toast.show(message);
    load();
    onChanged();
  }

  return (
    <>
      <div class="card">
        <div class="member-head">
          <h2>{member.displayName}</h2>
          <div class="meta">
            <span class={`badge ${member.accruesDues ? "neutral" : "good"}`}>{member.statusLabel}</span>
            {member.nickname && <span class="muted"> · “{member.nickname}”</span>}
          </div>

          <div class={`balance money ${owes ? "owes" : ahead ? "ahead" : ""}`}>
            {formatDollars(Math.abs(member.balanceCents))}
            {owes ? " owed" : ahead ? " credit" : ""}
          </div>

          {/* The sentence the treasurer reads out at the table. */}
          <div class="standing-line">{member.standing.summary}</div>

          {member.standing.state === "current" && member.standing.monthsRemaining > 0 && (
            <div class="standing-line">
              Covered through <strong>{formatPeriodLong(member.standing.coveredThrough)}</strong>
            </div>
          )}
        </div>

        <div class="card-body">
          <div class="btn-row no-print">
            <button class="btn primary grow" onClick={onAddEntry}>
              Record entry
            </button>
            <button class="btn" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button class="btn" onClick={() => print()}>
              Print
            </button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Ledger</h2>
          <span class="muted" style="font-size:.78rem">
            {ledger.filter((e) => !e.voided_at).length} entries
          </span>
        </div>
        <div class="card-body tight">
          {ledger.length === 0 ? (
            <div class="empty">No entries yet.</div>
          ) : (
            <div class="ledger-wrap">
              <table class="ledger">
                <thead>
                  <tr>
                    <th class="left">Date</th>
                    <th class="left col-memo">Memo</th>
                    <th>Debit</th>
                    <th>Credit</th>
                    <th>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((entry) => (
                    <tr
                      key={entry.id}
                      class={`tappable ${entry.voided_at ? "voided" : ""}`}
                      onClick={() => setEditingEntry(entry)}
                      title="Tap to correct this entry"
                    >
                      <td class="left">
                        <div class="date">{formatDate(entry.occurred_on)}</div>
                        <span class="memo-inline">{describe(entry)}</span>
                      </td>
                      <td class="left memo col-memo">{describe(entry)}</td>
                      <td class="debit">
                        {entry.direction === "debit" ? formatDollars(entry.amount_cents) : ""}
                      </td>
                      <td class="credit">
                        {entry.direction === "credit" ? formatDollars(entry.amount_cents) : ""}
                      </td>
                      <td class="running">{formatDollars(entry.running_balance_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {ledger.length > 0 && (
        <div class="hint no-print" style="margin-top:-6px">
          Tap any ledger row to correct it.
        </div>
      )}

      <div class="spacer" />

      {editingEntry && (
        <EditEntrySheet
          entry={editingEntry}
          methods={boot.methods}
          onClose={() => setEditingEntry(null)}
          onSaved={async (body) => {
            await api.updateTransaction(editingEntry.id, body);
            afterEntryChange("Entry updated.");
          }}
          onDelete={async () => {
            await api.deleteTransaction(editingEntry.id);
            afterEntryChange("Entry deleted.");
          }}
          onVoid={async (reason) => {
            await api.voidTransaction(editingEntry.id, reason);
            afterEntryChange("Month waived — it will not be re-posted.");
          }}
        />
      )}

      {editing && (
        <EditMemberSheet
          member={member}
          boot={boot}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            load();
            onChanged();
          }}
        />
      )}
    </>
  );
}

function describe(entry: LedgerEntry): string {
  const base = KIND_LABELS[entry.kind] ?? entry.kind;
  const bits: string[] = [];

  if (entry.kind === "dues_charge" && entry.period) {
    bits.push(formatPeriodLong(entry.period));
  }
  if (entry.memo && entry.memo !== base) bits.push(entry.memo);
  if (entry.method) bits.push(METHOD_LABELS[entry.method] ?? entry.method);
  if (entry.entered_as_months) {
    bits.push(`${entry.entered_as_months} mo`);
  }

  return bits.length ? `${base} — ${bits.join(" · ")}` : base;
}
