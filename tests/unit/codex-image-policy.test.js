import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// CODEX-01: Codex chat image prefetch policy (P-CX-IMG)
// Policy: Codex chat image inline-only.
// Prefetch success → inline base64 data URI.
// Timeout / 4xx / private / redirect-to-private / invalid → DROP image block.
// NEVER `fetched?.url || url` fallback (deterministic no-URL-leak).
//
// CODEX-02: Codex image-generation adapter
// Path independent from chat prefetch; handles data URI, raw base64, URLs;
// resolves tool image models vs standard image models; safe errors.
// ============================================================================

vi.mock("../../open-sse/translator/concerns/image.js", () => ({
  fetchImageAsBase64: vi.fn(),
}));

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { fetchImageAsBase64 } from "../../open-sse/translator/concerns/image.js";
import codexImageProvider from "../../open-sse/handlers/imageProviders/codex.js";

describe("CODEX-01: Codex chat image prefetch policy (P-CX-IMG)", () => {
  let executor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new CodexExecutor();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inlines valid remote image as base64 data URI on prefetch success", async () => {
    fetchImageAsBase64.mockResolvedValueOnce({
      url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
      mimeType: "image/png",
    });

    const body = {
      model: "gpt-5.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Look at this image" },
            { type: "image_url", image_url: "https://example.com/photo.png", detail: "high" },
          ],
        },
      ],
    };

    await executor.prefetchImages(body);

    expect(fetchImageAsBase64).toHaveBeenCalledWith("https://example.com/photo.png", { timeoutMs: 15000 });
    expect(body.input[0].content).toHaveLength(2);
    expect(body.input[0].content[1]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
      detail: "high",
    });
  });

  it("handles input_image format with remote URL on prefetch success", async () => {
    fetchImageAsBase64.mockResolvedValueOnce({
      url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      mimeType: "image/jpeg",
    });

    const body = {
      model: "gpt-5.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: "https://example.com/photo.jpg", detail: "low" },
          ],
        },
      ],
    };

    await executor.prefetchImages(body);

    expect(fetchImageAsBase64).toHaveBeenCalledWith("https://example.com/photo.jpg", { timeoutMs: 15000 });
    expect(body.input[0].content).toHaveLength(1);
    expect(body.input[0].content[0]).toEqual({
      type: "input_image",
      image_url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      detail: "low",
    });
  });

  it("preserves already-inlined data URI without calling fetch", async () => {
    const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const body = {
      model: "gpt-5.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: dataUri, detail: "auto" },
          ],
        },
      ],
    };

    await executor.prefetchImages(body);

    expect(fetchImageAsBase64).not.toHaveBeenCalled();
    expect(body.input[0].content).toHaveLength(1);
    expect(body.input[0].content[0]).toEqual({
      type: "input_image",
      image_url: dataUri,
      detail: "auto",
    });
  });

  it("DROPS image block on fetch timeout (never leaks remote URL)", async () => {
    fetchImageAsBase64.mockResolvedValueOnce(null); // Timeout returns null

    const body = {
      model: "gpt-5.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Caption this" },
            { type: "image_url", image_url: "https://example.com/slow-timeout.png", detail: "auto" },
          ],
        },
      ],
    };

    await executor.prefetchImages(body);

    // Image block must be DROPPED, never fallen back to the original URL
    expect(body.input[0].content).toHaveLength(1);
    expect(body.input[0].content[0]).toEqual({ type: "input_text", text: "Caption this" });
    const contentStr = JSON.stringify(body.input);
    expect(contentStr).not.toContain("https://example.com/slow-timeout.png");
  });

  it("DROPS image block on 4xx/5xx HTTP error", async () => {
    fetchImageAsBase64.mockResolvedValueOnce(null); // 404 / 500 returns null

    const body = {
      model: "gpt-5.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Describe" },
            { type: "input_image", image_url: "https://example.com/not-found-404.png", detail: "auto" },
          ],
        },
      ],
    };

    await executor.prefetchImages(body);

    expect(body.input[0].content).toHaveLength(1);
    expect(body.input[0].content[0]).toEqual({ type: "input_text", text: "Describe" });
    expect(JSON.stringify(body.input)).not.toContain("not-found-404.png");
  });

  it("DROPS image block on private IP / SSRF rejection", async () => {
    fetchImageAsBase64.mockResolvedValueOnce(null); // SSRF protection returns null

    const body = {
      model: "gpt-5.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "image_url", image_url: "http://169.254.169.254/latest/meta-data/image.png" },
          ],
        },
      ],
    };

    await executor.prefetchImages(body);

    expect(body.input[0].content).toHaveLength(0);
    expect(JSON.stringify(body.input)).not.toContain("169.254.169.254");
  });

  it("DROPS image block on redirect-to-private destination", async () => {
    fetchImageAsBase64.mockResolvedValueOnce(null); // redirect to private IP returns null

    const body = {
      model: "gpt-5.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: "http://public-redirector.org/to-internal.png" },
          ],
        },
      ],
    };

    await executor.prefetchImages(body);

    expect(body.input[0].content).toHaveLength(0);
    expect(JSON.stringify(body.input)).not.toContain("public-redirector.org");
  });

  it("DROPS image block when URL is invalid / empty / non-string", async () => {
    const body = {
      model: "gpt-5.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "image_url", image_url: "" },
            { type: "image_url", image_url: null },
            { type: "input_image", image_url: undefined },
            { type: "input_text", text: "Valid text" },
          ],
        },
      ],
    };

    await executor.prefetchImages(body);

    expect(fetchImageAsBase64).not.toHaveBeenCalled();
    expect(body.input[0].content).toHaveLength(1);
    expect(body.input[0].content[0]).toEqual({ type: "input_text", text: "Valid text" });
  });

  it("handles mixed content: preserves valid images + text, drops failed images", async () => {
    fetchImageAsBase64
      .mockResolvedValueOnce(null) // first image fails
      .mockResolvedValueOnce({
        url: "data:image/png;base64,VALID_IMAGE_BASE64",
        mimeType: "image/png",
      }); // second image succeeds

    const body = {
      model: "gpt-5.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Here is text" },
            { type: "image_url", image_url: "https://example.com/bad.png", detail: "low" },
            { type: "image_url", image_url: "https://example.com/good.png", detail: "high" },
          ],
        },
      ],
    };

    await executor.prefetchImages(body);

    expect(body.input[0].content).toHaveLength(2);
    expect(body.input[0].content[0]).toEqual({ type: "input_text", text: "Here is text" });
    expect(body.input[0].content[1]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,VALID_IMAGE_BASE64",
      detail: "high",
    });
    expect(JSON.stringify(body.input)).not.toContain("bad.png");
    expect(JSON.stringify(body.input)).not.toContain("good.png"); // inlined, not remote URL
  });

  it("handles image block with object image_url { url, detail }", async () => {
    fetchImageAsBase64.mockResolvedValueOnce({
      url: "data:image/webp;base64,UklGRg==",
      mimeType: "image/webp",
    });

    const body = {
      model: "gpt-5.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "https://example.com/photo.webp", detail: "low" } },
          ],
        },
      ],
    };

    await executor.prefetchImages(body);

    expect(body.input[0].content).toHaveLength(1);
    expect(body.input[0].content[0]).toEqual({
      type: "input_image",
      image_url: "data:image/webp;base64,UklGRg==",
      detail: "low",
    });
  });
});

