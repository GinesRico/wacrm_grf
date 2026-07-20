import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { crmAccounts } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { CURRENCIES } from "@/lib/currency";

export async function PATCH(request: Request) {
  try {
    const ctx = await requireDbRole("admin");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const defaultCurrency =
      typeof body.default_currency === "string" ? body.default_currency.trim() : "";

    if (
      defaultCurrency &&
      !CURRENCIES.some((currency) => currency.code === defaultCurrency)
    ) {
      return NextResponse.json(
        { error: "Unsupported default currency." },
        { status: 400 },
      );
    }

    if (!defaultCurrency) {
      return NextResponse.json(
        { error: "default_currency is required." },
        { status: 400 },
      );
    }

    await db
      .update(crmAccounts)
      .set({ defaultCurrency, updatedAt: new Date() })
      .where(eq(crmAccounts.id, ctx.accountId));

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
