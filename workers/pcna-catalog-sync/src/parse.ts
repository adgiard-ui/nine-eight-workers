const DOUBLED_HOST_PATTERN = /^https:\/\/www\.www\.pcna\.com\//i;
const GOOD_HOST_PATTERN = /^https:\/\/www\.pcna\.com\//i;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes the HTML entities PCNA's markup uses in text fields. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === "#") {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const codePoint = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

/**
 * Fixes PCNA's known doubled-host sitemap bug (www.www.pcna.com, which
 * 404s). Returns null — rather than guessing — for a URL that matches
 * neither the known-good nor known-bad host, so the caller can log it
 * instead of silently dropping it (per the design doc's normalization
 * requirement).
 */
export function normalizeUrl(rawUrl: string): { url: string; wasNormalized: boolean } | null {
  if (DOUBLED_HOST_PATTERN.test(rawUrl)) {
    return { url: rawUrl.replace(DOUBLED_HOST_PATTERN, "https://www.pcna.com/"), wasNormalized: true };
  }
  if (GOOD_HOST_PATTERN.test(rawUrl)) {
    return { url: rawUrl, wasNormalized: false };
  }
  return null;
}

/** Extracts every <loc> URL from a sitemap index or child sitemap document. */
export function extractLocUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => decodeHtmlEntities(match[1]));
}
