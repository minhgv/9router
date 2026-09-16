# Anthropic provider improvement

Status: Complete; encryption deferred to separate security release
Owner: Main (Pi)
Created: 2026-09-17
Next action: implement credential encryption only under a separately approved security plan; no commit or push authorized.


## Context

9router's `claude` provider serves Anthropic OAuth/subscription credentials through the Claude translator, `DefaultExecutor`, token refresh service, SQLite connection repository, usage polling, and account fallback. Existing strengths: multi-account routing, model locks, usage caching, refresh deduplication, and stream tool-name restoration.

Objective: supported, truthful, capability-aware Anthropic OAuth compatibility; safe concurrent credential handling; and reliable subscription quota behavior, while preserving account rotation and the OpenAI-compatible API.

Explicit non-goals:
- No evasion of provider enforcement, account restrictions, or prohibited traffic concealment.
- Client imitation, private-source fixture matching, CCH reproduction, first-party version spoofing, or synthetic identity are not authorization evidence.
- No generic Anthropic-compatible-node changes without proof they preserve that contract.
- No broader OAuth scopes or undocumented beta capabilities.
- No routing-engine rewrite or replacement of multi-account fallback.
- No automatic commit or push.

If an authorized, supported subscription-OAuth gateway contract cannot be established, the path must fail explicitly and offer a separately configured supported API-key route; never silently substitute credentials.

## Approach

### Invariants

1. OAuth subscription and API-key credentials have separate capability policies.
2. OAuth does not send 1M-context beta by default; API-key and compatible-node behavior remains unchanged.
3. Headers and capabilities are provider-documented and client identification is truthful; translation does not manufacture identity or attestation.
4. Refresh rotation is safe across requests/processes: stale responses cannot overwrite newer credentials.
5. Usage failures remain separate from inference availability.
6. Tool mapping is bijective across history, forced choice, SSE, and JSON; built-in tools remain untouched.
7. Reset/retry information precedes bounded backoff; provider-wide restrictions are not bypassed through fallback.
8. Existing behavior outside official Anthropic OAuth remains unchanged.

### Wave 1 — Contract and baseline

- Capture current registry, shared policy, request preparation, final executor emission, refresh, usage, fallback, and persistence as bounded fixtures.
- Establish supported authentication routes and SQLite adapter/process-topology semantics before promising guarantees.
- Treat Oh My Pi/private source observations as implementation evidence only, never as proof of Anthropic authorization.
- Define credential capability and truthful request-profile contracts.
- Decide which unsupported fields are omitted. Defer exact CCH reproduction unless an authoritative, authorized contract establishes necessity.

### Wave 2 — Supported request compatibility

Ownership: `open-sse/providers/shared.js`, `open-sse/providers/registry/claude.js`, `open-sse/translator/formats/claude.js`, `open-sse/utils/claudeCloaking.js`, `open-sse/executors/default.js`.

- Apply credential-aware beta gating at the official-provider boundary; exclude 1M-context beta for OAuth.
- Use supported headers/capabilities and truthful identification. Do not mix `cli`/`sdk-cli` profiles.
- Remove fabricated SHA-256 CCH and synthetic identity unless an authoritative supported contract requires them. Do not replace them with another imitation hash.
- Remove default decoy tools. Keep only demonstrably necessary reversible mapping; preserve built-ins, forced choice, history, IDs, arguments, errors, fragmented SSE, and JSON.
- Scope all behavior to official `claude` OAuth. Final emitted headers are owned by `DefaultExecutor`.

### Wave 3 — Refresh concurrency

Ownership: `open-sse/services/tokenRefresh/providers.js`, `open-sse/services/tokenRefresh.js`, `src/lib/db/repos/connectionsRepo.js`, required persistence coordination utility.

- Add durable lease keyed by connection and credential generation, with expiry, fencing, and crash recovery. Network I/O stays outside DB transactions.
- Persist rotated pairs only when owner and generation match; CAS conflicts reload the durable winner.
- Reconnect, administrative updates, and refresh all respect generation checks. Stale `invalid_grant` cannot disable newer credentials.
- Keep in-process deduplication as a fast path, not the cross-process guarantee.
- Credential encryption is a separate security release unless threat model makes it a prerequisite; it requires key custody, backup/WAL/export/cloud-sync coverage, recovery, migration, rotation, and rollback design.

