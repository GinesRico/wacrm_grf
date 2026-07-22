import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
}))

vi.mock('@/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (h.row ? [h.row] : []),
        }),
      }),
    }),
  },
}))

// decrypt is identity in tests so we don't depend on real ciphertext.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}))

import { loadAiConfig } from './config'

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  apiKey: 'enc-key',
  systemPrompt: null,
  isActive: false,
  autoReplyEnabled: false,
  autoReplyMaxPerConversation: 3,
  handoffAgentId: null,
  embeddingsApiKey: null,
}

beforeEach(() => {
  h.row = ROW
})

describe('loadAiConfig requireActive', () => {
  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(null, 'acct')).toBeNull()
  })

  it('returns the config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(null, 'acct', {
      requireActive: false,
    })
    expect(config).not.toBeNull()
    expect(config!.provider).toBe('openai')
    expect(config!.apiKey).toBe('plain:enc-key')
  })

  it('returns null when there is no row', async () => {
    h.row = null
    expect(await loadAiConfig(null, 'acct', { requireActive: false })).toBeNull()
  })
})
