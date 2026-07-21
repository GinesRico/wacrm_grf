import { integrationApps } from '@/db/schema';
import { ARVERA_APPOINTMENTS_SLUG } from './arvera-appointments';
import { ARVERA_PAYMENTS_SLUG } from './arvera-payments';

export const ARVERA_INTEGRATION_APP_DEFINITIONS = {
  [ARVERA_PAYMENTS_SLUG]: {
    slug: ARVERA_PAYMENTS_SLUG,
    name: 'Pagos Arvera',
    category: 'payments',
    description: 'Create Redsys payment links through the Arvera payments API.',
  },
  [ARVERA_APPOINTMENTS_SLUG]: {
    slug: ARVERA_APPOINTMENTS_SLUG,
    name: 'Citas Arvera',
    category: 'appointments',
    description:
      'Send appointment availability and receive appointment events.',
  },
} as const;

export type ArveraIntegrationAppSlug =
  keyof typeof ARVERA_INTEGRATION_APP_DEFINITIONS;

export async function ensureIntegrationApp(
  db: {
    insert: (table: typeof integrationApps) => {
      values: (value: typeof integrationApps.$inferInsert) => {
        onConflictDoNothing: () => Promise<unknown>;
      };
    };
  },
  slug: ArveraIntegrationAppSlug
) {
  await db
    .insert(integrationApps)
    .values(ARVERA_INTEGRATION_APP_DEFINITIONS[slug])
    .onConflictDoNothing();
}
