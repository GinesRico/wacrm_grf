import { requireApiKey } from '@/lib/auth/api-context';
import { fail, okList, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, buildPage } from '@/lib/api/v1/pagination';
import {
  getAutomationWithSteps,
  listAutomationLogs,
} from '@/lib/api/v1/automations';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'automations:read');
    const { id } = await params;
    const { limit, cursor } = parseListParams(request);

    if (!(await getAutomationWithSteps(ctx.accountId, id))) {
      return fail('not_found', 'Automation not found', 404);
    }

    const { items, nextCursor } = buildPage(
      await listAutomationLogs({
        accountId: ctx.accountId,
        automationId: id,
        limit: limit + 1,
        cursor,
      }),
      limit,
    );

    return okList(items, nextCursor);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
