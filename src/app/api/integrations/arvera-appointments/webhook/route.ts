import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { db } from '@/db/client';
import {
  appointmentRecords,
  appointmentWebhookEvents,
  contacts,
  integrationConnections,
} from '@/db/schema';
import {
  ARVERA_APPOINTMENTS_SLUG,
  resolveAppointmentsWebhookToken,
  type ArveraAppointmentRecord,
  type ArveraAppointmentsConnection,
} from '@/lib/integrations/arvera-appointments';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { recordWebhookEventSample } from '@/lib/webhooks/event-samples';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { verifySignatureHeader } from '@/lib/webhooks/sign';

const MAX_WEBHOOK_BYTES = 512 * 1024;

export async function POST(request: Request) {
  const limit = checkRateLimit(
    `arvera-webhook:${clientIp(request)}`,
    RATE_LIMITS.arveraWebhook,
  );
  if (!limit.success) return rateLimitResponse(limit);

  if (new URL(request.url).searchParams.has('token')) {
    return NextResponse.json(
      { error: 'Webhook token must be sent in a header, not in the URL' },
      { status: 401 },
    );
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  const connections = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.appSlug, ARVERA_APPOINTMENTS_SLUG),
        eq(integrationConnections.enabled, true),
      ),
    );

  const connection = await authenticateConnection(
    request,
    rawBody,
    connections.map(serializeConnection),
  );
  if (!connection) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const payload = parsePayload(rawBody) as {
    event?: unknown;
    timestamp?: unknown;
    data?: ArveraAppointmentRecord;
    old_data?: ArveraAppointmentRecord;
  } | null;
  if (!payload || typeof payload.event !== 'string' || !payload.data) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const eventType = payload.event;
  const appointment = payload.data;
  const externalId = appointment.Id;
  if (!externalId) {
    return NextResponse.json({ error: 'Appointment Id is required' }, { status: 400 });
  }
  const eventTimestamp =
    typeof payload.timestamp === 'number' && Number.isFinite(payload.timestamp)
      ? payload.timestamp
      : Math.floor(Date.now() / 1000);

  try {
    await db.insert(appointmentWebhookEvents).values({
    accountId: connection.account_id,
    eventType,
    externalId,
    eventTimestamp,
    payload,
  });
  } catch (eventErr) {
  if ((eventErr as { code?: string }).code === '23505') {
    return NextResponse.json({ ok: true, duplicate: true });
  }
    console.error('[arvera appointments webhook] event insert failed:', eventErr);
    return NextResponse.json({ error: 'Webhook event not saved' }, { status: 500 });
  }

  const deliveryTarget = await resolveDeliveryTarget(connection.account_id, appointment);
  const contactId = deliveryTarget.contactId;
  const [record] = await db
    .insert(appointmentRecords)
    .values({
        accountId: connection.account_id,
        contactId,
        provider: 'arvera-appointments',
        externalId,
        status: appointment.Estado ?? null,
        service: appointment.Servicio ?? null,
        customerName: appointment.Nombre ?? null,
        phone: appointment.Telefono ?? null,
        email: appointment.Email ?? null,
        startTime: appointment.startTime ? new Date(appointment.startTime) : null,
        endTime: appointment.endTime ? new Date(appointment.endTime) : null,
        cancelUrl: appointment.url_cancelacion_corta ?? appointment.Url_Cancelacion ?? null,
        rawPayload: payload,
      })
    .onConflictDoUpdate({
      target: [
        appointmentRecords.accountId,
        appointmentRecords.provider,
        appointmentRecords.externalId,
      ],
      set: {
        contactId,
        status: appointment.Estado ?? null,
        service: appointment.Servicio ?? null,
        customerName: appointment.Nombre ?? null,
        phone: appointment.Telefono ?? null,
        email: appointment.Email ?? null,
        startTime: appointment.startTime ? new Date(appointment.startTime) : null,
        endTime: appointment.endTime ? new Date(appointment.endTime) : null,
        cancelUrl: appointment.url_cancelacion_corta ?? appointment.Url_Cancelacion ?? null,
        rawPayload: payload,
      },
    })
    .returning();
  if (!record) {
    console.error('[arvera appointments webhook] record upsert failed');
    return NextResponse.json({ error: 'Appointment record not saved' }, { status: 500 });
  }

  const triggerType = eventToTrigger(eventType);
  void recordWebhookEventSample({
    accountId: connection.account_id,
    source: ARVERA_APPOINTMENTS_SLUG,
    eventType,
    triggerType,
    payload,
  }).catch((error) => {
    console.warn('[arvera appointments webhook] sample save failed:', error);
  });

  if (triggerType) {
    const cancelUrl = appointment.url_cancelacion_corta ?? appointment.Url_Cancelacion ?? '';
    const appointmentParts = formatAppointmentParts(appointment);
    void runAutomationsForTrigger({
      accountId: connection.account_id,
      triggerType,
      contactId,
      context: {
        conversation_id: deliveryTarget.conversationId,
        vars: {
          ...payloadVars(payload),
          ...appointmentVars(appointment),
          event_type: eventType,
          event_timestamp: String(eventTimestamp),
          appointment_record_id: record.id,
          appointment_id: externalId,
          appointment_customer_name: appointment.Nombre ?? '',
          appointment_phone: appointment.Telefono ?? '',
          appointment_email: appointment.Email ?? '',
          appointment_status: appointment.Estado ?? '',
          appointment_start: appointment.startTime ?? '',
          appointment_end: appointment.endTime ?? '',
          appointment_date: appointmentParts.date,
          appointment_time: appointmentParts.time,
          appointment_service: appointment.Servicio ?? '',
          appointment_plate: appointment.Matricula ?? '',
          appointment_model: appointment.Modelo ?? '',
          appointment_notes: appointment.Notas ?? '',
          appointment_cancel_url: cancelUrl,
          appointment_cancel_token: appointment.CancelToken ?? '',
          appointment_created_at: appointment.fecha_creacion ?? '',
          appointment_updated_at: appointment.fecha_modificacion ?? '',
          appointment_deleted_at: appointment.fecha_eliminacion ?? '',
          Nombre: appointment.Nombre ?? '',
          Telefono: appointment.Telefono ?? '',
          Email: appointment.Email ?? '',
          Servicio: appointment.Servicio ?? '',
          startTime: appointment.startTime ?? '',
          endTime: appointment.endTime ?? '',
          Fecha: appointmentParts.date,
          Hora: appointmentParts.time,
          Matricula: appointment.Matricula ?? '',
          Modelo: appointment.Modelo ?? '',
          Notas: appointment.Notas ?? '',
          Estado: appointment.Estado ?? '',
          CancelToken: appointment.CancelToken ?? '',
          fecha: appointment.fecha ?? appointmentParts.date,
          hora: appointment.hora ?? appointmentParts.time,
          Url_Cancelacion: appointment.Url_Cancelacion ?? '',
          url_cancelacion_corta: appointment.url_cancelacion_corta ?? '',
        },
      },
    });
  }

  return NextResponse.json({ ok: true, appointment_record: record });
}

function clientIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    'unknown'
  );
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function parsePayload(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

async function authenticateConnection(
  request: Request,
  rawBody: string,
  connections: ArveraAppointmentsConnection[],
): Promise<ArveraAppointmentsConnection | null> {
  const presentedToken = request.headers.get('x-arvera-webhook-token')?.trim() ?? '';
  const presentedSignature = request.headers.get('x-arvera-signature')?.trim() ?? '';
  if (!presentedToken && !presentedSignature) return null;

  for (const connection of connections) {
    const secret = resolveAppointmentsWebhookToken(connection);
    if (!secret) continue;
    if (presentedToken && safeEqual(presentedToken, secret)) return connection;
    if (
      presentedSignature &&
      verifySignatureHeader(
        presentedSignature,
        rawBody,
        secret,
        Math.floor(Date.now() / 1000),
      )
    ) {
      return connection;
    }
  }

  return null;
}

function payloadVars(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  return payload as Record<string, unknown>;
}

function appointmentVars(appointment: ArveraAppointmentRecord): Record<string, string> {
  return Object.fromEntries(
    Object.entries(appointment).map(([key, value]) => {
      if (value == null) return [key, ''];
      if (typeof value === 'string') return [key, value];
      if (typeof value === 'number' || typeof value === 'boolean') {
        return [key, String(value)];
      }
      return [key, JSON.stringify(value)];
    }),
  );
}

function formatAppointmentParts(appointment: ArveraAppointmentRecord): {
  date: string;
  time: string;
} {
  const explicitDate = typeof appointment.fecha === 'string' ? appointment.fecha.trim() : '';
  const explicitTime = typeof appointment.hora === 'string' ? appointment.hora.trim() : '';
  if (explicitDate || explicitTime) {
    return { date: explicitDate, time: explicitTime };
  }

  if (!appointment.startTime) return { date: '', time: '' };
  const date = new Date(appointment.startTime);
  if (Number.isNaN(date.getTime())) return { date: '', time: '' };
  return {
    date: new Intl.DateTimeFormat('es-ES', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'Europe/Madrid',
    }).format(date),
    time: new Intl.DateTimeFormat('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Europe/Madrid',
    }).format(date),
  };
}

