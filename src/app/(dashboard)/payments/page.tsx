"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CreditCard, ExternalLink, Loader2, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface PaymentLink {
  id: string;
  amount_cents: number;
  currency: string;
  concept: string;
  email: string | null;
  phone: string | null;
  order_id: string;
  payment_url: string;
  status: "pending" | "paid" | "failed" | "expired" | "cancelled";
  created_at: string;
  contact?: { id: string; name: string | null; phone: string | null } | null;
  conversation_id?: string | null;
}

const STATUS = ["all", "pending", "paid", "failed"] as const;
const STATUS_LABELS: Record<(typeof STATUS)[number], string> = {
  all: "Todos",
  pending: "Pendientes",
  paid: "Pagados",
  failed: "Fallidos",
};
const PAYMENT_STATUS_LABELS: Record<PaymentLink["status"], string> = {
  pending: "Pendiente",
  paid: "Pagado",
  failed: "Fallido",
  expired: "Caducado",
  cancelled: "Cancelado",
};
const PAYMENT_STATUS_CLASSES: Record<PaymentLink["status"], string> = {
  pending: "border-amber-200 bg-amber-50 text-amber-700",
  paid: "border-emerald-200 bg-emerald-50 text-emerald-700",
  failed: "border-red-200 bg-red-50 text-red-700",
  expired: "border-slate-200 bg-slate-50 text-slate-700",
  cancelled: "border-slate-200 bg-slate-50 text-slate-700",
};

export default function PaymentsPage() {
  const [payments, setPayments] = useState<PaymentLink[]>([]);
  const [status, setStatus] = useState<(typeof STATUS)[number]>("all");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [amount, setAmount] = useState("");
  const [concept, setConcept] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/payments?status=${status}`, { cache: "no-store" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || "No se pudieron cargar los pagos");
        return;
      }
      setPayments(payload.payments ?? []);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function syncPayment(payment: PaymentLink) {
    setSyncing(payment.id);
    try {
      const res = await fetch("/api/integrations/arvera-payments/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payment_link_id: payment.id }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || "No se pudo sincronizar");
        return;
      }
      toast.success(payload.changed ? "Estado actualizado" : "Sin cambios");
      void load();
    } finally {
      setSyncing(null);
    }
  }

  async function createPayment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountNumber = Number(amount.replace(",", "."));
    const conceptText = concept.trim();
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      toast.error("Introduce un importe valido");
      return;
    }
    if (!conceptText) {
      toast.error("Introduce un concepto");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/integrations/arvera-payments/payment-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount_eur: amountNumber,
          concept: conceptText,
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || "No se pudo crear el pago");
        return;
      }
      toast.success("Pago creado");
      setCreateOpen(false);
      setAmount("");
      setConcept("");
      setEmail("");
      setPhone("");
      setStatus("all");
      void load();
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Pagos
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Enlaces generados con Pagos Arvera.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            Crear pago
          </Button>
          <div className="flex flex-wrap gap-1">
            {STATUS.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setStatus(item)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                  status === item
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                {STATUS_LABELS[item]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : payments.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <CreditCard className="size-7 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">
              Aun no hay enlaces de pago.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Concepto</th>
                <th className="px-4 py-3">Contacto</th>
                <th className="px-4 py-3">Importe</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Orden</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card">
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-foreground">{payment.concept}</div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(payment.created_at).toLocaleString()}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {payment.contact?.name || payment.contact?.phone || payment.phone || "-"}
                  </td>
                  <td className="px-4 py-3 text-foreground">
                    {(payment.amount_cents / 100).toFixed(2)} {payment.currency}
                  </td>
                  <td className="px-4 py-3">
                    <Badge className={PAYMENT_STATUS_CLASSES[payment.status]}>
                      {PAYMENT_STATUS_LABELS[payment.status]}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {payment.order_id}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => syncPayment(payment)}
                        disabled={syncing === payment.id}
                      >
                        {syncing === payment.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <RefreshCw className="size-4" />
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        nativeButton={false}
                        render={
                          <a href={payment.payment_url} target="_blank" rel="noreferrer" />
                        }
                      >
                        <ExternalLink className="size-4" />
                      </Button>
                      {payment.conversation_id && (
                        <Button
                          size="sm"
                          variant="outline"
                          nativeButton={false}
                          render={<Link href={`/inbox?c=${payment.conversation_id}`} />}
                        >
                          Chat
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Crear pago</DialogTitle>
          </DialogHeader>
          <form onSubmit={createPayment} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="payment-amount">Importe EUR</Label>
                <Input
                  id="payment-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="121.00"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="payment-concept">Concepto</Label>
                <Input
                  id="payment-concept"
                  value={concept}
                  onChange={(event) => setConcept(event.target.value)}
                  placeholder="Factura 1074"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="payment-email">Email</Label>
                <Input
                  id="payment-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="cliente@example.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="payment-phone">Telefono</Label>
                <Input
                  id="payment-phone"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="600123456"
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={creating}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? <Loader2 className="size-4 animate-spin" /> : null}
                Crear pago
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
