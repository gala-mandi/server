CREATE TABLE "tenant_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"display_name" varchar(120),
	"parchi_footer" text,
	"default_commission_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"market_fee_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"labour_per_bag" numeric(14, 2) DEFAULT '0' NOT NULL,
	"default_unit" varchar(10) DEFAULT 'kg' NOT NULL,
	"maund_kg" numeric(6, 3) DEFAULT '40' NOT NULL,
	"bill_prefix" varchar(10),
	"financial_year_start" date,
	"language" varchar(5) DEFAULT 'en' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_settings" AS PERMISSIVE FOR ALL TO "app_tenant" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);