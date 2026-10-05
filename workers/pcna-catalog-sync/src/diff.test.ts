import { describe, expect, it } from "vitest";
import { classifyProduct, computeSkusToMarkUnseen, hashProduct } from "./diff";
import type { Product, StoredProductRow } from "./types";

const baseProduct: Product = {
  sku: "SM-9846",
  publishProductId: "16572",
  productName: "Astro Flashlight",
  category: "Flashlights & Lanterns",
  categoryId: "339",
  price: "3.78",
  productUrl: "https://www.pcna.com/en-us/product/astro-flashlight-sm-9846",
};

function storedRow(overrides: Partial<StoredProductRow> = {}): StoredProductRow {
  return {
    sku: "SM-9846",
    publishProductId: "16572",
    productName: "Astro Flashlight",
    category: "Flashlights & Lanterns",
    categoryId: "339",
    price: "3.78",
    productUrl: "https://www.pcna.com/en-us/product/astro-flashlight-sm-9846",
    dataHash: "",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    lastChangedAt: "2026-01-01T00:00:00.000Z",
    seenInLastRun: true,
    ...overrides,
  };
}

describe("hashProduct", () => {
  it("is deterministic for the same meaningful fields", async () => {
    const first = await hashProduct(baseProduct);
    const second = await hashProduct({ ...baseProduct });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when price changes", async () => {
    const original = await hashProduct(baseProduct);
    const changed = await hashProduct({ ...baseProduct, price: "4.00" });
    expect(changed).not.toBe(original);
  });

  it("is not affected by sku or publishProductId (not meaningful fields per the design doc)", async () => {
    const original = await hashProduct(baseProduct);
    const differentSku = await hashProduct({ ...baseProduct, sku: "DIFFERENT-SKU" });
    expect(differentSku).toBe(original);
  });
});

describe("classifyProduct", () => {
  it("classifies NEW when there is no existing row", () => {
    expect(classifyProduct(null, "abc123")).toBe("NEW");
  });

  it("classifies CHANGED when the hash differs from the stored row", () => {
    expect(classifyProduct(storedRow({ dataHash: "old-hash" }), "new-hash")).toBe("CHANGED");
  });

  it("classifies UNCHANGED when the hash matches the stored row", () => {
    expect(classifyProduct(storedRow({ dataHash: "same-hash" }), "same-hash")).toBe("UNCHANGED");
  });
});

describe("computeSkusToMarkUnseen", () => {
  it("marks unseen only within categories actually crawled this run (approved design behavior)", () => {
    // Run crawls categories [A, B] out of [A, B, C, D].
    const crawledCategoryIds = new Set(["A", "B"]);
    const storedSkusByCategory = new Map([
      ["A", ["a-sku-1", "a-sku-2"]],
      ["B", ["b-sku-1"]],
      ["C", ["c-sku-1"]], // not crawled this run
    ]);
    // a-sku-1 and b-sku-1 were observed; a-sku-2 was not (disappeared from A).
    const observedSkus = new Set(["a-sku-1", "b-sku-1"]);

    const result = computeSkusToMarkUnseen(crawledCategoryIds, storedSkusByCategory, observedSkus);

    expect(result).toEqual(["a-sku-2"]);
    // c-sku-1 must NOT appear — category C wasn't crawled this run.
    expect(result).not.toContain("c-sku-1");
  });

  it("returns an empty array when every stored SKU in crawled categories was observed", () => {
    const result = computeSkusToMarkUnseen(
      new Set(["A"]),
      new Map([["A", ["a-sku-1"]]]),
      new Set(["a-sku-1"])
    );
    expect(result).toEqual([]);
  });
});
