/**
 * SEC-04 — Proxy URL & NO_PROXY validation (locked policy P-PROXY, plan §6/S4).
 *
 * Boundaries under test:
 *   1. open-sse/utils/proxyFetch.js — normalizeProxyUrl / resolveConnectionProxyUrl /
 *      proxyAwareFetch (NO_PROXY matching, strict vs non-strict egress).
 *   2. src/lib/network/proxyTest.js — testProxyUrl input boundary.
 *   3. src/app/api/proxy-pools/route.js — POST /api/proxy-pools create boundary.
 *   4. src/lib/network/outboundProxy.js — the only writer of proxy values into
 *      process.env (policy: hostile input is never written raw to env).
 *
 * Locked policy P-PROXY: schemes http|https|socks5 are valid; CR/LF/control chars,
 * file:, javascript:, unsupported schemes and malformed host/port must be rejected
 * or safely normalized at EVERY input boundary; hostile input is never written to
 * env; NO_PROXY exact-host / leading-dot-suffix match → direct egress, non-match →
 * proxy; strict mode invalid proxy config = hard fail before egress; non-strict
 * invalid proxy input is still rejected at the boundary, then falls back to direct.
 *
 * NOTE (plan §2.2): runtime normalization is expected to be LOOSER than this policy
 * at some boundaries (source gap). Where an assertion below fails on observable
 * behavior, that is a CONFIRMED DEFECT for FIX-SEC-04 — assertions are
 * intentionally NOT weakened to pass.
 *
 * Deterministic: all egress is mocked. Real undici ProxyAgent is kept (wrapped for
 * observation only) so scheme validation at the transport boundary stays real;
 * undici.fetch is replaced with a controllable mock, and globalThis.fetch is
 * stubbed BEFORE proxyFetch is imported (the module captures it as originalFetch).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

const h = vi.hoisted(() => ({
  /** uris handed to undici ProxyAgent by the code under test (observation only) */
  proxyAgentUris: [],
  /** (url, init) tuples received by the mocked undici fetch transport */
  undiciFetchCalls: [],
  undiciFetchImpl: () => new Response(null, { status: 200, statusText: "OK" }),
  /** proxy pools persisted through the mocked @/models repo */
  createdPools: [],
}));

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal();
  class InstrumentedProxyAgent extends actual.ProxyAgent {
    constructor(...args) {
      h.proxyAgentUris.push(args[0]?.uri ?? args[0]);
      super(...args);
    }
  }
  return {
    ...actual,
    ProxyAgent: InstrumentedProxyAgent,
    fetch: async (...args) => {
      h.undiciFetchCalls.push(args);
      return h.undiciFetchImpl(...args);
    },
  };
});

vi.mock("@/models", () => ({
  createProxyPool: async (pool) => {
    h.createdPools.push(pool);
    return { id: "pool-test-1", ...pool };
  },
  getProviderConnections: async () => [],
  getProxyPools: async () => [],
}));

const REAL_FETCH = globalThis.fetch;
const ENV_KEYS = [
  "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
  "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
  "NINE_ROUTER_PROXY_URL", "NINE_ROUTER_NO_PROXY", "NINE_ROUTER_PROXY_MANAGED",
];

let savedEnv;
let globalFetchMock;
let proxyFetch;
let outboundProxy;
let proxyPoolsRoute;

beforeAll(async () => {
  // Stub global fetch BEFORE importing proxyFetch — it captures globalThis.fetch
  // as its internal originalFetch at module evaluation time.
  globalFetchMock = vi.fn(async () => new Response("direct-egress", { status: 200 }));
  globalThis.fetch = globalFetchMock;
  proxyFetch = await import("open-sse/utils/proxyFetch.js");
  outboundProxy = await import("@/lib/network/outboundProxy.js");
  proxyPoolsRoute = await import("@/app/api/proxy-pools/route.js");
});

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  h.proxyAgentUris.length = 0;
  h.undiciFetchCalls.length = 0;
  h.createdPools.length = 0;
  h.undiciFetchImpl = () => new Response(null, { status: 200, statusText: "OK" });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterAll(() => {
  globalThis.fetch = REAL_FETCH;
});

