# Antigravity Provider — Architecture & Debug Guide

> Provider `antigravity` (alias `ag`) — routes requests to Google's **Cloud Code Assist API** (`cloudcode-pa.googleapis.com` family) impersonating the official **Antigravity IDE** client. OAuth-based, supports LLM chat, image generation, and web search grounding.
>
> **Status:** `deprecated: true` in registry (hidden from UI, `deprecationNotice: "RISK_NOTICE"`) — still fully functional.
>
> **Design reference:** most anti-fingerprint logic is ported from `antigravity-opencode` (see "Parity:" comments in code). When debugging upstream behavior changes, diff against that project first.

---

## 1. File Map

| Layer | File | Role |
|---|---|---|
| Registry | `open-sse/providers/registry/antigravity.js` | Provider config: baseUrls, models, OAuth endpoints, retry, usage URLs |
| Shared constants | `open-sse/providers/shared.js:84-99` | `ANTIGRAVITY_IDE_BASE_URL`, `SANDBOX_BASE_URL`, `PROD_BASE_URL`, `IDE_USER_AGENT`, `OAUTH_CLIENT` (clientId/secret) |
| Executor | `open-sse/executors/antigravity.js` | `AntigravityExecutor` — request transform, headers, retry/failover, token refresh, tool cloaking |
| Version tracking | `open-sse/utils/antigravityVersion.js` | Live IDE version discovery via electron-builder manifest |
| App constants | `open-sse/config/appConstants.js` | `AG_DEFAULT_TOOLS`, `AG_TOOL_SUFFIX`, `ANTIGRAVITY_PROMPT_REWRITES`, `CLOUD_CODE_API.antigravity`, header sets |
| Request translator | `open-sse/translator/request/openai-to-gemini.js` (`openaiToAntigravityRequest`, `wrapInCloudCodeEnvelope`) | OpenAI → antigravity envelope |
| Request translator | `open-sse/translator/request/antigravity-to-openai.js` | Antigravity envelope → OpenAI (inbound clients speaking antigravity format) |
| Response translator | `open-sse/translator/response/gemini-to-openai.js` | Antigravity/Gemini SSE → OpenAI (shared, registered for `antigravity:openai`) |
| Response translator | `open-sse/translator/response/openai-to-antigravity.js` | OpenAI SSE → antigravity `{response:{...}}` envelope |
| Schema cleaner | `open-sse/translator/formats/gemini.js` | `cleanJSONSchemaForAntigravity`, `normalizeGeminiContents`, `$ref` dereferencing |
| OAuth provider | `src/lib/oauth/providers/antigravity.js` | Dashboard OAuth flow definition (auth URL, exchange, postExchange → projectId) |
| OAuth service | `src/lib/oauth/services/antigravity.js` | `AntigravityService` — CLI/browser flow: local server → code exchange → loadCodeAssist → onboardUser → saveTokens |
| OAuth constants | `src/lib/oauth/constants/oauth.js` | `ANTIGRAVITY_CONFIG` = `ANTIGRAVITY_OAUTH_CLIENT` + `PROVIDER_OAUTH["antigravity"]` + client metadata |
| Usage/quota | `open-sse/services/usage/google.js` (`getAntigravityUsage`) + `antigravity-weekly.js` | Per-model quota + weekly quota summary |
| Search | `open-sse/handlers/search/chatSearch.js` | Google Search grounding via `searchViaChat` config |
| Tests | `tests/unit/antigravity-oauth-client.test.js` | Pins canonical OAuth credentials location |

---

## 2. Request Lifecycle

