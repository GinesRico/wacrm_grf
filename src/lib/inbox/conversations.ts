import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { profiles } from "@/db/schema";
import type { Conversation, Contact, Department, Profile, Tag, WhatsAppConfig } from "@/types";

/**
 * Conversation select that embeds the contact plus its tags, so the Inbox
 * can filter conversations by contact tag without a second round-trip.
 * `contact_tags(tags(*))` returns the join rows; {@link normalizeConversation}
 * flattens them onto `contact.tags`.
 */
export const CONVERSATION_SELECT =
  "*, contact:contacts(*, contact_tags(tags(*))), whatsapp_config:whatsapp_config(id, label, phone_number_id), department:departments(id, name, color)";

/** Raw shape returned by {@link CONVERSATION_SELECT} before flattening. */
type RawContact = Contact & { contact_tags?: { tags: Tag | null }[] };
type RawConversation = Omit<Conversation, "contact" | "whatsapp_config" | "assigned_agent"> & {
  contact?: RawContact | null;
  whatsapp_config?: Pick<WhatsAppConfig, "id" | "label" | "phone_number_id"> | null;
  department?: Pick<Department, "id" | "name" | "color"> | null;
};

/**
 * Flatten the embedded `contact_tags(tags(*))` join into `contact.tags`.
 * Safe to call on rows fetched with {@link CONVERSATION_SELECT}; a row with
 * no contact (e.g. a freshly-inserted conversation) passes through untouched.
 */
export function normalizeConversation(raw: RawConversation): Conversation {
  const rawContact = raw.contact;
  if (!rawContact) return raw as Conversation;

  const { contact_tags, ...contact } = rawContact;
  return {
    ...raw,
    contact: {
      ...contact,
      tags: (contact_tags ?? [])
        .map((ct) => ct.tags)
        .filter((t): t is Tag => t != null),
    },
  };
}

export function normalizeConversations(
  rows: RawConversation[],
): Conversation[] {
  return rows.map(normalizeConversation);
}

export async function hydrateAssignedAgents(
  _unusedClient: unknown,
  accountId: string,
  conversations: Conversation[],
): Promise<Conversation[]> {
  const agentIds = Array.from(
    new Set(
      conversations
        .map((conversation) => conversation.assigned_agent_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  if (agentIds.length === 0) return conversations;

  const data = await db
    .select({
      user_id: profiles.userId,
      full_name: profiles.fullName,
      email: profiles.email,
      avatar_url: profiles.avatarUrl,
    })
    .from(profiles)
    .where(
      and(eq(profiles.accountId, accountId), inArray(profiles.userId, agentIds)),
    );

  const profilesByUserId = new Map(
    ((data ?? []) as Pick<
      Profile,
      "user_id" | "full_name" | "email" | "avatar_url"
    >[]).map((profile) => [profile.user_id, profile]),
  );

  return conversations.map((conversation) => ({
    ...conversation,
    assigned_agent: conversation.assigned_agent_id
      ? profilesByUserId.get(conversation.assigned_agent_id) ?? null
      : null,
  }));
}

function rowsOf<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[];
}

const INBOX_CONVERSATION_ROW_SQL = sql.raw(`
  c.*,
  case
    when ct.id is null then null
    else json_build_object(
      'id', ct.id,
      'user_id', ct.user_id,
      'account_id', ct.account_id,
      'phone', ct.phone,
      'phone_normalized', ct.phone_normalized,
      'name', ct.name,
      'email', ct.email,
      'company', ct.company,
      'avatar_url', ct.avatar_url,
      'created_at', ct.created_at,
      'updated_at', ct.updated_at,
      'tags', coalesce(tags.items, '[]'::json)
    )
  end as contact,
  case
    when wc.id is null then null
    else json_build_object(
      'id', wc.id,
      'label', wc.label,
      'phone_number_id', wc.phone_number_id
    )
  end as whatsapp_config,
  case
    when d.id is null then null
    else json_build_object(
      'id', d.id,
      'name', d.name,
      'color', d.color
    )
  end as department
`);

export async function getInboxConversationById(
  accountId: string,
  conversationId: string,
): Promise<Conversation | null> {
  const result = await db.execute(sql`
    select ${INBOX_CONVERSATION_ROW_SQL}
    from conversations c
    left join contacts ct on ct.id = c.contact_id
    left join whatsapp_config wc on wc.id = c.whatsapp_config_id
    left join departments d on d.id = c.department_id
    left join lateral (
      select json_agg(
        json_build_object(
          'id', t.id,
          'user_id', t.user_id,
          'name', t.name,
          'color', t.color,
          'created_at', t.created_at
        )
        order by t.name asc
      ) as items
      from contact_tags ctag
      join tags t on t.id = ctag.tag_id
      where ctag.contact_id = ct.id
    ) tags on true
    where c.id = ${conversationId} and c.account_id = ${accountId}
    limit 1
  `);

  const [row] = rowsOf<RawConversation>(result);
  if (!row) return null;
  const [conversation] = await hydrateAssignedAgents(null, accountId, [
    normalizeConversation(row),
  ]);
  return conversation;
}

