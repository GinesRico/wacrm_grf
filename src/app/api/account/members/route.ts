// ============================================================
// GET /api/account/members
//
// Lists every member of the caller's account. Any member can call
// it (the Members tab is shown to admins+, but agents/viewers see
// a read-only roster too).
//
// Field visibility
//   Sensitive fields (email) are returned only when the caller is
//   admin+. Agents and viewers see name + avatar + role + joined
//   date only. This mirrors the design decision from the planning
//   phase: "agent/viewer sees names only".
// ============================================================

import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { departmentMembers, profiles } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { canManageMembers, isAccountRole } from "@/lib/auth/roles";
import type { AccountMember } from "@/types";

export async function GET() {
  try {
    const ctx = await getCurrentDbAccount();

    const [profileRows, departmentRows] =
      await Promise.all([
        db
          .select({
            userId: profiles.userId,
            fullName: profiles.fullName,
            email: profiles.email,
            avatarUrl: profiles.avatarUrl,
            accountRole: profiles.accountRole,
            createdAt: profiles.createdAt,
          })
          .from(profiles)
          .where(eq(profiles.accountId, ctx.accountId))
          .orderBy(asc(profiles.createdAt)),
        db
          .select({
            departmentId: departmentMembers.departmentId,
            userId: departmentMembers.userId,
          })
          .from(departmentMembers)
          .where(eq(departmentMembers.accountId, ctx.accountId)),
      ]);

    const canSeeEmails = canManageMembers(ctx.role);
    const departmentIdsByUser = new Map<string, string[]>();
    for (const row of departmentRows) {
      const list = departmentIdsByUser.get(row.userId) ?? [];
      list.push(row.departmentId);
      departmentIdsByUser.set(row.userId, list);
    }

    const members: AccountMember[] = profileRows.flatMap((row) => {
      // Defensive: the DB enum should never let an unknown role
      // through, but if a migration ever broadens the enum without
      // updating TS, skip the row rather than crash the page.
      if (!isAccountRole(row.accountRole)) return [];
      return [
        {
          user_id: row.userId,
          full_name: row.fullName ?? "",
          email: canSeeEmails ? row.email : null,
          avatar_url: row.avatarUrl,
          role: row.accountRole,
          joined_at: row.createdAt.toISOString(),
          department_ids: departmentIdsByUser.get(row.userId) ?? [],
        },
      ];
    });

    return NextResponse.json({ members });
  } catch (err) {
    return toErrorResponse(err);
  }
}
