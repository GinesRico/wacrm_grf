import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; url: string; secret: string }>,
  updates: [] as Record<string, unknown>[],
  executes: [] as unknown[],
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (s: string) => s,
  encrypt: (s: string) => s,
}))

vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}))

vi.mock('@/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => h.rows,
      }),
    }),
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        h.updates.push(payload)
        return { where: async () => undefined }
      },
    }),
    execute: async (query: unknown) => {
      h.executes.push(query)
    },
  },
}))

import { dispatchWebhookEvent } from './deliver'
import { isDeliverableUrl } from './ssrf'

beforeEach(() => {
  h.rows = []
  h.updates = []
  h.executes = []
  vi.mocked(isDeliverableUrl).mockResolvedValue(true)
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => vi.unstubAllGlobals())

describe('dispatchWebhookEvent', () => {
  it('signs + POSTs and resets failure count on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response)
    vi.stubGlobal('fetch', fetchMock)
    h.rows = [{ id: 'a', url: 'https://a.test/hook', secret: 's1' }]

    await dispatchWebhookEvent(null, 'acct-1', 'message.received', { x: 1 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://a.test/hook')
    expect(opts.redirect).toBe('manual')
    expect(opts.headers['X-Wacrm-Event']).toBe('message.received')
    expect(opts.headers['X-Wacrm-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
    expect(JSON.parse(opts.body).id).toMatch(/[0-9a-f-]{36}/)
    expect(h.updates[0]).toMatchObject({ failureCount: 0 })
    expect(h.executes).toHaveLength(0)
  })

  it('records an atomic failure when the endpoint errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response))
    h.rows = [{ id: 'b', url: 'https://b.test/hook', secret: 's2' }]

    await dispatchWebhookEvent(null, 'acct-1', 'message.received', {})

    expect(h.executes).toHaveLength(1)
    expect(h.updates).toHaveLength(0)
  })

  it('blocks a non-public target without fetching', async () => {
    vi.mocked(isDeliverableUrl).mockResolvedValue(false)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    h.rows = [{ id: 'c', url: 'https://127.0.0.1/hook', secret: 's3' }]

    await dispatchWebhookEvent(null, 'acct-1', 'message.received', {})

    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.executes).toHaveLength(1)
  })

  it('does nothing when no endpoints are subscribed', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await dispatchWebhookEvent(null, 'acct-1', 'message.received', {})

    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.executes).toHaveLength(0)
    expect(h.updates).toHaveLength(0)
  })
})
