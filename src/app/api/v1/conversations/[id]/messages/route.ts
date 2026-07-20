import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, buildPage } from '@/lib/api/v1/pagination';
import {
  conversationExists,
  listConversationMessages,
} from '@/lib/api/v1/conversations';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'messages:read');
    const { id } = await params;
    const { limit, cursor } = parseListParams(request);

    if (!(await conversationExists(ctx.accountId, id))) {
      return fail('not_found', 'Conversation not found', 404);
    }

    const { items, nextCursor } = buildPage(
      await listConversationMessages({
        accountId: ctx.accountId,
        conversationId: id,
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
