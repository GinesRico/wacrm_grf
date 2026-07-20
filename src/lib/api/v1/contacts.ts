import { and, asc, desc, eq, ilike, inArray, lt, or, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import {
  contactTags,
  contacts,
  crmAccounts,
  tags,
  whatsappConfig,
} from '@/db/schema';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';

const DEFAULT_TAG_COLOR = '#3b82f6';

export interface ApiContact {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  company: string | null;
  avatar_url: string | null;
  tags: { id: string; name: string; color: string }[];
  created_at: string;
  updated_at: string;
}

export class ContactError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ContactError';
    this.status = status;
  }
}

export interface ContactInput {
  phone: string;
  name?: string | null;
  email?: string | null;
  company?: string | null;
}

export function serializeContactRow(
  row: typeof contacts.$inferSelect,
  rowTags: { id: string; name: string; color: string }[] = [],
): ApiContact {
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    email: row.email,
    company: row.company,
    avatar_url: row.avatarUrl,
    tags: rowTags,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export const serializeContact = (row: Record<string, unknown>): ApiContact => ({
  id: row.id as string,
  phone: row.phone as string,
  name: (row.name as string | null) ?? null,
  email: (row.email as string | null) ?? null,
  company: (row.company as string | null) ?? null,
  avatar_url: (row.avatar_url as string | null) ?? null,
  tags: [],
  created_at: row.created_at as string,
  updated_at: row.updated_at as string,
});

export async function resolveAuditUserId(
  accountIdOrClient: string | unknown,
  maybeAccountId?: string,
): Promise<string> {
  const accountId = maybeAccountId ?? (accountIdOrClient as string);
  const [config] = await db
    .select({ userId: whatsappConfig.userId })
    .from(whatsappConfig)
    .where(eq(whatsappConfig.accountId, accountId))
    .orderBy(desc(whatsappConfig.isDefault), asc(whatsappConfig.createdAt))
    .limit(1);

  if (config?.userId) return config.userId;

  const [account] = await db
    .select({ ownerUserId: crmAccounts.ownerUserId })
    .from(crmAccounts)
    .where(eq(crmAccounts.id, accountId))
    .limit(1);

  if (!account?.ownerUserId) {
    throw new ContactError('Account owner could not be resolved', 500);
  }
  return account.ownerUserId;
}

export async function findOrCreateContact(
  accountIdOrClient: string | unknown,
  auditUserIdOrAccountId: string,
  inputOrAuditUserId: ContactInput | string,
  maybeInput?: ContactInput,
): Promise<{ id: string; created: boolean }> {
  const accountId = maybeInput ? auditUserIdOrAccountId : (accountIdOrClient as string);
  const auditUserId = maybeInput ? (inputOrAuditUserId as string) : auditUserIdOrAccountId;
  const input = maybeInput ?? (inputOrAuditUserId as ContactInput);
  const sanitized = sanitizePhoneForMeta(input.phone);
  if (!isValidE164(sanitized)) {
    throw new ContactError(
      "'phone' must be a valid phone number in E.164 format (e.g. +14155550123)",
      400,
    );
  }

  const existing = await findExistingContact(null, accountId, sanitized);
  if (existing) return { id: existing.id, created: false };

  try {
    const [created] = await db
      .insert(contacts)
      .values({
        accountId,
        userId: auditUserId,
        phone: sanitized,
        phoneNormalized: sanitized.replace(/\D/g, ''),
        name: input.name ?? sanitized,
        email: input.email ?? null,
        company: input.company ?? null,
      })
      .returning({ id: contacts.id });

    if (!created) throw new ContactError('Failed to create contact', 500);
    return { id: created.id, created: true };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(null, accountId, sanitized);
      if (raced) return { id: raced.id, created: false };
    }
    console.error('[api/v1/contacts] create error:', error);
    throw new ContactError('Failed to create contact', 500);
  }
}

