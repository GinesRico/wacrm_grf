import { requireApiKey } from '@/lib/auth/api-context';
import { fail, ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { getAutomationWithSteps } from '@/lib/api/v1/automations';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'automations:read');
    const { id } = await params;
    const automation = await getAutomationWithSteps(ctx.accountId, id);

    if (!automation) {
      return fail('not_found', 'Automation not found', 404);
    }

    return ok(automation);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
