# Database ER diagram — review (ticket 41, issue #48)

Review of the database design against the built database, 8 Nov 2026.

- **Design:** `docs/database/schema.dbml` (master copy in `gala-mandi/.github`; the file in
  this repo is the synced copy). Paste it into <https://dbdiagram.io/d> to see the diagram.
- **Built database:** the Drizzle schema in `src/database/schema/*.ts`, migrations `0000`–`0015`.
  `drizzle-kit generate` reports "No schema changes", so the Drizzle schema and the migrations
  (and the live database that ran them) are the same.
- **Direction of the sync:** the database was built ticket by ticket after the DBML was first
  written, so the DBML had fallen behind. The DBML was brought up to the Drizzle schema. No table,
  column or migration was changed in this ticket.
- **Check:** `npm run db:check-dbml` (also part of `npm test`, so CI runs it) parses the DBML
  with `@dbml/core` (the dbdiagram parser) and fails on any error or warning, or any difference
  in tables, columns, SQL types, NOT NULL, defaults, primary keys, unique columns, indexes,
  foreign keys (including whether a relation is optional), check constraints or enums.

## 1. Before and after

|                                | DBML before | DBML after = Drizzle |
| ------------------------------ | ----------: | -------------------: |
| Tables                         |          23 |                   24 |
| Relations (foreign keys)       |          46 |                   54 |
| – required (`>`, `-`)          |          32 |                   34 |
| – optional (`>?`)              |          14 |                   20 |
| Indexes (named)                |   23 (none) |                   37 |
| Composite primary keys         |           1 |                    2 |
| Check constraints              |           0 |                    5 |
| Enums                          |           4 |                    4 |
| dbdiagram errors / warnings    |       0 / 0 |                0 / 0 |

### Drift found (DBML was missing what the database has)

