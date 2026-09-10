import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import { exportUnreadFolderPdfAttachmentsForUser } from '@/lib/email/service';

export async function POST(
  _request: Request,
  context: { params: Promise<{ folderId: string }> },
) {
  try {
    const ctx = await requireDbRole('viewer');
    const { folderId } = await context.params;
    const result = await exportUnreadFolderPdfAttachmentsForUser({
      accountId: ctx.accountId,
      userId: ctx.userId,
      role: ctx.role,
      folderId,
    });

    if (!result) {
      return NextResponse.json({ error: 'No hay PDFs pendientes en esta carpeta' }, { status: 404 });
    }

    const body = new ArrayBuffer(result.bytes.byteLength);
    new Uint8Array(body).set(result.bytes);

    return new Response(body, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(result.bytes.byteLength),
        'Content-Disposition': `attachment; filename="${result.fileName.replaceAll('"', '')}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Email-Pdf-Attachments': String(result.attachmentCount),
        'X-Email-Pdf-Messages': String(result.messageCount),
      },
    });
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
