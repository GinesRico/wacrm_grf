import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import { db } from '@/db/client';
import {
  departmentMembers,
  emailFolders,
  emailMailboxes,
  emailPermissions,
  emailUserPermissions,
} from '@/db/schema';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import type { EmailPermissionSet } from './types';

const FULL_ACCESS: EmailPermissionSet = {
  canRead: true,
  canMove: true,
  canClassify: true,
  canSend: true,
};

export async function getUserDepartmentIds(accountId: string, userId: string) {
  const rows = await db
    .select({ departmentId: departmentMembers.departmentId })
    .from(departmentMembers)
    .where(
      and(
        eq(departmentMembers.accountId, accountId),
        eq(departmentMembers.userId, userId),
      ),
    );
  return rows.map((row) => row.departmentId);
}

export async function resolveEmailPermission(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  mailboxId?: string | null;
  folderId?: string | null;
}): Promise<EmailPermissionSet> {
  if (hasMinRole(args.role, 'admin')) return FULL_ACCESS;

  if (args.mailboxId) {
    const [ownedMailbox] = await db
      .select({ id: emailMailboxes.id })
      .from(emailMailboxes)
      .where(
        and(
          eq(emailMailboxes.accountId, args.accountId),
          eq(emailMailboxes.id, args.mailboxId),
          eq(emailMailboxes.kind, 'personal'),
          eq(emailMailboxes.ownerUserId, args.userId),
        ),
      )
      .limit(1);
    if (ownedMailbox) return FULL_ACCESS;
  }

  const departments = await getUserDepartmentIds(args.accountId, args.userId);

  const userRows = await db
    .select({
      canRead: emailUserPermissions.canRead,
      canMove: emailUserPermissions.canMove,
      canClassify: emailUserPermissions.canClassify,
      canSend: emailUserPermissions.canSend,
    })
    .from(emailUserPermissions)
    .where(
      and(
        eq(emailUserPermissions.accountId, args.accountId),
        eq(emailUserPermissions.userId, args.userId),
        args.folderId
          ? or(
              eq(emailUserPermissions.folderId, args.folderId),
              args.mailboxId
                ? and(
                    eq(emailUserPermissions.mailboxId, args.mailboxId),
                    isNull(emailUserPermissions.folderId),
                  )
                : undefined,
            )
          : args.mailboxId
            ? eq(emailUserPermissions.mailboxId, args.mailboxId)
            : isNull(emailUserPermissions.mailboxId),
      ),
    );

  const departmentRows = departments.length
    ? await db
    .select({
      canRead: emailPermissions.canRead,
      canMove: emailPermissions.canMove,
      canClassify: emailPermissions.canClassify,
      canSend: emailPermissions.canSend,
    })
    .from(emailPermissions)
    .where(
      and(
        eq(emailPermissions.accountId, args.accountId),
        inArray(emailPermissions.departmentId, departments),
        args.folderId
          ? or(
              eq(emailPermissions.folderId, args.folderId),
              args.mailboxId
                ? and(
                    eq(emailPermissions.mailboxId, args.mailboxId),
                    isNull(emailPermissions.folderId),
                  )
                : undefined,
            )
          : args.mailboxId
            ? eq(emailPermissions.mailboxId, args.mailboxId)
            : isNull(emailPermissions.mailboxId),
      ),
    )
    : [];

  return [...userRows, ...departmentRows].reduce(
    (acc, row) => ({
      canRead: acc.canRead || row.canRead,
      canMove: acc.canMove || row.canMove,
      canClassify: acc.canClassify || row.canClassify,
      canSend: acc.canSend || row.canSend,
    }),
    { canRead: false, canMove: false, canClassify: false, canSend: false },
  );
}

