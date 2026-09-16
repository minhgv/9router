import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// SEC-03A / CODEX-06 - Codex token-refresh egress policy (Wave 1 Stage 1b,
// TEST-ONLY). An observable assertion failure here is a CONFIRMED DEFECT; the
// production source must NOT be adjusted to make these pass.
//
// Real caller chain under test (only undici's ProxyAgent construction and the
// process-global fetch are stubbed - the proxy layer itself runs for real):
//
//   CodexExecutor.refreshCredentials(credentials, log)          open-sse/executors/codex.js:237
//     -> refreshProviderCredentials(provider, credentials, log) open-sse/services/oauthCredentialManager.js:149
//        (signature has NO proxyOptions parameter)
//     -> refreshTokenByProvider("codex", ...)                   open-sse/services/tokenRefresh.js
//     -> refreshCodexToken -> bare fetch(tokenEndpoint)         open-sse/services/tokenRefresh/providers.js:261
//     -> patchedFetch -> proxyAwareFetch(url, opts, null)       open-sse/utils/proxyFetch.js:294
//
// Observable egress seam: open-sse/utils/proxyFetch.js captures globalThis.fetch
// as `originalFetch` at module import, so the global fetch is stubbed BEFORE any
// source module is dynamically imported (see beforeEach). "Proxied vs direct"
// is read from the captured fetch options: proxyFetch attaches `dispatcher`
// (an undici ProxyAgent, mocked at its real construction seam) ONLY when the
// request is routed through a proxy. No dispatcher on the outbound call =
// direct egress. Implementation call counts are deliberately not asserted.
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
const TOKEN_HOST_FRAGMENT = "auth.openai.com";
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
    id_token: "idt-default-ok",
    expires_in: 3600,
  });
});

// Connection-level proxy policy, mirroring the shape chatCore.js builds from
// credentials.providerSpecificData (open-sse/handlers/chatCore.js:324-329).
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

// Every refresh in this file uses a unique refresh token so the module-level
// dedup cache (open-sse/services/tokenRefresh/dedup.js, 10s result TTL) and the
// credential refresh lock never leak state between tests.
let seq = 0;
const uniqueRefreshToken = () => `rt-sec03a-${++seq}-${Date.now()}`;

let log;
let allLogText;

