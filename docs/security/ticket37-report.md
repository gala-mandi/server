# Ticket 37 — Security review & load testing before launch

Date: 7 Nov 2026 · Branch `test/security-load` in `server`, `web` and `admin`.

**Result: no open High or Critical issue.** Everything the scanners and `npm audit` rated High was
fixed; the manual review found one Medium (open redirect after login) and two Low issues worth
fixing, all fixed with tests. The peak-load scenario passed (p95 save 333 ms, 0 errors, no
duplicate or missing bill numbers) and every cross-shop attempt was blocked.

| Scenario (ticket) | Result |
| --- | --- |
| Peak load: p95 save under 500 ms, no duplicate bill numbers, no errors | **Pass** — p95 333 ms, 2,454 saves, 0 failed, 0 duplicates, 0 gaps |
| Scanner finds no high-severity issues | **Pass** — ZAP: 0 High on API, web and admin |
| Cross-tenant attempts all blocked | **Pass** — 134/134 isolation e2e tests, 20/20 black-box probes on staging |

Files in this folder:

- `ticket37-report.md` — this report
- `zap/api-baseline.{html,md}` — ZAP API scan (OpenAPI import, passive), anonymous
- `zap/api-auth-baseline.{html,md}` — the same, signed in as a shop owner
- `zap/web-baseline.{html,md}`, `zap/admin-baseline.{html,md}` — ZAP baseline of the built panels
- `k6-purchases-10m-summary.json` — k6 end-of-test metrics of the 10-minute run

## 1. Staging

There is no staging host, so "staging" was a **local production build**:

| Part | How it ran |
| --- | --- |
| Database | A fresh `postgres:17-alpine` container (`gm-staging-pg`, `pg_stat_statements` and `log_min_duration_statement=100` on), all 16 migrations applied with `npm run db:migrate` |
| API | `npm run build`, then `node dist/main` with `NODE_ENV=production` (argon2 at production cost, real throttling, secrets generated for the run) in a `node:24-bookworm-slim` container on the same Docker network as the database — API and database close together, as on the live host |
| Web / admin | `next build` + `next start` (ports 3100 / 3101), `NEXT_PUBLIC_API_URL` = the staging API |
| Load / scans | k6 (`grafana/k6:2.3.0`) and ZAP (`ghcr.io/zaproxy/zaproxy:stable`) from Docker |

Machine: laptop, Intel i5-10210U (4 cores) **held at 0.9 GHz by the power-saving profile**, 7.4 GB
RAM, shared with other running work, Docker Desktop VM with 1.8 GB. The live host will be faster;
the numbers below are a floor, not a ceiling.

A first attempt ran the API on the host and reached Postgres through Docker Desktop's port
forwarding: each query round trip cost 3.6 ms there (vs ~0.1 ms on one network), which with ~42
queries per save dominated the save time. All results below are from the same-network setup.

## 2. Multi-tenant isolation

| Suite (against the staging database) | Tests | Result |
| --- | --- | --- |
| `test/tenant-isolation.e2e-spec.ts`, `rls`, `rbac`, `route-access`, `throttle` | 134 | all pass |
| Full e2e suite (`npm run test:e2e`, 25 suites — every module has its own cross-shop cases) | 1,053 (1,054 with this ticket's test) | all pass (re-run after the fixes on a fresh migrated database, as CI does) |
| `load/isolation.js` — black-box k6 probe against the running staging build, two seeded shops | 20 checks | all pass |

The black-box probe (`npm run load:isolation`) checks, as shop B's owner (every permission, so a
refusal can only come from the shop check):

- shop A's purchase by id: `GET`, `PATCH`, `cancel` → **404** (never 403); search by its bill number finds nothing; shop A's bill is unchanged
- shop A's kissan and commodity: `GET`/`PATCH`/`DELETE` trader, khata, `GET` commodity → **404**; a purchase on A's kissan or with A's commodity → **400** (unknown)
- `tenantId` in the body → ignored, the bill is saved in shop B only; `?tenant_id=` on a list → ignored
- no token, an edited payload (B's token with A's `tenantId`), `alg: none` → **401**
- shop user on `/admin/tenants` → **403**

