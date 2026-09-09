import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';

import { db } from '@/db/client';
import {
  departments,
  emailAccounts,
  emailAttachments,
  emailAuditEvents,
  emailDrafts,
  emailFolders,
  emailLabels,
  emailMailboxes,
  emailMessageLabels,
  emailMessages,
  emailPermissions,
  emailRules,
  emailUserPermissions,
  profiles,
} from '@/db/schema';
import { getObjectBytes, putObject, signedObjectUrl } from '@/lib/storage/alarik';
import { decryptEmailCredentials, encryptEmailCredentials } from './credentials';
import { resolveEmailPermission } from './permissions';
import { resolveRuleTargetFolder } from './rules';
import type { AccountRole } from '@/lib/auth/roles';
import type { CreateEmailAccountInput, ThunderbirdRuleInput } from './types';

const DEFAULT_FOLDERS = [
  { name: 'Entrada', slug: 'inbox', kind: 'inbox', position: 0 },
  { name: 'Enviados', slug: 'sent', kind: 'sent', position: 10 },
  { name: 'Archivo', slug: 'archive', kind: 'archive', position: 20 },
  { name: 'Papelera', slug: 'trash', kind: 'trash', position: 30 },
] as const;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'carpeta';
}

function addressList(input?: AddressObject | AddressObject[] | null): string[] {
  const list = Array.isArray(input) ? input : input ? [input] : [];
  return list.flatMap((item) => item.value.map((address) => address.address).filter(Boolean) as string[]);
}

function firstAddress(input?: AddressObject | AddressObject[] | null) {
  const first = addressList(input)[0];
  const source = Array.isArray(input) ? input[0] : input;
  return {
    address: first ?? 'unknown@example.invalid',
    name: source?.value[0]?.name || null,
  };
}

function snippet(parsed: ParsedMail): string | null {
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  const text = (parsed.text ?? html).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 240) : null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function serializeDate(value: Date | null | undefined) {
  return value?.toISOString() ?? null;
}

export function serializeEmailMessage(row: typeof emailMessages.$inferSelect, extras?: { isReplied?: boolean } | number) {
  const flags = typeof extras === 'object' ? extras : undefined;
  return {
    id: row.id,
    account_id: row.accountId,
    mailbox_id: row.mailboxId,
    folder_id: row.folderId,
    subject: row.subject,
    from_name: row.fromName,
    from_address: row.fromAddress,
    to_addresses: row.toAddresses,
    cc_addresses: row.ccAddresses,
    received_at: row.receivedAt.toISOString(),
    sent_at: serializeDate(row.sentAt),
    snippet: row.snippet,
    body_text: row.bodyText,
    body_html: row.bodyHtml,
    is_read: row.isRead,
    is_starred: row.isStarred,
    is_replied: flags?.isReplied ?? false,
    has_attachments: row.hasAttachments,
    raw_size: row.rawSize,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function serializeEmailMailbox(row: typeof emailMailboxes.$inferSelect) {
  return {
    id: row.id,
    account_id: row.accountId,
    email_account_id: row.emailAccountId,
    owner_user_id: row.ownerUserId,
    address: row.address,
    display_name: row.displayName,
    kind: row.kind,
    can_send: row.canSend,
    is_default: row.isDefault,
  };
}

export function serializeEmailFolder(row: typeof emailFolders.$inferSelect) {
  return {
    id: row.id,
    account_id: row.accountId,
    mailbox_id: row.mailboxId,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    position: row.position,
  };
}

function serializeEmailPermission(row: typeof emailPermissions.$inferSelect) {
  return {
    id: row.id,
    department_id: row.departmentId,
    mailbox_id: row.mailboxId,
    folder_id: row.folderId,
    can_read: row.canRead,
    can_move: row.canMove,
    can_classify: row.canClassify,
    can_send: row.canSend,
  };
}

function serializeEmailUserPermission(row: typeof emailUserPermissions.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    mailbox_id: row.mailboxId,
    folder_id: row.folderId,
    can_read: row.canRead,
    can_move: row.canMove,
    can_classify: row.canClassify,
    can_send: row.canSend,
  };
}

async function assertUserInAccount(accountId: string, userId: string) {
  const [user] = await db
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(and(eq(profiles.accountId, accountId), eq(profiles.userId, userId)))
    .limit(1);
  if (!user) throw new Error('User is not part of this account.');
}

async function assertDepartmentInAccount(accountId: string, departmentId: string) {
  const [department] = await db
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.accountId, accountId), eq(departments.id, departmentId)))
    .limit(1);
  if (!department) throw new Error('Department is not part of this account.');
}

async function assertEmailPermissionTarget(
  accountId: string,
  mailboxId: string | null,
  folderId: string | null,
) {
  if (!mailboxId && !folderId) throw new Error('Choose a mailbox or folder target.');
  if (mailboxId) {
    const [mailbox] = await db
      .select({ id: emailMailboxes.id })
      .from(emailMailboxes)
      .where(and(eq(emailMailboxes.accountId, accountId), eq(emailMailboxes.id, mailboxId)))
      .limit(1);
    if (!mailbox) throw new Error('Mailbox not found.');
  }
  if (folderId) {
    const [folder] = await db
      .select({ id: emailFolders.id, mailboxId: emailFolders.mailboxId })
      .from(emailFolders)
      .where(and(eq(emailFolders.accountId, accountId), eq(emailFolders.id, folderId)))
      .limit(1);
    if (!folder) throw new Error('Folder not found.');
    if (mailboxId && folder.mailboxId && folder.mailboxId !== mailboxId) {
      throw new Error('Folder does not belong to the selected mailbox.');
    }
  }
}

export function serializeEmailAttachment(row: typeof emailAttachments.$inferSelect) {
  return {
    id: row.id,
    account_id: row.accountId,
    message_id: row.messageId,
    file_name: row.fileName,
    content_type: row.contentType,
    size: row.size,
    content_id: row.contentId,
    created_at: row.createdAt.toISOString(),
  };
}

export function serializeEmailLabel(row: typeof emailLabels.$inferSelect) {
  return {
    id: row.id,
    account_id: row.accountId,
    mailbox_id: row.mailboxId,
    name: row.name,
    color: row.color,
    position: row.position,
  };
}

