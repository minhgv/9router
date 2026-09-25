# Devin shared catalog — close discovery→executor gap (advisor P1)

Status: delivered (all tasks complete; reviewer repair pass applied + verified)
Work ID: 2026-09-25-devin-shared-catalog
Parent: docs/plans/2026-09-25-devin-variant-collapse.md (delivered, commit d16e284)

## Context

Advisor consultation verdict: the static-table-only routing leaves an architectural gap — the app advertises logical ids (via dynamic discovery collapse) that the executor cannot route when the family is absent from the static registry. Recommended fix (option d): a shared connection-scoped in-memory catalog service under `open-sse/services`, lazy-loaded by the executor, static registry as floor, atomic per-family replacement, raw-member metadata preserved. No SQLite.

Residual issues addressed here:
- P1: discovery→executor gap + hand-maintained `swe-2` (same root cause).
- P3: `collapseDevinFamilies` test-seam wrapper → tests moved to `parseDevinModelConfigs`, wrapper removed.
- P2: `claude.headers` baseline drift — confirmed INTENTIONAL (`13ed1456` templated UA `claude-cli/${CLAUDE_CLI_VERSION}`; bump in `cbffeb97` Opus 5.5). Regenerate `providers-baseline.json` in a separate `chore(tests)` commit.
- `inkling` contextWindow: `contextLength` is display-only (models API route.js:156/352/435; no consumer in chatCore/chat.js) → keep 262000 estimate, comment already flags it. No action.

Advisor-flagged risks folded into design:
- Missing-default routing: `resolveWireUid` must never emit a synthetic logical id — deterministic fallback chain.
- Raw-member metadata loss: snapshot carries BOTH logical families AND raw member map (executor needs `supportsParallelToolCalls`/`maxOutputTokens`/`modelRouter` of the routed member).
- Account/endpoint scope: cache key = `connectionId` (or token-hash + baseUrl); never log key material.
- Freshness: TTL + stale-while-revalidate; discovery failure keeps last-known-good; older refresh must not overwrite newer snapshot (generation counter).

Non-goals: no SQLite persistence; no thinkingLevels/capabilities dynamism (static policy tables stay — documented limitation: a server-only NEW tier name may clamp before executor; acceptable since wire uid routing still works for known tiers); no cross-process cache sharing.

## Approach

### New module: `open-sse/services/devinCatalog.js`

```js
// Snapshot (immutable, pinned per request incl. hedged payloads):
{ families: Map<logicalId, {id,name,members,routing,defaultMember?,defaultLevel?,efforts,requiresEffort}>,
  members:  Map<rawUid, modelEntry>,          // raw discovered entries incl. family members
  fetchedAt: number, generation: number }

// API:
getDevinCatalogSnapshot(credentials, { proxyOptions, fetchFn }) → Promise<snapshot|null>
  // null → caller falls back to static registry
invalidateDevinCatalog(connectionIdOrKey) → void   // credential/endpoint change; called from PUT/DELETE /api/providers/[id] for devin connections
```

- Cache key: `credentials.connectionId` when present; else `sha256(normalizeDevinSessionToken(token)).slice(0,16) + "|" + baseUrl` — no plaintext token in key, never logged.
- Cold path: bounded lazy discovery — `fetchDevinCliModelConfigs` with `AbortSignal.timeout(5000)` raced against caller signal; dedupe via in-flight Map<key, Promise>.
- Warm path: TTL 10 min; stale snapshot served while revalidating in background (non-blocking); generation counter rejects out-of-order publishes.
- Failure: keep last-known-good; if none, return null → static fallback → raw passthrough (unchanged failure mode).
- Snapshot construction: `parseDevinModelConfigs` output split — collapsed logical entries → `families` (atomic replace per family id over the static floor); ALL raw discovered entries (pre-collapse, incl. members) → `members`. Static registry supplies the floor for both maps.

### Executor changes (`open-sse/executors/devin.js`)

- `execute()`: `const snapshot = await getDevinCatalogSnapshot(credentials, { proxyOptions })` once per request (before retry loop — retries reuse the pinned snapshot).
- `resolveModelMeta(wireModel, snapshot)`: `snapshot.members.get(id) ?? snapshot.families.get(id) ?? static` (static = current `getProviderModels("dv")` lookup).
- `resolveWireUid` fallback chain (fix missing-default): `routing[effort]` → nearest-ladder clamp → `defaultMember` → first member in routing values → `members[0]` → `meta.id`. Never emits bare logical id when routing exists.
- `routedMeta` = `resolveModelMeta(wireUid, snapshot)` — same snapshot for single + hedged paths.
- Router path unchanged: `isRouterModel` check on resolved meta (snapshot-aware so a discovered router entry still works).

### Discovery route (`devinModels.js`)

- `resolveDevinModels` publishes its result into the catalog (warm the cache for the same connection) — dashboard fetch doubles as refresh. Keep return shape unchanged.
- Refactor: expose `parseDevinModelConfigs` split output (logical + raw members) or a `buildDevinCatalogSnapshot(decoded)` helper in devinCatalog.js that calls the existing parse + lane collector.

