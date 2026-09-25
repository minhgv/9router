/**
 * Devin model discovery via GetCliModelConfigs (Connect unary RPC).
 *
 * The CLI boots by POSTing an empty-metadata GetCliModelConfigsRequest to
 * `server.codeium.com` (content-type application/proto, no connect envelope for
 * unary calls) and renders its model picker from the returned
 * clientModelConfigs[] — each entry carries the wire modelUid we already send
 * in GetChatMessage, so the ids here are directly routable.
 */

import {
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_CLI_MODEL_CONFIGS_PATH,
  DisplayOption,
  GetCliModelConfigsRequestSchema,
  GetCliModelConfigsResponseSchema,
  toBinary,
  decodeDevinUnaryMessage,
  devinDiscoveryMetadata,
  normalizeDevinSessionToken,
} from "../utils/devinProtobuf.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { collectDevinFamilyLane, devinDynamicFamilies } from "./devinFamilies.js";
import { warmDevinCatalog, getDevinCatalogEpoch } from "./devinCatalog.js";

// Connect unary RPC headers, wire-captured from devin-cli: Basic auth with
// the session token repeated on both sides of a `-` (Basic {token}-{token}).
// Shared with usage/devin.js.
export function buildDevinUnaryHeaders(sessionToken) {
  return {
    "content-type": "application/proto",
    "connect-protocol-version": "1",
    accept: "*/*",
    authorization: `Basic ${sessionToken}-${sessionToken}`,
  };
}

function encodeCliModelConfigsRequest(sessionToken) {
  const metadata = devinDiscoveryMetadata(sessionToken);
  return toBinary(GetCliModelConfigsRequestSchema, { metadata });
}
/**
 * Parse raw clientModelConfigs into the three shapes downstream needs:
 * `logical` — dashboard model entries (chat-usable only, modelInfo.modelType
 * CHAT = 2) with server-declared families collapsed into one logical entry
 * per family carrying `effortRouting` / `defaultMember` / `efforts` /
 * `requiresEffort`; the members it replaces are removed from the output.
 * `families` — the collapsed family descriptors (`devinDynamicFamilies`
 * output); `rawMembers` — every pre-collapse chat entry, family members
 * included. The shared catalog snapshot needs all three, so
 * `parseDevinModelConfigs` is this split with `.logical` taken.
 *
 * The router semantic (displayOption MODEL_ROUTER or modelInfo.isModelRouter)
 * and the parallel-tool capability are preserved so execution metadata stays
 * coherent with the static registry. Configs without family metadata stay
 * standalone.
 */
export function parseDevinModelConfigsSplit(response) {
  const configs = Array.isArray(response?.clientModelConfigs) ? response.clientModelConfigs : [];
  const models = [];
  const seen = new Set();
  const lanes = new Map();
  for (const cfg of configs) {
    const id = typeof cfg?.modelUid === "string" ? cfg.modelUid : "";
    if (!id || seen.has(id)) continue;
    if (cfg?.modelInfo?.modelType !== 2) continue; // CHAT only
    seen.add(id);
    collectDevinFamilyLane(lanes, cfg, id);
    const features = cfg.modelInfo?.modelFeatures || {};
    models.push({
      id,
      name: cfg.label || id,
      ...(cfg.maxTokens ? { contextLength: cfg.maxTokens } : {}),
      ...(cfg.modelInfo?.maxOutputTokens ? { maxOutputTokens: cfg.modelInfo.maxOutputTokens } : {}),
      ...(cfg.creditMultiplier !== undefined && cfg.creditMultiplier !== null
        ? { creditMultiplier: cfg.creditMultiplier }
        : {}),
      ...(features.supportsImages ? { supportsImages: true } : {}),
      ...(features.supportsThinking ? { supportsThinking: true } : {}),
      ...(features.supportsToolCalls === false ? { supportsToolCalls: false } : {}),
      ...(features.supportsParallelToolCalls ? { supportsParallelToolCalls: true } : {}),
      ...((cfg.modelInfo?.displayOption === DisplayOption.MODEL_ROUTER || cfg.modelInfo?.isModelRouter === true)
        ? { modelRouter: true }
        : {}),
      ...(cfg.modelInfo?.modelFamilyUid ? { family: cfg.modelInfo.modelFamilyUid } : {}),
      ...(cfg.isRecommended ? { isRecommended: true } : {}),
    });
  }
  const families = devinDynamicFamilies(lanes.values());
  return { logical: applyFamilyCollapse(models, families), families, rawMembers: models };
}

/** Dashboard/executor parse: the collapsed logical entries of the split. */
export function parseDevinModelConfigs(response) {
  return parseDevinModelConfigsSplit(response).logical;
}

