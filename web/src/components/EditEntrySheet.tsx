import { useState } from "preact/hooks";
import { type LedgerEntry } from "../api";
import { previewAmount } from "../../../src/lib/money";
import { KIND_LABELS, METHOD_LABELS, formatDollars, formatPeriodLong } from "../format";

/**
 * Correcting one ledger entry.
 *
 * Dues charges get "Waive" instead of "Delete", because deleting one just
 * makes the period look missing and the next catch-up run puts it straight
 * back. Waiving (voiding) is what actually forgives a month.
 */
export function EditEntrySheet({
  entry,
  methods,
  onClose,
  onSaved,
  onDelete,
  onVoid,
}: {
  entry: LedgerEntry;
  methods: string[];
  onClose: () => void;
  onSaved: (body: unknown) => Promise<void>;
  onDelete: () => Promise<void>;
  onVoid: (reason: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState(String(entry.amount_cents / 100));
  const [occurredOn, setOccurredOn] = useState(entry.occurred_on);
  const [memo, setMemo] = useState(entry.memo ?? "");
  const [method, setMethod] = useState<string>(entry.method ?? "cash");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = previewAmount(amount);
  const isDues = entry.kind === "dues_charge";
  const alreadyVoided = Boolean(entry.voided_at);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true">
        <h2>{KIND_LABELS[entry.kind] ?? entry.kind}</h2>

        {isDues && entry.period && (
          <div class="hint" style="margin-bottom:12px">
            Covers {formatPeriodLong(entry.period)}.
          </div>
        )}

        {alreadyVoided && (
          <div class="hint rounded" style="margin-bottom:12px">
            Already waived{entry.void_reason ? ` — ${entry.void_reason}` : ""}. It does not
            count toward the balance and will not be re-posted.
          </div>
        )}

        <div class="field">
          <label for="ee-amount">Amount</label>
          <input
            id="ee-amount"
            type="text"
            inputMode="decimal"
            value={amount}
            onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
          />
          {preview?.rounded && (
            <div class="hint rounded">
              Rounds to {formatDollars(preview.cents)} — the club tracks whole dollars.
            </div>
          )}
        </div>

        <div class="field">
          <label for="ee-date">Date</label>
          <input
            id="ee-date"
            type="date"
            value={occurredOn}
            onInput={(e) => setOccurredOn((e.target as HTMLInputElement).value)}
          />
        </div>

        {entry.kind === "payment" && (
          <div class="field">
            <label for="ee-method">Paid by</label>
            <select
              id="ee-method"
              value={method}
              onChange={(e) => setMethod((e.target as HTMLSelectElement).value)}
            >
              {methods.map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABELS[m] ?? m}
                </option>
              ))}
            </select>
          </div>
        )}

        <div class="field">
          <label for="ee-memo">Memo</label>
          <input
            id="ee-memo"
            type="text"
            value={memo}
            onInput={(e) => setMemo((e.target as HTMLInputElement).value)}
          />
        </div>

        {error && <div class="hint error">{error}</div>}

        <div class="btn-row">
          <button class="btn grow" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            class="btn primary grow"
            disabled={busy || !preview}
            onClick={() =>
              run(() =>
                onSaved({
                  amount,
                  occurredOn,
                  memo,
                  ...(entry.kind === "payment" ? { method } : {}),
                }),
              )
            }
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>

        <div class="spacer" />

        {isDues && !alreadyVoided ? (
          <button
            class="btn danger block"
            disabled={busy}
            onClick={() => {
              const reason = prompt("Reason for waiving this month?", "Waived") ?? "";
              if (reason.trim()) void run(() => onVoid(reason.trim()));
            }}
          >
            Waive this month
          </button>
        ) : (
          <button
            class="btn danger block"
            disabled={busy}
            onClick={() => {
              if (confirm("Delete this entry? This cannot be undone.")) void run(onDelete);
            }}
          >
            Delete entry
          </button>
        )}

        {isDues && !alreadyVoided && (
          <div class="hint">
            Waiving forgives the month for good. Deleting a dues charge would just be
            re-posted at the next run.
          </div>
        )}
      </div>
    </div>
  );
}
