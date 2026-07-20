import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { notifications } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";

export async function GET() {
  try {
    const { accountId } = await getCurrentDbAccount();
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.accountId, accountId),
          isNull(notifications.readAt),
        ),
      );

    return NextResponse.json({ count: rows.length });
  } catch (err) {
    return toErrorResponse(err);
  }
}
