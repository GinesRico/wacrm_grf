import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/client";
import { notifications } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { serializeNotification } from "@/lib/notifications/create-notification";
import { publishRealtimeEvent } from "@/lib/realtime/soketi-server";

const PatchSchema = z.object({
  ids: z.array(z.string().uuid()).optional(),
  all: z.boolean().optional(),
});

export async function GET() {
  try {
    const { accountId, userId } = await getCurrentDbAccount();
    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.accountId, accountId),
          eq(notifications.userId, userId),
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(20);

    return NextResponse.json({ notifications: rows.map(serializeNotification) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const { accountId, userId } = await getCurrentDbAccount();
    const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success || (!parsed.data.all && !parsed.data.ids?.length)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const now = new Date();
    const filter = parsed.data.all
      ? and(
          eq(notifications.accountId, accountId),
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
        )
      : and(
          eq(notifications.accountId, accountId),
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
          inArray(notifications.id, parsed.data.ids ?? []),
        );

    const updated = await db
      .update(notifications)
      .set({ readAt: now })
      .where(filter)
      .returning();

    await Promise.all(
      updated.map((notification) =>
        publishRealtimeEvent("notification.updated", {
          accountId,
          payload: { notification: serializeNotification(notification) },
        }).catch((error) => {
          console.warn("[realtime] failed to publish notification.updated:", error);
        }),
      ),
    );

    return NextResponse.json({
      notifications: updated.map(serializeNotification),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
