import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { integrationApps, integrationConnections } from '@/db/schema';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { ARVERA_APPOINTMENTS_SLUG } from '@/lib/integrations/arvera-appointments';
import { ARVERA_PAYMENTS_SLUG } from '@/lib/integrations/arvera-payments';

function serializeConnection(row: typeof integrationConnections.$inferSelect) {
  return {
    app_slug: row.appSlug,
    enabled: row.enabled,
    status: row.status,
    last_error: row.lastError,
    config: row.config,
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const [apps, connections] = await Promise.all([
      db
        .select()
        .from(integrationApps)
        .orderBy(asc(integrationApps.name)),
      db
        .select()
        .from(integrationConnections)
        .where(eq(integrationConnections.accountId, ctx.accountId)),
    ]);

    const bySlug = new Map(
      connections.map((connection) => [
        connection.appSlug,
        serializeConnection(connection),
      ]),
    );
    const rows: Record<string, unknown>[] = apps.map((app) => ({
      slug: app.slug,
      name: app.name,
      category: app.category,
      description: app.description,
      connection: bySlug.get(app.slug) ?? null,
    }));

    if (!rows.some((app) => app.slug === ARVERA_PAYMENTS_SLUG)) {
      rows.push({
        slug: ARVERA_PAYMENTS_SLUG,
        name: 'Pagos Arvera',
        category: 'payments',
        description: 'Create Redsys payment links through the Arvera payments API.',
        connection: bySlug.get(ARVERA_PAYMENTS_SLUG) ?? null,
      });
    }
    if (!rows.some((app) => app.slug === ARVERA_APPOINTMENTS_SLUG)) {
      rows.push({
        slug: ARVERA_APPOINTMENTS_SLUG,
        name: 'Citas Arvera',
        category: 'appointments',
        description: 'Send appointment availability and receive appointment events.',
        connection: bySlug.get(ARVERA_APPOINTMENTS_SLUG) ?? null,
      });
    }

    return NextResponse.json({ apps: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}
