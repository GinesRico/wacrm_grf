import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { aiKnowledgeDocuments } from "@/db/schema";
import { getCurrentDbAccount, requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { loadEmbeddingsKey } from "@/lib/ai/config";
import { ingestDocument } from "@/lib/ai/knowledge";
import { AiError } from "@/lib/ai/types";
import { assertFeatureEnabled } from "@/lib/platform/entitlements";

export async function GET() {
  try {
    const { accountId } = await getCurrentDbAccount();
    const documents = await db
      .select({
        id: aiKnowledgeDocuments.id,
        title: aiKnowledgeDocuments.title,
        updated_at: aiKnowledgeDocuments.updatedAt,
      })
      .from(aiKnowledgeDocuments)
      .where(eq(aiKnowledgeDocuments.accountId, accountId))
      .orderBy(desc(aiKnowledgeDocuments.updatedAt));

    return NextResponse.json({
      documents: documents.map((doc) => ({
        ...doc,
        updated_at: doc.updated_at.toISOString(),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireDbRole("admin");
    await assertFeatureEnabled(null, accountId, "ai");
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!title || !content) {
      return NextResponse.json(
        { error: "title and content are required" },
        { status: 400 },
      );
    }

    const [doc] = await db
      .insert(aiKnowledgeDocuments)
      .values({ accountId, createdBy: userId, title, content })
      .returning({ id: aiKnowledgeDocuments.id });

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(null, accountId);
    try {
      await ingestDocument(null, accountId, { embeddingsApiKey }, doc.id, content);
    } catch (err) {
      const message = err instanceof AiError ? err.message : "indexing failed";
      console.error("[ai/knowledge POST] ingest error:", err);
      return NextResponse.json(
        {
          success: true,
          id: doc.id,
          warning: `Saved, but semantic indexing failed (${message}). Lexical search still works; use Reindex to retry.`,
        },
        { status: 200 },
      );
    }

    if (corrupt) {
      return NextResponse.json({
        success: true,
        id: doc.id,
        warning:
          "Saved with keyword search only - your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).",
      });
    }
    return NextResponse.json({ success: true, id: doc.id });
  } catch (err) {
    return toErrorResponse(err);
  }
}
