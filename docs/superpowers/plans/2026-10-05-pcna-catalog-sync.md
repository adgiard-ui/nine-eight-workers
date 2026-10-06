# pcna-catalog-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `workers/pcna-catalog-sync`, a scheduled Cloudflare Worker that crawls PCNA's product catalog, diffs it against a D1 snapshot, writes new/changed rows to a CSV in R2, and posts a Slack summary — with no agent loop, since this is deterministic data processing.

**Architecture:** Six focused modules (`fetch.ts`, `parse.ts`, `diff.ts`, `csv.ts`, `db.ts`, `slack.ts`) orchestrated by `crawl.ts`, wired to Cloudflare's `scheduled`/`fetch` handlers in `index.ts`. `fetch.ts` is the only module that calls the network, so a future auth/API swap touches one file. Pure logic (`parse.ts`, `diff.ts`, `csv.ts`, and `fetch.ts`'s cookie-jar/delay logic via an injected fake) gets real unit tests with Vitest — new to this repo, scoped to this worker only. Everything that needs a live D1/R2/network binding (`db.ts`, `slack.ts`, `crawl.ts`, `index.ts`) is validated the way every other worker in this repo has been: a manual `wrangler dev` smoke test, documented in the README.

**Tech Stack:** TypeScript, Cloudflare Workers (D1, R2, Cron Triggers), `node-html-parser` (new dependency, HTML parsing), Vitest (new dependency, unit tests for pure logic only), `@nine-eight/core` (`logger` only — not `model-router` or `agent-loop`).

**Spec:** `docs/superpowers/specs/2026-10-05-pcna-catalog-sync-design.md`

## Global Constraints

