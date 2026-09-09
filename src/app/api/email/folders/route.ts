import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import { createGlobalEmailFolder, serializeEmailFolder } from '@/lib/email/service';

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole('agent');
    const body = await request.json().catch(() => ({}));
    const folder = await createGlobalEmailFolder({
      accountId: ctx.accountId,
      userId: ctx.userId,
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
