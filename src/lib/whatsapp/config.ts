import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { conversations, whatsappConfig } from '@/db/schema';

export interface WhatsAppLineConfig {
  id: string;
  account_id: string;
  user_id: string;
  label: string | null;
  phone_number_id: string;
  waba_id: string | null;
  access_token: string;
  verify_token: string | null;
  status: 'connected' | 'disconnected';
  connected_at: string | null;
  registered_at: string | null;
  subscribed_apps_at: string | null;
  last_registration_error: string | null;
  is_default: boolean;
}

export async function getDefaultWhatsAppConfig(
  _unusedClient: unknown,
  accountId: string,
): Promise<WhatsAppLineConfig | null> {
  const [config] = await db
    .select()
    .from(whatsappConfig)
    .where(eq(whatsappConfig.accountId, accountId))
    .orderBy(
      desc(sql`${whatsappConfig.status} = 'connected'`),
      desc(whatsappConfig.isDefault),
      asc(whatsappConfig.createdAt),
    )
    .limit(1);

  return config ? serializeConfig(config) : null;
}

export async function getWhatsAppConfigById(
  _unusedClient: unknown,
  accountId: string,
  configId: string,
): Promise<WhatsAppLineConfig | null> {
  const [config] = await db
    .select()
    .from(whatsappConfig)
    .where(and(eq(whatsappConfig.accountId, accountId), eq(whatsappConfig.id, configId)))
    .limit(1);

  return config ? serializeConfig(config) : null;
}

export async function getWhatsAppConfigForConversation(
  client: unknown,
  accountId: string,
  conversationId: string,
): Promise<WhatsAppLineConfig | null> {
  const [conversation] = await db
    .select({ whatsappConfigId: conversations.whatsappConfigId })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)))
    .limit(1);

  const configId = conversation?.whatsappConfigId;
  if (configId) {
    const config = await getWhatsAppConfigById(client, accountId, configId);
    if (config?.status === 'connected') return config;
  }

  return getDefaultWhatsAppConfig(client, accountId);
}

function serializeConfig(config: typeof whatsappConfig.$inferSelect): WhatsAppLineConfig {
  return {
    id: config.id,
    account_id: config.accountId,
    user_id: config.userId,
    label: config.label,
    phone_number_id: config.phoneNumberId,
    waba_id: config.wabaId,
    access_token: config.accessToken,
    verify_token: config.verifyToken,
    status: config.status as WhatsAppLineConfig['status'],
    connected_at: config.connectedAt?.toISOString() ?? null,
    registered_at: config.registeredAt?.toISOString() ?? null,
    subscribed_apps_at: config.subscribedAppsAt?.toISOString() ?? null,
    last_registration_error: config.lastRegistrationError,
    is_default: config.isDefault,
  };
}
