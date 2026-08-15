import { runAgentLoop } from "@nine-eight/core/agent-loop";
import { getModelClient } from "@nine-eight/core/model-router";
import { logger } from "@nine-eight/core/logger";
import { createTools, postToSlackMessage } from "./tools";
import type { Env, InvocationState } from "./types";

export type { Env };

// Same default every other worker in this repo uses. env.CLAUDE_MODEL, if
// set, overrides it — see .dev.vars.example.
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

// Wide-open CORS so this can be hit directly during testing. Tighten to
// specific origins before this worker handles real HubSpot webhook traffic
// (though HubSpot's webhook caller itself isn't a browser, so CORS mostly
// matters for local/manual testing here).
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

/**
 * The four hs_lead_status values Claude is instructed to use, mapped onto
 * this HubSpot portal's actual stock enum options (confirmed with the
 * client — "OPEN_QUALIFIED" is not a default HubSpot value, so Qualified
 * maps to the stock "OPEN" status instead).
 */
const VALID_LEAD_STATUSES = new Set(["OPEN", "IN_PROGRESS", "UNQUALIFIED", "NEW"]);

const SYSTEM_PROMPT = `You are a lead qualification agent for a B2B professional services company. When a new lead comes in from HubSpot, your job is to:

1. Fetch the full contact record from HubSpot using the get_hubspot_contact tool.
2. Evaluate the lead against the following Ideal Customer Profile:

Company size: 20-500 employees
Location: United States
Industry: Professional services, technology, SaaS, or e-commerce
Job title includes decision-making authority: Owner, Founder, C-level, VP, Director, Head of
Contact source or form indicates buying intent (demo request, contact form, pricing inquiry) — not passive interest (newsletter, whitepaper download, event registration)

3. Classify the lead into one of four categories:

Qualified — meets all or most ICP criteria with clear buying intent
Nurture — partial fit, worth marketing follow-up but not sales-ready
Disqualified — clear ICP mismatch (wrong size, wrong industry, no decision-maker)
Needs Review — critical data is missing (no company, no title, no email) and you cannot confidently classify

4. Write your classification and a 2-3 sentence rationale back to the contact record using the update_hubspot_contact tool. Update these properties:

hs_lead_status: set to OPEN (for Qualified), IN_PROGRESS (for Nurture), UNQUALIFIED (for Disqualified), or NEW (for Needs Review)
Add a note in a custom property called nineeight_ai_notes (a text field) with your rationale

5. Based on classification:

If Qualified: post to the Slack channel #qualified-leads with a brief containing the lead's name, company, title, source, and your rationale, plus a link to the HubSpot record (use the HubSpot Portal ID you were given to build https://app.hubspot.com/contacts/{portalId}/contact/{contact_id})
If Needs Review: post to #leads-needs-review with the lead ID and a note about what critical info is missing
If Nurture or Disqualified: no Slack notification. The HubSpot update is sufficient.

Be concise in your Slack messages — sales reps read fast. Be honest in your classifications — if you're not sure, use Needs Review rather than guessing.`;

/**
 * Shape of a single event in a HubSpot webhook payload. HubSpot always
 * sends an array (a batch can contain multiple events); we only act on the
 * first one, per this worker's contract with the HubSpot subscription
 * (configured as a single "contact creation" event type).
 */
interface HubspotWebhookEvent {
  objectId?: number | string;
  portalId?: number | string;
  subscriptionType?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // HubSpot's webhook caller isn't a browser, but a preflight-friendly
    // OPTIONS handler keeps manual/browser-based testing frictionless.
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Only POST requests are supported." }, 405);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Request body must be valid JSON." }, 400);
    }

    // HubSpot's webhook payload is a JSON array of events, not a single
    // object — see the README for a sample payload.
    if (!Array.isArray(body) || body.length === 0) {
      return jsonResponse(
        { error: "Request body must be a non-empty JSON array of HubSpot webhook events." },
        400
      );
    }

    const firstEvent = body[0] as HubspotWebhookEvent | null;
    const objectId = firstEvent?.objectId;

    if (
      firstEvent === null ||
      typeof firstEvent !== "object" ||
      (typeof objectId !== "number" && typeof objectId !== "string") ||
      String(objectId).trim().length === 0
    ) {
      return jsonResponse(
        { error: 'The first event in the payload is missing a valid "objectId".' },
        400
      );
    }

    const contactId = String(objectId);
    const portalId =
      typeof firstEvent.portalId === "number" || typeof firstEvent.portalId === "string"
        ? String(firstEvent.portalId)
        : "unknown";

    // Fresh per-invocation state, threaded into every tool call this
    // request makes — this is what lets the guardrails (no duplicate Slack
    // post, no Slack post after a failed fetch, unrecognized classification
    // -> Needs Review) hold regardless of how Claude's reasoning plays out.
    // See types.ts for what each field enforces.
    const state: InvocationState = { hubspotFetchFailed: false, slackPosted: false };

    const client = getModelClient("anthropic", env.ANTHROPIC_API_KEY);
    const model = env.CLAUDE_MODEL || DEFAULT_MODEL;

    const userMessage = `A new HubSpot contact needs lead qualification.

Contact ID: ${contactId}
HubSpot Portal ID: ${portalId}

Fetch the contact, evaluate it against the ICP, classify it, write the classification back to HubSpot, and notify Slack if your instructions call for it.`;

    let result;
    try {
      result = await runAgentLoop({
        client,
        model,
        systemPrompt: SYSTEM_PROMPT,
        userMessage,
        tools: createTools(env, state),
        maxIterations: 10,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("lead_qualifier_request_failed", { contactId, error: errorMessage });
      return jsonResponse({ error: "Internal error while running the agent." }, 500);
    }

    // Guardrail: if the HubSpot fetch failed, this is a hard failure
    // regardless of what Claude's final text says — return 500, don't post
    // to Slack (post_to_slack already refuses to post once this flag is
    // set; this is the response-level half of the same guardrail).
    if (state.hubspotFetchFailed) {
      logger.error("lead_qualifier_hubspot_fetch_failed", {
        contactId,
        error: state.hubspotFetchError,
      });
      return jsonResponse(
        {
          error: `Could not fetch HubSpot contact ${contactId}: ${state.hubspotFetchError ?? "unknown error"}`,
        },
        500
      );
    }

    // Guardrail: if Claude's classification isn't one of the four defined
    // categories — or it never wrote one at all (e.g. it ran out of
    // iterations, or skipped the update step) — treat it as Needs Review
    // and make sure the review channel gets notified, even though Claude
    // itself didn't do it. This only fires if nothing was already posted to
    // Slack this invocation.
    const status = state.lastHsLeadStatus;
    if ((!status || !VALID_LEAD_STATUSES.has(status)) && !state.slackPosted) {
      logger.warn("lead_qualifier_unrecognized_classification", { contactId, status: status ?? null });
      await postToSlackMessage(
        env,
        state,
        "#leads-needs-review",
        `Lead ${contactId} (portal ${portalId}) needs manual review — the agent did not produce a recognized classification. https://app.hubspot.com/contacts/${portalId}/contact/${contactId}`
      );
    }

    return jsonResponse({
      response: result.finalResponse,
      toolCalls: result.toolCalls,
      iterations: result.iterations,
      leadStatus: state.lastHsLeadStatus ?? null,
    });
  },
};
