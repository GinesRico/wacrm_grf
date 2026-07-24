import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  contacts,
  conversations,
  messageTemplates,
  messages,
} from "@/db/schema";
import type { MessageTemplate } from "@/types";
import { decrypt, encrypt, isLegacyFormat } from "@/lib/whatsapp/encryption";
import {
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
  validateInteractivePayload,
} from "@/lib/whatsapp/interactive";
import {
  sendInteractiveButtons,
  sendInteractiveCtaUrl,
  sendInteractiveList,
  sendMediaMessage,
  sendTemplateMessage,
  sendTextMessage,
  type MediaKind,
} from "@/lib/whatsapp/meta-api";
import {
  isRecipientNotAllowedError,
  isValidE164,
  phoneVariants,
  sanitizePhoneForMeta,
} from "@/lib/whatsapp/phone-utils";
import { getWhatsAppConfigForConversation } from "@/lib/whatsapp/config";
import type { SendTimeParams } from "@/lib/whatsapp/template-send-builder";
import { getInboxConversationById } from "@/lib/inbox/conversations";
import { publishRealtimeEvent } from "@/lib/realtime/soketi-server";

export const MEDIA_KINDS = ["image", "video", "document", "audio"] as const;
export const VALID_MESSAGE_TYPES = [
  "text",
  "template",
  "interactive",
  ...MEDIA_KINDS,
] as const;

export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "SendMessageError";
    this.code = code;
    this.status = status;
  }
}

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  templateParams?: string[];
  templateMessageParams?: unknown;
  interactivePayload?: InteractiveMessagePayload | null;
  replyToMessageId?: string | null;
  isForwarded?: boolean;
  forwardedFromMessageId?: string | null;
}

export interface SendMessageResult {
  messageId: string;
  whatsappMessageId: string;
}

function serializeMessage(row: typeof messages.$inferSelect) {
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

export function validateSendMessageParams(params: {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  templateName?: string | null;
  interactivePayload?: InteractiveMessagePayload | null;
}): void {
  const { messageType, contentText, mediaUrl, templateName, interactivePayload } = params;
  if (!messageType) throw new SendMessageError("bad_request", "message_type is required", 400);

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);
  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new SendMessageError("bad_request", `Unsupported message_type "${messageType}"`, 400);
  }
  if (messageType === "text" && !contentText) {
    throw new SendMessageError("bad_request", "content_text is required for text messages", 400);
  }
  if (messageType === "template" && !templateName) {
    throw new SendMessageError("bad_request", "template_name is required for template messages", 400);
  }
  if (messageType === "interactive") {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) throw new SendMessageError("bad_request", result.error, 400);
  }
  if (isMediaKind && !mediaUrl) {
    throw new SendMessageError("bad_request", `media_url is required for ${messageType} messages`, 400);
  }
  if (
    isMediaKind &&
    messageType !== "audio" &&
    typeof contentText === "string" &&
    contentText.length > 1024
  ) {
    throw new SendMessageError("bad_request", "Caption exceeds the 1024-character limit", 400);
  }
}

function serializeTemplate(row: typeof messageTemplates.$inferSelect): MessageTemplate {
  return {
    id: row.id,
    user_id: row.userId,
    name: row.name,
    category: row.category as MessageTemplate["category"],
    language: row.language ?? "en_US",
    header_type: row.headerType as MessageTemplate["header_type"],
    header_content: row.headerContent ?? undefined,
    header_handle: row.headerHandle ?? undefined,
    header_media_url: row.headerMediaUrl ?? undefined,
    body_text: row.bodyText,
    footer_text: row.footerText ?? undefined,
    buttons: row.buttons as MessageTemplate["buttons"],
    sample_values: row.sampleValues as MessageTemplate["sample_values"],
    status: row.status as MessageTemplate["status"],
    meta_template_id: row.metaTemplateId ?? undefined,
    rejection_reason: row.rejectionReason ?? undefined,
    quality_score: row.qualityScore as MessageTemplate["quality_score"],
    submission_error: row.submissionError ?? undefined,
    last_submitted_at: row.lastSubmittedAt?.toISOString(),
    created_at: row.createdAt.toISOString(),
  };
}

function parseTemplateMessageParams(value: unknown): SendTimeParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const params = value as Record<string, unknown>;
  const buttonParams =
    params.buttonParams && typeof params.buttonParams === "object"
      ? Object.fromEntries(
          Object.entries(params.buttonParams as Record<string, unknown>)
            .filter(([key, v]) => /^\d+$/.test(key) && typeof v === "string")
            .map(([key, v]) => [Number(key), v as string]),
        )
      : undefined;
  return {
    body: Array.isArray(params.body) ? params.body.map(String) : undefined,
    headerText: typeof params.headerText === "string" ? params.headerText : undefined,
    headerMediaUrl: typeof params.headerMediaUrl === "string" ? params.headerMediaUrl : undefined,
    headerMediaId: typeof params.headerMediaId === "string" ? params.headerMediaId : undefined,
    buttonParams,
  };
}

