import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// SEC-03B / AG-02 - Antigravity refresh + request egress policy (Wave 1 Stage
// 1b, TEST-ONLY). An observable assertion failure here is a CONFIRMED DEFECT.
//
// Real caller chains under test (only undici's ProxyAgent construction and the
// process-global fetch are stubbed - the proxy layer itself runs for real):
//
//   Chat path:
//     chatCore builds proxyOptions from credentials.providerSpecificData
//     (open-sse/handlers/chatCore.js:324-329) and passes them to
//     executor.execute(..., proxyOptions)  ->  AntigravityExecutor refresh /
//     request calls forward proxyOptions into proxyAwareFetch (compliant).
//
//   Image path:
//     adapter.executeViaExecutor(model, body, credentials, log)
//     (open-sse/handlers/imageProviders/antigravity.js:24-28) calls
//     executor.execute WITHOUT proxyOptions, and the 401-refresh leg driven by
//     imageGenerationCore also calls executor.refreshCredentials(credentials,
//     log) without proxyOptions (open-sse/handlers/imageGenerationCore.js:129).
//
// Observable egress seam: proxyFetch attaches `dispatcher` (undici ProxyAgent,
// mocked at its real construction seam) only when egress is routed through a
// proxy. No dispatcher on the outbound call = direct egress.
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

// The antigravity IDE host (cloudcode-pa.googleapis.com) is in proxyFetch's
// MITM_BYPASS_HOSTS; a DIRECT call on that host resolves a real IP via a UDP
// dns.Resolver and then egresses through raw https.request - both escape the
// fetch stub (and the sandbox). Mocking dns.Resolver.resolve4 to fail sends
// the MITM branch down its fall-through into the stubbed fetch, keeping every
// egress observation hermetic and captured at the same seam.
vi.mock("dns", () => {
  class FakeResolver {
    setServers() {}
    resolve4(_hostname, callback) {
      callback(new Error("dns mocked out in SEC-03B/AG-02 egress tests"));
    }
  }
  return { Resolver: FakeResolver, default: { Resolver: FakeResolver } };
});

const CONN_PROXY_URL = "http://proxy.local:3128";
const GOOGLE_HOST_FRAGMENT = "googleapis.com"; // token + IDE/chat hosts; DNS probe (8.8.8.8) excluded
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
  return jsonResponse({ access_token: "at-default-ok", expires_in: 3600 });
});

function connectionPolicy(overrides = {}) {
  return {
    connectionProxyEnabled: true,
    connectionProxyUrl: CONN_PROXY_URL,
    connectionNoProxy: "",
    ...overrides,
  };
}

// Credentials carrying the same policy the way chatCore observes it.
function policyCredentials(extra = {}) {
  return {
    accessToken: "ag-at-old",
    refreshToken: null, // set per test
    projectId: "proj-1",
    providerSpecificData: {
      connectionProxyEnabled: true,
      connectionProxyUrl: CONN_PROXY_URL,
      connectionNoProxy: "",
    },
    ...extra,
  };
}

const googleCalls = () => egress.filter((c) => c.url.includes(GOOGLE_HOST_FRAGMENT));
const dispatcherUri = (call) => call?.dispatcher?.uri ?? null;

let seq = 0;
const uniqueRefreshToken = () => `rt-sec03b-${++seq}-${Date.now()}`;

let log;
let allLogText;
let warnSpy;
let errorSpy;

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
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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

