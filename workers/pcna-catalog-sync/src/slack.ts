import { logger } from "@nine-eight/core/logger";
import type { Env, RunSummary } from "./types";

/**
 * Posts the run summary to Slack via Nango's proxy, the same
 * Nango-to-Slack pattern lead-qualifier uses. Unlike lead-qualifier, a
 * failed Slack post here is logged and swallowed rather than surfaced as
 * a run failure — by the time this is called, the crawl has already
 * written its D1/R2 state; losing the notification shouldn't make the run
 * itself look like it failed.
 */
export async function postRunSummaryToSlack(env: Env, summary: RunSummary): Promise<void> {
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
      body: JSON.stringify({ channel: env.SLACK_CHANNEL, text: buildSummaryMessage(summary) }),
    });
  } catch (error) {
    logger.error("pcna_slack_post_network_error", { error: String(error) });
    return;
  }

  if (!res.ok) {
    logger.error("pcna_slack_post_failed", { status: res.status, body: await res.text() });
    return;
  }

  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (data.ok === false) {
    logger.error("pcna_slack_post_rejected", { error: data.error });
  }
}

function buildSummaryMessage(summary: RunSummary): string {
  return [
    `*PCNA catalog sync* — ${summary.categoriesCrawled} categories crawled`,
    `Seen: ${summary.productsSeen} | New: ${summary.newCount} | Changed: ${summary.changedCount} | Failed: ${summary.failedCount}`,
    `Duration: ${Math.round(summary.durationMs / 1000)}s`,
    summary.csvKey ? `CSV: ${summary.csvKey}` : "No CSV written (no new/changed products this run).",
  ].join("\n");
}