const VALID_PROXIES = [
  "http://192.0.2.10:8080",
  "https://192.0.2.10:8443",
  "socks5://192.0.2.10:1080",
];
// P-PROXY allowlist: http | https | socks5. Everything else is unsupported.
const HOSTILE_SCHEMES = [
  "javascript:alert(1)",
  "file:///etc/passwd",
  "gopher://192.0.2.10:70",
];
const CRLF_PAYLOAD = "http://192.0.2.10:7890\r\nX-Injected: 1";
const NUL_PAYLOAD = "http://192.0.2.10:7890\u0000";
const lastGlobalCall = () => globalFetchMock.mock.calls.at(-1);
const hadDispatcher = (call) => Boolean(call?.[1]?.dispatcher);

function postProxyPool(body) {
  return proxyPoolsRoute.POST(
    new Request("http://localhost/api/proxy-pools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("SEC-04 · proxyTest boundary (src/lib/network/proxyTest.js)", () => {
  it("SEC-04: valid http/https/socks5 proxies are accepted and used for the test request", async () => {
    const { testProxyUrl } = await import("@/lib/network/proxyTest.js");
    for (const proxyUrl of VALID_PROXIES) {
      const res = await testProxyUrl({ proxyUrl, testUrl: "https://example.com/", timeoutMs: 1000 });
      expect(res.ok, `${proxyUrl} should test OK`).toBe(true);
      expect(res.status).toBe(200);
      const calls = h.undiciFetchCalls.filter(([, init]) => init?.dispatcher != null);
      expect(calls.length, `${proxyUrl} must egress through a proxy dispatcher`).toBeGreaterThan(0);
    }
  });

  it("SEC-04: hostile proxy inputs are rejected with 4xx before any transport egress", async () => {
    const { testProxyUrl } = await import("@/lib/network/proxyTest.js");
    const hostile = [
      ...HOSTILE_SCHEMES,
      CRLF_PAYLOAD,
      "socks4://192.0.2.10:1080",
      "socks5h://192.0.2.10:1080",
      "localhost:7890",       // opaque scheme, not http/https/socks5
      "127.0.0.1:7890",       // bare host:port is not a valid proxy URL here
    ];
    const offenders = [];
    for (const proxyUrl of hostile) {
      const before = h.undiciFetchCalls.length;
      const res = await testProxyUrl({ proxyUrl, testUrl: "https://example.com/", timeoutMs: 1000 });
      const bad =
        res.ok !== false ||
        res.status < 400 ||
        res.status >= 500 ||
        h.undiciFetchCalls.length !== before;
      if (bad) offenders.push({ proxyUrl, status: res.status, ok: res.ok });
    }
    expect(offenders, "P-PROXY: unsupported schemes / control chars / malformed host:port must be rejected 4xx at the proxyTest boundary, never reaching the transport").toEqual([]);
  });

  it("SEC-04 [DEFECT PROBE]: NUL-carrying proxyUrl must not hand control characters to the transport", async () => {
    // P-PROXY: control chars → rejected or safely normalized AT the boundary.
    const { testProxyUrl } = await import("@/lib/network/proxyTest.js");
    // Acceptance is only compliant if the value handed to the transport is clean.
    const res = await testProxyUrl({ proxyUrl: NUL_PAYLOAD, testUrl: "https://example.com/", timeoutMs: 1000 });
    // Compliant outcomes: rejected at the boundary (no dispatcher at all) OR
    // handed to the transport as a clean, control-char-free uri.
    const lastUri = h.proxyAgentUris.at(-1);
    const boundaryClean = lastUri === undefined || !/[\u0000-\u001f\u007f]/.test(String(lastUri));
    expect(boundaryClean, "NUL-carrying proxyUrl must be rejected at the boundary (no dispatcher) or normalized clean before the transport").toBe(true);
    expect(res.ok === false || res.status < 400, "response must be a defined rejection or success, never a transport leak").toBe(true);
  });

  it("SEC-04: missing proxyUrl is rejected", async () => {
    const { testProxyUrl } = await import("@/lib/network/proxyTest.js");
    const res = await testProxyUrl({});
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
  });
});

describe("SEC-04 · proxyFetch boundary (open-sse/utils/proxyFetch.js)", () => {
  it("SEC-04: valid http/https/socks5 connection proxies construct a dispatcher with the exact uri", async () => {
    for (const proxyUrl of VALID_PROXIES) {
      h.proxyAgentUris.length = 0;
      const res = await proxyFetch.proxyAwareFetch("https://target.example/v1", {}, {
        enabled: true,
        url: proxyUrl,
      });
      expect(res.status).toBe(200);
      expect(h.proxyAgentUris, `${proxyUrl} must be handed to the transport verbatim`).toContain(proxyUrl);
      expect(hadDispatcher(lastGlobalCall()), `${proxyUrl} must egress via proxy`).toBe(true);
    }
  });

  it("SEC-04: NO_PROXY exact-host match egresses directly despite configured proxy", async () => {
    process.env.HTTPS_PROXY = "http://192.0.2.10:8080";
    process.env.NO_PROXY = "example.com";
    await proxyFetch.proxyAwareFetch("https://example.com/api/v1");
    expect(hadDispatcher(lastGlobalCall()), "exact-host NO_PROXY match must bypass the proxy").toBe(false);
  });

  it("SEC-04: NO_PROXY leading-dot suffix matches subdomains and the apex host", async () => {
    process.env.HTTPS_PROXY = "http://192.0.2.10:8080";
    process.env.NO_PROXY = ".example.com";
    await proxyFetch.proxyAwareFetch("https://api.example.com/v1");
    expect(hadDispatcher(lastGlobalCall()), "leading-dot pattern must bypass subdomain").toBe(false);
    await proxyFetch.proxyAwareFetch("https://example.com/");
    expect(hadDispatcher(lastGlobalCall()), "leading-dot pattern must bypass apex host").toBe(false);
  });

  it("SEC-04: NO_PROXY non-match keeps the proxy (no ambiguous suffix bypass)", async () => {
    process.env.HTTPS_PROXY = "http://192.0.2.10:8081"; // fresh uri: dispatcher not yet cached
    process.env.NO_PROXY = "example.com";
    await proxyFetch.proxyAwareFetch("https://notexample.com/v1");
    expect(hadDispatcher(lastGlobalCall()), "notexample.com must NOT bypass via example.com pattern").toBe(true);
    expect(h.proxyAgentUris).toContain("http://192.0.2.10:8081");
  });

  it("SEC-04: NO_PROXY '*' bypasses the proxy for all hosts", async () => {
    process.env.HTTPS_PROXY = "http://192.0.2.10:8080";
    process.env.NO_PROXY = "*";
    await proxyFetch.proxyAwareFetch("https://anything.example.net/v1");
    expect(hadDispatcher(lastGlobalCall())).toBe(false);
  });

  it("SEC-04: connection-level NO_PROXY match resolves to direct egress", async () => {
    await proxyFetch.proxyAwareFetch("https://api.example.com/v1", {}, {
      enabled: true,
      url: "http://192.0.2.10:8080",
      noProxy: ".example.com",
    });
    expect(hadDispatcher(lastGlobalCall()), "connection NO_PROXY match must bypass proxy").toBe(false);
  });

  it("SEC-04 [DEFECT PROBE]: control characters must be rejected or safely normalized before transport", async () => {
    // P-PROXY: CR/LF/control chars → rejected or safely normalized at the input
    // boundary. The value handed to the transport must never carry them raw.
    const offenders = [];
    for (const proxyUrl of [CRLF_PAYLOAD, NUL_PAYLOAD]) {
      h.proxyAgentUris.length = 0;
      await proxyFetch.proxyAwareFetch("https://target.example/v1", {}, { enabled: true, url: proxyUrl });
      if (h.proxyAgentUris.some((u) => /[\r\n\u0000]/.test(String(u)))) offenders.push(proxyUrl);
    }
    expect(offenders, "P-PROXY: control-char-carrying proxy URLs must be rejected or safely normalized at the boundary, never handed raw to the transport (normalizeProxyUrl)").toEqual([]);
  });

  it("SEC-04 [DEFECT PROBE]: unsupported schemes must be rejected at the boundary, not handed to the transport", async () => {
    const offenders = [];
    for (const proxyUrl of HOSTILE_SCHEMES) {
      h.proxyAgentUris.length = 0;
      await proxyFetch.proxyAwareFetch("https://target.example/v1", {}, { enabled: true, url: proxyUrl });
      const scheme = proxyUrl.split(":")[0];
      if (h.proxyAgentUris.some((u) => String(u).startsWith(`${scheme}:`))) offenders.push(proxyUrl);
    }
    expect(offenders, "P-PROXY: only http|https|socks5 are valid proxy schemes; unsupported schemes must be rejected at the input boundary (normalizeProxyUrl)").toEqual([]);
  });

  it("SEC-04: non-strict mode falls back to direct egress when the proxy transport fails", async () => {
    h.undiciFetchImpl = () => new Response(null, { status: 200 }); // unused; failure injected below
    globalFetchMock.mockImplementationOnce(async (_url, init) => {
      if (init?.dispatcher) throw new Error("proxy unreachable");
      return new Response("direct-egress", { status: 200 });
    });
    const res = await proxyFetch.proxyAwareFetch("https://target.example/v1", {}, {
      enabled: true,
      url: "http://192.0.2.10:9", // valid scheme, dead proxy
    });
    expect(res.status).toBe(200);
    expect(hadDispatcher(lastGlobalCall()), "fallback must be direct egress").toBe(false);
  });

  it("SEC-04: strict mode hard-fails when the proxy transport fails, before any direct egress", async () => {
    globalFetchMock.mockClear();
    globalFetchMock.mockImplementation(async (_url, init) => {
      if (init?.dispatcher) throw new Error("proxy unreachable");
      return new Response("direct-egress", { status: 200 });
    });
    await expect(
      proxyFetch.proxyAwareFetch("https://target.example/v1", {}, {
        enabled: true,
        url: "http://192.0.2.10:9",
        strictProxy: true,
      })
    ).rejects.toThrow(/strictProxy=true/);
    const directCalls = globalFetchMock.mock.calls.filter(([, init]) => !init?.dispatcher);
    expect(directCalls, "strict mode must not fall back to direct egress").toEqual([]);
  });

  it("SEC-04: strict mode with hostile proxy config hard-fails before egress", async () => {
    globalFetchMock.mockClear();
    await expect(
      proxyFetch.proxyAwareFetch("https://target.example/v1", {}, {
        enabled: true,
        url: "javascript:alert(1)",
        strictProxy: true,
      })
    ).rejects.toThrow(/strictProxy=true/);
    expect(globalFetchMock.mock.calls.length).toBe(0);
  });
});

describe("SEC-04 · hostile proxy input never reaches process.env", () => {
  it("SEC-04: env writer rejects unsupported schemes, CR/LF and shell metacharacters", async () => {
    const hostile = [
      ...HOSTILE_SCHEMES,
      CRLF_PAYLOAD,
      "socks4://192.0.2.10:1080",
      "socks4a://192.0.2.10:1080",
      "socks5h://192.0.2.10:1080",
      "http://192.0.2.10:8080/`id`",
      "http://192.0.2.10:8080/$HOME",
    ];
    const offenders = [];
    for (const url of hostile) {
      outboundProxy.applyOutboundProxyEnv({
        outboundProxyEnabled: true,
        outboundProxyUrl: url,
        outboundNoProxy: "",
      });
      const written =
        process.env.HTTP_PROXY !== undefined ||
        process.env.HTTPS_PROXY !== undefined ||
        process.env.ALL_PROXY !== undefined ||
        process.env.NINE_ROUTER_PROXY_URL !== undefined ||
        process.env.NINE_ROUTER_PROXY_MANAGED !== undefined;
      if (written) {
        offenders.push({ url, http_proxy: process.env.HTTP_PROXY });
        outboundProxy.applyOutboundProxyEnv({ outboundProxyEnabled: false });
      }
    }
    expect(offenders, "P-PROXY: hostile proxy input must never be written to process.env (outboundProxy env writer)").toEqual([]);
  });

  it("SEC-04: valid proxy URL is written to env in normalized form", async () => {
    outboundProxy.applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://192.0.2.10:8080",
      outboundNoProxy: "",
    });
    expect(process.env.HTTP_PROXY).toBe("http://192.0.2.10:8080/");
    expect(process.env.NINE_ROUTER_PROXY_MANAGED).toBe("1");
  });

  it("SEC-04: NUL-carrying proxy input is safely normalized before reaching env", async () => {
    // Trailing NUL is stripped by WHATWG URL parsing, so a clean href is the
    // compliant "safely normalized" outcome for the env boundary.
    outboundProxy.applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: NUL_PAYLOAD,
      outboundNoProxy: "",
    });
    expect(process.env.HTTP_PROXY).toBe("http://192.0.2.10:7890/");
    expect(process.env.HTTP_PROXY).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("SEC-04: disabling the outbound proxy clears previously managed env vars", async () => {
    outboundProxy.applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://192.0.2.10:8080",
      outboundNoProxy: "",
    });
    expect(process.env.HTTP_PROXY).toBeDefined();
    outboundProxy.applyOutboundProxyEnv({ outboundProxyEnabled: false });
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.NINE_ROUTER_PROXY_MANAGED).toBeUndefined();
  });
});

