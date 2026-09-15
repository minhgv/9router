# Devin Provider — Architecture & Debug Guide

> Provider `devin` (alias `dv`) — routes requests to Cognition's **Cascade backend** (`server.codeium.com`, the same infra as Windsurf/Codeium) over **ConnectRPC + protobuf**, impersonating the released **devin-cli** (codename `chisel`). OAuth PKCE login, long-lived session token, no refresh endpoint.
>
> **Design reference:** wire format and request profile are wire-captured from the released `devin-cli` (chisel) 3000.6.2. When upstream behavior changes, diff against that binary's traffic first. Legacy `devin-cli` subprocess provider was removed (migration `002-remove-devin-cli-connections.js`).

---

## 1. File Map

| Layer | File | Role |
|---|---|---|
| Registry | `open-sse/providers/registry/devin.js` | Provider config: OAuth endpoints, static model catalog (24 entries) |
| Executor | `open-sse/executors/devin.js` | `DevinExecutor` — full custom `execute()`: GetUserJwt → AssignModel → GetChatMessage, Connect stream → OpenAI SSE |
| Protobuf codec | `open-sse/utils/devinProtobuf.js` | Hand-rolled proto3 codec (ProtoWriter/ProtoReader), IR schemas, Connect framing, metadata builders, token/url helpers |
| Model discovery | `open-sse/services/devinModels.js` | `GetCliModelConfigs` unary RPC → live model lineup (~398 entries) for the dashboard |
| Usage/quota | `open-sse/services/usage/devin.js` | `GetUserStatus` unary RPC → daily/weekly quota %, prompt credits, plan info |
| Capabilities | `open-sse/providers/capabilities.js:135-152` | Per-model `reasoning`/`vision`/`contextWindow`/`maxOutput` |
| Pricing | `open-sse/providers/pricing.js:130-147` | Metered SWE rates; third-party models are ACU-billed (0.00 token rates) |
| OAuth provider | `src/lib/oauth/providers/devin.js` | PKCE flow definition (authorize URL, JSON token exchange, mapTokens) |
| OAuth constants | `src/lib/oauth/constants/oauth.js:127` | `DEVIN_CONFIG = PROVIDER_OAUTH["devin"]` |
| Loopback proxy | `src/lib/oauth/utils/server.js:940-1042` | Fixed-port `127.0.0.1:59653` callback server + server-side token exchange |
| OAuth route | `src/app/api/oauth/[provider]/[action]/route.js` | `start`/`poll`/`stop` actions wired for `devin` |
| Models route | `src/app/api/providers/[id]/models/route.js:470` | `customResolver` → `resolveDevinModels` |
| Token refresh | `open-sse/services/tokenRefresh.js:155` | `devin: () => null` — no refresh endpoint |
| Migration | `src/lib/db/migrations/002-remove-devin-cli-connections.js` | Drops stale `devin-cli` connection rows |
| Tests | `tests/unit/devin-executor.test.js`, `devin-protobuf.test.js`, `devin-models-usage.test.js`, `devin-oauth-provider.test.js` | Wire-level mocked edge (GetUserJwt/AssignModel/GetChatMessage recorder) |

---

## 2. Transport — ConnectRPC over Protobuf

Unlike most providers, Devin does **not** speak JSON/OpenAI upstream. All calls are protobuf over HTTP to `https://server.codeium.com`:

| RPC | Path | Type | Purpose |
|---|---|---|---|
| `GetUserJwt` | `/exa.auth_pb.AuthService/GetUserJwt` | unary | Session token → short-lived `userJwt` + optional `customApiServerUrl` |
| `AssignModel` | `/exa.api_server_pb.ApiServerService/AssignModel` | unary | Router model (`adaptive`) → concrete `modelUid` + `assignmentJwt` |
| `GetChatMessage` | `/exa.api_server_pb.ApiServerService/GetChatMessage` | **server-streaming** | The chat call — Connect-framed protobuf stream |
| `GetUserStatus` | `/exa.seat_management_pb.SeatManagementService/GetUserStatus` | unary | Quota/plan for dashboard |
| `GetCliModelConfigs` | `/exa.api_server_pb.ApiServerService/GetCliModelConfigs` | unary | Live model catalog for dashboard |

