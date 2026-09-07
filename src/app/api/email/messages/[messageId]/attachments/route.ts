import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import { listEmailAttachmentsForUser } from '@/lib/email/service';

export async function GET(
  _request: Request,
  context: { params: Promise<{ messageId: string }> },
) {
  try {
    const ctx = await requireDbRole('viewer');
    const { messageId } = await context.params;
    const attachments = await listEmailAttachmentsForUser({
      accountId: ctx.accountId,
      userId: ctx.userId,
      role: ctx.role,
      messageId,
    });
    return NextResponse.json({ attachments });
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
