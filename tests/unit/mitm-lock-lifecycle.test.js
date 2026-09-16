/**
 * SEC-05 — MITM lock lifecycle (plan §6 S5, §7.2 SEC-05)
 * Target: src/mitm/manager.js startServer() lock handling (LOCK_FILE ".mitm.lock").
 *
 * Locked policy (plan §5 row SEC-05):
 *  (a) pre-spawn failure  -> lock cleaned up, next start succeeds
 *  (b) concurrent start   -> bounded contention error, no second spawn, no false lockout
 *  (c) foreign live owner -> lock never deleted/stolen, owner never signalled
 *  (d) stale dead-pid lock-> reclaimed (rewritten with our pid), spawn proceeds
 *
 * Approach: manager.js is CommonJS — its require() graph is NOT intercepted by
 * vi.mock (verified empirically: mocks fire on direct import but never on
 * manager's lazy re-requires). We patch Module._load for modules resolved from
 * src/mitm/ instead, faking only leaf deps (child_process, https health poll,
 * cert/dns/logger/config helpers). fs stays REAL so lock-file state is
 * observably asserted. "./paths" is redirected to a per-test synthetic because
 * node's require cache survives vi.resetModules() — without this, MITM_DIR
 * leaks from the first test's temp dir into every later test (observed ENOENT).
 * No real MITM traffic: spawn is a fake EventEmitter child, health polling is
 * answered by a fake https.request.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import Module from "node:module";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync,
  existsSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const h = {
  spawnCalls: [],   // arrays of spawn(...args)
  execCalls: [],    // exec command strings
  execSyncCalls: [],
  spawnImpl: null,  // (args) => child  (default: healthy fake child)
  childPid: 4242422, // pid reported by fake child + health endpoint
  httpsMode: "healthy", // "healthy" | "pending"
  httpsPending: [],
  httpsRequests: [],
  flushHttps: null,
};

function makeFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {} };
  return child;
}

function fakeChildProcess() {
  return {
    spawn: (...args) => {
      h.spawnCalls.push(args);
      return h.spawnImpl(args);
    },
    exec: (cmd, opts, cb) => {
      h.execCalls.push(String(cmd));
      if (typeof opts === "function") { opts(null, "", ""); return; }
      if (typeof cb === "function") cb(null, "", "");
    },
    execSync: (...args) => {
      h.execSyncCalls.push(String(args[0]));
      throw new Error("execSync disabled in test");
    },
  };
}

function fakeHttps() {
  class FakeRequest extends EventEmitter {
    constructor(opts, cb) {
      super();
      h.httpsRequests.push(opts);
      this.opts = opts;
      this.resCb = cb;
    }
    end() {
      if (h.httpsMode === "healthy") {
        const res = new EventEmitter();
        setImmediate(() => {
          this.resCb(res);
          res.emit("data", Buffer.from(JSON.stringify({ ok: true, pid: h.childPid })));
          res.emit("end");
        });
      } else {
        h.httpsPending.push(this);
      }
    }
  }
  h.flushHttps = () => {
    const pending = h.httpsPending.splice(0, h.httpsPending.length);
    for (const req of pending) {
      const res = new EventEmitter();
      setImmediate(() => {
        req.resCb(res);
        res.emit("data", Buffer.from(JSON.stringify({ ok: true, pid: h.childPid })));
        res.emit("end");
      });
    }
  };
  return { request: (opts, cb) => new FakeRequest(opts, cb) };
}

/** Deterministically find a PID that is definitely not alive (probe 1..999). */
function findDeadPid() {
  for (let pid = 1; pid <= 999; pid++) {
    if (pid === process.pid || pid === process.ppid) continue;
    try { process.kill(pid, 0); } catch (err) {
      if (err.code === "ESRCH") return pid;
      // EPERM -> alive but owned by someone else; keep probing
    }
  }
  throw new Error("could not find a dead pid for stale-lock test");
}

