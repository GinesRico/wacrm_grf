'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { matchesContactFilters } from '@/lib/inbox/contact-filters';
import type { InboxScope, InboxSubtab, InboxTab } from '@/lib/inbox/tickets';
import { cn } from '@/lib/utils';
import type {
  Conversation,
  Department,
  InteractiveMessagePayload,
  Message,
  Tag,
} from '@/types';
import {
  Search,
  ChevronDown,
  X,
  Check,
  Inbox,
  CircleCheckBig,
  Building2,
  User,
  Users,
  Eye,
  CornerDownLeft,
  Ban,
  ArrowLeftRight,
  Forward,
  ImageIcon,
  Mic,
  Video,
  FileText,
  MapPin,
  LayoutTemplate,
  MessageSquare,
  ExternalLink,
  UserRound,
} from 'lucide-react';
import { format, type Locale } from 'date-fns';
import { es } from 'date-fns/locale';
import { useLocale, useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAuth } from '@/hooks/use-auth';
import { WhatsAppText } from './whatsapp-text';
import { TransferChatDialog } from './transfer-chat-dialog';
import {
  resolveTemplateButtonUrl,
  toInteractiveTemplateButton,
} from '@/lib/inbox/template-buttons';

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  onClearSelection?: () => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  onConversationUpdated: (conversation: Conversation) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility -> visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

interface InboxCounts {
  inboxOpen: number;
  inboxPending: number;
  resolved: number;
}

const INBOX_PREFERENCES_STORAGE_KEY = 'wacrm:inbox:conversation-list';

interface InboxPreferences {
  tab: InboxTab;
  subtab: InboxSubtab;
  scope: InboxScope;
  selectedDepartmentIds: string[];
  selectedTagIds: string[];
  selectedCompany: string | null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readInboxPreferences(): Partial<InboxPreferences> | null {
  try {
    const raw = localStorage.getItem(INBOX_PREFERENCES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      tab:
        parsed.tab === 'resolved' || parsed.tab === 'search'
          ? parsed.tab
          : parsed.tab === 'inbox'
            ? 'inbox'
            : undefined,
      subtab: parsed.subtab === 'pending' ? 'pending' : 'open',
      scope: parsed.scope === 'all' ? 'all' : 'mine',
      selectedDepartmentIds: readStringArray(parsed.selectedDepartmentIds),
      selectedTagIds: readStringArray(parsed.selectedTagIds),
      selectedCompany:
        typeof parsed.selectedCompany === 'string'
          ? parsed.selectedCompany
          : null,
    };
  } catch {
    return null;
  }
}

function writeInboxPreferences(preferences: InboxPreferences) {
  try {
    localStorage.setItem(
      INBOX_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences)
    );
  } catch {
    // localStorage persistence is best-effort.
  }
}

type MediaPreviewKind =
  | 'image'
  | 'audio'
  | 'video'
  | 'sticker'
  | 'document'
  | 'location'
  | 'template'
  | 'interactive'
  | 'unsupported';

function parseMediaPreviewToken(text: string): MediaPreviewKind | null {
  const normalized = text.trim().toLowerCase();
  if (
    normalized === '[unsupported]' ||
    normalized.startsWith('[unsupported message type:')
  ) {
    return 'unsupported';
  }
  switch (normalized) {
    case '[image]':
    case 'image':
    case 'imagen':
      return 'image';
    case '[audio]':
    case 'audio':
    case 'nota de voz':
      return 'audio';
    case '[video]':
    case 'video':
      return 'video';
    case '[sticker]':
    case 'sticker':
      return 'sticker';
    case '[document]':
    case 'document':
    case 'documento':
      return 'document';
    case '[location]':
    case 'location':
    case 'ubicacion':
    case 'ubicación':
      return 'location';
    case '[template]':
    case 'template':
    case 'plantilla':
      return 'template';
    case '[interactive]':
    case 'interactive':
      return 'interactive';
    case 'unsupported':
      return 'unsupported';
    default:
      return null;
  }
}

function mediaPreviewLabel(
  kind: MediaPreviewKind,
  t: ReturnType<typeof useTranslations>
) {
  switch (kind) {
    case 'image':
      return t('mediaImage');
    case 'audio':
      return t('mediaAudio');
    case 'video':
      return t('mediaVideo');
    case 'sticker':
      return t('mediaSticker');
    case 'document':
      return t('mediaDocument');
    case 'location':
      return t('mediaLocation');
    case 'template':
      return t('mediaTemplate');
    case 'interactive':
      return t('mediaInteractive');
    case 'unsupported':
      return t('mediaUnsupported');
  }
}

