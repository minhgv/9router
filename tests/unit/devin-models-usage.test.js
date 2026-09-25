import { describe, it, expect, vi } from "vitest";

import {
  parseDevinModelConfigs,
  parseDevinModelConfigsSplit,
  fetchDevinCliModelConfigs,
  resolveDevinModels,
  buildDevinUnaryHeaders,
} from "../../open-sse/services/devinModels.js";
import { parseDevinUserStatus, getDevinUsage } from "../../open-sse/services/usage/devin.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { invalidateDevinCatalog, getDevinCatalogSnapshot } from "../../open-sse/services/devinCatalog.js";
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

  it("preserves the router flag from displayOption or isModelRouter only", () => {
    const models = parseDevinModelConfigs({
      clientModelConfigs: [
        { label: "Adaptive", modelUid: "adaptive", modelInfo: { modelType: 2, displayOption: 3 } },
        { label: "Flagged", modelUid: "flagged-router", modelInfo: { modelType: 2, isModelRouter: true } },
        { label: "Plain", modelUid: "plain-chat", modelInfo: { modelType: 2 } },
      ],
    });

    expect(models.map((m) => m.id)).toEqual(["adaptive", "flagged-router", "plain-chat"]);
    // displayOption 3 (DisplayOption.MODEL_ROUTER) and isModelRouter are the
    // two wire representations of a router; plain entries carry no flag.
    expect(models.map((m) => m.modelRouter)).toEqual([true, true, undefined]);
  });

  it("preserves parallel tool-call capability from model features", () => {
    const models = parseDevinModelConfigs({
      clientModelConfigs: [
        {
          label: "SWE-2 High",
          modelUid: "swe-2-high",
          modelInfo: { modelType: 2, modelFeatures: { supportsParallelToolCalls: true } },
        },
        {
          label: "Serial",
          modelUid: "serial-lane",
          modelInfo: { modelType: 2, modelFeatures: { supportsParallelToolCalls: false } },
        },
      ],
    });

    expect(models.map((m) => m.supportsParallelToolCalls)).toEqual([true, undefined]);
  });

  it("round-trips router and parallel-call flags through the protobuf wire", async () => {
    const wire = {
      clientModelConfigs: [
        {
          label: "Adaptive",
          creditMultiplier: 1.5,
          isRecommended: true,
          modelUid: "adaptive",
          modelInfo: {
            modelType: 2,
            displayOption: 3,
            isModelRouter: true,
            modelFeatures: { supportsParallelToolCalls: true },
          },
        },
      ],
    };
    const fetchFn = vi.fn().mockResolvedValue(protobufResponse(GetCliModelConfigsResponseSchema, wire));

    const decoded = await fetchDevinCliModelConfigs(SESSION_TOKEN, { fetchFn });

    expect(parseDevinModelConfigs(decoded)[0]).toMatchObject({
      id: "adaptive",
      modelRouter: true,
      supportsParallelToolCalls: true,
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

  it("warms the shared catalog so a snapshot call skips discovery (AC-08)", async () => {
    invalidateDevinCatalog("conn-ac08");
    const connection = { id: "conn-ac08", accessToken: SESSION_TOKEN };
    const wire = {
      clientModelConfigs: [{ label: "Adaptive", modelUid: "adaptive", modelInfo: { modelType: 2 } }],
    };
    const warmFetch = vi.fn().mockResolvedValue(protobufResponse(GetCliModelConfigsResponseSchema, wire));
    const resolved = await resolveDevinModels(connection, { fetchFn: warmFetch });
    expect(resolved.models.map((m) => m.id)).toEqual(["adaptive"]);
    expect(warmFetch).toHaveBeenCalledTimes(1);

    // The catalog is warm for this connection: no upstream discovery fetch.
    const snapshotFetch = vi.fn();
    const snapshot = await getDevinCatalogSnapshot(
      { connectionId: "conn-ac08", accessToken: SESSION_TOKEN },
      { fetchFn: snapshotFetch },
    );
    expect(snapshotFetch).not.toHaveBeenCalled();
    expect(snapshot.members.get("adaptive")).toMatchObject({ id: "adaptive", name: "Adaptive" });
    invalidateDevinCatalog("conn-ac08");
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

describe("devin family collapse", () => {
  const effortEntry = (name, order = 2) => ({ key: "reasoning effort", value: { order, name } });

  function familyMember({
    uid,
    label,
    familyLabel,
    entries,
    configDefault = false,
    metadataDefault = false,
    modelType = 2,
    modelFamilyUid,
    features = {},
    maxTokens,
    maxOutputTokens,
    creditMultiplier,
    isRecommended = false,
  }) {
    return {
      label,
      modelUid: uid,
      ...(configDefault ? { isDefaultModelInFamily: true } : {}),
      ...(creditMultiplier !== undefined ? { creditMultiplier } : {}),
      ...(isRecommended ? { isRecommended: true } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      modelInfo: {
        modelType,
        ...(modelFamilyUid ? { modelFamilyUid } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        modelFeatures: features,
      },
      modelFamilyMetadata: {
        modelFamilyLabel: familyLabel,
        ...(metadataDefault ? { isDefaultModelInFamily: true } : {}),
        entries,
      },
    };
  }

  it("collapses a swe-2 effort family into one logical entry with routing", () => {
    const models = parseDevinModelConfigs({
      clientModelConfigs: [
        familyMember({ uid: "swe-2-medium", label: "SWE-2 Medium", familyLabel: "SWE-2", entries: [effortEntry("Medium", 2)], modelFamilyUid: "swe-2" }),
        familyMember({ uid: "swe-2-high", label: "SWE-2 High", familyLabel: "SWE-2", entries: [effortEntry("High", 3)], configDefault: true, modelFamilyUid: "swe-2" }),
        familyMember({ uid: "swe-2-max", label: "SWE-2 Max", familyLabel: "SWE-2", entries: [effortEntry("Max", 4)], modelFamilyUid: "swe-2" }),
      ],
    });

    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({
      id: "swe-2",
      name: "SWE-2",
      effortRouting: { medium: "swe-2-medium", high: "swe-2-high", max: "swe-2-max" },
      defaultMember: "swe-2-high",
      efforts: ["medium", "high", "max"],
      requiresEffort: true,
      family: "swe-2",
    });
  });

  // Family-descriptor assertions (members ordering, defaultLevel) read the
  // split parse output — the production path `parseDevinModelConfigs` wraps.
  const parseFamilies = (configs) => parseDevinModelConfigsSplit({ clientModelConfigs: configs }).families;

  it("hoists the server-default member and recovers defaultLevel", () => {
    const families = parseFamilies([
      familyMember({ uid: "swe-2-medium", label: "SWE-2 Medium", familyLabel: "SWE-2", entries: [effortEntry("Medium", 2)] }),
      familyMember({ uid: "swe-2-max", label: "SWE-2 Max", familyLabel: "SWE-2", entries: [effortEntry("Max", 4)] }),
      familyMember({ uid: "swe-2-high", label: "SWE-2 High", familyLabel: "SWE-2", entries: [effortEntry("High", 3)], configDefault: true }),
    ]);

    expect(families).toHaveLength(1);
    expect(families[0].id).toBe("swe-2");
    // default member hoisted to the front of the server filing order
    expect(families[0].members).toEqual(["swe-2-high", "swe-2-medium", "swe-2-max"]);
    expect(families[0].defaultMember).toBe("swe-2-high");
    expect(families[0].defaultLevel).toBe("high");
    expect(families[0].requiresEffort).toBe(true);
  });

  it("honors metadata-level isDefaultModelInFamily and survives its absence", () => {
    const withMetadataDefault = parseFamilies([
      familyMember({ uid: "a-med", label: "Lambda Med", familyLabel: "Lambda", entries: [effortEntry("Medium", 2)] }),
      familyMember({ uid: "a-high", label: "Lambda High", familyLabel: "Lambda", entries: [effortEntry("High", 3)], metadataDefault: true }),
    ]);
    expect(withMetadataDefault[0].defaultMember).toBe("a-high");
    expect(withMetadataDefault[0].defaultLevel).toBe("high");

    const withoutDefault = parseFamilies([
      familyMember({ uid: "b-med", label: "Mu Med", familyLabel: "Mu", entries: [effortEntry("Medium", 2)] }),
      familyMember({ uid: "b-high", label: "Mu High", familyLabel: "Mu", entries: [effortEntry("High", 3)] }),
    ]);
    expect(withoutDefault[0].defaultMember).toBeUndefined();
    expect(withoutDefault[0].defaultLevel).toBeUndefined();
    expect(withoutDefault[0].members).toEqual(["b-med", "b-high"]);
  });

  it("keeps the first claim on duplicate effort names", () => {
    const families = parseFamilies([
      familyMember({ uid: "first", label: "Nu High", familyLabel: "Nu", entries: [effortEntry("High", 3)] }),
      familyMember({ uid: "second", label: "Nu High Too", familyLabel: "Nu", entries: [effortEntry("High", 3)] }),
    ]);
    expect(families[0].routing).toEqual({ high: "first" });
    expect(families[0].members).toContain("second");
  });

  it("splits fast mode and 1m context into distinct lanes", () => {
    const models = parseDevinModelConfigs({
      clientModelConfigs: [
        familyMember({ uid: "swe-2", label: "SWE-2", familyLabel: "SWE-2", entries: [effortEntry("High", 3)] }),
        familyMember({ uid: "swe-2-fast", label: "SWE-2", familyLabel: "SWE-2", entries: [effortEntry("High", 3), { key: "fast mode", value: { order: 1, name: "Fast" } }] }),
        familyMember({ uid: "swe-2-1m", label: "SWE-2", familyLabel: "SWE-2", entries: [effortEntry("High", 3), { key: "1m context", value: { order: 1, name: "1M" } }] }),
        // fast mode with a non-1 order stays on the base lane
        familyMember({ uid: "swe-2-slow", label: "SWE-2", familyLabel: "SWE-2", entries: [effortEntry("Max", 4), { key: "fast mode", value: { order: 2, name: "Slow" } }] }),
      ],
    });

    expect(models.map((m) => m.id)).toEqual(["swe-2", "swe-2-fast", "swe-2-1m"]);
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["swe-2"].name).toBe("SWE-2");
    expect(byId["swe-2"].effortRouting).toEqual({ high: "swe-2", max: "swe-2-slow" });
    expect(byId["swe-2-fast"].name).toBe("SWE-2 Fast");
    expect(byId["swe-2-1m"].name).toBe("SWE-2 1M");
  });

  it("routes the shared-label non-thinking twin to off via the thinking axis", () => {
    const models = parseDevinModelConfigs({
      clientModelConfigs: [
        familyMember({
          uid: "claude-high",
          label: "Claude Sonnet 5 High",
          familyLabel: "Claude Sonnet 5",
          entries: [effortEntry("High", 3), { key: "thinking", value: { order: 1, name: "Thinking" } }],
        }),
        familyMember({
          uid: "claude-high-nt",
          label: "Claude Sonnet 5 High",
          familyLabel: "Claude Sonnet 5",
          entries: [effortEntry("High", 3), { key: "thinking", value: { order: 2, name: "No Thinking" } }],
        }),
      ],
    });

    expect(models.map((m) => m.id)).toEqual(["claude-sonnet-5"]);
    expect(models[0].effortRouting).toEqual({ off: "claude-high-nt", high: "claude-high" });
    expect(models[0].efforts).toEqual(["high"]);
    expect(models[0].requiresEffort).toBe(false);
  });

  it("normalizes effort names across punctuation and case", () => {
    const families = parseFamilies([
      familyMember({ uid: "xh-1", label: "Alpha XH", familyLabel: "Alpha", entries: [{ key: "effort", value: { order: 2, name: "X High" } }] }),
      familyMember({ uid: "xh-2", label: "Beta XH", familyLabel: "Beta", entries: [{ key: "effort", value: { order: 2, name: "XHigh" } }] }),
      familyMember({ uid: "xh-3", label: "Gamma XH", familyLabel: "Gamma", entries: [{ key: "effort", value: { order: 2, name: "x-high" } }] }),
      // off spellings: only an off route -> not collapsed, stays standalone
      familyMember({ uid: "off-1", label: "Delta NT", familyLabel: "Delta", entries: [{ key: "effort", value: { order: 2, name: "none" } }] }),
      familyMember({ uid: "off-2", label: "Epsilon NT", familyLabel: "Epsilon", entries: [{ key: "effort", value: { order: 2, name: "No Thinking" } }] }),
    ]);

    const routingById = Object.fromEntries(families.map((f) => [f.id, f.routing]));
    expect(routingById["alpha"]).toEqual({ xhigh: "xh-1" });
    expect(routingById["beta"]).toEqual({ xhigh: "xh-2" });
    expect(routingById["gamma"]).toEqual({ xhigh: "xh-3" });
    expect(routingById["delta"]).toBeUndefined();
    expect(routingById["epsilon"]).toBeUndefined();
  });

  it("keeps members with unknown effort names routeless but filed", () => {
    const configs = [
      familyMember({ uid: "omicron-turbo", label: "Omicron Turbo", familyLabel: "Omicron", entries: [{ key: "effort", value: { order: 2, name: "Turbo" } }] }),
      familyMember({ uid: "omicron-high", label: "Omicron High", familyLabel: "Omicron", entries: [effortEntry("High", 3)] }),
    ];
    const split = parseDevinModelConfigsSplit({ clientModelConfigs: configs });
    expect(split.logical.map((m) => m.id)).toEqual(["omicron"]);

    const [family] = split.families;
    expect(family.routing).toEqual({ high: "omicron-high" });
    expect(family.members).toEqual(expect.arrayContaining(["omicron-turbo", "omicron-high"]));
  });

  it("normalizes effort axis keys across case and punctuation", () => {
    const models = parseDevinModelConfigs({
      clientModelConfigs: [
        familyMember({ uid: "k-1", label: "Pi High", familyLabel: "Pi", entries: [{ key: "Reasoning Effort", value: { order: 2, name: "High" } }] }),
        familyMember({ uid: "k-2", label: "Rho High", familyLabel: "Rho", entries: [{ key: "reasoning-effort!!", value: { order: 2, name: "High" } }] }),
        familyMember({ uid: "k-3", label: "Sigma Max", familyLabel: "Sigma", entries: [{ key: "EFFORT", value: { order: 2, name: "Max" } }] }),
      ],
    });

    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["pi"].effortRouting).toEqual({ high: "k-1" });
    expect(byId["rho"].effortRouting).toEqual({ high: "k-2" });
    expect(byId["sigma"].effortRouting).toEqual({ max: "k-3" });
  });

  it("leaves lanes with only an off route standalone", () => {
    const models = parseDevinModelConfigs({
      clientModelConfigs: [
        familyMember({ uid: "solo-nt", label: "Tau", familyLabel: "Tau", entries: [{ key: "effort", value: { order: 2, name: "none" } }] }),
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["solo-nt"]);
    expect(models[0].effortRouting).toBeUndefined();
  });

  it("normalizes family labels to logical ids and skips empty labels", () => {
    const models = parseDevinModelConfigs({
      clientModelConfigs: [
        familyMember({ uid: "gpt-sol", label: "GPT-5.6 Sol High", familyLabel: "GPT-5.6 Sol", entries: [effortEntry("High", 3)] }),
        familyMember({ uid: "anon", label: "No Family", familyLabel: "   ", entries: [effortEntry("High", 3)] }),
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["gpt-5-6-sol", "anon"]);
  });

  it("inherits the default member's features and caps on the logical entry", () => {
    const models = parseDevinModelConfigs({
      clientModelConfigs: [
        familyMember({
          uid: "phi-low",
          label: "Phi Low",
          familyLabel: "Phi",
          entries: [{ key: "effort", value: { order: 2, name: "Low" } }],
          features: { supportsImages: true },
        }),
        familyMember({
          uid: "phi-high",
          label: "Phi High",
          familyLabel: "Phi",
          entries: [effortEntry("High", 3)],
          configDefault: true,
          modelFamilyUid: "phi-uid",
          features: { supportsThinking: true, supportsParallelToolCalls: true, supportsToolCalls: false },
          maxTokens: 262000,
          maxOutputTokens: 128000,
          creditMultiplier: 9,
          isRecommended: true,
        }),
      ],
    });

    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({
      id: "phi",
      name: "Phi",
      contextLength: 262000,
      maxOutputTokens: 128000,
      creditMultiplier: 9,
      supportsThinking: true,
      supportsParallelToolCalls: true,
      supportsToolCalls: false,
      family: "phi-uid",
      isRecommended: true,
      effortRouting: { low: "phi-low", high: "phi-high" },
      defaultMember: "phi-high",
      efforts: ["low", "high"],
      requiresEffort: true,
    });
  });

  it("filters non-chat members before collapse and leaves routers untouched", () => {
    const models = parseDevinModelConfigs({
      clientModelConfigs: [
        { label: "Adaptive", modelUid: "adaptive", modelInfo: { modelType: 2, displayOption: 3 } },
        familyMember({ uid: "chi-high", label: "Chi High", familyLabel: "Chi", entries: [effortEntry("High", 3)] }),
        familyMember({ uid: "chi-max", label: "Chi Max", familyLabel: "Chi", entries: [effortEntry("Max", 4)] }),
        familyMember({ uid: "chi-embed", label: "Chi Embed", familyLabel: "Chi", entries: [effortEntry("Low", 2)], modelType: 3 }),
      ],
    });

    expect(models.map((m) => m.id)).toEqual(["adaptive", "chi"]);
    expect(models[0].modelRouter).toBe(true);
    expect(models[1].effortRouting).toEqual({ high: "chi-high", max: "chi-max" });
  });

  it("dedupes model uids before filing family lanes", () => {
    const models = parseDevinModelConfigs({
      clientModelConfigs: [
        familyMember({ uid: "psi-high", label: "Psi High", familyLabel: "Psi", entries: [effortEntry("High", 3)] }),
        // duplicate uid is dropped by the seen-set before it could claim "max"
        { label: "Psi High dupe", modelUid: "psi-high", modelInfo: { modelType: 2 }, modelFamilyMetadata: { modelFamilyLabel: "Psi", entries: [effortEntry("Max", 4)] } },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["psi"]);
    expect(models[0].effortRouting).toEqual({ high: "psi-high" });
  });

  it("collapses families from a protobuf-encoded discovery response", async () => {
    const wire = {
      clientModelConfigs: [
        familyMember({ uid: "swe-2-medium", label: "SWE-2 Medium", familyLabel: "SWE-2", entries: [effortEntry("Medium", 2)], modelFamilyUid: "swe-2", features: { supportsToolCalls: true } }),
        familyMember({ uid: "swe-2-high", label: "SWE-2 High", familyLabel: "SWE-2", entries: [effortEntry("High", 3)], configDefault: true, modelFamilyUid: "swe-2", features: { supportsThinking: true } }),
        familyMember({ uid: "swe-2-max", label: "SWE-2 Max", familyLabel: "SWE-2", entries: [effortEntry("Max", 4)], modelFamilyUid: "swe-2", features: { supportsToolCalls: true } }),
      ],
    };
    const fetchFn = vi.fn().mockResolvedValue(protobufResponse(GetCliModelConfigsResponseSchema, wire));

    const decoded = await fetchDevinCliModelConfigs(SESSION_TOKEN, { fetchFn });
    const models = parseDevinModelConfigs(decoded);

    expect(models.map((m) => m.id)).toEqual(["swe-2"]);
    expect(models[0]).toMatchObject({
      name: "SWE-2",
      defaultMember: "swe-2-high",
      requiresEffort: true,
      supportsThinking: true,
      effortRouting: { medium: "swe-2-medium", high: "swe-2-high", max: "swe-2-max" },
    });
  });
});
