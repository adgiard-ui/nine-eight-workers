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