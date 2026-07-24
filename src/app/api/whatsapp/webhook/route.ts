import { NextResponse, after } from 'next/server';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  appointmentAvailabilityMessages,
  broadcastRecipients,
  broadcasts,
  contacts,
  conversations,
  messageReactions,
  messages,
  whatsappConfig,
} from '@/db/schema';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { downloadMedia, getMediaUrl } from '@/lib/whatsapp/meta-api';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import {
  getArveraAppointmentsConnection,
  normalizeAppointmentsConfig,
} from '@/lib/integrations/arvera-appointments';
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook';
import { publishRealtimeEvent } from '@/lib/realtime/soketi-server';
import { publishBroadcastRecipientUpdatedById } from '@/lib/realtime/broadcast-events';
import { publicObjectUrl, putObject } from '@/lib/storage/alarik';
import { buildIncomingMediaPath } from '@/lib/storage/upload-media';

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing can fan out to per-media Meta verification calls, so
// give it headroom beyond the platform default (Vercel clamps this to the
// plan's ceiling). Tune as needed.
export const maxDuration = 60;

interface AppointmentSlotSelection {
  reply_id: string;
  appointment_date: string;
  appointment_time: string;
  appointment_start: string;
  appointment_end: string;
  appointment_service: string;
}

function parseAppointmentSlotReplyId(replyId: string | null): {
  date: string;
  time: string;
} | null {
  const match = replyId?.match(/^appt_slot_(\d{4}-\d{2}-\d{2})_(\d{4})_\d+$/);
  if (!match) return null;
  const [, date, rawTime] = match;
  return { date, time: `${rawTime.slice(0, 2)}:${rawTime.slice(2)}` };
}

function getTimeZoneOffset(date: string, timeZone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  });
  const offset = formatter
    .formatToParts(probe)
    .find((part) => part.type === 'timeZoneName')
    ?.value?.replace('GMT', '');
  if (!offset) return 'Z';
  if (offset === '') return 'Z';
  const match = offset.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return 'Z';
  const [, sign, hours, minutes = '00'] = match;
  return `${sign}${hours.padStart(2, '0')}:${minutes}`;
}

