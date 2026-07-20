import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { quickReplies } from "@/db/schema";
import { getCurrentDbAccount, requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { validateInteractivePayload } from "@/lib/whatsapp/interactive";

function serializeQuickReply(row: typeof quickReplies.$inferSelect) {
  return {
    id: row.id,
    account_id: row.accountId,
    user_id: row.userId,
    title: row.title,
    kind: row.kind,
    content_text: row.contentText,
    interactive_payload: row.interactivePayload,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function GET() {
  try {
    const ctx = await getCurrentDbAccount();
    const rows = await db
      .select()
      .from(quickReplies)
      .where(eq(quickReplies.accountId, ctx.accountId))
      .orderBy(desc(quickReplies.createdAt));
    return NextResponse.json({ quick_replies: rows.map(serializeQuickReply) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole("admin");
    const body = await request.json().catch(() => null);
    if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

    const title = typeof body.title === "string" ? body.title.trim() : "";
    const kind = body.kind === "interactive" ? "interactive" : "text";
    if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });

    let contentText: string | null = null;
    let interactivePayload: unknown = null;

    if (kind === "interactive") {
      const result = validateInteractivePayload(body.interactive_payload);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
      interactivePayload = body.interactive_payload;
    } else {
      const text = typeof body.content_text === "string" ? body.content_text : "";
      if (!text.trim()) {
        return NextResponse.json(
          { error: "content_text is required for text quick replies" },
          { status: 400 },
        );
      }
      contentText = text;
    }

    const [row] = await db
      .insert(quickReplies)
      .values({
        accountId: ctx.accountId,
        userId: ctx.userId,
        title,
        kind,
        contentText,
        interactivePayload,
      })
      .returning();

    return NextResponse.json({ quick_reply: serializeQuickReply(row) }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
