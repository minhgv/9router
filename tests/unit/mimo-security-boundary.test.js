import { describe, it, expect, vi } from "vitest";
import crypto from "crypto";
import { XiaomiMimoExecutor, __test__ as mimoExecutorTest } from "../../open-sse/executors/xiaomi-mimo.js";
import { getMimoAccountCookie, MIMO_API_UA } from "../../open-sse/shared/mimoAccount.js";
import {
  decryptCallback,
  generateKeyPair,
} from "../../src/lib/oauth/providers/xiaomi-mimo.js";
import { XIAOMI_MIMO_CONFIG } from "../../src/lib/oauth/constants/oauth.js";

const { COOKIE_KEY } = mimoExecutorTest;

const OPENAI_TRANSPORT = {
  runtimeTransport: {
    format: "openai",
    baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
  },
};

const CLAUDE_TRANSPORT = {
  runtimeTransport: {
    format: "claude",
    baseUrl: "https://api.xiaomimimo.com/anthropic/v1/messages",
    headers: { "anthropic-version": "2023-06-01" },
    auth: { combined: true, header: "x-api-key", scheme: "raw" },
  },
};

describe("MIMO-03: Auth/transport boundary and credential isolation", () => {
  const ex = new XiaomiMimoExecutor();

  describe("Preview models header and credential isolation", () => {
    it("authenticates Preview models ONLY with Cookie and NO Authorization or x-api-key", () => {
      const creds = {
        apiKey: "sk-should-not-leak",
        accessToken: "token-should-not-leak",
        [COOKIE_KEY]: "serviceToken=valid_session_cookie_123",
      };

      const headers = ex.buildHeaders(creds, true, null, "mimo-x-pro-preview");

      expect(headers["Cookie"]).toBe("serviceToken=valid_session_cookie_123");
      expect(headers["Authorization"]).toBeUndefined();
      expect(headers["x-api-key"]).toBeUndefined();
      expect(headers["User-Agent"]).toBe(MIMO_API_UA);
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["Accept"]).toBe("text/event-stream");
    });

    it("fails fast when a Preview call has no account session", async () => {
      await expect(
        ex.execute({
          model: "mimo-x-pro-preview",
          body: { messages: [{ role: "user", content: "hi" }] },
          stream: false,
          credentials: { apiKey: "sk-plain-key" },
        }),
      ).rejects.toThrow(/Xiaomi MiMo account session unavailable/);
    });

    it("rejects session cookies containing CRLF or control characters", () => {
      const credsInjected = {
        [COOKIE_KEY]: "serviceToken=valid\r\nInjected-Header: evil\r\n",
      };
      expect(() => {
        ex.buildHeaders(credsInjected, true, null, "mimo-x-pro-preview");
      }).toThrow(/control characters or CRLF/);
    });

    it("rejects mimoPassToken containing CRLF in account cookie lookup", async () => {
      const res = await getMimoAccountCookie({
        mimoPassToken: "token_with_\r\n_crlf_injection",
      });
      expect(res).toBeNull();
    });
  });

  describe("Cloud models transport isolation", () => {
    it("authenticates Cloud OpenAI transport with Bearer and NO Cookie or x-api-key", () => {
      const creds = {
        apiKey: "sk-mimo-cloud-openai-key-12345",
        ...OPENAI_TRANSPORT,
      };

      const headers = ex.buildHeaders(creds, true, null, "mimo-v2.5-pro");

      expect(headers["Authorization"]).toBe("Bearer sk-mimo-cloud-openai-key-12345");
      expect(headers["Cookie"]).toBeUndefined();
      expect(headers["x-api-key"]).toBeUndefined();
    });

    it("authenticates Cloud Claude transport with x-api-key, anthropic-version, and NO Bearer or Cookie", () => {
      const creds = {
        apiKey: "sk-mimo-cloud-claude-key-67890",
        ...CLAUDE_TRANSPORT,
      };

      const headers = ex.buildHeaders(creds, true, null, "mimo-v2.5-pro");

      expect(headers["x-api-key"]).toBe("sk-mimo-cloud-claude-key-67890");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers["Authorization"]).toBeUndefined();
      expect(headers["Cookie"]).toBeUndefined();
    });

    it("rejects Cloud credentials containing CRLF or control characters", () => {
      const credsInjected = {
        apiKey: "sk-valid-key\r\nAuthorization: Bearer evil-admin-token\r\n",
        ...OPENAI_TRANSPORT,
      };

      expect(() => {
        ex.buildHeaders(credsInjected, true, null, "mimo-v2.5-pro");
      }).toThrow(/control characters or CRLF/);
    });
  });
});

