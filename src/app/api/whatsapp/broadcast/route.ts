import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { messageTemplates } from '@/db/schema'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { assertFeatureEnabled } from '@/lib/platform/entitlements'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getDefaultWhatsAppConfig } from '@/lib/whatsapp/config'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

interface BroadcastResult {
  phone: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string
  error?: string
}

interface NewRecipient {
  phone: string
  params?: string[]
  messageParams?: SendTimeParams
}

function serializeTemplate(row: typeof messageTemplates.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    name: row.name,
    category: row.category,
    language: row.language,
    header_type: row.headerType,
    header_content: row.headerContent,
    header_handle: row.headerHandle,
    header_media_url: row.headerMediaUrl,
    body_text: row.bodyText,
    footer_text: row.footerText,
    buttons: row.buttons,
    sample_values: row.sampleValues,
    status: row.status,
    meta_template_id: row.metaTemplateId,
    rejection_reason: row.rejectionReason,
    quality_score: row.qualityScore,
    submission_error: row.submissionError,
    last_submitted_at: row.lastSubmittedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

export async function POST(request: Request) {
  try {
    const { userId, accountId } = await getCurrentAccount()

    const limit = checkRateLimit(`broadcast:${userId}`, RATE_LIMITS.broadcast)
    if (!limit.success) return rateLimitResponse(limit)

    try {
      await assertFeatureEnabled(null, accountId, 'broadcasts')
    } catch (err) {
      if (err instanceof Error) {
        return NextResponse.json({ error: err.message }, { status: 403 })
      }
      throw err
    }

    const body = await request.json()
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
    } = body

    let recipients: NewRecipient[]
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params) ? template_params : []
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }))
    } else {
      return NextResponse.json(
        {
          error:
            'Provide either `recipients` (preferred) or `phone_numbers` - must be a non-empty array',
        },
        { status: 400 },
      )
    }

    if (!template_name) {
      return NextResponse.json(
        { error: 'template_name is required' },
        { status: 400 },
      )
    }

    const config = await getDefaultWhatsAppConfig(null, accountId)
    if (!config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Please set up your WhatsApp integration first.',
        },
        { status: 400 },
      )
    }

    const accessToken = decrypt(config.access_token)
    const [template] = await db
      .select()
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.accountId, accountId),
          eq(messageTemplates.name, template_name),
          eq(messageTemplates.language, template_language || 'en_US'),
        ),
      )
      .limit(1)

    const rawTemplateRow = template ? serializeTemplate(template) : null
    if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
      return NextResponse.json(
        {
          error:
            'Template row is malformed locally - run "Sync from Meta" in Settings to repair it before broadcasting.',
        },
        { status: 500 },
      )
    }

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0

    for (const recipient of recipients) {
      const sanitized = sanitizePhoneForMeta(recipient.phone)

      if (!isValidE164(sanitized)) {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: 'Invalid phone number format',
        })
        failedCount++
        continue
      }

      const variants = phoneVariants(sanitized)
      let sentMessageId: string | null = null
      let lastError: string | null = null

      for (const variant of variants) {
        try {
          const result = await sendTemplateMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            templateName: template_name,
            language: template_language || 'en_US',
            template: rawTemplateRow ?? undefined,
            messageParams: recipient.messageParams,
            params: recipient.params ?? [],
          })
          sentMessageId = result.messageId
          lastError = null
          break
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error'
          if (!isRecipientNotAllowedError(errorMessage)) {
            lastError = errorMessage
            break
          }
          lastError = errorMessage
        }
      }

      if (sentMessageId) {
        results.push({
          phone: recipient.phone,
          status: 'sent',
          whatsapp_message_id: sentMessageId,
        })
        sentCount++
      } else {
        console.error(`Failed to send broadcast to ${recipient.phone}:`, lastError)
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: lastError || 'Unknown error',
        })
        failedCount++
      }
    }

    return NextResponse.json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      results,
    })
  } catch (error) {
    console.error('Error in WhatsApp broadcast POST:', error)
    return toErrorResponse(error)
  }
}
