import { describe, expect, it } from "vitest";
import { decodeHtmlEntities, extractLocUrls, normalizeUrl } from "./parse";

describe("normalizeUrl", () => {
  it("fixes a doubled host", () => {
    const result = normalizeUrl("https://www.www.pcna.com/en-us/apparel");
    expect(result).toEqual({ url: "https://www.pcna.com/en-us/apparel", wasNormalized: true });
  });

  it("leaves an already-correct host unchanged", () => {
    const result = normalizeUrl("https://www.pcna.com/en-us/apparel");
    expect(result).toEqual({ url: "https://www.pcna.com/en-us/apparel", wasNormalized: false });
  });

  it("returns null for a URL matching neither pattern, for the caller to log", () => {
    const result = normalizeUrl("https://not-pcna.example.com/en-us/apparel");
    expect(result).toBeNull();
  });
});

describe("extractLocUrls", () => {
  it("extracts every <loc> entry from a sitemap document", () => {
    const xml = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://www.pcna.com/sitemaps/AllXMLSitemap_0.xml</loc></url>
        <url><loc>https://www.pcna.com/sitemaps/AllXMLSitemap_1.xml</loc></url>
      </urlset>`;
    expect(extractLocUrls(xml)).toEqual([
      "https://www.pcna.com/sitemaps/AllXMLSitemap_0.xml",
      "https://www.pcna.com/sitemaps/AllXMLSitemap_1.xml",
    ]);
  });

  it("decodes entities inside <loc> (e.g. query strings with &amp;)", () => {
    const xml = "<urlset><url><loc>https://www.pcna.com/en-us/search?a=1&amp;b=2</loc></url></urlset>";
    expect(extractLocUrls(xml)).toEqual(["https://www.pcna.com/en-us/search?a=1&b=2"]);
  });

  it("returns an empty array for a document with no <loc> tags", () => {
    expect(extractLocUrls("<urlset></urlset>")).toEqual([]);
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes named entities", () => {
    expect(decodeHtmlEntities("Flashlights &amp; Lanterns")).toBe("Flashlights & Lanterns");
    expect(decodeHtmlEntities("&lt;tag&gt; &quot;quoted&quot; &apos;s&apos;")).toBe(`<tag> "quoted" 's'`);
  });

  it("decodes numeric entities, including the trademark symbol seen on PCNA product pages", () => {
    expect(decodeHtmlEntities("ProudPath&#8482; program")).toBe("ProudPath™ program");
    expect(decodeHtmlEntities("&#x2122;")).toBe("™");
  });

  it("leaves plain text untouched", () => {
    expect(decodeHtmlEntities("Astro Flashlight")).toBe("Astro Flashlight");
  });
});
