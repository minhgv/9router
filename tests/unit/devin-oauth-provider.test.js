import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub global fetch for exchangeToken tests
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import devinProvider from "../../src/lib/oauth/providers/devin.js";
import { DEVIN_CONFIG } from "../../src/lib/oauth/constants/oauth.js";
import { PROVIDER_OAUTH } from "../../open-sse/providers/index.js";
import { getAccessToken } from "../../open-sse/services/tokenRefresh.js";

describe("devin oauth provider", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("registers in PROVIDER_OAUTH with the devin-cli loopback shape", () => {
    expect(PROVIDER_OAUTH.devin).toBeDefined();
    expect(PROVIDER_OAUTH.devin.authorizeUrl).toBe("https://app.devin.ai/auth/cli/continue");
    expect(PROVIDER_OAUTH.devin.tokenUrl).toBe("https://api.devin.ai/auth/cli/token");
    expect(PROVIDER_OAUTH.devin.codeChallengeMethod).toBe("S256");
    expect(PROVIDER_OAUTH.devin.loopbackPort).toBe(59653);
    expect(PROVIDER_OAUTH.devin.callbackPath).toBe("/callback");
  });

  it("exposes fixedPort/callbackPath for the proxy flow", () => {
    expect(devinProvider.flowType).toBe("authorization_code_pkce");
    expect(devinProvider.fixedPort).toBe(59653);
    expect(devinProvider.callbackPath).toBe("/callback");
    expect(DEVIN_CONFIG.loopbackPort).toBe(59653);
  });

  it("builds the authorize URL with devin-cli parity (no client_id, prompt=select_account)", () => {
    const url = new URL(
      devinProvider.buildAuthUrl(
        devinProvider.config,
        "http://127.0.0.1:59653/callback",
        "state-abc",
        "challenge-xyz"
      )
    );
    expect(url.origin + url.pathname).toBe("https://app.devin.ai/auth/cli/continue");
    const params = url.searchParams;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("redirect_uri")).toBe("http://127.0.0.1:59653/callback");
    expect(params.get("code_challenge")).toBe("challenge-xyz");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("state")).toBe("state-abc");
    expect(params.get("prompt")).toBe("select_account");
    expect(params.has("client_id")).toBe(false);
    expect(params.has("scope")).toBe(false);
  });

  it("exchanges the code via JSON body {code, code_verifier}", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: "devin-session-token$eyJhbGci.x.y" }),
    });

    const tokens = await devinProvider.exchangeToken(
      devinProvider.config,
      "auth-code-1",
      "http://127.0.0.1:59653/callback",
      "verifier-1"
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.devin.ai/auth/cli/token");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ code: "auth-code-1", code_verifier: "verifier-1" });
    expect(tokens.token).toBe("devin-session-token$eyJhbGci.x.y");
  });

  it("surfaces upstream exchange failures with the response body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant"}',
    });

    await expect(
      devinProvider.exchangeToken(devinProvider.config, "bad", "http://127.0.0.1:59653/callback", "v")
    ).rejects.toThrow(/Devin token exchange failed.*invalid_grant/s);
  });

  it("maps the token field to accessToken with no refresh token", () => {
    const mapped = devinProvider.mapTokens({ token: "devin-session-token$abc" });
    expect(mapped.accessToken).toBe("devin-session-token$abc");
    expect(mapped.refreshToken).toBeUndefined();
    expect(mapped.expiresIn).toBeUndefined();
    expect(mapped.lastRefreshAt).toBeTruthy();
  });

  it("accepts access_token as a fallback shape and rejects empty responses", () => {
    expect(devinProvider.mapTokens({ access_token: "bare-jwt" }).accessToken).toBe("bare-jwt");
    expect(() => devinProvider.mapTokens({})).toThrow(/missing token/i);
    expect(() => devinProvider.mapTokens(null)).toThrow(/missing token/i);
  });

  it("refresh resolves to null (session token never refreshes)", async () => {
    // REFRESH_HANDLERS is module-private; getAccessToken is the public path.
    await expect(getAccessToken("devin", { refreshToken: "anything" })).resolves.toBeNull();
  });
});
