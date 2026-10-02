# Selective upstream sync: OpenAI Codex + Claude

Work ID: `2026-10-01-upstream-sync-codex-claude`  
Owner: Pi (main; sole writer of this record)  
Status: accepted — implementation, verification and consolidated repair complete  
Next safe action: hand off the uncommitted selective upgrade; commit/push require separate user authorization.

## Context

User requests an implementation plan for upgrading OpenAI Codex and Claude against upstream while preserving their Antigravity and Devin commits, including indirect effects through shared modules.

Prior records:
- `2026-09-23-codex-upstream-sync.md`: retain proxy-aware refresh, P-CX-IMG fail-closed image handling, account/workspace resolution, auto-review routing and usage reporting.
- `2026-09-17-anthropic-provider-improvement.md`: credential-aware beta policy, no fabricated CCH/identity or decoy tools, reversible tool mapping, refresh leases/generation fencing, scoped usage/fallback.
- `2026-09-24-merge-upstream-0.5.86.md`: Antigravity endpoint/version/envelope/sanitizer protections retained; deliberately rejected upstream fabricated identity/cloaking behavior.
- `2026-09-25-devin-variant-collapse.md` and `2026-09-25-devin-shared-catalog.md`: logical family/effort routing plus connection-scoped dynamic catalog, epoch fencing, mixed-waiter cancellation fix.

Corrections to the earlier chat assessment:
1. Two-way file diffs demonstrate divergence, not actual three-way merge conflicts. No merge/conflict simulation has established conflict counts.
2. The larger upstream Claude cloaking implementation is not automatically preferable: local removed fabricated billing/identity and decoys deliberately.
3. Removing local Claude OAuth 1M-beta filtering would undo an explicit local policy. Client beta merging must still pass the final credential-aware gate.
4. A global upstream merge is unnecessarily broad for this objective. Use selective feature ports with dependency closure, not whole-file replacement.

Non-goals: upgrade Antigravity/Devin, import unrelated providers or CLI remote-connect features, replace DB/refresh architecture, add undocumented OAuth capabilities, modify credentials/live account state, change package versions, commit or push automatically. Implementation authorized by the user's subsequent “thực hiện kế hoạch” request.

## Approach

### Source and change control

- Pin current local HEAD and upstream commit before implementation; record dirty/untracked user changes and do not overwrite them. A later upstream fetch requires renewing the inventory rather than silently expanding scope.
- Source changes come from the pinned upstream feature commits. Port required hunks and dependent helpers explicitly; no `merge upstream/master`, reset, whole-file checkout, or blanket ours/theirs conflict resolution.
- Capture the exact protected path manifest and baseline hashes before mutation. Dedicated Antigravity/Devin files must stay byte-identical; existing user edits are part of that baseline, not expendable drift.
- Shared modules have one integration owner. Only Codex/Claude-specific changes or the minimum shared correctness fix needed for their upgrade are allowed. Every shared change requires a protected-provider behavioral check.
- No exported-symbol signature change without LSP references/graph usages. Reuse existing utilities and registries; do not hand-edit the generated registry index.

### Intended feature scope

**Codex:** updated CLI identity and catalog (including GPT-6.1 Sol and extended-context annotations), correct backend wire IDs/review quota mapping, Responses Lite request support, hosted web search, compatible effort levels, context/output limits and pricing, reduced refresh lead time with existing lease/CAS/proxy protection retained, Responses output/usage/completion and bounded watchdog behavior.

**Claude:** Sonnet 5.5 and Sonnet 5.x adaptive thinking/xhigh, source-aware trailing-user cleanup without destroying intentional prefill, container-upload preservation, final tool-result cache breakpoint, reversible tool-name restoration, client beta/session and rate-limit header propagation under local credential/trust policy, usage/free-limit reset feature only through the existing authenticated/proxy-aware management boundary.

### Candidate upstream feature map

These commit IDs were observed in the archived upstream inventory; the available upstream ref is pinned below. Wave 0 must confirm dependency closure and already-equivalent local behavior before applying any hunk. A commit is a source reference, not authorization to apply its entire patch.

