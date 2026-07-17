import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { hashInviteToken } from '@/lib/auth/invitations'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

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

async function hasBusinessData(admin: SupabaseClient, accountId: string): Promise<boolean> {
  for (const table of BUSINESS_TABLES) {
    const { count, error } = await admin
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    if (error) throw error
    if ((count ?? 0) > 0) return true
  }
  return false
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 400 })

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = supabaseAdmin()
  const tokenHash = hashInviteToken(token)

  const { data: invite, error: inviteErr } = await admin
    .from('platform_account_invites')
    .select('*')
    .eq('token_hash', tokenHash)
    .maybeSingle()
  if (inviteErr) {
    console.error('[platform redeem] invite fetch error:', inviteErr)
    return NextResponse.json({ error: 'Failed to load invitation' }, { status: 500 })
  }
  if (!invite || invite.accepted_at) {
    return NextResponse.json({ error: 'Invitation is invalid or already used' }, { status: 400 })
  }
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: 'Invitation has expired' }, { status: 400 })
  }
  if (user.email?.toLowerCase() !== String(invite.owner_email).toLowerCase()) {
    return NextResponse.json({ error: 'This invitation belongs to a different email address' }, { status: 403 })
  }

  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('account_id, account_role')
    .eq('user_id', user.id)
    .maybeSingle()
  if (profileErr || !profile?.account_id) {
    return NextResponse.json({ error: 'Profile is not linked to an account' }, { status: 403 })
  }
  if (profile.account_role !== 'owner') {
    return NextResponse.json({ error: 'Only a personal owner account can accept this invitation' }, { status: 409 })
  }

  const { data: account } = await admin
    .from('accounts')
    .select('owner_user_id')
    .eq('id', profile.account_id)
    .maybeSingle()
  if (!account || account.owner_user_id !== user.id) {
    return NextResponse.json({ error: 'Only the account owner can accept this invitation' }, { status: 409 })
  }

  try {
    if (await hasBusinessData(admin, profile.account_id)) {
      return NextResponse.json(
        { error: 'Your current account already has business data. Create a fresh user before accepting this platform invitation.' },
        { status: 409 },
      )
    }
  } catch (err) {
    console.error('[platform redeem] business data check error:', err)
    return NextResponse.json({ error: 'Failed to validate account state' }, { status: 500 })
  }

  const { error: accountErr } = await admin
    .from('accounts')
    .update({
      name: invite.account_name,
      plan: invite.plan,
      status: invite.status,
      max_users: invite.max_users,
      max_flows: invite.max_flows,
      max_automations: invite.max_automations,
      max_whatsapp_lines: invite.max_whatsapp_lines,
      allow_ai: invite.allow_ai,
      allow_api: invite.allow_api,
      allow_broadcasts: invite.allow_broadcasts,
      trial_ends_at: invite.trial_ends_at,
      updated_at: new Date().toISOString(),
    })
    .eq('id', profile.account_id)
  if (accountErr) {
    console.error('[platform redeem] account update error:', accountErr)
    return NextResponse.json({ error: 'Failed to configure account' }, { status: 500 })
  }

  const { error: acceptErr } = await admin
    .from('platform_account_invites')
    .update({
      accepted_at: new Date().toISOString(),
      accepted_by_user_id: user.id,
    })
    .eq('id', invite.id)
    .is('accepted_at', null)

  if (acceptErr) {
    console.error('[platform redeem] accept update error:', acceptErr)
    return NextResponse.json({ error: 'Failed to mark invitation accepted' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, accountId: profile.account_id })
}
