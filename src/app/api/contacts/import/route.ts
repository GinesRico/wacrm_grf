import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { contactTags, contacts, tags } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { isUniqueViolation, normalizeKey } from "@/lib/contacts/dedupe";
import { toErrorResponse } from "@/lib/auth/errors";
import { normalizePhone } from "@/lib/whatsapp/phone-utils";

const DEFAULT_TAG_COLOR = "#3b82f6";

interface ImportRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  tagNames?: string[];
}

function asRows(value: unknown): ImportRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    const phone = typeof record.phone === "string" ? record.phone.trim() : "";
    if (!phone) return [];
    return [
      {
        phone,
        name: typeof record.name === "string" ? record.name.trim() : "",
        email: typeof record.email === "string" ? record.email.trim() : "",
        company: typeof record.company === "string" ? record.company.trim() : "",
        tagNames: Array.isArray(record.tagNames)
          ? record.tagNames.filter((tag): tag is string => typeof tag === "string")
          : [],
      },
    ];
  });
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole("agent");
    const canCreateTags = ctx.role === "owner" || ctx.role === "admin";
    const body = await request.json().catch(() => ({}));
    const inputRows = asRows(body?.rows);

    let skipped = 0;
    let failed = 0;
    let imported = 0;

    const seen = new Set<string>();
    const uniqueRows = inputRows.filter((row) => {
      const key = normalizeKey(row.phone);
      if (!key || seen.has(key)) {
        skipped++;
        return false;
      }
      seen.add(key);
      return true;
    });

    const existingRows = await db
      .select({ phoneNormalized: contacts.phoneNormalized })
      .from(contacts)
      .where(eq(contacts.accountId, ctx.accountId));
    const existing = new Set(
      existingRows
        .map((row) => row.phoneNormalized)
        .filter((value): value is string => Boolean(value)),
    );

    const toInsert = uniqueRows.filter((row) => {
      if (existing.has(normalizeKey(row.phone))) {
        skipped++;
        return false;
      }
      return true;
    });

    const allTagNames = Array.from(
      new Set(
        toInsert
          .flatMap((row) => row.tagNames ?? [])
          .map((name) => name.trim())
          .filter(Boolean),
      ),
    );

    const tagIdByKey = new Map<string, string>();
    const skippedNames: string[] = [];
    if (allTagNames.length > 0) {
      const existingTags = await db
        .select()
        .from(tags)
        .where(eq(tags.accountId, ctx.accountId));
      for (const tag of existingTags) {
        tagIdByKey.set(tag.name.trim().toLowerCase(), tag.id);
      }

      const missingNames = allTagNames.filter(
        (name) => !tagIdByKey.has(name.toLowerCase()),
      );
      if (missingNames.length > 0 && canCreateTags) {
        const created = await db
          .insert(tags)
          .values(
            missingNames.map((name) => ({
              accountId: ctx.accountId,
              userId: ctx.userId,
              name,
              color: DEFAULT_TAG_COLOR,
            })),
          )
          .onConflictDoNothing()
          .returning();
        for (const tag of created) {
          tagIdByKey.set(tag.name.trim().toLowerCase(), tag.id);
        }
        const refreshed = await db
          .select()
          .from(tags)
          .where(
            and(
              eq(tags.accountId, ctx.accountId),
              inArray(tags.name, missingNames),
            ),
          );
        for (const tag of refreshed) {
          tagIdByKey.set(tag.name.trim().toLowerCase(), tag.id);
        }
      } else {
        skippedNames.push(...missingNames);
      }
    }

    let tagsAssigned = 0;
    for (const row of toInsert) {
      try {
        const [created] = await db
          .insert(contacts)
          .values({
            accountId: ctx.accountId,
            userId: ctx.userId,
            phone: row.phone,
            phoneNormalized: normalizePhone(row.phone),
            name: row.name || null,
            email: row.email || null,
            company: row.company || null,
          })
          .returning({ id: contacts.id });

        imported++;
        const tagIds = Array.from(
          new Set(
            (row.tagNames ?? [])
              .map((name) => tagIdByKey.get(name.trim().toLowerCase()))
              .filter((id): id is string => Boolean(id)),
          ),
        );
        if (tagIds.length > 0) {
          await db.insert(contactTags).values(
            tagIds.map((tagId) => ({
              contactId: created.id,
              tagId,
            })),
          );
          tagsAssigned += tagIds.length;
        }
      } catch (error) {
        if (isUniqueViolation(error)) skipped++;
        else failed++;
      }
    }

    return NextResponse.json({
      imported,
      skipped,
      failed,
      tagsAssigned,
      skippedNames,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
