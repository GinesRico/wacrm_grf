import { describe, expect, it, vi } from 'vitest';

import {
  amountEurToCents,
  buildPaymentTemplateParams,
  createArveraPaymentLink,
  extractPaymentUrlToken,
  normalizeAmountCents,
  responseToPaymentRecord,
} from './arvera-payments';

describe('arvera payments connector', () => {
  it('normalizes euros to cents', () => {
    expect(amountEurToCents(121)).toBe(12100);
    expect(amountEurToCents(10.99)).toBe(1099);
    expect(normalizeAmountCents({ amount_eur: 12.34 })).toBe(1234);
    expect(normalizeAmountCents({ amount_cents: 1234 })).toBe(1234);
    expect(normalizeAmountCents({ amount_cents: 0 })).toBeNull();
  });

  it('creates payment links with bearer auth', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        success: true,
        payment_url: 'https://sis.redsys.es/pay',
        order_id: '1234567890',
        document: { status: 'pending' },
      }),
    ) as unknown as typeof fetch;

    const payload = await createArveraPaymentLink({
      config: {
        base_url: 'https://pagos.arvera.es/api',
        auth_header: 'authorization_bearer',
        default_message: '',
        delivery_mode: 'text',
        cta_button_label: 'Pagar ahora',
        cta_url_template: '{{payment_url}}',
      },
      apiKey: 'secret',
      input: { amountCents: 12100, concept: 'Factura 1074' },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://pagos.arvera.es/api/external/payment-links',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      }),
    );
    expect(responseToPaymentRecord(payload)).toEqual({
      orderId: '1234567890',
      paymentUrl: 'https://sis.redsys.es/pay',
      status: 'pending',
    });
  });

  it('surfaces Arvera errors', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(
      createArveraPaymentLink({
        config: {
          base_url: 'https://pagos.arvera.es/api',
          auth_header: 'authorization_bearer',
          default_message: '',
          delivery_mode: 'text',
          cta_button_label: 'Pagar ahora',
          cta_url_template: '{{payment_url}}',
        },
        apiKey: 'bad',
        input: { amountCents: 100, concept: 'Test' },
        fetchImpl,
      }),
    ).rejects.toThrow('Unauthorized');
  });

  it('builds Meta template params from configured payment fields', () => {
    expect(
      extractPaymentUrlToken(
        'https://sis.redsys.es/sis/p2f?t=18D07D3A8B249893844442DC6C1207A1F092B547',
      ),
    ).toBe('18D07D3A8B249893844442DC6C1207A1F092B547');

    expect(
      buildPaymentTemplateParams(
        {
          template_body_params: {
            '1': 'order_id',
            '2': 'amount_eur',
          },
          template_button_params: {
            '0': 'payment_url_token',
          },
        },
        {
          payment_url:
            'https://sis.redsys.es/sis/p2f?t=18D07D3A8B249893844442DC6C1207A1F092B547',
          order_id: '2025111000345714',
          amount_cents: 1125,
          concept: 'Pedido 2025111000345714',
        },
      ),
    ).toEqual({
      body: ['2025111000345714', '11,25 €'],
      buttonParams: { 0: '18D07D3A8B249893844442DC6C1207A1F092B547' },
    });
  });
});
