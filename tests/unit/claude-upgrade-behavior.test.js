import { describe, expect, it, vi } from "vitest";
import { hasValidContent, prepareClaudeRequest, ensureTrailingUserTurn } from "../../open-sse/translator/formats/claude.js";
import { CLAUDE_BLOCK } from "../../open-sse/translator/schema/blocks.js";
import { CLAUDE_TOOL_SUFFIX } from "../../open-sse/config/appConstants.js";
import { decloakStreamChunk, decloakToolNames } from "../../open-sse/utils/claudeCloaking.js";
import { parseClaudeResetGrants } from "../../open-sse/services/usage/claude.js";
import { upstreamResponseHeaders } from "../../open-sse/utils/upstreamHeaders.js";
import claudeProvider from "../../open-sse/providers/registry/claude.js";

describe("Claude registry", () => {
  it("advertises the Sonnet 5.5 OAuth model", () => {
    expect(claudeProvider.models).toContainEqual({ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" });
  });
});
describe("Claude request preservation", () => {
  it("retains a user turn containing only a container_upload block", () => {
    expect(hasValidContent({ role: "user", content: [{ type: CLAUDE_BLOCK.CONTAINER_UPLOAD, file_id: "file_1" }] })).toBe(true);
  });

  it("uses the remaining fourth cache breakpoint on final tool results", () => {
    const body = {
      model: "claude-sonnet-5-5",
      max_tokens: 1000,
      system: [{ type: "text", text: "system" }],
      tools: [{ name: "run", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "assistant", content: [{ type: "text", text: "calling tool" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
      ],
    };
    prepareClaudeRequest(body, "claude", null);
    const marked = [
      ...body.system,
      ...body.tools,
      ...body.messages.flatMap((message) => message.content || []),
    ].filter((block) => block.cache_control);
    expect(marked).toHaveLength(4);
    expect(body.messages.at(-1).content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("adds a user turn only when cleanup would expose a generated assistant tail", () => {
    expect(ensureTrailingUserTurn([{ role: "assistant", content: "answer" }], "user").at(-1).role).toBe("user");
    const prefill = [{ role: "assistant", content: "partial" }];
    expect(ensureTrailingUserTurn(prefill, "assistant")).toBe(prefill);
  });
});
describe("Claude Sonnet 5 request capabilities", () => {
  it("uses the supported thinking-off marker and downgrades forced tool choices", () => {
    const body = {
      model: "claude-sonnet-5-5",
      max_tokens: 2048,
      thinking: { type: "disabled" },
      tool_choice: { type: "tool", name: "lookup", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: "hello" }],
    };
    prepareClaudeRequest(body, "claude", "synthetic-api-key");
    expect(body.thinking).toEqual({ type: "between_tools" });
    expect(body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });
});


describe("Claude tool-name restoration", () => {
  it("restores suffixed tool names when the per-request map is absent or stale", () => {
    const suffix = CLAUDE_TOOL_SUFFIX;
    expect(decloakToolNames({ content: [{ type: "tool_use", name: `run${suffix}` }] }, null).content[0].name).toBe("run");
    expect(decloakToolNames({ content: [{ type: "tool_use", name: `run${suffix}` }] }, new Map([[`other${suffix}`, "other"]])).content[0].name).toBe("run");
    expect(decloakStreamChunk({ type: "content_block_start", content_block: { type: "tool_use", name: `run${suffix}` } }, null).content_block.name).toBe("run");
  });
  it("does not rewrite a tool name without the exact cloak suffix", () => {
    const response = { content: [{ type: "tool_use", name: "run" }] };
    expect(decloakToolNames(response, null).content[0].name).toBe("run");
  });
});

describe("Claude reset grant parsing", () => {
  it("counts only active positive grants while retaining grant details for display", () => {
    const parsed = parseClaudeResetGrants({
      eligible: true,
      next_grant_id: "active-1",
      grants: [
        { id: "active-1", resets_left: 2, resets_total: 3, usable_now: true, clears: ["session", "weekly"] },
        { id: "paused", resets_left: 4, paused: true },
        { id: "empty", resets_left: 0 },
      ],
    });
    expect(parsed.availableCount).toBe(2);
    expect(parsed.nextGrantId).toBe("active-1");
    expect(parsed.grants).toHaveLength(3);
    expect(parsed.grants[0].clears).toEqual(["session", "weekly"]);
    expect(parseClaudeResetGrants({ eligible: false, grants: [] })).toBeNull();
  });
});

describe("Claude client request headers", () => {
  it("merges requested beta flags, filters OAuth 1M beta, and forwards only explicit OAuth session ids", async () => {
    vi.resetModules();
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const executor = new DefaultExecutor("claude");
    const oauth = executor.buildHeaders({
      authType: "oauth",
      accessToken: "token",
      rawHeaders: {
        "anthropic-beta": "context-1m-2025-08-07,client-flag,client-flag",
        "x-claude-code-session-id": "session-123",
      },
    }, false, undefined, "claude-sonnet-5-5");
    const betas = oauth["Anthropic-Beta"].split(",");
    expect(betas).toContain("client-flag");
    expect(betas).not.toContain("context-1m-2025-08-07");
    expect(oauth["x-claude-code-session-id"]).toBe("session-123");

    const apiKey = executor.buildHeaders({
      authType: "apikey",
      apiKey: "api-key",
      rawHeaders: { "anthropic-beta": "context-1m-2025-08-07", "x-claude-code-session-id": "session-123" },
    }, false, undefined, "claude-sonnet-5-5");
    expect(apiKey["x-claude-code-session-id"]).toBeUndefined();
    expect(apiKey["Anthropic-Beta"]).toContain("context-1m-2025-08-07");
  });

  it("drops invalid client session IDs instead of manufacturing or forwarding identity", async () => {
    vi.resetModules();
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({
      authType: "oauth",
      accessToken: "token",
      rawHeaders: { "x-claude-code-session-id": "invalid session" },
    }, false, undefined, "claude-sonnet-5-5");
    expect(headers["x-claude-code-session-id"]).toBeUndefined();
  });
});

describe("Claude upstream response header filtering", () => {
  it("forwards only retry and Anthropic rate-limit headers", () => {
    const forwarded = upstreamResponseHeaders(new Headers({
      "retry-after": "2",
      "x-should-retry": "true",
      "anthropic-ratelimit-requests-limit": "10",
      "set-cookie": "secret=1",
      "x-private": "do-not-forward",
    }));
    expect(forwarded).toEqual({
      "retry-after": "2",
      "x-should-retry": "true",
      "anthropic-ratelimit-requests-limit": "10",
    });
  });
});
