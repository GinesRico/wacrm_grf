import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/db/client";
import { contacts, conversations, crmAccounts, whatsappConfig } from "@/db/schema";
import { getDefaultWhatsAppConfig, getWhatsAppConfigById } from "@/lib/whatsapp/config";
import { isValidE164, sanitizePhoneForMeta } from "@/lib/whatsapp/phone-utils";
import { SendMessageError } from "@/lib/whatsapp/send-message";

export interface ResolvedConversation {
  conversationId: string;
  contactId: string;
  whatsappConfigId: string;
  contactCreated: boolean;
}

export async function resolveConversationByPhone(
  _unusedClient: unknown,
  accountId: string,
  phone: string,
  name?: string | null,
  whatsappConfigId?: string | null,
): Promise<ResolvedConversation> {
  const sanitized = sanitizePhoneForMeta(phone);
  if (!isValidE164(sanitized)) {
    throw new SendMessageError(
      "bad_request",
      "'to' must be a valid phone number in E.164 format (e.g. +14155550123)",
      400,
    );
  }

  const config = whatsappConfigId
    ? await getWhatsAppConfigById(null, accountId, whatsappConfigId)
    : await getDefaultWhatsAppConfig(null, accountId);
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

  const ownerUserId = await resolveAuditUserId(accountId);

  const [existing] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.accountId, accountId), eq(contacts.phone, sanitized)))
    .limit(1);

  let contactId: string;
  let contactCreated = false;
  if (existing) {
    contactId = existing.id;
    if (name && name !== existing.name) {
      await db.update(contacts).set({ name, updatedAt: new Date() }).where(eq(contacts.id, existing.id));
    }
  } else {
    const [created] = await db
      .insert(contacts)
      .values({
        accountId,
        userId: ownerUserId,
        phone: sanitized,
        phoneNormalized: sanitized.replace(/\D/g, ""),
        name: name || sanitized,
      })
      .onConflictDoUpdate({
        target: [contacts.accountId, contacts.phoneNormalized],
        set: { updatedAt: new Date() },
      })
      .returning({ id: contacts.id });
    contactId = created.id;
    contactCreated = true;
  }

  const conversationWhere = config.id
    ? and(
        eq(conversations.accountId, accountId),
        eq(conversations.contactId, contactId),
        eq(conversations.whatsappConfigId, config.id),
      )
    : and(
        eq(conversations.accountId, accountId),
        eq(conversations.contactId, contactId),
        isNull(conversations.whatsappConfigId),
      );

  const [existingConversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(conversationWhere)
    .limit(1);

  if (existingConversation) {
    return {
      conversationId: existingConversation.id,
      contactId,
      whatsappConfigId: config.id,
      contactCreated,
    };
  }

  const [createdConversation] = await db
    .insert(conversations)
    .values({
      accountId,
      userId: ownerUserId,
      contactId,
      whatsappConfigId: config.id,
      status: "open",
    })
    .returning({ id: conversations.id });

  return {
    conversationId: createdConversation.id,
    contactId,
    whatsappConfigId: config.id,
    contactCreated,
  };
}

async function resolveAuditUserId(accountId: string): Promise<string> {
  const [config] = await db
    .select({ userId: whatsappConfig.userId })
    .from(whatsappConfig)
    .where(eq(whatsappConfig.accountId, accountId))
    .limit(1);
  if (config?.userId) return config.userId;

  const [account] = await db
    .select({ ownerUserId: crmAccounts.ownerUserId })
    .from(crmAccounts)
    .where(eq(crmAccounts.id, accountId))
    .limit(1);
  if (!account?.ownerUserId) {
    throw new SendMessageError("db_error", "Account owner could not be resolved", 500);
  }
  return account.ownerUserId;
}
