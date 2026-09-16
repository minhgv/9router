import {
  ERROR_RULES,
  ERROR_CATEGORIES,
  BACKOFF_CONFIG,
  TRANSIENT_COOLDOWN_MS,
  MAX_RATE_LIMIT_COOLDOWN_MS,
  classifyError,
} from "../config/errorConfig.js";

/**
 * Parse HTTP Retry-After header value to delay in milliseconds.
 * Supports:
 *   - Delta-seconds (numeric string or number, e.g. "120", 120, "5.5")
 *   - HTTP-date (IMF-fixdate / RFC 7231 string, e.g. "Wed, 21 Oct 2026 07:28:00 GMT")
 * @param {string|number|null|undefined} headerValue
 * @returns {number|null} Milliseconds to wait, or null if unparseable / absent
 */
export function parseRetryAfter(headerValue) {
  if (headerValue == null) return null;

  if (typeof headerValue === "number") {
    if (Number.isFinite(headerValue) && headerValue >= 0) {
      return Math.round(headerValue * 1000);
    }
    return null;
  }

  if (typeof headerValue === "string") {
    const trimmed = headerValue.trim();
    if (!trimmed) return null;

    // Check for delta-seconds (integer or float)
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const seconds = parseFloat(trimmed);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.round(seconds * 1000);
      }
      return null;
    }

    // Try HTTP-date
    const parsedDate = Date.parse(trimmed);
    if (!Number.isNaN(parsedDate)) {
      const delayMs = parsedDate - Date.now();
      return Math.max(0, delayMs);
    }
  }

  return null;
}

/**
 * Parse reset timestamp from various formats to epoch milliseconds.
 * Supports:
 *   - Date object
 *   - Unix epoch seconds (e.g. 1774000000) or milliseconds (e.g. 1774000000000)
 *   - Numeric string
 *   - ISO / RFC date string
 * @param {number|string|Date|null|undefined} resetValue
 * @returns {number|null} Epoch timestamp in milliseconds, or null if invalid
 */
export function parseResetTimestamp(resetValue) {
  if (resetValue == null) return null;

  if (resetValue instanceof Date) {
    const time = resetValue.getTime();
    return Number.isNaN(time) ? null : time;
  }

  if (typeof resetValue === "number") {
    if (!Number.isFinite(resetValue) || resetValue <= 0) return null;
    // < 1e11 represents seconds (year 1973 to ~5138)
    return resetValue < 1e11 ? Math.round(resetValue * 1000) : Math.round(resetValue);
  }

  if (typeof resetValue === "string") {
    const trimmed = resetValue.trim();
    if (!trimmed) return null;

    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const num = parseFloat(trimmed);
      if (Number.isFinite(num) && num > 0) {
        return num < 1e11 ? Math.round(num * 1000) : Math.round(num);
      }
      return null;
    }

    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }

  return null;
}

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 1: 2s, Level 2: 4s, Level 3: 8s... → max 5 min
 * @param {number} backoffLevel - Current backoff level
 * @returns {number} Cooldown in milliseconds
 */
export function getQuotaCooldown(backoffLevel = 0) {
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, level);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * Config-driven: matches ERROR_RULES top-to-bottom (text rules first, then status)
 * Supports Retry-After / reset timestamp override before bounded backoff.
 * @param {number} status - HTTP status code
 * @param {string|object} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @param {object} [options] - Optional override parameters: { retryAfterMs, resetsAtMs, retryAfterHeader, resetsAt }
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel?: number, category: string }}
 */
