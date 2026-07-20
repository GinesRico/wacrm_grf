import { and, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { webhookEndpoints } from '@/db/schema';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { normalizeEvents } from '@/lib/webhooks/events';
import {
  serializeWebhookEndpoint,
  normalizeWebhookUrl,
} from '@/lib/webhooks/endpoints';

function publicWebhook(row: typeof webhookEndpoints.$inferSelect) {
  return serializeWebhookEndpoint({
    id: row.id,
    url: row.url,
    events: row.events,
    is_active: row.isActive,
    last_delivery_at: row.lastDeliveryAt?.toISOString() ?? null,
    failure_count: row.failureCount,
    created_at: row.createdAt.toISOString(),
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');
    const { id } = await params;

    const [data] = await db
      .select()
      .from(webhookEndpoints)
      .where(
        and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.accountId, ctx.accountId)),
      )
      .limit(1);

    if (!data) return fail('not_found', 'Webhook not found', 404);
    return ok(publicWebhook(data));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');
    const { id } = await params;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const updates: Partial<typeof webhookEndpoints.$inferInsert> = {};

    if ('url' in body) {
      const url = normalizeWebhookUrl(body.url);
      if (!url) return fail('bad_request', "'url' must be a valid https:// URL", 400);
      updates.url = url;
    }

    if ('events' in body) {
      const events = normalizeEvents(body.events);
      if (!events) {
        return fail(
          'bad_request',
          "'events' must be a non-empty array of known event names",
          400,
        );
      }
      updates.events = events;
    }

    if ('is_active' in body) {
      if (typeof body.is_active !== 'boolean') {
        return fail('bad_request', "'is_active' must be a boolean", 400);
      }
      updates.isActive = body.is_active;
      if (body.is_active === true) updates.failureCount = 0;
    }

    if (Object.keys(updates).length === 0) {
      return fail('bad_request', 'No updatable fields provided', 400);
    }

    const [data] = await db
      .update(webhookEndpoints)
      .set(updates)
      .where(
        and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.accountId, ctx.accountId)),
      )
      .returning();

    if (!data) return fail('not_found', 'Webhook not found', 404);
    return ok(publicWebhook(data));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');
    const { id } = await params;

    const [data] = await db
      .delete(webhookEndpoints)
      .where(
        and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.accountId, ctx.accountId)),
      )
      .returning({ id: webhookEndpoints.id });

    if (!data) return fail('not_found', 'Webhook not found', 404);
    return ok({ id: data.id, deleted: true });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
