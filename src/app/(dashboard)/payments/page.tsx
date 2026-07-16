"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CreditCard, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

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

export default function PaymentsPage() {
  const [payments, setPayments] = useState<PaymentLink[]>([]);
  const [status, setStatus] = useState<(typeof STATUS)[number]>("all");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);

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
              {item === "all" ? "Todos" : item}
            </button>
          ))}
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
                    <Badge className="border-border bg-muted text-muted-foreground">
                      {payment.status}
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
    </div>
  );
}
