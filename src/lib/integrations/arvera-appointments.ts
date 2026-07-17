import { randomBytes } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt, encrypt } from '@/lib/whatsapp/encryption';

export const ARVERA_APPOINTMENTS_SLUG = 'arvera-appointments';
export const ARVERA_APPOINTMENTS_DEFAULT_BASE_URL = 'https://citas.arvera.es';
export const ARVERA_APPOINTMENTS_DEFAULT_IFRAME_URL =
  'https://citas.arvera.es/index.html';
export const ARVERA_APPOINTMENTS_DEFAULT_PUBLIC_BOOKING_URL =
  'https://citas.arvera.es/reservas.html';
export const ARVERA_APPOINTMENTS_DEFAULT_MESSAGE = '{{mensaje}}';
export const ARVERA_APPOINTMENTS_DEFAULT_CTA_BUTTON_LABEL = 'Reservar cita';
export const ARVERA_APPOINTMENTS_DEFAULT_CTA_URL_TEMPLATE = '{{short_url}}';
export const ARVERA_APPOINTMENTS_DEFAULT_LIST_HEADER =
  'Citas disponibles para {{dates_short}}';
export const ARVERA_APPOINTMENTS_DEFAULT_LIST_BODY =
  'Haz click en el boton de abajo y selecciona una hora para agendar tu cita de {{service}}';
export const ARVERA_APPOINTMENTS_DEFAULT_LIST_FOOTER = 'Autorecambios Vera S.L';
export const ARVERA_APPOINTMENTS_DEFAULT_LIST_BUTTON_LABEL = 'Ver disponibles';
export const ARVERA_APPOINTMENTS_DEFAULT_LIST_SECTION_TITLE =
  '{{weekday_upper}} {{day}} DE {{month_upper}}';
export const ARVERA_APPOINTMENTS_DEFAULT_LIST_ROW_TITLE = '{{time}}';
export const ARVERA_APPOINTMENTS_DEFAULT_LIST_ROW_DESCRIPTION = '{{service}}';

export type AppointmentSendMode = 'booking_link' | 'interactive_list' | 'cta_url';

export interface ArveraAppointmentsConfig {
  base_url: string;
  iframe_url: string;
  public_booking_url: string;
  default_send_mode: AppointmentSendMode;
  default_days_ahead: number;
  duracion: number;
  timezone: string;
  default_service: string;
  default_message: string;
  cta_button_label: string;
  cta_url_template: string;
  list_header: string;
  list_body: string;
  list_footer: string;
  list_button_label: string;
  list_section_title: string;
  list_row_title: string;
  list_row_description: string;
}

export interface ArveraAppointmentsConnection {
  id: string;
  account_id: string;
  app_slug: string;
  enabled: boolean;
  encrypted_credentials: Record<string, string>;
  config: Partial<ArveraAppointmentsConfig>;
  status: string;
  last_error: string | null;
}

export interface AvailabilityMessageResponse {
  mensaje: string;
  slots?: string[];
  short_url?: string;
  fecha_texto?: string;
}

export interface AvailabilitySlot {
  fecha: string;
  hora_inicio: string;
  hora_fin: string;
  startTime: string;
  endTime: string;
}

export interface AvailabilityResponse {
  disponibles: AvailabilitySlot[];
}

export interface ArveraAppointmentRecord {
  Id?: string;
  Nombre?: string;
  Telefono?: string;
  Email?: string | null;
  Servicio?: string;
  startTime?: string;
  endTime?: string;
  Matricula?: string | null;
  Modelo?: string | null;
  Notas?: string | null;
  Estado?: string;
  Url_Cancelacion?: string | null;
  url_cancelacion_corta?: string | null;
  [key: string]: unknown;
}

export interface CreateAppointmentInput {
  Nombre: string;
  Telefono: string;
  Email?: string | null;
  Servicio: string;
  startTime: string;
  endTime: string;
  Matricula?: string | null;
  Modelo?: string | null;
  Notas?: string | null;
}