### Invalidation wiring (`src/app/api/providers/[id]/route.js`)

- PUT: after `updateProviderConnection` succeeds, if `existing.provider === "dv"` (or updated provider is dv) → `invalidateDevinCatalog(id)`. Unconditional for devin connections — cheap Map.delete; avoids diffing token/baseUrl fields.
- DELETE: after `deleteProviderConnection` succeeds → `invalidateDevinCatalog(id)` (guard by connection.provider === "dv" before delete, or call unconditionally — key is a no-op for non-devin ids).
- TTL+SWR remains the staleness bound for changes made outside this route (e.g. direct DB edits); wiring covers the UI/API path only.

### Test-seam cleanup

- Move the 5 `collapseDevinFamilies` tests in `devin-models-usage.test.js` onto `parseDevinModelConfigs` (production path, includes CHAT filter); delete the wrapper from `devinFamilies.js`.

### Baseline chore (separate commit)

- `node tests/__baseline__/snapshot-providers.mjs` (or whatever the generator is — verify filename) → regenerate `providers-baseline.json`; confirm ONLY claude.headers UA diff lands; commit as `chore(tests): regenerate providers baseline for claude UA 2.1.280`.

## Critical files and ownership

| File | Worker | Change |
|---|---|---|
| `open-sse/services/devinCatalog.js` (new) | W1 | cache, snapshot build, lazy load, TTL, dedupe, generation |
| `open-sse/services/devinModels.js` | W1 | publish to catalog; export raw-member list for snapshot |
| `open-sse/services/devinFamilies.js` | W1 | remove `collapseDevinFamilies` wrapper |
| `tests/unit/devin-catalog.test.js` (new) | W1 | cache/TTL/dedupe/scope/failure tests |
| `tests/unit/devin-models-usage.test.js` | W1 | move wrapper tests to parse path |
| `open-sse/executors/devin.js` | W2 | snapshot pin, resolveModelMeta(snapshot), resolveWireUid fallback chain |
| `tests/unit/devin-executor.test.js` | W2 | snapshot routing tests, missing-default, cold-path, account-scope |
| `tests/__baseline__/providers-baseline.json` | main | regenerate (separate commit) |
| `src/app/api/providers/[id]/route.js` | main | wire `invalidateDevinCatalog` on PUT/DELETE |
| `docs/DEVIN.md` | main | document catalog layer, TTL/SWR, fallback chain |

W1 ∥ W2 with locked contract (snapshot shape + `getDevinCatalogSnapshot` signature above). W2 mocks the catalog module in tests.

## Verification

- AC-01: cold executor request (no prior dashboard fetch) with mocked discovery → logical id `new-family` routes to discovered sibling uid; discovery failure → static/passthrough.
- AC-02: two connections (different connectionId) get isolated snapshots; no cross-account routing.
- AC-03: concurrent cold requests dedupe to ONE upstream discovery call.
- AC-04: TTL expiry → stale served + background refresh; failed refresh keeps last-known-good; older generation never overwrites newer.
- AC-05: family without `defaultMember` → deterministic fallback (first routed member), never bare logical id on wire.
- AC-06: routed member absent from static registry but present in discovery → `disableParallelToolCalls`/`maxTokens` from discovered member meta.
- AC-07: hedged path pins same snapshot; all payloads carry routed uid.
- AC-08: `resolveDevinModels` warms cache — subsequent executor call makes no upstream discovery fetch.
- AC-09: `collapseDevinFamilies` removed; its tests pass against `parseDevinModelConfigs`.
- AC-11: `npx vitest run unit/devin-*.test.js` green; eslint clean on touched files.
- AC-12: PUT (credential/baseUrl change) or DELETE on a devin connection → `invalidateDevinCatalog(id)` invoked; next executor call refetches.

## Execution checklist

- [x] T-01 (W1→AC-01,03,04,08): `devinCatalog.js` — snapshot build (families+members maps over static floor), connection-scoped cache, lazy bounded fetch, in-flight dedupe, TTL+SWR, generation guard, invalidate API; `resolveDevinModels` publishes. → W1Catalog.
- [x] T-02 (W1→AC-09): remove `collapseDevinFamilies`; port its 5 tests to `parseDevinModelConfigs`. → ported to `parseDevinModelConfigsSplit().families`.
- [x] T-03 (W2→AC-01,05,06,07): executor — pin snapshot per request, snapshot-aware `resolveModelMeta`, `resolveWireUid` deterministic fallback chain, routedMeta from snapshot. → W2Executor; sibling test files pinned catalog mock.
- [x] T-04 (main→AC-10): regenerate providers baseline, verify diff scope, separate `chore(tests)` commit. → done, commit `e3c9a2b7` (claude UA 2.1.280 only).
- [x] T-05 (main→AC-11): focused vitest + eslint via test-runner; consolidated reviewer pass on the diff. → 211 tests green, eslint clean; reviewer found 1 blocker (fixed).
- [x] T-06 (main→AC-12): wire `invalidateDevinCatalog` into PUT/DELETE `/api/providers/[id]` for devin connections. → also wired provider-nodes bulk delete; route tests in devin-catalog-invalidation.test.js.
- [x] T-07 (main): update `docs/DEVIN.md` — catalog layer, cache key scope, TTL/SWR, resolveWireUid fallback chain.
- [x] T-08 (repair): reviewer blocker — epoch-fence publishes vs invalidation (keyEpochs in devinCatalog.js; baseEpoch forwarded from resolveDevinModels pre-fetch); joinDiscovery listener detach; AC-12 route test.
- [x] T-09 (repair): post-delivery nit — signal-less waiters counted in `startDiscovery` (`unboundedWaiters`); `joinDiscovery` prunes waiter membership on ANY settlement (single `onAbort`, abort path calls `abortWhenUnwatched` after self-prune). Regression test `c-mixed-waiters` proven fail-before/pass-after.

