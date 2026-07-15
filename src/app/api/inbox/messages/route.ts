import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";

function asStringArray(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole("agent");
    const body = await request.json().catch(() => ({}));
    const action = body?.action;
    const messageIds = asStringArray(body?.message_ids ?? body?.message_id);

    if (action !== "delete") {
      return NextResponse.json({ error: "Invalid action." }, { status: 400 });
    }
    if (messageIds.length === 0) {
      return NextResponse.json({ error: "message_ids is required." }, { status: 400 });
    }

    const db = supabaseAdmin();
    const { data: targetMessages, error: targetError } = await db
      .from("messages")
      .select("id, conversation_id, message_id, conversations!inner(account_id)")
      .in("id", messageIds)
      .eq("conversations.account_id", ctx.accountId);

    if (targetError) throw targetError;
    const validIds = ((targetMessages ?? []) as { id: string; conversation_id: string }[]).map(
      (message) => message.id,
    );

    if (validIds.length === 0) {
      return NextResponse.json({ error: "Message not found." }, { status: 404 });
    }

    const deletedAt = new Date().toISOString();
    const { data: updatedRows, error: updateError } = await db
      .from("messages")
      .update({
        deleted_at: deletedAt,
        deleted_by_user_id: ctx.userId,
      })
      .in("id", validIds)
      .select("*");

    if (updateError) throw updateError;

    const conversationIds = Array.from(
      new Set(
        ((updatedRows ?? []) as { conversation_id: string }[]).map(
          (message) => message.conversation_id,
        ),
      ),
    );

    await Promise.all(
      conversationIds.map(async (conversationId) => {
        const { data: latest } = await db
          .from("messages")
          .select("content_text, content_type, created_at")
          .eq("conversation_id", conversationId)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!latest) return;
        await db
          .from("conversations")
          .update({
            last_message_text: latest.content_text || `[${latest.content_type}]`,
            last_message_at: latest.created_at,
            updated_at: new Date().toISOString(),
          })
          .eq("id", conversationId)
          .eq("account_id", ctx.accountId);
      }),
    );

    return NextResponse.json({ messages: updatedRows ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
