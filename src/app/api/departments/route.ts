import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import type { Department } from "@/types";

const DEFAULT_COLOR = "#22c55e";

function normalizeColor(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value
    : DEFAULT_COLOR;
}

async function loadDepartments(accountId: string): Promise<Department[]> {
  const db = supabaseAdmin();
  const [{ data: departments, error }, { data: members, error: membersError }] =
    await Promise.all([
      db
        .from("departments")
        .select("*")
        .eq("account_id", accountId)
        .order("name", { ascending: true }),
      db
        .from("department_members")
        .select("department_id, user_id")
        .eq("account_id", accountId),
    ]);

  if (error) throw error;
  if (membersError) throw membersError;

  const membersByDepartment = new Map<string, string[]>();
  for (const row of (members ?? []) as { department_id: string; user_id: string }[]) {
    const list = membersByDepartment.get(row.department_id) ?? [];
    list.push(row.user_id);
    membersByDepartment.set(row.department_id, list);
  }

  return ((departments ?? []) as Department[]).map((department) => ({
    ...department,
    member_user_ids: membersByDepartment.get(department.id) ?? [],
  }));
}

export async function GET() {
  try {
    const ctx = await requireRole("viewer");
    return NextResponse.json({
      departments: await loadDepartments(ctx.accountId),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = await request.json().catch(() => ({}));
    const name = typeof body?.name === "string" ? body.name.trim() : "";

    if (!name) {
      return NextResponse.json({ error: "Department name is required." }, { status: 400 });
    }

    const { error } = await supabaseAdmin()
      .from("departments")
      .insert({
        account_id: ctx.accountId,
        name,
        color: normalizeColor(body?.color),
      });

    if (error) throw error;

    return NextResponse.json({
      departments: await loadDepartments(ctx.accountId),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
