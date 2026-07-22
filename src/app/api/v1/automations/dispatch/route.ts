import { requireApiKey } from '@/lib/auth/api-context';
import { fail, ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import type { AutomationTriggerType } from '@/types';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'automations:write');
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;

    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const triggerType =
      typeof body.trigger_type === 'string' ? body.trigger_type.trim() : '';
    if (!triggerType) {
      return fail('bad_request', "'trigger_type' is required", 400);
    }

    const contactId =
      typeof body.contact_id === 'string' && body.contact_id.trim()
        ? body.contact_id.trim()
        : null;
    const context =
      body.context && typeof body.context === 'object' && !Array.isArray(body.context)
        ? (body.context as Record<string, unknown>)
        : {};

    await runAutomationsForTrigger({
      accountId: ctx.accountId,
      triggerType: triggerType as AutomationTriggerType,
      contactId,
      context,
    });

    return ok({
      dispatched: true,
      trigger_type: triggerType,
      contact_id: contactId,
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
