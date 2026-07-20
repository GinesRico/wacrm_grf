import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { messageTemplates } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";

export async function GET() {
  try {
    const ctx = await getCurrentDbAccount();
    const templates = await db
      .select()
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.accountId, ctx.accountId),
          eq(messageTemplates.status, "APPROVED"),
        ),
      )
      .orderBy(desc(messageTemplates.createdAt));

    return NextResponse.json({
      templates: templates.map((template) => ({
        id: template.id,
        user_id: template.userId,
        account_id: template.accountId,
        name: template.name,
        category: template.category,
        language: template.language,
        header_type: template.headerType,
        header_content: template.headerContent,
        header_handle: template.headerHandle,
        header_media_url: template.headerMediaUrl,
        body_text: template.bodyText,
        footer_text: template.footerText,
        buttons: template.buttons,
        sample_values: template.sampleValues,
        status: template.status,
        meta_template_id: template.metaTemplateId,
        rejection_reason: template.rejectionReason,
        quality_score: template.qualityScore,
        submission_error: template.submissionError,
        last_submitted_at: template.lastSubmittedAt?.toISOString() ?? null,
        created_at: template.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
