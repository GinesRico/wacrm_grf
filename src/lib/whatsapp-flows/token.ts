import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export interface MetaFlowTokenPayload {
  accountId: string;
  slug: string;
  nonce?: string;
  issuedAt?: number;
}

export function createMetaFlowToken(input: MetaFlowTokenPayload): string {
  const payload = {
    accountId: input.accountId,
    slug: input.slug,
    nonce: input.nonce || randomBytes(12).toString('hex'),
    issuedAt: input.issuedAt || Math.floor(Date.now() / 1000),
  };
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = sign(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function parseMetaFlowToken(token: string): MetaFlowTokenPayload | null {
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;
  const expected = sign(encodedPayload);
  if (!safeEqual(signature, expected)) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8')
    ) as Partial<MetaFlowTokenPayload>;
    if (!payload.accountId || !payload.slug) return null;
    return {
      accountId: payload.accountId,
      slug: payload.slug,
      nonce: payload.nonce,
      issuedAt: payload.issuedAt,
    };
  } catch {
    return null;
  }
}

function sign(value: string): string {
  return createHmac('sha256', getTokenSecret())
    .update(value)
    .digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function getTokenSecret(): string {
  const secret =
    process.env.WHATSAPP_FLOW_TOKEN_SECRET ||
    process.env.META_APP_SECRET ||
    process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'Set WHATSAPP_FLOW_TOKEN_SECRET or META_APP_SECRET before sending WhatsApp Flows.'
    );
  }
  return secret;
}
