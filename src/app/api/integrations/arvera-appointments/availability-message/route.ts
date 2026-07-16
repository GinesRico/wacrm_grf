import { NextResponse } from 'next/server';

import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  fetchAvailabilityMessage,
  fetchAvailabilitySlots,
  type AppointmentSendMode,
  renderAppointmentsMessage,
  requireActiveArveraAppointmentsConnection,
} from '@/lib/integrations/arvera-appointments';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';
import { sendMessageToConversation, SendMessageError } from '@/lib/whatsapp/send-message';

const MAX_INTERACTIVE_DAYS = 10;
const MAX_INTERACTIVE_ROWS = 10;
const APPOINTMENT_SERVICES = ['Neumaticos', 'Alineacion', 'Neumaticos + Alineacion'];

function parseRequestedDates(body: Record<string, unknown>): string[] {
  const rawDates = Array.isArray(body.dates) ? body.dates : [body.date];
  const seen = new Set<string>();
  const dates: string[] = [];
  for (const raw of rawDates) {
    if (typeof raw !== 'string') continue;
    const date = raw.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || seen.has(date)) continue;
    seen.add(date);
    dates.push(date);
  }
  return dates;
}

function resolveSendMode(body: Record<string, unknown>, fallback: AppointmentSendMode) {
  return body.send_mode === 'interactive_list' ? 'interactive_list' : fallback;
}

function normalizeAppointmentService(value: unknown, fallback: string) {
  if (typeof value === 'string') {
    const normalized = value.trim();
    const service = APPOINTMENT_SERVICES.find(
      (item) => item.toLowerCase() === normalized.toLowerCase(),
    );
    if (service) return service;
  }
  const fallbackService = APPOINTMENT_SERVICES.find(
    (item) => item.toLowerCase() === fallback.trim().toLowerCase(),
  );
  return fallbackService ?? APPOINTMENT_SERVICES[0];
}

function formatListDate(date: string) {
  const parsed = new Date(`${date}T12:00:00`);
  const formatted = new Intl.DateTimeFormat('es-ES', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  }).format(parsed);
  return formatted.replace(/\.$/, '').slice(0, 24);
}

