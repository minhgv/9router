import { describe, expect, it } from "vitest";
import { geminiToOpenAIResponse, extractLeakedGeminiToolCalls } from "../../open-sse/translator/response/gemini-to-openai.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { DEFAULT_THINKING_AG_SIGNATURE } from "../../open-sse/config/defaultThinkingSignature.js";
import { storeGeminiThoughtSignature } from "../../open-sse/services/thoughtSignatureStore.js";

describe("Gemini leaked default_api tool call healing", () => {
  it("parses exact leaked 하려コール{default_api:grep{...}} into tool call", () => {
    const leaked = "하려コール{default_api:grep{i:Checking session CLI and slash commands,path:packages/coding-agent/src/cli/args.ts;packages/coding-agent/src/slash-commands/builtin-registry.ts,pattern:resume|continue|session}}";
    const { cleanedText, toolCalls, pending } = extractLeakedGeminiToolCalls(leaked, false);

    expect(pending).toBe(false);
    expect(cleanedText).toBe("");
    expect(toolCalls).toEqual([
      {
        name: "grep",
        args: {
          i: "Checking session CLI and slash commands",
          path: "packages/coding-agent/src/cli/args.ts;packages/coding-agent/src/slash-commands/builtin-registry.ts",
          pattern: "resume|continue|session",
        },
      },
    ]);
  });

  it("translates single-chunk streaming leaked tool call into OpenAI tool_calls with finish_reason=tool_calls", () => {
    const state = { model: "gemini-4-argon-medium", sessionId: "sess-1" };
    const chunks = geminiToOpenAIResponse(
      {
        response: {
          responseId: "resp_1",
          modelVersion: "gemini-4-argon-medium",
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    text: "하려コール{default_api:grep{i:Checking session CLI and slash commands,path:packages/coding-agent/src/cli/args.ts;packages/coding-agent/src/slash-commands/builtin-registry.ts,pattern:resume|continue|session}}",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
        },
      },
      state,
    );

    const toolChunk = chunks.find(c => c.choices?.[0]?.delta?.tool_calls);
    const finishChunk = chunks.find(c => c.choices?.[0]?.finish_reason);
    const textChunk = chunks.find(c => c.choices?.[0]?.delta?.content);

    expect(textChunk).toBeUndefined();
    expect(toolChunk).toBeDefined();
    expect(toolChunk.choices[0].delta.tool_calls[0].function).toEqual({
      name: "grep",
      arguments: JSON.stringify({
        i: "Checking session CLI and slash commands",
        path: "packages/coding-agent/src/cli/args.ts;packages/coding-agent/src/slash-commands/builtin-registry.ts",
        pattern: "resume|continue|session",
      }),
    });
    expect(finishChunk.choices[0].finish_reason).toBe("tool_calls");
  });

  it("buffers multi-chunk split leaked tool call across SSE chunks without leaking prefix", () => {
    const state = { model: "gemini-4-argon-medium", sessionId: "sess-2" };

    const step1 = geminiToOpenAIResponse(
      {
        response: {
          responseId: "resp_2",
          candidates: [{ content: { role: "model", parts: [{ text: "하려" }] } }],
        },
      },
      state,
    );
    expect(step1.some(c => c.choices?.[0]?.delta?.content)).toBe(false);

    const step2 = geminiToOpenAIResponse(
      {
        response: {
          responseId: "resp_2",
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "コール{default_api:read{i:Reading file,path:src/index.js:1-50}}" }],
              },
              finishReason: "STOP",
            },
          ],
        },
      },
      state,
    );

    const toolChunk = step2.find(c => c.choices?.[0]?.delta?.tool_calls);
    const finishChunk = step2.find(c => c.choices?.[0]?.finish_reason);
    expect(step2.some(c => c.choices?.[0]?.delta?.content)).toBe(false);
    expect(toolChunk.choices[0].delta.tool_calls[0].function).toEqual({
      name: "read",
      arguments: JSON.stringify({ i: "Reading file", path: "src/index.js:1-50" }),
    });
    expect(finishChunk.choices[0].finish_reason).toBe("tool_calls");
  });

  it("heals non-streaming Antigravity response containing leaked default_api call", () => {
    const res = translateNonStreamingResponse(
      {
        response: {
          responseId: "resp_3",
          modelVersion: "gemini-4-argon-medium",
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "call:default_api:glob{i:Listing files,limit:20,path:src/*}" }],
              },
              finishReason: "STOP",
            },
          ],
        },
      },
      FORMATS.ANTIGRAVITY,
      FORMATS.OPENAI,
    );

    expect(res.choices[0].finish_reason).toBe("tool_calls");
    expect(res.choices[0].message.content).toBeUndefined();
    expect(res.choices[0].message.tool_calls[0].function).toEqual({
      name: "glob",
      arguments: JSON.stringify({ i: "Listing files", limit: 20, path: "src/*" }),
    });
  });

  it("strips leaked prefixes after prose on the same line", () => {
    const { cleanedText, toolCalls } = extractLeakedGeminiToolCalls(
      "Searching now 하려コール{default_api:grep{i:check,path:src}}",
      true,
    );
    expect(cleanedText).toBe("Searching now ");
    expect(toolCalls).toEqual([{ name: "grep", args: { i: "check", path: "src" } }]);
  });

  it("flushes buffered leaked tool text when the stream ends", () => {
    const state = {
      model: "gemini-4-argon-medium",
      messageId: "resp_flush",
      pendingLeakedToolText: "하려コール{default_api:read{i:Reading file,path:src/index.js}}",
    };
    const chunks = geminiToOpenAIResponse(null, state);
    expect(chunks.some(c => c.choices?.[0]?.delta?.tool_calls)).toBe(true);
    expect(chunks.find(c => c.choices?.[0]?.finish_reason)?.choices[0].finish_reason).toBe("tool_calls");
    expect(state.pendingLeakedToolText).toBe("");
  });

  it("heals MALFORMED_FUNCTION_CALL candidates into tool_calls finish reason", () => {
    const chunks = geminiToOpenAIResponse({
      response: {
        responseId: "resp_malformed",
        candidates: [{
          content: { role: "model", parts: [{ text: "하려コール{default_api:read{i:Reading,path:src}}" }] },
          finishReason: "MALFORMED_FUNCTION_CALL",
        }],
      },
    }, { model: "gemini-4-argon" });
    expect(chunks.find(c => c.choices?.[0]?.finish_reason)?.choices[0].finish_reason).toBe("tool_calls");
  });

  it("translates max_completion_tokens, healed assistant calls, and multiple system/developer messages", () => {
    const result = openaiToAntigravityRequest("gemini-4-argon", {
      max_completion_tokens: 1234,
      messages: [
        { role: "system", content: "system one" },
        { role: "developer", content: "developer two" },
        { role: "system", content: "system three" },
        { role: "assistant", content: "Searching now 하려コール{default_api:grep{i:check,path:src}}" },
      ],
    }, true, { projectId: "project-test", _clientSessionId: "session-test" });

    expect(result.request.generationConfig.maxOutputTokens).toBe(1234);
    expect(result.request.systemInstruction.parts.map(part => part.text)).toEqual(["system one", "developer two", "system three"]);
    const lastParts = result.request.contents.at(-1).parts;
    expect(lastParts[0]).toEqual({ text: "Searching now " });
    expect(lastParts[1].functionCall.name).toBe("grep");
    expect(lastParts[1].functionCall.args).toEqual({ i: "check", path: "src" });
    expect(lastParts[1].thoughtSignature).toBe(DEFAULT_THINKING_AG_SIGNATURE);
  });

  it("applies Argon output ceiling and medium thinking level while cached signatures outrank fallback signatures", () => {
    const executor = new AntigravityExecutor();
    storeGeminiThoughtSignature("call-cached", "CACHED_SIGNATURE", "12345", "gemini-4-argon");
    const result = executor.transformRequest("gemini-4-argon", {
      model: "gemini-4-argon",
      request: {
        sessionId: "12345",
        generationConfig: { maxOutputTokens: 70000 },
        contents: [{ role: "model", parts: [{ functionCall: { id: "call-cached", name: "grep", args: {} }, thoughtSignature: DEFAULT_THINKING_AG_SIGNATURE }] }],
      },
    }, true, { projectId: "project-test" });

    expect(result.request.generationConfig).toMatchObject({
      maxOutputTokens: 65536,
      thinkingConfig: { thinkingLevel: "MEDIUM" },
    });
    expect(result.request.contents.at(-1).parts[0].thoughtSignature).toBe("CACHED_SIGNATURE");
  });

  it("buffers a mid-tool-name SSE split and heals it on the next chunk", () => {
    const state = { model: "gemini-4-argon-medium", messageId: "resp_split" };
    // The pending gate must hold `하려コール{default_api:read` without a closing brace.
    const step1 = geminiToOpenAIResponse(
      { response: { responseId: "resp_split", candidates: [{ content: { role: "model", parts: [{ text: "하려コール{default_api:read" }] } }] } },
      state,
    );
    expect(step1 === null || step1.every(c => !c.choices?.[0]?.delta?.content)).toBe(true);
    const step2 = geminiToOpenAIResponse(
      { response: { responseId: "resp_split", candidates: [{ content: { role: "model", parts: [{ text: "{i:Reading,path:src}}" }] }, finishReason: "STOP" }] } },
      state,
    );
    const toolChunk = step2.find(c => c.choices?.[0]?.delta?.tool_calls);
    expect(toolChunk?.choices[0].delta.tool_calls[0].function.name).toBe("read");
    expect(step2.find(c => c.choices?.[0]?.finish_reason)?.choices[0].finish_reason).toBe("tool_calls");
  });

  it("emits a valid OpenAI finish_reason for non-streaming MALFORMED_FUNCTION_CALL", () => {
    const res = translateNonStreamingResponse(
      {
        response: {
          responseId: "resp_malformed_ns",
          candidates: [{
            content: { role: "model", parts: [{ text: "call:default_api:read{i:Reading,path:src}" }] },
            finishReason: "MALFORMED_FUNCTION_CALL",
          }],
        },
      },
      FORMATS.ANTIGRAVITY,
      FORMATS.OPENAI,
    );
    expect(["tool_calls", "stop", "length", "content_filter"]).toContain(res.choices[0].finish_reason);
    expect(res.choices[0].finish_reason).toBe("tool_calls");
  });

  it("healed call reuses the orphan tool_call_id so the real result pairs", () => {
    const result = openaiToAntigravityRequest("gemini-4-argon", {
      tools: [{ type: "function", function: { name: "grep", description: "Search", parameters: { type: "object", properties: { i: { type: "string" }, path: { type: "string" } } } } }],
      messages: [
        { role: "user", content: "list files in src" },
        { role: "assistant", content: "Searching now 하려コール{default_api:grep{i:check,path:src}}" },
        { role: "tool", tool_call_id: "call_1", content: "a.ts" },
        { role: "user", content: "done?" },
      ],
    }, true, { projectId: "project-test", _clientSessionId: "session-test" });
    const parts = result.request.contents.flatMap(c => c.parts);
    const fresp = parts.find(p => p.functionResponse);
    expect(fresp.functionResponse.id).toBe("call_1");
    expect(fresp.functionResponse.name).toBe("grep");
    expect(JSON.stringify(fresp.functionResponse.response)).toContain("a.ts");
  });
});
