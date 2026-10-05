import { logger } from "@nine-eight/core/logger";
import { buildCsv } from "./csv";
import {
  getCategoriesToCrawl,
  getStoredProductsBySkus,
  getStoredSkusByCategoryIds,
  markCategoryCrawled,
  markSkusUnseen,
  upsertDiscoveredCategories,
  upsertProducts,
} from "./db";
import { classifyProduct, computeSkusToMarkUnseen, hashProduct } from "./diff";
import { createCrawlerFetcher } from "./fetch";
import { extractLocUrls, normalizeUrl, parseProductFragment, resolveCategoryMeta } from "./parse";
import type { CookieJar, Env, Product, RunSummary } from "./types";

export async function runCrawl(env: Env): Promise<RunSummary> {
  const startedAt = Date.now();
  const cookieJar: CookieJar = new Map();
  const fetcher = createCrawlerFetcher(cookieJar, {
    delayMs: Number(env.FETCH_DELAY_MS) || 500,
    pageSize: Number(env.PAGE_SIZE) || 200,
  });

  let failedCount = 0;

  // 1. Sitemap walk: index -> 27 child sitemaps -> category URLs.
  const indexXml = await fetcher.fetchSitemapIndex();
  const categoryUrls = new Set<string>();

  for (const rawChildUrl of extractLocUrls(indexXml)) {
    const normalizedChild = normalizeUrl(rawChildUrl);
    if (!normalizedChild) {
      logger.warn("pcna_sitemap_url_failed_normalization", { url: rawChildUrl });
      failedCount++;
      continue;
    }

    try {
      const childXml = await fetcher.fetchChildSitemap(normalizedChild.url);
      for (const rawCategoryUrl of extractLocUrls(childXml)) {
        const normalizedCategory = normalizeUrl(rawCategoryUrl);
        if (!normalizedCategory) {
          logger.warn("pcna_category_url_failed_normalization", { url: rawCategoryUrl });
          failedCount++;
          continue;
        }
        categoryUrls.add(normalizedCategory.url);
      }
    } catch (error) {
      logger.error("pcna_child_sitemap_failed", { url: normalizedChild.url, error: String(error) });
      failedCount++;
    }
  }

  await upsertDiscoveredCategories(env.DB, [...categoryUrls]);

  // 2. Pick this run's slice: least-recently-crawled first, capped.
  const maxCategories = Number(env.MAX_CATEGORIES_PER_RUN) || 50;
  const categoriesToCrawl = await getCategoriesToCrawl(env.DB, maxCategories);

  const observedProducts = new Map<string, Product>();
  const crawledCategoryIds = new Set<string>();
  const now = new Date().toISOString();

  for (const category of categoriesToCrawl) {
    try {
      const categoryHtml = await fetcher.fetchCategoryPage(category.categoryUrl);
      const meta = resolveCategoryMeta(categoryHtml, category.categoryUrl);

      if (!meta.categoryId) {
        logger.warn("pcna_category_id_unresolved", { url: category.categoryUrl });
        failedCount++;
        continue;
      }

      // 3. Paginate LoadMoreProducts until a page returns no products.
      // PCNA doesn't signal "exhausted" with an empty 200 page like the
      // design assumed — the real site 500s on the first page past the
      // end. Once we've already seen at least one real page of products
      // for this category, treat a page fetch failure as "paged past the
      // end" (log + stop normally) rather than a real failure; a failure
      // on page 1 itself (before any products were ever seen) still means
      // a genuine category-level problem and propagates to the outer catch.
      let pageNumber = 1;
      let sawAnyProducts = false;
      while (true) {
        let fragment: string;
        try {
          fragment = await fetcher.fetchProductPage({
            categoryId: meta.categoryId,
            categoryName: meta.categoryName,
            pageNumber,
          });
        } catch (pageError) {
          if (sawAnyProducts) {
            logger.info("pcna_pagination_assumed_exhausted", {
              url: category.categoryUrl,
              pageNumber,
              error: String(pageError),
            });
            break;
          }
          throw pageError;
        }

        const products = parseProductFragment(fragment);
        if (products.length === 0) {
          break;
        }
        sawAnyProducts = true;
        for (const product of products) {
          observedProducts.set(product.sku, product); // 4. Dedup by SKU.
        }
        pageNumber++;
      }

      // Only mark this category as "crawled" (for discontinuation scoping)
      // once pagination has fully completed without throwing — a partial
      // failure mid-pagination must not make computeSkusToMarkUnseen treat
      // this category's unfetched pages as "confirmed gone".
      crawledCategoryIds.add(meta.categoryId);
      await markCategoryCrawled(env.DB, category.categoryUrl, meta.categoryId, meta.categoryName, now);
    } catch (error) {
      logger.error("pcna_category_crawl_failed", { url: category.categoryUrl, error: String(error) });
      failedCount++;
    }
  }

  // 5. Diff against D1.
  const storedBySku = await getStoredProductsBySkus(env.DB, [...observedProducts.keys()]);
  const deltaRows: Product[] = [];
  const upsertRows: { product: Product; dataHash: string }[] = [];
  let newCount = 0;
  let changedCount = 0;

  for (const product of observedProducts.values()) {
    const dataHash = await hashProduct(product);
    const status = classifyProduct(storedBySku.get(product.sku) ?? null, dataHash);

    if (status === "NEW") newCount++;
    if (status === "CHANGED") changedCount++;
    if (status !== "UNCHANGED") deltaRows.push(product);

    upsertRows.push({ product, dataHash });
  }

  await upsertProducts(env.DB, upsertRows, now);

  // 6. Discontinuation scoping (categories actually crawled this run only).
  const storedSkusByCategory = await getStoredSkusByCategoryIds(env.DB, [...crawledCategoryIds]);
  const skusToMarkUnseen = computeSkusToMarkUnseen(crawledCategoryIds, storedSkusByCategory, new Set(observedProducts.keys()));
  if (skusToMarkUnseen.length > 0) {
    await markSkusUnseen(env.DB, skusToMarkUnseen);
  }

  // 7. CSV + R2 (only when there's something to review).
  let csvKey: string | null = null;
  if (deltaRows.length > 0) {
    csvKey = buildCsvKey(new Date(startedAt));
    await env.CSV_BUCKET.put(csvKey, buildCsv(deltaRows));
  }

  const summary: RunSummary = {
    categoriesCrawled: crawledCategoryIds.size,
    productsSeen: observedProducts.size,
    newCount,
    changedCount,
    failedCount,
    durationMs: Date.now() - startedAt,
    csvKey,
  };

  logger.info("pcna_crawl_run_complete", { ...summary });
  return summary;
}

function buildCsvKey(startedAt: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${startedAt.getUTCFullYear()}-${pad(startedAt.getUTCMonth() + 1)}-${pad(startedAt.getUTCDate())}` +
    `-${pad(startedAt.getUTCHours())}${pad(startedAt.getUTCMinutes())}`;
  return `pcna-delta-${stamp}.csv`;
}
