import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Tests that create provider connections / call models must NEVER touch the
// real data dir (~/.9router). Vitest injects `env` into process.env before any
// test file imports modules that resolve the DB path, so a per-run mkdtemp
// here isolates the whole suite. Escape hatches:
//   - DATA_DIR=<dir> (explicit) wins.
//   - RUN_REAL=1 runs live-provider tests that intentionally read ~/.9router.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
const isolatedDataDir =
  !process.env.DATA_DIR && process.env.RUN_REAL !== "1"
    ? mkdtempSync(join(tmpdir(), "9router-test-"))
    : undefined;
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.js"],
    // Don't scan into git worktrees nested under .claude/ — they carry their
    // own copies of the test files but lack an installed node_modules (open-sse,
    // etc.), which makes provider imports fail during collection.
    exclude: ["**/node_modules/**", "**/.claude/**", "**/dist/**"],
    // Allow many it.concurrent cases (real provider smoke runs ~50 providers in parallel)
    maxConcurrency: 60,
    // Suppress noisy console output from handlers under test
    silent: false,
    env: {
      ...(isolatedDataDir ? { DATA_DIR: isolatedDataDir } : {}),
    },
  },
  resolve: {
    // Use array form so subpath aliases (e.g. "@/lib/db/index.js") resolve correctly.
    alias: [
      { find: /^open-sse\//, replacement: resolve(__dirname, "../open-sse") + "/" },
      { find: "open-sse", replacement: resolve(__dirname, "../open-sse") },
      { find: /^@\//, replacement: resolve(__dirname, "../src") + "/" },
    ],
  },
});
