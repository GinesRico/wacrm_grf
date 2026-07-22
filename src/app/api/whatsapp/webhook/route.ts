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
  const { data, error } = await dbAdmin()
    .from('appointment_availability_messages')
    .select('slots, service')
    .eq('account_id', args.accountId)
    .eq('conversation_id', args.conversationId)
    .eq('date', args.date)
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) {
    console.warn(
      '[webhook] could not load availability slots for reply:',
      error.message
    );
    return null;
  }

  for (const row of data ?? []) {
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
    const connection = await getArveraAppointmentsConnection(
      dbAdmin() as never,
      accountId
    );
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
    const { data: configs, error: configError } = await dbAdmin()
      .from('whatsapp_config')
      .select('id, verify_token');

    if (configError || !configs) {
      console.error('Error fetching configs for verification:', configError);
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
        void dbAdmin()
          .from('whatsapp_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error
              );
            }
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
          dbAdmin()
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
      const { data: configRows, error: configError } = await dbAdmin()
        .from('whatsapp_config')
        .select('*')
        .eq('phone_number_id', phoneNumberId);

      if (configError) {
        console.error(
          'Error fetching whatsapp_config for phone_number_id:',
          phoneNumberId,
          configError
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

function isoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date().toISOString();
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
  // 1) Mirror onto messages (legacy behavior) — Meta's status values
  //    already match the CHECK constraint on messages.status. No
  //    `.select()`: message_id is NOT unique (migration 009 — Meta ids
  //    repeat across numbers), so this updates 0..N rows and must not
  //    assume a single row.
  const { data: existingMessages, error: msgFetchErr } = await dbAdmin()
    .from('messages')
    .select('*')
    .eq('message_id', status.id);

  if (msgFetchErr) {
    console.error('Error fetching message status:', msgFetchErr);
  }

  const messageIdsToUpdate = (
    (existingMessages ?? []) as Record<string, unknown>[]
  )
    .filter((message) =>
      isValidMessageStatusTransition(
        String(message.status ?? ''),
        status.status
      )
    )
    .map((message) => String(message.id));

  let updatedMessages: Record<string, unknown>[] = [];
  if (messageIdsToUpdate.length > 0) {
    const { data, error: msgErr } = await dbAdmin()
      .from('messages')
      .update({ status: status.status })
      .in('id', messageIdsToUpdate)
      .select('*');

    if (msgErr) {
      console.error('Error updating message status:', msgErr);
    } else {
      updatedMessages = (data ?? []) as Record<string, unknown>[];
    }
  }

  // Webhook fan-out for this status change happens at the END of this
  // handler (after the broadcast mirror below), so a slow subscriber
  // endpoint can't delay the broadcast_recipients update.

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003). The aggregate trigger on
  //    broadcast_recipients re-derives the parent broadcast's
  //    sent/delivered/read/failed counts automatically.
  const tsIso = new Date(parseInt(status.timestamp) * 1000).toISOString();

  const { data: recipient, error: recFetchErr } = await dbAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', status.id)
    .maybeSingle();

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr);
  } else if (
    recipient &&
    // Guard transitions — forward-only on the success ladder, and
    // `failed` only from pre-delivered states.
    isValidStatusTransition(recipient.status, status.status)
  ) {
    const update: Record<string, unknown> = { status: status.status };
    if (status.status === 'sent' && !('sent_at' in update))
      update.sent_at = tsIso;
    if (status.status === 'delivered') update.delivered_at = tsIso;
    if (status.status === 'read') update.read_at = tsIso;

    const { error: recUpdateErr } = await dbAdmin()
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id);

    if (recUpdateErr) {
      console.error('Error updating broadcast recipient status:', recUpdateErr);
    } else {
      await publishBroadcastRecipientUpdatedById(recipient.id);
    }
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends).
  //    Runs last so a slow subscriber can't delay the mirrors above.
  //    Bounded to one row (message_id isn't unique) purely to resolve
  //    the owning account for delivery.
  if (updatedMessages.length > 0) {
    const { data: msgRow } = await dbAdmin()
      .from('messages')
      .select('conversation_id, conversations(account_id)')
      .eq('id', updatedMessages[0].id)
      .limit(1)
      .maybeSingle();

    if (msgRow) {
      const conv = msgRow.conversations as { account_id: string } | null;
      const accountId = conv?.account_id;
      if (accountId) {
        await dispatchWebhookEvent(
          dbAdmin(),
          accountId,
          'message.status_updated',
          {
            whatsapp_message_id: status.id,
            conversation_id: msgRow.conversation_id,
            status: status.status,
          }
        );
      }
    }
  }

  await Promise.all(
    updatedMessages.map(async (message) => {
      const { data: owner } = await dbAdmin()
        .from('messages')
        .select('conversation_id, conversations(account_id)')
        .eq('id', message.id)
        .limit(1)
        .maybeSingle();

      const conv = owner?.conversations as { account_id: string } | null;
      const accountId = conv?.account_id;
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
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const { data: recs, error } = await dbAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (error || !recs || recs.length === 0) return;

    const row = recs[0];
    const { error: updErr } = await dbAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id);

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr);
    } else {
      await publishBroadcastRecipientUpdatedById(row.id);
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err);
  }
}

