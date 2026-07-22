"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { useIncomingMessageAlerts } from "@/hooks/use-incoming-message-alerts";
import {
  getRealtimeClient,
  setRealtimeClientConfig,
  subscribeRealtimeChannel,
  unsubscribeRealtimeChannel,
  type RealtimeClientConfig,
} from "@/lib/realtime/soketi-client";

const CHUNK_RELOAD_KEY = "wacrm:last-chunk-reload";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "wacrm:dashboard:sidebar-collapsed";
const REALTIME_DEBUG =
  process.env.NEXT_PUBLIC_REALTIME_DEBUG === "true" ||
  process.env.NODE_ENV !== "production";

function reloadOnceForStaleChunk() {
  try {
    const lastReload = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? "0");
    if (Date.now() - lastReload < 30_000) return;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  } catch {
    // If storage is unavailable, a single reload is still the best recovery.
  }
  window.location.reload();
}

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const t = useTranslations("DashboardShell");
  const { user, loading, profileLoading, accountId } = useAuth();
  const router = useRouter();
  const [realtimeReady, setRealtimeReady] = useState(false);
  const [realtimeError, setRealtimeError] = useState<string | null>(null);
  useIncomingMessageAlerts(Boolean(user) && realtimeReady);

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const handleToggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((value) => {
      const next = !value;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
      } catch {
        // Persistence is best-effort; keep the current tab responsive.
      }
      return next;
    });
  }, []);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
      if (stored !== null) {
        queueMicrotask(() => setSidebarCollapsed(stored === "true"));
      }
    } catch {
      // localStorage can be unavailable in constrained contexts.
    }
  }, []);

  useEffect(() => {
    const handleResourceError = (event: ErrorEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLScriptElement &&
        target.src.includes("/_next/static/")
      ) {
        reloadOnceForStaleChunk();
      }
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason =
        event.reason instanceof Error
          ? event.reason.message
          : String(event.reason ?? "");
      if (/ChunkLoadError|Loading chunk|_next\/static/i.test(reason)) {
        reloadOnceForStaleChunk();
      }
    };

    window.addEventListener("error", handleResourceError, true);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => {
      window.removeEventListener("error", handleResourceError, true);
      window.removeEventListener(
        "unhandledrejection",
        handleUnhandledRejection,
      );
    };
  }, []);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  useEffect(() => {
    let cancelled = false;
    let channelName: string | null = null;

    if (!user) {
      queueMicrotask(() => {
        setRealtimeReady(false);
        setRealtimeError(null);
      });
      return;
    }
    if (!accountId) {
      queueMicrotask(() => {
        setRealtimeReady(false);
        setRealtimeError(
          profileLoading ? null : "Realtime account is not ready.",
        );
      });
      return;
    }

    const loadRealtimeConfig = async () => {
      setRealtimeReady(false);
      setRealtimeError(null);
      try {
        const response = await fetch("/api/realtime/config", {
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => ({}))) as
          | RealtimeClientConfig
          | { error?: string };
        if (
          !response.ok ||
          "error" in payload ||
          !("key" in payload) ||
          !("host" in payload) ||
          !("forceTLS" in payload)
        ) {
          throw new Error(
            "error" in payload && payload.error
              ? payload.error
              : "Realtime config failed.",
          );
        }
        if (!cancelled) {
          const accountChannelName = `private-account-${accountId}`;
          setRealtimeClientConfig(payload);
          getRealtimeClient().connect();
          if (REALTIME_DEBUG) {
            channelName = accountChannelName;
            const channel = subscribeRealtimeChannel(accountChannelName);
            channel.bind("realtime.debug", (event: unknown) => {
              console.info("[realtime] debug event received", event);
            });
            console.info("[realtime] initialized", {
              host: payload.host,
              port: payload.port,
              forceTLS: payload.forceTLS,
              channel: accountChannelName,
            });
          }
          setRealtimeReady(true);
        }
      } catch (error) {
        console.error("[realtime] failed to load config:", error);
        if (!cancelled) {
          setRealtimeError(
            error instanceof Error ? error.message : "Realtime config failed.",
          );
        }
      }
    };

    void loadRealtimeConfig();

    return () => {
      cancelled = true;
      if (channelName) {
        unsubscribeRealtimeChannel(channelName);
      }
    };
  }, [accountId, profileLoading, user]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  if (!realtimeReady) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">
            {realtimeError ?? t("loading")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      <Sidebar
        open={sidebarOpen}
        onClose={closeSidebar}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={handleToggleSidebarCollapsed}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header onOpenSidebar={() => setSidebarOpen(true)} />
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
