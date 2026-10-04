import { describe, expect, it } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import PROVIDERS from "../../open-sse/providers/registry/antigravity.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";

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

// Claude Opus 5.5 / Sonnet 5.5 landed in Antigravity 2026-10-03 (paid tiers).
// Their thinking tier travels inside the wire id itself
// (claude-{opus,sonnet}-5-5-{low,medium,high}) — the Gemini 3.8 pattern — so the
// executor must NOT inject generationConfig.thinkingConfig for them.
describe("Antigravity Claude 5.5 models", () => {
  const TIERED_IDS = [
    "claude-opus-5-5-high", "claude-opus-5-5-medium", "claude-opus-5-5-low",
    "claude-sonnet-5-5-high", "claude-sonnet-5-5-medium", "claude-sonnet-5-5-low",
  ];

  it("registry exposes all six tiered wire ids verbatim", () => {
    for (const id of TIERED_IDS) {
      const entry = PROVIDERS.models.find(m => m.id === id);
      expect(entry, id).toBeTruthy();
      expect(entry.upstreamModelId ?? entry.id, id).toBe(id);
    }
  });

  it("bare ids map to the medium tier upstream", () => {
    expect(getModelUpstreamId("ag", "claude-opus-5-5")).toBe("claude-opus-5-5-medium");
    expect(getModelUpstreamId("ag", "claude-sonnet-5-5")).toBe("claude-sonnet-5-5-medium");
  });

  it("wire id passes through untouched", () => {
    for (const id of TIERED_IDS) {
      expect(transform(id).model, id).toBe(id);
    }
  });

  it("no thinkingConfig is injected — the tier lives in the id", () => {
    for (const id of TIERED_IDS) {
      expect(transform(id).request.generationConfig.thinkingConfig, id).toBeUndefined();
    }
  });

  it("claude labels are attached", () => {
    const out = transform("claude-sonnet-5-5-high");
    expect(out.request.labels.used_claude).toBe("1");
    expect(out.request.labels.used_claude_conservative).toBe("1");
    expect(out.request.labels.model_enum).toBeUndefined();
  });

  it("capabilities resolve to 1M adaptive-thinking Claude", () => {
    for (const id of ["claude-opus-5-5-medium", "claude-sonnet-5-5-high", "claude-opus-5-5", "claude-sonnet-5-5"]) {
      const caps = getCapabilitiesForModel("antigravity", id);
      expect(caps.thinkingFormat, id).toBe("claude-adaptive");
      expect(caps.contextWindow, id).toBe(1000000);
      expect(caps.vision, id).toBe(true);
    }
  });

  it("thinking levels expose the adaptive ladder", () => {
    expect(getThinkingLevels("antigravity", "claude-opus-5-5-high"))
      .toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(getThinkingLevels("antigravity", "claude-sonnet-5-5-low"))
      .toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });
});