function renderTemplateBodyPreview(template: MessageTemplate | null, values?: string[]): string | null {
  if (!template || !values) return null;
  return template.body_text.replace(/\{\{(\d+)\}\}/g, (_, rawIndex) => {
    const index = Number(rawIndex) - 1;
    return values[index] ?? "";
  });
}

function templateHeaderMediaUrl(template: MessageTemplate | null, params: SendTimeParams): string | null {
  if (!["image", "video", "document"].includes(template?.header_type ?? "")) return null;
  return params.headerMediaUrl ?? template?.header_media_url ?? null;
}

function templatePreviewPayload(
  template: MessageTemplate | null,
  body: string | null | undefined,
  params: SendTimeParams = {},
): InteractiveMessagePayload | null {
  if (!template?.buttons?.length) return null;
  return {
    kind: "buttons",
    body: body ?? template.body_text ?? "",
    footer: template.footer_text || undefined,
    buttons: template.buttons.map((button, index) => ({
      id: `template-${index}`,
      title: button.text,
      type: button.type,
      url: button.type === "URL" ? button.url : undefined,
      example:
        button.type === "URL"
          ? params.buttonParams?.[index] ?? button.example
          : button.type === "COPY_CODE"
            ? params.buttonParams?.[index] ?? button.example
            : undefined,
      phone_number: button.type === "PHONE_NUMBER" ? button.phone_number : undefined,
    })),
  };
}

