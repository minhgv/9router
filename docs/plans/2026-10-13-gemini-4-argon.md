# Add gemini-4-argon (Antigravity 2.23.0 catalog sync)

Work ID: `2026-10-13-gemini-4-argon` · Status: **complete** (UA fix landed same day, see addendum) · Branch: `master` (fork, 108 ahead / 52 behind upstream)

## Context

Gemini 4 "Argon" announced 2026-09-30 (pre-release). Upstream PR decolua/9router#4507 (open, stale since 2026-10-02) only adds `capabilities.js` + `pricing.js` for provider `gemini` — insufficient to actually run the model, because it never lands in the `antigravity` provider registry or MITM model map.

Ground truth recovered from `Antigravity.app 2.23.0` (`/Applications`, `language_server` binary strings) — confirmed wire IDs the official client emits:

| Wire ID | Label |
|---|---|
| `gemini-4-argon` | Gemini 4 Argon (base/default) |
| `gemini-4-argon-high` | Gemini 4 Argon (High) |
| `gemini-4-argon-medium` | Gemini 4 Argon (Medium) |
| `gemini-4-argon-low` | Gemini 4 Argon (Low) |

No `gemini-4-argon-tiered` exists — unlike the 3.7/3.8 flash line upstream; Argon uses literal tiered wire IDs, same convention the local fork already adopted (registry comment: "no synthetic `(tier)` suffix — those 404 on daily-cloudcode-pa"; tier travels in `generationConfig.thinkingConfig.thinkingLevel`).

Also visible in the 2.23.0 binary but **out of scope** (separate change if wanted): `gemini-3.1-ultra`, `claude-opus-4-8`, `gpt-oss-{20b,120b}-maas`.

## Approach

Mirror the existing `gemini-3.8-flash` block conventions on this fork (literal `upstreamModelId`, no `(tier)` suffix). Port the PR-4507 caps/pricing but override its unverified `maxOutput: 1048576` claim → `65536` (3.x line value; PR body itself says the launch figure is unpublished — the diff contradicts its own body).

Changes:

1. `open-sse/providers/registry/antigravity.js` — 4 models after the 3.8-flash block:
   - `{ id: "gemini-4-argon", name: "Gemini 4 Argon", upstreamModelId: "gemini-4-argon-medium" }` (base → medium, parity with `gemini-3.8-flash` → `-medium`)
   - `{ id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", upstreamModelId: "gemini-4-argon-high" }`
   - `{ id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)", upstreamModelId: "gemini-4-argon-medium" }`
   - `{ id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)", upstreamModelId: "gemini-4-argon-low" }`
   - Comment noting wire IDs verified from Antigravity 2.23.0 `language_server`.
2. `src/shared/constants/cliTools.js` — append the 4 IDs to `modelAliases` and add 4 `defaultModels` rows (top of list, newest first — matches how 3.8 leads).
3. `open-sse/providers/capabilities.js` — add `{ pattern: "*gemini-4*", ... }` **above** `*gemini-3.8*` (patterns match in order): `{ vision: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65536 }`. Deliberately no `audioInput`/`videoInput` (announcement documents text+image only).
4. `open-sse/providers/pricing.js` — `gemini-4-argon` + 3 tier rows, `{ input: 2.00, output: 10.00 }` only (cached/reasoning/cache_creation unpublished; entries are returned verbatim — a fabricated 0 would mis-bill).
5. `src/mitm/antigravityIdeVersion.js` — `ANTIGRAVITY_IDE_VERSION` `2.11.0` → `2.23.0` (match installed IDE).
6. `tests/unit/gemini4-argon-caps.test.js` — port PR test, adapted: assert `maxOutput: 65536`, registry presence of all 4 IDs, `getModelUpstreamId` resolves base→`-medium`, wire IDs are literal (no `(tier)`).
7. `tests/unit/antigravity-ide-version.test.js` — `CURRENT_VERSION` `2.11.0` → `2.23.0`.

