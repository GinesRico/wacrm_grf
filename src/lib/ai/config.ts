import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { aiConfigs } from "@/db/schema";
import { decrypt } from "@/lib/whatsapp/encryption";
import type { AiConfig } from "./types";

export async function loadAiConfig(
  _unusedDb: unknown,
  accountId: string,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const { requireActive = true } = opts;
  const [row] = await db
    .select()
    .from(aiConfigs)
    .where(eq(aiConfigs.accountId, accountId))
    .limit(1);

  if (!row) return null;
  if (requireActive && !row.isActive) return null;
  if (!row.apiKey) return null;

  let embeddingsApiKey: string | null = null;
  if (row.embeddingsApiKey) {
    try {
      embeddingsApiKey = decrypt(row.embeddingsApiKey);
    } catch {
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted - check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`,
      );
      embeddingsApiKey = null;
    }
  }

  return {
    provider: row.provider as AiConfig["provider"],
    model: row.model,
    apiKey: decrypt(row.apiKey),
    systemPrompt: row.systemPrompt,
    isActive: row.isActive,
    autoReplyEnabled: row.autoReplyEnabled,
    autoReplyMaxPerConversation: row.autoReplyMaxPerConversation,
    handoffAgentId: row.handoffAgentId,
    embeddingsApiKey,
  };
}

export async function loadEmbeddingsKey(
  _unusedDb: unknown,
  accountId: string,
): Promise<{ key: string | null; corrupt: boolean }> {
  const [row] = await db
    .select({ embeddingsApiKey: aiConfigs.embeddingsApiKey })
    .from(aiConfigs)
    .where(eq(aiConfigs.accountId, accountId))
    .limit(1);

  if (!row?.embeddingsApiKey) return { key: null, corrupt: false };
  try {
    return { key: decrypt(row.embeddingsApiKey), corrupt: false };
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted - check ENCRYPTION_KEY.`,
    );
    return { key: null, corrupt: true };
  }
}
