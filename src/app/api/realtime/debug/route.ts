import { NextResponse } from "next/server";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { publishRealtimeEvent } from "@/lib/realtime/soketi-server";

export async function POST() {
  const { accountId, userId } = await getCurrentDbAccount();
  await publishRealtimeEvent("realtime.debug", {
    accountId,
    payload: {
      ok: true,
      userId,
      at: new Date().toISOString(),
    },
  });

  return NextResponse.json({ ok: true });
}
