import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  rows: [{ id: 'row-1' }] as { id: string }[],
  calls: [] as Array<{ update: Record<string, unknown> }>,
}))

vi.mock('@/db/client', () => ({
  db: {
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        h.calls.push({ update: payload })
        return {
          where: () => ({
            returning: async () => h.rows,
            then: (onF: (value: unknown) => unknown, onR?: (error: unknown) => unknown) =>
              Promise.resolve(undefined).then(onF, onR),
          }),
        }
      },
    }),
  },
}))

import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from './template-webhook'

beforeEach(() => {
  h.rows = [{ id: 'row-1' }]
  h.calls = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('isTemplateWebhookField', () => {
  it('recognises the three template fields', () => {
    expect(isTemplateWebhookField('message_template_status_update')).toBe(true)
    expect(isTemplateWebhookField('message_template_quality_update')).toBe(true)
    expect(isTemplateWebhookField('message_template_components_update')).toBe(true)
  })

  it('rejects messaging fields', () => {
    expect(isTemplateWebhookField('messages')).toBe(false)
    expect(isTemplateWebhookField('message_status')).toBe(false)
  })
})

describe('handleTemplateWebhookChange - status update', () => {
  it('flips status to APPROVED and clears any rejection reason', async () => {
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: {
        event: 'APPROVED',
        message_template_id: 12345,
        message_template_name: 'order_confirmation',
        message_template_language: 'en_US',
      },
    })

    expect(h.calls[0].update).toMatchObject({
      status: 'APPROVED',
      rejectionReason: null,
      submissionError: null,
    })
  })

  it('persists the reason field on REJECTED', async () => {
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: {
        event: 'REJECTED',
        message_template_id: 'TMPL_99',
        reason: 'Template uses non-compliant language.',
      },
    })

    expect(h.calls[0].update.rejectionReason).toBe(
      'Template uses non-compliant language.',
    )
  })

  it('falls back to a generic reason when REJECTED has no reason', async () => {
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: { event: 'REJECTED', message_template_id: '7' },
    })

    expect(h.calls[0].update.rejectionReason).toBe('Rejected by Meta')
  })

  it('normalises PENDING_REVIEW to PENDING', async () => {
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: { event: 'PENDING_REVIEW', message_template_id: '1' },
    })

    expect(h.calls[0].update.status).toBe('PENDING')
  })

  it('logs and exits when meta_template_id is missing', async () => {
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: { event: 'APPROVED' },
    })

    expect(h.calls).toHaveLength(0)
  })

  it('logs a warning when the row is unknown locally', async () => {
    const warn = vi.spyOn(console, 'warn')
    h.rows = []

    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: {
        event: 'APPROVED',
        message_template_id: 'NEVER_SEEN',
        message_template_name: 'mystery',
      },
    })

    expect(warn).toHaveBeenCalled()
  })
})

describe('handleTemplateWebhookChange - quality update', () => {
  it('sets qualityScore from new_quality_score', async () => {
    await handleTemplateWebhookChange({
      field: 'message_template_quality_update',
      value: {
        message_template_id: '99',
        previous_quality_score: 'GREEN',
        new_quality_score: 'YELLOW',
      },
    })

    expect(h.calls[0].update).toMatchObject({ qualityScore: 'YELLOW' })
  })

  it('stores null for unrecognised quality scores', async () => {
    await handleTemplateWebhookChange({
      field: 'message_template_quality_update',
      value: {
        message_template_id: '99',
        new_quality_score: 'PURPLE',
      },
    })

    expect(h.calls[0].update).toMatchObject({ qualityScore: null })
  })
})

describe('handleTemplateWebhookChange - components update', () => {
  it('is an info-log no-op', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    await handleTemplateWebhookChange({
      field: 'message_template_components_update',
      value: {
        message_template_id: '5',
        message_template_name: 'x',
      },
    })

    expect(h.calls).toHaveLength(0)
    expect(info).toHaveBeenCalled()
  })
})

describe('handleTemplateWebhookChange - unknown field', () => {
  it('is a defensive no-op', async () => {
    await handleTemplateWebhookChange({
      field: 'message_template_future_field',
      value: {},
    })

    expect(h.calls).toHaveLength(0)
  })
})
