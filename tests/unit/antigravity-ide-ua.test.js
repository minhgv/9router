import { describe, expect, it, vi } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import {
  DEFAULT_ANTIGRAVITY_VERSION,
  getAntigravityIdeUserAgent,
  getAntigravityVersion,
  parseAntigravityManifestVersion,
} from "../../open-sse/utils/antigravityVersion.js";

const credentials = { accessToken: "synthetic-token", projectId: "synthetic-project", connectionId: "synthetic-connection" };

describe("Antigravity version tracking", () => {
  it("falls back to the pinned version, env override wins", () => {
    expect(getAntigravityVersion()).toBe(DEFAULT_ANTIGRAVITY_VERSION);
    expect(getAntigravityIdeUserAgent()).toBe(`antigravity/ide/${DEFAULT_ANTIGRAVITY_VERSION} darwin/arm64`);

    process.env.ANTIGRAVITY_IDE_VERSION = "9.9.9";
    try {
      expect(getAntigravityVersion()).toBe("9.9.9");
      expect(getAntigravityIdeUserAgent()).toBe("antigravity/ide/9.9.9 darwin/arm64");
    } finally {
      delete process.env.ANTIGRAVITY_IDE_VERSION;
    }
  });

  it("parses electron-builder manifests and rejects malformed versions", () => {
    expect(parseAntigravityManifestVersion("version: 2.13.0\npath: x.yml")).toBe("2.13.0");
    expect(parseAntigravityManifestVersion('version: "2.13.0"')).toBe("2.13.0");
    expect(parseAntigravityManifestVersion("version: 2.13.0-beta.1")).toBeNull();
    expect(parseAntigravityManifestVersion("no version here")).toBeNull();
    expect(parseAntigravityManifestVersion(null)).toBeNull();
  });
});

describe("Antigravity executor header parity", () => {
  it("sends the IDE User-Agent plus x-request-source and Client-Metadata", () => {
    const executor = new AntigravityExecutor();
    const headers = executor.buildHeaders(credentials, true);

    expect(headers["User-Agent"]).toMatch(/^antigravity\/ide\/\d+\.\d+\.\d+ darwin\/arm64$/);
    expect(headers["x-request-source"]).toBe("local");
    expect(headers["Client-Metadata"]).toBe("ideType=ANTIGRAVITY,platform=MACOS,pluginType=GEMINI");
    expect(headers["Authorization"]).toBe("Bearer synthetic-token");
  });

  it("constructor kicks off manifest discovery once, fire-and-forget", async () => {
    vi.resetModules(); // fresh module state — the shared instance may already have a fetch in flight
    const mod = await import("../../open-sse/utils/antigravityVersion.js");
    const fetcher = vi.fn(async () => new Response("version: 2.13.0\n"));
    await mod.ensureAntigravityVersion(fetcher);
    await mod.ensureAntigravityVersion(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
