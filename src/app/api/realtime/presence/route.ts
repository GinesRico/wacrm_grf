import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { memberPresence } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { publishRealtimeEvent } from "@/lib/realtime/soketi-server";

const BodySchema = z.object({
  status: z.enum(["online", "away"]),
});

export async function GET() {
  try {
    const { accountId } = await getCurrentDbAccount();
    const rows = await db
      .select({
        user_id: memberPresence.userId,
        status: memberPresence.status,
        last_seen_at: memberPresence.lastSeenAt,
      })
      .from(memberPresence)
      .where(eq(memberPresence.accountId, accountId));

    return NextResponse.json({
      presence: rows.map((row) => ({
        ...row,
        last_seen_at: row.last_seen_at.toISOString(),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid presence status" }, { status: 400 });
    }
    const { userId, accountId } = await getCurrentDbAccount();
    const now = new Date();

    await db
      .insert(memberPresence)
      .values({
        accountId,
        userId,
        status: parsed.data.status,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [memberPresence.accountId, memberPresence.userId],
        set: {
          status: parsed.data.status,
          lastSeenAt: now,
        },
      });

    const presence = {
      user_id: userId,
      status: parsed.data.status,
      last_seen_at: now.toISOString(),
    };

    await publishRealtimeEvent("presence.updated", {
      accountId,
      payload: { presence },
    }).catch((publishError) => {
      console.warn("[realtime] failed to publish presence.updated:", publishError);
    });

    return NextResponse.json({ ok: true, presence });
  } catch (err) {
    return toErrorResponse(err);
  }
}