**Unary calls** (`GetUserJwt`, `AssignModel`, `GetUserStatus`, `GetCliModelConfigs`):
- `content-type: application/proto`, `connect-protocol-version: 1` — **bare protobuf body, no Connect envelope**.
- Discovery/usage calls add `authorization: Basic {token}-{token}` (session token repeated on both sides of `-`) — wire-captured shape, see `buildDevinUnaryHeaders` (devinModels.js:27).
- Response decoded by `decodeDevinUnaryMessage` — tries bare protobuf, falls back to gunzip.

**Streaming call** (`GetChatMessage`):
- `content-type: application/connect+proto`, `connect-protocol-version: 1`, `connect-content-encoding: gzip`, `connect-accept-encoding: gzip`, `accept-encoding: identity`, `user-agent: connect-go/1.18.1 (go1.26.3)`.
- Request body = one Connect frame: `1B flags | 4B BE length | payload`. Flag `0x01` = gzip-compressed protobuf.
- Response = stream of Connect frames; flag `0x02` = end-stream trailer frame whose payload is JSON `{"error":{code,message}}` on failure.

**Codec** (`devinProtobuf.js`): hand-rolled proto3 writer/reader with IR schemas (`{no, name, kind, T, repeat, optional}`). Critical detail: `int32` fields decode through the **64-bit varint path** — proto3 sign-extends negatives to 10-byte varints (`monthlyPromptCredits: -1` = unlimited plan). A 32-bit decoder crashes with "Varint exceeds 32 bits".

---

## 3. Request Lifecycle

```
Client (OpenAI format — registry transport.format = "openai")
  → src/app/api/v1/* → src/sse/handlers/chat.js → chatCore.js
  → DevinExecutor.execute()                       [custom, bypasses BaseExecutor.execute]
      1. resolveSessionToken  → normalizeDevinSessionToken (adds "devin-session-token$" prefix)
      2. resolveModelId       → strips "devin/"/"dv/" prefix; default "swe-1-6"
      3. fetchUserJwt         → POST GetUserJwt → {userJwt, customApiServerUrl?}
      4. assignModel          → ONLY if modelMeta.modelRouter (e.g. "adaptive")
      5. buildChatPayload     → GetChatMessageRequest protobuf (§4)
      6. POST GetChatMessage  → Connect-framed gzip protobuf
      7. createSseStream      → Connect frames → OpenAI SSE chunks (§5)
  → SSE to client
```

Retry: `maxRetries = 2` around steps 3–6 (pre-stream only). `shouldRetry`: 429 or 5xx. `computeRetryDelay`: `Retry-After` header else `1s * 2^attempt`, both capped 30s. **Once the stream starts, no replay** — mid-stream errors become an SSE `error` event + `[DONE]` (§6.3).

---

## 4. `buildChatPayload()` — The CASCADE Wire Profile

Mirrors released devin-cli 3000.6.2, `requestType: CASCADE` (**enum value 5**, NOT 3 — 3 is `PLAN`; wrong value silently degrades the model surface).

```jsonc
{
  metadata: devinCliMetadata(sessionToken, userJwt),  // §7
  prompt: "<sanitized system prompt>",               // all system/developer msgs joined \n\n
  chatMessagePrompts: [ /* user/assistant/tool turns, §4.1 */ ],
  chatModelUid: "<assigned uid | wire model>",       // router uid NEVER sent here
  modelAssignmentJwt: "<from AssignModel>",          // only for router models
  requestType: 5,                                    // CASCADE
  plannerMode: 1,                                    // DEFAULT
  toolChoice: { optionName: "auto" },
  systemPromptCacheOptions: { type: 1 },             // EPHEMERAL
  disableParallelToolCalls: !modelMeta.supportsParallelToolCalls,
  cascadeId: "<uuid, shared with AssignModel>",
  executionId: "<uuid>",
  configuration: {
    numCompletions: 1, maxTokens, maxNewlines: 200,
    temperature: 0.4, firstTemperature: 0.4,         // both set (CLI parity)
    topK: 50, topP: 1,
    stopPatterns: ["<|user|>","<|bot|>","<|context_request|>","<|endoftext|>","<|end_of_turn|>", ...callerStops],
    fimEotProbThreshold: 1,
  },
  tools: [{ name, description /*sanitized*/, jsonSchemaString, strict }],
}
```

`maxTokens` resolution: `body.max_tokens ?? body.max_completion_tokens ?? modelMeta.maxOutputTokens ?? 128000`.

