import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tags } from "@/db/schema";
import { getCurrentDbAccount, requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";

export async function GET() {
  try {
    const ctx = await getCurrentDbAccount();
    const rows = await db
      .select()
      .from(tags)
      .where(eq(tags.accountId, ctx.accountId))
      .orderBy(asc(tags.name));

    return NextResponse.json({
      tags: rows.map((row) => ({
        id: row.id,
        user_id: row.userId,
        name: row.name,
        color: row.color,
        created_at: row.createdAt.toISOString(),
      })),
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
    const color =
      typeof body?.color === "string" && body.color.trim()
        ? body.color.trim()
        : "#3b82f6";

    if (!name) {
      return NextResponse.json({ error: "name is required." }, { status: 400 });
    }

    const [existing] = await db
      .select()
      .from(tags)
      .where(and(eq(tags.accountId, ctx.accountId), eq(tags.name, name)))
      .limit(1);
    if (existing) {
      return NextResponse.json({
        tag: {
          id: existing.id,
          user_id: existing.userId,
          name: existing.name,
          color: existing.color,
          created_at: existing.createdAt.toISOString(),
        },
      });
    }

    const [tag] = await db
      .insert(tags)
      .values({
        userId: ctx.userId,
        accountId: ctx.accountId,
        name,
        color,
      })
      .returning();

    return NextResponse.json(
      {
        tag: {
          id: tag.id,
          user_id: tag.userId,
          name: tag.name,
          color: tag.color,
          created_at: tag.createdAt.toISOString(),
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireDbRole("admin");
    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "id is required." }, { status: 400 });
    }

    const deleted = await db
      .delete(tags)
      .where(and(eq(tags.accountId, ctx.accountId), eq(tags.id, id)))
      .returning({ id: tags.id });

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Tag not found." }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
