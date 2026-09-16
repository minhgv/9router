// Parallel function_calls from a Responses upstream must stay on separate
// chat tool_calls indices. Regression: response/openai-responses.js attributed
// every arguments delta to the positional toolCallIndex (advanced only on
// output_item.done), so all-added-then-deltas ordering concatenated N JSON
// payloads into index 0 and clients failed with InputValidationError.
import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";
import { clampResponsesCallId, coerceResponsesOutput, MAX_RESPONSES_CALL_ID_LEN } from "../../open-sse/translator/formats/responsesApi.js";
import { initState, translateResponse } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const added = (id, call_id, name, type = "function_call") => ({
  type: "response.output_item.added",
  item: { id, type, call_id, name, arguments: "" },
});
const delta = (item_id, text) => ({
  type: "response.function_call_arguments.delta",
  item_id,
  delta: text,
});
const done = (id, call_id, name) => ({
  type: "response.output_item.done",
  item: { id, type: "function_call", call_id, name },
});

// Reassemble translated chunks the way an OpenAI client accumulator does.
function accumulate(calls, chunks) {
  for (const chunk of chunks) {
    if (!chunk) continue;
    for (const tc of chunk.choices?.[0]?.delta?.tool_calls || []) {
      const slot = (calls[tc.index] ??= { id: null, name: "", args: "" });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
  }
  return calls;
}

function runStream(events) {
  const state = {};
  const chunks = [];
  for (const ev of events) {
    const out = openaiResponsesToOpenAIResponse(ev, state);
    if (out) chunks.push(out);
  }
  const flush = openaiResponsesToOpenAIResponse(null, state);
  if (flush) chunks.push(flush);
  return { state, chunks };
}

const PAYLOADS = [
  '{"file_path":"/docs/PRODUCT.md"}',
  '{"file_path":"/docs/ROADMAP.md"}',
  '{"file_path":"/docs/openapi.custom.yaml"}',
  '{"file_path":"/docs/.gitignore"}',
];

function hostileOrdering() {
  const events = PAYLOADS.map((_, i) => added(`fc_${i}`, `call_${i}`, "read_file"));
  // Interleaved deltas AFTER all addeds — the ordering that used to merge all
  // four payloads into index 0.
  PAYLOADS.forEach((p, i) => events.push(delta(`fc_${i}`, p.slice(0, 20)), delta(`fc_${i}`, p.slice(20))));
  PAYLOADS.forEach((_, i) => events.push(done(`fc_${i}`, `call_${i}`, "read_file")));
  return events;
}

describe("responses parallel tool calls keep their own index", () => {
  it("all-added-then-deltas ordering yields 4 separately parseable calls", () => {
    const { chunks } = runStream(hostileOrdering());
    const calls = accumulate({}, chunks);
    expect(Object.keys(calls)).toHaveLength(4);
    PAYLOADS.forEach((p, i) => {
      expect(calls[i].id).toBe(`call_${i}`);
      expect(calls[i].name).toBe("read_file");
      expect(JSON.parse(calls[i].args)).toEqual(JSON.parse(p));
    });
  });

  it("sequential ordering still yields indices 0,1 in order", () => {
    const events = [
      added("fc_0", "call_0", "read_file"),
      delta("fc_0", PAYLOADS[0]),
      done("fc_0", "call_0", "read_file"),
      added("fc_1", "call_1", "read_file"),
      delta("fc_1", PAYLOADS[1]),
      done("fc_1", "call_1", "read_file"),
    ];
    const { chunks } = runStream(events);
    const calls = accumulate({}, chunks);
    expect(Object.keys(calls)).toEqual(["0", "1"]);
    expect(JSON.parse(calls[0].args)).toEqual(JSON.parse(PAYLOADS[0]));
    expect(JSON.parse(calls[1].args)).toEqual(JSON.parse(PAYLOADS[1]));
  });

  it("done carrying full arguments (no deltas) emits them once", () => {
    const state = {};
    const out1 = openaiResponsesToOpenAIResponse(added("fc_9", "call_9", "read_file"), state);
    const out2 = openaiResponsesToOpenAIResponse({
      type: "response.output_item.done",
      item: { id: "fc_9", type: "function_call", call_id: "call_9", name: "read_file", arguments: PAYLOADS[0] },
    }, state);
    const calls = accumulate({}, [out1, out2]);
    expect(JSON.parse(calls[0].args)).toEqual(JSON.parse(PAYLOADS[0]));
  });

  it("deltas without item_id fall back to the most recent call (legacy behavior)", () => {
    const events = [
      added("fc_0", "call_0", "read_file"),
      { type: "response.function_call_arguments.delta", delta: PAYLOADS[0] },
      done("fc_0", "call_0", "read_file"),
    ];
    const { chunks } = runStream(events);
    const calls = accumulate({}, chunks);
    expect(JSON.parse(calls[0].args)).toEqual(JSON.parse(PAYLOADS[0]));
  });
});

describe("responses → claude end-to-end keeps parallel tool_use blocks separate", () => {
  it("four read_file calls arrive as four parseable tool_use blocks", () => {
    const state = initState(FORMATS.CLAUDE);
    const out = [];
    for (const ev of hostileOrdering()) {
      for (const r of translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, ev, state)) out.push(r);
    }
    for (const r of translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, null, state)) out.push(r);

    const starts = out.filter((r) => r?.type === "content_block_start" && r?.content_block?.type === "tool_use");
    expect(starts).toHaveLength(4);
    const partials = out.filter((r) => r?.delta?.type === "input_json_delta");
    expect(partials).toHaveLength(4);
    const bodies = partials.map((r) => JSON.parse(r.delta.partial_json).file_path).sort();
    expect(bodies).toEqual([
      "/docs/.gitignore",
      "/docs/PRODUCT.md",
      "/docs/ROADMAP.md",
      "/docs/openapi.custom.yaml",
    ]);
  });
});

