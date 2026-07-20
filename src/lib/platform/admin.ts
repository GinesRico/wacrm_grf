import { and, count, eq, inArray, or } from 'drizzle-orm'
import { db } from '@/db/client'
import { authUser, platformAdmins, profiles } from '@/db/schema'
import { getCurrentDbAccount } from '@/lib/auth/current-account'
import { ForbiddenError } from '@/lib/auth/errors'

export interface PlatformAdminContext {
  userId: string
  email: string
}

export function bootstrapPlatformAdminEmails(): readonly string[] {
  return (process.env.PLATFORM_BOOTSTRAP_ADMIN_EMAILS ?? process.env.PLATFORM_ADMIN_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
}

export function isBootstrapPlatformAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return bootstrapPlatformAdminEmails().includes(email.trim().toLowerCase())
}

export async function getPlatformAdminUserIds(): Promise<Set<string>> {
  const rows = await db
    .select({
      email: platformAdmins.email,
      userId: platformAdmins.userId,
    })
    .from(platformAdmins)

  const userIds = new Set<string>()
  const emails = new Set<string>()

  for (const platformAdmin of rows) {
    if (platformAdmin.userId) userIds.add(platformAdmin.userId)
    if (platformAdmin.email) emails.add(platformAdmin.email.toLowerCase())
  }

  if (emails.size > 0) {
    const matchedProfiles = await db
      .select({ userId: profiles.userId })
      .from(profiles)
      .where(inArray(profiles.email, Array.from(emails)))

    for (const profile of matchedProfiles) {
      if (profile.userId) userIds.add(profile.userId)
    }
  }

  return userIds
}

export async function isPlatformAdmin(email: string, userId: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase()

  const [total] = await db.select({ value: count() }).from(platformAdmins)
  if ((total?.value ?? 0) === 0 && isBootstrapPlatformAdminEmail(normalized)) {
    return true
  }

  const [row] = await db
    .select({ id: platformAdmins.id })
    .from(platformAdmins)
    .leftJoin(authUser, eq(authUser.id, platformAdmins.userId))
    .where(
      or(
        eq(platformAdmins.email, normalized),
        eq(platformAdmins.userId, userId),
        and(eq(authUser.email, normalized), eq(authUser.id, userId)),
      ),
    )
    .limit(1)

  return !!row
}

export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const ctx = await getCurrentDbAccount()

  if (!(await isPlatformAdmin(ctx.user.email, ctx.userId))) {
    throw new ForbiddenError('This action requires platform admin access')
  }

  return {
    userId: ctx.userId,
    email: ctx.user.email,
  }
}
