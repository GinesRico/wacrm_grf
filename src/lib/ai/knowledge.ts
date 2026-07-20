import { and, desc, eq, ilike, or, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { aiKnowledgeChunks } from "@/db/schema";
import type { AiConfig } from "./types";
import { chunkText } from "./chunk";
import { embedTexts, toVectorLiteral } from "./embeddings";

export async function ingestDocument(
  _unusedDb: unknown,
  accountId: string,
  config: Pick<AiConfig, "embeddingsApiKey">,
  documentId: string,
  content: string,
): Promise<void> {
  const chunks = chunkText(content);

  await db
    .delete(aiKnowledgeChunks)
    .where(eq(aiKnowledgeChunks.documentId, documentId));

  if (chunks.length === 0) return;

  let embeddings: number[][] | null = null;
  let embedError: unknown = null;
  if (config.embeddingsApiKey) {
    try {
      embeddings = await embedTexts(config.embeddingsApiKey, chunks);
    } catch (err) {
      embedError = err;
    }
  }

  await db.insert(aiKnowledgeChunks).values(
    chunks.map((content, i) => ({
      documentId,
      accountId,
      chunkIndex: i,
      content,
      embedding: embeddings ? toVectorLiteral(embeddings[i]) : null,
    })),
  );

  if (embedError) throw embedError;
}

export async function retrieveKnowledge(
  _unusedDb: unknown,
  accountId: string,
  _config: Pick<AiConfig, "embeddingsApiKey">,
  queryText: string,
  k = 5,
): Promise<string[]> {
  const query = queryText.trim();
  if (!query || k <= 0) return [];

  try {
    const terms = query
      .split(/\s+/)
      .map((term) => term.replace(/[%_]/g, ""))
      .filter((term) => term.length >= 3)
      .slice(0, 6);

    const predicates = terms.map((term) =>
      ilike(aiKnowledgeChunks.content, `%${term}%`),
    );
    const where =
      predicates.length > 0
        ? and(eq(aiKnowledgeChunks.accountId, accountId), or(...predicates))
        : eq(aiKnowledgeChunks.accountId, accountId);

    const rows = await db
      .select({
        content: aiKnowledgeChunks.content,
        rank: sql<number>`ts_rank_cd(to_tsvector('spanish', ${aiKnowledgeChunks.content}), plainto_tsquery('spanish', ${query}))`,
      })
      .from(aiKnowledgeChunks)
      .where(where)
      .orderBy(desc(sql`2`))
      .limit(k);

    return rows.map((row) => row.content).slice(0, k);
  } catch (err) {
    console.error("[ai knowledge] retrieval failed:", err);
    return [];
  }
}
