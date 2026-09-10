import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import {
  getEmailSignatureForUser,
  saveEmailSignatureForUser,
  serializeEmailSignature,
} from '@/lib/email/service';

export async function GET(request: Request) {
  try {
    const ctx = await requireDbRole('agent');
    const url = new URL(request.url);
    const mailboxId = url.searchParams.get('mailbox_id');
    const signature = await getEmailSignatureForUser({
      accountId: ctx.accountId,
      userId: ctx.userId,
      role: ctx.role,
      mailboxId,
    });

    return NextResponse.json({ signature: signature ? serializeEmailSignature(signature) : null });
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireDbRole('agent');
    const body = await request.json().catch(() => ({}));
    const mailboxId = typeof body?.mailbox_id === 'string' && body.mailbox_id ? body.mailbox_id : null;
    const signature = await saveEmailSignatureForUser({
      accountId: ctx.accountId,
      userId: ctx.userId,
      role: ctx.role,
      mailboxId,
      name: typeof body?.name === 'string' ? body.name : 'Firma',
      bodyText: typeof body?.body_text === 'string' ? body.body_text : '',
      bodyHtml: typeof body?.body_html === 'string' ? body.body_html : null,
      enabled: body?.enabled !== false,
    });

    return NextResponse.json({ signature: serializeEmailSignature(signature) });
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
