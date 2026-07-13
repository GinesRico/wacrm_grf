import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle();
    const accountId = profile?.account_id as string | undefined;

    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      );
    }

    const body = (await request.json().catch(() => null)) as {
      contact_id?: unknown;
      phone?: unknown;
      name?: unknown;
      whatsapp_config_id?: unknown;
    } | null;

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Request body must be a JSON object' },
        { status: 400 },
      );
    }

    const whatsappConfigId =
      typeof body.whatsapp_config_id === 'string'
        ? body.whatsapp_config_id.trim()
        : '';

    if (!whatsappConfigId) {
      return NextResponse.json(
        { error: 'Choose a WhatsApp line.' },
        { status: 400 },
      );
    }

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('id, department_id')
      .eq('id', whatsappConfigId)
      .eq('account_id', accountId)
      .maybeSingle();

    if (!config) {
      return NextResponse.json(
        { error: 'Selected WhatsApp line was not found.' },
        { status: 404 },
      );
    }

    const contactId = await resolveContactId({
      supabase,
      accountId,
      userId: user.id,
      contactId:
        typeof body.contact_id === 'string' ? body.contact_id.trim() : '',
      phone: typeof body.phone === 'string' ? body.phone.trim() : '',
      name: typeof body.name === 'string' ? body.name.trim() : '',
    });

    if (!contactId) {
      return NextResponse.json(
        { error: 'Choose a contact or enter a valid phone number.' },
        { status: 400 },
      );
    }

    const conversationId = await findOrCreateConversation(
      supabase,
      accountId,
      user.id,
      contactId,
      whatsappConfigId,
      (config.department_id as string | null) ?? null,
    );

    if (!conversationId) {
      return NextResponse.json(
        { error: 'Failed to open conversation.' },
        { status: 500 },
      );
    }

    return NextResponse.json({ conversation_id: conversationId });
  } catch (error) {
    console.error('[inbox/start-conversation] error:', error);
    return NextResponse.json(
      { error: 'Failed to open conversation.' },
      { status: 500 },
    );
  }
}

type InboxSupabase = Awaited<ReturnType<typeof createClient>>;

async function resolveContactId({
  supabase,
  accountId,
  userId,
  contactId,
  phone,
  name,
}: {
  supabase: InboxSupabase;
  accountId: string;
  userId: string;
  contactId: string;
  phone: string;
  name: string;
}): Promise<string | null> {
  if (contactId) {
    const { data } = await supabase
      .from('contacts')
      .select('id')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle();
    return data?.id ?? null;
  }

  const sanitized = sanitizePhoneForMeta(phone);
  if (!isValidE164(sanitized)) return null;

  const existing = await findExistingContact(supabase, accountId, sanitized);
  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: userId,
      phone: sanitized,
      name: name || sanitized,
    })
    .select('id')
    .single();

  if (created?.id) return created.id;

  if (isUniqueViolation(error)) {
    const raced = await findExistingContact(supabase, accountId, sanitized);
    return raced?.id ?? null;
  }

  if (error) {
    console.error('[inbox/start-conversation] contact create error:', error);
  }
  return null;
}

async function findOrCreateConversation(
  supabase: InboxSupabase,
  accountId: string,
  userId: string,
  contactId: string,
  whatsappConfigId: string,
  departmentId: string | null,
): Promise<string | null> {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id, status')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('whatsapp_config_id', whatsappConfigId)
    .maybeSingle();

  if (existing?.id) {
    if (existing.status === 'open') return existing.id;

    const { data: updated, error: updateError } = await supabase
      .from('conversations')
      .update({
        status: 'open',
        assigned_agent_id: userId,
        department_id: departmentId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select('id')
      .single();

    if (updateError) {
      console.error('[inbox/start-conversation] conversation reopen error:', updateError);
      return null;
    }

    return updated?.id ?? null;
  }

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
      whatsapp_config_id: whatsappConfigId,
      department_id: departmentId,
      status: 'open',
      assigned_agent_id: userId,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[inbox/start-conversation] conversation create error:', error);
    return null;
  }

  return created?.id ?? null;
}
