/**
 * Devin (Cognition) Provider Registry Entry
 * Transport uses ConnectRPC protobuf via dedicated DevinExecutor.
 */

export default {
  id: "devin",
  alias: "dv",
  aliases: ["devin"],
  uiAlias: "dv",

  display: {
    name: "Devin",
    icon: "smart_toy",
    color: "#6366F1",
    textIcon: "DV",
    website: "https://devin.ai",
  },

  category: "subscription",
  authType: "oauth",
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
  models: [
    // SWE (Devin's in-house coding family)
    { id: "swe-2-high", name: "SWE-2 High", contextLength: 262000, toolUse: true },
    { id: "swe-2-medium", name: "SWE-2 Medium", contextLength: 262000, toolUse: true },
    { id: "swe-2-max", name: "SWE-2 Max", contextLength: 262000, toolUse: true },
    { id: "swe-1-7", name: "SWE-1.7 Max", contextLength: 262000, toolUse: true },
    { id: "swe-1-7-medium", name: "SWE-1.7 Medium", contextLength: 262000, toolUse: true },
    { id: "swe-1-7-lightning", name: "SWE-1.7 Lightning Max", contextLength: 202752, toolUse: true },
    { id: "swe-1-7-lightning-medium", name: "SWE-1.7 Lightning Medium", contextLength: 202752, toolUse: true },
    { id: "adaptive", name: "Adaptive", toolUse: true },
    // Recommended third-party models (creditMultiplier = ACU multiplier)
    { id: "claude-opus-5-medium", name: "Claude Opus 5 Medium", contextLength: 1000000, toolUse: true },
    { id: "claude-fable-5-1-medium", name: "Claude Fable 5.1 Medium", contextLength: 1000000, toolUse: true },
    { id: "claude-sonnet-5-medium", name: "Claude Sonnet 5 Medium", contextLength: 1000000, toolUse: true },
    { id: "gemini-3-8-flash-medium", name: "Gemini 3.8 Flash Medium", contextLength: 1048576, toolUse: true },
    { id: "gpt-5-6-sol-medium", name: "GPT-5.6 Sol Medium Thinking", contextLength: 1000000, toolUse: true },
    { id: "gpt-5-6-luna-medium", name: "GPT-5.6 Luna Medium Thinking", contextLength: 1000000, toolUse: true },
    { id: "gpt-6-astra-medium", name: "GPT-6 Astra Medium Thinking", contextLength: 1000000, toolUse: true },
    { id: "glm-5-2", name: "GLM-5.2 High", contextLength: 200000, toolUse: true },
    { id: "glm-5-3-low", name: "GLM-5.3 Low", contextLength: 1048576, toolUse: true },
    { id: "glm-5-3-high", name: "GLM-5.3 High", contextLength: 1048576, toolUse: true },
    { id: "glm-5-3-max", name: "GLM-5.3 Max", contextLength: 1048576, toolUse: true },
    { id: "kimi-k3-high", name: "Kimi K3 High", contextLength: 1048576, toolUse: true },
    // Legacy (kept for existing combos; absent from current discovery)
    { id: "swe-check", name: "SWE-check", contextLength: 200000 },
    { id: "swe-1-6", name: "SWE-1.6", contextLength: 200000 },
    { id: "swe-1-6-fast", name: "SWE-1.6 Fast", contextLength: 200000 },
  ],
};
