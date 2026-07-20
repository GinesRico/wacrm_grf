"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Bell, CheckCheck, Loader2, UserPlus } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import {
  subscribeRealtimeChannel,
  unsubscribeRealtimeChannel,
} from "@/lib/realtime/soketi-client";
import { cn } from "@/lib/utils";
import type { Notification } from "@/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const TYPE_ICON: Record<Notification["type"], typeof Bell> = {
  conversation_assigned: UserPlus,
};

export function NotificationsMenu() {
  const t = useTranslations("NotificationsPage");
  const router = useRouter();
  const { accountId } = useAuth();
  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  const unreadIds = useMemo(
    () => notifications?.filter((n) => !n.read_at).map((n) => n.id) ?? [],
    [notifications],
  );
  const unreadCount = unreadIds.length;

  const load = useCallback(async () => {
    if (!accountId) return;
    const response = await fetch("/api/notifications", { cache: "no-store" });
    if (!response.ok) {
      setError(await response.text());
      return;
    }
    const data = (await response.json()) as { notifications: Notification[] };

    setError(null);
    setNotifications(data.notifications);
  }, [accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    if (!accountId) return;

    const channelName = `private-account-${accountId}`;
    const channel = subscribeRealtimeChannel(channelName);
    const handleCreated = (event: { payload: { notification: Notification } }) => {
      const row = event.payload.notification;
      setNotifications((prev) => {
        if (!prev) return [row];
        if (prev.some((n) => n.id === row.id)) return prev;
        return [row, ...prev].slice(0, 20);
      });
    };
    const handleUpdated = (event: { payload: { notification: Notification } }) => {
      const row = event.payload.notification;
      setNotifications(
        (prev) =>
          prev?.map((n) => (n.id === row.id ? { ...n, ...row } : n)) ?? prev,
      );
    };
    const handleDeleted = (event: {
      payload: { notification: Partial<Notification> };
    }) => {
      const row = event.payload.notification;
      setNotifications((prev) => prev?.filter((n) => n.id !== row.id) ?? prev);
    };

    channel.bind("notification.created", handleCreated);
    channel.bind("notification.updated", handleUpdated);
    channel.bind("notification.deleted", handleDeleted);

    return () => {
      channel.unbind("notification.created", handleCreated);
      channel.unbind("notification.updated", handleUpdated);
      channel.unbind("notification.deleted", handleDeleted);
      unsubscribeRealtimeChannel(channelName);
    };
  }, [accountId]);

  const markRead = useCallback(
    async (id: string) => {
      const now = new Date().toISOString();
      setNotifications(
        (prev) =>
          prev?.map((n) =>
            n.id === id && !n.read_at ? { ...n, read_at: now } : n,
          ) ?? prev,
      );

      const response = await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      });

      if (!response.ok) {
        toast.error(t("markReadFailed"));
        void load();
      }
    },
    [load, t],
  );

  const handleNotificationClick = useCallback(
    (notification: Notification) => {
      if (!notification.read_at) void markRead(notification.id);
      if (notification.conversation_id) {
        router.push(`/inbox?c=${notification.conversation_id}`);
      }
    },
    [markRead, router],
  );

  const markAllRead = useCallback(async () => {
    if (unreadCount === 0) return;
    setMarkingAll(true);
    const now = new Date().toISOString();
    setNotifications(
      (prev) => prev?.map((n) => (n.read_at ? n : { ...n, read_at: now })) ?? prev,
    );

    const response = await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });

    setMarkingAll(false);
    if (!response.ok) {
      toast.error(t("markAllReadFailed"));
      void load();
    }
  }, [load, t, unreadCount]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="relative inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:bg-muted focus:text-foreground focus:outline-none data-popup-open:bg-muted data-popup-open:text-foreground"
        aria-label={t("title")}
        title={t("title")}
      >
        <Bell className="size-4" />
        {unreadCount > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-[min(360px,calc(100vw-24px))] p-0"
      >
        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">
              {t("title")}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {t("description")}
            </p>
          </div>
          <button
            type="button"
            disabled={unreadCount === 0 || markingAll}
            onClick={() => void markAllRead()}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-primary transition-colors hover:bg-primary/10 disabled:text-muted-foreground disabled:opacity-50"
            title={t("markAllRead")}
            aria-label={t("markAllRead")}
          >
            {markingAll ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CheckCheck className="size-4" />
            )}
          </button>
        </div>
        <DropdownMenuSeparator className="my-0" />
        <div className="max-h-[420px] overflow-y-auto p-1.5">
          {error ? (
            <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
              <p className="text-sm text-destructive">{error}</p>
              <button
                type="button"
                onClick={() => void load()}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
              >
                {t("retry")}
              </button>
            </div>
          ) : notifications === null ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          ) : notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
              <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                <Bell className="size-5 text-primary" />
              </div>
              <p className="mt-3 text-sm font-medium text-foreground">
                {t("emptyTitle")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("emptyDesc")}
              </p>
            </div>
          ) : (
            <ul className="space-y-1">
              {notifications.map((notification) => {
                const Icon = TYPE_ICON[notification.type] ?? Bell;
                const isUnread = !notification.read_at;

                return (
                  <li key={notification.id}>
                    <button
                      type="button"
                      onClick={() => handleNotificationClick(notification)}
                      className={cn(
                        "flex w-full items-start gap-2 rounded-md p-2 text-left transition-colors",
                        isUnread
                          ? "bg-primary/5 hover:bg-primary/10"
                          : "hover:bg-muted",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md",
                          isUnread ? "bg-primary/15" : "bg-muted",
                        )}
                        aria-hidden="true"
                      >
                        <Icon
                          className={cn(
                            "size-4",
                            isUnread ? "text-primary" : "text-muted-foreground",
                          )}
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              "truncate text-sm font-medium",
                              isUnread
                                ? "text-foreground"
                                : "text-muted-foreground",
                            )}
                          >
                            {notification.title}
                          </span>
                          {isUnread ? (
                            <span
                              aria-label={t("unread")}
                              className="size-1.5 shrink-0 rounded-full bg-primary"
                            />
                          ) : null}
                        </span>
                        {notification.body ? (
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {notification.body}
                          </span>
                        ) : null}
                        <span className="mt-1 block text-[11px] text-muted-foreground/70">
                          {formatDistanceToNow(new Date(notification.created_at), {
                            addSuffix: true,
                          })}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
