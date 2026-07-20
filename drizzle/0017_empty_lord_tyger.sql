CREATE TABLE "flow_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_id" uuid NOT NULL,
	"node_key" text NOT NULL,
	"node_type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position_x" integer DEFAULT 0 NOT NULL,
	"position_y" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_nodes_node_type_check" CHECK ("flow_nodes"."node_type" in ('start', 'send_buttons', 'send_list', 'send_message', 'send_media', 'collect_input', 'condition', 'set_tag', 'handoff', 'http_fetch', 'end'))
);
--> statement-breakpoint
CREATE TABLE "flow_run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_run_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"node_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_run_events_event_type_check" CHECK ("flow_run_events"."event_type" in ('started', 'node_entered', 'message_sent', 'reply_received', 'fallback_fired', 'handoff', 'timeout', 'error', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "flow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"conversation_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"current_node_key" text,
	"last_prompt_message_id" uuid,
	"vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reprompt_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_advanced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	CONSTRAINT "flow_runs_status_check" CHECK ("flow_runs"."status" in ('active', 'completed', 'handed_off', 'timed_out', 'paused_by_agent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"entry_node_id" text,
	"fallback_policy" jsonb DEFAULT '{"on_unknown_reply":"reprompt","max_reprompts":2,"on_timeout_hours":24,"on_exhaust":"handoff"}'::jsonb NOT NULL,
	"execution_count" integer DEFAULT 0 NOT NULL,
	"last_executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flows_status_check" CHECK ("flows"."status" in ('draft', 'active', 'archived')),
	CONSTRAINT "flows_trigger_type_check" CHECK ("flows"."trigger_type" in ('keyword', 'first_inbound_message', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "flow_nodes" ADD CONSTRAINT "flow_nodes_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_run_events" ADD CONSTRAINT "flow_run_events_flow_run_id_flow_runs_id_fk" FOREIGN KEY ("flow_run_id") REFERENCES "public"."flow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_last_prompt_message_id_messages_id_fk" FOREIGN KEY ("last_prompt_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "flow_nodes_flow_id_node_key_key" ON "flow_nodes" USING btree ("flow_id","node_key");--> statement-breakpoint
CREATE INDEX "idx_flow_nodes_flow" ON "flow_nodes" USING btree ("flow_id");--> statement-breakpoint
CREATE INDEX "idx_flow_run_events_run_type" ON "flow_run_events" USING btree ("flow_run_id","event_type");--> statement-breakpoint
CREATE INDEX "idx_flow_run_events_run_time" ON "flow_run_events" USING btree ("flow_run_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_flow_runs_account" ON "flow_runs" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_flow_runs_active_advanced" ON "flow_runs" USING btree ("last_advanced_at");--> statement-breakpoint
CREATE INDEX "idx_flow_runs_flow_started" ON "flow_runs" USING btree ("flow_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_flows_account" ON "flows" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_flows_account_trigger" ON "flows" USING btree ("account_id","trigger_type");