// ============================================================
// Public API (v1) serializers for conversations + messages.
//
// The dashboard's `Conversation`/`Message` rows carry internal columns
// (account_id, user_id, sender_id) that shouldn't leak onto the public
// wire. These serializers project the stable public subset and rename
// the Meta id (`message_id` → `whatsapp_message_id`) to match the send
// endpoint's response vocabulary.
// ============================================================

import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  lt,
  or,
  type SQL,
} from 'drizzle-orm';

import { db } from '@/db/client';
import {
  contactTags,
  contacts,
  conversations,
  messages,
  tags,
} from '@/db/schema';
import type { Cursor } from '@/lib/api/v1/pagination';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import type { Conversation, Message } from '@/types';

export interface ApiConversation {
  id: string;
  contact_id: string;
  status: string;
  assigned_agent_id: string | null;
  last_message_text: string | null;
  last_message_at: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
  contact: {
    id: string;
    phone: string;
    name: string | null;
    email: string | null;
    company: string | null;
    tags: { id: string; name: string; color: string }[];
  } | null;
}

export interface ApiMessage {
  id: string;
  conversation_id: string;
  contact_id: string | null;
  direction: 'inbound' | 'outbound';
  sender_type: string;
  content_type: string;
  content_text: string | null;
  media_url: string | null;
  template_name: string | null;
  whatsapp_message_id: string | null;
  status: string;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  reply_to_message_id: string | null;
  interactive_reply_id: string | null;
  created_at: string;
  contact?: {
    id: string;
    phone: string;
    name: string | null;
    email: string | null;
    company: string | null;
  } | null;
}

/**
 * Project a normalized `Conversation` (from `normalizeConversation`,
 * which has already flattened `contact.tags`) into the public shape.
 */
export function serializeConversation(conv: Conversation): ApiConversation {
  const c = conv.contact;
  return {
    id: conv.id,
    contact_id: conv.contact_id,
    status: conv.status,
    assigned_agent_id: conv.assigned_agent_id ?? null,
    last_message_text: conv.last_message_text ?? null,
    last_message_at: conv.last_message_at ?? null,
    unread_count: conv.unread_count ?? 0,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
    contact: c
      ? {
          id: c.id,
          phone: c.phone,
          name: c.name ?? null,
          email: c.email ?? null,
          company: c.company ?? null,
          tags: (c.tags ?? []).map((t) => ({
            id: t.id,
            name: t.name,
            color: t.color,
          })),
        }
      : null,
  };
}

/** Project a `messages` row into the public shape. */
export function serializeMessage(m: Message): ApiMessage {
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    contact_id: null,
    // `customer` = inbound (from the contact); anything else is outbound.
    direction: m.sender_type === 'customer' ? 'inbound' : 'outbound',
    sender_type: m.sender_type,
    content_type: m.content_type,
    content_text: m.content_text ?? null,
    media_url: m.media_url ?? null,
    template_name: m.template_name ?? null,
    whatsapp_message_id: m.message_id ?? null,
    status: m.status,
    sent_at: m.sent_at ?? null,
    delivered_at: m.delivered_at ?? null,
    read_at: m.read_at ?? null,
    failed_at: m.failed_at ?? null,
    reply_to_message_id: m.reply_to_message_id ?? null,
    interactive_reply_id: m.interactive_reply_id ?? null,
    created_at: m.created_at,
  };
}

function serializeConversationRow(
  conv: typeof conversations.$inferSelect,
  contact: typeof contacts.$inferSelect | null,
  rowTags: { id: string; name: string; color: string }[] = []
): ApiConversation {
  return {
    id: conv.id,
    contact_id: conv.contactId,
    status: conv.status,
    assigned_agent_id: conv.assignedAgentId,
    last_message_text: conv.lastMessageText,
    last_message_at: conv.lastMessageAt?.toISOString() ?? null,
    unread_count: conv.unreadCount,
    created_at: conv.createdAt.toISOString(),
    updated_at: conv.updatedAt.toISOString(),
    contact: contact
      ? {
          id: contact.id,
          phone: contact.phone,
          name: contact.name,
          email: contact.email,
          company: contact.company,
          tags: rowTags,
        }
      : null,
  };
}

