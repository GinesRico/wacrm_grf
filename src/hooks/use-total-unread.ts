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
  const versionRef = useRef(0);

  useEffect(() => {
    if (!accountId) return;

    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    const recompute = () => {
      let sum = 0;
      for (const n of countsRef.current.values()) if (n > 0) sum += 1;
      setTotal(sum);
    };

    const refresh = async () => {
      const versionAtStart = versionRef.current;
      const response = await fetch("/api/realtime/unread-conversations", {
        cache: "no-store",
      }).catch(() => null);
      if (cancelled || !response?.ok || versionAtStart !== versionRef.current) return;
      const { conversations } = (await response.json().catch(() => ({ conversations: [] }))) as {
        conversations: { id: string; unread_count: number }[];
      };

      const map = new Map<string, number>();
      for (const row of conversations) {
        map.set(row.id, row.unread_count ?? 0);
      }
      countsRef.current = map;
      recompute();
    };

    void refresh();

    const channelName = `private-account-${accountId}`;
    const channel = subscribeRealtimeChannel(channelName);
    const upsertConversation = (event: {
      payload: { conversation: Conversation };
    }) => {
      const row = event.payload.conversation;
      versionRef.current += 1;
      countsRef.current.set(row.id, row.status === "closed" ? 0 : row.unread_count ?? 0);
      recompute();
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void refresh(), 250);
    };
    const removeConversation = (event: { payload?: { conversationId?: string; conversation?: { id?: string } } }) => {
      const id = event.payload?.conversationId ?? event.payload?.conversation?.id;
      if (!id) return;
      versionRef.current += 1;
      countsRef.current.delete(id);
      recompute();
    };
    const refreshOnVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };

    channel.bind("conversation.created", upsertConversation);
    channel.bind("conversation.updated", upsertConversation);
    channel.bind("conversation.deleted", removeConversation);
    window.addEventListener("focus", refreshOnVisibility);
    document.addEventListener("visibilitychange", refreshOnVisibility);

    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      channel.unbind("conversation.created", upsertConversation);
      channel.unbind("conversation.updated", upsertConversation);
      channel.unbind("conversation.deleted", removeConversation);
      window.removeEventListener("focus", refreshOnVisibility);
      document.removeEventListener("visibilitychange", refreshOnVisibility);
      unsubscribeRealtimeChannel(channelName);
    };
  }, [accountId]);

  return total;
}
