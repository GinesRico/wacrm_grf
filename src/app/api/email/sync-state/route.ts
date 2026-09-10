import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import { getEmailSyncStateForUser } from '@/lib/email/service';

export async function GET() {
  try {
    const ctx = await requireDbRole('viewer');
    return NextResponse.json(
      await getEmailSyncStateForUser({
        accountId: ctx.accountId,
        userId: ctx.userId,
        role: ctx.role,
      }),
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
