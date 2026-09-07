import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import { getEmailAttachmentDownloadForUser } from '@/lib/email/service';

export async function GET(
  _request: Request,
  context: { params: Promise<{ attachmentId: string }> },
) {
  try {
    const ctx = await requireDbRole('viewer');
    const { attachmentId } = await context.params;
    const attachment = await getEmailAttachmentDownloadForUser({
      accountId: ctx.accountId,
      userId: ctx.userId,
      role: ctx.role,
      attachmentId,
    });
    return NextResponse.json(attachment);
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
