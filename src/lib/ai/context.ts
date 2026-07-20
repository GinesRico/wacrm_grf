import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { messages } from "@/db/schema";
import type { ChatMessage } from "./types";
import { aiContextMessageLimit } from "./defaults";

export async function buildConversationContext(
  _unusedDb: unknown,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const rows = await db
    .select({
      senderType: messages.senderType,
      contentText: messages.contentText,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.contentType, "text"),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  return rows
    .reverse()
    .filter((message) => message.contentText?.trim())
    .map((message) => ({
      role: message.senderType === "customer" ? "user" : "assistant",
      content: message.contentText!.trim(),
    }));
}