async function resolveDeliveryTarget(
  accountId: string,
  appointment: ArveraAppointmentRecord,
): Promise<{ contactId: string | null; conversationId?: string }> {
  const phone = normalizeAppointmentPhone(appointment.Telefono);
  if (phone) {
    try {
      const resolved = await resolveConversationByPhone(
        null,
        accountId,
        phone,
        appointment.Nombre ?? null,
      );
      return {
        contactId: resolved.contactId,
        conversationId: resolved.conversationId,
      };
    } catch (error) {
      console.warn('[arvera appointments webhook] could not resolve WhatsApp conversation:', error);
    }
  }

  return {
    contactId: await findContactId(accountId, appointment),
  };
}

function normalizeAppointmentPhone(phone: unknown): string {
  if (typeof phone !== 'string') return '';
  const digits = phone.replace(/\D/g, '');
  if (/^[6789]\d{8}$/.test(digits)) return `34${digits}`;
  return digits;
}

function serializeConnection(
  row: typeof integrationConnections.$inferSelect,
): ArveraAppointmentsConnection {
  return {
    id: row.id,
    account_id: row.accountId,
    app_slug: row.appSlug,
    enabled: row.enabled,
    encrypted_credentials: row.encryptedCredentials as Record<string, string>,
    config: row.config as ArveraAppointmentsConnection['config'],
    status: row.status,
    last_error: row.lastError,
  };
}

async function findContactId(
  accountId: string,
  appointment: ArveraAppointmentRecord,
): Promise<string | null> {
  const phone = normalizeAppointmentPhone(appointment.Telefono);
  const email = typeof appointment.Email === 'string' ? appointment.Email.trim() : '';

  if (phone) {
    const [row] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.accountId, accountId), eq(contacts.phone, phone)))
      .limit(1);
    if (row?.id) return row.id;
  }

  if (email) {
    const [row] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.accountId, accountId), eq(contacts.email, email)))
      .limit(1);
    if (row?.id) return row.id;
  }

  return null;
}

function eventToTrigger(eventType: string) {
  switch (eventType) {
    case 'cita.creada':
      return 'appointment_created';
    case 'cita.actualizada':
      return 'appointment_updated';
    case 'cita.cancelada':
      return 'appointment_cancelled';
    case 'cita.coche_listo':
      return 'appointment_car_ready';
    default:
      return null;
  }
}
