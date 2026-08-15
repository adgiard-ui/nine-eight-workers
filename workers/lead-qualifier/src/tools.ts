import type { Tool } from "@nine-eight/core/types";
import { logger } from "@nine-eight/core/logger";
import type { Env, InvocationState } from "./types";

/**
 * HubSpot properties requested on every contact fetch. `company`, `jobtitle`,
 * `phone`, `lifecyclestage`, and `hs_lead_status` are not part of HubSpot's
 * default response set — the CRM API only returns a small default property
 * list unless you explicitly ask for more via `?properties=`. The three
 * `hs_*` source fields are HubSpot's built-in "how did this contact
 * originate" properties, used to evaluate the ICP's buying-intent criterion
 * (demo request / pricing inquiry vs. newsletter / whitepaper signup).
 */
const HUBSPOT_CONTACT_PROPERTIES = [
  "email",
  "firstname",
  "lastname",
  "company",
  "jobtitle",
  "phone",
  "lifecyclestage",
  "hs_lead_status",
  "hs_analytics_source",
  "hs_latest_source",
  "hs_object_source",
].join(",");

interface HubspotContactResponse {
  id: string;
  properties: Record<string, string | null>;
}

/**
 * Posts a message to Slack via Nango's proxy. Shared by the post_to_slack
 * tool *and* by index.ts's own "unrecognized classification" fallback, so
 * there's exactly one place that talks to Nango/Slack and enforces the
 * once-per-invocation + no-post-after-fetch-failure guardrails.
 *
 * Nango sits between us and Slack so this Worker never handles Slack OAuth
 * or token refresh directly. We POST to Nango's generic proxy path, named
 * after the underlying Slack API method we want to call
 * (`chat.postMessage`); Nango looks up the stored Slack token for the
 * connection identified by `Connection-Id` and forwards the request with
 * that token attached. `Provider-Config-Key` tells Nango which integration
 * definition (Slack, in this case) governs the connection.
 */
export async function postToSlackMessage(
  env: Env,
  state: InvocationState,
  channel: string,
  message: string
): Promise<string> {
  // Guardrail: never notify Slack about a lead we couldn't actually fetch.
  // Enforced here (not just via the system prompt) so it holds even if
  // Claude's reasoning tries to proceed anyway.
  if (state.hubspotFetchFailed) {
    return "Error: not posting to Slack — the HubSpot contact fetch failed earlier in this run.";
  }

  // Guardrail: at most one Slack message per invocation. The agent loop can
  // call tools across several iterations; without this check, a confused
  // or looping Claude could double-notify the sales team for the same lead.
  if (state.slackPosted) {
    return "Error: a Slack message has already been sent for this lead in this run. Not sending another.";
  }

  let res: Response;
  try {
    res = await fetch("https://api.nango.dev/proxy/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NANGO_SECRET_KEY}`,
        "Provider-Config-Key": "slack",
        "Connection-Id": env.NANGO_CONNECTION_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, text: message }),
    });
  } catch (error) {
    // Network-level failure talking to Nango itself — let it throw so
    // agent-loop.ts records it as a real tool error.
    logger.error("slack_post_network_error", { channel, error: String(error) });
    throw error;
  }

  if (!res.ok) {
    const body = await res.text();
    logger.error("slack_post_failed", { channel, status: res.status, body });
    return `Error: Slack post failed (status ${res.status}). Details: ${body}`;
  }

  // Slack's chat.postMessage quirk: it returns HTTP 200 even for in-band API
  // errors, e.g. { "ok": false, "error": "channel_not_found" }. Nango proxies
  // Slack's raw response body through unchanged, so we still have to check
  // the `ok` field ourselves rather than trusting res.ok.
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (data.ok === false) {
    logger.error("slack_post_rejected", { channel, error: data.error });
    return `Error: Slack rejected the message (${data.error ?? "unknown error"}).`;
  }

  state.slackPosted = true;
  return `Posted message to Slack channel ${channel}.`;
}

/**
 * Builds this worker's tools, closing over the request's `env` (for
 * credentials) and a fresh `InvocationState` (for the cross-tool
 * guardrails — see types.ts). Unlike hello-agent/research-assistant, whose
 * tools call unauthenticated public APIs and can be static module-level
 * exports, every tool here needs per-request secrets and shared state, so
 * this worker builds its tool list once per HTTP request instead.
 */