| Feature | Upstream source commits | Port decision / local constraint |
|---|---|---|
| Codex GPT-6.1 Sol + identity | `dec820b9`, `ca6e8407` | Catalog, pricing and consistent identity version; no protected-provider version changes |
| Codex catalog/routing + 1M variants | `8f9ff44f`, `9f41ee75` | Coordinate registry/wire-ID/model-marker/alias resolution; preserve explicit OpenAI/alias precedence |
| Codex capabilities/pricing/search | `92c7bdd5`, `89ffac5a`, `7bf93178` | Selected model rows/rules only; keep AG/DV rules and rule ordering |
| GPT-6 Sol/Luna / Responses Lite | `95600db1` and its executor prerequisites | Existing local model support is partly equivalent; inspect Lite dependency closure, do not duplicate models/tests |
| Codex refresh reuse | `0bc7f86e` | Port lead-time/usage-refresh improvement around the stronger local lease/CAS; retain proxy and metadata |
| Responses terminal output | `273f0c32` | Preserve real output items across completion without breaking local abort handling |
| Responses real usage + wait bound | `7111db35`, `fbcaa282` | Port together with request/stream state prerequisites; do not reapply locally ported `da004655` blindly |
| Empty thinking markers | `5d2cfbf3` | Selected translator behavior only; retain visible reasoning and signature handling |
| Claude Sonnet/adaptive/xhigh | `49ba54b2`, `ccd0677d`, `7894f3d3` | Model plus capability/effort mapping as one contract |
| Claude cleanup/prefill/uploads | `75834e96`, `5e9bd464`, `4f274c7f` | Preserve input-source intent; no blanket last-assistant deletion |
| Claude final tool-result cache | `49c761cd` | Enforce four-marker budget and preserve tool-result/error/image content |
| Claude tool restoration | `b65d2d0a` | Minimal reversible fix only; no upstream fake identity/billing/decoy prerequisites |
| Claude beta/session/rate-limit propagation | `dc198dff`, `6aea3875` | Minimum header/helper changes; final OAuth 1M filter retained, no synthetic session identity |
| Claude free-limit usage/reset | `e571a8b6` | Port management API/UI dependency closure only after auth/proxy/upstream endpoint checks |

The newer per-provider custom-header mechanism (`b3cf3fde`) is not imported wholesale. If a selected change depends on it, preserve the existing override order and port only the necessary boundary or explicitly record the dependency before expanding the write set.

For model removals/routing defaults: verify against the pinned upstream catalog and existing local consumers; distinguish backend-supported metadata from provider availability. Do not broadly reroute every bare GPT model away from OpenAI. Explicit aliases/combos retain precedence.

For context annotations: resolve `(effort)`, `[1m]`, provider prefixes and review suffixes in a defined order; preserve the annotation long enough for Codex context metadata, remove it before upstream dispatch, and do not enable Claude OAuth 1M beta. API-key/compatible-node semantics remain isolated. Review model removal must account for derived variants rather than treating removal of a literal registry row as removal of the API contract.

For headers/tools: union supported beta flags then apply the final auth-type policy; forward a client session identifier only under existing validation/trust rules, never manufacture identity. No CCH generator, synthetic device/account/user ID or default decoys. Tool names, IDs, arguments, forced choices, built-ins and errors remain reversible across streaming and JSON responses.

For refresh: maintain native-driver lease ownership, generation fencing, stale-error protection and reload of the durable winner; upstream latest-token adoption cannot replace these guarantees. Preserve providerSpecificData, connection proxy policy, and sql.js single-process limitation. No destructive live refresh smoke.

For completion: successful streams emit exactly one terminal completion with real usage when available and complete output items; failed/aborted streams preserve local terminal-error semantics rather than reporting false success. Deferred waits are bounded with timer cleanup. Pivot/direct, EOF, cancellation and upstream error paths preserve local in-band abort reporting. No retry after committed output.

### Runtime isolation and smoke contract

- Run smoke with temporary workspace-owned HOME/DATA_DIR, an isolated DB and synthetic credentials; usage/log paths also stay inside the workspace. Do not connect to the user's live accounts, rotate their tokens, or read their normal `~/.9router` state.
- Exercise `/v1/models`, `/v1/chat/completions` and `/v1/responses` through the actual gateway where the existing harness permits. Capture emitted request headers/body and returned SSE/JSON against deterministic mock responses.
- Fixed provider endpoints and Devin's DNS protections are not bypassed just to point them at loopback. Use an existing injected fetch/transport seam to observe real executor behavior while retaining normal URL construction and validation. If a gateway-wide transport seam is unavailable, pair real local API smoke for routing/metadata with an isolated real-executor transport smoke and report that coverage boundary explicitly.
- Cover Antigravity host fallback and Devin cold discovery/family UID resolution, not only the two upgraded providers. Reset UI changes require visual interaction proof; unauthenticated state-changing reset requests must fail without contacting upstream.

### Protected invariants

| Provider/boundary | Must preserve |
|---|---|
| Antigravity dedicated paths | Wire IDs/thinking mapping, daily → sandbox → prod failover including 403/404, version discovery/fallback, labels/envelope, thought signatures, existing sanitizer/obfuscation, onboarding/usage behavior |
| Devin dedicated paths | OAuth/session protocol, Connect/protobuf CHAT, logical aliases/family/effort → wire UID, router assignment, routed-member parallel-tool/token metadata, signature roundtrip, hedged requests and in-band errors |
| Devin catalog | Connection/endpoint isolation, static floor, lazy discovery, warm cache, TTL/SWR, deduplication, request-pinned snapshots, epoch/generation fence, invalidation routes and mixed signal-less/cancelled waiter semantics |
| Shared metadata | Existing `ag`/`antigravity` and `dv`/`devin` model lists, capabilities, prices, effort levels, alias resolution and provider categories unchanged |
| Shared routing/stream/auth | Request-scoped 4xx classification, account/model-scoped fallback, provider restrictions, no fallback after stream output; providerSpecificData and proxy policy retained |
| Shared constants | Keep Antigravity sandbox/prod exports and import closure; keep Claude OAuth beta policy until every consumer is intentionally migrated |
| Security | No remote-image URL fallback on failed Codex prefetch; no proxy bypass, secret leakage, fake attestation or broader OAuth scope |

