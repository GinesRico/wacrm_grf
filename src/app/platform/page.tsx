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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [lastUrl, setLastUrl] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [accountsRes, invitesRes] = await Promise.all([
        fetch("/api/platform/accounts", { cache: "no-store" }),
        fetch("/api/platform/account-invites", { cache: "no-store" }),
      ]);
      if (accountsRes.status === 403 || invitesRes.status === 403) {
        toast.error("Platform admin access required.");
        setAccounts([]);
        setInvites([]);
        return;
      }
      if (!accountsRes.ok || !invitesRes.ok) throw new Error("Failed to load platform data");
      const accountsJson = await accountsRes.json();
      const invitesJson = await invitesRes.json();
      setAccounts(accountsJson.accounts ?? []);
      setInvites(invitesJson.invitations ?? []);
    } catch (err) {
      console.error(err);
      toast.error("Could not load platform dashboard.");
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
      if (!res.ok) throw new Error(body.error ?? "Failed to create invitation");
      setLastUrl(body.url);
      setForm(DEFAULT_FORM);
      toast.success("Owner invitation created.");
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create invitation.");
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
      toast.error("Could not update account.");
      void load();
      return;
    }
    toast.success("Account updated.");
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
              <h1 className="text-xl font-semibold">Platform</h1>
              <p className="text-sm text-muted-foreground">SaaS accounts, owner invitations, plans and limits.</p>
            </div>
          </div>
          <Button variant="outline" onClick={load}>
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        </header>

        <section className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-4 flex items-center gap-2">
              <Plus className="size-4 text-primary" />
              <h2 className="text-sm font-semibold">Create company invite</h2>
            </div>
            <div className="space-y-3">
              <Input placeholder="Company name" value={form.account_name} onChange={(e) => setForm({ ...form, account_name: e.target.value })} />
              <Input placeholder="Owner email" value={form.owner_email} onChange={(e) => setForm({ ...form, owner_email: e.target.value })} />
              <Input placeholder="Plan" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })} />
              <div className="grid grid-cols-2 gap-2">
                <NumberInput label="Users" value={form.max_users} onChange={(v) => setForm({ ...form, max_users: v })} />
                <NumberInput label="Flows" value={form.max_flows} onChange={(v) => setForm({ ...form, max_flows: v })} />
                <NumberInput label="Automations" value={form.max_automations} onChange={(v) => setForm({ ...form, max_automations: v })} />
                <NumberInput label="WhatsApp lines" value={form.max_whatsapp_lines} onChange={(v) => setForm({ ...form, max_whatsapp_lines: v })} />
              </div>
              <FeatureToggle label="AI" checked={form.allow_ai} onChange={(v) => setForm({ ...form, allow_ai: v })} />
              <FeatureToggle label="API keys" checked={form.allow_api} onChange={(v) => setForm({ ...form, allow_api: v })} />
              <FeatureToggle label="Broadcasts" checked={form.allow_broadcasts} onChange={(v) => setForm({ ...form, allow_broadcasts: v })} />
              <Button onClick={createInvite} disabled={saving} className="w-full">
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                Create owner invite
              </Button>
              {lastUrl ? (
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(lastUrl);
                    toast.success("Invitation URL copied.");
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
                <h2 className="text-sm font-semibold">Companies</h2>
              </div>
              <div className="divide-y divide-border">
                {accounts.map((account) => (
                  <AccountRowView key={account.id} account={account} onPatch={(patch) => updateAccount(account, patch)} />
                ))}
                {accounts.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No companies yet.</p> : null}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-card">
              <div className="border-b border-border p-4">
                <h2 className="text-sm font-semibold">Pending owner invitations</h2>
              </div>
              <div className="divide-y divide-border">
                {pendingInvites.map((invite) => (
                  <div key={invite.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
                    <div>
                      <p className="font-medium">{invite.account_name}</p>
                      <p className="text-xs text-muted-foreground">{invite.owner_email} · {invite.plan}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">Expires {new Date(invite.expires_at).toLocaleDateString()}</p>
                  </div>
                ))}
                {pendingInvites.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No pending invitations.</p> : null}
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
  return (
    <div className="grid gap-3 p-4 text-sm xl:grid-cols-[minmax(180px,1fr)_140px_220px_220px] xl:items-center">
      <div className="min-w-0">
        <p className="truncate font-medium">{account.name}</p>
        <p className="text-xs text-muted-foreground">{account.plan} · {account.status}</p>
      </div>
      <select
        value={account.status}
        onChange={(e) => onPatch({ status: e.target.value as AccountRow["status"] })}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
      >
        <option value="trial">trial</option>
        <option value="active">active</option>
        <option value="suspended">suspended</option>
        <option value="cancelled">cancelled</option>
      </select>
      <div className="grid grid-cols-4 gap-2">
        <LimitControl label="U" used={account.usage.users} max={account.max_users} onChange={(value) => onPatch({ max_users: value })} />
        <LimitControl label="F" used={account.usage.flows} max={account.max_flows} onChange={(value) => onPatch({ max_flows: value })} />
        <LimitControl label="A" used={account.usage.automations} max={account.max_automations} onChange={(value) => onPatch({ max_automations: value })} />
        <LimitControl label="W" used={account.usage.whatsapp_lines} max={account.max_whatsapp_lines} onChange={(value) => onPatch({ max_whatsapp_lines: value })} />
      </div>
      <div className="flex flex-wrap gap-2">
        <MiniToggle label="AI" checked={account.allow_ai} onChange={(v) => onPatch({ allow_ai: v })} />
        <MiniToggle label="API" checked={account.allow_api} onChange={(v) => onPatch({ allow_api: v })} />
        <MiniToggle label="BC" checked={account.allow_broadcasts} onChange={(v) => onPatch({ allow_broadcasts: v })} />
      </div>
    </div>
  );
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