// --- Module._load patch (replaces vi.mock for manager's CJS require graph) --
const REAL_LOAD = Module._load;
let dataDir = null;

function mitmFakeFor(request, parentFilename) {
  if (!parentFilename || !parentFilename.includes(`${path.sep}src${path.sep}mitm`)) {
    return undefined;
  }
  if (request === "child_process") return fakeChildProcess();
  if (request === "https") return fakeHttps();
  if (request === "node-machine-id") return { machineIdSync: () => "test-machine-id" };

  const resolved = request.startsWith(".")
    ? path.resolve(path.dirname(parentFilename), request)
    : null;
  if (resolved && resolved.endsWith(`${path.sep}mitm${path.sep}paths`)) {
    return { DATA_DIR: dataDir, MITM_DIR: path.join(dataDir, "mitm") };
  }
  if (resolved && resolved.includes("cert/install")) {
    return {
      installCert: async () => {},
      uninstallCert: async () => {},
      checkCertInstalled: async () => true,
    };
  }
  if (resolved && resolved.includes("cert/generate")) {
    return { generateCert: async () => {} };
  }
  if (resolved && resolved.includes("cert/rootCA")) {
    return { isCertExpired: () => false };
  }
  if (resolved && resolved.includes("dns/dnsConfig")) {
    return {
      addDNSEntry: async () => ({}),
      removeDNSEntry: async () => ({}),
      removeAllDNSEntries: async () => {},
      removeAllDNSEntriesSync: () => {},
      checkAllDNSStatus: () => ({}),
      TOOL_HOSTS: {},
      isSudoAvailable: () => false,
      isSudoPasswordRequired: () => false,
      execWithPassword: async () => ({}),
    };
  }
  if (resolved && resolved.includes("winElevated")) {
    return { isAdmin: () => false };
  }
  if (resolved && resolved.endsWith(`${path.sep}mitm${path.sep}logger`)) {
    return { log: () => {}, err: () => {} };
  }
  if (resolved && resolved.endsWith(`${path.sep}mitm${path.sep}config`)) {
    return { LSOF_BIN: "lsof" };
  }
  return undefined;
}

function installRequirePatch() {
  Module._load = function patchedLoad(request, parent, isMain) {
    const parentFile = parent && parent.filename;
    const fake = mitmFakeFor(request, parentFile);
    if (fake !== undefined) return fake;
    return REAL_LOAD.call(this, request, parent, isMain);
  };
}

async function loadManager() {
  vi.resetModules();
  const mod = await import("../../src/mitm/manager.js");
  return mod.default ? mod.default : mod;
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "mitm-lock-lifecycle-"));
  mkdirSync(path.join(dataDir, "mitm"), { recursive: true });
  h.spawnCalls = [];
  h.execCalls = [];
  h.execSyncCalls = [];
  h.httpsMode = "healthy";
  h.httpsPending = [];
  h.httpsRequests = [];
  h.flushHttps = null;
  h.spawnImpl = () => makeFakeChild(h.childPid);
  installRequirePatch();
});