export async function listAccessibleMailboxes(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
}) {
  if (hasMinRole(args.role, 'admin')) {
    return db
      .select()
      .from(emailMailboxes)
      .where(eq(emailMailboxes.accountId, args.accountId));
  }

  const departments = await getUserDepartmentIds(args.accountId, args.userId);
  const ownedPersonalMailboxes = await db
    .select()
    .from(emailMailboxes)
    .where(
      and(
        eq(emailMailboxes.accountId, args.accountId),
        eq(emailMailboxes.kind, 'personal'),
        eq(emailMailboxes.ownerUserId, args.userId),
      ),
    );
  const userMailboxRows = await db
    .selectDistinct({
      id: emailMailboxes.id,
      accountId: emailMailboxes.accountId,
      emailAccountId: emailMailboxes.emailAccountId,
      ownerUserId: emailMailboxes.ownerUserId,
      address: emailMailboxes.address,
      displayName: emailMailboxes.displayName,
      kind: emailMailboxes.kind,
      canSend: emailMailboxes.canSend,
      isDefault: emailMailboxes.isDefault,
      createdAt: emailMailboxes.createdAt,
      updatedAt: emailMailboxes.updatedAt,
    })
    .from(emailMailboxes)
    .innerJoin(emailUserPermissions, eq(emailUserPermissions.mailboxId, emailMailboxes.id))
    .where(
      and(
        eq(emailMailboxes.accountId, args.accountId),
        eq(emailUserPermissions.userId, args.userId),
        eq(emailUserPermissions.canRead, true),
      ),
    );

  if (departments.length === 0) {
    const seen = new Set<string>();
    return [...ownedPersonalMailboxes, ...userMailboxRows].filter((mailbox) => {
      if (seen.has(mailbox.id)) return false;
      seen.add(mailbox.id);
      return true;
    });
  }

  const sharedMailboxes = await db
    .selectDistinct({
      id: emailMailboxes.id,
      accountId: emailMailboxes.accountId,
      emailAccountId: emailMailboxes.emailAccountId,
      ownerUserId: emailMailboxes.ownerUserId,
      address: emailMailboxes.address,
      displayName: emailMailboxes.displayName,
      kind: emailMailboxes.kind,
      canSend: emailMailboxes.canSend,
      isDefault: emailMailboxes.isDefault,
      createdAt: emailMailboxes.createdAt,
      updatedAt: emailMailboxes.updatedAt,
    })
    .from(emailMailboxes)
    .innerJoin(emailPermissions, eq(emailPermissions.mailboxId, emailMailboxes.id))
    .where(
      and(
        eq(emailMailboxes.accountId, args.accountId),
        inArray(emailPermissions.departmentId, departments),
        eq(emailPermissions.canRead, true),
      ),
    );

  const seen = new Set<string>();
  return [...ownedPersonalMailboxes, ...userMailboxRows, ...sharedMailboxes].filter((mailbox) => {
    if (seen.has(mailbox.id)) return false;
    seen.add(mailbox.id);
    return true;
  });
}

