# nine.eight architecture

## Positioning

We sell purpose-built AI workers embedded in a client's business processes. Not middleware, not chatbots, not integrations — workers that run a specific job (order processing, ticket triage, lead qualification, status sync, etc.) end-to-end.

Workers live on nine.eight infrastructure (Cloudflare Workers + Anthropic Claude), wired into the client's existing stack. Clients rent the role, don't own the code. No retainer, no worker access.

The client buys the outcome. The AI is invisible.

Anthropic's native features make our workers better, not obsolete, because we sell operational depth, not connectivity.

## Target buyer

- 20–500 employee companies
- $5M–$100M revenue
- Non-technical or lightly-technical operations
- Off-the-shelf SaaS stacks (no in-house engineering)
- COO / VP Ops / Managing Partner as buyer, not CTO
- Vertical focus: TBD — pick before first client engagement

## Product shape

Three tiers:
1. **Agent training / build** (one-time)
2. **Implementation** (priced by stack complexity, one-time)
3. **Maintenance retainer** (monthly, recurring — the real business)

Two worker categories:
- **Standard workers** — from the library, faster deploy, lower cost (~$2–5K impl + $800–1,500/mo)
- **Custom workers** — bespoke process, higher cost (~$10–50K+ impl + $2–5K+/mo)

Bundle discounts at 3+ workers on retainer.

Standard library grows over time — every custom build that generalizes becomes tomorrow's standard.

Note: agents run on nine.eight infrastructure only. Implementation builds the worker; retainer keeps it running. No retainer, no worker. Client never receives source code, prompts, or infra access unless on enterprise tier with paid portability option.

## Pitch angles

Three legitimate angles pointing to the same product:

1. **Replace the offshore role** — for ops leaders with BPO/VA fatigue
2. **Replace the Zapier mess** — for technical operators hitting automation ceilings
3. **Skip the enterprise upgrade** — for buyers about to overpay for LLM enterprise plans to unlock connectors

Different pains, same product, different doors.

## Stack

- **Runtime:** Cloudflare Workers (TypeScript)
- **Storage:** D1 (SQL), KV (session), R2 (files) — added when needed
- **Vector DB:** TBD — Turbopuffer or Vectorize
- **Observability:** Langfuse (planned)
- **Integrations:** Direct SDKs for top systems in chosen vertical, Nango for long-tail
- **Primary model:** Claude Sonnet (Anthropic)
- **Secondary:** Gemini (long context), OpenAI (voice)
- **Repo structure:** pnpm monorepo — `packages/core` (shared agent loop + model router), `packages/integrations` (reusable API clients), `workers/*` (individual worker deployments)

## Client-facing surfaces

Slack apps, embedded widgets, email agents, in-app bots. No custom dashboards early on. Meet clients in their existing tools.

## What we don't build

- Generic "AI platform" features
- Self-serve tooling for clients to configure their own agents
- Custom UIs unless the workflow demands it
- Anything that competes with Anthropic native features (chat interfaces, general Q&A, doc summarization on demand)
- Make/Zapier-shaped workflow tools — we replace those, not clone them

## Partnership

Adjacent skills business (brother's company) sells pre-trained Claude skills as zip files with intake survey. Lower-cost entry point.

nine.eight is the handoff and custom-build partner for their clients who need full deployment. Separate entities. Referral economics to be structured after nine.eight has proven traction.

## Decisions log

- **2026-08-04:** Chose Cloudflare Workers over AWS Lambda, Vercel, Make, and Zapier. Reasoning: edge deployment, cost at scale, defensibility of code we own, zero cold starts, integrated storage primitives.
- **2026-08-04:** Chose TypeScript over Python. Reasoning: HTTP-heavy integrations favor TS, better SDKs for target SaaS tools, edge deployment fit.
- **2026-08-04:** Chose Anthropic Claude Sonnet as primary model. Reasoning: best-in-class tool use, strong sustained reasoning, prompt caching for cost control, cleanest API.
- **2026-08-04:** Deployed hello-agent as first production worker. Validated end-to-end: scaffold → local dev → deploy → live URL responding.
- **2026-08-05:** Adopted `CLAUDE_MODEL` env var pattern for model selection per worker. Retrofitted hello-agent to match research-assistant's config.
- **2026-08-05:** Confirmed compounding library model works. research-assistant reused `packages/core` with zero changes, only new tool code added. Pattern validated: new workers = new tools + new system prompt, existing infrastructure untouched. This is the empirical proof of nine.eight's core thesis.