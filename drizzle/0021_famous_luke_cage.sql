CREATE TABLE "appointment_availability_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"conversation_id" uuid,
	"provider" text DEFAULT 'arvera-appointments' NOT NULL,
	"date" date NOT NULL,
	"end_date" date,
	"send_mode" text DEFAULT 'booking_link' NOT NULL,
	"service" text,
	"slots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"short_url" text,
	"message_text" text NOT NULL,
	"raw_response" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_availability_send_mode_check" CHECK ("appointment_availability_messages"."send_mode" in ('booking_link', 'interactive_list', 'cta_url'))
);
--> statement-breakpoint
CREATE TABLE "appointment_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"provider" text DEFAULT 'arvera-appointments' NOT NULL,
	"external_id" text NOT NULL,
	"status" text,
	"service" text,
	"customer_name" text,
	"phone" text,
	"email" text,
	"start_time" timestamp with time zone,
	"end_time" timestamp with time zone,
	"cancel_url" text,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointment_availability_messages" ADD CONSTRAINT "appointment_availability_messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_availability_messages" ADD CONSTRAINT "appointment_availability_messages_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_availability_messages" ADD CONSTRAINT "appointment_availability_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_availability_messages" ADD CONSTRAINT "appointment_availability_messages_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_records" ADD CONSTRAINT "appointment_records_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_records" ADD CONSTRAINT "appointment_records_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_appointment_availability_account_created" ON "appointment_availability_messages" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_appointment_availability_contact" ON "appointment_availability_messages" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "idx_appointment_availability_conversation" ON "appointment_availability_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_records_account_provider_external_key" ON "appointment_records" USING btree ("account_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "idx_appointment_records_account_start" ON "appointment_records" USING btree ("account_id","start_time");--> statement-breakpoint
CREATE INDEX "idx_appointment_records_contact" ON "appointment_records" USING btree ("contact_id");