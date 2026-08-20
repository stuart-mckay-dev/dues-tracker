# Decisions

Choices worth remembering, with the reasoning. Newest last.

---

## D1 — A running-balance ledger, not a paid/unpaid checklist

**Decision.** Model every member as a two-column debit/credit ledger with a running balance.

**Why.** The club's money moves in three shapes a checklist cannot express: paying ahead,
falling behind by many months, and reimbursements flowing back to members. A ledger
represents all three natively, and everything else the treasurer needs — months behind,
months prepaid, bad standing — becomes a derivation of one number rather than separately
tracked state.

---

## D2 — Cloudflare Workers + D1, behind Cloudflare Access

**Decision.** Host on the treasurer's existing Cloudflare account; delegate all
authentication to Cloudflare Access using the Zero Trust policy group already configured.

**Why.** The account and Zero Trust policies already exist. The app therefore ships with no
login screen, no session handling, no password storage, and no password reset flow — an
entire category of code and risk removed. D1's free tier covers a club roster indefinitely,
and the verified Access email gives audit attribution for free.

**Consequence.** The Worker must independently verify the Access JWT (see D3).

---

## D3 — Verify the Access JWT in the Worker, and disable `workers.dev`

**Decision.** Two independent controls: `workers_dev = false` in `wrangler.toml`, *and*
signature/`aud`/`exp` verification of `Cf-Access-Jwt-Assertion` on every `/api/*` request.

**Why.** Cloudflare Access protects a *route on a custom domain*. It does **not** protect the
`*.workers.dev` URL, which is public by default — a very common and very quiet way to deploy
an "Access-protected" app that anyone on the internet can read and write. Disabling the
bypass URL removes the known hole; verifying the JWT means that even a future route
misconfiguration fails closed rather than open.

For a system holding members' names and what they owe, failing closed is the only acceptable
default.

---

## D4 — Balances are computed, never stored

**Decision.** No cached `balance` column. Every read aggregates the transactions table.

**Why.** A stored balance must be updated in lockstep with every insert, edit, void, and
delete. The first time one path misses, the roster silently lies about who owes money — and
a *silent* wrong answer is far worse here than a slow one, because the treasurer acts on it
in front of the member. At club scale the aggregate is instantaneous.

The same reasoning applies to bad-standing flags, months behind, and months prepaid: all
derived at read time. A threshold change in Settings re-flags the whole roster immediately,
with no backfill.

---

## D5 — Idempotency enforced by a partial unique index

**Decision.**
`CREATE UNIQUE INDEX ux_dues_once ON transactions(member_id, period) WHERE kind = 'dues_charge' AND voided_at IS NULL`,
with all dues inserts using `ON CONFLICT DO NOTHING`.

**Why.** Duplicate dues charges are the worst available bug: they are invisible (one more dues line
among many), they compound monthly, and they eventually accuse a paid-up member of being in
bad standing. Enforcing uniqueness in the database rather than in application logic means no
retry, concurrent tab, or future code path can produce one.

**Consequence, and the real payoff.** The accrual job can be written as a naive "insert
everything missing" loop that is safe to run at any frequency. That is what makes catch-up
self-healing: a missed cron simply resolves itself on the next run.

---

## D6 — Whole dollars, stored as integer cents

**Decision.** Amounts are integer cents with `CHECK (amount_cents % 100 = 0)`. Entry rounds
to the nearest dollar, and the form previews the rounded value before saving.

**Why.** Cents-as-integers because floats and money must never mix. The whole-dollar
constraint because it makes `credit / dues` an exact number of months — which is what makes
"you're good for 3 more months" a sentence the treasurer can say with confidence. Fractional
months cannot be stated out loud.

Enforcing it as a database constraint rather than form validation means no import script or
manual `d1 execute` can introduce a stray 83¢ later.

**Tradeoff, accepted.** A $47.83 reimbursement is recorded as $48 — a 17¢ gift to the
member. Rounding is previewed, never silent.

---

## D7 — `monthsRemaining` counts the current month

