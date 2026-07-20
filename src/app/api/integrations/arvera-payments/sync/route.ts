import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { paymentLinks } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { runAutomationsForTrigger } from "@/lib/automations/engine";
import {
  fetchArveraPaymentStatus,
  normalizePaymentStatus,
  requireActiveArveraConnection,
} from "@/lib/integrations/arvera-payments";

function serializePaymentLink(row: typeof paymentLinks.$inferSelect) {
  return {
    id: row.id,
    account_id: row.accountId,
    contact_id: row.contactId,
    conversation_id: row.conversationId,
    provider: row.provider,
    amount_cents: row.amountCents,
    currency: row.currency,
    concept: row.concept,
    email: row.email,
    phone: row.phone,
    order_id: row.orderId,
    payment_url: row.paymentUrl,
    status: row.status,
    raw_response: row.rawResponse,
    last_synced_at: row.lastSyncedAt?.toISOString() ?? null,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole("agent");
    const body = (await request.json().catch(() => null)) as {
      payment_link_id?: unknown;
      order_id?: unknown;
    } | null;

    const where =
      typeof body?.payment_link_id === "string"
        ? and(
            eq(paymentLinks.accountId, ctx.accountId),
            eq(paymentLinks.id, body.payment_link_id),
          )
        : typeof body?.order_id === "string"
          ? and(
              eq(paymentLinks.accountId, ctx.accountId),
              eq(paymentLinks.orderId, body.order_id),
            )
          : null;

    const [link] = where
      ? await db.select().from(paymentLinks).where(where).limit(1)
      : [];

    if (!link) {
      return NextResponse.json({ error: "Payment link not found" }, { status: 404 });
    }

    const { config } = await requireActiveArveraConnection(null, ctx.accountId);
    const document = await fetchArveraPaymentStatus({
      config,
      orderId: link.orderId,
    });
    if (!document) {
      return NextResponse.json({
        payment_link: serializePaymentLink(link),
        synced: false,
      });
    }

    const nextStatus = normalizePaymentStatus(document.status);
    const changed = nextStatus !== link.status;
    const rawResponse =
      link.rawResponse && typeof link.rawResponse === "object" && !Array.isArray(link.rawResponse)
        ? link.rawResponse
        : {};

    const [updated] = await db
      .update(paymentLinks)
      .set({
        status: nextStatus,
        rawResponse: { ...rawResponse, latest_document: document },
        lastSyncedAt: new Date(),
      })
      .where(
        and(
          eq(paymentLinks.id, link.id),
          eq(paymentLinks.accountId, ctx.accountId),
        ),
      )
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Failed to update payment link" }, { status: 500 });
    }

    if (changed && (nextStatus === "paid" || nextStatus === "failed")) {
      void runAutomationsForTrigger({
        accountId: ctx.accountId,
        triggerType: nextStatus === "paid" ? "payment_paid" : "payment_failed",
        contactId: updated.contactId,
        context: {
          conversation_id: updated.conversationId ?? undefined,
          vars: {
            payment_link_id: updated.id,
            payment_url: updated.paymentUrl,
            order_id: updated.orderId,
            amount_cents: updated.amountCents,
            concept: updated.concept,
            status: updated.status,
          },
        },
      });
    }

    return NextResponse.json({
      payment_link: serializePaymentLink(updated),
      synced: true,
      changed,
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "UnauthorizedError" || err.name === "ForbiddenError")
    ) {
      return toErrorResponse(err);
    }
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
