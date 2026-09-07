import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import {
  createEmailAccount,
  createEmailFolder,
  grantEmailPermission,
  listEmailAdminState,
} from '@/lib/email/service';

export async function GET() {
  try {
    const ctx = await requireDbRole('admin');
    return NextResponse.json(await listEmailAdminState(ctx.accountId));
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole('admin');
    const body = await request.json().catch(() => ({}));
    const action = body?.action;

    if (action === 'create_account') {
      const created = await createEmailAccount({
        accountId: ctx.accountId,
        userId: ctx.userId,
        input: {
          label: String(body.label ?? ''),
          emailAddress: String(body.email_address ?? ''),
          imapHost: String(body.imap_host ?? ''),
          imapPort: Number(body.imap_port ?? 993),
          imapSecure: body.imap_secure !== false,
          imapUser: String(body.imap_user ?? ''),
          imapPassword: String(body.imap_password ?? ''),
          smtpHost: String(body.smtp_host ?? ''),
          smtpPort: Number(body.smtp_port ?? 465),
          smtpSecure: body.smtp_secure !== false,
          smtpUser: String(body.smtp_user ?? ''),
          smtpPassword: String(body.smtp_password ?? ''),
          syncMailbox: String(body.sync_mailbox ?? 'INBOX'),
          mailboxKind: body.mailbox_kind === 'personal' ? 'personal' : 'shared',
          ownerUserId: typeof body.owner_user_id === 'string' ? body.owner_user_id : null,
        },
      });
      return NextResponse.json({
        mailbox: created.mailbox,
        folders: created.folders,
      });
    }

    if (action === 'create_folder') {
      if (typeof body.mailbox_id !== 'string') {
        return NextResponse.json({ error: 'mailbox_id is required.' }, { status: 400 });
      }
      const folder = await createEmailFolder({
        accountId: ctx.accountId,
        mailboxId: body.mailbox_id,
        name: String(body.name ?? ''),
      });
      return NextResponse.json({ folder });
    }

    if (action === 'grant_permission') {
      if (typeof body.department_id !== 'string' || typeof body.mailbox_id !== 'string') {
        return NextResponse.json(
          { error: 'department_id and mailbox_id are required.' },
          { status: 400 },
        );
      }
      const permission = await grantEmailPermission({
        accountId: ctx.accountId,
        departmentId: body.department_id,
        mailboxId: body.mailbox_id,
        folderId: typeof body.folder_id === 'string' && body.folder_id ? body.folder_id : null,
        canRead: body.can_read !== false,
        canMove: body.can_move === true,
        canClassify: body.can_classify === true,
        canSend: body.can_send === true,
      });
      return NextResponse.json({ permission });
    }

    return NextResponse.json({ error: 'Invalid action.' }, { status: 400 });
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