## 3. Load test (k6)

**Scripts** (in `load/`, run with `npm run load:*`, README section "Load testing (k6)"):

- `load/seed.ts` — 50 shops (`load-shop-001…050`), each with an owner, 5 operators, 20 kissans, the default commodities and a Trial plan, written with Drizzle the way the API creates a shop (no new tables). Refuses a non-local database unless `LOAD_SEED_ALLOW_REMOTE=yes`; the password comes from `LOAD_TEST_PASSWORD` (no default).
- `load/purchases.js` — 250 VUs (50 × 5), one per operator, `constant-vus` for 10 minutes. Each operator signs in once in `setup()`, then saves a realistic parchi (1–3 lines, 10–80 bags, rate per maund, its own `Idempotency-Key`) every 45–75 s, starting at a random moment. Thresholds: `p(95)<500` on the save request, `http_req_failed == 0`, all checks pass.
- `load/verify.ts` — SQL after the run: duplicate bill numbers per shop, gaps (numbers must be exactly 1…n per shop and financial year and match `number_sequences`), purchases without khata lines.

**Rate limits are not relaxed** (no load-only override was needed or added). The API reads the
client address with `trust proxy = 1`; k6 sends each shop's own address in `X-Forwarded-For`
exactly as the host's proxy does, so each shop has its own 100-requests-a-minute budget, as real
shops do. Logins happen once per operator (5 a shop, well under the per-phone login limit).

**Pace chosen:** one parchi per operator about every minute, nonstop, all 250 operators at once =
~250 parchis a minute, ~2,500 in 10 minutes (≈ 50 per shop). Typing a parchi with its weights
takes a minute or two, and a busy shop writes a few hundred a *day*, so this is several times a
real peak.

### Results — 10-minute run (50 shops × 5 operators)

| Metric | Value |
| --- | --- |
| Purchases saved | **2,454** (3.6 saves/s; 4.1 requests/s incl. 250 logins and lookups) |
| Save time avg / median / p90 | 167 ms / 137 ms / 283 ms |
| **Save time p95** | **333 ms** (threshold 500 ms ✓) |
| Save time p99 / max / min | 449 ms / 777 ms / 70 ms |
| Failed saves | **0** of 2,454 (`http_req_failed` 0 %, 4,908/4,908 checks) |
| Duplicate bill numbers (SQL) | **0** |
| Gaps in bill numbers (SQL, all 50 shops) | **0** — every shop's numbers are 1…n and `number_sequences` agrees |
| Purchases without khata lines | **0** |

(`load:verify` counted 6,832 purchases: the 10-minute run plus the smoke and stress runs on the
same database; all were checked.) The 1-minute smoke run before it: 257 saves, p95 355 ms, 0 errors.

### Ceiling (stress runs)

With a 4–6 s pause per operator (~50 saves/s offered, about 12× the pace above) the save time
grows to p95 ≈ 16–18 s, still with **0 errors, 0 duplicates, 0 gaps**. The API tops out at about
**10 saves/s** on this laptop. Evidence that the limit is the single Node.js process, not the
database:

- During saturation 7–10 of the 10 pool connections are `idle in transaction / ClientRead` (Postgres waiting for the API), only 0–2 wait for a lock.
- Every save statement takes ≤ 2 ms in Postgres on average (below), ~20 ms of database time per save.
- The API uses ~170 ms of CPU per save at 0.9 GHz (~42 queries; about half of it is Drizzle building queries). One process = one core.

