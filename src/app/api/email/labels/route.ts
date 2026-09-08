import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import {
  createEmailLabelForUser,
  listEmailLabelsForUser,
  serializeEmailLabel,
  setEmailMessageLabelsForUser,
} from '@/lib/email/service';

export async function GET(request: Request) {
  try {
    const ctx = await requireDbRole('viewer');
    const url = new URL(request.url);
    const labels = await listEmailLabelsForUser({
      accountId: ctx.accountId,
      userId: ctx.userId,
      role: ctx.role,
      mailboxId: url.searchParams.get('mailbox_id'),
    });
    return NextResponse.json({ labels });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole('agent');
    const body = await request.json().catch(() => ({}));

    if (body?.action === 'set_message_labels') {
      if (typeof body.message_id !== 'string') {
        return NextResponse.json({ error: 'message_id is required.' }, { status: 400 });
      }
      const labelIds = Array.isArray(body.label_ids)
        ? body.label_ids.filter((item: unknown): item is string => typeof item === 'string')
        : [];
      const labels = await setEmailMessageLabelsForUser({
        accountId: ctx.accountId,
        userId: ctx.userId,
        role: ctx.role,
        messageId: body.message_id,
        labelIds,
      });
      return NextResponse.json({ labels });
    }

    if (typeof body?.mailbox_id !== 'string') {
      return NextResponse.json({ error: 'mailbox_id is required.' }, { status: 400 });
    }
    const label = await createEmailLabelForUser({
      accountId: ctx.accountId,
      userId: ctx.userId,
      role: ctx.role,
      mailboxId: body.mailbox_id,
      name: String(body.name ?? ''),
      color: typeof body.color === 'string' ? body.color : undefined,
    });
    return NextResponse.json({ label: serializeEmailLabel(label) });
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
