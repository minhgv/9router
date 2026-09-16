/**
 * SEC-01 (NEW) + MIMO-05 (EXTEND) — P-OAUTH-CB behavioral security tests.
 *
 * Policy under test (epic-blueprint §2 P-OAUTH-CB):
 *   - Every OAuth callback consumer renders attacker-controlled messages inert
 *     (entity-escaped / no executable markup) in the browser-visible result page.
 *   - Valid messages render correctly as text.
 *   - Callback state/auth validation is never bypassed by crafted params.
 *
 * Attacker-controlled message paths in src/lib/oauth/utils/server.js:
 *   - Codex / xAI (and trae/windsurf/zed/devin consumers of the same renderer):
 *     the `error_description` query param is read verbatim into
 *     `new Error(...)` and rendered by renderCodexResultPage (~L176, escaped
 *     via escapeHtml ~L167).
 *   - Xiaomi MiMo: the encrypted `u` param decrypts (this test owns the session
 *     X25519 key, so plaintext is attacker-chosen) into decryptCallback's
 *     JSON.parse; failures surface through renderXiaomiMimoResultPage (~L790).
 *
 * The renderers are private, so every case drives the exported local-HTTP
 * proxy seam against 127.0.0.1 loopback (conventions §6). All requests are
 * top-level navigations (no Origin header) — the loopback anti-CSRF guard
 * allows those by design; guard rejection is asserted explicitly where the
 * handler exposes it (trae/windsurf/zed, 403).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import {
  startLocalServer,
  startCodexProxy,
  stopCodexProxy,
  registerCodexSession,
  getCodexSessionStatus,
  startXaiProxy,
  stopXaiProxy,
  registerXaiSession,
  startTraeProxy,
  stopTraeProxy,
  registerTraeSession,
  getTraeSessionStatus,
  startWindsurfProxy,
  stopWindsurfProxy,
  registerWindsurfSession,
  getWindsurfSessionStatus,
  startZedProxy,
  stopZedProxy,
  registerZedSession,
  startXiaomiMimoProxy,
  stopXiaomiMimoProxy,
  registerXiaomiMimoSession,
  getXiaomiMimoSessionStatus,
} from "../../src/lib/oauth/utils/server.js";
import {
  generateKeyPair,
  decryptCallback,
} from "../../src/lib/oauth/providers/xiaomi-mimo.js";

const APP_PORT = "45931"; // Mode B redirect target only — nothing listens there

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Top-level-navigation GET (no Origin header). */
async function navGet(url) {
  const res = await fetch(url, { redirect: "manual" });
  return { status: res.status, body: await res.text(), headers: res.headers };
}

/** GET with an explicit cross-site Origin header. */
async function originGet(url, origin) {
  const res = await fetch(url, { redirect: "manual", headers: { Origin: origin } });
  return { status: res.status, body: await res.text() };
}

/** Test-owned entity encoding used to assert the escaped form is rendered. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Payload matrix per P-OAUTH-CB: <script>, quote-in-attribute, CR/LF, unicode.
// `signature` is the raw fragment that MUST NOT appear in any rendered page.
// Node's JSON.parse error snippet keeps ~10 leading chars, so the MiMo rows'
// signatures survive V8's truncation.
const PAYLOADS = [
  {
    name: "script tag",
    raw: "<script>alert(1)</script>",
    signature: "<script>alert(1)",
  },
  {
    name: "quote-in-attribute",
    raw: '" onmouseover="alert(1)',
    signature: '" onmouseover="',
  },
  {
    name: "CRLF + markup injection",
    raw: "<b>hi</b>\r\n<script>alert(2)</script>",
    signature: "<b>hi</b>",
  },
  {
    name: "unicode + svg event handler",
    raw: "<svg/onload=alert(1)>\u202e\u2028 hidden",
    signature: "<svg/onload=",
  },
];

/**
 * Start a fixed-port proxy with bounded, deterministic retries (server.close()
 * is async; an immediate re-listen can transiently hit EADDRINUSE), run `fn`,
 * then always stop the proxy.
 */
