import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSummaryMessage, postRunFailure, postRunSummary } from "./notify";
import type { Env, RunSummary } from "./types";

const WEBHOOK = "https://chat.googleapis.com/v1/spaces/AAA/messages?key=SECRETKEY&token=SECRETTOKEN";

const summary: RunSummary = {
  sitemapUrls: 2592,
  categoriesDiscovered: 118,
  categoriesCrawled: 5,
  productsSeen: 340,
  newCount: 12,
  changedCount: 3,
  failedCount: 1,
  durationMs: 61_400,
  csvKey: "pcna-delta-2026-10-27-1900.csv",
};

function envWith(webhook: string | undefined): Env {
  return { GOOGLE_CHAT_WEBHOOK_URL: webhook } as Env;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildSummaryMessage", () => {
  it("includes the counts, duration and CSV key", () => {
    const text = buildSummaryMessage(summary);
    expect(text).toContain("5 of 118 categories crawled (from 2592 sitemap URLs)");
    expect(text).toContain("Seen: 340 | New: 12 | Changed: 3 | Failed: 1");
    expect(text).toContain("Duration: 61s");
    expect(text).toContain("CSV: pcna-delta-2026-10-27-1900.csv");
  });

  it("says so when no CSV was written", () => {
    expect(buildSummaryMessage({ ...summary, csvKey: null })).toContain("No CSV written");
  });
});

describe("postRunSummary", () => {
  it("POSTs { text } as JSON to the Google Chat webhook", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

    await postRunSummary(envWith(WEBHOOK), summary, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json; charset=UTF-8");
    expect(JSON.parse(init.body)).toEqual({ text: buildSummaryMessage(summary) });
  });

  it.each([undefined, "", "   "])("skips notifying entirely when the webhook is %j", async (webhook) => {
    const fetchImpl = vi.fn();

    await postRunSummary(envWith(webhook), summary, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never throws on a network error, and never logs the webhook URL", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`connect failed: ${WEBHOOK}`));

    await expect(postRunSummary(envWith(WEBHOOK), summary, fetchImpl)).resolves.toBeUndefined();

    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("pcna_notify_network_error");
    expect(logged).not.toContain("SECRETKEY");
    expect(logged).not.toContain("SECRETTOKEN");
  });

  it("never throws on a non-2xx response, and logs the status", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Invalid space", { status: 400 }));

    await expect(postRunSummary(envWith(WEBHOOK), summary, fetchImpl)).resolves.toBeUndefined();

    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("pcna_notify_failed");
    expect(logged).toContain("400");
  });
});

describe("postRunFailure", () => {
  it("posts the error message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

    await postRunFailure(envWith(WEBHOOK), new Error("No sitemap URLs matched"), fetchImpl);

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body).text).toBe("*PCNA catalog sync* — run failed: No sitemap URLs matched");
  });
});
