import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { contacts, conversations, paymentLinks } from '@/db/schema';
import { getCurrentDbAccount } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';

function serializePayment(row: {
  payment: typeof paymentLinks.$inferSelect;
  contact: Pick<typeof contacts.$inferSelect, 'id' | 'name' | 'phone' | 'email'> | null;
  conversation: Pick<typeof conversations.$inferSelect, 'id' | 'status'> | null;
}) {
  return {
    id: row.payment.id,
    account_id: row.payment.accountId,
    contact_id: row.payment.contactId,
    conversation_id: row.payment.conversationId,
    provider: row.payment.provider,
    amount_cents: row.payment.amountCents,
    currency: row.payment.currency,
    concept: row.payment.concept,
    email: row.payment.email,
    phone: row.payment.phone,
    order_id: row.payment.orderId,
    payment_url: row.payment.paymentUrl,
    status: row.payment.status,
    raw_response: row.payment.rawResponse,
    last_synced_at: row.payment.lastSyncedAt?.toISOString() ?? null,
    created_by: row.payment.createdBy,
    created_at: row.payment.createdAt.toISOString(),
    updated_at: row.payment.updatedAt.toISOString(),
    contact: row.contact,
    conversation: row.conversation,
  };
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentDbAccount();
    const url = new URL(request.url);
    const status = url.searchParams.get('status');

    const rows = await db
      .select({
        payment: paymentLinks,
        contact: {
          id: contacts.id,
          name: contacts.name,
          phone: contacts.phone,
          email: contacts.email,
        },
        conversation: {
          id: conversations.id,
          status: conversations.status,
        },
      })
      .from(paymentLinks)
      .leftJoin(contacts, eq(contacts.id, paymentLinks.contactId))
      .leftJoin(conversations, eq(conversations.id, paymentLinks.conversationId))
      .where(
        status && status !== 'all'
          ? and(
              eq(paymentLinks.accountId, ctx.accountId),
              eq(paymentLinks.status, status),
            )
          : eq(paymentLinks.accountId, ctx.accountId),
      )
      .orderBy(desc(paymentLinks.createdAt))
      .limit(100);

    return NextResponse.json({ payments: rows.map(serializePayment) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
