import { appointmentsFlowHandler } from './appointments';
import type { MetaFlowHandler } from './types';

const handlers = new Map<string, MetaFlowHandler>([
  [appointmentsFlowHandler.slug, appointmentsFlowHandler],
]);

export function getMetaFlowHandler(slug: string): MetaFlowHandler | null {
  return handlers.get(slug) ?? null;
}

export function listMetaFlowHandlers(): MetaFlowHandler[] {
  return [...handlers.values()];
}
