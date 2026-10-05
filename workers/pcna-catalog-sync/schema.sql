CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY,
  publish_product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  category TEXT NOT NULL,
  category_id TEXT NOT NULL,
  price TEXT NOT NULL,
  product_url TEXT NOT NULL,
  data_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_changed_at TEXT NOT NULL,
  seen_in_last_run INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_products_category_id ON products (category_id);

-- Tracks every category URL discovered from the sitemap, independent of
-- whether its numeric categoryId has been resolved yet (it can't be,
-- until the category page itself is fetched). last_crawled_at drives the
-- "least-recently-checked first" rotation — NULL (never crawled) sorts
-- first. See db.ts's getCategoriesToCrawl.
CREATE TABLE IF NOT EXISTS categories (
  category_url TEXT PRIMARY KEY,
  category_id TEXT,
  category_name TEXT,
  last_crawled_at TEXT
);
