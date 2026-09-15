/**
 * Devin (Codeium/Cascade) Protobuf Codec & Wire Utilities
 * Implements ConnectRPC protobuf framing, wire encoding/decoding,
 * and IR schema definitions for Devin API communication.
 */

import zlib from "node:zlib";
import crypto from "node:crypto";

export const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";
export const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";
export const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
export const DEVIN_CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
export const DEVIN_ASSIGN_MODEL_PATH = "/exa.api_server_pb.ApiServerService/AssignModel";
export const DEVIN_USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
export const DEVIN_CLI_MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";

export const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024; // 16 MiB
export const MAX_DECOMPRESSED_PAYLOAD = 16 * 1024 * 1024; // 16 MiB

// ==================== ENUMS ====================

export const ChatMessageSource = {
  UNSPECIFIED: 0,
  USER: 1,
  SYSTEM: 2,
  TOOL: 4,
};

export const ChatMessageRequestType = {
  UNSPECIFIED: 0,
  CASCADE: 3,
  // Chat protocol used by devin-cli (chisel) ≥3000.10: replaces CASCADE for GetChatMessage.
  CHAT: 5,
};

export const ConversationalPlannerMode = {
  UNSPECIFIED: 0,
  DEFAULT: 1,
};

export const PromptCacheType = {
  UNSPECIFIED: 0,
  EPHEMERAL: 1,
};

export const StopReason = {
  UNSPECIFIED: 0,
  INCOMPLETE: 1,
  STOP_PATTERN: 2,
  MAX_TOKENS: 3,
  MIN_LOG_PROB: 4,
  MAX_NEWLINES: 5,
  NONFINITE_LOGIT_OR_PROB: 7,
  FIRST_NON_WHITESPACE_LINE: 8,
  PARTIAL: 9,
  FUNCTION_CALL: 10,
  CONTENT_FILTER: 11,
  NON_INSERTION: 12,
  ERROR: 13,
};

export const DisplayOption = {
  UNSPECIFIED: 0,
  ARENA: 1,
  BATTLE_GROUP_ONLY: 2,
  MODEL_ROUTER: 3,
  QUICK_REVIEW: 4,
};

// Raw display-option wire values accepted in Metadata.supportedModelDisplays
// (MODEL_ROUTER, QUICK_REVIEW, plus internal-default 6, unclassified 7, normal 8).
export const DEVIN_SUPPORTED_MODEL_DISPLAYS = [3, 4, 6, 7, 8];

// ==================== PRIMITIVE CODECS ====================

export function encodeVarint(value) {
  if (typeof value === "bigint" || value > 0xffffffff || value < 0) {
    let v = BigInt.asUintN(64, BigInt(value));
    const bytes = [];
    while (v > 0x7fn) {
      bytes.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    bytes.push(Number(v));
    return Buffer.from(bytes);
  }
  let v = Number(value) >>> 0;
  const bytes = [];
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

export function decodeVarint(buffer, offset = 0) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      const val = result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : result;
      return { value: val, bytesRead: pos - offset, nextOffset: pos };
    }
    shift += 7n;
    if (shift >= 64n) throw new Error("Varint exceeds 64 bits");
  }
  throw new Error("Unexpected end of varint buffer");
}

export function encodeZigZag32(n) {
  return ((n << 1) ^ (n >> 31)) >>> 0;
}

export function decodeZigZag32(n) {
  return (n >>> 1) ^ -(n & 1);
}

export function encodeZigZag64(n) {
  const bn = BigInt(n);
  return (bn << 1n) ^ (bn >> 63n);
}

export function decodeZigZag64(n) {
  const bn = BigInt(n);
  return (bn >> 1n) ^ -(bn & 1n);
}

// ==================== PROTOBUF WRITER & READER ====================

class ProtoWriter {
  constructor() {
    this.chunks = [];
  }

  raw(buf) {
    this.chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  }

  tag(no, wireType) {
    this.uint32((no << 3) | wireType);
  }