## Critical files and ownership

| File | Change |
|---|---|
| `open-sse/providers/registry/antigravity.js` | +4 model entries |
| `src/shared/constants/cliTools.js` | aliases + defaultModels |
| `open-sse/providers/capabilities.js` | +1 pattern row |
| `open-sse/providers/pricing.js` | +4 pricing rows |
| `src/mitm/antigravityIdeVersion.js` | version bump |
| `tests/unit/gemini4-argon-caps.test.js` | new test |
| `tests/unit/antigravity-ide-version.test.js` | version pin update |

Single package per file, sequential edits — no parallel waves needed. Do NOT regenerate `registry/index.js` (antigravity already registered).

## Verification

- **AC-01** `getCapabilitiesForModel("antigravity", "gemini-4-argon")` → `reasoning:true, vision:true, search:true, thinkingFormat:"gemini-level", contextWindow:1048576, maxOutput:65536`; `audioInput`/`videoInput` falsy (proves `*gemini-3*` wildcard does not claim it).
- **AC-02** `getModelUpstreamId("antigravity", "gemini-4-argon")` → `gemini-4-argon-medium`; tier IDs resolve to themselves.
- **AC-03** `getPricingForModel("antigravity", "gemini-4-argon")` → `{input:2, output:10}`; `cached`/`reasoning`/`cache_creation` keys absent. All 3 tier IDs resolve the same.
- **AC-04** All 4 IDs appear in `modelAliases` and `defaultModels` of MITM_TOOLS.antigravity.
- **AC-05** `antigravity-ide-version.test.js` passes with `2.23.0`; `gemini-3.x` caps untouched (mutation-checked: deleting the new pattern must fail the test).
- **AC-06** `npx eslint` clean on touched files; `tests/__baseline__/verify-providers*` baselines show no new drift vs pre-change run.
- **AC-07 (conditional)** Live smoke: if an `antigravity` OAuth connection exists in the local DB, one real `chat/completions` call with `model: "antigravity/gemini-4-argon-medium"` returns non-error (proves backend allowlist). If no credentials, mark SKIPPED — registry correctness still proven by AC-01..05.

## Execution checklist

- [x] T-01 → AC-01..03: registry + capabilities + pricing edits
- [x] T-02 → AC-04: cliTools.js edits
- [x] T-03 → AC-05: ideVersion bump + test pin + new test file
- [x] T-04 → AC-05,AC-06: run `vitest` on new + antigravity-related files; eslint; baseline verify
- [x] T-05 → AC-07: live smoke via direct upstream calls (argon absent — backend GA pending)
- [x] T-06: update this record evidence; CHANGELOG entry added

## Evidence and handoff

Verification run 2026-10-13:
- **AC-01..05 (vitest, via test-runner)**: `npx vitest run unit/gemini4-argon-caps.test.js unit/antigravity-ide-version.test.js unit/antigravity-ide-ua.test.js unit/antigravity-retry-hook.test.js unit/antigravity-usage-headers.test.js unit/antigravity-weekly-quota.test.js unit/antigravity-endpoint-failover.test.js unit/antigravity-mitm.test.js` → **71/71 passed** across 8 files. New test file mutation-pins the `*gemini-4*` pattern (removal fails the suite).
- **AC-06**: `eslint` on touched files → 0 errors (1 pre-existing `import/no-anonymous-default-export` warning in registry/antigravity.js, present before this change). `tests/__baseline__/verify-providers.mjs` → "PROVIDERS byte-for-byte equal (84 providers)" after re-pinning baseline UA to 2.23.0.
- **AC-07 (live smoke, direct upstream calls)**: refreshed the real `antigravity` OAuth token (account `minhgvmntn@gmail.com`, project `aicode-consumers`) and called `POST /v1internal:fetchAvailableModels` on daily + prod hosts → both 200, **argon absent** (26 daily / 35 prod model ids, none matching `argon|gemini-4`). Direct `streamGenerateContent` with `gemini-4-argon-medium` → **404 NOT_FOUND**. Conclusion at the time: backend allowlist not yet enabled for this account. **Superseded — see AC-08.**
- Official update manifest confirms `2.23.0` as the current release (`latest-arm64-mac.yml`), validating both version bumps.
- Scope additions beyond plan: `providers/shared.js` + `utils/antigravityVersion.js` static UA fallbacks bumped to 2.23.0, and 4 test files + `providers-baseline.json` re-pinned 2.11.0 → 2.23.0.