## Critical files and ownership

Planning owner: Pi. Workers report receipts and never edit this work record. No concurrent overlapping writes.

### Protected path manifest

The named-provider file inventory was verified with `glob`. Freeze these paths and existing matching tests before implementation; extend the manifest with any dedicated dependency discovered by Wave 0.

- Antigravity: `open-sse/executors/antigravity.js`; `open-sse/providers/registry/antigravity.js`; `open-sse/utils/antigravityVersion.js`; `open-sse/services/usage/antigravity-weekly.js`; `open-sse/handlers/imageProviders/antigravity.js`; `open-sse/translator/response/openai-to-antigravity.js`; `open-sse/translator/request/antigravity-to-openai.js`; `src/sse/services/antigravityQuota.js`; `src/mitm/antigravityIdeVersion.js`; `src/mitm/handlers/antigravity.js`; `src/lib/oauth/services/antigravity.js`; `src/lib/oauth/providers/antigravity.js`; existing `src/app/api/cli-tools/antigravity-mitm/` files.
- Devin: `open-sse/executors/devin.js`; `open-sse/providers/registry/devin.js`; `open-sse/utils/devinProtobuf.js`; `open-sse/services/devinCatalog.js`; `open-sse/services/devinModels.js`; `open-sse/services/devinFamilies.js`; `open-sse/services/usage/devin.js`; `src/lib/oauth/providers/devin.js`; `src/lib/db/migrations/002-remove-devin-cli-connections.js`.
- Preserve the existing Devin invalidation wiring in `src/app/api/providers/[id]/route.js` and provider-node bulk deletion, plus the dynamic discovery path `src/app/api/providers/[id]/models/route.js`; their existing ownership is established by the delivered catalog record. Wave 0 expands the exact bulk-delete path and captures all affected functions.
- Existing `tests/unit/*antigravity*.test.js` and `tests/unit/*devin*.test.js` remain unchanged unless an approved necessary shared-contract change proves an expectation obsolete; never weaken them to conceal an upgrade regression.
- Shared files are not byte-frozen: `open-sse/translator/request/openai-to-gemini.js`, provider model/capability/thinking/pricing tables, stream/translator entrypoints, refresh/account fallback and shared constants. Their protected AG/DV branches and caller behavior are frozen instead, verified by AC-03/04/10.

Local anchors from delivered records: Antigravity protections `2026-09-24-merge-upstream-0.5.86.md:40-55`; Devin cache/epoch/waiter repairs `2026-09-25-devin-shared-catalog.md:146-151`; Claude header/tool/lease policy `2026-09-17-anthropic-provider-improvement.md:179-213,238-245`; Codex proxy/image preservation `2026-09-23-codex-upstream-sync.md:13-16,60`.

| Slice | Paths/boundary | Owner |
|---|---|---|
| Protected baseline | Exact discovered Antigravity/Devin executors, registry, OAuth, services, protobuf, MITM/version, invalidation routes and tests | Integration owner captures; workers read-only |
| Codex-local behavior | `open-sse/executors/codex.js`, `open-sse/providers/registry/codex.js`, relevant Codex tests | Codex worker |
| Claude-local translation | `open-sse/utils/claudeCloaking.js`, `open-sse/translator/formats/claude.js`, relevant Claude tests | Claude worker |
| Shared metadata/header/routing | `open-sse/providers/{shared,capabilities,thinkingLevels,pricing}.js`, `open-sse/config/providerModels.js`, `open-sse/services/model.js`, required model-marker/helper changes, `open-sse/executors/default.js` | Integration owner only |
| Shared lifecycle | `open-sse/translator/index.js`, `open-sse/translator/response/openai-responses.js`, `open-sse/utils/stream.js`, `chatCore` and app chat handlers, upstream-header/error helpers | Stream/integration worker; after metadata contract locked |
| Auth/usage | App/core token-refresh services, existing usage route/service, Claude reset management API/UI if selected by source inventory | Auth/usage worker; no concurrent shared-handler edits |
| Verification/docs | Test runner, one consolidated implementation reviewer, targeted existing docs and changelog | Main owns acceptance and docs |

### Wave DAG and write boundaries

