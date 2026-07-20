import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { messageTemplates } from "@/db/schema";
import { normalizeStatus } from "./template-status-normalize";

const TEMPLATE_WEBHOOK_FIELDS = new Set([
  "message_template_status_update",
  "message_template_quality_update",
  "message_template_components_update",
]);

export function isTemplateWebhookField(field: string): boolean {
  return TEMPLATE_WEBHOOK_FIELDS.has(field);
}

interface TemplateStatusUpdateValue {
  event?: string;
  message_template_id?: string | number;
  message_template_name?: string;
  message_template_language?: string;
  reason?: string;
}

interface TemplateQualityUpdateValue {
  message_template_id?: string | number;
  message_template_name?: string;
  message_template_language?: string;
  previous_quality_score?: string;
  new_quality_score?: string;
}

interface TemplateComponentsUpdateValue {
  message_template_id?: string | number;
  message_template_name?: string;
  message_template_language?: string;
}

export interface TemplateWebhookChange {
  field: string;
  value: unknown;
}

export async function handleTemplateWebhookChange(
  change: TemplateWebhookChange,
  _unusedClient?: unknown,
): Promise<void> {
  switch (change.field) {
    case "message_template_status_update":
      await handleStatusUpdate(change.value as TemplateStatusUpdateValue);
      return;
    case "message_template_quality_update":
      await handleQualityUpdate(change.value as TemplateQualityUpdateValue);
      return;
    case "message_template_components_update":
      handleComponentsUpdate(change.value as TemplateComponentsUpdateValue);
      return;
  }
}

async function handleStatusUpdate(value: TemplateStatusUpdateValue): Promise<void> {
  const metaTemplateId =
    value.message_template_id !== undefined ? String(value.message_template_id) : null;
  if (!metaTemplateId || !value.event) {
    console.warn("[template-webhook] status update missing message_template_id or event:", value);
    return;
  }

  const status = normalizeStatus(value.event);
  const rows = await db
    .update(messageTemplates)
    .set({
      status,
      rejectionReason: status === "REJECTED" ? value.reason ?? "Rejected by Meta" : null,
      submissionError: null,
      updatedAt: new Date(),
    })
    .where(eq(messageTemplates.metaTemplateId, metaTemplateId))
    .returning({ id: messageTemplates.id });

  if (rows.length === 0) {
    console.warn(
      "[template-webhook] status update received for unknown template:",
      metaTemplateId,
      value.message_template_name,
    );
  }
  if (rows.length > 1) {
    console.warn(
      `[template-webhook] status update matched ${rows.length} rows for meta_template_id ${metaTemplateId}; investigate.`,
    );
  }
}

async function handleQualityUpdate(value: TemplateQualityUpdateValue): Promise<void> {
  const metaTemplateId =
    value.message_template_id !== undefined ? String(value.message_template_id) : null;
  if (!metaTemplateId) {
    console.warn("[template-webhook] quality update missing message_template_id:", value);
    return;
  }

  const raw = value.new_quality_score;
  const score =
    raw && ["GREEN", "YELLOW", "RED"].includes(raw.toUpperCase())
      ? raw.toUpperCase()
      : null;

  await db
    .update(messageTemplates)
    .set({ qualityScore: score, updatedAt: new Date() })
    .where(eq(messageTemplates.metaTemplateId, metaTemplateId));
}

function handleComponentsUpdate(value: TemplateComponentsUpdateValue): void {
  console.info(
    "[template-webhook] components updated by Meta for template",
    value.message_template_id,
    value.message_template_name,
    "- run Sync from Meta in Settings to pull the new components.",
  );
}
