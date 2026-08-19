import { afterEach, describe, expect, it } from 'vitest';
import { createMetaFlowToken, parseMetaFlowToken } from './token';

describe('meta flow token', () => {
  const originalSecret = process.env.WHATSAPP_FLOW_TOKEN_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.WHATSAPP_FLOW_TOKEN_SECRET;
    } else {
      process.env.WHATSAPP_FLOW_TOKEN_SECRET = originalSecret;
    }
  });

  it('round-trips signed account and slug metadata', () => {
    process.env.WHATSAPP_FLOW_TOKEN_SECRET = 'test-secret';
    const token = createMetaFlowToken({
      accountId: 'account-1',
      slug: 'citas',
      nonce: 'nonce-1',
      issuedAt: 1_788_000_000,
    });

    expect(parseMetaFlowToken(token)).toEqual({
      accountId: 'account-1',
      slug: 'citas',
      nonce: 'nonce-1',
      issuedAt: 1_788_000_000,
    });
  });

  it('rejects tampered tokens', () => {
    process.env.WHATSAPP_FLOW_TOKEN_SECRET = 'test-secret';
    const token = createMetaFlowToken({
      accountId: 'account-1',
      slug: 'citas',
    });
    const [payload, signature] = token.split('.');
    const tampered = `${payload.slice(0, -1)}x.${signature}`;

    expect(parseMetaFlowToken(tampered)).toBeNull();
  });
});
