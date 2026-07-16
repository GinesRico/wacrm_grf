import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import {
  createArveraPaymentLink,
  normalizeAmountCents,
  requireActiveArveraConnection,
  responseToPaymentRecord,
} from '@/lib/integrations/arvera-payments';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ error: 'Request body must be JSON' }, { status: 400 });
    }

    const amountCents = normalizeAmountCents(body);
    const concept = typeof body.concept === 'string' ? body.concept.trim() : '';
    if (!amountCents) {
      return NextResponse.json({ error: 'Valid amount is required' }, { status: 400 });
    }
    if (!concept) {
      return NextResponse.json({ error: 'Concept is required' }, { status: 400 });
    }

    const contactId = typeof body.contact_id === 'string' ? body.contact_id : null;
    const conversationId =
      typeof body.conversation_id === 'string' ? body.conversation_id : null;

    if (contactId) {
      const { data: contact } = await ctx.supabase
        .from('contacts')
        .select('id')
        .eq('account_id', ctx.accountId)
        .eq('id', contactId)
        .maybeSingle();
      if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    if (conversationId) {
      const { data: conversation } = await ctx.supabase
        .from('conversations')
        .select('id')
        .eq('account_id', ctx.accountId)
        .eq('id', conversationId)
        .maybeSingle();
      if (!conversation) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
      }
    }

    const { config, apiKey } = await requireActiveArveraConnection(
      ctx.supabase,
      ctx.accountId,
    );
    const payload = await createArveraPaymentLink({
      config,
      apiKey,
      input: {
        amountCents,
        concept,
        email: typeof body.email === 'string' ? body.email.trim() : null,
        phone: typeof body.phone === 'string' ? body.phone.trim() : null,
      },
    });
    const normalized = responseToPaymentRecord(payload);

    const { data, error } = await ctx.supabase
      .from('payment_links')
      .insert({
        account_id: ctx.accountId,
        contact_id: contactId,
        conversation_id: conversationId,
        provider: 'arvera-payments',
        amount_cents: amountCents,
        currency: 'EUR',
        concept,
        email: typeof body.email === 'string' ? body.email.trim() : null,
        phone: typeof body.phone === 'string' ? body.phone.trim() : null,
        order_id: normalized.orderId,
        payment_url: normalized.paymentUrl,
        status: normalized.status,
        raw_response: payload,
        created_by: ctx.userId,
      })
      .select('*')
      .single();

    if (error || !data) {
      console.error('[arvera payment-links] insert failed:', error);
      return NextResponse.json({ error: 'Payment link created but not saved' }, { status: 500 });
    }

    void runAutomationsForTrigger({
      accountId: ctx.accountId,
      triggerType: 'payment_link_created',
      contactId,
      context: {
        conversation_id: conversationId ?? undefined,
        vars: {
          payment_link_id: data.id,
          payment_url: data.payment_url,
          order_id: data.order_id,
          amount_cents: data.amount_cents,
          concept: data.concept,
        },
      },
    });

    return NextResponse.json({ payment_link: data }, { status: 201 });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === 'UnauthorizedError' || err.name === 'ForbiddenError')
    ) {
      return toErrorResponse(err);
    }
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
