import { db } from '@/db/client';
import { appointmentRecords } from '@/db/schema';
import {
  createAppointment,
  fetchAvailabilitySlots,
  requireActiveArveraAppointmentsConnection,
  type AvailabilitySlot,
} from '@/lib/integrations/arvera-appointments';
import type {
  MetaFlowDataOption,
  MetaFlowHandler,
  MetaFlowHandlerContext,
  MetaFlowRequestBody,
  MetaFlowResponseBody,
} from './types';

const VERSION = '3.0';
const PENDING_TIME = {
  id: 'pending_date',
  title: 'Selecciona una fecha',
  enabled: false,
};

const SERVICE_OPTIONS: MetaFlowDataOption[] = [
  { id: 'neumaticos', title: 'Neumaticos' },
  { id: 'alineacion', title: 'Alineacion' },
  { id: 'neumaticos_alineacion', title: 'Neumaticos, Alineacion' },
];

export const appointmentsFlowHandler: MetaFlowHandler = {
  slug: 'citas',
  initialScreen: 'APPOINTMENT',
  getInitialData,
  async handleRequest(body, ctx) {
    const action = body.action || body.data?.trigger;
    if (action === 'ping') {
      return screen('APPOINTMENT', { status: 'active' });
    }
    if (body.data?.error_key) {
      console.warn(
        '[whatsapp-flows:citas] Meta returned error_key:',
        body.data
      );
      return screen('APPOINTMENT', await getInitialData(ctx));
    }
    if (action === 'INIT' || !action) {
      return screen('APPOINTMENT', await getInitialData(ctx));
    }
    if (action === 'BACK') {
      return screen(body.screen || 'APPOINTMENT', await getInitialData(ctx));
    }

    const trigger = stringValue(body.data?.trigger) || action;
    switch (trigger) {
      case 'service_selected':
        return screen('APPOINTMENT', {
          ...(await getInitialData(ctx)),
          service: SERVICE_OPTIONS,
        });
      case 'date_selected':
        return screen('APPOINTMENT', {
          service: SERVICE_OPTIONS,
          date: getNextWorkDays(),
          time: await getTimeOptions(ctx, body.data),
        });
      case 'details_submitted':
        return screen('SUMMARY', buildSummaryData(body.data));
      case 'confirm_appointment':
        return confirmAppointment(ctx, body);
      default:
        console.warn('[whatsapp-flows:citas] unhandled trigger:', trigger);
        return screen('APPOINTMENT', await getInitialData(ctx));
    }
  },
};

async function getInitialData(
  _ctx?: MetaFlowHandlerContext
): Promise<Record<string, unknown>> {
  return {
    service: SERVICE_OPTIONS,
    date: getNextWorkDays(),
    time: [PENDING_TIME],
  };
}

async function getTimeOptions(
  ctx: MetaFlowHandlerContext,
  data: Record<string, unknown> | undefined
): Promise<MetaFlowDataOption[]> {
  const date = stringValue(data?.date);
  const service = stringValue(data?.service);
  if (!date) return [PENDING_TIME];

  const { config, apiToken } = await requireActiveArveraAppointmentsConnection(
    null,
    ctx.accountId
  );
  const payload = await fetchAvailabilitySlots({
    config,
    apiToken,
    startDate: date,
    endDate: date,
    duracion: config.duracion,
    timezone: config.timezone,
  });
  const slots = payload.disponibles.filter((slot) =>
    service === 'alineacion' || service === 'neumaticos_alineacion'
      ? slotAllowsAlignment(slot)
      : true
  );

  if (slots.length === 0) {
    return [
      { id: 'no_slots', title: 'Sin huecos disponibles', enabled: false },
    ];
  }
  return slots.map((slot) => ({
    id: JSON.stringify({
      hora_inicio: slot.hora_inicio,
      hora_fin: slot.hora_fin,
      startTime: slot.startTime,
      endTime: slot.endTime,
    }),
    title: slot.hora_inicio,
  }));
}

function buildSummaryData(
  data: Record<string, unknown> | undefined
): Record<string, unknown> {
  const service = stringValue(data?.service);
  const date = stringValue(data?.date);
  const timeSlot = parseTimeSlot(stringValue(data?.time));
  const time = timeSlot?.hora_inicio || stringValue(data?.time);
  const name = stringValue(data?.name);
  const phone = stringValue(data?.phone);
  const email = stringValue(data?.email);
  const licensePlate = stringValue(data?.license_plate);
  const vehicle = stringValue(data?.vehicle);
  const notes = stringValue(data?.notes);

  return {
    service,
    date,
    time: stringValue(data?.time),
    name,
    phone,
    email,
    license_plate: licensePlate,
    vehicle,
    notes,
    appointment:
      `${getServiceTitle(service)} - ${formatDateTitle(date)} ${time}`.trim(),
    details: [name, phone, email, licensePlate, vehicle]
      .filter(Boolean)
      .join('\n'),
  };
}

