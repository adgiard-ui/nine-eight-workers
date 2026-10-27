import { describe, expect, it } from "vitest";
import {
  categoryDepth,
  decodeHtmlEntities,
  extractLocUrls,
  normalizeUrl,
  parseCategoryPrefixes,
  parseProductFragment,
  resolveCategoryMeta,
  selectCategoryUrls,
} from "./parse";

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

  it("leaves an out-of-range numeric entity untouched rather than throwing", () => {
    expect(decodeHtmlEntities("&#99999999;")).toBe("&#99999999;");
  });
});

describe("resolveCategoryMeta", () => {
  it("resolves categoryId and categoryName from the data-categoryId/data-category attributes", () => {
    const html = `<div data-categoryid="339" data-category="Flashlights &amp; Lanterns"></div>`;
    expect(resolveCategoryMeta(html, "https://www.pcna.com/en-us/flashlights-lanterns")).toEqual({
      categoryId: "339",
      categoryName: "Flashlights & Lanterns",
    });
  });

  it("falls back to a regex scan for categoryId when the attribute is absent", () => {
    const html = `<script>var config = { categoryId: 339, other: 1 };</script>`;
    const result = resolveCategoryMeta(html, "https://www.pcna.com/en-us/flashlights-lanterns");
    expect(result.categoryId).toBe("339");
  });

  it("falls back to deriving categoryName from the URL slug when no attribute is present", () => {
    const html = `<div>no category data here</div>`;
    const result = resolveCategoryMeta(html, "https://www.pcna.com/en-us/flashlights-lanterns");
    expect(result.categoryName).toBe("Flashlights Lanterns");
  });

  it("returns a null categoryId when neither the attribute nor the fallback regex finds one", () => {
    const html = `<div>nothing useful</div>`;
    const result = resolveCategoryMeta(html, "https://www.pcna.com/en-us/flashlights-lanterns");
    expect(result.categoryId).toBeNull();
  });

  it("ignores decoy data-category/data-categoryId elements that precede the real #layout-category element", () => {
    // Trimmed from the real /en-us/bags page (2026-10-27): every category
    // page carries per-department promo banners (data-category="category-271"
    // etc., Apparel first) and data-categoryId="0" placeholders before the
    // element that actually describes the page.
    const html = `
      <div class="ad-banner-details category-271" data-category="category-271"></div>
      <div class="shopByPrice category-271" data-category="category-271"></div>
      <input type="hidden" data-categoryId="0" data-category="" />
      <div class="ad-banner-details category-272" data-category="category-272"></div>
      <div id="layout-category" data-category="Bags" data-categoryId="272" class="col"></div>
      <div data-sku="1234" data-productname="Tote" data-category="Bags" data-categoryId="272"></div>`;
    expect(resolveCategoryMeta(html, "https://www.pcna.com/en-us/bags")).toEqual({
      categoryId: "272",
      categoryName: "Bags",
    });
  });

  it("never resolves the decoy categoryId \"0\" via the regex fallback when #layout-category is missing", () => {
    const html = `<input type="hidden" data-categoryId="0" data-category="" /><script>var config = { categoryId: 339 };</script>`;
    expect(resolveCategoryMeta(html, "https://www.pcna.com/en-us/bags").categoryId).toBe("339");
  });

  it("returns a null categoryId rather than \"0\" when the only candidate is the placeholder", () => {
    const html = `<input type="hidden" data-categoryId="0" data-category="" />`;
    expect(resolveCategoryMeta(html, "https://www.pcna.com/en-us/bags").categoryId).toBeNull();
  });

  it("falls through to the regex fallback when data-categoryid is present but empty", () => {
    const html = `<div data-categoryid=""></div><script>var config = { categoryId: 339 };</script>`;
    const result = resolveCategoryMeta(html, "https://www.pcna.com/en-us/flashlights-lanterns");
    expect(result.categoryId).toBe("339");
  });
});

