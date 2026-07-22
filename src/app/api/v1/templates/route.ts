import { requireApiKey } from '@/lib/auth/api-context';
import { okList, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, buildPage } from '@/lib/api/v1/pagination';
import { listTemplates } from '@/lib/api/v1/templates';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'templates:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);

    const { items, nextCursor } = buildPage(
      await listTemplates({
        accountId: ctx.accountId,
        limit: limit + 1,
        cursor,
        status: url.searchParams.get('status'),
        category: url.searchParams.get('category'),
        language: url.searchParams.get('language'),
        name: url.searchParams.get('name'),
      }),
      limit,
    );

    return okList(items, nextCursor);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
