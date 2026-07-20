import { NextResponse } from "next/server";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  contactNotes,
  contactTags,
  contacts,
  messages,
  tags,
} from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";

const MEDIA_TYPES = ["image", "video", "audio", "document", "sticker"];

function toContact(row: typeof contacts.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    phone: row.phone,
    phone_normalized: row.phoneNormalized,
    name: row.name,
    email: row.email,
    company: row.company,
    avatar_url: row.avatarUrl,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function toMessage(row: typeof messages.$inferSelect) {
  return {
    id: row.id,
    conversation_id: row.conversationId,
    sender_type: row.senderType,
    sender_id: row.senderId,
    content_type: row.contentType,
    content_text: row.contentText,
    media_url: row.mediaUrl,
    template_name: row.templateName,
    message_id: row.messageId,
    status: row.status,
    reply_to_message_id: row.replyToMessageId,
    interactive_reply_id: row.interactiveReplyId,
    interactive_payload: row.interactivePayload,
    is_forwarded: row.isForwarded,
    forwarded_from_message_id: row.forwardedFromMessageId,
    deleted_at: row.deletedAt?.toISOString() ?? null,
    deleted_by_user_id: row.deletedByUserId,
    is_starred: row.isStarred,
    ai_generated: row.aiGenerated,
    created_at: row.createdAt.toISOString(),
  };
}

function toNote(row: typeof contactNotes.$inferSelect) {
  return {
    id: row.id,
    contact_id: row.contactId,
    account_id: row.accountId,
    user_id: row.userId,
    note_text: row.noteText,
    created_at: row.createdAt.toISOString(),
  };
}

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

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentDbAccount();
    const url = new URL(request.url);
    const contactId = url.searchParams.get("contact_id");
    const conversationId = url.searchParams.get("conversation_id");

    if (!contactId) {
      return NextResponse.json({ error: "contact_id is required." }, { status: 400 });
    }

    const [contact] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId)))
      .limit(1);

    if (!contact) {
      return NextResponse.json({ error: "Contact not found." }, { status: 404 });
    }

    const [deals, notes, tagRows, starredRows, mediaRows] = await Promise.all([
      safeDeals(contactId, ctx.accountId),
      db
        .select()
        .from(contactNotes)
        .where(and(eq(contactNotes.contactId, contactId), eq(contactNotes.accountId, ctx.accountId)))
        .orderBy(desc(contactNotes.createdAt)),
      db
        .select({
          contact_tag_id: contactTags.id,
          id: tags.id,
          user_id: tags.userId,
          name: tags.name,
          color: tags.color,
          created_at: tags.createdAt,
        })
        .from(contactTags)
        .innerJoin(tags, eq(tags.id, contactTags.tagId))
        .where(eq(contactTags.contactId, contactId)),
      conversationId
        ? db
            .select()
            .from(messages)
            .where(and(eq(messages.conversationId, conversationId), eq(messages.isStarred, true)))
            .orderBy(desc(messages.createdAt))
        : Promise.resolve([]),
      conversationId
        ? db
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.conversationId, conversationId),
                inArray(messages.contentType, MEDIA_TYPES),
                isNotNull(messages.mediaUrl),
              ),
            )
            .orderBy(desc(messages.createdAt))
        : Promise.resolve([]),
    ]);

    return NextResponse.json({
      contact: toContact(contact),
      deals,
      notes: notes.map(toNote),
      tags: tagRows.map((row) => ({
        id: row.id,
        user_id: row.user_id,
        name: row.name,
        color: row.color,
        created_at: row.created_at.toISOString(),
        contact_tag_id: row.contact_tag_id,
      })),
      starredMessages: starredRows.map(toMessage),
      mediaMessages: mediaRows.map(toMessage),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
