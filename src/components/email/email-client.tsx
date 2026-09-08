'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { EditorContent, useEditor } from '@tiptap/react';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import {
  Archive,
  Bold,
  CheckSquare,
  Download,
  FileIcon,
  FolderPlus,
  Info,
  Italic,
  Inbox,
  LinkIcon,
  Loader2,
  Mail,
  MailOpen,
  MoreHorizontal,
  Paperclip,
  PencilLine,
  Printer,
  RefreshCw,
  Reply,
  Search,
  Send,
  Settings,
  Square,
  Star,
  Tag,
  Trash2,
  UnderlineIcon,
  Wand2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface Mailbox {
  id: string;
  address: string;
  display_name: string | null;
  kind: 'personal' | 'shared';
  can_send: boolean;
}

interface Folder {
  id: string;
  mailbox_id: string;
  name: string;
  slug: string;
  kind: string;
  position: number;
}

interface Message {
  id: string;
  mailbox_id: string;
  folder_id: string;
  subject: string;
  from_name: string | null;
  from_address: string;
  to_addresses: string[];
  cc_addresses?: string[];
  received_at: string;
  snippet: string | null;
  body_text: string | null;
  body_html: string | null;
  is_read: boolean;
  is_starred: boolean;
  has_attachments: boolean;
  raw_size: number | null;
  labels?: EmailLabel[];
}

interface MessagesResponse {
  mailboxes: Mailbox[];
  folders: Folder[];
  messages: Message[];
}

interface Rule {
  id: string;
  mailbox_id: string;
  target_folder_id: string;
  name: string;
  field: string;
  operator: string;
  value: string;
  enabled: boolean;
}

interface Attachment {
  id: string;
  message_id: string;
  file_name: string;
  content_type: string | null;
  size: number | null;
  content_id: string | null;
}

interface EmailLabel {
  id: string;
  mailbox_id: string | null;
  name: string;
  color: string;
}

interface Draft {
  id: string;
  mailbox_id: string;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  subject: string;
  body_text: string;
  body_html: string | null;
  attachments: unknown;
  in_reply_to_message_id: string | null;
  updated_at: string;
}

interface ComposeAttachment {
  filename: string;
  content_type?: string;
  size: number;
  content_base64: string;
}

interface ComposeState {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  html: string;
  inReplyToMessageId: string | null;
}

type ActiveFilter = 'all' | 'unread' | 'attachments' | 'starred';
type MailLayout = 'three-pane' | 'focused-list' | 'bottom-pane';
type ContextActionId =
  | 'open'
  | 'reply'
  | 'reply_all'
  | 'forward'
  | 'read'
  | 'unread'
  | 'trash'
  | 'star'
  | 'rule'
  | 'copy_link'
  | 'print';

interface MailTab {
  id: string;
  type: 'folder' | 'message';
  title: string;
  messageId?: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  messageId: string;
}

interface ContextActionItem {
  id: ContextActionId;
  label: string;
  icon: LucideIcon;
}

interface RuleDraft {
  name: string;
  field: string;
  operator: string;
  value: string;
  targetFolderId: string;
}

const emptyCompose: ComposeState = {
  to: '',
  cc: '',
  bcc: '',
  subject: '',
  text: '',
  html: '',
  inReplyToMessageId: null,
};

const emptyRuleDraft: RuleDraft = {
  name: '',
  field: 'from',
  operator: 'contains',
  value: '',
  targetFolderId: '',
};

const CONTEXT_MENU_WIDTH = 240;
const CONTEXT_MENU_HEIGHT = 360;
const VIEWPORT_GAP = 8;

function initialSearchParam(name: string) {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(name);
}

