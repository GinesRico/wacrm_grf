'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import {
  Archive,
  Edit2,
  Folder,
  FolderPlus,
  Inbox,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { SettingsPanelHead } from './settings-panel-head';

interface EmailAccountRow {
  id: string;
  label: string;
  email_address: string;
  imap_host: string;
  imap_port: number;
  imap_secure: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  sync_mailbox: string;
  enabled: boolean;
  status: string;
  last_error: string | null;
  last_synced_at: string | null;
}

interface MailboxRow {
  id: string;
  email_account_id: string;
  owner_user_id: string | null;
  address: string;
  display_name: string | null;
  kind: 'personal' | 'shared';
  can_send: boolean;
}

interface FolderRow {
  id: string;
  mailbox_id: string | null;
  name: string;
  slug: string;
  kind: 'inbox' | 'sent' | 'archive' | 'trash' | 'custom' | 'public';
}

interface PermissionRow {
  id: string;
  department_id?: string;
  user_id?: string;
  mailbox_id: string | null;
  folder_id: string | null;
  can_read: boolean;
  can_move: boolean;
  can_classify: boolean;
  can_send: boolean;
}

interface UserRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  role: string;
}

interface RuleRow {
  id: string;
  mailbox_id: string | null;
  target_folder_id: string;
  name: string;
  value: string;
  field: string;
  operator: string;
  enabled: boolean;
}

interface AuditRow {
  id: string;
  user_id: string | null;
  mailbox_id: string | null;
  folder_id: string | null;
  event_type: string;
  created_at: string;
  metadata: unknown;
}

interface AdminState {
  accounts: EmailAccountRow[];
  mailboxes: MailboxRow[];
  folders: FolderRow[];
  permissions: PermissionRow[];
  user_permissions: PermissionRow[];
  departments: Array<{ id: string; name: string; color: string }>;
  users: UserRow[];
  rules: RuleRow[];
  audit_events: AuditRow[];
}

type SectionId = 'mailboxes' | 'folders' | 'permissions' | 'rules' | 'audit';

const emptyState: AdminState = {
  accounts: [],
  mailboxes: [],
  folders: [],
  permissions: [],
  user_permissions: [],
  departments: [],
  users: [],
  rules: [],
  audit_events: [],
};

const sections: Array<{ id: SectionId; label: string }> = [
  { id: 'mailboxes', label: 'Buzones' },
  { id: 'folders', label: 'Carpetas' },
  { id: 'permissions', label: 'Permisos' },
  { id: 'rules', label: 'Reglas' },
  { id: 'audit', label: 'Auditoria' },
];

const defaultMailboxForm = {
  label: '',
  email_address: '',
  imap_host: 'imap.serviciodecorreo.es',
  imap_port: '993',
  imap_secure: true,
  imap_user: '',
  imap_password: '',
  smtp_host: 'smtp.serviciodecorreo.es',
  smtp_port: '465',
  smtp_secure: true,
  smtp_user: '',
  smtp_password: '',
  sync_mailbox: 'INBOX',
  mailbox_kind: 'shared',
  owner_user_id: '',
};

