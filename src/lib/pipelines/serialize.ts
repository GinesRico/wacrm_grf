import type {
  contacts,
  deals,
  pipelineStages,
  pipelines,
  profiles,
} from "@/db/schema";
import { serializeContact } from "@/lib/contacts/serialize";

export function serializePipeline(row: typeof pipelines.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    name: row.name,
    created_at: row.createdAt.toISOString(),
  };
}

export function serializeStage(row: typeof pipelineStages.$inferSelect) {
  return {
    id: row.id,
    pipeline_id: row.pipelineId,
    name: row.name,
    position: row.position,
    color: row.color,
    created_at: row.createdAt.toISOString(),
  };
}

export function serializeProfile(row: typeof profiles.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    full_name: row.fullName,
    email: row.email,
    avatar_url: row.avatarUrl,
    role: row.role,
    beta_features: row.betaFeatures,
    account_id: row.accountId,
    account_role: row.accountRole,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function serializeDeal(
  row: typeof deals.$inferSelect,
  extras?: {
    contact?: typeof contacts.$inferSelect | null;
    assignee?: typeof profiles.$inferSelect | null;
    stage?: typeof pipelineStages.$inferSelect | null;
  },
) {
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    pipeline_id: row.pipelineId,
    stage_id: row.stageId,
    contact_id: row.contactId,
    conversation_id: row.conversationId,
    assigned_to: row.assignedTo,
    title: row.title,
    value: Number(row.value),
    currency: row.currency,
    notes: row.notes,
    expected_close_date: row.expectedCloseDate,
    status: row.status,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    contact: extras?.contact ? serializeContact(extras.contact) : undefined,
    assignee: extras?.assignee ? serializeProfile(extras.assignee) : undefined,
    stage: extras?.stage ? serializeStage(extras.stage) : undefined,
  };
}
