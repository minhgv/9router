import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// Video Providers Refresh Egress Policy (xAI, grok-cli, gcli, Vertex, OpenRouter)
//
// Verifies connection-proxy policy propagation from credentials to refresh egress
// end-to-end for video providers (xAI OAuth discovery + token POST, Vertex SA mint,
// and generic refreshAccessToken).
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

vi.mock("jose", () => ({
  importPKCS8: vi.fn(async () => "fake-pkcs8-key"),
  SignJWT: class {
    setProtectedHeader() { return this; }
    setIssuer() { return this; }
    setAudience() { return this; }
    setIssuedAt() { return this; }
    setExpirationTime() { return this; }
    async sign() { return "fake-signed-jwt-assertion"; }
  },
}));

const CONN_PROXY_URL = "http://127.0.0.1:8888";
const OVERRIDE_PROXY_URL = "http://127.0.0.1:9999";
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
  if (url.includes(".well-known/openid-configuration")) {
    return jsonResponse({
      authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
      token_endpoint: "https://auth.x.ai/oauth2/token",
    });
  }
  if (url.includes("oauth2.googleapis.com/token")) {
    return jsonResponse({
      access_token: "vertex-at-new",
      expires_in: 3600,
    });
  }
  return jsonResponse({
    access_token: "at-default-ok",
    refresh_token: "rt-default-ok",
    id_token: "header.payload.signature",
    expires_in: 3600,
  });
});

let seq = 0;
const uniqueRefreshToken = () => `rt-video-${++seq}-${Date.now()}`;
const uniqueSaEmail = () => `sa-video-${++seq}-${Date.now()}@test-project.iam.gserviceaccount.com`;

