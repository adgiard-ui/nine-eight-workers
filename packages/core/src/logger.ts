/**
 * Minimal structured logging helper.
 *
 * Why structured (JSON) logs instead of plain `console.log("some string")`:
 * Cloudflare Workers logs are viewed through `wrangler tail` or a log
 * aggregator, both of which can filter/search JSON fields but not
 * free-form text. A one-line JSON object per log entry keeps everything
 * greppable without pulling in a logging library.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Arbitrary extra context to attach to a log line, e.g. { workerId: "abc" }. */
export type LogFields = Record<string, unknown>;

function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...fields,
  };

  // JSON.stringify keeps each entry on a single line, which matters for
  // log viewers that split on newlines.
  const line = JSON.stringify(entry);

  // Route to the matching console method so log viewers that color-code by
  // console method (error = red, warn = yellow) work as expected.
  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}

export const logger = {
  debug: (message: string, fields?: LogFields) => log("debug", message, fields),
  info: (message: string, fields?: LogFields) => log("info", message, fields),
  warn: (message: string, fields?: LogFields) => log("warn", message, fields),
  error: (message: string, fields?: LogFields) => log("error", message, fields),
};