export function checkFallbackError(status, errorText, backoffLevel = 0, options = {}) {
  const classification = classifyError(status, errorText);

  if (!classification.shouldFallback) {
    return {
      shouldFallback: false,
      cooldownMs: 0,
      newBackoffLevel: backoffLevel,
      category: classification.category
    };
  }

  // Parse explicit Retry-After or resetsAt if provided in options
  const explicitRetryAfterMs = options.retryAfterMs ?? parseRetryAfter(options.retryAfterHeader);
  const explicitResetsAtMs = options.resetsAtMs ?? parseResetTimestamp(options.resetsAt);

  if (explicitRetryAfterMs != null && explicitRetryAfterMs >= 0) {
    const cooldownMs = Math.min(explicitRetryAfterMs, MAX_RATE_LIMIT_COOLDOWN_MS);
    return {
      shouldFallback: true,
      cooldownMs,
      newBackoffLevel: 0,
      category: classification.category
    };
  }

  if (explicitResetsAtMs != null && explicitResetsAtMs > Date.now()) {
    const cooldownMs = Math.min(explicitResetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    return {
      shouldFallback: true,
      cooldownMs,
      newBackoffLevel: 0,
      category: classification.category
    };
  }

  if (classification.backoff) {
    const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
    return {
      shouldFallback: true,
      cooldownMs: getQuotaCooldown(newLevel),
      newBackoffLevel: newLevel,
      category: classification.category
    };
  }

  const cooldownMs = classification.cooldownMs ?? TRANSIENT_COOLDOWN_MS;
  return {
    shouldFallback: true,
    cooldownMs,
    newBackoffLevel: backoffLevel,
    category: classification.category
  };
}

export { ERROR_CATEGORIES };

/**
 * Check if account is currently unavailable (cooldown not expired)
 */
export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

/**
 * Calculate unavailable until timestamp
 */
export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

/**
 * Get the earliest rateLimitedUntil from a list of accounts
 * @param {Array} accounts - Array of account objects with rateLimitedUntil
 * @returns {string|null} Earliest rateLimitedUntil ISO string, or null
 */
export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

/**
 * Format rateLimitedUntil to human-readable "reset after Xm Ys"
 * @param {string} rateLimitedUntil - ISO timestamp
 * @returns {string} e.g. "reset after 2m 30s"
 */
export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

/** Build the flat field key for a model lock */
export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

/**
 * Check if a model lock on a connection is still active.
 * Reads flat field `modelLock_${model}` (or `modelLock___all` when model=null).
 */
export function isModelLockActive(connection, model) {
  const key = getModelLockKey(model);
  const expiry = connection[key] || connection[MODEL_LOCK_ALL];
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now();
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection) {
  if (!connection) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 */
export function buildModelLockUpdate(model, cooldownMs) {
  const key = getModelLockKey(model);
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

/**
 * Build update object to clear all model locks on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

/**
 * Filter available accounts (not in cooldown)
 */
export function filterAvailableAccounts(accounts, excludeId = null) {
  const now = Date.now();
  return accounts.filter(acc => {
    if (excludeId && acc.id === excludeId) return false;
    if (acc.rateLimitedUntil) {
      const until = new Date(acc.rateLimitedUntil).getTime();
      if (until > now) return false;
    }
    return true;
  });
}

/**
 * Reset account state when request succeeds
 * Clears cooldown and resets backoff level to 0
 * @param {object} account - Account object
 * @returns {object} Updated account with reset state
 */
export function resetAccountState(account) {
  if (!account) return account;
  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active"
  };
}

/**
 * Apply error state to account
 * @param {object} account - Account object
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message
 * @returns {object} Updated account with error state
 */
export function applyErrorState(account, status, errorText, options = {}) {
  if (!account) return account;

  const backoffLevel = account.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel, category } = checkFallbackError(status, errorText, backoffLevel, options);

  return {
    ...account,
    rateLimitedUntil: cooldownMs > 0 ? getUnavailableUntil(cooldownMs) : null,
    backoffLevel: newBackoffLevel ?? backoffLevel,
    lastError: {
      status,
      message: typeof errorText === "string" ? errorText : JSON.stringify(errorText),
      category,
      timestamp: new Date().toISOString()
    },
    status: cooldownMs > 0 ? "error" : (account.status || "active")
  };
}
