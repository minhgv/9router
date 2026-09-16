/**
 * Some providers (e.g. codebuddy / cbcn) attach `tool_calls: []` to every
 * streaming chunk. An empty array is truthy in JS, so the guard
 * `if (delta.tool_calls)` closed the message on the first content token,
 * emitting `output_text.done` early and truncating the answer. This mirrors
 * the real repro: `codex exec -m cbcn/kimi-k3` answered only "cod" instead
 * of "codex-ok".
 */
import { describe, it, expect } from "vitest";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("OpenAI Chat stream -> Responses: empty tool_calls arrays", () => {
  it("does not emit output_text.done early when every chunk carries tool_calls: []", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const chunks = [
      { id: "cmb-test", choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning_content: "", tool_calls: [] }, finish_reason: null }] },
      { id: "cmb-test", choices: [{ index: 0, delta: { content: "", reasoning_content: "thinking", tool_calls: [] }, finish_reason: null }] },
      { id: "cmb-test", choices: [{ index: 0, delta: { content: "cod", reasoning_content: "", tool_calls: [] }, finish_reason: null }] },
      { id: "cmb-test", choices: [{ index: 0, delta: { content: "ex", reasoning_content: "", tool_calls: [] }, finish_reason: null }] },
      { id: "cmb-test", choices: [{ index: 0, delta: { content: "-ok", reasoning_content: "", tool_calls: [] }, finish_reason: null }] },
      { id: "cmb-test", choices: [{ index: 0, delta: { content: "", reasoning_content: "", tool_calls: [] }, finish_reason: "stop" }] },
    ];

    const events = chunks.flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state));
    const textDone = events.filter((e) => e.event === "response.output_text.done");
    const textDeltas = events.filter((e) => e.event === "response.output_text.delta");

    expect(textDone).toHaveLength(1);
    expect(textDone[0].data.text).toBe("codex-ok");
    expect(textDeltas.map((e) => e.data.delta).join("")).toBe("codex-ok");
    // done must come after every delta
    expect(events.indexOf(textDone[0])).toBe(events.indexOf(textDeltas[textDeltas.length - 1]) + 1);
  });

  it("still closes the message before a real tool call", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const chunks = [
      { id: "cmb-test", choices: [{ index: 0, delta: { content: "Let me run that.", tool_calls: [] }, finish_reason: null }] },
      { id: "cmb-test", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "exec", arguments: "" } }] }, finish_reason: null }] },
      { id: "cmb-test", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];

    const events = chunks.flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state));
    const added = events.find((e) => e.event === "response.output_item.added" && e.data.item?.type === "function_call");
    const textDone = events.find((e) => e.event === "response.output_text.done");

    expect(added).toBeTruthy();
    expect(textDone.data.text).toBe("Let me run that.");
  });

  it("CODEX-03: handles tool call with empty arguments string and subsequent deltas", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const chunks = [
      { id: "tc-empty", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "no_args", arguments: "" } }] }, finish_reason: null }] },
      { id: "tc-empty", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: null }] },
      { id: "tc-empty", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];

    const events = chunks.flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state));
    const added = events.find((e) => e.event === "response.output_item.added" && e.data.item?.name === "no_args");
    const delta = events.find((e) => e.event === "response.function_call_arguments.delta");
    const done = events.find((e) => e.event === "response.output_item.done");

    expect(added).toBeDefined();
    expect(delta?.data?.delta).toBe("{}");
    expect(done).toBeDefined();
  });

  it("CODEX-03: handles multiple parallel tool calls with empty and non-empty arguments", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const chunks = [
      { id: "tc-multi", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [
        { index: 0, id: "call_1", type: "function", function: { name: "fn1", arguments: "" } },
        { index: 1, id: "call_2", type: "function", function: { name: "fn2", arguments: "" } },
      ] }, finish_reason: null }] },
      { id: "tc-multi", choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, function: { arguments: '{"k":' } },
        { index: 1, function: { arguments: '{"v":' } },
      ] }, finish_reason: null }] },
      { id: "tc-multi", choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, function: { arguments: '1}' } },
        { index: 1, function: { arguments: '2}' } },
      ] }, finish_reason: null }] },
      { id: "tc-multi", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];

    const events = chunks.flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state));
    const addedEvents = events.filter((e) => e.event === "response.output_item.added");
    expect(addedEvents).toHaveLength(2);
    expect(addedEvents[0].data.item.name).toBe("fn1");
    expect(addedEvents[1].data.item.name).toBe("fn2");
  });
});
