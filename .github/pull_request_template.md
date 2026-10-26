Closes #

## Tasks

<!-- The ticket's tasks for this repo, ticked for what is done. -->

- [ ]

## How to run / test

## Left for a follow-up ticket

## Multi-tenant checklist

<!-- Skip only if the PR adds no table, endpoint or query on business data. -->

- [ ] Every business table uses `tenantColumns()` and `tenantIsolation()`.
- [ ] Every index starts with `tenant_id`; unique constraints include `tenant_id`.
- [ ] The migration has `ENABLE ROW LEVEL SECURITY` and the `tenant_isolation` policy.
- [ ] Services inject `TenantDatabase`, not `DRIZZLE`; queries use `scoped()` or its `where()` / `byId()`.
- [ ] No `tenant_id` in DTOs, params or query strings.
- [ ] Another shop's id returns `404` on read, update and delete.
- [ ] e2e isolation test with two seeded shops (read, update, delete across shops fail).
- [ ] Super-admin access goes through `withTenant()` only.