export function createTools(env: Env, state: InvocationState): Tool[] {
  const getHubspotContactTool: Tool = {
    name: "get_hubspot_contact",
    description:
      "Fetches a HubSpot contact record by ID, including the properties needed to evaluate the lead against the ICP (name, company, title, phone, lifecycle stage, lead status, and source/analytics fields). Call this first, before anything else, using the contact ID you were given.",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: {
          type: "string",
          description: "The HubSpot contact's numeric ID, as a string.",
        },
      },
      required: ["contact_id"],
    },
    execute: async (input) => {
      const contactId = input.contact_id;
      if (typeof contactId !== "string" || contactId.trim().length === 0) {
        return 'Error: "contact_id" must be a non-empty string.';
      }

      const url = `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(
        contactId
      )}?properties=${HUBSPOT_CONTACT_PROPERTIES}`;

      let res: Response;
      try {
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}` },
        });
      } catch (error) {
        // Network-level failure. Set the guardrail flag before rethrowing —
        // agent-loop.ts will catch this and report it to Claude as a tool
        // error, but index.ts still needs to know the fetch failed so it
        // can return a 500 instead of a normal response.
        state.hubspotFetchFailed = true;
        state.hubspotFetchError = error instanceof Error ? error.message : String(error);
        throw error;
      }

      if (res.status === 404) {
        state.hubspotFetchFailed = true;
        state.hubspotFetchError = `Contact ${contactId} not found in HubSpot.`;
        return `Error: no HubSpot contact found with ID "${contactId}" (404 Not Found).`;
      }

      if (res.status === 401) {
        state.hubspotFetchFailed = true;
        state.hubspotFetchError = "HubSpot rejected the access token (401).";
        return "Error: HubSpot rejected the access token (401 Unauthorized). Check HUBSPOT_ACCESS_TOKEN.";
      }

      if (!res.ok) {
        const body = await res.text();
        state.hubspotFetchFailed = true;
        state.hubspotFetchError = `HubSpot contact fetch failed with status ${res.status}.`;
        logger.error("hubspot_fetch_failed", { contactId, status: res.status, body });
        return `Error: HubSpot contact fetch failed (status ${res.status}).`;
      }

      const data = (await res.json()) as HubspotContactResponse;
      return JSON.stringify({ id: data.id, properties: data.properties });
    },
  };

  const updateHubspotContactTool: Tool = {
    name: "update_hubspot_contact",
    description:
      "Updates properties on a HubSpot contact record — use this to write the classification (hs_lead_status) and rationale (nineeight_ai_notes) back to the contact after evaluating it. Call this once, after you've reached a final classification.",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: {
          type: "string",
          description: "The HubSpot contact's numeric ID, as a string.",
        },
        properties: {
          type: "object",
          description:
            'Property name/value pairs to set, e.g. { "hs_lead_status": "OPEN", "nineeight_ai_notes": "..." }.',
        },
      },
      required: ["contact_id", "properties"],
    },
    execute: async (input) => {
      const contactId = input.contact_id;
      const properties = input.properties;

      if (typeof contactId !== "string" || contactId.trim().length === 0) {
        return 'Error: "contact_id" must be a non-empty string.';
      }
      if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
        return 'Error: "properties" must be an object of property name/value pairs.';
      }

      // Guardrail: exactly one write attempt, no automatic retry. Retrying a
      // failed PATCH here could produce a duplicate note or, worse, mask a
      // real failure that should surface to the caller — a single failed
      // attempt is reported back as an error tool-result and logged instead.
      let res: Response;
      try {
        res = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ properties }),
        });
      } catch (error) {
        logger.error("hubspot_update_network_error", { contactId, error: String(error) });
        throw error;
      }

      if (!res.ok) {
        const body = await res.text();
        logger.error("hubspot_update_failed", { contactId, status: res.status, body });
        return `Error: HubSpot update failed (status ${res.status}). Not retrying — a duplicate write risks a duplicate record or note. Details: ${body}`;
      }

      // Record whatever lead-status value Claude actually wrote so index.ts
      // can validate it against the four defined categories after the loop
      // finishes — this is what makes the "unrecognized classification"
      // guardrail hold even if Claude's own reasoning drifts.
      const writtenStatus = (properties as Record<string, unknown>).hs_lead_status;
      if (typeof writtenStatus === "string") {
        state.lastHsLeadStatus = writtenStatus;
      }

      return `Updated HubSpot contact ${contactId}.`;
    },
  };

  const postToSlackTool: Tool = {
    name: "post_to_slack",
    description:
      "Posts a message to a Slack channel. Use only for Qualified leads (#qualified-leads) or Needs Review leads (#leads-needs-review), per your instructions — never for Nurture or Disqualified leads, and never more than once per lead.",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: 'The Slack channel to post to, e.g. "#qualified-leads".',
        },
        message: {
          type: "string",
          description: "The message text to post.",
        },
      },
      required: ["channel", "message"],
    },
    execute: async (input) => {
      const channel = input.channel;
      const message = input.message;

      if (typeof channel !== "string" || channel.trim().length === 0) {
        return 'Error: "channel" must be a non-empty string.';
      }
      if (typeof message !== "string" || message.trim().length === 0) {
        return 'Error: "message" must be a non-empty string.';
      }

      return postToSlackMessage(env, state, channel, message);
    },
  };

  return [getHubspotContactTool, updateHubspotContactTool, postToSlackTool];
}
