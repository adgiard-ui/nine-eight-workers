/**
 * Bindings and config available to this Worker — see wrangler.toml for
 * [vars]/bindings and .dev.vars.example for secrets. ANTHROPIC_API_KEY and
 * CLAUDE_MODEL are reserved for a future Claude-based extraction step;
 * nothing in this worker's code calls packages/core's model-router or
 * agent-loop with them.
 */
export interface Env {
  DB: D1Database;
  CSV_BUCKET: R2Bucket;
  /** Google Chat incoming-webhook URL (a secret — it embeds key and token). Unset/empty: no notifications. */
  GOOGLE_CHAT_WEBHOOK_URL?: string;
  MANUAL_TRIGGER_SECRET: string;
  MAX_CATEGORIES_PER_RUN: string;
  /** Comma-separated top-level department slugs whose category pages (root, parents and leaves) are crawled, e.g. "apparel,bags". */
  CATEGORY_PATH_PREFIXES: string;
  FETCH_DELAY_MS: string;
  PAGE_SIZE: string;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
}

/**
 * Single source of truth for which fields a product carries. Drives both
 * the CSV column order (csv.ts) and the Product type below — adding a
 * field (e.g. a dealer price once authenticated requests exist) means
 * adding it here and nowhere else in the type system.
 */
export const PRODUCT_FIELDS = [
  "sku",
  "publishProductId",
  "productName",
  "category",
  "categoryId",
  "price",
  "productUrl",
] as const;

export type ProductField = (typeof PRODUCT_FIELDS)[number];

export type Product = Record<ProductField, string>;

export type DiffStatus = "NEW" | "CHANGED" | "UNCHANGED";

export interface DiffResult {
  product: Product;
  status: DiffStatus;
  dataHash: string;
}

/** Shape of a row read back from the `products` D1 table. */
export interface StoredProductRow {
  sku: string;
  publishProductId: string;
  productName: string;
  category: string;
  categoryId: string;
  price: string;
  productUrl: string;
  dataHash: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  seenInLastRun: boolean;
}

/** A category as tracked in the `categories` D1 table. */
export interface CategoryRef {
  categoryUrl: string;
  /** Empty string until the category page has been fetched and parsed. */
  categoryId: string;
  categoryName: string;
}

/**
 * Created fresh per run, threaded through fetch.ts's calls as a parameter
 * rather than held as module-level state — Workers best practice, and the
 * same per-invocation-state pattern lead-qualifier already uses for its
 * own guardrails.
 */
export type CookieJar = Map<string, string>;

export interface RunSummary {
  /** Unique, normalized URLs across all child sitemaps (before category filtering). */
  sitemapUrls: number;
  /** Category URLs (roots, parents and leaves) that survived the CATEGORY_PATH_PREFIXES filter — the rotation's size. */
  categoriesDiscovered: number;
  categoriesCrawled: number;
  productsSeen: number;
  newCount: number;
  changedCount: number;
  failedCount: number;
  durationMs: number;
  csvKey: string | null;
}
