import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaymentTemplateValueSource } from './payment-template-params';

export {
  buildPaymentTemplateParams,
  extractPaymentUrlToken,
  formatEuroAmount,
  resolvePaymentTemplateValue,
  type PaymentTemplateValueInput,
  type PaymentTemplateValueSource,
} from './payment-template-params';

export const ARVERA_PAYMENTS_SLUG = 'arvera-payments';
export const ARVERA_DEFAULT_BASE_URL = 'https://pagos.arvera.es/api';
export const ARVERA_DEFAULT_MESSAGE =
  'Aqui tienes tu enlace de pago: {{payment_url}}';
export const ARVERA_DEFAULT_CTA_MESSAGE = 'Aqui tienes tu enlace de pago.';
export const ARVERA_DEFAULT_CTA_BUTTON_LABEL = 'Pagar ahora';
export const ARVERA_DEFAULT_CTA_URL_TEMPLATE = '{{payment_url}}';

export type PaymentStatus =
  | 'pending'
  | 'paid'
  | 'failed'
  | 'expired'
  | 'cancelled';

export interface ArveraConnectionConfig {
  base_url: string;
  auth_header: 'authorization_bearer' | 'x_api_key';
  default_message: string;
  delivery_mode: 'text' | 'template' | 'cta_url';
  cta_button_label: string;
  cta_url_template: string;
  template_name?: string;
  template_language?: string;
  template_body_params?: Record<string, PaymentTemplateValueSource>;
  template_button_params?: Record<string, PaymentTemplateValueSource>;
}

export interface ArveraConnection {
  id: string;
  account_id: string;
  app_slug: string;
  enabled: boolean;
  encrypted_credentials: Record<string, string>;
  config: Partial<ArveraConnectionConfig>;
  status: string;
  last_error: string | null;
}

export interface CreatePaymentLinkInput {
  amountCents: number;
  concept: string;
  email?: string | null;
  phone?: string | null;
}

