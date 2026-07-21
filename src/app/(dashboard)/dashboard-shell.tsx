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

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  useEffect(() => {
    let cancelled = false;
    let channelName: string | null = null;

    if (!user) {
      setRealtimeReady(false);
      setRealtimeError(null);
      return;
    }
    if (!accountId) {
      setRealtimeReady(false);
      setRealtimeError(profileLoading ? null : "Realtime account is not ready.");
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
          channelName = accountChannelName;
          subscribeRealtimeChannel(accountChannelName);
          console.info("[realtime] initialized", {
            host: payload.host,
            port: payload.port,
            forceTLS: payload.forceTLS,
            channel: accountChannelName,
          });
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
        onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
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