- No calls to `@nine-eight/core/model-router` or `@nine-eight/core/agent-loop` anywhere in this worker. `ANTHROPIC_API_KEY` and `CLAUDE_MODEL` exist in `Env` and `.dev.vars.example` only as reserved config.
- `@nine-eight/core/logger` is used for every structured run/error log, matching `lead-qualifier`'s pattern.
- `wrangler.toml` (not `.jsonc`), hand-written `Env` interface in `types.ts` (not `wrangler types`-generated) — matches every existing worker in this repo (`workers/lead-qualifier/tsconfig.json`, `wrangler.toml`).
- `FETCH_DELAY_MS` default `500`, `PAGE_SIZE` default `200`, both configurable via `env`.
- Cron: `0 14 * * 1` (Monday 10:00 AM US/Eastern Daylight Time, expressed as fixed UTC — see the spec's note on DST drift).
- D1 rows in `products` are never deleted — `seen_in_last_run` is the discontinuation signal.
- Discontinuation (`seen_in_last_run = false`) is scoped to categories actually crawled in the current run — never applied to categories outside this run's rotation slice. This is the spec's one deliberate deviation from "mark everything not seen as false," approved during design.
- Category reassignment on a stored/observed mismatch is last-write-wins.
- Manual POST trigger requires header `X-Trigger-Secret` matching `env.MANUAL_TRIGGER_SECRET` (new secret, 403 on mismatch/missing). `?async=true` runs it via `ctx.waitUntil()` and returns `202`; the default is synchronous, for small validation runs.
- Every outbound HTTP call to PCNA goes through `fetch.ts` — no other module calls `fetch()` against pcna.com.

---

### Task 1: Scaffold the worker package

**Files:**
- Create: `workers/pcna-catalog-sync/package.json`
- Create: `workers/pcna-catalog-sync/tsconfig.json`
- Create: `workers/pcna-catalog-sync/wrangler.toml`
- Create: `workers/pcna-catalog-sync/.dev.vars.example`
- Create: `workers/pcna-catalog-sync/schema.sql`
- Create: `workers/pcna-catalog-sync/vitest.config.ts`
- Create: `workers/pcna-catalog-sync/src/types.ts`
- Create: `workers/pcna-catalog-sync/src/index.ts` (stub, replaced in Task 11)
- Modify: `package.json:6-11` (root) — add a `test` script

**Interfaces:**
- Produces: `Env` interface, `PRODUCT_FIELDS` const, `ProductField` type, `Product` type, `DiffStatus` type, `DiffResult` interface, `StoredProductRow` interface, `CategoryRef` interface, `CookieJar` type, `RunSummary` interface — all from `src/types.ts`, consumed by every later task.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "pcna-catalog-sync",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@nine-eight/core": "workspace:*",
    "node-html-parser": "^9.0.4"
  },
  "devDependencies": {
    "vitest": "^5.0.3"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Create `schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY,
  publish_product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  category TEXT NOT NULL,
  category_id TEXT NOT NULL,
  price TEXT NOT NULL,
  product_url TEXT NOT NULL,
  data_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_changed_at TEXT NOT NULL,
  seen_in_last_run INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_products_category_id ON products (category_id);

-- Tracks every category URL discovered from the sitemap, independent of
-- whether its numeric categoryId has been resolved yet (it can't be,
-- until the category page itself is fetched). last_crawled_at drives the
-- "least-recently-checked first" rotation — NULL (never crawled) sorts
-- first. See db.ts's getCategoriesToCrawl.
CREATE TABLE IF NOT EXISTS categories (
  category_url TEXT PRIMARY KEY,
  category_id TEXT,
  category_name TEXT,
  last_crawled_at TEXT
);
```

- [ ] **Step 5: Create `wrangler.toml`**

```toml
name = "pcna-catalog-sync"
main = "src/index.ts"
compatibility_date = "2026-08-06" # latest date this repo's pinned wrangler/workerd (4.118.0) supports locally — see ledger ruling
compatibility_flags = ["nodejs_compat"]

[triggers]
# Weekly, Monday 10:00 AM US/Eastern (fixed UTC — drifts 1hr across the
# DST boundary; see the design doc). Edit this line to change cadence.
crons = ["0 14 * * 1"]

[[d1_databases]]
binding = "DB"
database_name = "pcna-catalog-sync-db"
database_id = "REPLACE_WITH_D1_DATABASE_ID" # from `wrangler d1 create` — see README

[[r2_buckets]]
binding = "CSV_BUCKET"
bucket_name = "pcna-catalog-sync-csv"

# Non-secret run config. Unlike lead-qualifier (which has no non-sensitive
# config to separate out), these are plain [vars] so they're
# git-reviewable and editable without a secret rotation.
[vars]
SLACK_CHANNEL = "#pcna-catalog-sync"
MAX_CATEGORIES_PER_RUN = "50"
FETCH_DELAY_MS = "500"
PAGE_SIZE = "200"

# Secrets are intentionally NOT set here — never commit secrets to
# wrangler.toml, even in [vars]. Instead:
#   Local dev:   copy .dev.vars.example to .dev.vars and fill in real values
#   Production:  wrangler secret put <NAME>   (once per secret, per environment)
#
# Required secrets: NANGO_SECRET_KEY, NANGO_CONNECTION_ID, MANUAL_TRIGGER_SECRET.
# Reserved, currently unused by any code path: ANTHROPIC_API_KEY, CLAUDE_MODEL.
```

- [ ] **Step 6: Create `.dev.vars.example`**

```
NANGO_SECRET_KEY=your-nango-secret-key-here
NANGO_CONNECTION_ID=your-nango-slack-connection-id-here
MANUAL_TRIGGER_SECRET=choose-a-long-random-string-here

# Reserved for a future Claude-based extraction step. Nothing in this
# worker calls model-router or the agent loop yet — see the design doc.
ANTHROPIC_API_KEY=your-anthropic-key-here
CLAUDE_MODEL=claude-sonnet-4-5-20250929

# Optional local overrides of wrangler.toml's [vars] block, for a small
# validation run before a full crawl. Uncomment and lower this to test
# against 1-2 categories instead of the full 50.
# MAX_CATEGORIES_PER_RUN=2
```

- [ ] **Step 7: Create `src/types.ts`**

```typescript
/**
 * Bindings and config available to this Worker — see wrangler.toml for
 * [vars]/bindings and .dev.vars.example for secrets. ANTHROPIC_API_KEY and
 * CLAUDE_MODEL are reserved for a future Claude-based extraction step;
 * nothing in this worker's code calls packages/core's model-router or
 * agent-loop with them.
 */
export interface Env {
  DB: D1Database;
  CSV_BUCKET: R2Bucket;
  NANGO_SECRET_KEY: string;
  NANGO_CONNECTION_ID: string;
  MANUAL_TRIGGER_SECRET: string;
  SLACK_CHANNEL: string;
  MAX_CATEGORIES_PER_RUN: string;
  FETCH_DELAY_MS: string;
  PAGE_SIZE: string;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
}

/**
 * Single source of truth for which fields a product carries. Drives both
 * the CSV column order (csv.ts) and the Product type below — adding a
 * field (e.g. a dealer price once authenticated requests exist) means
 * adding it here and nowhere else in the type system.
 */
export const PRODUCT_FIELDS = [
  "sku",
  "publishProductId",
  "productName",
  "category",
  "categoryId",
  "price",
  "productUrl",
] as const;

export type ProductField = (typeof PRODUCT_FIELDS)[number];

export type Product = Record<ProductField, string>;

export type DiffStatus = "NEW" | "CHANGED" | "UNCHANGED";

export interface DiffResult {
  product: Product;
  status: DiffStatus;
  dataHash: string;
}

/** Shape of a row read back from the `products` D1 table. */
export interface StoredProductRow {
  sku: string;
  publishProductId: string;
  productName: string;
  category: string;
  categoryId: string;
  price: string;
  productUrl: string;
  dataHash: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  seenInLastRun: boolean;
}

/** A category as tracked in the `categories` D1 table. */
export interface CategoryRef {
  categoryUrl: string;
  /** Empty string until the category page has been fetched and parsed. */
  categoryId: string;
  categoryName: string;
}

/**
 * Created fresh per run, threaded through fetch.ts's calls as a parameter
 * rather than held as module-level state — Workers best practice, and the
 * same per-invocation-state pattern lead-qualifier already uses for its
 * own guardrails.
 */
export type CookieJar = Map<string, string>;

export interface RunSummary {
  categoriesCrawled: number;
  productsSeen: number;
  newCount: number;
  changedCount: number;
  failedCount: number;
  durationMs: number;
  csvKey: string | null;
}
```

- [ ] **Step 8: Create a stub `src/index.ts`**

This stub only proves the scaffold deploys and the secret check works; Task 11 replaces it with the real `scheduled`/`fetch` wiring to `crawl.ts`.

```typescript
import type { Env } from "./types";

export type { Env };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Only POST requests are supported." }, 405);
    }

    const providedSecret = request.headers.get("X-Trigger-Secret");
    if (!env.MANUAL_TRIGGER_SECRET || providedSecret !== env.MANUAL_TRIGGER_SECRET) {
      return jsonResponse({ error: "Missing or invalid X-Trigger-Secret header." }, 403);
    }

    return jsonResponse({ status: "scaffold ok — crawl not yet implemented" });
  },
};
```

- [ ] **Step 9: Add a root `test` script**

In the root `package.json`, add a `test` script alongside the existing `build` script, following the same `--if-present` pattern (most workers won't have tests, and that's fine):

```json
    "test": "pnpm -r --if-present run test",
```

- [ ] **Step 10: Install dependencies**

Run: `pnpm install`
Expected: resolves `node-html-parser` and `vitest` for `pcna-catalog-sync`, no errors.

- [ ] **Step 11: Verify typecheck and a local smoke test**

Run: `cd workers/pcna-catalog-sync && pnpm run typecheck`
Expected: no errors.

Run: `pnpm run dev` (in `workers/pcna-catalog-sync`), then in another terminal:

```sh
curl.exe -X POST http://127.0.0.1:8787
curl.exe -X POST http://127.0.0.1:8787 -H "X-Trigger-Secret: wrong"
curl.exe -X POST http://127.0.0.1:8787 -H "X-Trigger-Secret: choose-a-long-random-string-here"
```

Expected: first two return `403`, third returns `200` with the scaffold-ok body. (Requires `.dev.vars` copied from `.dev.vars.example` first.)

- [ ] **Step 12: Commit**

```bash
git add workers/pcna-catalog-sync package.json pnpm-lock.yaml
git commit -m "scaffold pcna-catalog-sync worker"
```

---

### Task 2: `parse.ts` — sitemap extraction, URL normalization, entity decoding

**Files:**
- Create: `workers/pcna-catalog-sync/src/parse.ts`
- Test: `workers/pcna-catalog-sync/src/parse.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure functions over strings).
- Produces: `normalizeUrl(rawUrl: string): { url: string; wasNormalized: boolean } | null`, `extractLocUrls(xml: string): string[]`, `decodeHtmlEntities(text: string): string` — all exported from `parse.ts`, consumed by Task 3, 4, and `crawl.ts` (Task 10).

- [ ] **Step 1: Write the failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd workers/pcna-catalog-sync && pnpm vitest run src/parse.test.ts`
Expected: FAIL — `parse.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
const DOUBLED_HOST_PATTERN = /^https:\/\/www\.www\.pcna\.com\//i;
const GOOD_HOST_PATTERN = /^https:\/\/www\.pcna\.com\//i;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes the HTML entities PCNA's markup uses in text fields. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === "#") {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const codePoint = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

/**
 * Fixes PCNA's known doubled-host sitemap bug (www.www.pcna.com, which
 * 404s). Returns null — rather than guessing — for a URL that matches
 * neither the known-good nor known-bad host, so the caller can log it
 * instead of silently dropping it (per the design doc's normalization
 * requirement).
 */
export function normalizeUrl(rawUrl: string): { url: string; wasNormalized: boolean } | null {
  if (DOUBLED_HOST_PATTERN.test(rawUrl)) {
    return { url: rawUrl.replace(DOUBLED_HOST_PATTERN, "https://www.pcna.com/"), wasNormalized: true };
  }
  if (GOOD_HOST_PATTERN.test(rawUrl)) {
    return { url: rawUrl, wasNormalized: false };
  }
  return null;
}

/** Extracts every <loc> URL from a sitemap index or child sitemap document. */
export function extractLocUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => decodeHtmlEntities(match[1]));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/parse.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add workers/pcna-catalog-sync/src/parse.ts workers/pcna-catalog-sync/src/parse.test.ts
git commit -m "pcna-catalog-sync: sitemap extraction, URL normalization, entity decoding"
```

---

### Task 3: `parse.ts` — category ID/name resolution

**Files:**
- Modify: `workers/pcna-catalog-sync/src/parse.ts`
- Modify: `workers/pcna-catalog-sync/src/parse.test.ts`

**Interfaces:**
- Consumes: `decodeHtmlEntities` (Task 2, same file).
- Produces: `resolveCategoryMeta(categoryPageHtml: string, categoryUrl: string): { categoryId: string | null; categoryName: string }`, exported from `parse.ts`, consumed by `crawl.ts` (Task 10).

- [ ] **Step 1: Write the failing tests**

```typescript
import { resolveCategoryMeta } from "./parse";

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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/parse.test.ts`
Expected: FAIL — `resolveCategoryMeta` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `parse.ts` (needs the `node-html-parser` import added at the top of the file — this is the first task that needs it):

```typescript
import { parse as parseHtml } from "node-html-parser";
```

```typescript
/**
 * Resolves the numeric categoryId LoadMoreProducts requires, plus a
 * human-readable categoryName for its `name` query param.
 *
 * categoryId: the data-categoryId attribute first; if a given category
 * page layout doesn't render it, falls back to a best-effort scan for a
 * bare categoryId reference elsewhere in the page (inline script, hidden
 * field) — e.g. `categoryId: 339`, `categoryId=339`, `"categoryId":"339"`.
 * Returns null (never throws) if neither finds one; the caller logs and
 * skips that category for this run.
 *
 * categoryName: the data-category attribute first, else derived from the
 * URL's last path segment. The one documented LoadMoreProducts call in
 * the design doc doesn't suggest this value affects which products come
 * back, only PCNA's own logging/display — the derived fallback is good
 * enough.
 */
export function resolveCategoryMeta(
  categoryPageHtml: string,
  categoryUrl: string
): { categoryId: string | null; categoryName: string } {
  const root = parseHtml(categoryPageHtml);

  const categoryIdAttr = root.querySelector("[data-categoryid]")?.getAttribute("data-categoryid");
  const fallbackMatch = categoryPageHtml.match(/categoryId["']?\s*[:=]\s*["']?(\d+)/i);
  const categoryId = categoryIdAttr ?? fallbackMatch?.[1] ?? null;

  const categoryNameAttr = root.querySelector("[data-category]")?.getAttribute("data-category");
  const categoryName = categoryNameAttr ? decodeHtmlEntities(categoryNameAttr) : deriveCategoryNameFromUrl(categoryUrl);

  return { categoryId, categoryName };
}

function deriveCategoryNameFromUrl(categoryUrl: string): string {
  const slug = categoryUrl.split("/").filter(Boolean).pop() ?? "";
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/parse.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add workers/pcna-catalog-sync/src/parse.ts workers/pcna-catalog-sync/src/parse.test.ts workers/pcna-catalog-sync/package.json pnpm-lock.yaml
git commit -m "pcna-catalog-sync: category ID/name resolution"
```

---

### Task 4: `parse.ts` — product fragment parsing

**Files:**
- Modify: `workers/pcna-catalog-sync/src/parse.ts`
- Modify: `workers/pcna-catalog-sync/src/parse.test.ts`

**Interfaces:**
- Consumes: `decodeHtmlEntities` (Task 2), `Product`/`PRODUCT_FIELDS` (Task 1, `./types`).
- Produces: `parseProductFragment(fragmentHtml: string): Product[]`, exported from `parse.ts`, consumed by `crawl.ts` (Task 10).

**Note on test fixtures:** no raw `LoadMoreProducts` HTML was available at design time (see the design doc). These fixtures are built from the literal attribute example in the original request (`data-sku="SM-9846"`, `data-productName="Astro Flashlight"`, etc.) and must be re-validated against a real response during Task 11's manual smoke test.

- [ ] **Step 1: Write the failing tests**

```typescript
import { parseProductFragment } from "./parse";

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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/parse.test.ts`
Expected: FAIL — `parseProductFragment` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `parse.ts` (needs `HTMLElement` type import added to the existing `node-html-parser` import line, and `Product`/`PRODUCT_FIELDS` imported from `./types`):

```typescript
import { parse as parseHtml, type HTMLElement } from "node-html-parser";
import { logger } from "@nine-eight/core/logger";
import type { Product } from "./types";
```

```typescript
/**
 * Parses one LoadMoreProducts HTML fragment into Product rows. Product
 * blocks are located by the presence of a data-sku attribute, which the
 * original spec confirms is always present. See the file-level note above
 * this function's tests: no raw fragment HTML was available at design
 * time, so this must be re-validated against a real response.
 */
export function parseProductFragment(fragmentHtml: string): Product[] {
  const root = parseHtml(fragmentHtml);
  const productNodes = root.querySelectorAll("[data-sku]");

  const products: Product[] = [];
  for (const node of productNodes) {
    const sku = node.getAttribute("data-sku");
    if (!sku) continue;

    products.push({
      sku: decodeHtmlEntities(sku),
      publishProductId: decodeHtmlEntities(node.getAttribute("data-publishproductid") ?? ""),
      productName: decodeHtmlEntities(node.getAttribute("data-productname") ?? ""),
      category: decodeHtmlEntities(node.getAttribute("data-category") ?? ""),
      categoryId: decodeHtmlEntities(node.getAttribute("data-categoryid") ?? ""),
      price: decodeHtmlEntities(node.getAttribute("data-originalprice") ?? ""),
      productUrl: resolveProductUrl(root, node, sku),
    });
  }
  return products;
}

/**
 * node-html-parser's fragments don't expose parentNode (confirmed against
 * its type definitions), so instead of walking up the tree this: (1)
 * checks the product block's own subtree first, then (2) falls back to
 * the one guaranteed link between a product's data block and its
 * detail-page anchor — PCNA's product URLs end in "-{sku}" (lowercased),
 * e.g. data-sku="SM-9846" -> .../astro-flashlight-sm-9846. Scans every
 * /product/ anchor in the whole fragment for one ending in that suffix.
 * Logs and returns "" (never throws) if neither finds one — one
 * unresolved URL shouldn't drop the product from the run.
 */
function resolveProductUrl(root: HTMLElement, productNode: HTMLElement, sku: string): string {
  const ownAnchor = productNode.querySelector('a[href*="/product/"]');
  const ownHref = ownAnchor?.getAttribute("href");
  if (ownHref) {
    return ownHref;
  }

  const suffix = `-${sku.toLowerCase()}`;
  const candidate = root
    .querySelectorAll('a[href*="/product/"]')
    .find((anchor) => (anchor.getAttribute("href") ?? "").toLowerCase().endsWith(suffix));
  const candidateHref = candidate?.getAttribute("href");
  if (candidateHref) {
    return candidateHref;
  }

  logger.warn("pcna_product_url_unresolved", { sku });
  return "";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/parse.test.ts`
Expected: PASS (18 tests).

- [ ] **Step 5: Commit**

```bash
git add workers/pcna-catalog-sync/src/parse.ts workers/pcna-catalog-sync/src/parse.test.ts
git commit -m "pcna-catalog-sync: product fragment parsing"
```

---

### Task 5: `diff.ts` — hashing, classification, discontinuation scoping

**Files:**
- Create: `workers/pcna-catalog-sync/src/diff.ts`
- Test: `workers/pcna-catalog-sync/src/diff.test.ts`

**Interfaces:**
- Consumes: `Product`, `StoredProductRow`, `DiffStatus` (Task 1, `./types`).
- Produces: `hashProduct(product: Product): Promise<string>`, `classifyProduct(existing: StoredProductRow | null, dataHash: string): DiffStatus`, `computeSkusToMarkUnseen(crawledCategoryIds: Set<string>, storedSkusByCategory: Map<string, string[]>, observedSkus: Set<string>): string[]` — all exported from `diff.ts`, consumed by `crawl.ts` (Task 10).

- [ ] **Step 1: Write the failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/diff.test.ts`
Expected: FAIL — `diff.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
import type { DiffStatus, Product, StoredProductRow } from "./types";

/**
 * SHA-256 over the fields that matter for "did this product change":
 * name, price, category, url. sku/publishProductId are identity, not
 * state — deliberately excluded per the design doc.
 */
export async function hashProduct(product: Product): Promise<string> {
  const payload = [product.productName, product.price, product.category, product.productUrl].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function classifyProduct(existing: StoredProductRow | null, dataHash: string): DiffStatus {
  if (!existing) {
    return "NEW";
  }
  return existing.dataHash === dataHash ? "UNCHANGED" : "CHANGED";
}

/**
 * Discontinuation scoping (design doc, user-approved): MAX_CATEGORIES_PER_RUN
 * caps coverage and rotates across runs, so "not seen this run" only means
 * "discontinued" for categories this run actually crawled. A product
 * stored under a category this run didn't visit is left alone regardless
 * of whether it showed up — it simply hasn't had its turn yet.
 */
export function computeSkusToMarkUnseen(
  crawledCategoryIds: Set<string>,
  storedSkusByCategory: Map<string, string[]>,
  observedSkus: Set<string>
): string[] {
  const toMarkUnseen: string[] = [];
  for (const categoryId of crawledCategoryIds) {
    for (const sku of storedSkusByCategory.get(categoryId) ?? []) {
      if (!observedSkus.has(sku)) {
        toMarkUnseen.push(sku);
      }
    }
  }
  return toMarkUnseen;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/diff.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add workers/pcna-catalog-sync/src/diff.ts workers/pcna-catalog-sync/src/diff.test.ts
git commit -m "pcna-catalog-sync: hashing, classification, discontinuation scoping"
```

---

### Task 6: `csv.ts` — delta CSV generation

**Files:**
- Create: `workers/pcna-catalog-sync/src/csv.ts`
- Test: `workers/pcna-catalog-sync/src/csv.test.ts`

**Interfaces:**
- Consumes: `Product`, `PRODUCT_FIELDS` (Task 1, `./types`).
- Produces: `buildCsv(rows: Product[]): string`, exported from `csv.ts`, consumed by `crawl.ts` (Task 10).

- [ ] **Step 1: Write the failing tests**

```typescript
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
    expect(header).toBe(PRODUCT_FIELDS.join(","));
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
    expect(buildCsv([])).toBe(PRODUCT_FIELDS.join(",") + "\r\n");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/csv.test.ts`
Expected: FAIL — `csv.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
import { PRODUCT_FIELDS } from "./types";
import type { Product } from "./types";

function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Builds the delta CSV from PRODUCT_FIELDS, so a new field is a one-place change (types.ts). */
export function buildCsv(rows: Product[]): string {
  const header = PRODUCT_FIELDS.join(",");
  const lines = rows.map((row) => PRODUCT_FIELDS.map((field) => escapeCsvField(row[field])).join(","));
  return [header, ...lines].join("\r\n") + "\r\n";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/csv.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add workers/pcna-catalog-sync/src/csv.ts workers/pcna-catalog-sync/src/csv.test.ts
git commit -m "pcna-catalog-sync: delta CSV generation"
```

---

### Task 7: `fetch.ts` — the single outbound-HTTP surface

**Files:**
- Create: `workers/pcna-catalog-sync/src/fetch.ts`
- Test: `workers/pcna-catalog-sync/src/fetch.test.ts`

**Interfaces:**
- Consumes: `CookieJar` (Task 1, `./types`).
- Produces: `createCrawlerFetcher(cookieJar: CookieJar, options: { delayMs: number; pageSize: number }, fetchImpl?: typeof fetch)` returning `{ fetchSitemapIndex(), fetchChildSitemap(url), fetchCategoryPage(url), fetchProductPage({categoryId, categoryName, pageNumber}) }` (each `Promise<string>`), exported from `fetch.ts`, consumed by `crawl.ts` (Task 10). This is the **only** module later tasks may call `fetch()` from for pcna.com requests.

- [ ] **Step 1: Write the failing tests**

```typescript
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
    // mockResolvedValueOnce x2, not mockResolvedValue: this test makes two
    // calls, and a single Response body can only be read once (.text() on
    // a reused instance throws "Body has already been read").
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/fetch.test.ts`
Expected: FAIL — `fetch.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/fetch.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add workers/pcna-catalog-sync/src/fetch.ts workers/pcna-catalog-sync/src/fetch.test.ts
git commit -m "pcna-catalog-sync: fetch module (cookie jar, delay, UA)"
```

---

### Task 8: `db.ts` — D1 queries

**Files:**
- Create: `workers/pcna-catalog-sync/src/db.ts`

**Interfaces:**
- Consumes: `Product`, `StoredProductRow`, `CategoryRef` (Task 1, `./types`).
- Produces: `getStoredProductsBySkus(db, skus): Promise<Map<string, StoredProductRow>>`, `upsertProducts(db, rows: {product: Product; dataHash: string}[], now: string): Promise<void>`, `getStoredSkusByCategoryIds(db, categoryIds): Promise<Map<string, string[]>>`, `markSkusUnseen(db, skus): Promise<void>`, `upsertDiscoveredCategories(db, categoryUrls): Promise<void>`, `getCategoriesToCrawl(db, limit): Promise<CategoryRef[]>`, `markCategoryCrawled(db, categoryUrl, categoryId, categoryName, crawledAt): Promise<void>` — all exported from `db.ts`, consumed by `crawl.ts` (Task 10).

**No unit tests** — every function here requires a live `D1Database` binding; validated manually in Task 11 against the local D1 simulation, matching how `lead-qualifier` validated its HubSpot calls (no mocking layer exists in this repo for external bindings).

- [ ] **Step 1: Write the implementation**

```typescript
import type { CategoryRef, Product, StoredProductRow } from "./types";

// D1 has a parameter limit per statement; chunk IN (...) queries and
// batched writes to stay safely under it regardless of run size.
const SQL_CHUNK_SIZE = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function rowToStoredProduct(row: Record<string, unknown>): StoredProductRow {
  return {
    sku: String(row.sku),
    publishProductId: String(row.publish_product_id ?? ""),
    productName: String(row.product_name ?? ""),
    category: String(row.category ?? ""),
    categoryId: String(row.category_id ?? ""),
    price: String(row.price ?? ""),
    productUrl: String(row.product_url ?? ""),
    dataHash: String(row.data_hash ?? ""),
    firstSeenAt: String(row.first_seen_at ?? ""),
    lastSeenAt: String(row.last_seen_at ?? ""),
    lastChangedAt: String(row.last_changed_at ?? ""),
    seenInLastRun: Boolean(row.seen_in_last_run),
  };
}

export async function getStoredProductsBySkus(
  db: D1Database,
  skus: string[]
): Promise<Map<string, StoredProductRow>> {
  const result = new Map<string, StoredProductRow>();
  for (const batch of chunk(skus, SQL_CHUNK_SIZE)) {
    const placeholders = batch.map(() => "?").join(",");
    const { results } = await db
      .prepare(`SELECT * FROM products WHERE sku IN (${placeholders})`)
      .bind(...batch)
      .all();
    for (const row of results) {
      const stored = rowToStoredProduct(row as Record<string, unknown>);
      result.set(stored.sku, stored);
    }
  }
  return result;
}

/**
 * Batched upsert: one D1Database.batch() round trip per chunk, instead of
 * one round trip per product. Keeps a run bounded by MAX_CATEGORIES_PER_RUN
 * from also being bounded by D1 round-trip latency.
 */
export async function upsertProducts(
  db: D1Database,
  rows: { product: Product; dataHash: string }[],
  now: string
): Promise<void> {
  const statements = rows.map(({ product, dataHash }) =>
    db
      .prepare(
        `INSERT INTO products (
           sku, publish_product_id, product_name, category, category_id,
           price, product_url, data_hash, first_seen_at, last_seen_at,
           last_changed_at, seen_in_last_run
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(sku) DO UPDATE SET
           publish_product_id = excluded.publish_product_id,
           product_name = excluded.product_name,
           category = excluded.category,
           category_id = excluded.category_id,
           price = excluded.price,
           product_url = excluded.product_url,
           data_hash = excluded.data_hash,
           last_seen_at = excluded.last_seen_at,
           last_changed_at = CASE
             WHEN products.data_hash != excluded.data_hash THEN excluded.last_changed_at
             ELSE products.last_changed_at
           END,
           seen_in_last_run = 1`
      )
      .bind(
        product.sku,
        product.publishProductId,
        product.productName,
        product.category,
        product.categoryId,
        product.price,
        product.productUrl,
        dataHash,
        now,
        now,
        now
      )
  );

  for (const batch of chunk(statements, SQL_CHUNK_SIZE)) {
    await db.batch(batch);
  }
}

export async function getStoredSkusByCategoryIds(
  db: D1Database,
  categoryIds: string[]
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (const batch of chunk(categoryIds, SQL_CHUNK_SIZE)) {
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => "?").join(",");
    const { results } = await db
      .prepare(`SELECT sku, category_id FROM products WHERE category_id IN (${placeholders})`)
      .bind(...batch)
      .all();
    for (const row of results as { sku: string; category_id: string }[]) {
      const existing = result.get(row.category_id) ?? [];
      existing.push(row.sku);
      result.set(row.category_id, existing);
    }
  }
  return result;
}

export async function markSkusUnseen(db: D1Database, skus: string[]): Promise<void> {
  for (const batch of chunk(skus, SQL_CHUNK_SIZE)) {
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => "?").join(",");
    await db.prepare(`UPDATE products SET seen_in_last_run = 0 WHERE sku IN (${placeholders})`).bind(...batch).run();
  }
}

export async function upsertDiscoveredCategories(db: D1Database, categoryUrls: string[]): Promise<void> {
  const statements = categoryUrls.map((url) =>
    db.prepare(`INSERT INTO categories (category_url) VALUES (?) ON CONFLICT(category_url) DO NOTHING`).bind(url)
  );
  for (const batch of chunk(statements, SQL_CHUNK_SIZE)) {
    if (batch.length === 0) continue;
    await db.batch(batch);
  }
}

export async function getCategoriesToCrawl(db: D1Database, limit: number): Promise<CategoryRef[]> {
  const { results } = await db
    .prepare(
      `SELECT category_url, category_id, category_name FROM categories
       ORDER BY (last_crawled_at IS NOT NULL) ASC, last_crawled_at ASC
       LIMIT ?`
    )
    .bind(limit)
    .all();
  return (results as { category_url: string; category_id: string | null; category_name: string | null }[]).map(
    (row) => ({
      categoryUrl: row.category_url,
      categoryId: row.category_id ?? "",
      categoryName: row.category_name ?? "",
    })
  );
}

export async function markCategoryCrawled(
  db: D1Database,
  categoryUrl: string,
  categoryId: string,
  categoryName: string,
  crawledAt: string
): Promise<void> {
  await db
    .prepare(`UPDATE categories SET category_id = ?, category_name = ?, last_crawled_at = ? WHERE category_url = ?`)
    .bind(categoryId, categoryName, crawledAt, categoryUrl)
    .run();
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd workers/pcna-catalog-sync && pnpm run typecheck`
Expected: no errors. (Functional verification happens in Task 11, once `crawl.ts` and a real D1 binding exist.)

- [ ] **Step 3: Commit**

```bash
git add workers/pcna-catalog-sync/src/db.ts
git commit -m "pcna-catalog-sync: D1 queries"
```

---

### Task 9: `slack.ts` — run summary notification

**Files:**
- Create: `workers/pcna-catalog-sync/src/slack.ts`

**Interfaces:**
- Consumes: `Env`, `RunSummary` (Task 1, `./types`).
- Produces: `postRunSummaryToSlack(env: Env, summary: RunSummary): Promise<void>`, exported from `slack.ts`, consumed by `index.ts` (Task 11).

**No unit test** — requires real Nango/Slack credentials; validated manually in Task 11, same as `lead-qualifier`'s Slack call (also untested).

- [ ] **Step 1: Write the implementation**

```typescript
import { logger } from "@nine-eight/core/logger";
import type { Env, RunSummary } from "./types";

/**
 * Posts the run summary to Slack via Nango's proxy, the same
 * Nango-to-Slack pattern lead-qualifier uses. Unlike lead-qualifier, a
 * failed Slack post here is logged and swallowed rather than surfaced as
 * a run failure — by the time this is called, the crawl has already
 * written its D1/R2 state; losing the notification shouldn't make the run
 * itself look like it failed.
 */
export async function postRunSummaryToSlack(env: Env, summary: RunSummary): Promise<void> {
  let res: Response;
  try {
    res = await fetch("https://api.nango.dev/proxy/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NANGO_SECRET_KEY}`,
        "Provider-Config-Key": "slack",
        "Connection-Id": env.NANGO_CONNECTION_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: env.SLACK_CHANNEL, text: buildSummaryMessage(summary) }),
    });
  } catch (error) {
    logger.error("pcna_slack_post_network_error", { error: String(error) });
    return;
  }

  if (!res.ok) {
    logger.error("pcna_slack_post_failed", { status: res.status, body: await res.text() });
    return;
  }

  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (data.ok === false) {
    logger.error("pcna_slack_post_rejected", { error: data.error });
  }
}

