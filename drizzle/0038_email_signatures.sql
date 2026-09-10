CREATE TABLE "email_signatures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "mailbox_id" uuid,
  "name" text DEFAULT 'Firma' NOT NULL,
  "body_text" text DEFAULT '' NOT NULL,
  "body_html" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_signatures_account_id_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE cascade,
  CONSTRAINT "email_signatures_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade,
  CONSTRAINT "email_signatures_mailbox_id_email_mailboxes_id_fk"
    FOREIGN KEY ("mailbox_id") REFERENCES "email_mailboxes"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "email_signatures_account_user_default_key"
  ON "email_signatures" ("account_id", "user_id")
  WHERE "mailbox_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "email_signatures_account_user_mailbox_key"
  ON "email_signatures" ("account_id", "user_id", "mailbox_id")
  WHERE "mailbox_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_email_signatures_account_user"
  ON "email_signatures" ("account_id", "user_id");
