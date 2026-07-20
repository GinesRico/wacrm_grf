"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import {
  subscribeRealtimeChannel,
  unsubscribeRealtimeChannel,
} from "@/lib/realtime/soketi-client";
import type { Notification } from "@/types";

export function useUnreadNotifications(): number {
  const { accountId } = useAuth();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!accountId) return;

    let cancelled = false;

    void (async () => {
      const response = await fetch("/api/realtime/unread-notifications", {
        cache: "no-store",
      });
      if (cancelled || !response.ok) return;
      const payload = (await response.json()) as { count: number };
      setCount(payload.count ?? 0);
    })();

    const channelName = `private-account-${accountId}`;
    const channel = subscribeRealtimeChannel(channelName);
    const handleCreated = (event: {
      payload: { notification: Notification };
    }) => {
      if (!event.payload.notification.read_at) setCount((n) => n + 1);
    };
    const handleUpdated = (event: {
      payload: { notification: Notification };
    }) => {
      if (event.payload.notification.read_at) {
        setCount((n) => Math.max(0, n - 1));
      }
    };
    const handleDeleted = (event: {
      payload: { notification: Partial<Notification> };
    }) => {
      if (!event.payload.notification.read_at) {
        setCount((n) => Math.max(0, n - 1));
      }
    };

    channel.bind("notification.created", handleCreated);
    channel.bind("notification.updated", handleUpdated);
    channel.bind("notification.deleted", handleDeleted);

    return () => {
      cancelled = true;
      channel.unbind("notification.created", handleCreated);
      channel.unbind("notification.updated", handleUpdated);
      channel.unbind("notification.deleted", handleDeleted);
      unsubscribeRealtimeChannel(channelName);
    };
  }, [accountId]);

  return count;
}
