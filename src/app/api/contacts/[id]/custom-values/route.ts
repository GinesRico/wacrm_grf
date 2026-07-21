import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { contactCustomValues, contacts, customFields } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { publishRealtimeEvent } from "@/lib/realtime/soketi-server";

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireDbRole("agent");
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const values =
      body?.values && typeof body.values === "object"
        ? (body.values as Record<string, unknown>)
        : {};

    const [contact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.accountId, ctx.accountId)))
      .limit(1);

    if (!contact) {
      return NextResponse.json({ error: "Contact not found." }, { status: 404 });
    }

    const fieldIds = Object.keys(values);
    await db.transaction(async (tx) => {
      await tx.delete(contactCustomValues).where(eq(contactCustomValues.contactId, id));
      if (fieldIds.length === 0) return;
      const ownedFields = await tx
        .select({ id: customFields.id })
        .from(customFields)
        .where(and(eq(customFields.accountId, ctx.accountId), inArray(customFields.id, fieldIds)));
      const rows = ownedFields.flatMap((field) => {
        const value = values[field.id];
        if (typeof value !== "string" || !value.trim()) return [];
        return [{ contactId: id, customFieldId: field.id, value: value.trim() }];
      });
      if (rows.length > 0) await tx.insert(contactCustomValues).values(rows);
    });

    await publishRealtimeEvent("contact_custom_values.updated", {
      accountId: ctx.accountId,
      payload: { contact_id: id },
    }).catch((error) => {
      console.warn("[realtime] failed to publish contact_custom_values.updated:", error);
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
