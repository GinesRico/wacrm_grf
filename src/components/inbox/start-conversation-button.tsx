"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2, MessageCirclePlus, Search, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { Contact } from "@/types";

const PREFIXES = [
  { value: "34", label: "España (+34)" },
  { value: "1", label: "EE. UU. / Canadá (+1)" },
  { value: "44", label: "Reino Unido (+44)" },
  { value: "351", label: "Portugal (+351)" },
  { value: "33", label: "Francia (+33)" },
  { value: "49", label: "Alemania (+49)" },
  { value: "39", label: "Italia (+39)" },
  { value: "52", label: "México (+52)" },
] as const;

interface WhatsAppLine {
  id: string;
  label?: string | null;
  phone_number_id: string;
  status?: string | null;
  is_default?: boolean | null;
}

interface StartConversationButtonProps {
  onStarted: (conversationId: string) => void;
  disabled?: boolean;
}

export function StartConversationButton({
  onStarted,
  disabled,
}: StartConversationButtonProps) {
  const t = useTranslations("Inbox.startConversation");
  const [open, setOpen] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [lines, setLines] = useState<WhatsAppLine[]>([]);
  const [prefix, setPrefix] = useState("34");
  const [lineId, setLineId] = useState("");
  const [query, setQuery] = useState("");
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);

  const selectedContact = useMemo(
    () => contacts.find((c) => c.id === selectedContactId) ?? null,
    [contacts, selectedContactId],
  );

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts.slice(0, 6);
    return contacts
      .filter((contact) => {
        const haystack = `${contact.name ?? ""} ${contact.phone ?? ""} ${
          contact.company ?? ""
        }`.toLowerCase();
        return haystack.includes(q);
      })
      .slice(0, 6);
  }, [contacts, query]);

  const loadData = useCallback(async () => {
    setLoadingData(true);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) return;

      const { data: profile } = await supabase
        .from("profiles")
        .select("account_id")
        .eq("user_id", user.id)
        .maybeSingle();
      const accountId = profile?.account_id as string | undefined;
      if (!accountId) return;

      const [contactsRes, linesRes] = await Promise.all([
        supabase
          .from("contacts")
          .select("*")
          .eq("account_id", accountId)
          .order("updated_at", { ascending: false })
          .limit(50),
        supabase
          .from("whatsapp_config")
          .select("id, label, phone_number_id, status, is_default")
          .eq("account_id", accountId)
          .order("is_default", { ascending: false })
          .order("created_at", { ascending: true }),
      ]);

      if (contactsRes.error) throw contactsRes.error;
      if (linesRes.error) throw linesRes.error;

      const nextLines = (linesRes.data ?? []) as WhatsAppLine[];
      setContacts((contactsRes.data ?? []) as Contact[]);
      setLines(nextLines);
      setLineId((current) => current || nextLines[0]?.id || "");
    } catch (error) {
      console.error("[start-conversation] load error:", error);
      toast.error(t("loadFailed"));
    } finally {
      setLoadingData(false);
    }
  }, [t]);

  useEffect(() => {
    if (open) void loadData();
  }, [open, loadData]);

  function resetDraft() {
    setQuery("");
    setSelectedContactId(null);
  }

  function buildPhone() {
    const raw = query.trim();
    if (!raw) return "";
    if (raw.startsWith("+")) return raw;
    const digits = raw.replace(/\D/g, "");
    if (!digits) return "";
    return `+${prefix}${digits}`;
  }

  const canSubmit =
    !!lineId && (!!selectedContactId || query.replace(/\D/g, "").length >= 6);

  async function handleSubmit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/inbox/start-conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          whatsapp_config_id: lineId,
          contact_id: selectedContactId,
          phone: selectedContact ? undefined : buildPhone(),
          name: selectedContact ? undefined : query.trim(),
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload?.error ?? t("failed"));
        return;
      }
      const conversationId = payload?.conversation_id;
      if (typeof conversationId !== "string") {
        toast.error(t("failed"));
        return;
      }
      setOpen(false);
      resetDraft();
      onStarted(conversationId);
    } catch (error) {
      console.error("[start-conversation] submit error:", error);
      toast.error(t("failed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        size="icon"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="absolute bottom-5 left-5 z-20 size-13 rounded-full shadow-lg shadow-primary/20"
        aria-label={t("open")}
        title={t("open")}
      >
        <MessageCirclePlus className="size-5" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="gap-0 p-0 sm:max-w-[430px]">
          <DialogHeader className="border-b border-border px-5 py-4">
            <DialogTitle>{t("title")}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 px-5 py-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("prefix")}>
                <Select
                  value={prefix}
                  onValueChange={(value) => {
                    if (value) setPrefix(value);
                  }}
                >
                  <SelectTrigger className="h-10 w-full bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PREFIXES.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label={t("line")}>
                <Select
                  value={lineId}
                  onValueChange={(value) => {
                    setLineId(value ?? "");
                  }}
                >
                  <SelectTrigger className="h-10 w-full bg-background">
                    <SelectValue placeholder={t("noLine")} />
                  </SelectTrigger>
                  <SelectContent>
                    {lines.map((line) => (
                      <SelectItem key={line.id} value={line.id}>
                        {line.label || line.phone_number_id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-primary">
                {t("searchLabel")}
              </label>
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setSelectedContactId(null);
                  }}
                  placeholder={t("searchPlaceholder")}
                  className="h-12 border-primary/60 bg-background pl-9"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleSubmit();
                    }
                  }}
                />
              </div>
            </div>

            {loadingData ? (
              <div className="flex items-center justify-center py-5 text-sm text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" />
                {t("loading")}
              </div>
            ) : suggestions.length > 0 && query.trim() ? (
              <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-card p-1">
                {suggestions.map((contact) => (
                  <button
                    key={contact.id}
                    type="button"
                    onClick={() => {
                      setSelectedContactId(contact.id);
                      setQuery(contact.name || contact.phone);
                    }}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors",
                      selectedContactId === contact.id
                        ? "bg-primary/10 text-primary"
                        : "hover:bg-muted",
                    )}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                      <UserRound className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {contact.name || contact.phone}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {contact.phone}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}

            {!lineId && !loadingData ? (
              <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
                {t("lineRequired")}
              </p>
            ) : null}
          </div>

          <DialogFooter className="px-5">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
              {t("cancel")}
            </Button>
            <Button onClick={handleSubmit} disabled={!canSubmit || submitting}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              {t("submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