```
Client (OpenAI/Claude/antigravity format)
  → src/app/api/v1/* → src/sse/handlers/chat.js
  → open-sse/handlers/chatCore.js
      - detects sourceFormat; provider format = "antigravity" (registry transport.format)
      - translateRequest(source → antigravity)  [openai-to-gemini.js wraps in Cloud Code envelope]
      - image models: stream forced to false (chatCore.js:124-127)
  → AntigravityExecutor.execute()  [base.js loop]
      - buildUrl()      → {baseUrl}/v1internal:{streamGenerateContent?alt=sse | generateContent}
      - transformRequest() → sanitize/normalize/envelope (§4)
      - buildHeaders()  → Bearer + IDE User-Agent + parity headers (§5)
      - proxyAwareFetch → upstream
      - retry/failover  → §7
  → response SSE → translateResponse(antigravity → source) [gemini-to-openai.js]
  → SSE to client
```

**Envelope shape** (what goes on the wire):

```jsonc
{
  "project": "<cloudaicompanionProject | generated>",
  "model": "<wire id, e.g. gemini-3.8-flash-high>",
  "userAgent": "antigravity",
  "requestId": "agent/<convUuid>/<epochMs>/<trajUuid>/<step>",
  // NO requestType on text requests — see §6.1
  "request": {
    "sessionId": "<numeric session id>",
    "contents": [ /* Gemini contents */ ],
    "systemInstruction": { "parts": [...] },
    "generationConfig": { "maxOutputTokens": ..., "thinkingConfig": {...} },
    "tools": [{ "functionDeclarations": [...] }],
    "toolConfig": { "functionCallingConfig": { "mode": "VALIDATED" } },
    "labels": { "trajectory_id": "...", "last_step_index": "...", "model_enum": "...", "used_claude": "1" }
  }
}
```

Image-gen requests differ: `requestType: "image_gen"`, text-only `contents`, `generationConfig.imageConfig = { aspectRatio }`, no tools/systemInstruction/safetySettings.

---

## 3. Endpoint Topology & Failover Chain

`transport.baseUrls` (registry) — tried **in order**:

| # | Host | Constant | Purpose |
|---|---|---|---|
| 0 | `https://daily-cloudcode-pa.googleapis.com` | `ANTIGRAVITY_IDE_BASE_URL` | Primary chat lane (bypasses prod 429) |
| 1 | `https://daily-cloudcode-pa.sandbox.googleapis.com` | `ANTIGRAVITY_SANDBOX_BASE_URL` | Sandbox mirror, failover on 429/5xx |
| 2 | `https://cloudcode-pa.googleapis.com` | `ANTIGRAVITY_PROD_BASE_URL` | Production — last resort; **only** host for `loadCodeAssist`/`onboardUser` |

Failover triggers (`shouldRetry`, executor:513): `429`, `500`, `502`, `503`, `504`, **plus `403`/`404`** — daily hosts reject PROD-only-licensed accounts (`"no valid license"` / `"Requested entity was not found"` for `cloudaicompanionProject`), so the chain must reach PROD before giving up.

**Auth/onboarding calls always hit PROD** (`CLOUD_CODE_API.antigravity`, appConstants.js:149): the daily host rejects `loadCodeAssist`/`onboardUser`.

Other endpoints (all on daily host unless noted):
- Quota: `POST /v1internal:fetchAvailableModels`, `POST /v1internal:retrieveUserQuotaSummary`
- `loadCodeAssist`: `POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` (PROD)
- `onboardUser`: `POST https://cloudcode-pa.googleapis.com/v1internal:onboardUser` (PROD)
- Token refresh: `POST https://oauth2.googleapis.com/token`
- Search grounding: `POST {daily}/v1internal:generateContent` (model `gemini-2.5-flash`)

---

## 4. `transformRequest()` — What Happens to Every Request

Order of operations in `AntigravityExecutor.transformRequest` (executor:216):

