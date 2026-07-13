import type { SupabaseClient } from "@supabase/supabase-js";

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
  db: SupabaseClient,
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

  const { data, error } = await db
    .from("profiles")
    .select("user_id, full_name, email, avatar_url")
    .eq("account_id", accountId)
    .in("user_id", agentIds);

  if (error) throw error;

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

export interface ContactFilters {
  /** Tag ids; a conversation matches if its contact has ANY of them (OR). */
  tagIds: string[];
  /** Exact company match, or null for no company filter. */
  company: string | null;
}

/**
 * Whether a conversation passes the contact-based Inbox filters (issue #272).
 * Empty `tagIds` and null `company` are no-ops, so the default (no filters)
 * always matches. Tags use OR logic, consistent with Broadcast audiences.
 */
export function matchesContactFilters(
  conversation: Conversation,
  { tagIds, company }: ContactFilters,
): boolean {
  if (tagIds.length > 0) {
    const contactTagIds = conversation.contact?.tags ?? [];
    if (!contactTagIds.some((t) => tagIds.includes(t.id))) return false;
  }

  if (company !== null && conversation.contact?.company?.trim() !== company) {
    return false;
  }

  return true;
}
