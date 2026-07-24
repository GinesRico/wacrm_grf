'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Loader2, MessageCirclePlus, Search, UserRound } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { Contact } from '@/types';

const PREFIXES = [
  { value: '34', label: 'España (+34)' },
  { value: '1', label: 'EE. UU. / Canadá (+1)' },
  { value: '44', label: 'Reino Unido (+44)' },
  { value: '351', label: 'Portugal (+351)' },
  { value: '33', label: 'Francia (+33)' },
  { value: '49', label: 'Alemania (+49)' },
  { value: '39', label: 'Italia (+39)' },
  { value: '52', label: 'México (+52)' },
] as const;

const COUNTRY_PREFIXES = [
  { value: '34', label: 'España (+34)' },
  { value: '1', label: 'EE. UU. / Canadá (+1)' },
  { value: '44', label: 'Reino Unido (+44)' },
  { value: '351', label: 'Portugal (+351)' },
  { value: '33', label: 'Francia (+33)' },
  { value: '49', label: 'Alemania (+49)' },
  { value: '39', label: 'Italia (+39)' },
  { value: '52', label: 'México (+52)' },
  { value: '54', label: 'Argentina (+54)' },
  { value: '55', label: 'Brasil (+55)' },
  { value: '56', label: 'Chile (+56)' },
  { value: '57', label: 'Colombia (+57)' },
  { value: '51', label: 'Perú (+51)' },
  { value: '593', label: 'Ecuador (+593)' },
  { value: '598', label: 'Uruguay (+598)' },
  { value: '595', label: 'Paraguay (+595)' },
  { value: '591', label: 'Bolivia (+591)' },
  { value: '58', label: 'Venezuela (+58)' },
  { value: '507', label: 'Panamá (+507)' },
  { value: '506', label: 'Costa Rica (+506)' },
  { value: '503', label: 'El Salvador (+503)' },
  { value: '502', label: 'Guatemala (+502)' },
  { value: '504', label: 'Honduras (+504)' },
  { value: '505', label: 'Nicaragua (+505)' },
  { value: '809', label: 'República Dominicana (+809)' },
  { value: '31', label: 'Países Bajos (+31)' },
  { value: '32', label: 'Bélgica (+32)' },
  { value: '41', label: 'Suiza (+41)' },
  { value: '43', label: 'Austria (+43)' },
  { value: '353', label: 'Irlanda (+353)' },
  { value: '45', label: 'Dinamarca (+45)' },
  { value: '46', label: 'Suecia (+46)' },
  { value: '47', label: 'Noruega (+47)' },
  { value: '358', label: 'Finlandia (+358)' },
  { value: '48', label: 'Polonia (+48)' },
  { value: '420', label: 'Chequia (+420)' },
  { value: '40', label: 'Rumanía (+40)' },
  { value: '30', label: 'Grecia (+30)' },
  { value: '90', label: 'Turquía (+90)' },
  { value: '212', label: 'Marruecos (+212)' },
  { value: '213', label: 'Argelia (+213)' },
  ...PREFIXES.filter(() => false),
] as const;

interface WhatsAppLine {
  id: string;
  label?: string | null;
  phone_number_id: string;
  display_phone_number?: string | null;
  status?: string | null;
  is_default?: boolean | null;
}

function prefixLabel(value: string): string {
  return (
    COUNTRY_PREFIXES.find((item) => item.value === value)?.label ?? `+${value}`
  );
}

function lineDisplayName(line: WhatsAppLine): string {
  return (
    line.label?.trim() ||
    line.display_phone_number?.trim() ||
    line.phone_number_id
  );
}

interface StartConversationButtonProps {
  onStarted: (conversationId: string) => void;
  disabled?: boolean;
}

