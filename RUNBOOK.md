# DuesTracker Runbook

This runbook takes DuesTracker from a fresh clone to a production deployment on Cloudflare, then covers running it day to day. Every step lists the commands to run and the **check** that confirms it worked.

**Architecture at a glance:**

```
Phone / desktop browser
   │  HTTPS
   ▼
Cloudflare edge ── custom-domain route (no workers.dev URL)
   │
   ├─ Cloudflare Access ── Zero Trust policy; injects Cf-Access-Jwt-Assertion
   ▼
Worker "dues-tracker" (Hono)
   ├─ /*          → static SPA from ./dist (Workers Assets)
   ├─ /api/*      → JSON API; Access JWT re-verified on every request
   └─ scheduled() → 15:00 UTC daily dues posting · 16:00 UTC Monday backup
   │
   ├──► D1  "dues-tracker"          members, transactions, settings, audit log
   └──► R2  "dues-tracker-backups"  weekly JSON + CSV snapshots, 26-week retention
```

Everything runs on Cloudflare's free tiers. Capacity math is in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md#cost-and-free-tier-headroom).

**Placeholders** used throughout:

| Placeholder | Meaning | Example |
|---|---|---|
| `<TEAM>` | Zero Trust team name | `yourteam` in `yourteam.cloudflareaccess.com` |
| `<HOSTNAME>` | Where the app lives, on a zone in your account | `dues.example.com` |
| `<AUD>` | Access application audience tag | 64-char hex string |
| `<DB_ID>` | D1 database id | UUID from `wrangler d1 create` |

---

## 1. Local development

### 1.1 Toolchain

```bash
nvm install && nvm use          # Node 24 LTS from .nvmrc (package.json requires >= 24.19.0)
npm install
```

`scripts/dev-api.sh` activates the pinned Node before starting `wrangler dev`. Editors and launchers often inherit the system Node rather than a shell that has run `nvm use`, and Wrangler needs at least Node 22.

### 1.2 Local secrets and auth bypass

```bash
cp .dev.vars.example .dev.vars       # git-ignored
```

`.dev.vars` sets `DEV_SKIP_ACCESS="1"` and a `DEV_ACTOR_EMAIL` for the audit log. Access is skipped only when **both** of these hold:

1. `DEV_SKIP_ACCESS` is `"1"`.
2. The request has **no `CF-Ray` header**, which means it came from a local `workerd` process rather than through Cloudflare's edge.

The check uses `CF-Ray` rather than the hostname because once `routes` is configured, `wrangler dev` presents the production hostname to the Worker even on `localhost:8787`. Cloudflare adds `CF-Ray` to every request through its edge, and a client can't remove it. So a flag left set by mistake in production still can't open the app.

### 1.3 Database and run

```bash
npm run db:migrate:local
npm run dev            # API on :8787, SPA on :5173 with /api proxied
```

To exercise the production shape (the Worker serving the built SPA): `npm run build && npm run dev:api`, then open <http://localhost:8787>.

```bash
npm run db:reset:local   # wipe local members and transactions; never touches production
```

### 1.4 Tests

```bash
npm test             # both Vitest projects
npm run typecheck
npm run types        # regenerate worker-configuration.d.ts after editing wrangler.toml
```

- **`unit`** runs the pure logic in Node.
- **`worker`** runs inside `workerd` via `@cloudflare/vitest-pool-workers`, against a real local D1 with `migrations/` applied plus a real local R2.

**Check:** 103 tests pass and typecheck is clean.

---

## 2. Cloudflare prerequisites (one-time)

1. **A Cloudflare account with a zone (domain) on it.** The app must live on a custom hostname, because Cloudflare Access cannot protect `*.workers.dev`.
2. **Zero Trust onboarded.** In the dashboard, go to **Zero Trust**, pick a team name (this becomes `<TEAM>.cloudflareaccess.com`), and choose the **Free** plan (up to 50 users). Until you do, the section only shows a plan chooser.
3. **An identity provider for Access.** **One-time PIN** (emailed code) works out of the box. Google or GitHub are optional extras under **Settings → Authentication**.
4. **Activate R2.** In **R2 → Overview**, activate the free subscription. Until you do, `wrangler r2 bucket create` fails with `code: 10042`.
5. **Authenticate Wrangler:**

   ```bash
   npx wrangler login
   npx wrangler whoami        # confirm the account it will deploy to
   ```

   If your login can see **several Cloudflare accounts**, add `account_id = "<ACCOUNT_ID>"` to `wrangler.toml`. Otherwise Wrangler may prompt you, or create D1 and R2 resources in the wrong account. A `database_id` from one account doesn't exist in another.

