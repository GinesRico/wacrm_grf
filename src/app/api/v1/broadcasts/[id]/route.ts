import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { broadcasts } from "@/db/schema";
import { requireApiKey } from "@/lib/auth/api-context";
import { ok, fail, toApiErrorResponse } from "@/lib/api/v1/respond";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, "broadcasts:send");
    const { id } = await params;

    const [row] = await db
      .select()
      .from(broadcasts)
      .where(and(eq(broadcasts.id, id), eq(broadcasts.accountId, ctx.accountId)))
      .limit(1);

    if (!row) return fail("not_found", "Broadcast not found", 404);

    return ok({
      id: row.id,
      name: row.name,
      template_name: row.templateName,
      template_language: row.templateLanguage,
      status: row.status,
      total_recipients: row.totalRecipients,
      sent_count: row.sentCount,
      delivered_count: row.deliveredCount,
      read_count: row.readCount,
      replied_count: row.repliedCount,
      failed_count: row.failedCount,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