export function StartConversationButton({
  onStarted,
  disabled,
}: StartConversationButtonProps) {
  const t = useTranslations('Inbox.startConversation');
  const [open, setOpen] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [lines, setLines] = useState<WhatsAppLine[]>([]);
  const [prefix, setPrefix] = useState('34');
  const [lineId, setLineId] = useState('');
  const [query, setQuery] = useState('');
  const [selectedContactId, setSelectedContactId] = useState<string | null>(
    null
  );

  const selectedContact = useMemo(
    () => contacts.find((c) => c.id === selectedContactId) ?? null,
    [contacts, selectedContactId]
  );
  const selectedLine = useMemo(
    () => lines.find((line) => line.id === lineId) ?? null,
    [lineId, lines]
  );

  const suggestions = useMemo(() => {
    return contacts.slice(0, 6);
  }, [contacts]);

  const loadContacts = useCallback(
    async (search: string, signal?: AbortSignal) => {
      setLoadingContacts(true);
      try {
        const params = new URLSearchParams({
          limit: '6',
          sort_by: 'name',
          sort_dir: 'asc',
        });
        const trimmed = search.trim();
        if (trimmed) params.set('search', trimmed);

        const res = await fetch(`/api/contacts?${params.toString()}`, {
          cache: 'no-store',
          signal,
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw payload;
        setContacts((payload.contacts ?? []) as Contact[]);
      } catch (error) {
        if ((error as { name?: string })?.name === 'AbortError') return;
        console.error('[start-conversation] contacts search error:', error);
        toast.error(t('loadFailed'));
      } finally {
        if (!signal?.aborted) setLoadingContacts(false);
      }
    },
    [t]
  );

  const loadData = useCallback(async () => {
    setLoadingData(true);
    try {
      const linesRes = await fetch('/api/inbox/transfer-options', {
        cache: 'no-store',
      });
      const linesPayload = await linesRes.json().catch(() => ({}));

      if (!linesRes.ok) throw linesPayload;

      const nextLines = (linesPayload.lines ?? []) as WhatsAppLine[];
      setLines(nextLines);
      setLineId((current) => current || nextLines[0]?.id || '');
    } catch (error) {
      console.error('[start-conversation] load error:', error);
      toast.error(t('loadFailed'));
    } finally {
      setLoadingData(false);
    }
  }, [t]);

  useEffect(() => {
    if (open) void loadData();
  }, [open, loadData]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void loadContacts(query, controller.signal);
    }, 180);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, loadContacts]);

  function resetDraft() {
    setQuery('');
    setSelectedContactId(null);
  }

  function buildPhone() {
    const raw = query.trim();
    if (!raw) return '';
    if (raw.startsWith('+')) return raw;
    const digits = raw.replace(/\D/g, '');
    if (!digits) return '';
    return `+${prefix}${digits}`;
  }

  const canSubmit =
    !!lineId && (!!selectedContactId || query.replace(/\D/g, '').length >= 6);

  async function handleSubmit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/inbox/start-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          whatsapp_config_id: lineId,
          contact_id: selectedContactId,
          phone: selectedContact ? undefined : buildPhone(),
          name: selectedContact ? undefined : query.trim(),
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload?.error ?? t('failed'));
        return;
      }
      const conversationId = payload?.conversation_id;
      if (typeof conversationId !== 'string') {
        toast.error(t('failed'));
        return;
      }
      setOpen(false);
      resetDraft();
      onStarted(conversationId);
    } catch (error) {
      console.error('[start-conversation] submit error:', error);
      toast.error(t('failed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        size="icon"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="shadow-primary/20 absolute bottom-5 left-5 z-20 size-13 rounded-full shadow-lg"
        aria-label={t('open')}
        title={t('open')}
      >
        <MessageCirclePlus className="size-5" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="gap-0 p-0 sm:max-w-[430px]">
          <DialogHeader className="border-border border-b px-5 py-4">
            <DialogTitle>{t('title')}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 px-5 py-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('prefix')}>
                <Select
                  value={prefix}
                  onValueChange={(value) => {
                    if (value) setPrefix(value);
                  }}
                >
                  <SelectTrigger className="bg-background h-10 w-full">
                    <span className="min-w-0 flex-1 truncate text-left">
                      {prefixLabel(prefix)}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {COUNTRY_PREFIXES.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label={t('line')}>
                <Select
                  value={lineId}
                  onValueChange={(value) => {
                    setLineId(value ?? '');
                  }}
                >
                  <SelectTrigger className="bg-background h-10 w-full">
                    <span className="min-w-0 flex-1 truncate text-left">
                      {selectedLine
                        ? lineDisplayName(selectedLine)
                        : t('noLine')}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {lines.map((line) => (
                      <SelectItem key={line.id} value={line.id}>
                        {lineDisplayName(line)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <div>
              <label className="text-primary mb-1.5 block text-xs font-medium">
                {t('searchLabel')}
              </label>
              <div className="relative">
                <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                <Input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setSelectedContactId(null);
                  }}
                  placeholder={t('searchPlaceholder')}
                  className="border-primary/60 bg-background h-12 pl-9"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void handleSubmit();
                    }
                  }}
                />
              </div>
            </div>

            {loadingData || loadingContacts ? (
              <div className="text-muted-foreground flex items-center justify-center py-5 text-sm">
                <Loader2 className="mr-2 size-4 animate-spin" />
                {t('loading')}
              </div>
            ) : suggestions.length > 0 && query.trim() ? (
              <div className="border-border bg-card max-h-48 overflow-y-auto rounded-lg border p-1">
                {suggestions.map((contact) => (
                  <button
                    key={contact.id}
                    type="button"
                    onClick={() => {
                      setSelectedContactId(contact.id);
                      setQuery(contact.name || contact.phone);
                    }}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors',
                      selectedContactId === contact.id
                        ? 'bg-primary/10 text-primary'
                        : 'hover:bg-muted'
                    )}
                  >
                    <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-full">
                      <UserRound className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {contact.name || contact.phone}
                      </span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {contact.phone}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}

            {!lineId && !loadingData ? (
              <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
                {t('lineRequired')}
              </p>
            ) : null}
          </div>

          <DialogFooter className="px-5">
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              {t('cancel')}
            </Button>
            <Button onClick={handleSubmit} disabled={!canSubmit || submitting}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              {t('submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-muted-foreground mb-1 block text-xs">{label}</span>
      {children}
    </label>
  );
}
