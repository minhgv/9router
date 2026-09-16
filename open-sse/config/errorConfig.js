// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

export const ERROR_CATEGORIES = {
  AUTH_INVALID: "auth_invalid",
  QUOTA: "quota",
  OVERLOAD: "overload",
  MALFORMED_REQUEST: "malformed_request",
  USAGE_FAILURE: "usage_failure",
  PROVIDER_RESTRICTION: "provider_restriction",
  TRANSIENT: "transient",
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, category?, shouldFallback?, cooldownMs?, backoff? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - category: one of ERROR_CATEGORIES
 *   - shouldFallback: boolean (default true)
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit / quota)
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  // Usage failure (must not disable inference)
  { text: "unable to fetch usage",     category: ERROR_CATEGORIES.USAGE_FAILURE, shouldFallback: false, cooldownMs: 0 },
  { text: "usage details require",     category: ERROR_CATEGORIES.USAGE_FAILURE, shouldFallback: false, cooldownMs: 0 },
  { text: "usage api requires",        category: ERROR_CATEGORIES.USAGE_FAILURE, shouldFallback: false, cooldownMs: 0 },
  { text: "failed to fetch usage",     category: ERROR_CATEGORIES.USAGE_FAILURE, shouldFallback: false, cooldownMs: 0 },

  // Auth invalid (account needs re-auth or switch)
  { text: "no credentials",           category: ERROR_CATEGORIES.AUTH_INVALID, shouldFallback: true, cooldownMs: COOLDOWN.long },
  { text: "invalid_api_key",          category: ERROR_CATEGORIES.AUTH_INVALID, shouldFallback: true, cooldownMs: COOLDOWN.long },
  { text: "invalid api key",          category: ERROR_CATEGORIES.AUTH_INVALID, shouldFallback: true, cooldownMs: COOLDOWN.long },
  { text: "invalid x-api-key",        category: ERROR_CATEGORIES.AUTH_INVALID, shouldFallback: true, cooldownMs: COOLDOWN.long },
  { text: "authentication_error",     category: ERROR_CATEGORIES.AUTH_INVALID, shouldFallback: true, cooldownMs: COOLDOWN.long },
  { text: "invalid_token",            category: ERROR_CATEGORIES.AUTH_INVALID, shouldFallback: true, cooldownMs: COOLDOWN.long },
  { text: "token expired",            category: ERROR_CATEGORIES.AUTH_INVALID, shouldFallback: true, cooldownMs: COOLDOWN.long },
  { text: "token has been revoked",   category: ERROR_CATEGORIES.AUTH_INVALID, shouldFallback: true, cooldownMs: COOLDOWN.long },
  { text: "account suspended",        category: ERROR_CATEGORIES.AUTH_INVALID, shouldFallback: true, cooldownMs: COOLDOWN.long },

  // Provider restrictions
  { text: "request not allowed",      category: ERROR_CATEGORIES.PROVIDER_RESTRICTION, shouldFallback: true, cooldownMs: COOLDOWN.short },
  { text: "permission_denied",        category: ERROR_CATEGORIES.PROVIDER_RESTRICTION, shouldFallback: true, cooldownMs: COOLDOWN.long },
  { text: "permission_error",         category: ERROR_CATEGORIES.PROVIDER_RESTRICTION, shouldFallback: true, cooldownMs: COOLDOWN.long },
  { text: "organization_restricted",   category: ERROR_CATEGORIES.PROVIDER_RESTRICTION, shouldFallback: true, cooldownMs: COOLDOWN.long },
  { text: "geoblocked",               category: ERROR_CATEGORIES.PROVIDER_RESTRICTION, shouldFallback: true, cooldownMs: COOLDOWN.long },
  { text: "country not supported",    category: ERROR_CATEGORIES.PROVIDER_RESTRICTION, shouldFallback: true, cooldownMs: COOLDOWN.long },
  { text: "region not supported",     category: ERROR_CATEGORIES.PROVIDER_RESTRICTION, shouldFallback: true, cooldownMs: COOLDOWN.long },
  { text: "provider_restricted",      category: ERROR_CATEGORIES.PROVIDER_RESTRICTION, shouldFallback: true, cooldownMs: COOLDOWN.long },

  // Malformed / client request errors (client should fix; switching accounts won't help)
  { text: "improperly formed request", category: ERROR_CATEGORIES.MALFORMED_REQUEST, shouldFallback: false, cooldownMs: 0 },
  { text: "invalid_request_error",     category: ERROR_CATEGORIES.MALFORMED_REQUEST, shouldFallback: false, cooldownMs: 0 },
  { text: "bad_request",              category: ERROR_CATEGORIES.MALFORMED_REQUEST, shouldFallback: false, cooldownMs: 0 },
  { text: "context length exceeded",   category: ERROR_CATEGORIES.MALFORMED_REQUEST, shouldFallback: false, cooldownMs: 0 },
  { text: "prompt too long",          category: ERROR_CATEGORIES.MALFORMED_REQUEST, shouldFallback: false, cooldownMs: 0 },
  { text: "max_tokens too large",     category: ERROR_CATEGORIES.MALFORMED_REQUEST, shouldFallback: false, cooldownMs: 0 },

  // Quota & billing errors (switch account or wait for reset)
  { text: "quota exceeded",           category: ERROR_CATEGORIES.QUOTA, shouldFallback: true, backoff: true },
  { text: "insufficient_quota",       category: ERROR_CATEGORIES.QUOTA, shouldFallback: true, backoff: true },
  { text: "credit balance",           category: ERROR_CATEGORIES.QUOTA, shouldFallback: true, backoff: true },
  { text: "usage limit reached",      category: ERROR_CATEGORIES.QUOTA, shouldFallback: true, backoff: true },
  { text: "usage limit exceeded",     category: ERROR_CATEGORIES.QUOTA, shouldFallback: true, backoff: true },
  { text: "billing_error",            category: ERROR_CATEGORIES.QUOTA, shouldFallback: true, backoff: true },

  // Overload & rate limit errors
  { text: "rate limit",               category: ERROR_CATEGORIES.OVERLOAD, shouldFallback: true, backoff: true },
  { text: "too many requests",        category: ERROR_CATEGORIES.OVERLOAD, shouldFallback: true, backoff: true },
  { text: "capacity",                 category: ERROR_CATEGORIES.OVERLOAD, shouldFallback: true, backoff: true },
  { text: "overloaded",               category: ERROR_CATEGORIES.OVERLOAD, shouldFallback: true, backoff: true },
  { text: "overloaded_error",         category: ERROR_CATEGORIES.OVERLOAD, shouldFallback: true, backoff: true },
  { text: "resource exhausted",       category: ERROR_CATEGORIES.OVERLOAD, shouldFallback: true, backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 400, category: ERROR_CATEGORIES.MALFORMED_REQUEST, shouldFallback: false, cooldownMs: 0 },
  { status: 401, category: ERROR_CATEGORIES.AUTH_INVALID, shouldFallback: true, cooldownMs: COOLDOWN.long },
  { status: 402, category: ERROR_CATEGORIES.QUOTA, shouldFallback: true, cooldownMs: COOLDOWN.long },
  { status: 403, category: ERROR_CATEGORIES.PROVIDER_RESTRICTION, shouldFallback: true, cooldownMs: COOLDOWN.long },
  { status: 404, category: ERROR_CATEGORIES.PROVIDER_RESTRICTION, shouldFallback: true, cooldownMs: COOLDOWN.long },
  { status: 406, category: ERROR_CATEGORIES.MALFORMED_REQUEST, shouldFallback: false, cooldownMs: 0 },
  { status: 422, category: ERROR_CATEGORIES.MALFORMED_REQUEST, shouldFallback: false, cooldownMs: 0 },
  { status: 429, category: ERROR_CATEGORIES.OVERLOAD, shouldFallback: true, backoff: true },
  { status: 529, category: ERROR_CATEGORIES.OVERLOAD, shouldFallback: true, backoff: true },
  { status: 500, category: ERROR_CATEGORIES.TRANSIENT, shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS },
  { status: 502, category: ERROR_CATEGORIES.TRANSIENT, shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS },
  { status: 503, category: ERROR_CATEGORIES.TRANSIENT, shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS },
  { status: 504, category: ERROR_CATEGORIES.TRANSIENT, shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS },
];