### 4.1 Message mapping (`mapMessages`)

- `system`/`developer` → joined into top-level `prompt` (then sanitized).
- `user` → `ChatMessagePrompt{source: USER(1), prompt, images[]}` — `image_url` data-URIs and Claude `image` blocks → `{mimeType, base64Data}`.
- `assistant` → `source: SYSTEM(2)`, `toolCalls[{id, name, argumentsJson}]`; **`thinking` and `signature` are NEVER replayed** (empty strings).
- `tool` → `source: TOOL(4)`, `toolCallId`, `toolResultIsError` (from `is_error`/`status:"error"`/`content` starting `"Error:"`).
- `messageId` = `deterministicUuid(cascadeId + idx + role + tool_call_id)` — sha256-derived, stable across retries.

### 4.2 Router models (`adaptive`)

`modelRouter: true` in registry → `AssignModel` runs **before** chat:
- Request: `{metadata (no userJwt), modelRouterUid, cascadeId, chatMessagePrompt}` — prompt is **only the latest user/developer turn**, never full history.
- Response must carry non-empty `modelUid` + `assignmentJwt`; if the server echoes a router uid back → **fail the turn** (no fallback — router uid is not a legal `chatModelUid`).
- The assigned uid + JWT bind to the same `cascadeId` in `GetChatMessage`.

---

## 5. Stream Decoding (`createSseStream`)

Connect frames → OpenAI `chat.completion.chunk` SSE:

| Protobuf field | Emitted as |
|---|---|
| `deltaThinking` | `delta.reasoning_content` |
| `deltaText` | `delta.content` |
| `deltaToolCalls[]` | `delta.tool_calls[]` (see quirks below) |
| `stopReason` | tracked → final `finish_reason` (`MAX_TOKENS`→`length`, `FUNCTION_CALL`→`tool_calls`, else `stop`; any tool call → `tool_calls`) |
| `usage` | accumulated → final chunk `usage` (`prompt_tokens` includes `cacheReadTokens`; `cached_tokens` detail) |
| `creditCost`, `committed*` | accumulated → `usage.credit_cost` when > 0 |
| `actualModelUid` | overrides response `model` (router-assigned real model) |
| `messageId` | response `id` |

**Tool-call quirks (OMP parity):**
- Continuation frames may omit `id` → falls back to `activeToolCallId` (never mints a spurious call).
- `argumentsJson` may be a suffix delta **or** the full accumulated JSON resent → tracked per-id in `toolArgsJson`; only the new suffix is emitted so client-side concatenation stays valid JSON.
- `id`/`type:"function"`/`name` emitted only on the first chunk of each call.

**Trailer frame** (`flags & 0x02`): payload is JSON; `error` → `parseConnectTrailerError`. Special case: `invalid_argument` + "internal error" + request ≥ 512KiB before first byte → `isContextOverflow` error (history too large).

---

## 6. Anti-Detection & Error Surfacing

### 6.1 Content classifier sanitization
Upstream runs a semantic classifier over the serialized payload; flagged requests return a `permission_denied` Connect trailer. Two deterministic triggers (verified against `server.codeium.com`):

1. **System-prompt paragraphs enumerating ≥2 offensive-security terms** (`DEVIN_POLICY_TERM_PATTERNS`: ddos, botnet, ransomware, keylogger, rootkit, malware, exploit kits/chains, credential stuffing/harvesting, c2 frameworks, supply-chain attacks, detection evasion, mass targeting). The whole paragraph is **dropped** — the same terms inside a refusal frame pass, so word substitution doesn't help. (e.g. ZCode's dual-use security policy paragraph.)
2. **Tool descriptions pairing `<name>_id` with "parameter identifying"** → rewritten to "argument identifying" (verified equivalent upstream).
3. **Third-party harness identity**: `zcode` → `Devin` in both system prompt and tool descriptions.

Sanitizers are exported (`sanitizeDevinSystemPrompt`, `sanitizeDevinToolDescription`) and logged via `log.info("DEVIN", "sanitized client text…")`.

