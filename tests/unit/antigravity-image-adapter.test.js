import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import antigravityAdapter from "../../open-sse/handlers/imageProviders/antigravity.js";
import * as executorRegistry from "../../open-sse/executors/index.js";

// ============================================================================
// AG-01 / FIX-AG-01: Antigravity image adapter input policy and executor integration
// Policy: data URI / raw base64 only; remote URLs deterministically rejected / null;
// malformed base64 rejected; no silent network fetch; no tool forwarding.
// ============================================================================

describe("AG-01 — Antigravity image adapter input policy (P-AG-IMG)", () => {
  let mockExecutor;
  let executedCalls = [];

  beforeEach(() => {
    executedCalls = [];
    mockExecutor = {
      execute: vi.fn(async (params) => {
        executedCalls.push(params);
        return {
          response: {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({}),
            json: async () => ({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        inlineData: {
                          mimeType: "image/png",
                          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          },
        };
      }),
    };
    vi.spyOn(executorRegistry, "getExecutor").mockReturnValue(mockExecutor);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("declares useExecutor: true for provider execution", () => {
    expect(antigravityAdapter.useExecutor).toBe(true);
    expect(antigravityAdapter.buildUrl()).toBe("");
    expect(antigravityAdapter.buildHeaders()).toEqual({});
    expect(antigravityAdapter.buildBody()).toEqual({});
  });

  it("resolves valid data URI (png, jpeg, webp) and injects inlineData into parts", async () => {
    const validB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const dataUri = `data:image/png;base64,${validB64}`;

    await antigravityAdapter.executeViaExecutor(
      "gemini-3.1-flash-image",
      { prompt: "generate a sunset", image: dataUri },
      { accessToken: "ag-tok" },
      null
    );

    expect(executedCalls).toHaveLength(1);
    const parts = executedCalls[0].body.contents[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      inlineData: { mimeType: "image/png", data: validB64 },
    });
    expect(parts[1]).toEqual({ text: "generate a sunset" });
  });

  it("resolves valid raw base64 string (>100 chars) as image/png inlineData", async () => {
    const validRawB64 = Buffer.from("a".repeat(120)).toString("base64");

    await antigravityAdapter.executeViaExecutor(
      "gemini-3.1-flash-image",
      { prompt: "edit this picture", image: validRawB64 },
      { accessToken: "ag-tok" },
      null
    );

    expect(executedCalls).toHaveLength(1);
    const parts = executedCalls[0].body.contents[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      inlineData: { mimeType: "image/png", data: validRawB64 },
    });
    expect(parts[1]).toEqual({ text: "edit this picture" });
  });

  it("accepts image from body.images array if body.image is not set", async () => {
    const validB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const dataUri = `data:image/jpeg;base64,${validB64}`;

    await antigravityAdapter.executeViaExecutor(
      "gemini-3.1-flash-image",
      { prompt: "edit photo", images: [dataUri] },
      { accessToken: "ag-tok" },
      null
    );

    expect(executedCalls).toHaveLength(1);
    const parts = executedCalls[0].body.contents[0].parts;
    expect(parts[0]).toEqual({
      inlineData: { mimeType: "image/jpeg", data: validB64 },
    });
  });

  it("rejects remote URLs deterministically and makes NO network fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const remoteUrls = [
      "https://example.com/photo.png",
      "http://example.com/photo.jpg",
      "http://127.0.0.1:8080/internal.png",
      "http://localhost:3000/admin.png",
      "http://169.254.169.254/latest/meta-data",
      "file:///etc/passwd",
      "ftp://example.com/file.png",
    ];

    for (const url of remoteUrls) {
      executedCalls = [];
      await antigravityAdapter.executeViaExecutor(
        "gemini-3.1-flash-image",
        { prompt: "draw something", image: url },
        { accessToken: "ag-tok" },
        null
      );

      expect(executedCalls).toHaveLength(1);
      const parts = executedCalls[0].body.contents[0].parts;
      // No inlineData part was injected because remote URL is rejected / returns null
      expect(parts).toEqual([{ text: "draw something" }]);
    }

    // Proves NO silent fetch occurred for any remote URL
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed base64 input in data URI format", async () => {
    const malformedDataUris = [
      "data:image/png;base64,not-valid-base64!@#$%^&*()",
      "data:image/png;base64,abc===def",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    ];

    for (const dataUri of malformedDataUris) {
      executedCalls = [];
      await antigravityAdapter.executeViaExecutor(
        "gemini-3.1-flash-image",
        { prompt: "draw something", image: dataUri },
        { accessToken: "ag-tok" },
        null
      );

      expect(executedCalls).toHaveLength(1);
      const parts = executedCalls[0].body.contents[0].parts;
      expect(parts).toEqual([{ text: "draw something" }]);
    }
  });

  it("rejects malformed raw base64 string (>100 chars with invalid chars)", async () => {
    const malformedRawStrings = [
      "A".repeat(110) + "!@#$%^&*()",
      "file:///etc/passwd/" + "a".repeat(100),
      "not a base64 string but longer than one hundred characters definitely with invalid spaces and symbols %%%",
    ];

    for (const raw of malformedRawStrings) {
      executedCalls = [];
      await antigravityAdapter.executeViaExecutor(
        "gemini-3.1-flash-image",
        { prompt: "draw something", image: raw },
        { accessToken: "ag-tok" },
        null
      );

      expect(executedCalls).toHaveLength(1);
      const parts = executedCalls[0].body.contents[0].parts;
      expect(parts).toEqual([{ text: "draw something" }]);
    }
  });

  it("never forwards tools, tool_choice, or system instructions to executor", async () => {
    await antigravityAdapter.executeViaExecutor(
      "gemini-3.1-flash-image",
      {
        prompt: "paint a landscape",
        tools: [{ type: "function", function: { name: "evil_tool", parameters: {} } }],
        tool_choice: "required",
        system: "You are an assistant",
        stream: true,
      },
      { accessToken: "ag-tok" },
      null
    );

    expect(executedCalls).toHaveLength(1);
    const call = executedCalls[0];
    // stream is explicitly false
    expect(call.stream).toBe(false);
    // body ONLY has user contents
    expect(call.body).toEqual({
      contents: [{ role: "user", parts: [{ text: "paint a landscape" }] }],
    });
    expect(call.body.tools).toBeUndefined();
    expect(call.body.toolConfig).toBeUndefined();
    expect(call.body.systemInstruction).toBeUndefined();
  });

  it("forwards proxyOptions to executor.execute", async () => {
    const customProxy = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.local:8080",
      connectionNoProxy: "localhost",
    };

    await antigravityAdapter.executeViaExecutor(
      "gemini-3.1-flash-image",
      { prompt: "generate art" },
      { accessToken: "ag-tok" },
      null,
      customProxy
    );

    expect(executedCalls).toHaveLength(1);
    expect(executedCalls[0].proxyOptions).toEqual(customProxy);
  });

  it("resolves size aspect ratio suffixes for image model names", async () => {
    const testCases = [
      { size: "1024x1024", expectedSuffix: "-1x1" },
      { size: "1792x1024", expectedSuffix: "-16x9" },
      { size: "1024x1792", expectedSuffix: "-9x16" },
      { size: "1536x1024", expectedSuffix: "-3x2" },
      { size: "1024x1536", expectedSuffix: "-2x3" },
    ];

    for (const { size, expectedSuffix } of testCases) {
      executedCalls = [];
      await antigravityAdapter.executeViaExecutor(
        "gemini-3.1-flash-image",
        { prompt: "sunset", size },
        { accessToken: "ag-tok" },
        null
      );

      expect(executedCalls[0].model).toBe(`gemini-3.1-flash-image${expectedSuffix}`);
    }
  });

  it("normalizes response candidates with inlineData to b64_json output", () => {
    const responseBody = {
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { mimeType: "image/png", data: "b64-image-data-here" } },
            ],
          },
        },
      ],
    };

    const normalized = antigravityAdapter.normalize(responseBody, "sunset prompt");
    expect(normalized.data).toEqual([{ b64_json: "b64-image-data-here" }]);
    expect(typeof normalized.created).toBe("number");
  });

  it("normalizes empty candidate response to revised_prompt fallback", () => {
    const emptyResponse = { candidates: [] };
    const normalized = antigravityAdapter.normalize(emptyResponse, "my prompt");
    expect(normalized.data).toEqual([{ b64_json: "", revised_prompt: "my prompt" }]);
  });

  it("throws on non-ok executor response with response text", async () => {
    mockExecutor.execute.mockResolvedValueOnce({
      response: {
        ok: false,
        status: 400,
        text: async () => "Invalid image dimensions",
      },
    });

    await expect(
      antigravityAdapter.executeViaExecutor(
        "gemini-3.1-flash-image",
        { prompt: "sunset" },
        { accessToken: "ag-tok" },
        null
      )
    ).rejects.toThrow("Invalid image dimensions");
  });
});
