import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";

const DEFAULT_COLOR = "#22c55e";

function normalizeColor(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value
    : DEFAULT_COLOR;
}

async function assertDepartment(accountId: string, departmentId: string) {
  const { data, error } = await supabaseAdmin()
    .from("departments")
    .select("id")
    .eq("account_id", accountId)
    .eq("id", departmentId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    return NextResponse.json({ error: "Department not found." }, { status: 404 });
  }
  return null;
}

async function validMemberIds(accountId: string, requested: unknown): Promise<string[]> {
  if (!Array.isArray(requested)) return [];
  const unique = Array.from(
    new Set(requested.filter((id): id is string => typeof id === "string" && id.length > 0)),
  );
  if (unique.length === 0) return [];

  const { data, error } = await supabaseAdmin()
    .from("profiles")
    .select("user_id")
    .eq("account_id", accountId)
    .in("user_id", unique);

  if (error) throw error;
  const allowed = new Set(((data ?? []) as { user_id: string }[]).map((row) => row.user_id));
  return unique.filter((id) => allowed.has(id));
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");
    const { id } = await context.params;
    const missing = await assertDepartment(ctx.accountId, id);
    if (missing) return missing;

    const body = await request.json().catch(() => ({}));
    const patch: { name?: string; color?: string } = {};
    if (typeof body?.name === "string") {
      const name = body.name.trim();
      if (!name) {
        return NextResponse.json({ error: "Department name is required." }, { status: 400 });
      }
      patch.name = name;
    }
    if (body?.color !== undefined) patch.color = normalizeColor(body.color);

    const db = supabaseAdmin();
    if (Object.keys(patch).length > 0) {
      const { error } = await db
        .from("departments")
        .update(patch)
        .eq("account_id", ctx.accountId)
        .eq("id", id);
      if (error) throw error;
    }

    if (Array.isArray(body?.member_user_ids)) {
      const memberIds = await validMemberIds(ctx.accountId, body.member_user_ids);
      const { error: deleteError } = await db
        .from("department_members")
        .delete()
        .eq("account_id", ctx.accountId)
        .eq("department_id", id);
      if (deleteError) throw deleteError;

      if (memberIds.length > 0) {
        const { error: insertError } = await db
          .from("department_members")
          .insert(
            memberIds.map((userId) => ({
              account_id: ctx.accountId,
              department_id: id,
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
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");
    const { id } = await context.params;
    const missing = await assertDepartment(ctx.accountId, id);
    if (missing) return missing;

    const db = supabaseAdmin();
    const { data: fallback } = await db
      .from("departments")
      .select("id")
      .eq("account_id", ctx.accountId)
      .neq("id", id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    await Promise.all([
      db.from("whatsapp_config").update({ department_id: fallback?.id ?? null }).eq("account_id", ctx.accountId).eq("department_id", id),
      db.from("conversations").update({ department_id: fallback?.id ?? null }).eq("account_id", ctx.accountId).eq("department_id", id),
    ]);

    const { error } = await db
      .from("departments")
      .delete()
      .eq("account_id", ctx.accountId)
      .eq("id", id);
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
