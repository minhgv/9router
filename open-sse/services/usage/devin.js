/**
 * Devin (Cognition) usage via GetUserStatus (Connect unary RPC).
 *
 * GetUserStatus exposes the same numbers the CLI prints at boot:
 * planStatus.dailyQuotaRemainingPercent / weeklyQuotaRemainingPercent (0–100),
 * the unix reset timestamps for both windows, monthly prompt credits
 * (-1 = unlimited on paid plans) and the plan period end.
 */

import {
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_USER_STATUS_PATH,
  GetUserStatusRequestSchema,
  GetUserStatusResponseSchema,
  toBinary,
  decodeDevinUnaryMessage,
  devinCliMetadata,
  normalizeDevinSessionToken,
} from "../../utils/devinProtobuf.js";
import { buildDevinUnaryHeaders } from "../devinModels.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

function unixSecondsToIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function percentQuota(remainingPercent, resetAtUnix) {
  const pct = Number(remainingPercent);
  if (!Number.isFinite(pct)) return null;
  return {
    used: Math.max(0, 100 - pct),
    total: 100,
    remainingPercentage: Math.min(100, Math.max(0, pct)),
    resetAt: unixSecondsToIso(resetAtUnix),
    unlimited: false,
  };
}

/**
 * Map a decoded GetUserStatusResponse to the dashboard usage shape.
 */
export function parseDevinUserStatus(response) {
  const status = response?.userStatus || {};
  const planStatus = status.planStatus || {};
  const planInfo = planStatus.planInfo || {};

  const quotas = {};
  const daily = percentQuota(planStatus.dailyQuotaRemainingPercent, planStatus.dailyQuotaResetAtUnix);
  if (daily) quotas["Daily quota"] = daily;
  const weekly = percentQuota(planStatus.weeklyQuotaRemainingPercent, planStatus.weeklyQuotaResetAtUnix);
  if (weekly) quotas["Weekly quota"] = weekly;

  const monthly = Number(planInfo.monthlyPromptCredits);
  const available = Number(planStatus.availablePromptCredits);
  if (Number.isFinite(monthly) && monthly > 0 && Number.isFinite(available) && available >= 0) {
    quotas["Prompt credits"] = {
      used: Math.max(0, monthly - available),
      total: monthly,
      remainingPercentage: (Math.min(monthly, available) / monthly) * 100,
      resetAt: null, // credits replenish on plan renewal, not on a fixed daily clock
      unlimited: false,
    };
  } else if (Number.isFinite(available) && available < 0) {
    quotas["Prompt credits"] = {
      used: 0,
      total: 0,
      remainingPercentage: 100,
      resetAt: unixSecondsToIso(planStatus.planEnd?.seconds),
      unlimited: true,
    };
  }

  const planName = planInfo.planName || (status.pro ? "Pro" : "Free");
  const expiresAt = unixSecondsToIso(planStatus.planEnd?.seconds);

  return {
    plan: planName,
    quotas,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

/**
 * @param {string} accessToken - raw or prefixed devin session token
 * @param {object|null} providerSpecificData
 * @param {object|null} proxyOptions
 * @param {Function} [fetchFn] - test seam; defaults to proxyAwareFetch
 */
export async function getDevinUsage(accessToken, providerSpecificData = null, proxyOptions = null, fetchFn = proxyAwareFetch) {
  const sessionToken = normalizeDevinSessionToken(accessToken || "");
  if (!sessionToken) {
    return { message: "Devin session token not available." };
  }

  const baseUrl = providerSpecificData?.apiBaseUrl || DEVIN_DEFAULT_BASE_URL;
  const body = toBinary(GetUserStatusRequestSchema, { metadata: devinCliMetadata(sessionToken) });

  try {
    const response = await fetchFn(
      `${baseUrl}${DEVIN_USER_STATUS_PATH}`,
      {
        method: "POST",
        headers: buildDevinUnaryHeaders(sessionToken),
        body,
      },
      proxyOptions,
    );

    if (response.status === 401 || response.status === 403) {
      return { message: "Devin session expired. Please re-login." };
    }
    if (!response.ok) {
      return { message: `Devin usage API error (${response.status})` };
    }

    const payload = Buffer.from(await response.arrayBuffer());
    const decoded = decodeDevinUnaryMessage(GetUserStatusResponseSchema, payload);
    if (!decoded?.userStatus) {
      return { message: "Devin usage response was not decodable protobuf." };
    }

    return parseDevinUserStatus(decoded);
  } catch (error) {
    return { message: `Devin usage error: ${error.message}` };
  }
}
