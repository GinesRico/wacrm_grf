"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CreditCard, Loader2, PlugZap, Save } from "lucide-react";

import { RequireRole } from "@/components/auth/require-role";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SettingsPanelHead } from "./settings-panel-head";
import { createClient } from "@/lib/supabase/client";
import { extractVariableIndices } from "@/lib/whatsapp/template-validators";
import type { MessageTemplate } from "@/types";

interface AppsResponse {
  apps: Array<{
    slug: string;
    name: string;
    category: string;
    description: string | null;
    connection: {
      enabled: boolean;
      status: string;
      last_error: string | null;
      config: {
        base_url?: string;
        auth_header?: "authorization_bearer" | "x_api_key";
        default_message?: string;
        delivery_mode?: "text" | "template";
        template_name?: string;
        template_language?: string;
        template_body_params?: Record<string, PaymentTemplateValueSource>;
        template_button_params?: Record<string, PaymentTemplateValueSource>;
      };
    } | null;
  }>;
}

type PaymentTemplateValueSource =
  | "payment_url"
  | "payment_url_token"
  | "order_id"
  | "amount_eur"
  | "amount_eur_number"
  | "amount_cents"
  | "concept"
  | "email"
  | "phone";

const DEFAULT_BASE_URL = "https://pagos.arvera.es/api";
const DEFAULT_MESSAGE = "Aqui tienes tu enlace de pago: {{payment_url}}";
const TEMPLATE_VALUE_SOURCES: Array<{
  value: PaymentTemplateValueSource;
  label: string;
}> = [
  { value: "concept", label: "Concepto / pedido manual" },
  { value: "amount_eur_number", label: "Importe EUR sin simbolo" },
  { value: "amount_eur", label: "Importe EUR con simbolo" },
  { value: "order_id", label: "ID generado por Arvera" },
  { value: "payment_url_token", label: "Token del enlace Redsys" },
  { value: "payment_url", label: "Enlace completo" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Telefono" },
  { value: "amount_cents", label: "Importe en centimos" },
];

export function AppsSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState("");
  const [authHeader, setAuthHeader] =
    useState<"authorization_bearer" | "x_api_key">("authorization_bearer");
  const [defaultMessage, setDefaultMessage] = useState(DEFAULT_MESSAGE);
  const [deliveryMode, setDeliveryMode] = useState<"text" | "template">("text");
  const [templateValue, setTemplateValue] = useState("");
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [bodyParamMap, setBodyParamMap] = useState<
    Record<string, PaymentTemplateValueSource>
  >({});
  const [buttonParamMap, setButtonParamMap] = useState<
    Record<string, PaymentTemplateValueSource>
  >({});
  const [status, setStatus] = useState("not_configured");
  const [lastError, setLastError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/integrations/apps", { cache: "no-store" });
      const payload = (await res.json().catch(() => ({}))) as AppsResponse;
      if (!res.ok) {
        toast.error("No se pudieron cargar las apps");
        return;
      }
      const app = payload.apps.find((item) => item.slug === "arvera-payments");
      const conn = app?.connection;
      setEnabled(Boolean(conn?.enabled));
      setStatus(conn?.status ?? "not_configured");
      setLastError(conn?.last_error ?? null);
      setBaseUrl(conn?.config?.base_url ?? DEFAULT_BASE_URL);
      setAuthHeader(conn?.config?.auth_header ?? "authorization_bearer");
      setDefaultMessage(conn?.config?.default_message ?? DEFAULT_MESSAGE);
      setDeliveryMode(conn?.config?.delivery_mode === "template" ? "template" : "text");
      setTemplateValue(
        conn?.config?.template_name
          ? `${conn.config.template_name}::${conn.config.template_language ?? "en_US"}`
          : "",
      );
      setBodyParamMap(conn?.config?.template_body_params ?? {});
      setButtonParamMap(conn?.config?.template_button_params ?? {});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("message_templates")
        .select("*")
        .eq("status", "APPROVED")
        .order("name");
      if (!cancelled) setTemplates((data as MessageTemplate[] | null) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedTemplate = useMemo(() => {
    const [templateName, templateLanguage] = templateValue.split("::");
    if (!templateName) return null;
    return (
      templates.find(
        (template) =>
          template.name === templateName &&
          (template.language ?? "en_US") === (templateLanguage || "en_US"),
      ) ?? null
    );
  }, [templateValue, templates]);

  const bodyVariables = useMemo(
    () => (selectedTemplate ? extractVariableIndices(selectedTemplate.body_text) : []),
    [selectedTemplate],
  );

  const urlButtonSlots = useMemo(
    () =>
      selectedTemplate?.buttons
        ?.map((button, index) => ({ button, index }))
        .filter(
          ({ button }) =>
            button.type === "URL" &&
            extractVariableIndices(button.url ?? "").length > 0,
        ) ?? [],
    [selectedTemplate],
  );

  useEffect(() => {
    if (deliveryMode !== "template" || !selectedTemplate) return;
    setBodyParamMap((current) => {
      let changed = false;
      const next = { ...current };
      bodyVariables.forEach((variable, index) => {
        const key = String(variable);
        if (!next[key]) {
          next[key] =
            index === 0
              ? "concept"
              : index === 1
                ? "amount_eur_number"
                : "payment_url";
          changed = true;
        }
      });
      return changed ? next : current;
    });
    setButtonParamMap((current) => {
      let changed = false;
      const next = { ...current };
      urlButtonSlots.forEach(({ index }) => {
        const key = String(index);
        if (!next[key]) {
          next[key] = "payment_url_token";
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [bodyVariables, deliveryMode, selectedTemplate, urlButtonSlots]);

  async function save() {
    setSaving(true);
    const [templateName, templateLanguage] = templateValue.split("::");
    try {
      const res = await fetch("/api/integrations/connections/arvera-payments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          base_url: baseUrl,
          api_key: apiKey || undefined,
          auth_header: authHeader,
          default_message: defaultMessage,
          delivery_mode: deliveryMode,
          template_name: deliveryMode === "template" ? templateName : undefined,
          template_language:
            deliveryMode === "template" ? templateLanguage || "en_US" : undefined,
          template_body_params:
            deliveryMode === "template" ? pickKnownKeys(bodyParamMap, bodyVariables) : {},
          template_button_params:
            deliveryMode === "template"
              ? pickKnownKeys(
                  buttonParamMap,
                  urlButtonSlots.map(({ index }) => index),
                )
              : {},
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || "No se pudo guardar Pagos Arvera");
        return;
      }
      setApiKey("");
      toast.success("Pagos Arvera guardado");
      window.dispatchEvent(new Event("arvera-payments-connection-updated"));
      void load();
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
        title="Apps"
        description="Activa integraciones por empresa. Las apps activas aparecen en el menu lateral, la bandeja y automatizaciones."
      />

      <Card>
        <CardContent className="space-y-5 p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <CreditCard className="size-5" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold text-foreground">
                    Pagos Arvera
                  </h2>
                  <Badge className="border-border bg-muted text-muted-foreground">
                    {enabled ? "Activa" : "Inactiva"}
                  </Badge>
                  {status === "error" && (
                    <Badge className="border-red-500/40 bg-red-500/10 text-red-300">
                      Error
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Crea enlaces de pago de Redsys desde la bandeja y automatizaciones.
                </p>
                {lastError && (
                  <p className="mt-1 text-xs text-red-300">{lastError}</p>
                )}
              </div>
            </div>
            <RequireRole min="admin">
              <div className="flex items-center gap-2">
                <PlugZap className="size-4 text-muted-foreground" />
                <Switch checked={enabled} onCheckedChange={setEnabled} />
              </div>
            </RequireRole>
          </div>

          <RequireRole min="admin">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Base URL</Label>
                <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>API key</Label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Dejar vacio para mantener la actual"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Cabecera de autenticacion</Label>
                <select
                  value={authHeader}
                  onChange={(e) =>
                    setAuthHeader(
                      e.target.value === "x_api_key"
                        ? "x_api_key"
                        : "authorization_bearer",
                    )
                  }
                  className="h-10 w-full rounded-md border border-border bg-muted px-3 text-sm text-foreground"
                >
                  <option value="authorization_bearer">Authorization: Bearer</option>
                  <option value="x_api_key">x-api-key</option>
                </select>
              </div>
              <div className="space-y-1.5 lg:col-span-2">
                <Label>Forma de envio</Label>
                <select
                  value={deliveryMode}
                  onChange={(e) =>
                    setDeliveryMode(e.target.value === "template" ? "template" : "text")
                  }
                  className="h-10 w-full rounded-md border border-border bg-muted px-3 text-sm text-foreground"
                >
                  <option value="text">Mensaje de texto</option>
                  <option value="template">Plantilla de Meta</option>
                </select>
              </div>
              {deliveryMode === "template" ? (
                <>
                  <div className="space-y-1.5 lg:col-span-2">
                    <Label>Plantilla para enviar enlace</Label>
                    <select
                      value={templateValue}
                      onChange={(e) => setTemplateValue(e.target.value)}
                      className="h-10 w-full rounded-md border border-border bg-muted px-3 text-sm text-foreground"
                    >
                      <option value="">Selecciona una plantilla aprobada</option>
                      {templates.map((template) => {
                        const lang = template.language ?? "en_US";
                        return (
                          <option key={template.id} value={`${template.name}::${lang}`}>
                            {template.name} ({lang})
                          </option>
                        );
                      })}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      Para botones Redsys, configura en Meta una URL como{" "}
                      https://sis.redsys.es/sis/p2f?t={"{{1}}"} y mapea ese boton a
                      Token del enlace Redsys.
                    </p>
                  </div>

                  {selectedTemplate && (
                    <div className="space-y-4 rounded-md border border-border bg-muted/30 p-4 lg:col-span-2">
                      <div>
                        <h3 className="text-sm font-medium text-foreground">
                          Variables de la plantilla
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Indica que dato de Pagos Arvera rellena cada variable de
                          Meta.
                        </p>
                      </div>

                      {bodyVariables.length > 0 && (
                        <div className="grid gap-3 md:grid-cols-2">
                          {bodyVariables.map((variable) => (
                            <TemplateSourceSelect
                              key={`body-${variable}`}
                              label={`Cuerpo {{${variable}}}`}
                              value={bodyParamMap[String(variable)]}
                              onChange={(value) =>
                                setBodyParamMap((current) => ({
                                  ...current,
                                  [String(variable)]: value,
                                }))
                              }
                            />
                          ))}
                        </div>
                      )}

                      {urlButtonSlots.length > 0 && (
                        <div className="grid gap-3 md:grid-cols-2">
                          {urlButtonSlots.map(({ button, index }) => (
                            <TemplateSourceSelect
                              key={`button-${index}`}
                              label={`Boton ${index + 1}: ${button.text || "URL"}`}
                              value={buttonParamMap[String(index)]}
                              onChange={(value) =>
                                setButtonParamMap((current) => ({
                                  ...current,
                                  [String(index)]: value,
                                }))
                              }
                            />
                          ))}
                        </div>
                      )}

                      {bodyVariables.length === 0 && urlButtonSlots.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          Esta plantilla no tiene variables dinamicas detectadas.
                        </p>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="space-y-1.5 lg:col-span-2">
                  <Label>Mensaje por defecto</Label>
                  <Textarea
                    value={defaultMessage}
                    onChange={(e) => setDefaultMessage(e.target.value)}
                    className="min-h-24"
                  />
                </div>
              )}
            </div>
            <div className="flex justify-end">
              <Button onClick={save} disabled={saving}>
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                Guardar app
              </Button>
            </div>
          </RequireRole>
        </CardContent>
      </Card>
    </section>
  );
}

function TemplateSourceSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: PaymentTemplateValueSource | undefined;
  onChange: (value: PaymentTemplateValueSource) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value as PaymentTemplateValueSource)}
        className="h-10 w-full rounded-md border border-border bg-muted px-3 text-sm text-foreground"
      >
        <option value="">Selecciona un dato</option>
        {TEMPLATE_VALUE_SOURCES.map((source) => (
          <option key={source.value} value={source.value}>
            {source.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function pickKnownKeys(
  map: Record<string, PaymentTemplateValueSource>,
  keys: number[],
): Record<string, PaymentTemplateValueSource> {
  const allowed = new Set(keys.map(String));
  return Object.fromEntries(
    Object.entries(map).filter(([key, value]) => allowed.has(key) && Boolean(value)),
  ) as Record<string, PaymentTemplateValueSource>;
}
