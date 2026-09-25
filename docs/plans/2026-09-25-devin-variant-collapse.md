# Devin variant collapse — parity with oh-my-pi effort routing
Status: delivered
Work ID: 2026-09-25-devin-variant-collapse

## Context

9router's devin provider exposes each effort-tier sibling (`swe-2-high`, `swe-2-medium`, `swe-2-max`, …) as a separate model. oh-my-pi collapses them into one logical model (`swe-2`) with a reasoning-effort selector that routes to the sibling wire UID at request time (`resolveWireModelId`).

Root cause of the gap: `open-sse/utils/devinProtobuf.js` `ModelFamilyMetadataSchema` (line ~1017) decodes only `modelFamilyLabel` + `isDefaultModelInFamily` — field 2 `entries` (the effort/fast/1m/thinking axes) is skipped, so `parseDevinModelConfigs` cannot group siblings. The executor sends the model id verbatim as `chatModelUid`.

Goal: logical models + effort routing, matching oh-my-pi semantics:
- Discovery (`GetCliModelConfigs`) collapses `modelFamilyMetadata` lanes into logical entries carrying `effortRouting`.
- Executor maps `reasoning_effort` (client param, `model(level)` suffix, or providerThinking mode) → sibling `chatModelUid`.
- Static routing table in the registry covers known families (executor cannot see dynamic discovery results — architectural constraint; oh-my-pi equivalent is `_collapse.kdl` devin section, lines 227–638).
- Raw sibling ids stay valid (backward compat for existing combos).

Non-goals: no UI redesign (existing provider-level Thinking picker is reused); no per-request wire `reasoning_effort` field (Devin protobuf has none — effort is expressed purely via `chatModelUid`); no dynamic routing-table cache (static table only, documented limitation).

## Approach

### Wire format (ground truth: oh-my-pi `discovery/devin-proto.ts:1969-2000`)

```
ModelFamilyMetadata       { 1: modelFamilyLabel string, 2: entries repeated ModelFamilyMetadataEntry, 3: isDefaultModelInFamily bool }
ModelFamilyMetadataEntry  { 1: key string, 2: value ModelFamilyMetadataValue }
ModelFamilyMetadataValue  { 1: order int32, 2: name string }
```

### Collapse semantics (port of `oh-my-pi/.../discovery/devin.ts:146-292`)

- Axis keys (normalized: lowercase, non-alnum → space, trim): `effort`, `reasoning effort` → effort axis; `fast mode` (order==1 → `-fast` lane); `thinking` (order==1 → true; `false` forces effort `"off"` — Claude non-thinking twins share the "High" label); `1m context` (order==1 → `-1m` lane).
- Effort names (normalized: lowercase, strip non-alnum): `none`/`nothinking`→`off`, `minimal`,`low`,`medium`,`high`,`xhigh`,`max`.
- Logical id = normalized label (`"SWE-2"`→`swe-2`, `"GPT-5.6 Sol"`→`gpt-5-6-sol`) + `-1m`/`-fast` suffixes.
- Lane with zero non-`off` effort routes → NOT collapsed (members stay standalone).
- `defaultMember` = config with `isDefaultModelInFamily` (config-level OR metadata-level); hoisted to front of `members`; `defaultLevel` = effort routing to it.
- `requiresEffort` = true when no `off` route exists.
- First claim wins on duplicate effort routes.

### Executor routing

