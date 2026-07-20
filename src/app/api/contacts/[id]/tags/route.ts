import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { contactTags, contacts, tags } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireDbRole("agent");
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const tagIds = Array.isArray(body?.tag_ids)
      ? body.tag_ids.filter((tagId: unknown): tagId is string => typeof tagId === "string")
      : [];

    const [contact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.accountId, ctx.accountId)))
      .limit(1);

    if (!contact) {
      return NextResponse.json({ error: "Contact not found." }, { status: 404 });
    }

    await db.transaction(async (tx) => {
      await tx.delete(contactTags).where(eq(contactTags.contactId, id));
      if (tagIds.length === 0) return;
      const owned = await tx
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.accountId, ctx.accountId), inArray(tags.id, tagIds)));
      if (owned.length > 0) {
        await tx.insert(contactTags).values(
          owned.map((tag) => ({ contactId: id, tagId: tag.id })),
        );
      }
    });

    return NextResponse.json({ tag_ids: tagIds });
  } catch (err) {
    return toErrorResponse(err);
  }
}