describe("MIMO-04: URL/input validation and provider-specific URL boundary", () => {
  const ex = new XiaomiMimoExecutor();

  describe("Canonical endpoint preservation", () => {
    it("routes Preview models strictly to the canonical account route", () => {
      const expectedPreviewUrl = "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions";
      expect(ex.buildUrl("mimo-x-pro-preview", true, 0, OPENAI_TRANSPORT)).toBe(expectedPreviewUrl);
      expect(ex.buildUrl("mimo-x-flash-preview", true, 0, CLAUDE_TRANSPORT)).toBe(expectedPreviewUrl);
    });

    it("preserves canonical transport endpoints for cloud models", () => {
      expect(ex.buildUrl("mimo-v2.5-pro", true, 0, OPENAI_TRANSPORT)).toBe(
        "https://api.xiaomimimo.com/v1/chat/completions",
      );
      expect(ex.buildUrl("mimo-v2.5-pro", true, 0, CLAUDE_TRANSPORT)).toBe(
        "https://api.xiaomimimo.com/anthropic/v1/messages",
      );
    });

    it("rejects baseUrl overrides containing CRLF or control characters", () => {
      const injectedTransport = {
        runtimeTransport: {
          format: "openai",
          baseUrl: "https://api.xiaomimimo.com/v1\r\nX-Injected: attack",
        },
      };
      expect(() => {
        ex.buildUrl("mimo-v2.5-pro", true, 0, injectedTransport);
      }).toThrow(/control characters or CRLF/);
    });
  });

  describe("OAuth callback decryption and URL sanitization", () => {
    // Helper to encrypt a payload as platform does:
    // [12-byte nonce][32-byte ephemeral pubkey][ciphertext][16-byte GCM tag]
    function encryptPayload(receiverPublicKeyB64, payloadObj) {
      const ephemeralKey = crypto.generateKeyPairSync("x25519");
      const ephemeralPubDer = ephemeralKey.publicKey.export({ format: "der", type: "spki" });
      const ephemeralPubRaw = ephemeralPubDer.subarray(ephemeralPubDer.length - 32);

      const receiverKey = crypto.createPublicKey({
        key: Buffer.from(receiverPublicKeyB64, "base64"),
        format: "der",
        type: "spki",
      });

      const sharedSecret = crypto.diffieHellman({
        privateKey: ephemeralKey.privateKey,
        publicKey: receiverKey,
      });
      const derivedKey = crypto.createHash("sha256").update(sharedSecret).digest();

      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey, nonce);
      const plaintext = Buffer.from(JSON.stringify(payloadObj), "utf-8");
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();

      const combined = Buffer.concat([nonce, ephemeralPubRaw, ciphertext, tag]);
      return combined.toString("base64");
    }

    it("normalizes arbitrary / malicious host URL in decrypted payload to default canonical baseUrl", () => {
      const { publicKey, privateKeyDer } = generateKeyPair();
      const maliciousPayload = {
        uid: "user123",
        sk: "sk-decrypted-secret-key",
        url: "http://evil.attacker.com/v1/intercept",
      };

      const encryptedB64 = encryptPayload(publicKey, maliciousPayload);
      const result = decryptCallback(privateKeyDer, encryptedB64);

      expect(result.uid).toBe("user123");
      expect(result.sk).toBe("sk-decrypted-secret-key");
      expect(result.url).toBe(XIAOMI_MIMO_CONFIG.defaultBaseUrl);
      expect(result.url).not.toContain("evil.attacker.com");
    });

    it("normalizes dangerous scheme URLs (javascript:, file:) to default canonical baseUrl", () => {
      const { publicKey, privateKeyDer } = generateKeyPair();
      const dangerousPayload = {
        uid: "user456",
        sk: "sk-test-key",
        url: "javascript:alert(document.cookie)",
      };

      const encryptedB64 = encryptPayload(publicKey, dangerousPayload);
      const result = decryptCallback(privateKeyDer, dangerousPayload ? encryptedB64 : null);

      expect(result.url).toBe(XIAOMI_MIMO_CONFIG.defaultBaseUrl);
    });

    it("preserves valid allowed Xiaomi MiMo domains in decrypted callback", () => {
      const { publicKey, privateKeyDer } = generateKeyPair();
      const validPayload = {
        uid: "user789",
        sk: "sk-official-key",
        url: "https://api.xiaomimimo.com/v1",
      };

      const encryptedB64 = encryptPayload(publicKey, validPayload);
      const result = decryptCallback(privateKeyDer, encryptedB64);

      expect(result.url).toBe("https://api.xiaomimimo.com/v1");
      expect(result.uid).toBe("user789");
      expect(result.sk).toBe("sk-official-key");
    });

    it("sanitizes control characters and CRLF from uid and sk in decrypted payload", () => {
      const { publicKey, privateKeyDer } = generateKeyPair();
      const injectedPayload = {
        uid: "user\r\nadmin\x00",
        sk: "sk-clean-key\r\nInjected-Header: bad\n",
        url: "https://api.xiaomimimo.com/v1",
      };

      const encryptedB64 = encryptPayload(publicKey, injectedPayload);
      const result = decryptCallback(privateKeyDer, encryptedB64);

      expect(result.uid).toBe("useradmin");
      expect(result.sk).toBe("sk-clean-keyInjected-Header: bad");
      expect(result.uid).not.toMatch(/[\r\n\x00-\x1f\x7f]/);
      expect(result.sk).not.toMatch(/[\r\n\x00-\x1f\x7f]/);
    });
  });
});
