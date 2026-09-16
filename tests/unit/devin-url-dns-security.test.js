/**
 * SEC-06 (Devin URL/DNS boundary) + DEV-01 security assertions — Wave 1 Stage 1a (W-C).
 *
 * TEST-ONLY wave: observable assertion failures on the locked policy (epic §2 P-DEVIN:
 * "private/loopback/mapped/decimal destinations rejected BEFORE credential send; redirects
 * re-validated") are CONFIRMED DEFECT receipts for Wave 2 Stage D (FIX-SEC-06), not fix
 * triggers here.
 *
 * Sources under test:
 *   - open-sse/utils/devinProtobuf.js  sanitizeCustomApiServerUrl (~L640-657)
 *   - open-sse/executors/devin.js      fetchUserJwt custom-server override (~L312-319),
 *                                      chat dispatch (~L136-182), redirect handling (~L167-176)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
  default: mocks.proxyAwareFetch,
}));

import zlib from "node:zlib";
import { DevinExecutor } from "open-sse/executors/devin.js";
import {
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_AUTH_PATH,
  DEVIN_CHAT_PATH,
  GetUserJwtResponseSchema,
  GetChatMessageRequestSchema,
  toBinary,
  fromBinary,
  buildConnectFrame,
  sanitizeCustomApiServerUrl,
} from "open-sse/utils/devinProtobuf.js";

// ==================== helpers (pattern: tests/unit/devin-executor.test.js) ====================

function createMockStream(chunks) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      } else {
        controller.close();
      }
    },
  });
}

function endStreamFrame(trailers = {}) {
  const payload = Buffer.from(JSON.stringify(trailers));
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 0x02;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

function chatStream(...dataFrames) {
  return Buffer.concat([...dataFrames, endStreamFrame()]);
}

// One recorder for the whole Devin edge: GetUserJwt / AssignModel / GetChatMessage.
function serveDevinEdge({ auth, chat } = {}) {
  const calls = [];
  mocks.proxyAwareFetch.mockImplementation(async (url, options, proxyOptions) => {
    const call = { url, options, proxyOptions };
    calls.push(call);
    if (url.includes(DEVIN_AUTH_PATH)) {
      return (
        auth?.() ??
        new Response(
          toBinary(GetUserJwtResponseSchema, { userJwt: "user-jwt-sec", customApiServerUrl: "" }),
          { status: 200, headers: { "content-type": "application/proto" } }
        )
      );
    }
    return (
      chat?.() ??
      new Response(createMockStream([chatStream()]), {
        status: 200,
        headers: { "content-type": "application/connect+proto" },
      })
    );
  });
  return calls;
}

function decodeChatRequest(call) {
  const framed = Buffer.from(call.options.body);
  const length = new DataView(framed.buffer, framed.byteOffset).getUint32(1, false);
  return fromBinary(GetChatMessageRequestSchema, zlib.gunzipSync(framed.subarray(5, 5 + length)));
}

function hostOf(call) {
  return new URL(call.url).host;
}

const CHAT_BODY = { messages: [{ role: "user", content: "hello" }] };

// ==================== SEC-06 URL: sanitizer unit boundary ====================

describe("SEC-06 sanitizeCustomApiServerUrl — URL/DNS boundary", () => {
  describe("rejected shapes (credentials must never reach these)", () => {
    it("rejects userinfo embedded in the URL", () => {
      expect(sanitizeCustomApiServerUrl("https://user:pass@evil.example.com/api")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://user@evil.example.com/api")).toBeNull();
    });

    it("rejects non-HTTPS schemes", () => {
      expect(sanitizeCustomApiServerUrl("http://evil.example.com")).toBeNull();
      expect(sanitizeCustomApiServerUrl("ftp://evil.example.com")).toBeNull();
      expect(sanitizeCustomApiServerUrl("javascript:alert(1)")).toBeNull();
      expect(sanitizeCustomApiServerUrl("file:///etc/passwd")).toBeNull();
    });

    it("rejects localhost and subdomain-localhost hostnames", () => {
      expect(sanitizeCustomApiServerUrl("https://localhost")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://localhost:8443")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://api.localhost")).toBeNull();
    });

    it("rejects loopback and every dotted-quad IPv4 literal (conservative IP ban)", () => {
      expect(sanitizeCustomApiServerUrl("https://127.0.0.1")).toBeNull();
      // Cloud metadata / RFC1918 / even public IPs: all numeric literals are banned.
      expect(sanitizeCustomApiServerUrl("https://169.254.169.254")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://10.1.2.3")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://192.168.0.1")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://8.8.8.8")).toBeNull();
    });

    it("rejects IPv6 literals including IPv4-mapped IPv6 (URL normalization applied)", () => {
      expect(sanitizeCustomApiServerUrl("https://[::1]")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://[::ffff:127.0.0.1]")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://[fe80::1]")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://[::ffff:a00:1]")).toBeNull();
    });

    it("rejects decimal/octal/hex/mixed non-canonical IPv4 encodings of loopback", () => {
      // WHATWG URL normalizes these to "127.0.0.1" before the literal check.
      expect(sanitizeCustomApiServerUrl("https://2130706433")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://0177.0.0.1")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://0x7f.1")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://127.1")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://0x7f000001")).toBeNull();
    });

    it("rejects junk inputs", () => {
      expect(sanitizeCustomApiServerUrl(null)).toBeNull();
      expect(sanitizeCustomApiServerUrl("")).toBeNull();
      expect(sanitizeCustomApiServerUrl("   ")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://")).toBeNull();
    });
  });

  describe("private DNS names — locked policy DEV-01: reject BEFORE credential send", () => {
    // Locked policy (plan §7.2 DEV-01): loopback/mapped/decimal AND private DNS names are
    // rejected. A DNS name is not an IP literal, so these need explicit suffix/known-host
    // handling; today's sanitizer has none — failure = confirmed defect for FIX-SEC-06.
    it("rejects cloud metadata and RFC 6762/8375 private DNS names", () => {
      expect(sanitizeCustomApiServerUrl("https://metadata.google.internal")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://svc.cluster.local")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://internal.corp")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://router.home.arpa")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://db.internal")).toBeNull();
    });
  });

  describe("policy-disallowed ports — locked policy DEV-01: HTTPS custom server on 443 only", () => {
    it("rejects explicit non-443 ports (SSRF port-scan surface)", () => {
      expect(sanitizeCustomApiServerUrl("https://api.example.com:8443")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://api.example.com:22")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://api.example.com:1337")).toBeNull();
    });
  });

  describe("accepted shape: valid public HTTPS custom URL", () => {
    it("accepts a public HTTPS host, preserving a path prefix and trimming trailing slashes", () => {
      expect(sanitizeCustomApiServerUrl("https://chat.example.com/api")).toBe(
        "https://chat.example.com/api"
      );
      expect(sanitizeCustomApiServerUrl("https://chat.example.com")).toBe("https://chat.example.com");
      expect(sanitizeCustomApiServerUrl("https://chat.example.com/")).toBe("https://chat.example.com");
      expect(sanitizeCustomApiServerUrl("https://chat.example.com/api/")).toBe(
        "https://chat.example.com/api"
      );
      expect(sanitizeCustomApiServerUrl("  https://chat.example.com/api  ")).toBe(
        "https://chat.example.com/api"
      );
    });

    it("accepts an explicit default port (normalized away)", () => {
      expect(sanitizeCustomApiServerUrl("https://chat.example.com:443/api")).toBe(
        "https://chat.example.com/api"
      );
    });
  });
});

// ==================== DEV-01: executor must never send credentials to a rejected destination ====================

describe("DEV-01 executor credential-before-send flow", () => {
  let executor;

  beforeEach(() => {
    process.env.DEVIN_HEDGE = "1"; // single-request flows
    executor = new DevinExecutor();
    mocks.proxyAwareFetch.mockReset();
  });

  afterEach(() => {
    delete process.env.DEVIN_HEDGE;
    vi.restoreAllMocks();
  });

  function authResponse(customApiServerUrl) {
    return new Response(
      toBinary(GetUserJwtResponseSchema, { userJwt: "user-jwt-sec", customApiServerUrl }),
      { status: 200, headers: { "content-type": "application/proto" } }
    );
  }

  it("rejected (userinfo) custom URL: chat stays on the default base, rejected host never contacted", async () => {
    const calls = serveDevinEdge({
      auth: () => authResponse("https://user:pass@evil.example.com"),
    });

    await executor.execute({
      model: "dv/swe-1-6",
      body: CHAT_BODY,
      credentials: { apiKey: "session-secret" },
    });

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.some((c) => hostOf(c).includes("evil.example.com"))).toBe(false);
    const chatCall = calls.find((c) => new URL(c.url).pathname === DEVIN_CHAT_PATH);
    expect(chatCall.url).toBe(`${DEVIN_DEFAULT_BASE_URL}${DEVIN_CHAT_PATH}`);
  });

  it("rejected (decimal/octal loopback) custom URL: default base used, loopback never contacted", async () => {
    const calls = serveDevinEdge({
      auth: () => authResponse("https://2130706433"),
    });

    await executor.execute({
      model: "dv/swe-1-6",
      body: CHAT_BODY,
      credentials: { apiKey: "session-secret" },
    });

    expect(calls.some((c) => hostOf(c) === "127.0.0.1" || hostOf(c) === "2130706433")).toBe(false);
    const chatCall = calls.find((c) => new URL(c.url).pathname === DEVIN_CHAT_PATH);
    expect(chatCall.url).toBe(`${DEVIN_DEFAULT_BASE_URL}${DEVIN_CHAT_PATH}`);
  });

  it("valid public HTTPS custom URL: usable end-to-end, credential delivered there (positive control)", async () => {
    const calls = serveDevinEdge({
      auth: () => authResponse("https://chat.example.com/api"),
    });

    await executor.execute({
      model: "dv/swe-1-6",
      body: CHAT_BODY,
      credentials: { apiKey: "session-secret" },
    });

    expect(calls[0].url).toBe(`${DEVIN_DEFAULT_BASE_URL}${DEVIN_AUTH_PATH}`);
    const chatCall = calls.find((c) => new URL(c.url).pathname.endsWith(DEVIN_CHAT_PATH));
    expect(chatCall.url).toBe("https://chat.example.com/api" + DEVIN_CHAT_PATH);
    const decoded = decodeChatRequest(chatCall);
    expect(decoded.metadata.userJwt).toBe("user-jwt-sec");
    // Exactly one credential-bearing chat request, to the sanctioned custom host.
    expect(calls.filter((c) => new URL(c.url).pathname.endsWith(DEVIN_CHAT_PATH))).toHaveLength(1);
  });

  it("(locked policy) private DNS custom URL is never contacted with credentials", async () => {
    const calls = serveDevinEdge({
      auth: () => authResponse("https://metadata.google.internal"),
    });

    await executor.execute({
      model: "dv/swe-1-6",
      body: CHAT_BODY,
      credentials: { apiKey: "session-secret" },
    });

    // P-DEVIN: private destinations rejected BEFORE credential send. The chat request
    // carries userJwt in its metadata — it must never be dispatched to a private DNS host.
    const privateCalls = calls.filter((c) => hostOf(c) === "metadata.google.internal");
    expect(privateCalls).toEqual([]);
    const chatCall = calls.find((c) => new URL(c.url).pathname === DEVIN_CHAT_PATH);
    expect(chatCall.url).toBe(`${DEVIN_DEFAULT_BASE_URL}${DEVIN_CHAT_PATH}`);
  });

  it("(locked policy) policy-disallowed port custom URL is never contacted with credentials", async () => {
    const calls = serveDevinEdge({
      auth: () => authResponse("https://api.example.com:8443"),
    });

    await executor.execute({
      model: "dv/swe-1-6",
      body: CHAT_BODY,
      credentials: { apiKey: "session-secret" },
    });

    const portCalls = calls.filter((c) => new URL(c.url).port === "8443");
    expect(portCalls).toEqual([]);
    const chatCall = calls.find((c) => new URL(c.url).pathname === DEVIN_CHAT_PATH);
    expect(chatCall.url).toBe(`${DEVIN_DEFAULT_BASE_URL}${DEVIN_CHAT_PATH}`);
  });

  it("3xx redirect at GetUserJwt: bounded terminal error, no credential ever dispatched to the target", async () => {
    const calls = serveDevinEdge({
      auth: () =>
        new Response("moved", {
          status: 302,
          headers: { location: "https://metadata.google.internal/exa.auth_pb.AuthService/GetUserJwt" },
        }),
    });

    await expect(
      executor.execute({
        model: "dv/swe-1-6",
        body: CHAT_BODY,
        credentials: { apiKey: "session-secret" },
      })
    ).rejects.toThrow(/302/);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${DEVIN_DEFAULT_BASE_URL}${DEVIN_AUTH_PATH}`);
    expect(calls.some((c) => hostOf(c) === "metadata.google.internal")).toBe(false);
  });

  it("3xx redirect at GetChatMessage: executor never re-dispatches to the redirect Location", async () => {
    const calls = serveDevinEdge({
      auth: () => authResponse(""),
      chat: () =>
        new Response("moved", {
          status: 302,
          headers: {
            location: "https://metadata.google.internal" + DEVIN_CHAT_PATH,
          },
        }),
    });

    await expect(
      executor.execute({
        model: "dv/swe-1-6",
        body: CHAT_BODY,
        credentials: { apiKey: "session-secret" },
      })
    ).rejects.toThrow(/302/);

    // Exactly one chat POST, to the sanctioned host — no re-dispatch to the Location.
    expect(calls.filter((c) => new URL(c.url).pathname === DEVIN_CHAT_PATH)).toHaveLength(1);
    expect(calls.some((c) => hostOf(c) === "metadata.google.internal")).toBe(false);
  });

  it("(locked policy) credential-bearing requests disable transport-level redirect auto-follow", async () => {
    // A compliant fetch transport (undici default: redirect:"follow") would auto-replay the
    // session-token/userJwt-bearing POST body to ANY redirect target before the executor
    // sees the 3xx. The executor must therefore opt out (redirect:"error"/"manual") or
    // re-validate the destination — observable at the transport boundary via request init.
    const calls = serveDevinEdge({
      auth: () => authResponse(""),
      chat: () =>
        new Response("moved", { status: 302, headers: { location: "https://metadata.google.internal" } }),
    });

    await executor
      .execute({
        model: "dv/swe-1-6",
        body: CHAT_BODY,
        credentials: { apiKey: "session-secret" },
      })
      .catch(() => {}); // bounded 302 error is acceptable; the assertion below is the contract

    const credentialCalls = calls.filter((c) =>
      [DEVIN_AUTH_PATH, DEVIN_CHAT_PATH].includes(new URL(c.url).pathname)
    );
    expect(credentialCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of credentialCalls) {
      expect(["error", "manual"]).toContain(call.options.redirect);
    }
  });
});
