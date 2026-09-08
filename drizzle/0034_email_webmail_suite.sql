ALTER TABLE "email_messages" ADD COLUMN "is_starred" boolean DEFAULT false NOT NULL;

CREATE TABLE "email_labels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "mailbox_id" uuid REFERENCES "email_mailboxes"("id") ON DELETE cascade,
  "created_by" text REFERENCES "user"("id") ON DELETE set null,
  "name" text NOT NULL,
  "color" text DEFAULT '#64748b' NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "email_message_labels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "message_id" uuid NOT NULL REFERENCES "email_messages"("id") ON DELETE cascade,
  "label_id" uuid NOT NULL REFERENCES "email_labels"("id") ON DELETE cascade,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "email_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "mailbox_id" uuid NOT NULL REFERENCES "email_mailboxes"("id") ON DELETE cascade,
  "to_addresses" text[] DEFAULT '{}'::text[] NOT NULL,
  "cc_addresses" text[] DEFAULT '{}'::text[] NOT NULL,
  "bcc_addresses" text[] DEFAULT '{}'::text[] NOT NULL,
  "subject" text DEFAULT '' NOT NULL,
  "body_text" text DEFAULT '' NOT NULL,
  "body_html" text,
  "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "in_reply_to_message_id" uuid REFERENCES "email_messages"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "email_trusted_senders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "sender_address" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "email_user_preferences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "layout" text DEFAULT 'three-pane' NOT NULL,
  "reading_pane" text DEFAULT 'right' NOT NULL,
  "block_external_content" boolean DEFAULT true NOT NULL,
  "plain_text_composer" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_user_preferences_layout_check" CHECK ("email_user_preferences"."layout" in ('three-pane', 'focused-list', 'bottom-pane')),
  CONSTRAINT "email_user_preferences_reading_pane_check" CHECK ("email_user_preferences"."reading_pane" in ('right', 'bottom'))
);

CREATE UNIQUE INDEX "email_labels_mailbox_name_key" ON "email_labels" ("mailbox_id","name");
CREATE INDEX "idx_email_labels_account_mailbox" ON "email_labels" ("account_id","mailbox_id");
CREATE UNIQUE INDEX "email_message_labels_message_label_key" ON "email_message_labels" ("message_id","label_id");
CREATE INDEX "idx_email_message_labels_account_label" ON "email_message_labels" ("account_id","label_id");
CREATE INDEX "idx_email_drafts_account_user_updated" ON "email_drafts" ("account_id","user_id","updated_at");
CREATE INDEX "idx_email_drafts_mailbox" ON "email_drafts" ("mailbox_id");
CREATE UNIQUE INDEX "email_trusted_senders_user_sender_key" ON "email_trusted_senders" ("account_id","user_id","sender_address");
CREATE UNIQUE INDEX "email_user_preferences_account_user_key" ON "email_user_preferences" ("account_id","user_id");
CREATE INDEX "idx_email_messages_starred" ON "email_messages" ("account_id","mailbox_id","is_starred");
