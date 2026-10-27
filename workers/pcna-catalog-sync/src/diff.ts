import type { DiffStatus, Product, StoredProductRow } from "./types";

/**
 * SHA-256 over the fields that matter for "did this product change":
 * name, price, category, url. sku/publishProductId are identity, not
 * state — deliberately excluded per the design doc.
 */
export async function hashProduct(product: Product): Promise<string> {
  const payload = [product.productName, product.price, product.category, product.productUrl].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function classifyProduct(existing: StoredProductRow | null, dataHash: string): DiffStatus {
  if (!existing) {
    return "NEW";
  }
  return existing.dataHash === dataHash ? "UNCHANGED" : "CHANGED";
}

/**
 * Discontinuation scoping (design doc, user-approved): MAX_CATEGORIES_PER_RUN
 * caps coverage and rotates across runs, so "not seen this run" only means
 * "discontinued" for categories this run actually crawled. A product
 * stored under a category this run didn't visit is left alone regardless
 * of whether it showed up — it simply hasn't had its turn yet.
 */
export function computeSkusToMarkUnseen(
  crawledCategoryIds: Set<string>,
  storedSkusByCategory: Map<string, string[]>,
  observedSkus: Set<string>
): string[] {
  const toMarkUnseen: string[] = [];
  for (const categoryId of crawledCategoryIds) {
    for (const sku of storedSkusByCategory.get(categoryId) ?? []) {
      if (!observedSkus.has(sku)) {
        toMarkUnseen.push(sku);
      }
    }
  }
  return toMarkUnseen;
}

/**
 * Products appear on a category page and on every ancestor page above it,
 * so "which category is this product in" means the most specific one:
 * the deepest category URL (see categoryDepth in parse.ts). Rotation
 * visits a product's categories in varying orders across runs, so this
 * decides at diff time whether an observation may replace the stored
 * category:
 *
 * - A deeper observation always wins (stored under "Drinkware", seen on
 *   "drinkware/tumblers" — even though tumblers is a non-leaf in the
 *   sitemap).
 * - A shallower or equally deep observation keeps the stored category,
 *   so rotation doesn't flip a product between a parent and its child,
 *   or between two sibling categories, and report it CHANGED each time.
 * - Except when the stored category was itself fully re-crawled this run
 *   (storedCategoryRecrawled) and the product wasn't seen there — it
 *   moved, so the observation wins.
 * - Unknown stored depth (no stored row, or a category that isn't one of
 *   the crawled department pages) lets the observation win.
 *
 * Only category/categoryId are preserved; price, name and URL changes
 * still come through.
 */
export function preferSpecificCategory(
  observed: Product,
  observedDepth: number,
  stored: StoredProductRow | null,
  storedDepth: number | null,
  storedCategoryRecrawled: boolean
): Product {
  const keepStored = stored !== null && storedDepth !== null && !storedCategoryRecrawled && storedDepth >= observedDepth;
  return keepStored ? { ...observed, category: stored.category, categoryId: stored.categoryId } : observed;
}

/**
 * In-run dedup: a SKU seen on several category pages in one run keeps its
 * deepest observation, whatever order the pages were crawled in; ties keep
 * the first.
 */
export function isMoreSpecificObservation(existingDepth: number | undefined, newDepth: number): boolean {
  return existingDepth === undefined || newDepth > existingDepth;
}
