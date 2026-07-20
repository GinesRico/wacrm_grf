"use client";

import Pusher, { type Channel } from "pusher-js";

let client: Pusher | null = null;

export function getRealtimeClient(): Pusher {
  if (client) return client;

  const key = process.env.NEXT_PUBLIC_SOKETI_APP_KEY;
  const host = process.env.NEXT_PUBLIC_SOKETI_HOST;
  if (!key || !host) {
    throw new Error(
      "NEXT_PUBLIC_SOKETI_APP_KEY and NEXT_PUBLIC_SOKETI_HOST are required.",
    );
  }

  const forceTLS = process.env.NEXT_PUBLIC_SOKETI_TLS !== "false";
  client = new Pusher(key, {
    cluster: process.env.NEXT_PUBLIC_SOKETI_CLUSTER ?? "mt1",
    wsHost: host,
    wsPort: process.env.NEXT_PUBLIC_SOKETI_PORT
      ? Number(process.env.NEXT_PUBLIC_SOKETI_PORT)
      : undefined,
    wssPort: process.env.NEXT_PUBLIC_SOKETI_PORT
      ? Number(process.env.NEXT_PUBLIC_SOKETI_PORT)
      : undefined,
    forceTLS,
    enabledTransports: [forceTLS ? "wss" : "ws"],
    disableStats: true,
    authorizer: (channel) => ({
      authorize: async (socketId, callback) => {
        try {
          const response = await fetch("/api/realtime/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              socket_id: socketId,
              channel_name: channel.name,
            }),
          });
          const payload = await response.json();
          if (!response.ok) {
            callback(new Error(payload?.error ?? "Realtime auth failed"), null);
            return;
          }
          callback(null, payload);
        } catch (error) {
          callback(error as Error, null);
        }
      },
    }),
  });

  return client;
}

export function subscribeRealtimeChannel(channelName: string): Channel {
  return getRealtimeClient().subscribe(channelName);
}

export function unsubscribeRealtimeChannel(channelName: string) {
  getRealtimeClient().unsubscribe(channelName);
}

export function disconnectRealtimeClient() {
  client?.disconnect();
  client = null;
}
