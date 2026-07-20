import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import {
  fetchAvailabilitySlots,
  requireActiveArveraAppointmentsConnection,
} from '@/lib/integrations/arvera-appointments';

export async function GET(request: Request) {
  try {
    const ctx = await requireDbRole('agent');
    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get('startDate') || searchParams.get('date');
    const endDate = searchParams.get('endDate') || startDate;
    if (!startDate || !endDate) {
      return NextResponse.json({ error: 'startDate/date is required' }, { status: 400 });
    }

    const { config, apiToken } = await requireActiveArveraAppointmentsConnection(
      null,
      ctx.accountId,
    );
    const duracion = Number(searchParams.get('duracion') ?? config.duracion);
    const payload = await fetchAvailabilitySlots({
      config,
      apiToken,
      startDate,
      endDate,
      duracion,
      timezone: searchParams.get('timezone') || config.timezone,
    });

    return NextResponse.json(payload);
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === 'UnauthorizedError' || err.name === 'ForbiddenError')
    ) {
      return toErrorResponse(err);
    }
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
