import { useEffect, useState } from "preact/hooks";
import { api, type Bootstrap, type DelinquencyReport, type RosterEntry } from "../api";
import { formatDate, formatDollars } from "../format";
import { navigate } from "../router";

/**
 * The print-and-read-out list. Designed to be legible on paper as well as on a
 * phone, because it gets handed to the club president at a meeting.
 */
export function Delinquency({ boot }: { boot: Bootstrap }) {
  const [report, setReport] = useState<DelinquencyReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.delinquency().then(setReport).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div class="empty">{error}</div>;
  if (!report) return <div class="empty">Loading…</div>;

  const nothing = report.badStanding.length === 0 && report.warning.length === 0;

  return (
    <>
      <div class="print-only" style="margin-bottom:12px">
        <h2 style="margin:0">{report.clubName || "Club"} — dues owed</h2>
        <div style="font-size:10pt">As of {formatDate(report.generatedOn)}</div>
      </div>

      <div class="stats">
        <div class={`stat ${report.badStanding.length ? "bad" : ""}`}>
          <div class="stat-label">Bad standing</div>
          <div class="stat-value">{report.badStanding.length}</div>
          <div class="stat-sub">
            {formatDollars(boot.settings.badStandingThresholdCents)}+ owed
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">Total owed</div>
          <div class="stat-value">{formatDollars(report.totalOwedCents)}</div>
          <div class="stat-sub">{report.warning.length} also falling behind</div>
        </div>
      </div>

      {nothing ? (
        <div class="card">
          <div class="empty">Nobody is behind. Everyone is current or paid ahead.</div>
        </div>
      ) : (
        <>
          <Section
            title="In bad standing"
            badgeClass="bad"
            entries={report.badStanding}
            note={`${formatDollars(boot.settings.badStandingThresholdCents)} or more owed — priority for collection.`}
          />
          <Section
            title="Falling behind"
            badgeClass="warn"
            entries={report.warning}
            note={`${formatDollars(boot.settings.warnThresholdCents)} or more owed.`}
          />
        </>
      )}

      <div class="btn-row no-print">
        <button class="btn primary grow" onClick={() => print()}>
          Print this list
        </button>
      </div>

      <div class="spacer" />
    </>
  );
}

function Section({
  title,
  badgeClass,
  entries,
  note,
}: {
  title: string;
  badgeClass: string;
  entries: RosterEntry[];
  note: string;
}) {
  if (entries.length === 0) return null;

  return (
    <div class="card">
      <div class="card-head">
        <h2>{title}</h2>
        <span class={`badge ${badgeClass}`}>{entries.length}</span>
      </div>
      <div class="card-body tight">
        <div class="ledger-wrap">
          <table class="ledger">
            <thead>
              <tr>
                <th class="left">Member</th>
                <th>Months</th>
                <th>Owed</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td class="left">
                    <button
                      style="background:none;border:0;padding:0;color:inherit;font:inherit;text-align:left;cursor:pointer"
                      onClick={() => navigate(`/member/${e.id}`)}
                    >
                      {e.displayName}
                    </button>
                    {e.phone && <div class="date">{e.phone}</div>}
                  </td>
                  <td>{e.standing.state === "behind" ? e.standing.monthsBehind : "—"}</td>
                  <td class="debit">
                    <strong>{formatDollars(e.balanceCents)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div class="card-body">
          <div class="hint">{note}</div>
        </div>
      </div>
    </div>
  );
}
