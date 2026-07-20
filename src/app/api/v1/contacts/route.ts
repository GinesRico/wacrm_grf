import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, buildPage } from '@/lib/api/v1/pagination';
import {
  listContacts,
  findOrCreateContact,
  setContactTags,
  getContactById,
  resolveAuditUserId,
  ContactError,
} from '@/lib/api/v1/contacts';

function sanitizeSearch(raw: string): string {
  return raw.replace(/[^\p{L}\p{N} +@.\-_]/gu, '').trim();
}

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const search = sanitizeSearch(url.searchParams.get('search') ?? '');
    const tag = url.searchParams.get('tag');

    const { items, nextCursor } = buildPage(
      await listContacts({
        accountId: ctx.accountId,
        limit: limit + 1,
        cursor,
        search,
        tagId: tag,
      }),
      limit,
    );

    return okList(items, nextCursor);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    if (!phone) return fail('bad_request', "'phone' is required", 400);

    const auditUserId = await resolveAuditUserId(ctx.accountId);
    const { id, created } = await findOrCreateContact(ctx.accountId, auditUserId, {
      phone,
      name: typeof body.name === 'string' ? body.name : undefined,
      email: typeof body.email === 'string' ? body.email : undefined,
      company: typeof body.company === 'string' ? body.company : undefined,
    });

    if (Array.isArray(body.tags)) {
      await setContactTags(
        ctx.accountId,
        auditUserId,
        id,
        body.tags.filter((tag): tag is string => typeof tag === 'string'),
      );
    }

    const contact = await getContactById(ctx.accountId, id);
    return ok(contact, created ? 201 : 200);
  } catch (err) {
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status,
      );
    }
    return toApiErrorResponse(err);
  }
}
