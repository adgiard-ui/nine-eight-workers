import { parse as parseHtml, type HTMLElement } from "node-html-parser";
import { logger } from "@nine-eight/core/logger";
import type { Product } from "./types";

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

/**
 * Resolves the numeric categoryId LoadMoreProducts requires, plus a
 * human-readable categoryName for its `name` query param.
 *
 * categoryId: the data-categoryId attribute first; if a given category
 * page layout doesn't render it, falls back to a best-effort scan for a
 * bare categoryId reference elsewhere in the page (inline script, hidden
 * field) — e.g. `categoryId: 339`, `categoryId=339`, `"categoryId":"339"`.
 * Returns null (never throws) if neither finds one; the caller logs and
 * skips that category for this run.
 *
 * categoryName: the data-category attribute first, else derived from the
 * URL's last path segment. The one documented LoadMoreProducts call in
 * the design doc doesn't suggest this value affects which products come
 * back, only PCNA's own logging/display — the derived fallback is good
 * enough.
 */
export function resolveCategoryMeta(
  categoryPageHtml: string,
  categoryUrl: string
): { categoryId: string | null; categoryName: string } {
  const root = parseHtml(categoryPageHtml);

  const categoryIdAttr = root.querySelector("[data-categoryid]")?.getAttribute("data-categoryid");
  const fallbackMatch = categoryPageHtml.match(/categoryId["']?\s*[:=]\s*["']?(\d+)/i);
  const categoryId = categoryIdAttr ?? fallbackMatch?.[1] ?? null;

  const categoryNameAttr = root.querySelector("[data-category]")?.getAttribute("data-category");
  const categoryName = categoryNameAttr ? decodeHtmlEntities(categoryNameAttr) : deriveCategoryNameFromUrl(categoryUrl);

  return { categoryId, categoryName };
}

function deriveCategoryNameFromUrl(categoryUrl: string): string {
  const slug = categoryUrl.split("/").filter(Boolean).pop() ?? "";
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Parses one LoadMoreProducts HTML fragment into Product rows. Product
 * blocks are located by the presence of a data-sku attribute, which the
 * original spec confirms is always present. See the file-level note above
 * this function's tests: no raw fragment HTML was available at design
 * time, so this must be re-validated against a real response.
 */
export function parseProductFragment(fragmentHtml: string): Product[] {
  const root = parseHtml(fragmentHtml);
  const productNodes = root.querySelectorAll("[data-sku]");

  const products: Product[] = [];
  for (const node of productNodes) {
    const sku = node.getAttribute("data-sku");
    if (!sku) continue;

    products.push({
      sku: decodeHtmlEntities(sku),
      publishProductId: decodeHtmlEntities(node.getAttribute("data-publishproductid") ?? ""),
      productName: decodeHtmlEntities(node.getAttribute("data-productname") ?? ""),
      category: decodeHtmlEntities(node.getAttribute("data-category") ?? ""),
      categoryId: decodeHtmlEntities(node.getAttribute("data-categoryid") ?? ""),
      price: decodeHtmlEntities(node.getAttribute("data-originalprice") ?? ""),
      productUrl: resolveProductUrl(root, node, sku),
    });
  }
  return products;
}

/**
 * node-html-parser's fragments don't expose parentNode (confirmed against
 * its type definitions), so instead of walking up the tree this: (1)
 * checks the product block's own subtree first, then (2) falls back to
 * the one guaranteed link between a product's data block and its
 * detail-page anchor — PCNA's product URLs end in "-{sku}" (lowercased),
 * e.g. data-sku="SM-9846" -> .../astro-flashlight-sm-9846. Scans every
 * /product/ anchor in the whole fragment for one ending in that suffix.
 * Logs and returns "" (never throws) if neither finds one — one
 * unresolved URL shouldn't drop the product from the run.
 */
function resolveProductUrl(root: HTMLElement, productNode: HTMLElement, sku: string): string {
  const ownAnchor = productNode.querySelector('a[href*="/product/"]');
  const ownHref = ownAnchor?.getAttribute("href");
  if (ownHref) {
    return ownHref;
  }

  const suffix = `-${sku.toLowerCase()}`;
  const candidate = root
    .querySelectorAll('a[href*="/product/"]')
    .find((anchor) => (anchor.getAttribute("href") ?? "").toLowerCase().endsWith(suffix));
  const candidateHref = candidate?.getAttribute("href");
  if (candidateHref) {
    return candidateHref;
  }

  logger.warn("pcna_product_url_unresolved", { sku });
  return "";
}
