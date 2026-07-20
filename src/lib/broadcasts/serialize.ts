import type { broadcastRecipients, broadcasts, contacts } from "@/db/schema";
import { serializeContact } from "@/lib/contacts/serialize";

export function serializeBroadcast(row: typeof broadcasts.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    name: row.name,
    template_name: row.templateName,
    template_language: row.templateLanguage,
    template_variables: row.templateVariables,
    audience_filter: row.audienceFilter,
    scheduled_at: row.scheduledAt?.toISOString() ?? null,
    status: row.status,
    total_recipients: row.totalRecipients ?? 0,
    sent_count: row.sentCount ?? 0,
    delivered_count: row.deliveredCount ?? 0,
    read_count: row.readCount ?? 0,
    replied_count: row.repliedCount ?? 0,
    failed_count: row.failedCount ?? 0,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function serializeBroadcastRecipient(
  row: typeof broadcastRecipients.$inferSelect,
  contact?: typeof contacts.$inferSelect | null,
) {
  return {
    id: row.id,
    broadcast_id: row.broadcastId,
    contact_id: row.contactId,
    status: row.status,
    sent_at: row.sentAt?.toISOString() ?? null,
    delivered_at: row.deliveredAt?.toISOString() ?? null,
    read_at: row.readAt?.toISOString() ?? null,
    replied_at: row.repliedAt?.toISOString() ?? null,
    error_message: row.errorMessage,
    whatsapp_message_id: row.whatsappMessageId,
    created_at: row.createdAt.toISOString(),
    contact: contact ? serializeContact(contact) : undefined,
  };
}
