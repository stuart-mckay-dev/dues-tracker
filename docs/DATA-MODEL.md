# Data model

D1 (SQLite). The authoritative DDL is [`migrations/0001_init.sql`](../migrations/0001_init.sql);
this document explains *why* the schema looks the way it does.

## Overview

```
statuses ──< members ──< transactions
                          │
settings          posting_runs      audit_log
```

Five tables carry data, two carry history. There is no users table — identity comes from
Cloudflare Access (see [DEPLOYMENT.md](DEPLOYMENT.md)).

---

## Two rules the schema enforces

### 1. Money is integer cents, constrained to whole dollars

```sql
amount_cents INTEGER NOT NULL CHECK (amount_cents > 0 AND amount_cents % 100 = 0)
```

Cents are the storage unit because floats and money must never mix — `0.1 + 0.2` is a
rounding bug waiting to become a member dispute. The `% 100 = 0` constraint enforces the
whole-dollar rule at the database level rather than in the form, so **no code path can
introduce a stray 83¢**, including a future import script or a manual `wrangler d1 execute`.

Rounding happens exactly once, at entry, in `roundToDollars()` — and the entry form previews
the result (`$47.83 → $48`) before saving, so nothing is ever silently adjusted.

Whole dollars are what make the "months prepaid" answer exact. With a whole-dollar dues rate,
 `credit / dues` is always a clean number of months
with a clean dollar remainder — never a fractional month that can't be said out loud.

### 2. Amounts are unsigned; direction carries the sign

`amount_cents` is always positive and `direction` is `'debit'` or `'credit'`. This is what
makes the two-column ledger render trivially — each row lands in one column or the other by
its `direction`, with no negative numbers displayed anywhere — and it makes "negative debit"
states unrepresentable.

Balance is therefore always computed as:

```sql
SUM(CASE WHEN direction = 'debit' THEN amount_cents ELSE -amount_cents END)
```

**Positive = the member owes the club. Negative = the member is paid ahead.**

---

## `statuses`

```sql
CREATE TABLE statuses (
  code         TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  accrues_dues INTEGER NOT NULL DEFAULT 1 CHECK (accrues_dues IN (0, 1)),
  sort_order   INTEGER NOT NULL DEFAULT 0
);
```

A reference table rather than a `CHECK` enum, because `accrues_dues` is a **policy decision
the treasurer may change** — if the club votes that suspended members stop accruing, that is
a Settings toggle, not a deploy.

Seeded:

| code | label | accrues_dues |
|---|---|---|
| `active` | Active | 1 |
| `prospect` | Prospect | 1 |
| `suspended` | Suspended | 1 |
| `inactive` | Inactive / on leave | 0 |
| `lifetime` | Lifetime / exempt | 0 |

## `members`

```sql
CREATE TABLE members (
  id                TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL,
  first_name        TEXT,
  last_name         TEXT,
  nickname          TEXT,
  email             TEXT,
  phone             TEXT,
  status            TEXT NOT NULL REFERENCES statuses(code),
  dues_start_period TEXT NOT NULL,   -- 'YYYY-MM'
  joined_on         TEXT,            -- 'YYYY-MM-DD'
  notes             TEXT,
  archived_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
```

`dues_start_period` is the first period the member is charged for. It is what makes new
members non-retroactive: set it to the next period and catch-up will never reach backwards
past it. It also supports the opposite case — a member being entered late whose dues really
did start months ago — by setting it back and letting catch-up post the intervening months.

`archived_at` rather than `DELETE`: a departed member's ledger stays intact for the record,
but they drop out of the roster and stop accruing.

## `transactions`

The ledger itself.

```sql
CREATE TABLE transactions (
  id                TEXT PRIMARY KEY,
  member_id         TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  direction         TEXT NOT NULL,
  amount_cents      INTEGER NOT NULL,
  occurred_on       TEXT NOT NULL,   -- 'YYYY-MM-DD'
  period            TEXT,            -- 'YYYY-MM', dues charges only
  method            TEXT,            -- payments only
  memo              TEXT,
  entered_as_months INTEGER,
  voided_at         TEXT,
  void_reason       TEXT,
  created_at        TEXT NOT NULL
);
```

| `kind` | `direction` | Meaning |
|---|---|---|
| `dues_charge` | debit | The monthly dues charge, auto-posted |
| `misc_debit` | debit | Ad-hoc amount added to what they owe |
| `payment` | credit | Money received |
| `reimbursement_credit` | credit | They bought something for the club |
| `opening_balance` | either | One-time starting position for a new member |

Four `CHECK` constraints keep impossible rows out:

