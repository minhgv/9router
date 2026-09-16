import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const egress = [];
let responder = null;

const fetchMock = vi.fn(async (input, init = {}) => {
  const url = typeof input === "string" ? input : String(input);
  const headers = init?.headers ? (init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : init.headers) : {};
  const entry = {
    url,
    method: init?.method ?? null,
    headers,
    body: init?.body ? (typeof init.body === "string" ? JSON.parse(init.body) : init.body) : null,
  };
  egress.push(entry);
  if (responder) return responder({ url, init, entry });
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
    clone: () => ({ text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "OK" }] } }] }) }),
    text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "OK" }] } }] }),
    json: async () => ({ candidates: [{ content: { parts: [{ text: "OK" }] } }] }),
  };
});

vi.stubGlobal("fetch", fetchMock);

vi.mock("dns", () => {
  class FakeResolver {
    setServers() {}
    resolve4(_hostname, callback) {
      callback(new Error("dns mocked out in tests"));
    }
  }
  return { Resolver: FakeResolver, default: { Resolver: FakeResolver } };
});

const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
const { default: antigravity } = await import("../../open-sse/providers/registry/antigravity.js");

const DAILY = "https://daily-cloudcode-pa.googleapis.com";
const SANDBOX = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const PROD = "https://cloudcode-pa.googleapis.com";

describe("Antigravity endpoint fallback chain", () => {
  beforeEach(() => {
    process.env.ANTIGRAVITY_IDE_VERSION = "2.11.0";
    egress.length = 0;
    responder = null;
    fetchMock.mockClear();
  });

  afterEach(() => {
    delete process.env.ANTIGRAVITY_IDE_VERSION;
  });

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

  it("walks the 3-host failover chain (403 daily → 429 sandbox → 200 prod) and rebuilds URL/headers/body", async () => {
    responder = ({ url }) => {
      if (url.includes("daily-cloudcode-pa.googleapis.com")) {
        return {
          ok: false,
          status: 403,
          headers: { get: () => null },
          clone: () => ({
            text: async () => JSON.stringify({ error: { message: "No valid license for daily" } }),
          }),
          text: async () => JSON.stringify({ error: { message: "No valid license for daily" } }),
          json: async () => ({ error: { message: "No valid license for daily" } }),
        };
      }
      if (url.includes("daily-cloudcode-pa.sandbox.googleapis.com")) {
        return {
          ok: false,
          status: 429,
          headers: { get: (k) => (k.toLowerCase() === "retry-after" ? "60" : null) }, // >10s vetoes delay, forces failover
          clone: () => ({
            text: async () => JSON.stringify({ error: { message: "Quota exceeded" } }),
          }),
          text: async () => JSON.stringify({ error: { message: "Quota exceeded" } }),
          json: async () => ({ error: { message: "Quota exceeded" } }),
        };
      }
      if (url.includes("cloudcode-pa.googleapis.com")) {
        return {
          ok: true,
          status: 200,
          headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
          clone: () => ({
            text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "OK from prod" }] } }] }),
          }),
          text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "OK from prod" }] } }] }),
          json: async () => ({ candidates: [{ content: { parts: [{ text: "OK from prod" }] } }] }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const executor = new AntigravityExecutor();
    const result = await executor.execute({
      model: "gemini-3.5-flash-low",
      body: {
        request: {
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
        },
      },
      stream: false,
      credentials: { accessToken: "ag-secret-tok-123", projectId: "proj-1" },
    });

    expect(result.response.ok).toBe(true);
    expect(result.response.status).toBe(200);
    const body = await result.response.json();
    expect(body.candidates[0].content.parts[0].text).toBe("OK from prod");

    // Exact 3 requests in chain sequence
    const requestedUrls = egress.map((e) => e.url);
    expect(requestedUrls).toEqual([
      `${DAILY}/v1internal:generateContent`,
      `${SANDBOX}/v1internal:generateContent`,
      `${PROD}/v1internal:generateContent`,
    ]);

    // Headers rebuilt correctly across all requests
    for (const call of egress) {
      expect(call.headers["Authorization"]).toBe("Bearer ag-secret-tok-123");
      expect(call.headers["Content-Type"]).toBe("application/json");
      expect(call.headers["x-request-source"]).toBe("local");
      expect(call.headers["Client-Metadata"]).toBe("ideType=ANTIGRAVITY,platform=MACOS,pluginType=GEMINI");
    }

    // Request body preserved across failovers
    for (const call of egress) {
      expect(call.body.project).toBe("proj-1");
      expect(call.body.model).toBe("gemini-3.5-flash-low");
      expect(call.body.request.contents[0].parts[0].text).toBe("hello");
    }
  });

  it("terminates failover when all 3 hosts fail and does not loop infinitely", async () => {
    responder = () => ({
      ok: false,
      status: 503,
      headers: { get: (k) => (k.toLowerCase() === "retry-after" ? "60" : null) }, // veto retry delay to test inter-host failover directly
      clone: () => ({ text: async () => JSON.stringify({ error: { message: "Service Unavailable" } }) }),
      text: async () => JSON.stringify({ error: { message: "Service Unavailable" } }),
      json: async () => ({ error: { message: "Service Unavailable" } }),
    });

    const executor = new AntigravityExecutor();
    const result = await executor.execute({
      model: "gemini-3.5-flash-low",
      body: {
        request: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        },
      },
      stream: false,
      credentials: { accessToken: "ag-tok", projectId: "proj-1" },
    });

    // Returned the final failed response without infinite retry
    expect(result.response.ok).toBe(false);
    expect(result.response.status).toBe(503);
    // All 3 hosts visited (with retry config per host bounded)
    const requestedUrls = egress.map((e) => e.url);
    expect(requestedUrls.some((u) => u.startsWith(DAILY))).toBe(true);
    expect(requestedUrls.some((u) => u.startsWith(SANDBOX))).toBe(true);
    expect(requestedUrls.some((u) => u.startsWith(PROD))).toBe(true);
  });

  it("does NOT failover on non-transient client errors (400, 401)", async () => {
    responder = () => ({
      ok: false,
      status: 400,
      headers: { get: () => null },
      clone: () => ({ text: async () => JSON.stringify({ error: { message: "Invalid request" } }) }),
      text: async () => JSON.stringify({ error: { message: "Invalid request" } }),
      json: async () => ({ error: { message: "Invalid request" } }),
    });

    const executor = new AntigravityExecutor();
    const result = await executor.execute({
      model: "gemini-3.5-flash-low",
      body: {
        request: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        },
      },
      stream: false,
      credentials: { accessToken: "ag-tok", projectId: "proj-1" },
    });

    expect(result.response.status).toBe(400);
    // Stopped on first host
    expect(egress).toHaveLength(1);
    expect(egress[0].url).toBe(`${DAILY}/v1internal:generateContent`);
  });
});
