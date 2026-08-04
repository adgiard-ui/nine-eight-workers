# nine-eight-workers

Shared infrastructure and individual Cloudflare Workers for nine.eight's custom AI workers. Each worker runs one specific business process for one client, deployed independently, built on a shared tool-use loop that talks to Claude (Anthropic) via `@anthropic-ai/sdk`.

## Repo structure

```
packages/
  core/            reusable agent loop, model client, shared types, logging
  integrations/     shared third-party integrations (empty placeholder for now)
workers/
  hello-agent/      example worker: one tool, one system prompt, JSON in/out
docs/
  ARCHITECTURE.md    positioning, stack, and decisions — fill in as the business firms up
  WORKERS.md         copy this template into a new file per worker you ship
```

- `packages/core/src/agent-loop.ts` — the reusable tool-use loop (`runAgentLoop`). Every worker calls this instead of hand-rolling its own Claude request/tool-result cycle.
- `packages/core/src/model-router.ts` — `getModelClient()`, a thin wrapper around the Anthropic SDK client. Structured so a second provider (Gemini, OpenAI) can be added later without touching call sites.
- `packages/core/src/types.ts` — shared `Tool`, `AgentConfig`, `AgentLoopResult` types.
- `packages/core/src/logger.ts` — one-line JSON structured logging.

Workers import from core via subpath, e.g. `import { runAgentLoop } from "@nine-eight/core/agent-loop"` — there's no build step for `packages/*`; Wrangler's bundler compiles the TypeScript source directly when a worker is built or deployed.

## Develop

```sh
pnpm install               # install everything, once, from the repo root
pnpm typecheck             # tsc --noEmit across every package/worker
pnpm --filter hello-agent dev   # or: pnpm dev (aliases to the same thing)
```

`pnpm dev` / `pnpm deploy` at the root currently point at `hello-agent` specifically — update the root `package.json` scripts (or just run `pnpm --filter <worker> dev`) once there's more than one worker.

To add a new worker, copy `workers/hello-agent` as a starting point: its own `package.json`, `tsconfig.json` (extending the root `tsconfig.base.json`), and `wrangler.toml`. Copy `docs/WORKERS.md` to a new file (e.g. `docs/workers/<name>.md`) and fill it in.

## Deploy

```sh
cd workers/hello-agent
wrangler deploy
```

Each worker deploys independently via its own `wrangler.toml`.

## What's ready

- [x] Monorepo scaffolding: pnpm workspaces, shared `tsconfig.base.json`, root scripts
- [x] `packages/core` — agent loop, model router, types, logger
- [x] `packages/integrations` — placeholder, empty until a client needs one
- [x] `workers/hello-agent` — full example: fetch handler, input validation, CORS, one tool (`get_current_time`)
- [x] `docs/ARCHITECTURE.md` and `docs/WORKERS.md` — placeholders/templates
- [x] `pnpm install` run and `pnpm typecheck` passing

## What you need to do manually

1. **Install Wrangler globally** (optional — it's also available via `pnpm exec wrangler` / the workspace scripts, but a global install is handy for ad-hoc commands):
   ```sh
   npm install -g wrangler
   ```
2. **Authenticate Wrangler with Cloudflare:**
   ```sh
   wrangler login
   ```
3. **Create your local secret file** at `workers/hello-agent/.dev.vars`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
   (This file is gitignored — it will never be committed.)
4. **Test locally:**
   ```sh
   cd workers/hello-agent
   wrangler dev
   ```
   In another terminal:
   ```sh
   curl -X POST http://localhost:8787 \
     -H "Content-Type: application/json" \
     -d '{"message": "What time is it right now?"}'
   ```
5. **Set the production secret** (one time, per environment):
   ```sh
   wrangler secret put ANTHROPIC_API_KEY
   ```
6. **Deploy:**
   ```sh
   cd workers/hello-agent
   wrangler deploy
   ```
7. **Test the deployed URL:**
   ```sh
   curl -X POST https://hello-agent.<your-subdomain>.workers.dev \
     -H "Content-Type: application/json" \
     -d '{"message": "What time is it right now?"}'
   ```
