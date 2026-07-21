'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  subscribeRealtimeChannel,
  unsubscribeRealtimeChannel,
} from '@/lib/realtime/soketi-client';
import { useAuth } from '@/hooks/use-auth';
import { usePresence } from '@/hooks/use-presence';
import { PresenceDot } from '@/components/presence/presence-dot';
import { presenceLabel } from '@/lib/presence';
import { cn } from '@/lib/utils';
import type {
  Conversation,
  Message,
  MessageReaction,
  Contact,
  MessageTemplate,
  AccountMember,
  Department,
  WhatsAppConfig,
  InteractiveMessagePayload,
} from '@/types';
import {
  MessageSquare,
  Check,
  Clock,
  ArrowLeft,
  RefreshCw,
  MoreVertical,
  Trash2,
  Forward,
  X,
  Copy,
  CornerUpLeft,
} from 'lucide-react';
import { format, isToday, isYesterday, differenceInHours } from 'date-fns';
import { es } from 'date-fns/locale';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MessageBubble } from './message-bubble';
import { MessageActions } from './message-actions';
import {
  MessageComposer,
  CHAT_MEDIA_BUCKET,
  type SendMediaPayload,
} from './message-composer';
import { deleteAccountMedia } from '@/lib/storage/upload-media';
import { TemplatePicker } from './template-picker';
import { AiThreadBanner } from './ai-thread-banner';
import { buildReplyPreview } from './reply-quote';
import { toast } from 'sonner';
import { useAppConfirm } from '@/hooks/use-app-dialog';
import { toInteractiveTemplateButton } from '@/lib/inbox/template-buttons';

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

function renderTemplateBody(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const idx = Number(raw) - 1;
    return params[idx] ?? `{{${raw}}}`;
  });
}

interface MessageThreadProps {
  conversation: Conversation | null;
  contact: Contact | null;
  messages: Message[];
  onMessagesLoaded: (messages: Message[]) => void;
  onNewMessage: (message: Message) => void;
  onUpdateMessage: (id: string, updates: Partial<Message>) => void;
  onAssignChange: (
    conversationId: string,
    assignedAgentId: string | null
  ) => void;
  onConversationUpdated: (conversation: Conversation) => void;
  onConversationDeleted?: (conversationId: string) => void;
  /**
   * On mobile, the thread is shown full-screen with the conversation list
   * hidden. This callback lets the page deselect the active conversation
   * and reveal the list again. Rendered as a back-arrow in the header on
   * mobile only.
   */
  onBack?: () => void;
  /**
   * Increment to force the messages + reactions fetch effects to refire.
   * Parent bumps this on realtime reconnect / tab visibility → visible
   * so the open thread catches up on any events sent while the WS was
   * disconnected or the tab was throttled. Optional so existing callers
   * keep working.
   */
  resyncToken?: number;
  /**
   * Fired by the manual-refresh button in the thread header. The parent
   * typically bumps the same `resyncToken` it controls — this gives the
   * user a way to force a refetch when they suspect realtime missed an
   * event (or they're impatient). Optional so existing callers keep
   * working; the button is only rendered when this is provided.
   */
  onRefresh?: () => void;
  /**
   * Desktop-only contact-panel toggle. The page owns the open/closed
   * state (it's the one that renders the sidebar), so the thread just
   * reflects it and asks the page to flip it. Both optional so existing
   * callers keep working; the toggle button only renders when
   * `onToggleContactPanel` is wired up.
   */
  contactPanelOpen?: boolean;
  onToggleContactPanel?: () => void;
  jumpToMessageId?: string | null;
  onJumpHandled?: () => void;
}

type TransferLine = Pick<
  WhatsAppConfig,
  'id' | 'label' | 'phone_number_id' | 'is_default' | 'status' | 'department_id'
>;

const NO_LINE_VALUE = '__none';
const NO_AGENT_VALUE = '__queue';
const SIGNATURE_STORAGE_KEY = 'inbox-sign-messages';
const NO_DEPARTMENT_VALUE = '__no_department';

