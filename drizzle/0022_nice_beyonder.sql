CREATE TABLE "ai_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"created_by" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"api_key" text NOT NULL,
	"system_prompt" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"auto_reply_enabled" boolean DEFAULT false NOT NULL,
	"auto_reply_max_per_conversation" integer DEFAULT 3 NOT NULL,
	"handoff_agent_id" text,
	"embeddings_api_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_configs_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "ai_configs_provider_check" CHECK ("ai_configs"."provider" in ('openai', 'anthropic')),
	CONSTRAINT "ai_configs_auto_reply_max_check" CHECK ("ai_configs"."auto_reply_max_per_conversation" between 1 and 20)
);
--> statement-breakpoint
ALTER TABLE "ai_configs" ADD CONSTRAINT "ai_configs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_configs" ADD CONSTRAINT "ai_configs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_configs" ADD CONSTRAINT "ai_configs_handoff_agent_id_user_id_fk" FOREIGN KEY ("handoff_agent_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;