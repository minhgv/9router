import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { ROLE, OPENAI_BLOCK, OPENAI_FINISH, DEFAULT_IMAGE_MIME } from "../schema/index.js";
import { buildChunk } from "../concerns/chunk.js";
import { toOpenAIUsage } from "../concerns/usage.js";
import { reasoningDelta } from "../concerns/reasoning.js";
import { encodeDataUri } from "../concerns/image.js";
import { toOpenAIFinish } from "../concerns/finishReason.js";
import { storeGeminiThoughtSignature } from "../../services/thoughtSignatureStore.js";
import { stripReasonPlaceholders } from "../../utils/reasonPlaceholder.js";

// Build chunk meta for current gemini state
function chunkMeta(state) {
  return { id: `chatcmpl-${state.messageId}`, created: Math.floor(Date.now() / 1000), model: state.model };
}

// Build a tool_call chunk from a gemini functionCall part (shared by sig/non-sig branches)
function emitFunctionCall(functionCall, state, signature = null) {
  const rawName = functionCall.name;
  // Restore original tool name from mapping (AG cloaking)
  const fcName = state.toolNameMap?.get(rawName) || rawName;
  // Strip the synthetic `reason` schema placeholder back out of the emitted
  // args — it only exists on the wire to satisfy Antigravity VALIDATED mode
  // (recorded per tool at translateRequest time); the client's own validator
  // would reject it as an unexpected parameter.
  const phMap = state?.reasonPlaceholderMap;
  const rawArgs = functionCall.args || {};
  const fcArgs = phMap?.has(rawName)
    ? stripReasonPlaceholders(rawName, rawArgs, phMap)
    : stripReasonPlaceholders(fcName, rawArgs, phMap);
  const toolCallIndex = state.functionIndex++;
  const callId = functionCall.id || `${fcName}-${Date.now()}-${toolCallIndex}`;
  if (signature) {
    storeGeminiThoughtSignature(callId, signature, state.sessionId, state.model);
  }
  const toolCall = {
    id: callId,
    index: toolCallIndex,
    type: OPENAI_BLOCK.FUNCTION,
    function: { name: fcName, arguments: JSON.stringify(fcArgs) },
  };
  // Keep Gemini bookkeeping separate from the shared translator state.toolCalls map.
  // The downstream OpenAI→Claude translator uses state.toolCalls for Claude block
  // metadata; pre-populating it here makes Anthropic tool deltas lose index.
  state.geminiToolCallCount = (state.geminiToolCallCount || 0) + 1;
  return buildChunk(chunkMeta(state), { tool_calls: [toolCall] }, null);
}

// Parse unquoted/ctrl46-stripped Gemini default_api value
function parseGeminiLeakedValue(raw) {
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("{") && v.endsWith("}")) || (v.startsWith("[") && v.endsWith("]"))) {
    try { return JSON.parse(v); } catch {}
    if (v.startsWith("{") && v.endsWith("}")) return parseGeminiLeakedArgs(v.slice(1, -1));
    if (v.startsWith("[") && v.endsWith("]")) {
      const inner = v.slice(1, -1).trim();
      if (!inner) return [];
      const items = [];
      let start = 0, depth = 0, inStr = false;
      for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (ch === '"' && inner[i - 1] !== "\\") inStr = !inStr;
        else if (!inStr) {
          if (ch === "{" || ch === "[") depth++;
          else if (ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
          else if (ch === "," && depth === 0) {
            items.push(parseGeminiLeakedValue(inner.slice(start, i)));
            start = i + 1;
          }
        }
      }
      items.push(parseGeminiLeakedValue(inner.slice(start)));
      return items;
    }
  }
  return v;
}

// Parse Gemini leaked default_api:{key:val,...} body into an args object
export function parseGeminiLeakedArgs(body) {
  const trimmed = body.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(`{${trimmed}}`);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}

  const keys = [];
  const firstMatch = trimmed.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
  if (!firstMatch) return {};
  keys.push({ key: firstMatch[1], keyStart: 0, valStart: firstMatch[0].length });

  let depth = 0, inStr = false;
  for (let i = firstMatch[0].length; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '"' && trimmed[i - 1] !== "\\") inStr = !inStr;
    else if (!inStr) {
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
      else if (ch === "," && depth === 0) {
        const nextMatch = trimmed.slice(i + 1).match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
        if (nextMatch) {
          keys.push({ key: nextMatch[1], keyStart: i, valStart: i + 1 + nextMatch[0].length });
          i += nextMatch[0].length;
        }
      }
    }
  }

  const out = {};
  for (let idx = 0; idx < keys.length; idx++) {
    const cur = keys[idx];
    const end = idx + 1 < keys.length ? keys[idx + 1].keyStart : trimmed.length;
    out[cur.key] = parseGeminiLeakedValue(trimmed.slice(cur.valStart, end));
  }
  return out;
}