export async function sendMessageToConversation(
  _unusedClient: unknown,
  accountId: string,
  params: SendMessageParams,
): Promise<SendMessageResult> {
  const {
    conversationId,
    messageType,
    contentText,
    mediaUrl,
    filename,
    templateName,
    templateLanguage,
    templateParams,
    templateMessageParams,
    interactivePayload,
    replyToMessageId,
  } = params;

  if (!conversationId) {
    throw new SendMessageError("bad_request", "conversation_id is required", 400);
  }

  validateSendMessageParams({
    messageType,
    contentText,
    mediaUrl,
    templateName,
    interactivePayload,
  });

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  const [conversation] = await db
    .select({
      id: conversations.id,
      whatsappConfigId: conversations.whatsappConfigId,
      contactId: conversations.contactId,
      phone: contacts.phone,
    })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)))
    .limit(1);

  if (!conversation) throw new SendMessageError("not_found", "Conversation not found", 404);

  const sanitizedPhone = sanitizePhoneForMeta(conversation.phone);
  if (!isValidE164(sanitizedPhone)) {
    throw new SendMessageError("bad_request", "Invalid phone number format", 400);
  }

  const config = await getWhatsAppConfigForConversation(null, accountId, conversationId);
  if (!config) {
    throw new SendMessageError(
      "whatsapp_not_configured",
      "WhatsApp not configured. Please set up your WhatsApp integration first.",
      400,
    );
  }
  if (config.status !== "connected") {
    throw new SendMessageError(
      "whatsapp_not_connected",
      "The selected WhatsApp line is not connected. Connect it or choose another line.",
      409,
    );
  }

  if (conversation.whatsappConfigId !== config.id) {
    void db
      .update(conversations)
      .set({ whatsappConfigId: config.id, updatedAt: new Date() })
      .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)));
  }

  const accessToken = decrypt(config.access_token);
  if (isLegacyFormat(config.access_token)) {
    void db.execute(
      sql.raw(
        `update whatsapp_config set access_token = '${encrypt(accessToken).replaceAll("'", "''")}' where id = '${config.id.replaceAll("'", "''")}'`,
      ),
    ).catch((error) => {
      console.warn("[send-message] access_token GCM upgrade failed:", error);
    });
  }

  let contextMessageId: string | undefined;
  if (replyToMessageId) {
    const [parent] = await db
      .select({ messageId: messages.messageId })
      .from(messages)
      .where(and(eq(messages.id, replyToMessageId), eq(messages.conversationId, conversationId)))
      .limit(1);
    if (!parent) {
      throw new SendMessageError(
        "bad_request",
        "reply_to_message_id not found in this conversation",
        400,
      );
    }
    if (parent.messageId) contextMessageId = parent.messageId;
  }

  let templateRow: MessageTemplate | null = null;
  if (messageType === "template" && templateName) {
    const [row] = await db
      .select()
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.accountId, accountId),
          eq(messageTemplates.name, templateName),
          eq(messageTemplates.language, templateLanguage || "en_US"),
        ),
      )
      .limit(1);
    templateRow = row ? serializeTemplate(row) : null;
  }

  const attempt = async (phone: string): Promise<string> => {
    if (messageType === "template") {
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: templateName!,
        language: templateLanguage || "en_US",
        template: templateRow ?? undefined,
        messageParams: templateMessageParams ?? undefined,
        params: templateParams || [],
        contextMessageId,
      });
      return result.messageId;
    }
    if (isMediaKind) {
      const result = await sendMediaMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        kind: messageType as MediaKind,
        link: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        contextMessageId,
      });
      return result.messageId;
    }
    if (messageType === "interactive") {
      const payload = interactivePayload!;
      if (payload.kind === "buttons") {
        const result = await sendInteractiveButtons({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          bodyText: payload.body,
          headerText: payload.header || undefined,
          footerText: payload.footer || undefined,
          buttons: payload.buttons,
          contextMessageId,
        });
        return result.messageId;
      }
      if (payload.kind === "list") {
        const result = await sendInteractiveList({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          bodyText: payload.body,
          buttonLabel: payload.button_label,
          headerText: payload.header || undefined,
          footerText: payload.footer || undefined,
          sections: payload.sections,
          contextMessageId,
        });
        return result.messageId;
      }
      const result = await sendInteractiveCtaUrl({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        bodyText: payload.body,
        buttonLabel: payload.button_label,
        url: payload.url,
        headerText: payload.header || undefined,
        footerText: payload.footer || undefined,
        contextMessageId,
      });
      return result.messageId;
    }
    const result = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: contentText!,
      contextMessageId,
    });
    return result.messageId;
  };

  let waMessageId = "";
  let workingPhone = sanitizedPhone;
  try {
    let lastError: unknown = null;
    for (const variant of phoneVariants(sanitizedPhone)) {
      try {
        waMessageId = await attempt(variant);
        workingPhone = variant;
        lastError = null;
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isRecipientNotAllowedError(message)) throw err;
        lastError = err;
        console.warn(`[send-message] variant "${variant}" rejected by Meta, trying next.`);
      }
    }
    if (lastError) throw lastError;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown Meta API error";
    console.error("[send-message] Meta send failed for all variants:", message);
    throw new SendMessageError("meta_error", `Meta API error: ${message}`, 502);
  }

  if (workingPhone !== sanitizedPhone) {
    await db.update(contacts).set({ phone: workingPhone }).where(eq(contacts.id, conversation.contactId));
  }

  const structuredTemplateParams =
    messageType === "template" ? parseTemplateMessageParams(templateMessageParams) : {};
  const renderedTemplateBody =
    messageType === "template"
      ? renderTemplateBodyPreview(templateRow, structuredTemplateParams.body ?? templateParams)
      : null;
  const templateButtonsPayload =
    messageType === "template"
      ? templatePreviewPayload(templateRow, renderedTemplateBody ?? contentText, structuredTemplateParams)
      : null;
  const templateMediaUrl =
    messageType === "template" ? templateHeaderMediaUrl(templateRow, structuredTemplateParams) : null;
  const interactiveBody = messageType === "interactive" ? interactivePayload!.body : null;

  const [messageRecord] = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: "agent",
      contentType: messageType,
      contentText: interactiveBody ?? renderedTemplateBody ?? contentText ?? null,
      mediaUrl: templateMediaUrl || mediaUrl || null,
      templateName: templateName || null,
      interactivePayload: messageType === "interactive" ? interactivePayload : templateButtonsPayload,
      messageId: waMessageId,
      status: "sent",
      replyToMessageId: replyToMessageId || null,
      isForwarded: Boolean(params.isForwarded),
      forwardedFromMessageId: params.forwardedFromMessageId || null,
    })
    .returning();

  const lastMessageText =
    messageType === "interactive"
      ? interactivePayloadPreviewText(interactivePayload!)
      : renderedTemplateBody || contentText || `[${messageType}]`;

  await db
    .update(conversations)
    .set({
      lastMessageText,
      lastMessageAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));

  const updatedConversation = await getInboxConversationById(accountId, conversationId);
  await Promise.all([
    publishRealtimeEvent("message.created", {
      accountId,
      conversationId,
      payload: { message: serializeMessage(messageRecord) },
    }).catch((error) => {
      console.warn("[realtime] failed to publish message.created:", error);
    }),
    updatedConversation
      ? publishRealtimeEvent("conversation.updated", {
          accountId,
          conversationId,
          payload: { conversation: updatedConversation },
        }).catch((error) => {
          console.warn("[realtime] failed to publish conversation.updated:", error);
        })
      : Promise.resolve(),
  ]);

  await db
    .execute(
      sql.raw(
        `update flow_runs set status = 'paused_by_agent', ended_at = now(), end_reason = 'agent_replied' where account_id = '${accountId.replaceAll("'", "''")}' and contact_id = '${conversation.contactId.replaceAll("'", "''")}' and status = 'active'`,
      ),
    )
    .catch((error) => {
      if ((error as { code?: string })?.code !== "42P01") {
        console.error("[flows] pause-on-agent-send failed:", error);
      }
    });

  return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
}
