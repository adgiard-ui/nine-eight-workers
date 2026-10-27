import { describe, expect, it } from "vitest";
import { buildCsv } from "./csv";
import { PRODUCT_FIELDS } from "./types";
import type { Product } from "./types";

const product: Product = {
  sku: "SM-9846",
  publishProductId: "16572",
  productName: "Astro Flashlight",
  category: "Flashlights & Lanterns",
  categoryId: "339",
  price: "3.78",
  productUrl: "https://www.pcna.com/en-us/product/astro-flashlight-sm-9846",
};

describe("buildCsv", () => {
  it("writes a header row matching PRODUCT_FIELDS order", () => {
    const [header] = buildCsv([product]).split("\r\n");
    expect(header).toBe("﻿" + PRODUCT_FIELDS.join(","));
  });

  it("writes one row per product, in PRODUCT_FIELDS order", () => {
    const [, row] = buildCsv([product]).split("\r\n");
    expect(row).toBe(
      "SM-9846,16572,Astro Flashlight,Flashlights & Lanterns,339,3.78,https://www.pcna.com/en-us/product/astro-flashlight-sm-9846"
    );
  });

  it("quotes and escapes a field containing a comma or a double quote", () => {
    const withComma: Product = { ...product, productName: 'Flashlight, 3" Beam' };
    const [, row] = buildCsv([withComma]).split("\r\n");
    expect(row).toContain('"Flashlight, 3"" Beam"');
  });

  it("produces only the header plus a trailing CRLF for an empty row list", () => {
    expect(buildCsv([])).toBe("﻿" + PRODUCT_FIELDS.join(",") + "\r\n");
  });

  it("starts with a UTF-8 byte-order mark so Excel decodes non-ASCII text (e.g. the trademark symbol) correctly", () => {
    const csv = buildCsv([{ ...product, productName: "Astro™ Flashlight" }]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(new TextEncoder().encode(csv).slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
  });
});
