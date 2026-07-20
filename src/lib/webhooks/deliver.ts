import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { webhookEndpoints } from "@/db/schema";
import { decrypt } from "@/lib/whatsapp/encryption";
import { buildSignatureHeader } from "@/lib/webhooks/sign";
import { isDeliverableUrl } from "@/lib/webhooks/ssrf";
import type { WebhookEvent } from "@/lib/webhooks/events";

export const DELIVERY_TIMEOUT_MS = 5000;
export const MAX_CONSECUTIVE_FAILURES = 15;

interface EndpointRow {
  id: string;
  url: string;
  secret: string;
}

export async function dispatchWebhookEvent(
  _unusedClient: unknown,
  accountId: string,
  event: WebhookEvent,
  data: unknown,
): Promise<void> {
  try {
    const rows = await db
      .select({
        id: webhookEndpoints.id,
        url: webhookEndpoints.url,
        secret: webhookEndpoints.secret,
      })
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.accountId, accountId),
          eq(webhookEndpoints.isActive, true),
          sql`${webhookEndpoints.events} @> ARRAY[${event}]::text[]`,
        ),
      );

    if (rows.length === 0) return;

    const payload = JSON.stringify({
      id: randomUUID(),
      event,
      occurred_at: new Date().toISOString(),
      account_id: accountId,
      data,
    });
    const tsSeconds = Math.floor(Date.now() / 1000);

    await Promise.allSettled(
      rows.map((row) => deliverOne(row, event, payload, tsSeconds)),
    );
  } catch (err) {
    console.error("[webhooks] dispatch failed:", err);
  }
}

async function deliverOne(
  row: EndpointRow,
  event: WebhookEvent,
  payload: string,
  tsSeconds: number,
): Promise<void> {
  if (!(await isDeliverableUrl(row.url))) {
    console.warn("[webhooks] refusing non-public delivery target for", row.id);
    await recordFailure(row);
    return;
  }

  let secret: string;
  try {
    secret = decrypt(row.secret);
  } catch (err) {
    console.error("[webhooks] secret decrypt failed for", row.id, err);
    await recordFailure(row);
    return;
  }

  try {
    const res = await fetch(row.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Wacrm-Event": event,
        "X-Wacrm-Webhook-Id": row.id,
        "X-Wacrm-Signature": buildSignatureHeader(payload, secret, tsSeconds),
      },
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`endpoint responded ${res.status}`);

    await db
      .update(webhookEndpoints)
      .set({ failureCount: 0, lastDeliveryAt: new Date() })
      .where(eq(webhookEndpoints.id, row.id));
  } catch (err) {
    console.warn(
      `[webhooks] delivery to ${row.id} failed:`,
      err instanceof Error ? err.message : err,
    );
    await recordFailure(row);
  }
}

async function recordFailure(row: EndpointRow): Promise<void> {
  await db
    .execute(
      sql`update webhook_endpoints
          set failure_count = failure_count + 1,
              is_active = case
                when failure_count + 1 >= ${MAX_CONSECUTIVE_FAILURES} then false
                else is_active
              end
          where id = ${row.id}`,
    )
    .catch((error) => {
      console.error("[webhooks] record failure failed for", row.id, error);
    });
}
