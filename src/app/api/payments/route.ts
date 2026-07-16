import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const url = new URL(request.url);
    const status = url.searchParams.get('status');

    let query = ctx.supabase
      .from('payment_links')
      .select(
        '*, contact:contacts(id, name, phone, email), conversation:conversations(id, status)',
      )
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (status && status !== 'all') query = query.eq('status', status);

    const { data, error } = await query;
    if (error) {
      console.error('[GET /api/payments] fetch failed:', error);
      return NextResponse.json({ error: 'Failed to load payments' }, { status: 500 });
    }

    return NextResponse.json({ payments: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