function addMinutesToLocalDateTime(
  date: string,
  time: string,
  minutes: number
): {
  date: string;
  time: string;
} {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const parsed = new Date(year, month - 1, day, hour, minute + minutes, 0);
  const yyyy = parsed.getFullYear();
  const mm = String(parsed.getMonth() + 1).padStart(2, '0');
  const dd = String(parsed.getDate()).padStart(2, '0');
  const hh = String(parsed.getHours()).padStart(2, '0');
  const mi = String(parsed.getMinutes()).padStart(2, '0');
  return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${mi}` };
}

function localDateTimeWithOffset(
  date: string,
  time: string,
  timeZone: string
): string {
  return `${date}T${time}:00${getTimeZoneOffset(date, timeZone)}`;
}

function slotRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function serializeWhatsappConfig(row: typeof whatsappConfig.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    department_id: row.departmentId,
    label: row.label,
    phone_number_id: row.phoneNumberId,
    waba_id: row.wabaId,
    access_token: row.accessToken,
    verify_token: row.verifyToken,
    status: row.status,
    connected_at: isoOrNull(row.connectedAt),
    registered_at: isoOrNull(row.registeredAt),
    subscribed_apps_at: isoOrNull(row.subscribedAppsAt),
    last_registration_error: row.lastRegistrationError,
    is_default: row.isDefault,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function serializeMessageRow(row: typeof messages.$inferSelect) {
  return {
    id: row.id,
    conversation_id: row.conversationId,
    sender_type: row.senderType,
    sender_id: row.senderId,
    content_type: row.contentType,
    content_text: row.contentText,
    media_url: row.mediaUrl,
    template_name: row.templateName,
    message_id: row.messageId,
    status: row.status,
    sent_at: isoOrNull(row.sentAt),
    delivered_at: isoOrNull(row.deliveredAt),
    read_at: isoOrNull(row.readAt),
    failed_at: isoOrNull(row.failedAt),
    reply_to_message_id: row.replyToMessageId,
    interactive_reply_id: row.interactiveReplyId,
    interactive_payload: row.interactivePayload,
    is_forwarded: row.isForwarded,
    forwarded_from_message_id: row.forwardedFromMessageId,
    deleted_at: isoOrNull(row.deletedAt),
    deleted_by_user_id: row.deletedByUserId,
    is_starred: row.isStarred,
    ai_generated: row.aiGenerated,
    created_at: row.createdAt.toISOString(),
  };
}

function serializeConversationRow(row: typeof conversations.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    contact_id: row.contactId,
    whatsapp_config_id: row.whatsappConfigId,
    department_id: row.departmentId,
    status: row.status,
    assigned_agent_id: row.assignedAgentId,
    last_message_text: row.lastMessageText,
    last_message_at: isoOrNull(row.lastMessageAt),
    unread_count: row.unreadCount,
    ai_autoreply_disabled: row.aiAutoreplyDisabled,
    ai_reply_count: row.aiReplyCount,
    ai_handoff_summary: row.aiHandoffSummary,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function serializeContactRow(row: typeof contacts.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    phone: row.phone,
    phone_normalized: row.phoneNormalized,
    name: row.name,
    email: row.email,
    company: row.company,
    avatar_url: row.avatarUrl,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function serializeReactionRow(row: typeof messageReactions.$inferSelect) {
  return {
    id: row.id,
    message_id: row.messageId,
    conversation_id: row.conversationId,
    actor_type: row.actorType,
    actor_id: row.actorId,
    emoji: row.emoji,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function extractSlotTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.match(/(\d{2}:\d{2})/)?.[1] ?? null;
}

async function resolveSlotTimes(args: {
  accountId: string;
  conversationId: string;
  date: string;
  time: string;
}): Promise<{
  startTime: string;
  endTime: string;
  service: string | null;
} | null> {
  let rows: Array<{
    slots: unknown;
    service: string | null;
  }>;
  try {
    rows = await db
      .select({
        slots: appointmentAvailabilityMessages.slots,
        service: appointmentAvailabilityMessages.service,
      })
      .from(appointmentAvailabilityMessages)
      .where(
        and(
          eq(appointmentAvailabilityMessages.accountId, args.accountId),
          eq(
            appointmentAvailabilityMessages.conversationId,
            args.conversationId
          ),
          eq(appointmentAvailabilityMessages.date, args.date)
        )
      )
      .orderBy(desc(appointmentAvailabilityMessages.createdAt))
      .limit(5);
  } catch (error) {
    console.warn(
      '[webhook] could not load availability slots for reply:',
      error instanceof Error ? error.message : error
    );
    return null;
  }

  for (const row of rows) {
    const slots = Array.isArray(row.slots) ? row.slots : [];
    for (const rawSlot of slots) {
      const slot = slotRecord(rawSlot);
      const start = extractSlotTime(slot.hora_inicio ?? slot.startTime);
      if (start !== args.time) continue;
      if (
        typeof slot.startTime === 'string' &&
        typeof slot.endTime === 'string'
      ) {
        return {
          startTime: slot.startTime,
          endTime: slot.endTime,
          service: typeof row.service === 'string' ? row.service : null,
        };
      }
    }
  }
  return null;
}

async function buildAppointmentSlotSelection(
  accountId: string,
  conversationId: string,
  replyId: string | null
): Promise<AppointmentSlotSelection | null> {
  const parsed = parseAppointmentSlotReplyId(replyId);
  if (!parsed || !replyId) return null;

  let duration = 45;
  let timeZone = 'Europe/Madrid';
  try {
    const connection = await getArveraAppointmentsConnection(db, accountId);
    const config = normalizeAppointmentsConfig(connection?.config);
    duration = config.duracion;
    timeZone = config.timezone;
  } catch (error) {
    console.warn(
      '[webhook] could not load appointments duration for slot reply:',
      error
    );
  }

  const resolvedSlot = await resolveSlotTimes({
    accountId,
    conversationId,
    date: parsed.date,
    time: parsed.time,
  });
  const end = addMinutesToLocalDateTime(parsed.date, parsed.time, duration);
  const appointmentStart =
    resolvedSlot?.startTime ??
    localDateTimeWithOffset(parsed.date, parsed.time, timeZone);
  const appointmentEnd =
    resolvedSlot?.endTime ??
    localDateTimeWithOffset(end.date, end.time, timeZone);
  return {
    reply_id: replyId,
    appointment_date: parsed.date,
    appointment_time: parsed.time,
    appointment_start: appointmentStart,
    appointment_end: appointmentEnd,
    appointment_service: resolvedSlot?.service ?? '',
  };
}

interface WhatsAppMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string };
  video?: { id: string; mime_type: string; caption?: string };
  document?: {
    id: string;
    mime_type: string;
    filename?: string;
    caption?: string;
  };
  audio?: { id: string; mime_type: string };
  sticker?: { id: string; mime_type: string };
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  reaction?: { message_id: string; emoji: string };
  /**
   * Meta sends template quick-reply button taps as `type: "button"`,
   * not as `interactive.button_reply`. The payload is the stable id.
   */
  button?: { text?: string; payload?: string };
  /**
   * Set when the customer taps a button or list row on an interactive
   * message we sent. `button_reply.id` / `list_reply.id` is whatever id
   * we put on the button/row when sending — the Flows engine uses this
   * to advance the per-contact run.
   */
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  /** Present for swipe-replies and forwarded messages. */
  context?: {
    id?: string;
    forwarded?: boolean;
    frequently_forwarded?: boolean;
  };
}

interface WhatsAppWebhookEntry {
  id: string;
  changes: Array<{
    value: {
      messaging_product: string;
      metadata: {
        display_phone_number: string;
        phone_number_id: string;
      };
      contacts?: Array<{
        profile: { name: string };
        wa_id: string;
      }>;
      messages?: WhatsAppMessage[];
      statuses?: Array<{
        id: string;
        status: string;
        timestamp: string;
        recipient_id: string;
      }>;
    };
    field: string;
  }>;
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('hub.mode');
    const challenge = searchParams.get('hub.challenge');
    const verifyToken = searchParams.get('hub.verify_token');

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      );
    }

    // Fetch all whatsapp configs to check verify tokens
    let configs: Array<{ id: string; verify_token: string | null }>;
    try {
      configs = (
        await db
          .select({
            id: whatsappConfig.id,
            verifyToken: whatsappConfig.verifyToken,
          })
          .from(whatsappConfig)
      ).map((config) => ({
        id: config.id,
        verify_token: config.verifyToken,
      }));
    } catch (error) {
      console.error('Error fetching configs for verification:', error);
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      );
    }

    // Check if any config's verify_token matches. Also collect the
    // matching row so we can opportunistically upgrade its token to
    // GCM if it was still in the legacy CBC format.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null;
    for (const config of configs) {
      if (!config.verify_token) continue;
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfig = config;
          break;
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      // Fire-and-forget GCM upgrade. Safe to run on every subscribe
      // since it's a no-op once the column is already GCM.
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void db
          .update(whatsappConfig)
          .set({ verifyToken: encrypt(verifyToken) })
          .where(eq(whatsappConfig.id, matchedConfig.id))
          .catch((error: unknown) => {
            console.warn(
              '[webhook] verify_token GCM upgrade failed:',
              (error as { message?: string })?.message ?? error
            );
          });
      }
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    );
  } catch (error) {
    console.error('Error in webhook GET verification:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed. request.json() would re-encode and break the signature.
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    // 401 (not 200) — we want Meta's delivery dashboard to show failures
    // loudly if a misconfiguration causes signatures to stop matching,
    // rather than silently eating events.
    console.warn('[webhook] rejected request with invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let body: { entry?: WhatsAppWebhookEntry[] };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Process AFTER the response so we ack Meta within their ~20s timeout
  // (a slow ack triggers Meta retries + duplicate inserts), while still
  // guaranteeing the work runs to completion.
  //
  // This MUST use `after()` rather than a detached `processWebhook(body)`
  // promise: on serverless platforms (we run on Vercel) the function can
  // be frozen or terminated the moment the response is sent, so a floating
  // promise's DB writes are not guaranteed to finish. That dropped a
  // non-deterministic *subset* of inbound messages — contacts/conversations
  // were created but the message insert never landed, leaving conversations
  // that show in the inbox with an empty thread, and no logs to explain it
  // (see issue #301). `after()` hands the callback to the runtime, which
  // keeps the function alive until it resolves (within the route's
  // maxDuration).
  after(async () => {
    try {
      await processWebhook(body);
    } catch (error) {
      console.error('Error processing webhook:', error);
    }
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
}

async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }) {
  if (!body.entry) return;

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      // Template-lifecycle events (status / quality / components
      // updates from Meta) come in on a different change.field and
      // have a different value shape — route them through the
      // dedicated handler. Skip the messaging branches below so we
      // don't try to read message-shaped fields off a template event.
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange(
          { field: change.field, value: change.value as unknown },
          db
        );
        continue;
      }

      const value = change.value;

      // Handle status updates
      if (value.statuses) {
        for (const status of value.statuses) {
          await handleStatusUpdate(status);
        }
      }

      // Handle incoming messages
      if (!value.messages || !value.contacts) continue;

      const phoneNumberId = value.metadata.phone_number_id;

      // Find user's config by phone_number_id. `.single()` returns
      // PGRST116 for both 0 rows AND ≥2 rows — distinguish them so
      // operators see the real cause in logs. ≥2 rows shouldn't happen
      // post-migration 013 (UNIQUE constraint), but a row created
      // before the constraint, or a race, would still surface here.
      let configRows: ReturnType<typeof serializeWhatsappConfig>[];
      try {
        configRows = (
          await db
            .select()
            .from(whatsappConfig)
            .where(eq(whatsappConfig.phoneNumberId, phoneNumberId))
        ).map(serializeWhatsappConfig);
      } catch (error) {
        console.error(
          'Error fetching whatsapp_config for phone_number_id:',
          phoneNumberId,
          error
        );
        continue;
      }

      if (!configRows || configRows.length === 0) {
        console.error('No config found for phone_number_id:', phoneNumberId);
        continue;
      }

      if (configRows.length > 1) {
        console.error(
          `Multiple configs (${configRows.length}) found for phone_number_id:`,
          phoneNumberId,
          '— inbound message dropped. Resolve duplicates so each number maps to a single account.',
          'Account owners:',
          configRows.map(
            (r: { account_id: string; user_id: string }) =>
              `${r.account_id} (admin ${r.user_id})`
          )
        );
        continue;
      }

      const config = configRows[0];

      const decryptedAccessToken = decrypt(config.access_token);

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i];
        const contact = value.contacts[i] || value.contacts[0];

        await processMessage(
          message,
          contact,
          // Tenancy — drives every contact / conversation lookup
          // and the engines' active-row dispatch.
          config.account_id,
          // Audit / sender-of-record — used as the user_id on row
          // inserts that need it for NOT NULL FK compliance. Always
          // the admin who saved the WhatsApp config.
          config.user_id,
          config.id,
          config.department_id ?? null,
          decryptedAccessToken
        );
      }
    }
  }
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once Meta has
// delivered or the user has read or replied, a later "failed" status
// event is a bug in Meta's pipeline or a spoof attempt and must be
// ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const;

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s);
  return idx < 0 ? -1 : idx;
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent';
  }
  if (current === 'failed') {
    return false; // failed is terminal
  }
  const ci = ladderLevel(current);
  const ii = ladderLevel(incoming);
  if (ii < 0) return false; // unknown incoming status
  if (ci < 0) return true; // unknown current — accept anything on the ladder
  return ii > ci;
}

const MESSAGE_STATUS_LADDER = ['sending', 'sent', 'delivered', 'read'] as const;

function messageStatusLevel(s: string): number {
  const idx = (MESSAGE_STATUS_LADDER as readonly string[]).indexOf(s);
  return idx < 0 ? -1 : idx;
}

function isValidMessageStatusTransition(
  current: string,
  incoming: string
): boolean {
  if (incoming === 'failed') {
    return current === 'sending' || current === 'sent';
  }
  if (current === 'failed') {
    return false;
  }
  const ci = messageStatusLevel(current);
  const ii = messageStatusLevel(incoming);
  if (ii < 0) return false;
  if (ci < 0) return true;
  return ii > ci;
}

function messageStatusUpdate(
  status: string,
  timestamp: Date
): Partial<typeof messages.$inferInsert> {
  const update: Partial<typeof messages.$inferInsert> = { status };
  if (status === 'sent') update.sentAt = timestamp;
  if (status === 'delivered') update.deliveredAt = timestamp;
  if (status === 'read') update.readAt = timestamp;
  if (status === 'failed') update.failedAt = timestamp;
  return update;
}

function isoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date().toISOString();
}

function isoStringOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

function serializeRealtimeMessage(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    conversation_id: String(row.conversation_id),
    sender_type: String(row.sender_type),
    sender_id: typeof row.sender_id === 'string' ? row.sender_id : null,
    content_type: String(row.content_type),
    content_text:
      typeof row.content_text === 'string' ? row.content_text : null,
    media_url: typeof row.media_url === 'string' ? row.media_url : null,
    template_name:
      typeof row.template_name === 'string' ? row.template_name : null,
    message_id: typeof row.message_id === 'string' ? row.message_id : null,
    status: String(row.status),
    sent_at: isoStringOrNull(row.sent_at),
    delivered_at: isoStringOrNull(row.delivered_at),
    read_at: isoStringOrNull(row.read_at),
    failed_at: isoStringOrNull(row.failed_at),
    reply_to_message_id:
      typeof row.reply_to_message_id === 'string'
        ? row.reply_to_message_id
        : null,
    interactive_reply_id:
      typeof row.interactive_reply_id === 'string'
        ? row.interactive_reply_id
        : null,
    interactive_payload:
      row.interactive_payload && typeof row.interactive_payload === 'object'
        ? row.interactive_payload
        : null,
    is_forwarded: Boolean(row.is_forwarded),
    forwarded_from_message_id:
      typeof row.forwarded_from_message_id === 'string'
        ? row.forwarded_from_message_id
        : null,
    deleted_at: row.deleted_at ? isoString(row.deleted_at) : null,
    deleted_by_user_id:
      typeof row.deleted_by_user_id === 'string'
        ? row.deleted_by_user_id
        : null,
    is_starred: Boolean(row.is_starred),
    ai_generated: Boolean(row.ai_generated),
    created_at: isoString(row.created_at),
  };
}

async function handleStatusUpdate(status: {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
}) {
  const tsDate = new Date(parseInt(status.timestamp) * 1000);

  // 1) Mirror onto messages (legacy behavior) - Meta's status values
  //    already match the CHECK constraint on messages.status. No
  //    single-row assumption: message_id is not unique across numbers.
  let existingMessages: ReturnType<typeof serializeMessageRow>[] = [];
  try {
    existingMessages = (
      await db.select().from(messages).where(eq(messages.messageId, status.id))
    ).map(serializeMessageRow);
  } catch (error) {
    console.error('Error fetching message status:', error);
  }

  const messageIdsToUpdate = existingMessages
    .filter((message) =>
      isValidMessageStatusTransition(
        String(message.status ?? ''),
        status.status
      )
    )
    .map((message) => String(message.id));

  let updatedMessages: Record<string, unknown>[] = [];
  if (messageIdsToUpdate.length > 0) {
    try {
      updatedMessages = (
        await db
          .update(messages)
          .set(messageStatusUpdate(status.status, tsDate))
          .where(inArray(messages.id, messageIdsToUpdate))
          .returning()
      ).map(serializeMessageRow);
    } catch (error) {
      console.error('Error updating message status:', error);
    }
  }

  // Webhook fan-out for this status change happens at the end of this
  // handler, so a slow subscriber cannot delay the broadcast mirror.
  let recipient: { id: string; status: string } | null = null;
  try {
    recipient =
      (
        await db
          .select({
            id: broadcastRecipients.id,
            status: broadcastRecipients.status,
          })
          .from(broadcastRecipients)
          .where(eq(broadcastRecipients.whatsappMessageId, status.id))
          .limit(1)
      )[0] ?? null;
  } catch (error) {
    console.error('Error fetching broadcast recipient:', error);
  }

  if (recipient && isValidStatusTransition(recipient.status, status.status)) {
    const update: Partial<typeof broadcastRecipients.$inferInsert> = {
      status: status.status,
    };
    if (status.status === 'sent') update.sentAt = tsDate;
    if (status.status === 'delivered') update.deliveredAt = tsDate;
    if (status.status === 'read') update.readAt = tsDate;

    try {
      await db
        .update(broadcastRecipients)
        .set(update)
        .where(eq(broadcastRecipients.id, recipient.id));
      await publishBroadcastRecipientUpdatedById(recipient.id);
    } catch (error) {
      console.error('Error updating broadcast recipient status:', error);
    }
  }

  async function resolveMessageOwner(messageId: string) {
    const row =
      (
        await db
          .select({
            conversationId: messages.conversationId,
            accountId: conversations.accountId,
          })
          .from(messages)
          .innerJoin(
            conversations,
            eq(conversations.id, messages.conversationId)
          )
          .where(eq(messages.id, messageId))
          .limit(1)
      )[0] ?? null;

    return row
      ? {
          conversation_id: row.conversationId,
          conversations: { account_id: row.accountId },
        }
      : null;
  }

  if (updatedMessages.length > 0) {
    const msgRow = await resolveMessageOwner(String(updatedMessages[0].id));

    if (msgRow) {
      const accountId = msgRow.conversations.account_id;
      if (accountId) {
        await dispatchWebhookEvent(db, accountId, 'message.status_updated', {
          whatsapp_message_id: status.id,
          conversation_id: msgRow.conversation_id,
          status: status.status,
        });
      }
    }
  }

  await Promise.all(
    updatedMessages.map(async (message) => {
      const owner = await resolveMessageOwner(String(message.id));
      const accountId = owner?.conversations.account_id;
      const conversationId =
        typeof owner?.conversation_id === 'string'
          ? owner.conversation_id
          : typeof message.conversation_id === 'string'
            ? message.conversation_id
            : null;

      if (!accountId || !conversationId) return;

      await publishRealtimeEvent('message.updated', {
        accountId,
        conversationId,
        payload: { message: serializeRealtimeMessage(message) },
      }).catch((error) => {
        console.warn('[realtime] failed to publish message.updated:', error);
      });
    })
  );
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis; failures here must not break the main
 * inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    const row =
      (
        await db
          .select({
            id: broadcastRecipients.id,
            status: broadcastRecipients.status,
            broadcastId: broadcastRecipients.broadcastId,
            accountId: broadcasts.accountId,
          })
          .from(broadcastRecipients)
          .innerJoin(
            broadcasts,
            eq(broadcasts.id, broadcastRecipients.broadcastId)
          )
          .where(
            and(
              eq(broadcastRecipients.contactId, contactId),
              eq(broadcasts.accountId, accountId),
              inArray(broadcastRecipients.status, ['sent', 'delivered', 'read'])
            )
          )
          .orderBy(desc(broadcastRecipients.createdAt))
          .limit(1)
      )[0] ?? null;

    if (!row) return;

    try {
      await db
        .update(broadcastRecipients)
        .set({ status: 'replied', repliedAt: new Date() })
        .where(eq(broadcastRecipients.id, row.id));
      await publishBroadcastRecipientUpdatedById(row.id);
    } catch (error) {
      console.error('Error marking broadcast recipient replied:', error);
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err);
  }
}

/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent.
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  try {
    const row =
      (
        await db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.messageId, metaId),
              eq(messages.conversationId, conversationId)
            )
          )
          .limit(1)
      )[0] ?? null;
    return row?.id ?? null;
  } catch (error) {
    console.error(
      '[webhook] lookupInternalIdByMetaId failed:',
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages;
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 */
async function handleReaction(
  message: WhatsAppMessage,
  accountId: string,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction;
  if (!reaction?.message_id) return;

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  );
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.message_id
    );
    return;
  }

  if (!reaction.emoji) {
    const existingReaction =
      (
        await db
          .select()
          .from(messageReactions)
          .where(
            and(
              eq(messageReactions.messageId, targetInternalId),
              eq(messageReactions.actorType, 'customer'),
              eq(messageReactions.actorId, contactId)
            )
          )
          .limit(1)
      )[0] ?? null;
    try {
      await db
        .delete(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, targetInternalId),
            eq(messageReactions.actorType, 'customer'),
            eq(messageReactions.actorId, contactId)
          )
        );
    } catch (error) {
      console.error(
        '[webhook] reaction delete failed:',
        error instanceof Error ? error.message : error
      );
      return;
    }
    if (existingReaction) {
      await publishRealtimeEvent('reaction.deleted', {
        accountId,
        conversationId,
        payload: { reaction: serializeReactionRow(existingReaction) },
      }).catch((error) => {
        console.warn('[realtime] failed to publish reaction.deleted:', error);
      });
    }
    return;
  }

  try {
    const savedReaction =
      (
        await db
          .insert(messageReactions)
          .values({
            messageId: targetInternalId,
            conversationId,
            actorType: 'customer',
            actorId: contactId,
            emoji: reaction.emoji,
          })
          .onConflictDoUpdate({
            target: [
              messageReactions.messageId,
              messageReactions.actorType,
              messageReactions.actorId,
            ],
            set: { emoji: reaction.emoji, updatedAt: new Date() },
          })
          .returning()
      )[0] ?? null;
    if (savedReaction) {
      await publishRealtimeEvent('reaction.updated', {
        accountId,
        conversationId,
        payload: { reaction: serializeReactionRow(savedReaction) },
      }).catch((error) => {
        console.warn('[realtime] failed to publish reaction.updated:', error);
      });
    }
  } catch (error) {
    console.error(
      '[webhook] reaction upsert failed:',
      error instanceof Error ? error.message : error
    );
  }
}
async function processMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string }; wa_id: string },
  // Tenancy. Resolved from the matched whatsapp_config row; every
  // contact / conversation / message row created downstream is
  // stamped with this so any member of the account can see it.
  accountId: string,
  // Sender-of-record for inserts that need a NOT NULL user_id FK
  // (contacts, conversations). Always the admin who saved the
  // WhatsApp config; the choice is arbitrary post-017 but stable.
  configOwnerUserId: string,
  whatsappConfigId: string,
  departmentId: string | null,
  accessToken: string
) {
  const senderPhone = normalizePhone(message.from);
  const contactName = contact.profile.name;

  // Find or create contact
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName
  );
  if (!contactOutcome) return;
  const contactRecord = contactOutcome.contact;
  if (contactOutcome.wasCreated) {
    await publishRealtimeEvent('contact.created', {
      accountId,
      payload: { contact: contactRecord },
    }).catch((error) => {
      console.warn('[realtime] failed to publish contact.created:', error);
    });
  }

  // Find or create conversation
  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id,
    whatsappConfigId,
    departmentId
  );
  if (!convResult) return;
  const conversation = convResult.conversation;

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the reaction short-circuit below — so a conversation first opened by
  // a reaction still fires the event, and a subscriber always sees the
  // thread open before its first message.received.
  if (convResult.created) {
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    });
    await publishRealtimeEvent('conversation.created', {
      accountId,
      conversationId: conversation.id,
      payload: { conversation },
    }).catch((error) => {
      console.warn('[realtime] failed to publish conversation.created:', error);
    });
  }

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  // Done before parseMessageContent so the media-URL fetch is skipped.
  if (message.type === 'reaction') {
    await handleReaction(message, accountId, conversation.id, contactRecord.id);
    return;
  }

  // Parse message content based on type
  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseMessageContent(message, accessToken, accountId);

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null;
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.context.id,
      conversation.id
    );
    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        message.context.id
      );
    }
  }

  // Insert message — field names MUST match the messages table schema
  // (see database/migrations/001_initial_schema.sql):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, template_name, message_id, status, created_at
  // `mediaType` is intentionally unused — the schema has no media_type
  // column; the MIME type is only used to construct the proxy URL during
  // parseMessageContent. Silence the unused-var warning:
  void mediaType;

  // The messages.content_type CHECK constraint allows the inbox-rendered
  // WhatsApp types we store directly:
  //   text, image, document, audio, video, sticker, location, template,
  //   interactive
  // Map incoming WhatsApp types that aren't in that list to the closest
  // allowed value so the INSERT doesn't fail with a constraint error.
  const ALLOWED_CONTENT_TYPES = new Set([
    'text',
    'image',
    'document',
    'audio',
    'video',
    'sticker',
    'location',
    'template',
    'interactive',
  ]);
  let contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'button'
      ? 'interactive'
      : message.type === 'sticker'
        ? 'image' // stickers are images
        : 'text'; // reaction, unknown → text fallback

  if (message.type === 'sticker') {
    contentType = 'sticker';
  }
  if (
    message.type === 'image' &&
    !contentText &&
    message.image?.mime_type?.toLowerCase().includes('webp')
  ) {
    contentType = 'sticker';
  }
  const unsupportedInbound = message.type === 'unsupported';

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate. Covers the case where
  // the contact row already exists (manual add / CSV import) but they've
  // never messaged us before — which new_contact_created wouldn't catch.
  const [{ value: priorCustomerMsgCount = 0 } = { value: 0 }] = await db
    .select({ value: count() })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversation.id),
        eq(messages.senderType, 'customer')
      )
    );
  const isFirstInboundMessage = priorCustomerMsgCount === 0;

  let insertedMessage: ReturnType<typeof serializeMessageRow> | null = null;
  try {
    const row =
      (
        await db
          .insert(messages)
          .values({
            conversationId: conversation.id,
            senderType: 'customer',
            contentType,
            contentText,
            mediaUrl,
            messageId: message.id,
            status: 'delivered',
            createdAt: new Date(parseInt(message.timestamp) * 1000),
            replyToMessageId: replyToInternalId,
            isForwarded: Boolean(
              message.context?.forwarded ||
              message.context?.frequently_forwarded
            ),
            // Only populated for content_type='interactive'. Migration 010 added
            // the column; null for every other content_type so existing inserts
            // behave identically.
            interactiveReplyId,
          })
          .returning()
      )[0] ?? null;
    insertedMessage = row ? serializeMessageRow(row) : null;
  } catch (error) {
    console.error('Error inserting message:', error);
    return;
  }

  // Update conversation
  const updatedConversation = {
    ...conversation,
    last_message_text: contentText || `[${message.type}]`,
    last_message_at: new Date().toISOString(),
    unread_count: (conversation.unread_count || 0) + 1,
    updated_at: new Date().toISOString(),
  };

  try {
    await db
      .update(conversations)
      .set({
        lastMessageText: updatedConversation.last_message_text,
        lastMessageAt: new Date(updatedConversation.last_message_at),
        unreadCount: updatedConversation.unread_count,
        updatedAt: new Date(updatedConversation.updated_at),
      })
      .where(eq(conversations.id, conversation.id));
  } catch (error) {
    console.error('Error updating conversation:', error);
  }

  await publishRealtimeEvent('conversation.updated', {
    accountId,
    conversationId: conversation.id,
    payload: { conversation: updatedConversation },
  }).catch((error) => {
    console.warn('[realtime] failed to publish conversation.updated:', error);
  });

  if (insertedMessage) {
    await publishRealtimeEvent('message.created', {
      accountId,
      conversationId: conversation.id,
      payload: {
        message: insertedMessage,
        contact: {
          name: contactRecord.name,
          phone: contactRecord.phone,
        },
      },
    }).catch((error) => {
      console.warn('[realtime] failed to publish message.created:', error);
    });
  }

  // If this contact was a recent broadcast recipient, flag the reply
  // so the broadcast's `replied_count` advances (via the aggregate
  // trigger installed in migration 003).
  await flagBroadcastReplyIfAny(accountId, contactRecord.id);

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active
  // run or started a new one), we suppress the `new_message_received`
  // + `keyword_match` automation triggers for this inbound. Customer
  // is navigating the bot menu, not sending a fresh trigger word
  // that should fork into automations.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed — those
  // are about WHO is messaging, not what they said.
  //
  // Awaited (not fire-and-forget) because we need the `consumed`
  // result before deciding whether to dispatch automations. The
  // runner has its own try/catch and never throws. Accounts with
  // no active flows take the runner's early-exit "no_match" path
  // basically for free (one indexed SELECT for the active run).
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: contentText ?? '',
          meta_message_id: message.id,
        }
      : {
          kind: 'text',
          text: unsupportedInbound
            ? ''
            : (contentText ?? message.text?.body ?? ''),
          meta_message_id: message.id,
        },
    isFirstInboundMessage,
  });
  const flowConsumed = flowResult.consumed;

  // Fire any automations that react to this webhook event. All dispatches
  // run here (not earlier) so the contact, conversation, and inbound
  // message all exist before any step — including send_message — runs.
  // This runs inside Next's `after()` callback; detached promises can be
  // frozen before they write logs or send messages, so keep the dispatches
  // in the awaited work graph.
  const inboundText = unsupportedInbound
    ? ''
    : (contentText ?? message.text?.body ?? '');
  const appointmentSlotSelection = await buildAppointmentSlotSelection(
    accountId,
    conversation.id,
    interactiveReplyId
  );
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
    | 'appointment_slot_selected'
  )[] = [];
  // Content-level triggers are suppressed when a flow consumed the
  // message — see the comment block above.
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match');
    // Interactive tap → fire the interactive_reply trigger too (only
    // meaningful when a button/list reply actually arrived). Enables
    // automation-only chained menus; when a Flow owns the menu it will
    // have consumed the reply and this is skipped.
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply');
    }
  }
  // Appointment slot selections are domain events, so they should fire
  // even if a Flow consumed the interactive reply first.
  if (appointmentSlotSelection) {
    automationTriggers.push('appointment_slot_selected');
  }
  // new_contact_created fires only when the webhook just auto-created the
  // contact row. first_inbound_message fires whenever this is the contact's
  // first-ever customer-sent message — a superset that also catches
  // manually-imported contacts sending for the first time. We dispatch both
  // so users can pick whichever semantic they want; an automation that
  // listens to only one trigger runs only when that trigger matches.
  if (contactOutcome.wasCreated)
    automationTriggers.unshift('new_contact_created');
  if (isFirstInboundMessage)
    automationTriggers.unshift('first_inbound_message');
  const automationDispatches = automationTriggers.map((triggerType) =>
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        // Only set on interactive taps; drives the interactive_reply
        // trigger's exact-id match.
        interactive_reply_id: interactiveReplyId ?? undefined,
        vars: {
          contact_name: contactRecord.name ?? '',
          contact_phone: contactRecord.phone ?? senderPhone,
          contact_email: contactRecord.email ?? '',
          ...(appointmentSlotSelection ?? {}),
        },
      },
    })
  );
  const automationResults = await Promise.allSettled(automationDispatches);
  for (const result of automationResults) {
    if (result.status === 'rejected') {
      console.error('[automations] dispatch failed:', result.reason);
    }
  }

  // AI auto-reply. Runs only for plain-text inbound the deterministic
  // flow runner did NOT consume (flows win over the LLM), and only when
  // the account has enabled it. Awaited inside `after()` (same reason as
  // the webhook dispatch below); `dispatchInboundToAiReply` owns its
  // eligibility gates + try/catch and never throws.
  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    });
  }

  // message.received webhook (public API). Awaited — not fire-and-forget
  // — because we're inside the route's `after()` block, which only keeps
  // the function alive for promises it can see; a detached promise could
  // be frozen before it delivers. `dispatchWebhookEvent` early-exits
  // when the account has no matching endpoint and never throws.
  // (conversation.created is emitted earlier, right after the thread is
  // opened.)
  await dispatchWebhookEvent(db, accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.id,
    content_type: contentType,
    text: contentText,
  });
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string,
  accountId: string
): Promise<{
  contentText: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null;
}> {
  const persistIncomingMedia = async (
    mediaId: string,
    fileName?: string | null
  ): Promise<string | null> => {
    try {
      const mediaInfo = await getMediaUrl({ mediaId, accessToken });
      const { buffer, contentType } = await downloadMedia({
        downloadUrl: mediaInfo.url,
        accessToken,
      });
      const mimeType = contentType || mediaInfo.mimeType;
      const path = buildIncomingMediaPath({
        accountId,
        mediaId,
        fileName,
        mimeType,
      });
      const key = `chat-media/${path}`;
      await putObject({
        key,
        body: buffer,
        contentType: mimeType,
        cacheControl: '86400',
      });
      return publicObjectUrl(key);
    } catch (error) {
      console.error(
        `Failed to persist incoming media ${mediaId}; falling back to Meta proxy:`,
        error instanceof Error ? error.message : error
      );
      try {
        await getMediaUrl({ mediaId, accessToken });
        return `/api/whatsapp/media/${mediaId}`;
      } catch (verifyError) {
        console.error(
          `Failed to verify media ${mediaId} with Meta:`,
          verifyError instanceof Error ? verifyError.message : verifyError
        );
        return null;
      }
    }
  };

  // Default shape — each case overrides only the fields it cares about.
  // Keeps the new `interactiveReplyId` field DRY across every return site.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  };

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null };

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await persistIncomingMedia(message.image.id),
          mediaType: message.image.mime_type,
        };
      }
      return empty;

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await persistIncomingMedia(message.video.id),
          mediaType: message.video.mime_type,
        };
      }
      return empty;

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          mediaUrl: await persistIncomingMedia(
            message.document.id,
            message.document.filename
          ),
          mediaType: message.document.mime_type,
        };
      }
      return empty;

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,
          mediaUrl: await persistIncomingMedia(message.audio.id),
          mediaType: message.audio.mime_type,
        };
      }
      return empty;

    case 'sticker':
      // Stickers are images under the hood, but keep a first-class
      // content_type so the inbox can render them like WhatsApp stickers
      // instead of regular photos.
      if (message.sticker?.id) {
        return {
          ...empty,
          mediaUrl: await persistIncomingMedia(message.sticker.id),
          mediaType: message.sticker.mime_type,
        };
      }
      return empty;

    case 'location':
      if (message.location) {
        const loc = message.location;
        const locationText = [
          loc.name,
          loc.address,
          `${loc.latitude},${loc.longitude}`,
        ]
          .filter(Boolean)
          .join(' - ');
        return { ...empty, contentText: locationText };
      }
      return empty;

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null };

    case 'button':
      return {
        ...empty,
        contentText: message.button?.text || message.button?.payload || null,
        interactiveReplyId: message.button?.payload || null,
      };

    case 'unsupported':
      return { ...empty, contentText: '[unsupported]' };

    case 'interactive': {
      // The customer tapped a reply button or a list row on a message
      // we previously sent. Meta delivers `interactive.button_reply` for
      // 3-button messages and `interactive.list_reply` for list messages.
      // Use the human-readable title as contentText so the inbox bubble
      // renders the tap legibly ("Existing customer"), and stash the
      // stable id separately so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply;
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        };
      }
      return { ...empty, contentText: '[Interactive reply]' };
    }

    default:
      return {
        ...empty,
        contentText: '[unsupported]',
      };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any;

interface ContactOutcome {
  contact: ContactRow;
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean;
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set. The same
  // helper backs the manual contact form and CSV import, so all three
  // paths agree on what "same number" means (issue #212).
  const existingContact = await findExistingContact(db, accountId, phone);

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      await db
        .update(contacts)
        .set({ name, updatedAt: new Date() })
        .where(eq(contacts.id, existingContact.id));
    }
    return { contact: existingContact, wasCreated: false };
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  try {
    const row =
      (
        await db
          .insert(contacts)
          .values({
            accountId,
            userId: configOwnerUserId,
            phone,
            name: name || phone,
          })
          .returning()
      )[0] ?? null;

    return row ? { contact: serializeContactRow(row), wasCreated: true } : null;
  } catch (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(db, accountId, phone);
      if (raced) return { contact: raced, wasCreated: false };
    }
    console.error('Error creating contact:', createError);
    return null;
  }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
  whatsappConfigId: string,
  departmentId: string | null
) {
  // Look for existing conversation in this account for the inbound line.
  const existingRow =
    (
      await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.accountId, accountId),
            eq(conversations.contactId, contactId),
            eq(conversations.whatsappConfigId, whatsappConfigId)
          )
        )
        .limit(1)
    )[0] ?? null;
  const existing = existingRow ? serializeConversationRow(existingRow) : null;

  if (existing) {
    if (existing.status === 'closed') {
      try {
        const reopened =
          (
            await db
              .update(conversations)
              .set({
                status: 'pending',
                assignedAgentId: null,
                departmentId,
                updatedAt: new Date(),
              })
              .where(eq(conversations.id, existing.id))
              .returning()
          )[0] ?? null;

        return {
          conversation: reopened
            ? serializeConversationRow(reopened)
            : existing,
          created: false,
        };
      } catch (error) {
        console.error('Error reopening closed conversation:', error);
        return { conversation: existing, created: false };
      }
    }

    return { conversation: existing, created: false };
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  try {
    const newConv =
      (
        await db
          .insert(conversations)
          .values({
            accountId,
            userId: configOwnerUserId,
            contactId,
            whatsappConfigId,
            departmentId,
            status: 'pending',
            assignedAgentId: null,
          })
          .returning()
      )[0] ?? null;

    return newConv
      ? { conversation: serializeConversationRow(newConv), created: true }
      : null;
  } catch (error) {
    console.error('Error creating conversation:', error);
    return null;
  }
}
