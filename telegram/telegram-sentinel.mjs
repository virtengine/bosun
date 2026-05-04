#!/usr/bin/env node

/**
 * telegram-sentinel.mjs — Always-on Telegram command listener for bosun.
 *
 * Runs independently of the main bosun process, ensuring Telegram
 * commands are always handled even when bosun is down.
 *
 * Architecture:
 *   ┌─────────────────┐
 *   │ telegram-sentinel│──── always running ────────────────────────────────┐
 *   │  (this file)     │                                                   │
 *   └────────┬─────────┘                                                   │
 *            │                                                             │
 *            ├─ Standalone Mode (bosun DOWN)                       │
 *            │   ├─ Polls Telegram directly                                │
 *            │   ├─ Handles simple commands (/ping, /status, /sentinel)    │
 *            │   └─ Auto-starts bosun for complex commands         │
 *            │                                                             │
 *            └─ Companion Mode (bosun UP)                          │
 *                ├─ Does NOT poll (lets telegram-bot.mjs handle it)        │
 *                ├─ Monitors bosun health via PID file             │
 *                └─ Transitions to Standalone if bosun dies        │
 *                                                                          │
 *   ┌─────────────────┐                                                    │
 *   │  bosun   │ ← started/stopped by sentinel as needed ─────────┘
 *   │  (cli.mjs fork)  │
 *   └─────────────────┘
 *
 * Usage:
 *   node telegram-sentinel.mjs          # start sentinel
 *   node telegram-sentinel.mjs --stop   # stop sentinel
 *   node telegram-sentinel.mjs --status # check sentinel status
 */

import {
  existsSync,
  readFileSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import os from "node:os";
import { createHarnessAgentService } from "../agent/harness-agent-service.mjs";
import { resolveRepoRoot } from "../config/repo-root.mjs";
import {
  claimTelegramPollOwner,
  getActiveTelegramPollOwner,
  releaseTelegramPollOwner,
} from "./telegram-poll-owner.mjs";

// ── Paths ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve repo root from BOSUN_HOME config first, then fall back to git detection.
// This avoids depending on cwd being inside a git repo (daemon/sentinel may start
// from homedir or any arbitrary directory).
function _resolveSentinelRepoRoot() {
  // 1. Explicit env
  if (process.env.REPO_ROOT) {
    const r = resolve(process.env.REPO_ROOT);
    if (existsSync(r)) return r;
  }
  // 2. Check BOSUN_HOME workspace config for a primary repo
  const bosunDir = resolveBosunConfigDir();
  if (bosunDir) {
    for (const cfgName of ["bosun.config.json", ".bosun.json", "bosun.json"]) {
      const cfgPath = resolve(bosunDir, cfgName);
      if (!existsSync(cfgPath)) continue;
      try {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
        // Check workspace repos
        const workspaces = Array.isArray(cfg.workspaces) ? cfg.workspaces : [];
        for (const ws of workspaces) {
          const repos = ws?.repos || ws?.repositories || [];
          if (!Array.isArray(repos)) continue;
          for (const repo of repos) {
            const name = typeof repo === "string" ? repo.split("/").pop() : (repo?.name || repo?.id || "");
            if (!name) continue;
            const wsId = ws?.id || "default";
            const repoPath = resolve(bosunDir, "workspaces", wsId, name);
            if (existsSync(resolve(repoPath, ".git"))) return repoPath;
          }
        }
        // Check flat repositories
        const repos = cfg.repositories || cfg.repos || [];
        if (Array.isArray(repos)) {
          for (const repo of repos) {
            const repoPath = typeof repo === "string" ? repo : (repo?.path || repo?.repoRoot);
            if (!repoPath) continue;
            const resolved = resolve(isAbsolute(repoPath) ? repoPath : resolve(bosunDir, repoPath));
            if (existsSync(resolve(resolved, ".git"))) return resolved;
          }
        }
      } catch { /* invalid config */ }
    }
  }
  // 3. Fall back to standard repo-root resolution (git detection)
  return resolveRepoRoot();
}

const repoRoot = _resolveSentinelRepoRoot();
const cacheDir = resolve(repoRoot, ".cache");

function resolveBosunConfigDir() {
  if (process.env.BOSUN_DIR) return resolve(process.env.BOSUN_DIR);
  if (process.env.APPDATA) return resolve(process.env.APPDATA, "bosun");
  if (process.env.LOCALAPPDATA) return resolve(process.env.LOCALAPPDATA, "bosun");
  if (process.env.USERPROFILE) return resolve(process.env.USERPROFILE, "bosun");
  if (process.env.HOME) return resolve(process.env.HOME, "bosun");
  return null;
}

function getWorkspaceCacheCandidates() {
  const candidates = new Set([cacheDir]);

  // Legacy/cwd cache paths used by older versions or detached launches.
  candidates.add(resolve(__dirname, "..", ".cache"));
  candidates.add(resolve(process.cwd(), ".cache"));

  // Some daemon/sentinel launches resolve repo root through BOSUN workspace
  // config paths (BOSUN_DIR/workspaces/<workspace>/<repo>). Include that
  // deterministic cache location so monitor/sentinel stay in sync.
  const bosunDir = resolveBosunConfigDir();
  if (bosunDir) {
    const parts = String(repoRoot).replace(/\\/g, "/").split("/").filter(Boolean);
    const repoName = parts.at(-1);
    const workspaceName = parts.at(-2);
    if (repoName && workspaceName) {
      candidates.add(
        resolve(bosunDir, "workspaces", workspaceName, repoName, ".cache"),
      );
    }
  }

  return [...candidates];
}

const CACHE_CANDIDATES = getWorkspaceCacheCandidates();

const MONITOR_PID_FILE = resolve(cacheDir, "bosun.pid");
const MONITOR_PID_FILE_LEGACY = resolve(__dirname, "..", ".cache", "bosun.pid");
const MONITOR_PID_FILE_CWD = resolve(process.cwd(), ".cache", "bosun.pid");
const DAEMON_PID_FILE = resolve(cacheDir, "bosun-daemon.pid");
const DAEMON_PID_FILE_LEGACY = resolve(__dirname, "..", ".cache", "bosun-daemon.pid");
const DAEMON_PID_FILE_CWD = resolve(process.cwd(), ".cache", "bosun-daemon.pid");
const SENTINEL_PID_FILE = resolve(cacheDir, "telegram-sentinel.pid");
const SENTINEL_HEARTBEAT_FILE = resolve(cacheDir, "sentinel-heartbeat.json");
const SENTINEL_LOCK_FILE = resolve(cacheDir, "telegram-sentinel.lock");
const SENTINEL_COMMAND_QUEUE_FILE = resolve(
  cacheDir,
  "sentinel-command-queue.json",
);
const SENTINEL_MONITOR_RECOVERY_FILE = resolve(
  cacheDir,
  "sentinel-monitor-recovery.json",
);
const MONITOR_POLL_LOCK_FILE = resolve(cacheDir, "telegram-getupdates.lock");
const STATUS_FILE = resolve(cacheDir, "orchestrator-status.json");

const TAG = "[sentinel]";
const harnessAgentRuntime = createHarnessAgentService();
const POLL_TIMEOUT_S = 30;
const MAX_MESSAGE_LEN = 4000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const POLL_ERROR_BACKOFF_BASE_MS = 5_000;
const POLL_ERROR_BACKOFF_MAX_MS = 120_000;
const POLL_OWNER_HANDOFF_CHECKS = 3;
const POLL_OWNER_HANDOFF_DELAY_MS = 500;
const SENTINEL_POLL_OWNER_TTL_MS = Math.max(
  30_000,
  Number(process.env.TELEGRAM_POLL_OWNER_TTL_MS || "120000") || 120_000,
);
const COMMAND_QUEUE_MAX_SIZE = 50;
const COMMAND_QUEUE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MONITOR_START_TIMEOUT_MS = 60_000; // 60s to wait for monitor to become healthy
const MONITOR_HEALTH_POLL_MS = 2_000; // check every 2s during startup

// ── State ────────────────────────────────────────────────────────────────────

/** @type {"standalone" | "companion"} */
let mode = "standalone";
let running = false;
let polling = false;
/** @type {AbortController | null} */
let pollAbort = null;
let lastUpdateId = 0;
let healthCheckTimer = null;
let heartbeatTimer = null;
let consecutivePollErrors = 0;
let commandsProcessed = 0;
let startedAt = new Date().toISOString();
/** @type {Array<{ chatId: string|number, text: string, timestamp: number }>} */
let commandQueue = [];
/** @type {Promise<void> | null} */
let monitorStartPromise = null;
let sentinelPollLockHeld = false;
let recoveryInProgress = false;
let monitorRestartAttempts = [];
let monitorCrashEvents = [];
let lastRepairAt = 0;
let lastMonitorStartAt = 0;
let monitorManualStopUntil = 0;
let consecutiveRecoveryFailures = 0;
let recoveryCircuitOpen = false;
let recoveryCircuitOpenedAt = 0;

const sentinelConfig = {
  autoRestartMonitor: true,
  crashLoopThreshold: 3,
  crashLoopWindowMs: 10 * 60 * 1000,
  monitorStartGraceMs: 45 * 1000,
  repairAgentEnabled: true,
  repairCooldownMs: 15 * 60 * 1000,
  repairTimeoutMs: 20 * 60 * 1000,
  primaryAgentFallbackEnabled: true,
  primaryAgentFallbackTimeoutMs: 15 * 60 * 1000,
  restartBackoffMs: 5 * 1000,
  manualStopHoldMs: 10 * 60 * 1000,
  monitorMonitorCheckEnabled: true,
  monitorMonitorMaxAgeMs: 20 * 60 * 1000,
  // Circuit breaker: stop auto-restart after this many consecutive failures
  maxConsecutiveRecoveryFailures: 5,
  // How long the circuit breaker stays open before allowing one retry
  recoveryCircuitCooldownMs: 30 * 60 * 1000,
};

// ── Environment ──────────────────────────────────────────────────────────────

/** @type {string} */
let telegramToken = "";
/** @type {string} */
let telegramChatId = "";
/** @type {string} */
let projectName = "";

/**
 * Parse the .env file for Telegram credentials and project name.
 * Uses a simple line-by-line parser — no external dependencies.
 * @returns {{ TELEGRAM_BOT_TOKEN?: string, TELEGRAM_CHAT_ID?: string, PROJECT_NAME?: string }}
 */
function loadEnvCredentials() {
  const envPath = resolve(__dirname, ".env");
  /** @type {Record<string, string>} */
  const vars = {};

  if (!existsSync(envPath)) return vars;

  try {
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      vars[key] = val;
    }
  } catch {
    // best effort
  }

  return vars;
}