export function EmailAdminSettings() {
  const [state, setState] = useState<AdminState>(emptyState);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionId>('mailboxes');
  const [editorOpen, setEditorOpen] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [mailboxForm, setMailboxForm] = useState(defaultMailboxForm);
  const [selectedMailboxId, setSelectedMailboxId] = useState('');
  const [newInternalFolder, setNewInternalFolder] = useState('');
  const [newPublicFolder, setNewPublicFolder] = useState('');
  const [permissionDraft, setPermissionDraft] = useState({
    scope: 'user' as 'user' | 'department',
    user_id: '',
    department_id: '',
    target_type: 'mailbox' as 'mailbox' | 'folder',
    mailbox_id: '',
    folder_id: '',
    can_read: true,
    can_move: false,
    can_classify: false,
    can_send: false,
  });
  const [rulesSource, setRulesSource] = useState('');
  const [editingRuleId, setEditingRuleId] = useState('');
  const [savingRuleId, setSavingRuleId] = useState('');
  const [ruleMailboxFilter, setRuleMailboxFilter] = useState('');
  const [ruleEdits, setRuleEdits] = useState<Record<string, {
    name: string;
    field: string;
    operator: string;
    value: string;
    target_folder_id: string;
    enabled: boolean;
  }>>({});

  const selectedAccount = state.accounts.find((account) => account.id === selectedAccountId) ?? null;
  const selectedMailbox = state.mailboxes.find((mailbox) => mailbox.id === selectedMailboxId) ?? state.mailboxes[0] ?? null;
  const accountsById = useMemo(() => new Map(state.accounts.map((account) => [account.id, account])), [state.accounts]);
  const publicFolders = state.folders.filter((folder) => folder.kind === 'public' || folder.mailbox_id === null);
  const internalFolders = state.folders.filter((folder) => folder.mailbox_id === selectedMailbox?.id);
  const systemFolderCount = state.folders.filter((folder) => folder.kind !== 'custom' && folder.kind !== 'public').length;
  const permissionFolderTargets = state.folders.filter((folder) => folder.kind === 'public' || folder.kind === 'custom');
  const visibleRules = ruleMailboxFilter ? state.rules.filter((rule) => rule.mailbox_id === ruleMailboxFilter) : state.rules;

  const mailboxName = useCallback((mailboxId: string | null) => {
    if (!mailboxId) return 'Carpetas publicas';
    const mailbox = state.mailboxes.find((item) => item.id === mailboxId);
    return mailbox?.display_name || mailbox?.address || 'Buzon';
  }, [state.mailboxes]);

  const folderName = useCallback((folderId: string | null) => {
    if (!folderId) return 'Todo el buzon';
    return state.folders.find((item) => item.id === folderId)?.name ?? 'Carpeta';
  }, [state.folders]);

  const userName = useCallback((userId: string | undefined) => {
    const user = state.users.find((item) => item.user_id === userId);
    return user?.full_name || user?.email || userId || 'Usuario';
  }, [state.users]);

  const departmentName = useCallback((departmentId: string | undefined) => {
    return state.departments.find((item) => item.id === departmentId)?.name || departmentId || 'Grupo';
  }, [state.departments]);

  const ruleDraft = (rule: RuleRow) =>
    ruleEdits[rule.id] ?? {
      name: rule.name,
      field: rule.field,
      operator: rule.operator,
      value: rule.value,
      target_folder_id: rule.target_folder_id,
      enabled: rule.enabled,
    };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/email/admin', { cache: 'no-store' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'No se pudo cargar Email');
      const nextState: AdminState = { ...emptyState, ...payload };
      const nextPublicFolders = nextState.folders.filter((folder) => folder.kind === 'public' || folder.mailbox_id === null);
      setState(nextState);
      setSelectedMailboxId((current) =>
        current && nextState.mailboxes.some((mailbox) => mailbox.id === current)
          ? current
          : nextState.mailboxes[0]?.id ?? '',
      );
      setPermissionDraft((current) => ({
        ...current,
        user_id: current.user_id || nextState.users[0]?.user_id || '',
        department_id: current.department_id || nextState.departments[0]?.id || '',
        mailbox_id: current.mailbox_id || nextState.mailboxes[0]?.id || '',
        folder_id: current.folder_id || nextPublicFolders[0]?.id || '',
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo cargar Email');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: Record<string, unknown>, success: string) {
    setSaving(true);
    try {
      const res = await fetch('/api/email/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'No se pudo guardar');
      toast.success(success);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo guardar');
    } finally {
      setSaving(false);
    }
  }

  function openNewMailbox() {
    setSelectedAccountId('');
    setMailboxForm(defaultMailboxForm);
    setEditorOpen(true);
  }

  function openMailbox(account: EmailAccountRow) {
    const mailbox = state.mailboxes.find((item) => item.email_account_id === account.id);
    setSelectedAccountId(account.id);
    setMailboxForm({
      label: account.label,
      email_address: account.email_address,
      imap_host: account.imap_host,
      imap_port: String(account.imap_port),
      imap_secure: account.imap_secure,
      imap_user: '',
      imap_password: '',
      smtp_host: account.smtp_host,
      smtp_port: String(account.smtp_port),
      smtp_secure: account.smtp_secure,
      smtp_user: '',
      smtp_password: '',
      sync_mailbox: account.sync_mailbox,
      mailbox_kind: mailbox?.kind ?? 'shared',
      owner_user_id: mailbox?.owner_user_id ?? '',
    });
    setEditorOpen(true);
  }

  async function saveMailbox() {
    const body = {
      ...mailboxForm,
      imap_port: Number(mailboxForm.imap_port),
      smtp_port: Number(mailboxForm.smtp_port),
      owner_user_id: mailboxForm.mailbox_kind === 'personal' ? mailboxForm.owner_user_id || null : null,
    };
    if (selectedAccount) {
      await post({ action: 'update_account', email_account_id: selectedAccount.id, enabled: selectedAccount.enabled, ...body }, 'Buzon actualizado');
    } else {
      await post({ action: 'create_account', ...body }, 'Buzon creado');
    }
    setEditorOpen(false);
  }

  async function deleteMailbox(account: EmailAccountRow) {
    if (!window.confirm(`Borrar el buzon ${account.email_address}? Tambien se eliminaran sus correos importados.`)) return;
    await post({ action: 'delete_account', email_account_id: account.id }, 'Buzon borrado');
  }

  async function createInternalFolder() {
    if (!selectedMailbox || !newInternalFolder.trim()) return;
    await post({ action: 'create_folder', mailbox_id: selectedMailbox.id, name: newInternalFolder.trim() }, 'Carpeta interna creada');
    setNewInternalFolder('');
  }

  async function createPublicFolder() {
    if (!newPublicFolder.trim()) return;
    await post({ action: 'create_public_folder', name: newPublicFolder.trim() }, 'Carpeta publica creada');
    setNewPublicFolder('');
  }

  async function deleteFolder(folder: FolderRow) {
    if (!window.confirm(`Borrar la carpeta ${folder.name}? Los correos volveran a Entrada.`)) return;
    await post({ action: 'delete_folder', folder_id: folder.id }, 'Carpeta borrada');
  }

  async function savePermission() {
    const isFolderTarget = permissionDraft.target_type === 'folder';
    const folder = isFolderTarget ? state.folders.find((item) => item.id === permissionDraft.folder_id) : null;
    const mailboxId = isFolderTarget ? folder?.mailbox_id ?? null : permissionDraft.mailbox_id;
    const folderId = isFolderTarget ? permissionDraft.folder_id : null;
    await post(
      {
        action: permissionDraft.scope === 'user' ? 'grant_user_permission' : 'grant_permission',
        target_user_id: permissionDraft.scope === 'user' ? permissionDraft.user_id : undefined,
        department_id: permissionDraft.scope === 'department' ? permissionDraft.department_id : undefined,
        mailbox_id: mailboxId,
        folder_id: folderId,
        can_read: permissionDraft.can_read,
        can_move: permissionDraft.can_move,
        can_classify: permissionDraft.can_classify,
        can_send: permissionDraft.can_send,
      },
      'Permiso guardado',
    );
  }

  async function deletePermission(permission: PermissionRow, scope: 'user' | 'department') {
    await post({ action: 'delete_permission', permission_id: permission.id, scope }, 'Permiso revocado');
  }

  async function importRules() {
    const mailboxId = ruleMailboxFilter || selectedMailboxId;
    if (!mailboxId || !rulesSource.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/email/rules/import-thunderbird', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mailbox_id: mailboxId, source: rulesSource }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'No se pudieron importar reglas');
      toast.success(`${payload.imported ?? 0} reglas importadas`);
      setRulesSource('');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudieron importar reglas');
    } finally {
      setSaving(false);
    }
  }

  function startEditRule(rule: RuleRow) {
    setEditingRuleId(rule.id);
    setRuleEdits((current) => ({
      ...current,
      [rule.id]: {
        name: rule.name,
        field: rule.field,
        operator: rule.operator,
        value: rule.value,
        target_folder_id: rule.target_folder_id,
        enabled: rule.enabled,
      },
    }));
  }

  function updateRuleDraft(ruleId: string, patch: Partial<ReturnType<typeof ruleDraft>>) {
    const rule = state.rules.find((item) => item.id === ruleId);
    if (!rule) return;
    setRuleEdits((current) => ({ ...current, [ruleId]: { ...ruleDraft(rule), ...patch } }));
  }

  async function saveRule(rule: RuleRow) {
    const draft = ruleDraft(rule);
    if (!draft.name.trim() || !draft.value.trim() || !draft.target_folder_id) return;
    setSavingRuleId(rule.id);
    try {
      const res = await fetch('/api/email/rules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rule_id: rule.id,
          name: draft.name.trim(),
          field: draft.field,
          operator: draft.operator,
          value: draft.value.trim(),
          target_folder_id: draft.target_folder_id,
          enabled: draft.enabled,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'No se pudo actualizar la regla');
      toast.success('Regla actualizada');
      setEditingRuleId('');
      setRuleEdits((current) => {
        const next = { ...current };
        delete next[rule.id];
        return next;
      });
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo actualizar la regla');
    } finally {
      setSavingRuleId('');
    }
  }

  async function deleteRule(ruleId: string) {
    if (!window.confirm('Borrar esta regla?')) return;
    setSavingRuleId(ruleId);
    try {
      const res = await fetch(`/api/email/rules?rule_id=${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'No se pudo borrar la regla');
      toast.success('Regla borrada');
      if (editingRuleId === ruleId) setEditingRuleId('');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo borrar la regla');
    } finally {
      setSavingRuleId('');
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead
        title="Email compartido"
        description="Administra buzones, carpetas publicas, permisos, reglas e historial del webmail."
      />

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="outline">{state.mailboxes.length} buzones</Badge>
              <Badge variant="outline">{publicFolders.length} carpetas publicas</Badge>
              <Badge variant="outline">{state.permissions.length + state.user_permissions.length} permisos</Badge>
              <Badge variant="outline">{state.rules.filter((rule) => rule.enabled).length} reglas activas</Badge>
            </div>
            <Button size="sm" onClick={openNewMailbox}>
              <Plus className="size-4" />
              Nuevo buzon
            </Button>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-2 pt-2" aria-label="Secciones de Email">
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveSection(section.id)}
                className={cn(
                  'border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                  activeSection === section.id
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {section.label}
              </button>
            ))}
          </nav>
        </CardContent>
      </Card>

      {activeSection === 'mailboxes' && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle className="text-base">Buzones IMAP/SMTP</CardTitle>
            <Button size="sm" variant="outline" onClick={openNewMailbox}>
              <Plus className="size-4" />
              Crear
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {state.mailboxes.length === 0 ? (
              <EmptyLine icon={Mail} text="Aun no hay buzones configurados." />
            ) : (
              state.mailboxes.map((mailbox) => {
                const account = accountsById.get(mailbox.email_account_id);
                return (
                  <div key={mailbox.id} className="grid gap-3 rounded-md border border-border p-3 text-sm lg:grid-cols-[minmax(220px,1fr)_minmax(180px,260px)_auto] lg:items-center">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Mail className="size-4 text-primary" />
                        <span className="truncate font-medium">{mailbox.display_name || mailbox.address}</span>
                        <Badge variant={mailbox.kind === 'personal' ? 'secondary' : 'outline'}>{mailbox.kind === 'personal' ? 'Personal' : 'Compartido'}</Badge>
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">{mailbox.address}</p>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <div>{account?.imap_host}:{account?.imap_port} · {account?.status}</div>
                      <div>{account?.last_synced_at ? new Date(account.last_synced_at).toLocaleString() : 'Sin sincronizar'}</div>
                      {account?.last_error ? <div className="text-destructive">{account.last_error}</div> : null}
                    </div>
                    <div className="flex justify-end gap-1">
                      {account ? (
                        <>
                          <Button size="icon-sm" variant="ghost" onClick={() => openMailbox(account)} title="Editar buzon">
                            <Edit2 className="size-4" />
                          </Button>
                          <Button size="icon-sm" variant="ghost" onClick={() => deleteMailbox(account)} title="Borrar buzon">
                            <Trash2 className="size-4" />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      )}

      {activeSection === 'folders' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Carpetas internas por buzon</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <SelectLabel label="Buzon" value={selectedMailboxId} onChange={setSelectedMailboxId}>
                {state.mailboxes.map((mailbox) => (
                  <option key={mailbox.id} value={mailbox.id}>{mailbox.display_name || mailbox.address}</option>
                ))}
              </SelectLabel>
              <div className="flex gap-2">
                <Input value={newInternalFolder} onChange={(event) => setNewInternalFolder(event.target.value)} placeholder="Nueva carpeta interna" />
                <Button onClick={createInternalFolder} disabled={!selectedMailbox || !newInternalFolder.trim() || saving}>
                  <FolderPlus className="size-4" />
                  Crear
                </Button>
              </div>
              <FolderList folders={internalFolders} onDelete={deleteFolder} />
              <p className="text-xs text-muted-foreground">{systemFolderCount} carpetas de sistema protegidas.</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Carpetas publicas globales</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <Input value={newPublicFolder} onChange={(event) => setNewPublicFolder(event.target.value)} placeholder="Nueva carpeta publica" />
                <Button onClick={createPublicFolder} disabled={!newPublicFolder.trim() || saving}>
                  <FolderPlus className="size-4" />
                  Crear
                </Button>
              </div>
              <FolderList folders={publicFolders} onDelete={deleteFolder} />
            </CardContent>
          </Card>
        </div>
      )}

      {activeSection === 'permissions' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Permisos de acceso</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 rounded-md border border-border p-3 lg:grid-cols-4">
              <SelectLabel label="Asignar a" value={permissionDraft.scope} onChange={(value) => setPermissionDraft({ ...permissionDraft, scope: value as 'user' | 'department' })}>
                <option value="user">Usuario</option>
                <option value="department">Grupo/departamento</option>
              </SelectLabel>
              {permissionDraft.scope === 'user' ? (
                <SelectLabel label="Usuario" value={permissionDraft.user_id} onChange={(value) => setPermissionDraft({ ...permissionDraft, user_id: value })}>
                  {state.users.map((user) => (
                    <option key={user.user_id} value={user.user_id}>{user.full_name || user.email || user.user_id}</option>
                  ))}
                </SelectLabel>
              ) : (
                <SelectLabel label="Grupo" value={permissionDraft.department_id} onChange={(value) => setPermissionDraft({ ...permissionDraft, department_id: value })}>
                  {state.departments.map((department) => (
                    <option key={department.id} value={department.id}>{department.name}</option>
                  ))}
                </SelectLabel>
              )}
              <SelectLabel label="Destino" value={permissionDraft.target_type} onChange={(value) => setPermissionDraft({ ...permissionDraft, target_type: value as 'mailbox' | 'folder' })}>
                <option value="mailbox">Buzon completo</option>
                <option value="folder">Carpeta concreta</option>
              </SelectLabel>
              {permissionDraft.target_type === 'mailbox' ? (
                <SelectLabel label="Buzon" value={permissionDraft.mailbox_id} onChange={(value) => setPermissionDraft({ ...permissionDraft, mailbox_id: value })}>
                  {state.mailboxes.map((mailbox) => (
                    <option key={mailbox.id} value={mailbox.id}>{mailbox.display_name || mailbox.address}</option>
                  ))}
                </SelectLabel>
              ) : (
                <SelectLabel label="Carpeta" value={permissionDraft.folder_id} onChange={(value) => setPermissionDraft({ ...permissionDraft, folder_id: value })}>
                  {permissionFolderTargets.map((folder) => (
                    <option key={folder.id} value={folder.id}>{folder.name} · {mailboxName(folder.mailbox_id)}</option>
                  ))}
                </SelectLabel>
              )}
              <div className="flex flex-wrap items-center gap-4 lg:col-span-3">
                <PermissionSwitch label="Leer" checked={permissionDraft.can_read} onChange={(value) => setPermissionDraft({ ...permissionDraft, can_read: value })} />
                <PermissionSwitch label="Mover" checked={permissionDraft.can_move} onChange={(value) => setPermissionDraft({ ...permissionDraft, can_move: value })} />
                <PermissionSwitch label="Clasificar" checked={permissionDraft.can_classify} onChange={(value) => setPermissionDraft({ ...permissionDraft, can_classify: value })} />
                <PermissionSwitch label="Enviar" checked={permissionDraft.can_send} onChange={(value) => setPermissionDraft({ ...permissionDraft, can_send: value })} />
              </div>
              <div className="flex justify-end">
                <Button onClick={savePermission} disabled={saving}>
                  <ShieldCheck className="size-4" />
                  Guardar permiso
                </Button>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <PermissionList title="Usuarios" rows={state.user_permissions} owner={(row) => userName(row.user_id)} mailboxName={mailboxName} folderName={folderName} onDelete={(row) => deletePermission(row, 'user')} />
              <PermissionList title="Grupos" rows={state.permissions} owner={(row) => departmentName(row.department_id)} mailboxName={mailboxName} folderName={folderName} onDelete={(row) => deletePermission(row, 'department')} />
            </div>
          </CardContent>
        </Card>
      )}

      {activeSection === 'rules' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reglas Thunderbird</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <SelectLabel label="Buzon" value={ruleMailboxFilter} onChange={setRuleMailboxFilter}>
              <option value="">Todos los buzones</option>
              {state.mailboxes.map((mailbox) => (
                <option key={mailbox.id} value={mailbox.id}>{mailbox.display_name || mailbox.address}</option>
              ))}
            </SelectLabel>
            <Textarea value={rulesSource} onChange={(event) => setRulesSource(event.target.value)} className="min-h-32 font-mono text-xs" placeholder="Pega aqui el contenido de msgFilterRules.dat" />
            <div className="flex justify-end">
              <Button variant="outline" onClick={importRules} disabled={!(ruleMailboxFilter || selectedMailboxId) || !rulesSource.trim() || saving}>
                <Upload className="size-4" />
                Importar reglas
              </Button>
            </div>
            <RulesTable
              rules={visibleRules}
              folders={state.folders}
              mailboxName={mailboxName}
              folderName={folderName}
              editingRuleId={editingRuleId}
              savingRuleId={savingRuleId}
              ruleDraft={ruleDraft}
              updateRuleDraft={updateRuleDraft}
              startEditRule={startEditRule}
              saveRule={saveRule}
              deleteRule={deleteRule}
              cancelEdit={(ruleId) => {
                setEditingRuleId('');
                setRuleEdits((current) => {
                  const next = { ...current };
                  delete next[ruleId];
                  return next;
                });
              }}
            />
          </CardContent>
        </Card>
      )}

      {activeSection === 'audit' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Auditoria reciente</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {state.audit_events.length === 0 ? (
              <EmptyLine icon={Archive} text="Aun no hay eventos de auditoria." />
            ) : (
              state.audit_events.map((event) => (
                <div key={event.id} className="grid gap-2 rounded-md border border-border p-3 text-sm lg:grid-cols-[180px_1fr_180px]">
                  <span className="font-medium">{event.event_type}</span>
                  <span className="truncate text-muted-foreground">{mailboxName(event.mailbox_id)} · {folderName(event.folder_id)}</span>
                  <span className="text-xs text-muted-foreground lg:text-right">{new Date(event.created_at).toLocaleString()}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}

      {editorOpen ? <div className="fixed inset-0 z-40 bg-black/20" onClick={() => setEditorOpen(false)} /> : null}
      <Card className={cn('fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col rounded-none border-y-0 border-r-0 shadow-2xl', !editorOpen && 'hidden')}>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">{selectedAccount ? 'Modificar buzon' : 'Nuevo buzon'}</CardTitle>
            <Button variant="ghost" size="icon-sm" onClick={() => setEditorOpen(false)} title="Cerrar">
              <X className="size-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid gap-4 lg:grid-cols-2">
            <Field label="Etiqueta" value={mailboxForm.label} onChange={(value) => setMailboxForm({ ...mailboxForm, label: value })} />
            <Field label="Direccion" value={mailboxForm.email_address} onChange={(value) => setMailboxForm({ ...mailboxForm, email_address: value })} />
            <Field label="IMAP host" value={mailboxForm.imap_host} onChange={(value) => setMailboxForm({ ...mailboxForm, imap_host: value })} />
            <Field label="IMAP puerto" value={mailboxForm.imap_port} onChange={(value) => setMailboxForm({ ...mailboxForm, imap_port: value })} />
            <Field label="IMAP usuario" value={mailboxForm.imap_user} onChange={(value) => setMailboxForm({ ...mailboxForm, imap_user: value })} />
            <Field label="IMAP password" type="password" value={mailboxForm.imap_password} onChange={(value) => setMailboxForm({ ...mailboxForm, imap_password: value })} />
            <Field label="SMTP host" value={mailboxForm.smtp_host} onChange={(value) => setMailboxForm({ ...mailboxForm, smtp_host: value })} />
            <Field label="SMTP puerto" value={mailboxForm.smtp_port} onChange={(value) => setMailboxForm({ ...mailboxForm, smtp_port: value })} />
            <Field label="SMTP usuario" value={mailboxForm.smtp_user} onChange={(value) => setMailboxForm({ ...mailboxForm, smtp_user: value })} />
            <Field label="SMTP password" type="password" value={mailboxForm.smtp_password} onChange={(value) => setMailboxForm({ ...mailboxForm, smtp_password: value })} />
            <Field label="Carpeta IMAP a copiar" value={mailboxForm.sync_mailbox} onChange={(value) => setMailboxForm({ ...mailboxForm, sync_mailbox: value })} />
            <SelectLabel label="Tipo" value={mailboxForm.mailbox_kind} onChange={(value) => setMailboxForm({ ...mailboxForm, mailbox_kind: value })}>
              <option value="shared">Compartido</option>
              <option value="personal">Personal</option>
            </SelectLabel>
            {mailboxForm.mailbox_kind === 'personal' ? (
              <SelectLabel label="Propietario" value={mailboxForm.owner_user_id} onChange={(value) => setMailboxForm({ ...mailboxForm, owner_user_id: value })}>
                <option value="">Usuario actual</option>
                {state.users.map((user) => (
                  <option key={user.user_id} value={user.user_id}>{user.full_name || user.email || user.user_id}</option>
                ))}
              </SelectLabel>
            ) : null}
            <div className="flex justify-end gap-2 lg:col-span-2">
              <Button variant="outline" onClick={() => setEditorOpen(false)}>Cancelar</Button>
              <Button onClick={saveMailbox} disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                {selectedAccount ? 'Actualizar' : 'Guardar'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function SelectLabel({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm">
        {children}
      </select>
    </div>
  );
}

function PermissionSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Switch checked={checked} onCheckedChange={onChange} />
      {label}
    </label>
  );
}

function FolderList({ folders, onDelete }: { folders: FolderRow[]; onDelete: (folder: FolderRow) => void }) {
  if (folders.length === 0) return <EmptyLine icon={Folder} text="No hay carpetas." />;
  return (
    <div className="space-y-1">
      {folders.map((folder) => (
        <div key={folder.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
          <div className="flex min-w-0 items-center gap-2">
            {folder.kind === 'inbox' ? <Inbox className="size-4 text-primary" /> : folder.kind === 'sent' ? <Send className="size-4 text-muted-foreground" /> : <Folder className="size-4 text-muted-foreground" />}
            <span className="truncate">{folder.name}</span>
            <Badge variant="outline">{folder.kind === 'public' ? 'Publica' : folder.kind}</Badge>
          </div>
          {folder.kind === 'custom' || folder.kind === 'public' ? (
            <Button size="icon-sm" variant="ghost" onClick={() => onDelete(folder)} title="Borrar carpeta">
              <Trash2 className="size-4" />
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function PermissionList({
  title,
  rows,
  owner,
  mailboxName,
  folderName,
  onDelete,
}: {
  title: string;
  rows: PermissionRow[];
  owner: (row: PermissionRow) => string;
  mailboxName: (mailboxId: string | null) => string;
  folderName: (folderId: string | null) => string;
  onDelete: (row: PermissionRow) => void;
}) {
  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Users className="size-4" />
        {title}
      </h3>
      {rows.length === 0 ? (
        <EmptyLine icon={ShieldCheck} text="Sin permisos configurados." />
      ) : (
        rows.map((row) => (
          <div key={row.id} className="rounded-md border border-border p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{owner(row)}</p>
                <p className="truncate text-xs text-muted-foreground">{mailboxName(row.mailbox_id)} · {folderName(row.folder_id)}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {row.can_read ? <Badge variant="outline">Leer</Badge> : null}
                  {row.can_move ? <Badge variant="outline">Mover</Badge> : null}
                  {row.can_classify ? <Badge variant="outline">Clasificar</Badge> : null}
                  {row.can_send ? <Badge variant="outline">Enviar</Badge> : null}
                </div>
              </div>
              <Button size="icon-sm" variant="ghost" onClick={() => onDelete(row)} title="Revocar permiso">
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function RulesTable({
  rules,
  folders,
  mailboxName,
  folderName,
  editingRuleId,
  savingRuleId,
  ruleDraft,
  updateRuleDraft,
  startEditRule,
  saveRule,
  deleteRule,
  cancelEdit,
}: {
  rules: RuleRow[];
  folders: FolderRow[];
  mailboxName: (mailboxId: string | null) => string;
  folderName: (folderId: string | null) => string;
  editingRuleId: string;
  savingRuleId: string;
  ruleDraft: (rule: RuleRow) => { name: string; field: string; operator: string; value: string; target_folder_id: string; enabled: boolean };
  updateRuleDraft: (ruleId: string, patch: Partial<ReturnType<typeof ruleDraft>>) => void;
  startEditRule: (rule: RuleRow) => void;
  saveRule: (rule: RuleRow) => void;
  deleteRule: (ruleId: string) => void;
  cancelEdit: (ruleId: string) => void;
}) {
  if (rules.length === 0) return <EmptyLine icon={RefreshCw} text="No hay reglas para mostrar." />;
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <div className="min-w-[920px]">
        <div className="grid grid-cols-[150px_minmax(180px,1fr)_120px_120px_minmax(160px,1fr)_160px_88px_112px] items-center border-b border-border bg-muted/60 px-3 py-2 text-xs font-medium uppercase text-muted-foreground">
          <span>Buzon</span>
          <span>Nombre</span>
          <span>Campo</span>
          <span>Operador</span>
          <span>Valor</span>
          <span>Destino</span>
          <span>Activa</span>
          <span className="text-right">Acciones</span>
        </div>
        {rules.map((rule) => {
          const editing = editingRuleId === rule.id;
          const draft = ruleDraft(rule);
          const folderOptions = folders.filter((folder) => folder.mailbox_id === rule.mailbox_id);
          return (
            <div key={rule.id} className="grid grid-cols-[150px_minmax(180px,1fr)_120px_120px_minmax(160px,1fr)_160px_88px_112px] items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0">
              <span className="truncate text-muted-foreground">{mailboxName(rule.mailbox_id)}</span>
              {editing ? (
                <>
                  <Input value={draft.name} onChange={(event) => updateRuleDraft(rule.id, { name: event.target.value })} className="h-8" />
                  <select value={draft.field} onChange={(event) => updateRuleDraft(rule.id, { field: event.target.value })} className="h-8 rounded-md border border-border bg-card px-2">
                    <option value="from">De</option>
                    <option value="from_domain">Dominio</option>
                    <option value="to">Para</option>
                    <option value="cc">Cc</option>
                    <option value="subject">Asunto</option>
                  </select>
                  <select value={draft.operator} onChange={(event) => updateRuleDraft(rule.id, { operator: event.target.value })} className="h-8 rounded-md border border-border bg-card px-2">
                    <option value="contains">Contiene</option>
                    <option value="equals">Igual</option>
                    <option value="starts_with">Empieza por</option>
                    <option value="ends_with">Termina por</option>
                  </select>
                  <Input value={draft.value} onChange={(event) => updateRuleDraft(rule.id, { value: event.target.value })} className="h-8" />
                  <select value={draft.target_folder_id} onChange={(event) => updateRuleDraft(rule.id, { target_folder_id: event.target.value })} className="h-8 rounded-md border border-border bg-card px-2">
                    {folderOptions.map((folder) => (
                      <option key={folder.id} value={folder.id}>{folder.name}</option>
                    ))}
                  </select>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input type="checkbox" checked={draft.enabled} onChange={(event) => updateRuleDraft(rule.id, { enabled: event.target.checked })} />
                    Si
                  </label>
                  <div className="flex justify-end gap-1">
                    <Button size="icon-sm" variant="ghost" onClick={() => saveRule(rule)} disabled={savingRuleId === rule.id}>
                      {savingRuleId === rule.id ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                    </Button>
                    <Button size="icon-sm" variant="ghost" onClick={() => cancelEdit(rule.id)}>
                      <X className="size-4" />
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <span className="truncate font-medium">{rule.name}</span>
                  <span className="truncate text-muted-foreground">{rule.field}</span>
                  <span className="truncate text-muted-foreground">{rule.operator}</span>
                  <span className="truncate">{rule.value}</span>
                  <span className="truncate text-muted-foreground">{folderName(rule.target_folder_id)}</span>
                  <span className={rule.enabled ? 'text-emerald-600' : 'text-muted-foreground'}>{rule.enabled ? 'Si' : 'No'}</span>
                  <div className="flex justify-end gap-1">
                    <Button size="icon-sm" variant="ghost" onClick={() => startEditRule(rule)} title="Editar regla">
                      <Edit2 className="size-4" />
                    </Button>
                    <Button size="icon-sm" variant="ghost" onClick={() => deleteRule(rule.id)} disabled={savingRuleId === rule.id} title="Borrar regla">
                      {savingRuleId === rule.id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                    </Button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EmptyLine({ icon: Icon, text }: { icon: ComponentType<{ className?: string }>; text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
      <Icon className="size-4" />
      {text}
    </div>
  );
}
