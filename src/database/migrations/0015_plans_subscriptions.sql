CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(60) NOT NULL,
	"max_users" integer NOT NULL,
	"max_branches" integer DEFAULT 1 NOT NULL,
	"price_monthly" numeric(14, 2) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "tenant_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"grace_days" integer DEFAULT 7 NOT NULL,
	"status" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_subscriptions_status" CHECK ("tenant_subscriptions"."status" in ('active', 'expired', 'cancelled')),
	CONSTRAINT "tenant_subscriptions_dates" CHECK ("tenant_subscriptions"."ends_on" >= "tenant_subscriptions"."starts_on"),
	CONSTRAINT "tenant_subscriptions_grace_days" CHECK ("tenant_subscriptions"."grace_days" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_subscriptions_tenant_id_ends_on_idx" ON "tenant_subscriptions" USING btree ("tenant_id","ends_on");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_subscriptions" AS PERMISSIVE FOR ALL TO "app_tenant" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Shops only read plans and their own subscriptions; the super-admin
-- (PlatformDatabase) and the daily job write them as the API's own role.
REVOKE INSERT, UPDATE, DELETE ON "plans" FROM app_tenant;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "tenant_subscriptions" FROM app_tenant;--> statement-breakpoint
-- Starting plans. Limits and prices are placeholders the owner edits in the
-- admin panel. New shops start on "Trial".
INSERT INTO "plans" ("name", "max_users", "max_branches", "price_monthly") VALUES
  ('Trial', 3, 1, '0.00'),
  ('Basic', 5, 1, '2500.00'),
  ('Pro', 15, 3, '6000.00')
ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
-- Shops that exist before plans: a 14-day Trial from today (Pakistan date),
-- so nobody is locked out on deploy.
INSERT INTO "tenant_subscriptions" ("tenant_id", "plan_id", "starts_on", "ends_on", "grace_days", "status")
SELECT t."id", p."id",
  (now() AT TIME ZONE 'Asia/Karachi')::date,
  (now() AT TIME ZONE 'Asia/Karachi')::date + 14,
  7, 'active'
FROM "tenants" t
CROSS JOIN "plans" p
WHERE p."name" = 'Trial'
  AND NOT EXISTS (
    SELECT 1 FROM "tenant_subscriptions" s WHERE s."tenant_id" = t."id"
  );
