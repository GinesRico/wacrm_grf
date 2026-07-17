import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  ARVERA_APPOINTMENTS_DEFAULT_BASE_URL,
  ARVERA_APPOINTMENTS_DEFAULT_CTA_BUTTON_LABEL,
  ARVERA_APPOINTMENTS_DEFAULT_CTA_URL_TEMPLATE,
  ARVERA_APPOINTMENTS_DEFAULT_IFRAME_URL,
  ARVERA_APPOINTMENTS_DEFAULT_LIST_BODY,
  ARVERA_APPOINTMENTS_DEFAULT_LIST_BUTTON_LABEL,
  ARVERA_APPOINTMENTS_DEFAULT_LIST_FOOTER,
  ARVERA_APPOINTMENTS_DEFAULT_LIST_HEADER,
  ARVERA_APPOINTMENTS_DEFAULT_LIST_ROW_DESCRIPTION,
  ARVERA_APPOINTMENTS_DEFAULT_LIST_ROW_TITLE,
  ARVERA_APPOINTMENTS_DEFAULT_LIST_SECTION_TITLE,
  ARVERA_APPOINTMENTS_DEFAULT_MESSAGE,
  ARVERA_APPOINTMENTS_DEFAULT_PUBLIC_BOOKING_URL,
  ARVERA_APPOINTMENTS_SLUG,
  encryptAppointmentsApiToken,
  encryptWebhookToken,
  generateWebhookToken,
  normalizeAppointmentsConfig,
  resolveAppointmentsWebhookToken,
} from '@/lib/integrations/arvera-appointments';
import { INTERACTIVE_LIMITS } from '@/lib/whatsapp/meta-api';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const { data, error } = await ctx.supabase
      .from('integration_connections')
      .select('id, app_slug, enabled, config, status, last_error, last_checked_at, updated_at, encrypted_credentials')
      .eq('account_id', ctx.accountId)
      .eq('app_slug', ARVERA_APPOINTMENTS_SLUG)
      .maybeSingle();
    if (error) {
      return NextResponse.json({ error: 'Failed to load connection' }, { status: 500 });
    }

    const token = resolveAppointmentsWebhookToken(data as never);
    return NextResponse.json({
      connection: data
        ? {
            ...data,
            encrypted_credentials: undefined,
          }
        : {
            app_slug: ARVERA_APPOINTMENTS_SLUG,
            enabled: false,
            config: {
              base_url: ARVERA_APPOINTMENTS_DEFAULT_BASE_URL,
              iframe_url: ARVERA_APPOINTMENTS_DEFAULT_IFRAME_URL,
              public_booking_url: ARVERA_APPOINTMENTS_DEFAULT_PUBLIC_BOOKING_URL,
              default_send_mode: 'booking_link',
              default_days_ahead: 1,
              duracion: 45,
              timezone: 'Europe/Madrid',
              default_service: 'Cita taller',
              default_message: ARVERA_APPOINTMENTS_DEFAULT_MESSAGE,
              cta_button_label: ARVERA_APPOINTMENTS_DEFAULT_CTA_BUTTON_LABEL,
              cta_url_template: ARVERA_APPOINTMENTS_DEFAULT_CTA_URL_TEMPLATE,
              list_header: ARVERA_APPOINTMENTS_DEFAULT_LIST_HEADER,
              list_body: ARVERA_APPOINTMENTS_DEFAULT_LIST_BODY,
              list_footer: ARVERA_APPOINTMENTS_DEFAULT_LIST_FOOTER,
              list_button_label: ARVERA_APPOINTMENTS_DEFAULT_LIST_BUTTON_LABEL,
              list_section_title: ARVERA_APPOINTMENTS_DEFAULT_LIST_SECTION_TITLE,
              list_row_title: ARVERA_APPOINTMENTS_DEFAULT_LIST_ROW_TITLE,
              list_row_description: ARVERA_APPOINTMENTS_DEFAULT_LIST_ROW_DESCRIPTION,
            },
            status: 'not_configured',
            last_error: null,
          },
      has_api_token: Boolean(data?.encrypted_credentials?.api_token),
      webhook_url: token ? buildWebhookUrl(request, token) : null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => null)) as {
      enabled?: unknown;
      base_url?: unknown;
      api_token?: unknown;
      iframe_url?: unknown;
      public_booking_url?: unknown;
      default_send_mode?: unknown;
      default_days_ahead?: unknown;
      duracion?: unknown;
      timezone?: unknown;
      default_service?: unknown;
      default_message?: unknown;
      cta_button_label?: unknown;
      cta_url_template?: unknown;
      list_header?: unknown;
      list_body?: unknown;
      list_footer?: unknown;
      list_button_label?: unknown;
      list_section_title?: unknown;
      list_row_title?: unknown;
      list_row_description?: unknown;
    } | null;

    const config = normalizeAppointmentsConfig({
      base_url:
        typeof body?.base_url === 'string'
          ? body.base_url
          : ARVERA_APPOINTMENTS_DEFAULT_BASE_URL,
      iframe_url:
        typeof body?.iframe_url === 'string'
          ? body.iframe_url
          : ARVERA_APPOINTMENTS_DEFAULT_IFRAME_URL,
      public_booking_url:
        typeof body?.public_booking_url === 'string'
          ? body.public_booking_url
          : ARVERA_APPOINTMENTS_DEFAULT_PUBLIC_BOOKING_URL,
      default_send_mode:
        body?.default_send_mode === 'interactive_list' || body?.default_send_mode === 'cta_url'
          ? body.default_send_mode
          : 'booking_link',
      default_days_ahead: Number(body?.default_days_ahead),
      duracion: Number(body?.duracion),
      timezone:
        typeof body?.timezone === 'string' && body.timezone.trim()
          ? body.timezone.trim()
          : 'Europe/Madrid',
      default_service:
        typeof body?.default_service === 'string' && body.default_service.trim()
          ? body.default_service.trim()
          : 'Cita taller',
      default_message:
        typeof body?.default_message === 'string' && body.default_message.trim()
          ? body.default_message.trim()
          : ARVERA_APPOINTMENTS_DEFAULT_MESSAGE,
      cta_button_label:
        typeof body?.cta_button_label === 'string' && body.cta_button_label.trim()
          ? body.cta_button_label.trim()
          : ARVERA_APPOINTMENTS_DEFAULT_CTA_BUTTON_LABEL,
      cta_url_template:
        typeof body?.cta_url_template === 'string' && body.cta_url_template.trim()
          ? body.cta_url_template.trim()
          : ARVERA_APPOINTMENTS_DEFAULT_CTA_URL_TEMPLATE,
      list_header:
        typeof body?.list_header === 'string' && body.list_header.trim()
          ? body.list_header.trim()
          : ARVERA_APPOINTMENTS_DEFAULT_LIST_HEADER,
      list_body:
        typeof body?.list_body === 'string' && body.list_body.trim()
          ? body.list_body.trim()
          : ARVERA_APPOINTMENTS_DEFAULT_LIST_BODY,
      list_footer:
        typeof body?.list_footer === 'string'
          ? body.list_footer.trim()
          : ARVERA_APPOINTMENTS_DEFAULT_LIST_FOOTER,
      list_button_label:
        typeof body?.list_button_label === 'string' && body.list_button_label.trim()
          ? body.list_button_label.trim()
          : ARVERA_APPOINTMENTS_DEFAULT_LIST_BUTTON_LABEL,
      list_section_title:
        typeof body?.list_section_title === 'string' && body.list_section_title.trim()
          ? body.list_section_title.trim()
          : ARVERA_APPOINTMENTS_DEFAULT_LIST_SECTION_TITLE,
      list_row_title:
        typeof body?.list_row_title === 'string' && body.list_row_title.trim()
          ? body.list_row_title.trim()
          : ARVERA_APPOINTMENTS_DEFAULT_LIST_ROW_TITLE,
      list_row_description:
        typeof body?.list_row_description === 'string'
          ? body.list_row_description.trim()
          : ARVERA_APPOINTMENTS_DEFAULT_LIST_ROW_DESCRIPTION,
    });

    if (config.default_send_mode === 'cta_url') {
      if (config.cta_button_label.length > 20) {
        return NextResponse.json(
          { error: 'El texto del boton CTA no puede superar 20 caracteres' },
          { status: 400 },
        );
      }
      if (!config.cta_url_template.includes('{{short_url}}')) {
        return NextResponse.json(
          { error: 'La URL del boton debe incluir {{short_url}}' },
          { status: 400 },
        );
      }
    }
    if (config.default_send_mode === 'interactive_list') {
      if (config.list_header.length > INTERACTIVE_LIMITS.headerTextMaxLength) {
        return NextResponse.json(
          { error: 'El encabezado de lista no puede superar 60 caracteres' },
          { status: 400 },
        );
      }
      if (config.list_body.length > INTERACTIVE_LIMITS.bodyMaxLength) {
        return NextResponse.json(
          { error: 'El cuerpo de lista no puede superar 1024 caracteres' },
          { status: 400 },
        );
      }
      if (config.list_footer.length > INTERACTIVE_LIMITS.footerMaxLength) {
        return NextResponse.json(
          { error: 'El pie de lista no puede superar 60 caracteres' },
          { status: 400 },
        );
      }
      if (config.list_button_label.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
        return NextResponse.json(
          { error: 'La etiqueta del boton de lista no puede superar 20 caracteres' },
          { status: 400 },
        );
      }
    }

    const apiToken = typeof body?.api_token === 'string' ? body.api_token.trim() : '';
    const enabled = body?.enabled === true;

    const { data: existing } = await ctx.supabase
      .from('integration_connections')
      .select('encrypted_credentials')
      .eq('account_id', ctx.accountId)
      .eq('app_slug', ARVERA_APPOINTMENTS_SLUG)
      .maybeSingle();

    const existingCredentials =
      (existing?.encrypted_credentials as Record<string, string> | undefined) ?? {};
    const webhookToken = resolveAppointmentsWebhookToken({
      encrypted_credentials: existingCredentials,
    } as never) ?? generateWebhookToken();
    const encrypted_credentials: Record<string, string> = {
      ...existingCredentials,
      ...(apiToken ? encryptAppointmentsApiToken(apiToken) : {}),
      webhook_token: encryptWebhookToken(webhookToken),
    };

    if (
      enabled &&
      !encrypted_credentials.api_token &&
      !process.env.ARVERA_APPOINTMENTS_API_TOKEN
    ) {
      return NextResponse.json(
        { error: 'API token is required before enabling Citas Arvera' },
        { status: 400 },
      );
    }

    const { data, error } = await ctx.supabase
      .from('integration_connections')
      .upsert(
        {
          account_id: ctx.accountId,
          app_slug: ARVERA_APPOINTMENTS_SLUG,
          enabled,
          encrypted_credentials,
          config,
          status: enabled ? 'active' : 'disabled',
          last_error: null,
          last_checked_at: new Date().toISOString(),
          created_by: ctx.userId,
        },
        { onConflict: 'account_id,app_slug' },
      )
      .select('id, app_slug, enabled, config, status, last_error, last_checked_at, updated_at')
      .single();

    if (error || !data) {
      console.error('[arvera appointments connection] save failed:', error);
      return NextResponse.json({ error: 'Failed to save connection' }, { status: 500 });
    }

    return NextResponse.json({
      connection: data,
      has_api_token: true,
      webhook_url: buildWebhookUrl(request, webhookToken),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

function buildWebhookUrl(request: Request, token: string): string {
  const origin = new URL(request.url).origin;
  return `${origin}/api/integrations/arvera-appointments/webhook?token=${encodeURIComponent(token)}`;
}
