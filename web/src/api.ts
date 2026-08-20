import type { Standing } from "../../src/lib/standing";
import type { RosterEntry } from "../../src/lib/roster";
import type { LedgerEntry, PaymentMethod, StatusRow, ClubSettings } from "../../src/types";

export type { Standing, RosterEntry, LedgerEntry, PaymentMethod, StatusRow, ClubSettings };

export interface Bootstrap {
  settings: ClubSettings;
  statuses: StatusRow[];
  actorEmail: string;
  today: string;
  currentPeriod: string;
  nextPostingDate: string;
  methods: PaymentMethod[];
}

export interface Dashboard {
  today: string;
  currentPeriod: string;
  nextPostingDate: string;
  thisMonthPostingDate: string;
  collectedThisMonthCents: number;
  collectedThisYearCents: number;
  outstandingCents: number;
  prepaidCents: number;
  memberCount: number;
  badStanding: RosterEntry[];
  warning: RosterEntry[];
  paidAhead: RosterEntry[];
  unpostedPeriods: string[];
}

export interface DelinquencyReport {
  clubName: string;
  generatedOn: string;
  badStanding: RosterEntry[];
  warning: RosterEntry[];
  totalOwedCents: number;
}

const SESSION_EXPIRED = "Session expired — reload to sign in again.";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    // 403 from Access means the session expired; a reload re-triggers the
    // Access login rather than leaving a dead-looking screen.
    if (res.status === 403) message = SESSION_EXPIRED;
    throw new ApiError(message, res.status);
  }

  // An expired Access session does not come back as an error status: Access
  // redirects to its login page, which arrives here as HTML with status 200.
  // Without this guard that falls through to res.json() and surfaces as a raw
  // "Unexpected token '<'" parse error rather than something actionable.
  const contentType = res.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiError(SESSION_EXPIRED, 401);
  }

  return res.json() as Promise<T>;
}

const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });

export const api = {
  bootstrap: () => request<Bootstrap>("/bootstrap"),
  dashboard: () => request<Dashboard>("/dashboard"),

  members: (includeArchived = false) =>
    request<{ members: RosterEntry[] }>(`/members${includeArchived ? "?archived=1" : ""}`),

  member: (id: string) =>
    request<{ member: RosterEntry; ledger: LedgerEntry[] }>(`/members/${id}`),

  createMember: (body: unknown) => post<{ member: RosterEntry }>("/members", body),

  updateMember: (id: string, body: unknown) =>
    request<{ member: RosterEntry }>(`/members/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  archiveMember: (id: string, archived: boolean) =>
    post<{ ok: boolean }>(`/members/${id}/archive`, { archived }),

  createTransaction: (body: unknown) =>
    post<{ transactionId: string; member: RosterEntry }>("/transactions", body),

  updateTransaction: (id: string, body: unknown) =>
    request<{ member: RosterEntry }>(`/transactions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  deleteTransaction: (id: string) =>
    request<{ member: RosterEntry }>(`/transactions/${id}`, { method: "DELETE" }),

  voidTransaction: (id: string, reason: string) =>
    post<{ member: RosterEntry }>(`/transactions/${id}/void`, { reason }),

  transactions: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request<{ transactions: (LedgerEntry & { member_name: string })[] }>(
      `/transactions${qs ? `?${qs}` : ""}`,
    );
  },

  postDues: () =>
    post<{
      periodsPosted: string[];
      chargesCreated: number;
      totalCents: number;
      membersCharged: number;
    }>("/dues/post"),

  delinquency: () => request<DelinquencyReport>("/reports/delinquency"),

  settings: () => request<{ settings: ClubSettings; statuses: StatusRow[] }>("/settings"),

  saveSettings: (body: unknown) =>
    request<{ settings: ClubSettings }>("/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
};
