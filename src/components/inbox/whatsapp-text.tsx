import { Fragment } from "react";
import type { ReactNode } from "react";
import {
  extractTyreMeasureKeys,
  findNormalizedSearchIndex,
  normalizeSearchText,
} from "@/lib/search/normalize";

const BOLD_SEGMENT_RE = /\*([^*\n]+)\*/g;
const URL_SEGMENT_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;
const TRAILING_URL_PUNCTUATION_RE = /[.,;:!?)]$/;

function renderHighlightedText(
  text: string,
  keyPrefix: string,
  searchQuery?: string | null,
) {
  const query = searchQuery?.trim();
  if (!query) return text;

  const nodes: ReactNode[] = [];
  const lowerText = normalizeSearchText(text);
  const lowerQuery = normalizeSearchText(query);
  let cursor = 0;
  const queryTyres = extractTyreMeasureKeys(query);
  let matchIndex = findNormalizedSearchIndex(text, query);

  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      nodes.push(text.slice(cursor, matchIndex));
    }

    let end = matchIndex + query.length;
    if (queryTyres.length > 0) {
      const tail = lowerText.slice(matchIndex);
      const tyreMatch =
        tail.match(/^(\d{3})\s*[/\-\s]?\s*(\d{2})\s*r\s*(\d{2})\b/i) ??
        tail.match(/^(\d{3})\s*[/\-\s]\s*(\d{2})\s*[/\-\s]\s*(\d{2})\b/i) ??
        tail.match(/^(\d{3})(\d{2})(\d{2})\b/i);
      if (tyreMatch) {
        end = matchIndex + tyreMatch[0].length;
      }
    }
    nodes.push(
      <mark
        key={`${keyPrefix}-search-${matchIndex}`}
        className="rounded-sm bg-yellow-300 px-0.5 text-yellow-950"
      >
        {text.slice(matchIndex, end)}
      </mark>,
    );

    cursor = end;
    matchIndex =
      queryTyres.length > 0
        ? findNormalizedSearchIndex(text.slice(cursor), query)
        : lowerText.indexOf(lowerQuery, cursor);
    if (matchIndex >= 0 && queryTyres.length > 0) {
      matchIndex += cursor;
    }
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes;
}

function renderBoldText(
  text: string,
  keyPrefix: string,
  searchQuery?: string | null,
) {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(BOLD_SEGMENT_RE)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(
        ...asNodeArray(
          renderHighlightedText(
            text.slice(lastIndex, start),
            `${keyPrefix}-plain-${lastIndex}`,
            searchQuery,
          ),
        ),
      );
    }
    nodes.push(
      <strong key={`${keyPrefix}-bold-${start}-${match[1]}`} className="font-semibold">
        {renderHighlightedText(match[1], `${keyPrefix}-bold-${start}`, searchQuery)}
      </strong>,
    );
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(
      ...asNodeArray(
        renderHighlightedText(
          text.slice(lastIndex),
          `${keyPrefix}-plain-${lastIndex}`,
          searchQuery,
        ),
      ),
    );
  }

  return nodes;
}

function asNodeArray(node: ReactNode | ReactNode[]) {
  return Array.isArray(node) ? node : [node];
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

export function WhatsAppText({
  text,
  searchQuery,
}: {
  text?: string | null;
  searchQuery?: string | null;
}) {
  if (!text) return null;

  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_SEGMENT_RE)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(
        ...renderBoldText(
          text.slice(lastIndex, start),
          `text-${start}`,
          searchQuery,
        ),
      );
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
        {renderHighlightedText(url, `url-${start}`, searchQuery)}
      </a>,
    );
    if (trailing) {
      nodes.push(
        ...asNodeArray(
          renderHighlightedText(trailing, `url-trailing-${start}`, searchQuery),
        ),
      );
    }
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(
      ...renderBoldText(text.slice(lastIndex), `text-${lastIndex}`, searchQuery),
    );
  }

  return (
    <>
      {nodes.map((node, index) => (
        <Fragment key={index}>{node}</Fragment>
      ))}
    </>
  );
}
