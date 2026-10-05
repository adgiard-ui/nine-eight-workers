import type { CategoryRef, Product, StoredProductRow } from "./types";

// D1 has a parameter limit per statement; chunk IN (...) queries and
// batched writes to stay safely under it regardless of run size.
const SQL_CHUNK_SIZE = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function rowToStoredProduct(row: Record<string, unknown>): StoredProductRow {
  return {
    sku: String(row.sku),
    publishProductId: String(row.publish_product_id ?? ""),
    productName: String(row.product_name ?? ""),
    category: String(row.category ?? ""),
    categoryId: String(row.category_id ?? ""),
    price: String(row.price ?? ""),
    productUrl: String(row.product_url ?? ""),
    dataHash: String(row.data_hash ?? ""),
    firstSeenAt: String(row.first_seen_at ?? ""),
    lastSeenAt: String(row.last_seen_at ?? ""),
    lastChangedAt: String(row.last_changed_at ?? ""),
    seenInLastRun: Boolean(row.seen_in_last_run),
  };
}

export async function getStoredProductsBySkus(
  db: D1Database,
  skus: string[]
): Promise<Map<string, StoredProductRow>> {
  const result = new Map<string, StoredProductRow>();
  for (const batch of chunk(skus, SQL_CHUNK_SIZE)) {
    const placeholders = batch.map(() => "?").join(",");
    const { results } = await db
      .prepare(`SELECT * FROM products WHERE sku IN (${placeholders})`)
      .bind(...batch)
      .all();
    for (const row of results) {
      const stored = rowToStoredProduct(row as Record<string, unknown>);
      result.set(stored.sku, stored);
    }
  }
  return result;
}

/**
 * Batched upsert: one D1Database.batch() round trip per chunk, instead of
 * one round trip per product. Keeps a run bounded by MAX_CATEGORIES_PER_RUN
 * from also being bounded by D1 round-trip latency.
 */
export async function upsertProducts(
  db: D1Database,
  rows: { product: Product; dataHash: string }[],
  now: string
): Promise<void> {
  const statements = rows.map(({ product, dataHash }) =>
    db
      .prepare(
        `INSERT INTO products (
           sku, publish_product_id, product_name, category, category_id,
           price, product_url, data_hash, first_seen_at, last_seen_at,
           last_changed_at, seen_in_last_run
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(sku) DO UPDATE SET
           publish_product_id = excluded.publish_product_id,
           product_name = excluded.product_name,
           category = excluded.category,
           category_id = excluded.category_id,
           price = excluded.price,
           product_url = excluded.product_url,
           data_hash = excluded.data_hash,
           last_seen_at = excluded.last_seen_at,
           last_changed_at = CASE
             WHEN products.data_hash != excluded.data_hash THEN excluded.last_changed_at
             ELSE products.last_changed_at
           END,
           seen_in_last_run = 1`
      )
      .bind(
        product.sku,
        product.publishProductId,
        product.productName,
        product.category,
        product.categoryId,
        product.price,
        product.productUrl,
        dataHash,
        now,
        now,
        now
      )
  );

  for (const batch of chunk(statements, SQL_CHUNK_SIZE)) {
    await db.batch(batch);
  }
}

export async function getStoredSkusByCategoryIds(
  db: D1Database,
  categoryIds: string[]
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (const batch of chunk(categoryIds, SQL_CHUNK_SIZE)) {
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => "?").join(",");
    const { results } = await db
      .prepare(`SELECT sku, category_id FROM products WHERE category_id IN (${placeholders})`)
      .bind(...batch)
      .all();
    for (const row of results as { sku: string; category_id: string }[]) {
      const existing = result.get(row.category_id) ?? [];
      existing.push(row.sku);
      result.set(row.category_id, existing);
    }
  }
  return result;
}

export async function markSkusUnseen(db: D1Database, skus: string[]): Promise<void> {
  for (const batch of chunk(skus, SQL_CHUNK_SIZE)) {
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => "?").join(",");
    await db.prepare(`UPDATE products SET seen_in_last_run = 0 WHERE sku IN (${placeholders})`).bind(...batch).run();
  }
}

export async function upsertDiscoveredCategories(db: D1Database, categoryUrls: string[]): Promise<void> {
  const statements = categoryUrls.map((url) =>
    db.prepare(`INSERT INTO categories (category_url) VALUES (?) ON CONFLICT(category_url) DO NOTHING`).bind(url)
  );
  for (const batch of chunk(statements, SQL_CHUNK_SIZE)) {
    if (batch.length === 0) continue;
    await db.batch(batch);
  }
}

export async function getCategoriesToCrawl(db: D1Database, limit: number): Promise<CategoryRef[]> {
  const { results } = await db
    .prepare(
      `SELECT category_url, category_id, category_name FROM categories
       ORDER BY (last_crawled_at IS NOT NULL) ASC, last_crawled_at ASC
       LIMIT ?`
    )
    .bind(limit)
    .all();
  return (results as { category_url: string; category_id: string | null; category_name: string | null }[]).map(
    (row) => ({
      categoryUrl: row.category_url,
      categoryId: row.category_id ?? "",
      categoryName: row.category_name ?? "",
    })
  );
}

export async function markCategoryCrawled(
  db: D1Database,
  categoryUrl: string,
  categoryId: string,
  categoryName: string,
  crawledAt: string
): Promise<void> {
  await db
    .prepare(`UPDATE categories SET category_id = ?, category_name = ?, last_crawled_at = ? WHERE category_url = ?`)
    .bind(categoryId, categoryName, crawledAt, categoryUrl)
    .run();
}

/**
 * Advances last_crawled_at WITHOUT touching category_id/category_name,
 * for a category that failed this run (unresolved ID, or any thrown
 * error). Without this, a category that fails deterministically would
 * sort first forever (NULL last_crawled_at sorts first in
 * getCategoriesToCrawl) and permanently occupy a slot in every future
 * run's MAX_CATEGORIES_PER_RUN-capped rotation.
 */
export async function markCategoryAttempted(db: D1Database, categoryUrl: string, attemptedAt: string): Promise<void> {
  await db.prepare(`UPDATE categories SET last_crawled_at = ? WHERE category_url = ?`).bind(attemptedAt, categoryUrl).run();
}
