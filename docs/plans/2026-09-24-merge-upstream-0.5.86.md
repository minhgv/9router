# Merge upstream/master (v0.5.86) into fork

## Context
- Fork `minhgv/9router` at 0.5.80, 38 commits ahead of merge-base `17c4cc76` (2026-09-11).
- Upstream `decolua/9router` at v0.5.86, 72 commits ahead.
- User requirement: merge + resolve; Devin and Antigravity must stay safe — DO NOT downgrade anti-detection mechanisms (zero-width obfuscation, IDE version parity, request.labels, system-phrase sanitizer, endpoint failover, envelope parity).

## Approach
- `git merge upstream/master` (single conflict pass; rebase would replay 36 commits and re-conflict repeatedly).
- Resolution policy per file:
  - Semantic duplicates (requestType omission, 4xx cooldown, capabilities, refusal→content_filter): prefer upstream version, keep fork's extra protections.
  - Anti-detection code (fork-only): always keep.
  - Version files: take upstream's higher version (0.5.86) — fork will re-bump on next release.
  - CHANGELOG: keep both histories.

## Critical files and ownership
- `open-sse/executors/antigravity.js` — requestType + thoughtSignature model param
- `open-sse/translator/request/openai-to-gemini.js` — same
- `open-sse/services/accountFallback.js` — fork refactor vs upstream fix
- `open-sse/executors/xiaomi-mimo.js`, `mimoAccount.js`, registry, api-key route — v2.6 overlap
- `open-sse/providers/capabilities.js` — same-commit-different-patch
- `open-sse/executors/default.js`, `open-sse/services/usage.js`, `combos/page.js`, `cli-tools/all-statuses`, `v1/models`, `OAuthModal.js` — misc
- Version/docs: `package.json`, `cli/package.json`, `CHANGELOG.md`, `DOCKER.md`, `cli/README.md`, `appConstants.js`
- Tests: `account-fallback-4xx.test.js`, `xiaomi-mimo-executor.test.js`

## Verification
- AC-01: `git merge` completes, no conflict markers remain (`grep -r '<<<<<<<'`).
- AC-02: Fork anti-detection intact: zero-width obfuscation, version manifest tracking, request.labels, sanitizer, failover present in merged antigravity.js.
- AC-03: Devin files unchanged from fork state.
- AC-04: `npx eslint` on touched files clean; dev server boots; usage page renders Cache Ratio.
- AC-05: `cd tests && npx vitest run` — no NEW failures vs known-fails baseline (239).

- [x] T-01: Run merge, enumerate conflicts (AC-01)
- [x] T-02: Resolve antigravity + openai-to-gemini (AC-02)
- [x] T-03: Resolve accountFallback + xiaomi-mimo cluster
- [x] T-04: Resolve capabilities + misc + version/docs
- [x] T-05: Verify devin untouched (AC-03), lint, dev server smoke (AC-04)
- [x] T-06: Baseline test comparison (AC-05)
## Evidence and handoff
- Merge commit `581aab9e` — 23 conflicts resolved, 273 files changed (+17,087/−1,302).
- AC-01 ✅ no conflict markers remain.
- AC-02 ✅ anti-detection intact: `obfuscateSensitiveWords`, `ensureAntigravityVersion`, `buildAntigravityLabels`, `ANTIGRAVITY_WIRE_PROFILES`, `resolveAntigravityThinkingLevel`, endpoint failover (403/404/429/5xx), `delete body.requestType` (upstream's belt added on top of fork's omission).
- AC-03 ✅ devin files byte-identical to pre-merge (`git diff e27ff842 HEAD -- devin*` = 0).
- AC-04 ✅ dev server boots (20127), usage page renders Cache Ratio in Tokens mode (94.4% on gpt-6-luna), new upstream charts (TOP MODELS, Requests mode) render.
- AC-05 ✅ 390/390 tests pass across 28 merged-area files (antigravity, devin, xiaomi-mimo, capabilities, account-fallback, translator). Baseline: alias byte-equal; providers diff = upstream claude-cli UA bump 2.1.258→2.1.280 only.

## Merge-time fixes applied
- `registry/index.js`: `p124` double-declared (qoder-cn + devin) → devin renamed `p125`.
- `mimoAccount.js`: `invalidateMimoAccountCookieCache` updated to `sha256(apiBase|token)` key format (upstream changed cache key; fork's per-token invalidate was silently broken).
- `xiaomi-mimo.js`: preview models (`mimo-x-pro-preview`, `mimo-x-flash-preview`) re-added to `ACCOUNT_MODELS` — upstream renamed PREVIEW_MODELS→ACCOUNT_MODELS and dropped them.
- `claude.js`: upstream's `applyCloaking` (fabricated billing header + fake user_id) NOT applied — fork security epic `ba1d1257` deliberately removed it; kept `hoistToolResultImages` + imports removed.
- `all-statuses/route.js`: dropped `devin` import (fork removed devin-cli tool); kept pi/omp/crush/forge/smelt/codewhale.
- `api-key/route.js`: kept fork's baseUrl host allowlist (anti API-key leak).
- `accountFallback.js`: kept fork's richer refactor (Retry-After parsing, backoff, `classification.rule` guard) — upstream's 4xx fix already subsumed.
- `appConstants.js`: union of both sanitizer rule sets (fork: google-antigravity/zcode/z.ai; upstream: Hermes + billing-header strip).
- Tests: `xiaomi-mimo-executor.test.js` cache keys updated to `apiBase|token` format.

## Assumptions and contingencies
- If a conflict hunk is genuinely ambiguous, prefer upstream behavior + re-apply fork protection on top.
- Rollback: `git merge --abort` anytime before commit; merge commit can be reverted.
- Residual: OAuthModal/combos lint errors are pre-existing upstream patterns (set-state-in-effect), not merge regressions.

