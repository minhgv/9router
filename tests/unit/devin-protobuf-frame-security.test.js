/**
 * SEC-06 (Devin Connect framing) + DEV-02 security assertions — Wave 1 Stage 1a (W-C).
 *
 * Locked policy (plan §7.2 SEC-06): "frame cap before allocation/decode; truncate/corrupt
 * rejected". Frame caps: 16 MiB compressed frame, 16 MiB decompressed payload
 * (MAX_CONNECT_FRAME_PAYLOAD / MAX_DECOMPRESSED_PAYLOAD in open-sse/utils/devinProtobuf.js,
 * parse loop ~L516-554).
 *
 * TEST-ONLY wave: observable assertion failures = confirmed defect receipts (Wave 2 Stage D),
 * no production fixes here.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import zlib from "node:zlib";
import {
  buildConnectFrame,
  parseConnectFrames,
  MAX_CONNECT_FRAME_PAYLOAD,
  MAX_DECOMPRESSED_PAYLOAD,
} from "open-sse/utils/devinProtobuf.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function headerOnlyFrame(flags, length) {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(length, 1);
  return header;
}

describe("SEC-06 Connect frame cap boundaries", () => {
  it("accepts an uncompressed frame of exactly MAX_CONNECT_FRAME_PAYLOAD bytes", () => {
    // Boundary: 16 MiB allocation is fine; the cap is inclusive.
    const payload = Buffer.alloc(MAX_CONNECT_FRAME_PAYLOAD, 0x61);
    const frame = buildConnectFrame(payload, false);
    const { frames, remaining } = parseConnectFrames(frame, { isStreamEnd: true });
    expect(remaining.length).toBe(0);
    expect(frames).toHaveLength(1);
    expect(frames[0].isEndStream).toBe(false);
    expect(frames[0].payload.length).toBe(MAX_CONNECT_FRAME_PAYLOAD);
    expect(frames[0].payload[0]).toBe(0x61);
  });

  it("accepts a compressed frame whose decompressed size is exactly MAX_DECOMPRESSED_PAYLOAD", () => {
    const payload = Buffer.alloc(MAX_DECOMPRESSED_PAYLOAD);
    const frame = buildConnectFrame(payload, true); // gzipSync of 16MiB zeros is small
    const { frames, remaining } = parseConnectFrames(frame, { isStreamEnd: true });
    expect(remaining.length).toBe(0);
    expect(frames).toHaveLength(1);
    expect(frames[0].payload.length).toBe(MAX_DECOMPRESSED_PAYLOAD);
  });

  it("rejects an over-cap frame length declared in the header BEFORE decoding any payload", () => {
    // Header-only input: rejection must be observable without the payload materializing.
    const gunzipSpy = vi.spyOn(zlib, "gunzipSync");
    const input = headerOnlyFrame(0x00, MAX_CONNECT_FRAME_PAYLOAD + 1);
    expect(() => parseConnectFrames(input, { isStreamEnd: true })).toThrow(/exceeds .*cap/);
    expect(gunzipSpy).not.toHaveBeenCalled();
  });

  it("buildConnectFrame refuses to emit a frame over the cap", () => {
    expect(() =>
      buildConnectFrame(Buffer.alloc(MAX_CONNECT_FRAME_PAYLOAD + 1), false)
    ).toThrow(/exceeds 16MiB cap/);
  });

  it("rejects a frame whose decompressed payload exceeds the decompressed cap", () => {
    // 17 MiB of zeros compresses to a ~17KB frame (under the compressed cap),
    // but inflates to 1 MiB beyond the decompressed cap.
    const bomb = Buffer.alloc(MAX_DECOMPRESSED_PAYLOAD + 1024 * 1024);
    const frame = buildConnectFrame(bomb, true);
    expect(frame.length).toBeLessThan(MAX_CONNECT_FRAME_PAYLOAD);
    expect(() => parseConnectFrames(frame, { isStreamEnd: true })).toThrow(
      /Decompressed frame payload .* exceeds 16MiB cap/
    );
  });

  it("(locked policy) enforces the decompressed cap BEFORE inflating past it (gzip-bomb bound)", () => {
    // P-DEVIN: "frame cap before allocation/decode". A 16MiB-compliant frame whose
    // zlib stream inflates to 16 GiB (1000:1 amplification) must be cut off at the cap,
    // not fully inflated and inspected afterwards.
    const spy = vi.spyOn(zlib, "gunzipSync");
    const bomb = Buffer.alloc(MAX_DECOMPRESSED_PAYLOAD + 1024 * 1024); // 17MiB zeros
    const frame = buildConnectFrame(bomb, true);
    expect(() => parseConnectFrames(frame, { isStreamEnd: true })).toThrow();

    // Observable bound: no single gunzip output may exceed the decompressed cap.
    const produced = spy.mock.results
      .filter((r) => r.type === "return")
      .map((r) => r.value?.length ?? 0);
    const maxProduced = Math.max(0, ...produced);
    expect(maxProduced).toBeLessThanOrEqual(MAX_DECOMPRESSED_PAYLOAD);
  });
});

describe("SEC-06 truncated / corrupt frame rejection", () => {
  it("rejects a truncated 5-byte header at stream end", () => {
    expect(() => parseConnectFrames(Buffer.from([0x00, 0x00, 0x00]), { isStreamEnd: true })).toThrow(
      /Truncated Connect frame at stream end/
    );
  });

  it("waits (returns empty frames) for a partial header on a live stream", () => {
    const input = Buffer.from([0x00, 0x00, 0x00]);
    const { frames, remaining } = parseConnectFrames(input, { isStreamEnd: false });
    expect(frames).toEqual([]);
    expect(remaining.equals(input)).toBe(true);
  });

  it("rejects a truncated payload at stream end", () => {
    const frame = buildConnectFrame(Buffer.from("x".repeat(64)), false);
    expect(frame.length).toBe(69);
    expect(() => parseConnectFrames(frame.subarray(0, 25), { isStreamEnd: true })).toThrow(
      /Truncated Connect frame at stream end/
    );
  });

  it("waits for the rest of the payload on a live stream", () => {
    const frame = buildConnectFrame(Buffer.from("x".repeat(64)), false);
    const partial = frame.subarray(0, 25);
    const { frames, remaining } = parseConnectFrames(partial, { isStreamEnd: false });
    expect(frames).toEqual([]);
    expect(remaining.equals(partial)).toBe(true);
  });

  it("rejects a corrupt gzip payload with a thrown (non-hang) error", () => {
    const input = Buffer.concat([
      headerOnlyFrame(0x01, 32),
      Buffer.alloc(32, 0x00), // invalid gzip magic
    ]);
    expect(() => parseConnectFrames(input, { isStreamEnd: true })).toThrow();
  });
});

describe("SEC-06 split / coalesced stream framing", () => {
  function twoUncompressedFrames() {
    return [
      buildConnectFrame(Buffer.from("first-payload"), false),
      buildConnectFrame(Buffer.from("second-payload"), false),
    ];
  }

  it("decodes two valid frames delivered byte-by-byte on a live stream", () => {
    const [f1, f2] = twoUncompressedFrames();
    const whole = Buffer.concat([f1, f2]);
    let pending = Buffer.alloc(0);
    const decoded = [];
    for (let i = 0; i < whole.length; i++) {
      pending = Buffer.concat([pending, whole.subarray(i, i + 1)]);
      const { frames, remaining } = parseConnectFrames(pending, { isStreamEnd: false });
      pending = remaining;
      decoded.push(...frames);
    }
    // Frame payloads only surface once fully delivered; nothing is lost in between.
    const final = parseConnectFrames(pending, { isStreamEnd: true });
    decoded.push(...final.frames);
    expect(final.remaining.length).toBe(0);
    expect(decoded).toHaveLength(2);
    expect(decoded.map((f) => f.payload.toString())).toEqual([
      "first-payload",
      "second-payload",
    ]);
  });

  it("decodes two coalesced frames arriving in a single chunk", () => {
    const [f1, f2] = twoUncompressedFrames();
    const { frames, remaining } = parseConnectFrames(Buffer.concat([f1, f2]), {
      isStreamEnd: true,
    });
    expect(remaining.length).toBe(0);
    expect(frames).toHaveLength(2);
    expect(frames[0].payload.toString()).toBe("first-payload");
    expect(frames[1].payload.toString()).toBe("second-payload");
  });

  it("flags an end-stream trailer frame and preserves its JSON payload", () => {
    const trailers = { error: { code: "unavailable", message: "boom" } };
    const payload = Buffer.from(JSON.stringify(trailers));
    const frame = Buffer.alloc(5 + payload.length);
    frame[0] = 0x02;
    frame.writeUInt32BE(payload.length, 1);
    payload.copy(frame, 5);

    const { frames } = parseConnectFrames(frame, { isStreamEnd: true });
    expect(frames).toHaveLength(1);
    expect(frames[0].isEndStream).toBe(true);
    expect(JSON.parse(frames[0].payload.toString())).toEqual(trailers);
  });
});
