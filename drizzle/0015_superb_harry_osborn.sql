CREATE TABLE "automation_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"trigger_event" text NOT NULL,
	"steps_executed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_logs_status_check" CHECK ("automation_logs"."status" in ('success', 'partial', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "automation_pending_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"contact_id" uuid,
	"log_id" uuid,
	"parent_step_id" uuid,
	"branch" text,
	"next_step_position" integer NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_pending_executions_branch_check" CHECK ("automation_pending_executions"."branch" in ('yes', 'no')),
	CONSTRAINT "automation_pending_executions_status_check" CHECK ("automation_pending_executions"."status" in ('pending', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "automation_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"parent_step_id" uuid,
	"branch" text,
	"step_type" text NOT NULL,
	"step_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_steps_branch_check" CHECK ("automation_steps"."branch" in ('yes', 'no'))
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger_type" text NOT NULL,
	"trigger_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"execution_count" integer DEFAULT 0 NOT NULL,
	"last_executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_log_id_automation_logs_id_fk" FOREIGN KEY ("log_id") REFERENCES "public"."automation_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_parent_step_id_automation_steps_id_fk" FOREIGN KEY ("parent_step_id") REFERENCES "public"."automation_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_steps" ADD CONSTRAINT "automation_steps_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_automation_logs_account" ON "automation_logs" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_automation_logs_automation" ON "automation_logs" USING btree ("automation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_automation_logs_user" ON "automation_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_automation_pending_due" ON "automation_pending_executions" USING btree ("run_at");--> statement-breakpoint
CREATE INDEX "idx_automation_steps_automation_id" ON "automation_steps" USING btree ("automation_id","position");--> statement-breakpoint
CREATE INDEX "idx_automation_steps_parent" ON "automation_steps" USING btree ("parent_step_id");--> statement-breakpoint
CREATE INDEX "idx_automations_account" ON "automations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_automations_user_id" ON "automations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_automations_account_active_trigger" ON "automations" USING btree ("account_id","trigger_type");