import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { contactNotes } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";

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
      .returning({ id: contactNotes.id });

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Note not found." }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
