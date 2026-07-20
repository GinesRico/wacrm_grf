import { NextResponse } from "next/server";
import { and, eq, ilike, inArray, ne } from "drizzle-orm";

import { db } from "@/db/client";
import {
  broadcastRecipients,
  broadcasts,
  contactCustomValues,
  contactTags,
  contacts,
} from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { normalizePhone } from "@/lib/whatsapp/phone-utils";

type VariableMapping =
  | { type: "static"; value: string }
  | { type: "field"; value: string }
  | { type: "custom_field"; value: string };

type ContactRow = typeof contacts.$inferSelect;
type CustomValueIndex = Map<string, Map<string, string>>;

interface BroadcastApiResult {
  phone: string;
  status: "sent" | "failed";
  whatsapp_message_id?: string;
  error?: string;
}

const SEND_BATCH_SIZE = 10;
const SEND_BATCH_DELAY_MS = 1000;
const INSERT_BATCH_SIZE = 200;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: ContactRow,
  customValues?: Map<string, string>,
) {
  const keys = Object.keys(variables).sort((a, b) => Number(a) - Number(b));
  return keys.map((key) => {
    const mapping = variables[key];
    if (mapping.type === "static") return mapping.value;
    if (mapping.type === "custom_field") {
      return customValues?.get(mapping.value) ?? "";
    }
    const fieldMap: Record<string, string | null> = {
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      company: contact.company,
    };
    return fieldMap[mapping.value] ?? "";
  });
}

async function fetchCustomValueIndex(contactIds: string[]) {
  const index: CustomValueIndex = new Map();
  if (contactIds.length === 0) return index;

  const PAGE = 500;
  for (let i = 0; i < contactIds.length; i += PAGE) {
    const slice = contactIds.slice(i, i + PAGE);
    const rows = await db
      .select()
      .from(contactCustomValues)
      .where(inArray(contactCustomValues.contactId, slice));
    for (const row of rows) {
      const bucket = index.get(row.contactId) ?? new Map<string, string>();
      bucket.set(row.customFieldId, row.value ?? "");
      index.set(row.contactId, bucket);
    }
  }

  return index;
}

async function resolveCsvContacts(
  accountId: string,
  userId: string,
  rows: Array<{ phone: string; name?: string }>,
) {
  const uniqueByPhone = new Map<string, { phone: string; name?: string }>();
  for (const row of rows) {
    if (row.phone) uniqueByPhone.set(row.phone, row);
  }
  const phones = [...uniqueByPhone.keys()];
  if (phones.length === 0) return [];

  const existing = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.accountId, accountId), inArray(contacts.phone, phones)));
  const byPhone = new Map(existing.map((contact) => [contact.phone, contact]));

  const missing = phones
    .filter((phone) => !byPhone.has(phone))
    .map((phone) => ({
      userId,
      accountId,
      phone,
      phoneNormalized: normalizePhone(phone),
      name: uniqueByPhone.get(phone)?.name ?? null,
    }));

  if (missing.length > 0) {
    const inserted = await db.insert(contacts).values(missing).returning();
    for (const contact of inserted) byPhone.set(contact.phone, contact);
  }

  return phones
    .map((phone) => byPhone.get(phone))
    .filter((contact): contact is ContactRow => Boolean(contact));
}

