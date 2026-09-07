import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import { importAllEmailAccounts, importEmailAccount } from '@/lib/email/service';

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole('admin');
    const body = await request.json().catch(() => ({}));
    const maxMessages =
      typeof body?.max_messages === 'number' && body.max_messages > 0
        ? Math.min(body.max_messages, 200)
        : 50;
    const result =
      typeof body?.email_account_id === 'string'
        ? await importEmailAccount({
            accountId: ctx.accountId,
            emailAccountId: body.email_account_id,
            userId: ctx.userId,
            maxMessages,
          })
        : await importAllEmailAccounts({
            accountId: ctx.accountId,
            userId: ctx.userId,
            maxMessages,
          });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}

export async function GET(request: Request) {
  const expected = process.env.EMAIL_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  if (request.headers.get('x-cron-secret') !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await importAllEmailAccounts({ maxMessages: 50 });
  return NextResponse.json(result);
}
