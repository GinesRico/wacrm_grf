import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import {
  createEmailAccount,
  createEmailFolder,
  createGlobalEmailFolder,
  deleteEmailAccount,
  deleteEmailFolder,
  deleteEmailPermission,
  grantEmailPermission,
  grantEmailUserPermission,
  listEmailAdminState,
  updateEmailAccount,
  upsertEmailPermissionsBulk,
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

    if (action === 'update_account') {
      if (typeof body.email_account_id !== 'string') {
        return NextResponse.json({ error: 'email_account_id is required.' }, { status: 400 });
      }
      const account = await updateEmailAccount({
        accountId: ctx.accountId,
        userId: ctx.userId,
        emailAccountId: body.email_account_id,
        input: {
          label: typeof body.label === 'string' ? body.label : undefined,
          emailAddress: typeof body.email_address === 'string' ? body.email_address : undefined,
          imapHost: typeof body.imap_host === 'string' ? body.imap_host : undefined,
          imapPort: body.imap_port ? Number(body.imap_port) : undefined,
          imapSecure:
            typeof body.imap_secure === 'boolean' ? body.imap_secure : undefined,
          imapUser: typeof body.imap_user === 'string' ? body.imap_user : undefined,
          imapPassword:
            typeof body.imap_password === 'string' ? body.imap_password : undefined,
          smtpHost: typeof body.smtp_host === 'string' ? body.smtp_host : undefined,
          smtpPort: body.smtp_port ? Number(body.smtp_port) : undefined,
          smtpSecure:
            typeof body.smtp_secure === 'boolean' ? body.smtp_secure : undefined,
          smtpUser: typeof body.smtp_user === 'string' ? body.smtp_user : undefined,
          smtpPassword:
            typeof body.smtp_password === 'string' ? body.smtp_password : undefined,
          syncMailbox:
            typeof body.sync_mailbox === 'string' ? body.sync_mailbox : undefined,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
          mailboxKind:
            body.mailbox_kind === 'personal' || body.mailbox_kind === 'shared'
              ? body.mailbox_kind
              : undefined,
          ownerUserId:
            typeof body.owner_user_id === 'string' ? body.owner_user_id : undefined,
        },
      });
      return NextResponse.json({ account });
    }

    if (action === 'create_folder') {
      if (typeof body.mailbox_id !== 'string') {
        return NextResponse.json({ error: 'mailbox_id is required.' }, { status: 400 });
      }
      const folder = await createEmailFolder({
        accountId: ctx.accountId,
        userId: ctx.userId,
        mailboxId: body.mailbox_id,
        name: String(body.name ?? ''),
      });
      return NextResponse.json({ folder });
    }

    if (action === 'create_public_folder') {
      const folder = await createGlobalEmailFolder({
        accountId: ctx.accountId,
        userId: ctx.userId,
        name: String(body.name ?? ''),
      });
      return NextResponse.json({ folder });
    }

    if (action === 'delete_folder') {
      if (typeof body.folder_id !== 'string') {
        return NextResponse.json({ error: 'folder_id is required.' }, { status: 400 });
      }
      const folder = await deleteEmailFolder({
        accountId: ctx.accountId,
        userId: ctx.userId,
        folderId: body.folder_id,
      });
      return NextResponse.json({ folder });
    }

    if (action === 'delete_account') {
      if (typeof body.email_account_id !== 'string') {
        return NextResponse.json({ error: 'email_account_id is required.' }, { status: 400 });
      }
      const account = await deleteEmailAccount({
        accountId: ctx.accountId,
        userId: ctx.userId,
        emailAccountId: body.email_account_id,
      });
      return NextResponse.json({ account });
    }

    if (action === 'grant_permission') {
      if (typeof body.department_id !== 'string') {
        return NextResponse.json(
          { error: 'department_id is required.' },
          { status: 400 },
        );
      }
      const permission = await grantEmailPermission({
        accountId: ctx.accountId,
        userId: ctx.userId,
        departmentId: body.department_id,
        mailboxId: typeof body.mailbox_id === 'string' && body.mailbox_id ? body.mailbox_id : null,
        folderId: typeof body.folder_id === 'string' && body.folder_id ? body.folder_id : null,
        canRead: body.can_read !== false,
        canMove: body.can_move === true,
        canClassify: body.can_classify === true,
        canSend: body.can_send === true,
      });
      return NextResponse.json({ permission });
    }

    if (action === 'grant_user_permission') {
      if (typeof body.target_user_id !== 'string') {
        return NextResponse.json({ error: 'target_user_id is required.' }, { status: 400 });
      }
      const permission = await grantEmailUserPermission({
        accountId: ctx.accountId,
        actorUserId: ctx.userId,
        targetUserId: body.target_user_id,
        mailboxId: typeof body.mailbox_id === 'string' && body.mailbox_id ? body.mailbox_id : null,
        folderId: typeof body.folder_id === 'string' && body.folder_id ? body.folder_id : null,
        canRead: body.can_read !== false,
        canMove: body.can_move === true,
        canClassify: body.can_classify === true,
        canSend: body.can_send === true,
      });
      return NextResponse.json({ permission });
    }

    if (action === 'delete_permission') {
      if (typeof body.permission_id !== 'string') {
        return NextResponse.json({ error: 'permission_id is required.' }, { status: 400 });
      }
      const permission = await deleteEmailPermission({
        accountId: ctx.accountId,
        userId: ctx.userId,
        permissionId: body.permission_id,
        scope: body.scope === 'user' ? 'user' : 'department',
      });
      return NextResponse.json({ permission });
    }

    if (action === 'upsert_permissions_bulk') {
      const scope = body.scope === 'user' ? 'user' : 'department';
      const subjectIds = Array.isArray(body.subject_ids)
        ? body.subject_ids.filter((id: unknown): id is string => typeof id === 'string')
        : [];
      const targets = Array.isArray(body.targets)
        ? body.targets
            .filter((target: unknown): target is Record<string, unknown> => Boolean(target) && typeof target === 'object')
            .map((target: Record<string, unknown>) => ({
              mailboxId: typeof target.mailbox_id === 'string' && target.mailbox_id ? target.mailbox_id : null,
              folderId: typeof target.folder_id === 'string' && target.folder_id ? target.folder_id : null,
            }))
        : [];
      const result = await upsertEmailPermissionsBulk({
        accountId: ctx.accountId,
        actorUserId: ctx.userId,
        scope,
        subjectIds,
        targets,
        canRead: body.can_read === true,
        canMove: body.can_move === true,
        canClassify: body.can_classify === true,
        canSend: body.can_send === true,
      });
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: 'Invalid action.' }, { status: 400 });
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
