import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: null as Record<string, unknown> | null,
  counts: {} as Record<string, number>,
}))

vi.mock('@/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (h.account ? [h.account] : []),
        }),
      }),
    }),
    execute: async (query: unknown) => {
      const sqlText = String(query)
      const table =
        sqlText.match(/from\s+([a-z_]+)/i)?.[1] ??
        Object.keys(h.counts)[0] ??
        ''
      return { rows: [{ count: h.counts[table] ?? 0 }] }
    },
  },
}))

import {
  assertCanCreateFlow,
  assertFeatureEnabled,
  type AccountEntitlements,
} from './entitlements'

const baseAccount: AccountEntitlements = {
  id: 'acct',
  status: 'active',
  plan: 'starter',
  max_users: 3,
  max_flows: 2,
  max_automations: 2,
  max_whatsapp_lines: 1,
  allow_ai: false,
  allow_api: false,
  allow_broadcasts: true,
  trial_ends_at: null,
}

function drizzleAccount(account: AccountEntitlements) {
  return {
    id: account.id,
    status: account.status,
    plan: account.plan,
    maxUsers: account.max_users,
    maxFlows: account.max_flows,
    maxAutomations: account.max_automations,
    maxWhatsappLines: account.max_whatsapp_lines,
    allowAi: account.allow_ai,
    allowApi: account.allow_api,
    allowBroadcasts: account.allow_broadcasts,
    trialEndsAt: account.trial_ends_at
      ? new Date(account.trial_ends_at)
      : null,
  }
}

beforeEach(() => {
  h.account = drizzleAccount(baseAccount)
  h.counts = {}
})

describe('account entitlements', () => {
  it('blocks disabled features', async () => {
    await expect(assertFeatureEnabled(null, 'acct', 'ai')).rejects.toThrow(
      /not enabled/,
    )
  })

  it('allows enabled features', async () => {
    await expect(
      assertFeatureEnabled(null, 'acct', 'broadcasts'),
    ).resolves.toBeUndefined()
  })

  it('blocks flow creation at the configured limit', async () => {
    h.counts = { flows: 2 }
    await expect(assertCanCreateFlow(null, 'acct')).rejects.toThrow(
      /Flow limit/,
    )
  })

  it('blocks writes for suspended accounts', async () => {
    h.account = drizzleAccount({ ...baseAccount, status: 'suspended' })
    h.counts = { flows: 0 }
    await expect(assertCanCreateFlow(null, 'acct')).rejects.toThrow(
      /suspended/,
    )
  })
})
