# DuesTracker — Planning

The club dues ledger. This is the top-level document; the deeper detail lives in
[DATA-MODEL.md](DATA-MODEL.md), [ACCRUAL-RULES.md](ACCRUAL-RULES.md),
[DEPLOYMENT.md](DEPLOYMENT.md), and [DECISIONS.md](DECISIONS.md).

> **About the numbers.** Dollar figures in these docs are illustrative, using a placeholder
> rate of **$25/month** (the seeded default). The real dues rate and thresholds are set in
> **Settings**; every rule below is expressed in months of dues and scales with the rate.

## The problem

The club charges a flat monthly dues rate. Tracking who has paid is not a checklist problem,
because money moves in three different shapes:

1. **Members pay ahead.** Someone pays two months at once at a meeting, so their
   account carries a credit.
2. **Members fall behind**, often by many months. The treasurer needs to know *by how much*
   in order to prioritise collections.
3. **Money flows both ways.** A member buys supplies for the club and is repaid as a credit
   against their dues. Occasionally the reverse: an amount is added to what they owe.

A checklist ("did Dave pay in August?") cannot represent any of these. A **running-balance
ledger** represents all three natively, which is why that is the core of this app: every
member has a traditional two-column debit/credit ledger, and their standing is derived from
the balance rather than tracked separately.

## Who uses it

One person — the club treasurer — from a phone at monthly meetings and from a computer at
home, against the same data. There is no multi-user story, no member self-service login,
and no role system. Authentication is delegated entirely to **Cloudflare Access** using the
treasurer's existing Zero Trust policy group, so the app itself has no login screen and
stores no passwords.

## What it must do

- Record payments, dues charges, reimbursement credits, and miscellaneous debits against a
  member, in a few taps, while standing at a meeting table.
- Post the monthly dues charge automatically on the meeting date.
- Show, at a glance, who is in **bad standing** (18 months behind) and who is
  **falling behind** (6 months behind).
- Answer, instantly, the question members actually ask: *"How many months am I still good
  for?"* — in months, not just dollars, with the month their next payment is due.
- Produce a printable delinquency list and per-member statements.
- Export everything to CSV, and back itself up weekly.

## Domain rules

| Rule | Value |
|---|---|
| Monthly dues | Flat rate, set in Settings |
| Dues posting date | First Thursday after the first Saturday of the month |
| Bad standing | Balance owed ≥ 18 months of dues |
| Falling behind (warning) | Balance owed ≥ 6 months of dues |
| Amounts | Whole dollars only |
| New members | First charged at the next posting; never retroactive or prorated |

The posting date is the monthly meeting, held on the Thursday after the first Saturday.
Since Saturday → Thursday is exactly five days, this is
deterministic: **first Saturday + 5 days**, always landing between the 6th and the 12th.
See [ACCRUAL-RULES.md](ACCRUAL-RULES.md).

### Member statuses

| Status | Accrues dues? |
|---|---|
| Active | Yes |
| Prospect / probationary | Yes |
| Suspended | Yes — still on the books, still owes |
| Inactive / on leave | No |
| Lifetime / exempt | No |

`accrues_dues` is a column on a `statuses` reference table, not a hardcoded enum, so this
behaviour is editable in Settings without a code change.

Bad-standing and warning flags apply **regardless of status** — they describe money owed,
not participation. A lifetime member carrying an old 20-month balance still shows as in bad
standing.

## Architecture

```
Browser (phone / desktop)
   │
   ▼
Cloudflare Access ── enforces the existing Zero Trust policy group
   │  injects Cf-Access-Jwt-Assertion + Cf-Access-Authenticated-User-Email
   ▼
Cloudflare Worker ── Hono router
   ├─ /          → static SPA assets
   ├─ /api/*     → JSON API, JWT verified on every request
   └─ scheduled() → daily dues-posting check, weekly backup
   │
   ├──► D1 (SQLite) — members, transactions, settings, audit
   └──► R2          — weekly backup snapshots
```

**Stack:** TypeScript · Hono (API routing) · Preact + Vite (SPA, ~10kb runtime — it matters
on a phone with bad signal at a meeting) · hand-rolled mobile-first CSS, no component
library · Vitest with `@cloudflare/vitest-pool-workers` for tests against real local D1.

