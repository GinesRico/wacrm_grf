'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Workflow,
  Plus,
  Trash2,
  Pencil,
  Loader2,
  MessageSquare,
  PlayCircle,
  PauseCircle,
  Archive,
  HelpCircle,
  UserPlus,
  FileText,
  Send,
} from 'lucide-react';

import { useTranslations } from 'next-intl';
import { useCan } from '@/hooks/use-can';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { GatedButton } from '@/components/ui/gated-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useAppConfirm } from '@/hooks/use-app-dialog';
import {
  subscribeRealtimeChannel,
  unsubscribeRealtimeChannel,
} from '@/lib/realtime/soketi-client';

/**
 * Flows list page.
 *
 * Open to every authenticated user. Flows is in soft-GA — the "Beta"
 * chip in the header is the only remaining signal that the surface
 * is new. The previous per-account beta gate was removed in PR #134.
 */

interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'archived';
  trigger_type: 'keyword' | 'first_inbound_message' | 'manual';
  trigger_config: { keywords?: string[] } | Record<string, unknown>;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MetaFlowRow {
  id: string;
  slug: string;
  flow_id: string;
  title: string;
  body_text: string;
  footer_text: string | null;
  button_text: string;
  initial_screen: string;
  active: boolean;
}

interface MetaFlowDraft {
  slug: string;
  flow_id: string;
  title: string;
  body_text: string;
  footer_text: string;
  button_text: string;
  initial_screen: string;
  active: boolean;
}

const STATUS_LABELS = (
  t: ReturnType<typeof useTranslations>
): Record<FlowRow['status'], string> => ({
  draft: t('statusDraft'),
  active: t('statusActive'),
  archived: t('statusArchived'),
});

const STATUS_COLORS: Record<FlowRow['status'], string> = {
  draft: 'border-border bg-muted text-muted-foreground',
  active: 'border-emerald-600/40 bg-emerald-500/10 text-emerald-300',
  archived: 'border-border bg-muted/50 text-muted-foreground',
};

interface TemplateSummary {
  slug: string;
  name: string;
  description: string;
  icon: 'MessageSquare' | 'HelpCircle' | 'UserPlus';
  trigger_type: string;
  node_count: number;
}

const TEMPLATE_ICONS = {
  MessageSquare,
  HelpCircle,
  UserPlus,
} as const;

const EMPTY_META_FLOW: MetaFlowDraft = {
  slug: 'citas',
  flow_id: '',
  title: 'Reservar cita',
  body_text: 'Abre el formulario para elegir servicio, fecha y hora.',
  footer_text: 'Autorecambios Vera',
  button_text: 'Reservar cita',
  initial_screen: 'APPOINTMENT',
  active: true,
};

