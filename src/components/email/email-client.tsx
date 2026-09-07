'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, Inbox, Loader2, Mail, MailOpen, RefreshCw, Reply, Search, Send } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  const [replyText, setReplyText] = useState('');

  const selectedMessage = messages.find((message) => message.id === selectedMessageId) ?? messages[0] ?? null;
  const selectedMailbox = mailboxes.find((mailbox) => mailbox.id === selectedMailboxId) ?? mailboxes[0] ?? null;
  const visibleFolders = folders
    .filter((folder) => folder.mailbox_id === selectedMailbox?.id)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

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
      setMailboxes(payload.mailboxes ?? []);
      setFolders(payload.folders ?? []);
      setMessages(payload.messages ?? []);
      const nextMailbox = selectedMailboxId ?? payload.mailboxes?.[0]?.id ?? null;
      setSelectedMailboxId(nextMailbox);
      if (!selectedFolderId && nextMailbox) {
        const inbox = payload.folders?.find((folder) => folder.mailbox_id === nextMailbox && folder.kind === 'inbox');
        setSelectedFolderId(inbox?.id ?? payload.folders?.find((folder) => folder.mailbox_id === nextMailbox)?.id ?? null);
      }
      setSelectedMessageId((current) =>
        current && payload.messages?.some((message) => message.id === current)
          ? current
          : payload.messages?.[0]?.id ?? null,
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

  async function sendReply() {
    if (!selectedMessage || !selectedMailbox || !replyText.trim()) return;
    setSending(true);
    try {
      const res = await fetch('/api/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mailbox_id: selectedMailbox.id,
          to: [selectedMessage.from_address],
          subject: selectedMessage.subject.startsWith('Re:') ? selectedMessage.subject : `Re: ${selectedMessage.subject}`,
          text: replyText,
          in_reply_to_message_id: selectedMessage.id,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'No se pudo enviar');
      setReplyText('');
      toast.success('Respuesta enviada');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo enviar');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="grid min-h-[calc(100vh-7rem)] gap-4 lg:grid-cols-[240px_minmax(280px,380px)_minmax(0,1fr)]">
      <aside className="min-w-0 rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border p-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Mail className="size-4 text-primary" />
            Email
          </div>
          <Button size="icon-sm" variant="outline" onClick={sync} disabled={syncing} title="Sincronizar">
            {syncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </Button>
        </div>
        <div className="space-y-3 p-3">
          {mailboxes.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
              No tienes buzones de correo asignados.
            </div>
          ) : (
            mailboxes.map((mailbox) => (
              <button
                key={mailbox.id}
                type="button"
                onClick={() => {
                  setSelectedMailboxId(mailbox.id);
                  const inbox = folders.find((folder) => folder.mailbox_id === mailbox.id && folder.kind === 'inbox');
                  setSelectedFolderId(inbox?.id ?? null);
                }}
                className={cn(
                  'w-full rounded-md px-2 py-2 text-left text-sm transition-colors',
                  selectedMailbox?.id === mailbox.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
                )}
              >
                <span className="block truncate font-medium">{mailbox.display_name || mailbox.address}</span>
                <span className="block truncate text-xs text-muted-foreground">{mailbox.address}</span>
              </button>
            ))
          )}

          <div className="border-t border-border pt-3">
            {visibleFolders.map((folder) => (
              <button
                key={folder.id}
                type="button"
                onClick={() => setSelectedFolderId(folder.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                  selectedFolderId === folder.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {folder.kind === 'inbox' ? <Inbox className="size-4" /> : <Archive className="size-4" />}
                <span className="truncate">{folder.name}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <section className="min-w-0 rounded-lg border border-border bg-card">
        <div className="border-b border-border p-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar correo" className="pl-8" />
          </div>
        </div>
        <div className="max-h-[calc(100vh-11rem)] overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          ) : messages.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">No hay correos en esta vista.</div>
          ) : (
            messages.map((message) => (
              <button
                key={message.id}
                type="button"
                onClick={() => setSelectedMessageId(message.id)}
                className={cn(
                  'block w-full border-b border-border p-3 text-left transition-colors hover:bg-muted/60',
                  selectedMessage?.id === message.id && 'bg-muted',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className={cn('truncate text-sm', !message.is_read && 'font-semibold')}>
                    {message.from_name || message.from_address}
                  </span>
                  {!message.is_read && <span className="ml-auto size-2 rounded-full bg-primary" />}
                </div>
                <p className={cn('mt-1 truncate text-sm', !message.is_read && 'font-semibold')}>{message.subject}</p>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{message.snippet}</p>
              </button>
            ))
          )}
        </div>
      </section>

      <main className="min-w-0 rounded-lg border border-border bg-card">
        {selectedMessage ? (
          <div className="flex h-full min-h-[520px] flex-col">
            <div className="border-b border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h1 className="min-w-0 truncate text-lg font-semibold">{selectedMessage.subject}</h1>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => patchMessage({ is_read: !selectedMessage.is_read })}>
                    {selectedMessage.is_read ? <Mail className="size-4" /> : <MailOpen className="size-4" />}
                    {selectedMessage.is_read ? 'No leido' : 'Leido'}
                  </Button>
                  {visibleFolders
                    .filter((folder) => folder.id !== selectedMessage.folder_id)
                    .slice(0, 1)
                    .map((folder) => (
                      <Button key={folder.id} variant="outline" size="sm" onClick={() => patchMessage({ folder_id: folder.id })}>
                        <Archive className="size-4" />
                        Mover a {folder.name}
                      </Button>
                    ))}
                </div>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {selectedMessage.from_name ? `${selectedMessage.from_name} <${selectedMessage.from_address}>` : selectedMessage.from_address}
              </p>
              <p className="text-xs text-muted-foreground">
                Para {selectedMessage.to_addresses.join(', ') || selectedMailbox?.address} · {new Date(selectedMessage.received_at).toLocaleString()}
              </p>
            </div>
            <article className="min-h-0 flex-1 overflow-y-auto p-4">
              {selectedMessage.body_html ? (
                <iframe
                  title="Contenido del correo"
                  sandbox=""
                  srcDoc={selectedMessage.body_html}
                  className="h-[420px] w-full rounded-md border border-border bg-background"
                />
              ) : (
                <pre className="whitespace-pre-wrap text-sm leading-6 text-foreground">{selectedMessage.body_text || selectedMessage.snippet}</pre>
              )}
            </article>
            <div className="border-t border-border p-4">
              <Label>Responder desde {selectedMailbox?.address}</Label>
              <Textarea value={replyText} onChange={(event) => setReplyText(event.target.value)} className="mt-2 min-h-24" />
              <div className="mt-3 flex justify-end">
                <Button onClick={sendReply} disabled={sending || !replyText.trim()}>
                  {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                  Enviar respuesta
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex min-h-[520px] flex-col items-center justify-center gap-2 text-muted-foreground">
            <Reply className="size-8" />
            <p className="text-sm">Selecciona un correo para leerlo.</p>
          </div>
        )}
      </main>
    </div>
  );
}
