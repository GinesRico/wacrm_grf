"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import type { InteractiveMessagePayload, Message, MessageReaction } from "@/types";
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  FileText,
  MapPin,
  ImageOff,
  CornerDownLeft,
  Sparkles,
  Ban,
  X,
  Download,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Forward,
  ExternalLink,
} from "lucide-react";
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";
import { InteractivePreview } from "@/components/interactive/interactive-preview";
import { WhatsAppText } from "./whatsapp-text";
import { useTranslations } from "next-intl";
import { resolveTemplateButtonUrl } from "@/lib/inbox/template-buttons";

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string; messageId?: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
  templateFallbackPayload?: InteractiveMessagePayload | null;
  onJumpToMessage?: (messageId: string) => void;
}

function StatusIcon({ status }: { status: Message["status"] }) {
  switch (status) {
    case "sending":
      return <Clock className="h-3 w-3 text-muted-foreground" />;
    case "sent":
      return <Check className="h-3 w-3 text-muted-foreground" />;
    case "delivered":
      return <CheckCheck className="h-3 w-3 text-muted-foreground" />;
    case "read":
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case "failed":
      return <XCircle className="h-3 w-3 text-red-400" />;
    default:
      return null;
  }
}

function MediaUnavailable({ label, t }: { label: string, t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{t("unavailable", { label })}</span>
    </div>
  );
}

function MediaViewer({
  open,
  kind,
  src,
  alt,
  onClose,
  t,
}: {
  open: boolean;
  kind: "image" | "video";
  src: string;
  alt: string;
  onClose: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const closeViewer = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    onClose();
  }, [onClose]);

  const updateZoom = useCallback((nextZoom: number) => {
    const normalized = Math.min(5, Math.max(1, Number(nextZoom.toFixed(2))));
    setZoom(normalized);
    if (normalized === 1) setPan({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeViewer();
      if (kind === "image" && (event.key === "+" || event.key === "=")) {
        updateZoom(zoom + 0.25);
      }
      if (kind === "image" && event.key === "-") {
        updateZoom(zoom - 0.25);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeViewer, kind, open, updateZoom, zoom]);

  if (!open) return null;

  const adjustZoom = (delta: number) => {
    updateZoom(zoom + delta);
  };

  const resetZoom = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={kind === "image" ? t("openImage") : t("openVideo")}
      onClick={closeViewer}
    >
      <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
        {kind === "image" ? (
          <>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                adjustZoom(-0.25);
              }}
              className="flex size-10 items-center justify-center rounded-full bg-black/55 text-white transition hover:bg-black/75"
              aria-label={t("zoomOut")}
              title={t("zoomOut")}
            >
              <ZoomOut className="size-5" />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                resetZoom();
              }}
              className="flex size-10 items-center justify-center rounded-full bg-black/55 text-white transition hover:bg-black/75"
              aria-label={t("resetZoom")}
              title={t("resetZoom")}
            >
              <RotateCcw className="size-5" />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                adjustZoom(0.25);
              }}
              className="flex size-10 items-center justify-center rounded-full bg-black/55 text-white transition hover:bg-black/75"
              aria-label={t("zoomIn")}
              title={t("zoomIn")}
            >
              <ZoomIn className="size-5" />
            </button>
          </>
        ) : null}
        <a
          href={src}
          download
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="flex size-10 items-center justify-center rounded-full bg-black/55 text-white transition hover:bg-black/75"
          aria-label={t("downloadMedia")}
          title={t("downloadMedia")}
        >
          <Download className="size-5" />
        </a>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            closeViewer();
          }}
          className="flex size-10 items-center justify-center rounded-full bg-black/55 text-white transition hover:bg-black/75"
          aria-label={t("closeViewer")}
          title={t("closeViewer")}
        >
          <X className="size-6" />
        </button>
      </div>

      <div
        className="flex h-full w-full items-center justify-center overflow-hidden"
        onClick={(event) => event.stopPropagation()}
        onWheel={
          kind === "image"
            ? (event) => {
                event.preventDefault();
                adjustZoom(event.deltaY > 0 ? -0.15 : 0.15);
              }
            : undefined
        }
        onPointerDown={
          kind === "image" && zoom > 1
            ? (event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                dragRef.current = {
                  pointerId: event.pointerId,
                  startX: event.clientX,
                  startY: event.clientY,
                  originX: pan.x,
                  originY: pan.y,
                };
              }
            : undefined
        }
        onPointerMove={
          kind === "image" && zoom > 1
            ? (event) => {
                const drag = dragRef.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                setPan({
                  x: drag.originX + event.clientX - drag.startX,
                  y: drag.originY + event.clientY - drag.startY,
                });
              }
            : undefined
        }
        onPointerUp={
          kind === "image"
            ? (event) => {
                if (dragRef.current?.pointerId === event.pointerId) {
                  dragRef.current = null;
                }
              }
            : undefined
        }
        onPointerCancel={
          kind === "image"
            ? () => {
                dragRef.current = null;
              }
            : undefined
        }
      >
        {kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={alt}
            className={cn(
              "max-h-[92vh] max-w-[92vw] select-none rounded-md object-contain transition-transform duration-100",
              zoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
            )}
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
              transformOrigin: "center center",
              touchAction: "none",
            }}
            draggable={false}
          />
        ) : (
          <video
            src={src}
            controls
            autoPlay
            className="max-h-[88vh] max-w-[88vw] rounded-md bg-black shadow-2xl"
          />
        )}
      </div>
    </div>
  );
}

