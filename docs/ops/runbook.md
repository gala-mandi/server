# Galla Mandi — operations runbook

One place for how the platform runs in production: where things live, backups and restore,
error alerts, uptime, deploys and rollbacks. Secrets are never written here, only their names.

## 1. Environments

| Service | Host | Address | Deploys |
|---|---|---|---|
| API (`server`) | EthioDeploy (nixpacks, Node 22, npm 9) | https://server-6i08.ethiodeploy.app | every push to `main` |
| Shop panel (`web`) | Vercel project `web-mandi-1` | https://web-mandi-1.vercel.app | every push to `main` |
| Super-admin (`admin`) | Vercel project `admin-mandi-1` | https://admin-mandi-1.vercel.app | every push to `main` |
| Database | PostgreSQL on EthioDeploy | `DATABASE_URL` in the API's environment | migrations run on API start |

There is **one environment: production**. Staging (its own database and secrets, updated on merge
to `main`) was left out on purpose for now; see [Follow-ups](#10-follow-ups).

API start command on EthioDeploy: `npm run db:migrate && node dist/main`.
Health check: `GET /health` → `200 {"status":"ok","database":"up"}`, or `503` when the database
is not reachable.

## 2. Environment variables (names only)

**API (EthioDeploy → service → Environment):**
`NODE_ENV=production`, `PORT`, `DATABASE_URL`, `CORS_ORIGINS`, `JWT_ACCESS_SECRET`, `OTP_SECRET`,
`JWT_ACCESS_TTL_SEC`, `REFRESH_TOKEN_TTL_DAYS`, `COOKIE_DOMAIN` (only with a shared parent
domain), `WEB_APP_URL`, `PUBLIC_API_URL`, `IMAGEKIT_PRIVATE_KEY`, `IMAGEKIT_FOLDER`, `UPLOADS_DIR`,
`LOGIN_THROTTLE_LIMIT`, `LOGIN_THROTTLE_TTL_MS`, `THROTTLE_TTL_MS`, `THROTTLE_LIMIT`, `LOG_LEVEL`,
`ARGON2_MEMORY_KIB`/`ARGON2_TIME_COST` (leave unset), and new: **`SENTRY_DSN`**, optional
`SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`. Never set `LOAD_TEST_PASSWORD` or `SEED_*` here.
`.env.example` lists all of them with comments.

**web and admin (Vercel → project → Settings → Environment Variables, Production):**
`NEXT_PUBLIC_API_URL`, and new: **`NEXT_PUBLIC_SENTRY_DSN`**, optional
`NEXT_PUBLIC_SENTRY_ENVIRONMENT`. `NEXT_PUBLIC_*` values are baked in at build time: redeploy
after changing one.

**GitHub (server repo → Settings → Secrets and variables → Actions):**
secrets `DATABASE_URL`, `BACKUP_PASSPHRASE`, optional `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`,
`BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_REGION`; optional variables
`API_URL`, `DEPLOY_WAIT_SECONDS`. web/admin repos: optional variable `SITE_URL`.

## 3. Backups

| | |
|---|---|
| What | `pg_dump --format=custom` of the whole database (all schemas, incl. `drizzle` migration history) |
| When | daily 02:30 Asia/Karachi (21:30 UTC), workflow **Backup** (`.github/workflows/backup.yml`); also on demand: Actions → Backup → Run workflow |
| Encryption | `gpg --symmetric` AES-256 with `BACKUP_PASSPHRASE`; the plain dump never touches disk |
| Check | every backup is decrypted and its table list read back (`pg_restore --list`); the run fails if that does not work |
| Where | GitHub Actions artifact `galla-mandi-<UTC time>.dump.gpg`, kept **30 days**; plus `s3://<bucket>/daily/` when the `BACKUP_S3_*` secrets are set |
| Retention | artifacts: `retention-days: 30`; bucket: a lifecycle rule (below) |
| Alerts | a failed run e-mails the person who last edited the schedule (GitHub default); a run without secrets is skipped with a warning |

Client version: the workflow reads the server's version and installs exactly that `pg_dump`
major from the PostgreSQL apt repository, so a dump can always be read by the host's own tools.

Point-in-time recovery: not available to us on EthioDeploy's Postgres as far as we know. If the
host offers its own scheduled backups/PITR, turn them on as well — they cost nothing extra and
cover the gap between daily dumps.

### If GitHub cannot reach the database

The workflow connects from GitHub's runners to `DATABASE_URL`. If EthioDeploy's Postgres only
accepts connections from inside its network, the run fails at "Install the matching PostgreSQL
client" (it cannot read the server version). Then do **not** build a second system:

1. Prefer the host's own backup feature (EthioDeploy database → Backups), daily, 30 days.
2. Or expose the database to the internet with TLS and a strong password only for the backup
   user (a read-only role is enough: `GRANT pg_read_all_data TO backup_user;`).
3. Or run `scripts/backup.sh` from a machine that can reach it (cron on a small VM with a tunnel).

### Object storage (optional, Cloudflare R2)

1. Cloudflare → R2 → Create bucket `galla-mandi-backups` (location: automatic).
2. Bucket → Settings → **Object lifecycle rules** → Add rule: prefix `daily/`, delete objects
   **30 days** after upload.
3. R2 → Manage API tokens → Create token: *Object Read & Write*, only this bucket.
4. Add the secrets: `BACKUP_S3_BUCKET=galla-mandi-backups`,
   `BACKUP_S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com`,
   `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` (region defaults to `auto`).

Any S3-compatible store works the same way (AWS S3: leave `BACKUP_S3_ENDPOINT` empty and set
`BACKUP_S3_REGION`).

### How to restore

You need: the backup file, `BACKUP_PASSPHRASE`, `gpg`, and PostgreSQL client tools of the same
major version as the dump or newer (`pg_restore --version`).

1. Get the backup: Actions → Backup → the run → Artifacts → download (a zip with the
   `.dump.gpg` inside), or download from the bucket.
2. Create a **new, empty** database (never restore over the live one), e.g. a new database on the
   host, or locally `createdb galla_mandi_restore`.
3. Restore:
   ```bash
   unzip galla-mandi-*.zip
   TARGET_DATABASE_URL=postgres://user:pass@host:5432/galla_mandi_restore \
   BACKUP_PASSPHRASE='…' scripts/restore.sh galla-mandi-<time>.dump.gpg
   ```
   The script refuses a database that already has tables, creates the `app_tenant` role that
   Row-Level Security needs (roles are not in a dump), restores everything owned by the user in
   `TARGET_DATABASE_URL`, and re-applies the default privileges.
4. Point the API at it: set `DATABASE_URL` to the restored database and redeploy (or run locally:
   `npm run build && DATABASE_URL=… node dist/main`). `npm run db:migrate` then does nothing — the
   migration history is in the dump.
5. Check: `/health` is ok, sign in, open traders and purchases; compare counts with what you
   expect.

### Restore drill — 2026-11-08 (local, passed)

Source: a scratch database `galla_drill_src` in the local Docker Postgres 17, migrated (16
migrations), `npm run db:seed`, then through the API as the seed owner: 6 traders and 15 purchases
(bills up to `PUR-2026-27-000015`) with charges and ledger entries.

| Step | Command | Result |
|---|---|---|
| Backup | `DATABASE_URL=…/galla_drill_src BACKUP_PASSPHRASE=… scripts/backup.sh <dir>` | `Backup OK … (28K, 25 tables)` in 1.5 s; `file`: *PGP symmetric key encrypted data - AES with 256-bit key*; wrong passphrase → gpg exit 2 |
| Fresh DB | `docker run -d --name galla-restore-drill -e POSTGRES_USER=restore_admin … postgres:17-alpine` | empty database, **different owner role** than the source (`galla`) |
| Restore | `TARGET_DATABASE_URL=…restore_admin@…/galla_restored BACKUP_PASSPHRASE=… scripts/restore.sh <file>` | `Restore OK: 24 tables, 16 migrations applied.` in 3.8 s (24 tables in `public` + the `drizzle` migrations table = the 25 in the backup) |
| Safety | same command again | `Refusing: the target database already has 25 tables…`, exit 1 |
| Data | row count of every table, source vs restored | **identical** (audit_logs 96, purchases 15, purchase_items 15, purchase_charges 45, ledger_entries 15, traders 6, users 2, …) |
| Migrate | `DATABASE_URL=<restored> npm run db:migrate` | no-op, success |
| App | `DATABASE_URL=<restored> PORT=4621 node dist/main` | `/health` → `{"status":"ok","database":"up"}`; owner sign-in ok; `GET /traders` total 6, `GET /purchases` total 15, latest `PUR-2026-27-000015` — same as the source API |
| Writes | `POST /traders` as the owner on the restored DB | `201` (Row-Level Security role and grants restored) |

Repeat the drill every 3 months and after any Postgres upgrade, with a real backup artifact
restored into a throw-away database.

## 4. Error tracking (Sentry)

What is sent: **server errors only**. API: every 5xx (unhandled exceptions, and 503s such as a
lost database); never 4xx. web/admin: errors in the browser and in server rendering, and errors
shown by the error pages. No tracing, no session replay, no source-map upload.

What is never sent: request bodies, cookies, `Authorization` and most other headers, query
strings, IP addresses, user e-mails/names, local variables, SQL parameter values. Phone numbers,
CNICs and e-mail addresses inside error messages and breadcrumbs are masked (`[number]`,
`[email]`). Code: `server/src/common/sentry/sentry-options.ts`, `web|admin/src/lib/sentry.ts`.

Everything is off unless a DSN is set, so local development and tests send nothing.

### Set up (owner, once)

1. Create a free account at https://sentry.io (organisation `galla-mandi`), data region of choice.
2. Create **three projects**: `galla-mandi-server` (platform *NestJS*), `galla-mandi-web` and
   `galla-mandi-admin` (platform *Next.js*). Skip the setup wizards; copy each project's
   **DSN** (Project settings → Client Keys).
3. Paste the DSNs:
   - EthioDeploy → API service → Environment: `SENTRY_DSN=<server DSN>` → redeploy.
   - Vercel → `web-mandi-1` → Settings → Environment Variables (Production):
     `NEXT_PUBLIC_SENTRY_DSN=<web DSN>` → Deployments → Redeploy.
   - Vercel → `admin-mandi-1` → same with `<admin DSN>`.
   The web/admin Content-Security-Policy allows the Sentry ingest host automatically (taken from
   the DSN at build time).
4. Alerts to the team: Settings → Members → invite the team. For each project, Alerts → Create
   alert → *Issues* → "A new issue is created" **or** "The issue changes state from resolved to
   unresolved" → Send a notification to *Team* / members by e-mail → all environments. Sentry
   usually e-mails within a minute or two of the error.
5. Optional: Settings → Security & Privacy → turn on *Data Scrubber* and *Use Default Scrubbers*
   (server-side scrubbing on top of ours) and *Prevent Storing of IP Addresses*.

### Verify alerts (safe, nothing touches production)

From a checkout of the server repo, for each DSN in turn:

```bash
npm ci
SENTRY_DSN='<dsn>' npm run sentry:test
# → Sent test event <id>. It shows in Sentry > Issues shortly.
```

It sends one error "Sentry test from Galla Mandi (safe to ignore)" with environment
`sentry-test` and the same scrubbing as the API. The alert e-mail should arrive within minutes;
then resolve the issue. (If an alert rule is limited to `production`, add
`SENTRY_ENVIRONMENT=production` to the command.) Local check of the real API path: with
`SENTRY_DSN` set, stop the database and call `/health` — the 503 is reported.

## 5. Uptime monitoring (UptimeRobot)

1. Create a free account at https://uptimerobot.com.
2. Alert contacts → add the team e-mails (and the UptimeRobot mobile app for push).
3. Add three monitors, **5-minute interval**, all alert contacts attached:

| Name | Type | URL | Check |
|---|---|---|---|
| Galla Mandi API | Keyword | `https://server-6i08.ethiodeploy.app/health` | keyword `"status":"ok"` **exists** (alert when missing) |
| Galla Mandi web | HTTP(s) | `https://web-mandi-1.vercel.app/login` | status 200 |
| Galla Mandi admin | HTTP(s) | `https://admin-mandi-1.vercel.app/login` | status 200 |

4. Optional: a public status page with the three monitors (Status pages → Add).

The API keyword monitor also catches a lost database (`/health` answers 503 without the keyword).
The 5-minute checks use about 0.2% of the API rate limit.

## 6. Deploys and the post-deploy check

| Repo | Trigger | What it checks |
|---|---|---|
| server | push to `main` (workflow **Post-deploy check**) | waits `DEPLOY_WAIT_SECONDS` (default 300 s) for EthioDeploy to build, then `/health` must return `"status":"ok"` 3 times in a row within 10 min |
| web, admin | Vercel's *deployment status* for Production (workflow **Post-deploy check**) | fails at once if the Vercel deployment failed; otherwise `/login` must return 200 3 times in a row within 5 min |

All use `scripts/smoke-check.sh <url> [text]` (same file in the three repos); run it by hand any
time, e.g. `scripts/smoke-check.sh https://server-6i08.ethiodeploy.app/health '"status":"ok"'`.
A failed check e-mails the person who pushed (GitHub's default for failed runs).

Limits: the API does not report its version, so the server check cannot tell a new version from
the old one that kept running — it proves the API is up after the deploy window, while a failed
deploy shows in EthioDeploy's deploy log/notifications. If the web/admin check never runs after a
merge, Vercel's GitHub deployments are switched off: Vercel → project → Settings → Git →
enable *GitHub deployments* (or run the workflow by hand).

## 7. Migrations, failed migrations and rollback

Rules:
- **Migrations are additive.** Add tables/columns/indexes; don't drop or rename in the same
  release that stops using them (drop later, after the code no longer reads them). So the
  previous API version always works with the newer schema, and rolling back code is safe.
- **Never edit a merged migration**; write a new one (`npm run db:generate`).
- `db:migrate` applies all pending migrations in one transaction: if any statement fails, none of them is applied.

What a failed migration does (drill 2026-11-08, local): a scratch migration `ALTER TABLE traders
ADD COLUMN …; SELECT 1/0;` was added and the start command run against a scratch database.
`npm run db:migrate && node dist/main` exited with **code 1**, `node dist/main` never started
(port stayed closed), the column was **not** added and the migration history stayed at 16 — the
database was unchanged. Note: drizzle-kit 0.31 prints no error text when a migration fails; run the
SQL by hand with `psql` against a copy to see the reason.

On EthioDeploy this means the new container never becomes healthy. Whether the old container keeps
serving depends on EthioDeploy's rollout (it does when it waits for the new one to start; check
the deploy log). Either way:

### Roll back the API (EthioDeploy)
1. EthioDeploy → API service → Deployments → pick the last good deployment → **Redeploy** (or
   push a `git revert` of the bad merge to `main`).
2. Watch `/health` (`scripts/smoke-check.sh …/health '"status":"ok"'`) and UptimeRobot.
3. Fix the migration in a new PR; never edit the merged one.

### Roll back web/admin (Vercel)
1. Vercel → project → Deployments → last good Production deployment → ⋯ → **Promote to
   Production** (instant; the next push to `main` deploys normally again).
2. Or `git revert` the merge and push.

### Rollback drill — 2026-11-08
Failed migration: verified locally as above (exit 1, API not started, database unchanged). The
EthioDeploy redeploy and Vercel promote steps are click paths that need the owner's accounts —
do them once on a quiet day and note the date here.

### Data rollback
Code rollback never needs the database rolled back (additive migrations). If data is damaged,
restore the last good backup into a **new** database (section 3), check it, then point
`DATABASE_URL` at it. Data written after that backup is lost — copy what you need first.

## 8. CORS, HTTPS, cookies, domain

- `CORS_ORIGINS` is an exact allow-list: comma-separated `https://` origins, e.g.
  `https://web-mandi-1.vercel.app,https://admin-mandi-1.vercel.app`. Each value is reduced to its
  origin (a trailing `/` or path is ignored); `*` is refused at start-up. Requests without an
  `Origin` (curl, uptime checks) are allowed; other browser origins get no CORS headers.
- HTTPS: EthioDeploy (behind Cloudflare) and Vercel serve HTTPS only; the API sends HSTS (helmet)
  and trusts the proxy's `X-Forwarded-Proto` (`trust proxy 1`).
- Refresh cookie: `httpOnly`, `secure` whenever `NODE_ENV` is not `development` (so always in
  production), `SameSite=Lax`.

### Adding a custom domain later
1. Buy the domain (e.g. `gallamandi.pk`); manage DNS (Cloudflare is fine).
2. web: Vercel → `web-mandi-1` → Domains → add `app.<domain>`; admin: `admin.<domain>`; API:
   EthioDeploy → API service → Domains → `api.<domain>`; add the DNS records each one shows.
3. Update env: API `CORS_ORIGINS=https://app.<domain>,https://admin.<domain>`,
   `WEB_APP_URL=https://app.<domain>`, `PUBLIC_API_URL=https://api.<domain>`, and
   `COOKIE_DOMAIN=.<domain>` (now that all three share a parent domain); web/admin
   `NEXT_PUBLIC_API_URL=https://api.<domain>` → redeploy all three.
4. Update the UptimeRobot monitors, the `API_URL`/`SITE_URL` repository variables, and this file.

## 9. Owner checklist

- [ ] GitHub `server` repo → Actions secrets: `DATABASE_URL` (production), `BACKUP_PASSPHRASE`
      (long random, e.g. `openssl rand -base64 32`; store it in your password manager too —
      without it the backups cannot be opened).
- [ ] Actions → Backup → Run workflow; check the run is green and has an artifact. If it fails at
      the client step, the database is not reachable from GitHub: follow section 3 "If GitHub
      cannot reach the database".
- [ ] Optional: R2 bucket + lifecycle rule + `BACKUP_S3_*` secrets.
- [ ] Sentry: 3 projects, DSNs into EthioDeploy and both Vercel projects, redeploy, alert rules,
      `npm run sentry:test` per DSN.
- [ ] UptimeRobot: 3 monitors + alert contacts.
- [ ] Vercel: GitHub deployments on (so the web/admin post-deploy check runs).
- [ ] Check `CORS_ORIGINS` on EthioDeploy lists exactly the two Vercel origins (https, no `*`).
- [ ] Once: practise both rollback paths (EthioDeploy redeploy, Vercel promote) and a restore of a
      real backup into a throw-away database; note the dates in sections 3 and 7.

## 10. Follow-ups

- **Staging** (separate database and secrets, deployed on merge to `main`): not built by the
  owner's choice.
- Report the commit SHA in `/health` if EthioDeploy exposes it as an env var, so the post-deploy
  check can wait for the new version instead of a fixed delay.
- Point-in-time recovery if the database moves to a host that offers it.
- Run migrations as a separate pre-deploy step if EthioDeploy supports one, so a failed migration
  can never take the running API down.
