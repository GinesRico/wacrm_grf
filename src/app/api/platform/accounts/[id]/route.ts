import { NextResponse } from 'next/server'

import { requirePlatformAdmin } from '@/lib/platform/admin'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { toErrorResponse } from '@/lib/auth/account'

const STATUS = new Set(['trial', 'active', 'suspended', 'cancelled'])
const MAX_NAME_LEN = 80

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value))
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