function MediaImage({
  url,
  alt,
  t,
  sticker = false,
}: {
  url: string;
  alt: string;
  t: ReturnType<typeof useTranslations>;
  sticker?: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [viewerOpen, setViewerOpen] = useState(false);

  const loadImage = useCallback(async () => {
    if (!url) return;

    // Proxy URLs need auth fetch to create blob URL
    if (url.startsWith("/api/whatsapp/media/")) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load media");
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        setSrc(blobUrl);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    } else {
      setSrc(url);
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    loadImage();
    return () => {
      if (src?.startsWith("blob:")) {
        URL.revokeObjectURL(src);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadImage]);

  if (error) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-lg bg-muted",
          sticker ? "h-32 w-32 bg-transparent" : "h-40 w-60",
        )}
      >
        <ImageOff className="h-8 w-8 text-muted-foreground" />
      </div>
    );
  }

  if (loading) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-lg bg-muted",
          sticker ? "h-32 w-32 bg-transparent" : "h-40 w-60",
        )}
      >
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setViewerOpen(true)}
        className="block overflow-hidden rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
        aria-label={t("openImage")}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src ?? ""}
          alt={alt}
          className={cn(
            "cursor-zoom-in transition brightness-100 hover:brightness-95",
            sticker
              ? "max-h-40 max-w-40 object-contain"
              : "max-h-64 max-w-60 rounded-lg object-cover",
          )}
          onError={() => setError(true)}
        />
      </button>
      {src ? (
        <MediaViewer
          open={viewerOpen}
          kind="image"
          src={src}
          alt={alt}
          onClose={() => setViewerOpen(false)}
          t={t}
        />
      ) : null}
    </>
  );
}

function MediaVideo({
  url,
  t,
}: {
  url: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const [viewerOpen, setViewerOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setViewerOpen(true)}
        className="block overflow-hidden rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
        aria-label={t("openVideo")}
      >
        <video
          src={url}
          className="max-h-64 max-w-60 cursor-zoom-in rounded-lg bg-black object-cover transition brightness-100 hover:brightness-95"
          preload="metadata"
          muted
        />
      </button>
      <MediaViewer
        open={viewerOpen}
        kind="video"
        src={url}
        alt={t("video")}
        onClose={() => setViewerOpen(false)}
        t={t}
      />
    </>
  );
}

function TemplateActions({
  payload,
  onPrimary,
}: {
  payload: InteractiveMessagePayload;
  onPrimary: boolean;
}) {
  const buttonClass = cn(
    "flex w-full items-center justify-center gap-2 border-t px-3 py-2 text-sm font-medium",
    onPrimary
      ? "border-primary-foreground/25 text-primary-foreground"
      : "border-border text-primary",
  );

  return (
    <div className="mt-2 overflow-hidden">
      {payload.footer ? (
        <p
          className={cn(
            "px-1 py-2 text-[11px]",
            onPrimary ? "text-primary-foreground/70" : "text-muted-foreground",
          )}
        >
          <WhatsAppText text={payload.footer} />
        </p>
      ) : null}
      {payload.kind === "buttons" ? (
        payload.buttons.map((button, index) => {
          const href = resolveTemplateButtonUrl(button);
          const content = (
            <>
              {href ? (
                <ExternalLink className="size-3.5" />
              ) : (
                <CornerDownLeft className="size-3.5" />
              )}
              <span className="truncate">
                <WhatsAppText text={button.title} />
              </span>
            </>
          );

          return href ? (
            <a
              key={button.id || index}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}
              className={buttonClass}
            >
              {content}
            </a>
          ) : (
            <button
              key={button.id || index}
              type="button"
              disabled
              className={buttonClass}
            >
              {content}
            </button>
          );
        })
      ) : (
        <button
          type="button"
          disabled
          className={cn(
            "flex w-full items-center justify-center gap-2 border-t px-3 py-2 text-sm font-medium",
            onPrimary
              ? "border-primary-foreground/25 text-primary-foreground"
              : "border-border text-primary",
          )}
        >
          <CornerDownLeft className="size-3.5" />
          <span className="truncate">{payload.button_label}</span>
        </button>
      )}
    </div>
  );
}

