CREATE TABLE "number_sequences" (
	"tenant_id" uuid NOT NULL,
	"doc_type" varchar(20) NOT NULL,
	"financial_year" varchar(9) NOT NULL,
	"prefix" varchar(10),
	"next_number" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "number_sequences_tenant_id_doc_type_financial_year_pk" PRIMARY KEY("tenant_id","doc_type","financial_year")
);
--> statement-breakpoint
ALTER TABLE "number_sequences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "number_sequences" AS PERMISSIVE FOR ALL TO "app_tenant" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);