**Decision.** "Good for 3 more months" in August means August, September, October, with the
next payment due in November.

**Why.** It matches what a member means when they ask — they want to know whether they owe
anything *today*, and August is already covered. It also keeps the month count and the
next-due month consistent with each other; an exclusive count would say "good for 2 more
months, next due November", which invites a dispute.

---

## D8 — Standing anchors on `lastPosted`, not on the calendar

**Decision.** `coveredThrough = lastPosted + floor(credit / dues)`, where `lastPosted` is the
member's most recent dues charge — not the current month.

**Why.** It makes the answer **stable across the posting date**. When the cron runs, it
advances `lastPosted` by one month and consumes one month of credit; the two cancel exactly,
so a member asking on the 5th and on the 7th gets the same answer. Anchoring on the current
period instead would make the reply jump by a month every time the cron fired — which the
member would notice and dispute.

This is subtle enough to break accidentally during a refactor, so it has a dedicated test.

---

## D9 — Statuses are a table, not an enum

**Decision.** `statuses(code, label, accrues_dues, sort_order)` as a reference table.

**Why.** Whether suspended members keep accruing dues is a **club policy decision**, not an
engineering one, and the club may vote to change it. As a table it is a Settings toggle; as a
hardcoded enum it is a migration and a deploy.

Current policy: Active, Prospect, and Suspended accrue; Inactive and Lifetime do not.

---

## D10 — Standing flags ignore status

**Decision.** Bad-standing and warning flags are evaluated on balance alone, regardless of
member status.

**Why.** The flag describes *money owed*, not participation. A member who ran up 20 months of
debt and was then moved to Lifetime or Inactive still owes it, and hiding that would defeat the purpose
of the app. Their status stops future accrual; it does not forgive the existing debt.

---

## D11 — Edit-and-delete with an audit log, rather than an append-only ledger

**Decision.** Transactions can be edited and deleted through the UI; every mutation writes an
`audit_log` row with actor, before, and after. Voiding is reserved for dues charges, where
the unique index needs the period released.

**Why.** A strictly append-only ledger is correct for a multi-person finance team, where the
control being enforced is that no one can quietly rewrite history. Here there is exactly one
person, who is also the auditor, and the realistic failure mode is a fat-fingered extra zero on
a dues payment. Forcing a reversing entry for that makes a member's statement harder to
read for no gain in control. The audit log preserves traceability either way.

---

## D12 — Void and delete mean different things

**Decision.** For a dues charge:

- **Void** (`voided_at` set) = *waived*. It stops counting toward the balance, and catch-up
  will **not** re-post it. `duesPeriodsByMember` deliberately includes voided rows.
- **Delete** (row removed) = *never happened*. The period looks missing again, so the next
  run re-posts it.

**Why.** This one was found by testing rather than by design. Catch-up posts every period a
member is missing, which means the obvious way to forgive a month — delete the charge — is
silently undone by the next cron. There was no way to waive dues at all, and the failure was
invisible: the charge simply reappeared days later.

Making void mean "waived" gives the treasurer a real forgiveness action, while delete stays
useful for its own case — repairing a bad import or an accidental removal, where you *want*
the row rebuilt. Both are now covered by tests, because the distinction lives entirely in one
easily-missed `WHERE` clause.

**Consequence in the UI.** Dues charges offer "Waive this month" rather than "Delete", with
the difference explained inline. Other entry types keep a plain delete, since nothing
re-creates them.

---

## D13 — Node 24 LTS, pinned

**Decision.** Pin the project to Node 24 (`.nvmrc`, `engines.node >= 24.19.0`).

**Why.** Node 20 was the machine default but reached end-of-life in April 2026 — no further
security patches — and Vite 8 requires a newer runtime regardless. Node 24 "Krypton" is the
current LTS line. Pinning it in the repo means the version is a property of the project
rather than of whichever shell the treasurer happens to open in two years.

`npm`'s install-script approvals for `esbuild` and `workerd` are pinned by version in
`package.json` under `allowScripts`, so a future install cannot silently run a postinstall
script from a version nobody reviewed.