## Screens

**Dashboard** (landing) — collected this month and this year; total outstanding; counts in
bad standing and warning; next posting date, with a banner if a period is due but unposted
and a "Post dues now" button; preview of members in bad standing; and a **Paid ahead panel**
showing each prepaid member's credit *and* months remaining *and* next due month.

**Roster** — searchable, sortable. Name, status chip, balance, and months behind or months
prepaid in the same column position, so the list reads as one continuous scale from
delinquent to prepaid. Bad standing red and pinned to top, warning amber, prepaid green.

**Member detail** — status, balance, and the full plain-English standing sentence; the
two-column ledger (`Date | Memo | Debit | Credit | Balance`); quick entry; print statement.

**Club ledger** — every transaction chronologically, filterable, CSV export.

**Delinquency report** — print-styled, ready to read out at a meeting.

**Settings** — dues amount, thresholds, timezone, per-status accrual flags, manual backup.

## Build status

Phases 0–7 are complete: the app runs, is covered by 99 tests, and has been verified
end-to-end against a local Worker + D1. Phase 8 (deployment) is the remaining step and
needs the treasurer's own Cloudflare account — see [DEPLOYMENT.md](DEPLOYMENT.md).

| # | Phase | Output | Status |
|---|---|---|---|
| 0 | Scaffold + docs | This folder; Wrangler + Vite + TS skeleton | ✅ Done |
| 1 | Data layer | D1 migrations, seeds, typed query helpers | ✅ Done |
| 2 | API + auth | Hono routes, Access JWT verification | ✅ Done |
| 3 | Accrual + standing | Posting date, catch-up, idempotency, months-prepaid | ✅ Done |
| 4 | Core UI | Dashboard, roster, member ledger | ✅ Done |
| 5 | Entry + audit | Entry sheet, months toggle, audit log | ✅ Done |
| 6 | Reports | CSV, delinquency list, statements, print CSS | ✅ Done |
| 7 | Backups | Weekly R2 snapshots, manual download | ✅ Done |
| 8 | Deploy | Behind Access; verified on phone | ⏳ Needs Cloudflare account |

### What the code looks like

| Path | Role |
|---|---|
| `src/lib/period.ts` | Calendar arithmetic; the only place a wall clock enters |
| `src/lib/money.ts` | Integer cents, whole-dollar rounding |
| `src/lib/accrual.ts` | Posting-date rule and the catch-up planner — pure |
| `src/lib/standing.ts` | Months behind / months prepaid / next due — pure |
| `src/lib/posting.ts` | The dues job: reads state, asks the planner, writes |
| `src/lib/db.ts` | Typed D1 access; the single balance query |
| `src/lib/roster.ts` | Member + standing, shared by every screen |
| `src/lib/backup.ts` | Weekly R2 snapshot bundle |
| `src/lib/csv.ts` | CSV export with injection-safe quoting |
| `src/middleware/access.ts` | Cloudflare Access JWT verification |
| `src/routes/api.ts` | The JSON API — see [API.md](API.md) |
| `web/` | Preact SPA |

### Test coverage

99 tests across two Vitest projects:

- **`unit`** — pure logic in plain Node. The posting rule is asserted across all 84 months of
  2024–2030 (every starting weekday, including the case where the 1st is a Thursday), the
  standing math against the worked example and its edge cases, and the stability property
  across 13 prepayment levels.
- **`worker`** — inside workerd against a real local D1 with these migrations applied, so the
  `CHECK` constraints and the partial unique index are the thing under test rather than a
  mock. Covers idempotency under repeat and concurrent runs, 20-month catch-up, gap repair,
  void-vs-delete, status eligibility, and R2 backup retention.

## Non-goals

Deliberately out of scope, to keep the app something one person can maintain:

- Member-facing logins or self-service payment
- Online payment processing (Venmo/Zelle are recorded, not integrated)
- Multi-club or multi-treasurer support
- Accounting beyond dues — this is not a general club treasury or budget tool
- Email/SMS dunning notifications
