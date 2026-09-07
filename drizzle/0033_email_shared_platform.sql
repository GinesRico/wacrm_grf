CREATE TABLE "email_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "created_by" text REFERENCES "user"("id") ON DELETE set null,
  "label" text NOT NULL,
  "email_address" text NOT NULL,
  "imap_host" text NOT NULL,
  "imap_port" integer DEFAULT 993 NOT NULL,
  "imap_secure" boolean DEFAULT true NOT NULL,
  "smtp_host" text NOT NULL,
  "smtp_port" integer DEFAULT 465 NOT NULL,
  "smtp_secure" boolean DEFAULT true NOT NULL,
  "encrypted_credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "sync_mailbox" text DEFAULT 'INBOX' NOT NULL,
  "sync_cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "status" text DEFAULT 'not_configured' NOT NULL,
  "last_error" text,
  "last_synced_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_accounts_status_check" CHECK ("email_accounts"."status" in ('not_configured', 'active', 'disabled', 'error'))
);

CREATE TABLE "email_mailboxes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "email_account_id" uuid NOT NULL REFERENCES "email_accounts"("id") ON DELETE cascade,
  "owner_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "address" text NOT NULL,
  "display_name" text,
  "kind" text DEFAULT 'shared' NOT NULL,
  "can_send" boolean DEFAULT true NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_mailboxes_kind_check" CHECK ("email_mailboxes"."kind" in ('personal', 'shared'))
);

CREATE TABLE "email_folders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "mailbox_id" uuid NOT NULL REFERENCES "email_mailboxes"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "kind" text DEFAULT 'custom' NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_folders_kind_check" CHECK ("email_folders"."kind" in ('inbox', 'sent', 'archive', 'trash', 'custom'))
);

CREATE TABLE "email_permissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "department_id" uuid NOT NULL REFERENCES "departments"("id") ON DELETE cascade,
  "mailbox_id" uuid NOT NULL REFERENCES "email_mailboxes"("id") ON DELETE cascade,
  "folder_id" uuid REFERENCES "email_folders"("id") ON DELETE cascade,
  "can_read" boolean DEFAULT true NOT NULL,
  "can_move" boolean DEFAULT false NOT NULL,
  "can_classify" boolean DEFAULT false NOT NULL,
  "can_send" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "email_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "email_account_id" uuid NOT NULL REFERENCES "email_accounts"("id") ON DELETE cascade,
  "mailbox_id" uuid NOT NULL REFERENCES "email_mailboxes"("id") ON DELETE cascade,
  "folder_id" uuid NOT NULL REFERENCES "email_folders"("id") ON DELETE restrict,
  "imap_mailbox" text DEFAULT 'INBOX' NOT NULL,
  "imap_uid_validity" text DEFAULT '0' NOT NULL,
  "imap_uid" integer NOT NULL,
  "message_id" text,
  "thread_key" text,
  "subject" text DEFAULT '(Sin asunto)' NOT NULL,
  "from_name" text,
  "from_address" text NOT NULL,
  "to_addresses" text[] DEFAULT '{}'::text[] NOT NULL,
  "cc_addresses" text[] DEFAULT '{}'::text[] NOT NULL,
  "bcc_addresses" text[] DEFAULT '{}'::text[] NOT NULL,
  "reply_to_addresses" text[] DEFAULT '{}'::text[] NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "sent_at" timestamp with time zone,
  "snippet" text,
  "body_text" text,
  "body_html" text,
  "is_read" boolean DEFAULT false NOT NULL,
  "has_attachments" boolean DEFAULT false NOT NULL,
  "raw_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "raw_size" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "email_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "message_id" uuid NOT NULL REFERENCES "email_messages"("id") ON DELETE cascade,
  "file_name" text NOT NULL,
  "content_type" text,
  "size" integer,
  "storage_key" text NOT NULL,
  "content_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "email_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "mailbox_id" uuid REFERENCES "email_mailboxes"("id") ON DELETE cascade,
  "target_folder_id" uuid NOT NULL REFERENCES "email_folders"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "field" text NOT NULL,
  "operator" text DEFAULT 'contains' NOT NULL,
  "value" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_rules_field_check" CHECK ("email_rules"."field" in ('from', 'from_domain', 'subject', 'to', 'cc')),
  CONSTRAINT "email_rules_operator_check" CHECK ("email_rules"."operator" in ('contains', 'equals', 'starts_with', 'ends_with'))
);

CREATE TABLE "email_audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "user_id" text REFERENCES "user"("id") ON DELETE set null,
  "mailbox_id" uuid REFERENCES "email_mailboxes"("id") ON DELETE set null,
  "folder_id" uuid REFERENCES "email_folders"("id") ON DELETE set null,
  "message_id" uuid REFERENCES "email_messages"("id") ON DELETE set null,
  "event_type" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "email_accounts_account_address_key" ON "email_accounts" ("account_id","email_address");
CREATE INDEX "idx_email_accounts_account" ON "email_accounts" ("account_id");
CREATE UNIQUE INDEX "email_mailboxes_account_address_key" ON "email_mailboxes" ("account_id","address");
CREATE INDEX "idx_email_mailboxes_account" ON "email_mailboxes" ("account_id");
CREATE UNIQUE INDEX "email_folders_mailbox_slug_key" ON "email_folders" ("mailbox_id","slug");
CREATE INDEX "idx_email_folders_account_mailbox" ON "email_folders" ("account_id","mailbox_id");
CREATE UNIQUE INDEX "email_permissions_department_target_key" ON "email_permissions" ("department_id","mailbox_id","folder_id");
CREATE INDEX "idx_email_permissions_account_department" ON "email_permissions" ("account_id","department_id");
CREATE UNIQUE INDEX "email_messages_import_identity_key" ON "email_messages" ("email_account_id","imap_mailbox","imap_uid_validity","imap_uid");
CREATE INDEX "idx_email_messages_account_folder_received" ON "email_messages" ("account_id","folder_id","received_at");
CREATE INDEX "idx_email_messages_mailbox_received" ON "email_messages" ("mailbox_id","received_at");
CREATE INDEX "idx_email_attachments_message" ON "email_attachments" ("message_id");
CREATE INDEX "idx_email_attachments_account" ON "email_attachments" ("account_id");
CREATE INDEX "idx_email_rules_account_position" ON "email_rules" ("account_id","position");
CREATE INDEX "idx_email_audit_account_created" ON "email_audit_events" ("account_id","created_at");
CREATE INDEX "idx_email_audit_message" ON "email_audit_events" ("message_id");