1. **`projectId`** — `credentials.projectId` (from OAuth onboarding) else `generateProjectId()` → `"{adj}-{noun}-{uuid5}"` (e.g. `swift-flow-a1b2c`).
2. **`stream_options` deleted** when `stream !== true` — Google rejects the combo.
3. **Image models** (`/image|imagen|image-generation/i`) → separate simplified path (§2), returns early.
4. **Contents normalization** (executor:275-314):
   - `functionResponse` parts → role forced to `"user"` (Claude-model requirement).
   - Thought-only parts stripped; `thoughtSignature` kept **only** on `functionCall` parts.
   - **thoughtSignature backfill**: Gemini 3+ rejects unsigned `functionCall`. First call in a turn gets `p.thoughtSignature || cachedSig (thoughtSignatureStore) || DEFAULT_THINKING_AG_SIGNATURE`; sibling parallel calls stay unsigned. Cache key: `functionCall.id` + `sessionId` via `getGeminiThoughtSignatureSync`.
   - `normalizeGeminiContents()` merges/validates.
5. **Tools** (executor:317-338): all `functionDeclarations` groups merged into ONE group; names sanitized to `[a-zA-Z_][a-zA-Z0-9_.:\-]{0,63}` (dedup after sanitize); `parameters` cleaned by `cleanJSONSchemaForAntigravity` (dereferences internal `$ref`/`$defs`/`definitions` first — sibling keys win, cycle-safe); missing parameters → stub `{reason}` schema.
6. **Blacklist strip** (executor:44-57): `output_config, thinking, reasoning_effort, reasoning, enable_thinking, thinking_budget, thinkingConfig` removed from `body.request` AND top-level `body` (leaked by `thinkingUnified.js`; Google 400s on them).
7. **systemInstruction rewrite** (executor:346-354): `ANTIGRAVITY_PROMPT_REWRITES` + `obfuscateSensitiveWords` — see §6.2.
8. **generationConfig**: `maxOutputTokens` capped at `ANTIGRAVITY_WIRE_PROFILES[wireId]?.maxOutputTokens` (65536/65535) else 64000. `thinkingConfig = { includeThoughts: true, thinkingLevel }` injected per `resolveAntigravityThinkingLevel` (§6.3).
9. **Envelope**: `requestId` via `buildIdeRequestId` (deterministic `agent/<conv>/<ts>/<traj>/<step>` from sha256 seeds of sessionId+model); `request.labels` via `buildAntigravityLabels` (§6.4); `safetySettings` removed; `toolConfig.functionCallingConfig.mode = "VALIDATED"` when tools present.

---

## 5. Headers & Fingerprinting

`buildHeaders` (executor:200) sends:

```
Content-Type: application/json
Authorization: Bearer <accessToken>
User-Agent: antigravity/ide/<version> darwin/arm64     ← dynamic, see below
x-request-source: local                              ← client parity
Client-Metadata: ideType=ANTIGRAVITY,platform=MACOS,pluginType=GEMINI
```

**Version tracking** (`utils/antigravityVersion.js`): backend gates model access on client version — a stale UA is itself a fingerprint.
- Resolution order: `ANTIGRAVITY_IDE_VERSION` env → manifest-discovered → pinned `2.11.0` (`DEFAULT_ANTIGRAVITY_VERSION`, also `ANTIGRAVITY_IDE_VERSION` in shared.js).
- Manifest: `https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml` (electron-builder YAML, `version:` line parsed).
- **Lazy**: `ensureAntigravityVersion()` fires fire-and-forget inside `buildHeaders` — deliberately NOT in the constructor (singletons are built at import time; a constructor fetch pollutes tests and fires network on bare import). First request uses pinned version; later ones use discovered.
- Discovery failure is silent; in-flight promise deduped; cleared on failure so next request retries.

**loadCodeAssist/onboardUser headers** (`ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS`, appConstants.js:164): only `Content-Type` + IDE `User-Agent`. The real IDE does NOT send `X-Goog-Api-Client`/`Client-Metadata` on these calls — Google fingerprints them and silently refuses to provision `cloudaicompanionProject`. (Contrast: `LOAD_CODE_ASSIST_HEADERS` for gemini-cli DOES send them.)

---

## 6. Anti-Detection Rules (the parts that break silently)

These exist because upstream answers flagged requests with a **bare `429 RESOURCE_EXHAUSTED` indistinguishable from real quota**. When debugging "quota exhausted" errors, check these first.