## Edge-case test matrix

Catalog (T-01):
1. Cold fetch success → snapshot has families + members; executor-usable.
2. Cold fetch failure, no prior snapshot → null → static fallback.
3. Cold fetch failure WITH prior snapshot → last-known-good returned.
4. Concurrent cold calls → single upstream fetch (in-flight dedupe).
5. TTL fresh → no fetch; stale → serve + background revalidate.
6. Refresh returns older generation → rejected (no overwrite).
7. Cache key: same token different connectionId → separate snapshots; different baseUrl → separate.
8. Token never appears in cache key/logs (assert key format).
9. `invalidateDevinCatalog` → next call refetches.
10. Discovery returning empty/invalid configs → snapshot still valid (static floor only).
11. Caller abort signal → fetch aborted, null returned, no cache poisoning.

Executor (T-03):
12. Logical id known only via snapshot (not in static registry) → routed to sibling uid.
13. Family without defaultMember → first routed member; never bare logical id.
14. Routed member meta from snapshot.members (not static) — `disableParallelToolCalls` honored.
15. Snapshot pinned across retry attempts and hedged payloads.
16. Snapshot null → identical behavior to today (static table).
17. Router model discovered dynamically → AssignModel path still taken.
18. `resolveDevinModels` warm → executor skips fetch (AC-08).

Cleanup (T-02):
19. The 5 moved tests assert identical collapse behavior via `parseDevinModelConfigs` (incl. CHAT filter on fixtures).

## Evidence and handoff

- T-04: `git show e3c9a2b7` — providers-baseline.json regenerated; diff scope = claude.headers UA → 2.1.280 only; alias/oauth baselines untouched. Committed as `chore(tests)`.
- T-01/T-02 (W1Catalog): devin-catalog.test.js 18 tests + devin-models-usage.test.js 29 — green; AC-01/03/04/08/09. Extra exports: `buildDevinCatalogSnapshot`, `warmDevinCatalog`, `getDevinCatalogEpoch`. Members floor = all static entries; family-id routing-coherence stamp keeps members-first lookup on fresh routing.
- T-03 (W2Executor): devin-executor.test.js 75/75; six-suite sweep 154/154; AC-01/05/06/07. Deviation: snapshot family `routing` → `effortRouting` shallow-copy normalization in resolveModelMeta (locked shape uses `routing`). Sibling test files (contracts, dns-security) pinned catalog mock after real module landed.
- T-05 (TRVerify/TRVerify2): pre-repair 205 green + eslint clean; post-repair 211 green (8 files) + eslint clean.
- Review (RevCatalog): overall incorrect → 1 BLOCKER (invalidation didn't fence in-flight publishes — orphan cold discovery could re-poison cache post-invalidate and reject the fresh refresh), 2 nits (joinDiscovery listener leak; AC-12 untested). Repair pass (RepairEpoch): keyEpochs fence + epoch forwarded from resolveDevinModels pre-fetch + listener detach + 4 route tests + 2 fence regression tests — both proven fail-before/pass-after. Per-AC: all PASS.
- T-09 (post-delivery nit): `joinDiscovery` previously left aborted signals in `waiterSignals` and treated signal-less cold callers as non-watchers — a co-waiter's abort could kill the shared fetch under a live signal-less waiter. Fix: `unboundedWaiters` counter + `finish()` prunes membership on any settlement. `tests/unit/devin-catalog.test.js` now 19 tests; full devin suite 226/226 green, eslint clean.

## Assumptions and contingencies

- `credentials.connectionId` and `credentials.providerSpecificData.apiBaseUrl` are present in executor context (verified chatCore.js:239,336-339).
- 5s lazy-discovery bound: if upstream is slower, request falls back to static — same as today; TTL/SWR keeps steady-state latency at zero.
- In-memory cache is per-process; Next.js dev/prod single-process model makes this sufficient. Multi-process deployments accept per-process snapshots (advisor: bounded limitation).
- If discovery latency proves unacceptable in practice, revisit persistence — not now.
