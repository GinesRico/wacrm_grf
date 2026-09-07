'use client';

import { useCallback, useEffect, useState } from 'react';
import { FolderPlus, Loader2, Save, ShieldCheck, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SettingsPanelHead } from './settings-panel-head';

interface AdminState {
  accounts: Array<{ id: string; label: string; email_address: string; status: string; last_error: string | null; last_synced_at: string | null }>;
  mailboxes: Array<{ id: string; address: string; display_name: string | null; kind: string }>;
  folders: Array<{ id: string; mailbox_id: string; name: string; kind: string }>;
  permissions: Array<{ id: string; department_id: string; mailbox_id: string; folder_id: string | null; can_read: boolean; can_move: boolean; can_classify: boolean; can_send: boolean }>;
  departments: Array<{ id: string; name: string; color: string }>;
  rules: Array<{ id: string; name: string; value: string; field: string; enabled: boolean }>;
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
  const [rulesSource, setRulesSource] = useState('');
  const [form, setForm] = useState({
    label: '',
    email_address: '',
    imap_host: 'serviciodecorreo.es',
    imap_port: '993',
    imap_secure: true,
    imap_user: '',
    imap_password: '',
    smtp_host: 'serviciodecorreo.es',
    smtp_port: '465',
    smtp_secure: true,
    smtp_user: '',
    smtp_password: '',
    sync_mailbox: 'INBOX',
    mailbox_kind: 'shared',
  });

  const firstMailboxId = state.mailboxes[0]?.id ?? '';
  const firstDepartmentId = state.departments[0]?.id ?? '';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/email/admin', { cache: 'no-store' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'No se pudo cargar Email');
      setState({ ...emptyState, ...payload });
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
          <CardTitle className="text-base">Nuevo buzon IMAP/SMTP</CardTitle>
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
            <Button onClick={createAccount} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              Guardar buzon
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
              <div key={account.id} className="rounded-md border border-border p-3 text-sm">
                <div className="font-medium">{account.label} · {account.email_address}</div>
                <div className="text-xs text-muted-foreground">
                  {account.status}{account.last_synced_at ? ` · ${new Date(account.last_synced_at).toLocaleString()}` : ''}
                </div>
                {account.last_error && <div className="mt-1 text-xs text-destructive">{account.last_error}</div>}
              </div>
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
          <p className="text-sm text-muted-foreground">{state.rules.length} reglas guardadas.</p>
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
