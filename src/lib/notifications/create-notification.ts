import { db } from "@/db/client";
import { notifications } from "@/db/schema";
import { publishRealtimeEvent } from "@/lib/realtime/soketi-server";

export function serializeNotification(row: typeof notifications.$inferSelect) {
  return {
    id: row.id,
    account_id: row.accountId,
    user_id: row.userId,
    type: row.type,
    conversation_id: row.conversationId,
    contact_id: row.contactId,
    actor_user_id: row.actorUserId,
    title: row.title,
    body: row.body,
    read_at: row.readAt?.toISOString(),
    created_at: row.createdAt.toISOString(),
  };
}

export async function createRealtimeNotification(input: {
  accountId: string;
  userId: string;
  type?: string;
  conversationId?: string | null;
  contactId?: string | null;
  actorUserId?: string | null;
  title: string;
  body?: string | null;
}) {
  const [notification] = await db
    .insert(notifications)
    .values({
      accountId: input.accountId,
      userId: input.userId,
      type: input.type ?? "conversation_assigned",
      conversationId: input.conversationId ?? null,
      contactId: input.contactId ?? null,
      actorUserId: input.actorUserId ?? null,
      title: input.title,
      body: input.body ?? null,
    })
    .returning();

  if (!notification) return null;

  const serialized = serializeNotification(notification);
  await publishRealtimeEvent("notification.created", {
    accountId: input.accountId,
    conversationId: input.conversationId ?? undefined,
    payload: { notification: serialized },
  }).catch((error) => {
    console.warn("[realtime] failed to publish notification.created:", error);
  });

  return serialized;
}
