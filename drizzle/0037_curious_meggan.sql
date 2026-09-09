ALTER TABLE "email_messages"
  ADD COLUMN "imap_flags" text[] DEFAULT '{}' NOT NULL,
  ADD COLUMN "external_state" text DEFAULT 'present' NOT NULL,
  ADD COLUMN "folder_source" text DEFAULT 'imap' NOT NULL,
  ADD COLUMN "last_imap_sync_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "email_messages"
  ADD CONSTRAINT "email_messages_external_state_check"
  CHECK ("email_messages"."external_state" in ('present', 'missing'));
--> statement-breakpoint
ALTER TABLE "email_messages"
  ADD CONSTRAINT "email_messages_folder_source_check"
  CHECK ("email_messages"."folder_source" in ('imap', 'local'));
--> statement-breakpoint
CREATE INDEX "idx_email_messages_external_state"
  ON "email_messages" ("email_account_id", "external_state", "last_imap_sync_at");
