import { describe, expect, it } from 'vitest'

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

function fakePostgres({
  account = baseAccount,
  counts = {},
}: {
  account?: AccountEntitlements
  counts?: Record<string, number>
}) {
  return {
    from(_table: string) {
      void _table
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: account, error: null }),
              }
            },
          }
        },
      }
    },
    countFor(table: string) {
      return counts[table] ?? 0
    },
  }
}

function fakeCountPostgres(args: Parameters<typeof fakePostgres>[0]) {
  const base = fakePostgres(args)
  return {
    from(table: string) {
      if (table === 'accounts') return base.from(table)
      return {
        select: () => ({
          eq: async () => ({ count: base.countFor(table), error: null }),
        }),
      }
    },
  } as never
}

describe('account entitlements', () => {
  it('blocks disabled features', async () => {
    await expect(
      assertFeatureEnabled(fakeCountPostgres({}) as never, 'acct', 'ai'),
    ).rejects.toThrow(/not enabled/)
  })

  it('allows enabled features', async () => {
    await expect(
      assertFeatureEnabled(fakeCountPostgres({}) as never, 'acct', 'broadcasts'),
    ).resolves.toBeUndefined()
  })

  it('blocks flow creation at the configured limit', async () => {
    await expect(
      assertCanCreateFlow(
        fakeCountPostgres({ counts: { flows: 2 } }) as never,
        'acct',
      ),
    ).rejects.toThrow(/Flow limit/)
  })

  it('blocks writes for suspended accounts', async () => {
    await expect(
      assertCanCreateFlow(
        fakeCountPostgres({
          account: { ...baseAccount, status: 'suspended' },
          counts: { flows: 0 },
        }) as never,
        'acct',
      ),
    ).rejects.toThrow(/suspended/)
  })
})
