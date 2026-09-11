import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { ImapFlow } from 'imapflow';
import JSZip from 'jszip';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';

import { db } from '@/db/client';
import { departments, departmentMembers, emailAccounts, emailAttachments, emailAuditEvents, emailDrafts, emailFolders, emailLabels, emailMailboxes, emailMessageLabels, emailMessages, emailPermissions, emailRules, emailSignatures, emailUserPermissions, profiles } from '@/db/schema';
import { deleteObject, getObjectBytes, putObject, signedObjectUrl } from '@/lib/storage/alarik';
import { createRealtimeNotification } from '@/lib/notifications/create-notification';
import { publishRealtimeEvent } from '@/lib/realtime/soketi-server';
import { decryptEmailCredentials, encryptEmailCredentials } from './credentials';
import { listAccessibleFolders, resolveEmailPermission } from './permissions';
import { matchEmailRule, resolveRuleTargetFolder, type EmailRuleLike, type RuleCandidate } from './rules';
import type { AccountRole } from '@/lib/auth/roles';
import type { CreateEmailAccountInput, EmailRuleAction, ThunderbirdRuleInput } from './types';

const DEFAULT_FOLDERS = [
  { name: 'Entrada', slug: 'inbox', kind: 'inbox', position: 0 },
  { name: 'Enviados', slug: 'sent', kind: 'sent', position: 10 },
  { name: 'Archivo', slug: 'archive', kind: 'archive', position: 20 },
  { name: 'Papelera', slug: 'trash', kind: 'trash', position: 30 },
] as const;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeDbText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\u0000/g, '') : '';
}

function sanitizeDbTextOrNull(value: unknown): string | null {
  const sanitized = sanitizeDbText(value);
  return sanitized.length > 0 ? sanitized : null;
}

function sanitizeDbTextArray(values: string[]) {
  return values.map((value) => sanitizeDbText(value)).filter(Boolean);
}

function sanitizeJsonForDb(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return sanitizeDbText(value);
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonForDb(item, seen));
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, item]) => [String(key), sanitizeJsonForDb(item, seen)]),
    );
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      sanitizeDbText(key),
      sanitizeJsonForDb(item, seen),
    ]),
  );
}

function compactImportError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Email import failed.';
  return sanitizeDbText(message).slice(0, 2000);
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'carpeta'
  );
}

function safeZipName(value: string, fallback: string) {
  return (
    (value || fallback)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 120) || fallback
  );
}

function displayEmailFolderName(row: Pick<typeof emailFolders.$inferSelect, 'name' | 'slug'>) {
  const normalized = `${row.slug} ${row.name}`.toLowerCase();
  if (/\b(junk|spam)\b/.test(normalized) || normalized.includes('correo-no-deseado')) return 'SPAM';
  return row.name;
}

function uniqueZipPath(path: string, seen: Set<string>) {
  if (!seen.has(path)) {
    seen.add(path);
    return path;
  }
  const dot = path.lastIndexOf('.');
  const base = dot > -1 ? path.slice(0, dot) : path;
  const ext = dot > -1 ? path.slice(dot) : '';
  let index = 2;
  let next = `${base}-${index}${ext}`;
  while (seen.has(next)) {
    index += 1;
    next = `${base}-${index}${ext}`;
  }
  seen.add(next);
  return next;
}

function addressList(input?: AddressObject | AddressObject[] | null): string[] {
  const list = Array.isArray(input) ? input : input ? [input] : [];
  return sanitizeDbTextArray(list.flatMap((item) => item.value.map((address) => address.address).filter(Boolean) as string[]));
}

function firstAddress(input?: AddressObject | AddressObject[] | null) {
  const first = addressList(input)[0];
  const source = Array.isArray(input) ? input[0] : input;
  return {
    address: first ?? 'unknown@example.invalid',
    name: sanitizeDbTextOrNull(source?.value[0]?.name),
  };
}

