import { NextResponse } from 'next/server';
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

export async function POST(request: Request) {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const connections = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.appSlug, ARVERA_APPOINTMENTS_SLUG),
        eq(integrationConnections.enabled, true),
      ),
    );

  const connection = connections.map(serializeConnection).find(
    (item) => resolveAppointmentsWebhookToken(item) === token,
  );
  if (!connection) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const payload = (await request.json().catch(() => null)) as {
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

  const contactId = await findContactId(connection.account_id, appointment);
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
  if (triggerType) {
    void runAutomationsForTrigger({
      accountId: connection.account_id,
      triggerType,
      contactId,
      context: {
        vars: {
          appointment_record_id: record.id,
          appointment_id: externalId,
          appointment_status: appointment.Estado,
          appointment_start: appointment.startTime,
          appointment_end: appointment.endTime,
          appointment_service: appointment.Servicio,
          appointment_cancel_url:
            appointment.url_cancelacion_corta ?? appointment.Url_Cancelacion ?? '',
        },
      },
    });
  }

  return NextResponse.json({ ok: true, appointment_record: record });
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
  const phone = typeof appointment.Telefono === 'string' ? appointment.Telefono.trim() : '';
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
