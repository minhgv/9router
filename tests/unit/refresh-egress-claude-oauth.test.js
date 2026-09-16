import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// SEC-03D - Claude OAuth refresh egress policy (Wave 1 Stage 1b, TEST-ONLY).
// An observable assertion failure here is a CONFIRMED DEFECT.
//
// Two real caller chains exist for Claude OAuth refresh and BOTH are tested:
//
//   (A) Executor grant-refresh path (policy-aware seam):
//     getExecutor("claude").refreshCredentials(credentials, log, proxyOptions)
//     (open-sse/executors/default.js:238-242)
//       -> refresher "claude" -> refreshFromGrant(credentials, log, proxyOptions)
//       -> refreshWithJSON(PROVIDER_OAUTH.claude.tokenUrl, grant, proxyOptions)
//       -> proxyAwareFetch(url, opts, proxyOptions)
//
//   (B) Services refresh path (the one oauthCredentialManager drives):
//     refreshProviderCredentials("claude", credentials, log)
//     (open-sse/services/oauthCredentialManager.js:149-156)
//       -> refreshTokenByProvider("claude", ...)            open-sse/services/tokenRefresh.js:186
//       -> REFRESH_HANDLERS.claude -> refreshClaudeOAuthToken(refreshToken, log)
//       -> refreshAccessToken("claude", ...) -> bare fetch  open-sse/services/tokenRefresh/providers.js
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

const CONN_PROXY_URL = "http://proxy.local:3128";
const TOKEN_HOST_FRAGMENT = "api.anthropic.com/v1/oauth/token";
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
  return jsonResponse({
    access_token: "at-default-ok",
    refresh_token: "rt-default-ok",
    expires_in: 3600,
  });
});

function connectionPolicy(overrides = {}) {
  return {
    connectionProxyEnabled: true,
    connectionProxyUrl: CONN_PROXY_URL,
    connectionNoProxy: "",
    ...overrides,
  };
}
// Credentials carrying the connection proxy policy in providerSpecificData
// (matching production chatCore / imageGenerationCore / embeddingsCore storage).
function policyCredentials(extra = {}) {
  return {
    accessToken: "at-old",
    providerSpecificData: {
      connectionProxyEnabled: true,
      connectionProxyUrl: CONN_PROXY_URL,
      connectionNoProxy: "",
      vercelRelayUrl: "",
    },
    ...extra,
  };
}


const tokenCalls = () => egress.filter((c) => c.url.includes(TOKEN_HOST_FRAGMENT));
const dispatcherUri = (call) => call?.dispatcher?.uri ?? null;

// Unique refresh tokens per test: keeps the credential refresh lock and any
// result dedup cache from leaking state between tests.
let seq = 0;
const uniqueRefreshToken = () => `rt-sec03d-${++seq}-${Date.now()}`;

let log;
let allLogText;
let warnSpy;
let errorSpy;

