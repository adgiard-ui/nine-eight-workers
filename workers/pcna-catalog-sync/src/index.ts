import { logger } from "@nine-eight/core/logger";
import { secretsMatch } from "./auth";
import { runCrawl } from "./crawl";
import { postRunFailure, postRunSummary } from "./notify";
import type { Env, RunSummary } from "./types";

export type { Env };

async function runAndNotify(env: Env): Promise<RunSummary> {
  try {
    const summary = await runCrawl(env);
    await postRunSummary(env, summary);
    return summary;
  } catch (error) {
    await postRunFailure(env, error);
    throw error;
  }
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

    if (!(await secretsMatch(request.headers.get("X-Trigger-Secret"), env.MANUAL_TRIGGER_SECRET))) {
      return jsonResponse({ error: "Missing or invalid X-Trigger-Secret header." }, 403);
    }

    // Default: synchronous, for small MAX_CATEGORIES_PER_RUN validation
    // runs. ?async=true: fire-and-forget via waitUntil, which Cloudflare
    // cuts off 30s after the response is sent — so this is only for runs
    // that finish within ~30s, NOT a full rotation slice. For a full
    // off-schedule run, fire the scheduled handler instead (README).
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
