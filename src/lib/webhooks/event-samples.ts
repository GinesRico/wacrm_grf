import { db } from '@/db/client';
import { webhookEventSamples } from '@/db/schema';

export interface WebhookVariablePath {
  path: string;
  variable: string;
  value: string;
}

export interface RecordWebhookEventSampleInput {
  accountId: string;
  source: string;
  eventType: string;
  triggerType?: string | null;
  payload: unknown;
}

const MAX_DEPTH = 6;
const MAX_VARIABLES = 200;
const MAX_VALUE_PREVIEW = 160;

export function extractWebhookVariablePaths(
  payload: unknown,
): WebhookVariablePath[] {
  const out: WebhookVariablePath[] = [];
  walk(payload, [], out);
  if (isPlainRecord(payload) && isPlainRecord(payload.data)) {
    walk(payload.data, [], out);
  }
  return out.slice(0, MAX_VARIABLES);
}

export async function recordWebhookEventSample(
  input: RecordWebhookEventSampleInput,
): Promise<void> {
  const variablePaths = extractWebhookVariablePaths(input.payload);
  await db
    .insert(webhookEventSamples)
    .values({
      accountId: input.accountId,
      source: input.source,
      eventType: input.eventType,
      triggerType: input.triggerType ?? null,
      samplePayload: input.payload ?? {},
      variablePaths,
      receivedAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        webhookEventSamples.accountId,
        webhookEventSamples.source,
        webhookEventSamples.eventType,
      ],
      set: {
        triggerType: input.triggerType ?? null,
        samplePayload: input.payload ?? {},
        variablePaths,
        receivedAt: new Date(),
        updatedAt: new Date(),
      },
    });
}

function walk(
  value: unknown,
  path: string[],
  out: WebhookVariablePath[],
): void {
  if (out.length >= MAX_VARIABLES || path.length > MAX_DEPTH) return;
  if (isPlainRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (!key) continue;
      walk(child, [...path, key], out);
      if (out.length >= MAX_VARIABLES) return;
    }
    return;
  }

  if (Array.isArray(value)) {
    value.slice(0, 10).forEach((child, index) => {
      walk(child, [...path, String(index)], out);
    });
    return;
  }

  if (path.length === 0) return;
  const valueText = previewValue(value);
  out.push({
    path: path.join('.'),
    variable: `{{ vars.${path.join('.')} }}`,
    value: valueText,
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function previewValue(value: unknown): string {
  if (value == null) return '';
  const raw =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value);
  return raw.length > MAX_VALUE_PREVIEW
    ? `${raw.slice(0, MAX_VALUE_PREVIEW - 1)}…`
    : raw;
}
