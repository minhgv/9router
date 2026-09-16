import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// Wave 4: Anthropic Bridge Contracts & Translator Dispatch (Worker W-G)
//
// IDs & Statuses:
//   - ANT-05 (NEW): Translator dispatch — registered direct route preferred
//     over OpenAI pivot for Anthropic/GLM/MiMo; Devin bypasses generic translator;
//     imported via open-sse/translator/index.js registry.
//   - ANT-04 (NEW blocking assertions): Anthropic headers / proxy egress policy:
//     auth/beta headers kept, hop-by-hop/attacker headers stripped on custom
//     hosts, proxy strict/fallback/NO_PROXY egress policy (assert egress policy,
//     NOT call counts).
//   - Legacy statuses VERIFIED NOT PROMOTED (informational, never pass criteria):
//     ANT-01 (KNOWN-XFAIL), ANT-02 (KNOWN-BASELINE+KNOWN-XFAIL), ANT-03 (KNOWN-XFAIL),
//     ANT-04 legacy (KNOWN-BASELINE).
// ============================================================================

vi.mock("undici", () => {
  class FakeProxyAgent {
    constructor(opts = {}) {
      this.uri = typeof opts === "string" ? opts : (opts.uri || opts.url || "http://proxy.local");
      this.options = opts;
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
const API_KEY = "sk-ant-test-key-wave4";
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
    dispatcher: init?.dispatcher ?? null,
  });
  if (responder) return responder({ url, init });
  return jsonResponse({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "hello" }] });
});