---

## 3. First deployment

### 3.1 Create the resources

```bash
npx wrangler d1 create dues-tracker
npx wrangler r2 bucket create dues-tracker-backups
```

Copy the `database_id` from the D1 output into `wrangler.toml`, replacing the all-zeros placeholder:

```toml
[[d1_databases]]
binding = "DB"
database_name = "dues-tracker"
database_id = "<DB_ID>"
migrations_dir = "migrations"
```

### 3.2 Apply migrations

```bash
npm run db:migrate:remote
npx wrangler d1 execute dues-tracker --remote --command "SELECT key, value FROM settings"
```

**Check:** the settings rows exist. The seeded dues rate and thresholds are placeholders, and you set the real values in the app (step 5).

### 3.3 Set the hostname

In `wrangler.toml`:

```toml
workers_dev = false
routes = [
  { pattern = "<HOSTNAME>", custom_domain = true }
]
```

`custom_domain = true` makes Wrangler create the DNS record and certificate for exactly this hostname. It changes no other record in the zone.

### 3.4 Deploy

```bash
npm run deploy           # vite build → dist/, then wrangler deploy
```

**Check:** the `workers.dev` bypass URL does not exist.

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://dues-tracker.<SUBDOMAIN>.workers.dev
```

A DNS failure, 404 or 403 is correct. Any other response means the bypass URL is live: fix `workers_dev` before storing any real data.

---

## 4. Put Cloudflare Access in front

### 4.1 Create the Access application

Go to **Zero Trust → Access → Applications → Add an application → Self-hosted**:

| Field | Value |
|---|---|
| Application domain | `<HOSTNAME>` |
| Session duration | **1 month**, so the phone isn't re-authenticating at every meeting |
| Identity providers | One-time PIN (and/or others you enabled) |
| Policy | **Allow** → *Emails* → the treasurer's address (or an existing policy group) |

Save, then copy the **Application Audience (AUD) tag** from the application's **Overview** tab.

### 4.2 Tell the Worker how to verify Access

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN   # <TEAM>.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD           # <AUD>
```

Never set `DEV_SKIP_ACCESS` in production.

On every `/api/*` request, `src/middleware/access.ts` checks that:

1. A `Cf-Access-Jwt-Assertion` header is present.
2. Its signature validates against `https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/certs`. The keys are fetched once and cached per isolate.
3. `aud` contains `ACCESS_AUD`. This stops a token issued for another Access application on the same team from working here.
4. `exp` hasn't passed.

If any check fails, the request gets a `403`. The verified `email` claim becomes the `actor_email` on every `audit_log` row.

---

## 5. Post-deploy verification

1. **Login prompt:** open `https://<HOSTNAME>` in a private window. The Access login should appear.
2. **Dashboard:** sign in, and the dashboard should load.
3. **API without a session:** `curl -i https://<HOSTNAME>/api/dashboard` should be blocked by Access and must **not** return JSON data.
4. **Real settings:** go to **Settings** and enter the real dues rate, the warning and bad-standing thresholds, the club name and the timezone. The thresholds are in dollars, and the screen shows each as a number of months for a sanity check.
5. **Statuses:** in **Settings**, confirm which member statuses accrue dues.
6. **Phone acceptance test:** add the app to the phone's home screen and record one real payment. The phone at a meeting is where the app actually gets used. It's also the one environment where layout problems or a short session length would cause real trouble.

---

## 6. Scheduled jobs

These are defined in `wrangler.toml` under `[triggers]` and need no dashboard setup.

