import { DEVIN_CONFIG } from "../constants/oauth.js";

// Devin (Cognition) — authorization-code + PKCE, mirroring the devin-cli flow:
//   authorize  https://app.devin.ai/auth/cli/continue?response_type=code&redirect_uri=http://127.0.0.1:59653/callback
//              &code_challenge=<S256>&code_challenge_method=S256&state=<uuid>&prompt=select_account
//   token      POST https://api.devin.ai/auth/cli/token  JSON {code, code_verifier} → {"token": "..."}
// No client_id is sent (the CLI does not either). The returned token is the
// long-lived session credential used verbatim as apiKey/accessToken — there is
// no refresh endpoint, so re-login is the only expiry path.
const devin = {
  config: DEVIN_CONFIG,
  flowType: "authorization_code_pkce",
  fixedPort: DEVIN_CONFIG.loopbackPort,
  callbackPath: DEVIN_CONFIG.callbackPath,
  buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
    const params = {
      response_type: "code",
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: config.codeChallengeMethod,
      state,
      ...config.extraParams,
    };
    const queryString = Object.entries(params)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&");
    return `${config.authorizeUrl}?${queryString}`;
  },
  exchangeToken: async (config, code, redirectUri, codeVerifier) => {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ code, code_verifier: codeVerifier }),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Devin token exchange failed: ${error.slice(0, 300)}`);
    }
    return await response.json();
  },
  mapTokens: (tokens) => {
    const token = tokens?.token || tokens?.access_token;
    if (!token || typeof token !== "string") {
      throw new Error("Devin token response missing token");
    }
    return {
      accessToken: token,
      lastRefreshAt: new Date().toISOString(),
    };
  },
};

export default devin;
