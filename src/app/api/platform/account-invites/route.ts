import { NextResponse } from 'next/server'

import { requirePlatformAdmin } from '@/lib/platform/admin'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { toErrorResponse } from '@/lib/auth/account'
import {
  clampExpiryDays,
  generateInviteToken,
  inviteExpiresAt,
  inviteUrl,
} from '@/lib/auth/invitations'

const MAX_NAME_LEN = 80
const MAX_PLAN_LEN = 40

function getBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  const proto = request.headers.get('x-forwarded-proto') ?? new URL(request.url).protocol.replace(':', '')
  return host ? `${proto}://${host}` : 'http://localhost:3000'
}

function asLimit(value: unknown, fallback: number, min = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.floor(value))
}

export async function GET() {
  try {
    await requirePlatformAdmin()
    const { data, error } = await supabaseAdmin()
      .from('platform_account_invites')
      .select('id, account_name, owner_email, plan, status, max_users, max_flows, max_automations, max_whatsapp_lines, allow_ai, allow_api, allow_broadcasts, trial_ends_at, created_at, expires_at, accepted_at, accepted_by_user_id')
      .order('created_at', { ascending: false })
    if (error) {
      console.error('[GET /api/platform/account-invites] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load invitations' }, { status: 500 })
    }
    return NextResponse.json({ invitations: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requirePlatformAdmin()
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

    const accountName = typeof body.account_name === 'string' ? body.account_name.trim() : ''
    const ownerEmail = typeof body.owner_email === 'string' ? body.owner_email.trim().toLowerCase() : ''
    const plan = typeof body.plan === 'string' && body.plan.trim() ? body.plan.trim() : 'starter'

    if (!accountName || accountName.length > MAX_NAME_LEN) {
      return NextResponse.json({ error: 'Invalid account_name' }, { status: 400 })
    }
    if (!ownerEmail || !ownerEmail.includes('@')) {
      return NextResponse.json({ error: 'Invalid owner_email' }, { status: 400 })
    }
    if (plan.length > MAX_PLAN_LEN) {
      return NextResponse.json({ error: 'Plan name is too long' }, { status: 400 })
    }

    const { token, hash } = generateInviteToken()
    const expiryDays = clampExpiryDays(typeof body.expiresInDays === 'number' ? body.expiresInDays : undefined)
    const expiresAt = inviteExpiresAt(expiryDays)

    const row = {
      account_name: accountName,
      owner_email: ownerEmail,
      plan,
      status: body.status === 'trial' ? 'trial' : 'active',
      max_users: asLimit(body.max_users, 3, 1),
      max_flows: asLimit(body.max_flows, 5),
      max_automations: asLimit(body.max_automations, 5),
      max_whatsapp_lines: asLimit(body.max_whatsapp_lines, 1),
      allow_ai: body.allow_ai === true,
      allow_api: body.allow_api === true,
      allow_broadcasts: body.allow_broadcasts !== false,
      trial_ends_at:
        typeof body.trial_ends_at === 'string' && body.trial_ends_at
          ? new Date(body.trial_ends_at).toISOString()
          : null,
      token_hash: hash,
      created_by_user_id: ctx.userId,
      expires_at: expiresAt.toISOString(),
    }

    const { data, error } = await supabaseAdmin()
      .from('platform_account_invites')
      .insert(row)
      .select('id, account_name, owner_email, plan, expires_at, created_at')
      .single()

    if (error || !data) {
      console.error('[POST /api/platform/account-invites] insert error:', error)
      return NextResponse.json({ error: 'Failed to create platform invitation' }, { status: 500 })
    }

    return NextResponse.json(
      {
        invitation: data,
        token,
        url: inviteUrl(token, `${getBaseUrl(request)}/platform`),
        expiresInDays: expiryDays,
      },
      { status: 201 },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
