import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { broadcastRecipients, broadcasts, contacts } from "@/db/schema";
import {
  serializeBroadcast,
  serializeBroadcastRecipient,
} from "@/lib/broadcasts/serialize";
import { publishRealtimeEvent } from "@/lib/realtime/soketi-server";

export async function publishBroadcastUpdated(accountId: string, broadcastId: string) {
  const [broadcast] = await db
    .select()
    .from(broadcasts)
    .where(and(eq(broadcasts.accountId, accountId), eq(broadcasts.id, broadcastId)))
    .limit(1);

  if (!broadcast) return;

  await publishRealtimeEvent("broadcast.updated", {
    accountId,
    payload: { broadcast: serializeBroadcast(broadcast) },
  }).catch((error) => {
    console.warn("[realtime] failed to publish broadcast.updated:", error);
  });
}

export async function publishBroadcastRecipientUpdated(
  accountId: string,
  recipientId: string,
) {
  const [row] = await db
    .select({ recipient: broadcastRecipients, contact: contacts, broadcast: broadcasts })
    .from(broadcastRecipients)
    .innerJoin(broadcasts, eq(broadcasts.id, broadcastRecipients.broadcastId))
    .leftJoin(contacts, eq(contacts.id, broadcastRecipients.contactId))
    .where(
      and(
        eq(broadcastRecipients.id, recipientId),
        eq(broadcasts.accountId, accountId),
      ),
    )
    .limit(1);

  if (!row) return;

  await Promise.all([
    publishRealtimeEvent("broadcast_recipient.updated", {
      accountId,
      payload: {
        recipient: serializeBroadcastRecipient(row.recipient, row.contact),
      },
    }).catch((error) => {
      console.warn("[realtime] failed to publish broadcast_recipient.updated:", error);
    }),
    publishRealtimeEvent("broadcast.updated", {
      accountId,
      payload: { broadcast: serializeBroadcast(row.broadcast) },
    }).catch((error) => {
      console.warn("[realtime] failed to publish broadcast.updated:", error);
    }),
  ]);
}

export async function publishBroadcastRecipientUpdatedById(recipientId: string) {
  const [row] = await db
    .select({ accountId: broadcasts.accountId })
    .from(broadcastRecipients)
    .innerJoin(broadcasts, eq(broadcasts.id, broadcastRecipients.broadcastId))
    .where(eq(broadcastRecipients.id, recipientId))
    .limit(1);

  if (!row) return;
  await publishBroadcastRecipientUpdated(row.accountId, recipientId);
}