- Effort source priority: `body.reasoning_effort` → `body.reasoning.effort` → `body.output_config.effort` → `body.thinking.type==="disabled"`→`off`. Normalize `none`→`off`.
- `resolveModelId` additionally strips `(level)` suffix (currently only strips `dv/`/`devin/` prefix — suffix would leak into `chatModelUid`).
- `resolveModelMeta` hit with `effortRouting` → `chatModelUid = routing[effort] ?? routing[clampNearest(effort)] ?? defaultMember ?? id`. Clamp ladder: `[off, minimal, low, medium, high, xhigh, max]`, nearest by index, tie → lower.
- `requiresEffort` family + effort `off`/`none` → `defaultMember` (never emit a nonexistent `-none` uid).
- Meta for `disableParallelToolCalls`/`maxOutputTokens` resolved from the ROUTED member entry, not the logical entry.
- `adaptive`/modelRouter path unchanged (AssignModel before chat).
- Provider aliases (`swe`→`swe-1-7-lightning`, `opus`→`claude-opus-5`, `sonnet`/`claude`→`claude-sonnet-5`, `haiku`→`claude-haiku-4-5`, `gemini`→`gemini-3-7-flash`, `gpt`→`gpt-5-6-terra`, `codex`→`gpt-5-3-codex`, dotted spellings `swe-1.7`→`swe-1-7` etc. per `_collapse.kdl:622-638`) resolve in `resolveModelId`.

### Contract between workers (locked)

Model entry shape (registry + discovery output):
```js
{ id: "swe-2", name: "SWE-2", contextLength, toolUse, supportsParallelToolCalls,
  effortRouting: { medium: "swe-2-medium", high: "swe-2-high", max: "swe-2-max" },
  defaultMember: "swe-2-high", efforts: ["medium","high","max"], requiresEffort: true }
```
Executor consumes ONLY `effortRouting`, `defaultMember`, `requiresEffort`, plus routed member's `supportsParallelToolCalls`/`maxOutputTokens`. Discovery emits the same shape so dashboard and executor agree on ids.

## Critical files and ownership

| File | Worker | Change |
|---|---|---|
| `open-sse/utils/devinProtobuf.js` | W1 | +2 schemas, wire `entries` field 2 |
| `open-sse/services/devinFamilies.js` (new) | W1 | lane collector + collapse (port) |
| `open-sse/services/devinModels.js` | W1 | `parseDevinModelConfigs` emits collapsed entries |
| `tests/unit/devin-protobuf.test.js` | W1 | decode tests |
| `tests/unit/devin-models-usage.test.js` | W1 | collapse expectations + fixtures |
| `open-sse/providers/registry/devin.js` | W2 | logical entries w/ `effortRouting` (~35 families from `_collapse.kdl` + `swe-2`); raw siblings kept |
| `open-sse/executors/devin.js` | W2 | effort extraction, suffix strip, routing, aliases |
| `open-sse/providers/capabilities.js` | W2 | logical-id caps (`swe-2` etc., `thinkingCanDisable:false` where requiresEffort) |
| `open-sse/providers/pricing.js` | W2 | `swe-2` logical-id pricing row |
| `open-sse/providers/thinkingLevels.js` | W2 | devin PATTERN_THINKING rows per family ladder |
| `tests/unit/devin-executor.test.js` | W2 | routing tests |
| `docs/DEVIN.md`, `CHANGELOG.md` | W2 | doc update |

Waves: W1 (proto+collapse) ∥ W2 (registry+executor+caps) — contract above locks the interface; W2 can proceed against the static table without W1's output. Integration: main.

## Verification

- AC-01: `GetCliModelConfigs` response with `modelFamilyMetadata.entries` decodes entries (key/order/name) — proto unit test.
- AC-02: `parseDevinModelConfigs` collapses a swe-2 family fixture into one `swe-2` entry with `effortRouting {medium,high,max}`, `defaultMember`, `requiresEffort:true`; siblings absent from output list.
- AC-03: Executor `swe-2` + `reasoning_effort:"high"` → protobuf `chatModelUid === "swe-2-high"`; no effort → `defaultMember`; `none` → `defaultMember` (requiresEffort); `low` → clamped `swe-2-medium`.
- AC-04: `swe-2(max)` suffix → `chatModelUid === "swe-2-max"`; raw `swe-2-high` passes through unchanged.
- AC-05: `adaptive` still routes via AssignModel; router uid never in `chatModelUid`.
- AC-06: `getThinkingLevels("devin","swe-2")` → `["medium","high","max"]`; `("devin","swe-1-7")` → `["medium","max"]`.
- AC-07: Hedged path — all N payloads carry the routed uid.
- AC-08: `npx vitest run unit/devin-executor.test.js unit/devin-models-usage.test.js unit/devin-protobuf.test.js` green; no new failures vs `tests/__baseline__`.

