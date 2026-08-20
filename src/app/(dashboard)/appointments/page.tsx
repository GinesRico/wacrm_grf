"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

interface EmbedTokenResponse {
  iframe_url?: string;
  expires_in?: number;
  error?: string;
  detail?: string;
}

export default function AppointmentsPage() {
  const [iframeUrl, setIframeUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    async function loadEmbed() {
      try {
        setError("");
        const res = await fetch("/api/appointments/embed-token?mode=calendario", {
          cache: "no-store",
        });
        const payload = (await res.json().catch(() => ({}))) as EmbedTokenResponse;
        if (!res.ok || !payload.iframe_url) {
          throw new Error(
            payload.error || payload.detail || "No se pudo cargar Citas Arvera",
          );
        }
        if (!cancelled) {
          setIframeLoaded(false);
          setIframeUrl(payload.iframe_url);
          if (payload.expires_in && payload.expires_in > 300) {
            refreshTimer = setTimeout(loadEmbed, (payload.expires_in - 300) * 1000);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "No se pudo cargar Citas Arvera");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadEmbed();

    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-md border border-destructive/30 bg-destructive/10 p-4 text-center">
          <h2 className="text-sm font-semibold text-foreground">No se pudo cargar Citas Arvera</h2>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        </div>
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
                Preparando el acceso temporal al calendario.
              </p>
            </div>
          </div>
        )}
        {iframeUrl && (
          <iframe
            src={iframeUrl}
            title="Calendario de citas"
            className="h-full w-full border-0"
            onLoad={() => setIframeLoaded(true)}
            allow="clipboard-read; clipboard-write"
          />
        )}
      </div>
    </div>
  );
}
