import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// SEC-03C - Anthropic API-key request/transport egress policy (Wave 1 Stage
// 1b, TEST-ONLY).
//
// Caller-existence evidence (locked in the first test below): the Anthropic
// API-key path has NO refresh caller. DefaultExecutor.refreshCredentials has
// no "anthropic" entry in its refreshers map
// (open-sse/executors/default.js:238-242 + refreshers map at :219-237), so no
// token rotation is assumed anywhere in this file. Per the plan, only
// request/transport egress is covered here.
//
// Real request path under test (only undici's ProxyAgent construction and the
// process-global fetch are stubbed - the proxy layer itself runs for real):
//
//   DefaultExecutor.execute({ model, body, credentials, proxyOptions })
//     (open-sse/executors/base.js:100-184)
//     -> proxyAwareFetch(url, { method, headers, body }, proxyOptions)
//     (open-sse/utils/proxyFetch.js:294)
//
// Observable egress seam: proxyFetch attaches `dispatcher` (undici ProxyAgent,
// mocked at its real construction seam) only when egress is routed through a
// proxy. No dispatcher on the outbound call = direct egress.
//
// Receipt note (SEC-03C): refresh-egress gate remains CLOSED - verdict
// "unresolved-evidence-no-caller" per blueprint section 4/7; the transport
// cases below are the only applicable policy assertions for this provider.
// ============================================================================

vi.mock("undici", () => {
  class FakeProxyAgent {
    constructor(opts = {}) {
      this.uri = opts.uri;
    }
  }
  class FakeAgent {
    constructor(opts = {}) {
      Object.assign(this, opts);
    }
  }
  return {
    ProxyAgent: FakeProxyAgent,
    Agent: FakeAgent,
    default: { ProxyAgent: FakeProxyAgent, Agent: FakeAgent },
  };
});

const CONN_PROXY_URL = "http://proxy.local:3128";
const ANTHROPIC_HOST_FRAGMENT = "api.anthropic.com";
const API_KEY = "sk-ant-test-key";
const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
];

const egress = [];
let responder = null;

function jsonResponse(body, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null),
    },
    text: async () => text,
    json: async () => body,
  };
}

const fetchMock = vi.fn(async (input, init = {}) => {
  const url = typeof input === "string" ? input : String(input);
  egress.push({
    url,
    method: init?.method ?? null,
    headers: init?.headers ?? null,
    body: init?.body ?? null,
    redirect: init?.redirect ?? null,
    dispatcher: init?.dispatcher ?? null,
  });
  if (responder) return responder({ url, init });
  return jsonResponse({ id: "msg_default", role: "assistant", content: [] });
});

function connectionPolicy(overrides = {}) {
  return {
    connectionProxyEnabled: true,
    connectionProxyUrl: CONN_PROXY_URL,
    connectionNoProxy: "",
    ...overrides,
  };
}

const anthropicCalls = () => egress.filter((c) => c.url.includes(ANTHROPIC_HOST_FRAGMENT));
const dispatcherUri = (call) => call?.dispatcher?.uri ?? null;

let log;
let allLogText;

