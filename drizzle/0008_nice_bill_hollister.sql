CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'Marketing' NOT NULL,
	"language" text DEFAULT 'en_US',
	"header_type" text,
	"header_content" text,
	"header_handle" text,
	"header_media_url" text,
	"body_text" text NOT NULL,
	"footer_text" text,
	"buttons" jsonb,
	"sample_values" jsonb,
	"status" text DEFAULT 'Draft',
	"meta_template_id" text,
	"rejection_reason" text,
	"quality_score" text,
	"submission_error" text,
	"last_submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_message_templates_account" ON "message_templates" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_message_templates_meta_id" ON "message_templates" USING btree ("meta_template_id");