export function serializeEmailDraft(row: typeof emailDrafts.$inferSelect) {
  return {
    id: row.id,
    account_id: row.accountId,
    user_id: row.userId,
    mailbox_id: row.mailboxId,
    to_addresses: row.toAddresses,
    cc_addresses: row.ccAddresses,
    bcc_addresses: row.bccAddresses,
    subject: row.subject,
    body_text: row.bodyText,
    body_html: row.bodyHtml,
    attachments: row.attachments,
    in_reply_to_message_id: row.inReplyToMessageId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function createEmailAccount(args: {
  accountId: string;
  userId: string;
  input: CreateEmailAccountInput;
}) {
  const label = clean(args.input.label);
  const emailAddress = normalizeEmail(args.input.emailAddress);
  if (!label || !emailAddress) throw new Error('Label and email address are required.');
  if (!args.input.imapHost || !args.input.smtpHost) {
    throw new Error('IMAP and SMTP hosts are required.');
  }

  return db.transaction(async (tx) => {
    const [account] = await tx
      .insert(emailAccounts)
      .values({
        accountId: args.accountId,
        createdBy: args.userId,
        label,
        emailAddress,
        imapHost: args.input.imapHost.trim(),
        imapPort: args.input.imapPort || 993,
        imapSecure: args.input.imapSecure,
        smtpHost: args.input.smtpHost.trim(),
        smtpPort: args.input.smtpPort || 465,
        smtpSecure: args.input.smtpSecure,
        encryptedCredentials: encryptEmailCredentials(args.input),
        syncMailbox: args.input.syncMailbox.trim() || 'INBOX',
        enabled: true,
        status: 'active',
      })
      .returning();

    const [mailbox] = await tx
      .insert(emailMailboxes)
      .values({
        accountId: args.accountId,
        emailAccountId: account.id,
        ownerUserId: args.input.mailboxKind === 'personal' ? args.input.ownerUserId ?? args.userId : null,
        address: emailAddress,
        displayName: label,
        kind: args.input.mailboxKind,
        canSend: true,
        isDefault: false,
      })
      .returning();

    const createdFolders = await tx
      .insert(emailFolders)
      .values(
        DEFAULT_FOLDERS.map((folder) => ({
          accountId: args.accountId,
          mailboxId: mailbox.id,
          name: folder.name,
          slug: folder.slug,
          kind: folder.kind,
          position: folder.position,
        })),
      )
      .returning();

    await tx.insert(emailAuditEvents).values({
      accountId: args.accountId,
      userId: args.userId,
      mailboxId: mailbox.id,
      eventType: 'mailbox.created',
      metadata: { email_account_id: account.id, address: emailAddress },
    });

    return { account, mailbox, folders: createdFolders };
  });
}

export async function updateEmailAccount(args: {
  accountId: string;
  userId: string;
  emailAccountId: string;
  input: Partial<CreateEmailAccountInput> & {
    enabled?: boolean;
    label?: string;
    emailAddress?: string;
    imapHost?: string;
    imapPort?: number;
    imapSecure?: boolean;
    smtpHost?: string;
    smtpPort?: number;
    smtpSecure?: boolean;
    syncMailbox?: string;
  };
}) {
  const [existing] = await db
    .select()
    .from(emailAccounts)
    .where(
      and(
        eq(emailAccounts.accountId, args.accountId),
        eq(emailAccounts.id, args.emailAccountId),
      ),
    )
    .limit(1);
  if (!existing) throw new Error('Email account not found.');

  const existingCredentials = existing.encryptedCredentials as Record<string, unknown>;
  const hasNewCredentials =
    Boolean(clean(args.input.imapUser)) ||
    Boolean(clean(args.input.imapPassword)) ||
    Boolean(clean(args.input.smtpUser)) ||
    Boolean(clean(args.input.smtpPassword));
  const encryptedCredentials = hasNewCredentials
    ? encryptEmailCredentials({
        imapUser: clean(args.input.imapUser) || decryptEmailCredentials(existingCredentials).imap_user,
        imapPassword:
          clean(args.input.imapPassword) ||
          decryptEmailCredentials(existingCredentials).imap_password,
        smtpUser: clean(args.input.smtpUser) || decryptEmailCredentials(existingCredentials).smtp_user,
        smtpPassword:
          clean(args.input.smtpPassword) ||
          decryptEmailCredentials(existingCredentials).smtp_password,
      })
    : existingCredentials;

  return db.transaction(async (tx) => {
    const emailAddress = args.input.emailAddress
      ? normalizeEmail(args.input.emailAddress)
      : existing.emailAddress;
    const [account] = await tx
      .update(emailAccounts)
      .set({
        label: clean(args.input.label) || existing.label,
        emailAddress,
        imapHost: clean(args.input.imapHost) || existing.imapHost,
        imapPort: args.input.imapPort || existing.imapPort,
        imapSecure:
          typeof args.input.imapSecure === 'boolean'
            ? args.input.imapSecure
            : existing.imapSecure,
        smtpHost: clean(args.input.smtpHost) || existing.smtpHost,
        smtpPort: args.input.smtpPort || existing.smtpPort,
        smtpSecure:
          typeof args.input.smtpSecure === 'boolean'
            ? args.input.smtpSecure
            : existing.smtpSecure,
        syncMailbox: clean(args.input.syncMailbox) || existing.syncMailbox,
        encryptedCredentials,
        enabled:
          typeof args.input.enabled === 'boolean' ? args.input.enabled : existing.enabled,
        status:
          typeof args.input.enabled === 'boolean' && !args.input.enabled
            ? 'disabled'
            : existing.status === 'disabled'
              ? 'active'
              : existing.status,
        updatedAt: new Date(),
      })
      .where(eq(emailAccounts.id, existing.id))
      .returning();

    await tx
      .update(emailMailboxes)
      .set({
        address: emailAddress,
        displayName: clean(args.input.label) || undefined,
        kind: args.input.mailboxKind ?? undefined,
        ownerUserId:
          args.input.mailboxKind === 'shared'
            ? null
            : args.input.ownerUserId === undefined
              ? undefined
              : args.input.ownerUserId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(emailMailboxes.accountId, args.accountId),
          eq(emailMailboxes.emailAccountId, existing.id),
        ),
      );

    await tx.insert(emailAuditEvents).values({
      accountId: args.accountId,
      userId: args.userId,
      eventType: 'mailbox.updated',
      metadata: { email_account_id: existing.id, address: emailAddress },
    });

    return account;
  });
}

export async function listEmailAdminState(accountId: string) {
  const [
    accountRows,
    mailboxRows,
    folderRows,
    permissionRows,
    userPermissionRows,
    departmentRows,
    userRows,
    ruleRows,
    auditRows,
  ] = await Promise.all([
    db.select().from(emailAccounts).where(eq(emailAccounts.accountId, accountId)),
    db.select().from(emailMailboxes).where(eq(emailMailboxes.accountId, accountId)),
    db.select().from(emailFolders).where(eq(emailFolders.accountId, accountId)),
    db.select().from(emailPermissions).where(eq(emailPermissions.accountId, accountId)),
    db.select().from(emailUserPermissions).where(eq(emailUserPermissions.accountId, accountId)),
    db.select().from(departments).where(eq(departments.accountId, accountId)).orderBy(asc(departments.name)),
    db
      .select({
        userId: profiles.userId,
        fullName: profiles.fullName,
        email: profiles.email,
        accountRole: profiles.accountRole,
      })
      .from(profiles)
      .where(eq(profiles.accountId, accountId))
      .orderBy(asc(profiles.fullName), asc(profiles.email)),
    db.select().from(emailRules).where(eq(emailRules.accountId, accountId)).orderBy(asc(emailRules.position)),
    db
      .select()
      .from(emailAuditEvents)
      .where(eq(emailAuditEvents.accountId, accountId))
      .orderBy(desc(emailAuditEvents.createdAt))
      .limit(50),
  ]);

  return {
    accounts: accountRows.map((row) => ({
      id: row.id,
      label: row.label,
      email_address: row.emailAddress,
      imap_host: row.imapHost,
      imap_port: row.imapPort,
      imap_secure: row.imapSecure,
      smtp_host: row.smtpHost,
      smtp_port: row.smtpPort,
      smtp_secure: row.smtpSecure,
      sync_mailbox: row.syncMailbox,
      enabled: row.enabled,
      status: row.status,
      last_error: row.lastError,
      last_synced_at: serializeDate(row.lastSyncedAt),
    })),
    mailboxes: mailboxRows.map(serializeEmailMailbox),
    folders: folderRows.map(serializeEmailFolder),
    permissions: permissionRows.map(serializeEmailPermission),
    user_permissions: userPermissionRows.map(serializeEmailUserPermission),
    departments: departmentRows,
    users: userRows.map((row) => ({
      user_id: row.userId,
      full_name: row.fullName,
      email: row.email,
      role: row.accountRole,
    })),
    rules: ruleRows.map((row) => ({
      id: row.id,
      mailbox_id: row.mailboxId,
      target_folder_id: row.targetFolderId,
      name: row.name,
      field: row.field,
      operator: row.operator,
      value: row.value,
      enabled: row.enabled,
      position: row.position,
    })),
    audit_events: auditRows.map((row) => ({
      id: row.id,
      user_id: row.userId,
      mailbox_id: row.mailboxId,
      folder_id: row.folderId,
      message_id: row.messageId,
      event_type: row.eventType,
      metadata: row.metadata,
      created_at: row.createdAt.toISOString(),
    })),
  };
}

export async function grantEmailPermission(args: {
  accountId: string;
  userId?: string;
  departmentId: string;
  mailboxId?: string | null;
  folderId?: string | null;
  canRead: boolean;
  canMove: boolean;
  canClassify: boolean;
  canSend: boolean;
}) {
  await assertDepartmentInAccount(args.accountId, args.departmentId);
  await assertEmailPermissionTarget(args.accountId, args.mailboxId ?? null, args.folderId ?? null);
  const row = await db.transaction(async (tx) => {
    await tx
      .delete(emailPermissions)
      .where(
        and(
          eq(emailPermissions.accountId, args.accountId),
          eq(emailPermissions.departmentId, args.departmentId),
          args.mailboxId ? eq(emailPermissions.mailboxId, args.mailboxId) : isNull(emailPermissions.mailboxId),
          args.folderId ? eq(emailPermissions.folderId, args.folderId) : isNull(emailPermissions.folderId),
        ),
      );
    const [permission] = await tx
      .insert(emailPermissions)
      .values({
        accountId: args.accountId,
        departmentId: args.departmentId,
        mailboxId: args.mailboxId ?? null,
        folderId: args.folderId ?? null,
        canRead: args.canRead,
        canMove: args.canMove,
        canClassify: args.canClassify,
        canSend: args.canSend,
      })
      .returning();
    await tx.insert(emailAuditEvents).values({
      accountId: args.accountId,
      userId: args.userId ?? null,
      mailboxId: args.mailboxId ?? null,
      folderId: args.folderId ?? null,
      eventType: 'permission.updated',
      metadata: { scope: 'department', department_id: args.departmentId },
    });
    return permission;
  });
  return row;
}

export async function grantEmailUserPermission(args: {
  accountId: string;
  actorUserId: string;
  targetUserId: string;
  mailboxId?: string | null;
  folderId?: string | null;
  canRead: boolean;
  canMove: boolean;
  canClassify: boolean;
  canSend: boolean;
}) {
  await assertUserInAccount(args.accountId, args.targetUserId);
  await assertEmailPermissionTarget(args.accountId, args.mailboxId ?? null, args.folderId ?? null);
  return db.transaction(async (tx) => {
    await tx
      .delete(emailUserPermissions)
      .where(
        and(
          eq(emailUserPermissions.accountId, args.accountId),
          eq(emailUserPermissions.userId, args.targetUserId),
          args.mailboxId
            ? eq(emailUserPermissions.mailboxId, args.mailboxId)
            : isNull(emailUserPermissions.mailboxId),
          args.folderId
            ? eq(emailUserPermissions.folderId, args.folderId)
            : isNull(emailUserPermissions.folderId),
        ),
      );
    const [permission] = await tx
      .insert(emailUserPermissions)
      .values({
        accountId: args.accountId,
        userId: args.targetUserId,
        mailboxId: args.mailboxId ?? null,
        folderId: args.folderId ?? null,
        canRead: args.canRead,
        canMove: args.canMove,
        canClassify: args.canClassify,
        canSend: args.canSend,
      })
      .returning();
    await tx.insert(emailAuditEvents).values({
      accountId: args.accountId,
      userId: args.actorUserId,
      mailboxId: args.mailboxId ?? null,
      folderId: args.folderId ?? null,
      eventType: 'permission.updated',
      metadata: { scope: 'user', target_user_id: args.targetUserId },
    });
    return permission;
  });
}

export async function deleteEmailPermission(args: {
  accountId: string;
  userId: string;
  permissionId: string;
  scope: 'department' | 'user';
}) {
  if (args.scope === 'user') {
    const [deleted] = await db
      .delete(emailUserPermissions)
      .where(
        and(
          eq(emailUserPermissions.accountId, args.accountId),
          eq(emailUserPermissions.id, args.permissionId),
        ),
      )
      .returning();
    if (deleted) {
      await db.insert(emailAuditEvents).values({
        accountId: args.accountId,
        userId: args.userId,
        mailboxId: deleted.mailboxId,
        folderId: deleted.folderId,
        eventType: 'permission.revoked',
        metadata: { scope: 'user', target_user_id: deleted.userId },
      });
    }
    return deleted ?? null;
  }

  const [deleted] = await db
    .delete(emailPermissions)
    .where(
      and(
        eq(emailPermissions.accountId, args.accountId),
        eq(emailPermissions.id, args.permissionId),
      ),
    )
    .returning();
  if (deleted) {
    await db.insert(emailAuditEvents).values({
      accountId: args.accountId,
      userId: args.userId,
      mailboxId: deleted.mailboxId,
      folderId: deleted.folderId,
      eventType: 'permission.revoked',
      metadata: { scope: 'department', department_id: deleted.departmentId },
    });
  }
  return deleted ?? null;
}

export async function createEmailFolder(args: {
  accountId: string;
  mailboxId: string;
  name: string;
  userId?: string;
}) {
  const name = clean(args.name);
  if (!name) throw new Error('Folder name is required.');
  await assertEmailPermissionTarget(args.accountId, args.mailboxId, null);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(emailFolders)
      .values({
        accountId: args.accountId,
        mailboxId: args.mailboxId,
        name,
        slug: slugify(name),
        kind: 'custom',
      })
      .returning();
    await tx.insert(emailAuditEvents).values({
      accountId: args.accountId,
      userId: args.userId ?? null,
      mailboxId: args.mailboxId,
      folderId: row.id,
      eventType: 'folder.created',
      metadata: { name: row.name, visibility: 'mailbox' },
    });
    return row;
  });
}

