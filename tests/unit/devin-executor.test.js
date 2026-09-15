import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
  default: mocks.proxyAwareFetch,
}));

import zlib from "node:zlib";
import {
  DevinExecutor,
  sanitizeDevinSystemPrompt,
  sanitizeDevinToolDescription,
} from "open-sse/executors/devin.js";

import { getExecutor, hasSpecializedExecutor } from "open-sse/executors/index.js";
import { PROVIDERS } from "open-sse/config/providers.js";
import { MODEL_PRICING } from "open-sse/providers/pricing.js";
import { MODEL_CAPABILITIES } from "open-sse/providers/capabilities.js";
import { PROVIDER_MODELS, getProviderModels } from "open-sse/config/providerModels.js";
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
    expect(models).toHaveLength(23);
    expect(models.map((m) => m.id)).toEqual([
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
      "swe-check",
      "swe-1-6",
      "swe-1-6-fast",
    ]);
    expect(models[0]).toMatchObject({
      id: "swe-2-high",
      name: "SWE-2 High",
      contextLength: 262000,
    });
    expect(models[21]).toMatchObject({
      id: "swe-1-6",
      name: "SWE-1.6",
      contextLength: 200000,
    });
    expect(models[22]).toMatchObject({
      id: "swe-1-6-fast",
      name: "SWE-1.6 Fast",
      contextLength: 200000,
    });

    // Every lineup model has metered pricing; legacy models keep output caps.
    for (const m of models) {
      expect(MODEL_PRICING[m.id]).toBeDefined();
      expect(MODEL_CAPABILITIES[m.id]).toBeDefined();
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

  beforeEach(() => {
    executor = new DevinExecutor();
    proxyFetchSpy = mocks.proxyAwareFetch;
    proxyFetchSpy.mockReset();
  });

  afterEach(() => {
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

    // Upstream trailer errors must surface as a well-formed SSE error event +
    // [DONE] (kiro-style), NOT a rejected stream: erroring the body makes
    // Next.js "failed to pipe response" and drop the connection with zero bytes.
    const events = await readSseResponse(result.response);
    expect(events[events.length - 1]).toBe("[DONE]");
    expect(JSON.parse(events[events.length - 2])).toEqual({
      error: {
        message: "Devin stream error [permission_denied]: User session expired or unauthorized",
        type: "upstream_error",
      },
    });
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
    expect(events2[events2.length - 1]).toBe("[DONE]");
    expect(JSON.parse(events2[events2.length - 2])).toEqual({
      error: {
        message: "Devin context overflow error: Internal error during cascade execution",
        type: "upstream_error",
      },
    });
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
