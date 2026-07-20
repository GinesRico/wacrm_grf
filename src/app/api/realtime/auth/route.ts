import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { conversations } from "@/db/schema";
import { getCurrentDbAccount } from "@/lib/auth/current-account";
import { getRealtimePublisher } from "@/lib/realtime/soketi-server";

type AuthBody = {
  socket_id?: string;
  channel_name?: string;
};

function forbidden() {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

async function readBody(request: Request): Promise<AuthBody> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await request.json().catch(() => ({}))) as AuthBody;
  }
  const form = await request.formData();
  return {
    socket_id: String(form.get("socket_id") ?? ""),
    channel_name: String(form.get("channel_name") ?? ""),
  };
}

async function resolveConversationAccountId(
  conversationId: string,
): Promise<string | null> {
  const [conversation] = await db
    .select({ accountId: conversations.accountId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return conversation?.accountId ?? null;
}

export async function POST(request: Request) {
  const { socket_id: socketId, channel_name: channelName } =
    await readBody(request);
  if (!socketId || !channelName) {
    return NextResponse.json(
      { error: "socket_id and channel_name are required" },
      { status: 400 },
    );
  }

  const profile = await getCurrentDbAccount().catch(() => null);
  if (!profile) return forbidden();

  if (channelName === `private-account-${profile.accountId}`) {
    return NextResponse.json(
      getRealtimePublisher().authorizeChannel(socketId, channelName),
    );
  }

  if (channelName === `presence-account-${profile.accountId}`) {
    return NextResponse.json(
      getRealtimePublisher().authorizeChannel(socketId, channelName, {
        user_id: profile.userId,
        user_info: {
          name: profile.profile.full_name,
          email: profile.profile.email,
        },
      }),
    );
  }

  const conversationPrefix = "private-conversation-";
  if (channelName.startsWith(conversationPrefix)) {
    const conversationId = channelName.slice(conversationPrefix.length);
    const accountId = await resolveConversationAccountId(conversationId);
    if (accountId === profile.accountId) {
      return NextResponse.json(
        getRealtimePublisher().authorizeChannel(socketId, channelName),
      );
    }
  }

  return forbidden();
}
