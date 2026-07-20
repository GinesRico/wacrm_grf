import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { messageTemplates } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentDbAccount();
    const body = await request.json().catch(() => ({}));
    const names = Array.isArray(body?.names)
      ? body.names.filter((name: unknown): name is string => typeof name === "string")
      : [];

    if (names.length === 0) {
      return NextResponse.json({ templates: [] });
    }

    const templates = await db
      .select({
        name: messageTemplates.name,
        footer_text: messageTemplates.footerText,
        buttons: messageTemplates.buttons,
      })
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.accountId, ctx.accountId),
          inArray(messageTemplates.name, names),
        ),
      );

    return NextResponse.json({ templates });
  } catch (err) {
    return toErrorResponse(err);
  }
}
