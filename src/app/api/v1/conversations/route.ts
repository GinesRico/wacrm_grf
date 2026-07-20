import { requireApiKey } from '@/lib/auth/api-context';
import { okList, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, buildPage } from '@/lib/api/v1/pagination';
import { listConversations } from '@/lib/api/v1/conversations';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);

    const { items, nextCursor } = buildPage(
      await listConversations({
        accountId: ctx.accountId,
        limit: limit + 1,
        cursor,
        status: url.searchParams.get('status'),
        contactId: url.searchParams.get('contact_id'),
      }),
      limit,
    );

    return okList(items, nextCursor);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