/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await dbAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (error) {
    console.error('[webhook] lookupInternalIdByMetaId failed:', error.message);
    return null;
  }
  return data?.id ?? null;
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
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

  // Empty emoji = removal (per Meta's Cloud API spec).
  if (!reaction.emoji) {
    const { data: existingReaction } = await dbAdmin()
      .from('message_reactions')
      .select('*')
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
      .maybeSingle();
    const { error: delError } = await dbAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId);
    if (delError) {
      console.error('[webhook] reaction delete failed:', delError.message);
      return;
    }
    if (existingReaction) {
      await publishRealtimeEvent('reaction.deleted', {
        accountId,
        conversationId,
        payload: { reaction: existingReaction },
      }).catch((error) => {
        console.warn('[realtime] failed to publish reaction.deleted:', error);
      });
    }
    return;
  }

  const { data: savedReaction, error: upsertError } = await dbAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
    .select('*')
    .single();
  if (upsertError) {
    console.error('[webhook] reaction upsert failed:', upsertError.message);
    return;
  }
  if (savedReaction) {
    await publishRealtimeEvent('reaction.updated', {
      accountId,
      conversationId,
      payload: { reaction: savedReaction },
    }).catch((error) => {
      console.warn('[realtime] failed to publish reaction.updated:', error);
    });
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
    await dispatchWebhookEvent(dbAdmin(), accountId, 'conversation.created', {
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
  const { count: priorCustomerMsgCount } = await dbAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer');
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0;

  const { data: insertedMessage, error: msgError } = await dbAdmin()
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      sender_type: 'customer',
      content_type: contentType,
      content_text: contentText,
      media_url: mediaUrl,
      message_id: message.id,
      status: 'delivered',
      created_at: new Date(parseInt(message.timestamp) * 1000).toISOString(),
      reply_to_message_id: replyToInternalId,
      is_forwarded: Boolean(
        message.context?.forwarded || message.context?.frequently_forwarded
      ),
      // Only populated for content_type='interactive'. Migration 010 added
      // the column; null for every other content_type so existing inserts
      // behave identically.
      interactive_reply_id: interactiveReplyId,
    })
    .select('*')
    .single();

  if (msgError) {
    console.error('Error inserting message:', msgError);
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

  const { error: convError } = await dbAdmin()
    .from('conversations')
    .update({
      last_message_text: updatedConversation.last_message_text,
      last_message_at: updatedConversation.last_message_at,
      unread_count: updatedConversation.unread_count,
      updated_at: updatedConversation.updated_at,
    })
    .eq('id', conversation.id);

  if (convError) {
    console.error('Error updating conversation:', convError);
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
  await dispatchWebhookEvent(dbAdmin(), accountId, 'message.received', {
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
  const existingContact = await findExistingContact(
    dbAdmin(),
    accountId,
    phone
  );

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      await dbAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id);
    }
    return { contact: existingContact, wasCreated: false };
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  const { data: newContact, error: createError } = await dbAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single();

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(dbAdmin(), accountId, phone);
      if (raced) return { contact: raced, wasCreated: false };
    }
    console.error('Error creating contact:', createError);
    return null;
  }

  return { contact: newContact, wasCreated: true };
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
  whatsappConfigId: string,
  departmentId: string | null
) {
  // Look for existing conversation in this account for the inbound line.
  const { data: existing, error: findError } = await dbAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('whatsapp_config_id', whatsappConfigId)
    .single();

  if (!findError && existing) {
    if (existing.status === 'closed') {
      const { data: reopened, error: reopenError } = await dbAdmin()
        .from('conversations')
        .update({
          status: 'pending',
          assigned_agent_id: null,
          department_id: departmentId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select()
        .single();

      if (reopenError) {
        console.error('Error reopening closed conversation:', reopenError);
        return { conversation: existing, created: false };
      }

      return { conversation: reopened, created: false };
    }

    return { conversation: existing, created: false };
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await dbAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
      whatsapp_config_id: whatsappConfigId,
      department_id: departmentId,
      status: 'pending',
      assigned_agent_id: null,
    })
    .select()
    .single();

  if (createError) {
    console.error('Error creating conversation:', createError);
    return null;
  }

  return { conversation: newConv, created: true };
}
