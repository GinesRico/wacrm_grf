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
import type { PostgrestError } from "@supabase/supabase-js";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { isAccountRole } from "@/lib/auth/roles";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

// Map known SQLSTATEs from the RPCs (see migration 018) onto HTTP
// statuses. The `error.code` field is the SQLSTATE; the `message`
// is the human-readable RAISE message we put in the migration.
function rpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === "42501") {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err.code === "22023") {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error("[members route] unexpected RPC error:", err);
  return NextResponse.json(
    { error: "Failed to update member" },
    { status: 500 },
  );
}

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

  const { data, error } = await supabaseAdmin()
    .from("departments")
    .select("id")
    .eq("account_id", accountId)
    .in("id", unique);

  if (error) throw error;
  const allowed = new Set(((data ?? []) as { id: string }[]).map((row) => row.id));
  return unique.filter((id) => allowed.has(id));
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("admin");

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

    const db = supabaseAdmin();

    if (hasRolePatch) {
      const { error } = await ctx.supabase.rpc("set_member_role", {
        p_user_id: userId,
        p_new_role: role,
      });

      if (error) return rpcErrorToResponse(error);
    }

    if (hasDepartmentPatch) {
      const { data: member, error: memberError } = await db
        .from("profiles")
        .select("user_id")
        .eq("account_id", ctx.accountId)
        .eq("user_id", userId)
        .maybeSingle();
      if (memberError) throw memberError;
      if (!member) {
        return NextResponse.json({ error: "Member not found" }, { status: 404 });
      }

      const departmentIds = await validDepartmentIds(ctx.accountId, body?.department_ids);
      const { error: deleteError } = await db
        .from("department_members")
        .delete()
        .eq("account_id", ctx.accountId)
        .eq("user_id", userId);
      if (deleteError) throw deleteError;

      if (departmentIds.length > 0) {
        const { error: insertError } = await db
          .from("department_members")
          .insert(
            departmentIds.map((departmentId) => ({
              account_id: ctx.accountId,
              department_id: departmentId,
              user_id: userId,
            })),
          );
        if (insertError) throw insertError;
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
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:memberRemove:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const { data, error } = await ctx.supabase.rpc("remove_account_member", {
      p_user_id: userId,
    });

    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ ok: true, newPersonalAccountId: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