describe("SEC-04 · proxy-pools route boundary (POST /api/proxy-pools)", () => {
  it("SEC-04: valid http/https/socks5 pools are accepted (201) and persisted verbatim", async () => {
    for (const proxyUrl of VALID_PROXIES) {
      const res = await postProxyPool({ name: `pool-${proxyUrl.split(":")[0]}`, proxyUrl, type: "http" });
      expect(res.status, `${proxyUrl} must be accepted`).toBe(201);
      const body = await res.json();
      expect(body.proxyPool.proxyUrl).toBe(proxyUrl);
    }
    expect(h.createdPools).toHaveLength(VALID_PROXIES.length);
  });

  it("SEC-04 [DEFECT PROBE]: hostile proxyUrl payloads must be rejected (4xx) and never persisted", async () => {
    const hostile = [...HOSTILE_SCHEMES, CRLF_PAYLOAD, NUL_PAYLOAD];
    const offenders = [];
    for (const proxyUrl of hostile) {
      h.createdPools.length = 0;
      const res = await postProxyPool({ name: "hostile-pool", proxyUrl, type: "http" });
      const bad = res.status < 400 || res.status >= 500 || h.createdPools.length > 0;
      if (bad) offenders.push({ proxyUrl, status: res.status, persisted: h.createdPools.length });
    }
    expect(offenders, "P-PROXY: hostile proxyUrl payloads must be rejected 4xx at the route boundary and never persisted (normalizeProxyPoolInput only checks non-empty)").toEqual([]);
  });

  it("SEC-04: missing name or missing proxyUrl is rejected (400)", async () => {
    const noName = await postProxyPool({ name: "", proxyUrl: "http://192.0.2.10:8080", type: "http" });
    expect(noName.status).toBe(400);
    const noUrl = await postProxyPool({ name: "pool", proxyUrl: "", type: "http" });
    expect(noUrl.status).toBe(400);
  });

  it("SEC-04: non-string proxyUrl is rejected (400)", async () => {
    for (const proxyUrl of [123, null, { url: "http://192.0.2.10:8080" }]) {
      const res = await postProxyPool({ name: "pool", proxyUrl, type: "http" });
      expect(res.status, `non-string proxyUrl ${String(proxyUrl)} must be rejected`).toBe(400);
    }
  });
});
