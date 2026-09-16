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

  it("routes Preview models to the account-service route regardless of transport", () => {
    const expected = "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions";
    expect(ex.buildUrl("mimo-x-pro-preview", true, 0, OPENAI_T)).toBe(expected);
    expect(ex.buildUrl("mimo-x-pro-preview", true, 0, CLAUDE_T)).toBe(expected);
    // body.model arrives as `xiaomi/<id>` via upstreamModelId
    expect(ex.buildUrl("xiaomi/mimo-x-flash-preview", true, 0, OPENAI_T)).toBe(expected);
  });

  it("keeps the sourceFormat-matched endpoint for cloud models", () => {
    // Regression: a Claude client must reach /anthropic/v1/messages, not /v1/chat/completions.
    expect(ex.buildUrl("mimo-v2.5-pro", true, 0, CLAUDE_T)).toBe(CLAUDE_T.runtimeTransport.baseUrl);
    expect(ex.buildUrl("mimo-v2.5-pro", true, 0, OPENAI_T)).toBe(OPENAI_T.runtimeTransport.baseUrl);
  });

  it("authenticates Preview calls with the account cookie", () => {
    const headers = ex.buildHeaders({ [COOKIE_KEY]: "serviceToken=abc", accessToken: "sk-x" }, true, "u", "mimo-x-pro-preview");
    expect(headers.Cookie).toBe("serviceToken=abc");
    expect(headers.Authorization).toBeUndefined();
  });

  it("authenticates cloud calls with the bearer key", () => {
    const headers = ex.buildHeaders({ accessToken: "sk-x" }, true, "u", "mimo-v2.5-pro");
    expect(headers.Authorization).toBe("Bearer sk-x");
    expect(headers.Cookie).toBeUndefined();
  });

  it("fails fast when a Preview call has no account session", async () => {
    await expect(
      ex.execute({ model: "mimo-x-pro-preview", body: {}, stream: true, credentials: {}, log: null }),
    ).rejects.toThrow(/account session unavailable/);
  });

  it("flattens content-part arrays to plain strings", () => {
    const out = ex.transformRequest(
      "mimo-x-pro-preview",
      { messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] },
      true,
      {},
    );
    expect(out.messages[0].content).toBe("ab");
  });

  it("applies Preview defaults without overriding explicit values", () => {
    const body = { messages: [{ role: "user", content: "hi" }], temperature: 0.2 };
    const out = ex.transformRequest("mimo-x-pro-preview", body, true, {});
    expect(out.temperature).toBe(0.2);       // caller's value kept
    expect(out.top_p).toBe(0.95);            // default filled in
    expect(out.max_tokens).toBe(4096);
  });

  it("leaves cloud bodies free of Preview defaults", () => {
    const out = ex.transformRequest("mimo-v2.5-pro", { messages: [{ role: "user", content: "hi" }] }, true, {});
    expect(out.thinking).toBeUndefined();
    expect(out.max_tokens).toBeUndefined();
  });

  it("strips a provider/model prefix when testing preview ids", () => {
    expect(bareModel("xiaomi/mimo-x-pro-preview")).toBe("mimo-x-pro-preview");
    expect(bareModel("mimo-x-pro-preview")).toBe("mimo-x-pro-preview");
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
    const keyA = crypto.createHash("sha256").update(tokenA).digest("hex");
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
    const keyA = crypto.createHash("sha256").update(tokenA).digest("hex");
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
    const keyA = crypto.createHash("sha256").update(tokenA).digest("hex");
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
    const keyA = crypto.createHash("sha256").update(tokenA).digest("hex");

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
    const keyA = crypto.createHash("sha256").update(tokenA).digest("hex");
    const keyB = crypto.createHash("sha256").update(tokenB).digest("hex");

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
    const keyA = crypto.createHash("sha256").update(tokenA).digest("hex");
    const keyB = crypto.createHash("sha256").update(tokenB).digest("hex");

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