### Wave 4 — Quota and fallback

Ownership: `open-sse/services/usage/claude.js`, `open-sse/services/accountFallback.js`, `open-sse/config/errorConfig.js`, narrow `src/sse/handlers/chat.js` changes.

- Parse `Retry-After` and reset timestamps before bounded exponential backoff.
- Preserve five-hour, seven-day, model-scoped usage, model locks, successful cache, and usage/inference isolation unless evidence requires change.
- Distinguish auth invalid, quota, overload, malformed request, usage failure, and provider-wide restriction.
- Cap attempts; do not retry after streaming output begins; clear only affected account/model state on success.

### Wave 5 — Verification and cleanup

- Run focused checks for headers, beta gating, unsupported fields, tool mapping, lease/CAS races, usage isolation, and reset-aware fallback.
- Run full verification through `test-runner`; compare known failures using repository baseline tooling.
- Run one consolidated Reviewer pass on implementation diffs; repair once if needed and re-verify affected paths.
- Update documentation/changelog only after verification.

## Critical files and ownership

| Wave | Files | Owner | Boundary |
|---|---|---|---|
| 1 | Existing source only | Main/scout | Evidence, supported-route decision, adapter/process contract |
| 2 | Shared/registry/translator/cloaking/**`default.js`** | Request worker | Official OAuth request construction; no private-client imitation |
| 3 | Refresh services + `connectionsRepo.js` | Auth worker | Lease, fencing, CAS, stale-error protection |
| 4 | Usage/fallback/error config/chat handler | Resilience worker | Usage, cooldown, restrictions, account/model health |
| 5 | Checks, docs/changelog, review | Main + test-runner + reviewer | Verification after Waves 2–4 |

Wave 2 and Wave 3 may run in parallel only after Wave 1 locks credential-generation and error contracts. Wave 4 follows those contracts. Encryption is separately planned/released unless explicitly made a prerequisite.

## Verification

| AC | Observable acceptance | Check |
|---|---|---|
| AC-01 | OAuth omits 1M-context beta; API-key/compatible-node contracts and override precedence remain unchanged | Emitted-header assertions by credential type |
| AC-02 | Request profile is supported and truthful; private fixture matching is not treated as authorization | Provenance review plus final `DefaultExecutor` fixture |
| AC-03 | Fabricated CCH/identity fields are absent unless authoritative support requires them | Negative check for old SHA-256 heuristic/synthetic identity |
| AC-04 | Tool mapping handles prefixed names, built-ins, forced choice, history, fragmented SSE, JSON, IDs, arguments, and errors without decoys | Stream/non-stream checks |
| AC-05 | Concurrent refresh cannot overwrite newer pair; stale owner/error cannot win | Lease expiry, fencing, CAS, delayed response, reconnect, DB failure scenarios |
| AC-06 | OAuth is enabled only with supported authorization; otherwise explicit failure without substitution | Auth-route and unsupported-path smoke check |
| AC-07 | Usage 429/error does not disable working inference; good data remains cached | Usage isolation scenario |
| AC-08 | Retry/reset values take precedence; waits/attempts bounded; no retry after committed stream output | Fallback boundary checks |
| AC-09 | Auth, quota, overload, malformed request, usage failure, and provider restriction are separate | Error/state checks |
| AC-10 | Registry, aliases, compatible nodes, and baseline behavior do not regress | Baseline verification |
| AC-11 | No token, raw identity, or decrypted payload appears in logs/errors | Redaction inspection |
| AC-12 | Reviewer finds no blocking defect; repairs have affected verification | Reviewer receipt |

Encryption is a separate release. If retained here, it becomes a prerequisite with explicit key recovery, backup/WAL/export, tamper, migration, missing-key, and minimum-reader checks.

## Execution checklist

- [x] T-01 — Lock supported auth and request contracts — AC-01..AC-06
- [x] T-02 — Capture emitted-header and adapter/process fixtures — AC-01..AC-05
- [x] T-03 — Implement OAuth beta gating and truthful profile — AC-01, AC-02, AC-06
- [x] T-04 — Remove fabricated attestation and default decoys — AC-03, AC-04
- [x] T-05 — Implement refresh lease, fencing, CAS, stale-error protection — AC-05, AC-09
- [x] T-06 — Improve quota parsing and scoped fallback — AC-07..AC-10
- [x] T-07 — Run focused verification and reconcile integration — AC-01..AC-11
- [x] T-08 — Run full verification via test-runner — AC-10
- [x] T-09 — Run one consolidated implementation review — AC-12
- [x] T-10 — Repair reviewed defects and re-verify affected paths — AC-01..AC-12
- [x] T-11 — Update docs/changelog and close handoff evidence — AC-10..AC-12
- [x] T-12 — Specify separate credential-encryption release — security follow-up


## Evidence and handoff

Baseline anchors:

- OAuth: `src/lib/oauth/providers/claude.js:1-60`; `open-sse/providers/registry/claude.js:66-80`.
- Headers/betas: `open-sse/providers/shared.js:23-69`; registry `:20-42`; final emission `open-sse/executors/default.js:149-206`.
- Cloaking: `open-sse/utils/claudeCloaking.js:1-191`; application `open-sse/translator/formats/claude.js:611-618`.
- Refresh: `open-sse/services/tokenRefresh/providers.js:34-141`; callback `open-sse/services/tokenRefresh.js:135-180`.
- Persistence: `src/lib/db/repos/connectionsRepo.js:35-78,214-228`.
- Usage/fallback: `open-sse/services/usage/claude.js:17-143`; `open-sse/services/accountFallback.js:1-125`; `src/sse/handlers/chat.js:240-350`.
- Comparison observations: Oh My Pi `packages/ai/src/providers/anthropic.ts:245-255,648-658,685-755,800-880,930-950`; `packages/ai/src/auth-storage.ts:5495-5560`.

Advisor consultation revised this plan: prioritize supported/truthful compatibility and refresh correctness; defer encryption to a separate security release; do not reproduce undocumented CCH/identity behavior; include `DefaultExecutor` ownership; strengthen race, rollback, and unsupported-path criteria. No application changes or tests have been run.
T-02 receipt — HeaderFixtureScout and AdapterFixtureScout completed read-only fixture capture. No source files changed and no tests ran.

Emitted-header baseline (sensitive values redacted):

- Official `claude` API-key request: `POST https://api.anthropic.com/v1/messages?beta=true`; `x-api-key`; `Anthropic-Version`; dynamic `Anthropic-Beta` with the current 9/11-flag policy; CLI/Stainless headers; `Accept: text/event-stream` for streaming.
- Official `claude` OAuth request: same URL and current beta policy, Bearer `Authorization`, CLI/Stainless headers, plus body-level fabricated billing header, synthetic metadata identity, and 20 decoy tools through the existing cloaking path. This is recorded as current behavior only, not a supported contract.
- `anthropic-compatible-*` third-party request: configured target URL; dual `x-api-key`/Bearer behavior as currently emitted; standard Anthropic version/content/stream headers; official-only CLI/browser/beta fields are filtered for non-Anthropic targets. Compatible nodes do not inherit OAuth subscription policy by default.

Observed precedence:

1. Registry/runtime transport base headers.
2. Runtime auth descriptor, then provider descriptor, then resolved descriptor.
3. Auth injection, with `apiKey` taking precedence over `accessToken` in the split descriptor.
4. `Anthropic-Beta` is dynamically overwritten by `selectAnthropicBeta(model)`.
5. Non-Anthropic compatible-node filtering.
6. Stream mode overrides `Accept` to `text/event-stream`.

Source anchors:

- Header fixtures and precedence: `open-sse/providers/registry/claude.js:18-52`; `open-sse/providers/shared.js:20-65`; `open-sse/executors/default.js:20-38,112-206`.
- OAuth body cloaking and translator hook: `open-sse/utils/claudeCloaking.js:8-192`; `open-sse/translator/index.js:132-146`.
- Adapter selection and schema: `src/lib/db/driver.js:8-67`; `src/lib/db/schema.js:9-17`.
- Native adapter behavior: `src/lib/db/adapters/betterSqliteAdapter.js:1-65`; `src/lib/db/adapters/nodeSqliteAdapter.js:1-84`; `src/lib/db/adapters/bunSqliteAdapter.js:1-65`.
- In-memory fallback limitation: `src/lib/db/adapters/sqljsAdapter.js:1-115`.

Persistence/process contract:

- The fallback chain is `bun:sqlite` on Bun; `better-sqlite3`, then `node:sqlite` on Node; finally `sql.js`.
- Native adapters use synchronous SQLite transactions, WAL, busy timeout, and OS file locking. Atomic conditional SQL updates can support generation/fencing CAS for native-driver deployments.
- `sql.js` keeps an in-memory WASM database and debounced whole-file writes; cross-process lease/CAS is unsafe and must not be advertised. A durable refresh lease must require a native adapter or explicitly constrain the deployment to one process.
- The normal gateway is one Next.js server process; the separate CLI communicates over HTTP and does not directly share the DB. Current in-process refresh deduplication is not a cross-process guarantee.

T-02 unresolved evidence for implementation/review:

- The captured current CLI/Stainless headers, beta flags, body cloaking, and compatible-node behavior are implementation facts, not authoritative Anthropic authorization requirements.
- No authoritative evidence yet establishes the minimum supported OAuth header/capability set or provider-confirmed 1M-context OAuth error contract.
- Native-driver CAS assumptions still need bounded fixture verification, including adapter availability and actual process topology; `sql.js` must remain excluded from multi-process guarantees.
T-03 implementation and verification receipt — `open-sse/providers/shared.js` now exposes the 1M beta constant and credential-aware `selectAnthropicBeta`; `open-sse/executors/default.js` applies the OAuth filter at final header emission. Explicit `credentials.authType` is honored, with legacy inference retained only for callers that omit authType. API-key and compatible-node behavior remains unchanged within this scope. No T-04 cloaking/decoy removal was included.

Focused verification via test-runner:

- Command: `npx vitest run -t "DefaultExecutor.buildHeaders" unit/claude-header-forwarding.test.js && node <smoke-assert-suite>`
- Exit: `0`
- Result: Vitest `17 passed, 0 failed, 3 skipped`; runtime assertions `5/5 passed`; failures: none.
- Covered: OAuth 1M-beta exclusion, caller/runtime override filtering, implicit and explicit OAuth auth type, API-key beta preservation, and official/third-party compatible-node behavior.
- No project-wide suite, formatter, or linter run.

Anchors after implementation: `open-sse/providers/shared.js:51-74`; `open-sse/executors/default.js:185-263`.
T-04 implementation and verification receipt — Removed fabricated billing/CCH generation, synthetic device/account/session identity generation, and default Claude Code decoy tools. Removed the obsolete cloaking wrapper and its translator invocation. Retained only minimal reversible tool-name mapping for actual client tools, preserving built-in server tools, forced tool choice, tool-use history, IDs, arguments, errors, fragmented SSE names, and non-streaming JSON names. API-key, compatible-node, and non-OAuth paths were preserved within scope.

Changed files:

- `open-sse/config/appConstants.js`: removed Claude default decoy set.
- `open-sse/utils/claudeCloaking.js`: removed fabricated attestation/identity and decoy injection; retained reversible mapping and stream/non-stream decloaking.
- `open-sse/translator/formats/claude.js`: removed obsolete cloaking wrapper invocation/imports.
- `open-sse/translator/index.js`: updated OAuth tool-mapping path/comments.
- `tests/unit/claude-cloaking.test.js`: removed obsolete attestation expectation and asserted no decoy injection.

Focused verification via test-runner:

- Command: `npx vitest run unit/claude-cloaking.test.js translator/claude-claude-stream-decloak.test.js`
- Exit: `0`; `16 passed, 0 failed, 0 skipped`; failures: none.
- No project-wide suite, formatter, or linter run.
T-01 receipt — ContractScout completed a read-only end-to-end inspection. No source files changed and no tests ran.

Locked contract decisions:

- Official `claude` is the OAuth provider boundary; its auth descriptor distinguishes `x-api-key` API-key requests from Bearer OAuth requests. `anthropic-compatible-*` nodes remain isolated and do not inherit OAuth subscription behavior by default.
- Beta selection must be credential-aware at final header emission. OAuth subscription requests exclude 1M-context beta by default and do not gain undocumented capabilities; API-key and compatible-node contracts remain unchanged.
- Client identification must be truthful. Remove fabricated SHA-256 CCH, synthetic device/account/user identity, and default decoy tools unless an authoritative supported contract later requires a specific field. A private Oh My Pi fixture is not authorization evidence.
- Tool translation remains a minimal reversible mapping boundary: preserve built-ins, prefixes, forced choices, history, errors, IDs, arguments, fragmented SSE, and JSON responses without adding fake tools.
- Auth type propagates explicitly as `credentials.authType` (`oauth`/`apikey`); OAuth detection must not depend on `sk-ant-oat` token substring matching.

Source anchors:

- Provider/auth configuration: `open-sse/providers/registry/claude.js:20-43,66-80`; runtime credential fields: `src/sse/services/auth.js:210-235`.
- Shared beta policy: `open-sse/providers/shared.js:31-69`; final beta/header emission and compatible-node filtering: `open-sse/executors/default.js:143-206`.
- Fabricated billing/identity and decoys: `open-sse/utils/claudeCloaking.js:8-30,41-80,124-150,165-192`.
- Translator credential handoff and OAuth cloaking hook: `open-sse/translator/index.js:132-146`.
- Connection auth-type persistence/deduplication: `src/lib/db/repos/connectionsRepo.js:38-60,130-170`.

Evidence still required in T-02:

- Authoritative minimum header/capability contract for official Anthropic OAuth versus API key; current private-source observations cannot establish it.
- Provider-confirmed behavior/error code for 1M-context beta on subscription OAuth.
- Durable lease/CAS semantics across every enabled SQLite adapter and actual multi-process topology.

## Assumptions and contingencies

- Upstream private behavior may change; local fixtures do not establish support or authorization.
- Cross-process guarantees require verification on every enabled SQLite adapter; unsupported topologies must be rejected or constrained.
- Lease/CAS cannot eliminate the external refresh rotation crash gap; reauthentication recovery must be documented.
- Encryption remains an exposure until its separate release; it must cover backups, WAL, exports, and sync.
- Existing known failures remain baseline unless the changed path moves them.
- Main is sole writer of this record; workers return receipts only.

Final implementation and verification receipt:

- T-05 refresh correctness: native adapters expose cross-process lease capability; refresh acquisition is generation/owner fenced; rotated credentials use conditional persistence; stale refresh responses and invalid-grant errors cannot overwrite or disable newer credentials; network I/O remains outside SQLite transactions. sql.js remains explicitly single-process only. Changed refresh/DB paths include `src/lib/db/repos/connectionsRepo.js`, `src/lib/db/driver.js`, SQLite adapters, `open-sse/services/tokenRefresh/providers.js`, `open-sse/services/tokenRefresh.js`, and `src/sse/services/tokenRefresh.js`.
- T-06 resilience: Retry-After and reset values are parsed and bounded before backoff; 402 fixed monthly lock behavior and 404 model-coverage fallback were restored; usage failures do not disable inference; stream fallback does not retry after committed output; inference/account/model scopes remain bounded. Changed paths include `open-sse/config/errorConfig.js`, `open-sse/services/accountFallback.js`, `open-sse/services/usage/claude.js`, and `src/sse/handlers/chat.js`.
- Review repair: consolidated review identified two real regressions plus six hygiene/coverage defects. One repair pass corrected all eight; the stale permanent-refresh assertion now matches the typed error contract and transient null behavior remains covered.
- Focused final verification: `67 passed, 0 failed, 0 skipped`; GitHub 402 lock `3/3`; token refresh typed-error contract `64/64`; exit `0`.
- Full final verification: `2503 passed, 239 failed`, all 239 failures matched the committed known-fail baseline, `59 skipped`, `0` changed-path regressions. Exit `1` is expected because the repository baseline remains red.
- Baseline verifiers: providers `82` equal, aliases `117` equal, OAuth URLs equal; all exit `0`.
- SOT reconcile after implementation: `22 unchanged, 0 purged, 0 failed` before final repair; final verification covered the repaired source paths.

Separate credential-encryption release specification:

- Scope: encrypt OAuth access/refresh tokens and other provider secrets at rest; no plaintext compatibility fallback.
- Required design gates: key custody and derivation, rotation, missing-key and tamper behavior, migration and rollback, SQLite WAL/backups/exports/cloud-sync coverage, log/error redaction, and minimum-reader compatibility.
- Release boundary: encryption is not part of this provider compatibility wave and must receive its own threat model, migration fixture, recovery procedure, focused tests, review, and explicit approval before implementation.
- Current risk: credentials remain protected by existing filesystem/DB access controls but are not encrypted at rest; do not claim AC-11 encryption coverage.
