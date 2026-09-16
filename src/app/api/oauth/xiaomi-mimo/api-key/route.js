import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";

/**
 * POST /api/oauth/xiaomi-mimo/api-key
 * Import a Xiaomi MiMo API key manually (or from auto-import).
 * The key is validated against the models endpoint, then stored.
 *
 * Body: { apiKey, uid?, baseUrl? }
 */
export async function POST(request) {
  try {
    const { apiKey, uid, baseUrl, mimoPassToken, mimoUserId, mimoCUserId } = await request.json();

    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return NextResponse.json(
        { error: "API key is required" },
        { status: 400 },
      );
    }

    const key = apiKey.trim();
    if (!key.startsWith("sk-")) {
      return NextResponse.json(
        { error: "Invalid key format — expected sk- prefix" },
        { status: 400 },
      );
    }
    if (/[\r\n\x00-\x1f\x7f]/.test(key)) {
      return NextResponse.json(
        { error: "API key contains invalid control characters or CRLF" },
        { status: 400 },
      );
    }

    let effectiveBaseUrl = "https://api.xiaomimimo.com/v1";
    if (baseUrl && typeof baseUrl === "string" && baseUrl.trim()) {
      const rawUrl = baseUrl.trim();
      if (/[\r\n\x00-\x1f\x7f]/.test(rawUrl)) {
        return NextResponse.json(
          { error: "baseUrl contains invalid control characters or CRLF" },
          { status: 400 },
        );
      }
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          return NextResponse.json(
            { error: "Invalid baseUrl protocol — expected http or https" },
            { status: 400 },
          );
        }
        const hostname = parsed.hostname.toLowerCase();
        const isAllowedHost =
          hostname === "api.xiaomimimo.com" ||
          hostname === "platform.xiaomimimo.com" ||
          hostname === "mimo-server-cn.xiaomimimo.com" ||
          hostname === "xiaomimimo.com" ||
          hostname.endsWith(".xiaomimimo.com") ||
          hostname === "localhost" ||
          hostname === "127.0.0.1";
        if (!isAllowedHost) {
          return NextResponse.json(
            { error: "Unsupported baseUrl host: arbitrary host override is not permitted" },
            { status: 400 },
          );
        }
        effectiveBaseUrl = rawUrl.replace(/\/+$/, "");
      } catch {
        return NextResponse.json(
          { error: "Invalid baseUrl format" },
          { status: 400 },
        );
      }
    }
    // Validate the key against the models endpoint
    let validated = false;
    let modelCount = 0;
    try {
      const resp = await fetch(`${effectiveBaseUrl}/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          "X-Mimo-Source": "mimocode-cli",
        },
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const data = await resp.json();
        modelCount = Array.isArray(data?.data) ? data.data.length : 0;
        validated = true;
      }
    } catch {
      // Network error — still allow import (key may be valid but network blocked)
    }

    if (!validated) {
      // Soft-fail: store the key but mark as untested
      console.log("[xiaomi-mimo] key validation failed, storing as untested");
    }

    // Dedup: if a connection with the same uid or same key already exists, update it
    const { getProviderConnections, updateProviderConnection } = await import("@/models");
    const existing = (await getProviderConnections()).find(
      (c) => c.provider === "xiaomi-mimo" && (
        (uid && c.email === `${uid}@xiaomi`) ||
        c.accessToken === key
      ),
    );
    if (existing) {
      const updated = await updateProviderConnection(existing.id, {
        accessToken: key,
        providerSpecificData: {
          ...existing.providerSpecificData,
          uid: uid || existing.providerSpecificData?.uid || null,
          baseUrl: effectiveBaseUrl,
          // Per-account session credential — enables multi-account rotation.
          mimoPassToken: mimoPassToken || existing.providerSpecificData?.mimoPassToken || null,
          mimoUserId: mimoUserId || existing.providerSpecificData?.mimoUserId || null,
          mimoCUserId: mimoCUserId || existing.providerSpecificData?.mimoCUserId || null,
          modelCount,
        },
        testStatus: validated ? "active" : existing.testStatus,
      });
      return NextResponse.json({
        success: true,
        validated,
        modelCount,
        updated: true,
        connection: {
          id: existing.id,
          provider: existing.provider,
          email: existing.email,
          displayName: existing.displayName,
        },
      });
    }

    const connection = await createProviderConnection({
      provider: "xiaomi-mimo",
      authType: "api_key",
      accessToken: key,
      refreshToken: null,
      // API keys don't expire on a fixed schedule; use a long horizon
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      email: uid ? `${uid}@xiaomi` : null,
      displayName: uid ? `Xiaomi ${uid}` : "Xiaomi MiMo",
      providerSpecificData: {
        uid: uid || null,
        baseUrl: effectiveBaseUrl,
        authMethod: "api_key",
        provider: "API Key",
        modelCount,
        // Per-account session credential — enables multi-account rotation.
        mimoPassToken: mimoPassToken || null,
        mimoUserId: mimoUserId || null,
        mimoCUserId: mimoCUserId || null,
      },
      testStatus: validated ? "active" : "untested",
    });

    return NextResponse.json({
      success: true,
      validated,
      modelCount,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        displayName: connection.displayName,
      },
    });
  } catch (error) {
    console.log("Xiaomi MiMo API key import error:", error);
    return NextResponse.json(
      { error: "API key import failed" },
      { status: 500 },
    );
  }
}