## Addendum 2026-10-13 (evening): root cause was the User-Agent client token, not backend GA

User reported argon still broken; cross-referenced `~/code/GitHub/oh-my-pi` (`pi-catalog`, verified working). Live bisect on the same account/project:

| UA sent | `fetchAvailableModels` | `generateContent gemini-4-argon-medium` |
|---|---|---|
| `antigravity/ide/2.23.0 darwin/arm64` (old pin) | 200, 26 ids, **no argon** | **404 NOT_FOUND** |
| `antigravity/2.23.0` (bare token — what the MITM rewrite produced) | — | **404 NOT_FOUND** |
| `antigravity/hub/2.23.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)` | 200, 29 ids, **argon present** | **200 OK** (+ streamGenerateContent SSE returns `OK`, `modelVersion: gemini-4-argon`) |

- **AC-08**: daily + sandbox 404 argon under `ide`; prod 429s account-wide under minimal probes (control `gemini-3.8-flash-medium` also 429 — prod gating, not argon-specific). `loadCodeAssist` accepts both UA forms (200). `retrieveUserQuotaSummary` shows ~95% weekly remaining → 429s are gating fingerprints, not quota.
- **Fix landed**: `ANTIGRAVITY_IDE_USER_AGENT` (shared.js) + `getAntigravityIdeUserAgent()` → `antigravity/hub/<ver> (aidev_client; os_type=darwin; arch=arm64; cl=963137146)` with `ANTIGRAVITY_CL/OS/ARCH` env overrides; `src/mitm/antigravityIdeVersion.js` regex fixed to bump only the version and preserve the `hub`/`ide` client token (bare-token output 404s argon). Tests re-pinned (4 UA assertions + baseline json + new token-preservation test); docs (ANTIGRAVITY.md, CHANGELOG v0.5.90) updated.
- **Verification**: vitest 8 antigravity files → 71/71 pass; eslint clean; `verify-providers.mjs` byte-for-byte equal (84 providers); live `streamGenerateContent` 200 on `gemini-4-argon-low`/`medium`/`high`.
- Parity reference: `oh-my-pi/packages/catalog/src/wire/gemini-headers.ts:111-119` (`antigravity/hub` UA) and wire profiles `:158-160` (argon `maxOutputTokens: 65536`, no `modelEnum` — matches our under-claim).

Residual risks: none for entitlement — argon live-verified 200 under the hub UA. `maxOutput: 65536` may under-claim if Argon truly ships 1M output; audio/video may be added by Google later. Out-of-scope 2.23.0 catalog models (`gemini-3.1-ultra`, `claude-opus-4-8`, `gpt-oss-*-maas`) not added.

## Assumptions and contingencies

- Backend allowlist unknown: catalog presence ≠ OAuth entitlement. If AC-07 fails with model-not-found/403, ship anyway — registry is a local catalog; error surfaces only at call time and self-heals when Google enables the account.
- `maxOutput` deliberately conservative (65536). If a published source later confirms 1M output, it's a one-line bump.
- `agy` CLI 1.3.3 contains no argon wire IDs — model catalog lives in `language_server`, which is the authoritative source used here.
- Pricing from Artificial Analysis (secondary source); models.dev doesn't carry Argon yet.