async function resolveTagIds(
  accountId: string,
  userId: string,
  tagNames: string[],
): Promise<Set<string>> {
  const uniqueNames: string[] = [];
  const seen = new Set<string>();
  for (const raw of tagNames) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueNames.push(name);
  }

  if (uniqueNames.length === 0) return new Set();

  const existing = await db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(eq(tags.accountId, accountId));

  const tagIdByKey = new Map<string, string>();
  for (const tag of existing) {
    tagIdByKey.set(tag.name.trim().toLowerCase(), tag.id);
  }

  const toCreate = uniqueNames.filter((name) => !tagIdByKey.has(name.toLowerCase()));
  if (toCreate.length > 0) {
    const created = await db
      .insert(tags)
      .values(
        toCreate.map((name) => ({
          accountId,
          userId,
          name,
          color: DEFAULT_TAG_COLOR,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: tags.id, name: tags.name });

    for (const tag of created) {
      tagIdByKey.set(tag.name.trim().toLowerCase(), tag.id);
    }

    const refreshed = await db
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(eq(tags.accountId, accountId));
    for (const tag of refreshed) {
      tagIdByKey.set(tag.name.trim().toLowerCase(), tag.id);
    }
  }

  return new Set(
    uniqueNames
      .map((name) => tagIdByKey.get(name.toLowerCase()))
      .filter((id): id is string => Boolean(id)),
  );
}

export async function setContactTags(
  accountIdOrClient: string | unknown,
  auditUserIdOrAccountId: string,
  contactIdOrAuditUserId: string,
  tagNamesOrContactId: string[] | string,
  maybeTagNames?: string[],
): Promise<void> {
  const accountId = maybeTagNames ? auditUserIdOrAccountId : (accountIdOrClient as string);
  const auditUserId = maybeTagNames ? contactIdOrAuditUserId : auditUserIdOrAccountId;
  const contactId = maybeTagNames ? (tagNamesOrContactId as string) : contactIdOrAuditUserId;
  const tagNames = maybeTagNames ?? (tagNamesOrContactId as string[]);
  const desired = await resolveTagIds(accountId, auditUserId, tagNames);
  const current = await db
    .select({ tagId: contactTags.tagId })
    .from(contactTags)
    .where(eq(contactTags.contactId, contactId));

  const existing = new Set(current.map((row) => row.tagId));
  const toAdd = [...desired].filter((id) => !existing.has(id));
  const toRemove = [...existing].filter((id) => !desired.has(id));

  if (toRemove.length > 0) {
    await db
      .delete(contactTags)
      .where(
        and(
          eq(contactTags.contactId, contactId),
          inArray(contactTags.tagId, toRemove),
        ),
      );
  }

  if (toAdd.length > 0) {
    await db
      .insert(contactTags)
      .values(toAdd.map((tagId) => ({ contactId, tagId })))
      .onConflictDoNothing();
  }
}

export async function getContactById(
  accountId: string,
  contactId: string,
): Promise<ApiContact | null> {
  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
    .limit(1);
  if (!contact) return null;

  const tagRows = await db
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(contactTags)
    .innerJoin(tags, eq(contactTags.tagId, tags.id))
    .where(eq(contactTags.contactId, contactId))
    .orderBy(asc(tags.name));

  return serializeContactRow(contact, tagRows);
}

export async function listContacts(params: {
  accountId: string;
  limit: number;
  cursor: { createdAt: string; id: string } | null;
  search: string;
  tagId: string | null;
}): Promise<Array<ApiContact & { id: string; created_at: string }>> {
  const whereParts = [eq(contacts.accountId, params.accountId)];

  if (params.search) {
    whereParts.push(
      or(
        ilike(contacts.name, `%${params.search}%`),
        ilike(contacts.phone, `%${params.search}%`),
      )!,
    );
  }

  if (params.cursor) {
    const cursorDate = new Date(params.cursor.createdAt);
    whereParts.push(
      or(
        lt(contacts.createdAt, cursorDate),
        and(eq(contacts.createdAt, cursorDate), lt(contacts.id, params.cursor.id)),
      )!,
    );
  }

  if (params.tagId) {
    whereParts.push(sql`exists (
      select 1 from contact_tags ct
      where ct.contact_id = ${contacts.id}
        and ct.tag_id = ${params.tagId}
    )`);
  }

  const rows = await db
    .select()
    .from(contacts)
    .where(and(...whereParts))
    .orderBy(desc(contacts.createdAt), desc(contacts.id))
    .limit(params.limit);

  const ids = rows.map((row) => row.id);
  const tagRows =
    ids.length > 0
      ? await db
          .select({
            contactId: contactTags.contactId,
            id: tags.id,
            name: tags.name,
            color: tags.color,
          })
          .from(contactTags)
          .innerJoin(tags, eq(contactTags.tagId, tags.id))
          .where(inArray(contactTags.contactId, ids))
          .orderBy(asc(tags.name))
      : [];

  const tagsByContact = new Map<string, { id: string; name: string; color: string }[]>();
  for (const tag of tagRows) {
    const list = tagsByContact.get(tag.contactId) ?? [];
    list.push({ id: tag.id, name: tag.name, color: tag.color });
    tagsByContact.set(tag.contactId, list);
  }

  return rows.map((row) => serializeContactRow(row, tagsByContact.get(row.id) ?? []));
}
