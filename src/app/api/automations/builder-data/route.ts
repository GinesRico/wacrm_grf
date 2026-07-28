import { NextResponse } from 'next/server'
import { asc, desc, eq } from 'drizzle-orm'

import { db } from '@/db/client'
import {
  customFields,
  messageTemplates,
  pipelineStages,
  pipelines,
  tags,
  webhookEventSamples,
  whatsappConfig,
} from '@/db/schema'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()

    const [
      tagRows,
      templateRows,
      fieldRows,
      pipelineRows,
      stageRows,
      whatsappRows,
      sampleRows,
    ] =
      await Promise.all([
        db
          .select()
          .from(tags)
          .where(eq(tags.accountId, accountId))
          .orderBy(asc(tags.name)),
        db
          .select()
          .from(messageTemplates)
          .where(eq(messageTemplates.accountId, accountId))
          .orderBy(asc(messageTemplates.name)),
        db
          .select()
          .from(customFields)
          .where(eq(customFields.accountId, accountId))
          .orderBy(asc(customFields.fieldName)),
        db
          .select()
          .from(pipelines)
          .where(eq(pipelines.accountId, accountId))
          .orderBy(asc(pipelines.name)),
        db
          .select({
            id: pipelineStages.id,
            name: pipelineStages.name,
            pipelineId: pipelineStages.pipelineId,
            position: pipelineStages.position,
          })
          .from(pipelineStages)
          .innerJoin(pipelines, eq(pipelineStages.pipelineId, pipelines.id))
          .where(eq(pipelines.accountId, accountId))
          .orderBy(asc(pipelineStages.position)),
        db
          .select({
            id: whatsappConfig.id,
            label: whatsappConfig.label,
            phoneNumberId: whatsappConfig.phoneNumberId,
            status: whatsappConfig.status,
            isDefault: whatsappConfig.isDefault,
          })
          .from(whatsappConfig)
          .where(eq(whatsappConfig.accountId, accountId))
          .orderBy(
            desc(whatsappConfig.isDefault),
            asc(whatsappConfig.label),
            asc(whatsappConfig.createdAt),
          ),
        db
          .select({
            id: webhookEventSamples.id,
            source: webhookEventSamples.source,
            eventType: webhookEventSamples.eventType,
            triggerType: webhookEventSamples.triggerType,
            variablePaths: webhookEventSamples.variablePaths,
            receivedAt: webhookEventSamples.receivedAt,
          })
          .from(webhookEventSamples)
          .where(eq(webhookEventSamples.accountId, accountId))
          .orderBy(desc(webhookEventSamples.receivedAt)),
      ])

    return NextResponse.json({
      tags: tagRows.map((row) => ({
        id: row.id,
        user_id: row.userId,
        account_id: row.accountId,
        name: row.name,
        color: row.color,
        created_at: row.createdAt.toISOString(),
      })),
      templates: templateRows
        .filter((row) => row.status === 'APPROVED')
        .map((row) => ({
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
        })),
      customFields: fieldRows.map((row) => ({
        id: row.id,
        user_id: row.userId,
        account_id: row.accountId,
        field_name: row.fieldName,
        field_type: row.fieldType,
        field_options: row.fieldOptions,
        created_at: row.createdAt.toISOString(),
      })),
      pipelines: pipelineRows.map((row) => ({ id: row.id, name: row.name })),
      stages: stageRows.map((row) => ({
        id: row.id,
        name: row.name,
        pipeline_id: row.pipelineId,
        position: row.position,
      })),
      whatsappLines: whatsappRows.map((row) => ({
        id: row.id,
        label: row.label,
        phone_number_id: row.phoneNumberId,
        status: row.status,
        is_default: row.isDefault,
      })),
      webhookSamples: sampleRows.map((row) => ({
        id: row.id,
        source: row.source,
        event_type: row.eventType,
        trigger_type: row.triggerType,
        variable_paths: row.variablePaths,
        received_at: row.receivedAt.toISOString(),
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
