CREATE TABLE "whatsapp_meta_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"flow_id" text NOT NULL,
	"title" text NOT NULL,
	"body_text" text NOT NULL,
	"footer_text" text,
	"button_text" text NOT NULL,
	"initial_screen" text DEFAULT 'APPOINTMENT' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_meta_flows" ADD CONSTRAINT "whatsapp_meta_flows_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_meta_flows_account_slug_key" ON "whatsapp_meta_flows" USING btree ("account_id","slug");
--> statement-breakpoint
CREATE INDEX "idx_whatsapp_meta_flows_account_active" ON "whatsapp_meta_flows" USING btree ("account_id","active");
