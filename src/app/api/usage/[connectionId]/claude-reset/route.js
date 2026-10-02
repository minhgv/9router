import "open-sse/index.js";

import { getProviderConnectionById } from "@/lib/localDb";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { consumeClaudeResetGrant } from "open-sse/services/usage.js";
import { refreshAndUpdateCredentials } from "../route.js";

function sameOriginRequest(request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.origin !== origin) return false;

    const allowedOrigins = new Set();
    const configuredOrigin = process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL;
    if (configuredOrigin) {
      try {
        allowedOrigins.add(new URL(configuredOrigin).origin);
      } catch {
        // Ignore invalid configuration and continue with the request authority.
      }
    }

    const requestUrl = new URL(request.url);
    const host = request.headers.get("host");
    if (host && !/[\\/,@?#\s]/.test(host)) {
      allowedOrigins.add(new URL(`${requestUrl.protocol}//${host}`).origin);
    } else if (!configuredOrigin) {
      allowedOrigins.add(requestUrl.origin);
    }
    return allowedOrigins.has(parsedOrigin.origin);
  } catch {
    return false;
  }
}

export async function POST(request, { params }) {
  if (!sameOriginRequest(request)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!await verifyDashboardAuthToken(request.cookies?.get("auth_token")?.value)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let connection;
  try {
    const { connectionId } = await params;
    const body = await request.json().catch(() => ({}));
    if (typeof body?.grantId !== "string" || !/^[a-z0-9_-]{1,40}$/.test(body.grantId)) {
      return Response.json({ error: "Invalid reset grant id." }, { status: 400 });
    }
    connection = await getProviderConnectionById(connectionId);
    if (!connection) return Response.json({ error: "Connection not found" }, { status: 404 });
    if (connection.provider !== "claude" || connection.authType !== "oauth") {
      return Response.json({ error: "Limit reset is only available for Claude OAuth connections." }, { status: 400 });
    }

    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };
    ({ connection } = await refreshAndUpdateCredentials(connection, false, proxyOptions));
    const result = await consumeClaudeResetGrant(connection.accessToken, body.grantId, proxyOptions);
    if (result.ok) return Response.json(result);
    const status = result.status >= 400 && result.status < 500 ? result.status : 409;
    return Response.json({ ...result, message: result.message || `Reset not applied: ${result.reason || result.result || "unknown"}` }, { status });
  } catch {
    console.warn(`[Claude Reset] Failed for connection ${connection?.id || "unknown"}`);
    return Response.json({ error: "Unable to apply Claude reset." }, { status: 500 });
  }
}
