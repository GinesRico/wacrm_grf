import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import {
  getEmailAttachmentDownloadForUser,
  getEmailAttachmentFileForUser,
} from '@/lib/email/service';

export async function GET(
  request: Request,
  context: { params: Promise<{ attachmentId: string }> },
) {
  try {
    const ctx = await requireDbRole('viewer');
    const { attachmentId } = await context.params;
    const url = new URL(request.url);
    const isDownload = url.searchParams.get('download') === '1';
    if (url.searchParams.get('raw') === '1' || isDownload) {
      const attachment = await getEmailAttachmentFileForUser({
        accountId: ctx.accountId,
        userId: ctx.userId,
        role: ctx.role,
        attachmentId,
      });
      const body = new ArrayBuffer(attachment.bytes.byteLength);
      new Uint8Array(body).set(attachment.bytes);
      return new Response(body, {
        headers: {
          'Content-Type': attachment.content_type || 'application/octet-stream',
          'Content-Length': String(attachment.bytes.byteLength),
          'Content-Disposition': `${isDownload ? 'attachment' : 'inline'}; filename="${attachment.file_name.replaceAll('"', '')}"`,
          'Cache-Control': 'private, max-age=300',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
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
