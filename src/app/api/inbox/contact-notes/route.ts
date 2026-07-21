import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { contactNotes, contacts } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { serializeNote } from "@/lib/contacts/serialize";
import { publishRealtimeEvent } from "@/lib/realtime/soketi-server";

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole("agent");
    const body = await request.json().catch(() => ({}));
    const contactId = typeof body?.contact_id === "string" ? body.contact_id : "";
    const noteText = typeof body?.note_text === "string" ? body.note_text.trim() : "";

    if (!contactId || !noteText) {
      return NextResponse.json(
        { error: "contact_id and note_text are required." },
        { status: 400 },
      );
    }

    const [contact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId)))
      .limit(1);

    if (!contact) {
      return NextResponse.json({ error: "Contact not found." }, { status: 404 });
    }

    const [note] = await db
      .insert(contactNotes)
      .values({
        contactId,
        accountId: ctx.accountId,
        userId: ctx.userId,
        noteText,
      })
      .returning();

    const serialized = serializeNote(note);
    await publishRealtimeEvent("contact_note.created", {
      accountId: ctx.accountId,
      payload: { note: serialized },
    }).catch((error) => {
      console.warn("[realtime] failed to publish contact_note.created:", error);
    });

    return NextResponse.json({
      note: serialized,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