### 6.1 No `requestType` on text requests
The official consumer Cloud Code client omits `requestType`; the `"agent"` lane is a rate-limited bucket → bare 429. `requestType` is only sent for `image_gen`. `buildIdeRequestId` still uses `"agent"` internally for trajectory seeding only. (executor:385-389, openai-to-gemini.js:282-285)

### 6.2 systemInstruction sanitization
Two passes (executor:346-354):

- **`ANTIGRAVITY_PROMPT_REWRITES`** (appConstants.js:179) — competing-client branding:
  | From | To |
  |---|---|
  | `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` | `""` |
  | `/google-antigravity\//g` | `""` |
  | `/opencode/gi` | case-preserving → `Antigravity`/`ANTIGRAVITY`/`antigravity` |
  | `/zcode/gi` | case-preserving → `Antigravity`/`ANTIGRAVITY`/`antigravity` |
  | `/\bz\.ai\b/gi` | `"Google DeepMind"` |
- **Zero-width obfuscation**: `DEFAULT_ANTIGRAVITY_SENSITIVE_WORDS = ["RFC 2119"]` — inserts `U+200B` after the first char of each literal match (`R\u200BFC 2119`). Override via env `ANTIGRAVITY_SENSITIVE_WORDS` (comma-separated, ≥2 chars); set empty to disable.

### 6.3 Thinking tiers on the wire
Wire model ids are **clean** — no synthetic `(tier)` suffix (upstream 404s them). Tier travels in `generationConfig.thinkingConfig.thinkingLevel` (executor:63-70):

| Wire id pattern | thinkingLevel |
|---|---|
| `gemini-pro-agent`, `gemini-3-flash-agent`, `*-high` | `HIGH` |
| `*-medium` | `MEDIUM` |
| `*-low`, `*-extra-low` | `LOW` |
| non-gemini / image / unmatched | none (no thinkingConfig) |

`MINIMAL` is never emitted — 400s on gemini ≥ 3.7. Model aliases: `gemini-3.5-flash-high` → `gemini-3-flash-agent`, `gemini-3.1-pro` → `gemini-pro-agent` (registry `upstreamModelId`).

### 6.4 `request.labels` telemetry parity
`buildAntigravityLabels` (executor:87) — must live at `request.labels` (root-level `labels` → 400):
- `trajectory_id`, `last_step_index` — parsed from the `agent/.../traj/step` requestId.
- `model_enum` — `MODEL_PLACEHOLDER_M*` tokens per `ANTIGRAVITY_WIRE_PROFILES` (only for the 5 pinned ids; Claude ids carry none).
- `used_claude: "1"`, `used_claude_conservative: "1"` — when wire id contains `claude`.

### 6.5 Tool cloaking — CURRENTLY DISABLED
`AntigravityExecutor.cloakTools` (executor:557) renames client tools with `_ide` suffix + injects 21 `AG_DECOY_TOOLS` (native AG tool names with "currently unavailable" stubs) + rewrites `functionCall`/`functionResponse` names in history. **The call site in `translator/index.js:149-156` is commented out** — cloaking is dead code right now. `AG_DEFAULT_TOOLS`/`AG_TOOL_SUFFIX` constants still used by it. Re-enable there if upstream starts flagging tool lists again; `toolNameMap` plumbing (`_toolNameMap` → `state.toolNameMap` → decloak in `gemini-to-openai.js:20`) is still wired.

### 6.6 `sessionId`
`resolveSessionId` (utils/sessionManager) → `toNumericSessionId` — upstream expects numeric session ids; falls back to raw id. Client session id captured in `translateRequest` → `credentials._clientSessionId` (translator/index.js:77-80).

---

## 7. Retry & Error Handling

Two-level mechanism in `BaseExecutor.execute` (base.js:100-184):

