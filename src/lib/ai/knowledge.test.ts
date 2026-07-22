import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  embedTexts: vi.fn(),
  rows: [] as { content: string }[],
  inserted: null as Record<string, unknown>[] | null,
  deleted: false,
}))

vi.mock('./embeddings', () => ({
  embedTexts: h.embedTexts,
  toVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
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
    delete: () => ({
      where: async () => {
        h.deleted = true
      },
    }),
    insert: () => ({
      values: async (rows: Record<string, unknown>[]) => {
        h.inserted = rows
      },
    }),
  },
}))

import { retrieveKnowledge, ingestDocument } from './knowledge'

beforeEach(() => {
  h.rows = []
  h.inserted = null
  h.deleted = false
  h.embedTexts.mockReset()
  h.embedTexts.mockImplementation(async (_key: string, inputs: string[]) =>
    inputs.map((_, i) => [i, i]),
  )
})

describe('retrieveKnowledge', () => {
  it('returns [] for an empty query without touching the DB', async () => {
    h.rows = [{ content: 'unused' }]

    expect(await retrieveKnowledge(null, 'acct', { embeddingsApiKey: null }, '  ')).toEqual([])
  })

  it('returns lexical matches from Drizzle rows', async () => {
    h.rows = [{ content: 'F1' }, { content: 'F2' }]

    const out = await retrieveKnowledge(null, 'acct', { embeddingsApiKey: null }, 'refund', 1)

    expect(out).toEqual(['F1'])
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('ignores embeddings during retrieval and still uses lexical search', async () => {
    h.rows = [{ content: 'S1' }, { content: 'S2' }, { content: 'S3' }]

    const out = await retrieveKnowledge(null, 'acct', { embeddingsApiKey: 'sk-x' }, 'shipping', 3)

    expect(out).toEqual(['S1', 'S2', 'S3'])
    expect(h.embedTexts).not.toHaveBeenCalled()
  })
})

describe('ingestDocument', () => {
  it('embeds chunks when a key is present', async () => {
    await ingestDocument(null, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world')

    expect(h.deleted).toBe(true)
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    expect(h.inserted).toHaveLength(1)
    expect(h.inserted![0].embedding).toBe('[0,0]')
    expect(h.inserted![0].accountId).toBe('acct')
  })

  it('stores chunks without embeddings when there is no key', async () => {
    await ingestDocument(null, 'acct', { embeddingsApiKey: null }, 'doc-1', 'hello world')

    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(h.inserted![0].embedding).toBeNull()
  })

  it('deletes existing chunks and inserts nothing for empty content', async () => {
    await ingestDocument(null, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', '   ')

    expect(h.deleted).toBe(true)
    expect(h.inserted).toBeNull()
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('still stores lexical chunks when embedding fails, then rethrows', async () => {
    h.embedTexts.mockRejectedValueOnce(new Error('rate limited'))

    await expect(
      ingestDocument(null, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world'),
    ).rejects.toThrow('rate limited')

    expect(h.inserted).toHaveLength(1)
    expect(h.inserted![0].embedding).toBeNull()
  })
})
