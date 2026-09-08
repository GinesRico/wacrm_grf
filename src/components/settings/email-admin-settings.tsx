'use client';

import { useCallback, useEffect, useState } from 'react';
import { Edit2, FolderPlus, Loader2, Plus, Save, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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

interface AdminState {
  accounts: EmailAccountRow[];
  mailboxes: Array<{ id: string; email_account_id: string; address: string; display_name: string | null; kind: string }>;
  folders: Array<{ id: string; mailbox_id: string; name: string; kind: string }>;
  permissions: Array<{ id: string; department_id: string; mailbox_id: string; folder_id: string | null; can_read: boolean; can_move: boolean; can_classify: boolean; can_send: boolean }>;
  departments: Array<{ id: string; name: string; color: string }>;
  rules: Array<{
    id: string;
    mailbox_id: string;
    target_folder_id: string;
    name: string;
    value: string;
    field: string;
    operator: string;
    enabled: boolean;
  }>;
  audit_events: Array<{ id: string; event_type: string; created_at: string; metadata: unknown }>;
}

const emptyState: AdminState = {
  accounts: [],
  mailboxes: [],
  folders: [],
  permissions: [],
  departments: [],
  rules: [],
  audit_events: [],
};

export function EmailAdminSettings() {
  const [state, setState] = useState<AdminState>(emptyState);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingRuleId, setSavingRuleId] = useState('');
  const [editingRuleId, setEditingRuleId] = useState('');
  const [ruleEdits, setRuleEdits] = useState<Record<string, {
    name: string;
    field: string;
    operator: string;
    value: string;
    target_folder_id: string;
    enabled: boolean;
  }>>({});
  const [rulesSource, setRulesSource] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [form, setForm] = useState({
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
  });

  const firstMailboxId = state.mailboxes[0]?.id ?? '';
  const firstDepartmentId = state.departments[0]?.id ?? '';
  const selectedAccount = state.accounts.find((account) => account.id === selectedAccountId) ?? null;
  const mailboxName = (mailboxId: string) => {
    const mailbox = state.mailboxes.find((item) => item.id === mailboxId);
    return mailbox?.display_name || mailbox?.address || 'Buzon';
  };
  const folderName = (folderId: string) => state.folders.find((item) => item.id === folderId)?.name ?? 'Carpeta';
  const foldersForMailbox = (mailboxId: string) => state.folders.filter((folder) => folder.mailbox_id === mailboxId);
  const ruleDraft = (rule: AdminState['rules'][number]) =>
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
      setState({ ...emptyState, ...payload });
      setSelectedAccountId((current) =>
        current && payload.accounts?.some((account: EmailAccountRow) => account.id === current)
          ? current
          : payload.accounts?.[0]?.id ?? '',
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

  async function createAccount() {
    await post(
      {
        action: 'create_account',
        ...form,
        imap_port: Number(form.imap_port),
        smtp_port: Number(form.smtp_port),
      },
      'Buzon conectado',
    );
    setForm((current) => ({
      ...current,
      label: '',
      email_address: '',
      imap_user: '',
      imap_password: '',
      smtp_user: '',
      smtp_password: '',
    }));
  }

  function loadAccountIntoForm(account: EmailAccountRow) {
    const mailbox = state.mailboxes.find((item) => item.email_account_id === account.id);
    setSelectedAccountId(account.id);
    setForm({
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
      mailbox_kind: mailbox?.kind === 'personal' ? 'personal' : 'shared',
    });
  }

  async function saveSelectedAccount() {
    if (!selectedAccount) return;
    await post(
      {
        action: 'update_account',
        email_account_id: selectedAccount.id,
        ...form,
        imap_port: Number(form.imap_port),
        smtp_port: Number(form.smtp_port),
        enabled: selectedAccount.enabled,
      },
      'Buzon actualizado',
    );
  }

  function newAccountForm() {
    setSelectedAccountId('');
    setForm({
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
    });
  }

  async function grantPermission() {
    if (!firstMailboxId || !firstDepartmentId) return;
    await post(
      {
        action: 'grant_permission',
        mailbox_id: firstMailboxId,
        department_id: firstDepartmentId,
        can_read: true,
        can_move: true,
        can_classify: true,
        can_send: true,
      },
      'Permiso concedido',
    );
  }

  async function createFolder() {
    const name = window.prompt('Nombre de carpeta interna');
    if (!name || !firstMailboxId) return;
    await post({ action: 'create_folder', mailbox_id: firstMailboxId, name }, 'Carpeta creada');
  }

  async function importRules() {
    if (!firstMailboxId || !rulesSource.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/email/rules/import-thunderbird', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mailbox_id: firstMailboxId, source: rulesSource }),
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

  function startEditRule(rule: AdminState['rules'][number]) {
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
    setRuleEdits((current) => ({
      ...current,
      [ruleId]: {
        ...ruleDraft(rule),
        ...patch,
      },
    }));
  }

  async function saveRule(rule: AdminState['rules'][number]) {
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
      const res = await fetch(`/api/email/rules?rule_id=${encodeURIComponent(ruleId)}`, {
        method: 'DELETE',
      });
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
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title="Email compartido"
        description="Configura buzones IMAP/SMTP, carpetas internas, permisos por departamento y reglas Thunderbird."
      />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">
              {selectedAccount ? 'Modificar buzon IMAP/SMTP' : 'Nuevo buzon IMAP/SMTP'}
            </CardTitle>
            {selectedAccount ? (
              <Button variant="outline" size="sm" onClick={newAccountForm}>
                <Plus className="size-4" />
                Nuevo
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <Field label="Etiqueta" value={form.label} onChange={(value) => setForm({ ...form, label: value })} />
          <Field label="Direccion" value={form.email_address} onChange={(value) => setForm({ ...form, email_address: value })} />
          <Field label="IMAP host" value={form.imap_host} onChange={(value) => setForm({ ...form, imap_host: value })} />
          <Field label="IMAP puerto" value={form.imap_port} onChange={(value) => setForm({ ...form, imap_port: value })} />
          <Field label="IMAP usuario" value={form.imap_user} onChange={(value) => setForm({ ...form, imap_user: value })} />
          <Field label="IMAP password" type="password" value={form.imap_password} onChange={(value) => setForm({ ...form, imap_password: value })} />
          <Field label="SMTP host" value={form.smtp_host} onChange={(value) => setForm({ ...form, smtp_host: value })} />
          <Field label="SMTP puerto" value={form.smtp_port} onChange={(value) => setForm({ ...form, smtp_port: value })} />
          <Field label="SMTP usuario" value={form.smtp_user} onChange={(value) => setForm({ ...form, smtp_user: value })} />
          <Field label="SMTP password" type="password" value={form.smtp_password} onChange={(value) => setForm({ ...form, smtp_password: value })} />
          <Field label="Carpeta IMAP a copiar" value={form.sync_mailbox} onChange={(value) => setForm({ ...form, sync_mailbox: value })} />
          <div className="space-y-1.5">
            <Label>Tipo</Label>
            <select
              value={form.mailbox_kind}
              onChange={(event) => setForm({ ...form, mailbox_kind: event.target.value })}
              className="h-10 w-full rounded-md border border-border bg-muted px-3 text-sm"
            >
              <option value="shared">Compartido</option>
              <option value="personal">Personal</option>
            </select>
          </div>
          <div className="flex justify-end lg:col-span-2">
            <Button onClick={selectedAccount ? saveSelectedAccount : createAccount} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {selectedAccount ? 'Actualizar buzon' : 'Guardar buzon'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Buzones y carpetas</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {state.accounts.map((account) => (
              <button
                key={account.id}
                type="button"
                onClick={() => loadAccountIntoForm(account)}
                className="block w-full rounded-md border border-border p-3 text-left text-sm transition-colors hover:bg-muted"
              >
                <div className="font-medium">{account.label} · {account.email_address}</div>
                <div className="text-xs text-muted-foreground">
                  {account.imap_host}:{account.imap_port} · {account.status}
                  {account.last_synced_at ? ` · ${new Date(account.last_synced_at).toLocaleString()}` : ''}
                </div>
                {account.last_error && <div className="mt-1 text-xs text-destructive">{account.last_error}</div>}
              </button>
            ))}
            {state.mailboxes.length === 0 && <p className="text-sm text-muted-foreground">Aun no hay buzones.</p>}
            <Button variant="outline" onClick={createFolder} disabled={!firstMailboxId || saving}>
              <FolderPlus className="size-4" />
              Crear carpeta interna
            </Button>
            <div className="space-y-1 text-xs text-muted-foreground">
              {state.folders.map((folder) => <div key={folder.id}>{folder.name}</div>)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Permisos por grupo</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Acceso completo rapido para el primer departamento y primer buzon. Despues se podra granular por carpeta.
            </p>
            <Button variant="outline" onClick={grantPermission} disabled={!firstMailboxId || !firstDepartmentId || saving}>
              <ShieldCheck className="size-4" />
              Conceder acceso completo
            </Button>
            <div className="space-y-1 text-xs text-muted-foreground">
              {state.permissions.map((permission) => (
                <div key={permission.id}>
                  {permission.department_id.slice(0, 8)} · {permission.mailbox_id.slice(0, 8)} · leer {String(permission.can_read)} · enviar {String(permission.can_send)}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reglas Thunderbird</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={rulesSource}
            onChange={(event) => setRulesSource(event.target.value)}
            className="min-h-40 font-mono text-xs"
            placeholder="Pega aqui el contenido de msgFilterRules.dat"
          />
          <div className="flex justify-end">
            <Button variant="outline" onClick={importRules} disabled={!firstMailboxId || !rulesSource.trim() || saving}>
              <Upload className="size-4" />
              Importar reglas
            </Button>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Reglas guardadas</h3>
              <span className="text-xs text-muted-foreground">{state.rules.length} reglas</span>
            </div>
            {state.rules.length === 0 ? (
              <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                Aun no hay reglas importadas o creadas.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-border">
                <div className="min-w-[920px]">
                  <div className="grid grid-cols-[150px_minmax(180px,1fr)_120px_120px_minmax(160px,1fr)_160px_88px_132px] items-center border-b border-border bg-muted/60 px-3 py-2 text-xs font-medium uppercase text-muted-foreground">
                    <span>Buzon</span>
                    <span>Nombre</span>
                    <span>Campo</span>
                    <span>Operador</span>
                    <span>Valor</span>
                    <span>Destino</span>
                    <span>Activa</span>
                    <span className="text-right">Acciones</span>
                  </div>
                  {state.rules.map((rule) => {
                    const editing = editingRuleId === rule.id;
                    const draft = ruleDraft(rule);
                    const folderOptions = foldersForMailbox(rule.mailbox_id);
                    return (
                      <div
                        key={rule.id}
                        className="grid grid-cols-[150px_minmax(180px,1fr)_120px_120px_minmax(160px,1fr)_160px_88px_132px] items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0"
                      >
                        <span className="truncate text-muted-foreground">{mailboxName(rule.mailbox_id)}</span>
                        {editing ? (
                          <>
                            <Input
                              value={draft.name}
                              onChange={(event) => updateRuleDraft(rule.id, { name: event.target.value })}
                              className="h-8"
                            />
                            <select
                              value={draft.field}
                              onChange={(event) => updateRuleDraft(rule.id, { field: event.target.value })}
                              className="h-8 rounded-md border border-border bg-card px-2"
                            >
                              <option value="from">De</option>
                              <option value="domain">Dominio</option>
                              <option value="to">Para</option>
                              <option value="subject">Asunto</option>
                              <option value="body">Cuerpo</option>
                            </select>
                            <select
                              value={draft.operator}
                              onChange={(event) => updateRuleDraft(rule.id, { operator: event.target.value })}
                              className="h-8 rounded-md border border-border bg-card px-2"
                            >
                              <option value="contains">Contiene</option>
                              <option value="equals">Igual</option>
                              <option value="starts_with">Empieza por</option>
                              <option value="ends_with">Termina por</option>
                            </select>
                            <Input
                              value={draft.value}
                              onChange={(event) => updateRuleDraft(rule.id, { value: event.target.value })}
                              className="h-8"
                            />
                            <select
                              value={draft.target_folder_id}
                              onChange={(event) => updateRuleDraft(rule.id, { target_folder_id: event.target.value })}
                              className="h-8 rounded-md border border-border bg-card px-2"
                            >
                              {folderOptions.map((folder) => (
                                <option key={folder.id} value={folder.id}>
                                  {folder.name}
                                </option>
                              ))}
                            </select>
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <input
                                type="checkbox"
                                checked={draft.enabled}
                                onChange={(event) => updateRuleDraft(rule.id, { enabled: event.target.checked })}
                              />
                              Si
                            </label>
                            <div className="flex justify-end gap-1">
                              <Button size="icon-sm" variant="ghost" onClick={() => saveRule(rule)} disabled={savingRuleId === rule.id}>
                                {savingRuleId === rule.id ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                              </Button>
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                onClick={() => {
                                  setEditingRuleId('');
                                  setRuleEdits((current) => {
                                    const next = { ...current };
                                    delete next[rule.id];
                                    return next;
                                  });
                                }}
                              >
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
                            <span className={rule.enabled ? 'text-emerald-600' : 'text-muted-foreground'}>
                              {rule.enabled ? 'Si' : 'No'}
                            </span>
                            <div className="flex justify-end gap-1">
                              <Button size="icon-sm" variant="ghost" onClick={() => startEditRule(rule)} title="Editar regla">
                                <Edit2 className="size-4" />
                              </Button>
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                onClick={() => deleteRule(rule.id)}
                                disabled={savingRuleId === rule.id}
                                title="Borrar regla"
                              >
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
            )}
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