1. **Same-URL retry** (`tryRetry` + registry `transport.retry`): `429`/`500`/`503` → 3 attempts each. Delay from `computeRetryDelay` hook (executor:524):
   - `Retry-After` header (seconds or HTTP-date), `x-ratelimit-reset-after`, `x-ratelimit-reset` → capped at `MAX_RETRY_AFTER_MS = 10s`; over cap → veto retry (`false`) → falls to next URL.
   - Error body `"quota will reset after 2h7m23s"` parsed by `parseRetryFromErrorMessage`.
   - Transient errors (statuses 500/502/503/504 or messages matching `high traffic|capacity|temporarily unavailable|timeout|stream ended|empty response|agent terminated`) → exponential backoff `1s * 2^attempt`, cap 10s (429) / 15s (other).
   - Non-transient → `false` → fallback.
2. **Cross-URL failover** (`shouldRetry`): 429/5xx/403/404 → next baseUrl (§3).

Network exceptions map to the 502 retry entry; connect timeout = `FETCH_CONNECT_TIMEOUT_MS` via AbortController; client aborts propagate (not retried).

**Debug tip:** `dbg("FETCH", ...)` logs URL, body size, status, TTFT — enable debug logging to trace which lane served a request.

---

## 8. OAuth & Credential Lifecycle

**Client credentials** (public Antigravity IDE client, single source = `ANTIGRAVITY_OAUTH_CLIENT` in `providers/shared.js:96`; duplicated into registry `transport.clientId/clientSecret` and `src/lib/oauth/constants/oauth.js` `ANTIGRAVITY_CONFIG`):
- clientId: `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`
- Test `antigravity-oauth-client.test.js` pins this arrangement — update all three spots or the test fails.

**Scopes** (registry `oauth.scopes`): `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs`.

**Flow** (`AntigravityService.connect`, services/antigravity.js:227):
1. `startLocalServer` → `http://localhost:<port>/callback`; auth URL opened in browser (`access_type=offline`, `prompt=consent`, 32-byte state).
2. `exchangeCode` → `oauth2.googleapis.com/token` (authorization_code).
3. `getUserInfo` → `googleapis.com/oauth2/v1/userinfo`.
4. `loadCodeAssist` (PROD, IDE UA only) → `{ cloudaicompanionProject, allowedTiers[] }` → `projectId` + `tierId` (default `legacy-tier`).
5. `completeOnboarding` → `onboardUser` retried ≤10× every 5s until `done:true` → final `projectId`.
6. `saveTokens` → `POST /api/cli/providers/antigravity` → DB: `{ accessToken, refreshToken, expiresIn, scope, email, projectId }`.

Dashboard path uses `providers/antigravity.js` `postExchange` (same loadCodeAssist/onboard, fire-and-forget onboard).

**Refresh** (`refreshCredentials`, executor:402): standard Google `refresh_token` grant with the IDE clientId/secret; `refreshLeadMs: 300000` (refresh 5 min before expiry, via `shouldRefreshCredentials`). New `refresh_token` kept if returned, else old one retained; `projectId` preserved.

---

## 9. Models & Wire IDs

Registry `models[]` (antigravity.js:47-77). Key mappings:

| Dashboard id | Wire id (`upstreamModelId`) | Notes |
|---|---|---|
| `gemini-3.8-flash-high/medium/low` | same | tier via thinkingConfig |
| `gemini-3.8-flash` | `gemini-3.8-flash-medium` | default → medium |
| `gemini-3.7-flash-*`, `3.6-flash-*` | same | |
| `gemini-3.5-flash-high` | `gemini-3-flash-agent` | 3.5 has no `-high` id; agent id IS the high tier |
| `gemini-3.1-pro` | `gemini-pro-agent` | |
| `claude-sonnet-4-6`, `claude-opus-4-6-thinking` | same | labels get `used_claude` |
| `gpt-oss-120b-medium` | same | |
| `gemini-3.1-flash-image` | same | `kind: "image"`, `imageGen: true`; suffix `-WxH` or `-AxB` → `imageConfig.aspectRatio` |