describe("CODEX-02: Codex image-generation adapter", () => {
  it("buildBody formats single image via toDataUrl and tools config", () => {
    const body = {
      prompt: "A sunset over mountains",
      image: "iVBORw0KGgoAAAANSUhEUg==", // raw base64
      size: "1024x1024",
      quality: "hd",
    };

    const req = codexImageProvider.buildBody("gpt-5-image", body);

    expect(req.model).toBe("gpt-5");
    expect(req.instructions).toBe("");
    expect(req.input).toHaveLength(1);
    const content = req.input[0].content;
    expect(content.some((c) => c.type === "input_image" && c.image_url.startsWith("data:image/png;base64,"))).toBe(true);
    expect(content.some((c) => c.type === "input_text" && c.text === "A sunset over mountains")).toBe(true);
    expect(req.tools[0].type).toBe("image_generation");
    expect(req.tools[0].size).toBe("1024x1024");
    expect(req.tools[0].quality).toBe("hd");
  });

  it("buildBody formats multiple images in body.images", () => {
    const body = {
      prompt: "Blend these two images",
      images: [
        "data:image/png;base64,AAA=",
        "data:image/jpeg;base64,BBB=",
      ],
    };

    const req = codexImageProvider.buildBody("gpt-image-1.5", body);

    expect(req.model).toBe("gpt-5.5"); // tool model resolves main model
    expect(req.tools[0].model).toBe("gpt-image-1.5");
    expect(req.tools[0].action).toBe("edit"); // refs > 0 -> edit
    const imgBlocks = req.input[0].content.filter((c) => c.type === "input_image");
    expect(imgBlocks).toHaveLength(2);
    expect(imgBlocks[0].image_url).toBe("data:image/png;base64,AAA=");
    expect(imgBlocks[1].image_url).toBe("data:image/jpeg;base64,BBB=");
  });

  it("buildBody handles generate action when no reference images are provided", () => {
    const body = {
      prompt: "Generate a futuristic cityscape",
    };

    const req = codexImageProvider.buildBody("gpt-image-2", body);

    expect(req.model).toBe("gpt-5.5");
    expect(req.tools[0].model).toBe("gpt-image-2");
    expect(req.tools[0].action).toBe("generate");
    expect(req.tool_choice).toEqual({ type: "image_generation" });
    const imgBlocks = req.input[0].content.filter((c) => c.type === "input_image");
    expect(imgBlocks).toHaveLength(0);
  });

  it("buildHeaders resolves ChatGPT account ID and originator", () => {
    const creds = {
      accessToken: "secret-token-cx",
      providerSpecificData: {
        workspaceId: "ws-test-123",
        chatgptAccountId: "cgt-test-456",
      },
    };

    const headers = codexImageProvider.buildHeaders(creds);

    expect(headers.authorization).toBe("Bearer secret-token-cx");
    expect(headers["chatgpt-account-id"]).toBe("ws-test-123"); // workspaceId precedence
    expect(headers.originator).toBe("codex_cli_rs");
    expect(headers["user-agent"]).toContain("codex_cli_rs");
  });

  it("parseResponse extracts b64 from output_item.done and throws clean error when missing", async () => {
    const sseBody = [
      'event: response.output_item.done\ndata: {"item":{"type":"image_generation_call","result":"B64_IMAGE_RESULT"}}\n\n',
    ].join("");

    const response = new Response(sseBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const result = await codexImageProvider.parseResponse(response, {});
    expect(result.data[0].b64_json).toBe("B64_IMAGE_RESULT");

    // When no image returned in SSE
    const emptyResponse = new Response('event: response.output_item.done\ndata: {"item":{"type":"message"}}\n\n', {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    await expect(codexImageProvider.parseResponse(emptyResponse, {})).rejects.toThrow(
      "Codex did not return an image. Account may not be entitled (Plus/Pro required)."
    );
  });
});
