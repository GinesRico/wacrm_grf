CREATE TABLE "integration_apps" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"app_slug" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"encrypted_credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'not_configured' NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_connections_status_check" CHECK ("integration_connections"."status" in ('not_configured', 'active', 'disabled', 'error'))
);
--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_app_slug_integration_apps_slug_fk" FOREIGN KEY ("app_slug") REFERENCES "public"."integration_apps"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_account_app_key" ON "integration_connections" USING btree ("account_id","app_slug");--> statement-breakpoint
CREATE INDEX "idx_integration_connections_account" ON "integration_connections" USING btree ("account_id");