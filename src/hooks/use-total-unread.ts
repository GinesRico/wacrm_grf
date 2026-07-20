"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import {
  subscribeRealtimeChannel,
  unsubscribeRealtimeChannel,
} from "@/lib/realtime/soketi-client";
import type { Conversation } from "@/types";

export function useTotalUnread(): number {
  const { accountId } = useAuth();
  const [total, setTotal] = useState(0);
  const countsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!accountId) return;

    let cancelled = false;

    const recompute = () => {
      let sum = 0;
      for (const n of countsRef.current.values()) if (n > 0) sum += 1;
      setTotal(sum);
    };

    void (async () => {
      const response = await fetch("/api/realtime/unread-conversations", {
        cache: "no-store",
      });
      if (cancelled || !response.ok) return;
      const { conversations } = (await response.json()) as {
        conversations: { id: string; unread_count: number }[];
      };

      const map = new Map<string, number>();
      for (const row of conversations) {
        map.set(row.id, row.unread_count ?? 0);
      }
      countsRef.current = map;
      recompute();
    })();

    const channelName = `private-account-${accountId}`;
    const channel = subscribeRealtimeChannel(channelName);
    const upsertConversation = (event: {
      payload: { conversation: Conversation };
    }) => {
      const row = event.payload.conversation;
      countsRef.current.set(row.id, row.unread_count ?? 0);
      recompute();
    };

    channel.bind("conversation.created", upsertConversation);
    channel.bind("conversation.updated", upsertConversation);

    return () => {
      cancelled = true;
      channel.unbind("conversation.created", upsertConversation);
      channel.unbind("conversation.updated", upsertConversation);
      unsubscribeRealtimeChannel(channelName);
    };
  }, [accountId]);

  return total;
}
