'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import {
  Archive,
  Building2,
  Copy,
  Edit2,
  Flame,
  Folder,
  FolderPlus,
  Grid2X2,
  Inbox,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  User,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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

function isSpamFolder(folder: Pick<FolderRow, 'name' | 'slug'>) {
  const normalized = `${folder.slug} ${folder.name}`.toLowerCase();
  return /\b(junk|spam)\b/.test(normalized) || normalized.includes('correo-no-deseado');
}

function emailFolderName(folder: Pick<FolderRow, 'name' | 'slug'>) {
  return isSpamFolder(folder) ? 'SPAM' : folder.name;
}

function FolderRowIcon({ folder }: { folder: FolderRow }) {
  if (isSpamFolder(folder)) return <Flame className="size-4 text-muted-foreground" />;
  if (folder.kind === 'inbox') return <Inbox className="size-4 text-primary" />;
  if (folder.kind === 'sent') return <Send className="size-4 text-muted-foreground" />;
  return <Folder className="size-4 text-muted-foreground" />;
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
  target_folder_id: string | null;
  name: string;
  value: string;
  field: string;
  operator: string;
  enabled: boolean;
  action: string;
  action_value: string | null;
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
type PermissionScope = 'department' | 'user';
type PermissionMatrixView = 'group' | 'user' | 'resource';

interface PermissionTarget {
  key: string;
  type: 'mailbox' | 'folder';
  id: string;
  label: string;
  description: string;
  mailboxId: string | null;
  folderId: string | null;
}

interface PermissionPreset {
  id: string;
  label: string;
  permissions: Pick<PermissionRow, 'can_read' | 'can_move' | 'can_classify' | 'can_send'>;
}

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

const permissionPresets: PermissionPreset[] = [
  {
    id: 'read',
    label: 'Solo lectura',
    permissions: { can_read: true, can_move: false, can_classify: false, can_send: false },
  },
  {
    id: 'work',
    label: 'Trabajo completo',
    permissions: { can_read: true, can_move: true, can_classify: true, can_send: true },
  },
  {
    id: 'move',
    label: 'Lectura + mover',
    permissions: { can_read: true, can_move: true, can_classify: false, can_send: false },
  },
  {
    id: 'send',
    label: 'Enviar permitido',
    permissions: { can_read: true, can_move: false, can_classify: false, can_send: true },
  },
  {
    id: 'none',
    label: 'Sin acceso',
    permissions: { can_read: false, can_move: false, can_classify: false, can_send: false },
  },
];

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
  const [permissionView, setPermissionView] = useState<PermissionMatrixView>('group');
  const [permissionSearch, setPermissionSearch] = useState('');
  const [permissionTargetFilter, setPermissionTargetFilter] = useState<'all' | 'mailboxes' | 'public' | 'with' | 'without'>('all');
  const [selectedPermissionSubjects, setSelectedPermissionSubjects] = useState<string[]>([]);
  const [selectedPermissionTargets, setSelectedPermissionTargets] = useState<string[]>([]);
  const [copyFromSubjectId, setCopyFromSubjectId] = useState('');
  const [resourceSubjectScope, setResourceSubjectScope] = useState<PermissionScope>('department');
  const [rulesSource, setRulesSource] = useState('');
  const [editingRuleId, setEditingRuleId] = useState('');
  const [savingRuleId, setSavingRuleId] = useState('');
  const [ruleMailboxFilter, setRuleMailboxFilter] = useState('');
  const [ruleEdits, setRuleEdits] = useState<Record<string, {
    name: string;
    field: string;
    operator: string;
    value: string;
    target_folder_id: string | null;
    enabled: boolean;
    action: string;
    action_value: string | null;
  }>>({});

  const selectedAccount = state.accounts.find((account) => account.id === selectedAccountId) ?? null;
  const selectedMailbox = state.mailboxes.find((mailbox) => mailbox.id === selectedMailboxId) ?? state.mailboxes[0] ?? null;
  const accountsById = useMemo(() => new Map(state.accounts.map((account) => [account.id, account])), [state.accounts]);
  const publicFolders = state.folders.filter((folder) => folder.kind === 'public' || folder.mailbox_id === null);
  const internalFolders = state.folders.filter((folder) => folder.mailbox_id === selectedMailbox?.id);
  const systemFolderCount = state.folders.filter((folder) => folder.kind !== 'custom' && folder.kind !== 'public').length;
  const visibleRules = ruleMailboxFilter ? state.rules.filter((rule) => rule.mailbox_id === ruleMailboxFilter) : state.rules;
  const permissionTargets = useMemo<PermissionTarget[]>(
    () => [
      ...state.mailboxes.map((mailbox) => ({
        key: `mailbox:${mailbox.id}`,
        type: 'mailbox' as const,
        id: mailbox.id,
        label: mailbox.display_name || mailbox.address,
        description: mailbox.address,
        mailboxId: mailbox.id,
        folderId: null,
      })),
      ...publicFolders.map((folder) => ({
        key: `folder:${folder.id}`,
        type: 'folder' as const,
        id: folder.id,
        label: emailFolderName(folder),
        description: 'Carpeta publica',
        mailboxId: null,
        folderId: folder.id,
      })),
    ],
    [publicFolders, state.mailboxes],
  );

  const mailboxName = useCallback((mailboxId: string | null) => {
    if (!mailboxId) return 'Carpetas publicas';
    const mailbox = state.mailboxes.find((item) => item.id === mailboxId);
    return mailbox?.display_name || mailbox?.address || 'Buzon';
  }, [state.mailboxes]);

  const folderName = useCallback((folderId: string | null) => {
    if (!folderId) return 'Todo el buzon';
    const folder = state.folders.find((item) => item.id === folderId);
    return folder ? emailFolderName(folder) : 'Carpeta';
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
      action: rule.action || 'move_to',
      action_value: rule.action_value || null,
    };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/email/admin', { cache: 'no-store' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'No se pudo cargar Email');
      const nextState: AdminState = { ...emptyState, ...payload };
      setState(nextState);
      setSelectedMailboxId((current) =>
        current && nextState.mailboxes.some((mailbox) => mailbox.id === current)
          ? current
          : nextState.mailboxes[0]?.id ?? '',
      );
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
    if (!window.confirm(`Borrar la carpeta ${emailFolderName(folder)}? Los correos volveran a Entrada.`)) return;
    await post({ action: 'delete_folder', folder_id: folder.id }, 'Carpeta borrada');
  }

  async function deletePermission(permission: PermissionRow, scope: 'user' | 'department') {
    await post({ action: 'delete_permission', permission_id: permission.id, scope }, 'Permiso revocado');
  }

  function rowsForScope(scope: PermissionScope) {
    return scope === 'user' ? state.user_permissions : state.permissions;
  }

  function permissionSubjectOptions(scope: PermissionScope) {
    return scope === 'user'
      ? state.users.map((user) => ({
          id: user.user_id,
          label: user.full_name || user.email || user.user_id,
          description: user.email || user.role,
        }))
      : state.departments.map((department) => ({
          id: department.id,
          label: department.name,
          description: 'Grupo/departamento',
      }));
  }

  function permissionScopeForView(): PermissionScope {
    if (permissionView === 'user') return 'user';
    if (permissionView === 'resource') return resourceSubjectScope;
    return 'department';
  }

  function findPermission(scope: PermissionScope, subjectId: string, target: PermissionTarget) {
    return rowsForScope(scope).find((row) => {
      const ownerMatches = scope === 'user' ? row.user_id === subjectId : row.department_id === subjectId;
      return ownerMatches && row.mailbox_id === target.mailboxId && row.folder_id === target.folderId;
    }) ?? null;
  }

  function permissionSummary(permission: PermissionRow | null) {
    if (!permission) return 'Sin acceso';
    const parts = [
      permission.can_read ? 'L' : '',
      permission.can_move ? 'M' : '',
      permission.can_classify ? 'C' : '',
      permission.can_send ? 'E' : '',
    ].filter(Boolean);
    return parts.length ? parts.join(' ') : 'Sin acceso';
  }

  function targetHasAnyPermission(target: PermissionTarget) {
    return [...state.permissions, ...state.user_permissions].some(
      (row) => row.mailbox_id === target.mailboxId && row.folder_id === target.folderId,
    );
  }

  const filteredPermissionTargets = permissionTargets.filter((target) => {
    const search = permissionSearch.trim().toLowerCase();
    const matchesSearch = !search || `${target.label} ${target.description}`.toLowerCase().includes(search);
    const matchesFilter =
      permissionTargetFilter === 'all' ||
      (permissionTargetFilter === 'mailboxes' && target.type === 'mailbox') ||
      (permissionTargetFilter === 'public' && target.type === 'folder') ||
      (permissionTargetFilter === 'with' && targetHasAnyPermission(target)) ||
      (permissionTargetFilter === 'without' && !targetHasAnyPermission(target));
    return matchesSearch && matchesFilter;
  });

  function toggleSelection(list: string[], value: string) {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }

  function selectedTargetsOrVisible() {
    const selected = permissionTargets.filter((target) => selectedPermissionTargets.includes(target.key));
    return selected.length ? selected : filteredPermissionTargets;
  }

  async function applyPermissionPreset(scope: PermissionScope, subjectIds: string[], targets: PermissionTarget[], preset: PermissionPreset) {
    if (subjectIds.length === 0 || targets.length === 0) {
      toast.error('Selecciona al menos una fila y un destino.');
      return;
    }
    await post(
      {
        action: 'upsert_permissions_bulk',
        scope,
        subject_ids: subjectIds,
        targets: targets.map((target) => ({
          mailbox_id: target.mailboxId,
          folder_id: target.folderId,
        })),
        can_read: preset.permissions.can_read,
        can_move: preset.permissions.can_move,
        can_classify: preset.permissions.can_classify,
        can_send: preset.permissions.can_send,
      },
      preset.id === 'none' ? 'Permisos revocados' : 'Permisos aplicados',
    );
  }

  async function applyPresetToSelection(preset: PermissionPreset) {
    const scope = permissionScopeForView();
    const fallbackSubjects = permissionSubjectOptions(scope).map((subject) => subject.id);
    const subjectIds = selectedPermissionSubjects.length ? selectedPermissionSubjects : fallbackSubjects;
    await applyPermissionPreset(scope, subjectIds, selectedTargetsOrVisible(), preset);
  }

  async function copyPermissionsFromSubject() {
    const scope = permissionScopeForView();
    if (!copyFromSubjectId) {
      toast.error('Elige de quien copiar permisos.');
      return;
    }
    const subjectIds = selectedPermissionSubjects.filter((subjectId) => subjectId !== copyFromSubjectId);
    const targets = selectedTargetsOrVisible();
    if (subjectIds.length === 0) {
      toast.error('Selecciona destinatarios distintos al origen.');
      return;
    }

    setSaving(true);
    try {
      for (const target of targets) {
        const sourcePermission = findPermission(scope, copyFromSubjectId, target);
        const res = await fetch('/api/email/admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'upsert_permissions_bulk',
            scope,
            subject_ids: subjectIds,
            targets: [{ mailbox_id: target.mailboxId, folder_id: target.folderId }],
            can_read: sourcePermission?.can_read ?? false,
            can_move: sourcePermission?.can_move ?? false,
            can_classify: sourcePermission?.can_classify ?? false,
            can_send: sourcePermission?.can_send ?? false,
          }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || 'No se pudieron copiar permisos');
      }
      toast.success('Permisos copiados');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudieron copiar permisos');
    } finally {
      setSaving(false);
    }
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
        action: rule.action || 'move_to',
        action_value: rule.action_value || null,
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
    const needsTarget = draft.action === 'move_to' || draft.action === 'copy_to';
    const needsValue = !['exists', 'not_exists'].includes(draft.operator);
    if (!draft.name.trim() || (needsValue && !draft.value.trim()) || (needsTarget && !draft.target_folder_id)) return;
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
          action: draft.action,
          action_value: draft.action_value,
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
            <CardTitle className="text-base">Permisos de acceso en masa</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
              <div className="flex flex-wrap gap-1">
                {[
                  { id: 'group', label: 'Por grupo', icon: Building2 },
                  { id: 'user', label: 'Por usuario', icon: User },
                  { id: 'resource', label: 'Por recurso', icon: Grid2X2 },
                ].map((item) => {
                  const Icon = item.icon;
                  return (
                    <Button
                      key={item.id}
                      type="button"
                      size="sm"
                      variant={permissionView === item.id ? 'default' : 'outline'}
                      onClick={() => {
                        setPermissionView(item.id as PermissionMatrixView);
                        setSelectedPermissionSubjects([]);
                        setSelectedPermissionTargets([]);
                      }}
                    >
                      <Icon className="size-4" />
                      {item.label}
                    </Button>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={permissionSearch}
                  onChange={(event) => setPermissionSearch(event.target.value)}
                  placeholder="Buscar buzón o carpeta"
                  className="h-9 w-56"
                />
                <select
                  value={permissionTargetFilter}
                  onChange={(event) => setPermissionTargetFilter(event.target.value as typeof permissionTargetFilter)}
                  className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                >
                  <option value="all">Todos</option>
                  <option value="mailboxes">Buzones</option>
                  <option value="public">Carpetas publicas</option>
                  <option value="with">Con permisos</option>
                  <option value="without">Sin permisos</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Presets</span>
              {permissionPresets.map((preset) => (
                <Button key={preset.id} type="button" size="sm" variant="outline" onClick={() => applyPresetToSelection(preset)} disabled={saving}>
                  {preset.label}
                </Button>
              ))}
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {permissionView === 'resource' ? (
                  <select
                    value={resourceSubjectScope}
                    onChange={(event) => {
                      setResourceSubjectScope(event.target.value as PermissionScope);
                      setSelectedPermissionSubjects([]);
                      setCopyFromSubjectId('');
                    }}
                    className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                  >
                    <option value="department">Grupos</option>
                    <option value="user">Usuarios</option>
                  </select>
                ) : null}
                <select
                  value={copyFromSubjectId}
                  onChange={(event) => setCopyFromSubjectId(event.target.value)}
                  className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                >
                  <option value="">Copiar permisos de...</option>
                  {permissionSubjectOptions(permissionScopeForView()).map((subject) => (
                    <option key={subject.id} value={subject.id}>{subject.label}</option>
                  ))}
                </select>
                <Button type="button" size="sm" variant="outline" onClick={copyPermissionsFromSubject} disabled={saving || !copyFromSubjectId}>
                  <Copy className="size-4" />
                  Copiar
                </Button>
              </div>
            </div>

            <PermissionMatrix
              view={permissionView}
              scope={permissionScopeForView()}
              subjects={permissionSubjectOptions(permissionScopeForView())}
              targets={filteredPermissionTargets}
              selectedSubjects={selectedPermissionSubjects}
              selectedTargets={selectedPermissionTargets}
              onToggleSubject={(id) => setSelectedPermissionSubjects((current) => toggleSelection(current, id))}
              onToggleTarget={(key) => setSelectedPermissionTargets((current) => toggleSelection(current, key))}
              onToggleAllSubjects={(ids) => setSelectedPermissionSubjects((current) => current.length === ids.length ? [] : ids)}
              onToggleAllTargets={(keys) => setSelectedPermissionTargets((current) => current.length === keys.length ? [] : keys)}
              getPermission={findPermission}
              permissionSummary={permissionSummary}
              applyCellPreset={(scope, subjectId, target, preset) => applyPermissionPreset(scope, [subjectId], [target], preset)}
              saving={saving}
            />

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

function FolderList({ folders, onDelete }: { folders: FolderRow[]; onDelete: (folder: FolderRow) => void }) {
  if (folders.length === 0) return <EmptyLine icon={Folder} text="No hay carpetas." />;
  return (
    <div className="space-y-1">
      {folders.map((folder) => (
        <div key={folder.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
          <div className="flex min-w-0 items-center gap-2">
            <FolderRowIcon folder={folder} />
            <span className="truncate">{emailFolderName(folder)}</span>
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

function PermissionMatrix({
  view,
  scope,
  subjects,
  targets,
  selectedSubjects,
  selectedTargets,
  onToggleSubject,
  onToggleTarget,
  onToggleAllSubjects,
  onToggleAllTargets,
  getPermission,
  permissionSummary,
  applyCellPreset,
  saving,
}: {
  view: PermissionMatrixView;
  scope: PermissionScope;
  subjects: Array<{ id: string; label: string; description: string }>;
  targets: PermissionTarget[];
  selectedSubjects: string[];
  selectedTargets: string[];
  onToggleSubject: (id: string) => void;
  onToggleTarget: (key: string) => void;
  onToggleAllSubjects: (ids: string[]) => void;
  onToggleAllTargets: (keys: string[]) => void;
  getPermission: (scope: PermissionScope, subjectId: string, target: PermissionTarget) => PermissionRow | null;
  permissionSummary: (permission: PermissionRow | null) => string;
  applyCellPreset: (scope: PermissionScope, subjectId: string, target: PermissionTarget, preset: PermissionPreset) => void;
  saving: boolean;
}) {
  if (subjects.length === 0 || targets.length === 0) {
    return <EmptyLine icon={ShieldCheck} text="No hay suficientes usuarios/grupos o destinos para pintar la matriz." />;
  }

  const allSubjectIds = subjects.map((subject) => subject.id);
  const allTargetKeys = targets.map((target) => target.key);

  if (view === 'resource') {
    return (
      <div className="overflow-auto rounded-md border border-border">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead className="sticky top-0 bg-muted/80 backdrop-blur">
            <tr>
              <th className="w-56 border-b border-r border-border px-3 py-2 text-left">
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={selectedTargets.length === allTargetKeys.length && allTargetKeys.length > 0}
                    onCheckedChange={() => onToggleAllTargets(allTargetKeys)}
                  />
                  Recurso
                </label>
              </th>
              {subjects.map((subject) => (
                <th key={subject.id} className="min-w-32 border-b border-r border-border px-2 py-2 text-left">
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={selectedSubjects.includes(subject.id)}
                      onCheckedChange={() => onToggleSubject(subject.id)}
                    />
                    <span className="truncate">{subject.label}</span>
                  </label>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {targets.map((target) => (
              <tr key={target.key} className="hover:bg-muted/40">
                <td className="border-r border-border px-3 py-2">
                  <label className="flex items-start gap-2">
                    <Checkbox
                      checked={selectedTargets.includes(target.key)}
                      onCheckedChange={() => onToggleTarget(target.key)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{target.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">{target.description}</span>
                    </span>
                  </label>
                </td>
                {subjects.map((subject) => (
                  <td key={`${target.key}-${subject.id}`} className="border-r border-t border-border px-2 py-1.5">
                    <PermissionCell
                      permission={getPermission(scope, subject.id, target)}
                      summary={permissionSummary(getPermission(scope, subject.id, target))}
                      onApply={(preset) => applyCellPreset(scope, subject.id, target, preset)}
                      saving={saving}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="overflow-auto rounded-md border border-border">
      <table className="w-full min-w-[820px] border-collapse text-sm">
        <thead className="sticky top-0 bg-muted/80 backdrop-blur">
          <tr>
            <th className="w-56 border-b border-r border-border px-3 py-2 text-left">
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={selectedSubjects.length === allSubjectIds.length && allSubjectIds.length > 0}
                  onCheckedChange={() => onToggleAllSubjects(allSubjectIds)}
                />
                {scope === 'user' ? 'Usuario' : 'Grupo'}
              </label>
            </th>
            {targets.map((target) => (
              <th key={target.key} className="min-w-36 border-b border-r border-border px-2 py-2 text-left">
                <label className="flex items-start gap-2">
                  <Checkbox
                    checked={selectedTargets.includes(target.key)}
                    onCheckedChange={() => onToggleTarget(target.key)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate">{target.label}</span>
                    <span className="block truncate text-[11px] font-normal text-muted-foreground">{target.type === 'mailbox' ? 'Buzon' : 'Publica'}</span>
                  </span>
                </label>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {subjects.map((subject) => (
            <tr key={subject.id} className="hover:bg-muted/40">
              <td className="border-r border-border px-3 py-2">
                <label className="flex items-start gap-2">
                  <Checkbox
                    checked={selectedSubjects.includes(subject.id)}
                    onCheckedChange={() => onToggleSubject(subject.id)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{subject.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">{subject.description}</span>
                  </span>
                </label>
              </td>
              {targets.map((target) => {
                const permission = getPermission(scope, subject.id, target);
                return (
                  <td key={`${subject.id}-${target.key}`} className="border-r border-t border-border px-2 py-1.5">
                    <PermissionCell
                      permission={permission}
                      summary={permissionSummary(permission)}
                      onApply={(preset) => applyCellPreset(scope, subject.id, target, preset)}
                      saving={saving}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PermissionCell({
  permission,
  summary,
  onApply,
  saving,
}: {
  permission: PermissionRow | null;
  summary: string;
  onApply: (preset: PermissionPreset) => void;
  saving: boolean;
}) {
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          'flex min-h-8 w-full items-center justify-center rounded-md border px-2 text-xs font-medium transition-colors hover:bg-muted',
          permission ? 'border-primary/30 bg-primary/10 text-primary' : 'border-dashed border-border text-muted-foreground',
        )}
      >
        {summary}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium">Aplicar permiso</p>
            <p className="text-xs text-muted-foreground">El preset reemplaza el permiso actual de esta celda.</p>
          </div>
          <div className="grid gap-1">
            {permissionPresets.map((preset) => (
              <Button key={preset.id} type="button" size="sm" variant="ghost" className="justify-start" onClick={() => onApply(preset)} disabled={saving}>
                {preset.label}
              </Button>
            ))}
          </div>
          {permission ? (
            <div className="grid grid-cols-2 gap-1 border-t border-border pt-2 text-xs text-muted-foreground">
              <span>Leer: {permission.can_read ? 'si' : 'no'}</span>
              <span>Mover: {permission.can_move ? 'si' : 'no'}</span>
              <span>Clasificar: {permission.can_classify ? 'si' : 'no'}</span>
              <span>Enviar: {permission.can_send ? 'si' : 'no'}</span>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
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
  ruleDraft: (rule: RuleRow) => { name: string; field: string; operator: string; value: string; target_folder_id: string | null; enabled: boolean; action: string; action_value: string | null };
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
          <span>Accion / destino</span>
          <span>Activa</span>
          <span className="text-right">Acciones</span>
        </div>
        {rules.map((rule) => {
          const editing = editingRuleId === rule.id;
          const draft = ruleDraft(rule);
          const folderOptions = folders.filter(
            (folder) => folder.mailbox_id === rule.mailbox_id || folder.kind === 'public' || folder.mailbox_id === null,
          );
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
                    <option value="body">Cuerpo</option>
                    <option value="to_or_cc">Para o CC</option>
                    <option value="recipients">Destinatarios</option>
                    <option value="age_days">Antiguedad</option>
                    <option value="size_kb">Tamano</option>
                    <option value="has_attachment">Adjunto</option>
                  </select>
                  <select value={draft.operator} onChange={(event) => updateRuleDraft(rule.id, { operator: event.target.value })} className="h-8 rounded-md border border-border bg-card px-2">
                    <option value="contains">Contiene</option>
                    <option value="equals">Igual</option>
                    <option value="starts_with">Empieza por</option>
                    <option value="ends_with">Termina por</option>
                    <option value="not_contains">No contiene</option>
                    <option value="not_equals">No es</option>
                    <option value="exists">Existe</option>
                    <option value="not_exists">No existe</option>
                    <option value="greater_than">Mayor que</option>
                    <option value="less_than">Menor que</option>
                  </select>
                  <Input value={draft.value} onChange={(event) => updateRuleDraft(rule.id, { value: event.target.value })} className="h-8" />
                  <select value={draft.action} onChange={(event) => updateRuleDraft(rule.id, { action: event.target.value })} className="h-8 rounded-md border border-border bg-card px-2">
                    <option value="move_to">Mover a</option>
                    <option value="copy_to">Copiar a</option>
                    <option value="mark_read">Marcar leído</option>
                    <option value="mark_unread">Marcar no leído</option>
                    <option value="star">Añadir estrella</option>
                    <option value="label">Etiquetar</option>
                  </select>
                  <select value={draft.target_folder_id ?? ''} onChange={(event) => updateRuleDraft(rule.id, { target_folder_id: event.target.value || null })} className="h-8 rounded-md border border-border bg-card px-2">
                    {folderOptions.map((folder) => (
                      <option key={folder.id} value={folder.id}>
                        {emailFolderName(folder)} · {folder.mailbox_id ? 'Buzon' : 'Publica'}
                      </option>
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
                  <span className="truncate text-muted-foreground">{rule.action || 'move_to'} · {folderName(rule.target_folder_id)}</span>
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
