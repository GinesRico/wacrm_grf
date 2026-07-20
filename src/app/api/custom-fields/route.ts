import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { customFields } from "@/db/schema";
import { getCurrentDbAccount, requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { serializeCustomField } from "@/lib/contacts/serialize";

export async function GET() {
  try {
    const ctx = await getCurrentDbAccount();
    const rows = await db
      .select()
      .from(customFields)
      .where(eq(customFields.accountId, ctx.accountId))
      .orderBy(asc(customFields.fieldName));

    return NextResponse.json({ fields: rows.map(serializeCustomField) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole("admin");
    const body = await request.json().catch(() => ({}));
    const name = typeof body?.field_name === "string" ? body.field_name.trim() : "";
    if (!name) {
      return NextResponse.json({ error: "field_name is required." }, { status: 400 });
    }

    const [field] = await db
      .insert(customFields)
      .values({
        userId: ctx.userId,
        accountId: ctx.accountId,
        fieldName: name,
        fieldType: "text",
      })
      .returning();

    return NextResponse.json({ field: serializeCustomField(field) }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireDbRole("admin");
    const body = await request.json().catch(() => ({}));
    const id = typeof body?.id === "string" ? body.id : "";
    const name = typeof body?.field_name === "string" ? body.field_name.trim() : "";
    if (!id || !name) {
      return NextResponse.json({ error: "id and field_name are required." }, { status: 400 });
    }

    const [field] = await db
      .update(customFields)
      .set({ fieldName: name })
      .where(and(eq(customFields.id, id), eq(customFields.accountId, ctx.accountId)))
      .returning();

    if (!field) {
      return NextResponse.json({ error: "Field not found." }, { status: 404 });
    }

    return NextResponse.json({ field: serializeCustomField(field) });
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
      .delete(customFields)
      .where(and(eq(customFields.id, id), eq(customFields.accountId, ctx.accountId)))
      .returning({ id: customFields.id });

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Field not found." }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
