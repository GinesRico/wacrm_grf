import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { contacts, conversations, paymentLinks } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { runAutomationsForTrigger } from "@/lib/automations/engine";
import {
  createArveraPaymentLink,
  normalizeAmountCents,
  requireActiveArveraConnection,
  responseToPaymentRecord,
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
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
    }

    const amountCents = normalizeAmountCents(body);
    const concept = typeof body.concept === "string" ? body.concept.trim() : "";
    if (!amountCents) {
      return NextResponse.json({ error: "Valid amount is required" }, { status: 400 });
    }
    if (!concept) {
      return NextResponse.json({ error: "Concept is required" }, { status: 400 });
    }

    const contactId = typeof body.contact_id === "string" ? body.contact_id : null;
    const conversationId =
      typeof body.conversation_id === "string" ? body.conversation_id : null;

    if (contactId) {
      const [contact] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.accountId, ctx.accountId), eq(contacts.id, contactId)))
        .limit(1);
      if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }

    if (conversationId) {
      const [conversation] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.accountId, ctx.accountId),
            eq(conversations.id, conversationId),
          ),
        )
        .limit(1);
      if (!conversation) {
        return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
      }
    }

    const { config, apiKey } = await requireActiveArveraConnection(
      null,
      ctx.accountId,
    );
    const payload = await createArveraPaymentLink({
      config,
      apiKey,
      input: {
        amountCents,
        concept,
        email: typeof body.email === "string" ? body.email.trim() : null,
        phone: typeof body.phone === "string" ? body.phone.trim() : null,
      },
    });
    const normalized = responseToPaymentRecord(payload);

    const [data] = await db
      .insert(paymentLinks)
      .values({
        accountId: ctx.accountId,
        contactId,
        conversationId,
        provider: "arvera-payments",
        amountCents,
        currency: "EUR",
        concept,
        email: typeof body.email === "string" ? body.email.trim() : null,
        phone: typeof body.phone === "string" ? body.phone.trim() : null,
        orderId: normalized.orderId,
        paymentUrl: normalized.paymentUrl,
        status: normalized.status,
        rawResponse: payload,
        createdBy: ctx.userId,
      })
      .returning();

    void runAutomationsForTrigger({
      accountId: ctx.accountId,
      triggerType: "payment_link_created",
      contactId,
      context: {
        conversation_id: conversationId ?? undefined,
        vars: {
          payment_link_id: data.id,
          payment_url: data.paymentUrl,
          order_id: data.orderId,
          amount_cents: data.amountCents,
          concept: data.concept,
        },
      },
    });

    return NextResponse.json({ payment_link: serializePaymentLink(data) }, { status: 201 });
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
