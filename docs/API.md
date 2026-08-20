# API

All routes are under `/api` and sit behind `requireAccess()` — every request must carry a
valid Cloudflare Access JWT (see [DEPLOYMENT.md](DEPLOYMENT.md)). Anything else returns
`403`, or `500` if Access is not configured at all. **Missing configuration never means
"let everyone in".**

The verified `email` claim becomes `actor_email` on every `audit_log` row.

Money is always **integer cents** on the wire, and always a whole number of dollars
(`amount_cents % 100 == 0`). Periods are `'YYYY-MM'`; dates are `'YYYY-MM-DD'`.

---

## Bootstrap and dashboard

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/bootstrap` | Settings, statuses, signed-in email, today, next posting date, payment methods. Called once at app start. |
| `GET` | `/api/dashboard` | Totals collected this month/year, outstanding, prepaid, plus the bad-standing, warning and paid-ahead lists and any unposted periods. |

Every member object returned anywhere carries a computed `standing` — see
[ACCRUAL-RULES.md](ACCRUAL-RULES.md):

```jsonc
{
  "state": "current",              // "behind" | "current" | "exempt"
  "flag": "ok",                    // "bad_standing" | "warning" | "ok"
  "balanceCents": -2000,           // + owes, - paid ahead
  "creditCents": 5000,
  "coveredThrough": "2026-10",
  "monthsRemaining": 3,            // inclusive of the current month
  "nextDue": "2026-11",
  "leftoverCents": 0,
  "summary": "Paid ahead $50 · good for 3 more months · next payment due November 2026"
}
```

## Members

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/members` | Roster, worst-first. `?archived=1` includes archived members. |
| `POST` | `/api/members` | `displayName` required. `duesStartPeriod` defaults to **next month**, so joining mid-cycle is never charged retroactively. Optional `openingBalance` (+ `openingBalanceOwes`). |
| `GET` | `/api/members/:id` | Member plus the full ledger with running balances, newest first. |
| `PATCH` | `/api/members/:id` | Partial update. Moving `duesStartPeriod` earlier makes catch-up post the intervening months. |
| `POST` | `/api/members/:id/archive` | `{ "archived": true \| false }`. Archiving keeps the ledger and stops accrual. |

## Transactions

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/transactions` | Create an entry. Returns the member's **new standing** so the UI can confirm on the spot. |
| `PATCH` | `/api/transactions/:id` | Edit amount, date, method, memo. |
| `POST` | `/api/transactions/:id/void` | **Waive** — stops counting toward the balance and is *not* re-posted by catch-up. |
| `DELETE` | `/api/transactions/:id` | Remove entirely. A deleted dues charge *will* be re-posted on the next run. |
| `GET` | `/api/transactions` | Club-wide ledger. Filters: `memberId`, `kind`, `from`, `to`. Capped at 1000 rows. |

Creating an entry:

```jsonc
{
  "memberId": "…",
  "kind": "payment",        // payment | reimbursement_credit | misc_debit | dues_charge | opening_balance
  "amount": "47.83",        // rounds to $48 — or use "months": 2 to mean 2 × dues
  "method": "cash",         // payments only: cash | venmo | zelle | check | other
  "occurredOn": "2026-08-17",
  "memo": "supplies for the club"
}
```

`direction` is derived from `kind` and is not accepted from the client (except for
`opening_balance`, which legitimately goes either way).

## Dues posting

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/dues/post` | Run the posting job manually. Idempotent — safe to call repeatedly. |
| `GET` | `/api/dues/status` | Today, the latest postable period, and any periods due but unposted. |

## Reports, export and backup

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/reports/delinquency` | Bad-standing and warning lists with totals, for the printable page. |
| `GET` | `/api/export/transactions.csv` | Every transaction as CSV. Memos are quoted against spreadsheet formula injection. |
| `GET` | `/api/backup/download` | On-demand JSON snapshot of all tables. |
| `POST` | `/api/backup/run` | Write the weekly bundle to R2 now and prune past the 26-week window. |

## Settings

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/settings` | Settings and the statuses table. |
| `PUT` | `/api/settings` | Club name, timezone, dues amount, both thresholds, and per-status `accruesDues`. Money values are rounded to whole dollars. |

## Errors

| Status | Meaning |
|---|---|
| `400` | Validation failure — the body names the field. |
| `403` | No/invalid/expired Access token, or wrong `aud`. |
| `404` | Member or transaction not found. |
| `500` | Access not configured, or an unexpected error. |

Errors are `{ "error": "message" }`. The SPA turns a `403` into "Session expired — reload to
sign in again", since that is what an expired Access session looks like.
