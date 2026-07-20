import { and, eq, like } from "drizzle-orm";

import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { normalizePhone, phonesMatch } from "@/lib/whatsapp/phone-utils";

export function normalizeKey(phone: string): string {
  return normalizePhone(phone);
}

export interface ExistingContact {
  id: string;
  phone: string;
  name?: string | null;
  [key: string]: unknown;
}

function serializeContact(row: typeof contacts.$inferSelect): ExistingContact {
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    phone: row.phone,
    phone_normalized: row.phoneNormalized,
    name: row.name,
    email: row.email,
    company: row.company,
    avatar_url: row.avatarUrl,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function findExistingContact(
  _unusedClient: unknown,
  accountId: string,
  phone: string,
): Promise<ExistingContact | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const suffix = normalized.length >= 8 ? normalized.slice(-8) : normalized;
  const rows = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.accountId, accountId), like(contacts.phone, `%${suffix}`)));

  const matched = rows.find((contact) => phonesMatch(contact.phone, phone));
  return matched ? serializeContact(matched) : null;
}

export function isExactMatch(existing: ExistingContact, phone: string): boolean {
  return normalizeKey(existing.phone) === normalizeKey(phone);
}

export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: string }).code === "23505";
}

export function dedupeByPhone<T extends { phone: string }>(
  rows: T[],
): { unique: T[]; duplicates: number } {
  const seen = new Set<string>();
  const unique: T[] = [];
  let duplicates = 0;

  for (const row of rows) {
    const key = normalizeKey(row.phone);
    if (!key || seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    unique.push(row);
  }

  return { unique, duplicates };
}
