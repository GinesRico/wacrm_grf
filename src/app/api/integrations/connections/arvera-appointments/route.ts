import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { integrationConnections } from '@/db/schema';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { ensureIntegrationApp } from '@/lib/integrations/apps';
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
  type ArveraAppointmentsConnection,
} from '@/lib/integrations/arvera-appointments';
import { INTERACTIVE_LIMITS } from '@/lib/whatsapp/meta-api';

function serializeConnection(row: typeof integrationConnections.$inferSelect) {
  return {
    id: row.id,
    app_slug: row.appSlug,
    enabled: row.enabled,
    config: row.config,
    status: row.status,
    last_error: row.lastError,
    last_checked_at: row.lastCheckedAt?.toISOString() ?? null,
    updated_at: row.updatedAt.toISOString(),
  };
}

function toResolverConnection(
  credentials: unknown
): ArveraAppointmentsConnection {
  return {
    id: '',
    account_id: '',
    app_slug: ARVERA_APPOINTMENTS_SLUG,
    enabled: false,
    encrypted_credentials: (credentials as Record<string, string> | null) ?? {},
    config: {},
    status: 'not_configured',
    last_error: null,
  };
}

function defaultConnection() {
  return {
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
  };
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const [data] = await db
      .select()
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.accountId, ctx.accountId),
          eq(integrationConnections.appSlug, ARVERA_APPOINTMENTS_SLUG)
        )
      )
      .limit(1);

    const token = resolveAppointmentsWebhookToken(
      data ? toResolverConnection(data.encryptedCredentials) : null
    );
    return NextResponse.json({
      connection: data ? serializeConnection(data) : defaultConnection(),
      has_api_token: Boolean(
        (data?.encryptedCredentials as Record<string, string> | undefined)
          ?.api_token
      ),
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
        body?.default_send_mode === 'interactive_list' ||
        body?.default_send_mode === 'cta_url'
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
        typeof body?.cta_button_label === 'string' &&
        body.cta_button_label.trim()
          ? body.cta_button_label.trim()
          : ARVERA_APPOINTMENTS_DEFAULT_CTA_BUTTON_LABEL,
      cta_url_template:
        typeof body?.cta_url_template === 'string' &&
        body.cta_url_template.trim()
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
        typeof body?.list_button_label === 'string' &&
        body.list_button_label.trim()
          ? body.list_button_label.trim()
          : ARVERA_APPOINTMENTS_DEFAULT_LIST_BUTTON_LABEL,
      list_section_title:
        typeof body?.list_section_title === 'string' &&
        body.list_section_title.trim()
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
          { status: 400 }
        );
      }
      if (!config.cta_url_template.includes('{{short_url}}')) {
        return NextResponse.json(
          { error: 'La URL del boton debe incluir {{short_url}}' },
          { status: 400 }
        );
      }
    }
    if (config.default_send_mode === 'interactive_list') {
      if (config.list_header.length > INTERACTIVE_LIMITS.headerTextMaxLength) {
        return NextResponse.json(
          { error: 'El encabezado de lista no puede superar 60 caracteres' },
          { status: 400 }
        );
      }
      if (config.list_body.length > INTERACTIVE_LIMITS.bodyMaxLength) {
        return NextResponse.json(
          { error: 'El cuerpo de lista no puede superar 1024 caracteres' },
          { status: 400 }
        );
      }
      if (config.list_footer.length > INTERACTIVE_LIMITS.footerMaxLength) {
        return NextResponse.json(
          { error: 'El pie de lista no puede superar 60 caracteres' },
          { status: 400 }
        );
      }
      if (
        config.list_button_label.length >
        INTERACTIVE_LIMITS.buttonTitleMaxLength
      ) {
        return NextResponse.json(
          {
            error:
              'La etiqueta del boton de lista no puede superar 20 caracteres',
          },
          { status: 400 }
        );
      }
    }

    const apiToken =
      typeof body?.api_token === 'string' ? body.api_token.trim() : '';
    const enabled = body?.enabled === true;

    const [existing] = await db
      .select({
        encryptedCredentials: integrationConnections.encryptedCredentials,
      })
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.accountId, ctx.accountId),
          eq(integrationConnections.appSlug, ARVERA_APPOINTMENTS_SLUG)
        )
      )
      .limit(1);

    const existingCredentials =
      (existing?.encryptedCredentials as Record<string, string> | undefined) ??
      {};
    const webhookToken =
      resolveAppointmentsWebhookToken({
        ...toResolverConnection(existingCredentials),
      }) ?? generateWebhookToken();
    const encryptedCredentials: Record<string, string> = {
      ...existingCredentials,
      ...(apiToken ? encryptAppointmentsApiToken(apiToken) : {}),
      webhook_token: encryptWebhookToken(webhookToken),
    };

    if (
      enabled &&
      !encryptedCredentials.api_token &&
      !process.env.ARVERA_APPOINTMENTS_API_TOKEN
    ) {
      return NextResponse.json(
        { error: 'API token is required before enabling Citas Arvera' },
        { status: 400 }
      );
    }

    await ensureIntegrationApp(db, ARVERA_APPOINTMENTS_SLUG);

    const [data] = await db
      .insert(integrationConnections)
      .values({
        accountId: ctx.accountId,
        appSlug: ARVERA_APPOINTMENTS_SLUG,
        enabled,
        encryptedCredentials,
        config,
        status: enabled ? 'active' : 'disabled',
        lastError: null,
        lastCheckedAt: new Date(),
        createdBy: ctx.userId,
      })
      .onConflictDoUpdate({
        target: [
          integrationConnections.accountId,
          integrationConnections.appSlug,
        ],
        set: {
          enabled,
          encryptedCredentials,
          config,
          status: enabled ? 'active' : 'disabled',
          lastError: null,
          lastCheckedAt: new Date(),
          createdBy: ctx.userId,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!data) {
      return NextResponse.json(
        { error: 'Failed to save connection' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      connection: serializeConnection(data),
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
