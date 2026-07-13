import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { canManageMembers, isAccountRole } from "@/lib/auth/roles";
import type { AccountMember, Department } from "@/types";

interface ProfileRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  account_role: string;
  created_at: string;
}

export async function GET() {
  try {
    const ctx = await requireRole("viewer");
    const db = supabaseAdmin();

    const [
      { data: profileRows, error: profilesError },
      { data: departmentRows, error: departmentsError },
      { data: departmentMemberRows, error: departmentMembersError },
      { data: lines, error: linesError },
    ] =
      await Promise.all([
        db
          .from("profiles")
          .select("user_id, full_name, email, avatar_url, account_role, created_at")
          .eq("account_id", ctx.accountId)
          .order("created_at", { ascending: true }),
        db
          .from("departments")
          .select("*")
          .eq("account_id", ctx.accountId)
          .order("name", { ascending: true }),
        db
          .from("department_members")
          .select("department_id, user_id")
          .eq("account_id", ctx.accountId),
        db
          .from("whatsapp_config")
          .select("id, label, phone_number_id, status, is_default, department_id")
          .eq("account_id", ctx.accountId)
          .order("is_default", { ascending: false })
          .order("created_at", { ascending: true }),
      ]);

    if (profilesError) throw profilesError;
    if (departmentsError) throw departmentsError;
    if (departmentMembersError) throw departmentMembersError;
    if (linesError) throw linesError;

    const canSeeEmails = canManageMembers(ctx.role);
    const departmentIdsByUser = new Map<string, string[]>();
    const memberIdsByDepartment = new Map<string, string[]>();
    for (const row of (departmentMemberRows ?? []) as { department_id: string; user_id: string }[]) {
      const userList = departmentIdsByUser.get(row.user_id) ?? [];
      userList.push(row.department_id);
      departmentIdsByUser.set(row.user_id, userList);

      const departmentList = memberIdsByDepartment.get(row.department_id) ?? [];
      departmentList.push(row.user_id);
      memberIdsByDepartment.set(row.department_id, departmentList);
    }

    const members: AccountMember[] = ((profileRows ?? []) as ProfileRow[]).flatMap(
      (row) => {
        if (!isAccountRole(row.account_role)) return [];
        return [
          {
            user_id: row.user_id,
            full_name: row.full_name ?? "",
            email: canSeeEmails ? row.email : null,
            avatar_url: row.avatar_url,
            role: row.account_role,
            joined_at: row.created_at,
            department_ids: departmentIdsByUser.get(row.user_id) ?? [],
          },
        ];
      },
    );

    const departments: Department[] = ((departmentRows ?? []) as Department[]).map(
      (department) => ({
        ...department,
        member_user_ids: memberIdsByDepartment.get(department.id) ?? [],
      }),
    );

    return NextResponse.json({ members, departments, lines: lines ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
