import { describe, expect, it } from "vitest";

import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { getModelUpstreamId, getProviderModels } from "../../open-sse/config/providerModels.js";
import { MITM_TOOLS } from "../../src/shared/constants/cliTools.js";

// Gemini 4 "Argon" (announced 2026-09-30, pre-release). Wire ids verified from
// the Antigravity IDE 2.23.0 language_server binary; caps/pricing per the
// Artificial Analysis model page (models.dev does not carry it yet).

const ARGON_IDS = ["gemini-4-argon", "gemini-4-argon-high", "gemini-4-argon-medium", "gemini-4-argon-low"];

describe("gemini-4-argon capabilities", () => {
  it("resolves the announced spec", () => {
    const c = getCapabilitiesForModel("antigravity", "gemini-4-argon");
    expect(c.vision).toBe(true);            // image input documented
    expect(c.reasoning).toBe(true);         // reasoning model
    expect(c.search).toBe(true);            // Gemini line standard
    expect(c.contextWindow).toBe(1048576);  // 1.0M tokens
    expect(c.thinkingFormat).toBe("gemini-level");
    expect(c.thinkingCanDisable).toBe(false);
  });

  it("keeps the 3.x line's 64K output limit (launch figure unpublished)", () => {
    // PR-4507 upstream claimed 1M output with no public source — we stay on
    // the line's known value until one appears.
    expect(getCapabilitiesForModel("antigravity", "gemini-4-argon").maxOutput).toBe(65536);
    expect(getCapabilitiesForModel("antigravity", "gemini-3.8-flash").maxOutput).toBe(65536);
  });

  it("is NOT captured by the gemini-3 wildcard", () => {
    // Patterns match in order: *gemini-4* must sit above *gemini-3*.
    const c4 = getCapabilitiesForModel("antigravity", "gemini-4-argon");
    const c3 = getCapabilitiesForModel("antigravity", "gemini-3.8-flash");
    // The distinguishing claim: audio/video not documented for Argon yet.
    expect(c4.audioInput).toBe(false);
    expect(c4.videoInput).toBe(false);
    // ...while the 3.x line does claim them, proving the patterns differ.
    expect(c3.audioInput).toBe(true);
    expect(c3.videoInput).toBe(true);
  });

  it("covers every tier wire id", () => {
    for (const id of ARGON_IDS) {
      const c = getCapabilitiesForModel("antigravity", id);
      expect(c.reasoning, id).toBe(true);
      expect(c.contextWindow, id).toBe(1048576);
      expect(c.thinkingFormat, id).toBe("gemini-level");
    }
  });

  it("leaves the rest of the Gemini line untouched", () => {
    for (const [id, expectLevel] of [
      ["gemini-3.8-flash", "gemini-level"],
      ["gemini-2.5-pro", "gemini-budget"],
      ["gemini-2.0-flash", null],
    ]) {
      const c = getCapabilitiesForModel("antigravity", id);
      expect(c.thinkingFormat, id).toBe(expectLevel);
      expect(c.contextWindow, id).toBe(1048576);
    }
  });
});

describe("gemini-4-argon registry (antigravity)", () => {
  // PROVIDER_MODELS is keyed by registry alias — antigravity registers "ag".
  it("declares all 4 wire ids verified from the 2.23.0 language_server", () => {
    const ids = getProviderModels("ag").map((m) => m.id);
    for (const id of ARGON_IDS) expect(ids, id).toContain(id);
  });

  it("uses literal upstream wire ids — no synthetic (tier) suffix", () => {
    // daily-cloudcode-pa 404s the "(tier)" form; the executor carries the tier
    // in generationConfig.thinkingConfig.thinkingLevel instead.
    for (const id of ARGON_IDS) {
      const upstream = getModelUpstreamId("ag", id);
      expect(upstream, id).not.toMatch(/\([^()]+\)/);
    }
    // Base id maps to the Medium tier (parity: gemini-3.8-flash → -medium).
    expect(getModelUpstreamId("ag", "gemini-4-argon")).toBe("gemini-4-argon-medium");
    expect(getModelUpstreamId("ag", "gemini-4-argon-high")).toBe("gemini-4-argon-high");
    expect(getModelUpstreamId("ag", "gemini-4-argon-low")).toBe("gemini-4-argon-low");
  });


  it("is exposed to the Antigravity MITM tool (aliases + defaultModels)", () => {
    const tool = MITM_TOOLS.antigravity;
    for (const id of ARGON_IDS) {
      expect(tool.modelAliases, `alias ${id}`).toContain(id);
      expect(
        tool.defaultModels.some((m) => m.id === id && m.alias === id),
        `defaultModel ${id}`
      ).toBe(true);
    }
  });
});

describe("gemini-4-argon pricing", () => {
  it("carries full pricing rates on every tier so cached tokens are not billed at full input rate", () => {
    for (const id of ARGON_IDS) {
      const p = getPricingForModel("antigravity", id);
      expect(p, id).toEqual({
        input: 2.00,
        output: 10.00,
        cached: 0.20,
        reasoning: 15.00,
        cache_creation: 2.50,
      });
    }
  });
});
