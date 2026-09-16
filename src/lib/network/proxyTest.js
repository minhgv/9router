import { ProxyAgent, fetch as undiciFetch } from "undici";

const DEFAULT_TEST_URL = "https://google.com/";
const DEFAULT_TIMEOUT_MS = 8000;
// P-PROXY allowlist: only http | https | socks5 are valid proxy schemes.
const ALLOWED_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:"]);

function getErrorMessage(err) {
  if (!err) return "Unknown error";
  const base = err?.message || String(err);
  const causeCode = err?.cause?.code || err?.code;
  const causeMessage = err?.cause?.message;

  if (causeMessage && causeMessage !== base) {
    return causeCode ? `${base}: ${causeMessage} (${causeCode})` : `${base}: ${causeMessage}`;
  }

  if (causeCode && !base.includes(causeCode)) {
    return `${base} (${causeCode})`;
  }

  return base;
}

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

export async function testProxyUrl({ proxyUrl, testUrl, timeoutMs } = {}) {
  const normalizedProxyUrl = normalizeString(proxyUrl);
  if (!normalizedProxyUrl) {
    return { ok: false, status: 400, error: "proxyUrl is required" };
  }

  // P-PROXY boundary: reject control characters, unparseable values and
  // unsupported schemes BEFORE any dispatcher/transport construction.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(normalizedProxyUrl)) {
    return { ok: false, status: 400, error: "Invalid proxy URL: control characters are not allowed" };
  }

  let parsedProxyUrl;
  try {
    parsedProxyUrl = new URL(normalizedProxyUrl);
  } catch {
    return { ok: false, status: 400, error: "Invalid proxy URL" };
  }

  if (!ALLOWED_PROXY_PROTOCOLS.has(parsedProxyUrl.protocol)) {
    return {
      ok: false,
      status: 400,
      error: `Unsupported proxy scheme: ${parsedProxyUrl.protocol.replace(/:$/, "")} (allowed: http, https, socks5)`,
    };
  }

  const normalizedTestUrl = normalizeString(testUrl) || DEFAULT_TEST_URL;
  const timeoutMsRaw = Number(timeoutMs);
  const normalizedTimeoutMs =
    Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.min(timeoutMsRaw, 30000)
      : DEFAULT_TIMEOUT_MS;

  let dispatcher;

  try {
    try {
      dispatcher = new ProxyAgent({ uri: normalizedProxyUrl });
    } catch (err) {
      return {
        ok: false,
        status: 400,
        error: `Invalid proxy URL: ${err?.message || String(err)}`,
      };
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), normalizedTimeoutMs);

    try {
      const res = await undiciFetch(normalizedTestUrl, {
        method: "HEAD",
        dispatcher,
        signal: controller.signal,
        headers: {
          "User-Agent": "9Router",
        },
      });

      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        url: normalizedTestUrl,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      const message =
        err?.name === "AbortError"
          ? "Proxy test timed out"
          : getErrorMessage(err);
      return { ok: false, status: 500, error: message };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    try {
      await dispatcher?.close?.();
    } catch {
      // ignore
    }
  }
}
