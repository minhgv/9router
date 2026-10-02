/**
 * Claude usage handler
 */
import { randomUUID } from "node:crypto";

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { ANTHROPIC_API_VERSION, CLAUDE_CLI_VERSION } from "../../providers/shared.js";
import { U, parseResetTime } from "./shared.js";
import { parseRetryAfter } from "../accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "../../config/errorConfig.js";
const CLAUDE_CONFIG = {
  oauthUsageUrl: U("claude").oauthUrl,
  usageUrl: U("claude").orgUrl,
  settingsUrl: U("claude").settingsUrl,
  profileUrl: U("claude").profileUrl,
  resetUrl: U("claude").resetUrl,
  apiVersion: ANTHROPIC_API_VERSION,
  userAgent: `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`,
};

// OAuth usage endpoint rate-limits (429); cool down per-token to stop hammering it.
// Only the quota endpoint is affected — chat with the same token still works.
const OAUTH_429_COOLDOWN_MS = 180000;
const oauthCooldown = new Map();

// Dedup + short TTL cache per access token. Many tabs / many accounts / auto-refresh
// all funnel through here; without this each call hits Anthropic and triggers 429.
const USAGE_CACHE_TTL_MS = 300000;
const usageCache = new Map(); // token -> { promise } | { result, expiresAt }

export async function getClaudeUsage(accessToken, proxyOptions = null, options = {}) {
  const force = options?.force === true;

  // Serve in-flight or fresh cached result (skip on manual force)
  if (!force && accessToken) {
    const hit = usageCache.get(accessToken);
    if (hit?.promise) return hit.promise;
    if (hit && hit.expiresAt > Date.now()) return hit.result;
  }

  const stale = (!force && accessToken && usageCache.get(accessToken)?.result) || null;

  const promise = (async () => {
    const result = await fetchClaudeUsageRaw(accessToken, proxyOptions);
    // Only cache real quota data, not soft-failure {message: ...} payloads
    if (accessToken && result?.quotas) {
      usageCache.set(accessToken, {
        result,
        expiresAt: Date.now() + USAGE_CACHE_TTL_MS,
      });
      return result;
    }
    // Soft failure (429/error): prefer the last good read over a transient error
    if (stale) return stale;
    return result;
  })();

  if (accessToken) usageCache.set(accessToken, { promise });
  return promise;
}

async function fetchClaudeUsageRaw(accessToken, proxyOptions = null) {
  try {
    // Skip OAuth usage call while this token is cooling down from a recent 429
    const cooldownUntil = oauthCooldown.get(accessToken);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      return await getClaudeUsageLegacy(accessToken, proxyOptions);
    }

    // cedar_ember=1 adds the free "limit reset" grants visible in Claude Code.
    const oauthResponse = await proxyAwareFetch(`${CLAUDE_CONFIG.oauthUsageUrl}?cedar_ember=1`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
        "User-Agent": CLAUDE_CONFIG.userAgent,
      },
    }, proxyOptions);

    if (oauthResponse.ok) {
      const data = await oauthResponse.json();
      const quotas = {};

      // utilization = % USED (e.g. 87 means 87% used, 13% remaining)
      const hasUtilization = (window) =>
        window && typeof window === "object" && typeof window.utilization === "number";

      const createQuotaObject = (window) => {
        const used = window.utilization;
        const remaining = Math.max(0, 100 - used);
        return {
          used,
          total: 100,
          remaining,
          remainingPercentage: remaining,
          resetAt: parseResetTime(window.resets_at),
          unlimited: false,
        };
      };

      if (hasUtilization(data.five_hour)) {
        quotas["session (5h)"] = createQuotaObject(data.five_hour);
      }

      if (hasUtilization(data.seven_day)) {
        quotas["weekly (7d)"] = createQuotaObject(data.seven_day);
      }

      // Parse model-specific weekly windows (e.g. seven_day_sonnet, seven_day_opus)
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith("seven_day_") && key !== "seven_day" && hasUtilization(value)) {
          const modelName = key.replace("seven_day_", "");
          quotas[`weekly ${modelName} (7d)`] = createQuotaObject(value);
        }
      }

      // Model-scoped weekly limits (e.g. Fable) arrive in limits[], not as
      // seven_day_* keys: { kind: "weekly_scoped", percent, resets_at,
      // scope: { model: { display_name: "Fable" } } }. No limits entry means
      // the account has no such window — omit the row, never fabricate one.
      if (Array.isArray(data.limits)) {
        for (const limit of data.limits) {
          if (limit?.kind !== "weekly_scoped") continue;
          const modelName = String(limit?.scope?.model?.display_name || "").trim().toLowerCase();
          if (!modelName || typeof limit.percent !== "number") continue;
          quotas[`weekly ${modelName} (7d)`] = createQuotaObject({
            utilization: Math.max(0, Math.min(100, limit.percent)),
            resets_at: limit.resets_at,
          });
        }
      }

      return {
        plan: "Claude Code",
        extraUsage: data.extra_usage ?? null,
        resetCredits: parseClaudeResetGrants(data.cedar_ember),
        quotas,
      };
    }

    // Cool down OAuth usage polling after a 429 (quota endpoint only)
    if (oauthResponse.status === 429) {
      const retryHeader = oauthResponse.headers?.get?.("retry-after");
      const parsedDelay = parseRetryAfter(retryHeader);
      const cooldownMs = parsedDelay != null && parsedDelay > 0
        ? Math.min(parsedDelay, MAX_RATE_LIMIT_COOLDOWN_MS)
        : OAUTH_429_COOLDOWN_MS;
      oauthCooldown.set(accessToken, Date.now() + cooldownMs);
    }
    // Fallback: legacy settings + org usage endpoint
    console.warn(`[Claude Usage] OAuth endpoint returned ${oauthResponse.status}, falling back to legacy`);
    return await getClaudeUsageLegacy(accessToken, proxyOptions);
  } catch (error) {
    return { message: `Claude connected. Unable to fetch usage: ${error.message}` };
  }
}

