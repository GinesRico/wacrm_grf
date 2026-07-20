import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { conversations } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";

function serializeConversation(row: typeof conversations.$inferSelect) {
  return {
    id: row.id,
    account_id: row.accountId,
    contact_id: row.contactId,
    whatsapp_config_id: row.whatsappConfigId,
    department_id: row.departmentId,
    assigned_agent_id: row.assignedAgentId,
    status: row.status,
    last_message_text: row.lastMessageText,
    last_message_at: row.lastMessageAt?.toISOString() ?? null,
    unread_count: row.unreadCount,
    ai_autoreply_disabled: row.aiAutoreplyDisabled,
    ai_reply_count: row.aiReplyCount,
    ai_handoff_summary: row.aiHandoffSummary,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentDbAccount();
    const url = new URL(request.url);
    const contactId = url.searchParams.get("contact_id");
    if (!contactId) {
      return NextResponse.json({ error: "contact_id is required." }, { status: 400 });
    }

    const [conversation] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.accountId, ctx.accountId),
          eq(conversations.contactId, contactId),
        ),
      )
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1);

    return NextResponse.json({
      conversation: conversation ? serializeConversation(conversation) : null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
