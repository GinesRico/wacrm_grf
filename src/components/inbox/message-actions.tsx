"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CornerUpLeft,
  Copy,
  Forward,
  Bot,
  SmilePlus,
  Star,
  Trash2,
  CheckSquare,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Message } from "@/types";
import { useTranslations } from "next-intl";
import { useAppConfirm } from "@/hooks/use-app-dialog";

// WhatsApp's own quick-reaction bar starts with these six. Picking the same
// set keeps the affordance familiar without pulling in a 300KB emoji library.
const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

interface MessageActionsProps {
  message: Message;
  onReply: () => void;
  onReact: (emoji: string) => void;
  onDelete: () => void | Promise<void>;
  onToggleStar: () => void | Promise<void>;
  onSelect: () => void;
  onForward: () => void;
  onAiReply: () => void;
  onToggleSelected?: () => void;
  selected?: boolean;
  selectionMode?: boolean;
  children: ReactNode;
}

/**
 * Hover/long-press toolbar wrapper around a `<MessageBubble>`. The bubble
 * itself stays a pure presenter — this component owns the action surface so
 * the bubble's render path is unaffected when the toolbar isn't visible.
 */
export function MessageActions({
  message,
  onReply,
  onReact,
  onDelete,
  onToggleStar,
  onSelect,
  onForward,
  onAiReply,
  onToggleSelected,
  selected = false,
  selectionMode = false,
  children,
}: MessageActionsProps) {
  const t = useTranslations("Inbox.actions");
  const { confirm, confirmDialog } = useAppConfirm();

  // Touch devices have no hover. Long-press fires `contextmenu`; we capture
  // it, suppress the native menu, and pin the toolbar open until the user
  // interacts elsewhere.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 });
  const actionRef = useRef<HTMLDivElement | null>(null);
  const lastTapRef = useRef(0);
  const starred = Boolean(message.is_starred);
  const isDeleted = Boolean(message.deleted_at);

  const isAgent =
    message.sender_type === "agent" || message.sender_type === "bot";

  useEffect(() => {
    if (!menuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (actionRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const menuWidth = 208;
    const menuHeight = 430;
    const margin = 12;
    setMenuPoint({
      x: Math.max(margin, Math.min(e.clientX, window.innerWidth - menuWidth - margin)),
      y: Math.max(margin, Math.min(e.clientY, window.innerHeight - menuHeight - margin)),
    });
    setMenuOpen(true);
  };

  const handleDoubleActivate = () => {
    onReply();
    setMenuOpen(false);
  };

  const handleTouchEnd = () => {
    const now = Date.now();
    if (now - lastTapRef.current < 320) {
      handleDoubleActivate();
      lastTapRef.current = 0;
      return;
    }
    lastTapRef.current = now;
  };

  const handleCopy = async () => {
    const text = message.content_text ?? "";
    if (!text) {
      toast.error(t("nothingToCopy"));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
    setMenuOpen(false);
  };

  const handlePickEmoji = (emoji: string) => {
    onReact(emoji);
    setMenuOpen(false);
  };

  const handleReply = () => {
    onReply();
    setMenuOpen(false);
  };

  const handleForward = () => {
    onForward();
    setMenuOpen(false);
  };

  const handleAiReply = () => {
    onAiReply();
    setMenuOpen(false);
  };

  const handleStar = async () => {
    await onToggleStar();
    toast.success(starred ? t("unstarred") : t("starred"));
    setMenuOpen(false);
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: t("delete"),
      description: t("deleteConfirm"),
      confirmLabel: t("delete"),
      cancelLabel: t("cancel"),
      destructive: true,
    });
    if (!ok) return;
    await onDelete();
    setMenuOpen(false);
  };

  const menuItems = [
    {
      key: "select",
      label: t("select"),
      icon: CheckSquare,
      onClick: () => {
        onSelect();
        setMenuOpen(false);
      },
    },
    ...(
      isDeleted
        ? []
        : [
    {
      key: "reply",
      label: t("reply"),
      icon: CornerUpLeft,
      onClick: handleReply,
    },
    {
      key: "aiReply",
      label: t("replyWithAi"),
      icon: Bot,
      onClick: handleAiReply,
    },
    {
      key: "copy",
      label: t("copy"),
      icon: Copy,
      onClick: handleCopy,
    },
    {
      key: "react",
      label: t("react"),
      icon: SmilePlus,
      onClick: () => handlePickEmoji("👍"),
    },
    {
      key: "forward",
      label: t("forward"),
      icon: Forward,
      onClick: handleForward,
    },
    {
      key: "star",
      label: starred ? t("unstar") : t("star"),
      icon: Star,
      onClick: handleStar,
    },
    {
      key: "delete",
      label: t("delete"),
      icon: Trash2,
      onClick: handleDelete,
      destructive: true,
    },
          ]
    ),
  ];

  // Row alignment lives here (not in MessageBubble) so the `group/actions`
  // hover region matches the bubble's content width — hovering empty space
  // in the row no longer reveals the toolbar.
  return (
    <>
      <div
        className={cn(
          "flex w-full",
          isAgent ? "justify-end" : "justify-start",
        )}
        onContextMenu={handleContextMenu}
        onDoubleClick={handleDoubleActivate}
        onTouchEnd={handleTouchEnd}
        ref={actionRef}
      >
        {/* `min-w-0` lets this flex child actually respect the 75% cap.
         *  Default `min-width: auto` lets content (a long quote preview,
         *  an unbroken URL) push past the cap and shove the row past
         *  100%, which used to bleed across into the contact-sidebar
         *  area. See issue #165. */}
        <div className="group/actions relative min-w-0 max-w-[75%]">
          {selectionMode && (
            <button
              type="button"
              onClick={onToggleSelected}
              className={cn(
                "absolute top-1/2 z-20 flex size-6 -translate-y-1/2 items-center justify-center rounded-full border shadow-sm",
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-popover text-muted-foreground",
                isAgent ? "-left-8" : "-right-8",
              )}
              aria-label={selected ? t("unselect") : t("select")}
            >
              <CheckSquare className="size-3.5" />
            </button>
          )}
          {children}
          {starred && !isDeleted && (
            <span
              className={cn(
                "absolute -bottom-1 z-10 flex size-4 items-center justify-center rounded-full bg-popover text-amber-500 shadow ring-1 ring-border",
                isAgent ? "-left-1" : "-right-1",
              )}
              title={t("star")}
              aria-label={t("star")}
            >
              <Star className="size-3 fill-current" />
            </span>
          )}
          {menuOpen && (
            <div
              className="fixed z-50 w-52 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
              style={{ left: menuPoint.x, top: menuPoint.y }}
              role="menu"
              aria-label={t("messageMenu")}
            >
              {!isDeleted && (
                <div className="mb-1 flex items-center justify-between gap-1 rounded-full border border-border bg-background px-2 py-1 shadow-sm">
                  {QUICK_EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => handlePickEmoji(emoji)}
                      className="flex size-7 items-center justify-center rounded-full text-lg leading-none transition-transform hover:scale-125 hover:bg-muted"
                      aria-label={t("reactWith", { emoji })}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
              <div className="overflow-hidden rounded-lg">
                {menuItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      role="menuitem"
                      onClick={item.onClick}
                      className={cn(
                        "flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-sm transition-colors hover:bg-muted",
                        item.destructive
                          ? "text-destructive"
                          : "text-popover-foreground",
                      )}
                    >
                      <Icon className="size-4" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
      {confirmDialog}
    </>
  );
}
