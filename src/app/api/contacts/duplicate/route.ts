import { NextResponse } from "next/server";

import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { findExistingContact, isExactMatch } from "@/lib/contacts/dedupe";

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentDbAccount();
    const url = new URL(request.url);
    const phone = url.searchParams.get("phone") ?? "";
    if (!phone.trim()) return NextResponse.json({ contact: null, exact: false });

    const contact = await findExistingContact(null, ctx.accountId, phone);
    return NextResponse.json({
      contact,
      exact: contact ? isExactMatch(contact, phone) : false,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
