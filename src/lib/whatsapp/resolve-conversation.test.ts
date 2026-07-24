import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  config: { id: 'cfg-1', status: 'connected' } as { id: string; status: string } | null,
  contact: null as { id: string; name?: string | null } | null,
  conversation: null as { id: string } | null,
  insertedContactId: 'c-new',
  insertedConversationId: 'cv-new',
  selectStep: 0,
  insertStep: 0,
}))

vi.mock('@/lib/whatsapp/config', () => ({
  getDefaultWhatsAppConfig: vi.fn(async () => h.config),
  getWhatsAppConfigById: vi.fn(async () => h.config),
}))

vi.mock('@/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            h.selectStep += 1
            if (h.selectStep === 1) return [{ userId: 'owner-1' }]
            if (h.selectStep === 2) return h.contact ? [h.contact] : []
            if (h.selectStep === 3) return h.conversation ? [h.conversation] : []
            return []
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: async () => undefined }),
    }),
    insert: () => {
      h.insertStep += 1
      const insert = {
        values: () => insert,
        onConflictDoUpdate: () => insert,
        returning: async () => {
          if (h.insertStep === 1) return [{ id: h.insertedContactId }]
          return [{ id: h.insertedConversationId }]
        },
      }
      return insert
    },
  },
}))

import { resolveConversationByPhone } from './resolve-conversation'
import { SendMessageError } from './send-message'

beforeEach(() => {
  h.config = { id: 'cfg-1', status: 'connected' }
  h.contact = null
  h.conversation = null
  h.insertedContactId = 'c-new'
  h.insertedConversationId = 'cv-new'
  h.selectStep = 0
  h.insertStep = 0
})

describe('resolveConversationByPhone', () => {
  it('rejects an invalid phone before any DB call', async () => {
    await expect(
      resolveConversationByPhone(null, 'acct', 'not-a-phone'),
    ).rejects.toBeInstanceOf(SendMessageError)
  })

  it('fails with whatsapp_not_configured when no config owner exists', async () => {
    h.config = null

    const error = (await resolveConversationByPhone(
      null,
      'acct',
      '+14155550123',
    ).catch((e: SendMessageError) => e)) as SendMessageError

    expect(error.code).toBe('whatsapp_not_configured')
    expect(error.status).toBe(400)
  })

  it('returns the existing contact + conversation without creating', async () => {
    h.contact = { id: 'c1', name: null }
    h.conversation = { id: 'cv1' }

    const res = await resolveConversationByPhone(null, 'acct', '+14155550123')

    expect(res).toEqual({
      conversationId: 'cv1',
      contactId: 'c1',
      whatsappConfigId: 'cfg-1',
      contactCreated: false,
    })
  })

  it('creates contact + conversation when none exist', async () => {
    const res = await resolveConversationByPhone(
      null,
      'acct',
      '+14155550199',
      'Jane',
    )

    expect(res).toEqual({
      conversationId: 'cv-new',
      contactId: 'c-new',
      whatsappConfigId: 'cfg-1',
      contactCreated: true,
    })
  })
})