- **Wave 0:** pin source, record user changes, protect paths/shared contracts, run baseline focus checks and capture runtime fixtures.
- **Wave 1:** Codex-local and Claude-local slices may run in parallel (two workers); integration owner serializes shared metadata/header changes. Claude and integration work must not write the same tests. Lock each worker's exact write set before dispatch.
- **Wave 2:** shared response/request lifecycle and auth/usage slices may run concurrently only if their enumerated write sets are disjoint. Shared app chat handlers remain with the stream owner. Auth/usage requires the header/proxy contract from Wave 1.
- **Wave 3:** reconcile integration; final verification and actual API/UI smoke; one consolidated code review; one repair pass if needed followed by affected verification. No review of this Markdown plan.

Create a short JIT wave blueprint in this record before each implementation wave: exact upstream commits, write set, inputs/outputs, protected consumers, tests and dependencies. At most three active workers; no build/lint/test/formatter runs during concurrent mutations. Test-runner executes checks at stable boundaries.

### JIT execution blueprint — Waves 1 and 2

Baseline completed before mutation. Three disjoint workers execute provider-local and lifecycle/auth slices; shared-file ownership is explicitly tightened from the preliminary table:

- **A / CodexMetadata (T-02, T-04):** Codex executor/registry; shared capabilities, pricing, thinking levels, providerModels and model resolution; only needed model-marker/helper changes. A also integrates Claude Sonnet metadata rows. A does NOT edit `providers/shared.js`, Claude registry/format, app chat or stream code.
- **B / ClaudeUpgrade (T-03, Claude part T-04/T-06):** Claude registry/format/cloaking; `providers/shared.js` and default executor headers; `utils/upstreamHeaders.js`; Claude usage service/aggregator, authenticated reset route, ProviderLimits UI. B does NOT edit translator/index, stream/chat/error utilities, tokenRefresh or existing connection-usage route.
- **C / LifecycleAuth (T-05, refresh part T-06):** translator/index and Responses response translator, stream utility, chatCore and streaming/nonstreaming handlers, app chat/header plumbing, error utility, app/core refresh services and existing connection-usage route. C does NOT edit B's helper, headers, Claude format/usage/UI, or A's metadata.
- B tells C the exact pinned upstream response-header helper exports and Claude request-cleanup helper contract before dependent edits. Preserve actual upstream helper names where possible; no speculative new header abstraction. C handles both Claude source-format/prefill registration and Responses terminal state in translator/index.
- A owns Codex/model/thinking/capability tests; B owns Claude format/header/tool/cache/reset tests; C owns Responses/stream/refresh and source-format/prefill integration tests. No worker edits protected AG/DV tests or source paths.
- Source refs stay `5013ab04` / `a99cf572`; no mid-flight fetch or unrelated patches. Worker pre-edit closure uses pinned diffs and graph/LSP references. No build/lint/test/formatter during mutations; verification runs through test-runner after all writers finish.
- Reset contract is verified by B before adding its route; it must use existing authenticated management boundary, fixed upstream endpoints, validated org identity and connection-scoped proxy. Local state/credentials stay untouched.

## Verification

Acceptance is separate from completing implementation tasks. The final acceptance ledger records the observed results for all criteria below; intermediate receipts remain preserved as execution history.

| AC | Observable acceptance | Check |
|---|---|---|
| AC-01 | Change set contains only planned Codex/Claude dependency closure; user edits preserved | Pinned refs, initial status/path manifest, final scoped impact receipt; no unrelated modifications |
| AC-02 | Dedicated Antigravity/Devin files unchanged | Before/after manifest hashes; any difference blocks acceptance |
| AC-03 | Antigravity behavior unchanged through modified shared paths | Focus suites plus deterministic gateway/real-executor smoke with mock upstream observing wire model, host fallback, labels and version |
| AC-04 | Devin catalog/protocol/routing behavior unchanged | All relevant Devin suites; deterministic cold/warm catalog → executor wire UID smoke, hedged/member metadata and cancellation boundaries |
| AC-05 | Codex catalog, bare/explicit routing, context/review/effort handling and Lite/web-search request contract correct | Model/routing/executor focus checks; local API mock observes emitted body/headers/wire ID and advertised metadata |
| AC-06 | Claude adaptive thinking/cleanup/cache/tool mapping correct without restoring fabricated identity or decoys | Claude focus checks; mock sees source-specific prefill, tool results/cache markers and reversible output names |
| AC-07 | Headers obey auth type and trust scope | OAuth still omits 1M beta even after client merge; API-key/compatible-node behavior unchanged; session/rate-limit headers do not leak cross-provider |
| AC-08 | Refresh rotation safe; egress and metadata preserved | Lease/CAS/stale refresh/proxy/image focus checks; isolated test DB and mock rotation, no live credentials |
| AC-09 | Response lifecycle correct and bounded | Direct/pivot/usage-only/EOF/error/cancel/watchdog scenarios: one successful completion or correct terminal error, real usage, output preserved, no leaked timer or post-output retry |
| AC-10 | Metadata baseline differences confined to selected providers | Provider/alias/OAuth baseline verifiers; validate proposed baseline delta before regeneration; AG/DV unchanged |
| AC-11 | No new failures relative to captured current baseline | Full credential-free Vitest verification through test-runner + repository non-regression comparator, focused build/lint and gateway smoke |
| AC-12 | Claude quota/reset feature respects management security and preserves inference isolation | Existing auth/middleware, trusted fixed URL/org identifier, connection-scoped proxy, denied unauthorized calls, bounded errors; actual UI/API smoke if surface changes |
| AC-13 | Consolidated code review has no unresolved blocking defect | One post-implementation reviewer receipt, consolidated repair closure and affected re-verification |

