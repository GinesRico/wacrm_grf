import { NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { contactTags, contacts, tags } from "@/db/schema";
import { getCurrentDbAccount, requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { findExistingContact, isUniqueViolation } from "@/lib/contacts/dedupe";
import { serializeContact } from "@/lib/contacts/serialize";
import { publishRealtimeEvent } from "@/lib/realtime/soketi-server";
import { normalizePhone } from "@/lib/whatsapp/phone-utils";

function normalizeInput(body: Record<string, unknown>) {
  return {
    name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : null,
    phone: typeof body.phone === "string" ? body.phone.trim() : "",
    email: typeof body.email === "string" && body.email.trim() ? body.email.trim() : null,
    company:
      typeof body.company === "string" && body.company.trim()
        ? body.company.trim()
        : null,
    tagIds: Array.isArray(body.tag_ids)
      ? body.tag_ids.filter((id): id is string => typeof id === "string")
      : [],
  };
}

function asIsoString(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function serializeRawContact(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    account_id: String(row.account_id),
    phone: String(row.phone),
    phone_normalized:
      typeof row.phone_normalized === "string" ? row.phone_normalized : null,
    name: typeof row.name === "string" ? row.name : null,
    email: typeof row.email === "string" ? row.email : null,
    company: typeof row.company === "string" ? row.company : null,
    avatar_url: typeof row.avatar_url === "string" ? row.avatar_url : null,
    created_at: asIsoString(row.created_at),
    updated_at: asIsoString(row.updated_at),
  };
}

function contactOrderBy(sortBy: string, sortDir: string) {
  const direction = sortDir === "desc" ? sql`desc` : sql`asc`;
  const nulls = sortDir === "desc" ? sql`nulls last` : sql`nulls first`;
  const fallback = sql`created_at desc`;

  const expression =
    sortBy === "phone"
      ? sql`phone`
      : sortBy === "email"
        ? sql`lower(coalesce(email, ''))`
        : sortBy === "company"
          ? sql`lower(coalesce(company, ''))`
          : sortBy === "tags"
            ? sql`lower(coalesce(tag_names, ''))`
            : sortBy === "created_at"
              ? sql`created_at`
              : sql`lower(coalesce(name, ''))`;

  return sql`${expression} ${direction} ${nulls}, ${fallback}`;
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentDbAccount();
    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
    const search = url.searchParams.get("search")?.trim() ?? "";
    const sortBy = url.searchParams.get("sort_by") ?? "created_at";
    const sortDir = url.searchParams.get("sort_dir") === "asc" ? "asc" : "desc";
    const tagIds = (url.searchParams.get("tag_ids") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const orderBy = contactOrderBy(sortBy, sortDir);

    const result = await db.execute(sql`
      with filtered as (
        select distinct c.*, sort_tag_data.tag_names
        from contacts c
        ${
          tagIds.length > 0
            ? sql`join contact_tags ctag_filter on ctag_filter.contact_id = c.id`
            : sql``
        }
        left join lateral (
          select string_agg(t.name, ', ' order by t.name asc) as tag_names
          from contact_tags ctag_sort
          join tags t on t.id = ctag_sort.tag_id
          where ctag_sort.contact_id = c.id
        ) sort_tag_data on true
        where c.account_id = ${ctx.accountId}
          ${
            search
              ? sql`and (c.name ilike ${`%${search}%`} or c.phone ilike ${`%${search}%`} or c.email ilike ${`%${search}%`})`
              : sql``
          }
          ${
            tagIds.length > 0
              ? sql`and ctag_filter.tag_id = any(${tagIds}::uuid[])`
              : sql``
          }
      ),
      counted as (
        select *, count(*) over()::int as total_count
        from filtered
        order by ${orderBy}
        limit ${limit}
        offset ${offset}
      )
      select
        counted.*,
        coalesce(tag_data.tags, '[]'::json) as tags
      from counted
      left join lateral (
        select json_agg(
          json_build_object(
            'id', t.id,
            'user_id', t.user_id,
            'name', t.name,
            'color', t.color,
            'created_at', t.created_at
          )
          order by t.name asc
        ) as tags
        from contact_tags ctag
        join tags t on t.id = ctag.tag_id
        where ctag.contact_id = counted.id
      ) tag_data on true
    `);

    const rows = result.rows as Array<Record<string, unknown>>;

    return NextResponse.json({
      contacts: rows.map((row) => ({
        ...serializeRawContact(row),
        tags: Array.isArray(row.tags) ? row.tags : [],
      })),
      count:
        typeof rows[0]?.total_count === "number" ? rows[0].total_count : 0,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole("agent");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const input = normalizeInput(body);

    if (!input.phone) {
      return NextResponse.json({ error: "phone is required." }, { status: 400 });
    }

    const existing = await findExistingContact(null, ctx.accountId, input.phone);
    if (existing) {
      return NextResponse.json(
        { error: "duplicate_phone", contact: existing },
        { status: 409 },
      );
    }

    try {
      const [created] = await db.transaction(async (tx) => {
        const [contact] = await tx
          .insert(contacts)
          .values({
            userId: ctx.userId,
            accountId: ctx.accountId,
            name: input.name,
            phone: input.phone,
            phoneNormalized: normalizePhone(input.phone),
            email: input.email,
            company: input.company,
          })
          .returning();

        if (input.tagIds.length > 0) {
          const ownedTags = await tx
            .select({ id: tags.id })
            .from(tags)
            .where(
              and(eq(tags.accountId, ctx.accountId), inArray(tags.id, input.tagIds)),
            );
          if (ownedTags.length > 0) {
            await tx.insert(contactTags).values(
              ownedTags.map((tag) => ({
                contactId: contact.id,
                tagId: tag.id,
              })),
            );
          }
        }
        return [contact];
      });

      const contact = serializeContact(created);
      await publishRealtimeEvent("contact.created", {
        accountId: ctx.accountId,
        payload: { contact },
      }).catch((error) => {
        console.warn("[realtime] failed to publish contact.created:", error);
      });

      return NextResponse.json({ contact }, { status: 201 });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await findExistingContact(null, ctx.accountId, input.phone);
        return NextResponse.json(
          { error: "duplicate_phone", contact: raced },
          { status: 409 },
        );
      }
      throw error;
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireDbRole("agent");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const input = normalizeInput(body);

    if (!id || !input.phone) {
      return NextResponse.json({ error: "id and phone are required." }, { status: 400 });
    }

    const [updated] = await db
      .update(contacts)
      .set({
        name: input.name,
        phone: input.phone,
        phoneNormalized: normalizePhone(input.phone),
        email: input.email,
        company: input.company,
        updatedAt: new Date(),
      })
      .where(and(eq(contacts.id, id), eq(contacts.accountId, ctx.accountId)))
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Contact not found." }, { status: 404 });
    }

    await db.transaction(async (tx) => {
      await tx.delete(contactTags).where(eq(contactTags.contactId, id));
      if (input.tagIds.length === 0) return;
      const ownedTags = await tx
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.accountId, ctx.accountId), inArray(tags.id, input.tagIds)));
      if (ownedTags.length > 0) {
        await tx.insert(contactTags).values(
          ownedTags.map((tag) => ({ contactId: id, tagId: tag.id })),
        );
      }
    });

    const contact = serializeContact(updated);
    await publishRealtimeEvent("contact.updated", {
      accountId: ctx.accountId,
      payload: { contact },
    }).catch((error) => {
      console.warn("[realtime] failed to publish contact.updated:", error);
    });

    return NextResponse.json({ contact });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return NextResponse.json({ error: "duplicate_phone" }, { status: 409 });
    }
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireDbRole("agent");
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const ids = (url.searchParams.get("ids") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const targets = id ? [id] : ids;
    if (targets.length === 0) {
      return NextResponse.json({ error: "id is required." }, { status: 400 });
    }

    const deleted = await db
      .delete(contacts)
      .where(
        and(
          eq(contacts.accountId, ctx.accountId),
          targets.length === 1 ? eq(contacts.id, targets[0]) : inArray(contacts.id, targets),
        ),
      )
      .returning({ id: contacts.id });

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Contact not found." }, { status: 404 });
    }

    await Promise.all(
      deleted.map((contact) =>
        publishRealtimeEvent("contact.deleted", {
          accountId: ctx.accountId,
          payload: { contact },
        }).catch((error) => {
          console.warn("[realtime] failed to publish contact.deleted:", error);
        }),
      ),
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
