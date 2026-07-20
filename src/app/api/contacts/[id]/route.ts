import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  contactCustomValues,
  contactNotes,
  contactTags,
  contacts,
  customFields,
  tags,
} from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import {
  serializeContact,
  serializeCustomField,
  serializeCustomValue,
  serializeNote,
  serializeTag,
} from "@/lib/contacts/serialize";

async function safeDeals(contactId: string, accountId: string) {
  try {
    const result = await db.execute(sql`
      select
        d.*,
        case
          when ps.id is null then null
          else json_build_object(
            'id', ps.id,
            'pipeline_id', ps.pipeline_id,
            'name', ps.name,
            'position', ps.position,
            'color', ps.color,
            'created_at', ps.created_at
          )
        end as stage
      from deals d
      left join pipeline_stages ps on ps.id = d.stage_id
      where d.contact_id = ${contactId} and d.account_id = ${accountId}
      order by d.created_at desc
    `);
    return result.rows;
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return [];
    throw error;
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getCurrentDbAccount();
    const { id } = await context.params;

    const [contact] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.accountId, ctx.accountId)))
      .limit(1);

    if (!contact) {
      return NextResponse.json({ error: "Contact not found." }, { status: 404 });
    }

    const [tagRows, notes, fields, values, deals] = await Promise.all([
      db
        .select({
          contact_tag_id: contactTags.id,
          id: tags.id,
          userId: tags.userId,
          accountId: tags.accountId,
          name: tags.name,
          color: tags.color,
          createdAt: tags.createdAt,
        })
        .from(contactTags)
        .innerJoin(tags, eq(tags.id, contactTags.tagId))
        .where(eq(contactTags.contactId, id)),
      db
        .select()
        .from(contactNotes)
        .where(and(eq(contactNotes.contactId, id), eq(contactNotes.accountId, ctx.accountId)))
        .orderBy(desc(contactNotes.createdAt)),
      db
        .select()
        .from(customFields)
        .where(eq(customFields.accountId, ctx.accountId))
        .orderBy(customFields.fieldName),
      db
        .select()
        .from(contactCustomValues)
        .where(eq(contactCustomValues.contactId, id)),
      safeDeals(id, ctx.accountId),
    ]);

    return NextResponse.json({
      contact: serializeContact(contact),
      tags: tagRows.map((row) => ({
        ...serializeTag(row),
        contact_tag_id: row.contact_tag_id,
      })),
      contact_tag_ids: tagRows.map((row) => row.id),
      notes: notes.map(serializeNote),
      custom_fields: fields.map(serializeCustomField),
      custom_values: values.map(serializeCustomValue),
      deals,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
