import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { messageTemplates } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { serializeMessageTemplate } from "@/lib/whatsapp/template-serializer";

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentDbAccount();
    const url = new URL(request.url);
    const status = url.searchParams.get("status")?.trim();
    const rows = await db
      .select()
      .from(messageTemplates)
      .where(
        status
          ? and(
              eq(messageTemplates.accountId, ctx.accountId),
              eq(messageTemplates.status, status),
            )
          : eq(messageTemplates.accountId, ctx.accountId),
      )
      .orderBy(desc(messageTemplates.createdAt));

    return NextResponse.json({ templates: rows.map(serializeMessageTemplate) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
