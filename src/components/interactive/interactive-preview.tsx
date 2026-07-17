"use client";

import { useState } from "react";
import { ExternalLink, List, Reply } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { WhatsAppText } from "@/components/inbox/whatsapp-text";
import type { InteractiveMessagePayload } from "@/lib/whatsapp/interactive";
import { resolveTemplateButtonUrl } from "@/lib/inbox/template-buttons";

/**
 * WhatsApp-style read-only render of an interactive message. Used both
 * in the builder's live preview and by the inbox message bubble so a
 * sent buttons/list message shows the same way it does on the phone.
 *
 * Purely presentational — the buttons/rows are not clickable here (the
 * customer taps them on their own device). Kept namespace-free (plain
 * English) so it can be dropped into the composer, the automation
 * builder, and the quick-replies manager without namespace coupling.
 */
export function InteractivePreview({
  payload,
  className,
  hideEmptyBody = false,
  embedded = false,
  onPrimary = false,
}: {
  payload: InteractiveMessagePayload;
  className?: string;
  hideEmptyBody?: boolean;
  embedded?: boolean;
  onPrimary?: boolean;
}) {
  const t = useTranslations("InteractiveBuilder");
  const [listOpen, setListOpen] = useState(false);
  const actionClass = cn(
    "flex w-full items-center justify-center gap-1.5 border-t px-3 py-2 text-sm font-medium",
    embedded
      ? onPrimary
        ? "border-primary-foreground/25 text-primary-foreground"
        : "border-border text-primary"
      : "border-border text-primary",
  );

  return (
    <div
      className={cn(
        embedded
          ? "w-full overflow-hidden text-inherit"
          : "w-full max-w-[260px] overflow-hidden rounded-lg bg-card text-foreground shadow-sm ring-1 ring-border",
        className,
      )}
    >
      <div className={cn(embedded ? "pb-2" : "px-3 py-2")}>
        {payload.header ? (
          <p className="mb-1 break-words text-sm font-semibold">
            <WhatsAppText text={payload.header} />
          </p>
        ) : null}
        {payload.body || !hideEmptyBody ? (
          <p className="whitespace-pre-wrap break-words text-sm">
            {payload.body ? (
              <WhatsAppText text={payload.body} />
            ) : (
              <span className="text-muted-foreground">{t("messageBodyFallback")}</span>
            )}
          </p>
        ) : null}
        {payload.footer ? (
          <p
            className={cn(
              "mt-1 break-words text-[11px]",
              embedded && onPrimary
                ? "text-primary-foreground/70"
                : "text-muted-foreground",
            )}
          >
            <WhatsAppText text={payload.footer} />
          </p>
        ) : null}
      </div>

      {payload.kind === "buttons" ? (
        <div className="flex flex-col">
          {payload.buttons.map((b, i) => {
            const href = resolveTemplateButtonUrl(b);
            const content = (
              <>
                {href ? (
                  <ExternalLink className="h-3.5 w-3.5" />
                ) : (
                  <Reply className="h-3.5 w-3.5" />
                )}
                <span className="truncate">
                  <WhatsAppText text={b.title || t("buttonFallback")} />
                </span>
              </>
            );

            return href ? (
              <a
                key={b.id || i}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
                className={cn(actionClass, i === 0 && !embedded ? "first:border-t" : "")}
              >
                {content}
              </a>
            ) : (
              <button
                key={b.id || i}
                type="button"
                disabled
                onClick={(event) => event.stopPropagation()}
                className={actionClass}
              >
                {content}
              </button>
            );
          })}
        </div>
      ) : payload.kind === "list" ? (
        <div className="flex flex-col">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setListOpen((open) => !open);
            }}
            className={actionClass}
            aria-expanded={listOpen}
          >
            <List className="h-3.5 w-3.5" />
            <span className="truncate">{payload.button_label || t("menuFallback")}</span>
          </button>
          {listOpen ? (
            <div
              className={cn(
                "border-t px-2 py-2",
                embedded && onPrimary
                  ? "border-primary-foreground/25"
                  : "border-border",
              )}
            >
              {payload.sections.map((section, sectionIndex) => (
                <div key={`${section.title ?? "section"}-${sectionIndex}`} className="space-y-1">
                  {section.title ? (
                    <p
                      className={cn(
                        "px-1 text-[11px] font-semibold uppercase tracking-wide",
                        embedded && onPrimary
                          ? "text-primary-foreground/70"
                          : "text-muted-foreground",
                      )}
                    >
                      <WhatsAppText text={section.title} />
                    </p>
                  ) : null}
                  {section.rows.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      disabled
                      className={cn(
                        "w-full rounded-md px-2 py-1.5 text-left text-xs",
                        embedded && onPrimary
                          ? "text-primary-foreground/90"
                          : "text-foreground",
                      )}
                    >
                      <span className="block font-medium">
                        <WhatsAppText text={row.title} />
                      </span>
                      {row.description ? (
                        <span
                          className={cn(
                            "mt-0.5 block",
                            embedded && onPrimary
                              ? "text-primary-foreground/65"
                              : "text-muted-foreground",
                          )}
                        >
                          <WhatsAppText text={row.description} />
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <a
          href={payload.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          className={actionClass}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          <span className="truncate">{payload.button_label || t("buttonFallback")}</span>
        </a>
      )}
    </div>
  );
}
