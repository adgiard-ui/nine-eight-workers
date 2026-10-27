import { logger } from "@nine-eight/core/logger";
import type { Env, RunSummary } from "./types";

/**
 * Posts the run summary to a Google Chat space via an incoming webhook
 * (GOOGLE_CHAT_WEBHOOK_URL). A failed post is logged and swallowed rather
 * than surfaced as a run failure — by the time this is called, the crawl
 * has already written its D1/R2 state; losing the notification shouldn't
 * make the run itself look like it failed.
 *
 * An unset/empty webhook skips notifying entirely — that's how local test
 * runs stay quiet (leave it out of .dev.vars and read the summary from the
 * pcna_crawl_run_complete log line instead).
 */
export async function postRunSummary(env: Env, summary: RunSummary, fetchImpl: typeof fetch = fetch): Promise<void> {
  await postText(env, buildSummaryMessage(summary), fetchImpl);
}

/**
 * Posts a short failure notification when runCrawl itself throws — the
 * one case the summary post above never reaches, since a thrown run has
 * no summary to report. Never throws itself, same as the summary post.
 */
export async function postRunFailure(env: Env, error: unknown, fetchImpl: typeof fetch = fetch): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await postText(env, `*PCNA catalog sync* — run failed: ${message}`, fetchImpl);
}

async function postText(env: Env, text: string, fetchImpl: typeof fetch): Promise<void> {
  const webhookUrl = env.GOOGLE_CHAT_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    logger.info("pcna_notify_skipped", { reason: "GOOGLE_CHAT_WEBHOOK_URL not set" });
    return;
  }

  // The webhook URL carries Google's key and token in its query string, so
  // it's never logged — and neither is a network error's message, which
  // can echo the URL back.
  let res: Response;
  try {
    res = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ text }),
    });
  } catch (error) {
    logger.error("pcna_notify_network_error", { errorName: error instanceof Error ? error.name : typeof error });
    return;
  }

  if (!res.ok) {
    logger.error("pcna_notify_failed", { status: res.status, body: await res.text() });
  }
}

export function buildSummaryMessage(summary: RunSummary): string {
  return [
    `*PCNA catalog sync* — ${summary.categoriesCrawled} of ${summary.categoriesDiscovered} categories crawled (from ${summary.sitemapUrls} sitemap URLs)`,
    `Seen: ${summary.productsSeen} | New: ${summary.newCount} | Changed: ${summary.changedCount} | Failed: ${summary.failedCount}`,
    `Duration: ${Math.round(summary.durationMs / 1000)}s`,
    summary.csvKey ? `CSV: ${summary.csvKey}` : "No CSV written (no new/changed products this run).",
  ].join("\n");
}
