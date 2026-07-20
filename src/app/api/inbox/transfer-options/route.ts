import { NextResponse } from "next/server";
import { asc, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { departmentMembers, departments as departmentsTable, profiles, whatsappConfig } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { canManageMembers, isAccountRole } from "@/lib/auth/roles";
import type { AccountMember, Department } from "@/types";

export async function GET() {
  try {
    const ctx = await getCurrentDbAccount();

    const [profileRows, departmentRows, departmentMemberRows, lineRows] =
      await Promise.all([
        db
          .select({
            user_id: profiles.userId,
            full_name: profiles.fullName,
            email: profiles.email,
            avatar_url: profiles.avatarUrl,
            account_role: profiles.accountRole,
            created_at: profiles.createdAt,
          })
          .from(profiles)
          .where(eq(profiles.accountId, ctx.accountId))
          .orderBy(asc(profiles.createdAt)),
        db
          .select()
          .from(departmentsTable)
          .where(eq(departmentsTable.accountId, ctx.accountId))
          .orderBy(asc(departmentsTable.name)),
        db
          .select({
            department_id: departmentMembers.departmentId,
            user_id: departmentMembers.userId,
          })
          .from(departmentMembers)
          .where(eq(departmentMembers.accountId, ctx.accountId)),
        db
          .select({
            id: whatsappConfig.id,
            label: whatsappConfig.label,
            phone_number_id: whatsappConfig.phoneNumberId,
            status: whatsappConfig.status,
            is_default: whatsappConfig.isDefault,
            department_id: whatsappConfig.departmentId,
          })
          .from(whatsappConfig)
          .where(eq(whatsappConfig.accountId, ctx.accountId))
          .orderBy(desc(whatsappConfig.isDefault), asc(whatsappConfig.createdAt)),
      ]);

    const canSeeEmails = canManageMembers(ctx.role);
    const departmentIdsByUser = new Map<string, string[]>();
    const memberIdsByDepartment = new Map<string, string[]>();
    for (const row of departmentMemberRows) {
      const userList = departmentIdsByUser.get(row.user_id) ?? [];
      userList.push(row.department_id);
      departmentIdsByUser.set(row.user_id, userList);

      const departmentList = memberIdsByDepartment.get(row.department_id) ?? [];
      departmentList.push(row.user_id);
      memberIdsByDepartment.set(row.department_id, departmentList);
    }

    const members: AccountMember[] = profileRows.flatMap(
      (row) => {
        if (!isAccountRole(row.account_role)) return [];
        return [
          {
            user_id: row.user_id,
            full_name: row.full_name ?? "",
            email: canSeeEmails ? row.email : null,
            avatar_url: row.avatar_url,
            role: row.account_role,
            joined_at: row.created_at.toISOString(),
            department_ids: departmentIdsByUser.get(row.user_id) ?? [],
          },
        ];
      },
    );

    const departments: Department[] = departmentRows.map(
      (department) => ({
        id: department.id,
        account_id: department.accountId,
        name: department.name,
        color: department.color,
        created_at: department.createdAt.toISOString(),
        updated_at: department.updatedAt.toISOString(),
        member_user_ids: memberIdsByDepartment.get(department.id) ?? [],
      }),
    );

    return NextResponse.json({ members, departments, lines: lineRows });
  } catch (err) {
    return toErrorResponse(err);
  }
}
