import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { accountInvitations, crmAccounts } from "@/db/schema";
import { hashInviteToken } from "@/lib/auth/invitations";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

function getClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const ip = getClientIp(request);
  const limit = checkRateLimit(`peek:${ip}`, RATE_LIMITS.invitationPeek);
  if (!limit.success) return rateLimitResponse(limit);

  const { token } = await params;
  if (!token || typeof token !== "string") {
    return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });
  }

  const [row] = await db
    .select({
      accountName: crmAccounts.name,
      role: accountInvitations.role,
      expiresAt: accountInvitations.expiresAt,
      acceptedAt: accountInvitations.acceptedAt,
    })
    .from(accountInvitations)
    .innerJoin(crmAccounts, eq(crmAccounts.id, accountInvitations.accountId))
    .where(eq(accountInvitations.tokenHash, hashInviteToken(token)))
    .limit(1);

  if (!row) return NextResponse.json({ ok: false, reason: "not_found" });
  if (row.acceptedAt) return NextResponse.json({ ok: false, reason: "used" });
  if (row.expiresAt.getTime() <= Date.now()) {
    return NextResponse.json({ ok: false, reason: "expired" });
  }

  return NextResponse.json({
    ok: true,
    account_name: row.accountName,
    role: row.role,
    expires_at: row.expiresAt.toISOString(),
  });
}
