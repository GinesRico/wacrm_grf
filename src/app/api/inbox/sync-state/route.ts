import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { conversations, departmentMembers, departments } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";

export async function GET() {
  try {
    const { accountId, userId } = await getCurrentDbAccount();
    const [allDepartmentRows, departmentRows] = await Promise.all([
      db.select({ id: departments.id }).from(departments).where(eq(departments.accountId, accountId)),
      db
        .select({ departmentId: departmentMembers.departmentId })
        .from(departmentMembers)
        .where(and(eq(departmentMembers.accountId, accountId), eq(departmentMembers.userId, userId))),
    ]);
    const departmentIds = departmentRows.map((row) => row.departmentId).filter(Boolean);
    const departmentVisibility =
      allDepartmentRows.length === 0
        ? undefined
        : departmentIds.length > 0
          ? or(isNull(conversations.departmentId), inArray(conversations.departmentId, departmentIds))
          : isNull(conversations.departmentId);
    const [state] = await db
      .select({
        conversationCount: sql<number>`count(*)::int`,
        unreadConversationCount: sql<number>`count(*) filter (where ${conversations.unreadCount} > 0)::int`,
        totalUnreadCount: sql<number>`coalesce(sum(${conversations.unreadCount}), 0)::int`,
        latestActivityAt: sql<Date | null>`max(coalesce(${conversations.lastMessageAt}, ${conversations.updatedAt}))`,
        latestUpdatedAt: sql<Date | null>`max(${conversations.updatedAt})`,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.accountId, accountId),
          ne(conversations.status, "closed"),
          departmentVisibility,
        ),
      );

    const payload = {
      conversation_count: Number(state?.conversationCount ?? 0),
      unread_conversation_count: Number(state?.unreadConversationCount ?? 0),
      total_unread_count: Number(state?.totalUnreadCount ?? 0),
      latest_activity_at: state?.latestActivityAt ? new Date(state.latestActivityAt).toISOString() : null,
      latest_updated_at: state?.latestUpdatedAt ? new Date(state.latestUpdatedAt).toISOString() : null,
    };

    return NextResponse.json({
      ...payload,
      version: JSON.stringify(payload),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
