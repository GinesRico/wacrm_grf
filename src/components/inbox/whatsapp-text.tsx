import { Fragment } from "react";
import type { ReactNode } from "react";

const BOLD_SEGMENT_RE = /\*([^*\n]+)\*/g;
const URL_SEGMENT_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;
const TRAILING_URL_PUNCTUATION_RE = /[.,;:!?)]$/;

function renderBoldText(text: string, keyPrefix: string) {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(BOLD_SEGMENT_RE)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start));
    }
    nodes.push(
      <strong key={`${keyPrefix}-bold-${start}-${match[1]}`} className="font-semibold">
        {match[1]}
      </strong>,
    );
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function splitUrlTrailingPunctuation(rawUrl: string) {
  let url = rawUrl;
  let trailing = "";

  while (url.length > 0 && TRAILING_URL_PUNCTUATION_RE.test(url)) {
    trailing = url.at(-1) + trailing;
    url = url.slice(0, -1);
  }

  return { url, trailing };
}

export function WhatsAppText({ text }: { text?: string | null }) {
  if (!text) return null;

  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_SEGMENT_RE)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(...renderBoldText(text.slice(lastIndex, start), `text-${start}`));
    }

    const rawUrl = match[0];
    const { url, trailing } = splitUrlTrailingPunctuation(rawUrl);
    const href = url.startsWith("http") ? url : `https://${url}`;
    nodes.push(
      <a
        key={`url-${start}-${url}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => event.stopPropagation()}
        className="font-medium underline underline-offset-2"
      >
        {url}
      </a>,
    );
    if (trailing) nodes.push(trailing);
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(...renderBoldText(text.slice(lastIndex), `text-${lastIndex}`));
  }

  return (
    <>
      {nodes.map((node, index) => (
        <Fragment key={index}>{node}</Fragment>
      ))}
    </>
  );
}
