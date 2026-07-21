import { NextResponse } from "next/server";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { conversations, messageReactions, messages } from "@/db/schema";
import { getCurrentDbAccount, requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { getInboxConversationById } from "@/lib/inbox/conversations";
import { publishRealtimeEvent } from "@/lib/realtime/soketi-server";

function asStringArray(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function toMessageRow(row: typeof messages.$inferSelect) {
  return {
    id: row.id,
    conversation_id: row.conversationId,
    sender_type: row.senderType,
    sender_id: row.senderId,
    content_type: row.contentType,
    content_text: row.contentText,
    media_url: row.mediaUrl,
    template_name: row.templateName,
    message_id: row.messageId,
    status: row.status,
    reply_to_message_id: row.replyToMessageId,
    interactive_reply_id: row.interactiveReplyId,
    interactive_payload: row.interactivePayload,
    is_forwarded: row.isForwarded,
    forwarded_from_message_id: row.forwardedFromMessageId,
    deleted_at: row.deletedAt?.toISOString() ?? null,
    deleted_by_user_id: row.deletedByUserId,
    is_starred: row.isStarred,
    ai_generated: row.aiGenerated,
    created_at: row.createdAt.toISOString(),
  };
}

function toReactionRow(row: typeof messageReactions.$inferSelect) {
  return {
    id: row.id,
    message_id: row.messageId,
    conversation_id: row.conversationId,
    actor_type: row.actorType,
    actor_id: row.actorId,
    emoji: row.emoji,
    created_at: row.createdAt.toISOString(),
  };
}

async function assertConversationAccess(accountId: string, conversationId: string) {
  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)))
    .limit(1);
  return Boolean(conversation);
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentDbAccount();
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversation_id");

    if (!conversationId) {
      return NextResponse.json({ error: "conversation_id is required." }, { status: 400 });
    }

    const allowed = await assertConversationAccess(ctx.accountId, conversationId);
    if (!allowed) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }

    const [messageRows, reactionRows] = await Promise.all([
      db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.createdAt)),
      db
        .select()
        .from(messageReactions)
        .where(eq(messageReactions.conversationId, conversationId)),
    ]);

    return NextResponse.json({
      messages: messageRows.map(toMessageRow),
      reactions: reactionRows.map(toReactionRow),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireDbRole("agent");
    const body = await request.json().catch(() => ({}));
    const action = body?.action;
    const messageIds = asStringArray(body?.message_ids ?? body?.message_id);

    if (action !== "delete" && action !== "star") {
      return NextResponse.json({ error: "Invalid action." }, { status: 400 });
    }
    if (messageIds.length === 0) {
      return NextResponse.json({ error: "message_ids is required." }, { status: 400 });
    }

    const targetMessages = await db
      .select({
        id: messages.id,
        conversation_id: messages.conversationId,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          inArray(messages.id, messageIds),
          eq(conversations.accountId, ctx.accountId),
        ),
      );

    const validIds = targetMessages.map(
      (message) => message.id,
    );

    if (validIds.length === 0) {
      return NextResponse.json({ error: "Message not found." }, { status: 404 });
    }

    if (action === "star") {
      const starred = Boolean(body?.is_starred);
      const updatedRows = await db
        .update(messages)
        .set({ isStarred: starred })
        .where(inArray(messages.id, validIds))
        .returning();

      await Promise.all(
        updatedRows.map((message) =>
          publishRealtimeEvent("message.updated", {
            accountId: ctx.accountId,
            conversationId: message.conversationId,
            payload: { message: toMessageRow(message) },
          }).catch((error) => {
            console.warn("[realtime] failed to publish message.updated:", error);
          }),
        ),
      );

      return NextResponse.json({ messages: updatedRows.map(toMessageRow) });
    }

    const deletedAt = new Date();
    const updatedRows = await db
      .update(messages)
      .set({
        deletedAt,
        deletedByUserId: ctx.userId,
      })
      .where(inArray(messages.id, validIds))
      .returning();

    const conversationIds = Array.from(
      new Set(
        updatedRows.map(
          (message) => message.conversationId,
        ),
      ),
    );

    await Promise.all(
      conversationIds.map(async (conversationId) => {
        const [latest] = await db
          .select({
            contentText: messages.contentText,
            contentType: messages.contentType,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversationId),
              isNull(messages.deletedAt),
            ),
          )
          .orderBy(sql`${messages.createdAt} desc`)
          .limit(1);

        if (!latest) return;
        await db
          .update(conversations)
          .set({
            lastMessageText: latest.contentText || `[${latest.contentType}]`,
            lastMessageAt: latest.createdAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.accountId, ctx.accountId),
            ),
          );

        const conversation = await getInboxConversationById(ctx.accountId, conversationId);
        if (conversation) {
          await publishRealtimeEvent("conversation.updated", {
            accountId: ctx.accountId,
            conversationId,
            payload: { conversation },
          }).catch((error) => {
            console.warn("[realtime] failed to publish conversation.updated:", error);
          });
        }
      }),
    );

    await Promise.all(
      updatedRows.map((message) =>
        publishRealtimeEvent("message.updated", {
          accountId: ctx.accountId,
          conversationId: message.conversationId,
          payload: { message: toMessageRow(message) },
        }).catch((error) => {
          console.warn("[realtime] failed to publish message.updated:", error);
        }),
      ),
    );

    return NextResponse.json({ messages: updatedRows.map(toMessageRow) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
