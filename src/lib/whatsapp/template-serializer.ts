import { messageTemplates } from "@/db/schema";

export function serializeMessageTemplate(row: typeof messageTemplates.$inferSelect) {
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
  };
}
