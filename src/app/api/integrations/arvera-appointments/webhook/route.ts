import { NextResponse } from 'next/server';

import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dbAdmin } from '@/lib/automations/admin-client';
import {
  ARVERA_APPOINTMENTS_SLUG,
  resolveAppointmentsWebhookToken,
  type ArveraAppointmentRecord,
  type ArveraAppointmentsConnection,
} from '@/lib/integrations/arvera-appointments';

export async function POST(request: Request) {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = dbAdmin();
  const { data: connections, error: connErr } = await db
    .from('integration_connections')
    .select('*')
    .eq('app_slug', ARVERA_APPOINTMENTS_SLUG)
    .eq('enabled', true);
  if (connErr) {
    console.error('[arvera appointments webhook] connection lookup failed:', connErr);
    return NextResponse.json({ error: 'Webhook lookup failed' }, { status: 500 });
  }

  const connection = (connections as ArveraAppointmentsConnection[] | null)?.find(
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

  const { error: eventErr } = await db.from('appointment_webhook_events').insert({
    account_id: connection.account_id,
    event_type: eventType,
    external_id: externalId,
    event_timestamp: eventTimestamp,
    payload,
  });
  if (eventErr && eventErr.code === '23505') {
    return NextResponse.json({ ok: true, duplicate: true });
  }
  if (eventErr) {
    console.error('[arvera appointments webhook] event insert failed:', eventErr);
    return NextResponse.json({ error: 'Webhook event not saved' }, { status: 500 });
  }

  const contactId = await findContactId(db, connection.account_id, appointment);
  const { data: record, error: upsertErr } = await db
    .from('appointment_records')
    .upsert(
      {
        account_id: connection.account_id,
        contact_id: contactId,
        external_id: externalId,
        status: appointment.Estado ?? null,
        service: appointment.Servicio ?? null,
        customer_name: appointment.Nombre ?? null,
        phone: appointment.Telefono ?? null,
        email: appointment.Email ?? null,
        start_time: appointment.startTime ?? null,
        end_time: appointment.endTime ?? null,
        cancel_url: appointment.url_cancelacion_corta ?? appointment.Url_Cancelacion ?? null,
        raw_payload: payload,
      },
      { onConflict: 'account_id,provider,external_id' },
    )
    .select('*')
    .single();
  if (upsertErr || !record) {
    console.error('[arvera appointments webhook] record upsert failed:', upsertErr);
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

async function findContactId(
  db: ReturnType<typeof dbAdmin>,
  accountId: string,
  appointment: ArveraAppointmentRecord,
): Promise<string | null> {
  const phone = typeof appointment.Telefono === 'string' ? appointment.Telefono.trim() : '';
  const email = typeof appointment.Email === 'string' ? appointment.Email.trim() : '';

  if (phone) {
    const { data } = await db
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .eq('phone', phone)
      .maybeSingle();
    if (data?.id) return data.id as string;
  }

  if (email) {
    const { data } = await db
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .eq('email', email)
      .maybeSingle();
    if (data?.id) return data.id as string;
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
