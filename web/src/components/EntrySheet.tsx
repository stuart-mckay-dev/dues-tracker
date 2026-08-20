import { useEffect, useMemo, useState } from "preact/hooks";
import { api, type Bootstrap, type RosterEntry } from "../api";
import { previewAmount } from "../../../src/lib/money";
import { formatDollars, formatPeriodLong, METHOD_LABELS } from "../format";

type Kind = "payment" | "reimbursement_credit" | "misc_debit" | "dues_charge";

const KIND_OPTIONS: { value: Kind; label: string; hint: string }[] = [
  { value: "payment", label: "Payment", hint: "Money received from the member" },
  { value: "reimbursement_credit", label: "Reimbursement", hint: "They bought something for the club" },
  { value: "misc_debit", label: "Charge", hint: "Add an amount to what they owe" },
  { value: "dues_charge", label: "Dues charge", hint: "Post a monthly due manually" },
];

export function EntrySheet({
  boot,
  memberId,
  onClose,
  onSaved,
}: {
  boot: Bootstrap;
  memberId?: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [members, setMembers] = useState<RosterEntry[]>([]);
  const [selected, setSelected] = useState(memberId ?? "");
  const [kind, setKind] = useState<Kind>("payment");
  const [mode, setMode] = useState<"dollars" | "months">("dollars");
  const [amount, setAmount] = useState("");
  const [months, setMonths] = useState("1");
  const [method, setMethod] = useState("cash");
  const [occurredOn, setOccurredOn] = useState(boot.today);
  const [memo, setMemo] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.members().then((r) => {
      setMembers(r.members);
      if (!memberId && r.members.length === 1) setSelected(r.members[0]!.id);
    });
  }, [memberId]);

  const dues = boot.settings.monthlyDuesCents;

  // Rounding is previewed, never silent: '$47.83 → $48' before saving.
  const preview = useMemo(() => {
    if (mode === "months") {
      const n = Math.max(1, Math.round(Number(months) || 0));
      return { cents: n * dues, rounded: false, typed: "" };
    }
    return previewAmount(amount);
  }, [mode, amount, months, dues]);

  const canSave = Boolean(selected) && Boolean(preview?.cents) && !saving;

  async function save() {
    if (!canSave || !preview) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.createTransaction({
        memberId: selected,
        kind,
        ...(mode === "months"
          ? { months: Math.max(1, Math.round(Number(months) || 1)) }
          : { amount }),
        method: kind === "payment" ? method : undefined,
        occurredOn,
        memo: memo || undefined,
      });

      onSaved(confirmation(result.member, preview.cents, kind));
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  const kindMeta = KIND_OPTIONS.find((k) => k.value === kind)!;
  const monthsAllowed = kind === "payment" || kind === "dues_charge";

  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true">
        <h2>Record an entry</h2>

        <div class="field">
          <label for="entry-member">Member</label>
          <select
            id="entry-member"
            value={selected}
            onChange={(e) => setSelected((e.target as HTMLSelectElement).value)}
          >
            <option value="">Choose a member…</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </div>

        <div class="field">
          <label>Type</label>
          <div class="segmented">
            {KIND_OPTIONS.map((option) => (
              <button
                key={option.value}
                aria-pressed={kind === option.value}
                onClick={() => {
                  setKind(option.value);
                  if (option.value !== "payment" && option.value !== "dues_charge") {
                    setMode("dollars");
                  }
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div class="hint">{kindMeta.hint}</div>
        </div>

        <div class="field">
          <label for="entry-amount">Amount</label>
          {monthsAllowed && (
            <div class="segmented" style="margin-bottom:8px">
              <button aria-pressed={mode === "dollars"} onClick={() => setMode("dollars")}>
                Dollars
              </button>
              <button aria-pressed={mode === "months"} onClick={() => setMode("months")}>
                Months
              </button>
            </div>
          )}

          {mode === "dollars" ? (
            <input
              id="entry-amount"
              type="text"
              inputMode="decimal"
              placeholder="20"
              value={amount}
              onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
            />
          ) : (
            <input
              id="entry-amount"
              type="number"
              min="1"
              step="1"
              value={months}
              onInput={(e) => setMonths((e.target as HTMLInputElement).value)}
            />
          )}

          {mode === "months" && preview && (
            <div class="hint">
              {months} × {formatDollars(dues)} = <strong>{formatDollars(preview.cents)}</strong>
            </div>
          )}

          {mode === "dollars" && preview?.rounded && (
            <div class="hint rounded">
              Rounds to {formatDollars(preview.cents)} — the club tracks whole dollars.
            </div>
          )}
        </div>

        {kind === "payment" && (
          <div class="field">
            <label for="entry-method">Paid by</label>
            <select
              id="entry-method"
              value={method}
              onChange={(e) => setMethod((e.target as HTMLSelectElement).value)}
            >
              {boot.methods.map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABELS[m] ?? m}
                </option>
              ))}
            </select>
          </div>
        )}

        <div class="field">
          <label for="entry-date">Date</label>
          <input
            id="entry-date"
            type="date"
            value={occurredOn}
            onInput={(e) => setOccurredOn((e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="field">
          <label for="entry-memo">Memo</label>
          <input
            id="entry-memo"
            type="text"
            placeholder="bought supplies for the club"
            value={memo}
            onInput={(e) => setMemo((e.target as HTMLInputElement).value)}
          />
        </div>

        {error && <div class="hint error">{error}</div>}

        <div class="btn-row">
          <button class="btn grow" onClick={onClose}>
            Cancel
          </button>
          <button class="btn primary grow" onClick={save} disabled={!canSave}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Restates the member's NEW standing right after saving, so the treasurer can
 * answer "am I good?" on the spot without navigating anywhere.
 */
function confirmation(member: RosterEntry, cents: number, kind: Kind): string {
  const what = kind === "payment" ? "Payment" : kind === "reimbursement_credit" ? "Credit" : "Charge";
  const head = `${what} of ${formatDollars(cents)} recorded.`;
  const s = member.standing;

  if (s.state === "current" && s.monthsRemaining > 0) {
    return (
      `${head} ${member.displayName} is good for ${s.monthsRemaining} more ` +
      `month${s.monthsRemaining === 1 ? "" : "s"} — next due ${formatPeriodLong(s.nextDue)}.`
    );
  }
  if (s.state === "behind") {
    return `${head} ${member.displayName} still owes ${formatDollars(s.balanceCents)}.`;
  }
  return `${head} ${member.displayName}: ${s.summary}`;
}