beforeEach(() => {
  egress.length = 0;
  responder = null;
  // Isolate ambient proxy env: routing must be decided only by the policy and
  // env state each test installs explicitly.
  for (const key of PROXY_ENV_KEYS) vi.stubEnv(key, "");

  const calls = [];
  const rec = (level) => (...args) =>
    calls.push([level, ...args.map((a) => (typeof a === "string" ? a : JSON.stringify(a)))]);
  log = {
    calls,
    info: vi.fn(rec("info")),
    warn: vi.fn(rec("warn")),
    error: vi.fn(rec("error")),
  };
  // Install the fetch stub BEFORE any source module is dynamically imported
  // (see the describe-level beforeEach): proxyFetch.js captures globalThis.fetch
  // as originalFetch at import time, so this stub becomes the observable
  // egress seam for every outbound call in the file.
  vi.stubGlobal("fetch", fetchMock);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  allLogText = () =>
    JSON.stringify([...calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("SEC-03A / CODEX-06 - Codex refresh egress policy", () => {
  let getExecutor;
  let PROVIDERS;

  beforeEach(async () => {
    // Dynamic import AFTER the global fetch stub is installed (outer
    // beforeEach runs first), so proxyFetch.js captures the stub as
    // originalFetch and no real network I/O can occur.
    ({ getExecutor } = await import("../../open-sse/executors/index.js"));
    ({ PROVIDERS } = await import("../../open-sse/config/providers.js"));
  });

  it("SEC-03A: proxy-required policy routes token-refresh egress through the connection proxy", async () => {
    const executor = getExecutor("codex");
    const refreshToken = uniqueRefreshToken();

    await executor.refreshCredentials(
      { refreshToken, accessToken: "at-old" },
      log,
      connectionPolicy()
    );

    const call = tokenCalls()[0];
    expect(call).toBeDefined();
    expect(call.method).toBe("POST");
    // P-REFRESH: when the policy requires a proxy, refresh egress MUST
    // traverse it - a null dispatcher here means direct egress bypassed the
    // connection proxy (assertion fails today: the Codex refresh caller chain
    // drops proxyOptions before the bare token fetch).
    expect(dispatcherUri(call)).toBe(CONN_PROXY_URL);
  }, 20000);
  it("SEC-03A: production call shape (no proxyOptions slot) derives proxy policy from credentials", async () => {
    const executor = getExecutor("codex");
    const refreshToken = uniqueRefreshToken();

    // Production chatCore.js:413 / imageGenerationCore.js:130 / embeddingsCore.js:86
    // call shape: executor.refreshCredentials(credentials, log) WITHOUT proxyOptions.
    await executor.refreshCredentials(
      policyCredentials({ refreshToken }),
      log
    );

    const call = tokenCalls()[0];
    expect(call).toBeDefined();
    expect(call.method).toBe("POST");
    // Derived policy must route token refresh through the connection proxy
    expect(dispatcherUri(call)).toBe(CONN_PROXY_URL);
  }, 20000);


  it("SEC-03A: connection NO_PROXY non-match keeps refresh egress on the proxy", async () => {
    const executor = getExecutor("codex");
    const refreshToken = uniqueRefreshToken();

    await executor.refreshCredentials(
      { refreshToken, accessToken: "at-old" },
      log,
      connectionPolicy({ connectionNoProxy: "internal.corp,other.host" })
    );

    const call = tokenCalls()[0];
    expect(call).toBeDefined();
    expect(call.url).toContain(TOKEN_HOST_FRAGMENT);
    expect(dispatcherUri(call)).toBe(CONN_PROXY_URL);
  }, 20000);

  it("SEC-03A: connection NO_PROXY match routes refresh egress direct (bypass honored)", async () => {
    const executor = getExecutor("codex");
    const refreshToken = uniqueRefreshToken();

    const result = await executor.refreshCredentials(
      { refreshToken, accessToken: "at-old" },
      log,
      connectionPolicy({ connectionNoProxy: "internal.corp,openai.com" })
    );

    const call = tokenCalls()[0];
    expect(call).toBeDefined();
    // Bypass semantics: matched hosts egress direct (no dispatcher) even when
    // a connection proxy is configured. This pin must survive the Stage B fix.
    expect(dispatcherUri(call)).toBeNull();
    expect(result?.accessToken).toBe("at-default-ok");
  }, 20000);

  it("SEC-03A: no proxy configured and no env proxy -> direct egress, bounded single call", async () => {
    const executor = getExecutor("codex");
    const refreshToken = uniqueRefreshToken();

    // Real chatCore call shape when no connection proxy is configured: no
    // proxyOptions are handed down at all.
    const result = await executor.refreshCredentials(
      { refreshToken, accessToken: "at-old" },
      log
    );

    expect(tokenCalls()).toHaveLength(1);
    expect(dispatcherUri(tokenCalls()[0])).toBeNull();
    expect(result?.accessToken).toBe("at-default-ok");
  }, 20000);

  it("CODEX-06: successful rotation merges tokens in one bounded egress and never logs raw tokens", async () => {
    const executor = getExecutor("codex");
    const refreshToken = uniqueRefreshToken();
    responder = () =>
      jsonResponse({
        access_token: "at-new-secret",
        refresh_token: "rt-new-secret",
        id_token: "idt-new-secret",
        expires_in: 3600,
      });

    const result = await executor.refreshCredentials(
      { refreshToken, accessToken: "at-old" },
      log
    );

    expect(result?.accessToken).toBe("at-new-secret");
    expect(result?.refreshToken).toBe("rt-new-secret");
    expect(result?.idToken).toBe("idt-new-secret");
    expect(result?.expiresAt).toBeDefined();
    // Bounded: exactly one token-endpoint egress, no retry loop.
    expect(tokenCalls()).toHaveLength(1);

    const body = JSON.parse(tokenCalls()[0].body);
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe(refreshToken);
    expect(body.client_id).toBe(PROVIDERS.codex.clientId);

    // No raw token material in any log level or console output.
    const logs = allLogText();
    expect(logs).not.toContain(refreshToken);
    expect(logs).not.toContain("at-new-secret");
    expect(logs).not.toContain("rt-new-secret");
    expect(logs).not.toContain("idt-new-secret");
  }, 20000);

  it("CODEX-06: permanent refresh failure (invalid_grant) is terminal, bounded, and does not leak tokens", async () => {
    const executor = getExecutor("codex");
    const refreshToken = uniqueRefreshToken();
    responder = () =>
      jsonResponse(
        {
          error: "invalid_grant",
          error_description: "refresh token already used",
        },
        401
      );

    const result = await executor.refreshCredentials(
      { refreshToken, accessToken: "at-old" },
      log
    );

    // Terminal: surfaced as unrecoverable so account fallback can stop
    // retrying this credential; bounded: single egress.
    expect(result?.error).toBe("unrecoverable_refresh_error");
    expect(result?.code).toBe("invalid_grant");
    expect(tokenCalls()).toHaveLength(1);

    const logs = allLogText();
    expect(logs).not.toContain(refreshToken);
    expect(logs).not.toContain("at-old");
  }, 20000);

  it("CODEX-06: transient refresh failure (5xx) stays bounded - single attempt, credentials unchanged", async () => {
    const executor = getExecutor("codex");
    const refreshToken = uniqueRefreshToken();
    responder = () => jsonResponse({ error: "server_error" }, 503);

    const result = await executor.refreshCredentials(
      { refreshToken, accessToken: "at-old" },
      log
    );

    // Bounded: no retry loop inside a single refresh call; the old refresh
    // token is preserved (caller keeps existing credentials).
    expect(tokenCalls()).toHaveLength(1);
    expect(result?.accessToken).toBeUndefined();
    expect(result?.refreshToken).toBeUndefined();
  }, 20000);

  it("CODEX-06: concurrent duplicate refresh collapses to a single egress", async () => {
    const executor = getExecutor("codex");
    const refreshToken = uniqueRefreshToken();

    const [r1, r2] = await Promise.all([
      executor.refreshCredentials({ refreshToken, accessToken: "at-a" }, log),
      executor.refreshCredentials({ refreshToken, accessToken: "at-b" }, log),
    ]);

    expect(tokenCalls()).toHaveLength(1);
    expect(r1?.accessToken).toBe("at-default-ok");
    expect(r2?.accessToken).toBe("at-default-ok");
  }, 20000);

  it("SEC-03A: refresh egress carries no credential beyond the refresh grant (single-hop hygiene)", async () => {
    const executor = getExecutor("codex");
    const refreshToken = uniqueRefreshToken();

    await executor.refreshCredentials(
      { refreshToken, accessToken: "at-old" },
      log
    );

    const call = tokenCalls()[0];
    expect(call).toBeDefined();
    // The old access token must not ride along on the refresh hop: not in the
    // URL, not in the headers, not in the grant body.
    expect(call.url).not.toContain("at-old");
    expect(JSON.stringify(call.headers ?? {})).not.toContain("at-old");
    expect(JSON.stringify(call.headers ?? {}).toLowerCase()).not.toContain("authorization");
    const body = JSON.parse(call.body);
    expect(JSON.stringify(body)).not.toContain("at-old");
    expect(Object.keys(body).sort()).toEqual(["client_id", "grant_type", "refresh_token"]);
  }, 20000);
});
