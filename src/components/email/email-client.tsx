'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { DragEvent, MouseEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { EditorContent, useEditor } from '@tiptap/react';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import * as XLSX from 'xlsx';
import {
  Archive,
  ArrowDown,
  ArrowDownUp,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bold,
  Check,
  CheckSquare,
  Columns3,
  Download,
  FileIcon,
  FileSpreadsheet,
  Filter,
  FolderPlus,
  GripVertical,
  Info,
  Italic,
  Inbox,
  ImageIcon,
  LayoutList,
  LinkIcon,
  Loader2,
  Mail,
  MailOpen,
  MoreHorizontal,
  Paperclip,
  PanelBottom,
  PencilLine,
  Plus,
  Printer,
  RefreshCw,
  Reply,
  Search,
  Send,
  Settings,
  SlidersHorizontal,
  Square,
  Star,
  Tag,
  Trash2,
  UnderlineIcon,
  Wand2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { subscribeRealtimeChannel, unsubscribeRealtimeChannel } from '@/lib/realtime/soketi-client';

interface Mailbox {
  id: string;
  address: string;
  display_name: string | null;
  kind: 'personal' | 'shared';
  can_send: boolean;
}

interface Folder {
  id: string;
  mailbox_id: string | null;
  name: string;
  slug: string;
  kind: string;
  position: number;
  unread_count?: number;
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
  is_replied?: boolean;
  has_attachments: boolean;
  raw_size: number | null;
  labels?: EmailLabel[];
}

interface MessagesResponse {
  mailboxes?: Mailbox[];
  folders?: Folder[];
  messages: Message[];
}

interface RealtimeEmailEvent {
  payload?: {
    message?: Message;
    reason?: string;
  };
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
  content_id?: string | null;
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
type EmailColumnId = 'status' | 'from' | 'subject' | 'labels' | 'received' | 'size';
type EmailColumnVisibility = Record<EmailColumnId, boolean>;
type EmailListTextMode = 'compact' | 'normal' | 'comfortable';
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
  type: 'folder' | 'message' | 'compose';
  title: string;
  messageId?: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  messageId: string;
}

interface MailboxContextMenuState {
  x: number;
  y: number;
  target: 'mailbox' | 'folder';
  mailboxId: string;
  folderId?: string;
}

type AttachmentPreviewKind = 'image' | 'pdf' | 'spreadsheet' | 'file';

interface SpreadsheetPreview {
  sheetNames: string[];
  activeSheet: string;
  rows: string[][];
  truncated: boolean;
  maxRows: number;
  maxColumns: number;
}

interface AttachmentPreviewState {
  attachment: Attachment;
  url: string;
  rawUrl: string;
  kind: AttachmentPreviewKind;
  x: number;
  y: number;
  zoom: number;
  spreadsheet?: SpreadsheetPreview;
  loading?: boolean;
  error?: string | null;
}

interface ContextActionItem {
  id: ContextActionId;
  label: string;
  icon: LucideIcon;
}

type EmailColumnWidths = Record<EmailColumnId, number>;

interface EmailColumnSettings {
  order: EmailColumnId[];
  visibility: EmailColumnVisibility;
}

interface RuleDraft {
  name: string;
  field: string;
  operator: string;
  value: string;
  targetFolderId: string;
  action: string;
  actionValue: string;
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
  action: 'move_to',
  actionValue: '',
};

const CONTEXT_MENU_WIDTH = 240;
const CONTEXT_MENU_HEIGHT = 360;
const VIEWPORT_GAP = 8;
const EMAIL_LAYOUT_STORAGE_KEY = 'wacrm.email.layout.v1';
const EMAIL_LIST_TEXT_MODE_STORAGE_KEY = 'wacrm.email.list-text-mode.v1';
const EMAIL_COLUMN_STORAGE_KEY = 'wacrm.email.column-widths.v1';
const EMAIL_COLUMN_SETTINGS_STORAGE_KEY = 'wacrm.email.column-settings.v1';
const EMAIL_PANEL_STORAGE_KEY = 'wacrm.email.panel-widths.v1';
const MAIL_LAYOUT_ORDER: MailLayout[] = ['three-pane', 'focused-list', 'bottom-pane'];
const DEFAULT_EMAIL_COLUMN_ORDER: EmailColumnId[] = ['status', 'from', 'subject', 'labels', 'received', 'size'];
const EMAIL_COLUMN_LABELS: Record<EmailColumnId, string> = {
  status: 'Estado',
  from: 'De',
  subject: 'Asunto',
  labels: 'Categorias',
  received: 'Recibido',
  size: 'Tamano',
};
const DEFAULT_EMAIL_COLUMN_VISIBILITY: EmailColumnVisibility = {
  status: true,
  from: true,
  subject: true,
  labels: true,
  received: true,
  size: true,
};
const DEFAULT_EMAIL_COLUMN_WIDTHS: EmailColumnWidths = {
  status: 68,
  from: 170,
  subject: 360,
  labels: 140,
  received: 96,
  size: 84,
};
const MIN_EMAIL_COLUMN_WIDTHS: EmailColumnWidths = {
  status: 64,
  from: 120,
  subject: 220,
  labels: 96,
  received: 84,
  size: 70,
};

interface EmailPanelWidths {
  sidebar: number;
  list: number;
  bottomList: number;
}

const DEFAULT_EMAIL_PANEL_WIDTHS: EmailPanelWidths = { sidebar: 270, list: 390, bottomList: 360 };
const MIN_EMAIL_PANEL_WIDTHS: EmailPanelWidths = { sidebar: 220, list: 300, bottomList: 180 };
const SPREADSHEET_PREVIEW_MAX_ROWS = 5000;
const SPREADSHEET_PREVIEW_MAX_COLUMNS = 10;
const SPREADSHEET_EXTENSIONS = new Set(['xls', 'xlsx', 'csv']);
const SPREADSHEET_MIME_TYPES = new Set([
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
]);

function attachmentExtension(attachment: Attachment) {
  return attachment.file_name.split('.').pop()?.toLowerCase() ?? '';
}

function attachmentMime(attachment: Attachment) {
  return attachment.content_type?.toLowerCase().split(';')[0].trim() ?? '';
}

function previewKindForAttachment(attachment: Attachment): AttachmentPreviewKind {
  const mime = attachmentMime(attachment);
  const extension = attachmentExtension(attachment);
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (SPREADSHEET_MIME_TYPES.has(mime) || SPREADSHEET_EXTENSIONS.has(extension)) return 'spreadsheet';
  return 'file';
}

function spreadsheetRowsForSheet(workbook: XLSX.WorkBook, sheetName: string): SpreadsheetPreview {
  const worksheet = workbook.Sheets[sheetName];
  const rawRows = worksheet
    ? XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
        header: 1,
        blankrows: false,
        defval: '',
      })
    : [];
  const rows = rawRows
    .slice(0, SPREADSHEET_PREVIEW_MAX_ROWS)
    .map((row) =>
      Array.from({ length: SPREADSHEET_PREVIEW_MAX_COLUMNS }, (_, index) => {
        const value = row[index];
        if (value === null || value === undefined) return '';
        return String(value);
      }),
    );

  return {
    sheetNames: workbook.SheetNames,
    activeSheet: sheetName,
    rows,
    truncated:
      rawRows.length > SPREADSHEET_PREVIEW_MAX_ROWS ||
      rawRows.some((row) => row.length > SPREADSHEET_PREVIEW_MAX_COLUMNS),
    maxRows: SPREADSHEET_PREVIEW_MAX_ROWS,
    maxColumns: SPREADSHEET_PREVIEW_MAX_COLUMNS,
  };
}

