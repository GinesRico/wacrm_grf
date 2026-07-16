"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  KeyboardEvent,
  ClipboardEvent,
} from "react";
import {
  Send,
  LayoutTemplate,
  FileText,
  X,
  Loader2,
  Plus,
  Paperclip,
  MessageSquareDashed,
  Zap,
  Smile,
  PenLine,
  CreditCard,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  uploadAccountMedia,
  deleteAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from "@/lib/storage/upload-media";
import { ReplyQuote } from "./reply-quote";
import { useTranslations } from "next-intl";
import {
  InteractiveBuilder,
  blankButtonsPayload,
} from "@/components/interactive/interactive-builder";
import { validateInteractivePayload } from "@/lib/whatsapp/interactive";
import {
  buildPaymentTemplateParams,
  type PaymentTemplateValueSource,
} from "@/lib/integrations/payment-template-params";
import type { Contact, InteractiveMessagePayload, QuickReply } from "@/types";
import { QuickReplyPicker } from "./quick-reply-picker";
import { useAppPrompt } from "@/hooks/use-app-dialog";

/** Media content types an agent can send from the composer. */
export type ComposerMediaKind = "image" | "video" | "document" | "audio";

/** Supabase Storage bucket holding agent-sent chat attachments (migration 023). */
export const CHAT_MEDIA_BUCKET = "chat-media";

/** Meta caps media captions at 1024 chars. Enforced here and in the send route. */
export const MEDIA_CAPTION_MAX = 1024;

const EMOJI_CHOICES = [
  "😀",
  "😄",
  "😂",
  "😊",
  "😍",
  "😘",
  "😎",
  "🤔",
  "😮",
  "😢",
  "🙏",
  "👍",
  "👌",
  "👏",
  "💪",
  "❤️",
  "🔥",
  "✅",
  "🚗",
  "🔧",
  "📦",
  "📸",
  "📍",
  "☎️",
];

export interface SendMediaPayload {
  kind: ComposerMediaKind;
  /** Public chat-media URL Meta fetches at send time. */
  mediaUrl: string;
  /** Storage object path — lets the caller GC the object if the send fails. */
  path: string;
  /** Optional caption (image/video/document only). */
  caption?: string;
  /** Original file name — surfaced to the recipient for documents. */
  filename?: string;
  replyToId?: string;
}

interface ReplyDraft {
  /** Internal UUID of the message being replied to — sent back through onSend. */
  id: string;
  authorLabel: string;
  preview: string;
}

// Mirrors the chat-media bucket's allowed_mime_types (migration 023) for
// the file picker so unsupported files are rejected before upload rather
// than failing with a confusing Storage error.
const PICKER_ACCEPT: Record<ComposerMediaKind, string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  audio: "audio/ogg,audio/mpeg,audio/aac,audio/mp4,audio/amr",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};

const ATTACH_ACCEPT = Object.values(PICKER_ACCEPT).join(",");

function mediaKindFromFile(file: File): ComposerMediaKind {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return "document";
}

interface MediaDraft {
  kind: ComposerMediaKind;
  mediaUrl: string;
  /** Storage path — used to GC the object if the draft is discarded. */
  path: string;
  filename: string;
  caption: string;
}

interface MessageComposerProps {
  conversationId: string;
  sessionExpired: boolean;
  locked?: boolean;
  lockedReason?: string;
  onSend: (text: string, replyToId?: string) => void;
  onSendMedia: (payload: SendMediaPayload) => void;
  onSendInteractive: (payload: InteractiveMessagePayload, replyToId?: string) => void;
  onOpenTemplates: () => void;
  replyTo?: ReplyDraft | null;
  aiDraftSeed?: string | null;
  onClearReply?: () => void;
  signatureEnabled: boolean;
  onSignatureEnabledChange: (enabled: boolean) => void;
  contact?: Contact | null;
}