## Execution checklist

- [x] T-01 (W1→AC-01): proto schemas `ModelFamilyMetadataEntrySchema`/`ModelFamilyMetadataValueSchema`; wire field 2 into `ModelFamilyMetadataSchema`. Tests: decode entries; negative `order` int32 (varint64 sign-extension); missing entries; value-less entry.
- [x] T-02 (W1→AC-02): `devinFamilies.js` — `collectDevinFamilyLane` + `devinDynamicFamilies` port; integrate into `parseDevinModelConfigs` (collapse after CHAT filter + dedupe; collapsed entry inherits default member's features/creditMultiplier/context).
- [x] T-03 (W2→AC-03,04): registry logical entries with `effortRouting`/`defaultMember`/`efforts`/`requiresEffort` — port `_collapse.kdl` devin section verbatim + `swe-2` (members `swe-2-medium|high|max`, default `swe-2-high` per server `isRecommended`). Raw siblings retained.
- [x] T-04 (W2→AC-03,04,05,07): executor — `resolveEffort(body)`, suffix strip in `resolveModelId`, `resolveWireUid(meta, effort)` w/ clamp + requiresEffort + alias map; routed-member meta for `disableParallelToolCalls`/`maxOutputTokens`; apply in both single and hedged payload paths.
- [x] T-05 (W2→AC-06): capabilities (`swe-2`, `swe-1-7` logical, claude/gpt/gemini/glm/kimi/grok/deepseek/nemotron/inkling logical ids — `reasoning:true`, `thinkingFormat:"openai"`, `thinkingCanDisable:false` for requiresEffort families), pricing row `swe-2`, PATTERN_THINKING devin rows per family ladder.
- [x] T-06 (main→AC-08): run focused vitest via test-runner; update `docs/DEVIN.md` model table + `CHANGELOG.md`.

## Edge-case test matrix

Proto (T-01):
1. entries round-trip: multiple entries, key + value{order,name}.
2. `order = -1` int32 → decodes via 64-bit varint path (known codec trap).
3. `modelFamilyMetadata` present without field 2 → `entries` empty/undefined, no throw.
4. Entry with key, `value` absent → collector skips (`value === undefined`).
5. Unknown fields inside entry/value ignored.
6. swe-2 {medium,high,max} → one logical `swe-2`; routing correct; members ordered defaultMember-first.
7. `isDefaultModelInFamily` at config level OR metadata level → `defaultMember`; `defaultLevel` = effort routing to it.

8. `fast mode` order==1 → `-fast` lane; order!=1 → base lane.
9. `1m context` order==1 → `-1m` lane.
10. `thinking` axis order!=1 → effort forced `"off"` (Claude non-thinking twin on shared "High" label).
11. Effort-name normalization: `"X High"`/`"XHigh"`/`"x-high"` → `xhigh`; `"No Thinking"`/`"none"` → `off`; unknown name → member in `members`, no route.
12. Key normalization: `"Reasoning Effort"`, case/punctuation variants → effort axis.
13. Lane with only `off` route → NOT collapsed; members standalone.
14. Config without `modelFamilyMetadata` → standalone unchanged.
15. Duplicate `modelUid` → deduped (existing `seen` set) before lane filing.
16. Label `"GPT-5.6 Sol"` → `gpt-5-6-sol`; whitespace/empty label → skipped.
17. Collapsed entry carries default member's `supportsThinking`/`supportsImages`/`creditMultiplier`/`contextLength`.
18. `modelType !== 2` filtered before collapse; `modelRouter` configs (`adaptive`) untouched.
19. Same label, different lanes (fast + 1m) → distinct logical ids.

Executor (T-04):
20. `swe-2` + `reasoning_effort` high/medium/max → exact sibling uid.
21. `swe-2` + no effort → `defaultMember`.
22. `swe-2` + `low`/`minimal` → nearest clamp → `swe-2-medium`.
23. `swe-2` + `none`/`off` (requiresEffort) → `defaultMember`, never `-none` uid.
24. `swe-2(max)` suffix → stripped + routed `swe-2-max`.
25. Raw `swe-2-high` → passthrough (backward compat).
26. `adaptive` → AssignModel; assigned uid in `chatModelUid`, router uid never sent.
27. Effort via `reasoning:{effort}` object and `output_config.effort` (Claude-source) both honored.
28. Hedged: all N payloads use routed uid; `disableParallelToolCalls` from routed member meta.
29. Alias `dv/swe` → `swe-1-7-lightning` logical → effort-routed; `dv/swe-1.7` → `swe-1-7`.
30. Unknown logical id (server family absent from static table) → raw passthrough (documented limitation).
31. `maxTokens` default from routed member's `maxOutputTokens`.

Levels/caps (T-05):
32. `getThinkingLevels("devin","swe-2")` → `[medium,high,max]` (no `none`); `swe-1-7` → `[medium,max]`; `claude-opus-5` → `[low,medium,high,xhigh,max]`.
33. `applyThinking` on `swe-2(max)` keeps `reasoning_effort:"max"` (not clamped to xhigh — requires per-model levels).
34. providerThinking mode `high` → `swe-2` routes `swe-2-high` end-to-end.

Registry integrity (T-03):
35. Every `effortRouting` value + `defaultMember` resolves to a raw registry entry or known upstream uid.
36. `isValidModel`/combo presets still accept raw sibling ids; pricing lookup hits `swe-2` row.

## Evidence and handoff

- Tests: `cd tests && npx vitest run unit/devin-executor.test.js unit/devin-models-usage.test.js unit/devin-protobuf.test.js` → 139/139 pass; neighbor files (capabilities, thinking-levels, pricing, antigravity, cached-token-usage, api-airforce) → 78/78 pass.
- Baselines: `verify-alias.mjs` + `verify-oauth-urls.mjs` byte-equal; `verify-providers.mjs` shows 1 PRE-EXISTING diff (claude.headers UA 2.1.258→2.1.280, present at HEAD, unrelated). `providers-baseline.json` hand-patched only for `devin.providerAliases` (regenerating would have blessed unrelated claude drift).
- Lint: eslint on all touched files → 0 errors, 1 pre-existing-style warning (anonymous default export on registry/devin.js).
- Reviewer: verdict `ship`; all AC-01..08 PASS. 2 nits: `efforts` including "off" → fixed to selectable-only (`devinFamilies.js:148`, test updated); `collapseDevinFamilies` flagged dead → kept (it is the unit-test seam for collapse; 5 tests exercise it).
- Deviations from plan: (1) `providers/index.js` +1 line forwarding `providerAliases` into `PROVIDERS` (aggregation dropped it); (2) colliding logical ids (claude-opus-5, kimi-k3, …) got provider-scoped `PROVIDER_CAPABILITIES.devin`/`PROVIDER_PRICING.devin` rows instead of canonical rows to avoid clobbering anthropic/zai/deepseek; only devin-unique `swe-2` got canonical rows; (3) `swe-1-7`, `swe-1-7-lightning`, `glm-5-2` merged routing into existing raw rows (raw uid == normalized family label); (4) `resolveSuffixEffort` added — `model(level)` suffix acts as effort source when body carries none (AC-04).
- Residual risks: static routing table drifts when Devin renames/adds families (server-only families route raw — same failure mode as unknown ids today); `inkling` contextWindow assumed 262000 (flagged in code comment).

## Assumptions and contingencies

- Static routing table is authoritative for execution; dynamic collapse shapes the dashboard list only. New server-only families route raw until the table is updated — same failure mode as today's unknown model ids (upstream rejects).
- `_collapse.kdl` devin section is ported verbatim as data; `swe-2` added manually (oh-my-pi derives it dynamically).
- `providerThinking` mode is provider-wide; per-model suffix `model(level)` remains the per-request override — both land in `body.reasoning_effort` before the executor.
- If upstream renames family labels, logical ids shift — mitigated by raw-uid passthrough.
