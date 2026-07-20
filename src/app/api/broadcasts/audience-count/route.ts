import { NextResponse } from "next/server";
import { and, count, eq, ilike, inArray, ne } from "drizzle-orm";

import { db } from "@/db/client";
import { contactCustomValues, contactTags, contacts } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";

type AudienceType = "all" | "tags" | "custom_field" | "csv";

function uniqueIds(rows: Array<{ contactId: string }>) {
  return new Set(rows.map((row) => row.contactId));
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentDbAccount();
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const type = body.type as AudienceType | undefined;
    const tagIds = Array.isArray(body.tagIds)
      ? body.tagIds.filter((id): id is string => typeof id === "string")
      : [];
    const excludeTagIds = Array.isArray(body.excludeTagIds)
      ? body.excludeTagIds.filter((id): id is string => typeof id === "string")
      : [];

    let baseIds: Set<string> | null = null;

    if (type === "all") {
      baseIds = null;
    } else if (type === "csv") {
      const rows = Array.isArray(body.csvContacts) ? body.csvContacts : [];
      return NextResponse.json({ count: rows.length });
    } else if (type === "tags" && tagIds.length > 0) {
      const rows = await db
        .select({ contactId: contactTags.contactId })
        .from(contactTags)
        .innerJoin(contacts, eq(contacts.id, contactTags.contactId))
        .where(
          and(
            eq(contacts.accountId, ctx.accountId),
            inArray(contactTags.tagId, tagIds),
          ),
        );
      baseIds = uniqueIds(rows);
    } else if (type === "custom_field") {
      const filter =
        body.customField && typeof body.customField === "object"
          ? (body.customField as Record<string, unknown>)
          : {};
      const fieldId = typeof filter.fieldId === "string" ? filter.fieldId : "";
      const operator = typeof filter.operator === "string" ? filter.operator : "is";
      const value = typeof filter.value === "string" ? filter.value : "";

      if (!fieldId || !value) {
        return NextResponse.json({ count: null });
      }

      const valuePredicate =
        operator === "is_not"
          ? ne(contactCustomValues.value, value)
          : operator === "contains"
            ? ilike(contactCustomValues.value, `%${value}%`)
            : eq(contactCustomValues.value, value);
      const rows = await db
        .select({ contactId: contactCustomValues.contactId })
        .from(contactCustomValues)
        .innerJoin(contacts, eq(contacts.id, contactCustomValues.contactId))
        .where(
          and(
            eq(contacts.accountId, ctx.accountId),
            eq(contactCustomValues.customFieldId, fieldId),
            valuePredicate,
          ),
        );
      baseIds = uniqueIds(rows);
    } else {
      return NextResponse.json({ count: null });
    }

    let excluded = new Set<string>();
    if (excludeTagIds.length > 0) {
      const rows = await db
        .select({ contactId: contactTags.contactId })
        .from(contactTags)
        .innerJoin(contacts, eq(contacts.id, contactTags.contactId))
        .where(
          and(
            eq(contacts.accountId, ctx.accountId),
            inArray(contactTags.tagId, excludeTagIds),
          ),
        );
      excluded = uniqueIds(rows);
    }

    if (baseIds) {
      return NextResponse.json({
        count: [...baseIds].filter((id) => !excluded.has(id)).length,
      });
    }

    const [row] = await db
      .select({ count: count() })
      .from(contacts)
      .where(eq(contacts.accountId, ctx.accountId));
    return NextResponse.json({
      count: Math.max(0, Number(row?.count ?? 0) - excluded.size),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
