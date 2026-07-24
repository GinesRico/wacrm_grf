import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { whatsappConfig } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";

export async function GET() {
  try {
    const ctx = await getCurrentDbAccount();
    const [connectedLine] = await db
      .select({ id: whatsappConfig.id })
      .from(whatsappConfig)
      .where(
        and(
          eq(whatsappConfig.accountId, ctx.accountId),
          eq(whatsappConfig.status, "connected"),
        ),
      )
      .limit(1);

    return NextResponse.json({ connected: Boolean(connectedLine) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
