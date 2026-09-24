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

## Execution checklist
- [ ] T-01: Run merge, enumerate conflicts (AC-01)
- [ ] T-02: Resolve antigravity + openai-to-gemini (AC-02)
- [ ] T-03: Resolve accountFallback + xiaomi-mimo cluster
- [ ] T-04: Resolve capabilities + misc + version/docs
- [ ] T-05: Verify devin untouched (AC-03), lint, dev server smoke (AC-04)
- [ ] T-06: Baseline test comparison (AC-05)

## Evidence and handoff
(pending)

## Assumptions and contingencies
- If a conflict hunk is genuinely ambiguous, prefer upstream behavior + re-apply fork protection on top.
- Rollback: `git merge --abort` anytime before commit; merge commit can be reverted.
