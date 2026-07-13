import type { SupabaseClient } from '@supabase/supabase-js';

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
  db: SupabaseClient,
  accountId: string,
): Promise<WhatsAppLineConfig | null> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return (data as WhatsAppLineConfig | null) ?? null;
}

export async function getWhatsAppConfigById(
  db: SupabaseClient,
  accountId: string,
  configId: string,
): Promise<WhatsAppLineConfig | null> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', configId)
    .maybeSingle();

  if (error) throw error;
  return (data as WhatsAppLineConfig | null) ?? null;
}

export async function getWhatsAppConfigForConversation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<WhatsAppLineConfig | null> {
  const { data: conversation, error } = await db
    .from('conversations')
    .select('whatsapp_config_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) throw error;
  const configId = conversation?.whatsapp_config_id as string | null | undefined;
  if (configId) {
    const config = await getWhatsAppConfigById(db, accountId, configId);
    if (config) return config;
  }

  return getDefaultWhatsAppConfig(db, accountId);
}
