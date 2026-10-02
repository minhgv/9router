import { describe, expect, it } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

async function runTransform(chunks, targetFormat, provider) {
  const encoder = new TextEncoder();
  const input = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });
  const output = source.pipeThrough(createSSETransformStreamWithLogger(
    targetFormat, FORMATS.OPENAI_RESPONSES, provider, null, null, "claude-sonnet-5",
  ));
  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function completedResponse(text) {
  const lines = text.split("\n").filter((line) => line.startsWith("data: ") && line.includes('"type":"response.completed"'));
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0].slice(6)).response;
}

const CLAUDE_CHUNKS_WITH_USAGE = [
  { type: "message_start", message: { id: "msg-1", model: "claude-sonnet-5", usage: { input_tokens: 1500, cache_read_input_tokens: 12000, cache_creation_input_tokens: 300, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } },
  { type: "message_stop" },
];

describe("OpenAI Responses usage across the Claude pivot", () => {
  it("reports merged Claude usage in response.completed", async () => {
    const output = await runTransform(CLAUDE_CHUNKS_WITH_USAGE, FORMATS.CLAUDE, "claude");
    expect(completedResponse(output).usage).toEqual({
      input_tokens: 13800,
      output_tokens: 42,
      total_tokens: 13842,
      input_tokens_details: { cached_tokens: 12000 },
    });
  });

  it("always reports all required top-level usage counts", async () => {
    const output = await runTransform(CLAUDE_CHUNKS_WITH_USAGE, FORMATS.CLAUDE, "claude");
    const usage = completedResponse(output).usage;
    for (const field of ["input_tokens", "output_tokens", "total_tokens"]) {
      expect(Number.isFinite(usage[field])).toBe(true);
    }
  });
});
