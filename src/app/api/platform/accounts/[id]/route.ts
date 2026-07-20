import { NextResponse } from 'next/server'
import { eq, inArray } from 'drizzle-orm'

import { db } from '@/db/client'
import { authUser, crmAccounts, profiles } from '@/db/schema'
import { getPlatformAdminUserIds, requirePlatformAdmin } from '@/lib/platform/admin'
import { toErrorResponse } from '@/lib/auth/errors'
import { deleteObject, listObjectKeys } from '@/lib/storage/alarik'

const STATUS = new Set(['trial', 'active', 'suspended', 'cancelled'])
const MAX_NAME_LEN = 80

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value))
}

function serializeAccount(account: typeof crmAccounts.$inferSelect) {
  return {
    id: account.id,
    name: account.name,
    owner_user_id: account.ownerUserId,
    status: account.status,
    plan: account.plan,
    max_users: account.maxUsers,
    max_flows: account.maxFlows,
    max_automations: account.maxAutomations,
    max_whatsapp_lines: account.maxWhatsappLines,
    allow_ai: account.allowAi,
    allow_api: account.allowApi,
    allow_broadcasts: account.allowBroadcasts,
    trial_ends_at: account.trialEndsAt?.toISOString() ?? null,
    created_at: account.createdAt.toISOString(),
    updated_at: account.updatedAt.toISOString(),
  }
}

async function removeStoragePrefix(bucket: string, prefix: string): Promise<void> {
  const keys = await listObjectKeys(`${bucket}/${prefix}`)
  for (const key of keys) {
    await deleteObject(key).catch((error) => {
      console.warn(`[DELETE /api/platform/accounts/[id]] storage remove failed for ${key}:`, error)
    })
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requirePlatformAdmin()
    const { id } = await params
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

    const patch: Partial<typeof crmAccounts.$inferInsert> = { updatedAt: new Date() }

    if (typeof body.name === 'string') {
      const name = body.name.trim()
      if (!name || name.length > MAX_NAME_LEN) {
        return NextResponse.json({ error: 'Invalid account name' }, { status: 400 })
      }
      patch.name = name
    }
    if (typeof body.plan === 'string' && body.plan.trim()) patch.plan = body.plan.trim()
    if (typeof body.status === 'string' && STATUS.has(body.status)) patch.status = body.status
    for (const key of ['max_users', 'max_flows', 'max_automations', 'max_whatsapp_lines'] as const) {
      if (!(key in body)) continue
      const value = key === 'max_users'
        ? Math.max(1, positiveInt(body[key], 1))
        : positiveInt(body[key], 0)
      if (key === 'max_users') patch.maxUsers = value
      if (key === 'max_flows') patch.maxFlows = value
      if (key === 'max_automations') patch.maxAutomations = value
      if (key === 'max_whatsapp_lines') patch.maxWhatsappLines = value
    }
    for (const key of ['allow_ai', 'allow_api', 'allow_broadcasts'] as const) {
      if (typeof body[key] !== 'boolean') continue
      if (key === 'allow_ai') patch.allowAi = body[key]
      if (key === 'allow_api') patch.allowApi = body[key]
      if (key === 'allow_broadcasts') patch.allowBroadcasts = body[key]
    }
    if ('trial_ends_at' in body) {
      patch.trialEndsAt =
        typeof body.trial_ends_at === 'string' && body.trial_ends_at
          ? new Date(body.trial_ends_at)
          : null
    }

    const [updated] = await db
      .update(crmAccounts)
      .set(patch)
      .where(eq(crmAccounts.id, id))
      .returning()

    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ account: serializeAccount(updated) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requirePlatformAdmin()
    const { id } = await params
    const body = (await request.json().catch(() => null)) as { confirm_name?: unknown } | null
    const confirmName = typeof body?.confirm_name === 'string' ? body.confirm_name.trim() : ''

    const [account] = await db
      .select()
      .from(crmAccounts)
      .where(eq(crmAccounts.id, id))
      .limit(1)
    if (!account) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (confirmName !== account.name) {
      return NextResponse.json({ error: 'Account name confirmation does not match' }, { status: 400 })
    }

    const platformAdminUserIds = await getPlatformAdminUserIds()
    if (platformAdminUserIds.has(account.ownerUserId)) {
      return NextResponse.json({ error: 'Platform admin accounts cannot be deleted here' }, { status: 400 })
    }

    const accountProfiles = await db
      .select({ userId: profiles.userId })
      .from(profiles)
      .where(eq(profiles.accountId, account.id))

    const memberUserIds = Array.from(
      new Set(
        accountProfiles
          .map((profile) => profile.userId)
          .filter((userId): userId is string => typeof userId === 'string' && !platformAdminUserIds.has(userId)),
      ),
    )

    await Promise.all([
      removeStoragePrefix('avatars', `account-${account.id}`),
      removeStoragePrefix('chat-media', `account-${account.id}`),
      removeStoragePrefix('flow-media', `account-${account.id}`),
    ])

    await db.delete(crmAccounts).where(eq(crmAccounts.id, account.id))

    const authDeleteErrors: string[] = []
    if (memberUserIds.length > 0) {
      try {
        await db.delete(authUser).where(inArray(authUser.id, memberUserIds))
      } catch (error) {
        authDeleteErrors.push(...memberUserIds)
        console.warn('[DELETE /api/platform/accounts/[id]] auth user delete failed:', error)
      }
    }

    return NextResponse.json({
      ok: true,
      deleted_auth_users: memberUserIds.length - authDeleteErrors.length,
      auth_delete_errors: authDeleteErrors,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