export interface ArveraPaymentDocument {
  id?: string;
  order_id?: string;
  orderId?: string;
  amount?: number;
  concept?: string;
  payment_url?: string;
  status?: PaymentStatus | string;
  email?: string;
  phone?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ArveraPaymentResponse {
  success?: boolean;
  payment_url?: string;
  order_id?: string;
  orderId?: string;
  error?: string;
  document?: ArveraPaymentDocument;
}

export function amountEurToCents(value: number): number {
  return Math.round(value * 100);
}

export function normalizeAmountCents(input: {
  amount_eur?: unknown;
  amount_cents?: unknown;
}): number | null {
  if (input.amount_cents !== undefined) {
    const cents = Number(input.amount_cents);
    return Number.isInteger(cents) && cents > 0 ? cents : null;
  }
  if (input.amount_eur !== undefined) {
    const eur = Number(input.amount_eur);
    if (!Number.isFinite(eur) || eur <= 0) return null;
    return amountEurToCents(eur);
  }
  return null;
}

export function normalizeConfig(
  config: Partial<ArveraConnectionConfig> | null | undefined,
): ArveraConnectionConfig {
  const deliveryMode =
    config?.delivery_mode === 'template' || config?.delivery_mode === 'cta_url'
      ? config.delivery_mode
      : 'text';
  return {
    base_url: trimTrailingSlash(config?.base_url || ARVERA_DEFAULT_BASE_URL),
    auth_header: config?.auth_header || 'authorization_bearer',
    default_message: config?.default_message || ARVERA_DEFAULT_MESSAGE,
    delivery_mode: deliveryMode,
    cta_button_label: config?.cta_button_label || ARVERA_DEFAULT_CTA_BUTTON_LABEL,
    cta_url_template: config?.cta_url_template || ARVERA_DEFAULT_CTA_URL_TEMPLATE,
    template_name: config?.template_name || undefined,
    template_language: config?.template_language || undefined,
    template_body_params: config?.template_body_params ?? {},
    template_button_params: config?.template_button_params ?? {},
  };
}

export function encryptApiKey(apiKey: string): Record<string, string> {
  return { api_key: encrypt(apiKey) };
}

export function resolveApiKey(connection?: ArveraConnection | null): string | null {
  const encrypted = connection?.encrypted_credentials?.api_key;
  if (encrypted) return decrypt(encrypted);
  return process.env.PAYMENT_LINKS_API_KEY || null;
}

export async function getArveraConnection(
  db: SupabaseClient,
  accountId: string,
): Promise<ArveraConnection | null> {
  const { data, error } = await db
    .from('integration_connections')
    .select('*')
    .eq('account_id', accountId)
    .eq('app_slug', ARVERA_PAYMENTS_SLUG)
    .maybeSingle();

  if (error) throw new Error(`Could not load Arvera connection: ${error.message}`);
  return (data as ArveraConnection | null) ?? null;
}

export async function requireActiveArveraConnection(
  db: SupabaseClient,
  accountId: string,
): Promise<{ connection: ArveraConnection; config: ArveraConnectionConfig; apiKey: string }> {
  const connection = await getArveraConnection(db, accountId);
  const config = normalizeConfig(connection?.config);
  const apiKey = resolveApiKey(connection);
  if (!connection?.enabled || !apiKey) {
    throw new Error('Pagos Arvera is not configured for this account');
  }
  return { connection, config, apiKey };
}

export async function createArveraPaymentLink(args: {
  config: ArveraConnectionConfig;
  apiKey: string;
  input: CreatePaymentLinkInput;
  fetchImpl?: typeof fetch;
}): Promise<ArveraPaymentResponse> {
  const fetcher = args.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (args.config.auth_header === 'x_api_key') {
    headers['x-api-key'] = args.apiKey;
  } else {
    headers.Authorization = `Bearer ${args.apiKey}`;
  }

  const res = await fetcher(`${args.config.base_url}/external/payment-links`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      amount_cents: args.input.amountCents,
      concept: args.input.concept,
      email: args.input.email || undefined,
      phone: args.input.phone || undefined,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = (await res.json().catch(() => ({}))) as ArveraPaymentResponse;
  if (!res.ok || payload.success === false) {
    throw new Error(payload.error || `Arvera returned HTTP ${res.status}`);
  }
  if (!payload.payment_url && !payload.document?.payment_url) {
    throw new Error('Arvera did not return a payment URL');
  }
  if (!payload.order_id && !payload.orderId && !payload.document?.order_id) {
    throw new Error('Arvera did not return an order id');
  }
  return payload;
}

export async function fetchArveraPaymentStatus(args: {
  config: ArveraConnectionConfig;
  orderId: string;
  fetchImpl?: typeof fetch;
}): Promise<ArveraPaymentDocument | null> {
  const fetcher = args.fetchImpl ?? fetch;
  const res = await fetcher(
    `${args.config.base_url}/payment-links/${encodeURIComponent(args.orderId)}`,
    { method: 'GET', signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) return null;
  const payload = (await res.json().catch(() => ({}))) as {
    document?: ArveraPaymentDocument;
  };
  return payload.document ?? null;
}

export function responseToPaymentRecord(payload: ArveraPaymentResponse): {
  orderId: string;
  paymentUrl: string;
  status: PaymentStatus;
} {
  const orderId =
    payload.order_id || payload.orderId || payload.document?.order_id || payload.document?.orderId;
  const paymentUrl = payload.payment_url || payload.document?.payment_url;
  if (!orderId || !paymentUrl) {
    throw new Error('Arvera response is missing order id or payment URL');
  }
  return {
    orderId,
    paymentUrl,
    status: normalizePaymentStatus(payload.document?.status),
  };
}

export function normalizePaymentStatus(status: unknown): PaymentStatus {
  if (
    status === 'paid' ||
    status === 'failed' ||
    status === 'expired' ||
    status === 'cancelled'
  ) {
    return status;
  }
  return 'pending';
}

export function renderPaymentMessage(template: string, values: {
  payment_url: string;
  amount_eur: string;
  concept: string;
  order_id: string;
}): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = values[String(key) as keyof typeof values];
    return value ?? '';
  });
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
