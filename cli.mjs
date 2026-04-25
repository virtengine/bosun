#!/usr/bin/env node

/**
 * bosun — CLI Entry Point
 *
 * Usage:
 *   bosun                        # start with default config
 *   bosun --setup                # launch web setup wizard
 *   bosun --setup-terminal       # terminal setup wizard
 *   bosun --args "-MaxParallel 6" # pass orchestrator args
 *   bosun --help                 # show help
 *
 * The CLI handles:
 *   1. First-run detection → auto-launches setup wizard
 *   2. Command routing (setup, help, version, main start)
 *   3. Configuration loading from config.mjs
 */

import { isAbsolute, resolve, dirname } from "node:path";
import {
  existsSync,
  openSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  closeSync,
} from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { createDaemonCrashTracker } from "./infra/daemon-restart-policy.mjs";
import { ensureTestRuntimeSandbox } from "./infra/test-runtime.mjs";
import { followTextFile } from "./lib/log-tail.mjs";
import { safeBanner, BOX } from "./lib/safe-box.mjs";
import {
  applyAllCompatibility,
  detectLegacySetup,
  migrateFromLegacy,
} from "./compat.mjs";
import {
  resolveRepoLocalBosunDir,
  resolveRepoRoot,
  detectBosunModuleRoot,
} from "./config/repo-root.mjs";

const MONITOR_START_MAX_WAIT_MS = Math.max(
  0,
  Number(process.env.BOSUN_MONITOR_START_MAX_WAIT_MS || "15000") || 15000,
);
const MONITOR_START_RETRY_MS = Math.max(
  100,
  Number(process.env.BOSUN_MONITOR_START_RETRY_MS || "500") || 500,
);
const DAEMON_START_STABILITY_MS = Math.max(
  500,
  Number(process.env.BOSUN_DAEMON_START_STABILITY_MS || "8000") || 8000,
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function getArgValue(flag) {
  const match = args.find((arg) => arg.startsWith(`${flag}=`));
  if (match) {
    return match.slice(flag.length + 1).trim();
  }
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--")) {
    return args[idx + 1].trim();
  }
  return "";
}

// ── Version (read from package.json — single source of truth) ────────────────

const VERSION = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf8"),
).version;

// ── Help ─────────────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
  bosun v${VERSION}
  AI-powered orchestrator supervisor with executor failover, smart PR flow, and Telegram notifications.

  USAGE
    bosun [options]

  COMMANDS
    workflow list              List declarative pipeline workflows
    workflow run <name>        Run a declarative pipeline workflow
    workflow templates         List workflow-engine templates
    workflow template-run <id> Run a workflow-engine template directly
    simulate task [id|restart] Run the real task-lifecycle workflow
    workflow nodes             Inspect custom workflow node plugin health
    tui                        Launch the terminal UI
    audit <command>            Run codebase annotation audit tools (scan|generate|warn|manifest|index|trim|conformity|migrate)
    --setup                    Launch the web-based setup wizard (default)
    --setup-terminal            Run the legacy terminal setup wizard
    --where                     Show the resolved bosun config directory
    --doctor                    Validate bosun .env/config setup
    --tool-log <ID|list|prune>  Retrieve/list/prune cached tool outputs
    node:create <name>          Scaffold a custom workflow node in custom-nodes/
    --context-index [mode]      Run context index workflow (run|status|search|graph)
    --context-index-query <text> Query text for context index search mode
    --context-index-limit <n>   Max results for context index search (default: 25)
    --context-index-task-type <type> Task scope for search (auto|ci-cd|frontend|backend|infra|docs|security)
    --context-index-no-fallback Disable global fallback when scoped search is weak
    --help                      Show this help
    --version                   Show version
    --portal, --desktop         Launch the Bosun desktop portal (Electron)
    --desktop-shortcut          Create a desktop shortcut for the portal
    --desktop-shortcut-remove   Remove the desktop shortcut
    --desktop-shortcut-status   Show desktop shortcut status
    --update                    Check for and install latest version
    --no-update-check           Skip automatic update check on startup
    --no-auto-update            Disable background auto-update polling
    --daemon, -d                Run as a background daemon (detached, with PID file)
    --stop-daemon               Stop a running daemon process
    --terminate                 Hard-stop all bosun processes (daemon + monitor + companions)
    --daemon-status             Check if daemon is running

  ORCHESTRATOR
    --script <path>             Path to the orchestrator script
    --args "<args>"             Arguments passed to the script (default: "-MaxParallel 6")
    --restart-delay <ms>        Delay before restart (default: 180000)
    --max-restarts <n>          Max restarts, 0 = unlimited (default: 0)

  LOGGING
    --log-dir <path>            Log directory (default: ./logs)
    --echo-logs                 Echo raw orchestrator output to console (off by default)
    --quiet, -q                 Only show warnings and errors in terminal
    --verbose, -V               Show debug-level messages in terminal
    --trace                     Show all messages including trace-level
    --log-level <level>         Set explicit log level (trace|debug|info|warn|error|silent)

  AI / CODEX
    --no-codex                  Disable Codex SDK analysis
    --no-autofix                Disable automatic error fixing
    --primary-agent <name>      Override primary agent (codex|copilot|claude)
    --shell, --interactive      Enable interactive shell mode in monitor

  TELEGRAM
    --no-telegram-bot           Disable the interactive Telegram bot
    --telegram-commands         Enable monitor-side Telegram polling (advanced)

  WHATSAPP
    --whatsapp-auth             Run WhatsApp authentication (QR code mode)
    --whatsapp-auth --pairing-code  Authenticate via pairing code instead of QR

  CONTAINERS
    Container support is configured via environment variables:
      CONTAINER_ENABLED=1       Enable container isolation for agent execution
      CONTAINER_RUNTIME=docker  Runtime to use (docker|podman|container)

  WORKSPACES
    --workspace-list            List configured workspaces
    --workspace-add <name>      Create a new workspace
    --workspace-switch <id>     Switch active workspace
    --workspace-add-repo        Add repo to workspace (interactive)
    --workspace-health          Run workspace health diagnostics
    --workspace-pause <id>      Pause a workspace (no new workflows)
    --workspace-resume <id>     Resume a paused workspace
    --workspace-disable <id>    Disable a workspace entirely
    --workspace-status          Show state summary of all workspaces
    --workspace-executors <id>  Show/set executor config for workspace
                                  [--max-concurrent N] [--pool shared|dedicated] [--weight N]

  TASK MANAGEMENT
    task list [--status s] [--json]  List tasks with optional filters
    task create <json|flags>    Create a new task (flags or inline JSON)
    task get <id> [--json]      Show task details by ID (prefix match)
    task update <id> <patch>    Update task fields (JSON or flags)
    task delete <id>            Delete a task
    task stats [--json]         Show aggregate task statistics
    task import <file.json>     Bulk import tasks from JSON file

    Run 'bosun task --help' for complete task CLI documentation and examples.

  WORKFLOWS
    workflow list               List built-in and configured workflows
    workflow run <name>         Run a declarative fresh-context workflow
    workflow templates          List built-in workflow-engine templates
    workflow template-run <id>  Run a workflow-engine template directly
    simulate task [id|restart]  Run the real task lifecycle workflow

    Run 'bosun workflow --help' for workflow CLI examples.
    Run 'bosun tui' to launch the terminal UI.

  STARTUP SERVICE
    --enable-startup             Register bosun to auto-start on login
    --disable-startup           Remove bosun from startup services
    --startup-status            Check if startup service is installed

  SENTINEL
    --sentinel                  Start telegram-sentinel in companion mode
    --sentinel-stop             Stop a running sentinel
    --sentinel-status           Show sentinel status

  FILE WATCHING
    --no-watch                  Disable file watching for auto-restart
    --watch-path <path>         File to watch (default: script path)

  CONFIGURATION
    --config-dir <path>         Directory containing config files
    --repo-root <path>          Repository root (auto-detected)
    --project-name <name>       Project name for display
    --repo <org/repo>           GitHub repo slug
    --repo-name <name>          Select repository from multi-repo config
    --profile <name>            Environment profile selection
    --mode <name>               Override mode (virtengine/generic)

  ENVIRONMENT
    Configuration is loaded from (in priority order):
    1. CLI flags
    2. Environment variables
    3. .env file
    4. bosun.config.json
    5. Built-in defaults

    Auto-update environment variables:
      BOSUN_SKIP_UPDATE_CHECK=1     Disable startup version check
      BOSUN_SKIP_AUTO_UPDATE=1      Disable background polling
      BOSUN_UPDATE_INTERVAL_MS=N    Override poll interval (default: 600000)

    See .env.example for all environment variables.

  EXECUTOR CONFIG (bosun.config.json)
    {
      "projectName": "my-project",
      "executors": [
        { "name": "copilot-claude", "executor": "COPILOT", "variant": "CLAUDE_OPUS_4_6", "weight": 50, "role": "primary" },
        { "name": "codex-default", "executor": "CODEX", "variant": "DEFAULT", "weight": 50, "role": "backup" }
      ],
      "failover": {
        "strategy": "next-in-line",
        "maxRetries": 3,
        "cooldownMinutes": 5,
        "disableOnConsecutiveFailures": 3
      },
      "distribution": "weighted"
    }

  EXECUTOR ENV SHORTHAND
    EXECUTORS=COPILOT:CLAUDE_OPUS_4_6:50,CODEX:DEFAULT:50

  EXAMPLES
    bosun                                          # start with defaults
    bosun --setup                                  # web setup wizard
    bosun --setup-terminal                          # terminal setup wizard
    bosun --script ./my-orchestrator.sh             # custom script
    bosun --args "-MaxParallel 4" --no-telegram-bot # custom args
    bosun --no-codex --no-autofix                  # minimal mode

  DOCS
    https://www.npmjs.com/package/bosun
