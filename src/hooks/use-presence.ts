"use client";

import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import {
  subscribeRealtimeChannel,
  unsubscribeRealtimeChannel,
} from "@/lib/realtime/soketi-client";
import {
  derivePresence,
  type PresenceRow,
  type PresenceStatus,
  type StoredPresence,
} from "@/lib/presence";

const RE_DERIVE_MS = 15_000;

type PresenceMap = Map<string, PresenceRow>;

interface UsePresenceResult {
  getPresence: (userId: string) => PresenceStatus;
  getRow: (userId: string) => PresenceRow | undefined;
  now: number;
}

export function usePresence(enabled = true): UsePresenceResult {
  const { accountId } = useAuth();
  const [rows, setRows] = useState<PresenceMap>(() => new Map());
  const [now, setNow] = useState(() => Date.now());
  const active = enabled && !!accountId;

  useEffect(() => {
    if (!active || !accountId) return;

    let cancelled = false;

    const applyRow = (row: {
      user_id: string;
      status: StoredPresence;
      last_seen_at: string;
    }) => {
      setRows((prev) => {
        const next = new Map(prev);
        next.set(row.user_id, {
          status: row.status,
          last_seen_at: row.last_seen_at,
        });
        return next;
      });
    };

    const channelName = `private-account-${accountId}`;
    const channel = subscribeRealtimeChannel(channelName);
    const handlePresenceUpdated = (event: {
      payload: {
        presence: {
          user_id: string;
          status: StoredPresence;
          last_seen_at: string;
        };
      };
    }) => {
      applyRow(event.payload.presence);
      setNow(Date.now());
    };
    channel.bind("presence.updated", handlePresenceUpdated);

    void fetch("/api/realtime/presence", { cache: "no-store" })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          console.error("[usePresence] initial fetch error:", await response.text());
          return;
        }
        const { presence } = (await response.json()) as {
          presence: {
            user_id: string;
            status: StoredPresence;
            last_seen_at: string;
          }[];
        };
        setRows((prev) => {
          const next = new Map(prev);
          for (const r of presence) {
            const userId = r.user_id;
            const incoming: PresenceRow = {
              status: r.status,
              last_seen_at: r.last_seen_at,
            };
            const existing = next.get(userId);
            if (
              !existing ||
              new Date(incoming.last_seen_at) >= new Date(existing.last_seen_at)
            ) {
              next.set(userId, incoming);
            }
          }
          return next;
        });
      });

    const tick = setInterval(() => setNow(Date.now()), RE_DERIVE_MS);

    return () => {
      cancelled = true;
      clearInterval(tick);
      channel.unbind("presence.updated", handlePresenceUpdated);
      unsubscribeRealtimeChannel(channelName);
    };
  }, [active, accountId]);

  const getRow = useCallback(
    (userId: string): PresenceRow | undefined => rows.get(userId),
    [rows],
  );

  const getPresence = useCallback(
    (userId: string): PresenceStatus => {
      const row = rows.get(userId);
      return derivePresence(row?.status, row?.last_seen_at, now);
    },
    [rows, now],
  );

  return { getPresence, getRow, now };
}
