CREATE TABLE "commodities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"name" varchar(80) NOT NULL,
	"name_ur" varchar(80),
	"category" varchar(40),
	"default_unit" varchar(10) DEFAULT 'maund' NOT NULL,
	"bag_weight_kg" numeric(8, 3),
	"commission_pct" numeric(5, 2),
	"market_fee_pct" numeric(5, 2),
	"labour_per_bag" numeric(14, 2),
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commodities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commodities" ADD CONSTRAINT "commodities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commodities" ADD CONSTRAINT "commodities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commodities_tenant_id_name_key" ON "commodities" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "commodities" AS PERMISSIVE FOR ALL TO "app_tenant" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);