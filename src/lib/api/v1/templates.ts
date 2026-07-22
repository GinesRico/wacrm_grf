import { and, desc, eq, ilike, lt, or, type SQL } from 'drizzle-orm';

import { db } from '@/db/client';
import { messageTemplates } from '@/db/schema';
import type { Cursor } from '@/lib/api/v1/pagination';
import { serializeMessageTemplate } from '@/lib/whatsapp/template-serializer';

function cursorWhere(cursor: Cursor | null): SQL | undefined {
  if (!cursor) return undefined;
  const createdAt = new Date(cursor.createdAt);
  return or(
    lt(messageTemplates.createdAt, createdAt),
    and(eq(messageTemplates.createdAt, createdAt), lt(messageTemplates.id, cursor.id)),
  );
}

export async function listTemplates(params: {
  accountId: string;
  limit: number;
  cursor: Cursor | null;
  status?: string | null;
  category?: string | null;
  language?: string | null;
  name?: string | null;
}) {
  const conditions: SQL[] = [eq(messageTemplates.accountId, params.accountId)];
  if (params.status) conditions.push(eq(messageTemplates.status, params.status));
  if (params.category) conditions.push(eq(messageTemplates.category, params.category));
  if (params.language) conditions.push(eq(messageTemplates.language, params.language));
  if (params.name) conditions.push(ilike(messageTemplates.name, `%${params.name}%`));
  const cursorCondition = cursorWhere(params.cursor);
  if (cursorCondition) conditions.push(cursorCondition);

  const rows = await db
    .select()
    .from(messageTemplates)
    .where(and(...conditions))
    .orderBy(desc(messageTemplates.createdAt), desc(messageTemplates.id))
    .limit(params.limit);

  return rows.map(serializeMessageTemplate);
}

export async function getTemplate(accountId: string, id: string) {
  const [row] = await db
    .select()
    .from(messageTemplates)
    .where(and(eq(messageTemplates.id, id), eq(messageTemplates.accountId, accountId)))
    .limit(1);

  return row ? serializeMessageTemplate(row) : null;
}
