// Placeholder for third-party integrations shared across workers — things
// like Slack, HubSpot, Notion, or a client's internal API. Nothing lives
// here yet; add one module per integration as workers need them, and
// re-export it from this file so workers can import from
// "@nine-eight/integrations" instead of reaching into individual files.
export {};