function MessageContent({
  message,
  t,
  templateFallbackPayload,
  onPrimary,
}: {
  message: Message;
  t: ReturnType<typeof useTranslations>;
  templateFallbackPayload?: InteractiveMessagePayload | null;
  onPrimary: boolean;
}) {
  const text = message.content_text ?? "";
  const isUnsupportedText =
    text.trim().toLowerCase() === "[unsupported]" ||
    text.trim().toLowerCase().startsWith("[unsupported message type:");

  if (message.deleted_at) {
    const deletedPreview = message.content_text || (() => {
      switch (message.content_type) {
        case "image":
          return t("photo");
        case "sticker":
          return t("sticker");
        case "video":
          return t("video");
        case "audio":
          return t("audio");
        case "document":
          return t("document");
        case "location":
          return t("locationShared");
        case "template":
          return t("template");
        default:
          return t("unsupported");
      }
    })();

    return (
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide">
          <Ban className="size-3.5" />
          {t("deletedTitle")}
        </span>
        <p className="whitespace-pre-wrap break-words text-sm opacity-80">
          <WhatsAppText text={deletedPreview} />
        </p>
      </div>
    );
  }

  switch (message.content_type) {
    case "text":
      if (isUnsupportedText) {
        return (
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {t("unsupported")}
          </p>
        );
      }
      return (
        <div>
          <p className="whitespace-pre-wrap break-words text-sm">
            <WhatsAppText text={message.content_text} />
          </p>
          {templateFallbackPayload ? (
            <TemplateActions payload={templateFallbackPayload} onPrimary={onPrimary} />
          ) : null}
        </div>
      );

    case "image":
    case "sticker":
      return (
        <div>
          {message.media_url ? (
            <MediaImage
              url={message.media_url}
              alt={
                message.content_type === "sticker"
                  ? t("sharedStickerAlt")
                  : t("sharedImageAlt")
              }
              t={t}
              sticker={message.content_type === "sticker"}
            />
          ) : (
            <MediaUnavailable
              label={message.content_type === "sticker" ? t("sticker") : t("photo")}
              t={t}
            />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              <WhatsAppText text={message.content_text} />
            </p>
          )}
          {message.interactive_payload ? (
            <div className="mt-2">
              <InteractivePreview
                payload={{ ...message.interactive_payload, body: "" }}
                hideEmptyBody
              />
            </div>
          ) : null}
        </div>
      );

    case "video":
      return (
        <div>
          {message.media_url ? (
            <MediaVideo url={message.media_url} t={t} />
          ) : (
            <MediaUnavailable label={t("video")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              <WhatsAppText text={message.content_text} />
            </p>
          )}
          {message.interactive_payload ? (
            <div className="mt-2">
              <InteractivePreview
                payload={{ ...message.interactive_payload, body: "" }}
                hideEmptyBody
              />
            </div>
          ) : null}
        </div>
      );

    case "audio":
      return (
        <div>
          {message.media_url ? (
            <audio src={message.media_url} controls className="max-w-60" />
          ) : (
            <MediaUnavailable label={t("audio")} t={t} />
          )}
        </div>
      );

    case "document":
      if (!message.media_url) {
        return <MediaUnavailable label={message.content_text || t("document")} t={t} />;
      }
      return (
        <a
          href={message.media_url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm hover:bg-muted"
        >
          <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
          <span className="truncate">
            <WhatsAppText text={message.content_text || t("document")} />
          </span>
        </a>
      );

    case "template": {
      const templatePayload = message.interactive_payload ?? templateFallbackPayload;
      return (
        <div>
          {message.content_text && (
            <p className="whitespace-pre-wrap break-words text-sm">
              <WhatsAppText text={message.content_text} />
            </p>
          )}
          {templatePayload ? (
            <TemplateActions payload={templatePayload} onPrimary={onPrimary} />
          ) : null}
        </div>
      );
    }

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>
            <WhatsAppText text={message.content_text || t("locationShared")} />
          </span>
        </div>
      );

    case "interactive": {
      // Three cases share content_type='interactive':
      //  - OUTBOUND with payload (composer / automation / Flow send after
      //    migration 035): render the buttons/list as they appear on the phone.
      //  - INBOUND tap (customer chose an option, sender_type='customer'):
      //    no payload; show the tapped option's title with a reply affordance
      //    so agents can tell it's a tap, not the customer typing.
      //  - OUTBOUND with NO payload (legacy bot/Flow sends from before
      //    migration 035 backfilled the column): show the body text plainly —
      //    it is our own message, NOT a customer tap.
      if (message.interactive_payload) {
        return <InteractivePreview payload={message.interactive_payload} />;
      }
      if (message.sender_type === "customer") {
        return (
          <div className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <CornerDownLeft className="h-3 w-3" />
              {t("buttonReply")}
            </span>
            <p className="whitespace-pre-wrap break-words text-sm">
              <WhatsAppText text={message.content_text || t("interactiveReply")} />
            </p>
          </div>
        );
      }
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          <WhatsAppText text={message.content_text || t("interactiveReply")} />
        </p>
      );
    }

    default:
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          <WhatsAppText text={message.content_text || t("unsupported")} />
        </p>
      );
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
  templateFallbackPayload,
  onJumpToMessage,
}: MessageBubbleProps) {
  const t = useTranslations("Inbox.bubble");

  if (message.content_type === "system") {
    return (
      <div className="flex justify-center py-1">
        <div className="max-w-[80%] rounded-full bg-background/85 px-4 py-2 text-center text-xs italic text-muted-foreground shadow-sm">
          <WhatsAppText text={message.content_text || ""} />
        </div>
      </div>
    );
  }

  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  const isDeleted = Boolean(message.deleted_at);
  const isSticker = message.content_type === "sticker";
  const time = format(new Date(message.created_at), "HH:mm");

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div
      className={cn(
        "flex flex-col",
        isAgent ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "relative rounded-2xl px-3 py-2",
          isDeleted
            ? isAgent
              ? "rounded-br-md border border-primary/20 bg-primary/15 text-primary/80"
              : "rounded-bl-md border border-border bg-muted/50 text-muted-foreground"
            : isSticker
              ? "bg-transparent px-0 py-0 shadow-none"
            : isAgent
              ? "rounded-br-md border border-primary/20 bg-primary-soft-2 text-foreground shadow-sm"
              : "rounded-bl-md bg-muted text-foreground",
        )}
      >
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={false}
            onClick={
              reply.messageId && onJumpToMessage
                ? () => onJumpToMessage(reply.messageId!)
                : undefined
            }
          />
        )}
        {message.is_forwarded && !isDeleted ? (
          <div
            className={cn(
              "mb-1 flex items-center gap-1 text-xs italic",
              "text-muted-foreground",
            )}
          >
            <Forward className="size-3" />
            {t("forwarded")}
          </div>
        ) : null}
        <MessageContent
          message={message}
          t={t}
          templateFallbackPayload={templateFallbackPayload}
          onPrimary={false}
        />
        <div
          className={cn(
            "mt-1 flex items-center gap-1",
            isAgent ? "justify-end" : "justify-start",
          )}
        >
          {/* AI badge — only on replies the auto-reply bot generated
              (always outbound, so it sits on the primary fill). Lets
              agents tell an AI reply from their own / a Flow's at a
              glance. */}
          {message.ai_generated && (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-px text-[9px] font-semibold uppercase leading-none tracking-wide text-primary"
              title={t("aiBadgeTitle")}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {t("aiBadge")}
            </span>
          )}
          <span
            className={cn(
              "text-[10px]",
              // Outbound bubbles sit on the primary fill, so the
              // timestamp must read against that (not the neutral
              // foreground) — otherwise it goes low-contrast in light
              // mode. Inbound bubbles use the muted surface.
              isDeleted
                ? isAgent
                  ? "text-primary/60"
                  : "text-muted-foreground"
                : isAgent
                  ? "text-muted-foreground"
                  : "text-muted-foreground",
            )}
          >
            {time}
          </span>
          {isAgent && !isDeleted && <StatusIcon status={message.status} />}
        </div>
      </div>
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
