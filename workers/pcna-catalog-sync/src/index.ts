import type { Env } from "./types";

export type { Env };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Only POST requests are supported." }, 405);
    }

    const providedSecret = request.headers.get("X-Trigger-Secret");
    if (!env.MANUAL_TRIGGER_SECRET || providedSecret !== env.MANUAL_TRIGGER_SECRET) {
      return jsonResponse({ error: "Missing or invalid X-Trigger-Secret header." }, 403);
    }

    return jsonResponse({ status: "scaffold ok — crawl not yet implemented" });
  },
};
