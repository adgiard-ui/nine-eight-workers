# pcna-catalog-sync

Phase one of a pipeline that will eventually feed NetSuite. Crawls PCNA's
public product catalog on a schedule, detects new/changed products
against a D1 snapshot, writes the deltas to a CSV in R2, and posts a
Google Chat summary. Deterministic data processing — no agent loop, no Claude
calls. `ANTHROPIC_API_KEY`/`CLAUDE_MODEL` are reserved for a future
Claude-based extraction step and are not wired to any code path yet.

## Trigger

- **Cron:** weekly, Monday 10:00 AM US/Eastern (`0 14 * * 1` in
  `wrangler.toml`, fixed UTC — drifts an hour across the DST boundary).
- **Manual POST `/`:** requires header `X-Trigger-Secret` matching
  `MANUAL_TRIGGER_SECRET`. Synchronous by default (good for a small
  `MAX_CATEGORIES_PER_RUN` validation run); add `?async=true` to run via
  `waitUntil` and get an immediate `202`. **`?async=true` cannot run a
  full slice:** Cloudflare stops `waitUntil` work 30 seconds after the
  response is sent, and a 50-category run takes minutes. For a full
  off-schedule run, fire the scheduled handler instead (locally:
  `wrangler dev --test-scheduled`, then GET `/__scheduled`; deployed:
  temporarily point `crons` at a few minutes from now and redeploy),
  which gets the 15-minute scheduled-run limit.

## Modules

- `fetch.ts` — the only module that calls `fetch()` against pcna.com.
  Cookie jar, inter-request delay, User-Agent.
- `parse.ts` — sitemap XML -> URLs (with host-doubling normalization),
  department-category filtering (`CATEGORY_PATH_PREFIXES`), category
  HTML -> categoryId/categoryName, product fragment HTML -> `Product[]`.
- `auth.ts` — constant-time manual-trigger secret check.
- `diff.ts` — SHA-256 hashing, NEW/CHANGED/UNCHANGED classification,
  category-scoped discontinuation marking.
- `csv.ts` — delta CSV generation.
- `db.ts` — all D1 queries.
- `notify.ts` — run summary / failure notification to a Google Chat
  incoming webhook (`GOOGLE_CHAT_WEBHOOK_URL`). Unset = no notifications;
  the summary is always in the `pcna_crawl_run_complete` log line.
- `crawl.ts` — orchestrates one full run; shared by `scheduled` and the
  manual `fetch` handler.

## Guardrails

- `FETCH_DELAY_MS` (default 500ms) between every outbound request to PCNA.
- **The sitemap is not a category list.** Of ~2,600 URLs (2026-10-16),
  ~2,000 are product pages, ~170 blog posts, ~230 CMS/brand/marketing
  pages and ~28 bare relative paths. Only URLs under a department in
  `CATEGORY_PATH_PREFIXES` are crawled — 118 category pages (8 roots,
  parents and leaves). Collection pages (deals, clearance,
  gifts-by-occasion/...) are excluded so they don't become a product's
  category. A run that matches zero categories fails loudly rather than
  reporting success.
- Parent pages list their descendants' products, and the sitemap lists
  only some children (so parents can't be skipped). A product's category
  is the deepest category URL it's been seen under: a deeper observation
  always replaces the stored category; a shallower or equally deep one
  keeps it (so rotation doesn't flip products between parent/child or
  sibling categories) unless the stored category was re-crawled this run
  without the product, meaning it moved.
- `MAX_CATEGORIES_PER_RUN` caps category processing per run; categories
  are processed least-recently-crawled first, so coverage rotates. At
  118 categories and 50/run, one full rotation takes 3 weekly runs
  (re-verified against the live sitemap 2026-10-27: 118 = 94 leaves +
  24 parents/roots).
- **Platform limits this depends on (Cloudflare, Workers Paid):**
  scheduled runs get 15 minutes of wall time; subrequests (D1 and R2
  calls count) are capped at 10,000 per invocation. A 50-category run is
  roughly 150 requests to PCNA, an estimated 4–7 minutes. The Free plan
  (50 subrequests, 10 ms CPU) cannot run this worker. Re-check these if
  the worker moves to a different account or platform.
- **Sitemap blind spot:** a category PCNA doesn't list in its sitemap is
  never crawled. As of 2026-10-27 there's a `health-beauty-pcna` landing
  page but no `/en-us/health-beauty/...` category URLs, so if that
  department exists its products are not covered.
- Any single category or page failure is logged and the run continues.
- `seen_in_last_run = false` (the discontinuation signal) is only applied
  within categories this run actually crawled — never across the whole
  catalog, since `MAX_CATEGORIES_PER_RUN` means most categories aren't
  visited on any given run. Rows are never deleted.
- **Pagination exhaustion is an HTTP 500, not an empty page.** Confirmed
  against the real site: PCNA's `LoadMoreProducts` doesn't return an
  empty 200 once a category's pages run out — it 500s on the first
  overrun page. `crawl.ts` treats a page-fetch failure as "exhausted"
  only once at least one earlier page of that category already returned
  real products; a failure on page 1 is still treated as a real
  category-level failure.

## Local setup

```sh
cd workers/pcna-catalog-sync
cp .dev.vars.example .dev.vars
# fill in MANUAL_TRIGGER_SECRET; set GOOGLE_CHAT_WEBHOOK_URL only if you
# want local runs to post to Google Chat (leave it out to keep them quiet)
wrangler d1 execute pcna-catalog-sync-db --local --file ./schema.sql
pnpm run dev
```

## Testing

> **Known local-dev breakage (2026-10-27):** wrangler 4.118.0 pins
> `miniflare@5.20260730.0-alpha`, whose on-disk persistence
> (`resourcePersistencePath`) fails on this machine — every local D1 call
> from `wrangler d1 execute --local` and `wrangler dev` returns
> `internal error; reference = ...`, even `SELECT 1` on a fresh state dir.
> The 2026-10-27 batch test ran the `wrangler deploy --dry-run` bundle in
> miniflare directly (in-memory storage, one process). Try a newer wrangler
> before relying on the local steps below.

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

Async path (small runs only — see the 30-second `waitUntil` note under Trigger):

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
wrangler secret put GOOGLE_CHAT_WEBHOOK_URL
wrangler secret put MANUAL_TRIGGER_SECRET
wrangler deploy
```

## Manual setup checklist

- [ ] `wrangler d1 create pcna-catalog-sync-db`, paste the `database_id`
      into `wrangler.toml`
- [ ] `wrangler d1 execute pcna-catalog-sync-db --remote --file ./schema.sql`
- [ ] `wrangler r2 bucket create pcna-catalog-sync-csv`
- [ ] Create an incoming webhook in the Google Chat space that should get
      run summaries, then `wrangler secret put GOOGLE_CHAT_WEBHOOK_URL`
- [ ] `wrangler secret put MANUAL_TRIGGER_SECRET` (generate a long random value)
- [ ] `wrangler deploy`