export async function createGlobalEmailFolder(args: {
  accountId: string;
  userId: string;
  name: string;
}) {
  const name = clean(args.name);
  if (!name) throw new Error('Folder name is required.');
  const [folder] = await db
    .insert(emailFolders)
    .values({
      accountId: args.accountId,
      mailboxId: null,
      name,
      slug: slugify(name),
      kind: 'public',
      position: 100,
    })
    .returning();
  await db.insert(emailAuditEvents).values({
    accountId: args.accountId,
    userId: args.userId,
    folderId: folder.id,
    eventType: 'folder.created',
    metadata: { name: folder.name, visibility: 'public' },
  });
  return folder;
}

export async function deleteEmailFolder(args: {
  accountId: string;
  userId: string;
  folderId: string;
}) {
  const [folder] = await db
    .select()
    .from(emailFolders)
    .where(and(eq(emailFolders.accountId, args.accountId), eq(emailFolders.id, args.folderId)))
    .limit(1);
  if (!folder) throw new Error('Folder not found.');
  if (folder.kind !== 'custom' && folder.kind !== 'public') {
    throw new Error('System folders cannot be deleted.');
  }

  await db.transaction(async (tx) => {
    if (folder.mailboxId) {
      const [inboxFolder] = await tx
        .select({ id: emailFolders.id })
        .from(emailFolders)
        .where(
          and(
            eq(emailFolders.accountId, args.accountId),
            eq(emailFolders.mailboxId, folder.mailboxId),
            eq(emailFolders.kind, 'inbox'),
          ),
        )
        .limit(1);
      if (!inboxFolder) throw new Error('Inbox folder is missing.');
      await tx
        .update(emailMessages)
        .set({ folderId: inboxFolder.id, updatedAt: new Date() })
        .where(and(eq(emailMessages.accountId, args.accountId), eq(emailMessages.folderId, folder.id)));
    } else {
      const affected = await tx
        .selectDistinct({ mailboxId: emailMessages.mailboxId })
        .from(emailMessages)
        .where(and(eq(emailMessages.accountId, args.accountId), eq(emailMessages.folderId, folder.id)));
      for (const row of affected) {
        const [inboxFolder] = await tx
          .select({ id: emailFolders.id })
          .from(emailFolders)
          .where(
            and(
              eq(emailFolders.accountId, args.accountId),
              eq(emailFolders.mailboxId, row.mailboxId),
              eq(emailFolders.kind, 'inbox'),
            ),
          )
          .limit(1);
        if (inboxFolder) {
          await tx
            .update(emailMessages)
            .set({ folderId: inboxFolder.id, updatedAt: new Date() })
            .where(
              and(
                eq(emailMessages.accountId, args.accountId),
                eq(emailMessages.folderId, folder.id),
                eq(emailMessages.mailboxId, row.mailboxId),
              ),
            );
        }
      }
    }

    await tx
      .delete(emailFolders)
      .where(and(eq(emailFolders.accountId, args.accountId), eq(emailFolders.id, folder.id)));
    await tx.insert(emailAuditEvents).values({
      accountId: args.accountId,
      userId: args.userId,
      mailboxId: folder.mailboxId,
      folderId: folder.id,
      eventType: 'folder.deleted',
      metadata: { name: folder.name, moved_messages_to: 'inbox' },
    });
  });
  return folder;
}

