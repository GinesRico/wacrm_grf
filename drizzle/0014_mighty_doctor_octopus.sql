CREATE TABLE "broadcast_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"contact_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"error_message" text,
	"whatsapp_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"template_name" text NOT NULL,
	"template_language" text DEFAULT 'en_US' NOT NULL,
	"template_variables" jsonb,
	"audience_filter" jsonb,
	"scheduled_at" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"total_recipients" integer DEFAULT 0,
	"sent_count" integer DEFAULT 0,
	"delivered_count" integer DEFAULT 0,
	"read_count" integer DEFAULT 0,
	"replied_count" integer DEFAULT 0,
	"failed_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_broadcast_recipients_broadcast" ON "broadcast_recipients" USING btree ("broadcast_id");--> statement-breakpoint
CREATE INDEX "idx_broadcast_recipients_broadcast_status" ON "broadcast_recipients" USING btree ("broadcast_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_broadcast_recipients_wamid" ON "broadcast_recipients" USING btree ("whatsapp_message_id");--> statement-breakpoint
CREATE INDEX "idx_broadcasts_account" ON "broadcasts" USING btree ("account_id");