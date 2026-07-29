const DIACRITICS_RE = /[\u0300-\u036f]/g;
const TYRE_WITH_R_RE = /\b(\d{3})\s*[/\-\s]?\s*(\d{2})\s*r\s*(\d{2})\b/gi;
const TYRE_WITHOUT_R_RE = /\b(\d{3})\s*[/\-\s]\s*(\d{2})\s*[/\-\s]\s*(\d{2})\b/g;
const COMPACT_TYRE_RE = /\b(\d{3})(\d{2})(\d{2})\b/g;

function stripDiacritics(value: string) {
  return value.normalize("NFD").replace(DIACRITICS_RE, "");
}

export function normalizeSearchText(value: string | null | undefined) {
  return stripDiacritics(value ?? "").toLocaleLowerCase();
}

export function extractTyreMeasureKeys(value: string | null | undefined) {
  const text = normalizeSearchText(value);
  const keys = new Set<string>();

  for (const match of text.matchAll(TYRE_WITH_R_RE)) {
    keys.add(`${match[1]}${match[2]}${match[3]}`);
  }
  for (const match of text.matchAll(TYRE_WITHOUT_R_RE)) {
    keys.add(`${match[1]}${match[2]}${match[3]}`);
  }
  for (const match of text.matchAll(COMPACT_TYRE_RE)) {
    keys.add(`${match[1]}${match[2]}${match[3]}`);
  }

  return [...keys];
}

export function normalizedSearchIncludes(
  value: string | null | undefined,
  query: string | null | undefined,
) {
  const normalizedQuery = normalizeSearchText(query).trim();
  if (!normalizedQuery) return true;

  const normalizedValue = normalizeSearchText(value);
  if (normalizedValue.includes(normalizedQuery)) return true;

  const queryTyres = extractTyreMeasureKeys(query);
  if (queryTyres.length === 0) return false;

  const valueTyres = extractTyreMeasureKeys(value);
  return queryTyres.some((key) => valueTyres.includes(key));
}

export function findNormalizedSearchIndex(value: string, query: string) {
  const normalizedQuery = normalizeSearchText(query).trim();
  if (!normalizedQuery) return -1;

  const normalizedValue = normalizeSearchText(value);
  const directIndex = normalizedValue.indexOf(normalizedQuery);
  if (directIndex >= 0) return directIndex;

  const queryTyres = extractTyreMeasureKeys(query);
  if (queryTyres.length === 0) return -1;

  const tyrePatterns = [TYRE_WITH_R_RE, TYRE_WITHOUT_R_RE, COMPACT_TYRE_RE];
  for (const pattern of tyrePatterns) {
    pattern.lastIndex = 0;
    for (const match of normalizedValue.matchAll(pattern)) {
      const key = `${match[1]}${match[2]}${match[3]}`;
      if (queryTyres.includes(key)) return match.index ?? -1;
    }
  }

  return -1;
}
