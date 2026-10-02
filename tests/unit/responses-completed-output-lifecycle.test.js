import { describe, expect, it } from "vitest";
import { initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";

describe("Responses completion lifecycle", () => {
  it("includes completed text items in response.completed", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const chunks = [
      { id: "chatcmpl-output", choices: [{ index: 0, delta: { content: "complete answer" }, finish_reason: null }] },
      { id: "chatcmpl-output", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    const events = chunks.flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state));
    const completed = events.filter((event) => event.event === "response.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].data.response.output).toMatchObject([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "complete answer" }] },
    ]);
  });

  it("includes completed tool calls in response.completed", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const events = [
      { id: "chatcmpl-tool", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] }, finish_reason: null }] },
      { id: "chatcmpl-tool", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ].flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state));
    const completed = events.find((event) => event.event === "response.completed");
    expect(completed.data.response.output).toMatchObject([
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"x\"}" },
    ]);
  });

  it("waits through placeholder usage for a real usage trailer and completes once", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    state.targetFormat = FORMATS.OPENAI;
    const finish = openaiToOpenAIResponsesResponse({
      id: "chatcmpl-usage",
      choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }, state);
    expect(finish.some((event) => event.event === "response.completed")).toBe(false);
    const trailer = openaiToOpenAIResponsesResponse({
      choices: [],
      usage: { prompt_tokens: 17, completion_tokens: 4, total_tokens: 999 },
    }, state);
    const completed = trailer.filter((event) => event.event === "response.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].data.response.usage).toEqual({ input_tokens: 17, output_tokens: 4, total_tokens: 21 });
    expect(openaiToOpenAIResponsesResponse(null, state)).toEqual([]);
  });
});