`);
}

function isWslInteropRuntime() {
  return Boolean(
    process.env.WSL_DISTRO_NAME ||
      process.env.WSL_INTEROP ||
      (process.platform === "win32" &&
        String(process.env.HOME || "")
          .trim()
          .startsWith("/home/")),
  );
}

function resolveRepoRootForCliRuntime(options = {}) {
  const repoRootArg = getArgValue("--repo-root");
  if (repoRootArg) return resolve(repoRootArg);
  if (process.env.REPO_ROOT) return resolve(process.env.REPO_ROOT);
  return resolveRepoRoot({ cwd: options.cwd || process.cwd() });
}

function resolveConfigDirForCli() {
  const configDirArg = getArgValue("--config-dir");
  if (configDirArg) return resolve(configDirArg);
  if (process.env.BOSUN_HOME) return resolve(process.env.BOSUN_HOME);
  if (process.env.BOSUN_DIR) return resolve(process.env.BOSUN_DIR);

  const repoRoot = resolveRepoRootForCliRuntime();
  const repoLocalConfigDir = resolveRepoLocalBosunDir(repoRoot);
  if (repoLocalConfigDir) return repoLocalConfigDir;

  // Fallback: check the bosun module's own directory for a .bosun/ config.
  // This ensures `bosun` (global) finds the same config as `npm start` which
  // explicitly passes `--config-dir .bosun`.  Without this, running `bosun`
  // from a directory outside the module (e.g. home dir) would miss workspace
  // config, .env vars (TELEGRAM_UI_PORT, etc.), and task store data.
  const moduleRoot = detectBosunModuleRoot();
  if (moduleRoot && resolve(moduleRoot) !== resolve(repoRoot || "")) {
    const moduleLocalConfigDir = resolveRepoLocalBosunDir(moduleRoot);
    if (moduleLocalConfigDir) return moduleLocalConfigDir;
  }

  const sandbox = ensureTestRuntimeSandbox();
  if (sandbox?.configDir) return sandbox.configDir;

  const preferWindowsDirs =
    process.platform === "win32" && !isWslInteropRuntime();
  const baseDir = preferWindowsDirs
    ? process.env.APPDATA ||
      process.env.LOCALAPPDATA ||
      process.env.USERPROFILE ||
      process.env.HOME ||
      process.cwd()
    : process.env.HOME ||
      process.env.XDG_CONFIG_HOME ||
      process.env.USERPROFILE ||
      process.env.APPDATA ||
      process.env.LOCALAPPDATA ||
      process.cwd();
  return resolve(baseDir, "bosun");
}

function printConfigLocations() {
  const configDir = resolveConfigDirForCli();
  const envPath = resolve(configDir, ".env");
  const configPath = resolve(configDir, "bosun.config.json");
  const workspacesPath = resolve(configDir, "workspaces");
  console.log("\n  Bosun config directory");
  console.log(`  ${configDir}`);
  console.log(`  .env: ${envPath}`);
  console.log(`  bosun.config.json: ${configPath}`);
  console.log(`  workspaces: ${workspacesPath}\n`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

// ── Daemon Mode ──────────────────────────────────────────────────────────────

const runtimeRepoRoot = resolveRepoRootForCliRuntime();
const runtimeCacheDir = resolve(runtimeRepoRoot, ".cache");
// Monitor singleton lock file (owned by monitor.mjs / maintenance.mjs).
const PID_FILE = resolve(runtimeCacheDir, "bosun.pid");
const LEGACY_MONITOR_PID_FILE = resolve(__dirname, ".cache", "bosun.pid");
// Daemon supervisor PID file (owned by cli.mjs --daemon-child).
const DAEMON_PID_FILE = resolve(runtimeCacheDir, "bosun-daemon.pid");
const LEGACY_DAEMON_PID_FILE = resolve(__dirname, ".cache", "bosun-daemon.pid");
const DAEMON_LOG = resolve(__dirname, "logs", "daemon.log");
const SENTINEL_PID_FILE = resolve(
  runtimeCacheDir,
  "telegram-sentinel.pid",
);
const SENTINEL_PID_FILE_LEGACY = resolve(
  __dirname,
  "..",
  "..",
  ".cache",
  "telegram-sentinel.pid",
);
const SENTINEL_PID_FILE_LEGACY_ALT = resolve(
  __dirname,
  ".cache",
  "telegram-sentinel.pid",
);
const SENTINEL_SCRIPT_PATH = fileURLToPath(
  new URL("./telegram/telegram-sentinel.mjs", import.meta.url),
);
const IS_DAEMON_CHILD =
  args.includes("--daemon-child") || process.env.BOSUN_DAEMON === "1";
let daemonInlineSupervisorActive = false;
let daemonPidCleanupInstalled = false;
const DAEMON_RESTART_DELAY_MS = Math.max(
  1000,
  Number(process.env.BOSUN_DAEMON_RESTART_DELAY_MS || 5000) || 5000,
);
const DAEMON_MAX_RESTART_DELAY_MS = Math.max(
  DAEMON_RESTART_DELAY_MS,
  Number(process.env.BOSUN_DAEMON_MAX_RESTART_DELAY_MS || 120000) || 120000,
);
const DAEMON_MAX_RESTARTS = Math.max(
  0,
  Number(process.env.BOSUN_DAEMON_MAX_RESTARTS || 25) || 25,
);
const DAEMON_INSTANT_CRASH_WINDOW_MS = Math.max(
  1000,
  Number(process.env.BOSUN_DAEMON_INSTANT_CRASH_WINDOW_MS || 60000) ||
    60000,
);
const DAEMON_MAX_INSTANT_RESTARTS = Math.max(
  1,
  Number(process.env.BOSUN_DAEMON_MAX_INSTANT_RESTARTS || 5) || 5,
);
const DAEMON_MISCONFIG_GUARD_ENABLED = !["0", "false", "off", "no"].includes(
  String(process.env.BOSUN_DAEMON_MISCONFIG_GUARD || "1")
    .trim()
    .toLowerCase(),
);
const DAEMON_MISCONFIG_GUARD_MIN_RESTARTS = Math.max(
  1,
  Number(process.env.BOSUN_DAEMON_MISCONFIG_GUARD_MIN_RESTARTS || 3) || 3,
);
const DAEMON_MISCONFIG_LOG_SCAN_LINES = Math.max(
  20,
  Number(process.env.BOSUN_DAEMON_MISCONFIG_LOG_SCAN_LINES || 250) || 250,
);
let daemonRestartCount = 0;
const daemonCrashTracker = createDaemonCrashTracker({
  instantCrashWindowMs: DAEMON_INSTANT_CRASH_WINDOW_MS,
  maxInstantCrashes: DAEMON_MAX_INSTANT_RESTARTS,
});

function uniqueResolvedPaths(paths) {
  const seen = new Set();
  const results = [];
  for (const entry of paths) {
    if (!entry) continue;
    const normalized = resolve(entry);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    results.push(normalized);
  }
  return results;
}

function getWorkspaceScopedCacheDirCandidate(repoRootPath) {
  const bosunDir = process.env.BOSUN_DIR || resolveConfigDirForCli();
  if (!bosunDir || !repoRootPath) return null;
  const parts = String(repoRootPath).replace(/\\/g, "/").split("/").filter(Boolean);
  const repoName = parts.at(-1);
  const workspaceName = parts.at(-2);
  if (!repoName || !workspaceName) return null;
  return resolve(bosunDir, "workspaces", workspaceName, repoName, ".cache");
}

function getRuntimeCacheDirCandidates(extraCacheDirs = []) {
  return uniqueResolvedPaths([
    ...extraCacheDirs,
    runtimeCacheDir,
    getWorkspaceScopedCacheDirCandidate(runtimeRepoRoot),
    process.env.BOSUN_DIR ? resolve(process.env.BOSUN_DIR, ".cache") : null,
    resolve(__dirname, ".cache"),
    resolve(process.cwd(), ".cache"),
  ]);
}

async function getConfiguredRuntimeCacheDirs() {
  try {
    const { loadConfig } = await import("./config/config.mjs");
    const config = loadConfig();
    return getRuntimeCacheDirCandidates([
      String(config?.cacheDir || "").trim() || null,
    ]);
  } catch {
    return getRuntimeCacheDirCandidates();
  }
}

function getPidFileCandidates(fileName, extraCacheDirs = []) {
  return getRuntimeCacheDirCandidates(extraCacheDirs).map((cacheDir) =>
    resolve(cacheDir, fileName),
  );
}

function waitForPidsToExit(pids, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let alive = pids.filter((pid) => isProcessAlive(pid));
  while (alive.length > 0 && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    alive = alive.filter((pid) => isProcessAlive(pid));
  }
  return alive;
}

function getSentinelRecoveryStateCandidates(extraCacheDirs = []) {
  return getRuntimeCacheDirCandidates(extraCacheDirs).map((cacheDir) =>
    resolve(cacheDir, "sentinel-monitor-recovery.json"),
  );
}

function writeSentinelManualStopHold(extraCacheDirs = [], holdMs = 0) {
  const holdUntil = Date.now() + Math.max(0, holdMs);
  for (const stateFile of getSentinelRecoveryStateCandidates(extraCacheDirs)) {
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      let existing = {};
      if (existsSync(stateFile)) {
        try {
          existing = JSON.parse(readFileSync(stateFile, "utf8"));
        } catch {
          existing = {};
        }
      }
      writeFileSync(
        stateFile,
        JSON.stringify(
          {
            ...existing,
            monitorManualStopUntil: holdUntil,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );
    } catch {
      /* best effort */
    }
  }
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && (err.code === "EPERM" || err.code === "EACCES")) {
      return true;
    }
    return false;
  }
}

function readAlivePid(pidFile) {
  try {
    if (!existsSync(pidFile)) return null;
    const raw = readFileSync(pidFile, "utf8").trim();
    if (!raw) return null;

    let pid = Number(raw);
    if ((!Number.isFinite(pid) || pid <= 0) && raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw);
        // Accept legacy/new payload variants while staying strict on pid validity.
        pid = Number(
          parsed?.pid ??
            parsed?.processId ??
            parsed?.ownerPid ??
            parsed?.process?.pid,
        );
      } catch {
        return null;
      }
    }

    if (!Number.isFinite(pid) || pid <= 0) return null;
    return isProcessAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function parseBoolEnv(val, fallback = false) {
  if (val == null || String(val).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(val).toLowerCase());
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function readSentinelPid() {
  return (
    readAlivePid(SENTINEL_PID_FILE) ||
    readAlivePid(SENTINEL_PID_FILE_LEGACY) ||
    readAlivePid(SENTINEL_PID_FILE_LEGACY_ALT)
  );
}

async function runSentinelCli(flag) {
  return await new Promise((resolveExit) => {
    const child = spawn(process.execPath, [SENTINEL_SCRIPT_PATH, flag], {
      stdio: "inherit",
      env: { ...process.env },
      cwd: process.cwd(),
    });
    child.on("error", () => resolveExit(1));
    child.on("exit", (code) => resolveExit(code ?? 1));
  });
}

async function ensureSentinelRunning(options = {}) {
  const { quiet = false } = options;
  const existing = readSentinelPid();
  if (existing) {
    if (!quiet) {
      console.log(`  telegram-sentinel already running (PID ${existing})`);
    }
    return { ok: true, pid: existing, alreadyRunning: true };
  }

  const child = spawn(process.execPath, [SENTINEL_SCRIPT_PATH], {
    detached: true,
    stdio: "ignore",
    windowsHide: process.platform === "win32",
    env: {
      ...process.env,
      BOSUN_SENTINEL_COMPANION: "1",
    },
    cwd: process.cwd(),
  });
  child.unref();

  const spawnedPid = child.pid;
  if (!spawnedPid) {
    return { ok: false, error: "sentinel spawn returned no PID" };
  }

  const timeoutAt = Date.now() + 5000;
  while (Date.now() < timeoutAt) {
    await sleep(200);
    const pid = readSentinelPid();
    if (pid) {
      if (!quiet) {
        console.log(`  telegram-sentinel started (PID ${pid})`);
      }
      return { ok: true, pid, alreadyRunning: false };
    }
    if (!isProcessAlive(spawnedPid)) {
      return {
        ok: false,
        error: "telegram-sentinel exited during startup",
      };
    }
  }

  return {
    ok: false,
    error: "timed out waiting for telegram-sentinel to become healthy",
  };
}

function getDaemonPid() {
  const tracked =
    readAlivePid(DAEMON_PID_FILE) || readAlivePid(LEGACY_DAEMON_PID_FILE);
  if (tracked) return tracked;

  // Legacy fallback: older versions stored daemon PID in bosun.pid
  // as a plain number before monitor lock payloads were JSON.
  try {
    if (!existsSync(PID_FILE)) return null;
    const raw = String(readFileSync(PID_FILE, "utf8") || "").trim();
    if (!/^\d+$/.test(raw)) return null;
    const legacyPid = Number(raw);
    return isProcessAlive(legacyPid) ? legacyPid : null;
  } catch {
    return null;
  }
}

/**
 * Scan for ghost bosun daemon-child processes that are alive but have no PID
 * file (e.g. PID file was removed by compat migration). Uses pgrep on Linux/Mac.
 * Returns an array of PIDs (may be empty).
 */
function findGhostDaemonPids() {
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|electron)(\\.exe)?$' -and $_.CommandLine -match 'cli\\.mjs' -and $_.CommandLine -match '--daemon-child' } | Select-Object -ExpandProperty ProcessId",
        ],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 },
      ).trim();
      if (!out) return [];
      return out
        .split(/\r?\n/)
        .map((s) => parseInt(String(s).trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
    } catch {
      return [];
    }
  }
  try {
    const out = execFileSync(
      "pgrep",
      ["-f", "bosun.*--daemon-child|cli\.mjs.*--daemon-child"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 },
    ).trim();
    return out
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
  } catch {
    return [];
  }
}

function findGhostSentinelPids() {
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|electron)(\\.exe)?$' -and $_.CommandLine -match 'telegram-sentinel\\.mjs' } | Select-Object -ExpandProperty ProcessId",
        ],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 },
      ).trim();
      if (!out) return [];
      return out
        .split(/\r?\n/)
        .map((s) => parseInt(String(s).trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
    } catch {
      return [];
    }
  }
  try {
    const out = execFileSync(
      "pgrep",
      ["-f", "telegram-sentinel\\.mjs"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 },
    ).trim();
    return out
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
  } catch {
    return [];
  }
}

function writePidFile(pid) {
  try {
    mkdirSync(dirname(DAEMON_PID_FILE), { recursive: true });
    writeFileSync(DAEMON_PID_FILE, String(pid), "utf8");
  } catch {
    /* best effort */
  }
}

function removePidFile() {
  try {
    if (existsSync(DAEMON_PID_FILE)) unlinkSync(DAEMON_PID_FILE);
    if (existsSync(LEGACY_DAEMON_PID_FILE)) unlinkSync(LEGACY_DAEMON_PID_FILE);
  } catch {
    /* ok */
  }
}

function isDaemonSupervisorRuntime() {
  return IS_DAEMON_CHILD || daemonInlineSupervisorActive;
}

function installDaemonPidCleanup() {
  if (daemonPidCleanupInstalled) return;
  daemonPidCleanupInstalled = true;
  process.on("exit", () => {
    if (!isDaemonSupervisorRuntime()) return;
    removePidFile();
  });
}

function absolutizeDaemonArgPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return raw;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

function normalizeDetachedDaemonArgs(rawArgs = []) {
  const normalized = Array.isArray(rawArgs) ? [...rawArgs] : [];
  const pathFlags = new Set(["--config-dir", "--repo-root", "--log-dir"]);
  for (let i = 0; i < normalized.length; i += 1) {
    const arg = String(normalized[i] || "").trim();
    if (!arg.startsWith("--")) continue;

    const eq = arg.indexOf("=");
    if (eq > 0) {
      const flag = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      if (pathFlags.has(flag)) {
        normalized[i] = flag + "=" + absolutizeDaemonArgPath(value);
      }
      continue;
    }

    if (pathFlags.has(arg) && i + 1 < normalized.length) {
      const value = String(normalized[i + 1] || "").trim();
      if (value && !value.startsWith("--")) {
        normalized[i + 1] = absolutizeDaemonArgPath(value);
        i += 1;
      }
    }
  }
  return normalized;
}

function resolveDetachedDaemonEnvOverrides() {
  const explicitRepoRoot = getArgValue("--repo-root");
  return {
    BOSUN_DAEMON: "1",
    BOSUN_DIR: process.env.BOSUN_DIR || resolveConfigDirForCli(),
    ...(process.env.REPO_ROOT
      ? { REPO_ROOT: resolve(process.env.REPO_ROOT) }
      : explicitRepoRoot
        ? { REPO_ROOT: resolve(explicitRepoRoot) }
      : (() => {
          try {
            const gitRoot = execSync("git rev-parse --show-toplevel", {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            }).trim();
            return gitRoot ? { REPO_ROOT: gitRoot } : {};
          } catch {
            return {};
          }
        })()),
  };
}

function buildDetachedDaemonLaunchSpec() {
  const runAsNode = process.versions?.electron ? ["--run-as-node"] : [];
  return {
    filePath: process.execPath,
    args: [
      ...runAsNode,
      "--max-old-space-size=4096",
      fileURLToPath(new URL("./cli.mjs", import.meta.url)),
      ...normalizeDetachedDaemonArgs(
        process.argv.slice(2).filter((a) => a !== "--daemon" && a !== "-d"),
      ),
      "--daemon-child",
    ],
    env: {
      ...process.env,
      ...resolveDetachedDaemonEnvOverrides(),
    },
    cwd: os.homedir(),
  };
}

function buildDetachedMonitorLaunchSpec() {
  const runAsNode = process.versions?.electron ? ["--run-as-node"] : [];
  return {
    filePath: process.execPath,
    args: [
      ...runAsNode,
      "--max-old-space-size=4096",
      fileURLToPath(new URL("./infra/monitor.mjs", import.meta.url)),
      ...normalizeDetachedDaemonArgs(
        process.argv.slice(2).filter(
          (a) => a !== "--daemon" && a !== "-d" && a !== "--daemon-child",
        ),
      ),
    ],
    env: {
      ...process.env,
      BOSUN_DAEMON: "1",
      BOSUN_DIR: process.env.BOSUN_DIR || resolveConfigDirForCli(),
      ...(process.env.REPO_ROOT
        ? { REPO_ROOT: resolve(process.env.REPO_ROOT) }
        : getArgValue("--repo-root")
          ? { REPO_ROOT: resolve(getArgValue("--repo-root")) }
          : {}),
    },
    cwd: os.homedir(),
  };
}

function escapePowerShellSingleQuoted(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function waitForTrackedDaemonPid(timeoutMs = 4000) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() <= deadline) {
    const pid = getDaemonPid();
    if (pid) return pid;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return null;
}

function startDaemonViaWindowsStartProcess(launchSpec) {
  const envAssignments = Object.entries(launchSpec.env || {})
    .filter(([key, value]) => {
      if (value === undefined) return false;
      return process.env[key] !== String(value);
    })
    .map(
      ([key, value]) =>
        `Set-Item -LiteralPath ${escapePowerShellSingleQuoted(`Env:${key}`)} -Value ${escapePowerShellSingleQuoted(String(value))};`,
    )
    .join(" ");
  const argumentList = launchSpec.args
    .map((arg) => escapePowerShellSingleQuoted(String(arg)))
    .join(", ");
  const command = [
    envAssignments,
    `$process = Start-Process -FilePath ${escapePowerShellSingleQuoted(launchSpec.filePath)}`,
    `-ArgumentList @(${argumentList})`,
    `-WorkingDirectory ${escapePowerShellSingleQuoted(launchSpec.cwd)}`,
    "-WindowStyle Hidden -PassThru;",
    "[Console]::Out.Write($process.Id)",
  ].join(" ");
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
      windowsHide: true,
    },
  ).trim();
  const pid = Number.parseInt(output, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(`Start-Process did not return a daemon PID (output: ${output || "empty"})`);
  }
  return pid;
}

async function startDaemon() {
  const existing = getDaemonPid();
  if (existing) {
    console.log(`  bosun daemon is already running (PID ${existing})`);
    console.log(`  Use --stop-daemon to stop it first.`);
    process.exit(1);
  }

  // Check for ghost processes that have no PID file (e.g. after compat migration
  // deleted the old codex-monitor directory and its PID file with it).
  const ghosts = findGhostDaemonPids();
  if (ghosts.length > 0) {
    console.log(`  :alert:  Found ${ghosts.length} ghost bosun daemon process(es) with no PID file: ${ghosts.join(", ")}`);
    console.log(`  Stopping ghost process(es) before starting fresh...`);
    for (const gpid of ghosts) {
      try { process.kill(gpid, "SIGTERM"); } catch { /* already dead */ }
    }
    // Give them a moment to exit
    const deadline = Date.now() + 3000;
    let alive = ghosts.filter((p) => isProcessAlive(p));
    while (alive.length > 0 && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      alive = alive.filter((p) => isProcessAlive(p));
    }
    for (const gpid of alive) {
      try { process.kill(gpid, "SIGKILL"); } catch { /* ok */ }
    }
    console.log(`  :check: Ghost process(es) stopped.`);
  }

  // Ensure log directory exists
  try {
    mkdirSync(dirname(DAEMON_LOG), { recursive: true });
  } catch {
    /* ok */
  }

  const launchPreflight =
    process.platform === "win32" ? checkPipedChildProcessLaunch() : { ok: true, code: null };
  const shouldInlineFallback =
    process.platform === "win32" &&
    launchPreflight?.ok === false &&
    ["EPERM", "EACCES"].includes(String(launchPreflight?.code || "").trim().toUpperCase());
  if (shouldInlineFallback) {
    daemonInlineSupervisorActive = true;
    installDaemonPidCleanup();
    writePidFile(process.pid);
    console.warn(
      `\n  [cli] daemon detached startup is unavailable on this Windows host (${launchPreflight.code}); running Bosun inline in the current process instead`,
    );
    console.log(`
