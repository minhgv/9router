import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// Wave 5: GLM Dual Transport, Foreign Tool History, Reasoning & Error Contracts
// Worker: W-H (GLM)
//
// IDs & Statuses (Plan §7.2 / Blueprint §5):
//   - GLM-01 (NEW): GLM OpenAI transport -> DefaultExecutor
//     OpenAI source format, coding endpoint, Bearer auth, reasoning variants,
//     no Claude wrapper / no x-api-key, distinct from glm-cn.
//   - GLM-02 (NEW): GLM Claude transport -> DefaultExecutor
//     Claude source format, Anthropic endpoint, beta query (?beta=true),
//     x-api-key auth, no Bearer leak, body Claude-compatible.
//   - GLM-03 (EXTEND): GLM tool history, stream & search contracts
//     Foreign server_tool_use sanitization, orphan tool_result stripping,
//     delta reasoning_content extraction, MCP web search request & normalization.
//   - GLM-04 (NEW): GLM reasoning effort & error handling
//     Reasoning effort mapping (low/medium/high/max/none), invalid normalization,
//     graceful upstream error handling with zero credential leakage.
// ============================================================================

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

function jsonResponse(body, status = 200, headers = {}) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: {
      get: (k) => {
        const lower = String(k).toLowerCase();
        if (lower === "content-type") return "application/json";
        return headers[k] || headers[lower] || null;
      },
    },
    text: async () => text,
    json: async () => body,
  };
}

