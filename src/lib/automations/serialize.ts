import type { InferSelectModel } from "drizzle-orm";

import type { Automation, AutomationLog } from "@/types";
import type { automations, automationLogs, contacts } from "@/db/schema";

type AutomationRow = InferSelectModel<typeof automations>;
type AutomationLogRow = InferSelectModel<typeof automationLogs>;
type ContactRow = Pick<
  InferSelectModel<typeof contacts>,
  "id" | "name" | "phone" | "email" | "company" | "avatarUrl" | "createdAt" | "updatedAt"
>;

export function serializeAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    account_id: row.accountId,
    user_id: row.userId,
    name: row.name,
    description: row.description ?? undefined,
    trigger_type: row.triggerType as Automation["trigger_type"],
    trigger_config: row.triggerConfig as Automation["trigger_config"],
    is_active: row.isActive,
    execution_count: row.executionCount,
    last_executed_at: row.lastExecutedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function serializeAutomationLog(
  row: AutomationLogRow,
  contact?: ContactRow | null,
): AutomationLog {
  return {
    id: row.id,
    automation_id: row.automationId,
    user_id: row.userId,
    contact_id: row.contactId,
    trigger_event: row.triggerEvent,
    steps_executed: row.stepsExecuted as AutomationLog["steps_executed"],
    status: row.status as AutomationLog["status"],
    error_message: row.errorMessage,
    created_at: row.createdAt.toISOString(),
    contact: contact
      ? {
          id: contact.id,
          user_id: "",
          account_id: "",
          phone: contact.phone,
          name: contact.name ?? undefined,
          email: contact.email ?? undefined,
          company: contact.company ?? undefined,
          avatar_url: contact.avatarUrl ?? undefined,
          created_at: contact.createdAt.toISOString(),
          updated_at: contact.updatedAt.toISOString(),
        }
      : undefined,
  };
}
