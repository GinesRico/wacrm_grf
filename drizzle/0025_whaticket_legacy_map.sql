CREATE TABLE "whaticket_legacy_map" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"import_key" text NOT NULL,
	"entity_type" text NOT NULL,
	"legacy_id" text NOT NULL,
	"new_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whaticket_legacy_map" ADD CONSTRAINT "whaticket_legacy_map_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "whaticket_legacy_map_unique" ON "whaticket_legacy_map" USING btree ("account_id","import_key","entity_type","legacy_id");
--> statement-breakpoint
CREATE INDEX "idx_whaticket_legacy_map_lookup" ON "whaticket_legacy_map" USING btree ("account_id","import_key","entity_type");
