/**
 * Devin shared model catalog: a connection-scoped in-memory snapshot of the
 * live GetCliModelConfigs discovery, layered over the static registry.
 *
 * Closes the discovery→executor gap: the dashboard advertises logical family
 * ids from dynamic discovery, and the executor must route those ids even when
 * the family is absent from the static table. `getDevinCatalogSnapshot` hands
 * callers an immutable snapshot `{ families, members, fetchedAt, generation }`;
 * null means "fall back to the static registry" — catalog/discovery errors
 * NEVER break a request (fail-open: null snapshot → static fallback → today's
 * behavior).
 *
 * - Cache key: `credentials.connectionId` when present, else
 *   `sha256(normalizeDevinSessionToken(token)).slice(0,16) + "|" + baseUrl`.
 *   Plaintext tokens never appear in keys or logs.
 * - Cold path: bounded lazy discovery (`AbortSignal.timeout(5000)`); concurrent
 *   cold calls share one upstream fetch (in-flight dedupe). A caller abort
 *   stops only that caller's wait — it never poisons the cache nor kills the
 *   fetch other waiters share.
 * - Warm path: 10 min TTL; stale snapshots are served while a background
 *   refresh revalidates (stale-while-revalidate); a generation guard rejects
 *   out-of-order publishes so an older fetch can't overwrite a newer snapshot.
 * - Failure: the last-known-good snapshot is kept; without one, null.
 */

import { createHash } from "node:crypto";

import { getProviderModels } from "../config/providerModels.js";
import { DEVIN_DEFAULT_BASE_URL, normalizeDevinSessionToken } from "../utils/devinProtobuf.js";
import { fetchDevinCliModelConfigs, parseDevinModelConfigsSplit } from "./devinModels.js";

/** Serve stale beyond this age while a background refresh revalidates. */
const CATALOG_TTL_MS = 10 * 60 * 1000;
/** Hard bound for one lazy discovery round-trip. */
const DISCOVERY_TIMEOUT_MS = 5000;
/** Generation sentinel for "no snapshot published yet for this key". */
const NO_GENERATION = -1;

/** key → { snapshot } — connection-scoped last-known-good snapshots. */
const snapshotCache = new Map();
/** key → in-flight discovery record; dedupes concurrent cold calls/refreshes. */
const inFlightDiscoveries = new Map();
let generationSeq = 0;
/**
 * key → epoch, bumped on every invalidate. Fences publishes initiated BEFORE
 * an invalidate (credential rotation): a cold discovery compares NO_GENERATION
 * against NO_GENERATION, so the generation guard alone would let it republish
 * pre-rotation data after the cache was dropped. Entries are deliberately
 * never deleted — resetting an epoch to 0 would re-open the fence for work
 * still in flight.
 */
const keyEpochs = new Map();

// ---------- static floor ----------

/**
 * Static registry entries carrying an effortRouting table, converted to the
 * snapshot family-descriptor shape. These are the floor `families` — dynamic
 * discovery atomically replaces them per family id.
 */
const STATIC_FAMILY_FLOOR_MAP = new Map(
  getProviderModels("dv")
    .filter((m) => m?.effortRouting && typeof m.effortRouting === "object")
    .map((m) => {
      const routing = { ...m.effortRouting };
      const routedUids = [...new Set(Object.values(routing))];
      const members = m.defaultMember
        ? [m.defaultMember, ...routedUids.filter((uid) => uid !== m.defaultMember)]
        : routedUids;
      return [
        m.id,
        {
          id: m.id,
          name: m.name ?? m.id,
          members,
          routing,
          ...(m.defaultMember !== undefined ? { defaultMember: m.defaultMember } : {}),
          ...(Array.isArray(m.efforts) ? { efforts: m.efforts } : { efforts: Object.keys(routing) }),
          requiresEffort: m.requiresEffort ?? routing.off === undefined,
        },
      ];
    })
);

/** All static registry entries keyed by id — the floor `members`. */
const STATIC_MEMBER_FLOOR = new Map(getProviderModels("dv").map((m) => [m.id, m]));

// ---------- snapshot build ----------

/**
 * Build a catalog snapshot from a decoded GetCliModelConfigs response.
 *
 * `families` maps logical id → collapsed family descriptor; dynamic discovery
 * replaces the static floor per family id (atomic per-family replacement).
 * `members` maps every raw discovered uid (pre-collapse, family members
 * included) to its model entry over the static registry floor. A member whose
 * uid doubles as a family id is stamped with that family's routing under both
 * `routing` and the registry-legacy `effortRouting` key, so the executor's
 * members-first lookup still effort-routes merged ids (swe-1-7, glm-5-2, …)
 * on fresh discovery data.
 *
 * `fetchedAt`/`generation` are stamped when the snapshot is published.
 */
