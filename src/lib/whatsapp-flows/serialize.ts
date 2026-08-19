import { whatsappMetaFlows } from '@/db/schema';

export function serializeWhatsappMetaFlow(
  row: typeof whatsappMetaFlows.$inferSelect
) {
  return {
    id: row.id,
    account_id: row.accountId,
    slug: row.slug,
    flow_id: row.flowId,
    title: row.title,
    body_text: row.bodyText,
    footer_text: row.footerText,
    button_text: row.buttonText,
    initial_screen: row.initialScreen,
    active: row.active,
    config: row.config,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
