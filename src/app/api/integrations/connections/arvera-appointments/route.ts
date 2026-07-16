import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  ARVERA_APPOINTMENTS_DEFAULT_BASE_URL,
  ARVERA_APPOINTMENTS_DEFAULT_IFRAME_URL,
  ARVERA_APPOINTMENTS_DEFAULT_MESSAGE,
  ARVERA_APPOINTMENTS_DEFAULT_PUBLIC_BOOKING_URL,
  ARVERA_APPOINTMENTS_SLUG,
  encryptAppointmentsApiToken,
  encryptWebhookToken,
  generateWebhookToken,
  normalizeAppointmentsConfig,
  resolveAppointmentsWebhookToken,
} from '@/lib/integrations/arvera-appointments';

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
        body?.default_send_mode === 'interactive_list' ? 'interactive_list' : 'booking_link',
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
    });

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