async function resolveAudience(
  accountId: string,
  userId: string,
  audience: Record<string, unknown>,
) {
  const type = audience.type;
  let resolved: ContactRow[] = [];

  if (type === "all") {
    resolved = await db
      .select()
      .from(contacts)
      .where(eq(contacts.accountId, accountId));
  } else if (type === "tags") {
    const tagIds = Array.isArray(audience.tagIds)
      ? audience.tagIds.filter((id): id is string => typeof id === "string")
      : [];
    if (tagIds.length > 0) {
      const rows = await db
        .select({ contact: contacts })
        .from(contactTags)
        .innerJoin(contacts, eq(contacts.id, contactTags.contactId))
        .where(
          and(
            eq(contacts.accountId, accountId),
            inArray(contactTags.tagId, tagIds),
          ),
        );
      resolved = [...new Map(rows.map((row) => [row.contact.id, row.contact])).values()];
    }
  } else if (type === "custom_field") {
    const filter =
      audience.customField && typeof audience.customField === "object"
        ? (audience.customField as Record<string, unknown>)
        : {};
    const fieldId = typeof filter.fieldId === "string" ? filter.fieldId : "";
    const operator = typeof filter.operator === "string" ? filter.operator : "is";
    const value = typeof filter.value === "string" ? filter.value : "";
    if (fieldId && value) {
      const predicate =
        operator === "is_not"
          ? ne(contactCustomValues.value, value)
          : operator === "contains"
            ? ilike(contactCustomValues.value, `%${value}%`)
            : eq(contactCustomValues.value, value);
      const rows = await db
        .select({ contact: contacts })
        .from(contactCustomValues)
        .innerJoin(contacts, eq(contacts.id, contactCustomValues.contactId))
        .where(
          and(
            eq(contacts.accountId, accountId),
            eq(contactCustomValues.customFieldId, fieldId),
            predicate,
          ),
        );
      resolved = [...new Map(rows.map((row) => [row.contact.id, row.contact])).values()];
    }
  } else if (type === "csv") {
    const csvContacts = Array.isArray(audience.csvContacts)
      ? (audience.csvContacts as Array<{ phone: string; name?: string }>)
      : [];
    resolved = await resolveCsvContacts(accountId, userId, csvContacts);
  }

  const excludeTagIds = Array.isArray(audience.excludeTagIds)
    ? audience.excludeTagIds.filter((id): id is string => typeof id === "string")
    : [];
  if (excludeTagIds.length > 0 && type !== "csv") {
    const excluded = await db
      .select({ contactId: contactTags.contactId })
      .from(contactTags)
      .innerJoin(contacts, eq(contacts.id, contactTags.contactId))
      .where(
        and(
          eq(contacts.accountId, accountId),
          inArray(contactTags.tagId, excludeTagIds),
        ),
      );
    const excludedIds = new Set(excluded.map((row) => row.contactId));
    resolved = resolved.filter((contact) => !excludedIds.has(contact.id));
  }

  return resolved;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole("agent");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const template =
      body.template && typeof body.template === "object"
        ? (body.template as Record<string, unknown>)
        : {};
    const audience =
      body.audience && typeof body.audience === "object"
        ? (body.audience as Record<string, unknown>)
        : { type: "all" };
    const variables =
      body.variables && typeof body.variables === "object"
        ? (body.variables as Record<string, VariableMapping>)
        : {};
    const headerMediaUrl =
      typeof body.headerMediaUrl === "string" ? body.headerMediaUrl.trim() : "";
    const templateName = typeof template.name === "string" ? template.name : "";
    const templateLanguage =
      typeof template.language === "string" && template.language
        ? template.language
        : "en_US";

    if (!name || !templateName) {
      return NextResponse.json(
        { error: "name and template are required." },
        { status: 400 },
      );
    }

    const audienceContacts = await resolveAudience(
      ctx.accountId,
      ctx.userId,
      audience,
    );
    if (audienceContacts.length === 0) {
      return NextResponse.json(
        { error: "No contacts found for this audience." },
        { status: 400 },
      );
    }

    const [broadcast] = await db
      .insert(broadcasts)
      .values({
        userId: ctx.userId,
        accountId: ctx.accountId,
        name,
        templateName,
        templateLanguage,
        templateVariables: variables,
        audienceFilter: audience,
        status: "sending",
        totalRecipients: audienceContacts.length,
        sentCount: 0,
        deliveredCount: 0,
        readCount: 0,
        repliedCount: 0,
        failedCount: 0,
      })
      .returning();

    for (let i = 0; i < audienceContacts.length; i += INSERT_BATCH_SIZE) {
      const chunk = audienceContacts.slice(i, i + INSERT_BATCH_SIZE);
      await db.insert(broadcastRecipients).values(
        chunk.map((contact) => ({
          broadcastId: broadcast.id,
          contactId: contact.id,
          status: "pending",
        })),
      );
    }

    const recipients = await db
      .select({ recipient: broadcastRecipients, contact: contacts })
      .from(broadcastRecipients)
      .innerJoin(contacts, eq(contacts.id, broadcastRecipients.contactId))
      .where(eq(broadcastRecipients.broadcastId, broadcast.id));
    const customValueIndex = await fetchCustomValueIndex(
      recipients.map((row) => row.contact.id),
    );

    const headerType = typeof template.header_type === "string" ? template.header_type : null;
    const isMediaHeader =
      headerType === "image" || headerType === "video" || headerType === "document";
    const messageParams =
      isMediaHeader && headerMediaUrl ? { headerMediaUrl } : undefined;

    let sentCount = 0;
    let failedCount = 0;

    for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
      const batch = recipients.slice(i, i + SEND_BATCH_SIZE);
      const apiRecipients = batch.map((row) => ({
        phone: row.contact.phone,
        params: resolveVariables(
          variables,
          row.contact,
          customValueIndex.get(row.contact.id),
        ),
        ...(messageParams ? { messageParams } : {}),
      }));

      try {
        const res = await fetch(new URL("/api/whatsapp/broadcast", request.url), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            cookie: request.headers.get("cookie") ?? "",
          },
          body: JSON.stringify({
            recipients: apiRecipients,
            template_name: templateName,
            template_language: templateLanguage,
          }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error ?? "Broadcast API request failed");

        const byPhone = new Map<string, BroadcastApiResult>();
        for (const result of (payload.results ?? []) as BroadcastApiResult[]) {
          byPhone.set(result.phone, result);
        }

        for (const row of batch) {
          const result = byPhone.get(row.contact.phone);
          if (result?.status === "sent") {
            sentCount++;
            await db
              .update(broadcastRecipients)
              .set({
                status: "sent",
                sentAt: new Date(),
                whatsappMessageId: result.whatsapp_message_id ?? null,
                errorMessage: null,
              })
              .where(eq(broadcastRecipients.id, row.recipient.id));
          } else {
            failedCount++;
            await db
              .update(broadcastRecipients)
              .set({
                status: "failed",
                errorMessage: result?.error ?? "Unknown error",
              })
              .where(eq(broadcastRecipients.id, row.recipient.id));
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        failedCount += batch.length;
        for (const row of batch) {
          await db
            .update(broadcastRecipients)
            .set({ status: "failed", errorMessage: message })
            .where(eq(broadcastRecipients.id, row.recipient.id));
        }
      }

      if (i + SEND_BATCH_SIZE < recipients.length) {
        await sleep(SEND_BATCH_DELAY_MS);
      }
    }

    await db
      .update(broadcasts)
      .set({
        status: failedCount === recipients.length ? "failed" : "sent",
        sentCount,
        failedCount,
        updatedAt: new Date(),
      })
      .where(eq(broadcasts.id, broadcast.id));

    return NextResponse.json({ broadcast_id: broadcast.id });
  } catch (err) {
    return toErrorResponse(err);
  }
}
