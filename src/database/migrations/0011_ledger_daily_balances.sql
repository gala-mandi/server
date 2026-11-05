CREATE TABLE "ledger_daily_balances" (
	"tenant_id" uuid NOT NULL,
	"trader_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"debit" numeric(14, 2) DEFAULT '0' NOT NULL,
	"credit" numeric(14, 2) DEFAULT '0' NOT NULL,
	CONSTRAINT "ledger_daily_balances_tenant_id_trader_id_entry_date_pk" PRIMARY KEY("tenant_id","trader_id","entry_date")
);
--> statement-breakpoint
ALTER TABLE "ledger_daily_balances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ledger_daily_balances" ADD CONSTRAINT "ledger_daily_balances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_daily_balances" ADD CONSTRAINT "ledger_daily_balances_trader_id_traders_id_fk" FOREIGN KEY ("trader_id") REFERENCES "public"."traders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ledger_daily_balances" AS PERMISSIVE FOR ALL TO "app_tenant" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Hand-written below this line (keep it when this migration is regenerated).
-- Daily balance snapshots: every new khata entry adds its amounts to its
-- trader's day, in the same transaction. SECURITY DEFINER so only this
-- trigger writes the table; the entry itself already passed RLS.
CREATE FUNCTION "ledger_daily_balances_add"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO ledger_daily_balances (tenant_id, trader_id, entry_date, debit, credit)
  VALUES (NEW.tenant_id, NEW.trader_id, NEW.entry_date, NEW.debit, NEW.credit)
  ON CONFLICT (tenant_id, trader_id, entry_date) DO UPDATE
    SET debit = ledger_daily_balances.debit + EXCLUDED.debit,
        credit = ledger_daily_balances.credit + EXCLUDED.credit;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "ledger_entries_daily_balances" AFTER INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_daily_balances_add"();--> statement-breakpoint
-- Entries written before this migration (the trigger above already locks
-- ledger_entries, so nothing is counted twice).
INSERT INTO "ledger_daily_balances" ("tenant_id", "trader_id", "entry_date", "debit", "credit")
  SELECT "tenant_id", "trader_id", "entry_date", sum("debit"), sum("credit")
    FROM "ledger_entries"
   GROUP BY "tenant_id", "trader_id", "entry_date";--> statement-breakpoint
-- The khata is append-only: the API may read and add entries, never change
-- or remove them, and only reads the snapshots.
REVOKE UPDATE, DELETE, TRUNCATE ON "ledger_entries" FROM "app_tenant";--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "ledger_daily_balances" FROM "app_tenant";
