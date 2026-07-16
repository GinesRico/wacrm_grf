"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

interface AppsResponse {
  apps?: Array<{
    slug: string;
    connection?: {
      enabled?: boolean;
      config?: {
        iframe_url?: string;
      };
    } | null;
  }>;
}

export default function AppointmentsPage() {
  const [iframeUrl, setIframeUrl] = useState("https://citas.arvera.es/index.html");
  const [loading, setLoading] = useState(true);
  const [iframeLoaded, setIframeLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/integrations/apps", { cache: "no-store" });
        const payload = (await res.json().catch(() => ({}))) as AppsResponse;
        const app = payload.apps?.find((item) => item.slug === "arvera-appointments");
        if (!cancelled) {
          setIframeUrl(app?.connection?.config?.iframe_url ?? "https://citas.arvera.es/index.html");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="-m-4 flex h-[calc(100%+2rem)] flex-col bg-background sm:-m-6 sm:h-[calc(100%+3rem)]">
      <div className="relative min-h-0 flex-1">
        {!iframeLoaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-background">
            <div className="text-center">
              <Loader2 className="mx-auto size-6 animate-spin text-primary" />
              <p className="mt-2 text-sm text-muted-foreground">Cargando Citas Arvera...</p>
              <p className="mt-1 max-w-md text-xs text-muted-foreground">
                Si no aparece, revisa que Citas Arvera permita iframe desde este dominio.
              </p>
            </div>
          </div>
        )}
        <iframe
          src={iframeUrl}
          title="Citas Arvera"
          className="h-full w-full border-0"
          onLoad={() => setIframeLoaded(true)}
          allow="clipboard-read; clipboard-write"
        />
      </div>
    </div>
  );
}
