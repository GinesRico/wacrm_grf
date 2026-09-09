"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import {
  subscribeRealtimeChannel,
  unsubscribeRealtimeChannel,
} from "@/lib/realtime/soketi-client";

interface EmailWorkspaceResponse {
  folders?: Array<{ unread_count?: number | null }>;
}

export function useTotalUnreadEmail(): number {
  const { accountId } = useAuth();
  const [total, setTotal] = useState(0);

  const load = useCallback(async () => {
    if (!accountId) return;
    const response = await fetch("/api/email/workspace", { cache: "no-store" });
    if (!response.ok) return;
    const payload = (await response.json().catch(() => ({}))) as EmailWorkspaceResponse;
    const count = (payload.folders ?? []).reduce(
      (sum, folder) => sum + Math.max(0, Number(folder.unread_count ?? 0)),
      0,
    );
    setTotal(count);
  }, [accountId]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;

    void (async () => {
      if (!cancelled) await load();
    })();

    const channelName = `private-account-${accountId}`;
    const channel = subscribeRealtimeChannel(channelName);
    const refresh = () => void load();
    channel.bind("email.message.created", refresh);
    channel.bind("email.message.updated", refresh);
    channel.bind("email.message.deleted", refresh);

    return () => {
      cancelled = true;
      channel.unbind("email.message.created", refresh);
      channel.unbind("email.message.updated", refresh);
      channel.unbind("email.message.deleted", refresh);
      unsubscribeRealtimeChannel(channelName);
    };
  }, [accountId, load]);

  return total;
}
