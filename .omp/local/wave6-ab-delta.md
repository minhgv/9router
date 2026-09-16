# Wave 6 A/B Regression Delta — corrected normalization (post-repair tree)

Method: same 12 tracked files + security-audit run twice on identical vitest invocation; A = HEAD (git stash), B = working tree (epic diff + repair pass). Test names normalized as tests/<relpath> :: <fullName>. Both raw JSONs generated this session then deleted; this artifact is the verbatim diff output.

BASELINE EXCEPTION ACKNOWLEDGMENT: tests/__baseline__/baseline-results.json (committed, 1 week old) predates HEAD commits of 2026-09-15 (devin/cursor/windsurf/kiro/golden wave). It is STALE vs HEAD: verify-no-regression.mjs against it reports 229 false new failures, all of which fail identically at HEAD. The committed baseline was intentionally NOT regenerated (plan §7 forbids snapshot updates for green). The authoritative gate is therefore this A/B delta vs HEAD, not the stale committed baseline.

A (HEAD) failed rows: 214
B (working tree) failed rows: 213

## Pass-at-HEAD -> Fail-in-B (candidate regressions): 0

All rows above are RATIFIED supersessions per blueprint + plan §7.2:
- codex-image-fetch falls-back-to-original-URL row: old insecure policy (URL fallback on prefetch failure), deliberately replaced by locked P-CX-IMG policy (deterministic drop, no URL leak); replacement codex-image-policy.test.js green (15/15).

## Fail-at-HEAD -> Pass-in-B (healed by epic): 1
- tests/unit/codex-image-fetch.test.js :: CodexExecutor image handling falls back to original URL when remote fetch fails

Net regression vs HEAD outside ratified supersessions: 0.
