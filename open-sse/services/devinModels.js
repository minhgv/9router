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
 * Map raw clientModelConfigs to dashboard model entries.
 * Keeps only chat-usable entries (modelInfo.modelType CHAT = 2). The router
 * semantic (displayOption MODEL_ROUTER or modelInfo.isModelRouter) and the
 * parallel-tool capability are preserved so execution metadata stays coherent
 * with the static registry.
 */
export function parseDevinModelConfigs(response) {
  const configs = Array.isArray(response?.clientModelConfigs) ? response.clientModelConfigs : [];
  const models = [];
  const seen = new Set();
  for (const cfg of configs) {
    const id = typeof cfg?.modelUid === "string" ? cfg.modelUid : "";
    if (!id || seen.has(id)) continue;
    if (cfg?.modelInfo?.modelType !== 2) continue; // CHAT only
    seen.add(id);
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
  return models;
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
    },
    proxyOptions,
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`GetCliModelConfigs failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }

  const payload = Buffer.from(await response.arrayBuffer());
  const decoded = decodeDevinUnaryMessage(GetCliModelConfigsResponseSchema, payload);
  if (!decoded || !Array.isArray(decoded.clientModelConfigs)) {
    throw new Error("GetCliModelConfigs response was not decodable protobuf.");
  }
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
    const decoded = await fetchDevinCliModelConfigs(token, {
      ...(options.proxyOptions ? { proxyOptions: options.proxyOptions } : {}),
      ...(connection.providerSpecificData?.apiBaseUrl ? { baseUrl: connection.providerSpecificData.apiBaseUrl } : {}),
    });
    return { models: parseDevinModelConfigs(decoded) };
  } catch (error) {
    const status = /401|403/.test(error.message) ? 401 : 502;
    return { error: `Devin model discovery failed: ${error.message}`, status };
  }
}