function splitRecipients(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatBytes(value: number | null) {
  if (!value) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function emailHtml(html: string, allowExternalContent: boolean) {
  if (allowExternalContent) return html;
  return html
    .replace(/\s(src|srcset)=["']https?:\/\/[^"']+["']/gi, ' data-external-content-blocked="true"')
    .replace(/\sbackground=["']https?:\/\/[^"']+["']/gi, ' data-external-background-blocked="true"');
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function contextActions(isRead: boolean): ContextActionItem[] {
  return [
    { id: 'open', label: 'Abrir en pestana', icon: MailOpen },
    { id: 'reply', label: 'Responder', icon: Reply },
    { id: 'reply_all', label: 'Responder a todos', icon: Reply },
    { id: 'forward', label: 'Reenviar', icon: Send },
    { id: isRead ? 'unread' : 'read', label: isRead ? 'Marcar como no leido' : 'Marcar como leido', icon: Mail },
    { id: 'star', label: 'Alternar favorito', icon: Star },
    { id: 'rule', label: 'Crear regla desde este correo', icon: Wand2 },
    { id: 'copy_link', label: 'Copiar enlace', icon: LinkIcon },
    { id: 'print', label: 'Imprimir', icon: Printer },
    { id: 'trash', label: 'Mover a papelera', icon: Trash2 },
  ];
}

function MessageContextMenu({
  x,
  y,
  isRead,
  onAction,
}: {
  x: number;
  y: number;
  isRead: boolean;
  onAction: (action: ContextActionId) => void;
}) {
  return (
    <div
      className="fixed z-50 w-60 rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
      style={{ left: x, top: y }}
      onClick={(event) => event.stopPropagation()}
    >
      {contextActions(isRead).map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onAction(item.id)}
            className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-muted"
          >
            <Icon className="size-4" />
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function fileToComposeAttachment(file: File): Promise<ComposeAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer el adjunto.'));
    reader.onload = () => {
      const raw = typeof reader.result === 'string' ? reader.result : '';
      const contentBase64 = raw.includes(',') ? raw.split(',')[1] : raw;
      resolve({
        filename: file.name,
        content_type: file.type || undefined,
        size: file.size,
        content_base64: contentBase64,
      });
    };
    reader.readAsDataURL(file);
  });
}

function RichTextEditor({
  initialHtml,
  onChange,
}: {
  initialHtml: string;
  onChange: (html: string, text: string) => void;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({
        openOnClick: false,
      }),
      Placeholder.configure({
        placeholder: 'Escribe el mensaje',
      }),
    ],
    content: initialHtml,
    immediatelyRender: false,
    onUpdate: ({ editor: activeEditor }) => {
      onChange(activeEditor.getHTML(), activeEditor.getText());
    },
    editorProps: {
      attributes: {
        class:
          'min-h-56 px-3 py-3 text-sm leading-6 outline-none prose prose-sm max-w-none dark:prose-invert',
      },
    },
  });

  return (
    <div className="min-h-64 flex-1">
      <div className="flex min-h-9 items-center gap-1 border-b border-border px-2">
        <Button
          type="button"
          size="icon-xs"
          variant={editor?.isActive('bold') ? 'secondary' : 'ghost'}
          onClick={() => editor?.chain().focus().toggleBold().run()}
          title="Negrita"
        >
          <Bold className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant={editor?.isActive('italic') ? 'secondary' : 'ghost'}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          title="Cursiva"
        >
          <Italic className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant={editor?.isActive('underline') ? 'secondary' : 'ghost'}
          onClick={() => editor?.chain().focus().toggleUnderline().run()}
          title="Subrayado"
        >
          <UnderlineIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={() => {
            const href = window.prompt('URL del enlace');
            if (href) editor?.chain().focus().setLink({ href }).run();
          }}
          title="Enlace"
        >
          <LinkIcon className="size-3.5" />
        </Button>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}

export function EmailClient() {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedMailboxId, setSelectedMailboxId] = useState<string | null>(() => initialSearchParam('mailbox_id'));
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(() => initialSearchParam('folder_id'));
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(() => initialSearchParam('message_id'));
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [sending, setSending] = useState(false);
  const [rules, setRules] = useState<Rule[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [compose, setCompose] = useState<ComposeState>(emptyCompose);
  const [composeAttachments, setComposeAttachments] = useState<ComposeAttachment[]>([]);
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [labels, setLabels] = useState<EmailLabel[]>([]);
  const [selectedLabelId, setSelectedLabelId] = useState('');
  const [moveFolderId, setMoveFolderId] = useState('');
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('all');
  const [layout, setLayout] = useState<MailLayout>('three-pane');
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [ruleBuilderOpen, setRuleBuilderOpen] = useState(false);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(emptyRuleDraft);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advanced, setAdvanced] = useState({ from: '', to: '', sort: 'newest' });
  const [searchScope, setSearchScope] = useState<'folder' | 'mailbox'>('folder');
  const [editorKey, setEditorKey] = useState(0);
  const [allowExternalContent, setAllowExternalContent] = useState(false);
  const [tabs, setTabs] = useState<MailTab[]>([]);
  const [activeTabId, setActiveTabId] = useState('folder');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const selectedMailbox = useMemo(
    () => mailboxes.find((mailbox) => mailbox.id === selectedMailboxId) ?? mailboxes[0] ?? null,
    [mailboxes, selectedMailboxId],
  );

  const visibleFolders = useMemo(
    () =>
      folders
        .filter((folder) => folder.mailbox_id === selectedMailbox?.id)
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    [folders, selectedMailbox?.id],
  );

  const selectedMessage = useMemo(
    () => messages.find((message) => message.id === selectedMessageId) ?? messages[0] ?? null,
    [messages, selectedMessageId],
  );

  const selectedFolder = visibleFolders.find((folder) => folder.id === selectedFolderId) ?? null;
  const unreadCount = messages.filter((message) => !message.is_read).length;
  const attachmentCount = messages.filter((message) => message.has_attachments).length;
  const filteredMessages = useMemo(() => {
    if (activeFilter === 'unread') return messages.filter((message) => !message.is_read);
    if (activeFilter === 'attachments') return messages.filter((message) => message.has_attachments);
    if (activeFilter === 'starred') return messages.filter((message) => message.is_starred);
    return messages;
  }, [activeFilter, messages]);

  const params = useMemo(() => {
    const next = new URLSearchParams();
    if (selectedMailboxId) next.set('mailbox_id', selectedMailboxId);
    if (selectedFolderId && searchScope === 'folder') next.set('folder_id', selectedFolderId);
    if (query.trim()) next.set('q', query.trim());
    if (advanced.from.trim()) next.set('from', advanced.from.trim());
    if (advanced.to.trim()) next.set('to', advanced.to.trim());
    if (advanced.sort !== 'newest') next.set('sort', advanced.sort);
    if (selectedLabelId) next.set('label_id', selectedLabelId);
    if (activeFilter === 'unread') next.set('unread', 'true');
    if (activeFilter === 'attachments') next.set('attachments', 'true');
    if (activeFilter === 'starred') next.set('starred', 'true');
    return next.toString();
  }, [activeFilter, advanced.from, advanced.sort, advanced.to, query, searchScope, selectedFolderId, selectedLabelId, selectedMailboxId]);

  const trashFolderId = visibleFolders.find((folder) => folder.kind === 'trash')?.id ?? '';
  const isMessageTabActive = activeTabId !== 'folder';
  const selectedLabel = labels.find((label) => label.id === selectedLabelId) ?? null;
  const activeSearchChips = [
    query.trim() ? { id: 'query', label: `Texto: ${query.trim()}` } : null,
    advanced.from.trim() ? { id: 'from', label: `De: ${advanced.from.trim()}` } : null,
    advanced.to.trim() ? { id: 'to', label: `Para: ${advanced.to.trim()}` } : null,
    activeFilter !== 'all' ? { id: 'filter', label: activeFilter === 'unread' ? 'No leidos' : activeFilter === 'attachments' ? 'Con adjuntos' : 'Favoritos' } : null,
    selectedLabel ? { id: 'label', label: `Etiqueta: ${selectedLabel.name}` } : null,
    searchScope === 'mailbox' ? { id: 'scope', label: 'Todo el buzon' } : null,
  ].filter(Boolean) as Array<{ id: string; label: string }>;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/email/messages?${params}`, { cache: 'no-store' });
      const payload = (await res.json().catch(() => ({}))) as Partial<MessagesResponse> & { error?: string };
      if (!res.ok) throw new Error(payload.error || 'No se pudo cargar el correo');

      const nextMailboxes = payload.mailboxes ?? [];
      const nextFolders = payload.folders ?? [];
      const nextMessages = payload.messages ?? [];
      const nextMailboxId =
        selectedMailboxId && nextMailboxes.some((mailbox) => mailbox.id === selectedMailboxId)
          ? selectedMailboxId
          : nextMailboxes[0]?.id ?? null;
      const nextFolderId =
        selectedFolderId && nextFolders.some((folder) => folder.id === selectedFolderId)
          ? selectedFolderId
          : nextFolders.find((folder) => folder.mailbox_id === nextMailboxId && folder.kind === 'inbox')?.id ??
            nextFolders.find((folder) => folder.mailbox_id === nextMailboxId)?.id ??
            null;

      setMailboxes(nextMailboxes);
      setFolders(nextFolders);
      setMessages(nextMessages);
      setSelectedMessageIds(new Set());
      setSelectedMailboxId(nextMailboxId);
      setSelectedFolderId(nextFolderId);
      setSelectedMessageId((current) =>
        current && nextMessages.some((message) => message.id === current)
          ? current
          : nextMessages[0]?.id ?? null,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo cargar el correo');
    } finally {
      setLoading(false);
    }
  }, [params, selectedFolderId, selectedMailboxId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const next = new URLSearchParams(window.location.search);
    if (selectedMailboxId) next.set('mailbox_id', selectedMailboxId);
    else next.delete('mailbox_id');
    if (selectedFolderId) next.set('folder_id', selectedFolderId);
    else next.delete('folder_id');
    if (selectedMessageId) next.set('message_id', selectedMessageId);
    else next.delete('message_id');
    const queryString = next.toString();
    window.history.replaceState(null, '', queryString ? `/email?${queryString}` : '/email');
  }, [selectedFolderId, selectedMailboxId, selectedMessageId]);

  useEffect(() => {
    function closeMenus() {
      setContextMenu(null);
    }
    window.addEventListener('click', closeMenus);
    window.addEventListener('scroll', closeMenus, true);
    return () => {
      window.removeEventListener('click', closeMenus);
      window.removeEventListener('scroll', closeMenus, true);
    };
  }, []);

  useEffect(() => {
    if (!selectedMailboxId) {
      setRules([]);
      setSelectedRuleId('');
      setLabels([]);
      setDrafts([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const [rulesRes, labelsRes, draftsRes] = await Promise.all([
        fetch(`/api/email/rules?mailbox_id=${encodeURIComponent(selectedMailboxId)}`, {
          cache: 'no-store',
        }),
        fetch(`/api/email/labels?mailbox_id=${encodeURIComponent(selectedMailboxId)}`, {
          cache: 'no-store',
        }),
        fetch(`/api/email/drafts?mailbox_id=${encodeURIComponent(selectedMailboxId)}`, {
          cache: 'no-store',
        }),
      ]);
      const [rulesPayload, labelsPayload, draftsPayload] = await Promise.all([
        rulesRes.json().catch(() => ({})),
        labelsRes.json().catch(() => ({})),
        draftsRes.json().catch(() => ({})),
      ]);
      if (!cancelled) {
        const nextRules = rulesRes.ok ? ((rulesPayload.rules ?? []) as Rule[]) : [];
        setRules(nextRules);
        setSelectedRuleId((current) =>
          current && nextRules.some((rule) => rule.id === current)
            ? current
            : nextRules[0]?.id ?? '',
        );
        setLabels(labelsRes.ok ? (labelsPayload.labels ?? []) : []);
        setDrafts(draftsRes.ok ? (draftsPayload.drafts ?? []) : []);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedMailboxId]);

  useEffect(() => {
    if (!selectedMessage?.has_attachments) {
      setAttachments([]);
      return;
    }
    let cancelled = false;
    setAttachmentsLoading(true);
    void (async () => {
      const res = await fetch(`/api/email/messages/${selectedMessage.id}/attachments`, { cache: 'no-store' });
      const payload = await res.json().catch(() => ({}));
      if (!cancelled) {
        if (res.ok) setAttachments(payload.attachments ?? []);
        else toast.error(payload.error || 'No se pudieron cargar los adjuntos');
        setAttachmentsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedMessage?.id, selectedMessage?.has_attachments]);

  useEffect(() => {
    setAllowExternalContent(false);
    setDetailsOpen(false);
  }, [selectedMessage?.id]);

  useEffect(() => {
    setMoveFolderId(
      visibleFolders.find((folder) => folder.id !== selectedMessage?.folder_id)?.id ?? '',
    );
    setRuleDraft((current) => ({
      ...current,
      targetFolderId:
        current.targetFolderId && visibleFolders.some((folder) => folder.id === current.targetFolderId)
          ? current.targetFolderId
          : visibleFolders.find((folder) => folder.id !== selectedMessage?.folder_id)?.id ?? visibleFolders[0]?.id ?? '',
    }));
  }, [selectedMessage?.folder_id, visibleFolders]);

  async function patchMessageById(messageId: string, body: Record<string, unknown>, reload = true) {
    const res = await fetch('/api/email/messages', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_id: messageId, ...body }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload.error || 'No se pudo actualizar');
      return false;
    }
    if (reload) await load();
    return true;
  }

  async function patchMessage(body: Record<string, unknown>) {
    if (!selectedMessage) return;
    await patchMessageById(selectedMessage.id, body);
  }

  async function selectMessage(message: Message) {
    setSelectedMessageId(message.id);
    setActiveTabId((current) => current || 'folder');
    if (!message.is_read) {
      setMessages((current) =>
        current.map((item) => (item.id === message.id ? { ...item, is_read: true } : item)),
      );
      await patchMessageById(message.id, { is_read: true }, false);
    }
  }

  async function openMessageTab(message: Message) {
    await selectMessage(message);
    setTabs((current) =>
      current.some((tab) => tab.id === message.id)
        ? current
        : [
            ...current,
            {
              id: message.id,
              type: 'message' as const,
              title: message.subject || '(Sin asunto)',
              messageId: message.id,
            },
          ].slice(-8),
    );
    setActiveTabId(message.id);
  }

  function closeTab(tabId: string) {
    setTabs((current) => current.filter((tab) => tab.id !== tabId));
    if (activeTabId === tabId) {
      setActiveTabId('folder');
    }
  }

  async function bulkPatchMessages(body: Record<string, unknown>) {
    const ids = Array.from(selectedMessageIds);
    if (ids.length === 0) return;
    const res = await fetch('/api/email/messages/batch', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_ids: ids, ...body }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload.error || 'No se pudieron actualizar los correos');
      return;
    }
    toast.success(`${payload.messages?.length ?? ids.length} correos actualizados`);
    await load();
  }

  function toggleMessageSelection(messageId: string) {
    setSelectedMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }

  function toggleVisibleSelection() {
    setSelectedMessageIds((current) => {
      const visibleIds = filteredMessages.map((message) => message.id);
      const allSelected = visibleIds.length > 0 && visibleIds.every((id) => current.has(id));
      if (allSelected) return new Set([...current].filter((id) => !visibleIds.includes(id)));
      return new Set([...current, ...visibleIds]);
    });
  }

  function setTableSort(nextSort: 'received' | 'sender' | 'size') {
    setAdvanced((current) => ({
      ...current,
      sort:
        nextSort === 'received'
          ? current.sort === 'newest' ? 'oldest' : 'newest'
          : nextSort === 'size'
            ? current.sort === 'size_desc' ? 'size_asc' : 'size_desc'
            : 'sender',
    }));
  }

  function selectRelativeMessage(direction: 1 | -1) {
    if (filteredMessages.length === 0) return;
    const currentIndex = filteredMessages.findIndex((message) => message.id === selectedMessage?.id);
    const nextIndex =
      currentIndex === -1
        ? direction > 0 ? 0 : filteredMessages.length - 1
        : Math.min(Math.max(currentIndex + direction, 0), filteredMessages.length - 1);
    const nextMessage = filteredMessages[nextIndex];
    if (nextMessage) void selectMessage(nextMessage);
  }

  function clearSearchChip(chipId: string) {
    if (chipId === 'query') setQuery('');
    if (chipId === 'from') setAdvanced((current) => ({ ...current, from: '' }));
    if (chipId === 'to') setAdvanced((current) => ({ ...current, to: '' }));
    if (chipId === 'filter') setActiveFilter('all');
    if (chipId === 'label') setSelectedLabelId('');
    if (chipId === 'scope') setSearchScope('folder');
  }

  function openMessageContextMenu(event: MouseEvent, message: Message) {
    event.preventDefault();
    setSelectedMessageId(message.id);
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - CONTEXT_MENU_WIDTH - VIEWPORT_GAP),
      y: Math.min(event.clientY, window.innerHeight - CONTEXT_MENU_HEIGHT - VIEWPORT_GAP),
      messageId: message.id,
    });
  }

  function openSelectedMessageMenu(event: MouseEvent<HTMLButtonElement>) {
    if (!selectedMessage) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setContextMenu({
      x: Math.max(VIEWPORT_GAP, rect.right - CONTEXT_MENU_WIDTH),
      y: Math.min(rect.bottom + 6, window.innerHeight - CONTEXT_MENU_HEIGHT - VIEWPORT_GAP),
      messageId: selectedMessage.id,
    });
  }

  async function copyMessageLink(message: Message) {
    const next = new URL(window.location.href);
    next.pathname = '/email';
    next.searchParams.set('mailbox_id', message.mailbox_id);
    next.searchParams.set('folder_id', message.folder_id);
    next.searchParams.set('message_id', message.id);
    await navigator.clipboard.writeText(next.toString());
    toast.success('Enlace del correo copiado');
  }

  function printMessage(message: Message) {
    const printWindow = window.open('', '_blank', 'noopener,noreferrer,width=960,height=720');
    if (!printWindow) {
      toast.error('El navegador ha bloqueado la ventana de impresion');
      return;
    }
    const safeBody = message.body_html
      ? emailHtml(message.body_html, allowExternalContent)
      : `<pre>${escapeHtml(message.body_text || message.snippet || '')}</pre>`;
    printWindow.document.write(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>${escapeHtml(message.subject || 'Correo')}</title>
          <style>
            body { font-family: Arial, sans-serif; color: #111827; margin: 24px; }
            h1 { font-size: 20px; margin: 0 0 8px; }
            .meta { color: #4b5563; font-size: 13px; margin-bottom: 18px; }
            pre { white-space: pre-wrap; font-family: Arial, sans-serif; line-height: 1.5; }
          </style>
        </head>
        <body>
          <h1>${escapeHtml(message.subject || '(Sin asunto)')}</h1>
          <div class="meta">
            De: ${escapeHtml(message.from_name ? `${message.from_name} <${message.from_address}>` : message.from_address)}<br />
            Para: ${escapeHtml(message.to_addresses.join(', '))}<br />
            Fecha: ${escapeHtml(new Date(message.received_at).toLocaleString('es-ES'))}
          </div>
          ${safeBody}
          <script>window.addEventListener('load', () => window.print());</script>
        </body>
      </html>
    `);
    printWindow.document.close();
  }

  async function runContextAction(action: ContextActionId) {
    const message = messages.find((item) => item.id === contextMenu?.messageId);
    setContextMenu(null);
    if (!message) return;
    if (action === 'open') await openMessageTab(message);
    if (action === 'reply') {
      await selectMessage(message);
      openReply(message);
    }
    if (action === 'reply_all') {
      await selectMessage(message);
      openReplyAll(message);
    }
    if (action === 'forward') {
      await selectMessage(message);
      openForward(message);
    }
    if (action === 'read') await patchMessageById(message.id, { is_read: true });
    if (action === 'unread') await patchMessageById(message.id, { is_read: false });
    if (action === 'star') await patchMessageById(message.id, { is_starred: !message.is_starred });
    if (action === 'copy_link') await copyMessageLink(message);
    if (action === 'print') printMessage(message);
    if (action === 'trash' && trashFolderId) await patchMessageById(message.id, { folder_id: trashFolderId });
    if (action === 'rule') {
      await selectMessage(message);
      setRuleBuilderOpen(true);
      setRuleDraft((current) => ({
        ...current,
        name: `Mover ${message.from_name || message.from_address}`,
        field: 'from',
        operator: 'contains',
        value: message.from_address,
      }));
    }
  }

  async function sync() {
    setSyncing(true);
    try {
      const res = await fetch('/api/email/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_messages: 50 }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'No se pudo sincronizar');
      toast.success(`Sincronizacion completada: ${payload.imported ?? 0} nuevos`);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo sincronizar');
    } finally {
      setSyncing(false);
    }
  }

  async function createPublicFolder() {
    if (!selectedMailbox) return;
    const name = window.prompt('Nombre de la nueva carpeta publica');
    if (!name?.trim()) return;
    const res = await fetch('/api/email/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mailbox_id: selectedMailbox.id, name }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload.error || 'No se pudo crear la carpeta');
      return;
    }
    toast.success('Carpeta publica creada');
    await load();
  }

  async function applyRule() {
    if (!selectedMessage || !selectedRuleId) return;
    const res = await fetch('/api/email/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'apply',
        message_id: selectedMessage.id,
        rule_id: selectedRuleId,
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload.error || 'No se pudo aplicar la regla');
      return;
    }
    toast.success('Regla aplicada');
    await load();
  }

  async function createRuleFromBuilder() {
    if (!selectedMailbox || !ruleDraft.value.trim() || !ruleDraft.targetFolderId) return;
    const res = await fetch('/api/email/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mailbox_id: selectedMailbox.id,
        target_folder_id: ruleDraft.targetFolderId,
        name: ruleDraft.name.trim() || `Regla ${ruleDraft.value.trim()}`,
        field: ruleDraft.field,
        operator: ruleDraft.operator,
        value: ruleDraft.value.trim(),
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload.error || 'No se pudo crear la regla');
      return;
    }
    const nextRule = payload.rule as Rule;
    setRules((current) => [...current, nextRule]);
    setSelectedRuleId(nextRule.id);
    setRuleDraft(emptyRuleDraft);
    setRuleBuilderOpen(false);
    toast.success('Regla creada');
  }

  async function createLabel() {
    if (!selectedMailbox) return;
    const name = window.prompt('Nombre de la etiqueta');
    if (!name?.trim()) return;
    const colors = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];
    const color = colors[labels.length % colors.length];
    const res = await fetch('/api/email/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mailbox_id: selectedMailbox.id, name, color }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload.error || 'No se pudo crear la etiqueta');
      return;
    }
    setLabels((current) => [...current, payload.label]);
    toast.success('Etiqueta creada');
  }

  async function setMessageLabels(labelIds: string[]) {
    if (!selectedMessage) return;
    const res = await fetch('/api/email/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'set_message_labels',
        message_id: selectedMessage.id,
        label_ids: labelIds,
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload.error || 'No se pudieron asignar etiquetas');
      return;
    }
    setMessages((current) =>
      current.map((message) =>
        message.id === selectedMessage.id ? { ...message, labels: payload.labels ?? [] } : message,
      ),
    );
  }

  async function toggleLabel(labelId: string) {
    const currentLabels = selectedMessage?.labels?.map((label) => label.id) ?? [];
    const nextLabels = currentLabels.includes(labelId)
      ? currentLabels.filter((id) => id !== labelId)
      : [...currentLabels, labelId];
    await setMessageLabels(nextLabels);
  }

  function openDraft(draft: Draft) {
    setCurrentDraftId(draft.id);
    setCompose({
      to: draft.to_addresses.join(', '),
      cc: draft.cc_addresses.join(', '),
      bcc: draft.bcc_addresses.join(', '),
      subject: draft.subject,
      text: draft.body_text,
      html: draft.body_html ?? draft.body_text,
      inReplyToMessageId: draft.in_reply_to_message_id,
    });
    setComposeAttachments([]);
    setEditorKey((current) => current + 1);
    setComposeOpen(true);
  }

  function openNewMessage() {
    setCurrentDraftId(null);
    setCompose(emptyCompose);
    setComposeAttachments([]);
    setEditorKey((current) => current + 1);
    setComposeOpen(true);
  }

  function openReply(source?: Message) {
    const message = source ?? selectedMessage;
    if (!message) return;
    setCurrentDraftId(null);
    setCompose({
      to: message.from_address,
      cc: '',
      bcc: '',
      subject: message.subject.toLowerCase().startsWith('re:')
        ? message.subject
        : `Re: ${message.subject}`,
      text: '',
      html: '',
      inReplyToMessageId: message.id,
    });
    setComposeAttachments([]);
    setEditorKey((current) => current + 1);
    setComposeOpen(true);
  }

  function openReplyAll(source?: Message) {
    const message = source ?? selectedMessage;
    if (!message || !selectedMailbox) return;
    const recipients = [message.from_address, ...(message.to_addresses ?? [])]
      .filter((address) => address && address !== selectedMailbox.address);
    setCurrentDraftId(null);
    setCompose({
      to: [...new Set(recipients)].join(', '),
      cc: (message.cc_addresses ?? []).join(', '),
      bcc: '',
      subject: message.subject.toLowerCase().startsWith('re:')
        ? message.subject
        : `Re: ${message.subject}`,
      text: '',
      html: '',
      inReplyToMessageId: message.id,
    });
    setComposeAttachments([]);
    setEditorKey((current) => current + 1);
    setComposeOpen(true);
  }

  function openForward(source?: Message) {
    const message = source ?? selectedMessage;
    if (!message) return;
    setCurrentDraftId(null);
    setCompose({
      to: '',
      cc: '',
      bcc: '',
      subject: message.subject.toLowerCase().startsWith('fw:')
        ? message.subject
        : `Fw: ${message.subject}`,
      text: `\n\n---------- Mensaje reenviado ----------\nDe: ${message.from_address}\nFecha: ${new Date(message.received_at).toLocaleString('es-ES')}\nAsunto: ${message.subject}\n\n${message.body_text ?? message.snippet ?? ''}`,
      html: '',
      inReplyToMessageId: null,
    });
    setComposeAttachments([]);
    setEditorKey((current) => current + 1);
    setComposeOpen(true);
  }

  const saveDraft = useCallback(async (silent = false) => {
    if (!selectedMailbox || !composeOpen) return;
    const hasContent =
      compose.to.trim() ||
      compose.cc.trim() ||
      compose.bcc.trim() ||
      compose.subject.trim() ||
      compose.text.trim() ||
      composeAttachments.length > 0;
    if (!hasContent) return;

    const res = await fetch('/api/email/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        draft_id: currentDraftId,
        mailbox_id: selectedMailbox.id,
        to: splitRecipients(compose.to),
        cc: splitRecipients(compose.cc),
        bcc: splitRecipients(compose.bcc),
        subject: compose.subject,
        text: compose.text,
        html: compose.html,
        attachments: composeAttachments.map(({ filename, content_type, size }) => ({
          filename,
          content_type,
          size,
        })),
        in_reply_to_message_id: compose.inReplyToMessageId,
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (!silent) toast.error(payload.error || 'No se pudo guardar el borrador');
      return;
    }
    const savedDraft = payload.draft as Draft | undefined;
    setCurrentDraftId(savedDraft?.id ?? null);
    if (savedDraft) {
      setDrafts((current) => {
        const others = current.filter((draft) => draft.id !== savedDraft.id);
        return [savedDraft, ...others].slice(0, 20);
      });
    }
    if (!silent) toast.success('Borrador guardado');
  }, [compose, composeAttachments, composeOpen, currentDraftId, selectedMailbox]);

  async function downloadAttachment(attachment: Attachment) {
    const res = await fetch(`/api/email/attachments/${attachment.id}`, { cache: 'no-store' });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.url) {
      toast.error(payload.error || 'No se pudo descargar el adjunto');
      return;
    }
    window.open(payload.url, '_blank', 'noopener,noreferrer');
  }

  async function addComposeFiles(files: FileList | null) {
    if (!files?.length) return;
    const next = await Promise.all(Array.from(files).slice(0, 10).map(fileToComposeAttachment));
    const totalBytes = [...composeAttachments, ...next].reduce((total, item) => total + item.size, 0);
    if (totalBytes > 8 * 1024 * 1024) {
      toast.error('Los adjuntos superan el limite de 8 MB.');
      return;
    }
    setComposeAttachments((current) => [...current, ...next].slice(0, 10));
  }

  async function sendCurrentMessage() {
    if (!selectedMailbox || !compose.to.trim()) return;
    setSending(true);
    try {
      const res = await fetch('/api/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mailbox_id: selectedMailbox.id,
          to: splitRecipients(compose.to),
          cc: splitRecipients(compose.cc),
          bcc: splitRecipients(compose.bcc),
          subject: compose.subject,
          text: compose.text,
          html: compose.html,
          in_reply_to_message_id: compose.inReplyToMessageId,
          attachments: composeAttachments,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'No se pudo enviar');
      toast.success(compose.inReplyToMessageId ? 'Respuesta enviada' : 'Correo enviado');
      if (currentDraftId) {
        await fetch(`/api/email/drafts?draft_id=${encodeURIComponent(currentDraftId)}`, {
          method: 'DELETE',
        }).catch(() => undefined);
        setDrafts((current) => current.filter((draft) => draft.id !== currentDraftId));
      }
      setComposeOpen(false);
      setCurrentDraftId(null);
      setCompose(emptyCompose);
      setComposeAttachments([]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo enviar');
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    if (!composeOpen) return;
    const timeout = window.setTimeout(() => {
      void saveDraft(true);
    }, 1800);
    return () => window.clearTimeout(timeout);
  }, [compose, composeAttachments, composeOpen, currentDraftId, saveDraft, selectedMailbox?.id]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;
      if (isTyping) return;
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        openNewMessage();
      }
      if (event.key.toLowerCase() === 'r' && selectedMessage) {
        event.preventDefault();
        openReply();
      }
      if (event.key.toLowerCase() === 'u' && selectedMessage) {
        event.preventDefault();
        void patchMessage({ is_read: !selectedMessage.is_read });
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        selectRelativeMessage(1);
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        selectRelativeMessage(-1);
      }
      if (event.key === 'Enter' && selectedMessage) {
        event.preventDefault();
        void openMessageTab(selectedMessage);
      }
      if (event.key === 'Delete' && selectedMessage && trashFolderId) {
        event.preventDefault();
        void patchMessage({ folder_id: trashFolderId });
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p' && selectedMessage) {
        event.preventDefault();
        printMessage(selectedMessage);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  return (
    <div className="flex min-h-[calc(100vh-7rem)] flex-col rounded-lg border border-border bg-background">
      <div className="flex min-h-14 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Button size="icon-sm" variant="ghost" onClick={toggleVisibleSelection} disabled={filteredMessages.length === 0} title="Seleccionar correos">
          {filteredMessages.length > 0 && filteredMessages.every((message) => selectedMessageIds.has(message.id)) ? (
            <CheckSquare className="size-4" />
          ) : (
            <Square className="size-4" />
          )}
        </Button>
        <Button onClick={openNewMessage} disabled={!selectedMailbox?.can_send}>
          <PencilLine className="size-4" />
          Nuevo correo
        </Button>
        <Button size="sm" variant="outline" onClick={sync} disabled={syncing}>
          {syncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          Sincronizar
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => patchMessage({ is_read: !selectedMessage?.is_read })}
          disabled={!selectedMessage}
        >
          {selectedMessage?.is_read ? <Mail className="size-4" /> : <MailOpen className="size-4" />}
          {selectedMessage?.is_read ? 'No leido' : 'Leido'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => patchMessage({ is_starred: !selectedMessage?.is_starred })}
          disabled={!selectedMessage}
        >
          <Star className={cn('size-4', selectedMessage?.is_starred && 'fill-amber-400 text-amber-500')} />
          Favorito
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => selectedMessage && void openMessageTab(selectedMessage)}
          disabled={!selectedMessage}
        >
          <MailOpen className="size-4" />
          Abrir pestana
        </Button>
        <Button size="sm" variant="outline" onClick={() => openReply()} disabled={!selectedMessage || !selectedMailbox?.can_send}>
          <Reply className="size-4" />
          Responder
        </Button>
        <Button size="sm" variant="outline" onClick={() => openForward()} disabled={!selectedMessage || !selectedMailbox?.can_send}>
          <Send className="size-4" />
          Reenviar
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => selectedMessage && trashFolderId && patchMessage({ folder_id: trashFolderId })}
          disabled={!selectedMessage || !trashFolderId}
        >
          <Trash2 className="size-4" />
          Papelera
        </Button>
        <Button size="sm" variant="outline" onClick={openSelectedMessageMenu} disabled={!selectedMessage}>
          <MoreHorizontal className="size-4" />
          Acciones
        </Button>
        {selectedMessageIds.size > 0 ? (
          <div className="flex items-center gap-2 border-l border-border pl-2">
            <span className="text-sm text-muted-foreground">{selectedMessageIds.size} seleccionados</span>
            <Button size="sm" variant="outline" onClick={() => bulkPatchMessages({ is_read: true })}>
              <MailOpen className="size-4" />
              Leidos
            </Button>
            <Button size="sm" variant="outline" onClick={() => bulkPatchMessages({ is_read: false })}>
              <Mail className="size-4" />
              No leidos
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => bulkPatchMessages({ folder_id: moveFolderId })}
              disabled={!moveFolderId}
            >
              <Archive className="size-4" />
              Mover lote
            </Button>
          </div>
        ) : null}
        <div className="flex min-w-[220px] items-center gap-2">
          <select
            value={moveFolderId}
            onChange={(event) => setMoveFolderId(event.target.value)}
            disabled={!selectedMessage}
            className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-card px-2 text-sm"
          >
            {visibleFolders
              .filter((folder) => folder.id !== selectedMessage?.folder_id)
              .map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            onClick={() => patchMessage({ folder_id: moveFolderId })}
            disabled={!selectedMessage || !moveFolderId}
          >
            <Archive className="size-4" />
            Mover
          </Button>
        </div>
        <div className="ml-auto flex min-w-[240px] items-center gap-2">
          <div className="grid grid-cols-3 rounded-lg bg-muted p-1">
            {[
              { id: 'three-pane' as const, label: '3' },
              { id: 'focused-list' as const, label: 'Lista' },
              { id: 'bottom-pane' as const, label: 'Abajo' },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setLayout(item.id)}
                className={cn(
                  'h-7 min-w-10 rounded-md px-2 text-xs font-medium',
                  layout === item.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRuleBuilderOpen((current) => !current)}
            disabled={!selectedMailbox}
          >
            <Tag className="size-4" />
            Nueva regla
          </Button>
          <select
            value={selectedRuleId}
            onChange={(event) => setSelectedRuleId(event.target.value)}
            disabled={!rules.length || !selectedMessage}
            className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-card px-2 text-sm"
          >
            {rules.length === 0 ? <option>Sin reglas</option> : null}
            {rules.map((rule) => (
              <option key={rule.id} value={rule.id}>
                {rule.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            onClick={applyRule}
            disabled={!selectedMessage || !selectedRuleId}
          >
            <Wand2 className="size-4" />
            Aplicar
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              window.location.href = '/settings?tab=email';
            }}
          >
            <Settings className="size-4" />
            Ajustes Email
          </Button>
        </div>
      </div>

      <div className="flex min-h-10 items-end gap-1 border-b border-border bg-card px-2">
        <button
          type="button"
          onClick={() => setActiveTabId('folder')}
          className={cn(
            'flex h-9 max-w-[240px] items-center gap-2 rounded-t-md border border-b-0 px-3 text-sm',
            activeTabId === 'folder' ? 'border-border bg-background text-primary' : 'border-transparent bg-muted/60 text-muted-foreground',
          )}
        >
          <Inbox className="size-4" />
          <span className="truncate">{selectedFolder?.name ?? 'Bandeja'}</span>
        </button>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              'flex h-9 max-w-[260px] items-center gap-2 rounded-t-md border border-b-0 px-3 text-sm',
              activeTabId === tab.id ? 'border-border bg-background text-primary' : 'border-transparent bg-muted/60 text-muted-foreground',
            )}
          >
            <Mail className="size-4 shrink-0" />
            <button
              type="button"
              onClick={() => {
                setActiveTabId(tab.id);
                if (tab.messageId) setSelectedMessageId(tab.messageId);
              }}
              className="min-w-0 flex-1 truncate text-left"
            >
              {tab.title}
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab.id);
              }}
              className="ml-1 rounded p-0.5 hover:bg-muted"
              title="Cerrar pestana"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>

      <div
        className={cn(
          'grid min-h-0 flex-1',
          layout === 'three-pane' && !isMessageTabActive && 'lg:grid-cols-[270px_minmax(320px,420px)_minmax(0,1fr)]',
          (layout !== 'three-pane' || isMessageTabActive) && 'lg:grid-cols-[270px_minmax(0,1fr)]',
        )}
      >
        <aside className="min-w-0 border-b border-border bg-card lg:border-b-0 lg:border-r">
          <div className="border-b border-border p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Mail className="size-4 text-primary" />
                Email
              </div>
              <Button size="icon-sm" variant="ghost" onClick={createPublicFolder} disabled={!selectedMailbox} title="Nueva carpeta publica">
                <FolderPlus className="size-4" />
              </Button>
            </div>
          </div>
          <div className="max-h-[calc(100vh-12rem)] space-y-4 overflow-y-auto p-3">
            <div>
              <p className="mb-2 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Buzones</p>
              {mailboxes.length === 0 ? (
                <div className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                  No tienes buzones asignados.
                </div>
              ) : (
                <div className="space-y-1">
                  {mailboxes.map((mailbox) => (
                    <button
                      key={mailbox.id}
                      type="button"
                      onClick={() => {
                        const inbox = folders.find((folder) => folder.mailbox_id === mailbox.id && folder.kind === 'inbox');
                        setSelectedMailboxId(mailbox.id);
                        setSelectedFolderId(inbox?.id ?? folders.find((folder) => folder.mailbox_id === mailbox.id)?.id ?? null);
                        setSelectedMessageId(null);
                        setActiveTabId('folder');
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors',
                        selectedMailbox?.id === mailbox.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
                      )}
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold">
                        {(mailbox.display_name || mailbox.address).slice(0, 2).toUpperCase()}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{mailbox.display_name || mailbox.address}</span>
                        <span className="block truncate text-xs text-muted-foreground">{mailbox.address}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between px-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Carpetas publicas</p>
                <Button size="icon-xs" variant="ghost" onClick={createPublicFolder} disabled={!selectedMailbox} title="Crear carpeta">
                  <FolderPlus className="size-3.5" />
                </Button>
              </div>
              <div className="space-y-1">
                {visibleFolders.map((folder) => {
                  const count = messages.filter((message) => message.folder_id === folder.id).length;
                  return (
                    <button
                      key={folder.id}
                      type="button"
                      onClick={() => {
                        setSelectedFolderId(folder.id);
                        setSelectedMessageId(null);
                        setActiveTabId('folder');
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                        selectedFolderId === folder.id
                          ? 'bg-muted text-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      {folder.kind === 'inbox' ? (
                        <Inbox className="size-4" />
                      ) : folder.kind === 'trash' ? (
                        <Trash2 className="size-4" />
                      ) : (
                        <Archive className="size-4" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                      {count > 0 ? <span className="text-xs text-muted-foreground">{count}</span> : null}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between px-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Etiquetas</p>
                <Button size="icon-xs" variant="ghost" onClick={createLabel} disabled={!selectedMailbox} title="Crear etiqueta">
                  <Tag className="size-3.5" />
                </Button>
              </div>
              <div className="space-y-1">
                <button
                  type="button"
                  onClick={() => setSelectedLabelId('')}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                    !selectedLabelId ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Tag className="size-4" />
                  Todas
                </button>
                {labels.map((label) => (
                  <button
                    key={label.id}
                    type="button"
                    onClick={() => setSelectedLabelId(label.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                      selectedLabelId === label.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <span className="size-2.5 rounded-full" style={{ backgroundColor: label.color }} />
                    <span className="truncate">{label.name}</span>
                  </button>
                ))}
              </div>
            </div>
            {drafts.length > 0 ? (
              <div>
                <p className="mb-2 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Borradores</p>
                <div className="space-y-1">
                  {drafts.slice(0, 6).map((draft) => (
                    <button
                      key={draft.id}
                      type="button"
                      onClick={() => openDraft(draft)}
                      className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <span className="block truncate">{draft.subject || '(Sin asunto)'}</span>
                      <span className="block truncate text-xs">{formatDate(draft.updated_at)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </aside>

        <section className={cn('min-w-0 border-b border-border bg-card lg:border-b-0 lg:border-r', isMessageTabActive && 'hidden')}>
          <div className="border-b border-border p-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar correo"
                className="pl-8"
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="xs" variant={advancedOpen ? 'secondary' : 'ghost'} onClick={() => setAdvancedOpen((current) => !current)}>
                <Search className="size-3.5" />
                Filtro avanzado
              </Button>
              {advancedOpen ? (
                <div className="grid w-full gap-2 rounded-md border border-border bg-background p-2 shadow-sm">
                  <div className="grid gap-2 sm:grid-cols-3">
                  <Input
                    value={advanced.from}
                    onChange={(event) => setAdvanced((current) => ({ ...current, from: event.target.value }))}
                    placeholder="De"
                    className="h-8"
                  />
                  <Input
                    value={advanced.to}
                    onChange={(event) => setAdvanced((current) => ({ ...current, to: event.target.value }))}
                    placeholder="Para"
                    className="h-8"
                  />
                  <select
                    value={advanced.sort}
                    onChange={(event) => setAdvanced((current) => ({ ...current, sort: event.target.value }))}
                    className="h-8 rounded-md border border-border bg-card px-2 text-xs"
                  >
                    <option value="newest">Recientes</option>
                    <option value="oldest">Antiguos</option>
                    <option value="sender">Remitente</option>
                    <option value="size_desc">Mas grandes</option>
                    <option value="size_asc">Mas pequenos</option>
                  </select>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-1">
                      {[
                        { id: 'folder' as const, label: 'Carpeta actual' },
                        { id: 'mailbox' as const, label: 'Todo el buzon' },
                      ].map((scope) => (
                        <button
                          key={scope.id}
                          type="button"
                          onClick={() => setSearchScope(scope.id)}
                          className={cn(
                            'h-7 rounded-md border px-2 text-xs transition-colors',
                            searchScope === scope.id
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                          )}
                        >
                          {scope.label}
                        </button>
                      ))}
                    </div>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        setQuery('');
                        setAdvanced({ from: '', to: '', sort: 'newest' });
                        setActiveFilter('all');
                        setSelectedLabelId('');
                      }}
                    >
                      Limpiar
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span className="truncate">{selectedFolder?.name ?? 'Carpeta'} · {messages.length} correos</span>
              <span>{unreadCount} no leidos</span>
            </div>
            <div className="mt-3 grid grid-cols-4 gap-1 rounded-lg bg-muted p-1">
              {[
                { id: 'all' as const, label: 'Todos', count: messages.length },
                { id: 'unread' as const, label: 'No leidos', count: unreadCount },
                { id: 'attachments' as const, label: 'Adjuntos', count: attachmentCount },
                { id: 'starred' as const, label: 'Fav', count: messages.filter((message) => message.is_starred).length },
              ].map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => setActiveFilter(filter.id)}
                  className={cn(
                    'h-7 rounded-md px-2 text-xs font-medium transition-colors',
                    activeFilter === filter.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {filter.label} {filter.count}
                </button>
              ))}
            </div>
            {activeSearchChips.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {activeSearchChips.map((chip) => (
                  <button
                    key={chip.id}
                    type="button"
                    onClick={() => clearSearchChip(chip.id)}
                    className="flex h-7 max-w-full items-center gap-1 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                    title="Quitar filtro"
                  >
                    <span className="truncate">{chip.label}</span>
                    <X className="size-3" />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="max-h-[calc(100vh-15rem)] overflow-auto">
            {loading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="size-5 animate-spin text-primary" />
              </div>
            ) : filteredMessages.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">No hay correos en esta vista.</div>
            ) : (
              <div className="min-w-[760px]">
                <div className="sticky top-0 z-10 grid grid-cols-[34px_46px_minmax(120px,0.9fr)_minmax(240px,1.8fr)_140px_96px_80px] items-center border-b border-border bg-card px-2 py-2 text-[11px] font-semibold uppercase text-muted-foreground">
                  <button
                    type="button"
                    onClick={toggleVisibleSelection}
                    className="flex size-7 items-center justify-center rounded hover:bg-muted hover:text-foreground"
                    title="Seleccionar todos los visibles"
                  >
                    {filteredMessages.length > 0 && filteredMessages.every((message) => selectedMessageIds.has(message.id)) ? (
                      <CheckSquare className="size-4" />
                    ) : (
                      <Square className="size-4" />
                    )}
                  </button>
                  <span>Estado</span>
                  <button type="button" onClick={() => setTableSort('sender')} className="truncate text-left hover:text-foreground">
                    De
                  </button>
                  <span>Asunto</span>
                  <span>Categorias</span>
                  <button type="button" onClick={() => setTableSort('received')} className="truncate text-left hover:text-foreground">
                    Recibido
                  </button>
                  <button type="button" onClick={() => setTableSort('size')} className="truncate text-left hover:text-foreground">
                    Tamano
                  </button>
                </div>
                {filteredMessages.map((message) => (
                  <div
                    key={message.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => void selectMessage(message)}
                    onDoubleClick={() => void openMessageTab(message)}
                    onContextMenu={(event) => openMessageContextMenu(event, message)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void selectMessage(message);
                    }}
                    className={cn(
                      'grid min-h-9 grid-cols-[34px_46px_minmax(120px,0.9fr)_minmax(240px,1.8fr)_140px_96px_80px] items-center border-b border-border px-2 text-sm transition-colors hover:bg-muted/60',
                      selectedMessage?.id === message.id && 'bg-primary/10',
                      !message.is_read && 'font-semibold',
                    )}
                    title="Doble clic para abrir en pestana. Clic derecho para acciones."
                  >
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleMessageSelection(message.id);
                      }}
                      className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                      title="Seleccionar"
                    >
                      {selectedMessageIds.has(message.id) ? <CheckSquare className="size-4" /> : <Square className="size-4" />}
                    </button>
                    <div className="flex items-center gap-1.5">
                      <span className={cn('size-2 rounded-full', message.is_read ? 'bg-transparent' : 'bg-primary')} />
                      {message.has_attachments ? <Paperclip className="size-3.5 shrink-0 text-muted-foreground" /> : <Mail className="size-3.5 shrink-0 text-muted-foreground" />}
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void patchMessageById(message.id, { is_starred: !message.is_starred });
                        }}
                        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-amber-500"
                        title={message.is_starred ? 'Quitar favorito' : 'Marcar favorito'}
                      >
                        <Star className={cn('size-3.5', message.is_starred && 'fill-amber-400 text-amber-500')} />
                      </button>
                    </div>
                    <span className="truncate pr-3">{message.from_name || message.from_address}</span>
                    <span className="min-w-0 pr-3">
                      <span className="block truncate">{message.subject || '(Sin asunto)'}</span>
                      {message.snippet ? (
                        <span className="block truncate text-xs font-normal text-muted-foreground">{message.snippet}</span>
                      ) : null}
                    </span>
                    <span className="flex min-w-0 gap-1 overflow-hidden pr-2">
                      {message.labels?.slice(0, 2).map((label) => (
                        <span
                          key={label.id}
                          className="max-w-28 truncate rounded px-1.5 py-0.5 text-[11px] font-medium text-white"
                          style={{ backgroundColor: label.color }}
                        >
                          {label.name}
                        </span>
                      ))}
                    </span>
                    <span className="truncate text-xs font-normal text-muted-foreground tabular-nums">{formatDate(message.received_at)}</span>
                    <span className="truncate text-xs font-normal text-muted-foreground tabular-nums">{formatBytes(message.raw_size)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {contextMenu ? (
            <MessageContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              isRead={messages.find((item) => item.id === contextMenu.messageId)?.is_read ?? true}
              onAction={(action) => void runContextAction(action)}
            />
          ) : null}
        </section>

        <main
          className={cn(
            'relative min-w-0 bg-card',
            layout === 'focused-list' && !isMessageTabActive && 'hidden',
            layout === 'bottom-pane' && !isMessageTabActive && 'lg:col-start-2 lg:row-start-2',
          )}
        >
          {selectedMessage ? (
            <div className="flex h-full min-h-[620px] flex-col">
              <div className="border-b border-border p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h1 className="truncate text-xl font-semibold">{selectedMessage.subject || '(Sin asunto)'}</h1>
                    <p className="mt-1 truncate text-sm text-muted-foreground">
                      {selectedMessage.from_name
                        ? `${selectedMessage.from_name} <${selectedMessage.from_address}>`
                        : selectedMessage.from_address}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      Para {selectedMessage.to_addresses.join(', ') || selectedMailbox?.address} ·{' '}
                      {new Date(selectedMessage.received_at).toLocaleString('es-ES')}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => openReply()} disabled={!selectedMailbox?.can_send}>
                      <Reply className="size-4" />
                      Responder
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => openReplyAll()} disabled={!selectedMailbox?.can_send}>
                      <Reply className="size-4" />
                      Todos
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => openForward()} disabled={!selectedMailbox?.can_send}>
                      <Send className="size-4" />
                      Reenviar
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => copyMessageLink(selectedMessage)}>
                      <LinkIcon className="size-4" />
                      Enlace
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => printMessage(selectedMessage)}>
                      <Printer className="size-4" />
                      Imprimir
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setDetailsOpen((current) => !current)}>
                      <Info className="size-4" />
                      Detalles
                    </Button>
                    <Button variant="ghost" size="icon-sm" title="Mas acciones" onClick={openSelectedMessageMenu}>
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </div>
                </div>

                {detailsOpen ? (
                  <div className="mt-3 grid gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground sm:grid-cols-2">
                    <div className="min-w-0">
                      <span className="font-medium text-foreground">Buzon: </span>
                      <span className="break-all">{selectedMailbox?.display_name || selectedMailbox?.address}</span>
                    </div>
                    <div className="min-w-0">
                      <span className="font-medium text-foreground">Carpeta: </span>
                      <span>{selectedFolder?.name ?? 'Sin carpeta'}</span>
                    </div>
                    <div className="min-w-0">
                      <span className="font-medium text-foreground">De: </span>
                      <span className="break-all">{selectedMessage.from_address}</span>
                    </div>
                    <div className="min-w-0">
                      <span className="font-medium text-foreground">Para: </span>
                      <span className="break-all">{selectedMessage.to_addresses.join(', ') || '-'}</span>
                    </div>
                    <div className="min-w-0">
                      <span className="font-medium text-foreground">CC: </span>
                      <span className="break-all">{selectedMessage.cc_addresses?.join(', ') || '-'}</span>
                    </div>
                    <div className="min-w-0">
                      <span className="font-medium text-foreground">Tamano: </span>
                      <span className="tabular-nums">{formatBytes(selectedMessage.raw_size) || '-'}</span>
                    </div>
                  </div>
                ) : null}

                {labels.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {labels.map((label) => {
                      const active = selectedMessage.labels?.some((item) => item.id === label.id);
                      return (
                        <button
                          key={label.id}
                          type="button"
                          onClick={() => toggleLabel(label.id)}
                          className={cn(
                            'rounded-md border px-2 py-1 text-xs transition-colors',
                            active ? 'border-transparent text-white' : 'border-border text-muted-foreground hover:bg-muted',
                          )}
                          style={active ? { backgroundColor: label.color } : undefined}
                        >
                          {label.name}
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                {selectedMessage.body_html ? (
                  <div className="mt-3 flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    <span>Contenido externo bloqueado</span>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => setAllowExternalContent((current) => !current)}
                    >
                      {allowExternalContent ? 'Ocultar externo' : 'Mostrar externo'}
                    </Button>
                  </div>
                ) : null}

                {selectedMessage.has_attachments ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {attachmentsLoading ? (
                      <span className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        Cargando adjuntos
                      </span>
                    ) : (
                      attachments.map((attachment) => (
                        <button
                          key={attachment.id}
                          type="button"
                          onClick={() => downloadAttachment(attachment)}
                          className="flex max-w-[260px] items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-left text-sm hover:bg-muted"
                        >
                          <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{attachment.file_name}</span>
                            <span className="block text-xs text-muted-foreground">{formatBytes(attachment.size)}</span>
                          </span>
                          <Download className="size-4 shrink-0 text-muted-foreground" />
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </div>

              <article className="min-h-0 flex-1 overflow-y-auto p-4">
                {selectedMessage.body_html ? (
                  <iframe
                    title="Contenido del correo"
                    sandbox=""
                    srcDoc={emailHtml(selectedMessage.body_html, allowExternalContent)}
                    className="h-[560px] w-full rounded-md border border-border bg-background"
                  />
                ) : (
                  <pre className="whitespace-pre-wrap text-sm leading-6 text-foreground">
                    {selectedMessage.body_text || selectedMessage.snippet}
                  </pre>
                )}
              </article>
            </div>
          ) : (
            <div className="flex min-h-[620px] flex-col items-center justify-center gap-2 text-muted-foreground">
              <MailOpen className="size-9" />
              <p className="text-sm">Selecciona un correo para leerlo.</p>
            </div>
          )}

          {ruleBuilderOpen ? (
            <div className="absolute right-4 top-4 z-10 w-[min(460px,calc(100%-2rem))] rounded-lg border border-border bg-background shadow-xl">
              <div className="flex min-h-12 items-center justify-between border-b border-border px-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">Nueva regla</p>
                  <p className="truncate text-xs text-muted-foreground">{selectedMailbox?.address}</p>
                </div>
                <Button size="icon-sm" variant="ghost" onClick={() => setRuleBuilderOpen(false)} title="Cerrar">
                  <X className="size-4" />
                </Button>
              </div>
              <div className="grid gap-3 p-3">
                <Input
                  value={ruleDraft.name}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Nombre de la regla"
                />
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={ruleDraft.field}
                    onChange={(event) => setRuleDraft((current) => ({ ...current, field: event.target.value }))}
                    className="h-8 rounded-lg border border-border bg-card px-2 text-sm"
                  >
                    <option value="from">Remitente</option>
                    <option value="from_domain">Dominio</option>
                    <option value="subject">Asunto</option>
                    <option value="to">Destinatario</option>
                  </select>
                  <select
                    value={ruleDraft.operator}
                    onChange={(event) => setRuleDraft((current) => ({ ...current, operator: event.target.value }))}
                    className="h-8 rounded-lg border border-border bg-card px-2 text-sm"
                  >
                    <option value="contains">Contiene</option>
                    <option value="equals">Es igual</option>
                    <option value="starts_with">Empieza por</option>
                    <option value="ends_with">Termina por</option>
                  </select>
                </div>
                <Input
                  value={ruleDraft.value}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, value: event.target.value }))}
                  placeholder="Valor"
                />
                <select
                  value={ruleDraft.targetFolderId}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, targetFolderId: event.target.value }))}
                  className="h-8 rounded-lg border border-border bg-card px-2 text-sm"
                >
                  {visibleFolders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      Mover a {folder.name}
                    </option>
                  ))}
                </select>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => setRuleBuilderOpen(false)}>
                    Cancelar
                  </Button>
                  <Button size="sm" onClick={createRuleFromBuilder} disabled={!ruleDraft.value.trim() || !ruleDraft.targetFolderId}>
                    <Wand2 className="size-4" />
                    Crear regla
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {composeOpen ? (
            <div className="absolute bottom-4 right-4 z-10 flex max-h-[calc(100%-2rem)] w-[min(620px,calc(100%-2rem))] flex-col rounded-lg border border-border bg-background shadow-xl">
              <div className="flex min-h-12 items-center justify-between border-b border-border px-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">
                    {compose.inReplyToMessageId ? 'Responder' : 'Nuevo correo'}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">Desde {selectedMailbox?.address}</p>
                </div>
                <Button size="icon-sm" variant="ghost" onClick={() => setComposeOpen(false)} title="Cerrar">
                  <X className="size-4" />
                </Button>
              </div>
              <div className="space-y-2 border-b border-border p-3">
                <Input
                  value={compose.to}
                  onChange={(event) => setCompose((current) => ({ ...current, to: event.target.value }))}
                  placeholder="Para"
                />
                <Input
                  value={compose.cc}
                  onChange={(event) => setCompose((current) => ({ ...current, cc: event.target.value }))}
                  placeholder="Cc"
                />
                <Input
                  value={compose.bcc}
                  onChange={(event) => setCompose((current) => ({ ...current, bcc: event.target.value }))}
                  placeholder="Bcc"
                />
                <Input
                  value={compose.subject}
                  onChange={(event) => setCompose((current) => ({ ...current, subject: event.target.value }))}
                  placeholder="Asunto"
                />
              </div>
              <RichTextEditor
                key={editorKey}
                initialHtml={compose.html || compose.text}
                onChange={(html, text) => setCompose((current) => ({ ...current, html, text }))}
              />
              {composeAttachments.length > 0 ? (
                <div className="flex flex-wrap gap-2 border-t border-border p-3">
                  {composeAttachments.map((attachment, index) => (
                    <span
                      key={`${attachment.filename}-${index}`}
                      className="flex max-w-[240px] items-center gap-2 rounded-md border border-border px-2 py-1 text-sm"
                    >
                      <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
                      <button
                        type="button"
                        onClick={() => setComposeAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                        className="text-muted-foreground hover:text-foreground"
                        title="Quitar"
                      >
                        <X className="size-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="flex items-center justify-between border-t border-border p-3">
                <div className="flex items-center gap-2">
                  <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-sm font-medium hover:bg-muted">
                    <Paperclip className="size-4" />
                    Adjuntar
                    <input
                      type="file"
                      multiple
                      className="sr-only"
                      onChange={(event) => {
                        void addComposeFiles(event.target.files);
                        event.currentTarget.value = '';
                      }}
                    />
                  </label>
                  <Button size="sm" variant="outline" onClick={() => saveDraft(false)}>
                    Guardar
                  </Button>
                </div>
                <Button onClick={sendCurrentMessage} disabled={sending || !compose.to.trim() || !selectedMailbox?.can_send}>
                  {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                  Enviar
                </Button>
              </div>
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}
