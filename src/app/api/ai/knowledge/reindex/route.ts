import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { aiKnowledgeDocuments } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { loadEmbeddingsKey } from "@/lib/ai/config";
import { ingestDocument } from "@/lib/ai/knowledge";
import { AiError } from "@/lib/ai/types";
import { assertFeatureEnabled } from "@/lib/platform/entitlements";

export async function POST() {
  try {
    const { accountId, userId } = await requireDbRole("admin");
    await assertFeatureEnabled(null, accountId, "ai");
    const limit = checkRateLimit(`ai-kb-reindex:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const docs = await db
      .select({ id: aiKnowledgeDocuments.id, content: aiKnowledgeDocuments.content })
      .from(aiKnowledgeDocuments)
      .where(eq(aiKnowledgeDocuments.accountId, accountId));

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(null, accountId);
    if (corrupt) {
      return NextResponse.json(
        {
          success: false,
          reindexed: 0,
          error:
            "Your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key in Settings > AI Assistant). Nothing was reindexed.",
        },
        { status: 200 },
      );
    }

    let reindexed = 0;
    for (const doc of docs) {
      try {
        await ingestDocument(null, accountId, { embeddingsApiKey }, doc.id, doc.content);
        reindexed += 1;
      } catch (err) {
        const message = err instanceof AiError ? err.message : String(err);
        console.error(`[ai/knowledge/reindex] doc ${doc.id} failed:`, message);
        return NextResponse.json(
          {
            success: false,
            reindexed,
            total: docs.length,
            error: `Reindexed ${reindexed}, then hit an error: ${message}`,
          },
          { status: 200 },
        );
      }
    }

    return NextResponse.json({ success: true, reindexed });
  } catch (err) {
    return toErrorResponse(err);
  }
}