function buildSummaryMessage(summary: RunSummary): string {
  return [
    `*PCNA catalog sync* — ${summary.categoriesCrawled} categories crawled`,
    `Seen: ${summary.productsSeen} | New: ${summary.newCount} | Changed: ${summary.changedCount} | Failed: ${summary.failedCount}`,
    `Duration: ${Math.round(summary.durationMs / 1000)}s`,
    summary.csvKey ? `CSV: ${summary.csvKey}` : "No CSV written (no new/changed products this run).",
  ].join("\n");
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd workers/pcna-catalog-sync && pnpm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add workers/pcna-catalog-sync/src/slack.ts
git commit -m "pcna-catalog-sync: Slack run summary"
```

---

### Task 10: `crawl.ts` — run orchestration

**Files:**
- Create: `workers/pcna-catalog-sync/src/crawl.ts`

**Interfaces:**
- Consumes: `createCrawlerFetcher` (Task 7), `extractLocUrls`/`normalizeUrl`/`resolveCategoryMeta`/`parseProductFragment` (Tasks 2-4), `hashProduct`/`classifyProduct`/`computeSkusToMarkUnseen` (Task 5), `buildCsv` (Task 6), all `db.ts` functions (Task 8), `Env`/`Product`/`RunSummary`/`CookieJar` (Task 1).
- Produces: `runCrawl(env: Env): Promise<RunSummary>`, exported from `crawl.ts`, consumed by `index.ts` (Task 11).

**No unit test** — this is the orchestration layer wiring together everything that needs live D1/R2/network bindings; validated end-to-end in Task 11's manual smoke test. Each piece it calls was already unit-tested in its own task.

- [ ] **Step 1: Write the implementation**

```typescript
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

      // 3. Paginate LoadMoreProducts until exhausted. Confirmed against
      // the real site (Task 11): PCNA does NOT return an empty 200 once
      // a category's pages run out — it 500s on the first overrun page.
      // So a page-level fetch failure, once we've already seen at least
      // one real page of products this category, IS the exhaustion
      // signal, not a category-level failure. A failure on page 1 (no
      // products seen yet) is still a real failure — rethrow it so the
      // outer catch handles it normally. The `products.length === 0`
      // check stays as a secondary signal in case any category ever
      // does return an empty 200 instead.
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

      // Only now — after pagination has fully completed without throwing
      // — does this category count as "crawled" for discontinuation
      // scoping. Adding it to crawledCategoryIds any earlier (e.g. right
      // after resolving categoryId, before pagination) would let a
      // mid-pagination failure (caught below) falsely mark still-live
      // products on unfetched later pages as discontinued, since
      // computeSkusToMarkUnseen trusts this set as "fully checked."
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
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd workers/pcna-catalog-sync && pnpm run typecheck`
Expected: no errors. (Functional verification happens in Task 11.)

- [ ] **Step 3: Commit**

```bash
git add workers/pcna-catalog-sync/src/crawl.ts
git commit -m "pcna-catalog-sync: crawl orchestration"
```

---

### Task 11: `index.ts` — wire `scheduled`/`fetch`, manual-trigger auth, sync/async split

**Files:**
- Modify: `workers/pcna-catalog-sync/src/index.ts` (replaces Task 1's stub)

**Interfaces:**
- Consumes: `runCrawl` (Task 10), `postRunSummaryToSlack` (Task 9), `Env`/`RunSummary` (Task 1).
- Produces: the deployed Worker's `scheduled` and `fetch` handlers — nothing downstream consumes these as a module import; this is the entry point.

- [ ] **Step 1: Write the implementation**

```typescript
import { logger } from "@nine-eight/core/logger";
import { runCrawl } from "./crawl";
import { postRunSummaryToSlack } from "./slack";
import type { Env, RunSummary } from "./types";

export type { Env };

async function runAndNotify(env: Env): Promise<RunSummary> {
  const summary = await runCrawl(env);
  await postRunSummaryToSlack(env, summary);
  return summary;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runAndNotify(env).catch((error) => {
        logger.error("pcna_scheduled_run_failed", { error: String(error) });
      })
    );
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Only POST requests are supported." }, 405);
    }

    const providedSecret = request.headers.get("X-Trigger-Secret");
    if (!env.MANUAL_TRIGGER_SECRET || providedSecret !== env.MANUAL_TRIGGER_SECRET) {
      return jsonResponse({ error: "Missing or invalid X-Trigger-Secret header." }, 403);
    }

    // Default: synchronous, for small MAX_CATEGORIES_PER_RUN validation
    // runs. ?async=true: fire-and-forget via waitUntil, for a full-catalog
    // manual run that would otherwise exceed the HTTP response timeout.
    const isAsync = new URL(request.url).searchParams.get("async") === "true";

    if (isAsync) {
      ctx.waitUntil(
        runAndNotify(env).catch((error) => {
          logger.error("pcna_manual_async_run_failed", { error: String(error) });
        })
      );
      return jsonResponse({ status: "accepted" }, 202);
    }

    try {
      const summary = await runAndNotify(env);
      return jsonResponse(summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("pcna_manual_sync_run_failed", { error: message });
      return jsonResponse({ error: "Crawl run failed.", detail: message }, 500);
    }
  },
};
```

- [ ] **Step 2: Create the D1 database and apply the schema locally**

Run (from `workers/pcna-catalog-sync`):

```sh
wrangler d1 execute pcna-catalog-sync-db --local --file ./schema.sql
```

Expected: creates the `products` and `categories` tables in the local SQLite simulation (no real D1 database or `database_id` needed yet for local-only testing — `--local` keys off the binding name).

- [ ] **Step 3: Set up local secrets and run a small validation crawl**

```sh
cp .dev.vars.example .dev.vars
# Fill in NANGO_SECRET_KEY, NANGO_CONNECTION_ID, MANUAL_TRIGGER_SECRET.
# Uncomment MAX_CATEGORIES_PER_RUN=2 in .dev.vars for this first run.
pnpm run dev
```

In another terminal:

```sh
curl.exe -X POST "http://127.0.0.1:8787" -H "X-Trigger-Secret: YOUR_SECRET"
```

Expected: a JSON `RunSummary` body (`categoriesCrawled: 2`, some `productsSeen` count, `newCount` equal to `productsSeen` on this first-ever run since nothing is in D1 yet, `csvKey` pointing at a `pcna-delta-...csv` object). **This is the point where Task 4's parser fixtures get validated against the real site** — if `productsSeen` is 0 or fields look wrong, inspect the real `LoadMoreProducts` response (e.g. via the Network tab) and adjust `parseProductFragment`/`resolveCategoryMeta` in `parse.ts` before continuing.

- [ ] **Step 4: Verify the async path**

```sh
curl.exe -i -X POST "http://127.0.0.1:8787?async=true" -H "X-Trigger-Secret: YOUR_SECRET"
```

Expected: `202` with `{"status":"accepted"}` returned immediately; the run's log line (`pcna_crawl_run_complete`) appears in the `wrangler dev` terminal a few seconds later.

- [ ] **Step 5: Verify a second run classifies correctly**

Run the Step 3 curl command again, unchanged.

Expected: `newCount: 0`, and most products `UNCHANGED` (not in `deltaRows`, so `csvKey` is likely `null` this time — unless PCNA's catalog genuinely changed between runs). Confirms the hash-based diff is stable across runs.

- [ ] **Step 6: Verify the 403 path**

```sh
curl.exe -X POST "http://127.0.0.1:8787" -H "X-Trigger-Secret: wrong-secret"
curl.exe -X POST "http://127.0.0.1:8787"
```

Expected: both return `403`.

- [ ] **Step 7: Commit**

```bash
git add workers/pcna-catalog-sync/src/index.ts
git commit -m "pcna-catalog-sync: wire scheduled/fetch handlers, manual trigger auth, sync/async split"
```

---

### Task 12: README and manual setup checklist

**Files:**
- Create: `workers/pcna-catalog-sync/README.md`
- Modify: `docs/WORKERS.md` — add a `pcna-catalog-sync` entry, matching the existing `lead-qualifier` entry's format

**Interfaces:** none — documentation only.

- [ ] **Step 1: Write `README.md`**

```markdown
# pcna-catalog-sync

