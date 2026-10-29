-- Trigram search on trader names (ILIKE '%ali%').
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."trader_type" AS ENUM('kissan', 'beopari', 'arhti');--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trader_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"source_type" varchar(20) NOT NULL,
	"source_id" uuid,
	"debit" numeric(14, 2) DEFAULT '0' NOT NULL,
	"credit" numeric(14, 2) DEFAULT '0' NOT NULL,
	"narration" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "traders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"type" "trader_type" NOT NULL,
	"name" varchar(120) NOT NULL,
	"father_name" varchar(120),
	"phone" varchar(20),
	"cnic" varchar(15),
	"village" varchar(80),
	"address" text,
	"opening_balance" numeric(14, 2) DEFAULT '0' NOT NULL,
	"opening_balance_type" varchar(6) DEFAULT 'debit' NOT NULL,
	"credit_limit" numeric(14, 2),
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "traders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_trader_id_traders_id_fk" FOREIGN KEY ("trader_id") REFERENCES "public"."traders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traders" ADD CONSTRAINT "traders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traders" ADD CONSTRAINT "traders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_tenant_id_trader_id_entry_date_idx" ON "ledger_entries" USING btree ("tenant_id","trader_id","entry_date");--> statement-breakpoint
CREATE INDEX "ledger_entries_tenant_id_source_type_source_id_idx" ON "ledger_entries" USING btree ("tenant_id","source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "traders_tenant_id_phone_key" ON "traders" USING btree ("tenant_id","phone");--> statement-breakpoint
CREATE INDEX "traders_tenant_id_type_idx" ON "traders" USING btree ("tenant_id","type");--> statement-breakpoint
CREATE INDEX "traders_name_trgm_idx" ON "traders" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ledger_entries" AS PERMISSIVE FOR ALL TO "app_tenant" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "traders" AS PERMISSIVE FOR ALL TO "app_tenant" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);