| Table                   | What the DBML was missing or had wrong                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ledger_daily_balances` | Whole table (ticket "ledger daily balances", migration `0011`): composite PK, 2 FKs, trigger-maintained                    |
| `tenant_settings`       | Columns `credit_limit_action` (`0013`), `overpayment_action` (`0014`)                                                      |
| `audit_logs`            | Column `user_agent` (`0004`); `action` also takes `access` and `remind`                                                    |
| `tenant_subscriptions`  | 3 check constraints (status, `ends_on >= starts_on`, `grace_days >= 0`)                                                    |
| `invitations`           | Index `(tenant_id, created_at)`                                                                                            |
| `traders`               | GIN trigram index on `name` (pg_trgm search)                                                                               |
| `commodities`           | `created_by`, `updated_at`                                                                                                 |
| `daily_rates`           | `updated_at`, `deleted_at`; index `(tenant_id, rate_date)`                                                                 |
| `purchases`, `sales`    | `deleted_at`                                                                                                               |
| `purchase_items`        | `created_by`, `created_at`, `updated_at`, `deleted_at`; indexes `(tenant_id, purchase_id)`, `(tenant_id, commodity_id)`    |
| `purchase_charges`      | Same 4 base columns; index `(tenant_id, purchase_id)`                                                                      |
| `sale_items`            | Same 4 base columns; indexes `(tenant_id, sale_id)`, `(tenant_id, commodity_id)`, `(tenant_id, purchase_item_id)`          |
| `sale_charges`          | Same 4 base columns; index `(tenant_id, sale_id)`                                                                          |
| `payments`              | `updated_at`, `deleted_at`; unique key is `(tenant_id, direction, voucher_no)`, not `(tenant_id, voucher_no)`; index `(tenant_id, trader_id)` |
| `payment_allocations`   | Same 4 base columns; 3 indexes; 2 check constraints (exactly one bill, amount > 0)                                         |
| all uuid PKs            | Default `gen_random_uuid()`                                                                                                |
| all indexes             | Index names (now written, so the check can compare them)                                                                   |

`plans`, `tenant_subscriptions` and `otp_codes` were already in the DBML and matched, apart from
the checks above.

## 2. Table-by-table rule check

Rules from `CLAUDE.md`: money `numeric(14,2)`; weight `numeric(12,3)` kg; `timestamptz`; uuid PKs;
every business table has `id`, `tenant_id` (NOT NULL, FK), `created_at`, `updated_at`,
`created_by`, `deleted_at`, and indexes that start with `tenant_id`.

✅ = follows the rule · ⚠️ = exception (reason given) · — = not applicable

### Platform tables (no `tenant_id` rule, no RLS)

| Table            | Tenant                              | PK        | Notes                                                                 |
| ---------------- | ----------------------------------- | --------- | --------------------------------------------------------------------- |
| `plans`          | none (platform)                     | uuid      | Money `price_monthly` 14,2 ✅                                          |
| `tenants`        | is the tenant                       | uuid      | Has `created_at`, `updated_at`, `deleted_at`                          |
| `users`          | `tenant_id` NULL only for super_admin | uuid    | `phone` unique across **all** shops (see 4.4)                         |
| `refresh_tokens` | via user                            | uuid      |                                                                       |
| `otp_codes`      | via user                            | uuid      | No index on `user_id` (see 4.5)                                       |
| `auth_logs`      | `tenant_id` nullable (platform events) | bigserial | Append-only log; index `(tenant_id, created_at)` ✅                  |
| `audit_logs`     | `tenant_id` nullable (super-admin actions) | bigserial | Append-only log; both indexes start with `tenant_id` ✅           |

### Business tables (`tenant_id` NOT NULL + Row-Level Security policy `tenant_isolation`)

All 17 have a NOT NULL `tenant_id` with a FK to `tenants` and the RLS policy (the check
asserts this too). Base columns:

| Table                   | id        | created_by | created_at | updated_at | deleted_at | Indexes start with tenant_id |
| ----------------------- | --------- | ---------- | ---------- | ---------- | ---------- | ---------------------------- |
| `traders`               | uuid      | ✅          | ✅          | ✅          | ✅          | ⚠️ trigram index on `name` only |
| `commodities`           | uuid      | ✅          | ✅          | ✅          | ✅          | ✅                            |
| `daily_rates`           | uuid      | ✅          | ✅          | ✅          | ✅          | ✅                            |
| `purchases`             | uuid      | ✅          | ✅          | ✅          | ✅          | ✅                            |
| `purchase_items`        | uuid      | ✅          | ✅          | ✅          | ✅          | ✅                            |
| `purchase_charges`      | uuid      | ✅          | ✅          | ✅          | ✅          | ✅                            |
| `sales`                 | uuid      | ✅          | ✅          | ✅          | ✅          | ✅                            |
| `sale_items`            | uuid      | ✅          | ✅          | ✅          | ✅          | ✅                            |
| `sale_charges`          | uuid      | ✅          | ✅          | ✅          | ✅          | ✅                            |
| `payments`              | uuid      | ✅          | ✅          | ✅          | ✅          | ✅                            |
| `payment_allocations`   | uuid      | ✅          | ✅          | ✅          | ✅          | ✅                            |
| `tenant_subscriptions`  | uuid      | ⚠️          | ✅          | ⚠️          | ⚠️          | ✅                            |
| `invitations`           | uuid      | ⚠️ `invited_by` | ✅      | ⚠️          | ⚠️ `cancelled_at` | ✅                      |
| `tenant_settings`       | ⚠️ PK = `tenant_id` | ⚠️ | ⚠️        | ✅          | ⚠️          | ✅ (PK)                       |
| `number_sequences`      | ⚠️ PK (tenant_id, doc_type, financial_year) | ⚠️ | ⚠️ | ⚠️ | ⚠️       | ✅ (PK)                       |
| `ledger_entries`        | ⚠️ bigserial | ✅       | ✅          | ⚠️ append-only | ⚠️ append-only | ✅                   |
| `ledger_daily_balances` | ⚠️ PK (tenant_id, trader_id, entry_date) | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ✅ (PK)                |

Reasons for the exceptions (all by design, none is a bug):

- `tenant_subscriptions` — written only by the super-admin and the daily job; a period is never
  edited or deleted, a new row is added.
- `invitations` — `invited_by` is the creator; an invite is cancelled (`cancelled_at`) or accepted,
  never edited or soft-deleted.
- `tenant_settings` — one row per shop, keyed by `tenant_id`.
- `number_sequences` — a counter row per shop / document type / financial year.
- `ledger_entries` — the khata is append-only (the app role has no UPDATE/DELETE on it), so it has
  no `updated_at`/`deleted_at`; `bigserial` id keeps entry order and is cheap for a high-volume
  table.
- `ledger_daily_balances` — derived snapshot kept by a trigger; the app role can only read it.

### Money, weight and time

- **Money — all `numeric(14,2)` ✅:** `plans.price_monthly`; `tenant_settings.labour_per_bag`;
  `traders.opening_balance`, `credit_limit`; `commodities.labour_per_bag`;
  `daily_rates.min_rate`/`max_rate`/`avg_rate`; `purchases`/`sales` gross, deductions/charges,
  net, paid/received; `purchase_items`/`sale_items` `rate`, `amount`;
  `purchase_charges`/`sale_charges` `value`, `amount`; `ledger_entries` and
  `ledger_daily_balances` `debit`, `credit`; `payments.amount`; `payment_allocations.amount`.
  No float or `real` column anywhere.
- **Percentages:** `numeric(5,2)` (`default_commission_pct`, `market_fee_pct`, `commission_pct`).
  Not money; fine. The `value` column of the charge tables is `numeric(14,2)` because it holds a
  percent, Rs per bag or a fixed Rs amount.
- **Weight — `numeric(12,3)` kg ✅:** `purchase_items.weight_kg`, `sale_items.weight_kg`.
  ⚠️ Two per-unit factors use a smaller precision: `commodities.bag_weight_kg numeric(8,3)` (max
  99,999.999 kg per bag) and `tenant_settings.maund_kg numeric(6,3)` (max 999.999 kg per maund).
  They are conversion factors, not stored quantities, so the scale (3 decimals) matches and the
  range is more than enough. Reported, not changed.
- **Time ✅:** every timestamp is `timestamptz`; business days (`purchase_date`, `sale_date`,
  `payment_date`, `rate_date`, `entry_date`, `starts_on`/`ends_on`) are `date` in Asia/Karachi.
- **Primary keys:** uuid with `gen_random_uuid()`, except ⚠️ `bigserial` on the three append-only
  logs (`ledger_entries`, `auth_logs`, `audit_logs`) and the composite keys above.
- **Relations:** every FK is `ON DELETE NO ACTION` (rows are soft-deleted, never removed).
  Every nullable FK is drawn as optional (`>?`), every NOT NULL FK as required — the check
  enforces this.

## 3. Commission and charges model (as built) — for the client to confirm

One calculator (`src/common/charges/calculate-transaction.ts`) is used by purchases, sales,
previews and reports, so all totals match.

| Charge type  | Basis (as built)   | Where the rate comes from (first set wins)                       |
| ------------ | ------------------ | ---------------------------------------------------------------- |
| `commission` | `percent` of gross | entry → commodity `commission_pct` → shop `default_commission_pct` |
| `market_fee` | `percent` of gross | entry → commodity `market_fee_pct` → shop `market_fee_pct`       |
| `labour`     | `per_bag` (Rs/bag) | entry → commodity `labour_per_bag` → shop `labour_per_bag`       |
| `other`      | `fixed` (Rs)       | **Not reachable yet:** the tables and calculator support it, the API does not accept it |

- `0.00` is a real value (no commission on this item); only an empty value falls back.
- On a **purchase** the charges are deducted from what the kissan gets
  (`net = gross − charges`); on a **sale** they are added to what the beopari owes
  (`net = gross + charges`).
- Each charge line is stored on the bill (`purchase_charges` / `sale_charges`) with its rate
  copied at save time, so later setting changes never alter old bills.
- Lines are shown to the paisa; the net is rounded **once** to the nearest rupee (half-up); the
  rounding difference is shown on the parchi.

**Questions for the client:** (1) Is commission always a percent, or do some shops charge it
per bag or per maund? (2) Is market fee always a percent? (3) Is labour always per bag, or also
per maund / fixed? (4) Are there other charges on a parchi (e.g. weighing / kanta fee, brokerage,
loading, freight) that need the `other` / `fixed` line? (5) Do the same charges apply on the
sale side, or does the buyer pay different ones? The schema already stores any
type × basis, so answers (1)–(5) need API/UI work, not a schema change.

## 4. Other findings (reported, not fixed in this ticket)

1. **Comment off by one** — `src/database/schema/ledger-daily-balances.ts` says the trigger is in
   migration `0010_ledger_daily_balances`; it is in `0011_ledger_daily_balances.sql`. Doc only.
2. **`traders_name_trgm_idx` does not start with `tenant_id`.** It is a GIN trigram index on
   `name` across all shops; the tenant filter comes from RLS and the WHERE clause. Fine at today's
   size; at many shops a `btree_gin` index on `(tenant_id, name)` would keep searches per shop.
3. **Unique keys include soft-deleted rows:** `(tenant_id, phone)` on traders and
   `(tenant_id, name)` on commodities, so a deleted trader's phone or a deleted commodity's name
   can't be reused. The code says this is on purpose; the owner should confirm.
4. **`users.phone` is unique across all shops**, so one person can't be staff in two shops with
   the same phone number. Owner should confirm.
5. **`otp_codes.user_id` has no index** (and `invitations.invited_by`,
   `tenant_subscriptions.plan_id` neither). Small tables today; add an index if they grow.
6. **Text "enums" without DB checks:** `payments.direction`/`method`,
   `*_charges.type`/`basis`, `ledger_entries.source_type`, `number_sequences.doc_type`,
   `otp_codes.purpose`/`channel`, `tenant_settings` actions are checked by Zod only (only
   `tenant_subscriptions.status` has a CHECK). A later hardening ticket could add CHECKs.
7. **`updated_at` is set by the API** (Drizzle `$onUpdate`), not by a DB trigger; a manual SQL
   update won't change it.

## 5. Open questions — extra tables (decision is the owner's)

| Topic                 | What exists today                                                                                                                                                                                                                         | Recommendation                                                                                                                                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Advances (peshgi)** | No separate table. The part of a payment that no `payment_allocations` row covers is an advance; it is in the khata (`ledger_entries`) like any payment. `tenant_settings.overpayment_action` decides whether over-paying is allowed (`advance`) or blocked. | **No new table.** The ledger already carries advances. If the client wants advance-specific fields (agreed crop, season, interest/markup, due date), add an `advances` table then — with its own ledger entries, never a second balance.                                                                    |
| **Stock**             | No stock table. `sale_items.purchase_item_id` (optional) links a sold line to the kissan's lot; what is unsold can be worked out as purchased − sold weight per commodity.                                                                  | **Not now** for a pure commission shop (goods pass through the same day). If shops hold goods (godown, own-account trading), add an append-only `stock_movements` table (tenant, commodity, date, in/out kg `numeric(12,3)`, source like the ledger) rather than a stored balance. |
| **Expenses**          | Nothing. The shop's own costs (rent, wages, electricity, tea) are not recorded.                                                                                                                                                           | **Add when profit / cash-book reports are wanted:** `expenses` (base columns, `expense_date`, `category`, `amount numeric(14,2)`, `method`, `notes`), voucher numbers from `number_sequences`. Small, self-contained ticket.                                                                                 |
| **Branches**          | Nothing. One tenant = one shop. `plans.max_branches` is stored and shown but not enforced.                                                                                                                                               | **Defer.** Branches touch almost every table (`branch_id` on documents, per-branch number series, per-branch staff access and reports). Decide before many shops are on board; until then a second shop can be a second tenant.                                                                           |

## 6. Keeping it in sync

1. A table change starts as a PR to `gala-mandi/.github` editing `docs/database/schema.dbml`.
2. After merge, the "Set up repos" workflow copies it to every repo, and the owner pastes it into
   dbdiagram.
3. The Drizzle change and its migration (`npm run db:generate`) are made from the same change in
   `server`; `npm test` / `npm run db:check-dbml` fails until both sides match.

## 7. Sign-off

- [ ] Two-person review of every table and relation (backend developer + owner)
- [ ] Commission / charges model confirmed with the client (section 3)
- [ ] Decisions on advances, stock, expenses, branches (section 5)
- [ ] Diagram pasted into dbdiagram, approved and shared with the team
