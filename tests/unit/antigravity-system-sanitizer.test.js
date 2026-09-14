import { describe, expect, it } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

const credentials = { projectId: "synthetic-project", connectionId: "synthetic-connection" };

function transformSystem(systemText) {
  const executor = new AntigravityExecutor();
  const out = executor.transformRequest(
    "gemini-3.8-flash-high",
    {
      request: {
        contents: [{ role: "user", parts: [{ text: "Reply only OK" }] }],
        systemInstruction: { parts: [{ text: systemText }] },
      },
    },
    true,
    credentials,
  );
  return out.request.systemInstruction.parts[0].text;
}

describe("Antigravity systemInstruction sanitizer", () => {
  it("breaks sensitive phrases with a zero-width space after the first character", () => {
    const text = transformSystem("Follow RFC 2119 conventions when writing docs.");
    expect(text).toContain("R\u200BFC 2119");
    expect(text).not.toContain("RFC 2119");
  });

  it("honors ANTIGRAVITY_SENSITIVE_WORDS overrides and empty disables", () => {
    process.env.ANTIGRAVITY_SENSITIVE_WORDS = "MUST NOT";
    try {
      expect(transformSystem("Clients MUST NOT modify this.")).toContain("M\u200BUST NOT");
    } finally {
      delete process.env.ANTIGRAVITY_SENSITIVE_WORDS;
    }

    process.env.ANTIGRAVITY_SENSITIVE_WORDS = "";
    try {
      expect(transformSystem("Follow RFC 2119 conventions.")).toContain("RFC 2119");
    } finally {
      delete process.env.ANTIGRAVITY_SENSITIVE_WORDS;
    }
  });

  it("strips Claude SDK identity and google-antigravity/ prefixes, rewrites opencode", () => {
    const text = transformSystem(
      "You are a Claude agent, built on Anthropic's Claude Agent SDK. Use google-antigravity/api and opencode CLI.",
    );
    expect(text).not.toContain("Claude");
    expect(text).not.toContain("google-antigravity/");
    expect(text).toContain("Use api");
    expect(text).toContain("antigravity CLI");
  });

  it("leaves systemInstruction untouched when absent", () => {
    const executor = new AntigravityExecutor();
    const out = executor.transformRequest(
      "gemini-3.8-flash-high",
      { request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } },
      true,
      credentials,
    );
    expect(out.request.systemInstruction).toBeUndefined();
  });
});