export function serializeMessageRow(
  row: typeof messages.$inferSelect
): ApiMessage {
  return {
    id: row.id,
    conversation_id: row.conversationId,
    contact_id: null,
    direction: row.senderType === 'customer' ? 'inbound' : 'outbound',
    sender_type: row.senderType,
    content_type: row.contentType,
    content_text: row.contentText,
    media_url: row.mediaUrl,
    template_name: row.templateName,
    whatsapp_message_id: row.messageId,
    status: row.status,
    sent_at: row.sentAt?.toISOString() ?? null,
    delivered_at: row.deliveredAt?.toISOString() ?? null,
    read_at: row.readAt?.toISOString() ?? null,
    failed_at: row.failedAt?.toISOString() ?? null,
    reply_to_message_id: row.replyToMessageId,
    interactive_reply_id: row.interactiveReplyId,
    created_at: row.createdAt.toISOString(),
  };
}

function serializeMessageJoinedRow(
  message: typeof messages.$inferSelect,
  contact: typeof contacts.$inferSelect | null
): ApiMessage {
  return {
    ...serializeMessageRow(message),
    contact_id: contact?.id ?? null,
    contact: contact
      ? {
          id: contact.id,
          phone: contact.phone,
          name: contact.name,
          email: contact.email,
          company: contact.company,
        }
      : null,
  };
}

async function tagsByContactIds(contactIds: string[]) {
  if (contactIds.length === 0)
    return new Map<string, { id: string; name: string; color: string }[]>();
  const rows = await db
    .select({
      contactId: contactTags.contactId,
      id: tags.id,
      name: tags.name,
      color: tags.color,
    })
    .from(contactTags)
    .innerJoin(tags, eq(contactTags.tagId, tags.id))
    .where(inArray(contactTags.contactId, contactIds))
    .orderBy(asc(tags.name));

  const byContact = new Map<
    string,
    { id: string; name: string; color: string }[]
  >();
  for (const row of rows) {
    const list = byContact.get(row.contactId) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    byContact.set(row.contactId, list);
  }
  return byContact;
}

export async function listConversations(params: {
  accountId: string;
  limit: number;
  cursor: Cursor | null;
  status: string | null;
  contactId: string | null;
}): Promise<Array<ApiConversation & { id: string; created_at: string }>> {
  const whereParts = [eq(conversations.accountId, params.accountId)];
  if (params.status) whereParts.push(eq(conversations.status, params.status));
  if (params.contactId)
    whereParts.push(eq(conversations.contactId, params.contactId));
  if (params.cursor) {
    const cursorDate = new Date(params.cursor.createdAt);
    whereParts.push(
      or(
        lt(conversations.createdAt, cursorDate),
        and(
          eq(conversations.createdAt, cursorDate),
          lt(conversations.id, params.cursor.id)
        )
      )!
    );
  }

  const rows = await db
    .select({ conversation: conversations, contact: contacts })
    .from(conversations)
    .leftJoin(contacts, eq(conversations.contactId, contacts.id))
    .where(and(...whereParts))
    .orderBy(desc(conversations.createdAt), desc(conversations.id))
    .limit(params.limit);

  const tagMap = await tagsByContactIds(
    rows.flatMap((row) => (row.contact ? [row.contact.id] : []))
  );
  return rows.map((row) =>
    serializeConversationRow(
      row.conversation,
      row.contact,
      row.contact ? (tagMap.get(row.contact.id) ?? []) : []
    )
  );
}

export async function getConversationById(
  accountId: string,
  id: string
): Promise<ApiConversation | null> {
  const [row] = await db
    .select({ conversation: conversations, contact: contacts })
    .from(conversations)
    .leftJoin(contacts, eq(conversations.contactId, contacts.id))
    .where(
      and(eq(conversations.id, id), eq(conversations.accountId, accountId))
    )
    .limit(1);
  if (!row) return null;
  const tagMap = await tagsByContactIds(row.contact ? [row.contact.id] : []);
  return serializeConversationRow(
    row.conversation,
    row.contact,
    row.contact ? (tagMap.get(row.contact.id) ?? []) : []
  );
}

