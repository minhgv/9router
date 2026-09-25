import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
  getDevinCatalogSnapshot: vi.fn(),
  invalidateDevinCatalog: vi.fn(),
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
  default: mocks.proxyAwareFetch,
}));

// W1's shared catalog module, consumed by the executor per the locked
// contract. Every test defaults to a null snapshot (static-registry
// behavior) unless it pins its own snapshot.
vi.mock("open-sse/services/devinCatalog.js", () => ({
  getDevinCatalogSnapshot: mocks.getDevinCatalogSnapshot,
  invalidateDevinCatalog: mocks.invalidateDevinCatalog,
}));

import zlib from "node:zlib";
import {
  DevinExecutor,
  sanitizeDevinSystemPrompt,
  sanitizeDevinToolDescription,
} from "open-sse/executors/devin.js";

import { getExecutor, hasSpecializedExecutor } from "open-sse/executors/index.js";
import { PROVIDERS } from "open-sse/config/providers.js";
import { MODEL_PRICING, getPricingForModel } from "open-sse/providers/pricing.js";
import { MODEL_CAPABILITIES, getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { PROVIDER_MODELS, getProviderModels, isValidModel } from "open-sse/config/providerModels.js";
import devinRegistry from "open-sse/providers/registry/devin.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import {
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_AUTH_PATH,
  DEVIN_CHAT_PATH,
  DEVIN_ASSIGN_MODEL_PATH,
  ChatMessageRequestType,
  ChatMessageSource,
  ConversationalPlannerMode,
  PromptCacheType,
  StopReason,
  toBinary,
  fromBinary,
  buildConnectFrame,
  GetUserJwtResponseSchema,
  GetChatMessageRequestSchema,
  GetChatMessageResponseSchema,
  AssignModelRequestSchema,
  AssignModelResponseSchema,
} from "open-sse/utils/devinProtobuf.js";

// Helper to create a mock ReadableStream from chunks
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

// Helper to consume an SSE Response into parsed SSE events
async function readSseResponse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n\n");
    buffer = lines.pop() || "";

    for (const block of lines) {
      for (const line of block.split("\n")) {
        if (line.startsWith("data: ")) {
          const data = line.slice("data: ".length).trim();
          events.push(data);
        }
      }
    }
  }

  if (buffer.trim().startsWith("data: ")) {
    events.push(buffer.trim().slice("data: ".length).trim());
  }

  return events;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// End-of-stream Connect trailer frame (flag 0x02 + JSON trailers).