### Planned commands and scenario groups

Commands below are planned, not executed. Run from `tests/` unless explicitly marked repository root; `test-runner` records exact commands/exit codes and failure anchors. Capture pre-change and post-change results separately. Inspect the comparator CLI at T-01 before execution; the receipt reports a positional JSON input.

1. **Protected providers (AC-02..04):** `npx vitest run unit/*antigravity*.test.js unit/*devin*.test.js`. Also run existing signature/Gemini integration checks if Wave 0's caller closure includes them. Existing named suites cover Antigravity failover/version/labels/envelope/schema/usage and Devin catalog/invalidation/executor/protobuf/DNS/OAuth.
2. **Codex/stream/security (AC-05/08/09):** `npx vitest run unit/codex-auto-review-routing.test.js unit/codex-image-policy.test.js unit/codex-account-headers.test.js unit/refresh-egress-codex.test.js unit/openai-responses-usage-completed.test.js unit/openai-responses-empty-toolcalls.test.js unit/responses-abort-terminal.test.js`; add relevant existing `codex-*`, `openai-responses-*`, lease/generation and thinking-level suites after exact discovery.
3. **Claude policy/translation (AC-06/07/12):** `npx vitest run unit/claude-cloaking.test.js unit/claude-header-forwarding.test.js unit/refresh-egress-claude-oauth.test.js translator/claude-claude-stream-decloak.test.js unit/model-context-marker.test.js`; extend with capability/cache/refusal/prefill/upload and quota tests from the pinned feature set.
4. **New upstream regression cases:** port/adapt behavior tests for GPT-6 Lite/catalog routing, Sonnet adaptive thinking, trailing-user/source-format cleanup, final-tool cache, completion usage/pivot/watchdog and reset grants. Do not import tests that enforce fake identities, incidental defaults or source-text pinning. Add permanent tests only for plausible consumer-visible edge cases.
5. **Current/full baseline (AC-11):** `npx vitest run --reporter=json --outputFile=upgrade-before.json`, then `node __baseline__/verify-no-regression.mjs upgrade-before.json`; repeat with `upgrade-after.json` after implementation and compare changed-path failures against the captured before results. Run the comparator even when Vitest exits nonzero. Disable/skip credential-dependent real-provider tests through the existing suite configuration; no live account calls.
6. **Metadata baseline (AC-10):** `node __baseline__/verify-providers.mjs`; `node __baseline__/verify-alias.mjs`; `node __baseline__/verify-oauth-urls.mjs`. Existing filenames were verified on disk. Inspect and approve expected Codex/Claude deltas before any snapshot update; AG/DV entries must be identical.
7. **Build/lint:** repository-root `npm run build`; repository-root `npx eslint` with the exact changed JS-file list locked at T-01. Separate pre-existing failures from regressions, and use the isolated runtime environment described above.
8. **Actual smoke:** local gateway `/v1/models`, chat and Responses; observe emitted model/header/body and terminal usage/output via mock transport. Exercise Antigravity fallback, Devin cold/warm routing, Codex image failure and Claude beta/tool policy. If quota UI is changed, open its real dashboard surface and observe authenticated reset interaction plus rejection of unauthorized requests.

Do not claim the old 239-failure baseline is the current baseline without comparison. Baseline snapshot updates must never turn a newly introduced failure into an accepted failure. Live-provider availability remains unverified by deterministic mocks and must be stated as a residual limitation.

## Execution checklist

Planning:
- [x] P-01 — Read completed work records and correct earlier policy assumptions.
- [x] P-02 — Verify current source refs/status and named protected paths; map planned feature sources and preservation risks. Exact transitive hunk closure and reset endpoint security remain explicit T-01 preconditions.
- [x] P-03 — Finalize this blueprint with pinned sources, concrete checks, wave ownership and acceptance gates.

