import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
  getProviderConnectionById: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  refreshAndUpdateCredentials: vi.fn(),
  consumeClaudeResetGrant: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyAwareFetch }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: mocks.getProviderConnectionById }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig }));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({ refreshAndUpdateCredentials: mocks.refreshAndUpdateCredentials }));
vi.mock("open-sse/services/usage.js", () => ({ consumeClaudeResetGrant: mocks.consumeClaudeResetGrant }));

const response = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});
let validToken;
const originalJwtSecret = process.env.JWT_SECRET;

afterAll(() => {
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
});

const TEST_JWT_SECRET = "claude-reset-boundary-unit-test-secret-with-32-bytes";

function makeRequest({ origin = "https://router.test", body = { grantId: "grant_123" }, token = validToken, url = "https://router.test/api/usage/conn-1/claude-reset", host = new URL(url).host } = {}) {
  const headers = { origin, host, cookie: `auth_token=${encodeURIComponent(token)}`, "content-type": "application/json" };
  const request = new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  Object.defineProperty(request, "cookies", { value: { get: (name) => name === "auth_token" ? { value: token } : undefined } });
  return request;
}

describe("Claude free-limit reset", () => {
  beforeEach(async () => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    vi.resetModules();
    vi.resetAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test" });
    mocks.getProviderConnectionById.mockResolvedValue({ id: "conn-1", provider: "claude", authType: "oauth", accessToken: "secret-token", providerSpecificData: {} });
    mocks.refreshAndUpdateCredentials.mockImplementation(async (connection) => ({ connection }));
    mocks.consumeClaudeResetGrant.mockResolvedValue({ ok: true, status: 200, result: "reset" });
    const { createDashboardAuthToken } = await import("../../src/lib/auth/dashboardSession.js");
    validToken = await createDashboardAuthToken();
  });

  it("resolves a fixed Anthropic organization endpoint through the connection proxy", async () => {
    mocks.proxyAwareFetch
      .mockResolvedValueOnce(response({ organization: { uuid: "550e8400-e29b-41d4-a716-446655440000" } }))
      .mockResolvedValueOnce(response({ result: "reset", resets_left: 1 }));
    const { consumeClaudeResetGrant } = await import("../../open-sse/services/usage/claude.js");
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test", strictProxy: false };
    const result = await consumeClaudeResetGrant("secret-token", "grant_123", proxy);
    expect(result.ok).toBe(true);
    expect(mocks.proxyAwareFetch).toHaveBeenNthCalledWith(1, "https://api.anthropic.com/api/oauth/profile", expect.objectContaining({ method: "GET" }), proxy);
    expect(mocks.proxyAwareFetch).toHaveBeenNthCalledWith(2,
      "https://api.anthropic.com/api/organizations/550e8400-e29b-41d4-a716-446655440000/reset_rate_limits",
      expect.objectContaining({ method: "POST", body: expect.stringContaining('"program":"cedar_ember"') }), proxy);
  });

  it("rejects an invalid organization identifier before constructing the reset URL", async () => {
    mocks.proxyAwareFetch.mockResolvedValueOnce(response({ organization: { uuid: "https://evil.test/path" } }));
    const { consumeClaudeResetGrant } = await import("../../open-sse/services/usage/claude.js");
    await expect(consumeClaudeResetGrant("secret-token", "grant_123")).rejects.toThrow("Cannot resolve Claude organization");
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a grant identifier outside the provider wire format without network access", async () => {
    const { consumeClaudeResetGrant } = await import("../../open-sse/services/usage/claude.js");
    await expect(consumeClaudeResetGrant("secret-token", "../grant")).rejects.toThrow("Invalid reset grant id");
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("fetches legacy organization quotas after OAuth quota throttling", async () => {
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test" };
    mocks.proxyAwareFetch
      .mockResolvedValueOnce(response({}, 429))
      .mockResolvedValueOnce(response({ organization_id: "org-123", organization_name: "Test Org", plan: "Team" }))
      .mockResolvedValueOnce(response({ five_hour: { utilization: 25 } }));
    const { getClaudeUsage } = await import("../../open-sse/services/usage/claude.js");
    const result = await getClaudeUsage("legacy-quota-token", proxy, { force: true });
    expect(result).toMatchObject({ plan: "Team", organization: "Test Org", quotas: { five_hour: { utilization: 25 } } });
    expect(mocks.proxyAwareFetch).toHaveBeenNthCalledWith(3,
      "https://api.anthropic.com/api/organizations/org-123/usage",
      expect.objectContaining({ method: "GET" }), proxy);
  });

  it("requires authenticated same-origin management requests before database or upstream access", async () => {
    const { POST } = await import("../../src/app/api/usage/[connectionId]/claude-reset/route.js");
    const unauthorized = await POST(makeRequest({ token: "bad" }), { params: Promise.resolve({ connectionId: "conn-1" }) });
    expect(unauthorized.status).toBe(401);
    expect(mocks.getProviderConnectionById).not.toHaveBeenCalled();

    const crossOrigin = await POST(makeRequest({ origin: "https://evil.test" }), { params: Promise.resolve({ connectionId: "conn-1" }) });
    expect(crossOrigin.status).toBe(403);
    expect(mocks.getProviderConnectionById).not.toHaveBeenCalled();
  });
  it("accepts the validated Host origin when the framework URL is internal and rejects a malicious Origin", async () => {
    const { POST } = await import("../../src/app/api/usage/[connectionId]/claude-reset/route.js");
    const request = {
      url: "http://localhost:21481/api/usage/conn-1/claude-reset",
      host: "127.0.0.1:21481",
    };
    const params = { params: Promise.resolve({ connectionId: "conn-1" }) };
    const accepted = await POST(makeRequest({
      ...request,
      origin: "http://127.0.0.1:21481",
    }), params);
    expect(accepted.status).toBe(200);
    expect(mocks.getProviderConnectionById).toHaveBeenCalledTimes(1);

    const rejected = await POST(makeRequest({
      ...request,
      origin: "https://evil.test",
    }), params);
    expect(rejected.status).toBe(403);
    expect(mocks.getProviderConnectionById).toHaveBeenCalledTimes(1);
  });

  it("guards provider and auth type and uses refreshed credentials plus connection proxy", async () => {
    const { POST } = await import("../../src/app/api/usage/[connectionId]/claude-reset/route.js");
    mocks.getProviderConnectionById.mockResolvedValueOnce({ id: "conn-1", provider: "openai", authType: "oauth" });
    const wrongProvider = await POST(makeRequest(), { params: Promise.resolve({ connectionId: "conn-1" }) });
    expect(wrongProvider.status).toBe(400);
    expect(mocks.consumeClaudeResetGrant).not.toHaveBeenCalled();
    mocks.getProviderConnectionById.mockResolvedValueOnce({ id: "conn-1", provider: "claude", authType: "apikey" });
    const apiKeyConnection = await POST(makeRequest(), { params: Promise.resolve({ connectionId: "conn-1" }) });
    expect(apiKeyConnection.status).toBe(400);
    expect(mocks.consumeClaudeResetGrant).not.toHaveBeenCalled();

    mocks.getProviderConnectionById.mockResolvedValue({ id: "conn-1", provider: "claude", authType: "oauth", accessToken: "fresh-token", providerSpecificData: {} });
    const accepted = await POST(makeRequest(), { params: Promise.resolve({ connectionId: "conn-1" }) });
    expect(accepted.status).toBe(200);
    expect(mocks.refreshAndUpdateCredentials).toHaveBeenCalledWith(expect.objectContaining({ provider: "claude" }), false, expect.objectContaining({ connectionProxyEnabled: true }));
    expect(mocks.consumeClaudeResetGrant).toHaveBeenCalledWith("fresh-token", "grant_123", expect.objectContaining({ connectionProxyUrl: "http://proxy.test" }));
  });
});
