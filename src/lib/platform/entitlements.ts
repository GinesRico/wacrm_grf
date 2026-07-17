import type { SupabaseClient } from '@supabase/supabase-js'
import { ForbiddenError } from '@/lib/auth/account'

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

const ACCOUNT_COLUMNS =
  'id, status, plan, max_users, max_flows, max_automations, max_whatsapp_lines, allow_ai, allow_api, allow_broadcasts, trial_ends_at'

export async function getAccountEntitlements(
  supabase: SupabaseClient,
  accountId: string,
): Promise<AccountEntitlements> {
  const { data, error } = await supabase
    .from('accounts')
    .select(ACCOUNT_COLUMNS)
    .eq('id', accountId)
    .maybeSingle()

  if (error || !data) {
    throw new ForbiddenError('Could not load account limits')
  }

  return data as AccountEntitlements
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
  supabase: SupabaseClient,
  table: string,
  accountId: string,
  column = 'id',
): Promise<number> {
  const { count, error } = await supabase
    .from(table)
    .select(column, { count: 'exact', head: true })
    .eq('account_id', accountId)
  if (error) throw new ForbiddenError(`Could not check ${table} limit`)
  return count ?? 0
}

export async function assertCanInviteMember(
  supabase: SupabaseClient,
  accountId: string,
): Promise<void> {
  const entitlements = await getAccountEntitlements(supabase, accountId)
  assertAccountWritable(entitlements)
  const members = await exactCount(supabase, 'profiles', accountId, 'user_id')
  if (members >= entitlements.max_users) {
    throw new ForbiddenError(`User limit reached for plan '${entitlements.plan}'`)
  }
}

export async function assertCanCreateFlow(
  supabase: SupabaseClient,
  accountId: string,
): Promise<void> {
  const entitlements = await getAccountEntitlements(supabase, accountId)
  assertAccountWritable(entitlements)
  const flows = await exactCount(supabase, 'flows', accountId)
  if (flows >= entitlements.max_flows) {
    throw new ForbiddenError(`Flow limit reached for plan '${entitlements.plan}'`)
  }
}

export async function assertCanCreateAutomation(
  supabase: SupabaseClient,
  accountId: string,
): Promise<void> {
  const entitlements = await getAccountEntitlements(supabase, accountId)
  assertAccountWritable(entitlements)
  const automations = await exactCount(supabase, 'automations', accountId)
  if (automations >= entitlements.max_automations) {
    throw new ForbiddenError(`Automation limit reached for plan '${entitlements.plan}'`)
  }
}

export async function assertCanCreateWhatsAppLine(
  supabase: SupabaseClient,
  accountId: string,
  existingLineId?: string | null,
): Promise<void> {
  const entitlements = await getAccountEntitlements(supabase, accountId)
  assertAccountWritable(entitlements)
  if (existingLineId) return
  const lines = await exactCount(supabase, 'whatsapp_config', accountId)
  if (lines >= entitlements.max_whatsapp_lines) {
    throw new ForbiddenError(`WhatsApp line limit reached for plan '${entitlements.plan}'`)
  }
}

export async function assertFeatureEnabled(
  supabase: SupabaseClient,
  accountId: string,
  feature: AccountFeature,
): Promise<void> {
  const entitlements = await getAccountEntitlements(supabase, accountId)
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
