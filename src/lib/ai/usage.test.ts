import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  inserted: null as Record<string, unknown> | null,
  shouldThrow: false,
}))

vi.mock('@/db/client', () => ({
  db: {
    insert: () => ({
      values: async (payload: Record<string, unknown>) => {
        h.inserted = payload
        if (h.shouldThrow) throw new Error('boom')
      },
    }),
  },
}))

import { logAiUsage } from './usage'

beforeEach(() => {
  h.inserted = null
  h.shouldThrow = false
})

describe('logAiUsage', () => {
  it('inserts a row mapping normalized usage to the log columns', async () => {
    await logAiUsage(null, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      mode: 'auto_reply',
      provider: 'anthropic',
      model: 'claude-x',
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })

    expect(h.inserted).toEqual({
      accountId: 'acct-1',
      conversationId: 'conv-1',
      mode: 'auto_reply',
      provider: 'anthropic',
      model: 'claude-x',
      promptTokens: 30,
      completionTokens: 6,
      totalTokens: 36,
    })
  })

  it('is a no-op when the provider reported no usage', async () => {
    await logAiUsage(null, {
      accountId: 'acct-1',
      conversationId: null,
      mode: 'draft',
      provider: 'openai',
      model: 'gpt-x',
      usage: null,
    })

    expect(h.inserted).toBeNull()
  })

  it('never throws when the insert errors', async () => {
    h.shouldThrow = true

    await expect(
      logAiUsage(null, {
        accountId: 'acct-1',
        conversationId: 'conv-1',
        mode: 'draft',
        provider: 'openai',
        model: 'gpt-x',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
    ).resolves.toBeUndefined()
  })
})
