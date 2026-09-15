/**
 * Devin (Cognition / Codeium / Cascade) Executor
 * Implements ConnectRPC protobuf transport against Cascade backend.
 */

import crypto from "node:crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../providers/index.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { chatChunkSse } from "../utils/sse.js";
import { SSE_DONE, SSE_HEADERS } from "../utils/sseConstants.js";
import {
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_AUTH_PATH,
  DEVIN_CHAT_PATH,
  ChatMessageSource,
  ChatMessageRequestType,
  ConversationalPlannerMode,
  StopReason,
  GetChatMessageRequestSchema,
  GetChatMessageResponseSchema,
  GetUserJwtRequestSchema,
  GetUserJwtResponseSchema,
  toBinary,
  fromBinary,
  buildConnectFrame,
  parseConnectFrames,
  decodeDevinUnaryMessage,
  devinCliMetadata,
  normalizeDevinSessionToken,
  sanitizeCustomApiServerUrl,
  deterministicUuid,
} from "../utils/devinProtobuf.js";

const DEFAULT_MAX_TOKENS = 128000;
const DEFAULT_TEMPERATURE = 1;
const DEFAULT_TOP_P = 0.95;

export class DevinExecutor extends BaseExecutor {
  constructor() {
    super("devin", PROVIDERS.devin);
    this.baseUrl = DEVIN_DEFAULT_BASE_URL;
  }

  transformRequest() {
    return null;
  }

  buildUrl() {
    return `${this.baseUrl || DEVIN_DEFAULT_BASE_URL}${DEVIN_CHAT_PATH}`;
  }

  refreshCredentials() {
    return null;
  }

  needsRefresh() {
    return false;
  }

  resolveSessionToken(credentials) {
    const raw = credentials?.apiKey || credentials?.accessToken || "";
    return normalizeDevinSessionToken(raw) || null;
  }
  shouldRetry(status, urlIndex = 0) {
    return status === 429 || (status >= 500 && status <= 599);
  }

  computeRetryDelay(response, attempt = 0) {
    const retryAfter = response?.headers?.get?.("retry-after");
    if (retryAfter) {
      const seconds = Number.parseInt(retryAfter, 10);
      if (!Number.isNaN(seconds) && seconds > 0) {
        return Math.min(seconds * 1000, 30000);
      }
    }
    return Math.min(1000 * (2 ** attempt), 30000);
  }
  resolveModelId(model) {
    if (!model || typeof model !== "string") return "swe-1-6";
    let m = model.trim();
    if (m.startsWith("devin/")) m = m.slice("devin/".length);
    else if (m.startsWith("dv/")) m = m.slice("dv/".length);
    return m || "swe-1-6";
  }

  async execute({ model, body = {}, credentials, signal, log, proxyOptions = null }) {
    const sessionToken = this.resolveSessionToken(credentials);
    if (!sessionToken) {
      throw new Error("Devin requires an apiKey or accessToken (session token).");
    }

    const wireModel = this.resolveModelId(model);
    const maxRetries = 2;

    // Retry loop for pre-stream requests (GetUserJwt and GetChatMessage initial connect)
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) {
        throw signal.reason || new Error("Request aborted");
      }

