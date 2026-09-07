import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import { db } from '@/db/client';
import {
  departmentMembers,
  emailFolders,
  emailMailboxes,
  emailPermissions,
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
  mailboxId: string;
  folderId?: string | null;
}): Promise<EmailPermissionSet> {
  if (hasMinRole(args.role, 'admin')) return FULL_ACCESS;

  const departments = await getUserDepartmentIds(args.accountId, args.userId);
  if (departments.length === 0) {
    return { canRead: false, canMove: false, canClassify: false, canSend: false };
  }

  const rows = await db
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
        eq(emailPermissions.mailboxId, args.mailboxId),
        inArray(emailPermissions.departmentId, departments),
        args.folderId
          ? or(isNull(emailPermissions.folderId), eq(emailPermissions.folderId, args.folderId))
          : undefined,
      ),
    );

  return rows.reduce(
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
  if (departments.length === 0) return [];

  return db
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
}

export async function listAccessibleFolders(args: {
  accountId: string;
  userId: string;
  role: AccountRole;
  mailboxIds: string[];
}) {
  if (args.mailboxIds.length === 0) return [];
  if (hasMinRole(args.role, 'admin')) {
    return db
      .select()
      .from(emailFolders)
      .where(
        and(
          eq(emailFolders.accountId, args.accountId),
          inArray(emailFolders.mailboxId, args.mailboxIds),
        ),
      );
  }

  const departments = await getUserDepartmentIds(args.accountId, args.userId);
  if (departments.length === 0) return [];

  return db
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
        or(isNull(emailPermissions.folderId), eq(emailPermissions.folderId, emailFolders.id)),
      ),
    );
}
