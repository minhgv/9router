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

  models: [
    { id: "swe-2-high", name: "SWE-2 High", contextLength: 200000 },
    { id: "swe-2-medium", name: "SWE-2 Medium", contextLength: 200000 },
    { id: "swe-2-max", name: "SWE-2 Max", contextLength: 200000 },
    { id: "swe-1-7", name: "SWE-1.7", contextLength: 200000 },
    { id: "swe-1-7-medium", name: "SWE-1.7 Medium", contextLength: 200000 },
    { id: "swe-1-7-lightning", name: "SWE-1.7 Lightning", contextLength: 200000 },
    { id: "swe-1-7-lightning-medium", name: "SWE-1.7 Lightning Medium", contextLength: 200000 },
    { id: "swe-check", name: "SWE-check", contextLength: 200000 },
    { id: "swe-1-6", name: "SWE-1.6", contextLength: 200000 },
    { id: "swe-1-6-fast", name: "SWE-1.6 Fast", contextLength: 200000 },
  ],
};
