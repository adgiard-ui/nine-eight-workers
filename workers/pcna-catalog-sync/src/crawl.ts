import { logger } from "@nine-eight/core/logger";
import { buildCsv } from "./csv";
import {
  getCategoriesToCrawl,
  getStoredProductsBySkus,
  getStoredSkusByCategoryIds,
  markCategoryAttempted,
  markCategoryCrawled,
  markSkusUnseen,
  upsertDiscoveredCategories,
  upsertProducts,
} from "./db";
import { classifyProduct, computeSkusToMarkUnseen, hashProduct } from "./diff";
import { createCrawlerFetcher, type CrawlerFetcher } from "./fetch";
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
        await markCategoryAttempted(env.DB, category.categoryUrl, now);
        continue;
      }

      const { products, fullyEnumerated } = await enumerateCategoryProducts(fetcher, {
        categoryId: meta.categoryId,
        categoryName: meta.categoryName,
      });
      for (const product of products) {
        // Stamp the category actually being crawled onto every observed
        // product rather than trusting whichever data-categoryId/data-category
        // happened to land on the winning (last-in-document-order) matching
        // element — real PCNA markup doesn't guarantee every element
        // matching [data-sku][data-productname] carries the same attributes.
        // This makes "every stored category_id is one of crawledCategoryIds"
        // true by construction, which is the invariant discontinuation
        // scoping depends on.
        observedProducts.set(product.sku, {
          ...product,
          categoryId: meta.categoryId,
          category: meta.categoryName,
        });
      }

      // Only grant discontinuation-scoping authority over this category
      // when pagination actually saw at least one real product this run —
      // a zero-products-on-page-1 result (markup change, anti-bot
      // interstitial, or a genuinely empty category all look identical)
      // must not be trusted to mean "confirmed nothing here," since that
      // would mass-mark every previously-stored product in this category
      // as discontinued. markCategoryCrawled still runs regardless, so
      // rotation bookkeeping advances either way.
      if (fullyEnumerated) {
        crawledCategoryIds.add(meta.categoryId);
      }
      await markCategoryCrawled(env.DB, category.categoryUrl, meta.categoryId, meta.categoryName, now);
    } catch (error) {
      logger.error("pcna_category_crawl_failed", { url: category.categoryUrl, error: String(error) });
      failedCount++;
      await markCategoryAttempted(env.DB, category.categoryUrl, now);
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

/**
 * Paginates LoadMoreProducts for one category until exhausted. Confirmed
 * against the real site: PCNA does NOT return an empty 200 once a
 * category's pages run out — it 500s on the first overrun page. So once
 * at least one page has yielded real products, a page-fetch failure is
 * treated as "paged past the end," not a category-level failure. A
 * failure on page 1 itself (before any products were ever seen) is still
 * a real failure and propagates to the caller.
 *
 * `fullyEnumerated` tells the caller whether this category's product list
 * can be trusted as complete — false if page 1 itself returned zero
 * products (ambiguous: a genuinely empty category vs. a blocked/broken
 * request look identical). The caller uses this to decide whether to
 * grant discontinuation-scoping authority over this category.
 */
export async function enumerateCategoryProducts(
  fetcher: CrawlerFetcher,
  meta: { categoryId: string; categoryName: string }
): Promise<{ products: Product[]; fullyEnumerated: boolean }> {
  const products: Product[] = [];
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
        logger.warn("pcna_pagination_assumed_exhausted", {
          categoryId: meta.categoryId,
          pageNumber,
          error: String(pageError),
        });
        break;
      }
      throw pageError;
    }

    const pageProducts = parseProductFragment(fragment);
    if (pageProducts.length === 0) {
      break;
    }
    sawAnyProducts = true;
    products.push(...pageProducts);
    pageNumber++;
  }

  return { products, fullyEnumerated: sawAnyProducts };
}

function buildCsvKey(startedAt: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${startedAt.getUTCFullYear()}-${pad(startedAt.getUTCMonth() + 1)}-${pad(startedAt.getUTCDate())}` +
    `-${pad(startedAt.getUTCHours())}${pad(startedAt.getUTCMinutes())}`;
  return `pcna-delta-${stamp}.csv`;
}