  uint32(val) {
    let v = Number(val) >>> 0;
    const bytes = [];
    while (v > 0x7f) {
      bytes.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    bytes.push(v);
    this.raw(Buffer.from(bytes));
  }

  int32(val) {
    if (val >= 0) {
      this.uint32(val);
    } else {
      this.int64(BigInt(val));
    }
  }

  uint64(val) {
    let v = BigInt.asUintN(64, BigInt(val));
    const bytes = [];
    while (v > 0x7fn) {
      bytes.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    bytes.push(Number(v));
    this.raw(Buffer.from(bytes));
  }

  int64(val) {
    this.uint64(val);
  }

  bool(val) {
    this.raw(Buffer.from([val ? 1 : 0]));
  }

  float(val) {
    const buf = Buffer.alloc(4);
    buf.writeFloatLE(Number(val), 0);
    this.raw(buf);
  }

  double(val) {
    const buf = Buffer.alloc(8);
    buf.writeDoubleLE(Number(val), 0);
    this.raw(buf);
  }

  string(val) {
    const buf = Buffer.from(String(val), "utf8");
    this.uint32(buf.length);
    this.raw(buf);
  }

  bytes(val) {
    const b = Buffer.isBuffer(val) ? val : Buffer.from(val);
    this.uint32(b.length);
    this.raw(b);
  }

  finish() {
    return Buffer.concat(this.chunks);
  }
}

class ProtoReader {
  constructor(buf) {
    this.buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    this.pos = 0;
    this.len = this.buf.length;
  }

  uint32() {
    let result = 0;
    let shift = 0;
    while (this.pos < this.len) {
      const byte = this.buf[this.pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift >= 32) throw new Error("Varint exceeds 32 bits");
    }
    throw new Error("Unexpected end of protobuf varint");
  }

  int32() {
    // proto3 encodes negative int32 as a 10-byte sign-extended varint — decode
    // through uint64 then truncate, instead of failing the 32-bit varint check.
    return Number(BigInt.asIntN(32, this.uint64()));
  }

  uint64() {
    let result = 0n;
    let shift = 0n;
    while (this.pos < this.len) {
      const byte = this.buf[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return BigInt.asUintN(64, result);
      shift += 7n;
      if (shift >= 64n) throw new Error("Varint exceeds 64 bits");
    }
    throw new Error("Unexpected end of protobuf 64-bit varint");
  }

  int64() {
    return BigInt.asIntN(64, this.uint64());
  }

  bool() {
    return this.uint32() !== 0;
  }

  float() {
    if (this.pos + 4 > this.len) throw new Error("Unexpected EOF reading float");
    const val = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return val;
  }

  double() {
    if (this.pos + 8 > this.len) throw new Error("Unexpected EOF reading double");
    const val = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return val;
  }

  string() {
    const len = this.uint32();
    if (this.pos + len > this.len) throw new Error("Unexpected EOF reading string");
    const str = this.buf.toString("utf8", this.pos, this.pos + len);
    this.pos += len;
    return str;
  }

  bytes() {
    const len = this.uint32();
    if (this.pos + len > this.len) throw new Error("Unexpected EOF reading bytes");
    const b = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return b;
  }

  skip(wireType) {
    if (wireType === 0) {
      this.uint64();
    } else if (wireType === 1) {
      if (this.pos + 8 > this.len) throw new Error("Unexpected EOF skipping 64-bit");
      this.pos += 8;
    } else if (wireType === 2) {
      const len = this.uint32();
      if (this.pos + len > this.len) throw new Error("Unexpected EOF skipping length-delimited");
      this.pos += len;
    } else if (wireType === 5) {
      if (this.pos + 4 > this.len) throw new Error("Unexpected EOF skipping 32-bit");
      this.pos += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
  }
}

// ==================== SCHEMA RUNTIME ====================

export function toBinary(schema, message) {
  if (!message || typeof message !== "object") return Buffer.alloc(0);
  const writer = new ProtoWriter();

  for (const field of schema.fields) {
    let val = message[field.name];
    if (val === undefined || val === null) continue;

    if (field.repeat) {
      if (!Array.isArray(val) || val.length === 0) continue;
      for (const item of val) {
        if (item === undefined || item === null) continue;
        writeFieldValue(writer, field, item);
      }
    } else {
      // Default scalar suppression in proto3
      if (field.kind === "string" && val === "") continue;
      if (field.kind === "bool" && val === false) continue;
      if ((field.kind === "int32" || field.kind === "enum" || field.kind === "uint32") && Number(val) === 0) continue;
      if ((field.kind === "int64" || field.kind === "uint64") && BigInt(val) === 0n) continue;
      if ((field.kind === "float" || field.kind === "double") && Number(val) === 0) continue;
      if (field.kind === "bytes" && val.length === 0) continue;

      writeFieldValue(writer, field, val);
    }
  }

  return writer.finish();
}

function writeFieldValue(writer, field, value) {
  switch (field.kind) {
    case "string":
      writer.tag(field.no, 2);
      writer.string(value);
      break;
    case "bool":
      writer.tag(field.no, 0);
      writer.bool(value);
      break;
    case "int32":
    case "enum":
      writer.tag(field.no, 0);
      writer.int32(value);
      break;
    case "uint32":
      writer.tag(field.no, 0);
      writer.uint32(value);
      break;
    case "int64":
      writer.tag(field.no, 0);
      writer.int64(value);
      break;
    case "uint64":
      writer.tag(field.no, 0);
      writer.uint64(value);
      break;
    case "float":
      writer.tag(field.no, 5);
      writer.float(value);
      break;
    case "double":
      writer.tag(field.no, 1);
      writer.double(value);
      break;
    case "bytes":
      writer.tag(field.no, 2);
      writer.bytes(value);
      break;
    case "message": {
      const childSchema = field.T();
      const childBytes = toBinary(childSchema, value);
      writer.tag(field.no, 2);
      writer.bytes(childBytes);
      break;
    }
    default:
      throw new Error(`Unknown field kind ${field.kind} for field ${field.name}`);
  }
}

export function fromBinary(schema, buffer) {
  const reader = new ProtoReader(buffer);
  const fieldMap = new Map();
  for (const field of schema.fields) {
    fieldMap.set(field.no, field);
  }

  const result = {};

  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;

    const field = fieldMap.get(fieldNo);
    if (!field) {
      reader.skip(wireType);
      continue;
    }

    // Check packed repeated scalars
    if (field.repeat && wireType === 2 && field.kind !== "message" && field.kind !== "string" && field.kind !== "bytes") {
      const packLen = reader.uint32();
      const end = reader.pos + packLen;
      if (!result[field.name]) result[field.name] = [];
      while (reader.pos < end) {
        result[field.name].push(readScalarValue(reader, field.kind));
      }
      continue;
    }

    const val = readFieldValue(reader, field, wireType);
    if (field.repeat) {
      if (!result[field.name]) result[field.name] = [];
      result[field.name].push(val);
    } else {
      result[field.name] = val;
    }
  }

  return result;
}

function readFieldValue(reader, field, wireType) {
  switch (field.kind) {
    case "string":
      return reader.string();
    case "bool":
      return reader.bool();
    case "int32":
    case "enum":
      return reader.int32();
    case "uint32":
      return reader.uint32();
    case "int64":
      return reader.int64();
    case "uint64":
      return reader.uint64();
    case "float":
      return reader.float();
    case "double":
      return reader.double();
    case "bytes":
      return reader.bytes();
    case "message": {
      const childBytes = reader.bytes();
      const childSchema = field.T();
      return fromBinary(childSchema, childBytes);
    }
    default:
      reader.skip(wireType);
      return null;
  }
}

function readScalarValue(reader, kind) {
  switch (kind) {
    case "bool":
      return reader.bool();
    case "int32":
    case "enum":
      return reader.int32();
    case "uint32":
      return reader.uint32();
    case "int64":
      return reader.int64();
    case "uint64":
      return reader.uint64();
    case "float":
      return reader.float();
    case "double":
      return reader.double();
    default:
      throw new Error(`Unsupported packed scalar kind ${kind}`);
  }
}

// ==================== CONNECT FRAME UTILS ====================

/**
 * Builds a 5-byte framed Connect message.
 * @param {Buffer|Uint8Array} payload
 * @param {boolean} compress - whether to gzip compress (flag 0x01)
 * @returns {Buffer}
 */
export function buildConnectFrame(payload, compress = true) {
  let flags = 0x00;
  let finalPayload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (compress) {
    flags = 0x01;
    finalPayload = zlib.gzipSync(finalPayload);
  }
  if (finalPayload.length > MAX_CONNECT_FRAME_PAYLOAD) {
    throw new Error(`Connect frame payload ${finalPayload.length} exceeds 16MiB cap`);
  }
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(finalPayload.length, 1);
  return Buffer.concat([header, finalPayload]);
}

/**
 * Incremental Connect frame parser.
 * @param {Buffer|Uint8Array} buffer
 * @param {{ isStreamEnd?: boolean }} options
 * @returns {{ frames: Array<{ flags: number, isEndStream: boolean, isCompressed: boolean, payload: Buffer, rawPayload: Buffer }>, remaining: Buffer }}
 */
export function parseConnectFrames(buffer, { isStreamEnd = false } = {}) {
  let pending = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const frames = [];

  while (pending.length >= 5) {
    const flags = pending[0];
    const len = pending.readUInt32BE(1);

    if (len > MAX_CONNECT_FRAME_PAYLOAD) {
      throw new Error(`Connect frame length ${len} exceeds ${MAX_CONNECT_FRAME_PAYLOAD}-byte cap`);
    }

    if (pending.length < 5 + len) {
      break; // Frame incomplete, wait for more chunks
    }

    const rawPayload = pending.subarray(5, 5 + len);
    pending = pending.subarray(5 + len);

    let decompressed;
    if (flags & 0x01) {
      decompressed = zlib.gunzipSync(rawPayload);
      if (decompressed.length > MAX_DECOMPRESSED_PAYLOAD) {
        throw new Error(`Decompressed frame payload ${decompressed.length} exceeds 16MiB cap`);
      }
    } else {
      decompressed = rawPayload;
    }

    frames.push({
      flags,
      isEndStream: !!(flags & 0x02),
      isCompressed: !!(flags & 0x01),
      payload: decompressed,
      rawPayload,
    });
  }

  if (isStreamEnd && pending.length > 0) {
    throw new Error(`Truncated Connect frame at stream end: ${pending.length} pending bytes`);
  }

  return {
    frames,
    remaining: pending,
  };
}

/**
 * Decode unary Connect response: try bare protobuf, fallback gunzip.
 * @param {object} schema
 * @param {Buffer|Uint8Array} payload
 * @returns {object|null}
 */
export function decodeDevinUnaryMessage(schema, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (buf.length === 0) return null;

  try {
    return fromBinary(schema, buf);
  } catch (directErr) {
    try {
      const unzipped = zlib.gunzipSync(buf);
      return fromBinary(schema, unzipped);
    } catch {
      throw directErr;
    }
  }
}

// ==================== IDENTITY & TOKEN UTILS ====================

export function getDevinOs() {
  return process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
}

export function normalizeDevinSessionToken(token) {
  if (!token || typeof token !== "string") return "";
  const trimmed = token.trim();
  if (!trimmed) return "";
  return trimmed.startsWith(DEVIN_SESSION_TOKEN_PREFIX) ? trimmed : `${DEVIN_SESSION_TOKEN_PREFIX}${trimmed}`;
}

export function devinCliMetadata(apiKey, userJwt = "") {
  const ideVersion = process.env.DEVIN_IDE_VERSION || "3000.10.23";
  return {
    ideName: "devin-cli",
    ideType: "chisel",
    ideVersion,
    extensionName: "chisel",
    extensionVersion: ideVersion,
    locale: "en",
    os: getDevinOs(),
    apiKey: normalizeDevinSessionToken(apiKey),
    ...(userJwt ? { userJwt } : {}),
  };
}

export function devinDiscoveryMetadata(apiKey, supportedModelDisplays = DEVIN_SUPPORTED_MODEL_DISPLAYS) {
  return {
    ideName: "chisel",
    ideVersion: "0.0.0-dev",
    extensionName: "chisel",
    extensionVersion: "0.0.0-dev",
    locale: "en",
    os: getDevinOs(),
    apiKey: normalizeDevinSessionToken(apiKey),
    supportedModelDisplays,
  };
}

/**
 * Validates and sanitizes customApiServerUrl returned by GetUserJwtResponse.
 * Override chat base URL ONLY if https, no userinfo, host not IP/localhost — else ignore.
 */
export function sanitizeCustomApiServerUrl(url) {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return null;
    if (hostname === "127.0.0.1" || hostname === "::1") return null;
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) return null;
    if (hostname.includes(":") || hostname.startsWith("[") || hostname.endsWith("]")) return null;
    return `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

export function deterministicUuid(seed) {
  const hex = crypto.createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ==================== SCHEMA DEFINITIONS ====================

export const TimestampSchema = {
  typeName: "google.protobuf.Timestamp",
  fields: [
    { no: 1, name: "seconds", kind: "int64" },
    { no: 2, name: "nanos", kind: "int32" },
  ],
};

export const MetadataSchema = {
  typeName: "exa.codeium_common_pb.Metadata",
  fields: [
    { no: 1, name: "ideName", kind: "string" },
    { no: 7, name: "ideVersion", kind: "string" },
    { no: 28, name: "ideType", kind: "string" },
    { no: 12, name: "extensionName", kind: "string" },
    { no: 2, name: "extensionVersion", kind: "string" },
    { no: 3, name: "apiKey", kind: "string" },
    { no: 4, name: "locale", kind: "string" },
    { no: 5, name: "os", kind: "string" },
    { no: 8, name: "hardware", kind: "string" },
    { no: 6, name: "disableTelemetry", kind: "bool" },
    { no: 10, name: "sessionId", kind: "string" },
    { no: 16, name: "lsTimestamp", kind: "message", T: () => TimestampSchema },
    { no: 9, name: "requestId", kind: "uint64" },
    { no: 11, name: "sourceAddress", kind: "string" },
    { no: 13, name: "userAgent", kind: "string" },
    { no: 14, name: "url", kind: "string" },
    { no: 15, name: "authSource", kind: "enum" },
    { no: 17, name: "extensionPath", kind: "string" },
    { no: 20, name: "userId", kind: "string" },
    { no: 21, name: "userJwt", kind: "string" },
    { no: 22, name: "forceTeamId", kind: "string" },
    { no: 24, name: "deviceFingerprint", kind: "string" },
    { no: 25, name: "triggerId", kind: "string" },
    { no: 26, name: "planName", kind: "string" },
    { no: 27, name: "id", kind: "string" },
    { no: 29, name: "impersonateTier", kind: "string" },
    { no: 30, name: "supportedModelDisplays", kind: "enum", repeat: true },
    { no: 31, name: "f", kind: "string" },
    { no: 32, name: "teamId", kind: "string" },
  ],
};

export const ImageDataSchema = {
  typeName: "exa.codeium_common_pb.ImageData",
  fields: [
    { no: 1, name: "base64Data", kind: "string" },
    { no: 2, name: "mimeType", kind: "string" },
    { no: 3, name: "caption", kind: "string" },
  ],
};

export const ChatToolCallSchema = {
  typeName: "exa.codeium_common_pb.ChatToolCall",
  fields: [
    { no: 1, name: "id", kind: "string" },
    { no: 2, name: "name", kind: "string" },
    { no: 3, name: "argumentsJson", kind: "string" },
    { no: 4, name: "invalidJsonStr", kind: "string" },
    { no: 5, name: "invalidJsonErr", kind: "string" },
    { no: 6, name: "isCustomToolCall", kind: "bool" },
  ],
};

export const ChatToolChoiceSchema = {
  typeName: "exa.chat_pb.ChatToolChoice",
  // omp declares a `choice` oneof (optionName=1 / toolName=2); flat fields are wire-identical.
  fields: [
    { no: 1, name: "optionName", kind: "string" },
    { no: 2, name: "toolName", kind: "string" },
  ],
};

export const ChatToolDefinitionSchema = {
  typeName: "exa.chat_pb.ChatToolDefinition",
  // row 8 computerUseConfig (ComputerUseToolConfigSchema) omitted — skipped as unknown on the wire.
  fields: [
    { no: 1, name: "name", kind: "string" },
    { no: 2, name: "description", kind: "string" },
    { no: 3, name: "jsonSchemaString", kind: "string" },
    { no: 5, name: "attributionFieldNames", kind: "string", repeat: true },
    { no: 6, name: "serverName", kind: "string" },
    { no: 7, name: "readOnlyHint", kind: "bool", optional: true },
    { no: 9, name: "isCustomTool", kind: "bool", optional: true },
    { no: 10, name: "customToolGrammar", kind: "string", optional: true },
    { no: 11, name: "customToolGrammarSyntax", kind: "string", optional: true },
    { no: 12, name: "strict", kind: "bool" },
  ],
};

export const PromptCacheOptionsSchema = {
  typeName: "exa.chat_pb.PromptCacheOptions",
  fields: [
    { no: 1, name: "type", kind: "enum" },
  ],
};

export const ChatMessagePromptSchema = {
  typeName: "exa.chat_pb.ChatMessagePrompt",
  // row 14 promptAnnotationRanges (PromptAnnotationRangeSchema) omitted — skipped as unknown on the wire.
  fields: [
    { no: 1, name: "messageId", kind: "string" },
    { no: 2, name: "source", kind: "enum" },
    { no: 3, name: "prompt", kind: "string" },
    { no: 4, name: "numTokens", kind: "uint32" },
    { no: 5, name: "safeForCodeTelemetry", kind: "bool" },
    { no: 6, name: "toolCalls", kind: "message", T: () => ChatToolCallSchema, repeat: true },
    { no: 7, name: "toolCallId", kind: "string" },
    { no: 8, name: "promptCacheOptions", kind: "message", T: () => PromptCacheOptionsSchema },
    { no: 9, name: "toolResultIsError", kind: "bool" },
    { no: 10, name: "images", kind: "message", T: () => ImageDataSchema, repeat: true },
    { no: 11, name: "thinking", kind: "string" },
    { no: 12, name: "signature", kind: "string" },
    { no: 13, name: "thinkingRedacted", kind: "bool" },
    { no: 15, name: "outputId", kind: "string" },
    { no: 16, name: "thinkingId", kind: "string" },
    { no: 17, name: "geminiThoughtSignature", kind: "bytes" },
    { no: 18, name: "signatureType", kind: "string" },
    { no: 19, name: "phase", kind: "string" },
  ],
};

export const CompletionConfigurationSchema = {
  typeName: "exa.codeium_common_pb.CompletionConfiguration",
  fields: [
    { no: 1, name: "numCompletions", kind: "uint64" },
    { no: 2, name: "maxTokens", kind: "uint64" },
    { no: 3, name: "maxNewlines", kind: "uint64" },
    { no: 4, name: "minLogProbability", kind: "double" },
    { no: 5, name: "temperature", kind: "double" },
    { no: 6, name: "firstTemperature", kind: "double" },
    { no: 7, name: "topK", kind: "uint64" },
    { no: 8, name: "topP", kind: "double" },
    { no: 9, name: "stopPatterns", kind: "string", repeat: true },
    { no: 10, name: "seed", kind: "uint64" },
    { no: 11, name: "fimEotProbThreshold", kind: "double" },
    { no: 12, name: "useFimEotThreshold", kind: "bool" },
    { no: 13, name: "doNotScoreStopTokens", kind: "bool" },
    { no: 14, name: "sqrtLenNormalizedLogProbScore", kind: "bool" },
    { no: 15, name: "lastMessageIsPartial", kind: "bool" },
    { no: 16, name: "returnLogprob", kind: "bool" },
    { no: 17, name: "serviceTier", kind: "string" },
  ],
};

export const ModelUsageStatsSchema = {
  typeName: "exa.codeium_common_pb.ModelUsageStats",
  // row 8 responseHeader (map<string,string>) omitted — skipped as unknown on the wire.
  fields: [
    { no: 1, name: "modelDeprecated", kind: "enum" },
    { no: 9, name: "modelUid", kind: "string" },
    { no: 10, name: "billingModelUid", kind: "string" },
    { no: 11, name: "requestedModelUid", kind: "string" },
    { no: 2, name: "inputTokens", kind: "uint64" },
    { no: 3, name: "outputTokens", kind: "uint64" },
    { no: 4, name: "cacheWriteTokens", kind: "uint64" },
    { no: 5, name: "cacheReadTokens", kind: "uint64" },
    { no: 6, name: "apiProvider", kind: "enum" },
    { no: 7, name: "messageId", kind: "string" },
  ],
};

export const GetChatMessageRequestSchema = {
  typeName: "exa.api_server_pb.GetChatMessageRequest",
  // rows 9 experimentConfig / 15 trajectoryReference omitted (unmirrored deps) — skipped as unknown.
  fields: [
    { no: 1, name: "metadata", kind: "message", T: () => MetadataSchema },
    { no: 2, name: "prompt", kind: "string" },
    { no: 3, name: "chatMessagePrompts", kind: "message", T: () => ChatMessagePromptSchema, repeat: true },
    { no: 5, name: "useInternalChatModel", kind: "bool" },
    { no: 6, name: "internalChatModel", kind: "enum" },
    { no: 21, name: "chatModelUid", kind: "string" },
    { no: 7, name: "requestType", kind: "enum" },
    { no: 8, name: "configuration", kind: "message", T: () => CompletionConfigurationSchema },
    { no: 10, name: "tools", kind: "message", T: () => ChatToolDefinitionSchema, repeat: true },
    { no: 11, name: "disableParallelToolCalls", kind: "bool" },
    { no: 12, name: "toolChoice", kind: "message", T: () => ChatToolChoiceSchema },
    { no: 13, name: "systemPromptCacheOptions", kind: "message", T: () => PromptCacheOptionsSchema },
    { no: 14, name: "chatModelName", kind: "string" },
    { no: 16, name: "cascadeId", kind: "string" },
    { no: 17, name: "promptId", kind: "string" },
    { no: 18, name: "providerSource", kind: "enum" },
    { no: 19, name: "language", kind: "enum" },
    { no: 20, name: "plannerMode", kind: "enum" },
    { no: 22, name: "executionId", kind: "string" },
    { no: 24, name: "arenaConvergeCount", kind: "int32", optional: true },
    { no: 25, name: "arenaAssignmentJwt", kind: "string", optional: true },
    { no: 26, name: "modelAssignmentJwt", kind: "string", optional: true },
  ],
};

export const GetChatMessageResponseSchema = {
  typeName: "exa.api_server_pb.GetChatMessageResponse",
  // rows 13 completionProfile / 28 responseDimensionGroups omitted (unmirrored deps) — skipped as unknown.
  fields: [
    { no: 1, name: "messageId", kind: "string" },
    { no: 2, name: "timestamp", kind: "message", T: () => TimestampSchema },
    { no: 3, name: "deltaText", kind: "string" },
    { no: 4, name: "deltaTokens", kind: "uint32" },
    { no: 5, name: "stopReason", kind: "enum" },
    { no: 6, name: "deltaToolCalls", kind: "message", T: () => ChatToolCallSchema, repeat: true },
    { no: 7, name: "usage", kind: "message", T: () => ModelUsageStatsSchema },
    { no: 14, name: "creditCost", kind: "int32" },
    { no: 8, name: "redact", kind: "bool" },
    { no: 9, name: "deltaThinking", kind: "string" },
    { no: 10, name: "deltaSignature", kind: "string" },
    { no: 11, name: "thinkingRedacted", kind: "bool" },
    { no: 12, name: "latency", kind: "double" },
    { no: 15, name: "outputId", kind: "string" },
    { no: 16, name: "thinkingId", kind: "string" },
    { no: 17, name: "requestId", kind: "string" },
    { no: 18, name: "committedCreditCost", kind: "int32" },
    { no: 19, name: "prompt", kind: "string" },
    { no: 20, name: "geminiThoughtSignature", kind: "bytes" },
    { no: 21, name: "deltaSignatureType", kind: "string" },
    { no: 22, name: "committedAcuCost", kind: "double" },
    { no: 23, name: "actualModelUid", kind: "string", optional: true },
    { no: 24, name: "arenaInvocationCapReached", kind: "bool" },
    { no: 25, name: "phase", kind: "string" },
    { no: 26, name: "committedQuotaCostBasisPoints", kind: "int64", optional: true },
    { no: 27, name: "committedOverageCostCents", kind: "int64", optional: true },
  ],
};

export const GetUserJwtRequestSchema = {
  typeName: "exa.auth_pb.GetUserJwtRequest",
  fields: [
    { no: 1, name: "metadata", kind: "message", T: () => MetadataSchema },
  ],
};

export const GetUserJwtResponseSchema = {
  typeName: "exa.auth_pb.GetUserJwtResponse",
  fields: [
    { no: 1, name: "userJwt", kind: "string" },
    { no: 2, name: "customApiServerUrl", kind: "string" },
  ],
};

export const ModelAssignmentSchema = {
  typeName: "exa.api_server_pb.ModelAssignment",
  fields: [
    { no: 1, name: "assignmentJwt", kind: "string" },
    { no: 2, name: "modelUid", kind: "string" },
    { no: 3, name: "harnessUids", kind: "string", repeat: true },
  ],
};

export const AssignModelRequestSchema = {
  typeName: "exa.api_server_pb.AssignModelRequest",
  fields: [
    { no: 1, name: "metadata", kind: "message", T: () => MetadataSchema },
    { no: 2, name: "modelRouterUid", kind: "string" },
    { no: 3, name: "cascadeId", kind: "string" },
  ],
};

export const AssignModelResponseSchema = {
  typeName: "exa.api_server_pb.AssignModelResponse",
  fields: [
    { no: 1, name: "assignment", kind: "message", T: () => ModelAssignmentSchema },
  ],
};

export const ModelFeaturesSchema = {
  typeName: "exa.codeium_common_pb.ModelFeatures",
  fields: [
    { no: 2, name: "supportsContextTokens", kind: "bool" },
    { no: 3, name: "requiresInstructTags", kind: "bool" },
    { no: 4, name: "requiresFimContext", kind: "bool" },
    { no: 5, name: "requiresContextSnippetPrefix", kind: "bool" },
    { no: 6, name: "requiresContextRelevanceTags", kind: "bool" },
    { no: 7, name: "requiresLlama3Tokens", kind: "bool" },
    { no: 8, name: "zeroShotCapable", kind: "bool" },
    { no: 9, name: "requiresAutocompleteAsCommand", kind: "bool" },
    { no: 10, name: "supportsCursorAwareSupercomplete", kind: "bool" },
    { no: 11, name: "supportsImages", kind: "bool" },
    { no: 20, name: "supportsImageCaptions", kind: "bool" },
    { no: 12, name: "supportsToolCalls", kind: "bool" },
    { no: 21, name: "supportsParallelToolCalls", kind: "bool" },
    { no: 13, name: "supportsCumulativeContext", kind: "bool" },
    { no: 14, name: "tabJumpPrintLineRange", kind: "bool" },
    { no: 15, name: "supportsThinking", kind: "bool" },
    { no: 24, name: "interleaveThinking", kind: "bool" },
    { no: 25, name: "preserveThinking", kind: "bool" },
    { no: 17, name: "supportsEstimateTokenCounter", kind: "bool" },
    { no: 18, name: "addCursorToFindReplaceTarget", kind: "bool" },
    { no: 19, name: "supportsTabJumpUseWholeDocument", kind: "bool" },
    { no: 22, name: "requiresSupercompleteClean", kind: "bool" },
    { no: 23, name: "tabRouteToModal", kind: "bool" },
    { no: 26, name: "supportsRejectionContext", kind: "bool" },
  ],
};

export const ModelInfoSchema = {
  typeName: "exa.codeium_common_pb.ModelInfo",
  // rows 21 arenaConfig / 24 inferenceConfig omitted (unmirrored deps) — skipped as unknown.
  fields: [
    { no: 1, name: "modelId", kind: "enum" },
    { no: 17, name: "modelUid", kind: "string" },
    { no: 2, name: "isInternal", kind: "bool" },
    { no: 3, name: "modelType", kind: "enum" },
    { no: 4, name: "maxTokens", kind: "int32" },
    { no: 5, name: "tokenizerType", kind: "string" },
    { no: 6, name: "modelFeatures", kind: "message", T: () => ModelFeaturesSchema },
    { no: 7, name: "apiProvider", kind: "enum" },
    { no: 8, name: "modelName", kind: "string" },
    { no: 9, name: "supportsContext", kind: "bool" },
    { no: 10, name: "embedDim", kind: "int32" },
    { no: 11, name: "baseUrl", kind: "string" },
    { no: 12, name: "chatModelName", kind: "string" },
    { no: 13, name: "maxOutputTokens", kind: "int32" },
    { no: 14, name: "promptTemplaterType", kind: "enum" },
    { no: 15, name: "toolFormatterType", kind: "enum" },
    { no: 18, name: "inferenceServerUrl", kind: "string" },
    { no: 20, name: "harnessUids", kind: "string", repeat: true },
    { no: 22, name: "displayOption", kind: "enum" },
    { no: 23, name: "modelFamilyUid", kind: "string" },
    { no: 25, name: "isModelRouter", kind: "bool" },
  ],
};

export const ModelFamilyMetadataSchema = {
  typeName: "exa.codeium_common_pb.ModelFamilyMetadata",
  // row 2 entries (ModelFamilyMetadataEntrySchema) omitted — skipped as unknown on the wire.
  fields: [
    { no: 1, name: "modelFamilyLabel", kind: "string" },
    { no: 3, name: "isDefaultModelInFamily", kind: "bool" },
  ],
};

export const ModelDimensionSchema = {
  typeName: "exa.codeium_common_pb.ModelDimension",
  fields: [
    { no: 1, name: "label", kind: "string" },
    { no: 2, name: "value", kind: "float" },
    { no: 3, name: "denominator", kind: "string" },
    { no: 4, name: "minRange", kind: "float" },
    { no: 5, name: "maxRange", kind: "float" },
    { no: 6, name: "kind", kind: "enum" },
    { no: 7, name: "info", kind: "string", optional: true },
  ],
};

export const ClientModelConfigSchema = {
  typeName: "exa.codeium_common_pb.ClientModelConfig",
  // rows 2 modelOrAlias / 19 promoStatus / 21 fastStatus / 33 disabledReason omitted (unmirrored
  // deps) — skipped as unknown on the wire.
  fields: [
    { no: 1, name: "label", kind: "string" },
    { no: 22, name: "modelUid", kind: "string" },
    { no: 3, name: "creditMultiplier", kind: "float" },
    { no: 13, name: "pricingType", kind: "enum" },
    { no: 4, name: "disabled", kind: "bool" },
    { no: 5, name: "supportsImages", kind: "bool" },
    { no: 6, name: "supportsLegacy", kind: "bool" },
    { no: 7, name: "isPremium", kind: "bool" },
    { no: 8, name: "betaWarningMessage", kind: "string" },
    { no: 9, name: "isBeta", kind: "bool" },
    { no: 10, name: "provider", kind: "enum" },
    { no: 11, name: "isRecommended", kind: "bool" },
    { no: 12, name: "allowedTiers", kind: "enum", repeat: true },
    { no: 14, name: "apiProvider", kind: "enum" },
    { no: 15, name: "isNew", kind: "bool" },
    { no: 16, name: "partialRollout", kind: "bool" },
    { no: 17, name: "rolloutFraction", kind: "float" },
    { no: 18, name: "maxTokens", kind: "int32" },
    { no: 20, name: "isCapacityLimited", kind: "bool" },
    { no: 23, name: "modelInfo", kind: "message", T: () => ModelInfoSchema },
    { no: 24, name: "modelCostTier", kind: "enum" },
    { no: 27, name: "description", kind: "string", optional: true },
    { no: 29, name: "smartFriendModelUid", kind: "string", optional: true },
    { no: 30, name: "modelFamilyMetadata", kind: "message", T: () => ModelFamilyMetadataSchema },
    { no: 31, name: "isDefaultModelInFamily", kind: "bool" },
    { no: 32, name: "modelDimensions", kind: "message", T: () => ModelDimensionSchema, repeat: true },
  ],
};

export const GetCliModelConfigsRequestSchema = {
  typeName: "exa.api_server_pb.GetCliModelConfigsRequest",
  fields: [
    { no: 1, name: "metadata", kind: "message", T: () => MetadataSchema },
  ],
};

export const GetCliModelConfigsResponseSchema = {
  typeName: "exa.api_server_pb.GetCliModelConfigsResponse",
  fields: [
    { no: 1, name: "clientModelConfigs", kind: "message", T: () => ClientModelConfigSchema, repeat: true },
  ],
};

export const DevinPlanInfoSchema = {
  typeName: "exa.codeium_common_pb.DevinPlanInfo",
  fields: [
    { no: 1, name: "canUseCascade", kind: "bool" },
    { no: 2, name: "canUseCli", kind: "bool" },
    { no: 3, name: "isAdmin", kind: "bool" },
    { no: 4, name: "orgId", kind: "string" },
    { no: 5, name: "webappHost", kind: "string" },
    { no: 6, name: "devinReviewEnabled", kind: "bool", optional: true },
    { no: 7, name: "apiUrl", kind: "string" },
    { no: 8, name: "accountDisplayName", kind: "string" },
  ],
};

export const PlanInfoSchema = {
  typeName: "exa.codeium_common_pb.PlanInfo",
  // rows 21 cascadeAllowedModelsConfig / 24 defaultTeamConfig / 30 defaultTeamFeatures (map)
  // omitted (unmirrored deps or unsupported map kind) — skipped as unknown on the wire.
  fields: [
    { no: 1, name: "teamsTier", kind: "enum" },
    { no: 2, name: "planName", kind: "string" },
    { no: 3, name: "hasAutocompleteFastMode", kind: "bool" },
    { no: 4, name: "allowStickyPremiumModels", kind: "bool" },
    { no: 5, name: "hasForgeAccess", kind: "bool" },
    { no: 11, name: "disableCodeSnippetTelemetry", kind: "bool" },
    { no: 15, name: "allowPremiumCommandModels", kind: "bool" },
    { no: 23, name: "hasTabToJump", kind: "bool" },
    { no: 6, name: "maxNumPremiumChatMessages", kind: "int64" },
    { no: 7, name: "maxNumChatInputTokens", kind: "int64" },
    { no: 8, name: "maxCustomChatInstructionCharacters", kind: "int64" },
    { no: 9, name: "maxNumPinnedContextItems", kind: "int64" },
    { no: 10, name: "maxLocalIndexSize", kind: "int64" },
    { no: 26, name: "maxUnclaimedSites", kind: "int32" },
    { no: 12, name: "monthlyPromptCredits", kind: "int32" },
    { no: 13, name: "monthlyFlowCredits", kind: "int32" },
    { no: 14, name: "monthlyFlexCreditPurchaseAmount", kind: "int32" },
    { no: 17, name: "isTeams", kind: "bool" },
    { no: 16, name: "isEnterprise", kind: "bool" },
    { no: 32, name: "hasPaidFeatures", kind: "bool" },
    { no: 18, name: "canBuyMoreCredits", kind: "bool" },
    { no: 19, name: "cascadeWebSearchEnabled", kind: "bool" },
    { no: 20, name: "canCustomizeAppIcon", kind: "bool" },
    { no: 22, name: "cascadeCanAutoRunCommands", kind: "bool" },
    { no: 25, name: "canGenerateCommitMessages", kind: "bool" },
    { no: 27, name: "knowledgeBaseEnabled", kind: "bool" },
    { no: 28, name: "canShareConversations", kind: "bool" },
    { no: 29, name: "canAllowCascadeInBackground", kind: "bool" },
    { no: 31, name: "browserEnabled", kind: "bool" },
    { no: 33, name: "devinInfo", kind: "message", T: () => DevinPlanInfoSchema },
    { no: 34, name: "isDevin", kind: "bool" },
    { no: 35, name: "billingStrategy", kind: "enum" },
    { no: 36, name: "hideDailyQuota", kind: "bool" },
    { no: 37, name: "hideWeeklyQuota", kind: "bool" },
  ],
};

export const PlanStatusSchema = {
  typeName: "exa.codeium_common_pb.PlanStatus",
  // row 10 topUpStatus (TopUpStatusSchema) omitted — skipped as unknown on the wire.
  fields: [
    { no: 1, name: "planInfo", kind: "message", T: () => PlanInfoSchema },
    { no: 2, name: "planStart", kind: "message", T: () => TimestampSchema },
    { no: 3, name: "planEnd", kind: "message", T: () => TimestampSchema },
    { no: 8, name: "availablePromptCredits", kind: "int32" },
    { no: 9, name: "availableFlowCredits", kind: "int32" },
    { no: 4, name: "availableFlexCredits", kind: "int32" },
    { no: 7, name: "usedFlexCredits", kind: "int32" },
    { no: 5, name: "usedFlowCredits", kind: "int32" },
    { no: 6, name: "usedPromptCredits", kind: "int32" },
    { no: 11, name: "wasReducedByOrphanedUsage", kind: "bool" },
    { no: 12, name: "gracePeriodStatus", kind: "enum" },
    { no: 13, name: "gracePeriodEnd", kind: "message", T: () => TimestampSchema },
    { no: 14, name: "dailyQuotaRemainingPercent", kind: "int32" },
    { no: 15, name: "weeklyQuotaRemainingPercent", kind: "int32" },
    { no: 16, name: "overageBalanceMicros", kind: "int64" },
    { no: 17, name: "dailyQuotaResetAtUnix", kind: "int64" },
    { no: 18, name: "weeklyQuotaResetAtUnix", kind: "int64" },
  ],
};

export const UserStatusSchema = {
  typeName: "exa.codeium_common_pb.UserStatus",
  // rows 32 teamConfig / 33 cascadeModelConfigData omitted (unmirrored deps) — skipped as unknown.
  fields: [
    { no: 1, name: "pro", kind: "bool" },
    { no: 2, name: "disableTelemetry", kind: "bool" },
    { no: 3, name: "name", kind: "string" },
    { no: 4, name: "ignoreChatTelemetrySetting", kind: "bool" },
    { no: 5, name: "teamId", kind: "string" },
    { no: 6, name: "teamStatus", kind: "enum" },
    { no: 7, name: "email", kind: "string" },
    { no: 9, name: "userFeatures", kind: "enum", repeat: true },
    { no: 8, name: "teamsFeatures", kind: "enum", repeat: true },
    { no: 10, name: "teamsTier", kind: "enum" },
    { no: 11, name: "permissions", kind: "enum", repeat: true },
    { no: 13, name: "planStatus", kind: "message", T: () => PlanStatusSchema },
    { no: 31, name: "hasUsedWindsurf", kind: "bool" },
    { no: 28, name: "userUsedPromptCredits", kind: "int64" },
    { no: 29, name: "userUsedFlowCredits", kind: "int64" },
    { no: 30, name: "hasFingerprintSet", kind: "bool" },
    { no: 34, name: "windsurfProTrialEndTime", kind: "message", T: () => TimestampSchema },
    { no: 35, name: "maxNumPremiumChatMessages", kind: "int64" },
    { no: 36, name: "userId", kind: "string" },
  ],
};

export const GetUserStatusRequestSchema = {
  typeName: "exa.seat_management_pb.GetUserStatusRequest",
  fields: [
    { no: 1, name: "metadata", kind: "message", T: () => MetadataSchema },
  ],
};

export const GetUserStatusResponseSchema = {
  typeName: "exa.seat_management_pb.GetUserStatusResponse",
  fields: [
    { no: 1, name: "userStatus", kind: "message", T: () => UserStatusSchema },
    { no: 2, name: "planInfo", kind: "message", T: () => PlanInfoSchema },
  ],
};
