import { NextResponse } from 'next/server'

import { requirePlatformAdmin } from '@/lib/platform/admin'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { toErrorResponse } from '@/lib/auth/account'

const ACCOUNT_COLUMNS =
  'id, name, owner_user_id, status, plan, max_users, max_flows, max_automations, max_whatsapp_lines, allow_ai, allow_api, allow_broadcasts, trial_ends_at, created_at, updated_at'

async function countByAccount(table: string): Promise<Map<string, number>> {
  const { data, error } = await supabaseAdmin()
    .from(table)
    .select('account_id')
  if (error) throw error
  const counts = new Map<string, number>()
  for (const row of (data ?? []) as { account_id: string }[]) {
    counts.set(row.account_id, (counts.get(row.account_id) ?? 0) + 1)
  }
  return counts
}

export async function GET() {
  try {
    await requirePlatformAdmin()

    const admin = supabaseAdmin()
    const { data: accounts, error } = await admin
      .from('accounts')
      .select(ACCOUNT_COLUMNS)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[GET /api/platform/accounts] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load accounts' }, { status: 500 })
    }

    const [members, flows, automations, whatsappLines] = await Promise.all([
      countByAccount('profiles'),
      countByAccount('flows'),
      countByAccount('automations'),
      countByAccount('whatsapp_config'),
    ])

    return NextResponse.json({
      accounts: (accounts ?? []).map((account) => ({
        ...account,
        usage: {
          users: members.get(account.id) ?? 0,
          flows: flows.get(account.id) ?? 0,
          automations: automations.get(account.id) ?? 0,
          whatsapp_lines: whatsappLines.get(account.id) ?? 0,
        },
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