export default function FlowsPage() {
  const router = useRouter();
  const canCreate = useCan('edit-settings');
  const { accountId, profileLoading } = useAuth();
  const t = useTranslations('Flows.list');
  const { confirm, confirmDialog } = useAppConfirm();
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [metaFlows, setMetaFlows] = useState<MetaFlowRow[]>([]);
  const [metaFlowOpen, setMetaFlowOpen] = useState(false);
  const [editingMetaFlowId, setEditingMetaFlowId] = useState<string | null>(
    null
  );
  const [metaFlowDraft, setMetaFlowDraft] =
    useState<MetaFlowDraft>(EMPTY_META_FLOW);
  const [savingMetaFlow, setSavingMetaFlow] = useState(false);

  const load = useCallback(async () => {
    let cancelled = false;
    (async () => {
      try {
        const [flowsRes, tmplRes, metaFlowsRes] = await Promise.all([
          fetch('/api/flows'),
          fetch('/api/flows/templates'),
          fetch('/api/whatsapp/meta-flows'),
        ]);
        if (!flowsRes.ok) {
          throw new Error(`Failed to load flows: ${flowsRes.status}`);
        }
        const flowsJson = (await flowsRes.json()) as { flows: FlowRow[] };
        if (!cancelled) setFlows(flowsJson.flows ?? []);
        // Templates endpoint is forward-looking — if it 404s on an
        // older deployment, gracefully fall through.
        if (tmplRes.ok) {
          const tmplJson = (await tmplRes.json()) as {
            templates: TemplateSummary[];
          };
          if (!cancelled) setTemplates(tmplJson.templates ?? []);
        }
        if (metaFlowsRes.ok) {
          const metaJson = (await metaFlowsRes.json()) as {
            flows: MetaFlowRow[];
          };
          if (!cancelled) setMetaFlows(metaJson.flows ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          toast.error(t('loadError'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!accountId) return;

    const channelName = `private-account-${accountId}`;
    const channel = subscribeRealtimeChannel(channelName);
    const refresh = () => void load();

    channel.bind('flow.created', refresh);
    channel.bind('flow.updated', refresh);
    channel.bind('flow.deleted', refresh);
    channel.bind('whatsapp_meta_flow.created', refresh);
    channel.bind('whatsapp_meta_flow.updated', refresh);
    channel.bind('whatsapp_meta_flow.deleted', refresh);

    return () => {
      channel.unbind('flow.created', refresh);
      channel.unbind('flow.updated', refresh);
      channel.unbind('flow.deleted', refresh);
      channel.unbind('whatsapp_meta_flow.created', refresh);
      channel.unbind('whatsapp_meta_flow.updated', refresh);
      channel.unbind('whatsapp_meta_flow.deleted', refresh);
      unsubscribeRealtimeChannel(channelName);
    };
  }, [accountId, load]);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          trigger_type: 'keyword',
          trigger_config: { keywords: [] },
        }),
      });
      if (!res.ok) throw new Error(`Create failed: ${res.status}`);
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      setNewName('');
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      console.error(err);
      toast.error(t('createError'));
    } finally {
      setCreating(false);
    }
  }

  async function handleUseTemplate(slug: string) {
    setCreating(true);
    try {
      const res = await fetch('/api/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_slug: slug }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `Clone failed: ${res.status}`);
      }
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('cloneError');
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(flow: FlowRow) {
    const yes = await confirm({
      title: t('delete'),
      description: t('deleteConfirm', { name: flow.name }),
      confirmLabel: t('delete'),
      cancelLabel: t('cancel'),
      destructive: true,
    });
    if (!yes) return;
    try {
      const res = await fetch(`/api/flows/${flow.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      setFlows((prev) => prev.filter((f) => f.id !== flow.id));
      toast.success(t('deleteSuccess'));
    } catch (err) {
      console.error(err);
      toast.error(t('deleteError'));
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  function openNewMetaFlow() {
    setEditingMetaFlowId(null);
    setMetaFlowDraft(EMPTY_META_FLOW);
    setMetaFlowOpen(true);
  }

  function openEditMetaFlow(flow: MetaFlowRow) {
    setEditingMetaFlowId(flow.id);
    setMetaFlowDraft({
      slug: flow.slug,
      flow_id: flow.flow_id,
      title: flow.title,
      body_text: flow.body_text,
      footer_text: flow.footer_text ?? '',
      button_text: flow.button_text,
      initial_screen: flow.initial_screen,
      active: flow.active,
    });
    setMetaFlowOpen(true);
  }

  async function saveMetaFlow() {
    setSavingMetaFlow(true);
    try {
      const res = await fetch(
        editingMetaFlowId
          ? `/api/whatsapp/meta-flows/${editingMetaFlowId}`
          : '/api/whatsapp/meta-flows',
        {
          method: editingMetaFlowId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(metaFlowDraft),
        }
      );
      const json = (await res.json().catch(() => ({}))) as {
        flow?: MetaFlowRow;
        error?: string;
      };
      if (!res.ok || !json.flow) {
        throw new Error(json.error ?? `Save failed: ${res.status}`);
      }
      setMetaFlows((prev) =>
        editingMetaFlowId
          ? prev.map((flow) => (flow.id === json.flow!.id ? json.flow! : flow))
          : [json.flow!, ...prev]
      );
      setMetaFlowOpen(false);
      toast.success(t('metaSaveSuccess'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('metaSaveError'));
    } finally {
      setSavingMetaFlow(false);
    }
  }

  async function deleteMetaFlow(flow: MetaFlowRow) {
    const yes = await confirm({
      title: t('metaDelete'),
      description: t('metaDeleteConfirm', { name: flow.title }),
      confirmLabel: t('delete'),
      cancelLabel: t('cancel'),
      destructive: true,
    });
    if (!yes) return;
    try {
      const res = await fetch(`/api/whatsapp/meta-flows/${flow.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      setMetaFlows((prev) => prev.filter((item) => item.id !== flow.id));
      toast.success(t('metaDeleteSuccess'));
    } catch {
      toast.error(t('metaDeleteError'));
    }
  }

  if (!profileLoading && !canCreate) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <div>
          <h1 className="text-foreground text-base font-medium">
            {t('title')}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            This section is only available to account admins.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {confirmDialog}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-foreground text-2xl font-semibold">
              {t('title')}
            </h1>
            <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-amber-300 uppercase">
              {t('beta')}
            </span>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('description')}
          </p>
        </div>
        <GatedButton
          canAct={canCreate}
          gateReason="create flows"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4" />
          {t('newFlow')}
        </GatedButton>
      </header>

      <section className="border-border bg-card space-y-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-foreground text-base font-semibold">
              {t('metaTitle')}
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              {t('metaDescription')}
            </p>
          </div>
          <GatedButton
            canAct={canCreate}
            gateReason="manage Meta flows"
            onClick={openNewMetaFlow}
          >
            <Plus className="h-4 w-4" />
            {t('metaNew')}
          </GatedButton>
        </div>

        {metaFlows.length === 0 ? (
          <div className="border-border text-muted-foreground rounded-md border border-dashed px-4 py-6 text-sm">
            {t('metaEmpty')}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {metaFlows.map((flow) => (
              <MetaFlowCard
                key={flow.id}
                flow={flow}
                onEdit={() => openEditMetaFlow(flow)}
                onDelete={() => deleteMetaFlow(flow)}
                t={t}
              />
            ))}
          </div>
        )}
      </section>

      {flows.length === 0 ? (
        <EmptyState
          onCreate={() => setCreateOpen(true)}
          canCreate={canCreate}
          t={t}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {flows.map((flow) => (
            <FlowCard
              key={flow.id}
              flow={flow}
              onEdit={() => router.push(`/flows/${flow.id}`)}
              onDelete={() => handleDelete(flow)}
              t={t}
            />
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        {/* `sm:max-w-4xl` not `max-w-4xl` — shadcn's DialogContent has
            `sm:max-w-sm` baked into its default classes. Without the
            sm: prefix our override applies at base only and the
            sm-scoped 384px wins at every real desktop breakpoint. */}
        <DialogContent className="bg-popover text-popover-foreground sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t('createTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('createDesc')}
            </DialogDescription>
          </DialogHeader>

          {templates.length > 0 && (
            <div className="space-y-3">
              <p className="text-muted-foreground text-xs tracking-wide uppercase">
                {t('startTemplate')}
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {templates.map((template) => {
                  const Icon = TEMPLATE_ICONS[template.icon] ?? FileText;
                  const templateName = t(
                    `templates.${template.slug}.name` as Parameters<typeof t>[0]
                  );
                  const templateDescription = t(
                    `templates.${template.slug}.description` as Parameters<
                      typeof t
                    >[0]
                  );
                  return (
                    <button
                      key={template.slug}
                      type="button"
                      onClick={() => handleUseTemplate(template.slug)}
                      disabled={creating}
                      className="border-border bg-background hover:border-primary/40 hover:bg-muted flex flex-col gap-2.5 rounded-lg border p-4 text-left transition-colors disabled:opacity-50"
                    >
                      <Icon className="text-primary h-5 w-5" />
                      <span className="text-popover-foreground text-sm font-semibold">
                        {templateName}
                      </span>
                      <span className="text-muted-foreground text-xs leading-relaxed">
                        {templateDescription}
                      </span>
                      <span className="border-border text-muted-foreground mt-auto border-t pt-2 text-[11px]">
                        {t('nodeCount', { count: template.node_count })}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="border-border space-y-2 border-t pt-4">
            <p className="text-muted-foreground text-xs tracking-wide uppercase">
              {t('startBlank')}
            </p>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('placeholderName')}
              className="bg-muted"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
              }}
            />
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!newName.trim() || creating}
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('createBlank')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={metaFlowOpen} onOpenChange={setMetaFlowOpen}>
        <DialogContent className="bg-popover text-popover-foreground sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingMetaFlowId ? t('metaEditTitle') : t('metaCreateTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('metaCreateDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <MetaFlowField
              label={t('metaSlug')}
              value={metaFlowDraft.slug}
              onChange={(value) =>
                setMetaFlowDraft((draft) => ({ ...draft, slug: value }))
              }
            />
            <MetaFlowField
              label={t('metaFlowId')}
              value={metaFlowDraft.flow_id}
              onChange={(value) =>
                setMetaFlowDraft((draft) => ({ ...draft, flow_id: value }))
              }
            />
            <MetaFlowField
              label={t('metaTitleLabel')}
              value={metaFlowDraft.title}
              onChange={(value) =>
                setMetaFlowDraft((draft) => ({ ...draft, title: value }))
              }
            />
            <MetaFlowField
              label={t('metaButtonText')}
              value={metaFlowDraft.button_text}
              maxLength={20}
              onChange={(value) =>
                setMetaFlowDraft((draft) => ({ ...draft, button_text: value }))
              }
            />
            <MetaFlowField
              label={t('metaInitialScreen')}
              value={metaFlowDraft.initial_screen}
              onChange={(value) =>
                setMetaFlowDraft((draft) => ({
                  ...draft,
                  initial_screen: value,
                }))
              }
            />
            <MetaFlowField
              label={t('metaFooterText')}
              value={metaFlowDraft.footer_text}
              onChange={(value) =>
                setMetaFlowDraft((draft) => ({ ...draft, footer_text: value }))
              }
            />
            <div className="space-y-1.5 sm:col-span-2">
              <label className="text-muted-foreground text-xs font-medium">
                {t('metaBodyText')}
              </label>
              <textarea
                value={metaFlowDraft.body_text}
                onChange={(event) =>
                  setMetaFlowDraft((draft) => ({
                    ...draft,
                    body_text: event.target.value,
                  }))
                }
                rows={3}
                className="border-input bg-muted text-foreground focus:border-primary/50 min-h-24 w-full resize-y rounded-md border px-3 py-2 text-sm outline-none"
              />
            </div>
            <label className="text-foreground flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={metaFlowDraft.active}
                onChange={(event) =>
                  setMetaFlowDraft((draft) => ({
                    ...draft,
                    active: event.target.checked,
                  }))
                }
                className="border-border text-primary focus:ring-primary h-4 w-4 rounded"
              />
              {t('metaActive')}
            </label>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setMetaFlowOpen(false)}
              disabled={savingMetaFlow}
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={saveMetaFlow}
              disabled={
                savingMetaFlow ||
                !metaFlowDraft.slug.trim() ||
                !metaFlowDraft.flow_id.trim() ||
                !metaFlowDraft.title.trim() ||
                !metaFlowDraft.body_text.trim() ||
                !metaFlowDraft.button_text.trim()
              }
            >
              {savingMetaFlow ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MetaFlowField({
  label,
  value,
  onChange,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-muted-foreground text-xs font-medium">
        {label}
      </label>
      <Input
        value={value}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        className="bg-muted"
      />
    </div>
  );
}

function MetaFlowCard({
  flow,
  onEdit,
  onDelete,
  t,
}: {
  flow: MetaFlowRow;
  onEdit: () => void;
  onDelete: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="border-border bg-background rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Send className="text-primary h-4 w-4 shrink-0" />
            <h3 className="text-foreground truncate text-sm font-semibold">
              {flow.title}
            </h3>
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            {flow.slug} · {flow.initial_screen}
          </p>
        </div>
        <Badge
          variant="outline"
          className={cn(
            'shrink-0 text-[10px]',
            flow.active
              ? 'border-emerald-600/40 bg-emerald-500/10 text-emerald-300'
              : 'border-border bg-muted text-muted-foreground'
          )}
        >
          {flow.active ? t('metaActiveStatus') : t('metaInactiveStatus')}
        </Badge>
      </div>
      <p className="text-muted-foreground mt-3 line-clamp-2 text-xs">
        {flow.body_text}
      </p>
      <div className="border-border mt-3 flex items-center justify-between gap-3 border-t pt-3">
        <span className="bg-muted text-muted-foreground max-w-40 truncate rounded-md px-2 py-1 text-xs">
          {flow.button_text}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
            {t('edit')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('delete')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  onCreate,
  canCreate,
  t,
}: {
  onCreate: () => void;
  canCreate: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="border-border bg-card/50 flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-16 text-center">
      <div className="bg-muted flex h-14 w-14 items-center justify-center rounded-full">
        <Workflow className="text-muted-foreground h-6 w-6" />
      </div>
      <h2 className="text-foreground mt-4 text-base font-medium">
        {t('emptyTitle')}
      </h2>
      <p className="text-muted-foreground mt-1 max-w-md text-sm">
        {t('emptyDesc')}
      </p>
      <GatedButton
        canAct={canCreate}
        gateReason="create flows"
        onClick={onCreate}
        className="mt-5"
      >
        <Plus className="h-4 w-4" />
        {t('createFirst')}
      </GatedButton>
    </div>
  );
}

function FlowCard({
  flow,
  onEdit,
  onDelete,
  t,
}: {
  flow: FlowRow;
  onEdit: () => void;
  onDelete: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const triggerSummary = describeTrigger(flow, t);
  const StatusIcon =
    flow.status === 'active'
      ? PlayCircle
      : flow.status === 'archived'
        ? Archive
        : PauseCircle;
  return (
    <div className="border-border bg-card hover:border-border flex flex-col rounded-lg border p-4 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Workflow className="text-primary h-4 w-4 shrink-0" />
          <h3 className="text-foreground truncate text-sm font-semibold">
            {flow.name}
          </h3>
        </div>
        <Badge
          variant="outline"
          className={cn(
            'shrink-0 gap-1 text-[10px]',
            STATUS_COLORS[flow.status]
          )}
        >
          <StatusIcon className="h-3 w-3" />
          {STATUS_LABELS(t)[flow.status]}
        </Badge>
      </div>

      <p className="text-muted-foreground mt-2 line-clamp-2 text-xs">
        {flow.description || triggerSummary}
      </p>

      <div className="text-muted-foreground mt-4 flex items-center gap-3 text-[11px]">
        <span className="inline-flex items-center gap-1">
          <MessageSquare className="h-3 w-3" />
          {t('runCount', { count: flow.execution_count })}
        </span>
      </div>

      <div className="border-border mt-4 flex items-center justify-end gap-2 border-t pt-3">
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
          {t('edit')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t('delete')}
        </Button>
      </div>
    </div>
  );
}

function describeTrigger(
  flow: FlowRow,
  t: ReturnType<typeof useTranslations>
): string {
  if (flow.trigger_type === 'keyword') {
    const keywords = Array.isArray(flow.trigger_config.keywords)
      ? (flow.trigger_config.keywords as string[])
      : [];
    if (keywords.length === 0) return t('triggerKeywordNone');
    return t('triggerKeyword', { keywords: keywords.join(', ') });
  }
  if (flow.trigger_type === 'first_inbound_message') {
    return t('triggerFirstInbound');
  }
  return t('triggerManual');
}
