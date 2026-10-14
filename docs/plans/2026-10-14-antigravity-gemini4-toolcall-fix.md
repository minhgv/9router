# Fix Antigravity Gemini 4 Argon Tool Call & Thought Signature Pipeline (Phase 2)

Work ID: `2026-10-14-antigravity-gemini4-toolcall-fix` · Status: **complete** · Branch: `master`


## Context

When `ag/gemini-4-argon*` is invoked through `9router` (`open-sse`) from OpenAI-compatible clients such as `oh-my-pi`, tool calls fail intermittently or degrade across multi-turn conversations.

**Known upstream trigger**: Google (`daily-cloudcode-pa`) occasionally drops the internal `<|tool_call|>call:` control token (frequent on `gemini-4-argon` when auto-thinking yields `reasoningTokens: 0`). The SentencePiece tokenizer then leaks the literal text `하려コール` (or `call:`) followed by `default_api:<tool>{<unquoted-args>}` into `part.text` with `finishReason: "STOP"`.

**Phase 1 (completed)**: `extractLeakedGeminiToolCalls` and `parseGeminiLeakedArgs` were added to `open-sse/translator/response/gemini-to-openai.js` and `open-sse/handlers/chatCore/nonStreamingHandler.js` to detect, strip, and convert these text leaks into valid OpenAI `tool_calls` chunks, preventing direct output pollution on the current turn.

**Phase 2 (this plan) — Residual root causes in 9router's request/response pipeline**:

1. **Corrupted `thoughtSignature` & dropped `credentials` on Antigravity requests**:
   - `openaiToAntigravityRequest` (`open-sse/translator/request/openai-to-gemini.js`) delegates to `openaiToGeminiCLIRequest(model, body, stream)` without forwarding `credentials`, leaving `sessionId` undefined during signature lookup and injecting `DEFAULT_THINKING_GEMINI_CLI_SIGNATURE` instead of `DEFAULT_THINKING_AG_SIGNATURE`.
   - `AntigravityExecutor.transformRequest` (`open-sse/executors/antigravity.js`) evaluates `p.thoughtSignature || cachedSig || DEFAULT_THINKING_AG_SIGNATURE`, which allows the pre-populated fallback `DEFAULT_THINKING_GEMINI_CLI_SIGNATURE` to override the real `cachedSig` (looked up with the resolved numeric `sessionId`) as well as `DEFAULT_THINKING_AG_SIGNATURE`. Because healed tool calls lack a `thoughtSignature` in the prior turn (due to `reasoningTokens: 0`), this wrong-signature fallback applies on the very next turn.
2. **Dropped `max_completion_tokens`, multi-system / `developer` role loss, and triple schema cleaning**:
   - `openaiToGeminiBase` only reads `body.max_tokens` and ignores `body.max_completion_tokens`.
   - Multiple `system` or `developer` messages overwrite `result.systemInstruction` instead of accumulating parts, or get dropped when `role === "developer"`.
   - `openaiToGeminiCLIRequest` re-runs `cleanJSONSchemaForAntigravity` redundantly after `openaiToGeminiBase`.
3. **Poisoned history sanitization (re-opened sessions)**:
   - Sessions that were polluted before Phase 1 (assistant messages containing raw `하려コール{default_api:...}` text, or sessions imported from other clients) replay the leak back to Gemini on the next turn, causing the model to imitate the token slip. `openaiToGeminiBase` does not clean these messages.
4. **Antigravity `thinkingConfig` & `maxOutputTokens` ceiling for Gemini 4 Argon**:
   - `resolveAntigravityThinkingLevel` in `open-sse/executors/antigravity.js` returns `null` for un-suffixed `gemini-4-argon` and does not normalize or clamp lowercase `"minimal"` thinking levels from `thinkingUnified.js` (which cause 400 errors on Gemini >= 3.7 / 4.0).
   - `ANTIGRAVITY_WIRE_PROFILES` lacks entries for `gemini-4-argon*` (`maxOutputTokens: 65536`), clamping output tokens to `64000`.
