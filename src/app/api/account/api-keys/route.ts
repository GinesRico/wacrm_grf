// ============================================================
// /api/account/api-keys
//
//   GET  — list this account's API keys (safe columns only).
//   POST — mint a new key.
//
// These are the *dashboard* endpoints for managing keys, so they
// authenticate the normal way (cookie session) and go through the
// RLS client. Listing is open to any member (viewer+) — the roster
// is not secret; the secret (the key itself) is never in it. Minting
// is admin+ (a key hands out capabilities), enforced by both
// `requireRole('admin')` here and the `api_keys_insert` RLS policy.
//
// IMPORTANT: the plaintext key is returned exactly ONCE, in the POST
// response. We persist only its SHA-256 hash, so neither GET nor any
// future endpoint can resurface it — same one-time-reveal contract
// as invite links. If the admin loses it, they revoke and re-issue.
// ============================================================

import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { apiKeys } from '@/db/schema';
import { getCurrentDbAccount, requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import { generateApiKey } from '@/lib/api-keys/keys';
import { normalizeScopes } from '@/lib/api-keys/scopes';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { assertFeatureEnabled } from '@/lib/platform/entitlements';

const MAX_NAME_LEN = 80;
// Hard ceiling on caller-supplied expiry (1 year), mirroring the
// invite-link clamp. NULL/absent = never expires.
const MAX_EXPIRY_DAYS = 365;

// Columns safe to expose. `key_hash` is deliberately excluded — it
// never leaves the server.
function serializeKey(key: typeof apiKeys.$inferSelect) {
  return {
    id: key.id,
    name: key.name,
    key_prefix: key.keyPrefix,
    scopes: key.scopes,
    last_used_at: key.lastUsedAt?.toISOString() ?? null,
    expires_at: key.expiresAt?.toISOString() ?? null,
    revoked_at: key.revokedAt?.toISOString() ?? null,
    created_at: key.createdAt.toISOString(),
  };
}

export async function GET() {
  try {
    // Any member can view the roster (RLS allows it); we just need a
    // resolved account context.
    const ctx = await getCurrentDbAccount();

    const keys = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.accountId, ctx.accountId))
      .orderBy(desc(apiKeys.createdAt));

    return NextResponse.json({ keys: keys.map(serializeKey) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole('admin');
    await assertFeatureEnabled(null, ctx.accountId, 'api');

    const limit = checkRateLimit(
      `admin:apiKeyCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      scopes?: unknown;
      expiresInDays?: unknown;
    } | null;

    const rawName = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!rawName) {
      return NextResponse.json(
        { error: "'name' is required" },
        { status: 400 }
      );
    }
    if (rawName.length > MAX_NAME_LEN) {
      return NextResponse.json(
        { error: `Name must be ${MAX_NAME_LEN} characters or fewer` },
        { status: 400 }
      );
    }

    // Scopes default to none if omitted — that yields a key that can
    // only call the scope-free endpoints (e.g. GET /api/v1/me).
    const scopes = normalizeScopes(body?.scopes ?? []);
    if (scopes === null) {
      return NextResponse.json(
        { error: "'scopes' must be an array of known scope strings" },
        { status: 400 }
      );
    }

    let expiresAt: Date | null = null;
    const rawExpiry = body?.expiresInDays;
    if (
      typeof rawExpiry === 'number' &&
      Number.isFinite(rawExpiry) &&
      rawExpiry > 0
    ) {
      const days = Math.min(Math.floor(rawExpiry), MAX_EXPIRY_DAYS);
      expiresAt = new Date(
        Date.now() + days * 24 * 60 * 60 * 1000
      );
    }

    const { plaintext, hash, prefix } = generateApiKey();

    const [key] = await db
      .insert(apiKeys)
      .values({
        accountId: ctx.accountId,
        createdBy: ctx.userId,
        name: rawName,
        keyPrefix: prefix,
        keyHash: hash,
        scopes,
        expiresAt,
      })
      .returning();

    if (!key) {
      return NextResponse.json(
        { error: 'Failed to create API key' },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        key: serializeKey(key),
        // Plaintext — shown to the admin exactly once.
        plaintext,
      },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
