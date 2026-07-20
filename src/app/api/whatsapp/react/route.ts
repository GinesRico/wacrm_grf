import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { contacts, conversations, messageReactions, messages } from '@/db/schema';
import { getCurrentDbAccount } from '@/lib/auth/current-account';
import { sendReactionMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { getWhatsAppConfigForConversation } from '@/lib/whatsapp/config';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { publishRealtimeEvent } from '@/lib/realtime/soketi-server';

/**
 * POST /api/whatsapp/react
 *
 * Body: { message_id: <internal UUID>, emoji: <single emoji or "" to remove> }
 *
 * Sends the reaction to Meta and mirrors it into `message_reactions`
 * (delete on empty emoji). Customer-side reactions are handled by the
 * webhook — this route only writes `actor_type = 'agent'` rows.
 */
export async function POST(request: Request) {
  try {
    const ctx = await getCurrentDbAccount();

    const limit = checkRateLimit(`react:${ctx.userId}`, RATE_LIMITS.react);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const body = await request.json();
    const { message_id, emoji } = body as {
      message_id?: string;
      emoji?: string;
    };

    if (!message_id || typeof emoji !== 'string') {
      return NextResponse.json(
        { error: 'message_id and emoji are required' },
        { status: 400 },
      );
    }

    // Resolve target message + its conversation; verify ownership.
    const [targetMessage] = await db
      .select({
        id: messages.id,
        messageId: messages.messageId,
        conversationId: messages.conversationId,
      })
      .from(messages)
      .where(eq(messages.id, message_id))
      .limit(1);

    if (!targetMessage) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    if (!targetMessage.messageId) {
      // No Meta ID yet — usually a sending/failed agent message. We can't
      // tell Meta to react to a message it never received.
      return NextResponse.json(
        { error: 'Cannot react to a message that has not been sent to WhatsApp' },
        { status: 400 },
      );
    }

    const [conversation] = await db
      .select({
        id: conversations.id,
        accountId: conversations.accountId,
        contactPhone: contacts.phone,
      })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(
        and(
          eq(conversations.id, targetMessage.conversationId),
          eq(conversations.accountId, ctx.accountId),
        ),
      )
      .limit(1);

    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 },
      );
    }

    if (!conversation.contactPhone) {
      return NextResponse.json(
        { error: 'Contact phone number not found' },
        { status: 400 },
      );
    }

    // WhatsApp config + access token. Conversation-scoped for multi-line.
    const config = await getWhatsAppConfigForConversation(
      null,
      ctx.accountId,
      targetMessage.conversationId,
    );

    if (!config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured.' },
        { status: 400 },
      );
    }

    const accessToken = decrypt(config.access_token);
    const sanitizedPhone = sanitizePhoneForMeta(conversation.contactPhone);

    try {
      await sendReactionMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: sanitizedPhone,
        targetMessageId: targetMessage.messageId,
        emoji,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown Meta API error';
      console.error('[whatsapp/react] Meta send failed:', message);
      return NextResponse.json(
        { error: `Meta API error: ${message}` },
        { status: 502 },
      );
    }

    // Mirror into DB. Empty emoji = removal.
    if (emoji === '') {
      const [existingReaction] = await db
        .select()
        .from(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, targetMessage.id),
            eq(messageReactions.actorType, 'agent'),
            eq(messageReactions.actorId, ctx.userId),
          ),
        )
        .limit(1);

      await db
        .delete(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, targetMessage.id),
            eq(messageReactions.actorType, 'agent'),
            eq(messageReactions.actorId, ctx.userId),
          ),
        );

      if (existingReaction) {
        await publishRealtimeEvent('reaction.deleted', {
          accountId: ctx.accountId,
          conversationId: targetMessage.conversationId,
          payload: { reaction: existingReaction },
        }).catch((error) => {
          console.warn('[realtime] failed to publish reaction.deleted:', error);
        });
      }
    } else {
      // Upsert. The unique constraint (message_id, actor_type, actor_id)
      // lets us swap emoji in a single statement.
      const [savedReaction] = await db
        .insert(messageReactions)
        .values({
          messageId: targetMessage.id,
          conversationId: targetMessage.conversationId,
          actorType: 'agent',
          actorId: ctx.userId,
          emoji,
        })
        .onConflictDoUpdate({
          target: [
            messageReactions.messageId,
            messageReactions.actorType,
            messageReactions.actorId,
          ],
          set: {
            emoji,
            updatedAt: new Date(),
          },
        })
        .returning();

      if (savedReaction) {
        await publishRealtimeEvent('reaction.updated', {
          accountId: ctx.accountId,
          conversationId: targetMessage.conversationId,
          payload: { reaction: savedReaction },
        }).catch((error) => {
          console.warn('[realtime] failed to publish reaction.updated:', error);
        });
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error in WhatsApp react POST:', error);
    return NextResponse.json(
      { error: 'Failed to react to message' },
      { status: 500 },
    );
  }
}