const fetchMock = vi.fn(async (input, init = {}) => {
  const url = typeof input === "string" ? input : String(input);
  egress.push({
    url,
    method: init?.method ?? "GET",
    headers: init?.headers ?? {},
    body: typeof init?.body === "string" ? init.body : null,
  });

  if (responder) {
    return responder(url, init);
  }

  return jsonResponse({
    id: "chatcmpl-test-glm",
    object: "chat.completion",
    created: Date.now(),
    model: "glm-5.3",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "GLM response output" },
        finish_reason: "stop",
      },
    ],
  });
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
// Section 1: GLM-01 (NEW) — GLM OpenAI Transport -> DefaultExecutor
// ============================================================================
describe("GLM-01 (NEW): GLM OpenAI transport -> DefaultExecutor contracts", () => {
  let glmRegistry;
  let glmCnRegistry;
  let resolveTransport;
  let DefaultExecutor;

  beforeEach(async () => {
    glmRegistry = (await import("../../open-sse/providers/registry/glm.js")).default;
    glmCnRegistry = (await import("../../open-sse/providers/registry/glm-cn.js")).default;
    const providerService = await import("../../open-sse/services/provider.js");
    resolveTransport = providerService.resolveTransport;
    const defaultExecutorMod = await import("../../open-sse/executors/default.js");
    DefaultExecutor = defaultExecutorMod.DefaultExecutor;
  });

  it("declares an OpenAI coding transport distinct from China endpoint (glm-cn)", () => {
    expect(glmRegistry.id).toBe("glm");
    expect(glmRegistry.transports).toBeDefined();

    const openaiTransport = glmRegistry.transports.find((t) => t.format === "openai");
    expect(openaiTransport).toBeDefined();
    expect(openaiTransport.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
    expect(openaiTransport.auth).toEqual({
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    });

    // Verify glm is distinct from glm-cn
    expect(glmCnRegistry.id).toBe("glm-cn");
    expect(glmCnRegistry.transport.baseUrl).toBe(
      "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"
    );
    expect(openaiTransport.baseUrl).not.toBe(glmCnRegistry.transport.baseUrl);
  });

  it("resolves the OpenAI transport when client source format is openai", () => {
    const transport = resolveTransport("glm", "openai");
    expect(transport).not.toBeNull();
    expect(transport.format).toBe("openai");
    expect(transport.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
    expect(transport.auth.header).toBe("Authorization");
    expect(transport.auth.scheme).toBe("bearer");
  });

  it("DefaultExecutor builds correct URL and Bearer headers for OpenAI transport", () => {
    const executor = new DefaultExecutor("glm");
    const credentials = {
      apiKey: "sk-glm-test-openai-key-123",
      runtimeTransport: {
        format: "openai",
        baseUrl: "https://api.z.ai/api/coding/paas/v4/chat/completions",
        auth: { combined: true, header: "Authorization", scheme: "bearer" },
      },
    };

    const url = executor.buildUrl("glm-5.3", false, 0, credentials);
    expect(url).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");

    const headers = executor.buildHeaders(credentials, false, url, "glm-5.3");
    expect(headers["Authorization"]).toBe("Bearer sk-glm-test-openai-key-123");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBeUndefined();
    expect(headers["Anthropic-Beta"]).toBeUndefined();
    expect(headers["Accept"]).toBeUndefined();
  });

  it("DefaultExecutor builds streaming Accept header when stream=true", () => {
    const executor = new DefaultExecutor("glm");
    const credentials = {
      apiKey: "sk-glm-test-streaming-key",
      runtimeTransport: {
        format: "openai",
        baseUrl: "https://api.z.ai/api/coding/paas/v4/chat/completions",
        auth: { combined: true, header: "Authorization", scheme: "bearer" },
      },
    };

    const headers = executor.buildHeaders(credentials, true, "https://api.z.ai/api/coding/paas/v4/chat/completions", "glm-5.3");
    expect(headers["Accept"]).toBe("text/event-stream");
    expect(headers["Authorization"]).toBe("Bearer sk-glm-test-streaming-key");
  });

  it("DefaultExecutor.execute sends request to coding endpoint with Bearer auth and no Claude headers", async () => {
    const executor = new DefaultExecutor("glm");
    const credentials = {
      apiKey: "sk-glm-live-key-456",
      runtimeTransport: {
        format: "openai",
        baseUrl: "https://api.z.ai/api/coding/paas/v4/chat/completions",
        auth: { combined: true, header: "Authorization", scheme: "bearer" },
      },
    };

    const requestBody = {
      model: "glm-5.3",
      messages: [{ role: "user", content: "Write a quicksort in Rust" }],
      stream: false,
    };

    await executor.execute({
      model: "glm-5.3",
      stream: false,
      body: requestBody,
      credentials,
    });

    expect(egress.length).toBe(1);
    const sent = egress[0];
    expect(sent.url).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
    expect(sent.method).toBe("POST");
    expect(sent.headers["Authorization"]).toBe("Bearer sk-glm-live-key-456");
    expect(sent.headers["x-api-key"]).toBeUndefined();
    expect(sent.headers["anthropic-version"]).toBeUndefined();

    const parsedBody = JSON.parse(sent.body);
    expect(parsedBody.model).toBe("glm-5.3");
    expect(parsedBody.messages[0].content).toBe("Write a quicksort in Rust");
  });
});

// ============================================================================
// Section 2: GLM-02 (NEW) — GLM Claude Transport -> DefaultExecutor
// ============================================================================
describe("GLM-02 (NEW): GLM Claude transport -> DefaultExecutor contracts", () => {
  let glmRegistry;
  let resolveTransport;
  let DefaultExecutor;

  beforeEach(async () => {
    glmRegistry = (await import("../../open-sse/providers/registry/glm.js")).default;
    const providerService = await import("../../open-sse/services/provider.js");
    resolveTransport = providerService.resolveTransport;
    const defaultExecutorMod = await import("../../open-sse/executors/default.js");
    DefaultExecutor = defaultExecutorMod.DefaultExecutor;
  });

  it("declares a Claude transport with ?beta=true URL suffix and x-api-key auth", () => {
    expect(glmRegistry.transports).toBeDefined();

    const claudeTransport = glmRegistry.transports.find((t) => t.format === "claude");
    expect(claudeTransport).toBeDefined();
    expect(claudeTransport.baseUrl).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(claudeTransport.urlSuffix).toBe("?beta=true");
    expect(claudeTransport.headers).toBeDefined();
    expect(claudeTransport.headers["Anthropic-Version"] || claudeTransport.headers["anthropic-version"]).toBe("2023-06-01");
    expect(claudeTransport.auth).toEqual({
      combined: true,
      header: "x-api-key",
      scheme: "raw",
    });
  });

  it("resolves the Claude transport when client source format is claude", () => {
    const transport = resolveTransport("glm", "claude");
    expect(transport).not.toBeNull();
    expect(transport.format).toBe("claude");
    expect(transport.baseUrl).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(transport.urlSuffix).toBe("?beta=true");
    expect(transport.auth.header).toBe("x-api-key");
    expect(transport.auth.scheme).toBe("raw");
  });

  it("DefaultExecutor builds correct URL with ?beta=true and x-api-key headers without leaking Bearer", () => {
    const executor = new DefaultExecutor("glm");
    const credentials = {
      apiKey: "sk-glm-claude-test-key-789",
      runtimeTransport: {
        format: "claude",
        baseUrl: "https://api.z.ai/api/anthropic/v1/messages",
        urlSuffix: "?beta=true",
        headers: { "anthropic-version": "2023-06-01" },
        auth: { combined: true, header: "x-api-key", scheme: "raw" },
      },
    };

    const url = executor.buildUrl("glm-5.3", false, 0, credentials);
    expect(url).toBe("https://api.z.ai/api/anthropic/v1/messages?beta=true");

    const headers = executor.buildHeaders(credentials, false, url, "glm-5.3");
    expect(headers["x-api-key"]).toBe("sk-glm-claude-test-key-789");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["Content-Type"]).toBe("application/json");
    // CRITICAL: Ensure Bearer Authorization is NOT leaked
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("DefaultExecutor.execute sends request to Anthropic endpoint with x-api-key and Claude-compatible body", async () => {
    const executor = new DefaultExecutor("glm");
    const credentials = {
      apiKey: "sk-glm-claude-secret-999",
      runtimeTransport: {
        format: "claude",
        baseUrl: "https://api.z.ai/api/anthropic/v1/messages",
        urlSuffix: "?beta=true",
        headers: { "anthropic-version": "2023-06-01" },
        auth: { combined: true, header: "x-api-key", scheme: "raw" },
      },
    };

    const requestBody = {
      model: "glm-5.3",
      system: "You are a coding expert",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Explain monads in TypeScript" }],
        },
      ],
      tools: [
        {
          name: "eval_code",
          description: "Run TypeScript snippet",
          input_schema: {
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
          },
        },
      ],
      stream: false,
    };

    await executor.execute({
      model: "glm-5.3",
      stream: false,
      body: requestBody,
      credentials,
    });

    expect(egress.length).toBe(1);
    const sent = egress[0];
    expect(sent.url).toBe("https://api.z.ai/api/anthropic/v1/messages?beta=true");
    expect(sent.headers["x-api-key"]).toBe("sk-glm-claude-secret-999");
    expect(sent.headers["anthropic-version"]).toBe("2023-06-01");
    expect(sent.headers["Authorization"]).toBeUndefined();

    const parsedBody = JSON.parse(sent.body);
    expect(parsedBody.model).toBe("glm-5.3");
    expect(parsedBody.system).toBe("You are a coding expert");
    expect(parsedBody.messages[0].content).toEqual([
      { type: "text", text: "Explain monads in TypeScript" },
    ]);
    expect(parsedBody.tools).toHaveLength(1);
    expect(parsedBody.tools[0].name).toBe("eval_code");
  });
});

// ============================================================================
// Section 3: GLM-03 (EXTEND) — GLM Tool History, Stream & Search Contracts
// ============================================================================
describe("GLM-03 (EXTEND): GLM tool history, stream & search contracts", () => {
  let normalizeClaudePassthrough;
  let extractReasoningText;
  let buildSearchRequest;
  let normalizeSearchResponse;
  let glmRegistry;

  beforeEach(async () => {
    const claudeFormatMod = await import("../../open-sse/translator/formats/claude.js");
    normalizeClaudePassthrough = claudeFormatMod.normalizeClaudePassthrough;
    const reasoningMod = await import("../../open-sse/translator/concerns/reasoning.js");
    extractReasoningText = reasoningMod.extractReasoningText;
    const callersMod = await import("../../open-sse/handlers/search/callers.js");
    buildSearchRequest = callersMod.buildSearchRequest;
    const normalizersMod = await import("../../open-sse/handlers/search/normalizers.js");
    normalizeSearchResponse = normalizersMod.normalizeSearchResponse;
    glmRegistry = (await import("../../open-sse/providers/registry/glm.js")).default;
  });

  describe("Foreign server_tool_use and orphan tool_result sanitization", () => {
    it("strips OpenAI-style server_tool_use and orphan tool_result to prevent Anthropic 400", () => {
      const historyWithForeignServerToolUse = {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Checking repository index..." },
              {
                type: "server_tool_use",
                id: "call_9876543210abcdef",
                name: "web_search",
                input: { query: "vitest documentation" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_9876543210abcdef",
                content: "Search results from external provider",
              },
              { type: "text", text: "Please summarize the results." },
            ],
          },
        ],
      };

      const normalized = normalizeClaudePassthrough(historyWithForeignServerToolUse);

      // Assistant message: foreign server_tool_use stripped, text kept
      expect(normalized.messages[0].content).toEqual([
        { type: "text", text: "Checking repository index..." },
      ]);

      // User message: orphan tool_result stripped, text kept
      expect(normalized.messages[1].content).toEqual([
        { type: "text", text: "Please summarize the results." },
      ]);
    });

    it("preserves valid Anthropic srvtoolu_ server_tool_use and standard tool_use blocks", () => {
      const validHistory = {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "server_tool_use",
                id: "srvtoolu_01A2B3C4D5E6F7G8H9",
                name: "web_search",
                input: { query: "anthropic srvtoolu format" },
              },
              {
                type: "tool_use",
                id: "call_client_tool_123",
                name: "readFile",
                input: { path: "index.js" },
              },
            ],
          },
        ],
      };

      const normalized = normalizeClaudePassthrough(validHistory);
      expect(normalized.messages[0].content).toHaveLength(2);
      expect(normalized.messages[0].content[0].id).toBe("srvtoolu_01A2B3C4D5E6F7G8H9");
      expect(normalized.messages[0].content[1].id).toBe("call_client_tool_123");
    });
  });

  describe("GLM streaming delta reasoning extraction", () => {
    it("extracts reasoning_content from GLM stream deltas", () => {
      const delta1 = { reasoning_content: "Step 1: Parse AST\n" };
      const delta2 = { reasoning_content: "Step 2: Check types" };
      expect(extractReasoningText(delta1)).toBe("Step 1: Parse AST\n");
      expect(extractReasoningText(delta2)).toBe("Step 2: Check types");
    });

    it("extracts alternative reasoning shapes (reasoning string and reasoning_details array)", () => {
      expect(extractReasoningText({ reasoning: "compat reasoning string" })).toBe(
        "compat reasoning string"
      );
      expect(
        extractReasoningText({
          reasoning_details: [{ text: "part A " }, { content: "part B" }],
        })
      ).toBe("part A part B");
      expect(extractReasoningText({})).toBe("");
      expect(extractReasoningText(null)).toBe("");
    });
  });

  describe("GLM MCP web search integration", () => {
    it("builds correct JSON-RPC 2.0 web_search_prime request for GLM provider", () => {
      const searchConfig = glmRegistry.searchConfig;
      expect(searchConfig).toBeDefined();
      const provider = {
        id: "glm",
        ...searchConfig,
      };

      const req = buildSearchRequest(provider, {
        query: "Z.ai GLM-5.3 release notes",
        maxResults: 10,
        token: "glm-search-key-bearer-777",
      });

      expect(req.url).toBe("https://api.z.ai/api/mcp/web_search_prime/mcp");
      expect(req.init.method).toBe("POST");
      expect(req.init.headers["Authorization"]).toBe("Bearer glm-search-key-bearer-777");
      expect(req.init.headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(req.init.body);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.method).toBe("tools/call");
      expect(body.params.name).toBe("web_search_prime");
      expect(body.params.arguments).toEqual({
        search_query: "Z.ai GLM-5.3 release notes",
        count: 10,
      });
    });

    it("normalizes GLM search results into unified search schema", () => {
      const sampleGlmPayload = {
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                results: [
                  {
                    title: "GLM-5.3 Overview",
                    link: "https://z.ai/models/glm-5.3",
                    content: "GLM-5.3 is the newest model from Z.ai featuring enhanced coding.",
                    publish_date: "2026-03-01",
                    icon: "https://z.ai/favicon.ico",
                    media: "news",
                  },
                  {
                    title: "Z.ai Developer Documentation",
                    url: "https://docs.z.ai/guides/api",
                    content: "API guides for GLM models and MCP search integration.",
                  },
                ],
              }),
            },
          ],
        },
      };

      const normalized = normalizeSearchResponse("glm", sampleGlmPayload, "GLM-5.3", "web");
      expect(normalized.results).toHaveLength(2);
      expect(normalized.totalResults).toBe(2);

      const first = normalized.results[0];
      expect(first.title).toBe("GLM-5.3 Overview");
      expect(first.url).toBe("https://z.ai/models/glm-5.3");
      expect(first.snippet).toContain("enhanced coding");
      expect(first.citation.provider).toBe("glm");
      expect(first.favicon_url).toBe("https://z.ai/favicon.ico");

      const second = normalized.results[1];
      expect(second.title).toBe("Z.ai Developer Documentation");
      expect(second.url).toBe("https://docs.z.ai/guides/api");
      expect(second.citation.provider).toBe("glm");
    });
  });
});

