import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import {
  markEmailMailboxAsRead,
  serializeEmailMessage,
  updateEmailMessagesBatch,
} from '@/lib/email/service';

export async function PATCH(request: Request) {
  try {
    const ctx = await requireDbRole('viewer');
    const body = await request.json().catch(() => ({}));
    if (body?.action === 'mark_mailbox_read') {
      if (typeof body.mailbox_id !== 'string') {
        return NextResponse.json({ error: 'mailbox_id is required.' }, { status: 400 });
      }
      const result = await markEmailMailboxAsRead({
        accountId: ctx.accountId,
        userId: ctx.userId,
        role: ctx.role,
        mailboxId: body.mailbox_id,
      });
      return NextResponse.json(result);
    }

    const messageIds = Array.isArray(body?.message_ids)
      ? body.message_ids.filter((item: unknown): item is string => typeof item === 'string')
      : [];
    if (messageIds.length === 0) {
      return NextResponse.json({ error: 'message_ids is required.' }, { status: 400 });
    }

    const messages = await updateEmailMessagesBatch({
      accountId: ctx.accountId,
      userId: ctx.userId,
      role: ctx.role,
      messageIds,
      isRead: typeof body?.is_read === 'boolean' ? body.is_read : undefined,
      isStarred: typeof body?.is_starred === 'boolean' ? body.is_starred : undefined,
      folderId: typeof body?.folder_id === 'string' ? body.folder_id : undefined,
    });

    return NextResponse.json({ messages: messages.map(serializeEmailMessage) });
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