      try {
        // Step 1: GetUserJwt
        const { userJwt, chatBaseUrl } = await this.fetchUserJwt({
          sessionToken,
          signal,
          log,
          proxyOptions,
        });
        // Step 2: Build GetChatMessageRequest
        const cascadeId = crypto.randomUUID();
        const requestPayload = this.buildChatPayload({
          body,
          model: wireModel,
          sessionToken,
          userJwt,
          cascadeId,
        });

        const protoBinary = toBinary(GetChatMessageRequestSchema, requestPayload);
        const framedBody = buildConnectFrame(protoBinary, true);

        const chatUrl = `${chatBaseUrl}${DEVIN_CHAT_PATH}`;
        const chatHeaders = {
          "content-type": "application/connect+proto",
          "connect-protocol-version": "1",
          "connect-content-encoding": "gzip",
          "accept-encoding": "identity",
          "connect-accept-encoding": "gzip",
          "user-agent": "connect-go/1.18.1 (go1.26.3)",
        };

        log?.debug?.("DEVIN", `Devin -> ${chatUrl} (model=${wireModel}, cascadeId=${cascadeId})`);

        const upstream = await proxyAwareFetch(
          chatUrl,
          {
            method: "POST",
            headers: chatHeaders,
            body: framedBody,
            signal,
          },
          proxyOptions
        );

        if (!upstream.ok) {
          if (this.shouldRetry(upstream.status) && attempt < maxRetries) {
            const delay = this.computeRetryDelay(upstream, attempt);
            log?.warn?.("DEVIN", `Devin upstream HTTP ${upstream.status}, retrying after ${delay}ms...`);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          const errorText = await upstream.text().catch(() => "");
          throw new Error(`Devin upstream HTTP ${upstream.status}: ${errorText || upstream.statusText}`);
        }

        // Stream response: once reading begins, NO replay / NO retry after first client byte
        const sseResponse = this.createSseStream({
          upstream,
          model: wireModel,
          protoBinaryLength: protoBinary.length,
          signal,
          log,
        });

        return {
          response: sseResponse,
          url: chatUrl,
          headers: chatHeaders,
        };
      } catch (err) {
        lastError = err;
        if (signal?.aborted || err.name === "AbortError") {
          throw err;
        }
        if (attempt < maxRetries && err.isTransientNetwork) {
          const delay = Math.min(1000 * (2 ** attempt), 10000);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }

    throw lastError || new Error("Devin request failed after retries.");
  }

  async fetchUserJwt({ sessionToken, signal, log, proxyOptions }) {
    const authUrl = `${this.baseUrl || DEVIN_DEFAULT_BASE_URL}${DEVIN_AUTH_PATH}`;
    const authReqBinary = toBinary(GetUserJwtRequestSchema, {
      metadata: devinCliMetadata(sessionToken),
    });

    const response = await proxyAwareFetch(
      authUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/proto",
          "connect-protocol-version": "1",
          accept: "*/*",
        },
        body: authReqBinary,
        signal,
      },
      proxyOptions
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      const err = new Error(`Devin GetUserJwt failed (${response.status}): ${errText}`);
      if (this.shouldRetry(response.status)) err.isTransientNetwork = true;
      throw err;
    }

    const payloadBuffer = Buffer.from(await response.arrayBuffer());
    const decoded = decodeDevinUnaryMessage(GetUserJwtResponseSchema, payloadBuffer);

    if (!decoded?.userJwt || typeof decoded.userJwt !== "string" || !decoded.userJwt.trim()) {
      throw new Error("Devin auth error: GetUserJwt returned an empty user JWT. Please re-login.");
    }

    let chatBaseUrl = this.baseUrl || DEVIN_DEFAULT_BASE_URL;
    if (decoded.customApiServerUrl) {
      const sanitized = sanitizeCustomApiServerUrl(decoded.customApiServerUrl);
      if (sanitized) {
        chatBaseUrl = sanitized;
        log?.debug?.("DEVIN", `Custom API server override: ${chatBaseUrl}`);
      }
    }

