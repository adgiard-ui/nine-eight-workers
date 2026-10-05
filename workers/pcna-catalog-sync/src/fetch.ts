import type { CookieJar } from "./types";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

export interface FetchOptions {
  delayMs: number;
  pageSize: number;
}

/**
 * The only module that calls fetch() against pcna.com. Owns the cookie
 * jar (ASP.NET session continuity), the inter-request delay (PCNA sits
 * behind Cloudflare), and the User-Agent. When dealer-auth or a
 * PromoStandards API swap arrives, only this file changes — parse.ts,
 * diff.ts, and csv.ts work on plain strings/objects and don't know PCNA's
 * endpoints exist.
 */
export function createCrawlerFetcher(
  cookieJar: CookieJar,
  options: FetchOptions,
  fetchImpl: typeof fetch = fetch
) {
  let lastRequestAt = 0;

  async function throttledFetch(url: string): Promise<Response> {
    const wait = options.delayMs - (Date.now() - lastRequestAt);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastRequestAt = Date.now();

    const cookieHeader = [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    const res = await fetchImpl(url, {
      headers: {
        "User-Agent": USER_AGENT,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    });

    for (const setCookie of res.headers.getSetCookie()) {
      const [pair] = setCookie.split(";");
      const [name, value] = pair.split("=");
      if (name && value !== undefined) {
        cookieJar.set(name.trim(), value.trim());
      }
    }

    return res;
  }

  async function fetchText(url: string, label: string): Promise<string> {
    const res = await throttledFetch(url);
    if (!res.ok) {
      throw new Error(`${label} failed (${url}): ${res.status}`);
    }
    return res.text();
  }

  return {
    fetchSitemapIndex: (): Promise<string> => fetchText("https://www.pcna.com/sitemap.xml", "Sitemap index fetch"),

    fetchChildSitemap: (url: string): Promise<string> => fetchText(url, "Child sitemap fetch"),

    fetchCategoryPage: (url: string): Promise<string> => fetchText(url, "Category page fetch"),

    fetchProductPage: (params: { categoryId: string; categoryName: string; pageNumber: number }): Promise<string> => {
      const url =
        "https://www.pcna.com/en-us/PCNAProduct/LoadMoreProducts" +
        `?id=${encodeURIComponent(params.categoryId)}` +
        `&name=${encodeURIComponent(params.categoryName)}` +
        "&controllerName=Category" +
        `&pageSize=${options.pageSize}` +
        `&pageNumber=${params.pageNumber}` +
        "&sort=&quantity=&priceFrom=&priceTo=&facetGroup=&fromSearch=";
      return fetchText(url, `Product page fetch (category ${params.categoryId}, page ${params.pageNumber})`);
    },
  };
}

export type CrawlerFetcher = ReturnType<typeof createCrawlerFetcher>;