describe("parseProductFragment", () => {
  it("parses a product block with the anchor nested inside the data-attribute element", () => {
    const fragment = `
      <div class="product-card">
        <div data-sku="SM-9846" data-publishproductid="16572" data-productName="Astro Flashlight"
             data-category="Flashlights &amp; Lanterns" data-categoryId="339" data-originalPrice="3.78">
          <a href="https://www.pcna.com/en-us/product/astro-flashlight-sm-9846">View</a>
        </div>
      </div>`;

    expect(parseProductFragment(fragment)).toEqual([
      {
        sku: "SM-9846",
        publishProductId: "16572",
        productName: "Astro Flashlight",
        category: "Flashlights & Lanterns",
        categoryId: "339",
        price: "3.78",
        productUrl: "https://www.pcna.com/en-us/product/astro-flashlight-sm-9846",
      },
    ]);
  });

  it("falls back to a fragment-wide SKU-suffix match when the anchor isn't nested inside the data block", () => {
    const fragment = `
      <div class="product-card">
        <div data-sku="PC-1234" data-publishproductid="99888" data-productName="Test Widget"
             data-category="Widgets" data-categoryId="400" data-originalPrice="5.00"></div>
        <div class="card-footer">
          <a href="https://www.pcna.com/en-us/product/test-widget-pc-1234">View</a>
        </div>
      </div>`;

    const [product] = parseProductFragment(fragment);
    expect(product.productUrl).toBe("https://www.pcna.com/en-us/product/test-widget-pc-1234");
  });

  it("parses multiple products in one fragment", () => {
    const fragment = `
      <div data-sku="A-1" data-publishproductid="1" data-productName="One" data-category="C" data-categoryId="1" data-originalPrice="1.00">
        <a href="https://www.pcna.com/en-us/product/one-a-1">View</a>
      </div>
      <div data-sku="A-2" data-publishproductid="2" data-productName="Two" data-category="C" data-categoryId="1" data-originalPrice="2.00">
        <a href="https://www.pcna.com/en-us/product/two-a-2">View</a>
      </div>`;

    expect(parseProductFragment(fragment).map((p) => p.sku)).toEqual(["A-1", "A-2"]);
  });

  it("returns an empty productUrl (not a throw) when no matching anchor exists anywhere in the fragment", () => {
    const fragment = `<div data-sku="NO-URL" data-publishproductid="1" data-productName="No URL" data-category="C" data-categoryId="1" data-originalPrice="1.00"></div>`;
    const [product] = parseProductFragment(fragment);
    expect(product.productUrl).toBe("");
  });

  it("returns an empty array for an exhausted page (no data-sku blocks)", () => {
    expect(parseProductFragment("")).toEqual([]);
    expect(parseProductFragment("<div>No more products.</div>")).toEqual([]);
  });

  // Fixtures below are trimmed/redacted from a real LoadMoreProducts
  // response captured 2026-10-05 against https://www.pcna.com (category
  // 268). Real PCNA markup is a Znode storefront that repeats data-sku
  // across several elements per product (a hidden checkbox+label, one or
  // two "compare"/"wishlist" anchors, per-color swatch <li> elements) plus
  // one per-row price-display wrapper that carries an unrelated, hardcoded
  // placeholder sku and no other product attributes.
  it("still excludes the data-sku-only checkbox/label/swatch siblings, keeping only nodes that also carry data-productname (real markup repeats data-sku across several elements per product; crawl.ts's Map.set dedupes the resulting entries by sku, last one wins)", () => {
    const fragment = `
      <li class="b2b-products spacer-m" data-redirect="pdp" id="product-tile-2853-01">
        <article class="product-item">
          <div class="custom-control custom-checkbox add-to-project-checkbox" style="display: none;">
            <input type="checkbox" class="custom-control-input is-checked" id="product-2853-01"
                   data-sku="2853-01" data-publishproductid="53775" data-productName="Blue Tees Captain Pro Rangefinder"
                   data-category="category-271" data-brand="Blue Tees Golf" data-originalPrice="349.99">
            <label class="custom-control-label" data-sku="2853-01" for="product-2853-01"></label>
          </div>
          <li class="circle active" title="Black">
            <span data-sku="2853-01" data-variantsku="2853-01BK" data-quantity="12"></span>
          </li>
          <li class="wishlisticon btn wishlist-quick-view" data-sku="2853-01" data-publishproductid="53775">
            <a class="default get-sku"
               href="https://www.pcna.com/en-us/product/blue-tees-captain-pro-rangefinder-2853-01"
               data-sku="2853-01"
               data-publishproductid="53775"
               data-productName="Blue Tees Captain Pro Rangefinder"
               data-category="category-271"
               data-categoryId="268"
               data-brand="Blue Tees Golf"
               data-originalPrice="349.99">View</a>
          </li>
        </article>
      </li>`;

    // parseProductFragment itself doesn't dedupe by sku — that's crawl.ts's
    // job (a Map keyed by sku, set once per entry in document order, last
    // write wins). The label and swatch <span> above have no
    // data-productname, so (unlike with the old bare [data-sku] selector)
    // they never produce entries at all; only the checkbox and the anchor
    // do, and both already carry fully correct, consistent data.
    const products = parseProductFragment(fragment);
    expect(products).toHaveLength(2);
    for (const product of products) {
      expect(product.sku).toBe("2853-01");
      expect(product.productName).toBe("Blue Tees Captain Pro Rangefinder");
      expect(product.price).toBe("349.99");
    }

    const deduped = new Map(products.map((p) => [p.sku, p]));
    expect(deduped.get("2853-01")).toEqual({
      sku: "2853-01",
      publishProductId: "53775",
      productName: "Blue Tees Captain Pro Rangefinder",
      category: "category-271",
      categoryId: "268",
      price: "349.99",
      productUrl: "https://www.pcna.com/en-us/product/blue-tees-captain-pro-rangefinder-2853-01",
    });
  });

  it("does not treat a sku-bearing non-product node (real markup: the price-display wrapper's hardcoded placeholder sku) as its own product", () => {
    const fragment = `
      <div data-sku="2853-01" data-publishproductid="53775" data-productName="Blue Tees Captain Pro Rangefinder"
           data-category="category-271" data-categoryId="268" data-originalPrice="349.99">
        <a href="https://www.pcna.com/en-us/product/blue-tees-captain-pro-rangefinder-2853-01">View</a>
      </div>
      <div class="product-sku-title">2853-01</div>
      <div data-test-selector="divPrice" class="price" data-sku="10317" data-type="ConfigurableProduct">
        <span>In Stock</span>
      </div>`;

    const products = parseProductFragment(fragment);
    expect(products).toHaveLength(1);
    expect(products[0].sku).toBe("2853-01");
    expect(products.find((p) => p.sku === "10317")).toBeUndefined();
  });
});