    return { userJwt: decoded.userJwt.trim(), chatBaseUrl };
  }

  /**
   * Builds GetChatMessageRequest for the CHAT protocol (requestType 5) used by
   * devin-cli (chisel) >= 3000.10. Ground truth from wire capture of the real CLI:
   * no AssignModel / modelAssignmentJwt, no toolChoice / systemPromptCacheOptions /
   * executionId / disableParallelToolCalls, no stopPatterns / firstTemperature /
   * fimEotProbThreshold in configuration. Unknown fields are rejected upstream.
   */
  buildChatPayload({ body, model, sessionToken, userJwt, cascadeId }) {
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const { prompt, chatMessagePrompts } = this.mapMessages(rawMessages, cascadeId);

    const maxTokens = body.max_tokens ?? body.max_completion_tokens ?? DEFAULT_MAX_TOKENS;
    const temp = body.temperature ?? DEFAULT_TEMPERATURE;
    const topP = body.top_p ?? DEFAULT_TOP_P;

    const tools = (body.tools || []).map((t) => {
      const fn = t.function || t;
      return {
        name: fn.name,
        description: fn.description || "",
        jsonSchemaString: JSON.stringify(fn.parameters || {}),
        strict: Boolean(fn.strict ?? false),
      };
    });

    return {
      metadata: devinCliMetadata(sessionToken, userJwt),
      prompt,
      chatMessagePrompts,
      chatModelUid: model,
      plannerMode: ConversationalPlannerMode.DEFAULT,
      requestType: ChatMessageRequestType.CHAT,
      configuration: {
        numCompletions: 1n,
        maxTokens: BigInt(maxTokens),
        maxNewlines: 400n,
        temperature: temp,
        topK: 40n,
        topP,
      },
      tools,
      cascadeId,
    };
  }

  mapMessages(messages, cascadeId) {
    const systemPrompts = [];
    const conversationMessages = [];

    for (const msg of messages) {
      if (msg.role === "system" || msg.role === "developer") {
        const text = extractMessageText(msg.content);
        if (text) systemPrompts.push(text);
      } else {
        conversationMessages.push(msg);
      }
    }

    const chatMessagePrompts = conversationMessages.map((msg, idx) => {
      const messageId = deterministicUuid(
        `${cascadeId}\0${idx}\0${msg.role}${msg.tool_call_id ? `\0${msg.tool_call_id}` : ""}`
      );

      if (msg.role === "assistant") {
        const text = extractMessageText(msg.content);
        const toolCalls = Array.isArray(msg.tool_calls)
          ? msg.tool_calls.map((tc) => ({
              id: tc.id,
              name: tc.function?.name || tc.name,
              argumentsJson:
                typeof tc.function?.arguments === "string"
                  ? tc.function.arguments
                  : JSON.stringify(tc.function?.arguments || {}),
            }))
          : [];

        return {
          messageId,
          source: ChatMessageSource.SYSTEM,
          prompt: text,
          thinking: "", // NEVER replay thinking
          signature: "", // NEVER replay signature
          toolCalls,
        };
      }

      if (msg.role === "tool") {
        const text = extractMessageText(msg.content);
        const isError = Boolean(
          msg.is_error ||
            (typeof msg.content === "string" && msg.content.startsWith("Error:")) ||
            msg.status === "error"
        );

        return {
          messageId,
          source: ChatMessageSource.TOOL,
          prompt: text,
          toolCallId: msg.tool_call_id || "",
          toolResultIsError: isError,
        };
      }

      // User or other roles
      const text = extractMessageText(msg.content);
      const images = extractMessageImages(msg.content);

      return {
        messageId,
        source: ChatMessageSource.USER,
        prompt: text,
        images,
      };
    });

    return {
      prompt: systemPrompts.join("\n\n"),
      chatMessagePrompts,
    };
  }

  createSseStream({ upstream, model, protoBinaryLength, signal, log }) {
    const textEncoder = new TextEncoder();
    let firstByteEmitted = false;
    let pendingBuffer = Buffer.alloc(0);

    let responseId = "";
    let responseModel = model;
    const created = Math.floor(Date.now() / 1000);

    const toolCallsMap = new Map();
    const toolCallsList = [];
    let latestStopReason = 0;

    const accumulatedUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    const accumulatedCost = {
      creditCost: 0,
      committedCreditCost: 0,
      committedAcuCost: 0,
      committedQuotaCostBasisPoints: 0,
      committedOverageCostCents: 0,
    };

    const reader = upstream.body.getReader();

    const stream = new ReadableStream({
      async start(controller) {
        const emit = (str) => {
          firstByteEmitted = true;
          controller.enqueue(textEncoder.encode(str));
        };

        const abortHandler = () => {
          reader.cancel().catch(() => {});
          try {
            controller.error(signal?.reason || new Error("Stream aborted"));
          } catch {}
        };
        if (signal?.aborted) {
          abortHandler();
          return;
        }
        signal?.addEventListener("abort", abortHandler, { once: true });

        try {
          while (true) {
            if (signal?.aborted) {
              throw signal.reason || new Error("Stream aborted");
            }
            const { done, value } = await reader.read();
            if (signal?.aborted) {
              throw signal.reason || new Error("Stream aborted");
            }
            if (done) break;

            pendingBuffer = Buffer.concat([pendingBuffer, Buffer.from(value)]);

            const { frames, remaining } = parseConnectFrames(pendingBuffer, { isStreamEnd: false });
            pendingBuffer = remaining;

            for (const frame of frames) {
              if (frame.isEndStream) {
                // Trailer frame: check for Connect error
                const trailerErr = parseConnectTrailerError(frame.payload);
                if (trailerErr) {
                  // Check pre-first-token context overflow
                  if (
                    !firstByteEmitted &&
                    String(trailerErr.code || "").toLowerCase() === "invalid_argument" &&
                    /internal error/i.test(trailerErr.message || "") &&
                    protoBinaryLength >= 512 * 1024
                  ) {
                    const overflowErr = new Error(
                      `Devin context overflow error: ${trailerErr.message || "history too large"}`
                    );
                    overflowErr.isContextOverflow = true;
                    throw overflowErr;
                  }
                  throw new Error(`Devin stream error [${trailerErr.code}]: ${trailerErr.message}`);
                }
                continue;
              }

              // Normal data frame
              const msg = fromBinary(GetChatMessageResponseSchema, frame.payload);

              if (!responseId && msg.messageId) {
                responseId = msg.messageId;
              }
              if (msg.actualModelUid) {
                responseModel = msg.actualModelUid;
              }

              // Delta thinking / reasoning
              if (msg.deltaThinking) {
                emit(
                  chatChunkSse({
                    id: responseId || `chatcmpl-${created}`,
                    created,
                    model: responseModel,
                    delta: { reasoning_content: msg.deltaThinking },
                  })
                );
              }

              // Delta text / content
              if (msg.deltaText) {
                emit(
                  chatChunkSse({
                    id: responseId || `chatcmpl-${created}`,
                    created,
                    model: responseModel,
                    delta: { content: msg.deltaText },
                  })
                );
              }

              // Tool calls streaming
              if (Array.isArray(msg.deltaToolCalls) && msg.deltaToolCalls.length > 0) {
                for (const tc of msg.deltaToolCalls) {
                  let existing = toolCallsMap.get(tc.id);
                  if (!existing) {
                    existing = {
                      index: toolCallsList.length,
                      id: tc.id,
                      name: tc.name || "",
                      arguments: "",
                    };
                    toolCallsList.push(existing);
                    toolCallsMap.set(tc.id, existing);

                    emit(
                      chatChunkSse({
                        id: responseId || `chatcmpl-${created}`,
                        created,
                        model: responseModel,
                        delta: {
                          tool_calls: [
                            {
                              index: existing.index,
                              id: existing.id,
                              type: "function",
                              function: {
                                name: existing.name,
                                arguments: tc.argumentsJson || "",
                              },
                            },
                          ],
                        },
                      })
                    );
                  } else {
                    emit(
                      chatChunkSse({
                        id: responseId || `chatcmpl-${created}`,
                        created,
                        model: responseModel,
                        delta: {
                          tool_calls: [
                            {
                              index: existing.index,
                              function: {
                                arguments: tc.argumentsJson || "",
                              },
                            },
                          ],
                        },
                      })
                    );
                  }

                  if (tc.argumentsJson) {
                    existing.arguments += tc.argumentsJson;
                  }
                }
              }

              // Track stopReason
              if (msg.stopReason !== undefined && msg.stopReason !== 0) {
                latestStopReason = msg.stopReason;
              }

              // Track token usage
              if (msg.usage) {
                accumulatedUsage.inputTokens += Number(msg.usage.inputTokens || 0n);
                accumulatedUsage.outputTokens += Number(msg.usage.outputTokens || 0n);
                accumulatedUsage.cacheReadTokens += Number(msg.usage.cacheReadTokens || 0n);
                accumulatedUsage.cacheWriteTokens += Number(msg.usage.cacheWriteTokens || 0n);
              }

              // Track cost
              if (msg.creditCost) accumulatedCost.creditCost += msg.creditCost;
              if (msg.committedCreditCost) accumulatedCost.committedCreditCost += msg.committedCreditCost;
              if (msg.committedAcuCost) accumulatedCost.committedAcuCost += msg.committedAcuCost;
              if (msg.committedQuotaCostBasisPoints) {
                accumulatedCost.committedQuotaCostBasisPoints += Number(msg.committedQuotaCostBasisPoints);
              }
              if (msg.committedOverageCostCents) {
                accumulatedCost.committedOverageCostCents += Number(msg.committedOverageCostCents);
              }
            }
          }
          if (signal?.aborted) {
            throw signal.reason || new Error("Stream aborted");
          }
          // Check if stream closed with trailing partial frame
          if (pendingBuffer.length > 0) {
            parseConnectFrames(pendingBuffer, { isStreamEnd: true });
          }

          // Determine finish reason
          let finishReason = "stop";
          if (toolCallsList.length > 0) {
            finishReason = "tool_calls";
          } else if (latestStopReason === StopReason.MAX_TOKENS) {
            finishReason = "length";
          } else if (latestStopReason === StopReason.FUNCTION_CALL) {
            finishReason = "tool_calls";
          }

          const promptTokens = accumulatedUsage.inputTokens + accumulatedUsage.cacheReadTokens;
          const completionTokens = accumulatedUsage.outputTokens;
          const totalTokens = promptTokens + completionTokens;

          const finalChunk = {
            id: responseId || `chatcmpl-${created}`,
            object: "chat.completion.chunk",
            created,
            model: responseModel,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: finishReason,
              },
            ],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: totalTokens,
              prompt_tokens_details: {
                cached_tokens: accumulatedUsage.cacheReadTokens,
              },
              ...(accumulatedCost.creditCost > 0 ? { credit_cost: accumulatedCost.creditCost } : {}),
            },
          };

          emit(`data: ${JSON.stringify(finalChunk)}\n\n`);
          emit(SSE_DONE);
          controller.close();
        } catch (err) {
          log?.error?.("DEVIN", "Stream error:", err);
          try {
            // App-level upstream errors (e.g. Connect trailer [unavailable]) must
            // NOT error the stream: Next.js turns that into "failed to pipe
            // response" and drops the connection before any byte reaches the
            // client (curl 52 empty reply). Emit a well-formed SSE error event +
            // [DONE] instead — same pattern as the kiro integrity gate. The
            // forced SSE→JSON non-stream path surfaces chunk.error as 502 JSON.
            if (err?.name === "AbortError" || signal?.aborted) {
              controller.error(err);
            } else {
              emit(`data: ${JSON.stringify({ error: { message: err?.message || "Devin stream error", type: "upstream_error" } })}\n\n`);
              emit(SSE_DONE);
              controller.close();
            }
          } catch {}
        } finally {
          signal?.removeEventListener("abort", abortHandler);
        }
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  }
}

function extractMessageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && (part.type === "text" || typeof part.text === "string"))
      .map((part) => part.text || "")
      .join("\n");
  }
  return "";
}

function extractMessageImages(content) {
  if (!Array.isArray(content)) return [];
  const images = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === "image_url" && part.image_url?.url) {
      const url = part.image_url.url;
      if (url.startsWith("data:")) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          images.push({
            mimeType: match[1],
            base64Data: match[2],
            caption: "",
          });
        }
      }
    } else if (part.type === "image" && part.source?.data) {
      images.push({
        mimeType: part.source.media_type || "image/png",
        base64Data: part.source.data,
        caption: "",
      });
    }
  }
  return images;
}

function parseConnectTrailerError(payload) {
  if (!payload || payload.length === 0) return null;
  try {
    const parsed = JSON.parse(payload.toString("utf8"));
    if (parsed && typeof parsed === "object" && parsed.error) {
      return parsed.error;
    }
    return null;
  } catch {
    return null;
  }
}