Implementation complete; final acceptance evidence below supersedes intermediate pending/failure receipts:
- [x] T-01 — Wave 0 snapshot and baseline/runtime fixtures; lock shared contracts — AC-01..AC-04, AC-07, AC-10, AC-11. Pre-change tests/build/lint/metadata and protected hashes captured.
- [x] T-02 — Port Codex catalog/identity/Lite/context/search behavior — AC-05, AC-08. Owned dependency closure and behavior tests implemented; final verification recorded at T-07.
- [x] T-03 — Port Claude model/thinking/cleanup/cache/tool behavior — AC-06, AC-07. Implementation and regression cases verified at T-07.
- [x] T-04 — Integrate scoped shared metadata/header/model-resolution changes — AC-01..AC-07, AC-10. Context/review/effort ordering, header contracts and protected metadata verified.
- [x] T-05 — Port response usage/output/completion/watchdog with local abort semantics — AC-03, AC-04, AC-09. Regression cases and lifecycle smoke pass.
- [x] T-06 — Port refresh/usage improvements and secure Claude quota/reset surface — AC-07, AC-08, AC-12. Boundary tests and mocked real-UI interaction verified; native refresh lifecycle retained.
- [x] T-07 — Run final focus/full/baseline/build/lint and actual API/UI smoke via test-runner/runtime tools — AC-01..AC-12. Final comparison: zero new failures; protected hashes/suites and three real-code smokes pass; UI interaction verified with mock responses.
- [x] T-08 — One consolidated implementation review; repair once if necessary and re-verify impact — AC-13 and affected ACs. Six review findings plus observed modal/origin/tool-argument defects closed in the consolidated repair; no re-review.
- [x] T-09 — Record acceptance evidence and residual limitations; deliver without commit/push — AC-01..AC-13. Changelog updated; package versions unchanged; isolated browser/service stopped.

## Evidence and handoff

