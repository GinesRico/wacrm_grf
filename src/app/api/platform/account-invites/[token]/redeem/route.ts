import { NextResponse } from 'next/server'
import { and, eq, isNull, sql } from 'drizzle-orm'

import { hashInviteToken } from '@/lib/auth/invitations'
import { db } from '@/db/client'
import { crmAccounts, platformAccountInvites } from '@/db/schema'
import { getCurrentDbAccount } from '@/lib/auth/current-account'

const BUSINESS_TABLES = [
  'contacts',
  'conversations',
  'broadcasts',
  'automations',
  'flows',
  'deals',
  'message_templates',
  'whatsapp_config',
] as const

async function hasBusinessData(accountId: string): Promise<boolean> {
  for (const table of BUSINESS_TABLES) {
    try {
      const result = await db.execute(
        sql.raw(`select count(*)::int as count from ${table} where account_id = '${accountId.replaceAll("'", "''")}'`),
      )
      if (Number((result.rows[0] as { count?: number } | undefined)?.count ?? 0) > 0) return true
    } catch (error) {
      if ((error as { code?: string })?.code !== '42P01') throw error
    }
  }
  return false
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 400 })

  const ctx = await getCurrentDbAccount().catch(() => null)
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const tokenHash = hashInviteToken(token)

  const [invite] = await db
    .select()
    .from(platformAccountInvites)
    .where(eq(platformAccountInvites.tokenHash, tokenHash))
    .limit(1)

  if (!invite || invite.acceptedAt) {
    return NextResponse.json({ error: 'Invitation is invalid or already used' }, { status: 400 })
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    return NextResponse.json({ error: 'Invitation has expired' }, { status: 400 })
  }
  if (ctx.user.email.toLowerCase() !== invite.ownerEmail.toLowerCase()) {
    return NextResponse.json({ error: 'This invitation belongs to a different email address' }, { status: 403 })
  }

  if (ctx.role !== 'owner') {
    return NextResponse.json({ error: 'Only a personal owner account can accept this invitation' }, { status: 409 })
  }

  if (ctx.account.owner_user_id !== ctx.userId) {
    return NextResponse.json({ error: 'Only the account owner can accept this invitation' }, { status: 409 })
  }

  try {
    if (await hasBusinessData(ctx.accountId)) {
      return NextResponse.json(
        { error: 'Your current account already has business data. Create a fresh user before accepting this platform invitation.' },
        { status: 409 },
      )
    }
  } catch (err) {
    console.error('[platform redeem] business data check error:', err)
    return NextResponse.json({ error: 'Failed to validate account state' }, { status: 500 })
  }

  const accepted = await db.transaction(async (tx) => {
    await tx
      .update(crmAccounts)
      .set({
        name: invite.accountName,
        plan: invite.plan,
        status: invite.status,
        maxUsers: invite.maxUsers,
        maxFlows: invite.maxFlows,
        maxAutomations: invite.maxAutomations,
        maxWhatsappLines: invite.maxWhatsappLines,
        allowAi: invite.allowAi,
        allowApi: invite.allowApi,
        allowBroadcasts: invite.allowBroadcasts,
        trialEndsAt: invite.trialEndsAt,
        updatedAt: new Date(),
      })
      .where(eq(crmAccounts.id, ctx.accountId))

    const [acceptedInvite] = await tx
      .update(platformAccountInvites)
      .set({
        acceptedAt: new Date(),
        acceptedByUserId: ctx.userId,
      })
      .where(and(eq(platformAccountInvites.id, invite.id), isNull(platformAccountInvites.acceptedAt)))
      .returning({ id: platformAccountInvites.id })

    return !!acceptedInvite
  })

  if (!accepted) {
    return NextResponse.json({ error: 'Failed to mark invitation accepted' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, accountId: ctx.accountId })
}
