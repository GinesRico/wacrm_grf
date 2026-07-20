import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { broadcastRecipients, broadcasts, contacts } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import {
  serializeBroadcast,
  serializeBroadcastRecipient,
} from "@/lib/broadcasts/serialize";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getCurrentDbAccount();
    const { id } = await context.params;

    const [broadcast] = await db
      .select()
      .from(broadcasts)
      .where(and(eq(broadcasts.accountId, ctx.accountId), eq(broadcasts.id, id)))
      .limit(1);

    if (!broadcast) {
      return NextResponse.json({ error: "Broadcast not found." }, { status: 404 });
    }

    const recipients = await db
      .select({ recipient: broadcastRecipients, contact: contacts })
      .from(broadcastRecipients)
      .leftJoin(contacts, eq(contacts.id, broadcastRecipients.contactId))
      .where(eq(broadcastRecipients.broadcastId, id))
      .orderBy(desc(broadcastRecipients.createdAt));

    return NextResponse.json({
      broadcast: serializeBroadcast(broadcast),
      recipients: recipients.map((row) =>
        serializeBroadcastRecipient(row.recipient, row.contact),
      ),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
