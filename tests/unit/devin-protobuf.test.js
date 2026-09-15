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
  GetChatMessageRequestSchema,
  GetChatMessageResponseSchema,
  GetUserJwtRequestSchema,
  GetUserJwtResponseSchema,
  MetadataSchema,
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
          ideVersion: "3000.6.2",
          ideType: "chisel",
          extensionName: "chisel",
          extensionVersion: "3000.6.2",
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
      expect(decoded.plannerMode).toBe(ConversationalPlannerMode.DEFAULT);
      expect(decoded.cascadeId).toBe("cascade-id-16-check");
      expect(decoded.executionId).toBe("execution-id-22-check");
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
      expect(metaDefault.ideVersion).toBe("3000.6.2");
      expect(metaDefault.extensionName).toBe("chisel");
      expect(metaDefault.extensionVersion).toBe("3000.6.2");
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
      // Valid HTTPS URLs
      expect(sanitizeCustomApiServerUrl("https://server.codeium.com")).toBe("https://server.codeium.com");
      expect(sanitizeCustomApiServerUrl("https://devin-cluster.internal.net:8443/api/")).toBe("https://devin-cluster.internal.net:8443/api");

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
});
