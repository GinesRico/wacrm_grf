"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarClock, Copy, CreditCard, Loader2, PlugZap, Save } from "lucide-react";

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
        delivery_mode?: "text" | "template" | "cta_url";
        cta_button_label?: string;
        cta_url_template?: string;
        template_name?: string;
        template_language?: string;
        template_body_params?: Record<string, PaymentTemplateValueSource>;
        template_button_params?: Record<string, PaymentTemplateValueSource>;
        iframe_url?: string;
        public_booking_url?: string;
        default_send_mode?: "booking_link" | "interactive_list" | "cta_url";
        default_days_ahead?: number;
        duracion?: number;
        timezone?: string;
        default_service?: string;
        list_header?: string;
        list_body?: string;
        list_footer?: string;
        list_button_label?: string;
        list_section_title?: string;
        list_row_title?: string;
        list_row_description?: string;
      };
    } | null;
  }>;
}

interface AppointmentsConnectionResponse {
  webhook_url?: string | null;
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
const DEFAULT_PAYMENT_CTA_MESSAGE = "Aqui tienes tu enlace de pago.";
const DEFAULT_PAYMENT_CTA_BUTTON = "Pagar ahora";
const DEFAULT_PAYMENT_CTA_URL = "{{payment_url}}";
const APPOINTMENTS_DEFAULT_BASE_URL = "https://citas.arvera.es";
const APPOINTMENTS_DEFAULT_IFRAME_URL = "https://citas.arvera.es/index.html";
const APPOINTMENTS_DEFAULT_PUBLIC_BOOKING_URL = "https://citas.arvera.es/reservas.html";
const APPOINTMENTS_DEFAULT_MESSAGE = "{{mensaje}}";
const APPOINTMENTS_DEFAULT_CTA_MESSAGE =
  "*Citas disponibles para {{fecha_texto}}*\n\nHoras libres:\n{{slots}}\n\nPulsa el boton para reservar.";
const APPOINTMENTS_DEFAULT_CTA_BUTTON = "Reservar cita";
const APPOINTMENTS_DEFAULT_CTA_URL = "{{short_url}}";
const APPOINTMENTS_DEFAULT_LIST_HEADER = "Citas disponibles para {{dates_short}}";
const APPOINTMENTS_DEFAULT_LIST_BODY =
  "Haz click en el boton de abajo y selecciona una hora para agendar tu cita de {{service}}";
const APPOINTMENTS_DEFAULT_LIST_FOOTER = "Autorecambios Vera S.L";
const APPOINTMENTS_DEFAULT_LIST_BUTTON_LABEL = "Ver disponibles";
const APPOINTMENTS_DEFAULT_LIST_SECTION_TITLE = "{{weekday_upper}} {{day}} DE {{month_upper}}";
const APPOINTMENTS_DEFAULT_LIST_ROW_TITLE = "{{time}}";
const APPOINTMENTS_DEFAULT_LIST_ROW_DESCRIPTION = "{{service}}";
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
  const [deliveryMode, setDeliveryMode] = useState<"text" | "template" | "cta_url">("text");
  const [paymentCtaButtonLabel, setPaymentCtaButtonLabel] =
    useState(DEFAULT_PAYMENT_CTA_BUTTON);
  const [paymentCtaUrlTemplate, setPaymentCtaUrlTemplate] =
    useState(DEFAULT_PAYMENT_CTA_URL);
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
  const [appointmentsEnabled, setAppointmentsEnabled] = useState(false);
  const [appointmentsBaseUrl, setAppointmentsBaseUrl] = useState(APPOINTMENTS_DEFAULT_BASE_URL);
  const [appointmentsApiToken, setAppointmentsApiToken] = useState("");
  const [appointmentsIframeUrl, setAppointmentsIframeUrl] = useState(
    APPOINTMENTS_DEFAULT_IFRAME_URL,
  );
  const [appointmentsPublicBookingUrl, setAppointmentsPublicBookingUrl] = useState(
    APPOINTMENTS_DEFAULT_PUBLIC_BOOKING_URL,
  );
  const [appointmentsDaysAhead, setAppointmentsDaysAhead] = useState(1);
  const [appointmentsDuration, setAppointmentsDuration] = useState(45);
  const [appointmentsTimezone, setAppointmentsTimezone] = useState("Europe/Madrid");
  const [appointmentsService, setAppointmentsService] = useState("Cita taller");
  const [appointmentsMessage, setAppointmentsMessage] = useState(
    APPOINTMENTS_DEFAULT_MESSAGE,
  );
  const [appointmentsSendMode, setAppointmentsSendMode] =
    useState<"booking_link" | "interactive_list" | "cta_url">("booking_link");
  const [appointmentsCtaButtonLabel, setAppointmentsCtaButtonLabel] = useState(
    APPOINTMENTS_DEFAULT_CTA_BUTTON,
  );
  const [appointmentsCtaUrlTemplate, setAppointmentsCtaUrlTemplate] = useState(
    APPOINTMENTS_DEFAULT_CTA_URL,
  );
  const [appointmentsListHeader, setAppointmentsListHeader] = useState(
    APPOINTMENTS_DEFAULT_LIST_HEADER,
  );
  const [appointmentsListBody, setAppointmentsListBody] = useState(
    APPOINTMENTS_DEFAULT_LIST_BODY,
  );
  const [appointmentsListFooter, setAppointmentsListFooter] = useState(
    APPOINTMENTS_DEFAULT_LIST_FOOTER,
  );
  const [appointmentsListButtonLabel, setAppointmentsListButtonLabel] = useState(
    APPOINTMENTS_DEFAULT_LIST_BUTTON_LABEL,
  );
  const [appointmentsListSectionTitle, setAppointmentsListSectionTitle] = useState(
    APPOINTMENTS_DEFAULT_LIST_SECTION_TITLE,
  );
  const [appointmentsListRowTitle, setAppointmentsListRowTitle] = useState(
    APPOINTMENTS_DEFAULT_LIST_ROW_TITLE,
  );
  const [appointmentsListRowDescription, setAppointmentsListRowDescription] = useState(
    APPOINTMENTS_DEFAULT_LIST_ROW_DESCRIPTION,
  );
  const [appointmentsStatus, setAppointmentsStatus] = useState("not_configured");
  const [appointmentsLastError, setAppointmentsLastError] = useState<string | null>(null);
  const [appointmentsWebhookUrl, setAppointmentsWebhookUrl] = useState<string | null>(null);

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
      const loadedDeliveryMode =
        conn?.config?.delivery_mode === "template" || conn?.config?.delivery_mode === "cta_url"
          ? conn.config.delivery_mode
          : "text";
      setDefaultMessage(
        conn?.config?.default_message ??
          (loadedDeliveryMode === "cta_url" ? DEFAULT_PAYMENT_CTA_MESSAGE : DEFAULT_MESSAGE),
      );
      setDeliveryMode(loadedDeliveryMode);
      setPaymentCtaButtonLabel(
        conn?.config?.cta_button_label ?? DEFAULT_PAYMENT_CTA_BUTTON,
      );
      setPaymentCtaUrlTemplate(
        conn?.config?.cta_url_template ?? DEFAULT_PAYMENT_CTA_URL,
      );
      setTemplateValue(
        conn?.config?.template_name
          ? `${conn.config.template_name}::${conn.config.template_language ?? "en_US"}`
          : "",
      );
      setBodyParamMap(conn?.config?.template_body_params ?? {});
      setButtonParamMap(conn?.config?.template_button_params ?? {});
      const appointmentsApp = payload.apps.find(
        (item) => item.slug === "arvera-appointments",
      );
      const appointmentsConn = appointmentsApp?.connection;
      setAppointmentsEnabled(Boolean(appointmentsConn?.enabled));
      setAppointmentsStatus(appointmentsConn?.status ?? "not_configured");
      setAppointmentsLastError(appointmentsConn?.last_error ?? null);
      setAppointmentsBaseUrl(
        appointmentsConn?.config?.base_url ?? APPOINTMENTS_DEFAULT_BASE_URL,
      );
      setAppointmentsIframeUrl(
        appointmentsConn?.config?.iframe_url ?? APPOINTMENTS_DEFAULT_IFRAME_URL,
      );
      setAppointmentsPublicBookingUrl(
        appointmentsConn?.config?.public_booking_url ??
          APPOINTMENTS_DEFAULT_PUBLIC_BOOKING_URL,
      );
      setAppointmentsDaysAhead(appointmentsConn?.config?.default_days_ahead ?? 1);
      setAppointmentsDuration(appointmentsConn?.config?.duracion ?? 45);
      setAppointmentsTimezone(appointmentsConn?.config?.timezone ?? "Europe/Madrid");
      setAppointmentsService(appointmentsConn?.config?.default_service ?? "Cita taller");
      setAppointmentsMessage(
        appointmentsConn?.config?.default_message ?? APPOINTMENTS_DEFAULT_MESSAGE,
      );
      setAppointmentsSendMode(
        appointmentsConn?.config?.default_send_mode === "interactive_list" ||
          appointmentsConn?.config?.default_send_mode === "cta_url"
          ? appointmentsConn.config.default_send_mode
          : "booking_link",
      );
      setAppointmentsCtaButtonLabel(
        appointmentsConn?.config?.cta_button_label ?? APPOINTMENTS_DEFAULT_CTA_BUTTON,
      );
      setAppointmentsCtaUrlTemplate(
        appointmentsConn?.config?.cta_url_template ?? APPOINTMENTS_DEFAULT_CTA_URL,
      );
      setAppointmentsListHeader(
        appointmentsConn?.config?.list_header ?? APPOINTMENTS_DEFAULT_LIST_HEADER,
      );
      setAppointmentsListBody(
        appointmentsConn?.config?.list_body ?? APPOINTMENTS_DEFAULT_LIST_BODY,
      );
      setAppointmentsListFooter(
        appointmentsConn?.config?.list_footer ?? APPOINTMENTS_DEFAULT_LIST_FOOTER,
      );
      setAppointmentsListButtonLabel(
        appointmentsConn?.config?.list_button_label ?? APPOINTMENTS_DEFAULT_LIST_BUTTON_LABEL,
      );
      setAppointmentsListSectionTitle(
        appointmentsConn?.config?.list_section_title ?? APPOINTMENTS_DEFAULT_LIST_SECTION_TITLE,
      );
      setAppointmentsListRowTitle(
        appointmentsConn?.config?.list_row_title ?? APPOINTMENTS_DEFAULT_LIST_ROW_TITLE,
      );
      setAppointmentsListRowDescription(
        appointmentsConn?.config?.list_row_description ?? APPOINTMENTS_DEFAULT_LIST_ROW_DESCRIPTION,
      );
      const appointmentsRes = await fetch(
        "/api/integrations/connections/arvera-appointments",
        { cache: "no-store" },
      );
      if (appointmentsRes.ok) {
        const appointmentsPayload =
          (await appointmentsRes.json().catch(() => ({}))) as AppointmentsConnectionResponse;
        setAppointmentsWebhookUrl(appointmentsPayload.webhook_url ?? null);
      }
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
          cta_button_label: deliveryMode === "cta_url" ? paymentCtaButtonLabel : undefined,
          cta_url_template: deliveryMode === "cta_url" ? paymentCtaUrlTemplate : undefined,
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

