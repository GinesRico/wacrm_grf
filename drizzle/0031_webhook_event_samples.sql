CREATE TABLE IF NOT EXISTS "webhook_event_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"source" text NOT NULL,
	"event_type" text NOT NULL,
	"trigger_type" text,
	"sample_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"variable_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'webhook_event_samples_account_id_accounts_id_fk'
	) THEN
		ALTER TABLE "webhook_event_samples"
			ADD CONSTRAINT "webhook_event_samples_account_id_accounts_id_fk"
			FOREIGN KEY ("account_id")
			REFERENCES "public"."accounts"("id")
			ON DELETE cascade
			ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_event_samples_account_source_event_key"
	ON "webhook_event_samples" USING btree ("account_id","source","event_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_event_samples_account_trigger"
	ON "webhook_event_samples" USING btree ("account_id","trigger_type");