function MediaPreviewIcon({ kind }: { kind: MediaPreviewKind }) {
  switch (kind) {
    case 'image':
      return <ImageIcon className="size-3.5" />;
    case 'audio':
      return <Mic className="size-3.5" />;
    case 'video':
      return <Video className="size-3.5" />;
    case 'sticker':
      return <MessageSquare className="size-3.5" />;
    case 'document':
      return <FileText className="size-3.5" />;
    case 'location':
      return <MapPin className="size-3.5" />;
    case 'template':
      return <LayoutTemplate className="size-3.5" />;
    case 'interactive':
      return <MessageSquare className="size-3.5" />;
    case 'unsupported':
      return <MessageSquare className="size-3.5" />;
  }
}

function ConversationPreviewText({
  text,
  t,
}: {
  text: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const kind = parseMediaPreviewToken(text);
  if (!kind) {
    return <WhatsAppText text={text} />;
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="text-muted-foreground shrink-0">
        <MediaPreviewIcon kind={kind} />
      </span>
      <span className="truncate">{mediaPreviewLabel(kind, t)}</span>
    </span>
  );
}

export function ConversationList({
  activeConversationId,
  onSelect,
  onClearSelection,
  conversations,
  onConversationsLoaded,
  onConversationUpdated,
  resyncToken = 0,
}: ConversationListProps) {
  const t = useTranslations('Inbox.conversationList');
  const tThread = useTranslations('Inbox.messageThread');
  const locale = useLocale();
  const dateLocale = locale.startsWith('es') ? es : undefined;
  const { user } = useAuth();
  const currentUserId = user?.id;

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [tab, setTab] = useState<InboxTab>('inbox');
  const [subtab, setSubtab] = useState<InboxSubtab>('open');
  const [scope, setScope] = useState<InboxScope>('mine');
  const [counts, setCounts] = useState<InboxCounts>({
    inboxOpen: 0,
    inboxPending: 0,
    resolved: 0,
  });
  const [loading, setLoading] = useState(true);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [previewConversation, setPreviewConversation] =
    useState<Conversation | null>(null);
  const [previewMessages, setPreviewMessages] = useState<Message[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedDepartmentIds, setSelectedDepartmentIds] = useState<string[]>(
    []
  );
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  const effectiveScope: InboxScope = tab === 'inbox' ? scope : 'all';

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable identity across parent rerenders.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  const conversationsCountRef = useRef(conversations.length);
  const fetchKeyRef = useRef('');
  const fetchSeqRef = useRef(0);
  const activeStatusRef = useRef<Conversation['status'] | null>(null);
  const conversationStatusesRef = useRef<Map<string, Conversation['status']>>(
    new Map()
  );
  const preferencesHydratedRef = useRef(false);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
    conversationsCountRef.current = conversations.length;
  });

  useEffect(() => {
    const stored = readInboxPreferences();
    queueMicrotask(() => {
      if (stored?.tab) setTab(stored.tab);
      if (stored?.subtab) setSubtab(stored.subtab);
      if (stored?.scope) setScope(stored.scope);
      if (stored?.selectedDepartmentIds) {
        setSelectedDepartmentIds(stored.selectedDepartmentIds);
      }
      if (stored?.selectedTagIds) setSelectedTagIds(stored.selectedTagIds);
      if (stored && 'selectedCompany' in stored) {
        setSelectedCompany(stored.selectedCompany ?? null);
      }
      preferencesHydratedRef.current = true;
    });
  }, []);

  useEffect(() => {
    if (!preferencesHydratedRef.current) return;
    writeInboxPreferences({
      tab,
      subtab,
      scope,
      selectedDepartmentIds,
      selectedTagIds,
      selectedCompany,
    });
  }, [
    tab,
    subtab,
    scope,
    selectedDepartmentIds,
    selectedTagIds,
    selectedCompany,
  ]);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search.trim()), 500);
    return () => clearTimeout(handle);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const fetchSeq = ++fetchSeqRef.current;

    (async () => {
      const fetchKey = [tab, subtab, effectiveScope, debouncedSearch].join('|');
      const shouldShowLoading =
        fetchKey !== fetchKeyRef.current || conversationsCountRef.current === 0;
      fetchKeyRef.current = fetchKey;
      if (shouldShowLoading) setLoading(true);
      try {
        const params = new URLSearchParams({
          tab,
          subtab,
          scope: effectiveScope,
        });
        if (debouncedSearch) params.set('search', debouncedSearch);

        const res = await fetch(
          `/api/inbox/conversations?${params.toString()}`,
          {
            cache: 'no-store',
            signal: controller.signal,
          }
        );
        const payload = await res.json().catch(() => ({}));

        if (cancelled || fetchSeq !== fetchSeqRef.current) return;

        if (!res.ok) {
          console.error('Failed to fetch conversations:', payload);
          return;
        }

        onConversationsLoadedRef.current(payload.conversations ?? []);
        setCounts(
          payload.counts ?? { inboxOpen: 0, inboxPending: 0, resolved: 0 }
        );
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          console.error('Failed to fetch conversations:', error);
        }
      } finally {
        if (!cancelled && fetchSeq === fetchSeqRef.current) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [tab, subtab, effectiveScope, debouncedSearch, resyncToken]);

  // Tag and department definitions for the filter pickers; loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [tagsRes, departmentRes] = await Promise.all([
        fetch('/api/tags', { cache: 'no-store' }),
        fetch('/api/departments', { cache: 'no-store' }),
      ]);
      const tagsPayload = await tagsRes.json().catch(() => ({}));
      const departmentPayload = await departmentRes.json().catch(() => ({}));
      if (!cancelled && tagsRes.ok) {
        setTags((tagsPayload.tags as Tag[] | undefined) ?? []);
      }
      if (!cancelled && departmentRes.ok) {
        setDepartments(
          (departmentPayload.departments as Department[] | undefined) ?? []
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    let result = conversations;

    if (tab === 'resolved') {
      result = result.filter((c) => c.status === 'closed');
    } else if (tab === 'inbox') {
      result = result.filter((c) => c.status === subtab);
    }

    if (effectiveScope === 'mine') {
      result = result.filter(
        (c) =>
          c.status === 'pending' ||
          !currentUserId ||
          c.assigned_agent_id === currentUserId
      );
    }

    if (selectedDepartmentIds.length > 0) {
      result = result.filter(
        (c) =>
          c.department_id && selectedDepartmentIds.includes(c.department_id)
      );
    }

    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    return result;
  }, [
    conversations,
    tab,
    subtab,
    effectiveScope,
    currentUserId,
    selectedDepartmentIds,
    selectedTagIds,
    selectedCompany,
  ]);

  const visiblePendingCount = useMemo(() => {
    let result = conversations.filter((c) => c.status === 'pending');

    if (effectiveScope === 'mine') {
      result = result.filter((c) => c.status === 'pending');
    }

    if (selectedDepartmentIds.length > 0) {
      result = result.filter(
        (c) =>
          c.department_id && selectedDepartmentIds.includes(c.department_id)
      );
    }

    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    return result.length;
  }, [
    conversations,
    effectiveScope,
    selectedDepartmentIds,
    selectedTagIds,
    selectedCompany,
  ]);

  useEffect(() => {
    let cancelled = false;
    const activeStatus =
      conversations.find(
        (conversation) => conversation.id === activeConversationId
      )?.status ?? null;
    const previousStatus = activeStatusRef.current;
    activeStatusRef.current = activeStatus;
    const previousStatuses = conversationStatusesRef.current;
    const nextStatuses = new Map(
      conversations.map((conversation) => [
        conversation.id,
        conversation.status,
      ])
    );
    conversationStatusesRef.current = nextStatuses;

    const closedOpenConversation = conversations.some(
      (conversation) =>
        previousStatuses.get(conversation.id) === 'open' &&
        conversation.status === 'closed'
    );
    const openCount = conversations.filter(
      (conversation) => conversation.status === 'open'
    ).length;

    if (
      closedOpenConversation &&
      openCount === 0 &&
      (counts.inboxPending > 0 || visiblePendingCount > 0)
    ) {
      queueMicrotask(() => {
        if (cancelled) return;
        setTab('inbox');
        setSubtab('pending');
      });
    }

    if (previousStatus !== 'closed') {
      return () => {
        cancelled = true;
      };
    }
    if (activeStatus === 'open') {
      queueMicrotask(() => {
        if (cancelled) return;
        setTab('inbox');
        setSubtab('open');
      });
    } else if (activeStatus === 'pending') {
      queueMicrotask(() => {
        if (cancelled) return;
        setTab('inbox');
        setSubtab('pending');
      });
    }

    return () => {
      cancelled = true;
    };
  }, [
    activeConversationId,
    conversations,
    counts.inboxPending,
    visiblePendingCount,
  ]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const toggleDepartment = useCallback((id: string) => {
    setSelectedDepartmentIds((prev) =>
      prev.includes(id)
        ? prev.filter((departmentId) => departmentId !== id)
        : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters =
    selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
      if (tab !== 'search') setTab('search');
    },
    [tab]
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const handleAccept = useCallback(
    async (conversation: Conversation) => {
      if (acceptingId) return;
      setAcceptingId(conversation.id);
      try {
        const res = await fetch('/api/inbox/conversations', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'accept',
            conversation_id: conversation.id,
          }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok || !payload.conversation) {
          console.error('Failed to accept conversation:', payload);
          return;
        }
        onConversationUpdated(payload.conversation);
        onSelect(payload.conversation);
        setTab('inbox');
        setSubtab('open');
      } finally {
        setAcceptingId(null);
      }
    },
    [acceptingId, onConversationUpdated, onSelect]
  );

  const handlePreview = useCallback(async (conversation: Conversation) => {
    setPreviewConversation(conversation);
    setPreviewMessages([]);
    setPreviewLoading(true);

    const res = await fetch(
      `/api/inbox/messages?conversation_id=${conversation.id}`,
      {
        cache: 'no-store',
      }
    );
    const payload = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.error('Failed to load conversation preview:', payload);
      setPreviewMessages([]);
    } else {
      setPreviewMessages(
        ((payload.messages as Message[] | undefined) ?? []).slice(-30)
      );
    }

    setPreviewLoading(false);
  }, []);

  const patchConversation = useCallback(
    async (conversation: Conversation, action: 'accept' | 'resolve') => {
      const res = await fetch('/api/inbox/conversations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, conversation_id: conversation.id }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload.conversation) {
        console.error('Failed to update conversation:', payload);
        return;
      }
      onConversationUpdated(payload.conversation);
      if (action === 'accept') {
        onSelect(payload.conversation);
        setTab('inbox');
        setSubtab('open');
        setPreviewConversation(null);
        setPreviewMessages([]);
        return;
      }
      if (action === 'resolve') {
        setPreviewConversation(null);
        setPreviewMessages([]);
        if (activeConversationId === conversation.id) {
          onClearSelection?.();
        }
        return;
      }
      setPreviewConversation(payload.conversation);
    },
    [activeConversationId, onClearSelection, onConversationUpdated, onSelect]
  );

  return (
    <div
      className={cn(
        'border-border bg-card flex h-full w-full min-w-0 flex-col border-r lg:w-[23.75rem]'
      )}
    >
      <div className="border-border min-w-0 border-b">
        <div className="border-border flex min-w-0 items-center border-b px-2 pt-2">
          <div className="grid min-w-0 flex-1 grid-cols-3">
            <TabButton
              active={tab === 'inbox'}
              onClick={() => setTab('inbox')}
              label={t('tabInbox')}
              icon={Inbox}
            />
            <TabButton
              active={tab === 'resolved'}
              onClick={() => setTab('resolved')}
              label={t('tabResolved')}
              icon={CircleCheckBig}
            />
            <TabButton
              active={tab === 'search'}
              onClick={() => setTab('search')}
              label={t('tabSearch')}
              icon={Search}
            />
          </div>
        </div>

        <div className="space-y-2 px-3 pt-3 pb-0">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
              <Input
                value={search}
                onChange={handleSearchChange}
                placeholder={
                  tab === 'inbox'
                    ? t('searchInboxPlaceholder')
                    : t('searchPlaceholder')
                }
                className="border-border bg-background text-foreground placeholder-muted-foreground focus:border-primary/50 h-10 rounded-full pr-3 pl-9 text-sm"
              />
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger
                title={t('departmentFilter')}
                aria-label={t('departmentFilter')}
                className="border-border bg-background text-muted-foreground hover:border-primary/30 hover:bg-primary/10 hover:text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition-colors"
              >
                <Building2 className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {departments.length === 0 ? (
                  <DropdownMenuItem disabled>
                    {t('noDepartmentsAvailable')}
                  </DropdownMenuItem>
                ) : (
                  departments.map((department) => (
                    <DropdownMenuCheckboxItem
                      key={department.id}
                      checked={selectedDepartmentIds.includes(department.id)}
                      onCheckedChange={() => toggleDepartment(department.id)}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: department.color }}
                        />
                        <span className="truncate">{department.name}</span>
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <button
              type="button"
              disabled={tab !== 'inbox'}
              onClick={() =>
                setScope((value) => (value === 'mine' ? 'all' : 'mine'))
              }
              title={effectiveScope === 'mine' ? t('scopeMine') : t('scopeAll')}
              aria-label={
                effectiveScope === 'mine' ? t('scopeMine') : t('scopeAll')
              }
              className={cn(
                'flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition-colors',
                effectiveScope === 'mine'
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground',
                tab !== 'inbox' && 'cursor-default opacity-80'
              )}
            >
              {effectiveScope === 'mine' ? (
                <User className="h-4 w-4" />
              ) : (
                <Users className="h-4 w-4" />
              )}
            </button>
          </div>

          {tab === 'inbox' && (
            <div className="grid min-w-0 grid-cols-2">
              <SubtabButton
                active={subtab === 'open'}
                onClick={() => setSubtab('open')}
                label={t('subtabOpen')}
                count={counts.inboxOpen}
              />
              <SubtabButton
                active={subtab === 'pending'}
                onClick={() => setSubtab('pending')}
                label={t('subtabPending')}
                count={counts.inboxPending}
              />
            </div>
          )}

          {(tags.length > 0 || companies.length > 0) && (
            <div className="flex flex-wrap items-center gap-1">
              {tags.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className={cn(
                      'hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs',
                      selectedTagIds.length > 0
                        ? 'text-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {t('tags')}
                    {selectedTagIds.length > 0 && (
                      <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                        {selectedTagIds.length}
                      </span>
                    )}
                    <ChevronDown className="h-3 w-3" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="border-border bg-popover max-h-64 w-56"
                  >
                    {tags.map((tag) => (
                      <DropdownMenuCheckboxItem
                        key={tag.id}
                        checked={selectedTagIds.includes(tag.id)}
                        onCheckedChange={() => toggleTag(tag.id)}
                        className="text-popover-foreground text-sm"
                      >
                        <span className="flex items-center gap-2">
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: tag.color }}
                          />
                          <span className="truncate">{tag.name}</span>
                        </span>
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              {companies.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className={cn(
                      'hover:bg-muted inline-flex h-7 max-w-40 items-center justify-center gap-1 rounded-md px-2 text-xs',
                      selectedCompany
                        ? 'text-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <span className="truncate">
                      {selectedCompany ?? t('company')}
                    </span>
                    <ChevronDown className="h-3 w-3 shrink-0" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="border-border bg-popover max-h-64 w-56"
                  >
                    <DropdownMenuItem
                      onClick={() => setSelectedCompany(null)}
                      className={cn(
                        'text-sm',
                        selectedCompany === null
                          ? 'text-primary'
                          : 'text-popover-foreground'
                      )}
                    >
                      {t('allCompanies')}
                    </DropdownMenuItem>
                    {companies.map((co) => (
                      <DropdownMenuItem
                        key={co}
                        onClick={() => setSelectedCompany(co)}
                        className={cn(
                          'text-sm',
                          selectedCompany === co
                            ? 'text-primary'
                            : 'text-popover-foreground'
                        )}
                      >
                        <span className="truncate">{co}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}

          {hasContactFilters && (
            <div className="flex flex-wrap items-center gap-1">
              {selectedTagIds.map((id) => {
                const tag = tagsById.get(id);
                return (
                  <button
                    key={id}
                    onClick={() => toggleTag(id)}
                    className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor:
                          tag?.color ?? 'var(--muted-foreground)',
                      }}
                    />
                    <span className="max-w-24 truncate">
                      {tag?.name ?? t('tags')}
                    </span>
                    <X className="h-3 w-3" />
                  </button>
                );
              })}
              {selectedCompany && (
                <button
                  onClick={() => setSelectedCompany(null)}
                  className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                >
                  <span className="max-w-24 truncate">{selectedCompany}</span>
                  <X className="h-3 w-3" />
                </button>
              )}
              <button
                onClick={clearContactFilters}
                className="text-muted-foreground hover:text-foreground px-1 text-[11px]"
              >
                {t('clearAll')}
              </button>
            </div>
          )}
        </div>
      </div>

      <ScrollArea className={cn('min-h-0 flex-1', tab !== 'inbox' && 'pt-px')}>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-muted-foreground text-sm">
              {t('noConversations')}
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                onPreview={handlePreview}
                onAccept={handleAccept}
                accepting={acceptingId === conv.id}
                dateLocale={dateLocale}
                t={t}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      <ConversationPreviewDialog
        conversation={previewConversation}
        messages={previewMessages}
        loading={previewLoading}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewConversation(null);
            setPreviewMessages([]);
          }
        }}
        onAccept={(conversation) => patchConversation(conversation, 'accept')}
        onResolve={(conversation) => patchConversation(conversation, 'resolve')}
        t={t}
        tTransfer={tThread}
        currentUserId={user?.id}
        onConversationUpdated={onConversationUpdated}
      />
    </div>
  );
}

function TabButton({
  active,
  label,
  icon: Icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: typeof Inbox;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cn(
        'relative flex min-w-0 items-center justify-center gap-1.5 px-1 text-xs font-medium transition-colors sm:px-2',
        'h-14 border-b-2',
        active
          ? 'border-primary text-foreground'
          : 'text-muted-foreground hover:text-foreground border-transparent'
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0', active && 'text-primary')} />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function SubtabButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative flex h-10 min-w-0 items-center justify-center gap-1 border-b-2 px-1 text-sm font-medium transition-colors sm:px-2',
        active
          ? 'border-primary text-foreground'
          : 'border-border text-muted-foreground hover:text-foreground'
      )}
    >
      <span className="min-w-0 truncate">{label}</span>
      {count > 0 && (
        <span className="bg-primary text-primary-foreground ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
          {count}
        </span>
      )}
    </button>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  onPreview: (conversation: Conversation) => void;
  onAccept: (conversation: Conversation) => void;
  accepting: boolean;
  dateLocale?: Locale;
  t: ReturnType<typeof useTranslations>;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  onPreview,
  onAccept,
  accepting,
  dateLocale,
  t,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t('unknown');
  const lineName =
    conversation.whatsapp_config?.label ||
    conversation.whatsapp_config?.phone_number_id ||
    null;
  const department = conversation.department;
  const lineInitial = lineName?.charAt(0).toUpperCase() ?? null;
  const assignedAgent = conversation.assigned_agent;
  const assignedAgentName =
    assignedAgent?.full_name || assignedAgent?.email || null;
  const assignedInitial = assignedAgentName?.charAt(0).toUpperCase() ?? null;
  const opensDirectly = conversation.status !== 'pending';
  const isResolved = conversation.status === 'closed';

  const handleClick = useCallback(() => {
    if (opensDirectly) onSelect(conversation);
  }, [conversation, onSelect, opensDirectly]);

  const lastMessageTime = conversation.last_message_at
    ? format(new Date(conversation.last_message_at), 'HH:mm', {
        locale: dateLocale,
      })
    : '';
  return (
    <div
      className={cn(
        'border-border/70 hover:bg-muted/50 relative flex w-full items-stretch gap-3 border-b pl-3 text-left transition-colors',
        isActive && 'bg-muted/70'
      )}
    >
      <span
        className={cn(
          'absolute inset-y-0 left-0 w-1',
          !department &&
            (conversation.status === 'open'
              ? 'bg-primary'
              : conversation.status === 'pending'
                ? 'bg-destructive'
                : 'bg-muted-foreground')
        )}
        style={department ? { backgroundColor: department.color } : undefined}
      />
      <div
        role={opensDirectly ? 'button' : undefined}
        tabIndex={opensDirectly ? 0 : undefined}
        onClick={opensDirectly ? handleClick : undefined}
        onKeyDown={
          opensDirectly
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handleClick();
                }
              }
            : undefined
        }
        className="flex min-w-0 flex-1 items-start gap-3 py-3 pr-1 text-left"
      >
        <div className="relative h-11 w-11 shrink-0">
          <div className="bg-muted text-foreground flex h-10 w-10 items-center justify-center rounded-full text-sm font-medium">
            {contact?.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={contact.avatar_url}
                alt={displayName}
                className="h-10 w-10 rounded-full object-cover"
              />
            ) : (
              <UserRound className="h-4 w-4" />
            )}
          </div>

          {assignedInitial && (
            <span
              title={`${t('agent')}: ${assignedAgentName}`}
              className="border-card bg-primary/10 text-primary absolute -bottom-0.5 left-0 inline-flex h-4 min-w-4 items-center justify-center rounded-full border px-1 text-[10px] leading-none font-bold shadow-sm"
            >
              {assignedInitial}
            </span>
          )}
        </div>

        <div className="flex min-w-0 flex-1 items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <span className="text-foreground block truncate text-sm font-medium">
              {displayName}
            </span>
            <div className="mt-0.5 min-w-0 pt-0.5">
              <p className="text-muted-foreground truncate text-xs">
                <ConversationPreviewText
                  text={conversation.last_message_text || t('noMessagesYet')}
                  t={t}
                />
              </p>
            </div>
          </div>
          <div className="flex w-8 shrink-0 flex-col items-center gap-1">
            <span className="text-muted-foreground h-3 text-[10px] leading-3">
              {lastMessageTime}
            </span>
            <div className="flex h-4 items-center gap-1">
              <span
                role="button"
                tabIndex={0}
                title={isResolved ? t('statusClosed') : t('preview')}
                aria-label={isResolved ? t('statusClosed') : t('preview')}
                onClick={(event) => {
                  event.stopPropagation();
                  onPreview(conversation);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    onPreview(conversation);
                  }
                }}
                className={cn(
                  'hover:bg-muted inline-flex h-4 w-4 items-center justify-center rounded-full',
                  isResolved
                    ? 'text-primary hover:text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {isResolved ? (
                  <CircleCheckBig className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
              </span>
              {conversation.unread_count > 0 && (
                <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                  {conversation.unread_count}
                </span>
              )}
            </div>
            <div className="flex h-4 items-center">
              {lineInitial && (
                <span
                  title={`${t('line')}: ${lineName}`}
                  className="bg-muted text-muted-foreground inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-bold"
                >
                  {lineInitial}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {conversation.status === 'pending' && (
        <button
          type="button"
          disabled={accepting}
          onClick={() => onAccept(conversation)}
          className="group bg-primary text-primary-foreground hover:bg-primary/90 flex w-14 shrink-0 items-center justify-center overflow-hidden transition-all duration-200 ease-out hover:w-24 disabled:opacity-60"
          title={t('accept')}
          aria-label={t('accept')}
        >
          <Check className="h-5 w-5" />
          <span className="ml-0 max-w-0 overflow-hidden text-xs font-bold whitespace-nowrap opacity-0 transition-all duration-200 group-hover:ml-2 group-hover:max-w-16 group-hover:opacity-100">
            {t('accept')}
          </span>
        </button>
      )}
    </div>
  );
}

function ConversationPreviewDialog({
  conversation,
  messages,
  loading,
  onOpenChange,
  onAccept,
  onResolve,
  t,
  tTransfer,
  currentUserId,
  onConversationUpdated,
}: {
  conversation: Conversation | null;
  messages: Message[];
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onAccept: (conversation: Conversation) => void;
  onResolve: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
  tTransfer: ReturnType<typeof useTranslations>;
  currentUserId?: string;
  onConversationUpdated: (conversation: Conversation) => void;
}) {
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferAgentId, setTransferAgentId] = useState('');
  const [transferLineId, setTransferLineId] = useState('');
  const [transferDepartmentId, setTransferDepartmentId] = useState('');
  const [templateFallbackPayloads, setTemplateFallbackPayloads] = useState<
    Record<string, InteractiveMessagePayload>
  >({});
  const contact = conversation?.contact;
  const displayName = contact?.name || contact?.phone || t('unknown');
  const lineName =
    conversation?.whatsapp_config?.label ||
    conversation?.whatsapp_config?.phone_number_id ||
    null;
  const lineInitial = lineName?.charAt(0).toUpperCase() ?? null;
  const assignedAgentName =
    conversation?.assigned_agent?.full_name ||
    conversation?.assigned_agent?.email ||
    null;
  const assignedInitial = assignedAgentName?.charAt(0).toUpperCase() ?? null;

  const handleTransferSubmit = useCallback(async () => {
    if (!conversation) return;
    const res = await fetch('/api/inbox/conversations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'assign',
        conversation_id: conversation.id,
        assigned_agent_id: transferAgentId || null,
        whatsapp_config_id: transferLineId || null,
        department_id: transferDepartmentId || null,
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.conversation) {
      console.error('Failed to transfer conversation:', payload);
      return;
    }
    onConversationUpdated(payload.conversation);
    setTransferOpen(false);
  }, [
    conversation,
    onConversationUpdated,
    transferAgentId,
    transferDepartmentId,
    transferLineId,
  ]);

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
        console.error('Failed to fetch preview template buttons:', payload);
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

  return (
    <Dialog open={conversation !== null} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="max-h-[84vh] gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        {conversation && (
          <>
            <div className="border-border bg-card flex min-w-0 items-center gap-3 border-b py-3 pr-14 pl-4">
              <div className="relative h-11 w-11 shrink-0">
                <div className="bg-muted text-foreground flex h-10 w-10 items-center justify-center rounded-full text-sm font-medium">
                  {contact?.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={contact.avatar_url}
                      alt={displayName}
                      className="h-10 w-10 rounded-full object-cover"
                    />
                  ) : (
                    <UserRound className="h-4 w-4" />
                  )}
                </div>
                {assignedInitial && (
                  <span
                    title={`${t('agent')}: ${assignedAgentName}`}
                    className="border-card bg-primary/10 text-primary absolute -bottom-0.5 left-0 inline-flex h-4 min-w-4 items-center justify-center rounded-full border px-1 text-[10px] leading-none font-bold shadow-sm"
                  >
                    {assignedInitial}
                  </span>
                )}
              </div>

              <div className="min-w-0 flex-1 overflow-hidden">
                <DialogTitle className="max-w-full truncate text-sm leading-5 font-semibold">
                  {displayName}
                </DialogTitle>
                <div className="text-muted-foreground mt-1 flex min-w-0 items-center gap-1.5 text-xs">
                  {lineInitial && (
                    <span
                      title={`${t('line')}: ${lineName}`}
                      className="bg-muted text-muted-foreground inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-bold"
                    >
                      {lineInitial}
                    </span>
                  )}
                  {lineName && <span className="min-w-0 truncate">{lineName}</span>}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {conversation.status === 'pending' && (
                  <button
                    type="button"
                    onClick={() => onAccept(conversation)}
                    title={t('accept')}
                    aria-label={t('accept')}
                    className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-8 w-8 items-center justify-center rounded-md"
                  >
                    <Check className="h-4 w-4" />
                  </button>
                )}
                {conversation.status !== 'closed' && (
                  <button
                    type="button"
                    onClick={() => onResolve(conversation)}
                    title={t('resolve')}
                    aria-label={t('resolve')}
                    className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-8 w-8 items-center justify-center rounded-md"
                  >
                    <CircleCheckBig className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setTransferAgentId(conversation.assigned_agent_id ?? '');
                    setTransferLineId(conversation.whatsapp_config_id ?? '');
                    setTransferDepartmentId(conversation.department_id ?? '');
                    setTransferOpen(true);
                  }}
                  title={t('transfer')}
                  aria-label={t('transfer')}
                  className="border-border bg-background text-primary hover:bg-muted inline-flex h-8 w-8 items-center justify-center rounded-md border"
                >
                  <ArrowLeftRight className="h-4 w-4" />
                </button>
              </div>
            </div>

            <ScrollArea className="bg-background h-[62vh] bg-[url('/inbox-doodle.svg')] bg-repeat">
              <div className="space-y-2 px-6 py-4 sm:px-8">
                {loading ? (
                  <p className="text-muted-foreground text-center text-xs">
                    {t('loadingPreview')}
                  </p>
                ) : messages.length === 0 ? (
                  <p className="text-muted-foreground text-center text-xs">
                    {t('noMessagesYet')}
                  </p>
                ) : (
                  messages.map((message) => (
                    <PreviewMessageBubble
                      key={message.id}
                      message={message}
                      templateFallbackPayload={
                        message.template_name
                          ? templateFallbackPayloads[message.template_name]
                          : null
                      }
                    />
                  ))
                )}
              </div>
            </ScrollArea>
            <TransferChatDialog
              open={transferOpen}
              onOpenChange={setTransferOpen}
              selectedAgentId={transferAgentId}
              onSelectedAgentIdChange={setTransferAgentId}
              selectedLineId={transferLineId}
              onSelectedLineIdChange={setTransferLineId}
              selectedDepartmentId={transferDepartmentId}
              onSelectedDepartmentIdChange={setTransferDepartmentId}
              currentUserId={currentUserId}
              onSubmit={() => void handleTransferSubmit()}
              t={tTransfer}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PreviewTemplateActions({
  payload,
  onPrimary,
}: {
  payload: InteractiveMessagePayload;
  onPrimary: boolean;
}) {
  const buttonClass = cn(
    'flex w-full items-center justify-center gap-1.5 border-t px-3 py-1.5 text-xs font-medium',
    onPrimary ? 'border-primary/20 text-primary' : 'border-border text-primary'
  );

  return (
    <div className="mt-2 overflow-hidden">
      {payload.footer ? (
        <p
          className={cn(
            'px-1 py-1.5 text-[11px]',
            onPrimary ? 'text-foreground/60' : 'text-muted-foreground'
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
                <ExternalLink className="size-3" />
              ) : (
                <CornerDownLeft className="size-3" />
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
            'flex w-full items-center justify-center gap-1.5 border-t px-3 py-1.5 text-xs font-medium',
            onPrimary
              ? 'border-primary/20 text-primary'
              : 'border-border text-primary'
          )}
        >
          <CornerDownLeft className="size-3" />
          <span className="truncate">{payload.button_label}</span>
        </button>
      )}
    </div>
  );
}

function mergePreviewTemplatePayload(
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

function PreviewMessageBubble({
  message,
  templateFallbackPayload,
}: {
  message: Message;
  templateFallbackPayload?: InteractiveMessagePayload | null;
}) {
  const tBubble = useTranslations('Inbox.bubble');
  if (message.content_type === 'system') {
    return (
      <div className="flex justify-center py-1">
        <div className="bg-background/85 text-muted-foreground max-w-[80%] rounded-full px-4 py-2 text-center text-xs italic shadow-sm">
          <WhatsAppText text={message.content_text || ''} />
        </div>
      </div>
    );
  }

  const isAgent =
    message.sender_type === 'agent' || message.sender_type === 'bot';
  const templatePayload = mergePreviewTemplatePayload(
    message.interactive_payload,
    templateFallbackPayload
  );
  const isDeleted = Boolean(message.deleted_at);
  const fallback =
    message.content_type === 'image'
      ? 'Imagen'
      : message.content_type === 'audio'
        ? 'Nota de voz'
        : message.content_type === 'sticker'
          ? 'Sticker'
          : message.content_type === 'document'
            ? 'Documento'
            : '';
  const text = message.content_text || fallback;

  return (
    <div className={cn('flex w-full', isAgent ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'min-w-20 max-w-[min(82%,34rem)] rounded-lg px-3 py-2 text-sm shadow-sm',
          isDeleted
            ? isAgent
              ? 'border-primary/20 bg-primary/10 text-primary/80 border'
              : 'border-border bg-muted/60 text-muted-foreground border'
            : isAgent
              ? 'bg-primary/15 text-foreground'
              : 'bg-card text-card-foreground'
        )}
      >
        {isDeleted ? (
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
              <Ban className="size-3" />
              {tBubble('deletedTitle')}
            </span>
            <span className="text-xs break-words whitespace-pre-wrap opacity-80">
              <WhatsAppText text={text} />
            </span>
          </div>
        ) : (
          <>
            {message.is_forwarded ? (
              <div
                className={cn(
                  'mb-1 flex items-center gap-1 text-xs italic',
                  isAgent ? 'text-primary' : 'text-muted-foreground'
                )}
              >
                <Forward className="size-3" />
                {tBubble('forwarded')}
              </div>
            ) : null}
            {message.content_type === 'template' && message.media_url ? (
              <div className="bg-muted mb-2 overflow-hidden rounded-md">
                {/* eslint-disable-next-line @next/next/no-img-element -- Template header media uses dynamic public URLs. */}
                <img
                  src={message.media_url}
                  alt={tBubble('sharedImageAlt')}
                  className="max-h-52 w-full object-contain"
                />
              </div>
            ) : null}
            <p className="break-words whitespace-pre-wrap">
              <WhatsAppText text={text} />
            </p>
          </>
        )}
        {!isDeleted && templatePayload ? (
          <PreviewTemplateActions
            payload={templatePayload}
            onPrimary={isAgent}
          />
        ) : null}
        <span className="text-muted-foreground mt-1 block text-right text-[10px]">
          {new Date(message.created_at).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      </div>
    </div>
  );
}
