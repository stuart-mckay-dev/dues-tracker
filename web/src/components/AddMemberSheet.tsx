import { useState } from "preact/hooks";
import { api, type Bootstrap } from "../api";
import { addMonths } from "../../../src/lib/period";
import { formatPeriodLong } from "../format";

export function AddMemberSheet({
  boot,
  onClose,
  onSaved,
}: {
  boot: Bootstrap;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Defaults to next month, so joining mid-cycle never produces a retroactive
  // or prorated charge.
  const defaultStart = addMonths(boot.currentPeriod, 1);

  const [displayName, setDisplayName] = useState("");
  const [nickname, setNickname] = useState("");
  const [status, setStatus] = useState("active");
  const [duesStartPeriod, setDuesStart] = useState(defaultStart);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [openingBalance, setOpening] = useState("");
  const [openingOwes, setOpeningOwes] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!displayName.trim()) {
      setError("A name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.createMember({
        displayName: displayName.trim(),
        nickname: nickname.trim() || undefined,
        status,
        duesStartPeriod,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        openingBalance: openingBalance.trim() || undefined,
        openingBalanceOwes: openingOwes,
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true">
        <h2>Add member</h2>

        <div class="field">
          <label for="m-name">Name</label>
          <input
            id="m-name"
            type="text"
            value={displayName}
            onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="field">
          <label for="m-nick">Nickname</label>
          <input
            id="m-nick"
            type="text"
            value={nickname}
            onInput={(e) => setNickname((e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="field">
          <label for="m-status">Status</label>
          <select
            id="m-status"
            value={status}
            onChange={(e) => setStatus((e.target as HTMLSelectElement).value)}
          >
            {boot.statuses.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
                {s.accrues_dues ? "" : " (no dues)"}
              </option>
            ))}
          </select>
        </div>

        <div class="field">
          <label for="m-start">Dues start</label>
          <input
            id="m-start"
            type="month"
            value={duesStartPeriod}
            onInput={(e) => setDuesStart((e.target as HTMLInputElement).value)}
          />
          <div class="hint">
            First charged for {formatPeriodLong(duesStartPeriod)}. Defaults to next month, so
            joining mid-cycle is never charged retroactively.
          </div>
        </div>

        <div class="field">
          <label for="m-email">Email</label>
          <input
            id="m-email"
            type="email"
            value={email}
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="field">
          <label for="m-phone">Phone</label>
          <input
            id="m-phone"
            type="tel"
            value={phone}
            onInput={(e) => setPhone((e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="field">
          <label for="m-opening">Opening balance (optional)</label>
          <input
            id="m-opening"
            type="text"
            inputMode="decimal"
            placeholder="0"
            value={openingBalance}
            onInput={(e) => setOpening((e.target as HTMLInputElement).value)}
          />
          {openingBalance.trim() !== "" && (
            <div class="segmented" style="margin-top:8px">
              <button aria-pressed={openingOwes} onClick={() => setOpeningOwes(true)}>
                They owe it
              </button>
              <button aria-pressed={!openingOwes} onClick={() => setOpeningOwes(false)}>
                Credit to them
              </button>
            </div>
          )}
          <div class="hint">Use this only when carrying over an existing balance.</div>
        </div>

        {error && <div class="hint error">{error}</div>}

        <div class="btn-row">
          <button class="btn grow" onClick={onClose}>
            Cancel
          </button>
          <button class="btn primary grow" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Add member"}
          </button>
        </div>
      </div>
    </div>
  );
}
