import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import {
  fetchArveraPaymentStatus,
  normalizePaymentStatus,
  requireActiveArveraConnection,
} from '@/lib/integrations/arvera-payments';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await request.json().catch(() => null)) as {
      payment_link_id?: unknown;
      order_id?: unknown;
    } | null;

    const query = ctx.supabase
      .from('payment_links')
      .select('*')
      .eq('account_id', ctx.accountId);

    const { data: link, error } =
      typeof body?.payment_link_id === 'string'
        ? await query.eq('id', body.payment_link_id).maybeSingle()
        : typeof body?.order_id === 'string'
          ? await query.eq('order_id', body.order_id).maybeSingle()
          : { data: null, error: null };

    if (error) {
      return NextResponse.json({ error: 'Failed to load payment link' }, { status: 500 });
    }
    if (!link) {
      return NextResponse.json({ error: 'Payment link not found' }, { status: 404 });
    }

    const { config } = await requireActiveArveraConnection(ctx.supabase, ctx.accountId);
    const document = await fetchArveraPaymentStatus({
      config,
      orderId: link.order_id,
    });
    if (!document) {
      return NextResponse.json({ payment_link: link, synced: false });
    }

    const nextStatus = normalizePaymentStatus(document.status);
    const changed = nextStatus !== link.status;
    const { data: updated, error: updateErr } = await ctx.supabase
      .from('payment_links')
      .update({
        status: nextStatus,
        raw_response: { ...(link.raw_response ?? {}), latest_document: document },
        last_synced_at: new Date().toISOString(),
      })
      .eq('id', link.id)
      .eq('account_id', ctx.accountId)
      .select('*')
      .single();

    if (updateErr || !updated) {
      return NextResponse.json({ error: 'Failed to update payment link' }, { status: 500 });
    }

    if (changed && (nextStatus === 'paid' || nextStatus === 'failed')) {
      void runAutomationsForTrigger({
        accountId: ctx.accountId,
        triggerType: nextStatus === 'paid' ? 'payment_paid' : 'payment_failed',
        contactId: updated.contact_id,
        context: {
          conversation_id: updated.conversation_id ?? undefined,
          vars: {
            payment_link_id: updated.id,
            payment_url: updated.payment_url,
            order_id: updated.order_id,
            amount_cents: updated.amount_cents,
            concept: updated.concept,
            status: updated.status,
          },
        },
      });
    }

    return NextResponse.json({ payment_link: updated, synced: true, changed });
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
