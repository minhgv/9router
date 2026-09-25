/**
 * Devin (Cognition) Provider Registry Entry
 * Transport uses ConnectRPC protobuf via dedicated DevinExecutor.
 */

export default {
  id: "devin",
  alias: "dv",
  aliases: ["devin"],
  uiAlias: "dv",

  // Short/dotted client aliases (oh-my-pi parity, _collapse.kdl provider-alias
  // list) — resolved by DevinExecutor.resolveModelId after prefix/suffix strip.
  providerAliases: {
    swe: "swe-1-7-lightning",
    opus: "claude-opus-5",
    sonnet: "claude-sonnet-5",
    claude: "claude-sonnet-5",
    haiku: "claude-haiku-4-5",
    gemini: "gemini-3-7-flash",
    gpt: "gpt-5-6-terra",
    codex: "gpt-5-3-codex",
    "claude-haiku-4.5": "claude-haiku-4-5",
    "gemini-3.7-flash": "gemini-3-7-flash",
    "glm-5.2": "glm-5-2",
    "gpt-5.6-luna": "gpt-5-6-luna",
    "gpt-5.6-sol": "gpt-5-6-sol",
    "gpt-5.6-terra": "gpt-5-6-terra",
    "grok-4.6": "grok-4-6",
    "swe-1.7": "swe-1-7",
    "swe-1.7-lightning": "swe-1-7-lightning",
  },

  display: {
    name: "Devin",
    icon: "smart_toy",
    color: "#6366F1",
    textIcon: "DV",
    website: "https://devin.ai",
  },

  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth", "apikey"],

  transport: {
    baseUrl: "https://server.codeium.com",
    format: "openai",
  },

  // OAuth PKCE flow mirroring devin-cli (chisel): browser authorize at
  // app.devin.ai → loopback callback 127.0.0.1:59653/callback?code →
  // POST api.devin.ai/auth/cli/token {code, code_verifier} → {token}.
  // The token ("devin-session-token$..." or bare JWT) is a long-lived session
  // credential — there is no refresh endpoint.
  oauth: {
    authorizeUrl: "https://app.devin.ai/auth/cli/continue",
    tokenUrl: "https://api.devin.ai/auth/cli/token",
    codeChallengeMethod: "S256",
    loopbackPort: 59653,
    callbackPath: "/callback",
    extraParams: { prompt: "select_account" },
  },

  // Static catalog snapshot (2026-09) from GetCliModelConfigs on
  // server.codeium.com: the 15 picker-recommended models plus the SWE tiers
  // and legacy entries. The dashboard fetches the live 398-entry lineup via
  // the devin modelsResolver (open-sse/services/devinModels.js).
  // Execution-relevant flags mirror the working released-CLI runtime:
  //   modelRouter — server-side router (adaptive/fusion): resolved through
  //     AssignModel before chat; the router uid itself is never a chatModelUid.
  //   supportsParallelToolCalls — drives the CASCADE disableParallelToolCalls
  //     field; absent = parallel tool calls disabled (matches runtime cache).
  //   maxOutputTokens — model-aware token ceiling when the caller sends none.
  //   effortRouting/defaultMember/efforts/requiresEffort — logical variant
  //     families: the executor collapses reasoning_effort (or the model(level)
  //     suffix) into the sibling wire uid at request time; raw sibling ids
  //     below remain valid.
  models: [
    // SWE (Devin's in-house coding family)
    { id: "swe-2-high", name: "SWE-2 High", contextLength: 262000, toolUse: true, supportsParallelToolCalls: true },
    { id: "swe-2-medium", name: "SWE-2 Medium", contextLength: 262000, toolUse: true, supportsParallelToolCalls: true },
    { id: "swe-2-max", name: "SWE-2 Max", contextLength: 262000, toolUse: true, supportsParallelToolCalls: true },
    // swe-1-7 / swe-1-7-lightning / glm-5-2 double as logical family ids: the
    // raw max-tier uid IS the family label normalized, so the routing table
    // merges into the existing entry (no duplicate rows).
    { id: "swe-1-7", name: "SWE-1.7", contextLength: 262000, toolUse: true, supportsParallelToolCalls: true,
      effortRouting: { medium: "swe-1-7-medium", max: "swe-1-7" }, defaultMember: "swe-1-7", efforts: ["medium", "max"], requiresEffort: true },
    { id: "swe-1-7-medium", name: "SWE-1.7 Medium", contextLength: 262000, toolUse: true, supportsParallelToolCalls: true },
    { id: "swe-1-7-lightning", name: "SWE-1.7 Lightning", contextLength: 202752, toolUse: true, supportsParallelToolCalls: true,
      effortRouting: { medium: "swe-1-7-lightning-medium", max: "swe-1-7-lightning" }, defaultMember: "swe-1-7-lightning-medium", efforts: ["medium", "max"], requiresEffort: true },
    { id: "swe-1-7-lightning-medium", name: "SWE-1.7 Lightning Medium", contextLength: 202752, toolUse: true, supportsParallelToolCalls: true },
    { id: "adaptive", name: "Adaptive", toolUse: true, modelRouter: true, maxOutputTokens: 64000 },
    // Recommended third-party models (creditMultiplier = ACU multiplier)
    { id: "claude-opus-5-medium", name: "Claude Opus 5 Medium", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true },
    { id: "claude-fable-5-1-medium", name: "Claude Fable 5.1 Medium", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true },
    { id: "claude-sonnet-5-medium", name: "Claude Sonnet 5 Medium", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true },
    { id: "gemini-3-8-flash-medium", name: "Gemini 3.8 Flash Medium", contextLength: 1048576, toolUse: true, supportsParallelToolCalls: true },
    { id: "gpt-5-6-sol-medium", name: "GPT-5.6 Sol Medium Thinking", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true },
    { id: "gpt-5-6-luna-medium", name: "GPT-5.6 Luna Medium Thinking", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true },
    { id: "gpt-6-astra-medium", name: "GPT-6 Astra Medium Thinking", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true },
    { id: "glm-5-2", name: "GLM-5.2", contextLength: 200000, toolUse: true,
      // Verbatim kdl routes: high and xhigh both serve the base uid.
      effortRouting: { high: "glm-5-2", xhigh: "glm-5-2" }, defaultMember: "glm-5-2", efforts: ["high", "xhigh"], requiresEffort: true },
    { id: "glm-5-3-low", name: "GLM-5.3 Low", contextLength: 1048576, toolUse: true },
    { id: "glm-5-3-high", name: "GLM-5.3 High", contextLength: 1048576, toolUse: true },
    { id: "glm-5-3-max", name: "GLM-5.3 Max", contextLength: 1048576, toolUse: true },
    { id: "kimi-k3-high", name: "Kimi K3 High", contextLength: 1048576, toolUse: true },
    // ── Logical variant families (effort-routed) ────────────────────────
    // Collapse of the effort-tier siblings into one selectable model, ported
    // verbatim from oh-my-pi's taxonomy table (`_collapse.kdl`, devin section).
    // resolveWireUid: effortRouting[effort] ?? nearest ladder tier ??
    // defaultMember; `off` routes exist only for families without
    // requiresEffort. defaultMember = kdl `default-member` when declared,
    // else the picker-recommended tier (medium where one exists). Members
    // missing as rows below are upstream wire uids — they need no registry
    // entry and resolve by raw passthrough at execution time.
    { id: "swe-2", name: "SWE-2", contextLength: 262000, toolUse: true, supportsParallelToolCalls: true,
      effortRouting: { medium: "swe-2-medium", high: "swe-2-high", max: "swe-2-max" }, defaultMember: "swe-2-high", efforts: ["medium", "high", "max"], requiresEffort: true },
    { id: "claude-opus-5", name: "Claude Opus 5", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true,
      effortRouting: { low: "claude-opus-5-low", medium: "claude-opus-5-medium", high: "claude-opus-5-high", xhigh: "claude-opus-5-xhigh", max: "claude-opus-5-max" }, defaultMember: "claude-opus-5-medium", efforts: ["low", "medium", "high", "xhigh", "max"], requiresEffort: true },
    { id: "claude-opus-5-fast", name: "Claude Opus 5 Fast", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true,
      effortRouting: { low: "claude-opus-5-low-fast", medium: "claude-opus-5-medium-fast", high: "claude-opus-5-high-fast", xhigh: "claude-opus-5-xhigh-fast", max: "claude-opus-5-max-fast" }, defaultMember: "claude-opus-5-medium-fast", efforts: ["low", "medium", "high", "xhigh", "max"], requiresEffort: true },
    { id: "claude-fable-5", name: "Claude Fable 5", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true,
      effortRouting: { low: "claude-5-fable-low", medium: "claude-5-fable-medium", high: "claude-5-fable-high", xhigh: "claude-5-fable-xhigh", max: "claude-5-fable-max" }, defaultMember: "claude-5-fable-medium", efforts: ["low", "medium", "high", "xhigh", "max"], requiresEffort: true },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true,
      effortRouting: { low: "claude-sonnet-5-low", medium: "claude-sonnet-5-medium", high: "claude-sonnet-5-high", xhigh: "claude-sonnet-5-xhigh", max: "claude-sonnet-5-max" }, defaultMember: "claude-sonnet-5-medium", efforts: ["low", "medium", "high", "xhigh", "max"], requiresEffort: true },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true,
      effortRouting: { low: "claude-opus-4-7-low", medium: "claude-opus-4-7-medium", high: "claude-opus-4-7-high", xhigh: "claude-opus-4-7-xhigh", max: "claude-opus-4-7-max" }, defaultMember: "claude-opus-4-7-medium", efforts: ["low", "medium", "high", "xhigh", "max"], requiresEffort: true },
    { id: "claude-opus-4-7-fast", name: "Claude Opus 4.7 Fast", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true,
      effortRouting: { low: "claude-opus-4-7-low-fast", medium: "claude-opus-4-7-medium-fast", high: "claude-opus-4-7-high-fast", xhigh: "claude-opus-4-7-xhigh-fast", max: "claude-opus-4-7-max-fast" }, defaultMember: "claude-opus-4-7-medium-fast", efforts: ["low", "medium", "high", "xhigh", "max"], requiresEffort: true },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true,
      effortRouting: { low: "claude-opus-4-8-low", medium: "claude-opus-4-8-medium", high: "claude-opus-4-8-high", xhigh: "claude-opus-4-8-xhigh", max: "claude-opus-4-8-max" }, defaultMember: "claude-opus-4-8-medium", efforts: ["low", "medium", "high", "xhigh", "max"], requiresEffort: true },
    { id: "claude-opus-4-8-fast", name: "Claude Opus 4.8 Fast", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true,
      effortRouting: { low: "claude-opus-4-8-low-fast", medium: "claude-opus-4-8-medium-fast", high: "claude-opus-4-8-high-fast", xhigh: "claude-opus-4-8-xhigh-fast", max: "claude-opus-4-8-max-fast" }, defaultMember: "claude-opus-4-8-medium-fast", efforts: ["low", "medium", "high", "xhigh", "max"], requiresEffort: true },
    { id: "gpt-5-2", name: "GPT-5.2", contextLength: 1000000, toolUse: true,
      effortRouting: { off: "MODEL_GPT_5_2_NONE", low: "MODEL_GPT_5_2_LOW", medium: "MODEL_GPT_5_2_MEDIUM", high: "MODEL_GPT_5_2_HIGH", xhigh: "MODEL_GPT_5_2_XHIGH" }, defaultMember: "MODEL_GPT_5_2_MEDIUM", efforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5-3-codex", name: "GPT-5.3 Codex", contextLength: 1000000, toolUse: true,
      effortRouting: { low: "gpt-5-3-codex-low", medium: "gpt-5-3-codex-medium", high: "gpt-5-3-codex-high", xhigh: "gpt-5-3-codex-xhigh" }, defaultMember: "gpt-5-3-codex-medium", efforts: ["low", "medium", "high", "xhigh"], requiresEffort: true },
    { id: "gpt-5-3-codex-fast", name: "GPT-5.3 Codex Fast", contextLength: 1000000, toolUse: true,
      effortRouting: { low: "gpt-5-3-codex-low-priority", medium: "gpt-5-3-codex-medium-priority", high: "gpt-5-3-codex-high-priority", xhigh: "gpt-5-3-codex-xhigh-priority" }, defaultMember: "gpt-5-3-codex-medium-priority", efforts: ["low", "medium", "high", "xhigh"], requiresEffort: true },
    { id: "gpt-5-4", name: "GPT-5.4", contextLength: 1000000, toolUse: true,
      effortRouting: { off: "gpt-5-4-none", low: "gpt-5-4-low", medium: "gpt-5-4-medium", high: "gpt-5-4-high", xhigh: "gpt-5-4-xhigh" }, defaultMember: "gpt-5-4-medium", efforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5-4-fast", name: "GPT-5.4 Fast", contextLength: 1000000, toolUse: true,
      effortRouting: { off: "gpt-5-4-none-priority", low: "gpt-5-4-low-priority", medium: "gpt-5-4-medium-priority", high: "gpt-5-4-high-priority", xhigh: "gpt-5-4-xhigh-priority" }, defaultMember: "gpt-5-4-medium-priority", efforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5-4-mini", name: "GPT-5.4 Mini", contextLength: 1000000, toolUse: true,
      effortRouting: { low: "gpt-5-4-mini-low", medium: "gpt-5-4-mini-medium", high: "gpt-5-4-mini-high", xhigh: "gpt-5-4-mini-xhigh" }, defaultMember: "gpt-5-4-mini-medium", efforts: ["low", "medium", "high", "xhigh"], requiresEffort: true },
    { id: "gpt-5-5", name: "GPT-5.5", contextLength: 1000000, toolUse: true,
      effortRouting: { off: "gpt-5-5-none", low: "gpt-5-5-low", medium: "gpt-5-5-medium", high: "gpt-5-5-high", xhigh: "gpt-5-5-xhigh" }, defaultMember: "gpt-5-5-medium", efforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5-5-fast", name: "GPT-5.5 Fast", contextLength: 1000000, toolUse: true,
      effortRouting: { off: "gpt-5-5-none-priority", low: "gpt-5-5-low-priority", medium: "gpt-5-5-medium-priority", high: "gpt-5-5-high-priority", xhigh: "gpt-5-5-xhigh-priority" }, defaultMember: "gpt-5-5-medium-priority", efforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5-6-luna", name: "GPT-5.6 Luna", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true,
      effortRouting: { off: "gpt-5-6-luna-none", low: "gpt-5-6-luna-low", medium: "gpt-5-6-luna-medium", high: "gpt-5-6-luna-high", xhigh: "gpt-5-6-luna-xhigh", max: "gpt-5-6-luna-max" }, defaultMember: "gpt-5-6-luna-medium", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-5-6-luna-fast", name: "GPT-5.6 Luna Fast", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true,
      effortRouting: { off: "gpt-5-6-luna-none-priority", low: "gpt-5-6-luna-low-priority", medium: "gpt-5-6-luna-medium-priority", high: "gpt-5-6-luna-high-priority", xhigh: "gpt-5-6-luna-xhigh-priority", max: "gpt-5-6-luna-max-priority" }, defaultMember: "gpt-5-6-luna-medium-priority", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-5-6-sol", name: "GPT-5.6 Sol", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true,
      effortRouting: { off: "gpt-5-6-sol-none", low: "gpt-5-6-sol-low", medium: "gpt-5-6-sol-medium", high: "gpt-5-6-sol-high", xhigh: "gpt-5-6-sol-xhigh", max: "gpt-5-6-sol-max" }, defaultMember: "gpt-5-6-sol-medium", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-5-6-sol-fast", name: "GPT-5.6 Sol Fast", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true,
      effortRouting: { off: "gpt-5-6-sol-none-priority", low: "gpt-5-6-sol-low-priority", medium: "gpt-5-6-sol-medium-priority", high: "gpt-5-6-sol-high-priority", xhigh: "gpt-5-6-sol-xhigh-priority", max: "gpt-5-6-sol-max-priority" }, defaultMember: "gpt-5-6-sol-medium-priority", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-5-6-terra", name: "GPT-5.6 Terra", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true,
      effortRouting: { off: "gpt-5-6-terra-none", low: "gpt-5-6-terra-low", medium: "gpt-5-6-terra-medium", high: "gpt-5-6-terra-high", xhigh: "gpt-5-6-terra-xhigh", max: "gpt-5-6-terra-max" }, defaultMember: "gpt-5-6-terra-medium", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-5-6-terra-fast", name: "GPT-5.6 Terra Fast", contextLength: 1000000, toolUse: true, supportsParallelToolCalls: true,
      effortRouting: { off: "gpt-5-6-terra-none-priority", low: "gpt-5-6-terra-low-priority", medium: "gpt-5-6-terra-medium-priority", high: "gpt-5-6-terra-high-priority", xhigh: "gpt-5-6-terra-xhigh-priority", max: "gpt-5-6-terra-max-priority" }, defaultMember: "gpt-5-6-terra-medium-priority", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "kimi-k3", name: "Kimi K3", contextLength: 1048576, toolUse: true,
      effortRouting: { low: "kimi-k3-low", high: "kimi-k3-high", max: "kimi-k3-max" }, defaultMember: "kimi-k3-high", efforts: ["low", "high", "max"], requiresEffort: true },
    { id: "grok-4-5", name: "Grok 4.5", contextLength: 500000, toolUse: true,
      effortRouting: { low: "grok-4-5-low", medium: "grok-4-5-medium", high: "grok-4-5-high" }, defaultMember: "grok-4-5-medium", efforts: ["low", "medium", "high"], requiresEffort: true },
    { id: "inkling", name: "Inkling", contextLength: 262000, toolUse: true,
      effortRouting: { off: "inkling-none", low: "inkling-low", medium: "inkling-medium", high: "inkling-high", xhigh: "inkling-xhigh", max: "inkling-max" }, defaultMember: "inkling-medium", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gemini-3-1-pro", name: "Gemini 3.1 Pro", contextLength: 1048576, toolUse: true,
      effortRouting: { low: "gemini-3-1-pro-low", high: "gemini-3-1-pro-high" }, defaultMember: "gemini-3-1-pro-high", efforts: ["low", "high"], requiresEffort: true },
    { id: "gemini-3-5-flash", name: "Gemini 3.5 Flash", contextLength: 1048576, toolUse: true,
      effortRouting: { minimal: "gemini-3-5-flash-minimal", low: "gemini-3-5-flash-low", medium: "gemini-3-5-flash-medium", high: "gemini-3-5-flash-high" }, defaultMember: "gemini-3-5-flash-medium", efforts: ["minimal", "low", "medium", "high"], requiresEffort: true },
    { id: "gemini-3-6-flash", name: "Gemini 3.6 Flash", contextLength: 1048576, toolUse: true,
      effortRouting: { minimal: "gemini-3-6-flash-minimal", low: "gemini-3-6-flash-low", medium: "gemini-3-6-flash-medium", high: "gemini-3-6-flash-high" }, defaultMember: "gemini-3-6-flash-medium", efforts: ["minimal", "low", "medium", "high"], requiresEffort: true },
    { id: "gemini-3-flash", name: "Gemini 3 Flash", contextLength: 1048576, toolUse: true,
      effortRouting: { minimal: "MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL", low: "MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW", medium: "MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM", high: "MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH" }, defaultMember: "MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM", efforts: ["minimal", "low", "medium", "high"], requiresEffort: true },
    { id: "glm-5-2-1m", name: "GLM-5.2 1M", contextLength: 1000000, toolUse: true,
      effortRouting: { off: "glm-5-2-none-1m", high: "glm-5-2-1m", xhigh: "glm-5-2-max-1m" }, defaultMember: "glm-5-2-1m", efforts: ["high", "xhigh"] },
    { id: "gemini-3-7-flash", name: "Gemini 3.7 Flash", contextLength: 1048576, toolUse: true,
      effortRouting: { minimal: "gemini-3-7-flash-minimal", low: "gemini-3-7-flash-low", medium: "gemini-3-7-flash-medium", high: "gemini-3-7-flash-high" }, defaultMember: "gemini-3-7-flash-medium", efforts: ["minimal", "low", "medium", "high"], requiresEffort: true },
    { id: "grok-4-6", name: "Grok 4.6", contextLength: 500000, toolUse: true,
      effortRouting: { low: "grok-4-6-low", medium: "grok-4-6-medium", high: "grok-4-6-high", xhigh: "grok-4-6-xhigh" }, defaultMember: "grok-4-6-medium", efforts: ["low", "medium", "high", "xhigh"], requiresEffort: true },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextLength: 1000000, toolUse: true,
      effortRouting: { low: "deepseek-v4-flash-low", high: "deepseek-v4-flash-high", max: "deepseek-v4-flash-max" }, defaultMember: "deepseek-v4-flash-high", efforts: ["low", "high", "max"], requiresEffort: true },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextLength: 1000000, toolUse: true,
      effortRouting: { low: "deepseek-v4-pro-low", high: "deepseek-v4-pro-high", max: "deepseek-v4-pro-max" }, defaultMember: "deepseek-v4-pro-high", efforts: ["low", "high", "max"], requiresEffort: true },
    { id: "nemotron-3-ultra", name: "Nemotron 3 Ultra", contextLength: 128000, toolUse: true,
      effortRouting: { off: "nemotron-3-ultra-none", medium: "nemotron-3-ultra-medium", high: "nemotron-3-ultra-high" }, defaultMember: "nemotron-3-ultra-high", efforts: ["medium", "high"] },
    // Single-member no-thinking family: every effort resolves to the lone
    // upstream wire uid (no effort axis — kdl `no-thinking`).
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextLength: 200000, toolUse: true,
      effortRouting: {}, defaultMember: "MODEL_PRIVATE_11", efforts: [] },

    // Legacy (kept for existing combos; absent from current discovery)
    { id: "swe-check", name: "SWE-check", contextLength: 200000 },
    { id: "swe-1-6", name: "SWE-1.6", contextLength: 200000, supportsParallelToolCalls: true },
    { id: "swe-1-6-fast", name: "SWE-1.6 Fast", contextLength: 200000, supportsParallelToolCalls: true },
  ],
};
