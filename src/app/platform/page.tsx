"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Building2, Copy, Loader2, Plus, RefreshCw, Shield } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

interface AccountRow {
  id: string;
  name: string;
  status: "trial" | "active" | "suspended" | "cancelled";
  plan: string;
  max_users: number;
  max_flows: number;
  max_automations: number;
  max_whatsapp_lines: number;
  allow_ai: boolean;
  allow_api: boolean;
  allow_broadcasts: boolean;
  usage: {
    users: number;
    flows: number;
    automations: number;
    whatsapp_lines: number;
  };
}

interface InviteRow {
  id: string;
  account_name: string;
  owner_email: string;
  plan: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
}

interface PlatformAdminRow {
  id: string;
  email: string;
  user_id: string | null;
  created_at: string;
}

const DEFAULT_FORM = {
  account_name: "",
  owner_email: "",
  plan: "starter",
  max_users: 3,
  max_flows: 5,
  max_automations: 5,
  max_whatsapp_lines: 1,
  allow_ai: false,
  allow_api: false,
  allow_broadcasts: true,
};

export default function PlatformPage() {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [admins, setAdmins] = useState<PlatformAdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [adminEmail, setAdminEmail] = useState("");
  const [form, setForm] = useState(DEFAULT_FORM);
  const [lastUrl, setLastUrl] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [accountsRes, invitesRes, adminsRes] = await Promise.all([
        fetch("/api/platform/accounts", { cache: "no-store" }),
        fetch("/api/platform/account-invites", { cache: "no-store" }),
        fetch("/api/platform/admins", { cache: "no-store" }),
      ]);
      if (accountsRes.status === 403 || invitesRes.status === 403 || adminsRes.status === 403) {
        toast.error("Hace falta acceso de superadmin de plataforma.");
        setAccounts([]);
        setInvites([]);
        setAdmins([]);
        return;
      }
      if (!accountsRes.ok || !invitesRes.ok || !adminsRes.ok) {
        throw new Error("No se pudieron cargar los datos de plataforma");
      }
      const accountsJson = await accountsRes.json();
      const invitesJson = await invitesRes.json();
      const adminsJson = await adminsRes.json();
      setAccounts(accountsJson.accounts ?? []);
      setInvites(invitesJson.invitations ?? []);
      setAdmins(adminsJson.admins ?? []);
    } catch (err) {
      console.error(err);
      toast.error("No se pudo cargar el panel de plataforma.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function createInvite() {
    setSaving(true);
    setLastUrl(null);
    try {
      const res = await fetch("/api/platform/account-invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "No se pudo crear la invitacion");
      setLastUrl(body.url);
      setForm(DEFAULT_FORM);
      toast.success("Invitacion de propietario creada.");
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo crear la invitacion.");
    } finally {
      setSaving(false);
    }
  }

  async function updateAccount(account: AccountRow, patch: Partial<AccountRow>) {
    const next = { ...account, ...patch };
    setAccounts((prev) => prev.map((row) => (row.id === account.id ? next : row)));
    const res = await fetch(`/api/platform/accounts/${account.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      toast.error("No se pudo actualizar la empresa.");
      void load();
      return;
    }
    toast.success("Empresa actualizada.");
  }

  async function addPlatformAdmin() {
    const email = adminEmail.trim().toLowerCase();
    if (!email) return;
    const res = await fetch("/api/platform/admins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? "No se pudo guardar el superadmin.");
      return;
    }
    setAdminEmail("");
    toast.success("Superadmin de plataforma guardado.");
    void load();
  }

  const pendingInvites = useMemo(
    () => invites.filter((invite) => !invite.accepted_at),
    [invites],
  );

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <Loader2 className="size-6 animate-spin text-primary" />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background px-6 py-6 text-foreground">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Shield className="size-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Plataforma</h1>
              <p className="text-sm text-muted-foreground">Empresas, invitaciones de propietario, planes y limites.</p>
            </div>
          </div>
          <Button variant="outline" onClick={load}>
            <RefreshCw className="size-4" />
            Actualizar
          </Button>
        </header>

        <section className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-4 flex items-center gap-2">
              <Plus className="size-4 text-primary" />
              <h2 className="text-sm font-semibold">Crear invitacion de empresa</h2>
            </div>
            <div className="space-y-3">
              <Input placeholder="Nombre de la empresa" value={form.account_name} onChange={(e) => setForm({ ...form, account_name: e.target.value })} />
              <Input placeholder="Email del propietario" value={form.owner_email} onChange={(e) => setForm({ ...form, owner_email: e.target.value })} />
              <Input placeholder="Plan" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })} />
              <div className="grid grid-cols-2 gap-2">
                <NumberInput label="Usuarios" value={form.max_users} onChange={(v) => setForm({ ...form, max_users: v })} />
                <NumberInput label="Flujos" value={form.max_flows} onChange={(v) => setForm({ ...form, max_flows: v })} />
                <NumberInput label="Automatizaciones" value={form.max_automations} onChange={(v) => setForm({ ...form, max_automations: v })} />
                <NumberInput label="Lineas WhatsApp" value={form.max_whatsapp_lines} onChange={(v) => setForm({ ...form, max_whatsapp_lines: v })} />
              </div>
              <FeatureToggle label="IA" checked={form.allow_ai} onChange={(v) => setForm({ ...form, allow_ai: v })} />
              <FeatureToggle label="Claves API" checked={form.allow_api} onChange={(v) => setForm({ ...form, allow_api: v })} />
              <FeatureToggle label="Difusiones" checked={form.allow_broadcasts} onChange={(v) => setForm({ ...form, allow_broadcasts: v })} />
              <Button onClick={createInvite} disabled={saving} className="w-full">
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                Crear invitacion de propietario
              </Button>
              {lastUrl ? (
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(lastUrl);
                    toast.success("Enlace de invitacion copiado.");
                  }}
                  className="flex w-full items-center gap-2 rounded-md border border-border bg-muted p-2 text-left text-xs text-muted-foreground"
                >
                  <Copy className="size-4 shrink-0" />
                  <span className="truncate">{lastUrl}</span>
                </button>
              ) : null}
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border p-4">
                <Building2 className="size-4 text-primary" />
                <h2 className="text-sm font-semibold">Empresas</h2>
              </div>
              <div className="divide-y divide-border">
                {accounts.map((account) => (
                  <AccountRowView key={account.id} account={account} onPatch={(patch) => updateAccount(account, patch)} />
                ))}
                {accounts.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Todavia no hay empresas.</p> : null}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-card">
              <div className="border-b border-border p-4">
                <h2 className="text-sm font-semibold">Invitaciones de propietario pendientes</h2>
              </div>
              <div className="divide-y divide-border">
                {pendingInvites.map((invite) => (
                  <div key={invite.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
                    <div>
                      <p className="font-medium">{invite.account_name}</p>
                      <p className="text-xs text-muted-foreground">{invite.owner_email} · {invite.plan}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">Caduca el {new Date(invite.expires_at).toLocaleDateString()}</p>
                  </div>
                ))}
                {pendingInvites.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No hay invitaciones pendientes.</p> : null}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-card">
              <div className="border-b border-border p-4">
                <h2 className="text-sm font-semibold">Superadmins de plataforma</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Usa aqui un usuario independiente de las empresas. Primero crea el usuario en Supabase Auth o deja que se registre, despues anade su email.
                </p>
              </div>
              <div className="space-y-3 p-4">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={adminEmail}
                    onChange={(e) => setAdminEmail(e.target.value)}
                    placeholder="admin-plataforma@tudominio.com"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void addPlatformAdmin();
                    }}
                  />
                  <Button onClick={addPlatformAdmin}>
                    <Plus className="size-4" />
                    Anadir
                  </Button>
                </div>
                <div className="divide-y divide-border rounded-md border border-border">
                  {admins.map((admin) => (
                    <div key={admin.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                      <span className="font-medium">{admin.email}</span>
                      <span className="text-xs text-muted-foreground">
                        {admin.user_id ? "Usuario vinculado" : "Pendiente de registro"}
                      </span>
                    </div>
                  ))}
                  {admins.length === 0 ? (
                    <p className="p-3 text-sm text-muted-foreground">
                      Aun no hay superadmins en la tabla. Se esta usando el bootstrap del entorno hasta crear el primero.
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function NumberInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="space-y-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <Input type="number" min={0} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function FeatureToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

function AccountRowView({ account, onPatch }: { account: AccountRow; onPatch: (patch: Partial<AccountRow>) => void }) {
  const [name, setName] = useState(account.name);

  function saveName() {
    const next = name.trim();
    if (!next || next === account.name) {
      setName(account.name);
      return;
    }
    onPatch({ name: next } as Partial<AccountRow>);
  }

  return (
    <div className="grid gap-3 p-4 text-sm xl:grid-cols-[minmax(180px,1fr)_140px_220px_220px] xl:items-center">
      <div className="min-w-0">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setName(account.name);
          }}
          aria-label="Nombre de la empresa"
          className="h-8 max-w-xs border-transparent bg-transparent px-0 font-medium hover:border-border hover:px-2 focus:px-2"
        />
        <p className="text-xs text-muted-foreground">{account.plan} · {statusLabel(account.status)}</p>
      </div>
      <select
        value={account.status}
        onChange={(e) => onPatch({ status: e.target.value as AccountRow["status"] })}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
      >
        <option value="trial">prueba</option>
        <option value="active">activa</option>
        <option value="suspended">suspendida</option>
        <option value="cancelled">cancelada</option>
      </select>
      <div className="grid grid-cols-4 gap-2">
        <LimitControl label="U" used={account.usage.users} max={account.max_users} onChange={(value) => onPatch({ max_users: value })} />
        <LimitControl label="F" used={account.usage.flows} max={account.max_flows} onChange={(value) => onPatch({ max_flows: value })} />
        <LimitControl label="A" used={account.usage.automations} max={account.max_automations} onChange={(value) => onPatch({ max_automations: value })} />
        <LimitControl label="W" used={account.usage.whatsapp_lines} max={account.max_whatsapp_lines} onChange={(value) => onPatch({ max_whatsapp_lines: value })} />
      </div>
      <div className="flex flex-wrap gap-2">
        <MiniToggle label="IA" checked={account.allow_ai} onChange={(v) => onPatch({ allow_ai: v })} />
        <MiniToggle label="API" checked={account.allow_api} onChange={(v) => onPatch({ allow_api: v })} />
        <MiniToggle label="BC" checked={account.allow_broadcasts} onChange={(v) => onPatch({ allow_broadcasts: v })} />
      </div>
    </div>
  );
}

function statusLabel(status: AccountRow["status"]): string {
  switch (status) {
    case "trial":
      return "prueba";
    case "active":
      return "activa";
    case "suspended":
      return "suspendida";
    case "cancelled":
      return "cancelada";
  }
}

function LimitControl({ label, used, max, onChange }: { label: string; used: number; max: number; onChange: (value: number) => void }) {
  return (
    <label className="rounded-md border border-border px-2 py-1 text-center text-xs text-muted-foreground" title={label}>
      <span>{label} {used}/</span>
      <input
        className="ml-1 w-8 bg-transparent text-foreground outline-none"
        type="number"
        min={label === "U" ? 1 : 0}
        value={max}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function MiniToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`rounded-md border px-2 py-1 text-xs ${checked ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
    >
      {label}
    </button>
  );
}
