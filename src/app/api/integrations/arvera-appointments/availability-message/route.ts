import { NextResponse } from 'next/server';

import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  fetchAvailabilityMessage,
  fetchAvailabilitySlots,
  renderAppointmentsMessage,
  requireActiveArveraAppointmentsConnection,
} from '@/lib/integrations/arvera-appointments';
import { sendMessageToConversation, SendMessageError } from '@/lib/whatsapp/send-message';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ error: 'Request body must be JSON' }, { status: 400 });
    }

    const date = typeof body.date === 'string' ? body.date : '';
    const conversationId =
      typeof body.conversation_id === 'string' ? body.conversation_id : null;
    const contactId = typeof body.contact_id === 'string' ? body.contact_id : null;
    if (!date) return NextResponse.json({ error: 'date is required' }, { status: 400 });
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
    const messagePayload = await fetchAvailabilityMessage({ config, date });
    const text = renderAppointmentsMessage(config.default_message, {
      mensaje: messagePayload.mensaje,
      short_url: messagePayload.short_url ?? '',
      fecha_texto: messagePayload.fecha_texto ?? '',
      service:
        typeof body.service === 'string' && body.service.trim()
          ? body.service.trim()
          : config.default_service,
    });

    const availability = await fetchAvailabilitySlots({
      config,
      apiToken,
      startDate: date,
      endDate: typeof body.end_date === 'string' ? body.end_date : date,
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
        end_date: typeof body.end_date === 'string' ? body.end_date : null,
        send_mode: 'booking_link',
        service:
          typeof body.service === 'string' && body.service.trim()
            ? body.service.trim()
            : config.default_service,
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

    const sent = await sendMessageToConversation(ctx.supabase, ctx.accountId, {
      conversationId,
      messageType: 'text',
      contentText: text,
    });

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
        },
      },
    });

    return NextResponse.json({ availability_message: audit, message: sent }, { status: 201 });
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