### 6.2 Client identity metadata
`devinCliMetadata` (devinProtobuf.js:606) — the backend gates `AssignModel` and the CASCADE model surface on this tuple:
```
ideName: "devin-cli", ideType: "chisel", extensionName: "chisel",
ideVersion: env DEVIN_IDE_VERSION || "3000.6.2",
locale: "en", os: darwin|windows|linux, apiKey: <normalized session token>, userJwt?
```
Discovery calls use `devinDiscoveryMetadata` instead: `ideName: "chisel"`, `ideVersion: "0.0.0-dev"`, plus `supportedModelDisplays: [3,4,6,7,8]` (MODEL_ROUTER, QUICK_REVIEW, internal-default, unclassified, normal).

### 6.3 Mid-stream error surfacing
Upstream errors arriving mid-stream (incl. Connect trailer errors like `unavailable`) are emitted as a well-formed SSE `data: {error:{...}}` + `[DONE]` — **never** `controller.error()`. Reason: erroring the ReadableStream makes Next.js abort with "failed to pipe response" and the client sees curl-52 empty reply. The non-stream path (`nonStreamingHandler.js:293`) maps the SSE error event to a `502` JSON and re-enables account fallback. Client aborts still error the stream normally.

### 6.4 `customApiServerUrl` override
`GetUserJwt` may return a per-account API server. `sanitizeCustomApiServerUrl` accepts it only if: `https:`, no userinfo, hostname not IP/localhost — else ignored (SSRF guard).

---

## 7. OAuth & Credential Lifecycle

**Flow** (`authorization_code_pkce`, devin-cli parity — `providers/devin.js`):
1. Authorize: `https://app.devin.ai/auth/cli/continue?response_type=code&redirect_uri=http://127.0.0.1:59653/callback&code_challenge=<S256>&code_challenge_method=S256&state=<uuid>&prompt=select_account` — **no `client_id`** (the CLI sends none).
2. Callback on **fixed port 59653** (`loopbackPort`) — handled by `startDevinProxy` in `utils/server.js` (5-min timeout).
3. Token exchange: `POST https://api.devin.ai/auth/cli/token` — **JSON** `{code, code_verifier}` (not form-encoded) → `{token}`.
4. Token (`devin-session-token$…` or bare JWT) stored as `accessToken` — **non-expiring, no `expiresAt`, no refresh endpoint**. `tokenRefresh.js` registers `devin: () => null`; `needsRefresh()`/`refreshCredentials()` in the executor are no-ops. Expiry → 401/403 → re-login is the only path.

Two callback modes in the proxy: **Mode A** server-side exchange (session registered via `registerDevinSession` → exchange + `createProviderConnection` inline), **Mode B** 302 redirect fallback to the app.

Per-request auth: session token goes in `metadata.apiKey` (normalized with `devin-session-token$` prefix); `userJwt` from `GetUserJwt` rides in `metadata.userJwt` for chat only (AssignModel omits it, matching the CLI).

---

## 8. Models

Static catalog in registry (24 entries); dashboard fetches the live lineup via `resolveDevinModels` → `GetCliModelConfigs` (filters `modelType === 2` CHAT, dedups by `modelUid`, exposes `creditMultiplier`, `contextLength`, `maxOutputTokens`, `supportsImages/Thinking/ToolCalls/ParallelToolCalls`, `modelRouter`, `family`, `isRecommended`).

| Group | Ids | Notes |
|---|---|---|
| SWE-2 | `swe-2-high`, `swe-2-medium`, `swe-2-max` | 262k ctx, parallel tools |
| SWE-1.7 | `swe-1-7`, `-medium`, `-lightning`, `-lightning-medium` | 262k / 202k (lightning) |
| Router | `adaptive` | `modelRouter: true`, `maxOutputTokens: 64000` — resolves via AssignModel |
| Third-party | `claude-opus-5-medium`, `claude-fable-5-1-medium`, `claude-sonnet-5-medium`, `gemini-3-8-flash-medium`, `gpt-5-6-sol/luna-medium`, `gpt-6-astra-medium`, `glm-5-2`, `glm-5-3-low/high/max`, `kimi-k3-high` | ACU-billed (`creditMultiplier`), no per-token metered rate |
| Legacy | `swe-check`, `swe-1-6`, `swe-1-6-fast` | Kept for existing combos; absent from current discovery |

Unknown ids (not in registry) are treated as **concrete models** — direct chat lane, no AssignModel.

Pricing: SWE models metered (`swe-2-high`: $0.75/$3.75 per Mtok); third-party entries are `0.00` — billed in ACUs on the Devin plan.

---

## 9. Usage / Quota