function snippet(parsed: ParsedMail): string | null {
  const html = typeof parsed.html === 'string' ? sanitizeDbText(parsed.html) : '';
  const text = sanitizeDbText(parsed.text ?? html).replace(/\s+/g, ' ').trim();
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
    external_state: row.externalState,
    is_replied: flags?.isReplied ?? false,
    has_attachments: row.hasAttachments,
    raw_size: row.rawSize,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

async function publishEmailMessageEvent(name: 'email.message.created' | 'email.message.updated' | 'email.message.deleted', row: typeof emailMessages.$inferSelect, reason: string) {
  await publishRealtimeEvent(name, {
    accountId: row.accountId,
    payload: {
      message: serializeEmailMessage(row),
      reason,
    },
  }).catch((error) => {
    console.warn('[realtime] failed to publish email event', {
      name,
      reason,
      error,
    });
  });
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

export function serializeEmailFolder(row: typeof emailFolders.$inferSelect, counts?: { unreadCount?: number }) {
  return {
    id: row.id,
    account_id: row.accountId,
    mailbox_id: row.mailboxId,
    name: displayEmailFolderName(row),
    slug: row.slug,
    kind: row.kind,
    position: row.position,
    unread_count: counts?.unreadCount ?? 0,
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

async function assertEmailPermissionTarget(accountId: string, mailboxId: string | null, folderId: string | null) {
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

export function serializeEmailSignature(row: typeof emailSignatures.$inferSelect) {
  return {
    id: row.id,
    account_id: row.accountId,
    user_id: row.userId,
    mailbox_id: row.mailboxId,
    name: row.name,
    body_text: row.bodyText,
    body_html: row.bodyHtml,
    enabled: row.enabled,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function getEmailSignatureForUser(args: { accountId: string; userId: string; role: AccountRole; mailboxId?: string | null }) {
  if (args.mailboxId) {
    const permission = await resolveEmailPermission({
      accountId: args.accountId,
      userId: args.userId,
      role: args.role,
      mailboxId: args.mailboxId,
    });
    if (!permission.canSend) throw new Error('You do not have permission to send from this mailbox.');
  }

  const filters = [and(eq(emailSignatures.accountId, args.accountId), eq(emailSignatures.userId, args.userId), isNull(emailSignatures.mailboxId))];
  if (args.mailboxId) {
    filters.unshift(and(eq(emailSignatures.accountId, args.accountId), eq(emailSignatures.userId, args.userId), eq(emailSignatures.mailboxId, args.mailboxId)));
  }

  for (const filter of filters) {
    const [row] = await db.select().from(emailSignatures).where(filter).limit(1);
    if (row) return row;
  }
  return null;
}

export async function saveEmailSignatureForUser(args: { accountId: string; userId: string; role: AccountRole; mailboxId?: string | null; name?: string; bodyText: string; bodyHtml?: string | null; enabled: boolean }) {
  if (args.mailboxId) {
    const permission = await resolveEmailPermission({
      accountId: args.accountId,
      userId: args.userId,
      role: args.role,
      mailboxId: args.mailboxId,
    });
    if (!permission.canSend) throw new Error('You do not have permission to send from this mailbox.');
  }

  const where = and(eq(emailSignatures.accountId, args.accountId), eq(emailSignatures.userId, args.userId), args.mailboxId ? eq(emailSignatures.mailboxId, args.mailboxId) : isNull(emailSignatures.mailboxId));
  const [existing] = await db.select().from(emailSignatures).where(where).limit(1);
  if (existing) {
    const [updated] = await db
      .update(emailSignatures)
      .set({
        name: args.name?.trim() || 'Firma',
        bodyText: args.bodyText,
        bodyHtml: args.bodyHtml || null,
        enabled: args.enabled,
        updatedAt: new Date(),
      })
      .where(eq(emailSignatures.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(emailSignatures)
    .values({
      accountId: args.accountId,
      userId: args.userId,
      mailboxId: args.mailboxId ?? null,
      name: args.name?.trim() || 'Firma',
      bodyText: args.bodyText,
      bodyHtml: args.bodyHtml || null,
      enabled: args.enabled,
    })
    .returning();
  return created;
}

export async function createEmailAccount(args: { accountId: string; userId: string; input: CreateEmailAccountInput }) {
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
        ownerUserId: args.input.mailboxKind === 'personal' ? (args.input.ownerUserId ?? args.userId) : null,
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
        }))
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
    .where(and(eq(emailAccounts.accountId, args.accountId), eq(emailAccounts.id, args.emailAccountId)))
    .limit(1);
  if (!existing) throw new Error('Email account not found.');

  const existingCredentials = existing.encryptedCredentials as Record<string, unknown>;
  const hasNewCredentials = Boolean(clean(args.input.imapUser)) || Boolean(clean(args.input.imapPassword)) || Boolean(clean(args.input.smtpUser)) || Boolean(clean(args.input.smtpPassword));
  const encryptedCredentials = hasNewCredentials
    ? encryptEmailCredentials({
        imapUser: clean(args.input.imapUser) || decryptEmailCredentials(existingCredentials).imap_user,
        imapPassword: clean(args.input.imapPassword) || decryptEmailCredentials(existingCredentials).imap_password,
        smtpUser: clean(args.input.smtpUser) || decryptEmailCredentials(existingCredentials).smtp_user,
        smtpPassword: clean(args.input.smtpPassword) || decryptEmailCredentials(existingCredentials).smtp_password,
      })
    : existingCredentials;

  return db.transaction(async (tx) => {
    const emailAddress = args.input.emailAddress ? normalizeEmail(args.input.emailAddress) : existing.emailAddress;
    const [account] = await tx
      .update(emailAccounts)
      .set({
        label: clean(args.input.label) || existing.label,
        emailAddress,
        imapHost: clean(args.input.imapHost) || existing.imapHost,
        imapPort: args.input.imapPort || existing.imapPort,
        imapSecure: typeof args.input.imapSecure === 'boolean' ? args.input.imapSecure : existing.imapSecure,
        smtpHost: clean(args.input.smtpHost) || existing.smtpHost,
        smtpPort: args.input.smtpPort || existing.smtpPort,
        smtpSecure: typeof args.input.smtpSecure === 'boolean' ? args.input.smtpSecure : existing.smtpSecure,
        syncMailbox: clean(args.input.syncMailbox) || existing.syncMailbox,
        encryptedCredentials,
        enabled: typeof args.input.enabled === 'boolean' ? args.input.enabled : existing.enabled,
        status: typeof args.input.enabled === 'boolean' && !args.input.enabled ? 'disabled' : existing.status === 'disabled' ? 'active' : existing.status,
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
        ownerUserId: args.input.mailboxKind === 'shared' ? null : args.input.ownerUserId === undefined ? undefined : args.input.ownerUserId,
        updatedAt: new Date(),
      })
      .where(and(eq(emailMailboxes.accountId, args.accountId), eq(emailMailboxes.emailAccountId, existing.id)));

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
  const [accountRows, mailboxRows, folderRows, permissionRows, userPermissionRows, departmentRows, userRows, ruleRows, auditRows] = await Promise.all([
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
    db.select().from(emailAuditEvents).where(eq(emailAuditEvents.accountId, accountId)).orderBy(desc(emailAuditEvents.createdAt)).limit(50),
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
    folders: folderRows.map((row) => serializeEmailFolder(row)),
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

export async function grantEmailPermission(args: { accountId: string; userId?: string; departmentId: string; mailboxId?: string | null; folderId?: string | null; canRead: boolean; canMove: boolean; canClassify: boolean; canSend: boolean }) {
  await assertDepartmentInAccount(args.accountId, args.departmentId);
  await assertEmailPermissionTarget(args.accountId, args.mailboxId ?? null, args.folderId ?? null);
  const row = await db.transaction(async (tx) => {
    await tx.delete(emailPermissions).where(and(eq(emailPermissions.accountId, args.accountId), eq(emailPermissions.departmentId, args.departmentId), args.mailboxId ? eq(emailPermissions.mailboxId, args.mailboxId) : isNull(emailPermissions.mailboxId), args.folderId ? eq(emailPermissions.folderId, args.folderId) : isNull(emailPermissions.folderId)));
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

export async function grantEmailUserPermission(args: { accountId: string; actorUserId: string; targetUserId: string; mailboxId?: string | null; folderId?: string | null; canRead: boolean; canMove: boolean; canClassify: boolean; canSend: boolean }) {
  await assertUserInAccount(args.accountId, args.targetUserId);
  await assertEmailPermissionTarget(args.accountId, args.mailboxId ?? null, args.folderId ?? null);
  return db.transaction(async (tx) => {
    await tx.delete(emailUserPermissions).where(and(eq(emailUserPermissions.accountId, args.accountId), eq(emailUserPermissions.userId, args.targetUserId), args.mailboxId ? eq(emailUserPermissions.mailboxId, args.mailboxId) : isNull(emailUserPermissions.mailboxId), args.folderId ? eq(emailUserPermissions.folderId, args.folderId) : isNull(emailUserPermissions.folderId)));
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

export async function upsertEmailPermissionsBulk(args: { accountId: string; actorUserId: string; scope: 'department' | 'user'; subjectIds: string[]; targets: Array<{ mailboxId?: string | null; folderId?: string | null }>; canRead: boolean; canMove: boolean; canClassify: boolean; canSend: boolean }) {
  const subjectIds = [...new Set(args.subjectIds.filter(Boolean))];
  const targets = args.targets
    .map((target) => ({
      mailboxId: target.mailboxId ?? null,
      folderId: target.folderId ?? null,
    }))
    .filter((target) => target.mailboxId || target.folderId);
  if (subjectIds.length === 0 || targets.length === 0) {
    throw new Error('Choose at least one subject and one target.');
  }

  for (const subjectId of subjectIds) {
    if (args.scope === 'user') {
      await assertUserInAccount(args.accountId, subjectId);
    } else {
      await assertDepartmentInAccount(args.accountId, subjectId);
    }
  }
  for (const target of targets) {
    await assertEmailPermissionTarget(args.accountId, target.mailboxId, target.folderId);
  }

  const shouldGrant = args.canRead || args.canMove || args.canClassify || args.canSend;
  let changed = 0;

  await db.transaction(async (tx) => {
    for (const subjectId of subjectIds) {
      for (const target of targets) {
        if (args.scope === 'user') {
          const deleted = await tx
            .delete(emailUserPermissions)
            .where(and(eq(emailUserPermissions.accountId, args.accountId), eq(emailUserPermissions.userId, subjectId), target.mailboxId ? eq(emailUserPermissions.mailboxId, target.mailboxId) : isNull(emailUserPermissions.mailboxId), target.folderId ? eq(emailUserPermissions.folderId, target.folderId) : isNull(emailUserPermissions.folderId)))
            .returning({ id: emailUserPermissions.id });
          changed += deleted.length;
          if (shouldGrant) {
            await tx.insert(emailUserPermissions).values({
              accountId: args.accountId,
              userId: subjectId,
              mailboxId: target.mailboxId,
              folderId: target.folderId,
              canRead: args.canRead,
              canMove: args.canMove,
              canClassify: args.canClassify,
              canSend: args.canSend,
            });
            changed += 1;
          }
        } else {
          const deleted = await tx
            .delete(emailPermissions)
            .where(and(eq(emailPermissions.accountId, args.accountId), eq(emailPermissions.departmentId, subjectId), target.mailboxId ? eq(emailPermissions.mailboxId, target.mailboxId) : isNull(emailPermissions.mailboxId), target.folderId ? eq(emailPermissions.folderId, target.folderId) : isNull(emailPermissions.folderId)))
            .returning({ id: emailPermissions.id });
          changed += deleted.length;
          if (shouldGrant) {
            await tx.insert(emailPermissions).values({
              accountId: args.accountId,
              departmentId: subjectId,
              mailboxId: target.mailboxId,
              folderId: target.folderId,
              canRead: args.canRead,
              canMove: args.canMove,
              canClassify: args.canClassify,
              canSend: args.canSend,
            });
            changed += 1;
          }
        }
      }
    }

    await tx.insert(emailAuditEvents).values({
      accountId: args.accountId,
      userId: args.actorUserId,
      eventType: shouldGrant ? 'permission.bulk_updated' : 'permission.bulk_revoked',
      metadata: {
        scope: args.scope,
        subject_count: subjectIds.length,
        target_count: targets.length,
        changed,
        permissions: {
          can_read: args.canRead,
          can_move: args.canMove,
          can_classify: args.canClassify,
          can_send: args.canSend,
        },
      },
    });
  });

  return {
    changed,
    subject_count: subjectIds.length,
    target_count: targets.length,
  };
}

export async function deleteEmailPermission(args: { accountId: string; userId: string; permissionId: string; scope: 'department' | 'user' }) {
  if (args.scope === 'user') {
    const [deleted] = await db
      .delete(emailUserPermissions)
      .where(and(eq(emailUserPermissions.accountId, args.accountId), eq(emailUserPermissions.id, args.permissionId)))
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
    .where(and(eq(emailPermissions.accountId, args.accountId), eq(emailPermissions.id, args.permissionId)))
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

export async function createEmailFolder(args: { accountId: string; mailboxId: string; name: string; userId?: string }) {
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

export async function createGlobalEmailFolder(args: { accountId: string; userId: string; name: string }) {
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

export async function deleteEmailFolder(args: { accountId: string; userId: string; folderId: string }) {
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
        .where(and(eq(emailFolders.accountId, args.accountId), eq(emailFolders.mailboxId, folder.mailboxId), eq(emailFolders.kind, 'inbox')))
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
          .where(and(eq(emailFolders.accountId, args.accountId), eq(emailFolders.mailboxId, row.mailboxId), eq(emailFolders.kind, 'inbox')))
          .limit(1);
        if (inboxFolder) {
          await tx
            .update(emailMessages)
            .set({ folderId: inboxFolder.id, updatedAt: new Date() })
            .where(and(eq(emailMessages.accountId, args.accountId), eq(emailMessages.folderId, folder.id), eq(emailMessages.mailboxId, row.mailboxId)));
        }
      }
    }

    await tx.delete(emailFolders).where(and(eq(emailFolders.accountId, args.accountId), eq(emailFolders.id, folder.id)));
    await tx.insert(emailAuditEvents).values({
      accountId: args.accountId,
      userId: args.userId,
      mailboxId: folder.mailboxId,
      folderId: null,
      eventType: 'folder.deleted',
      metadata: {
        deleted_folder_id: folder.id,
        name: folder.name,
        moved_messages_to: 'inbox',
      },
    });
  });
  return folder;
}

export async function deleteEmailAccount(args: { accountId: string; userId: string; emailAccountId: string }) {
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
    await tx.delete(emailAccounts).where(and(eq(emailAccounts.accountId, args.accountId), eq(emailAccounts.id, account.id)));
  });
  return account;
}

export async function createPublicEmailFolder(args: { accountId: string; userId: string; role: AccountRole; mailboxId: string; name: string }) {
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

export async function listEmailWorkspace(args: { accountId: string; userId: string; role: AccountRole; includeUnreadCounts?: boolean }) {
  const { listAccessibleMailboxes, listAccessibleFolders } = await import('./permissions');
  const mailboxes = await listAccessibleMailboxes(args);
  const folders = await listAccessibleFolders({
    ...args,
    mailboxIds: mailboxes.map((mailbox) => mailbox.id),
  });
  const folderIds = folders.map((folder) => folder.id);
  const unreadRows =
    args.includeUnreadCounts !== false && folderIds.length > 0
      ? await db
          .select({
            folderId: emailMessages.folderId,
            unreadCount: sql<number>`count(*)::int`,
          })
          .from(emailMessages)
          .where(and(eq(emailMessages.accountId, args.accountId), inArray(emailMessages.folderId, folderIds), eq(emailMessages.isRead, false), eq(emailMessages.externalState, 'present')))
          .groupBy(emailMessages.folderId)
      : [];
  const unreadByFolder = new Map(unreadRows.map((row) => [row.folderId, Number(row.unreadCount) || 0]));
  return {
    mailboxes: mailboxes.map(serializeEmailMailbox),
    folders: folders.map((folder) =>
      serializeEmailFolder(folder, {
        unreadCount: unreadByFolder.get(folder.id) ?? 0,
      })
    ),
  };
}

export async function getEmailSyncStateForUser(args: { accountId: string; userId: string; role: AccountRole }) {
  const workspace = await listEmailWorkspace(args);
  const folderIds = workspace.folders.map((folder) => folder.id);
  const messageStateRows =
    folderIds.length > 0
      ? await db
          .select({
            folderId: emailMessages.folderId,
            unreadCount: sql<number>`count(*) filter (where ${emailMessages.isRead} = false)::int`,
            presentCount: sql<number>`count(*)::int`,
            latestMessageAt: sql<Date | null>`max(${emailMessages.receivedAt})`,
            latestUpdatedAt: sql<Date | null>`max(${emailMessages.updatedAt})`,
          })
          .from(emailMessages)
          .where(and(eq(emailMessages.accountId, args.accountId), inArray(emailMessages.folderId, folderIds), eq(emailMessages.externalState, 'present')))
          .groupBy(emailMessages.folderId)
      : [];
  const stateByFolder = new Map(messageStateRows.map((row) => [row.folderId, row]));
  const folderState = workspace.folders.map((folder) => {
    const state = stateByFolder.get(folder.id);
    return {
      id: folder.id,
      mailbox_id: folder.mailbox_id,
      unread_count: Number(state?.unreadCount ?? folder.unread_count ?? 0),
      message_count: Number(state?.presentCount ?? 0),
      latest_message_at: state?.latestMessageAt ? new Date(state.latestMessageAt).toISOString() : null,
      latest_updated_at: state?.latestUpdatedAt ? new Date(state.latestUpdatedAt).toISOString() : null,
    };
  });
  const mailboxState = workspace.mailboxes.map((mailbox) => {
    const folders = folderState.filter((folder) => folder.mailbox_id === mailbox.id);
    return {
      id: mailbox.id,
      unread_count: folders.reduce((sum, folder) => sum + folder.unread_count, 0),
      message_count: folders.reduce((sum, folder) => sum + folder.message_count, 0),
      latest_updated_at:
        folders
          .map((folder) => folder.latest_updated_at)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null,
    };
  });
  const version = crypto
    .createHash('sha1')
    .update(JSON.stringify({ folders: folderState, mailboxes: mailboxState }))
    .digest('hex');

  return {
    ...workspace,
    state: {
      version,
      folders: folderState,
      mailboxes: mailboxState,
    },
  };
}

export async function listEmailRulesForUser(args: { accountId: string; userId: string; role: AccountRole; mailboxId?: string | null }) {
  const workspace = await listEmailWorkspace(args);
  const mailboxIds = workspace.mailboxes.map((mailbox) => mailbox.id);
  if (mailboxIds.length === 0) return { rules: [], ...workspace };
  const effectiveMailboxIds = args.mailboxId && mailboxIds.includes(args.mailboxId) ? [args.mailboxId] : mailboxIds;
  const rows = await db
    .select()
    .from(emailRules)
    .where(and(eq(emailRules.accountId, args.accountId), inArray(emailRules.mailboxId, effectiveMailboxIds)))
    .orderBy(asc(emailRules.position), asc(emailRules.name));
  return { rules: rows, ...workspace };
}

export async function createEmailRule(args: { accountId: string; userId: string; role: AccountRole; mailboxId: string; targetFolderId: string | null; action?: EmailRuleAction | string; actionValue?: string | null; name: string; field: string; operator: string; value: string }) {
  const action = clean(args.action) || 'move_to';
  if ((action === 'move_to' || action === 'copy_to') && !args.targetFolderId) {
    throw new Error('Esta acción necesita una carpeta de destino.');
  }
  const permission = await resolveEmailPermission({
    accountId: args.accountId,
    userId: args.userId,
    role: args.role,
    mailboxId: args.mailboxId,
  });
  const targetPermission = args.targetFolderId
    ? await resolveEmailPermission({
        accountId: args.accountId,
        userId: args.userId,
        role: args.role,
        folderId: args.targetFolderId,
      })
    : permission;
  if (!permission.canClassify || !targetPermission.canClassify) {
    throw new Error('You do not have permission to create rules for this mailbox or target folder.');
  }
  const [rule] = await db
    .insert(emailRules)
    .values({
      accountId: args.accountId,
      mailboxId: args.mailboxId,
      targetFolderId: args.targetFolderId,
      action,
      actionValue: args.actionValue ?? null,
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

export async function updateEmailRuleForUser(args: { accountId: string; userId: string; role: AccountRole; ruleId: string; targetFolderId: string | null; action?: EmailRuleAction | string; actionValue?: string | null; name: string; field: string; operator: string; value: string; enabled: boolean }) {
  const action = clean(args.action) || 'move_to';
  if ((action === 'move_to' || action === 'copy_to') && !args.targetFolderId) {
    throw new Error('Esta acción necesita una carpeta de destino.');
  }
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
  });
  const targetPermission = args.targetFolderId
    ? await resolveEmailPermission({
        accountId: args.accountId,
        userId: args.userId,
        role: args.role,
        folderId: args.targetFolderId,
      })
    : permission;
  if (!permission.canClassify || !targetPermission.canClassify) {
    throw new Error('You do not have permission to update rules for this mailbox or target folder.');
  }

  const [rule] = await db
    .update(emailRules)
    .set({
      targetFolderId: args.targetFolderId,
      action,
      actionValue: args.actionValue ?? null,
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

export async function deleteEmailRuleForUser(args: { accountId: string; userId: string; role: AccountRole; ruleId: string }) {
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
    folderId: existing.targetFolderId ?? undefined,
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
    folderId: existing.targetFolderId ?? undefined,
    eventType: 'rule.deleted',
    metadata: { rule_id: existing.id, name: existing.name },
  });

  return deleted;
}

export async function applyEmailRuleToMessage(args: { accountId: string; userId: string; role: AccountRole; messageId: string; ruleId: string }) {
  const current = await getEmailMessageForUser(args);
  if (!current) throw new Error('Message not found or not permitted.');
  if (!current.permission.canClassify && !current.permission.canMove) {
    throw new Error('You do not have permission to classify this email.');
  }
  const [rule] = await db
    .select()
    .from(emailRules)
    .where(and(eq(emailRules.accountId, args.accountId), eq(emailRules.id, args.ruleId), eq(emailRules.mailboxId, current.message.mailboxId)))
    .limit(1);
  if (!rule) throw new Error('Rule not found for this mailbox.');

  const [targetFolder] = rule.targetFolderId
    ? await db
        .select()
        .from(emailFolders)
        .where(and(eq(emailFolders.accountId, args.accountId), eq(emailFolders.id, rule.targetFolderId), or(eq(emailFolders.mailboxId, current.message.mailboxId), isNull(emailFolders.mailboxId))))
        .limit(1)
    : [null];
  if ((rule.action === 'move_to' || rule.action === 'copy_to') && !targetFolder) throw new Error('Rule target folder not found.');

  const action = rule.action || 'move_to';
  const update = action === 'mark_read' ? { isRead: true, updatedAt: new Date() } : action === 'mark_unread' ? { isRead: false, updatedAt: new Date() } : action === 'star' ? { isStarred: true, updatedAt: new Date() } : targetFolder ? { folderId: targetFolder.id, updatedAt: new Date() } : { updatedAt: new Date() };

  const [updated] = await db
    .update(emailMessages)
    .set(update)
    .where(and(eq(emailMessages.accountId, args.accountId), eq(emailMessages.id, args.messageId)))
    .returning();

  await db.insert(emailAuditEvents).values({
    accountId: args.accountId,
    userId: args.userId,
    mailboxId: updated.mailboxId,
    folderId: targetFolder?.id ?? updated.folderId,
    messageId: updated.id,
    eventType: 'rule.applied',
    metadata: { rule_id: rule.id, rule_name: rule.name, action },
  });
  return updated;
}

export async function applyEmailRulesForUser(args: { accountId: string; userId: string; role: AccountRole; mailboxId: string; folderId?: string | null }) {
  const workspace = await listEmailWorkspace(args);
  const mailbox = workspace.mailboxes.find((row) => row.id === args.mailboxId);
  if (!mailbox) throw new Error('Mailbox not found or not permitted.');

  const selectedFolder = args.folderId ? (workspace.folders.find((folder) => folder.id === args.folderId) ?? null) : null;
  if (args.folderId && !selectedFolder) {
    throw new Error('Folder not found or not permitted.');
  }

  const permission = await resolveEmailPermission({
    accountId: args.accountId,
    userId: args.userId,
    role: args.role,
    mailboxId: args.mailboxId,
    folderId: selectedFolder?.id ?? undefined,
  });
  if (!permission.canClassify && !permission.canMove) {
    throw new Error('You do not have permission to apply rules here.');
  }

  const [rules, accessibleTargetFolders] = await Promise.all([
    db
      .select()
      .from(emailRules)
      .where(and(eq(emailRules.accountId, args.accountId), eq(emailRules.mailboxId, args.mailboxId), eq(emailRules.enabled, true)))
      .orderBy(asc(emailRules.position), asc(emailRules.name)),
    listAccessibleFolders({
      accountId: args.accountId,
      userId: args.userId,
      role: args.role,
      mailboxIds: [args.mailboxId],
    }),
  ]);
  const accessibleTargetFolderIds = new Set(accessibleTargetFolders.map((folder) => folder.id));
  const applicableRules = rules.filter((rule) => {
    const action = clean(rule.action) || 'move_to';
    return !(action === 'move_to' || action === 'copy_to') || !rule.targetFolderId || accessibleTargetFolderIds.has(rule.targetFolderId);
  });
  if (applicableRules.length === 0) {
    return { checked: 0, matched: 0, updated: 0, skipped_rules: rules.length };
  }

  const folderIds = selectedFolder ? [selectedFolder.id] : workspace.folders.filter((folder) => folder.mailbox_id === args.mailboxId).map((folder) => folder.id);
  if (folderIds.length === 0) {
    return {
      checked: 0,
      matched: 0,
      updated: 0,
      skipped_rules: rules.length - applicableRules.length,
    };
  }

  const rows = await db
    .select()
    .from(emailMessages)
    .where(and(eq(emailMessages.accountId, args.accountId), eq(emailMessages.mailboxId, args.mailboxId), inArray(emailMessages.folderId, folderIds), eq(emailMessages.externalState, 'present')))
    .orderBy(desc(emailMessages.receivedAt))
    .limit(1000);

  let matched = 0;
  let updated = 0;
  for (const message of rows) {
    const candidate: RuleCandidate = {
      fromAddress: message.fromAddress,
      toAddresses: message.toAddresses,
      ccAddresses: message.ccAddresses,
      subject: message.subject,
      bodyText: message.bodyText ?? '',
      sizeBytes: message.rawSize ?? undefined,
      hasAttachment: message.hasAttachments,
      date: message.receivedAt,
    };
    if (!applicableRules.some((rule) => matchEmailRule(rule, candidate))) continue;
    matched += 1;
    const next = await applyMatchingRulesToImportedMessage({
      accountId: args.accountId,
      userId: args.userId,
      mailboxId: args.mailboxId,
      message,
      candidate,
      rules: applicableRules,
    });
    if (next.folderId !== message.folderId || next.isRead !== message.isRead || next.isStarred !== message.isStarred) {
      updated += 1;
      await publishEmailMessageEvent('email.message.updated', next, 'rules_applied');
    }
  }

  await db.insert(emailAuditEvents).values({
    accountId: args.accountId,
    userId: args.userId,
    mailboxId: args.mailboxId,
    folderId: selectedFolder?.id ?? null,
    eventType: 'rules.applied_bulk',
    metadata: {
      checked: rows.length,
      matched,
      updated,
      skipped_rules: rules.length - applicableRules.length,
    },
  });

  return {
    checked: rows.length,
    matched,
    updated,
    skipped_rules: rules.length - applicableRules.length,
  };
}

export async function listEmailMessages(args: { accountId: string; userId: string; role: AccountRole; mailboxId?: string | null; folderId?: string | null; q?: string | null; unread?: boolean; attachments?: boolean; starred?: boolean; labelId?: string | null; from?: string | null; to?: string | null; sort?: string | null; includeWorkspace?: boolean }) {
  const includeWorkspace = args.includeWorkspace !== false;
  const workspace = await listEmailWorkspace({
    ...args,
    includeUnreadCounts: includeWorkspace,
  });
  const allowedMailboxIds = workspace.mailboxes.map((mailbox) => mailbox.id);
  const allowedFolderIds = workspace.folders.map((folder) => folder.id);
  if (allowedFolderIds.length === 0) {
    return { messages: [], ...workspace };
  }

  const folderId = args.folderId && allowedFolderIds.includes(args.folderId) ? args.folderId : null;
  const selectedFolder = folderId ? (workspace.folders.find((folder) => folder.id === folderId) ?? null) : null;
  // A public folder can contain messages from multiple source mailboxes. Once
  // it is selected, its own folder access is the boundary for the query.
  const mailboxId = selectedFolder ? selectedFolder.mailbox_id : args.mailboxId && allowedMailboxIds.includes(args.mailboxId) ? args.mailboxId : (allowedMailboxIds[0] ?? null);

  if (!selectedFolder && !mailboxId) {
    return { messages: [], ...workspace };
  }

  const q = clean(args.q);
  const from = clean(args.from);
  const to = clean(args.to);

  const filters = [eq(emailMessages.accountId, args.accountId), mailboxId ? inArray(emailMessages.mailboxId, [mailboxId]) : undefined, folderId ? eq(emailMessages.folderId, folderId) : inArray(emailMessages.folderId, allowedFolderIds), q ? or(ilike(emailMessages.subject, `%${q}%`), ilike(emailMessages.fromAddress, `%${q}%`), ilike(emailMessages.bodyText, `%${q}%`)) : undefined, args.unread ? eq(emailMessages.isRead, false) : undefined, args.attachments ? eq(emailMessages.hasAttachments, true) : undefined, args.starred ? eq(emailMessages.isStarred, true) : undefined, from ? ilike(emailMessages.fromAddress, `%${from}%`) : undefined, to ? sql`${emailMessages.toAddresses}::text ilike ${`%${to}%`}` : undefined];

  const orderBy = args.sort === 'oldest' ? asc(emailMessages.receivedAt) : args.sort === 'sender' ? asc(emailMessages.fromAddress) : args.sort === 'subject_asc' ? asc(emailMessages.subject) : args.sort === 'subject_desc' ? desc(emailMessages.subject) : args.sort === 'size_desc' ? desc(emailMessages.rawSize) : args.sort === 'size_asc' ? asc(emailMessages.rawSize) : desc(emailMessages.receivedAt);

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
          inArray(
            emailMessageLabels.messageId,
            rows.map((row) => row.id)
          ),
          args.labelId ? eq(emailLabels.id, args.labelId) : undefined
        )
      );
    labelRows = joined.map((row) => ({
      messageId: row.messageId,
      label: serializeEmailLabel(row.label),
    }));
  }

  const labelsByMessage = new Map<string, ReturnType<typeof serializeEmailLabel>[]>();
  for (const row of labelRows) {
    labelsByMessage.set(row.messageId, [...(labelsByMessage.get(row.messageId) ?? []), row.label]);
  }

  const filteredRows = args.labelId ? rows.filter((row) => labelsByMessage.has(row.id)) : rows;
  const repliedMessageIds = new Set<string>();
  if (filteredRows.length > 0) {
    const repliedRows = await db
      .select({ threadKey: emailMessages.threadKey })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.accountId, args.accountId),
          inArray(
            emailMessages.threadKey,
            filteredRows.map((row) => row.id)
          ),
          isNotNull(emailMessages.sentAt)
        )
      );
    for (const row of repliedRows) {
      if (row.threadKey) repliedMessageIds.add(row.threadKey);
    }
  }

  return {
    messages: filteredRows.map((row) => ({
      ...serializeEmailMessage(row, {
        isReplied: repliedMessageIds.has(row.id),
      }),
      labels: labelsByMessage.get(row.id) ?? [],
    })),
    ...(includeWorkspace ? workspace : {}),
  };
}

export async function getEmailMessageForUser(args: { accountId: string; userId: string; role: AccountRole; messageId: string }) {
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

export async function updateEmailMessageState(args: { accountId: string; userId: string; role: AccountRole; messageId: string; isRead?: boolean; isStarred?: boolean; folderId?: string }) {
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
      folderSource: args.folderId ? 'local' : current.message.folderSource,
      imapFlags: typeof args.isRead === 'boolean' ? readFlags(current.message.imapFlags, args.isRead) : current.message.imapFlags,
      updatedAt: new Date(),
    })
    .where(and(eq(emailMessages.id, args.messageId), eq(emailMessages.accountId, args.accountId)))
    .returning();

  if (typeof args.isRead === 'boolean' && args.isRead !== current.message.isRead) {
    await syncReadStateToImap({
      accountId: args.accountId,
      userId: args.userId,
      messages: [updated],
      isRead: args.isRead,
    });
  }

  await db.insert(emailAuditEvents).values({
    accountId: args.accountId,
    userId: args.userId,
    mailboxId: updated.mailboxId,
    folderId: updated.folderId,
    messageId: updated.id,
    eventType: args.folderId ? 'message.moved' : typeof args.isStarred === 'boolean' ? 'message.starred_changed' : 'message.read_state_changed',
    metadata: {
      is_read: updated.isRead,
      is_starred: updated.isStarred,
      folder_id: updated.folderId,
    },
  });

  await publishEmailMessageEvent('email.message.updated', updated, args.folderId ? 'moved' : 'state_changed');

  return updated;
}

export async function updateEmailMessagesBatch(args: { accountId: string; userId: string; role: AccountRole; messageIds: string[]; isRead?: boolean; isStarred?: boolean; folderId?: string }) {
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
      })
    );
  }
  return updated;
}

export async function markEmailMailboxAsRead(args: { accountId: string; userId: string; role: AccountRole; mailboxId: string }) {
  const permission = await resolveEmailPermission({
    accountId: args.accountId,
    userId: args.userId,
    role: args.role,
    mailboxId: args.mailboxId,
  });
  if (!permission.canRead) {
    throw new Error('You do not have permission to read this mailbox.');
  }

  // A folder-only grant must never expand into access to the complete mailbox.
  // Resolve the actual readable folders before applying the bulk update.
  const accessibleFolders = await listAccessibleFolders({
    accountId: args.accountId,
    userId: args.userId,
    role: args.role,
    mailboxIds: [args.mailboxId],
  });
  const accessibleFolderIds = accessibleFolders.filter((folder) => folder.mailboxId === args.mailboxId).map((folder) => folder.id);

  const updated =
    accessibleFolderIds.length === 0
      ? []
      : await db
          .update(emailMessages)
          .set({
            isRead: true,
            imapFlags: sql`array_append(array_remove(${emailMessages.imapFlags}, '\\Seen'), '\\Seen')`,
            updatedAt: new Date(),
          })
          .where(and(eq(emailMessages.accountId, args.accountId), eq(emailMessages.mailboxId, args.mailboxId), inArray(emailMessages.folderId, accessibleFolderIds), eq(emailMessages.folderSource, 'imap'), eq(emailMessages.isRead, false)))
          .returning();

  await syncReadStateToImap({
    accountId: args.accountId,
    userId: args.userId,
    messages: updated,
    isRead: true,
  });

  await db.insert(emailAuditEvents).values({
    accountId: args.accountId,
    userId: args.userId,
    mailboxId: args.mailboxId,
    eventType: 'mailbox.marked_read',
    metadata: { message_count: updated.length },
  });

  if (updated.length > 0) {
    await Promise.all(updated.map((row) => publishEmailMessageEvent('email.message.updated', row, 'mailbox_marked_read')));
  }

  return { updated: updated.length };
}

export async function markEmailFolderAsRead(args: { accountId: string; userId: string; role: AccountRole; folderId: string }) {
  const [folder] = await db
    .select()
    .from(emailFolders)
    .where(and(eq(emailFolders.accountId, args.accountId), eq(emailFolders.id, args.folderId)))
    .limit(1);
  if (!folder) throw new Error('Folder not found.');

  const permission = await resolveEmailPermission({
    accountId: args.accountId,
    userId: args.userId,
    role: args.role,
    mailboxId: folder.mailboxId,
    folderId: folder.id,
  });
  if (!permission.canRead) {
    throw new Error('You do not have permission to read this folder.');
  }

  const updated = await db
    .update(emailMessages)
    .set({
      isRead: true,
      imapFlags: sql`array_append(array_remove(${emailMessages.imapFlags}, '\\Seen'), '\\Seen')`,
      updatedAt: new Date(),
    })
    .where(and(eq(emailMessages.accountId, args.accountId), eq(emailMessages.folderId, folder.id), eq(emailMessages.isRead, false)))
    .returning();

  await syncReadStateToImap({
    accountId: args.accountId,
    userId: args.userId,
    messages: updated,
    isRead: true,
  });

  await db.insert(emailAuditEvents).values({
    accountId: args.accountId,
    userId: args.userId,
    mailboxId: folder.mailboxId,
    folderId: folder.id,
    eventType: 'folder.marked_read',
    metadata: { folder_name: folder.name, message_count: updated.length },
  });

  if (updated.length > 0) {
    await Promise.all(updated.map((row) => publishEmailMessageEvent('email.message.updated', row, 'folder_marked_read')));
  }

  return { updated: updated.length };
}

export async function listEmailAttachmentsForUser(args: { accountId: string; userId: string; role: AccountRole; messageId: string }) {
  const current = await getEmailMessageForUser(args);
  if (!current) throw new Error('Message not found or not permitted.');

  const rows = await db
    .select()
    .from(emailAttachments)
    .where(and(eq(emailAttachments.accountId, args.accountId), eq(emailAttachments.messageId, args.messageId)))
    .orderBy(asc(emailAttachments.fileName));

  return rows.map(serializeEmailAttachment);
}

export async function getEmailAttachmentDownloadForUser(args: { accountId: string; userId: string; role: AccountRole; attachmentId: string }) {
  const [attachment] = await db
    .select()
    .from(emailAttachments)
    .where(and(eq(emailAttachments.accountId, args.accountId), eq(emailAttachments.id, args.attachmentId)))
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

export async function getEmailAttachmentFileForUser(args: { accountId: string; userId: string; role: AccountRole; attachmentId: string }) {
  const [attachment] = await db
    .select()
    .from(emailAttachments)
    .where(and(eq(emailAttachments.accountId, args.accountId), eq(emailAttachments.id, args.attachmentId)))
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

async function exportUnreadFoldersPdfAttachmentsForUser(args: { accountId: string; userId: string; role: AccountRole; folderIds: string[] }) {
  const folderIds = [...new Set(args.folderIds)].filter(Boolean).slice(0, 50);
  if (folderIds.length === 0) throw new Error('Choose at least one folder.');

  const folders = await db
    .select()
    .from(emailFolders)
    .where(and(eq(emailFolders.accountId, args.accountId), inArray(emailFolders.id, folderIds)));
  if (folders.length !== folderIds.length) throw new Error('Folder not found.');

  for (const folder of folders) {
    const permission = await resolveEmailPermission({
      accountId: args.accountId,
      userId: args.userId,
      role: args.role,
      mailboxId: folder.mailboxId,
      folderId: folder.id,
    });
    if (!permission.canRead) {
      throw new Error('You do not have permission to read this folder.');
    }
  }

  const rows = await db
    .select({
      message: emailMessages,
      attachment: emailAttachments,
    })
    .from(emailAttachments)
    .innerJoin(emailMessages, eq(emailMessages.id, emailAttachments.messageId))
    .where(and(eq(emailMessages.accountId, args.accountId), eq(emailAttachments.accountId, args.accountId), inArray(emailMessages.folderId, folderIds), eq(emailMessages.isRead, false), eq(emailMessages.externalState, 'present'), or(ilike(emailAttachments.contentType, '%pdf%'), ilike(emailAttachments.fileName, '%.pdf'), ilike(emailAttachments.fileName, '%.PDF'))))
    .orderBy(asc(emailMessages.receivedAt), asc(emailAttachments.fileName))
    .limit(301);

  if (rows.length === 0) {
    return null;
  }
  if (rows.length > 300) {
    throw new Error('Hay mas de 300 PDFs pendientes. Divide la descarga en carpetas mas pequenas.');
  }

  const zip = new JSZip();
  const seenPaths = new Set<string>();
  const includedMessageIds = new Set<string>();
  let totalBytes = 0;

  for (const row of rows) {
    const bytes = await getObjectBytes(row.attachment.storageKey);
    totalBytes += bytes.byteLength;
    if (totalBytes > 250 * 1024 * 1024) {
      throw new Error('Los PDFs pendientes superan 250 MB. Divide la descarga en partes mas pequenas.');
    }

    const fileName = safeZipName(row.attachment.fileName, 'adjunto.pdf');
    const path = uniqueZipPath(fileName, seenPaths);
    zip.file(path, bytes);
    includedMessageIds.add(row.message.id);
  }

  const zipBytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const messageIds = [...includedMessageIds];
  const updated = await db
    .update(emailMessages)
    .set({
      isRead: true,
      imapFlags: sql`array_append(array_remove(${emailMessages.imapFlags}, '\\Seen'), '\\Seen')`,
      updatedAt: new Date(),
    })
    .where(and(eq(emailMessages.accountId, args.accountId), inArray(emailMessages.id, messageIds), eq(emailMessages.isRead, false)))
    .returning();

  await syncReadStateToImap({
    accountId: args.accountId,
    userId: args.userId,
    messages: updated,
    isRead: true,
  });

  await db.insert(emailAuditEvents).values({
    accountId: args.accountId,
    userId: args.userId,
    mailboxId: folders.length === 1 ? (folders[0]?.mailboxId ?? null) : null,
    folderId: folders.length === 1 ? (folders[0]?.id ?? null) : null,
    eventType: 'folder.unread_pdfs_exported',
    metadata: {
      folder_ids: folderIds,
      folder_names: folders.map((folder) => folder.name),
      message_count: messageIds.length,
      attachment_count: rows.length,
      bytes: zipBytes.byteLength,
    },
  });

  if (updated.length > 0) {
    await Promise.all(updated.map((row) => publishEmailMessageEvent('email.message.updated', row, 'folder_pdfs_exported')));
  }

  return {
    bytes: zipBytes,
    fileName: folders.length === 1 ? `${safeZipName(folders[0]?.name ?? 'carpeta', 'carpeta')}-pdfs-pendientes.zip` : `pdfs-pendientes-${folders.length}-carpetas.zip`,
    messageCount: messageIds.length,
    attachmentCount: rows.length,
  };
}

export async function exportUnreadFolderPdfAttachmentsForUser(args: { accountId: string; userId: string; role: AccountRole; folderId: string }) {
  return exportUnreadFoldersPdfAttachmentsForUser({
    accountId: args.accountId,
    userId: args.userId,
    role: args.role,
    folderIds: [args.folderId],
  });
}

export async function exportUnreadPdfAttachmentsForFolders(args: { accountId: string; userId: string; role: AccountRole; folderIds: string[] }) {
  return exportUnreadFoldersPdfAttachmentsForUser(args);
}

export async function listEmailLabelsForUser(args: { accountId: string; userId: string; role: AccountRole; mailboxId?: string | null }) {
  const workspace = await listEmailWorkspace(args);
  const mailboxIds = workspace.mailboxes.map((mailbox) => mailbox.id);
  if (mailboxIds.length === 0) return [];
  const effectiveMailboxIds = args.mailboxId && mailboxIds.includes(args.mailboxId) ? [args.mailboxId] : mailboxIds;

  const rows = await db
    .select()
    .from(emailLabels)
    .where(and(eq(emailLabels.accountId, args.accountId), or(inArray(emailLabels.mailboxId, effectiveMailboxIds), sql`${emailLabels.mailboxId} is null`)))
    .orderBy(asc(emailLabels.position), asc(emailLabels.name));

  return rows.map(serializeEmailLabel);
}

export async function createEmailLabelForUser(args: { accountId: string; userId: string; role: AccountRole; mailboxId: string; name: string; color?: string }) {
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

export async function setEmailMessageLabelsForUser(args: { accountId: string; userId: string; role: AccountRole; messageId: string; labelIds: string[] }) {
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
        .where(and(eq(emailLabels.accountId, args.accountId), inArray(emailLabels.id, requestedIds), or(eq(emailLabels.mailboxId, current.message.mailboxId), sql`${emailLabels.mailboxId} is null`)))
    : [];

  await db.transaction(async (tx) => {
    await tx.delete(emailMessageLabels).where(and(eq(emailMessageLabels.accountId, args.accountId), eq(emailMessageLabels.messageId, args.messageId)));

    if (allowedLabels.length > 0) {
      await tx.insert(emailMessageLabels).values(
        allowedLabels.map((label) => ({
          accountId: args.accountId,
          messageId: args.messageId,
          labelId: label.id,
        }))
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

export async function listEmailDraftsForUser(args: { accountId: string; userId: string; role: AccountRole; mailboxId?: string | null }) {
  const workspace = await listEmailWorkspace(args);
  const mailboxIds = workspace.mailboxes.filter((mailbox) => !args.mailboxId || mailbox.id === args.mailboxId).map((mailbox) => mailbox.id);
  if (mailboxIds.length === 0) return [];

  const rows = await db
    .select()
    .from(emailDrafts)
    .where(and(eq(emailDrafts.accountId, args.accountId), eq(emailDrafts.userId, args.userId), inArray(emailDrafts.mailboxId, mailboxIds)))
    .orderBy(desc(emailDrafts.updatedAt));

  return rows.map(serializeEmailDraft);
}

export async function upsertEmailDraftForUser(args: { accountId: string; userId: string; role: AccountRole; draftId?: string | null; mailboxId: string; to: string[]; cc?: string[]; bcc?: string[]; subject?: string; text?: string; html?: string | null; attachments?: unknown; inReplyToMessageId?: string | null }) {
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
      .where(and(eq(emailDrafts.accountId, args.accountId), eq(emailDrafts.userId, args.userId), eq(emailDrafts.id, args.draftId)))
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

export async function deleteEmailDraftForUser(args: { accountId: string; userId: string; draftId: string }) {
  const rows = await db
    .delete(emailDrafts)
    .where(and(eq(emailDrafts.accountId, args.accountId), eq(emailDrafts.userId, args.userId), eq(emailDrafts.id, args.draftId)))
    .returning();
  return rows[0] ?? null;
}

async function rulesFor(accountId: string, mailboxId: string) {
  return db
    .select()
    .from(emailRules)
    .where(and(eq(emailRules.accountId, accountId), eq(emailRules.enabled, true), or(eq(emailRules.mailboxId, mailboxId), sql`${emailRules.mailboxId} is null`)))
    .orderBy(asc(emailRules.position));
}

type EmailSyncCursor = {
  folders?: Record<string, { last_uid?: number; uid_validity?: string }>;
  last_uid?: number;
  uid_validity?: string;
};

function sameImapFlags(left: string[] | null | undefined, right: string[]) {
  const normalize = (flags: string[] | null | undefined) => [...new Set((flags ?? []).map((flag) => flag.toLowerCase()))].sort();
  const a = normalize(left);
  const b = normalize(right);
  return a.length === b.length && a.every((flag, index) => flag === b[index]);
}

function readFlags(flags: string[] | null | undefined, isRead: boolean) {
  const next = (flags ?? []).filter((flag) => flag.toLowerCase() !== '\\seen');
  if (isRead) next.push('\\Seen');
  return [...new Set(next)];
}

async function syncReadStateToImap(args: { accountId: string; userId: string | null; messages: (typeof emailMessages.$inferSelect)[]; isRead: boolean }) {
  const rows = args.messages.filter((message) => message.imapUid > 0 && message.imapMailbox);
  if (rows.length === 0) return;

  const emailAccountIds = [...new Set(rows.map((message) => message.emailAccountId))];
  const accounts = await db
    .select()
    .from(emailAccounts)
    .where(and(eq(emailAccounts.accountId, args.accountId), inArray(emailAccounts.id, emailAccountIds)));
  const accountsById = new Map(accounts.map((account) => [account.id, account]));

  for (const emailAccountId of emailAccountIds) {
    const account = accountsById.get(emailAccountId);
    if (!account || !account.enabled) continue;

    const credentials = decryptEmailCredentials(account.encryptedCredentials as Record<string, unknown>);
    const client = new ImapFlow({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapSecure,
      auth: { user: credentials.imap_user, pass: credentials.imap_password },
      logger: false,
    });

    try {
      await client.connect();
      const byMailbox = new Map<string, number[]>();
      for (const message of rows.filter((row) => row.emailAccountId === emailAccountId)) {
        byMailbox.set(message.imapMailbox, [...(byMailbox.get(message.imapMailbox) ?? []), message.imapUid]);
      }

      for (const [imapMailbox, uids] of byMailbox) {
        const lock = await client.getMailboxLock(imapMailbox);
        try {
          await client.mailboxOpen(imapMailbox);
          if (args.isRead) {
            await client.messageFlagsAdd(uids, ['\\Seen'], {
              uid: true,
              silent: true,
            });
          } else {
            await client.messageFlagsRemove(uids, ['\\Seen'], {
              uid: true,
              silent: true,
            });
          }
        } finally {
          lock.release();
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not update IMAP flags.';
      console.warn('[email] failed to sync read state to IMAP', {
        emailAccountId,
        isRead: args.isRead,
        error: message,
      });
      await db.insert(emailAuditEvents).values({
        accountId: args.accountId,
        userId: args.userId,
        eventType: 'message.read_state_imap_failed',
        metadata: {
          email_account_id: emailAccountId,
          is_read: args.isRead,
          error: message,
        },
      });
    } finally {
      await client.logout().catch(() => undefined);
    }
  }
}

async function ensureImapFolder(accountId: string, mailboxId: string, path: string, specialUse?: string) {
  const normalized = path.toLowerCase() === 'inbox' ? 'inbox' : path;
  const special = specialUse?.toLowerCase();
  const spamLike = special === '\\junk' || ['junk', 'spam', 'correo no deseado'].includes(path.trim().toLowerCase());
  const mapped =
    special === '\\sent'
      ? { slug: 'sent', name: 'Enviados', kind: 'sent' as const, position: 10 }
      : special === '\\trash'
        ? {
            slug: 'trash',
            name: 'Papelera',
            kind: 'trash' as const,
            position: 30,
          }
        : special === '\\archive'
          ? {
              slug: 'archive',
              name: 'Archivo',
              kind: 'archive' as const,
              position: 20,
            }
          : spamLike
            ? {
                slug: `imap-${slugify(path)}`,
                name: 'SPAM',
                kind: 'custom' as const,
                position: 90,
              }
            : normalized === 'inbox'
              ? {
                  slug: 'inbox',
                  name: 'Entrada',
                  kind: 'inbox' as const,
                  position: 0,
                }
              : {
                  slug: `imap-${slugify(path)}`,
                  name: path,
                  kind: 'custom' as const,
                  position: 100,
                };

  const [existing] = await db
    .select()
    .from(emailFolders)
    .where(and(eq(emailFolders.mailboxId, mailboxId), eq(emailFolders.slug, mapped.slug)))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(emailFolders)
    .values({ mailboxId, accountId, ...mapped })
    .returning();
  return created;
}

async function applyMatchingRulesToImportedMessage(args: { accountId: string; userId?: string | null; mailboxId: string; message: typeof emailMessages.$inferSelect; candidate: RuleCandidate; rules: EmailRuleLike[] }) {
  const matched = args.rules.filter((rule) => matchEmailRule(rule, args.candidate));
  if (matched.length === 0) return args.message;

  const now = new Date();
  let nextFolderId = args.message.folderId;
  let nextIsRead = args.message.isRead;
  let nextIsStarred = args.message.isStarred;
  const auditRows: Array<typeof emailAuditEvents.$inferInsert> = [];

  for (const rule of matched) {
    const action = clean(rule.action) || 'move_to';
    if ((action === 'move_to' || action === 'copy_to') && rule.targetFolderId) {
      nextFolderId = rule.targetFolderId;
    } else if (action === 'mark_read') {
      nextIsRead = true;
    } else if (action === 'mark_unread') {
      nextIsRead = false;
    } else if (action === 'star') {
      nextIsStarred = true;
    } else if (action === 'label' && rule.actionValue) {
      const [label] = await db
        .select({ id: emailLabels.id })
        .from(emailLabels)
        .where(and(eq(emailLabels.accountId, args.accountId), eq(emailLabels.id, rule.actionValue)))
        .limit(1);
      if (label) {
        await db
          .insert(emailMessageLabels)
          .values({
            accountId: args.accountId,
            messageId: args.message.id,
            labelId: label.id,
          })
          .onConflictDoNothing();
      }
    }

    auditRows.push({
      accountId: args.accountId,
      userId: args.userId ?? null,
      mailboxId: args.mailboxId,
      folderId: action === 'move_to' || action === 'copy_to' ? (rule.targetFolderId ?? nextFolderId) : nextFolderId,
      messageId: args.message.id,
      eventType: 'rule.applied',
      metadata: { rule_id: rule.id, action },
    });
  }

  if (auditRows.length > 0) {
    await db.insert(emailAuditEvents).values(auditRows);
  }

  if (nextFolderId === args.message.folderId && nextIsRead === args.message.isRead && nextIsStarred === args.message.isStarred) {
    return args.message;
  }

  const [updated] = await db
    .update(emailMessages)
    .set({
      folderId: nextFolderId,
      folderSource: nextFolderId !== args.message.folderId ? 'local' : args.message.folderSource,
      isRead: nextIsRead,
      isStarred: nextIsStarred,
      updatedAt: now,
    })
    .where(and(eq(emailMessages.accountId, args.accountId), eq(emailMessages.id, args.message.id)))
    .returning();

  return updated ?? args.message;
}

async function listEmailNotificationRecipients(args: { accountId: string; mailboxId: string; folderId: string }) {
  const recipients = new Set<string>();

  const adminRows = await db
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(and(eq(profiles.accountId, args.accountId), inArray(profiles.accountRole, ['owner', 'admin'])));
  for (const row of adminRows) recipients.add(row.userId);

  const [mailbox] = await db
    .select({
      ownerUserId: emailMailboxes.ownerUserId,
      kind: emailMailboxes.kind,
    })
    .from(emailMailboxes)
    .where(and(eq(emailMailboxes.accountId, args.accountId), eq(emailMailboxes.id, args.mailboxId)))
    .limit(1);
  if (mailbox?.kind === 'personal' && mailbox.ownerUserId) {
    recipients.add(mailbox.ownerUserId);
  }

  const userPermissionRows = await db
    .select({ userId: emailUserPermissions.userId })
    .from(emailUserPermissions)
    .where(and(eq(emailUserPermissions.accountId, args.accountId), eq(emailUserPermissions.canRead, true), or(eq(emailUserPermissions.folderId, args.folderId), and(eq(emailUserPermissions.mailboxId, args.mailboxId), isNull(emailUserPermissions.folderId)))));
  for (const row of userPermissionRows) recipients.add(row.userId);

  const departmentPermissionRows = await db
    .select({ userId: departmentMembers.userId })
    .from(emailPermissions)
    .innerJoin(departmentMembers, eq(departmentMembers.departmentId, emailPermissions.departmentId))
    .where(and(eq(emailPermissions.accountId, args.accountId), eq(departmentMembers.accountId, args.accountId), eq(emailPermissions.canRead, true), or(eq(emailPermissions.folderId, args.folderId), and(eq(emailPermissions.mailboxId, args.mailboxId), isNull(emailPermissions.folderId)))));
  for (const row of departmentPermissionRows) recipients.add(row.userId);

  return [...recipients];
}

async function notifyNewEmailMessage(row: typeof emailMessages.$inferSelect) {
  const recipients = await listEmailNotificationRecipients({
    accountId: row.accountId,
    mailboxId: row.mailboxId,
    folderId: row.folderId,
  });
  if (recipients.length === 0) return;

  const sender = row.fromName?.trim() || row.fromAddress;
  const subject = row.subject || '(Sin asunto)';
  const body = row.snippet || subject;

  await Promise.all(
    recipients.map((userId) =>
      createRealtimeNotification({
        accountId: row.accountId,
        userId,
        type: 'email_new_message',
        title: `Nuevo correo de ${sender}`,
        body,
      }).catch((error) => {
        console.warn('[notifications] failed to create email notification:', error);
      })
    )
  );
}

export async function importEmailAccount(args: { accountId: string; emailAccountId: string; userId?: string | null; maxMessages?: number | null; resetExisting?: boolean; fullScan?: boolean; since?: Date | string | null; notify?: boolean }) {
  const [account] = await db
    .select()
    .from(emailAccounts)
    .where(and(eq(emailAccounts.accountId, args.accountId), eq(emailAccounts.id, args.emailAccountId)))
    .limit(1);
  if (!account || !account.enabled) return { imported: 0, skipped: 0, moved: 0, missing: 0 };

  const [mailbox] = await db
    .select()
    .from(emailMailboxes)
    .where(and(eq(emailMailboxes.accountId, args.accountId), eq(emailMailboxes.emailAccountId, account.id)))
    .limit(1);
  if (!mailbox) throw new Error('Email mailbox is missing.');

  const credentials = decryptEmailCredentials(account.encryptedCredentials as Record<string, unknown>);
  const resetExisting = args.resetExisting === true;
  const fullScan = args.fullScan === true;
  const since = asDate(args.since) ?? null;

  if (resetExisting) {
    const attachmentRows = await db
      .select({ storageKey: emailAttachments.storageKey })
      .from(emailAttachments)
      .innerJoin(emailMessages, eq(emailMessages.id, emailAttachments.messageId))
      .where(and(eq(emailMessages.accountId, args.accountId), eq(emailMessages.emailAccountId, account.id)));
    const deletedRows = await db.transaction(async (tx) => {
      const deleted = await tx
        .delete(emailMessages)
        .where(and(eq(emailMessages.accountId, args.accountId), eq(emailMessages.emailAccountId, account.id)))
        .returning({ id: emailMessages.id });
      await tx.insert(emailAuditEvents).values({
        accountId: args.accountId,
        userId: args.userId ?? null,
        mailboxId: mailbox.id,
        eventType: 'email.import_reset',
        metadata: {
          email_account_id: account.id,
          deleted_messages: deleted.length,
          since: serializeDate(since),
        },
      });
      return deleted;
    });
    await Promise.all(
      attachmentRows.map((row) =>
        deleteObject(row.storageKey).catch((error) => {
          console.warn('[email] failed to delete old attachment during import reset', {
            emailAccountId: account.id,
            storageKey: row.storageKey,
            error: error instanceof Error ? error.message : String(error),
          });
        })
      )
    );
    void deletedRows;
  }

  const cursor = resetExisting || fullScan ? {} : ((account.syncCursor as EmailSyncCursor | null) ?? {});
  const folderCursors = cursor.folders ?? {
    [account.syncMailbox]: {
      last_uid: cursor.last_uid,
      uid_validity: cursor.uid_validity,
    },
  };
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: { user: credentials.imap_user, pass: credentials.imap_password },
    logger: false,
  });

  let imported = 0;
  let skipped = 0;
  let moved = 0;
  let missing = 0;
  const limit = args.maxMessages ?? 50;
  const seen = new Set<string>();
  const seenMessageIds = new Set<string>();

  try {
    await client.connect();
    const listed = await client.list();
    const folders = listed.filter((item) => item.listed && item.path && !item.flags.has('\\Noselect'));
    const existingRows = resetExisting ? [] : await db.select().from(emailMessages).where(eq(emailMessages.emailAccountId, account.id));
    const byMessageId = new Map(existingRows.filter((row) => row.messageId).map((row) => [row.messageId as string, row]));
    const byImapIdentity = new Map(existingRows.map((row) => [`${row.imapMailbox}:${row.imapUidValidity}:${row.imapUid}`, row]));
    const rules = await rulesFor(args.accountId, mailbox.id);

    for (const remoteFolder of folders) {
      const lock = await client.getMailboxLock(remoteFolder.path);
      try {
        const info = await client.mailboxOpen(remoteFolder.path, {
          readOnly: true,
        });
        const uidValidity = String(info.uidValidity ?? '0');
        const previous = folderCursors[remoteFolder.path];
        const fromUid = fullScan ? 1 : previous?.uid_validity === uidValidity ? (previous.last_uid ?? 0) + 1 : 1;
        const allUidsResult = await client.search({ all: true }, { uid: true });
        const allUids = Array.isArray(allUidsResult) ? allUidsResult : [];
        for (const uid of allUids) seen.add(`${remoteFolder.path}:${uidValidity}:${uid}`);

        // Flags can change on old messages from another mail client. Fetch only
        // metadata here so read/unread state stays realtime without redownloading
        // bodies or attachments.
        for await (const meta of client.fetch('1:*', { uid: true, flags: true }, { uid: true })) {
          if (!meta.uid) continue;
          const existing = byImapIdentity.get(`${remoteFolder.path}:${uidValidity}:${meta.uid}`);
          if (!existing) continue;
          const flags = sanitizeDbTextArray([...(meta.flags ?? [])]);
          const isRead = flags.some((flag) => flag.toLowerCase() === '\\seen');
          if (existing.isRead === isRead && sameImapFlags(existing.imapFlags, flags)) continue;
          const [updated] = await db
            .update(emailMessages)
            .set({
              isRead,
              imapFlags: flags,
              externalState: 'present',
              lastImapSyncAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(emailMessages.id, existing.id))
            .returning();
          if (updated) {
            byImapIdentity.set(`${remoteFolder.path}:${uidValidity}:${meta.uid}`, updated);
            await publishEmailMessageEvent('email.message.updated', updated, 'imap_flags_changed');
          }
        }

        const eligibleUids = since ? ((await client.search({ since }, { uid: true })) as number[]).filter((uid) => uid >= fromUid) : allUids.filter((uid) => uid >= fromUid);
        const advancePastHistorical = resetExisting && Boolean(since);
        let folderMaxUid = advancePastHistorical ? Math.max(0, ...allUids, fromUid - 1) : Math.max(0, fromUid - 1);
        if (eligibleUids.length === 0) {
          folderCursors[remoteFolder.path] = {
            last_uid: folderMaxUid,
            uid_validity: uidValidity,
          };
          continue;
        }
        for await (const msg of client.fetch(
          eligibleUids,
          {
            uid: true,
            source: true,
            flags: true,
            internalDate: true,
            size: true,
          },
          { uid: true }
        )) {
          if (!msg.uid || msg.uid < fromUid) continue;
          if (limit !== null && imported >= limit) break;
          folderMaxUid = Math.max(folderMaxUid, msg.uid);
          const source = msg.source ? Buffer.from(msg.source) : null;
          if (!source) {
            skipped++;
            continue;
          }

          const parsed = await simpleParser(source);
          const from = firstAddress(parsed.from);
          const toAddresses = addressList(parsed.to);
          const ccAddresses = addressList(parsed.cc);
          const subject = sanitizeDbText(parsed.subject) || '(Sin asunto)';
          const bodyText = sanitizeDbTextOrNull(parsed.text);
          const bodyHtml = typeof parsed.html === 'string' ? sanitizeDbTextOrNull(parsed.html) : null;
          const candidate = {
            fromAddress: from.address,
            toAddresses,
            ccAddresses,
            subject,
            bodyText: bodyText ?? '',
            sizeBytes: msg.size ?? source.byteLength,
            hasAttachment: parsed.attachments.length > 0,
            date: parsed.date ?? msg.internalDate,
          };
          const externalFolder = await ensureImapFolder(args.accountId, mailbox.id, remoteFolder.path, remoteFolder.specialUse);
          const targetFolderId = resolveRuleTargetFolder(rules, candidate) ?? externalFolder.id;
          const flags = sanitizeDbTextArray([...(msg.flags ?? [])]);
          const parsedMessageId = sanitizeDbTextOrNull(parsed.messageId);
          const existing = parsedMessageId ? byMessageId.get(parsedMessageId) : undefined;
          let row: typeof emailMessages.$inferSelect | undefined;

          if (existing) {
            const [updated] = await db
              .update(emailMessages)
              .set({
                imapMailbox: remoteFolder.path,
                imapUidValidity: uidValidity,
                imapUid: msg.uid,
                imapFlags: flags,
                externalState: 'present',
                lastImapSyncAt: new Date(),
                folderId: existing.folderSource === 'imap' ? targetFolderId : existing.folderId,
                updatedAt: new Date(),
              })
              .where(eq(emailMessages.id, existing.id))
              .returning();
            row = updated;
            byImapIdentity.set(`${remoteFolder.path}:${uidValidity}:${msg.uid}`, updated);
            if (updated.messageId) seenMessageIds.add(updated.messageId);
            if (existing.imapMailbox !== remoteFolder.path) moved++;
            await publishEmailMessageEvent('email.message.updated', updated, existing.imapMailbox !== remoteFolder.path ? 'moved_externally' : 'imap_refreshed');
          } else {
            const [created] = await db
              .insert(emailMessages)
              .values({
                accountId: args.accountId,
                emailAccountId: account.id,
                mailboxId: mailbox.id,
                folderId: targetFolderId,
                imapMailbox: remoteFolder.path,
                imapUidValidity: uidValidity,
                imapUid: msg.uid,
                imapFlags: flags,
                externalState: 'present',
                folderSource: targetFolderId === externalFolder.id ? 'imap' : 'local',
                lastImapSyncAt: new Date(),
                messageId: parsedMessageId,
                threadKey: sanitizeDbTextOrNull(parsed.references?.toString() ?? parsed.inReplyTo ?? parsedMessageId),
                subject,
                fromName: from.name,
                fromAddress: from.address,
                toAddresses,
                ccAddresses,
                bccAddresses: addressList(parsed.bcc),
                replyToAddresses: addressList(parsed.replyTo),
                receivedAt: parsed.date ?? asDate(msg.internalDate) ?? new Date(),
                sentAt: parsed.date ?? null,
                snippet: snippet(parsed),
                bodyText,
                bodyHtml,
                isRead: flags.some((flag) => flag.toLowerCase() === '\\seen'),
                hasAttachments: parsed.attachments.length > 0,
                rawHeaders: sanitizeJsonForDb(parsed.headers) as Record<string, unknown>,
                rawSize: msg.size ?? source.byteLength,
              })
              .onConflictDoNothing()
              .returning();
            if (!created) {
              skipped++;
              continue;
            }
            row = created;
            byImapIdentity.set(`${remoteFolder.path}:${uidValidity}:${msg.uid}`, created);
            if (created.messageId) seenMessageIds.add(created.messageId);
            for (const attachment of parsed.attachments) {
              const fileName = sanitizeDbText(attachment.filename) || 'attachment';
              const storageKey = `email/${args.accountId}/${created.id}/${crypto.randomUUID()}-${fileName}`;
              await putObject({
                key: storageKey,
                body: attachment.content,
                contentType: sanitizeDbText(attachment.contentType) || undefined,
              });
              await db.insert(emailAttachments).values({
                accountId: args.accountId,
                messageId: created.id,
                fileName,
                contentType: sanitizeDbTextOrNull(attachment.contentType),
                size: attachment.size,
                storageKey,
                contentId: sanitizeDbTextOrNull(attachment.contentId),
              });
            }
            const createdWithRules = await applyMatchingRulesToImportedMessage({
              accountId: args.accountId,
              userId: args.userId ?? null,
              mailboxId: mailbox.id,
              message: created,
              candidate,
              rules,
            });
            row = createdWithRules;
            byMessageId.set(createdWithRules.messageId ?? createdWithRules.id, createdWithRules);
            await db.insert(emailAuditEvents).values({
              accountId: args.accountId,
              userId: args.userId ?? null,
              mailboxId: mailbox.id,
              folderId: createdWithRules.folderId,
              messageId: createdWithRules.id,
              eventType: 'message.imported',
              metadata: { imap_uid: msg.uid, copied_from: remoteFolder.path },
            });
            if (args.notify !== false) await notifyNewEmailMessage(createdWithRules);
            await publishEmailMessageEvent('email.message.created', createdWithRules, 'imported');
            imported++;
          }
          void row;
        }
        folderCursors[remoteFolder.path] = {
          last_uid: folderMaxUid,
          uid_validity: uidValidity,
        };
      } finally {
        lock.release();
      }
    }

    for (const row of since ? [] : existingRows) {
      const identity = `${row.imapMailbox}:${row.imapUidValidity}:${row.imapUid}`;
      if (row.externalState === 'present' && !seen.has(identity) && !seenMessageIds.has(row.messageId ?? '')) {
        const [updated] = await db
          .update(emailMessages)
          .set({
            externalState: 'missing',
            lastImapSyncAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(emailMessages.id, row.id))
          .returning();
        if (updated) {
          missing++;
          await db.insert(emailAuditEvents).values({
            accountId: args.accountId,
            userId: args.userId ?? null,
            mailboxId: updated.mailboxId,
            folderId: updated.folderId,
            messageId: updated.id,
            eventType: 'message.external_missing',
            metadata: {
              imap_mailbox: updated.imapMailbox,
              imap_uid: updated.imapUid,
            },
          });
          await publishEmailMessageEvent('email.message.deleted', updated, 'missing_externally');
        }
      }
    }

    await db
      .update(emailAccounts)
      .set({
        syncCursor: { folders: folderCursors },
        lastSyncedAt: new Date(),
        status: 'active',
        lastError: null,
      })
      .where(eq(emailAccounts.id, account.id));
  } catch (error) {
    const message = compactImportError(error);
    await db.update(emailAccounts).set({ status: 'error', lastError: message }).where(eq(emailAccounts.id, account.id));
    throw error;
  } finally {
    await client.logout().catch(() => undefined);
  }

  return { imported, skipped, moved, missing };
}

export async function importAllEmailAccounts(args: { accountId?: string; userId?: string | null; maxMessages?: number | null; resetExisting?: boolean; fullScan?: boolean; since?: Date | string | null; notify?: boolean }) {
  const rows = await db
    .select()
    .from(emailAccounts)
    .where(args.accountId ? and(eq(emailAccounts.accountId, args.accountId), eq(emailAccounts.enabled, true)) : eq(emailAccounts.enabled, true));
  let imported = 0;
  let skipped = 0;
  let moved = 0;
  let missing = 0;
  for (const row of rows) {
    const result = await importEmailAccount({
      accountId: row.accountId,
      emailAccountId: row.id,
      userId: args.userId ?? null,
      maxMessages: args.maxMessages,
      resetExisting: args.resetExisting,
      fullScan: args.fullScan,
      since: args.since,
      notify: args.notify,
    });
    imported += result.imported;
    skipped += result.skipped;
    moved += result.moved;
    missing += result.missing;
  }
  return { imported, skipped, moved, missing, accounts: rows.length };
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
    contentBase64?: string;
    contentId?: string;
    sourceAttachmentId?: string;
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

  const preparedAttachments: Array<{
    filename: string;
    contentType?: string;
    bytes: Buffer;
    contentId?: string;
  }> = [];
  let totalAttachmentBytes = 0;
  for (const attachment of args.attachments ?? []) {
    let bytes: Buffer;
    let filename = attachment.filename || 'attachment';
    let contentType = attachment.contentType;

    if (attachment.sourceAttachmentId) {
      const source = await getEmailAttachmentFileForUser({
        accountId: args.accountId,
        userId: args.userId,
        role: args.role,
        attachmentId: attachment.sourceAttachmentId,
      });
      bytes = Buffer.from(source.bytes);
      filename = attachment.filename || source.file_name || filename;
      contentType = attachment.contentType || source.content_type || undefined;
    } else if (attachment.contentBase64) {
      bytes = Buffer.from(attachment.contentBase64, 'base64');
    } else {
      continue;
    }

    totalAttachmentBytes += bytes.byteLength;
    if (totalAttachmentBytes > 20 * 1024 * 1024) {
      throw new Error('Attachments exceed the 20 MB limit.');
    }
    preparedAttachments.push({
      filename,
      contentType,
      bytes,
      contentId: attachment.contentId,
    });
  }

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
    attachments: preparedAttachments.map((attachment) => ({
      filename: attachment.filename || 'attachment',
      contentType: attachment.contentType,
      content: attachment.bytes,
      cid: attachment.contentId,
    })),
  });

  const [sentFolder] = await db
    .select()
    .from(emailFolders)
    .where(and(eq(emailFolders.accountId, args.accountId), eq(emailFolders.mailboxId, mailbox.id), eq(emailFolders.kind, 'sent')))
    .limit(1);

  let sentMessageId: string | null = null;
  let sentMessage: typeof emailMessages.$inferSelect | null = null;
  if (sentFolder) {
    const now = new Date();
    const localUid = Math.floor(now.getTime() / 1000) + Math.floor(Math.random() * 1000);
    const [createdSentMessage] = await db
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
        hasAttachments: preparedAttachments.length > 0,
        rawHeaders: {},
        rawSize: null,
      })
      .returning();
    sentMessage = createdSentMessage;
    sentMessageId = createdSentMessage.id;

    for (const attachment of preparedAttachments) {
      const fileName = attachment.filename || 'attachment';
      const storageKey = `email/${args.accountId}/${createdSentMessage.id}/${crypto.randomUUID()}-${fileName}`;
      await putObject({
        key: storageKey,
        body: attachment.bytes,
        contentType: attachment.contentType,
      });
      await db.insert(emailAttachments).values({
        accountId: args.accountId,
        messageId: createdSentMessage.id,
        fileName,
        contentType: attachment.contentType,
        size: attachment.bytes.byteLength,
        storageKey,
        contentId: attachment.contentId ?? null,
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
      attachment_count: preparedAttachments.length,
      in_reply_to_message_id: args.inReplyToMessageId ?? null,
    },
  });

  if (sentMessage) {
    await publishEmailMessageEvent('email.message.created', sentMessage, 'sent');
  }

  return {
    message_id: info.messageId ?? null,
    stored_message_id: sentMessageId,
  };
}

export async function importThunderbirdRules(args: { accountId: string; mailboxId: string; rules: ThunderbirdRuleInput[] }) {
  let position = 0;
  const created = [];
  let skippedDuplicates = 0;
  const existingRules = await db
    .select()
    .from(emailRules)
    .where(and(eq(emailRules.accountId, args.accountId), eq(emailRules.mailboxId, args.mailboxId)))
    .orderBy(asc(emailRules.position), asc(emailRules.createdAt));
  const seen = new Set(existingRules.map(ruleDedupeKey));

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

    const key = ruleDedupeKey({
      ...rule,
      mailboxId: args.mailboxId,
      targetFolderId: folder.id,
      actionValue: rule.actionValue ?? null,
    });
    if (seen.has(key)) {
      skippedDuplicates += 1;
      continue;
    }
    seen.add(key);

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
  const removedDuplicates = await deleteDuplicateEmailRules(args.accountId, args.mailboxId);
  return { created, skippedDuplicates, removedDuplicates };
}

function normalizeRuleText(value: unknown) {
  return clean(value).toLowerCase();
}

function ruleDedupeKey(rule: { mailboxId?: string | null; targetFolderId?: string | null; action?: string | null; actionValue?: string | null; field: string; operator: string; value: string }) {
  return [rule.mailboxId ?? '', rule.targetFolderId ?? '', normalizeRuleText(rule.action || 'move_to'), normalizeRuleText(rule.actionValue), normalizeRuleText(rule.field), normalizeRuleText(rule.operator || 'contains'), normalizeRuleText(rule.value)].join('\u001f');
}

async function deleteDuplicateEmailRules(accountId: string, mailboxId: string) {
  const rows = await db
    .select()
    .from(emailRules)
    .where(and(eq(emailRules.accountId, accountId), eq(emailRules.mailboxId, mailboxId)))
    .orderBy(asc(emailRules.position), asc(emailRules.createdAt), asc(emailRules.id));
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  for (const row of rows) {
    const key = ruleDedupeKey(row);
    if (seen.has(key)) duplicateIds.push(row.id);
    else seen.add(key);
  }
  if (duplicateIds.length === 0) return 0;
  const deleted = await db
    .delete(emailRules)
    .where(and(eq(emailRules.accountId, accountId), inArray(emailRules.id, duplicateIds)))
    .returning({ id: emailRules.id });
  return deleted.length;
}