beforeEach(() => {
  egress.length = 0;
  responder = null;
  for (const key of PROXY_ENV_KEYS) vi.stubEnv(key, "");

  const calls = [];
  const rec = (level) => (...args) =>
    calls.push([level, ...args.map((a) => (typeof a === "string" ? a : JSON.stringify(a)))]);
  log = {
    calls,
    info: vi.fn(rec("info")),
    warn: vi.fn(rec("warn")),
    error: vi.fn(rec("error")),
    debug: vi.fn(rec("debug")),
  };
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  allLogText = () =>
    JSON.stringify([...calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]);
  // Install the fetch stub BEFORE any source module is dynamically imported
  // (see the describe-level beforeEach): proxyFetch.js captures globalThis.fetch
  // as originalFetch at import time, so this stub becomes the observable
  // egress seam for every outbound call in the file.
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("SEC-03C - Anthropic API-key request/transport egress policy", () => {
  let getExecutor;

  beforeEach(async () => {
    // Dynamic import AFTER the global fetch stub is installed (outer
    // beforeEach runs first) so proxyFetch.js captures the stub.
    ({ getExecutor } = await import("../../open-sse/executors/index.js"));
  });

  it("SEC-03C evidence: no refresh caller exists for the anthropic API-key path", async () => {
    const executor = getExecutor("anthropic");

    // DefaultExecutor.refreshers has no "anthropic" entry: whatever the
    // arguments, no token rotation happens and no egress occurs.
    const result = await executor.refreshCredentials(
      { refreshToken: "rt-nonexistent", accessToken: "at-nonexistent" },
      log,
      connectionPolicy()
    );

    expect(result).toBeNull();
    expect(egress).toHaveLength(0);
    expect(log.error).not.toHaveBeenCalled();
  }, 20000);

  it("SEC-03C: proxy-required policy routes message request egress through the connection proxy", async () => {
    const executor = getExecutor("anthropic");

    const result = await executor.execute({
      model: "claude-sonnet-5",
      body: { model: "claude-sonnet-5", max_tokens: 32, messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: API_KEY },
      log,
      proxyOptions: connectionPolicy(),
    });

    const call = anthropicCalls()[0];
    expect(call).toBeDefined();
    expect(call.url).toContain(ANTHROPIC_HOST_FRAGMENT);
    expect(call.method).toBe("POST");
    expect(dispatcherUri(call)).toBe(CONN_PROXY_URL);
    expect(result?.response?.ok).toBe(true);
  }, 20000);

  it("SEC-03C: connection NO_PROXY match routes request egress direct (bypass honored)", async () => {
    const executor = getExecutor("anthropic");

    await executor.execute({
      model: "claude-sonnet-5",
      body: { model: "claude-sonnet-5", max_tokens: 32, messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: API_KEY },
      log,
      proxyOptions: connectionPolicy({ connectionNoProxy: "internal.corp,anthropic.com" }),
    });

    const call = anthropicCalls()[0];
    expect(call).toBeDefined();
    // Pin: matched hosts must keep direct egress after any Stage B change.
    expect(dispatcherUri(call)).toBeNull();
  }, 20000);

  it("SEC-03C: connection NO_PROXY non-match keeps request egress on the proxy", async () => {
    const executor = getExecutor("anthropic");

    await executor.execute({
      model: "claude-sonnet-5",
      body: { model: "claude-sonnet-5", max_tokens: 32, messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: API_KEY },
      log,
      proxyOptions: connectionPolicy({ connectionNoProxy: "internal.corp,other.host" }),
    });

    const call = anthropicCalls()[0];
    expect(call).toBeDefined();
    expect(dispatcherUri(call)).toBe(CONN_PROXY_URL);
  }, 20000);

  it("SEC-03C: credential travels on the correct hop only - single request, bearer header, no side hops", async () => {
    const executor = getExecutor("anthropic");

    await executor.execute({
      model: "claude-sonnet-5",
      body: { model: "claude-sonnet-5", max_tokens: 32, messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: API_KEY },
      log,
      proxyOptions: connectionPolicy(),
    });

    // Exactly one egress hop for a non-streaming message request; the API key
    // travels only on that hop's x-api-key header (official Anthropic transport:
    // raw scheme, no Bearer duplication), never in the URL and nowhere else.
    expect(anthropicCalls()).toHaveLength(1);
    expect(egress).toHaveLength(1);
    const call = egress[0];
    expect(call.headers?.["x-api-key"]).toBe(API_KEY);
    expect(call.headers?.Authorization).toBeUndefined();
    expect(call.url).not.toContain(API_KEY);

    const logs = allLogText();
    expect(logs).not.toContain(API_KEY);
  }, 20000);
  it("SEC-03C: strictProxy transport failure fails closed - zero direct credential egress", async () => {
    const executor = getExecutor("anthropic");
    // Proxy stays down for every attempt: any compliant behavior (fail-closed
    // immediately, or a bounded on-proxy retry) must still reject and must
    // NEVER re-egress the credential hop direct. Fail-closed is the minimal
    // valid contract; no retry feature is required here.
    responder = () => {
      throw new Error("ECONNRESET proxy down");
    };
    const failure = executor.execute({
      model: "claude-sonnet-5",
      body: { model: "claude-sonnet-5", max_tokens: 32, messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: API_KEY },
      log,
      proxyOptions: connectionPolicy({ strictProxy: true }),
    });
    await expect(failure).rejects.toThrow();

    const calls = anthropicCalls();
    // Bounded: tracks the executor's DEFAULT_RETRY_CONFIG (4 attempts), never
    // an unbounded loop - the bound IS the security property here.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeLessThanOrEqual(4);
    for (const call of calls) {
      expect(call.url).toContain(ANTHROPIC_HOST_FRAGMENT);
      expect(call.headers?.["x-api-key"]).toBe(API_KEY);
      expect(call.headers?.Authorization).toBeUndefined();
      expect(call.url).not.toContain(API_KEY);
      // Zero direct credential egress: every observed attempt stays on the proxy.
      expect(dispatcherUri(call)).toBe(CONN_PROXY_URL);
    }
  }, 30000);

  it("SEC-03C (non-strict, approved per P-PROXY): proxy failure falls back to direct egress", async () => {
    const executor = getExecutor("anthropic");
    // APPROVED non-strict branch of the same seam: without strictProxy, one
    // failed proxy attempt may fall back to direct egress (redacted warning).
    // This row pins that approved behavior so the strict fail-closed row
    // above cannot be "fixed" by weakening the policy instead of the seam.
    let attempts = 0;
    responder = ({ init }) => {
      attempts += 1;
      if (init?.dispatcher) throw new Error("ECONNRESET proxy flake");
      return jsonResponse({ id: "msg_fallback_ok", role: "assistant", content: [] });
    };

    const result = await executor.execute({
      model: "claude-sonnet-5",
      body: { model: "claude-sonnet-5", max_tokens: 32, messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: API_KEY },
      log,
      proxyOptions: connectionPolicy(),
    });

    expect(result?.response?.ok).toBe(true);
    const calls = anthropicCalls();
    expect(calls).toHaveLength(2);
    expect(dispatcherUri(calls[0])).toBe(CONN_PROXY_URL);
    expect(dispatcherUri(calls[1])).toBeNull();
    const logs = allLogText();
    expect(logs).not.toContain(API_KEY);
  }, 30000);
});