function makeSaJson(email = uniqueSaEmail()) {
  return JSON.stringify({
    type: "service_account",
    project_id: "test-project",
    private_key_id: "key-123",
    private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3\n-----END PRIVATE KEY-----\n",
    client_email: email,
    client_id: "client-123",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

function strictCredentials(extra = {}) {
  return {
    accessToken: "at-old",
    providerSpecificData: {
      connectionProxyEnabled: true,
      connectionProxyUrl: CONN_PROXY_URL,
      strictProxy: true,
      connectionNoProxy: "",
      vercelRelayUrl: "",
    },
    ...extra,
  };
}

function disabledProxyCredentials(extra = {}) {
  return {
    accessToken: "at-old",
    providerSpecificData: {
      connectionProxyEnabled: false,
      connectionProxyUrl: CONN_PROXY_URL,
      strictProxy: false,
    },
    ...extra,
  };
}

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
  };
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

describe("Video providers refresh egress proxy policy", () => {
  let refreshTokenByProvider;
  let refreshVertexToken;
  let refreshXaiToken;
  let refreshAccessToken;
  let resetDiscoveryCache;

  beforeEach(async () => {
    vi.resetModules();
    const tokenRefreshMod = await import("../../open-sse/services/tokenRefresh.js");
    refreshTokenByProvider = tokenRefreshMod.refreshTokenByProvider;
    refreshVertexToken = tokenRefreshMod.refreshVertexToken;
    const providersMod = await import("../../open-sse/services/tokenRefresh/providers.js");
    refreshXaiToken = providersMod.refreshXaiToken;
    refreshAccessToken = providersMod.refreshAccessToken;
    const xaiMod = await import("../../src/lib/oauth/services/xai.js");
    resetDiscoveryCache = xaiMod.resetDiscoveryCache;
    resetDiscoveryCache();
  });

  describe("xAI / grok-cli / gcli refresh egress", () => {
    it("derives proxy policy from strict credentials in videoCore caller shape (no explicit proxyOptions)", async () => {
      const refreshToken = uniqueRefreshToken();
      const credentials = strictCredentials({ refreshToken });

      const result = await refreshTokenByProvider("xai", credentials, log);

      expect(result).toBeDefined();
      expect(result.accessToken).toBe("at-default-ok");

      // Both discovery and token POST egress must route through connection proxy
      const discoveryCall = egress.find((c) => c.url.includes(".well-known/openid-configuration"));
      expect(discoveryCall).toBeDefined();
      expect(dispatcherUri(discoveryCall)).toBe(CONN_PROXY_URL);

      const tokenCall = egress.find((c) => c.url.includes("/oauth2/token"));
      expect(tokenCall).toBeDefined();
      expect(tokenCall.method).toBe("POST");
      expect(dispatcherUri(tokenCall)).toBe(CONN_PROXY_URL);
    });

    it("grok-cli routes token refresh through derived connection proxy", async () => {
      const refreshToken = uniqueRefreshToken();
      const credentials = strictCredentials({ refreshToken });

      const result = await refreshTokenByProvider("grok-cli", credentials, log);

      expect(result).toBeDefined();
      expect(result.accessToken).toBe("at-default-ok");

      const tokenCall = egress.find((c) => c.url.includes("/oauth2/token"));
      expect(tokenCall).toBeDefined();
      expect(dispatcherUri(tokenCall)).toBe(CONN_PROXY_URL);
    });

    it("gcli routes token refresh through derived connection proxy", async () => {
      const refreshToken = uniqueRefreshToken();
      const credentials = strictCredentials({ refreshToken });

      const result = await refreshTokenByProvider("gcli", credentials, log);

      expect(result).toBeDefined();
      expect(result.accessToken).toBe("at-default-ok");

      const tokenCall = egress.find((c) => c.url.includes("/oauth2/token"));
      expect(tokenCall).toBeDefined();
      expect(dispatcherUri(tokenCall)).toBe(CONN_PROXY_URL);
    });

    it("explicit proxyOptions argument overrides derived credentials proxy", async () => {
      const refreshToken = uniqueRefreshToken();
      const credentials = strictCredentials({ refreshToken });
      const overrideOptions = {
        connectionProxyEnabled: true,
        connectionProxyUrl: OVERRIDE_PROXY_URL,
        strictProxy: true,
      };

      const result = await refreshTokenByProvider("xai", credentials, log, overrideOptions);

      expect(result).toBeDefined();
      const tokenCall = egress.find((c) => c.url.includes("/oauth2/token"));
      expect(tokenCall).toBeDefined();
      expect(dispatcherUri(tokenCall)).toBe(OVERRIDE_PROXY_URL);
    });

    it("disabled connection proxy routes egress direct (no dispatcher)", async () => {
      const refreshToken = uniqueRefreshToken();
      const credentials = disabledProxyCredentials({ refreshToken });

      const result = await refreshTokenByProvider("xai", credentials, log);

      expect(result).toBeDefined();
      const tokenCall = egress.find((c) => c.url.includes("/oauth2/token"));
      expect(tokenCall).toBeDefined();
      expect(dispatcherUri(tokenCall)).toBeNull();
    });

    it("direct refreshXaiToken forwards proxyOptions", async () => {
      const refreshToken = uniqueRefreshToken();
      const proxyOpts = {
        connectionProxyEnabled: true,
        connectionProxyUrl: CONN_PROXY_URL,
        strictProxy: true,
      };

      const result = await refreshXaiToken(refreshToken, log, proxyOpts);

      expect(result).toBeDefined();
      const tokenCall = egress.find((c) => c.url.includes("/oauth2/token"));
      expect(tokenCall).toBeDefined();
      expect(dispatcherUri(tokenCall)).toBe(CONN_PROXY_URL);
    });
  });

  describe("Vertex AI / vertex-partner refresh egress", () => {
    it("derives proxy policy from strict credentials with SA JSON apiKey (no explicit proxyOptions)", async () => {
      const saJson = makeSaJson();
      const credentials = strictCredentials({ apiKey: saJson });

      const result = await refreshTokenByProvider("vertex", credentials, log);

      expect(result).toBeDefined();
      expect(result.accessToken).toBe("vertex-at-new");

      const mintCall = egress.find((c) => c.url.includes("oauth2.googleapis.com/token"));
      expect(mintCall).toBeDefined();
      expect(mintCall.method).toBe("POST");
      expect(dispatcherUri(mintCall)).toBe(CONN_PROXY_URL);
    });

    it("vertex-partner routes mint egress through derived connection proxy", async () => {
      const saJson = makeSaJson();
      const credentials = strictCredentials({ apiKey: saJson });

      const result = await refreshTokenByProvider("vertex-partner", credentials, log);

      expect(result).toBeDefined();
      expect(result.accessToken).toBe("vertex-at-new");

      const mintCall = egress.find((c) => c.url.includes("oauth2.googleapis.com/token"));
      expect(mintCall).toBeDefined();
      expect(dispatcherUri(mintCall)).toBe(CONN_PROXY_URL);
    });

    it("explicit proxyOptions argument overrides derived credentials proxy for vertex", async () => {
      const saJson = makeSaJson();
      const credentials = strictCredentials({ apiKey: saJson });
      const overrideOptions = {
        connectionProxyEnabled: true,
        connectionProxyUrl: OVERRIDE_PROXY_URL,
        strictProxy: true,
      };

      const result = await refreshTokenByProvider("vertex", credentials, log, overrideOptions);

      expect(result).toBeDefined();
      const mintCall = egress.find((c) => c.url.includes("oauth2.googleapis.com/token"));
      expect(mintCall).toBeDefined();
      expect(dispatcherUri(mintCall)).toBe(OVERRIDE_PROXY_URL);
    });

    it("disabled connection proxy routes vertex mint egress direct (no dispatcher)", async () => {
      const saJson = makeSaJson();
      const credentials = disabledProxyCredentials({ apiKey: saJson });

      const result = await refreshTokenByProvider("vertex", credentials, log);

      expect(result).toBeDefined();
      const mintCall = egress.find((c) => c.url.includes("oauth2.googleapis.com/token"));
      expect(mintCall).toBeDefined();
      expect(dispatcherUri(mintCall)).toBeNull();
    });

    it("direct refreshVertexToken forwards proxyOptions", async () => {
      const saObj = JSON.parse(makeSaJson());
      const proxyOpts = {
        connectionProxyEnabled: true,
        connectionProxyUrl: CONN_PROXY_URL,
        strictProxy: true,
      };

      const result = await refreshVertexToken(saObj, log, proxyOpts);

      expect(result).toBeDefined();
      expect(result.accessToken).toBe("vertex-at-new");
      const mintCall = egress.find((c) => c.url.includes("oauth2.googleapis.com/token"));
      expect(mintCall).toBeDefined();
      expect(dispatcherUri(mintCall)).toBe(CONN_PROXY_URL);
    });
  });

  describe("Generic refreshAccessToken egress (generic path)", () => {
    beforeEach(async () => {
      const { PROVIDERS } = await import("../../open-sse/config/providers.js");
      PROVIDERS["test-generic"] = {
        refreshUrl: "https://auth.example.com/oauth/token",
        clientId: "client-123",
      };
    });

    it("generic provider routes token refresh through derived connection proxy", async () => {
      const refreshToken = uniqueRefreshToken();
      const credentials = strictCredentials({ refreshToken });

      const result = await refreshTokenByProvider("test-generic", credentials, log);

      expect(result).toBeDefined();
      expect(result.accessToken).toBe("at-default-ok");
      const tokenCall = egress.find((c) => c.url.includes("auth.example.com") || c.method === "POST");
      expect(tokenCall).toBeDefined();
      expect(dispatcherUri(tokenCall)).toBe(CONN_PROXY_URL);
    });

    it("direct refreshAccessToken forwards proxyOptions", async () => {
      const refreshToken = uniqueRefreshToken();
      const credentials = strictCredentials({ refreshToken });
      const proxyOpts = {
        connectionProxyEnabled: true,
        connectionProxyUrl: CONN_PROXY_URL,
        strictProxy: true,
      };

      const result = await refreshAccessToken("test-generic", refreshToken, credentials, log, proxyOpts);

      expect(result).toBeDefined();
      expect(result.accessToken).toBe("at-default-ok");
      const tokenCall = egress.find((c) => c.url.includes("auth.example.com") || c.method === "POST");
      expect(tokenCall).toBeDefined();
      expect(dispatcherUri(tokenCall)).toBe(CONN_PROXY_URL);
    });
  });
});
