'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Download,
  FileIcon,
  FolderPlus,
  Inbox,
  Loader2,
  Mail,
  MailOpen,
  MoreHorizontal,
  Paperclip,
  PencilLine,
  RefreshCw,
  Reply,
  Search,
  Send,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
  has_attachments: boolean;
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

interface ComposeAttachment {
  filename: string;
  content_type?: string;
  size: number;
  content_base64: string;
}

interface ComposeState {
  to: string;
  cc: string;
  subject: string;
  text: string;
  inReplyToMessageId: string | null;
}

const emptyCompose: ComposeState = {
  to: '',
  cc: '',
  subject: '',
  text: '',
  inReplyToMessageId: null,
};

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

export function EmailClient() {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedMailboxId, setSelectedMailboxId] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
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
  const [moveFolderId, setMoveFolderId] = useState('');

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

  const params = useMemo(() => {
    const next = new URLSearchParams();
    if (selectedMailboxId) next.set('mailbox_id', selectedMailboxId);
    if (selectedFolderId) next.set('folder_id', selectedFolderId);
    if (query.trim()) next.set('q', query.trim());
    return next.toString();
  }, [query, selectedFolderId, selectedMailboxId]);

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
    if (!selectedMailboxId) {
      setRules([]);
      setSelectedRuleId('');
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/email/rules?mailbox_id=${encodeURIComponent(selectedMailboxId)}`, {
        cache: 'no-store',
      });
      const payload = await res.json().catch(() => ({}));
      if (!cancelled && res.ok) {
        const nextRules = (payload.rules ?? []) as Rule[];
        setRules(nextRules);
        setSelectedRuleId((current) =>
          current && nextRules.some((rule) => rule.id === current)
            ? current
            : nextRules[0]?.id ?? '',
        );
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
    setMoveFolderId(
      visibleFolders.find((folder) => folder.id !== selectedMessage?.folder_id)?.id ?? '',
    );
  }, [selectedMessage?.folder_id, visibleFolders]);

  async function patchMessage(body: Record<string, unknown>) {
    if (!selectedMessage) return;
    const res = await fetch('/api/email/messages', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_id: selectedMessage.id, ...body }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload.error || 'No se pudo actualizar');
      return;
    }
    await load();
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

  function openNewMessage() {
    setCompose(emptyCompose);
    setComposeAttachments([]);
    setComposeOpen(true);
  }

  function openReply() {
    if (!selectedMessage) return;
    setCompose({
      to: selectedMessage.from_address,
      cc: '',
      subject: selectedMessage.subject.toLowerCase().startsWith('re:')
        ? selectedMessage.subject
        : `Re: ${selectedMessage.subject}`,
      text: '',
      inReplyToMessageId: selectedMessage.id,
    });
    setComposeAttachments([]);
    setComposeOpen(true);
  }

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
          subject: compose.subject,
          text: compose.text,
          in_reply_to_message_id: compose.inReplyToMessageId,
          attachments: composeAttachments,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'No se pudo enviar');
      toast.success(compose.inReplyToMessageId ? 'Respuesta enviada' : 'Correo enviado');
      setComposeOpen(false);
      setCompose(emptyCompose);
      setComposeAttachments([]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo enviar');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-7rem)] flex-col rounded-lg border border-border bg-background">
      <div className="flex min-h-14 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
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
        </div>
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[270px_minmax(320px,420px)_minmax(0,1fr)]">
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
          </div>
        </aside>

        <section className="min-w-0 border-b border-border bg-card lg:border-b-0 lg:border-r">
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
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span className="truncate">{selectedFolder?.name ?? 'Carpeta'} · {messages.length} correos</span>
              <span>{unreadCount} no leidos</span>
            </div>
          </div>
          <div className="max-h-[calc(100vh-15rem)] overflow-y-auto">
            {loading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="size-5 animate-spin text-primary" />
              </div>
            ) : messages.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">No hay correos en esta vista.</div>
            ) : (
              messages.map((message) => (
                <button
                  key={message.id}
                  type="button"
                  onClick={() => setSelectedMessageId(message.id)}
                  className={cn(
                    'grid w-full grid-cols-[auto_minmax(0,1fr)] gap-2 border-b border-border p-3 text-left transition-colors hover:bg-muted/60',
                    selectedMessage?.id === message.id && 'bg-muted',
                  )}
                >
                  <span className={cn('mt-1 size-2 rounded-full', message.is_read ? 'bg-transparent' : 'bg-primary')} />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className={cn('truncate text-sm', !message.is_read && 'font-semibold')}>
                        {message.from_name || message.from_address}
                      </span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">{formatDate(message.received_at)}</span>
                    </span>
                    <span className={cn('mt-1 flex items-center gap-1 truncate text-sm', !message.is_read && 'font-semibold')}>
                      {message.has_attachments ? <Paperclip className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                      <span className="truncate">{message.subject || '(Sin asunto)'}</span>
                    </span>
                    <span className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{message.snippet}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </section>

        <main className="relative min-w-0 bg-card">
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
                    <Button variant="outline" size="sm" onClick={openReply} disabled={!selectedMailbox?.can_send}>
                      <Reply className="size-4" />
                      Responder
                    </Button>
                    <Button variant="ghost" size="icon-sm" title="Mas acciones">
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </div>
                </div>

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
                    srcDoc={selectedMessage.body_html}
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
                  value={compose.subject}
                  onChange={(event) => setCompose((current) => ({ ...current, subject: event.target.value }))}
                  placeholder="Asunto"
                />
              </div>
              <Textarea
                value={compose.text}
                onChange={(event) => setCompose((current) => ({ ...current, text: event.target.value }))}
                placeholder="Escribe el mensaje"
                className="min-h-56 flex-1 rounded-none border-0 focus-visible:ring-0"
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