function TransferDialog({
  open,
  onOpenChange,
  members,
  departments,
  lines,
  selectedAgentId,
  onSelectedAgentIdChange,
  selectedDepartmentId,
  onSelectedDepartmentIdChange,
  selectedLineId,
  onSelectedLineIdChange,
  onSubmit,
  getPresence,
  getRow,
  now,
  currentUserId,
  t,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: AccountMember[];
  departments: Department[];
  lines: TransferLine[];
  selectedAgentId: string;
  onSelectedAgentIdChange: (value: string) => void;
  selectedDepartmentId: string;
  onSelectedDepartmentIdChange: (value: string) => void;
  selectedLineId: string;
  onSelectedLineIdChange: (value: string) => void;
  onSubmit: () => void;
  getPresence: ReturnType<typeof usePresence>['getPresence'];
  getRow: ReturnType<typeof usePresence>['getRow'];
  now: number;
  currentUserId?: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const teammates = members.filter(
    (member) => member.user_id !== currentUserId
  );
  const selectedLineValue =
    selectedLineId && lines.some((line) => line.id === selectedLineId)
      ? selectedLineId
      : NO_LINE_VALUE;
  const selectedAgentValue = selectedAgentId || NO_AGENT_VALUE;
  const selectedDepartmentValue =
    selectedDepartmentId &&
    departments.some((department) => department.id === selectedDepartmentId)
      ? selectedDepartmentId
      : NO_DEPARTMENT_VALUE;
  const selectedDepartmentLabel =
    departments.find((department) => department.id === selectedDepartmentId)
      ?.name ?? t('transferDepartment');
  const selectedLine = lines.find((line) => line.id === selectedLineId);
  const selectedLineLabel = selectedLine
    ? selectedLine.label?.trim() || selectedLine.phone_number_id
    : t('transferLine');
  const selectedAgentLabel =
    teammates.find((member) => member.user_id === selectedAgentId)?.full_name ??
    t('unassign');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-sm">
        <div className="border-border border-b px-5 py-4">
          <DialogTitle className="text-base font-semibold">
            {t('transferChat')}
          </DialogTitle>
        </div>
        <div className="space-y-4 px-5 py-5">
          <Select
            value={selectedDepartmentValue}
            onValueChange={(value) => {
              if (!value || value === NO_DEPARTMENT_VALUE) return;
              onSelectedDepartmentIdChange(value);
            }}
          >
            <SelectTrigger className="h-12 w-full">
              <span className="min-w-0 flex-1 truncate text-left">
                {selectedDepartmentLabel}
              </span>
            </SelectTrigger>
            <SelectContent>
              {departments.length === 0 ? (
                <SelectItem value={NO_DEPARTMENT_VALUE} disabled>
                  {t('noDepartmentsAvailable')}
                </SelectItem>
              ) : (
                departments.map((department) => (
                  <SelectItem key={department.id} value={department.id}>
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: department.color }}
                      />
                      <span className="truncate">{department.name}</span>
                    </span>
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>

          <Select
            value={selectedLineValue}
            onValueChange={(value) => {
              const nextValue = value ?? '';
              if (nextValue !== NO_LINE_VALUE) {
                onSelectedLineIdChange(nextValue);
                const line = lines.find((item) => item.id === nextValue);
                if (line?.department_id) {
                  onSelectedDepartmentIdChange(line.department_id);
                }
              }
            }}
          >
            <SelectTrigger className="h-12 w-full">
              <span className="min-w-0 flex-1 truncate text-left">
                {selectedLineLabel}
              </span>
            </SelectTrigger>
            <SelectContent>
              {lines.length === 0 ? (
                <SelectItem value={NO_LINE_VALUE} disabled>
                  {t('noLinesAvailable')}
                </SelectItem>
              ) : (
                lines.map((line) => (
                  <SelectItem key={line.id} value={line.id}>
                    {(line.label?.trim() || line.phone_number_id) +
                      (line.is_default ? ` · ${t('defaultLine')}` : '')}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>

          <Select
            value={selectedAgentValue}
            onValueChange={(value) => {
              const nextValue = value ?? '';
              onSelectedAgentIdChange(
                nextValue === NO_AGENT_VALUE ? '' : nextValue
              );
            }}
          >
            <SelectTrigger className="h-12 w-full">
              <span className="min-w-0 flex-1 truncate text-left">
                {selectedAgentLabel}
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_AGENT_VALUE}>{t('unassign')}</SelectItem>
              {teammates.length === 0 ? (
                <SelectItem value="__no_teammates" disabled>
                  {t('noTeammates')}
                </SelectItem>
              ) : (
                teammates.map((member) => {
                  const presence = getPresence(member.user_id);
                  return (
                    <SelectItem key={member.user_id} value={member.user_id}>
                      <span className="flex min-w-0 items-center gap-2">
                        <PresenceDot
                          status={presence}
                          label={presenceLabel(
                            presence,
                            getRow(member.user_id)?.last_seen_at ?? null,
                            now
                          )}
                        />
                        <span className="truncate">{member.full_name}</span>
                      </span>
                    </SelectItem>
                  );
                })
              )}
            </SelectContent>
          </Select>
        </div>
        <div className="border-border bg-muted/30 flex justify-end gap-3 border-t px-5 py-4">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="border-border bg-background text-destructive hover:bg-muted h-10 rounded-md border px-4 text-sm font-medium"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={onSubmit}
            className="bg-primary text-primary-foreground hover:bg-primary/90 h-10 rounded-md px-4 text-sm font-semibold"
          >
            {t('transfer')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function formatDateSeparator(
  dateStr: string,
  t: ReturnType<typeof useTranslations>,
  locale: string
): string {
  const date = new Date(dateStr);
  if (isToday(date)) return t('today');
  if (isYesterday(date)) return t('yesterday');
  return format(
    date,
    locale.startsWith('es') ? 'd MMMM yyyy' : 'MMMM d, yyyy',
    {
      locale: locale.startsWith('es') ? es : undefined,
    }
  );
}

function groupMessagesByDate(messages: Message[]) {
  const groups: { date: string; messages: Message[] }[] = [];
  let currentDate = '';

  for (const msg of messages) {
    const day = format(new Date(msg.created_at), 'yyyy-MM-dd');
    if (day !== currentDate) {
      currentDate = day;
      groups.push({ date: msg.created_at, messages: [msg] });
    } else {
      groups[groups.length - 1].messages.push(msg);
    }
  }

  return groups;
}

/**
 * WhatsApp-style doodle background applied to the chat area (both the
 * active thread and the empty state). The SVG tile lives at
 * `/public/inbox-doodle.svg`; the slate-950 colour sits underneath so
 * the doodles read as a subtle pattern rather than a stark grid.
 *
 * Defined once at module scope so the two render paths can't drift —
 * if we ever switch the asset, both spots update together.
 */
const DOODLE_BG_CLASSES =
  "bg-background bg-[url('/inbox-doodle.svg')] bg-repeat";

export function MessageThread({
  conversation,
  contact,
  messages,
  onMessagesLoaded,
  onNewMessage,
  onUpdateMessage,
  onAssignChange,
  onConversationUpdated,
  onConversationDeleted,
  onBack,
  resyncToken = 0,
  onRefresh,
  contactPanelOpen,
  onToggleContactPanel,
  jumpToMessageId,
  onJumpHandled,
}: MessageThreadProps) {
  const t = useTranslations('Inbox.messageThread');
  const tActions = useTranslations('Inbox.actions');
  const tTimer = useTranslations('Inbox.sessionTimer');
  const tQuote = useTranslations('Inbox.replyQuote');
  const locale = useLocale();
  const dateLocale = locale.startsWith('es') ? es : undefined;
  const { confirm, confirmDialog } = useAppConfirm();

  const { user, profile } = useAuth();
  const { getPresence, getRow, now } = usePresence();
  const [loading, setLoading] = useState(false);
  const [sessionCheckedConversationId, setSessionCheckedConversationId] =
    useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(
    () => new Set()
  );
  const [forwardDialogOpen, setForwardDialogOpen] = useState(false);
  const [forwardContactId, setForwardContactId] = useState('');
  const [forwardLineId, setForwardLineId] = useState('');
  const [forwardContacts, setForwardContacts] = useState<Contact[]>([]);
  const [aiDraftSeed, setAiDraftSeed] = useState<string | null>(null);
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(
    null
  );
  const [signatureEnabled, setSignatureEnabled] = useState(false);
  const [lines, setLines] = useState<TransferLine[]>([]);
  const [templateFallbackPayloads, setTemplateFallbackPayloads] = useState<
    Record<string, InteractiveMessagePayload>
  >({});
  const [reactions, setReactions] = useState<MessageReaction[]>([]);

  useEffect(() => {
    try {
      setSignatureEnabled(
        localStorage.getItem(SIGNATURE_STORAGE_KEY) === 'true'
      );
    } catch {
      // localStorage can be unavailable in constrained contexts.
    }
  }, []);

  const handleSignatureEnabledChange = useCallback((enabled: boolean) => {
    setSignatureEnabled(enabled);
    try {
      localStorage.setItem(SIGNATURE_STORAGE_KEY, String(enabled));
    } catch {
      // Ignore persistence failures; the in-memory toggle still works.
    }
  }, []);

  const agentSignatureName =
    profile?.full_name?.trim() || profile?.email?.trim() || user?.email || '';

  const signMessageText = useCallback(
    (value: string) => {
      if (!signatureEnabled || !agentSignatureName) return value;
      return `*${agentSignatureName}:*\n${value}`;
    },
    [agentSignatureName, signatureEnabled]
  );

  const jumpToMessage = useCallback((messageId: string) => {
    const target = scrollRef.current?.querySelector<HTMLElement>(
      `[data-message-id="${messageId}"]`
    );
    if (!target) return false;

    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightMessageId(messageId);

    window.setTimeout(() => {
      setHighlightMessageId((current) =>
        current === messageId ? null : current
      );
    }, 1800);

    return true;
  }, []);
  const [ticketAction, setTicketAction] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferAgentId, setTransferAgentId] = useState<string>('');
  const [transferDepartmentId, setTransferDepartmentId] = useState<string>('');
  const [transferLineId, setTransferLineId] = useState<string>('');
  // Purely visual spin state for the manual-refresh button. The actual
  // refetch is fire-and-forget through `onRefresh` (which bumps the
  // parent's resyncToken); the 700ms spin is just feedback so the click
  // doesn't feel like a no-op. Cleared via the timer ref on unmount.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const templateNames = Array.from(
      new Set(
        messages
          .filter(
            (message) => !message.interactive_payload && message.template_name
          )
          .map((message) => message.template_name as string)
      )
    );

    if (templateNames.length === 0) {
      setTemplateFallbackPayloads({});
      return;
    }

    let cancelled = false;

    (async () => {
      const res = await fetch('/api/inbox/template-previews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: templateNames }),
      });
      const payload = await res.json().catch(() => ({}));
      if (cancelled) return;
      if (!res.ok) {
        console.error('Failed to fetch template buttons:', payload);
        return;
      }

      const payloads: Record<string, InteractiveMessagePayload> = {};
      for (const row of (payload.templates ?? []) as {
        name?: unknown;
        footer_text?: unknown;
        buttons?: unknown;
      }[]) {
        const buttons = Array.isArray(row.buttons) ? row.buttons : [];
        const previewButtons = buttons
          .map(toInteractiveTemplateButton)
          .filter((button): button is NonNullable<typeof button> =>
            Boolean(button)
          );

        if (typeof row.name === 'string' && previewButtons.length > 0) {
          payloads[row.name] = {
            kind: 'buttons',
            body: '',
            footer:
              typeof row.footer_text === 'string' && row.footer_text.length > 0
                ? row.footer_text
                : undefined,
            buttons: previewButtons,
          };
        }
      }

      setTemplateFallbackPayloads(payloads);
    })();

    return () => {
      cancelled = true;
    };
  }, [messages]);
  const handleRefreshClick = useCallback(() => {
    if (isRefreshing || !onRefresh) return;
    setIsRefreshing(true);
    onRefresh();
    refreshTimerRef.current = setTimeout(() => {
      setIsRefreshing(false);
      refreshTimerRef.current = null;
    }, 700);
  }, [isRefreshing, onRefresh]);
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);

  // Profiles are bounded by RLS to rows the current user is allowed to
  // see — today that's just the current user, but the dropdown keeps the
  // shape ready for shared-team workspaces without a refactor.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch('/api/inbox/transfer-options', {
        cache: 'no-store',
      });
      const payload = await res.json().catch(() => ({}));
      if (cancelled) return;
      if (!res.ok) {
        console.error('Failed to fetch transfer options:', payload);
        return;
      }
      setMembers((payload.members as AccountMember[] | undefined) ?? []);
      setDepartments((payload.departments as Department[] | undefined) ?? []);
      setLines((payload.lines as TransferLine[] | undefined) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 24-hour session timer
  const sessionInfo = useMemo(() => {
    if (!messages.length) {
      return {
        expired: true,
        remaining: t('noCustomerMessages'),
        availableUntil: '',
      };
    }

    // Find last customer message
    const lastCustomerMsg = [...messages]
      .reverse()
      .find((m) => m.sender_type === 'customer');

    if (!lastCustomerMsg) {
      return {
        expired: true,
        remaining: t('noCustomerMessages'),
        availableUntil: '',
      };
    }

    const lastCustomerDate = new Date(lastCustomerMsg.created_at);
    const hoursSince = differenceInHours(new Date(), lastCustomerDate);
    const expired = hoursSince >= 24;
    const availableUntil = format(
      new Date(lastCustomerDate.getTime() + 24 * 60 * 60 * 1000),
      'dd/MM HH:mm',
      { locale: dateLocale }
    );

    if (expired) {
      return { expired: true, remaining: tTimer('expired'), availableUntil };
    }

    const hoursLeft = 24 - hoursSince;
    const remaining =
      hoursLeft >= 1
        ? tTimer('xhRemaining', { hours: Math.floor(hoursLeft) })
        : tTimer('xmRemaining', { minutes: Math.floor(hoursLeft * 60) });

    return { expired, remaining, availableUntil };
  }, [dateLocale, messages, t, tTimer]);

  // Store latest callback in a ref so fetchMessages doesn't need to
  // depend on `onMessagesLoaded` — otherwise parent re-renders cause
  // fetchMessages to change → useEffect re-fires → refetch → realtime
  // UPDATE on conversations.unread_count → parent re-renders → LOOP.
  // The ref is written inside an effect so the mutation doesn't happen
  // during render (React 19 refs rule); consumers only read `.current`
  // inside the async fetch completion, which runs after the render.
  const onMessagesLoadedRef = useRef(onMessagesLoaded);
  const messagesCountRef = useRef(messages.length);
  const fetchConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    onMessagesLoadedRef.current = onMessagesLoaded;
    messagesCountRef.current = messages.length;
  });

  const conversationId = conversation?.id;
  const hasUnread = (conversation?.unread_count ?? 0) > 0;

  // Fetch messages whenever the selected conversation changes. Kept
  // separate from the unread-reset effect so that incoming messages
  // arriving while the thread is open don't trigger a full refetch —
  // they only flip hasUnread, which only the reset effect listens to.
  useEffect(() => {
    if (!conversationId) return;

    let cancelled = false;

    (async () => {
      const shouldShowLoading =
        fetchConversationIdRef.current !== conversationId ||
        messagesCountRef.current === 0;
      fetchConversationIdRef.current = conversationId;
      if (shouldShowLoading) {
        setLoading(true);
        setSessionCheckedConversationId(null);
      }

      const res = await fetch(
        `/api/inbox/messages?conversation_id=${conversationId}`,
        {
          cache: 'no-store',
        }
      );
      const payload = await res.json().catch(() => ({}));

      if (cancelled) return;

      if (!res.ok) {
        console.error('Failed to fetch messages:', payload);
      } else {
        onMessagesLoadedRef.current(payload.messages ?? []);
        setReactions(
          (payload.reactions as MessageReaction[] | undefined) ?? []
        );
        setSessionCheckedConversationId(conversationId);
      }

      if (!cancelled && shouldShowLoading) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus —
    // realtime is best-effort and any message events sent while the WS
    // was disconnected or throttled are otherwise lost.
  }, [conversationId, resyncToken]);

  // Reactions fetch — pulls the current state from the DB. Kept separate
  // from the channel subscription below so a `resyncToken` bump just
  // refetches the rows without also tearing down and rebuilding the
  // realtime channel.
  useEffect(() => {
    if (!conversationId) return;

    const channelName = `private-conversation-${conversationId}`;
    const channel = subscribeRealtimeChannel(channelName);
    const handleMessageCreated = (event: {
      payload?: { message?: Message };
    }) => {
      const message = event.payload?.message;
      if (!message || message.conversation_id !== conversationId) return;
      onNewMessage(message);
    };
    const handleMessageUpdated = (event: {
      payload?: {
        message?: Partial<Message> & { id?: string; conversation_id?: string };
      };
    }) => {
      const message = event.payload?.message;
      if (!message?.id || message.conversation_id !== conversationId) return;
      onUpdateMessage(message.id, message);
    };
    const handleConversationUpdated = (event: {
      payload?: { conversation?: Conversation };
    }) => {
      const updatedConversation = event.payload?.conversation;
      if (!updatedConversation || updatedConversation.id !== conversationId)
        return;
      onConversationUpdated(updatedConversation);
    };
    const upsertReaction = (event: {
      payload: { reaction: MessageReaction };
    }) => {
      const row = event.payload.reaction;
      setReactions((prev) => {
        const existingIdx = prev.findIndex((r) => r.id === row.id);
        if (existingIdx >= 0) {
          const copy = prev.slice();
          copy[existingIdx] = row;
          return copy;
        }

        const tempIdx = prev.findIndex(
          (r) =>
            r.id.startsWith('temp-') &&
            r.message_id === row.message_id &&
            r.actor_type === row.actor_type &&
            r.actor_id === row.actor_id
        );
        if (tempIdx >= 0) {
          const copy = prev.slice();
          copy[tempIdx] = row;
          return copy;
        }

        return [...prev, row];
      });
    };
    const deleteReaction = (event: {
      payload: { reaction: Partial<MessageReaction> };
    }) => {
      const old = event.payload.reaction;
      if (!old?.id) return;
      setReactions((prev) => prev.filter((r) => r.id !== old.id));
    };

    channel.bind('message.created', handleMessageCreated);
    channel.bind('message.updated', handleMessageUpdated);
    channel.bind('conversation.updated', handleConversationUpdated);
    channel.bind('reaction.created', upsertReaction);
    channel.bind('reaction.updated', upsertReaction);
    channel.bind('reaction.deleted', deleteReaction);

    return () => {
      channel.unbind('message.created', handleMessageCreated);
      channel.unbind('message.updated', handleMessageUpdated);
      channel.unbind('conversation.updated', handleConversationUpdated);
      channel.unbind('reaction.created', upsertReaction);
      channel.unbind('reaction.updated', upsertReaction);
      channel.unbind('reaction.deleted', deleteReaction);
      unsubscribeRealtimeChannel(channelName);
    };
  }, [conversationId, onConversationUpdated, onNewMessage, onUpdateMessage]);

  // Clear any in-progress reply draft when the active conversation changes —
  // a quote pulled from conversation A shouldn't bleed into conversation B.
  useEffect(() => {
    setReplyTo(null);
  }, [conversationId]);

  // Reset the server-side unread_count to 0 whenever an unread count
  // surfaces on the active conversation — covers both (a) opening a
  // conversation that had unread messages and (b) new messages arriving
  // while the user is already viewing the thread (webhook server-bumps
  // unread_count to N+1; the realtime UPDATE propagates it into the
  // client, which re-runs this effect and flips it back to 0).
  //
  // Guarding on hasUnread prevents the eq-update loop: once unread_count
  // is 0 the condition is false, so no further UPDATE is issued.
  useEffect(() => {
    if (!conversationId || !hasUnread) return;
    void fetch(`/api/inbox/conversations/${conversationId}/unread`, {
      method: 'PATCH',
    }).then(async (res) => {
      if (!res.ok) {
        console.error(
          'Failed to reset unread_count:',
          await res.json().catch(() => ({}))
        );
      }
    });
  }, [conversationId, hasUnread]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      const el = scrollRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (!jumpToMessageId || !scrollRef.current) return;
    const jumped = jumpToMessage(jumpToMessageId);
    if (!jumped) return;
    onJumpHandled?.();
  }, [jumpToMessageId, onJumpHandled, messages, jumpToMessage]);

  const contactDisplayName = contact?.name || contact?.phone || 'Customer';

  const resolveReplyToId = useCallback(
    (candidate?: string | null) => {
      if (!candidate || candidate.startsWith('temp-')) return undefined;
      const quoted = messages.find((message) => message.id === candidate);
      if (!quoted || quoted.conversation_id !== conversationId)
        return undefined;
      return quoted.id;
    },
    [conversationId, messages]
  );

  useEffect(() => {
    if (replyTo && !resolveReplyToId(replyTo.id)) {
      setReplyTo(null);
    }
  }, [replyTo, resolveReplyToId]);

  const handleSend = useCallback(
    async (text: string, replyToId?: string) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}`;
      const safeReplyToId = resolveReplyToId(replyToId);

      // Optimistic update — shows the message immediately with "sending" status
      const signedText = signMessageText(text);

      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: 'text',
        content_text: signedText,
        status: 'sending',
        created_at: new Date().toISOString(),
        reply_to_message_id: safeReplyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: 'text',
            content_text: signedText,
            reply_to_message_id: safeReplyToId,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error('Failed to send message:', reason);
          toast.error(`Failed to send: ${reason}`);
          // Mark the optimistic bubble as failed so the user sees what happened
          onUpdateMessage(tempId, { status: 'failed' });
          return;
        }

        // Success — the realtime INSERT event will replace the temp bubble
        // with the real DB row. If realtime hasn't arrived yet, at least
        // flip status to 'sent' so the UI stops showing "sending".
        onUpdateMessage(tempId, { status: 'sent' });
      } catch (err) {
        console.error('Failed to send message:', err);
        const reason = err instanceof Error ? err.message : 'network error';
        toast.error(`Failed to send: ${reason}`);
        onUpdateMessage(tempId, { status: 'failed' });
      }
    },
    [
      conversation,
      onNewMessage,
      onUpdateMessage,
      resolveReplyToId,
      signMessageText,
    ]
  );

  const handleSendMedia = useCallback(
    async (payload: SendMediaPayload) => {
      if (!conversation) return;
      const safeReplyToId = resolveReplyToId(payload.replyToId);

      // Documents show their filename in our own bubble (and to the
      // recipient as the Meta caption when no caption was typed); other
      // kinds use the caption as-is. Audio carries no caption.
      const signedCaption = payload.caption
        ? signMessageText(payload.caption)
        : payload.caption;
      const contentText =
        payload.kind === 'document'
          ? signedCaption || payload.filename || 'Document'
          : signedCaption;

      const tempId = `temp-${Date.now()}`;
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: payload.kind,
        content_text: contentText,
        media_url: payload.mediaUrl,
        status: 'sending',
        created_at: new Date().toISOString(),
        reply_to_message_id: safeReplyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: payload.kind,
            media_url: payload.mediaUrl,
            content_text: contentText,
            filename: payload.filename,
            reply_to_message_id: safeReplyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.error || `HTTP ${res.status}`;
          console.error('Failed to send media:', reason);
          toast.error(`Failed to send: ${reason}`);
          onUpdateMessage(tempId, { status: 'failed' });
          // The upload never reached the recipient — GC the orphaned
          // object rather than leaving it in the public bucket forever.
          void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(
            () => {}
          );
          return;
        }

        onUpdateMessage(tempId, { status: 'sent' });
      } catch (err) {
        console.error('Failed to send media:', err);
        const reason = err instanceof Error ? err.message : 'network error';
        toast.error(`Failed to send: ${reason}`);
        onUpdateMessage(tempId, { status: 'failed' });
        void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(
          () => {}
        );
      }
    },
    [
      conversation,
      onNewMessage,
      onUpdateMessage,
      resolveReplyToId,
      signMessageText,
    ]
  );

  const handleSendInteractive = useCallback(
    async (payload: InteractiveMessagePayload, replyToId?: string) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}`;
      const safeReplyToId = resolveReplyToId(replyToId);
      const signedPayload = { ...payload, body: signMessageText(payload.body) };
      // Optimistic bubble — renders the buttons/list immediately via the
      // interactive_payload, same as the persisted row will.
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: 'interactive',
        content_text: signedPayload.body,
        interactive_payload: signedPayload,
        status: 'sending',
        created_at: new Date().toISOString(),
        reply_to_message_id: safeReplyToId,
      };
      onNewMessage(optimisticMsg);

      try {
        const res = await fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: 'interactive',
            interactive_payload: signedPayload,
            reply_to_message_id: safeReplyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.error || `HTTP ${res.status}`;
          console.error('Failed to send interactive message:', reason);
          toast.error(`Failed to send: ${reason}`);
          onUpdateMessage(tempId, { status: 'failed' });
          return;
        }

        onUpdateMessage(tempId, { status: 'sent' });
      } catch (err) {
        console.error('Failed to send interactive message:', err);
        const reason = err instanceof Error ? err.message : 'network error';
        toast.error(`Failed to send: ${reason}`);
        onUpdateMessage(tempId, { status: 'failed' });
      }
    },
    [
      conversation,
      onNewMessage,
      onUpdateMessage,
      resolveReplyToId,
      signMessageText,
    ]
  );

  const patchConversation = useCallback(
    async (body: Record<string, unknown>) => {
      if (!conversation) return;

      const res = await fetch('/api/inbox/conversations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          conversation_id: conversation.id,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload.conversation) {
        throw new Error(payload?.error || `HTTP ${res.status}`);
      }
      onConversationUpdated(payload.conversation);
      if ('assigned_agent_id' in payload.conversation) {
        onAssignChange(
          conversation.id,
          payload.conversation.assigned_agent_id ?? null
        );
      }
    },
    [conversation, onAssignChange, onConversationUpdated]
  );

  const handleTicketAction = useCallback(
    async (action: 'accept' | 'resolve' | 'return_to_pending' | 'reopen') => {
      if (!conversation || ticketAction) return;
      setTicketAction(action);
      try {
        await patchConversation({ action });
        if (action === 'resolve' || action === 'return_to_pending') {
          onBack?.();
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'network error';
        toast.error(t('ticketActionFailed', { reason }));
      } finally {
        setTicketAction(null);
      }
    },
    [conversation, onBack, patchConversation, ticketAction, t]
  );

  const conversationLocked = conversation?.status !== 'open';
  const lockedReason =
    conversation?.status === 'pending'
      ? t('acceptBeforeReply')
      : conversation?.status === 'closed'
        ? t('reopenBeforeReply')
        : undefined;
  const sessionPending = sessionCheckedConversationId !== conversationId;
  const composerLocked = conversationLocked || loading || sessionPending;
  const composerLockedReason =
    loading || sessionPending ? t('loadingMessages') : lockedReason;

  const handleOpenTemplates = useCallback(() => {
    if (conversationLocked) return;
    setTemplateModalOpen(true);
  }, [conversationLocked]);

  const handleSendTemplate = useCallback(
    async (
      template: MessageTemplate,
      values: {
        body: string[];
        headerText?: string;
        headerMediaUrl?: string;
        headerMediaPath?: string;
        buttonParams?: Record<number, string>;
      }
    ) => {
      if (!conversation) return;

      const renderedBody = renderTemplateBody(template.body_text, values.body);
      const tempId = `temp-${Date.now()}`;

      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: 'template',
        content_text: renderedBody,
        media_url:
          values.headerMediaUrl || template.header_media_url || undefined,
        template_name: template.name,
        status: 'sending',
        created_at: new Date().toISOString(),
      };
      onNewMessage(optimisticMsg);

      try {
        const res = await fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: 'template',
            template_name: template.name,
            template_language: template.language,
            // Structured params drive the new send-builder path
            // (header media + URL button substitution). Body values
            // are mirrored under both shapes so the route can fall
            // back if the template row isn't found locally.
            template_message_params: {
              body: values.body,
              headerText: values.headerText,
              headerMediaUrl: values.headerMediaUrl,
              buttonParams: values.buttonParams,
            },
            template_params: values.body,
            content_text: renderedBody,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error('Failed to send template:', reason);
          toast.error(`Failed to send template: ${reason}`);
          if (values.headerMediaPath) {
            void deleteAccountMedia(
              CHAT_MEDIA_BUCKET,
              values.headerMediaPath
            ).catch(() => {});
          }
          onUpdateMessage(tempId, { status: 'failed' });
          return;
        }

        onUpdateMessage(tempId, { status: 'sent' });
      } catch (err) {
        console.error('Failed to send template:', err);
        const reason = err instanceof Error ? err.message : 'network error';
        toast.error(`Failed to send template: ${reason}`);
        if (values.headerMediaPath) {
          void deleteAccountMedia(
            CHAT_MEDIA_BUCKET,
            values.headerMediaPath
          ).catch(() => {});
        }
        onUpdateMessage(tempId, { status: 'failed' });
      }
    },
    [conversation, onNewMessage, onUpdateMessage]
  );

  // Build a quick id → Message map so reply quotes can be rendered without
  // an extra fetch — the thread already holds the full conversation.
  const messagesById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  // Bucket reactions by their target message_id for O(1) per-bubble lookup.
  const reactionsByMessageId = useMemo(() => {
    const map = new Map<string, MessageReaction[]>();
    for (const r of reactions) {
      const bucket = map.get(r.message_id);
      if (bucket) bucket.push(r);
      else map.set(r.message_id, [r]);
    }
    return map;
  }, [reactions]);

  // Author label for a quoted message: "You" when we sent the parent,
  // contact name when the customer sent it.
  const authorLabelFor = useCallback(
    (m: Message): string => {
      const isAgentMsg = m.sender_type === 'agent' || m.sender_type === 'bot';
      return isAgentMsg ? 'You' : contactDisplayName;
    },
    [contactDisplayName]
  );

  const handleStartReply = useCallback(
    (msg: Message) => {
      const safeReplyToId = resolveReplyToId(msg.id);
      if (!safeReplyToId) {
        toast.error(t('waitForMessage'));
        return;
      }
      setReplyTo({
        id: safeReplyToId,
        authorLabel: authorLabelFor(msg),
        preview: buildReplyPreview(msg, tQuote),
      });
    },
    [authorLabelFor, resolveReplyToId, t, tQuote]
  );

  const handleAiReplyToMessage = useCallback(
    (msg: Message) => {
      handleStartReply(msg);
      setAiDraftSeed(`${msg.id}:${Date.now()}`);
    },
    [handleStartReply]
  );

  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      if (!conversation) return;
      if (messageId.startsWith('temp-')) {
        toast.error(t('waitForMessage'));
        return;
      }

      const snapshot = messages;
      const deletedAt = new Date().toISOString();
      const nextMessages = messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              deleted_at: deletedAt,
              deleted_by_user_id: user?.id ?? null,
            }
          : message
      );
      onMessagesLoaded(nextMessages);
      if (replyTo?.id === messageId) {
        setReplyTo(null);
      }

      const res = await fetch('/api/inbox/messages', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete',
          message_id: messageId,
        }),
      });

      if (!res.ok) {
        onMessagesLoaded(snapshot);
        toast.error(t('messageDeleteFailed'));
      }
    },
    [conversation, messages, onMessagesLoaded, replyTo?.id, t, user?.id]
  );

  const handleToggleMessageStar = useCallback(
    async (message: Message) => {
      const nextStarred = !message.is_starred;
      onUpdateMessage(message.id, { is_starred: nextStarred });

      const res = await fetch('/api/inbox/messages', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'star',
          message_id: message.id,
          is_starred: nextStarred,
        }),
      });

      if (!res.ok) {
        onUpdateMessage(message.id, { is_starred: message.is_starred });
        toast.error(t('messageStarFailed'));
      }
    },
    [onUpdateMessage, t]
  );

  const beginMessageSelection = useCallback((messageId: string) => {
    setSelectionMode(true);
    setSelectedMessageIds(new Set([messageId]));
  }, []);

  const toggleSelectedMessage = useCallback((messageId: string) => {
    setSelectedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      if (next.size === 0) {
        setSelectionMode(false);
      }
      return next;
    });
  }, []);

  const clearMessageSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
    setForwardDialogOpen(false);
    setForwardContactId('');
  }, []);

  const selectedMessages = useMemo(() => {
    if (selectedMessageIds.size === 0) return [];
    return messages.filter((message) => selectedMessageIds.has(message.id));
  }, [messages, selectedMessageIds]);

  const handleDeleteSelectedMessages = useCallback(async () => {
    if (!conversation || selectedMessageIds.size === 0) return;
    const ok = await confirm({
      title: t('delete'),
      description: t('deleteSelectedConfirm', {
        count: selectedMessageIds.size,
      }),
      confirmLabel: t('delete'),
      cancelLabel: t('cancel'),
      destructive: true,
    });
    if (!ok) return;

    const ids = Array.from(selectedMessageIds);
    const snapshot = messages;
    const deletedAt = new Date().toISOString();
    onMessagesLoaded(
      messages.map((message) =>
        selectedMessageIds.has(message.id)
          ? {
              ...message,
              deleted_at: deletedAt,
              deleted_by_user_id: user?.id ?? null,
            }
          : message
      )
    );
    clearMessageSelection();

    const res = await fetch('/api/inbox/messages', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'delete',
        message_ids: ids,
      }),
    });

    if (!res.ok) {
      onMessagesLoaded(snapshot);
      toast.error(t('messageDeleteFailed'));
    }
  }, [
    clearMessageSelection,
    confirm,
    conversation,
    messages,
    onMessagesLoaded,
    selectedMessageIds,
    t,
    user?.id,
  ]);

  const handleCopySelectedMessages = useCallback(async () => {
    if (selectedMessages.length === 0) return;

    const text = selectedMessages
      .map((message) => buildReplyPreview(message, tQuote).trim())
      .filter(Boolean)
      .join('\n');

    if (!text) {
      toast.error(tActions('nothingToCopy'));
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      toast.success(tActions('copied'));
    } catch {
      toast.error(tActions('copyFailed'));
    }
  }, [selectedMessages, tActions, tQuote]);

  const openForwardDialog = useCallback(() => {
    if (selectedMessageIds.size === 0) return;
    setForwardContactId('');
    setForwardLineId(
      (current) =>
        current || conversation?.whatsapp_config_id || lines[0]?.id || ''
    );
    setForwardDialogOpen(true);
  }, [conversation?.whatsapp_config_id, lines, selectedMessageIds.size]);

  const openForwardDialogForMessage = useCallback(
    (messageId: string) => {
      setSelectionMode(true);
      setSelectedMessageIds(new Set([messageId]));
      setForwardContactId('');
      setForwardLineId(
        (current) =>
          current || conversation?.whatsapp_config_id || lines[0]?.id || ''
      );
      setForwardDialogOpen(true);
    },
    [conversation?.whatsapp_config_id, lines]
  );

  useEffect(() => {
    if (!forwardDialogOpen) return;

    let cancelled = false;

    (async () => {
      const res = await fetch('/api/inbox/forward-contacts', {
        cache: 'no-store',
      });
      const payload = await res.json().catch(() => ({}));
      if (cancelled) return;
      if (res.ok) {
        setForwardContacts((payload.contacts as Contact[] | undefined) ?? []);
      }
      setForwardLineId(
        (current) =>
          current || conversation?.whatsapp_config_id || lines[0]?.id || ''
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [conversation?.whatsapp_config_id, forwardDialogOpen, lines]);

  const handleForwardSelectedMessages = useCallback(async () => {
    if (!forwardContactId || !forwardLineId || selectedMessages.length === 0)
      return;
    const forwardableMessages = selectedMessages.filter(
      (message) => !message.deleted_at
    );
    if (forwardableMessages.length === 0) return;

    try {
      const openRes = await fetch('/api/inbox/start-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: forwardContactId,
          whatsapp_config_id: forwardLineId,
        }),
      });
      const openPayload = await openRes.json().catch(() => ({}));
      if (!openRes.ok || typeof openPayload?.conversation_id !== 'string') {
        throw new Error(openPayload?.error || `HTTP ${openRes.status}`);
      }
      const targetConversationId = openPayload.conversation_id as string;

      for (const message of forwardableMessages) {
        const body = {
          conversation_id: targetConversationId,
          message_type:
            message.content_type === 'text' ? 'text' : message.content_type,
          content_text: message.content_text ?? '',
          media_url: message.media_url,
          is_forwarded: true,
          forwarded_from_message_id: message.id,
        };
        const res = await fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload?.error || `HTTP ${res.status}`);
        }
      }
      toast.success(t('forwarded'));
      clearMessageSelection();
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'network error';
      toast.error(t('forwardFailed', { reason }));
    }
  }, [
    clearMessageSelection,
    forwardContactId,
    forwardLineId,
    selectedMessages,
    t,
  ]);

  // Single reaction-set primitive. emoji === "" removes; otherwise adds/swaps.
  // The "toggle" semantic (pill click) is computed at the call site where the
  // current reactions for the bubble are already in scope — keeps this
  // function dependency-free w.r.t. the reaction list.
  const postReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!user?.id || !conversation) {
        console.warn('[reactions] missing user or conversation');
        return;
      }
      if (messageId.startsWith('temp-')) {
        toast.error(t('waitForMessage'));
        return;
      }

      const convId = conversation.id;
      const userId = user.id;
      let snapshot: MessageReaction[] = [];

      // Functional updater — captures the freshest reactions list, never a
      // stale closure. Snapshot stored for rollback on POST failure.
      setReactions((prev) => {
        snapshot = prev;
        const own = prev.find(
          (r) =>
            r.message_id === messageId &&
            r.actor_type === 'agent' &&
            r.actor_id === userId
        );
        if (emoji === '') return own ? prev.filter((r) => r !== own) : prev;
        if (own) return prev.map((r) => (r === own ? { ...own, emoji } : r));
        return [
          ...prev,
          {
            id: `temp-${Date.now()}`,
            message_id: messageId,
            conversation_id: convId,
            actor_type: 'agent',
            actor_id: userId,
            emoji,
            created_at: new Date().toISOString(),
          },
        ];
      });

      try {
        const res = await fetch('/api/whatsapp/react', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message_id: messageId, emoji }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload?.error || `HTTP ${res.status}`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'network error';
        toast.error(t('reactionFailed', { reason }));
        setReactions(snapshot);
      }
    },
    [conversation, user?.id, t]
  );

  const handleDeleteConversation = useCallback(async () => {
    if (!conversation) return;
    const ok = await confirm({
      title: t('deleteTicket'),
      description: t('deleteConfirm'),
      confirmLabel: t('delete'),
      cancelLabel: t('cancel'),
      destructive: true,
    });
    if (!ok) return;

    try {
      const res = await fetch(
        `/api/inbox/conversations?conversation_id=${encodeURIComponent(conversation.id)}`,
        {
          method: 'DELETE',
        }
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error ?? 'delete failed');
      }
      onConversationDeleted?.(conversation.id);
    } catch (err) {
      console.error('Failed to delete conversation:', err);
      toast.error(t('deleteFailed'));
    }
  }, [confirm, conversation, onConversationDeleted, t]);

  const handleTransferSubmit = useCallback(async () => {
    if (!conversation) return;
    try {
      await patchConversation({
        action: 'assign',
        assigned_agent_id: transferAgentId || null,
        department_id: transferDepartmentId || null,
        whatsapp_config_id: transferLineId || null,
      });
      setTransferOpen(false);
      if (!transferAgentId && transferDepartmentId) {
        onBack?.();
      }
    } catch (err) {
      console.error('Failed to transfer conversation:', err);
      toast.error(t('assignmentFailed'));
    }
  }, [
    conversation,
    onBack,
    patchConversation,
    t,
    transferAgentId,
    transferDepartmentId,
    transferLineId,
  ]);

  // Empty state — same WhatsApp-style doodle background as the active
  // thread below, so swapping between empty/selected doesn't change the
  // pattern under the user's eye.
  if (!conversation || !contact) {
    return (
      <div
        className={cn(
          'flex flex-1 flex-col items-center justify-center',
          DOODLE_BG_CLASSES
        )}
      >
        <div className="bg-muted flex h-16 w-16 items-center justify-center rounded-full">
          <MessageSquare className="text-muted-foreground h-8 w-8" />
        </div>
        <h3 className="text-muted-foreground mt-4 text-sm font-medium">
          {t('selectConversation')}
        </h3>
        <p className="text-muted-foreground mt-1 text-xs">
          {t('selectConversationHint')}
        </p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const lineName =
    conversation.whatsapp_config?.label ||
    conversation.whatsapp_config?.phone_number_id ||
    null;
  const messageGroups = groupMessagesByDate(messages);
  const statusLabel =
    conversation.status === 'open'
      ? t('statusOpen')
      : conversation.status === 'pending'
        ? t('statusPending')
        : t('statusClosed');
  const statusColor =
    conversation.status === 'open'
      ? 'text-primary'
      : conversation.status === 'pending'
        ? 'text-amber-400'
        : 'text-muted-foreground';
  const assignedAgentId = conversation.assigned_agent_id ?? null;
  const currentAssignee = members.find((p) => p.user_id === assignedAgentId);
  const assignLabel = assignedAgentId
    ? (currentAssignee?.full_name ?? t('assigned'))
    : t('assign');
  const assigneeName = currentAssignee?.full_name ?? t('assigned');
  const departmentHeaderColor = conversation.department?.color?.trim() || null;

  return (
    // `min-w-0` is load-bearing: the page already puts min-w-0 on the
    // thread's flex *wrapper* (issue #165), but this root keeps the
    // default `min-width: auto`, so a single wide message (long unbroken
    // URL/word) expands the whole thread past its flex share and the chat
    // paints on top of the contact sidebar at lg+ — outgoing bubbles get
    // clipped and the hover toolbar overlaps the Tags panel. Letting the
    // root shrink lets the bubbles' break-words / max-w caps apply.
    // Issue #257.
    <div className={cn('flex min-w-0 flex-1 flex-col', DOODLE_BG_CLASSES)}>
      {/* Header — solid card surface sits on top of the doodle so the
          name/avatar/dropdowns stay legible. */}
      <div className="border-border bg-card relative flex items-center justify-between gap-2 border-b px-2 py-2.5 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          {/* Back-to-list button — mobile only. Hidden on lg+ where the
              conversation list is always visible next to the thread. */}
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={t('backToConversations')}
              className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              onToggleContactPanel?.();
            }}
            className="bg-muted text-foreground hover:ring-primary/30 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-sm font-medium transition-shadow hover:ring-2"
            title={t('showContact')}
            aria-label={t('showContact')}
            aria-pressed={contactPanelOpen}
          >
            {displayName.charAt(0).toUpperCase()}
          </button>
          <button
            type="button"
            onClick={() => {
              onToggleContactPanel?.();
            }}
            className="min-w-0 text-left leading-tight"
            title={t('showContact')}
            aria-pressed={contactPanelOpen}
          >
            <h2 className="text-foreground truncate text-sm font-semibold">
              {displayName}
            </h2>
            <div className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
              {assignedAgentId && (
                <span className="hidden min-w-0 truncate sm:inline">
                  {t('assignedTo')}: {assigneeName}
                </span>
              )}
              {assignedAgentId && (lineName || sessionInfo.availableUntil) && (
                <span className="hidden sm:inline">•</span>
              )}
              {lineName && (
                <span className="hidden max-w-32 truncate sm:inline">
                  {lineName}
                </span>
              )}
              {sessionInfo.availableUntil && (
                <span className="hidden truncate md:inline">
                  {t('availableUntil', { value: sessionInfo.availableUntil })}
                </span>
              )}
            </div>
          </button>
          {/* Session timer badge — hidden on the narrowest phones so
              the name + back arrow keep their room. */}
          <span className="sr-only">{contact.phone}</span>
        </div>

        <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
          {/* Contact-panel toggle — desktop only. The contact sidebar
              eats a chunk of horizontal width that crowds the thread on
              smaller laptops; this lets agents reclaim it when they just
              want to read and reply. Hidden on mobile, where the sidebar
              never renders as a permanent panel anyway. Issue #258. */}

          {/* Manual refresh — forces a refetch of the messages + the
              conversation list (the parent bumps its resyncToken). Useful
              when realtime missed an event or the agent just wants to be
              sure nothing's stale. Only rendered when the parent wires
              up `onRefresh`. */}
          {onRefresh && (
            <button
              type="button"
              onClick={handleRefreshClick}
              disabled={isRefreshing}
              aria-label={t('refreshConversation')}
              title={t('refresh')}
              className={cn(
                'text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-60'
              )}
            >
              <RefreshCw
                className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')}
              />
            </button>
          )}

          <Badge
            variant="outline"
            title={statusLabel}
            className={cn(
              'border-border hidden h-7 gap-1 text-[10px] sm:inline-flex',
              sessionInfo.expired ? 'text-red-400' : statusColor
            )}
          >
            <Clock className="h-3 w-3" />
            {sessionInfo.remaining || statusLabel}
          </Badge>

          {conversation.status === 'pending' && (
            <button
              type="button"
              disabled={ticketAction !== null}
              onClick={() => void handleTicketAction('accept')}
              title={t('accept')}
              aria-label={t('accept')}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-8 w-8 items-center justify-center gap-1 rounded-md px-0 text-xs font-medium disabled:opacity-60 sm:h-7 sm:w-auto sm:px-2"
            >
              <Check className="h-3 w-3" />
              <span className="hidden sm:inline">{t('accept')}</span>
            </button>
          )}

          {conversation.status === 'open' && (
            <>
              <button
                type="button"
                disabled={ticketAction !== null}
                onClick={() => void handleTicketAction('return_to_pending')}
                title={t('returnToPending')}
                aria-label={t('returnToPending')}
                className="border-border bg-background text-primary hover:bg-muted inline-flex h-8 w-8 items-center justify-center gap-1 rounded-md border px-0 text-xs font-medium disabled:opacity-60 sm:w-auto sm:px-3"
              >
                <CornerUpLeft className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t('returnToPending')}</span>
              </button>
              <button
                type="button"
                disabled={ticketAction !== null}
                onClick={() => void handleTicketAction('resolve')}
                title={t('resolve')}
                aria-label={t('resolve')}
                className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-8 w-8 items-center justify-center gap-1 rounded-md px-0 text-xs font-medium disabled:opacity-60 sm:w-auto sm:px-3"
              >
                <Check className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t('resolve')}</span>
              </button>
            </>
          )}

          {conversation.status === 'closed' && (
            <button
              type="button"
              disabled={ticketAction !== null}
              onClick={() => void handleTicketAction('reopen')}
              title={t('reopen')}
              aria-label={t('reopen')}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-8 w-8 items-center justify-center gap-1 rounded-md px-0 text-xs font-medium disabled:opacity-60 sm:w-auto sm:px-3"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t('reopen')}</span>
            </button>
          )}

          {/* Assign dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                'hover:bg-muted inline-flex h-8 w-8 items-center justify-center rounded-md',
                assignedAgentId ? 'text-primary' : 'text-muted-foreground'
              )}
              title={assignLabel}
              aria-label={assignLabel}
            >
              <MoreVertical className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border bg-popover"
            >
              <DropdownMenuItem
                onClick={() => {
                  setTransferAgentId('');
                  setTransferDepartmentId(conversation.department_id ?? '');
                  setTransferLineId(conversation.whatsapp_config_id ?? '');
                  setTransferOpen(true);
                }}
                className="text-sm"
              >
                {t('transferOrAssign')}
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                onClick={() => void handleDeleteConversation()}
                className="text-destructive text-sm"
              >
                {t('deleteTicket')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {departmentHeaderColor ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5"
            style={{ backgroundColor: departmentHeaderColor }}
          />
        ) : null}
      </div>

      <TransferDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        members={members}
        departments={departments}
        lines={lines}
        selectedAgentId={transferAgentId}
        onSelectedAgentIdChange={setTransferAgentId}
        selectedDepartmentId={transferDepartmentId}
        onSelectedDepartmentIdChange={setTransferDepartmentId}
        selectedLineId={transferLineId}
        onSelectedLineIdChange={setTransferLineId}
        onSubmit={() => void handleTransferSubmit()}
        getPresence={getPresence}
        getRow={getRow}
        now={now}
        currentUserId={user?.id}
        t={t}
      />
      {confirmDialog}

      {/* Messages Area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {selectionMode && (
          <div className="border-border bg-card/95 sticky top-0 z-20 mb-3 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 shadow-sm backdrop-blur">
            <div className="text-foreground flex items-center gap-2 text-sm font-medium">
              <button
                type="button"
                onClick={clearMessageSelection}
                className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded-md"
                aria-label={t('cancelSelection')}
              >
                <X className="size-4" />
              </button>
              {t('selectedMessages', { count: selectedMessageIds.size })}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => void handleCopySelectedMessages()}
                className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-8 items-center justify-center rounded-md"
                title={tActions('copy')}
                aria-label={tActions('copy')}
              >
                <Copy className="size-4" />
              </button>
              <button
                type="button"
                onClick={openForwardDialog}
                className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-8 items-center justify-center rounded-md"
                title={t('forward')}
                aria-label={t('forward')}
              >
                <Forward className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteSelectedMessages()}
                className="text-destructive hover:bg-destructive/10 flex size-8 items-center justify-center rounded-md"
                title={t('delete')}
                aria-label={t('delete')}
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground text-sm">
              {t('noMessagesYet')}
            </p>
            <p className="text-muted-foreground text-xs">
              {t('sendTemplateHint')}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {messageGroups.map((group) => (
              <div key={group.date}>
                {/* Date separator */}
                <div className="mb-4 flex items-center justify-center">
                  <span className="bg-muted text-muted-foreground rounded-full px-3 py-1 text-[10px] font-medium">
                    {formatDateSeparator(group.date, t, locale)}
                  </span>
                </div>
                {/* Messages */}
                <div className="space-y-2">
                  {group.messages.map((msg) => {
                    const parent = msg.reply_to_message_id
                      ? messagesById.get(msg.reply_to_message_id)
                      : null;
                    const reply = parent
                      ? {
                          authorLabel:
                            parent.sender_type === 'agent' ||
                            parent.sender_type === 'bot'
                              ? t('me')
                              : contact?.name || contact?.phone || 'Unknown',
                          preview: buildReplyPreview(parent, tQuote),
                          messageId: parent.id,
                        }
                      : null;
                    const msgReactions = reactionsByMessageId.get(msg.id);
                    // Toggle is computed at the call site — `msgReactions`
                    // and `user?.id` are already in scope, no extra hook.
                    const handlePillToggle = (emoji: string) => {
                      const own = msgReactions?.find(
                        (r) =>
                          r.actor_type === 'agent' && r.actor_id === user?.id
                      );
                      const next = own?.emoji === emoji ? '' : emoji;
                      void postReaction(msg.id, next);
                    };
                    if (msg.content_type === 'system') {
                      return (
                        <div key={msg.id} data-message-id={msg.id}>
                          <MessageBubble message={msg} />
                        </div>
                      );
                    }
                    return (
                      <div
                        key={msg.id}
                        data-message-id={msg.id}
                        className={cn(
                          'rounded-2xl transition-all duration-300',
                          highlightMessageId === msg.id &&
                            'bg-primary/10 ring-primary/40 ring-offset-background animate-pulse ring-2 ring-offset-2'
                        )}
                      >
                        <MessageActions
                          message={msg}
                          onReply={() => handleStartReply(msg)}
                          onReact={(emoji) => {
                            if (emoji) void postReaction(msg.id, emoji);
                          }}
                          onDelete={() => handleDeleteMessage(msg.id)}
                          onToggleStar={() => handleToggleMessageStar(msg)}
                          onSelect={() => beginMessageSelection(msg.id)}
                          onForward={() => openForwardDialogForMessage(msg.id)}
                          onAiReply={() => handleAiReplyToMessage(msg)}
                          onToggleSelected={() => toggleSelectedMessage(msg.id)}
                          selected={selectedMessageIds.has(msg.id)}
                          selectionMode={selectionMode}
                        >
                          <MessageBubble
                            message={msg}
                            reply={reply}
                            reactions={msgReactions}
                            currentUserId={user?.id}
                            onToggleReaction={handlePillToggle}
                            templateFallbackPayload={
                              msg.template_name
                                ? templateFallbackPayloads[msg.template_name]
                                : null
                            }
                            onJumpToMessage={jumpToMessage}
                          />
                        </MessageActions>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* AI auto-reply banner — take over an active bot, or resume it
          after a handoff. Renders nothing unless the account has
          auto-reply configured. */}
      <Dialog open={forwardDialogOpen} onOpenChange={setForwardDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogTitle>{t('forward')}</DialogTitle>
          <div className="space-y-3">
            <Select
              value={forwardContactId}
              onValueChange={(value) => setForwardContactId(value ?? '')}
            >
              <SelectTrigger className="w-full">
                <span className="truncate">
                  {forwardContacts.find(
                    (contact) => contact.id === forwardContactId
                  )?.name ??
                    forwardContacts.find(
                      (contact) => contact.id === forwardContactId
                    )?.phone ??
                    t('chooseForwardTarget')}
                </span>
              </SelectTrigger>
              <SelectContent>
                {forwardContacts.map((contact) => (
                  <SelectItem key={contact.id} value={contact.id}>
                    {contact.name || contact.phone || t('unknown')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={forwardLineId}
              onValueChange={(value) => setForwardLineId(value ?? '')}
            >
              <SelectTrigger className="w-full">
                <span className="truncate">
                  {lines.find((line) => line.id === forwardLineId)?.label ??
                    t('transferLine')}
                </span>
              </SelectTrigger>
              <SelectContent>
                {lines.map((line) => (
                  <SelectItem key={line.id} value={line.id}>
                    {line.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setForwardDialogOpen(false)}
                className="border-border hover:bg-muted h-9 rounded-md border px-3 text-sm font-medium"
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                disabled={!forwardContactId || !forwardLineId}
                onClick={() => void handleForwardSelectedMessages()}
                className="bg-primary text-primary-foreground hover:bg-primary/90 h-9 rounded-md px-3 text-sm font-medium disabled:opacity-50"
              >
                {t('forward')}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AiThreadBanner
        conversationId={conversation.id}
        disabled={conversation.ai_autoreply_disabled ?? false}
        handoffSummary={conversation.ai_handoff_summary}
        assignedAgentId={assignedAgentId}
        currentUserId={user?.id}
        onChange={(patch) => {
          if ('assigned_agent_id' in patch) {
            onAssignChange(conversation.id, patch.assigned_agent_id ?? null);
          }
        }}
      />

      {/* Composer */}
      <MessageComposer
        conversationId={conversation.id}
        sessionExpired={sessionInfo.expired}
        locked={composerLocked}
        lockedReason={composerLockedReason}
        onSend={handleSend}
        onSendMedia={handleSendMedia}
        onSendInteractive={handleSendInteractive}
        onOpenTemplates={handleOpenTemplates}
        replyTo={replyTo}
        aiDraftSeed={aiDraftSeed}
        onClearReply={() => setReplyTo(null)}
        signatureEnabled={signatureEnabled}
        onSignatureEnabledChange={handleSignatureEnabledChange}
        contact={contact}
      />

      <TemplatePicker
        open={templateModalOpen}
        onOpenChange={setTemplateModalOpen}
        onSelect={handleSendTemplate}
      />
    </div>
  );
}
