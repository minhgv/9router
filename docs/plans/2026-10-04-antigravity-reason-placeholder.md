# Fix: Antigravity `reason` placeholder leaks into client tool-call args

Work ID: `2026-10-04-antigravity-reason-placeholder`
Status: in progress

## Context

Report (`sotgraph/report_tool_schema_2026-10-04.md`): ZCode tools whose
parameters are an empty object schema (`{"type":"object","properties":{}}`) or
free-form objects get a synthetic `reason` property injected into the declared
schema. Model calls the tool with `{"reason":"..."}` → host validator
(`InputValidationError: unexpected parameter reason`). Free-form nested objects
(`AskUserQuestion.answers`, `CreateWorkflow.args`) are broken worse: model can't
send arbitrary map keys.

Root cause confirmed in 9router:

- `open-sse/translator/formats/gemini.js` `cleanJSONSchemaForAntigravity` →
  `addPlaceholders` (lines ~431-465) replaces any `{"type":"object"}` with
  empty/absent `properties` (after `additionalProperties` is stripped) with
  `{reason: {type:"string"}, required:["reason"]}`, recursively at all depths.
- `open-sse/executors/antigravity.js:334` same injection when `fn.parameters` is
  missing entirely.
- Response side (`translator/response/gemini-to-openai.js` `emitFunctionCall`,
  `handlers/chatCore/nonStreamingHandler.js` ~line 178) forwards
  `functionCall.args` verbatim → the placeholder `reason` reaches the client.

Non-goal: changing upstream schema shape (Antigravity rejects empty `properties`;
VALIDATED mode). Keep placeholder on the wire; strip it before the client sees it.

## Approach

1. Track injected paths at request time:
   - New `open-sse/utils/reasonPlaceholder.js`: `REASON_PLACEHOLDER_PROP` shared
     constant, `cleanJSONSchemaForAntigravity(schema, onPlaceholder?)` gains a
     path collector (schema-object-space → args-space paths; `items` → `*`).
   - `openai-to-gemini.js`: collect per sanitized tool name while cleaning
     declarations; carry map via non-enumerable `_reasonPlaceholderMap` on the
     gemini base object; envelope wrappers (`wrapInCloudCodeEnvelope`,
     `wrapInCloudCodeEnvelopeForClaude`, `openaiToGeminiRequest`) register the
     map into a `WeakMap` keyed on the returned body (`registerReasonPlaceholders`
     merges).
   - `executors/antigravity.js`: in its second sanitize pass, merge-collect any
     paths not already recorded (missing-`parameters` fallback records `[]`).
   - `chatCore.js`: after `executor.execute`, `takeReasonPlaceholderMap(translatedBody)`
     → `reasonPlaceholderMap` → passed to all three response handlers + stream
     state (mirrors `renamedToolNames` plumbing).
2. Strip on response:
   - `utils/reasonPlaceholder.js` `stripReasonPlaceholders(toolName, args, map)`:
     deep-clone args, delete `reason` at recorded paths (`*` walks object/array
     children).
   - `response/gemini-to-openai.js` `emitFunctionCall`: strip before
     `JSON.stringify` using `state.reasonPlaceholderMap` keyed on raw wire name.
   - `nonStreamingHandler.js` `translateNonStreamingResponse`: extra param, strip
     in the Gemini/AG/vertex converter block.
3. Passthrough mode untouched (no translation = wire-native client).

## Critical files and ownership

| File | Change |
| --- | --- |
| `open-sse/utils/reasonPlaceholder.js` | NEW: registry + strip helper |
| `open-sse/translator/formats/gemini.js` | `addPlaceholders` path tracking; cleaner signature `onPlaceholder` |
| `open-sse/translator/request/openai-to-gemini.js` | collect/attach/register maps (3 sites) |
| `open-sse/executors/antigravity.js` | merge-collect in sanitize block |
| `open-sse/handlers/chatCore.js` | `takeReasonPlaceholderMap` → `sharedCtx` |
| `open-sse/handlers/chatCore/streamingHandler.js` | forward map to stream |
| `open-sse/utils/stream.js` | `reasonPlaceholderMap` option → `state` |
| `open-sse/translator/response/gemini-to-openai.js` | strip in `emitFunctionCall` |
| `open-sse/handlers/chatCore/nonStreamingHandler.js` | strip in gemini branch |
| `tests/unit/antigravity-reason-placeholder.test.js` | NEW |
| `CHANGELOG.md`, `docs/ANTIGRAVITY.md` | notes |

Single worker (main) — files are small, sequential.

## Verification

- AC-01: `TodoRead`-style empty params → tool call returns `arguments` without
  `reason` (unit: emitFunctionCall with map).
- AC-02: Nested free-form (`args`/`annotations`) → `reason` stripped inside
  nested object, other keys kept.
- AC-03: Tools that legitimately declare `reason` still keep it (no recorded
  path → no strip).
- AC-04: Wire request still carries placeholder schemas (transformRequest
  output unchanged upstream-side).
- AC-05: Focused vitest suite green; no regressions in antigravity/gemini tests.

- [x] T-01 utils/reasonPlaceholder.js + cleaner collector (AC-02, AC-04)
- [x] T-02 openai-to-gemini.js registration (AC-02, AC-03)
- [x] T-03 executor merge-collect + chatCore plumbing (AC-01)
- [x] T-04 response-side stripping: stream + non-stream (AC-01..AC-03)
- [x] T-05 tests + focused run (AC-05)
- [x] T-06 CHANGELOG + ANTIGRAVITY.md note

## Evidence and handoff

- `npx vitest run unit/antigravity-reason-placeholder.test.js` → 13/13 pass
  (root strip, nested `annotations`/`rows[*]` paths, legit-`reason` kept,
  no-mutation, executor merge + missing-params fallback).
- Focused regression suite (10 files: antigravity-claude-5-5, wire-parity, mitm,
  labels, capabilities, thought-signature-family, bugs-antigravity,
  agent-client-fixes, golden-*) → 121/121 pass.
- eslint on all 10 touched files → clean.
- Full suite: 218 fails run vs `known-fails.txt` (239) — the 24 fails outside
  the catalogue (golden-url-header, security-audit, openai-to-kiro,
  oauth-cursor-auto-import, executor-const-guard, …) all reproduce identically
  with the change stashed → pre-existing, not regressions.
- Residual: `handleForcedSSEToJson` receives the map but only parses OpenAI-
  shape SSE — unreachable for AG-shaped streams today (harmless).
- ZCode can now call `TodoRead`/`ListModels`/`CronList` normally; nested
  free-form args (`annotations`, `answers`, `args`) carry real keys again —
  model emits them because the placeholder is stripped client-side.

## Assumptions and contingencies

- Upstream still rejects truly-empty `properties` → placeholder stays required
  (fallback if not: could switch to `properties:{}` later, unverified).
- `reason` legitimately declared in client schema → cleaner never injects a
  path for it → never stripped.
