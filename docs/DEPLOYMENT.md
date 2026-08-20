# Deployment

Target: Cloudflare Workers + D1 + R2, behind Cloudflare Access using the existing Zero Trust
policy group.

Placeholders to substitute throughout:

| Placeholder | Meaning | Example |
|---|---|---|
| `<TEAM>` | Zero Trust team name | `yourteam` in `yourteam.cloudflareaccess.com` |
| `<DOMAIN>` | Domain on the Cloudflare account | `example.com` |
| `<HOSTNAME>` | Where the app lives | `dues.example.com` |
| `<AUD>` | Access application AUD tag | 64-char hex string |

---

## Prerequisites

```bash
node --version   # must be >= 24.19.0 — run `nvm use` in the repo root
npx wrangler login
```

---

## 1. Create the resources

```bash
npx wrangler d1 create dues-tracker
npx wrangler r2 bucket create dues-tracker-backups
```

Copy the `database_id` from the D1 output into `wrangler.toml`.

## 2. Apply migrations

```bash
npm run db:migrate:local    # local dev database
npm run db:migrate:remote   # production
```

## 3. Deploy once, on a custom domain

The app must be reachable at `<HOSTNAME>` — a route on a real domain, **not** a
`workers.dev` subdomain. Cloudflare Access cannot protect `workers.dev`.

```bash
npm run deploy
```

`wrangler.toml` sets `workers_dev = false`, so no bypass URL is created. Verify after
deploying:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://dues-tracker.<TEAM>.workers.dev
```

Anything other than a failure to resolve or a 404/403 means the bypass URL is live and must
be disabled before the app holds real data.

---

## 4. Put Cloudflare Access in front

In the Zero Trust dashboard → **Access → Applications → Add an application → Self-hosted**:

- **Application domain:** `<HOSTNAME>`
- **Session duration:** 1 month — long enough that the phone is not re-authenticating at
  every meeting
- **Policy:** Allow → the existing policy group

Then copy the **Application Audience (AUD) tag** from the application's Overview tab.

## 5. Configure the Worker to verify Access

Two values, set as Worker vars (not secrets — neither is sensitive, and both are needed to
*reject* traffic):

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN   # <TEAM>.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD           # the AUD tag from step 4
```

For local development, put the same keys in `.dev.vars` (git-ignored).

### Why the Worker verifies the JWT itself

Access enforcement lives on the *route*. If the route is ever misconfigured, removed, or
shadowed, requests reach the Worker with no Access check at all — and a Worker that trusts
the `Cf-Access-Authenticated-User-Email` header without verification would serve the club's
finances to anyone who found the URL.

`src/middleware/access.ts` therefore verifies, on every `/api/*` request:

1. The `Cf-Access-Jwt-Assertion` header is present.
2. Its signature validates against `https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/certs`
   (keys fetched once and cached in the isolate).
3. `aud` contains `ACCESS_AUD` — this is what stops a token minted for a *different* Access
   application on the same team from working here.
4. `exp` has not passed.

Anything else returns `403`. The verified `email` claim becomes `actor_email` on every
`audit_log` row.

Together with `workers_dev = false`, this is defense in depth: the bypass URL does not
exist, and if the route protection ever fails, the app fails **closed**.

---

## 6. Cron triggers

Configured in `wrangler.toml`; no dashboard steps needed.

| Schedule (UTC) | Job |
|---|---|
| `0 15 * * *` | Daily dues-posting check — no-ops unless today ≥ this period's posting date, in club time |
| `0 16 * * 1` | Weekly backup to R2, Monday |

The daily job runs at 15:00 UTC — mid-morning in `America/Los_Angeles` year-round, safely
clear of the local-midnight boundary in either DST state, so it never evaluates "today"
against the wrong calendar date.

Verify locally:

```bash
npx wrangler dev --test-scheduled
curl 'http://localhost:8787/__scheduled?cron=0+15+*+*+*'
```

---

## 7. Post-deploy verification

1. Open `https://<HOSTNAME>` in a private window → Access login prompt appears.
2. Authenticate → dashboard loads.
3. `curl https://<HOSTNAME>/api/dashboard` with no cookie → **403**, not data.
4. Confirm the `workers.dev` URL does not resolve (step 3 above).
5. **Open it on the phone and record a real payment.** This is the acceptance test — the
   phone at a meeting is where the app is actually used, and it is the one environment
   where a layout or session-length problem will actually cost something.

---

## Cost and free-tier headroom

Everything this app uses sits on Cloudflare's free tiers, and not marginally. R2 requires
activating its (free, $0/month) subscription in the dashboard before `wrangler r2 bucket
create` will succeed — the API otherwise returns `code: 10042`.

Measured against a real dataset: 60 members with 25 months of accrual (1,375 transactions)
produces a **515 KB JSON bundle and a 145 KB CSV**, or roughly **467 bytes per transaction**
across both formats.

### R2 — 10 GB storage, 1M Class A ops, 10M Class B ops per month, free

| Horizon (60-member club) | Transactions | One bundle | 26 retained | % of free tier |
|---|---|---|---|---|
| 2 years | 2,160 | 1.0 MB | 26 MB | 0.26% |
| 10 years | 10,800 | 5.1 MB | 131 MB | 1.31% |
| 25 years | 27,000 | 12.6 MB | 328 MB | 3.28% |
| 50 years | 54,000 | 25.2 MB | 656 MB | 6.56% |

Operations are the same story: the weekly job does 2 PUTs, 1 LIST for pruning, and (once
retention kicks in) 2 DELETEs — about **22 Class A operations per month against a million
free**, and effectively zero Class B, because nothing ever reads from R2 in normal operation.
The manual "Download backup" rebuilds from D1 rather than fetching the stored bundle.

### D1 — 5 GB storage, 5M rows read/day, 100K rows written/day, free

Storage is a non-issue: the 1,375-transaction database is 640 KB.

Writes are a non-issue: about 60 rows once a month at accrual, plus a handful of manual
entries, against 100,000 per day.

**Rows read is the only metric worth watching**, because balances are computed rather than
stored (see [DECISIONS.md](DECISIONS.md) D4) — so a dashboard or roster load aggregates over
every transaction:

| Horizon | Rows per page load | Page loads/day before the read limit |
|---|---|---|
| 2 years | ~2,160 | ~2,300 |
| 10 years | ~10,800 | ~460 |
| 25 years | ~27,000 | ~185 |
| 50 years | ~54,000 | ~93 |

For one treasurer this is decades of headroom. If it ever did bind, the fix is a summary
table refreshed on write — **not** reintroducing a cached balance column on `members`, which
is the denormalisation D4 exists to avoid. The invariant is worth more than the reads.

## Backups and recovery

Weekly R2 snapshots (JSON + CSV) with 26-week retention, plus **D1 Time Travel** — 30 days
of point-in-time restore, on by default, requiring no configuration:

```bash
npx wrangler d1 time-travel info dues-tracker
npx wrangler d1 time-travel restore dues-tracker --timestamp=<UNIX_TS>
```

Time Travel is the fast path for "I just deleted the wrong member". The R2 bundles exist for
portability and for handing the books to the next treasurer — a format that outlives the app.

Manual snapshot at any time from **Settings → Download backup**.