export function buildDevinCatalogSnapshot(decoded) {
  const { families: discoveredFamilies, rawMembers } = parseDevinModelConfigsSplit(decoded);
  const families = new Map(STATIC_FAMILY_FLOOR_MAP);
  for (const family of discoveredFamilies) families.set(family.id, family);
  const members = new Map(STATIC_MEMBER_FLOOR);
  for (const entry of rawMembers) members.set(entry.id, entry);
  for (const family of families.values()) {
    const member = members.get(family.id);
    if (!member) continue;
    members.set(family.id, {
      ...member,
      routing: family.routing,
      effortRouting: family.routing,
      ...(family.defaultMember !== undefined ? { defaultMember: family.defaultMember } : {}),
    });
  }
  return { families, members, fetchedAt: 0, generation: 0 };
}

// ---------- cache key ----------

/**
 * Connection-scoped cache key: the connection id when the caller supplies
 * one, else a truncated sha256 of the normalized session token plus the
 * upstream base URL. Plaintext tokens never appear in the key.
 */
function catalogCacheKey(credentials) {
  const connectionId = credentials?.connectionId ?? credentials?.id;
  if (connectionId !== undefined && connectionId !== null && `${connectionId}` !== "") {
    return `${connectionId}`;
  }
  const token = credentials?.accessToken || credentials?.apiKey || "";
  const normalized = normalizeDevinSessionToken(token);
  if (!normalized) return null;
  const tokenHash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  const baseUrl = credentials?.providerSpecificData?.apiBaseUrl || DEVIN_DEFAULT_BASE_URL;
  return `${tokenHash}|${baseUrl}`;
}

// ---------- publish ----------

/**
 * Store a freshly built snapshot unless it was initiated before an invalidate
 * (epoch fence) or a newer one was published since this fetch started
 * (out-of-order publish → rejected, the newer snapshot wins).
 */
function publishSnapshot(key, snapshot, baseGeneration, baseEpoch) {
  // Epoch fence first: an invalidate since this publish was initiated
  // orphans the result — the generation guard cannot see it.
  if ((keyEpochs.get(key) ?? 0) !== baseEpoch) return false;
  const currentGeneration = snapshotCache.get(key)?.snapshot.generation ?? NO_GENERATION;
  if (currentGeneration !== baseGeneration) return false;
  snapshot.fetchedAt = Date.now();
  snapshot.generation = ++generationSeq;
  snapshotCache.set(key, { snapshot });
  return true;
}

// ---------- discovery ----------

/**
 * Start (or join) the single in-flight discovery for `key`. The upstream fetch
 * is bounded by a 5s timeout; when every waiter has aborted (or the timeout
 * fires) the shared controller aborts the request. Success publishes under
 * the generation + invalidate-epoch guards; any failure resolves null and
 * leaves the cache — and
 * thus the last-known-good snapshot — untouched.
 */
function startDiscovery(key, credentials, options = {}) {
  const existing = inFlightDiscoveries.get(key);
  if (existing) return existing;
  const baseGeneration = snapshotCache.get(key)?.snapshot.generation ?? NO_GENERATION;
  const baseEpoch = keyEpochs.get(key) ?? 0;
  const timeoutSignal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  const controller = new AbortController();
  const waiterSignals = new Set();
  const onTimeout = () => controller.abort();
  timeoutSignal.addEventListener("abort", onTimeout, { once: true });
  const abortWhenUnwatched = () => {
    for (const signal of waiterSignals) if (!signal.aborted) return;
    controller.abort();
  };
  const record = { waiterSignals, abortWhenUnwatched };
  record.promise = (async () => {
    try {
      const token = credentials?.accessToken || credentials?.apiKey || "";
      if (!normalizeDevinSessionToken(token)) return null;
      const decoded = await fetchDevinCliModelConfigs(token, {
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
        ...(options.proxyOptions ? { proxyOptions: options.proxyOptions } : {}),
        baseUrl: credentials?.providerSpecificData?.apiBaseUrl || DEVIN_DEFAULT_BASE_URL,
        signal: controller.signal,
      });
      const snapshot = buildDevinCatalogSnapshot(decoded);
      if (publishSnapshot(key, snapshot, baseGeneration, baseEpoch)) return snapshot;
      return snapshotCache.get(key)?.snapshot ?? null; // a newer snapshot won the race
    } catch {
      return null; // keep last-known-good; without one the caller falls back to static
    } finally {
      timeoutSignal.removeEventListener("abort", onTimeout);
      if (inFlightDiscoveries.get(key) === record) inFlightDiscoveries.delete(key);
    }
  })();
  inFlightDiscoveries.set(key, record);
  return record;
}

