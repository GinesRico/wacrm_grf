import { describe, expect, it, vi } from 'vitest';

import {
  createAppointment,
  buildAppointmentsEmbedUrl,
  fetchAppointmentsEmbedToken,
  fetchAvailabilityMessage,
  fetchAvailabilitySlots,
  listAppointments,
  normalizeAppointmentsConfig,
} from './arvera-appointments';

describe('arvera appointments connector', () => {
  it('normalizes config defaults', () => {
    expect(normalizeAppointmentsConfig({})).toMatchObject({
      base_url: 'https://citas.arvera.es',
      iframe_url: 'https://partes.arvera.es/embed/calendario',
      public_booking_url: 'https://citas.arvera.es/reservas.html',
      default_send_mode: 'booking_link',
      duracion: 45,
      timezone: 'Europe/Madrid',
    });
  });

  it('fetches WhatsApp availability message', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        mensaje: 'Citas disponibles',
        slots: ['08:30'],
        short_url: 'https://citas.arvera.es/r/abc',
      }),
    ) as unknown as typeof fetch;

    const payload = await fetchAvailabilityMessage({
      config: normalizeAppointmentsConfig({}),
      date: '2026-07-20',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://citas.arvera.es/api/whatsapp/mensaje?date=2026-07-20',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(payload.short_url).toBe('https://citas.arvera.es/r/abc');
  });

  it('fetches slots with x-api-key when provided', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        disponibles: [
          {
            fecha: '2026-07-20',
            hora_inicio: '08:30',
            hora_fin: '09:15',
            startTime: '2026-07-20T08:30:00+02:00',
            endTime: '2026-07-20T09:15:00+02:00',
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const payload = await fetchAvailabilitySlots({
      config: normalizeAppointmentsConfig({}),
      apiToken: 'token',
      startDate: '2026-07-20',
      endDate: '2026-07-20',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/api/disponibles?'),
      expect.objectContaining({
        headers: { 'x-api-key': 'token' },
      }),
    );
    expect(payload.disponibles).toHaveLength(1);
  });

  it('fetches an embed token without exposing the API key to the browser', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        embed_token: 'embed-token',
        expires_in: 3600,
        mode: 'calendario',
      }),
    ) as unknown as typeof fetch;

    const payload = await fetchAppointmentsEmbedToken({
      config: normalizeAppointmentsConfig({}),
      apiToken: 'token',
      mode: 'calendario',
      origin: 'https://chat.arvera.es',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://citas.arvera.es/api/embed-token',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'token',
        },
        body: JSON.stringify({
          mode: 'calendario',
          origin: 'https://chat.arvera.es',
        }),
      }),
    );
    expect(payload.embed_token).toBe('embed-token');
  });

  it('builds the documented embed iframe URL', () => {
    expect(
      buildAppointmentsEmbedUrl({
        config: normalizeAppointmentsConfig({}),
        mode: 'calendario',
        embedToken: 'token value',
      }),
    ).toBe(
      'https://partes.arvera.es/embed/calendario?embed_token=token+value&v=embed-20260820',
    );
    expect(
      buildAppointmentsEmbedUrl({
        config: normalizeAppointmentsConfig({
          iframe_url: 'https://citas.arvera.es/index.html',
        }),
        mode: 'disponibles',
        embedToken: 'token',
      }),
    ).toBe(
      'https://partes.arvera.es/embed/disponibles?embed_token=token&v=embed-20260820',
    );
  });

  it('lists and creates appointments with x-api-key', async () => {
    const config = normalizeAppointmentsConfig({});
    const listFetch = vi.fn(async () =>
      Response.json([{ Id: 'cita_1', Nombre: 'Juan' }]),
    ) as unknown as typeof fetch;
    const createFetch = vi.fn(async () =>
      Response.json({ Id: 'cita_2', Nombre: 'Ana' }, { status: 201 }),
    ) as unknown as typeof fetch;

    await expect(
      listAppointments({ config, apiToken: 'token', fetchImpl: listFetch }),
    ).resolves.toHaveLength(1);
    await expect(
      createAppointment({
        config,
        apiToken: 'token',
        input: {
          Nombre: 'Ana',
          Telefono: '600123123',
          Servicio: 'Cita',
          startTime: '2026-07-20T08:30:00+02:00',
          endTime: '2026-07-20T09:15:00+02:00',
        },
        fetchImpl: createFetch,
      }),
    ).resolves.toMatchObject({ Id: 'cita_2' });
  });

  it('surfaces API errors', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ detail: 'Unauthorized' }, { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(
      fetchAvailabilityMessage({
        config: normalizeAppointmentsConfig({}),
        date: '2026-07-20',
        fetchImpl,
      }),
    ).rejects.toThrow('Unauthorized');
  });
});
