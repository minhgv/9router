import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import {
  buildDevinCatalogSnapshot,
  getDevinCatalogEpoch,
  getDevinCatalogSnapshot,
  invalidateDevinCatalog,
  warmDevinCatalog,
} from "../../open-sse/services/devinCatalog.js";
import { resolveDevinModels } from "../../open-sse/services/devinModels.js";
import { getProviderModels } from "../../open-sse/config/providerModels.js";
import {
  DEVIN_DEFAULT_BASE_URL,
  GetCliModelConfigsResponseSchema,
  toBinary,
} from "../../open-sse/utils/devinProtobuf.js";

const SESSION_TOKEN = "devin-session-token$eyJfake.jwt.sig";
const TTL_MS = 10 * 60 * 1000;

function protobufResponse(schema, message) {
  const buf = toBinary(schema, message);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

/** A fetch mock whose upstream response the test controls explicitly. */
function deferredFetch() {
  let resolveFn;
  let rejectFn;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  const fetchFn = vi.fn(() => promise);
  fetchFn.resolveWith = (message) => resolveFn(protobufResponse(GetCliModelConfigsResponseSchema, message));
  fetchFn.rejectWith = (error) => rejectFn(error);
  return fetchFn;
}

function wireOf(configs) {
  return protobufResponse(GetCliModelConfigsResponseSchema, { clientModelConfigs: configs });
}

function chatConfig(uid, label = uid, extraModelInfo = {}) {
  return { label, modelUid: uid, modelInfo: { modelType: 2, ...extraModelInfo } };
}

const effortEntry = (name, order = 2) => ({ key: "reasoning effort", value: { order, name } });

function familyMember({ uid, label, familyLabel, effortName, effortOrder = 2, configDefault = false }) {
  return {
    label,
    modelUid: uid,
    ...(configDefault ? { isDefaultModelInFamily: true } : {}),
    modelInfo: { modelType: 2 },
    modelFamilyMetadata: {
      modelFamilyLabel: familyLabel,
      entries: [effortEntry(effortName, effortOrder)],
    },
  };
}

const credsFor = (connectionId, overrides = {}) => ({ connectionId, accessToken: SESSION_TOKEN, ...overrides });

// Let a kicked background refresh (publish/cleanup) run to completion.
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("devin catalog service", () => {
  it("cold fetch builds an executor-usable snapshot over the static floor (matrix 1)", async () => {
    invalidateDevinCatalog("c-cold");
    const fetchFn = vi.fn().mockResolvedValue(wireOf([
      chatConfig("m-1", "Model One", { maxOutputTokens: 64000 }),
      familyMember({ uid: "nova-med", label: "Nova Med", familyLabel: "Nova", effortName: "Medium", effortOrder: 2 }),
      familyMember({ uid: "nova-high", label: "Nova High", familyLabel: "Nova", effortName: "High", effortOrder: 3, configDefault: true }),
    ]));

    const snapshot = await getDevinCatalogSnapshot(credsFor("c-cold"), { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(snapshot).not.toBeNull();

    // Discovered family (absent from the static registry) is routable...
    const nova = snapshot.families.get("nova");
    expect(nova).toMatchObject({
      id: "nova",
      members: ["nova-high", "nova-med"],
      defaultMember: "nova-high",
      requiresEffort: true,
    });
    expect(nova.routing).toEqual({ medium: "nova-med", high: "nova-high" });
    // ...alongside every raw member, family members included.
    expect(snapshot.members.get("m-1")).toMatchObject({ id: "m-1", name: "Model One", maxOutputTokens: 64000 });
    expect(snapshot.members.get("nova-med")).toMatchObject({ id: "nova-med" });
    // Static registry remains the floor under the discovery overlay.
    expect(snapshot.families.get("swe-2")).toMatchObject({ defaultMember: "swe-2-high", routing: { high: "swe-2-high" } });
    expect(snapshot.members.get("swe-2-high")).toMatchObject({ id: "swe-2-high" });
    expect(typeof snapshot.fetchedAt).toBe("number");
    expect(typeof snapshot.generation).toBe("number");

    // Fresh call is a pure cache hit and returns the SAME pinned snapshot.
    const again = await getDevinCatalogSnapshot(credsFor("c-cold"), { fetchFn });
    expect(again).toBe(snapshot);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    invalidateDevinCatalog("c-cold");
  });

  it("cold fetch failure with no prior snapshot returns null and does not cache (matrix 2)", async () => {
    invalidateDevinCatalog("c-fail");
    const fetchFn = vi.fn().mockRejectedValue(new Error("GetCliModelConfigs failed (503)"));
    await expect(getDevinCatalogSnapshot(credsFor("c-fail"), { fetchFn })).resolves.toBeNull();
    // Nothing was negatively cached — the next call retries upstream.
    await expect(getDevinCatalogSnapshot(credsFor("c-fail"), { fetchFn })).resolves.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    invalidateDevinCatalog("c-fail");
  });

  it("a failed revalidation keeps the last-known-good snapshot (matrix 3)", async () => {
    invalidateDevinCatalog("c-lkg");
    const good = await getDevinCatalogSnapshot(credsFor("c-lkg"), {
      fetchFn: vi.fn().mockResolvedValue(wireOf([chatConfig("good-1")])),
    });
    expect(good.members.get("good-1")).toBeTruthy();

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + TTL_MS + 60 * 1000); // past TTL → stale
      const badFetch = deferredFetch();
      const stale = await getDevinCatalogSnapshot(credsFor("c-lkg"), { fetchFn: badFetch });
      expect(stale).toBe(good); // stale-while-revalidate: last-known-good served
      expect(badFetch).toHaveBeenCalledTimes(1); // background refresh kicked
      badFetch.rejectWith(new Error("GetCliModelConfigs failed (500)"));
      await flushMicrotasks();

      const stillGood = await getDevinCatalogSnapshot(credsFor("c-lkg"), { fetchFn: badFetch });
      expect(stillGood).toBe(good); // failure kept the snapshot
      expect(badFetch).toHaveBeenCalledTimes(2); // and the next stale call retries
    } finally {
      vi.useRealTimers();
    }
    invalidateDevinCatalog("c-lkg");
  });

  it("dedupes concurrent cold calls into ONE upstream fetch (matrix 4 / AC-03)", async () => {
    invalidateDevinCatalog("c-dedupe");
    const fetchFn = deferredFetch();
    const p1 = getDevinCatalogSnapshot(credsFor("c-dedupe"), { fetchFn });
    const p2 = getDevinCatalogSnapshot(credsFor("c-dedupe"), { fetchFn });
    const p3 = getDevinCatalogSnapshot(credsFor("c-dedupe"), { fetchFn });
    fetchFn.resolveWith({ clientModelConfigs: [chatConfig("shared-1")] });
    const [s1, s2, s3] = await Promise.all([p1, p2, p3]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(s1).toBe(s2);
    expect(s2).toBe(s3);
    expect(s1.members.get("shared-1")).toMatchObject({ id: "shared-1" });
    invalidateDevinCatalog("c-dedupe");
  });

  it("serves fresh snapshots without I/O, then stale-while-revalidate past the TTL (matrix 5 / AC-04)", async () => {
    invalidateDevinCatalog("c-ttl");
    const first = deferredFetch();
    const pending = getDevinCatalogSnapshot(credsFor("c-ttl"), { fetchFn: first });
    first.resolveWith({ clientModelConfigs: [chatConfig("gen1")] });
    const gen1 = await pending;

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 5 * 60 * 1000); // 5 min old — still fresh
      const freshFetch = vi.fn();
      await expect(getDevinCatalogSnapshot(credsFor("c-ttl"), { fetchFn: freshFetch })).resolves.toBe(gen1);
      expect(freshFetch).not.toHaveBeenCalled();

      vi.setSystemTime(Date.now() + 6 * 60 * 1000); // 11 min old — stale
      const refresh = deferredFetch();
      const stale = await getDevinCatalogSnapshot(credsFor("c-ttl"), { fetchFn: refresh });
      expect(stale).toBe(gen1); // stale served immediately, non-blocking
      expect(refresh).toHaveBeenCalledTimes(1); // background revalidate kicked
      refresh.resolveWith({ clientModelConfigs: [chatConfig("gen2")] });
      await flushMicrotasks();

      const gen2 = await getDevinCatalogSnapshot(credsFor("c-ttl"), { fetchFn: refresh });
      expect(gen2).not.toBe(gen1); // atomic snapshot replace
      expect(gen2.members.get("gen2")).toBeTruthy();
      expect(gen2.members.has("gen1")).toBe(false);
      expect(gen2.generation).toBeGreaterThan(gen1.generation);
      expect(refresh).toHaveBeenCalledTimes(1); // gen2 is fresh — no extra fetch
    } finally {
      vi.useRealTimers();
    }
    invalidateDevinCatalog("c-ttl");
  });

  it("rejects an out-of-order refresh that lands after a newer publish (matrix 6 / AC-04)", async () => {
    invalidateDevinCatalog("c-gen");
    const first = deferredFetch();
    const pending = getDevinCatalogSnapshot(credsFor("c-gen"), { fetchFn: first });
    first.resolveWith({ clientModelConfigs: [chatConfig("gen1")] });
    await pending;

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + TTL_MS + 60 * 1000); // stale
      const staleRefresh = deferredFetch();
      await getDevinCatalogSnapshot(credsFor("c-gen"), { fetchFn: staleRefresh }); // kicks refresh at gen1
      expect(staleRefresh).toHaveBeenCalledTimes(1);

      // A dashboard discovery (resolveDevinModels) publishes a NEWER snapshot first.
      const resolved = await resolveDevinModels(
        { id: "c-gen", accessToken: SESSION_TOKEN },
        { fetchFn: vi.fn().mockResolvedValue(wireOf([chatConfig("warm-wins")])) },
      );
      expect(resolved.models.map((m) => m.id)).toEqual(["warm-wins"]);

      // The older background refresh finishes late — it must NOT overwrite.
      staleRefresh.resolveWith({ clientModelConfigs: [chatConfig("stale-should-lose")] });
      await flushMicrotasks();

      const current = await getDevinCatalogSnapshot(credsFor("c-gen"), { fetchFn: staleRefresh });
      expect(current.members.get("warm-wins")).toBeTruthy();
      expect(current.members.has("stale-should-lose")).toBe(false);
      expect(staleRefresh).toHaveBeenCalledTimes(1); // warm snapshot kept it fresh
    } finally {
      vi.useRealTimers();
    }
    invalidateDevinCatalog("c-gen");
  });

  it("isolates snapshots per connectionId even with an identical token (matrix 7)", async () => {
    invalidateDevinCatalog("iso-a");
    invalidateDevinCatalog("iso-b");
    const token = "devin-session-token$same.jwt.value";
    const fetchA = vi.fn().mockResolvedValue(wireOf([chatConfig("from-a")]));
    const fetchB = vi.fn().mockResolvedValue(wireOf([chatConfig("from-b")]));
    const [sa, sb] = await Promise.all([
      getDevinCatalogSnapshot({ connectionId: "iso-a", accessToken: token }, { fetchFn: fetchA }),
      getDevinCatalogSnapshot({ connectionId: "iso-b", accessToken: token }, { fetchFn: fetchB }),
    ]);
    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(1);
    expect(sa.members.has("from-a")).toBe(true);
    expect(sa.members.has("from-b")).toBe(false);
    expect(sb.members.has("from-b")).toBe(true);
    expect(sb.members.has("from-a")).toBe(false);
    invalidateDevinCatalog("iso-a");
    invalidateDevinCatalog("iso-b");
  });

  it("without a connectionId the scope is sha256(token)[0:16]|baseUrl (matrix 7/8)", async () => {
    const token = "devin-session-token$scope.jwt.check";
    const otherBase = "https://devin.example.dev";
    invalidateDevinCatalog(`${createHash("sha256").update(token).digest("hex").slice(0, 16)}|${DEVIN_DEFAULT_BASE_URL}`);
    invalidateDevinCatalog(`${createHash("sha256").update(token).digest("hex").slice(0, 16)}|${otherBase}`);

    const fetchDefault = vi.fn().mockResolvedValue(wireOf([chatConfig("default-base")]));
    const fetchAlt = vi.fn().mockResolvedValue(wireOf([chatConfig("alt-base")]));
    const [s1, s2] = await Promise.all([
      getDevinCatalogSnapshot({ accessToken: token }, { fetchFn: fetchDefault }),
      getDevinCatalogSnapshot({ accessToken: token, providerSpecificData: { apiBaseUrl: otherBase } }, { fetchFn: fetchAlt }),
    ]);
    // Different baseUrl → different scope → two upstream fetches.
    expect(fetchDefault).toHaveBeenCalledTimes(1);
    expect(fetchAlt).toHaveBeenCalledTimes(1);
    expect(s1.members.get("default-base")).toBeTruthy();
    expect(s2.members.get("alt-base")).toBeTruthy();

    // Same token + baseUrl → same scoped snapshot, no refetch.
    const s1again = await getDevinCatalogSnapshot({ accessToken: token }, { fetchFn: fetchDefault });
    expect(s1again).toBe(s1);
    expect(fetchDefault).toHaveBeenCalledTimes(1);
    invalidateDevinCatalog(`${createHash("sha256").update(token).digest("hex").slice(0, 16)}|${DEVIN_DEFAULT_BASE_URL}`);
    invalidateDevinCatalog(`${createHash("sha256").update(token).digest("hex").slice(0, 16)}|${otherBase}`);
  });

  it("never keys or evicts by the plaintext token (matrix 8)", async () => {
    const token = "devin-session-token$keyformat.jwt.probe";
    const documentedKey = `${createHash("sha256").update(token).digest("hex").slice(0, 16)}|${DEVIN_DEFAULT_BASE_URL}`;
    invalidateDevinCatalog(documentedKey);

    const first = vi.fn().mockResolvedValue(wireOf([chatConfig("keyed")]));
    const snap = await getDevinCatalogSnapshot({ accessToken: token }, { fetchFn: first });
    expect(snap.members.get("keyed")).toBeTruthy();

    // While cached, an eviction attempt with the PLAINTEXT token is a no-op.
    invalidateDevinCatalog(token);
    const probe = vi.fn();
    await expect(getDevinCatalogSnapshot({ accessToken: token }, { fetchFn: probe })).resolves.toBe(snap);
    expect(probe).not.toHaveBeenCalled();

    // Evicting by the documented hash|baseUrl format drops the entry → refetch.
    invalidateDevinCatalog(documentedKey);
    const second = vi.fn().mockResolvedValue(wireOf([chatConfig("keyed")]));
    const refetched = await getDevinCatalogSnapshot({ accessToken: token }, { fetchFn: second });
    expect(second).toHaveBeenCalledTimes(1);
    expect(refetched).not.toBe(snap);
    invalidateDevinCatalog(documentedKey);
  });

  it("invalidateDevinCatalog forces the next call to refetch (matrix 9 / AC-12)", async () => {
    invalidateDevinCatalog("c-inv");
    const first = vi.fn().mockResolvedValue(wireOf([chatConfig("v1")]));
    const v1 = await getDevinCatalogSnapshot(credsFor("c-inv"), { fetchFn: first });
    expect(first).toHaveBeenCalledTimes(1);
    const cachedProbe = vi.fn();
    await expect(getDevinCatalogSnapshot(credsFor("c-inv"), { fetchFn: cachedProbe })).resolves.toBe(v1);
    expect(cachedProbe).not.toHaveBeenCalled();

    invalidateDevinCatalog("c-inv");
    const second = vi.fn().mockResolvedValue(wireOf([chatConfig("v2")]));
    const v2 = await getDevinCatalogSnapshot(credsFor("c-inv"), { fetchFn: second });
    expect(second).toHaveBeenCalledTimes(1);
    expect(v2).not.toBe(v1);
    expect(v2.members.get("v2")).toBeTruthy();
    invalidateDevinCatalog("c-inv");
  });

  it("a cold discovery started before invalidateDevinCatalog cannot republish after it", async () => {
    invalidateDevinCatalog("c-epoch-cold");
    const fetchFn = deferredFetch();
    // Cold discovery in flight when the credential rotates → cache dropped.
    const pending = getDevinCatalogSnapshot(credsFor("c-epoch-cold"), { fetchFn });
    invalidateDevinCatalog("c-epoch-cold");

    fetchFn.resolveWith({ clientModelConfigs: [chatConfig("pre-rotation")] });
    // Fenced publish → the orphaned discovery resolves null (no snapshot won).
    await expect(pending).resolves.toBeNull();

    // Nothing re-poisoned the cache: the next call refetches fresh.
    const next = vi.fn().mockResolvedValue(wireOf([chatConfig("post-rotation")]));
    const fresh = await getDevinCatalogSnapshot(credsFor("c-epoch-cold"), { fetchFn: next });
    expect(next).toHaveBeenCalledTimes(1);
    expect(fresh.members.has("pre-rotation")).toBe(false);
    expect(fresh.members.get("post-rotation")).toBeTruthy();
    invalidateDevinCatalog("c-epoch-cold");
  });

  it("a warm publish carrying a pre-invalidation epoch is rejected (stale acquisition fenced)", async () => {
    const conn = credsFor("c-epoch-warm");
    // Acquisition-freshness capture, as an async caller takes it BEFORE its fetch.
    const e0 = getDevinCatalogEpoch(conn);
    invalidateDevinCatalog("c-epoch-warm"); // credential rotation mid-acquisition

    // The orphaned acquisition lands late: warm asserts the STALE epoch → fenced.
    warmDevinCatalog(conn, { clientModelConfigs: [chatConfig("stale-warm")] }, { baseEpoch: e0 });
    const next = vi.fn().mockResolvedValue(wireOf([chatConfig("fresh-warm")]));
    const fresh = await getDevinCatalogSnapshot(conn, { fetchFn: next });
    expect(next).toHaveBeenCalledTimes(1); // NOT a cache hit — the publish never landed
    expect(fresh.members.has("stale-warm")).toBe(false);
    expect(fresh.members.get("fresh-warm")).toBeTruthy();

    // A warm asserting the CURRENT epoch (post-rotation acquisition) still lands.
    warmDevinCatalog(conn, { clientModelConfigs: [chatConfig("warmed-post")] }, { baseEpoch: getDevinCatalogEpoch(conn) });
    const warmed = vi.fn();
    const hit = await getDevinCatalogSnapshot(conn, { fetchFn: warmed });
    expect(warmed).not.toHaveBeenCalled(); // fresh cache hit — warm succeeded
    expect(hit.members.get("warmed-post")).toBeTruthy();
    invalidateDevinCatalog("c-epoch-warm");
  });

  it("empty or non-chat-only discovery still yields a usable static-floor snapshot (matrix 10)", async () => {
    invalidateDevinCatalog("c-empty");
    const dvModels = getProviderModels("dv");
    const fetchFn = vi.fn().mockResolvedValue(wireOf([]));
    const snapshot = await getDevinCatalogSnapshot(credsFor("c-empty"), { fetchFn });
    expect(snapshot).not.toBeNull();
    expect(snapshot.families.size).toBe(dvModels.filter((m) => m?.effortRouting).length);
    expect(snapshot.members.size).toBe(dvModels.length);
    expect(snapshot.families.get("swe-2").efforts).toEqual(["medium", "high", "max"]);
    invalidateDevinCatalog("c-empty");

    invalidateDevinCatalog("c-nonchat");
    const fetch2 = vi.fn().mockResolvedValue(wireOf([
      { label: "Embed", modelUid: "embed-1", modelInfo: { modelType: 3 } },
    ]));
    const snap2 = await getDevinCatalogSnapshot(credsFor("c-nonchat"), { fetchFn: fetch2 });
    expect(snap2).not.toBeNull();
    expect(snap2.members.has("embed-1")).toBe(false); // CHAT filter dropped it
    expect(snap2.members.size).toBe(dvModels.length);
    invalidateDevinCatalog("c-nonchat");
  });

  it("caller abort returns null, aborts the fetch, and never poisons the cache (matrix 11)", async () => {
    invalidateDevinCatalog("c-abort");
    const fetchFn = deferredFetch();
    const controller = new AbortController();
    const pending = getDevinCatalogSnapshot(credsFor("c-abort"), { fetchFn, signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toBeNull();
    // Sole waiter aborted → the shared discovery fetch was aborted too.
    expect(fetchFn.mock.calls[0][1].signal.aborted).toBe(true);

    // A late-successful fetch still publishes — no negative caching happened.
    fetchFn.resolveWith({ clientModelConfigs: [chatConfig("post-abort")] });
    await flushMicrotasks();
    const next = vi.fn();
    const snapshot = await getDevinCatalogSnapshot(credsFor("c-abort"), { fetchFn: next });
    expect(next).not.toHaveBeenCalled();
    expect(snapshot.members.get("post-abort")).toMatchObject({ id: "post-abort" });
    invalidateDevinCatalog("c-abort");
  });

  it("an already-aborted signal short-circuits to null without fetching (matrix 11)", async () => {
    invalidateDevinCatalog("c-aborted");
    const controller = new AbortController();
    controller.abort();
    const fetchFn = vi.fn();
    await expect(
      getDevinCatalogSnapshot(credsFor("c-aborted"), { fetchFn, signal: controller.signal }),
    ).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
    invalidateDevinCatalog("c-aborted");
  });

  it("returns null when the credentials carry neither connection id nor token", async () => {
    const fetchFn = vi.fn();
    await expect(getDevinCatalogSnapshot({}, { fetchFn })).resolves.toBeNull();
    await expect(getDevinCatalogSnapshot(null, { fetchFn })).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("buildDevinCatalogSnapshot", () => {
  it("overlays discovery on the static floor and re-routes merged family uids", () => {
    const snapshot = buildDevinCatalogSnapshot({
      clientModelConfigs: [
        familyMember({ uid: "glm-5-2", label: "GLM-5.2", familyLabel: "GLM-5.2", effortName: "Medium", effortOrder: 2, configDefault: true }),
        familyMember({ uid: "glm-5-2-high", label: "GLM-5.2 High", familyLabel: "GLM-5.2", effortName: "High", effortOrder: 3 }),
      ],
    });

    // Static floor intact...
    expect(snapshot.families.has("swe-2")).toBe(true);
    expect(snapshot.members.get("swe-2-high")).toBeTruthy();
    // ...with the static family's routing mirrored onto its members-floor entry.
    expect(snapshot.members.get("swe-2").routing).toBe(snapshot.families.get("swe-2").routing);
    expect(snapshot.members.get("swe-2").effortRouting).toBe(snapshot.families.get("swe-2").routing);

    // Discovered family atomically replaces the static glm-5-2 floor family.
    const fam = snapshot.families.get("glm-5-2");
    expect(fam.routing).toEqual({ medium: "glm-5-2", high: "glm-5-2-high" });
    expect(fam.defaultMember).toBe("glm-5-2");

    // Members-first lookup for the merged raw uid still carries FRESH routing
    // (both `routing` and the registry-legacy `effortRouting` key).
    const merged = snapshot.members.get("glm-5-2");
    expect(merged.routing).toBe(fam.routing);
    expect(merged.effortRouting).toBe(fam.routing);
    expect(merged.defaultMember).toBe("glm-5-2");
    // Pure raw members pass through without routing keys.
    expect(snapshot.members.get("glm-5-2-high").routing).toBeUndefined();
  });

  it("produces independent snapshot instances per build", () => {
    const a = buildDevinCatalogSnapshot({ clientModelConfigs: [] });
    const b = buildDevinCatalogSnapshot({ clientModelConfigs: [] });
    expect(a).not.toBe(b);
    expect(a.families).not.toBe(b.families);
    expect(a.members).not.toBe(b.members);
    expect(a.families.get("swe-2").routing).toEqual(b.families.get("swe-2").routing);
  });
});