/**
 * Wait for a discovery as one caller: an abort on this caller's signal
 * resolves null immediately without affecting the shared fetch.
 */
function joinDiscovery(record, signal) {
  if (signal) {
    record.waiterSignals.add(signal);
    if (signal.aborted) {
      record.abortWhenUnwatched();
      return Promise.resolve(null);
    }
    signal.addEventListener("abort", record.abortWhenUnwatched, { once: true });
  }
  return new Promise((resolve) => {
    const onAbort = () => resolve(null);
    if (signal?.aborted) return resolve(null);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    record.promise.then((snapshot) => {
      signal?.removeEventListener("abort", onAbort);
      signal?.removeEventListener("abort", record.abortWhenUnwatched);
      resolve(snapshot);
    });
  });
}

// ---------- public API ----------

/**
 * Connection-scoped Devin model catalog snapshot, or null when no snapshot is
 * available (static-registry fallback). Fresh snapshots are returned without
 * I/O; stale ones are served immediately while a background refresh runs;
 * cache-miss requests share one bounded discovery.
 */
export async function getDevinCatalogSnapshot(credentials, { proxyOptions, fetchFn, signal } = {}) {
  try {
    if (signal?.aborted) return null;
    const key = catalogCacheKey(credentials);
    if (!key) return null;
    const entry = snapshotCache.get(key);
    if (entry) {
      if (Date.now() - entry.snapshot.fetchedAt < CATALOG_TTL_MS) return entry.snapshot;
      // Stale-while-revalidate: serve last-known-good, refresh in background.
      startDiscovery(key, credentials, { proxyOptions, fetchFn });
      return entry.snapshot;
    }
    return await joinDiscovery(startDiscovery(key, credentials, { proxyOptions, fetchFn }), signal);
  } catch {
    return null; // fail-open: catalog errors never break a request
  }
}

/**
 * Drop the cached snapshot for a connection id (or prebuilt cache key). Cheap
 * Map.delete — safe to call unconditionally on credential/endpoint changes;
 * a pending discovery for the key is orphaned and its publish rejected.
 */
export function invalidateDevinCatalog(connectionIdOrKey) {
  try {
    if (connectionIdOrKey === undefined || connectionIdOrKey === null) return;
    const key = String(connectionIdOrKey);
    if (!key) return;
    keyEpochs.set(key, (keyEpochs.get(key) ?? 0) + 1);
    snapshotCache.delete(key);
    inFlightDiscoveries.delete(key);
  } catch { /* fail-open */ }
}

/**
 * Current invalidate-epoch for a connection object or prebuilt cache key.
 * Callers that acquire catalog data asynchronously capture this BEFORE the
 * fetch starts and forward it as `warmDevinCatalog`'s `baseEpoch`, so an
 * invalidate landing mid-acquisition (credential rotation) fences the
 * resulting publish. 0 = never invalidated.
 */
export function getDevinCatalogEpoch(connectionOrKey) {
  try {
    const key = typeof connectionOrKey === "string"
      ? connectionOrKey
      : catalogCacheKey(connectionOrKey);
    return keyEpochs.get(key) ?? 0;
  } catch { /* fail-open */ }
}

/**
 * Publish an already-decoded discovery result into the catalog (dashboard
 * fetch doubles as refresh — `resolveDevinModels` calls this so the executor
 * finds a warm snapshot for the same connection). Fail-open; never throws.
 *
 * `options.baseEpoch` (forward `getDevinCatalogEpoch(connection)` captured
 * BEFORE the acquisition fetch started) fences the publish against an
 * invalidate that landed mid-acquisition. Absent → unfenced (synchronous
 * callers are fence-safe by construction); the production async carrier
 * (resolveDevinModels) must forward it to close the warm re-poison window.
 */
export function warmDevinCatalog(connection, decoded, { baseEpoch } = {}) {
  try {
    if (!decoded) return;
    const key = catalogCacheKey(connection);
    if (!key) return;
    if (typeof baseEpoch === "number" && (keyEpochs.get(key) ?? 0) !== baseEpoch) return;
    publishSnapshot(
      key,
      buildDevinCatalogSnapshot(decoded),
      snapshotCache.get(key)?.snapshot.generation ?? NO_GENERATION,
      keyEpochs.get(key) ?? 0, // warm is synchronous — this is the epoch at warm start
    );
  } catch { /* fail-open */ }
}
