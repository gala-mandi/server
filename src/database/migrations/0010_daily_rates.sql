CREATE TABLE "daily_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"commodity_id" uuid NOT NULL,
	"rate_date" date NOT NULL,
	"min_rate" numeric(14, 2) NOT NULL,
	"max_rate" numeric(14, 2) NOT NULL,
	"avg_rate" numeric(14, 2),
	"rate_unit" varchar(10) DEFAULT 'maund' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_rates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "daily_rates" ADD CONSTRAINT "daily_rates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_rates" ADD CONSTRAINT "daily_rates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_rates" ADD CONSTRAINT "daily_rates_commodity_id_commodities_id_fk" FOREIGN KEY ("commodity_id") REFERENCES "public"."commodities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_rates_tenant_id_commodity_id_rate_date_key" ON "daily_rates" USING btree ("tenant_id","commodity_id","rate_date");--> statement-breakpoint
CREATE INDEX "daily_rates_tenant_id_rate_date_idx" ON "daily_rates" USING btree ("tenant_id","rate_date");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "daily_rates" AS PERMISSIVE FOR ALL TO "app_tenant" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);