// ============================================================
// DELETE /api/account/invitations/[id]
//
// Admin+. Revokes a pending invitation by id. RLS on
// `account_invitations` already restricts the DELETE to admins
// of the inviting account; we lean on it and skip the explicit
// ownership check.
//
// We intentionally delete the row outright rather than soft-
// deleting (a "revoked_at" flag). Once revoked, an invite is
// dead forever — there's no UX where a former invite should be
// listed; the plaintext token is gone too. Hard delete keeps
// the table small.
// ============================================================

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { accountInvitations } from "@/db/schema";
import { requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireDbRole("admin");

    const limit = checkRateLimit(
      `admin:inviteRevoke:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    // No `eq('account_id', ctx.accountId)` — the RLS policy
    // (`is_account_member(account_id, 'admin')`) already scopes
    // the DELETE to invites in the caller's account. Adding the
    // filter would be redundant; omitting it surfaces a
    // cross-account attempt as a silent 0-row delete (which is
    // exactly what we want for a revocation endpoint).
    const deleted = await db
      .delete(accountInvitations)
      .where(
        and(
          eq(accountInvitations.id, id),
          eq(accountInvitations.accountId, ctx.accountId),
        ),
      )
      .returning({ id: accountInvitations.id });

    if (deleted.length === 0) {
      // Either the id doesn't exist or RLS hid it (different
      // account). 404 either way — surfacing "exists but not
      // yours" would leak existence.
      return NextResponse.json(
        { error: "Invitation not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
