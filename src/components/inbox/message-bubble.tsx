'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';
import type {
  InteractiveMessagePayload,
  Message,
  MessageReaction,
} from '@/types';
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
} from 'lucide-react';
import { format } from 'date-fns';
import { ReplyQuote } from './reply-quote';
import { MessageReactions } from './message-reactions';
import { InteractivePreview } from '@/components/interactive/interactive-preview';
import { WhatsAppText } from './whatsapp-text';
import { useTranslations } from 'next-intl';
import { resolveTemplateButtonUrl } from '@/lib/inbox/template-buttons';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

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

function StatusIcon({ status }: { status: Message['status'] }) {
  switch (status) {
    case 'sending':
      return <Clock className="text-muted-foreground h-3 w-3" />;
    case 'sent':
      return <Check className="text-muted-foreground h-3 w-3" />;
    case 'delivered':
      return <CheckCheck className="text-muted-foreground h-3 w-3" />;
    case 'read':
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case 'failed':
      return <XCircle className="h-3 w-3 text-red-400" />;
    default:
      return null;
  }
}

function formatMessageInfoDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
}

function statusLabel(
  status: Message['status'],
  t: ReturnType<typeof useTranslations>
) {
  switch (status) {
    case 'sending':
      return t('statusSending');
    case 'sent':
      return t('statusSent');
    case 'delivered':
      return t('statusDelivered');
    case 'read':
      return t('statusRead');
    case 'failed':
      return t('statusFailed');
    default:
      return status;
  }
}

function contentTypeLabel(
  type: Message['content_type'],
  t: ReturnType<typeof useTranslations>
) {
  switch (type) {
    case 'text':
      return t('typeText');
    case 'image':
      return t('typeImage');
    case 'document':
      return t('typeDocument');
    case 'audio':
      return t('typeAudio');
    case 'video':
      return t('typeVideo');
    case 'sticker':
      return t('typeSticker');
    case 'location':
      return t('typeLocation');
    case 'template':
      return t('typeTemplate');
    case 'interactive':
      return t('typeInteractive');
    case 'system':
      return t('typeSystem');
    default:
      return type;
  }
}