  async function saveAppointments() {
    setSaving(true);
    try {
      const res = await fetch("/api/integrations/connections/arvera-appointments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: appointmentsEnabled,
          base_url: appointmentsBaseUrl,
          api_token: appointmentsApiToken || undefined,
          iframe_url: appointmentsIframeUrl,
          public_booking_url: appointmentsPublicBookingUrl,
          default_send_mode: appointmentsSendMode,
          default_days_ahead: appointmentsDaysAhead,
          duracion: appointmentsDuration,
          timezone: appointmentsTimezone,
          default_service: appointmentsService,
          default_message: appointmentsMessage,
          cta_button_label:
            appointmentsSendMode === "cta_url" ? appointmentsCtaButtonLabel : undefined,
          cta_url_template:
            appointmentsSendMode === "cta_url" ? appointmentsCtaUrlTemplate : undefined,
          list_header: appointmentsListHeader,
          list_body: appointmentsListBody,
          list_footer: appointmentsListFooter,
          list_button_label: appointmentsListButtonLabel,
          list_section_title: appointmentsListSectionTitle,
          list_row_title: appointmentsListRowTitle,
          list_row_description: appointmentsListRowDescription,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || "No se pudo guardar Citas Arvera");
        return;
      }
      setAppointmentsApiToken("");
      setAppointmentsWebhookUrl(payload.webhook_url ?? null);
      toast.success("Citas Arvera guardado");
      window.dispatchEvent(new Event("arvera-appointments-connection-updated"));
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
                  onChange={(e) => {
                    const mode =
                      e.target.value === "template" || e.target.value === "cta_url"
                        ? e.target.value
                        : "text";
                    setDeliveryMode(mode);
                    if (mode === "cta_url" && defaultMessage === DEFAULT_MESSAGE) {
                      setDefaultMessage(DEFAULT_PAYMENT_CTA_MESSAGE);
                    }
                  }}
                  className="h-10 w-full rounded-md border border-border bg-muted px-3 text-sm text-foreground"
                >
                  <option value="text">Mensaje de texto</option>
                  <option value="cta_url">Boton con URL</option>
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
                  <p className="text-xs text-muted-foreground">
                    Variables: {"{{payment_url}}"}, {"{{order_id}}"}, {"{{amount_eur}}"},{" "}
                    {"{{amount_eur_number}}"}, {"{{concept}}"}.
                  </p>
                </div>
              )}
              {deliveryMode === "cta_url" && (
                <>
                  <div className="space-y-1.5">
                    <Label>Texto del boton</Label>
                    <Input
                      value={paymentCtaButtonLabel}
                      maxLength={20}
                      onChange={(e) => setPaymentCtaButtonLabel(e.target.value)}
                      placeholder={DEFAULT_PAYMENT_CTA_BUTTON}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>URL del boton</Label>
                    <Input
                      value={paymentCtaUrlTemplate}
                      onChange={(e) => setPaymentCtaUrlTemplate(e.target.value)}
                      placeholder={DEFAULT_PAYMENT_CTA_URL}
                    />
                    <p className="text-xs text-muted-foreground">
                      Usa {"{{payment_url}}"} para abrir el enlace de Redsys.
                    </p>
                  </div>
                </>
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

      <Card>
        <CardContent className="space-y-5 p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <CalendarClock className="size-5" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold text-foreground">
                    Citas Arvera
                  </h2>
                  <Badge className="border-border bg-muted text-muted-foreground">
                    {appointmentsEnabled ? "Activa" : "Inactiva"}
                  </Badge>
                  {appointmentsStatus === "error" && (
                    <Badge className="border-red-500/40 bg-red-500/10 text-red-300">
                      Error
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Envia citas disponibles, recibe eventos y muestra el panel original.
                </p>
                {appointmentsLastError && (
                  <p className="mt-1 text-xs text-red-300">{appointmentsLastError}</p>
                )}
              </div>
            </div>
            <RequireRole min="admin">
              <div className="flex items-center gap-2">
                <PlugZap className="size-4 text-muted-foreground" />
                <Switch
                  checked={appointmentsEnabled}
                  onCheckedChange={setAppointmentsEnabled}
                />
              </div>
            </RequireRole>
          </div>

          <RequireRole min="admin">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Base URL</Label>
                <Input
                  value={appointmentsBaseUrl}
                  onChange={(e) => setAppointmentsBaseUrl(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>API token</Label>
                <Input
                  type="password"
                  value={appointmentsApiToken}
                  onChange={(e) => setAppointmentsApiToken(e.target.value)}
                  placeholder="Dejar vacio para mantener el actual"
                />
              </div>
              <div className="space-y-1.5">
                <Label>URL iframe panel</Label>
                <Input
                  value={appointmentsIframeUrl}
                  onChange={(e) => setAppointmentsIframeUrl(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>URL reservas publicas</Label>
                <Input
                  value={appointmentsPublicBookingUrl}
                  onChange={(e) => setAppointmentsPublicBookingUrl(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Dias adelante por defecto</Label>
                <Input
                  type="number"
                  min={0}
                  value={appointmentsDaysAhead}
                  onChange={(e) => setAppointmentsDaysAhead(Number(e.target.value))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Duracion cita</Label>
                <Input
                  type="number"
                  min={1}
                  value={appointmentsDuration}
                  onChange={(e) => setAppointmentsDuration(Number(e.target.value))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Timezone</Label>
                <Input
                  value={appointmentsTimezone}
                  onChange={(e) => setAppointmentsTimezone(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Servicio por defecto</Label>
                <Input
                  value={appointmentsService}
                  onChange={(e) => setAppointmentsService(e.target.value)}
                />
              </div>
              <div className="space-y-1.5 lg:col-span-2">
                <Label>Forma de envio</Label>
                <select
                  value={appointmentsSendMode}
                  onChange={(e) => {
                    const mode =
                      e.target.value === "interactive_list" || e.target.value === "cta_url"
                        ? e.target.value
                        : "booking_link";
                    setAppointmentsSendMode(mode);
                    if (mode === "cta_url" && appointmentsMessage === APPOINTMENTS_DEFAULT_MESSAGE) {
                      setAppointmentsMessage(APPOINTMENTS_DEFAULT_CTA_MESSAGE);
                    }
                  }}
                  className="h-10 w-full rounded-md border border-border bg-muted px-3 text-sm text-foreground"
                >
                  <option value="booking_link">Mensaje de texto</option>
                  <option value="cta_url">Boton con URL</option>
                  <option value="interactive_list">Lista interactiva</option>
                </select>
              </div>
              <div className="space-y-1.5 lg:col-span-2">
                <Label>Mensaje por defecto</Label>
                <Textarea
                  value={appointmentsMessage}
                  onChange={(e) => setAppointmentsMessage(e.target.value)}
                  className="min-h-20"
                />
                <p className="text-xs text-muted-foreground">
                  Variables: {"{{mensaje}}"}, {"{{short_url}}"}, {"{{fecha_texto}}"},{" "}
                  {"{{service}}"}, {"{{slots}}"}.
                </p>
              </div>
              {appointmentsSendMode === "cta_url" && (
                <>
                  <div className="space-y-1.5">
                    <Label>Texto del boton</Label>
                    <Input
                      value={appointmentsCtaButtonLabel}
                      maxLength={20}
                      onChange={(e) => setAppointmentsCtaButtonLabel(e.target.value)}
                      placeholder={APPOINTMENTS_DEFAULT_CTA_BUTTON}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>URL del boton</Label>
                    <Input
                      value={appointmentsCtaUrlTemplate}
                      onChange={(e) => setAppointmentsCtaUrlTemplate(e.target.value)}
                      placeholder={APPOINTMENTS_DEFAULT_CTA_URL}
                    />
                    <p className="text-xs text-muted-foreground">
                      Usa {"{{short_url}}"} para abrir el enlace de reserva generado.
                    </p>
                  </div>
                </>
              )}
              {appointmentsSendMode === "interactive_list" && (
                <div className="space-y-4 rounded-md border border-border bg-muted/30 p-4 lg:col-span-2">
                  <div>
                    <h3 className="text-sm font-medium text-foreground">
                      Plantilla de lista interactiva
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      Variables: {"{{service}}"}, {"{{dates_short}}"}, {"{{dates_text}}"},{" "}
                      {"{{date}}"}, {"{{long_date}}"}, {"{{weekday}}"},{" "}
                      {"{{weekday_upper}}"}, {"{{day}}"}, {"{{month}}"},{" "}
                      {"{{month_upper}}"}, {"{{year}}"}, {"{{time}}"}, {"{{end}}"}.
                    </p>
                  </div>
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Encabezado</Label>
                      <Input
                        value={appointmentsListHeader}
                        maxLength={60}
                        onChange={(e) => setAppointmentsListHeader(e.target.value)}
                        placeholder={APPOINTMENTS_DEFAULT_LIST_HEADER}
                      />
                      <p className="text-xs text-muted-foreground">
                        {appointmentsListHeader.length}/60
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Etiqueta del boton de lista</Label>
                      <Input
                        value={appointmentsListButtonLabel}
                        maxLength={20}
                        onChange={(e) => setAppointmentsListButtonLabel(e.target.value)}
                        placeholder={APPOINTMENTS_DEFAULT_LIST_BUTTON_LABEL}
                      />
                      <p className="text-xs text-muted-foreground">
                        {appointmentsListButtonLabel.length}/20
                      </p>
                    </div>
                    <div className="space-y-1.5 lg:col-span-2">
                      <Label>Cuerpo</Label>
                      <Textarea
                        value={appointmentsListBody}
                        maxLength={1024}
                        onChange={(e) => setAppointmentsListBody(e.target.value)}
                        className="min-h-20"
                        placeholder={APPOINTMENTS_DEFAULT_LIST_BODY}
                      />
                      <p className="text-xs text-muted-foreground">
                        {appointmentsListBody.length}/1024
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Pie</Label>
                      <Input
                        value={appointmentsListFooter}
                        maxLength={60}
                        onChange={(e) => setAppointmentsListFooter(e.target.value)}
                        placeholder={APPOINTMENTS_DEFAULT_LIST_FOOTER}
                      />
                      <p className="text-xs text-muted-foreground">
                        {appointmentsListFooter.length}/60
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Titulo de seccion por dia</Label>
                      <Input
                        value={appointmentsListSectionTitle}
                        onChange={(e) => setAppointmentsListSectionTitle(e.target.value)}
                        placeholder={APPOINTMENTS_DEFAULT_LIST_SECTION_TITLE}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Titulo de fila</Label>
                      <Input
                        value={appointmentsListRowTitle}
                        maxLength={24}
                        onChange={(e) => setAppointmentsListRowTitle(e.target.value)}
                        placeholder={APPOINTMENTS_DEFAULT_LIST_ROW_TITLE}
                      />
                      <p className="text-xs text-muted-foreground">
                        {appointmentsListRowTitle.length}/24
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Descripcion de fila</Label>
                      <Input
                        value={appointmentsListRowDescription}
                        maxLength={72}
                        onChange={(e) => setAppointmentsListRowDescription(e.target.value)}
                        placeholder={APPOINTMENTS_DEFAULT_LIST_ROW_DESCRIPTION}
                      />
                      <p className="text-xs text-muted-foreground">
                        {appointmentsListRowDescription.length}/72
                      </p>
                    </div>
                  </div>
                </div>
              )}
              <div className="space-y-1.5 lg:col-span-2">
                <Label>Webhook para Citas Web</Label>
                <div className="flex gap-2">
                  <Input readOnly value={appointmentsWebhookUrl ?? "Guarda la app para generarlo"} />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!appointmentsWebhookUrl}
                    onClick={() => {
                      if (!appointmentsWebhookUrl) return;
                      void navigator.clipboard.writeText(appointmentsWebhookUrl);
                      toast.success("Webhook copiado");
                    }}
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={saveAppointments} disabled={saving}>
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
