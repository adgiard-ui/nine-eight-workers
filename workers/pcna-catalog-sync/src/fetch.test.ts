import { describe, expect, it, vi } from "vitest";
import { createCrawlerFetcher } from "./fetch";
import type { CookieJar } from "./types";

function fakeResponse(body: string, init: { status?: number; setCookie?: string[] } = {}): Response {
  const res = new Response(body, { status: init.status ?? 200 });
  for (const cookie of init.setCookie ?? []) {
    res.headers.append("Set-Cookie", cookie);
  }
  return res;
}

describe("createCrawlerFetcher", () => {
  it("sends no Cookie header on the first request", async () => {
    const cookieJar: CookieJar = new Map();
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse("ok"));
    const fetcher = createCrawlerFetcher(cookieJar, { delayMs: 0, pageSize: 200 }, fetchImpl);

    await fetcher.fetchSitemapIndex();

    const [, requestInit] = fetchImpl.mock.calls[0];
    expect(requestInit.headers.Cookie).toBeUndefined();
  });

  it("captures Set-Cookie from a response and sends it back on the next request", async () => {
    const cookieJar: CookieJar = new Map();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse("ok", { setCookie: ["ASP.NET_SessionId=abc123; Path=/"] }))
      .mockResolvedValueOnce(fakeResponse("ok"));
    const fetcher = createCrawlerFetcher(cookieJar, { delayMs: 0, pageSize: 200 }, fetchImpl);

    await fetcher.fetchSitemapIndex();
    await fetcher.fetchChildSitemap("https://www.pcna.com/sitemaps/AllXMLSitemap_0.xml");

    const [, secondRequestInit] = fetchImpl.mock.calls[1];
    expect(secondRequestInit.headers.Cookie).toBe("ASP.NET_SessionId=abc123");
  });

  it("sets a realistic browser User-Agent on every request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse("ok"));
    const fetcher = createCrawlerFetcher(new Map(), { delayMs: 0, pageSize: 200 }, fetchImpl);

    await fetcher.fetchSitemapIndex();

    const [, requestInit] = fetchImpl.mock.calls[0];
    expect(requestInit.headers["User-Agent"]).toContain("Mozilla/5.0");
  });

  it("waits at least delayMs between consecutive requests", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse("ok"))
      .mockResolvedValueOnce(fakeResponse("ok"));
    const fetcher = createCrawlerFetcher(new Map(), { delayMs: 30, pageSize: 200 }, fetchImpl);

    const start = Date.now();
    await fetcher.fetchSitemapIndex();
    await fetcher.fetchChildSitemap("https://www.pcna.com/sitemaps/AllXMLSitemap_0.xml");
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(25);
  });

  it("builds the LoadMoreProducts URL with id/name/pageSize/pageNumber", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse("ok"));
    const fetcher = createCrawlerFetcher(new Map(), { delayMs: 0, pageSize: 200 }, fetchImpl);

    await fetcher.fetchProductPage({ categoryId: "339", categoryName: "Flashlights & Lanterns", pageNumber: 2 });

    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain("id=339");
    expect(url).toContain("pageSize=200");
    expect(url).toContain("pageNumber=2");
    expect(url).toContain("controllerName=Category");
  });

  it("throws a descriptive error on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse("not found", { status: 404 }));
    const fetcher = createCrawlerFetcher(new Map(), { delayMs: 0, pageSize: 200 }, fetchImpl);

    await expect(fetcher.fetchCategoryPage("https://www.pcna.com/en-us/flashlights")).rejects.toThrow(/404/);
  });
});
