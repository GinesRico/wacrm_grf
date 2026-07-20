import { eq, sql } from 'drizzle-orm'

import { db } from '@/db/client'
import { crmAccounts } from '@/db/schema'
import { ForbiddenError } from '@/lib/auth/errors'

export type AccountStatus = 'trial' | 'active' | 'suspended' | 'cancelled'
export type AccountFeature = 'ai' | 'api' | 'broadcasts'

export interface AccountEntitlements {
  id: string
  status: AccountStatus
  plan: string
  max_users: number
  max_flows: number
  max_automations: number
  max_whatsapp_lines: number
  allow_ai: boolean
  allow_api: boolean
  allow_broadcasts: boolean
  trial_ends_at: string | null
}

export async function getAccountEntitlements(
  _unusedClient: unknown,
  accountId: string,
): Promise<AccountEntitlements> {
  const [account] = await db
    .select()
    .from(crmAccounts)
    .where(eq(crmAccounts.id, accountId))
    .limit(1)

  if (!account) {
    throw new ForbiddenError('Could not load account limits')
  }

  return {
    id: account.id,
    status: account.status as AccountStatus,
    plan: account.plan,
    max_users: account.maxUsers,
    max_flows: account.maxFlows,
    max_automations: account.maxAutomations,
    max_whatsapp_lines: account.maxWhatsappLines,
    allow_ai: account.allowAi,
    allow_api: account.allowApi,
    allow_broadcasts: account.allowBroadcasts,
    trial_ends_at: account.trialEndsAt?.toISOString() ?? null,
  }
}

export function assertAccountWritable(entitlements: AccountEntitlements): void {
  if (entitlements.status === 'suspended') {
    throw new ForbiddenError('This account is suspended')
  }
  if (entitlements.status === 'cancelled') {
    throw new ForbiddenError('This account is cancelled')
  }
}

async function exactCount(
  _unusedClient: unknown,
  table: string,
  accountId: string,
  _column = 'id',
): Promise<number> {
  void _column

  if (!['profiles', 'flows', 'automations', 'whatsapp_config'].includes(table)) {
    throw new ForbiddenError(`Could not check ${table} limit`)
  }

  try {
    const result = await db.execute(
      sql.raw(`select count(*)::int as count from ${table} where account_id = '${accountId.replaceAll("'", "''")}'`),
    )
    return Number((result.rows[0] as { count?: number } | undefined)?.count ?? 0)
  } catch (error) {
    if ((error as { code?: string })?.code === '42P01') return 0
    throw new ForbiddenError(`Could not check ${table} limit`)
  }
}

export async function assertCanInviteMember(
  client: unknown,
  accountId: string,
): Promise<void> {
  const entitlements = await getAccountEntitlements(client, accountId)
  assertAccountWritable(entitlements)
  const members = await exactCount(client, 'profiles', accountId, 'user_id')
  if (members >= entitlements.max_users) {
    throw new ForbiddenError(`User limit reached for plan '${entitlements.plan}'`)
  }
}

export async function assertCanCreateFlow(
  client: unknown,
  accountId: string,
): Promise<void> {
  const entitlements = await getAccountEntitlements(client, accountId)
  assertAccountWritable(entitlements)
  const flows = await exactCount(client, 'flows', accountId)
  if (flows >= entitlements.max_flows) {
    throw new ForbiddenError(`Flow limit reached for plan '${entitlements.plan}'`)
  }
}

export async function assertCanCreateAutomation(
  client: unknown,
  accountId: string,
): Promise<void> {
  const entitlements = await getAccountEntitlements(client, accountId)
  assertAccountWritable(entitlements)
  const automations = await exactCount(client, 'automations', accountId)
  if (automations >= entitlements.max_automations) {
    throw new ForbiddenError(`Automation limit reached for plan '${entitlements.plan}'`)
  }
}

export async function assertCanCreateWhatsAppLine(
  client: unknown,
  accountId: string,
  existingLineId?: string | null,
): Promise<void> {
  const entitlements = await getAccountEntitlements(client, accountId)
  assertAccountWritable(entitlements)
  if (existingLineId) return
  const lines = await exactCount(client, 'whatsapp_config', accountId)
  if (lines >= entitlements.max_whatsapp_lines) {
    throw new ForbiddenError(`WhatsApp line limit reached for plan '${entitlements.plan}'`)
  }
}

export async function assertFeatureEnabled(
  client: unknown,
  accountId: string,
  feature: AccountFeature,
): Promise<void> {
  const entitlements = await getAccountEntitlements(client, accountId)
  assertAccountWritable(entitlements)
  const enabled =
    feature === 'ai'
      ? entitlements.allow_ai
      : feature === 'api'
        ? entitlements.allow_api
        : entitlements.allow_broadcasts
  if (!enabled) {
    throw new ForbiddenError(`Feature '${feature}' is not enabled for this plan`)
  }
}
