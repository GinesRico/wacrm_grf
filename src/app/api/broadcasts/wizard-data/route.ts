import { NextResponse } from "next/server";
import { asc, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { contactCustomValues, contacts, customFields, tags } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { serializeContact } from "@/lib/contacts/serialize";
import { serializeCustomField, serializeTag } from "@/lib/contacts/serialize";

export async function GET() {
  try {
    const ctx = await getCurrentDbAccount();
    const [tagRows, fieldRows, [latestContact]] = await Promise.all([
      db
        .select()
        .from(tags)
        .where(eq(tags.accountId, ctx.accountId))
        .orderBy(asc(tags.name)),
      db
        .select()
        .from(customFields)
        .where(eq(customFields.accountId, ctx.accountId))
        .orderBy(asc(customFields.fieldName)),
      db
        .select()
        .from(contacts)
        .where(eq(contacts.accountId, ctx.accountId))
        .orderBy(desc(contacts.createdAt))
        .limit(1),
    ]);

    const customValues = latestContact
      ? await db
          .select()
          .from(contactCustomValues)
          .where(eq(contactCustomValues.contactId, latestContact.id))
      : [];

    return NextResponse.json({
      tags: tagRows.map(serializeTag),
      custom_fields: fieldRows.map(serializeCustomField),
      first_contact: latestContact ? serializeContact(latestContact) : null,
      first_contact_custom_values: customValues.map((row) => ({
        custom_field_id: row.customFieldId,
        value: row.value,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
