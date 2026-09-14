import { describe, expect, it } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import antigravity from "../../open-sse/providers/registry/antigravity.js";

const DAILY = "https://daily-cloudcode-pa.googleapis.com";
const SANDBOX = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const PROD = "https://cloudcode-pa.googleapis.com";

describe("Antigravity endpoint fallback chain", () => {
  it("registry chains daily → sandbox → production", () => {
    expect(antigravity.transport.baseUrls).toEqual([DAILY, SANDBOX, PROD]);
  });

  it("buildUrl walks the chain by urlIndex", () => {
    const executor = new AntigravityExecutor();
    expect(executor.buildUrl("gemini-3.8-flash-high", true, 0)).toBe(`${DAILY}/v1internal:streamGenerateContent?alt=sse`);
    expect(executor.buildUrl("gemini-3.8-flash-high", true, 1)).toBe(`${SANDBOX}/v1internal:streamGenerateContent?alt=sse`);
    expect(executor.buildUrl("gemini-3.8-flash-high", false, 2)).toBe(`${PROD}/v1internal:generateContent`);
  });

  it("shouldRetry fails over on 429, 5xx, 403 and 404 while a next host remains", () => {
    const executor = new AntigravityExecutor();
    expect(executor.getFallbackCount()).toBe(3);

    for (const status of [429, 403, 404, 500, 502, 503, 504]) {
      expect(executor.shouldRetry(status, 0)).toBe(true);
      expect(executor.shouldRetry(status, 1)).toBe(true);
    }
    // Last host: nothing left to fail over to.
    expect(executor.shouldRetry(429, 2)).toBe(false);
    expect(executor.shouldRetry(403, 2)).toBe(false);
    // Non-failover statuses never advance the chain.
    expect(executor.shouldRetry(401, 0)).toBe(false);
    expect(executor.shouldRetry(400, 0)).toBe(false);
  });
});
