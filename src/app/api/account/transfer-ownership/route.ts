import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { crmAccounts, profiles } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

function looksLikeUserId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole("owner");

    const limit = checkRateLimit(
      `admin:transferOwnership:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { newOwnerUserId?: unknown }
      | null;
    const newOwnerUserId = body?.newOwnerUserId;

    if (!looksLikeUserId(newOwnerUserId)) {
      return NextResponse.json(
        { error: "'newOwnerUserId' must be a non-empty string" },
        { status: 400 },
      );
    }

    if (newOwnerUserId === ctx.userId) {
      return NextResponse.json({ error: "You are already the owner" }, { status: 400 });
    }

    const result = await db.transaction(async (tx) => {
      const [target] = await tx
        .select({ accountId: profiles.accountId })
        .from(profiles)
        .where(eq(profiles.userId, newOwnerUserId))
        .limit(1);

      if (!target) return { error: "Target user not found", status: 400 as const };
      if (target.accountId !== ctx.accountId) {
        return { error: "Target user is not a member of your account", status: 403 as const };
      }

      await tx
        .update(profiles)
        .set({ accountRole: "admin", updatedAt: new Date() })
        .where(and(eq(profiles.accountId, ctx.accountId), eq(profiles.userId, ctx.userId)));

      await tx
        .update(profiles)
        .set({ accountRole: "owner", updatedAt: new Date() })
        .where(
          and(
            eq(profiles.accountId, ctx.accountId),
            eq(profiles.userId, newOwnerUserId),
          ),
        );

      await tx
        .update(crmAccounts)
        .set({ ownerUserId: newOwnerUserId, updatedAt: new Date() })
        .where(eq(crmAccounts.id, ctx.accountId));

      return { ok: true };
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
