export type PaymentTemplateValueSource =
  | 'payment_url'
  | 'payment_url_token'
  | 'order_id'
  | 'amount_eur'
  | 'amount_eur_number'
  | 'amount_cents'
  | 'concept'
  | 'email'
  | 'phone';

export interface PaymentTemplateValueInput {
  payment_url: string;
  order_id: string;
  amount_cents: number;
  concept: string;
  email?: string | null;
  phone?: string | null;
}

export interface PaymentTemplateParamConfig {
  template_body_params?: Record<string, PaymentTemplateValueSource>;
  template_button_params?: Record<string, PaymentTemplateValueSource>;
}

export function extractPaymentUrlToken(paymentUrl: string): string {
  try {
    const url = new URL(paymentUrl);
    const token = url.searchParams.get('t');
    if (token) return token;
  } catch {
    // Fall through to string parsing for non-standard URLs.
  }
  const marker = 't=';
  const markerIndex = paymentUrl.indexOf(marker);
  if (markerIndex >= 0) {
    return paymentUrl.slice(markerIndex + marker.length).split('&')[0] ?? '';
  }
  return paymentUrl.split('/').filter(Boolean).at(-1) ?? paymentUrl;
}

export function formatEuroAmount(amountCents: number): string {
  return `${(amountCents / 100).toFixed(2).replace('.', ',')} €`;
}

export function formatEuroNumber(amountCents: number): string {
  return (amountCents / 100).toFixed(2).replace('.', ',');
}

export function resolvePaymentTemplateValue(
  source: PaymentTemplateValueSource | undefined,
  values: PaymentTemplateValueInput,
): string {
  switch (source) {
    case 'payment_url':
      return values.payment_url;
    case 'payment_url_token':
      return extractPaymentUrlToken(values.payment_url);
    case 'order_id':
      return values.order_id;
    case 'amount_eur':
      return formatEuroAmount(values.amount_cents);
    case 'amount_eur_number':
      return formatEuroNumber(values.amount_cents);
    case 'amount_cents':
      return String(values.amount_cents);
    case 'concept':
      return values.concept;
    case 'email':
      return values.email ?? '';
    case 'phone':
      return values.phone ?? '';
    default:
      return '';
  }
}

export function buildPaymentTemplateParams(
  config: PaymentTemplateParamConfig,
  values: PaymentTemplateValueInput,
): { body: string[]; buttonParams: Record<number, string> } {
  const bodyMap = config.template_body_params ?? {};
  const maxBodyIndex = Math.max(0, ...Object.keys(bodyMap).map((key) => Number(key)));
  const body = Array.from({ length: maxBodyIndex }, (_, index) =>
    resolvePaymentTemplateValue(bodyMap[String(index + 1)], values),
  );

  const buttonParams = Object.fromEntries(
    Object.entries(config.template_button_params ?? {}).map(([index, source]) => [
      Number(index),
      resolvePaymentTemplateValue(source, values),
    ]),
  );

  return { body, buttonParams };
}