5. **Leaked `default_api:` tool-call edge cases and stream flush**:
   - `geminiToOpenAIResponse` returns `null` immediately when `chunk === null` (end-of-stream flush), dropping any buffered `state.pendingLeakedToolText` if the stream closes without a `finishReason` chunk.
   - `extractLeakedGeminiToolCalls` only strips the `하려コール` / `コール` prefix at the start of a line. If the prefix follows prose on the same line, it is left in `cleanedText`.
   - `GEMINI_FINISH` (`open-sse/translator/schema/finishReasons.js`) omits `MALFORMED_FUNCTION_CALL`, leaving any uncaught leaked calls without a proper `finish_reason: "tool_calls"` recovery.

### Non-goals
- Changing upstream model catalog IDs or pricing tables.
- Modifying Claude or Devin request translators.
- Solving Google's upstream control-token slip (impossible client-side).

## Approach

1. **Request translation (`open-sse/translator/request/openai-to-gemini.js`)**:
   - Forward `credentials` and use `DEFAULT_THINKING_AG_SIGNATURE` for Antigravity Gemini requests.
   - Support `body.max_completion_tokens ?? body.max_tokens` when populating `generationConfig.maxOutputTokens`.
   - Accumulate multiple `system` messages into `result.systemInstruction.parts` and treat `developer` role messages as `system` (when leading) or `user` content parts instead of dropping them.
   - Remove redundant second pass of `cleanJSONSchemaForAntigravity` in `openaiToGeminiCLIRequest`.
   - Sanitize prior `assistant` text content that contains leaked `default_api:` calls before replaying to Gemini, preventing model imitation in resumed/poisoned sessions.
