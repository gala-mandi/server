CREATE TYPE "public"."doc_status" AS ENUM('draft', 'posted', 'cancelled');--> statement-breakpoint
CREATE TABLE "purchase_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"purchase_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"basis" varchar(10) NOT NULL,
	"value" numeric(14, 2) NOT NULL,
	"amount" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchase_charges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "purchase_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"purchase_id" uuid NOT NULL,
	"commodity_id" uuid NOT NULL,
	"bags" integer,
	"weight_kg" numeric(12, 3) NOT NULL,
	"rate" numeric(14, 2) NOT NULL,
	"rate_unit" varchar(10) NOT NULL,
	"amount" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchase_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"bill_no" varchar(30) NOT NULL,
	"trader_id" uuid NOT NULL,
	"purchase_date" date NOT NULL,
	"gross_amount" numeric(14, 2) NOT NULL,
	"total_deductions" numeric(14, 2) DEFAULT '0' NOT NULL,
	"net_amount" numeric(14, 2) NOT NULL,
	"paid_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"status" "doc_status" DEFAULT 'posted' NOT NULL,
	"notes" text,
	"idempotency_key" varchar(64)
);
--> statement-breakpoint
ALTER TABLE "purchases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "purchase_charges" ADD CONSTRAINT "purchase_charges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_charges" ADD CONSTRAINT "purchase_charges_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_charges" ADD CONSTRAINT "purchase_charges_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_commodity_id_commodities_id_fk" FOREIGN KEY ("commodity_id") REFERENCES "public"."commodities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_trader_id_traders_id_fk" FOREIGN KEY ("trader_id") REFERENCES "public"."traders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_charges_tenant_id_purchase_id_idx" ON "purchase_charges" USING btree ("tenant_id","purchase_id");--> statement-breakpoint
CREATE INDEX "purchase_items_tenant_id_purchase_id_idx" ON "purchase_items" USING btree ("tenant_id","purchase_id");--> statement-breakpoint
CREATE INDEX "purchase_items_tenant_id_commodity_id_idx" ON "purchase_items" USING btree ("tenant_id","commodity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_tenant_id_bill_no_key" ON "purchases" USING btree ("tenant_id","bill_no");--> statement-breakpoint
CREATE INDEX "purchases_tenant_id_purchase_date_idx" ON "purchases" USING btree ("tenant_id","purchase_date");--> statement-breakpoint
CREATE INDEX "purchases_tenant_id_trader_id_idx" ON "purchases" USING btree ("tenant_id","trader_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_tenant_id_idempotency_key_key" ON "purchases" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "purchase_charges" AS PERMISSIVE FOR ALL TO "app_tenant" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "purchase_items" AS PERMISSIVE FOR ALL TO "app_tenant" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "purchases" AS PERMISSIVE FOR ALL TO "app_tenant" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);