- `direction` must match `kind` (payments can't be debits), except `opening_balance`, which
  legitimately goes either way.
- `period IS NOT NULL` **iff** `kind = 'dues_charge'` — every dues charge declares the month
  it covers, and nothing else claims one. This is what the idempotency index depends on.
- `method` is only set on payments.
- `entered_as_months` is only set when the entry was typed in months rather than dollars; it
  is a record of *how it was entered*, never used in arithmetic.

### The idempotency index

```sql
CREATE UNIQUE INDEX ux_dues_once ON transactions (member_id, period)
  WHERE kind = 'dues_charge' AND voided_at IS NULL;
```

**The single most important line in the schema.** It makes double-charging impossible at the
database level rather than merely unlikely in application logic. A cron that fires twice, a
retried request, a manual "Post dues now" clicked after the cron already ran, two browser
tabs — all collapse into a no-op instead of a duplicate charge.

This is what lets the accrual job be written as a naive "post everything missing" loop that
is safe to run any number of times. See [ACCRUAL-RULES.md](ACCRUAL-RULES.md).

The `voided_at IS NULL` clause means a voided charge frees the period to be re-posted, which
is what makes correcting a bad posting possible.

### Voiding vs. deleting

`voided_at` / `void_reason` exist so a charge can be reversed without vanishing. Every
balance query filters `WHERE voided_at IS NULL`, so a voided row stops affecting the balance
while staying visible in the ledger (struck through).

The two operations mean **different things**, and the difference is what makes forgiving a
month possible at all:

| Action | Balance | Catch-up |
|---|---|---|
| **Void** — the month is *waived* | Excluded | Will **not** re-post it |
| **Delete** — it *never happened* | Excluded | **Re-posts** it on the next run |

The hinge is one easily-missed `WHERE` clause: `duesPeriodsByMember` (the catch-up input)
deliberately does **not** filter `voided_at`, so a waived period still counts as "already
charged" and never comes back. Every balance query does filter it.

Without that, deleting a dues charge to forgive it would be silently undone by the next cron
run. Delete keeps its own use — repairing a bad import or an accidental removal, where the
row *should* be rebuilt. Both behaviours have dedicated tests. See
[ACCRUAL-RULES.md](ACCRUAL-RULES.md) and [DECISIONS.md](DECISIONS.md) D12.

Ordinary corrections to non-dues entries go through plain edit/delete with an `audit_log`
entry — friendlier for a single treasurer than a strictly append-only ledger, and nothing
re-creates those rows.

## `settings`

Key/value, so adding a setting never needs a migration.

| key | default | meaning |
|---|---|---|
| `monthly_dues_cents` | `2500` | placeholder rate; set the real one in Settings |
| `warn_threshold_cents` | `15000` | 6 months at the placeholder rate — amber |
| `bad_standing_threshold_cents` | `45000` | 18 months at the placeholder rate — red |
| `club_timezone` | `America/Los_Angeles` | posting-date arithmetic |
| `club_name` | `""` | report headers |
| `posting_rule` | `first_saturday_plus_5` | reserved for future rules |

Thresholds are stored in cents, not months, so they stay correct when reimbursements and
misc debits move a balance off an exact multiple of the dues rate.

## `posting_runs`

One row per period actually posted, recording `posting_date`, `member_count`, `total_cents`,
and `triggered_by` (`cron` | `manual`). A catch-up run covering 20 months writes 20 rows.

This is the audit trail for the automatic behaviour — the thing you check when a member
insists they were charged twice in March.

## `audit_log`

```sql
id, at, actor_email, action, entity, entity_id, before_json, after_json
```

Every mutation writes one row. `actor_email` comes from the verified
`Cf-Access-Authenticated-User-Email` header, so attribution is free and requires no user
table. `before_json` / `after_json` make any correction reconstructable.

---

## What is deliberately *not* stored

**Balances.** There is no cached `balance` column on `members`. Balances are computed by
aggregate query on every read:

```sql
SELECT member_id,
       SUM(CASE WHEN direction = 'debit' THEN amount_cents ELSE -amount_cents END) AS balance_cents
FROM transactions
WHERE voided_at IS NULL
GROUP BY member_id;
```

A stored balance is a denormalisation that must be updated in lockstep with every insert,
edit, void, and delete — and the first time one path misses, the roster silently lies about
who owes money. At club scale (tens of members, low thousands of rows) the aggregate is
instantaneous, and it cannot drift.

**Standing flags.** `bad_standing` and `warning` are not columns. They are derived from the
balance at read time, which means changing a threshold in Settings re-flags the whole roster
immediately with no backfill.

**Months prepaid / next due.** Also derived — see `src/lib/standing.ts` and
[ACCRUAL-RULES.md](ACCRUAL-RULES.md).
