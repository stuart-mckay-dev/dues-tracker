import { useState } from "preact/hooks";
import { api, type Bootstrap, type RosterEntry } from "../api";
import { formatPeriodLong } from "../format";

export function EditMemberSheet({
  member,
  boot,
  onClose,
  onSaved,
}: {
  member: RosterEntry;
  boot: Bootstrap;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(member.displayName);
  const [nickname, setNickname] = useState(member.nickname ?? "");
  const [status, setStatus] = useState(member.status);
  const [duesStartPeriod, setDuesStart] = useState(member.duesStartPeriod);
  const [email, setEmail] = useState(member.email ?? "");
  const [phone, setPhone] = useState(member.phone ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = boot.statuses.find((s) => s.code === status);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.updateMember(member.id, {
        displayName: displayName.trim(),
        nickname: nickname.trim() || null,
        status,
        duesStartPeriod,
        email: email.trim() || null,
        phone: phone.trim() || null,
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  async function toggleArchive() {
    const archiving = !member.archived;
    if (
      archiving &&
      !confirm(`Archive ${member.displayName}? Their ledger is kept, but they stop accruing dues.`)
    ) {
      return;
    }
    setSaving(true);
    try {
      await api.archiveMember(member.id, archiving);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true">
        <h2>Edit {member.displayName}</h2>

        <div class="field">
          <label for="e-name">Name</label>
          <input
            id="e-name"
            type="text"
            value={displayName}
            onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="field">
          <label for="e-nick">Nickname</label>
          <input
            id="e-nick"
            type="text"
            value={nickname}
            onInput={(e) => setNickname((e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="field">
          <label for="e-status">Status</label>
          <select
            id="e-status"
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
          {chosen && !chosen.accrues_dues && (
            <div class="hint">
              Stops future dues. Any balance already owed stays on the books.
            </div>
          )}
        </div>

        <div class="field">
          <label for="e-start">Dues start</label>
          <input
            id="e-start"
            type="month"
            value={duesStartPeriod}
            onInput={(e) => setDuesStart((e.target as HTMLInputElement).value)}
          />
          <div class="hint">
            Charged from {formatPeriodLong(duesStartPeriod)}. Moving this earlier will post the
            missing months on the next run.
          </div>
        </div>

        <div class="field">
          <label for="e-email">Email</label>
          <input
            id="e-email"
            type="email"
            value={email}
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="field">
          <label for="e-phone">Phone</label>
          <input
            id="e-phone"
            type="tel"
            value={phone}
            onInput={(e) => setPhone((e.target as HTMLInputElement).value)}
          />
        </div>

        {error && <div class="hint error">{error}</div>}

        <div class="btn-row">
          <button class="btn grow" onClick={onClose}>
            Cancel
          </button>
          <button class="btn primary grow" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>

        <div class="spacer" />

        <button class="btn danger block" onClick={toggleArchive} disabled={saving}>
          {member.archived ? "Restore member" : "Archive member"}
        </button>
      </div>
    </div>
  );
}
