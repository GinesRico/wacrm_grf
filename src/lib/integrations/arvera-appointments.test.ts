import { describe, expect, it, vi } from 'vitest';

import {
  createAppointment,
  fetchAvailabilityMessage,
  fetchAvailabilitySlots,
  listAppointments,
  normalizeAppointmentsConfig,
} from './arvera-appointments';

describe('arvera appointments connector', () => {
  it('normalizes config defaults', () => {
    expect(normalizeAppointmentsConfig({})).toMatchObject({
      base_url: 'https://citas.arvera.es',
      iframe_url: 'https://citas.arvera.es/index.html',
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
