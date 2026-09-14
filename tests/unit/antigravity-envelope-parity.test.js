import { describe, expect, it } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

// Parity with the official antigravity consumer client (and antigravity-opencode):
// the envelope must not serialize `requestType: "agent"` — that lane is a
// rate-limited bucket which trips bare 429 RESOURCE_EXHAUSTED responses.
const credentials = {
  projectId: "synthetic-project",
  connectionId: "synthetic-connection",
  email: "tester@example.com",
};

describe("Antigravity envelope parity (no requestType on text requests)", () => {
  it("executor text envelope omits requestType", () => {
    const executor = new AntigravityExecutor();
    const output = executor.transformRequest(
      "gemini-3.8-flash-high",
      { request: { contents: [{ role: "user", parts: [{ text: "Reply only OK" }] }] } },
      true,
      credentials,
    );

    expect(output.requestType).toBeUndefined();
    expect(output.userAgent).toBe("antigravity");
    expect(output.requestId).toMatch(/^agent\/[0-9a-f-]+\/\d+\/[0-9a-f-]+\/\d+$/);
    expect(output.project).toBe("synthetic-project");
  });

  it("executor image envelope still sends requestType image_gen", () => {
    const executor = new AntigravityExecutor();
    const output = executor.transformRequest(
      "gemini-3.1-flash-image",
      { prompt: "a red cube", request: { contents: [] } },
      true,
      credentials,
    );

    expect(output.requestType).toBe("image_gen");
  });

  it("gemini translator envelope omits requestType", () => {
    const output = openaiToAntigravityRequest(
      "gemini-3.8-flash-high",
      { messages: [{ role: "user", content: "Reply only OK" }], stream: false },
      false,
      credentials,
    );

    expect(output.requestType).toBeUndefined();
    expect(output.userAgent).toBe("antigravity");
    expect(typeof output.request.sessionId).toBe("string");
  });

  it("claude translator envelope omits requestType", () => {
    const output = openaiToAntigravityRequest(
      "claude-sonnet-4-6",
      { messages: [{ role: "user", content: "Reply only OK" }], stream: false, max_tokens: 64 },
      false,
      credentials,
    );

    expect(output.requestType).toBeUndefined();
    expect(output.userAgent).toBe("antigravity");
  });
});