export async function deleteEmailAccount(args: {
  accountId: string;
  userId: string;
  emailAccountId: string;
}) {
  const [account] = await db
    .select()
    .from(emailAccounts)
    .where(and(eq(emailAccounts.accountId, args.accountId), eq(emailAccounts.id, args.emailAccountId)))
    .limit(1);
  if (!account) throw new Error('Email account not found.');
  const [mailbox] = await db
    .select()
    .from(emailMailboxes)
    .where(and(eq(emailMailboxes.accountId, args.accountId), eq(emailMailboxes.emailAccountId, account.id)))
    .limit(1);

  await db.transaction(async (tx) => {
    await tx.insert(emailAuditEvents).values({
      accountId: args.accountId,
      userId: args.userId,
      mailboxId: mailbox?.id ?? null,
      eventType: 'mailbox.deleted',
      metadata: { email_account_id: account.id, address: account.emailAddress },
    });
    await tx
      .delete(emailAccounts)
      .where(and(eq(emailAccounts.accountId, args.accountId), eq(emailAccounts.id, account.id)));
  });
  return account;
}

export async function createPublicEmailFolder(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  mailboxId: string;
  name: string;
}) {
  const permission = await resolveEmailPermission({
    accountId: args.accountId,
    userId: args.userId,
    role: args.role,
    mailboxId: args.mailboxId,
  });
  if (!permission.canRead) {
    throw new Error('You do not have permission to create folders in this mailbox.');
  }
  const folder = await createEmailFolder(args);
  await db.insert(emailAuditEvents).values({
    accountId: args.accountId,
    userId: args.userId,
    mailboxId: args.mailboxId,
    folderId: folder.id,
    eventType: 'folder.created',
    metadata: { name: folder.name, visibility: 'public' },
  });
  return folder;
}

export async function listEmailWorkspace(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
}) {
  const { listAccessibleMailboxes, listAccessibleFolders } = await import('./permissions');
  const mailboxes = await listAccessibleMailboxes(args);
  const folders = await listAccessibleFolders({
    ...args,
    mailboxIds: mailboxes.map((mailbox) => mailbox.id),
  });
  return {
    mailboxes: mailboxes.map(serializeEmailMailbox),
    folders: folders.map(serializeEmailFolder),
  };
}

export async function listEmailRulesForUser(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  mailboxId?: string | null;
}) {
  const workspace = await listEmailWorkspace(args);
  const mailboxIds = workspace.mailboxes.map((mailbox) => mailbox.id);
  if (mailboxIds.length === 0) return { rules: [], ...workspace };
  const effectiveMailboxIds =
    args.mailboxId && mailboxIds.includes(args.mailboxId)
      ? [args.mailboxId]
      : mailboxIds;
  const rows = await db
    .select()
    .from(emailRules)
    .where(
      and(
        eq(emailRules.accountId, args.accountId),
        inArray(emailRules.mailboxId, effectiveMailboxIds),
      ),
    )
    .orderBy(asc(emailRules.position), asc(emailRules.name));
  return { rules: rows, ...workspace };
}

export async function createEmailRule(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  mailboxId: string;
  targetFolderId: string;
  name: string;
  field: string;
  operator: string;
  value: string;
}) {
  const permission = await resolveEmailPermission({
    accountId: args.accountId,
    userId: args.userId,
    role: args.role,
    mailboxId: args.mailboxId,
    folderId: args.targetFolderId,
  });
  if (!permission.canClassify) {
    throw new Error('You do not have permission to create rules for this mailbox.');
  }
  const [rule] = await db
    .insert(emailRules)
    .values({
      accountId: args.accountId,
      mailboxId: args.mailboxId,
      targetFolderId: args.targetFolderId,
      name: clean(args.name) || 'Regla',
      field: args.field,
      operator: args.operator,
      value: clean(args.value),
      enabled: true,
      position: 0,
    })
    .returning();
  await db.insert(emailAuditEvents).values({
    accountId: args.accountId,
    userId: args.userId,
    mailboxId: args.mailboxId,
    folderId: args.targetFolderId,
    eventType: 'rule.created',
    metadata: { rule_id: rule.id, name: rule.name },
  });
  return rule;
}

export async function updateEmailRuleForUser(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  ruleId: string;
  targetFolderId: string;
  name: string;
  field: string;
  operator: string;
  value: string;
  enabled: boolean;
}) {
  const [existing] = await db
    .select()
    .from(emailRules)
    .where(and(eq(emailRules.accountId, args.accountId), eq(emailRules.id, args.ruleId)))
    .limit(1);
  if (!existing?.mailboxId) throw new Error('Rule not found.');

  const permission = await resolveEmailPermission({
    accountId: args.accountId,
    userId: args.userId,
    role: args.role,
    mailboxId: existing.mailboxId,
    folderId: args.targetFolderId,
  });
  if (!permission.canClassify) {
    throw new Error('You do not have permission to update rules for this mailbox.');
  }

  const [rule] = await db
    .update(emailRules)
    .set({
      targetFolderId: args.targetFolderId,
      name: clean(args.name) || existing.name,
      field: args.field,
      operator: args.operator,
      value: clean(args.value),
      enabled: args.enabled,
      updatedAt: new Date(),
    })
    .where(and(eq(emailRules.accountId, args.accountId), eq(emailRules.id, args.ruleId)))
    .returning();

  await db.insert(emailAuditEvents).values({
    accountId: args.accountId,
    userId: args.userId,
    mailboxId: existing.mailboxId,
    folderId: args.targetFolderId,
    eventType: 'rule.updated',
    metadata: { rule_id: rule.id, name: rule.name },
  });

  return rule;
}