/**
 * Classify error into a canonical error category and fallback rules.
 * @param {number} status - HTTP status code
 * @param {string|object} errorText - Error message text
 * @returns {{ category: string, shouldFallback: boolean, cooldownMs?: number, backoff?: boolean, rule?: object }}
 */
export function classifyError(status, errorText) {
  const lowerError = errorText
    ? (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase()
    : "";

  for (const rule of ERROR_RULES) {
    if (rule.text && lowerError && lowerError.includes(rule.text)) {
      return {
        category: rule.category || ERROR_CATEGORIES.TRANSIENT,
        shouldFallback: rule.shouldFallback !== undefined ? rule.shouldFallback : true,
        cooldownMs: rule.cooldownMs,
        backoff: !!rule.backoff,
        rule
      };
    }
    if (rule.status && rule.status === status) {
      return {
        category: rule.category || ERROR_CATEGORIES.TRANSIENT,
        shouldFallback: rule.shouldFallback !== undefined ? rule.shouldFallback : true,
        cooldownMs: rule.cooldownMs,
        backoff: !!rule.backoff,
        rule
      };
    }
  }

  return {
    category: ERROR_CATEGORIES.TRANSIENT,
    shouldFallback: true,
    cooldownMs: TRANSIENT_COOLDOWN_MS,
    backoff: false
  };
}

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
  authInvalid: COOLDOWN.long,
  quota: COOLDOWN.long,
  providerRestriction: COOLDOWN.long,
};
