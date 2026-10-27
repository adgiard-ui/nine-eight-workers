# Worker: hello-agent

## Client
Internal / practice — first foundational worker

## Process it runs
Proof-of-concept agent loop. Answers freeform questions using a single time tool. Built to validate the core agent pattern end-to-end.

## Trigger
POST request with { message: string }

## Tools it uses
- get_current_time (local, no external API)

## Integrations
None

## Deployment URL
https://hello-agent.nine-eight.workers.dev

## Retainer notes
N/A — foundational practice worker

## Change log
2026-08-04: Built and deployed. First worker on nine.eight infrastructure. Verified agent loop, tool use, local dev, and production deploy pipeline.

# Worker: research-assistant

## Client
Internal / practice

## Process it runs
Answers factual questions using external data sources — time, weather, currency conversion. Second worker; validates multi-tool orchestration and external API integration.

## Trigger
POST request with { message: string }

## Tools it uses
- get_current_time (from shared library)
- get_weather (via Open-Meteo, no API key)
- convert_currency (via Frankfurter, no API key)

## Integrations
- Open-Meteo (weather + geocoding)
- Frankfurter (ECB exchange rates)

## Deployment URL
https://research-assistant.nine-eight.workers.dev

## Retainer notes
N/A — practice worker

## Change log
2026-08-05: Built and deployed. Verified time, weather, currency, and multi-tool orchestration (4-5 iterations on multi-question prompts).

# Worker: lead-qualifier

## Client
nine.eight's first client-shaped worker — built to the client's actual process, not a practice/foundational build.

## Process it runs
Automates inbound lead qualification for a B2B professional services company using HubSpot as CRM. On a new HubSpot contact, fetches the full contact record, classifies it against the client's Ideal Customer Profile (Qualified / Nurture / Disqualified / Needs Review), writes the classification and rationale back to HubSpot, and notifies the sales team in Slack for Qualified and Needs Review leads. Replaces the SDR/sales-ops role of manually triaging inbound leads — the first concrete proof of the "purpose-built AI worker embedded in a business process" thesis.

## Trigger
HTTP POST from HubSpot's "contact creation" webhook subscription — a JSON array of events; the worker reads `objectId` from the first event.