describe("fallback call_ids stay unique within a batch", () => {
  it("same-millisecond fallbacks never collide", () => {
    const ids = new Set(Array.from({ length: 50 }, () => clampResponsesCallId(undefined)));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id.startsWith("call_")).toBe(true);
      expect(id.length).toBeLessThanOrEqual(MAX_RESPONSES_CALL_ID_LEN);
    }
    expect(new Set([clampResponsesCallId(""), clampResponsesCallId(null)]).size).toBe(2);
  });
});

describe("output coercion stays fail-soft on unstringifiable values", () => {
  it("never throws on BigInt/circular array elements", () => {
    const circular = {};
    circular.self = circular;
    const input = [1n, circular, { text: "ok" }];
    expect(() => coerceResponsesOutput(input)).not.toThrow();
    const out = coerceResponsesOutput(input);
    expect(typeof out).toBe("string");
    expect(out).toContain("ok");
  });
});

describe("CODEX-03: responses parallel tool calls fine-grained streaming & terminal events", () => {
  it("interleaved byte-by-byte deltas across 3 parallel calls stay isolated", () => {
    const callsMeta = [
      { id: "fc_a", call_id: "call_a", name: "get_weather", json: '{"location":"Tokyo"}' },
      { id: "fc_b", call_id: "call_b", name: "get_time", json: '{"zone":"Asia/Tokyo"}' },
      { id: "fc_c", call_id: "call_c", name: "convert_currency", json: '{"amount":100,"from":"USD","to":"JPY"}' },
    ];

    const events = [];
    // 1. Add all items
    for (const c of callsMeta) {
      events.push(added(c.id, c.call_id, c.name));
    }
    // 2. Interleave characters
    const maxLen = Math.max(...callsMeta.map((c) => c.json.length));
    for (let i = 0; i < maxLen; i++) {
      for (const c of callsMeta) {
        if (i < c.json.length) {
          events.push(delta(c.id, c.json[i]));
        }
      }
    }
    // 3. Mark all done
    for (const c of callsMeta) {
      events.push(done(c.id, c.call_id, c.name));
    }

    const { chunks } = runStream(events);
    const accumulated = accumulate({}, chunks);

    expect(Object.keys(accumulated)).toHaveLength(3);
    expect(accumulated[0].id).toBe("call_a");
    expect(accumulated[0].name).toBe("get_weather");
    expect(JSON.parse(accumulated[0].args)).toEqual({ location: "Tokyo" });

    expect(accumulated[1].id).toBe("call_b");
    expect(accumulated[1].name).toBe("get_time");
    expect(JSON.parse(accumulated[1].args)).toEqual({ zone: "Asia/Tokyo" });

    expect(accumulated[2].id).toBe("call_c");
    expect(accumulated[2].name).toBe("convert_currency");
    expect(JSON.parse(accumulated[2].args)).toEqual({ amount: 100, from: "USD", to: "JPY" });
  });

  it("translates terminal response.done event with usage and tool_calls finish_reason", () => {
    const state = {};
    const evAdded = added("fc_term", "call_term", "calculate");
    const evDelta = delta("fc_term", '{"expr":"2+2"}');
    const evDone = done("fc_term", "call_term", "calculate");
    const evResponseDone = {
      type: "response.done",
      response: {
        id: "resp_123",
        status: "completed",
        usage: {
          input_tokens: 42,
          output_tokens: 18,
          total_tokens: 60,
        },
      },
    };

    const chunk1 = openaiResponsesToOpenAIResponse(evAdded, state);
    const chunk2 = openaiResponsesToOpenAIResponse(evDelta, state);
    const chunk3 = openaiResponsesToOpenAIResponse(evDone, state);
    const chunk4 = openaiResponsesToOpenAIResponse(evResponseDone, state);
    const chunk5 = openaiResponsesToOpenAIResponse(null, state); // flush

    const chunks = [chunk1, chunk2, chunk3, chunk4, chunk5].filter(Boolean);
    const calls = accumulate({}, chunks);

    expect(calls[0].id).toBe("call_term");
    expect(calls[0].name).toBe("calculate");
    expect(JSON.parse(calls[0].args)).toEqual({ expr: "2+2" });

    // Check that usage and finish_reason are preserved in output chunks
    const finishChunk = chunks.find((c) => c.choices?.[0]?.finish_reason === "tool_calls");
    expect(finishChunk).toBeDefined();

    const usageChunk = chunks.find((c) => c.usage);
    if (usageChunk) {
      expect(usageChunk.usage.prompt_tokens || usageChunk.usage.input_tokens).toBe(42);
    }
  });

  it("resets state cleanly between independent streams", () => {
    // Stream 1
    const stream1 = runStream([
      added("fc_s1", "call_s1", "tool_one"),
      delta("fc_s1", '{"a":1}'),
      done("fc_s1", "call_s1", "tool_one"),
    ]);
    const calls1 = accumulate({}, stream1.chunks);
    expect(calls1[0].name).toBe("tool_one");

    // Stream 2 with fresh state
    const stream2 = runStream([
      added("fc_s2", "call_s2", "tool_two"),
      delta("fc_s2", '{"b":2}'),
      done("fc_s2", "call_s2", "tool_two"),
    ]);
    const calls2 = accumulate({}, stream2.chunks);
    expect(calls2[0].name).toBe("tool_two");
    expect(calls2[1]).toBeUndefined();
  });
});
