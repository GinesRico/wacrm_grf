import { Fragment } from "react";
import type { ReactNode } from "react";

const BOLD_SEGMENT_RE = /\*([^*\n]+)\*/g;

export function WhatsAppText({ text }: { text?: string | null }) {
  if (!text) return null;

  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(BOLD_SEGMENT_RE)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start));
    }
    nodes.push(
      <strong key={`${start}-${match[1]}`} className="font-semibold">
        {match[1]}
      </strong>,
    );
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return (
    <>
      {nodes.map((node, index) => (
        <Fragment key={index}>{node}</Fragment>
      ))}
    </>
  );
}
