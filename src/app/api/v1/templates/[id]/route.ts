import { requireApiKey } from '@/lib/auth/api-context';
import { fail, ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { getTemplate } from '@/lib/api/v1/templates';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'templates:read');
    const { id } = await params;
    const template = await getTemplate(ctx.accountId, id);

    if (!template) {
      return fail('not_found', 'Template not found', 404);
    }

    return ok(template);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
