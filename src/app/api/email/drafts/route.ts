import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import {
  deleteEmailDraftForUser,
  listEmailDraftsForUser,
  serializeEmailDraft,
  upsertEmailDraftForUser,
} from '@/lib/email/service';

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

export async function GET(request: Request) {
  try {
    const ctx = await requireDbRole('viewer');
    const url = new URL(request.url);
    const drafts = await listEmailDraftsForUser({
      accountId: ctx.accountId,
      userId: ctx.userId,
      role: ctx.role,
      mailboxId: url.searchParams.get('mailbox_id'),
    });
    return NextResponse.json({ drafts });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole('agent');
    const body = await request.json().catch(() => ({}));
    if (typeof body?.mailbox_id !== 'string') {
      return NextResponse.json({ error: 'mailbox_id is required.' }, { status: 400 });
    }
    const draft = await upsertEmailDraftForUser({
      accountId: ctx.accountId,
      userId: ctx.userId,
      role: ctx.role,
      draftId: typeof body?.draft_id === 'string' ? body.draft_id : null,
      mailboxId: body.mailbox_id,
      to: list(body?.to),
      cc: list(body?.cc),
      bcc: list(body?.bcc),
      subject: typeof body?.subject === 'string' ? body.subject : '',
      text: typeof body?.text === 'string' ? body.text : '',
      html: typeof body?.html === 'string' ? body.html : null,
      attachments: Array.isArray(body?.attachments) ? body.attachments : [],
      inReplyToMessageId:
        typeof body?.in_reply_to_message_id === 'string'
          ? body.in_reply_to_message_id
          : null,
    });
    return NextResponse.json({ draft: serializeEmailDraft(draft) });
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireDbRole('agent');
    const url = new URL(request.url);
    const draftId = url.searchParams.get('draft_id');
    if (!draftId) {
      return NextResponse.json({ error: 'draft_id is required.' }, { status: 400 });
    }
    const draft = await deleteEmailDraftForUser({
      accountId: ctx.accountId,
      userId: ctx.userId,
      draftId,
    });
    return NextResponse.json({ draft: draft ? serializeEmailDraft(draft) : null });
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