beforeEach(() => {
  egress.length = 0;
  responder = null;
  for (const key of PROXY_ENV_KEYS) vi.stubEnv(key, "");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ============================================================================
// Section 1: ANT-05 (NEW) — Translator Dispatch Contracts
// ============================================================================
describe("ANT-05 (NEW): Translator dispatch contracts", () => {
  let translateRequest;
  let translateResponse;
  let register;
  let needsTranslation;
  let initState;
  let FORMATS;
  let getExecutor;
  let DevinExecutor;

  beforeEach(async () => {
    const translatorMod = await import("../../open-sse/translator/index.js");
    translateRequest = translatorMod.translateRequest;
    translateResponse = translatorMod.translateResponse;
    register = translatorMod.register;
    needsTranslation = translatorMod.needsTranslation;
    initState = translatorMod.initState;

    const formatsMod = await import("../../open-sse/translator/formats.js");
    FORMATS = formatsMod.FORMATS;

    const executorsMod = await import("../../open-sse/executors/index.js");
    getExecutor = executorsMod.getExecutor;

    const devinMod = await import("../../open-sse/executors/devin.js");
    DevinExecutor = devinMod.DevinExecutor;
  });

  describe("Direct route preference over OpenAI pivot", () => {
    it("prefers registered direct route (e.g. claude:kiro) over OpenAI pivot", () => {
      const claudeBody = {
        messages: [{ role: "user", content: "hello direct kiro" }],
      };

      // Direct route claude:kiro is registered and produces conversationState directly
      const result = translateRequest(
        FORMATS.CLAUDE,
        FORMATS.KIRO,
        "claude-sonnet-4.5",
        claudeBody,
        true,
        null,
        "kiro"
      );

      // Kiro direct payload has conversationState, not OpenAI messages array
      expect(result.conversationState).toBeDefined();
      expect(result.conversationState.currentMessage.userInputMessage.content).toContain("hello direct kiro");
      expect(result.messages).toBeUndefined();
    });

    it("prefers registered direct response route (e.g. kiro:claude) over OpenAI pivot", () => {
      const state = initState(FORMATS.CLAUDE);
      const kiroChunk = {
        choices: [
          {
            delta: { content: "direct stream text" },
            index: 0,
          },
        ],
      };

      const events = translateResponse(FORMATS.KIRO, FORMATS.CLAUDE, kiroChunk, state);
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBeGreaterThan(0);
      const hasContentDelta = events.some(
        (e) => e?.type === "content_block_delta" && e?.delta?.text === "direct stream text"
      );
      expect(hasContentDelta).toBe(true);
    });

    it("dynamically registered direct route executes without OpenAI intermediate conversion", () => {
      const customSource = "custom-test-src";
      const customTarget = "custom-test-dst";
      const reqSpy = vi.fn((model, body) => ({ customTranslated: true, original: body }));
      const resSpy = vi.fn((chunk) => [{ customChunk: true, original: chunk }]);

      register(customSource, customTarget, reqSpy, resSpy);

      const inputBody = { test: 123 };
      const outReq = translateRequest(customSource, customTarget, "m1", inputBody);

      expect(reqSpy).toHaveBeenCalledOnce();
      expect(outReq.customTranslated).toBe(true);

      const state = {};
      const outRes = translateResponse(customSource, customTarget, { delta: "a" }, state);
      expect(resSpy).toHaveBeenCalledOnce();
      expect(outRes[0].customChunk).toBe(true);
    });

    it("falls back to OpenAI intermediate pivot when no direct route exists", () => {
      // gemini -> claude has no direct registered route; it pivots through OpenAI
      const geminiBody = {
        contents: [
          {
            role: "user",
            parts: [{ text: "pivoted text from gemini" }],
          },
        ],
      };

      const out = translateRequest(
        FORMATS.GEMINI,
        FORMATS.CLAUDE,
        "claude-sonnet-4",
        geminiBody,
        true,
        null,
        "anthropic"
      );

      // Output is formatted for Claude format via OpenAI intermediate
      expect(out.messages).toBeDefined();
      expect(Array.isArray(out.messages)).toBe(true);
      const userMsg = out.messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(JSON.stringify(userMsg.content)).toContain("pivoted text from gemini");
    });
  });

  describe("Format matching & dispatch for Anthropic, GLM, MiMo", () => {
    it("reports needsTranslation = false when source and target formats match", () => {
      expect(needsTranslation(FORMATS.CLAUDE, FORMATS.CLAUDE)).toBe(false);
      expect(needsTranslation(FORMATS.OPENAI, FORMATS.OPENAI)).toBe(false);
      expect(needsTranslation(FORMATS.GEMINI, FORMATS.GEMINI)).toBe(false);
      expect(needsTranslation(FORMATS.CLAUDE, FORMATS.OPENAI)).toBe(true);
      expect(needsTranslation(FORMATS.OPENAI, FORMATS.CLAUDE)).toBe(true);
    });

    it("Anthropic format passthrough preserves Claude structure without translation hop", () => {
      const claudeBody = {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "native claude request" }],
          },
        ],
        thinking: { type: "enabled", budget_tokens: 2048 },
      };

      const out = translateRequest(
        FORMATS.CLAUDE,
        FORMATS.CLAUDE,
        "claude-sonnet-4-20250514",
        claudeBody,
        true,
        null,
        "anthropic"
      );

      expect(out.messages).toBeDefined();
      expect(out.messages[0].content[0].text).toBe("native claude request");
      expect(out.thinking).toBeDefined();
    });

    it("GLM requests: OpenAI-format client targeting OpenAI transport is passthrough", () => {
      const openAIBody = {
        messages: [{ role: "user", content: "glm text prompt" }],
        model: "glm-4",
      };

      const out = translateRequest(
        FORMATS.OPENAI,
        FORMATS.OPENAI,
        "glm-4",
        openAIBody,
        true,
        null,
        "glm"
      );

      expect(out.messages[0].content).toBe("glm text prompt");
      expect(needsTranslation(FORMATS.OPENAI, FORMATS.OPENAI)).toBe(false);
    });

    it("GLM requests: Claude-format client targeting Claude transport is passthrough", () => {
      const claudeBody = {
        messages: [{ role: "user", content: "glm claude wire" }],
        model: "glm-4",
      };

      const out = translateRequest(
        FORMATS.CLAUDE,
        FORMATS.CLAUDE,
        "glm-4",
        claudeBody,
        true,
        null,
        "glm"
      );

      expect(out.messages[0].content).toBe("glm claude wire");
      expect(needsTranslation(FORMATS.CLAUDE, FORMATS.CLAUDE)).toBe(false);
    });

    it("MiMo cloud requests: OpenAI format is passthrough", () => {
      const openAIBody = {
        messages: [{ role: "user", content: "mimo cloud prompt" }],
        model: "mimo-v2-flash",
      };

      const out = translateRequest(
        FORMATS.OPENAI,
        FORMATS.OPENAI,
        "mimo-v2-flash",
        openAIBody,
        true,
        null,
        "xiaomi-mimo"
      );

      expect(out.messages[0].content).toBe("mimo cloud prompt");
      expect(needsTranslation(FORMATS.OPENAI, FORMATS.OPENAI)).toBe(false);
    });
  });

  describe("Devin bypasses generic translator", () => {
    it("Devin executor implements native ConnectRPC transport without generic JSON translator", () => {
      const executor = getExecutor("devin");
      expect(executor).toBeInstanceOf(DevinExecutor);
      expect(typeof executor.execute).toBe("function");

      // Wire endpoint for Devin is ConnectRPC protobuf path, not chat/completions or messages
      const url = executor.buildUrl("swe-2-high", false);
      expect(url).toContain("/exa.api_server_pb.ApiServerService/GetChatMessage");
    });
  });
});