afterEach(() => {
  Module._load = REAL_LOAD;
  if (h.flushHttps) h.flushHttps();
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

describe("SEC-05: MITM lock lifecycle (src/mitm/manager.js startServer)", () => {
  it("(a) pre-spawn failure cleans up the lock; the next start succeeds", async () => {
    const lockFile = path.join(dataDir, "mitm", ".mitm.lock");
    const pidFile = path.join(dataDir, "mitm", ".mitm.pid");
    const manager = await loadManager();

    h.spawnImpl = () => { throw new Error("simulated spawn failure"); };
    await expect(manager.startServer("test-api-key")).rejects.toThrow(/simulated spawn failure/);

    // Lock must be cleaned up by the failure path (manager.js catch block).
    expect(existsSync(lockFile)).toBe(false);

    // Next start must succeed (no stale lock blocking).
    h.spawnImpl = () => makeFakeChild(h.childPid);
    const second = await manager.startServer("test-api-key");
    expect(second.running).toBe(true);
    expect(second.pid).toBe(h.childPid);
    // Healthy start consumed the lock (removed) and wrote the PID marker.
    expect(existsSync(lockFile)).toBe(false);
    expect(readFileSync(pidFile, "utf-8")).toBe(String(h.childPid));
  }, 15000);

  it("(b) concurrent start while first is in-flight reuses the live server (no double-spawn, no false lockout)", async () => {
    const lockFile = path.join(dataDir, "mitm", ".mitm.lock");
    const pidFile = path.join(dataDir, "mitm", ".mitm.pid");
    // A live pid (our parent) so the second instance's PID-marker check sees
    // a running server, exactly as a second process would.
    const livePid = process.ppid;
    h.childPid = livePid;
    h.spawnImpl = () => makeFakeChild(livePid);
    const instA = await loadManager();
    const instB = await loadManager(); // second module instance ~ second process

    // Keep the first start in-flight: spawned, PID marker written, poll pending.
    h.httpsMode = "pending";
    const first = instA.startServer("test-api-key");
    await vi.waitFor(() => expect(h.spawnCalls).toHaveLength(1));
    expect(existsSync(lockFile)).toBe(true);
    expect(readFileSync(lockFile, "utf-8")).toBe(String(process.pid));
    expect(readFileSync(pidFile, "utf-8")).toBe(String(livePid));

    // Concurrent start (separate instance) must be bounded: no second spawn,
    // no lock theft, and no false lockout — it reuses the live server.
    const second = await instB.startServer("test-api-key");
    expect(second).toEqual({ running: true, pid: livePid });
    expect(h.spawnCalls).toHaveLength(1);
    expect(readFileSync(lockFile, "utf-8")).toBe(String(process.pid));

    // First start completes: lock released, PID marker persists.
    h.flushHttps();
    await expect(first).resolves.toEqual({ running: true, pid: livePid });
    expect(existsSync(lockFile)).toBe(false);
    expect(readFileSync(pidFile, "utf-8")).toBe(String(livePid));

    // Start against the running server: bounded rejection, still one spawn.
    await expect(instA.startServer("test-api-key")).rejects.toThrow(/already running/);
    expect(h.spawnCalls).toHaveLength(1);
    expect(existsSync(lockFile)).toBe(false);
  }, 15000);


  it("(c) lock owned by another live process is never deleted, stolen, or signalled", async () => {
    const lockFile = path.join(dataDir, "mitm", ".mitm.lock");
    const manager = await loadManager();

    // Pre-create the lock in the manager's own format: String(pid).
    writeFileSync(lockFile, String(process.ppid), { flag: "wx" });

    await expect(manager.startServer("test-api-key")).rejects.toThrow(/already starting/);

    // Foreign lock preserved byte-for-byte; our pid never took ownership.
    expect(readFileSync(lockFile, "utf-8")).toBe(String(process.ppid));
    // No second spawn and no kill/lsof signaling against the foreign owner.
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.execCalls.join("\n")).not.toContain(String(process.ppid));
  }, 15000);

  it("(d) stale lock from a dead pid is reclaimed with our own pid", async () => {
    const lockFile = path.join(dataDir, "mitm", ".mitm.lock");
    const manager = await loadManager();

    const deadPid = findDeadPid();
    writeFileSync(lockFile, String(deadPid), { flag: "wx" });

    h.httpsMode = "pending";
    const first = manager.startServer("test-api-key");
    await vi.waitFor(() => expect(h.spawnCalls).toHaveLength(1));
    // Reclaim must proceed to spawn, and the lock must now carry OUR pid.
    expect(readFileSync(lockFile, "utf-8")).toBe(String(process.pid));
    expect(h.spawnCalls).toHaveLength(1);

    h.flushHttps();
    await expect(first).resolves.toEqual({ running: true, pid: h.childPid });
    expect(existsSync(lockFile)).toBe(false);
  }, 15000);
});