export async function deleteEmailRuleForUser(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  ruleId: string;
}) {
  const [existing] = await db
    .select()
    .from(emailRules)
    .where(and(eq(emailRules.accountId, args.accountId), eq(emailRules.id, args.ruleId)))
    .limit(1);
  if (!existing?.mailboxId) throw new Error('Rule not found.');

  const permission = await resolveEmailPermission({
    accountId: args.accountId,
    userId: args.userId,
    role: args.role,
    mailboxId: existing.mailboxId,
    folderId: existing.targetFolderId,
  });
  if (!permission.canClassify) {
    throw new Error('You do not have permission to delete rules for this mailbox.');
  }

  const [deleted] = await db
    .delete(emailRules)
    .where(and(eq(emailRules.accountId, args.accountId), eq(emailRules.id, args.ruleId)))
    .returning();

  await db.insert(emailAuditEvents).values({
    accountId: args.accountId,
    userId: args.userId,
    mailboxId: existing.mailboxId,
    folderId: existing.targetFolderId,
    eventType: 'rule.deleted',
    metadata: { rule_id: existing.id, name: existing.name },
  });

  return deleted;
}

export async function applyEmailRuleToMessage(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  messageId: string;
  ruleId: string;
}) {
  const current = await getEmailMessageForUser(args);
  if (!current) throw new Error('Message not found or not permitted.');
  if (!current.permission.canClassify && !current.permission.canMove) {
    throw new Error('You do not have permission to classify this email.');
  }
  const [rule] = await db
    .select()
    .from(emailRules)
    .where(
      and(
        eq(emailRules.accountId, args.accountId),
        eq(emailRules.id, args.ruleId),
        eq(emailRules.mailboxId, current.message.mailboxId),
      ),
    )
    .limit(1);
  if (!rule) throw new Error('Rule not found for this mailbox.');

  const [targetFolder] = await db
    .select()
    .from(emailFolders)
    .where(
      and(
        eq(emailFolders.accountId, args.accountId),
        eq(emailFolders.id, rule.targetFolderId),
        eq(emailFolders.mailboxId, current.message.mailboxId),
      ),
    )
    .limit(1);
  if (!targetFolder) throw new Error('Rule target folder not found.');

  const [updated] = await db
    .update(emailMessages)
    .set({ folderId: targetFolder.id, updatedAt: new Date() })
    .where(
      and(
        eq(emailMessages.accountId, args.accountId),
        eq(emailMessages.id, args.messageId),
      ),
    )
    .returning();

  await db.insert(emailAuditEvents).values({
    accountId: args.accountId,
    userId: args.userId,
    mailboxId: updated.mailboxId,
    folderId: targetFolder.id,
    messageId: updated.id,
    eventType: 'rule.applied',
    metadata: { rule_id: rule.id, rule_name: rule.name },
  });
  return updated;
}

export async function listEmailMessages(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  mailboxId?: string | null;
  folderId?: string | null;
  q?: string | null;
  unread?: boolean;
  attachments?: boolean;
  starred?: boolean;
  labelId?: string | null;
  from?: string | null;
  to?: string | null;
  sort?: string | null;
}) {
  const workspace = await listEmailWorkspace(args);
  const allowedMailboxIds = workspace.mailboxes.map((mailbox) => mailbox.id);
  const allowedFolderIds = workspace.folders.map((folder) => folder.id);
  if (allowedFolderIds.length === 0) {
    return { messages: [], ...workspace };
  }

  const folderId =
    args.folderId && allowedFolderIds.includes(args.folderId) ? args.folderId : null;
  const selectedFolder = folderId
    ? workspace.folders.find((folder) => folder.id === folderId) ?? null
    : null;
  const mailboxId =
    selectedFolder?.mailbox_id ??
    (args.mailboxId && allowedMailboxIds.includes(args.mailboxId)
      ? args.mailboxId
      : allowedMailboxIds[0] ?? null);

  if (!selectedFolder && !mailboxId) {
    return { messages: [], ...workspace };
  }

  const q = clean(args.q);
  const from = clean(args.from);
  const to = clean(args.to);

  const filters = [
    eq(emailMessages.accountId, args.accountId),
    mailboxId ? inArray(emailMessages.mailboxId, [mailboxId]) : undefined,
    folderId ? eq(emailMessages.folderId, folderId) : inArray(emailMessages.folderId, allowedFolderIds),
    q
      ? or(
          ilike(emailMessages.subject, `%${q}%`),
          ilike(emailMessages.fromAddress, `%${q}%`),
          ilike(emailMessages.bodyText, `%${q}%`),
        )
      : undefined,
    args.unread ? eq(emailMessages.isRead, false) : undefined,
    args.attachments ? eq(emailMessages.hasAttachments, true) : undefined,
    args.starred ? eq(emailMessages.isStarred, true) : undefined,
    from ? ilike(emailMessages.fromAddress, `%${from}%`) : undefined,
    to ? sql`${emailMessages.toAddresses}::text ilike ${`%${to}%`}` : undefined,
  ];

  const orderBy = args.sort === 'oldest'
    ? asc(emailMessages.receivedAt)
    : args.sort === 'sender'
      ? asc(emailMessages.fromAddress)
      : args.sort === 'subject_asc'
        ? asc(emailMessages.subject)
        : args.sort === 'subject_desc'
          ? desc(emailMessages.subject)
      : args.sort === 'size_desc'
        ? desc(emailMessages.rawSize)
        : args.sort === 'size_asc'
          ? asc(emailMessages.rawSize)
      : desc(emailMessages.receivedAt);

  const rows = await db
    .select()
    .from(emailMessages)
    .where(and(...filters))
    .orderBy(orderBy)
    .limit(200);

  let labelRows: Array<{
    messageId: string;
    label: ReturnType<typeof serializeEmailLabel>;
  }> = [];
  if (rows.length > 0) {
    const joined = await db
      .select({
        messageId: emailMessageLabels.messageId,
        label: emailLabels,
      })
      .from(emailMessageLabels)
      .innerJoin(emailLabels, eq(emailLabels.id, emailMessageLabels.labelId))
      .where(
        and(
          eq(emailMessageLabels.accountId, args.accountId),
          inArray(emailMessageLabels.messageId, rows.map((row) => row.id)),
          args.labelId ? eq(emailLabels.id, args.labelId) : undefined,
        ),
      );
    labelRows = joined.map((row) => ({
      messageId: row.messageId,
      label: serializeEmailLabel(row.label),
    }));
  }

  const labelsByMessage = new Map<string, ReturnType<typeof serializeEmailLabel>[]>();
  for (const row of labelRows) {
    labelsByMessage.set(row.messageId, [
      ...(labelsByMessage.get(row.messageId) ?? []),
      row.label,
    ]);
  }

  const filteredRows = args.labelId
    ? rows.filter((row) => labelsByMessage.has(row.id))
    : rows;
  const repliedMessageIds = new Set<string>();
  if (filteredRows.length > 0) {
    const repliedRows = await db
      .select({ threadKey: emailMessages.threadKey })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.accountId, args.accountId),
          inArray(emailMessages.threadKey, filteredRows.map((row) => row.id)),
          isNotNull(emailMessages.sentAt),
        ),
      );
    for (const row of repliedRows) {
      if (row.threadKey) repliedMessageIds.add(row.threadKey);
    }
  }

  return {
    messages: filteredRows.map((row) => ({
      ...serializeEmailMessage(row, { isReplied: repliedMessageIds.has(row.id) }),
      labels: labelsByMessage.get(row.id) ?? [],
    })),
    ...workspace,
  };
}

