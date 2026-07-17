import type { InteractiveButton } from "@/lib/whatsapp/interactive";

export function toInteractiveTemplateButton(
  button: unknown,
  index: number,
): InteractiveButton | null {
  if (!button || typeof button !== "object") return null;

  const record = button as Record<string, unknown>;
  const text = record.text;
  if (typeof text !== "string" || text.trim().length === 0) return null;

  return {
    id: `template-${index}`,
    title: text,
    type: typeof record.type === "string" ? record.type : "QUICK_REPLY",
    url: typeof record.url === "string" ? record.url : undefined,
    example: typeof record.example === "string" ? record.example : undefined,
    phone_number:
      typeof record.phone_number === "string" ? record.phone_number : undefined,
  };
}

export function resolveTemplateButtonUrl(
  button: Pick<InteractiveButton, "type" | "url" | "example">,
): string | null {
  if (button.type?.toUpperCase() !== "URL" || !button.url) return null;
  if (/\{\{\s*1\s*\}\}/.test(button.url) && !button.example) return null;

  const example = button.example ?? "";
  const resolved = button.url.replace(/\{\{\s*1\s*\}\}/g, example);
  if (/\{\{\s*\d+\s*\}\}/.test(resolved)) return null;

  try {
    const url = new URL(resolved);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