## Tools it uses
- get_hubspot_contact (direct HubSpot CRM API auth via HUBSPOT_ACCESS_TOKEN)
- update_hubspot_contact (same auth; writes hs_lead_status + nineeight_ai_notes)
- post_to_slack (via Nango proxy to Slack's chat.postMessage — first Nango integration in this repo)

## Integrations
- HubSpot CRM API (direct)
- Slack, via Nango (Provider-Config-Key: slack)

## Deployment URL
Not yet deployed — scaffolded and verified against a local `wrangler dev` smoke test on 2026-08-15. Production deploy pending (client secrets + HubSpot webhook wiring happen in a separate session).

## Retainer notes
First worker with real code-level guardrails beyond the happy path: no auto-retry on HubSpot writes, at most one Slack post per invocation, no Slack post if the HubSpot fetch failed, and an unrecognized classification forces a Needs Review fallback notification rather than trusting Claude to self-correct.

## Change log
2026-08-15: Scaffolded, reusing packages/core unchanged. Guardrails implemented and smoke-tested locally (400/405 validation paths, and a live request through the agent loop that failed gracefully on an invalid API key, confirming structured error logging and the fetch-failure guardrail path). HubSpot's `hs_lead_status` values remapped from the originally spec'd `OPEN_QUALIFIED` to the portal's actual stock value `OPEN` after confirming with the client. Custom property internal name corrected from `nine_eight_ai_notes` to `nineeight_ai_notes` — see ARCHITECTURE.md decisions log.

# Worker: pcna-catalog-sync

## Client
Internal pipeline tooling — phase one of a pipeline that will eventually feed NetSuite.

## Process it runs
Crawls PCNA's public product catalog on a schedule (27 sitemaps -> ~2,600 URLs, filtered by `CATEGORY_PATH_PREFIXES` down to 118 department category pages -> paginated product listings), deduplicates by SKU, diffs against a D1 snapshot, writes NEW/CHANGED rows to a CSV in R2, and posts a Google Chat summary. Deterministic data processing — no agent loop; ANTHROPIC_API_KEY/CLAUDE_MODEL are reserved for a future Claude-based extraction step and unused by any current code path.

## Trigger
Weekly Cloudflare Cron Trigger (Monday 10am Eastern), plus a POST endpoint for manual runs (synchronous by default; `?async=true` returns 202 immediately but is cut off 30s after responding, so it's for small runs only — see the worker README), gated by a shared `X-Trigger-Secret` header.

## Tools it uses
- fetch.ts (direct, unauthenticated requests to pcna.com — cookie jar, configurable delay, browser User-Agent)
- notify.ts (run summary / failure message to a Google Chat incoming webhook)

## Integrations
- PCNA public catalog (direct HTTP, no auth yet — isolated in fetch.ts so dealer-auth or a PromoStandards API swap only touches that file)
- Google Chat, via an incoming webhook (`GOOGLE_CHAT_WEBHOOK_URL` secret; unset = no notifications)

## Deployment URL
Not yet deployed to production. Validated end-to-end against the real live PCNA site via local `wrangler dev` (815 real products seen in a 2-category smoke run; correctly classified as NEW on first run, UNCHANGED on a repeat run). Production deploy pending manual D1/R2/secret setup (see the worker's README checklist).

## Retainer notes
First worker in this repo using D1, R2, and Cron Triggers. First worker with an automated unit test suite (Vitest, scoped to this worker's pure logic only — parsing, hashing/classification, CSV, fetch module cookie-jar/delay behavior). Discontinuation detection (`seen_in_last_run`) is deliberately scoped to categories actually crawled in a given run, not the whole catalog — `MAX_CATEGORIES_PER_RUN` caps per-run coverage and rotates least-recently-crawled-first, so most categories aren't visited on any single run. Two real-world gotchas found and fixed during live validation: (1) PCNA's product-listing fragment carries a per-row price-wrapper element with a hardcoded placeholder `data-sku`, with no other product attributes — the parser now requires `data-productname` alongside `data-sku` to exclude it; (2) PCNA signals "no more pages" with an HTTP 500 on the first overrun page, not an empty 200 — see ARCHITECTURE.md's decisions log. A third, found after the first build: PCNA's sitemap is mostly not categories (see the 2026-10-16 decisions log entry). Requires Workers Paid (the Free plan's 50-subrequest and 10 ms CPU caps can't run it); hosting may move to a different Cloudflare account or AWS, so re-check limits on any move.

## Change log
2026-10-05: Scaffolded per the design doc (`docs/superpowers/specs/2026-10-05-pcna-catalog-sync-design.md`) and implementation plan (`docs/superpowers/plans/2026-10-05-pcna-catalog-sync.md`); validated end-to-end against the real PCNA site, including two real-world fixes to the parser and pagination-termination logic.
2026-10-16: Sitemap filtered to department category pages via `CATEGORY_PATH_PREFIXES` (118 of ~2,600 URLs); parent-page observations no longer overwrite a product's more specific leaf category; UTF-8 BOM on the CSV; `sitemapUrls`/`categoriesDiscovered` added to the run summary and notification message; constant-time manual-trigger secret check (`auth.ts`). 62 unit tests.
2026-10-27: Re-verified the 118 category count against the live sitemap (94 leaves + 24 parents/roots); `MAX_CATEGORIES_PER_RUN` stays at 50 (full rotation every 3 weekly runs).
2026-10-27: Notifications moved from Slack (via Nango) to a Google Chat incoming webhook; Nango secrets and `SLACK_CHANNEL` removed. Unset webhook = no notifications (used for local test runs).
2026-10-27: Local batch test against the live site (3 runs x 5 categories, then 1 x 2): sitemap filter, crawl, D1 writes, BOM'd delta CSV, rotation and CHANGED detection all verified. Found and fixed a decoy-element bug: category pages carry per-department promo banners (`data-category="category-271"`, ...) and `data-categoryId="0"` placeholders before the real `#layout-category` element, so every product was stored with category "category-271"; `resolveCategoryMeta` now reads both values from that element.
2026-10-27: Code review fixes: product category is now the deepest category URL seen (the leaf/non-leaf rule could leave products stuck under a root category); the categoryId regex fallback can no longer return the "0" placeholder; notify.ts can't throw on an unreadable error body; a run with zero sitemap URLs reports PCNA being unreachable instead of blaming CATEGORY_PATH_PREFIXES. 82 unit tests; 10-category live run verified products move from "Apparel" into Accessories/Headwear/Hoodies & Fleece.
