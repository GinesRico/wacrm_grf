import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { integrationConnections } from '@/db/schema';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  ARVERA_DEFAULT_BASE_URL,
  ARVERA_DEFAULT_CTA_BUTTON_LABEL,
  ARVERA_DEFAULT_CTA_URL_TEMPLATE,
  ARVERA_DEFAULT_MESSAGE,
  ARVERA_PAYMENTS_SLUG,
  encryptApiKey,
  normalizeConfig,
  type PaymentTemplateValueSource,
} from '@/lib/integrations/arvera-payments';

const PAYMENT_TEMPLATE_VALUE_SOURCES = new Set<PaymentTemplateValueSource>([
  'payment_url',
  'payment_url_token',
  'order_id',
  'amount_eur',
  'amount_eur_number',
  'amount_cents',
  'concept',
  'email',
  'phone',
]);

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

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const [data] = await db
      .select()
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.accountId, ctx.accountId),
          eq(integrationConnections.appSlug, ARVERA_PAYMENTS_SLUG),
        ),
      )
      .limit(1);

    return NextResponse.json({
      connection: data
        ? serializeConnection(data)
        : {
            app_slug: ARVERA_PAYMENTS_SLUG,
            enabled: false,
            config: {
              base_url: ARVERA_DEFAULT_BASE_URL,
              auth_header: 'authorization_bearer',
              default_message: ARVERA_DEFAULT_MESSAGE,
              delivery_mode: 'text',
              cta_button_label: ARVERA_DEFAULT_CTA_BUTTON_LABEL,
              cta_url_template: ARVERA_DEFAULT_CTA_URL_TEMPLATE,
            },
            status: 'not_configured',
            last_error: null,
          },
      has_api_key: Boolean(data),
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
      api_key?: unknown;
      auth_header?: unknown;
      default_message?: unknown;
      delivery_mode?: unknown;
      cta_button_label?: unknown;
      cta_url_template?: unknown;
      template_name?: unknown;
      template_language?: unknown;
      template_body_params?: unknown;
      template_button_params?: unknown;
    } | null;

    const config = normalizeConfig({
      base_url: typeof body?.base_url === 'string' ? body.base_url : ARVERA_DEFAULT_BASE_URL,
      auth_header:
        body?.auth_header === 'x_api_key' ? 'x_api_key' : 'authorization_bearer',
      default_message:
        typeof body?.default_message === 'string' && body.default_message.trim()
          ? body.default_message.trim()
          : ARVERA_DEFAULT_MESSAGE,
      delivery_mode:
        body?.delivery_mode === 'template' || body?.delivery_mode === 'cta_url'
          ? body.delivery_mode
          : 'text',
      cta_button_label:
        typeof body?.cta_button_label === 'string' && body.cta_button_label.trim()
          ? body.cta_button_label.trim()
          : ARVERA_DEFAULT_CTA_BUTTON_LABEL,
      cta_url_template:
        typeof body?.cta_url_template === 'string' && body.cta_url_template.trim()
          ? body.cta_url_template.trim()
          : ARVERA_DEFAULT_CTA_URL_TEMPLATE,
      template_name:
        typeof body?.template_name === 'string' && body.template_name.trim()
          ? body.template_name.trim()
          : undefined,
      template_language:
        typeof body?.template_language === 'string' && body.template_language.trim()
          ? body.template_language.trim()
          : undefined,
      template_body_params: normalizeTemplateSourceMap(body?.template_body_params),
      template_button_params: normalizeTemplateSourceMap(body?.template_button_params),
    });

    if (config.delivery_mode === 'template' && !config.template_name) {
      return NextResponse.json(
        { error: 'Select a Meta template before enabling template delivery' },
        { status: 400 },
      );
    }

    if (config.delivery_mode === 'cta_url') {
      if (config.cta_button_label.length > 20) {
        return NextResponse.json(
          { error: 'El texto del boton CTA no puede superar 20 caracteres' },
          { status: 400 },
        );
      }
      if (!config.cta_url_template.includes('{{payment_url}}')) {
        return NextResponse.json(
          { error: 'La URL del boton debe incluir {{payment_url}}' },
          { status: 400 },
        );
      }
    }

    const apiKey = typeof body?.api_key === 'string' ? body.api_key.trim() : '';
    const enabled = body?.enabled === true;

    const [existing] = await db
      .select({ encryptedCredentials: integrationConnections.encryptedCredentials })
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.accountId, ctx.accountId),
          eq(integrationConnections.appSlug, ARVERA_PAYMENTS_SLUG),
        ),
      )
      .limit(1);

    const encryptedCredentials = apiKey
      ? encryptApiKey(apiKey)
      : ((existing?.encryptedCredentials as Record<string, string> | undefined) ?? {});

    if (enabled && !encryptedCredentials.api_key && !process.env.PAYMENT_LINKS_API_KEY) {
      return NextResponse.json(
        { error: 'API key is required before enabling Pagos Arvera' },
        { status: 400 },
      );
    }

    const [data] = await db
      .insert(integrationConnections)
      .values({
        accountId: ctx.accountId,
        appSlug: ARVERA_PAYMENTS_SLUG,
        enabled,
        encryptedCredentials,
        config,
        status: enabled ? 'active' : 'disabled',
        lastError: null,
        lastCheckedAt: new Date(),
        createdBy: ctx.userId,
      })
      .onConflictDoUpdate({
        target: [integrationConnections.accountId, integrationConnections.appSlug],
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
      return NextResponse.json({ error: 'Failed to save connection' }, { status: 500 });
    }

    return NextResponse.json({ connection: serializeConnection(data), has_api_key: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

function normalizeTemplateSourceMap(
  value: unknown,
): Record<string, PaymentTemplateValueSource> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([key, source]) =>
        /^\d+$/.test(key) &&
        typeof source === 'string' &&
        PAYMENT_TEMPLATE_VALUE_SOURCES.has(source as PaymentTemplateValueSource),
    ),
  ) as Record<string, PaymentTemplateValueSource>;
}
