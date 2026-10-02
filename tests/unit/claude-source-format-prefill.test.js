import { describe, expect, it } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("Claude source-format trailing-turn cleanup", () => {
  it("preserves an intentional Gemini model prefill after Claude preparation", () => {
    const translated = translateRequest(
      FORMATS.GEMINI,
      FORMATS.CLAUDE,
      "claude-sonnet-4",
      {
        contents: [
          { role: "user", parts: [{ text: "question" }] },
          { role: "model", parts: [{ text: "prefill" }] },
        ],
        max_tokens: 128,
      },
      true,
      {},
      "claude",
    );

    expect(translated.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: expect.arrayContaining([expect.objectContaining({ type: "text", text: "prefill" })]),
    });
  });
});