async function withFixedPortProxy(startFn, stopFn, fn) {
  stopFn();
  let started = await startFn(APP_PORT);
  for (let i = 0; !started.success && i < 9; i++) {
    await sleep(100);
    stopFn();
    started = await startFn(APP_PORT);
  }
  if (!started.success) throw new Error(`proxy failed to start: ${started.reason}`);
  try {
    return await fn();
  } finally {
    stopFn();
  }
}

// ── generic startLocalServer consumer (static success page, ~L29-95) ────────

describe("SEC-01 generic local callback server (startLocalServer)", () => {
  it("renders a static success page that never reflects attacker params, and passes params to the auth handler intact", async () => {
    const captured = [];
    const { port, close } = await startLocalServer((params) => captured.push(params));
    try {
      const q = new URLSearchParams({
        code: "ATT<script>alert(1)</script>",
        state: 'ST" onmouseover="alert(1)',
        error_description: "<b>hi</b>\r\ninjected",
      });
      const res = await navGet(`http://127.0.0.1:${port}/callback?${q}`);
      expect(res.status).toBe(200);
      expect(res.body).toContain("Authentication Successful");
      // None of the attacker material may reach the rendered page.
      expect(res.body).not.toContain("<script>alert(1)");
      expect(res.body).not.toContain('onmouseover="alert(1)');
      expect(res.body).not.toContain("<b>hi</b>");
      // The auth handler still receives the raw params — state validation intact.
      expect(captured).toHaveLength(1);
      expect(captured[0].code).toBe("ATT<script>alert(1)</script>");
      expect(captured[0].state).toBe('ST" onmouseover="alert(1)');
      expect(captured[0].error_description).toBe("<b>hi</b>\r\ninjected");
    } finally {
      close();
    }
  });

  it("404s non-callback paths", async () => {
    const { port, close } = await startLocalServer(() => {});
    try {
      const res = await navGet(`http://127.0.0.1:${port}/nope`);
      expect(res.status).toBe(404);
    } finally {
      close();
    }
  });
});

// ── shared result page (renderCodexResultPage via the codex proxy) ──────────

