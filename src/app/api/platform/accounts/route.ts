import { NextResponse } from 'next/server'
import { desc, sql } from 'drizzle-orm'

import { db } from '@/db/client'
import { crmAccounts } from '@/db/schema'
import { getPlatformAdminUserIds, requirePlatformAdmin } from '@/lib/platform/admin'
import { toErrorResponse } from '@/lib/auth/errors'

const COUNT_TABLES = new Set(['profiles', 'flows', 'automations', 'whatsapp_config'])

async function countByAccount(table: string): Promise<Map<string, number>> {
  if (!COUNT_TABLES.has(table)) throw new Error(`Unsupported count table: ${table}`)

  const counts = new Map<string, number>()
  try {
    const result = await db.execute(
      sql.raw(`select account_id, count(*)::int as count from ${table} group by account_id`),
    )
    for (const row of result.rows as { account_id: string; count: number }[]) {
      counts.set(row.account_id, Number(row.count) || 0)
    }
  } catch (error) {
    if ((error as { code?: string })?.code !== '42P01') throw error
    console.warn(`[GET /api/platform/accounts] table ${table} is not migrated yet; usage defaults to 0`)
  }
  return counts
}

export async function GET() {
  try {
    await requirePlatformAdmin()

    const accounts = await db.select().from(crmAccounts).orderBy(desc(crmAccounts.createdAt))

    const [platformAdminUserIds, members, flows, automations, whatsappLines] = await Promise.all([
      getPlatformAdminUserIds(),
      countByAccount('profiles'),
      countByAccount('flows'),
      countByAccount('automations'),
      countByAccount('whatsapp_config'),
    ])
    const customerAccounts = accounts.filter(
      (account) => !platformAdminUserIds.has(account.ownerUserId),
    )

    return NextResponse.json({
      accounts: customerAccounts.map((account) => ({
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