export async function listConversationMessages(params: {
  accountId: string;
  conversationId: string;
  limit: number;
  cursor: Cursor | null;
  direction?: string | null;
  contentType?: string | null;
  status?: string | null;
  templateName?: string | null;
  interactiveReplyId?: string | null;
  createdAfter?: Date | null;
  createdBefore?: Date | null;
}): Promise<Array<ApiMessage & { id: string; created_at: string }>> {
  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, params.conversationId),
        eq(conversations.accountId, params.accountId)
      )
    )
    .limit(1);
  if (!conversation) return [];

  const whereParts = [eq(messages.conversationId, params.conversationId)];
  applyMessageFilters(whereParts, params);
  if (params.cursor) {
    const cursorDate = new Date(params.cursor.createdAt);
    whereParts.push(
      or(
        lt(messages.createdAt, cursorDate),
        and(
          eq(messages.createdAt, cursorDate),
          lt(messages.id, params.cursor.id)
        )
      )!
    );
  }

  const rows = await db
    .select()
    .from(messages)
    .where(and(...whereParts))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(params.limit);

  return rows.map(serializeMessageRow);
}

function applyMessageFilters(
  whereParts: SQL[],
  filters: {
    direction?: string | null;
    contentType?: string | null;
    status?: string | null;
    templateName?: string | null;
    interactiveReplyId?: string | null;
    createdAfter?: Date | null;
    createdBefore?: Date | null;
  }
) {
  if (filters.direction === 'inbound') {
    whereParts.push(eq(messages.senderType, 'customer'));
  } else if (filters.direction === 'outbound') {
    whereParts.push(
      or(eq(messages.senderType, 'agent'), eq(messages.senderType, 'bot'))!
    );
  }
  if (filters.contentType)
    whereParts.push(eq(messages.contentType, filters.contentType));
  if (filters.status) whereParts.push(eq(messages.status, filters.status));
  if (filters.templateName)
    whereParts.push(eq(messages.templateName, filters.templateName));
  if (filters.interactiveReplyId) {
    whereParts.push(
      eq(messages.interactiveReplyId, filters.interactiveReplyId)
    );
  }
  if (filters.createdAfter)
    whereParts.push(gte(messages.createdAt, filters.createdAfter));
  if (filters.createdBefore)
    whereParts.push(lte(messages.createdAt, filters.createdBefore));
}

function parseDateParam(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function messageFiltersFromUrl(url: URL) {
  return {
    conversationId: url.searchParams.get('conversation_id'),
    contactId: url.searchParams.get('contact_id'),
    phone: url.searchParams.get('phone'),
    direction: url.searchParams.get('direction'),
    contentType: url.searchParams.get('content_type'),
    status: url.searchParams.get('status'),
    templateName: url.searchParams.get('template_name'),
    interactiveReplyId: url.searchParams.get('interactive_reply_id'),
    search: url.searchParams.get('q'),
    createdAfter: parseDateParam(url.searchParams.get('created_after')),
    createdBefore: parseDateParam(url.searchParams.get('created_before')),
  };
}

export async function listMessages(params: {
  accountId: string;
  limit: number;
  cursor: Cursor | null;
  conversationId?: string | null;
  contactId?: string | null;
  phone?: string | null;
  direction?: string | null;
  contentType?: string | null;
  status?: string | null;
  templateName?: string | null;
  interactiveReplyId?: string | null;
  search?: string | null;
  createdAfter?: Date | null;
  createdBefore?: Date | null;
}): Promise<Array<ApiMessage & { id: string; created_at: string }>> {
  const whereParts: SQL[] = [eq(conversations.accountId, params.accountId)];
  if (params.conversationId) {
    whereParts.push(eq(messages.conversationId, params.conversationId));
  }
  if (params.contactId) {
    whereParts.push(eq(conversations.contactId, params.contactId));
  }
  if (params.phone) {
    whereParts.push(eq(contacts.phoneNormalized, normalizePhone(params.phone)));
  }
  if (params.search) {
    whereParts.push(ilike(messages.contentText, `%${params.search}%`));
  }
  applyMessageFilters(whereParts, params);
  if (params.cursor) {
    const cursorDate = new Date(params.cursor.createdAt);
    whereParts.push(
      or(
        lt(messages.createdAt, cursorDate),
        and(
          eq(messages.createdAt, cursorDate),
          lt(messages.id, params.cursor.id)
        )
      )!
    );
  }

  const rows = await db
    .select({ message: messages, contact: contacts })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .leftJoin(contacts, eq(conversations.contactId, contacts.id))
    .where(and(...whereParts))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(params.limit);

  return rows.map((row) => serializeMessageJoinedRow(row.message, row.contact));
}

export async function conversationExists(
  accountId: string,
  conversationId: string
) {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.accountId, accountId)
      )
    )
    .limit(1);
  return Boolean(row);
}
