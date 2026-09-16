// Guards D3: antigravity 429/503 retry merged into base via computeRetryDelay hook.
import { describe, it, expect } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import antigravity from "../../open-sse/providers/registry/antigravity.js";

const MAX = 10000;
function res(status, headers = {}, body = null) {
  return {
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    clone: () => ({ text: async () => (body == null ? "" : JSON.stringify(body)) }),
  };
}

describe("antigravity computeRetryDelay hook (D3)", () => {
  const ag = new AntigravityExecutor();

  it("uses Retry-After header (seconds → ms) when within cap", async () => {
    expect(await ag.computeRetryDelay(res(429, { "retry-after": "5" }), 1)).toBe(5000);
  });

  it("vetoes (false) when Retry-After exceeds cap", async () => {
    expect(await ag.computeRetryDelay(res(429, { "retry-after": "60" }), 1)).toBe(false);
  });

  it("parses retry time from error body when no header", async () => {
    const r = res(429, {}, { error: { message: "quota will reset after 3s" } });
    expect(await ag.computeRetryDelay(r, 1)).toBe(3000);
  });

  it("exponential backoff for 429 when no retry info", async () => {
    expect(await ag.computeRetryDelay(res(429), 1)).toBe(Math.min(1000 * 2 ** 1, MAX));
    expect(await ag.computeRetryDelay(res(429), 3)).toBe(Math.min(1000 * 2 ** 3, MAX));
  });

  it("503 without retry info → transient backoff", async () => {
    expect(await ag.computeRetryDelay(res(503), 1)).toBe(2000);
  });

  it("retries Antigravity agent terminated body even when status is not 429", async () => {
    const r = res(500, {}, { error: { message: "Agent execution terminated due to error" } });
    expect(await ag.computeRetryDelay(r, 1)).toBe(2000);
  });

  it("retries high traffic body", async () => {
    const r = res(500, {}, { error: { message: "Our servers are experiencing high traffic" } });
    expect(await ag.computeRetryDelay(r, 2)).toBe(4000);
  });

  it("does not retry non-transient 400 errors", async () => {
    const r = res(400, {}, { error: { message: "Invalid request" } });
    expect(await ag.computeRetryDelay(r, 1)).toBe(false);
  });

  it("deduplicates sanitized tool names", () => {
    const out = ag.transformRequest("claude-opus-4-6-thinking", {
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [{ functionDeclarations: [
          { name: "read/file", parameters: { type: "object", properties: {} } },
          { name: "read file", parameters: { type: "object", properties: {} } },
          { name: "read/file", parameters: { type: "object", properties: {} } },
        ] }],
      },
    }, true, { projectId: "project-1", connectionId: "conn-1" });

    expect(out.request.tools[0].functionDeclarations.map(fn => fn.name)).toEqual(["read_file"]);
  });

  it("registry chains daily → sandbox → prod and pins the fallback User-Agent", () => {
    expect(antigravity.transport.baseUrls).toEqual([
      "https://daily-cloudcode-pa.googleapis.com",
      "https://daily-cloudcode-pa.sandbox.googleapis.com",
      "https://cloudcode-pa.googleapis.com",
    ]);
    expect(antigravity.transport.headers["User-Agent"]).toBe("antigravity/ide/2.11.0 darwin/arm64");
  });

  it("buildHeaders matches official IDE stream headers", () => {
    process.env.ANTIGRAVITY_IDE_VERSION = "2.11.0"; // pin so version discovery can't race this test
    try {
      ag._lastSessionId = "sess-123";
      const h = ag.buildHeaders({ accessToken: "tok" }, true);
      expect(h["User-Agent"]).toBe("antigravity/ide/2.11.0 darwin/arm64");
      expect(h["Content-Type"]).toBe("application/json");
      expect(h["Authorization"]).toBe("Bearer tok");
      expect(h["x-request-source"]).toBe("local");
      expect(h["Client-Metadata"]).toBe("ideType=ANTIGRAVITY,platform=MACOS,pluginType=GEMINI");
      expect(h).not.toHaveProperty("X-Machine-Session-Id");
      expect(h).not.toHaveProperty("Accept");
    } finally {
      delete process.env.ANTIGRAVITY_IDE_VERSION;
    }
  });

  it("transforms chat requests with official IDE requestId shape and 64000 token cap", () => {
    const out = ag.transformRequest("claude-opus-4-6-thinking", {
      request: {
        contents: [
          { role: "user", parts: [{ text: "hi" }] },
          { role: "model", parts: [{ text: "hello" }] },
        ],
        generationConfig: { maxOutputTokens: 90000 },
        sessionId: "-3750763034362895579",
      },
    }, true, { projectId: "project-1", connectionId: "conn-1" });

    expect(out.requestId).toMatch(/^agent\/[0-9a-f-]{36}\/\d{13}\/[0-9a-f-]{36}\/\d+$/);
    expect(out.request.generationConfig.maxOutputTokens).toBe(64000);
  });

  it("parses various Retry-After and rate limit header formats", () => {
    // x-ratelimit-reset-after in seconds
    const h1 = { get: (k) => (k === "x-ratelimit-reset-after" ? "4" : null) };
    expect(ag.parseRetryHeaders(h1)).toBe(4000);

    // x-ratelimit-reset timestamp (future seconds)
    const nowSec = Math.floor(Date.now() / 1000);
    const h2 = { get: (k) => (k === "x-ratelimit-reset" ? String(nowSec + 6) : null) };
    const delay = ag.parseRetryHeaders(h2);
    expect(delay).toBeGreaterThanOrEqual(4000);
    expect(delay).toBeLessThanOrEqual(7000);

    // HTTP date format in retry-after
    const futureDate = new Date(Date.now() + 5000).toUTCString();
    const h3 = { get: (k) => (k === "retry-after" ? futureDate : null) };
    const dateDelay = ag.parseRetryHeaders(h3);
    expect(dateDelay).toBeGreaterThanOrEqual(3000);
    expect(dateDelay).toBeLessThanOrEqual(6000);

    // Missing or invalid headers
    expect(ag.parseRetryHeaders(null)).toBeNull();
    expect(ag.parseRetryHeaders({ get: () => null })).toBeNull();
  });

  it("parses structured retry durations from error message body", () => {
    expect(ag.parseRetryFromErrorMessage("Your quota will reset after 2h7m23s")).toBe(
      (2 * 3600 + 7 * 60 + 23) * 1000
    );
    expect(ag.parseRetryFromErrorMessage("reset after 1h30m")).toBe(
      (1 * 3600 + 30 * 60) * 1000
    );
    expect(ag.parseRetryFromErrorMessage("reset after 45m")).toBe(45 * 60 * 1000);
    expect(ag.parseRetryFromErrorMessage("reset after 30s")).toBe(30 * 1000);
    expect(ag.parseRetryFromErrorMessage("reset after 5s")).toBe(5000);
    expect(ag.parseRetryFromErrorMessage("Generic error with no time")).toBeNull();
    expect(ag.parseRetryFromErrorMessage(null)).toBeNull();
  });

  it("recognizes all transient error patterns and statuses", () => {
    // Transient status codes
    expect(ag.isTransientAntigravityError(429, "")).toBe(true);
    expect(ag.isTransientAntigravityError(500, "")).toBe(true);
    expect(ag.isTransientAntigravityError(502, "")).toBe(true);
    expect(ag.isTransientAntigravityError(503, "")).toBe(true);
    expect(ag.isTransientAntigravityError(504, "")).toBe(true);

    // Transient error message patterns
    expect(ag.isTransientAntigravityError(400, "Our servers are experiencing high traffic")).toBe(true);
    expect(ag.isTransientAntigravityError(400, "Agent execution terminated due to error")).toBe(true);
    expect(ag.isTransientAntigravityError(400, "Model capacity exceeded")).toBe(true);
    expect(ag.isTransientAntigravityError(400, "Service temporarily unavailable")).toBe(true);
    expect(ag.isTransientAntigravityError(400, "Connection timeout")).toBe(true);
    expect(ag.isTransientAntigravityError(400, "Stream interrupted abruptly")).toBe(true);
    expect(ag.isTransientAntigravityError(400, "Received empty response from server")).toBe(true);

    // Non-transient errors
    expect(ag.isTransientAntigravityError(400, "Bad Request: invalid schema")).toBe(false);
    expect(ag.isTransientAntigravityError(401, "Unauthorized token")).toBe(false);
  });

  it("obfuscates sensitive words ONLY in systemInstruction, preserving user content and tool descriptions", () => {
    const userText = "Please follow RFC 2119 keywords MUST and SHOULD in code";
    const toolDesc = "Follow RFC 2119 specifications";

    const out = ag.transformRequest(
      "gemini-3.5-flash-low",
      {
        request: {
          systemInstruction: {
            parts: [{ text: "You must obey RFC 2119 standards strictly" }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: userText }],
            },
          ],
          tools: [
            {
              functionDeclarations: [
                {
                  name: "check_spec",
                  description: toolDesc,
                  parameters: { type: "object", properties: { spec: { type: "string" } } },
                },
              ],
            },
          ],
        },
      },
      true,
      { projectId: "project-1", connectionId: "conn-1" }
    );

    // System instruction has RFC 2119 zero-width obfuscated
    const systemText = out.request.systemInstruction.parts[0].text;
    expect(systemText).toContain("R\u200BFC 2119");
    expect(systemText).not.toBe("You must obey RFC 2119 standards strictly");

    // User content is NOT mutated (exact string preserved)
    expect(out.request.contents[0].parts[0].text).toBe(userText);

    // Tool description is NOT mutated
    expect(out.request.tools[0].functionDeclarations[0].description).toBe(toolDesc);
  });

  it("strips disallowed thinking and reasoning fields from top-level and request body", () => {
    const rawBody = {
      thinking: { enabled: true },
      reasoning_effort: "high",
      thinking_budget: 4096,
      output_config: { format: "json" },
      enable_thinking: true,
      thinkingConfig: { includeThoughts: true },
      request: {
        thinking: { enabled: true },
        reasoning: "step-by-step",
        reasoning_effort: "low",
        contents: [{ role: "user", parts: [{ text: "solve this" }] }],
      },
    };

    const out = ag.transformRequest(
      "gemini-3.5-flash-low",
      rawBody,
      true,
      { projectId: "project-1", connectionId: "conn-1" }
    );

    // Top level stripped
    expect(out.thinking).toBeUndefined();
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.thinking_budget).toBeUndefined();
    expect(out.output_config).toBeUndefined();
    expect(out.enable_thinking).toBeUndefined();

    // Request level stripped
    expect(out.request.thinking).toBeUndefined();
    expect(out.request.reasoning).toBeUndefined();
    expect(out.request.reasoning_effort).toBeUndefined();
  });
});