export async function getEmailMessageForUser(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  messageId: string;
}) {
  const [message] = await db
    .select()
    .from(emailMessages)
    .where(and(eq(emailMessages.accountId, args.accountId), eq(emailMessages.id, args.messageId)))
    .limit(1);
  if (!message) return null;
  const permission = await resolveEmailPermission({
    accountId: args.accountId,
    userId: args.userId,
    role: args.role,
    mailboxId: message.mailboxId,
    folderId: message.folderId,
  });
  if (!permission.canRead) return null;
  return { message, permission };
}

export async function updateEmailMessageState(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  messageId: string;
  isRead?: boolean;
  isStarred?: boolean;
  folderId?: string;
}) {
  const current = await getEmailMessageForUser(args);
  if (!current) throw new Error('Message not found or not permitted.');
  if (args.folderId && !current.permission.canMove) {
    throw new Error('You do not have permission to move this email.');
  }

  const [updated] = await db
    .update(emailMessages)
    .set({
      isRead: typeof args.isRead === 'boolean' ? args.isRead : current.message.isRead,
      isStarred: typeof args.isStarred === 'boolean' ? args.isStarred : current.message.isStarred,
      folderId: args.folderId ?? current.message.folderId,
      updatedAt: new Date(),
    })
    .where(and(eq(emailMessages.id, args.messageId), eq(emailMessages.accountId, args.accountId)))
    .returning();

  await db.insert(emailAuditEvents).values({
    accountId: args.accountId,
    userId: args.userId,
    mailboxId: updated.mailboxId,
    folderId: updated.folderId,
    messageId: updated.id,
    eventType: args.folderId
      ? 'message.moved'
      : typeof args.isStarred === 'boolean'
        ? 'message.starred_changed'
        : 'message.read_state_changed',
    metadata: {
      is_read: updated.isRead,
      is_starred: updated.isStarred,
      folder_id: updated.folderId,
    },
  });

  return updated;
}

export async function updateEmailMessagesBatch(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  messageIds: string[];
  isRead?: boolean;
  isStarred?: boolean;
  folderId?: string;
}) {
  const updated = [];
  for (const messageId of [...new Set(args.messageIds)].slice(0, 200)) {
    updated.push(
      await updateEmailMessageState({
        accountId: args.accountId,
        userId: args.userId,
        role: args.role,
        messageId,
        isRead: args.isRead,
        isStarred: args.isStarred,
        folderId: args.folderId,
      }),
    );
  }
  return updated;
}

export async function listEmailAttachmentsForUser(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  messageId: string;
}) {
  const current = await getEmailMessageForUser(args);
  if (!current) throw new Error('Message not found or not permitted.');

  const rows = await db
    .select()
    .from(emailAttachments)
    .where(
      and(
        eq(emailAttachments.accountId, args.accountId),
        eq(emailAttachments.messageId, args.messageId),
      ),
    )
    .orderBy(asc(emailAttachments.fileName));

  return rows.map(serializeEmailAttachment);
}

export async function getEmailAttachmentDownloadForUser(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  attachmentId: string;
}) {
  const [attachment] = await db
    .select()
    .from(emailAttachments)
    .where(
      and(
        eq(emailAttachments.accountId, args.accountId),
        eq(emailAttachments.id, args.attachmentId),
      ),
    )
    .limit(1);
  if (!attachment) throw new Error('Attachment not found.');

  const current = await getEmailMessageForUser({
    accountId: args.accountId,
    userId: args.userId,
    role: args.role,
    messageId: attachment.messageId,
  });
  if (!current) throw new Error('Message not found or not permitted.');

  return {
    ...serializeEmailAttachment(attachment),
    url: await signedObjectUrl(attachment.storageKey),
  };
}

export async function getEmailAttachmentFileForUser(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  attachmentId: string;
}) {
  const [attachment] = await db
    .select()
    .from(emailAttachments)
    .where(
      and(
        eq(emailAttachments.accountId, args.accountId),
        eq(emailAttachments.id, args.attachmentId),
      ),
    )
    .limit(1);
  if (!attachment) throw new Error('Attachment not found.');

  const current = await getEmailMessageForUser({
    accountId: args.accountId,
    userId: args.userId,
    role: args.role,
    messageId: attachment.messageId,
  });
  if (!current) throw new Error('Message not found or not permitted.');

  return {
    ...serializeEmailAttachment(attachment),
    bytes: await getObjectBytes(attachment.storageKey),
  };
}

export async function listEmailLabelsForUser(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  mailboxId?: string | null;
}) {
  const workspace = await listEmailWorkspace(args);
  const mailboxIds = workspace.mailboxes.map((mailbox) => mailbox.id);
  if (mailboxIds.length === 0) return [];
  const effectiveMailboxIds =
    args.mailboxId && mailboxIds.includes(args.mailboxId)
      ? [args.mailboxId]
      : mailboxIds;

  const rows = await db
    .select()
    .from(emailLabels)
    .where(
      and(
        eq(emailLabels.accountId, args.accountId),
        or(
          inArray(emailLabels.mailboxId, effectiveMailboxIds),
          sql`${emailLabels.mailboxId} is null`,
        ),
      ),
    )
    .orderBy(asc(emailLabels.position), asc(emailLabels.name));

  return rows.map(serializeEmailLabel);
}

export async function createEmailLabelForUser(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  mailboxId: string;
  name: string;
  color?: string;
}) {
  const permission = await resolveEmailPermission({
    accountId: args.accountId,
    userId: args.userId,
    role: args.role,
    mailboxId: args.mailboxId,
  });
  if (!permission.canClassify) {
    throw new Error('You do not have permission to create labels for this mailbox.');
  }

  const [label] = await db
    .insert(emailLabels)
    .values({
      accountId: args.accountId,
      mailboxId: args.mailboxId,
      createdBy: args.userId,
      name: clean(args.name) || 'Etiqueta',
      color: args.color || '#64748b',
    })
    .returning();

  await db.insert(emailAuditEvents).values({
    accountId: args.accountId,
    userId: args.userId,
    mailboxId: args.mailboxId,
    eventType: 'label.created',
    metadata: { label_id: label.id, name: label.name },
  });

  return label;
}

export async function setEmailMessageLabelsForUser(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  messageId: string;
  labelIds: string[];
}) {
  const current = await getEmailMessageForUser(args);
  if (!current) throw new Error('Message not found or not permitted.');
  if (!current.permission.canClassify) {
    throw new Error('You do not have permission to label this email.');
  }

  const requestedIds = [...new Set(args.labelIds)].slice(0, 20);
  const allowedLabels = requestedIds.length
    ? await db
        .select()
        .from(emailLabels)
        .where(
          and(
            eq(emailLabels.accountId, args.accountId),
            inArray(emailLabels.id, requestedIds),
            or(
              eq(emailLabels.mailboxId, current.message.mailboxId),
              sql`${emailLabels.mailboxId} is null`,
            ),
          ),
        )
    : [];

  await db.transaction(async (tx) => {
    await tx
      .delete(emailMessageLabels)
      .where(
        and(
          eq(emailMessageLabels.accountId, args.accountId),
          eq(emailMessageLabels.messageId, args.messageId),
        ),
      );

    if (allowedLabels.length > 0) {
      await tx.insert(emailMessageLabels).values(
        allowedLabels.map((label) => ({
          accountId: args.accountId,
          messageId: args.messageId,
          labelId: label.id,
        })),
      );
    }

    await tx.insert(emailAuditEvents).values({
      accountId: args.accountId,
      userId: args.userId,
      mailboxId: current.message.mailboxId,
      folderId: current.message.folderId,
      messageId: args.messageId,
      eventType: 'message.labels_changed',
      metadata: { label_ids: allowedLabels.map((label) => label.id) },
    });
  });

  return allowedLabels.map(serializeEmailLabel);
}

