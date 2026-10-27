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
 * Products appear on both a leaf category page and its parents, and
 * dedup-by-SKU is last-write-wins. An observation from a parent page
 * (isLeaf false) therefore never overrides a category the product already
 * has — otherwise rotation would flip it between "Half Zips" and
 * "Apparel" and report it CHANGED each time. A product seen only on a
 * parent page (no stored row) takes the parent's category. Only
 * category/categoryId are preserved; price, name and URL changes still
 * come through.
 */
export function preferSpecificCategory(observed: Product, fromLeaf: boolean, stored: StoredProductRow | null): Product {
  if (fromLeaf || !stored) {
    return observed;
  }
  return { ...observed, category: stored.category, categoryId: stored.categoryId };
}
