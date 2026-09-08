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
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  is_replied?: boolean;
  has_attachments: boolean;
  raw_size: number | null;
  labels?: EmailLabel[];
}

interface MessagesResponse {
  mailboxes: Mailbox[];
  folders: Folder[];
  messages: Message[];
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
  status: 48,
  from: 170,
  subject: 360,
  labels: 140,
  received: 96,
  size: 84,
};
const MIN_EMAIL_COLUMN_WIDTHS: EmailColumnWidths = {
  status: 44,
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
        const document = await pdfjs.getDocument({ url }).promise;
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

function replyQuote(message: Message) {
  const date = new Date(message.received_at).toLocaleString('es-ES');
  const author = message.from_name ? `${message.from_name} <${message.from_address}>` : message.from_address;
  const quotedText = message.body_text || message.snippet || '';
  const text = `\n\nEl ${date}, ${author} escribio:\n> ${quotedText.replace(/\n/g, '\n> ')}`;
  const html = [
    '<p><br></p>',
    '<blockquote style="margin:0 0 0 0.75rem;border-left:3px solid #d4d4d8;padding-left:0.75rem;color:#52525b">',
    `<p>El ${escapeHtml(date)}, ${escapeHtml(author)} escribio:</p>`,
    `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(quotedText)}</pre>`,
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advanced, setAdvanced] = useState({ from: '', to: '', sort: 'newest' });
  const [searchScope, setSearchScope] = useState<'folder' | 'mailbox'>('folder');
  const [editorKey, setEditorKey] = useState(0);
  const [allowExternalContent, setAllowExternalContent] = useState(false);
  const [tabs, setTabs] = useState<MailTab[]>([]);
  const [activeTabId, setActiveTabId] = useState('folder');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [columnWidths, setColumnWidths] = useState<EmailColumnWidths>(() => initialEmailColumnWidths());
  const [columnSettings, setColumnSettings] = useState<EmailColumnSettings>(() => initialEmailColumnSettings());
  const [panelWidths, setPanelWidths] = useState<EmailPanelWidths>(() => initialEmailPanelWidths());
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreviewState | null>(null);
  const attachmentUrlsRef = useRef(new Map<string, string>());

  const selectedMailbox = useMemo(
    () => mailboxes.find((mailbox) => mailbox.id === selectedMailboxId) ?? mailboxes[0] ?? null,
    [mailboxes, selectedMailboxId],
  );

  const mailboxFolders = useMemo(
    () =>
      folders
        .filter((folder) => folder.mailbox_id === selectedMailbox?.id)
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    [folders, selectedMailbox?.id],
  );

  const publicFolders = useMemo(
    () => folders
      .filter((folder) => folder.kind === 'custom')
      .sort((a, b) => a.name.localeCompare(b.name)),
    [folders],
  );

  const visibleFolders = mailboxFolders;

  const selectedMessage = useMemo(
    () => messages.find((message) => message.id === selectedMessageId) ?? null,
    [messages, selectedMessageId],
  );

  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId) ?? null;
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

  const trashFolderId = mailboxFolders.find((folder) => folder.kind === 'trash')?.id ?? '';
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const isMessageTabActive = activeTab?.type === 'message';
  const isContentTabActive = Boolean(activeTab);
  const hasReaderPane = !composeOpen && Boolean(selectedMessage);
  const isSplitReaderLayout = layout === 'three-pane' && hasReaderPane && !isContentTabActive;
  const isBottomReaderLayout = layout === 'bottom-pane' && hasReaderPane && !isContentTabActive;
  const shouldShowMessageList = !isContentTabActive;
  const shouldShowContentPane = composeOpen || hasReaderPane || isMessageTabActive;
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
      if (tabId === 'compose') setComposeOpen(false);
    }
  }

  function closeMessageView() {
    if (activeTabId !== 'folder') {
      setTabs((current) => current.filter((tab) => tab.id !== activeTabId));
    }
    setSelectedMessageId(null);
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
      return (
        <div className="flex items-center gap-1.5">
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
      return <span className="truncate pr-3">{message.from_name || message.from_address}</span>;
    }
    if (column === 'subject') {
      return (
        <span className="min-w-0 pr-3">
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

  function openNewMessage() {
    setCurrentDraftId(null);
    setCompose(emptyCompose);
    setComposeAttachments([]);
    setEditorKey((current) => current + 1);
    openComposeTab('Nuevo correo');
  }

  function openReply(source?: Message) {
    const message = source ?? selectedMessage;
    if (!message) return;
    const quote = replyQuote(message);
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
    setComposeAttachments([]);
    setEditorKey((current) => current + 1);
    openComposeTab('Responder');
  }

  function openReplyAll(source?: Message) {
    const message = source ?? selectedMessage;
    if (!message || !selectedMailbox) return;
    const quote = replyQuote(message);
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
    setComposeAttachments([]);
    setEditorKey((current) => current + 1);
    openComposeTab('Responder a todos');
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
    const url = await getAttachmentUrl(attachment);
    if (!url) return;

    // Chromium exposes DownloadURL to the desktop/file manager, which is the
    // same interaction users expect from a native webmail attachment.
    event.dataTransfer.setData(
      'DownloadURL',
      `${attachment.content_type || 'application/octet-stream'}:${attachment.file_name}:${url}`,
    );
    event.dataTransfer.setData('text/uri-list', url);
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

  async function downloadAttachment(attachment: Attachment) {
    const url = attachmentPreview?.attachment.id === attachment.id
      ? attachmentPreview.url
      : await getAttachmentUrl(attachment);
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
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
              <Button size="icon-sm" variant="ghost" onClick={createPublicFolder} disabled={!selectedMailbox} title="Nueva carpeta publica">
                <FolderPlus className="size-4" />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
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
                        onClick={() => {
                          const inbox = folders.find((folder) => folder.mailbox_id === mailbox.id && folder.kind === 'inbox');
                          setSelectedMailboxId(mailbox.id);
                          setSelectedFolderId(inbox?.id ?? folders.find((folder) => folder.mailbox_id === mailbox.id)?.id ?? null);
                          setSelectedMessageId(null);
                          setActiveTabId('folder');
                          setComposeOpen(false);
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
                      <div className="ml-4 mt-1 space-y-0.5 border-l border-border pl-2">
                        {folders
                          .filter((folder) => folder.mailbox_id === mailbox.id && folder.kind !== 'custom')
                          .sort((a, b) => a.position - b.position)
                          .map((folder) => (
                            <button
                              key={folder.id}
                              type="button"
                              onClick={() => {
                                setSelectedMailboxId(mailbox.id);
                                setSelectedFolderId(folder.id);
                                setSelectedMessageId(null);
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
                              {folder.kind === 'inbox' && selectedMailbox?.id === mailbox.id && unreadCount > 0 ? <span className="text-xs text-muted-foreground">{unreadCount}</span> : null}
                            </button>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between px-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Carpetas compartidas</p>
                <Button size="icon-xs" variant="ghost" onClick={createPublicFolder} disabled={!selectedMailbox} title="Crear carpeta">
                  <FolderPlus className="size-3.5" />
                </Button>
              </div>
              <div className="space-y-1">
                {publicFolders.map((folder) => {
                  const count = messages.filter((message) => message.folder_id === folder.id).length;
                  return (
                    <button
                      key={folder.id}
                      type="button"
                      onClick={() => {
                        setSelectedMailboxId(folder.mailbox_id);
                        setSelectedFolderId(folder.id);
                        setSelectedMessageId(null);
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
                    onClick={() => void selectMessage(message)}
                    onDoubleClick={() => void openMessageTab(message)}
                    onContextMenu={(event) => openMessageContextMenu(event, message)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void selectMessage(message);
                    }}
                    className={cn(
                      'grid items-center border-b border-border px-2 text-sm transition-colors hover:bg-muted/60',
                      listTextMode === 'compact' ? 'min-h-8' : listTextMode === 'comfortable' ? 'min-h-12' : 'min-h-10',
                      selectedMessage?.id === message.id && 'bg-primary/10',
                      !message.is_read && 'font-semibold',
                    )}
                    style={{ gridTemplateColumns: messageGridTemplate }}
                    title="Doble clic para abrir en pestana. Clic derecho para acciones."
                  >
                    {visibleMessageColumns.map((column) => (
                      <div key={column} className="min-w-0">
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
                    <Button size="sm" onClick={() => openReply()} disabled={!selectedMailbox?.can_send}>
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
                    <Button variant="outline" size="icon-sm" onClick={() => copyMessageLink(selectedMessage)} title="Copiar enlace" aria-label="Copiar enlace">
                      <LinkIcon className="size-4" />
                    </Button>
                    <Button variant="outline" size="icon-sm" onClick={() => printMessage(selectedMessage)} title="Imprimir" aria-label="Imprimir">
                      <Printer className="size-4" />
                    </Button>
                    <Button variant="outline" size="icon-sm" onClick={() => setDetailsOpen((current) => !current)} title="Detalles" aria-label="Detalles">
                      <Info className="size-4" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" title="Mas acciones" onClick={openSelectedMessageMenu}>
                      <MoreHorizontal className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
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
                              void downloadAttachment(attachment);
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== 'Enter' && event.key !== ' ') return;
                              event.preventDefault();
                              event.stopPropagation();
                              void downloadAttachment(attachment);
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

              <article className="min-h-0 flex-1 overflow-y-auto p-4">
                {selectedMessage.body_html ? (
                  <iframe
                    title="Contenido del correo"
                    sandbox=""
                    srcDoc={emailHtml(selectedMessage.body_html, allowExternalContent)}
                    className="h-full min-h-[420px] w-full rounded-md border border-border bg-background"
                  />
                ) : (
                  <pre className="whitespace-pre-wrap text-sm leading-6 text-foreground">
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
                    <Button size="sm" onClick={() => void downloadAttachment(attachmentPreview.attachment)}>
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
