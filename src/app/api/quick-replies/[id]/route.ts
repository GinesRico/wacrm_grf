import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { quickReplies } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { validateInteractivePayload } from "@/lib/whatsapp/interactive";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireDbRole("admin");
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

    const update: Partial<typeof quickReplies.$inferInsert> = { updatedAt: new Date() };
    if (typeof body.title === "string") {
      const title = body.title.trim();
      if (!title) return NextResponse.json({ error: "title cannot be empty" }, { status: 400 });
      update.title = title;
    }

    if ("kind" in body) {
      if (body.kind !== "text" && body.kind !== "interactive") {
        return NextResponse.json({ error: 'kind must be "text" or "interactive"' }, { status: 400 });
      }
      update.kind = body.kind;
      if (body.kind === "interactive") {
        const result = validateInteractivePayload(body.interactive_payload);
        if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
        update.interactivePayload = body.interactive_payload;
        update.contentText = null;
      } else {
        const text = typeof body.content_text === "string" ? body.content_text : "";
        if (!text.trim()) {
          return NextResponse.json(
            { error: "content_text is required for text quick replies" },
            { status: 400 },
          );
        }
        update.contentText = text;
        update.interactivePayload = null;
      }
    } else {
      if ("content_text" in body) update.contentText = body.content_text ?? null;
      if ("interactive_payload" in body) {
        if (body.interactive_payload != null) {
          const result = validateInteractivePayload(body.interactive_payload);
          if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
        }
        update.interactivePayload = body.interactive_payload ?? null;
      }
    }

    if (Object.keys(update).length === 1) return NextResponse.json({ ok: true });

    await db
      .update(quickReplies)
      .set(update)
      .where(and(eq(quickReplies.id, id), eq(quickReplies.accountId, ctx.accountId)));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireDbRole("admin");
    const { id } = await params;
    await db
      .delete(quickReplies)
      .where(and(eq(quickReplies.id, id), eq(quickReplies.accountId, ctx.accountId)));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
