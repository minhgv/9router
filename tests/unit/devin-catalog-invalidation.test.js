import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  getProxyPoolById: vi.fn(),
  updateProviderConnection: vi.fn(),
  deleteProviderConnection: vi.fn(),
  invalidateDevinCatalog: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  getProxyPoolById: mocks.getProxyPoolById,
  updateProviderConnection: mocks.updateProviderConnection,
  deleteProviderConnection: mocks.deleteProviderConnection,
}));

vi.mock("open-sse/services/devinCatalog.js", () => ({
  invalidateDevinCatalog: mocks.invalidateDevinCatalog,
}));

// Response shape only — route wiring is under test, not Next's runtime.
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) =>
      new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      }),
  },
}));

import { DELETE, PUT } from "@/app/api/providers/[id]/route.js";

const jsonRequest = (body) => ({ json: async () => body });

const devinConnection = { id: "conn-devin", provider: "devin", authType: "apikey" };
const otherConnection = { id: "conn-anthropic", provider: "anthropic", authType: "apikey" };

describe("providers [id] route → devin catalog invalidation wiring (AC-12)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PUT on a devin connection invalidates the catalog after the update lands", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(devinConnection);
    mocks.updateProviderConnection.mockResolvedValue({ ...devinConnection, name: "Renamed", apiKey: "sk-secret" });

    const response = await PUT(
      jsonRequest({ name: "Renamed" }),
      { params: Promise.resolve({ id: "conn-devin" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connection: { ...devinConnection, name: "Renamed" }, // sensitive fields stripped
    });
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("conn-devin", { name: "Renamed" });
    expect(mocks.invalidateDevinCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateDevinCatalog).toHaveBeenCalledWith("conn-devin");
    // Invalidated after the persist, so a failed update never drops the cache.
    expect(mocks.invalidateDevinCatalog.mock.invocationCallOrder[0])
      .toBeGreaterThan(mocks.updateProviderConnection.mock.invocationCallOrder[0]);
  });

  it("PUT on a non-devin connection does not touch the catalog", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(otherConnection);
    mocks.updateProviderConnection.mockResolvedValue({ ...otherConnection, name: "Renamed" });

    const response = await PUT(
      jsonRequest({ name: "Renamed" }),
      { params: Promise.resolve({ id: "conn-anthropic" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.updateProviderConnection).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateDevinCatalog).not.toHaveBeenCalled();
  });

  it("DELETE invalidates the catalog for the deleted connection id", async () => {
    mocks.deleteProviderConnection.mockResolvedValue(true);

    const response = await DELETE(jsonRequest({}), { params: Promise.resolve({ id: "conn-devin" }) });

    expect(response.status).toBe(200);
    expect(mocks.deleteProviderConnection).toHaveBeenCalledWith("conn-devin");
    expect(mocks.invalidateDevinCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateDevinCatalog).toHaveBeenCalledWith("conn-devin");
  });

  it("DELETE of a missing connection 404s without invalidating", async () => {
    mocks.deleteProviderConnection.mockResolvedValue(null);

    const response = await DELETE(jsonRequest({}), { params: Promise.resolve({ id: "gone" }) });

    expect(response.status).toBe(404);
    expect(mocks.invalidateDevinCatalog).not.toHaveBeenCalled();
  });
});