// ============================================================================
// Section 4: GLM-04 (NEW) — GLM Reasoning Effort & Error Handling
// ============================================================================
describe("GLM-04 (NEW): GLM reasoning effort & error handling contracts", () => {
  let applyThinking;
  let DefaultExecutor;

  beforeEach(async () => {
    const thinkingMod = await import("../../open-sse/translator/concerns/thinkingUnified.js");
    applyThinking = thinkingMod.applyThinking;
    const defaultExecutorMod = await import("../../open-sse/executors/default.js");
    DefaultExecutor = defaultExecutorMod.DefaultExecutor;
  });

  describe("GLM reasoning effort mapping for GLM-5.3 and GLM-5.2", () => {
    it("maps low/minimal reasoning effort to reasoning_effort: 'low'", () => {
      const bodyLow = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: "low",
      };
      const resLow = applyThinking("openai", "glm-5.3", bodyLow, "glm");
      expect(resLow.thinking).toEqual({ type: "enabled" });
      expect(resLow.reasoning_effort).toBe("low");

      const bodyMinimal = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: "minimal",
      };
      const resMinimal = applyThinking("openai", "glm-5.3", bodyMinimal, "glm");
      expect(resMinimal.thinking).toEqual({ type: "enabled" });
      expect(resMinimal.reasoning_effort).toBe("low");
    });

    it("maps medium/high reasoning effort to reasoning_effort: 'high'", () => {
      const bodyMedium = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: "medium",
      };
      const resMedium = applyThinking("openai", "glm-5.3", bodyMedium, "glm");
      expect(resMedium.thinking).toEqual({ type: "enabled" });
      expect(resMedium.reasoning_effort).toBe("high");

      const bodyHigh = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: "high",
      };
      const resHigh = applyThinking("openai", "glm-5.3", bodyHigh, "glm");
      expect(resHigh.thinking).toEqual({ type: "enabled" });
      expect(resHigh.reasoning_effort).toBe("high");
    });

    it("maps max/xhigh/auto reasoning effort to reasoning_effort: 'max'", () => {
      const bodyMax = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: "max",
      };
      const resMax = applyThinking("openai", "glm-5.3", bodyMax, "glm");
      expect(resMax.thinking).toEqual({ type: "enabled" });
      expect(resMax.reasoning_effort).toBe("max");

      const bodyXhigh = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: "xhigh",
      };
      const resXhigh = applyThinking("openai", "glm-5.3", bodyXhigh, "glm");
      expect(resXhigh.thinking).toEqual({ type: "enabled" });
      expect(resXhigh.reasoning_effort).toBe("max");
    });

    it("maps none/disabled reasoning to enable_thinking: false and removes thinking object", () => {
      const bodyNone = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: "none",
      };
      const resNone = applyThinking("openai", "glm-5.3", bodyNone, "glm");
      expect(resNone.enable_thinking).toBe(false);
      expect(resNone.thinking).toBeUndefined();

      const bodyDisabled = {
        model: "glm-5.3",
        messages: [{ role: "user", content: "hello" }],
        thinking: { type: "disabled" },
      };
      const resDisabled = applyThinking("openai", "glm-5.3", bodyDisabled, "glm");
      expect(resDisabled.enable_thinking).toBe(false);
      expect(resDisabled.thinking).toBeUndefined();
    });

    it("applies thinking: { type: 'enabled' } but omits reasoning_effort for older models (e.g. glm-5, glm-4.7)", () => {
      const bodyGlm5 = {
        model: "glm-5",
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: "medium",
      };
      const resGlm5 = applyThinking("openai", "glm-5", bodyGlm5, "glm");
      expect(resGlm5.thinking).toEqual({ type: "enabled" });
      expect(resGlm5.reasoning_effort).toBeUndefined();

      const bodyGlm4 = {
        model: "glm-4.7",
        messages: [{ role: "user", content: "hello" }],
        thinking: { type: "enabled" },
      };
      const resGlm4 = applyThinking("openai", "glm-4.7", bodyGlm4, "glm");
      expect(resGlm4.thinking).toEqual({ type: "enabled" });
      expect(resGlm4.reasoning_effort).toBeUndefined();
    });
  });

  describe("Error handling and credential isolation", () => {
    it("handles upstream 401 Unauthorized without leaking apiKey in errors", async () => {
      responder = async () =>
        jsonResponse(
          {
            error: {
              code: "1001",
              message: "Authentication failed. Token is invalid or expired.",
            },
          },
          401
        );

      const executor = new DefaultExecutor("glm");
      const credentials = {
        apiKey: "SUPER-SECRET-GLM-KEY-XYZ999",
        runtimeTransport: {
          format: "openai",
          baseUrl: "https://api.z.ai/api/coding/paas/v4/chat/completions",
          auth: { combined: true, header: "Authorization", scheme: "bearer" },
        },
      };

      const result = await executor.execute({
        model: "glm-5.3",
        stream: false,
        body: { model: "glm-5.3", messages: [{ role: "user", content: "hi" }] },
        credentials,
      });

      expect(result.response.status).toBe(401);
      const errText = await result.response.text();
      expect(errText).not.toContain("SUPER-SECRET-GLM-KEY-XYZ999");
      expect(errText).toContain("Authentication failed");
    });

    it("handles upstream 500 HTML gateway error without crashing", async () => {
      responder = async () => ({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: {
          get: (k) => (String(k).toLowerCase() === "content-type" ? "text/html" : null),
        },
        text: async () => "<html><body>500 Internal Server Error from Upstream</body></html>",
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0");
        },
      });

      const executor = new DefaultExecutor("glm");
      const credentials = {
        apiKey: "sk-test-html-key-111",
        runtimeTransport: {
          format: "openai",
          baseUrl: "https://api.z.ai/api/coding/paas/v4/chat/completions",
          auth: { combined: true, header: "Authorization", scheme: "bearer" },
        },
      };

      const result = await executor.execute({
        model: "glm-5.3",
        stream: false,
        body: { model: "glm-5.3", messages: [{ role: "user", content: "hi" }] },
        credentials,
      });

      expect(result.response.status).toBe(500);
      const text = await result.response.text();
      expect(text).toContain("500 Internal Server Error");
      expect(text).not.toContain("sk-test-html-key-111");
    });
  });
});
