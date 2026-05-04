import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const monitorSource = readFileSync(resolve(process.cwd(), "infra/monitor.mjs"), "utf8");
const maintenanceSource = readFileSync(
  resolve(process.cwd(), "infra/maintenance.mjs"),
  "utf8",
);
const cliSource = readFileSync(resolve(process.cwd(), "cli.mjs"), "utf8");

function extractFunctionSource(source, functionName) {
  const signature = `function ${functionName}(`;
  const start = source.indexOf(signature);
  if (start < 0) {
    throw new Error(`Function not found: ${functionName}`);
  }

  const bodyStart = source.indexOf("{", start);
  if (bodyStart < 0) {
    throw new Error(`Function body not found: ${functionName}`);
  }

  let depth = 0;
  let stringQuote = null;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (stringQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === stringQuote) {
        stringQuote = null;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (ch === "\"" || ch === "'" || ch === "`") {
      stringQuote = ch;
      continue;
    }

    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  throw new Error(`Function braces did not close: ${functionName}`);
}

function compileFunction(source, functionName, deps = {}) {
  const fnSource = extractFunctionSource(source, functionName);
  const depNames = Object.keys(deps);
  const depValues = Object.values(deps);
  const factory = new Function(
    ...depNames,
    `${fnSource}\nreturn ${functionName};`,
  );
  return factory(...depValues);
}

describe("duplicate monitor lock handling", () => {
  it("treats non-self-restart lock contention as a benign duplicate start", () => {
    const blockMatch = monitorSource.match(
      /if \(!acquireMonitorLock\(config\.cacheDir\)\) \{[\s\S]*?process\.exit\(0\);[\s\S]*?\n\s*\}/,
    );
    expect(blockMatch, "singleton guard block should exit 0 for duplicate starts").toBeTruthy();
    const block = blockMatch ? blockMatch[0] : "";
    expect(
      block.includes("duplicate start ignored") ||
        block.includes("writeDuplicateStartExitNotice("),
    ).toBe(true);
    expect(block).not.toContain("exit code 1");
  });

  it("logs duplicate lock owners as warnings in maintenance", () => {
    expect(maintenanceSource).toContain("another bosun is already running");
    expect(maintenanceSource).toContain("Ignoring duplicate start.");
    expect(maintenanceSource).toContain("logDuplicateStartWarning(");
  });

  it("throttles duplicate lock warning spam across restart storms", () => {
    expect(maintenanceSource).toContain("MONITOR_DUPLICATE_START_WARN_THROTTLE_MS");
    expect(maintenanceSource).toContain("duplicate-start warnings in last");
  });
  it("throttles duplicate-start exit notices in monitor", () => {
    expect(monitorSource).toContain("DUPLICATE_START_EXIT_THROTTLE_MS");
    expect(monitorSource).toContain("monitor-duplicate-start-exit-state.json");
    expect(monitorSource).toContain("samePid");
    expect(monitorSource).toContain("duplicate-start exits in last");
  });

  it("includes lock owner PID in monitor duplicate-start exit notices", () => {
    expect(monitorSource).toContain("MONITOR_PID_FILE_NAME");
    expect(monitorSource).toContain("readMonitorLockOwnerPid");
    expect(monitorSource).toContain("holds the lock");
    expect(monitorSource).toContain("(PID ${ownerPid})");
  });
  it("keeps benign duplicate-start logs out of error channels", () => {
    expect(maintenanceSource).toContain("console.log(message + suffix)");
    expect(monitorSource).toContain("process.stdout.write(");
  });

  it("treats permission-denied PID probes as alive in cli preflight", () => {
    expect(cliSource).toContain("err.code === \"EPERM\"");
    expect(cliSource).toContain("err.code === \"EACCES\"");
  });

  it("short-circuits duplicate starts in cli before forking monitor", () => {
    const preflightMatch = cliSource.match(
      /const configuredCacheDirs = await getConfiguredRuntimeCacheDirs\(\);[\s\S]*?const existingOwner = detectExistingMonitorLockOwner\(null, configuredCacheDirs\);[\s\S]*?if \(existingOwner\) \{[\s\S]*?exiting duplicate start\.[\s\S]*?return;[\s\S]*?\}/,
    );
    expect(preflightMatch, "cli should skip runMonitor() when a live lock owner exists").toBeTruthy();
  });
});

describe("cli isProcessAlive", () => {
  function makeIsProcessAlive(killImpl) {
    return compileFunction(cliSource, "isProcessAlive", {
      process: {
        kill: killImpl,
      },
    });
  }

  it("returns false for non-positive or non-numeric PIDs without probing", () => {
    const kill = vi.fn();
    const isProcessAlive = makeIsProcessAlive(kill);

    expect(isProcessAlive(null)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-12)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("returns true when process.kill(pid, 0) succeeds", () => {
    const kill = vi.fn();
    const isProcessAlive = makeIsProcessAlive(kill);

    expect(isProcessAlive(4321)).toBe(true);
    expect(kill).toHaveBeenCalledWith(4321, 0);
  });

  it("returns true when process probe fails with EPERM", () => {
    const kill = vi.fn(() => {
      const err = new Error("permission denied");
      err.code = "EPERM";
      throw err;
    });
    const isProcessAlive = makeIsProcessAlive(kill);

    expect(isProcessAlive(4321)).toBe(true);
  });

  it("returns true when process probe fails with EACCES", () => {
    const kill = vi.fn(() => {
      const err = new Error("access denied");
      err.code = "EACCES";
      throw err;
    });
    const isProcessAlive = makeIsProcessAlive(kill);

    expect(isProcessAlive(4321)).toBe(true);
  });

  it("returns false for non-permission process probe failures", () => {
    const kill = vi.fn(() => {
      const err = new Error("no such process");
      err.code = "ESRCH";
      throw err;
    });
    const isProcessAlive = makeIsProcessAlive(kill);

    expect(isProcessAlive(4321)).toBe(false);
  });
});

describe("cli readAlivePid", () => {
  function makeReadAlivePid({ existsSync, readFileSync, isProcessAlive }) {
    return compileFunction(cliSource, "readAlivePid", {
      existsSync,
      readFileSync,
      isProcessAlive,
    });
  }

  it("returns null when PID file does not exist", () => {
    const existsSync = vi.fn(() => false);
    const readFileSync = vi.fn();
    const isProcessAlive = vi.fn();
    const readAlivePid = makeReadAlivePid({ existsSync, readFileSync, isProcessAlive });

    expect(readAlivePid("missing.pid")).toBeNull();
    expect(readFileSync).not.toHaveBeenCalled();
    expect(isProcessAlive).not.toHaveBeenCalled();
  });

  it("returns numeric PID when file contains a live PID", () => {
    const existsSync = vi.fn(() => true);
    const readFileSync = vi.fn(() => "2468");
    const isProcessAlive = vi.fn((pid) => pid === 2468);
    const readAlivePid = makeReadAlivePid({ existsSync, readFileSync, isProcessAlive });

    expect(readAlivePid("bosun.pid")).toBe(2468);
    expect(isProcessAlive).toHaveBeenCalledWith(2468);
  });

  it("parses JSON pid payloads for legacy/new formats", () => {
    const existsSync = vi.fn(() => true);
    const readFileSync = vi.fn(() => '{"pid":"9001"}');
    const isProcessAlive = vi.fn((pid) => pid === 9001);
    const readAlivePid = makeReadAlivePid({ existsSync, readFileSync, isProcessAlive });

    expect(readAlivePid("bosun.pid")).toBe(9001);
    expect(isProcessAlive).toHaveBeenCalledWith(9001);
  });

  it("returns null when JSON payload is malformed", () => {
    const existsSync = vi.fn(() => true);
    const readFileSync = vi.fn(() => "{not-json");
    const isProcessAlive = vi.fn();
    const readAlivePid = makeReadAlivePid({ existsSync, readFileSync, isProcessAlive });

    expect(readAlivePid("bosun.pid")).toBeNull();
    expect(isProcessAlive).not.toHaveBeenCalled();
  });

  it("returns null when pid exists but is no longer alive", () => {
    const existsSync = vi.fn(() => true);
    const readFileSync = vi.fn(() => "2468");
    const isProcessAlive = vi.fn(() => false);
    const readAlivePid = makeReadAlivePid({ existsSync, readFileSync, isProcessAlive });

    expect(readAlivePid("bosun.pid")).toBeNull();
    expect(isProcessAlive).toHaveBeenCalledWith(2468);
  });

  it("returns null when file read throws", () => {
    const existsSync = vi.fn(() => true);
    const readFileSync = vi.fn(() => {
      throw new Error("boom");
    });
    const isProcessAlive = vi.fn();
    const readAlivePid = makeReadAlivePid({ existsSync, readFileSync, isProcessAlive });

    expect(readAlivePid("bosun.pid")).toBeNull();
  });
});

describe("cli detectExistingMonitorLockOwner", () => {
  function makeDetectExistingMonitorLockOwner({
    getMonitorPidFileCandidates,
    readAlivePid,
    processPid = 1111,
    warn = vi.fn(),
  }) {
    return compileFunction(cliSource, "detectExistingMonitorLockOwner", {
      getMonitorPidFileCandidates,
      readAlivePid,
      process: { pid: processPid },
      console: { warn },
    });
  }

  it("returns first live owner that is not self", () => {
    const readAlivePid = vi.fn((pidFile) => {
      if (pidFile === "a.pid") return null;
      if (pidFile === "b.pid") return 1111;
      if (pidFile === "c.pid") return 2222;
      return null;
    });
    const detectExistingMonitorLockOwner = makeDetectExistingMonitorLockOwner({
      getMonitorPidFileCandidates: () => ["a.pid", "b.pid", "c.pid"],
      readAlivePid,
      processPid: 1111,
    });

    expect(detectExistingMonitorLockOwner()).toEqual({
      pid: 2222,
      pidFile: "c.pid",
    });
  });

  it("skips excluded PID and returns next live owner", () => {
    const readAlivePid = vi.fn((pidFile) => {
      if (pidFile === "a.pid") return 2001;
      if (pidFile === "b.pid") return 2002;
      return null;
    });
    const detectExistingMonitorLockOwner = makeDetectExistingMonitorLockOwner({
      getMonitorPidFileCandidates: () => ["a.pid", "b.pid"],
      readAlivePid,
      processPid: 9999,
    });

    expect(detectExistingMonitorLockOwner(2001)).toEqual({
      pid: 2002,
      pidFile: "b.pid",
    });
  });

  it("returns null when no live external owner exists", () => {
    const detectExistingMonitorLockOwner = makeDetectExistingMonitorLockOwner({
      getMonitorPidFileCandidates: () => ["a.pid", "b.pid"],
      readAlivePid: () => null,
      processPid: 7777,
    });

    expect(detectExistingMonitorLockOwner()).toBeNull();
  });

  it("logs and returns null when lock-owner inspection throws", () => {
    const warn = vi.fn();
    const detectExistingMonitorLockOwner = makeDetectExistingMonitorLockOwner({
      getMonitorPidFileCandidates: () => {
        throw new Error("scan failed");
      },
      readAlivePid: () => null,
      processPid: 7777,
      warn,
    });

    expect(detectExistingMonitorLockOwner()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      "failed to inspect existing monitor lock owner",
    );
  });

  it("integrates readAlivePid + detectExistingMonitorLockOwner for EPERM probes", () => {
    const isProcessAlive = compileFunction(cliSource, "isProcessAlive", {
      process: {
        kill: () => {
          const err = new Error("permission denied");
          err.code = "EPERM";
          throw err;
        },
      },
    });
    const readAlivePid = compileFunction(cliSource, "readAlivePid", {
      existsSync: () => true,
      readFileSync: () => "4455",
      isProcessAlive,
    });
    const detectExistingMonitorLockOwner = makeDetectExistingMonitorLockOwner({
      getMonitorPidFileCandidates: () => ["bosun.pid"],
      readAlivePid,
      processPid: 9999,
    });

    expect(detectExistingMonitorLockOwner()).toEqual({
      pid: 4455,
      pidFile: "bosun.pid",
    });
  });
});


describe("cli daemon restart-storm guard", () => {
  it("pauses auto-restart after threshold when persistent misconfiguration signals exist", () => {
    const shouldPauseDaemonRestartStorm = compileFunction(
      cliSource,
      "shouldPauseDaemonRestartStorm",
      {
        IS_DAEMON_CHILD: true,
        DAEMON_MISCONFIG_GUARD_ENABLED: true,
        DAEMON_MISCONFIG_GUARD_MIN_RESTARTS: 3,
        detectDaemonRestartStormSignals: () => ({
          hasSignal: true,
          reasons: ["missing_api_key", "duplicate_runtime"],
        }),
      },
    );

    expect(shouldPauseDaemonRestartStorm({ restartCount: 2 })).toEqual({
      pause: false,
      reasons: [],
    });
    expect(shouldPauseDaemonRestartStorm({ restartCount: 3 })).toEqual({
      pause: true,
      reasons: ["missing_api_key", "duplicate_runtime"],
    });
  });

  it("does not pause when guard is disabled or not daemon-child", () => {
    const detectStub = () => ({ hasSignal: true, reasons: ["missing_api_key"] });
    const disabledGuard = compileFunction(cliSource, "shouldPauseDaemonRestartStorm", {
      IS_DAEMON_CHILD: true,
      DAEMON_MISCONFIG_GUARD_ENABLED: false,
      DAEMON_MISCONFIG_GUARD_MIN_RESTARTS: 1,
      detectDaemonRestartStormSignals: detectStub,
    });
    const nonDaemon = compileFunction(cliSource, "shouldPauseDaemonRestartStorm", {
      IS_DAEMON_CHILD: false,
      DAEMON_MISCONFIG_GUARD_ENABLED: true,
      DAEMON_MISCONFIG_GUARD_MIN_RESTARTS: 1,
      detectDaemonRestartStormSignals: detectStub,
    });

    expect(disabledGuard({ restartCount: 10 })).toEqual({ pause: false, reasons: [] });
    expect(nonDaemon({ restartCount: 10 })).toEqual({ pause: false, reasons: [] });
  });

  it("detects known conflict and misconfiguration markers from recent monitor logs", () => {
    const detectDaemonRestartStormSignals = compileFunction(
      cliSource,
      "detectDaemonRestartStormSignals",
      {
        __dirname: "/repo",
        resolve: (...parts) => parts.join("/"),
        DAEMON_MISCONFIG_LOG_SCAN_LINES: 200,
        tailLinesFromFile: (filePath) => {
          if (filePath.endsWith("monitor-error.log")) {
            return [
              "[agent-pool] primary SDK \"codex\" missing prerequisites: no API key",
              "[task-claims] Shared state heartbeat FATAL for abc: owner_mismatch",
            ];
          }
          if (filePath.endsWith("monitor.log")) {
            return [
              "[monitor] another bosun instance holds the lock (PID 1234) — duplicate start ignored",
              "workspace sync sample: There is no tracking information for the current branch",
            ];
          }
          return [];
        },
      },
    );

    expect(detectDaemonRestartStormSignals()).toEqual({
      hasSignal: true,
      reasons: [
        "missing_api_key",
        "duplicate_runtime",
        "shared_state_owner_mismatch",
        "workspace_git_tracking_missing",
      ],
    });
  });
});
