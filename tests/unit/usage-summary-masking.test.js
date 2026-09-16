/**
 * SEC-02 (NEW) — usage summary projection must never serialize raw API keys.
 *
 * Policy under test (epic-blueprint §2 P-OAUTH-CB / plan §7.2 SEC-02):
 *   - getUsageStats(period) summary output (7d/30d/60d/all daily-summary path
 *     and the 24h/today direct path) exposes only masked key identity
 *     (apiKeyMasked / apiKeyKey) — never the raw credential.
 *   - Usage totals and per-mask-family grouping stay stable and independent
 *     of key masking (mask-colliding keys must not lose usage).
 *
 * Seed data covers: a long key, a second long key sharing its first 8 chars
 * (identical mask → collision pair), a different-prefix long key, a short key
 * (≤8 chars mask branch), and a null key (local model). Verification is
 * behavioral: the entire serialized stats object is scanned for raw keys.
 *
 * DB isolation: DATA_DIR is redirected to a fresh temp dir BEFORE the first
 * import of the repo module (paths.js resolves DATA_DIR at import time).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "9router-sec02-"));

// Imported AFTER the env override above.
const { saveRequestUsage, getUsageStats } = await import(
  "../../src/lib/db/repos/usageRepo.js"
);

const KEY_A = "sk-openai-a1b2c3d4e5f6a7b8"; // first 8 chars: "sk-opena"
const KEY_B = "sk-opena-twin-9988776655"; // same first 8 chars → same mask as KEY_A
const KEY_C = "sk-ant-api03-zzyyxxwwvv"; // different prefix
const KEY_TINY = "tiny1234"; // 8 chars → short-key mask branch
const KEY_NULL = null; // local model without a key

// ISO-8601 timestamps (what real callers pass — saveRequestUsage only
// defaults falsy timestamps; numbers would bypass the 24h ISO comparison).
const NOW = Date.now();
const T = (offsetMs) => new Date(NOW - offsetMs).toISOString(); // all within the last minute

// 8 entries, distinct timestamps (dedupe guard), distinct (ts, model, provider).
const ENTRIES = [
  { ts: T(60_000), key: KEY_A, provider: "openai", model: "gpt-4o", prompt: 100, completion: 50, cached: 10 },
  { ts: T(58_000), key: KEY_A, provider: "openai", model: "gpt-4o", prompt: 200, completion: 80, cached: 0 },
  { ts: T(56_000), key: KEY_B, provider: "openai", model: "gpt-4o", prompt: 40, completion: 20, cached: 0 },
  { ts: T(54_000), key: KEY_C, provider: "anthropic", model: "claude-sonnet-4-5", prompt: 300, completion: 120, cached: 30 },
  { ts: T(52_000), key: KEY_C, provider: "anthropic", model: "claude-sonnet-4-5", prompt: 150, completion: 60, cached: 5 },
  { ts: T(50_000), key: KEY_C, provider: "anthropic", model: "claude-opus-4-1", prompt: 90, completion: 30, cached: 0 },
  { ts: T(48_000), key: KEY_NULL, provider: "ollama", model: "llama3", prompt: 80, completion: 40, cached: 0 },
  { ts: T(46_000), key: KEY_TINY, provider: "openai", model: "gpt-4o-mini", prompt: 10, completion: 5, cached: 0 },
];

const RAW_KEYS = [KEY_A, KEY_B, KEY_C, KEY_TINY].filter(Boolean);
// Expected per-mask-family request sums (collision pair A+B shares "sk-opena***").
const FAMILY_SUMS = { "sk-opena***": 3, "sk-ant-a***": 3, "t***": 1 };
const TOTALS = { requests: 8, prompt: 970, completion: 405, cached: 45 };

function assertNoRawKey(json, label) {
  for (const key of RAW_KEYS) {
    expect(json, `${label}: raw key leaked into serialized stats`).not.toContain(key);
  }
}

function familyRequests(groups, masked) {
  return groups
    .filter((g) => g.apiKeyMasked === masked)
    .reduce((n, g) => n + g.requests, 0);
}

describe("SEC-02 usage summary never serializes raw API keys", () => {
  beforeAll(async () => {
    for (const e of ENTRIES) {
      await saveRequestUsage({
        timestamp: e.ts,
        provider: e.provider,
        model: e.model,
        apiKey: e.key,
        connectionId: null,
        endpoint: "https://api.example.com/v1",
        tokens: { prompt_tokens: e.prompt, completion_tokens: e.completion, cached_tokens: e.cached },
      });
    }
  });

  afterAll(() => {
    try {
      rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it.each(["7d", "30d", "60d", "all"])(
    "daily-summary period %s exposes no raw API key anywhere in the serialized stats",
    async (period) => {
      const stats = await getUsageStats(period);
      assertNoRawKey(JSON.stringify(stats), period);
    },
    20_000
  );

  it("24h direct path exposes no raw API key anywhere in the serialized stats", async () => {
    const stats = await getUsageStats("24h");
    assertNoRawKey(JSON.stringify(stats), "24h");
  }, 20_000);

  it.each(["7d", "30d", "60d", "all"])(
    "daily-summary period %s: every byApiKey group carries masked identity and totals stay stable",
    async (period) => {
      const stats = await getUsageStats(period);
      const groups = Object.values(stats.byApiKey || {});
      expect(groups.length).toBeGreaterThan(0);
      for (const g of groups) {
        expect(g, `${period}: group missing apiKeyMasked`).toHaveProperty("apiKeyMasked");
        expect(g, `${period}: group missing apiKeyKey`).toHaveProperty("apiKeyKey");
      }
      // Mask-collision family A+B keeps all its usage under one masked identity.
      for (const [masked, expected] of Object.entries(FAMILY_SUMS)) {
        expect(familyRequests(groups, masked), `${period}: family ${masked}`).toBe(expected);
      }
      // Null-key usage groups under a null masked identity, not a fabricated key.
      expect(
        groups.filter((g) => g.apiKeyMasked == null).reduce((n, g) => n + g.requests, 0)
      ).toBe(1);
      // Totals stable across periods.
      expect(stats.totalRequests).toBe(TOTALS.requests);
      expect(stats.totalPromptTokens).toBe(TOTALS.prompt);
      expect(stats.totalCompletionTokens).toBe(TOTALS.completion);
      expect(stats.totalCachedTokens).toBe(TOTALS.cached);
    },
    20_000
  );

  it("24h direct path: masked identity present, mask-colliding keys merged, totals stable", async () => {
    const stats = await getUsageStats("24h");
    const groups = Object.values(stats.byApiKey || {});
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g).toHaveProperty("apiKeyMasked");
      expect(g).toHaveProperty("apiKeyKey");
    }
    // The 24h path keys groups by the masked identity itself → twins merge.
    const openaiFamily = groups.filter((g) => g.apiKeyMasked === "sk-opena***");
    expect(openaiFamily).toHaveLength(1);
    expect(openaiFamily[0].requests).toBe(3);
    for (const [masked, expected] of Object.entries(FAMILY_SUMS)) {
      expect(familyRequests(groups, masked)).toBe(expected);
    }
    expect(stats.totalRequests).toBe(TOTALS.requests);
    expect(stats.totalPromptTokens).toBe(TOTALS.prompt);
    expect(stats.totalCompletionTokens).toBe(TOTALS.completion);
    expect(stats.totalCachedTokens).toBe(TOTALS.cached);
  }, 20_000);
});
