import { useState } from "preact/hooks";
import { api, type Bootstrap, type StatusRow } from "../api";
import { formatDollars } from "../format";
import type { ToastState } from "../components/Toast";

export function Settings({ boot, toast }: { boot: Bootstrap; toast: ToastState }) {
  const [clubName, setClubName] = useState(boot.settings.clubName);
  const [dues, setDues] = useState(String(boot.settings.monthlyDuesCents / 100));
  const [warn, setWarn] = useState(String(boot.settings.warnThresholdCents / 100));
  const [bad, setBad] = useState(String(boot.settings.badStandingThresholdCents / 100));
  const [timezone, setTimezone] = useState(boot.settings.clubTimezone);
  const [statuses, setStatuses] = useState<StatusRow[]>(boot.statuses);
  const [saving, setSaving] = useState(false);

  const duesCents = Math.round(Number(dues) || 0) * 100;
  const badMonths = duesCents > 0 ? Math.round((Number(bad) * 100) / duesCents) : 0;
  const warnMonths = duesCents > 0 ? Math.round((Number(warn) * 100) / duesCents) : 0;

  async function save() {
    setSaving(true);
    try {
      await api.saveSettings({
        clubName,
        monthlyDuesCents: Math.round(Number(dues) || 0) * 100,
        warnThresholdCents: Math.round(Number(warn) || 0) * 100,
        badStandingThresholdCents: Math.round(Number(bad) || 0) * 100,
        clubTimezone: timezone,
        statuses: statuses.map((s) => ({ code: s.code, accruesDues: s.accrues_dues === 1 })),
      });
      toast.show("Settings saved. Reload to see them applied everywhere.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function toggleStatus(code: string) {
    setStatuses((prev) =>
      prev.map((s) => (s.code === code ? { ...s, accrues_dues: s.accrues_dues === 1 ? 0 : 1 } : s)),
    );
  }

  return (
    <>
      <div class="card">
        <div class="card-head">
          <h2>Club</h2>
        </div>
        <div class="card-body">
          <div class="field">
            <label for="s-name">Club name</label>
            <input
              id="s-name"
              type="text"
              value={clubName}
              onInput={(e) => setClubName((e.target as HTMLInputElement).value)}
            />
            <div class="hint">Shown on printed reports.</div>
          </div>

          <div class="field">
            <label for="s-tz">Timezone</label>
            <input
              id="s-tz"
              type="text"
              value={timezone}
              onInput={(e) => setTimezone((e.target as HTMLInputElement).value)}
            />
            <div class="hint">
              Used to decide when the meeting date has arrived. An IANA name like
              America/Los_Angeles.
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Dues and thresholds</h2>
        </div>
        <div class="card-body">
          <div class="field">
            <label for="s-dues">Monthly dues ($)</label>
            <input
              id="s-dues"
              type="number"
              min="1"
              step="1"
              value={dues}
              onInput={(e) => setDues((e.target as HTMLInputElement).value)}
            />
          </div>

          <div class="field">
            <label for="s-bad">Bad standing at ($)</label>
            <input
              id="s-bad"
              type="number"
              min="0"
              step="1"
              value={bad}
              onInput={(e) => setBad((e.target as HTMLInputElement).value)}
            />
            <div class="hint">
              {duesCents > 0 && `${badMonths} months of dues. `}
              Flags are evaluated on dollars, so they stay correct when reimbursements move a
              balance off a round number.
            </div>
          </div>

          <div class="field">
            <label for="s-warn">Falling behind at ($)</label>
            <input
              id="s-warn"
              type="number"
              min="0"
              step="1"
              value={warn}
              onInput={(e) => setWarn((e.target as HTMLInputElement).value)}
            />
            <div class="hint">{duesCents > 0 && `${warnMonths} months of dues.`}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Who accrues dues</h2>
        </div>
        <div class="card-body tight">
          <ul class="rows">
            {statuses.map((s) => (
              <li key={s.code}>
                <div class="row" style="cursor:default">
                  <span class="row-main">
                    <span class="row-name">{s.label}</span>
                    <span class="row-sub">
                      {s.accrues_dues ? "Charged every month" : "No dues charged"}
                    </span>
                  </span>
                  <button
                    class={`btn ${s.accrues_dues ? "primary" : ""}`}
                    onClick={() => toggleStatus(s.code)}
                  >
                    {s.accrues_dues ? "Accrues" : "Exempt"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div class="card-body">
          <div class="hint">
            Club policy, not a code change. A member's status stops future dues; it never
            forgives a balance already owed.
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Data</h2>
        </div>
        <div class="card-body">
          <a class="btn block" href="/api/export/transactions.csv">
            Export all transactions (CSV)
          </a>
          <div class="spacer" />
          <a class="btn block" href="/api/backup/download">
            Download full backup (JSON)
          </a>
          <div class="hint">
            Backups also run automatically every Monday, keeping 26 weeks. D1 keeps 30 days of
            point-in-time restore on top of that.
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-body">
          <div class="muted" style="font-size:.82rem">
            Signed in as {boot.actorEmail}
          </div>
          <div class="muted" style="font-size:.82rem">
            Dues {formatDollars(boot.settings.monthlyDuesCents)}/month · today {boot.today}
          </div>
        </div>
      </div>

      <button class="btn primary block" onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save settings"}
      </button>

      <div class="spacer" />
    </>
  );
}
