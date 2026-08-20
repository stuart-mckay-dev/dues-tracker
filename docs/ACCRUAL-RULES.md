# Accrual and standing rules

The two pieces of real logic in the app. Implemented in
[`src/lib/accrual.ts`](../src/lib/accrual.ts) and
[`src/lib/standing.ts`](../src/lib/standing.ts); both are pure functions over plain values so
they can be tested without a database.

> **About the numbers.** Dollar figures in these docs are illustrative, using a placeholder
> rate of **$25/month** (the seeded default). The real dues rate and thresholds are set in
> **Settings**; every rule below is expressed in months of dues and scales with the rate.

---

## Part 1 — When dues post

### The rule

> Monthly dues post on the **first Thursday after the first Saturday** of the month.

This is the date of the monthly meeting, where the treasurer collects payments.

Saturday → Thursday is exactly five days, so the rule is deterministic and needs no
weekday searching:

```
firstOfMonth  = YYYY-MM-01
dow           = weekday of firstOfMonth      (0 = Sunday … 6 = Saturday)
daysUntilSat  = (6 - dow + 7) % 7
firstSaturday = 1 + daysUntilSat              // always 1..7
postingDay    = firstSaturday + 5             // always 6..12
```

The result is always a Thursday and always falls between the **6th and the 12th**:

| 1st falls on | First Saturday | Posting date |
|---|---|---|
| Saturday | 1st | **6th** |
| Sunday | 7th | **12th** |
| Monday | 6th | 11th |
| Tuesday | 5th | 10th |
| Wednesday | 4th | 9th |
| Thursday | 3rd | 8th |
| Friday | 2nd | 7th |

Note the 1st-falls-on-Thursday row: the posting date is the **8th**, not the 3rd. The rule is
the Thursday *after the first Saturday*, so a Thursday earlier in the month than the first
Saturday is not it. This is the case a naive "first Thursday of the month" implementation
gets wrong, and it is covered by a test.

### Timezone

The posting date is a **plain calendar date**, and "has it passed yet?" is evaluated against
today's date **in the club's timezone** (`settings.club_timezone`, default
`America/Los_Angeles`) — never UTC. A Workers cron firing at 08:00 UTC is the previous
evening in California, and comparing against a UTC date would post a day early every month.

Because the arithmetic is over whole calendar dates rather than instants, DST transitions
cannot shift the result. Deriving "today" from the correct zone is the only thing that
matters, and it is done once, in `todayInClubTz()`.

### Who gets charged

Every member where:

- `archived_at IS NULL`, **and**
- their status has `accrues_dues = 1` (Active, Prospect, Suspended — not Inactive or
  Lifetime), **and**
- `dues_start_period <= period`

New members are never charged retroactively or prorated: `dues_start_period` is set to the
next period when they are added, so their first charge arrives at the next meeting.

### Idempotency

```sql
CREATE UNIQUE INDEX ux_dues_once ON transactions (member_id, period)
  WHERE kind = 'dues_charge' AND voided_at IS NULL;
```

Every dues insert is `ON CONFLICT DO NOTHING`. Double-charging is therefore impossible at
the storage layer, not merely avoided by careful code — a cron firing twice, a retried
request, a "Post dues now" tap after the cron already ran, or two open browser tabs all
collapse into a no-op.

### Catch-up

The job does **not** post "this month". It posts **every period a member is missing**:

```
for each eligible member:
    from = member.dues_start_period
    to   = today >= postingDate(currentPeriod) ? currentPeriod : previousPeriod
    for each period in from..to:
        INSERT dues_charge ... ON CONFLICT DO NOTHING
```

Combined with the unique index, this makes the job **self-healing and safe to run at any
frequency**. A missed cron, a Cloudflare incident, a laptop-closed weekend, or a member
entered with a backdated `dues_start_period` all resolve themselves on the next run, with no
manual repair and no risk of duplicates.

The `to` bound is what prevents charging for a month whose meeting has not happened yet.

### Waiving a month: void vs. delete

Because catch-up posts *everything* missing, the obvious way to forgive a month — deleting
the charge — is silently undone by the next cron run. So the two operations are given
different meanings:

| Action | Balance | Catch-up |
|---|---|---|
| **Void** (`voided_at` set) | Excluded — the month is **waived** | Will **not** re-post it |
| **Delete** (row removed) | Excluded | **Re-posts** it on the next run |