function endStreamFrame(trailers = {}) {
  const payload = Buffer.from(JSON.stringify(trailers));
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 0x02;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

// A complete GetChatMessage stream: data frames + empty success trailer.
function chatStream(...dataFrames) {
  return Buffer.concat([...dataFrames, endStreamFrame()]);
}

// Mocked Devin edge: GetUserJwt / AssignModel / GetChatMessage served from one
// recorder so tests assert call order and decode the real wire bodies.
function serveDevinEdge({ auth, assignment, chat } = {}) {
  const calls = [];
  mocks.proxyAwareFetch.mockImplementation(async (url, options, proxyOptions) => {
    const call = { url, options, proxyOptions };
    calls.push(call);
    if (url.includes(DEVIN_AUTH_PATH)) {
      return (
        auth?.() ??
        new Response(
          toBinary(GetUserJwtResponseSchema, {
            userJwt: "user-jwt",
            customApiServerUrl: "https://custom.server.codeium.com",
          }),
          { status: 200, headers: { "content-type": "application/proto" } }
        )
      );
    }
    if (url.includes(DEVIN_ASSIGN_MODEL_PATH)) {
      return (
        assignment?.() ??
        new Response(
          toBinary(AssignModelResponseSchema, {
            assignment: { assignmentJwt: "assign-jwt", modelUid: "claude-sonnet-4-5" },
          }),
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

function decodeAssignRequest(call) {
  return fromBinary(AssignModelRequestSchema, call.options.body);
}

function decodeChatRequest(call) {
  const framed = Buffer.from(call.options.body);
  const length = new DataView(framed.buffer, framed.byteOffset).getUint32(1, false);
  return fromBinary(GetChatMessageRequestSchema, zlib.gunzipSync(framed.subarray(5, 5 + length)));
}

function callPaths(calls) {
  return calls.map((c) => new URL(c.url).pathname);
}

// The executor requests the shared catalog on every call; unless a test
// pins its own snapshot, default to null → static-registry behavior.
beforeEach(() => {
  mocks.getDevinCatalogSnapshot.mockReset();
  mocks.getDevinCatalogSnapshot.mockResolvedValue(null);
});


describe("DevinExecutor Registration & Provider Config", () => {
  it("registers in executors map and resolves specialized executor", () => {
    expect(hasSpecializedExecutor("devin")).toBe(true);
    const executor = getExecutor("devin");
    expect(executor).toBeInstanceOf(DevinExecutor);
  });

  it("exists in PROVIDERS and registry with correct identity, display, and transport", () => {
    const provider = PROVIDERS.devin;
    expect(provider).toBeDefined();
    expect(provider.baseUrl).toBe("https://server.codeium.com");
    expect(provider.format).toBe("openai");

    expect(devinRegistry.id).toBe("devin");
    expect(devinRegistry.alias).toBe("dv");
    expect(devinRegistry.aliases).toContain("devin");
    expect(devinRegistry.uiAlias).toBe("dv");
    expect(devinRegistry.category).toBe("oauth");
    expect(devinRegistry.authType).toBe("oauth");
    expect(devinRegistry.authModes).toEqual(["oauth", "apikey"]);
    expect(devinRegistry.transport.baseUrl).toBe("https://server.codeium.com");
    expect(devinRegistry.transport.format).toBe("openai");

    expect(devinRegistry.display).toEqual({
      name: "Devin",
      icon: "smart_toy",
      color: "#6366F1",
      textIcon: "DV",
      website: "https://devin.ai",
    });

    const models = PROVIDER_MODELS.dv;
    expect(models).toHaveLength(60);
    expect(models.map((m) => m.id)).toEqual([
      // Raw sibling uids (kept for backward compat)
      "swe-2-high",
      "swe-2-medium",
      "swe-2-max",
      "swe-1-7",
      "swe-1-7-medium",
      "swe-1-7-lightning",
      "swe-1-7-lightning-medium",
      "adaptive",
      "claude-opus-5-medium",
      "claude-fable-5-1-medium",
      "claude-sonnet-5-medium",
      "gemini-3-8-flash-medium",
      "gpt-5-6-sol-medium",
      "gpt-5-6-luna-medium",
      "gpt-6-astra-medium",
      "glm-5-2",
      "glm-5-3-low",
      "glm-5-3-high",
      "glm-5-3-max",
      "kimi-k3-high",
      // Logical effort-routed variant families
      "swe-2",
      "claude-opus-5",
      "claude-opus-5-fast",
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-opus-4-7",
      "claude-opus-4-7-fast",
      "claude-opus-4-8",
      "claude-opus-4-8-fast",
      "gpt-5-2",
      "gpt-5-3-codex",
      "gpt-5-3-codex-fast",
      "gpt-5-4",
      "gpt-5-4-fast",
      "gpt-5-4-mini",
      "gpt-5-5",
      "gpt-5-5-fast",
      "gpt-5-6-luna",
      "gpt-5-6-luna-fast",
      "gpt-5-6-sol",
      "gpt-5-6-sol-fast",
      "gpt-5-6-terra",
      "gpt-5-6-terra-fast",
      "kimi-k3",
      "grok-4-5",
      "inkling",
      "gemini-3-1-pro",
      "gemini-3-5-flash",
      "gemini-3-6-flash",
      "gemini-3-flash",
      "glm-5-2-1m",
      "gemini-3-7-flash",
      "grok-4-6",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "nemotron-3-ultra",
      "claude-haiku-4-5",
      // Legacy
      "swe-check",
      "swe-1-6",
      "swe-1-6-fast",
    ]);
    expect(models[0]).toMatchObject({
      id: "swe-2-high",
      name: "SWE-2 High",
      contextLength: 262000,
    });
    expect(models[57]).toMatchObject({
      id: "swe-check",
      name: "SWE-check",
      contextLength: 200000,
    });
    expect(models[58]).toMatchObject({
      id: "swe-1-6",
      name: "SWE-1.6",
      contextLength: 200000,
    });
    expect(models[59]).toMatchObject({
      id: "swe-1-6-fast",
      name: "SWE-1.6 Fast",
      contextLength: 200000,
    });

    // Logical effort-routed family entry per the collapse contract.
    expect(models.find((m) => m.id === "swe-2")).toMatchObject({
      name: "SWE-2",
      contextLength: 262000,
      toolUse: true,
      supportsParallelToolCalls: true,
      effortRouting: { medium: "swe-2-medium", high: "swe-2-high", max: "swe-2-max" },
      defaultMember: "swe-2-high",
      efforts: ["medium", "high", "max"],
      requiresEffort: true,
    });
    // Merged families: the raw max-tier uid doubles as the logical family id.
    expect(models.find((m) => m.id === "swe-1-7")).toMatchObject({
      name: "SWE-1.7",
      effortRouting: { medium: "swe-1-7-medium", max: "swe-1-7" },
      defaultMember: "swe-1-7",
      efforts: ["medium", "max"],
      requiresEffort: true,
    });
    expect(models.find((m) => m.id === "swe-1-7-lightning")).toMatchObject({
      name: "SWE-1.7 Lightning",
      defaultMember: "swe-1-7-lightning-medium",
      requiresEffort: true,
    });
    expect(models.find((m) => m.id === "glm-5-2")).toMatchObject({
      name: "GLM-5.2",
      effortRouting: { high: "glm-5-2", xhigh: "glm-5-2" },
      defaultMember: "glm-5-2",
      efforts: ["high", "xhigh"],
      requiresEffort: true,
    });
    expect(devinRegistry.providerAliases).toMatchObject({
      swe: "swe-1-7-lightning",
      opus: "claude-opus-5",
      sonnet: "claude-sonnet-5",
      claude: "claude-sonnet-5",
      haiku: "claude-haiku-4-5",
      gemini: "gemini-3-7-flash",
      gpt: "gpt-5-6-terra",
      codex: "gpt-5-3-codex",
      "swe-1.7": "swe-1-7",
      "glm-5.2": "glm-5-2",
    });
    // No duplicate ids: merged families must not double-register.
    const ids = models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Every lineup model resolves pricing (canonical or provider-scoped) and
    // devin capabilities through the provider chain — logical ids must not
    // fall through to another vendor's canonical entry (e.g. anthropic
    // claude-adaptive format). The no-thinking haiku family is the exception.
    for (const m of models) {
      expect(getPricingForModel("devin", m.id)).toBeDefined();
      const caps = getCapabilitiesForModel("devin", m.id);
      expect(caps.contextWindow).toBeGreaterThan(0);
      if (m.id !== "claude-haiku-4-5") expect(caps.thinkingFormat).toBe("openai");
    }
    expect(MODEL_PRICING["swe-2-high"]).toMatchObject({ input: 0.75, output: 3.75, cached: 0.075 });
    expect(MODEL_PRICING["swe-1-7-lightning"]).toMatchObject({ input: 2.5, output: 12.5, cached: 1 });
    expect(MODEL_PRICING["swe-check"]).toMatchObject({ input: 0, output: 0, cached: 0 });
    expect(MODEL_CAPABILITIES["swe-1-6"].maxOutput).toBe(64000);
    expect(MODEL_CAPABILITIES["swe-1-6-fast"].maxOutput).toBe(128000);
    expect(MODEL_CAPABILITIES["swe-2-high"].maxOutput).toBeUndefined();
    expect(resolveProviderAlias("dv")).toBe("devin");
    expect(resolveProviderAlias("devin")).toBe("devin");
  });


  it("satisfies BaseExecutor contract methods", () => {
    const executor = new DevinExecutor();
    expect(executor.transformRequest()).toBeNull();
    expect(executor.buildUrl()).toBe(
      `${DEVIN_DEFAULT_BASE_URL}${DEVIN_CHAT_PATH}`
    );
    expect(executor.refreshCredentials()).toBeNull();
    expect(executor.needsRefresh()).toBe(false);
  });

  it("resolves and normalizes session tokens", () => {
    const executor = new DevinExecutor();
    expect(executor.resolveSessionToken({ apiKey: "abc123xyz" })).toBe(
      "devin-session-token$abc123xyz"
    );
    expect(
      executor.resolveSessionToken({
        accessToken: "devin-session-token$already-normalized",
      })
    ).toBe("devin-session-token$already-normalized");
    expect(executor.resolveSessionToken({})).toBeNull();
  });

  it("evaluates shouldRetry and computeRetryDelay correctly", () => {
    const executor = new DevinExecutor();
    expect(executor.shouldRetry(429)).toBe(true);
    expect(executor.shouldRetry(500)).toBe(true);
    expect(executor.shouldRetry(502)).toBe(true);
    expect(executor.shouldRetry(503)).toBe(true);
    expect(executor.shouldRetry(504)).toBe(true);
    expect(executor.shouldRetry(400)).toBe(false);
    expect(executor.shouldRetry(401)).toBe(false);
    expect(executor.shouldRetry(403)).toBe(false);
    expect(executor.shouldRetry(404)).toBe(false);
    expect(executor.shouldRetry(200)).toBe(false);

    // With retry-after header
    const mockHeaders = new Headers({ "retry-after": "7" });
    expect(executor.computeRetryDelay({ headers: mockHeaders }, 0)).toBe(7000);

    // Without retry-after header (exponential backoff)
    expect(executor.computeRetryDelay({}, 0)).toBe(1000);
    expect(executor.computeRetryDelay({}, 1)).toBe(2000);
    expect(executor.computeRetryDelay({}, 2)).toBe(4000);
  });
});

describe("DevinExecutor Execution & Wire Protocol", () => {
  let executor;
  let proxyFetchSpy;
  let savedHedge;

  beforeEach(() => {
    // Disable hedging for unit tests — existing tests mock single-request
    // flows and expect exactly one GetChatMessage call. Hedging behavior
    // is verified separately.
    savedHedge = process.env.DEVIN_HEDGE;
    process.env.DEVIN_HEDGE = "1";
    executor = new DevinExecutor();
    proxyFetchSpy = mocks.proxyAwareFetch;
    proxyFetchSpy.mockReset();
  });

  afterEach(() => {
    if (savedHedge === undefined) delete process.env.DEVIN_HEDGE;
    else process.env.DEVIN_HEDGE = savedHedge;
    vi.restoreAllMocks();
  });

  it("throws error when no session token is provided", async () => {
    await expect(
      executor.execute({
        model: "dv/swe-1-6",
        body: { messages: [{ role: "user", content: "hi" }] },
        credentials: {},
      })
    ).rejects.toThrow(/Devin requires an apiKey or accessToken/);
  });

  it("throws re-login error when GetUserJwt returns empty JWT", async () => {
    const emptyJwtPayload = toBinary(GetUserJwtResponseSchema, {
      userJwt: "",
    });

    proxyFetchSpy.mockResolvedValueOnce(
      new Response(emptyJwtPayload, {
        status: 200,
        headers: { "content-type": "application/proto" },
      })
    );

    await expect(
      executor.execute({
        model: "dv/swe-1-6",
        body: { messages: [{ role: "user", content: "hi" }] },
        credentials: { apiKey: "test_token" },
      })
    ).rejects.toThrow(/GetUserJwt returned an empty user JWT. Please re-login/);
  });

  it("GetUserJwt -> GetChatMessage happy path: emits valid OpenAI SSE", async () => {
    const userJwt = "test_user_jwt_value_123";
    const authPayload = toBinary(GetUserJwtResponseSchema, {
      userJwt,
      customApiServerUrl: "https://custom.server.codeium.com",
    });

    // 1. Mock GetUserJwt
    proxyFetchSpy.mockResolvedValueOnce(
      new Response(authPayload, {
        status: 200,
        headers: { "content-type": "application/proto" },
      })
    );

    // 2. Build Connect frames for GetChatMessage
    const frame1Payload = toBinary(GetChatMessageResponseSchema, {
      messageId: "msg_abc_123",
      actualModelUid: "swe-1-6",
      deltaText: "Hello",
    });
    const frame1 = buildConnectFrame(frame1Payload, true);

    const frame2Payload = toBinary(GetChatMessageResponseSchema, {
      deltaThinking: "Analyzing request...",
    });
    const frame2 = buildConnectFrame(frame2Payload, true);

    const frame3Payload = toBinary(GetChatMessageResponseSchema, {
      deltaText: " world!",
      stopReason: StopReason.STOP_PATTERN,
      usage: {
        inputTokens: 15n,
        outputTokens: 7n,
        cacheReadTokens: 5n,
        cacheWriteTokens: 0n,
      },
      creditCost: 4,
    });
    const frame3 = buildConnectFrame(frame3Payload, true);

    // End-stream trailer frame
    const trailerJson = Buffer.from(JSON.stringify({}));
    const trailerFrame = new Uint8Array(5 + trailerJson.length);
    trailerFrame[0] = 0x02; // End of stream flag
    new DataView(trailerFrame.buffer).setUint32(1, trailerJson.length, false);
    trailerFrame.set(trailerJson, 5);

    const streamBody = Buffer.concat([frame1, frame2, frame3, trailerFrame]);

    // Mock GetChatMessage
    proxyFetchSpy.mockResolvedValueOnce(
      new Response(createMockStream([streamBody]), {
        status: 200,
        headers: { "content-type": "application/connect+proto" },
      })
    );

    const result = await executor.execute({
      model: "dv/swe-1-6",
      body: {
        messages: [{ role: "user", content: "Hello!" }],
      },
      credentials: { apiKey: "raw_token" },
    });

    expect(result.url).toBe("https://custom.server.codeium.com" + DEVIN_CHAT_PATH);

    const events = await readSseResponse(result.response);
    expect(events.length).toBeGreaterThan(0);

    // Check [DONE] is the last event
    expect(events[events.length - 1]).toBe("[DONE]");

    const parsedChunks = events.slice(0, -1).map((e) => JSON.parse(e));

    // Chunk 1: text "Hello"
    expect(parsedChunks[0].choices[0].delta.content).toBe("Hello");
    expect(parsedChunks[0].id).toBe("msg_abc_123");
    expect(parsedChunks[0].model).toBe("swe-1-6");

    // Chunk 2: reasoning
    expect(parsedChunks[1].choices[0].delta.reasoning_content).toBe(
      "Analyzing request..."
    );

    // Chunk 3: text " world!"
    expect(parsedChunks[2].choices[0].delta.content).toBe(" world!");

    // Final chunk with usage and finish_reason
    const finalChunk = parsedChunks[3];
    expect(finalChunk.choices[0].finish_reason).toBe("stop");
    expect(finalChunk.usage).toEqual({
      prompt_tokens: 20, // inputTokens (15) + cacheReadTokens (5)
      completion_tokens: 7,
      total_tokens: 27,
      prompt_tokens_details: {
        cached_tokens: 5,
      },
      credit_cost: 4,
    });
  });

  it("multi-turn tool exchange: properly maps SYSTEM assistant with toolCalls, TOOL result, omits thinking, fresh UUIDs", async () => {
    let capturedChatBody = null;

    proxyFetchSpy.mockImplementation(async (url, options) => {
      if (url.includes(DEVIN_AUTH_PATH)) {
        return new Response(
          toBinary(GetUserJwtResponseSchema, { userJwt: "jwt_turn2" }),
          { status: 200 }
        );
      }
      if (url.includes(DEVIN_CHAT_PATH)) {
        capturedChatBody = options.body;
        // Return minimal stream
        const f1 = buildConnectFrame(
          toBinary(GetChatMessageResponseSchema, {
            deltaText: "Done!",
            stopReason: StopReason.STOP_PATTERN,
          }),
          true
        );
        return new Response(createMockStream([f1]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const messages = [
      { role: "system", content: "You are Devin." },
      { role: "user", content: "Read test.txt" },
      {
        role: "assistant",
        content: "Checking file...",
        thinking: "Secret internal thinking that must NOT be replayed",
        signature: "secret_sig",
        tool_calls: [
          {
            id: "call_read_1",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "test.txt" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_read_1",
        content: "File contents: hello world",
      },
      {
        role: "tool",
        tool_call_id: "call_read_fail",
        content: "Error: File not found",
      },
      { role: "user", content: "What was inside?" },
    ];

    const result = await executor.execute({
      model: "devin/swe-1-6",
      body: { messages },
      credentials: { apiKey: "tok" },
    });

    await readSseResponse(result.response);

    expect(capturedChatBody).toBeDefined();

    // Decompress the Connect frame body to inspect GetChatMessageRequest
    const flag = capturedChatBody[0];
    expect(flag).toBe(0x01); // Gzip compressed Connect frame
    const payloadLen = new DataView(capturedChatBody.buffer, capturedChatBody.byteOffset).getUint32(1, false);
    const compressedPayload = capturedChatBody.subarray(5, 5 + payloadLen);
    const decompressed = zlib.gunzipSync(compressedPayload);

    const req = fromBinary(GetChatMessageRequestSchema, decompressed);

    // 1. Top-level prompt is system prompt
    expect(req.prompt).toBe("You are Devin.");

    // Conversational planner mode is always set on chat requests
    expect(req.plannerMode).toBe(ConversationalPlannerMode.DEFAULT);


    // 2. ChatMessagePrompts mapping
    expect(req.chatMessagePrompts).toHaveLength(5);

    // User turn 1
    expect(req.chatMessagePrompts[0].source).toBe(ChatMessageSource.USER);
    expect(req.chatMessagePrompts[0].prompt).toBe("Read test.txt");

    // Assistant turn: mapped to SYSTEM, toolCalls present, thinking and signature empty
    const assistantTurn = req.chatMessagePrompts[1];
    expect(assistantTurn.source).toBe(ChatMessageSource.SYSTEM);
    expect(assistantTurn.prompt).toBe("Checking file...");
    expect(assistantTurn.thinking || "").toBe(""); // Invariant: NEVER replay thinking
    expect(assistantTurn.signature || "").toBe(""); // Invariant: NEVER replay signature
    expect(assistantTurn.toolCalls).toHaveLength(1);
    expect(assistantTurn.toolCalls[0].id).toBe("call_read_1");
    expect(assistantTurn.toolCalls[0].name).toBe("read_file");
    expect(assistantTurn.toolCalls[0].argumentsJson).toBe('{"path":"test.txt"}');

    // Tool turn 1 (success)
    const toolTurn1 = req.chatMessagePrompts[2];
    expect(toolTurn1.source).toBe(ChatMessageSource.TOOL);
    expect(toolTurn1.toolCallId).toBe("call_read_1");
    expect(Boolean(toolTurn1.toolResultIsError)).toBe(false);
    expect(toolTurn1.prompt).toBe("File contents: hello world");

    // Tool turn 2 (error)
    const toolTurn2 = req.chatMessagePrompts[3];
    expect(toolTurn2.source).toBe(ChatMessageSource.TOOL);
    expect(toolTurn2.toolCallId).toBe("call_read_fail");
    expect(toolTurn2.toolResultIsError).toBe(true);

    // User turn 2
    expect(req.chatMessagePrompts[4].source).toBe(ChatMessageSource.USER);
    expect(req.chatMessagePrompts[4].prompt).toBe("What was inside?");

    // Fresh cascadeId per execution; direct concrete models ride the lane
    // without any assignment binding.
    expect(req.cascadeId).toMatch(UUID_PATTERN);
    expect(req.modelAssignmentJwt).toBeUndefined();


    // MessageIds are deterministic UUIDs
    for (const p of req.chatMessagePrompts) {
      expect(p.messageId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    }
  });
  it("router model: auth -> AssignModel -> chat forwards the assignment on the same cascade", async () => {
    const controller = new AbortController();
    const proxyOptions = { proxy: "http://proxy.local:8080" };
    const calls = serveDevinEdge({
      chat: () =>
        new Response(
          createMockStream([
            chatStream(
              buildConnectFrame(
                toBinary(GetChatMessageResponseSchema, { messageId: "msg-1", deltaText: "Hello" }),
                true
              ),
              buildConnectFrame(
                toBinary(GetChatMessageResponseSchema, {
                  deltaText: " world",
                  actualModelUid: "gpt-5-codex",
                  stopReason: StopReason.STOP_PATTERN,
                }),
                true
              )
            ),
          ]),
          { status: 200, headers: { "content-type": "application/connect+proto" } }
        ),
    });

    const result = await executor.execute({
      model: "dv/adaptive",
      body: {
        messages: [
          { role: "system", content: "You are Devin." },
          { role: "user", content: "older turn" },
 { role: "assistant", content: "ok" },
          {
            role: "user",
            content: [
              { type: "text", text: "route me" },
              { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2VkYXRh" } },
            ],
          },
        ],
      },
      credentials: { apiKey: "tok" },
      signal: controller.signal,
      proxyOptions,
    });

    // Call order, auth-selected custom base for BOTH assignment and chat,
    // shared proxy/signal.
    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_ASSIGN_MODEL_PATH, DEVIN_CHAT_PATH]);
    expect(calls[1].url).toBe("https://custom.server.codeium.com" + DEVIN_ASSIGN_MODEL_PATH);
    expect(calls[2].url).toBe("https://custom.server.codeium.com" + DEVIN_CHAT_PATH);
    for (const call of calls) {
      expect(call.proxyOptions).toBe(proxyOptions);
      expect(call.options.signal).toBe(controller.signal);
    }

    // Assignment request: router uid + cascadeId + session credential without
    // userJwt, scoring only the last user turn (text + inline image).
    const assign = decodeAssignRequest(calls[1]);
    expect(assign.modelRouterUid).toBe("adaptive");
    expect(assign.cascadeId).toMatch(UUID_PATTERN);
    expect(assign.metadata).toMatchObject({
      ideType: "chisel",
      apiKey: "devin-session-token$tok",
    });
    expect(assign.metadata.userJwt).toBeFalsy();
    expect(assign.chatMessagePrompt.messageId ?? "").toBe("");
    expect(assign.chatMessagePrompt).toMatchObject({
      source: ChatMessageSource.USER,
      prompt: "route me",
    });
    expect(assign.chatMessagePrompt.images[0]).toMatchObject({
      mimeType: "image/png",
      base64Data: "aW1hZ2VkYXRh",
    });

    // Chat request: concrete uid + assignment jwt on the SAME cascadeId, full
    // history still mapped, adaptive's 64000 registry cap applied.
    const chat = decodeChatRequest(calls[2]);
    expect(chat.chatModelUid).toBe("claude-sonnet-4-5");
    expect(chat.modelAssignmentJwt).toBe("assign-jwt");
    expect(chat.cascadeId).toBe(assign.cascadeId);
    expect(chat.metadata.userJwt).toBe("user-jwt");
    expect(chat.requestType).toBe(ChatMessageRequestType.CASCADE);
    expect(chat.prompt).toBe("You are Devin.");
    expect(chat.chatMessagePrompts).toHaveLength(3);
    expect(chat.chatMessagePrompts[2]).toMatchObject({
      source: ChatMessageSource.USER,
      prompt: "route me",
    });

    // SSE: chunks start under the assigned uid; an actualModelUid frame wins.
    const events = await readSseResponse(result.response);
    expect(events[events.length - 1]).toBe("[DONE]");
    const parsed = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(parsed[0].model).toBe("claude-sonnet-4-5");
    expect(parsed[1].model).toBe("gpt-5-codex");
  });

  it("router prompt scores the last user/developer turn, not the mapped history", async () => {
    const calls = serveDevinEdge();

    await executor.execute({
      model: "dv/adaptive",
      body: {
        messages: [
          { role: "user", content: "older user turn" },
          { role: "developer", content: "Route on the developer instruction" },
        ],
      },
      credentials: { apiKey: "tok" },
    });

    const assign = decodeAssignRequest(calls[1]);
    expect(assign.chatMessagePrompt.messageId ?? "").toBe("");
    expect(assign.chatMessagePrompt).toMatchObject({
      source: ChatMessageSource.USER,
      prompt: "Route on the developer instruction",
    });

    // mapMessages folds developer text into the system prompt, so the
    // assignment prompt must come from the raw message scan instead.
    const chat = decodeChatRequest(calls[2]);
    expect(chat.prompt).toBe("Route on the developer instruction");
    expect(chat.chatMessagePrompts).toHaveLength(1);
    expect(chat.chatMessagePrompts[0].prompt).toBe("older user turn");
  });

  it("fails closed when the assignment carries no concrete uid/jwt: no chat", async () => {
    const calls = serveDevinEdge({
      assignment: () =>
        new Response(
          toBinary(AssignModelResponseSchema, { assignment: { assignmentJwt: "", modelUid: "" } }),
          { status: 200, headers: { "content-type": "application/proto" } }
        ),
    });

    await expect(
      executor.execute({
        model: "dv/adaptive",
        body: { messages: [{ role: "user", content: "hi" }] },
        credentials: { apiKey: "tok" },
      })
    ).rejects.toThrow();

    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_ASSIGN_MODEL_PATH]);
  });

  it("fails closed when the server echoes the router uid: no chat", async () => {
    const calls = serveDevinEdge({
      assignment: () =>
        new Response(
          toBinary(AssignModelResponseSchema, { assignment: { assignmentJwt: "jwt", modelUid: "adaptive" } }),
          { status: 200, headers: { "content-type": "application/proto" } }
        ),
    });

    await expect(
      executor.execute({
        model: "dv/adaptive",
        body: { messages: [{ role: "user", content: "hi" }] },
        credentials: { apiKey: "tok" },
      })
    ).rejects.toThrow();

    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_ASSIGN_MODEL_PATH]);
  });

  it("fails closed when assignment fails over HTTP: no chat, no retry", async () => {
    const calls = serveDevinEdge({
      assignment: () => new Response("forbidden", { status: 403 }),
    });

    await expect(
      executor.execute({
        model: "dv/adaptive",
        body: { messages: [{ role: "user", content: "hi" }] },
        credentials: { apiKey: "tok" },
      })
    ).rejects.toThrow(/AssignModel/);

    expect(calls).toHaveLength(2);
    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_ASSIGN_MODEL_PATH]);
  });

  it("fails closed when the assignment payload is undecodable: no chat", async () => {
    const calls = serveDevinEdge({
      assignment: () =>
        new Response(Buffer.from([0xff, 0xff, 0xff]), {
          status: 200,
          headers: { "content-type": "application/proto" },
        }),
    });

    await expect(
      executor.execute({
        model: "dv/adaptive",
        body: { messages: [{ role: "user", content: "hi" }] },
        credentials: { apiKey: "tok" },
      })
    ).rejects.toThrow();

    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_ASSIGN_MODEL_PATH]);
  });

  it("preserves cancellation before any upstream call when already aborted", async () => {
    const calls = serveDevinEdge();
    const controller = new AbortController();
    controller.abort(new Error("Client disconnected"));

    await expect(
      executor.execute({
        model: "dv/adaptive",
        body: { messages: [{ role: "user", content: "hi" }] },
        credentials: { apiKey: "tok" },
        signal: controller.signal,
      })
    ).rejects.toThrow(/Client disconnected/);

    expect(calls).toHaveLength(0);
  });

  it("direct model keeps the CASCADE wire profile, honors caller overrides, and never assigns", async () => {
    const calls = serveDevinEdge();

    const result = await executor.execute({
      model: "dv/swe-2-high",
      body: {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 777,
        temperature: 0.9,
        top_p: 0.5,
        stop: "END_TURN",
      },
      credentials: { apiKey: "tok" },
    });

    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_CHAT_PATH]);
    expect(result.url).toBe("https://custom.server.codeium.com" + DEVIN_CHAT_PATH);

    const chat = decodeChatRequest(calls[1]);
    expect(chat.chatModelUid).toBe("swe-2-high");
    expect(chat.modelAssignmentJwt).toBeUndefined();
    expect(chat.requestType).toBe(ChatMessageRequestType.CASCADE);
    expect(chat.plannerMode).toBe(ConversationalPlannerMode.DEFAULT);
    expect(chat.metadata).toMatchObject({
      ideName: "devin-cli",
      userJwt: "user-jwt",
    });
    expect(chat.cascadeId).toMatch(UUID_PATTERN);
    expect(chat.executionId).toMatch(UUID_PATTERN);
    expect(chat.toolChoice?.optionName).toBe("auto");
    expect(chat.systemPromptCacheOptions?.type).toBe(PromptCacheType.EPHEMERAL);
    // swe-2-high advertises parallel tool calls; serial models flip this to true.
    expect(chat.disableParallelToolCalls ?? false).toBe(false);
    expect(chat.configuration.maxTokens).toBe(777n);
    expect(chat.configuration.temperature).toBe(0.9);
    expect(chat.configuration.firstTemperature).toBe(0.9);
    expect(chat.configuration.topP).toBe(0.5);
    expect(chat.configuration.stopPatterns).toContain("END_TURN");

    const events = await readSseResponse(result.response);
    expect(events[events.length - 1]).toBe("[DONE]");
  });

  it("routes an unknown/discovered model UID through the direct lane without assignment", async () => {
    const calls = serveDevinEdge({
      chat: () => new Response(
        createMockStream([
          chatStream(buildConnectFrame(toBinary(GetChatMessageResponseSchema, {
            deltaText: "Direct model answer.",
            stopReason: StopReason.STOP_PATTERN,
          }), true)),
        ]),
        { status: 200, headers: { "content-type": "application/connect+proto" } }
      ),
    });

    const result = await executor.execute({
      model: "dv/discovered-only-model",
      body: { messages: [{ role: "user", content: "hello discovered lane" }] },
      credentials: { apiKey: "tok" },
    });

    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_CHAT_PATH]);
    const chat = decodeChatRequest(calls[1]);
    expect(chat.chatModelUid).toBe("discovered-only-model");
    expect(chat.modelAssignmentJwt).toBeUndefined();

    const events = await readSseResponse(result.response);
    expect(events[events.length - 1]).toBe("[DONE]");
    const parsed = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(parsed.some((event) => event.error)).toBe(false);
    expect(parsed.map((event) => event.choices?.[0]?.delta?.content ?? "").join("")).toBe("Direct model answer.");
  });

  it("streaming tool-call argument accumulation across multiple frames", async () => {
    proxyFetchSpy.mockResolvedValueOnce(
      new Response(toBinary(GetUserJwtResponseSchema, { userJwt: "jwt_tools" }), {
        status: 200,
      })
    );

    // Frame 1: deltaToolCalls for call_1 (first part of args)
    const f1 = buildConnectFrame(
      toBinary(GetChatMessageResponseSchema, {
        messageId: "msg_tool_1",
        deltaToolCalls: [
          {
            id: "call_1",
            name: "execute_bash",
            argumentsJson: '{"command":',
          },
        ],
      }),
      true
    );

    // Frame 2: deltaToolCalls for call_1 (second part of args)
    const f2 = buildConnectFrame(
      toBinary(GetChatMessageResponseSchema, {
        deltaToolCalls: [
          {
            id: "call_1",
            argumentsJson: '"ls -la"}',
          },
        ],
      }),
      true
    );

    // Frame 3: second tool call call_2 and FUNCTION_CALL stopReason
    const f3 = buildConnectFrame(
      toBinary(GetChatMessageResponseSchema, {
        deltaToolCalls: [
          {
            id: "call_2",
            name: "read_file",
            argumentsJson: '{"path":"a.txt"}',
          },
        ],
        stopReason: StopReason.FUNCTION_CALL,
      }),
      true
    );

    // Trailer frame
    const trailerJson = Buffer.from(JSON.stringify({}));
    const trailerFrame = new Uint8Array(5 + trailerJson.length);
    trailerFrame[0] = 0x02;
    new DataView(trailerFrame.buffer).setUint32(1, trailerJson.length, false);
    trailerFrame.set(trailerJson, 5);

    proxyFetchSpy.mockResolvedValueOnce(
      new Response(createMockStream([Buffer.concat([f1, f2, f3, trailerFrame])]), {
        status: 200,
        headers: { "content-type": "application/connect+proto" },
      })
    );

    const result = await executor.execute({
      model: "dv/swe-1-6",
      body: { messages: [{ role: "user", content: "List files" }] },
      credentials: { apiKey: "tok" },
    });

    const events = await readSseResponse(result.response);
    const parsedChunks = events.slice(0, -1).map((e) => JSON.parse(e));

    // Chunk 1: call_1 initial tool call with id and name
    expect(parsedChunks[0].choices[0].delta.tool_calls).toEqual([
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: {
          name: "execute_bash",
          arguments: '{"command":',
        },
      },
    ]);

    // Chunk 2: call_1 continuation: arguments only, no id or name
    expect(parsedChunks[1].choices[0].delta.tool_calls).toEqual([
      {
        index: 0,
        function: {
          arguments: '"ls -la"}',
        },
      },
    ]);

    // Chunk 3: call_2 initial tool call with index 1
    expect(parsedChunks[2].choices[0].delta.tool_calls).toEqual([
      {
        index: 1,
        id: "call_2",
        type: "function",
        function: {
          name: "read_file",
          arguments: '{"path":"a.txt"}',
        },
      },
    ]);

    // Final chunk has finish_reason: "tool_calls"
    const finalChunk = parsedChunks[3];
    expect(finalChunk.choices[0].finish_reason).toBe("tool_calls");
  });

  it("id-less continuation frames merge into the active tool call (OMP parity)", async () => {
    proxyFetchSpy.mockResolvedValueOnce(
      new Response(toBinary(GetUserJwtResponseSchema, { userJwt: "jwt_noid" }), {
        status: 200,
      })
    );

    const f1 = buildConnectFrame(
      toBinary(GetChatMessageResponseSchema, {
        messageId: "msg_noid",
        deltaToolCalls: [{ id: "call_x", name: "write_file", argumentsJson: '{"path"' }],
      }),
      true
    );
    // Continuation frames carry NO id — must extend call_x, not mint new calls.
    const f2 = buildConnectFrame(
      toBinary(GetChatMessageResponseSchema, {
        deltaToolCalls: [{ argumentsJson: ':"x.txt",' }],
      }),
      true
    );
    const f3 = buildConnectFrame(
      toBinary(GetChatMessageResponseSchema, {
        deltaToolCalls: [{ argumentsJson: '"content":"hi"}' }],
        stopReason: StopReason.FUNCTION_CALL,
      }),
      true
    );

    const trailerJson = Buffer.from(JSON.stringify({}));
    const trailerFrame = new Uint8Array(5 + trailerJson.length);
    trailerFrame[0] = 0x02;
    new DataView(trailerFrame.buffer).setUint32(1, trailerJson.length, false);
    trailerFrame.set(trailerJson, 5);

    proxyFetchSpy.mockResolvedValueOnce(
      new Response(createMockStream([Buffer.concat([f1, f2, f3, trailerFrame])]), {
        status: 200,
        headers: { "content-type": "application/connect+proto" },
      })
    );

    const result = await executor.execute({
      model: "dv/swe-1-6",
      body: { messages: [{ role: "user", content: "Write a file" }] },
      credentials: { apiKey: "tok" },
    });

    const events = await readSseResponse(result.response);
    const parsedChunks = events.slice(0, -1).map((e) => JSON.parse(e));

    // Exactly one tool call: 3 tool chunks + final chunk, all index 0.
    expect(parsedChunks).toHaveLength(4);
    const toolChunks = parsedChunks.slice(0, 3).map((c) => c.choices[0].delta.tool_calls[0]);
    expect(toolChunks.map((tc) => tc.index)).toEqual([0, 0, 0]);
    expect(toolChunks[0].id).toBe("call_x");
    expect(toolChunks[1]).not.toHaveProperty("id");
    expect(toolChunks[2]).not.toHaveProperty("id");

    // Client-side concatenation of streamed arguments must stay valid JSON.
    const mergedArgs = toolChunks.map((tc) => tc.function.arguments).join("");
    expect(JSON.parse(mergedArgs)).toEqual({ path: "x.txt", content: "hi" });
    expect(parsedChunks[3].choices[0].finish_reason).toBe("tool_calls");
  });

  it("cumulative argumentsJson resend emits only the new suffix (OMP parity)", async () => {
    proxyFetchSpy.mockResolvedValueOnce(
      new Response(toBinary(GetUserJwtResponseSchema, { userJwt: "jwt_cumul" }), {
        status: 200,
      })
    );

    const f1 = buildConnectFrame(
      toBinary(GetChatMessageResponseSchema, {
        messageId: "msg_cumul",
        deltaToolCalls: [{ id: "call_c", name: "exec", argumentsJson: '{"a"' }],
      }),
      true
    );
    // Upstream resends the FULL accumulated JSON each frame.
    const f2 = buildConnectFrame(
      toBinary(GetChatMessageResponseSchema, {
        deltaToolCalls: [{ id: "call_c", argumentsJson: '{"a":1' }],
      }),
      true
    );
    const f3 = buildConnectFrame(
      toBinary(GetChatMessageResponseSchema, {
        deltaToolCalls: [{ id: "call_c", argumentsJson: '{"a":1,"b":2}' }],
        stopReason: StopReason.FUNCTION_CALL,
      }),
      true
    );

    const trailerJson = Buffer.from(JSON.stringify({}));
    const trailerFrame = new Uint8Array(5 + trailerJson.length);
    trailerFrame[0] = 0x02;
    new DataView(trailerFrame.buffer).setUint32(1, trailerJson.length, false);
    trailerFrame.set(trailerJson, 5);

    proxyFetchSpy.mockResolvedValueOnce(
      new Response(createMockStream([Buffer.concat([f1, f2, f3, trailerFrame])]), {
        status: 200,
        headers: { "content-type": "application/connect+proto" },
      })
    );

    const result = await executor.execute({
      model: "dv/swe-1-6",
      body: { messages: [{ role: "user", content: "Run" }] },
      credentials: { apiKey: "tok" },
    });

    const events = await readSseResponse(result.response);
    const parsedChunks = events.slice(0, -1).map((e) => JSON.parse(e));
    const toolChunks = parsedChunks.slice(0, -1).map((c) => c.choices[0].delta.tool_calls[0]);

    // Each streamed arguments value must be ONLY the new suffix, so plain
    // concatenation (what every OpenAI client does) reconstructs valid JSON.
    expect(toolChunks[0].function.arguments).toBe('{"a"');
    expect(toolChunks[1].function.arguments).toBe(":1");
    expect(toolChunks[2].function.arguments).toBe(',"b":2}');
    expect(JSON.parse(toolChunks.map((tc) => tc.function.arguments).join(""))).toEqual({
      a: 1,
      b: 2,
    });
  });

  it("maps stopReason MAX_TOKENS to length", async () => {
    proxyFetchSpy.mockResolvedValueOnce(
      new Response(toBinary(GetUserJwtResponseSchema, { userJwt: "jwt_stop" }), {
        status: 200,
      })
    );

    const f1 = buildConnectFrame(
      toBinary(GetChatMessageResponseSchema, {
        deltaText: "Hit limit",
        stopReason: StopReason.MAX_TOKENS,
      }),
      true
    );

    proxyFetchSpy.mockResolvedValueOnce(
      new Response(createMockStream([f1]), {
        status: 200,
      })
    );

    const result = await executor.execute({
      model: "dv/swe-1-6",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: { apiKey: "tok" },
    });

    const events = await readSseResponse(result.response);
    const parsedChunks = events.slice(0, -1).map((e) => JSON.parse(e));
    const finalChunk = parsedChunks[parsedChunks.length - 1];
    expect(finalChunk.choices[0].finish_reason).toBe("length");
  });

  it("surfaces Connect trailer error", async () => {
    proxyFetchSpy.mockResolvedValueOnce(
      new Response(toBinary(GetUserJwtResponseSchema, { userJwt: "jwt_err" }), {
        status: 200,
      })
    );

    const trailerPayload = Buffer.from(
      JSON.stringify({
        error: {
          code: "permission_denied",
          message: "User session expired or unauthorized",
        },
      })
    );
    const trailerFrame = new Uint8Array(5 + trailerPayload.length);
    trailerFrame[0] = 0x02;
    new DataView(trailerFrame.buffer).setUint32(1, trailerPayload.length, false);
    trailerFrame.set(trailerPayload, 5);

    proxyFetchSpy.mockResolvedValueOnce(
      new Response(createMockStream([trailerFrame]), {
        status: 200,
      })
    );

    const result = await executor.execute({
      model: "dv/swe-1-6",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: { apiKey: "tok" },
    });

    // Upstream trailer errors surface as a well-formed SSE error event and terminate
    // without appending [DONE] (locked P-DEVIN policy).
    const events = await readSseResponse(result.response);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0])).toEqual({
      error: {
        message: "Devin stream error [permission_denied]: User session expired or unauthorized",
        type: "upstream_error",
      },
    });
    expect(events).not.toContain("[DONE]");
  });

  it("classifies pre-first-token trailer invalid_argument with >=512KiB history as context-overflow", async () => {
    proxyFetchSpy.mockResolvedValueOnce(
      new Response(toBinary(GetUserJwtResponseSchema, { userJwt: "jwt_large" }), {
        status: 200,
      })
    );

    const trailerPayload = Buffer.from(
      JSON.stringify({
        error: {
          code: "invalid_argument",
          message: "Internal error during cascade execution",
        },
      })
    );
    const trailerFrame = new Uint8Array(5 + trailerPayload.length);
    trailerFrame[0] = 0x02;
    new DataView(trailerFrame.buffer).setUint32(1, trailerPayload.length, false);
    trailerFrame.set(trailerPayload, 5);

    proxyFetchSpy.mockResolvedValueOnce(
      new Response(createMockStream([trailerFrame]), {
        status: 200,
      })
    );

    // Create a large body that results in >= 512KiB protobuf
    const largeContent = "A".repeat(550 * 1024);
    const result = await executor.execute({
      model: "dv/swe-1-6",
      body: { messages: [{ role: "user", content: largeContent }] },
      credentials: { apiKey: "tok" },
    });

    const events2 = await readSseResponse(result.response);
    expect(events2).toHaveLength(1);
    expect(JSON.parse(events2[0])).toEqual({
      error: {
        message: "Devin context overflow error: Internal error during cascade execution",
        type: "upstream_error",
      },
    });
    expect(events2).not.toContain("[DONE]");
  });

  it("aborts mid-stream: reader cancelled, clean error, no retry", async () => {
    proxyFetchSpy.mockResolvedValueOnce(
      new Response(toBinary(GetUserJwtResponseSchema, { userJwt: "jwt_abort" }), {
        status: 200,
      })
    );

    const abortController = new AbortController();

    // Stream that yields one frame then aborts
    const f1 = buildConnectFrame(
      toBinary(GetChatMessageResponseSchema, {
        deltaText: "Start text",
      }),
      true
    );
    let cancelCalled = false;
    let timer = null;
    const slowStream = new ReadableStream({
      start(controller) {
        controller.enqueue(f1);
        timer = setTimeout(() => {
          abortController.abort(new Error("Client disconnected"));
        }, 20);
      },
      cancel() {
        cancelCalled = true;
        clearTimeout(timer);
      },
    });
    proxyFetchSpy.mockResolvedValueOnce(
      new Response(slowStream, { status: 200 })
    );

    const result = await executor.execute({
      model: "dv/swe-1-6",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: { apiKey: "tok" },
      signal: abortController.signal,
    });

    await expect(readSseResponse(result.response)).rejects.toThrow(
      /Client disconnected|Stream aborted|aborted/
    );

    // Verify proxyFetchSpy was only called twice (GetUserJwt and GetChatMessage), no retries
    expect(proxyFetchSpy).toHaveBeenCalledTimes(2);
    expect(cancelCalled).toBe(true);
  });

  it("replays reasoning_content and reasoning_signature from assistant history (thinking round-trip)", async () => {
    let capturedChatBody = null;

    proxyFetchSpy.mockImplementation(async (url, options) => {
      if (url.includes(DEVIN_AUTH_PATH)) {
        return new Response(
          toBinary(GetUserJwtResponseSchema, { userJwt: "jwt_rt" }),
          { status: 200 }
        );
      }
      if (url.includes(DEVIN_CHAT_PATH)) {
        capturedChatBody = options.body;
        const f1 = buildConnectFrame(
          toBinary(GetChatMessageResponseSchema, {
            deltaText: "OK",
            stopReason: StopReason.STOP_PATTERN,
          }),
          true
        );
        return new Response(createMockStream([f1]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const messages = [
      { role: "user", content: "Think step by step" },
      {
        role: "assistant",
        content: "Here is the answer",
        reasoning_content: "I considered all options carefully",
        reasoning_signature: "sig_abc123",
        reasoning_signature_type: "openai",
        tool_calls: [],
      },
      { role: "user", content: "Continue" },
    ];

    const result = await executor.execute({
      model: "devin/swe-1-6",
      body: { messages },
      credentials: { apiKey: "tok" },
    });

    await readSseResponse(result.response);

    expect(capturedChatBody).toBeDefined();
    const flag = capturedChatBody[0];
    expect(flag).toBe(0x01);
    const payloadLen = new DataView(capturedChatBody.buffer, capturedChatBody.byteOffset).getUint32(1, false);
    const decompressed = zlib.gunzipSync(capturedChatBody.subarray(5, 5 + payloadLen));
    const req = fromBinary(GetChatMessageRequestSchema, decompressed);

    // Assistant turn: thinking + signature replayed from reasoning_content / reasoning_signature
    const assistantTurn = req.chatMessagePrompts[1];
    expect(assistantTurn.source).toBe(ChatMessageSource.SYSTEM);
    expect(assistantTurn.thinking).toBe("I considered all options carefully");
    expect(assistantTurn.signature).toBe("sig_abc123");
    expect(assistantTurn.signatureType).toBe("openai");
  });

  it("emits reasoning_signature, reasoning_signature_type, and reasoning_redacted as SSE delta fields", async () => {
    proxyFetchSpy.mockImplementation(async (url) => {
      if (url.includes(DEVIN_AUTH_PATH)) {
        return new Response(
          toBinary(GetUserJwtResponseSchema, { userJwt: "jwt_sig" }),
          { status: 200 }
        );
      }
      if (url.includes(DEVIN_CHAT_PATH)) {
        const f1 = buildConnectFrame(
          toBinary(GetChatMessageResponseSchema, {
            deltaThinking: "Reasoning here",
            deltaSignature: "sig_xyz",
            deltaSignatureType: "openai",
            thinkingRedacted: true,
          }),
          true
        );
        const f2 = buildConnectFrame(
          toBinary(GetChatMessageResponseSchema, {
            deltaText: "Answer",
            stopReason: StopReason.STOP_PATTERN,
          }),
          true
        );
        return new Response(createMockStream([f1, f2]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await executor.execute({
      model: "devin/swe-1-6",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: { apiKey: "tok" },
    });

    const events = await readSseResponse(result.response);
    const parsedChunks = events.slice(0, -1).map((e) => JSON.parse(e));

    // Signature emitted as custom delta field
    const sigChunk = parsedChunks.find(c => c.choices[0].delta.reasoning_signature);
    expect(sigChunk).toBeDefined();
    expect(sigChunk.choices[0].delta.reasoning_signature).toBe("sig_xyz");

    // Signature type emitted
    const sigTypeChunk = parsedChunks.find(c => c.choices[0].delta.reasoning_signature_type);
    expect(sigTypeChunk).toBeDefined();
    expect(sigTypeChunk.choices[0].delta.reasoning_signature_type).toBe("openai");

    // Thinking redacted flag emitted
    const redactedChunk = parsedChunks.find(c => c.choices[0].delta.reasoning_redacted);
    expect(redactedChunk).toBeDefined();
    expect(redactedChunk.choices[0].delta.reasoning_redacted).toBe(true);
  });

  it("hedges SWE models: fires N requests, first data frame wins", async () => {
    // Enable hedging for this test
    process.env.DEVIN_HEDGE = "3";

    let chatCallCount = 0;

    proxyFetchSpy.mockImplementation(async (url) => {
      if (url.includes(DEVIN_AUTH_PATH)) {
        return new Response(
          toBinary(GetUserJwtResponseSchema, { userJwt: "jwt_hedge" }),
          { status: 200 }
        );
      }
      if (url.includes(DEVIN_CHAT_PATH)) {
        chatCallCount++;

        // Requests 1 and 2: slow (delayed stream)
        if (chatCallCount <= 2) {
          const slowStream = new ReadableStream({
            start(controller) {
              setTimeout(() => {
                const f = buildConnectFrame(
                  toBinary(GetChatMessageResponseSchema, {
                    deltaText: `slow_${chatCallCount}`,
                    stopReason: StopReason.STOP_PATTERN,
                  }),
                  true
                );
                controller.enqueue(f);
                controller.close();
              }, 200);
            },
          });
          return new Response(slowStream, { status: 200 });
        }

        // Request 3: fast (immediate stream) — should win the race
        const f1 = buildConnectFrame(
          toBinary(GetChatMessageResponseSchema, {
            deltaText: "fast_response",
            stopReason: StopReason.STOP_PATTERN,
          }),
          true
        );
        return new Response(createMockStream([f1]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await executor.execute({
      model: "devin/swe-1-6",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: { apiKey: "tok" },
    });

    const events = await readSseResponse(result.response);
    const parsedChunks = events.slice(0, -1).map((e) => JSON.parse(e));

    // 3 hedged GetChatMessage + 1 GetUserJwt = 4 total calls
    expect(proxyFetchSpy).toHaveBeenCalledTimes(4);

    // The fast (3rd) request should win — its content appears in the response
    const textChunks = parsedChunks.filter(c => c.choices[0].delta.content);
    expect(textChunks.length).toBeGreaterThan(0);
    expect(textChunks[0].choices[0].delta.content).toBe("fast_response");
  });

  it("hedgeCount: DEVIN_HEDGE env overrides, SWE models default to 3, others to 1", () => {
    const saved = process.env.DEVIN_HEDGE;

    delete process.env.DEVIN_HEDGE;
    expect(executor.hedgeCount("swe-1-6")).toBe(3);
    expect(executor.hedgeCount("swe-2-high")).toBe(3);
    expect(executor.hedgeCount("claude-sonnet-4-5")).toBe(1);
    expect(executor.hedgeCount("adaptive")).toBe(1);

    process.env.DEVIN_HEDGE = "2";
    expect(executor.hedgeCount("swe-1-6")).toBe(2);
    expect(executor.hedgeCount("claude-sonnet-4-5")).toBe(2);

    process.env.DEVIN_HEDGE = "1";
    expect(executor.hedgeCount("swe-1-6")).toBe(1);

    process.env.DEVIN_HEDGE = "10"; // out of range → 1
    expect(executor.hedgeCount("swe-1-6")).toBe(1);

    process.env.DEVIN_HEDGE = "abc"; // invalid → 1
    expect(executor.hedgeCount("swe-1-6")).toBe(1);

    if (saved === undefined) delete process.env.DEVIN_HEDGE;
    else process.env.DEVIN_HEDGE = saved;
  });
});

describe("Devin effort routing (variant collapse)", () => {
  let executor;
  let proxyFetchSpy;
  let savedHedge;

  beforeEach(() => {
    savedHedge = process.env.DEVIN_HEDGE;
    process.env.DEVIN_HEDGE = "1";
    executor = new DevinExecutor();
    proxyFetchSpy = mocks.proxyAwareFetch;
    proxyFetchSpy.mockReset();
  });

  afterEach(() => {
    if (savedHedge === undefined) delete process.env.DEVIN_HEDGE;
    else process.env.DEVIN_HEDGE = savedHedge;
    vi.restoreAllMocks();
  });

  it("resolveEffort: source priority, normalization, and thinking-disabled", () => {
    expect(executor.resolveEffort({ reasoning_effort: "HIGH" })).toBe("high");
    expect(executor.resolveEffort({ reasoning: { effort: "Max" } })).toBe("max");
    expect(executor.resolveEffort({ output_config: { effort: "Medium" } })).toBe("medium");
    expect(executor.resolveEffort({ reasoning_effort: "none" })).toBe("off");
    // Explicit effort wins over a disabled-thinking flag.
    expect(executor.resolveEffort({ reasoning_effort: "high", thinking: { type: "disabled" } })).toBe("high");
    expect(executor.resolveEffort({ thinking: { type: "disabled" } })).toBe("off");
    expect(executor.resolveEffort({})).toBeNull();
    expect(executor.resolveEffort({ reasoning_effort: "   " })).toBeNull();
  });

  it("resolveWireUid: exact route, nearest clamp (ties lower), default member, passthrough", () => {
    const swe2 = getProviderModels("dv").find((m) => m.id === "swe-2");
    expect(executor.resolveWireUid(swe2, "medium")).toBe("swe-2-medium");
    expect(executor.resolveWireUid(swe2, "high")).toBe("swe-2-high");
    expect(executor.resolveWireUid(swe2, "max")).toBe("swe-2-max");
    // Clamp: low/minimal → nearest routed tier (medium); xhigh ties between
    // high and max (dist 1 each) → clamps to the lower tier (high).
    expect(executor.resolveWireUid(swe2, "low")).toBe("swe-2-medium");
    expect(executor.resolveWireUid(swe2, "minimal")).toBe("swe-2-medium");
    expect(executor.resolveWireUid(swe2, "xhigh")).toBe("swe-2-high");
    // requiresEffort: no off tier upstream → default member, never "-none".
    expect(executor.resolveWireUid(swe2, "off")).toBe("swe-2-high");
    expect(executor.resolveWireUid(swe2, null)).toBe("swe-2-high");
    // Unknown effort string → default member.
    expect(executor.resolveWireUid(swe2, "banana")).toBe("swe-2-high");
    // Non-logical meta passes through; null meta yields null (caller falls
    // back to the raw wire model).
    expect(executor.resolveWireUid(getProviderModels("dv").find((m) => m.id === "swe-2-high"), "low")).toBe("swe-2-high");
    expect(executor.resolveWireUid(null, "high")).toBeNull();
  });

  it.each([
    ["medium", "swe-2-medium"],
    ["high", "swe-2-high"],
    ["max", "swe-2-max"],
  ])("swe-2 + reasoning_effort %s routes the exact sibling uid", async (effort, uid) => {
    const calls = serveDevinEdge();
    await executor.execute({
      model: "dv/swe-2",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: effort },
      credentials: { apiKey: "tok" },
    });
    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_CHAT_PATH]);
    expect(decodeChatRequest(calls[1]).chatModelUid).toBe(uid);
  });

  it("swe-2 without effort defaults to the recommended member", async () => {
    const calls = serveDevinEdge();
    await executor.execute({
      model: "dv/swe-2",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: { apiKey: "tok" },
    });
    expect(decodeChatRequest(calls[1]).chatModelUid).toBe("swe-2-high");
  });

  it("swe-2 effort none/off (requiresEffort) lands on the default member, never a -none uid", async () => {
    for (const effort of ["none", "off"]) {
      const calls = serveDevinEdge();
      await executor.execute({
        model: "dv/swe-2",
        body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: effort },
        credentials: { apiKey: "tok" },
      });
      const uid = decodeChatRequest(calls[1]).chatModelUid;
      expect(uid).toBe("swe-2-high");
      expect(uid).not.toContain("none");
    }
  });

  it("swe-2(low) clamps to the nearest routed tier", async () => {
    const calls = serveDevinEdge();
    await executor.execute({
      model: "dv/swe-2",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "low" },
      credentials: { apiKey: "tok" },
    });
    expect(decodeChatRequest(calls[1]).chatModelUid).toBe("swe-2-medium");
  });

  it("model(level) suffix strips and routes: swe-2(max) → swe-2-max", async () => {
    const calls = serveDevinEdge();
    await executor.execute({
      model: "dv/swe-2(max)",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: { apiKey: "tok" },
    });
    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_CHAT_PATH]);
    expect(decodeChatRequest(calls[1]).chatModelUid).toBe("swe-2-max");
  });

  it("raw sibling swe-2-high passes through even with effort set", async () => {
    const calls = serveDevinEdge();
    await executor.execute({
      model: "swe-2-high",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "low" },
      credentials: { apiKey: "tok" },
    });
    expect(decodeChatRequest(calls[1]).chatModelUid).toBe("swe-2-high");
  });

  it("adaptive still routes via AssignModel; effort never mangles the router path", async () => {
    const calls = serveDevinEdge();
    await executor.execute({
      model: "adaptive",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "max" },
      credentials: { apiKey: "tok" },
    });
    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_ASSIGN_MODEL_PATH, DEVIN_CHAT_PATH]);
    const chat = decodeChatRequest(calls[2]);
    expect(chat.chatModelUid).toBe("claude-sonnet-4-5");
    expect(chat.modelAssignmentJwt).toBe("assign-jwt");
    expect(chat.chatModelUid).not.toBe("adaptive");
  });

  it("honors reasoning:{effort} and output_config:{effort} sources end-to-end", async () => {
    let calls = serveDevinEdge();
    await executor.execute({
      model: "dv/swe-2",
      body: { messages: [{ role: "user", content: "hi" }], reasoning: { effort: "max" } },
      credentials: { apiKey: "tok" },
    });
    expect(decodeChatRequest(calls[1]).chatModelUid).toBe("swe-2-max");

    calls = serveDevinEdge();
    await executor.execute({
      model: "dv/swe-2",
      body: { messages: [{ role: "user", content: "hi" }], output_config: { effort: "medium" } },
      credentials: { apiKey: "tok" },
    });
    expect(decodeChatRequest(calls[1]).chatModelUid).toBe("swe-2-medium");
  });

  it("hedged payloads all carry the routed uid and routed-member parallel-tool flag", async () => {
    process.env.DEVIN_HEDGE = "3";
    const calls = serveDevinEdge();
    await executor.execute({
      model: "dv/swe-2",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
      credentials: { apiKey: "tok" },
    });
    const chatCalls = calls.filter((c) => new URL(c.url).pathname === DEVIN_CHAT_PATH);
    expect(chatCalls).toHaveLength(3);
    for (const call of chatCalls) {
      const chat = decodeChatRequest(call);
      expect(chat.chatModelUid).toBe("swe-2-high");
      // Routed member swe-2-high advertises parallel tool calls — the flag
      // must come from the routed member meta, not the logical entry.
      expect(chat.disableParallelToolCalls ?? false).toBe(false);
    }
  });

  it("provider aliases route through the family: dv/swe and dv/swe-1.7", async () => {
    let calls = serveDevinEdge();
    await executor.execute({
      model: "dv/swe",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "medium" },
      credentials: { apiKey: "tok" },
    });
    expect(decodeChatRequest(calls[1]).chatModelUid).toBe("swe-1-7-lightning-medium");

    // No effort → the kdl default-level tier (medium).
    calls = serveDevinEdge();
    await executor.execute({
      model: "dv/swe",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: { apiKey: "tok" },
    });
    expect(decodeChatRequest(calls[1]).chatModelUid).toBe("swe-1-7-lightning-medium");

    calls = serveDevinEdge();
    await executor.execute({
      model: "dv/swe-1.7",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "max" },
      credentials: { apiKey: "tok" },
    });
    expect(decodeChatRequest(calls[1]).chatModelUid).toBe("swe-1-7");
  });

  it("unknown logical id (server family absent from the static table) passes through raw", async () => {
    const calls = serveDevinEdge();
    await executor.execute({
      model: "dv/future-family-x",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
      credentials: { apiKey: "tok" },
    });
    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_CHAT_PATH]);
    expect(decodeChatRequest(calls[1]).chatModelUid).toBe("future-family-x");
  });

  it("maxTokens falls back to wire defaults when the routed member carries no cap", async () => {
    const calls = serveDevinEdge();
    await executor.execute({
      model: "dv/swe-2",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "max" },
      credentials: { apiKey: "tok" },
    });
    const chat = decodeChatRequest(calls[1]);
    expect(chat.chatModelUid).toBe("swe-2-max");
    // swe-2-max has no maxOutputTokens row → DEFAULT_MAX_TOKENS.
    expect(chat.configuration.maxTokens).toBe(128000n);
  });

  it("registry integrity: routing targets resolve, ids unique, siblings and pricing stay valid", () => {
    const models = getProviderModels("dv");
    for (const m of models) {
      if (!m.effortRouting) continue;
      expect(Array.isArray(m.efforts)).toBe(true);
      for (const uid of [...Object.values(m.effortRouting), m.defaultMember]) {
        expect(typeof uid).toBe("string");
        expect(uid.length).toBeGreaterThan(0);
      }
    }
    // swe-2 routes land on raw sibling rows in the static catalog.
    const swe2 = models.find((m) => m.id === "swe-2");
    for (const uid of Object.values(swe2.effortRouting)) {
      expect(models.some((x) => x.id === uid)).toBe(true);
    }
    const ids = models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Raw sibling ids and logical ids both validate; the swe-2 pricing row hits.
    expect(isValidModel("dv", "swe-2-high")).toBe(true);
    expect(isValidModel("dv", "swe-2")).toBe(true);
    expect(getPricingForModel("devin", "swe-2")).toMatchObject({ input: 0.75, output: 3.75, cached: 0.075 });
  });

  it("thinking levels follow the family ladders", async () => {
    const { getThinkingLevels } = await import("open-sse/providers/thinkingLevels.js");
    expect(getThinkingLevels("devin", "swe-2")).toEqual(["medium", "high", "max"]);
    expect(getThinkingLevels("devin", "swe-1-7")).toEqual(["medium", "max"]);
    expect(getThinkingLevels("devin", "claude-opus-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // Off-capable families expose none.
    expect(getThinkingLevels("devin", "gpt-5-6-terra")).toContain("none");
    // Other providers are untouched by the devin-scoped rows and caps.
    expect(getThinkingLevels("anthropic", "claude-opus-5")).toEqual(["none", "low", "medium", "high", "max"]);
  });
});

