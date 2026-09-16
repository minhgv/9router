import { CLAUDE_TOOL_SUFFIX } from "../config/appConstants.js";

/**
 * Map client tool names with CLAUDE_TOOL_SUFFIX ("_ide") when forwarding to Claude OAuth:
 * - Rename client tools with CLAUDE_TOOL_SUFFIX in tools[] and messages[]
 * - Skip tools that carry a `type` (server-side built-ins) — sent as-is
 * Returns { body, toolNameMap } where toolNameMap maps suffixed → original
 * @param {object} body - Claude API request body
 * @returns {{ body: object, toolNameMap: Map|null }}
 */
export function cloakClaudeTools(body) {
  const tools = body.tools;
  if (!tools || tools.length === 0) return { body, toolNameMap: null };

  const suffix = (name) => `${name}${CLAUDE_TOOL_SUFFIX}`;
  const toolNameMap = new Map();
  const clientToolNames = new Set();
  const clientDeclarations = [];

  // All client tools get renamed with suffix.
  // Built-in server tools (web_search_20250305, etc.) carry a `type` and require
  // an exact reserved `name` — never suffix those or Claude rejects the request.
  for (const tool of tools) {
    if (tool.type) { clientDeclarations.push(tool); continue; }
    const suffixed = suffix(tool.name);
    toolNameMap.set(suffixed, tool.name);
    clientToolNames.add(tool.name);
    clientDeclarations.push({ ...tool, name: suffixed });
  }

  // Rename tool_use in message history (only client tools we renamed)
  const renamedMessages = body.messages?.map(msg => {
    if (!Array.isArray(msg.content)) return msg;
    const renamedContent = msg.content.map(block =>
      block.type === "tool_use" && clientToolNames.has(block.name)
        ? { ...block, name: suffix(block.name) }
        : block
    );
    return { ...msg, content: renamedContent };
  });

  const cloakedBody = { ...body, tools: clientDeclarations, messages: renamedMessages || body.messages };

  // A forced tool_choice ({ type: "tool", name }) must point at the suffixed
  // tool name, otherwise Claude rejects it: "Tool '<name>' not found in provided tools".
  // Only rewrite when the choice targets one of the client tools we actually renamed.
  if (
    body.tool_choice?.type === "tool" &&
    clientToolNames.has(body.tool_choice.name)
  ) {
    cloakedBody.tool_choice = { ...body.tool_choice, name: suffix(body.tool_choice.name) };
  }

  return {
    body: cloakedBody,
    toolNameMap: toolNameMap.size > 0 ? toolNameMap : null
  };
}

// Decloak tool_use names in non-streaming Claude response body (INPUT side)
export function decloakToolNames(body, toolNameMap) {
  if (!toolNameMap?.size || !Array.isArray(body?.content)) return body;
  const content = body.content.map(block => {
    if (block?.type === "tool_use" && toolNameMap.has(block.name)) {
      return { ...block, name: toolNameMap.get(block.name) };
    }
    return block;
  });
  return { ...body, content };
}

/**
 * Decloak the tool name inside a single streamed Claude SSE event.
 *
 * Streaming counterpart of decloakToolNames(). Required for claude→claude
 * proxying: translateResponse() returns same-format chunks untouched, so
 * without this the client receives the cloaked ("_ide"-suffixed) tool name
 * and rejects the call as an unknown tool. In a Claude SSE stream a tool
 * name appears exactly once per call — on the content_block_start event of
 * a tool_use block; argument deltas carry no name.
 *
 * Unknown names pass through unchanged, matching the non-streaming decloak behavior.
 *
 * @param {object|null} chunk - Parsed SSE event (may be null on stream flush)
 * @param {Map|null} toolNameMap - Suffixed → original name map from cloakClaudeTools()
 * @returns {object|null} The chunk, with the tool_use name restored when cloaked
 */
export function decloakStreamChunk(chunk, toolNameMap) {
  if (!toolNameMap?.size || !chunk || typeof chunk !== "object") return chunk;
  if (chunk.type !== "content_block_start") return chunk;
  const block = chunk.content_block;
  if (block?.type !== "tool_use" || typeof block.name !== "string") return chunk;
  const original = toolNameMap.get(block.name);
  if (!original) return chunk;
  return { ...chunk, content_block: { ...block, name: original } };
}
