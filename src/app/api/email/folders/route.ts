import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import { createPublicEmailFolder, serializeEmailFolder } from '@/lib/email/service';

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole('agent');
    const body = await request.json().catch(() => ({}));
    if (typeof body?.mailbox_id !== 'string') {
      return NextResponse.json({ error: 'mailbox_id is required.' }, { status: 400 });
    }
    const folder = await createPublicEmailFolder({
      accountId: ctx.accountId,
      userId: ctx.userId,
      role: ctx.role,
      mailboxId: body.mailbox_id,
      name: String(body.name ?? ''),
    });
    return NextResponse.json({ folder: serializeEmailFolder(folder) });
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
