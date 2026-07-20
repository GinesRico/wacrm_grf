// ============================================================
// /api/account/members/[userId]
//
//   PATCH  — change a member's role.   Admin+.
//   DELETE — remove a member.          Admin+.
//
// Both delegate to SECURITY DEFINER RPCs from migration 018:
//   - set_member_role(p_user_id, p_new_role)
//   - remove_account_member(p_user_id)
//
// The RPCs do the *real* authorisation work — caller must be
// admin+, target must be in caller's account, target can't be the
// owner, can't be self. The TS layer here only forwards the call
// and maps Postgres SQLSTATEs back to HTTP statuses.
// ============================================================

import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { crmAccounts, departmentMembers, departments, profiles } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { isAccountRole } from "@/lib/auth/roles";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

async function validDepartmentIds(accountId: string, requested: unknown): Promise<string[]> {
  if (!Array.isArray(requested)) return [];
  const unique = Array.from(
    new Set(
      requested.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      ),
    ),
  );
  if (unique.length === 0) return [];

  const rows = await db
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.accountId, accountId), inArray(departments.id, unique)));
  const allowed = new Set(rows.map((row) => row.id));
  return unique.filter((id) => allowed.has(id));
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireDbRole("admin");

    const limit = checkRateLimit(
      `admin:memberRole:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const body = (await request.json().catch(() => null)) as
      | { role?: unknown; department_ids?: unknown }
      | null;
    const role = body?.role;
    const hasRolePatch = role !== undefined;
    const hasDepartmentPatch = Array.isArray(body?.department_ids);

    if (!hasRolePatch && !hasDepartmentPatch) {
      return NextResponse.json(
        { error: "No member changes provided" },
        { status: 400 },
      );
    }

    if (hasRolePatch && !isAccountRole(role)) {
      return NextResponse.json(
        { error: "'role' must be one of owner, admin, agent, viewer" },
        { status: 400 },
      );
    }

    // The RPC blocks promotion to / demotion from owner, but
    // surface the friendlier 400 before crossing the wire too.
    if (role === "owner") {
      return NextResponse.json(
        {
          error:
            "Use POST /api/account/transfer-ownership to promote a member to owner",
        },
        { status: 400 },
      );
    }

    if (hasRolePatch) {
      if (userId === ctx.userId) {
        return NextResponse.json({ error: "Cannot change your own role" }, { status: 400 });
      }

      const [member] = await db
        .select({ accountId: profiles.accountId, accountRole: profiles.accountRole })
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .limit(1);

      if (!member) return NextResponse.json({ error: "Target user not found" }, { status: 400 });
      if (member.accountId !== ctx.accountId) {
        return NextResponse.json(
          { error: "Target user is not a member of your account" },
          { status: 403 },
        );
      }
      if (member.accountRole === "owner") {
        return NextResponse.json(
          { error: "Use transfer_account_ownership to demote an owner" },
          { status: 400 },
        );
      }

      await db
        .update(profiles)
        .set({ accountRole: role, updatedAt: new Date() })
        .where(eq(profiles.userId, userId));
    }

    if (hasDepartmentPatch) {
      const [member] = await db
        .select({ userId: profiles.userId })
        .from(profiles)
        .where(and(eq(profiles.accountId, ctx.accountId), eq(profiles.userId, userId)))
        .limit(1);
      if (!member) {
        return NextResponse.json({ error: "Member not found" }, { status: 404 });
      }

      const departmentIds = await validDepartmentIds(ctx.accountId, body?.department_ids);
      await db
        .delete(departmentMembers)
        .where(
          and(
            eq(departmentMembers.accountId, ctx.accountId),
            eq(departmentMembers.userId, userId),
          ),
        );

      if (departmentIds.length > 0) {
        await db.insert(departmentMembers).values(
          departmentIds.map((departmentId) => ({
            accountId: ctx.accountId,
            departmentId,
            userId,
          })),
        );
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireDbRole("admin");

    const limit = checkRateLimit(
      `admin:memberRemove:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    if (userId === ctx.userId) {
      return NextResponse.json(
        { error: "Cannot remove yourself; transfer ownership or leave the account instead" },
        { status: 400 },
      );
    }

    const result = await db.transaction(async (tx) => {
      const [target] = await tx
        .select({
          accountId: profiles.accountId,
          accountRole: profiles.accountRole,
          fullName: profiles.fullName,
          email: profiles.email,
        })
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .limit(1);

      if (!target) return { error: "Target user not found", status: 400 as const };
      if (target.accountId !== ctx.accountId) {
        return { error: "Target user is not a member of your account", status: 403 as const };
      }
      if (target.accountRole === "owner") {
        return { error: "Cannot remove the account owner; transfer ownership first", status: 400 as const };
      }

      const [newAccount] = await tx
        .insert(crmAccounts)
        .values({
          name: target.fullName || target.email || "My account",
          ownerUserId: userId,
        })
        .returning({ id: crmAccounts.id });

      await tx
        .delete(departmentMembers)
        .where(and(eq(departmentMembers.accountId, ctx.accountId), eq(departmentMembers.userId, userId)));

      await tx
        .update(profiles)
        .set({
          accountId: newAccount.id,
          accountRole: "owner",
          updatedAt: new Date(),
        })
        .where(eq(profiles.userId, userId));

      return { newPersonalAccountId: newAccount.id };
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({ ok: true, newPersonalAccountId: result.newPersonalAccountId });
  } catch (err) {
    return toErrorResponse(err);
  }
}
