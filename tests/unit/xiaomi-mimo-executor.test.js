import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import { XiaomiMimoExecutor, __test__ } from "../../open-sse/executors/xiaomi-mimo.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import {
  __test__ as accountTest,
  getMimoAccountCookie,
  invalidateMimoAccountCookieCache,
} from "../../open-sse/shared/mimoAccount.js";

const { bareModel, COOKIE_KEY } = __test__;
const { _cache, _inflight, COOKIE_TTL_MS } = accountTest;

const OPENAI_T = { runtimeTransport: { format: "openai", baseUrl: "https://api.xiaomimimo.com/v1/chat/completions" } };
const CLAUDE_T = { runtimeTransport: { format: "claude", baseUrl: "https://api.xiaomimimo.com/anthropic/v1/messages" } };

describe("xiaomi-mimo executor", () => {
  let ex;
  beforeEach(() => {
    ex = new XiaomiMimoExecutor();
  });

  it("is registered for xiaomi-mimo", () => {
    expect(getExecutor("xiaomi-mimo")).toBeInstanceOf(XiaomiMimoExecutor);
  });

  it("keeps the sourceFormat-matched endpoint for cloud models", () => {
    expect(ex.buildUrl("mimo-v2.5-pro", true, 0, CLAUDE_T)).toBe(CLAUDE_T.runtimeTransport.baseUrl);
    expect(ex.buildUrl("mimo-v2.5-pro", true, 0, OPENAI_T)).toBe(OPENAI_T.runtimeTransport.baseUrl);
  });

  it("routes v2.6 models to account route when desktop credentials are present", () => {
    // No region → SGP default
    const expected = "https://mimo-server-sgp.xiaomimimo.com/api/route/chat/completions";
    const credsWithToken = { providerSpecificData: { mimoPassToken: "token123" } };
    const credsWithCookie = { [COOKIE_KEY]: "serviceToken=abc" };

    expect(ex.buildUrl("mimo-v2.6-flash", true, 0, credsWithToken)).toBe(expected);
    expect(ex.buildUrl("mimo-v2.6-pro", true, 0, credsWithCookie)).toBe(expected);
    expect(ex.buildUrl("xiaomi/mimo-v2.6-flash", true, 0, credsWithToken)).toBe(expected);
  });

  it("routes v2.6 models to cloud API when no desktop credentials are present", () => {
    expect(ex.buildUrl("mimo-v2.6-flash", true, 0, OPENAI_T)).toBe(OPENAI_T.runtimeTransport.baseUrl);
    expect(ex.buildUrl("mimo-v2.6-pro", true, 0, CLAUDE_T)).toBe(CLAUDE_T.runtimeTransport.baseUrl);
  });

  it("resolves the account-service cluster per connection region", () => {
    const cn = "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions";
    const sgp = "https://mimo-server-sgp.xiaomimimo.com/api/route/chat/completions";
    const ams = "https://mimo-server-ams.xiaomimimo.com/api/route/chat/completions";
    const ru = "https://mimo-server-ru.xiaomimimo.com/api/route/chat/completions";
    const inRegion = "https://mimo-server-in.xiaomimimo.com/api/route/chat/completions";
    // default (no region) falls back to SGP (the international cluster)
    expect(ex.buildUrl("mimo-v2.6-flash", true, 0, { providerSpecificData: { mimoPassToken: "t" } })).toBe(sgp);
    expect(ex.buildUrl("mimo-v2.6-pro", true, 0, { providerSpecificData: { region: "cn", mimoPassToken: "t" } })).toBe(cn);
    expect(ex.buildUrl("mimo-v2.6-pro", true, 0, { providerSpecificData: { region: "sgp", mimoPassToken: "t" } })).toBe(sgp);
    expect(ex.buildUrl("mimo-v2.6-flash", true, 0, { providerSpecificData: { region: "SGP", mimoPassToken: "t" } })).toBe(sgp);
    expect(ex.buildUrl("mimo-v2.6-pro", true, 0, { providerSpecificData: { region: "ams", mimoPassToken: "t" } })).toBe(ams);
    expect(ex.buildUrl("mimo-v2.6-pro", true, 0, { providerSpecificData: { region: "ru", mimoPassToken: "t" } })).toBe(ru);
    expect(ex.buildUrl("mimo-v2.6-pro", true, 0, { providerSpecificData: { region: "in", mimoPassToken: "t" } })).toBe(inRegion);
    // unknown region falls back to SGP
    expect(ex.buildUrl("mimo-v2.6-pro", true, 0, { providerSpecificData: { region: "eu", mimoPassToken: "t" } })).toBe(sgp);
  });

  it("authenticates v2.6 calls with account cookie when on account route", () => {
    const headers = ex.buildHeaders(
      { [COOKIE_KEY]: "serviceToken=abc", accessToken: "sk-x" },
      true,
      "u",
      "mimo-v2.6-flash",
    );
    expect(headers.Cookie).toBe("serviceToken=abc");
    expect(headers.Authorization).toBeUndefined();
  });

  it("authenticates cloud calls with the bearer key", () => {
    const headers = ex.buildHeaders({ accessToken: "sk-x" }, true, "u", "mimo-v2.5-pro");
    expect(headers.Authorization).toBe("Bearer sk-x");
    expect(headers.Cookie).toBeUndefined();
  });

  it("preserves content-part arrays for multimodal inputs", () => {
    const parts = [{ type: "image_url", image_url: { url: "data:image/png;base64,xyz" } }, { type: "text", text: "hi" }];
    const out = ex.transformRequest(
      "mimo-v2.6-pro",
      { messages: [{ role: "user", content: parts }] },
      true,
      { providerSpecificData: { mimoPassToken: "token" } },
    );
    expect(out.messages[0].content).toEqual(parts);
  });

  it("bridges reasoning_effort to official output_config.effort", () => {
    const creds = { providerSpecificData: { mimoPassToken: "token" } };
    const body = {
      messages: [{ role: "user", content: "solve" }],
      reasoning_effort: "high",
    };
    const out = ex.transformRequest("mimo-v2.6-pro", body, true, creds);
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("normalizes xhigh reasoning_effort to high in output_config.effort", () => {
    const creds = { providerSpecificData: { mimoPassToken: "token" } };
    const body = {
      messages: [{ role: "user", content: "complex" }],
      reasoning_effort: "xhigh",
    };
    const out = ex.transformRequest("mimo-v2.6-pro", body, true, creds);
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("applies defaults without overriding explicit values", () => {
    const creds = { providerSpecificData: { mimoPassToken: "token" } };
    const body = { messages: [{ role: "user", content: "hi" }], temperature: 0.2 };
    const out = ex.transformRequest("mimo-v2.6-pro", body, true, creds);
    expect(out.temperature).toBe(0.2);
    expect(out.top_p).toBe(0.95);
  });

  it("leaves cloud bodies free of account defaults", () => {
    const out = ex.transformRequest("mimo-v2.5-pro", { messages: [{ role: "user", content: "hi" }] }, true, {});
    expect(out.output_config).toBeUndefined();
    expect(out.temperature).toBeUndefined();
  });

  it("strips a provider/model prefix when testing model ids", () => {
    expect(bareModel("xiaomi/mimo-v2.6-pro")).toBe("mimo-v2.6-pro");
    expect(bareModel("mimo-v2.6-flash")).toBe("mimo-v2.6-flash");
  });
});

describe("MIMO-01: Preview executor/account cache lifecycle", () => {
  let ex;
  beforeEach(() => {
    ex = new XiaomiMimoExecutor();
    _cache.clear();
    _inflight.clear();
  });

  it("retries once with fresh cookie on 401 response and succeeds on 200", async () => {
    const tokenA = "passTokenA_12345";
    const keyA = crypto.createHash("sha256").update(`https://mimo-server-sgp.xiaomimimo.com|${tokenA}`).digest("hex");
    _cache.set(keyA, { cookie: "serviceToken=stale_cookie", at: Date.now() });

    let callCount = 0;
    const superExecuteMock = vi.fn().mockImplementation(async (args) => {
      callCount++;
      if (callCount === 1) {
        return { response: { status: 401 }, callCount };
      }
      return { response: { status: 200 }, callCount, cookieUsed: args.credentials[COOKIE_KEY] };
    });

    const origSuper = Object.getPrototypeOf(XiaomiMimoExecutor.prototype).execute;
    Object.getPrototypeOf(XiaomiMimoExecutor.prototype).execute = superExecuteMock;

    const origAcquire = accountTest.acquireServiceCookie;
    accountTest.acquireServiceCookie = vi.fn().mockResolvedValue("serviceToken=fresh_cookie");

    try {
      const credentials = { providerSpecificData: { mimoPassToken: tokenA } };
      const res = await ex.execute({
        model: "mimo-x-pro-preview",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials,
      });

      expect(callCount).toBe(2);
      expect(res.response.status).toBe(200);
      expect(res.cookieUsed).toBe("serviceToken=fresh_cookie");
    } finally {
      Object.getPrototypeOf(XiaomiMimoExecutor.prototype).execute = origSuper;
      accountTest.acquireServiceCookie = origAcquire;
    }
  });
  it("bounds retry to exactly 1 attempt on consecutive 401 responses", async () => {
    const tokenA = "passTokenA_retry_bound";
    const keyA = crypto.createHash("sha256").update(`https://mimo-server-sgp.xiaomimimo.com|${tokenA}`).digest("hex");
    _cache.set(keyA, { cookie: "serviceToken=cookie_val", at: Date.now() });

    let callCount = 0;
    const superExecuteMock = vi.fn().mockImplementation(async () => {
      callCount++;
      return { response: { status: 401 }, callCount };
    });

    const origSuper = Object.getPrototypeOf(XiaomiMimoExecutor.prototype).execute;
    Object.getPrototypeOf(XiaomiMimoExecutor.prototype).execute = superExecuteMock;

    const origAcquire = accountTest.acquireServiceCookie;
    accountTest.acquireServiceCookie = vi.fn().mockResolvedValue("serviceToken=fresh_cookie");

    try {
      const credentials = { providerSpecificData: { mimoPassToken: tokenA } };
      const res = await ex.execute({
        model: "mimo-x-pro-preview",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials,
      });

      expect(callCount).toBe(2);
      expect(res.response.status).toBe(401);
    } finally {
      Object.getPrototypeOf(XiaomiMimoExecutor.prototype).execute = origSuper;
      accountTest.acquireServiceCookie = origAcquire;
    }
  });

  it("re-runs handshake when cached session is older than TTL", async () => {
    const tokenA = "passTokenA_ttl_test";
    const keyA = crypto.createHash("sha256").update(`https://mimo-server-sgp.xiaomimimo.com|${tokenA}`).digest("hex");
    // Cache an expired entry (older than COOKIE_TTL_MS)
    _cache.set(keyA, { cookie: "st=expired_cookie", at: Date.now() - (COOKIE_TTL_MS + 1000) });

    // When getServiceCookie runs, expired entry is not returned directly
    const { getServiceCookie } = accountTest;
    // Mock acquireServiceCookie
    const origAcquire = accountTest.acquireServiceCookie;
    let acquireCalled = false;
    accountTest.acquireServiceCookie = vi.fn().mockImplementation(async () => {
      acquireCalled = true;
      return "serviceToken=new_fresh_token";
    });

    try {
      const res = await getServiceCookie({ mimoPassToken: tokenA });
      expect(res.cookie).toBe("serviceToken=new_fresh_token");
      expect(acquireCalled).toBe(true);
    } finally {
      accountTest.acquireServiceCookie = origAcquire;
    }
  });

  it("cleans up inflight map on handshake failure so future requests can retry", async () => {
    const tokenA = "passTokenA_cleanup_test";
    const keyA = crypto.createHash("sha256").update(`https://mimo-server-sgp.xiaomimimo.com|${tokenA}`).digest("hex");

    const { getServiceCookie } = accountTest;
    const origAcquire = accountTest.acquireServiceCookie;
    accountTest.acquireServiceCookie = vi.fn().mockRejectedValueOnce(new Error("network failure"));

    try {
      const res1 = await getServiceCookie({ mimoPassToken: tokenA });
      expect(res1.cookie).toBeNull();
      expect(res1.reason).toBe("sso-failed");
      // inflight entry must be cleared
      expect(_inflight.has(keyA)).toBe(false);
    } finally {
      accountTest.acquireServiceCookie = origAcquire;
    }
  });
});

describe("MIMO-02: Concurrent account path and isolation", () => {
  beforeEach(() => {
    _cache.clear();
    _inflight.clear();
  });

  it("maintains separate cache entries per account passToken", async () => {
    const tokenA = "passToken_User_A";
    const tokenB = "passToken_User_B";
    const keyA = crypto.createHash("sha256").update(`https://mimo-server-sgp.xiaomimimo.com|${tokenA}`).digest("hex");
    const keyB = crypto.createHash("sha256").update(`https://mimo-server-sgp.xiaomimimo.com|${tokenB}`).digest("hex");

    _cache.set(keyA, { cookie: "serviceToken=cookie_A", at: Date.now() });
    _cache.set(keyB, { cookie: "serviceToken=cookie_B", at: Date.now() });

    const cookieA = await getMimoAccountCookie({ mimoPassToken: tokenA });
    const cookieB = await getMimoAccountCookie({ mimoPassToken: tokenB });

    expect(cookieA).toBe("serviceToken=cookie_A");
    expect(cookieB).toBe("serviceToken=cookie_B");
    expect(cookieA).not.toBe(cookieB);
  });

  it("invalidating account A does not affect account B cached session", async () => {
    const tokenA = "passToken_User_A_inval";
    const tokenB = "passToken_User_B_keep";
    const keyA = crypto.createHash("sha256").update(`https://mimo-server-sgp.xiaomimimo.com|${tokenA}`).digest("hex");
    const keyB = crypto.createHash("sha256").update(`https://mimo-server-sgp.xiaomimimo.com|${tokenB}`).digest("hex");

    _cache.set(keyA, { cookie: "serviceToken=cookie_A", at: Date.now() });
    _cache.set(keyB, { cookie: "serviceToken=cookie_B", at: Date.now() });

    // Selectively invalidate account A
    invalidateMimoAccountCookieCache({ mimoPassToken: tokenA });

    expect(_cache.has(keyA)).toBe(false);
    expect(_cache.has(keyB)).toBe(true);
    expect(_cache.get(keyB).cookie).toBe("serviceToken=cookie_B");
  });

  it("deduplicates concurrent handshakes for the same account", async () => {
    const tokenA = "passToken_Concurrent_A";
    const { getServiceCookie } = accountTest;
    const origAcquire = accountTest.acquireServiceCookie;

    let acquireCallCount = 0;
    accountTest.acquireServiceCookie = vi.fn().mockImplementation(async () => {
      acquireCallCount++;
      await new Promise((r) => setTimeout(r, 20));
      return "serviceToken=deduped_token";
    });

    try {
      // Trigger two concurrent requests for account A simultaneously
      const [res1, res2] = await Promise.all([
        getServiceCookie({ mimoPassToken: tokenA }),
        getServiceCookie({ mimoPassToken: tokenA }),
      ]);

      expect(acquireCallCount).toBe(1);
      expect(res1.cookie).toBe("serviceToken=deduped_token");
      expect(res2.cookie).toBe("serviceToken=deduped_token");
    } finally {
      accountTest.acquireServiceCookie = origAcquire;
    }
  });
});