`getDevinUsage` → `GetUserStatus` (unary, Basic-auth headers):
- `planStatus.dailyQuotaRemainingPercent` / `weeklyQuotaRemainingPercent` (0–100) → `Daily quota`/`Weekly quota` buckets with `resetAt`.
- `planInfo.monthlyPromptCredits` + `planStatus.availablePromptCredits` → `Prompt credits` bucket; **`available < 0` → `unlimited: true`** (plan reports -1).
- `plan`: `planInfo.planName` else `Pro`/`Free` from `status.pro`; `expiresAt` from `planStatus.planEnd`.
- 401/403 → "session expired, re-login" message.
- `providerSpecificData.apiBaseUrl` can override the base URL.

---

## 10. Debug Playbook

| Symptom | Likely cause | Where to look |
|---|---|---|
| Connect trailer `permission_denied` | Content classifier: offensive-security paragraph in system prompt, or `<name>_id parameter identifying` tool description | `sanitizeDevinSystemPrompt`/`sanitizeDevinToolDescription` (executor:865/882); check `DEVIN` info log for "sanitized client text" |
| `adaptive` fails before chat | AssignModel returned blank fields or echoed a router uid | executor:391-402; router uid is never a legal `chatModelUid` |
| Wrong/degraded model surface | `requestType` not 5, or metadata tuple off | `ChatMessageRequestType.CASCADE = 5` (devinProtobuf:35); `devinCliMetadata` |
| "Varint exceeds 32 bits" | Negative int32 field decoded via 32-bit path | All int32 reads go through 64-bit varint decode (fixed; regression = check `readScalarValue`) |
| Client sees empty reply (curl 52) | Stream errored instead of SSE error event | `createSseStream` catch must emit `data:{error}` + `[DONE]`, never `controller.error` for upstream errors |
| Tool args = invalid JSON client-side | `argumentsJson` full-resend vs suffix-delta mishandled | `toolArgsJson` accumulation (executor:650-656) |
| Spurious extra tool calls | Continuation frame without `id` minted a new call | `activeToolCallId` fallback (executor:643) |
| 401/403 on any RPC | Session token expired — no refresh exists | Re-login via OAuth; `tokenRefresh.js:155` |
| Chat hits wrong host | `customApiServerUrl` override accepted/rejected | `sanitizeCustomApiServerUrl` (devinProtobuf:640) |
| Context overflow error | Request ≥512KiB + `invalid_argument`/"internal error" trailer | executor:586-598 — trim history |
| Discovery returns 0 models | `supportedModelDisplays` or `modelType !== 2` filter | `devinDiscoveryMetadata`, `parseDevinModelConfigs:54` |
| Quota shows nothing | `availablePromptCredits`/`monthlyPromptCredits` edge cases | `parseDevinUserStatus` (usage/devin.js:44) |

**Env overrides:** `DEVIN_IDE_VERSION` (default `3000.6.2`).

**Tests:** `devin-executor.test.js` mocks the whole edge (GetUserJwt/AssignModel/GetChatMessage recorder asserting call order + decoding real wire bodies) — best place to reproduce wire bugs. `devin-protobuf.test.js` covers codec edge cases (varint boundaries, unknown-field skipping, frame truncation).

---

## 11. Invariants (don't break these)

1. `requestType: CASCADE` = **5**, not 3 (`PLAN`).
2. Router uid (`adaptive`) is never sent as `chatModelUid` — AssignModel first, bind `modelAssignmentJwt` + same `cascadeId`.
3. Unary RPCs use bare `application/proto` (no Connect envelope); only `GetChatMessage` uses Connect framing.
4. Discovery/usage unary calls send `Basic {token}-{token}` auth; chat sends no `Authorization` header (auth lives in `metadata.apiKey`/`userJwt`).
5. `thinking`/`signature` on assistant history are NEVER replayed.
6. Mid-stream upstream errors → SSE `error` event + `[DONE]`, never `controller.error` (except client abort).
7. Session token always normalized to `devin-session-token$…` prefix before hitting the wire.
8. Token exchange is JSON `{code, code_verifier}` with no `client_id`; callback is fixed port 59653.
9. int32 fields decode via the 64-bit varint path (negative values sign-extend to 10-byte varints).
10. `customApiServerUrl` only honored after `sanitizeCustomApiServerUrl` (https, no userinfo, no IP/localhost).
