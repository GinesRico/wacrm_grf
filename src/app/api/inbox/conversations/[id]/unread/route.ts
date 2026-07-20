import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { conversations } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";

export async function PATCH(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireDbRole("viewer");
    const { id } = await context.params;
    const updated = await db
      .update(conversations)
      .set({ unreadCount: 0, updatedAt: new Date() })
      .where(and(eq(conversations.id, id), eq(conversations.accountId, ctx.accountId)))
      .returning({ id: conversations.id });

    if (updated.length === 0) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
