import { NextResponse } from "next/server";
import { and, count, eq, gt, isNull } from "drizzle-orm";

import { db } from "@/db/client";
import {
  accountInvitations,
  customFields,
  messageTemplates,
  profiles,
  tags,
  whatsappConfig,
} from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";

async function countRows<T>(query: Promise<T[]>) {
  const [row] = (await query) as Array<{ count: number }>;
  return Number(row?.count ?? 0);
}

export async function GET() {
  try {
    const ctx = await getCurrentDbAccount();

    const [
      members,
      pendingInvites,
      templates,
      templatesPending,
      tagCount,
      fieldCount,
      configuredLine,
    ] = await Promise.all([
      countRows(
        db
          .select({ count: count() })
          .from(profiles)
          .where(eq(profiles.accountId, ctx.accountId)),
      ),
      countRows(
        db
          .select({ count: count() })
          .from(accountInvitations)
          .where(
            and(
              eq(accountInvitations.accountId, ctx.accountId),
              isNull(accountInvitations.acceptedAt),
              gt(accountInvitations.expiresAt, new Date()),
            ),
          ),
      ),
      countRows(
        db
          .select({ count: count() })
          .from(messageTemplates)
          .where(eq(messageTemplates.accountId, ctx.accountId)),
      ),
      countRows(
        db
          .select({ count: count() })
          .from(messageTemplates)
          .where(
            and(
              eq(messageTemplates.accountId, ctx.accountId),
              eq(messageTemplates.status, "PENDING"),
            ),
          ),
      ),
      countRows(
        db
          .select({ count: count() })
          .from(tags)
          .where(eq(tags.accountId, ctx.accountId)),
      ),
      countRows(
        db
          .select({ count: count() })
          .from(customFields)
          .where(eq(customFields.accountId, ctx.accountId)),
      ),
      db
        .select({
          phoneNumberId: whatsappConfig.phoneNumberId,
          status: whatsappConfig.status,
        })
        .from(whatsappConfig)
        .where(eq(whatsappConfig.accountId, ctx.accountId))
        .limit(1),
    ]);

    return NextResponse.json({
      counts: {
        members,
        pendingInvites,
        templates,
        templatesPending,
        tags: tagCount,
        customFields: fieldCount,
      },
      whatsapp: {
        configured: Boolean(configuredLine[0]?.phoneNumberId),
        connected: configuredLine[0]?.status === "connected",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
