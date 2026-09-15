import { describe, it, expect, vi } from "vitest";

import {
  parseDevinModelConfigs,
  fetchDevinCliModelConfigs,
  resolveDevinModels,
  buildDevinUnaryHeaders,
} from "../../open-sse/services/devinModels.js";
import { parseDevinUserStatus, getDevinUsage } from "../../open-sse/services/usage/devin.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  toBinary,
  GetCliModelConfigsResponseSchema,
  GetUserStatusResponseSchema,
} from "../../open-sse/utils/devinProtobuf.js";

const SESSION_TOKEN = "devin-session-token$eyJfake.jwt.sig";

function protobufResponse(schema, message) {
  const buf = toBinary(schema, message);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

describe("devinModels service", () => {
  it("builds Connect unary headers with the wire-captured Basic auth shape", () => {
    const headers = buildDevinUnaryHeaders(SESSION_TOKEN);
    expect(headers["content-type"]).toBe("application/proto");
    expect(headers["connect-protocol-version"]).toBe("1");
    expect(headers.authorization).toBe(`Basic ${SESSION_TOKEN}-${SESSION_TOKEN}`);
  });

  it("parses chat-model configs and drops non-chat / duplicate entries", () => {
    const response = {
      clientModelConfigs: [
        {
          label: "SWE-2 High",
          creditMultiplier: 9,
          maxTokens: 262000,
          isRecommended: true,
          modelUid: "swe-2-high",
          modelInfo: {
            modelType: 2,
            maxOutputTokens: 128000,
            modelFamilyUid: "swe-2",
            modelFeatures: { supportsImages: true, supportsThinking: true, supportsToolCalls: true },
          },
        },
        { label: "Autocomplete", modelUid: "autocomplete-x", modelInfo: { modelType: 3 } },
        { label: "SWE-2 High dupe", modelUid: "swe-2-high", modelInfo: { modelType: 2 } },
        { label: "No uid", modelInfo: { modelType: 2 } },
      ],
    };

    const models = parseDevinModelConfigs(response);
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({
      id: "swe-2-high",
      name: "SWE-2 High",
      contextLength: 262000,
      maxOutputTokens: 128000,
      creditMultiplier: 9,
      supportsImages: true,
      supportsThinking: true,
      family: "swe-2",
      isRecommended: true,
    });
  });

  it("round-trips a protobuf-encoded GetCliModelConfigs response through fetch", async () => {
    const wire = {
      clientModelConfigs: [
        {
          label: "Adaptive",
          creditMultiplier: 1.5,
          isRecommended: true,
          modelUid: "adaptive",
          modelInfo: { modelType: 2 },
        },
      ],
    };
    const fetchFn = vi.fn().mockResolvedValue(
      protobufResponse(GetCliModelConfigsResponseSchema, wire)
    );

    const decoded = await fetchDevinCliModelConfigs(SESSION_TOKEN, { fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCliModelConfigs");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe(`Basic ${SESSION_TOKEN}-${SESSION_TOKEN}`);
    expect(init.headers["content-type"]).toBe("application/proto");
    // Request body must itself be valid protobuf (metadata with the session token).
    expect(Buffer.isBuffer(init.body)).toBe(true);
    expect(init.body.length).toBeGreaterThan(40);

    expect(decoded.clientModelConfigs).toHaveLength(1);
    expect(parseDevinModelConfigs(decoded)[0]).toMatchObject({ id: "adaptive", name: "Adaptive" });
  });

  it("rejects when upstream answers non-OK", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "unauthenticated",
    });
    await expect(fetchDevinCliModelConfigs(SESSION_TOKEN, { fetchFn })).rejects.toThrow(/401/);
  });

  it("resolver rejects connections without a token", async () => {
    expect(await resolveDevinModels({})).toMatchObject({ status: 401 });
    expect(await resolveDevinModels({ accessToken: " " })).toMatchObject({ status: 401 });
    expect(await resolveDevinModels({ apiKey: null })).toMatchObject({ status: 401 });
  });
});

describe("devin usage handler", () => {
  const wireUserStatus = {
    userStatus: {
      pro: true,
      planStatus: {
        planInfo: { planName: "Pro", monthlyPromptCredits: -1 },
        availablePromptCredits: -1,
        dailyQuotaRemainingPercent: 40,
        dailyQuotaResetAtUnix: "1789459200",
        weeklyQuotaRemainingPercent: 75,
        weeklyQuotaResetAtUnix: "1789891200",
        planEnd: { seconds: "1791681043" },
      },
    },
  };

  it("maps GetUserStatus to percent quotas, unlimited credits and plan expiry", () => {
    const parsed = parseDevinUserStatus(wireUserStatus);
    expect(parsed.plan).toBe("Pro");
    expect(parsed.quotas["Daily quota"]).toEqual({
      used: 60,
      total: 100,
      remainingPercentage: 40,
      resetAt: "2026-09-15T08:00:00.000Z",
      unlimited: false,
    });
    expect(parsed.quotas["Weekly quota"].remainingPercentage).toBe(75);
    expect(parsed.quotas["Prompt credits"].unlimited).toBe(true);
    expect(parsed.expiresAt).toBe("2026-10-11T01:10:43.000Z");
  });

  it("maps metered credits when the plan has a monthly allowance", () => {
    const parsed = parseDevinUserStatus({
      userStatus: {
        planStatus: {
          planInfo: { planName: "Standard", monthlyPromptCredits: 100 },
          availablePromptCredits: 30,
        },
      },
    });
    expect(parsed.plan).toBe("Standard");
    expect(parsed.quotas["Prompt credits"]).toEqual({
      used: 70,
      total: 100,
      remainingPercentage: 30,
      resetAt: null,
      unlimited: false,
    });
  });

  it("decodes a protobuf GetUserStatus response from the wire", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(protobufResponse(GetUserStatusResponseSchema, wireUserStatus));
    const parsed = await getDevinUsage(SESSION_TOKEN, null, null, fetchFn);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe(`Basic ${SESSION_TOKEN}-${SESSION_TOKEN}`);
    expect(parsed.plan).toBe("Pro");
    expect(parsed.quotas["Daily quota"].remainingPercentage).toBe(40);
    expect(parsed.quotas["Prompt credits"].unlimited).toBe(true);
  });

  it("requires a session token", async () => {
    const out = await getDevinUsage("");
    expect(out.message).toMatch(/session token/i);
  });

  it("is registered in USAGE_HANDLERS via getUsageForProvider", async () => {
    // Empty token short-circuits inside the handler without touching network.
    const out = await getUsageForProvider({ provider: "devin", accessToken: "", apiKey: "" });
    expect(out.message).toMatch(/session token/i);
  });
});
