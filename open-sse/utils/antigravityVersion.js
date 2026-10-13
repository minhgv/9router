// Antigravity client version tracking.
//
// The backend gates model access on the client version in the User-Agent, so a
// stale pinned version is itself a fingerprint. The real client updates via
// electron-builder; its update manifest is publicly readable and carries the
// latest released version. (Parity: antigravity-opencode transport/version.ts.)

/** Pinned fallback when the update manifest is unreachable. */
export const DEFAULT_ANTIGRAVITY_VERSION = "2.23.0";

const ANTIGRAVITY_VERSION_MANIFEST_URL =
  "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
const ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS = 5000;

let discoveredAntigravityVersion = null;
let antigravityVersionFetch = null;

/** Current Antigravity client version: env override → manifest-discovered → pinned fallback. */
export function getAntigravityVersion() {
  return process.env.ANTIGRAVITY_IDE_VERSION || discoveredAntigravityVersion || DEFAULT_ANTIGRAVITY_VERSION;
}

/** Current client User-Agent (`antigravity/hub/<version> (aidev_client; …)`).
 * The backend gates the model roster on the UA client token — `antigravity/ide`
 * is served a stale catalog without gemini-4-argon (404 NOT_FOUND), while the
 * real `antigravity/hub` client string unlocks it. `cl` is telemetry only
 * (verified live: stale/absent cl still passes gating; version is what gates). */
export function getAntigravityIdeUserAgent() {
  const cl = process.env.ANTIGRAVITY_CL || "963137146";
  const os = process.env.ANTIGRAVITY_OS || "darwin";
  const arch = process.env.ANTIGRAVITY_ARCH || "arm64";
  return `antigravity/hub/${getAntigravityVersion()} (aidev_client; os_type=${os}; arch=${arch}; cl=${cl})`;
}

/**
 * Extracts the client version from an electron-builder update manifest.
 * Returns null when no well-formed `version:` line is present.
 */
export function parseAntigravityManifestVersion(yamlText) {
  for (const line of String(yamlText || "").split(/\r?\n/)) {
    const match = /^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    const version = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  }
  return null;
}

/**
 * Resolves the latest Antigravity release from the official update manifest.
 * Success is cached for the process lifetime; failures are silent (the pinned
 * fallback stays valid) and clear the in-flight cache so a later call retries.
 * Skipped entirely when ANTIGRAVITY_IDE_VERSION is set.
 */
export function ensureAntigravityVersion(fetcher = fetch) {
  if (process.env.ANTIGRAVITY_IDE_VERSION || discoveredAntigravityVersion) {
    return Promise.resolve();
  }
  if (antigravityVersionFetch) return antigravityVersionFetch;

  antigravityVersionFetch = (async () => {
    try {
      const response = await fetcher(ANTIGRAVITY_VERSION_MANIFEST_URL, {
        headers: { "Cache-Control": "no-cache", "User-Agent": "electron-builder" },
        signal: AbortSignal.timeout(ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        discoveredAntigravityVersion = parseAntigravityManifestVersion(await response.text());
      }
    } catch {
      // Silent: the pinned fallback remains valid when version discovery fails.
    } finally {
      if (!discoveredAntigravityVersion) antigravityVersionFetch = null;
    }
  })();
  return antigravityVersionFetch;
}