Recommendation for the host (not a blocker at real volumes): run 2+ API processes (e.g. PM2 cluster
or the host's instances) behind the proxy and keep the database on the same network; at real
clock speed one process should give several times the numbers above.

## 4. Slow queries and indexes

Captured with `pg_stat_statements` (reset before each phase) and `log_min_duration_statement = 100`.

**Save path (10-minute run):** no statement needs an index.

| Statement (per save) | Calls | Mean | Max |
| --- | --- | --- | --- |
| insert `ledger_entries` | 2,454 | 1.69 ms | 70 ms |
| insert `purchase_items` | 4,939 | 1.29 ms | 19 ms |
| insert `purchases` | 2,454 | 1.29 ms | 17 ms |
| insert `purchase_charges` | 7,362 | 0.99 ms | 16 ms |
| upsert `number_sequences` (bill number) | 2,454 | 0.97 ms | 159 ms |
| insert `audit_logs` | 17,209 | 0.90 ms | 16 ms |

The only statements over 100 ms during the run were 4 bill-number upserts waiting for the shop's
`number_sequences` row lock — that wait is the design (saves of one shop take numbers one after
another, which is what guarantees no duplicates and no gaps).

**Read paths:** one shop (`load-shop-001`) was given a full financial year in SQL (36,500 purchases
+ 36,500 sales with items and charges, 18,250 vouchers, ~100k khata lines) and the list, ledger and
report endpoints were timed through the staging API (best of 3):

| Endpoint (1 year of data) | Time |
| --- | --- |
| `GET /purchases` (page 1) / `?trader=` / `?status=` / `?from&to` / `?sort=billNo` | 88 / 29 / 46 / 43 / 62 ms |
| `GET /purchases?commodity=` / `?page=500` | 93 / 355 ms |
| `GET /purchases?search=<bill no>` / `?search=<kissan name>` | 555 / 258 ms |
| `GET /sales` / `?search=<bill no>` / `?trader=` | 63 / 728 ms / 71 ms |
| `GET /payments` / `?search=` | 74 / 102 ms |
| `GET /ledger/:trader` (whole year) / `/ledger/balances` | 38 / 191 ms |
| `GET /reports/daily-summary` / `outstanding` / `cash-book` (1 month) | 167 / 284 / 131 ms |
| `GET /reports/purchases` year by day / by trader, `sales` by commodity, `commission` | 548 / 1,077 / 1,471 / 958 ms |

**No index was added**, because none of these is slow for want of one:

- Page-1 lists already use `(tenant_id, purchase_date)` with an incremental sort (8 ms in Postgres); the rest is the `count(*)` of a year of bills for the pager (~150 ms), which an index cannot avoid.
- The search (`ILIKE '%…%'` on bill number OR kissan name/phone) is a sequential scan. A trigram index was tried and **cannot be used under Row-Level Security**: `ILIKE` is not a leak-proof operator, so Postgres may not run it inside an index scan before the `tenant_isolation` policy. (The same applies to the existing `traders_name_trgm_idx`, which the shop queries never use.) Making search faster needs a query change (e.g. exact bill-number match first) — follow-up, not an index.
- Year-long reports aggregate every line of the year by design; they stay under the 2 s target of the reports ticket (`test/reports-performance.e2e-spec.ts`) even at 0.9 GHz.
- Deep pages (`?page=500`) cost an `OFFSET`; the UI pages forward from page 1.

## 5. OWASP Top 10 checklist (manual review)

✅ pass · 🔧 fixed in this ticket · 📝 note / accepted (with reason)

### Server (API)

| # | Area | Check | Status |
| --- | --- | --- | --- |
| A01 | Access control | Global guards in order: throttle → JWT → roles → permissions → plan. `route-access` e2e proves every route has `@Public()`, roles or permissions. | ✅ |
| A01 | Tenant isolation | `tenantId` only from the verified JWT (CLS); `tenant_id`/`tenantId` stripped from every body at any depth; `TenantDatabase` filters every query and RLS (`app_tenant`, `SET LOCAL`) is the second layer; other shop's id → 404. Proven by section 2. | ✅ |
| A01 | Super-admin | Crossing shops only through `withTenant()` / `PlatformDatabase`, both audited; refused for other roles. | ✅ |
| A01 | Role changes | The access token carries the role; a demoted user keeps the old role until the token expires (≤ 15 min). Disabled users and suspended shops are cut off on the next request (DB check per request). | 📝 Low, accepted (short TTL) |
| A02 | Crypto / secrets | argon2id (production refuses < 19 MiB / 2 passes); JWT HS256 only, secret ≥ 32 chars from env; refresh tokens random 256-bit, stored as SHA-256; OTP HMAC + 5 attempts. | ✅ |
| A02 | Secrets in repo | `git log -p --all` of all three repos scanned for keys, tokens, private keys, DB URLs with passwords: only `change-me` placeholders. No `.env` was ever committed (`.env*` ignored, `.env.example` only). | ✅ |
| A03 | Injection | Drizzle parameterises everything; no `sql.raw`; sort keys from an enum map; LIKE wildcards escaped (`likePattern`); Zod validates every body/query (`strict()` on writes). | ✅ |
| A03 | XSS (output) | API returns JSON only (`application/json`), helmet CSP `default-src 'self'` on API responses; logo uploads checked by magic bytes (PNG/JPEG only, no SVG) and served with `nosniff`. | ✅ |
| A04 | Money / design | Totals, prices and bill numbers computed server-side (decimal.js); bill numbers from a locked `number_sequences` row, rolled back with a failed save (load test: 0 gaps); idempotency key per save. | ✅ |
| A05 | Security headers | helmet defaults (CSP, HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, CORP/COOP), no `X-Powered-By`. ZAP API scans: no header warnings. | ✅ |
| A05 | CORS | Allow-list from `CORS_ORIGINS` with credentials; unknown origins get no CORS headers. | ✅ |
| A05 | Error leakage | Global filter: `{ statusCode, message }`, no stack traces. **Found:** a body over the 100 kB limit returned **500** (and logged an error) instead of 413. | 🔧 Low — body-parser client errors keep their 4xx status with a fixed message (unit + e2e test) |
| A05 | Swagger | `/docs` is public in production (schema only; every endpoint still needs a token). | 📝 Info, accepted — the API is the documented contract for web/admin/app; hide behind the proxy if wanted |
| A06 | Vulnerable packages | See section 7. | 🔧 |
| A07 | Auth / sessions | Refresh rotation with reuse detection (a rotated token coming back ends every session of the user); logout / logout-all / password change revoke; disabled user and suspended shop → 403 on login, refresh and every request. | ✅ |
| A07 | Brute force / rate limits | Global 100 requests/min per client; login & forgot-password 5/min per IP + phone; reset-password 10/min per IP; OTP 5 attempts. Credential stuffing across many phones from one IP is held only by the global 100/min. | ✅ / 📝 |
| A07 | CSRF on the refresh cookie | `refresh_token` is `httpOnly`, `Secure` outside dev, `SameSite=Lax`; refresh and logout are `POST`, so a cross-site page never sends the cookie; responses are unreadable cross-origin (CORS). A sibling subdomain of the same site could still trigger a rotation/logout (nuisance, no token disclosure). | ✅ / 📝 Low |
| A08 | Integrity | Ledger append-only (reversals), audit log for every write, money writes in one transaction. | ✅ |
| A09 | Logging | pino with `authorization`, `cookie` and `set-cookie` redacted; auth events in `auth_logs`; writes in `audit_logs`. | ✅ |
| A10 | SSRF | The API makes one outbound call (ImageKit upload, fixed URL). | ✅ |
| — | Proxy trust | `trust proxy = 1` is right only when exactly one proxy sits in front of the API. If the API port is reachable directly, `X-Forwarded-For` can be forged to dodge per-IP limits. | 📝 Deploy check: expose the API only through the host's proxy |

### Web and admin (Next.js)

| # | Area | Check | Status |
| --- | --- | --- | --- |
| A01 | Open redirect after login | `?next=` was accepted when it started with `/` and not `//` or `/\`. **Found:** `/login?next=/%09/evil.com` sent the user to `evil.com` after signing in (browsers drop the tab → `//evil.com`). | 🔧 Medium — `safeNextPath` now rejects control characters, spaces and backslashes and checks the path resolves to the same origin (unit tests in both apps; checked in the browser: lands on `/dashboard`) |
| A02 | Token storage | Access token in memory (Zustand, not persisted); refresh token only in the server's `httpOnly` cookie; `localStorage` holds UI preferences only (theme, columns, dismissed banner). | ✅ |
| A03 | XSS sinks | No `dangerouslySetInnerHTML` in web; admin uses it only for the static theme script built from constants (no user data); no `eval`/`new Function`/`innerHTML`; React escapes all API text. | ✅ |
| A03 | Spreadsheet export | SheetJS 0.20.3 (patched CDN build) writes typed string cells, so `=…` in a trader name is never a formula. | ✅ |
| A05 | Security headers | **Found:** no CSP, no `X-Frame-Options` (clickjacking), no `nosniff`. | 🔧 Medium — `next.config.ts` now sends CSP (`frame-ancestors 'none'`, `object-src 'none'`, `connect-src` self + API, images self + API + ImageKit), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP, CORP; no `X-Powered-By` |
| A05 | CSP `unsafe-inline` | Kept for scripts and styles: Next's inline bootstrap scripts need it unless every page is rendered per request with a nonce, which would turn off the prerendered (cached) pages. | 📝 Medium (ZAP), accepted — no XSS sink found to exploit it |
| A07 | Auth flow | Single-flight refresh on 401, session wiped on failure; proxy only checks the cookie exists, the real check is the API. Admin refuses a shop user (`?reason=not-admin`). | ✅ |

## 6. ZAP scans

| Target | Scan | High | Medium | Low | Info |
| --- | --- | --- | --- | --- | --- |
| API (80 endpoints from `/docs-json`) | `zap-api-scan.py -S` (passive), anonymous | 0 | 0 | 0 | 3 |
| API, signed in as a shop owner | same, with `ZAP_AUTH_HEADER_VALUE` | 0 | 0 | 0 | 3 |
| Web (`next start`) | `zap-baseline.py` | 0 | 2 | 1 | 3 |
| Admin (`next start`) | `zap-baseline.py` | 0 | 2 | 1 | 3 |

- API info alerts: client-error responses (the scanner's placeholder ids → 400/401/404 — expected), "sensitive information in URL" (`userId` query parameter on the super-admin audit filter — a UUID, not a secret), cache headers. No 5xx in either API scan.
- Web/admin Medium: `CSP: script-src unsafe-inline`, `CSP: style-src unsafe-inline` — accepted, see A05 above. Low: `Cross-Origin-Embedder-Policy` missing — not set on purpose (`require-corp` would block ImageKit logos). Before the fix the first web scan also reported `CSP: Wildcard Directive` (`img-src https:`), fixed by naming ImageKit; the missing-CSP / clickjacking / `nosniff` headers were added before scanning.

## 7. Dependencies (`npm audit`, Dependabot)

`.github/dependabot.yml` added in all three repos (npm, weekly, dev minor/patch grouped).

| Repo | Before (prod deps) | Fixed | After (prod deps) |
| --- | --- | --- | --- |
| server | 2 High, 2 Moderate, 2 Low | **High** `multer` 2.4.0 DoS (GHSA-q7qp-rjg7-q26m) via `@nestjs/platform-express` → `overrides: { multer: 2.5.0 }` (the latest 11.x of platform-express still pins 2.4.0); Moderate `js-yaml` via `@nestjs/swagger` 11.4.7 → 11.4.8 (lock only) | 0 High, 0 Moderate, 2 Low |
| web | 1 High, 4 Moderate, 2 Low | **High** `follow-redirects` 1.16.1 (GHSA-mrwp-f3q8-3g9p, via axios) → 1.16.2 (lock only) | 0 High, 4 Moderate, 2 Low |
| admin | 1 High, 4 Moderate, 2 Low | same as web | 0 High, 4 Moderate, 2 Low |

Lockfiles refreshed so the live host's npm 9 installs them (`npx npm@9 ci --dry-run` passes).

Left, with reasons (none High/Critical):

- server, Low: `deepmerge` via `nestjs-zod` (prototype poisoning of merged objects; the only "fix" is a major downgrade of nestjs-zod; we never merge client objects with it).
- web/admin, Moderate/Low: `shadcn` CLI → `ts-morph` → `minimatch` (ReDoS) and `@shadcn/registry`/`deepmerge`. The `shadcn` CLI is a code generator listed under dependencies; nothing of it runs in the browser or in `next start`. Fix = move `shadcn` to devDependencies or wait for the CLI to update (Dependabot will raise it).
- Dev-only Moderate/Low (jest/istanbul `glob`, `esbuild` dev server, `minimatch` in typescript-eslint): test and build tools, not shipped.

## 8. Fixes in this ticket

| Repo | Fix | Severity | Test |
| --- | --- | --- | --- |
| server | `multer` 2.5.0 override; `@nestjs/swagger` 11.4.8 (js-yaml 5.5.0) | High / Moderate | unit + e2e suites |
| server | Oversized/invalid bodies from Express's body parser answer their 4xx (413) instead of 500 | Low | `all-exceptions.filter.spec.ts`, `app.e2e-spec.ts` |
| web, admin | Open redirect via `?next=/%09/…` after login | Medium | `src/lib/navigation.test.ts` |
| web, admin | Security headers + CSP in `next.config.ts` | Medium | ZAP rescans; Playwright e2e against the production build (web 69/69, admin 29/29); signed in through the built web panel with no CSP errors |
| web, admin | `follow-redirects` 1.16.2 | High | unit + e2e suites |
| web, admin | Auth e2e "expired access token is refreshed silently" read the `/auth/me` → refresh → retry chain once, right after the name appeared; it failed ~1 in 4 runs on `main` too. It now waits for the chain (`expect.poll`) | test only | 8/8 repeated runs |
| all | `.github/dependabot.yml` | — | — |

## 9. Open items (none High or Critical)

| Item | Severity | Owner / next step |
| --- | --- | --- |
| CSP keeps `'unsafe-inline'` for scripts/styles (Next prerendering) | Medium (accepted) | Revisit if pages move to per-request rendering with nonces |
| Expose the API only through the host's single proxy (`trust proxy = 1`) | Deploy check | Ops, at go-live |
| One Node process tops out ~10 saves/s on this laptop at 0.9 GHz | Capacity | Run 2+ API processes on the host; re-run `npm run load:test` there |
| Search (`ILIKE`) cannot use trigram indexes under RLS; `traders_name_trgm_idx` unused | Performance | Follow-up: exact bill-number match first / leak-proof search |
| `shadcn` CLI in web/admin dependencies (moderate advisories) | Moderate | Move to devDependencies |
| Role in the access token until expiry (≤ 15 min) | Low (accepted) | — |
| `/docs` public in production | Info (accepted) | Optional: block at the proxy |

## How to run it again

```bash
# server (a test database only)
export LOAD_TEST_PASSWORD='…'
npm run db:migrate && npm run load:seed
npm run build && NODE_ENV=production node dist/main          # another terminal
export API_URL=http://host.docker.internal:4000
npm run load:smoke && npm run load:test && npm run load:verify
npm run load:isolation

# ZAP (from a folder Docker can write to)
docker run --rm -v "$PWD/docs/security/zap:/zap/wrk:rw" ghcr.io/zaproxy/zaproxy:stable \
  zap-api-scan.py -t http://host.docker.internal:4000/docs-json -f openapi -S -r api-baseline.html -w api-baseline.md
docker run --rm -v "$PWD/docs/security/zap:/zap/wrk:rw" ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py -t http://host.docker.internal:3000 -r web-baseline.html -w web-baseline.md
```