describe("Devin upstream content-policy sanitizer", () => {
  const ZCODE_SECURITY_PARAGRAPH =
    "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.";

  it("drops a system-prompt paragraph enumerating 2+ offensive-security terms", () => {
    const prompt = `You are ZCode, an interactive coding agent\n\n${ZCODE_SECURITY_PARAGRAPH}\n\n# Harness\n- Use tools well.`;
    const { text, droppedParagraphs } = sanitizeDevinSystemPrompt(prompt);
    expect(droppedParagraphs).toBe(1);
    expect(text).not.toContain("Dual-use security tools");
    expect(text).not.toContain("DoS attacks");
    expect(text).toContain("# Harness");
    expect(text).toContain("- Use tools well.");
  });

  it("neutralizes ZCode identity to Devin", () => {
    const { text, droppedParagraphs } = sanitizeDevinSystemPrompt(
      "You are an interactive ZCode agent.\n\n# ZCode Desktop Context\n- Be helpful."
    );
    expect(droppedParagraphs).toBe(0);
    expect(text).not.toMatch(/zcode/i);
    expect(text).toContain("You are an interactive Devin agent.");
    expect(text).toContain("# Devin Desktop Context");
  });

  it("leaves benign security-tooling prompts untouched", () => {
    const benign =
      "You are a coding agent.\n\nUse nmap, burp suite, and metasploit only in authorized lab engagements.\n\nRefuse clearly malicious work.";
    expect(sanitizeDevinSystemPrompt(benign)).toEqual({ text: benign, droppedParagraphs: 0 });
  });

  it("returns input unchanged for non-strings", () => {
    expect(sanitizeDevinSystemPrompt("").text).toBe("");
  });

  it("rewrites the tool-description '<name>_id parameter identifying' trigger", () => {
    const desc =
      "Waits for a task to finish.\n- Takes a task_id parameter identifying the task\n- timeout is optional.";
    expect(sanitizeDevinToolDescription(desc)).toBe(
      "Waits for a task to finish.\n- Takes a task_id argument identifying the task\n- timeout is optional."
    );
  });

  it("leaves benign tool descriptions untouched", () => {
    const desc = "Reads a file. path parameter is the file path to read.";
    expect(sanitizeDevinToolDescription(desc)).toBe(desc);
  });

  it("buildChatPayload sanitizes prompt and tool descriptions end-to-end", async () => {
    const executor = new DevinExecutor();
    const payload = executor.buildChatPayload({
      body: {
        messages: [
          { role: "system", content: `You are ZCode.\n\n${ZCODE_SECURITY_PARAGRAPH}` },
          { role: "user", content: "hi" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "TaskOutput",
              description: "Takes a task_id parameter identifying the task",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
      model: "swe-1-7",
      sessionToken: "tok",
      userJwt: "jwt",
      cascadeId: "c1",
    });
    expect(payload.prompt).not.toMatch(/zcode|Dual-use|DoS attacks/i);
    expect(payload.prompt).toContain("You are Devin.");
    expect(payload.tools[0].description).toBe(
      "Takes a task_id argument identifying the task"
    );
  });
});

describe("Devin Contract Residuals (DEV-01..04)", () => {
  let executor;
  let proxyFetchSpy;
  let savedHedge;

  beforeEach(() => {
    savedHedge = process.env.DEVIN_HEDGE;
    process.env.DEVIN_HEDGE = "1";
    executor = new DevinExecutor();
    proxyFetchSpy = mocks.proxyAwareFetch;
    proxyFetchSpy.mockReset();
  });

  afterEach(() => {
    if (savedHedge === undefined) delete process.env.DEVIN_HEDGE;
    else process.env.DEVIN_HEDGE = savedHedge;
    vi.restoreAllMocks();
  });

  describe("DEV-01: Model assignment semantics & base URL routing", () => {
    it("falls back to default base URL when GetUserJwt returns an unsanitary customApiServerUrl", async () => {
      const calls = [];
      proxyFetchSpy.mockImplementation(async (url, options) => {
        calls.push({ url, options });
        if (url.includes(DEVIN_AUTH_PATH)) {
          return new Response(
            toBinary(GetUserJwtResponseSchema, {
              userJwt: "jwt_sanitary_test",
              customApiServerUrl: "https://127.0.0.1:8443/evil", // Insecure loopback IP -> rejected
            }),
            { status: 200, headers: { "content-type": "application/proto" } }
          );
        }
        if (url.includes(DEVIN_CHAT_PATH)) {
          const frame = buildConnectFrame(
            toBinary(GetChatMessageResponseSchema, { deltaText: "Safe fallback" }),
            false
          );
          return new Response(createMockStream([frame]), {
            status: 200,
            headers: { "content-type": "application/connect+proto" },
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const result = await executor.execute({
        model: "swe-1-7",
        body: { messages: [{ role: "user", content: "hi" }] },
        credentials: { apiKey: "tok_test" },
      });

      const events = await readSseResponse(result.response);
      expect(events).toContain("[DONE]");
      expect(calls).toHaveLength(2);
      // Chat URL must NOT target the rejected customApiServerUrl
      expect(calls[1].url).toBe(`${DEVIN_DEFAULT_BASE_URL}${DEVIN_CHAT_PATH}`);
    });

    it("normalizes credentials and session tokens with surrounding whitespace and prefixes", () => {
      expect(executor.resolveSessionToken({ apiKey: "  my_secret_key  " })).toBe(
        "devin-session-token$my_secret_key"
      );
      expect(
        executor.resolveSessionToken({ accessToken: "devin-session-token$session_123" })
      ).toBe("devin-session-token$session_123");
      expect(executor.resolveSessionToken({})).toBeNull();
    });

    it("resolves model IDs correctly across alias prefixes", () => {
      expect(executor.resolveModelId("dv/swe-1-6")).toBe("swe-1-6");
      expect(executor.resolveModelId("devin/swe-1-7")).toBe("swe-1-7");
      expect(executor.resolveModelId("swe-1-6")).toBe("swe-1-6");
      expect(executor.resolveModelId("dv/custom-devin-model")).toBe("custom-devin-model");
      // Effort-selector suffix never reaches the wire uid.
      expect(executor.resolveModelId("dv/swe-2(max)")).toBe("swe-2");
      expect(executor.resolveModelId("dv/gpt-5.6-sol(high)")).toBe("gpt-5-6-sol");
      // Provider aliases: short family names + dotted spellings.
      expect(executor.resolveModelId("dv/swe")).toBe("swe-1-7-lightning");
      expect(executor.resolveModelId("swe-1.7")).toBe("swe-1-7");
      expect(executor.resolveModelId("opus")).toBe("claude-opus-5");
      expect(executor.resolveModelId("codex")).toBe("gpt-5-3-codex");
    });

    it("builds the default chat endpoint URL", () => {
      expect(executor.buildUrl()).toBe(`${DEVIN_DEFAULT_BASE_URL}${DEVIN_CHAT_PATH}`);
    });
  });

  describe("DEV-02: Payload framing, generation params, stop patterns, and tool conversions", () => {
    it("maps temperature, top_p, max_tokens, and stop sequences into GetChatMessageRequest", () => {
      const payload = executor.buildChatPayload({
        body: {
          messages: [{ role: "user", content: "Test prompt" }],
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: 4096,
          stop: ["###END###", "<custom_stop>"],
        },
        model: "swe-1-7",
        sessionToken: "tok",
        userJwt: "jwt_val",
        cascadeId: "c_123",
      });

      expect(payload.configuration.temperature).toBeCloseTo(0.7);
      expect(payload.configuration.topP).toBeCloseTo(0.9);
      expect(payload.configuration.maxTokens).toBe(4096n);
      expect(payload.configuration.stopPatterns).toContain("###END###");
      expect(payload.configuration.stopPatterns).toContain("<custom_stop>");
      expect(payload.configuration.stopPatterns).toContain("<|endoftext|>");
    });

    it("converts OpenAI function tools into Devin ChatToolDefinition schemas", () => {
      const payload = executor.buildChatPayload({
        body: {
          messages: [{ role: "user", content: "Run tool" }],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Fetches current weather for a given city",
                parameters: {
                  type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"],
                },
                strict: true,
              },
            },
          ],
        },
        model: "swe-1-7",
        sessionToken: "tok",
        userJwt: "jwt_val",
        cascadeId: "c_123",
      });

      expect(payload.tools).toHaveLength(1);
      expect(payload.tools[0].name).toBe("get_weather");
      expect(payload.tools[0].description).toBe("Fetches current weather for a given city");
      expect(payload.tools[0].strict).toBe(true);
      const parsedSchema = JSON.parse(payload.tools[0].jsonSchemaString);
      expect(parsedSchema.properties.city.type).toBe("string");
    });
  });

  describe("DEV-03: Model assignment error semantics & cascade binding", () => {
    it("router model: AssignModel HTTP 500 results in bounded terminal failure with 0 chat calls", async () => {
      const calls = [];
      proxyFetchSpy.mockImplementation(async (url, options) => {
        calls.push({ url, options });
        if (url.includes(DEVIN_AUTH_PATH)) {
          return new Response(
            toBinary(GetUserJwtResponseSchema, { userJwt: "jwt_assign_fail" }),
            { status: 200, headers: { "content-type": "application/proto" } }
          );
        }
        if (url.includes(DEVIN_ASSIGN_MODEL_PATH)) {
          return new Response("Internal server error", { status: 500 });
        }
        return new Response("Unexpected", { status: 404 });
      });

      await expect(
        executor.execute({
          model: "dv/adaptive",
          body: { messages: [{ role: "user", content: "hi" }] },
          credentials: { apiKey: "tok" },
        })
      ).rejects.toThrow(/Devin AssignModel failed \(500\)/);

      // Assert no GetChatMessage call was dispatched
      const chatCalls = calls.filter((c) => c.url.includes(DEVIN_CHAT_PATH));
      expect(chatCalls).toHaveLength(0);
    });

    it("router model: AssignModel returning empty assignment JWT results in bounded failure with 0 chat calls", async () => {
      const calls = [];
      proxyFetchSpy.mockImplementation(async (url, options) => {
        calls.push({ url, options });
        if (url.includes(DEVIN_AUTH_PATH)) {
          return new Response(
            toBinary(GetUserJwtResponseSchema, { userJwt: "jwt_auth_ok" }),
            { status: 200, headers: { "content-type": "application/proto" } }
          );
        }
        if (url.includes(DEVIN_ASSIGN_MODEL_PATH)) {
          return new Response(
            toBinary(AssignModelResponseSchema, {
              assignment: {
                assignmentJwt: "", // Empty assignmentJwt
                modelUid: "swe-1-6",
              },
            }),
            { status: 200, headers: { "content-type": "application/proto" } }
          );
        }
        return new Response("Unexpected", { status: 404 });
      });

      await expect(
        executor.execute({
          model: "dv/adaptive",
          body: { messages: [{ role: "user", content: "hi" }] },
          credentials: { apiKey: "tok" },
        })
      ).rejects.toThrow(/Devin AssignModel error: response carried no assignment JWT and model uid/);

      const chatCalls = calls.filter((c) => c.url.includes(DEVIN_CHAT_PATH));
      expect(chatCalls).toHaveLength(0);
    });

    it("direct model: bypasses AssignModel completely and binds cascadeId directly", async () => {
      const calls = [];
      proxyFetchSpy.mockImplementation(async (url, options) => {
        calls.push({ url, options });
        if (url.includes(DEVIN_AUTH_PATH)) {
          return new Response(
            toBinary(GetUserJwtResponseSchema, { userJwt: "jwt_direct_ok" }),
            { status: 200, headers: { "content-type": "application/proto" } }
          );
        }
        if (url.includes(DEVIN_CHAT_PATH)) {
          const frame = buildConnectFrame(
            toBinary(GetChatMessageResponseSchema, { deltaText: "Direct output" }),
            false
          );
          return new Response(createMockStream([frame]), {
            status: 200,
            headers: { "content-type": "application/connect+proto" },
          });
        }
        return new Response("Unexpected", { status: 404 });
      });

      const result = await executor.execute({
        model: "swe-1-7",
        body: { messages: [{ role: "user", content: "direct request" }] },
        credentials: { apiKey: "tok" },
      });

      const events = await readSseResponse(result.response);
      expect(events).toContain("[DONE]");

      const assignCalls = calls.filter((c) => c.url.includes(DEVIN_ASSIGN_MODEL_PATH));
      expect(assignCalls).toHaveLength(0);
      expect(calls).toHaveLength(2);
    });
  });

  describe("DEV-04: Streaming frame handling, Connect errors, and usage aggregation", () => {
    it("maps Connect gRPC error code resource_exhausted to SSE error without [DONE]", async () => {
      proxyFetchSpy.mockImplementation(async (url) => {
        if (url.includes(DEVIN_AUTH_PATH)) {
          return new Response(
            toBinary(GetUserJwtResponseSchema, { userJwt: "jwt_quota_err" }),
            { status: 200, headers: { "content-type": "application/proto" } }
          );
        }
        if (url.includes(DEVIN_CHAT_PATH)) {
          const trailerPayload = Buffer.from(
            JSON.stringify({
              error: {
                code: "resource_exhausted",
                message: "Monthly quota exceeded for user",
              },
            })
          );
          const trailerFrame = new Uint8Array(5 + trailerPayload.length);
          trailerFrame[0] = 0x02; // End-stream flag
          new DataView(trailerFrame.buffer).setUint32(1, trailerPayload.length, false);
          trailerFrame.set(trailerPayload, 5);

          return new Response(createMockStream([trailerFrame]), {
            status: 200,
            headers: { "content-type": "application/connect+proto" },
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const result = await executor.execute({
        model: "swe-1-7",
        body: { messages: [{ role: "user", content: "hi" }] },
        credentials: { apiKey: "tok" },
      });

      const events = await readSseResponse(result.response);
      expect(events).toHaveLength(1);
      const parsed = JSON.parse(events[0]);
      expect(parsed.error.message).toContain("resource_exhausted");
      expect(parsed.error.message).toContain("Monthly quota exceeded for user");
      expect(parsed.error.type).toBe("upstream_error");
      expect(events).not.toContain("[DONE]");
    });

    it("delivers text chunks first then error event when error trailer follows text frame", async () => {
      proxyFetchSpy.mockImplementation(async (url) => {
        if (url.includes(DEVIN_AUTH_PATH)) {
          return new Response(
            toBinary(GetUserJwtResponseSchema, { userJwt: "jwt_partial_stream" }),
            { status: 200, headers: { "content-type": "application/proto" } }
          );
        }
        if (url.includes(DEVIN_CHAT_PATH)) {
          const f1 = buildConnectFrame(
            toBinary(GetChatMessageResponseSchema, { deltaText: "Partial response before failure" }),
            false
          );
          const trailerPayload = Buffer.from(
            JSON.stringify({
              error: {
                code: "unavailable",
                message: "Backend stream dropped",
              },
            })
          );
          const trailerFrame = new Uint8Array(5 + trailerPayload.length);
          trailerFrame[0] = 0x02;
          new DataView(trailerFrame.buffer).setUint32(1, trailerPayload.length, false);
          trailerFrame.set(trailerPayload, 5);

          return new Response(createMockStream([Buffer.concat([f1, trailerFrame])]), {
            status: 200,
            headers: { "content-type": "application/connect+proto" },
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const result = await executor.execute({
        model: "swe-1-7",
        body: { messages: [{ role: "user", content: "hi" }] },
        credentials: { apiKey: "tok" },
      });

      const events = await readSseResponse(result.response);
      expect(events.length).toBeGreaterThanOrEqual(2);
      // First chunk has text
      const firstChunk = JSON.parse(events[0]);
      expect(firstChunk.choices[0].delta.content).toBe("Partial response before failure");
      // Last chunk has error
      const lastChunk = JSON.parse(events[events.length - 1]);
      expect(lastChunk.error.message).toContain("Backend stream dropped");
      expect(events).not.toContain("[DONE]");
    });

    it("aggregates usage and emits valid final usage chunk", async () => {
      proxyFetchSpy.mockImplementation(async (url) => {
        if (url.includes(DEVIN_AUTH_PATH)) {
          return new Response(
            toBinary(GetUserJwtResponseSchema, { userJwt: "jwt_usage_stream" }),
            { status: 200, headers: { "content-type": "application/proto" } }
          );
        }
        if (url.includes(DEVIN_CHAT_PATH)) {
          const f1 = buildConnectFrame(
            toBinary(GetChatMessageResponseSchema, {
              deltaText: "Answer completed.",
              usage: {
                inputTokens: 1200n,
                outputTokens: 350n,
                cacheReadTokens: 400n,
                cacheWriteTokens: 100n,
              },
              stopReason: StopReason.END_TURN,
            }),
            false
          );
          return new Response(createMockStream([f1]), {
            status: 200,
            headers: { "content-type": "application/connect+proto" },
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const result = await executor.execute({
        model: "swe-1-7",
        body: { messages: [{ role: "user", content: "hi" }] },
        credentials: { apiKey: "tok" },
      });

      const events = await readSseResponse(result.response);
      expect(events).toContain("[DONE]");
      const parsedChunks = events
        .filter((e) => e !== "[DONE]")
        .map((e) => JSON.parse(e));

      const usageChunk = parsedChunks.find((c) => c.usage);
      expect(usageChunk).toBeDefined();
      expect(usageChunk.usage.prompt_tokens).toBe(1600);
      expect(usageChunk.usage.completion_tokens).toBe(350);
      expect(usageChunk.usage.total_tokens).toBe(1950);
      expect(usageChunk.usage.prompt_tokens_details.cached_tokens).toBe(400);
    });
  });
});

describe("Devin shared catalog snapshot routing", () => {
  let executor;
  let proxyFetchSpy;
  let savedHedge;

  // Snapshot-only fixtures — absent from the static registry entirely.
  const DYN_FAMILY = {
    id: "org-dyn-family",
    name: "Org Dyn Family",
    members: ["org-dyn-high", "org-dyn-low"],
    routing: { high: "org-dyn-high", low: "org-dyn-low" },
    defaultMember: "org-dyn-high",
    efforts: ["low", "high"],
    requiresEffort: true,
  };
  const DYN_MEMBERS = [
    { id: "org-dyn-high", name: "Org Dyn High", contextLength: 200000, toolUse: true, supportsParallelToolCalls: true },
    { id: "org-dyn-low", name: "Org Dyn Low", contextLength: 200000, toolUse: true, supportsParallelToolCalls: true },
  ];
  const DYN_MAPS = {
    families: new Map([[DYN_FAMILY.id, DYN_FAMILY]]),
    members: new Map(DYN_MEMBERS.map((m) => [m.id, m])),
    fetchedAt: 1,
    generation: 1,
  };

  beforeEach(() => {
    savedHedge = process.env.DEVIN_HEDGE;
    process.env.DEVIN_HEDGE = "1";
    executor = new DevinExecutor();
    proxyFetchSpy = mocks.proxyAwareFetch;
    proxyFetchSpy.mockReset();
  });

  afterEach(() => {
    if (savedHedge === undefined) delete process.env.DEVIN_HEDGE;
    else process.env.DEVIN_HEDGE = savedHedge;
    vi.restoreAllMocks();
  });

  it("matrix 12 / AC-01: snapshot-only logical id routes to the discovered sibling uid", async () => {
    mocks.getDevinCatalogSnapshot.mockResolvedValue(DYN_MAPS);
    const calls = serveDevinEdge();
    await executor.execute({
      model: "dv/org-dyn-family",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "low" },
      credentials: { apiKey: "tok", connectionId: "conn-1" },
    });
    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_CHAT_PATH]);
    expect(decodeChatRequest(calls[1]).chatModelUid).toBe("org-dyn-low");
    // Pinned exactly once per request, with the contract args.
    expect(mocks.getDevinCatalogSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.getDevinCatalogSnapshot).toHaveBeenCalledWith(
      { apiKey: "tok", connectionId: "conn-1" },
      { proxyOptions: null, signal: undefined }
    );
  });

  it("matrix 13 / AC-05: family without defaultMember falls back deterministically — never the bare logical id", async () => {
    const noDefault = { ...DYN_FAMILY, defaultMember: undefined };
    mocks.getDevinCatalogSnapshot.mockResolvedValue({
      families: new Map([[noDefault.id, noDefault]]),
      members: new Map(DYN_MEMBERS.map((m) => [m.id, m])),
      fetchedAt: 1,
      generation: 1,
    });
    // No effort → requiresEffort tail: first routed member (insertion order).
    let calls = serveDevinEdge();
    await executor.execute({
      model: "dv/org-dyn-family",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: { apiKey: "tok" },
    });
    expect(decodeChatRequest(calls[1]).chatModelUid).toBe("org-dyn-high");

    // Degenerate family: routing present but valueless → members[0].
    const bare = {
      id: "org-bare",
      name: "Bare",
      members: ["org-bare-x", "org-bare-y"],
      routing: {},
      requiresEffort: true,
    };
    mocks.getDevinCatalogSnapshot.mockResolvedValue({
      families: new Map([[bare.id, bare]]),
      members: new Map(),
      fetchedAt: 1,
      generation: 1,
    });
    calls = serveDevinEdge();
    await executor.execute({
      model: "dv/org-bare",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
      credentials: { apiKey: "tok" },
    });
    const uid = decodeChatRequest(calls[1]).chatModelUid;
    expect(uid).toBe("org-bare-x");
    expect(uid).not.toBe("org-bare");
  });

  it("resolveWireUid fallback chain: defaultMember → first routed → members[0] → logical id", () => {
    // Direct calls take executor-shaped meta (effortRouting) — normalization
    // from snapshot `routing` happens in resolveModelMeta, covered above.
    const wireShaped = { ...DYN_FAMILY, effortRouting: DYN_FAMILY.routing };
    expect(executor.resolveWireUid({ ...wireShaped, defaultMember: undefined }, null)).toBe("org-dyn-high");
    expect(executor.resolveWireUid({ ...wireShaped, defaultMember: undefined }, "off")).toBe("org-dyn-high");
    expect(
      executor.resolveWireUid({ id: "f", effortRouting: {}, members: ["m1", "m2"], requiresEffort: true }, "off")
    ).toBe("m1");
    // All fallbacks exhausted → the logical id itself (documented last resort).
    expect(executor.resolveWireUid({ id: "f", effortRouting: {}, members: [], requiresEffort: true }, "off")).toBe("f");
  });

  it("matrix 14 / AC-06: routed member meta comes from snapshot.members — maxTokens and parallel-tool flags honored", async () => {
    const ghost = {
      id: "org-ghost-member",
      name: "Ghost Member",
      contextLength: 150000,
      toolUse: true,
      supportsParallelToolCalls: true,
      maxOutputTokens: 42000,
    };
    const ghostFamily = {
      id: "org-ghost",
      name: "Ghost Family",
      members: ["org-ghost-member"],
      routing: { high: "org-ghost-member" },
      defaultMember: "org-ghost-member",
      efforts: ["high"],
      requiresEffort: true,
    };
    mocks.getDevinCatalogSnapshot.mockResolvedValue({
      families: new Map([[ghostFamily.id, ghostFamily]]),
      members: new Map([[ghost.id, ghost]]),
      fetchedAt: 1,
      generation: 1,
    });
    const calls = serveDevinEdge();
    await executor.execute({
      model: "dv/org-ghost",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
      credentials: { apiKey: "tok" },
    });
    const chat = decodeChatRequest(calls[1]);
    expect(chat.chatModelUid).toBe("org-ghost-member");
    // maxOutputTokens from the discovered member — not the 128000 wire default.
    expect(chat.configuration.maxTokens).toBe(42000n);
    // supportsParallelToolCalls on the discovered member → serial flag stays off.
    expect(chat.disableParallelToolCalls ?? false).toBe(false);
  });

  it("matrix 15a / AC-07: snapshot pinned across retry attempts", async () => {
    let chatCalls = 0;
    const calls = serveDevinEdge({
      chat: () => {
        chatCalls += 1;
        if (chatCalls === 1) return new Response("boom", { status: 500 });
        return new Response(createMockStream([chatStream()]), {
          status: 200,
          headers: { "content-type": "application/connect+proto" },
        });
      },
    });
    mocks.getDevinCatalogSnapshot.mockResolvedValue(DYN_MAPS);
    await executor.execute({
      model: "dv/org-dyn-family",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
      credentials: { apiKey: "tok" },
    });
    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_CHAT_PATH, DEVIN_AUTH_PATH, DEVIN_CHAT_PATH]);
    // Exactly one snapshot fetch for the whole request, across the retry.
    expect(mocks.getDevinCatalogSnapshot).toHaveBeenCalledTimes(1);
    expect(decodeChatRequest(calls[1]).chatModelUid).toBe("org-dyn-high");
    expect(decodeChatRequest(calls[3]).chatModelUid).toBe("org-dyn-high");
  });

  it("matrix 15b / AC-07: hedged payloads reuse the pinned snapshot and the routed uid", async () => {
    process.env.DEVIN_HEDGE = "3";
    mocks.getDevinCatalogSnapshot.mockResolvedValue(DYN_MAPS);
    const calls = serveDevinEdge();
    await executor.execute({
      model: "dv/org-dyn-family",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
      credentials: { apiKey: "tok" },
    });
    const chatCalls = calls.filter((c) => c.url.includes(DEVIN_CHAT_PATH));
    expect(chatCalls).toHaveLength(3);
    expect(mocks.getDevinCatalogSnapshot).toHaveBeenCalledTimes(1);
    for (const call of chatCalls) {
      expect(decodeChatRequest(call).chatModelUid).toBe("org-dyn-high");
    }
  });

  it("matrix 16: null snapshot or catalog failure keeps today's static-registry behavior", async () => {
    // Null snapshot (the file default): static swe-2 routing intact.
    let calls = serveDevinEdge();
    await executor.execute({
      model: "dv/swe-2",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "low" },
      credentials: { apiKey: "tok" },
    });
    expect(decodeChatRequest(calls[1]).chatModelUid).toBe("swe-2-medium");

    // Catalog throwing must never break the request (fail-open).
    mocks.getDevinCatalogSnapshot.mockRejectedValue(new Error("catalog unavailable"));
    calls = serveDevinEdge();
    await executor.execute({
      model: "dv/swe-2",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
      credentials: { apiKey: "tok" },
    });
    expect(decodeChatRequest(calls[1]).chatModelUid).toBe("swe-2-high");
  });

  it("matrix 17: dynamically discovered router model takes the AssignModel path", async () => {
    mocks.getDevinCatalogSnapshot.mockResolvedValue({
      families: new Map(),
      members: new Map([
        ["adaptive-org", { id: "adaptive-org", name: "Adaptive Org", toolUse: true, modelRouter: true }],
      ]),
      fetchedAt: 1,
      generation: 1,
    });
    const calls = serveDevinEdge();
    await executor.execute({
      model: "dv/adaptive-org",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: { apiKey: "tok" },
    });
    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_ASSIGN_MODEL_PATH, DEVIN_CHAT_PATH]);
    expect(decodeAssignRequest(calls[1]).modelRouterUid).toBe("adaptive-org");
    // Chat carries the ASSIGNED concrete uid, resolved from the same snapshot.
    expect(decodeChatRequest(calls[2]).chatModelUid).toBe("claude-sonnet-4-5");
  });

  it("matrix 17b: snapshot-known router uid echoed back by AssignModel fails the turn", async () => {
    mocks.getDevinCatalogSnapshot.mockResolvedValue({
      families: new Map(),
      members: new Map([
        ["adaptive-org", { id: "adaptive-org", name: "Adaptive Org", toolUse: true, modelRouter: true }],
        ["adaptive-alt", { id: "adaptive-alt", name: "Adaptive Alt", toolUse: true, modelRouter: true }],
      ]),
      fetchedAt: 1,
      generation: 1,
    });
    serveDevinEdge({
      // Server assigns a DIFFERENT snapshot-known router uid (not the
      // requested one, not in the static registry) — only the
      // snapshot-aware isKnownRouterUid can trip the guard.
      assignment: () =>
        new Response(
          toBinary(AssignModelResponseSchema, {
            assignment: { assignmentJwt: "assign-jwt", modelUid: "adaptive-alt" },
          }),
          { status: 200, headers: { "content-type": "application/proto" } }
        ),
    });
    await expect(
      executor.execute({
        model: "dv/adaptive-org",
        body: { messages: [{ role: "user", content: "hi" }] },
        credentials: { apiKey: "tok" },
      })
    ).rejects.toThrow(/instead of a concrete model/);
  });
});