${safeBanner([`bosun daemon fallback active (PID ${process.pid})`])}

  Mode: inline supervisor fallback
  Logs: ${DAEMON_LOG}
  PID:  ${DAEMON_PID_FILE}

  Commands:
    bosun --daemon-status   Check if running
    bosun --stop-daemon     Stop the daemon
    bosun --echo-logs       Tail live logs
  `);
    await runMonitor({ restartReason: "daemon-inline-fallback" });
    return;
  }

  const launchSpec = buildDetachedDaemonLaunchSpec();
  let daemonPid = null;
  let child = null;
  let daemonLogFd = null;
  const preferWindowsStartProcess = process.platform === "win32";
  let usedDirectMonitorFallback = false;
  const closeDaemonLogFd = () => {
    if (daemonLogFd == null) return;
    try {
      closeSync(daemonLogFd);
    } catch {
      /* best effort */
    }
    daemonLogFd = null;
  };
  const startDetachedMonitorFallback = () => {
    if (usedDirectMonitorFallback || process.platform !== "win32") return null;
    usedDirectMonitorFallback = true;
    closeDaemonLogFd();
    const monitorLaunchSpec = buildDetachedMonitorLaunchSpec();
    console.warn(
      "\n  [cli] daemon-child detached startup was not durable; falling back to direct detached monitor process",
    );
    const monitorPid = startDaemonViaWindowsStartProcess(monitorLaunchSpec);
    const stabilityDeadline = Date.now() + DAEMON_START_STABILITY_MS;
    while (Date.now() < stabilityDeadline) {
      if (!isProcessAlive(monitorPid)) {
        throw new Error(
          "Detached direct monitor exited during startup stability window; Windows child-process policy is preventing a durable Bosun background start in this runtime.",
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
    if (!isProcessAlive(monitorPid)) {
      throw new Error(
        "Detached direct monitor exited during startup stability window; Windows child-process policy is preventing a durable Bosun background start in this runtime.",
      );
    }
    writePidFile(monitorPid);
    return monitorPid;
  };
  try {
    daemonLogFd = openSync(DAEMON_LOG, "a");
  } catch {
    daemonLogFd = null;
  }
  try {
    if (preferWindowsStartProcess) {
      closeDaemonLogFd();
      console.warn(
        "\n  [cli] using PowerShell Start-Process for durable Windows daemon detachment",
      );
      daemonPid = startDaemonViaWindowsStartProcess(launchSpec);
    } else {
      child = spawn(
        launchSpec.filePath,
        launchSpec.args,
        {
          detached: true,
          stdio:
            daemonLogFd == null ? "ignore" : ["ignore", daemonLogFd, daemonLogFd],
          windowsHide: process.platform === "win32",
          env: {
            ...launchSpec.env,
            ...(daemonLogFd == null
              ? {}
              : { BOSUN_DAEMON_STDIO_REDIRECTED: "1" }),
          },
          // Use home dir so spawn never inherits a deleted CWD (e.g. old git worktree)
          cwd: launchSpec.cwd,
        },
      );
      child.unref();
      daemonPid = child.pid;
    }
  } catch (error) {
    closeDaemonLogFd();
    const canUseWindowsStartProcess =
      process.platform === "win32" && error?.code === "EPERM";
    if (!canUseWindowsStartProcess) throw error;
    console.warn(
      "\n  [cli] detached daemon spawn hit EPERM; launching daemon via PowerShell Start-Process for stable Windows detachment",
    );
    daemonPid = startDaemonViaWindowsStartProcess(launchSpec);
  }
  const trackedPid = waitForTrackedDaemonPid();
  if (trackedPid) {
    daemonPid = trackedPid;
  } else if (!isProcessAlive(daemonPid)) {
    const fallbackPid = startDetachedMonitorFallback();
    if (fallbackPid) {
      daemonPid = fallbackPid;
    } else {
      closeDaemonLogFd();
      throw new Error("Detached daemon exited before writing its PID file");
    }
  }
  const stabilityDeadline = Date.now() + DAEMON_START_STABILITY_MS;
  while (Date.now() < stabilityDeadline) {
    if (!isProcessAlive(daemonPid)) {
      const fallbackPid = startDetachedMonitorFallback();
      if (fallbackPid) {
        daemonPid = fallbackPid;
        break;
      }
      closeDaemonLogFd();
      throw new Error(
        "Detached daemon exited during startup stability window; Windows child-process policy is preventing a durable daemon start in this runtime.",
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  if (!isProcessAlive(daemonPid)) {
    const fallbackPid = startDetachedMonitorFallback();
    if (fallbackPid) {
      daemonPid = fallbackPid;
    } else {
      closeDaemonLogFd();
      throw new Error(
        "Detached daemon exited during startup stability window; Windows child-process policy is preventing a durable daemon start in this runtime.",
      );
    }
  }
  closeDaemonLogFd();

  console.log(`
${safeBanner([`bosun daemon started (PID ${daemonPid})`])}

  Logs: ${DAEMON_LOG}
  PID:  ${DAEMON_PID_FILE}

  Commands:
    bosun --daemon-status   Check if running
    bosun --stop-daemon     Stop the daemon
    bosun --echo-logs       Tail live logs
  `);
  process.exit(0);
}

function stopDaemon() {
  const pid = getDaemonPid();
  if (!pid) {
    const ghosts = findGhostDaemonPids();
    if (ghosts.length === 0) {
      console.log("  No daemon running (PID file not found or process dead).");
      removePidFile();
      process.exit(0);
      return;
    }
    console.log(
      `  Found ${ghosts.length} untracked daemon process(es): ${ghosts.join(", ")}`,
    );
    for (const gpid of ghosts) {
      try {
        process.kill(gpid, "SIGTERM");
      } catch {
        /* already dead */
      }
    }
    setTimeout(() => {
      for (const gpid of ghosts) {
        if (!isProcessAlive(gpid)) continue;
        try {
          process.kill(gpid, "SIGKILL");
        } catch {
          /* already dead */
        }
      }
      removePidFile();
      console.log("  ✓ Untracked daemon process(es) stopped.");
      process.exit(0);
    }, 1200);
    return;
  }
  console.log(`  Stopping bosun daemon (PID ${pid})...`);
  try {
    process.kill(pid, "SIGTERM");
    // Wait briefly for graceful shutdown
    let tries = 0;
    const check = () => {
      try {
        process.kill(pid, 0);
      } catch {
        removePidFile();
        console.log("  ✓ Daemon stopped.");
        process.exit(0);
      }
      if (++tries > 10) {
        console.log("  Sending SIGKILL...");
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* ok */
        }
        removePidFile();
        console.log("  ✓ Daemon killed.");
        process.exit(0);
      }
      setTimeout(check, 500);
    };
    setTimeout(check, 500);
  } catch (err) {
    console.error(`  Failed to stop daemon: ${err.message}`);
    removePidFile();
    process.exit(1);
  }
}

async function daemonStatus() {
  const pid = getDaemonPid();
  if (pid) {
    console.log(`  bosun daemon is running (PID ${pid})`);
  } else {
    // Check for ghost daemon-child processes (alive but no PID file)
    const ghosts = findGhostDaemonPids();
    const ghostSentinels = findGhostSentinelPids();
    if (ghosts.length > 0) {
      console.log(`  :alert:  bosun daemon is NOT tracked (no PID file), but ${ghosts.length} ghost process(es) found: ${ghosts.join(", ")}`);
      console.log(`  The daemon is likely running but its PID file was lost.`);
      if (ghostSentinels.length > 0) {
        console.log(`  Ghost sentinel restart owner(s) detected: ${ghostSentinels.join(", ")}`);
      }
      console.log(`  Run --terminate to stop restart owners, then --daemon to restart.`);
    } else {
      const configuredCacheDirs = await getConfiguredRuntimeCacheDirs();
      const existingMonitorOwner = detectExistingMonitorLockOwner(null, configuredCacheDirs);
      if (existingMonitorOwner) {
        console.log(
          `  bosun daemon is not running in daemon mode, but bosun monitor is active (PID ${existingMonitorOwner.pid}).`,
        );
        console.log(
          `  Bosun is running in monitor mode with lock file ${existingMonitorOwner.pidFile}.`,
        );
        console.log(
          `  Use 'bosun --terminate' to stop it, or 'bosun --daemon' only after it is fully stopped.`,
        );
        process.exit(0);
      }
      // Broader scan: portal, monitor, ui-server, etc. (non-daemon bosun processes)
      const allPids = findAllBosunProcessPids();
      if (allPids.length > 0) {
        console.log(`  bosun daemon is not running in daemon mode, but ${allPids.length} bosun process(es) are active (PID ${allPids.join(", ")}).`);
        console.log(`  Bosun may be running in portal or monitor mode (not as a background daemon).`);
        console.log(`  Use 'bosun --stop' to terminate all processes, or 'bosun --daemon' to start the daemon.`);
      } else {
        console.log("  bosun daemon is not running.");
        removePidFile();
      }
    }
  }
  process.exit(0);
}

function findAllBosunProcessPids() {
  // Match both direct script launches and global shim invocations (e.g. `bosun`,
  // `bosun --portal`) so terminate can find non-daemon instances too.
  const patterns = [
    "node_modules\\\\bosun",
    "cli.mjs",
    "monitor.mjs",
    "telegram-bot.mjs",
    "telegram-sentinel.mjs",
    "ui-server.mjs",
    "--portal",
    "--desktop",
  ];
  const joined = patterns.join("|");
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process | Where-Object {
             $name = [string]$_.Name
             $cmd = [string]$_.CommandLine
             $exe = [string]$_.ExecutablePath
             $pid = [int]$_.ProcessId
             $isBosunHost = $name -match '^(node|electron|bosun)(\\.exe)?$'
             $isBosunCmd = $cmd -match '${joined}'
             $isBosunExe = $exe -match 'bosun'
             $pid -ne ${process.pid} -and $isBosunHost -and ($isBosunCmd -or $isBosunExe)
           } | Select-Object -ExpandProperty ProcessId`,
        ],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 4000 },
      ).trim();
      if (!out) return [];
      return out
        .split(/\r?\n/)
        .map((s) => Number.parseInt(String(s).trim(), 10))
        .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
    } catch {
      return [];
    }
  }
  try {
    const out = execFileSync("pgrep", ["-f", joined], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 4000,
    }).trim();
    if (!out) return [];
    return out
      .split(/\r?\n/)
      .map((s) => Number.parseInt(String(s).trim(), 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

function getRunningDaemonPids() {
  const trackedDaemonPid = getDaemonPid();
  if (trackedDaemonPid) return [trackedDaemonPid];
  const ghostPids = findGhostDaemonPids();
  return ghostPids.length > 0 ? ghostPids : [];
}

function stopBosunProcesses(
  pids,
  { reason = null, timeoutMs = 5000 } = {},
) {
  const targets = Array.from(
    new Set(
      (Array.isArray(pids) ? pids : []).filter(
        (pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid,
      ),
    ),
  );
  if (targets.length === 0) return [];
  if (reason) {
    console.log(`  ${reason}: ${targets.join(", ")}`);
  }
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already dead */
    }
  }
  const alive = waitForPidsToExit(targets, timeoutMs);
  for (const pid of alive) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
  return targets;
}

function removeKnownPidFiles(extraCacheDirs = []) {
  const pidFiles = uniqueResolvedPaths([
    ...getPidFileCandidates("bosun-daemon.pid", extraCacheDirs),
    ...getMonitorPidFileCandidates(extraCacheDirs),
    ...getPidFileCandidates("telegram-sentinel.pid", extraCacheDirs),
    LEGACY_DAEMON_PID_FILE,
    LEGACY_MONITOR_PID_FILE,
    SENTINEL_PID_FILE_LEGACY,
    SENTINEL_PID_FILE_LEGACY_ALT,
    resolve(__dirname, "..", ".cache", "bosun.pid"),
  ]);
  for (const pidFile of pidFiles) {
    try {
      if (existsSync(pidFile)) unlinkSync(pidFile);
    } catch {
      /* best effort */
    }
  }
}

function taskkillPid(pid, { force = false } = {}) {
  if (process.platform !== "win32") return false;
  try {
    const args = ["/PID", String(pid)];
    if (force) args.push("/F");
    execFileSync("taskkill", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      windowsHide: true,
    });
    return true;
  } catch (err) {
    const detail = String(
      err?.stderr || err?.stdout || err?.message || "taskkill failed",
    ).toLowerCase();
    if (
      detail.includes("no running instance") ||
      detail.includes("not found") ||
      detail.includes("not exist")
    ) {
      return true;
    }
    return false;
  }
}

