/**
 * telegram-bot.mjs — Telegram surface controller for Bosun.
 *
 * Polls Telegram Bot API for incoming messages, routes slash commands to
 * built-in handlers, and forwards free-text plus control actions through the
 * canonical harness API surface.
 *
 * Architecture:
 *   Telegram → getUpdates long-poll → handleUpdate()
 *     ├─ /command → built-in handler (fast, no agent)
 *     └─ free-text → harness session API → canonical session manager/runtime
 *
 * Security: Only accepts messages from the configured TELEGRAM_CHAT_ID.
 *
 * Transitional architecture note:
 * Telegram remains a surface controller and poll-owner runtime, but provider
 * switching, session inspection, approvals, and thread control must route
 * through `telegram/harness-api-client.mjs` and the canonical server harness
 * routes. UI-server lifecycle is owned by monitor/runtime composition and
 * injected here as bounded URL/token/tunnel helper callbacks only.
 */

import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { resolveRepoRoot } from "../config/repo-root.mjs";
import {
  claimTelegramPollOwner,
  releaseTelegramPollOwner,
} from "./telegram-poll-owner.mjs";
import { fetchWithFallback } from "../infra/fetch-runtime.mjs";
import { setComponentStatus } from "../infra/health-status.mjs";
import {
  getKanbanAdapter,
  setKanbanBackend,
  getAvailableBackends,
  getKanbanBackendName,
} from "../kanban/kanban-adapter.mjs";
import {
  getWorktreeManager,
  listActiveWorktrees as listManagedWorktrees,
  pruneStaleWorktrees,
  getWorktreeStats,
} from "../workspace/worktree-manager.mjs";
import { loadExecutorConfig } from "../config/config.mjs";
import { generateWeeklyAgentWorkReport } from "../agent/agent-work-report.mjs";
import { resolvePwshRuntime } from "../shell/pwsh-runtime.mjs";
import { createExecutorHealthRegionCache } from "./executor-health-region-cache.mjs";
import { createStickyMenuStateManager } from "./sticky-menu-state.mjs";
import {
  createTelegramHarnessApiClient,
  createTelegramWorkspaceApiClient,
  requestTelegramJsonApi,
} from "./harness-api-client.mjs";
import {
  loadWorkspaceRegistry,
  formatRegistryDiagnostics,
  getDefaultModelPriority,
  getLocalWorkspace,
} from "../workspace/workspace-registry.mjs";
import {
  claimSharedWorkspace,
  formatSharedWorkspaceDetail,
  formatSharedWorkspaceSummary,
  getSharedAvailabilityMap,
  loadSharedWorkspaceRegistry as loadSharedRegistry,
  releaseSharedWorkspace,
  resolveSharedWorkspace,
  sweepExpiredLeases as sweepSharedLeases,
} from "../workspace/shared-workspace-registry.mjs";
import {
  listWorkspaces as listManagedWorkspaces,
  getActiveWorkspace as getActiveManagedWs,
  createWorkspace as createManagedWs,
  removeWorkspace as removeManagedWs,
  setActiveWorkspace as setActiveManagedWs,
  addRepoToWorkspace as addRepoToManagedWs,
  removeRepoFromWorkspace as removeRepoFromManagedWs,
  pullWorkspaceRepos as pullManagedWsRepos,
  detectWorkspaces as detectManagedWs,
  initializeWorkspaces as initManagedWs,
  mergeDetectedWorkspaces,
} from "../workspace/workspace-manager.mjs";

// Convenience aliases used in existing /workspace command
const listLocalWorkspaces = listManagedWorkspaces;
const getActiveLocalWorkspace = getActiveManagedWs;
const setActiveLocalWorkspace = setActiveManagedWs;
import {
  buildLocalPresence,
  formatCoordinatorSummary,
  formatPresenceMessage,
  formatPresenceSummary,
  initPresence,
  notePresence,
  parsePresenceMessage,
} from "../infra/presence.mjs";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));

function isWslInteropRuntime() {
  return Boolean(
    process.env.WSL_DISTRO_NAME
    || process.env.WSL_INTEROP
    || (process.platform === "win32"
      && String(process.env.HOME || "")
        .trim()
        .startsWith("/home/")),
  );
}

function resolveTelegramConfigDir() {
  if (process.env.BOSUN_HOME) return resolve(process.env.BOSUN_HOME);
  if (process.env.BOSUN_DIR) return resolve(process.env.BOSUN_DIR);

  const preferWindowsDirs = process.platform === "win32" && !isWslInteropRuntime();
  const baseDir = preferWindowsDirs
    ? process.env.APPDATA
      || process.env.LOCALAPPDATA
      || process.env.USERPROFILE
      || process.env.HOME
      || homedir()
    : process.env.HOME
      || process.env.XDG_CONFIG_HOME
      || process.env.USERPROFILE
      || process.env.APPDATA
      || process.env.LOCALAPPDATA
      || homedir();
  return resolve(baseDir, "bosun");
}
const repoRoot = resolveRepoRoot();
const BosunDir = __dirname;
const statusPath = resolve(repoRoot, ".cache", "orchestrator-status.json");
const telegramPollLockPath = resolve(
  repoRoot,
  ".cache",
  "telegram-getupdates.lock",
);
const telegramPollConflictStatePath = resolve(
  repoRoot,
  ".cache",
  "telegram-getupdates-conflict.json",
);
const liveDigestStatePath = resolve(repoRoot, ".cache", "ve-live-digest.json");
const statusBoardStatePath = resolve(
  repoRoot,
  ".cache",
  "ve-status-board.json",
);
const fwCooldownPath = resolve(repoRoot, ".cache", "ve-fw-cooldown.json");
const FW_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Message History Auto-Cleanup ──────────────────────────────────────────
const msgHistoryPath = resolve(repoRoot, ".cache", "ve-message-history.json");
// Days to keep bot messages in chat. 0 = disabled. Default: 3 days.
const HISTORY_RETENTION_DAYS = (() => {
  const v = Number(process.env.TELEGRAM_HISTORY_RETENTION_DAYS ?? "3");
  return Number.isFinite(v) && v > 0 ? v : 0;
})();
const HISTORY_RETENTION_MS = HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const HISTORY_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // run every 6 hours
const HISTORY_INITIAL_DELAY_MS = 2 * 60 * 1000;         // wait 2 min after boot
const HISTORY_MAX_TRACKED = 10_000;                      // safety cap

/** Resolve orchestrator PS1 path (region tracking functions). */
function resolveVeKanbanPs1Path() {
  for (const candidate of [
    resolve(BosunDir, "orchestrator.ps1"),
    resolve(repoRoot, "scripts", "bosun", "orchestrator.ps1"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return resolve(BosunDir, "orchestrator.ps1");
}

// ── Configuration ────────────────────────────────────────────────────────────

let telegramToken = process.env.TELEGRAM_BOT_TOKEN;
let telegramChatId = process.env.TELEGRAM_CHAT_ID;
let TELEGRAM_API_BASE = String(
  process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org",
).replace(/\/+$/, "");
const POLL_TIMEOUT_S = 30; // long-poll timeout
const MAX_MESSAGE_LEN = 4000; // Telegram max is 4096, leave margin
const STREAM_INLINE_FINAL_RESPONSE_MAX = 1200;
const POLL_ERROR_BACKOFF_MS = 5000;
const TELEGRAM_FETCH_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
// 409 Conflict cooldown: minimum 60 s, default 15 minutes
const TELEGRAM_POLL_CONFLICT_COOLDOWN_MS = Math.max(
  60_000,
  Number(process.env.TELEGRAM_POLL_CONFLICT_COOLDOWN_MS) || 900_000,
);
const TELEGRAM_POLL_OWNER_TTL_MS = Math.max(
  30_000,
  Number(process.env.TELEGRAM_POLL_OWNER_TTL_MS || "120000") || 120_000,
);
let TELEGRAM_HTTP_TIMEOUT_MS = Math.max(
  2000,
  Number(process.env.TELEGRAM_HTTP_TIMEOUT_MS || "15000") || 15000,
);
let TELEGRAM_RETRY_ATTEMPTS = Math.max(
  1,
  Number(process.env.TELEGRAM_RETRY_ATTEMPTS || "4") || 4,
);
let TELEGRAM_RETRY_BASE_MS = Math.max(
  100,
  Number(process.env.TELEGRAM_RETRY_BASE_MS || "600") || 600,
);
let TELEGRAM_CURL_CONNECT_TIMEOUT_SEC = Math.max(
  2,
  Number(process.env.TELEGRAM_CURL_CONNECT_TIMEOUT_SEC || "8") || 8,
);
let TELEGRAM_CURL_POLL_TIMEOUT_SEC = Math.max(
  1,
  Number(process.env.TELEGRAM_CURL_POLL_TIMEOUT_SEC || "5") || 5,
);
let TELEGRAM_CURL_FALLBACK = !["0", "false", "no"].includes(
  String(
    process.env.TELEGRAM_CURL_FALLBACK ||
      (process.platform === "win32" ? "false" : "true"),
  ).toLowerCase(),
);
let telegramAllowedChatIds = new Set();
let telegramPreferCurlUntilMs = 0;
let lastPollErrorLogAtMs = 0;
let lastFallbackSwitchLogMs = 0;
let pollFailureStreak = 0;
let telegramApiReachable = null; // null = unknown, true/false after probe
let pollLockLostAtMs = 0;
let pollLockRetryBackoffMs = 2000;

// ── 409 Conflict Cooldown State ──────────────────────────────────────────────

/**
 * Read persisted 409 conflict state from disk.
 * Returns { untilMs, reason, pid } or null if missing or corrupt.
 */
function readTelegramPollConflictState() {
  try {
    if (!existsSync(telegramPollConflictStatePath)) return null;
    const raw = readFileSync(telegramPollConflictStatePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.untilMs !== "number") return null;
    return {
      untilMs: parsed.untilMs,
      reason: parsed.reason || "",
      pid: Number(parsed.pid) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Persist a 409 conflict cooldown state to disk (best-effort).
 * @param {number} untilMs - Epoch ms until which polling should be suppressed.
 * @param {string} reason - Human-readable reason for the cooldown.
 */
function writeTelegramPollConflictState(untilMs, reason = "409 Conflict") {
  try {
    mkdirSync(resolve(repoRoot, ".cache"), { recursive: true });
    writeFileSync(
      telegramPollConflictStatePath,
      JSON.stringify({ untilMs, reason, updatedAt: new Date().toISOString(), pid: process.pid }),
      "utf8",
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Remove the 409 conflict state file (best-effort, called on successful poll).
 */
function clearTelegramPollConflictState() {
  try {
    unlinkSync(telegramPollConflictStatePath);
  } catch {
    /* best-effort */
  }
}

async function ensureTelegramPollOwnership() {
  const ownerClaim = await claimTelegramPollOwner("telegram-bot", {
    ttlMs: TELEGRAM_POLL_OWNER_TTL_MS,
  }).catch(() => null);
  if (!ownerClaim?.ok) {
    return false;
  }
  const lockOk = await acquireTelegramPollLock("telegram-bot");
  if (!lockOk) {
    await releaseTelegramPollOwner("telegram-bot").catch(() => {});
    return false;
  }
  return true;
}

function parseAllowedTelegramIds(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAuthorizedTelegramActor(chatId, fromId) {
  if (!telegramAllowedChatIds || telegramAllowedChatIds.size === 0) return true;
  if (chatId && telegramAllowedChatIds.has(String(chatId))) return true;
  if (fromId && telegramAllowedChatIds.has(String(fromId))) return true;
  return false;
}

function refreshTelegramConfigFromEnv() {
  telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  telegramChatId = process.env.TELEGRAM_CHAT_ID;
  TELEGRAM_API_BASE = String(
    process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org",
  ).replace(/\/+$/, "");
  TELEGRAM_HTTP_TIMEOUT_MS = Math.max(
    2000,
    Number(process.env.TELEGRAM_HTTP_TIMEOUT_MS || "15000") || 15000,
  );
  TELEGRAM_RETRY_ATTEMPTS = Math.max(
    1,
    Number(process.env.TELEGRAM_RETRY_ATTEMPTS || "4") || 4,
  );
  TELEGRAM_RETRY_BASE_MS = Math.max(
    100,
    Number(process.env.TELEGRAM_RETRY_BASE_MS || "600") || 600,
  );
  TELEGRAM_CURL_CONNECT_TIMEOUT_SEC = Math.max(
    2,
    Number(process.env.TELEGRAM_CURL_CONNECT_TIMEOUT_SEC || "8") || 8,
  );
  TELEGRAM_CURL_POLL_TIMEOUT_SEC = Math.max(
    1,
    Number(process.env.TELEGRAM_CURL_POLL_TIMEOUT_SEC || "5") || 5,
  );
  TELEGRAM_CURL_FALLBACK = !["0", "false", "no"].includes(
    String(
      process.env.TELEGRAM_CURL_FALLBACK ||
        (process.platform === "win32" ? "false" : "true"),
    ).toLowerCase(),
  );
  const allowedIds = new Set([
    ...parseAllowedTelegramIds(
      process.env.TELEGRAM_ALLOWED_CHAT_IDS || process.env.TELEGRAM_CHAT_IDS,
    ),
    ...parseAllowedTelegramIds(process.env.TELEGRAM_CHAT_ID),
  ]);
  telegramAllowedChatIds = allowedIds;
}
const AGENT_TIMEOUT_MS = (() => {
  const minRaw = Number(process.env.TELEGRAM_AGENT_TIMEOUT_MIN || "");
  if (Number.isFinite(minRaw) && minRaw > 0) return minRaw * 60 * 1000;
  const raw = Number(
    process.env.TELEGRAM_AGENT_TIMEOUT_MS ||
      process.env.PRIMARY_AGENT_TIMEOUT_MS ||
      process.env.INTERNAL_EXECUTOR_TIMEOUT_MS ||
      "",
  );
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 90 * 60 * 1000; // 90 min default
})();
let telegramPollLockHeld = false;
const presenceIntervalSec = Number(
  process.env.TELEGRAM_PRESENCE_INTERVAL_SEC || "60",
);
const presenceTtlSec = Number(
  process.env.TELEGRAM_PRESENCE_TTL_SEC || String(presenceIntervalSec * 3),
);
const presenceDisabled = ["1", "true", "yes"].includes(
  String(process.env.TELEGRAM_PRESENCE_DISABLED || "").toLowerCase(),
);
const presenceSilent = ["1", "true", "yes"].includes(
  String(process.env.TELEGRAM_PRESENCE_SILENT || "").toLowerCase(),
);
const presenceOnlyOnChange = ["1", "true", "yes"].includes(
  String(process.env.TELEGRAM_PRESENCE_ONLY_ON_CHANGE || "true").toLowerCase(),
);
const presenceChatId = process.env.TELEGRAM_PRESENCE_CHAT_ID;
const presenceTtlMs = Number.isFinite(presenceTtlSec)
  ? Math.max(0, presenceTtlSec * 1000)
  : 0;

console.log(
  `[telegram-bot] agent timeout set to ${Math.round(AGENT_TIMEOUT_MS / 60000)} min`,
);

// ── Message Batching Configuration ──────────────────────────────────────────
const batchingEnabled = !["0", "false", "no"].includes(
  String(process.env.TELEGRAM_BATCH_NOTIFICATIONS || "true").toLowerCase(),
);
const batchIntervalSec = Number(
  process.env.TELEGRAM_BATCH_INTERVAL_SEC || "300",
); // 5 minutes default
const batchMaxSize = Number(process.env.TELEGRAM_BATCH_MAX_SIZE || "50");
// Priority threshold: only messages >= this priority bypass batching (1=critical, 2=error, 3=warning, 4=info, 5=debug)
const immediateThreshold = Number(
  process.env.TELEGRAM_IMMEDIATE_PRIORITY || "1",
);

// ── Live Digest Configuration ──────────────────────────────────────────────
// Instead of batching and flushing, we maintain a single "live" Telegram message
// per digest window that gets continuously edited as new events arrive.
const liveDigestEnabled = !["0", "false", "no"].includes(
  String(process.env.TELEGRAM_LIVE_DIGEST || "true").toLowerCase(),
);
const liveDigestWindowSec = Number(
  process.env.TELEGRAM_LIVE_DIGEST_WINDOW_SEC || "1200",
); // 20 minutes default
const liveDigestEditDebounceMs = Number(
  process.env.TELEGRAM_LIVE_DIGEST_DEBOUNCE_MS || "3000",
); // 3 second debounce on edits

// ── Status Board Configuration ─────────────────────────────────────────────
// A single pinned Telegram message that persists forever and is edited in-place
// to show the current orchestrator state. Replaces periodic "N-min Update"
// messages so the chat stays quiet while the board stays current 24/7.
const statusBoardEnabled = !["0", "false", "no"].includes(
  String(process.env.TELEGRAM_STATUS_BOARD || "true").toLowerCase(),
);
const statusBoardEditDebounceMs = Number(
  process.env.TELEGRAM_STATUS_BOARD_DEBOUNCE_MS || "2000",
);

function delayMs(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

const SAFE_DETACH_PREFIX = "[telegram-bot] async-detach";

function safeDetach(label, taskOrPromise) {
  const tag = label
    ? `${SAFE_DETACH_PREFIX}:${String(label)}`
    : SAFE_DETACH_PREFIX;
  try {
    const result =
      typeof taskOrPromise === "function" ? taskOrPromise() : taskOrPromise;
    Promise.resolve(result).catch((err) => {
      console.warn(`${tag} failed: ${err?.message || err}`);
    });
  } catch (err) {
    console.warn(`${tag} failed: ${err?.message || err}`);
  }
}

function shouldUseCurlPrimary() {
  return (
    TELEGRAM_CURL_FALLBACK &&
    hasCurlBinary() &&
    Date.now() < telegramPreferCurlUntilMs
  );
}

function shouldPinCurlFallback(operation) {
  return String(operation || "") !== "getUpdates";
}

function toErrorCode(err) {
  return String(
    err?.cause?.code || err?.code || err?.cause?.name || err?.name || "",
  ).toUpperCase();
}

function isRetryableCurlFailure(err) {
  const message = String(err?.message || err || "").toLowerCase();
  if (!message.includes("curl")) return false;
  if (/curl:\s*\((6|7|28|35|52|56)\)/.test(message)) return true;
  return [
    "timed out",
    "timeout",
    "failed to connect",
    "couldn't connect",
    "could not resolve",
    "empty reply",
    "network is unreachable",
    "ssl connection timeout",
  ].some((fragment) => message.includes(fragment));
}

function isRetryableNetworkError(err) {
  const code = toErrorCode(err);
  if (
    [
      "ABORTERROR",
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "ENOTFOUND",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(code)
  ) {
    return true;
  }
  return isRetryableCurlFailure(err);
}

function getPollBackoffMs() {
  return Math.min(
    60_000,
    POLL_ERROR_BACKOFF_MS * 2 ** Math.min(5, Math.max(0, pollFailureStreak - 1)),
  );
}

function resetPollFailureStreak() {
  pollFailureStreak = 0;
}

function markPollFailure() {
  pollFailureStreak += 1;
}

function shouldLogPollError(now = Date.now()) {
  if (now - lastPollErrorLogAtMs < 60_000) return false;
  lastPollErrorLogAtMs = now;
  return true;
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

let _hasCurlBinary = null;
function hasCurlBinary() {
  if (_hasCurlBinary !== null) return _hasCurlBinary;
  try {
    const probe = spawnSync("curl", ["--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    _hasCurlBinary = probe?.status === 0;
  } catch {
    _hasCurlBinary = false;
  }
  return _hasCurlBinary;
}

function createTelegramResponse(status, bodyText) {
  const text = String(bodyText || "");
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: { get: () => null },
    body: {
      cancel: async () => {},
    },
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text || "{}");
    },
  };
}

async function telegramApiFetchViaCurl(url, requestOptions = {}) {
  const {
    method: httpMethod = "POST",
    payload,
    timeoutMs = TELEGRAM_HTTP_TIMEOUT_MS,
    operation = "telegram-api",
  } = requestOptions;

  if (!hasCurlBinary()) {
    throw new Error("curl is not available for Telegram fallback");
  }

  const maxTimeSec = Math.max(5, Math.ceil(timeoutMs / 1000));
  const connectTimeSec = Math.max(
    2,
    Math.min(TELEGRAM_CURL_CONNECT_TIMEOUT_SEC, maxTimeSec - 1),
  );

  const args = [
    "--silent",
    "--show-error",
    "--location",
    "--request",
    String(httpMethod || "POST").toUpperCase(),
    "--connect-timeout",
    String(connectTimeSec),
    "--max-time",
    String(maxTimeSec),
    "--write-out",
    "\n__CODE__:%{http_code}",
    String(url),
  ];

  if (payload !== undefined) {
    args.push("--header", "Content-Type: application/json");
    args.push("--data", JSON.stringify(payload));
  }

  const result = spawnSync("curl", args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 8,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const errText = String(result.stderr || result.stdout || "").trim();
    throw new Error(
      `curl failed for ${operation}: ${errText || `exit ${result.status}`}`,
    );
  }

  const out = String(result.stdout || "");
  const marker = out.lastIndexOf("\n__CODE__:");
  if (marker === -1) {
    throw new Error(`curl response missing HTTP code marker for ${operation}`);
  }
  const body = out.slice(0, marker);
  const statusRaw = out.slice(marker + "\n__CODE__:".length).trim();
  const status = Number(statusRaw);
  if (!Number.isFinite(status)) {
    throw new Error(`invalid curl HTTP status for ${operation}: ${statusRaw}`);
  }
  return createTelegramResponse(status, body);
}

function parseRetryAfterMs(response) {
  const value = response?.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(30_000, seconds * 1000);
  }
  const absolute = Date.parse(value);
  if (!Number.isFinite(absolute)) return null;
  const delta = absolute - Date.now();
  return delta > 0 ? Math.min(30_000, delta) : null;
}

function calcRetryDelayMs(attempt, response) {
  const hinted = parseRetryAfterMs(response);
  if (hinted != null) return hinted;
  const expo = TELEGRAM_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * Math.min(1500, expo * 0.4));
  return Math.min(30_000, expo + jitter);
}

function createTelegramUrl(method, query = null) {
  const url = new URL(
    `/bot${telegramToken}/${method}`,
    `${TELEGRAM_API_BASE}/`,
  );
  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value == null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function telegramApiFetch(method, requestOptions = {}) {
  refreshTelegramConfigFromEnv();
  const {
    method: httpMethod = "POST",
    payload,
    query,
    signal,
    timeoutMs = TELEGRAM_HTTP_TIMEOUT_MS,
    retries = TELEGRAM_RETRY_ATTEMPTS,
    retryOnStatus = true,
    operation = method,
  } = requestOptions;

  if (!telegramToken) {
    throw new Error("Telegram bot token missing");
  }

  const url = createTelegramUrl(method, query);
  if (shouldPinCurlFallback(operation) && shouldUseCurlPrimary()) {
    try {
      return await telegramApiFetchViaCurl(url, {
        method: httpMethod,
        payload,
        timeoutMs,
        operation,
      });
    } catch (curlErr) {
      if (!isRetryableNetworkError(curlErr)) throw curlErr;
      telegramPreferCurlUntilMs = 0;
    }
  }
  const maxAttempts = Math.max(1, retries);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => {
        try {
          controller.abort(new Error("timeout"));
        } catch {
          controller.abort();
        }
      },
      Math.max(1000, timeoutMs),
    );

    let abortListener = null;
    if (signal) {
      abortListener = () => {
        try {
          controller.abort(signal.reason || new Error("aborted"));
        } catch {
          controller.abort();
        }
      };
      if (signal.aborted) {
        abortListener();
      } else {
        signal.addEventListener("abort", abortListener, { once: true });
      }
    }

    try {
      const response = await fetchWithFallback(url, {
        method: httpMethod,
        headers: { "Content-Type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response || typeof response.ok === "undefined") {
        throw new Error(
          `[telegram-bot] ${operation} invalid response object (response=${!!response}, ok=${response?.ok})`,
        );
      }

      if (
        response.ok ||
        !retryOnStatus ||
        !isRetryableStatus(response.status) ||
        attempt >= maxAttempts
      ) {
        return response;
      }

      try {
        await response.body?.cancel?.();
      } catch {
        /* ignore */
      }

      const waitMs = calcRetryDelayMs(attempt, response);
      if (Date.now() - lastFallbackSwitchLogMs >= 300_000) {
        console.warn(
          `[telegram-bot] ${operation} retry ${attempt}/${maxAttempts} after HTTP ${response.status} (${waitMs}ms)`,
        );
      }
      await delayMs(waitMs);
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      const retryable = isRetryableNetworkError(err);
      if (TELEGRAM_CURL_FALLBACK && hasCurlBinary()) {
        const shouldPinCurl = shouldPinCurlFallback(operation);
        if (shouldPinCurl) {
          telegramPreferCurlUntilMs =
            Date.now() + TELEGRAM_FETCH_FAILURE_COOLDOWN_MS;
        }
        const now = Date.now();
        if (now - lastFallbackSwitchLogMs >= 300_000) {
          lastFallbackSwitchLogMs = now;
          console.warn(
            `[telegram-bot] fetch unavailable, using curl fallback: ${err?.message || err}`,
          );
        }
        try {
          return await telegramApiFetchViaCurl(url, {
            method: httpMethod,
            payload,
            timeoutMs,
            operation,
          });
        } catch (curlErr) {
          telegramPreferCurlUntilMs = 0;
          const curlRetryable = isRetryableNetworkError(curlErr);
          if (!curlRetryable || attempt >= maxAttempts) {
            throw curlErr;
          }
          const waitMs = calcRetryDelayMs(attempt);
          // Curl retry logging suppressed — the overall failure is logged once above
          await delayMs(waitMs);
          continue;
        }
      }
      if (!retryable || attempt >= maxAttempts) {
        throw err;
      }

      const waitMs = calcRetryDelayMs(attempt);
      if (Date.now() - lastFallbackSwitchLogMs >= 300_000) {
        console.warn(
          `[telegram-bot] ${operation} network retry ${attempt}/${maxAttempts}: ${err?.message || err} (${waitMs}ms)`,
        );
      }
      await delayMs(waitMs);
    } finally {
      clearTimeout(timeoutHandle);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }

  throw new Error(`Telegram request failed: ${operation}`);
}

function canSignalProcess(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireTelegramPollLock(owner) {
  if (telegramPollLockHeld) return true;
  try {
    const payload = JSON.stringify(
      { owner, pid: process.pid, started_at: new Date().toISOString() },
      null,
      2,
    );
    await writeFile(telegramPollLockPath, payload, { flag: "wx" });
    telegramPollLockHeld = true;
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") {
      try {
        const raw = await readFile(telegramPollLockPath, "utf8");
        if (!raw || !raw.trim()) {
          // Empty/corrupt lock file — treat as stale
          await unlink(telegramPollLockPath);
          return await acquireTelegramPollLock(owner);
        }
        const data = JSON.parse(raw);
        const pid = Number(data?.pid);
        if (!canSignalProcess(pid)) {
          await unlink(telegramPollLockPath);
          return await acquireTelegramPollLock(owner);
        }
      } catch {
        // Lock file is corrupt/unparseable — remove and retry
        try {
          await unlink(telegramPollLockPath);
        } catch {
          /* ignore */
        }
        return await acquireTelegramPollLock(owner);
      }
    }
    return false;
  }
}

async function releaseTelegramPollLock() {
  if (!telegramPollLockHeld) return;
  telegramPollLockHeld = false;
  try {
    await unlink(telegramPollLockPath);
  } catch {
    /* best effort */
  }
}

// ── State ────────────────────────────────────────────────────────────────────

let lastUpdateId = 0;
let polling = false;
let pollAbort = null;
let presenceReady = false;
let workspaceRegistryPromise = null;
let localWorkspaceCache = null;
let telegramUiUrl = null;
let telegramWebAppUrl = null;
let telegramWebAppUrlWarned = "";
let lastMenuButtonUrl = null;
let menuButtonRefreshTimer = null;
const UI_TOKEN_TTL_MS = 30 * 60 * 1000;
const UI_INPUT_TTL_MS = 15 * 60 * 1000;
const uiTokenRegistry = new Map();
const uiInputRequests = new Map();

/**
 * Get the browser URL with the session token appended for auto-auth.
 *
 * Priority:
 *   1. Cloudflare tunnel URL (publicly reachable — works from Telegram/mobile)
 *   2. Configured base URL (explicit env override)
 *   3. LAN URL (same-network fallback)
 *
 * Previous behavior preferred LAN which broke "Open in Browser" for Telegram
 * users connecting from outside the local network.
 */
function getBrowserUiUrl() {
  const token = getSessionToken();
  const tunnelUrl = getTunnelUrl();
  if (tunnelUrl) {
    return appendTokenToUrl(tunnelUrl, token) || tunnelUrl;
  }

  const base = telegramUiUrl || getTelegramUiUrl?.() || null;
  if (!base) return null;

  // 1. Tunnel URL already checked above.

  // 2. Fall back to configured/explicit URL
  const explicit =
    process.env.TELEGRAM_WEBAPP_URL || process.env.TELEGRAM_UI_BASE_URL || "";
  if (explicit) {
    const trimmed = explicit.trim().replace(/\/+$/, "");
    if (trimmed) return appendTokenToUrl(trimmed, token) || trimmed;
  }

  // 3. Fall back to LAN URL for same-network access
  try {
    const parsed = new URL(base);
    const lanIp = getLocalLanIp?.();
    if (lanIp && parsed.port) {
      const lanBase = `${parsed.protocol}//${lanIp}:${parsed.port}`;
      return appendTokenToUrl(lanBase, token) || lanBase;
    }
  } catch {
    // fall through to base URL
  }

  if (!token) return base;
  return appendTokenToUrl(base, token) || base;
}

function isTelegramInlineButtonUrlAllowed(inputUrl) {
  try {
    const parsed = new URL(String(inputUrl || "").trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    const host = String(parsed.hostname || "").toLowerCase();
    if (!host) return false;
    // Telegram rejects localhost/loopback URLs for inline keyboard URL buttons.
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]"
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function getBrowserUiUrlOptions({ forTelegramButtons = true } = {}) {
  const tunnelUrl = getTunnelUrl();
  const localUiUrl = String(getTelegramUiUrl?.() || "").trim();
  const base = String(telegramUiUrl || localUiUrl || tunnelUrl || "").trim();
  if (!base && !tunnelUrl) return [];
  const token = getSessionToken();
  const options = [];
  const seen = new Set();
  const add = (label, inputUrl) => {
    const raw = String(inputUrl || "").trim();
    if (!raw) return;
    const url = appendTokenToUrl(raw, token) || raw;
    if (!url) return;
    if (seen.has(url)) return;
    seen.add(url);
    if (forTelegramButtons && !isTelegramInlineButtonUrlAllowed(url)) {
      return;
    }
    options.push({ label, url });
  };

  let parsed = null;
  try {
    parsed = new URL(base);
  } catch {
    parsed = null;
  }

  if (tunnelUrl) {
    let label = ":globe: Cloudflare";
    try {
      const host = String(new URL(tunnelUrl).hostname || "").toLowerCase();
      label = host.endsWith(".trycloudflare.com")
        ? ":globe: Cloudflare (Quick)"
        : ":globe: Cloudflare (Permanent)";
    } catch {
      // keep default label
    }
    add(label, tunnelUrl);
  }

  if (parsed) {
    const localhostUrl = `${parsed.protocol}//localhost${parsed.port ? `:${parsed.port}` : ""}`;
    add(":monitor: Localhost", localhostUrl);
  }

  // LAN should remain available even when a Cloudflare tunnel is active.
  // Derive it from the local UI listener URL (port-bound), not the tunnel URL.
  let localParsed = null;
  try {
    localParsed = new URL(localUiUrl);
  } catch {
    localParsed = null;
  }
  const lanSource = localParsed || parsed;
  if (lanSource) {
    const lanIp = getLocalLanIp?.();
    if (lanIp && lanSource.port) {
      const lanUrl = `${lanSource.protocol}//${lanIp}:${lanSource.port}`;
      add(":chart: LAN", lanUrl);
    }
  }

  if (options.length === 0 && base) {
    add(":globe: Browser URL", base);
  }
  return options;
}

function normalizeMeetingCallType(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "voice";
  if (value === "video" || value === "videocall") return "video";
  if (/\bvideo\b/.test(value)) return "video";
  return "voice";
}

function appendQueryParams(inputUrl, params = {}) {
  const raw = String(inputUrl || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    for (const [key, value] of Object.entries(params || {})) {
      const next = String(value ?? "").trim();
      if (!next) continue;
      url.searchParams.set(key, next);
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function buildMeetingLaunchUrl(baseUrl, callType = "voice", extra = {}) {
  const normalizedCall = normalizeMeetingCallType(callType);
  return appendQueryParams(baseUrl, {
    launch: "meeting",
    call: normalizedCall,
    autostart: "1",
    source: "telegram",
    ...extra,
  });
}

function getMeetingWebAppUrl(callType = "voice", extra = {}) {
  const base = telegramWebAppUrl || getTelegramWebAppUrl(telegramUiUrl);
  if (!base) return null;
  return buildMeetingLaunchUrl(base, callType, extra);
}

function getMeetingBrowserUrlOptions(callType = "voice", extra = {}) {
  return getBrowserUiUrlOptions().map((option) => ({
    label: option.label,
    url: buildMeetingLaunchUrl(option.url, callType, extra),
  }));
}

function syncUiUrlsFromServer() {
  const currentUiUrl = getTunnelUrl() || getTelegramUiUrl?.() || null;
  telegramUiUrl = currentUiUrl;
  telegramWebAppUrl = getTelegramWebAppUrl(currentUiUrl);
  return {
    uiUrl: telegramUiUrl,
    webAppUrl: telegramWebAppUrl,
  };
}

// ── Agent session state (for follow-up steering & bottom-pinning) ────────────

const activeAgentSessions = new Map(); // chatId -> session
let activeAgentSession = null; // legacy pointer to the latest active session
let agentMessageId = null; // latest agent streaming message ID
let agentChatId = null; // latest chat where an agent is running

// ── Sticky UI menu state (keep /menu accessible at bottom) ─────────────────
const STICKY_MENU_BUMP_MS = 600;
const CALLBACK_ACTION_DEDUPE_MS = Math.max(
  150,
  Number(process.env.TELEGRAM_CALLBACK_ACTION_DEDUPE_MS || "1200") || 1200,
);
const stickyMenuRuntime = createStickyMenuStateManager({
  callbackActionDedupeMs: CALLBACK_ACTION_DEDUPE_MS,
  stickyMenuBumpMs: STICKY_MENU_BUMP_MS,
  onBump: (chatId) => bumpStickyMenu(chatId),
  onResetChat: (chatId) => clearPendingUiInput(chatId),
  logStructured: (event, payload) => logTelegramStructured(event, payload),
});

// ── Queues ──────────────────────────────────────────────────────────────────

let fastCommandQueue = Promise.resolve();
let commandQueue = Promise.resolve();
const agentQueues = new Map();

function enqueueFastCommand(task) {
  fastCommandQueue = fastCommandQueue.then(task).catch((err) => {
    console.error(`[telegram-bot] fast command error: ${err.message || err}`);
  });
}

function enqueueCommand(task) {
  commandQueue = commandQueue.then(task).catch((err) => {
    console.error(`[telegram-bot] command error: ${err.message || err}`);
  });
}

function enqueueAgentTask(task, key = "global") {
  const queueKey = String(key || "global");
  const prev = agentQueues.get(queueKey) || Promise.resolve();
  const next = prev
    .then(task)
    .catch((err) => {
      console.error(
        `[telegram-bot] agent error (${queueKey}): ${err.message || err}`,
      );
    })
    .finally(() => {
      if (agentQueues.get(queueKey) === next) {
        agentQueues.delete(queueKey);
      }
    });
  agentQueues.set(queueKey, next);
}

function getActiveAgentSession(chatId = null) {
  if (chatId != null) {
    return activeAgentSessions.get(String(chatId)) || null;
  }
  if (
    activeAgentSession &&
    activeAgentSessions.has(String(activeAgentSession.chatId || ""))
  ) {
    return activeAgentSession;
  }
  const first = activeAgentSessions.values().next().value || null;
  if (first) activeAgentSession = first;
  return first;
}

function setActiveAgentSession(chatId, session) {
  const key = String(chatId || "");
  if (!key || !session) return;
  activeAgentSessions.set(key, session);
  activeAgentSession = session;
  if (session.messageId) {
    agentMessageId = session.messageId;
    agentChatId = key;
  }
}

function clearActiveAgentSession(chatId, expectedSession = null) {
  const key = String(chatId || "");
  if (!key) return;
  const current = activeAgentSessions.get(key);
  if (expectedSession && current && current !== expectedSession) return;
  activeAgentSessions.delete(key);
  if (agentChatId === key) {
    agentChatId = null;
    agentMessageId = null;
  }
  if (
    activeAgentSession &&
    String(activeAgentSession.chatId || "") === key
  ) {
    activeAgentSession = null;
  }
  if (!activeAgentSession && activeAgentSessions.size > 0) {
    activeAgentSession = Array.from(activeAgentSessions.values()).pop() || null;
  }
}

async function getWorkspaceRegistryCached() {
  if (!workspaceRegistryPromise) {
    workspaceRegistryPromise = loadWorkspaceRegistry();
  }
  return workspaceRegistryPromise;
}

async function getLocalWorkspaceContext() {
  if (localWorkspaceCache) return localWorkspaceCache;
  const loaded = await getWorkspaceRegistryCached();
  const registry = loaded.registry || loaded;
  localWorkspaceCache = getLocalWorkspace(
    registry,
    process.env.VE_WORKSPACE_ID || "",
  );
  return localWorkspaceCache;
}

// ── External refs (injected by monitor.mjs) ──────────────────────────────────

let _sendTelegramMessage = null; // injected from monitor.mjs
let _readStatusData = null;
let _readStatusSummary = null;
let _getCurrentChild = null;
let _startProcess = null;
let _requestFullBosunRestart = null;
let _getRepoRoot = null;
let _startFreshSession = null;
let _attemptFreshSessionRetry = null;
let _buildRetryPrompt = null;
let _getActiveAttemptInfo = null;
let _reconcileTaskStatuses = null;
let _onDigestSealed = null;
let _getAnomalyReport = null;
let _getInternalExecutor = null;
let _getExecutorMode = null;
let _getAgentEndpoint = null;
let _getAgentEventBus = null;
let _getReviewAgent = null;
let _getReviewAgentEnabled = null;
let _getSyncEngine = null;
let _getErrorDetector = null;
let _getPrCleanupDaemon = null;
let _getWorkspaceMonitor = null;
let _getMonitorMonitorStatus = null;
let _getTuiMonitorStats = null;
let _getTaskStoreStats = null;
let _getTasksPendingReview = null;
let _triggerTaskPlanner = null;
let _telegramUiRuntime = null;

function setTelegramUiRuntime(runtime = null) {
  if (!runtime || typeof runtime !== "object") {
    _telegramUiRuntime = null;
    return;
  }
  _telegramUiRuntime = { ...runtime };
}

function getTelegramUiRuntime() {
  return _telegramUiRuntime && typeof _telegramUiRuntime === "object"
    ? _telegramUiRuntime
    : {};
}

function getTelegramUiUrl() {
  return getTelegramUiRuntime().getUiUrl?.() || null;
}

function getLocalLanIp() {
  return getTelegramUiRuntime().getLocalLanIp?.() || null;
}

function getFirewallState() {
  return getTelegramUiRuntime().getFirewallState?.() || null;
}

async function openFirewallPort(...args) {
  return await getTelegramUiRuntime().openFirewallPort?.(...args);
}

function getSessionToken() {
  return getTelegramUiRuntime().getSessionToken?.() || "";
}

function getTunnelUrl() {
  return getTelegramUiRuntime().getTunnelUrl?.() || null;
}

function onTunnelUrlChange(cb) {
  return getTelegramUiRuntime().onTunnelUrlChange?.(cb) || null;
}

function disableUnsafeMode() {
  return getTelegramUiRuntime().disableUnsafeMode?.() === true;
}

/**
 * Inject monitor.mjs functions so the bot can send messages and read status.
 * Call this BEFORE startTelegramBot().
 */
export function injectMonitorFunctions({
  sendTelegramMessage,
  readStatusData,
  readStatusSummary,
  getCurrentChild,
  startProcess,
  requestFullBosunRestart,
  getRepoRoot,
  startFreshSession,
  attemptFreshSessionRetry,
  buildRetryPrompt,
  getActiveAttemptInfo,
  reconcileTaskStatuses,
  onDigestSealed,
  getAnomalyReport,
  getInternalExecutor,
  getExecutorMode,
  getAgentEndpoint,
  getAgentEventBus,
  getReviewAgent,
  getReviewAgentEnabled,
  getSyncEngine,
  getErrorDetector,
  getPrCleanupDaemon,
  getWorkspaceMonitor,
  getMonitorMonitorStatus,
  getTuiMonitorStats,
  getTaskStoreStats,
  getTasksPendingReview,
  triggerTaskPlanner,
  telegramUiRuntime,
}) {
  refreshTelegramConfigFromEnv();
  _sendTelegramMessage = sendTelegramMessage;
  _readStatusData = readStatusData;
  _readStatusSummary = readStatusSummary;
  _getCurrentChild = getCurrentChild;
  _startProcess = startProcess;
  _requestFullBosunRestart = requestFullBosunRestart || null;
  _getRepoRoot = getRepoRoot;
  _startFreshSession = startFreshSession;
  _attemptFreshSessionRetry = attemptFreshSessionRetry;
  _buildRetryPrompt = buildRetryPrompt;
  _getActiveAttemptInfo = getActiveAttemptInfo;
  _reconcileTaskStatuses = reconcileTaskStatuses;
  _onDigestSealed = onDigestSealed || null;
  _getAnomalyReport = getAnomalyReport || null;
  _getInternalExecutor = getInternalExecutor || null;
  _getExecutorMode = getExecutorMode || null;
  _getAgentEndpoint = getAgentEndpoint || null;
  _getAgentEventBus = getAgentEventBus || null;
  _getReviewAgent = getReviewAgent || null;
  _getReviewAgentEnabled = getReviewAgentEnabled || null;
  _getSyncEngine = getSyncEngine || null;
  _getErrorDetector = getErrorDetector || null;
  _getPrCleanupDaemon = getPrCleanupDaemon || null;
  _getWorkspaceMonitor = getWorkspaceMonitor || null;
  _getMonitorMonitorStatus = getMonitorMonitorStatus || null;
  _getTuiMonitorStats = getTuiMonitorStats || null;
  _getTaskStoreStats = getTaskStoreStats || null;
  _getTasksPendingReview = getTasksPendingReview || null;
  _triggerTaskPlanner = triggerTaskPlanner || null;
  setTelegramUiRuntime(telegramUiRuntime);
}

/**
 * Called by monitor.mjs when a notification is sent while the agent is streaming.
 * Re-sends the agent message so it stays at the bottom of the chat.
 */
export async function bumpAgentMessage() {
  const candidates = [];
  if (agentChatId) {
    const pinned = getActiveAgentSession(agentChatId);
    if (pinned) candidates.push(pinned);
  }
  if (candidates.length === 0) {
    for (const session of activeAgentSessions.values()) {
      if (!session?.background) candidates.push(session);
    }
  }
  for (const session of candidates) {
    if (!session || session.background) continue;
    if (!session.messageId || !session.chatId) continue;
    try {
      await deleteDirect(session.chatId, session.messageId);
    } catch {
      /* best effort */
    }
    const msg = buildStreamMessage({
      taskPreview: session.taskPreview,
      actionLog: session.actionLog,
      currentThought: session.currentThought,
      totalActions: session.totalActions,
      phase: session.phase,
      finalResponse: null,
    });
    const newId = await sendDirect(session.chatId, msg);
    if (newId) {
      session.messageId = newId;
      agentMessageId = newId;
      agentChatId = String(session.chatId);
    }
  }
}

/**
 * Check if agent is active (for external callers like monitor.mjs).
 */
export function isAgentActive() {
  return activeAgentSessions.size > 0;
}

export function __resetStickyMenuStateForTest() {
  stickyMenuRuntime.resetAll();
  uiInputRequests.clear();
}

export const __stickyMenuTestApi = {
  setStickyMenuState,
  getStickyMenuDiagnostics,
  recoverStickyMenuContextFromCallback,
  dedupeMenuCallbackAction,
  resetStickyMenuContext,
};

function setStickyMenuState(chatId, patch) {
  return stickyMenuRuntime.setState(chatId, patch);
}

function getStickyMenuDiagnostics(chatId, now = Date.now()) {
  return stickyMenuRuntime.getDiagnostics(chatId, now);
}

function getStickyMenuState(chatId) {
  return stickyMenuRuntime.getState(chatId);
}

function deleteStickyMenuState(chatId) {
  stickyMenuRuntime.deleteState(chatId);
}

function resetStickyMenuContext(chatId, options = {}) {
  return stickyMenuRuntime.resetContext(chatId, options);
}

function formatStickyMenuDiagnosticsMessage(chatId) {
  const diagnostics = getStickyMenuDiagnostics(chatId);
  const lines = [
    ":mag: Sticky menu diagnostics",
    `Chat: ${diagnostics.chatId || "unknown"}`,
    `State: ${diagnostics.enabled ? "active" : "idle"}`,
    `Session: ${diagnostics.sessionId || "none"}`,
    `Lease age: ${diagnostics.leaseAgeMs != null ? formatDurationMs(diagnostics.leaseAgeMs) : "n/a"}`,
    `Screen: ${diagnostics.screenId || "n/a"}`,
    `Message: ${diagnostics.messageId || "n/a"}`,
    `Recoveries: ${diagnostics.recoveryCount || 0}`,
    `Resets: ${diagnostics.resetCount || 0}`,
  ];
  if (diagnostics.lastRecovery) {
    lines.push(
      `Last recovery: ${diagnostics.lastRecovery.reason || "callback"} • ${diagnostics.lastRecovery.sessionId || "no-session"}`,
    );
  }
  if (diagnostics.lastDedupe) {
    const age = diagnostics.lastDedupe.ageMs != null
      ? `${diagnostics.lastDedupe.ageMs}ms`
      : "first-seen";
    lines.push(
      `Last callback: ${diagnostics.lastDedupe.decision || "accepted"} • ${diagnostics.lastDedupe.data || "n/a"} • ${age}`,
    );
  }
  if (diagnostics.lastReset) {
    lines.push(
      `Last reset: ${diagnostics.lastReset.reason || "operator"} • ${diagnostics.lastReset.previousSessionId || "no-session"}`,
    );
  }
  lines.push("Use /menu reset to clear only this chat's sticky-menu lease.");
  return lines.join("\n");
}

function formatStickyMenuResetMessage(reset) {
  const session = reset?.previousSessionId || "none";
  const age = reset?.previousLeaseAgeMs != null
    ? formatDurationMs(reset.previousLeaseAgeMs)
    : "n/a";
  return [
    ":broom: Sticky menu reset applied.",
    `Reason: ${reset?.reason || "operator"}`,
    `Previous session: ${session}`,
    `Previous lease age: ${age}`,
    "This only cleared sticky-menu state for the current chat.",
  ].join("\n");
}

function logTelegramStructured(event, payload = {}) {
  try {
    console.log(`[telegram-bot] ${JSON.stringify({
      event,
      at: new Date().toISOString(),
      ...payload,
    })}`);
  } catch {
    console.log(`[telegram-bot] ${event}`);
  }
}

function clearStickyMenuTimer(chatId) {
  stickyMenuRuntime.clearTimer(chatId);
}

function isStickyMenuInteractive(chatId) {
  return stickyMenuRuntime.isInteractive(chatId);
}

function recoverStickyMenuContextFromCallback(query, reason = "callback") {
  return stickyMenuRuntime.recoverContextFromCallback(query, reason);
}

function dedupeMenuCallbackAction({
  chatId,
  fromId,
  messageId,
  data,
  callbackId,
}) {
  return stickyMenuRuntime.dedupeCallbackAction({
    chatId,
    fromId,
    messageId,
    data,
    callbackId,
  });
}

function getStickyMenuRestoreTarget(chatId) {
  return stickyMenuRuntime.getRestoreTarget(chatId);
}

function isStickyMenuMessage(chatId, messageId) {
  return stickyMenuRuntime.isMessage(chatId, messageId);
}

function isStaleStickyMenuMessage(chatId, messageId) {
  return stickyMenuRuntime.isStaleMessage(chatId, messageId);
}

function ensureStickyMenuEnabled(chatId, messageId, screenId, params) {
  return stickyMenuRuntime.ensureEnabled(chatId, messageId, screenId, params);
}

function scheduleStickyMenuBump(chatId, lastMessageId) {
  stickyMenuRuntime.scheduleBump(chatId, lastMessageId);
}

async function bumpStickyMenu(chatId) {
  const state = getStickyMenuState(chatId);
  if (!state?.enabled || !state?.screenId || state.mode === "interactive") return;
  // On bump (new messages pushed menu up), clear any inline result
  // so the menu shows clean navigation when it reappears at the bottom
  await showUiScreen(chatId, null, state.screenId, state.params || {}, {
    sticky: true,
  });
}

async function showStickyInteractiveMessage(chatId, text, options = {}) {
  const state = getStickyMenuState(chatId) || {};
  const hasStickyMenu = Boolean(state.enabled);
  const { screenId, params } = getStickyMenuRestoreTarget(chatId);
  const targetMessageId =
    options.messageId || (hasStickyMenu ? state.messageId || null : null);
  const messageOptions = { ...options };
  delete messageOptions.messageId;
  clearStickyMenuTimer(chatId);

  let nextMessageId = targetMessageId;
  if (targetMessageId) {
    nextMessageId = await editDirect(chatId, targetMessageId, text, messageOptions);
  } else {
    nextMessageId = await sendDirect(chatId, text, {
      ...messageOptions,
      skipSticky: true,
    });
  }

  setStickyMenuState(chatId, {
    enabled: hasStickyMenu,
    messageId: nextMessageId,
    screenId,
    params,
    mode: "interactive",
    restoreScreenId: screenId,
    restoreParams: params,
  });
  return nextMessageId;
}

async function restoreStickyMenuMessage(chatId, fallbackScreenId = "home", fallbackParams = {}) {
  const state = getStickyMenuState(chatId);
  if (!state?.enabled) return false;
  clearStickyMenuTimer(chatId);
  const screenId = state.restoreScreenId || state.screenId || fallbackScreenId;
  const params = state.restoreParams || state.params || fallbackParams;
  await showUiScreen(chatId, state.messageId || null, screenId, params, {
    sticky: true,
  });
  return true;
}

async function refreshStickyMenu(chatId, screenId = "home", params = {}) {
  const state = getStickyMenuState(chatId);
  if (state?.messageId) {
    try {
      await deleteDirect(chatId, state.messageId);
    } catch {
      /* best effort */
    }
  }
  clearStickyMenuTimer(chatId);
  deleteStickyMenuState(chatId);
  clearPendingUiInput(chatId);
  await showUiScreen(chatId, null, screenId, params, { sticky: true });
}

// ── Telegram API Helpers ─────────────────────────────────────────────────────

/**
 * UI capture buffer — when commands are executed via handleUiCommand with
 * chatId === "__ui_capture__", sendReply pushes here instead of Telegram.
 */
let _uiCaptureBuffer = null;

async function sendReply(chatId, text, options = {}) {
  // UI capture mode — collect messages instead of sending to Telegram
  if (chatId === "__ui_capture__" && _uiCaptureBuffer) {
    _uiCaptureBuffer.push(typeof text === "string" ? text : String(text));
    return;
  }
  // If monitor's sendTelegramMessage is available, use it (handles dedup & history)
  if (_sendTelegramMessage) {
    // Bypass dedup for direct replies
    await sendDirect(chatId, text, options);
    return;
  }
  await sendDirect(chatId, text, options);
}

async function sendDirect(chatId, text, options = {}) {
  if (!telegramToken) return null;
  const skipSticky = options.skipSticky;
  const normalizedText = formatTelegramIconTokens(text, { button: false });

  // Split long messages
  const chunks = splitMessage(normalizedText, MAX_MESSAGE_LEN);
  let lastMessageId = null;
  for (const chunk of chunks) {
    const payload = {
      chat_id: chatId,
      text: chunk,
    };
    if (options.parseMode) {
      payload.parse_mode = options.parseMode;
    }
    if (options.silent) {
      payload.disable_notification = true;
    }
    payload.disable_web_page_preview = true;
    if (options.reply_markup) {
      payload.reply_markup = sanitizeWebAppButtons(options.reply_markup);
    }

    let res;
    try {
      res = await telegramApiFetch("sendMessage", {
        method: "POST",
        payload,
        operation: "sendMessage",
      });
    } catch (err) {
      console.warn(`[telegram-bot] send error: ${err.message}`);
      continue;
    }

    // Safety: validate response object
    if (!res || typeof res.ok === "undefined") {
      console.warn(`[telegram-bot] send error: invalid response object`);
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[telegram-bot] send failed: ${res.status} ${body}`);
      // If HTML parse mode fails, retry as plain text
      if (options.parseMode && res.status === 400) {
        return sendDirect(chatId, chunk, {
          ...options,
          parseMode: undefined,
        });
      }
    } else {
      try {
        const data = await res.json();
        if (data.ok && data.result?.message_id) {
          lastMessageId = data.result.message_id;
          recordSentMessage(chatId, lastMessageId);
        }
      } catch (err) {
        console.warn(`[telegram-bot] send JSON parse error: ${err.message}`);
      }
    }
  }
  if (!skipSticky && lastMessageId) {
    scheduleStickyMenuBump(chatId, lastMessageId);
  }
  return lastMessageId;
}

/**
 * Edit an existing Telegram message in-place.
 * Falls back to sending a new message if the edit fails (message too old, etc.).
 */
async function editDirect(chatId, messageId, text, options = {}) {
  if (!telegramToken || !messageId) return messageId;
  const normalizedText = formatTelegramIconTokens(text, { button: false });

  // Telegram editMessageText has 4096 char limit — truncate if needed
  const truncated =
    normalizedText.length > MAX_MESSAGE_LEN
      ? normalizedText.slice(0, MAX_MESSAGE_LEN - 20) + "\n\n…(truncated)"
      : normalizedText;

  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: truncated,
    disable_web_page_preview: true,
  };
  if (options.parseMode) {
    payload.parse_mode = options.parseMode;
  }
  if (options.reply_markup) {
    payload.reply_markup = sanitizeWebAppButtons(options.reply_markup);
  }

  let res;
  try {
    res = await telegramApiFetch("editMessageText", {
      method: "POST",
      payload,
      operation: "editMessageText",
    });
  } catch (err) {
    console.warn(`[telegram-bot] edit error: ${err.message}`);
    return messageId;
  }

  // Safety: validate response object
  if (!res || typeof res.ok === "undefined") {
    console.warn(`[telegram-bot] edit error: invalid response object`);
    return messageId;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // "message is not modified" is fine — content didn't change
    if (body.includes("message is not modified")) return messageId;
    // Missing or immutable messages should fall back to a fresh send.
    if (
      body.includes("message to edit not found") ||
      body.includes("can't be edited") ||
      body.includes("MESSAGE_ID_INVALID")
    ) {
      console.warn(`[telegram-bot] edit failed, sending new message`);
      return await sendDirect(chatId, truncated, options);
    }
    console.warn(`[telegram-bot] edit failed: ${res.status} ${body}`);
    // For HTML parse errors, retry without parse mode
    if (options.parseMode && res.status === 400) {
      return editDirect(chatId, messageId, truncated, {
        ...options,
        parseMode: undefined,
      });
    }
  }
  return messageId;
}

// ── Action Summarizer ────────────────────────────────────────────────────────

/**
 * Delete a Telegram message. Best-effort, failures are silently ignored.
 */
async function deleteDirect(chatId, messageId) {
  if (!telegramToken || !messageId) return;
  try {
    await telegramApiFetch("deleteMessage", {
      method: "POST",
      payload: { chat_id: chatId, message_id: messageId },
      operation: "deleteMessage",
    });
  } catch {
    /* best effort */
  }
}

// ── Message History Helpers ───────────────────────────────────────────────────

/** Lazy-loaded in-memory list of sent message records. */
let _msgHistory = null;
let _msgHistoryDirty = false;

function _loadMsgHistory() {
  if (_msgHistory !== null) return;
  try {
    const raw = readFileSync(msgHistoryPath, "utf8");
    const data = JSON.parse(raw);
    _msgHistory = Array.isArray(data.messages) ? data.messages : [];
  } catch {
    _msgHistory = [];
  }
}

function _saveMsgHistory() {
  if (!_msgHistory) return;
  try {
    mkdirSync(resolve(repoRoot, ".cache"), { recursive: true });
    writeFileSync(
      msgHistoryPath,
      JSON.stringify({ messages: _msgHistory }, null, 2),
      "utf8",
    );
    _msgHistoryDirty = false;
  } catch {
    /* best effort */
  }
}

/**
 * Record a newly sent message ID so it can be cleaned up later.
 * No-op when HISTORY_RETENTION_MS is 0 (feature disabled).
 */
function recordSentMessage(chatId, messageId) {
  if (!HISTORY_RETENTION_MS || !messageId) return;
  _loadMsgHistory();
  _msgHistory.push({ chat_id: chatId, message_id: messageId, sent_at: Date.now() });
  if (_msgHistory.length > HISTORY_MAX_TRACKED) {
    _msgHistory = _msgHistory.slice(-HISTORY_MAX_TRACKED);
  }
  _msgHistoryDirty = true;
}

/**
 * Delete all tracked bot messages older than HISTORY_RETENTION_MS.
 * Failures are silently swallowed — Telegram may refuse deletes for messages
 * older than 48 h in private chats; we just skip those gracefully.
 */
async function pruneMessageHistory() {
  if (!HISTORY_RETENTION_MS) return;
  _loadMsgHistory();
  if (_msgHistoryDirty) _saveMsgHistory();

  const cutoff = Date.now() - HISTORY_RETENTION_MS;
  const toDelete = _msgHistory.filter((m) => m.sent_at < cutoff);
  if (toDelete.length === 0) return;

  console.log(
    `[telegram-bot] auto-cleanup: deleting ${toDelete.length} message(s) older than ${HISTORY_RETENTION_DAYS}d`,
  );

  let i = 0;
  for (const m of toDelete) {
    await deleteDirect(m.chat_id, m.message_id);
    i++;
    // Pace at ~20 deletes/s to stay well under Telegram’s 30 msg/s limit
    if (i % 20 === 0) await new Promise((r) => setTimeout(r, 1000));
  }

  _msgHistory = _msgHistory.filter((m) => m.sent_at >= cutoff);
  _saveMsgHistory();
  console.log(
    `[telegram-bot] auto-cleanup: done. ${_msgHistory.length} messages remaining in history.`,
  );
}

/**
 * Answer a Telegram callback query (required to dismiss the "loading" indicator).
 * @param {string} callbackQueryId - The callback_query.id from the update
 * @param {string} [text] - Optional toast notification text
 * @param {boolean} [showAlert] - Show as alert popup instead of toast
 */
async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
  if (!telegramToken || !callbackQueryId) return;
  const payload = { callback_query_id: callbackQueryId };
  if (text) payload.text = text;
  if (showAlert) payload.show_alert = showAlert;
  try {
    await telegramApiFetch("answerCallbackQuery", {
      method: "POST",
      payload,
      operation: "answerCallbackQuery",
    });
  } catch (err) {
    console.warn(`[telegram-bot] answerCallbackQuery error: ${err.message}`);
  }
}

/**
 * Extract a short filename from a path (last 2 segments for context).
 */
function shortPath(p) {
  if (!p) return "";
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : parts.join("/");
}

/**
 * Extract a file path target from a command string (first path-like argument).
 */
function extractTarget(cmd) {
  if (!cmd) return "";
  // Match file paths (containing / or \ and a file extension, or known directories)
  const m = cmd.match(
    /(?:['"])?([\w.\-/\\]+\.(?:ps1|mjs|js|ts|go|json|yaml|yml|md|log|txt|toml|sh))(?:['"])?/i,
  );
  if (m) return shortPath(m[1]);
  // Match directory paths
  const d = cmd.match(
    /(?:(?:Get-Content|cat|head|tail|type|Select-String)\s+(?:-Path\s+)?['"]?)([\w.\-/\\]+)/i,
  );
  if (d) return shortPath(d[1]);
  return "";
}

function normalizeToolName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function getCopilotToolInfo(event) {
  const data = event?.data || {};
  const toolName =
    data.toolName ||
    data.name ||
    data.tool?.name ||
    event?.toolName ||
    event?.tool ||
    "";
  const input =
    data.input ||
    data.args ||
    data.parameters ||
    data.toolInput ||
    data.payload ||
    null;
  const output = data.output || data.result || data.toolOutput || null;
  const status = data.status || event?.status || "";
  return { toolName: String(toolName || ""), input, output, status };
}

function extractCopilotCommand(input) {
  if (!input) return null;
  if (typeof input === "string") return input;
  const candidates = [
    "command",
    "cmd",
    "shell",
    "script",
    "execute",
    "args",
    "run",
  ];
  for (const key of candidates) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function extractCopilotPath(input) {
  if (!input) return null;
  if (typeof input === "string") return input;
  const candidates = [
    "path",
    "file",
    "filename",
    "filepath",
    "filePath",
    "fullPath",
    "target",
  ];
  for (const key of candidates) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function isCopilotReadTool(name) {
  const tool = normalizeToolName(name);
  return /read|open|view|get_file|read_file/.test(tool);
}

function isCopilotWriteTool(name) {
  const tool = normalizeToolName(name);
  return /write|edit|apply|patch|create|update|save/.test(tool);
}

function isCopilotSearchTool(name) {
  const tool = normalizeToolName(name);
  return /search|grep|rg|find|query/.test(tool);
}

function summarizeCopilotTool(toolName, input) {
  const tool = normalizeToolName(toolName);
  const command = extractCopilotCommand(input);
  const target = extractCopilotPath(input);
  if (!toolName) return "running tool";
  if (/command|shell|execute|run/.test(tool)) {
    return command ? `running ${shortSnippet(command, 80)}` : "running command";
  }
  if (isCopilotReadTool(tool)) {
    return target ? `reading ${shortPath(target)}` : "reading file";
  }
  if (isCopilotWriteTool(tool)) {
    return target ? `updating ${shortPath(target)}` : "updating files";
  }
  if (isCopilotSearchTool(tool)) {
    return target ? `searching ${shortPath(target)}` : "searching";
  }
  if (/mcp/.test(tool)) return `MCP tool: ${toolName}`;
  return `tool: ${toolName}`;
}

/**
 * Convert a raw agent event into a concise human-readable action description.
 * Shows which files are being read/written, line counts for changes, and
 * concise command summaries with targets.
 */
function summarizeAction(event) {
  if (!event) return null;

  switch (event.type) {
    case "item.started": {
      const item = event.item;
      switch (item.type) {
        case "command_execution": {
          const desc = summarizeCommand(item.command);
          const target = extractTarget(item.command);
          return {
            icon: ":zap:",
            text: target ? `${desc} → ${target}` : desc,
            phase: "running",
          };
        }
        case "mcp_tool_call":
          return {
            icon: ":plug:",
            text: `MCP: ${item.server}/${item.tool}`,
            phase: "running",
          };
        case "reasoning":
          return item.text
            ? { icon: ":u1f4ad:", text: item.text.slice(0, 200), phase: "thinking" }
            : null;
        case "web_search":
          return {
            icon: ":search:",
            text: `Searching: ${item.query?.slice(0, 80)}`,
            phase: "searching",
          };
        case "todo_list":
          return item.items?.length
            ? {
                icon: ":clipboard:",
                text: `Planning ${item.items.length} steps`,
                phase: "planning",
              }
            : null;
        default:
          return null;
      }
    }

    case "item.completed": {
      const item = event.item;
      switch (item.type) {
        case "command_execution": {
          const ok = item.exit_code === 0;
          const desc = summarizeCommand(item.command);
          const target = extractTarget(item.command);
          const label = target ? `${desc} → ${target}` : desc;
          return {
            icon: ok ? ":check:" : ":close:",
            text: label + (ok ? "" : ` (exit ${item.exit_code})`),
            phase: "done",
          };
        }
        case "file_change": {
          if (item.changes?.length) {
            const fileDescs = item.changes.map((c) => {
              const name = shortPath(c.path);
              const kind =
                c.kind === "add" ? ":plus:" : c.kind === "delete" ? ":trash:" : ":edit:";
              // Show line counts if available
              const adds = c.additions ?? c.lines_added ?? 0;
              const dels = c.deletions ?? c.lines_deleted ?? 0;
              const stats = adds || dels ? ` (+${adds} -${dels})` : "";
              return `${kind} ${name}${stats}`;
            });
            return {
              icon: ":folder:",
              text: fileDescs.join(", "),
              phase: "done",
              detail: "file_change",
              files: item.changes.map((c) => ({
                path: c.path,
                kind: c.kind,
                adds: c.additions ?? c.lines_added ?? 0,
                dels: c.deletions ?? c.lines_deleted ?? 0,
              })),
            };
          }
          return null;
        }
        case "mcp_tool_call": {
          const ok = item.status === "completed";
          return {
            icon: ok ? ":check:" : ":close:",
            text: `MCP ${item.server}/${item.tool}: ${ok ? "done" : "failed"}`,
            phase: "done",
          };
        }
        case "agent_message":
          return null; // final response handled separately
        default:
          return null;
      }
    }

    case "assistant.reasoning":
    case "assistant.reasoning_delta": {
      const text = event.data?.content || event.data?.deltaContent || "";
      return text
        ? { icon: ":u1f4ad:", text: text.slice(0, 200), phase: "thinking" }
        : null;
    }

    case "tool.execution_start": {
      const { toolName, input } = getCopilotToolInfo(event);
      return {
        icon: ":u1f6e0:",
        text: summarizeCopilotTool(toolName, input),
        phase: "running",
      };
    }

    case "tool.execution_complete": {
      const { toolName, input, status } = getCopilotToolInfo(event);
      const ok =
        !status ||
        ["ok", "success", "completed", "done"].includes(
          String(status).toLowerCase(),
        );
      return {
        icon: ok ? ":check:" : ":close:",
        text: summarizeCopilotTool(toolName, input) + (ok ? "" : " (failed)"),
        phase: "done",
      };
    }

    case "session.error":
      return {
        icon: ":close:",
        text: `Failed: ${event.data?.message || "unknown"}`,
        phase: "error",
      };

    case "item.updated": {
      const item = event.item;
      if (item.type === "reasoning" && item.text) {
        return { icon: ":u1f4ad:", text: item.text.slice(0, 200), phase: "thinking" };
      }
      if (item.type === "todo_list" && item.items) {
        const done = item.items.filter((t) => t.completed).length;
        return {
          icon: ":clipboard:",
          text: `Progress: ${done}/${item.items.length} steps`,
          phase: "planning",
        };
      }
      return null;
    }

    case "turn.failed":
      return {
        icon: ":close:",
        text: `Failed: ${event.error?.message || "unknown"}`,
        phase: "error",
      };
    default:
      return null;
  }
}

/**
 * Convert raw command strings into concise human-readable descriptions.
 */
function summarizeCommand(cmd) {
  if (!cmd) return "(unknown command)";
  const c = cmd.trim();
  const cmdLower = c.toLowerCase();
  const clean = c.replace(/\s+/g, " ").trim();

  // Git commands
  if (/^git\s+diff/i.test(c)) return "checking git diff";
  if (/^git\s+log/i.test(c)) return "reading git log";
  if (/^git\s+branch/i.test(c)) return "listing git branches";
  if (/^git\s+status/i.test(c)) return "checking git status";
  if (/^git\s+add/i.test(c)) return "staging files";
  if (/^git\s+commit/i.test(c)) return "committing changes";
  if (/^git\s+push/i.test(c)) return "pushing to remote";
  if (/^git\s+pull/i.test(c)) return "pulling from remote";
  if (/^git\s+checkout/i.test(c)) return "switching branch";
  if (/^git\s+merge/i.test(c)) return "merging branches";
  if (/^git\s+stash/i.test(c)) return "stashing changes";

  // PowerShell / search patterns
  if (/pwsh.*-file/i.test(c)) {
    const target = extractTarget(c);
    return target
      ? `running PowerShell file ${target}`
      : "running PowerShell file";
  }
  if (/pwsh.*Get-Content/i.test(c)) {
    const target = extractTarget(c);
    return target ? `reading ${target}` : "reading file contents";
  }
  if (/pwsh.*Select-String/i.test(c)) {
    const target = extractTarget(c);
    const patternMatch = c.match(/-Pattern\s+["']?([^"']+)["']?/i);
    const pattern = patternMatch ? patternMatch[1].slice(0, 40) : null;
    if (target && pattern) return `searching "${pattern}" in ${target}`;
    return target ? `searching in ${target}` : "searching in files";
  }
  if (/pwsh.*Get-ChildItem.*Select-String/i.test(c))
    return "searching across files";
  if (/pwsh/i.test(c) || /powershell/i.test(c))
    return describePowerShell(clean);

  // Node/npm/pnpm
  if (/^node\s+-[ec]/i.test(c))
    return `running Node.js script: ${shortSnippet(clean, 60)}`;
  if (/^npm\s+/i.test(c)) return `running npm: ${shortSnippet(clean, 60)}`;
  if (/^pnpm\s+/i.test(c)) return `running pnpm: ${shortSnippet(clean, 60)}`;

  // Go
  if (/^go\s+test/i.test(c)) {
    const pkgs = extractGoPackages(c);
    return pkgs ? `running Go tests: ${pkgs}` : "running Go tests";
  }
  if (/^go\s+build/i.test(c)) {
    const pkgs = extractGoPackages(c);
    return pkgs ? `building Go: ${pkgs}` : "building Go project";
  }
  if (/^go\s+vet/i.test(c)) {
    const pkgs = extractGoPackages(c);
    return pkgs ? `vetting Go: ${pkgs}` : "vetting Go code";
  }
  if (/^go\s+/i.test(c)) return `running Go: ${shortSnippet(clean, 60)}`;

  // Make
  if (/^make\s+/i.test(c))
    return `running make ${c.split(/\s+/)[1] || ""}`.trim();

  // gh CLI
  if (/^gh\s+pr/i.test(c)) return "managing GitHub PR";
  if (/^gh\s+issue/i.test(c)) return "managing GitHub issue";
  if (/^gh\s+/i.test(c)) return `running gh: ${shortSnippet(clean, 60)}`;

  // cat/head/tail/grep/find/ls
  if (/^(cat|head|tail|type)\s+/i.test(c)) {
    const target = extractTarget(c);
    return target ? `reading ${target}` : "reading file";
  }
  if (/^(grep|findstr|rg)\s+/i.test(c)) {
    const target = extractTarget(c);
    const pat = c.match(/(['"])(.*?)\1/);
    const pattern = pat ? pat[2].slice(0, 40) : null;
    if (target && pattern) return `searching "${pattern}" in ${target}`;
    return target ? `searching in ${target}` : "searching in files";
  }
  if (/^(find|fd)\s+/i.test(c)) return "finding files";
  if (/^(ls|dir|Get-ChildItem)\s*/i.test(c)) return "listing directory";

  // Docker
  if (/^docker\s+/i.test(c))
    return `running docker: ${shortSnippet(clean, 60)}`;

  // Fallback: first word + truncated
  const firstWord = c.split(/\s+/)[0];
  if (firstWord.length < 20)
    return `running ${firstWord}: ${shortSnippet(clean, 60)}`;
  return shortSnippet(clean, 80);
}

function shortSnippet(text, maxLen = 80) {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

function describePowerShell(command) {
  const cmd = command;
  const cmdMatch = cmd.match(/-Command\s+(.+)/i);
  const fileMatch = cmd.match(/-File\s+([^\s]+)/i);
  if (fileMatch) {
    const target = shortPath(fileMatch[1]);
    return `running PowerShell file ${target}`;
  }
  if (cmdMatch) {
    const inner = cmdMatch[1].replace(/^['"]|['"]$/g, "");
    const target = extractTarget(inner);
    const snippet = shortSnippet(inner, 70);
    return target
      ? `running PowerShell: ${snippet} → ${target}`
      : `running PowerShell: ${snippet}`;
  }
  return "running PowerShell command";
}

function extractGoPackages(command) {
  const parts = command.split(/\s+/).filter(Boolean);
  const pkgs = parts.filter((p) => p.startsWith("./") || p.includes("/"));
  if (!pkgs.length) return "";
  const unique = [...new Set(pkgs)];
  return unique.slice(0, 3).join(" ") + (unique.length > 3 ? " …" : "");
}

const TELEGRAM_ICON_TOKEN_LABELS = Object.freeze({
  check: "OK",
  close: "Close",
  alert: "Alert",
  pause: "Pause",
  play: "Run",
  stop: "Stop",
  refresh: "Refresh",
  chart: "Status",
  clipboard: "Tasks",
  bot: "Agents",
  git: "Workspaces",
  settings: "Executor",
  server: "Routing",
  folder: "Logs",
  file: "Commands",
  phone: "Control Center",
  globe: "Browser",
  heart: "Health",
  cpu: "Session",
  chat: "Ask",
  hash: "Parallel",
  repeat: "Retry",
  beaker: "Executors",
  compass: "Tasks",
  target: "Coordinator",
  workflow: "Flow",
  arrowRight: "Back",
  plus: "New",
  menu: "Menu",
  lock: "Lock",
  unlock: "Unlock",
  search: "Search",
  link: "Link",
  upload: "Upload",
  download: "Download",
  box: "SDK",
  bell: "Alerts",
  lightbulb: "Tips",
  rocket: "Start",
  home: "Home",
  pin: "Pin",
  star: "Star",
  help: "Help",
  cloud: "Cloud",
});

const TELEGRAM_ICON_TOKEN_EMOJI = Object.freeze({
  check: "✅",
  close: "❌",
  alert: "⚠️",
  pause: "⏸️",
  play: "▶️",
  stop: "⏹️",
  refresh: "🔄",
  chart: "📊",
  clipboard: "📋",
  bot: "🤖",
  git: "🌿",
  settings: "⚙️",
  server: "🖧",
  folder: "📁",
  file: "📄",
  phone: "📱",
  globe: "🌐",
  heart: "❤️",
  cpu: "🧠",
  chat: "💬",
  hash: "#️⃣",
  repeat: "🔁",
  beaker: "🧪",
  compass: "🧭",
  target: "🎯",
  workflow: "🧩",
  arrowright: "➡️",
  plus: "➕",
  menu: "☰",
  lock: "🔒",
  unlock: "🔓",
  search: "🔍",
  link: "🔗",
  upload: "📤",
  download: "📥",
  box: "📦",
  bell: "🔔",
  lightbulb: "💡",
  rocket: "🚀",
  home: "🏠",
  pin: "📌",
  star: "⭐",
  help: "❓",
  cloud: "☁️",
  monitor: "🖥️",
  eye: "👁️",
  edit: "✏️",
  trash: "🗑️",
  dot: "•",
});

function decodeUnicodeIconToken(name) {
  const raw = String(name || "").trim();
  const match = raw.match(/^u([0-9a-f]{4,6})$/i);
  if (!match) return "";
  const codePoint = Number.parseInt(match[1], 16);
  if (!Number.isFinite(codePoint)) return "";
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

function resolveTelegramIconTokenGlyph(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  const lowered = raw.toLowerCase();
  const squashed = lowered.replace(/[_-]+/g, "");
  const glyph = TELEGRAM_ICON_TOKEN_EMOJI[lowered]
    || TELEGRAM_ICON_TOKEN_EMOJI[squashed]
    || decodeUnicodeIconToken(lowered)
    || decodeUnicodeIconToken(squashed);
  return glyph || "";
}

function humanizeIconTokenName(name) {
  const spaced = String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!spaced) return "";
  return spaced
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatTelegramIconTokens(value, { button = false } = {}) {
  if (value == null) return value;
  const str = String(value);
  return str.replace(/:([a-zA-Z][a-zA-Z0-9_-]*):/g, (_match, rawName) => {
    const tokenName = String(rawName || "");
    const glyph = resolveTelegramIconTokenGlyph(tokenName);
    if (glyph) return glyph;
    const key = tokenName.toLowerCase();
    const label = TELEGRAM_ICON_TOKEN_LABELS[tokenName]
      || TELEGRAM_ICON_TOKEN_LABELS[key]
      || humanizeIconTokenName(tokenName);
    if (!label) return "";
    return button ? label : `[${label}]`;
  });
}

/**
 * Strip web_app buttons whose URL is not HTTPS — Telegram rejects non-HTTPS
 * web_app URLs with a 400 error.  Returns the sanitized reply_markup object.
 */
function sanitizeWebAppButtons(markup) {
  if (!markup || !markup.inline_keyboard) return markup;
  const filtered = markup.inline_keyboard
    .map((row) =>
      row
        .map((btn) => {
          if (!btn || typeof btn !== "object") return btn;
          if (typeof btn.text === "string") {
            return {
              ...btn,
              text: formatTelegramIconTokens(btn.text, { button: true }),
            };
          }
          return btn;
        })
        .filter((btn) => {
          if (!btn || typeof btn !== "object") return false;
        if (btn.web_app && btn.web_app.url) {
          try {
            const u = new URL(btn.web_app.url);
            if (u.protocol !== "https:") return false;
          } catch {
            return false;
          }
        }
          return true;
        }),
    )
    .filter((row) => row.length > 0);
  return { ...markup, inline_keyboard: filtered };
}

function splitMessage(text, maxLen) {
  if (!text) return ["(empty response)"];
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at newline
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.3) {
      splitIdx = maxLen; // no good newline, hard split
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}

// ── UI Menu Helpers ─────────────────────────────────────────────────────────

function pruneUiTokens() {
  const now = Date.now();
  for (const [token, entry] of uiTokenRegistry.entries()) {
    if (!entry || entry.expiresAt <= now) {
      uiTokenRegistry.delete(token);
    }
  }
}

function issueUiToken(payload, ttlMs = UI_TOKEN_TTL_MS) {
  pruneUiTokens();
  let token = "";
  for (let i = 0; i < 8; i += 1) {
    token = Math.random().toString(36).slice(2, 8);
    if (token && !uiTokenRegistry.has(token)) break;
  }
  uiTokenRegistry.set(token, {
    payload,
    expiresAt: Date.now() + ttlMs,
  });
  return token;
}

function readUiToken(token) {
  const entry = uiTokenRegistry.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    uiTokenRegistry.delete(token);
    return null;
  }
  return entry.payload || null;
}

function setPendingUiInput(chatId, request) {
  if (!chatId || !request) return;
  uiInputRequests.set(String(chatId), {
    ...request,
    expiresAt: Date.now() + UI_INPUT_TTL_MS,
  });
}

function getPendingUiInput(chatId) {
  const key = String(chatId || "");
  const entry = uiInputRequests.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    uiInputRequests.delete(key);
    return null;
  }
  return entry;
}

function clearPendingUiInput(chatId) {
  uiInputRequests.delete(String(chatId || ""));
}

function consumePendingUiInput(chatId) {
  const key = String(chatId || "");
  const entry = getPendingUiInput(key);
  if (entry) uiInputRequests.delete(key);
  return entry;
}

// ── Polling ──────────────────────────────────────────────────────────────────

async function pollUpdates() {
  if (!telegramToken) return [];
  const effectivePollTimeoutS =
    shouldUseCurlPrimary()
      ? Math.min(POLL_TIMEOUT_S, TELEGRAM_CURL_POLL_TIMEOUT_SEC)
      : POLL_TIMEOUT_S;

  pollAbort = new AbortController();
  let res;
  try {
    res = await telegramApiFetch("getUpdates", {
      method: "POST",
      payload: {
        offset: String(lastUpdateId + 1),
        timeout: String(effectivePollTimeoutS),
        allowed_updates: JSON.stringify(["message", "callback_query"]),
      },
      signal: pollAbort.signal,
      timeoutMs: Math.max(
        TELEGRAM_HTTP_TIMEOUT_MS,
        effectivePollTimeoutS * 1000 + 15_000,
      ),
      retries: TELEGRAM_RETRY_ATTEMPTS,
      operation: "getUpdates",
    });
  } catch (err) {
    if (err.name === "AbortError" || !polling) return [];
    markPollFailure();
    const now = Date.now();
    if (shouldLogPollError(now)) {
      console.warn(`[telegram-bot] poll error: ${err.message}`);
    }
    if (polling) await delayMs(getPollBackoffMs());
    return [];
  } finally {
    pollAbort = null;
  }

  // Safety: validate response object
  if (!res || typeof res.ok === "undefined") {
    markPollFailure();
    console.warn(`[telegram-bot] poll error: invalid response object`);
    if (polling) await delayMs(getPollBackoffMs());
    return [];
  }

  if (!res.ok) {
    markPollFailure();
    const body = await res.text().catch(() => "");
    console.warn(`[telegram-bot] getUpdates failed: ${res.status} ${body}`);
    if (res.status === 409) {
      const untilMs = Date.now() + TELEGRAM_POLL_CONFLICT_COOLDOWN_MS;
      writeTelegramPollConflictState(untilMs, `409 Conflict — cooldown until ${new Date(untilMs).toISOString()}`);
      await releaseTelegramPollLock();
      await releaseTelegramPollOwner("telegram-bot").catch(() => {});
      pollLockLostAtMs = Date.now();
      pollLockRetryBackoffMs = 2000;
      return [];
    }
    if (polling) await delayMs(getPollBackoffMs());
    return [];
  }
  resetPollFailureStreak();
  clearTelegramPollConflictState();
  await claimTelegramPollOwner("telegram-bot", {
    ttlMs: TELEGRAM_POLL_OWNER_TTL_MS,
  }).catch(() => {});
  if (!telegramApiReachable) {
    telegramApiReachable = true;
    // API came back — register commands that were deferred at startup
    registerBotCommands().catch(() => {});
  }

  try {
    const data = await res.json();
    return data.ok ? data.result || [] : [];
  } catch (err) {
    console.warn(`[telegram-bot] poll JSON parse error: ${err.message}`);
    return [];
  }
}

// ── Update Handling ──────────────────────────────────────────────────────────

/**
 * Handle Telegram inline keyboard button presses (callback_query).
 * Routes callback data to the appropriate command handler.
 */
async function handleCallbackQuery(query) {
  const chatId = String(query.message?.chat?.id || "");
  const fromId = String(query.from?.id || "");
  const data = query.data || "";
  const callbackId = query.id;
  const messageId = query.message?.message_id || null;

  // Security: only accept from configured chat/user allow-list
  if (!isAuthorizedTelegramActor(chatId, fromId)) {
    await answerCallbackQuery(callbackId, "Unauthorized", true);
    return;
  }

  const recovery = recoverStickyMenuContextFromCallback(query, "reconnect");

  const dedupe = dedupeMenuCallbackAction({
    chatId,
    fromId,
    messageId,
    data,
    callbackId,
  });
  if (dedupe.duplicate) {
    logTelegramStructured("sticky_menu.callback_deduped", {
      chatId,
      fromId,
      messageId,
      data,
      ageMs: dedupe.ageMs,
      sessionId: dedupe.sessionId,
      leaseAgeMs: dedupe.leaseAgeMs,
    });
    await answerCallbackQuery(callbackId, "Already processing... Use /menu diag if stuck.");
    return;
  }

  console.log(`[telegram-bot] callback: "${data}" from chat ${chatId}`);

  // Always acknowledge the callback to dismiss loading indicator
  await answerCallbackQuery(
    callbackId,
    recovery?.recovered ? "Recovered sticky menu context." : undefined,
  );

  if (data.startsWith("ui:")) {
    await handleUiAction({
      chatId,
      messageId: query.message?.message_id,
      data,
    });
    return;
  }

  // Route callback data as if it were a slash command
  if (data.startsWith("/")) {
    const cmd = data.split(/\s+/)[0].toLowerCase().replace(/@\w+/, "");
    if (FAST_COMMANDS.has(cmd)) {
      enqueueFastCommand(() => handleCommand(data, chatId));
    } else {
      enqueueCommand(() => handleCommand(data, chatId));
    }
    return;
  }

  // Handle special callback prefixes
  if (data === "cb:confirm_pause") {
    enqueueCommand(() => cmdPauseTasks(chatId));
    return;
  }
  if (data === "cb:confirm_resume") {
    enqueueCommand(() => cmdResumeTasks(chatId));
    return;
  }
  if (data === "cb:close_menu") {
    // Close and disable sticky menu
    const state = getStickyMenuState(chatId);
    if (state?.enabled) {
      clearStickyMenuTimer(chatId);
      // Delete the sticky menu message
      if (state.messageId) {
        await deleteDirect(chatId, state.messageId).catch(() => {});
      }
      // Disable sticky state
      deleteStickyMenuState(chatId);
    } else if (query.message?.message_id) {
      // Not sticky — just delete the message
      await deleteDirect(chatId, query.message.message_id).catch(() => {});
    }
    return;
  }
  if (data === "cb:toggle_menu") {
    // Toggle sticky menu on/off
    const state = getStickyMenuState(chatId);
    if (state?.enabled) {
      // Menu is open → close it
      clearStickyMenuTimer(chatId);
      if (state.messageId) {
        await deleteDirect(chatId, state.messageId).catch(() => {});
      }
      deleteStickyMenuState(chatId);
    } else {
      // Menu is closed → open it
      enqueueCommand(() => cmdMenu(chatId));
    }
    return;
  }
  if (data === "cb:confirm_restart") {
    await showStickyInteractiveMessage(
      chatId,
      ":alert: Restart will stop the orchestrator process and let the monitor respawn it.\nProceed?",
      { reply_markup: buildConfirmKeyboard("cb:do_restart", "Confirm Restart") },
    );
    return;
  }
  if (data === "cb:do_restart") {
    enqueueCommand(() => handleCommand("/restart --confirm", chatId));
    return;
  }
  if (data === "cb:confirm_clear") {
    enqueueCommand(() => handleCommand("/clear --confirm", chatId));
    return;
  }
  if (data === "cb:confirm_cleanup") {
    enqueueCommand(() => handleCommand("/cleanup --confirm", chatId));
    return;
  }
  if (data === "cb:confirm_threads_clear") {
    enqueueCommand(() => handleCommand("/threads clear --confirm", chatId));
    return;
  }
  if (data === "cb:confirm_stop") {
    enqueueCommand(() => handleCommand("/stop --confirm", chatId));
    return;
  }
  if (data === "cb:do_disable_unsafe") {
    enqueueCommand(() => cmdDisableUnsafeAccess(chatId, "", query.message?.message_id));
    return;
  }
  if (data === "cb:dismiss") {
    if (isStickyMenuInteractive(chatId) && isStickyMenuMessage(chatId, query.message?.message_id)) {
      await restoreStickyMenuMessage(chatId);
      return;
    }
    if (query.message?.message_id) {
      await deleteDirect(chatId, query.message.message_id);
    }
    return;
  }
  if (data.startsWith("cb:confirm_action:")) {
    const token = data.slice("cb:confirm_action:".length);
    const payload = readUiToken(token);
    if (!payload || payload.type !== "confirm_cmd") {
      if (query.message?.message_id) {
        await deleteDirect(chatId, query.message.message_id);
      }
      await sendReply(chatId, ":clock: That action expired. Please try again.");
      return;
    }
    uiTokenRegistry.delete(token);
    if (isStickyMenuInteractive(chatId) && isStickyMenuMessage(chatId, query.message?.message_id)) {
      await restoreStickyMenuMessage(chatId);
    } else if (query.message?.message_id) {
      await deleteDirect(chatId, query.message.message_id);
    }
    await dispatchUiCommand(chatId, payload.command);
    return;
  }

  if (data === "fw:open") {
    const fwState = getFirewallState();
    if (!fwState || !fwState.blocked) {
      await sendReply(chatId, ":check: Port is already open or no firewall detected.");
      return;
    }
    await sendReply(
      chatId,
      `:settings: Attempting to open port via \`${fwState.firewall}\`...\n` +
      `Please enter your admin password on the server if prompted.`,
      { parseMode: "Markdown" },
    );
    const result = await openFirewallPort(
      Number(new URL(getTelegramUiUrl() || "http://localhost:5511").port || 5511),
    );
    if (result.success) {
      await sendReply(chatId, `:check: ${result.message}\nThe Control Center should now be reachable.`);
    } else {
      await sendReply(
        chatId,
        `:alert: Auto-fix failed.\n\n${result.message}`,
        { parseMode: "Markdown" },
      );
    }
    return;
  }

  // Fallback: treat as command text
  await sendReply(chatId, `Unknown button action: ${data}`);
}

/**
 * Transcribe a Telegram voice message using OpenAI Whisper and process as free text.
 * @param {{ file_id: string, duration?: number }} voiceFile
 * @param {string} chatId
 */
async function transcribeAndProcessVoice(voiceFile, chatId) {
  const apiKey = process.env.OPENAI_API_KEY
    || process.env.OPENAI_REALTIME_API_KEY
    || "";

  if (!apiKey) {
    await sendReply(chatId, ":alert: Voice messages require an OpenAI API key for transcription. Set OPENAI_API_KEY in your configuration.");
    return;
  }

  // 1. Get file path from Telegram
  const token = telegramToken;
  const fileInfoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${voiceFile.file_id}`);
  if (!fileInfoRes.ok) throw new Error("Failed to get file info from Telegram");
  const fileInfo = await fileInfoRes.json();
  const filePath = fileInfo.result?.file_path;
  if (!filePath) throw new Error("No file path in Telegram response");

  // 2. Download the voice file
  const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const audioRes = await fetch(fileUrl);
  if (!audioRes.ok) throw new Error("Failed to download voice file");
  const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

  // 3. Transcribe using OpenAI Whisper API
  const boundary = `----FormBoundary${Date.now()}`;
  const ext = filePath.split(".").pop() || "ogg";
  const formParts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.${ext}"\r\nContent-Type: audio/${ext === "oga" ? "ogg" : ext}\r\n\r\n`,
    audioBuffer,
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`,
  ];

  const bodyBuffer = Buffer.concat([
    Buffer.from(formParts[0], "utf8"),
    formParts[1],
    Buffer.from(formParts[2], "utf8"),
  ]);

  const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: bodyBuffer,
  });

  if (!whisperRes.ok) {
    const errText = await whisperRes.text().catch(() => "unknown");
    throw new Error(`Whisper transcription failed (${whisperRes.status}): ${errText}`);
  }

  const { text: transcribedText } = await whisperRes.json();
  if (!transcribedText?.trim()) {
    await sendReply(chatId, ":mic: Could not transcribe voice message (empty result).");
    return;
  }

  // 4. Show transcription and process as free text
  console.log(`[telegram-bot] voice transcription: "${transcribedText.slice(0, 80)}"`);
  await sendReply(chatId, `:mic: _${transcribedText}_`, { parseMode: "Markdown" });

  // Route through the same free-text handler
  if (transcribedText.startsWith("/")) {
    enqueueCommand(() => handleCommand(transcribedText, chatId));
  } else if (getActiveAgentSession(chatId)?.running === true) {
    safeDetach("voice-text", () => handleFreeText(transcribedText, chatId));
  } else {
    enqueueAgentTask(() => handleFreeText(transcribedText, chatId), chatId);
  }
}

async function handleUpdate(update) {
  // Handle inline keyboard button presses
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  if (!update.message) return;

  const msg = update.message;
  const chatId = String(msg.chat?.id);
  const fromId = String(msg.from?.id || "");
  const text = (msg.text || "").trim();

  const presencePayload = text ? parsePresenceMessage(text) : null;
  if (presencePayload) {
    if (!presenceChatId || chatId !== String(presenceChatId)) {
      console.warn(
        `[telegram-bot] ignored presence from chat ${chatId} (expected ${presenceChatId || "unset"})`,
      );
      return;
    }
    await ensurePresenceReady();
    const receivedAt = Number.isFinite(msg.date)
      ? new Date(msg.date * 1000).toISOString()
      : new Date().toISOString();
    await notePresence(presencePayload, {
      source: "telegram",
      receivedAt,
    });
    return;
  }

  // Security: only accept from configured chat/user allow-list
  if (!isAuthorizedTelegramActor(chatId, fromId)) {
    console.warn(
      `[telegram-bot] rejected message from chat ${chatId} user ${fromId || "unknown"} (allowed: ${Array.from(telegramAllowedChatIds).join(",") || "none"})`,
    );
    return;
  }

  if (msg.web_app_data?.data) {
    await handleWebAppData(msg.web_app_data.data, chatId);
    return;
  }

  // ── Voice message handling: transcribe and process as free text ──
  if (msg.voice || msg.audio) {
    const voiceFile = msg.voice || msg.audio;
    try {
      await transcribeAndProcessVoice(voiceFile, chatId);
    } catch (err) {
      console.error(`[telegram-bot] voice processing error:`, err.message);
      await sendReply(chatId, `:alert: Could not process voice message: ${err.message}`);
    }
    return;
  }

  if (!text) return;

  console.log(
    `[telegram-bot] received: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}" from chat ${chatId}`,
  );

  const pendingInput = getPendingUiInput(chatId);
  if (pendingInput) {
    const cmdText = text.split(/\s+/)[0].toLowerCase().replace(/@\w+/, "");
    if (cmdText === "/cancel") {
      clearPendingUiInput(chatId);
      if (isStickyMenuInteractive(chatId)) {
        await restoreStickyMenuMessage(chatId);
      } else {
        await sendReply(chatId, ":check: Input cancelled.");
      }
      return;
    }
    if (!text.startsWith("/")) {
      const request = consumePendingUiInput(chatId);
      if (request) {
        await handleUiInput(chatId, request, text);
        return;
      }
    }
  }

  // Route: slash command or free-text
  if (text.startsWith("/")) {
    const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@\w+/, "");
    if (FAST_COMMANDS.has(cmd)) {
      enqueueFastCommand(() => handleCommand(text, chatId));
      return;
    }
    enqueueCommand(() => handleCommand(text, chatId));
    return;
  }

  // Free-text agent task runs in a separate per-chat queue so one chat does not
  // block another. If this same chat already has an active run, handle
  // immediately so follow-ups can be queued into that run.
  if (getActiveAgentSession(chatId)?.running === true) {
    safeDetach("free-text", () => handleFreeText(text, chatId));
    return;
  }
  enqueueAgentTask(() => handleFreeText(text, chatId), chatId);
}

// ── Command Router ────────────────────────────────────────────────────────────

// ── Task Pause / Resume / Repos ──────────────────────────────────────────────

/**
 * /pausetasks — Pause the task executor (running agents continue, no new dispatch)
 */
async function cmdPauseTasks(chatId) {
  const executor = _getInternalExecutor?.();
  if (!executor) {
    return sendDirect(
      chatId,
      ":alert: Internal executor not enabled — nothing to pause.",
    );
  }
  if (executor.isPaused()) {
    const info = executor.getPauseInfo();
    const dur = info.pauseDuration;
    return sendDirect(
      chatId,
      `:pause: Already paused (${dur >= 60 ? Math.round(dur / 60) + "m" : dur + "s"} ago).\nUse /resumetasks to resume.`,
    );
  }
  executor.pause();
  const status = executor.getStatus();
  const lines = [`:pause: *Task executor paused*`];
  if (status.activeSlots > 0) {
    lines.push(
      `\n${status.activeSlots} running task(s) will continue to completion.`,
    );
    lines.push(`No new tasks will be dispatched until /resumetasks.`);
  } else {
    lines.push(`No tasks running. Use /resumetasks when ready.`);
  }
  const keyboard = {
    inline_keyboard: [
      [
        { text: ":play: Resume Tasks", callback_data: "cb:confirm_resume" },
        { text: ":chart: Status", callback_data: "/status" },
      ],
    ],
  };
  return sendDirect(chatId, lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

/**
 * /resumetasks — Resume the task executor
 */
async function cmdResumeTasks(chatId) {
  const executor = _getInternalExecutor?.();
  if (!executor) {
    return sendDirect(
      chatId,
      ":alert: Internal executor not enabled — nothing to resume.",
    );
  }
  if (!executor.isPaused()) {
    return sendDirect(chatId, ":play: Executor is already running — not paused.");
  }
  const info = executor.getPauseInfo();
  const dur = info.pauseDuration;
  executor.resume();
  const durStr = dur >= 60 ? Math.round(dur / 60) + "m" : dur + "s";
  const keyboard = {
    inline_keyboard: [
      [
        { text: ":pause: Pause Tasks", callback_data: "cb:confirm_pause" },
        { text: ":clipboard: Tasks", callback_data: "/tasks" },
      ],
    ],
  };
  return sendDirect(
    chatId,
    `:play: *Task executor resumed* (was paused for ${durStr}).\nWill pick up tasks on next poll cycle.`,
    { parse_mode: "Markdown", reply_markup: keyboard },
  );
}

/**
 * /repos — View configured repositories and their status
 */
async function cmdRepos(chatId, _text) {
  try {
    const loadConfig = (await import("../config/config.mjs")).default;
    const config = loadConfig();
    const repos = Array.isArray(config.repositories) ? config.repositories : [];
    const selected = config.selectedRepository || null;
    const activeWorkspace = config.activeWorkspace || "";

    if (repos.length === 0) {
      return sendDirect(
        chatId,
        [
          ":folder: *Repositories*",
          "",
          `Active: \`${config.repoSlug || config.repoRoot || "current directory"}\``,
          "",
          "_Single-repo mode. Add repositories in bosun.config.json:_",
          "\`\`\`json",
          JSON.stringify(
            {
              repositories: [
                {
                  name: "backend",
                  path: "./",
                  slug: "org/backend",
                  primary: true,
                },
                { name: "frontend", path: "../frontend", slug: "org/frontend" },
              ],
            },
            null,
            2,
          ),
          "\`\`\`",
        ].join("\n"),
        { parse_mode: "Markdown" },
      );
    }

    const lines = [":folder: *Repositories*", ""];
    if (activeWorkspace) {
      lines.push(`Workspace: \`${activeWorkspace}\``, "");
    }
    for (const repo of repos) {
      const isCurrent =
        repo.id === selected?.id ||
        repo.name === selected?.name ||
        repo.slug === selected?.slug ||
        repo.primary;
      const icon = isCurrent ? ":dot:" : ":dot:";
      const primary = repo.primary ? " _(primary)_" : "";
      lines.push(
        `${icon} \`${repo.name}\` — ${repo.slug || repo.path || "?"}${primary}`,
      );
    }
    lines.push("");
    lines.push(`Selected: \`${selected?.name || selected?.slug || selected?.id || "(auto)"}\``);
    lines.push("Switch workspace: \`/workspace switch <id>\`");

    return sendDirect(chatId, lines.join("\n"), { parse_mode: "Markdown" });
  } catch (err) {
    return sendDirect(chatId, `:close: Failed to read repo config: ${err.message}`);
  }
}

/**
 * /workspace — list/switch/scan/create/add-repo/remove-repo/pull/delete local BOSUN_DIR workspaces.
 *
 * Usage:
 *   /workspace                                        — list all workspaces
 *   /workspace list                                   — list all workspaces
 *   /workspace switch <id>                            — switch active workspace
 *   /workspace scan                                   — detect new workspaces from disk
 *   /workspace create <name>                          — create a new workspace
 *   /workspace add-repo <wsId> <gitUrl> [branch]      — clone a repo into workspace
 *   /workspace remove-repo <wsId> <repoName>          — remove a repo from workspace
 *   /workspace pull [wsId]                            — pull all repos in workspace
 *   /workspace delete <wsId>                          — delete a workspace
 */
async function cmdWorkspace(chatId, text) {
  const raw = String(text || "")
    .replace(/^\/workspace\b/i, "")
    .trim();
  const [sub, ...rest] = raw ? raw.split(/\s+/) : [];
  const subcmd = String(sub || "list").toLowerCase();
  const configDir = resolveTelegramConfigDir();

  try {
    if (subcmd === "scan") {
      const merged = mergeDetectedWorkspaces(configDir);
      await sendReply(
        chatId,
        [
          ":search: Workspace Scan Complete",
          `Scanned: ${merged.scanned}`,
          `Added: ${merged.added}`,
          `Updated: ${merged.updated}`,
          "",
          "Use /workspace to view all workspaces.",
        ].join("\n"),
      );
      return;
    }

    if (subcmd === "switch") {
      const targetId = String(rest[0] || "").trim();
      if (!targetId) {
        await sendReply(chatId, "Usage: /workspace switch <id>");
        return;
      }
      setActiveLocalWorkspace(configDir, targetId);
      const active = getActiveLocalWorkspace(configDir);
      await sendReply(
        chatId,
        `:check: Active workspace: ${active?.name || targetId} (\`${active?.id || targetId}\`)`,
      );
      return;
    }

    if (subcmd === "create") {
      const name = rest.join(" ").trim();
      if (!name) {
        await sendReply(chatId, "Usage: /workspace create <name>");
        return;
      }
      const ws = createManagedWs(configDir, { name });
      await sendReply(
        chatId,
        `:check: Created workspace: *${ws.name}* (\`${ws.id}\`)\nPath: \`${ws.path}\``,
        { parseMode: "Markdown" },
      );
      return;
    }

    if (subcmd === "add-repo" || subcmd === "addrepo") {
      const wsId = String(rest[0] || "").trim();
      const gitUrl = String(rest[1] || "").trim();
      const branch = rest[2] || undefined;
      if (!wsId || !gitUrl) {
        await sendReply(chatId, "Usage: /workspace add-repo <wsId> <gitUrl> [branch]");
        return;
      }
      await sendReply(chatId, `:clock: Cloning ${gitUrl} into workspace ${wsId}...`);
      const repo = addRepoToManagedWs(configDir, wsId, {
        url: gitUrl,
        branch,
      });
      await sendReply(
        chatId,
        `:check: Added repo *${repo.name}* to workspace \`${wsId}\`\n${repo.cloned ? "Cloned from remote" : "Already existed on disk"}`,
        { parseMode: "Markdown" },
      );
      return;
    }

    if (subcmd === "remove-repo" || subcmd === "removerepo") {
      const wsId = String(rest[0] || "").trim();
      const repoName = String(rest[1] || "").trim();
      if (!wsId || !repoName) {
        await sendReply(chatId, "Usage: /workspace remove-repo <wsId> <repoName>");
        return;
      }
      const removed = removeRepoFromManagedWs(configDir, wsId, repoName);
      await sendReply(
        chatId,
        removed
          ? `:check: Removed repo \`${repoName}\` from workspace \`${wsId}\``
          : `:alert: Repo \`${repoName}\` not found in workspace \`${wsId}\``,
      );
      return;
    }

    if (subcmd === "pull") {
      const wsId = String(rest[0] || "").trim();
      if (!wsId) {
        const active = getActiveLocalWorkspace(configDir);
        if (!active) {
          await sendReply(chatId, "Usage: /workspace pull <wsId> (no active workspace)");
          return;
        }
        await sendReply(chatId, `:clock: Pulling repos in workspace ${active.name}...`);
        const results = pullManagedWsRepos(configDir, active.id);
        const lines = results.map(
          (r) => `${r.success ? ":check:" : ":close:"} ${r.name}${r.error ? ` — ${r.error}` : ""}`,
        );
        await sendReply(chatId, ["Pull results:", ...lines].join("\n"));
        return;
      }
      await sendReply(chatId, `:clock: Pulling repos in workspace ${wsId}...`);
      const results = pullManagedWsRepos(configDir, wsId);
      const lines = results.map(
        (r) => `${r.success ? ":check:" : ":close:"} ${r.name}${r.error ? ` — ${r.error}` : ""}`,
      );
      await sendReply(chatId, ["Pull results:", ...lines].join("\n"));
      return;
    }

    if (subcmd === "delete" || subcmd === "remove") {
      const wsId = String(rest[0] || "").trim();
      if (!wsId) {
        await sendReply(chatId, "Usage: /workspace delete <wsId>");
        return;
      }
      const deleted = removeManagedWs(configDir, wsId, { deleteFiles: false });
      await sendReply(
        chatId,
        deleted
          ? `:check: Removed workspace \`${wsId}\` from config (files preserved on disk)`
          : `:alert: Workspace \`${wsId}\` not found`,
      );
      return;
    }

    // Default: list
    const workspaces = listLocalWorkspaces(configDir);
    const active = getActiveLocalWorkspace(configDir);
    if (!workspaces.length) {
      await sendReply(
        chatId,
        [
          ":git: No local workspaces configured.",
          `Expected directory: ${resolve(configDir, "workspaces")}`,
          "",
          "Quick start:",
          "• /workspace create MyProject",
          "• /workspace add-repo myproject git@github.com:org/repo.git",
          "• /workspace scan (auto-detect existing repos)",
        ].join("\n"),
      );
      return;
    }

    const lines = [":git: *Local Workspaces*", ""];
    for (const workspace of workspaces) {
      const marker = workspace.id === active?.id ? ":dot:" : ":dot:";
      const repoCount = Array.isArray(workspace.repos) ? workspace.repos.length : 0;
      lines.push(`${marker} *${workspace.name}* (\`${workspace.id}\`) — ${repoCount} repo(s)`);
      for (const repo of (workspace.repos || []).slice(0, 4)) {
        const primary = repo.primary ? ":star: " : "";
        const exists = repo.exists === false ? ":close:" : ":check:";
        lines.push(`   ${exists} ${primary}${repo.name}${repo.slug ? ` (${repo.slug})` : ""}`);
      }
      if ((workspace.repos || []).length > 4) {
        lines.push(`   … +${workspace.repos.length - 4} more`);
      }
    }
    lines.push("");
    lines.push("Commands:");
    lines.push("• /workspace switch <id>");
    lines.push("• /workspace create <name>");
    lines.push("• /workspace add-repo <wsId> <url>");
    lines.push("• /workspace pull [wsId]");
    lines.push("• /workspace scan");
    await sendReply(chatId, lines.join("\n"), { parseMode: "Markdown" });
  } catch (err) {
    await sendReply(chatId, `:close: Workspace command failed: ${err.message}`);
  }
}

/**
 * /maxparallel — View or set max parallel task slots
 */
async function cmdMaxParallel(chatId, text) {
  const executor = _getInternalExecutor?.();
  if (!executor) {
    return sendDirect(chatId, ":alert: Internal executor not enabled.");
  }
  const arg = (text || "").replace("/maxparallel", "").trim();
  if (arg) {
    const n = parseInt(arg, 10);
    if (isNaN(n) || n < 0 || n > 20) {
      return sendDirect(chatId, ":alert: Provide a number between 0 and 20.");
    }
    const old = executor.maxParallel;
    executor.maxParallel = n;
    if (n === 0) {
      executor.pause();
      return sendDirect(
        chatId,
        `:pause: Max parallel set to 0 — executor paused. Use /maxparallel <n> to resume.`,
      );
    }
    if (executor.isPaused() && n > 0) {
      executor.resume();
    }
    return sendDirect(chatId, `:check: Max parallel: ${old} → ${n}`);
  }
  const status = executor.getStatus();
  return sendDirect(
    chatId,
    `:chart: Max parallel: ${status.maxParallel} (active: ${status.activeSlots})`,
  );
}

/**
 * /whatsapp — Show WhatsApp channel status
 */
async function cmdWhatsApp(chatId) {
  try {
    const { isWhatsAppEnabled, getWhatsAppStatus } =
      await import("./whatsapp-channel.mjs");
    if (!isWhatsAppEnabled()) {
      return sendDirect(
        chatId,
        ":dot: WhatsApp channel is not enabled.\n\nSet WHATSAPP_ENABLED=1 in your .env to enable.",
      );
    }
    const status = getWhatsAppStatus();
    const lines = [
      ":phone: <b>WhatsApp Channel Status</b>",
      "",
      `Status: ${status.connected ? ":dot: Connected" : ":dot: Disconnected"}`,
      `Chat ID: <code>${status.chatId || "not set"}</code>`,
      `Pending messages: ${status.pendingMessages || 0}`,
    ];
    if (status.connectedAt) {
      const ago = Math.round((Date.now() - status.connectedAt) / 60000);
      lines.push(`Connected: ${ago}m ago`);
    }
    return sendDirect(chatId, lines.join("\n"), { parse_mode: "HTML" });
  } catch (err) {
    return sendDirect(chatId, `:close: WhatsApp status error: ${err.message}`);
  }
}

/**
 * /container — Show container runtime status
 */
async function cmdContainer(chatId) {
  try {
    const { isContainerEnabled, getContainerStatus } =
      await import("../infra/container-runner.mjs");
    if (!isContainerEnabled()) {
      return sendDirect(
        chatId,
        ":dot: Container isolation is not enabled.\n\nSet CONTAINER_ENABLED=1 in your .env to enable.",
      );
    }
    const status = getContainerStatus();
    const lines = [
      ":box: <b>Container Runtime Status</b>",
      "",
      `Runtime: ${status.runtime || "detecting..."}`,
      `Active containers: ${status.activeContainers || 0}`,
      `Max concurrent: ${status.maxConcurrent || "unlimited"}`,
    ];
    if (status.image) {
      lines.push(`Image: <code>${status.image}</code>`);
    }
    return sendDirect(chatId, lines.join("\n"), { parse_mode: "HTML" });
  } catch (err) {
    return sendDirect(chatId, `:close: Container status error: ${err.message}`);
  }
}

const COMMANDS = {
  "/menu": { handler: cmdMenu, desc: "Open the control center UI" },
  "/help": { handler: cmdHelp, desc: "Show available commands" },
  "/helpfull": { handler: cmdHelpFull, desc: "Show all commands (text list)" },
  "/commands": { handler: cmdHelpFull, desc: "Alias for /helpfull" },
  "/app": { handler: cmdApp, desc: "Open the Control Center Mini App" },
  "/miniapp": { handler: cmdApp, desc: "Open the Control Center Mini App" },
  "/webapp": { handler: cmdApp, desc: "Open the Control Center Mini App" },
  "/call": { handler: cmdCall, desc: "Open one-click voice meeting room" },
  "/videocall": {
    handler: cmdVideoCall,
    desc: "Open one-click video meeting room",
  },
  "/cancel": { handler: cmdCancel, desc: "Cancel a pending input prompt" },
  "/ask": { handler: cmdAsk, desc: "Send prompt to agent: /ask <prompt>" },
  "/status": { handler: cmdStatus, desc: "Detailed orchestrator status" },
  "/tasks": {
    handler: cmdTasks,
    desc: "Active tasks, workspace metrics & retries",
  },
  "/starttask": {
    handler: cmdStartTask,
    desc: "Manual start of a task: /starttask <taskId>",
  },
  "/agents": {
    handler: cmdAgents,
    desc: "Show all active monitor/task/review/conflict agents",
  },
  "/logs": { handler: cmdLogs, desc: "Recent monitor logs" },
  "/telemetry": {
    handler: cmdTelemetry,
    desc: "Telemetry summary: /telemetry [errors|executors|alerts]",
  },
  "/weekly": {
    handler: cmdWeeklyReport,
    desc: "Weekly agent work report: /weekly [days]",
  },
  "/report": {
    handler: cmdReport,
    desc: "Report aliases: /report weekly [days]",
  },
  "/agentlogs": {
    handler: cmdAgentLogs,
    desc: "Agent output for branch: /agentlogs <branch>",
  },
  "/log": { handler: cmdLogs, desc: "Alias for /logs" },
  "/branches": { handler: cmdBranches, desc: "Recent git branches" },
  "/diff": { handler: cmdDiff, desc: "Git diff summary (staged)" },
  "/restart": { handler: cmdRestart, desc: "Full Bosun restart (all services)" },
  // Hidden — no desc so it's excluded from /help, /helpfull, and Telegram autocomplete.
  // Only surfaces in the security warning when TELEGRAM_UI_ALLOW_UNSAFE=true.
  "/disable_unsafe_access": { handler: cmdDisableUnsafeAccess },
  "/retry": {
    handler: cmdRetry,
    desc: "Start fresh session for stuck task: /retry [reason]",
  },
  "/plan": {
    handler: cmdPlan,
    desc: "Run task planner workflow: /plan [count] [focus]",
  },
  "/cleanup": {
    handler: cmdCleanupMerged,
    desc: "Reconcile tasks with merged PRs/branches",
  },
  "/reconcile": {
    handler: cmdCleanupMerged,
    desc: "Alias for /cleanup",
  },
  "/history": {
    handler: cmdHistory,
    desc: "Primary agent session history",
  },
  "/clear": {
    handler: cmdClear,
    desc: "Clear primary agent session context",
  },
  "/reset_thread": {
    handler: cmdClear,
    desc: "Alias for /clear (reset thread)",
  },
  "/git": { handler: cmdGit, desc: "Run a git command: /git log --oneline -5" },
  "/shell": { handler: cmdShell, desc: "Run a shell command: /shell ls -la" },
  "/background": {
    handler: cmdBackground,
    desc: "Run a task in background or background the active agent",
  },
  "/region": {
    handler: cmdRegion,
    desc: "View/switch Codex region: /region [us|sweden|auto]",
  },
  "/health": {
    handler: cmdHealth,
    desc: "Executor health status & model routing",
  },
  "/anomalies": {
    handler: cmdAnomalies,
    desc: "Agent anomaly detector status & active concerns",
  },
  "/model": {
    handler: cmdModel,
    desc: "Override executor for next task: /model gpt-5.2-codex",
  },
  "/sdk": {
    handler: cmdSdk,
    desc: "View/switch agent pool SDK: /sdk [codex|copilot|claude]",
  },
  "/kanban": {
    handler: cmdKanban,
    desc: "View/switch kanban backend: /kanban [internal|github|jira]",
  },
  "/autobacklog": {
    handler: cmdAutoBacklog,
    desc: "Experimental backlog replenishment controls",
  },
  "/requirements": {
    handler: cmdRequirements,
    desc: "Set project requirements profile",
  },
  "/threads": {
    handler: cmdThreads,
    desc: "View active agent threads: /threads [clear]",
  },
  "/worktrees": {
    handler: cmdWorktrees,
    desc: "View/manage worktrees: /worktrees [prune|release <taskKey>]",
  },
  "/executor": {
    handler: cmdExecutor,
    desc: "View/manage executor mode: /executor [status|mode <internal|hybrid>|slots]",
  },
  "/shared_workspaces": {
    handler: cmdSharedWorkspaces,
    desc: "List shared cloud workspace availability",
  },
  "/claim": {
    handler: cmdSharedWorkspaceClaim,
    desc: "Claim a shared workspace: /claim <id> [--owner <id>] [--ttl <minutes>]",
  },
  "/release": {
    handler: cmdSharedWorkspaceRelease,
    desc: "Release a shared workspace: /release <id> [--owner <id>] [--force]",
  },
  "/agent": {
    handler: cmdAgent,
    desc: "Route a task to a workspace: /agent --workspace <id> <task>",
  },
  "/stop": {
    handler: cmdStop,
    desc: "Stop the running agent and wait for new instructions",
  },
  "/steer": {
    handler: cmdSteer,
    desc: "Steer a running agent: /steer focus on X",
  },
  "/context": {
    handler: cmdSteer,
    desc: "Alias for /steer — update in-flight agent context",
  },
  "/presence": {
    handler: cmdPresence,
    desc: "Show active bosun instances",
  },
  "/instances": {
    handler: cmdPresence,
    desc: "Alias for /presence",
  },
  "/coordinator": {
    handler: cmdCoordinator,
    desc: "Show current coordinator selection",
  },
  "/pausetasks": {
    handler: cmdPauseTasks,
    desc: "Pause task dispatch (running tasks continue)",
  },
  "/resumetasks": {
    handler: cmdResumeTasks,
    desc: "Resume task dispatch after pause",
  },
  "/pause": {
    handler: cmdPauseTasks,
    desc: "Alias for /pausetasks",
  },
  "/resume": {
    handler: cmdResumeTasks,
    desc: "Alias for /resumetasks",
  },
  "/repos": {
    handler: cmdRepos,
    desc: "View configured repositories",
  },
  "/workspace": {
    handler: cmdWorkspace,
    desc: "List/switch/scan local workspaces",
  },
  "/maxparallel": {
    handler: cmdMaxParallel,
    desc: "View/set max parallel slots: /maxparallel [n]",
  },
  "/whatsapp": {
    handler: cmdWhatsApp,
    desc: "WhatsApp channel status",
  },
  "/container": {
    handler: cmdContainer,
    desc: "Container runtime status",
  },
  "/workspace": {
    handler: cmdWorkspace,
    desc: "Manage workspaces: /workspace [list|switch|create|add-repo|pull|scan|delete]",
  },
  "/ws": {
    handler: cmdWorkspace,
    desc: "Alias for /workspace",
  },
};

/**
 * Quick connectivity probe — calls getMe with minimal retries.
 * Returns true if Telegram API is reachable, false otherwise.
 */
async function probeTelegramConnectivity() {
  try {
    const res = await telegramApiFetch("getMe", {
      method: "GET",
      retries: 1,
      retryOnStatus: false,
      timeoutMs: 10_000,
      operation: "getMe",
    });
    const ok = res && res.ok;
    telegramApiReachable = !!ok;
    return telegramApiReachable;
  } catch {
    telegramApiReachable = false;
    return false;
  }
}

/**
 * Delete all existing bot commands from every scope to clear stale/old entries.
 * Telegram stores commands per-scope, so we must clear each one explicitly.
 */
async function clearAllBotCommands() {
  const scopes = [
    { scope: { type: "default" } },
    { scope: { type: "all_private_chats" } },
    { scope: { type: "all_group_chats" } },
    { scope: { type: "all_chat_administrators" } },
  ];

  for (const body of scopes) {
    try {
      await telegramApiFetch("deleteMyCommands", {
        method: "POST",
        payload: body,
        retries: 1,
        retryOnStatus: false,
        operation: "deleteMyCommands",
      });
    } catch {
      /* best effort — scope may not have had commands */
    }
  }
}

/**
 * Sync the COMMANDS object to Telegram's bot command menu via setMyCommands.
 * First clears ALL existing commands from every scope to remove stale entries
 * (e.g. leftover commands from a previous project or bot configuration).
 * Then sets the current command list.
 */
async function registerBotCommands() {
  // Step 1: Clear all old commands from every scope
  await clearAllBotCommands();

  // Step 2: Build and register current commands
  const seen = new Set();
  const commands = [];
  for (const [cmd, entry] of Object.entries(COMMANDS)) {
    const command = cmd.replace(/^\//, ""); // strip leading /
    if (seen.has(command)) continue; // skip duplicate keys (e.g. /agent appears twice)
    // Telegram only allows lowercase letters, digits, underscores (1-32 chars)
    if (!/^[a-z0-9_]{1,32}$/.test(command)) {
      console.warn(`[telegram-bot] skipping invalid command name: /${command}`);
      continue;
    }
    seen.add(command);
    // Telegram limits description to 256 chars
    const description = (entry.desc || command).slice(0, 256);
    commands.push({ command, description });
  }

  let res;
  try {
    res = await telegramApiFetch("setMyCommands", {
      method: "POST",
      payload: { commands },
      operation: "setMyCommands",
    });
  } catch (err) {
    // Suppress if we already know the API is unreachable
    if (telegramApiReachable !== false) {
      console.warn(`[telegram-bot] setMyCommands error: ${err.message}`);
    }
    return;
  }

  try {
    const data = await res.json();
    if (data.ok) {
      console.log(
        `[telegram-bot] registered ${commands.length} commands with Telegram`,
      );
    } else {
      console.warn(
        `[telegram-bot] setMyCommands failed: ${data.description || JSON.stringify(data)}`,
      );
    }
  } catch (err) {
    console.warn(
      `[telegram-bot] setMyCommands JSON parse error: ${err.message}`,
    );
  }
}

async function setWebAppMenuButton(url) {
  if (!telegramToken || !url) return false;
  const webAppUrl = getTelegramWebAppUrl(url);
  if (!webAppUrl) return false;
  try {
    const payload = {
      menu_button: {
        type: "web_app",
        text: "Control Center",
        web_app: { url: webAppUrl },
      },
    };
    // Set for the specific chat so it takes effect immediately
    if (telegramChatId) payload.chat_id = telegramChatId;
    const res = await telegramApiFetch("setChatMenuButton", {
      method: "POST",
      payload,
      operation: "setChatMenuButton",
    });
    if (!res || typeof res.ok === "undefined") {
      throw new Error("invalid response object");
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      const details = data?.description || `${res.status} ${res.statusText || ""}`;
      throw new Error(details.trim());
    }
    console.log(`[telegram-bot] chat menu button set to ${webAppUrl}`);
    return true;
  } catch (err) {
    if (telegramApiReachable !== false) {
      console.warn(`[telegram-bot] setChatMenuButton error: ${err.message}`);
    }
    return false;
  }
}

async function clearWebAppMenuButton() {
  if (!telegramToken) return;
  try {
    const payload = { menu_button: { type: "default" } };
    if (telegramChatId) payload.chat_id = telegramChatId;
    await telegramApiFetch("setChatMenuButton", {
      method: "POST",
      payload,
      operation: "clearChatMenuButton",
    });
  } catch {
    /* best effort */
  }
}

const MENU_BUTTON_REFRESH_MS = 60 * 1000; // 1 minute — re-sync after tunnel URL rotates

async function refreshMenuButton() {
  const { uiUrl: currentUiUrl, webAppUrl: currentUrl } = syncUiUrlsFromServer();
  if (currentUrl && currentUrl !== lastMenuButtonUrl) {
    const updated = await setWebAppMenuButton(currentUrl);
    if (updated) {
      lastMenuButtonUrl = currentUrl;
      console.log(`[telegram-bot] menu button URL refreshed: ${currentUrl}`);
    }
  } else if (!currentUrl) {
    await clearWebAppMenuButton();
    lastMenuButtonUrl = null;
    if (currentUiUrl !== telegramUiUrl) {
      telegramUiUrl = currentUiUrl;
    }
  }
}

const FAST_COMMANDS = new Set([
  "/menu",
  "/call",
  "/videocall",
  "/background",
  "/status",
  "/weekly",
  "/tasks",
  "/agents",
  "/cancel",
  "/sdk",
  "/kanban",
  "/threads",
  "/worktrees",
  "/executor",
  "/pausetasks",
  "/resumetasks",
  "/pause",
  "/resume",
  "/maxparallel",
  "/repos",
  "/workspace",
  "/whatsapp",
  "/container",
]);

function getTelegramWebAppUrl(url) {
  // Telegram Mini App must be HTTPS and publicly reachable.
  // Priority: tunnel URL (permanent hostname) -> explicit env URL -> provided URL.
  const tUrl = getTunnelUrl();
  const explicit =
    process.env.TELEGRAM_WEBAPP_URL || process.env.TELEGRAM_UI_BASE_URL || "";
  const candidates = [tUrl, explicit, url];

  for (const candidate of candidates) {
    let normalized = String(candidate || "").trim();
    while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
    if (!normalized) continue;
    try {
      const parsed = new URL(normalized);
      if (parsed.protocol !== "https:") continue;
      let normalizedUrl = parsed.toString();
      while (normalizedUrl.endsWith("/")) normalizedUrl = normalizedUrl.slice(0, -1);
      return appendTokenToUrl(normalizedUrl, getSessionToken()) || normalizedUrl;
    } catch {
      // try next candidate
    }
  }

  const warnSource = String(explicit || tUrl || url || "").trim();
  if (warnSource && telegramWebAppUrlWarned !== warnSource) {
    telegramWebAppUrlWarned = warnSource;
    console.warn(
      `[telegram-bot] mini app URL requires a valid HTTPS URL. Got "${warnSource}". Falling back to browser URL buttons only.`,
    );
  }
  return null;
}

function appendTokenToUrl(inputUrl, token) {
  const raw = String(inputUrl || "").trim();
  if (!raw) return null;
  if (!token) return raw;
  try {
    const url = new URL(raw);
    url.searchParams.set("token", token);
    return url.toString();
  } catch {
    return raw;
  }
}

async function handleCommand(text, chatId) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@\w+/, ""); // strip @botname
  const cmdArgs = parts.slice(1).join(" ");

  const entry = COMMANDS[cmd] || COMMANDS[cmd.replace(/-/g, "_")];
  if (entry) {
    try {
      await entry.handler(chatId, cmdArgs);
    } catch (err) {
      await sendReply(chatId, `:close: Command error: ${err.message}`);
    }
  } else {
    await sendReply(
      chatId,
      `Unknown command: ${cmd}\nType /menu (or /helpfull) for available commands.`,
    );
  }
}

/**
 * Handle a command from the Mini App UI.
 * Runs the Telegram command handler silently (without sending to chat)
 * and returns a summary object. For read-only commands (/status, /health,
 * /tasks, etc.), captures the formatted output and returns it as `content`
 * so the MiniApp chat can render it inline without needing the agent.
 */
export async function handleUiCommand(text) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@\w+/, "");
  const cmdArgs = parts.slice(1).join(" ");

  const entry = COMMANDS[cmd] || COMMANDS[cmd.replace(/-/g, "_")];
  if (!entry) {
    return { executed: false, error: `Unknown command: ${cmd}` };
  }

  // For the UI, we don't actually need to run the Telegram chat command.
  // The UI already has dedicated API endpoints for data. We just acknowledge
  // and trigger a data refresh via the broadcast in the API handler.
  // For action commands like /restart, /plan, /retry, we run them.
  const ACTION_COMMANDS = new Set([
    "/restart", "/plan", "/retry", "/cleanup", "/prune",
    "/starttask", "/pause", "/resume", "/reconcile",
    "/autobacklog", "/requirements",
  ]);

  if (ACTION_COMMANDS.has(cmd)) {
    try {
      if (telegramChatId) {
        await entry.handler(telegramChatId, cmdArgs);
      }
      return { executed: true, command: cmd, args: cmdArgs };
    } catch (err) {
      return { executed: false, error: err.message };
    }
  }

  // For /help and /version, return inline content
  if (cmd === "/help" || cmd === "/helpfull") {
    const helpLines = Object.entries(COMMANDS)
      .filter(([, v]) => v.desc || v.description)
      .map(([k, v]) => `**${k}** — ${v.desc || v.description}`)
      .join("\n");
    return { executed: true, command: cmd, readOnly: true, content: `**Available Commands:**\n${helpLines}` };
  }
  if (cmd === "/version") {
    try {
      const { readFileSync } = await import("node:fs");
      const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      return { executed: true, command: cmd, readOnly: true, content: `**Bosun** v${pkg.version}` };
    } catch {
      return { executed: true, command: cmd, readOnly: true, content: "**Bosun** (version unknown)" };
    }
  }

  // For read-only data commands, capture their output by running against
  // a fake chatId that collects messages instead of sending to Telegram.
  const DATA_COMMANDS = new Set([
    "/status", "/health", "/tasks", "/logs", "/agents",
    "/branches", "/diff", "/threads", "/sdk", "/kanban",
    "/executor", "/hooks", "/sentinel", "/anomalies",
    "/worktrees", "/region", "/presence", "/coordinator",
    "/history",
  ]);

  if (DATA_COMMANDS.has(cmd) && entry.handler) {
    try {
      _uiCaptureBuffer = [];
      try {
        await entry.handler("__ui_capture__", cmdArgs);
      } finally {
        const captured = _uiCaptureBuffer;
        _uiCaptureBuffer = null;
        const content = captured.join("\n\n").trim();
        if (content) {
          return { executed: true, command: cmd, readOnly: true, content };
        }
      }
    } catch {
      // Fall through to generic acknowledgment
    }
  }

  return { executed: true, command: cmd, args: cmdArgs, readOnly: true };
}

// ── UI Menu System ──────────────────────────────────────────────────────────

const UI_INPUT_HANDLERS = {
  ask: {
    prompt: "Send your question for the primary agent.",
    buildCommand: (input) => `/ask ${input}`,
  },
  agentlogs: {
    prompt: "Enter a branch fragment to view logs.",
    buildCommand: (input) => `/agentlogs ${input}`,
  },
  git: {
    prompt: "Enter git arguments (example: log --oneline -5).",
    buildCommand: (input) => `/git ${input}`,
  },
  shell: {
    prompt: "Enter a shell command to run.",
    buildCommand: (input) => `/shell ${input}`,
  },
  plan_count: {
    prompt: "Optional: number of tasks then focus text (example: 5 stabilize planner imports).",
    buildCommand: () => `/plan`,
  },
  plan_prompt: {
    prompt: "Optional: number of tasks then focus text (example: 5 stabilize planner imports).",
    buildCommand: () => `/plan`,
  },
  starttask: {
    prompt:
      "Enter the task ID to start manually.\nNext you'll pick executor → SDK → model.",
    buildCommand: (input) => `/starttask ${input}`,
  },
  starttask_model: {
    prompt: (ctx) =>
      `Model for ${ctx.sdk || "selected"} (${ctx.executor || "executor"}). ` +
      "Type a model name or 'default' to use the standard route.",
    buildCommand: () => null,
  },
  retry_reason: {
    prompt: "Retry reason (any short label).",
    buildCommand: (input) => `/retry ${input}`,
  },
  steer: {
    prompt: "Send steering instructions for the active agent.",
    buildCommand: (input) => `/steer ${input}`,
  },
  background: {
    prompt: "Send the background task description.",
    buildCommand: (input) => `/background ${input}`,
  },
  maxparallel: {
    prompt: "Set max parallel slots (0-20).",
    buildCommand: (input) => `/maxparallel ${input}`,
  },
  logs_lines: {
    prompt: "How many log lines should I show?",
    buildCommand: (input) => `/logs ${input}`,
  },
  threads_kill: {
    prompt: "Task key to invalidate.",
    buildCommand: (input) => `/threads kill ${input}`,
    confirm: true,
    confirmTitle: "Invalidate Thread",
    confirmLabel: "Invalidate",
    confirmBackAction: "go:threads_kill",
    confirmDetails: (input) => [`Task Key: \`${input}\``],
  },
  worktrees_release: {
    prompt: "Task key to release.",
    buildCommand: (input) => `/worktrees release ${input}`,
    confirm: true,
    confirmTitle: "Release Worktree",
    confirmLabel: "Release",
    confirmBackAction: "go:worktrees_release",
    confirmDetails: (input) => [`Task Key: \`${input}\``],
  },
  shared_detail: {
    prompt: "Shared workspace ID to inspect.",
    buildCommand: (input) => `/shared_workspaces ${input}`,
  },
  shared_claim: {
    prompt: 'Claim workspace (id or full args, e.g. "cloud-01 --ttl 120").',
    buildCommand: (input) => `/claim ${input}`,
    confirm: true,
    confirmTitle: "Claim Shared Workspace",
    confirmLabel: "Claim",
    confirmBackAction: "go:shared_claim",
    confirmDetails: (input) => [`Args: \`${shortSnippet(input, 120)}\``],
  },
  shared_release: {
    prompt: 'Release workspace (id or full args, e.g. "cloud-01 --force").',
    buildCommand: (input) => `/release ${input}`,
    confirm: true,
    confirmTitle: "Release Shared Workspace",
    confirmLabel: "Release",
    confirmBackAction: "go:shared_release",
    confirmDetails: (input) => [`Args: \`${shortSnippet(input, 120)}\``],
  },
  agent_custom: {
    prompt:
      'Enter /agent arguments (everything after /agent). Example: "--workspace cloud-01 Update docs"',
    buildCommand: (input) => `/agent ${input}`,
  },
  agent_workspace_task: {
    prompt: (ctx) => `Task for workspace ${ctx.workspaceId}:`,
    buildCommand: (input, ctx) => `${ctx.commandPrefix}${input}`,
  },
  workspace_switch: {
    prompt: "Workspace id to activate.",
    buildCommand: (input) => `/workspace switch ${input}`,
  },
  workspace_create: {
    prompt: "Enter a name for the new workspace (letters, numbers, hyphens).",
    buildCommand: (input) => `/workspace create ${input}`,
  },
  workspace_add_repo: {
    prompt: (ctx) =>
      ctx?.workspaceId
        ? `Enter the git URL to clone into workspace "${ctx.workspaceId}":`
        : "Enter: <workspace-id> <git-url>",
    buildCommand: (input, ctx) =>
      ctx?.workspaceId
        ? `/workspace add-repo ${ctx.workspaceId} ${input}`
        : `/workspace add-repo ${input}`,
  },
  workspace_delete: {
    prompt: "Enter the workspace ID to delete.",
    buildCommand: (input) => `/workspace delete ${input}`,
    confirm: true,
    confirmTitle: "Delete Workspace",
    confirmLabel: "Delete",
    confirmBackAction: "go:managed_workspaces",
    confirmDetails: (input) => [`Workspace: \`${shortSnippet(input, 60)}\``],
  },
  agent_role_task: {
    prompt: (ctx) => `Task for role ${ctx.role}:`,
    buildCommand: (input, ctx) => `${ctx.commandPrefix}${input}`,
  },
};

function uiCallback(action) {
  return `ui:${action}`;
}

function uiGoAction(screenId, page = null) {
  return page === null || page === undefined
    ? `go:${screenId}`
    : `go:${screenId}:${page}`;
}

function uiCmdAction(command) {
  return `cmd:${command}`;
}

function uiInputAction(key) {
  return `input:${key}`;
}

function uiTokenAction(token) {
  return `token:${token}`;
}

function uiButton(text, action) {
  const normalizedText = formatTelegramIconTokens(text, { button: true });
  if (typeof action === "string" && (action.startsWith("cb:") || action.startsWith("ui:"))) {
    return { text: normalizedText, callback_data: action };
  }
  return { text: normalizedText, callback_data: uiCallback(action) };
}

function buildKeyboard(rows) {
  return { inline_keyboard: rows };
}

function buildConfirmKeyboard(confirmId, confirmLabel = "Confirm") {
  return {
    inline_keyboard: [
      [
        { text: `:check: ${confirmLabel}`, callback_data: confirmId },
        { text: ":close: Cancel", callback_data: "cb:dismiss" },
      ],
    ],
  };
}

function buildActionConfirmKeyboard(confirmId, confirmLabel, backAction) {
  const rows = [
    [
      { text: `:check: ${confirmLabel || "Confirm"}`, callback_data: confirmId },
      { text: ":close: Cancel", callback_data: "cb:dismiss" },
    ],
  ];
  if (backAction) {
    rows.push([uiButton(":arrowRight: Back", backAction)]);
  }
  return { inline_keyboard: rows };
}

function appendRefreshRow(keyboard, screenId, params = {}) {
  if (!keyboard || !keyboard.inline_keyboard) return keyboard;
  const hasExtraParams =
    params &&
    Object.keys(params).some((key) => key !== "page" && params[key] !== undefined);
  const action = hasExtraParams
    ? uiTokenAction(
        issueUiToken({
          type: "go",
          screenId,
          params,
        }),
      )
    : uiGoAction(screenId, params.page);
  const rows = keyboard.inline_keyboard || [];
  const refreshLabel = formatTelegramIconTokens(":refresh: Refresh", { button: true });
  const hasRefresh = rows.some((row) =>
    row.some((btn) =>
      btn?.text === ":refresh: Refresh"
      || btn?.text === refreshLabel
      || btn?.callback_data === action),
  );
  if (hasRefresh) return keyboard;
  return {
    ...keyboard,
    inline_keyboard: [...rows, [uiButton(":refresh: Refresh", action)]],
  };
}

function chunkButtons(buttons, perRow = 2) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(buttons.slice(i, i + perRow));
  }
  return rows;
}

function shortenLabel(value, maxLen = 24) {
  const text = String(value || "");
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function parseUiAction(data) {
  const payload = data.startsWith("ui:") ? data.slice(3) : data;
  const [type, ...rest] = payload.split(":");
  return { type, rest, raw: payload };
}

// ── Set of commands whose output can be captured and rendered inline ─────────
const INLINE_CAPTURABLE_COMMANDS = new Set([
  "/status", "/health", "/tasks", "/logs", "/agents",
  "/branches", "/diff", "/threads", "/sdk", "/kanban",
  "/executor", "/hooks", "/sentinel", "/anomalies",
  "/worktrees", "/region", "/presence", "/coordinator",
  "/history", "/metrics", "/repos", "/container",
  "/whatsapp", "/model",
]);

/**
 * Capture the text output of a command without sending it to Telegram.
 * Returns the captured text (joined with double-newline) or null on failure.
 */
async function captureCommandOutput(command) {
  const parts = command.split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@\w+/, "");
  const cmdArgs = parts.slice(1).join(" ");
  const entry = COMMANDS[cmd] || COMMANDS[cmd.replace(/-/g, "_")];
  if (!entry?.handler) return null;
  _uiCaptureBuffer = [];
  try {
    await entry.handler("__ui_capture__", cmdArgs);
  } catch {
    _uiCaptureBuffer = null;
    return null;
  }
  const captured = _uiCaptureBuffer;
  _uiCaptureBuffer = null;
  const content = captured.join("\n\n").trim();
  return content || null;
}

async function dispatchUiCommand(chatId, command) {
  const cmd = command.split(/\s+/)[0].toLowerCase().replace(/@\w+/, "");
  if (FAST_COMMANDS.has(cmd)) {
    enqueueFastCommand(() => handleCommand(command, chatId));
    return;
  }
  enqueueCommand(() => handleCommand(command, chatId));
}

async function promptUiInput(chatId, key, extra = {}) {
  const handler = UI_INPUT_HANDLERS[key];
  if (!handler) {
    await sendReply(chatId, "Unknown input prompt.");
    return;
  }
  const prompt =
    extra.prompt ||
    (typeof handler.prompt === "function"
      ? handler.prompt(extra)
      : handler.prompt);
  setPendingUiInput(chatId, {
    key,
    buildCommand: handler.buildCommand,
    ...extra,
  });
  const keyboard = buildKeyboard([
    [{ text: ":close: Cancel", callback_data: uiCallback("cancel") }],
  ]);
  await showStickyInteractiveMessage(chatId, `${prompt}\n\nSend /cancel to abort.`, {
    reply_markup: keyboard,
  });
}

async function promptActionConfirm(chatId, token, payload, options = {}) {
  const title = payload.title || "Confirm Action";
  const detailLines = Array.isArray(payload.detailLines)
    ? payload.detailLines.filter(Boolean)
    : [];
  const hint = payload.hint ? String(payload.hint) : "";
  const text = [
    `*${title}*`,
    detailLines.length ? "" : null,
    ...detailLines,
    hint ? "" : null,
    hint,
  ]
    .filter(Boolean)
    .join("\n");
  const confirmId = `cb:confirm_action:${token}`;
  const keyboard = buildActionConfirmKeyboard(
    confirmId,
    payload.confirmLabel || "Confirm",
    payload.backAction,
  );
  await showStickyInteractiveMessage(chatId, text, {
    parseMode: "Markdown",
    reply_markup: keyboard,
    ...options,
  });
}

async function handleUiInput(chatId, request, text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    if (isStickyMenuInteractive(chatId)) {
      await restoreStickyMenuMessage(chatId);
    }
    await sendReply(chatId, ":alert: Input was empty. Prompt cancelled.");
    return;
  }
  if (request.key === "starttask") {
    await showStartTaskExecutorPicker(chatId, trimmed);
    return;
  }
  if (request.key === "starttask_model") {
    const normalizedModel = normalizeStartTaskModelInput(trimmed);
    await promptStartTaskConfirm(chatId, {
      taskId: request.taskId,
      sdk: request.sdk,
      model: normalizedModel,
      executor: request.executor,
    });
    return;
  }
  const buildCommand = request.buildCommand;
  if (typeof buildCommand !== "function") {
    if (isStickyMenuInteractive(chatId)) {
      await restoreStickyMenuMessage(chatId);
    }
    await sendReply(chatId, ":alert: Unable to process that input.");
    return;
  }
  const command = buildCommand(trimmed, request);
  if (!command) {
    if (isStickyMenuInteractive(chatId)) {
      await restoreStickyMenuMessage(chatId);
    }
    await sendReply(chatId, ":alert: Could not build a command from that input.");
    return;
  }
  if (request.confirm) {
    const detailLines =
      typeof request.confirmDetails === "function"
        ? request.confirmDetails(trimmed, request, command)
        : [`Command: \`${shortSnippet(command, 120)}\``];
    const payload = {
      type: "confirm_cmd",
      command,
      title: request.confirmTitle || "Confirm Action",
      confirmLabel: request.confirmLabel || "Confirm",
      detailLines,
      backAction: request.confirmBackAction || null,
    };
    const token = issueUiToken(payload);
    await promptActionConfirm(chatId, token, payload);
    return;
  }
  if (isStickyMenuInteractive(chatId)) {
    await restoreStickyMenuMessage(chatId);
  }
  await dispatchUiCommand(chatId, command);
}

function normalizeStartTaskExecutor(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "auto") return "auto";
  if (["internal", "local", "agent", "pool"].includes(raw)) return "internal";
  return "";
}

function normalizeStartTaskModelInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const lowered = raw.toLowerCase();
  if (["default", "auto", "none"].includes(lowered)) return "";
  return raw;
}

function resolveStartTaskExecutorMode() {
  const raw =
    (_getExecutorMode?.() || process.env.EXECUTOR_MODE || "internal")
      .toString()
      .trim()
      .toLowerCase();
  if (["internal", "hybrid"].includes(raw)) return raw;
  return "internal";
}

function getStartTaskExecutorAvailability(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  return {
    internal: normalized === "internal" || normalized === "hybrid",
  };
}

function resolveStartTaskExecutor(requested, mode) {
  const normalized = normalizeStartTaskExecutor(requested);
  const availability = getStartTaskExecutorAvailability(mode);
  if (!normalized || normalized === "auto") {
    if (availability.internal) return "internal";
    return null;
  }
  if (normalized === "internal" && !availability.internal) return null;
  return normalized;
}

function buildStartTaskCommand(taskId, sdk, model, executor) {
  const parts = ["/starttask", taskId];
  if (executor) parts.push("--executor", executor);
  if (sdk) parts.push("--sdk", sdk);
  if (model) parts.push("--model", model);
  return parts.join(" ");
}

async function promptStartTaskConfirm(chatId, details = {}) {
  const taskId = String(details.taskId || "").trim();
  if (!taskId) {
    await sendReply(chatId, ":alert: Task ID missing for manual start.");
    return;
  }
  const executor = normalizeStartTaskExecutor(details.executor);
  const sdk = details.sdk ? String(details.sdk).trim() : "";
  const model = details.model ? String(details.model).trim() : "";
  const command = buildStartTaskCommand(taskId, sdk, model, executor);
  const token = issueUiToken({ type: "cmd", command });
  const executorLabel = executor || "auto";
  const sdkLabel = sdk || "auto";
  const modelLabel = model || "default";
  const lines = [
    ":rocket: *Confirm Manual Start*",
    "",
    "This will enqueue the task immediately.",
    "",
    `Task: \`${taskId}\``,
    `Executor: \`${executorLabel}\``,
    `SDK: \`${sdkLabel}\``,
    `Model: \`${modelLabel}\``,
  ];
  const keyboard = buildKeyboard([
    [
      uiButton(":check: Start", uiTokenAction(token)),
      uiButton(":close: Cancel", "cancel"),
    ],
  ]);
  await showStickyInteractiveMessage(chatId, lines.join("\n"), {
    parseMode: "Markdown",
    reply_markup: keyboard,
  });
}

async function showStartTaskExecutorPicker(chatId, taskId) {
  const safeId = String(taskId || "").trim();
  if (!safeId) {
    await sendReply(chatId, ":alert: Task ID missing.");
    return;
  }
  const mode = resolveStartTaskExecutorMode();
  const availability = getStartTaskExecutorAvailability(mode);
  const buttons = [];
  if (availability.internal) {
    buttons.push({
      label: ":star: Auto (recommended)",
      executor: "auto",
    });
    buttons.push({
      label: ":cpu: Internal (only)",
      executor: "internal",
    });
  }
  if (!buttons.length) {
    await sendReply(
      chatId,
      ":alert: No executors available. Check EXECUTOR_MODE configuration.",
    );
    return;
  }
  const rows = [
    ...chunkButtons(
      buttons.map((entry) =>
        uiButton(
          entry.label,
          uiTokenAction(
            issueUiToken({
              type: "starttask_executor",
              taskId: safeId,
              executor: entry.executor,
            }),
          ),
        ),
      ),
      2,
    ),
    [uiButton(":close: Cancel", "cancel")],
  ];
  const lines = [
    "Step 1/3 • Choose executor",
    "",
    `Task: \`${safeId}\``,
    `Mode: \`${mode}\``,
    availability.internal ? ":cpu: Internal executor available" : ":cpu: Internal executor unavailable",
    "",
    "Auto picks the internal executor.",
  ];
  await showStickyInteractiveMessage(chatId, lines.join("\n"), {
    parseMode: "Markdown",
    reply_markup: buildKeyboard(rows),
  });
}

async function showStartTaskSdkPicker(chatId, taskId, executor) {
  const safeId = String(taskId || "").trim();
  if (!safeId) {
    await sendReply(chatId, ":alert: Task ID missing.");
    return;
  }
  const safeExecutor = normalizeStartTaskExecutor(executor) || "internal";
  const availablePayload = await harnessApi.getProviderSelection().catch(() => ({ selection: {} }));
  const available = Array.isArray(availablePayload?.selection?.availableSdks)
    ? availablePayload.selection.availableSdks
    : [];
  const sdkList = available.length > 0 ? available : ["codex", "copilot", "claude"];
  const tokenAuto = issueUiToken({
    type: "starttask_confirm",
    taskId: safeId,
    executor: safeExecutor,
  });
  const tokens = sdkList.map((sdk) => ({
    sdk,
    token: issueUiToken({
      type: "starttask_sdk",
      taskId: safeId,
      sdk,
      executor: safeExecutor,
    }),
  }));
  const tokenBack = issueUiToken({
    type: "starttask_executor_list",
    taskId: safeId,
  });
  const lines = [
    "Step 2/3 • Choose SDK",
    "",
    `Task: \`${safeId}\``,
    `Executor: \`${safeExecutor}\``,
    "Auto uses the current pool SDK.",
  ];
  const rows = [
    [uiButton(":bot: Auto", uiTokenAction(tokenAuto))],
    ...chunkButtons(
      tokens.map((entry) => uiButton(entry.sdk, uiTokenAction(entry.token))),
      2,
    ),
    [uiButton(":arrowRight: Back", uiTokenAction(tokenBack))],
    [uiButton(":close: Cancel", "cancel")],
  ];
  const keyboard = buildKeyboard(rows);
  await showStickyInteractiveMessage(chatId, lines.join("\n"), {
    parseMode: "Markdown",
    reply_markup: keyboard,
  });
}

async function showStartTaskModelPicker(chatId, taskId, sdk, executor) {
  const safeId = String(taskId || "").trim();
  const safeSdk = String(sdk || "").trim();
  const safeExecutor = normalizeStartTaskExecutor(executor) || "internal";
  if (!safeId || !safeSdk) {
    await sendReply(chatId, ":alert: Missing task ID or SDK.");
    return;
  }
  const modelOptions = getDefaultModelPriority()
    .map((entry) => (typeof entry === "string" ? entry : entry?.model || entry?.name || null))
    .filter(Boolean);
  const tokenDefault = issueUiToken({
    type: "starttask_confirm",
    taskId: safeId,
    sdk: safeSdk,
    executor: safeExecutor,
  });
  const tokenCustom = issueUiToken({
    type: "input",
    key: "starttask_model",
    taskId: safeId,
    sdk: safeSdk,
    executor: safeExecutor,
    prompt: `Custom model for ${safeSdk}:`,
  });
  const tokenBack = issueUiToken({
    type: "starttask_sdk_list",
    taskId: safeId,
    executor: safeExecutor,
  });
  const lines = [
    "Step 3/3 • Choose model",
    "",
    `Task: \`${safeId}\``,
    `Executor: \`${safeExecutor}\``,
    `SDK: \`${safeSdk}\``,
    "Default uses the standard routing policy.",
  ];
  const rows = [[uiButton("Default Model", uiTokenAction(tokenDefault))]];
  if (modelOptions.length > 0) {
    rows.push(
      ...chunkButtons(
        modelOptions.slice(0, 6).map((model) =>
          uiButton(
            shortenLabel(model),
            uiTokenAction(
              issueUiToken({
                type: "starttask_confirm",
                taskId: safeId,
                sdk: safeSdk,
                executor: safeExecutor,
                model,
              }),
            ),
          ),
        ),
        2,
      ),
    );
  }
  rows.push([uiButton("Custom Model", uiTokenAction(tokenCustom))]);
  rows.push([uiButton(":arrowRight: Back", uiTokenAction(tokenBack))]);
  const keyboard = buildKeyboard(rows);
  await showStickyInteractiveMessage(chatId, lines.join("\n"), {
    parseMode: "Markdown",
    reply_markup: keyboard,
  });
}

function uiNavRow(parent) {
  if (!parent) {
    return [
      uiButton(":home: Home", uiGoAction("home")),
      uiButton(":close: Close", "cb:close_menu"),
    ];
  }
  return [
    uiButton(":arrowRight: Back", uiGoAction(parent)),
    uiButton(":home: Home", uiGoAction("home")),
    uiButton(":close: Close", "cb:close_menu"),
  ];
}

function parsePageParam(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

const TASK_LIST_PAGE_SIZE = 6;
const TASK_LIST_LABELS = {
  backlog: "Backlog",
  draft: "Draft",
  todo: "Todo",
  inprogress: "Active",
  inreview: "Review",
  blocked: "Blocked",
  done: "Done",
};

function normalizeTaskListStatus(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "all") return "";
  if (["backlog"].includes(raw)) return "todo";
  if (["active", "running", "in-progress", "in_progress"].includes(raw)) return "inprogress";
  if (["review", "in-review", "in_review"].includes(raw)) return "inreview";
  if (["done", "completed", "complete"].includes(raw)) return "done";
  if (["blocked", "stuck"].includes(raw)) return "blocked";
  if (["draft"].includes(raw)) return "draft";
  if (["todo", "to-do"].includes(raw)) return "todo";
  return raw;
}

function taskStatusLabel(status) {
  const raw = String(status || "").trim().toLowerCase();
  if (TASK_LIST_LABELS[raw]) return TASK_LIST_LABELS[raw];
  const normalized = normalizeTaskListStatus(status) || "todo";
  return TASK_LIST_LABELS[normalized] || normalized;
}

async function resolveKanbanProjectId(adapter) {
  try {
    const projects = await adapter.listProjects();
    const primary = projects[0];
    return primary?.id || primary?.project_id || "";
  } catch {
    return "";
  }
}

function formatTaskLine(task, index) {
  const id = task?.id || "(no-id)";
  const title = task?.title || task?.summary || "Untitled";
  const status = taskStatusLabel(task?.status || task?.state || "");
  const priority = task?.priority ? ` • ${task.priority}` : "";
  return `${index + 1}. ${shortenLabel(title, 48)}\n   ${id} • ${status}${priority}`;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  return formatRuntimeSeconds(Math.floor(ms / 1000));
}

async function buildHomeStatusLine() {
  const data = await readStatusSnapshot();
  if (!data) return "Status: :close: unavailable";
  const counts = data.counts || {};
  const backlog = data.backlog_remaining ?? "?";
  const running = counts.running ?? 0;
  const review = counts.review ?? 0;
  const error = counts.error ?? 0;
  return `:play: Running ${running} • :eye: Review ${review} • :alert: Error ${error} • :download: Backlog ${backlog}`;
}

async function listWorktreeNames() {
  const worktreeDir = resolve(repoRoot, ".cache", "worktrees");
  let names = [];
  try {
    names = await readdir(worktreeDir);
  } catch {
    return [];
  }
  const entries = await Promise.all(
    names.map(async (name) => {
      const stats = await stat(resolve(worktreeDir, name)).catch(() => null);
      return { name, mtime: stats?.mtimeMs || 0 };
    }),
  );
  return entries.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.name);
}

async function listThreadEntries() {
  try {
    const payload = await harnessApi.listThreads();
    const threads = Array.isArray(payload?.items) ? payload.items : [];
    return threads
      .map((t) => ({
        taskKey: t.taskKey,
        sdk: t.sdk,
        turnCount: t.turnCount,
        ageMs: t.age,
        threadId: t.threadId,
      }))
      .filter((entry) => entry.taskKey);
  } catch {
    return [];
  }
}

async function listWorktreeEntries() {
  try {
    const worktrees = await listManagedWorktrees(repoRoot);
    return worktrees
      .map((wt) => ({
        taskKey: wt.taskKey,
        branch: wt.branch,
        status: wt.status,
        ageMs: wt.age,
        owner: wt.owner,
        path: wt.path,
      }))
      .filter((entry) => entry.taskKey);
  } catch {
    return [];
  }
}

async function listSharedWorkspaceEntries() {
  try {
    const registry = await loadSharedRegistry();
    const sweep = await sweepSharedLeases({
      registry,
      actor: "telegram:ui",
    });
    return sweep.registry?.workspaces || [];
  } catch {
    return [];
  }
}

function buildSharedWorkspaceDetailLines(workspace) {
  if (!workspace) return [];
  const lines = [
    `Workspace: \`${workspace.id}\``,
    workspace.name && workspace.name !== workspace.id
      ? `Name: ${workspace.name}`
      : null,
    workspace.region ? `Region: ${workspace.region}` : null,
    workspace.provider ? `Provider: ${workspace.provider}` : null,
    `Status: ${workspace.availability}`,
  ];
  const lease = workspace.lease;
  if (lease) {
    lines.push(`Lease Owner: ${lease.owner || "unknown"}`);
    if (lease.claimed_at) {
      const claimedAt = Date.parse(lease.claimed_at);
      lines.push(`Claimed: ${formatAgeFromTimestamp(claimedAt)}`);
    }
    if (lease.lease_expires_at) {
      const expiresAt = Date.parse(lease.lease_expires_at);
      lines.push(`Expires In: ${formatTimeUntil(expiresAt)}`);
    }
    if (lease.notes) {
      lines.push(`Notes: ${shortSnippet(String(lease.notes), 120)}`);
    }
  }
  return lines.filter(Boolean);
}

async function listWorkspaceRegistryEntries() {
  try {
    const { registry } = await loadWorkspaceRegistry();
    return registry?.workspaces || [];
  } catch {
    return [];
  }
}

const UI_SCREENS = {};

Object.assign(UI_SCREENS, {
  home: {
    title: "Bosun Control Center",
    parent: null,
    body: async () => {
      const statusLine = await buildHomeStatusLine();
      const executor = _getInternalExecutor?.();
      let executorLine = "";
      if (executor) {
        const status = executor.getStatus();
        const paused = executor.isPaused?.() ? ":pause: paused" : ":play: running";
        executorLine = `:settings: Executor: ${paused} • :sliders: Slots ${status.activeSlots}/${status.maxParallel}`;
      } else {
        executorLine = `:settings: Executor: ${_getExecutorMode?.() || "internal"}`;
      }
      return [
        "Pick a section below to manage Bosun.",
        "",
        statusLine,
        executorLine,
      ].join("\n");
    },
    keyboard: () => {
      syncUiUrlsFromServer();
      const rows = [
        // Core Operations
        [
          uiButton(":chart: Dashboard", uiGoAction("overview")),
          uiButton(":compass: Tasks", uiGoAction("tasks")),
          uiButton(":bot: Agents", uiGoAction("agents")),
        ],
        // System & Config
        [
          uiButton(":git: Workspaces", uiGoAction("workspaces")),
          uiButton(":settings: Executor", uiGoAction("executor")),
          uiButton(":server: Routing", uiGoAction("routing")),
        ],
        // Monitoring & Tools
        [
          uiButton(":folder: Logs & Git", uiGoAction("logs")),
          uiButton(":chart: Telemetry", uiGoAction("telemetry")),
          uiButton(":cpu: Session", uiGoAction("session")),
        ],
        // Quick Actions
        [
          uiButton(":chat: Ask Agent", uiInputAction("ask")),
          uiButton(":file: All Commands", uiCmdAction("/helpfull")),
        ],
      ];
      if (telegramWebAppUrl) {
        rows.unshift([
          {
            text: ":phone: Open Control Center",
            web_app: { url: telegramWebAppUrl },
          },
          uiButton(":close:", "cb:close_menu"),
        ]);
        if (getBrowserUiUrlOptions().length > 0) {
          rows.unshift([uiButton(":globe: Open in Browser", uiGoAction("browser_urls"))]);
        }
      } else if (telegramUiUrl) {
        rows.unshift([
          uiButton(":globe: Open in Browser", uiGoAction("browser_urls")),
          uiButton(":close:", "cb:close_menu"),
        ]);
      } else {
        rows.unshift([uiButton(":close: Close Menu", "cb:close_menu")]);
      }
      return buildKeyboard(rows);
    },
  },
  browser_urls: {
    title: "Browser URLs",
    parent: "home",
    body: () => {
      const options = getBrowserUiUrlOptions();
      if (options.length === 0) {
        return "Mini App URL is not available yet.";
      }
      const lines = ["Choose a browser URL. Session token is pre-attached."];
      for (const option of options) {
        lines.push(`• ${option.label}`);
      }
      return lines.join("\n");
    },
    keyboard: () => {
      const options = getBrowserUiUrlOptions();
      const rows = options.map((option) => [{ text: option.label, url: option.url }]);
      rows.push(uiNavRow("home"));
      return buildKeyboard(rows);
    },
  },
  overview: {
    title: "Dashboard",
    parent: "home",
    body: () => "Live status, health, and presence dashboards.",
    keyboard: () =>
      buildKeyboard([
        // Core Status
        [
          uiButton(":chart: Status", uiCmdAction("/status")),
          uiButton(":clipboard: Tasks", uiCmdAction("/tasks")),
          uiButton(":bot: Agents", uiCmdAction("/agents")),
        ],
        // System Health
        [
          uiButton(":heart: Health", uiCmdAction("/health")),
          uiButton(":alert: Anomalies", uiCmdAction("/anomalies")),
          uiButton(":eye: Presence", uiCmdAction("/presence")),
        ],
        // Deep Dives
        [
          uiButton(":target: Coordinator", uiCmdAction("/coordinator")),
          uiButton(":edit: Logs", uiCmdAction("/logs 50")),
        ],
        [
          uiButton(":chart: Telemetry", uiGoAction("telemetry")),
        ],
        uiNavRow("home"),
      ]),
  },
  telemetry: {
    title: "Telemetry",
    parent: "home",
    body: () =>
      "Analytics and quality signals from recent agent runs.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton(":chart: Summary", uiCmdAction("/telemetry")),
          uiButton(":alert: Errors", uiCmdAction("/telemetry errors")),
        ],
        [
          uiButton(":beaker: Executors", uiCmdAction("/telemetry executors")),
          uiButton(":alert: Alerts", uiCmdAction("/telemetry alerts")),
        ],
        uiNavRow("home"),
      ]),
  },
  tasks: {
    title: "Task Operations",
    parent: "home",
    body: () =>
      "Manage task execution, planning, and cleanup.",
    keyboard: () =>
      buildKeyboard([
        // Execution Controls
        [
          { text: ":pause: Pause", callback_data: "cb:confirm_pause" },
          { text: ":play: Resume", callback_data: "cb:confirm_resume" },
          { text: ":refresh: Restart", callback_data: "cb:confirm_restart" },
        ],
        // Viewing & Starting
        [
          uiButton(":clipboard: Active Tasks", uiCmdAction("/tasks")),
          uiButton(":folder: Task Lists", uiGoAction("task_lists")),
          uiButton(":play: Start Task", uiInputAction("starttask")),
        ],
        // Management
        [
          uiButton(":grid: Workflows", uiGoAction("plan")),
          uiButton(":repeat: Retry", uiGoAction("retry")),
          uiButton(":trash: Cleanup", uiCmdAction("/cleanup")),
        ],
        uiNavRow("home"),
      ]),
  },
  task_lists: {
    title: "Task Lists",
    parent: "tasks",
    body: () =>
      `Browse kanban tasks by status.\nBackend: ${getKanbanBackendName() || "unknown"}`,
    keyboard: () => {
      const rows = [
        [
          uiButton(
            ":download: Backlog",
            uiTokenAction(
              issueUiToken({
                type: "go",
                screenId: "task_list",
                params: { status: "backlog", page: 0 },
              }),
            ),
          ),
          uiButton(
            ":edit: Draft",
            uiTokenAction(
              issueUiToken({
                type: "go",
                screenId: "task_list",
                params: { status: "draft", page: 0 },
              }),
            ),
          ),
        ],
        [
          uiButton(
            ":check: Todo",
            uiTokenAction(
              issueUiToken({
                type: "go",
                screenId: "task_list",
                params: { status: "todo", page: 0 },
              }),
            ),
          ),
          uiButton(
            ":alert: Active",
            uiTokenAction(
              issueUiToken({
                type: "go",
                screenId: "task_list",
                params: { status: "inprogress", page: 0 },
              }),
            ),
          ),
        ],
        [
          uiButton(
            ":search: Review",
            uiTokenAction(
              issueUiToken({
                type: "go",
                screenId: "task_list",
                params: { status: "inreview", page: 0 },
              }),
            ),
          ),
          uiButton(
            ":ban: Blocked",
            uiTokenAction(
              issueUiToken({
                type: "go",
                screenId: "task_list",
                params: { status: "blocked", page: 0 },
              }),
            ),
          ),
        ],
        [
          uiButton(
            ":flag: Done",
            uiTokenAction(
              issueUiToken({
                type: "go",
                screenId: "task_list",
                params: { status: "done", page: 0 },
              }),
            ),
          ),
        ],
        uiNavRow("tasks"),
      ];
      return buildKeyboard(rows);
    },
  },
  task_list: {
    title: "Tasks",
    parent: "task_lists",
    body: async (ctx) => {
      const status = ctx.params?.status || "todo";
      const page = parsePageParam(ctx.params?.page);
      const adapter = getKanbanAdapter();
      const projectId = await resolveKanbanProjectId(adapter);
      if (!projectId) {
        return "No kanban project available.";
      }
      const normalizedStatus = normalizeTaskListStatus(status);
      const tasks = await adapter.listTasks(
        projectId,
        normalizedStatus ? { status: normalizedStatus } : {},
      );
      if (!tasks || tasks.length === 0) {
        return `No tasks found for ${taskStatusLabel(status)}.`;
      }
      const total = tasks.length;
      const start = page * TASK_LIST_PAGE_SIZE;
      const slice = tasks.slice(start, start + TASK_LIST_PAGE_SIZE);
      const lines = [
        `${taskStatusLabel(status)} Tasks · ${total} total`,
        "",
        ...slice.map((task, idx) => formatTaskLine(task, start + idx)),
      ];
      return lines.join("\n");
    },
    keyboard: async (ctx) => {
      const status = ctx.params?.status || "todo";
      const page = parsePageParam(ctx.params?.page);
      const adapter = getKanbanAdapter();
      const projectId = await resolveKanbanProjectId(adapter);
      if (!projectId) {
        return buildKeyboard([uiNavRow("task_lists")]);
      }
      const normalizedStatus = normalizeTaskListStatus(status);
      const tasks = await adapter.listTasks(
        projectId,
        normalizedStatus ? { status: normalizedStatus } : {},
      );
      const total = tasks.length;
      const totalPages = Math.max(1, Math.ceil(total / TASK_LIST_PAGE_SIZE));
      const safePage = Math.min(page, totalPages - 1);
      const slice = tasks.slice(
        safePage * TASK_LIST_PAGE_SIZE,
        safePage * TASK_LIST_PAGE_SIZE + TASK_LIST_PAGE_SIZE,
      );
      const rows = [];
      const startable = slice.filter((task) => task?.id);
      if (startable.length > 0) {
        rows.push(
          ...startable.map((task) => {
            const token = issueUiToken({
              type: "starttask_executor",
              taskId: task.id,
            });
            const label = `:play: ${shortenLabel(task.id || task.title || "Task", 28)}`;
            return [uiButton(label, uiTokenAction(token))];
          }),
        );
      }
      if (totalPages > 1) {
        const pager = [];
        if (safePage > 0) {
          pager.push(
            uiButton(
              ":arrowRight: Prev",
              uiTokenAction(
                issueUiToken({
                  type: "go",
                  screenId: "task_list",
                  params: { status, page: safePage - 1 },
                }),
              ),
            ),
          );
        }
        if (safePage < totalPages - 1) {
          pager.push(
            uiButton(
              "Next :arrowRight:",
              uiTokenAction(
                issueUiToken({
                  type: "go",
                  screenId: "task_list",
                  params: { status, page: safePage + 1 },
                }),
              ),
            ),
          );
        }
        if (pager.length) rows.push(pager);
      }
      rows.push(
        [
          uiButton(":repeat: Change Status", uiGoAction("task_lists")),
          uiButton(":play: Start Task", uiInputAction("starttask")),
        ],
      );
      rows.push(uiNavRow("task_lists"));
      return buildKeyboard(rows);
    },
  },
  plan: {
    title: "Task Planner",
    parent: "tasks",
    body: () => "Run planner workflow now.\nUse /plan [count] [focus] (example: /plan 5 stabilize API retries).",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("Run Planner", uiCmdAction("/plan")),
          uiButton("Set Count", uiInputAction("plan_count")),
        ],
        uiNavRow("tasks"),
      ]),
  },
  retry: {
    title: "Fresh Retry",
    parent: "tasks",
    body: () => "Start a fresh session retry for the active task.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("Manual", uiCmdAction("/retry manual_ui")),
          uiButton("Stuck", uiCmdAction("/retry stuck")),
          uiButton("Rate Limit", uiCmdAction("/retry rate_limit")),
        ],
        [uiButton("Custom Reason", uiInputAction("retry_reason"))],
        uiNavRow("tasks"),
      ]),
  },
  executor: {
    title: "Executor",
    parent: "home",
    body: () => "Executor status, slots, and tuning.",
    keyboard: () =>
      buildKeyboard([
        // Status
        [
          uiButton(":chart: Status", uiCmdAction("/executor")),
          uiButton(":sliders: Slots", uiCmdAction("/executor slots")),
          uiButton(":settings: Mode", uiCmdAction("/executor mode")),
        ],
        // Controls
        [
          uiButton(":pause: Pause", uiCmdAction("/pausetasks")),
          uiButton(":play: Resume", uiCmdAction("/resumetasks")),
          uiButton(":hash: Max Parallel", uiGoAction("maxparallel")),
        ],
        uiNavRow("home"),
      ]),
  },
  maxparallel: {
    title: "Max Parallel",
    parent: "executor",
    body: () => "Set the max concurrent task slots.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("0 (Pause)", uiCmdAction("/maxparallel 0")),
          uiButton("1", uiCmdAction("/maxparallel 1")),
          uiButton("2", uiCmdAction("/maxparallel 2")),
        ],
        [
          uiButton("3", uiCmdAction("/maxparallel 3")),
          uiButton("4", uiCmdAction("/maxparallel 4")),
          uiButton("6", uiCmdAction("/maxparallel 6")),
        ],
        [
          uiButton("8", uiCmdAction("/maxparallel 8")),
          uiButton("12", uiCmdAction("/maxparallel 12")),
          uiButton("16", uiCmdAction("/maxparallel 16")),
        ],
        [uiButton("Custom", uiInputAction("maxparallel"))],
        uiNavRow("executor"),
      ]),
  },
  agents: {
    title: "Agents",
    parent: "home",
    body: () => "Monitor and steer running agents.",
    keyboard: () =>
      buildKeyboard([
        // Monitoring
        [
          uiButton(":bot: Active Agents", uiCmdAction("/agents")),
          uiButton(":folder: Agent Logs", uiGoAction("agent_logs")),
          uiButton(":link: Threads", uiGoAction("threads")),
        ],
        // Control
        [
          uiButton(":compass: Steer", uiInputAction("steer")),
          uiButton(":close: Stop", uiCmdAction("/stop")),
          uiButton(":server: Background", uiGoAction("background")),
        ],
        // Context
        [
          uiButton(":cpu: History", uiCmdAction("/history")),
          uiButton(":chart: Status", uiCmdAction("/status")),
        ],
        uiNavRow("home"),
      ]),
  },
  background: {
    title: "Background Mode",
    parent: "agents",
    body: () => "Run tasks silently or background the active agent.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("Background Active", uiCmdAction("/background")),
          uiButton("New Background Task", uiInputAction("background")),
        ],
        [
          uiButton(":compass: Steer", uiInputAction("steer")),
          uiButton(":close: Stop", uiCmdAction("/stop")),
        ],
        uiNavRow("agents"),
      ]),
  },
  threads: {
    title: "Threads",
    parent: "agents",
    body: () => "Manage persistent agent threads.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("List Threads", uiCmdAction("/threads")),
          uiButton("Clear Registry", uiCmdAction("/threads clear")),
        ],
        [uiButton("Kill Thread", uiGoAction("threads_kill"))],
        uiNavRow("agents"),
      ]),
  },
});

Object.assign(UI_SCREENS, {
  agent_logs: {
    title: "Agent Logs",
    parent: "agents",
    body: () => "Pick a worktree to view logs, or search by branch fragment.",
    keyboard: async (ctx) => {
      const page = parsePageParam(ctx.params?.page);
      const names = await listWorktreeNames();
      if (names.length === 0) {
        return buildKeyboard([
          [uiButton("Search", uiInputAction("agentlogs"))],
          uiNavRow("agents"),
        ]);
      }
      const perPage = 8;
      const totalPages = Math.max(1, Math.ceil(names.length / perPage));
      const safePage = Math.min(page, totalPages - 1);
      const start = safePage * perPage;
      const slice = names.slice(start, start + perPage);
      const rows = chunkButtons(
        slice.map((name) => {
          const token = issueUiToken({
            type: "cmd",
            command: `/agentlogs ${name}`,
          });
          return uiButton(shortenLabel(name), uiTokenAction(token));
        }),
        2,
      );
      if (totalPages > 1) {
        const pager = [];
        if (safePage > 0) {
          pager.push(
            uiButton(":arrowRight: Prev", uiGoAction("agent_logs", safePage - 1)),
          );
        }
        if (safePage < totalPages - 1) {
          pager.push(
            uiButton("Next :arrowRight:", uiGoAction("agent_logs", safePage + 1)),
          );
        }
        if (pager.length) rows.push(pager);
      }
      rows.push([uiButton("Search", uiInputAction("agentlogs"))]);
      rows.push(uiNavRow("agents"));
      return buildKeyboard(rows);
    },
  },
  threads_kill: {
    title: "Kill Thread",
    parent: "threads",
    body: () => "Select a thread to review details and confirm invalidation.",
    keyboard: async (ctx) => {
      const page = parsePageParam(ctx.params?.page);
      const threads = await listThreadEntries();
      if (threads.length === 0) {
        return buildKeyboard([
          [uiButton("Custom Task Key", uiInputAction("threads_kill"))],
          uiNavRow("threads"),
        ]);
      }
      const perPage = 8;
      const totalPages = Math.max(1, Math.ceil(threads.length / perPage));
      const safePage = Math.min(page, totalPages - 1);
      const slice = threads.slice(
        safePage * perPage,
        safePage * perPage + perPage,
      );
      const rows = chunkButtons(
        slice.map((entry) => {
          const age = formatDurationMs(entry.ageMs);
          const detailLines = [
            `Task Key: \`${entry.taskKey}\``,
            entry.sdk ? `SDK: \`${entry.sdk}\`` : null,
            Number.isFinite(entry.turnCount) ? `Turns: ${entry.turnCount}` : null,
            entry.threadId
              ? `Thread: \`${entry.threadId.slice(0, 12)}…\``
              : null,
            `Age: ${age}`,
          ];
          const token = issueUiToken({
            type: "confirm_cmd",
            command: `/threads kill ${entry.taskKey}`,
            title: "Invalidate Thread",
            confirmLabel: "Invalidate",
            detailLines,
            backAction: uiGoAction("threads_kill", safePage),
          });
          return uiButton(shortenLabel(entry.taskKey), uiTokenAction(token));
        }),
        2,
      );
      if (totalPages > 1) {
        const pager = [];
        if (safePage > 0) {
          pager.push(
            uiButton(":arrowRight: Prev", uiGoAction("threads_kill", safePage - 1)),
          );
        }
        if (safePage < totalPages - 1) {
          pager.push(
            uiButton("Next :arrowRight:", uiGoAction("threads_kill", safePage + 1)),
          );
        }
        if (pager.length) rows.push(pager);
      }
      rows.push([uiButton("Custom Task Key", uiInputAction("threads_kill"))]);
      rows.push(uiNavRow("threads"));
      return buildKeyboard(rows);
    },
  },
});

Object.assign(UI_SCREENS, {
  routing: {
    title: "Routing & Models",
    parent: "home",
    body: () => "Control model routing, SDKs, and workspace routing.",
    keyboard: () =>
      buildKeyboard([
        // Core Routing
        [
          uiButton(":bot: Model", uiGoAction("model")),
          uiButton(":box: SDK", uiGoAction("sdk")),
          uiButton(":globe: Region", uiGoAction("region")),
        ],
        // Task Routing
        [
          uiButton(":target: Route Task", uiGoAction("route_task")),
          uiButton(":clipboard: Kanban", uiGoAction("kanban")),
          uiButton(":repeat: Auto Backlog", uiGoAction("autobacklog")),
        ],
        // Config
        [
          uiButton(":ruler: Requirements", uiGoAction("requirements")),
          uiButton(":heart: Health", uiCmdAction("/health")),
        ],
        uiNavRow("home"),
      ]),
  },
  model: {
    title: "Model Override",
    parent: "routing",
    body: () => "Override the executor model for the next few tasks.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("gpt-5.2-codex", uiCmdAction("/model gpt-5.2-codex")),
          uiButton("gpt-5.1-max", uiCmdAction("/model gpt-5.1-codex-max")),
        ],
        [
          uiButton("gpt-5.1-mini", uiCmdAction("/model gpt-5.1-codex-mini")),
          uiButton("claude-opus-4.6", uiCmdAction("/model claude-opus-4.6")),
        ],
        [
          uiButton("claude-code", uiCmdAction("/model claude-code")),
          uiButton("Auto", uiCmdAction("/model auto")),
        ],
        uiNavRow("routing"),
      ]),
  },
  sdk: {
    title: "Agent SDK",
    parent: "routing",
    body: () => "Switch the agent pool SDK.",
    keyboard: () => {
      const available = ["codex", "copilot", "claude"];
      const rows = [];
      const buttons = ["codex", "copilot", "claude"].map((sdk) =>
        uiButton(sdk, uiCmdAction(`/sdk ${sdk}`)),
      );
      rows.push(...chunkButtons(buttons, 2));
      rows.push([uiButton("Auto", uiCmdAction("/sdk auto"))]);
      if (available.length > 0) {
        rows.unshift([
          uiButton(`Available: ${available.join(", ")}`, uiCmdAction("/sdk")),
        ]);
      }
      rows.push(uiNavRow("routing"));
      return buildKeyboard(rows);
    },
  },
  kanban: {
    title: "Kanban Backend",
    parent: "routing",
    body: () => "Switch the Kanban backend.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("Internal", uiCmdAction("/kanban internal")),
          uiButton("GitHub", uiCmdAction("/kanban github")),
        ],
        [uiButton("Jira", uiCmdAction("/kanban jira"))],
        [uiButton("Status", uiCmdAction("/kanban"))],
        uiNavRow("routing"),
      ]),
  },
  autobacklog: {
    title: "Auto Backlog",
    parent: "routing",
    body: () => "Experimental autonomous backlog replenishment controls.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("Enable", uiCmdAction("/autobacklog on")),
          uiButton("Disable", uiCmdAction("/autobacklog off")),
          uiButton("Status", uiCmdAction("/autobacklog")),
        ],
        [
          uiButton("Min 1", uiCmdAction("/autobacklog min 1")),
          uiButton("Min 2", uiCmdAction("/autobacklog min 2")),
        ],
        [
          uiButton("Max 1", uiCmdAction("/autobacklog max 1")),
          uiButton("Max 2", uiCmdAction("/autobacklog max 2")),
          uiButton("Max 3", uiCmdAction("/autobacklog max 3")),
        ],
        uiNavRow("routing"),
      ]),
  },
  requirements: {
    title: "Requirements Profile",
    parent: "routing",
    body: () => "Tune project-scope requirements for planning and backlog quality.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("Simple", uiCmdAction("/requirements simple-feature")),
          uiButton("Feature", uiCmdAction("/requirements feature")),
          uiButton("Large", uiCmdAction("/requirements large-feature")),
        ],
        [
          uiButton("System", uiCmdAction("/requirements system")),
          uiButton("Multi-System", uiCmdAction("/requirements multi-system")),
        ],
        [uiButton("Status", uiCmdAction("/requirements"))],
        uiNavRow("routing"),
      ]),
  },
  region: {
    title: "Codex Region",
    parent: "routing",
    body: () => "Switch Codex region routing.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("US", uiCmdAction("/region us")),
          uiButton("Sweden", uiCmdAction("/region sweden")),
          uiButton("Auto", uiCmdAction("/region auto")),
        ],
        [uiButton("Status", uiCmdAction("/region"))],
        uiNavRow("routing"),
      ]),
  },
  route_task: {
    title: "Route Task",
    parent: "routing",
    body: () => "Send tasks to a specific workspace or role.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("By Workspace", uiGoAction("route_workspace")),
          uiButton("By Role", uiGoAction("route_role")),
        ],
        [uiButton("Custom /agent", uiInputAction("agent_custom"))],
        uiNavRow("routing"),
      ]),
  },
  route_workspace: {
    title: "Route by Workspace",
    parent: "route_task",
    body: () => "Select a workspace to send a task.",
    keyboard: async (ctx) => {
      const page = parsePageParam(ctx.params?.page);
      const workspaces = await listWorkspaceRegistryEntries();
      if (!workspaces.length) {
        return buildKeyboard([
          [uiButton("Custom /agent", uiInputAction("agent_custom"))],
          uiNavRow("route_task"),
        ]);
      }
      const perPage = 8;
      const totalPages = Math.max(1, Math.ceil(workspaces.length / perPage));
      const safePage = Math.min(page, totalPages - 1);
      const slice = workspaces.slice(
        safePage * perPage,
        safePage * perPage + perPage,
      );
      const rows = chunkButtons(
        slice.map((ws) => {
          const token = issueUiToken({
            type: "input",
            key: "agent_workspace_task",
            workspaceId: ws.id,
            commandPrefix: `/agent --workspace ${ws.id} `,
            prompt: `Task for workspace ${ws.id}:`,
          });
          const label = `${shortenLabel(ws.id)}${
            ws.role ? ` (${ws.role})` : ""
          }`;
          return uiButton(label, uiTokenAction(token));
        }),
        1,
      );
      if (totalPages > 1) {
        const pager = [];
        if (safePage > 0) {
          pager.push(
            uiButton(":arrowRight: Prev", uiGoAction("route_workspace", safePage - 1)),
          );
        }
        if (safePage < totalPages - 1) {
          pager.push(
            uiButton("Next :arrowRight:", uiGoAction("route_workspace", safePage + 1)),
          );
        }
        if (pager.length) rows.push(pager);
      }
      rows.push([uiButton("Custom /agent", uiInputAction("agent_custom"))]);
      rows.push(uiNavRow("route_task"));
      return buildKeyboard(rows);
    },
  },
  route_role: {
    title: "Route by Role",
    parent: "route_task",
    body: () => "Select a role to route tasks.",
    keyboard: async (ctx) => {
      const page = parsePageParam(ctx.params?.page);
      const workspaces = await listWorkspaceRegistryEntries();
      const roles = Array.from(
        new Set(workspaces.map((ws) => ws.role).filter(Boolean)),
      );
      if (!roles.length) {
        return buildKeyboard([
          [uiButton("Custom /agent", uiInputAction("agent_custom"))],
          uiNavRow("route_task"),
        ]);
      }
      const perPage = 8;
      const totalPages = Math.max(1, Math.ceil(roles.length / perPage));
      const safePage = Math.min(page, totalPages - 1);
      const slice = roles.slice(
        safePage * perPage,
        safePage * perPage + perPage,
      );
      const rows = chunkButtons(
        slice.map((role) => {
          const token = issueUiToken({
            type: "input",
            key: "agent_role_task",
            role,
            commandPrefix: `/agent --role ${role} `,
            prompt: `Task for role ${role}:`,
          });
          return uiButton(shortenLabel(role, 28), uiTokenAction(token));
        }),
        2,
      );
      if (totalPages > 1) {
        const pager = [];
        if (safePage > 0) {
          pager.push(
            uiButton(":arrowRight: Prev", uiGoAction("route_role", safePage - 1)),
          );
        }
        if (safePage < totalPages - 1) {
          pager.push(
            uiButton("Next :arrowRight:", uiGoAction("route_role", safePage + 1)),
          );
        }
        if (pager.length) rows.push(pager);
      }
      rows.push([uiButton("Custom /agent", uiInputAction("agent_custom"))]);
      rows.push(uiNavRow("route_task"));
      return buildKeyboard(rows);
    },
  },
});

Object.assign(UI_SCREENS, {
  workspaces: {
    title: "Workspaces",
    parent: "home",
    body: () => "Manage workspaces, repos, worktrees, and shared environments.",
    keyboard: () =>
      buildKeyboard([
        // Workspaces
        [
          uiButton(":folder: My Workspaces", uiGoAction("managed_workspaces")),
          uiButton(":plus: New Workspace", uiInputAction("workspace_create")),
          uiButton(":target: Switch Active", uiGoAction("workspace_switch")),
        ],
        // Worktrees
        [
          uiButton(":git: Worktrees", uiCmdAction("/worktrees")),
          uiButton(":chart: Stats", uiCmdAction("/worktrees stats")),
          uiButton(":trash: Prune", uiCmdAction("/worktrees prune")),
        ],
        // Repos & Shared
        [
          uiButton(":folder: Repos", uiCmdAction("/repos")),
          uiButton(":unlock: Release WT", uiGoAction("worktrees_release")),
          uiButton(":refresh: Scan Disk", uiCmdAction("/workspace scan")),
        ],
        // Shared
        [
          uiButton(":clipboard: Shared", uiCmdAction("/shared_workspaces")),
          uiButton(":check: Claim", uiGoAction("shared_claim")),
          uiButton(":close: Release", uiGoAction("shared_release")),
        ],
        uiNavRow("home"),
      ]),
  },
  workspace_switch: {
    title: "Switch Workspace",
    parent: "workspaces",
    body: () => "Choose a local workspace to set active for task routing.",
    keyboard: async (ctx) => {
      const page = parsePageParam(ctx.params?.page);
      const configDir = resolveTelegramConfigDir();
      const workspaces = listLocalWorkspaces(configDir);
      const active = getActiveLocalWorkspace(configDir);
      if (!workspaces.length) {
        return buildKeyboard([
          [uiButton(":refresh: Scan", uiCmdAction("/workspace scan"))],
          [uiButton("Type Workspace ID", uiInputAction("workspace_switch"))],
          uiNavRow("workspaces"),
        ]);
      }

      const perPage = 8;
      const totalPages = Math.max(1, Math.ceil(workspaces.length / perPage));
      const safePage = Math.min(page, totalPages - 1);
      const slice = workspaces.slice(
        safePage * perPage,
        safePage * perPage + perPage,
      );

      const rows = chunkButtons(
        slice.map((workspace) => {
          const isActive = workspace.id === active?.id;
          const repoCount = Array.isArray(workspace.repos)
            ? workspace.repos.length
            : 0;
          const token = issueUiToken({
            type: "confirm_cmd",
            command: `/workspace switch ${workspace.id}`,
            title: "Switch Local Workspace",
            confirmLabel: "Switch",
            detailLines: [
              `Workspace: \`${workspace.name || workspace.id}\``,
              `ID: \`${workspace.id}\``,
              `Repos: ${repoCount}`,
              isActive ? "Status: already active" : "Status: inactive",
            ],
            backAction: uiGoAction("workspace_switch", safePage),
          });
          const prefix = isActive ? ":dot:" : ":dot:";
          return uiButton(
            `${prefix} ${shortenLabel(workspace.name || workspace.id)}`,
            uiTokenAction(token),
          );
        }),
        2,
      );

      if (totalPages > 1) {
        const pager = [];
        if (safePage > 0) {
          pager.push(
            uiButton(":arrowRight: Prev", uiGoAction("workspace_switch", safePage - 1)),
          );
        }
        if (safePage < totalPages - 1) {
          pager.push(
            uiButton("Next :arrowRight:", uiGoAction("workspace_switch", safePage + 1)),
          );
        }
        if (pager.length) rows.push(pager);
      }

      rows.push([
        uiButton("Type Workspace ID", uiInputAction("workspace_switch")),
      ]);
      rows.push([uiButton(":refresh: Scan", uiCmdAction("/workspace scan"))]);
      rows.push(uiNavRow("workspaces"));
      return buildKeyboard(rows);
    },
  },
  worktrees_release: {
    title: "Release Worktree",
    parent: "workspaces",
    body: () => "Select a task key to review details and confirm release.",
    keyboard: async (ctx) => {
      const page = parsePageParam(ctx.params?.page);
      const entries = await listWorktreeEntries();
      if (entries.length === 0) {
        return buildKeyboard([
          [uiButton("Custom Task Key", uiInputAction("worktrees_release"))],
          uiNavRow("workspaces"),
        ]);
      }
      const perPage = 8;
      const totalPages = Math.max(1, Math.ceil(entries.length / perPage));
      const safePage = Math.min(page, totalPages - 1);
      const slice = entries.slice(
        safePage * perPage,
        safePage * perPage + perPage,
      );
      const rows = chunkButtons(
        slice.map((entry) => {
          const age = formatDurationMs(entry.ageMs);
          const detailLines = [
            `Task Key: \`${entry.taskKey}\``,
            entry.branch ? `Branch: \`${entry.branch}\`` : null,
            entry.status ? `Status: ${entry.status}` : null,
            entry.owner ? `Owner: ${entry.owner}` : null,
            `Age: ${age}`,
            entry.path ? `Path: \`${shortPath(entry.path)}\`` : null,
          ];
          const token = issueUiToken({
            type: "confirm_cmd",
            command: `/worktrees release ${entry.taskKey}`,
            title: "Release Worktree",
            confirmLabel: "Release",
            detailLines,
            backAction: uiGoAction("worktrees_release", safePage),
          });
          return uiButton(shortenLabel(entry.taskKey), uiTokenAction(token));
        }),
        2,
      );
      if (totalPages > 1) {
        const pager = [];
        if (safePage > 0) {
          pager.push(
            uiButton(":arrowRight: Prev", uiGoAction("worktrees_release", safePage - 1)),
          );
        }
        if (safePage < totalPages - 1) {
          pager.push(
            uiButton("Next :arrowRight:", uiGoAction("worktrees_release", safePage + 1)),
          );
        }
        if (pager.length) rows.push(pager);
      }
      rows.push([
        uiButton("Custom Task Key", uiInputAction("worktrees_release")),
      ]);
      rows.push(uiNavRow("workspaces"));
      return buildKeyboard(rows);
    },
  },
  shared_claim: {
    title: "Claim Shared Workspace",
    parent: "workspaces",
    body: () => "Select a workspace to review details and confirm claim.",
    keyboard: async (ctx) => {
      const page = parsePageParam(ctx.params?.page);
      const entries = await listSharedWorkspaceEntries();
      if (!entries.length) {
        return buildKeyboard([
          [uiButton("Custom Claim", uiInputAction("shared_claim"))],
          uiNavRow("workspaces"),
        ]);
      }
      const available = entries.filter((ws) => ws.availability === "available");
      const pool = available.length ? available : entries;
      const perPage = 8;
      const totalPages = Math.max(1, Math.ceil(pool.length / perPage));
      const safePage = Math.min(page, totalPages - 1);
      const slice = pool.slice(
        safePage * perPage,
        safePage * perPage + perPage,
      );
      const rows = chunkButtons(
        slice.map((ws) => {
          const detailLines = buildSharedWorkspaceDetailLines(ws);
          if (ws.availability !== "available") {
            detailLines.push("Note: Workspace is not marked available.");
          }
          const token = issueUiToken({
            type: "confirm_cmd",
            command: `/claim ${ws.id}`,
            title: "Claim Shared Workspace",
            confirmLabel: ws.availability === "available" ? "Claim" : "Claim Anyway",
            detailLines,
            backAction: uiGoAction("shared_claim", safePage),
          });
          const emoji = ws.availability === "available" ? ":check:" : ":lock:";
          return uiButton(
            `${emoji} ${shortenLabel(ws.id)}`,
            uiTokenAction(token),
          );
        }),
        2,
      );
      if (totalPages > 1) {
        const pager = [];
        if (safePage > 0) {
          pager.push(
            uiButton(":arrowRight: Prev", uiGoAction("shared_claim", safePage - 1)),
          );
        }
        if (safePage < totalPages - 1) {
          pager.push(
            uiButton("Next :arrowRight:", uiGoAction("shared_claim", safePage + 1)),
          );
        }
        if (pager.length) rows.push(pager);
      }
      rows.push([uiButton("Custom Claim", uiInputAction("shared_claim"))]);
      rows.push(uiNavRow("workspaces"));
      return buildKeyboard(rows);
    },
  },
  shared_release: {
    title: "Release Shared Workspace",
    parent: "workspaces",
    body: () => "Select a workspace to review details and confirm release.",
    keyboard: async (ctx) => {
      const page = parsePageParam(ctx.params?.page);
      const entries = await listSharedWorkspaceEntries();
      if (!entries.length) {
        return buildKeyboard([
          [uiButton("Custom Release", uiInputAction("shared_release"))],
          uiNavRow("workspaces"),
        ]);
      }
      const perPage = 8;
      const totalPages = Math.max(1, Math.ceil(entries.length / perPage));
      const safePage = Math.min(page, totalPages - 1);
      const slice = entries.slice(
        safePage * perPage,
        safePage * perPage + perPage,
      );
      const rows = chunkButtons(
        slice.map((ws) => {
          const detailLines = buildSharedWorkspaceDetailLines(ws);
          if (ws.availability !== "leased") {
            detailLines.push("Note: Workspace is not currently leased.");
          }
          const token = issueUiToken({
            type: "confirm_cmd",
            command: `/release ${ws.id}`,
            title: "Release Shared Workspace",
            confirmLabel: "Release",
            detailLines,
            backAction: uiGoAction("shared_release", safePage),
          });
          const emoji = ws.availability === "leased" ? ":unlock:" : ":help:";
          return uiButton(
            `${emoji} ${shortenLabel(ws.id)}`,
            uiTokenAction(token),
          );
        }),
        2,
      );
      if (totalPages > 1) {
        const pager = [];
        if (safePage > 0) {
          pager.push(
            uiButton(":arrowRight: Prev", uiGoAction("shared_release", safePage - 1)),
          );
        }
        if (safePage < totalPages - 1) {
          pager.push(
            uiButton("Next :arrowRight:", uiGoAction("shared_release", safePage + 1)),
          );
        }
        if (pager.length) rows.push(pager);
      }
      rows.push([uiButton("Custom Release", uiInputAction("shared_release"))]);
      rows.push(uiNavRow("workspaces"));
      return buildKeyboard(rows);
    },
  },
  managed_workspaces: {
    title: "My Workspaces",
    parent: "workspaces",
    body: () => "Browse, manage, and interact with your managed workspaces.",
    keyboard: async (ctx) => {
      const page = parsePageParam(ctx.params?.page);
      const configDir = resolveTelegramConfigDir();
      const workspaces = listLocalWorkspaces(configDir);
      const active = getActiveLocalWorkspace(configDir);
      if (!workspaces.length) {
        return buildKeyboard([
          [uiButton(":plus: Create Workspace", uiInputAction("workspace_create"))],
          [uiButton(":refresh: Scan Disk", uiCmdAction("/workspace scan"))],
          uiNavRow("workspaces"),
        ]);
      }
      const perPage = 5;
      const totalPages = Math.max(1, Math.ceil(workspaces.length / perPage));
      const safePage = Math.min(page, totalPages - 1);
      const slice = workspaces.slice(
        safePage * perPage,
        safePage * perPage + perPage,
      );
      const rows = [];
      for (const ws of slice) {
        const isActive = ws.id === active?.id;
        const repoCount = Array.isArray(ws.repos) ? ws.repos.length : 0;
        const repoNames = Array.isArray(ws.repos)
          ? ws.repos.map((r) => (typeof r === "string" ? r : r.name || r.url || "?")).join(", ")
          : "none";
        const prefix = isActive ? ":dot:" : ":dot:";
        const switchToken = issueUiToken({
          type: "confirm_cmd",
          command: `/workspace switch ${ws.id}`,
          title: `Workspace: ${ws.name || ws.id}`,
          confirmLabel: isActive ? "Already Active" : "Set Active",
          detailLines: [
            `Name: \`${ws.name || ws.id}\``,
            `ID: \`${ws.id}\``,
            `Repos (${repoCount}): ${repoNames || "none"}`,
            `Status: ${isActive ? ":check: Active" : "Inactive"}`,
          ],
          backAction: uiGoAction("managed_workspaces", safePage),
        });
        rows.push([
          uiButton(
            `${prefix} ${shortenLabel(ws.name || ws.id, 20)} (${repoCount})`,
            uiTokenAction(switchToken),
          ),
          uiButton(":download: Pull", uiCmdAction(`/workspace pull ${ws.id}`)),
          uiButton(":trash:", uiCmdAction(`/workspace delete ${ws.id}`)),
        ]);
      }
      if (totalPages > 1) {
        const pager = [];
        if (safePage > 0) {
          pager.push(
            uiButton(":arrowRight: Prev", uiGoAction("managed_workspaces", safePage - 1)),
          );
        }
        if (safePage < totalPages - 1) {
          pager.push(
            uiButton("Next :arrowRight:", uiGoAction("managed_workspaces", safePage + 1)),
          );
        }
        if (pager.length) rows.push(pager);
      }
      rows.push([
        uiButton(":plus: Create", uiInputAction("workspace_create")),
        uiButton(":refresh: Scan", uiCmdAction("/workspace scan")),
      ]);
      rows.push(uiNavRow("workspaces"));
      return buildKeyboard(rows);
    },
  },
});

Object.assign(UI_SCREENS, {
  logs: {
    title: "Logs & Git",
    parent: "home",
    body: () => "Logs, branches, diffs, and utilities.",
    keyboard: () =>
      buildKeyboard([
        // Logs
        [
          uiButton(":edit: System Logs", uiGoAction("logs_tail")),
          uiButton(":folder: Agent Logs", uiGoAction("agent_logs")),
        ],
        // Git
        [
          uiButton(":git: Branches", uiCmdAction("/branches")),
          uiButton(":lightbulb: Diff", uiCmdAction("/diff")),
          uiButton(":search: Git", uiGoAction("git")),
        ],
        // Utils
        [
          uiButton(":monitor: Shell", uiGoAction("shell")),
        ],
        uiNavRow("home"),
      ]),
  },
  logs_tail: {
    title: "Tail Logs",
    parent: "logs",
    body: () => "Choose how many log lines to show.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("30 lines", uiCmdAction("/logs 30")),
          uiButton("100 lines", uiCmdAction("/logs 100")),
          uiButton("300 lines", uiCmdAction("/logs 300")),
        ],
        [
          uiButton("600 lines", uiCmdAction("/logs 600")),
          uiButton("Custom", uiInputAction("logs_lines")),
        ],
        uiNavRow("logs"),
      ]),
  },
  git: {
    title: "Git",
    parent: "logs",
    body: () => "Quick git utilities.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("Status", uiCmdAction("/git status")),
          uiButton("Log -5", uiCmdAction("/git log --oneline -5")),
        ],
        [
          uiButton(
            "Branches",
            uiCmdAction("/git branch -a --sort=-committerdate"),
          ),
          uiButton("Diff Stat", uiCmdAction("/git diff --stat")),
        ],
        [uiButton("Custom Git", uiInputAction("git"))],
        uiNavRow("logs"),
      ]),
  },
  shell: {
    title: "Shell",
    parent: "logs",
    body: () => "Run safe shell commands.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton("dir", uiCmdAction("/shell dir")),
          uiButton("cd", uiCmdAction("/shell cd")),
        ],
        [
          uiButton("whoami", uiCmdAction("/shell whoami")),
          uiButton("ver", uiCmdAction("/shell ver")),
        ],
        [uiButton("Custom Shell", uiInputAction("shell"))],
        uiNavRow("logs"),
      ]),
  },
  integrations: {
    title: "Integrations",
    parent: "home",
    body: () => "WhatsApp and container runtime status.",
    keyboard: () =>
      buildKeyboard([
        [
          uiButton(":phone: WhatsApp", uiCmdAction("/whatsapp")),
          uiButton(":box: Container", uiCmdAction("/container")),
        ],
        uiNavRow("home"),
      ]),
  },
  session: {
    title: "Session",
    parent: "home",
    body: () => "Primary agent session controls.",
    keyboard: () =>
      buildKeyboard([
        // Interaction
        [
          uiButton(":chat: Ask", uiInputAction("ask")),
          uiButton(":compass: Steer", uiInputAction("steer")),
        ],
        // Context
        [
          uiButton(":cpu: History", uiCmdAction("/history")),
          uiButton(":trash: Clear", "confirm_clear"),
        ],
        // Control
        [
          uiButton(":server: Background", uiGoAction("background")),
          uiButton(":close: Stop", uiCmdAction("/stop")),
        ],
        [
          uiButton(":mag: Menu Diag", uiCmdAction("/menu diag")),
          uiButton(":broom: Reset Menu", uiCmdAction("/menu reset")),
        ],
        uiNavRow("home"),
      ]),
  },
});

async function showUiScreen(chatId, messageId, screenId, params = {}, opts = {}) {
  const screen = UI_SCREENS[screenId];
  if (!screen) {
    await sendReply(chatId, "Unknown menu.");
    return;
  }
  const sticky = Boolean(opts.sticky);
  const stickyActive = sticky || getStickyMenuState(chatId)?.enabled;
  const isCurrentSticky = isStickyMenuMessage(chatId, messageId);
  const isStaleSticky =
    !!messageId && stickyActive && !isCurrentSticky && isStaleStickyMenuMessage(chatId, messageId);
  let resolvedMessageId = messageId;
  if (isStaleSticky) {
    await deleteDirect(chatId, messageId);
    resolvedMessageId = null;
  }
  const ctx = { chatId, params };
  const body =
    typeof screen.body === "function"
      ? await screen.body(ctx)
      : screen.body || "";
  const title = screen.title ? `*${screen.title}*` : "";

  // Support inline result rendering — show command output above the keyboard
  const inlineResult = opts.result || "";
  const textParts = [title, body];
  if (inlineResult) {
    // Truncate result to leave room for title/body/keyboard in 4096 char limit
    const maxResultLen = 3200 - title.length - body.length;
    const trimmedResult = inlineResult.length > maxResultLen
      ? inlineResult.slice(0, maxResultLen - 20) + "\n…(truncated)"
      : inlineResult;
    textParts.push("━━━━━━━━━━━━━━━━━━━━━━━━");
    textParts.push(trimmedResult);
    textParts.push("━━━━━━━━━━━━━━━━━━━━━━━━");
  }
  const text = textParts.filter(Boolean).join("\n\n");

  const keyboard =
    typeof screen.keyboard === "function"
      ? await screen.keyboard(ctx)
      : screen.keyboard;
  const finalKeyboard = appendRefreshRow(keyboard, screenId, params);
  const sendOpts = {
    parseMode: "Markdown",
    reply_markup: finalKeyboard,
  };
  if (resolvedMessageId) {
    await editDirect(chatId, resolvedMessageId, text, sendOpts);
    if (stickyActive) {
      setStickyMenuState(chatId, {
        enabled: true,
        screenId,
        params,
        messageId: resolvedMessageId,
        mode: "menu",
        restoreScreenId: null,
        restoreParams: null,
      });
    }
  } else if (stickyActive) {
    const prev = getStickyMenuState(chatId);
    if (prev?.messageId) {
      try {
        await deleteDirect(chatId, prev.messageId);
      } catch {
        /* best effort */
      }
    }
    const newId = await sendDirect(chatId, text, {
      ...sendOpts,
      skipSticky: true,
    });
    setStickyMenuState(chatId, {
      enabled: true,
      messageId: newId,
      screenId,
      params,
      mode: "menu",
      restoreScreenId: null,
      restoreParams: null,
    });
  } else {
    await sendDirect(chatId, text, sendOpts);
  }
}

async function handleUiAction({ chatId, messageId, data }) {
  const { type, rest, raw } = parseUiAction(data);
  const stickyEnabled = ensureStickyMenuEnabled(chatId, messageId);
  const staleSticky = stickyEnabled && isStaleStickyMenuMessage(chatId, messageId);
  if (type === "cancel") {
    clearPendingUiInput(chatId);
    if (isStickyMenuInteractive(chatId)) {
      await restoreStickyMenuMessage(chatId);
      return;
    }
    if (messageId) {
      await deleteDirect(chatId, messageId);
    }
    await sendReply(chatId, ":check: Input cancelled.");
    return;
  }
  if (type === "confirm_clear") {
    enqueueCommand(() => handleCommand("/clear", chatId));
    return;
  }
  if (type === "go") {
    const screenId = rest[0];
    const page = rest[1] ? parsePageParam(rest[1]) : 0;
    const resolvedMessageId =
      staleSticky ? null : messageId || null;
    await showUiScreen(chatId, resolvedMessageId, screenId, { page }, {
      sticky: stickyEnabled,
    });
    return;
  }
  if (type === "cmd") {
    const command = raw.slice(4);
    const cmd = command.split(/\s+/)[0].toLowerCase().replace(/@\w+/, "");

    // For capturable read-only commands, render output inline in the menu message
    // instead of sending a separate message (eliminates menu disappear/reappear)
    if (INLINE_CAPTURABLE_COMMANDS.has(cmd)) {
      try {
        const captured = await captureCommandOutput(command);
        if (captured) {
          // Determine which screen to render the result in
          const state = getStickyMenuState(chatId);
          const parentScreen = state?.screenId || "home";
          const resolvedMessageId =
            staleSticky ? null : (isStickyMenuMessage(chatId, messageId) ? messageId : null);
          await showUiScreen(chatId, resolvedMessageId || messageId, parentScreen, state?.params || {}, {
            sticky: stickyEnabled,
            result: captured,
          });
          return;
        }
      } catch {
        // Fall through to regular dispatch on capture failure
      }
    }

    // For action commands (restart, cleanup, etc.), dispatch normally
    if (staleSticky && messageId) {
      await deleteDirect(chatId, messageId);
    }
    await dispatchUiCommand(chatId, command);
    return;
  }
  if (type === "input") {
    if (staleSticky && messageId) {
      await deleteDirect(chatId, messageId);
    }
    const key = rest[0];
    await promptUiInput(chatId, key);
    return;
  }
  if (type === "token") {
    const token = rest[0];
    const payload = readUiToken(token);
    if (!payload) {
      if (messageId && !isStickyMenuMessage(chatId, messageId)) {
        await deleteDirect(chatId, messageId);
      }
      if (messageId && isStickyMenuMessage(chatId, messageId)) {
        const state = getStickyMenuState(chatId);
        if (state?.screenId) {
          await showUiScreen(chatId, messageId, state.screenId, state.params || {}, {
            sticky: true,
          });
        }
      }
      await sendReply(
        chatId,
        ":clock: That option expired. Please reopen the menu.",
      );
      return;
    }
    if (payload.type === "confirm_cmd") {
      if (staleSticky && messageId) {
        await deleteDirect(chatId, messageId);
      }
      await promptActionConfirm(chatId, token, payload);
      return;
    }
    if (payload.type === "cmd") {
      const tokenCmd = payload.command?.split(/\s+/)[0]?.toLowerCase()?.replace(/@\w+/, "") || "";
      // Try inline rendering for capturable commands
      if (INLINE_CAPTURABLE_COMMANDS.has(tokenCmd)) {
        try {
          const captured = await captureCommandOutput(payload.command);
          if (captured) {
            const state = getStickyMenuState(chatId);
            const parentScreen = state?.screenId || "home";
            const resolvedMessageId =
              staleSticky ? null : (isStickyMenuMessage(chatId, messageId) ? messageId : null);
            await showUiScreen(chatId, resolvedMessageId || messageId, parentScreen, state?.params || {}, {
              sticky: stickyEnabled,
              result: captured,
            });
            return;
          }
        } catch {
          // Fall through
        }
      }
      if (staleSticky && messageId) {
        await deleteDirect(chatId, messageId);
      }
      if (isStickyMenuInteractive(chatId)) {
        await restoreStickyMenuMessage(chatId);
      }
      await dispatchUiCommand(chatId, payload.command);
      return;
    }
    if (payload.type === "input") {
      if (staleSticky && messageId) {
        await deleteDirect(chatId, messageId);
      }
      await promptUiInput(chatId, payload.key, payload);
      return;
    }
    if (payload.type === "go") {
      const resolvedMessageId =
        staleSticky || !isStickyMenuMessage(chatId, messageId)
          ? null
          : messageId;
      await showUiScreen(chatId, resolvedMessageId, payload.screenId, payload.params, {
        sticky: stickyEnabled,
      });
      return;
    }
    if (payload.type === "starttask_confirm") {
      await promptStartTaskConfirm(chatId, payload);
      return;
    }
    if (payload.type === "starttask_executor") {
      const mode = resolveStartTaskExecutorMode();
      const executor = resolveStartTaskExecutor(payload.executor, mode);
      if (!executor) {
        await sendReply(
          chatId,
          `:alert: Executor "${payload.executor || "auto"}" not available (mode: ${mode}).`,
        );
        await showStartTaskExecutorPicker(chatId, payload.taskId);
        return;
      }
      await showStartTaskSdkPicker(chatId, payload.taskId, executor || "internal");
      return;
    }
    if (payload.type === "starttask_sdk") {
      await showStartTaskModelPicker(
        chatId,
        payload.taskId,
        payload.sdk,
        payload.executor,
      );
      return;
    }
    if (payload.type === "starttask_sdk_list") {
      await showStartTaskSdkPicker(
        chatId,
        payload.taskId,
        payload.executor,
      );
      return;
    }
    if (payload.type === "starttask_executor_list") {
      await showStartTaskExecutorPicker(chatId, payload.taskId);
      return;
    }
  }
  await sendReply(chatId, `Unknown UI action: ${data}`);
}

async function handleWebAppData(raw, chatId) {
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { type: "command", command: String(raw || "").trim() };
  }

  if (!payload || typeof payload !== "object") {
    await sendReply(chatId, ":alert: Web app sent an invalid payload.");
    return;
  }

  if (payload.type === "command" && payload.command) {
    await dispatchUiCommand(chatId, payload.command);
    return;
  }

  if (payload.type === "menu" && payload.screen) {
    await showUiScreen(chatId, null, payload.screen, payload.params || {}, {
      sticky: getStickyMenuState(chatId)?.enabled,
    });
    return;
  }

  if (payload.type === "prompt" && payload.key) {
    await promptUiInput(chatId, payload.key, payload);
    return;
  }

  await sendReply(chatId, ":alert: Web app request not recognized.");
}

// ── Built-in Command Handlers ────────────────────────────────────────────────

function splitArgs(input) {
  if (!input) return [];
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function stripLeadingConfirmFlag(rawArgs) {
  const trimmed = String(rawArgs || "").trim();
  if (!trimmed) return { confirmed: false, args: "" };
  const match = trimmed.match(/^--confirm\b\s*/i);
  if (!match) return { confirmed: false, args: trimmed };
  return { confirmed: true, args: trimmed.slice(match[0].length).trim() };
}

function matchesAnyPattern(value, patterns) {
  const lower = String(value || "").toLowerCase();
  return patterns.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(lower) : lower.includes(pattern),
  );
}

function parseSharedWorkspaceArgs(args) {
  const tokens = splitArgs(args);
  const parsed = {
    workspaceId: null,
    owner: null,
    ttlMinutes: null,
    note: "",
    reason: "",
    force: false,
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--owner") {
      parsed.owner = tokens[i + 1];
      i++;
      continue;
    }
    if (token === "--ttl") {
      parsed.ttlMinutes = Number(tokens[i + 1]);
      i++;
      continue;
    }
    if (token === "--note") {
      parsed.note = tokens.slice(i + 1).join(" ");
      break;
    }
    if (token === "--reason") {
      parsed.reason = tokens.slice(i + 1).join(" ");
      break;
    }
    if (token === "--force") {
      parsed.force = true;
      continue;
    }
    if (!parsed.workspaceId) {
      parsed.workspaceId = token;
    }
  }
  return parsed;
}

function parseAgentArgs(args) {
  const tokens = splitArgs(args);
  let workspaceId = null;
  let role = null;
  let model = null;
  let queue = false;
  let newSession = false;
  let dryRun = false;
  let taskTokens = [];
  const remaining = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--workspace" || token === "-w") {
      workspaceId = tokens[i + 1] || null;
      i++;
      continue;
    }
    if (token.startsWith("--workspace=")) {
      workspaceId = token.slice("--workspace=".length) || null;
      continue;
    }
    if (token === "--role" || token === "-r") {
      role = tokens[i + 1] || null;
      i++;
      continue;
    }
    if (token.startsWith("--role=")) {
      role = token.slice("--role=".length) || null;
      continue;
    }
    if (token === "--model" || token === "-m") {
      model = tokens[i + 1] || null;
      i++;
      continue;
    }
    if (token.startsWith("--model=")) {
      model = token.slice("--model=".length) || null;
      continue;
    }
    if (token === "--queue") {
      queue = true;
      continue;
    }
    if (token === "--new-session") {
      newSession = true;
      continue;
    }
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token === "--task" || token === "-t") {
      taskTokens = tokens.slice(i + 1);
      break;
    }
    if (token.startsWith("--task=")) {
      taskTokens = [token.slice("--task=".length)];
      break;
    }
    remaining.push(token);
  }

  if (taskTokens.length === 0) {
    taskTokens = remaining;
  }

  return {
    workspaceId: workspaceId ? workspaceId.trim() : null,
    role: role ? role.trim() : null,
    model: model ? model.trim() : null,
    queue,
    newSession,
    dryRun,
    message: taskTokens.join(" ").trim(),
  };
}

function isPathLike(value) {
  return /[\\/]|^[A-Za-z]:/.test(value);
}

function findRepoPath(basePath) {
  if (!basePath) return null;
  const resolved = resolve(basePath);
  if (existsSync(resolve(resolved, "go.mod"))) {
    return resolved;
  }
  return null;
}

async function listWorkspaceIds(worktreesRoot) {
  const entries = await readdir(worktreesRoot, { withFileTypes: true }).catch(
    () => [],
  );
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repoPath = findRepoPath(resolve(worktreesRoot, entry.name));
    if (repoPath) ids.push(entry.name);
  }
  return ids;
}

async function resolveWorkspaceRepo(workspaceId) {
  const trimmed = (workspaceId || "").trim();
  if (!trimmed) {
    return {
      repoPath: repoRoot,
      label: "primary coordinator",
      isPrimary: true,
    };
  }

  const lower = trimmed.toLowerCase();
  if (["primary", "coordinator", "default"].includes(lower)) {
    return {
      repoPath: repoRoot,
      label: "primary coordinator",
      isPrimary: true,
    };
  }

  const worktreesRoot = resolve(repoRoot, "..", "..");
  const candidates = [];

  if (isPathLike(trimmed)) {
    candidates.push(trimmed);
    candidates.push(resolve(worktreesRoot, trimmed));
  } else {
    candidates.push(resolve(worktreesRoot, trimmed));
  }

  for (const candidate of candidates) {
    const repoPath = findRepoPath(candidate);
    if (repoPath) {
      return {
        repoPath,
        label: trimmed,
        isPrimary: repoPath === repoRoot,
      };
    }
  }

  const suggestions = await listWorkspaceIds(worktreesRoot);
  return {
    error: `Workspace "${trimmed}" not found.`,
    suggestions,
    worktreesRoot,
  };
}

async function loadWorkspaceStatusData(workspacePath) {
  try {
    const workspaceStatusPath = resolve(
      workspacePath,
      ".cache",
      "orchestrator-status.json",
    );
    const raw = await readFile(workspaceStatusPath, "utf8").catch(() => null);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function cmdApp(chatId) {
  const { uiUrl, webAppUrl } = syncUiUrlsFromServer();
  if (!uiUrl) {
    await sendReply(
      chatId,
      ":alert: Mini App not configured. Set TELEGRAM_UI_PORT and TELEGRAM_MINIAPP_ENABLED=true in your environment.",
    );
    return;
  }
  const browserOptions = getBrowserUiUrlOptions();
  const voiceMeetingWebAppUrl = getMeetingWebAppUrl("voice", {
    chat_id: String(chatId || "").trim(),
  });
  const videoMeetingWebAppUrl = getMeetingWebAppUrl("video", {
    chat_id: String(chatId || "").trim(),
  });
  const rows = [];
  if (webAppUrl) {
    rows.unshift([{ text: ":phone: Open Control Center", web_app: { url: webAppUrl } }]);
  }
  if (voiceMeetingWebAppUrl || videoMeetingWebAppUrl) {
    rows.push([
      voiceMeetingWebAppUrl
        ? { text: "Voice Meeting", web_app: { url: voiceMeetingWebAppUrl } }
        : { text: "Voice Meeting", callback_data: "/call" },
      videoMeetingWebAppUrl
        ? { text: "Video Meeting", web_app: { url: videoMeetingWebAppUrl } }
        : { text: "Video Meeting", callback_data: "/videocall" },
    ]);
  }
  if (browserOptions.length > 0) {
    rows.push(...browserOptions.map((option) => [{ text: option.label, url: option.url }]));
  } else {
    rows.push([{ text: ":globe: Open in Browser", url: getBrowserUiUrl() || uiUrl }]);
  }
  const keyboard = { inline_keyboard: rows };

  await sendDirect(
    chatId,
    ":rocket: *Bosun Control Center*\n\nOpen the Mini App or access via browser:",
    {
      parseMode: "Markdown",
      reply_markup: keyboard,
    },
  );
}

async function cmdCall(chatId, args = "") {
  const callType = normalizeMeetingCallType(args);
  const isVideo = callType === "video";
  const label = isVideo ? "video" : "voice";
  const title = isVideo ? "*Video Meeting*" : "*Voice Meeting*";
  syncUiUrlsFromServer();

  const webAppMeetingUrl = getMeetingWebAppUrl(callType, {
    chat_id: String(chatId || "").trim(),
  });
  const browserOptions = getMeetingBrowserUrlOptions(callType, {
    chat_id: String(chatId || "").trim(),
  });

  const rows = [];
  if (webAppMeetingUrl) {
    rows.push([
      {
        text: isVideo ? "Start Video Meeting" : "Start Voice Meeting",
        web_app: { url: webAppMeetingUrl },
      },
    ]);
  }
  if (browserOptions.length > 0) {
    rows.push(
      ...browserOptions.map((option) => [
        {
          text: `${option.label} (${label})`,
          url: option.url,
        },
      ]),
    );
  }

  if (rows.length === 0) {
    await sendReply(
      chatId,
      ":alert: Meeting UI is not available yet. Set TELEGRAM_WEBAPP_URL (HTTPS) or enable the UI tunnel first.",
    );
    return;
  }

  await sendDirect(
    chatId,
    [
      title,
      "",
      "One tap opens the Bosun meeting room with your default agent + voice settings.",
      isVideo
        ? "Video mode auto-starts camera. You can switch to screen share any time."
        : "Voice mode starts instantly. You can enable camera/screen share in-call.",
    ].join("\n"),
    {
      parseMode: "Markdown",
      reply_markup: { inline_keyboard: rows },
    },
  );
}

async function cmdVideoCall(chatId, args = "") {
  const normalized = String(args || "").trim();
  await cmdCall(chatId, normalized ? `video ${normalized}` : "video");
}

async function cmdMenu(chatId, args = "") {
  const action = String(args || "").trim().toLowerCase();
  if (["diag", "diagnostics", "lease", "session"].includes(action)) {
    await sendReply(chatId, formatStickyMenuDiagnosticsMessage(chatId));
    return;
  }
  if (action === "reset") {
    const reset = resetStickyMenuContext(chatId, { reason: "operator" });
    logTelegramStructured("sticky_menu.reset_applied", {
      chatId,
      reason: reset.reason,
      previousSessionId: reset.previousSessionId,
      previousLeaseAgeMs: reset.previousLeaseAgeMs,
    });
    await sendReply(chatId, formatStickyMenuResetMessage(reset));
    syncUiUrlsFromServer();
    if (telegramApiReachable !== false) {
      safeDetach("menu-button-refresh", refreshMenuButton);
    }
    await showUiScreen(chatId, null, "home", {}, { sticky: true });
    return;
  }
  syncUiUrlsFromServer();
  if (telegramApiReachable !== false) {
    safeDetach("menu-button-refresh", refreshMenuButton);
  }
  clearPendingUiInput(chatId);
  await showUiScreen(chatId, null, "home", {}, { sticky: true });
}

async function cmdCancel(chatId) {
  const pending = getPendingUiInput(chatId);
  if (!pending) {
    await sendReply(chatId, "No pending input to cancel.");
    return;
  }
  clearPendingUiInput(chatId);
  if (isStickyMenuInteractive(chatId)) {
    await restoreStickyMenuMessage(chatId);
    return;
  }
  await sendReply(chatId, ":check: Input cancelled.");
}

async function cmdHelp(chatId) {
  await cmdMenu(chatId);
}

async function cmdHelpFull(chatId) {
  const lines = [":bot: Bosun Primary Agent — All Commands:\n"];
  for (const [cmd, { desc }] of Object.entries(COMMANDS)) {
    lines.push(`${cmd} — ${desc}`);
  }
  lines.push(
    "",
    "Any other text → sent to the primary agent (full repo + MCP access)",
    "Use /menu for the full button-driven control center.",
  );
  await sendReply(chatId, lines.join("\n"));
}

async function readJsonlTail(path, maxLines = 2000) {
  try {
    const raw = await readFile(path, "utf8");
    if (!raw) return [];
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-maxLines);
    return tail
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function withinDays(entry, days) {
  if (!days) return true;
  const ts = Date.parse(entry?.timestamp || "");
  if (!Number.isFinite(ts)) return true;
  return ts >= Date.now() - days * 24 * 60 * 60 * 1000;
}

function summarizeTelemetry(metrics, days) {
  const filtered = metrics.filter((m) => withinDays(m, days));
  if (filtered.length === 0) return null;
  const total = filtered.length;
  const success = filtered.filter(
    (m) => m.outcome?.status === "completed" || m.metrics?.success === true,
  ).length;
  const durations = filtered.map((m) => m.metrics?.duration_ms || 0);
  const avgDuration =
    durations.length > 0
      ? Math.round(
          durations.reduce((a, b) => a + b, 0) / durations.length / 1000,
        )
      : 0;
  const totalErrors = filtered.reduce(
    (sum, m) => sum + (m.error_summary?.total_errors || m.metrics?.errors || 0),
    0,
  );
  const executors = {};
  for (const m of filtered) {
    const exec = m.executor || "unknown";
    executors[exec] = (executors[exec] || 0) + 1;
  }
  return {
    total,
    success,
    successRate: total > 0 ? Math.round((success / total) * 100) : 0,
    avgDuration,
    totalErrors,
    executors,
  };
}

async function cmdTelemetry(chatId, args = "") {
  const mode = String(args || "").trim().toLowerCase();
  const days = Number(process.env.TELEMETRY_DAYS || 7);
  const logDir = resolve(repoRoot, ".cache", "agent-work-logs");
  const metricsPath = resolve(logDir, "agent-metrics.jsonl");
  const errorsPath = resolve(logDir, "agent-errors.jsonl");
  const alertsPath = resolve(logDir, "agent-alerts.jsonl");

  if (mode === "errors") {
    const errors = (await readJsonlTail(errorsPath, 1000)).filter((e) =>
      withinDays(e, days),
    );
    if (errors.length === 0) {
      return sendReply(chatId, "No error telemetry found.");
    }
    const byFingerprint = new Map();
    for (const e of errors) {
      const fp = e.data?.error_fingerprint || e.data?.error_message || "unknown";
      byFingerprint.set(fp, (byFingerprint.get(fp) || 0) + 1);
    }
    const top = [...byFingerprint.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    const lines = [
      ":alert: Telemetry — Top Errors",
      `Window: last ${days}d`,
      "",
    ];
    for (const [fp, count] of top) {
      lines.push(`• ${fp.slice(0, 80)} (${count})`);
    }
    return sendReply(chatId, lines.join("\n"));
  }

  if (mode === "executors") {
    const metrics = await readJsonlTail(metricsPath, 2000);
    const summary = summarizeTelemetry(metrics, days);
    if (!summary) return sendReply(chatId, "No telemetry metrics found.");
    const lines = [
      ":beaker: Telemetry — Executor Mix",
      `Window: last ${days}d`,
      "",
    ];
    for (const [exec, count] of Object.entries(summary.executors)) {
      lines.push(`• ${exec}: ${count}`);
    }
    return sendReply(chatId, lines.join("\n"));
  }

  if (mode === "alerts") {
    const alerts = (await readJsonlTail(alertsPath, 200)).filter((a) =>
      withinDays(a, days),
    );
    if (alerts.length === 0) {
      return sendReply(chatId, "No analyzer alerts found.");
    }
    const lines = [
      ":alert: Telemetry — Recent Alerts",
      `Window: last ${days}d`,
      "",
      ...alerts.slice(-10).map((a) => {
        const sev = (a.severity || "medium").toUpperCase();
        const attempt = a.attempt_id || "unknown";
        const type = a.type || "alert";
        return `• ${sev} ${type} (${attempt})`;
      }),
    ];
    return sendReply(chatId, lines.join("\n"));
  }

  if (!mode) {
    const surface = await harnessApi.getSurface("telemetry", 12).catch(() => null);
    if (surface?.ok) {
      const monitor = surface?.telemetry?.monitor || {};
      const harnessSummary = surface?.telemetry?.harnessSummary || {};
      const harnessProviders = surface?.telemetry?.harnessProviders || {};
      const providerRows = Array.isArray(harnessProviders?.providers) ? harnessProviders.providers : [];
      const lines = [
        ":chart: Telemetry Summary",
        "",
        `Agents: ${monitor?.activeAgents || 0}/${monitor?.maxAgents || 0}`,
        `Tokens: in ${monitor?.tokensIn || 0} | out ${monitor?.tokensOut || 0} | total ${monitor?.totalTokens || monitor?.tokensTotal || 0}`,
        `Harness sessions: ${harnessSummary?.sessionCount || 0} | events: ${harnessSummary?.eventCount || 0} | runs: ${harnessSummary?.runCount || 0}`,
      ];
      if (providerRows.length) {
        lines.push("");
        lines.push(":electric_plug: Providers");
        for (const provider of providerRows.slice(0, 6)) {
          lines.push(
            `  ${provider?.providerId || provider?.provider || "provider"}: sessions=${provider?.sessionCount || 0} tokens=${provider?.tokenCount || 0} calls=${provider?.callCount || 0}`,
          );
        }
      }
      lines.push("");
      lines.push("Use /telemetry errors | executors | alerts for drill-down.");
      return sendReply(chatId, lines.join("\n"));
    }
  }

  const metrics = await readJsonlTail(metricsPath, 2000);
  const summary = summarizeTelemetry(metrics, days);
  if (!summary) {
    return sendReply(chatId, "No telemetry metrics found.");
  }
  const lines = [
    ":chart: Telemetry Summary",
    `Window: last ${days}d`,
    "",
    `Sessions: ${summary.total}`,
    `Success: ${summary.success}/${summary.total} (${summary.successRate}%)`,
    `Avg duration: ${summary.avgDuration}s`,
    `Total errors: ${summary.totalErrors}`,
    "",
    "Use /telemetry errors | executors | alerts for drill‑down.",
  ];
  return sendReply(chatId, lines.join("\n"));
}

async function cmdWeeklyReport(chatId, args = "") {
  try {
    const maybeDays = Number.parseInt(String(args || "").trim(), 10);
    const days = Number.isFinite(maybeDays) && maybeDays > 0 && maybeDays <= 30
      ? maybeDays
      : 7;
    const report = await generateWeeklyAgentWorkReport({ days });
    await sendReply(chatId, report.text);
  } catch (err) {
    await sendReply(chatId, `Weekly report failed: ${err?.message || err}`);
  }
}

async function cmdReport(chatId, args = "") {
  const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
  const subcommand = (parts[0] || "").toLowerCase();
  if (subcommand === "weekly") {
    const remainingArgs = parts.slice(1).join(" ");
    await cmdWeeklyReport(chatId, remainingArgs);
    return;
  }
  await sendReply(chatId, "Usage: /report weekly [days]");
}

async function cmdAsk(chatId, args) {
  const prompt = String(args || "").trim();
  if (!prompt) {
    await sendReply(chatId, "Usage: /ask <prompt>");
    return;
  }
  enqueueAgentTask(() => handleFreeText(prompt, chatId), chatId);
}

async function cmdStatus(chatId) {
  await sendReply(chatId, ":clock: Reading orchestrator status...");

  let statusText = "Status unavailable";

  // Try the formatted summary first
  if (_readStatusSummary) {
    try {
      const summary = await _readStatusSummary();
      if (summary?.text) {
        await sendReply(chatId, summary.text, {
          parseMode: summary.parseMode || undefined,
        });
        return;
      }
    } catch {
      /* fallback to raw */
    }
  }

  // Fallback: read raw status file
  try {
    const raw = await readFile(statusPath, "utf8");
    const data = JSON.parse(raw);

    const counts = data.counts || {};
    const sm = data.success_metrics || {};
    const backlog = data.backlog_remaining ?? "?";
    const submitted = Array.isArray(data.submitted_tasks)
      ? data.submitted_tasks.length
      : 0;
    const completed = Array.isArray(data.completed_tasks)
      ? data.completed_tasks.length
      : 0;
    const errors = Array.isArray(data.error_tasks) ? data.error_tasks : [];
    const reviews = Array.isArray(data.review_tasks) ? data.review_tasks : [];
    const manualReviews = Array.isArray(data.manual_review_tasks)
      ? data.manual_review_tasks
      : [];

    const lines = [
      ":chart: Bosun Orchestrator Status",
      "",
      `Running: ${counts.running ?? 0}`,
      `Review: ${counts.review ?? 0}`,
      `Error: ${counts.error ?? 0}`,
      `Manual Review: ${counts.manual_review ?? 0}`,
      `Backlog: ${backlog}`,
      "",
      `Submitted: ${submitted} | Completed: ${completed}`,
      `First-shot: ${sm.first_shot_rate ?? 0}% (${sm.first_shot_success ?? 0}/${(sm.first_shot_success ?? 0) + (sm.needed_fix ?? 0) + (sm.failed ?? 0)})`,
      `Needed fix: ${sm.needed_fix ?? 0} | Failed: ${sm.failed ?? 0}`,
    ];

    if (errors.length > 0) {
      lines.push(
        "",
        ":alert: Error tasks:",
        ...errors.slice(0, 5).map((t) => `  - ${t}`),
      );
    }
    if (manualReviews.length > 0) {
      lines.push(
        "",
        ":eye: Manual review:",
        ...manualReviews.slice(0, 5).map((t) => `  - ${t}`),
      );
    }

    statusText = lines.join("\n");
  } catch (err) {
    statusText = `Status file error: ${err.message}`;
  }

  await sendReply(chatId, statusText);
}

async function cmdAnomalies(chatId) {
  if (!_getAnomalyReport) {
    await sendReply(chatId, "Anomaly detector not initialized.");
    return;
  }
  try {
    const report = _getAnomalyReport();
    await sendReply(chatId, report, { parseMode: "HTML" });
  } catch (err) {
    await sendReply(chatId, `Error getting anomaly report: ${err.message}`);
  }
}

function formatRuntimeSeconds(seconds) {
  const safeSeconds =
    Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const mins = Math.floor(safeSeconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  return `${hours}h${remMin}m`;
}

function formatAgeFromTimestamp(timestampMs) {
  const ts = Number(timestampMs || 0);
  if (!Number.isFinite(ts) || ts <= 0) return "n/a";
  const ageSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  const hours = Math.floor(ageSec / 3600);
  const remMin = Math.floor((ageSec % 3600) / 60);
  return remMin > 0 ? `${hours}h ${remMin}m ago` : `${hours}h ago`;
}

function formatTimeUntil(timestampMs) {
  const ts = Number(timestampMs || 0);
  if (!Number.isFinite(ts) || ts <= 0) return "n/a";
  const deltaSec = Math.floor((ts - Date.now()) / 1000);
  if (deltaSec <= 0) return "expired";
  if (deltaSec < 60) return `${deltaSec}s`;
  const mins = Math.floor(deltaSec / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
}

async function cmdTasks(chatId) {
  try {
    // ── Prefer live executor slots over stale status file ──
    const executor = _getInternalExecutor?.();
    const executorStatus = executor?.getStatus?.();

    if (executorStatus) {
      let statusSnapshot = null;
      if (_readStatusData) {
        try {
          statusSnapshot = await _readStatusData();
        } catch {
          /* best effort */
        }
      }
      const reviewTaskIds = (() => {
        try {
          const pending = _getTasksPendingReview?.() || [];
          if (Array.isArray(pending) && pending.length > 0) {
            return pending.map((task) => task?.id).filter(Boolean);
          }
        } catch {
          /* best effort */
        }
        return Array.isArray(statusSnapshot?.review_tasks)
          ? statusSnapshot.review_tasks
          : [];
      })();
      const lines = [];

      // Show pause state prominently at top
      if (executorStatus.paused) {
        const dur = executorStatus.pauseDuration || 0;
        const durStr =
          dur >= 3600
            ? Math.round(dur / 3600) + "h"
            : dur >= 60
              ? Math.round(dur / 60) + "m"
              : dur + "s";
        lines.push(`:pause: PAUSED (for ${durStr}) — /resumetasks to resume`);
        lines.push("");
      }

      if (executorStatus.slots.length > 0) {
        lines.push(
          `:clipboard: Active Agents (${executorStatus.activeSlots}/${executorStatus.maxParallel} slots)\n`,
        );

        for (const slot of executorStatus.slots) {
          const emoji =
            slot.status === "running"
              ? ":dot:"
              : slot.status === "error"
                ? ":close:"
                : ":dot:";
          const runStr = formatRuntimeSeconds(slot.runningFor);
          const agentId =
            Number.isFinite(slot.agentInstanceId) && slot.agentInstanceId > 0
              ? `#${slot.agentInstanceId}`
              : "n/a";

          // Branch is still the best debug key for logs/worktrees.
          const branch = slot.branch || slot.taskId.substring(0, 8);
          const shortBranch = branch.replace(/^ve\//, "");
          lines.push(`${emoji} Agent ${agentId} • ${shortBranch}`);
          lines.push(`   ${slot.taskTitle}`);
          lines.push(
            `   SDK: ${slot.sdk} | :clock: ${runStr} | Attempt #${slot.attempt} | Task ${slot.taskId.substring(0, 8)}`,
          );

          // Git diff stats
          if (slot.branch) {
            try {
              const diffStat = execSync(
                `git diff --shortstat main...${slot.branch} 2>nul || echo ""`,
                { cwd: repoRoot, encoding: "utf8", timeout: 8000 },
              ).trim();
              if (diffStat) {
                const insMatch = diffStat.match(/(\d+) insertion/);
                const delMatch = diffStat.match(/(\d+) deletion/);
                const filesMatch = diffStat.match(/(\d+) file/);
                lines.push(
                  `   :chart: ${filesMatch?.[1] || 0} files | +${insMatch?.[1] || 0} -${delMatch?.[1] || 0}`,
                );
              }
            } catch {
              /* branch not pushed yet */
            }
          }
          lines.push(""); // spacing
        }

        const reviewAgent = _getReviewAgent?.();
        const reviewStatus =
          reviewAgent && typeof reviewAgent.getStatus === "function"
            ? reviewAgent.getStatus()
            : null;
        const reviewQueued =
          Number(reviewStatus?.queuedReviews || 0) +
          Number(reviewStatus?.activeReviews || 0);
        const taskStoreStats = _getTaskStoreStats?.() || null;
        const reviewCount = Math.max(
          Number(taskStoreStats?.inreview || 0),
          reviewQueued,
        );
        if (reviewCount > 0) {
          lines.push(`:eye: In review: ${reviewCount} task(s)`);
          if (reviewStatus) {
            lines.push(
              `   Review agent queue: active=${reviewStatus.activeReviews || 0}, queued=${reviewStatus.queuedReviews || 0}, completed=${reviewStatus.completedReviews || 0}`,
            );
          }
          if (reviewTaskIds.length > 0) {
            for (const taskId of reviewTaskIds.slice(0, 5)) {
              lines.push(`   - ${taskId}`);
            }
          }
          lines.push("");
        }

        lines.push("────────────────────────────");
        lines.push(`Use /agentlogs <branch> for agent output`);

        await sendReply(chatId, lines.join("\n"));
        return;
      } else {
        // No active slots — show status summary
        lines.push(
          `:clipboard: No active agents (0/${executorStatus.maxParallel} slots)`,
        );
        const reviewAgent = _getReviewAgent?.();
        const reviewStatus =
          reviewAgent && typeof reviewAgent.getStatus === "function"
            ? reviewAgent.getStatus()
            : null;
        const taskStoreStats = _getTaskStoreStats?.() || null;
        const reviewCount = Math.max(
          Number(taskStoreStats?.inreview || 0),
          Number(reviewStatus?.activeReviews || 0) +
            Number(reviewStatus?.queuedReviews || 0),
        );
        if (reviewCount > 0) {
          lines.push(`:eye: In review: ${reviewCount} task(s)`);
          if (reviewTaskIds.length > 0) {
            for (const taskId of reviewTaskIds.slice(0, 5)) {
              lines.push(`   - ${taskId}`);
            }
          }
        }
        if (executorStatus.blockedTasks?.length > 0) {
          lines.push(
            `\n:ban: ${executorStatus.blockedTasks.length} task(s) blocked (exceeded retry limit)`,
          );
        }
        lines.push("");
        lines.push(
          executorStatus.paused
            ? `Use /resumetasks to start accepting tasks`
            : `Waiting for todo tasks in kanban...`,
        );
      }

      await sendReply(chatId, lines.join("\n"));
      return;
    }

    // ── Fallback: read status file (legacy mode) ──
    const raw = await readFile(statusPath, "utf8");
    const data = JSON.parse(raw);
    const attempts = data.attempts || {};

    if (Object.keys(attempts).length === 0) {
      await sendReply(chatId, "No active task attempts tracked.");
      return;
    }

    const lines = [":clipboard: Active Task Attempts\n"];

    for (const [id, attempt] of Object.entries(attempts)) {
      if (!attempt) continue;
      const status = attempt.status || "unknown";
      const emoji =
        status === "running"
          ? ":dot:"
          : status === "review"
            ? ":eye:"
            : status === "error"
              ? ":close:"
              : status === "completed"
                ? ":check:"
                : ":pause:";
      const branch = attempt.branch || "";
      const pr = attempt.pr_number ? ` PR#${attempt.pr_number}` : "";
      const title = attempt.task_title || attempt.task_id || id;
      const shortBranch = branch ? branch.replace(/^ve\//, "") : title;
      const agentIdRaw = Number(attempt.agent_instance_id);
      const agentId =
        Number.isFinite(agentIdRaw) && agentIdRaw > 0 ? `#${agentIdRaw}` : null;

      lines.push(
        `${emoji} ${agentId ? `Agent ${agentId} • ` : ""}${shortBranch}${pr}`,
      );
      lines.push(`   ${title}`);
      lines.push(`   Status: ${status} | Agent: ${attempt.executor || "?"}`);

      const started =
        attempt.started_at || attempt.created_at || attempt.updated_at;
      if (started) {
        const dur = Date.now() - Date.parse(started);
        const mins = Math.floor(dur / 60000);
        const hrs = Math.floor(mins / 60);
        const remMin = mins % 60;
        const durStr = hrs > 0 ? `${hrs}h ${remMin}m` : `${mins}m`;
        lines.push(`   :clock: Active: ${durStr}`);
      }

      if (branch) {
        try {
          const diffStat = execSync(
            `git diff --shortstat main...${branch} 2>nul || echo ""`,
            { cwd: repoRoot, encoding: "utf8", timeout: 8000 },
          ).trim();
          if (diffStat) {
            const insMatch = diffStat.match(/(\d+) insertion/);
            const delMatch = diffStat.match(/(\d+) deletion/);
            const filesMatch = diffStat.match(/(\d+) file/);
            lines.push(
              `   :chart: ${filesMatch?.[1] || 0} files | +${insMatch?.[1] || 0} -${delMatch?.[1] || 0}`,
            );
          }
        } catch {
          /* git diff not available */
        }
      }
      lines.push("");
    }

    const running = Object.values(attempts).filter(
      (a) => a?.status === "running",
    ).length;
    const errors = Object.values(attempts).filter(
      (a) => a?.status === "error",
    ).length;
    const reviews = Object.values(attempts).filter(
      (a) => a?.status === "review" || a?.status === "manual_review",
    ).length;
    lines.push("────────────────────────────");
    lines.push(
      `Total: ${Object.keys(attempts).length} | Running: ${running} | Review: ${reviews} | Error: ${errors}`,
    );

    await sendReply(chatId, lines.join("\n"));
  } catch (err) {
    await sendReply(chatId, `Error reading tasks: ${err.message}`);
  }
}

async function cmdStartTask(chatId, args) {
  const rawArgs = String(args || "").trim();
  const tokens = rawArgs ? rawArgs.split(/\s+/) : [];
  const taskId = String(tokens.shift() || "").trim();
  if (!taskId) {
    await sendReply(
      chatId,
      "Usage: /starttask <taskId> [--executor internal] [--sdk <sdk>] [--model <model>]",
    );
    return;
  }
  let sdk = "";
  let model = "";
  let executorArg = "";
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--sdk" && tokens[i + 1]) {
      sdk = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith("--sdk=")) {
      sdk = token.slice("--sdk=".length);
      continue;
    }
    if (token === "--model" && tokens[i + 1]) {
      model = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith("--model=")) {
      model = token.slice("--model=".length);
      continue;
    }
    if (token === "--executor" && tokens[i + 1]) {
      executorArg = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith("--executor=")) {
      executorArg = token.slice("--executor=".length);
      continue;
    }
  }
  const executorMode = resolveStartTaskExecutorMode();
  const normalizedExecutor = executorArg ? normalizeStartTaskExecutor(executorArg) : "";
  if (executorArg && !normalizedExecutor) {
    await sendReply(
      chatId,
      `:alert: Unknown executor "${executorArg}". Use internal.`,
    );
    return;
  }
  const selectedExecutor = resolveStartTaskExecutor(
    normalizedExecutor,
    executorMode,
  );
  if (!selectedExecutor) {
    const availability = getStartTaskExecutorAvailability(executorMode);
    const options = [
      availability.internal ? "internal" : null,
    ]
      .filter(Boolean)
      .join(" | ");
    await sendReply(
      chatId,
      `:alert: Executor "${normalizedExecutor || "auto"}" not available (mode: ${executorMode}). Available: ${options || "none"}`,
    );
    return;
  }
  try {
    const adapter = getKanbanAdapter();
    const task = await adapter.getTask(taskId);
    if (!task) {
      await sendReply(chatId, `Task "${taskId}" not found.`);
      return;
    }

    const executor = _getInternalExecutor?.();
    if (!executor) {
      await sendReply(
        chatId,
        ":alert: Manual start requires internal executor. Set EXECUTOR_MODE=internal or hybrid and restart the monitor.",
      );
      return;
    }
    safeDetach("manual-start", () => executor.executeTask(task, {
      sdk: sdk || undefined,
      model: model || undefined,
    }));
    await sendReply(
      chatId,
      `:check: Manual start queued for ${task.title || task.id}.` +
        `\nExecutor: ${selectedExecutor}` +
        (sdk ? `\nSDK: ${sdk}` : "") +
        (model ? `\nModel: ${model}` : ""),
    );
  } catch (err) {
    await sendReply(chatId, `:close: Manual start failed: ${err.message}`);
  }
}

async function cmdAgents(chatId) {
  try {
    const surface = await harnessApi.getSurface("agents", 12).catch(() => null);
    if (surface?.ok) {
      const lines = [":bot: Agent Fleet", ""];
      const monitor = surface?.telemetry?.monitor || {};
      const executor = monitor?.executor || null;
      const sessions = Array.isArray(surface?.sessions) ? surface.sessions : [];
      const retryQueue = surface?.retryQueue && typeof surface.retryQueue === "object"
        ? surface.retryQueue
        : { count: 0, items: [] };
      const liveness = Array.isArray(surface?.agent?.liveness) ? surface.agent.liveness : [];
      const harnessRuns = Array.isArray(surface?.harness?.runs) ? surface.harness.runs : [];
      const harnessApprovals = Array.isArray(surface?.harness?.approvals) ? surface.harness.approvals : [];

      if (executor) {
        lines.push(
          `Task Executor: mode=${executor.mode || "internal"} | slots=${executor.activeSlots || 0}/${executor.maxParallel || 0} | paused=${executor.paused === true ? "yes" : "no"}`,
        );
        for (const slot of Array.isArray(executor.slots) ? executor.slots.slice(0, 5) : []) {
          lines.push(
            `  ${slot.taskId || "task"}: ${slot.taskTitle || "-"} | sdk=${slot.sdk || "-"} | status=${slot.status || "-"} | run=${formatRuntimeSeconds(Math.floor(Number(slot.runningFor || 0) / 1000))}`,
          );
        }
      }

      lines.push(
        `Sessions: ${sessions.length} | live agents: ${liveness.filter((entry) => entry?.alive !== false).length} | retry queue: ${retryQueue.count || 0}`,
      );
      if (harnessRuns.length) {
        lines.push(`Harness runs: ${harnessRuns.length} | pending approvals: ${harnessApprovals.length}`);
        for (const run of harnessRuns.slice(0, 4)) {
          lines.push(
            `  ${String(run?.runId || "run").slice(0, 12)}: ${run?.health?.state || run?.status || "unknown"} | stage=${run?.currentStageId || run?.health?.approvalStageId || "n/a"} | ${run?.health?.lastEventSummary || run?.summary || "no summary"}`,
          );
        }
      }
      if (liveness.length) {
        lines.push("");
        lines.push(":satellite: Live agent monitor");
        for (const entry of liveness.slice(0, 5)) {
          lines.push(
            `  ${entry?.taskId || entry?.sessionId || "agent"}: ${entry?.alive === false ? "stale" : "live"} | heartbeat=${entry?.lastHeartbeatAt || entry?.updatedAt || entry?.lastSeenAt || "n/a"}`,
          );
        }
      }
      await sendReply(chatId, lines.join("\n"));
      return;
    }

    const lines = [":bot: Agent Fleet", ""];
    let statusSnapshot = null;
    if (_readStatusData) {
      try {
        statusSnapshot = await _readStatusData();
      } catch {
        /* best effort */
      }
    }

    const executor = _getInternalExecutor?.();
    const executorStatus = executor?.getStatus?.();
    if (executorStatus) {
      lines.push(
        `Task Executor: ${executorStatus.running ? "running" : "stopped"} | mode=${executorStatus.mode} | slots=${executorStatus.activeSlots}/${executorStatus.maxParallel} | sdk=${executorStatus.sdk}`,
      );
      if (executorStatus.slots.length > 0) {
        for (const slot of executorStatus.slots) {
          const agentId =
            Number.isFinite(slot.agentInstanceId) && slot.agentInstanceId > 0
              ? `#${slot.agentInstanceId}`
              : "n/a";
          lines.push(
            `  Agent ${agentId}: ${slot.taskTitle} | status=${slot.status} | run=${formatRuntimeSeconds(slot.runningFor)} | branch=${slot.branch || "-"}`,
          );
        }
      }
    } else {
      lines.push("Task Executor: unavailable");
    }

    const threadPayload = await harnessApi.listThreads().catch(() => ({ items: [] }));
    const threads = Array.isArray(threadPayload?.items) ? threadPayload.items : [];
    lines.push(`Thread Registry: ${threads.length} active thread(s)`);
    for (const entry of threads.slice(0, 5)) {
      lines.push(
        `  ${entry.taskKey}: ${entry.sdk} turn=${entry.turnCount} age=${Math.round(entry.age / 60_000)}m`,
      );
    }

    const reviewEnabled = _getReviewAgentEnabled
      ? !!_getReviewAgentEnabled()
      : !!_getReviewAgent?.();
    const reviewAgent = _getReviewAgent?.();
    const reviewStatus =
      reviewAgent && typeof reviewAgent.getStatus === "function"
        ? reviewAgent.getStatus()
        : null;
    if (!reviewEnabled) {
      lines.push("Review Agent: disabled");
    } else if (reviewStatus) {
      lines.push(
        `Review Agent: running | active=${reviewStatus.activeReviews || 0} queued=${reviewStatus.queuedReviews || 0} completed=${reviewStatus.completedReviews || 0}`,
      );
    } else {
      lines.push("Review Agent: enabled, not running");
    }

    const endpoint = _getAgentEndpoint?.();
    const endpointStatus =
      endpoint && typeof endpoint.getStatus === "function"
        ? endpoint.getStatus()
        : null;
    if (endpointStatus) {
      lines.push(
        `Agent Endpoint: ${endpointStatus.running ? "listening" : "stopped"} | port=${endpointStatus.port} | uptime=${formatRuntimeSeconds(Math.floor((endpointStatus.uptimeMs || 0) / 1000))}`,
      );
    }

    const prCleanup = _getPrCleanupDaemon?.();
    const prStatus =
      prCleanup && typeof prCleanup.getStatus === "function"
        ? prCleanup.getStatus()
        : null;
    if (prStatus) {
      lines.push(
        `PR Cleanup Daemon: ${prStatus.running ? "running" : "stopped"} | active=${prStatus.activeCleanups} queued=${prStatus.queuedCleanups} | processed=${prStatus.stats?.prsProcessed || 0} resolved=${prStatus.stats?.conflictsResolved || 0}`,
      );
    }

    const monitorMonitor = _getMonitorMonitorStatus?.();
    if (monitorMonitor) {
      lines.push(
        `Monitor-Monitor: ${monitorMonitor.enabled ? (monitorMonitor.running ? "running" : "idle") : "disabled"} | sdk=${monitorMonitor.currentSdk || "n/a"} | failures=${monitorMonitor.consecutiveFailures || 0} | last=${formatAgeFromTimestamp(monitorMonitor.lastRunAt)}`,
      );
    }

    const workspaceMonitor = _getWorkspaceMonitor?.();
    if (
      workspaceMonitor &&
      typeof workspaceMonitor.getAllStates === "function"
    ) {
      const states = workspaceMonitor.getAllStates();
      lines.push(`Workspace Monitor: tracking ${states.length} workspace(s)`);
    }

    const syncEngine = _getSyncEngine?.();
    const syncStatus =
      syncEngine && typeof syncEngine.getStatus === "function"
        ? syncEngine.getStatus()
        : null;
    if (syncStatus) {
      lines.push(
        `Sync Engine: ${syncStatus.running ? "running" : "stopped"} | syncs=${syncStatus.syncsCompleted || 0} | failures=${syncStatus.consecutiveFailures || 0}`,
      );
    }

    const storeStats = _getTaskStoreStats?.();
    if (storeStats) {
      lines.push(
        `Task Store: todo=${storeStats.todo || 0} inprogress=${storeStats.inprogress || 0} inreview=${storeStats.inreview || 0} done=${storeStats.done || 0} blocked=${storeStats.blocked || 0}`,
      );
    }

    const conflictResolvingCount = Number(
      statusSnapshot?.counts?.conflict_resolving ||
        statusSnapshot?.counts?.conflictResolving ||
        0,
    );
    if (conflictResolvingCount > 0) {
      lines.push(
        `SDK Conflict Resolution Agents: active=${conflictResolvingCount}`,
      );
    }

    await sendReply(chatId, lines.join("\n"));
  } catch (err) {
    await sendReply(
      chatId,
      `:close: Failed to read agent fleet status: ${err.message}`,
    );
  }
}

/**
 * /agentlogs {branch} — Show agent output for a specific branch/worktree.
 * The branch can be partial (e.g. "hpc-topology" matches "ve/73ea9114-xl-p1-feat-hpc-topology-aware-scheduling").
 * Shows: last git log, last commit diff stat, worktree status.
 */
async function cmdAgentLogs(chatId, args) {
  const query = (args || "").trim();
  if (!query) {
    await sendReply(
      chatId,
      "Usage: /agentlogs <branch-fragment>\n\nExample: /agentlogs hpc-topology",
    );
    return;
  }

  try {
    // Find matching worktree
    const worktreeDir = resolve(repoRoot, ".cache", "worktrees");
    let dirs;
    try {
      dirs = await readdir(worktreeDir);
    } catch {
      await sendReply(chatId, "No worktrees directory found.");
      return;
    }

    const matches = dirs.filter((d) =>
      d.toLowerCase().includes(query.toLowerCase()),
    );
    if (matches.length === 0) {
      await sendReply(
        chatId,
        `No worktree matching "${query}".\n\nAvailable:\n${dirs.slice(0, 15).join("\n")}`,
      );
      return;
    }

    const wtName = matches[0]; // Best match
    const wtPath = resolve(worktreeDir, wtName);
    const lines = [`:folder: Agent: ${wtName}\n`];

    // Git log (last 5 commits)
    try {
      const gitLog = execSync(`git log --oneline -5 2>&1`, {
        cwd: wtPath,
        encoding: "utf8",
        timeout: 10000,
      }).trim();
      if (gitLog) {
        lines.push(":edit: Recent commits:");
        lines.push(gitLog);
      } else {
        lines.push(":edit: No commits yet");
      }
    } catch {
      lines.push(":edit: Git log unavailable");
    }

    lines.push("");

    // Git status
    try {
      const gitStatus = execSync(`git status --short 2>&1`, {
        cwd: wtPath,
        encoding: "utf8",
        timeout: 10000,
      }).trim();
      if (gitStatus) {
        const statusLines = gitStatus.split("\n");
        lines.push(`:file: Working tree: ${statusLines.length} changed files`);
        lines.push(statusLines.slice(0, 15).join("\n"));
        if (statusLines.length > 15)
          lines.push(`... +${statusLines.length - 15} more`);
      } else {
        lines.push(":file: Working tree: clean");
      }
    } catch {
      lines.push(":file: Git status unavailable");
    }

    lines.push("");

    // Diff stat vs main
    try {
      const branchName = execSync(`git branch --show-current 2>&1`, {
        cwd: wtPath,
        encoding: "utf8",
        timeout: 5000,
      }).trim();
      const diffStat = execSync(`git diff --stat main...${branchName} 2>&1`, {
        cwd: wtPath,
        encoding: "utf8",
        timeout: 10000,
      }).trim();
      if (diffStat) {
        const statLines = diffStat.split("\n");
        lines.push(":chart: Diff vs main:");
        // Show only summary line (last line)
        lines.push(statLines[statLines.length - 1] || "(none)");
      }
    } catch {
      /* no diff available */
    }

    lines.push("");

    // Check for active executor slot matching this branch
    const executor = _getInternalExecutor?.();
    if (executor) {
      const executorStatus = executor.getStatus?.();
      const slot = executorStatus?.slots?.find(
        (s) =>
          s.branch &&
          wtName.includes(s.branch.replace("ve/", "").replace(/\//g, "-")),
      );
      if (slot) {
        const runMin = Math.round(slot.runningFor / 60);
        const runStr =
          runMin >= 60
            ? `${Math.floor(runMin / 60)}h${runMin % 60}m`
            : `${runMin}m`;
        lines.push(
          `:bot: Active agent: ${slot.sdk} | Running: ${runStr} | Attempt #${slot.attempt}`,
        );
      } else {
        lines.push(":bot: No active agent on this branch");
      }
    }

    await sendReply(chatId, lines.join("\n"));
  } catch (err) {
    await sendReply(chatId, `Error: ${err.message}`);
  }
}

async function cmdLogs(chatId, _args) {
  const numLines = parseInt(_args, 10) || 30;
  try {
    const surfaceLogs = await harnessApi.getLogs(numLines).catch(() => null);
    if (surfaceLogs?.ok && surfaceLogs?.data) {
      const tailLines = Array.isArray(surfaceLogs.data.lines) ? surfaceLogs.data.lines : [];
      const files = Array.isArray(surfaceLogs.data.files) ? surfaceLogs.data.files.join(", ") : String(surfaceLogs.data.file || "logs");
      await sendReply(
        chatId,
        `:file: Last ${tailLines.length || numLines} lines (${files}):\n\n${tailLines.join("\n") || "(empty)"}`,
      );
      return;
    }

    const logFiles = await readdir(resolve(__dirname, "..", "logs")).catch(() => []);
    const logFile = logFiles
      .filter((f) => f.endsWith(".log"))
      .sort()
      .pop(); // most recent

    if (!logFile) {
      await sendReply(chatId, "No log files found.");
      return;
    }

    const logPath = resolve(__dirname, "..", "logs", logFile);
    const content = await readFile(logPath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const tail = lines.slice(-numLines).join("\n");

    await sendReply(
      chatId,
      `:file: Last ${numLines} lines of ${logFile}:\n\n${tail || "(empty)"}`,
    );
  } catch (err) {
    await sendReply(chatId, `Error reading logs: ${err.message}`);
  }
}

async function cmdBranches(chatId, _args) {
  try {
    const result = execSync("git branch -a --sort=-committerdate", {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10000,
    });
    const lines = result.split("\n").filter(Boolean).slice(0, 20);
    await sendReply(
      chatId,
      `:git: Recent branches (top 20):\n\n${lines.join("\n")}`,
    );
  } catch (err) {
    await sendReply(chatId, `Error listing branches: ${err.message}`);
  }
}

async function cmdDiff(chatId, _args) {
  try {
    const diffStat = execSync("git diff --stat HEAD", {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10000,
    });
    if (!diffStat.trim()) {
      await sendReply(chatId, "No uncommitted changes.");
      return;
    }
    await sendReply(
      chatId,
      `:edit: Working tree changes:\n\n${diffStat.slice(0, 3500)}`,
    );
  } catch (err) {
    await sendReply(chatId, `Error reading diff: ${err.message}`);
  }
}

/**
 * Hidden command — not listed in /help or Telegram autocomplete.
 * Writes TELEGRAM_UI_ALLOW_UNSAFE=false into .env and prompts a restart.
 * Surfaced only via the security warning message button.
 */
async function cmdDisableUnsafeAccess(chatId, _args, editMessageId) {
  const ok = disableUnsafeMode();
  // Delete the warning message if we came from an inline button
  if (editMessageId) {
    try { await deleteDirect(chatId, editMessageId); } catch { /* best effort */ }
  }
  if (ok) {
    await sendReply(
      chatId,
      ":check: *Unsafe access disabled.*\n\n"
        + "`TELEGRAM_UI_ALLOW_UNSAFE=false` has been written to your .env file.\n\n"
        + "Send /restart to restart Bosun — Cloudflare tunnel will start automatically on the next boot.",
      { parse_mode: "Markdown" },
    );
  } else {
    await sendReply(
      chatId,
      ":close: Could not write to .env automatically.\n\n"
        + "Please edit your .env file manually:\n"
        + "`TELEGRAM_UI_ALLOW_UNSAFE=false`\n\n"
        + "Then send /restart.",
      { parse_mode: "Markdown" },
    );
  }
}

async function cmdRestart(chatId, args) {
  const confirmFlag = /--confirm\b/i.test(String(args || ""));
  if (!confirmFlag) {
    await sendReply(
      chatId,
      ":alert: This will perform a *full Bosun restart* — all services, agent process, and monitor will stop and restart from scratch (equivalent to Ctrl+C + relaunch).\nProceed?",
      { reply_markup: buildConfirmKeyboard("cb:do_restart", "Confirm Full Restart") },
    );
    return;
  }

  if (!_requestFullBosunRestart) {
    // Fallback: legacy agent-only restart if hook not injected (shouldn't happen)
    await sendReply(chatId, ":alert: Full restart hook not available — falling back to agent-only restart.");
    try {
      if (_getCurrentChild) {
        const child = _getCurrentChild();
        if (child && child.pid) {
          try { child.kill("SIGTERM"); } catch { /* best effort */ }
        }
      }
      await sendReply(chatId, ":check: Agent restart signal sent.");
    } catch (err) {
      await sendReply(chatId, `:close: Restart failed: ${err.message}`);
    }
    return;
  }

  try {
    // Send confirmation BEFORE triggering restart — the bot shuts down ~1.5 s later
    await sendReply(
      chatId,
      ":refresh: Full Bosun restart initiated. All services stopping now — will be back in a few seconds...",
    );
    // Trigger monitor.mjs to exit with SELF_RESTART_EXIT_CODE (75).
    // cli.mjs detects this and immediately forks a completely fresh monitor process.
    _requestFullBosunRestart("telegram-restart-command");
  } catch (err) {
    await sendReply(chatId, `:close: Restart failed: ${err.message}`);
  }
}

async function cmdRetry(chatId, args) {
  if (!_attemptFreshSessionRetry) {
    await sendReply(
      chatId,
      ":close: Fresh session retry not available (not injected from monitor).",
    );
    return;
  }

  const reason = args?.trim() || "manual_retry_via_telegram";
  await sendReply(chatId, `:refresh: Attempting fresh session retry (${reason})...`);

  try {
    const started = await _attemptFreshSessionRetry(reason);
    if (started) {
      await sendReply(
        chatId,
        ":check: Fresh session started. New agent will pick up the task.",
      );
    } else {
      await sendReply(
        chatId,
        ":alert: Fresh session retry failed. Check logs for details (rate limit or no active attempt).",
      );
    }
  } catch (err) {
    await sendReply(chatId, `:close: Retry error: ${err.message || err}`);
  }
}

async function cmdPlan(chatId, args) {
  if (typeof _triggerTaskPlanner !== "function") {
    await sendReply(
      chatId,
      ":close: Task planner trigger is not available from monitor runtime.",
    );
    return;
  }

  const rawArgs = String(args || "").trim();
  let taskCount = null;
  let prompt = "";
  const countMatch = rawArgs.match(/^(\d+)\s*(.*)$/);
  if (countMatch) {
    const parsed = Number(countMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      taskCount = Math.max(1, Math.min(100, Math.trunc(parsed)));
    }
    prompt = String(countMatch[2] || "").trim();
  } else {
    prompt = rawArgs;
  }

  const launchingMsg = taskCount
    ? `:clipboard: Launching planner workflow for ${taskCount} task(s)...`
    : ":clipboard: Launching planner workflow...";
  await sendReply(chatId, launchingMsg);

  try {
    const result = await _triggerTaskPlanner({
      source: "telegram-command",
      reason: "manual-telegram-plan",
      taskCount,
      prompt,
    });
    if (!result?.ok) {
      await sendReply(
        chatId,
        `:close: Planner run failed: ${result?.error || "unknown error"}`,
      );
      return;
    }

    const created = Number(result.createdCount || 0);
    const parsed = Number(result.parsedCount || 0);
    await sendReply(
      chatId,
      `:check: Planner run finished. Created ${created} task(s) from ${parsed} parsed item(s).`,
    );
  } catch (err) {
    await sendReply(chatId, `:close: Planner run error: ${err?.message || err}`);
  }
}

async function cmdCleanupMerged(chatId, args) {
  const confirmFlag = /--confirm\b/i.test(String(args || ""));
  if (!_reconcileTaskStatuses) {
    await sendReply(
      chatId,
      ":close: Cleanup not available (not injected from monitor).",
    );
    return;
  }
  if (!confirmFlag) {
    await sendReply(
      chatId,
      ":alert: Cleanup will reconcile task statuses with PR/branch state.\nProceed?",
      { reply_markup: buildConfirmKeyboard("cb:confirm_cleanup", "Confirm Cleanup") },
    );
    return;
  }
  await sendReply(
    chatId,
    ":trash: Reconciling task statuses with PR/branch state…",
  );
  try {
    const result = await _reconcileTaskStatuses("manual-telegram");
    const lines = [
      ":check: Cleanup complete.",
      `Checked: ${result?.checked ?? 0}`,
      `Moved to done: ${result?.movedDone ?? 0}`,
      `Moved to inreview: ${result?.movedReview ?? 0}`,
    ];
    await sendReply(chatId, lines.join("\n"));
  } catch (err) {
    await sendReply(chatId, `:close: Cleanup error: ${err.message || err}`);
  }
}

async function cmdHistory(chatId) {
  const session = getActiveAgentSession(chatId);
  const sessionId = String(session?.sessionId || "").trim();
  let detail = null;
  if (sessionId) {
    detail = await harnessApi.getSession(sessionId).catch(() => null);
  }
  const sessionLabel = sessionId || "(none)";
  const sessionRecord = detail?.session || {};
  const turnCount = Array.isArray(sessionRecord?.messages) ? sessionRecord.messages.length : 0;
  const agentLabel = String(sessionRecord?.metadata?.agent || sessionRecord?.metadata?.mode || "harness-session").trim();
  const lines = [
    `:cpu: Harness Session (${agentLabel})`,
    "",
    `Session: ${sessionLabel}`,
    `Turns: ${turnCount}`,
    `Active: ${session?.running === true ? "yes" : "no"}`,
    `Busy: ${session?.running === true ? "yes" : "no"}`,
    sessionRecord?.metadata?.workspaceDir ? `Workspace: ${sessionRecord.metadata.workspaceDir}` : "",
    "",
    "The session persists across messages.",
    "Use /clear to start a fresh session.",
  ];
  await sendReply(chatId, lines.filter(Boolean).join("\n"));
}

async function cmdClear(chatId, args) {
  const confirmFlag = /--confirm\b/i.test(String(args || ""));
  const session = getActiveAgentSession(chatId);
  const sessionId = String(session?.sessionId || "").trim();
  if (!confirmFlag) {
    const lines = [
      ":alert: This will clear the active harness session and reset context.",
      "",
      `Session: ${sessionId || "(none)"}`,
      `Busy: ${session?.running === true ? "yes" : "no"}`,
      "",
      "Proceed?",
    ];
    await sendReply(chatId, lines.join("\n"), {
      reply_markup: buildConfirmKeyboard("cb:confirm_clear", "Confirm Clear"),
    });
    return;
  }
  if (sessionId) {
    await harnessApi.deleteSession(sessionId).catch(() => null);
  }
  clearActiveAgentSession(chatId);
  await sendReply(
    chatId,
    ":trash: Harness session reset. Next message starts a fresh conversation.",
  );
}

async function cmdGit(chatId, gitArgs) {
  if (!gitArgs) {
    await sendReply(
      chatId,
      "Usage: /git <command>\nExample: /git log --oneline -10",
    );
    return;
  }

  const { confirmed, args } = stripLeadingConfirmFlag(gitArgs);
  if (!args) {
    await sendReply(
      chatId,
      "Usage: /git <command>\nExample: /git log --oneline -10",
    );
    return;
  }
  const destructiveGit = [
    /^push\b/i,
    /^reset\b.*--hard\b/i,
    /^clean\b.*-f\b/i,
    /^checkout\b.*-f\b/i,
  ];
  if (!confirmed && matchesAnyPattern(args, destructiveGit)) {
    const token = issueUiToken({
      type: "confirm_cmd",
      command: `/git --confirm ${args}`,
      title: "Run Destructive Git Command",
      confirmLabel: "Run Git",
      detailLines: [`Command: \`git ${shortSnippet(args, 120)}\``],
      hint: "This may rewrite history or delete files.",
    });
    await promptActionConfirm(chatId, token, {
      type: "confirm_cmd",
      title: "Run Destructive Git Command",
      confirmLabel: "Run Git",
      detailLines: [`Command: \`git ${shortSnippet(args, 120)}\``],
      hint: "This may rewrite history or delete files.",
    });
    return;
  }

  try {
    const result = execSync(`git ${args}`, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15000,
    });
    await sendReply(
      chatId,
      `$ git ${args}\n\n${result.slice(0, 3800) || "(no output)"}`,
    );
  } catch (err) {
    await sendReply(
      chatId,
      `$ git ${args}\n\n:close: ${err.message?.slice(0, 1500) || err}`,
    );
  }
}

async function cmdShell(chatId, shellArgs) {
  if (!shellArgs) {
    await sendReply(
      chatId,
      "Usage: /shell <command>\nExample: /shell ls -la scripts/",
    );
    return;
  }

  const { confirmed, args } = stripLeadingConfirmFlag(shellArgs);
  if (!args) {
    await sendReply(
      chatId,
      "Usage: /shell <command>\nExample: /shell ls -la scripts/",
    );
    return;
  }

  const blockedShell = [/rm\s+-rf\s+\/(\s|$)/i];
  if (matchesAnyPattern(args, blockedShell)) {
    await sendReply(chatId, `:ban: Blocked: '${args}' is too destructive.`);
    return;
  }

  const confirmShell = [
    /rm\s+-rf\b/i,
    /rm\s+-r\b/i,
    "format",
    "del /f /s",
    "shutdown",
    "reboot",
  ];
  if (!confirmed && matchesAnyPattern(args, confirmShell)) {
    const token = issueUiToken({
      type: "confirm_cmd",
      command: `/shell --confirm ${args}`,
      title: "Run Destructive Shell Command",
      confirmLabel: "Run Shell",
      detailLines: [`Command: \`${shortSnippet(args, 120)}\``],
      hint: "This may delete data or stop services.",
    });
    await promptActionConfirm(chatId, token, {
      type: "confirm_cmd",
      title: "Run Destructive Shell Command",
      confirmLabel: "Run Shell",
      detailLines: [`Command: \`${shortSnippet(args, 120)}\``],
      hint: "This may delete data or stop services.",
    });
    return;
  }

  try {
    const isWin = process.platform === "win32";
    const result = execSync(args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30000,
      shell: isWin ? "cmd.exe" : "/bin/sh",
    });
    await sendReply(
      chatId,
      `$ ${args}\n\n${result.slice(0, 3800) || "(no output)"}`,
    );
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().slice(0, 1000) : "";
    const stdout = err.stdout ? err.stdout.toString().slice(0, 1000) : "";
    await sendReply(
      chatId,
      `$ ${args}\n\n:close: ${stderr || stdout || err.message}`,
    );
  }
}

// ── Region / Health / Model Override Commands ─────────────────────────────────

function runPwsh(psScript, timeoutMs = 15000) {
  const isWin = process.platform === "win32";
  const pwsh = isWin
    ? "powershell.exe"
    : resolvePwshRuntime({ preferBundled: true }).command;
  const script = `& { ${psScript} }`;
  const result = spawnSync(pwsh, ["-NoProfile", "-Command", script], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (result.error) {
    throw new Error(result.error.message);
  }
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "").trim() ||
        `powershell command failed (exit ${result.status})`,
    );
  }
  return result.stdout;
}

function runPwshAsync(psScript, timeoutMs = 15000) {
  const isWin = process.platform === "win32";
  const pwsh = isWin
    ? "powershell.exe"
    : resolvePwshRuntime({ preferBundled: true }).command;
  const script = `& { ${psScript} }`;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(pwsh, ["-NoProfile", "-Command", script], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (err, value = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) rejectPromise(err);
      else resolvePromise(value);
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (err) => {
      finish(new Error(err.message));
    });
    child.once("close", (code) => {
      if (code !== 0) {
        finish(
          new Error(
            (stderr || stdout || "").trim() ||
              `powershell command failed (exit ${code})`,
          ),
        );
        return;
      }
      finish(null, stdout);
    });

    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`powershell command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

const HEALTH_REGION_CACHE_TTL_MS = Math.max(
  1000,
  Number(process.env.TELEGRAM_HEALTH_REGION_CACHE_TTL_MS || "30000") || 30000,
);
const executorHealthRegionCache = createExecutorHealthRegionCache({
  ttlMs: HEALTH_REGION_CACHE_TTL_MS,
  loadExecutorRegionStatus,
  safeDetach,
});

function resetHealthRegionCacheForTest() {
  executorHealthRegionCache.reset();
}

async function loadExecutorRegionStatus() {
  const regionScript = [
    `. '${resolveVeKanbanPs1Path()}';`,
    "Initialize-CodexRegionTracking;",
    "Get-RegionStatus | ConvertTo-Json",
  ].join(" ");
  const regionResult = await runPwshAsync(regionScript, 10000);
  return JSON.parse(regionResult);
}

async function getCachedExecutorRegionStatus(options = {}) {
  return executorHealthRegionCache.getCachedStatus(options);
}

export const __executorHealthTestApi = {
  getCachedExecutorRegionStatus,
  resetHealthRegionCacheForTest,
};

async function readStatusSnapshot() {
  try {
    const raw = await readFile(statusPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildExecutorKey(executor, variant) {
  const exec = (executor || "unknown").toString().trim().toUpperCase();
  const varNorm = variant ? String(variant).trim().toUpperCase() : "";
  return varNorm ? `${exec}:${varNorm}` : exec;
}

function buildExecutorHealthFromStatus(statusData) {
  const metrics = new Map();
  const attempts = statusData?.attempts ?? {};
  for (const info of Object.values(attempts)) {
    if (!info) continue;
    const key = buildExecutorKey(info.executor, info.executor_variant);
    const entry = metrics.get(key) || {
      active: 0,
      failures: 0,
      successes: 0,
      timeouts: 0,
      rate_limits: 0,
    };

    const processStatus = String(
      info.last_process_status || info.status || "",
    ).toLowerCase();
    const trackedStatus = String(info.status || "").toLowerCase();

    if (
      ["running", "queued", "in_progress", "active"].includes(processStatus) ||
      trackedStatus === "running"
    ) {
      entry.active += 1;
    } else if (
      ["failed", "error", "killed", "aborted"].includes(processStatus) ||
      trackedStatus === "error"
    ) {
      entry.failures += 1;
    } else if (
      ["completed", "success", "review", "done"].includes(processStatus) ||
      ["review", "completed", "done"].includes(trackedStatus)
    ) {
      entry.successes += 1;
    }

    if (processStatus.includes("timeout")) entry.timeouts += 1;
    if (processStatus.includes("rate") || processStatus.includes("limit")) {
      entry.rate_limits += 1;
    }

    metrics.set(key, entry);
  }
  return metrics;
}

function deriveExecutorStatus(stats) {
  if (!stats) return "unknown";
  if ((stats.rate_limits ?? 0) > 0) return "cooldown";
  if ((stats.failures ?? 0) > 0 || (stats.timeouts ?? 0) > 0) {
    return "degraded";
  }
  if ((stats.active ?? 0) > 0 || (stats.successes ?? 0) > 0) {
    return "healthy";
  }
  return "unknown";
}

function buildExecutorHealthEntries(executorConfig, metrics) {
  const entries = [];
  const usedKeys = new Set();
  const executors = executorConfig?.executors ?? [];

  for (const exec of executors) {
    const key = buildExecutorKey(exec.executor, exec.variant);
    const stats =
      metrics.get(key) ||
      metrics.get(buildExecutorKey(exec.executor, null)) ||
      null;
    usedKeys.add(key);
    entries.push({
      label:
        exec.executor && exec.variant
          ? `${exec.executor}/${exec.variant}`
          : exec.executor || exec.name || key,
      tier: exec.tier || exec.role || "default",
      region: exec.region || exec.variant || "default",
      status: deriveExecutorStatus(stats),
      stats: stats || {
        active: 0,
        failures: 0,
        successes: 0,
        timeouts: 0,
        rate_limits: 0,
      },
    });
  }

  for (const [key, stats] of metrics.entries()) {
    if (usedKeys.has(key)) continue;
    entries.push({
      label: key.replace(":", "/"),
      tier: "default",
      region: "default",
      status: deriveExecutorStatus(stats),
      stats,
    });
  }

  return entries;
}

async function cmdRegion(chatId, regionArg) {
  if (!regionArg || regionArg.trim() === "") {
    // Show current region status
    try {
      const result = runPwsh(
        `. '${resolveVeKanbanPs1Path()}'; Initialize-CodexRegionTracking; Get-RegionStatus | ConvertTo-Json -Depth 3`,
      );
      const status = JSON.parse(result);
      const lines = [
        ":globe: Codex Region Status",
        "",
        `Active: ${status.active_region?.toUpperCase() || "unknown"}`,
        `Override: ${status.override || "auto"}`,
        `Sweden available: ${status.sweden_available ? ":check:" : ":close:"}`,
        `Cooldown: ${status.cooldown_min}min`,
      ];
      if (status.switched_ago_min !== null) {
        lines.push(`Switched: ${status.switched_ago_min}min ago`);
      }
      if (status.active_region === "sweden") {
        lines.push(
          `Auto-restore to US: ${status.cooldown_expired ? "ready" : `in ${Math.round(status.cooldown_min - (status.switched_ago_min || 0))}min`}`,
        );
      }
      lines.push("", "Usage: /region us | /region sweden | /region auto");
      await sendReply(chatId, lines.join("\n"));
    } catch (err) {
      await sendReply(chatId, `Error reading region: ${err.message}`);
    }
    return;
  }

  const target = regionArg.trim().toLowerCase();
  if (!["us", "sweden", "auto"].includes(target)) {
    await sendReply(
      chatId,
      "Usage: /region us | /region sweden | /region auto",
    );
    return;
  }

  try {
    const psCmd =
      target === "auto"
        ? `. '${resolveVeKanbanPs1Path()}'; Set-RegionOverride -Region $null | ConvertTo-Json`
        : `. '${resolveVeKanbanPs1Path()}'; Set-RegionOverride -Region '${target}' | ConvertTo-Json`;
    const result = runPwsh(psCmd);
    const info = JSON.parse(result);
    const icon = info.changed ? ":check:" : ":help:";
    await sendReply(
      chatId,
      `${icon} Region: ${info.region?.toUpperCase()}\nReason: ${info.reason}`,
    );
  } catch (err) {
    await sendReply(chatId, `:close: Region switch failed: ${err.message}`);
  }
}

async function cmdHealth(chatId) {
  try {
    const statusData = await readStatusSnapshot();
    let executorConfig = null;
    try {
      executorConfig = loadExecutorConfig(__dirname, null);
    } catch {
      executorConfig = null;
    }
    const metrics = buildExecutorHealthFromStatus(statusData);
    const arr = buildExecutorHealthEntries(executorConfig, metrics);

    const iconMap = {
      healthy: ":check:",
      degraded: ":alert:",
      cooldown: ":pause:",
      disabled: ":close:",
    };
    const lines = [":heart: Executor Health Dashboard\n"];

    if (!arr.length) {
      lines.push("No executor data available.");
    }

    for (const e of arr) {
      const icon = iconMap[e.status] || ":help:";
      lines.push(
        `${icon} ${e.label} (${e.tier}/${e.region})\n` +
          `   Status: ${e.status} | Active: ${e.stats.active}\n` +
          `   ✓${e.stats.successes} ✗${e.stats.failures} :clock:${e.stats.timeouts} :ban:${e.stats.rate_limits}`,
      );
    }

    // Add region info
    try {
      const region = await getCachedExecutorRegionStatus();
      lines.push(
        "",
        `:globe: Region: ${region.active_region?.toUpperCase()} ${region.override ? `(override: ${region.override})` : "(auto)"}`,
        `Sweden backup: ${region.sweden_available ? "available" : "not configured"}`,
      );
    } catch {
      lines.push("", ":globe: Region: unavailable");
    }

    await sendReply(chatId, lines.join("\n"));
  } catch (err) {
    await sendReply(chatId, `Error reading health: ${err.message}`);
  }
}

async function cmdPresence(chatId) {
  await ensurePresenceReady();
  const child = _getCurrentChild ? _getCurrentChild() : null;
  const payload = buildLocalPresence({
    orchestrator_running: !!child,
    orchestrator_pid: child?.pid ?? null,
  });
  await notePresence(payload, {
    source: "local",
    receivedAt: payload.updated_at,
  });
  const nowMs = Date.now();
  const summary = formatPresenceSummary({ nowMs, ttlMs: presenceTtlMs });
  await sendReply(chatId, summary);
}

async function cmdCoordinator(chatId) {
  await ensurePresenceReady();
  const nowMs = Date.now();
  const summary = formatCoordinatorSummary({ nowMs, ttlMs: presenceTtlMs });
  await sendReply(chatId, summary);
}

/** State for model override — write a file that orchestrator reads */
const modelOverridePath = resolve(repoRoot, ".cache", "executor-override.json");

async function cmdModel(chatId, modelArg) {
  if (!modelArg || modelArg.trim() === "") {
    // Show current model routing info
    try {
      const exists = existsSync(modelOverridePath);
      let overrideText = "none (auto routing)";
      if (exists) {
        const raw = await readFile(modelOverridePath, "utf8");
        const data = JSON.parse(raw);
        if (
          data.model &&
          (!data.expires_at || new Date(data.expires_at) > new Date())
        ) {
          overrideText = `${data.model} (until ${data.expires_at || "cleared"})`;
        }
      }
      const lines = [
        ":bot: Model Routing",
        "",
        `Override: ${overrideText}`,
        "",
        "Available models:",
        "  gpt-5.2-codex      — Primary, best speed/quality",
        "  gpt-5.1-codex-max  — Large tasks, extra capacity",
        "  gpt-5.1-codex-mini — Small tasks, subagent-optimized",
        "  claude-opus-4.6    — Supreme quality, complex refactors",
        "  claude-code        — Claude Code CLI fallback",
        "",
        "Usage:",
        "  /model gpt-5.2-codex     Set override for next 3 tasks",
        "  /model auto              Clear override (smart routing)",
      ];
      await sendReply(chatId, lines.join("\n"));
    } catch (err) {
      await sendReply(chatId, `Error: ${err.message}`);
    }
    return;
  }

  const target = modelArg.trim().toLowerCase();

  if (target === "auto" || target === "clear") {
    try {
      if (existsSync(modelOverridePath)) {
        await unlink(modelOverridePath);
      }
      await sendReply(
        chatId,
        ":check: Model override cleared. Smart routing active.",
      );
    } catch (err) {
      await sendReply(chatId, `:close: Error: ${err.message}`);
    }
    return;
  }

  const validModels = [
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "claude-opus-4.6",
    "claude-code",
  ];
  if (!validModels.includes(target)) {
    await sendReply(
      chatId,
      `Unknown model: ${target}\nValid: ${validModels.join(", ")}`,
    );
    return;
  }

  try {
    const override = {
      model: target,
      remaining_tasks: 3,
      set_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
    };
    await writeFile(
      modelOverridePath,
      JSON.stringify(override, null, 2),
      "utf8",
    );
    await sendReply(
      chatId,
      `:check: Model override set: ${target}\nApplies to next 3 tasks (or 1 hour)`,
    );
  } catch (err) {
    await sendReply(chatId, `:close: Error: ${err.message}`);
  }
}

async function cmdKanban(chatId, backendArg) {
  if (!backendArg || backendArg.trim() === "") {
    const current = getKanbanBackendName();
    const available = getAvailableBackends();
    const syncPolicy = String(
      process.env.KANBAN_SYNC_POLICY || "internal-primary",
    ).toLowerCase();
    const lines = [
      ":clipboard: Kanban Backend Status",
      "",
      `Active: ${current}`,
      `Sync Policy: ${syncPolicy}`,
      `Available: ${available.join(", ")}`,
      "",
      "Switch backend:",
      "  /kanban internal  Internal task-store (primary)",
      "  /kanban github     GitHub Issues",
      "  /kanban jira       Jira",
    ];
    await sendReply(chatId, lines.join("\n"));
    return;
  }

  const target = backendArg.trim().toLowerCase();
  const validBackends = getAvailableBackends();

  if (!validBackends.includes(target)) {
    await sendReply(
      chatId,
      `Unknown backend: ${target}\nValid: ${validBackends.join(", ")}`,
    );
    return;
  }

  try {
    setKanbanBackend(target);
    await sendReply(
      chatId,
      `:check: Kanban backend switched to: ${target}\nActive: ${getKanbanBackendName()}`,
    );
  } catch (err) {
    await sendReply(chatId, `:close: Error switching backend: ${err.message}`);
  }
}

async function cmdAutoBacklog(chatId, args) {
  const executor = _getInternalExecutor?.();
  if (!executor) {
    await sendReply(chatId, ":alert: Internal executor is not available.");
    return;
  }

  const parts = String(args || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0 || parts[0] === "status") {
    const cfg = executor.getBacklogReplenishmentConfig?.() || {};
    await sendReply(
      chatId,
      [
        ":repeat: Experimental Auto-Backlog",
        "",
        `Enabled: ${cfg.enabled ? "yes" : "no"}`,
        `Min new tasks: ${cfg.minNewTasks ?? 1}`,
        `Max new tasks: ${cfg.maxNewTasks ?? 2}`,
        `Require priority: ${cfg.requirePriority !== false ? "yes" : "no"}`,
        `Requirements profile: ${cfg.projectRequirements?.profile || "feature"}`,
        "",
        "Usage:",
        "  /autobacklog on|off",
        "  /autobacklog min <1|2>",
        "  /autobacklog max <1|2|3>",
      ].join("\n"),
    );
    return;
  }

  const op = parts[0];
  if (op === "on" || op === "off") {
    const cfg = executor.setBacklogReplenishmentConfig?.({
      enabled: op === "on",
    });
    await sendReply(
      chatId,
      `:check: Auto-backlog ${op === "on" ? "enabled" : "disabled"}. Min=${cfg?.minNewTasks ?? 1}, Max=${cfg?.maxNewTasks ?? 2}`,
    );
    return;
  }

  if ((op === "min" || op === "max") && parts[1]) {
    const value = Number(parts[1]);
    if (!Number.isFinite(value)) {
      await sendReply(chatId, `:close: Invalid ${op} value: ${parts[1]}`);
      return;
    }
    const patch = op === "min" ? { minNewTasks: value } : { maxNewTasks: value };
    const cfg = executor.setBacklogReplenishmentConfig?.(patch);
    await sendReply(
      chatId,
      `:check: Auto-backlog updated. Enabled=${cfg?.enabled ? "yes" : "no"}, Min=${cfg?.minNewTasks ?? 1}, Max=${cfg?.maxNewTasks ?? 2}`,
    );
    return;
  }

  await sendReply(chatId, "Usage: /autobacklog [status|on|off|min <n>|max <n>]");
}

async function cmdRequirements(chatId, args) {
  const executor = _getInternalExecutor?.();
  if (!executor) {
    await sendReply(chatId, ":alert: Internal executor is not available.");
    return;
  }
  const profiles = [
    "simple-feature",
    "feature",
    "large-feature",
    "system",
    "multi-system",
  ];
  const input = String(args || "").trim();
  if (!input) {
    const req = executor.getProjectRequirements?.() || {
      profile: "feature",
      notes: "",
    };
    await sendReply(
      chatId,
      [
        ":ruler: Project Requirements",
        "",
        `Profile: ${req.profile || "feature"}`,
        `Notes: ${req.notes || "(none)"}`,
        "",
        "Usage:",
        "  /requirements <simple-feature|feature|large-feature|system|multi-system>",
      ].join("\n"),
    );
    return;
  }

  const profile = input.toLowerCase();
  if (!profiles.includes(profile)) {
    await sendReply(
      chatId,
      `:close: Unknown requirements profile: ${input}\nValid: ${profiles.join(", ")}`,
    );
    return;
  }

  const req = executor.setProjectRequirements?.({ profile });
  await sendReply(
    chatId,
    `:check: Project requirements profile set to ${req?.profile || profile}`,
  );
}

async function cmdThreads(chatId, subArg) {
  if (subArg) {
    const parts = subArg.trim().split(/\s+/);
    const sub = parts[0]?.toLowerCase();
    if (sub === "clear") {
      const confirmed = parts.slice(1).some((p) => p === "--confirm");
      if (!confirmed) {
        await sendReply(
          chatId,
          ":alert: This will clear all thread records. Proceed?",
          {
            reply_markup: buildConfirmKeyboard(
              "cb:confirm_threads_clear",
              "Confirm Clear",
            ),
          },
        );
        return;
      }
      await harnessApi.clearThreads();
      await sendReply(chatId, ":check: Thread registry cleared.");
      return;
    }
  }

  if (subArg && subArg.trim().toLowerCase().startsWith("kill ")) {
    const tokens = subArg.trim().split(/\s+/);
    const taskKey = tokens.slice(1).find((t) => !t.startsWith("--")) || "";
    const confirmed = tokens.includes("--confirm");
    if (!taskKey) {
      await sendReply(chatId, "Usage: /threads kill <taskKey>");
      return;
    }
    if (!confirmed) {
      const token = issueUiToken({
        type: "confirm_cmd",
        command: `/threads kill ${taskKey} --confirm`,
        title: "Invalidate Thread",
        confirmLabel: "Invalidate",
        detailLines: [`Task Key: \`${taskKey}\``],
        backAction: uiGoAction("threads_kill"),
      });
      await promptActionConfirm(chatId, token, {
        type: "confirm_cmd",
        title: "Invalidate Thread",
        confirmLabel: "Invalidate",
        detailLines: [`Task Key: \`${taskKey}\``],
        backAction: uiGoAction("threads_kill"),
      });
      return;
    }
    await harnessApi.invalidateThread(taskKey);
    await sendReply(chatId, `:check: Thread for "${taskKey}" invalidated.`);
    return;
  }

  const threadsPayload = await harnessApi.listThreads().catch(() => ({ items: [] }));
  const threads = Array.isArray(threadsPayload?.items) ? threadsPayload.items : [];
  if (threads.length === 0) {
    await sendReply(
      chatId,
      ":link: No active agent threads.\n\nThreads are created when tasks run via the agent pool with thread persistence.",
    );
    return;
  }

  const lines = [`:link: Active Agent Threads (${threads.length})`, ""];

  for (const t of threads) {
    const ageMin = Math.round(t.age / 60_000);
    lines.push(
      `• ${t.taskKey}`,
      `  SDK: ${t.sdk} | Turns: ${t.turnCount} | Age: ${ageMin}m`,
      `  Thread: ${t.threadId ? t.threadId.slice(0, 12) + "…" : "(none)"}`,
      "",
    );
  }

  lines.push(
    "Commands:",
    "  /threads clear          Clear all thread records",
    "  /threads kill <taskKey>  Invalidate a specific thread",
  );

  await sendReply(chatId, lines.join("\n"));
}

/**
 * /worktrees — View and manage git worktrees.
 *
 * Subcommands:
 *   /worktrees           — Show all active worktrees with branch, task, age
 *   /worktrees stats     — Show aggregate statistics
 *   /worktrees prune     — Prune stale/orphaned worktrees
 *   /worktrees release <taskKey> — Release a specific worktree by task key
 */
async function cmdWorktrees(chatId, args) {
  const parts = args ? args.trim().split(/\s+/) : [];
  const sub = parts[0]?.toLowerCase();

  if (sub === "prune") {
    const confirmed = parts.slice(1).some((p) => p === "--confirm");
    if (!confirmed) {
      const token = issueUiToken({
        type: "confirm_cmd",
        command: "/worktrees prune --confirm",
        title: "Prune Worktrees",
        confirmLabel: "Prune",
        detailLines: ["This removes stale/orphaned worktrees from disk."],
        backAction: uiGoAction("worktrees"),
      });
      await promptActionConfirm(chatId, token, {
        type: "confirm_cmd",
        title: "Prune Worktrees",
        confirmLabel: "Prune",
        detailLines: ["This removes stale/orphaned worktrees from disk."],
        backAction: uiGoAction("worktrees"),
      });
      return;
    }
    // Prune stale worktrees
    try {
      const result = await pruneStaleWorktrees(repoRoot);
      const lines = [`:trash: Worktree prune complete:`];
      lines.push(`  Pruned: ${result.pruned}`);
      lines.push(`  Registry evicted: ${result.evicted}`);
      await sendReply(chatId, lines.join("\n"));
    } catch (err) {
      await sendReply(chatId, `:close: Prune failed: ${err.message}`);
    }
    return;
  }

  if (sub === "release") {
    const taskKey = parts[1];
    if (!taskKey) {
      await sendReply(chatId, "Usage: /worktrees release <taskKey>");
      return;
    }
    const confirmed = parts.slice(2).some((p) => p === "--confirm");
    if (!confirmed) {
      const token = issueUiToken({
        type: "confirm_cmd",
        command: `/worktrees release ${taskKey} --confirm`,
        title: "Release Worktree",
        confirmLabel: "Release",
        detailLines: [`Task Key: \`${taskKey}\``],
        backAction: uiGoAction("worktrees_release"),
      });
      await promptActionConfirm(chatId, token, {
        type: "confirm_cmd",
        title: "Release Worktree",
        confirmLabel: "Release",
        detailLines: [`Task Key: \`${taskKey}\``],
        backAction: uiGoAction("worktrees_release"),
      });
      return;
    }
    try {
      const wm = getWorktreeManager(repoRoot);
      const result = wm.releaseWorktree(taskKey);
      if (result.success) {
        await sendReply(
          chatId,
          `:check: Released worktree for "${taskKey}": ${result.path}`,
        );
      } else {
        await sendReply(
          chatId,
          `:alert: No worktree found for task key "${taskKey}"`,
        );
      }
    } catch (err) {
      await sendReply(chatId, `:close: Release failed: ${err.message}`);
    }
    return;
  }

  if (sub === "stats") {
    try {
      const stats = getWorktreeStats();
      const lines = [`:chart: Worktree Stats:`];
      lines.push(`  Total tracked: ${stats.total}`);
      lines.push(`  Active: ${stats.active}`);
      lines.push(`  Stale: ${stats.stale}`);
      if (Object.keys(stats.byOwner).length > 0) {
        lines.push(`  By owner:`);
        for (const [owner, count] of Object.entries(stats.byOwner)) {
          lines.push(`    ${owner}: ${count}`);
        }
      }
      await sendReply(chatId, lines.join("\n"));
    } catch (err) {
      await sendReply(chatId, `:close: Stats failed: ${err.message}`);
    }
    return;
  }

  // Default: list all active worktrees
  try {
    const worktrees = listManagedWorktrees(repoRoot);
    if (!worktrees || worktrees.length === 0) {
      await sendReply(chatId, ":git: No active worktrees tracked.");
      return;
    }

    const lines = [`:git: Active Worktrees (${worktrees.length}):\n`];
    for (const wt of worktrees) {
      const ageMin = Math.round((wt.age || 0) / 60000);
      const ageStr =
        ageMin >= 60 ? `${Math.round(ageMin / 60)}h` : `${ageMin}m`;
      const branch = wt.branch || "(detached)";
      const taskKey = wt.taskKey ? ` [${wt.taskKey}]` : "";
      const owner = wt.owner ? ` (${wt.owner})` : "";
      const status = wt.status || "active";
      lines.push(`• ${branch}${taskKey}${owner}`);
      lines.push(`  Status: ${status} | Age: ${ageStr}`);
      lines.push(`  Path: ${wt.path}`);
    }

    lines.push(
      `\nCommands: /worktrees prune | /worktrees release <key> | /worktrees stats`,
    );
    await sendReply(chatId, lines.join("\n"));
  } catch (err) {
    await sendReply(chatId, `:close: Worktree list failed: ${err.message}`);
  }
}

/**
 * /executor — View and manage the internal task executor.
 *
 * Subcommands:
 *   /executor           — Show status (mode, active slots, SDK, etc.)
 *   /executor status    — Same as above
 *   /executor slots     — Show active task slots with details
 *   /executor mode <internal|hybrid> — Show current mode (runtime switch not supported)
 */
async function cmdExecutor(chatId, args) {
  const parts = args ? args.trim().split(/\s+/) : [];
  const sub = parts[0]?.toLowerCase();

  // Get monitor functions for executor access
  const executor = _getInternalExecutor?.();
  const mode = _getExecutorMode?.() || "internal";

  if (sub === "slots") {
    if (!executor) {
      await sendReply(
        chatId,
        `:settings: Internal executor not active (mode: ${mode})`,
      );
      return;
    }
    const status = executor.getStatus();
    if (status.slots.length === 0) {
      await sendReply(
        chatId,
        `:settings: No active task slots (${status.activeSlots}/${status.maxParallel} used)`,
      );
      return;
    }
    const lines = [
      `:settings: Active Task Slots (${status.activeSlots}/${status.maxParallel}):\n`,
    ];
    for (const slot of status.slots) {
      const runStr = formatRuntimeSeconds(slot.runningFor);
      const agentId =
        Number.isFinite(slot.agentInstanceId) && slot.agentInstanceId > 0
          ? `#${slot.agentInstanceId}`
          : "n/a";
      lines.push(`• ${slot.taskTitle}`);
      lines.push(
        `  ID: ${slot.taskId.substring(0, 8)} | Agent: ${agentId} | SDK: ${slot.sdk}`,
      );
      lines.push(`  Branch: ${slot.branch}`);
      lines.push(
        `  Running: ${runStr} | Attempt: ${slot.attempt} | Status: ${slot.status}`,
      );
    }
    await sendReply(chatId, lines.join("\n"));
    return;
  }

  if (sub === "mode") {
    const target = parts[1]?.toLowerCase();
    if (target && ["internal", "hybrid"].includes(target)) {
      await sendReply(
        chatId,
        `:settings: Current mode: ${mode}\n` +
          `:help: Mode can be changed via EXECUTOR_MODE env var or config.\n` +
          `Restart the monitor after changing to apply.`,
      );
    } else {
      await sendReply(
        chatId,
        `:settings: Current executor mode: ${mode}\n\nValid modes: internal, hybrid`,
      );
    }
    return;
  }

  // Default: show status
  const lines = [`:settings: Executor Status\n`];
  lines.push(`Mode: ${mode}`);

  if (executor) {
    const status = executor.getStatus();
    lines.push(`Running: ${status.running ? ":check: Yes" : ":close: No"}`);
    lines.push(`SDK: ${status.sdk}`);
    lines.push(`Active Slots: ${status.activeSlots}/${status.maxParallel}`);
    lines.push(`Poll Interval: ${status.pollIntervalMs / 1000}s`);
    lines.push(`Task Timeout: ${Math.round(status.taskTimeoutMs / 60000)}min`);
    lines.push(`Max Retries: ${status.maxRetries}`);
    lines.push(`Cooldowns: ${status.cooldowns}`);
    if (status.projectId) {
      lines.push(`Project ID: ${status.projectId.substring(0, 8)}...`);
    }
  } else {
    lines.push(`Internal executor: not active`);
  }

  lines.push(`\nCommands: /executor slots | /executor mode`);
  await sendReply(chatId, lines.join("\n"));
}

async function cmdSdk(chatId, sdkArg) {
  if (!sdkArg || sdkArg.trim() === "") {
    const selectionPayload = await harnessApi.getProviderSelection().catch(() => ({ selection: {} }));
    const selection = selectionPayload?.selection || {};
    const poolSdk = selection.poolSdk || "(unknown)";
    const primaryAgent = selection.primaryAgent || "(unknown)";
    const available = Array.isArray(selection.availableSdks) ? selection.availableSdks : [];
    const lines = [
      ":plug: Agent SDK Status",
      "",
      `Pool SDK: ${poolSdk}`,
      `Primary Agent: ${primaryAgent}`,
      `Available: ${available.join(", ") || "(none)"}`,
      "",
      "Switch SDK:",
      "  /sdk copilot    Use Copilot SDK",
      "  /sdk codex      Use Codex SDK",
      "  /sdk claude     Use Claude SDK",
      "  /sdk auto       Reset to config default",
    ];
    await sendReply(chatId, lines.join("\n"));
    return;
  }

  const target = sdkArg.trim().toLowerCase().replace(/-sdk$/, "");

  if (target === "auto" || target === "reset") {
    await harnessApi.setProviderSelection("auto");
    const selectionPayload = await harnessApi.getProviderSelection().catch(() => ({ selection: {} }));
    await sendReply(
      chatId,
      ":check: Agent pool SDK reset to config default.\nCurrent: " +
        (selectionPayload?.selection?.poolSdk || "(unknown)"),
    );
    return;
  }

  const validSdks = ["codex", "copilot", "claude"];
  if (!validSdks.includes(target)) {
    await sendReply(
      chatId,
      `Unknown SDK: ${target}\nValid: ${validSdks.join(", ")}, auto`,
    );
    return;
  }

  try {
    const result = await harnessApi.setProviderSelection(target);
    const selection = result?.selection || {};
    const switchResult = result?.switchResult || null;
    const primaryStatus = switchResult?.ok === false
      ? `Primary agent switch failed: ${switchResult.reason}`
      : `Primary agent: ${selection.primaryAgent || switchResult?.name || "(unknown)"}`;

    await sendReply(
      chatId,
      `:check: SDK switched to: ${target}\nPool SDK: ${selection.poolSdk || target}\n${primaryStatus}`,
    );
  } catch (err) {
    await sendReply(chatId, `:close: Error switching SDK: ${err.message}`);
  }
}

async function cmdSharedWorkspaces(chatId, rawArgs) {
  const registry = await loadSharedRegistry();
  const sweep = await sweepSharedLeases({
    registry,
    actor: `telegram:${chatId}`,
  });
  const tokens = splitArgs(rawArgs);
  if (tokens.length > 0) {
    const workspace = resolveSharedWorkspace(sweep.registry, tokens[0]);
    if (!workspace) {
      await sendReply(chatId, `Unknown shared workspace '${tokens[0]}'.`);
      return;
    }
    await sendReply(chatId, formatSharedWorkspaceDetail(workspace));
    return;
  }
  await sendReply(chatId, formatSharedWorkspaceSummary(sweep.registry));
}

async function cmdSharedWorkspaceClaim(chatId, rawArgs) {
  const parsed = parseSharedWorkspaceArgs(rawArgs);
  if (!parsed.workspaceId) {
    await sendReply(
      chatId,
      "Usage: /claim <id> [--owner <id>] [--ttl <minutes>] [--note <text>]",
    );
    return;
  }
  const actor = `telegram:${chatId}`;
  const owner = parsed.owner || actor;
  const result = await claimSharedWorkspace({
    workspaceId: parsed.workspaceId,
    owner,
    ttlMinutes: parsed.ttlMinutes,
    note: parsed.note,
    force: parsed.force,
    actor,
  });
  if (result.error) {
    await sendReply(chatId, `:close: ${result.error}`);
    return;
  }
  await sendReply(
    chatId,
    `:check: Claimed ${result.workspace.id} for ${result.lease.owner} (expires ${result.lease.lease_expires_at})`,
  );
}

async function cmdSharedWorkspaceRelease(chatId, rawArgs) {
  const parsed = parseSharedWorkspaceArgs(rawArgs);
  if (!parsed.workspaceId) {
    await sendReply(
      chatId,
      "Usage: /release <id> [--owner <id>] [--reason <text>] [--force]",
    );
    return;
  }
  if (!parsed.force) {
    const token = issueUiToken({
      type: "confirm_cmd",
      command: `/release ${parsed.workspaceId} --force`,
      title: "Release Shared Workspace",
      confirmLabel: "Release",
      detailLines: [
        `Workspace: \`${parsed.workspaceId}\``,
        parsed.owner ? `Owner: \`${parsed.owner}\`` : null,
      ].filter(Boolean),
      backAction: uiGoAction("shared_release"),
    });
    await promptActionConfirm(chatId, token, {
      type: "confirm_cmd",
      title: "Release Shared Workspace",
      confirmLabel: "Release",
      detailLines: [
        `Workspace: \`${parsed.workspaceId}\``,
        parsed.owner ? `Owner: \`${parsed.owner}\`` : null,
      ].filter(Boolean),
      backAction: uiGoAction("shared_release"),
    });
    return;
  }
  const actor = `telegram:${chatId}`;
  const result = await releaseSharedWorkspace({
    workspaceId: parsed.workspaceId,
    owner: parsed.owner,
    reason: parsed.reason,
    force: parsed.force,
    actor,
  });
  if (result.error) {
    await sendReply(chatId, `:close: ${result.error}`);
    return;
  }
  await sendReply(chatId, `:check: Released ${result.workspace.id}`);
}

// ── /agent — route to workspace registry ────────────────────────────────────

const MODEL_PROFILE_MAP = {
  "gpt-5.2-codex": {
    executor: "CODEX",
    variant: "DEFAULT",
    model: "gpt-5.2-codex",
  },
  "gpt-5.1-codex-max": {
    executor: "CODEX",
    variant: "DEFAULT",
    model: "gpt-5.1-codex-max",
  },
  "gpt-5.1-codex-mini": {
    executor: "CODEX",
    variant: "DEFAULT",
    model: "gpt-5.1-codex-mini",
  },
  "claude-opus-4.6": {
    executor: "COPILOT",
    variant: "CLAUDE_OPUS_4_6",
    model: "claude-opus-4.6",
  },
  "claude-code": {
    executor: "COPILOT",
    variant: "CLAUDE_CODE",
    model: "claude-code",
  },
};

function normalizeHost(host) {
  if (!host) return null;
  const trimmed = String(host).trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function buildExecutorProfile(model, customProfile) {
  if (customProfile && typeof customProfile === "object") {
    const profile = { ...customProfile };
    if (model && !profile.model) profile.model = model;
    return profile;
  }
  if (!model) return null;
  return MODEL_PROFILE_MAP[model] || { model };
}

function resolveModelSelection(workspace, preferredModel) {
  const priorities = Array.isArray(workspace.model_priority)
    ? workspace.model_priority
    : getDefaultModelPriority();
  const candidates = [];
  if (preferredModel) candidates.push(preferredModel);
  candidates.push(...priorities);

  for (const entry of candidates) {
    if (!entry) continue;
    if (typeof entry === "string") {
      const model = entry.trim();
      if (!model) continue;
      return { model, profile: buildExecutorProfile(model) };
    }
    if (typeof entry === "object") {
      const model = entry.model || entry.name || null;
      const profile = buildExecutorProfile(model, entry);
      if (profile) {
        return { model: model || profile.model || null, profile };
      }
    }
  }
  return { model: null, profile: null };
}

const harnessApi = createTelegramHarnessApiClient((path, options = {}) => {
  const request = getTelegramUiRuntime().request;
  if (typeof request !== "function") {
    throw new Error("Bosun UI server is not available.");
  }
  return request(path, options);
});
const workspaceApi = createTelegramWorkspaceApiClient((host, path, options = {}) =>
  requestTelegramJsonApi(normalizeHost(host), path, {
    ...options,
    unwrapData: true,
    errorPrefix: "Workspace API",
  }));

async function getWorkspaceSummaries(host) {
  const data = await workspaceApi.listTaskAttemptSummaries(host, {
    archived: false,
  });
  if (!data) return [];
  if (Array.isArray(data.summaries)) return data.summaries;
  return Array.isArray(data) ? data : [data];
}

function scoreWorkspace(summary) {
  const status = String(
    summary?.latest_process_status ?? summary?.status ?? summary?.state ?? "",
  ).toLowerCase();
  const busy = ["running", "queued", "in_progress", "active"];
  const idle = ["completed", "idle", "success", "done"];
  const failed = ["failed", "error", "crashed", "killed", "aborted"];
  if (busy.includes(status)) {
    return { available: false, score: 0, status: "busy" };
  }
  if (idle.includes(status)) {
    return { available: true, score: 3, status: "healthy" };
  }
  if (failed.includes(status)) {
    return { available: true, score: 1, status: "degraded" };
  }
  return { available: true, score: 2, status: status || "unknown" };
}

async function getWorkspaceHealth(workspaces) {
  const health = new Map();
  const hostMap = new Map();
  for (const ws of workspaces) {
    const host = normalizeHost(ws.host);
    if (!host) {
      health.set(ws.id, { available: true, score: 1, status: "unknown" });
      continue;
    }
    if (!hostMap.has(host)) hostMap.set(host, []);
    hostMap.get(host).push(ws);
  }

  for (const [host, wsList] of hostMap.entries()) {
    let summaries = [];
    try {
      summaries = await getWorkspaceSummaries(host);
    } catch {
      for (const ws of wsList) {
        health.set(ws.id, { available: true, score: 1, status: "unknown" });
      }
      continue;
    }

    const summaryMap = new Map();
    for (const summary of summaries) {
      if (summary?.workspace_id) {
        summaryMap.set(summary.workspace_id, summary);
      }
    }
    for (const ws of wsList) {
      const summary = summaryMap.get(ws.id);
      if (summary) {
        const scored = scoreWorkspace(summary);
        const last = Date.parse(
          summary.latest_process_completed_at ||
            summary.latest_process_started_at ||
            summary.updated_at ||
            "",
        );
        health.set(ws.id, {
          ...scored,
          lastCompletedAt: Number.isFinite(last) ? last : null,
        });
      } else {
        health.set(ws.id, { available: true, score: 1, status: "unknown" });
      }
    }
  }

  return health;
}

function selectWorkspace(candidates, healthMap, options = {}) {
  const { preferredId } = options;
  const scored = candidates.map((ws) => {
    const h = healthMap.get(ws.id) || {
      available: true,
      score: 1,
      status: "unknown",
    };
    return { ws, health: h };
  });

  const sortFn = (a, b) => {
    const scoreDiff = (b.health.score ?? 0) - (a.health.score ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    const lastA = a.health.lastCompletedAt || 0;
    const lastB = b.health.lastCompletedAt || 0;
    return lastB - lastA;
  };

  if (preferredId) {
    const target = scored.find((item) => item.ws.id === preferredId);
    if (target && target.health.available) {
      return { workspace: target.ws, health: target.health };
    }
    const fallback = scored.sort(sortFn)[0];
    return {
      workspace: fallback?.ws || null,
      health: fallback?.health || null,
      fallbackFrom: target?.ws || null,
    };
  }

  const best = scored.sort(sortFn)[0];
  return { workspace: best?.ws || null, health: best?.health || null };
}

function rankWorkspaceCandidates(candidates, healthMap, options = {}) {
  const { preferredId } = options;
  const scored = candidates.map((ws) => {
    const h = healthMap.get(ws.id) || {
      available: true,
      score: 1,
      status: "unknown",
    };
    return { ws, health: h };
  });

  const sortFn = (a, b) => {
    const scoreDiff = (b.health.score ?? 0) - (a.health.score ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    const lastA = a.health.lastCompletedAt || 0;
    const lastB = b.health.lastCompletedAt || 0;
    return lastB - lastA;
  };

  const sorted = scored.sort(sortFn).map((item) => item.ws);
  if (!preferredId) return sorted;
  const preferred = scored.find((item) => item.ws.id === preferredId);
  if (!preferred) return sorted;
  return [
    preferred.ws,
    ...sorted.filter((candidate) => candidate.id !== preferred.ws.id),
  ];
}

function pickLatestSession(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  return [...sessions].sort((a, b) => {
    const ta = Date.parse(a.updated_at || a.created_at || 0) || 0;
    const tb = Date.parse(b.updated_at || b.created_at || 0) || 0;
    return tb - ta;
  })[0];
}

async function dispatchAgentMessage(workspace, message, options = {}) {
  const host = normalizeHost(workspace.host);
  const executorProfile = options.executorProfile || null;
  const sessions = await workspaceApi.listSessions(host, workspace.id);
  let session = pickLatestSession(sessions);
  let created = false;

  if (!session || options.newSession) {
    session = await workspaceApi.createSession(host, workspace.id);
    created = true;
  }
  if (!session?.id) {
    throw new Error("Failed to acquire workspace session.");
  }

  if (options.queue) {
    await workspaceApi.queueSessionMessage(host, session.id, {
      message,
      executor_profile_id: executorProfile || undefined,
    });
    return { sessionId: session.id, created, action: "queued" };
  }

  await workspaceApi.sendFollowUp(host, session.id, {
    prompt: message,
    executor_profile_id: executorProfile || undefined,
  });
  return { sessionId: session.id, created, action: "follow-up" };
}

async function cmdAgent(chatId, rawArgs) {
  const parsed = parseAgentArgs(rawArgs || "");
  const { message, workspaceId, role, model, queue, newSession, dryRun } =
    parsed;

  const { registry, errors, warnings } = await loadWorkspaceRegistry();
  const diagnostics = formatRegistryDiagnostics(errors, warnings);
  if (diagnostics) {
    await sendReply(chatId, diagnostics);
  }

  if (!message) {
    const list = registry.workspaces
      .map((ws) => `  - ${ws.id} (${ws.role})`)
      .join("\n");
    const usage = [
      "Usage: /agent --workspace <id> <task>",
      "       /agent --role <role> <task>",
      "Options: --model <name> --queue --new-session --dry-run",
      "",
      "Available workspaces:",
      list || "  (none)",
    ];
    await sendReply(chatId, usage.join("\n"));
    return;
  }

  if (!registry.workspaces.length) {
    await sendReply(chatId, "No workspaces available to route.");
    return;
  }

  let candidates = registry.workspaces;
  let preferredId = null;

  if (workspaceId) {
    const match = registry.workspaces.find(
      (ws) => ws.id.toLowerCase() === workspaceId.toLowerCase(),
    );
    if (!match) {
      const ids = registry.workspaces.map((ws) => ws.id).join(", ");
      await sendReply(
        chatId,
        `Unknown workspace: ${workspaceId}\nAvailable: ${ids}`,
      );
      return;
    }
    candidates = [match];
    preferredId = match.id;
  } else if (role) {
    const roleLower = role.toLowerCase();
    candidates = registry.workspaces.filter(
      (ws) => ws.role && ws.role.toLowerCase() === roleLower,
    );
    if (candidates.length === 0) {
      await sendReply(chatId, `No workspaces found with role: ${role}`);
      return;
    }
  } else {
    const primary = registry.workspaces.filter(
      (ws) => (ws.role || "").toLowerCase() === "primary",
    );
    if (primary.length > 0) {
      candidates = primary;
    }
  }

  const leaseOwner =
    process.env.VE_WORKSPACE_OWNER ||
    process.env.USER ||
    process.env.USERNAME ||
    `telegram:${chatId}`;
  const leaseTtlSecRaw = Number(process.env.VE_WORKSPACE_LEASE_TTL_SEC || "");
  const leaseTtlMinRaw = Number(process.env.VE_WORKSPACE_LEASE_TTL_MIN || "");
  const leaseTtlMinutes = Number.isFinite(leaseTtlMinRaw)
    ? leaseTtlMinRaw
    : Number.isFinite(leaseTtlSecRaw)
      ? Math.ceil(leaseTtlSecRaw / 60)
      : null;

  let availabilityMap = new Map();
  try {
    const registry = await loadSharedRegistry();
    const sweep = await sweepSharedLeases({ registry, actor: leaseOwner });
    availabilityMap = getSharedAvailabilityMap(sweep.registry);
  } catch {
    availabilityMap = new Map();
  }

  if (availabilityMap.size > 0) {
    const filtered = candidates.filter((ws) => {
      const entry = availabilityMap.get(ws.id);
      if (!entry) return true;
      const state = String(entry.state || "available").toLowerCase();
      return state === "available";
    });
    if (filtered.length === 0) {
      await sendReply(
        chatId,
        "No available workspaces found (all leased or unavailable).",
      );
      return;
    }
    candidates = filtered;
  }

  const healthMap = await getWorkspaceHealth(candidates);
  const ranked = rankWorkspaceCandidates(candidates, healthMap, {
    preferredId,
  });
  const preferredMatch = preferredId
    ? candidates.find((ws) => ws.id === preferredId)
    : null;

  let selectedWorkspace = null;
  let selectedHealth = null;
  let leaseError = null;

  for (const candidate of ranked) {
    if (dryRun) {
      selectedWorkspace = candidate;
      selectedHealth = healthMap.get(candidate.id) || null;
      break;
    }
    try {
      const claimResult = await claimSharedWorkspace({
        workspaceId: candidate.id,
        owner: leaseOwner,
        ttlMinutes: leaseTtlMinutes,
        note: `telegram:${chatId}`,
        actor: leaseOwner,
      });
      if (claimResult?.error) {
        throw new Error(claimResult.error);
      }
      selectedWorkspace = candidate;
      selectedHealth = healthMap.get(candidate.id) || null;
      break;
    } catch (err) {
      leaseError = err;
    }
  }

  if (!selectedWorkspace) {
    await sendReply(
      chatId,
      leaseError?.message || "No available workspace found for routing.",
    );
    return;
  }

  const selection = {
    workspace: selectedWorkspace,
    health: selectedHealth,
    fallbackFrom:
      preferredMatch && preferredMatch.id !== selectedWorkspace.id
        ? preferredMatch
        : null,
  };

  const modelSelection = resolveModelSelection(selection.workspace, model);
  const selectedModel = modelSelection.model || model || "auto";

  const infoLines = [
    `Routing → ${selection.workspace.name} (${selection.workspace.id})`,
    `Role: ${selection.workspace.role || "n/a"}`,
    `Host: ${normalizeHost(selection.workspace.host) || "n/a"}`,
    `Model: ${selectedModel}`,
  ];
  if (selection.fallbackFrom) {
    infoLines.push(`Fallback: ${selection.fallbackFrom.id} unavailable`);
  }

  if (dryRun) {
    infoLines.push("Dry-run only. No message sent.");
    await sendReply(chatId, infoLines.join("\\n"));
    return;
  }

  try {
    const result = await dispatchAgentMessage(selection.workspace, message, {
      executorProfile: modelSelection.profile,
      queue,
      newSession,
    });
    infoLines.push(`Action: ${result.action}`);
    infoLines.push(
      `Session: ${result.sessionId}${result.created ? " (new)" : ""}`,
    );
    await sendReply(chatId, infoLines.join("\\n"));
  } catch (err) {
    await sendReply(
      chatId,
      `:close: /agent failed: ${err.message || err}\n${infoLines.join("\\n")}`,
    );
  }
}

// ── /background — run task silently or background active agent ────────────────

async function cmdBackground(chatId, args) {
  const task = (args || "").trim();
  if (task) {
    await sendReply(
      chatId,
      `:server: Background task queued: "${task.slice(0, 80)}${task.length > 80 ? "…" : ""}"`,
    );
    safeDetach("background-free-text", () => handleFreeText(task, chatId, { background: true, isolated: true }));
    return;
  }

  const session = getActiveAgentSession(chatId);
  if (!session) {
    await sendReply(
      chatId,
      "No active agent. Usage:\n/background <task>\n(background current agent with /background)",
    );
    return;
  }

  session.background = true;
  session.suppressEdits = true;

  if (session.messageId && session.chatId) {
    try {
      await deleteDirect(session.chatId, session.messageId);
    } catch {
      /* best effort */
    }
  }
  session.messageId = null;
  if (agentChatId === String(chatId)) {
    agentMessageId = null;
    agentChatId = null;
  }

  await sendReply(
    chatId,
    ":server: Background mode enabled for the active agent. I will post a final summary when it completes. Use /stop to cancel or /steer to adjust context.",
  );
}

// ── /stop — Stop Running Agent ───────────────────────────────────────────────

async function cmdStop(chatId, args) {
  const confirmFlag = /--confirm\b/i.test(String(args || ""));
  if (!confirmFlag) {
    await sendReply(
      chatId,
      ":alert: Stop will halt the active agent session. Proceed?",
      { reply_markup: buildConfirmKeyboard("cb:confirm_stop", "Confirm Stop") },
    );
    return;
  }
  const session = getActiveAgentSession(chatId);
  if (!session) {
    await sendReply(chatId, "No agent is currently running.");
    return;
  }
  session.aborted = true;
  if (session.sessionId) {
    await harnessApi.stopSession(session.sessionId).catch(() => null);
  }
  if (session.actionLog) {
    session.actionLog.push({
      icon: ":close:",
      text: "Stop requested by user (session stop sent to harness API)",
    });
    if (session.scheduleEdit) {
      session.scheduleEdit();
    }
  }
  await sendReply(chatId, ":close: Stop signal sent. Agent will halt and wait.");
}

// ── /steer — Steering update for running agent ───────────────────────────────

async function cmdSteer(chatId, steerArgs) {
  if (!steerArgs || !steerArgs.trim()) {
    await sendReply(chatId, "Usage: /steer <update or correction>");
    return;
  }
  const message = steerArgs.trim();

  const session = getActiveAgentSession(chatId);
  if (!session) {
    await sendReply(chatId, "No active agent. Sending as a new task.");
    await handleFreeText(message, chatId);
    return;
  }
  if (session.running !== true) {
    await sendReply(chatId, "No active turn is running. Sending the update through the existing harness session.");
    await handleFreeText(message, chatId, { reuseSessionId: session.sessionId });
    return;
  }

  if (!session.followUpQueue) {
    session.followUpQueue = [];
  }
  session.followUpQueue.push(message);
  const qLen = session.followUpQueue.length;
  if (session.actionLog) {
    session.actionLog.push({
      icon: ":compass:",
      text: `Follow-up queued for canonical session (#${qLen})`,
      kind: "followup_queued",
      steerStatus: "queued",
    });
    if (session.scheduleEdit) {
      session.scheduleEdit();
    }
  }
  await sendReply(chatId, `:compass: Steering queued (#${qLen}).`);
}

// ── Free-text → Primary Agent Dispatch ───────────────────────────────────────

/**
 * Build the rolling summary message text from accumulated action log.
 * This is the single message that gets continuously edited in Telegram.
 */
function suppressSteerFailedLines(actionLog) {
  if (!Array.isArray(actionLog)) return;
  for (let i = actionLog.length - 1; i >= 0; i -= 1) {
    const entry = actionLog[i];
    if (!entry || entry.kind !== "followup_queued") continue;
    if (entry.steerStatus && entry.steerStatus !== "ok") {
      actionLog.splice(i, 1);
    }
  }
}

function buildStreamMessage({
  taskPreview,
  actionLog,
  currentThought,
  totalActions,
  phase,
  finalResponse,
  filesRead,
  filesWritten,
  searchesDone,
  statusIcon,
}) {
  const header = `:settings: Agent: ${taskPreview}`;
  const counter = `:chart: Actions: ${totalActions} | ${phase}`;
  const separator = "────────────────────────────";

  // Show last N actions (keep message compact)
  const MAX_VISIBLE_ACTIONS = 20;
  const visibleActions = actionLog.slice(-MAX_VISIBLE_ACTIONS);
  const hiddenCount = actionLog.length - visibleActions.length;

  const lines = [header, counter, separator];

  if (hiddenCount > 0) {
    lines.push(`… ${hiddenCount} earlier action${hiddenCount > 1 ? "s" : ""}`);
  }

  for (const action of visibleActions) {
    lines.push(`${action.icon} ${action.text}`);
  }

  if (currentThought) {
    lines.push("", `:u1f4ad: ${currentThought}`);
  }

  if (!finalResponse) {
    if (filesWritten?.size) {
      lines.push("", ":edit: Files modified so far:");
      const recent = Array.from(filesWritten.entries()).slice(-6);
      for (const [fpath, info] of recent) {
        const name = shortPath(fpath);
        if (info.adds || info.dels) {
          lines.push(`  :edit: ${name} (+${info.adds} -${info.dels})`);
        } else {
          lines.push(`  :edit: ${name}`);
        }
      }
    }
    if (filesRead?.size) {
      lines.push("", ":file: Files read so far:");
      const recent = Array.from(filesRead.values()).slice(-6);
      for (const fpath of recent) {
        lines.push(`  :file: ${shortPath(fpath)}`);
      }
    }
    if (searchesDone) {
      lines.push("", `:search: Searches: ${searchesDone}`);
    }
  }

  if (finalResponse) {
    // ── Final summary block ──────────────────────────────────────
    const icon = statusIcon || ":check:";
    lines.push("", separator);
    lines.push(`${icon} ${phase}`);
    lines.push("");

    // Stats line
    const stats = [];
    if (filesRead?.size) stats.push(`${filesRead.size} files read`);
    if (filesWritten?.size) stats.push(`${filesWritten.size} files modified`);
    if (searchesDone) stats.push(`${searchesDone} searches`);
    if (stats.length) {
      lines.push(`:chart: ${stats.join(" · ")}`);
    }

    // Files modified detail
    if (filesWritten?.size) {
      lines.push("");
      lines.push(":folder: Files modified:");
      for (const [fpath, info] of filesWritten) {
        const name = shortPath(fpath);
        if (info.adds || info.dels) {
          lines.push(`  :edit: ${name} (+${info.adds} -${info.dels})`);
        } else {
          const kindIcon =
            info.kind === "add" ? ":plus:" : info.kind === "delete" ? ":trash:" : ":edit:";
          lines.push(`  ${kindIcon} ${name}`);
        }
      }
    }

    lines.push("");
    const inlineFinal = String(finalResponse || "").slice(
      0,
      STREAM_INLINE_FINAL_RESPONSE_MAX,
    );
    lines.push(inlineFinal);
    if (String(finalResponse || "").length > STREAM_INLINE_FINAL_RESPONSE_MAX) {
      lines.push("");
      lines.push(":page_facing_up: Full response continued in follow-up message(s).");
    }
  }

  return lines.join("\n");
}

async function sendFullAgentResponseIfTruncated(chatId, finalResponse, summaryText = "") {
  const responseText = String(finalResponse || "");
  if (!responseText) return;
  const summaryLen = String(summaryText || "").length;
  const needsFollowUp =
    responseText.length > STREAM_INLINE_FINAL_RESPONSE_MAX ||
    summaryLen > MAX_MESSAGE_LEN;
  if (!needsFollowUp) return;
  const fullText = `:speech_balloon: Agent full response:\n\n${responseText}`;
  await sendReply(chatId, fullText, { skipSticky: true });
}

async function handleFreeText(text, chatId, options = {}) {
  const backgroundMode = !!options.background;
  const isolatedMode = !!options.isolated;
  const reusedSessionId = String(options.reuseSessionId || "").trim();
  const chatSession = getActiveAgentSession(chatId);
  if (!isolatedMode && chatSession?.running === true) {
    if (!chatSession.followUpQueue) {
      chatSession.followUpQueue = [];
    }
    chatSession.followUpQueue.push(text);
    const qLen = chatSession.followUpQueue.length;
    await sendDirect(
      chatId,
      `:pin: Follow-up queued (#${qLen}). It will be delivered through the canonical session API after the current turn completes.`,
    );
    if (chatSession.actionLog) {
      chatSession.actionLog.push({
        icon: ":pin:",
        text: `Follow-up: "${text.length > 60 ? text.slice(0, 60) + "…" : text}"`,
        kind: "followup_queued",
        steerStatus: "queued",
      });
      if (chatSession.scheduleEdit) {
        chatSession.scheduleEdit();
      }
    }
    return;
  }

  const taskPreview = text.length > 60 ? text.slice(0, 60) + "…" : text;
  let messageId = null;
  if (!backgroundMode) {
    messageId = await sendDirect(
      chatId,
      buildStreamMessage({
        taskPreview,
        actionLog: [],
        currentThought: null,
        totalActions: 0,
        phase: "starting…",
        finalResponse: null,
      }),
    );
  }

  const actionLog = [];
  let totalActions = 0;
  let phase = "working…";
  let lastEditAt = 0;
  const EDIT_THROTTLE_MS = 2000;
  let editPending = false;
  let editTimer = null;

  const sessionState = {
    chatId,
    messageId,
    taskPreview,
    actionLog,
    totalActions: 0,
    phase,
    followUpQueue: [],
    aborted: false,
    background: backgroundMode,
    suppressEdits: backgroundMode,
    running: true,
    sessionId: reusedSessionId || toTrimmedString(chatSession?.sessionId || "") || null,
  };

  const doEdit = async () => {
    if (backgroundMode || sessionState.background) return;
    editPending = false;
    const msg = buildStreamMessage({
      taskPreview,
      actionLog,
      currentThought: null,
      totalActions,
      phase,
      finalResponse: null,
    });
    if (messageId) {
      messageId = await editDirect(chatId, messageId, msg);
      agentMessageId = messageId;
    }
    lastEditAt = Date.now();
  };

  const scheduleEdit = () => {
    if (backgroundMode || sessionState.background) return;
    if (editPending) return;
    const now = Date.now();
    const elapsed = now - lastEditAt;
    if (elapsed >= EDIT_THROTTLE_MS) {
      editPending = true;
      safeDetach("agent-edit", doEdit);
    } else {
      editPending = true;
      if (editTimer) clearTimeout(editTimer);
      editTimer = setTimeout(() => safeDetach("agent-edit", doEdit), EDIT_THROTTLE_MS - elapsed);
    }
  };

  sessionState.scheduleEdit = scheduleEdit;
  setActiveAgentSession(chatId, sessionState);
  agentMessageId = messageId;
  agentChatId = chatId;

  const messageToAction = (message = {}) => {
    const role = String(message?.role || message?.type || "event").toLowerCase();
    const textContent = String(message?.content || "").replace(/\s+/g, " ").trim();
    const clipped = textContent.length > 120 ? `${textContent.slice(0, 120)}…` : textContent;
    if (role === "assistant") return { icon: ":speech_balloon:", text: clipped || "Assistant response" };
    if (role === "user") return { icon: ":bust_in_silhouette:", text: clipped || "User input" };
    if (role === "error" || (role === "system" && /error|failed/i.test(textContent))) {
      return { icon: ":close:", text: clipped || "Runtime error" };
    }
    return { icon: ":gear:", text: clipped || `${message?.type || "event"}` };
  };

  const getPhaseFromStatus = (status) => {
    const normalized = String(status || "").trim().toLowerCase();
    if (normalized === "completed") return "Completed successfully";
    if (normalized === "failed") return "Failed — needs manual review";
    if (normalized === "paused") return "Paused";
    if (normalized === "archived") return "Archived";
    return "working…";
  };

  const getFinalResponseFromMessages = (messages = []) => {
    const assistantMessages = messages.filter((entry) => String(entry?.role || "").toLowerCase() === "assistant");
    return assistantMessages
      .slice(-3)
      .map((entry) => String(entry?.content || "").trim())
      .filter(Boolean)
      .join("\n\n");
  };

  const syncFromSessionDetail = async () => {
    if (!sessionState.sessionId) return null;
    const detail = await harnessApi.getSession(sessionState.sessionId).catch(() => null);
    if (!detail?.session) return null;
    const messages = Array.isArray(detail.session.messages) ? detail.session.messages : [];
    actionLog.splice(0, actionLog.length, ...messages.slice(-20).map(messageToAction));
    totalActions = messages.length;
    sessionState.totalActions = totalActions;
    sessionState.running = String(detail.session.status || "").trim().toLowerCase() === "active";
    phase = getPhaseFromStatus(detail.session.status);
    sessionState.phase = phase;
    scheduleEdit();
    return detail;
  };

  const waitForSessionTurn = async () => {
    while (!sessionState.aborted && sessionState.sessionId) {
      const detail = await syncFromSessionDetail();
      const status = String(detail?.session?.status || "").trim().toLowerCase();
      if (!status || status !== "active") {
        return detail;
      }
      await delayMs(1500);
    }
    return syncFromSessionDetail();
  };

  try {
    if (!sessionState.sessionId) {
      const created = await harnessApi.createSession({
        type: "primary",
        prompt: text,
        agent: "telegram",
        mode: isolatedMode ? "ask" : undefined,
      });
      sessionState.sessionId = String(created?.session?.id || "").trim() || null;
    }
    if (!sessionState.sessionId) {
      throw new Error("Failed to create a canonical session.");
    }

    const pendingInputs = [text];
    let finalDetail = null;
    while (!sessionState.aborted && (pendingInputs.length > 0 || sessionState.followUpQueue.length > 0)) {
      const nextInput = pendingInputs.length > 0
        ? pendingInputs.shift()
        : sessionState.followUpQueue.shift();
      if (!nextInput) continue;
      phase = pendingInputs.length > 0 ? "processing follow-up…" : "working…";
      scheduleEdit();
      await harnessApi.sendSessionMessage(sessionState.sessionId, {
        content: nextInput,
        mode: isolatedMode ? "ask" : undefined,
      });
      finalDetail = await waitForSessionTurn();
    }

    if (editTimer) clearTimeout(editTimer);
    finalDetail = finalDetail || await syncFromSessionDetail();
    const finalMessages = Array.isArray(finalDetail?.session?.messages) ? finalDetail.session.messages : [];
    const finalResponse = getFinalResponseFromMessages(finalMessages);
    const finalStatus = String(finalDetail?.session?.status || "").trim().toLowerCase();
    const statusIcon = finalStatus === "failed"
      ? ":close:"
      : finalStatus === "completed"
        ? ":check:"
        : ":help:";
    phase = getPhaseFromStatus(finalStatus || "completed");
    const finalMsg = buildStreamMessage({
      taskPreview,
      actionLog,
      currentThought: null,
      totalActions,
      phase,
      finalResponse: finalResponse || null,
      statusIcon,
    });
    if (backgroundMode || sessionState.background) {
      await sendReply(chatId, finalMsg);
    } else {
      const finalMessageId = await editDirect(chatId, messageId, finalMsg);
      if (finalMessageId) {
        scheduleStickyMenuBump(chatId, finalMessageId);
      }
    }
    await sendFullAgentResponseIfTruncated(chatId, finalResponse || "", finalMsg);
  } catch (err) {
    if (editTimer) clearTimeout(editTimer);
    const finalMsg = buildStreamMessage({
      taskPreview,
      actionLog,
      currentThought: null,
      totalActions,
      phase: "Failed — error during execution",
      finalResponse: `Error: ${err.message}`,
      statusIcon: ":close:",
    });
    if (backgroundMode || sessionState.background) {
      await sendReply(chatId, finalMsg);
    } else {
      const finalMessageId = await editDirect(chatId, messageId, finalMsg);
      if (finalMessageId) {
        scheduleStickyMenuBump(chatId, finalMessageId);
      }
    }
  } finally {
    sessionState.running = false;
    if (sessionState.sessionId) {
      setActiveAgentSession(chatId, sessionState);
    } else {
      clearActiveAgentSession(chatId, sessionState);
    }
  }
}

// ── Main Polling Loop ────────────────────────────────────────────────────────

async function pollLoop() {
  while (polling) {
    if (pollLockLostAtMs > 0) {
      const conflictState = readTelegramPollConflictState();
      const now = Date.now();
      if (conflictState && conflictState.untilMs > now) {
        const waitMs = Math.max(500, conflictState.untilMs - now);
        await delayMs(waitMs);
        continue;
      }

      const reacquired = await ensureTelegramPollOwnership();
      if (!reacquired) {
        await delayMs(pollLockRetryBackoffMs);
        pollLockRetryBackoffMs = Math.min(pollLockRetryBackoffMs * 2, 30_000);
        continue;
      }

      pollLockLostAtMs = 0;
      pollLockRetryBackoffMs = 2000;
      clearTelegramPollConflictState();
      console.log("[telegram-bot] polling ownership reacquired after conflict");
    }

    try {
      const updates = await pollUpdates();
      for (const update of updates) {
        lastUpdateId = Math.max(lastUpdateId, update.update_id);
        try {
          await handleUpdate(update);
        } catch (err) {
          console.error(
            `[telegram-bot] error handling update ${update.update_id}: ${err.message}`,
          );
        }
      }
    } catch (err) {
      console.error(`[telegram-bot] poll loop error: ${err.message}`);
      // Backoff before retrying
      await new Promise((r) => setTimeout(r, POLL_ERROR_BACKOFF_MS));
    }
  }
}

async function ensurePresenceReady() {
  if (presenceReady) return;
  const localWorkspace = await getLocalWorkspaceContext();
  await initPresence({
    repoRoot: _getRepoRoot ? _getRepoRoot() : repoRoot,
    localWorkspace,
  });
  presenceReady = true;
}

function startPresenceLoop() {
  if (presenceDisabled) return;
  if (!telegramToken || !presenceChatId) return;
  if (!Number.isFinite(presenceIntervalSec) || presenceIntervalSec <= 0) {
    return;
  }
  const intervalMs = presenceIntervalSec * 1000;
  let lastSentPayload = null;

  const sendPresence = async () => {
    try {
      await ensurePresenceReady();
      const child = _getCurrentChild ? _getCurrentChild() : null;
      const payload = buildLocalPresence({
        orchestrator_running: !!child,
        orchestrator_pid: child?.pid ?? null,
      });

      // Check if state changed significantly (ignore updated_at for comparison)
      const shouldSend =
        !presenceOnlyOnChange ||
        !lastSentPayload ||
        hasPresenceChanged(lastSentPayload, payload);

      // Always update local registry
      await notePresence(payload, {
        source: "local",
        receivedAt: payload.updated_at,
      });

      // Only send to Telegram if state changed or not configured to only-on-change
      if (shouldSend) {
        await sendDirect(presenceChatId, formatPresenceMessage(payload), {
          silent: presenceSilent,
        });
        lastSentPayload = payload;
      }
    } catch (err) {
      console.warn(
        `[telegram-bot] presence heartbeat error: ${err.message || err}`,
      );
    }
  };
  setTimeout(() => safeDetach("presence-heartbeat", sendPresence), intervalMs);
  setInterval(() => safeDetach("presence-heartbeat", sendPresence), intervalMs);
}

function hasPresenceChanged(prev, curr) {
  if (!prev || !curr) return true;
  // Compare meaningful fields (ignore timestamps)
  const significantFields = [
    "instance_id",
    "workspace_id",
    "workspace_role",
    "orchestrator_running",
    "orchestrator_pid",
    "git_branch",
    "git_sha",
    "coordinator_priority",
    "coordinator_eligible",
  ];
  for (const field of significantFields) {
    if (prev[field] !== curr[field]) {
      return true;
    }
  }
  return false;
}

// ── Notification Batching System ─────────────────────────────────────────────

const messageQueue = {
  critical: [], // priority 1 - immediate
  errors: [], // priority 2
  warnings: [], // priority 3
  info: [], // priority 4
  debug: [], // priority 5
};

let batchFlushTimer = null;

// ── Live Digest State ───────────────────────────────────────────────────────
// A single Telegram message that gets continuously edited as events happen.
// When the digest window expires, the message is sealed and the next event
// starts a fresh one.
let liveDigest = {
  messageId: null, // Telegram message_id of the current live digest
  chatId: null, // chat_id it was sent to
  startedAt: 0, // timestamp when this digest window started
  entries: [], // { emoji, text, time } — events in this digest window
  sealTimer: null, // timer to seal the digest after the window expires
  editTimer: null, // debounce timer for edits
  editPending: false, // whether an edit is pending
  sealed: false, // true once the window has expired and message is finalized
};

const PRIORITY_EMOJI = {
  1: ":dot:",
  2: ":close:",
  3: ":alert:",
  4: ":help:",
  5: ":dot:",
};

/**
 * Build the live digest message text from accumulated entries.
 */
function buildLiveDigestText() {
  const d = liveDigest;
  const startTime = new Date(d.startedAt).toISOString().slice(11, 19);
  const now = new Date().toISOString().slice(11, 19);

  // Count by severity
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const e of d.entries) {
    counts[e.priority] = (counts[e.priority] || 0) + 1;
  }

  const countParts = [];
  if (counts[1] > 0) countParts.push(`:dot: ${counts[1]}`);
  if (counts[2] > 0) countParts.push(`:close: ${counts[2]}`);
  if (counts[3] > 0) countParts.push(`:alert: ${counts[3]}`);
  if (counts[4] > 0) countParts.push(`:help: ${counts[4]}`);

  const statusLine = d.sealed
    ? `:chart: Digest (${startTime} → ${now}) — sealed`
    : `:chart: Live Digest (since ${startTime}) — updating...`;
  const headerLine =
    countParts.length > 0
      ? `${statusLine}\n${countParts.join(" • ")}`
      : statusLine;

  // Build event lines (most recent at bottom, like a log)
  // Telegram 4096 char limit — keep recent events, trim old ones
  const MAX_LEN = 3800; // leave room for header
  const lines = [];
  let totalLen = headerLine.length + 2; // +2 for \n\n separator

  // Add entries from newest to oldest, then reverse for chronological order
  for (let i = d.entries.length - 1; i >= 0; i--) {
    const e = d.entries[i];
    const line = `${e.time} ${e.emoji} ${e.text}`;
    if (totalLen + line.length + 1 > MAX_LEN) {
      const trimmed = d.entries.length - lines.length;
      if (trimmed > 0) {
        lines.push(`  …${trimmed} earlier event(s) trimmed`);
      }
      break;
    }
    lines.push(line);
    totalLen += line.length + 1;
  }

  lines.reverse(); // chronological order

  return [headerLine, "", ...lines].join("\n");
}

/**
 * Schedule a debounced edit of the live digest message.
 */
function scheduleLiveDigestEdit() {
  const d = liveDigest;
  if (d.editTimer) {
    clearTimeout(d.editTimer);
  }
  d.editPending = true;
  d.editTimer = setTimeout(async () => {
    d.editPending = false;
    d.editTimer = null;
    if (!d.messageId || !d.chatId) return;
    const text = buildLiveDigestText();
    try {
      const newId = await editDirect(d.chatId, d.messageId, text);
      if (newId && newId !== d.messageId) {
        d.messageId = newId; // editDirect fell back to sendDirect
      }
    } catch (err) {
      console.warn(`[telegram-bot] live digest edit failed: ${err.message}`);
    }
  }, liveDigestEditDebounceMs);
}

/**
 * Seal the current live digest window — mark final, clear state for next window.
 */
function sealLiveDigest() {
  const d = liveDigest;
  if (d.entries.length === 0) {
    // Nothing happened in this window — just reset
    resetLiveDigest();
    return;
  }

  // Snapshot entries before sealing (for devmode auto code fix callback)
  const sealedEntries = [...d.entries];
  const sealedText = buildLiveDigestText();

  d.sealed = true;
  // Flush one last edit to mark it sealed
  if (d.editTimer) clearTimeout(d.editTimer);
  const text = buildLiveDigestText();
  if (d.messageId && d.chatId) {
    editDirect(d.chatId, d.messageId, text).catch(() => {});
  }

  // Fire digest sealed callback (used by devmode auto code fix)
  if (_onDigestSealed) {
    try {
      _onDigestSealed({ entries: sealedEntries, text: sealedText });
    } catch (err) {
      console.warn(
        `[telegram-bot] onDigestSealed callback error: ${err.message}`,
      );
    }
  }

  // Reset for next window
  resetLiveDigest();
}

/**
 * Reset live digest state for a new window.
 */
function resetLiveDigest() {
  if (liveDigest.sealTimer) clearTimeout(liveDigest.sealTimer);
  if (liveDigest.editTimer) clearTimeout(liveDigest.editTimer);
  liveDigest = {
    messageId: null,
    chatId: null,
    startedAt: 0,
    entries: [],
    sealTimer: null,
    editTimer: null,
    editPending: false,
    sealed: false,
  };
  // Clear persisted state
  writeFile(liveDigestStatePath, "{}").catch(() => {});
}

/**
 * Persist live digest state to disk so restarts can resume the same message.
 */
function persistLiveDigest() {
  const d = liveDigest;
  if (!d.messageId) return;
  const state = {
    messageId: d.messageId,
    chatId: d.chatId,
    startedAt: d.startedAt,
    entries: d.entries,
  };
  writeFile(liveDigestStatePath, JSON.stringify(state)).catch(() => {});
}

/**
 * Restore live digest state from disk after a restart.
 * Returns true if a valid digest was restored (still within window).
 */
export async function restoreLiveDigest() {
  // Already restored or active — skip
  if (liveDigest.messageId) return true;
  try {
    const raw = await readFile(liveDigestStatePath, "utf8");
    const state = JSON.parse(raw);
    if (!state.messageId || !state.startedAt) return false;
    const now = Date.now();
    const windowMs = liveDigestWindowSec * 1000;
    // Only restore if the window hasn't expired
    if (now - state.startedAt >= windowMs) {
      await writeFile(liveDigestStatePath, "{}").catch(() => {});
      return false;
    }
    liveDigest.messageId = state.messageId;
    liveDigest.chatId = state.chatId || telegramChatId;
    liveDigest.startedAt = state.startedAt;
    liveDigest.entries = state.entries || [];
    liveDigest.sealed = false;
    // Re-schedule the seal timer for remaining window time
    const remaining = windowMs - (now - state.startedAt);
    liveDigest.sealTimer = setTimeout(() => sealLiveDigest(), remaining);
    console.log(
      `[telegram-bot] restored live digest (${liveDigest.entries.length} entries, ${Math.round(remaining / 1000)}s remaining)`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Add an event to the live digest. Creates the message on first event,
 * then edits it for subsequent events in the same window.
 */
async function addToLiveDigest(text, priority, category) {
  const d = liveDigest;
  const now = Date.now();
  const timeStr = new Date(now).toISOString().slice(11, 19);
  const emoji = PRIORITY_EMOJI[priority] || ":help:";

  // Check if we need a new digest window
  const windowMs = liveDigestWindowSec * 1000;
  const windowExpired = d.startedAt > 0 && now - d.startedAt >= windowMs;

  if (windowExpired || !d.startedAt) {
    // Seal old digest if it had entries
    if (d.entries.length > 0) {
      sealLiveDigest();
    } else {
      resetLiveDigest();
    }
  }

  // Add entry
  liveDigest.entries.push({ emoji, text, time: timeStr, priority, category });

  if (!liveDigest.startedAt) {
    // First event — create the digest message
    liveDigest.startedAt = now;
    liveDigest.chatId = telegramChatId;

    const messageText = buildLiveDigestText();
    const msgId = await sendDirect(telegramChatId, messageText, {
      silent: true,
    });
    if (msgId) {
      liveDigest.messageId = msgId;
    }
    persistLiveDigest();

    // Schedule seal
    liveDigest.sealTimer = setTimeout(() => sealLiveDigest(), windowMs);
  } else {
    // Subsequent event — debounced edit
    scheduleLiveDigestEdit();
    persistLiveDigest();
  }
}

// ── Status Board State ──────────────────────────────────────────────────────
// A single persistent Telegram message that is pinned and edited in-place.
// Unlike the live digest (which opens a new window every N minutes), the
// status board lives forever — it always represents the current state.
let statusBoard = {
  messageId: null,
  chatId: null,
  editTimer: null,
};

/**
 * Persist status board message ID to disk across restarts.
 */
function persistStatusBoard() {
  if (!statusBoard.messageId) return;
  writeFile(
    statusBoardStatePath,
    JSON.stringify({ messageId: statusBoard.messageId, chatId: statusBoard.chatId }),
  ).catch(() => {});
}

/**
 * Schedule a debounced edit of the status board message.
 */
function scheduleStatusBoardEdit(text, opts) {
  if (statusBoard.editTimer) clearTimeout(statusBoard.editTimer);
  statusBoard.editTimer = setTimeout(async () => {
    statusBoard.editTimer = null;
    if (!statusBoard.messageId || !statusBoard.chatId) return;
    try {
      const newId = await editDirect(
        statusBoard.chatId,
        statusBoard.messageId,
        text,
        opts,
      );
      if (newId && newId !== statusBoard.messageId) {
        // editDirect fell back to a new message — persist the new ID
        statusBoard.messageId = newId;
        persistStatusBoard();
      }
    } catch (err) {
      console.warn(`[telegram-bot] status board edit failed: ${err.message}`);
    }
  }, statusBoardEditDebounceMs);
}

/**
 * Push a status update to the pinned status board message.
 * Returns true if the board exists and the update was scheduled, false otherwise.
 * @param {string} text - Formatted message text
 * @param {object} [opts] - { parseMode }
 */
export function pushStatusBoardUpdate(text, opts = {}) {
  if (!statusBoardEnabled) return false;
  if (!statusBoard.messageId) return false;
  scheduleStatusBoardEdit(text, opts);
  return true;
}

/**
 * Initialise the status board: restore from disk or create a fresh pinned message.
 * Should be called once at startup, after Telegram bot is ready.
 */
export async function initStatusBoard() {
  if (!statusBoardEnabled) return;
  if (!telegramToken || !telegramChatId) return;

  // Try restoring the previously-pinned message
  try {
    const raw = await readFile(statusBoardStatePath, "utf8");
    const saved = JSON.parse(raw);
    if (saved.messageId) {
      statusBoard.messageId = saved.messageId;
      statusBoard.chatId = saved.chatId || telegramChatId;
      console.log(
        `[telegram-bot] status board restored (msg ${saved.messageId})`,
      );
      // Edit the board straight away so it shows "restarted" state
      scheduleStatusBoardEdit(":refresh: Orchestrator restarting…", {});
      return;
    }
  } catch {
    /* no saved state — create fresh */
  }

  // Create the initial status board message
  const msgId = await sendDirect(
    telegramChatId,
    ":server: Orchestrator starting…",
    { silent: true },
  );
  if (!msgId) return;

  statusBoard.messageId = msgId;
  statusBoard.chatId = telegramChatId;
  persistStatusBoard();

  // Pin the message (requires the bot to have admin rights in the chat)
  try {
    await telegramApiFetch("pinChatMessage", {
      method: "POST",
      payload: {
        chat_id: telegramChatId,
        message_id: msgId,
        disable_notification: true,
      },
    });
    console.log(
      `[telegram-bot] status board created and pinned (msg ${msgId})`,
    );
  } catch (err) {
    console.warn(
      `[telegram-bot] status board created but could not pin: ${err.message}`,
    );
  }
}

/**
 * Queue a notification for batched delivery.
 * Routes through Live Digest when enabled, falls back to batch queues.
 * @param {string} text - Message text
 * @param {number} priority - 1=critical(immediate), 2=error, 3=warning, 4=info, 5=debug
 * @param {object} options - { category, data, silent }
 */
function queueNotification(text, priority = 4, options = {}) {
  // Critical messages always go immediately
  if (priority <= immediateThreshold) {
    return sendDirect(telegramChatId, text, { silent: options.silent });
  }

  // Live Digest mode: append to the continuously-edited message
  if (liveDigestEnabled && batchingEnabled) {
    return addToLiveDigest(text, priority, options.category || "general");
  }

  // Legacy batch mode fallback
  if (!batchingEnabled) {
    return sendDirect(telegramChatId, text, { silent: options.silent });
  }

  const category = options.category || "info";
  const entry = {
    text,
    priority,
    category,
    timestamp: new Date().toISOString(),
    data: options.data || {},
  };

  // Route to appropriate queue
  if (priority === 1) {
    messageQueue.critical.push(entry);
  } else if (priority === 2) {
    messageQueue.errors.push(entry);
  } else if (priority === 3) {
    messageQueue.warnings.push(entry);
  } else if (priority === 5) {
    messageQueue.debug.push(entry);
  } else {
    messageQueue.info.push(entry);
  }

  // Flush if queue is getting too large
  const totalSize =
    messageQueue.critical.length +
    messageQueue.errors.length +
    messageQueue.warnings.length +
    messageQueue.info.length +
    messageQueue.debug.length;

  if (totalSize >= batchMaxSize) {
    flushNotificationQueue();
  }
}

/**
 * Format and send batched notifications as a summary (legacy fallback).
 */
async function flushNotificationQueue() {
  const sections = [];
  const counts = {
    critical: messageQueue.critical.length,
    errors: messageQueue.errors.length,
    warnings: messageQueue.warnings.length,
    info: messageQueue.info.length,
    debug: messageQueue.debug.length,
  };

  const totalMessages =
    counts.critical +
    counts.errors +
    counts.warnings +
    counts.info +
    counts.debug;

  if (totalMessages === 0) return; // Nothing to send

  // Build summary header
  const timestamp = new Date().toISOString().slice(11, 19);
  let header = `:chart: Update Summary (${timestamp})`;
  if (totalMessages > 0) {
    const parts = [];
    if (counts.critical > 0) parts.push(`:dot: ${counts.critical}`);
    if (counts.errors > 0) parts.push(`:close: ${counts.errors}`);
    if (counts.warnings > 0) parts.push(`:alert: ${counts.warnings}`);
    if (counts.info > 0) parts.push(`:help: ${counts.info}`);
    header += `\n${parts.join(" • ")}`;
  }

  // Critical messages (show all)
  if (counts.critical > 0) {
    sections.push(
      `:dot: Critical:\n${messageQueue.critical.map((m) => `  • ${m.text}`).join("\n")}`,
    );
  }

  // Errors (show up to 5, then summarize)
  if (counts.errors > 0) {
    const errorTexts = messageQueue.errors
      .slice(0, 5)
      .map((m) => `  • ${m.text}`);
    if (counts.errors > 5) {
      errorTexts.push(`  • ... and ${counts.errors - 5} more errors`);
    }
    sections.push(`:close: Errors:\n${errorTexts.join("\n")}`);
  }

  // Warnings (show up to 3, then summarize)
  if (counts.warnings > 0) {
    const warnTexts = messageQueue.warnings
      .slice(0, 3)
      .map((m) => `  • ${m.text}`);
    if (counts.warnings > 3) {
      warnTexts.push(`  • ... and ${counts.warnings - 3} more warnings`);
    }
    sections.push(`:alert: Warnings:\n${warnTexts.join("\n")}`);
  }

  // Info messages (aggregate by category)
  if (counts.info > 0) {
    const categories = {};
    for (const msg of messageQueue.info) {
      const cat = msg.category || "general";
      categories[cat] = (categories[cat] || 0) + 1;
    }
    const summary = Object.entries(categories)
      .map(([cat, count]) => `  • ${cat}: ${count}`)
      .join("\n");
    sections.push(`:help: Info:\n${summary}`);
  }

  // Build final message
  const message = [header, ...sections].join("\n\n");

  // Send the summary
  await sendDirect(telegramChatId, message, { silent: true });

  // Clear queues
  messageQueue.critical.length = 0;
  messageQueue.errors.length = 0;
  messageQueue.warnings.length = 0;
  messageQueue.info.length = 0;
  messageQueue.debug.length = 0;
}

/**
 * Start periodic flushing of the notification queue.
 * In live-digest mode, the flush loop is only used as a fallback seal timer.
 */
async function startBatchFlushLoop() {
  if (!batchingEnabled || batchFlushTimer) return;
  // In live digest mode, restore persisted state (if not already restored) and skip flush loop
  if (liveDigestEnabled) {
    if (!liveDigest.messageId) await restoreLiveDigest();
    return;
  }
  const intervalMs = batchIntervalSec * 1000;
  batchFlushTimer = setInterval(() => {
    flushNotificationQueue().catch((err) =>
      console.warn(`[telegram-bot] batch flush error: ${err.message}`),
    );
  }, intervalMs);
}

/**
 * Stop the batch flush loop and seal any active live digest.
 */
function stopBatchFlushLoop() {
  if (batchFlushTimer) {
    clearInterval(batchFlushTimer);
    batchFlushTimer = null;
  }
  // Seal any active live digest
  if (liveDigest.entries.length > 0) {
    sealLiveDigest();
  } else {
    resetLiveDigest();
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the two-way Telegram bot.
 * Call injectMonitorFunctions() first for canonical UI-runtime and monitor integration.
 */
export async function startTelegramBot(options = {}) {
  refreshTelegramConfigFromEnv();
  setComponentStatus("monitor", "running");
  const miniAppEnabled = ["1", "true", "yes"].includes(
    String(process.env.TELEGRAM_MINIAPP_ENABLED || "").toLowerCase(),
  );
  const miniAppPort = Number(process.env.TELEGRAM_UI_PORT || "0");
  const hasTelegram = !!(telegramToken && telegramChatId);
  syncUiUrlsFromServer();

  if (!hasTelegram) {
    console.warn(
      "[telegram-bot] Telegram polling disabled (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)" +
      (miniAppEnabled || miniAppPort > 0 ? " — portal UI is still active" : ""),
    );
    return;
  }

  // Probe Telegram API connectivity before startup registration
  const reachable = await probeTelegramConnectivity();
  if (reachable) {
    await registerBotCommands();
  } else {
    console.warn(
      "[telegram-bot] Telegram API unreachable at startup — command registration deferred",
    );
  }

  // Wire up Telegram-specific UI integrations (menu button, firewall alerts)
  if (miniAppEnabled || miniAppPort > 0) {
    try {
      if (reachable && telegramWebAppUrl) {
        const updated = await setWebAppMenuButton(telegramWebAppUrl);
        if (updated) {
          lastMenuButtonUrl = telegramWebAppUrl;
        }
      } else if (reachable) {
        await clearWebAppMenuButton();
        lastMenuButtonUrl = null;
      }

      // Immediately sync the menu button, then periodically refresh
      if (reachable) {
        safeDetach("menu-button-refresh", refreshMenuButton);
      }
      if (reachable && !menuButtonRefreshTimer) {
        menuButtonRefreshTimer = setInterval(() => safeDetach("menu-button-refresh", refreshMenuButton), MENU_BUTTON_REFRESH_MS);
      }

      // React immediately when the tunnel URL changes (e.g. after restart)
      onTunnelUrlChange((url) => {
        console.log(`[telegram-bot] tunnel URL changed: ${url} — refreshing menu button`);
        safeDetach("menu-button-refresh", refreshMenuButton);
      });

      // Notify about firewall issues if detected (24h cooldown)
      // Skip the alarm if the cloudflared tunnel is active — Telegram Mini App
      // traffic goes through the tunnel (internet → Cloudflare → localhost),
      // so the LAN firewall doesn't matter for Telegram. Only direct LAN
      // browser access is affected.
      if (reachable) {
        const fwState = getFirewallState();
        const tUrl = getTunnelUrl();
        if (fwState && fwState.blocked && !tUrl) {
          let skipCooldown = false;
          try {
            if (existsSync(fwCooldownPath)) {
              const data = JSON.parse(readFileSync(fwCooldownPath, "utf8"));
              if (Date.now() - (data.lastNotified || 0) < FW_COOLDOWN_MS) {
                skipCooldown = true;
              }
            }
          } catch { /* ignore corrupt file */ }
          if (!skipCooldown) {
            const port = new URL(telegramUiUrl || "http://localhost:5511").port || "5511";
            await sendDirect(
              telegramChatId,
              `:zap: *Firewall Alert*\n\n` +
              `Port ${port}/tcp appears blocked by \`${fwState.firewall}\`.\n` +
              `The Control Center may not be reachable from your phone or LAN browser.\n\n` +
              `To fix, run on the server:\n\`\`\`\n${fwState.allowCmd}\n\`\`\``,
              {
                parseMode: "Markdown",
                reply_markup: {
                  inline_keyboard: [[
                    { text: ":unlock: Open Port (requires admin password on server)", callback_data: "fw:open" },
                  ]],
                },
              },
            );
            try {
              mkdirSync(resolve(repoRoot, ".cache"), { recursive: true });
              writeFileSync(fwCooldownPath, JSON.stringify({ lastNotified: Date.now() }));
            } catch { /* best effort */ }
          }
        } else if (fwState && fwState.blocked && tUrl) {
          console.log(
            `[telegram-bot] firewall blocks port but tunnel active — suppressing Telegram firewall alert`,
          );
        }
      }
    } catch (err) {
      console.warn(`[telegram-bot] UI Telegram integration failed: ${err.message}`);
      if (reachable) {
        await clearWebAppMenuButton();
        lastMenuButtonUrl = null;
      }
    }
  } else if (reachable) {
    await clearWebAppMenuButton();
  }

  // Start presence announcements for multi-workstation discovery
  startPresenceLoop();

  // Start batched notification / live digest system
  await startBatchFlushLoop();

  // ── Polling guards ─────────────────────────────────────────────────────
  // These only gate Telegram getUpdates polling — the portal / UI server,
  // presence loop, and batch flush are already running above.

  const conflictState = readTelegramPollConflictState();
  if (conflictState && conflictState.untilMs > Date.now()) {
    // If the recorded cooldown owner process is no longer alive, clear stale
    // conflict cooldown immediately so polling can recover without waiting
    // the full backoff window.
    if (
      Number.isFinite(Number(conflictState.pid)) &&
      Number(conflictState.pid) > 0 &&
      !canSignalProcess(Number(conflictState.pid))
    ) {
      clearTelegramPollConflictState();
    } else {
    const remainSec = Math.ceil((conflictState.untilMs - Date.now()) / 1000);
    console.warn(
      `[telegram-bot] polling suppressed — 409 conflict cooldown active for ${remainSec}s` +
      (conflictState.reason ? ` (${conflictState.reason})` : ""),
    );
    return;
    }
  }

  const ownerClaim = await claimTelegramPollOwner("telegram-bot", {
    ttlMs: TELEGRAM_POLL_OWNER_TTL_MS,
  });
  if (!ownerClaim?.ok) {
    const activeOwner =
      ownerClaim?.owner && ownerClaim.owner.owner
        ? `${ownerClaim.owner.owner} (pid ${ownerClaim.owner.pid})`
        : "another active poll owner";
    console.warn(
      `[telegram-bot] polling disabled (${activeOwner} owns getUpdates arbitration)`,
    );
    return;
  }

  const lockOk = await acquireTelegramPollLock("telegram-bot");
  if (!lockOk) {
    await releaseTelegramPollOwner("telegram-bot").catch(() => {});
    console.warn(
      "[telegram-bot] polling disabled (another getUpdates poller is active)",
    );
    return;
  }

  // Clear any pending updates that arrived while we were offline
  try {
    const stale = await pollUpdates();
    for (const u of stale) {
      lastUpdateId = Math.max(lastUpdateId, u.update_id);
    }
    if (stale.length > 0) {
      console.log(`[telegram-bot] skipped ${stale.length} stale updates`);
    }
  } catch {
    /* best effort */
  }

  polling = true;

  // Only send "online" notification on truly fresh starts, not code-change restarts.
  // Check the self-restart marker file first, then fall back to rapid-restart heuristic.
  const botStartPath = resolve(repoRoot, ".cache", "ve-last-bot-start.txt");
  const selfRestartPath = resolve(repoRoot, ".cache", "ve-self-restart.marker");
  let suppressOnline = false;
  try {
    if (existsSync(selfRestartPath)) {
      const ts = Number(readFileSync(selfRestartPath, "utf8"));
      if (Date.now() - ts < 30_000) suppressOnline = true;
    }
  } catch {
    /* best effort */
  }
  if (!suppressOnline) {
    try {
      const prev = await readFile(botStartPath, "utf8");
      const elapsed = Date.now() - Number(prev);
      if (elapsed < 60_000) suppressOnline = true;
    } catch {
      /* first start or missing file */
    }
  }
  await writeFile(botStartPath, String(Date.now())).catch(() => {});

  if (suppressOnline) {
    console.log(
      "[telegram-bot] restarted (suppressed online notification — rapid restart)",
    );
  } else {
    const selectionPayload = await harnessApi.getProviderSelection().catch(() => ({ selection: {} }));
    await sendDirect(
      telegramChatId,
      `:bot: Bosun harness session channel online (${selectionPayload?.selection?.primaryAgent || "harness-session"}).\n\nType /menu for the control center or send any message to chat with the agent.\n\nRefreshing control center menu below…`,
    );
    await refreshStickyMenu(telegramChatId, "home", {});

    // ── SECURITY: Alert when ALLOW_UNSAFE is enabled (especially with tunnel) ──
    const _isUnsafe = ["1", "true", "yes"].includes(
      String(process.env.TELEGRAM_UI_ALLOW_UNSAFE || "").toLowerCase(),
    );
    if (_isUnsafe) {
      const _tunnelMode = (process.env.TELEGRAM_UI_TUNNEL || "named").toLowerCase();
      const _tunnelWanted = _tunnelMode !== "disabled" && _tunnelMode !== "off" && _tunnelMode !== "0";
      const title = _tunnelWanted
        ? ":ban: *Unsafe UI Access + Cloudflare Tunnel conflict detected*"
        : ":alert: *Unsafe UI Access enabled*";
      const body = _tunnelWanted
        ? "*Unsafe UI access was enabled alongside Cloudflare tunnel — the tunnel has been disabled* until unsafe access is turned off.\n\n"
          + "With both active, anyone on the internet could control your agents, execute code, and read your secrets.\n\n"
          + "Tap the button below (or send `/disable_unsafe_access` then `/restart`; `/disable-unsafe-access` alias also works) to re-enable the tunnel."
        : "Authentication is *completely disabled* on the web UI. "
          + "Anyone with the local URL can send commands to agents and access API keys.\n\n"
          + "Tap the button below (or send `/disable_unsafe_access`; `/disable-unsafe-access` alias also works) to re-enable auth.";
      await sendDirect(
        telegramChatId,
        `${title}\n\n${body}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: ":lock: Disable Unsafe Access", callback_data: "cb:do_disable_unsafe" },
              ],
            ],
          },
        },
      );
    }
  }

  console.log("[telegram-bot] started — listening for messages");

  // Start the polling loop (non-blocking)
  pollLoop().catch((err) => {
    console.error(`[telegram-bot] fatal poll loop error: ${err.message}`);
    polling = false;
  });

  // ── Message history auto-cleanup ──
  if (HISTORY_RETENTION_MS) {
    // Flush in-memory buffer to disk every 5 minutes
    const flushTimer = setInterval(() => {
      if (_msgHistoryDirty) _saveMsgHistory();
    }, 5 * 60 * 1000);
    flushTimer.unref();

    // Run first prune after HISTORY_INITIAL_DELAY_MS (2 min), then every 6 h
    setTimeout(() => {
      pruneMessageHistory().catch((err) =>
        console.warn(`[telegram-bot] message history cleanup error: ${err.message}`),
      );
      const cleanupTimer = setInterval(
        () =>
          pruneMessageHistory().catch((err) =>
            console.warn(
              `[telegram-bot] message history cleanup error: ${err.message}`,
            ),
          ),
        HISTORY_CLEANUP_INTERVAL_MS,
      );
      cleanupTimer.unref();
    }, HISTORY_INITIAL_DELAY_MS);
  }
}

/**
 * Stop the Telegram bot polling.
 */
export function stopTelegramBot(options = {}) {
  polling = false;
  if (pollAbort) {
    try {
      pollAbort.abort();
    } catch {
      /* best effort */
    }
  }
  if (options.preserveDigest) {
    // Self-restart: persist live digest state for the next process to resume.
    // Don't seal or reset — the new process will pick up where we left off.
    persistLiveDigest();
    if (liveDigest.sealTimer) clearTimeout(liveDigest.sealTimer);
    if (liveDigest.editTimer) clearTimeout(liveDigest.editTimer);
    if (batchFlushTimer) {
      clearInterval(batchFlushTimer);
      batchFlushTimer = null;
    }
  } else {
    // Normal shutdown: seal any active live digest and flush legacy queues
    if (liveDigestEnabled && liveDigest.entries.length > 0) {
      sealLiveDigest();
    } else {
      flushNotificationQueue().catch(() => {});
    }
    stopBatchFlushLoop();
  }
  safeDetach("poll-lock-release", releaseTelegramPollLock);
  safeDetach("poll-owner-release", () => releaseTelegramPollOwner("telegram-bot"));
  setComponentStatus("monitor", "stopped");
  if (menuButtonRefreshTimer) {
    clearInterval(menuButtonRefreshTimer);
    menuButtonRefreshTimer = null;
  }
  console.log("[telegram-bot] stopped");
}

/**
 * Queue a notification for batched delivery (exported for monitor.mjs).
 * @param {string} text - Message text
 * @param {number} priority - 1=critical(immediate), 2=error, 3=warning, 4=info, 5=debug
 * @param {object} options - { category, data, silent }
 */
export function notify(text, priority = 4, options = {}) {
  return queueNotification(text, priority, options);
}

/**
 * Get a snapshot of the current live digest entries.
 * Useful for external consumers that need to read digest state.
 */
export function getDigestSnapshot() {
  return {
    entries: [...liveDigest.entries],
    startedAt: liveDigest.startedAt,
    sealed: liveDigest.sealed,
  };
}

// ── Periodic status file writer ─────────────────────────────────
// Called by monitor to keep the status file in sync with live executor state
let _statusWriterTimer = null;

export function startStatusFileWriter(intervalMs = 30000) {
  if (_statusWriterTimer) return;
  const statusDir = dirname(statusPath);
  _statusWriterTimer = setInterval(async () => {
    try {
      const executor = _getInternalExecutor?.();
      if (!executor) return;
      const status = executor.getStatus?.();
      if (!status) return;
      await mkdir(statusDir, { recursive: true });

      let data = {};
      try {
        const raw = await readFile(statusPath, "utf8");
        data = JSON.parse(raw);
      } catch {
        /* fresh file */
      }

      // Convert executor slots to the attempts format
      const attempts = {};
      for (const slot of status.slots) {
        attempts[slot.taskId] = {
          task_id: slot.taskId,
          task_title: slot.taskTitle,
          branch: slot.branch,
          status: slot.status,
          executor: slot.sdk,
          started_at: new Date(
            Number(slot.startedAt || Date.now()),
          ).toISOString(),
          updated_at: new Date().toISOString(),
          attempt: slot.attempt,
          agent_instance_id:
            Number.isFinite(slot.agentInstanceId) && slot.agentInstanceId > 0
              ? Number(slot.agentInstanceId)
              : null,
        };
      }

      let storeStats = null;
      try {
        storeStats = _getTaskStoreStats?.() || null;
      } catch {
        storeStats = null;
      }

      let reviewTasks = [];
      try {
        reviewTasks = (_getTasksPendingReview?.() || [])
          .map((task) => task?.id)
          .filter(Boolean);
      } catch {
        reviewTasks = [];
      }

      const draftCount = Number(storeStats?.draft || 0);
      const todoCount = Number(storeStats?.todo || 0);
      const inprogressCount = Number(storeStats?.inprogress || 0);
      const reviewCount = Number(storeStats?.inreview || reviewTasks.length || 0);
      const doneCount = Number(storeStats?.done || 0);
      const blockedCount = Number(storeStats?.blocked || 0);

      data.attempts = attempts;
      data.last_executor_sync = new Date().toISOString();
      data.executor_mode = status.mode || "unknown";
      data.active_slots = `${status.activeSlots}/${status.maxParallel}`;
      data.review_tasks = reviewTasks;
      data.manual_review_tasks = [];
      data.backlog_remaining = draftCount + todoCount;
      if (!data.counts || typeof data.counts !== "object") data.counts = {};
      data.counts.draft = draftCount;
      data.counts.todo = todoCount + draftCount;
      data.counts.running = Number(status.activeSlots || inprogressCount || 0);
      data.counts.inprogress = inprogressCount;
      data.counts.review = reviewCount;
      data.counts.inreview = reviewCount;
      data.counts.done = doneCount;
      data.counts.blocked = blockedCount;
      data.counts.error = blockedCount;
      data.counts.manual_review = 0;
      data.counts.total = draftCount + todoCount + inprogressCount + reviewCount + doneCount + blockedCount;

      const { writeFile } = await import("node:fs/promises");
      await writeFile(statusPath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.warn("[telegram-bot] Status file write error:", err.message);
    }
  }, intervalMs);

  if (_statusWriterTimer.unref) _statusWriterTimer.unref();
}

export function stopStatusFileWriter() {
  if (_statusWriterTimer) {
    clearInterval(_statusWriterTimer);
    _statusWriterTimer = null;
  }
}
