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