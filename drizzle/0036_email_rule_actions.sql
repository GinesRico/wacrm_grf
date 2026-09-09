ALTER TABLE "email_rules" ALTER COLUMN "target_folder_id" DROP NOT NULL;
ALTER TABLE "email_rules" ADD COLUMN "action" text DEFAULT 'move_to' NOT NULL;
ALTER TABLE "email_rules" ADD COLUMN "action_value" text;
ALTER TABLE "email_rules" DROP CONSTRAINT IF EXISTS "email_rules_field_check";
ALTER TABLE "email_rules" ADD CONSTRAINT "email_rules_field_check" CHECK ("email_rules"."field" in ('from','from_domain','subject','body','to','cc','to_or_cc','recipients','age_days','size_kb','has_attachment'));
ALTER TABLE "email_rules" DROP CONSTRAINT IF EXISTS "email_rules_operator_check";
ALTER TABLE "email_rules" ADD CONSTRAINT "email_rules_operator_check" CHECK ("email_rules"."operator" in ('contains','not_contains','equals','not_equals','starts_with','ends_with','exists','not_exists','greater_than','less_than'));
ALTER TABLE "email_rules" ADD CONSTRAINT "email_rules_action_check" CHECK ("email_rules"."action" in ('move_to','copy_to','mark_read','mark_unread','star','label'));
ALTER TABLE "email_rules" ADD CONSTRAINT "email_rules_target_required_check" CHECK (("email_rules"."action" in ('move_to','copy_to') AND "email_rules"."target_folder_id" IS NOT NULL) OR ("email_rules"."action" NOT IN ('move_to','copy_to')));
