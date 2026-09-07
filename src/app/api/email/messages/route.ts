import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import {
  listEmailMessages,
  serializeEmailMessage,
  updateEmailMessageState,
} from '@/lib/email/service';

export async function GET(request: Request) {
  try {
    const ctx = await requireDbRole('viewer');
    const url = new URL(request.url);
    return NextResponse.json(
      await listEmailMessages({
        accountId: ctx.accountId,
        userId: ctx.userId,
        role: ctx.role,
        mailboxId: url.searchParams.get('mailbox_id'),
        folderId: url.searchParams.get('folder_id'),
        q: url.searchParams.get('q'),
      }),
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireDbRole('agent');
    const body = await request.json().catch(() => ({}));
    if (typeof body?.message_id !== 'string') {
      return NextResponse.json({ error: 'message_id is required.' }, { status: 400 });
    }
    const updated = await updateEmailMessageState({
      accountId: ctx.accountId,
      userId: ctx.userId,
      role: ctx.role,
      messageId: body.message_id,
      isRead: typeof body?.is_read === 'boolean' ? body.is_read : undefined,
      folderId: typeof body?.folder_id === 'string' ? body.folder_id : undefined,
    });
    return NextResponse.json({ message: serializeEmailMessage(updated) });
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