// Extract leaked Gemini tool calls (e.g. `하려コール{default_api:grep{...}}` or `call:default_api:grep{...}`)
// ponytail: single-pass brace scanner; upgrade to full grammar parser only if Gemini changes internal default_api syntax.
export function extractLeakedGeminiToolCalls(text, isFinal = true) {
  if (!text || typeof text !== "string") return { cleanedText: text || "", toolCalls: [], pending: false };

  // Buffer when the tail may still be mid-marker: fused junk prefix, a `<tool_call>`
  // opener, or a partial `default_api:` tail. A false positive only delays one chunk;
  // the combined text flushes as content when no call materializes. `}` is excluded
  // from the trailing class so complete calls still extract immediately.
  if (!isFinal && /(?:하려(?:コール)?|コール|<tool_call>|call(?::(?:default_api)?)?|default_api(?::[a-zA-Z0-9_.:-]*)?)[\s{:]*$/.test(text)) {
    return { cleanedText: "", toolCalls: [], pending: true };
  }


  const startRe = /(?:<tool_call>\s*)?(?:[^\s{<]{1,12})?(\{)?(?:call:)?default_api:([a-zA-Z0-9_.:-]+)\{/g;

  let match = startRe.exec(text);
  if (!match) {
    return { cleanedText: text, toolCalls: [], pending: false };
  }

  const toolCalls = [];
  let cleanedText = "";
  let lastIndex = 0;

  while (match) {
    const matchStart = match.index;
    const outerBrace = match[1] === "{";
    const toolName = match[2];
    const openBraceIdx = matchStart + match[0].length - 1;

    let depth = 0, inStr = false, closeIdx = -1;
    for (let i = openBraceIdx; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"' && text[i - 1] !== "\\") inStr = !inStr;
      else if (!inStr) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            closeIdx = i;
            break;
          }
        }
      }
    }

    if (closeIdx === -1 && isFinal) {
      const trimmedEnd = text.trimEnd();
      if (outerBrace && trimmedEnd.endsWith("}}")) closeIdx = trimmedEnd.length - 2;
      else if (!outerBrace && trimmedEnd.endsWith("}")) closeIdx = trimmedEnd.length - 1;
    }

    if (closeIdx === -1) {
      if (!isFinal) return { cleanedText: "", toolCalls: [], pending: true };
      break;
    }

    cleanedText += text.slice(lastIndex, matchStart);
    const argsBody = text.slice(openBraceIdx + 1, closeIdx);
    let endIdx = closeIdx + 1;
    if (outerBrace && text[endIdx] === "}") endIdx++;
    const closeTagMatch = text.slice(endIdx).match(/^\s*<\/tool_call>/);
    if (closeTagMatch) endIdx += closeTagMatch[0].length;

    toolCalls.push({
      name: toolName,
      args: parseGeminiLeakedArgs(argsBody),
    });

    lastIndex = endIdx;
    startRe.lastIndex = lastIndex;
    match = startRe.exec(text);
  }

  cleanedText += text.slice(lastIndex);
  return { cleanedText, toolCalls, pending: false };
}

function processAssistantTextPart(text, isThought, sig, isFinal, state, results) {
  if (isThought) {
    results.push(buildChunk(chunkMeta(state), reasoningDelta(text), null));
    return;
  }
  const combined = (state.pendingLeakedToolText || "") + text;
  const { cleanedText, toolCalls, pending } = extractLeakedGeminiToolCalls(combined, isFinal);
  if (pending) {
    state.pendingLeakedToolText = combined;
    return;
  }
  state.pendingLeakedToolText = "";
  if (cleanedText) {
    results.push(buildChunk(chunkMeta(state), { content: cleanedText }, null));
  }
  for (const tc of toolCalls) {
    results.push(emitFunctionCall(tc, state, sig));
    state.pendingThoughtSignature = null;
  }
}

// Convert Gemini response chunk to OpenAI format
export function geminiToOpenAIResponse(chunk, state) {
  // Handle Antigravity wrapper
  if (!chunk) {
    if (state?.pendingLeakedToolText) {
      const pendingText = state.pendingLeakedToolText;
      state.pendingLeakedToolText = "";
      const results = [];
      processAssistantTextPart(pendingText, false, state.pendingThoughtSignature || null, true, state, results);
      if (state.messageId && !state.finishReason) {
        const finishReason = state.geminiToolCallCount > 0 ? OPENAI_FINISH.TOOL_CALLS : OPENAI_FINISH.STOP;
        const finalChunk = buildChunk(chunkMeta(state), {}, finishReason);
        if (state.usage) finalChunk.usage = state.usage;
        results.push(finalChunk);
        state.finishReason = finishReason;
      }
      return results.length > 0 ? results : null;
    }
    return null;
  }

  const response = chunk.response || chunk;
  if (!response || !response.candidates?.[0]) return null;


  const results = [];
  const candidate = response.candidates[0];
  const content = candidate.content;

  // Initialize state
  if (!state.messageId) {
    state.messageId = response.responseId || `msg_${Date.now()}`;
    state.model = response.modelVersion || state.model || "gemini";
    state.functionIndex = 0;
    state.geminiToolCallCount = 0;
    results.push(buildChunk(chunkMeta(state), { role: ROLE.ASSISTANT }, null));
  }

  // Process parts
  if (content?.parts) {
    for (const part of content.parts) {
      const hasThoughtSig = part.thoughtSignature || part.thought_signature;
      if (hasThoughtSig && typeof hasThoughtSig === "string") {
        state.pendingThoughtSignature = hasThoughtSig;
      }
      const isThought = part.thought === true;

      // Handle thought signature (thinking mode)
      if (hasThoughtSig) {
        const hasTextContent = part.text !== undefined && part.text !== "";
        const hasFunctionCall = !!part.functionCall;

        // Standalone thoughtSignature part (no text, no functionCall): keep pending for next functionCall
        if (!hasTextContent && !hasFunctionCall) {
          continue;
        }

        if (hasTextContent) {
          processAssistantTextPart(part.text, isThought, hasThoughtSig, Boolean(candidate.finishReason), state, results);
        }

        if (hasFunctionCall) {
          results.push(emitFunctionCall(part.functionCall, state, hasThoughtSig));
          state.pendingThoughtSignature = null;
        }
        continue;
      }

      // Text content. Gemini marks model-internal thinking with `thought: true`.
      // Some responses include a thoughtSignature, but Google AI Studio/Gemini API
      // can also stream thought parts without a signature; those must not be
      // surfaced as normal assistant content in OpenAI-compatible clients.
      if (part.text !== undefined && part.text !== "") {
        processAssistantTextPart(part.text, isThought, state.pendingThoughtSignature || null, Boolean(candidate.finishReason), state, results);
      }

      // Function call
      if (part.functionCall) {
        const sig = state.pendingThoughtSignature || null;
        results.push(emitFunctionCall(part.functionCall, state, sig));
        state.pendingThoughtSignature = null;
      }

      // Inline data (images)
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData?.data) {
        const mimeType = inlineData.mimeType || inlineData.mime_type || DEFAULT_IMAGE_MIME;
        results.push(buildChunk(
          chunkMeta(state),
          {
            images: [{
              type: OPENAI_BLOCK.IMAGE_URL,
              image_url: { url: encodeDataUri(mimeType, inlineData.data) }
            }]
          },
          null
        ));
      }
    }
  }

  // Usage metadata - extract before finish reason so we can include it
  const usageMeta = response.usageMetadata || chunk.usageMetadata;
  const geminiUsage = toOpenAIUsage(usageMeta, "gemini");
  if (geminiUsage) state.usage = geminiUsage;

  // Finish reason - include usage in final chunk
  if (candidate.finishReason) {
    if (state.pendingLeakedToolText) {
      const pendingText = state.pendingLeakedToolText;
      state.pendingLeakedToolText = "";
      processAssistantTextPart(pendingText, false, state.pendingThoughtSignature || null, true, state, results);
    }
    const upstreamReason = String(candidate.finishReason).toUpperCase();
    let finishReason = toOpenAIFinish(candidate.finishReason, "gemini");
    if ((finishReason === OPENAI_FINISH.STOP || upstreamReason === "MALFORMED_FUNCTION_CALL") && state.geminiToolCallCount > 0) {
      finishReason = OPENAI_FINISH.TOOL_CALLS;
    }
    
    
    const finalChunk = buildChunk(chunkMeta(state), {}, finishReason);
    
    // Include usage in final chunk for downstream translators
    if (state.usage) {
      finalChunk.usage = state.usage;
    }
    
    results.push(finalChunk);
    state.finishReason = finishReason;
  }

  return results.length > 0 ? results : null;
}

// Register
register(FORMATS.GEMINI, FORMATS.OPENAI, null, geminiToOpenAIResponse);
register(FORMATS.GEMINI_CLI, FORMATS.OPENAI, null, geminiToOpenAIResponse);
register(FORMATS.ANTIGRAVITY, FORMATS.OPENAI, null, geminiToOpenAIResponse);
register(FORMATS.VERTEX, FORMATS.OPENAI, null, geminiToOpenAIResponse);

