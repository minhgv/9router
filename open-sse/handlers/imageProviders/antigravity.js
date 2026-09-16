// Antigravity image adapter - delegates to the executor for correct request
// envelope (project, model, requestType, sessionId) and auth headers.
import { nowSec, sizeToAspectRatio } from "./_base.js";
import { getExecutor } from "../../executors/index.js";
import { deriveConnectionProxyOptions } from "../../utils/proxyFetch.js";

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// Convert image input (data URI or raw base64) to Gemini inlineData part
function resolveImageInput(input) {
  if (!input || typeof input !== "string") return null;
  // data:image/png;base64,... format
  const dataUriMatch = input.match(/^data:(image\/[^;]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (dataUriMatch) {
    const rawData = dataUriMatch[2].replace(/[\r\n\s]/g, "");
    if (rawData.length > 0 && BASE64_RE.test(rawData)) {
      return { inlineData: { mimeType: dataUriMatch[1], data: rawData } };
    }
    return null;
  }
  // Raw base64 string (assume PNG)
  const cleanInput = input.replace(/[\r\n\s]/g, "");
  if (cleanInput.length > 100 && !input.startsWith("http") && !input.startsWith("file:") && !input.startsWith("ftp:") && BASE64_RE.test(cleanInput)) {
    return { inlineData: { mimeType: "image/png", data: cleanInput } };
  }
  return null;
}

export default {
  // Delegate to executor instead of building URL/headers/body manually
  useExecutor: true,

  // Stubs - required by imageGenerationCore interface but unused with useExecutor
  buildUrl: () => "",
  buildHeaders: () => ({}),
  buildBody: () => ({}),

  async executeViaExecutor(model, body, credentials, log, proxyOptions = null) {
    const executor = getExecutor("antigravity");
    if (!executor) throw new Error("Antigravity executor not found");

    // Ensure we use an image model for image generation
    const isImageModel = (m) => /image|imagen|image-generation/i.test(m || "");
    let targetModel = isImageModel(model) ? model : "gemini-3.1-flash-image";

    // If body.size is provided, resolve aspect ratio and append to model
    if (body.size && typeof body.size === "string") {
      const ratio = sizeToAspectRatio(body.size);
      const suffix = ratio.replace(":", "x");
      if (!targetModel.includes(suffix)) {
        targetModel = `${targetModel}-${suffix}`;
      }
    }

    // Build parts: text prompt + optional input image for editing
    const parts = [{ text: body.prompt }];
    const imageInput = body.image || (Array.isArray(body.images) && body.images[0]);
    if (imageInput) {
      const inlineData = resolveImageInput(imageInput);
      if (inlineData) parts.unshift(inlineData);
    }

    const chatBody = {
      contents: [{ role: "user", parts }],
    };

    const result = await executor.execute({
      model: targetModel,
      body: chatBody,
      stream: false,
      credentials,
      log,
      proxyOptions: proxyOptions ?? deriveConnectionProxyOptions(credentials),
    });

    if (!result.response.ok) {
      const text = await result.response.text();
      throw new Error(text || `HTTP ${result.response.status}`);
    }

    return result.response.json();
  },

  normalize: (responseBody, prompt) => {
    const candidates = responseBody.candidates || responseBody.response?.candidates || [];
    const parts = candidates[0]?.content?.parts || [];
    const images = parts.filter((p) => p.inlineData?.data).map((p) => ({
      b64_json: p.inlineData.data,
    }));
    return {
      created: nowSec(),
      data: images.length > 0 ? images : [{ b64_json: "", revised_prompt: prompt }],
    };
  },
};