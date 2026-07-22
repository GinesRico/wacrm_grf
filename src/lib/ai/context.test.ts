import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  rows: [] as Array<{ senderType: string; contentText: string | null }>,
}))

vi.mock('@/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => h.rows,
          }),
        }),
      }),
    }),
  },
}))

import { buildConversationContext } from './context'

beforeEach(() => {
  h.rows = []
})

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the function reverses it.
    h.rows = [
      { senderType: 'customer', contentText: 'third' },
      { senderType: 'agent', contentText: 'second' },
      { senderType: 'customer', contentText: 'first' },
    ]

    const out = await buildConversationContext(null, 'conv-1')

    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    h.rows = [{ senderType: 'bot', contentText: 'auto reply' }]

    const out = await buildConversationContext(null, 'conv-1')

    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    h.rows = [
      { senderType: 'customer', contentText: '   ' },
      { senderType: 'customer', contentText: null },
      { senderType: 'customer', contentText: 'real' },
    ]

    const out = await buildConversationContext(null, 'conv-1')

    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })
})
