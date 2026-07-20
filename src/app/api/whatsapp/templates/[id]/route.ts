import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { messageTemplates } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { decrypt } from "@/lib/whatsapp/encryption";
import { getDefaultWhatsAppConfig } from "@/lib/whatsapp/config";
import {
  deleteMessageTemplate,
  editMessageTemplate,
} from "@/lib/whatsapp/meta-api";
import {
  validateTemplatePayload,
  type TemplatePayload,
} from "@/lib/whatsapp/template-validators";
import { buildMetaTemplatePayload } from "@/lib/whatsapp/template-components";
import { ensureImageHeaderHandle } from "@/lib/whatsapp/template-header-handle";
import { serializeMessageTemplate } from "@/lib/whatsapp/template-serializer";

const EDITABLE_STATUSES = new Set(["APPROVED", "REJECTED", "PAUSED"]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isDryRun(): boolean {
  return (
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === "true" ||
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === "1"
  );
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    let ctx;
    try {
      ctx = await requireDbRole("admin");
    } catch (err) {
      return toErrorResponse(err);
    }

    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: "Invalid template id." },
        { status: 400 },
      );
    }

    let payload: TemplatePayload;
    try {
      payload = (await request.json()) as TemplatePayload;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const [existing] = await db
      .select()
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.id, id),
          eq(messageTemplates.accountId, ctx.accountId),
        ),
      )
      .limit(1);

    if (!existing) {
      return NextResponse.json({ error: "Template not found." }, { status: 404 });
    }

    if (!existing.metaTemplateId) {
      return NextResponse.json(
        {
          error:
            "This template was never submitted to Meta - use New Template to submit it instead.",
        },
        { status: 400 },
      );
    }

    if (!EDITABLE_STATUSES.has(existing.status ?? "")) {
      return NextResponse.json(
        {
          error: `Templates in status ${existing.status} cannot be edited. Allowed: APPROVED, REJECTED, PAUSED.`,
        },
        { status: 400 },
      );
    }

    if (payload.category === "Authentication") {
      return NextResponse.json(
        {
          error:
            "AUTHENTICATION templates are not editable here - manage them in Meta WhatsApp Manager.",
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

    if (!isDryRun()) {
      const config = await getDefaultWhatsAppConfig(null, ctx.accountId);
      if (!config) {
        return NextResponse.json(
          { error: "WhatsApp not configured." },
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
        await editMessageTemplate({
          metaTemplateId: existing.metaTemplateId,
          accessToken,
          components: metaPayload.components,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Meta edit failed.";
        await db
          .update(messageTemplates)
          .set({
            submissionError: message,
            lastSubmittedAt: new Date(),
          })
          .where(eq(messageTemplates.id, id));
        return NextResponse.json({ error: message }, { status: 502 });
      }
    }

    const [row] = await db
      .update(messageTemplates)
      .set({
        category: payload.category,
        headerType: payload.header_type ?? null,
        headerContent: payload.header_content ?? null,
        headerMediaUrl: payload.header_media_url ?? null,
        headerHandle: payload.header_handle ?? null,
        bodyText: payload.body_text,
        footerText: payload.footer_text ?? null,
        buttons: payload.buttons ?? null,
        sampleValues: payload.sample_values ?? null,
        status: "PENDING",
        submissionError: null,
        rejectionReason: null,
        lastSubmittedAt: new Date(),
      })
      .where(eq(messageTemplates.id, id))
      .returning();

    return NextResponse.json({
      success: true,
      template: serializeMessageTemplate(row),
      dry_run: isDryRun(),
    });
  } catch (error) {
    console.error("Error editing template:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to edit template.",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    let ctx;
    try {
      ctx = await requireDbRole("admin");
    } catch (err) {
      return toErrorResponse(err);
    }

    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: "Invalid template id." },
        { status: 400 },
      );
    }

    const [existing] = await db
      .select()
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.id, id),
          eq(messageTemplates.accountId, ctx.accountId),
        ),
      )
      .limit(1);

    if (!existing) {
      return NextResponse.json({ error: "Template not found." }, { status: 404 });
    }

    if (existing.metaTemplateId && !isDryRun()) {
      const config = await getDefaultWhatsAppConfig(null, ctx.accountId);
      if (!config || !config.waba_id) {
        return NextResponse.json(
          { error: "WhatsApp not configured - cannot delete on Meta." },
          { status: 400 },
        );
      }
      const accessToken = decrypt(config.access_token);
      try {
        await deleteMessageTemplate({
          wabaId: config.waba_id,
          accessToken,
          name: existing.name,
          metaTemplateId: existing.metaTemplateId,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Meta delete failed.";
        return NextResponse.json({ error: message }, { status: 502 });
      }
    }

    await db.delete(messageTemplates).where(eq(messageTemplates.id, id));

    return NextResponse.json({ success: true, dry_run: isDryRun() });
  } catch (error) {
    console.error("Error deleting template:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to delete template.",
      },
      { status: 500 },
    );
  }
}
