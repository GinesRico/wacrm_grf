import { NextResponse } from 'next/server';

import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  createAppointment,
  listAppointments,
  requireActiveArveraAppointmentsConnection,
} from '@/lib/integrations/arvera-appointments';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const { searchParams } = new URL(request.url);
    const { config, apiToken } = await requireActiveArveraAppointmentsConnection(
      ctx.supabase,
      ctx.accountId,
    );
    const appointments = await listAppointments({
      config,
      apiToken,
      startDate: searchParams.get('startDate') || undefined,
      endDate: searchParams.get('endDate') || undefined,
      estado: searchParams.get('estado') || undefined,
    });
    return NextResponse.json({ appointments });
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ error: 'Request body must be JSON' }, { status: 400 });
    }

    const Nombre = requiredString(body.Nombre, 'Nombre');
    const Telefono = requiredString(body.Telefono, 'Telefono');
    const Servicio = requiredString(body.Servicio, 'Servicio');
    const startTime = requiredString(body.startTime, 'startTime');
    const endTime = requiredString(body.endTime, 'endTime');
    const contactId = typeof body.contact_id === 'string' ? body.contact_id : null;

    if (contactId) {
      const { data: contact } = await ctx.supabase
        .from('contacts')
        .select('id')
        .eq('account_id', ctx.accountId)
        .eq('id', contactId)
        .maybeSingle();
      if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    const { config, apiToken } = await requireActiveArveraAppointmentsConnection(
      ctx.supabase,
      ctx.accountId,
    );
    const appointment = await createAppointment({
      config,
      apiToken,
      input: {
        Nombre,
        Telefono,
        Servicio,
        startTime,
        endTime,
        Email: optionalString(body.Email),
        Matricula: optionalString(body.Matricula),
        Modelo: optionalString(body.Modelo),
        Notas: optionalString(body.Notas),
      },
    });

    await ctx.supabase.from('appointment_records').upsert(
      {
        account_id: ctx.accountId,
        contact_id: contactId,
        external_id: appointment.Id,
        status: appointment.Estado ?? null,
        service: appointment.Servicio ?? null,
        customer_name: appointment.Nombre ?? null,
        phone: appointment.Telefono ?? null,
        email: appointment.Email ?? null,
        start_time: appointment.startTime ?? null,
        end_time: appointment.endTime ?? null,
        cancel_url: appointment.url_cancelacion_corta ?? appointment.Url_Cancelacion ?? null,
        raw_payload: appointment,
      },
      { onConflict: 'account_id,provider,external_id' },
    );

    void runAutomationsForTrigger({
      accountId: ctx.accountId,
      triggerType: 'appointment_created',
      contactId,
      context: {
        vars: {
          appointment_id: appointment.Id,
          appointment_status: appointment.Estado,
          appointment_start: appointment.startTime,
          appointment_end: appointment.endTime,
          appointment_service: appointment.Servicio,
          appointment_cancel_url:
            appointment.url_cancelacion_corta ?? appointment.Url_Cancelacion ?? '',
        },
      },
    });

    return NextResponse.json({ appointment }, { status: 201 });
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`${field} is required`);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