`duesPeriodsByMember` therefore includes voided rows, while every balance query excludes
them. Delete stays useful for its own case — repairing a bad import or an accidental
removal, where the row *should* come back. Both behaviours have dedicated tests, because the
distinction lives in a single easily-missed `WHERE` clause.

In the UI, dues charges offer **"Waive this month"** rather than "Delete".

### Triggers

- **Daily cron** — no-ops unless today ≥ this period's posting date.
- **Manual "Post dues now"** button on the dashboard.
- The dashboard shows a **banner whenever a period is due but unposted**, so a silently
  failing cron is visible rather than invisible. This matters: an accrual job that quietly
  stops running produces a roster where everyone looks current.

Each period actually posted writes a `posting_runs` row recording the date, member count,
total, and whether it was `cron` or `manual`.

---

## Part 2 — "How many months am I still good for?"

The question members actually ask at meetings. It is a first-class computed field, not
arithmetic done in the treasurer's head from a dollar figure.

### The algorithm

Let `dues` = `monthly_dues_cents`, and `balance` = the signed balance
(**positive = owes**, **negative = paid ahead**).

```
lastPosted      = latest period with a non-voided dues charge for this member
                  (or dues_start_period - 1 month, if never charged)
credit          = -balance                            // only when balance < 0
coveredThrough  = lastPosted + floor(credit / dues) months
monthsRemaining = months from currentPeriod to coveredThrough, INCLUSIVE
nextDue         = coveredThrough + 1 month
leftover        = credit % dues                       // credit that doesn't buy a whole month
```

### Worked example

August 2026. August's dues have posted. The member has a $50 credit (two months).

| | |
|---|---|
| `lastPosted` | `2026-08` |
| `credit` | $50 → buys 2 whole months |
| `coveredThrough` | `2026-08` + 2 = **`2026-10`** |
| `monthsRemaining` | Aug, Sep, Oct = **3** |
| `nextDue` | **`2026-11`** |

> *"You're good for 3 more months — you'll need to pay again in November."*

### Why `monthsRemaining` counts the current month

Because that is what the member means. They are asking whether they owe anything *today*,
and August is already covered — so August counts.

Counting inclusively is also what keeps `monthsRemaining` and `nextDue` consistent with each
other. Under an exclusive count the same member would be "good for 2 more months" but not due
until November, which is the kind of discrepancy that starts an argument at the table.

### Stability across the posting date

The answer must not change when the cron runs. It doesn't — and the reason is worth
recording, because it is easy to break during a refactor.

Take the same member on either side of the August posting:

| | Aug 5 (before posting) | Aug 7 (after posting) |
|---|---|---|
| balance | −$75 | −$50 |
| `lastPosted` | `2026-07` | `2026-08` |
| `floor(credit / dues)` | 3 | 2 |
| `coveredThrough` | Jul + 3 = **Oct** | Aug + 2 = **Oct** |
| `monthsRemaining` | **3** | **3** |
| `nextDue` | **Nov** | **Nov** |

Posting simultaneously advances `lastPosted` by one month and consumes one month of credit.
The two cancel exactly. Anchoring on `lastPosted` rather than on the calendar is what buys
this property; anchoring on `currentPeriod` would make the answer jump by a month every time
the cron fired. There is a test asserting the two columns above match.

### Edge cases

| Situation | Result |
|---|---|
| Balance owed | `Owes $450 · 18 months behind` — no prepaid figure |
| Balance exactly $0 | `Square · good through August · next payment due September` |
| Credit not a whole multiple of dues ($65) | `Paid ahead $65 · good through October · next due November · $15 carried` |
| Never charged yet (brand-new member) | `lastPosted` falls back to `dues_start_period − 1`, so a member who prepays before their first charge still reads correctly |
| Non-accruing status (Lifetime / Inactive) | `Exempt — no dues accruing`; a balance still shows if they carry one |

### Months behind uses `floor` too

`monthsBehind = floor(balance / dues)`, with the remainder shown separately — symmetric with
the prepaid side. A member owing $455 reads `18 months behind · $5`, not "19 months behind",
which would overstate the debt on a balance nudged off a round number by a misc debit.

The bad-standing and warning flags are evaluated on **dollars, not months**
(`balance >= bad_standing_threshold_cents` and `balance >= warn_threshold_cents`), so they stay correct regardless of how
reimbursements and ad-hoc charges move a balance off an exact multiple of the dues rate.
Thresholds are inclusive: a balance exactly at the bad-standing threshold is bad standing.
