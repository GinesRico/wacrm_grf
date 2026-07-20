CREATE TABLE "whatsapp_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"label" text,
	"phone_number_id" text NOT NULL,
	"waba_id" text,
	"access_token" text NOT NULL,
	"verify_token" text,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"connected_at" timestamp with time zone,
	"registered_at" timestamp with time zone,
	"subscribed_apps_at" timestamp with time zone,
	"last_registration_error" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_config" ADD CONSTRAINT "whatsapp_config_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_config" ADD CONSTRAINT "whatsapp_config_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_config_account_phone_number_id_key" ON "whatsapp_config" USING btree ("account_id","phone_number_id");--> statement-breakpoint
CREATE INDEX "idx_whatsapp_config_account_default" ON "whatsapp_config" USING btree ("account_id","is_default");