import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { contacts, profiles } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { serializeContact } from "@/lib/contacts/serialize";
import { serializeProfile } from "@/lib/pipelines/serialize";

export async function GET() {
  try {
    const ctx = await getCurrentDbAccount();
    const [contactRows, profileRows] = await Promise.all([
      db
        .select()
        .from(contacts)
        .where(eq(contacts.accountId, ctx.accountId))
        .orderBy(asc(contacts.name)),
      db
        .select()
        .from(profiles)
        .where(eq(profiles.accountId, ctx.accountId))
        .orderBy(asc(profiles.fullName)),
    ]);

    return NextResponse.json({
      contacts: contactRows.map(serializeContact),
      profiles: profileRows.map(serializeProfile),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