export async function listEmailDraftsForUser(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  mailboxId?: string | null;
}) {
  const workspace = await listEmailWorkspace(args);
  const mailboxIds = workspace.mailboxes
    .filter((mailbox) => !args.mailboxId || mailbox.id === args.mailboxId)
    .map((mailbox) => mailbox.id);
  if (mailboxIds.length === 0) return [];

  const rows = await db
    .select()
    .from(emailDrafts)
    .where(
      and(
        eq(emailDrafts.accountId, args.accountId),
        eq(emailDrafts.userId, args.userId),
        inArray(emailDrafts.mailboxId, mailboxIds),
      ),
    )
    .orderBy(desc(emailDrafts.updatedAt));

  return rows.map(serializeEmailDraft);
}

export async function upsertEmailDraftForUser(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  draftId?: string | null;
  mailboxId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string | null;
  attachments?: unknown;
  inReplyToMessageId?: string | null;
}) {
  const permission = await resolveEmailPermission({
    accountId: args.accountId,
    userId: args.userId,
    role: args.role,
    mailboxId: args.mailboxId,
  });
  if (!permission.canSend) {
    throw new Error('You do not have permission to draft from this mailbox.');
  }

  const values = {
    mailboxId: args.mailboxId,
    toAddresses: args.to,
    ccAddresses: args.cc ?? [],
    bccAddresses: args.bcc ?? [],
    subject: args.subject ?? '',
    bodyText: args.text ?? '',
    bodyHtml: args.html ?? null,
    attachments: Array.isArray(args.attachments) ? args.attachments : [],
    inReplyToMessageId: args.inReplyToMessageId ?? null,
    updatedAt: new Date(),
  };

  if (args.draftId) {
    const [draft] = await db
      .update(emailDrafts)
      .set(values)
      .where(
        and(
          eq(emailDrafts.accountId, args.accountId),
          eq(emailDrafts.userId, args.userId),
          eq(emailDrafts.id, args.draftId),
        ),
      )
      .returning();
    if (!draft) throw new Error('Draft not found.');
    return draft;
  }

  const [draft] = await db
    .insert(emailDrafts)
    .values({
      accountId: args.accountId,
      userId: args.userId,
      ...values,
    })
    .returning();
  return draft;
}

