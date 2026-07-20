import { NextResponse } from 'next/server'
import { desc } from 'drizzle-orm'

import { db } from '@/db/client'
import { platformAccountInvites } from '@/db/schema'
import { toErrorResponse } from '@/lib/auth/errors'
import { requirePlatformAdmin } from '@/lib/platform/admin'
import {
  clampExpiryDays,
  generateInviteToken,
  inviteExpiresAt,
  inviteUrl,
} from '@/lib/auth/invitations'

const MAX_NAME_LEN = 80
const MAX_PLAN_LEN = 40

function serializeInvite(invite: typeof platformAccountInvites.$inferSelect) {
  return {
    id: invite.id,
    account_name: invite.accountName,
    owner_email: invite.ownerEmail,
    plan: invite.plan,
    status: invite.status,
    max_users: invite.maxUsers,
    max_flows: invite.maxFlows,
    max_automations: invite.maxAutomations,
    max_whatsapp_lines: invite.maxWhatsappLines,
    allow_ai: invite.allowAi,
    allow_api: invite.allowApi,
    allow_broadcasts: invite.allowBroadcasts,
    trial_ends_at: invite.trialEndsAt?.toISOString() ?? null,
    created_at: invite.createdAt.toISOString(),
    expires_at: invite.expiresAt.toISOString(),
    accepted_at: invite.acceptedAt?.toISOString() ?? null,
    accepted_by_user_id: invite.acceptedByUserId,
  }
}

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

    const invites = await db
      .select()
      .from(platformAccountInvites)
      .orderBy(desc(platformAccountInvites.createdAt))

    return NextResponse.json({ invitations: invites.map(serializeInvite) })
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
      accountName,
      ownerEmail,
      plan,
      status: body.status === 'trial' ? 'trial' : 'active',
      maxUsers: asLimit(body.max_users, 3, 1),
      maxFlows: asLimit(body.max_flows, 5),
      maxAutomations: asLimit(body.max_automations, 5),
      maxWhatsappLines: asLimit(body.max_whatsapp_lines, 1),
      allowAi: body.allow_ai === true,
      allowApi: body.allow_api === true,
      allowBroadcasts: body.allow_broadcasts !== false,
      trialEndsAt:
        typeof body.trial_ends_at === 'string' && body.trial_ends_at
          ? new Date(body.trial_ends_at)
          : null,
      tokenHash: hash,
      createdByUserId: ctx.userId,
      expiresAt,
    }

    const [invitation] = await db.insert(platformAccountInvites).values(row).returning()

    if (!invitation) {
      return NextResponse.json({ error: 'Failed to create platform invitation' }, { status: 500 })
    }

    return NextResponse.json(
      {
        invitation: serializeInvite(invitation),
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