async function confirmAppointment(
  ctx: MetaFlowHandlerContext,
  body: MetaFlowRequestBody
): Promise<MetaFlowResponseBody> {
  const data = body.data ?? {};
  const service = stringValue(data.service);
  const slot = parseTimeSlot(stringValue(data.time));
  if (!slot?.startTime || !slot.endTime) {
    console.warn('[whatsapp-flows:citas] missing start/end time:', data);
    return screen('SUMMARY', {
      ...buildSummaryData(data),
      error: 'Selecciona una hora valida antes de confirmar.',
    });
  }

  const input = {
    Nombre: requiredString(data.name, 'name'),
    Telefono: requiredString(data.phone, 'phone'),
    Email: nullableString(data.email),
    Servicio: getServiceTitle(service),
    startTime: slot.startTime,
    endTime: slot.endTime,
    Matricula: nullableString(data.license_plate),
    Modelo: nullableString(data.vehicle),
    Notas: nullableString(data.notes),
  };
  const { config, apiToken } = await requireActiveArveraAppointmentsConnection(
    null,
    ctx.accountId
  );
  const appointment = await createAppointment({ config, apiToken, input });
  const externalId = appointment.Id || crypto.randomUUID();

  await db
    .insert(appointmentRecords)
    .values({
      accountId: ctx.accountId,
      externalId,
      status: appointment.Estado ?? null,
      service: appointment.Servicio ?? null,
      customerName: appointment.Nombre ?? null,
      phone: appointment.Telefono ?? null,
      email: appointment.Email ?? null,
      startTime: appointment.startTime ? new Date(appointment.startTime) : null,
      endTime: appointment.endTime ? new Date(appointment.endTime) : null,
      cancelUrl:
        appointment.url_cancelacion_corta ??
        appointment.Url_Cancelacion ??
        null,
      rawPayload: appointment,
    })
    .onConflictDoUpdate({
      target: [
        appointmentRecords.accountId,
        appointmentRecords.provider,
        appointmentRecords.externalId,
      ],
      set: {
        status: appointment.Estado ?? null,
        service: appointment.Servicio ?? null,
        customerName: appointment.Nombre ?? null,
        phone: appointment.Telefono ?? null,
        email: appointment.Email ?? null,
        startTime: appointment.startTime
          ? new Date(appointment.startTime)
          : null,
        endTime: appointment.endTime ? new Date(appointment.endTime) : null,
        cancelUrl:
          appointment.url_cancelacion_corta ??
          appointment.Url_Cancelacion ??
          null,
        rawPayload: appointment,
        updatedAt: new Date(),
      },
    });

  return screen('SUCCESS', {
    extension_message_response: {
      params: {
        flow_token: ctx.flowToken,
        service,
        date: stringValue(data.date),
        time: slot.hora_inicio,
        name: input.Nombre,
        phone: input.Telefono,
        appointment_id: appointment.Id,
      },
    },
  });
}

function screen(screenName: string, data: Record<string, unknown>) {
  return { version: VERSION, screen: screenName, data };
}

function getNextWorkDays(): MetaFlowDataOption[] {
  const days: MetaFlowDataOption[] = [];
  const date = new Date();
  while (days.length < 10) {
    date.setDate(date.getDate() + 1);
    const day = date.getDay();
    if (day === 0) continue;
    const id = date.toISOString().slice(0, 10);
    days.push({ id, title: formatDateTitle(id) });
  }
  return days;
}

function formatDateTitle(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(date);
}

function getServiceTitle(service: string): string {
  if (service === 'neumaticos') return 'Neumaticos';
  if (service === 'alineacion') return 'Alineacion';
  if (service === 'neumaticos_alineacion') return 'Neumaticos, Alineacion';
  return service;
}

function slotAllowsAlignment(slot: AvailabilitySlot): boolean {
  return (
    (slot as AvailabilitySlot & { permite_alineacion?: unknown })
      .permite_alineacion !== false
  );
}

function parseTimeSlot(value: string): {
  hora_inicio?: string;
  hora_fin?: string;
  startTime?: string;
  endTime?: string;
} | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      hora_inicio: stringValue(parsed.hora_inicio),
      hora_fin: stringValue(parsed.hora_fin),
      startTime: stringValue(parsed.startTime),
      endTime: stringValue(parsed.endTime),
    };
  } catch {
    return null;
  }
}

function requiredString(value: unknown, field: string): string {
  const text = stringValue(value);
  if (text) return text;
  throw new Error(`${field} is required`);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nullableString(value: unknown): string | null {
  const text = stringValue(value);
  return text || null;
}