2. **Antigravity executor (`open-sse/executors/antigravity.js`)**:
   - Fix `thoughtSignature` precedence on `functionCall` parts: prioritize `cachedSig` (resolved with Antigravity's `sessionId`) over pre-populated default signatures (`DEFAULT_THINKING_GEMINI_CLI_SIGNATURE` / `DEFAULT_THINKING_AG_SIGNATURE`), apply `DEFAULT_THINKING_AG_SIGNATURE` only on the first unsigned call, and strip default fallback signatures from secondary parallel calls.
   - Normalize `thinkingConfig.thinkingLevel`: map bare `gemini-4-argon` to `"MEDIUM"`, clamp `"MINIMAL"` to `"LOW"` on Gemini >= 3.7 / 4.0, and uppercase any level set by `thinkingUnified.js`.
   - Add `gemini-4-argon*` and `gemini-3.8-flash*` `maxOutputTokens: 65536` entries to `ANTIGRAVITY_WIRE_PROFILES`.
3. **Response translation & finish reason (`open-sse/translator/response/gemini-to-openai.js`, `open-sse/translator/schema/finishReasons.js`, `open-sse/translator/concerns/finishReason.js`)**:
   - Flush `state.pendingLeakedToolText` when `geminiToOpenAIResponse(null, state)` is invoked at end-of-stream.
   - Allow `extractLeakedGeminiToolCalls` to strip `하려コール` / `コール` prefixes even when preceded by prose on the same line.
   - Add `MALFORMED_FUNCTION_CALL` to `GEMINI_FINISH` and ensure healed tool calls on `MALFORMED_FUNCTION_CALL` emit `finish_reason: "tool_calls"`.

## Critical files and ownership

| File | Responsibility |
|---|---|
| `open-sse/translator/request/openai-to-gemini.js` | OpenAI → Gemini/Antigravity request translation, signature default, `max_completion_tokens`, system/developer handling, and poisoned history sanitization |
| `open-sse/executors/antigravity.js` | Antigravity envelope transformation, `thoughtSignature` cache priority, `thinkingLevel` clamping, `ANTIGRAVITY_WIRE_PROFILES` |
| `open-sse/translator/response/gemini-to-openai.js` | Mid-line `하려コール` prefix stripping, end-of-stream `null` chunk flush, and finish_reason mapping |
| `open-sse/translator/schema/finishReasons.js` | `GEMINI_FINISH.MALFORMED_FUNCTION_CALL` enum constant |
| `open-sse/translator/concerns/finishReason.js` | Explicit handling of `GEMINI_FINISH.MALFORMED_FUNCTION_CALL` |
| `tests/unit/gemini-leaked-tool-call.test.js` | Behavioral unit tests for request/executor/response tool-call contracts |

## Verification

- **AC-01**: `openaiToAntigravityRequest` uses `DEFAULT_THINKING_AG_SIGNATURE` (never `DEFAULT_THINKING_GEMINI_CLI_SIGNATURE`), forwards `credentials`, maps `max_completion_tokens` to `generationConfig.maxOutputTokens`, and preserves multiple `system` / `developer` messages.
- **AC-02**: `openaiToGeminiBase` sanitizes prior `assistant` text containing leaked `default_api:` calls before replaying to Gemini.
- **AC-03**: `AntigravityExecutor.transformRequest` prioritizes `cachedSig` from `thoughtSignatureStore` over fallback signatures, uses `DEFAULT_THINKING_AG_SIGNATURE` on the first uncached `functionCall`, leaves secondary parallel `functionCall` parts unsigned when uncached, sets `maxOutputTokens` ceiling to `65536` for `gemini-4-argon*`, resolves bare `gemini-4-argon` thinking level to `"MEDIUM"`, and clamps `"minimal"` thinking level to `"LOW"`.
- **AC-04**: `geminiToOpenAIResponse` heals leaked `default_api:` calls (including mid-line `하려コール` prefixes, `MALFORMED_FUNCTION_CALL` finishReason, and end-of-stream `chunk === null` flush) into structured OpenAI `tool_calls` with `finish_reason: "tool_calls"`.
- **AC-05**: All unit tests in `tests/unit/gemini-leaked-tool-call.test.js` and existing Antigravity/translator test suites pass via `test-runner`, and `reviewer` sign-off is clean.

## Execution checklist

- [x] T-01 (AC-01, AC-02): Patch `open-sse/translator/request/openai-to-gemini.js` for Antigravity signature, `credentials` forwarding, `max_completion_tokens`, multiple `system`/`developer` messages, deduplicated schema cleaning, and poisoned history sanitization.
- [x] T-02 (AC-01, AC-03): Patch `open-sse/executors/antigravity.js` for `thoughtSignature` priority, unsigned sibling calls, `gemini-4-argon*` wire profiles (`65536`), and `thinkingLevel` normalization/clamping.
- [x] T-03 (AC-04): Patch `open-sse/translator/response/gemini-to-openai.js`, `open-sse/translator/schema/finishReasons.js`, and `open-sse/translator/concerns/finishReason.js` for `MALFORMED_FUNCTION_CALL`, mid-line prefix healing, and `chunk === null` flush.
- [x] T-04 (AC-01..05): Expand `tests/unit/gemini-leaked-tool-call.test.js` to cover AC-01..04, run verification via `test-runner`, and run consolidated code review via `reviewer`.



## Evidence and handoff

Phase-1 (pre-existing uncommitted work, verified this session):
- `open-sse/translator/response/gemini-to-openai.js` — `extractLeakedGeminiToolCalls` / `parseGeminiLeakedArgs` heal `하려コール{default_api:...}` / `call:default_api:...` text leaks into `tool_calls`.
- `open-sse/handlers/chatCore/nonStreamingHandler.js` — non-streaming path uses the same extractor.
- `tests/unit/gemini-leaked-tool-call.test.js` — 9 tests including the exact leaked string from the incident.

Phase-2 (this plan):
- `openai-to-gemini.js` — `openaiToAntigravityRequest` now passes `credentials` into `openaiToGeminiCLIRequest` (sessionId reaches the signature cache) and the base uses `DEFAULT_THINKING_AG_SIGNATURE` on the Antigravity path (previously the Gemini-CLI fallback). `max_completion_tokens ?? max_tokens` populates `maxOutputTokens`. Multiple `system`/`developer` messages accumulate in `systemInstruction.parts`; `developer` in a multi-message body is system-like. `sanitizeAssistantContent` strips prior-turn leaked `default_api:` text and re-shapes it into `tool_calls` entries (id `<name>-<ts>-<idx>`) before replay — poisoned histories heal instead of propagating.
- `antigravity.js` — `functionCall` signature precedence is now `cachedSig > explicit non-default sig > DEFAULT_THINKING_AG_SIGNATURE (first call only)`; sibling parallel calls stay unsigned; default-signature parts on later calls are stripped. `resolveAntigravityThinkingLevel` wire-tier wins over client `thinkingConfig` (executor owns it), `MINIMAL` → `LOW` (never emits MINIMAL on Gemini ≥3.7), bare `gemini-4-argon` → `MEDIUM`. `ANTIGRAVITY_WIRE_PROFILES` gained argon + 3.8-flash `maxOutputTokens: 65536`.
- `gemini-to-openai.js` — `chunk === null` flushes `pendingLeakedToolText` and emits a terminal finish chunk (`tool_calls` when calls were recovered); mid-line junk prefixes (`하려コール`, `コール`, prose-fused tokens) stripped via `[^\s{<]{1,12}` run; `MALFORMED_FUNCTION_CALL` + recovered calls → `finish_reason: "tool_calls"`.
- `finishReasons.js` — `GEMINI_FINISH.MALFORMED_FUNCTION_CALL` added; `finishReason.js` maps it to `STOP` (recovery happens via the extractor, not error propagation).
- Test pins: `antigravity-thought-signature-family.test.js` re-pinned the fallback to `DEFAULT_THINKING_AG_SIGNATURE` (the old pin encoded the bug).

Verification: `npx vitest run unit/gemini-leaked-tool-call.test.js unit/antigravity-*.test.js` → **184 passed, 6 skipped** (27 files). `eslint` on all touched files → clean.

Repair pass (reviewer findings, post-hoc):
- `openai-to-gemini.js:167` — `msg.content = sanitized.text` after healing makes account-rotation retries idempotent (shared `body.messages` no longer re-extracts the same calls on `handleChatCore` retry). Healed call id now `<name>-<ts>-<msg>-<idx>` (message index included) to prevent same-millisecond collisions.
- `gemini-to-openai.js:128` — pending gate broadened to drop the `(?:^|\n)` anchor and accept a partial `default_api:` tail (`default_api(?::[a-zA-Z0-9_.:-]*)?[\s{:]*$`), so mid-token SSE splits (`하려コール{default_api:read` + `{i:Reading,path:src}`) heal instead of leaking.
- `nonStreamingHandler.js:211-214` — `MALFORMED_FUNCTION_CALL` finish reason normalized to `stop` (valid OpenAI value), then upgraded to `tool_calls` when healing produced calls. Previously emitted literal `"malformed_function_call"`.
- `antigravity-thought-signature-family.test.js` — re-pinned `DEFAULT_THINKING_GEMINI_CLI_SIGNATURE` → `DEFAULT_THINKING_AG_SIGNATURE` (the old value encoded the bug).
- Regression coverage added: mid-token SSE split, non-streaming `MALFORMED_FUNCTION_CALL` → `tool_calls`, retry idempotency preserved.

## Assumptions and contingencies

- Phase 1 uncommitted work in `open-sse/translator/response/gemini-to-openai.js`, `open-sse/handlers/chatCore/nonStreamingHandler.js`, and `tests/unit/gemini-leaked-tool-call.test.js` is preserved and extended cleanly.
- If a running local `9router` daemon on port `20128` serves from a pre-built bundle or old process, it needs a restart/reload to pick up these changes (the running process at `localhost:20128` predates this patch).