/**
 * Replace family members with one logical entry per collapsed family. The
 * logical entry inherits the default member's spec (features, credit
 * multiplier, context/output caps, isRecommended, modelFamilyUid) and carries
 * the effort routing table; with no server-declared default the first member
 * is the base. Logical entries appear at the first member's position.
 */
function applyFamilyCollapse(models, families) {
  if (families.length === 0) return models;
  const familyByMember = new Map();
  for (const family of families) {
    for (const uid of family.members) familyByMember.set(uid, family);
  }
  const entryById = new Map(models.map((entry) => [entry.id, entry]));
  const logicalByFamily = new Map();
  for (const family of families) {
    const baseId = family.defaultMember !== undefined ? family.defaultMember : family.members[0];
    const base = entryById.get(baseId) || entryById.get(family.members[0]) || {};
    logicalByFamily.set(family.id, {
      ...base,
      id: family.id,
      name: family.name,
      effortRouting: { ...family.routing },
      ...(family.defaultMember !== undefined ? { defaultMember: family.defaultMember } : {}),
      efforts: family.efforts,
      requiresEffort: family.requiresEffort,
    });
  }
  const collapsed = [];
  const emitted = new Set();
  for (const entry of models) {
    const family = familyByMember.get(entry.id);
    if (family === undefined) {
      collapsed.push(entry);
      continue;
    }
    if (emitted.has(family.id)) continue;
    emitted.add(family.id);
    collapsed.push(logicalByFamily.get(family.id));
  }
  return collapsed;
}

/**
 * Fetch + decode GetCliModelConfigs. Returns the decoded response object.
 * @throws on network / HTTP / decode failure.
 */
export async function fetchDevinCliModelConfigs(sessionToken, options = {}) {
  const {
    fetchFn = proxyAwareFetch,
    proxyOptions = null,
    baseUrl = DEVIN_DEFAULT_BASE_URL,
  } = options;

  const normalized = normalizeDevinSessionToken(sessionToken || "");
  if (!normalized) throw new Error("Devin session token is missing.");

  const body = encodeCliModelConfigsRequest(normalized);
  const response = await fetchFn(
    `${baseUrl}${DEVIN_CLI_MODEL_CONFIGS_PATH}`,
    {
      method: "POST",
      headers: buildDevinUnaryHeaders(normalized),
      body,
      ...(options.signal ? { signal: options.signal } : {}),
    },
    proxyOptions,
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`GetCliModelConfigs failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }

  const payload = Buffer.from(await response.arrayBuffer());
  // A zero-length body IS a valid proto message (empty lineup): static-floor
  // discovery, not a decode failure.
  if (payload.length === 0) return { clientModelConfigs: [] };
  const decoded = decodeDevinUnaryMessage(GetCliModelConfigsResponseSchema, payload);
  if (!decoded) {
    throw new Error("GetCliModelConfigs response was not decodable protobuf.");
  }
  // protobufjs omits empty repeated fields — an empty-but-valid lineup is a
  // real (static-floor-only) discovery, not a decode failure.
  if (!Array.isArray(decoded.clientModelConfigs)) decoded.clientModelConfigs = [];
  return decoded;
}

/**
 * Route-facing resolver: connection → { models } | { error, status }.
 */
export async function resolveDevinModels(connection, options = {}) {
  const token = connection?.accessToken || connection?.apiKey || "";
  if (!normalizeDevinSessionToken(token)) {
    return { error: "Devin session token not available.", status: 401 };
  }
  try {
    // Capture the invalidation epoch BEFORE the fetch: a PUT/DELETE that lands
    // while this await is in flight must fence our warm publish, else a
    // discovery started pre-invalidation re-poisons the cache with
    // pre-rotation credentials.
    const baseEpoch = getDevinCatalogEpoch(connection);
    const decoded = await fetchDevinCliModelConfigs(token, {
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
      ...(options.proxyOptions ? { proxyOptions: options.proxyOptions } : {}),
      ...(connection.providerSpecificData?.apiBaseUrl ? { baseUrl: connection.providerSpecificData.apiBaseUrl } : {}),
    });
    // Publish into the shared catalog so the executor finds a warm snapshot
    // for this connection without a second discovery round-trip (fail-open:
    // warm errors must not fail the dashboard fetch).
    warmDevinCatalog(connection, decoded, { baseEpoch });
    return { models: parseDevinModelConfigs(decoded) };
  } catch (error) {
    const status = /401|403/.test(error.message) ? 401 : 502;
    return { error: `Devin model discovery failed: ${error.message}`, status };
  }
}
