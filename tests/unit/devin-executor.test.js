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
import { getExecutor, hasSpecializedExecutor } from "open-sse/executors/index.js";
import { PROVIDERS } from "open-sse/config/providers.js";
import { MODEL_PRICING } from "open-sse/providers/pricing.js";
import { MODEL_CAPABILITIES } from "open-sse/providers/capabilities.js";
import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";
import devinRegistry from "open-sse/providers/registry/devin.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import {
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_AUTH_PATH,
  DEVIN_CHAT_PATH,
  ChatMessageSource,
  ConversationalPlannerMode,
  StopReason,
  toBinary,
  fromBinary,
  buildConnectFrame,
  GetUserJwtResponseSchema,
  GetChatMessageRequestSchema,
  GetChatMessageResponseSchema,
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
    expect(devinRegistry.category).toBe("subscription");
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
    expect(models).toHaveLength(10);
    expect(models.map((m) => m.id)).toEqual([
      "swe-2-high",
      "swe-2-medium",
      "swe-2-max",
      "swe-1-7",
      "swe-1-7-medium",
      "swe-1-7-lightning",
      "swe-1-7-lightning-medium",
      "swe-check",
      "swe-1-6",
      "swe-1-6-fast",
    ]);
    expect(models[0]).toMatchObject({
      id: "swe-2-high",
      name: "SWE-2 High",
      contextLength: 200000,
    });
    expect(models[8]).toMatchObject({
      id: "swe-1-6",
      name: "SWE-1.6",
      contextLength: 200000,
    });
    expect(models[9]).toMatchObject({
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

    // Fresh cascadeId and executionId
    expect(req.cascadeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(req.executionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(req.cascadeId).not.toBe(req.executionId);

    // MessageIds are deterministic UUIDs
    for (const p of req.chatMessagePrompts) {
      expect(p.messageId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    }
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

    await expect(readSseResponse(result.response)).rejects.toThrow(
      /Devin stream error \[permission_denied\]: User session expired or unauthorized/
    );
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

    await expect(readSseResponse(result.response)).rejects.toThrow(
      /Devin context overflow error: Internal error during cascade execution/
    );
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
