import { and, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { contacts } from '@/db/schema';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  getContactById,
  setContactTags,
  resolveAuditUserId,
  ContactError,
} from '@/lib/api/v1/contacts';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'contacts:read');
    const { id } = await params;
    const contact = await getContactById(ctx.accountId, id);
    if (!contact) return fail('not_found', 'Contact not found', 404);
    return ok(contact);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');
    const { id } = await params;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const existing = await getContactById(ctx.accountId, id);
    if (!existing) return fail('not_found', 'Contact not found', 404);

    const updates: Partial<typeof contacts.$inferInsert> = {};
    for (const field of ['name', 'email', 'company'] as const) {
      if (!(field in body)) continue;
      const value = body[field];
      if (value === null || typeof value === 'string') {
        updates[field] = value;
      } else {
        return fail('bad_request', `'${field}' must be a string or null`, 400);
      }
    }

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date();
      await db
        .update(contacts)
        .set(updates)
        .where(and(eq(contacts.id, id), eq(contacts.accountId, ctx.accountId)));
    }

    if (Array.isArray(body.tags)) {
      const auditUserId = await resolveAuditUserId(ctx.accountId);
      await setContactTags(
        ctx.accountId,
        auditUserId,
        id,
        body.tags.filter((tag): tag is string => typeof tag === 'string'),
      );
    }

    const contact = await getContactById(ctx.accountId, id);
    return ok(contact);
  } catch (err) {
    if (err instanceof ContactError) {
      return fail(err.status === 400 ? 'bad_request' : 'internal', err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