export async function listAccessibleFolders(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  mailboxIds: string[];
}) {
  if (hasMinRole(args.role, 'admin')) {
    return db
      .select()
      .from(emailFolders)
      .where(
        and(
          eq(emailFolders.accountId, args.accountId),
          args.mailboxIds.length > 0
            ? or(inArray(emailFolders.mailboxId, args.mailboxIds), isNull(emailFolders.mailboxId))
            : isNull(emailFolders.mailboxId),
        ),
      );
  }

  const departments = await getUserDepartmentIds(args.accountId, args.userId);
  const ownedFolderRows = await db
    .select()
    .from(emailFolders)
    .innerJoin(emailMailboxes, eq(emailMailboxes.id, emailFolders.mailboxId))
    .where(
      and(
        eq(emailFolders.accountId, args.accountId),
        args.mailboxIds.length > 0 ? inArray(emailFolders.mailboxId, args.mailboxIds) : undefined,
        eq(emailMailboxes.kind, 'personal'),
        eq(emailMailboxes.ownerUserId, args.userId),
      ),
    );
  const ownedFolders = ownedFolderRows.map((row) => row.email_folders);

  const userFolders = await db
    .selectDistinct({
      id: emailFolders.id,
      accountId: emailFolders.accountId,
      mailboxId: emailFolders.mailboxId,
      name: emailFolders.name,
      slug: emailFolders.slug,
      kind: emailFolders.kind,
      position: emailFolders.position,
      createdAt: emailFolders.createdAt,
      updatedAt: emailFolders.updatedAt,
    })
    .from(emailFolders)
    .innerJoin(emailUserPermissions, eq(emailUserPermissions.folderId, emailFolders.id))
    .where(
      and(
        eq(emailFolders.accountId, args.accountId),
        eq(emailUserPermissions.userId, args.userId),
        eq(emailUserPermissions.canRead, true),
      ),
    );

  const userMailboxFolders = args.mailboxIds.length
    ? await db
        .selectDistinct({
          id: emailFolders.id,
          accountId: emailFolders.accountId,
          mailboxId: emailFolders.mailboxId,
          name: emailFolders.name,
          slug: emailFolders.slug,
          kind: emailFolders.kind,
          position: emailFolders.position,
          createdAt: emailFolders.createdAt,
          updatedAt: emailFolders.updatedAt,
        })
        .from(emailFolders)
        .innerJoin(emailUserPermissions, eq(emailUserPermissions.mailboxId, emailFolders.mailboxId))
        .where(
          and(
            eq(emailFolders.accountId, args.accountId),
            inArray(emailFolders.mailboxId, args.mailboxIds),
            eq(emailUserPermissions.userId, args.userId),
            eq(emailUserPermissions.canRead, true),
            isNull(emailUserPermissions.folderId),
          ),
        )
    : [];

  if (departments.length === 0) {
    const seen = new Set<string>();
    return [...ownedFolders, ...userFolders, ...userMailboxFolders].filter((folder) => {
      if (seen.has(folder.id)) return false;
      seen.add(folder.id);
      return true;
    });
  }

  const sharedFolders = await db
    .selectDistinct({
      id: emailFolders.id,
      accountId: emailFolders.accountId,
      mailboxId: emailFolders.mailboxId,
      name: emailFolders.name,
      slug: emailFolders.slug,
      kind: emailFolders.kind,
      position: emailFolders.position,
      createdAt: emailFolders.createdAt,
      updatedAt: emailFolders.updatedAt,
    })
    .from(emailFolders)
    .innerJoin(emailPermissions, eq(emailPermissions.folderId, emailFolders.id))
    .where(
      and(
        eq(emailFolders.accountId, args.accountId),
        inArray(emailPermissions.departmentId, departments),
        eq(emailPermissions.canRead, true),
      ),
    );

  const seen = new Set<string>();
  const departmentMailboxFolders = args.mailboxIds.length
    ? await db
        .selectDistinct({
          id: emailFolders.id,
          accountId: emailFolders.accountId,
          mailboxId: emailFolders.mailboxId,
          name: emailFolders.name,
          slug: emailFolders.slug,
          kind: emailFolders.kind,
          position: emailFolders.position,
          createdAt: emailFolders.createdAt,
          updatedAt: emailFolders.updatedAt,
        })
        .from(emailFolders)
        .innerJoin(emailPermissions, eq(emailPermissions.mailboxId, emailFolders.mailboxId))
        .where(
          and(
            eq(emailFolders.accountId, args.accountId),
            inArray(emailFolders.mailboxId, args.mailboxIds),
            inArray(emailPermissions.departmentId, departments),
            eq(emailPermissions.canRead, true),
            isNull(emailPermissions.folderId),
          ),
        )
    : [];

  return [...ownedFolders, ...userFolders, ...userMailboxFolders, ...sharedFolders, ...departmentMailboxFolders].filter((folder) => {
    if (seen.has(folder.id)) return false;
    seen.add(folder.id);
    return true;
  });
}
