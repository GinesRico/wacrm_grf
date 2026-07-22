import { requireApiKey } from '@/lib/auth/api-context';
import { okList, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, buildPage } from '@/lib/api/v1/pagination';
import { listAutomations } from '@/lib/api/v1/automations';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'automations:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const isActiveParam = url.searchParams.get('is_active');
    const isActive =
      isActiveParam === null
        ? null
        : isActiveParam === 'true'
          ? true
          : isActiveParam === 'false'
            ? false
            : null;

    const { items, nextCursor } = buildPage(
      await listAutomations({
        accountId: ctx.accountId,
        limit: limit + 1,
        cursor,
        triggerType: url.searchParams.get('trigger_type'),
        isActive,
      }),
      limit,
    );

    return okList(items, nextCursor);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
