import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import { parseThunderbirdRules } from '@/lib/email/rules';
import { importThunderbirdRules } from '@/lib/email/service';

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole('admin');
    const body = await request.json().catch(() => ({}));
    if (typeof body?.mailbox_id !== 'string') {
      return NextResponse.json({ error: 'mailbox_id is required.' }, { status: 400 });
    }
    const source = typeof body?.source === 'string' ? body.source : '';
    const parsed = parseThunderbirdRules(source);
    const result = await importThunderbirdRules({
      accountId: ctx.accountId,
      mailboxId: body.mailbox_id,
      rules: parsed,
    });
    return NextResponse.json({
      imported: result.created.length,
      skipped_duplicates: result.skippedDuplicates,
      removed_duplicates: result.removedDuplicates,
      rules: result.created,
    });
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
