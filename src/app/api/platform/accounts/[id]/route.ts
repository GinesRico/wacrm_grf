import { NextResponse } from 'next/server'

import { getPlatformAdminUserIds, requirePlatformAdmin } from '@/lib/platform/admin'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { toErrorResponse } from '@/lib/auth/account'

const STATUS = new Set(['trial', 'active', 'suspended', 'cancelled'])
const MAX_NAME_LEN = 80

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value))
}

interface StorageEntry {
  id: string | null
  name: string
}

async function removeStoragePrefix(bucket: string, prefix: string): Promise<void> {
  const storage = supabaseAdmin().storage.from(bucket)

  async function walk(path: string): Promise<string[]> {
    const files: string[] = []
    let offset = 0

    while (true) {
      const { data, error } = await storage.list(path, { limit: 1000, offset })
      if (error) {
        console.warn(`[DELETE /api/platform/accounts/[id]] storage list failed for ${bucket}/${path}:`, error)
        return files
      }

      const entries = (data ?? []) as StorageEntry[]
      for (const entry of entries) {
        const nextPath = path ? `${path}/${entry.name}` : entry.name
        if (entry.id === null) {
          files.push(...(await walk(nextPath)))
        } else {
          files.push(nextPath)
        }
      }
      if (entries.length < 1000) break
      offset += entries.length
    }

    return files
  }

  const files = await walk(prefix)
  for (let i = 0; i < files.length; i += 100) {
    const chunk = files.slice(i, i + 100)
    const { error } = await storage.remove(chunk)
    if (error) {
      console.warn(`[DELETE /api/platform/accounts/[id]] storage remove failed for ${bucket}:`, error)
    }
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

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }

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
      if (key in body) patch[key] = key === 'max_users'
        ? Math.max(1, positiveInt(body[key], 1))
        : positiveInt(body[key], 0)
    }
    for (const key of ['allow_ai', 'allow_api', 'allow_broadcasts'] as const) {
      if (typeof body[key] === 'boolean') patch[key] = body[key]
    }
    if ('trial_ends_at' in body) {
      patch.trial_ends_at =
        typeof body.trial_ends_at === 'string' && body.trial_ends_at
          ? new Date(body.trial_ends_at).toISOString()
          : null
    }

    const { data, error } = await supabaseAdmin()
      .from('accounts')
      .update(patch)
      .eq('id', id)
      .select()
      .maybeSingle()

    if (error) {
      console.error('[PATCH /api/platform/accounts/[id]] update error:', error)
      return NextResponse.json({ error: 'Failed to update account' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ account: data })
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
    const admin = supabaseAdmin()

    const { data: account, error: accountError } = await admin
      .from('accounts')
      .select('id, name, owner_user_id')
      .eq('id', id)
      .maybeSingle()

    if (accountError) {
      console.error('[DELETE /api/platform/accounts/[id]] fetch error:', accountError)
      return NextResponse.json({ error: 'Failed to load account' }, { status: 500 })
    }
    if (!account) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (confirmName !== account.name) {
      return NextResponse.json({ error: 'Account name confirmation does not match' }, { status: 400 })
    }

    const platformAdminUserIds = await getPlatformAdminUserIds()
    if (platformAdminUserIds.has(account.owner_user_id)) {
      return NextResponse.json({ error: 'Platform admin accounts cannot be deleted here' }, { status: 400 })
    }

    const { data: profiles, error: profilesError } = await admin
      .from('profiles')
      .select('user_id')
      .eq('account_id', account.id)

    if (profilesError) {
      console.error('[DELETE /api/platform/accounts/[id]] members fetch error:', profilesError)
      return NextResponse.json({ error: 'Failed to load account members' }, { status: 500 })
    }

    const memberUserIds = Array.from(
      new Set(
        (profiles ?? [])
          .map((profile) => profile.user_id)
          .filter((userId): userId is string => typeof userId === 'string' && !platformAdminUserIds.has(userId)),
      ),
    )

    await Promise.all([
      removeStoragePrefix('chat-media', `account-${account.id}`),
      removeStoragePrefix('flow-media', `account-${account.id}`),
    ])

    const { error: deleteError } = await admin
      .from('accounts')
      .delete()
      .eq('id', account.id)

    if (deleteError) {
      console.error('[DELETE /api/platform/accounts/[id]] delete error:', deleteError)
      return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 })
    }

    const authDeleteErrors: string[] = []
    for (const userId of memberUserIds) {
      const { error } = await admin.auth.admin.deleteUser(userId)
      if (error) {
        authDeleteErrors.push(userId)
        console.warn(`[DELETE /api/platform/accounts/[id]] auth user delete failed for ${userId}:`, error)
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
