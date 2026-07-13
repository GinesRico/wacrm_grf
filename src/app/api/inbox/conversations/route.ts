import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  listInboxConversations,
  parseInboxSearchParams,
} from "@/lib/inbox/tickets";

export async function GET(request: Request) {
  try {
    const ctx = await requireRole("viewer");
    const url = new URL(request.url);
    const parsed = parseInboxSearchParams(url.searchParams);

    const result = await listInboxConversations(supabaseAdmin(), {
      accountId: ctx.accountId,
      userId: ctx.userId,
      ...parsed,
    });

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
