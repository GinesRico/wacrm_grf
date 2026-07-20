import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { broadcasts } from "@/db/schema";
import { getCurrentDbAccount, requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { serializeBroadcast } from "@/lib/broadcasts/serialize";

function normalizeDraft(body: Record<string, unknown>) {
  return {
    name: typeof body.name === "string" ? body.name.trim() : "",
    templateName:
      typeof body.template_name === "string" ? body.template_name.trim() : "",
    templateLanguage:
      typeof body.template_language === "string" && body.template_language.trim()
        ? body.template_language.trim()
        : "en_US",
    templateVariables:
      body.template_variables && typeof body.template_variables === "object"
        ? body.template_variables
        : null,
    audienceFilter:
      body.audience_filter && typeof body.audience_filter === "object"
        ? body.audience_filter
        : null,
  };
}

export async function GET() {
  try {
    const ctx = await getCurrentDbAccount();
    const rows = await db
      .select()
      .from(broadcasts)
      .where(eq(broadcasts.accountId, ctx.accountId))
      .orderBy(desc(broadcasts.createdAt));

    return NextResponse.json({ broadcasts: rows.map(serializeBroadcast) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole("agent");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const input = normalizeDraft(body);

    if (!input.name || !input.templateName) {
      return NextResponse.json(
        { error: "name and template_name are required." },
        { status: 400 },
      );
    }

    const [created] = await db
      .insert(broadcasts)
      .values({
        userId: ctx.userId,
        accountId: ctx.accountId,
        name: input.name,
        templateName: input.templateName,
        templateLanguage: input.templateLanguage,
        templateVariables: input.templateVariables,
        audienceFilter: input.audienceFilter,
        status: "draft",
        totalRecipients: 0,
        sentCount: 0,
        deliveredCount: 0,
        readCount: 0,
        repliedCount: 0,
        failedCount: 0,
      })
      .returning();

    return NextResponse.json(
      { broadcast: serializeBroadcast(created) },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireDbRole("agent");
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id is required." }, { status: 400 });
    }

    const deleted = await db
      .delete(broadcasts)
      .where(and(eq(broadcasts.accountId, ctx.accountId), eq(broadcasts.id, id)))
      .returning({ id: broadcasts.id });

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Broadcast not found." }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
