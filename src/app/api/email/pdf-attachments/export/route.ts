import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import { exportUnreadPdfAttachmentsForFolders } from '@/lib/email/service';

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole('viewer');
    const body = await request.json().catch(() => ({}));
    const folderIds = Array.isArray(body?.folder_ids)
      ? body.folder_ids.filter((item: unknown): item is string => typeof item === 'string')
      : [];

    const result = await exportUnreadPdfAttachmentsForFolders({
      accountId: ctx.accountId,
      userId: ctx.userId,
      role: ctx.role,
      folderIds,
    });

    if (!result) {
      return NextResponse.json({ error: 'No hay PDFs pendientes en estas carpetas' }, { status: 404 });
    }

    const bodyBytes = new ArrayBuffer(result.bytes.byteLength);
    new Uint8Array(bodyBytes).set(result.bytes);

    return new Response(bodyBytes, {
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
