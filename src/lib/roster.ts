/**
 * Turns member rows into what every screen actually displays: the member plus
 * their computed standing. One place, so the dashboard, the roster, the member
 * page, and the reports can never disagree about how many months someone is
 * good for.
 */

import { computeStanding, type Standing } from "./standing";
import { periodOfDate, todayInTz, type DateStr, type Period } from "./period";
import type { ClubSettings, MemberWithBalance } from "../types";

export interface RosterEntry {
  id: string;
  displayName: string;
  nickname: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  statusLabel: string;
  accruesDues: boolean;
  duesStartPeriod: Period;
  joinedOn: DateStr | null;
  archived: boolean;
  balanceCents: number;
  lastPostedPeriod: Period | null;
  standing: Standing;
}

export function toRosterEntry(
  member: MemberWithBalance,
  settings: ClubSettings,
  currentPeriod: Period,
): RosterEntry {
  return {
    id: member.id,
    displayName: member.display_name,
    nickname: member.nickname,
    email: member.email,
    phone: member.phone,
    status: member.status,
    statusLabel: member.status_label,
    accruesDues: member.accrues_dues === 1,
    duesStartPeriod: member.dues_start_period,
    joinedOn: member.joined_on,
    archived: member.archived_at !== null,
    balanceCents: member.balance_cents,
    lastPostedPeriod: member.last_posted_period,
    standing: computeStanding({
      balanceCents: member.balance_cents,
      duesCents: settings.monthlyDuesCents,
      lastPostedPeriod: member.last_posted_period,
      duesStartPeriod: member.dues_start_period,
      currentPeriod,
      accruesDues: member.accrues_dues === 1,
      warnThresholdCents: settings.warnThresholdCents,
      badStandingThresholdCents: settings.badStandingThresholdCents,
    }),
  };
}

export function currentPeriodFor(settings: ClubSettings, today?: DateStr): Period {
  return periodOfDate(today ?? todayInTz(settings.clubTimezone));
}

const FLAG_RANK = { bad_standing: 0, warning: 1, ok: 2 } as const;

/**
 * Roster order: worst first. Bad standing pinned to the top and sorted by how
 * much is owed, so the collections priority list is simply the top of the
 * screen — which is the whole reason the treasurer opens the app.
 */
export function sortForRoster(entries: RosterEntry[]): RosterEntry[] {
  return [...entries].sort((a, b) => {
    const rank = FLAG_RANK[a.standing.flag] - FLAG_RANK[b.standing.flag];
    if (rank !== 0) return rank;
    if (a.balanceCents !== b.balanceCents) return b.balanceCents - a.balanceCents;
    return a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" });
  });
}

/** Members carrying a credit, most prepaid first — the dashboard panel. */
export function paidAhead(entries: RosterEntry[]): RosterEntry[] {
  return entries
    .filter((e) => e.standing.state === "current" && e.standing.creditCents > 0)
    .sort((a, b) => a.balanceCents - b.balanceCents);
}

export function inBadStanding(entries: RosterEntry[]): RosterEntry[] {
  return sortForRoster(entries.filter((e) => e.standing.flag === "bad_standing"));
}

export function inWarning(entries: RosterEntry[]): RosterEntry[] {
  return sortForRoster(entries.filter((e) => e.standing.flag === "warning"));
}
