import { describe, expect, it } from "vitest";
import { secretsMatch } from "./auth";

describe("secretsMatch", () => {
  it("accepts an exact match", async () => {
    expect(await secretsMatch("long-random-secret", "long-random-secret")).toBe(true);
  });

  it("rejects a wrong value of the same length", async () => {
    expect(await secretsMatch("long-random-secreT", "long-random-secret")).toBe(false);
  });

  it("rejects a prefix or a longer value (no early exit on length)", async () => {
    expect(await secretsMatch("long-random", "long-random-secret")).toBe(false);
    expect(await secretsMatch("long-random-secret-extra", "long-random-secret")).toBe(false);
  });

  it("rejects a missing header", async () => {
    expect(await secretsMatch(null, "long-random-secret")).toBe(false);
  });

  it("rejects everything when no secret is configured, including an empty header", async () => {
    expect(await secretsMatch("", "")).toBe(false);
    expect(await secretsMatch("anything", undefined)).toBe(false);
  });
});