function PdfPreview({ url }: { url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    async function renderPdf() {
      try {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
          import.meta.url,
        ).toString();
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error('No se pudo descargar el PDF');
        const document = await pdfjs.getDocument({ data: await response.arrayBuffer() }).promise;
        const page = await document.getPage(1);
        const viewport = page.getViewport({ scale: 1.35 });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas no disponible');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        if (!cancelled) setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    }
    void renderPdf();
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (status === 'error') {
    return (
      <div className="flex h-full min-h-80 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        No se pudo renderizar el PDF. Puedes abrirlo en una pestaña nueva.
      </div>
    );
  }

  return (
    <div className="flex min-h-full items-start justify-center overflow-auto bg-muted/30 p-5">
      {status === 'loading' ? <Loader2 className="absolute top-1/2 size-7 animate-spin text-primary" /> : null}
      <canvas ref={canvasRef} className="max-w-full bg-white shadow-md" aria-label="Vista previa del PDF" />
    </div>
  );
}

function initialEmailPanelWidths(): EmailPanelWidths {
  if (typeof window === 'undefined') return DEFAULT_EMAIL_PANEL_WIDTHS;
  try {
    const stored = JSON.parse(window.localStorage.getItem(EMAIL_PANEL_STORAGE_KEY) || '{}') as Partial<EmailPanelWidths>;
    return {
      sidebar: Math.max(MIN_EMAIL_PANEL_WIDTHS.sidebar, Number(stored.sidebar) || DEFAULT_EMAIL_PANEL_WIDTHS.sidebar),
      list: Math.max(MIN_EMAIL_PANEL_WIDTHS.list, Number(stored.list) || DEFAULT_EMAIL_PANEL_WIDTHS.list),
      bottomList: Math.max(MIN_EMAIL_PANEL_WIDTHS.bottomList, Number(stored.bottomList) || DEFAULT_EMAIL_PANEL_WIDTHS.bottomList),
    };
  } catch {
    return DEFAULT_EMAIL_PANEL_WIDTHS;
  }
}

function initialSearchParam(name: string) {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(name);
}

function initialMailLayout(): MailLayout {
  if (typeof window === 'undefined') return 'three-pane';
  const stored = window.localStorage.getItem(EMAIL_LAYOUT_STORAGE_KEY);
  return MAIL_LAYOUT_ORDER.includes(stored as MailLayout) ? (stored as MailLayout) : 'three-pane';
}

function initialEmailListTextMode(): EmailListTextMode {
  if (typeof window === 'undefined') return 'normal';
  const stored = window.localStorage.getItem(EMAIL_LIST_TEXT_MODE_STORAGE_KEY);
  return stored === 'compact' || stored === 'comfortable' || stored === 'normal' ? stored : 'normal';
}

function initialEmailColumnWidths(): EmailColumnWidths {
  if (typeof window === 'undefined') return DEFAULT_EMAIL_COLUMN_WIDTHS;
  try {
    const stored = window.localStorage.getItem(EMAIL_COLUMN_STORAGE_KEY);
    if (!stored) return DEFAULT_EMAIL_COLUMN_WIDTHS;
    const parsed = JSON.parse(stored) as Partial<EmailColumnWidths>;
    return {
      status: Math.max(parsed.status ?? DEFAULT_EMAIL_COLUMN_WIDTHS.status, MIN_EMAIL_COLUMN_WIDTHS.status),
      from: Math.max(parsed.from ?? DEFAULT_EMAIL_COLUMN_WIDTHS.from, MIN_EMAIL_COLUMN_WIDTHS.from),
      subject: Math.max(parsed.subject ?? DEFAULT_EMAIL_COLUMN_WIDTHS.subject, MIN_EMAIL_COLUMN_WIDTHS.subject),
      labels: Math.max(parsed.labels ?? DEFAULT_EMAIL_COLUMN_WIDTHS.labels, MIN_EMAIL_COLUMN_WIDTHS.labels),
      received: Math.max(parsed.received ?? DEFAULT_EMAIL_COLUMN_WIDTHS.received, MIN_EMAIL_COLUMN_WIDTHS.received),
      size: Math.max(parsed.size ?? DEFAULT_EMAIL_COLUMN_WIDTHS.size, MIN_EMAIL_COLUMN_WIDTHS.size),
    };
  } catch {
    return DEFAULT_EMAIL_COLUMN_WIDTHS;
  }
}

function initialEmailColumnSettings(): EmailColumnSettings {
  if (typeof window === 'undefined') {
    return { order: DEFAULT_EMAIL_COLUMN_ORDER, visibility: DEFAULT_EMAIL_COLUMN_VISIBILITY };
  }
  try {
    const stored = JSON.parse(window.localStorage.getItem(EMAIL_COLUMN_SETTINGS_STORAGE_KEY) || '{}') as Partial<EmailColumnSettings>;
    const storedOrder = Array.isArray(stored.order) ? stored.order : [];
    const order = [
      ...storedOrder.filter((column): column is EmailColumnId => DEFAULT_EMAIL_COLUMN_ORDER.includes(column as EmailColumnId)),
      ...DEFAULT_EMAIL_COLUMN_ORDER.filter((column) => !storedOrder.includes(column)),
    ];
    return {
      order,
      visibility: {
        ...DEFAULT_EMAIL_COLUMN_VISIBILITY,
        ...(stored.visibility ?? {}),
        status: true,
        subject: true,
      },
    };
  } catch {
    return { order: DEFAULT_EMAIL_COLUMN_ORDER, visibility: DEFAULT_EMAIL_COLUMN_VISIBILITY };
  }
}

function emailMessageGridTemplate(widths: EmailColumnWidths, columns: EmailColumnId[]) {
  return columns
    .map((column) => column === 'subject' ? `minmax(${widths.subject}px,1fr)` : `${widths[column]}px`)
    .join(' ');
}

function hasExternalEmailContent(html: string | null) {
  if (!html) return false;
  return /\s(?:src|srcset|background)=["']https?:\/\//i.test(html);
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

function isAppDarkMode() {
  if (typeof document === 'undefined') return false;
  return (
    document.documentElement.dataset.mode === 'dark' ||
    document.body.dataset.mode === 'dark' ||
    document.documentElement.classList.contains('dark') ||
    document.body.classList.contains('dark')
  );
}

function emailHtml(html: string, allowExternalContent: boolean) {
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+=(["']).*?\1/gi, '')
    .replace(/\son[a-z]+=[^\s>]+/gi, '');
  if (allowExternalContent) return withoutScripts;
  return withoutScripts
    .replace(/\s(src|srcset)=["']https?:\/\/[^"']+["']/gi, ' data-external-content-blocked="true"')
    .replace(/\sbackground=["']https?:\/\/[^"']+["']/gi, ' data-external-background-blocked="true"');
}

function emailDocument(html: string, allowExternalContent: boolean, darkMode: boolean) {
  const safeHtml = emailHtml(html, allowExternalContent);
  const surface = darkMode ? '#0f1117' : '#ffffff';
  const text = darkMode ? '#f8fafc' : '#111827';
  const mutedText = darkMode ? '#cbd5e1' : '#4b5563';
  const border = darkMode ? '#2b3038' : '#d1d5db';
  const link = darkMode ? '#8ab4ff' : '#0b57d0';
  const scrollbarThumb = darkMode ? '#4b5563' : '#cbd5e1';
  const scrollbarTrack = darkMode ? '#0f1117' : '#f8fafc';
  const baseStyles = `
    <style>
      :root { color-scheme: ${darkMode ? 'dark' : 'light'}; }
      html, body {
        min-height: 100%;
        margin: 0;
        background: ${surface} !important;
        color: ${text} !important;
        scrollbar-color: ${scrollbarThumb} ${scrollbarTrack};
      }
      body {
        box-sizing: border-box;
        overflow-wrap: anywhere;
        padding: 8px 10px;
      }
      ${darkMode ? `
      body, body * {
        color: ${text} !important;
        border-color: ${border} !important;
      }
      body * {
        background-color: transparent !important;
      }
      [style*="color:"] {
        color: ${text} !important;
      }
      [style*="background"] {
        background-color: transparent !important;
      }
      ` : ''}
      *::-webkit-scrollbar {
        width: 10px;
        height: 10px;
      }
      *::-webkit-scrollbar-track {
        background: ${scrollbarTrack};
      }
      *::-webkit-scrollbar-thumb {
        background: ${scrollbarThumb};
        border-radius: 999px;
        border: 2px solid ${scrollbarTrack};
      }
      img, video {
        max-width: 100%;
        height: auto;
        background: transparent !important;
      }
      table {
        max-width: 100%;
      }
      hr {
        border-color: ${border};
      }
      a {
        color: ${link} !important;
      }
      blockquote {
        color: ${mutedText} !important;
        border-color: ${border} !important;
      }
    </style>
  `;

  if (/<html[\s>]/i.test(safeHtml)) {
    if (/<head[\s>]/i.test(safeHtml)) {
      return safeHtml.replace(/<head([^>]*)>/i, `<head$1>${baseStyles}`);
    }
    return safeHtml.replace(/<html([^>]*)>/i, `<html$1><head>${baseStyles}</head>`);
  }

  return `<!doctype html><html><head><meta charset="utf-8">${baseStyles}</head><body>${safeHtml}</body></html>`;
}

function emailBodyFragment(html: string) {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch?.[1] ?? html;
}

function normalizeContentId(value: string | null | undefined) {
  return value?.trim().replace(/^<|>$/g, '') || null;
}

function forwardedHtml(message: Message) {
  const body = message.body_html
    ? emailBodyFragment(message.body_html)
    : `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(message.body_text || message.snippet || '')}</pre>`;
  return [
    '<p><br></p>',
    '<div style="border-top:1px solid #d4d4d8;margin-top:16px;padding-top:12px">',
    '<p style="margin:0 0 10px;font-weight:600">Mensaje reenviado</p>',
    '<table style="font-size:13px;margin-bottom:12px">',
    `<tr><td style="padding-right:8px;color:#6b7280">De:</td><td>${escapeHtml(message.from_name ? `${message.from_name} <${message.from_address}>` : message.from_address)}</td></tr>`,
    `<tr><td style="padding-right:8px;color:#6b7280">Fecha:</td><td>${escapeHtml(new Date(message.received_at).toLocaleString('es-ES'))}</td></tr>`,
    `<tr><td style="padding-right:8px;color:#6b7280">Asunto:</td><td>${escapeHtml(message.subject || '(Sin asunto)')}</td></tr>`,
    '</table>',
    body,
    '</div>',
  ].join('');
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function replyQuote(message: Message) {
  const date = new Date(message.received_at).toLocaleString('es-ES');
  const author = message.from_name ? `${message.from_name} <${message.from_address}>` : message.from_address;
  const quotedText = message.body_text || message.snippet || '';
  const text = `\n\nEl ${date}, ${author} escribio:\n> ${quotedText.replace(/\n/g, '\n> ')}`;
  const quotedHtml = message.body_html
    ? emailBodyFragment(message.body_html)
    : `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(quotedText)}</pre>`;
  const html = [
    '<p><br></p>',
    '<blockquote style="margin:0 0 0 0.75rem;border-left:3px solid #d4d4d8;padding-left:0.75rem;color:#52525b">',
    `<p>El ${escapeHtml(date)}, ${escapeHtml(author)} escribio:</p>`,
    quotedHtml,
    '</blockquote>',
  ].join('');
  return { text, html };
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

function MailboxContextMenu({
  x,
  y,
  mailboxName,
  target,
  onMarkAllRead,
}: {
  x: number;
  y: number;
  mailboxName: string;
  target: 'mailbox' | 'folder';
  onMarkAllRead: () => void;
}) {
  return (
    <div
      className="fixed z-50 w-64 rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
      style={{ left: x, top: y }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="border-b border-border px-2 py-1.5 text-xs font-medium text-muted-foreground">
        {mailboxName}
      </div>
      <button
        type="button"
        onClick={onMarkAllRead}
        className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-muted"
      >
        <MailOpen className="size-4" />
        <span className="truncate">{target === 'folder' ? 'Marcar carpeta como leida' : 'Marcar todos como leidos'}</span>
      </button>
    </div>
  );
}

function ResizableMessageHeader({
  label,
  column,
  sortable,
  sortDirection,
  canMoveLeft,
  canMoveRight,
  onSort,
  onMoveLeft,
  onMoveRight,
  onResizeStart,
}: {
  label: string;
  column: EmailColumnId;
  sortable?: boolean;
  sortDirection?: 'asc' | 'desc' | null;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onSort?: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  onResizeStart: (column: EmailColumnId, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const SortIcon = sortDirection === 'asc' ? ArrowUp : sortDirection === 'desc' ? ArrowDown : ArrowDownUp;

  return (
    <div className="group relative flex min-w-0 items-center gap-1 pr-3">
      <button
        type="button"
        onClick={onMoveLeft}
        disabled={!canMoveLeft}
        className="hidden rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-0 group-hover:opacity-100 sm:inline-flex"
        title={`Mover ${label} a la izquierda`}
        aria-label={`Mover ${label} a la izquierda`}
      >
        <ArrowLeft className="size-3" />
      </button>
      {sortable ? (
        <button
          type="button"
          onClick={onSort}
          className="flex min-w-0 items-center gap-1 truncate text-left hover:text-foreground"
          title={`Ordenar por ${label}`}
          aria-label={`Ordenar por ${label}`}
        >
          <span className="truncate">{label}</span>
          <SortIcon className={cn('size-3 shrink-0', sortDirection ? 'text-primary' : 'text-muted-foreground/60')} />
        </button>
      ) : (
        <span className="truncate">{label}</span>
      )}
      <button
        type="button"
        onClick={onMoveRight}
        disabled={!canMoveRight}
        className="hidden rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-0 group-hover:opacity-100 sm:inline-flex"
        title={`Mover ${label} a la derecha`}
        aria-label={`Mover ${label} a la derecha`}
      >
        <ArrowRight className="size-3" />
      </button>
      <button
        type="button"
        onMouseDown={(event) => onResizeStart(column, event)}
        className="group/column-resizer absolute right-0 top-0 h-full w-2 cursor-col-resize rounded bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        title={`Ajustar columna ${label}`}
        aria-label={`Ajustar ancho de columna ${label}`}
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-[background-color,box-shadow] duration-150 group-hover/column-resizer:bg-primary group-focus-visible/column-resizer:bg-primary group-hover/column-resizer:shadow-[0_0_0_2px_hsl(var(--primary)/0.12)]" />
        <GripVertical className="pointer-events-none absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 text-primary opacity-0 transition-opacity group-hover/column-resizer:opacity-100 group-focus-visible/column-resizer:opacity-100" />
      </button>
    </div>
  );
}

function PanelResizer({
  label,
  className,
  orientation = 'vertical',
  onResizeStart,
}: {
  label: string;
  className?: string;
  orientation?: 'vertical' | 'horizontal';
  onResizeStart: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onMouseDown={onResizeStart}
      className={cn(
        'group z-20 hidden shrink-0 items-center justify-center bg-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 lg:flex',
        orientation === 'vertical'
          ? 'absolute -right-1 top-0 h-full w-2 cursor-col-resize'
          : 'h-2 w-full cursor-row-resize',
        className,
      )}
      title={label}
    >
      <span
        className={cn(
          'rounded-full bg-border transition-[background-color,box-shadow] duration-150 group-hover:bg-primary group-focus-visible:bg-primary group-hover:shadow-[0_0_0_2px_hsl(var(--primary)/0.12)]',
          orientation === 'vertical' ? 'h-full w-px' : 'h-px w-full',
        )}
      />
      {orientation === 'vertical' ? (
        <GripVertical className="pointer-events-none absolute size-3 text-primary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
      ) : null}
    </button>
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
  const { accountId } = useAuth();
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedMailboxId, setSelectedMailboxId] = useState<string | null>(() => initialSearchParam('mailbox_id'));
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(() => initialSearchParam('folder_id'));
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(() => initialSearchParam('message_id'));
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(() => new Set());
  const [readerMessage, setReaderMessage] = useState<Message | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [applyingRules, setApplyingRules] = useState(false);
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [compose, setCompose] = useState<ComposeState>(emptyCompose);
  const [composeAttachments, setComposeAttachments] = useState<ComposeAttachment[]>([]);
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
  const [, setDrafts] = useState<Draft[]>([]);
  const [labels, setLabels] = useState<EmailLabel[]>([]);
  const [selectedLabelId, setSelectedLabelId] = useState('');
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('all');
  const [layout, setLayout] = useState<MailLayout>(() => initialMailLayout());
  const [listTextMode, setListTextMode] = useState<EmailListTextMode>(() => initialEmailListTextMode());
  const [ruleBuilderOpen, setRuleBuilderOpen] = useState(false);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(emptyRuleDraft);
  const [ruleBuilderPosition, setRuleBuilderPosition] = useState({ x: 320, y: 96 });
  const [publicFolderDialogOpen, setPublicFolderDialogOpen] = useState(false);
  const [publicFolderName, setPublicFolderName] = useState('');
  const [sharedFolderFilter, setSharedFolderFilter] = useState<'all' | 'unread' | 'read'>('all');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advanced, setAdvanced] = useState({ from: '', to: '', sort: 'newest' });
  const [searchScope, setSearchScope] = useState<'folder' | 'mailbox'>('folder');
  const [editorKey, setEditorKey] = useState(0);
  const [allowExternalContent, setAllowExternalContent] = useState(false);
  const [isDarkReader, setIsDarkReader] = useState(false);
  const [tabs, setTabs] = useState<MailTab[]>([]);
  const [activeTabId, setActiveTabId] = useState('folder');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [mailboxContextMenu, setMailboxContextMenu] = useState<MailboxContextMenuState | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [columnWidths, setColumnWidths] = useState<EmailColumnWidths>(() => initialEmailColumnWidths());
  const [columnSettings, setColumnSettings] = useState<EmailColumnSettings>(() => initialEmailColumnSettings());
  const [panelWidths, setPanelWidths] = useState<EmailPanelWidths>(() => initialEmailPanelWidths());
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreviewState | null>(null);
  const attachmentUrlsRef = useRef(new Map<string, string>());
  const hasLoadedRef = useRef(false);
  const mailboxesRef = useRef<Mailbox[]>([]);
  const foldersRef = useRef<Folder[]>([]);
  const readerMessageRef = useRef<Message | null>(null);
  const selectionAnchorMessageIdRef = useRef<string | null>(null);
  const viewCacheRef = useRef(new Map<string, MessagesResponse>());
  const loadSeqRef = useRef(0);
  const realtimeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const keepReaderMessage = useCallback((message: Message | null) => {
    readerMessageRef.current = message;
    setReaderMessage(message);
  }, []);

  const selectedMailbox = useMemo(
    () => selectedMailboxId ? mailboxes.find((mailbox) => mailbox.id === selectedMailboxId) ?? null : null,
    [mailboxes, selectedMailboxId],
  );

  useEffect(() => {
    const readDarkMode = () =>
      isAppDarkMode() || window.matchMedia('(prefers-color-scheme: dark)').matches;
    setIsDarkReader(readDarkMode());
    const observer = new MutationObserver(() => setIsDarkReader(readDarkMode()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mode'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-mode'] });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onMediaChange = () => setIsDarkReader(readDarkMode());
    media.addEventListener('change', onMediaChange);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', onMediaChange);
    };
  }, []);

  const mailboxFolders = useMemo(
    () =>
      folders
        .filter((folder) => folder.mailbox_id === selectedMailbox?.id)
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    [folders, selectedMailbox?.id],
  );

  const publicFolders = useMemo(
    () => folders
      .filter((folder) => folder.kind === 'public' || (folder.kind === 'custom' && !folder.mailbox_id))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [folders],
  );

  const visiblePublicFolders = useMemo(
    () => publicFolders.filter((folder) => {
      const unread = (folder.unread_count ?? 0) > 0;
      if (sharedFolderFilter === 'unread') return unread;
      if (sharedFolderFilter === 'read') return !unread;
      return true;
    }),
    [publicFolders, sharedFolderFilter],
  );
  const sharedFolderFilterLabel = sharedFolderFilter === 'unread'
    ? 'Pendientes'
    : sharedFolderFilter === 'read'
      ? 'Sin pendientes'
      : 'Todas';

  const ruleTargetFolders = useMemo(
    () =>
      [...mailboxFolders, ...publicFolders]
        .filter((folder, index, all) => all.findIndex((item) => item.id === folder.id) === index)
        .sort((a, b) => {
          const aPublic = !a.mailbox_id || a.kind === 'public';
          const bPublic = !b.mailbox_id || b.kind === 'public';
          if (aPublic !== bPublic) return aPublic ? 1 : -1;
          return a.position - b.position || a.name.localeCompare(b.name);
        }),
    [mailboxFolders, publicFolders],
  );

  const selectedMessage = useMemo(
    () => messages.find((message) => message.id === selectedMessageId) ?? readerMessage,
    [messages, readerMessage, selectedMessageId],
  );

  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId) ?? null;
  const unreadByMailbox = useMemo(() => {
    const counts = new Map<string, number>();
    for (const folder of folders) {
      if (!folder.mailbox_id) continue;
      counts.set(folder.mailbox_id, (counts.get(folder.mailbox_id) ?? 0) + (folder.unread_count ?? 0));
    }
    return counts;
  }, [folders]);
  const unreadCount = messages.filter((message) => !message.is_read).length;
  const attachmentCount = messages.filter((message) => message.has_attachments).length;
  const filteredMessages = useMemo(() => {
    if (activeFilter === 'unread') return messages.filter((message) => !message.is_read);
    if (activeFilter === 'attachments') return messages.filter((message) => message.has_attachments);
    if (activeFilter === 'starred') return messages.filter((message) => message.is_starred);
    return messages;
  }, [activeFilter, messages]);
  const selectedVisibleMessageCount = filteredMessages.filter((message) => selectedMessageIds.has(message.id)).length;

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

  const trashFolderId = mailboxFolders.find((folder) => folder.kind === 'trash')?.id ?? '';
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const isMessageTabActive = activeTab?.type === 'message';
  const isContentTabActive = Boolean(activeTab);
  const hasReaderPane = !composeOpen && Boolean(selectedMessage);
  const isSplitReaderLayout = layout === 'three-pane' && hasReaderPane && !isContentTabActive;
  const isBottomReaderLayout = layout === 'bottom-pane' && hasReaderPane && !isContentTabActive;
  const shouldShowMessageList = !isContentTabActive;
  const shouldShowContentPane = composeOpen || isMessageTabActive || (hasReaderPane && layout !== 'focused-list');
  const visibleMessageColumns = columnSettings.order.filter((column) => columnSettings.visibility[column]);
  const messageGridTemplate = emailMessageGridTemplate(columnWidths, visibleMessageColumns);
  const messageGridMinWidth = visibleMessageColumns.reduce((total, column) => total + columnWidths[column], 0);
  const selectedMessageHasExternalContent = hasExternalEmailContent(selectedMessage?.body_html ?? null);
  const selectedLabel = labels.find((label) => label.id === selectedLabelId) ?? null;
  const activeFilterLabel =
    activeFilter === 'unread'
      ? 'No leidos'
      : activeFilter === 'attachments'
        ? 'Con adjuntos'
        : activeFilter === 'starred'
          ? 'Favoritos'
          : 'Todos';
  const quickFilterOptions = [
    { id: 'all' as const, label: 'Todos', count: messages.length },
    { id: 'unread' as const, label: 'No leidos', count: unreadCount },
    { id: 'attachments' as const, label: 'Con adjuntos', count: attachmentCount },
    { id: 'starred' as const, label: 'Favoritos', count: messages.filter((message) => message.is_starred).length },
  ];
  const LayoutIcon = layout === 'three-pane' ? Columns3 : layout === 'bottom-pane' ? PanelBottom : LayoutList;
  const layoutLabel = layout === 'three-pane' ? 'Vista de 3 paneles' : layout === 'bottom-pane' ? 'Vista abajo' : 'Vista lista';
  const activeSearchChips = [
    query.trim() ? { id: 'query', label: `Texto: ${query.trim()}` } : null,
    advanced.from.trim() ? { id: 'from', label: `De: ${advanced.from.trim()}` } : null,
    advanced.to.trim() ? { id: 'to', label: `Para: ${advanced.to.trim()}` } : null,
    activeFilter !== 'all' ? { id: 'filter', label: activeFilter === 'unread' ? 'No leidos' : activeFilter === 'attachments' ? 'Con adjuntos' : 'Favoritos' } : null,
    selectedLabel ? { id: 'label', label: `Etiqueta: ${selectedLabel.name}` } : null,
    searchScope === 'mailbox' ? { id: 'scope', label: 'Todo el buzon' } : null,
  ].filter(Boolean) as Array<{ id: string; label: string }>;

  const sortMessagesByCurrentSort = useCallback((items: Message[]) => {
    const sorted = [...items];
    sorted.sort((a, b) => {
      if (advanced.sort === 'oldest') return new Date(a.received_at).getTime() - new Date(b.received_at).getTime();
      if (advanced.sort === 'sender') return a.from_address.localeCompare(b.from_address);
      if (advanced.sort === 'subject_asc') return a.subject.localeCompare(b.subject);
      if (advanced.sort === 'subject_desc') return b.subject.localeCompare(a.subject);
      if (advanced.sort === 'size_asc') return (a.raw_size ?? 0) - (b.raw_size ?? 0);
      if (advanced.sort === 'size_desc') return (b.raw_size ?? 0) - (a.raw_size ?? 0);
      return new Date(b.received_at).getTime() - new Date(a.received_at).getTime();
    });
    return sorted;
  }, [advanced.sort]);

  const messageMatchesCurrentView = useCallback((message: Message) => {
    if (selectedMailboxId && message.mailbox_id !== selectedMailboxId) return false;
    if (selectedFolderId && searchScope === 'folder' && message.folder_id !== selectedFolderId) return false;
    if (activeFilter === 'unread' && message.is_read) return false;
    if (activeFilter === 'attachments' && !message.has_attachments) return false;
    if (activeFilter === 'starred' && !message.is_starred) return false;
    if (selectedLabelId) return false;
    if (advanced.from.trim() && !message.from_address.toLowerCase().includes(advanced.from.trim().toLowerCase())) return false;
    if (advanced.to.trim() && !message.to_addresses.join(',').toLowerCase().includes(advanced.to.trim().toLowerCase())) return false;
    const textQuery = query.trim().toLowerCase();
    if (textQuery) {
      const haystack = [message.subject, message.from_address, message.from_name, message.snippet, message.body_text]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(textQuery)) return false;
    }
    return true;
  }, [activeFilter, advanced.from, advanced.to, query, searchScope, selectedFolderId, selectedLabelId, selectedMailboxId]);

  const applyRealtimeMessage = useCallback((eventName: 'created' | 'updated' | 'deleted', event: RealtimeEmailEvent) => {
    const message = event.payload?.message;
    if (!message) return;
    viewCacheRef.current.clear();

    setFolders((current) =>
      current.map((folder) => {
        const currentCount = folder.unread_count ?? 0;
        const sameFolder = folder.id === message.folder_id;
        if (eventName === 'created' && sameFolder && !message.is_read) {
          return { ...folder, unread_count: currentCount + 1 };
        }
        if ((eventName === 'updated' || eventName === 'deleted') && sameFolder && message.is_read) {
          return folder;
        }
        return folder;
      }),
    );

    setMessages((current) => {
      const withoutCurrent = current.filter((item) => item.id !== message.id);
      if (eventName === 'deleted' || !messageMatchesCurrentView(message)) return withoutCurrent;
      return sortMessagesByCurrentSort([message, ...withoutCurrent]).slice(0, 200);
    });
    if (eventName === 'deleted' || !messageMatchesCurrentView(message)) {
      setSelectedMessageIds((current) => {
        if (!current.has(message.id)) return current;
        const next = new Set(current);
        next.delete(message.id);
        return next;
      });
    }
    if (readerMessageRef.current?.id === message.id) {
      if (eventName === 'deleted') keepReaderMessage(null);
      else keepReaderMessage(message);
    }
  }, [keepReaderMessage, messageMatchesCurrentView, sortMessagesByCurrentSort]);

  const load = useCallback(async (options?: { silent?: boolean; useCache?: boolean; includeWorkspace?: boolean }) => {
    const requestParams = params;
    const requestId = loadSeqRef.current + 1;
    loadSeqRef.current = requestId;
    const cached = options?.useCache === false ? undefined : viewCacheRef.current.get(requestParams);
    const hasWorkspace = mailboxesRef.current.length > 0 || foldersRef.current.length > 0;
    const silent = options?.silent ?? (hasLoadedRef.current || Boolean(cached));
    if (cached) {
      setMessages(cached.messages);
      setSelectedMessageIds((current) => {
        const nextMessageIds = new Set(cached.messages.map((message) => message.id));
        const nextSelection = [...current].filter((id) => nextMessageIds.has(id));
        return nextSelection.length === current.size ? current : new Set(nextSelection);
      });
    }
    if (!silent) setLoading(true);
    try {
      const fetchParams = new URLSearchParams(requestParams);
      if (hasWorkspace && options?.includeWorkspace !== true) fetchParams.set('workspace', 'false');
      const res = await fetch(`/api/email/messages?${fetchParams.toString()}`, { cache: 'no-store' });
      const payload = (await res.json().catch(() => ({}))) as Partial<MessagesResponse> & { error?: string };
      if (!res.ok) throw new Error(payload.error || 'No se pudo cargar el correo');
      if (requestId !== loadSeqRef.current) return;

      const nextMailboxes = payload.mailboxes ?? mailboxesRef.current;
      const nextFolders = payload.folders ?? foldersRef.current;
      const nextMessages = payload.messages ?? [];
      const retainedFolder = selectedFolderId
        ? nextFolders.find((folder) => folder.id === selectedFolderId) ?? null
        : null;
      const nextMailboxId = retainedFolder
        ? retainedFolder.mailbox_id
        : selectedMailboxId && nextMailboxes.some((mailbox) => mailbox.id === selectedMailboxId)
          ? selectedMailboxId
          : nextMailboxes[0]?.id ?? null;
      const nextFolderId =
        retainedFolder
          ? retainedFolder.id
          : nextFolders.find((folder) => folder.mailbox_id === nextMailboxId && folder.kind === 'inbox')?.id ??
            nextFolders.find((folder) => folder.mailbox_id === nextMailboxId)?.id ??
            nextFolders.find((folder) => !folder.mailbox_id)?.id ??
            null;

      mailboxesRef.current = nextMailboxes;
      foldersRef.current = nextFolders;
      viewCacheRef.current.set(requestParams, {
        mailboxes: nextMailboxes,
        folders: nextFolders,
        messages: nextMessages,
      });
      if (viewCacheRef.current.size > 20) {
        const oldest = viewCacheRef.current.keys().next().value;
        if (oldest) viewCacheRef.current.delete(oldest);
      }
      setMailboxes(nextMailboxes);
      setFolders(nextFolders);
      setMessages(nextMessages);
      setSelectedMessageIds((current) => {
        const nextMessageIds = new Set(nextMessages.map((message) => message.id));
        const nextSelection = [...current].filter((id) => nextMessageIds.has(id));
        return nextSelection.length === current.size ? current : new Set(nextSelection);
      });
      setSelectedMailboxId(nextMailboxId);
      setSelectedFolderId(nextFolderId);
      setSelectedMessageId((current) => {
        if (current && nextMessages.some((message) => message.id === current)) return current;
        if (current && readerMessageRef.current?.id === current) return current;
        return null;
      });
      hasLoadedRef.current = true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo cargar el correo');
    } finally {
      if (!silent && requestId === loadSeqRef.current) setLoading(false);
    }
  }, [params, selectedFolderId, selectedMailboxId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!accountId) return;
    const channelName = `private-account-${accountId}`;
    const channel = subscribeRealtimeChannel(channelName);
    const scheduleSilentRefresh = () => {
      if (realtimeRefreshTimerRef.current) clearTimeout(realtimeRefreshTimerRef.current);
      realtimeRefreshTimerRef.current = setTimeout(() => {
        realtimeRefreshTimerRef.current = null;
        void load({ silent: true });
      }, 450);
    };
    const created = (event: RealtimeEmailEvent) => {
      applyRealtimeMessage('created', event);
      scheduleSilentRefresh();
    };
    const updated = (event: RealtimeEmailEvent) => {
      applyRealtimeMessage('updated', event);
      scheduleSilentRefresh();
    };
    const deleted = (event: RealtimeEmailEvent) => {
      applyRealtimeMessage('deleted', event);
      scheduleSilentRefresh();
    };
    channel.bind('email.message.created', created);
    channel.bind('email.message.updated', updated);
    channel.bind('email.message.deleted', deleted);
    return () => {
      if (realtimeRefreshTimerRef.current) {
        clearTimeout(realtimeRefreshTimerRef.current);
        realtimeRefreshTimerRef.current = null;
      }
      channel.unbind('email.message.created', created);
      channel.unbind('email.message.updated', updated);
      channel.unbind('email.message.deleted', deleted);
      unsubscribeRealtimeChannel(channelName);
    };
  }, [accountId, applyRealtimeMessage, load]);

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
      setMailboxContextMenu(null);
    }
    window.addEventListener('click', closeMenus);
    window.addEventListener('scroll', closeMenus, true);
    return () => {
      window.removeEventListener('click', closeMenus);
      window.removeEventListener('scroll', closeMenus, true);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(EMAIL_COLUMN_STORAGE_KEY, JSON.stringify(columnWidths));
  }, [columnWidths]);

  useEffect(() => {
    window.localStorage.setItem(EMAIL_COLUMN_SETTINGS_STORAGE_KEY, JSON.stringify(columnSettings));
  }, [columnSettings]);

  useEffect(() => {
    window.localStorage.setItem(EMAIL_LIST_TEXT_MODE_STORAGE_KEY, listTextMode);
  }, [listTextMode]);

  useEffect(() => {
    window.localStorage.setItem(EMAIL_LAYOUT_STORAGE_KEY, layout);
  }, [layout]);

  useEffect(() => {
    window.localStorage.setItem(EMAIL_PANEL_STORAGE_KEY, JSON.stringify(panelWidths));
  }, [panelWidths]);

  useEffect(() => {
    if (!selectedMailboxId) {
      setLabels([]);
      setDrafts([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const [labelsRes, draftsRes] = await Promise.all([
        fetch(`/api/email/labels?mailbox_id=${encodeURIComponent(selectedMailboxId)}`, {
          cache: 'no-store',
        }),
        fetch(`/api/email/drafts?mailbox_id=${encodeURIComponent(selectedMailboxId)}`, {
          cache: 'no-store',
        }),
      ]);
      const [labelsPayload, draftsPayload] = await Promise.all([
        labelsRes.json().catch(() => ({})),
        draftsRes.json().catch(() => ({})),
      ]);
      if (!cancelled) {
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
    setAttachmentPreview(null);
  }, [selectedMessage?.id]);

  useEffect(() => {
    setRuleDraft((current) => ({
      ...current,
      targetFolderId:
        current.targetFolderId && ruleTargetFolders.some((folder) => folder.id === current.targetFolderId)
          ? current.targetFolderId
          : ruleTargetFolders.find((folder) => folder.id !== selectedMessage?.folder_id)?.id ?? ruleTargetFolders[0]?.id ?? '',
    }));
  }, [selectedMessage?.folder_id, ruleTargetFolders]);

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
    if (reload) await load({ useCache: false, includeWorkspace: true });
    return true;
  }

  async function patchMessage(body: Record<string, unknown>) {
    if (!selectedMessage) return;
    await patchMessageById(selectedMessage.id, body);
  }

  async function selectMessage(message: Message) {
    keepReaderMessage(message);
    setSelectedMessageId(message.id);
    setSelectedMessageIds(new Set());
    selectionAnchorMessageIdRef.current = message.id;
    setActiveTabId((current) => current || 'folder');
    if (!message.is_read) {
      setMessages((current) =>
        current.map((item) => (item.id === message.id ? { ...item, is_read: true } : item)),
      );
      await patchMessageById(message.id, { is_read: true }, false);
    }
  }

  function clearMessageSelection() {
    setSelectedMessageIds(new Set());
    selectionAnchorMessageIdRef.current = null;
  }

  function toggleMessageSelection(message: Message) {
    selectionAnchorMessageIdRef.current = message.id;
    setSelectedMessageIds((current) => {
      const next = new Set(current);
      if (next.has(message.id)) next.delete(message.id);
      else next.add(message.id);
      return next;
    });
  }

  function selectMessageRange(message: Message) {
    const anchorId = selectionAnchorMessageIdRef.current ?? selectedMessageId ?? filteredMessages[0]?.id ?? message.id;
    const anchorIndex = filteredMessages.findIndex((item) => item.id === anchorId);
    const targetIndex = filteredMessages.findIndex((item) => item.id === message.id);
    if (anchorIndex === -1 || targetIndex === -1) {
      setSelectedMessageIds(new Set([message.id]));
      selectionAnchorMessageIdRef.current = message.id;
      return;
    }
    const [from, to] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    setSelectedMessageIds(new Set(filteredMessages.slice(from, to + 1).map((item) => item.id)));
  }

  function handleMessageClick(event: MouseEvent<HTMLDivElement>, message: Message) {
    if (event.shiftKey) {
      selectMessageRange(message);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      toggleMessageSelection(message);
      return;
    }
    void selectMessage(message);
  }

  async function patchSelectedMessages(body: Record<string, unknown>) {
    const messageIds = filteredMessages
      .map((message) => message.id)
      .filter((messageId) => selectedMessageIds.has(messageId));
    if (messageIds.length === 0) return;

    if (typeof body.is_read === 'boolean') {
      setMessages((current) =>
        current.map((message) =>
          selectedMessageIds.has(message.id) ? { ...message, is_read: body.is_read as boolean } : message,
        ),
      );
      if (readerMessageRef.current && selectedMessageIds.has(readerMessageRef.current.id)) {
        keepReaderMessage({ ...readerMessageRef.current, is_read: body.is_read as boolean });
      }
    }

    try {
      const res = await fetch('/api/email/messages/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_ids: messageIds, ...body }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'No se pudo actualizar la seleccion');
      toast.success(`${messageIds.length} correos actualizados`);
      await load({ silent: true, useCache: false, includeWorkspace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo actualizar la seleccion');
      await load({ silent: true, useCache: false, includeWorkspace: true });
    }
  }

  async function openMessageTab(message: Message) {
    await selectMessage(message);
    setComposeOpen(false);
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
      setSelectedMessageId(null);
      keepReaderMessage(null);
      if (tabId === 'compose') setComposeOpen(false);
    }
  }

  function closeMessageView() {
    if (activeTabId !== 'folder') {
      setTabs((current) => current.filter((tab) => tab.id !== activeTabId));
    }
    setSelectedMessageId(null);
    keepReaderMessage(null);
    setActiveTabId('folder');
  }

  function openComposeTab(title: string) {
    setTabs((current) => [
      ...current.filter((tab) => tab.id !== 'compose'),
      { id: 'compose', type: 'compose' as const, title },
    ].slice(-8));
    setActiveTabId('compose');
    setComposeOpen(true);
  }

  function setTableSort(nextSort: 'received' | 'sender' | 'subject' | 'size') {
    setAdvanced((current) => ({
      ...current,
      sort:
        nextSort === 'received'
          ? current.sort === 'newest' ? 'oldest' : 'newest'
          : nextSort === 'size'
            ? current.sort === 'size_desc' ? 'size_asc' : 'size_desc'
            : nextSort === 'subject'
              ? current.sort === 'subject_asc' ? 'subject_desc' : 'subject_asc'
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

  function cycleLayout() {
    setLayout((current) => {
      const currentIndex = MAIL_LAYOUT_ORDER.indexOf(current);
      return MAIL_LAYOUT_ORDER[(currentIndex + 1) % MAIL_LAYOUT_ORDER.length] ?? 'three-pane';
    });
  }

  function toggleMessageColumn(column: EmailColumnId) {
    if (column === 'status' || column === 'subject') return;
    setColumnSettings((current) => ({
      ...current,
      visibility: {
        ...current.visibility,
        [column]: !current.visibility[column],
      },
    }));
  }

  function moveMessageColumn(column: EmailColumnId, direction: -1 | 1) {
    setColumnSettings((current) => {
      const index = current.order.indexOf(column);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.order.length) return current;
      const order = [...current.order];
      [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
      return { ...current, order };
    });
  }

  function messageColumnSortDirection(column: EmailColumnId): 'asc' | 'desc' | null {
    if (column === 'from') return advanced.sort === 'sender' ? 'asc' : null;
    if (column === 'subject') {
      if (advanced.sort === 'subject_asc') return 'asc';
      if (advanced.sort === 'subject_desc') return 'desc';
      return null;
    }
    if (column === 'received') {
      if (advanced.sort === 'oldest') return 'asc';
      if (advanced.sort === 'newest') return 'desc';
      return null;
    }
    if (column === 'size') {
      if (advanced.sort === 'size_asc') return 'asc';
      if (advanced.sort === 'size_desc') return 'desc';
    }
    return null;
  }

  function renderMessageCell(message: Message, column: EmailColumnId) {
    if (column === 'status') {
      const isSelected = selectedMessageIds.has(message.id);
      return (
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              toggleMessageSelection(message);
            }}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-primary"
            title={isSelected ? 'Quitar de la seleccion' : 'Seleccionar correo'}
            aria-label={isSelected ? 'Quitar de la seleccion' : 'Seleccionar correo'}
          >
            {isSelected ? <CheckSquare className="size-3.5 text-primary" /> : <Square className="size-3.5" />}
          </button>
          <span className={cn('size-2 rounded-full', message.is_read ? 'bg-transparent' : 'bg-primary')} />
          {message.is_replied ? (
            <Reply className="size-3.5 shrink-0 text-primary" aria-label="Respondido" />
          ) : message.has_attachments ? (
            <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Mail className="size-3.5 shrink-0 text-muted-foreground" />
          )}
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
      );
    }
    if (column === 'from') {
      return <span className="block min-w-0 truncate pr-3">{message.from_name || message.from_address}</span>;
    }
    if (column === 'subject') {
      return (
        <span className="block min-w-0 overflow-hidden pr-3">
          <span className="block truncate">{message.subject || '(Sin asunto)'}</span>
          {listTextMode !== 'compact' && message.snippet ? (
            <span className="block truncate text-xs font-normal text-muted-foreground">{message.snippet}</span>
          ) : null}
        </span>
      );
    }
    if (column === 'labels') {
      return (
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
      );
    }
    if (column === 'received') {
      return <span className="truncate text-xs font-normal text-muted-foreground tabular-nums">{formatDate(message.received_at)}</span>;
    }
    return <span className="truncate text-xs font-normal text-muted-foreground tabular-nums">{formatBytes(message.raw_size)}</span>;
  }

  function startColumnResize(column: EmailColumnId, event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = columnWidths[column];
    function onPointerMove(moveEvent: globalThis.MouseEvent) {
      const nextWidth = Math.max(MIN_EMAIL_COLUMN_WIDTHS[column], startWidth + moveEvent.clientX - startX);
      setColumnWidths((current) => ({
        ...current,
        [column]: nextWidth,
      }));
    }
    function onPointerUp() {
      window.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('mouseup', onPointerUp);
    }
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);
  }

  function startPanelResize(panel: keyof EmailPanelWidths, event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    const isVerticalResize = panel === 'bottomList';
    const startPosition = isVerticalResize ? event.clientY : event.clientX;
    const startWidth = panelWidths[panel];
    const onPointerMove = (moveEvent: globalThis.MouseEvent) => {
      const nextPosition = isVerticalResize ? moveEvent.clientY : moveEvent.clientX;
      const delta = nextPosition - startPosition;
      setPanelWidths((current) => ({
        ...current,
        [panel]: Math.max(MIN_EMAIL_PANEL_WIDTHS[panel], startWidth + delta),
      }));
    };
    const stopResize = () => {
      window.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('mouseup', stopResize);
    };
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', stopResize);
  }

  function startAttachmentPreviewDrag(event: MouseEvent<HTMLDivElement>) {
    if (!attachmentPreview) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = attachmentPreview.x;
    const originY = attachmentPreview.y;
    const onPointerMove = (moveEvent: globalThis.MouseEvent) => {
      setAttachmentPreview((current) => {
        if (!current) return current;
        return {
          ...current,
          x: Math.min(Math.max(VIEWPORT_GAP, originX + moveEvent.clientX - startX), window.innerWidth - 360),
          y: Math.min(Math.max(VIEWPORT_GAP, originY + moveEvent.clientY - startY), window.innerHeight - 220),
        };
      });
    };
    const stopDrag = () => {
      window.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('mouseup', stopDrag);
    };
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', stopDrag);
  }

  function startRuleBuilderDrag(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = ruleBuilderPosition;
    const onMove = (moveEvent: globalThis.MouseEvent) => {
      setRuleBuilderPosition({
        x: Math.min(Math.max(VIEWPORT_GAP, origin.x + moveEvent.clientX - startX), window.innerWidth - 420),
        y: Math.min(Math.max(VIEWPORT_GAP, origin.y + moveEvent.clientY - startY), window.innerHeight - 180),
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function openMessageContextMenu(event: MouseEvent, message: Message) {
    event.preventDefault();
    keepReaderMessage(message);
    setSelectedMessageId(message.id);
    setMailboxContextMenu(null);
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - CONTEXT_MENU_WIDTH - VIEWPORT_GAP),
      y: Math.min(event.clientY, window.innerHeight - CONTEXT_MENU_HEIGHT - VIEWPORT_GAP),
      messageId: message.id,
    });
  }

  function openMailboxContextMenu(event: MouseEvent, mailbox: Mailbox) {
    event.preventDefault();
    setContextMenu(null);
    setMailboxContextMenu({
      x: Math.min(event.clientX, window.innerWidth - CONTEXT_MENU_WIDTH - VIEWPORT_GAP),
      y: Math.min(event.clientY, window.innerHeight - 120 - VIEWPORT_GAP),
      target: 'mailbox',
      mailboxId: mailbox.id,
    });
  }

  function openFolderContextMenu(event: MouseEvent, folder: Folder, fallbackMailboxId: string | null) {
    event.preventDefault();
    setContextMenu(null);
    setMailboxContextMenu({
      x: Math.min(event.clientX, window.innerWidth - CONTEXT_MENU_WIDTH - VIEWPORT_GAP),
      y: Math.min(event.clientY, window.innerHeight - 120 - VIEWPORT_GAP),
      target: 'folder',
      mailboxId: folder.mailbox_id ?? fallbackMailboxId ?? '',
      folderId: folder.id,
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

  async function markMailboxAsRead(mailboxId: string) {
    setMailboxContextMenu(null);
    setMessages((current) =>
      current.map((message) =>
        message.mailbox_id === mailboxId ? { ...message, is_read: true } : message,
      ),
    );
    try {
      const res = await fetch('/api/email/messages/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_mailbox_read', mailbox_id: mailboxId }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'No se pudo marcar el buzon como leido');
      toast.success(`${payload.updated ?? 0} correos marcados como leidos`);
      await load({ useCache: false, includeWorkspace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo marcar el buzon como leido');
      await load({ useCache: false, includeWorkspace: true });
    }
  }

  async function markFolderAsRead(folderId: string) {
    setMailboxContextMenu(null);
    setMessages((current) =>
      current.map((message) =>
        message.folder_id === folderId ? { ...message, is_read: true } : message,
      ),
    );
    try {
      const res = await fetch('/api/email/messages/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_folder_read', folder_id: folderId }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'No se pudo marcar la carpeta como leida');
      toast.success(`${payload.updated ?? 0} correos marcados como leidos`);
      await load({ useCache: false, includeWorkspace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo marcar la carpeta como leida');
      await load({ useCache: false, includeWorkspace: true });
    }
  }

  function printMessage(message: Message) {
    const safeBody = message.body_html
      ? emailBodyFragment(emailHtml(message.body_html, allowExternalContent))
      : `<pre>${escapeHtml(message.body_text || message.snippet || '')}</pre>`;
    const frame = document.createElement('iframe');
    frame.title = 'Impresion del correo';
    frame.style.position = 'fixed';
    frame.style.right = '0';
    frame.style.bottom = '0';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.style.border = '0';
    frame.style.opacity = '0';
    frame.srcdoc = `
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
        </body>
      </html>
    `;
    frame.onload = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch {
        toast.error('No se pudo abrir el dialogo de impresion');
      } finally {
        window.setTimeout(() => frame.remove(), 1000);
      }
    };
    document.body.appendChild(frame);
  }

  async function runContextAction(action: ContextActionId) {
    const message = messages.find((item) => item.id === contextMenu?.messageId);
    setContextMenu(null);
    if (!message) return;
    if (action === 'open') await openMessageTab(message);
    if (action === 'reply') {
      await selectMessage(message);
      await openReply(message);
    }
    if (action === 'reply_all') {
      await selectMessage(message);
      await openReplyAll(message);
    }
    if (action === 'forward') {
      await selectMessage(message);
      await openForward(message);
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
      await load({ useCache: false, includeWorkspace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo sincronizar');
    } finally {
      setSyncing(false);
    }
  }

  async function applyCurrentRules(folderId: string | null = selectedFolderId) {
    if (!selectedMailbox) return;
    setApplyingRules(true);
    try {
      const res = await fetch('/api/email/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'apply_all',
          mailbox_id: selectedMailbox.id,
          folder_id: folderId,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'No se pudieron aplicar las reglas');
      toast.success(`Reglas aplicadas: ${payload.matched ?? 0} correos coincidentes, ${payload.updated ?? 0} actualizados`);
      await load({ useCache: false, includeWorkspace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudieron aplicar las reglas');
    } finally {
      setApplyingRules(false);
    }
  }

  async function createPublicFolder() {
    const name = publicFolderName.trim();
    if (!name) return;
    const res = await fetch('/api/email/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload.error || 'No se pudo crear la carpeta');
      return;
    }
    setPublicFolderName('');
    setPublicFolderDialogOpen(false);
    toast.success('Carpeta publica creada');
    await load({ useCache: false, includeWorkspace: true });
  }

  async function createRuleFromBuilder(applyAfterCreate = false) {
    const needsTarget = ruleDraft.action === 'move_to' || ruleDraft.action === 'copy_to';
    const needsValue = !['exists', 'not_exists'].includes(ruleDraft.operator);
    if (!selectedMailbox || (needsValue && !ruleDraft.value.trim()) || (needsTarget && !ruleDraft.targetFolderId)) return;
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
        action: ruleDraft.action,
        action_value: ruleDraft.actionValue.trim() || null,
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload.error || 'No se pudo crear la regla');
      return;
    }
    setRuleDraft(emptyRuleDraft);
    setRuleBuilderOpen(false);
    toast.success('Regla creada');
    if (applyAfterCreate) await applyCurrentRules(null);
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

  function openNewMessage() {
    setCurrentDraftId(null);
    setCompose(emptyCompose);
    setComposeAttachments([]);
    setEditorKey((current) => current + 1);
    openComposeTab('Nuevo correo');
  }

  async function openReply(source?: Message) {
    const message = source ?? selectedMessage;
    if (!message) return;
    const quote = replyQuote(message);
    const inlineAttachments = await loadMessageAttachmentsForCompose(message, { inlineOnly: true }).catch((error) => {
      toast.error(error instanceof Error ? error.message : 'No se pudieron preparar las imagenes embebidas');
      return [];
    });
    setCurrentDraftId(null);
    setCompose({
      to: message.from_address,
      cc: '',
      bcc: '',
      subject: message.subject.toLowerCase().startsWith('re:')
        ? message.subject
        : `Re: ${message.subject}`,
      text: quote.text,
      html: quote.html,
      inReplyToMessageId: message.id,
    });
    setComposeAttachments(inlineAttachments);
    setEditorKey((current) => current + 1);
    openComposeTab('Responder');
  }

  async function openReplyAll(source?: Message) {
    const message = source ?? selectedMessage;
    if (!message || !selectedMailbox) return;
    const quote = replyQuote(message);
    const inlineAttachments = await loadMessageAttachmentsForCompose(message, { inlineOnly: true }).catch((error) => {
      toast.error(error instanceof Error ? error.message : 'No se pudieron preparar las imagenes embebidas');
      return [];
    });
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
      text: quote.text,
      html: quote.html,
      inReplyToMessageId: message.id,
    });
    setComposeAttachments(inlineAttachments);
    setEditorKey((current) => current + 1);
    openComposeTab('Responder a todos');
  }

  async function openForward(source?: Message) {
    const message = source ?? selectedMessage;
    if (!message) return;
    let forwardedAttachments: ComposeAttachment[] = [];
    if (message.has_attachments) {
      try {
        forwardedAttachments = await loadMessageAttachmentsForCompose(message);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'No se pudieron preparar los adjuntos originales');
      }
    }
    setCurrentDraftId(null);
    setCompose({
      to: '',
      cc: '',
      bcc: '',
      subject: message.subject.toLowerCase().startsWith('fw:')
        ? message.subject
        : `Fw: ${message.subject}`,
      text: `\n\n---------- Mensaje reenviado ----------\nDe: ${message.from_address}\nFecha: ${new Date(message.received_at).toLocaleString('es-ES')}\nAsunto: ${message.subject}\n\n${message.body_text ?? message.snippet ?? ''}`,
      html: forwardedHtml(message),
      inReplyToMessageId: null,
    });
    setComposeAttachments(forwardedAttachments);
    setEditorKey((current) => current + 1);
    openComposeTab('Reenviar');
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

  async function getAttachmentUrl(attachment: Attachment) {
    const cachedUrl = attachmentUrlsRef.current.get(attachment.id);
    if (cachedUrl) return cachedUrl;
    const res = await fetch(`/api/email/attachments/${attachment.id}`, { cache: 'no-store' });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.url) {
      toast.error(payload.error || 'No se pudo abrir el adjunto');
      return null;
    }
    const url = String(payload.url);
    attachmentUrlsRef.current.set(attachment.id, url);
    return url;
  }

  async function prepareAttachmentDrag(attachment: Attachment, event: DragEvent<HTMLDivElement>) {
    event.dataTransfer.effectAllowed = 'copy';
    const downloadUrl = `${window.location.origin}/api/email/attachments/${encodeURIComponent(attachment.id)}?download=1`;

    // Chromium exposes DownloadURL to the desktop/file manager, which is the
    // same interaction users expect from a native webmail attachment.
    event.dataTransfer.setData(
      'DownloadURL',
      `${attachment.content_type || 'application/octet-stream'}:${attachment.file_name}:${downloadUrl}`,
    );
    event.dataTransfer.setData('text/uri-list', downloadUrl);
  }

  async function openAttachmentPreview(attachment: Attachment) {
    const url = await getAttachmentUrl(attachment);
    if (!url) return;
    const rawUrl = `/api/email/attachments/${attachment.id}?raw=1`;
    const kind = previewKindForAttachment(attachment);
    setAttachmentPreview({
      attachment,
      url,
      rawUrl,
      kind,
      x: Math.max(72, Math.round(window.innerWidth * 0.18)),
      y: Math.max(72, Math.round(window.innerHeight * 0.12)),
      zoom: 1,
      loading: kind === 'spreadsheet',
      error: null,
    });
    if (kind !== 'spreadsheet') return;

    try {
      const response = await fetch(rawUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error('No se pudo cargar la vista previa.');
      const workbook = XLSX.read(await response.arrayBuffer(), { type: 'array' });
      const firstSheet = workbook.SheetNames[0];
      if (!firstSheet) throw new Error('El archivo no contiene hojas visibles.');
      const spreadsheet = spreadsheetRowsForSheet(workbook, firstSheet);
      setAttachmentPreview((current) => {
        if (!current || current.attachment.id !== attachment.id) return current;
        return { ...current, spreadsheet, loading: false };
      });
    } catch (error) {
      setAttachmentPreview((current) => {
        if (!current || current.attachment.id !== attachment.id) return current;
        return {
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : 'No se pudo cargar la vista previa.',
        };
      });
    }
  }

  async function selectSpreadsheetSheet(sheetName: string) {
    if (!attachmentPreview || attachmentPreview.kind !== 'spreadsheet') return;
    const { attachment, rawUrl } = attachmentPreview;
    setAttachmentPreview((current) => current ? { ...current, loading: true, error: null } : current);
    try {
      const response = await fetch(rawUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error('No se pudo cargar la hoja.');
      const workbook = XLSX.read(await response.arrayBuffer(), { type: 'array' });
      const spreadsheet = spreadsheetRowsForSheet(workbook, sheetName);
      setAttachmentPreview((current) => {
        if (!current || current.attachment.id !== attachment.id) return current;
        return { ...current, spreadsheet, loading: false };
      });
    } catch (error) {
      setAttachmentPreview((current) => {
        if (!current || current.attachment.id !== attachment.id) return current;
        return {
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : 'No se pudo cargar la hoja.',
        };
      });
    }
  }

  function downloadAttachment(attachment: Attachment) {
    const link = document.createElement('a');
    link.href = `/api/email/attachments/${encodeURIComponent(attachment.id)}?download=1`;
    link.download = attachment.file_name;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function blobToBase64(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error('No se pudo leer el adjunto.'));
      reader.onload = () => {
        const value = typeof reader.result === 'string' ? reader.result : '';
        resolve(value.includes(',') ? value.split(',')[1] ?? '' : value);
      };
      reader.readAsDataURL(blob);
    });
  }

  async function loadMessageAttachmentsForCompose(message: Message, options: { inlineOnly?: boolean } = {}) {
    if (!message.has_attachments) return [];
    const listRes = await fetch(`/api/email/messages/${message.id}/attachments`, { cache: 'no-store' });
    const listPayload = await listRes.json().catch(() => ({}));
    if (!listRes.ok) throw new Error(listPayload.error || 'No se pudieron cargar los adjuntos originales');
    const sourceAttachments = ((listPayload.attachments ?? []) as Attachment[])
      .filter((attachment) => !options.inlineOnly || Boolean(attachment.content_id));
    const totalBytes = sourceAttachments.reduce((total, attachment) => total + (attachment.size ?? 0), 0);
    if (totalBytes > 8 * 1024 * 1024) {
      throw new Error('Los adjuntos originales superan el limite de 8 MB.');
    }

    return Promise.all(
      sourceAttachments.slice(0, 10).map(async (attachment) => {
        const fileRes = await fetch(`/api/email/attachments/${attachment.id}?raw=1`, { cache: 'no-store' });
        if (!fileRes.ok) throw new Error(`No se pudo leer ${attachment.file_name}`);
        const blob = await fileRes.blob();
        return {
          filename: attachment.file_name,
          content_type: attachment.content_type ?? (blob.type || 'application/octet-stream'),
          size: attachment.size ?? blob.size,
          content_base64: await blobToBase64(blob),
          content_id: normalizeContentId(attachment.content_id),
        } satisfies ComposeAttachment;
      }),
    );
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
      if (compose.inReplyToMessageId) {
        setMessages((current) =>
          current.map((message) =>
            message.id === compose.inReplyToMessageId ? { ...message, is_replied: true } : message,
          ),
        );
      }
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
        void openReply();
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
    <div className="-m-4 flex h-screen flex-col overflow-hidden bg-background sm:-m-6">
      <div className="flex min-h-10 items-end gap-2 border-b border-border bg-card px-2">
        <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
          <button
            type="button"
            onClick={() => {
              setActiveTabId('folder');
              setComposeOpen(false);
            }}
            className={cn(
              'flex h-9 max-w-[240px] items-center gap-2 rounded-t-md border border-b-0 px-3 text-sm',
              activeTabId === 'folder' ? 'border-border bg-background text-primary' : 'border-transparent bg-muted/60 text-muted-foreground',
            )}
          >
            <Inbox className="size-4" />
            <span className="truncate">{selectedFolder?.name ?? 'Bandeja'}</span>
          </button>
          <Button
            size="icon-sm"
            className="mb-1"
            onClick={openNewMessage}
            disabled={!selectedMailbox?.can_send}
            title="Nuevo correo"
            aria-label="Nuevo correo"
          >
            <Plus className="size-4" />
          </Button>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                'flex h-9 max-w-[260px] items-center gap-2 rounded-t-md border border-b-0 px-3 text-sm',
                activeTabId === tab.id ? 'border-border bg-background text-primary' : 'border-transparent bg-muted/60 text-muted-foreground',
              )}
            >
              {tab.type === 'compose' ? <PencilLine className="size-4 shrink-0" /> : <Mail className="size-4 shrink-0" />}
              <button
                type="button"
                onClick={() => {
                  setActiveTabId(tab.id);
                  if (tab.messageId) setSelectedMessageId(tab.messageId);
                  if (tab.type !== 'compose') setComposeOpen(false);
                  if (tab.type === 'compose') setComposeOpen(true);
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
        <div className="flex h-9 shrink-0 items-center gap-1 pb-1">
          <Button size="icon-sm" variant="outline" onClick={sync} disabled={syncing} title="Sincronizar" aria-label="Sincronizar">
            {syncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => void applyCurrentRules()}
            disabled={applyingRules || !selectedMailbox}
            title="Aplicar reglas"
            aria-label="Aplicar reglas"
          >
            {applyingRules ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
          </Button>
          <Button size="icon-sm" variant="outline" onClick={cycleLayout} title={`${layoutLabel}. Cambiar vista`} aria-label={`${layoutLabel}. Cambiar vista`}>
            <LayoutIcon className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => {
              window.location.href = '/settings?tab=email';
            }}
            title="Ajustes de correo"
            aria-label="Ajustes de correo"
          >
            <Settings className="size-4" />
          </Button>
        </div>
      </div>

      <div
        className={cn(
          'grid min-h-0 flex-1',
          isSplitReaderLayout && 'lg:grid-cols-[var(--mail-sidebar)_var(--mail-list)_minmax(0,1fr)]',
          !isSplitReaderLayout && 'lg:grid-cols-[var(--mail-sidebar)_minmax(0,1fr)]',
          isBottomReaderLayout && 'lg:grid-rows-[var(--mail-bottom-list)_8px_minmax(0,1fr)]',
        )}
        style={{
          '--mail-sidebar': `${panelWidths.sidebar}px`,
          '--mail-list': `${panelWidths.list}px`,
          '--mail-bottom-list': `${panelWidths.bottomList}px`,
        } as CSSProperties}
      >
        <aside className={cn(
          'relative flex min-w-0 flex-col border-b border-border bg-card lg:border-b-0 lg:border-r',
          isBottomReaderLayout && 'lg:row-span-3',
        )}>
          <PanelResizer label="Ajustar ancho del buzón" onResizeStart={(event) => startPanelResize('sidebar', event)} />
          <div className="border-b border-border p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Mail className="size-4 text-primary" />
                Email
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] p-3">
            <div>
              <p className="mb-2 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Buzones</p>
              {mailboxes.length === 0 ? (
                <div className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                  No tienes buzones asignados.
                </div>
              ) : (
                <div className="space-y-3">
                  {mailboxes.map((mailbox) => (
                    <div key={mailbox.id}>
                      <button
                        type="button"
                        onContextMenu={(event) => openMailboxContextMenu(event, mailbox)}
                        onClick={() => {
                          const inbox = folders.find((folder) => folder.mailbox_id === mailbox.id && folder.kind === 'inbox');
                          setSelectedMailboxId(mailbox.id);
                          setSelectedFolderId(inbox?.id ?? folders.find((folder) => folder.mailbox_id === mailbox.id)?.id ?? null);
                          setSelectedMessageId(null);
                          clearMessageSelection();
                          setActiveTabId('folder');
                          setComposeOpen(false);
                        }}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors',
                          selectedMailbox?.id === mailbox.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
                        )}
                        title="Clic derecho para opciones del buzon"
                      >
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold">
                          {(mailbox.display_name || mailbox.address).slice(0, 2).toUpperCase()}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{mailbox.display_name || mailbox.address}</span>
                          <span className="block truncate text-xs text-muted-foreground">{mailbox.address}</span>
                        </span>
                        {(unreadByMailbox.get(mailbox.id) ?? 0) > 0 ? (
                          <span className="ml-auto rounded-full bg-primary/10 px-1.5 text-xs font-medium text-primary">
                            {unreadByMailbox.get(mailbox.id)}
                          </span>
                        ) : null}
                      </button>
                      <div className="ml-4 mt-1 space-y-0.5 border-l border-border pl-2">
                        {folders
                          .filter((folder) => folder.mailbox_id === mailbox.id && folder.kind !== 'custom')
                          .sort((a, b) => a.position - b.position)
                          .map((folder) => (
                            <button
                              key={folder.id}
                              type="button"
                              onContextMenu={(event) => openFolderContextMenu(event, folder, mailbox.id)}
                              onClick={() => {
                                setSelectedMailboxId(mailbox.id);
                                setSelectedFolderId(folder.id);
                                setSelectedMessageId(null);
                                clearMessageSelection();
                                setActiveTabId('folder');
                                setComposeOpen(false);
                              }}
                              className={cn(
                                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                                selectedFolderId === folder.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                              )}
                            >
                              {folder.kind === 'inbox' ? <Inbox className="size-4" /> : folder.kind === 'trash' ? <Trash2 className="size-4" /> : <Archive className="size-4" />}
                              <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                              {(folder.unread_count ?? 0) > 0 ? <span className="text-xs text-muted-foreground">{folder.unread_count}</span> : null}
                            </button>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between gap-2 px-2">
                <button
                  type="button"
                  onClick={() => {
                    setSharedFolderFilter((current) =>
                      current === 'all' ? 'unread' : current === 'unread' ? 'read' : 'all',
                    );
                  }}
                  className="min-w-0 truncate text-left text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
                  title={`Filtro: ${sharedFolderFilterLabel}`}
                  aria-label={`Carpetas compartidas, filtro ${sharedFolderFilterLabel}`}
                >
                  Carpetas compartidas · {sharedFolderFilterLabel}
                </button>
                <Button size="icon-xs" variant="ghost" onClick={() => setPublicFolderDialogOpen(true)} title="Crear carpeta compartida">
                  <FolderPlus className="size-3.5" />
                </Button>
              </div>
              <div className="space-y-1">
                {visiblePublicFolders.map((folder) => {
                  const count = folder.unread_count ?? 0;
                  return (
                    <button
                      key={folder.id}
                      type="button"
                      onContextMenu={(event) => openFolderContextMenu(event, folder, selectedMailboxId)}
                      onClick={() => {
                        setSelectedMailboxId(folder.mailbox_id);
                        setSelectedFolderId(folder.id);
                        setSelectedMessageId(null);
                        clearMessageSelection();
                        setActiveTabId('folder');
                        setComposeOpen(false);
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
          </div>
        </aside>

        <section className={cn(
          'relative flex min-h-0 min-w-0 flex-col overflow-hidden border-b border-border bg-card lg:border-b-0',
          isSplitReaderLayout && 'lg:border-r',
          !shouldShowMessageList && 'hidden',
          isBottomReaderLayout && 'lg:col-start-2 lg:row-start-1',
        )}>
          {isSplitReaderLayout ? (
            <PanelResizer label="Ajustar ancho de la lista" onResizeStart={(event) => startPanelResize('list', event)} />
          ) : null}
          <div className="shrink-0 border-b border-border p-3">
            <div className="relative z-20 flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Buscar correo"
                  className="h-9 pl-8 pr-10"
                />
                <Button
                  type="button"
                  size="icon-xs"
                  variant={advancedOpen ? 'secondary' : 'ghost'}
                  onClick={() => setAdvancedOpen((current) => !current)}
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  title="Busqueda avanzada"
                  aria-label="Busqueda avanzada"
                >
                  <SlidersHorizontal className="size-3.5" />
                </Button>
                {advancedOpen ? (
                  <div className="absolute left-0 right-0 top-[calc(100%+0.375rem)] z-30 grid gap-2 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg">
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
                        <option value="subject_asc">Asunto A-Z</option>
                        <option value="subject_desc">Asunto Z-A</option>
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
                          setAdvancedOpen(false);
                        }}
                      >
                        Limpiar
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant={activeFilter === 'all' ? 'outline' : 'secondary'}
                      title={`Filtro: ${activeFilterLabel}`}
                      aria-label={`Filtro: ${activeFilterLabel}`}
                    />
                  }
                >
                  <Filter className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  {quickFilterOptions.map((filter) => (
                    <DropdownMenuItem
                      key={filter.id}
                      onClick={() => setActiveFilter(filter.id)}
                      className={cn(activeFilter === filter.id && 'text-primary')}
                    >
                      <Check className={cn('size-4', activeFilter === filter.id ? 'opacity-100' : 'opacity-0')} />
                      <span className="flex-1">{filter.label}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">{filter.count}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button size="icon-sm" variant="outline" title="Opciones de lista" aria-label="Opciones de lista" />
                  }
                >
                  <MoreHorizontal className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Columnas</div>
                  {columnSettings.order.map((column) => (
                    <div key={column} className="flex items-center gap-1 px-1">
                      <DropdownMenuCheckboxItem
                        checked={columnSettings.visibility[column]}
                        disabled={column === 'status' || column === 'subject'}
                        onCheckedChange={() => toggleMessageColumn(column)}
                        className="min-w-0 flex-1"
                      >
                        {EMAIL_COLUMN_LABELS[column]}
                      </DropdownMenuCheckboxItem>
                      <button
                        type="button"
                        onClick={() => moveMessageColumn(column, -1)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                        disabled={columnSettings.order.indexOf(column) === 0}
                        title="Mover a la izquierda"
                      >
                        <ArrowLeft className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveMessageColumn(column, 1)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                        disabled={columnSettings.order.indexOf(column) === columnSettings.order.length - 1}
                        title="Mover a la derecha"
                      >
                        <ArrowRight className="size-3.5" />
                      </button>
                    </div>
                  ))}
                  <DropdownMenuSeparator />
                  <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Texto</div>
                  {[
                    { id: 'compact' as const, label: 'Compacto' },
                    { id: 'normal' as const, label: 'Normal' },
                    { id: 'comfortable' as const, label: 'Comodo' },
                  ].map((mode) => (
                    <DropdownMenuItem key={mode.id} onClick={() => setListTextMode(mode.id)}>
                      <Check className={cn('size-4', listTextMode === mode.id ? 'opacity-100' : 'opacity-0')} />
                      {mode.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span className="truncate">{selectedFolder?.name ?? 'Carpeta'} · {messages.length} correos</span>
              <span>{unreadCount} no leidos</span>
            </div>
            {selectedVisibleMessageCount > 0 ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-muted/40 p-1.5 text-xs">
                <span className="px-1.5 font-medium text-foreground">{selectedVisibleMessageCount} seleccionados</span>
                <Button size="xs" variant="outline" onClick={() => void patchSelectedMessages({ is_read: true })}>
                  <MailOpen className="size-3.5" />
                  Leidos
                </Button>
                <Button size="xs" variant="outline" onClick={() => void patchSelectedMessages({ is_read: false })}>
                  <Mail className="size-3.5" />
                  No leidos
                </Button>
                <Button size="icon-xs" variant="ghost" onClick={clearMessageSelection} title="Limpiar seleccion" aria-label="Limpiar seleccion">
                  <X className="size-3.5" />
                </Button>
              </div>
            ) : null}
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
          <div className="min-h-0 flex-1 overflow-auto">
            {loading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="size-5 animate-spin text-primary" />
              </div>
            ) : filteredMessages.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">No hay correos en esta vista.</div>
            ) : (
              <div style={{ minWidth: messageGridMinWidth }}>
                <div
                  className="sticky top-0 z-10 grid items-center border-b border-border bg-card px-2 py-2 text-[11px] font-semibold uppercase text-muted-foreground"
                  style={{ gridTemplateColumns: messageGridTemplate }}
                >
                  {visibleMessageColumns.map((column) => {
                    const columnIndex = columnSettings.order.indexOf(column);
                    return (
                      <ResizableMessageHeader
                        key={column}
                        label={EMAIL_COLUMN_LABELS[column]}
                        column={column}
                        sortable={column === 'from' || column === 'subject' || column === 'received' || column === 'size'}
                        sortDirection={messageColumnSortDirection(column)}
                        canMoveLeft={columnIndex > 0}
                        canMoveRight={columnIndex >= 0 && columnIndex < columnSettings.order.length - 1}
                        onSort={() => {
                          if (column === 'from') setTableSort('sender');
                          if (column === 'subject') setTableSort('subject');
                          if (column === 'received') setTableSort('received');
                          if (column === 'size') setTableSort('size');
                        }}
                        onMoveLeft={() => moveMessageColumn(column, -1)}
                        onMoveRight={() => moveMessageColumn(column, 1)}
                        onResizeStart={startColumnResize}
                      />
                    );
                  })}
                </div>
                {filteredMessages.map((message) => (
                  <div
                    key={message.id}
                    role="button"
                    tabIndex={0}
                    onClick={(event) => handleMessageClick(event, message)}
                    onDoubleClick={() => void openMessageTab(message)}
                    onContextMenu={(event) => openMessageContextMenu(event, message)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void selectMessage(message);
                      if (event.key === ' ') {
                        event.preventDefault();
                        toggleMessageSelection(message);
                      }
                    }}
                    className={cn(
                      'grid items-center border-b border-border px-2 text-sm transition-colors hover:bg-muted/60',
                      listTextMode === 'compact' ? 'min-h-8' : listTextMode === 'comfortable' ? 'min-h-12' : 'min-h-10',
                      selectedMessageIds.has(message.id) && 'bg-primary/5 ring-1 ring-inset ring-primary/20',
                      selectedMessage?.id === message.id && 'bg-primary/10',
                      !message.is_read && 'font-semibold',
                    )}
                    style={{ gridTemplateColumns: messageGridTemplate }}
                    title="Doble clic para abrir en pestana. Clic derecho para acciones."
                  >
                    {visibleMessageColumns.map((column) => (
          <div key={column} className="min-w-0 overflow-hidden">
                        {renderMessageCell(message, column)}
                      </div>
                    ))}
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
          {mailboxContextMenu ? (
            <MailboxContextMenu
              x={mailboxContextMenu.x}
              y={mailboxContextMenu.y}
              mailboxName={
                mailboxContextMenu.folderId
                  ? folders.find((folder) => folder.id === mailboxContextMenu.folderId)?.name || 'Carpeta'
                  : mailboxes.find((mailbox) => mailbox.id === mailboxContextMenu.mailboxId)?.display_name ||
                    mailboxes.find((mailbox) => mailbox.id === mailboxContextMenu.mailboxId)?.address ||
                    'Buzon'
              }
              target={mailboxContextMenu.target}
              onMarkAllRead={() => {
                if (mailboxContextMenu.folderId) {
                  void markFolderAsRead(mailboxContextMenu.folderId);
                  return;
                }
                void markMailboxAsRead(mailboxContextMenu.mailboxId);
              }}
            />
          ) : null}
        </section>

        {isBottomReaderLayout ? (
          <PanelResizer
            label="Ajustar alto entre lista y lector"
            orientation="horizontal"
            className="lg:col-start-2 lg:row-start-2"
            onResizeStart={(event) => startPanelResize('bottomList', event)}
          />
        ) : null}

        <main
          className={cn(
            'relative min-h-0 min-w-0 overflow-hidden bg-card',
            !shouldShowContentPane && 'hidden',
            isSplitReaderLayout && 'lg:col-start-3',
            isBottomReaderLayout && 'lg:col-start-2 lg:row-start-3',
          )}
        >
          {!composeOpen && selectedMessage ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="shrink-0 border-b border-border p-4">
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
                    <Button size="sm" className="h-8 px-2.5" onClick={() => void openReply()} disabled={!selectedMailbox?.can_send}>
                      <Reply className="size-4" />
                      Responder
                    </Button>
                    <Button variant="outline" size="sm" className="h-8 px-2.5" onClick={() => void openReplyAll()} disabled={!selectedMailbox?.can_send}>
                      <Reply className="size-4" />
                      Todos
                    </Button>
                    <Button variant="outline" size="sm" className="h-8 px-2.5" onClick={() => void openForward()} disabled={!selectedMailbox?.can_send}>
                      <Send className="size-4" />
                      Reenviar
                    </Button>
                    <Button variant="outline" size="icon-sm" className="size-8" onClick={() => copyMessageLink(selectedMessage)} title="Copiar enlace" aria-label="Copiar enlace">
                      <LinkIcon className="size-4" />
                    </Button>
                    <Button variant="outline" size="icon-sm" className="size-8" onClick={() => printMessage(selectedMessage)} title="Imprimir" aria-label="Imprimir">
                      <Printer className="size-4" />
                    </Button>
                    <Button variant="outline" size="icon-sm" className="size-8" onClick={() => setDetailsOpen((current) => !current)} title="Detalles" aria-label="Detalles">
                      <Info className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-8"
                      title="Cerrar mensaje"
                      aria-label="Cerrar mensaje"
                      onClick={closeMessageView}
                    >
                      <X className="size-4" />
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

                {selectedMessageHasExternalContent ? (
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
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {attachmentsLoading ? (
                      <span className="flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        Cargando adjuntos
                      </span>
                    ) : (
                      attachments.map((attachment) => (
                        <div
                          key={attachment.id}
                          role="button"
                          tabIndex={0}
                          draggable
                          onClick={() => void openAttachmentPreview(attachment)}
                          onDragStart={(event) => void prepareAttachmentDrag(attachment, event)}
                          onMouseEnter={() => void getAttachmentUrl(attachment)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void openAttachmentPreview(attachment);
                          }}
                          className="group flex h-7 max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-background px-2 text-left text-xs hover:bg-muted"
                          title="Abrir adjunto"
                        >
                          <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">
                            {attachment.file_name}
                            <span className="ml-1 text-muted-foreground">{formatBytes(attachment.size)}</span>
                          </span>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              downloadAttachment(attachment);
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== 'Enter' && event.key !== ' ') return;
                              event.preventDefault();
                              event.stopPropagation();
                              downloadAttachment(attachment);
                            }}
                            className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                            title="Descargar adjunto"
                            aria-label="Descargar adjunto"
                          >
                            <Download className="size-3.5" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                ) : null}
              </div>

              <article className="min-h-0 flex-1 overflow-y-auto">
                {selectedMessage.body_html ? (
                  <iframe
                    title="Contenido del correo"
                    sandbox=""
                    srcDoc={emailDocument(selectedMessage.body_html, allowExternalContent, isDarkReader)}
                    className="h-full min-h-[420px] w-full border-0 bg-background"
                  />
                ) : (
                  <pre className="min-h-full whitespace-pre-wrap bg-background p-2.5 text-sm leading-6 text-foreground">
                    {selectedMessage.body_text || selectedMessage.snippet}
                  </pre>
                )}
              </article>
            </div>
          ) : !composeOpen ? (
            <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 text-muted-foreground">
              <MailOpen className="size-9" />
              <p className="text-sm">Selecciona un correo para leerlo.</p>
            </div>
          ) : null}

          {ruleBuilderOpen ? (
            <div className="fixed z-50 w-[min(700px,calc(100vw-24px))] rounded-lg border border-border bg-background shadow-2xl" style={{ left: ruleBuilderPosition.x, top: ruleBuilderPosition.y }}>
              <div className="flex min-h-12 cursor-move items-center justify-between border-b border-border px-3" onMouseDown={startRuleBuilderDrag}>
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
                <div className="grid grid-cols-3 gap-2">
                  <select
                    value={ruleDraft.field}
                    onChange={(event) => setRuleDraft((current) => ({ ...current, field: event.target.value }))}
                    className="h-8 rounded-lg border border-border bg-card px-2 text-sm"
                  >
                    <option value="from">Remitente</option>
                    <option value="from_domain">Dominio</option>
                    <option value="subject">Asunto</option>
                    <option value="body">Cuerpo</option>
                    <option value="to">A</option>
                    <option value="cc">Cc</option>
                    <option value="to_or_cc">Para o CC</option>
                    <option value="recipients">Todos los destinatarios</option>
                    <option value="age_days">Antigüedad (días)</option>
                    <option value="size_kb">Tamaño (KB)</option>
                    <option value="has_attachment">Tiene adjunto</option>
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
                    <option value="not_contains">No contiene</option>
                    <option value="not_equals">No es</option>
                    <option value="exists">Existe</option>
                    <option value="not_exists">No existe</option>
                    <option value="greater_than">Mayor que</option>
                    <option value="less_than">Menor que</option>
                  </select>
                  <select value={ruleDraft.action} onChange={(event) => setRuleDraft((current) => ({ ...current, action: event.target.value }))} className="h-8 rounded-lg border border-border bg-card px-2 text-sm">
                    <option value="move_to">Mover a</option>
                    <option value="copy_to">Copiar a</option>
                    <option value="mark_read">Marcar como leído</option>
                    <option value="mark_unread">Marcar como no leído</option>
                    <option value="star">Añadir estrella</option>
                    <option value="label">Etiquetar mensaje</option>
                  </select>
                </div>
                {!['exists', 'not_exists'].includes(ruleDraft.operator) ? <Input
                  value={ruleDraft.value}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, value: event.target.value }))}
                  placeholder="Valor"
                /> : null}
                {ruleDraft.action === 'label' ? <select value={ruleDraft.actionValue} onChange={(event) => setRuleDraft((current) => ({ ...current, actionValue: event.target.value }))} className="h-8 rounded-lg border border-border bg-card px-2 text-sm">
                  <option value="">Selecciona una etiqueta</option>
                  {labels.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}
                </select> : null}
                {ruleDraft.action === 'move_to' || ruleDraft.action === 'copy_to' ? <select
                  value={ruleDraft.targetFolderId}
                  onChange={(event) => setRuleDraft((current) => ({ ...current, targetFolderId: event.target.value }))}
                  className="h-8 rounded-lg border border-border bg-card px-2 text-sm"
                >
                  {ruleTargetFolders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      Mover a {folder.name} · {folder.mailbox_id ? 'Buzon' : 'Publica'}
                    </option>
                  ))}
                </select> : null}
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => setRuleBuilderOpen(false)}>
                    Cancelar
                  </Button>
                  <Button size="sm" onClick={() => void createRuleFromBuilder()} disabled={(['exists', 'not_exists'].includes(ruleDraft.operator) ? false : !ruleDraft.value.trim()) || ((ruleDraft.action === 'move_to' || ruleDraft.action === 'copy_to') && !ruleDraft.targetFolderId)}>
                    <Wand2 className="size-4" />
                    Crear regla
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void createRuleFromBuilder(true)}
                    disabled={applyingRules || (['exists', 'not_exists'].includes(ruleDraft.operator) ? false : !ruleDraft.value.trim()) || ((ruleDraft.action === 'move_to' || ruleDraft.action === 'copy_to') && !ruleDraft.targetFolderId)}
                  >
                    <Wand2 className="size-4" />
                    Crear y aplicar
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          <Dialog
            open={publicFolderDialogOpen}
            onOpenChange={(open) => {
              setPublicFolderDialogOpen(open);
              if (!open) setPublicFolderName('');
            }}
          >
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Nueva carpeta compartida</DialogTitle>
                <DialogDescription>
                  La carpeta será global y aparecerá fuera de los buzones. El acceso se controla desde Permisos.
                </DialogDescription>
              </DialogHeader>
              <Input
                autoFocus
                value={publicFolderName}
                onChange={(event) => setPublicFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void createPublicFolder();
                  }
                }}
                placeholder="Nombre de la carpeta"
                aria-label="Nombre de la carpeta compartida"
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setPublicFolderDialogOpen(false)}>
                  Cancelar
                </Button>
                <Button type="button" onClick={() => void createPublicFolder()} disabled={!publicFolderName.trim()}>
                  <FolderPlus className="size-4" />
                  Crear carpeta
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {composeOpen ? (
            <div className="absolute inset-0 z-10 flex min-h-0 flex-col bg-background">
              <div className="flex min-h-12 items-center justify-between border-b border-border px-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">
                    {compose.inReplyToMessageId ? 'Responder' : 'Nuevo correo'}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">Desde {selectedMailbox?.address}</p>
                </div>
                <Button size="icon-sm" variant="ghost" onClick={() => closeTab('compose')} title="Cerrar redactor">
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

      {attachmentPreview ? (
        <div className="pointer-events-none fixed inset-0 z-50 bg-black/35">
          <div
            className="pointer-events-auto fixed flex h-[min(86vh,820px)] w-[min(88vw,1040px)] min-w-[380px] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-2xl"
            style={{ left: attachmentPreview.x, top: attachmentPreview.y }}
          >
            <div
              className="flex min-h-10 cursor-move items-center gap-2 bg-background px-3"
              onMouseDown={startAttachmentPreviewDrag}
            >
              {attachmentPreview.kind === 'spreadsheet' ? (
                <FileSpreadsheet className="size-4 shrink-0 text-muted-foreground" />
              ) : attachmentPreview.kind === 'image' ? (
                <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{attachmentPreview.attachment.file_name}</p>
              </div>
              <button
                type="button"
                onClick={() => setAttachmentPreview(null)}
                onMouseDown={(event) => event.stopPropagation()}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Cerrar"
                aria-label="Cerrar"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="flex min-h-9 items-center justify-end gap-1 border-y border-zinc-700 bg-zinc-800 px-3 text-zinc-100">
              <span className="mr-auto truncate text-xs text-zinc-300">
                {attachmentPreview.attachment.content_type || 'Archivo adjunto'} · {formatBytes(attachmentPreview.attachment.size)}
              </span>
              <button
                type="button"
                onClick={() =>
                  setAttachmentPreview((current) =>
                    current ? { ...current, zoom: Math.max(0.5, Number((current.zoom - 0.1).toFixed(2))) } : current,
                  )
                }
                className="rounded p-1 hover:bg-white/10"
                title="Reducir zoom"
                aria-label="Reducir zoom"
              >
                <ZoomOut className="size-4" />
              </button>
              <span className="min-w-16 rounded bg-zinc-700 px-2 py-1 text-center text-xs">
                {Math.round(attachmentPreview.zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() =>
                  setAttachmentPreview((current) =>
                    current ? { ...current, zoom: Math.min(2, Number((current.zoom + 0.1).toFixed(2))) } : current,
                  )
                }
                className="rounded p-1 hover:bg-white/10"
                title="Aumentar zoom"
                aria-label="Aumentar zoom"
              >
                <ZoomIn className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => window.open(attachmentPreview.rawUrl, '_blank', 'noopener,noreferrer')}
                className="rounded p-1 hover:bg-white/10"
                title="Abrir en pestana"
                aria-label="Abrir en pestana"
              >
                <ArrowRight className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => void downloadAttachment(attachmentPreview.attachment)}
                className="rounded p-1 hover:bg-white/10"
                title="Descargar adjunto"
                aria-label="Descargar adjunto"
              >
                <Download className="size-4" />
              </button>
            </div>
            {attachmentPreview.kind === 'spreadsheet' && attachmentPreview.spreadsheet ? (
              <div className="flex min-h-9 items-center gap-1 border-b border-border bg-muted/50 px-3">
                {attachmentPreview.spreadsheet.sheetNames.map((sheetName) => (
                  <button
                    key={sheetName}
                    type="button"
                    onClick={() => void selectSpreadsheetSheet(sheetName)}
                    className={cn(
                      'h-7 rounded-t border border-b-0 px-3 text-xs font-medium',
                      attachmentPreview.spreadsheet?.activeSheet === sheetName
                        ? 'bg-background text-foreground'
                        : 'bg-muted text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {sheetName}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-auto bg-zinc-900 p-3">
              {attachmentPreview.kind === 'image' ? (
                <div className="flex min-h-full items-center justify-center">
                  <img
                    src={attachmentPreview.rawUrl}
                    alt={attachmentPreview.attachment.file_name}
                    className="max-h-none max-w-none rounded border border-zinc-700 bg-white"
                    style={{ transform: `scale(${attachmentPreview.zoom})`, transformOrigin: 'center top' }}
                  />
                </div>
              ) : attachmentPreview.kind === 'pdf' ? (
                <PdfPreview url={attachmentPreview.rawUrl} />
              ) : attachmentPreview.kind === 'spreadsheet' ? (
                <div className="min-h-full rounded bg-white p-3 text-black">
                  {attachmentPreview.loading ? (
                    <div className="flex h-48 items-center justify-center">
                      <Loader2 className="size-5 animate-spin text-primary" />
                    </div>
                  ) : attachmentPreview.error ? (
                    <div className="flex h-48 flex-col items-center justify-center text-center text-sm text-muted-foreground">
                      <FileSpreadsheet className="mb-3 size-10" />
                      {attachmentPreview.error}
                    </div>
                  ) : attachmentPreview.spreadsheet ? (
                    <div style={{ transform: `scale(${attachmentPreview.zoom})`, transformOrigin: 'top left' }}>
                      {attachmentPreview.spreadsheet.truncated ? (
                        <div className="mb-2 border border-yellow-300 bg-yellow-50 px-3 py-2 text-center text-xs text-yellow-900">
                          Vista previa truncada a {attachmentPreview.spreadsheet.maxRows} filas x {attachmentPreview.spreadsheet.maxColumns} columnas.
                        </div>
                      ) : null}
                      <table className="border-collapse text-xs">
                        <tbody>
                          {attachmentPreview.spreadsheet.rows.map((row, rowIndex) => (
                            <tr key={rowIndex}>
                              {row.map((cell, cellIndex) => (
                                <td key={cellIndex} className="min-w-36 max-w-72 border border-zinc-300 px-2 py-1 align-top">
                                  <span className="block truncate" title={cell}>{cell}</span>
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="flex h-full min-h-[360px] flex-col items-center justify-center rounded bg-background p-6 text-center">
                  <FileIcon className="mb-3 size-10 text-muted-foreground" />
                  <p className="max-w-full truncate text-sm font-medium">{attachmentPreview.attachment.file_name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Este tipo de archivo no tiene vista previa interna.</p>
                  <div className="mt-5 flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => window.open(attachmentPreview.rawUrl, '_blank', 'noopener,noreferrer')}>
                      Abrir
                    </Button>
                    <Button size="sm" onClick={() => downloadAttachment(attachmentPreview.attachment)}>
                      <Download className="size-4" />
                      Descargar
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
