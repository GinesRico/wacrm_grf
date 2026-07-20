import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { whatsappConfig } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";

export async function GET() {
  try {
    const ctx = await getCurrentDbAccount();
    const [line] = await db
      .select({ status: whatsappConfig.status })
      .from(whatsappConfig)
      .where(eq(whatsappConfig.accountId, ctx.accountId))
      .limit(1);

    return NextResponse.json({ connected: line?.status === "connected" });
  } catch (err) {
    return toErrorResponse(err);
  }
}
