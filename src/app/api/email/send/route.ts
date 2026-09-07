import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import { sendEmail } from '@/lib/email/service';

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole('agent');
    const body = await request.json().catch(() => ({}));
    if (typeof body?.mailbox_id !== 'string') {
      return NextResponse.json({ error: 'mailbox_id is required.' }, { status: 400 });
    }
    const to = list(body?.to);
    if (to.length === 0) {
      return NextResponse.json({ error: 'At least one recipient is required.' }, { status: 400 });
    }
    const result = await sendEmail({
      accountId: ctx.accountId,
      userId: ctx.userId,
      role: ctx.role,
      mailboxId: body.mailbox_id,
      to,
      cc: list(body?.cc),
      subject: typeof body?.subject === 'string' ? body.subject : '',
      text: typeof body?.text === 'string' ? body.text : '',
      html: typeof body?.html === 'string' ? body.html : undefined,
      inReplyToMessageId:
        typeof body?.in_reply_to_message_id === 'string'
          ? body.in_reply_to_message_id
          : null,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