export function normalizeAppointmentsConfig(
  config: Partial<ArveraAppointmentsConfig> | null | undefined,
): ArveraAppointmentsConfig {
  return {
    base_url: trimTrailingSlash(config?.base_url || ARVERA_APPOINTMENTS_DEFAULT_BASE_URL),
    iframe_url: config?.iframe_url || ARVERA_APPOINTMENTS_DEFAULT_IFRAME_URL,
    public_booking_url:
      config?.public_booking_url || ARVERA_APPOINTMENTS_DEFAULT_PUBLIC_BOOKING_URL,
    default_send_mode:
      config?.default_send_mode === 'interactive_list' || config?.default_send_mode === 'cta_url'
        ? config.default_send_mode
        : 'booking_link',
    default_days_ahead: normalizePositiveInteger(config?.default_days_ahead, 1),
    duracion: normalizePositiveInteger(config?.duracion, 45),
    timezone: config?.timezone || 'Europe/Madrid',
    default_service: config?.default_service || 'Cita taller',
    default_message: config?.default_message || ARVERA_APPOINTMENTS_DEFAULT_MESSAGE,
    cta_button_label:
      config?.cta_button_label || ARVERA_APPOINTMENTS_DEFAULT_CTA_BUTTON_LABEL,
    cta_url_template:
      config?.cta_url_template || ARVERA_APPOINTMENTS_DEFAULT_CTA_URL_TEMPLATE,
    list_header:
      config?.list_header || ARVERA_APPOINTMENTS_DEFAULT_LIST_HEADER,
    list_body:
      config?.list_body || ARVERA_APPOINTMENTS_DEFAULT_LIST_BODY,
    list_footer:
      config?.list_footer || ARVERA_APPOINTMENTS_DEFAULT_LIST_FOOTER,
    list_button_label:
      config?.list_button_label || ARVERA_APPOINTMENTS_DEFAULT_LIST_BUTTON_LABEL,
    list_section_title:
      config?.list_section_title || ARVERA_APPOINTMENTS_DEFAULT_LIST_SECTION_TITLE,
    list_row_title:
      config?.list_row_title || ARVERA_APPOINTMENTS_DEFAULT_LIST_ROW_TITLE,
    list_row_description:
      config?.list_row_description || ARVERA_APPOINTMENTS_DEFAULT_LIST_ROW_DESCRIPTION,
  };
}

export function encryptAppointmentsApiToken(apiToken: string): Record<string, string> {
  return { api_token: encrypt(apiToken) };
}

export function encryptWebhookToken(token: string): string {
  return encrypt(token);
}

export function generateWebhookToken(): string {
  return randomBytes(24).toString('hex');
}

export function resolveAppointmentsApiToken(
  connection?: ArveraAppointmentsConnection | null,
): string | null {
  const encrypted = connection?.encrypted_credentials?.api_token;
  if (encrypted) return decrypt(encrypted);
  return process.env.ARVERA_APPOINTMENTS_API_TOKEN || null;
}

export function resolveAppointmentsWebhookToken(
  connection?: ArveraAppointmentsConnection | null,
): string | null {
  const encrypted = connection?.encrypted_credentials?.webhook_token;
  if (encrypted) return decrypt(encrypted);
  return null;
}

export async function getArveraAppointmentsConnection(
  db: SupabaseClient,
  accountId: string,
): Promise<ArveraAppointmentsConnection | null> {
  const { data, error } = await db
    .from('integration_connections')
    .select('*')
    .eq('account_id', accountId)
    .eq('app_slug', ARVERA_APPOINTMENTS_SLUG)
    .maybeSingle();

  if (error) throw new Error(`Could not load Arvera appointments connection: ${error.message}`);
  return (data as ArveraAppointmentsConnection | null) ?? null;
}

export async function requireActiveArveraAppointmentsConnection(
  db: SupabaseClient,
  accountId: string,
): Promise<{
  connection: ArveraAppointmentsConnection;
  config: ArveraAppointmentsConfig;
  apiToken: string;
}> {
  const connection = await getArveraAppointmentsConnection(db, accountId);
  const config = normalizeAppointmentsConfig(connection?.config);
  const apiToken = resolveAppointmentsApiToken(connection);
  if (!connection?.enabled || !apiToken) {
    throw new Error('Citas Arvera is not configured for this account');
  }
  return { connection, config, apiToken };
}

