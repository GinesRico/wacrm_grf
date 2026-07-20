CREATE TABLE "contact_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"note_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_contact_notes_contact" ON "contact_notes" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "idx_contact_notes_account" ON "contact_notes" USING btree ("account_id");