export async function deleteEmailDraftForUser(args: {
  accountId: string;
  userId: string;
  draftId: string;
}) {
  const rows = await db
    .delete(emailDrafts)
    .where(
      and(
        eq(emailDrafts.accountId, args.accountId),
        eq(emailDrafts.userId, args.userId),
        eq(emailDrafts.id, args.draftId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

async function rulesFor(accountId: string, mailboxId: string) {
  return db
    .select()
    .from(emailRules)
    .where(
      and(
        eq(emailRules.accountId, accountId),
        eq(emailRules.enabled, true),
        or(eq(emailRules.mailboxId, mailboxId), sql`${emailRules.mailboxId} is null`),
      ),
    )
    .orderBy(asc(emailRules.position));
}

export async function importEmailAccount(args: {
  accountId: string;
  emailAccountId: string;
  userId?: string | null;
  maxMessages?: number;
}) {
  const [account] = await db
    .select()
    .from(emailAccounts)
    .where(and(eq(emailAccounts.accountId, args.accountId), eq(emailAccounts.id, args.emailAccountId)))
    .limit(1);
  if (!account || !account.enabled) return { imported: 0, skipped: 0 };

  const [mailbox] = await db
    .select()
    .from(emailMailboxes)
    .where(and(eq(emailMailboxes.accountId, args.accountId), eq(emailMailboxes.emailAccountId, account.id)))
    .limit(1);
  if (!mailbox) throw new Error('Email mailbox is missing.');

  const [inboxFolder] = await db
    .select()
    .from(emailFolders)
    .where(and(eq(emailFolders.mailboxId, mailbox.id), eq(emailFolders.kind, 'inbox')))
    .limit(1);
  if (!inboxFolder) throw new Error('Inbox folder is missing.');

  const credentials = decryptEmailCredentials(account.encryptedCredentials as Record<string, unknown>);
  const cursor = (account.syncCursor as { last_uid?: number; uid_validity?: string } | null) ?? {};
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: {
      user: credentials.imap_user,
      pass: credentials.imap_password,
    },
  });

  let imported = 0;
  let skipped = 0;
  let maxUid = cursor.last_uid ?? 0;

  try {
    await client.connect();
    const lock = await client.getMailboxLock(account.syncMailbox);
    try {
      const mailboxInfo = await client.mailboxOpen(account.syncMailbox, { readOnly: true });
      const uidValidity = String(mailboxInfo.uidValidity ?? cursor.uid_validity ?? '0');
      const fromUid = uidValidity === cursor.uid_validity ? (cursor.last_uid ?? 0) + 1 : 1;
      const range = `${fromUid}:*`;
      const ruleRows = await rulesFor(args.accountId, mailbox.id);
      const limit = args.maxMessages ?? 50;

      for await (const msg of client.fetch(range, { uid: true, source: true, flags: true, envelope: true, internalDate: true, size: true }, { uid: true })) {
        if (!msg.uid || msg.uid < fromUid) continue;
        if (imported >= limit) break;
        maxUid = Math.max(maxUid, msg.uid);
        const source = msg.source ? Buffer.from(msg.source) : null;
        if (!source) {
          skipped++;
          continue;
        }

        const parsed = await simpleParser(source);
        const from = firstAddress(parsed.from);
        const toAddresses = addressList(parsed.to);
        const ccAddresses = addressList(parsed.cc);
        const targetFolderId =
          resolveRuleTargetFolder(ruleRows, {
            fromAddress: from.address,
            toAddresses,
            ccAddresses,
            subject: parsed.subject ?? '',
          }) ?? inboxFolder.id;

        const [created] = await db
          .insert(emailMessages)
          .values({
            accountId: args.accountId,
            emailAccountId: account.id,
            mailboxId: mailbox.id,
            folderId: targetFolderId,
            imapMailbox: account.syncMailbox,
            imapUidValidity: uidValidity,
            imapUid: msg.uid,
            messageId: parsed.messageId ?? null,
            threadKey: parsed.references?.toString() ?? parsed.inReplyTo ?? parsed.messageId ?? null,
            subject: parsed.subject || '(Sin asunto)',
            fromName: from.name,
            fromAddress: from.address,
            toAddresses,
            ccAddresses,
            bccAddresses: addressList(parsed.bcc),
            replyToAddresses: addressList(parsed.replyTo),
            receivedAt: parsed.date ?? asDate(msg.internalDate) ?? new Date(),
            sentAt: parsed.date ?? null,
            snippet: snippet(parsed),
            bodyText: parsed.text ?? null,
            bodyHtml: typeof parsed.html === 'string' ? parsed.html : null,
            isRead: false,
            hasAttachments: parsed.attachments.length > 0,
            rawHeaders: Object.fromEntries(parsed.headers.entries()),
            rawSize: msg.size ?? source.byteLength,
          })
          .onConflictDoNothing()
          .returning();

        if (!created) {
          skipped++;
          continue;
        }

        for (const attachment of parsed.attachments) {
          const fileName = attachment.filename || 'attachment';
          const storageKey = `email/${args.accountId}/${created.id}/${crypto.randomUUID()}-${fileName}`;
          await putObject({
            key: storageKey,
            body: attachment.content,
            contentType: attachment.contentType,
          });
          await db.insert(emailAttachments).values({
            accountId: args.accountId,
            messageId: created.id,
            fileName,
            contentType: attachment.contentType,
            size: attachment.size,
            storageKey,
            contentId: attachment.contentId ?? null,
          });
        }

        await db.insert(emailAuditEvents).values({
          accountId: args.accountId,
          userId: args.userId ?? null,
          mailboxId: mailbox.id,
          folderId: targetFolderId,
          messageId: created.id,
          eventType: 'message.imported',
          metadata: { imap_uid: msg.uid, copied_from: account.syncMailbox },
        });
        imported++;
      }

      await db
        .update(emailAccounts)
        .set({
          syncCursor: { last_uid: maxUid, uid_validity: uidValidity },
          lastSyncedAt: new Date(),
          status: 'active',
          lastError: null,
        })
        .where(eq(emailAccounts.id, account.id));
    } finally {
      lock.release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Email import failed.';
    await db
      .update(emailAccounts)
      .set({ status: 'error', lastError: message })
      .where(eq(emailAccounts.id, account.id));
    throw error;
  } finally {
    await client.logout().catch(() => undefined);
  }

  return { imported, skipped };
}

export async function importAllEmailAccounts(args: {
  accountId?: string;
  userId?: string | null;
  maxMessages?: number;
}) {
  const rows = await db
    .select()
    .from(emailAccounts)
    .where(
      args.accountId
        ? and(eq(emailAccounts.accountId, args.accountId), eq(emailAccounts.enabled, true))
        : eq(emailAccounts.enabled, true),
    );
  let imported = 0;
  let skipped = 0;
  for (const row of rows) {
    const result = await importEmailAccount({
      accountId: row.accountId,
      emailAccountId: row.id,
      userId: args.userId ?? null,
      maxMessages: args.maxMessages,
    });
    imported += result.imported;
    skipped += result.skipped;
  }
  return { imported, skipped, accounts: rows.length };
}

export async function sendEmail(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  mailboxId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: {
    filename: string;
    contentType?: string;
    contentBase64: string;
  }[];
  inReplyToMessageId?: string | null;
}) {
  const [mailbox] = await db
    .select()
    .from(emailMailboxes)
    .where(and(eq(emailMailboxes.accountId, args.accountId), eq(emailMailboxes.id, args.mailboxId)))
    .limit(1);
  if (!mailbox || !mailbox.canSend) throw new Error('Mailbox is not available for sending.');

  const permission = await resolveEmailPermission({
    accountId: args.accountId,
    userId: args.userId,
    role: args.role,
    mailboxId: mailbox.id,
  });
  if (!permission.canSend) throw new Error('You do not have permission to send from this mailbox.');

  const [account] = await db
    .select()
    .from(emailAccounts)
    .where(and(eq(emailAccounts.accountId, args.accountId), eq(emailAccounts.id, mailbox.emailAccountId)))
    .limit(1);
  if (!account) throw new Error('SMTP account not found.');

  const credentials = decryptEmailCredentials(account.encryptedCredentials as Record<string, unknown>);
  const transporter = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    auth: {
      user: credentials.smtp_user,
      pass: credentials.smtp_password,
    },
  });

  const info = await transporter.sendMail({
    from: mailbox.displayName ? `${mailbox.displayName} <${mailbox.address}>` : mailbox.address,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject || '(Sin asunto)',
    text: args.text,
    html: args.html,
    attachments: args.attachments?.map((attachment) => ({
      filename: attachment.filename || 'attachment',
      contentType: attachment.contentType,
      content: Buffer.from(attachment.contentBase64, 'base64'),
    })),
  });

  const [sentFolder] = await db
    .select()
    .from(emailFolders)
    .where(
      and(
        eq(emailFolders.accountId, args.accountId),
        eq(emailFolders.mailboxId, mailbox.id),
        eq(emailFolders.kind, 'sent'),
      ),
    )
    .limit(1);

  let sentMessageId: string | null = null;
  if (sentFolder) {
    const now = new Date();
    const localUid = Math.floor(now.getTime() / 1000) + Math.floor(Math.random() * 1000);
    const [sentMessage] = await db
      .insert(emailMessages)
      .values({
        accountId: args.accountId,
        emailAccountId: account.id,
        mailboxId: mailbox.id,
        folderId: sentFolder.id,
        imapMailbox: '__sent__',
        imapUidValidity: 'local',
        imapUid: localUid,
        messageId: info.messageId ?? null,
        threadKey: args.inReplyToMessageId ?? info.messageId ?? null,
        subject: args.subject || '(Sin asunto)',
        fromName: mailbox.displayName,
        fromAddress: mailbox.address,
        toAddresses: args.to,
        ccAddresses: args.cc ?? [],
        bccAddresses: args.bcc ?? [],
        replyToAddresses: [],
        receivedAt: now,
        sentAt: now,
        snippet: args.text.replace(/\s+/g, ' ').trim().slice(0, 240) || null,
        bodyText: args.text,
        bodyHtml: args.html ?? null,
        isRead: true,
        hasAttachments: Boolean(args.attachments?.length),
        rawHeaders: {},
        rawSize: null,
      })
      .returning();
    sentMessageId = sentMessage.id;

    for (const attachment of args.attachments ?? []) {
      const fileName = attachment.filename || 'attachment';
      const storageKey = `email/${args.accountId}/${sentMessage.id}/${crypto.randomUUID()}-${fileName}`;
      await putObject({
        key: storageKey,
        body: Buffer.from(attachment.contentBase64, 'base64'),
        contentType: attachment.contentType,
      });
      await db.insert(emailAttachments).values({
        accountId: args.accountId,
        messageId: sentMessage.id,
        fileName,
        contentType: attachment.contentType,
        size: Math.ceil((attachment.contentBase64.length * 3) / 4),
        storageKey,
        contentId: null,
      });
    }
  }

  await db.insert(emailAuditEvents).values({
    accountId: args.accountId,
    userId: args.userId,
    mailboxId: mailbox.id,
    folderId: sentFolder?.id ?? null,
    messageId: sentMessageId,
    eventType: 'message.sent',
    metadata: {
      smtp_message_id: info.messageId,
      from: mailbox.address,
      to: args.to,
      cc: args.cc ?? [],
      bcc: args.bcc ?? [],
      attachment_count: args.attachments?.length ?? 0,
      in_reply_to_message_id: args.inReplyToMessageId ?? null,
    },
  });

  return { message_id: info.messageId ?? null, stored_message_id: sentMessageId };
}

export async function importThunderbirdRules(args: {
  accountId: string;
  mailboxId: string;
  rules: ThunderbirdRuleInput[];
}) {
  let position = 0;
  const created = [];
  for (const rule of args.rules) {
    const slug = slugify(rule.targetFolderName);
    const [folder] = await db
      .insert(emailFolders)
      .values({
        accountId: args.accountId,
        mailboxId: args.mailboxId,
        name: rule.targetFolderName,
        slug,
        kind: 'custom',
        position: 100 + position,
      })
      .onConflictDoUpdate({
        target: [emailFolders.mailboxId, emailFolders.slug],
        set: { name: rule.targetFolderName },
      })
      .returning();

    const [row] = await db
      .insert(emailRules)
      .values({
        accountId: args.accountId,
        mailboxId: args.mailboxId,
        targetFolderId: folder.id,
        name: rule.name,
        field: rule.field,
        operator: rule.operator,
        value: rule.value,
        enabled: rule.enabled,
        position: position++,
      })
      .returning();
    created.push(row);
  }
  return created;
}
