# lead-qualifier

Automates inbound lead qualification for a B2B professional services client using HubSpot as CRM. Triggered by HubSpot's "contact creation" webhook; fetches the contact, classifies it against an ICP with Claude, writes the classification back to HubSpot, and notifies Slack (via Nango) for Qualified and Needs Review leads.

## Trigger

HTTP POST from HubSpot's webhook system. HubSpot sends a JSON array of events; this worker reads `objectId` from the first event to know which contact to fetch. Example payload:

```json
[
  {
    "eventId": 12345,
    "subscriptionId": 67890,
    "portalId": 111,
    "occurredAt": 1691000000000,
    "subscriptionType": "contact.creation",
    "attemptNumber": 0,
    "objectId": 987654,
    "changeSource": "CRM_UI"
  }
]
```

A malformed payload, or one missing `objectId` on the first event, returns `400`.

## Tools

- `get_hubspot_contact(contact_id)` — GET the contact from HubSpot's CRM API, requesting name/company/title/phone/lifecycle/lead-status/source properties. Returns a tool-result error string on 404/401/other failures (handled gracefully, not thrown) and sets a guardrail flag the rest of the request checks.
- `update_hubspot_contact(contact_id, properties)` — PATCH the contact with the classification (`hs_lead_status`) and rationale (`nineeight_ai_notes`). Single attempt, no automatic retry — see Guardrails below.
- `post_to_slack(channel, message)` — posts via Nango's proxy to Slack's `chat.postMessage`. At most once per invocation — see Guardrails below.

## Guardrails (enforced in code, not just the system prompt)

- **No automatic retry on HubSpot writes.** A failed `update_hubspot_contact` call returns an error and is logged; it is never retried within the same invocation, since a retry after a partial failure risks a duplicate note or record.
- **At most one Slack post per invocation.** `post_to_slack` tracks whether it has already sent a message this request and refuses a second send, even if Claude's agent loop calls the tool more than once.
- **No Slack post if the HubSpot fetch failed.** `post_to_slack` checks this before sending, and the fetch handler independently returns `500` in this case regardless of what Claude's final response says.
- **Unrecognized classification → Needs Review.** After the agent loop finishes, the fetch handler checks the `hs_lead_status` value that was actually written (or the absence of one) against the four defined categories. If it doesn't match, and nothing was already posted to Slack, the worker posts a fallback notification to `#leads-needs-review` itself — it doesn't rely on Claude noticing its own miscategorization.

## Local setup

```sh
cd workers/lead-qualifier
cp .dev.vars.example .dev.vars
# fill in ANTHROPIC_API_KEY, HUBSPOT_ACCESS_TOKEN, NANGO_SECRET_KEY, NANGO_CONNECTION_ID
wrangler dev
```

## Testing without a real HubSpot webhook

Replace `YOUR_TEST_CONTACT_ID` with a real contact ID from your HubSpot test account (the numeric ID from the contact's URL or the CRM API), and `YOUR_PORTAL_ID` with your HubSpot portal/hub ID.

```sh
curl.exe -X POST http://127.0.0.1:8787 -H "Content-Type: application/json" -d '[{"eventId":12345,"portalId":YOUR_PORTAL_ID,"objectId":YOUR_TEST_CONTACT_ID,"subscriptionType":"contact.creation"}]'
```

To confirm the 400 path for a malformed payload:

```sh
curl.exe -X POST http://127.0.0.1:8787 -H "Content-Type: application/json" -d '[{"eventId":12345,"subscriptionType":"contact.creation"}]'
```

(missing `objectId` — should return `400` with a clear error.)

## Deploy

```sh
cd workers/lead-qualifier
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put HUBSPOT_ACCESS_TOKEN
wrangler secret put NANGO_SECRET_KEY
wrangler secret put NANGO_CONNECTION_ID
wrangler deploy
```

Then point HubSpot's webhook subscription (Settings → Integrations → Private Apps, or a Workflow-based webhook, depending on how the client's portal is set up) at the deployed URL for the `contact.creation` event.
