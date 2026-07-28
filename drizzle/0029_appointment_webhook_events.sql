CREATE TABLE IF NOT EXISTS "appointment_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"external_id" text NOT NULL,
	"event_timestamp" integer NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'appointment_webhook_events_account_id_accounts_id_fk'
	) THEN
		ALTER TABLE "appointment_webhook_events"
			ADD CONSTRAINT "appointment_webhook_events_account_id_accounts_id_fk"
			FOREIGN KEY ("account_id")
			REFERENCES "public"."accounts"("id")
			ON DELETE cascade
			ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_appointment_webhook_events_account"
	ON "appointment_webhook_events" USING btree ("account_id");
