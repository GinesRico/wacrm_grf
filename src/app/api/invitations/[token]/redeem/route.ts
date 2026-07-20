import { and, count, eq, isNull, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { accountInvitations, crmAccounts, profiles } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { hashInviteToken } from "@/lib/auth/invitations";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

const BUSINESS_TABLES = [
  "contacts",
  "conversations",
  "broadcasts",
  "automations",
  "flows",
  "pipelines",
  "message_templates",
  "tags",
  "custom_fields",
  "contact_notes",
  "whatsapp_config",
] as const;

function getClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

async function hasBusinessData(accountId: string): Promise<boolean> {
  for (const table of BUSINESS_TABLES) {
    try {
      const result = await db.execute(
        sql.raw(`select count(*)::int as count from ${table} where account_id = '${accountId.replaceAll("'", "''")}'`),
      );
      if (Number((result.rows[0] as { count?: number } | undefined)?.count ?? 0) > 0) {
        return true;
      }
    } catch (error) {
      if ((error as { code?: string })?.code !== "42P01") throw error;
    }
  }
  return false;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const ip = getClientIp(request);
  const limit = checkRateLimit(`redeem:${ip}`, RATE_LIMITS.invitationRedeem);
  if (!limit.success) return rateLimitResponse(limit);

  const { token } = await params;
  if (!token || typeof token !== "string") {
    return NextResponse.json({ error: "Missing invitation token" }, { status: 400 });
  }

  const ctx = await getCurrentDbAccount().catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [invite] = await db
    .select()
    .from(accountInvitations)
    .where(eq(accountInvitations.tokenHash, hashInviteToken(token)))
    .limit(1);

  if (!invite) return NextResponse.json({ error: "Invitation not found" }, { status: 400 });
  if (invite.acceptedAt) {
    return NextResponse.json({ error: "Invitation has already been redeemed" }, { status: 400 });
  }
  if (invite.expiresAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: "Invitation has expired" }, { status: 400 });
  }
  if (invite.accountId === ctx.accountId) {
    return NextResponse.json(
      { error: "You are already a member of this account" },
      { status: 409 },
    );
  }
  if (ctx.account.owner_user_id !== ctx.userId) {
    return NextResponse.json(
      { error: "You are already in a shared account; sign up with a different email to join this one" },
      { status: 409 },
    );
  }

  const [memberCount] = await db
    .select({ value: count() })
    .from(profiles)
    .where(eq(profiles.accountId, ctx.accountId));
  if ((memberCount?.value ?? 0) > 1) {
    return NextResponse.json(
      { error: "Your account already has members; sign up with a different email to join this one" },
      { status: 409 },
    );
  }

  if (await hasBusinessData(ctx.accountId)) {
    return NextResponse.json(
      { error: "Your account already contains data; sign up with a different email to join this one" },
      { status: 409 },
    );
  }

  const accepted = await db.transaction(async (tx) => {
    const [acceptedInvite] = await tx
      .update(accountInvitations)
      .set({ acceptedAt: new Date(), acceptedByUserId: ctx.userId })
      .where(and(eq(accountInvitations.id, invite.id), isNull(accountInvitations.acceptedAt)))
      .returning({ id: accountInvitations.id });

    if (!acceptedInvite) return false;

    await tx
      .update(profiles)
      .set({
        accountId: invite.accountId,
        accountRole: invite.role,
        updatedAt: new Date(),
      })
      .where(eq(profiles.userId, ctx.userId));

    await tx.delete(crmAccounts).where(eq(crmAccounts.id, ctx.accountId));
    return true;
  });

  if (!accepted) {
    return NextResponse.json(
      { error: "Invitation has already been redeemed" },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true, accountId: invite.accountId });
}
