import { describe, expect, it } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

const credentials = {
  projectId: "synthetic-project",
  connectionId: "synthetic-connection",
  email: "tester@example.com",
};

function transform(model, request = {}) {
  const executor = new AntigravityExecutor();
  return executor.transformRequest(
    model,
    { request: { contents: [{ role: "user", parts: [{ text: "Reply only OK" }] }], ...request } },
    true,
    credentials,
  );
}

describe("Antigravity request.labels parity", () => {
  it("labels live in request.labels, never on the envelope root", () => {
    const output = transform("gemini-3-flash-agent");
    expect(output.labels).toBeUndefined();
    expect(typeof output.request.labels.trajectory_id).toBe("string");
  });

  it("trajectory_id matches the requestId pieces and last_step_index is step-1", () => {
    const output = transform("gemini-3.8-flash-high");
    const pieces = output.requestId.split("/");
    expect(output.request.labels.trajectory_id).toBe(pieces[3]);
    expect(output.request.labels.last_step_index).toBe(String(Number(pieces[4]) - 1));
  });

  it("pinned agent ids carry their model_enum", () => {
    expect(transform("gemini-3-flash-agent").request.labels.model_enum).toBe("MODEL_PLACEHOLDER_M132");
    expect(transform("gemini-pro-agent").request.labels.model_enum).toBe("MODEL_PLACEHOLDER_M16");
    expect(transform("gemini-3.1-pro-low").request.labels.model_enum).toBe("MODEL_PLACEHOLDER_M36");
    expect(transform("gemini-3.5-flash-low").request.labels.model_enum).toBe("MODEL_PLACEHOLDER_M20");
    expect(transform("gemini-3.5-flash-extra-low").request.labels.model_enum).toBe("MODEL_PLACEHOLDER_M187");
  });

  it("unprofiled gemini ids and claude ids omit model_enum; claude sets used_claude flags", () => {
    expect(transform("gemini-3.8-flash-high").request.labels.model_enum).toBeUndefined();
    const claude = transform("claude-sonnet-4-6");
    expect(claude.request.labels.model_enum).toBeUndefined();
    expect(claude.request.labels.used_claude).toBe("1");
    expect(claude.request.labels.used_claude_conservative).toBe("1");
  });

  it("maxOutputTokens is capped per wire profile", () => {
    const gemini = transform("gemini-3-flash-agent", { generationConfig: { maxOutputTokens: 200000 } });
    expect(gemini.request.generationConfig.maxOutputTokens).toBe(65536);
    const claude = transform("claude-sonnet-4-6", { generationConfig: { maxOutputTokens: 200000 } });
    expect(claude.request.generationConfig.maxOutputTokens).toBe(64000);
  });
});