- User authorized implementation after plan delivery. All implementation and acceptance tasks complete. No merge/cherry-pick, commit or push performed.
- Prior record evidence establishes the deliberate local policies above, not current runtime verification.
- Current source pins verified on disk: local HEAD `5013ab04cf212eae49dc233e8bb43713561017a2`; upstream `a99cf57239ff778b61e434c2786009d5ed1c412c`; merge-base `39e36d3d0c849e0e01dfeacddf111edf892448fc`.
- Command: `git rev-parse HEAD upstream/master && git merge-base HEAD upstream/master && git status --short` — exit 0; no tracked user modifications reported; only this newly created plan is untracked. No fetch during planning; the upstream pin is the currently available local remote-tracking ref, not a freshness claim about GitHub.
- Planning receipts were reconciled against direct Git and path evidence; unsupported claims about static-only review generation and absence of a Claude upstream reset feature are not adopted.
- `git show --stat --oneline e571a8b6` — exit 0; confirms Claude free-limit usage/reset touches registry, usage service, `src/app/dashboard/usage/components/ProviderLimits/index.js`, `src/app/api/usage/[connectionId]/claude-reset/route.js`, and `tests/unit/claude-reset-grants.test.js`. Reset is not the unrelated local CLI-settings reset. Its exact method, authentication/CSRF boundary, fixed upstream URL, org-ID validation and proxy behavior require T-01 verification before porting.
- Named AG/DV files, model-marker module/test and baseline verifier filenames were confirmed by a bounded `glob` inventory. Shared-function anchors are carried by the completed work records; Wave 0 verifies them against current source before edits.
- Remaining implementation evidence: exact Responses Lite prerequisites and context-marker propagation; reset endpoint trust contract; protected baseline hashes; all runtime/test/build/review results. These are mandatory implementation gates, not completed checks.
- Wave 0 evidence: `.tmp/codex-claude-upgrade/protected-sha256.txt` (61 protected entries), `catalog-exports.json`, `prechange/` (122 affected snapshots), and `before-receipt.json`/`upgrade-before.json`; no initial tracked user changes.
- Pre-change protected tests: 396 pass, 6 skip, 0 fail. Codex/Claude/Responses focus: 192 pass, 2 pre-existing failures (`claude-header-forwarding.test.js:32,263`).
- Full pre-change suite: 2961 pass, 226 fail, 24 pending; 203 failures match known-fails and 23 are unmatched pre-existing failures captured in the receipt, plus six suite-load errors. These current results, not the historical 239 figure, define non-regression.
- Pre-change providers (84), alias (117) and OAuth URL verifiers pass; `npm run build` and changed-path `npx eslint --quiet ...` pass. Exact commands/isolation are in `before-receipt.json`.
- T-05 implementation receipt (LifecycleAuth): terminal output snapshots, real-usage/pivot handling, 3-second watchdog/timer cleanup, source-aware Claude prefill, allowlisted rate-limit headers and Codex request-scoped context marker implemented. Added output/usage/prefill/watchdog/pivot behavioral tests; `.tmp/codex-claude-upgrade/lifecycle-smoke.mjs` prepared. Tests/smoke not yet run.
- T-06 refresh portion: usage route reads latest DB connection before refresh; existing lease/CAS/generation/proxy lifecycle retained rather than replaced. Quota/reset portion remains with ClaudeUpgrade.
- Initial Codex worker returned an incomplete slice; ownership transferred exclusively to FinishCodexPort. T-02/T-04 remain pending until complete dependency closure lands and is verified.
- T-03/T-06 implementation receipt (ClaudeUpgrade): Sonnet 5.5 registry and capability-aware format behavior; container uploads, source-aware tail guard, four-slot final-tool caching, missing-map restoration, client beta/session policy and allowlisted response headers; usage reset grants and dashboard redemption. Added `claude-upgrade-behavior.test.js` and `claude-reset-boundary.test.js`; no tests/build/lint/runtime executed yet.
- Reset implementation inspects fixed OAuth profile endpoint, validates organization UUID and posts selected grant to the fixed organization reset URL; connection proxy forwarded. Route requires dashboard JWT and matching Origin and checks Claude OAuth type. Its denial/proxy behavior and UI remain unverified until T-07.
- T-02/T-04 implementation receipt (FinishCodexPort): completed Codex catalog/identity/Lite developer prefix/schema/tool choices, hosted-search fallback, decorated model resolution, accepted effort/context/output limits and pricing. Prepared real-executor/image-policy/protected-metadata smoke at `.tmp/codex-claude-upgrade/codex-executor-smoke.mjs`; no execution results yet.
- Protected smoke completed by LifecycleAuth at `.tmp/codex-claude-upgrade/protected-executor-smoke.mjs`: real Antigravity fixed-host fallback, Devin protobuf cold/warm family routing and Claude OAuth/API-key header policy against deterministic intercepted transport. This is executor-level proof, not live-provider compatibility or a substitute for gateway/UI smoke.
- First post-change verification: 61/61 protected hashes matched; build and lint passed (three warnings). Alias/OAuth metadata unchanged; provider snapshot drift is the planned Codex CLI identity header. Lifecycle smoke passed; Codex/protected executor smokes failed and require production-vs-fixture diagnosis.
- First full verification reported hundreds of new failures, dominated by missing `providerCaps` in `getCapabilitiesForModel`. After/before exclusions and pending counts were not fully comparable; final rerun must use the exact before command. No acceptance claimed from this run.
- Sole consolidated Reviewer receipt (`ReviewSelectiveUpgrade`): P0 missing capability declaration; P1 mismatched Claude thinking/forced-choice capability keys; P2 unreachable auto-search flag and missing legacy Claude orgUrl; P3 dead Lite argument and Sonnet xhigh coercion. All assigned to ConsolidatedUpgradeRepair; no re-review will be invoked.
- Actual browser smoke on the isolated built app located the reset UI at `/dashboard/quota`, rendered grant details, then observed confirmation blocked by the still-open grant modal (`Redeem reset` covered by `div.flex.flex-wrap`). This runtime defect is included in the same consolidated repair. Native screenshot tools timed out; browser interaction/DOM observations are available, but no screenshot proof claimed yet.
- Runtime unauthorized reset and mismatched Origin were rejected (401/403). An authorized synthetic reset produced 500 without a transport mock; do not repeat it or claim successful/live-network-free reset proof. Final success smoke must intercept quota/reset responses, while endpoint security/proxy coverage uses deterministic tests.
- Consolidated repair landed: capability lookup restored; Claude thinking-off/forced-choice schema and xhigh effort aligned; legacy orgUrl restored; dead auto-search trigger/argument removed; Codex proxy refresh and unselected canonical pricing retained; context parsing and grant/confirmation modal layering corrected.
- Reverification (FinalUpgradeVerify): 61/61 protected hashes; protected suites 396 pass/6 skip; Codex, protected-provider and lifecycle real-code mock-transport smokes all exit 0. Build/lint pass; authenticated `/v1/models` returns 200 with 121 items and upgraded Codex plus AG/DV entries; unauthorized reset returns 401.
- Comparable full run: 3000 pass, 223 fail, 24 skip vs before 2961 pass, 226 fail, 24 skip. Six remaining new failures are an obsolete Claude thinking-wrapper snapshot, four obsolete GPT-6 effort-array assertions, and one new multi-tool prefix/schema assertion requiring diagnosis. Same repair owner is closing these without repinning incidental expectations; no acceptance claimed yet.
- Provider verifier drift is confined to the expected Codex CLI headers (`0.159.0` plus version); alias/OAuth URL baselines remain equal. Scoped provider baseline refresh is authorized after validating that exact delta, never known-fails regeneration.
- Graph reconcile after repair: 1264 unchanged, 0 purged, 0 failed.
- Actual rebuilt Quota Tracker smoke: grant details opened, confirmation controls became reachable after layering repair, intercepted reset POST returned 200, quota refetch rendered available reset count 0 and removed the usable-grant button. All usage/reset responses in this success path were browser fixtures, not live provider transactions. Tab closed after proof.
- Additional actual Origin rejection on a valid same-host browser request (Origin/Referer `http://127.0.0.1:21481`, response 403) exposed Next standalone internal-origin mismatch; same repair owner is aligning trusted-origin handling without dropping JWT/CSRF protection. Deterministic route tests must verify this before acceptance.
- Native screenshot and CDP capture timed out; successful browser interaction/DOM state is verified, but no screenshot artifact or live-provider compatibility claim is made.
- Final closure run after the scoped provider snapshot update: all three metadata verifiers exit 0 (84 providers, 117 aliases, OAuth URLs); 61 hashes and protected suites remain green; three executor/lifecycle smokes, build and lint pass.
- Four new assertions still block acceptance: Claude streaming fixture duplicates tool JSON between start/delta events, and three reset-boundary cases need valid JWT/Host fixture and auth/origin-order diagnosis. Same consolidated repair remains open until exact before/after comparison proves zero new failures; no second review or known-fails update.
- `CHANGELOG.md` updated under Unreleased with selected Codex/Claude behavior, quota management and response lifecycle changes. Package versions remain unchanged.
- Guarantee boundary: preserved hashes prove dedicated code retention; shared-path behavior requires focus suites and runtime smoke. No claim of zero runtime regressions before these gates pass.

