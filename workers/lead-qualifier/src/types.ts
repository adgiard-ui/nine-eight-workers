/**
 * Bindings available to this Worker — declared in wrangler.toml (vars) or
 * set as a secret (`wrangler secret put` / `.dev.vars`). Cloudflare injects
 * these into the `env` parameter of the fetch handler; there's no
 * `process.env` in the Workers runtime.
 */
export interface Env {
  ANTHROPIC_API_KEY: string;
  HUBSPOT_ACCESS_TOKEN: string;
  NANGO_SECRET_KEY: string;
  NANGO_CONNECTION_ID: string;
  /** Optional model override. Falls back to DEFAULT_MODEL in index.ts. */
  CLAUDE_MODEL?: string;
}

/**
 * Mutable state shared across every tool call within a single invocation
 * (one HTTP request = one `InvocationState`, created fresh in the fetch
 * handler and threaded into `createTools`). This is how the code-level
 * guardrails are enforced — they hold regardless of what Claude decides to
 * do, rather than relying on the system prompt alone:
 *
 *   - `hubspotFetchFailed` — set by get_hubspot_contact on any fetch
 *     failure. Checked by post_to_slack (refuses to post) and by index.ts
 *     after the loop (returns 500 instead of a normal response).
 *   - `slackPosted` — set by post_to_slack after a successful send. Checked
 *     by post_to_slack itself so a second call in the same invocation is a
 *     no-op instead of a duplicate notification, even if Claude's agent
 *     loop calls the tool more than once.
 *   - `lastHsLeadStatus` — the hs_lead_status value Claude actually wrote
 *     via update_hubspot_contact, if any. Checked by index.ts after the
 *     loop against the four defined categories; an unrecognized or missing
 *     value triggers the worker's own Needs Review fallback notification.
 */
export interface InvocationState {
  hubspotFetchFailed: boolean;
  hubspotFetchError?: string;
  slackPosted: boolean;
  lastHsLeadStatus?: string;
}