/**
 * Initialize environment variables from .env and process.env.
 * Process.env takes precedence over .env file values.
 */
function parseBool(value, defaultValue) {
  if (value == null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function parseNumber(value, defaultValue, min = null, max = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  let out = parsed;
  if (Number.isFinite(min)) out = Math.max(min, out);
  if (Number.isFinite(max)) out = Math.min(max, out);
  return out;
}

function getEnvValue(fileVars, key, fallback = "") {
  // .env is the PRIMARY source, then process env.
  const fromFile = fileVars?.[key];
  if (fromFile != null && String(fromFile).trim() !== "") return fromFile;
  const fromProcess = process.env[key];
  if (fromProcess != null && String(fromProcess).trim() !== "") {
    return fromProcess;
  }
  return fallback;
}

function initEnv() {
  const fileVars = loadEnvCredentials();
  telegramToken = getEnvValue(fileVars, "TELEGRAM_BOT_TOKEN", "");
  telegramChatId = getEnvValue(fileVars, "TELEGRAM_CHAT_ID", "");
  projectName = getEnvValue(fileVars, "PROJECT_NAME", "bosun");

  sentinelConfig.autoRestartMonitor = parseBool(
    getEnvValue(fileVars, "SENTINEL_AUTO_RESTART_MONITOR", "1"),
    true,
  );
  sentinelConfig.crashLoopThreshold = parseNumber(
    getEnvValue(fileVars, "SENTINEL_CRASH_LOOP_THRESHOLD", "3"),
    3,
    2,
    20,
  );
  sentinelConfig.crashLoopWindowMs =
    parseNumber(
      getEnvValue(fileVars, "SENTINEL_CRASH_LOOP_WINDOW_MIN", "10"),
      10,
      1,
      120,
    ) * 60_000;
  sentinelConfig.monitorStartGraceMs =
    parseNumber(
      getEnvValue(fileVars, "SENTINEL_MONITOR_START_GRACE_SEC", "45"),
      45,
      10,
      600,
    ) * 1000;
  sentinelConfig.repairAgentEnabled = parseBool(
    getEnvValue(fileVars, "SENTINEL_REPAIR_AGENT_ENABLED", "1"),
    true,
  );
  sentinelConfig.repairCooldownMs =
    parseNumber(
      getEnvValue(fileVars, "SENTINEL_REPAIR_COOLDOWN_MIN", "15"),
      15,
      1,
      240,
    ) * 60_000;
  sentinelConfig.repairTimeoutMs =
    parseNumber(
      getEnvValue(fileVars, "SENTINEL_REPAIR_TIMEOUT_MIN", "20"),
      20,
      1,
      240,
    ) * 60_000;
  sentinelConfig.primaryAgentFallbackEnabled = parseBool(
    getEnvValue(fileVars, "SENTINEL_PRIMARY_AGENT_FALLBACK_ENABLED", "1"),
    true,
  );
  sentinelConfig.primaryAgentFallbackTimeoutMs =
    parseNumber(
      getEnvValue(fileVars, "SENTINEL_PRIMARY_AGENT_TIMEOUT_MIN", "15"),
      15,
      1,
      180,
    ) * 60_000;
  sentinelConfig.restartBackoffMs =
    parseNumber(
      getEnvValue(fileVars, "SENTINEL_RESTART_BACKOFF_SEC", "5"),
      5,
      0,
      600,
    ) * 1000;
  sentinelConfig.manualStopHoldMs =
    parseNumber(
      getEnvValue(fileVars, "SENTINEL_MANUAL_STOP_HOLD_MIN", "10"),
      10,
      0,
      240,
    ) * 60_000;
  sentinelConfig.monitorMonitorCheckEnabled = parseBool(
    getEnvValue(fileVars, "SENTINEL_MONITOR_MONITOR_CHECK_ENABLED", "1"),
    true,
  );
  sentinelConfig.monitorMonitorMaxAgeMs =
    parseNumber(
      getEnvValue(fileVars, "SENTINEL_MONITOR_MONITOR_MAX_AGE_MIN", "20"),
      20,
      1,
      240,
    ) * 60_000;
  sentinelConfig.maxConsecutiveRecoveryFailures = parseNumber(
    getEnvValue(fileVars, "SENTINEL_MAX_CONSECUTIVE_RECOVERY_FAILURES", "5"),
    5,
    2,
    50,
  );
  sentinelConfig.recoveryCircuitCooldownMs =
    parseNumber(
      getEnvValue(fileVars, "SENTINEL_RECOVERY_CIRCUIT_COOLDOWN_MIN", "30"),
      30,
      5,
      240,
    ) * 60_000;
}

function pruneTimestamps(values, now = Date.now()) {
  const floor = now - sentinelConfig.crashLoopWindowMs;
  return (values || []).filter((ts) => Number.isFinite(ts) && ts >= floor);
}

function saveRecoveryState() {
  try {
    mkdirSync(dirname(SENTINEL_MONITOR_RECOVERY_FILE), { recursive: true });
    writeFileSync(
      SENTINEL_MONITOR_RECOVERY_FILE,
      JSON.stringify(
        {
          monitorRestartAttempts,
          monitorCrashEvents,
          lastRepairAt,
          lastMonitorStartAt,
          monitorManualStopUntil,
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

function loadRecoveryState() {
  try {
    if (!existsSync(SENTINEL_MONITOR_RECOVERY_FILE)) return;
    const raw = readFileSync(SENTINEL_MONITOR_RECOVERY_FILE, "utf8");
    if (!raw || !raw.trim()) return;
    const data = JSON.parse(raw);
    monitorRestartAttempts = Array.isArray(data.monitorRestartAttempts)
      ? data.monitorRestartAttempts
      : [];
    monitorCrashEvents = Array.isArray(data.monitorCrashEvents)
      ? data.monitorCrashEvents
      : [];
    lastRepairAt = Number(data.lastRepairAt) || 0;
    lastMonitorStartAt = Number(data.lastMonitorStartAt) || 0;
    monitorManualStopUntil = Number(data.monitorManualStopUntil) || 0;
  } catch {
    /* best effort */
  }
}

function recordMonitorRestartAttempt() {
  const now = Date.now();
  monitorRestartAttempts.push(now);
  monitorRestartAttempts = pruneTimestamps(monitorRestartAttempts, now);
  saveRecoveryState();
}

function recordMonitorCrashEvent() {
  const now = Date.now();
  monitorCrashEvents.push(now);
  monitorCrashEvents = pruneTimestamps(monitorCrashEvents, now);
  saveRecoveryState();
}

function isCrashLoopDetected(now = Date.now()) {
  monitorRestartAttempts = pruneTimestamps(monitorRestartAttempts, now);
  monitorCrashEvents = pruneTimestamps(monitorCrashEvents, now);
  const threshold = sentinelConfig.crashLoopThreshold;
  return (
    monitorCrashEvents.length >= threshold ||
    monitorRestartAttempts.length >= threshold
  );
}

async function assessMonitorMonitorHealth() {
  if (!sentinelConfig.monitorMonitorCheckEnabled) {
    return { ok: true, reason: "check disabled" };
  }
  const devmodeEnabled = parseBool(
    process.env.DEVMODE_MONITOR_MONITOR_ENABLED ?? "1",
    true,
  );
  if (!devmodeEnabled) {
    return { ok: true, reason: "devmode monitor-monitor disabled" };
  }
  try {
    if (!existsSync(STATUS_FILE)) {
      return { ok: false, reason: "status file missing" };
    }
    const statusRaw = await readFile(STATUS_FILE, "utf8");
    const status = JSON.parse(statusRaw || "{}");
    const mm = status?.monitor_monitor || status?.monitorMonitor || null;
    if (!mm || typeof mm !== "object") {
      // If the monitor-monitor section was never written, the feature is
      // simply not configured. Treat this as healthy to avoid false-positive
      // crash-loop repair triggers.
      return { ok: true, reason: "monitor-monitor not configured" };
    }
    if (mm.enabled === false) {
      return { ok: true, reason: "monitor-monitor disabled in status" };
    }
    const lastRunAt = mm.lastRunAt || mm.last_run_at || mm.last_run || null;
    if (!lastRunAt) {
      return { ok: false, reason: "monitor-monitor missing last run timestamp" };
    }
    const ageMs = Date.now() - new Date(lastRunAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0) {
      return { ok: false, reason: "monitor-monitor timestamp invalid" };
    }
    if (ageMs > sentinelConfig.monitorMonitorMaxAgeMs) {
      return {
        ok: false,
        reason: `monitor-monitor stale (${formatUptime(ageMs)} old)`,
      };
    }
    return { ok: true, reason: `healthy (${formatUptime(ageMs)} old)` };
  } catch (err) {
    return { ok: false, reason: err?.message || "health check failed" };
  }
}

function normalizeAgentResult(result) {
  if (!result) return "(no response)";
  if (typeof result === "string") return result;
  if (typeof result.finalResponse === "string" && result.finalResponse.trim()) {
    return result.finalResponse.trim();
  }
  if (typeof result.response === "string" && result.response.trim()) {
    return result.response.trim();
  }
  try {
    return JSON.stringify(result).slice(0, 3000);
  } catch {
    return String(result);
  }
}

async function runRepairAgent(triggerReason, details = "") {
  if (!sentinelConfig.repairAgentEnabled) return false;
  if (recoveryInProgress) return false;

  const now = Date.now();
  const sinceLast = now - lastRepairAt;
  if (lastRepairAt > 0 && sinceLast < sentinelConfig.repairCooldownMs) {
    log(
      "warn",
      `repair-agent cooldown active (${Math.round((sentinelConfig.repairCooldownMs - sinceLast) / 1000)}s remaining)`,
    );
    return false;
  }

  recoveryInProgress = true;
  lastRepairAt = now;
  saveRecoveryState();

  try {
    await sendTelegram(
      telegramChatId,
      [
        ":settings: Crash-loop detected. Launching repair agent.",
        `Trigger: ${triggerReason}`,
        details ? `Context: ${details}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );

    const runtimeLabel =
      harnessAgentRuntime.getPoolSdkName?.()
      || harnessAgentRuntime.getPrimaryAgentName?.()
      || "harness";
    const mmHealth = await assessMonitorMonitorHealth();
    const prompt = [
      "bosun sentinel autonomous repair request.",
      "",
      `Trigger: ${triggerReason}`,
      `Project: ${projectName}`,
      `Host: ${os.hostname()}`,
      `Crash events in window: ${monitorCrashEvents.length}`,
      `Restart attempts in window: ${monitorRestartAttempts.length}`,
      `Monitor-monitor health: ${mmHealth.ok ? "healthy" : "degraded"} (${mmHealth.reason})`,
      details ? `Additional context: ${details}` : "",
      "",
      "Task:",
      "1) Diagnose likely monitor crash-loop root cause.",
      "2) Apply safe, minimal fixes directly in this workspace when possible.",
      "3) Return concise summary: root cause, files changed, validation performed, residual risk.",
    ]
      .filter(Boolean)
      .join("\n");

    const result = await harnessAgentRuntime.runBackgroundPrompt(prompt, {
      timeoutMs: sentinelConfig.repairTimeoutMs,
      sessionId: "sentinel-repair-agent",
      scope: "telegram-sentinel:repair",
      sessionType: "telegram-sentinel",
      taskKey: "telegram-sentinel-repair",
      autoRecover: true,
    });
    const summary = normalizeAgentResult(result);
    await sendTelegram(
      telegramChatId,
      [
        `:check: Repair agent completed via ${runtimeLabel}.`,
        "",
        summary.slice(0, 3500),
      ].join("\n"),
    );
    return true;
  } catch (err) {
    await sendTelegram(
      telegramChatId,
      `:close: Repair agent failed: ${err?.message || err}`,
    );
    return false;
  } finally {
    recoveryInProgress = false;
    saveRecoveryState();
  }
}

async function runPrimaryAgentFallback(chatId, text, command) {
  if (!sentinelConfig.primaryAgentFallbackEnabled) {
    return false;
  }
  try {
    const runtimeLabel =
      harnessAgentRuntime.getPoolSdkName?.()
      || harnessAgentRuntime.getPrimaryAgentName?.()
      || "harness";
    await sendTelegram(
      chatId,
      `:bot: bosun is down. Running via sentinel harness fallback (${runtimeLabel})...`,
    );

    const prompt = [
      "Telegram fallback request while bosun is offline.",
      "",
      `Project: ${projectName}`,
      `Host: ${os.hostname()}`,
      `Command: ${command}`,
      "",
      "User input:",
      text,
      "",
      "Execute this request directly and return a concise, actionable response suitable for Telegram.",
      "If the exact command requires monitor internals, provide the closest equivalent action and clear next steps.",
    ].join("\n");

    const result = await harnessAgentRuntime.runBackgroundPrompt(prompt, {
      timeoutMs: sentinelConfig.primaryAgentFallbackTimeoutMs,
      sessionId: `sentinel-fallback-${chatId}`,
      scope: `telegram-sentinel:${chatId}`,
      sessionType: "telegram-sentinel",
      taskKey: `telegram-sentinel-${chatId}`,
      autoRecover: true,
    });
    const message = normalizeAgentResult(result).slice(0, 3600);
    await sendTelegram(chatId, message || "(fallback completed with no text output)");
    return true;
  } catch (err) {
    await sendTelegram(
      chatId,
      `:close: Sentinel fallback failed: ${err?.message || err}`,
    );
    return false;
  }
}

async function attemptMonitorRecovery(triggerReason) {
  if (!sentinelConfig.autoRestartMonitor) return;
  if (monitorStartPromise) return;
  if (Date.now() < monitorManualStopUntil) {
    log("info", "auto-restart suppressed due to recent manual stop");
    return;
  }

  // If the monitor is already running, nothing to recover
  if (readMonitorPid()) {
    log("info", `monitor is already running — suppressing recovery (${triggerReason})`);
    return;
  }

  // If a daemon-child is alive it manages its own restart loop internally;
  // spawning a competing daemon from the sentinel causes immediate PID/port
  // conflicts and the "bosun process died during startup" crash loop.
  const liveDaemonPid = readDaemonPid();
  if (liveDaemonPid) {
    log(
      "info",
      `daemon-child (PID ${liveDaemonPid}) is alive — suppressing sentinel recovery to avoid competing restart (${triggerReason})`,
    );
    return;
  }

  // ── Circuit breaker: stop retrying after consecutive failures ──
  if (recoveryCircuitOpen) {
    const elapsed = Date.now() - recoveryCircuitOpenedAt;
    if (elapsed < sentinelConfig.recoveryCircuitCooldownMs) {
      log(
        "info",
        `recovery circuit breaker open — ${Math.round((sentinelConfig.recoveryCircuitCooldownMs - elapsed) / 60000)}m until next retry`,
      );
      return;
    }
    // Cooldown expired — allow one retry (half-open)
    log("info", "recovery circuit breaker half-open — allowing one retry");
    recoveryCircuitOpen = false;
  }

  const loopDetected = isCrashLoopDetected();
  if (loopDetected) {
    const mmHealth = await assessMonitorMonitorHealth();
    await sendTelegram(
      telegramChatId,
      [
        ":alert: Monitor crash-loop detected.",
        `Window: ${Math.round(sentinelConfig.crashLoopWindowMs / 60000)}m | threshold: ${sentinelConfig.crashLoopThreshold}`,
        `Monitor-monitor: ${mmHealth.ok ? "healthy" : "degraded"} (${mmHealth.reason})`,
        `Consecutive failures: ${consecutiveRecoveryFailures}/${sentinelConfig.maxConsecutiveRecoveryFailures}`,
        "Attempting autonomous repair before restart.",
      ].join("\n"),
    );
    await runRepairAgent(triggerReason, mmHealth.reason);
  }

  // Exponential backoff: base * 2^(failures-1), capped at 5 minutes
  const backoffMs = Math.min(
    sentinelConfig.restartBackoffMs * Math.pow(2, consecutiveRecoveryFailures),
    5 * 60 * 1000,
  );
  if (backoffMs > 0) {
    log("info", `restart backoff: ${Math.round(backoffMs / 1000)}s`);
    await sleep(backoffMs);
  }

  try {
    await ensureMonitorRunning(`sentinel recovery: ${triggerReason}`);
    const pid = readMonitorPid();
    const pidSuffix = pid ? ` (PID ${pid})` : "";
    await sendTelegram(
      telegramChatId,
      `:check: bosun recovered${pidSuffix}.`,
    );
    // Recovery succeeded — reset circuit breaker state
    consecutiveRecoveryFailures = 0;
    recoveryCircuitOpen = false;
    recoveryCircuitOpenedAt = 0;
  } catch (err) {
    consecutiveRecoveryFailures += 1;
    if (consecutiveRecoveryFailures >= sentinelConfig.maxConsecutiveRecoveryFailures) {
      recoveryCircuitOpen = true;
      recoveryCircuitOpenedAt = Date.now();
      const cooldownMin = Math.round(sentinelConfig.recoveryCircuitCooldownMs / 60000);
      await sendTelegram(
        telegramChatId,
        [
          `:close: bosun auto-restart failed ${consecutiveRecoveryFailures} times consecutively.`,
          `Circuit breaker OPEN — auto-restart paused for ${cooldownMin}m.`,
          `Use /start to manually restart, or wait for cooldown.`,
          `Last error: ${err?.message || err}`,
        ].join("\n"),
      );
      log(
        "error",
        `recovery circuit breaker opened after ${consecutiveRecoveryFailures} consecutive failures`,
      );
    } else {
      await sendTelegram(
        telegramChatId,
        `:close: bosun auto-restart failed: ${err?.message || err}`,
      );
    }
  }
}

// ── Process Utilities ────────────────────────────────────────────────────────

/**
 * Check if a process with the given PID is alive.
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a PID file payload that may be plain text (`"1234"`) or JSON (`{"pid":1234,...}`).
 * @param {string} raw
 * @returns {number | null}
 */
export function parsePidFileValue(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text);
      const pid = Number(data?.pid);
      if (!Number.isFinite(pid) || pid <= 0) return null;
      return Math.trunc(pid);
    } catch {
      return null;
    }
  }

  const pid = Number.parseInt(text, 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return pid;
}

/**
 * Read a PID from a file and check if the process is alive.
 * @param {string} pidPath
 * @returns {number | null} The PID if alive, null otherwise.
 */
function readAlivePid(pidPath) {
  try {
    if (!existsSync(pidPath)) return null;
    const pid = parsePidFileValue(readFileSync(pidPath, "utf8"));
    if (!pid) return null;
    return isProcessAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Write a PID file atomically (best effort).
 * @param {string} pidPath
 * @param {number} pid
 */
function writePidFile(pidPath, pid) {
  try {
    mkdirSync(dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, String(pid), "utf8");
  } catch {
    /* best effort */
  }
}

/**
 * Remove a PID file.
 * @param {string} pidPath
 */
function removePidFile(pidPath) {
  try {
    if (existsSync(pidPath)) unlinkSync(pidPath);
  } catch {
    /* best effort */
  }
}

function readMonitorPid() {
  const candidates = [
    MONITOR_PID_FILE,
    MONITOR_PID_FILE_LEGACY,
    MONITOR_PID_FILE_CWD,
    ...CACHE_CANDIDATES.map((dir) => resolve(dir, "bosun.pid")),
  ];
  for (const pidFile of new Set(candidates)) {
    const pid = readAlivePid(pidFile);
    if (pid) return pid;
  }
  return null;
}

function readDaemonPid() {
  const candidates = [
    DAEMON_PID_FILE,
    DAEMON_PID_FILE_LEGACY,
    DAEMON_PID_FILE_CWD,
    ...CACHE_CANDIDATES.map((dir) => resolve(dir, "bosun-daemon.pid")),
  ];
  for (const pidFile of new Set(candidates)) {
    const pid = readAlivePid(pidFile);
    if (pid) return pid;
  }
  return null;
}

function readSentinelPid() {
  const candidates = [
    SENTINEL_PID_FILE,
    ...CACHE_CANDIDATES.map((dir) => resolve(dir, "telegram-sentinel.pid")),
  ];
  for (const pidFile of new Set(candidates)) {
    const pid = readAlivePid(pidFile);
    if (pid) return pid;
  }
  return null;
}

function removeSentinelPidFiles() {
  const candidates = [
    SENTINEL_PID_FILE,
    ...CACHE_CANDIDATES.map((dir) => resolve(dir, "telegram-sentinel.pid")),
  ];
  for (const pidFile of new Set(candidates)) {
    removePidFile(pidFile);
  }
}

function readHeartbeatSnapshot() {
  const candidates = [
    SENTINEL_HEARTBEAT_FILE,
    ...CACHE_CANDIDATES.map((dir) => resolve(dir, "sentinel-heartbeat.json")),
  ];
  for (const hbPath of new Set(candidates)) {
    try {
      if (!existsSync(hbPath)) continue;
      const raw = readFileSync(hbPath, "utf8");
      if (!raw?.trim()) continue;
      return JSON.parse(raw);
    } catch {
      /* try next */
    }
  }
  return null;
}

function removeMonitorPidFiles() {
  removePidFile(MONITOR_PID_FILE);
  removePidFile(MONITOR_PID_FILE_LEGACY);
  removePidFile(MONITOR_PID_FILE_CWD);
}

// ── Sentinel Lock ────────────────────────────────────────────────────────────

/**
 * Acquire the sentinel poll lock file. Uses exclusive create (wx) to prevent
 * races between multiple sentinel instances.
 * @returns {Promise<boolean>}
 */
async function acquireSentinelPollLock() {
  if (sentinelPollLockHeld) return true;
  try {
    const payload = JSON.stringify(
      {
        owner: "sentinel",
        pid: process.pid,
        started_at: new Date().toISOString(),
      },
      null,
      2,
    );
    await writeFile(SENTINEL_LOCK_FILE, payload, { flag: "wx" });
    sentinelPollLockHeld = true;
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") {
      // Check if the existing lock holder is still alive
      try {
        const raw = await readFile(SENTINEL_LOCK_FILE, "utf8");
        if (!raw || !raw.trim()) {
          await unlink(SENTINEL_LOCK_FILE).catch(() => {});
          return acquireSentinelPollLock();
        }
        const data = JSON.parse(raw);
        const pid = Number(data?.pid);
        if (!isProcessAlive(pid)) {
          // Stale lock — reclaim
          await unlink(SENTINEL_LOCK_FILE).catch(() => {});
          return acquireSentinelPollLock();
        }
        // Another live sentinel holds the lock
        return false;
      } catch {
        // Corrupt lock file — remove and retry
        await unlink(SENTINEL_LOCK_FILE).catch(() => {});
        return acquireSentinelPollLock();
      }
    }
    return false;
  }
}

/**
 * Release the sentinel poll lock file.
 * @returns {Promise<void>}
 */
async function releaseSentinelPollLock() {
  if (!sentinelPollLockHeld) return;
  sentinelPollLockHeld = false;
  try {
    await unlink(SENTINEL_LOCK_FILE).catch(() => {});
  } catch {
    /* best effort */
  }
}

// ── Telegram API ─────────────────────────────────────────────────────────────

/**
 * Send a text message to a Telegram chat.
 * Handles message splitting for long texts and retries on transient errors.
 * @param {string | number} chatId
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.parseMode]
 * @param {boolean} [options.silent]
 * @returns {Promise<number | null>} The message_id of the last sent chunk, or null.
 */
async function sendTelegram(chatId, text, options = {}) {
  if (!telegramToken) return null;
  const chunks = splitMessage(text, MAX_MESSAGE_LEN);
  let lastMessageId = null;

  for (const chunk of chunks) {
    const url = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
    /** @type {Record<string, any>} */
    const payload = {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    };
    if (options.parseMode) payload.parse_mode = options.parseMode;
    if (options.silent) payload.disable_notification = true;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res || typeof res.ok === "undefined") {
        log("warn", "send error: invalid response object");
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log("warn", `send failed: ${res.status} ${body}`);
        // If parse_mode caused the error, retry as plain text
        if (options.parseMode && res.status === 400) {
          return sendTelegram(chatId, chunk, {
            ...options,
            parseMode: undefined,
          });
        }
      } else {
        try {
          const data = await res.json();
          if (data.ok && data.result?.message_id) {
            lastMessageId = data.result.message_id;
          }
        } catch {
          /* best effort */
        }
      }
    } catch (err) {
      log("warn", `send error: ${err.message}`);
    }
  }
  return lastMessageId;
}

/**
 * Split a text into chunks that fit within Telegram's message limit.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string[]}
 */
function splitMessage(text, maxLen) {
  if (!text) return ["(empty)"];
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.3) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}

// ── Telegram Polling ─────────────────────────────────────────────────────────

/**
 * Long-poll the Telegram Bot API for new updates.
 * @returns {Promise<Array<object>>}
 */
async function pollUpdates() {
  if (!telegramToken) return [];

  const url = `https://api.telegram.org/bot${telegramToken}/getUpdates`;
  const params = new URLSearchParams({
    offset: String(lastUpdateId + 1),
    timeout: String(POLL_TIMEOUT_S),
    allowed_updates: JSON.stringify(["message"]),
  });

  pollAbort = new AbortController();
  let res;
  try {
    res = await fetch(`${url}?${params}`, {
      signal: pollAbort.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") return [];
    throw err;
  } finally {
    pollAbort = null;
  }

  if (!res || typeof res.ok === "undefined") {
    throw new Error("invalid response object from Telegram");
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 409 = conflict — another poller is active
    if (res.status === 409) {
      log(
        "warn",
        "Telegram 409 conflict — another poller is active, backing off",
      );
      const conflictError = new Error("getUpdates conflict: another poller is active");
      conflictError.code = "TELEGRAM_POLL_CONFLICT";
      throw conflictError;
    }
    throw new Error(`getUpdates failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  return data.ok ? data.result || [] : [];
}

/**
 * Main polling loop. Runs continuously while sentinel is in standalone mode.
 * Implements exponential backoff on errors.
 */
async function pollLoop() {
  log("info", "polling loop started");

  try {
    while (running && polling && mode === "standalone") {
      try {
        await claimTelegramPollOwner("telegram-sentinel", {
          ttlMs: SENTINEL_POLL_OWNER_TTL_MS,
        });

        const updates = await pollUpdates();
        consecutivePollErrors = 0;

        for (const update of updates) {
          lastUpdateId = Math.max(lastUpdateId, update.update_id);
          await handleUpdate(update);
        }
      } catch (err) {
        if (!running) break;
        if (err?.code === "TELEGRAM_POLL_CONFLICT") {
          polling = false;
          await releaseSentinelPollLock();
          await releaseTelegramPollOwner("telegram-sentinel").catch(() => {});
          break;
        }

        consecutivePollErrors++;
        const backoff = Math.min(
          POLL_ERROR_BACKOFF_BASE_MS * Math.pow(2, consecutivePollErrors - 1),
          POLL_ERROR_BACKOFF_MAX_MS,
        );
        log(
          "warn",
          `poll error (attempt ${consecutivePollErrors}): ${err.message} — retry in ${Math.round(backoff / 1000)}s`,
        );
        await sleep(backoff);
      }
    }
  } finally {
    await releaseSentinelPollLock();
    await releaseTelegramPollOwner("telegram-sentinel").catch(() => {});
  }

  log("info", "polling loop stopped");
}

// ── Update Handler ───────────────────────────────────────────────────────────

/** Commands that the sentinel can handle without bosun. */
const STANDALONE_COMMANDS = new Set([
  "/ping",
  "/status",
  "/sentinel",
  "/start",
  "/stop",
  "/help",
]);

/** Commands that require bosun to be running. */
const MONITOR_REQUIRED_COMMANDS = new Set([
  "/resumetask",
  "/resume",
  "/tasks",
  "/task",
  "/sdk",
  "/model",
  "/switch",
  "/worktrees",
  "/prune",
  "/batch",
  "/threads",
  "/rebalance",
  "/logs",
  "/errors",
  "/restart",
  "/config",
]);

/**
 * Handle a single Telegram update.
 * @param {object} update
 */
async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = String(msg.chat?.id);
  // Security: only accept messages from the configured chat
  if (chatId !== String(telegramChatId)) {
    log("warn", `ignoring message from unauthorized chat ${chatId}`);
    return;
  }

  const text = msg.text.trim();
  const command = text.split(/\s+/)[0].toLowerCase();
  // Strip @botname suffix from commands (e.g. /ping@MyBot → /ping)
  const bareCommand = command.includes("@") ? command.split("@")[0] : command;

  commandsProcessed++;

  // ── Standalone-handled commands ──────────────────────────────────────────
  if (STANDALONE_COMMANDS.has(bareCommand)) {
    await handleStandaloneCommand(chatId, bareCommand, text);
    return;
  }

  // ── Commands requiring bosun ─────────────────────────────────────
  // Either a known monitor command, free-text message, or unknown command
  log("info", `command "${bareCommand}" requires bosun`);
  await handleMonitorCommand(chatId, text, bareCommand);
}

// ── Standalone Command Handlers ──────────────────────────────────────────────

/**
 * Handle commands that the sentinel can process without bosun.
 * @param {string} chatId
 * @param {string} command
 * @param {string} fullText
 */
async function handleStandaloneCommand(chatId, command, fullText) {
  switch (command) {
    case "/ping":
      await handlePing(chatId);
      break;
    case "/status":
      await handleStatus(chatId);
      break;
    case "/sentinel":
      await handleSentinelInfo(chatId);
      break;
    case "/start":
      await handleStartMonitor(chatId);
      break;
    case "/stop":
      await handleStopMonitor(chatId);
      break;
    case "/help":
      await handleHelp(chatId);
      break;
    default:
      await sendTelegram(chatId, `Unknown standalone command: ${command}`);
  }
}

/**
 * /ping — Simple liveness check for the sentinel.
 * @param {string} chatId
 */
async function handlePing(chatId) {
  const monPid = readMonitorPid();
  const monStatus = monPid ? `:check: running (PID ${monPid})` : ":close: not running";
  const uptime = formatUptime(Date.now() - new Date(startedAt).getTime());
  await sendTelegram(
    chatId,
    [
      ":target: *Pong!*",
      "",
      `Sentinel: :check: alive (${uptime})`,
      `Mode: ${mode}`,
      `Monitor: ${monStatus}`,
      `Host: \`${os.hostname()}\``,
    ].join("\n"),
    { parseMode: "Markdown" },
  );
}

/**
 * /status — Read the cached orchestrator status file.
 * @param {string} chatId
 */
async function handleStatus(chatId) {
  try {
    if (!existsSync(STATUS_FILE)) {
      await sendTelegram(
        chatId,
        ":chart: No status file found. bosun may not have run yet.",
      );
      return;
    }
    const raw = await readFile(STATUS_FILE, "utf8");
    const data = JSON.parse(raw);

    const lines = [":chart: *Orchestrator Status*", ""];

    if (data.executor_mode) lines.push(`Mode: \`${data.executor_mode}\``);
    if (data.active_slots) lines.push(`Slots: \`${data.active_slots}\``);
    if (data.last_executor_sync) {
      const ago = formatUptime(
        Date.now() - new Date(data.last_executor_sync).getTime(),
      );
      lines.push(`Last sync: ${ago} ago`);
    }

    // Show active attempts
    if (data.attempts && typeof data.attempts === "object") {
      const active = Object.values(data.attempts).filter(
        (a) => a.status === "running" || a.status === "pending",
      );
      if (active.length > 0) {
        lines.push("", "*Active Tasks:*");
        for (const a of active.slice(0, 10)) {
          const title = a.task_title || a.task_id?.slice(0, 8) || "?";
          lines.push(`• ${title} — ${a.status} (${a.executor || "?"})`);
        }
      } else {
        lines.push("", "No active tasks.");
      }
    }

    await sendTelegram(chatId, lines.join("\n"), { parseMode: "Markdown" });
  } catch (err) {
    await sendTelegram(chatId, `:close: Error reading status: ${err.message}`);
  }
}

/**
 * /sentinel — Show detailed sentinel information.
 * @param {string} chatId
 */
async function handleSentinelInfo(chatId) {
  const status = getSentinelStatus();
  const lines = [
    ":shield: *Telegram Sentinel*",
    "",
    `PID: \`${process.pid}\``,
    `Mode: ${status.mode}`,
    `Started: ${status.startedAt}`,
    `Uptime: ${formatUptime(Date.now() - new Date(status.startedAt).getTime())}`,
    `Monitor PID: ${status.monitorPid ? `\`${status.monitorPid}\`` : "none"}`,
    `Commands processed: ${status.commandsProcessed}`,
    `Commands queued: ${status.commandsQueued}`,
    `Poll errors: ${consecutivePollErrors}`,
    `Host: \`${os.hostname()}\``,
    `Platform: \`${process.platform} ${process.arch}\``,
    `Node: \`${process.version}\``,
  ];

  await sendTelegram(chatId, lines.join("\n"), { parseMode: "Markdown" });
}

/**
 * /start — Manually start bosun.
 * @param {string} chatId
 */
async function handleStartMonitor(chatId) {
  const monPid = readMonitorPid();
  if (monPid) {
    await sendTelegram(
      chatId,
      `:check: bosun is already running (PID ${monPid}).`,
    );
    return;
  }
  // Manual start resets the circuit breaker
  consecutiveRecoveryFailures = 0;
  recoveryCircuitOpen = false;
  recoveryCircuitOpenedAt = 0;
  await sendTelegram(chatId, ":rocket: Starting bosun...");
  try {
    await ensureMonitorRunning("manual /start command");
    const pid = readMonitorPid();
    await sendTelegram(
      chatId,
      `:check: bosun started${pid ? ` (PID ${pid})` : ""}.`,
    );
  } catch (err) {
    await sendTelegram(
      chatId,
      `:close: Failed to start bosun: ${err.message}`,
    );
  }
}

/**
 * /stop — Manually stop bosun.
 * @param {string} chatId
 */
async function handleStopMonitor(chatId) {
  const monPid = readMonitorPid();
  if (!monPid) {
    await sendTelegram(chatId, ":help: bosun is not running.");
    return;
  }
  await sendTelegram(chatId, `:close: Stopping bosun (PID ${monPid})...`);
  try {
    process.kill(monPid, "SIGTERM");
    // Wait for process to die
    let gone = false;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (!isProcessAlive(monPid)) {
        gone = true;
        break;
      }
    }
    if (!gone) {
      try {
        process.kill(monPid, "SIGKILL");
      } catch {
        /* best effort */
      }
    }
    removeMonitorPidFiles();
    await sendTelegram(chatId, ":check: bosun stopped.");
    monitorManualStopUntil = Date.now() + sentinelConfig.manualStopHoldMs;
    saveRecoveryState();
    // Transition to standalone mode after stopping monitor
    await transitionToStandalone("monitor manually stopped");
  } catch (err) {
    await sendTelegram(chatId, `:close: Error stopping monitor: ${err.message}`);
  }
}

/**
 * /help — Show available sentinel commands.
 * @param {string} chatId
 */
async function handleHelp(chatId) {
  const monPid = readMonitorPid();
  const monStatus = monPid ? "running" : "stopped";

  const lines = [
    ":shield: *Sentinel Commands* (always available)",
    "",
    "/ping — Check sentinel + monitor liveness",
    "/status — Show cached orchestrator status",
    "/sentinel — Show sentinel details",
    "/start — Start bosun",
    "/stop — Stop bosun",
    "/help — This message",
    "",
    `Monitor is *${monStatus}*. All other commands will ${monPid ? "be forwarded to" : "auto-start"} bosun.`,
  ];

  await sendTelegram(chatId, lines.join("\n"), { parseMode: "Markdown" });
}

// ── Monitor-Required Command Handling ────────────────────────────────────────

/**
 * Handle commands that need bosun. Starts the monitor if not running
 * and queues the command for replay once it's healthy.
 * @param {string} chatId
 * @param {string} text
 * @param {string} command
 */
async function handleMonitorCommand(chatId, text, command) {
  const monPid = readMonitorPid();
  const requiresMonitor = MONITOR_REQUIRED_COMMANDS.has(command);

  if (monPid) {
    // Monitor is running but sentinel is somehow in standalone mode — this
    // can happen briefly during transitions. Queue the command for the
    // monitor to pick up.
    queueCommand(chatId, text);
    await writeCommandQueueFile();
    log("info", "monitor running — queued command for replay");
    return;
  }

  let fallbackHandled = false;
  if (sentinelConfig.primaryAgentFallbackEnabled) {
    fallbackHandled = await runPrimaryAgentFallback(chatId, text, command);
  }

  if (requiresMonitor) {
    queueCommand(chatId, text);
  }

  if (!sentinelConfig.autoRestartMonitor && !requiresMonitor) {
    return;
  }

  await sendTelegram(chatId, ":clock: Starting bosun in the background...");

  try {
    await ensureMonitorRunning(`command: ${command}`);
    if (commandQueue.length > 0) {
      await writeCommandQueueFile();
    }
    log(
      "info",
      `monitor started — ${commandQueue.length} command(s) queued for replay`,
    );
  } catch (err) {
    if (!fallbackHandled) {
      await sendTelegram(
        chatId,
        `:close: Failed to start bosun: ${err.message}\n\nYour command was not processed.`,
      );
    }
    // Clear the failed commands
    commandQueue = [];
  }
}

// ── Command Queue ────────────────────────────────────────────────────────────

/**
 * Add a command to the replay queue.
 * @param {string | number} chatId
 * @param {string} text
 */
function queueCommand(chatId, text) {
  // Evict stale commands
  const now = Date.now();
  commandQueue = commandQueue.filter(
    (c) => now - c.timestamp < COMMAND_QUEUE_TTL_MS,
  );

  // Enforce max queue size
  if (commandQueue.length >= COMMAND_QUEUE_MAX_SIZE) {
    log(
      "warn",
      `command queue full (${COMMAND_QUEUE_MAX_SIZE}), dropping oldest`,
    );
    commandQueue.shift();
  }

  commandQueue.push({ chatId: String(chatId), text, timestamp: now });
}

/**
 * Write the command queue to a JSON file for bosun to read.
 * @returns {Promise<void>}
 */
async function writeCommandQueueFile() {
  try {
    mkdirSync(dirname(SENTINEL_COMMAND_QUEUE_FILE), { recursive: true });
    await writeFile(
      SENTINEL_COMMAND_QUEUE_FILE,
      JSON.stringify(commandQueue, null, 2),
      "utf8",
    );
  } catch (err) {
    log("warn", `failed to write command queue: ${err.message}`);
  }
}

/**
 * Get the current command queue.
 * @returns {Array<{ chatId: string, text: string, timestamp: number }>}
 */
export function getQueuedCommands() {
  return [...commandQueue];
}

// ── Monitor Lifecycle ────────────────────────────────────────────────────────

/**
 * Check if the bosun process is running.
 * @returns {boolean}
 */
export function isMonitorRunning() {
  return readMonitorPid() !== null;
}

/**
 * Ensure bosun is running. If not, start it and wait until it's healthy.
 * Returns immediately if monitor is already running. Coalesces concurrent calls
 * so only one monitor start happens at a time.
 * @param {string} reason - Human-readable reason for starting the monitor.
 * @returns {Promise<void>}
 */
export async function ensureMonitorRunning(reason) {
  // Already running
  if (readMonitorPid()) return;

  // A live daemon-child is already managing monitor startup — don't spawn a
  // competing one. The daemon's own restart loop will surface the monitor PID
  // once it is healthy.
  if (readDaemonPid()) {
    log("info", `daemon-child already alive — skipping spawn (reason: ${reason})`);
    return;
  }

  // Another call is already starting the monitor — piggyback on it
  if (monitorStartPromise) {
    log("info", `waiting for in-progress monitor start (reason: ${reason})`);
    return monitorStartPromise;
  }

  recordMonitorRestartAttempt();

  monitorStartPromise = startAndWaitForMonitor(reason).catch((err) => {
    recordMonitorCrashEvent();
    throw err;
  });
  try {
    await monitorStartPromise;
  } finally {
    monitorStartPromise = null;
  }
}

/**
 * Start bosun as a detached background process and wait for it to
 * become healthy (PID file written and process alive).
 * @param {string} reason
 * @returns {Promise<void>}
 */
async function startAndWaitForMonitor(reason) {
  log("info", `starting bosun (reason: ${reason})`);

  // If sentinel is currently polling, release the sentinel lock.
  // The monitor's telegram-bot.mjs will acquire its own poll lock.
  const wasPolling = polling;
  if (wasPolling) {
    polling = false;
    if (pollAbort) {
      try {
        pollAbort.abort();
      } catch {
        /* ok */
      }
    }
    await releaseSentinelPollLock();
    log("info", "released sentinel poll lock for monitor startup");
  }

  // Ensure log directory exists for daemon output
  const daemonLog = resolve(__dirname, "..", "logs", "daemon.log");
  try {
    mkdirSync(dirname(daemonLog), { recursive: true });
  } catch {
    /* ok */
  }

  // Start cli.mjs as a detached daemon child
  // Propagate BOSUN_DIR and REPO_ROOT so the spawned child can find config
  // and resolve the repo root correctly (matching startDaemon() in cli.mjs).
  const spawnEnv = { ...process.env, BOSUN_DAEMON: "1" };
  if (!spawnEnv.BOSUN_DIR) {
    // Derive config dir from __dirname (bosun module root) or standard locations
    const possibleConfigDirs = [
      process.env.APPDATA ? resolve(process.env.APPDATA, "bosun") : null,
      process.env.USERPROFILE ? resolve(process.env.USERPROFILE, "bosun") : null,
      process.env.HOME ? resolve(process.env.HOME, "bosun") : null,
    ].filter(Boolean);
    for (const dir of possibleConfigDirs) {
      if (existsSync(dir)) {
        spawnEnv.BOSUN_DIR = dir;
        break;
      }
    }
  }
  if (!spawnEnv.REPO_ROOT && repoRoot) {
    spawnEnv.REPO_ROOT = repoRoot;
  }
  const child = spawn(
    process.execPath,
    [
      "--max-old-space-size=4096",
      resolve(__dirname, "..", "cli.mjs"),
      "--daemon-child",
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: process.platform === "win32",
      env: spawnEnv,
      // Use repoRoot if it has a .git dir; otherwise use homedir so spawn
      // never inherits a non-existent or non-repo cwd.
      cwd: existsSync(resolve(repoRoot, ".git")) ? repoRoot : os.homedir(),
    },
  );

  child.on("error", (err) => {
    log("error", `monitor spawn error: ${err.message}`);
  });

  child.unref();

  const spawnedPid = child.pid;
  if (!spawnedPid) {
    throw new Error("bosun failed to spawn (no PID)");
  }

  log("info", `monitor spawned (PID ${spawnedPid}), waiting for health...`);

  // Wait for the monitor to become healthy (PID file written + process alive)
  const deadline = Date.now() + MONITOR_START_TIMEOUT_MS;
  let startupHandoffLogged = false;
  while (Date.now() < deadline) {
    await sleep(MONITOR_HEALTH_POLL_MS);

    const alivePid = readMonitorPid();
    if (alivePid) {
      log("info", `monitor is healthy (PID ${alivePid})`);
      lastMonitorStartAt = Date.now();
      saveRecoveryState();
      // Transition to companion mode
      await transitionToCompanion(alivePid);
      return;
    }

    // Check if spawned process died prematurely
    if (!isProcessAlive(spawnedPid)) {
      const daemonPid = readDaemonPid();
      if (daemonPid && daemonPid !== spawnedPid) {
        if (!startupHandoffLogged) {
          startupHandoffLogged = true;
          log(
            "info",
            `startup handoff detected — bootstrap PID ${spawnedPid} exited while daemon PID ${daemonPid} is alive; continuing health wait`,
          );
        }
        continue;
      }
      throw new Error(
        `bosun process died during startup (PID ${spawnedPid})`,
      );
    }
  }

  throw new Error(
    `bosun did not become healthy within ${MONITOR_START_TIMEOUT_MS / 1000}s`,
  );
}

// ── Mode Transitions ─────────────────────────────────────────────────────────

/**
 * Transition to standalone mode. Starts polling for Telegram updates directly.
 * @param {string} reason
 */
async function transitionToStandalone(reason) {
  if (mode === "standalone" && polling) {
    log("debug", `already in standalone mode (${reason})`);
    return;
  }

  log("info", `transitioning to standalone mode: ${reason}`);
  mode = "standalone";

  // Debounced handoff check to avoid racing monitor startup
  const canStartPolling = await canStartSentinelPolling();
  if (!canStartPolling) {
    log(
      "info",
      "main bot ownership/polling still active — skipping sentinel poll start",
    );
    return;
  }

  const ownerClaim = await claimTelegramPollOwner("telegram-sentinel", {
    ttlMs: SENTINEL_POLL_OWNER_TTL_MS,
  });
  if (!ownerClaim?.ok) {
    const activeOwner =
      ownerClaim?.owner && ownerClaim.owner.owner
        ? `${ownerClaim.owner.owner} (pid ${ownerClaim.owner.pid})`
        : "another active poll owner";
    log("info", `sentinel poll owner claim denied — ${activeOwner}`);
    return;
  }

  // Acquire sentinel poll lock and start polling
  const lockAcquired = await acquireSentinelPollLock();
  if (!lockAcquired) {
    await releaseTelegramPollOwner("telegram-sentinel").catch(() => {});
    log(
      "warn",
      "failed to acquire sentinel poll lock — another sentinel may be running",
    );
    return;
  }

  // Clear stale updates before starting the loop
  try {
    const stale = await pollUpdates();
    for (const u of stale) {
      lastUpdateId = Math.max(lastUpdateId, u.update_id);
    }
    if (stale.length > 0) {
      log("info", `skipped ${stale.length} stale updates`);
    }
  } catch {
    /* best effort */
  }

  polling = true;
  consecutivePollErrors = 0;

  // Fire polling loop (non-blocking)
  pollLoop().catch((err) => {
    log("error", `poll loop crashed: ${err.message}`);
    polling = false;
    releaseTelegramPollOwner("telegram-sentinel").catch(() => {});
  });

  await writeHeartbeat();
}

/**
 * Transition to companion mode. Stops polling and lets telegram-bot.mjs handle it.
 * @param {number} monitorPid
 */
async function transitionToCompanion(monitorPid) {
  log("info", `transitioning to companion mode (monitor PID ${monitorPid})`);
  mode = "companion";

  // Monitor is healthy — reset circuit breaker state
  consecutiveRecoveryFailures = 0;
  recoveryCircuitOpen = false;
  recoveryCircuitOpenedAt = 0;

  // Stop polling if active
  polling = false;
  if (pollAbort) {
    try {
      pollAbort.abort();
    } catch {
      /* ok */
    }
  }
  await releaseSentinelPollLock();
  await releaseTelegramPollOwner("telegram-sentinel").catch(() => {});

  await writeHeartbeat();
}

/**
 * Check if the main telegram-bot.mjs poll lock is held by a live process.
 * @returns {Promise<boolean>}
 */
async function isMainBotPolling() {
  try {
    if (!existsSync(MONITOR_POLL_LOCK_FILE)) return false;
    const raw = await readFile(MONITOR_POLL_LOCK_FILE, "utf8");
    if (!raw || !raw.trim()) return false;
    const data = JSON.parse(raw);
    const pid = Number(data?.pid);
    return isProcessAlive(pid);
  } catch {
    return false;
  }
}

async function isMainBotOwnerActive() {
  const activeOwner = await getActiveTelegramPollOwner().catch(() => null);
  return Boolean(activeOwner && activeOwner.owner === "telegram-bot");
}

async function canStartSentinelPolling() {
  for (let attempt = 0; attempt < POLL_OWNER_HANDOFF_CHECKS; attempt += 1) {
    const [mainPolling, mainOwnerActive] = await Promise.all([
      isMainBotPolling(),
      isMainBotOwnerActive(),
    ]);
    if (mainPolling || mainOwnerActive) return false;
    if (attempt < POLL_OWNER_HANDOFF_CHECKS - 1) {
      await sleep(POLL_OWNER_HANDOFF_DELAY_MS);
    }
  }
  return true;
}

// ── Health Monitoring ────────────────────────────────────────────────────────

/**
 * Periodic health check for bosun. Runs every HEALTH_CHECK_INTERVAL_MS.
 */
async function healthCheck() {
  const monPid = readMonitorPid();

  if (mode === "companion") {
    if (!monPid) {
      // Monitor died while in companion mode — send crash notification and go standalone.
      // Before acting, verify the daemon-child isn't mid-restart (PID files can lag).
      const daemonStillAlive = readDaemonPid();
      if (daemonStillAlive) {
        log(
          "info",
          `monitor PID gone but daemon-child (PID ${daemonStillAlive}) is alive — waiting for daemon-managed restart`,
        );
        return;
      }
      log("warn", "monitor process died — transitioning to standalone");
      removeMonitorPidFiles();
      recordMonitorCrashEvent();

      const recentStartAge =
        lastMonitorStartAt > 0 ? Date.now() - lastMonitorStartAt : null;
      const rapidCrash =
        Number.isFinite(recentStartAge) &&
        recentStartAge <= sentinelConfig.monitorStartGraceMs;

      // Notify user
      const host = os.hostname();
      const tag = projectName ? `[${projectName}]` : "";
      await sendTelegram(
        telegramChatId,
        [
          `:zap: ${tag} bosun crashed`,
          "",
          `Host: \`${host}\``,
          `Time: ${new Date().toISOString()}`,
          rapidCrash
            ? `Detected rapid crash (${formatUptime(recentStartAge)} after startup).`
            : "",
          "",
          "Sentinel is switching to standalone mode and will attempt automatic recovery.",
        ].join("\n"),
        { parseMode: "Markdown" },
      );

      await transitionToStandalone("monitor process died");
      await attemptMonitorRecovery("monitor crashed in companion mode");
    }
  } else if (mode === "standalone") {
    if (monPid) {
      // Monitor appeared while in standalone mode (started externally)
      log(
        "info",
        `monitor detected (PID ${monPid}) — switching to companion mode`,
      );
      await transitionToCompanion(monPid);
    } else {
      // Check if main bot has acquired the poll lock (edge case: monitor starting up)
      const mainPolling = await isMainBotPolling();
      if (mainPolling && polling) {
        log("info", "main bot is polling — stopping sentinel polling");
        polling = false;
        if (pollAbort) {
          try {
            pollAbort.abort();
          } catch {
            /* ok */
          }
        }
        await releaseSentinelPollLock();
        await releaseTelegramPollOwner("telegram-sentinel").catch(() => {});
      } else if (!mainPolling && !polling) {
        // Neither is polling — sentinel should resume
        log("info", "no poller active — resuming sentinel polling");
        await transitionToStandalone("no active poller detected");
      }

      if (sentinelConfig.autoRestartMonitor && !monitorStartPromise) {
        // If a daemon-child process is still alive, it manages its own monitor
        // restart loop. Don't spawn a competing daemon-child from sentinel.
        const daemonPid = readDaemonPid();
        if (daemonPid) {
          log(
            "info",
            `daemon-child (PID ${daemonPid}) is alive and managing monitor restart — skipping sentinel recovery`,
          );
        } else {
          await attemptMonitorRecovery("monitor not running during standalone health check");
        }
      }
    }
  }

  // Clean up stale PID files
  const sentinelPid = readSentinelPid();
  if (sentinelPid && sentinelPid !== process.pid) {
    // Another sentinel is alive — we shouldn't be running
    log(
      "warn",
      `another sentinel is alive (PID ${sentinelPid}) — stopping this instance`,
    );
    stopSentinel();
    return;
  }

  await writeHeartbeat();
}

// ── Heartbeat ────────────────────────────────────────────────────────────────

/**
 * Write the sentinel heartbeat file.
 * @returns {Promise<void>}
 */
async function writeHeartbeat() {
  /** @type {import("./telegram-sentinel.mjs").SentinelHeartbeat} */
  const heartbeat = {
    pid: process.pid,
    startedAt,
    mode,
    monitorPid: readMonitorPid(),
    lastCheck: new Date().toISOString(),
    commandsQueued: commandQueue.length,
    commandsProcessed,
  };

  try {
    mkdirSync(dirname(SENTINEL_HEARTBEAT_FILE), { recursive: true });
    await writeFile(
      SENTINEL_HEARTBEAT_FILE,
      JSON.stringify(heartbeat, null, 2),
      "utf8",
    );
  } catch (err) {
    log("warn", `heartbeat write failed: ${err.message}`);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the Telegram sentinel. This is the main entry point.
 *
 * @param {object} [options]
 * @param {boolean} [options.skipExistingCheck] - Skip checking for an existing sentinel.
 * @returns {Promise<void>}
 */
export async function startSentinel(options = {}) {
  if (running) {
    log("warn", "sentinel is already running");
    return;
  }

  initEnv();

  if (!telegramToken || !telegramChatId) {
    log(
      "error",
      "cannot start sentinel: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured",
    );
    console.error(
      `${TAG} Set these in .env (project root) or as environment variables.`,
    );
    process.exit(1);
  }

  // Ensure cache directory exists
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(dirname(MONITOR_PID_FILE), { recursive: true });

  // Check for existing sentinel
  if (!options.skipExistingCheck) {
    const existingPid = readSentinelPid();
    if (existingPid && existingPid !== process.pid) {
      console.error(
        `${TAG} Another sentinel is already running (PID ${existingPid}). Use --stop first.`,
      );
      process.exit(1);
    }
  }

  running = true;
  startedAt = new Date().toISOString();
  loadRecoveryState();
  writePidFile(resolve(cacheDir, "telegram-sentinel.pid"), process.pid);

  log("info", `sentinel started (PID ${process.pid})`);

  // Determine initial mode
  const monPid = readMonitorPid();
  if (monPid) {
    log(
      "info",
      `bosun already running (PID ${monPid}) — starting in companion mode`,
    );
    await transitionToCompanion(monPid);
  } else {
    log("info", "bosun not running — starting in standalone mode");
    await transitionToStandalone("initial startup");
  }

  // Set up periodic health checks
  healthCheckTimer = setInterval(() => {
    healthCheck().catch((err) => {
      log("error", `health check error: ${err.message}`);
    });
  }, HEALTH_CHECK_INTERVAL_MS);

  // Set up periodic heartbeat writes
  heartbeatTimer = setInterval(() => {
    writeHeartbeat().catch(() => {});
  }, HEALTH_CHECK_INTERVAL_MS);

  // Initial heartbeat
  await writeHeartbeat();

  // Register shutdown handlers
  const shutdown = () => {
    log("info", "received shutdown signal");
    stopSentinel();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", (err) => {
    log("error", `uncaught exception: ${err.message}\n${err.stack}`);
    // Attempt crash notification
    sendTelegram(
      telegramChatId,
      `:shield::close: Sentinel crashed: ${err.message}\nHost: \`${os.hostname()}\``,
      { parseMode: "Markdown" },
    ).catch(() => {});
    stopSentinel();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log("error", `unhandled rejection: ${reason}`);
  });
}

/**
 * Stop the sentinel gracefully. Cleans up timers, locks, and PID files.
 */
export function stopSentinel() {
  if (!running) return;
  running = false;
  polling = false;

  // Abort any pending poll
  if (pollAbort) {
    try {
      pollAbort.abort();
    } catch {
      /* ok */
    }
  }

  // Clear timers
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  // Release locks and PID files
  releaseSentinelPollLock().catch(() => {});
  releaseTelegramPollOwner("telegram-sentinel").catch(() => {});
  removeSentinelPidFiles();

  // Clean up heartbeat file
  try {
    if (existsSync(SENTINEL_HEARTBEAT_FILE))
      unlinkSync(SENTINEL_HEARTBEAT_FILE);
  } catch {
    /* best effort */
  }

  log("info", "sentinel stopped");
}

/**
 * Get the current sentinel status.
 * @returns {SentinelStatus}
 */
export function getSentinelStatus() {
  return {
    pid: process.pid,
    running,
    startedAt,
    mode,
    monitorPid: readMonitorPid(),
    polling,
    commandsQueued: commandQueue.length,
    commandsProcessed,
    consecutivePollErrors,
    uptime: Date.now() - new Date(startedAt).getTime(),
  };
}

export function getSentinelRecoveryStatus() {
  const now = Date.now();
  const crashes = pruneTimestamps(monitorCrashEvents, now).length;
  const restarts = pruneTimestamps(monitorRestartAttempts, now).length;
  return {
    crashLoopDetected: isCrashLoopDetected(now),
    crashesInWindow: crashes,
    restartsInWindow: restarts,
    crashLoopThreshold: sentinelConfig.crashLoopThreshold,
    crashLoopWindowMs: sentinelConfig.crashLoopWindowMs,
    lastRepairAt,
    recoveryInProgress,
  };
}

export function __setRecoveryStateForTest(state = {}) {
  monitorRestartAttempts = Array.isArray(state.monitorRestartAttempts)
    ? [...state.monitorRestartAttempts]
    : [];
  monitorCrashEvents = Array.isArray(state.monitorCrashEvents)
    ? [...state.monitorCrashEvents]
    : [];
  lastRepairAt = Number(state.lastRepairAt) || 0;
  lastMonitorStartAt = Number(state.lastMonitorStartAt) || 0;
  monitorManualStopUntil = Number(state.monitorManualStopUntil) || 0;
}

// ── Logging ──────────────────────────────────────────────────────────────────

/**
 * Simple structured logger. All output goes to stdout/stderr with a tag prefix.
 * @param {"info" | "warn" | "error" | "debug"} level
 * @param {string} message
 */
function log(level, message) {
  const timestamp = new Date().toISOString();
  const prefix = `${timestamp} ${TAG}`;
  switch (level) {
    case "error":
      console.error(`${prefix} ERROR: ${message}`);
      break;
    case "warn":
      console.warn(`${prefix} WARN: ${message}`);
      break;
    case "debug":
      if (process.env.SENTINEL_DEBUG === "1") {
        console.log(`${prefix} DEBUG: ${message}`);
      }
      break;
    default:
      console.log(`${prefix} ${message}`);
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────

/**
 * Format a duration in milliseconds to a human-readable string.
 * @param {number} ms
 * @returns {string}
 */
function formatUptime(ms) {
  if (ms < 0) ms = 0;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Sleep for the given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Type Definitions (JSDoc) ─────────────────────────────────────────────────

/**
 * @typedef {object} SentinelHeartbeat
 * @property {number} pid
 * @property {string} startedAt
 * @property {"standalone" | "companion"} mode
 * @property {number | null} monitorPid
 * @property {string} lastCheck
 * @property {number} commandsQueued
 * @property {number} commandsProcessed
 */

/**
 * @typedef {object} SentinelStatus
 * @property {number} pid
 * @property {boolean} running
 * @property {string} startedAt
 * @property {"standalone" | "companion"} mode
 * @property {number | null} monitorPid
 * @property {boolean} polling
 * @property {number} commandsQueued
 * @property {number} commandsProcessed
 * @property {number} consecutivePollErrors
 * @property {number} uptime
 */

// ── CLI Entry Point ──────────────────────────────────────────────────────────

const isDirectExecution = (() => {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const argv1 = process.argv[1];
    if (!argv1) return false;
    // Normalize paths for comparison (Windows backslash vs posix)
    const normalizedThis = thisFile.replace(/\\/g, "/").toLowerCase();
    const normalizedArgv = resolve(argv1).replace(/\\/g, "/").toLowerCase();
    return normalizedThis === normalizedArgv;
  } catch {
    return false;
  }
})();

if (isDirectExecution) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
  telegram-sentinel — Always-on Telegram command listener for bosun

  USAGE
    node telegram-sentinel.mjs [options]

  OPTIONS
    --stop       Stop a running sentinel
    --status     Check sentinel status
    --help       Show this help

  ENVIRONMENT
    TELEGRAM_BOT_TOKEN    Telegram bot token (or set in .env)
    TELEGRAM_CHAT_ID      Authorized chat ID (or set in .env)
    SENTINEL_DEBUG=1      Enable debug logging

  The sentinel monitors bosun and handles Telegram commands
  even when the main process is not running.
    `);
    process.exit(0);
  }

  if (args.includes("--stop")) {
    const pid = readSentinelPid();
    if (!pid) {
      console.log("  No sentinel running.");
      removeSentinelPidFiles();
      process.exit(0);
    }
    console.log(`  Stopping sentinel (PID ${pid})...`);
    try {
      process.kill(pid, "SIGTERM");
      let gone = false;
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        if (!isProcessAlive(pid)) {
          gone = true;
          break;
        }
      }
      if (!gone) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* ok */
        }
      }
      removeSentinelPidFiles();
      console.log("  ✓ Sentinel stopped.");
    } catch (err) {
      console.error(`  Failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.includes("--status")) {
    const pid = readSentinelPid();
    if (pid) {
      console.log(`  Sentinel is running (PID ${pid})`);
      try {
        const hb = readHeartbeatSnapshot();
        if (hb) {
          console.log(`  Mode: ${hb.mode}`);
          console.log(`  Monitor PID: ${hb.monitorPid || "none"}`);
          console.log(`  Last check: ${hb.lastCheck}`);
          console.log(`  Commands processed: ${hb.commandsProcessed}`);
        }
      } catch {
        /* best effort */
      }
    } else {
      console.log("  Sentinel is not running.");
      removeSentinelPidFiles();
    }
    process.exit(0);
  }

  // Default: start sentinel
  startSentinel().catch((err) => {
    console.error(`${TAG} Fatal: ${err.message}`);
    process.exit(1);
  });
}
