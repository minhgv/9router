import { describe, expect, it } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import PROVIDERS from "../../open-sse/providers/registry/antigravity.js";

const credentials = {
  projectId: "synthetic-project",
  connectionId: "synthetic-connection",
  email: "tester@example.com",
};

function transform(model) {
  const executor = new AntigravityExecutor();
  return executor.transformRequest(
    model,
    { request: { contents: [{ role: "user", parts: [{ text: "Reply only OK" }] }] } },
    true,
    credentials,
  );
}

describe("Antigravity wire catalog parity", () => {
  it("no wire id carries a synthetic (tier) suffix", () => {
    for (const entry of PROVIDERS.models) {
      if (entry.upstreamModelId) {
        expect(entry.upstreamModelId, entry.id).not.toMatch(/\(/);
      }
    }
  });

  it("gemini-3.5-flash-high maps to the agent wire id", () => {
    const entry = PROVIDERS.models.find(m => m.id === "gemini-3.5-flash-high");
    expect(entry.upstreamModelId).toBe("gemini-3-flash-agent");
  });

  it("tiered flash ids inject thinkingLevel", () => {
    expect(transform("gemini-3.8-flash-high").request.generationConfig.thinkingConfig)
      .toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
    expect(transform("gemini-3.7-flash-medium").request.generationConfig.thinkingConfig)
      .toEqual({ includeThoughts: true, thinkingLevel: "MEDIUM" });
    expect(transform("gemini-3.6-flash-low").request.generationConfig.thinkingConfig)
      .toEqual({ includeThoughts: true, thinkingLevel: "LOW" });
  });

  it("agent/pro ids are the High tier, non-gemini models inject nothing", () => {
    expect(transform("gemini-3-flash-agent").request.generationConfig.thinkingConfig)
      .toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
    expect(transform("gemini-pro-agent").request.generationConfig.thinkingConfig)
      .toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
    expect(transform("claude-sonnet-4-6").request.generationConfig.thinkingConfig).toBeUndefined();
    expect(transform("gpt-oss-120b-medium").request.generationConfig.thinkingConfig).toBeUndefined();
    expect(transform("gemini-3-flash").request.generationConfig.thinkingConfig).toBeUndefined();
  });

  it("client-supplied thinkingConfig never leaks through — executor owns it", () => {
    const executor = new AntigravityExecutor();
    const output = executor.transformRequest(
      "gemini-3.8-flash-high",
      { request: { contents: [{ role: "user", parts: [{ text: "OK" }] }], generationConfig: { thinkingConfig: { thinkingLevel: "BOGUS", includeThoughts: false } } } },
      true,
      credentials,
    );
    expect(output.request.generationConfig.thinkingConfig)
      .toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
  });
});
