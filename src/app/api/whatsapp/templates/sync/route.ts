import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { messageTemplates } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { decrypt } from "@/lib/whatsapp/encryption";
import { getDefaultWhatsAppConfig } from "@/lib/whatsapp/config";
import { normalizeStatus } from "@/lib/whatsapp/template-status-normalize";
import type { TemplateButton, TemplateSampleValues } from "@/types";

const META_API_VERSION = "v21.0";
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

interface MetaButton {
  type: string;
  text: string;
  url?: string;
  phone_number?: string;
  example?: string[] | string;
}

interface MetaTemplateComponent {
  type: string;
  text?: string;
  format?: string;
  buttons?: MetaButton[];
  example?: {
    header_text?: string[];
    header_handle?: string[];
    body_text?: string[][];
  };
}

interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components?: MetaTemplateComponent[];
  quality_score?: { score?: string } | string;
}

async function readJsonResponse<T>(
  response: Response,
): Promise<{ data?: T; error?: string }> {
  const text = await response.text();
  if (!text) return {};

  try {
    return { data: JSON.parse(text) as T };
  } catch {
    return {
      error: text.trim().slice(0, 500) || `HTTP ${response.status}`,
    };
  }
}

function normalizeCategory(
  meta: string,
): "Marketing" | "Utility" | "Authentication" {
  const upper = meta.toUpperCase();
  if (upper === "UTILITY") return "Utility";
  if (upper === "AUTHENTICATION") return "Authentication";
  return "Marketing";
}

function normalizeQualityScore(
  raw: MetaTemplate["quality_score"],
): "GREEN" | "YELLOW" | "RED" | null {
  const score =
    typeof raw === "string" ? raw : raw?.score ? String(raw.score) : null;
  if (!score) return null;
  const upper = score.toUpperCase();
  return upper === "GREEN" || upper === "YELLOW" || upper === "RED"
    ? (upper as "GREEN" | "YELLOW" | "RED")
    : null;
}

function parseButtons(metaButtons: MetaButton[] | undefined): TemplateButton[] {
  if (!metaButtons?.length) return [];
  const out: TemplateButton[] = [];
  for (const b of metaButtons) {
    switch (b.type?.toUpperCase()) {
      case "QUICK_REPLY":
        out.push({ type: "QUICK_REPLY", text: b.text });
        break;
      case "URL":
        out.push({
          type: "URL",
          text: b.text,
          url: b.url ?? "",
          example: Array.isArray(b.example) ? b.example[0] : b.example,
        });
        break;
      case "PHONE_NUMBER":
        out.push({
          type: "PHONE_NUMBER",
          text: b.text,
          phone_number: b.phone_number ?? "",
        });
        break;
      case "COPY_CODE":
        out.push({
          type: "COPY_CODE",
          text: b.text,
          example: Array.isArray(b.example)
            ? b.example[0] ?? ""
            : b.example ?? "",
        });
        break;
    }
  }
  return out;
}

function extractSampleValues(
  body: MetaTemplateComponent | undefined,
  header: MetaTemplateComponent | undefined,
): TemplateSampleValues | null {
  const bodySample = body?.example?.body_text?.[0];
  const headerSample = header?.example?.header_text;
  if (!bodySample?.length && !headerSample?.length) return null;
  const sv: TemplateSampleValues = {};
  if (bodySample?.length) sv.body = bodySample;
  if (headerSample?.length) sv.header = headerSample;
  return sv;
}

export async function POST() {
  try {
    let ctx;
    try {
      ctx = await requireDbRole("admin");
    } catch (err) {
      return toErrorResponse(err);
    }

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

    const metaTemplates: MetaTemplate[] = [];
    let nextUrl:
      | string
      | null = `${META_API_BASE}/${config.waba_id}/message_templates?limit=100&fields=id,name,language,status,category,components,quality_score`;
    const PAGE_CAP = 20;
    let pageCount = 0;

    while (nextUrl && pageCount < PAGE_CAP) {
      pageCount++;
      const metaRes: Response = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!metaRes.ok) {
        let metaErr = `Meta API error: ${metaRes.status}`;
        const body = await readJsonResponse<{ error?: { message?: string } }>(
          metaRes,
        );
        if (body.data?.error?.message) {
          metaErr = body.data.error.message;
        } else if (body.error) {
          metaErr = body.error;
        }
        return NextResponse.json({ error: metaErr }, { status: 502 });
      }

      const parsed = await readJsonResponse<{
        data?: MetaTemplate[];
        paging?: { next?: string };
      }>(metaRes);
      if (!parsed.data) {
        return NextResponse.json(
          { error: parsed.error || "Meta returned an invalid response." },
          { status: 502 },
        );
      }
      const metaBody = parsed.data;
      if (metaBody.data) metaTemplates.push(...metaBody.data);
      nextUrl = metaBody.paging?.next ?? null;
    }

    let inserted = 0;
    let updated = 0;
    const errors: { name: string; language: string; message: string }[] = [];

    for (const t of metaTemplates) {
      const body = (t.components ?? []).find((c) => c.type === "BODY");
      const header = (t.components ?? []).find((c) => c.type === "HEADER");
      const footer = (t.components ?? []).find((c) => c.type === "FOOTER");
      const buttons = (t.components ?? []).find((c) => c.type === "BUTTONS");

      const parsedButtons = parseButtons(buttons?.buttons);
      const sampleValues = extractSampleValues(body, header);

      const headerFormat = header?.format?.toUpperCase();
      const headerType =
        headerFormat === "TEXT" ||
        headerFormat === "IMAGE" ||
        headerFormat === "VIDEO" ||
        headerFormat === "DOCUMENT"
          ? headerFormat.toLowerCase()
          : null;

      const row: typeof messageTemplates.$inferInsert = {
        accountId: ctx.accountId,
        userId: ctx.userId,
        name: t.name,
        category: normalizeCategory(t.category),
        language: t.language,
        headerType,
        headerContent: header?.text ?? null,
        headerHandle: header?.example?.header_handle?.[0] ?? null,
        bodyText: body?.text ?? "",
        footerText: footer?.text ?? null,
        buttons: parsedButtons.length ? parsedButtons : null,
        sampleValues,
        status: normalizeStatus(t.status),
        metaTemplateId: t.id,
        qualityScore: normalizeQualityScore(t.quality_score),
        updatedAt: new Date(),
      };

      const [existing] = await db
        .select({ id: messageTemplates.id })
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.accountId, ctx.accountId),
            eq(messageTemplates.name, t.name),
            eq(messageTemplates.language, t.language),
          ),
        )
        .limit(1);

      try {
        if (existing?.id) {
          await db
            .update(messageTemplates)
            .set(row)
            .where(eq(messageTemplates.id, existing.id));
          updated++;
        } else {
          await db.insert(messageTemplates).values(row);
          inserted++;
        }
      } catch (err) {
        errors.push({
          name: t.name,
          language: t.language,
          message: err instanceof Error ? err.message : "Template sync failed.",
        });
      }
    }

    return NextResponse.json({
      success: errors.length === 0,
      total: metaTemplates.length,
      inserted,
      updated,
      errors,
      truncated: pageCount >= PAGE_CAP && nextUrl !== null,
    });
  } catch (error) {
    console.error("Error syncing WhatsApp templates:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to sync templates",
      },
      { status: 500 },
    );
  }
}
