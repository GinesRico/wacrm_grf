import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { departmentMembers, departments } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { publishRealtimeEvent } from "@/lib/realtime/soketi-server";
import type { Department } from "@/types";

const DEFAULT_COLOR = "#22c55e";

function normalizeColor(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value
    : DEFAULT_COLOR;
}

function serializeDepartment(
  department: typeof departments.$inferSelect,
  memberUserIds: string[],
): Department {
  return {
    id: department.id,
    account_id: department.accountId,
    name: department.name,
    color: department.color,
    created_at: department.createdAt.toISOString(),
    updated_at: department.updatedAt.toISOString(),
    member_user_ids: memberUserIds,
  };
}

async function loadDepartments(accountId: string): Promise<Department[]> {
  const [departmentRows, memberRows] = await Promise.all([
    db
      .select()
      .from(departments)
      .where(eq(departments.accountId, accountId))
      .orderBy(asc(departments.name)),
    db
      .select({
        departmentId: departmentMembers.departmentId,
        userId: departmentMembers.userId,
      })
      .from(departmentMembers)
      .where(eq(departmentMembers.accountId, accountId)),
  ]);

  const membersByDepartment = new Map<string, string[]>();
  for (const row of memberRows) {
    const list = membersByDepartment.get(row.departmentId) ?? [];
    list.push(row.userId);
    membersByDepartment.set(row.departmentId, list);
  }

  return departmentRows.map((department) =>
    serializeDepartment(department, membersByDepartment.get(department.id) ?? []),
  );
}

export async function GET() {
  try {
    const ctx = await requireDbRole("viewer");
    return NextResponse.json({
      departments: await loadDepartments(ctx.accountId),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole("admin");
    const body = await request.json().catch(() => ({}));
    const name = typeof body?.name === "string" ? body.name.trim() : "";

    if (!name) {
      return NextResponse.json({ error: "Department name is required." }, { status: 400 });
    }

    const [created] = await db.insert(departments).values({
      accountId: ctx.accountId,
      name,
      color: normalizeColor(body?.color),
    }).returning();
    await publishRealtimeEvent("department.created", {
      accountId: ctx.accountId,
      payload: { department: serializeDepartment(created, []) },
    }).catch((error) => {
      console.warn("[realtime] failed to publish department.created:", error);
    });

    return NextResponse.json({
      departments: await loadDepartments(ctx.accountId),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
