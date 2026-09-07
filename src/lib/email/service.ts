import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
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
  emailFolders,
  emailMailboxes,
  emailMessages,
  emailPermissions,
  emailRules,
} from '@/db/schema';
import { putObject } from '@/lib/storage/alarik';
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

export function serializeEmailMessage(row: typeof emailMessages.$inferSelect) {
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
    has_attachments: row.hasAttachments,
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

export async function listEmailAdminState(accountId: string) {
  const [
    accountRows,
    mailboxRows,
    folderRows,
    permissionRows,
    departmentRows,
    ruleRows,
    auditRows,
  ] = await Promise.all([
    db.select().from(emailAccounts).where(eq(emailAccounts.accountId, accountId)),
    db.select().from(emailMailboxes).where(eq(emailMailboxes.accountId, accountId)),
    db.select().from(emailFolders).where(eq(emailFolders.accountId, accountId)),
    db.select().from(emailPermissions).where(eq(emailPermissions.accountId, accountId)),
    db.select().from(departments).where(eq(departments.accountId, accountId)).orderBy(asc(departments.name)),
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
    permissions: permissionRows.map((row) => ({
      id: row.id,
      department_id: row.departmentId,
      mailbox_id: row.mailboxId,
      folder_id: row.folderId,
      can_read: row.canRead,
      can_move: row.canMove,
      can_classify: row.canClassify,
      can_send: row.canSend,
    })),
    departments: departmentRows,
    rules: ruleRows,
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
  departmentId: string;
  mailboxId: string;
  folderId?: string | null;
  canRead: boolean;
  canMove: boolean;
  canClassify: boolean;
  canSend: boolean;
}) {
  const [row] = await db
    .insert(emailPermissions)
    .values({
      accountId: args.accountId,
      departmentId: args.departmentId,
      mailboxId: args.mailboxId,
      folderId: args.folderId ?? null,
      canRead: args.canRead,
      canMove: args.canMove,
      canClassify: args.canClassify,
      canSend: args.canSend,
    })
    .onConflictDoUpdate({
      target: [
        emailPermissions.departmentId,
        emailPermissions.mailboxId,
        emailPermissions.folderId,
      ],
      set: {
        canRead: args.canRead,
        canMove: args.canMove,
        canClassify: args.canClassify,
        canSend: args.canSend,
      },
    })
    .returning();
  return row;
}

export async function createEmailFolder(args: {
  accountId: string;
  mailboxId: string;
  name: string;
}) {
  const name = clean(args.name);
  if (!name) throw new Error('Folder name is required.');
  const [row] = await db
    .insert(emailFolders)
    .values({
      accountId: args.accountId,
      mailboxId: args.mailboxId,
      name,
      slug: slugify(name),
      kind: 'custom',
    })
    .returning();
  return row;
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

export async function listEmailMessages(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  mailboxId?: string | null;
  folderId?: string | null;
  q?: string | null;
}) {
  const workspace = await listEmailWorkspace(args);
  const allowedMailboxIds = workspace.mailboxes.map((mailbox) => mailbox.id);
  const allowedFolderIds = workspace.folders.map((folder) => folder.id);
  if (allowedMailboxIds.length === 0 || allowedFolderIds.length === 0) {
    return { messages: [], ...workspace };
  }

  const mailboxId = args.mailboxId && allowedMailboxIds.includes(args.mailboxId)
    ? args.mailboxId
    : allowedMailboxIds[0];
  const folderId = args.folderId && allowedFolderIds.includes(args.folderId)
    ? args.folderId
    : null;
  const q = clean(args.q);

  const filters = [
    eq(emailMessages.accountId, args.accountId),
    inArray(emailMessages.mailboxId, [mailboxId]),
    folderId ? eq(emailMessages.folderId, folderId) : inArray(emailMessages.folderId, allowedFolderIds),
    q
      ? or(
          ilike(emailMessages.subject, `%${q}%`),
          ilike(emailMessages.fromAddress, `%${q}%`),
          ilike(emailMessages.bodyText, `%${q}%`),
        )
      : undefined,
  ];

  const rows = await db
    .select()
    .from(emailMessages)
    .where(and(...filters))
    .orderBy(desc(emailMessages.receivedAt))
    .limit(100);

  return { messages: rows.map(serializeEmailMessage), ...workspace };
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
    eventType: args.folderId ? 'message.moved' : 'message.read_state_changed',
    metadata: { is_read: updated.isRead, folder_id: updated.folderId },
  });

  return updated;
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
  subject: string;
  text: string;
  html?: string;
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
    subject: args.subject || '(Sin asunto)',
    text: args.text,
    html: args.html,
  });

  await db.insert(emailAuditEvents).values({
    accountId: args.accountId,
    userId: args.userId,
    mailboxId: mailbox.id,
    eventType: 'message.sent',
    metadata: {
      smtp_message_id: info.messageId,
      from: mailbox.address,
      to: args.to,
      cc: args.cc ?? [],
      in_reply_to_message_id: args.inReplyToMessageId ?? null,
    },
  });

  return { message_id: info.messageId ?? null };
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
