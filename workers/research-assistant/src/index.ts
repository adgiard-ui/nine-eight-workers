import { runAgentLoop } from "@nine-eight/core/agent-loop";
import { getModelClient } from "@nine-eight/core/model-router";
import { logger } from "@nine-eight/core/logger";
import { tools } from "./tools";

/**
 * Bindings available to this Worker — declared in wrangler.toml (vars) or
 * set as a secret (`wrangler secret put` / `.dev.vars`). Cloudflare injects
 * these into the `env` parameter of the fetch handler below; there's no
 * `process.env` in the Workers runtime.
 */
export interface Env {
  ANTHROPIC_API_KEY: string;
}

// Wide-open CORS so this can be hit directly from a browser during testing.
// Tighten this to specific origins before this worker handles real traffic.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

const SYSTEM_PROMPT = `You are a research assistant. Your job is to answer factual questions accurately.

- Use a tool whenever a question depends on current or looked-up information (e.g. the current time, current weather, current exchange rates) — don't guess at values that change over time.
- Answer directly, without calling a tool, when the question is general knowledge you already know.
- Be concise. Give the answer, not a lengthy explanation, unless the user asks for more detail.
- If a tool returns an error or fails, say so plainly and acknowledge the uncertainty rather than guessing at an answer.`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Browsers send a CORS preflight OPTIONS request before the real POST.
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Only POST requests are supported." }, 405);
    }

    // Parse the body defensively — a malformed request shouldn't throw an
    // unhandled exception, it should return a clean 400.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Request body must be valid JSON." }, 400);
    }

    const message = (body as Record<string, unknown> | null)?.message;

    if (typeof message !== "string" || message.trim().length === 0) {
      return jsonResponse(
        { error: 'Request body must be { "message": string } with a non-empty message.' },
        400
      );
    }

    // Build a Claude client for this request using the Worker's secret.
    const client = getModelClient("anthropic", env.ANTHROPIC_API_KEY);

    try {
      const result = await runAgentLoop({
        client,
        model: "claude-sonnet-4-5-20250929",
        systemPrompt: SYSTEM_PROMPT,
        userMessage: message,
        tools,
        maxIterations: 10,
      });

      return jsonResponse({
        response: result.finalResponse,
        toolCalls: result.toolCalls,
        iterations: result.iterations,
      });
    } catch (error) {
      // Anything that reaches here is unexpected (network failure, bad API
      // key, etc.) rather than a normal part of the agent loop — those are
      // already handled inside runAgentLoop. Log it and return a generic
      // 500 rather than leaking internal error details to the caller.
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("research_assistant_request_failed", { error: errorMessage });
      return jsonResponse({ error: "Internal error while running the agent." }, 500);
    }
  },
};