describe("SEC-01 codex callback result page (fixed-port proxy, shared renderer)", () => {
  it(
    "renders attacker error_description inert and the escaped text visible",
    async () => {
      for (const p of PAYLOADS) {
        await withFixedPortProxy(startCodexProxy, stopCodexProxy, async () => {
          const state = `st-codex-${p.name.replace(/\W+/g, "-")}`;
          expect(
            registerCodexSession({ state, codeVerifier: "cv", redirectUri: "http://127.0.0.1/cb" })
          ).toBe(true);
          const q = new URLSearchParams({ state, error: "access_denied", error_description: p.raw });
          const res = await navGet(`http://127.0.0.1:1455/callback?${q}`);
          expect(res.status).toBe(200);
          // Inert: no markup from the attacker message survives rendering.
          expect(res.body).not.toContain(p.signature);
          // Text channel works: the fully escaped form is present and readable.
          expect(res.body).toContain(escapeHtml(p.raw));
          expect(res.body).toContain("Authentication Failed");
          // The callback errored through the auth flow (not bypassed).
          expect(getCodexSessionStatus(state).status).toBe("error");
        });
      }
    },
    30_000
  );

  it("renders a valid human-readable error message verbatim as text", async () => {
    await withFixedPortProxy(startCodexProxy, stopCodexProxy, async () => {
      const state = "st-codex-valid";
      registerCodexSession({ state, codeVerifier: "cv", redirectUri: "http://127.0.0.1/cb" });
      const q = new URLSearchParams({
        state,
        error: "temporarily_unavailable",
        error_description: "Token exchange failed: rate limited (retry in 5m)",
      });
      const res = await navGet(`http://127.0.0.1:1455/callback?${q}`);
      expect(res.status).toBe(200);
      expect(res.body).toContain("Token exchange failed: rate limited (retry in 5m)");
      expect(res.body).toContain("Authentication Failed");
    });
  });

  it("falls back to the error code when error_description is empty, without rendering 'undefined'", async () => {
    await withFixedPortProxy(startCodexProxy, stopCodexProxy, async () => {
      const state = "st-codex-empty";
      registerCodexSession({ state, codeVerifier: "cv", redirectUri: "http://127.0.0.1/cb" });
      const q = new URLSearchParams({ state, error: "access_denied", error_description: "" });
      const res = await navGet(`http://127.0.0.1:1455/callback?${q}`);
      expect(res.status).toBe(200);
      expect(res.body).toContain("access_denied");
      expect(res.body).not.toContain("undefined");
    });
  });

  it("keeps the bounded no-code message when a code-less callback arrives", async () => {
    await withFixedPortProxy(startCodexProxy, stopCodexProxy, async () => {
      const state = "st-codex-nocode";
      registerCodexSession({ state, codeVerifier: "cv", redirectUri: "http://127.0.0.1/cb" });
      const res = await navGet(`http://127.0.0.1:1455/callback?state=${state}`);
      expect(res.status).toBe(200);
      expect(res.body).toContain("No authorization code received");
    });
  });

  it("preserves the legacy channel-fallback redirect for unregistered states (auth flow intact)", async () => {
    await withFixedPortProxy(startCodexProxy, stopCodexProxy, async () => {
      const q = new URLSearchParams({ code: "abc", state: "unregistered-state" });
      const res = await navGet(`http://127.0.0.1:1455/callback?${q}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`http://localhost:${APP_PORT}/callback?${q.toString()}`);
    });
  });
});

// xAI delegates to the same shared renderer (~L329-331) — representative rows.
describe("SEC-01 xAI callback result page (fixed-port proxy)", () => {
  it(
    "renders attacker script payload inert with the escaped form visible",
    async () => {
      await withFixedPortProxy(startXaiProxy, stopXaiProxy, async () => {
        const state = "st-xai-script";
        expect(
          registerXaiSession({ state, codeVerifier: "cv", redirectUri: "http://127.0.0.1/cb" })
        ).toBe(true);
        const q = new URLSearchParams({
          state,
          error: "access_denied",
          error_description: "<script>alert(1)</script>",
        });
        const res = await navGet(`http://127.0.0.1:56121/callback?${q}`);
        expect(res.status).toBe(200);
        expect(res.body).not.toContain("<script>alert(1)");
        expect(res.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(res.body).toContain("Authentication Failed");
      });
    },
    20_000
  );

  it(
    "renders a valid error message as text",
    async () => {
      await withFixedPortProxy(startXaiProxy, stopXaiProxy, async () => {
        const state = "st-xai-valid";
        registerXaiSession({ state, codeVerifier: "cv", redirectUri: "http://127.0.0.1/cb" });
        const q = new URLSearchParams({
          state,
          error: "upstream_error",
          error_description: "xAI token exchange failed: upstream 503",
        });
        const res = await navGet(`http://127.0.0.1:56121/callback?${q}`);
        expect(res.status).toBe(200);
        expect(res.body).toContain("xAI token exchange failed: upstream 503");
      });
    },
    20_000
  );
});

// ── trae / windsurf / zed consumers (dynamic ports) ─────────────────────────

describe("SEC-01 trae/windsurf/zed callback consumers", () => {
  it("trae: no-session callback gets the bounded static message and never reflects the query", async () => {
    let handle;
    try {
      handle = await startTraeProxy();
      expect(handle.success).toBe(true);
      const q = new URLSearchParams({ state: 'S<img src=x onerror=alert(1)>' });
      const res = await navGet(`http://127.0.0.1:${handle.port}/callback?${q}`);
      expect(res.status).toBe(200);
      expect(res.body).toContain("No active Trae login session");
      expect(res.body).not.toContain("<img");
      expect(res.body).not.toContain("onerror=alert(1)");
    } finally {
      stopTraeProxy();
    }
  });

  it("trae: rejects cross-origin callbacks (anti-CSRF) and marks state mismatch without reflection", async () => {
    let handle;
    try {
      handle = await startTraeProxy();
      registerTraeSession({ state: "trae-real-state" });

      const evil = await originGet(
        `http://127.0.0.1:${handle.port}/callback?state=trae-real-state`,
        "https://evil.example"
      );
      expect(evil.status).toBe(403);
      expect(evil.body).toContain("Cross-origin callback rejected");
      expect(getTraeSessionStatus("trae-real-state").status).toBe("pending");

      const q = new URLSearchParams({ state: 'WRONG<img src=x onerror=alert(1)>' });
      const mismatch = await navGet(`http://127.0.0.1:${handle.port}/callback?${q}`);
      expect(mismatch.status).toBe(200);
      expect(mismatch.body).toContain("Trae callback state mismatch");
      expect(mismatch.body).not.toContain("<img");
      expect(mismatch.body).not.toContain("onerror=alert(1)");
      expect(getTraeSessionStatus("trae-real-state").status).toBe("error");
    } finally {
      stopTraeProxy();
    }
  });

  it("windsurf: missing or mismatched state is enforced and never reflected", async () => {
    let handle;
    try {
      handle = await startWindsurfProxy();
      expect(handle.success).toBe(true);
      registerWindsurfSession({ state: "ws-real-state" });

      // Missing state → mismatch (proxy self-stops after this branch).
      const missing = await navGet(`http://127.0.0.1:${handle.port}/windsurf-auth-callback`);
      expect(missing.status).toBe(200);
      expect(missing.body).toContain("Windsurf callback state mismatch");
      expect(getWindsurfSessionStatus("ws-real-state").status).toBe("error");
    } finally {
      stopWindsurfProxy();
    }

    // Fresh proxy for the crafted-state row (previous branch stopped it).
    try {
      handle = await startWindsurfProxy();
      registerWindsurfSession({ state: "ws-real-state-2" });
      const q = new URLSearchParams({ state: 'WRONG<script>alert(3)</script>' });
      const mismatch = await navGet(`http://127.0.0.1:${handle.port}/windsurf-auth-callback?${q}`);
      expect(mismatch.status).toBe(200);
      expect(mismatch.body).not.toContain("<script>alert(3)");
      expect(getWindsurfSessionStatus("ws-real-state-2").status).toBe("error");
    } finally {
      stopWindsurfProxy();
    }
  });

  it("zed: no-session callback is static; with a session, cross-origin callbacks are rejected", async () => {
    let handle;
    try {
      handle = await startZedProxy(0);
      expect(handle.success).toBe(true);

      const noSession = await navGet(`http://127.0.0.1:${handle.port}/?state=zz`);
      expect(noSession.status).toBe(200);
      expect(noSession.body).toContain("No active Zed login session");

      registerZedSession({ state: "zed-real-state", codeVerifier: "cv" });
      const evil = await originGet(
        `http://127.0.0.1:${handle.port}/callback?state=zed-real-state`,
        "https://evil.example"
      );
      expect(evil.status).toBe(403);
      expect(evil.body).toContain("Cross-origin callback rejected");
    } finally {
      stopZedProxy();
    }
  });
});

// ── MIMO-05: Xiaomi MiMo dedicated renderer (dynamic port) ──────────────────

/**
 * Build an encrypted `u` callback param exactly the way the Xiaomi flow's
 * platform-side counterpart does: wire format nonce|ephRaw32|ct|tag with
 * key = SHA256(ECDH(ephemeralPriv, sessionPub)). The test owns the session
 * key, so the decrypted plaintext is fully attacker-chosen.
 */
function craftU(sessionPublicKeyB64, plaintext) {
  const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
  const eph = crypto.generateKeyPairSync("x25519");
  const ephRaw = eph.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const sessionPubRaw = Buffer.from(sessionPublicKeyB64, "base64").subarray(-32);
  const shared = crypto.diffieHellman({
    privateKey: eph.privateKey,
    publicKey: crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, sessionPubRaw]),
      format: "der",
      type: "spki",
    }),
  });
  const key = crypto.createHash("sha256").update(shared).digest();
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return Buffer.concat([nonce, ephRaw, ct, cipher.getAuthTag()]).toString("base64");
}

