import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { messageTemplates } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { decrypt } from "@/lib/whatsapp/encryption";
import { getDefaultWhatsAppConfig } from "@/lib/whatsapp/config";
import { submitMessageTemplate } from "@/lib/whatsapp/meta-api";
import {
  validateTemplatePayload,
  type TemplatePayload,
} from "@/lib/whatsapp/template-validators";
import { buildMetaTemplatePayload } from "@/lib/whatsapp/template-components";
import { ensureImageHeaderHandle } from "@/lib/whatsapp/template-header-handle";
import { normalizeStatus } from "@/lib/whatsapp/template-status-normalize";
import { serializeMessageTemplate } from "@/lib/whatsapp/template-serializer";
import { publishRealtimeEvent } from "@/lib/realtime/soketi-server";

function buildUpsertRow(
  accountId: string,
  userId: string,
  payload: TemplatePayload,
  extras: {
    status: "DRAFT" | string;
    metaTemplateId: string | null;
    submissionError: string | null;
  },
): typeof messageTemplates.$inferInsert {
  return {
    accountId,
    userId,
    name: payload.name,
    category: payload.category,
    language: payload.language,
    headerType: payload.header_type ?? null,
    headerContent: payload.header_content ?? null,
    headerMediaUrl: payload.header_media_url ?? null,
    headerHandle: payload.header_handle ?? null,
    bodyText: payload.body_text,
    footerText: payload.footer_text ?? null,
    buttons: payload.buttons ?? null,
    sampleValues: payload.sample_values ?? null,
    status: extras.status,
    metaTemplateId: extras.metaTemplateId,
    submissionError: extras.submissionError,
    rejectionReason: null,
    lastSubmittedAt: new Date(),
  };
}

async function upsertTemplateRow(row: typeof messageTemplates.$inferInsert) {
  const [existing] = await db
    .select({ id: messageTemplates.id })
    .from(messageTemplates)
    .where(
      and(
        eq(messageTemplates.accountId, row.accountId),
        eq(messageTemplates.name, row.name),
        eq(messageTemplates.language, row.language ?? "en_US"),
      ),
    )
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(messageTemplates)
      .set(row)
      .where(eq(messageTemplates.id, existing.id))
      .returning();
    return updated;
  }

  const [inserted] = await db.insert(messageTemplates).values(row).returning();
  return inserted;
}

export async function POST(request: Request) {
  try {
    let ctx;
    try {
      ctx = await requireDbRole("admin");
    } catch (err) {
      return toErrorResponse(err);
    }

    let payload: TemplatePayload;
    try {
      payload = (await request.json()) as TemplatePayload;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    if (payload.category === "Authentication") {
      return NextResponse.json(
        {
          error:
            'AUTHENTICATION templates are not yet supported here - create them in Meta WhatsApp Manager and use "Sync from Meta".',
        },
        { status: 400 },
      );
    }

    try {
      validateTemplatePayload(payload);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Validation failed." },
        { status: 400 },
      );
    }

    const dryRun =
      process.env.WHATSAPP_TEMPLATES_DRY_RUN === "true" ||
      process.env.WHATSAPP_TEMPLATES_DRY_RUN === "1";

    let metaTemplateId: string;
    let metaStatus: string;

    if (dryRun) {
      metaTemplateId = `dry-run-${crypto.randomUUID()}`;
      metaStatus = "PENDING";
    } else {
      const config = await getDefaultWhatsAppConfig(null, ctx.accountId);
      if (!config) {
        return NextResponse.json(
          {
            error:
              "WhatsApp not configured. Connect your WhatsApp Business account in Settings first.",
          },
          { status: 400 },
        );
      }
      if (!config.waba_id) {
        return NextResponse.json(
          {
            error:
              "WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.",
          },
          { status: 400 },
        );
      }

      const accessToken = decrypt(config.access_token);

      try {
        await ensureImageHeaderHandle(payload, accessToken);
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : "Header image upload failed." },
          { status: 400 },
        );
      }

      const metaPayload = buildMetaTemplatePayload(payload);
      try {
        const meta = await submitMessageTemplate({
          wabaId: config.waba_id,
          accessToken,
          payload: metaPayload,
        });
        metaTemplateId = meta.id;
        metaStatus = meta.status;
      } catch (e) {
        const message = e instanceof Error ? e.message : "Meta submit failed.";
        await upsertTemplateRow(
          buildUpsertRow(ctx.accountId, ctx.userId, payload, {
            status: "DRAFT",
            metaTemplateId: null,
            submissionError: message,
          }),
        );
        const isRateLimit = /\b429\b/.test(message);
        return NextResponse.json(
          {
            error: isRateLimit
              ? "Meta rate limit hit (100 template creates per hour). Try again later."
              : message,
          },
          { status: isRateLimit ? 429 : 502 },
        );
      }
    }

    const row = await upsertTemplateRow(
      buildUpsertRow(ctx.accountId, ctx.userId, payload, {
        status: normalizeStatus(metaStatus),
        metaTemplateId,
        submissionError: null,
      }),
    );
    const template = serializeMessageTemplate(row);
    await publishRealtimeEvent("template.created", {
      accountId: ctx.accountId,
      payload: { template },
    }).catch((error) => {
      console.warn("[realtime] failed to publish template.created:", error);
    });

    return NextResponse.json({
      success: true,
      template,
      dry_run: dryRun,
    });
  } catch (error) {
    console.error("Error submitting template:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to submit template.",
      },
      { status: 500 },
    );
  }
}