function taskkillPidsElevated(pids, { force = false } = {}) {
  if (process.platform !== "win32" || pids.length === 0) return false;
  try {
    const args = [];
    for (const pid of pids) {
      args.push("/PID", String(pid));
    }
    if (force) args.push("/F");
    const quotedArgs = args.map((arg) => `'${String(arg).replace(/'/g, "''")}'`);
    const command =
      "Start-Process -FilePath taskkill.exe -ArgumentList " +
      quotedArgs.join(",") +
      " -Verb RunAs -Wait -WindowStyle Hidden";
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", command],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
        windowsHide: false,
      },
    );
  } catch {
    /* best effort */
  }
  return pids.every((pid) => !isProcessAlive(pid));
}

function findWindowsManagedAncestorPids(seedPids, maxDepth = 2) {
  if (process.platform !== "win32" || seedPids.length === 0) return [];
  const uniquePids = Array.from(new Set(seedPids)).filter(
    (pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid,
  );
  if (uniquePids.length === 0) return [];
  try {
    const command = [
      `$targets = @(${uniquePids.join(",")})`,
      "$seen = New-Object 'System.Collections.Generic.HashSet[int]'",
      "foreach ($target in $targets) {",
      `  $depth = 0`,
      "  $current = Get-CimInstance Win32_Process -Filter \"ProcessId = $target\" -ErrorAction SilentlyContinue",
      `  while ($current -and $depth -lt ${Math.max(1, maxDepth)}) {`,
      "    $parentPid = [int]$current.ParentProcessId",
      "    if ($parentPid -le 0) { break }",
      "    $parent = Get-CimInstance Win32_Process -Filter \"ProcessId = $parentPid\" -ErrorAction SilentlyContinue",
      "    if (-not $parent) { break }",
      "    if ([string]$parent.Name -notmatch '^(node|electron|bosun)(\\.exe)?$') { break }",
      "    if ($seen.Add($parentPid)) { Write-Output $parentPid }",
      "    $current = $parent",
      "    $depth += 1",
      "  }",
      "}",
    ].join("; ");
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", command],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 },
    ).trim();
    if (!out) return [];
    return out
      .split(/\r?\n/)
      .map((line) => Number.parseInt(String(line).trim(), 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

async function terminateBosun() {
  const configuredCacheDirs = await getConfiguredRuntimeCacheDirs();
  const daemonPids = [
    getDaemonPid(),
    ...getPidFileCandidates("bosun-daemon.pid", configuredCacheDirs).map(
      (pidFile) => readAlivePid(pidFile),
    ),
  ].filter((pid) => Number.isFinite(pid) && pid > 0);
  const monitorPids = [
    ...getMonitorPidFileCandidates(configuredCacheDirs).map((pidFile) =>
      readAlivePid(pidFile),
    ),
  ].filter((pid) => Number.isFinite(pid) && pid > 0);
  const sentinelPids = [
    ...uniqueResolvedPaths([
      ...getPidFileCandidates("telegram-sentinel.pid", configuredCacheDirs),
      SENTINEL_PID_FILE_LEGACY,
      SENTINEL_PID_FILE_LEGACY_ALT,
    ]).map((pidFile) => readAlivePid(pidFile)),
    readSentinelPid(),
  ].filter((pid) => Number.isFinite(pid) && pid > 0);
  const sentinelGhostPids = findGhostSentinelPids();
  const manualStopHoldMs =
    Math.max(
      0,
      Number(process.env.SENTINEL_MANUAL_STOP_HOLD_MIN || "10") || 10,
    ) * 60_000;
  writeSentinelManualStopHold(configuredCacheDirs, manualStopHoldMs);
  const ghosts = findGhostDaemonPids();
  const ancestorPids = findWindowsManagedAncestorPids([
    ...daemonPids,
    ...monitorPids,
    ...sentinelPids,
    ...sentinelGhostPids,
    ...ghosts,
  ]);
  const restartOwnerPids = Array.from(
    new Set([
      ...ancestorPids,
      ...sentinelPids,
      ...sentinelGhostPids,
      ...daemonPids,
      ...ghosts,
    ]),
  ).filter((pid) => pid !== process.pid);
  const tracked = [...restartOwnerPids, ...monitorPids];
  const trackedPids = Array.from(new Set([...tracked, ...ghosts])).filter(
    (pid) => pid !== process.pid,
  );
  const scanned =
    trackedPids.length === 0 && process.platform !== "win32"
      ? findAllBosunProcessPids()
      : [];
  const allPids = Array.from(new Set([...trackedPids, ...scanned])).filter(
    (pid) => pid !== process.pid,
  );
  if (allPids.length === 0) {
    removeKnownPidFiles(configuredCacheDirs);
    console.log("  No running bosun processes found.");
    process.exit(0);
    return;
  }

  console.log(`  Terminating ${allPids.length} bosun process(es): ${allPids.join(", ")}`);
  for (const pid of restartOwnerPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already dead */
    }
  }

  let alive = waitForPidsToExit(restartOwnerPids, 1500);
  if (process.platform === "win32" && alive.length > 0) {
    for (const pid of alive) {
      taskkillPid(pid);
    }
    alive = waitForPidsToExit(alive, 2000);
  }

  const remainingPids = allPids.filter((pid) => !restartOwnerPids.includes(pid));
  for (const pid of remainingPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already dead */
    }
  }

  alive = waitForPidsToExit(allPids, 5000);

  if (process.platform === "win32" && alive.length > 0) {
    for (const pid of alive) {
      taskkillPid(pid);
    }
    const taskkillDeadline = Date.now() + 3000;
    while (alive.length > 0 && Date.now() < taskkillDeadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      alive = alive.filter((pid) => isProcessAlive(pid));
    }
    if (alive.length > 0) {
      taskkillPidsElevated(alive, { force: false });
      alive = waitForPidsToExit(alive, 3000);
    }
  }

  for (const pid of alive) {
    try {
      if (process.platform === "win32") {
        taskkillPid(pid, { force: true });
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch {
      /* already dead */
    }
  }
  if (alive.length > 0) {
    if (process.platform === "win32") {
      taskkillPidsElevated(alive, { force: true });
    }
    const finalDeadline = Date.now() + 3000;
    while (alive.length > 0 && Date.now() < finalDeadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      alive = alive.filter((pid) => isProcessAlive(pid));
    }
  }
  removeKnownPidFiles(configuredCacheDirs);
  const killed = allPids.length - alive.length;
  console.log(`  ✓ Terminated ${killed}/${allPids.length} process(es).`);
  if (alive.length > 0) {
    console.log(`  :alert:  Still alive: ${alive.join(", ")}`);
    process.exit(1);
    return;
  }
  process.exit(0);
}

async function main() {
  // Apply legacy CODEX_MONITOR_* → BOSUN_* env aliases before any config ops
  applyAllCompatibility();

  // Apply config/repo CLI overrides before any subcommand routing so task
  // commands resolve the same workspace config/store paths as daemon mode.
  const earlyConfigDirArg = getArgValue("--config-dir");
  if (earlyConfigDirArg) {
    const resolvedConfigDirArg = resolve(earlyConfigDirArg);
    process.env.BOSUN_DIR = resolvedConfigDirArg;
    process.env.BOSUN_HOME = resolvedConfigDirArg;
  }
  const earlyRepoRootArg = getArgValue("--repo-root");
  if (earlyRepoRootArg) {
    process.env.REPO_ROOT = resolve(earlyRepoRootArg);
  }

  // Handle 'task' subcommand FIRST — before --help, so that
  // `bosun task --help` and `bosun task create --help` route to task-specific help
  // rather than the main bosun help page.
  const taskFlagIndex = args.indexOf("--task");
  const taskCommandIndex =
    args[0] === "task"
      ? 0
      : args[0]?.startsWith("--")
        ? args.indexOf("task")
        : -1;
  if (taskCommandIndex >= 0 || taskFlagIndex >= 0) {
    const { runTaskCli } = await import("./task/task-cli.mjs");
    const commandStartIndex = taskCommandIndex >= 0 ? taskCommandIndex : taskFlagIndex;
    const taskArgs = args.slice(commandStartIndex + 1);
    await runTaskCli(taskArgs);
    process.exit(0);
  }

  const workflowFlagIndex = args.indexOf("--workflow");
  const workflowCommandIndex =
    args[0] === "workflow"
      ? 0
      : args[0]?.startsWith("--")
        ? args.indexOf("workflow")
        : -1;
  if (workflowCommandIndex >= 0 || workflowFlagIndex >= 0) {
    const { runWorkflowCli } = await import("./workflow/workflow-cli.mjs");
    const commandStartIndex = workflowCommandIndex >= 0 ? workflowCommandIndex : workflowFlagIndex;
    const workflowArgs = args.slice(commandStartIndex + 1);
    await runWorkflowCli(workflowArgs);
    process.exit(0);
  }

  const simulateFlagIndex = args.indexOf("--simulate");
  const simulateCommandIndex =
    args[0] === "simulate"
      ? 0
      : args[0]?.startsWith("--")
        ? args.indexOf("simulate")
        : -1;
  if (simulateCommandIndex >= 0 || simulateFlagIndex >= 0) {
    const { runTaskSimulationCli } = await import("./task/task-simulate-cli.mjs");
    const commandStartIndex =
      simulateCommandIndex >= 0 ? simulateCommandIndex : simulateFlagIndex;
    const simulateArgs = args.slice(commandStartIndex + 1);
    await runTaskSimulationCli(simulateArgs);
    process.exit(0);
  }

  const auditFlagIndex = args.indexOf("--audit");
  const auditCommandIndex =
    args[0] === "audit"
      ? 0
      : args[0]?.startsWith("--")
        ? args.indexOf("audit")
        : -1;
  if (auditCommandIndex >= 0 || auditFlagIndex >= 0) {
    const { runAuditCli } = await import("./lib/codebase-audit.mjs");
    const commandStartIndex = auditCommandIndex >= 0 ? auditCommandIndex : auditFlagIndex;
    const auditArgs = args.slice(commandStartIndex + 1);
    const { exitCode } = await runAuditCli(auditArgs);
    process.exit(exitCode);
  }

  if (args[0] === "node:create" || (args[0] === "node" && args[1] === "create")) {
    const name = args[0] === "node:create" ? args[1] : args[2];
    if (!name) {
      console.error("Usage: bosun node:create <name>");
      process.exit(1);
    }
    const { scaffoldCustomNodeFile } = await import("./workflow/workflow-nodes.mjs");
    try {
      const result = scaffoldCustomNodeFile(name, { repoRoot: runtimeRepoRoot });
      console.log(`\n  ✓ Created custom node \"${result.type}\"`);
      console.log(`    File: ${result.filePath}`);
      console.log("");
    } catch (err) {
      console.error(`  Error: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args[0] === "apply-suggestions") {
    const { applyPrSuggestions } = await import("./tools/apply-pr-suggestions.mjs");
    const prNum = parseInt(args[1], 10);
    if (!prNum) {
      console.error("Usage: bosun apply-suggestions <pr-number> [--author <login>] [--dry-run]");
      process.exit(1);
    }
    const detected = (() => {
      try {
        const url = execSync("git config --get remote.origin.url", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
        const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
        return m ? { owner: m[1], repo: m[2] } : { owner: "", repo: "" };
      } catch { return { owner: "", repo: "" }; }
    })();
    const authorIdx = args.indexOf("--author");
    const author = authorIdx >= 0 ? args[authorIdx + 1] : undefined;
    const dryRun = args.includes("--dry-run");
    try {
      const result = await applyPrSuggestions({
        owner: detected.owner, repo: detected.repo, prNumber: prNum, dryRun, author,
      });
      if (result.commitSha) {
        console.log(`✅ Applied ${result.applied} suggestion(s) → ${result.commitSha.slice(0, 8)}`);
      } else {
        console.log(`ℹ ${result.message || "No suggestions to apply."}`);
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args[0] === "tui") {
    const { runBosunTui } = await import("./bosun-tui.mjs");
    const exitCode = await runBosunTui(args.slice(1));
    process.exit(exitCode ?? 0);
  }

  // Handle --help
  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  // Handle --version
  if (args.includes("--version") || args.includes("-v")) {
    console.log(`bosun v${VERSION}`);
    process.exit(0);
  }

  // Handle --where
  if (args.includes("--where") || args.includes("where")) {
    printConfigLocations();
    process.exit(0);
  }

  // Handle desktop shortcut controls
  if (args.includes("--desktop-shortcut")) {
    const { installDesktopShortcut, getDesktopShortcutMethodName } =
      await import("./infra/desktop-shortcut.mjs");
    const result = installDesktopShortcut();
    if (result.success) {
      console.log(`  :check: Desktop shortcut installed (${result.method})`);
      if (result.path) console.log(`     Path: ${result.path}`);
      if (result.name) console.log(`     Name: ${result.name}`);
    } else {
      const method = getDesktopShortcutMethodName();
      console.error(
        `  :close: Failed to install desktop shortcut (${method}): ${result.error}`,
      );
    }
    process.exit(result.success ? 0 : 1);
  }
  if (args.includes("--desktop-shortcut-remove")) {
    const { removeDesktopShortcut } = await import("./infra/desktop-shortcut.mjs");
    const result = removeDesktopShortcut();
    if (result.success) {
      console.log(`  :check: Desktop shortcut removed`);
    } else {
      console.error(
        `  :close: Failed to remove desktop shortcut: ${result.error}`,
      );
    }
    process.exit(result.success ? 0 : 1);
  }
  if (args.includes("--desktop-shortcut-status")) {
    const { getDesktopShortcutStatus } = await import("./infra/desktop-shortcut.mjs");
    const status = getDesktopShortcutStatus();
    if (status.installed) {
      console.log(`  Desktop shortcut: installed (${status.method})`);
      if (status.path) console.log(`  Path: ${status.path}`);
    } else {
      console.log(`  Desktop shortcut: not installed`);
    }
    process.exit(0);
  }

  // Handle --portal / --desktop
  if (args.includes("--portal") || args.includes("--desktop")) {
    const launcher = resolve(__dirname, "desktop", "launch.mjs");
    const child = spawn(process.execPath, [launcher], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      process.exit(code ?? 0);
    });
    return;
  }

  // Handle --doctor
  if (args.includes("--doctor") || args.includes("doctor")) {
    const { runConfigDoctor, formatConfigDoctorReport } =
      await import("./config/config-doctor.mjs");
    const result = runConfigDoctor();
    console.log(formatConfigDoctorReport(result));
    process.exit(result.ok ? 0 : 1);
  }

  // Handle --tool-log <ID> — retrieve cached tool output
  if (args.includes("--tool-log")) {
    const idx = args.indexOf("--tool-log");
    const logIdArg = args[idx + 1];
    const { retrieveToolLog, listToolLogs, pruneToolLogCache, getToolLogDir } =
      await import("./workspace/context-cache.mjs");

    if (logIdArg === "list" || logIdArg === "ls") {
      const logs = await listToolLogs(50);
      if (logs.length === 0) {
        console.log("No cached tool logs found.");
      } else {
        console.log(`Cached tool logs (${logs.length} entries):\n`);
        for (const entry of logs) {
          const ts = new Date(entry.ts).toISOString().replace("T", " ").slice(0, 19);
          console.log(`  ${entry.id}  ${ts}  ${entry.toolName}(${entry.argsPreview || ""})`);
        }
        console.log(`\nCache dir: ${getToolLogDir()}`);
      }
      process.exit(0);
    }

    if (logIdArg === "prune") {
      const pruned = await pruneToolLogCache();
      console.log(`Pruned ${pruned} expired cache entries.`);
      process.exit(0);
    }

    if (!logIdArg || !/^\d+$/.test(logIdArg)) {
      console.error("Usage: bosun --tool-log <ID>       Retrieve a cached tool output");
      console.error("       bosun --tool-log list       List cached tool logs");
      console.error("       bosun --tool-log prune      Remove expired cache entries");
      process.exit(1);
    }

    const result = await retrieveToolLog(Number(logIdArg));
    if (!result.found) {
      console.error(result.error || `Tool log ${logIdArg} not found.`);
      process.exit(1);
    }

    // Print the full original tool output
    const entry = result.entry;
    console.log(`\n${BOX.h.repeat(2)} Tool Log ${entry.id} ${BOX.h.repeat(2)}`);
    console.log(`Tool:  ${entry.toolName}`);
    console.log(`Args:  ${entry.argsPreview || "(none)"}`);
    console.log(`Time:  ${new Date(entry.ts).toISOString()}`);
    console.log(`${BOX.h.repeat(60)}\n`);

    const item = entry.item;
    const output =
      item?.text || item?.output || item?.aggregated_output ||
      item?.result || item?.message || JSON.stringify(item, null, 2);
    console.log(output);
    process.exit(0);
  }

  if (args.includes("--context-index")) {
    const modeRaw = (getArgValue("--context-index") || "run").toLowerCase();
    const validModes = new Set(["run", "status", "search", "graph"]);
    if (!validModes.has(modeRaw)) {
      console.error(`Invalid --context-index mode: ${modeRaw}`);
      console.error("Valid modes: run, status, search, graph");
      process.exit(1);
    }

    try {
      const {
        runContextIndex,
        searchContextIndex,
        getContextGraph,
        getContextIndexStatus,
      } = await import("./workspace/context-indexer.mjs");

      if (modeRaw === "run") {
        const result = await runContextIndex({ rootDir: runtimeRepoRoot });
        console.log(
          `Context index complete: files=${result.indexedFiles}, changed=${result.changedFiles}, removed=${result.removedFiles}, symbols=${result.symbolCount}`,
        );
        if (result.zoekt) {
          const zoektState = result.zoekt.success ? "ok" : "not-ready";
          console.log(`Zoekt: ${zoektState}${result.zoekt.message ? ` (${result.zoekt.message})` : ""}`);
        }
        process.exit(0);
      }

      if (modeRaw === "status") {
        const status = await getContextIndexStatus({ rootDir: runtimeRepoRoot });
        console.log(JSON.stringify(status, null, 2));
        process.exit(0);
      }

      const query = getArgValue("--context-index-query");
      if (!query) {
        console.error("--context-index-query is required when --context-index=search");
        process.exit(1);
      }

      const limitRaw = getArgValue("--context-index-limit");
      const parsedLimit = Number(limitRaw || 25);
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.floor(parsedLimit)
        : 25;

      const taskType = getArgValue("--context-index-task-type") || "auto";
      const fallbackToGlobal = !args.includes("--context-index-no-fallback");

      if (modeRaw === "graph") {
        const graph = await getContextGraph(query, {
          rootDir: runtimeRepoRoot,
          limit,
        });
        console.log(JSON.stringify(graph, null, 2));
        process.exit(0);
      }

      const results = await searchContextIndex(query, {
        rootDir: runtimeRepoRoot,
        limit,
        taskType,
        fallbackToGlobal,
        includeMeta: true,
      });
      console.log(JSON.stringify(results, null, 2));
      process.exit(0);
    } catch (error) {
      console.error(`Context index command failed: ${error?.message || String(error)}`);
      process.exit(1);
    }
  }

  // Handle sentinel controls
  if (args.includes("--sentinel-stop")) {
    process.exit(await runSentinelCli("--stop"));
  }
  if (args.includes("--sentinel-status")) {
    process.exit(await runSentinelCli("--status"));
  }

  // Handle --daemon
  if (args.includes("--daemon") || args.includes("-d")) {
    const { shouldRunSetup, runSetup } = await import("./setup.mjs");
    if (shouldRunSetup()) {
      console.log(
        "\n  :rocket: First run detected — setup is required before daemon mode.\n",
      );
      await runSetup();
      console.log("\n  Setup complete. Starting daemon...\n");
    }
    await startDaemon();
    return;
  }
  if (args.includes("--stop-daemon")) {
    stopDaemon();
    return;
  }
  if (args.includes("--terminate")) {
    await terminateBosun();
    return;
  }
  if (args.includes("--daemon-status")) {
    await daemonStatus();
    return;
  }

  // Write PID file if running as daemon child
  if (
    args.includes("--daemon-child") ||
    process.env.BOSUN_DAEMON === "1"
  ) {
    const existingDaemonPid = getDaemonPid();
    if (existingDaemonPid && existingDaemonPid !== process.pid) {
      process.stdout.write(
        `[daemon] another daemon-child already owns ${DAEMON_PID_FILE} (PID ${existingDaemonPid}) — duplicate daemon-child ignored.\n`,
      );
      process.exit(0);
    }
    writePidFile(process.pid);
    const daemonStdIoRedirected = process.env.BOSUN_DAEMON_STDIO_REDIRECTED === "1";
    if (!daemonStdIoRedirected) {
      // Redirect console to log file on daemon child when the launcher did not
      // already redirect stdio there (for example the Windows Start-Process fallback).
      const { createWriteStream } = await import("node:fs");
      const logStream = createWriteStream(DAEMON_LOG, { flags: "a" });
      let logStreamErrored = false;
      logStream.on("error", () => {
        logStreamErrored = true;
      });
      const origStdout = process.stdout.write.bind(process.stdout);
      const origStderr = process.stderr.write.bind(process.stderr);
      const isBenignDaemonStreamError = (err) => {
        const message = String(err?.message || "");
        return !!(
          err &&
          (err.code === "EPIPE" ||
            err.code === "EIO" ||
            err.code === "ERR_STREAM_DESTROYED" ||
            err.code === "ERR_STREAM_WRITE_AFTER_END" ||
            err.code === "ERR_STREAM_PREMATURE_CLOSE" ||
            /\bEIO\b/.test(message) ||
            /\bEPIPE\b/.test(message) ||
            /\bEOF\b/.test(message) ||
            /stream was destroyed/i.test(message) ||
            /write after end/i.test(message) ||
            /This socket has been ended/i.test(message))
        );
      };
      const safeWrite = (writeFn, chunk, args) => {
        try {
          return writeFn(chunk, ...args);
        } catch (err) {
          if (isBenignDaemonStreamError(err)) {
            return false;
          }
          throw err;
        }
      };
      process.stdout.write = (chunk, ...a) => {
        if (!logStreamErrored) {
          safeWrite(logStream.write.bind(logStream), chunk, []);
        }
        return safeWrite(origStdout, chunk, a);
      };
      process.stderr.write = (chunk, ...a) => {
        if (!logStreamErrored) {
          safeWrite(logStream.write.bind(logStream), chunk, []);
        }
        return safeWrite(origStderr, chunk, a);
      };
    }
    console.log(
      `\n[daemon] bosun started at ${new Date().toISOString()} (PID ${process.pid})`,
    );
  }

  // Sentinel is opt-in. Running sentinel and monitor Telegram polling together
  // can create getUpdates 409 conflicts when both poll the same bot token.
  const sentinelExplicit = args.includes("--sentinel");
  const sentinelAutoRequested = parseBoolEnv(
    process.env.BOSUN_SENTINEL_AUTO_START,
    false,
  );
  // In daemon-child mode, disable implicit sentinel auto-starts unless the
  // user explicitly requested --sentinel. This avoids accidental double pollers.
  const sentinelRequested =
    sentinelExplicit || (!IS_DAEMON_CHILD && sentinelAutoRequested);
  if (sentinelAutoRequested && !sentinelExplicit && IS_DAEMON_CHILD) {
    console.log(
      "  telegram-sentinel auto-start suppressed in daemon-child mode (use --sentinel to enable explicitly)",
    );
  }
  if (sentinelRequested) {
    const sentinel = await ensureSentinelRunning({ quiet: false });
    if (!sentinel.ok) {
      const mode = sentinelExplicit
        ? "requested by --sentinel"
        : "requested by BOSUN_SENTINEL_AUTO_START";
      const strictSentinel = parseBoolEnv(
        process.env.BOSUN_SENTINEL_STRICT,
        sentinelExplicit,
      );
      const prefix = strictSentinel ? ":close:" : ":alert:";
      const suffix = strictSentinel
        ? ""
        : " (continuing without sentinel companion)";
      console.error(
        `  ${prefix} Failed to start telegram-sentinel (${mode}): ${sentinel.error}${suffix}`,
      );
      if (strictSentinel) {
        process.exit(1);
      }
    }

    if (sentinelExplicit && !isDaemonSupervisorRuntime()) {
      console.log(
        "  Sentinel started without launching monitor (use --daemon --sentinel to run both).",
      );
      process.exit(0);
    }
  }

  // Handle --enable-startup / --disable-startup / --startup-status
  if (args.includes("--enable-startup")) {
    const { installStartupService, getStartupMethodName } =
      await import("./infra/startup-service.mjs");
    const result = await installStartupService({ daemon: true });
    if (result.success) {
      console.log(`  \u2705 Startup service installed via ${result.method}`);
      if (result.path) console.log(`     Path: ${result.path}`);
      if (result.name) console.log(`     Name: ${result.name}`);
      console.log(`\n  bosun will auto-start on login.`);
    } else {
      console.error(
        `  \u274c Failed to install startup service: ${result.error}`,
      );
    }
    process.exit(result.success ? 0 : 1);
  }
  if (args.includes("--disable-startup")) {
    const { removeStartupService } = await import("./infra/startup-service.mjs");
    const result = await removeStartupService();
    if (result.success) {
      console.log(`  \u2705 Startup service removed (${result.method})`);
    } else {
      console.error(
        `  \u274c Failed to remove startup service: ${result.error}`,
      );
    }
    process.exit(result.success ? 0 : 1);
  }
  if (args.includes("--startup-status")) {
    const { getStartupStatus } = await import("./infra/startup-service.mjs");
    const status = getStartupStatus();
    if (status.installed) {
      console.log(`  Startup service: installed (${status.method})`);
      if (status.name) console.log(`  Name: ${status.name}`);
      if (status.path) console.log(`  Path: ${status.path}`);
      if (status.running !== undefined)
        console.log(`  Running: ${status.running ? "yes" : "no"}`);
    } else {
      console.log(`  Startup service: not installed`);
      console.log(`  Run 'bosun --enable-startup' to register.`);
    }
    process.exit(0);
  }

  // Handle --update (force update)
  if (args.includes("--update")) {
    const runningDaemonPids = getRunningDaemonPids();
    const shouldRestartDaemon = runningDaemonPids.length > 0;
    const runningSiblingPids = findAllBosunProcessPids().filter(
      (pid) => pid !== process.pid,
    );
    const runningNonDaemonPids = runningSiblingPids.filter(
      (pid) => !runningDaemonPids.includes(pid),
    );
    if (shouldRestartDaemon) {
      console.log(
        "  Note: a successful update will restart the bosun daemon automatically.",
      );
    }
    if (runningNonDaemonPids.length > 0) {
      console.log(
        `  Note: ${runningNonDaemonPids.length} other running bosun process(es) will be stopped after a successful update.`,
      );
    }

    const { forceUpdate } = await import("./infra/update-check.mjs");
    const updated = await forceUpdate(VERSION);
    if (!updated) {
      process.exit(0);
    }

    // Only stop sibling processes once npm has actually installed the update.
    const daemonPids = getRunningDaemonPids();
    const siblingPids = Array.from(
      new Set([
        ...findAllBosunProcessPids().filter((pid) => pid !== process.pid),
        ...daemonPids,
      ]),
    );
    stopBosunProcesses(siblingPids, {
      reason: `Stopping ${siblingPids.length} running bosun process(es) to finish update`,
      timeoutMs: 5000,
    });

    if (shouldRestartDaemon) {
      if (daemonPids.length > 0) {
        removePidFile();
      }
      console.log("  Restarting daemon with updated version...");
      startDaemon(); // spawns new daemon-child and calls process.exit(0)
      return; // unreachable — startDaemon exits
    }

    if (siblingPids.length > 0) {
      console.log("  Restart stopped bosun sessions manually if you still need them.");
    }
    console.log("  Restart bosun to use the new version.\n");
    process.exit(0);
  }

  // ── Startup banner with update check ──────────────────────────────────────
  console.log("");
  console.log(safeBanner([`>_ bosun (v${VERSION})`]));

  // Non-blocking update check (don't delay startup)
  if (!args.includes("--no-update-check")) {
    import("./infra/update-check.mjs")
      .then(({ checkForUpdate }) => checkForUpdate(VERSION))
      .catch(() => {}); // silent — never block startup
  }

  // Propagate --no-auto-update to env for monitor.mjs to pick up
  if (args.includes("--no-auto-update")) {
    process.env.BOSUN_SKIP_AUTO_UPDATE = "1";
  }

  // Mark all child processes as bosun managed.
  // The agent-hook-bridge checks this to avoid firing hooks for standalone
  // agent sessions that happen to have hook config files in their tree.
  process.env.VE_MANAGED = "1";

  // Handle workspace commands
  if (args.includes("--workspace-list") || args.includes("workspace-list")) {
    const { listWorkspaces, getActiveWorkspace } = await import("./workspace/workspace-manager.mjs");
    const configDirArg = getArgValue("--config-dir");
    const configDir = configDirArg || process.env.BOSUN_DIR || resolveConfigDirForCli();
    const workspaces = listWorkspaces(configDir);
    const active = getActiveWorkspace(configDir);
    if (workspaces.length === 0) {
      console.log("\n  No workspaces configured. Run 'bosun --setup' to create one.\n");
    } else {
      console.log("\n  Workspaces:");
      for (const ws of workspaces) {
        const marker = ws.id === active?.id ? " ← active" : "";
        const stateIcon = ws.state === "active" ? "●" : ws.state === "paused" ? "◐" : "○";
        const stateLabel = ws.state !== "active" ? ` [${ws.state}]` : "";
        console.log(`    ${stateIcon} ${ws.name} (${ws.id})${stateLabel}${marker}`);
        const ex = ws.executors;
        console.log(`      executors: max=${ex.maxConcurrent}, pool=${ex.pool}, weight=${ex.weight}`);
        for (const repo of ws.repos || []) {
          const primary = repo.primary ? " [primary]" : "";
          const exists = repo.exists ? "✓" : "✗";
          console.log(`      ${exists} ${repo.name} — ${repo.slug || repo.url || "local"}${primary}`);
        }
      }
      console.log("");
    }
    process.exit(0);
  }

  if (args.includes("--workspace-add")) {
    const { createWorkspace } = await import("./workspace/workspace-manager.mjs");
    const configDirArg = getArgValue("--config-dir");
    const configDir = configDirArg || process.env.BOSUN_DIR || resolveConfigDirForCli();
    const name = getArgValue("--workspace-add");
    if (!name) {
      console.error("  Error: workspace name is required. Usage: bosun --workspace-add <name>");
      process.exit(1);
    }
    try {
      const ws = createWorkspace(configDir, { name });
      console.log(`\n  ✓ Workspace "${ws.name}" created at ${ws.path}\n`);
    } catch (err) {
      console.error(`  Error: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.includes("--workspace-switch")) {
    const { setActiveWorkspace, getWorkspace } = await import("./workspace/workspace-manager.mjs");
    const configDirArg = getArgValue("--config-dir");
    const configDir = configDirArg || process.env.BOSUN_DIR || resolveConfigDirForCli();
    const wsId = getArgValue("--workspace-switch");
    if (!wsId) {
      console.error("  Error: workspace ID required. Usage: bosun --workspace-switch <id>");
      process.exit(1);
    }
    try {
      setActiveWorkspace(configDir, wsId);
      const ws = getWorkspace(configDir, wsId);
      console.log(`\n  ✓ Switched to workspace "${ws?.name || wsId}"\n`);
    } catch (err) {
      console.error(`  Error: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.includes("--workspace-add-repo")) {
    const { addRepoToWorkspace, getActiveWorkspace, listWorkspaces } = await import("./workspace/workspace-manager.mjs");
    const configDirArg = getArgValue("--config-dir");
    const configDir = configDirArg || process.env.BOSUN_DIR || resolveConfigDirForCli();
    const active = getActiveWorkspace(configDir);
    if (!active) {
      console.error("  No active workspace. Create one first: bosun --workspace-add <name>");
      process.exit(1);
    }
    const url = getArgValue("--workspace-add-repo");
    if (!url) {
      console.error("  Error: repo URL required. Usage: bosun --workspace-add-repo <git-url>");
      process.exit(1);
    }
    try {
      console.log(`  Cloning into workspace "${active.name}"...`);
      const repo = addRepoToWorkspace(configDir, active.id, { url });
      console.log(`\n  ✓ Added repo "${repo.name}" to workspace "${active.name}"`);
      if (repo.cloned) console.log(`    Cloned to: ${repo.path}`);
      console.log("");
    } catch (err) {
      console.error(`  Error: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // Handle --workspace-health / --verify-workspace
  if (args.includes("--workspace-health") || args.includes("--verify-workspace") || args.includes("workspace-health")) {
    const { runWorkspaceHealthCheck, formatWorkspaceHealthReport } =
      await import("./config/config-doctor.mjs");
    const configDirArg = getArgValue("--config-dir");
    const configDir = configDirArg || process.env.BOSUN_DIR || resolveConfigDirForCli();
    const result = runWorkspaceHealthCheck({ configDir });
    console.log(formatWorkspaceHealthReport(result));
    process.exit(result.ok ? 0 : 1);
  }

  // Handle --workspace-pause
  if (args.includes("--workspace-pause") || args.includes("workspace-pause")) {
    const { pauseWorkspace, getWorkspace } = await import("./workspace/workspace-manager.mjs");
    const configDirArg = getArgValue("--config-dir");
    const configDir = configDirArg || process.env.BOSUN_DIR || resolveConfigDirForCli();
    const wsId = getArgValue("--workspace-pause") || getArgValue("workspace-pause");
    if (!wsId) {
      console.error("  Error: workspace ID required. Usage: bosun --workspace-pause <id>");
      process.exit(1);
    }
    try {
      pauseWorkspace(configDir, wsId);
      const ws = getWorkspace(configDir, wsId);
      console.log(`\n  ⏸  Workspace "${ws?.name || wsId}" paused — no new workflows will start\n`);
    } catch (err) {
      console.error(`  Error: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // Handle --workspace-resume
  if (args.includes("--workspace-resume") || args.includes("workspace-resume")) {
    const { resumeWorkspace, getWorkspace } = await import("./workspace/workspace-manager.mjs");
    const configDirArg = getArgValue("--config-dir");
    const configDir = configDirArg || process.env.BOSUN_DIR || resolveConfigDirForCli();
    const wsId = getArgValue("--workspace-resume") || getArgValue("workspace-resume");
    if (!wsId) {
      console.error("  Error: workspace ID required. Usage: bosun --workspace-resume <id>");
      process.exit(1);
    }
    try {
      resumeWorkspace(configDir, wsId);
      const ws = getWorkspace(configDir, wsId);
      console.log(`\n  ▶  Workspace "${ws?.name || wsId}" resumed — workflows will trigger normally\n`);
    } catch (err) {
      console.error(`  Error: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // Handle --workspace-disable
  if (args.includes("--workspace-disable") || args.includes("workspace-disable")) {
    const { disableWorkspace, getWorkspace } = await import("./workspace/workspace-manager.mjs");
    const configDirArg = getArgValue("--config-dir");
    const configDir = configDirArg || process.env.BOSUN_DIR || resolveConfigDirForCli();
    const wsId = getArgValue("--workspace-disable") || getArgValue("workspace-disable");
    if (!wsId) {
      console.error("  Error: workspace ID required. Usage: bosun --workspace-disable <id>");
      process.exit(1);
    }
    try {
      disableWorkspace(configDir, wsId);
      const ws = getWorkspace(configDir, wsId);
      console.log(`\n  ⏹  Workspace "${ws?.name || wsId}" disabled — no workflows, no executors\n`);
    } catch (err) {
      console.error(`  Error: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // Handle --workspace-status
  if (args.includes("--workspace-status") || args.includes("workspace-status")) {
    const { getWorkspaceStateSummary } = await import("./workspace/workspace-manager.mjs");
    const configDirArg = getArgValue("--config-dir");
    const configDir = configDirArg || process.env.BOSUN_DIR || resolveConfigDirForCli();
    const summary = getWorkspaceStateSummary(configDir);
    if (summary.length === 0) {
      console.log("\n  No workspaces configured.\n");
    } else {
      console.log("\n  Workspace Status:");
      for (const ws of summary) {
        const stateIcon = ws.state === "active" ? "●" : ws.state === "paused" ? "◐" : "○";
        const current = ws.isCurrent ? " ← current" : "";
        console.log(`    ${stateIcon} ${ws.name} (${ws.id}) — ${ws.state}${current}`);
        const ex = ws.executors;
        console.log(`      executors: max=${ex.maxConcurrent}, pool=${ex.pool}, weight=${ex.weight}`);
        if (ws.disabledWorkflows.length > 0) {
          console.log(`      disabled workflows: ${ws.disabledWorkflows.join(", ")}`);
        }
        if (ws.enabledWorkflows.length > 0) {
          console.log(`      enabled workflows: ${ws.enabledWorkflows.join(", ")}`);
        }
      }
      console.log("");
    }
    process.exit(0);
  }

  // Handle --workspace-executors
  if (args.includes("--workspace-executors") || args.includes("workspace-executors")) {
    const { setWorkspaceExecutors, getWorkspace } = await import("./workspace/workspace-manager.mjs");
    const configDirArg = getArgValue("--config-dir");
    const configDir = configDirArg || process.env.BOSUN_DIR || resolveConfigDirForCli();
    const wsId = getArgValue("--workspace-executors") || getArgValue("workspace-executors");
    if (!wsId) {
      console.error("  Error: workspace ID required. Usage: bosun --workspace-executors <id> [--max-concurrent N] [--pool shared|dedicated] [--weight N]");
      process.exit(1);
    }
    const maxConcurrent = getArgValue("--max-concurrent");
    const pool = getArgValue("--pool");
    const weight = getArgValue("--weight");
    const hasUpdate = maxConcurrent || pool || weight;
    if (hasUpdate) {
      try {
        const opts = {};
        if (maxConcurrent) opts.maxConcurrent = Number(maxConcurrent);
        if (pool) opts.pool = pool;
        if (weight) opts.weight = Number(weight);
        const result = setWorkspaceExecutors(configDir, wsId, opts);
        console.log(`\n  ✓ Executor config updated for "${wsId}":`, JSON.stringify(result), "\n");
      } catch (err) {
        console.error(`  Error: ${err.message}`);
        process.exit(1);
      }
    } else {
      const ws = getWorkspace(configDir, wsId);
      if (!ws) {
        console.error(`  Error: workspace "${wsId}" not found`);
        process.exit(1);
      }
      console.log(`\n  Executor config for "${ws.name}":`);
      console.log(`    maxConcurrent: ${ws.executors.maxConcurrent}`);
      console.log(`    pool: ${ws.executors.pool}`);
      console.log(`    weight: ${ws.executors.weight}\n`);
    }
    process.exit(0);
  }

  // Handle --setup-terminal (legacy terminal wizard)
  if (args.includes("--setup-terminal")) {
    const configDirArg = getArgValue("--config-dir");
    if (configDirArg) process.env.BOSUN_DIR = configDirArg;
    const { runSetup } = await import("./setup.mjs");
    await runSetup();
    process.exit(0);
  }

  // Handle --setup (web wizard — default)
  if (args.includes("--setup") || args.includes("setup")) {
    const configDirArg = getArgValue("--config-dir");
    if (configDirArg) process.env.BOSUN_DIR = configDirArg;
    const { startSetupServer } = await import("./server/setup-web-server.mjs");
    await startSetupServer();
    // Server keeps running until setup completes
  }

  // Handle --whatsapp-auth
  if (args.includes("--whatsapp-auth") || args.includes("whatsapp-auth")) {
    const mode = args.includes("--pairing-code") ? "pairing-code" : "qr";
    const { runWhatsAppAuth } = await import("./telegram/whatsapp-channel.mjs");
    await runWhatsAppAuth(mode);
    process.exit(0);
  }

  // First-run detection — skip in daemon-child mode (parent already handled it,
  // and the detached child has no stdin for interactive prompts).
  if (!isDaemonSupervisorRuntime()) {
    const { shouldRunSetup } = await import("./setup.mjs");
    if (shouldRunSetup()) {
      const configDirArg = getArgValue("--config-dir");
      if (configDirArg) {
        process.env.BOSUN_DIR = configDirArg;
      }
      console.log("\n  :rocket: First run detected — launching setup wizard...\n");
      const { startSetupServer } = await import("./server/setup-web-server.mjs");
      await startSetupServer();
      console.log("\n  Setup complete! Starting bosun...\n");
    }
  }

  // Legacy migration: if ~/codex-monitor exists with config, auto-migrate to ~/bosun
  const legacyInfo = detectLegacySetup();
  if (legacyInfo.hasLegacy && !legacyInfo.alreadyMigrated) {
    console.log(
      `\n  :box: Detected legacy codex-monitor config at ${legacyInfo.legacyDir}`,
    );
    console.log(`     Auto-migrating to ${legacyInfo.newDir}...\n`);
    const result = migrateFromLegacy(legacyInfo.legacyDir, legacyInfo.newDir);
    if (result.migrated.length > 0) {
      console.log(`  :check:  Migrated: ${result.migrated.join(", ")}`);
      console.log(`\n  Config is now at ${legacyInfo.newDir}\n`);
    }
    for (const err of result.errors) {
      console.log(`  :alert:   Migration warning: ${err}`);
    }
  }

  // ── Handle --echo-logs: tail the active monitor's log instead of spawning a new instance ──
  if (args.includes("--echo-logs")) {
    // Search for the monitor PID file in common cache locations
    const candidatePidFiles = [
      PID_FILE,
      process.env.BOSUN_DIR
        ? resolve(process.env.BOSUN_DIR, ".cache", "bosun.pid")
        : null,
      resolve(__dirname, "..", ".cache", "bosun.pid"),
      resolve(process.cwd(), ".cache", "bosun.pid"),
    ].filter(Boolean);

    let activePidFile = null;
    for (const f of candidatePidFiles) {
      if (existsSync(f)) {
        activePidFile = f;
        break;
      }
    }

    if (activePidFile) {
      try {
        const raw = readFileSync(activePidFile, "utf8").trim();
        let monitorPid;
        let monitorPath = "";

        // PID file can be a plain number (from writePidFile) or JSON (legacy format)
        const parsed = parseInt(raw, 10);
        if (!isNaN(parsed) && String(parsed) === raw) {
          monitorPid = parsed;
          // Derive the log directory from __dirname since we don't have argv
          monitorPath = fileURLToPath(new URL("./cli.mjs", import.meta.url));
        } else {
          try {
            const pidData = JSON.parse(raw);
            monitorPid = Number(pidData.pid);
            monitorPath = (pidData.argv || [])[1] || "";
          } catch {
            throw new Error(`Could not parse PID file: ${raw.slice(0, 100)}`);
          }
        }

        let isAlive = false;
        try {
          process.kill(monitorPid, 0);
          isAlive = true;
        } catch {}

        if (isAlive) {
          const logDir = monitorPath ? resolve(dirname(monitorPath), "logs") : resolve(__dirname, "logs");
          const daemonLog = existsSync(DAEMON_LOG) ? DAEMON_LOG : resolve(logDir, "daemon.log");
          const monitorLog = resolve(logDir, "monitor.log");
          // Prefer monitor.log — that's where the real activity goes.
          // daemon.log only has the startup line; monitor.mjs intercepts
          // all console output and writes to monitor.log.
          const logFile = existsSync(monitorLog) ? monitorLog : daemonLog;

          if (existsSync(logFile)) {
            console.log(
              `\n  Tailing logs for active bosun (PID ${monitorPid}):\n  ${logFile}\n`,
            );
            const controller = new AbortController();
            const stopFollowing = () => controller.abort();
            process.once("SIGINT", stopFollowing);
            try {
              await followTextFile(logFile, {
                initialLines: 200,
                signal: controller.signal,
              });
            } finally {
              process.removeListener("SIGINT", stopFollowing);
            }
            process.exit(0);
          } else {
            console.error(
              `\n  No log file found for active bosun (PID ${monitorPid}).\n  Expected: ${logFile}\n`,
            );
            process.exit(1);
          }
        }
      } catch (e) {
        console.error(`\n  --echo-logs: failed to read PID file — ${e.message}\n`);
        process.exit(1);
      }
    } else {
      console.error(
        "\n  --echo-logs: no active bosun found (PID file missing).\n  Start bosun first with: bosun --daemon\n",
      );
      process.exit(1);
    }

    // Should not reach here — all paths above exit
    process.exit(0);
  }

  const configuredCacheDirs = await getConfiguredRuntimeCacheDirs();
  const existingOwner = detectExistingMonitorLockOwner(null, configuredCacheDirs);
  if (existingOwner) {
    console.log(
      `\n  bosun is already running (PID ${existingOwner.pid}); exiting duplicate start.\n`,
    );
    return;
  }

  // Fork monitor as a child process — enables self-restart on source changes.
  // When monitor exits with code 75, cli re-forks with a fresh ESM module cache.
  await runMonitor();
}

// ── Crash notification (last resort — raw fetch when monitor can't start) ─────

function readEnvCredentials() {
  const envPath = resolve(__dirname, ".env");
  if (!existsSync(envPath)) return {};
  const vars = {};
  try {
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (
        key === "TELEGRAM_BOT_TOKEN" ||
        key === "TELEGRAM_CHAT_ID" ||
        key === "PROJECT_NAME"
      ) {
        vars[key] = val;
      }
    }
  } catch {
    // best effort
  }
  return vars;
}

async function sendCrashNotification(exitCode, signal, options = {}) {
  const { autoRestartInMs = 0, restartAttempt = 0, maxRestarts = 0 } = options;
  const env = readEnvCredentials();
  const token = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const project = env.PROJECT_NAME || process.env.PROJECT_NAME || "";
  const host = os.hostname();
  const tag = project ? `[${project}]` : "";
  const reason = signal ? `signal ${signal}` : `exit code ${exitCode}`;
  const isAutoRestart = Number(autoRestartInMs) > 0;
  const restartLine = isAutoRestart
    ? [
        `Auto-restart scheduled in ${Math.max(1, Math.round(autoRestartInMs / 1000))}s.`,
        restartAttempt > 0
          ? `Restart attempt: ${restartAttempt}${maxRestarts > 0 ? `/${maxRestarts}` : ""}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "Monitor is no longer running. Manual restart required.";
  const text =
    `:zap: *CRASH* ${tag} bosun v${VERSION} died unexpectedly\n` +
    `Host: \`${host}\`\n` +
    `Reason: \`${reason}\`\n` +
    `Time: ${new Date().toISOString()}\n\n` +
    restartLine;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // best effort — if Telegram is unreachable, nothing we can do
  }
}

// ── Self-restart exit code (must match monitor.mjs SELF_RESTART_EXIT_CODE) ───
const SELF_RESTART_EXIT_CODE = 75;
let monitorChild = null;
let shutdownSignalCount = 0;
let monitorShutdownForceTimer = null;

function getMonitorPidFileCandidates(extraCacheDirs = []) {
  return uniqueResolvedPaths([
    ...getPidFileCandidates("bosun.pid", extraCacheDirs),
    resolve(__dirname, "..", ".cache", "bosun.pid"),
  ]);
}

function tailLinesFromFile(filePath, maxLines = 200) {
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, "utf8");
    if (!raw) return [];
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length <= maxLines) return lines;
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

function checkPipedChildProcessLaunch() {
  try {
    const result = spawnSync(
      process.execPath,
      ["-e", "process.exit(0)"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 2000,
      },
    );
    if (result?.error) {
      return {
        ok: false,
        code: String(result.error?.code || "").trim().toUpperCase() || null,
      };
    }
    return {
      ok: Number(result?.status) === 0,
      code:
        Number(result?.status) === 0
          ? null
          : String(result?.status ?? "").trim() || null,
    };
  } catch (error) {
    return {
      ok: false,
      code: String(error?.code || "").trim().toUpperCase() || null,
    };
  }
}

function detectDaemonRestartStormSignals(options) {
  const resolvedOptions = options && typeof options === "object" ? options : {};
  const logDir = resolvedOptions.logDir || resolve(__dirname, "logs");
  const maxLines = resolvedOptions.maxLines || DAEMON_MISCONFIG_LOG_SCAN_LINES;
  const reasons = [];
  const monitorErrorLines = tailLinesFromFile(
    resolve(logDir, "monitor-error.log"),
    maxLines,
  );
  const monitorLines = tailLinesFromFile(resolve(logDir, "monitor.log"), maxLines);
  const combined = [...monitorErrorLines, ...monitorLines].join("\n");
  if (!combined) {
    return { hasSignal: false, reasons: [] };
  }

  if (
    /missing prerequisites:\s*no API key|codex unavailable:\s*no API key/i.test(
      combined,
    )
  ) {
    reasons.push("missing_api_key");
  }
  if (
    /another bosun instance holds the lock|duplicate start ignored|another bosun is already running/i
      .test(combined)
  ) {
    reasons.push("duplicate_runtime");
  }
  if (/Shared state heartbeat FATAL.*owner_mismatch/i.test(combined)) {
    reasons.push("shared_state_owner_mismatch");
  }
  if (
    /There is no tracking information for the current branch|git pull <remote> <branch>/i
      .test(combined)
  ) {
    reasons.push("workspace_git_tracking_missing");
  }

  return {
    hasSignal: reasons.length > 0,
    reasons,
  };
}

function installInlineMonitorKeepAlive() {
  const existing = globalThis.__bosunInlineMonitorKeepAlive;
  if (existing && typeof existing.refresh === "function") {
    existing.refresh();
    return existing;
  }
  if (existing && typeof existing.hasRef === "function" && existing.hasRef()) {
    return existing;
  }
  const timer = setInterval(() => {}, 60_000);
  globalThis.__bosunInlineMonitorKeepAlive = timer;
  return timer;
}

function shouldPauseDaemonRestartStorm(options) {
  const resolvedOptions = options && typeof options === "object" ? options : {};
  const restartCount = Number(resolvedOptions.restartCount || 0);
  const logDir = resolvedOptions.logDir;
  const daemonSupervisorActive =
    IS_DAEMON_CHILD === true
    || (typeof daemonInlineSupervisorActive !== "undefined" && daemonInlineSupervisorActive === true);
  if (!daemonSupervisorActive) return { pause: false, reasons: [] };
  if (!DAEMON_MISCONFIG_GUARD_ENABLED) return { pause: false, reasons: [] };
  if (restartCount < DAEMON_MISCONFIG_GUARD_MIN_RESTARTS) {
    return { pause: false, reasons: [] };
  }
  const signals = detectDaemonRestartStormSignals({ logDir });
  if (!signals.hasSignal) return { pause: false, reasons: [] };
  return { pause: true, reasons: signals.reasons };
}

function detectExistingMonitorLockOwner(excludePid = null, extraCacheDirs = []) {
  try {
    for (const pidFile of getMonitorPidFileCandidates(extraCacheDirs)) {
      let ownerPid = null;
      try {
        ownerPid = readAlivePid(pidFile);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `\n  [cli] failed to inspect existing monitor lock owner: ${message} (pidFile=${pidFile})\n`,
        );
        continue;
      }
      if (!ownerPid) continue;
      if (Number.isFinite(excludePid) && ownerPid === excludePid) continue;
      if (ownerPid === process.pid) continue;
      return { pid: ownerPid, pidFile };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `\n  [cli] failed to inspect existing monitor lock owner: ${message}\n`,
    );
  }
  return null;
}

function getRequiredMonitorRuntimeFiles(monitorPath) {
  const required = [monitorPath];
  const copilotDir = resolve(
    __dirname,
    "node_modules",
    "@github",
    "copilot",
  );
  const conptyAgentPath = resolve(copilotDir, "conpty_console_list_agent.js");
  if (process.platform === "win32" && existsSync(copilotDir)) {
    required.push(conptyAgentPath);
  }
  return required;
}

function listMissingFiles(paths) {
  return paths.filter((entry) => !existsSync(entry));
}

async function waitForMonitorRuntimeFiles(monitorPath) {
  const required = getRequiredMonitorRuntimeFiles(monitorPath);
  const startedAt = Date.now();
  let missing = listMissingFiles(required);
  while (
    missing.length > 0 &&
    Date.now() - startedAt < MONITOR_START_MAX_WAIT_MS
  ) {
    await new Promise((resolveWait) => {
      setTimeout(resolveWait, MONITOR_START_RETRY_MS);
    });
    missing = listMissingFiles(required);
  }
  return {
    ready: missing.length === 0,
    missing,
    waitedMs: Date.now() - startedAt,
  };
}

function runMonitor({ restartReason = "" } = {}) {
  return new Promise((resolve, reject) => {
    const monitorPath = fileURLToPath(
      new URL("./infra/monitor.mjs", import.meta.url),
    );
    waitForMonitorRuntimeFiles(monitorPath)
      .then(({ ready, missing, waitedMs }) => {
        if (!ready) {
          throw new Error(
            `monitor runtime files missing after waiting ${Math.round(waitedMs / 1000)}s: ${missing.join(", ")}`,
          );
        }
        if (waitedMs >= MONITOR_START_RETRY_MS) {
          console.warn(
            `[cli] delayed monitor start by ${Math.round(waitedMs / 1000)}s while waiting for runtime files to settle`,
          );
        }
        const childEnv = { ...process.env };
        if (restartReason) {
          childEnv.BOSUN_MONITOR_RESTART_REASON = restartReason;
        } else {
          delete childEnv.BOSUN_MONITOR_RESTART_REASON;
        }
        let forceInlineMonitor = false;
        if (process.platform === "win32") {
          const childProcessLaunch = checkPipedChildProcessLaunch();
          forceInlineMonitor =
            childProcessLaunch?.ok === false &&
            ["EPERM", "EACCES"].includes(
              String(childProcessLaunch?.code || "").trim().toUpperCase(),
            );
          if (forceInlineMonitor) {
            console.warn(
              `\n  [cli] monitor child spawn preflight blocked (${childProcessLaunch.code}); forcing inline monitor execution`,
            );
          }
        }
        const runAsNode = process.versions?.electron ? ["--run-as-node"] : [];
        const monitorArgs = [...runAsNode, monitorPath, ...process.argv.slice(2)];
        let usedWindowsShellFallback = false;
        const spawnMonitorChild = (forceWindowsShell = false) => {
          if (forceWindowsShell && process.platform === "win32") {
            const command = [process.execPath, ...monitorArgs]
              .map((part) => `"${String(part).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
              .join(" ");
            return spawn(
              process.env.ComSpec || "cmd.exe",
              ["/d", "/s", "/c", command],
              {
                env: childEnv,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
                cwd: process.cwd(),
              },
            );
          }
          try {
            return spawn(
              process.execPath,
              monitorArgs,
              {
                env: childEnv,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: process.platform === "win32",
                cwd: process.cwd(),
              },
            );
          } catch (err) {
            if (
              process.platform === "win32"
              && !forceWindowsShell
              && err?.code === "EPERM"
            ) {
              usedWindowsShellFallback = true;
              console.warn("\n  [cli] direct monitor spawn hit EPERM; retrying via cmd.exe shell wrapper");
              return spawnMonitorChild(true);
            }
            throw err;
          }
        };
        const launchInlineMonitor = async () => {
          console.warn("\n  [cli] monitor child spawn is unavailable; falling back to inline monitor execution");
          Object.assign(process.env, childEnv);
          installInlineMonitorKeepAlive();
          await import(`${pathToFileURL(monitorPath).href}?inline=${Date.now()}`);
        };
        const attachMonitorChildHandlers = (child) => {
          child.stdout?.on("data", (chunk) => {
            process.stdout.write(chunk);
          });
          child.stderr?.on("data", (chunk) => {
            process.stderr.write(chunk);
          });
          child.on("error", (err) => {
            if (monitorChild !== child) return;
            const canRetryViaShell =
              process.platform === "win32"
              && !usedWindowsShellFallback
              && err?.code === "EPERM";
            if (canRetryViaShell) {
              usedWindowsShellFallback = true;
              console.warn("\n  [cli] direct monitor spawn hit EPERM; retrying via cmd.exe shell wrapper");
              monitorChild = spawnMonitorChild(true);
              attachMonitorChildHandlers(monitorChild);
              return;
            }
            console.error(`\n  :close: Monitor failed to start: ${err.message}`);
          });
        };
        try {
          if (forceInlineMonitor) {
            launchInlineMonitor().then(resolve).catch(reject);
            return;
          }
          monitorChild = spawnMonitorChild(false);
        } catch (spawnErr) {
          if (process.platform === "win32" && spawnErr?.code === "EPERM") {
            launchInlineMonitor().then(resolve).catch(reject);
            return;
          }
          throw spawnErr;
        }
        attachMonitorChildHandlers(monitorChild);
        daemonCrashTracker.markStart();

        monitorChild.on("exit", (code, signal) => {
          const childPid = Number(monitorChild?.pid || 0) || null;
          if (monitorShutdownForceTimer) {
            clearTimeout(monitorShutdownForceTimer);
            monitorShutdownForceTimer = null;
          }
          monitorChild = null;
          if (code === SELF_RESTART_EXIT_CODE) {
            console.log(
              "\n  ↻ Monitor restarting with fresh modules...\n",
            );
            // Small delay to let file writes / port releases settle
            setTimeout(() => resolve(runMonitor({ restartReason: "self-restart" })), 2000);
          } else {
            const exitCode = code ?? (signal ? 1 : 0);
            const existingOwner =
              !gracefulShutdown && exitCode === 1
                ? detectExistingMonitorLockOwner(childPid)
                : null;
            if (existingOwner) {
              console.log(
                `\n  bosun is already running (PID ${existingOwner.pid}); exiting duplicate start.\n`,
              );
              process.exit(0);
              return;
            }
            // 4294967295 (0xFFFFFFFF / -1 signed) = OS killed the process (OOM, external termination)
            const isOSKill = exitCode === 4294967295 || exitCode === -1;
            const shouldAutoRestart =
              !gracefulShutdown &&
              (isOSKill || (isDaemonSupervisorRuntime() && exitCode !== 0));
            if (shouldAutoRestart) {
              const crashState = daemonCrashTracker.recordExit();
              daemonRestartCount += 1;
              // Exponential backoff: base delay doubles each attempt, capped at max
              const backoffDelay = Math.min(
                DAEMON_RESTART_DELAY_MS * Math.pow(2, Math.min(daemonRestartCount - 1, 10)),
                DAEMON_MAX_RESTART_DELAY_MS,
              );
              const delayMs = isOSKill ? 5000 : backoffDelay;
              const restartStormGuard = shouldPauseDaemonRestartStorm({
                restartCount: daemonRestartCount,
              });
              if (restartStormGuard.pause) {
                const reasonLabel = restartStormGuard.reasons.join(", ");
                console.error(
                  `\n  :close: Monitor restart storm paused after ${daemonRestartCount} attempts due to persistent runtime issues (${reasonLabel}).`,
                );
                sendCrashNotification(exitCode, signal).finally(() =>
                  process.exit(exitCode),
                );
                return;
              }
              if (isDaemonSupervisorRuntime() && crashState.exceeded) {
                const durationSec = Math.max(
                  1,
                  Math.round(crashState.runDurationMs / 1000),
                );
                const windowSec = Math.max(
                  1,
                  Math.round(crashState.instantCrashWindowMs / 1000),
                );
                console.error(
                  `\n  :close: Monitor crashed too quickly ${crashState.instantCrashCount} times in a row (each <= ${windowSec}s, latest ${durationSec}s). Auto-restart is now paused.`,
                );
                sendCrashNotification(exitCode, signal).finally(() =>
                  process.exit(exitCode),
                );
                return;
              }
              if (
                isDaemonSupervisorRuntime() &&
                DAEMON_MAX_RESTARTS > 0 &&
                daemonRestartCount > DAEMON_MAX_RESTARTS
              ) {
                console.error(
                  `\n  :close: Monitor crashed too many times (${daemonRestartCount - 1} restarts, max ${DAEMON_MAX_RESTARTS}).`,
                );
                sendCrashNotification(exitCode, signal).finally(() =>
                  process.exit(exitCode),
                );
                return;
              }
              const reasonLabel = signal
                ? `signal ${signal}`
                : `exit code ${exitCode}`;
              const attemptLabel =
                isDaemonSupervisorRuntime() && DAEMON_MAX_RESTARTS > 0
                  ? `${daemonRestartCount}/${DAEMON_MAX_RESTARTS}`
                  : `${daemonRestartCount}`;
              console.error(
                `\n  :alert: Monitor exited (${reasonLabel}) — auto-restarting in ${Math.max(1, Math.round(delayMs / 1000))}s${isDaemonSupervisorRuntime() ? ` [attempt ${attemptLabel}]` : ""}...`,
              );
              sendCrashNotification(exitCode, signal, {
                autoRestartInMs: delayMs,
                restartAttempt: daemonRestartCount,
                maxRestarts: isDaemonSupervisorRuntime() ? DAEMON_MAX_RESTARTS : 0,
              }).catch(() => {});
              setTimeout(
                () =>
                  resolve(
                    runMonitor({
                      restartReason: isOSKill ? "os-kill" : "crash",
                    }),
                  ),
                delayMs,
              );
              return;
            }

            if (exitCode !== 0 && !gracefulShutdown) {
              console.error(
                `\n  :close: Monitor crashed (${signal ? `signal ${signal}` : `exit code ${exitCode}`}) — sending crash notification...`,
              );
              sendCrashNotification(exitCode, signal).finally(() =>
                process.exit(exitCode),
              );
            } else {
              daemonRestartCount = 0;
              daemonCrashTracker.reset();
              process.exit(exitCode);
            }
          }
        });

      })
      .catch((err) => {
        console.error(`\n  :close: Monitor failed to start: ${err.message}`);
        sendCrashNotification(1, null).finally(() => reject(err));
      });
  });
}

function requestMonitorChildShutdown(signal = "SIGINT") {
  gracefulShutdown = true;
  shutdownSignalCount += 1;
  if (!monitorChild) {
    process.exit(0);
    return;
  }

  const requestedSignal = shutdownSignalCount > 1 ? "SIGTERM" : signal;
  try {
    if (typeof monitorChild.kill === "function") {
      monitorChild.kill(requestedSignal);
    } else if (typeof monitorChild.terminate === "function") {
      monitorChild.terminate().catch(() => {});
    }
  } catch {
    /* best effort */
  }

  if (monitorShutdownForceTimer) return;
  monitorShutdownForceTimer = setTimeout(() => {
    const child = monitorChild;
    monitorShutdownForceTimer = null;
    if (!child) {
      process.exit(0);
      return;
    }
    try {
      if (typeof child.kill === "function") {
        child.kill("SIGTERM");
      } else if (typeof child.terminate === "function") {
        child.terminate().catch(() => {});
      }
    } catch {
      /* best effort */
    }
    const hardExitTimer = setTimeout(() => process.exit(0), 2000);
    hardExitTimer.unref?.();
  }, 15000);
  monitorShutdownForceTimer.unref?.();
}

// Let forked monitor handle signal cleanup — prevent parent from dying first
let gracefulShutdown = false;
process.on("SIGINT", () => {
  requestMonitorChildShutdown("SIGINT");
});
process.on("SIGTERM", () => {
  requestMonitorChildShutdown("SIGTERM");
});

main().catch(async (err) => {
  console.error(`bosun failed: ${err.message}`);
  await sendCrashNotification(1, null).catch(() => {});
  process.exit(1);
});