function fileNameFromUrl(url: string | null | undefined) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const rawName = decodeURIComponent(parsed.pathname.split('/').pop() ?? '');
    return rawName || null;
  } catch {
    const rawName = decodeURIComponent(
      String(url).split(/[?#]/)[0].split('/').pop() ?? ''
    );
    return rawName || null;
  }
}

function fileExtension(name: string | null | undefined) {
  const match = name?.match(/\.([a-z0-9]{2,8})$/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function isFileNameLike(value: string | null | undefined) {
  if (!value) return false;
  return /^[^\n\r]{1,120}\.[a-z0-9]{2,8}$/i.test(value.trim());
}

function documentTitle(
  message: Message,
  t: ReturnType<typeof useTranslations>
) {
  const text = message.content_text?.trim() || null;
  if (isFileNameLike(text)) return text;
  const urlName = fileNameFromUrl(message.media_url);
  const extension = fileExtension(urlName);
  return extension ? `${t('document')} ${extension}` : t('document');
}

function documentCaption(message: Message) {
  const text = message.content_text?.trim();
  if (!text || isFileNameLike(text)) return null;
  return text;
}

function MessageInfoRow({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="grid grid-cols-[86px_minmax(0,1fr)] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'min-w-0 text-right break-words',
          muted && 'text-muted-foreground'
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function MediaUnavailable({
  label,
  t,
}: {
  label: string;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="bg-muted/40 text-muted-foreground flex items-center gap-2 rounded-lg px-3 py-2 text-xs">
      <ImageOff className="text-muted-foreground h-4 w-4 shrink-0" />
      <span>{t('unavailable', { label })}</span>
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
  kind: 'image' | 'video';
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
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeViewer();
      if (kind === 'image' && (event.key === '+' || event.key === '=')) {
        updateZoom(zoom + 0.25);
      }
      if (kind === 'image' && event.key === '-') {
        updateZoom(zoom - 0.25);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
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
      aria-label={kind === 'image' ? t('openImage') : t('openVideo')}
      onClick={closeViewer}
    >
      <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
        {kind === 'image' ? (
          <>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                adjustZoom(-0.25);
              }}
              className="flex size-10 items-center justify-center rounded-full bg-black/55 text-white transition hover:bg-black/75"
              aria-label={t('zoomOut')}
              title={t('zoomOut')}
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
              aria-label={t('resetZoom')}
              title={t('resetZoom')}
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
              aria-label={t('zoomIn')}
              title={t('zoomIn')}
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
          aria-label={t('downloadMedia')}
          title={t('downloadMedia')}
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
          aria-label={t('closeViewer')}
          title={t('closeViewer')}
        >
          <X className="size-6" />
        </button>
      </div>

      <div
        className="flex h-full w-full items-center justify-center overflow-hidden"
        onClick={(event) => event.stopPropagation()}
        onWheel={
          kind === 'image'
            ? (event) => {
                event.preventDefault();
                adjustZoom(event.deltaY > 0 ? -0.15 : 0.15);
              }
            : undefined
        }
        onPointerDown={
          kind === 'image' && zoom > 1
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
          kind === 'image' && zoom > 1
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
          kind === 'image'
            ? (event) => {
                if (dragRef.current?.pointerId === event.pointerId) {
                  dragRef.current = null;
                }
              }
            : undefined
        }
        onPointerCancel={
          kind === 'image'
            ? () => {
                dragRef.current = null;
              }
            : undefined
        }
      >
        {kind === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={alt}
            className={cn(
              'max-h-[92vh] max-w-[92vw] rounded-md object-contain transition-transform duration-100 select-none',
              zoom > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'
            )}
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
              transformOrigin: 'center center',
              touchAction: 'none',
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
    if (url.startsWith('/api/whatsapp/media/')) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('Failed to load media');
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
      if (src?.startsWith('blob:')) {
        URL.revokeObjectURL(src);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadImage]);

  if (error) {
    return (
      <div
        className={cn(
          'bg-muted flex items-center justify-center rounded-lg',
          sticker ? 'h-32 w-32 bg-transparent' : 'h-40 w-60'
        )}
      >
        <ImageOff className="text-muted-foreground h-8 w-8" />
      </div>
    );
  }

  if (loading) {
    return (
      <div
        className={cn(
          'bg-muted flex items-center justify-center rounded-lg',
          sticker ? 'h-32 w-32 bg-transparent' : 'h-40 w-60'
        )}
      >
        <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setViewerOpen(true)}
        className="focus:ring-ring block overflow-hidden rounded-lg focus:ring-2 focus:outline-none"
        aria-label={t('openImage')}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src ?? ''}
          alt={alt}
          className={cn(
            'cursor-zoom-in brightness-100 transition hover:brightness-95',
            sticker
              ? 'max-h-40 max-w-40 object-contain'
              : 'max-h-64 max-w-60 rounded-lg object-cover'
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
        className="focus:ring-ring block overflow-hidden rounded-lg focus:ring-2 focus:outline-none"
        aria-label={t('openVideo')}
      >
        <video
          src={url}
          className="max-h-64 max-w-60 cursor-zoom-in rounded-lg bg-black object-cover brightness-100 transition hover:brightness-95"
          preload="metadata"
          muted
        />
      </button>
      <MediaViewer
        open={viewerOpen}
        kind="video"
        src={url}
        alt={t('video')}
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
    'flex w-full items-center justify-center gap-2 border-t px-3 py-2 text-sm font-medium',
    onPrimary
      ? 'border-primary-foreground/25 text-primary-foreground'
      : 'border-border text-primary'
  );

  return (
    <div className="mt-2 overflow-hidden">
      {payload.footer ? (
        <p
          className={cn(
            'px-1 py-2 text-[11px]',
            onPrimary ? 'text-primary-foreground/70' : 'text-muted-foreground'
          )}
        >
          <WhatsAppText text={payload.footer} />
        </p>
      ) : null}
      {payload.kind === 'buttons' ? (
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
            'flex w-full items-center justify-center gap-2 border-t px-3 py-2 text-sm font-medium',
            onPrimary
              ? 'border-primary-foreground/25 text-primary-foreground'
              : 'border-border text-primary'
          )}
        >
          <CornerDownLeft className="size-3.5" />
          <span className="truncate">{payload.button_label}</span>
        </button>
      )}
    </div>
  );
}

function mergeTemplatePayload(
  payload?: InteractiveMessagePayload | null,
  fallback?: InteractiveMessagePayload | null
) {
  if (!payload) return fallback ?? null;
  if (
    payload.kind !== 'buttons' ||
    fallback?.kind !== 'buttons' ||
    payload.buttons.some((button) => button.url)
  ) {
    return payload;
  }

  return {
    ...payload,
    footer: payload.footer ?? fallback.footer,
    buttons: payload.buttons.map((button, index) => ({
      ...fallback.buttons[index],
      ...button,
      type: button.type ?? fallback.buttons[index]?.type,
      url: button.url ?? fallback.buttons[index]?.url,
      example: button.example ?? fallback.buttons[index]?.example,
      phone_number:
        button.phone_number ?? fallback.buttons[index]?.phone_number,
    })),
  } satisfies InteractiveMessagePayload;
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
  const text = message.content_text ?? '';
  const isUnsupportedText =
    text.trim().toLowerCase() === '[unsupported]' ||
    text.trim().toLowerCase().startsWith('[unsupported message type:');

  if (message.deleted_at) {
    const deletedPreview =
      message.content_text ||
      (() => {
        switch (message.content_type) {
          case 'image':
            return t('photo');
          case 'sticker':
            return t('sticker');
          case 'video':
            return t('video');
          case 'audio':
            return t('audio');
          case 'document':
            return t('document');
          case 'location':
            return t('locationShared');
          case 'template':
            return t('template');
          default:
            return t('unsupported');
        }
      })();

    return (
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
          <Ban className="size-3.5" />
          {t('deletedTitle')}
        </span>
        <p className="text-sm break-words whitespace-pre-wrap opacity-80">
          <WhatsAppText text={deletedPreview} />
        </p>
      </div>
    );
  }

  switch (message.content_type) {
    case 'text':
      if (isUnsupportedText) {
        return (
          <p className="text-muted-foreground text-sm break-words whitespace-pre-wrap">
            {t('unsupported')}
          </p>
        );
      }
      return (
        <div>
          <p className="text-sm break-words whitespace-pre-wrap">
            <WhatsAppText text={message.content_text} />
          </p>
          {templateFallbackPayload ? (
            <TemplateActions
              payload={templateFallbackPayload}
              onPrimary={onPrimary}
            />
          ) : null}
        </div>
      );

    case 'image':
    case 'sticker':
      return (
        <div>
          {message.media_url ? (
            <MediaImage
              url={message.media_url}
              alt={
                message.content_type === 'sticker'
                  ? t('sharedStickerAlt')
                  : t('sharedImageAlt')
              }
              t={t}
              sticker={message.content_type === 'sticker'}
            />
          ) : (
            <MediaUnavailable
              label={
                message.content_type === 'sticker' ? t('sticker') : t('photo')
              }
              t={t}
            />
          )}
          {message.content_text && (
            <p className="mt-1 text-sm break-words whitespace-pre-wrap">
              <WhatsAppText text={message.content_text} />
            </p>
          )}
          {message.interactive_payload ? (
            <div className="mt-2">
              <InteractivePreview
                payload={{ ...message.interactive_payload, body: '' }}
                hideEmptyBody
                embedded
                onPrimary={onPrimary}
              />
            </div>
          ) : null}
        </div>
      );

    case 'video':
      return (
        <div>
          {message.media_url ? (
            <MediaVideo url={message.media_url} t={t} />
          ) : (
            <MediaUnavailable label={t('video')} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 text-sm break-words whitespace-pre-wrap">
              <WhatsAppText text={message.content_text} />
            </p>
          )}
          {message.interactive_payload ? (
            <div className="mt-2">
              <InteractivePreview
                payload={{ ...message.interactive_payload, body: '' }}
                hideEmptyBody
                embedded
                onPrimary={onPrimary}
              />
            </div>
          ) : null}
        </div>
      );

    case 'audio':
      return (
        <div>
          {message.media_url ? (
            <audio src={message.media_url} controls className="max-w-60" />
          ) : (
            <MediaUnavailable label={t('audio')} t={t} />
          )}
        </div>
      );

    case 'document':
      if (!message.media_url) {
        return (
          <MediaUnavailable
            label={message.content_text || t('document')}
            t={t}
          />
        );
      }
      {
        const title = documentTitle(message, t);
        const caption = documentCaption(message);
        const extension = fileExtension(title);

        return (
          <div className="min-w-0">
            <a
              href={message.media_url}
              target="_blank"
              rel="noopener noreferrer"
              className="border-border/70 bg-background/80 hover:bg-background flex min-w-0 items-center gap-3 rounded-lg border px-3 py-2.5 text-sm shadow-sm transition-colors"
            >
              <span className="bg-muted text-muted-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-md">
                <FileText className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-foreground block truncate font-medium">
                  {title}
                </span>
                <span className="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
                  {extension ? <span>{extension}</span> : null}
                  {extension ? <span>·</span> : null}
                  <span>{t('openDocument')}</span>
                </span>
              </span>
              <ExternalLink className="text-muted-foreground h-4 w-4 shrink-0" />
            </a>
            {caption ? (
              <p className="mt-2 text-sm break-words whitespace-pre-wrap">
                <WhatsAppText text={caption} />
              </p>
            ) : null}
          </div>
        );
      }

    case 'template': {
      const templatePayload = mergeTemplatePayload(
        message.interactive_payload,
        templateFallbackPayload
      );
      return (
        <div>
          {message.media_url ? (
            <div className="mb-2">
              <MediaImage
                url={message.media_url}
                alt={t('sharedImageAlt')}
                t={t}
              />
            </div>
          ) : null}
          {message.content_text && (
            <p className="text-sm break-words whitespace-pre-wrap">
              <WhatsAppText text={message.content_text} />
            </p>
          )}
          {templatePayload ? (
            <TemplateActions payload={templatePayload} onPrimary={onPrimary} />
          ) : null}
        </div>
      );
    }

    case 'location':
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="text-muted-foreground h-4 w-4 shrink-0" />
          <span>
            <WhatsAppText text={message.content_text || t('locationShared')} />
          </span>
        </div>
      );

    case 'interactive': {
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
        return (
          <InteractivePreview
            payload={message.interactive_payload}
            embedded
            onPrimary={onPrimary}
          />
        );
      }
      if (message.sender_type === 'customer') {
        return (
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground inline-flex items-center gap-1 text-[10px] font-medium tracking-wide uppercase">
              <CornerDownLeft className="h-3 w-3" />
              {t('buttonReply')}
            </span>
            <p className="text-sm break-words whitespace-pre-wrap">
              <WhatsAppText
                text={message.content_text || t('interactiveReply')}
              />
            </p>
          </div>
        );
      }
      return (
        <p className="text-sm break-words whitespace-pre-wrap">
          <WhatsAppText text={message.content_text || t('interactiveReply')} />
        </p>
      );
    }

    default:
      return (
        <p className="text-sm break-words whitespace-pre-wrap">
          <WhatsAppText text={message.content_text || t('unsupported')} />
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
  const t = useTranslations('Inbox.bubble');

  if (message.content_type === 'system') {
    const createdAt =
      formatMessageInfoDate(message.created_at) ?? t('missingTime');

    return (
      <div className="flex justify-center py-1">
        <Popover>
          <PopoverTrigger
            type="button"
            title={t('messageInfo')}
            className="bg-background/85 text-muted-foreground focus-visible:ring-primary/40 max-w-[80%] rounded-full px-4 py-2 text-center text-xs italic underline-offset-2 shadow-sm hover:underline focus-visible:ring-2 focus-visible:outline-none"
          >
            <WhatsAppText text={message.content_text || ''} />
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="center"
            className="w-64 p-3 text-xs"
          >
            <dl>
              <MessageInfoRow label={t('createdAt')} value={createdAt} />
            </dl>
          </PopoverContent>
        </Popover>
      </div>
    );
  }

  const isAgent =
    message.sender_type === 'agent' || message.sender_type === 'bot';
  const isDeleted = Boolean(message.deleted_at);
  const isSticker = message.content_type === 'sticker';
  const time = format(new Date(message.created_at), 'HH:mm');
  const missingTime = t('missingTime');
  const messageInfoRows = [
    { label: t('status'), value: statusLabel(message.status, t) },
    { label: t('type'), value: contentTypeLabel(message.content_type, t) },
    { label: t('createdAt'), value: formatMessageInfoDate(message.created_at) },
    ...(isAgent
      ? [
          {
            label: t('sentAt'),
            value: formatMessageInfoDate(message.sent_at),
            muted: !message.sent_at,
          },
          {
            label: t('deliveredAt'),
            value: formatMessageInfoDate(message.delivered_at),
            muted: !message.delivered_at,
          },
          {
            label: t('readAt'),
            value: formatMessageInfoDate(message.read_at),
            muted: !message.read_at,
          },
          ...(message.failed_at || message.status === 'failed'
            ? [
                {
                  label: t('failedAt'),
                  value: formatMessageInfoDate(message.failed_at),
                  muted: !message.failed_at,
                },
              ]
            : []),
        ]
      : []),
  ].map((row) => ({
    ...row,
    value: row.value ?? missingTime,
  }));
  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div className={cn('flex flex-col', isAgent ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'relative rounded-2xl px-3 py-2',
          isDeleted
            ? isAgent
              ? 'border-primary/20 bg-primary/15 text-primary/80 rounded-br-md border'
              : 'border-border bg-muted/50 text-muted-foreground rounded-bl-md border'
            : isSticker
              ? 'bg-transparent px-0 py-0 shadow-none'
              : isAgent
                ? 'border-primary/20 bg-primary-soft-2 text-foreground rounded-br-md border shadow-sm'
                : 'bg-muted text-foreground rounded-bl-md'
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
              'mb-1 flex items-center gap-1 text-xs italic',
              'text-muted-foreground'
            )}
          >
            <Forward className="size-3" />
            {t('forwarded')}
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
            'mt-1 flex items-center gap-1',
            isAgent ? 'justify-end' : 'justify-start'
          )}
        >
          {/* AI badge — only on replies the auto-reply bot generated
              (always outbound, so it sits on the primary fill). Lets
              agents tell an AI reply from their own / a Flow's at a
              glance. */}
          {message.ai_generated && (
            <span
              className="bg-primary/10 text-primary inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[9px] leading-none font-semibold tracking-wide uppercase"
              title={t('aiBadgeTitle')}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {t('aiBadge')}
            </span>
          )}
          <Popover>
            <PopoverTrigger
              type="button"
              title={t('messageInfo')}
              className={cn(
                'focus-visible:ring-primary/40 border-0 bg-transparent p-0 text-[10px] underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none',
                // Outbound bubbles sit on the primary fill, so the
                // timestamp must read against that (not the neutral
                // foreground) — otherwise it goes low-contrast in light
                // mode. Inbound bubbles use the muted surface.
                isDeleted
                  ? isAgent
                    ? 'text-primary/60'
                    : 'text-muted-foreground'
                  : isAgent
                    ? 'text-muted-foreground'
                    : 'text-muted-foreground'
              )}
            >
              {time}
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align={isAgent ? 'end' : 'start'}
              className="w-72 gap-2 p-3 text-xs"
            >
              <div className="text-foreground font-medium">
                {t('messageInfo')}
              </div>
              <dl className="space-y-1.5">
                {messageInfoRows.map((row) => (
                  <MessageInfoRow
                    key={row.label}
                    label={row.label}
                    value={row.value}
                    muted={row.muted}
                  />
                ))}
              </dl>
            </PopoverContent>
          </Popover>
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
