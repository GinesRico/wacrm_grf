import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { aiConfigs } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { decrypt } from "@/lib/whatsapp/encryption";
import { validateAiCredentials } from "@/lib/ai/validate";
import { AiError, type AiProvider } from "@/lib/ai/types";
import { assertFeatureEnabled } from "@/lib/platform/entitlements";

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireDbRole("admin");
    await assertFeatureEnabled(null, accountId, "ai");

    const limit = checkRateLimit(`ai-test:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const provider = body.provider as AiProvider;
    if (provider !== "openai" && provider !== "anthropic") {
      return NextResponse.json(
        { error: 'provider must be "openai" or "anthropic"' },
        { status: 400 },
      );
    }
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!model) {
      return NextResponse.json({ error: "model is required" }, { status: 400 });
    }

    const rawKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
    let apiKeyPlain = rawKey;
    if (!apiKeyPlain) {
      const [existing] = await db
        .select({ apiKey: aiConfigs.apiKey })
        .from(aiConfigs)
        .where(eq(aiConfigs.accountId, accountId))
        .limit(1);
      if (!existing?.apiKey) {
        return NextResponse.json(
          { error: "Enter an API key to test." },
          { status: 400 },
        );
      }
      try {
        apiKeyPlain = decrypt(existing.apiKey);
      } catch {
        return NextResponse.json(
          { error: "Stored API key could not be decrypted - re-enter your key." },
          { status: 400 },
        );
      }
    }

    try {
      await validateAiCredentials({
        provider,
        model,
        apiKey: apiKeyPlain,
        systemPrompt: null,
        isActive: true,
        autoReplyEnabled: false,
        autoReplyMaxPerConversation: 3,
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
      console.error("[ai/test] validation error:", err);
      return NextResponse.json(
        { error: "Could not validate the API key." },
        { status: 400 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