export function parseClaudeResetGrants(block) {
  if (!block?.eligible || !Array.isArray(block.grants)) return null;
  const grants = block.grants.filter((grant) =>
    typeof grant?.id === "string" && grant.id && !grant.paused &&
    Number.isFinite(Number(grant.resets_left)) && Number(grant.resets_left) > 0);
  const next = grants.find((grant) => grant.id === block.next_grant_id) || grants[0] || null;
  return {
    availableCount: grants.reduce((sum, grant) => sum + Number(grant.resets_left), 0),
    nextGrantId: next?.id || null,
    expiresAt: next?.ends_at || null,
    clears: Array.isArray(next?.clears) ? next.clears.filter((item) => typeof item === "string") : [],
    cooldownUntil: typeof block.cooldown_until === "string" ? block.cooldown_until : null,
    weeklyResetsAt: typeof block.weekly_resets_at === "string" ? block.weekly_resets_at : null,
    grants: block.grants.filter((grant) => typeof grant?.id === "string" && grant.id).map((grant) => ({
      id: grant.id,
      label: typeof grant.label === "string" ? grant.label : "",
      resetsLeft: Number.isFinite(Number(grant.resets_left)) ? Number(grant.resets_left) : 0,
      resetsTotal: Number.isFinite(Number(grant.resets_total)) ? Number(grant.resets_total) : 0,
      startsAt: typeof grant.starts_at === "string" ? grant.starts_at : null,
      endsAt: typeof grant.ends_at === "string" ? grant.ends_at : null,
      clears: Array.isArray(grant.clears) ? grant.clears.filter((item) => typeof item === "string") : [],
      paused: grant.paused === true,
      usableNow: grant.usable_now === true,
      useRequiresLimit: grant.use_requires_limit !== false,
    })),
  };
}

export async function consumeClaudeResetGrant(accessToken, grantId, proxyOptions = null) {
  if (!accessToken) throw new Error("No Claude access token available.");
  if (typeof grantId !== "string" || !/^[a-z0-9_-]{1,40}$/.test(grantId)) throw new Error("Invalid reset grant id.");
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
    "anthropic-version": CLAUDE_CONFIG.apiVersion,
    "User-Agent": CLAUDE_CONFIG.userAgent,
    "Content-Type": "application/json",
  };
  const profileResponse = await proxyAwareFetch(CLAUDE_CONFIG.profileUrl, { method: "GET", headers }, proxyOptions);
  const profile = await profileResponse.json().catch(() => null);
  const organizationId = profile?.organization?.uuid;
  if (!profileResponse.ok || typeof organizationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId)) {
    throw new Error("Cannot resolve Claude organization.");
  }
  const url = CLAUDE_CONFIG.resetUrl.replace("{org_id}", encodeURIComponent(organizationId));
  const response = await proxyAwareFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ program: "cedar_ember", grant_id: grantId, request_id: randomUUID() }),
  }, proxyOptions);
  const data = await response.json().catch(() => null);
  usageCache.delete(accessToken);
  return {
    ok: response.ok && data?.result === "reset",
    status: response.status,
    result: data?.result || null,
    reason: data?.reason || null,
    resetsLeft: data?.resets_left ?? null,
    message: data?.error?.message || null,
  };
}

/**
 * Legacy Claude usage for API key / org admin users
 */
async function getClaudeUsageLegacy(accessToken, proxyOptions = null) {
  try {
    const settingsResponse = await proxyAwareFetch(CLAUDE_CONFIG.settingsUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
      },
    }, proxyOptions);

    if (settingsResponse.ok) {
      const settings = await settingsResponse.json();

      if (settings.organization_id) {
        const usageResponse = await proxyAwareFetch(
          CLAUDE_CONFIG.usageUrl.replace("{org_id}", settings.organization_id),
          {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "anthropic-version": CLAUDE_CONFIG.apiVersion,
            },
          },
          proxyOptions
        );

        if (usageResponse.ok) {
          const usage = await usageResponse.json();
          return {
            plan: settings.plan || "Unknown",
            organization: settings.organization_name,
            quotas: usage,
          };
        }
      }

      return {
        plan: settings.plan || "Unknown",
        organization: settings.organization_name,
        message: "Claude connected. Usage details require admin access.",
      };
    }

    return { message: "Claude connected. Usage API requires admin permissions." };
  } catch (error) {
    return { message: `Claude connected. Unable to fetch usage: ${error.message}` };
  }
}