describe("MIMO-05 xiaomi-mimo callback result page", () => {
  let handle;

  beforeAll(async () => {
    handle = await startXiaomiMimoProxy();
    expect(handle.success).toBe(true);
  });

  afterAll(() => {
    stopXiaomiMimoProxy();
  });

  // Runs before any session registration: with zero pending sessions the
  // handler must serve the bounded static message.
  it("serves the bounded no-session message when nothing is pending", async () => {
    const res = await navGet(`http://127.0.0.1:${handle.port}/?u=${encodeURIComponent("AAAA")}`);
    expect(res.status).toBe(500);
    expect(res.body).toContain("No active OAuth session");
    expect(res.body).not.toContain("AAAA");
  });

  it("fixture sanity: crafted attacker plaintext reaches decryptCallback's JSON.parse error", () => {
    const { publicKey, privateKeyDer } = generateKeyPair();
    let msg = "";
    try {
      decryptCallback(privateKeyDer, craftU(publicKey, "<script>alert(1)</script>"));
    } catch (e) {
      msg = e.message;
    }
    // The message channel carries attacker text — this documents that the
    // renderer sink WOULD receive attacker markup if the handler ever
    // forwarded decryptCallback errors verbatim.
    expect(msg).toContain("<script>al");
  });

  it("keeps the bounded message when the u parameter is missing", async () => {
    const res = await navGet(`http://127.0.0.1:${handle.port}/`);
    expect(res.status).toBe(400);
    expect(res.body).toContain("Missing encrypted payload");
  });

  it.each(PAYLOADS)(
    "renders attacker-controlled decrypted payload inert ($name)",
    async (p) => {
      const { publicKey, privateKeyDer } = generateKeyPair();
      const state = `mimo-${p.name.replace(/\W+/g, "-")}`;
      expect(registerXiaomiMimoSession({ state, privateKeyDer })).toBe(true);

      const u = craftU(publicKey, p.raw);
      const res = await navGet(`http://127.0.0.1:${handle.port}/?u=${encodeURIComponent(u)}`);

      // P-OAUTH-CB: the browser-visible page must contain NO markup derived
      // from attacker input, whatever error path the payload triggers.
      expect(res.status).toBe(400);
      expect(res.body).toContain("Authentication Failed");
      expect(res.body).not.toContain(p.signature);
      // The bounded fallback must be one of the handler's static messages —
      // not a reflection of the crafted payload.
      expect(res.body).toContain("Decryption failed");
    }
  );

  it("renders the valid success message and stores the linked account", async () => {
    const { publicKey, privateKeyDer } = generateKeyPair();
    const state = "mimo-valid-success";
    expect(registerXiaomiMimoSession({ state, privateKeyDer })).toBe(true);
    const sk = "sk-mimo-valid-1234567890abcdef";
    const u = craftU(publicKey, JSON.stringify({ uid: "user-1", sk }));
    const res = await navGet(`http://127.0.0.1:${handle.port}/?u=${encodeURIComponent(u)}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("Xiaomi account linked");
    // The linked API key must not be echoed into the page.
    expect(res.body).not.toContain(sk);
    const view = getXiaomiMimoSessionStatus(state);
    expect(view.status).toBe("done");
    expect(view.result.accessToken).toBe(sk);
  });

  it("keeps the bounded message when the decrypted payload lacks sk", async () => {
    const { publicKey, privateKeyDer } = generateKeyPair();
    const state = "mimo-missing-sk";
    expect(registerXiaomiMimoSession({ state, privateKeyDer })).toBe(true);
    const u = craftU(publicKey, JSON.stringify({ uid: "user-2" }));
    const res = await navGet(`http://127.0.0.1:${handle.port}/?u=${encodeURIComponent(u)}`);
    expect(res.status).toBe(400);
    expect(res.body).toContain("missing sk");
    expect(getXiaomiMimoSessionStatus(state).status).toBe("error");
  });
});