`ANTIGRAVITY_WIRE_PROFILES` (executor:76) — only 5 ids have `model_enum` telemetry + raised `maxOutputTokens` (65536/65535); everything else caps at 64000.

---

## 10. Usage / Quota

`features.usage: true` → `getAntigravityUsage` in `services/usage/google.js`:
- `fetchAvailableModels` → per-model buckets (`remainingFraction` → normalized /1000, `resetTime`).
- `retrieveUserQuotaSummary` → weekly buckets via `fetchAntigravityWeeklyQuota` (antigravity-weekly.js): groups matched by `/gemini/i` → `gemini_weekly`, `/claude|gpt/i` → `claude_gpt_weekly`; 3-min TTL cache + in-flight dedup per `token::project`; **never throws** (best-effort).
- `projectId` resolution: connection-stored → `loadCodeAssist` fallback; `normalizeCloudCodeProjectId` handles `{id}` object form.

---

## 11. Debug Playbook

| Symptom | Likely cause | Where to look |
|---|---|---|
| Bare `429 RESOURCE_EXHAUSTED`, no quota details | Fingerprint flag, NOT real quota: `requestType` leaked, branding in systemInstruction, sensitive word, stale UA version | executor:385 (requestType), appConstants:179 (rewrites), `ANTIGRAVITY_SENSITIVE_WORDS`, `getAntigravityVersion()` |
| `404 "Requested entity was not found"` on daily hosts | Account licensed on PROD only | Failover chain §3 — should auto-reach PROD; check `shouldRetry` |
| `403 "no valid license"` | Same as above | Same |
| `400` mentioning thinking fields | Blacklist leak — new thinking field name added upstream | `ANTIGRAVITY_REQUEST_BLACKLIST` (executor:44) |
| `400` on `functionCall` | Missing `thoughtSignature` on Gemini 3+ | executor:287-306 backfill; `thoughtSignatureStore` |
| Tool schema 400 / empty params | `$ref` stripped or unsupported schema keys | `cleanJSONSchemaForAntigravity` in formats/gemini.js:343 |
| `IN 0 \| OUT 0` in usage logs | usageMetadata read path — it's inside `{response}` envelope | gemini-to-openai.js usage extraction |
| UA version stale / model gated | Manifest fetch failed | `ANTIGRAVITY_IDE_VERSION` env override; check manifest URL reachability |
| Onboarding never completes | `X-Goog-Api-Client`/`Client-Metadata` sent on loadCodeAssist | Must use `ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS` (appConstants:164) |
| Root `labels` 400 | labels placed on envelope root | Must be `request.labels` (executor:390) |
| Token refresh fails | Missing `refreshToken` or revoked | executor:402; re-run OAuth connect |

**Quick checks:**
- `dbg` FETCH logs show which baseUrl served + status + TTFT.
- `tests/unit/antigravity-oauth-client.test.js` — credential-source integrity.
- `tests/__baseline__/verify-providers.mjs` — registry snapshot drift.
- Env overrides: `ANTIGRAVITY_IDE_VERSION`, `ANTIGRAVITY_SENSITIVE_WORDS`.

---

## 12. Invariants (don't break these)

1. `requestType` only on `image_gen` — never on text chat.
2. `labels` under `request`, never envelope root.
3. Wire model ids stay clean; tier goes in `thinkingConfig.thinkingLevel`.
4. `loadCodeAssist`/`onboardUser` → PROD host + minimal headers (no `X-Goog-Api-Client`).
5. Failover order daily → sandbox → prod; 403/404 must fail over.
6. `functionCall` parts need `thoughtSignature` (first call per turn).
7. Version discovery stays lazy (never in constructor/module top-level).
8. OAuth clientId/secret single-sourced from `ANTIGRAVITY_OAUTH_CLIENT` (3 consumption points kept in sync by test).
9. `cloakTools` is currently disabled at `translator/index.js:149` — don't assume tool names are suffixed on the wire.
