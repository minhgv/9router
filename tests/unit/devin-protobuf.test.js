import { describe, it, expect, beforeEach, afterEach } from "vitest";
import zlib from "node:zlib";
import {
  encodeVarint,
  decodeVarint,
  encodeZigZag32,
  decodeZigZag32,
  encodeZigZag64,
  decodeZigZag64,
  toBinary,
  fromBinary,
  buildConnectFrame,
  parseConnectFrames,
  decodeDevinUnaryMessage,
  normalizeDevinSessionToken,
  devinCliMetadata,
  devinDiscoveryMetadata,
  sanitizeCustomApiServerUrl,
  ChatMessageSource,
  ChatMessageRequestType,
  ConversationalPlannerMode,
  PromptCacheType,
  StopReason,
  AssignModelRequestSchema,
  GetChatMessageRequestSchema,
  GetChatMessageResponseSchema,
  GetUserJwtRequestSchema,
  GetUserJwtResponseSchema,
  MetadataSchema,
  TimestampSchema,
  ImageDataSchema,
  ChatToolCallSchema,
  ChatToolChoiceSchema,
  ChatToolDefinitionSchema,
  PromptCacheOptionsSchema,
  CompletionConfigurationSchema,
  ModelUsageStatsSchema,
  ModelAssignmentSchema,
  ModelFeaturesSchema,
  ModelInfoSchema,
  ModelFamilyMetadataSchema,
  ModelFamilyMetadataEntrySchema,
  ModelFamilyMetadataValueSchema,
  ModelDimensionSchema,
  ClientModelConfigSchema,
  GetCliModelConfigsRequestSchema,
  GetCliModelConfigsResponseSchema,
  DevinPlanInfoSchema,
  PlanInfoSchema,
  PlanStatusSchema,
  UserStatusSchema,
  GetUserStatusRequestSchema,
  GetUserStatusResponseSchema,
  DEVIN_DEFAULT_BASE_URL,
  DEVIN_DEFAULT_STOP_PATTERNS,
  DEVIN_AUTH_PATH,
  DEVIN_CHAT_PATH,
  DEVIN_ASSIGN_MODEL_PATH,
  DEVIN_USER_STATUS_PATH,
  DEVIN_CLI_MODEL_CONFIGS_PATH,
  DisplayOption,
  DEVIN_SUPPORTED_MODEL_DISPLAYS,
  MAX_CONNECT_FRAME_PAYLOAD,
} from "open-sse/utils/devinProtobuf.js";

