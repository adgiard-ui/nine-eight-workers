import { describe, expect, it, vi } from "vitest";
import { enumerateCategoryProducts } from "./crawl";
import type { CrawlerFetcher } from "./fetch";

function fakeFetcher(fetchProductPage: CrawlerFetcher["fetchProductPage"]): CrawlerFetcher {
  return {
    fetchSitemapIndex: vi.fn(),
    fetchChildSitemap: vi.fn(),
    fetchCategoryPage: vi.fn(),
    fetchProductPage,
  } as unknown as CrawlerFetcher;
}

const PRODUCT_FRAGMENT = `<div data-sku="A-1" data-publishproductid="1" data-productname="One" data-category="C" data-categoryid="1" data-originalprice="1.00"><a href="https://www.pcna.com/en-us/product/one-a-1">View</a></div>`;
const EMPTY_FRAGMENT = `<div>No more products.</div>`;

describe("enumerateCategoryProducts", () => {
  it("paginates until a page returns zero products, and is fullyEnumerated", async () => {
    const fetchProductPage = vi
      .fn()
      .mockResolvedValueOnce(PRODUCT_FRAGMENT)
      .mockResolvedValueOnce(EMPTY_FRAGMENT);
    const fetcher = fakeFetcher(fetchProductPage);

    const result = await enumerateCategoryProducts(fetcher, { categoryId: "1", categoryName: "C" });

    expect(result.products).toHaveLength(1);
    expect(result.fullyEnumerated).toBe(true);
    expect(fetchProductPage).toHaveBeenCalledTimes(2);
  });

  it("is NOT fullyEnumerated when page 1 itself returns zero products", async () => {
    const fetchProductPage = vi.fn().mockResolvedValueOnce(EMPTY_FRAGMENT);
    const fetcher = fakeFetcher(fetchProductPage);

    const result = await enumerateCategoryProducts(fetcher, { categoryId: "1", categoryName: "C" });

    expect(result.products).toHaveLength(0);
    expect(result.fullyEnumerated).toBe(false);
  });

  it("treats a page failure after at least one successful page as exhaustion, and is fullyEnumerated", async () => {
    const fetchProductPage = vi
      .fn()
      .mockResolvedValueOnce(PRODUCT_FRAGMENT)
      .mockRejectedValueOnce(new Error("500"));
    const fetcher = fakeFetcher(fetchProductPage);

    const result = await enumerateCategoryProducts(fetcher, { categoryId: "1", categoryName: "C" });

    expect(result.products).toHaveLength(1);
    expect(result.fullyEnumerated).toBe(true);
  });

  it("rethrows a page-1 failure (no products seen yet) rather than treating it as exhaustion", async () => {
    const fetchProductPage = vi.fn().mockRejectedValueOnce(new Error("500"));
    const fetcher = fakeFetcher(fetchProductPage);

    await expect(enumerateCategoryProducts(fetcher, { categoryId: "1", categoryName: "C" })).rejects.toThrow("500");
  });
});