Phase one of a pipeline that will eventually feed NetSuite. Crawls PCNA's
public product catalog on a schedule, detects new/changed products
against a D1 snapshot, writes the deltas to a CSV in R2, and posts a
Slack summary. Deterministic data processing — no agent loop, no Claude
calls. `ANTHROPIC_API_KEY`/`CLAUDE_MODEL` are reserved for a future
Claude-based extraction step and are not wired to any code path yet.

## Trigger

- **Cron:** weekly, Monday 10:00 AM US/Eastern (`0 14 * * 1` in
  `wrangler.toml`, fixed UTC — drifts an hour across the DST boundary).
- **Manual POST `/`:** requires header `X-Trigger-Secret` matching
  `MANUAL_TRIGGER_SECRET`. Synchronous by default (good for a small
  `MAX_CATEGORIES_PER_RUN` validation run); add `?async=true` to run via
  `waitUntil` and get an immediate `202` — required for a full-catalog
  manual run, which would otherwise exceed the HTTP timeout.

## Modules

- `fetch.ts` — the only module that calls `fetch()` against pcna.com.
  Cookie jar, inter-request delay, User-Agent.
- `parse.ts` — sitemap XML -> category URLs (with host-doubling
  normalization), category HTML -> categoryId/categoryName, product
  fragment HTML -> `Product[]`.