describe("devinProtobuf", () => {
  describe("varint and zigzag edge cases", () => {
    it("encodes and decodes 32-bit varints correctly across boundary values", () => {
      const cases = [0, 1, 127, 128, 255, 256, 16383, 16384, 2097151, 2097152, 268435455, 268435456, 0xffffffff];
      for (const val of cases) {
        const encoded = encodeVarint(val);
        const { value, bytesRead } = decodeVarint(encoded);
        expect(Number(value)).toBe(val >>> 0);
        expect(bytesRead).toBe(encoded.length);
      }
    });

    it("encodes and decodes 64-bit varints correctly across large boundaries", () => {
      const cases = [
        0n,
        1n,
        127n,
        128n,
        0xffffffffn,
        0x100000000n,
        0x7fffffffffffffffn,
        0xffffffffffffffffn,
      ];
      for (const val of cases) {
        const encoded = encodeVarint(val);
        const { value } = decodeVarint(encoded);
        expect(BigInt(value)).toBe(BigInt.asUintN(64, val));
      }
    });

    it("handles zigzag32 round trips for positive, negative, and extreme integers", () => {
      const cases = [0, -1, 1, -2, 2, -100, 100, 2147483647, -2147483648];
      expect(encodeZigZag32(0)).toBe(0);
      expect(encodeZigZag32(-1)).toBe(1);
      expect(encodeZigZag32(1)).toBe(2);
      expect(encodeZigZag32(-2)).toBe(3);

      for (const val of cases) {
        const zz = encodeZigZag32(val);
        expect(decodeZigZag32(zz)).toBe(val);
      }
    });

    it("handles zigzag64 round trips for 64-bit bigints", () => {
      const cases = [
        0n,
        -1n,
        1n,
        -2n,
        2n,
        -123456789012345n,
        123456789012345n,
        0x7fffffffffffffffn,
        -0x8000000000000000n,
      ];
      expect(encodeZigZag64(0n)).toBe(0n);
      expect(encodeZigZag64(-1n)).toBe(1n);
      expect(encodeZigZag64(1n)).toBe(2n);

      for (const val of cases) {
        const zz = encodeZigZag64(val);
        expect(decodeZigZag64(zz)).toBe(val);
      }
    });
  });

  describe("golden round-trip of GetChatMessageRequest", () => {
    it("encodes and decodes a representative GetChatMessageRequest identically", () => {
      const request = {
        metadata: {
          ideName: "devin-cli",
          ideVersion: "3000.10.23",
          ideType: "chisel",
          extensionName: "chisel",
          extensionVersion: "3000.10.23",
          apiKey: "devin-session-token$test_key_123",
          locale: "en",
          os: "darwin",
          userJwt: "jwt_token_abc_456",
        },
        prompt: "You are a helpful coding assistant.",
        chatMessagePrompts: [
          {
            messageId: "msg-001",
            source: ChatMessageSource.USER,
            prompt: "Please inspect this issue and call the tool.",
            images: [
              {
                base64Data: "aW1hZ2VkYXRh",
                mimeType: "image/png",
                caption: "screenshot.png",
              },
            ],
            promptCacheOptions: {
              type: PromptCacheType.EPHEMERAL,
            },
          },
          {
            messageId: "msg-002",
            source: ChatMessageSource.SYSTEM,
            prompt: "I will call the search tool.",
            thinking: "",
            signature: "",
            toolCalls: [
              {
                id: "call_abc_1",
                name: "search_code",
                argumentsJson: JSON.stringify({ query: "devin" }),
              },
            ],
          },
          {
            messageId: "msg-003",
            source: ChatMessageSource.TOOL,
            prompt: "Found 5 matches in codebase.",
            toolCallId: "call_abc_1",
            toolResultIsError: false,
          },
        ],
        chatModelUid: "swe-1-6",
        requestType: ChatMessageRequestType.CASCADE,
        configuration: {
          numCompletions: 1n,
          maxTokens: 64000n,
          maxNewlines: 200n,
          temperature: 0.4,
          firstTemperature: 0.4,
          topK: 50n,
          topP: 1.0,
          stopPatterns: ["<|user|>", "<|bot|>", "<|endoftext|>"],
          fimEotProbThreshold: 1.0,
        },
        tools: [
          {
            name: "search_code",
            description: "Search the codebase",
            jsonSchemaString: JSON.stringify({
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            }),
            strict: true,
          },
        ],
        toolChoice: {
          optionName: "auto",
        },
        systemPromptCacheOptions: {
          type: PromptCacheType.EPHEMERAL,
        },
        cascadeId: "cascade-uuid-1234",
        executionId: "execution-uuid-5678",
      };

      const binary = toBinary(GetChatMessageRequestSchema, request);
      expect(binary.length).toBeGreaterThan(0);

      const decoded = fromBinary(GetChatMessageRequestSchema, binary);

      expect(decoded.prompt).toBe(request.prompt);
      expect(decoded.chatModelUid).toBe("swe-1-6");
      expect(decoded.requestType).toBe(ChatMessageRequestType.CASCADE);
      expect(decoded.cascadeId).toBe("cascade-uuid-1234");
      expect(decoded.executionId).toBe("execution-uuid-5678");

      expect(decoded.metadata.ideName).toBe("devin-cli");
      expect(decoded.metadata.apiKey).toBe("devin-session-token$test_key_123");
      expect(decoded.metadata.userJwt).toBe("jwt_token_abc_456");

      expect(decoded.chatMessagePrompts).toHaveLength(3);
      expect(decoded.chatMessagePrompts[0].source).toBe(ChatMessageSource.USER);
      expect(decoded.chatMessagePrompts[0].images[0].mimeType).toBe("image/png");
      expect(decoded.chatMessagePrompts[1].source).toBe(ChatMessageSource.SYSTEM);
      expect(decoded.chatMessagePrompts[1].toolCalls[0].name).toBe("search_code");
      expect(decoded.chatMessagePrompts[2].source).toBe(ChatMessageSource.TOOL);
      expect(decoded.chatMessagePrompts[2].toolCallId).toBe("call_abc_1");

      expect(decoded.configuration.temperature).toBeCloseTo(0.4);
      expect(decoded.configuration.stopPatterns).toEqual(["<|user|>", "<|bot|>", "<|endoftext|>"]);
      expect(decoded.tools[0].name).toBe("search_code");
      expect(decoded.tools[0].strict).toBe(true);
      expect(decoded.toolChoice.optionName).toBe("auto");
    });
  });

  describe("wire contract regression guards", () => {
    function scanTags(buf) {
      const out = [];
      let i = 0;
      const readVarint = () => {
        let result = 0n;
        let shift = 0n;
        for (;;) {
          if (i >= buf.length) throw new Error("truncated varint");
          const b = buf[i++];
          result |= BigInt(b & 0x7f) << shift;
          if ((b & 0x80) === 0) break;
          shift += 7n;
        }
        const val = result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : result;
        return val;
      };
      while (i < buf.length) {
        const tag = Number(readVarint());
        const fieldNo = tag >>> 3;
        const wireType = tag & 7;
        const entry = { fieldNo, wireType };
        if (wireType === 0) entry.value = Number(readVarint());
        else if (wireType === 1) i += 8;
        else if (wireType === 5) i += 4;
        else if (wireType === 2) { const len = Number(readVarint()); i += len; }
        else throw new Error(`unexpected wire type ${wireType}`);
        out.push(entry);
      }
      return out;
    }

    function unknownFieldBytes() {
      const parts = [];
      // field 99, wire type 0 (varint), value 300
      parts.push(encodeVarint((99 << 3) | 0), encodeVarint(300));
      // field 100, wire type 2 (length-delimited)
      const payload = Buffer.from("unknown-payload", "utf8");
      parts.push(encodeVarint((100 << 3) | 2), encodeVarint(payload.length), payload);
      // field 101, wire type 1 (fixed64)
      const fixed64 = Buffer.alloc(8);
      fixed64.writeDoubleLE(1.5, 0);
      parts.push(encodeVarint((101 << 3) | 1), fixed64);
      // field 102, wire type 5 (fixed32)
      const fixed32 = Buffer.alloc(4);
      fixed32.writeFloatLE(2.5, 0);
      parts.push(encodeVarint((102 << 3) | 5), fixed32);
      return Buffer.concat(parts);
    }

    it("skips unknown fields of every wire type instead of throwing", () => {
      const metadata = devinCliMetadata("skip_test", "jwt_xyz");
      const binary = toBinary(MetadataSchema, metadata);
      const extended = Buffer.concat([binary, unknownFieldBytes()]);

      const decoded = fromBinary(MetadataSchema, extended);
      expect(decoded.ideName).toBe("devin-cli");
      expect(decoded.apiKey).toBe("devin-session-token$skip_test");
      expect(decoded.userJwt).toBe("jwt_xyz");
      expect(Object.keys(decoded)).not.toContain("99");
      expect(Object.keys(decoded)).not.toContain("100");
      expect(Object.keys(decoded)).not.toContain("101");
      expect(Object.keys(decoded)).not.toContain("102");
    });

    it("encodes plannerMode at field 20, cascadeId at 16, executionId at 22 (manual tag scan)", () => {
      const request = {
        metadata: devinCliMetadata("k", "jwt"),
        chatModelUid: "swe-2-high",
        plannerMode: ConversationalPlannerMode.DEFAULT,
        requestType: ChatMessageRequestType.CASCADE,
        cascadeId: "cascade-id-16-check",
        executionId: "execution-id-22-check",
      };
      const binary = toBinary(GetChatMessageRequestSchema, request);
      const tags = scanTags(binary);

      const requestType = tags.find((t) => t.fieldNo === 7);
      expect(requestType).toBeDefined();
      expect(requestType.wireType).toBe(0);
      expect(requestType.value).toBe(5);
      expect(ChatMessageRequestType.CASCADE).toBe(5);

      const planner = tags.find((t) => t.fieldNo === 20);
      expect(planner).toBeDefined();
      expect(planner.wireType).toBe(0);
      expect(planner.value).toBe(1);

      const cascade = tags.find((t) => t.fieldNo === 16);
      expect(cascade).toBeDefined();
      expect(cascade.wireType).toBe(2);

      const execution = tags.find((t) => t.fieldNo === 22);
      expect(execution).toBeDefined();
      expect(execution.wireType).toBe(2);

      const decoded = fromBinary(GetChatMessageRequestSchema, binary);
      expect(decoded.requestType).toBe(ChatMessageRequestType.CASCADE);
      expect(decoded.plannerMode).toBe(ConversationalPlannerMode.DEFAULT);
      expect(decoded.cascadeId).toBe("cascade-id-16-check");
      expect(decoded.executionId).toBe("execution-id-22-check");
    });
    it("encodes AssignModelRequest with the router prompt at field 5 (manual tag scan)", () => {
      const request = {
        metadata: devinCliMetadata("assign_key"),
        modelRouterUid: "adaptive",
        cascadeId: "cascade-assign-42",
        chatMessagePrompt: {
          messageId: "",
          source: ChatMessageSource.USER,
          prompt: "route me",
          images: [{ base64Data: "aW1hZ2VkYXRh", mimeType: "image/png", caption: "" }],
        },
      };
      const binary = toBinary(AssignModelRequestSchema, request);
      const tags = scanTags(binary);

      // Field 5 carries the router-scoring prompt; a codec that drops it makes
      // the router score an empty turn.
      const promptTags = tags.filter((t) => t.fieldNo === 5);
      expect(promptTags).toHaveLength(1);
      expect(promptTags[0].wireType).toBe(2);
      expect(tags.find((t) => t.fieldNo === 4)).toBeUndefined();

      const decoded = fromBinary(AssignModelRequestSchema, binary);
      expect(decoded.modelRouterUid).toBe("adaptive");
      expect(decoded.cascadeId).toBe("cascade-assign-42");
      expect(decoded.metadata.apiKey).toBe("devin-session-token$assign_key");
      expect(decoded.chatMessagePrompt.messageId ?? "").toBe("");
      expect(decoded.chatMessagePrompt).toMatchObject({
        source: ChatMessageSource.USER,
        prompt: "route me",
      });
      expect(decoded.chatMessagePrompt.images[0]).toMatchObject({
        mimeType: "image/png",
        base64Data: "aW1hZ2VkYXRh",
      });
    });

    it("omits field 5 entirely when no router prompt is supplied", () => {
      const binary = toBinary(AssignModelRequestSchema, {
        metadata: devinCliMetadata("k"),
        modelRouterUid: "adaptive",
        cascadeId: "cascade-1",
      });
      expect(scanTags(binary).find((t) => t.fieldNo === 5)).toBeUndefined();

      const decoded = fromBinary(AssignModelRequestSchema, binary);
      expect(decoded.modelRouterUid).toBe("adaptive");
      expect(decoded.chatMessagePrompt).toBeUndefined();
    });

    it("exports DisplayOption and DEVIN_SUPPORTED_MODEL_DISPLAYS with metadata passthrough", () => {
      expect(DisplayOption).toEqual({
        UNSPECIFIED: 0,
        ARENA: 1,
        BATTLE_GROUP_ONLY: 2,
        MODEL_ROUTER: 3,
        QUICK_REVIEW: 4,
      });
      expect(DEVIN_SUPPORTED_MODEL_DISPLAYS).toEqual([3, 4, 6, 7, 8]);
      expect(devinDiscoveryMetadata("tok").supportedModelDisplays).toEqual([3, 4, 6, 7, 8]);
      expect(devinDiscoveryMetadata("tok", [1]).supportedModelDisplays).toEqual([1]);
    });
  });

  describe("Connect frame build and incremental parse", () => {
    it("builds and parses uncompressed frame (flag 0x00)", () => {
      const payload = Buffer.from("hello uncompressed connect frame");
      const framed = buildConnectFrame(payload, false);

      expect(framed[0]).toBe(0x00);
      expect(framed.readUInt32BE(1)).toBe(payload.length);
      expect(framed.subarray(5).toString("utf8")).toBe("hello uncompressed connect frame");

      const { frames, remaining } = parseConnectFrames(framed);
      expect(frames).toHaveLength(1);
      expect(frames[0].flags).toBe(0x00);
      expect(frames[0].isCompressed).toBe(false);
      expect(frames[0].isEndStream).toBe(false);
      expect(frames[0].payload.toString("utf8")).toBe("hello uncompressed connect frame");
      expect(remaining.length).toBe(0);
    });

    it("builds and parses compressed frame (flag 0x01)", () => {
      const payload = Buffer.from("hello gzip compressed connect frame");
      const framed = buildConnectFrame(payload, true);

      expect(framed[0]).toBe(0x01);
      const len = framed.readUInt32BE(1);
      expect(len).toBe(framed.length - 5);

      const { frames, remaining } = parseConnectFrames(framed);
      expect(frames).toHaveLength(1);
      expect(frames[0].flags).toBe(0x01);
      expect(frames[0].isCompressed).toBe(true);
      expect(frames[0].isEndStream).toBe(false);
      expect(frames[0].payload.toString("utf8")).toBe("hello gzip compressed connect frame");
      expect(remaining.length).toBe(0);
    });

    it("parses end-stream frame (flag 0x02 and 0x03 with gzip)", () => {
      const trailerJson = JSON.stringify({ error: { code: "invalid_argument", message: "Bad request" } });
      const trailerBuf = Buffer.from(trailerJson, "utf8");

      // Uncompressed trailer (0x02)
      const header02 = Buffer.alloc(5);
      header02[0] = 0x02;
      header02.writeUInt32BE(trailerBuf.length, 1);
      const frame02 = Buffer.concat([header02, trailerBuf]);

      const parsed02 = parseConnectFrames(frame02);
      expect(parsed02.frames).toHaveLength(1);
      expect(parsed02.frames[0].isEndStream).toBe(true);
      expect(parsed02.frames[0].payload.toString("utf8")).toBe(trailerJson);

      // Gzip-compressed trailer (0x03)
      const gzippedTrailer = zlib.gzipSync(trailerBuf);
      const header03 = Buffer.alloc(5);
      header03[0] = 0x03;
      header03.writeUInt32BE(gzippedTrailer.length, 1);
      const frame03 = Buffer.concat([header03, gzippedTrailer]);

      const parsed03 = parseConnectFrames(frame03);
      expect(parsed03.frames).toHaveLength(1);
      expect(parsed03.frames[0].isEndStream).toBe(true);
      expect(parsed03.frames[0].isCompressed).toBe(true);
      expect(parsed03.frames[0].payload.toString("utf8")).toBe(trailerJson);
    });

    it("parses multi-frame chunk streams incrementally across chunk splits", () => {
      const frame1 = buildConnectFrame(Buffer.from("chunk 1"), true);
      const frame2 = buildConnectFrame(Buffer.from("chunk 2"), true);
      const combined = Buffer.concat([frame1, frame2]);

      // Split right in the middle of frame1's payload
      const part1 = combined.subarray(0, 8);
      const part2 = combined.subarray(8);

      const res1 = parseConnectFrames(part1);
      expect(res1.frames).toHaveLength(0);
      expect(res1.remaining.length).toBe(8);

      const res2 = parseConnectFrames(Buffer.concat([res1.remaining, part2]));
      expect(res2.frames).toHaveLength(2);
      expect(res2.frames[0].payload.toString("utf8")).toBe("chunk 1");
      expect(res2.frames[1].payload.toString("utf8")).toBe("chunk 2");
      expect(res2.remaining.length).toBe(0);
    });

    it("throws on truncated frame when isStreamEnd is true", () => {
      const partialFrame = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x10, 0x01, 0x02]);
      expect(() => {
        parseConnectFrames(partialFrame, { isStreamEnd: true });
      }).toThrow(/Truncated Connect frame at stream end/);
    });

    it("rejects frame length exceeding 16MiB cap", () => {
      const oversizeHeader = Buffer.alloc(5);
      oversizeHeader[0] = 0x00;
      oversizeHeader.writeUInt32BE(MAX_CONNECT_FRAME_PAYLOAD + 1, 1);

      expect(() => {
        parseConnectFrames(Buffer.concat([oversizeHeader, Buffer.alloc(10)]));
      }).toThrow(/exceeds/);
    });

    it("decodes unary message with bare protobuf and gzip fallback", () => {
      const sample = { userJwt: "jwt_unary_123", customApiServerUrl: "https://custom.server.com" };
      const rawProto = toBinary(GetUserJwtResponseSchema, sample);

      // Bare decode
      const bareDecoded = decodeDevinUnaryMessage(GetUserJwtResponseSchema, rawProto);
      expect(bareDecoded.userJwt).toBe("jwt_unary_123");
      expect(bareDecoded.customApiServerUrl).toBe("https://custom.server.com");

      // Gzip-compressed decode fallback
      const gzipped = zlib.gzipSync(rawProto);
      const gzipDecoded = decodeDevinUnaryMessage(GetUserJwtResponseSchema, gzipped);
      expect(gzipDecoded.userJwt).toBe("jwt_unary_123");
      expect(gzipDecoded.customApiServerUrl).toBe("https://custom.server.com");
    });
    it("builds and parses 0-byte uncompressed payload frame (flag 0x00)", () => {
      const framed = buildConnectFrame(Buffer.alloc(0), false);
      expect(framed.length).toBe(5);
      expect(framed[0]).toBe(0x00);
      expect(framed.readUInt32BE(1)).toBe(0);

      const { frames, remaining } = parseConnectFrames(framed, { isStreamEnd: true });
      expect(frames).toHaveLength(1);
      expect(frames[0].isCompressed).toBe(false);
      expect(frames[0].isEndStream).toBe(false);
      expect(frames[0].payload.length).toBe(0);
      expect(remaining.length).toBe(0);
    });

    it("builds and parses 0-byte gzip compressed payload frame (flag 0x01)", () => {
      const framed = buildConnectFrame(Buffer.alloc(0), true);
      expect(framed[0]).toBe(0x01);
      const { frames } = parseConnectFrames(framed, { isStreamEnd: true });
      expect(frames).toHaveLength(1);
      expect(frames[0].isCompressed).toBe(true);
      expect(frames[0].payload.length).toBe(0);
    });

    it("parses interleaved uncompressed, compressed, and trailer frames in a single chunk", () => {
      const f1 = buildConnectFrame(Buffer.from("frame-1"), false);
      const f2 = buildConnectFrame(Buffer.from("frame-2-compressed"), true);
      const trailerJson = JSON.stringify({ error: { code: "unavailable", message: "server maintenance" } });
      const f3 = Buffer.alloc(5 + trailerJson.length);
      f3[0] = 0x02;
      f3.writeUInt32BE(trailerJson.length, 1);
      f3.set(Buffer.from(trailerJson), 5);

      const chunk = Buffer.concat([f1, f2, f3]);
      const { frames, remaining } = parseConnectFrames(chunk, { isStreamEnd: true });
      expect(frames).toHaveLength(3);
      expect(frames[0].payload.toString()).toBe("frame-1");
      expect(frames[0].isCompressed).toBe(false);
      expect(frames[1].payload.toString()).toBe("frame-2-compressed");
      expect(frames[1].isCompressed).toBe(true);
      expect(frames[2].isEndStream).toBe(true);
      expect(JSON.parse(frames[2].payload.toString())).toEqual({
        error: { code: "unavailable", message: "server maintenance" },
      });
      expect(remaining.length).toBe(0);
    });

    it("parses frames arriving across fragmented byte chunks splitting header and payload", () => {
      const frame1 = buildConnectFrame(Buffer.from("first message data"), false);
      const frame2 = buildConnectFrame(Buffer.from("second message data"), true);
      const allBytes = Buffer.concat([frame1, frame2]);

      let pending = Buffer.alloc(0);
      const collected = [];
      const chunkSize = 3;
      for (let i = 0; i < allBytes.length; i += chunkSize) {
        const slice = allBytes.subarray(i, Math.min(i + chunkSize, allBytes.length));
        pending = Buffer.concat([pending, slice]);
        const isLast = i + chunkSize >= allBytes.length;
        const parsed = parseConnectFrames(pending, { isStreamEnd: isLast });
        collected.push(...parsed.frames);
        pending = parsed.remaining;
      }

      expect(collected).toHaveLength(2);
      expect(collected[0].payload.toString()).toBe("first message data");
      expect(collected[1].payload.toString()).toBe("second message data");
      expect(pending.length).toBe(0);
    });

    it("handles empty buffers cleanly", () => {
      const { frames, remaining } = parseConnectFrames(Buffer.alloc(0), { isStreamEnd: false });
      expect(frames).toEqual([]);
      expect(remaining.length).toBe(0);
    });
  });

  describe("token normalization and metadata builders", () => {
    const originalEnv = process.env.DEVIN_IDE_VERSION;

    beforeEach(() => {
      delete process.env.DEVIN_IDE_VERSION;
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.DEVIN_IDE_VERSION = originalEnv;
      } else {
        delete process.env.DEVIN_IDE_VERSION;
      }
    });

    it("normalizes devin session token idempotently", () => {
      expect(normalizeDevinSessionToken("raw_secret_token")).toBe("devin-session-token$raw_secret_token");
      expect(normalizeDevinSessionToken("devin-session-token$already_prefixed")).toBe("devin-session-token$already_prefixed");
      expect(normalizeDevinSessionToken("  token_with_spaces  ")).toBe("devin-session-token$token_with_spaces");
      expect(normalizeDevinSessionToken("")).toBe("");
      expect(normalizeDevinSessionToken(null)).toBe("");
      expect(normalizeDevinSessionToken(undefined)).toBe("");
    });

    it("builds CLI metadata with default version and environment override", () => {
      const metaDefault = devinCliMetadata("my_key", "jwt_abc");
      expect(metaDefault.ideName).toBe("devin-cli");
      expect(metaDefault.ideType).toBe("chisel");
      expect(metaDefault.extensionName).toBe("chisel");
      expect(metaDefault.extensionVersion).toBe(metaDefault.ideVersion);
      expect(metaDefault.apiKey).toBe("devin-session-token$my_key");
      expect(metaDefault.userJwt).toBe("jwt_abc");

      // With env override
      process.env.DEVIN_IDE_VERSION = "3005.1.0";
      const metaOverride = devinCliMetadata("my_key");
      expect(metaOverride.ideVersion).toBe("3005.1.0");
      expect(metaOverride.extensionVersion).toBe("3005.1.0");
      expect(metaOverride.userJwt).toBeUndefined();
    });

    it("builds discovery metadata with chisel 0.0.0-dev and without userJwt", () => {
      const meta = devinDiscoveryMetadata("test_tok");
      expect(meta.ideName).toBe("chisel");
      expect(meta.ideVersion).toBe("0.0.0-dev");
      expect(meta.extensionName).toBe("chisel");
      expect(meta.extensionVersion).toBe("0.0.0-dev");
      expect(meta.apiKey).toBe("devin-session-token$test_tok");
      expect(meta.userJwt).toBeUndefined();
    });

    it("sanitizes customApiServerUrl according to security constraints", () => {
      // Valid HTTPS URLs (port 443 only)
      expect(sanitizeCustomApiServerUrl("https://server.codeium.com")).toBe("https://server.codeium.com");
      expect(sanitizeCustomApiServerUrl("https://server.codeium.com/api/")).toBe("https://server.codeium.com/api");

      // Non-443 port rejected per locked P-DEVIN policy
      expect(sanitizeCustomApiServerUrl("https://devin-cluster.internal.net:8443/api/")).toBeNull();

      // Non-HTTPS rejected
      expect(sanitizeCustomApiServerUrl("http://server.codeium.com")).toBeNull();
      // Localhost rejected
      expect(sanitizeCustomApiServerUrl("https://localhost:8080")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://sub.localhost:8080")).toBeNull();

      // IPs rejected
      expect(sanitizeCustomApiServerUrl("https://127.0.0.1:8080")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://192.168.1.100")).toBeNull();
      expect(sanitizeCustomApiServerUrl("https://[::1]:8080")).toBeNull();

      // Userinfo rejected
      expect(sanitizeCustomApiServerUrl("https://user:pass@server.codeium.com")).toBeNull();

      // Invalid / empty
      expect(sanitizeCustomApiServerUrl("")).toBeNull();
      expect(sanitizeCustomApiServerUrl("not-a-url")).toBeNull();
      expect(sanitizeCustomApiServerUrl(null)).toBeNull();
    });
  });

  describe("schema codecs IR and round-trip (DEV-02 residuals)", () => {
    it("round-trips TimestampSchema", () => {
      const msg = { seconds: 1717000000n, nanos: 500000 };
      const bin = toBinary(TimestampSchema, msg);
      const dec = fromBinary(TimestampSchema, bin);
      expect(dec.seconds).toBe(1717000000n);
      expect(dec.nanos).toBe(500000);
    });

    it("round-trips ImageDataSchema", () => {
      const msg = { base64Data: "iVBORw0KGgoAAAANSUhEUg==", mimeType: "image/png" };
      const bin = toBinary(ImageDataSchema, msg);
      const dec = fromBinary(ImageDataSchema, bin);
      expect(dec).toEqual(msg);
    });

    it("round-trips ChatToolCallSchema and ChatToolChoiceSchema", () => {
      const toolCall = { id: "call_123", name: "fetch_data", argumentsJson: '{"key":"val"}' };
      const tcBin = toBinary(ChatToolCallSchema, toolCall);
      const tcDec = fromBinary(ChatToolCallSchema, tcBin);
      expect(tcDec).toEqual(toolCall);

      const toolChoice = { optionName: "required", toolName: "fetch_data" };
      const choiceBin = toBinary(ChatToolChoiceSchema, toolChoice);
      const choiceDec = fromBinary(ChatToolChoiceSchema, choiceBin);
      expect(choiceDec).toEqual(toolChoice);
    });

    it("round-trips ChatToolDefinitionSchema with strict flag", () => {
      const toolDef = {
        name: "calculator",
        description: "Evaluates expressions",
        jsonSchemaString: '{"type":"object"}',
        strict: true,
      };
      const bin = toBinary(ChatToolDefinitionSchema, toolDef);
      const dec = fromBinary(ChatToolDefinitionSchema, bin);
      expect(dec).toEqual(toolDef);
    });

    it("round-trips PromptCacheOptionsSchema", () => {
      const opts = { type: PromptCacheType.EPHEMERAL };
      const bin = toBinary(PromptCacheOptionsSchema, opts);
      const dec = fromBinary(PromptCacheOptionsSchema, bin);
      expect(dec).toEqual(opts);
    });

    it("round-trips ModelUsageStatsSchema with tokens and cache breakdown", () => {
      const usage = {
        inputTokens: 1050n,
        outputTokens: 250n,
        cacheReadTokens: 500n,
        cacheWriteTokens: 100n,
      };
      const bin = toBinary(ModelUsageStatsSchema, usage);
      const dec = fromBinary(ModelUsageStatsSchema, bin);
      expect(dec.inputTokens).toBe(1050n);
      expect(dec.outputTokens).toBe(250n);
      expect(dec.cacheReadTokens).toBe(500n);
      expect(dec.cacheWriteTokens).toBe(100n);
    });

    it("round-trips ModelFeaturesSchema and ModelDimensionSchema", () => {
      const features = {
        supportsContextTokens: true,
        supportsToolCalls: true,
        supportsImages: true,
        supportsThinking: true,
        supportsParallelToolCalls: true,
      };
      const bin = toBinary(ModelFeaturesSchema, features);
      const dec = fromBinary(ModelFeaturesSchema, bin);
      expect(dec.supportsContextTokens).toBe(true);
      expect(dec.supportsToolCalls).toBe(true);
      expect(dec.supportsImages).toBe(true);
      expect(dec.supportsThinking).toBe(true);
      expect(dec.supportsParallelToolCalls).toBe(true);

      const dim = { label: "Quality", value: 4.5, denominator: "5", minRange: 1, maxRange: 5, kind: 1 };
      const dimBin = toBinary(ModelDimensionSchema, dim);
      const dimDec = fromBinary(ModelDimensionSchema, dimBin);
      expect(dimDec.label).toBe("Quality");
      expect(dimDec.value).toBeCloseTo(4.5);
      expect(dimDec.denominator).toBe("5");
      expect(dimDec.kind).toBe(1);
    });
    it("round-trips ModelInfoSchema with repeated fields", () => {
      const modelInfo = {
        modelUid: "swe-2-high",
        modelName: "SWE-2 High",
        modelFeatures: { supportsToolCalls: true, supportsThinking: true },
        maxOutputTokens: 64000,
        harnessUids: ["harness-1", "harness-2"],
      };
      const bin = toBinary(ModelInfoSchema, modelInfo);
      const dec = fromBinary(ModelInfoSchema, bin);
      expect(dec.modelUid).toBe("swe-2-high");
      expect(dec.modelName).toBe("SWE-2 High");
      expect(dec.modelFeatures.supportsToolCalls).toBe(true);
      expect(dec.modelFeatures.supportsThinking).toBe(true);
      expect(dec.maxOutputTokens).toBe(64000);
      expect(dec.harnessUids).toEqual(["harness-1", "harness-2"]);
    });

    it("round-trips ClientModelConfigSchema and GetCliModelConfigsResponseSchema", () => {
      const config = {
        label: "SWE 1.6",
        modelUid: "swe-1-6",
        modelInfo: { modelUid: "swe-1-6", modelName: "SWE-1.6" },
        isPremium: true,
        supportsImages: true,
        isDefaultModelInFamily: true,
      };
      const resp = {
        clientModelConfigs: [config],
      };
      const bin = toBinary(GetCliModelConfigsResponseSchema, resp);
      const dec = fromBinary(GetCliModelConfigsResponseSchema, bin);
      expect(dec.clientModelConfigs).toHaveLength(1);
      expect(dec.clientModelConfigs[0].label).toBe("SWE 1.6");
      expect(dec.clientModelConfigs[0].modelUid).toBe("swe-1-6");
      expect(dec.clientModelConfigs[0].modelInfo.modelUid).toBe("swe-1-6");
      expect(dec.clientModelConfigs[0].isPremium).toBe(true);
      expect(dec.clientModelConfigs[0].supportsImages).toBe(true);
      expect(dec.clientModelConfigs[0].isDefaultModelInFamily).toBe(true);
    });

    it("round-trips ModelFamilyMetadataSchema with effort axis entries", () => {
      const metadata = {
        modelFamilyLabel: "SWE-2",
        isDefaultModelInFamily: true,
        entries: [
          { key: "reasoning effort", value: { order: 2, name: "Medium" } },
          { key: "reasoning effort", value: { order: 3, name: "High" } },
          { key: "1m context", value: { order: 1, name: "1M" } },
        ],
      };
      const bin = toBinary(ModelFamilyMetadataSchema, metadata);
      const dec = fromBinary(ModelFamilyMetadataSchema, bin);
      expect(dec.modelFamilyLabel).toBe("SWE-2");
      expect(dec.isDefaultModelInFamily).toBe(true);
      expect(dec.entries).toHaveLength(3);
      expect(dec.entries[0]).toEqual({ key: "reasoning effort", value: { order: 2, name: "Medium" } });
      expect(dec.entries[1].value).toEqual({ order: 3, name: "High" });
      expect(dec.entries[2].value).toEqual({ order: 1, name: "1M" });
    });

    it("round-trips family metadata nested in ClientModelConfigSchema", () => {
      const config = {
        label: "SWE-2 High",
        modelUid: "swe-2-high",
        modelInfo: { modelType: 2 },
        isDefaultModelInFamily: true,
        modelFamilyMetadata: {
          modelFamilyLabel: "SWE-2",
          entries: [{ key: "effort", value: { order: 3, name: "High" } }],
        },
      };
      const bin = toBinary(GetCliModelConfigsResponseSchema, { clientModelConfigs: [config] });
      const dec = fromBinary(GetCliModelConfigsResponseSchema, bin);
      const meta = dec.clientModelConfigs[0].modelFamilyMetadata;
      expect(meta.modelFamilyLabel).toBe("SWE-2");
      expect(dec.clientModelConfigs[0].isDefaultModelInFamily).toBe(true);
      expect(meta.entries).toEqual([{ key: "effort", value: { order: 3, name: "High" } }]);
    });

    it("decodes negative order int32 through the 64-bit varint path", () => {
      // Hand-crafted wire: negative int32 is a 10-byte sign-extended varint,
      // which a 32-bit varint reader rejects.
      const valueBytes = Buffer.concat([
        Buffer.from([0x08]), // field 1 (order), wire type 0
        encodeVarint(-1),
        Buffer.from([0x12, 0x03]), // field 2 (name), wire type 2
        Buffer.from("Max", "utf8"),
      ]);
      const entryBytes = Buffer.concat([
        Buffer.from([0x0a, 0x06]), // field 1 (key), wire type 2
        Buffer.from("effort", "utf8"),
        Buffer.from([0x12, valueBytes.length]), // field 2 (value), wire type 2
        valueBytes,
      ]);
      const dec = fromBinary(ModelFamilyMetadataEntrySchema, entryBytes);
      expect(dec.key).toBe("effort");
      expect(dec.value.order).toBe(-1);
      expect(dec.value.name).toBe("Max");

      const bin = toBinary(ModelFamilyMetadataValueSchema, { order: -1, name: "Max" });
      expect(fromBinary(ModelFamilyMetadataValueSchema, bin).order).toBe(-1);
    });

    it("decodes metadata without entries and entries without values", () => {
      const bare = fromBinary(
        ModelFamilyMetadataSchema,
        toBinary(ModelFamilyMetadataSchema, { modelFamilyLabel: "SWE-2" })
      );
      expect(bare.modelFamilyLabel).toBe("SWE-2");
      expect(bare.entries).toBeUndefined();

      const bin = toBinary(ModelFamilyMetadataEntrySchema, { key: "effort", value: undefined });
      const dec = fromBinary(ModelFamilyMetadataEntrySchema, bin);
      expect(dec.key).toBe("effort");
      expect(dec.value).toBeUndefined();
    });

    it("ignores unknown fields inside family metadata entries and values", () => {
      const valueBytes = Buffer.concat([
        Buffer.from([0x08, 0x03]), // field 1 (order) = 3
        Buffer.from([0x12, 0x04]), // field 2 (name) "High"
        Buffer.from("High", "utf8"),
        Buffer.from([0x48, 0x2a]), // unknown field 9 varint 42
      ]);
      const entryBytes = Buffer.concat([
        Buffer.from([0x0a, 0x06]), // field 1 (key) "effort"
        Buffer.from("effort", "utf8"),
        Buffer.from([0x12, valueBytes.length]), // field 2 (value)
        valueBytes,
        Buffer.from([0x72, 0x02, 0x01, 0x02]), // unknown field 14 length-delimited
      ]);
      const dec = fromBinary(ModelFamilyMetadataEntrySchema, entryBytes);
      expect(dec).toEqual({ key: "effort", value: { order: 3, name: "High" } });
    });

    it("round-trips DevinPlanInfoSchema, PlanInfoSchema, and UserStatusSchema", () => {
      const userStatus = {
        name: "Alice",
        email: "alice@example.com",
        planStatus: {
          planInfo: {
            planName: "Pro Plan",
            devinInfo: { canUseCascade: true, canUseCli: true, orgId: "org_123" },
          },
        },
      };
      const bin = toBinary(GetUserStatusResponseSchema, { userStatus });
      const dec = fromBinary(GetUserStatusResponseSchema, bin);
      expect(dec.userStatus.name).toBe("Alice");
      expect(dec.userStatus.email).toBe("alice@example.com");
      expect(dec.userStatus.planStatus.planInfo.planName).toBe("Pro Plan");
      expect(dec.userStatus.planStatus.planInfo.devinInfo.canUseCascade).toBe(true);
      expect(dec.userStatus.planStatus.planInfo.devinInfo.canUseCli).toBe(true);
      expect(dec.userStatus.planStatus.planInfo.devinInfo.orgId).toBe("org_123");
    });
  });


  describe("URL sanitization and Connect paths (DEV-01 residuals)", () => {
    it("validates all standard Devin ConnectRPC path constants", () => {
      expect(DEVIN_DEFAULT_BASE_URL).toBe("https://server.codeium.com");
      expect(DEVIN_AUTH_PATH).toBe("/exa.auth_pb.AuthService/GetUserJwt");
      expect(DEVIN_CHAT_PATH).toBe("/exa.api_server_pb.ApiServerService/GetChatMessage");
      expect(DEVIN_ASSIGN_MODEL_PATH).toBe("/exa.api_server_pb.ApiServerService/AssignModel");
      expect(DEVIN_USER_STATUS_PATH).toBe("/exa.seat_management_pb.SeatManagementService/GetUserStatus");
      expect(DEVIN_CLI_MODEL_CONFIGS_PATH).toBe("/exa.api_server_pb.ApiServerService/GetCliModelConfigs");
      expect(DEVIN_DEFAULT_STOP_PATTERNS).toEqual([
        "<|user|>",
        "<|bot|>",
        "<|context_request|>",
        "<|endoftext|>",
        "<|end_of_turn|>",
      ]);
    });

    it("sanitizes customApiServerUrl: preserves path hierarchy while trimming trailing slashes", () => {
      expect(sanitizeCustomApiServerUrl("https://cascade.enterprise.com/api/v1/")).toBe(
        "https://cascade.enterprise.com/api/v1"
      );
      expect(sanitizeCustomApiServerUrl("https://cascade.enterprise.com/api/v1")).toBe(
        "https://cascade.enterprise.com/api/v1"
      );
      expect(sanitizeCustomApiServerUrl("https://cascade.enterprise.com/")).toBe(
        "https://cascade.enterprise.com"
      );
    });

    it("sanitizes customApiServerUrl: normalizes default port 443 away", () => {
      expect(sanitizeCustomApiServerUrl("https://cascade.enterprise.com:443/chat")).toBe(
        "https://cascade.enterprise.com/chat"
      );
      expect(sanitizeCustomApiServerUrl("https://cascade.enterprise.com:443")).toBe(
        "https://cascade.enterprise.com"
      );
    });

    it("sanitizes customApiServerUrl: rejects non-string inputs cleanly", () => {
      expect(sanitizeCustomApiServerUrl(12345)).toBeNull();
      expect(sanitizeCustomApiServerUrl({})).toBeNull();
      expect(sanitizeCustomApiServerUrl([])).toBeNull();
      expect(sanitizeCustomApiServerUrl(undefined)).toBeNull();
    });
  });
});
