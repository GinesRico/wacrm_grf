import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { platformAccountInvites, platformAccountRequests } from '@/db/schema'
import { toErrorResponse } from '@/lib/auth/errors'
import { requirePlatformAdmin } from '@/lib/platform/admin'
import {
  clampExpiryDays,
  generateInviteToken,
  inviteExpiresAt,
  inviteUrl,
} from '@/lib/auth/invitations'

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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requirePlatformAdmin()
    const { id } = await params
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

    const decision = body.decision
    if (decision !== 'approve' && decision !== 'reject') {
      return NextResponse.json({ error: 'Invalid decision' }, { status: 400 })
    }

    const [accountRequest] = await db
      .select()
      .from(platformAccountRequests)
      .where(eq(platformAccountRequests.id, id))
      .limit(1)

    if (!accountRequest) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 })
    }
    if (accountRequest.status !== 'pending') {
      return NextResponse.json({ error: 'Request has already been reviewed' }, { status: 409 })
    }

    if (decision === 'reject') {
      const [updated] = await db
        .update(platformAccountRequests)
        .set({
          status: 'rejected',
          reviewedByUserId: ctx.userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(platformAccountRequests.id, id))
        .returning({ id: platformAccountRequests.id })

      if (!updated) return NextResponse.json({ error: 'Failed to reject request' }, { status: 500 })
      return NextResponse.json({ ok: true })
    }

    const { token, hash } = generateInviteToken()
    const expiryDays = clampExpiryDays(typeof body.expiresInDays === 'number' ? body.expiresInDays : undefined)
    const expiresAt = inviteExpiresAt(expiryDays)

    const accepted = await db.transaction(async (tx) => {
      const [invitation] = await tx
        .insert(platformAccountInvites)
        .values({
          accountName: accountRequest.accountName,
          ownerEmail: accountRequest.ownerEmail,
          plan: typeof body.plan === 'string' && body.plan.trim() ? body.plan.trim() : 'starter',
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
        })
        .returning()

      if (!invitation) return null

      await tx
        .update(platformAccountRequests)
        .set({
          status: 'approved',
          reviewedByUserId: ctx.userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(platformAccountRequests.id, id))

      return invitation
    })

    if (!accepted) {
      return NextResponse.json({ error: 'Failed to approve request' }, { status: 500 })
    }

    return NextResponse.json({
      invitation: serializeInvite(accepted),
      token,
      url: inviteUrl(token, `${getBaseUrl(request)}/platform`),
      expiresInDays: expiryDays,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