| Cron (UTC) | Job | Behaviour |
|---|---|---|
| `0 15 * * *` | Dues posting | Posts every missing period for every eligible member. Does nothing until today is on or after this period's posting date in the club's timezone. |
| `0 16 * * 1` | Weekly backup | Writes a JSON and CSV snapshot to R2 and keeps 26 weeks |

15:00 UTC is mid-morning in `America/Los_Angeles` in both DST states, safely away from local midnight. "Today" is always worked out in `settings.club_timezone`, never in UTC.

To test them locally:

```bash
npx wrangler dev --test-scheduled
curl 'http://localhost:8787/__scheduled?cron=0+15+*+*+*'   # dues posting
curl 'http://localhost:8787/__scheduled?cron=0+16+*+*+1'   # backup
```

To watch production:

```bash
npx wrangler tail dues-tracker          # live logs, including "Posted N dues charge(s) for …"
```

The dashboard shows a **banner whenever a period is due but hasn't been posted**, with a **Post dues now** button. A cron that has quietly stopped is therefore visible. Posting is idempotent, so pressing the button after the cron has already run does nothing.

---

## 7. Backups and recovery

There are three layers:

| Layer | What | Use it for |
|---|---|---|
| **D1 Time Travel** | 30 days of point-in-time restore, on by default | "I just deleted the wrong member" |
| **R2 weekly snapshots** | JSON + CSV, 26-week retention | Portability; longer history |
| **Manual download** | **Settings → Download full backup (JSON)**, built fresh from D1 | Handing the books to the next treasurer |

### 7.1 Point-in-time restore

```bash
npx wrangler d1 time-travel info dues-tracker
npx wrangler d1 time-travel restore dues-tracker --timestamp=<UNIX_TS>
```

A restore **replaces the whole database**. Take a manual backup first.

### 7.2 Inspect R2 snapshots

Snapshots are written as `backups/<YYYY-MM-DD>/dues-tracker.json` and `…/dues-tracker.csv`, one folder per Monday. Browse them in **R2 → dues-tracker-backups**, or fetch one directly:

```bash
npx wrangler r2 object get dues-tracker-backups/backups/<YYYY-MM-DD>/dues-tracker.csv --remote --file ./restore.csv
```

---

## 8. Updating the app

```bash
git pull
npm ci
npm test && npm run typecheck
npm run db:migrate:remote      # only if migrations/ changed; migrations are append-only
npm run deploy
```

To roll back a bad deploy:

```bash
npx wrangler deployments list
npx wrangler rollback <VERSION_ID>
```

A rollback restores code, not data. Use D1 Time Travel for data.

### Rotating the Access application

If you recreate the Access application, its AUD tag changes. Run `npx wrangler secret put ACCESS_AUD` again, or every API call returns 403.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Session expired — reload to sign in again." toast | The Access session lapsed. Access answers a background API call with its login page as **HTML with status 200**, not with an error code | Reload the page. The SPA detects the HTML response and shows the toast instead of a JSON parse error |
| Every API call returns 403 after deploy | `ACCESS_AUD` or `ACCESS_TEAM_DOMAIN` is missing or wrong | Set both secrets again (step 4.2) |
| Local dev returns 403 | `.dev.vars` is missing or `DEV_SKIP_ACCESS` isn't `"1"` | `cp .dev.vars.example .dev.vars` |
| `wrangler r2 bucket create` fails with `10042` | R2 isn't activated | Activate it in the dashboard (step 2.4) |
| `database_id` not found on deploy | Resources were created in a different account | Set `account_id` and create the resources in the account you deploy to |
| Dues didn't post this month | The cron failed or today is before the posting date | Check `wrangler tail`; press **Post dues now** (it can't double-post) |
| A waived month came back | It was **deleted** rather than **voided** | Use **Waive this month**: a voided charge is never re-posted |
| Wrangler fails on a Node version error | Not on the pinned Node | `nvm use`; start dev through `scripts/dev-api.sh` |
| Date fields overlap on iOS Safari | Safari sizes native date inputs to their content and ignores `width: 100%` | Already handled in `styles.css` (`min-width: 0` on inputs, plus a Safari-specific date rule). Keep both if you restyle the ledger |
