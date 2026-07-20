import { desc, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { webhookEndpoints } from '@/db/schema';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { encrypt } from '@/lib/whatsapp/encryption';
import { normalizeEvents } from '@/lib/webhooks/events';
import {
  serializeWebhookEndpoint,
  generateWebhookSecret,
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

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');
    const rows = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.accountId, ctx.accountId))
      .orderBy(desc(webhookEndpoints.createdAt));

    return okList(rows.map(publicWebhook), null);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const url = normalizeWebhookUrl(body.url);
    if (!url) return fail('bad_request', "'url' must be a valid https:// URL", 400);

    const events = normalizeEvents(body.events);
    if (!events) {
      return fail(
        'bad_request',
        "'events' must be a non-empty array of known event names",
        400,
      );
    }

    const secret = generateWebhookSecret();
    const [created] = await db
      .insert(webhookEndpoints)
      .values({
        accountId: ctx.accountId,
        createdBy: ctx.createdBy,
        url,
        secret: encrypt(secret),
        events,
      })
      .returning();

    if (!created) return fail('internal', 'Failed to create webhook', 500);
    return ok({ ...publicWebhook(created), secret }, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