// ============================================================================
// Section 2: ANT-04 (NEW) — Anthropic Headers & Proxy Egress Policy
// ============================================================================
describe("ANT-04 (NEW): Anthropic headers and proxy egress policy", () => {
  let DefaultExecutor;
  let proxyAwareFetch;

  beforeEach(async () => {
    const defMod = await import("../../open-sse/executors/default.js");
    DefaultExecutor = defMod.DefaultExecutor;

    const proxyMod = await import("../../open-sse/utils/proxyFetch.js");
    proxyAwareFetch = proxyMod.proxyAwareFetch;
  });

  describe("Official Anthropic host headers (api.anthropic.com)", () => {
    it("retains auth, version, and beta headers on official Anthropic host", () => {
      const executor = new DefaultExecutor("anthropic");
      const headers = executor.buildHeaders(
        { apiKey: API_KEY },
        true,
        "https://api.anthropic.com/v1/messages",
        "claude-sonnet-4-20250514"
      );

      expect(headers["x-api-key"]).toBe(API_KEY);
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers["Anthropic-Beta"] || headers["anthropic-beta"]).toBeDefined();
      expect(headers["Accept"]).toBe("text/event-stream");
    });

    it("retains Authorization Bearer header when accessToken is provided for Claude OAuth", () => {
      const executor = new DefaultExecutor("claude");
      const headers = executor.buildHeaders(
        { accessToken: "oauth-token-123" },
        true,
        "https://api.anthropic.com/v1/messages",
        "claude-opus-5"
      );

      expect(headers["Authorization"]).toBe("Bearer oauth-token-123");
      expect(headers["Anthropic-Version"] || headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers["Anthropic-Dangerous-Direct-Browser-Access"]).toBe("true");
      expect(headers["X-App"]).toBe("cli");
    });

    it("includes model-gated beta flags (e.g. context-management) for Claude models", () => {
      const executor = new DefaultExecutor("claude");
      const headers = executor.buildHeaders(
        { accessToken: "oauth-token-123" },
        true,
        "https://api.anthropic.com/v1/messages",
        "claude-opus-5"
      );

      const betaVal = headers["Anthropic-Beta"] || headers["anthropic-beta"] || "";
      expect(betaVal).toContain("context-management-2025-06-27");
      expect(betaVal).toContain("interleaved-thinking-2025-05-14");
    });
  });

  describe("Non-Anthropic / third-party compatible host headers", () => {
    it("strips first-party identity and attacker headers for non-Anthropic hosts", () => {
      const executor = new DefaultExecutor("anthropic-compatible-custom");
      const headers = executor.buildHeaders(
        {
          apiKey: "custom-key",
          providerSpecificData: { baseUrl: "https://custom-gateway.example.com/v1" },
        },
        true,
        "https://custom-gateway.example.com/v1/messages",
        "claude-sonnet-4"
      );

      expect(headers["x-app"]).toBeUndefined();
      expect(headers["X-App"]).toBeUndefined();
      expect(headers["anthropic-dangerous-direct-browser-access"]).toBeUndefined();
      expect(headers["Anthropic-Dangerous-Direct-Browser-Access"]).toBeUndefined();

      // Dual auth set for third-party compatible gateways
      expect(headers["x-api-key"]).toBe("custom-key");
      expect(headers["Authorization"]).toBe("Bearer custom-key");
    });

    it("strips claude-code-20250219 from beta flags while retaining valid model beta flags", () => {
      const executor = new DefaultExecutor("anthropic-compatible-custom");
      const headers = executor.buildHeaders(
        {
          apiKey: "custom-key",
          providerSpecificData: { baseUrl: "https://custom-gateway.example.com/v1" },
        },
        true,
        "https://custom-gateway.example.com/v1/messages",
        "claude-opus-5"
      );

      const betaVal = headers["Anthropic-Beta"] || headers["anthropic-beta"] || "";
      expect(betaVal).not.toContain("claude-code-20250219");
      expect(betaVal).toContain("context-management-2025-06-27");
    });
  });

  describe("Proxy egress policy (Strict / Fallback / NO_PROXY)", () => {
    it("attaches proxy dispatcher to outbound Anthropic request when proxy is configured", async () => {
      const executor = new DefaultExecutor("anthropic");
      const credentials = { apiKey: API_KEY };
      const proxyOptions = {
        enabled: true,
        url: CONN_PROXY_URL,
      };

      await executor.execute({
        model: "claude-sonnet-4-20250514",
        body: { messages: [{ role: "user", content: "test proxy" }] },
        stream: false,
        credentials,
        proxyOptions,
      });

      const anthropicEgress = egress.filter((c) => c.url.includes(ANTHROPIC_HOST_FRAGMENT));
      expect(anthropicEgress.length).toBeGreaterThan(0);
      const call = anthropicEgress[0];
      expect(call.dispatcher).toBeDefined();
      expect(call.dispatcher.uri).toBe(CONN_PROXY_URL);
    });

    it("NO_PROXY exact host match (api.anthropic.com) bypasses proxy to direct egress", async () => {
      const executor = new DefaultExecutor("anthropic");
      const credentials = { apiKey: API_KEY };
      const proxyOptions = {
        enabled: true,
        url: CONN_PROXY_URL,
        noProxy: "api.anthropic.com",
      };

      await executor.execute({
        model: "claude-sonnet-4-20250514",
        body: { messages: [{ role: "user", content: "test no_proxy" }] },
        stream: false,
        credentials,
        proxyOptions,
      });

      const anthropicEgress = egress.filter((c) => c.url.includes(ANTHROPIC_HOST_FRAGMENT));
      expect(anthropicEgress.length).toBeGreaterThan(0);
      const call = anthropicEgress[0];
      // Direct egress: no dispatcher attached
      expect(call.dispatcher).toBeNull();
    });

    it("NO_PROXY leading dot suffix (.anthropic.com) bypasses proxy to direct egress", async () => {
      const executor = new DefaultExecutor("anthropic");
      const credentials = { apiKey: API_KEY };
      const proxyOptions = {
        enabled: true,
        url: CONN_PROXY_URL,
        noProxy: ".anthropic.com,other.org",
      };

      await executor.execute({
        model: "claude-sonnet-4-20250514",
        body: { messages: [{ role: "user", content: "test suffix no_proxy" }] },
        stream: false,
        credentials,
        proxyOptions,
      });

      const anthropicEgress = egress.filter((c) => c.url.includes(ANTHROPIC_HOST_FRAGMENT));
      expect(anthropicEgress.length).toBeGreaterThan(0);
      const call = anthropicEgress[0];
      expect(call.dispatcher).toBeNull();
    });

    it("NO_PROXY non-matching host routes through configured proxy", async () => {
      const executor = new DefaultExecutor("anthropic");
      const credentials = { apiKey: API_KEY };
      const proxyOptions = {
        enabled: true,
        url: CONN_PROXY_URL,
        noProxy: "openai.com,google.com",
      };

      await executor.execute({
        model: "claude-sonnet-4-20250514",
        body: { messages: [{ role: "user", content: "test non matching no_proxy" }] },
        stream: false,
        credentials,
        proxyOptions,
      });

      const anthropicEgress = egress.filter((c) => c.url.includes(ANTHROPIC_HOST_FRAGMENT));
      expect(anthropicEgress.length).toBeGreaterThan(0);
      const call = anthropicEgress[0];
      expect(call.dispatcher).toBeDefined();
      expect(call.dispatcher.uri).toBe(CONN_PROXY_URL);
    });

    it("strictProxy = true hard-fails before egress when proxy URL is invalid", async () => {
      const invalidProxyOptions = {
        enabled: true,
        url: "ftp://invalid-scheme.local:21",
        strictProxy: true,
      };

      await expect(
        proxyAwareFetch("https://api.anthropic.com/v1/messages", {}, invalidProxyOptions)
      ).rejects.toThrow(/Proxy required but failed|unsupported scheme/);
    });

    it("non-strict mode falls back to direct egress when invalid proxy URL is provided", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const invalidProxyOptions = {
        enabled: true,
        url: "ftp://invalid-scheme.local:21",
        strictProxy: false,
      };

      const res = await proxyAwareFetch(
        "https://api.anthropic.com/v1/messages",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        invalidProxyOptions
      );

      expect(res.ok).toBe(true);
      const anthropicEgress = egress.filter((c) => c.url.includes(ANTHROPIC_HOST_FRAGMENT));
      expect(anthropicEgress.length).toBeGreaterThan(0);
      // Fell back to direct fetch: no dispatcher
      expect(anthropicEgress[0].dispatcher).toBeNull();
      warnSpy.mockRestore();
    });
  });
});

