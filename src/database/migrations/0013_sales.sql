CREATE TABLE "sale_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"sale_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"basis" varchar(10) NOT NULL,
	"value" numeric(14, 2) NOT NULL,
	"amount" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sale_charges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sale_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"sale_id" uuid NOT NULL,
	"commodity_id" uuid NOT NULL,
	"purchase_item_id" uuid,
	"bags" integer,
	"weight_kg" numeric(12, 3) NOT NULL,
	"rate" numeric(14, 2) NOT NULL,
	"rate_unit" varchar(10) NOT NULL,
	"amount" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sale_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"bill_no" varchar(30) NOT NULL,
	"buyer_id" uuid NOT NULL,
	"sale_date" date NOT NULL,
	"gross_amount" numeric(14, 2) NOT NULL,
	"total_charges" numeric(14, 2) DEFAULT '0' NOT NULL,
	"net_amount" numeric(14, 2) NOT NULL,
	"received_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"status" "doc_status" DEFAULT 'posted' NOT NULL,
	"notes" text,
	"idempotency_key" varchar(64)
);
--> statement-breakpoint
ALTER TABLE "sales" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "credit_limit_action" varchar(10) DEFAULT 'warn' NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_charges" ADD CONSTRAINT "sale_charges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_charges" ADD CONSTRAINT "sale_charges_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_charges" ADD CONSTRAINT "sale_charges_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_commodity_id_commodities_id_fk" FOREIGN KEY ("commodity_id") REFERENCES "public"."commodities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_purchase_item_id_purchase_items_id_fk" FOREIGN KEY ("purchase_item_id") REFERENCES "public"."purchase_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_buyer_id_traders_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."traders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_charges_tenant_id_sale_id_idx" ON "sale_charges" USING btree ("tenant_id","sale_id");--> statement-breakpoint
CREATE INDEX "sale_items_tenant_id_sale_id_idx" ON "sale_items" USING btree ("tenant_id","sale_id");--> statement-breakpoint
CREATE INDEX "sale_items_tenant_id_commodity_id_idx" ON "sale_items" USING btree ("tenant_id","commodity_id");--> statement-breakpoint
CREATE INDEX "sale_items_tenant_id_purchase_item_id_idx" ON "sale_items" USING btree ("tenant_id","purchase_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_tenant_id_bill_no_key" ON "sales" USING btree ("tenant_id","bill_no");--> statement-breakpoint
CREATE INDEX "sales_tenant_id_sale_date_idx" ON "sales" USING btree ("tenant_id","sale_date");--> statement-breakpoint
CREATE INDEX "sales_tenant_id_buyer_id_idx" ON "sales" USING btree ("tenant_id","buyer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_tenant_id_idempotency_key_key" ON "sales" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sale_charges" AS PERMISSIVE FOR ALL TO "app_tenant" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sale_items" AS PERMISSIVE FOR ALL TO "app_tenant" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sales" AS PERMISSIVE FOR ALL TO "app_tenant" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);