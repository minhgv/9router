/**
 * DEV-03 (execution sequence) + DEV-04 (streaming) contract tests — Wave 1 Stage 1a (W-C).
 *
 * EXTEND tier: these MUST pass deterministically. An observable assertion failure on the
 * locked policy is a CONFIRMED DEFECT receipt for Wave 2/5 — record, do not fix.
 *
 * Targets: open-sse/executors/devin.js
 *   - sequence: fetchUserJwt → optional assignModel → chat dispatch (~L104-486)
 *   - stream:   createSseStream OpenAI-compatible mapping + error handling (~L784-917)
 *
 * Locked policies (plan §7.2):
 *   DEV-03: GetUserJwt → optional AssignModel → GetChatMessage order; missing assignment
 *           JWT/UID → bounded failure; assignment failure → terminal bounded error, no
 *           prompt replay loop; transient pre-stream failures bounded by retry budget.
 *   DEV-04: stream text/tool/usage/trailer → OpenAI-compatible SSE events and [DONE] ONLY
 *           on valid completion; partial output then trailer error → bounded redacted error;
 *           mid-stream Connect error → bounded; cancel → no replay.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

import zlib from "node:zlib";
import { DevinExecutor } from "open-sse/executors/devin.js";
import {
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_AUTH_PATH,
  DEVIN_CHAT_PATH,
  DEVIN_ASSIGN_MODEL_PATH,
  GetUserJwtResponseSchema,
  AssignModelRequestSchema,
  AssignModelResponseSchema,
  GetChatMessageRequestSchema,
  GetChatMessageResponseSchema,
  toBinary,
  fromBinary,
  buildConnectFrame,
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

// Upstream that enqueues a partial frame then fails mid-flight (transport-level error).
function streamThatErrorsAfterFirstChunk(firstChunkBytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(firstChunkBytes);
      controller.error(new Error("ECONNRESET: socket hang up"));
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

function dataFrame(msg) {
  return buildConnectFrame(toBinary(GetChatMessageResponseSchema, msg), true);
}

const SSE_HEADERS = { "content-type": "application/connect+proto" };

// One recorder for GetUserJwt / AssignModel / GetChatMessage.
function serveDevinEdge({ auth, assignment, chat } = {}) {
  const calls = [];
  mocks.proxyAwareFetch.mockImplementation(async (url, options) => {
    const call = { url, options };
    calls.push(call);
    const pathname = new URL(url).pathname;
    if (pathname === DEVIN_AUTH_PATH) {
      return (
        auth?.() ??
        new Response(toBinary(GetUserJwtResponseSchema, { userJwt: "user-jwt-c" }), {
          status: 200,
          headers: { "content-type": "application/proto" },
        })
      );
    }
    if (pathname === DEVIN_ASSIGN_MODEL_PATH) {
      return assignment?.() ?? null;
    }
    return (
      chat?.() ??
      new Response(createMockStream([chatStream()]), { status: 200, headers: SSE_HEADERS })
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

import { AssignModelRequestSchema } from "open-sse/utils/devinProtobuf.js";

function callPaths(calls) {
  return calls.map((c) => new URL(c.url).pathname);
}

const CHAT_BODY = {
  messages: [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "hello" },
  ],
};

// ==================== DEV-03: execution sequence ====================

describe("DEV-03 executor sequence contracts", () => {
  let executor;

  beforeEach(() => {
    process.env.DEVIN_HEDGE = "1"; // single-request flows
    executor = new DevinExecutor();
    mocks.proxyAwareFetch.mockReset();
  });

  afterEach(() => {
    delete process.env.DEVIN_HEDGE;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("router model: GetUserJwt → AssignModel → GetChatMessage, cascade-bound assignment", async () => {
    const calls = serveDevinEdge({
      assignment: () =>
        new Response(
          toBinary(AssignModelResponseSchema, {
            assignment: { assignmentJwt: "assign-jwt-1", modelUid: "claude-opus-5-medium" },
          }),
          { status: 200, headers: { "content-type": "application/proto" } }
        ),
    });

    await executor.execute({
      model: "dv/adaptive",
      body: CHAT_BODY,
      credentials: { apiKey: "session-secret" },
    });

    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_ASSIGN_MODEL_PATH, DEVIN_CHAT_PATH]);
    const assigned = decodeAssignRequest(calls[1]);
    expect(assigned.modelRouterUid).toBe("adaptive");
    const chatCall = calls[2];
    const decoded = decodeChatRequest(chatCall);
    // GetUserJwt token rides metadata; the assignment is bound via chatModelUid + modelAssignmentJwt.
    expect(decoded.metadata.userJwt).toBe("user-jwt-c");
    expect(decoded.chatModelUid).toBe("claude-opus-5-medium");
    expect(decoded.modelAssignmentJwt).toBe("assign-jwt-1");
    // Exactly one prompt dispatch — the chat request IS the only prompt replay surface.
    expect(calls.filter((c) => new URL(c.url).pathname === DEVIN_CHAT_PATH)).toHaveLength(1);
  });

  it("direct model skips AssignModel entirely", async () => {
    const calls = serveDevinEdge();

    await executor.execute({
      model: "dv/swe-1-6",
      body: CHAT_BODY,
      credentials: { apiKey: "session-secret" },
    });

    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_CHAT_PATH]);
  });

  it("missing assignment JWT: bounded failure BEFORE chat (no partial dispatch)", async () => {
    const calls = serveDevinEdge({
      assignment: () =>
        new Response(
          toBinary(AssignModelResponseSchema, {
            assignment: { assignmentJwt: "", modelUid: "claude-opus-5-medium" },
          }),
          { status: 200, headers: { "content-type": "application/proto" } }
        ),
    });

    await expect(
      executor.execute({
        model: "dv/adaptive",
        body: CHAT_BODY,
        credentials: { apiKey: "session-secret" },
      })
    ).rejects.toThrow(/no assignment JWT and model uid/i);

    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_ASSIGN_MODEL_PATH]);
    expect(calls.filter((c) => new URL(c.url).pathname === DEVIN_CHAT_PATH)).toHaveLength(0);
  });

  it("missing assignment model UID: bounded failure BEFORE chat", async () => {
    const calls = serveDevinEdge({
      assignment: () =>
        new Response(
          toBinary(AssignModelResponseSchema, { assignment: { assignmentJwt: "assign-jwt-1", modelUid: "" } }),
        ),
    });

    await expect(
      executor.execute({
        model: "dv/adaptive",
        body: CHAT_BODY,
        credentials: { apiKey: "session-secret" },
      })
    ).rejects.toThrow(/no assignment JWT and model uid/i);

    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_ASSIGN_MODEL_PATH]);
  });

  it("assignment HTTP failure: terminal bounded error, no chat, no prompt replay loop", async () => {
    const calls = serveDevinEdge({
      assignment: () => new Response("forbidden", { status: 403 }),
    });

    await expect(
      executor.execute({
        model: "dv/adaptive",
        body: CHAT_BODY,
        credentials: { apiKey: "session-secret" },
      })
    ).rejects.toThrow(/AssignModel failed \(403\)/);

    // The retry loop only owns transient failures: exactly auth + assignment, never chat.
    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_ASSIGN_MODEL_PATH]);
    // Bounded error must not leak the session credential.
    const err = await executor
      .execute({
        model: "dv/adaptive",
        body: CHAT_BODY,
        credentials: { apiKey: "session-secret-leak-marker" },
      })
      .catch((e) => e);
    expect(String(err?.message)).toMatch(/AssignModel failed \(403\)/);
    expect(String(err?.message)).not.toContain("session-secret-leak-marker");
  });

  it("assignment echoing the router UID fails bounded before chat (router uid is never a chat model)", async () => {
    const calls = serveDevinEdge({
      assignment: () =>
        new Response(
          toBinary(AssignModelResponseSchema, {
            assignment: { assignmentJwt: "assign-jwt-1", modelUid: "adaptive" },
          }),
          { status: 200, headers: { "content-type": "application/proto" } }
        ),
    });

    await expect(
      executor.execute({
        model: "dv/adaptive",
        body: CHAT_BODY,
        credentials: { apiKey: "session-secret" },
      })
    ).rejects.toThrow(/router model UID/i);

    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_ASSIGN_MODEL_PATH]);
  });

  it("missing session credential fails before any request", async () => {
    const calls = serveDevinEdge();

    await expect(
      executor.execute({ model: "dv/swe-1-6", body: CHAT_BODY, credentials: {} })
    ).rejects.toThrow(/requires an apiKey/i);

    expect(calls).toHaveLength(0);
  });

  it("transient auth failures retry bounded then recover (no infinite loop)", async () => {
    vi.useFakeTimers();
    let authAttempts = 0;
    const calls = serveDevinEdge({
      auth: () => {
        authAttempts += 1;
        if (authAttempts <= 2) return new Response("overloaded", { status: 503 });
        return new Response(toBinary(GetUserJwtResponseSchema, { userJwt: "user-jwt-c" }), {
          status: 200,
          headers: { "content-type": "application/proto" },
        });
      },
    });

    const pending = executor
      .execute({
        model: "dv/swe-1-6",
        body: CHAT_BODY,
        credentials: { apiKey: "session-secret" },
      })
      .catch((e) => e);
    await vi.runAllTimersAsync();
    const result = await pending;
    await readSseResponse(result.response);

    expect(authAttempts).toBe(3); // 1 initial + 2 retries, then success
    expect(callPaths(calls).filter((p) => p === DEVIN_CHAT_PATH)).toHaveLength(1);
  });

  it("auth failing transiently forever is bounded: exactly maxRetries+1 attempts, last error surfaces", async () => {
    vi.useFakeTimers();
    const calls = serveDevinEdge({
      auth: () => new Response("overloaded", { status: 503 }),
    });

    const pending = executor
      .execute({
        model: "dv/swe-1-6",
        body: CHAT_BODY,
        credentials: { apiKey: "session-secret" },
      })
      .catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await pending;
    expect(String(err?.message)).toMatch(/GetUserJwt failed \(503\)/);

    const authAttempts = calls.filter((c) => new URL(c.url).pathname === DEVIN_AUTH_PATH).length;
    expect(authAttempts).toBe(3); // bounded: 1 initial + 2 retries
    expect(calls.filter((c) => new URL(c.url).pathname === DEVIN_CHAT_PATH)).toHaveLength(0);
  });
});

// ==================== module-scope SSE consumer ====================


async function readSseResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    return raw
      .split("\n\n")
      .map((block) =>
        block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
      )
      .filter((data) => data.length > 0);
}

describe("DEV-04 streaming contracts", () => {
  let executor;

  beforeEach(() => {
    process.env.DEVIN_HEDGE = "1";
    executor = new DevinExecutor();
    mocks.proxyAwareFetch.mockReset();
  });

  afterEach(() => {
    delete process.env.DEVIN_HEDGE;
    vi.restoreAllMocks();
  });


  it("text/tool/usage/trailer stream to OpenAI-compatible SSE with exactly one trailing [DONE] on valid completion", async () => {
    const calls = serveDevinEdge({
      chat: () =>
        new Response(
          createMockStream([
            chatStream(
              dataFrame({ messageId: "msg-1", deltaText: "Hello" }),
              dataFrame({ deltaText: " world" }),
              dataFrame({
                deltaToolCalls: [
                  { id: "call_1", name: "read_file", argumentsJson: '{"path":"a.ts"}' },
                ],
              }),
              dataFrame({ usage: { inputTokens: 10n, outputTokens: 5n, cacheReadTokens: 2n } }),
              dataFrame({ usage: { inputTokens: 3n, outputTokens: 2n } })
            ),
          ]),
          { status: 200, headers: SSE_HEADERS }
        ),
    });

    const result = await executor.execute({
      model: "dv/swe-1-6",
      body: CHAT_BODY,
      credentials: { apiKey: "session-secret" },
    });
    const events = await readSseResponse(result.response);

    const parsed = events
      .filter((e) => e !== "[DONE]")
      .map((e) => JSON.parse(e));
    const doneCount = events.filter((e) => e === "[DONE]").length;

    // Exactly one [DONE], and it terminates the stream.
    expect(doneCount).toBe(1);
    expect(events[events.length - 1]).toBe("[DONE]");
    // OpenAI-compatible chunks.
    expect(parsed.length).toBeGreaterThanOrEqual(4);
    for (const chunk of parsed) {
      expect(chunk.object).toBe("chat.completion.chunk");
    }
    const ids = new Set(parsed.map((c) => c.id));
    expect(ids.size).toBe(1);
    // Text content arrives as delta.content in order.
    const text = parsed
      .map((c) => c.choices?.[0]?.delta?.content ?? "")
      .join("");
    expect(text).toContain("Hello");
    expect(text).toContain(" world");
    // Tool call is surfaced as an OpenAI tool_calls delta.
    const toolChunk = parsed.find(
      (c) => c.choices?.[0]?.delta?.tool_calls?.length > 0
    );
    expect(toolChunk).toBeTruthy();
    const tool = toolChunk.choices[0].delta.tool_calls[0];
    expect(tool.id).toBe("call_1");
    expect(tool.function.name).toBe("read_file");
    expect(tool.function.arguments).toBe('{"path":"a.ts"}');
    // Final chunk: finish_reason + accumulated usage (usage frames summed).
    const final = parsed[parsed.length - 1];
    expect(final.choices[0].finish_reason).toBe("tool_calls");
    expect(final.usage).toMatchObject({
      prompt_tokens: 15, // (10+3) input + (2+0) cacheRead
      completion_tokens: 7, // 5+2
      total_tokens: 22,
    });
    expect(calls.filter((c) => new URL(c.url).pathname === DEVIN_CHAT_PATH)).toHaveLength(1);
  });

  it("(locked policy) partial output then error trailer yields bounded redacted error and NO [DONE]", async () => {
    const calls = serveDevinEdge({
      chat: () =>
        new Response(
          createMockStream([
            chatStream(dataFrame({ messageId: "msg-1", deltaText: "partial answer" })),
            endStreamFrame({ error: { code: "unavailable", message: "upstream exploded" } }),
          ]),
          { status: 200, headers: SSE_HEADERS }
        ),
    });

    const result = await executor.execute({
      model: "dv/swe-1-6",
      body: CHAT_BODY,
      credentials: { apiKey: "session-secret-token" },
    });
    const events = await readSseResponse(result.response);

    const errorEvents = events
      .filter((e) => e !== "[DONE]")
      .map((e) => JSON.parse(e))
      .filter((c) => c.error);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].error.type).toBe("upstream_error");
    expect(errorEvents[0].error.message).toContain("unavailable");
    // Redaction: the bounded error never echoes credentials.
    expect(errorEvents[0].error.message).not.toContain("session-secret-token");
    expect(errorEvents[0].error.message).not.toContain("user-jwt-c");
    // LOCKED POLICY: [DONE] signals a valid completion only.
    expect(events).not.toContain("[DONE]");
    expect(calls.filter((c) => new URL(c.url).pathname === DEVIN_CHAT_PATH)).toHaveLength(1);
  });

  it("mid-stream Connect transport error is bounded: single error event, stream closes, no retry dispatch", async () => {
    const calls = serveDevinEdge({
      chat: () =>
        new Response(
          streamThatErrorsAfterFirstChunk(
            chatStream(dataFrame({ messageId: "msg-1", deltaText: "so far" }))
          ),
          { status: 200, headers: SSE_HEADERS }
        ),
    });

    const result = await executor.execute({
      model: "dv/swe-1-6",
      body: CHAT_BODY,
      credentials: { apiKey: "session-secret" },
    });
    const events = await readSseResponse(result.response);

    const parsed = events.filter((e) => e !== "[DONE]").map((e) => JSON.parse(e));
    const errorEvents = parsed.filter((c) => c.error);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].error.type).toBe("upstream_error");
    expect(errorEvents[0].error.message).toContain("socket hang up");
    // The error never carries credentials.
    expect(errorEvents[0].error.message).not.toContain("session-secret");
    // Bounded: no re-dispatch of the prompt after the transport error.
    expect(calls.filter((c) => new URL(c.url).pathname === DEVIN_CHAT_PATH)).toHaveLength(1);
    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_CHAT_PATH]);
  });

  it("cancel mid-stream: no prompt replay, no new chat dispatch", async () => {
    let chatStreamsClosed = 0;
    const calls = serveDevinEdge({
      chat: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(chatStream(dataFrame({ messageId: "msg-1", deltaText: "Hello" })));
              // Never closes upstream: any further data must come from a NEW dispatch.
            },
            cancel() {
              chatStreamsClosed += 1;
            },
          }),
          { status: 200, headers: SSE_HEADERS }
        ),
    });

    const controller = new AbortController();
    const result = await executor.execute({
      model: "dv/swe-1-6",
      body: CHAT_BODY,
      credentials: { apiKey: "session-secret" },
      signal: controller.signal,
    });

    const reader = result.response.body.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value).toString()).toContain("Hello");

    controller.abort(new Error("client gone"));
    await expect(reader.read()).rejects.toThrow(/client gone/);


    // No replay: still exactly auth + one chat POST; the upstream stream was cancelled.
    expect(callPaths(calls)).toEqual([DEVIN_AUTH_PATH, DEVIN_CHAT_PATH]);
    expect(chatStreamsClosed).toBeGreaterThanOrEqual(1);
  });
});
