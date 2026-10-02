import { describe, expect, it } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import codex from "../../open-sse/providers/registry/codex.js";
import { getModelInfoCore } from "../../open-sse/services/model.js";
import { getModelQuotaFamily, getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";

import { stripModelContextMarker } from "../../open-sse/utils/modelMarkers.js";
const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }];
const functionTool = (name, parameters = { type: "object", properties: {} }) => ({
  type: "function", function: { name, description: `${name} tool`, parameters },
});

describe("Codex GPT-6.1 Sol Responses Lite", () => {
  it("serializes a valid multi-tool schema and places instructions/tools before every turn", () => {
    const executor = new CodexExecutor();
    const body = executor.transformRequest("gpt-6.1-sol", {
      model: "gpt-6.1-sol", input: structuredClone(input),
      instructions: "Use tools carefully.",
      tools: [functionTool("lookup"), functionTool("update", { type: "object", pattern: "\\p{L}" })],
      tool_choice: { type: "function", function: { name: "lookup" } },
    }, true, {});
    const prefix = body.input.slice(0, 2);
    expect(prefix.map((item) => item.type)).toEqual(["additional_tools", "message"]);
    expect(prefix[0].tools.map((tool) => tool.name)).toEqual(["lookup", "update"]);
    expect(prefix[0].tools[0]).toMatchObject({
      type: "function",
      name: "lookup",
      description: "lookup tool",
      parameters: { type: "object", properties: {} },
    });
    expect(prefix[0].tools[1]).toMatchObject({
      type: "function",
      name: "update",
      description: "update tool",
      parameters: { type: "object" },
    });
    expect(prefix[0].tools[1].parameters.pattern).toBeUndefined();
    expect(prefix[1]).toEqual({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Use tools carefully." }],
    });
    expect(body.tool_choice).toEqual({ type: "function", name: "lookup" });
    expect(body.reasoning).toMatchObject({ effort: "medium", context: "all_turns" });
    expect(body.instructions).toBe("");
    expect(body.tools).toBeNull();
    expect(body.parallel_tool_calls).toBe(false);
    expect(executor.buildHeaders({}, true, null, "gpt-6.1-sol", body)["x-openai-internal-codex-responses-lite"]).toBe("true");
  });
  it("creates the Lite prefix even when the incoming request has no input", () => {
    const body = new CodexExecutor().transformRequest("gpt-6-sol", {
      model: "gpt-6-sol", tools: [functionTool("lookup")],
    }, true, {});
    expect(body.input[0]).toMatchObject({ type: "additional_tools", tools: [{ name: "lookup" }] });
    expect(body.input[1]).toMatchObject({ type: "message", role: "developer" });
    expect(body.input[2]).toMatchObject({ type: "message", role: "user" });
    expect(body.reasoning.context).toBe("all_turns");
  });

  it("keeps all turns in the prefix, supports the context annotation and maps review/effort to the wire id", () => {
    const body = new CodexExecutor().transformRequest("gpt-6-sol", {
      model: "gpt-6-sol-review(high)", input: structuredClone(input), tools: [],
    }, true, { contextMarker: "1m" });
    expect(body.input.map((item) => item.type)).toEqual(["additional_tools", "message", "message"]);
    expect(body.model).toBe("gpt-6-sol");
    expect(body.reasoning).toMatchObject({ effort: "high", context: "all_turns" });
    expect(stripModelContextMarker("gpt-6-sol(high)[1m]-review")).toEqual({
      model: "gpt-6-sol(high)-review", contextMarker: "1m",
    });
    expect(JSON.stringify(body)).not.toContain("contextMarker");
    expect(getModelUpstreamId("cx", "gpt-6-sol-review(high)[1m]")).toBe("gpt-6-sol(high)");
    expect(getModelUpstreamId("cx", "gpt-6-sol(high)[1m]-review")).toBe("gpt-6-sol(high)");
    expect(getModelQuotaFamily("cx", "gpt-6-sol(high)[1m]-review")).toBe("review");
  });

  it("falls back to the hosted search contract instead of Lite when web search is requested", () => {
    const executor = new CodexExecutor();
    const body = executor.transformRequest("gpt-6.1-sol", {
      model: "gpt-6.1-sol", input: structuredClone(input),
      tools: [{ type: "web_search_preview", search_context_size: "high" }],
    }, true, {});
    expect(body.tools).toEqual([{ type: "web_search_preview", search_context_size: "high" }]);
    expect(body.instructions).toBeTruthy();
    expect(body.reasoning.context).toBeUndefined();
    const headers = executor.buildHeaders({}, true, null, "gpt-6.1-sol", body);
    expect(headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();
  });
  it("moves native-prefix hosted search to Responses tools without losing developer instructions", () => {
    const instruction = { type: "message", role: "developer", content: [{ type: "input_text", text: "Answer in French" }] };
    const body = new CodexExecutor().transformRequest("gpt-6.1-sol", {
      model: "gpt-6.1-sol",
      input: [
        { type: "additional_tools", role: "developer", tools: [functionTool("lookup"), { type: "web_search" }] },
        instruction,
        ...structuredClone(input),
      ],
    }, true, {});
    expect(body.input.some((item) => item.type === "additional_tools")).toBe(false);
    expect(body.input).toContainEqual(instruction);
    expect(body.tools).toEqual([
      { type: "function", name: "lookup", description: "lookup tool", parameters: { type: "object", properties: {} } },
      { type: "web_search" },
    ]);
    expect(body.instructions).toBe("");
  });

  it("advertises the real context, output, price, and accepted effort contract", () => {
    expect(getCapabilitiesForModel("codex", "gpt-6-sol[1m]")).toMatchObject({ contextWindow: 872000, maxOutput: 128000 });
    expect(getCapabilitiesForModel("codex", "gpt-6-sol(high)[1m]-review").contextWindow).toBe(872000);
    expect(getPricingForModel("codex", "gpt-6-sol(high)[1m]-review")).toMatchObject({ input: 2, output: 10, cached: 0.2 });
    expect(getPricingForModel("codex", "gpt-6.1-sol")).toMatchObject({ input: 2, output: 10, cached: 0.1 });
  });
  it("resolves complete model capabilities for every provider family", () => {
    for (const provider of ["openai", "claude", "kiro", "codex", "antigravity", "devin"]) {
      const capabilities = getCapabilitiesForModel(provider, "gpt-4o");
      expect(capabilities).toMatchObject({ tools: expect.any(Boolean), contextWindow: expect.any(Number) });
      expect(capabilities.contextWindow).toBeGreaterThan(0);
    }
  });

  it("keeps canonical prices provider-agnostic while applying Codex Astra overrides", () => {
    expect(getPricingForModel("openai", "gpt-6-astra")).toMatchObject({ input: 5, output: 30, cached: 0.5 });
    expect(getPricingForModel("codex", "gpt-6-astra")).toMatchObject({ input: 10, output: 50, cached: 1 });
  });


  it("routes bare Codex catalog ids without overriding explicit provider routes", async () => {
    expect((await getModelInfoCore("gpt-6.1-sol", {})).provider).toBe("codex");
    expect((await getModelInfoCore("openai/gpt-6.1-sol", {})).provider).toBe("openai");
    expect(codex.models.find(({ id }) => id === "gpt-6-sol").responsesLite).toBe(true);
    expect(codex.models.find(({ id }) => id === "gpt-5.4")).toBeUndefined();
    expect(codex.models.find(({ id }) => id === "gpt-5.3-codex-spark")).toBeUndefined();
    expect((await getModelInfoCore("gpt-6-sol", {})).provider).toBe("codex");
  });
});
