-- Role that every shop query runs as (SET LOCAL ROLE app_tenant inside
-- TenantDatabase). It has no login and no BYPASSRLS, so Row-Level Security
-- policies on business tables always apply to it, even when the API itself
-- connects as a superuser or as the table owner.
DO $$
BEGIN
  CREATE ROLE app_tenant NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$$;
--> statement-breakpoint
GRANT app_tenant TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_tenant;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_tenant;
--> statement-breakpoint
-- Tables created later by the migration user get the same rights.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_tenant;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_tenant;
