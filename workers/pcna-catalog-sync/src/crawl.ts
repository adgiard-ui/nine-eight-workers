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
import { classifyProduct, computeSkusToMarkUnseen, hashProduct, preferSpecificCategory } from "./diff";
import { createCrawlerFetcher, type CrawlerFetcher } from "./fetch";
import {
  extractLocUrls,
  normalizeUrl,
  parseCategoryPrefixes,
  parseProductFragment,
  resolveCategoryMeta,
  selectCategoryUrls,
} from "./parse";
import type { CookieJar, Env, Product, RunSummary } from "./types";

export async function runCrawl(env: Env): Promise<RunSummary> {
  const startedAt = Date.now();
  const cookieJar: CookieJar = new Map();
  const fetcher = createCrawlerFetcher(cookieJar, {
    delayMs: Number(env.FETCH_DELAY_MS) || 500,
    pageSize: Number(env.PAGE_SIZE) || 200,
  });

  let failedCount = 0;

  // 1. Sitemap walk: index -> 27 child sitemaps -> every listed URL
  // (products, blog, CMS pages and categories alike — filtered below).
  const indexXml = await fetcher.fetchSitemapIndex();
  const sitemapUrls = new Set<string>();
  let unnormalizableUrlCount = 0;

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
          // PCNA lists ~28 bare relative paths (e.g. "apparel-decoration"),
          // all CMS pages as of 2026-10-16. Logged, but not counted in
          // failedCount — they recur every run and would drown out real
          // failures in the run summary.
          logger.warn("pcna_category_url_failed_normalization", { url: rawCategoryUrl });
          unnormalizableUrlCount++;
          continue;
        }
        sitemapUrls.add(normalizedCategory.url);
      }
    } catch (error) {
      logger.error("pcna_child_sitemap_failed", { url: normalizedChild.url, error: String(error) });
      failedCount++;
    }
  }

  // 2. Keep only department category pages (see selectCategoryUrls).
  const categoryPrefixes = parseCategoryPrefixes(env.CATEGORY_PATH_PREFIXES);
  const selectedCategories = selectCategoryUrls([...sitemapUrls], categoryPrefixes);
  const categoryUrls = selectedCategories.map((category) => category.url);
  const leafCategoryUrls = new Set(selectedCategories.filter((category) => category.isLeaf).map((category) => category.url));
  logger.info("pcna_sitemap_filtered", {
    sitemapUrls: sitemapUrls.size,
    unnormalizableUrls: unnormalizableUrlCount,
    categoriesDiscovered: categoryUrls.length,
    prefixes: categoryPrefixes,
  });
  if (categoryUrls.length === 0) {
    // Fail loudly (runAndNotify posts it to Google Chat) rather than report a
    // "successful" run that crawled nothing — an unset/typo'd
    // CATEGORY_PATH_PREFIXES or a PCNA URL restructure both land here.
    throw new Error(
      `No sitemap URLs matched CATEGORY_PATH_PREFIXES (${categoryPrefixes.join(",") || "unset"}) out of ${sitemapUrls.size} sitemap URLs`
    );
  }

  await upsertDiscoveredCategories(env.DB, categoryUrls);

  // 3. Pick this run's slice: least-recently-crawled first, capped.
  const maxCategories = Number(env.MAX_CATEGORIES_PER_RUN) || 50;
  const categoriesToCrawl = await getCategoriesToCrawl(env.DB, maxCategories, new Set(categoryUrls));

  const observedProducts = new Map<string, Product>();
  const skusSeenOnLeafPage = new Set<string>();
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
      const isLeaf = leafCategoryUrls.has(category.categoryUrl);
      for (const product of products) {
        // A parent page lists its children's products too; don't let it
        // overwrite a leaf observation from earlier in this same run.
        if (!isLeaf && skusSeenOnLeafPage.has(product.sku)) {
          continue;
        }
        if (isLeaf) {
          skusSeenOnLeafPage.add(product.sku);
        }
        // Stamp the category actually being crawled onto every observed
        // product rather than trusting whichever data-categoryId/data-category
        // happened to land on the winning (last-in-document-order) matching
        // element — real PCNA markup doesn't guarantee every element
        // matching [data-sku][data-productname] carries the same attributes.
        // This makes "every observed product's category_id is one this run
        // crawled" true by construction, which discontinuation scoping
        // depends on. The one exception is deliberate: a parent-page
        // observation of an already-stored product keeps its stored leaf
        // category (preferSpecificCategory, at diff time) — that product
        // is in observedProducts, so it's never wrongly marked unseen.
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

  for (const observed of observedProducts.values()) {
    const stored = storedBySku.get(observed.sku) ?? null;
    const product = preferSpecificCategory(observed, skusSeenOnLeafPage.has(observed.sku), stored);
    const dataHash = await hashProduct(product);
    const status = classifyProduct(stored, dataHash);

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
    sitemapUrls: sitemapUrls.size,
    categoriesDiscovered: categoryUrls.length,
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
