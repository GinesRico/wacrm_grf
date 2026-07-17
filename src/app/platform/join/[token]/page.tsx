"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

export default function PlatformJoinPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function redeem() {
    setLoading(true);
    try {
      const res = await fetch(`/api/platform/account-invites/${params.token}/redeem`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) {
        toast.error("Sign in or create your account first, then return to this link.");
        return;
      }
      if (!res.ok) throw new Error(body.error ?? "Could not accept invitation");
      toast.success("Company account activated.");
      router.push("/dashboard");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not accept invitation.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-md bg-primary/10 text-primary">
          <ShieldCheck className="size-6" />
        </div>
        <h1 className="mt-4 text-lg font-semibold">Activate company account</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sign in with the invited owner email, then accept this platform invitation.
        </p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button onClick={redeem} disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : null}
            Accept invitation
          </Button>
          <Button variant="outline" render={<Link href={`/login`} />}>
            Sign in
          </Button>
        </div>
      </div>
    </main>
  );
}
