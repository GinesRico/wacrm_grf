CREATE OR REPLACE FUNCTION public.increment_automation_execution_count(automation_id uuid)
RETURNS void
LANGUAGE sql
AS $$
	UPDATE "automations"
	SET
		"execution_count" = "execution_count" + 1,
		"last_executed_at" = now(),
		"updated_at" = now()
	WHERE "id" = automation_id;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.increment_flow_execution_count(flow_id uuid)
RETURNS void
LANGUAGE sql
AS $$
	UPDATE "flows"
	SET
		"execution_count" = "execution_count" + 1,
		"last_executed_at" = now(),
		"updated_at" = now()
	WHERE "id" = flow_id;
$$;
