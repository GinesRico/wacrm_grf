CREATE TABLE "payment_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"conversation_id" uuid,
	"provider" text DEFAULT 'arvera-payments' NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"concept" text NOT NULL,
	"email" text,
	"phone" text,
	"order_id" text NOT NULL,
	"payment_url" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"raw_response" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_links_amount_cents_check" CHECK ("payment_links"."amount_cents" > 0),
	CONSTRAINT "payment_links_status_check" CHECK ("payment_links"."status" in ('pending', 'paid', 'failed', 'expired', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_account_provider_order_key" ON "payment_links" USING btree ("account_id","provider","order_id");--> statement-breakpoint
CREATE INDEX "idx_payment_links_account_created" ON "payment_links" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_payment_links_status" ON "payment_links" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "idx_payment_links_contact" ON "payment_links" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "idx_payment_links_conversation" ON "payment_links" USING btree ("conversation_id");