beforeEach(() => {
  egress.length = 0;
  responder = null;
  for (const key of PROXY_ENV_KEYS) vi.stubEnv(key, "");
  // Install the fetch stub BEFORE any source module is dynamically imported
  // (see the describe-level beforeEach): proxyFetch.js captures globalThis.fetch
  // as originalFetch at import time, so this stub becomes the observable
  // egress seam for every outbound call in the file.
  vi.stubGlobal("fetch", fetchMock);


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
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("SEC-03D - Claude OAuth refresh egress policy", () => {
  let getExecutor;
  let refreshTokenByProvider;
  let PROVIDERS;

  beforeEach(async () => {
    // Dynamic import AFTER the global fetch stub is installed (outer
    // beforeEach runs first) so proxyFetch.js captures the stub.
    ({ getExecutor } = await import("../../open-sse/executors/index.js"));
    ({ refreshTokenByProvider } = await import("../../open-sse/services/tokenRefresh.js"));
    ({ PROVIDERS } = await import("../../open-sse/config/providers.js"));
  });

  // --- Path A: executor grant-refresh (policy-aware seam) -------------------

  it("SEC-03D: executor refresh honors proxy-required policy (proxied token egress)", async () => {
    const executor = getExecutor("claude");
    const refreshToken = uniqueRefreshToken();

    const result = await executor.refreshCredentials(
      { refreshToken, accessToken: "at-old" },
      log,
      connectionPolicy()
    );

    const call = tokenCalls()[0];
    expect(call).toBeDefined();
    expect(call.method).toBe("POST");
    expect(dispatcherUri(call)).toBe(CONN_PROXY_URL);
    expect(result?.accessToken).toBe("at-default-ok");
  }, 20000);
  it("SEC-03D: production call shape (no proxyOptions slot) derives proxy policy from credentials", async () => {
    const executor = getExecutor("claude");
    const refreshToken = uniqueRefreshToken();

    // Production chatCore.js:413 / imageGenerationCore.js:130 / embeddingsCore.js:86
    // call shape: executor.refreshCredentials(credentials, log) WITHOUT proxyOptions.
    const result = await executor.refreshCredentials(
      policyCredentials({ refreshToken }),
      log
    );

    const call = tokenCalls()[0];
    expect(call).toBeDefined();
    expect(call.method).toBe("POST");
    expect(dispatcherUri(call)).toBe(CONN_PROXY_URL);
    expect(result?.accessToken).toBe("at-default-ok");
  }, 20000);


  it("SEC-03D: executor refresh honors connection NO_PROXY match -> direct token egress", async () => {
    const executor = getExecutor("claude");
    const refreshToken = uniqueRefreshToken();

    const result = await executor.refreshCredentials(
      { refreshToken, accessToken: "at-old" },
      log,
      connectionPolicy({ connectionNoProxy: "internal.corp,anthropic.com" })
    );

    const call = tokenCalls()[0];
    expect(call).toBeDefined();
    expect(dispatcherUri(call)).toBeNull();
    expect(result?.accessToken).toBe("at-default-ok");
  }, 20000);

  it("SEC-03D: executor refresh honors connection NO_PROXY non-match -> proxied token egress", async () => {
    const executor = getExecutor("claude");
    const refreshToken = uniqueRefreshToken();

    await executor.refreshCredentials(
      { refreshToken, accessToken: "at-old" },
      log,
      connectionPolicy({ connectionNoProxy: "internal.corp,other.host" })
    );

    const call = tokenCalls()[0];
    expect(call).toBeDefined();
    expect(dispatcherUri(call)).toBe(CONN_PROXY_URL);
  }, 20000);

  it("SEC-03D: strictProxy proxy failure fails hard - no direct downgrade, single bounded egress", async () => {
    const executor = getExecutor("claude");
    const refreshToken = uniqueRefreshToken();
    responder = ({ init }) => {
      if (init?.dispatcher) throw new Error("ECONNREFUSED proxy unavailable");
      return jsonResponse({ access_token: "at-direct-downgrade", expires_in: 3600 });
    };

    await expect(
      executor.refreshCredentials(
        { refreshToken, accessToken: "at-old" },
        log,
        connectionPolicy({ strictProxy: true })
      )
    ).rejects.toThrow(/Proxy required but failed/);

    expect(tokenCalls()).toHaveLength(1);
    expect(dispatcherUri(tokenCalls()[0])).toBe(CONN_PROXY_URL);

    const logs = allLogText();
    expect(logs).not.toContain(refreshToken);
    expect(logs).not.toContain("at-direct-downgrade");
  }, 20000);

  it("SEC-03D: rotation success is bounded - single egress, exact grant body, no raw tokens in logs", async () => {
    const executor = getExecutor("claude");
    const refreshToken = uniqueRefreshToken();
    responder = () =>
      jsonResponse({ access_token: "at-new-secret", refresh_token: "rt-new-secret", expires_in: 3600 });

    const result = await executor.refreshCredentials(
      { refreshToken, accessToken: "at-old" },
      log,
      connectionPolicy()
    );

    expect(result?.accessToken).toBe("at-new-secret");
    expect(result?.refreshToken).toBe("rt-new-secret");
    expect(tokenCalls()).toHaveLength(1);

    const body = JSON.parse(tokenCalls()[0].body);
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe(refreshToken);
    expect(body.client_id).toBe(PROVIDERS.claude.clientId);

    const logs = allLogText();
    expect(logs).not.toContain(refreshToken);
    expect(logs).not.toContain("at-new-secret");
    expect(logs).not.toContain("rt-new-secret");
  }, 20000);

  // --- Path B: services refresh (the oauthCredentialManager-driven seam) ----

  it("SEC-03D: services refresh path honors proxy-required policy (no direct egress)", async () => {
    const refreshToken = uniqueRefreshToken();

    await refreshTokenByProvider("claude", { refreshToken, accessToken: "at-old" }, log, connectionPolicy());

    const call = tokenCalls()[0];
    expect(call).toBeDefined();
    // Locked policy: when the connection policy requires a proxy, the
    // services-level refresh (the path oauthCredentialManager actually
    // drives) must traverse it too. Stage B threads proxyOptions through
    // refreshTokenByProvider -> REFRESH_HANDLERS -> providers.js.
    expect(dispatcherUri(call)).toBe(CONN_PROXY_URL);
  }, 20000);

  it("SEC-03D: services refresh terminal failure is bounded and does not leak tokens", async () => {
    const refreshToken = uniqueRefreshToken();
    responder = () =>
      jsonResponse(
        { error: "invalid_grant", error_description: "refresh token already used" },
        400
      );

    const result = await refreshTokenByProvider(
      "claude",
      { refreshToken, accessToken: "at-old" },
      log
    );

    // Bounded: exactly one egress; the failure is surfaced (terminal error
    // object) or contained (null) - never thrown raw, never retried here.
    expect(tokenCalls()).toHaveLength(1);
    expect(result === null || result?.error === "unrecoverable_refresh_error").toBe(true);

    const logs = allLogText();
    expect(logs).not.toContain(refreshToken);
    expect(logs).not.toContain("at-old");
  }, 20000);

  it("SEC-03D: both refresh paths target the same token endpoint", async () => {
    const executor = getExecutor("claude");
    const executorToken = uniqueRefreshToken();
    const servicesToken = uniqueRefreshToken();

    await executor.refreshCredentials({ refreshToken: executorToken, accessToken: "at-a" }, log);
    await refreshTokenByProvider("claude", { refreshToken: servicesToken, accessToken: "at-b" }, log);

    // Both paths must resolve the Claude token endpoint to the same origin
    // and path - a split-brain URL would split the NO_PROXY match domain.
    expect(tokenCalls()).toHaveLength(2);
    const urls = tokenCalls().map((c) => c.url);
    expect(new URL(urls[0]).origin).toBe(new URL(urls[1]).origin);
    expect(new URL(urls[0]).pathname).toBe(new URL(urls[1]).pathname);
    expect(urls[0]).toContain(TOKEN_HOST_FRAGMENT);
  }, 20000);
});