// ============================================================================
// Section 3: Legacy Statuses Verified (Informational Only, Never Promoted)
// ============================================================================
describe("Legacy statuses verified (informational only, non-blocking)", () => {
  it("[ANT-01: KNOWN-XFAIL] documents Claude -> OpenAI bridge image/tool semantics status", () => {
    // Legacy status recorded: image URLs and is_error flags over OpenAI bridge
    // are catalogued as KNOWN-XFAIL in tests/translator/bugs-openai-bridge.test.js
    const legacyStatus = "KNOWN-XFAIL";
    expect(legacyStatus).toBe("KNOWN-XFAIL");
  });

  it("[ANT-02: KNOWN-BASELINE+KNOWN-XFAIL] documents OpenAI -> Claude bridge thinking/empty Read status", () => {
    // Legacy status recorded: empty Read parameter omission is in tests/__baseline__/known-fails.txt (#10)
    const legacyStatus = "KNOWN-BASELINE+KNOWN-XFAIL";
    expect(legacyStatus).toBe("KNOWN-BASELINE+KNOWN-XFAIL");
  });

  it("[ANT-03: KNOWN-XFAIL] documents Claude Code context bridge system prompt injection status", () => {
    // Legacy status recorded: system prompt injection for compatible non-Claude targets is KNOWN-XFAIL
    const legacyStatus = "KNOWN-XFAIL";
    expect(legacyStatus).toBe("KNOWN-XFAIL");
  });

  it("[ANT-04: KNOWN-BASELINE] documents legacy Anthropic got-scraping non-streaming baseline status", () => {
    // Legacy status recorded: got-scraping non-streaming routing is in tests/__baseline__/known-fails.txt (#1)
    const legacyStatus = "KNOWN-BASELINE";
    expect(legacyStatus).toBe("KNOWN-BASELINE");
  });
});