export function MessageComposer({
  conversationId,
  sessionExpired,
  locked = false,
  lockedReason,
  onSend,
  onSendMedia,
  onSendInteractive,
  onOpenTemplates,
  replyTo,
  aiDraftSeed,
  onClearReply,
  signatureEnabled,
  onSignatureEnabledChange,
  contact,
}: MessageComposerProps) {
  const t = useTranslations("Inbox.composer");
  const { prompt, promptDialog } = useAppPrompt();

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Interactive-message builder dialog + quick-reply picker.
  const [interactiveOpen, setInteractiveOpen] = useState(false);
  const [interactivePayload, setInteractivePayload] =
    useState<InteractiveMessagePayload>(blankButtonsPayload);
  const [savingQuickReply, setSavingQuickReply] = useState(false);
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);
  const [slashQuickReplies, setSlashQuickReplies] = useState<QuickReply[]>([]);
  const [slashLoading, setSlashLoading] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [paymentsEnabled, setPaymentsEnabled] = useState(false);
  const [paymentDelivery, setPaymentDelivery] = useState<{
    mode: "text" | "template";
    templateName?: string;
    templateLanguage?: string;
    templateBodyParams?: Record<string, PaymentTemplateValueSource>;
    templateButtonParams?: Record<string, PaymentTemplateValueSource>;
  }>({ mode: "text" });
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentConcept, setPaymentConcept] = useState("");
  const [paymentBusy, setPaymentBusy] = useState(false);

  // Media attachment state. `draft` holds an uploaded-but-not-yet-sent
  // attachment; `busy` covers the upload/transcode window.
  const [draft, setDraft] = useState<MediaDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const attachInputRef = useRef<HTMLInputElement>(null);
  // Mirror of `draft` for the unmount cleanup, which can't read render
  // state. Kept in sync below so navigating away with a staged-but-unsent
  // attachment GCs the orphaned object.
  const draftRef = useRef<MediaDraft | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Best-effort GC of a staged object the user never sent. Fire-and-forget.
  const removeStaged = useCallback((path: string | undefined) => {
    if (!path) return;
    void deleteAccountMedia(CHAT_MEDIA_BUCKET, path).catch(() => {});
  }, []);

  // Viewers (read-only role) can browse the inbox but never send.
  // For solo users this is always true — single-owner accounts pass
  // every capability — so the disabled branch is a no-op there.
  const canSend = useCan("send-messages");
  const readOnly = !canSend;
  // Media (like free-form text) is only allowed inside the 24h window.
  const inputsDisabled = readOnly || sessionExpired || locked;

  useEffect(() => {
    if (inputsDisabled || draft) return;
    const id = window.setTimeout(() => {
      textareaRef.current?.focus();
    }, 80);
    return () => window.clearTimeout(id);
  }, [conversationId, draft, inputsDisabled]);

  // Tear down a staged-but-unsent attachment on unmount so it doesn't orphan in the bucket.
  useEffect(() => {
    return () => {
      removeStaged(draftRef.current?.path);
    };
  }, [removeStaged]);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Max 4 lines (~96px)
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || sessionExpired || locked) return;

    setSending(true);
    try {
      onSend(trimmed, replyTo?.id);
      setText("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } finally {
      setSending(false);
    }
  }, [text, sending, sessionExpired, locked, onSend, replyTo?.id]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      adjustHeight();
    },
    [adjustHeight]
  );

  const insertTextAtCursor = useCallback(
    (value: string) => {
      const el = textareaRef.current;
      const start = el?.selectionStart ?? text.length;
      const end = el?.selectionEnd ?? text.length;
      const nextText = `${text.slice(0, start)}${value}${text.slice(end)}`;
      setText(nextText);
      requestAnimationFrame(() => {
        adjustHeight();
        const target = textareaRef.current;
        if (!target) return;
        const cursor = start + value.length;
        target.focus();
        target.setSelectionRange(cursor, cursor);
      });
    },
    [adjustHeight, text],
  );

  const slashQuery = text.startsWith("/") ? text.slice(1).trim().toLowerCase() : "";
  const slashPickerOpen = text.startsWith("/") && !inputsDisabled && !draft;
  const visibleSlashQuickReplies = slashQuickReplies.filter((qr) => {
    if (!slashQuery) return true;
    const haystack = `${qr.title} ${qr.content_text ?? ""}`.toLowerCase();
    return haystack.includes(slashQuery);
  });

  useEffect(() => {
    if (!slashPickerOpen) return;
    let cancelled = false;
    setSlashLoading(true);
    void (async () => {
      try {
        const res = await fetch("/api/quick-replies", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) {
          setSlashQuickReplies((data.quick_replies as QuickReply[]) ?? []);
        }
      } finally {
        if (!cancelled) setSlashLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slashPickerOpen]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/integrations/apps", { cache: "no-store" });
        if (!res.ok) return;
        const payload = await res.json();
        const app = payload.apps?.find(
          (item: { slug: string }) => item.slug === "arvera-payments",
        );
        if (!cancelled) {
          setPaymentsEnabled(Boolean(app?.connection?.enabled));
          const config = app?.connection?.config ?? {};
          setPaymentDelivery({
            mode: config.delivery_mode === "template" ? "template" : "text",
            templateName: config.template_name,
            templateLanguage: config.template_language,
            templateBodyParams: config.template_body_params ?? {},
            templateButtonParams: config.template_button_params ?? {},
          });
        }
      } catch {
        if (!cancelled) setPaymentsEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Ask the AI assistant for a suggested reply and drop it into the
  // composer for the agent to edit + send. Read-only server-side —
  // nothing is sent until the agent hits Send.
  const handleDraft = useCallback(async () => {
    if (drafting) return;
    setDrafting(true);
    try {
      const res = await fetch("/api/ai/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === "ai_not_configured") {
          toast.error(t("aiNotConfigured"));
        } else {
          toast.error(data.error ?? t("aiDraftFailed"));
        }
        return;
      }
      const draftText = typeof data.draft === "string" ? data.draft.trim() : "";
      if (!draftText) {
        toast.error(t("aiEmptyReply"));
        return;
      }
      setText(draftText);
      // Let the textarea grow to fit and drop the cursor at the end so
      // the agent can tweak immediately.
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    } catch {
      toast.error(t("aiNetworkFailed"));
    } finally {
      setDrafting(false);
    }
  }, [drafting, conversationId, adjustHeight, t]);

  useEffect(() => {
    if (!aiDraftSeed) return;
    void handleDraft();
  }, [aiDraftSeed, handleDraft]);

  // ---- Interactive message + quick replies --------------------------

  const openInteractiveBuilder = useCallback(
    (seed?: InteractiveMessagePayload) => {
      setInteractivePayload(seed ?? blankButtonsPayload());
      setInteractiveOpen(true);
    },
    [],
  );

  const sendInteractive = useCallback(() => {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    onSendInteractive(interactivePayload, replyTo?.id);
    setInteractiveOpen(false);
    onClearReply?.();
  }, [interactivePayload, onSendInteractive, replyTo?.id, onClearReply]);

  // Persist the current builder payload as a reusable interactive snippet.
  const saveAsQuickReply = useCallback(async () => {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    const title = (
      await prompt({
        title: t("quickReplyNamePrompt"),
        confirmLabel: t("save"),
        cancelLabel: t("cancel"),
      })
    )?.trim();
    if (!title) return;
    setSavingQuickReply(true);
    try {
      const res = await fetch("/api/quick-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          kind: "interactive",
          interactive_payload: interactivePayload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("quickReplySaveError"));
        return;
      }
      toast.success(t("quickReplySaved"));
    } catch {
      toast.error(t("quickReplySaveError"));
    } finally {
      setSavingQuickReply(false);
    }
  }, [interactivePayload, prompt, t]);

  const sendPaymentLink = useCallback(async () => {
    const amount = Number(paymentAmount);
    const concept = paymentConcept.trim();
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error(t("paymentAmountRequired"));
      return;
    }
    if (!concept) {
      toast.error(t("paymentConceptRequired"));
      return;
    }
    setPaymentBusy(true);
    try {
      const res = await fetch("/api/integrations/arvera-payments/payment-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          contact_id: contact?.id,
          amount_eur: amount,
          concept,
          email: contact?.email,
          phone: contact?.phone,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t("paymentCreateFailed"));
        return;
      }
      const paymentUrl = payload.payment_link?.payment_url;
      if (!paymentUrl) {
        toast.error(t("paymentCreateFailed"));
        return;
      }
      if (paymentDelivery.mode === "template" && paymentDelivery.templateName) {
        const templateParams = buildPaymentTemplateParams(
          {
            template_body_params: paymentDelivery.templateBodyParams ?? {},
            template_button_params: paymentDelivery.templateButtonParams ?? {},
          },
          {
            payment_url: paymentUrl,
            order_id: payload.payment_link?.order_id ?? "",
            amount_cents: payload.payment_link?.amount_cents ?? Math.round(amount * 100),
            concept: payload.payment_link?.concept ?? concept,
            email: payload.payment_link?.email ?? contact?.email,
            phone: payload.payment_link?.phone ?? contact?.phone,
          },
        );
        const sendRes = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversationId,
            message_type: "template",
            template_name: paymentDelivery.templateName,
            template_language: paymentDelivery.templateLanguage || "en_US",
            template_params: templateParams.body,
            template_message_params: {
              body: templateParams.body,
              buttonParams: templateParams.buttonParams,
            },
            content_text: paymentUrl,
          }),
        });
        const sendPayload = await sendRes.json().catch(() => ({}));
        if (!sendRes.ok) {
          toast.error(sendPayload.error || t("paymentSendFailed"));
          return;
        }
      } else {
        onSend(`Aqui tienes tu enlace de pago: ${paymentUrl}`);
      }
      setPaymentOpen(false);
      setPaymentAmount("");
      setPaymentConcept("");
      toast.success(t("paymentCreated"));
    } finally {
      setPaymentBusy(false);
    }
  }, [paymentAmount, paymentConcept, conversationId, contact, onSend, paymentDelivery, t]);

  // A picked quick reply: text fills the composer; interactive opens the
  // builder pre-filled so the agent can tweak before sending.
  const handlePickQuickReply = useCallback(
    (qr: QuickReply) => {
      setQuickReplyOpen(false);
      if (qr.kind === "interactive" && qr.interactive_payload) {
        openInteractiveBuilder(qr.interactive_payload);
        return;
      }
      const body = qr.content_text ?? "";
      // Separate the snippet from any existing draft with a newline so the
      // words don't run together ("Thanks" + "we'll…" → "Thankswe'll…").
      setText((prev) =>
        prev && !/\s$/.test(prev) ? `${prev}\n${body}` : `${prev}${body}`,
      );
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    },
    [openInteractiveBuilder, adjustHeight],
  );

  const handlePickSlashQuickReply = useCallback(
    (qr: QuickReply) => {
      if (qr.kind === "interactive" && qr.interactive_payload) {
        setText("");
        openInteractiveBuilder(qr.interactive_payload);
        return;
      }
      setText(qr.content_text ?? "");
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    },
    [openInteractiveBuilder, adjustHeight],
  );

  // Upload a captured file to chat-media and stage it as a draft.
  const stageUpload = useCallback(
    async (kind: ComposerMediaKind, file: File) => {
      // Per-kind ceiling mirrors Meta's caps (image 5 MB, etc.) so we
      // reject before upload rather than orphaning an object that Meta
      // would then refuse at send.
      const max = MEDIA_MAX_BYTES_BY_KIND[kind];
      if (file.size > max) {
        toast.error(
          t("fileTooLarge", {
            size: (file.size / 1024 / 1024).toFixed(1),
            kind,
            max: Math.round(max / 1024 / 1024),
          }),
        );
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        // Replacing an existing draft? GC the previous object first.
        removeStaged(draftRef.current?.path);
        setDraft({ kind, mediaUrl: publicUrl, path, filename: file.name, caption: "" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("uploadFailed"));
      } finally {
        setBusy(false);
      }
    },
    [removeStaged, t],
  );

  const handlePicked = useCallback(
    (file: File | undefined) => {
      if (file) void stageUpload(mediaKindFromFile(file), file);
    },
    [stageUpload],
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      if (inputsDisabled || busy || draft) return;
      const file =
        Array.from(e.clipboardData.files)[0] ??
        Array.from(e.clipboardData.items)
          .find((item) => item.kind === "file")
          ?.getAsFile();
      if (!file) return;

      e.preventDefault();
      void stageUpload(mediaKindFromFile(file), file);
    },
    [busy, draft, inputsDisabled, stageUpload],
  );

  // ---- Draft send / discard -----------------------------------------

  const sendDraft = useCallback(() => {
    if (!draft || busy) return;
    onSendMedia({
      kind: draft.kind,
      mediaUrl: draft.mediaUrl,
      path: draft.path,
      // Audio takes no caption (Meta rejects it). Everything else: the
      // trimmed caption, or undefined when blank.
      caption:
        draft.kind === "audio" ? undefined : draft.caption.trim() || undefined,
      filename: draft.kind === "document" ? draft.filename : undefined,
      replyToId: replyTo?.id,
    });
    // The object is now owned by the sent message — clear without GC.
    setDraft(null);
    onClearReply?.();
  }, [draft, busy, onSendMedia, replyTo?.id, onClearReply]);

  // Discard GCs the staged object — it was uploaded but never sent.
  const discardDraft = useCallback(() => {
    removeStaged(draft?.path);
    setDraft(null);
  }, [draft?.path, removeStaged]);

  const setCaption = useCallback((caption: string) => {
    setDraft((d) => (d ? { ...d, caption } : d));
  }, []);

  // ---- Render --------------------------------------------------------

  return (
    <div className="border-t border-border bg-card p-3">
      {replyTo && (
        <div className="mb-2">
          <ReplyQuote
            authorLabel={replyTo.authorLabel}
            preview={replyTo.preview}
            onDismiss={onClearReply}
          />
        </div>
      )}
      {sessionExpired && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-amber-500/10 px-3 py-2">
          <p className="text-xs text-amber-400">
            {t("sessionExpiredHint")}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-amber-400 hover:text-amber-300"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="mr-1 h-3 w-3" />
            {t("templates")}
          </Button>
        </div>
      )}

      {/* Hidden file input driven by the attach menu. */}
      <input
        ref={attachInputRef}
        type="file"
        accept={ATTACH_ACCEPT}
        className="hidden"
        onChange={(e) => {
          handlePicked(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {draft ? (
        <MediaDraftPreview
          draft={draft}
          busy={busy}
          readOnly={readOnly}
          onCaptionChange={setCaption}
          onDiscard={discardDraft}
          onSend={sendDraft}
          t={t}
        />
      ) : (
        <div className="relative flex items-end gap-2">
          {/* Quick replies appear inline when the draft starts with /. */}
          {slashPickerOpen && (
            <div className="absolute bottom-full left-11 z-30 mb-2 max-h-72 w-80 overflow-y-auto rounded-lg border border-border bg-popover p-1.5 text-sm shadow-lg">
              {slashLoading ? (
                <div className="flex items-center justify-center py-5 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : visibleSlashQuickReplies.length === 0 ? (
                <div className="px-3 py-5 text-center text-xs text-muted-foreground">
                  {t("quickRepliesEmpty")}
                </div>
              ) : (
                visibleSlashQuickReplies.map((qr) => (
                  <button
                    key={qr.id}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => handlePickSlashQuickReply(qr)}
                    className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-muted"
                  >
                    {qr.kind === "interactive" ? (
                      <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    ) : (
                      <MessageSquareDashed className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">
                        {qr.title}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {qr.kind === "interactive"
                          ? t("interactiveMessage")
                          : qr.content_text}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          )}

          {/* + menu groups media, templates, interactive messages and snippets. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={inputsDisabled || busy}
              title={
                readOnly
                  ? t("readOnlyTitle")
                  : inputsDisabled
                    ? undefined
                    : t("moreActions")
              }
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64 border-border bg-popover">
              <DropdownMenuItem onClick={() => attachInputRef.current?.click()}>
                <Paperclip className="mr-2 h-4 w-4" />
                {t("attach")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onOpenTemplates}>
                <LayoutTemplate className="mr-2 h-4 w-4" />
                {t("templates")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openInteractiveBuilder()}>
                <MessageSquareDashed className="mr-2 h-4 w-4" />
                {t("interactiveMessage")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setQuickReplyOpen(true)}>
                <Zap className="mr-2 h-4 w-4" />
                {t("quickReplies")}
              </DropdownMenuItem>
              {paymentsEnabled && (
                <DropdownMenuItem onClick={() => setPaymentOpen(true)}>
                  <CreditCard className="mr-2 h-4 w-4" />
                  {t("paymentLink")}
                </DropdownMenuItem>
              )}
              <DropdownMenuCheckboxItem
                checked={signatureEnabled}
                onCheckedChange={onSignatureEnabledChange}
              >
                <PenLine className="mr-2 h-4 w-4" />
                {t("signMessages")}
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
            <PopoverTrigger
              disabled={inputsDisabled}
              title={t("emoji")}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Smile className="h-4 w-4" />
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              className="grid w-72 grid-cols-8 gap-1 p-2"
            >
              {EMOJI_CHOICES.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => {
                    insertTextAtCursor(emoji);
                    setEmojiOpen(false);
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-lg hover:bg-muted"
                >
                  {emoji}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              readOnly
                ? t("readOnlyPlaceholder")
                : locked
                  ? (lockedReason ?? t("lockedPlaceholder"))
                  : sessionExpired
                  ? t("sessionExpiredPlaceholder")
                  : t("typeMessagePlaceholder")
            }
            disabled={sessionExpired || readOnly || locked}
            rows={1}
            // Textarea keeps its own inline title — the GatedButton
            // wrapping pattern doesn't apply to non-button inputs.
            // The placeholder text also surfaces the read-only state.
            title={locked ? lockedReason : readOnly ? t("readOnlyTitle") : undefined}
            className={cn(
              "flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50",
              (sessionExpired || readOnly || locked) && "cursor-not-allowed opacity-50"
            )}
          />

          <GatedButton
            size="sm"
            canAct={!readOnly && !locked}
            gateReason="send messages"
            disabled={!text.trim() || sessionExpired || locked || sending}
            onClick={handleSend}
            className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </GatedButton>
        </div>
      )}

      {/* Interactive-message builder dialog. */}
      <Dialog open={interactiveOpen} onOpenChange={setInteractiveOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("interactiveMessage")}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto">
            <InteractiveBuilder
              value={interactivePayload}
              onChange={setInteractivePayload}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={savingQuickReply}
              onClick={saveAsQuickReply}
            >
              {savingQuickReply ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Zap className="mr-1 h-4 w-4" />
              )}
              {t("saveAsQuickReply")}
            </Button>
            <Button onClick={sendInteractive}>
              <Send className="mr-1 h-4 w-4" />
              {t("send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick-reply picker. */}
      <QuickReplyPicker
        open={quickReplyOpen}
        onOpenChange={setQuickReplyOpen}
        onPick={handlePickQuickReply}
      />
      <Dialog open={paymentOpen} onOpenChange={setPaymentOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("paymentLink")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t("paymentAmount")}</Label>
              <Input
                type="number"
                min={0.01}
                step="0.01"
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("paymentConcept")}</Label>
              <Input
                value={paymentConcept}
                onChange={(e) => setPaymentConcept(e.target.value)}
                placeholder="Factura 1074"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaymentOpen(false)}>
              {t("cancel")}
            </Button>
            <Button onClick={sendPaymentLink} disabled={paymentBusy}>
              {paymentBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CreditCard className="h-4 w-4" />
              )}
              {t("sendPaymentLink")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {promptDialog}
    </div>
  );
}

/**
 * Staged-attachment preview with caption + send/discard. Declared at
 * module scope (not nested in MessageComposer) so React keeps it mounted
 * across the parent's re-renders — a nested component would remount the
 * caption input on every keystroke and drop focus.
 */
function MediaDraftPreview({
  draft,
  busy,
  readOnly,
  onCaptionChange,
  onDiscard,
  onSend,
  t,
}: {
  draft: MediaDraft;
  busy: boolean;
  readOnly: boolean;
  onCaptionChange: (caption: string) => void;
  onDiscard: () => void;
  onSend: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {draft.kind === "image" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={draft.mediaUrl}
              alt={draft.filename}
              className="max-h-40 rounded-lg object-cover"
            />
          )}
          {draft.kind === "video" && (
            <video src={draft.mediaUrl} controls className="max-h-40 rounded-lg" />
          )}
          {draft.kind === "audio" && (
            <audio src={draft.mediaUrl} controls className="w-full" />
          )}
          {draft.kind === "document" && (
            <div className="flex items-center gap-2 text-sm text-foreground">
              <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="truncate">{draft.filename}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDiscard}
          aria-label={t("removeAttachment")}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2 flex items-end gap-2">
        {draft.kind !== "audio" && (
          <input
            value={draft.caption}
            maxLength={MEDIA_CAPTION_MAX}
            onChange={(e) => onCaptionChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder={t("addCaption")}
            className="flex-1 rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50"
          />
        )}
        <GatedButton
          size="sm"
          canAct={!readOnly}
          gateReason="send messages"
          disabled={busy}
          onClick={onSend}
          className={cn(
            "h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40",
            draft.kind === "audio" && "ml-auto",
          )}
        >
          <Send className="h-4 w-4" />
        </GatedButton>
      </div>
    </div>
  );
}
