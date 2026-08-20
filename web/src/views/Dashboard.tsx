import { useEffect, useState } from "preact/hooks";
import { api, type Bootstrap, type Dashboard as DashboardData, type RosterEntry } from "../api";
import { navigate } from "../router";
import { formatDate, formatDollars, formatPeriodLong } from "../format";
import { MemberRow } from "../components/MemberRow";
import type { ToastState } from "../components/Toast";

export function Dashboard({
  boot,
  onChanged,
  toast,
}: {
  boot: Bootstrap;
  onChanged: () => void;
  toast: ToastState;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    api.dashboard().then(setData).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div class="empty">{error}</div>;
  if (!data) return <div class="empty">Loading…</div>;

  async function postDues() {
    setPosting(true);
    try {
      const result = await api.postDues();
      if (result.chargesCreated === 0) {
        toast.show("Already up to date — nothing to post.");
      } else {
        toast.show(
          `Posted ${result.chargesCreated} charge${result.chargesCreated === 1 ? "" : "s"} ` +
            `(${formatDollars(result.totalCents)}) for ${result.periodsPosted
              .map(formatPeriodLong)
              .join(", ")}.`,
        );
      }
      const fresh = await api.dashboard();
      setData(fresh);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPosting(false);
    }
  }

  const dues = formatDollars(boot.settings.monthlyDuesCents);

  return (
    <>
      {/* A silently-failing cron produces a roster where everyone looks
          current, so an unposted period has to be visible on the first screen. */}
      {data.unpostedPeriods.length > 0 && (
        <div class="banner">
          <span class="grow">
            <strong>
              {data.unpostedPeriods.length} month
              {data.unpostedPeriods.length === 1 ? "" : "s"} not posted
            </strong>
            <p>{data.unpostedPeriods.map(formatPeriodLong).join(", ")}</p>
          </span>
          <button class="btn primary" onClick={postDues} disabled={posting}>
            {posting ? "Posting…" : "Post dues now"}
          </button>
        </div>
      )}

      <div class="stats">
        <div class="stat">
          <div class="stat-label">Collected this month</div>
          <div class="stat-value">{formatDollars(data.collectedThisMonthCents)}</div>
          <div class="stat-sub">{formatDollars(data.collectedThisYearCents)} this year</div>
        </div>
        <div class={`stat ${data.outstandingCents > 0 ? "bad" : ""}`}>
          <div class="stat-label">Outstanding</div>
          <div class="stat-value">{formatDollars(data.outstandingCents)}</div>
          <div class="stat-sub">across {data.memberCount} members</div>
        </div>
        <div class={`stat ${data.badStanding.length > 0 ? "bad" : ""}`}>
          <div class="stat-label">Bad standing</div>
          <div class="stat-value">{data.badStanding.length}</div>
          <div class="stat-sub">
            {formatDollars(boot.settings.badStandingThresholdCents)}+ owed
          </div>
        </div>
        <div class={`stat ${data.prepaidCents > 0 ? "good" : ""}`}>
          <div class="stat-label">Paid ahead</div>
          <div class="stat-value">{formatDollars(data.prepaidCents)}</div>
          <div class="stat-sub">{data.paidAhead.length} members</div>
        </div>
      </div>

      <div class="card">
        <div class="card-body">
          <div class="btn-row">
            <span class="grow">
              <strong>Next dues posting</strong>
              <div class="muted" style="font-size:.85rem">
                {formatDate(data.nextPostingDate)} · {dues} each
              </div>
            </span>
            <button class="btn" onClick={postDues} disabled={posting}>
              {posting ? "Posting…" : "Post now"}
            </button>
          </div>
        </div>
      </div>

      {/* Capped previews. The dashboard is a summary — listing every
          delinquent member inline turns it into an endless scroll on a phone
          the moment the club has more than a handful. The full lists live on
          the Behind tab, which is built for exactly that. */}
      <PreviewCard
        title="In bad standing"
        badge="bad"
        entries={data.badStanding}
        emptyNote={null}
      />
      <PreviewCard
        title="Falling behind"
        badge="warn"
        entries={data.warning}
        emptyNote={null}
      />

      {/* The answer to "am I still good?" without tapping into a member. */}
      <PreviewCard
        title="Paid ahead"
        badge="good"
        entries={data.paidAhead}
        subtitleFor={prepaidLine}
        emptyNote="Nobody is paid ahead right now."
      />
    </>
  );
}

const PREVIEW_LIMIT = 5;

/**
 * A dashboard card showing at most PREVIEW_LIMIT members, with a link to the
 * full list when there are more.
 */
function PreviewCard({
  title,
  badge,
  entries,
  emptyNote,
  subtitleFor,
}: {
  title: string;
  badge: string;
  entries: RosterEntry[];
  emptyNote: string | null;
  subtitleFor?: (s: import("../api").Standing) => string;
}) {
  if (entries.length === 0 && emptyNote === null) return null;

  const shown = entries.slice(0, PREVIEW_LIMIT);
  const hidden = entries.length - shown.length;

  return (
    <div class="card">
      <div class="card-head">
        <h2>{title}</h2>
        <span class={`badge ${badge}`}>{entries.length}</span>
      </div>
      <div class="card-body tight">
        {entries.length === 0 ? (
          <div class="empty">{emptyNote}</div>
        ) : (
          <>
            <ul class="rows">
              {shown.map((m) => (
                <MemberRow
                  key={m.id}
                  entry={m}
                  subtitle={subtitleFor ? subtitleFor(m.standing) : undefined}
                />
              ))}
            </ul>
            {hidden > 0 && (
              <button class="btn block" onClick={() => navigate("/report")}>
                See all {entries.length} →
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** "good for 3 more months · next due November 2026" */
function prepaidLine(standing: import("../api").Standing): string {
  if (standing.state !== "current") return standing.summary;
  return (
    `good for ${standing.monthsRemaining} more month${standing.monthsRemaining === 1 ? "" : "s"}` +
    ` · next due ${formatPeriodLong(standing.nextDue)}`
  );
}