describe("categoryDepth", () => {
  it("counts path segments below /en-us/", () => {
    expect(categoryDepth("https://www.pcna.com/en-us/drinkware")).toBe(1);
    expect(categoryDepth("https://www.pcna.com/en-us/drinkware/tumblers")).toBe(2);
    expect(categoryDepth("https://www.pcna.com/en-us/apparel/hoodies-fleece/hoodies-sweatshirts/quarter-zips/")).toBe(4);
  });
});

describe("selectCategoryUrls", () => {
  const base = "https://www.pcna.com/en-us/";
  const prefixes = ["apparel", "bags"];
  const urlsOf = (selected: { url: string }[]) => selected.map((category) => category.url);

  it("keeps only URLs under an allowlisted department prefix", () => {
    const urls = [
      `${base}apparel/polos`,
      `${base}bags/duffels`,
      `${base}product/wolverine-23l-laptop-backpack-1883-05`,
      `${base}blog/article/anatomy-of-the-perfect-winter-jacket`,
      `${base}brand/stanley`,
      `${base}clearance`,
      `${base}gifts-by-occasion/employee-onboarding`,
      `${base}apparel-decoration`,
    ];
    expect(urlsOf(selectCategoryUrls(urls, prefixes))).toEqual([`${base}apparel/polos`, `${base}bags/duffels`]);
  });

  it("keeps department roots and parents (the sitemap doesn't list every child), flagging only childless ones as leaves", () => {
    const urls = [
      `${base}apparel`,
      `${base}apparel/hoodies-fleece/hoodies-sweatshirts`,
      `${base}apparel/hoodies-fleece/hoodies-sweatshirts/quarter-zips`,
      `${base}apparel/polos`,
    ];
    expect(selectCategoryUrls(urls, prefixes)).toEqual([
      { url: `${base}apparel`, isLeaf: false },
      { url: `${base}apparel/hoodies-fleece/hoodies-sweatshirts`, isLeaf: false },
      { url: `${base}apparel/hoodies-fleece/hoodies-sweatshirts/quarter-zips`, isLeaf: true },
      { url: `${base}apparel/polos`, isLeaf: true },
    ]);
  });

  it("matches whole path segments, not string prefixes", () => {
    const urls = [`${base}bags-pcna`, `${base}apparel/t-shirts`, `${base}apparel/t-shirts-extra`];
    expect(selectCategoryUrls(urls, prefixes)).toEqual([
      { url: `${base}apparel/t-shirts`, isLeaf: true },
      { url: `${base}apparel/t-shirts-extra`, isLeaf: true },
    ]);
  });

  it("is case-insensitive on the prefix, ignores a trailing slash, and dedupes", () => {
    const urls = [`${base}Apparel/Polos/`, `${base}apparel/polos`];
    expect(urlsOf(selectCategoryUrls(urls, prefixes))).toEqual([`${base}Apparel/Polos/`]);
  });

  it("returns nothing for an empty allowlist rather than everything", () => {
    expect(selectCategoryUrls([`${base}apparel/polos`], [])).toEqual([]);
  });
});

describe("parseCategoryPrefixes", () => {
  it("splits a comma-separated list, trimming whitespace and slashes and dropping empties", () => {
    expect(parseCategoryPrefixes(" apparel, /bags/ ,,Drinkware ")).toEqual(["apparel", "bags", "drinkware"]);
  });

  it("returns an empty list for an unset value", () => {
    expect(parseCategoryPrefixes(undefined)).toEqual([]);
  });
});
