"use client";

import { useCallback, useEffect, useRef } from "react";

type ResyncReason = "visible" | "focus" | "online" | "hidden-poll";

interface UseVisibilityResyncOptions {
  enabled?: boolean;
  minVisibleIntervalMs?: number;
  hiddenPollIntervalMs?: number;
  onResync: (reason: ResyncReason) => void | Promise<void>;
}

export function useVisibilityResync({
  enabled = true,
  minVisibleIntervalMs = 30_000,
  hiddenPollIntervalMs = 300_000,
  onResync,
}: UseVisibilityResyncOptions) {
  const onResyncRef = useRef(onResync);
  const lastConfirmedAtRef = useRef(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    onResyncRef.current = onResync;
  }, [onResync]);

  const run = useCallback(
    async (reason: ResyncReason, minIntervalMs: number) => {
      if (!enabled || inFlightRef.current) return;
      const now = Date.now();
      if (now - lastConfirmedAtRef.current < minIntervalMs) return;

      inFlightRef.current = true;
      try {
        await onResyncRef.current(reason);
        lastConfirmedAtRef.current = Date.now();
      } finally {
        inFlightRef.current = false;
      }
    },
    [enabled],
  );

  useEffect(() => {
    if (!enabled) return;

    const reconcileVisible = (reason: ResyncReason) => {
      void run(reason, minVisibleIntervalMs);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") reconcileVisible("visible");
    };
    const onFocus = () => reconcileVisible("focus");
    const onOnline = () => void run("online", 0);

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);

    const hiddenPoll = window.setInterval(() => {
      if (document.visibilityState === "hidden") {
        void run("hidden-poll", hiddenPollIntervalMs);
      }
    }, hiddenPollIntervalMs);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      window.clearInterval(hiddenPoll);
    };
  }, [enabled, hiddenPollIntervalMs, minVisibleIntervalMs, run]);
}
