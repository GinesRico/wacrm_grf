import { NextResponse } from "next/server";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";

export async function GET() {
  try {
    const ctx = await getCurrentDbAccount();
    return NextResponse.json({
      user: ctx.user,
      profile: ctx.profile,
      account: ctx.account,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
