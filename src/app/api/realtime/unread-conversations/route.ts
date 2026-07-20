import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { conversations } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";

export async function GET() {
  try {
    const { accountId } = await getCurrentDbAccount();
    const rows = await db
      .select({
        id: conversations.id,
        unread_count: conversations.unreadCount,
      })
      .from(conversations)
      .where(eq(conversations.accountId, accountId));

    return NextResponse.json({ conversations: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}
