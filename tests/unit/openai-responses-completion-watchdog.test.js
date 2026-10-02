import { describe, expect, it, vi } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

const encoder = new TextEncoder();
const FINISH_CHUNK = {
  id: "chatcmpl-1",
  choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
};
const USAGE_TRAILER = { id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } };

function completedResponses(text) {
  return text.split("\n")
    .filter((line) => line.startsWith("data: ") && line.includes('"type":"response.completed"'))
    .map((line) => JSON.parse(line.slice(6)).response);
}

async function readAll(reader) {
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function openPipeline(onComplete = null) {
  let source;
  const input = new ReadableStream({ start(controller) { source = controller; } });
  const output = input.pipeThrough(createSSETransformStreamWithLogger(
    FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "test", null, null, "gpt-test", null, null, onComplete,
  ));
  return { source, reader: output.getReader() };
}

describe("pending response.completed watchdog", () => {
  it("flushes completion after finish_reason when usage and [DONE] never arrive", async () => {
    vi.useFakeTimers();
    try {
      const { source, reader } = openPipeline();
      source.enqueue(encoder.encode(`data: ${JSON.stringify(FINISH_CHUNK)}\n\n`));
      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(3000);
      source.close();
      const completed = completedResponses(await readAll(reader));
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ status: "completed", output: [{ type: "message" }] });
      expect(completed[0].usage).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a usage trailer and clears the watchdog without duplicate completion", async () => {
    vi.useFakeTimers();
    try {
      const { source, reader } = openPipeline();
      source.enqueue(encoder.encode(`data: ${JSON.stringify(FINISH_CHUNK)}\n\n`));
      await vi.advanceTimersByTimeAsync(20);
      source.enqueue(encoder.encode(`data: ${JSON.stringify(USAGE_TRAILER)}\n\n`));
      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(10000);
      source.close();
      const completed = completedResponses(await readAll(reader));
      expect(completed).toHaveLength(1);
      expect(completed[0].usage).toMatchObject({ input_tokens: 120, output_tokens: 30 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not report successful completion if the client cancels while completion is pending", async () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    try {
      const { source, reader } = openPipeline(onComplete);
      source.enqueue(encoder.encode(`data: ${JSON.stringify(FINISH_CHUNK)}\n\n`));
      await vi.advanceTimersByTimeAsync(20);
      await reader.cancel();
      await vi.advanceTimersByTimeAsync(3000);
      expect(onComplete).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
