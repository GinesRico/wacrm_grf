import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";

export async function GET() {
  try {
    const ctx = await getCurrentDbAccount();
    const rows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.accountId, ctx.accountId))
      .orderBy(asc(contacts.name));

    return NextResponse.json({
      contacts: rows.map((row) => ({
        id: row.id,
        user_id: row.userId,
        account_id: row.accountId,
        phone: row.phone,
        phone_normalized: row.phoneNormalized,
        name: row.name,
        email: row.email,
        company: row.company,
        avatar_url: row.avatarUrl,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
