import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { contacts, conversations, whatsappConfig } from '@/db/schema';
import { getCurrentDbAccount } from '@/lib/auth/current-account';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentDbAccount();

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

    const [config] = await db
      .select({
        id: whatsappConfig.id,
        department_id: whatsappConfig.departmentId,
        status: whatsappConfig.status,
      })
      .from(whatsappConfig)
      .where(
        and(
          eq(whatsappConfig.id, whatsappConfigId),
          eq(whatsappConfig.accountId, ctx.accountId),
        ),
      )
      .limit(1);

    if (!config) {
      return NextResponse.json(
        { error: 'Selected WhatsApp line was not found.' },
        { status: 404 },
      );
    }
    if (config.status !== 'connected') {
      return NextResponse.json(
        { error: 'The selected WhatsApp line is not connected. Connect it or choose another line.' },
        { status: 409 },
      );
    }

    const contactId = await resolveContactId({
      accountId: ctx.accountId,
      userId: ctx.userId,
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
      null,
      ctx.accountId,
      ctx.userId,
      contactId,
      whatsappConfigId,
      config.department_id ?? null,
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

async function resolveContactId({
  accountId,
  userId,
  contactId,
  phone,
  name,
}: {
  accountId: string;
  userId: string;
  contactId: string;
  phone: string;
  name: string;
}): Promise<string | null> {
  if (contactId) {
    const [contact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
      .limit(1);
    return contact?.id ?? null;
  }

  const sanitized = sanitizePhoneForMeta(phone);
  if (!isValidE164(sanitized)) return null;

  const existing = await findExistingContact(null, accountId, sanitized);
  if (existing) return existing.id;

  try {
    const [created] = await db
      .insert(contacts)
      .values({
        accountId,
        userId,
        phone: sanitized,
        phoneNormalized: sanitized.replace(/\D/g, ''),
        name: name || sanitized,
      })
      .returning({ id: contacts.id });
    if (created?.id) return created.id;
  } catch (error) {
    if (!isUniqueViolation(error)) {
      console.error('[inbox/start-conversation] contact create error:', error);
      return null;
    }
    const raced = await findExistingContact(null, accountId, sanitized);
    return raced?.id ?? null;
  }
  return null;
}

async function findOrCreateConversation(
  _unusedClient: unknown,
  accountId: string,
  userId: string,
  contactId: string,
  whatsappConfigId: string,
  departmentId: string | null,
): Promise<string | null> {
  const [existing] = await db
    .select({ id: conversations.id, status: conversations.status })
    .from(conversations)
    .where(
      and(
        eq(conversations.accountId, accountId),
        eq(conversations.contactId, contactId),
        eq(conversations.whatsappConfigId, whatsappConfigId),
      ),
    )
    .limit(1);

  if (existing?.id) {
    if (existing.status === 'open') return existing.id;

    try {
      const [updated] = await db
        .update(conversations)
        .set({
          status: 'open',
          assignedAgentId: userId,
          departmentId,
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, existing.id))
        .returning({ id: conversations.id });
      return updated?.id ?? null;
    } catch (updateError) {
      console.error('[inbox/start-conversation] conversation reopen error:', updateError);
      return null;
    }
  }

  try {
    const [created] = await db
      .insert(conversations)
      .values({
        accountId,
        userId,
        contactId,
        whatsappConfigId,
        departmentId,
        status: 'open',
        assignedAgentId: userId,
      })
      .returning({ id: conversations.id });
    return created?.id ?? null;
  } catch (error) {
    console.error('[inbox/start-conversation] conversation create error:', error);
    return null;
  }
}
