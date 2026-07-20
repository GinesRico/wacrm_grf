import { and, desc, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { contacts, conversations, messages, whatsappConfig } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from "@/lib/whatsapp/send-message";

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentDbAccount();
    const limit = checkRateLimit(`send:${ctx.userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json();
    const {
      conversation_id: conversationIdInput,
      contact_id,
      message_type,
      content_text,
      media_url,
      filename,
      template_name,
      template_language,
      template_params,
      template_message_params,
      interactive_payload,
      reply_to_message_id,
      is_forwarded,
      forwarded_from_message_id,
      whatsapp_config_id,
    } = body;

    if ((!conversationIdInput && !contact_id) || !message_type) {
      return NextResponse.json(
        { error: "Either conversation_id or contact_id, plus message_type, are required" },
        { status: 400 },
      );
    }

    try {
      validateSendMessageParams({
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        templateName: template_name,
        interactivePayload: interactive_payload,
      });
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }

    let conversationId: string | null = null;
    if (conversationIdInput) {
      const [conversation] = await db
        .select({ id: conversations.id, status: conversations.status })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, conversationIdInput),
            eq(conversations.accountId, ctx.accountId),
          ),
        )
        .limit(1);
      if (!conversation) {
        return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
      }
      if (conversation.status && conversation.status !== "open") {
        return NextResponse.json(
          { error: "Accept or reopen this conversation before sending messages." },
          { status: 409 },
        );
      }
      conversationId = conversation.id;
    } else {
      const [contact] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, contact_id), eq(contacts.accountId, ctx.accountId)))
        .limit(1);
      if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

      const resolved = await findOrCreateConversation(
        ctx.accountId,
        ctx.userId,
        contact_id,
        typeof whatsapp_config_id === "string" ? whatsapp_config_id : null,
      );
      if (resolved === "not_open") {
        return NextResponse.json(
          { error: "Accept or reopen this conversation before sending messages." },
          { status: 409 },
        );
      }
      if (!resolved) {
        return NextResponse.json(
          { error: "Failed to open a conversation for this contact" },
          { status: 500 },
        );
      }
      conversationId = resolved;
    }

    if (message_type !== "template") {
      const sessionOpen = await isConversationWithinCustomerSession(conversationId);
      if (!sessionOpen) {
        return NextResponse.json(
          { error: "The 24-hour WhatsApp session has expired. Send an approved template to re-engage this contact." },
          { status: 409 },
        );
      }
    }

    try {
      const result = await sendMessageToConversation(null, ctx.accountId, {
        conversationId,
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        filename,
        templateName: template_name,
        templateLanguage: template_language,
        templateParams: template_params,
        templateMessageParams: template_message_params,
        interactivePayload: interactive_payload,
        replyToMessageId: reply_to_message_id,
        isForwarded: Boolean(is_forwarded),
        forwardedFromMessageId:
          typeof forwarded_from_message_id === "string" ? forwarded_from_message_id : null,
      });

      return NextResponse.json({
        success: true,
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
      });
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  } catch (error) {
    console.error("Error in WhatsApp send POST:", error);
    return NextResponse.json({ error: "Failed to send message" }, { status: 500 });
  }
}

async function findOrCreateConversation(
  accountId: string,
  userId: string,
  contactId: string,
  whatsappConfigId: string | null,
): Promise<string | "not_open" | null> {
  let resolvedConfigId = whatsappConfigId;
  if (resolvedConfigId) {
    const [line] = await db
      .select({ id: whatsappConfig.id })
      .from(whatsappConfig)
      .where(and(eq(whatsappConfig.id, resolvedConfigId), eq(whatsappConfig.accountId, accountId)))
      .limit(1);
    if (!line) return null;
  } else {
    const [line] = await db
      .select({ id: whatsappConfig.id })
      .from(whatsappConfig)
      .where(eq(whatsappConfig.accountId, accountId))
      .orderBy(desc(whatsappConfig.isDefault), whatsappConfig.createdAt)
      .limit(1);
    resolvedConfigId = line?.id ?? null;
  }

  const where = resolvedConfigId
    ? and(
        eq(conversations.accountId, accountId),
        eq(conversations.contactId, contactId),
        eq(conversations.whatsappConfigId, resolvedConfigId),
      )
    : and(
        eq(conversations.accountId, accountId),
        eq(conversations.contactId, contactId),
        isNull(conversations.whatsappConfigId),
      );

  const [existing] = await db
    .select({ id: conversations.id, status: conversations.status })
    .from(conversations)
    .where(where)
    .limit(1);
  if (existing) {
    if (existing.status && existing.status !== "open") return "not_open";
    return existing.id;
  }

  const [created] = await db
    .insert(conversations)
    .values({
      accountId,
      userId,
      contactId,
      whatsappConfigId: resolvedConfigId,
      status: "open",
      assignedAgentId: userId,
    })
    .returning({ id: conversations.id });

  return created?.id ?? null;
}

async function isConversationWithinCustomerSession(conversationId: string): Promise<boolean> {
  const [lastCustomerMessage] = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.senderType, "customer")))
    .orderBy(desc(messages.createdAt))
    .limit(1);

  if (!lastCustomerMessage) return false;
  return Date.now() - lastCustomerMessage.createdAt.getTime() < 24 * 60 * 60 * 1000;
}
