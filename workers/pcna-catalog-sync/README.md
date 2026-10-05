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