function formatLongListDate(date: string) {
  const parsed = new Date(`${date}T12:00:00`);
  return new Intl.DateTimeFormat('es-ES', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(parsed);
}

function formatSelectedDates(dates: string[]) {
  if (dates.length === 1) return `el ${formatLongListDate(dates[0])}`;
  if (dates.length === 2) {
    return `los dias ${formatLongListDate(dates[0])} y ${formatLongListDate(dates[1])}`;
  }
  const visible = dates.slice(0, 3).map(formatLongListDate).join(', ');
  const rest = dates.length > 3 ? ` y ${dates.length - 3} mas` : '';
  return `los dias ${visible}${rest}`;
}

function formatRowDate(date: string) {
  return formatLongListDate(date);
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function extractDate(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const isoDate = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return isoDate?.[1] ?? fallback;
}

function extractTime(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const hhmm = value.match(/(\d{2}:\d{2})/);
  return hhmm?.[1] ?? null;
}

function slotTimeId(date: string, start: string, index: number) {
  return `appt_slot_${date}_${start.replace(':', '')}_${index}`;
}

function buildInteractivePayload(
  dates: string[],
  service: string,
  audits: Array<{ date: string; slots?: unknown[] | null; short_url?: string | null }>,
): InteractiveMessagePayload {
  const rows = audits.flatMap((audit) => {
    const slots = Array.isArray(audit.slots) ? audit.slots : [];
    return slots.map((slot, index) => {
      const item = toRecord(slot);
      const date = extractDate(item.fecha ?? item.startTime, audit.date);
      const start = extractTime(item.hora_inicio ?? item.startTime) ?? '';
      const end = extractTime(item.hora_fin ?? item.endTime);
      return { date, start, end, index };
    });
  })
    .filter((slot) => slot.start)
    .sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));

  const visibleRows = rows.slice(0, MAX_INTERACTIVE_ROWS);
  const sections = dates
    .map((date) => {
      const dateRows = visibleRows.filter((slot) => slot.date === date);
      if (dateRows.length === 0) return null;
      return {
        title: formatListDate(date),
        rows: dateRows.map((slot) => ({
          id: slotTimeId(slot.date, slot.start, slot.index),
          title: slot.start,
          description: service ? `${formatRowDate(slot.date)} - ${service}` : formatRowDate(slot.date),
        })),
      };
    })
    .filter(Boolean) as Array<{ title: string; rows: Array<{ id: string; title: string; description: string }> }>;

  if (sections.length === 0) {
    return {
      kind: 'list',
      header: 'Citas disponibles',
      body: 'No he encontrado horas libres para los dias seleccionados.',
      footer: 'Puedes probar con otros dias.',
      button_label: 'Ver citas',
      sections: [
        {
          title: 'Sin huecos',
          rows: dates.slice(0, 1).map((date) => ({
            id: `appt_no_slots_${date}`,
            title: 'Sin horas libres',
            description: formatListDate(date),
          })),
        },
      ],
    };
  }

  return {
    kind: 'list',
    header: 'Citas disponibles',
    body:
      rows.length > MAX_INTERACTIVE_ROWS
        ? `Elige una hora para ${service} ${formatSelectedDates(dates)}. Mostramos las primeras 10 disponibles.`
        : `Elige una hora para ${service} ${formatSelectedDates(dates)}.`,
    footer: 'Responderas con la hora elegida.',
    button_label: 'Ver citas',
    sections,
  };
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ error: 'Request body must be JSON' }, { status: 400 });
    }

    const dates = parseRequestedDates(body);
    const conversationId =
      typeof body.conversation_id === 'string' ? body.conversation_id : null;
    const contactId = typeof body.contact_id === 'string' ? body.contact_id : null;
    if (dates.length === 0) {
      return NextResponse.json({ error: 'At least one date is required' }, { status: 400 });
    }
    if (dates.length > MAX_INTERACTIVE_DAYS) {
      return NextResponse.json(
        { error: `You can send up to ${MAX_INTERACTIVE_DAYS} days at once` },
        { status: 400 },
      );
    }
    if (!conversationId) {
      return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 });
    }

    if (contactId) {
      const { data: contact } = await ctx.supabase
        .from('contacts')
        .select('id')
        .eq('account_id', ctx.accountId)
        .eq('id', contactId)
        .maybeSingle();
      if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    const { data: conversation } = await ctx.supabase
      .from('conversations')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('id', conversationId)
      .maybeSingle();
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const { config, apiToken } = await requireActiveArveraAppointmentsConnection(
      ctx.supabase,
      ctx.accountId,
    );
    const sendMode = resolveSendMode(body, config.default_send_mode);
    const service = normalizeAppointmentService(body.service, config.default_service);

    const audits = [];
    const sentMessages = [];
    for (const date of dates) {
      const messagePayload = await fetchAvailabilityMessage({ config, date });
      const text = renderAppointmentsMessage(config.default_message, {
        mensaje: messagePayload.mensaje,
        short_url: messagePayload.short_url ?? '',
        fecha_texto: messagePayload.fecha_texto ?? '',
        service,
      });

      const availability = await fetchAvailabilitySlots({
        config,
        apiToken,
        startDate: date,
        endDate: date,
        duracion: Number(body.duracion ?? config.duracion),
        timezone: typeof body.timezone === 'string' ? body.timezone : config.timezone,
      }).catch(() => ({ disponibles: [] }));

      const { data: audit, error } = await ctx.supabase
        .from('appointment_availability_messages')
        .insert({
          account_id: ctx.accountId,
          contact_id: contactId,
          conversation_id: conversationId,
          date,
          end_date: null,
          send_mode: sendMode,
          service,
          slots: availability.disponibles,
          short_url: messagePayload.short_url ?? null,
          message_text: text,
          raw_response: messagePayload,
          created_by: ctx.userId,
        })
        .select('*')
        .single();
      if (error || !audit) {
        console.error('[arvera appointments availability] insert failed:', error);
        return NextResponse.json({ error: 'Availability message not saved' }, { status: 500 });
      }
      audits.push(audit);

      if (sendMode === 'booking_link') {
        const sent = await sendMessageToConversation(ctx.supabase, ctx.accountId, {
          conversationId,
          messageType: 'text',
          contentText: text,
        });
        sentMessages.push(sent);
      }

      void runAutomationsForTrigger({
        accountId: ctx.accountId,
        triggerType: 'appointment_availability_sent',
        contactId,
        context: {
          conversation_id: conversationId,
          vars: {
            appointment_availability_message_id: audit.id,
            appointment_date: audit.date,
            appointment_short_url: audit.short_url,
            appointment_service: audit.service,
            appointment_send_mode: sendMode,
          },
        },
      });
    }

    if (sendMode === 'interactive_list') {
      const payload = buildInteractivePayload(dates, service, audits);
      const sent = await sendMessageToConversation(ctx.supabase, ctx.accountId, {
        conversationId,
        messageType: 'interactive',
        interactivePayload: payload,
      });
      sentMessages.push(sent);
    }

    return NextResponse.json(
      {
        availability_message: audits[0] ?? null,
        availability_messages: audits,
        message: sentMessages[0] ?? null,
        messages: sentMessages,
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof SendMessageError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