export async function fetchAvailabilityMessage(args: {
  config: ArveraAppointmentsConfig;
  date: string;
  fetchImpl?: typeof fetch;
}): Promise<AvailabilityMessageResponse> {
  const fetcher = args.fetchImpl ?? fetch;
  const url = new URL(`${args.config.base_url}/api/whatsapp/mensaje`);
  url.searchParams.set('date', args.date);
  const res = await fetcher(url.toString(), { method: 'GET', signal: AbortSignal.timeout(10_000) });
  const payload = (await res.json().catch(() => ({}))) as AvailabilityMessageResponse & {
    detail?: string;
  };
  if (!res.ok || typeof payload.mensaje !== 'string') {
    throw new Error(payload.detail || `Citas returned HTTP ${res.status}`);
  }
  return payload;
}

export async function fetchAvailabilitySlots(args: {
  config: ArveraAppointmentsConfig;
  apiToken?: string | null;
  startDate: string;
  endDate: string;
  duracion?: number;
  timezone?: string;
  fetchImpl?: typeof fetch;
}): Promise<AvailabilityResponse> {
  const fetcher = args.fetchImpl ?? fetch;
  const url = new URL(`${args.config.base_url}/api/disponibles`);
  url.searchParams.set('startDate', args.startDate);
  url.searchParams.set('endDate', args.endDate);
  url.searchParams.set('duracion', String(args.duracion ?? args.config.duracion));
  url.searchParams.set('timezone', args.timezone ?? args.config.timezone);
  const res = await fetcher(url.toString(), {
    method: 'GET',
    headers: args.apiToken ? { 'x-api-key': args.apiToken } : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await res.json().catch(() => ({}))) as AvailabilityResponse & {
    detail?: string;
  };
  if (!res.ok || !Array.isArray(payload.disponibles)) {
    throw new Error(payload.detail || `Citas returned HTTP ${res.status}`);
  }
  return payload;
}

export async function listAppointments(args: {
  config: ArveraAppointmentsConfig;
  apiToken: string;
  startDate?: string;
  endDate?: string;
  estado?: string;
  fetchImpl?: typeof fetch;
}): Promise<ArveraAppointmentRecord[]> {
  const fetcher = args.fetchImpl ?? fetch;
  const url = new URL(`${args.config.base_url}/api/citas`);
  if (args.startDate) url.searchParams.set('startDate', args.startDate);
  if (args.endDate) url.searchParams.set('endDate', args.endDate);
  if (args.estado) url.searchParams.set('estado', args.estado);
  const res = await fetcher(url.toString(), {
    method: 'GET',
    headers: { 'x-api-key': args.apiToken },
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await res.json().catch(() => ({}))) as ArveraAppointmentRecord[] | {
    detail?: string;
  };
  if (!res.ok || !Array.isArray(payload)) {
    throw new Error(!Array.isArray(payload) && payload.detail ? payload.detail : `Citas returned HTTP ${res.status}`);
  }
  return payload;
}

export async function createAppointment(args: {
  config: ArveraAppointmentsConfig;
  apiToken: string;
  input: CreateAppointmentInput;
  fetchImpl?: typeof fetch;
}): Promise<ArveraAppointmentRecord> {
  const fetcher = args.fetchImpl ?? fetch;
  const res = await fetcher(`${args.config.base_url}/api/citas`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': args.apiToken,
    },
    body: JSON.stringify(args.input),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await res.json().catch(() => ({}))) as ArveraAppointmentRecord & {
    detail?: string;
  };
  if (!res.ok || !payload.Id) {
    throw new Error(payload.detail || `Citas returned HTTP ${res.status}`);
  }
  return payload;
}

export function renderAppointmentsMessage(
  template: string,
  values: {
    mensaje: string;
    short_url: string;
    fecha_texto: string;
    service: string;
    slots?: string;
  },
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = values[String(key) as keyof typeof values];
    return value ?? '';
  });
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
