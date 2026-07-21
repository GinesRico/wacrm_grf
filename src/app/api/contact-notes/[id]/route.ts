import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { contactNotes } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { publishRealtimeEvent } from "@/lib/realtime/soketi-server";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireDbRole("agent");
    const { id } = await context.params;
    const deleted = await db
      .delete(contactNotes)
      .where(and(eq(contactNotes.id, id), eq(contactNotes.accountId, ctx.accountId)))
      .returning({ id: contactNotes.id, contactId: contactNotes.contactId });

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Note not found." }, { status: 404 });
    }

    await publishRealtimeEvent("contact_note.deleted", {
      accountId: ctx.accountId,
      payload: {
        note: {
          id: deleted[0].id,
          contact_id: deleted[0].contactId,
        },
      },
    }).catch((error) => {
      console.warn("[realtime] failed to publish contact_note.deleted:", error);
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
