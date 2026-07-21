"use client";

import Pusher, { type Channel } from "pusher-js";

export interface RealtimeClientConfig {
  key: string;
  host: string;
  port?: number;
  forceTLS: boolean;
  cluster?: string;
}

let client: Pusher | null = null;
let runtimeConfig: RealtimeClientConfig | null = null;

export function setRealtimeClientConfig(config: RealtimeClientConfig) {
  runtimeConfig = config;
  if (client) {
    client.disconnect();
    client = null;
  }
}

function envConfig(): RealtimeClientConfig | null {
  const key = process.env.NEXT_PUBLIC_SOKETI_APP_KEY;
  const host = process.env.NEXT_PUBLIC_SOKETI_HOST;
  if (!key || !host) return null;

  return {
    key,
    host,
    port: process.env.NEXT_PUBLIC_SOKETI_PORT
      ? Number(process.env.NEXT_PUBLIC_SOKETI_PORT)
      : undefined,
    forceTLS: process.env.NEXT_PUBLIC_SOKETI_TLS !== "false",
    cluster: process.env.NEXT_PUBLIC_SOKETI_CLUSTER ?? "mt1",
  };
}

export function getRealtimeClient(): Pusher {
  if (client) return client;

  const config = runtimeConfig ?? envConfig();
  if (!config?.key || !config.host) {
    throw new Error(
      "NEXT_PUBLIC_SOKETI_APP_KEY and NEXT_PUBLIC_SOKETI_HOST are required.",
    );
  }

  client = new Pusher(config.key, {
    cluster: config.cluster ?? "mt1",
    wsHost: config.host,
    wsPort: config.port,
    wssPort: config.port,
    forceTLS: config.forceTLS,
    enabledTransports: [config.forceTLS ? "wss" : "ws"],
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