describe("SEC-03B / AG-02 - Antigravity egress policy", () => {
  let getExecutor;
  let adapter;
  let PROVIDERS;

  beforeEach(async () => {
    // Dynamic import AFTER the global fetch stub is installed (outer
    // beforeEach runs first) so proxyFetch.js captures the stub.
    ({ getExecutor } = await import("../../open-sse/executors/index.js"));
    adapter = (await import("../../open-sse/handlers/imageProviders/antigravity.js")).default;
    ({ PROVIDERS } = await import("../../open-sse/config/providers.js"));
  });

  it("SEC-03B: executor refresh honors proxy-required policy (proxied token egress)", async () => {
    const executor = getExecutor("antigravity");
    const refreshToken = uniqueRefreshToken();

    const result = await executor.refreshCredentials(
      { refreshToken, accessToken: "ag-at-old", projectId: "proj-1" },
      log,
      connectionPolicy()
    );

    const call = googleCalls()[0];
    expect(call).toBeDefined();
    expect(call.url).toContain("oauth2.googleapis.com");
    expect(call.method).toBe("POST");
    expect(dispatcherUri(call)).toBe(CONN_PROXY_URL);
    expect(result?.accessToken).toBe("at-default-ok");
  }, 20000);

  it("SEC-03B: executor refresh honors connection NO_PROXY match -> direct token egress", async () => {
    const executor = getExecutor("antigravity");
    const refreshToken = uniqueRefreshToken();

    const result = await executor.refreshCredentials(
      { refreshToken, accessToken: "ag-at-old", projectId: "proj-1" },
      log,
      connectionPolicy({ connectionNoProxy: "internal.corp,googleapis.com" })
    );

    const call = googleCalls().find((c) => c.url.includes("oauth2.googleapis.com"));
    expect(call).toBeDefined();
    expect(dispatcherUri(call)).toBeNull();
    expect(result?.accessToken).toBe("at-default-ok");
  }, 20000);

  it("SEC-03B: executor refresh honors connection NO_PROXY non-match -> proxied token egress", async () => {
    const executor = getExecutor("antigravity");
    const refreshToken = uniqueRefreshToken();

    await executor.refreshCredentials(
      { refreshToken, accessToken: "ag-at-old", projectId: "proj-1" },
      log,
      connectionPolicy({ connectionNoProxy: "internal.corp,other.host" })
    );

    const call = googleCalls().find((c) => c.url.includes("oauth2.googleapis.com"));
    expect(call).toBeDefined();
    expect(dispatcherUri(call)).toBe(CONN_PROXY_URL);
  }, 20000);

  it("SEC-03B: strictProxy proxy failure is bounded - error surfaced, no direct downgrade, no token in logs", async () => {
    const executor = getExecutor("antigravity");
    const refreshToken = uniqueRefreshToken();
    responder = ({ init }) => {
      if (init?.dispatcher) throw new Error("ECONNREFUSED proxy unavailable");
      return jsonResponse({ access_token: "at-direct-downgrade", expires_in: 3600 });
    };

    const result = await executor.refreshCredentials(
      { refreshToken, accessToken: "ag-at-old", projectId: "proj-1" },
      log,
      connectionPolicy({ strictProxy: true })
    );

    // Strict boundary: the failure is contained by the executor (error logged,
    // null returned), the request is never downgraded to direct egress.
    expect(result).toBeNull();
    expect(googleCalls()).toHaveLength(1);
    expect(dispatcherUri(googleCalls()[0])).toBe(CONN_PROXY_URL);
    expect(log.error).toHaveBeenCalled();

    const logs = allLogText();
    expect(logs).not.toContain(refreshToken);
    expect(logs).not.toContain("at-direct-downgrade");
  }, 20000);

  it("SEC-03B: non-strict proxy failure falls back to direct with a redacted warning", async () => {
    const executor = getExecutor("antigravity");
    const refreshToken = uniqueRefreshToken();
    responder = ({ init }) => {
      if (init?.dispatcher) throw new Error("ECONNREFUSED proxy unavailable");
      return jsonResponse({ access_token: "at-fallback-ok", expires_in: 3600 });
    };

    const result = await executor.refreshCredentials(
      { refreshToken, accessToken: "ag-at-old", projectId: "proj-1" },
      log,
      connectionPolicy()
    );

    // Non-strict policy: direct fallback is allowed and the refresh succeeds.
    expect(result?.accessToken).toBe("at-fallback-ok");
    const calls = googleCalls().filter((c) => c.url.includes("oauth2.googleapis.com"));
    expect(calls).toHaveLength(2);
    expect(dispatcherUri(calls[0])).toBe(CONN_PROXY_URL);
    expect(dispatcherUri(calls[1])).toBeNull();

    // The fallback warning must explain the downgrade without leaking secrets.
    const warnText = JSON.stringify(warnSpy.mock.calls);
    expect(warnText).toContain("falling back to direct");
    expect(warnText).not.toContain(refreshToken);
    expect(warnText).not.toContain("at-fallback-ok");
    expect(allLogText()).not.toContain(refreshToken);
  }, 20000);

  it("SEC-03B: rotation success is bounded - single egress, tokens mapped, projectId preserved", async () => {
    const executor = getExecutor("antigravity");
    const refreshToken = uniqueRefreshToken();
    responder = () =>
      jsonResponse({ access_token: "at-new-secret", expires_in: 5400 });

    const result = await executor.refreshCredentials(
      { refreshToken, accessToken: "ag-at-old", projectId: "proj-1" },
      log,
      connectionPolicy()
    );

    expect(result?.accessToken).toBe("at-new-secret");
    expect(result?.refreshToken).toBe(refreshToken); // upstream sent no refresh_token -> keep old
    expect(result?.projectId).toBe("proj-1");
    expect(googleCalls().filter((c) => c.url.includes("oauth2.googleapis.com"))).toHaveLength(1);

    const body = Object.fromEntries(new URLSearchParams(googleCalls()[0].body));
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe(refreshToken);
    expect(body.client_id).toBe(PROVIDERS.antigravity.clientId);

    const logs = allLogText();
    expect(logs).not.toContain(refreshToken);
    expect(logs).not.toContain("at-new-secret");
  }, 20000);

  it("AG-02: image adapter request egress observes the SAME proxy policy as chat (proxy-required)", async () => {
    const executor = getExecutor("antigravity");
    const creds = policyCredentials({ refreshToken: uniqueRefreshToken() });
    const policy = connectionPolicy();
    const model = "gemini-3.1-flash-image";
    const chatBody = { contents: [{ role: "user", parts: [{ text: "draw a cat" }] }] };
    try {
      await executor.execute({ model, body: chatBody, stream: false, credentials: creds, log, proxyOptions: policy });
    } catch {
      // Response-shape handling beyond egress capture is out of scope here;
      // the chat egress entry is already recorded.
    }
    const chatCall = googleCalls().find((c) => !c.url.includes("oauth2.googleapis.com"));
    expect(chatCall).toBeDefined();
    expect(dispatcherUri(chatCall)).toBe(CONN_PROXY_URL);

    // Image-side: the adapter's real execution path (executeViaExecutor)
    // forwards the caller's proxyOptions into executor.execute - the SAME
    // policy object the chat leg used above. The adapter takes a raw image
    // body ({prompt}) and builds the chat envelope itself.
    egress.length = 0;
    try {
      await adapter.executeViaExecutor(model, { prompt: "draw a cat" }, creds, log, policy);
    } catch {
      // Same scoping note as above.
    }
    const imageCall = googleCalls().find((c) => !c.url.includes("oauth2.googleapis.com"));
    expect(imageCall).toBeDefined();
    // AG-02 locked policy: adapter -> executor must observe the SAME policy.
    // Fails today: the adapter drops proxyOptions, so egress bypasses the
    // connection proxy (defect confirmed at imageProviders/antigravity.js:24-28).
    expect(dispatcherUri(imageCall)).toBe(CONN_PROXY_URL);
  }, 20000);
  it("AG-02: image adapter request egress without 5th arg derives proxy policy from credentials", async () => {
    const creds = policyCredentials({ refreshToken: uniqueRefreshToken() });
    const model = "gemini-3.1-flash-image";

    // Production imageGenerationCore.js:57 call shape: executeViaExecutor(model, body, credentials, log)
    // called WITHOUT 5th arg (proxyOptions).
    try {
      await adapter.executeViaExecutor(model, { prompt: "draw a cat" }, creds, log);
    } catch {
      // Egress capture only.
    }

    const imageCall = googleCalls().find((c) => !c.url.includes("oauth2.googleapis.com"));
    expect(imageCall).toBeDefined();
    // Derived policy must route image adapter egress through the connection proxy
    expect(dispatcherUri(imageCall)).toBe(CONN_PROXY_URL);
  }, 20000);


  it("AG-02: image-path refresh leg drops the connection policy (imageGenerationCore-style call)", async () => {
    const executor = getExecutor("antigravity");
    const refreshToken = uniqueRefreshToken();
    const creds = policyCredentials({ refreshToken });

    // The refresh leg on the image path is invoked WITHOUT proxyOptions
    // (open-sse/handlers/imageGenerationCore.js:129-133), although the
    // credentials carry a proxy-required policy.
    await executor.refreshCredentials(creds, log);
    const withoutPolicy = googleCalls().find((c) => c.url.includes("oauth2.googleapis.com"));
    expect(withoutPolicy).toBeDefined();
    // Fails today: the executor ignored credential-carried policy on this
    // no-slot refresh leg (Stage B: derived from providerSpecificData).
    expect(dispatcherUri(withoutPolicy)).toBe(CONN_PROXY_URL);

    // Contrast: forwarding the policy at the same seam routes through the
    // proxy - the executor itself is compliant; the drop is at the call site.
    egress.length = 0;
    await executor.refreshCredentials(creds, log, connectionPolicy());
    const withPolicy = googleCalls().find((c) => c.url.includes("oauth2.googleapis.com"));
    expect(withPolicy).toBeDefined();
    expect(dispatcherUri(withPolicy)).toBe(CONN_PROXY_URL);
  }, 20000);

  it("AG-02: image adapter NO_PROXY match egresses direct (bypass semantics preserved)", async () => {
    const adapterModel = "gemini-3.1-flash-image";
    const executor = getExecutor("antigravity");
    const creds = policyCredentials({ refreshToken: uniqueRefreshToken() });
    const policy = connectionPolicy({ connectionNoProxy: "internal.corp,googleapis.com" });
    try {
      await executor.execute({ model: adapterModel, body: { contents: [{ role: "user", parts: [{ text: "draw a cat" }] }] }, stream: false, credentials: creds, log, proxyOptions: policy });
    } catch {
      // Egress capture only.
    }
    const executorCall = googleCalls().find((c) => !c.url.includes("oauth2.googleapis.com"));
    expect(executorCall).toBeDefined();
    expect(dispatcherUri(executorCall)).toBeNull();

    // Adapter path with the same credentials and the SAME NO_PROXY-match
    // policy the executor leg used: the slot forwards it and the matched
    // host keeps direct egress (bypass semantics preserved through the
    // adapter -> executor hop).
    egress.length = 0;
    try {
      await adapter.executeViaExecutor(adapterModel, { prompt: "draw a cat" }, creds, log, policy);
    } catch {
      // Response-shape handling beyond egress capture is out of scope here.
    }

    const imageCall = googleCalls().find((c) => !c.url.includes("oauth2.googleapis.com"));
    expect(imageCall).toBeDefined();
    // Pin: matched hosts must keep direct egress after the Stage B fix.
    expect(dispatcherUri(imageCall)).toBeNull();
  }, 20000);
});
