import type { DateStr, Period } from "./lib/period";

/**
 * Bindings (DB, BACKUPS, ASSETS) are generated from wrangler.toml into
 * worker-configuration.d.ts by `npm run types`. Secrets and dev vars are not
 * in that file, so they are declared here — augmenting the generated interface
 * rather than shadowing it, so the two can never drift apart.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      /** e.g. 'myteam.cloudflareaccess.com' — see docs/DEPLOYMENT.md */
      ACCESS_TEAM_DOMAIN?: string;
      /** Access application AUD tag. */
      ACCESS_AUD?: string;

      /** Local development only. Never set in production — disables auth. */
      DEV_SKIP_ACCESS?: string;
      DEV_ACTOR_EMAIL?: string;
    }
  }
}

export type Env = Cloudflare.Env;

export type StatusCode =
  | "active"
  | "prospect"
  | "suspended"
  | "inactive"
  | "lifetime";

export type TransactionKind =
  | "dues_charge"
  | "misc_debit"
  | "payment"
  | "reimbursement_credit"
  | "opening_balance";

export type Direction = "debit" | "credit";

export type PaymentMethod = "cash" | "venmo" | "zelle" | "check" | "other";

export interface ClubSettings {
  monthlyDuesCents: number;
  warnThresholdCents: number;
  badStandingThresholdCents: number;
  clubTimezone: string;
  clubName: string;
}

export interface StatusRow {
  code: StatusCode;
  label: string;
  accrues_dues: number;
  sort_order: number;
}

export interface MemberRow {
  id: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  nickname: string | null;
  email: string | null;
  phone: string | null;
  status: StatusCode;
  dues_start_period: Period;
  joined_on: DateStr | null;
  notes: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A member joined to their status and aggregated ledger totals. */
export interface MemberWithBalance extends MemberRow {
  status_label: string;
  accrues_dues: number;
  balance_cents: number;
  last_posted_period: Period | null;
}

export interface TransactionRow {
  id: string;
  member_id: string;
  kind: TransactionKind;
  direction: Direction;
  amount_cents: number;
  occurred_on: DateStr;
  period: Period | null;
  method: PaymentMethod | null;
  memo: string | null;
  entered_as_months: number | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
}

/** A ledger row with the running balance after it is applied. */
export interface LedgerEntry extends TransactionRow {
  running_balance_cents: number;
}
