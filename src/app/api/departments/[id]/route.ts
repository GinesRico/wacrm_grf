import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import {
  conversations,
  departmentMembers,
  departments,
  profiles,
  whatsappConfig,
} from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";

const DEFAULT_COLOR = "#22c55e";

function normalizeColor(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value
    : DEFAULT_COLOR;
}

async function assertDepartment(accountId: string, departmentId: string) {
  const [department] = await db
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.accountId, accountId), eq(departments.id, departmentId)))
    .limit(1);

  if (!department) {
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

  const rows = await db
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(and(eq(profiles.accountId, accountId), inArray(profiles.userId, unique)));
  const allowed = new Set(rows.map((row) => row.userId));
  return unique.filter((id) => allowed.has(id));
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireDbRole("admin");
    const { id } = await context.params;
    const missing = await assertDepartment(ctx.accountId, id);
    if (missing) return missing;

    const body = await request.json().catch(() => ({}));
    const patch: Partial<typeof departments.$inferInsert> = {};
    if (typeof body?.name === "string") {
      const name = body.name.trim();
      if (!name) {
        return NextResponse.json({ error: "Department name is required." }, { status: 400 });
      }
      patch.name = name;
    }
    if (body?.color !== undefined) patch.color = normalizeColor(body.color);

    if (Object.keys(patch).length > 0) {
      await db
        .update(departments)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(departments.accountId, ctx.accountId), eq(departments.id, id)));
    }

    if (Array.isArray(body?.member_user_ids)) {
      const memberIds = await validMemberIds(ctx.accountId, body.member_user_ids);
      await db
        .delete(departmentMembers)
        .where(
          and(
            eq(departmentMembers.accountId, ctx.accountId),
            eq(departmentMembers.departmentId, id),
          ),
        );

      if (memberIds.length > 0) {
        await db.insert(departmentMembers).values(
          memberIds.map((userId) => ({
            accountId: ctx.accountId,
            departmentId: id,
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
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireDbRole("admin");
    const { id } = await context.params;
    const missing = await assertDepartment(ctx.accountId, id);
    if (missing) return missing;

    const [fallback] = await db
      .select({ id: departments.id })
      .from(departments)
      .where(and(eq(departments.accountId, ctx.accountId), ne(departments.id, id)))
      .orderBy(asc(departments.createdAt))
      .limit(1);

    await db.transaction(async (tx) => {
      await tx
        .update(whatsappConfig)
        .set({ departmentId: fallback?.id ?? null, updatedAt: new Date() })
        .where(
          and(
            eq(whatsappConfig.accountId, ctx.accountId),
            eq(whatsappConfig.departmentId, id),
          ),
        );
      await tx
        .update(conversations)
        .set({ departmentId: fallback?.id ?? null, updatedAt: new Date() })
        .where(
          and(
            eq(conversations.accountId, ctx.accountId),
            eq(conversations.departmentId, id),
          ),
        );
      await tx
        .delete(departments)
        .where(and(eq(departments.accountId, ctx.accountId), eq(departments.id, id)));
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
