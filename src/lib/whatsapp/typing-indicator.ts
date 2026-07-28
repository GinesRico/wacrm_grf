import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { crmAccounts, messages } from '@/db/schema';
import { sendTypingIndicator } from '@/lib/whatsapp/meta-api';
import type { WhatsAppLineConfig } from '@/lib/whatsapp/config';

interface MaybeSendTypingIndicatorArgs {
  accountId: string;
  conversationId: string;
  config: WhatsAppLineConfig;
  accessToken: string;
}

export async function maybeSendTypingIndicatorForConversation(
  args: MaybeSendTypingIndicatorArgs,
): Promise<void> {
  const { accountId, conversationId, config, accessToken } = args;

  const [[account], [lastCustomerMessage]] = await Promise.all([
    db
      .select({
        sendTypingIndicators: crmAccounts.sendTypingIndicators,
      })
      .from(crmAccounts)
      .where(eq(crmAccounts.id, accountId))
      .limit(1),
    db
      .select({ messageId: messages.messageId })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.senderType, 'customer'),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1),
  ]);

  if (!account?.sendTypingIndicators || !lastCustomerMessage?.messageId) return;

  try {
    await sendTypingIndicator({
      phoneNumberId: config.phone_number_id,
      accessToken,
      messageId: lastCustomerMessage.messageId,
    });
  } catch (error) {
    console.warn(
      '[whatsapp] typing indicator failed:',
      error instanceof Error ? error.message : error,
    );
  }
}
