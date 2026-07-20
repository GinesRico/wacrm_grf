import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { aiConfigs, profiles } from "@/db/schema";
import { getCurrentDbAccount, requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { encrypt, decrypt } from "@/lib/whatsapp/encryption";
import { validateAiCredentials } from "@/lib/ai/validate";
import { embedTexts } from "@/lib/ai/embeddings";
import { AiError, type AiProvider } from "@/lib/ai/types";
import { assertFeatureEnabled } from "@/lib/platform/entitlements";

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET() {
  try {
    const { accountId } = await getCurrentDbAccount();
    const [data] = await db
      .select()
      .from(aiConfigs)
      .where(eq(aiConfigs.accountId, accountId))
      .limit(1);

    if (!data) return NextResponse.json({ configured: false });
    return NextResponse.json({
      configured: true,
      has_key: !!data.apiKey,
      has_embeddings_key: !!data.embeddingsApiKey,
      provider: data.provider,
      model: data.model,
      system_prompt: data.systemPrompt,
      is_active: data.isActive,
      auto_reply_enabled: data.autoReplyEnabled,
      auto_reply_max_per_conversation: data.autoReplyMaxPerConversation,
      handoff_agent_id: data.handoffAgentId,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireDbRole("admin");
    await assertFeatureEnabled(null, accountId, "ai");

    const limit = checkRateLimit(`ai-config:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return bad("Invalid request body");

    const provider = body.provider as AiProvider;
    if (provider !== "openai" && provider !== "anthropic") {
      return bad('provider must be "openai" or "anthropic"');
    }
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!model) return bad("model is required");

    const systemPrompt =
      typeof body.system_prompt === "string" && body.system_prompt.trim()
        ? body.system_prompt.trim()
        : null;
    const isActive = body.is_active === true;
    const autoReplyEnabled = body.auto_reply_enabled === true;

    let maxPer = Number(body.auto_reply_max_per_conversation);
    if (!Number.isFinite(maxPer)) maxPer = 3;
    maxPer = Math.min(20, Math.max(1, Math.floor(maxPer)));

    const rawHandoff =
      typeof body.handoff_agent_id === "string" ? body.handoff_agent_id.trim() : "";
    const handoffProvided = "handoff_agent_id" in body;
    let handoffAgentId: string | null = null;
    if (rawHandoff) {
      const [member] = await db
        .select({ userId: profiles.userId })
        .from(profiles)
        .where(and(eq(profiles.accountId, accountId), eq(profiles.userId, rawHandoff)))
        .limit(1);
      if (!member) return bad("handoff_agent_id must be a member of this account");
      handoffAgentId = rawHandoff;
    }

    const rawKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
    const rawEmbeddingsKey =
      typeof body.embeddings_api_key === "string"
        ? body.embeddings_api_key.trim()
        : "";
    const clearEmbeddingsKey = body.embeddings_api_key === null;

    const [existing] = await db
      .select()
      .from(aiConfigs)
      .where(eq(aiConfigs.accountId, accountId))
      .limit(1);

    let apiKeyPlain: string;
    if (rawKey) {
      apiKeyPlain = rawKey;
    } else if (existing?.apiKey) {
      try {
        apiKeyPlain = decrypt(existing.apiKey);
      } catch {
        return bad("Stored API key could not be decrypted - re-enter your key.");
      }
    } else {
      return bad("api_key is required");
    }

    const credentialsChanged =
      !existing ||
      rawKey !== "" ||
      provider !== existing.provider ||
      model !== existing.model;

    if (credentialsChanged) {
      try {
        await validateAiCredentials({
          provider,
          model,
          apiKey: apiKeyPlain,
          systemPrompt,
          isActive,
          autoReplyEnabled,
          autoReplyMaxPerConversation: maxPer,
          handoffAgentId: null,
          embeddingsApiKey: null,
        });
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: err.message, code: err.code },
            { status: 400 },
          );
        }
        console.error("[ai/config POST] validation error:", err);
        return bad("Could not validate the API key with the provider.");
      }
    }

    if (rawEmbeddingsKey) {
      try {
        await embedTexts(rawEmbeddingsKey, ["ping"]);
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: `Embeddings key: ${err.message}`, code: err.code },
            { status: 400 },
          );
        }
        console.error("[ai/config POST] embeddings validation error:", err);
        return bad("Could not validate the embeddings key.");
      }
    }

    const encryptedKey = rawKey ? encrypt(rawKey) : null;
    const shared = {
      provider,
      model,
      systemPrompt,
      isActive,
      autoReplyEnabled,
      autoReplyMaxPerConversation: maxPer,
      ...(handoffProvided ? { handoffAgentId } : {}),
      ...(rawEmbeddingsKey
        ? { embeddingsApiKey: encrypt(rawEmbeddingsKey) }
        : clearEmbeddingsKey
          ? { embeddingsApiKey: null }
          : {}),
    };

    if (existing) {
      await db
        .update(aiConfigs)
        .set(encryptedKey ? { ...shared, apiKey: encryptedKey } : shared)
        .where(eq(aiConfigs.accountId, accountId));
    } else {
      await db.insert(aiConfigs).values({
        accountId,
        createdBy: userId,
        apiKey: encryptedKey ?? encrypt(apiKeyPlain),
        ...shared,
      });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE() {
  try {
    const { accountId } = await requireDbRole("admin");
    await assertFeatureEnabled(null, accountId, "ai");
    await db.delete(aiConfigs).where(eq(aiConfigs.accountId, accountId));
    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
