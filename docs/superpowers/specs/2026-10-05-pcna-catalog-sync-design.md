# pcna-catalog-sync — Design

**Status:** Approved. Proceeding to implementation plan.
**Date:** 2026-10-05

## Purpose

Phase one of a pipeline that will eventually feed NetSuite. Crawls PCNA's
public product catalog on a schedule, detects new and changed products
relative to a stored snapshot, and writes the deltas to a CSV in R2 for
manual review. CSV output (rather than writing directly to a system of
record) lets accuracy be validated before anything touches NetSuite.

This worker is deterministic data processing. **No agent loop, no Claude
calls.** `ANTHROPIC_API_KEY` and `CLAUDE_MODEL` are carried in `Env` and
`.dev.vars.example` only as reserved configuration for a possible future
Claude-based extraction step — nothing in this worker's code calls
`packages/core/model-router` or `packages/core/agent-loop`. `packages/core/logger`
*is* used throughout for structured run logging, matching `lead-qualifier`'s
pattern.

## Discovered site structure

- Sitemap index: `https://www.pcna.com/sitemap.xml` → 27 child sitemaps
  (`AllXMLSitemap_0.xml` through `AllXMLSitemap_26.xml`), each listing
  category page URLs.
- **Known data issue:** some sitemap URLs have a doubled host
  (`https://www.www.pcna.com/...`) — confirmed these 404 as-is. Normalize to
  a single `www.` before fetching. Any URL that fails normalization (i.e.
  doesn't match the expected doubled-host pattern but is still malformed) is
  logged, not silently dropped.
- Category pages carry a numeric category ID needed for the product
  endpoint. Products on the page carry a `data-categoryId` attribute; if
  that's missing on a given page, fall back to a best-effort regex scan of
  the page HTML for a `categoryId` value (e.g. in an inline script or hidden
  field). If both fail, log and skip that category for this run — it is not
  a fatal error for the overall crawl.
- Product listing endpoint (returns an HTML fragment, not JSON):

  ```
  https://www.pcna.com/en-us/PCNAProduct/LoadMoreProducts
    ?id={categoryId}
    &name={categoryName}
    &controllerName=Category
    &pageSize=200
    &pageNumber={n}
    &sort=&quantity=&priceFrom=&priceTo=&facetGroup=&fromSearch=
  ```

  Paginate `pageNumber` starting at 1 until a response contains no products.

- Each product in the fragment carries structured data attributes
  (`data-sku`, `data-publishproductid`, `data-productName`, `data-category`,
  `data-categoryId`, `data-originalPrice`) plus a nearby anchor linking to
  the product detail page
  (`https://www.pcna.com/en-us/product/{slug}-{sku}`).

  **No raw HTML sample of the fragment or the exhausted-pagination response
  was available during design** — only the attribute names/values given in
  the original request, and rendered (not source) page text confirming the
  card's visible shape (brand, name, item code, two price tiers, MOQ). The
  parser (see below) is written defensively against this uncertainty and
  must be validated against a real `LoadMoreProducts` response during the
  first local test run, before a full crawl.

## Fields captured

`sku` (primary key), `publishProductId`, `productName`, `category`,
`categoryId`, `price`, `productUrl`. HTML entities in text fields are
decoded. The field list is designed to be easy to extend — see "CSV &
field extensibility" below.

## Flow

1. Fetch the sitemap index, then all 27 child sitemaps.
2. Extract and normalize category URLs.
3. For each category (least-recently-crawled first, capped at
   `MAX_CATEGORIES_PER_RUN`), resolve its numeric category ID.
4. Paginate `LoadMoreProducts` until exhausted, parsing products from each
   fragment.
5. Deduplicate by SKU (products can appear in multiple categories — see
   "Category reassignment" below for what happens to the stored category on
   a conflict).
6. Compare each deduplicated product against its D1 row — classify NEW,
   CHANGED, or UNCHANGED (see "Diffing" below).
7. Write NEW and CHANGED rows to a CSV; store it in R2 with a timestamped
   filename.
8. Update the D1 snapshot (see "Discontinuation scoping" below for exactly
   which rows get touched).
9. Post a run summary to Slack: products seen, new, changed, failed, plus
   the CSV's R2 key.

## Storage

### D1

**`products`** (as originally specified):

| Column | Type | Notes |
|---|---|---|
| `sku` | TEXT PRIMARY KEY | |
| `publish_product_id` | TEXT | |
| `product_name` | TEXT | |
| `category` | TEXT | last-observed category name (see reassignment below) |
| `category_id` | TEXT | last-observed category id |
| `price` | TEXT | |
| `product_url` | TEXT | |
| `data_hash` | TEXT | SHA-256 over name\|price\|category\|url |
| `first_seen_at` | TEXT (ISO) | set once, on insert |
| `last_seen_at` | TEXT (ISO) | updated whenever this run observes the product |
| `last_changed_at` | TEXT (ISO) | updated only when `data_hash` changes |
| `seen_in_last_run` | INTEGER (0/1) | see discontinuation scoping |

**`categories`** (new — not in the original request, added to support
rotation; see "Design additions" below). Keyed on `category_url`, not
`category_id` — a category's numeric ID isn't known until its page is
fetched, which is exactly the step the rotation needs to pick *before*
fetching (corrected during implementation planning; the original design
conversation implied `category_id` as the key, which is circular):

| Column | Type | Notes |
|---|---|---|
| `category_url` | TEXT PRIMARY KEY | known from the sitemap, before the page is ever fetched |
| `category_id` | TEXT | populated once the category page is resolved |
| `category_name` | TEXT | populated once the category page is resolved |
| `last_crawled_at` | TEXT (ISO) | drives least-recently-crawled ordering; `NULL` (never crawled) sorts first |

Rows are never deleted from either table.

### R2

CSV outputs, one object per run, named `pcna-delta-YYYY-MM-DD-HHMM.csv`
(UTC, based on run start time).

## Diffing & discontinuation scoping

A product is classified by comparing its computed `data_hash` (SHA-256 over
the concatenation of name, price, category, and url) against the stored
row:

- No existing row → **NEW**
- Existing row, hash differs → **CHANGED** (`last_changed_at` updated)
- Existing row, hash matches → **UNCHANGED** (not written to CSV, but
  `last_seen_at` and `seen_in_last_run` still refresh)

**Discontinuation scoping (design addition, user-approved):** because
`MAX_CATEGORIES_PER_RUN` caps coverage and coverage rotates across runs,
"not seen this run" is not the same as "discontinued" for the majority of
the catalog on any given run. `seen_in_last_run` is set to `false` only for
products whose *stored* `category_id` is among the categories actually
crawled this run and that were not observed in this run's crawl of that
category. Products belonging to categories not visited this run are left
untouched — their `seen_in_last_run` value carries over unchanged.

**Category reassignment (design addition, user-approved):** because
dedup-by-SKU collapses a multi-category product to a single row, if a
product is observed under a different category than its stored one,
this run's observation wins (last-write-wins on `category`/`category_id`).

## Architecture

- **`fetch.ts`** — the only module that calls `fetch()`. Exposes
  `fetchSitemapIndex()`, `fetchChildSitemap(url)`, `fetchCategoryPage(url)`,
  `fetchProductPage({categoryId, categoryName, pageNumber})`, all returning
  raw text. Internally owns:
  - a cookie jar (`Map<string, string>`, created fresh per run and threaded
    through as a parameter — not module-level state — merged from
    `Set-Cookie` response headers, sent back as `Cookie` on subsequent
    requests)
  - the configurable inter-request delay (`FETCH_DELAY_MS`, default 500ms)
  - a realistic browser User-Agent constant

  Nothing in parsing, diffing, or output needs to change when PCNA requires
  authenticated dealer-pricing requests, or when/if this swaps to a
  PromoStandards API — only this file changes.

- **`parse.ts`** — sitemap XML → category URLs (with host-doubling
  normalization + failure logging); category HTML → categoryId (attribute
  first, regex fallback second); product fragment HTML → `Product[]`.
  Uses `node-html-parser` (new dependency — no HTML parser currently exists
  in this repo; chosen for being lightweight and dependency-free beyond
  itself, Workers-compatible without `nodejs_compat`-only APIs). HTML
  entities in text fields are decoded. Product blocks are located by
  presence of a `data-sku` attribute (guaranteed present per spec); the
  nearby product-URL anchor is resolved by searching the block's subtree
  first, then its ancestor's siblings, logging (not throwing) if neither
  yields a match — an unresolved URL does not drop the product from the
  run, only logs a warning.

- **`diff.ts`** — hashing (SHA-256 via `crypto.subtle.digest`) and
  classification, including the discontinuation-scoping and
  category-reassignment logic above.

- **`db.ts`** — all D1 queries: upsert product, mark-unseen (scoped),
  category rotation ordering (`ORDER BY last_crawled_at ASC LIMIT
  MAX_CATEGORIES_PER_RUN`), category last-crawled-at update.

- **`csv.ts`** — builds the delta CSV from a single `PRODUCT_FIELDS`
  ordered list that also drives the D1 row shape, so adding a field later
  (e.g. a dealer price once authenticated requests exist) is a one-place
  change rather than a scattered one.

- **`crawl.ts`** — orchestrates one full run (shared by both the `scheduled`
  handler and the manual POST handler): sitemap walk → category resolution
  → pagination → dedup → diff → CSV/R2 → D1 update → Slack summary. Returns
  `{seen, new, changed, failed, durationMs, csvKey}`.

- **`index.ts`** — wires `scheduled()` and `fetch()` to `crawl.ts`.

## Guardrails

- `FETCH_DELAY_MS` (default 500ms) between outbound requests.
- Realistic browser User-Agent on all requests.
- Cookie jar maintained across requests within a run (ASP.NET session
  continuity).
- `MAX_CATEGORIES_PER_RUN` caps category processing per run; categories are
  ordered least-recently-crawled first so coverage rotates.
- Any single category or page failure is logged and the run continues —
  one bad fetch does not kill the run.
- A single structured summary log (counts + duration) at the end of every
  run, cron or manual.

## Triggers

- **Cron:** weekly, `0 14 * * 1` (Monday 10:00 AM US/Eastern, expressed as
  UTC in `wrangler.toml` cron syntax) — trivially editable. Cron Triggers
  are fixed UTC; `14:00` is correct for Eastern Daylight Time (current, and
  through early November). Once EST resumes it becomes 9:00 AM Eastern
  until manually adjusted to `0 15 * * 1` — worth a calendar reminder rather
  than solving in code for a once-a-year, one-hour drift.
- **Manual POST `/`:** requires header `X-Trigger-Secret` matching
  `env.MANUAL_TRIGGER_SECRET` (403 on mismatch or missing header).
  - Default (no query param): runs synchronously, returns the JSON summary
    in the HTTP response. Intended for small, `MAX_CATEGORIES_PER_RUN`-capped
    validation runs during development.
  - `?async=true`: kicks the run off via `ctx.waitUntil()` and returns `202`
    immediately. Required for a full-catalog manual run, which would
    otherwise exceed the HTTP response timeout.

## Config (env vars)

`ANTHROPIC_API_KEY`, `NANGO_SECRET_KEY`, `NANGO_CONNECTION_ID`,
`SLACK_CHANNEL`, `MAX_CATEGORIES_PER_RUN`, `FETCH_DELAY_MS`, `PAGE_SIZE`
(default 200), `CLAUDE_MODEL`, `MANUAL_TRIGGER_SECRET` (new, see
"Triggers"). `.dev.vars.example` documents all of these.

## Design additions beyond the original request (flagged for visibility)

1. **`categories` D1 table** — required to implement "least-recently-checked
   first" rotation; nothing in the original `products`-only schema tracked
   that state.
2. **Discontinuation scoping** — the literal spec text ("mark
   `seen_in_last_run = false` for products that disappear") would, applied
   naively against a rotating partial crawl, falsely flag most of the
   catalog as discontinued every run. Scoped to categories actually crawled
   this run instead — user-approved.
3. **Category reassignment on conflict** — last-write-wins, user-approved.
4. **`?async=true` on the manual trigger** — user-added, to avoid HTTP
   timeout on a full-catalog manual run.
5. **`MANUAL_TRIGGER_SECRET`** — user-approved, to prevent unauthenticated
   triggering of a real crawl against PCNA once deployed.

## Testing plan

- Local `wrangler dev` with `MAX_CATEGORIES_PER_RUN` set low (e.g. 1–2) in
  `.dev.vars`, triggered via the synchronous manual POST endpoint, to
  validate the full pipeline end-to-end on a small slice before a real
  crawl.
- Validate the parser specifically against a real `LoadMoreProducts`
  response during this first run, since no raw fragment HTML was available
  at design time (see "Discovered site structure").
- Confirm the sitemap host-doubling normalization against a real doubled
  URL from the live sitemap.
- Confirm the 404/malformed-payload and 403 (missing/wrong trigger secret)
  paths return clear errors.
- Confirm a second local run against the same small category set correctly
  classifies previously-seen products as UNCHANGED, and a manually-edited
  D1 row as CHANGED.

## Manual setup required (not done by this plan)

- Create the D1 database (`pcna-catalog-sync-db`) and apply `schema.sql`.
- Create the R2 bucket (`pcna-catalog-sync-csv`).
- Set secrets: `ANTHROPIC_API_KEY`, `NANGO_SECRET_KEY`, `NANGO_CONNECTION_ID`,
  `MANUAL_TRIGGER_SECRET`.
- Set `SLACK_CHANNEL`, `MAX_CATEGORIES_PER_RUN`, `FETCH_DELAY_MS`,
  `PAGE_SIZE` as vars (or secrets, if preferred) per environment.

## Post-implementation changes (added 2026-10-27)

This doc is the 2026-10-05 design as approved; it is left as written. The
following changed after implementation — the worker README is the
current reference.

- **Sitemap → categories is filtered** (2026-10-16). The sitemap is not
  a category list: of ~2,600 URLs, only 118 are department category
  pages. Flow step 2 and `parse.ts` now keep only URLs under an allowlisted
  department (`CATEGORY_PATH_PREFIXES` in `wrangler.toml`), roots and
  parents included. Re-verified against the live site 2026-10-27
  (94 leaves + 24 parents/roots); at `MAX_CATEGORIES_PER_RUN = 50`, a full
  rotation takes 3 weekly runs.
- **Category reassignment is no longer pure last-write-wins** (design
  addition 3). A product takes the deepest category URL it's been seen
  under; shallower or equal-depth sightings keep the stored category
  unless that category was re-crawled this run without the product.
  (2026-10-16 first did this with a leaf/non-leaf flag; the 2026-10-27
  review showed sitemap "non-leaf" pages like `drinkware/tumblers` could
  then never upgrade a product stored under a root, so it now uses depth.)
- **Rotation query** (`db.ts`): ordering is unchanged, but the cap and the
  "still in this run's filtered sitemap" check are applied in JS rather
  than via `LIMIT`, so stale `categories` rows never take rotation slots.
- **`?async=true` cannot run a full-catalog slice** (design addition 4).
  Cloudflare stops `waitUntil` work 30 seconds after the response is sent;
  a full run must go through the scheduled handler (15-minute limit).
- **Notifications go to Google Chat, not Slack** (2026-10-27). `slack.ts`
  (Slack via Nango) is replaced by `notify.ts`, which posts to a Google
  Chat incoming webhook (`GOOGLE_CHAT_WEBHOOK_URL` secret). The Nango
  secrets and `SLACK_CHANNEL` are gone; an unset webhook means no
  notifications.
- Also added: UTF-8 BOM on the CSV, `sitemapUrls`/`categoriesDiscovered`
  in the run summary, constant-time trigger-secret comparison.
