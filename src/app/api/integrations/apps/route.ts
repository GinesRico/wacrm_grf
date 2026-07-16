import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { ARVERA_APPOINTMENTS_SLUG } from '@/lib/integrations/arvera-appointments';
import { ARVERA_PAYMENTS_SLUG } from '@/lib/integrations/arvera-payments';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data: apps, error: appsErr } = await ctx.supabase
      .from('integration_apps')
      .select('slug, name, category, description')
      .order('name');
    if (appsErr) {
      return NextResponse.json({ error: 'Failed to load apps' }, { status: 500 });
    }

    const { data: connections, error: connErr } = await ctx.supabase
      .from('integration_connections')
      .select('app_slug, enabled, status, last_error, config, updated_at')
      .eq('account_id', ctx.accountId);
    if (connErr) {
      return NextResponse.json({ error: 'Failed to load connections' }, { status: 500 });
    }

    const bySlug = new Map((connections ?? []).map((c) => [c.app_slug, c]));
    const rows = (apps ?? []).map((app) => ({
      ...app,
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
