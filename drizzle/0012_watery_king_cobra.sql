CREATE TABLE "contact_custom_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"custom_field_id" uuid NOT NULL,
	"value" text
);
--> statement-breakpoint
CREATE TABLE "custom_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"field_name" text NOT NULL,
	"field_type" text DEFAULT 'text' NOT NULL,
	"field_options" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_custom_values" ADD CONSTRAINT "contact_custom_values_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_custom_values" ADD CONSTRAINT "contact_custom_values_custom_field_id_custom_fields_id_fk" FOREIGN KEY ("custom_field_id") REFERENCES "public"."custom_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_custom_values_contact_field_key" ON "contact_custom_values" USING btree ("contact_id","custom_field_id");--> statement-breakpoint
CREATE INDEX "idx_contact_custom_values_contact" ON "contact_custom_values" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_fields_account_name_key" ON "custom_fields" USING btree ("account_id","field_name");--> statement-breakpoint
CREATE INDEX "idx_custom_fields_account" ON "custom_fields" USING btree ("account_id");