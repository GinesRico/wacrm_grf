import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  contact: { id: 'contact-1' } as { id: string } | null,
  existingConversation: null as { id: string; status: string } | null,
  conversationInserts: [] as Record<string, unknown>[],
  selectStep: 0,
  sendMessageToConversation: vi.fn(),
}))

vi.mock('@/lib/auth/current-account', () => ({
  getCurrentDbAccount: vi.fn(async () => ({
    userId: 'user-1',
    accountId: 'acct-1',
    role: 'admin',
    account: { id: 'acct-1', name: 'Acme' },
  })),
}))

vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { send: { limit: 100, windowMs: 60_000 } },
  checkRateLimit: vi.fn(() => ({ success: true })),
  rateLimitResponse: vi.fn(),
}))

vi.mock('@/lib/whatsapp/send-message', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/send-message')>()
  return {
    ...actual,
    sendMessageToConversation: h.sendMessageToConversation,
  }
})

vi.mock('@/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => {
              h.selectStep += 1
              return [{ id: 'cfg-1', status: 'connected' }]
            },
          }),
          limit: async () => {
            h.selectStep += 1
            if (h.selectStep === 1) return h.contact ? [h.contact] : []
            if (h.selectStep === 3) {
              return h.existingConversation ? [h.existingConversation] : []
            }
            return []
          },
        }),
      }),
    }),
    insert: () => {
      const insert = {
        values: (payload: Record<string, unknown>) => {
          h.conversationInserts.push(payload)
          return insert
        },
        returning: async () => [{ id: 'conv-new' }],
      }
      return insert
    },
  },
}))

import { POST } from './route'

function postContactTemplate(overrides: Record<string, unknown> = {}) {
  return POST(
    new Request('http://localhost/api/whatsapp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contact_id: 'contact-1',
        message_type: 'template',
        template_name: 'order_update',
        template_language: 'en_US',
        template_message_params: { body: ['Acme', '#1234'] },
        template_params: ['Acme', '#1234'],
        ...overrides,
      }),
    }),
  )
}

describe('POST /api/whatsapp/send - contact_id template path', () => {
  beforeEach(() => {
    h.contact = { id: 'contact-1' }
    h.existingConversation = null
    h.conversationInserts = []
    h.selectStep = 0
    h.sendMessageToConversation.mockReset()
    h.sendMessageToConversation.mockResolvedValue({
      messageId: 'msg-1',
      whatsappMessageId: 'wamid-1',
    })
  })

  it('creates a conversation for a contact with none, then sends the template', async () => {
    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.whatsapp_message_id).toBe('wamid-1')
    expect(h.conversationInserts).toHaveLength(1)
    expect(h.sendMessageToConversation).toHaveBeenCalledWith(
      null,
      'acct-1',
      expect.objectContaining({ conversationId: 'conv-new' }),
    )
  })

  it('reuses an existing conversation instead of creating a duplicate', async () => {
    h.existingConversation = { id: 'conv-existing', status: 'open' }

    const res = await postContactTemplate()

    expect(res.status).toBe(200)
    expect(h.conversationInserts).toHaveLength(0)
    expect(h.sendMessageToConversation).toHaveBeenCalledWith(
      null,
      'acct-1',
      expect.objectContaining({ conversationId: 'conv-existing' }),
    )
  })

  it('404s when the contact is not in the caller account', async () => {
    h.contact = null

    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error).toMatch(/contact not found/i)
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
  })

  it('400s when neither conversation_id nor contact_id is provided', async () => {
    const res = await POST(
      new Request('http://localhost/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_type: 'template' }),
      }),
    )

    expect(res.status).toBe(400)
  })
})