- `diff.ts` — SHA-256 hashing, NEW/CHANGED/UNCHANGED classification,
  category-scoped discontinuation marking.
- `csv.ts` — delta CSV generation.
- `db.ts` — all D1 queries.
- `slack.ts` — run summary notification via Nango.
- `crawl.ts` — orchestrates one full run; shared by `scheduled` and the
  manual `fetch` handler.

## Guardrails

- `FETCH_DELAY_MS` (default 500ms) between every outbound request to PCNA.
- `MAX_CATEGORIES_PER_RUN` caps category processing per run; categories
  are processed least-recently-crawled first, so coverage rotates.
- Any single category or page failure is logged and the run continues.
- `seen_in_last_run = false` (the discontinuation signal) is only applied
  within categories this run actually crawled — never across the whole
  catalog, since `MAX_CATEGORIES_PER_RUN` means most categories aren't
  visited on any given run. Rows are never deleted.

## Local setup

```sh
cd workers/pcna-catalog-sync
cp .dev.vars.example .dev.vars
# fill in NANGO_SECRET_KEY, NANGO_CONNECTION_ID, MANUAL_TRIGGER_SECRET
wrangler d1 execute pcna-catalog-sync-db --local --file ./schema.sql
pnpm run dev
```

## Testing

Unit tests (pure logic — parsing, hashing/classification, CSV, the fetch
module's cookie-jar/delay behavior via an injected fake):

```sh
pnpm run test
```

Manual smoke test against the real site, with a small `MAX_CATEGORIES_PER_RUN`
(uncomment the override in `.dev.vars`):

```sh
curl.exe -X POST "http://127.0.0.1:8787" -H "X-Trigger-Secret: YOUR_SECRET"
```

Async path:

```sh
curl.exe -i -X POST "http://127.0.0.1:8787?async=true" -H "X-Trigger-Secret: YOUR_SECRET"
```

Missing/wrong secret (expect `403`):

```sh
curl.exe -X POST "http://127.0.0.1:8787" -H "X-Trigger-Secret: wrong"
```

## Deploy

```sh
cd workers/pcna-catalog-sync
wrangler d1 create pcna-catalog-sync-db   # copy the returned database_id into wrangler.toml
wrangler d1 execute pcna-catalog-sync-db --remote --file ./schema.sql
wrangler r2 bucket create pcna-catalog-sync-csv
wrangler secret put NANGO_SECRET_KEY
wrangler secret put NANGO_CONNECTION_ID
wrangler secret put MANUAL_TRIGGER_SECRET
wrangler deploy
```

## Manual setup checklist

- [ ] `wrangler d1 create pcna-catalog-sync-db`, paste the `database_id`
      into `wrangler.toml`
- [ ] `wrangler d1 execute pcna-catalog-sync-db --remote --file ./schema.sql`
- [ ] `wrangler r2 bucket create pcna-catalog-sync-csv`
- [ ] `wrangler secret put NANGO_SECRET_KEY`
- [ ] `wrangler secret put NANGO_CONNECTION_ID`
- [ ] `wrangler secret put MANUAL_TRIGGER_SECRET` (generate a long random value)
- [ ] Confirm `SLACK_CHANNEL` in `wrangler.toml`'s `[vars]` is the right
      channel for this client/environment
- [ ] Confirm the `#pcna-catalog-sync` (or whatever `SLACK_CHANNEL` is set
      to) Slack channel exists and the Nango Slack connection can post to it
- [ ] `wrangler deploy`
```

- [ ] **Step 2: Add the `docs/WORKERS.md` entry**

Append, matching the existing entries' format:

```markdown
# Worker: pcna-catalog-sync

## Client
Internal pipeline tooling — phase one of a pipeline that will eventually feed NetSuite.

## Process it runs
Crawls PCNA's public product catalog on a schedule (27 sitemaps -> category pages -> paginated product listings), deduplicates by SKU, diffs against a D1 snapshot, writes NEW/CHANGED rows to a CSV in R2, and posts a Slack summary. Deterministic data processing — no agent loop; ANTHROPIC_API_KEY/CLAUDE_MODEL are reserved for a future Claude-based extraction step and unused by any current code path.

## Trigger
Weekly Cloudflare Cron Trigger (Monday 10am Eastern), plus a POST endpoint for manual runs (synchronous by default, `?async=true` for a full-catalog run), gated by a shared `X-Trigger-Secret` header.

## Tools it uses
- fetch.ts (direct, unauthenticated requests to pcna.com — cookie jar, configurable delay, browser User-Agent)
- post_run_summary_to_slack (via Nango proxy to Slack's chat.postMessage)

## Integrations
- PCNA public catalog (direct HTTP, no auth yet — isolated in fetch.ts so dealer-auth or a PromoStandards API swap only touches that file)
- Slack, via Nango (Provider-Config-Key: slack)

## Deployment URL
Not yet deployed — scaffolded and validated against a local `wrangler dev` smoke test. Production deploy pending manual D1/R2/secret setup (see the worker's README checklist).

## Retainer notes
First worker in this repo using D1, R2, and Cron Triggers. First worker with an automated unit test suite (Vitest, scoped to this worker's pure logic only — parsing, hashing/classification, CSV, fetch module cookie-jar/delay behavior). Discontinuation detection (`seen_in_last_run`) is deliberately scoped to categories actually crawled in a given run, not the whole catalog — `MAX_CATEGORIES_PER_RUN` caps per-run coverage and rotates least-recently-crawled-first, so most categories aren't visited on any single run.

## Change log
2026-10-05: Scaffolded per the design doc (`docs/superpowers/specs/2026-10-05-pcna-catalog-sync-design.md`) and implementation plan (`docs/superpowers/plans/2026-10-05-pcna-catalog-sync.md`).
```

- [ ] **Step 3: Commit**

```bash
git add workers/pcna-catalog-sync/README.md docs/WORKERS.md
git commit -m "pcna-catalog-sync: README and manual setup checklist"
```

---

## Self-Review Notes

- **Spec coverage:** every section of the design doc maps to a task —
  sitemap/normalization (Task 2), category resolution (Task 3), product
  parsing (Task 4), hashing/diffing/discontinuation scoping (Task 5), CSV
  (Task 6), the fetch module (Task 7), D1 (Task 8), Slack (Task 9),
  orchestration (Task 10), triggers/auth/sync-async (Task 11), manual
  setup checklist (Task 12).
- **Placeholder scan:** no TBD/TODO; every step has real code or a real
  shell command.
- **Type consistency:** `Product`, `StoredProductRow`, `CategoryRef`,
  `RunSummary`, `CookieJar` are defined once in Task 1 and used with the
  same field names throughout — cross-checked `categoryUrl`/`categoryId`/
  `categoryName` naming between `CategoryRef` (Task 1), `db.ts` (Task 8),
  and `crawl.ts` (Task 10), since that's the one place a mismatch would be
  easy to introduce.
- **Spec correction surfaced during planning:** the design doc's
  `categories` table used `category_id` as the primary key. That's
  circular — a category's ID isn't known until its page is fetched, which
  is exactly the step the rotation needs to pick *before* fetching. This
  plan's `schema.sql` (Task 1) keys `categories` on `category_url`
  instead, with `category_id`/`category_name`/`last_crawled_at` populated
  once resolved. Functionally equivalent to what was approved (same
  rotation behavior, same discontinuation scoping by resolved
  `category_id`), just corrected to avoid the circular dependency.