### Final acceptance ledger

Final receipt: `.tmp/closure-final-receipt.json`; full results: `.tmp/codex-claude-upgrade/closure-final.json`. Earlier failures above are historical observations, not unresolved blockers.

| Acceptance | Final evidence / result |
|---|---|
| AC-01 / AC-02 | Selective ports only; no initial tracked user edits; no destructive Git operations; all 61 protected source/test hashes match. |
| AC-03 / AC-04 | Antigravity/Devin suites: 396 passed, 6 skipped, exit 0. Real executors with mock transport verified fixed-host 403/404 fallback and Devin cold/warm catalog → wire UID; AG/DV metadata projection checks pass. |
| AC-05 / AC-06 / AC-07 | Codex Lite/search/context/review/schema and Claude thinking/tools/cache/header policy covered by final full suite plus real-executor smoke. Three metadata verifiers pass: 84 providers, 117 aliases, OAuth URLs. The provider snapshot update changes only Codex CLI identity headers. |
| AC-08 / AC-09 | Proxy/image/refresh and output/usage/pivot/watchdog/cancellation regression cases covered in final suite; all three Codex/protected/lifecycle smoke commands exit 0. Native refresh lease/CAS/generation protections retained. |
| AC-10 / AC-11 | Exact before/after full-suite comparison: before 2961 pass / 226 fail / 24 skip; after 3003 pass / 217 fail / 24 skip. Zero new failure names. The suite remains non-green because 217 pre-existing failures remain; no known-fails regeneration. Final `npm run build` and lint on all changed JS files exit 0. |
| AC-12 | Reset boundary tests verify signed dashboard JWT, validated Host/public origin, malicious-Origin denial, fixed UUID-scoped upstream URL, provider/OAuth guard and connection proxy. Real gateway authenticated models API returns 200 (121 items), unauthorized reset 401. Real Quota Tracker interaction reaches confirmation and mocked redemption/refetch → zero available grants. |
| AC-13 | One consolidated Reviewer pass; all six findings and runtime-discovered modal/origin/tool-chunk defects repaired and affected/full verification rerun. No unresolved blocking finding. |

Final verification commands include the original local-Vitest full command/exclusions from `before-receipt.json`, protected-provider suites, `sha256sum -c .../protected-sha256.txt`, all three `node --loader .../loader.mjs ...-smoke.mjs` invocations, provider/alias/OAuth verifiers, `npm run build`, and changed-JS ESLint. Exact command/exit/count details are in the final receipt.

Residual limits: live provider availability and real grant consumption are not proved by mock transport; no real account state was changed. Native screenshot capture failed, so UI proof is browser interaction/DOM observations, not a screenshot. Gateway/API smoke covers metadata/auth boundaries; actual provider request behavior is proved separately through real executors/translator with intercepted transport. Browser closed and isolated port 21481 stopped. Throwaway smoke scripts are removed after their evidence is recorded; verification JSON, snapshots and receipts remain workspace-local.


## Assumptions and contingencies

- A planning receipt can establish dependency risks, not prove a safe implementation. Missing evidence blocks the corresponding acceptance criterion, not the entire reachable plan.
- Local policies win when upstream would remove protection. Implement compatibility around them; do not silently replace them.
- If an upstream hunk touches dedicated AG/DV code, split out the Codex/Claude change. If separation is impossible, stop that slice and request an explicit revised scope; preserve other completed work.
- If supported Claude header/reset semantics are unclear, establish the existing trusted-management contract before enabling that feature; do not infer authorization from private-client imitation.
- If a protected shared behavior fails, repair the specific cause or revert only the owned upgrade delta; never erase user edits or roll back their provider commits.
- Rollback is a recorded scoped patch reversal against the initial worktree snapshot; avoid destructive reset/clean. Never replay live rotated credentials from a backup.
- No package release/version bump, commit or push is implied by this plan.
