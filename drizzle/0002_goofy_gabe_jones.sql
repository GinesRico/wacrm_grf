CREATE TABLE "platform_account_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"account_name" text NOT NULL,
	"owner_email" text NOT NULL,
	"plan" text DEFAULT 'starter' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"max_users" integer DEFAULT 3 NOT NULL,
	"max_flows" integer DEFAULT 5 NOT NULL,
	"max_automations" integer DEFAULT 5 NOT NULL,
	"max_whatsapp_lines" integer DEFAULT 1 NOT NULL,
	"allow_ai" boolean DEFAULT false NOT NULL,
	"allow_api" boolean DEFAULT false NOT NULL,
	"allow_broadcasts" boolean DEFAULT true NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" text,
	CONSTRAINT "platform_account_invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "platform_account_invites" ADD CONSTRAINT "platform_account_invites_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_account_invites" ADD CONSTRAINT "platform_account_invites_accepted_by_user_id_user_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_platform_account_invites_pending" ON "platform_account_invites" USING btree ("expires_at");