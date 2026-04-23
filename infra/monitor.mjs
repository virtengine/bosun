import { execSync, spawn, spawnSync, exec } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { clearLine, createInterface, cursorTo } from "node:readline";
import net from "node:net";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

// Node.js Happy Eyeballs (RFC 8305) tries IPv6 first with a 250ms timeout
// before falling back to IPv4.  On networks where IPv6 is unreachable, the
// IPv4 fallback can exceed 250ms (Telegram's server round-trip is ~500ms)
// causing fetch() to fail with ETIMEDOUT while curl works fine.  Raise the
// attempt timeout so IPv4 has enough time to connect.
if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === "function") {
  net.setDefaultAutoSelectFamilyAttemptTimeout(2000);
}

const heartbeatRuntimeState = {
  current: null,
};

const HELPER_PROCESS_REAP_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.BOSUN_HELPER_PROCESS_REAP_INTERVAL_MS || "300000") || 300000,
);
const HELPER_PROCESS_MAX_AGE_MS = Math.max(
  60_000,
  Number(process.env.BOSUN_HELPER_PROCESS_MAX_AGE_MS || "600000") || 600000,
);

/**
 * Non-blocking async shell exec — avoids blocking the HTTP server event loop.
 * Use instead of execSync/spawnSync in timer callbacks and request handlers.
 * @param {string} cmd - Shell command string
 * @param {{ cwd?: string, timeout?: number, encoding?: string }} [opts]
 * @returns {Promise<string>} stdout on success, rejects with Error on non-zero exit
 */
function execAsync(cmd, { cwd, timeout = 30_000, encoding = "utf8" } = {}) {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { cwd, timeout, encoding, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      if (code === 0 || code === null) resolve(stdout);
      else reject(Object.assign(new Error(`exec failed (${code}): ${cmd}`), { stdout, stderr, exitCode: code }));
    });
    child.on("error", reject);
  });
}


import {
  acquireMonitorLock,
  reapStaleBosunHelperProcesses,
} from "./maintenance.mjs";

import {
  attemptAutoFix,
  fixLoopingError,
  isDevMode,
  runCodexExec,
} from "../agent/autofix.mjs";
import {
  startTelegramBot,
  stopTelegramBot,
  injectMonitorFunctions,
  notify,
  restoreLiveDigest,
  getDigestSnapshot,
  startStatusFileWriter,
  stopStatusFileWriter,
  initStatusBoard,
  pushStatusBoardUpdate,
  handleUiCommand,
} from "../telegram/telegram-bot.mjs";
import {
  createTelegramUiRuntime,
  startTelegramSurfaceRuntime,
  stopTelegramSurfaceRuntime,
} from "../telegram/telegram-surface-runtime.mjs";
import { startAnalyzer, stopAnalyzer } from "../agent/agent-work-analyzer.mjs";
import {
  generateWeeklyAgentWorkReport,
  getNextWeeklyReportTime,
  getWeeklyReportStatePath,
  readWeeklyReportScheduleState,
  shouldSendWeeklyReport,
  writeWeeklyReportScheduleState,
} from "../agent/agent-work-report.mjs";

import {
  execPrimaryPrompt,
  initPrimaryAgent,
  setPrimaryAgent,
  getPrimaryAgentName,
  switchPrimaryAgent,
} from "../agent/primary-agent.mjs";
import {
  execPooledPrompt,
  launchEphemeralThread,
  launchOrResumeThread,
  execWithRetry,
  getAvailableSdks,
  forceNewThread,
  steerActiveThread,
  hasActiveSession,
} from "../agent/agent-pool.mjs";
import { loadConfig } from "../config/config.mjs";
import {
  checkChildProcessLaunch,
  formatPreflightReport,
  runPreflightChecks,
} from "./preflight.mjs";
import { startAutoUpdateLoop, stopAutoUpdateLoop } from "./update-check.mjs";
import { createHeartbeatMonitor } from "./heartbeat-monitor.mjs";
import {
  isWhatsAppEnabled,
  startWhatsAppChannel,
  stopWhatsAppChannel,
  notifyWhatsApp,
  getWhatsAppStatus,
} from "../telegram/whatsapp-channel.mjs";
import {
  isContainerEnabled,
  getContainerStatus,
  ensureContainerRuntime,
  stopAllContainers,
  cleanupOrphanedContainers,
  getIsolatedRunnerPoolStatus,
  runInIsolatedRunner,
} from "./container-runner.mjs";
import { ensureCodexConfig, printConfigSummary } from "../shell/codex-config.mjs";
import { RestartController } from "./restart-controller.mjs";

import { assessTask, quickAssess } from "../task/task-assessment.mjs";
import {
  normalizeDebtItems as normalizeAssessmentDebtItems,
  recordTaskDebt,
  readTaskDebtEntries,
} from "../task/task-debt-ledger.mjs";
import {
  getBosunCoAuthorTrailer,
  shouldAddBosunCoAuthor,
} from "../git/git-commit-helpers.mjs";
import {
  normalizeDedupKey,
  stripAnsi,
  isErrorLine,
  escapeHtml,
  formatHtmlLink,
  getErrorFingerprint,
  getMaxParallelFromArgs,
  parsePrNumberFromUrl,
} from "../utils.mjs";
import { fetchWithFallback } from "./fetch-runtime.mjs";
import { resolveEntry, syncAutoDiscoveredLibraryEntries } from "./library-manager.mjs";
import { evaluateMarkdownSafety, recordMarkdownSafetyAuditEvent } from "../lib/skill-markdown-safety.mjs";
import {
  initFleet,
  refreshFleet,
  buildFleetPresence,
  getFleetState,
  isFleetCoordinator,
  getFleetMode,
  getTotalFleetSlots,
  buildExecutionWaves,
  assignTasksToWorkstations,
  calculateBacklogDepth,
  detectMaintenanceMode,
  formatFleetSummary,
  persistFleetState,
} from "../agent/fleet-coordinator.mjs";
import {
  getComplexityMatrix,
  assessCompletionConfidence,
  classifyComplexity,
  COMPLEXITY_TIERS,
  DEFAULT_MODEL_PROFILES,
  executorToSdk,
} from "../task/task-complexity.mjs";
import {
  getDirtyTasks,
  prioritizeDirtyTasks,
  shouldReserveDirtySlot,
  getDirtySlotReservation,
  buildConflictResolutionPrompt,
  isFileOverlapWithDirtyPR,
  registerDirtyTask,
  clearDirtyTask,
  isDirtyTask,
  getHighTierForDirty,
  isOnResolutionCooldown,
  recordResolutionAttempt,
  formatDirtyTaskSummary,
  DIRTY_TASK_DEFAULTS,
} from "../git/conflict-resolver.mjs";

import {
  initSharedKnowledge,
  buildKnowledgeEntry,
  appendKnowledgeEntry,
  formatKnowledgeSummary,
} from "../workspace/shared-knowledge.mjs";
import { WorkspaceMonitor } from "../workspace/workspace-monitor.mjs";
import {
  createAnomalyDetector,
  setWorkflowEngine as bindWorkflowEngineToAnomalyDetector,
  wrapAnomalyCallback,
} from "./anomaly-detector.mjs";
import { resolvePwshRuntime } from "../shell/pwsh-runtime.mjs";
import {
  getWorktreeManager,
  acquireWorktree,
  releaseWorktree,
  releaseWorktreeByBranch,
  findWorktreeForBranch as findManagedWorktree,
  pruneStaleWorktrees,
  getWorktreeStats,
} from "../workspace/worktree-manager.mjs";
import {
  getTaskExecutor,
  isInternalExecutorEnabled,
  isExecutorDisabled,
  getExecutorMode,
  loadExecutorOptionsFromConfig,
  setTaskStatusTransitionHandler,
} from "../task/task-executor.mjs";
import {
  configureFromArgs,
  installConsoleInterceptor,
  setErrorLogFile,
} from "../lib/logger.mjs";
import { fixGitConfigCorruption, listActiveWorktrees } from "../workspace/worktree-manager.mjs";
// ── Task management subsystem imports ──────────────────────────────────────
import {
  configureTaskStore,
  canStartTask,
  getTask as getInternalTask,
  getTasksByStatus as getInternalTasksByStatus,
  updateTask as updateInternalTask,
  addTask as addInternalTask,
  recordAgentAttempt,
  recordErrorPattern,
  getStorePath,
  loadStore as loadTaskStore,
  getStats as getTaskStoreStats,
  setTaskStatus as setInternalTaskStatus,
  setReviewResult,
  getTasksPendingReview,
  getStaleInProgressTasks,
  getStaleInReviewTasks,
  getAllTasks as getAllInternalTasks,
  recoverAutoBlockedTasks,
} from "../task/task-store.mjs";
import { createAgentEndpoint } from "../agent/agent-endpoint.mjs";
import { createAgentEventBus } from "../agent/agent-event-bus.mjs";
import { onConfigReload } from "../ui/tui/config-events.js";
import { createReviewAgent } from "../agent/review-agent.mjs";

import { createErrorDetector } from "./error-detector.mjs";
import { createAgentSupervisor } from "../agent/agent-supervisor.mjs";
import { getSessionTracker } from "./session-tracker.mjs";
import { pullWorkspaceRepos } from "../workspace/workspace-manager.mjs";
import {
	initRuntimeAccumulator,
	getRuntimeStats,
	addCompletedSession,
	getSessionTokens,
} from "./runtime-accumulator.mjs";
import { buildMonitorStatsPayload } from "./tui-bridge.mjs";
import { addConfigReloadListener } from "./config-reload-bus.mjs";

import {
  getKanbanBackendName,
  setKanbanBackend,
  listTasks as listKanbanTasks,
  updateTaskStatus as updateKanbanTaskStatus,
  updateTask as updateKanbanTask,
  listProjects as listKanbanProjects,
  createTask as createKanbanTask,
} from "../kanban/kanban-adapter.mjs";
import { resolvePromptTemplate } from "../agent/agent-prompts.mjs";
import { resolveCodexProfileRuntime } from "../shell/codex-model-profiles.mjs";
import { sanitizeMonitorTailForPrompt as sanitizeMonitorTailForPromptShared } from "../monitor-tail-sanitizer.mjs";
import { webhookEvents as _githubWebhookEvents } from "../github/github-oauth-portal.mjs";
const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));

// ── Anomaly signal file path (shared with orchestrator) ──────────────────────
const ANOMALY_SIGNAL_PATH = resolve(
  __dirname,
  "..",
  ".cache",
  "anomaly-signals.json",
);

const AGENT_ALERT_POLL_MS = 10_000;
const AGENT_ALERTS_REPLAY_STARTUP = isTruthyFlag(
  process.env.AGENT_ALERTS_REPLAY_STARTUP,
);
let agentWorkAnalyzerActive = false;
let agentAlertsOffset = 0;
let agentAlertsTimer = null;
const agentAlertsDedup = new Map();

function getAgentAlertsPath() {
  return resolve(repoRoot, ".cache", "agent-work-logs", "agent-alerts.jsonl");
}

function getAgentAlertsStatePath() {
  return resolve(
    repoRoot,
    ".cache",
    "agent-work-logs",
    "agent-alert-tail-state.json",
  );
}

function loadAgentAlertsState() {
  const statePath = getAgentAlertsStatePath();
  try {
    if (!existsSync(statePath)) return;
    const raw = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    const offset = Number(parsed?.offset || 0);
    if (Number.isFinite(offset) && offset >= 0) {
      agentAlertsOffset = offset;
    }
    const dedupEntries = Array.isArray(parsed?.dedupEntries)
      ? parsed.dedupEntries
      : [];
    agentAlertsDedup.clear();
    for (const entry of dedupEntries) {
      if (!entry || typeof entry !== "object") continue;
      const key = String(entry.key || "").trim();
      const ts = Number(entry.ts || 0);
      if (!key || !Number.isFinite(ts) || ts <= 0) continue;
      agentAlertsDedup.set(key, ts);
    }
  } catch (err) {
    console.warn(`[monitor] failed loading alert tail state: ${err.message}`);
  }
}

function saveAgentAlertsState() {
  const statePath = getAgentAlertsStatePath();
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    const dedupEntries = [...agentAlertsDedup.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200)
      .map(([key, ts]) => ({ key, ts }));
    const payload = {
      offset: agentAlertsOffset,
      dedupEntries,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn(`[monitor] failed saving alert tail state: ${err.message}`);
  }
}

function initializeAgentAlertsOffset() {
  if (AGENT_ALERTS_REPLAY_STARTUP) {
    // In replay mode, start from the beginning and ignore any persisted
    // deduplication state so that replayed alerts are not suppressed.
    agentAlertsOffset = 0;
    agentAlertsDedup.clear();
    return;
  }
  loadAgentAlertsState();
  if (agentAlertsOffset > 0) return;
  const path = getAgentAlertsPath();
  if (!existsSync(path)) return;
  try {
    agentAlertsOffset = statSync(path).size;
  } catch {
    agentAlertsOffset = 0;
  }
}

function rememberAlert(key) {
  agentAlertsDedup.set(key, Date.now());
  if (agentAlertsDedup.size > 200) {
    const sorted = [...agentAlertsDedup.entries()].sort((a, b) => a[1] - b[1]);
    for (const [oldKey] of sorted.slice(0, 100)) {
      agentAlertsDedup.delete(oldKey);
    }
  }
}

function formatAgentAlert(alert) {
  const severity = String(alert.severity || "medium").toUpperCase();
  const type = alert.type || "alert";
  const lines = [
    `:search: Agent Analyzer: ${severity} ${type}`,
    `Attempt: ${alert.attempt_id || "unknown"}`,
  ];
  if (alert.task_id) lines.push(`Task: ${alert.task_id}`);
  if (alert.executor) lines.push(`Executor: ${alert.executor}`);
  if (alert.recommendation) lines.push(`Recommendation: ${alert.recommendation}`);
      if (alert.error_count) lines.push(`Errors: ${alert.error_count} (merge conflicts)`);
  if (alert.idle_time_ms) {
    lines.push(`Idle: ${Math.round(alert.idle_time_ms / 1000)}s`);
  }
  if (alert.cost_usd) lines.push(`Cost: $${Number(alert.cost_usd).toFixed(3)}`);
  return lines.join("\n");
}

function formatMonitorError(err) {
  if (err == null) return "unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "object") {
    const details = [err.message, err.error, err.stderr, err.reason]
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => String(value).trim());
    if (details.length > 0) return details[0];
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

function parseEnvBoolean(value, defaultValue = false) {
  if (value == null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return defaultValue;
}

function parseEnvInteger(value, defaultValue, { min = null, max = null } = {}) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  if (Number.isFinite(min) && parsed < min) return defaultValue;
  if (Number.isFinite(max) && parsed > max) return defaultValue;
  return parsed;
}

function parseEnvNumber(value, defaultValue, { min = null, max = null } = {}) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return defaultValue;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return defaultValue;
  if (Number.isFinite(min) && parsed < min) return defaultValue;
  if (Number.isFinite(max) && parsed > max) return defaultValue;
  return parsed;
}

const DEFAULT_AGENT_ENDPOINT_PORT = 18432;
const REPO_SCOPED_AGENT_ENDPOINT_PORT_WINDOW = 2048;

function deriveRepoScopedAgentEndpointPort(repoRoot) {
  const normalizedRoot = resolve(String(repoRoot || process.cwd()))
    .replace(/\\/g, "/")
    .toLowerCase();
  const digest = createHash("sha1").update(normalizedRoot, "utf8").digest();
  const offset = ((digest[0] << 8) | digest[1]) % REPO_SCOPED_AGENT_ENDPOINT_PORT_WINDOW;
  return DEFAULT_AGENT_ENDPOINT_PORT + offset;
}

function resolveMonitorAgentEndpointPort(repoRoot) {
  const explicit = parseEnvInteger(
    process.env.AGENT_ENDPOINT_PORT ?? process.env.BOSUN_AGENT_ENDPOINT_PORT,
    Number.NaN,
    { min: 1, max: 65535 },
  );
  if (Number.isFinite(explicit)) return explicit;
  return deriveRepoScopedAgentEndpointPort(repoRoot);
}

function syncAgentEndpointPortEnv(port) {
  const normalized = Number(port);
  if (!Number.isInteger(normalized) || normalized <= 0 || normalized > 65535) return;
  const value = String(normalized);
  process.env.BOSUN_AGENT_ENDPOINT_PORT = value;
  process.env.AGENT_ENDPOINT_PORT = value;
}

var workflowAutomationEnabled = false;
var workflowEventDedupWindowMs = 15_000;
var workflowEventDedup = new Map();
var workflowTaskStatusSnapshot = new Map();
var workflowAutomationEngine = null;
var workflowAutomationInitPromise = null;
var workflowAutomationInitDone = false;
var workflowAutomationReadyLogged = false;
var workflowAutomationUnavailableLogged = false;
var workflowConflictResolverPausedLogged = false;
var workflowTaskReconcilePausedLogged = false;
var workflowTaskReconcileInFlight = false;
var workflowTaskReconcileLastAt = 0;
var WORKFLOW_TASK_RECONCILE_MIN_INTERVAL_MS = 45 * 1000;

/**
 * Cache of module names that have an enabled workflow replacement.
 * Populated once after the workflow engine loads.
 * Used by `isWorkflowReplacingModule()` to let legacy code yield.
 */
var _workflowReplacesModuleCache = new Set();
var _workflowReplacesModuleCachePopulated = false;

/**
 * Check whether a workflow replaces a legacy module and workflow automation is
 * enabled.  When this returns `true` the legacy code-path should yield so that
 * the same action is not performed twice (once by the module and once by the
 * workflow).
 *
 * @param {string} moduleName  e.g. "merge-strategy.mjs", "review-agent.mjs"
 * @returns {boolean}
 */
function isWorkflowReplacingModule(moduleName) {
  if (!workflowAutomationEnabled) return false;
  if (!workflowAutomationEngine) return false;

  // Lazily populate the cache from the engine's loaded workflows
  if (!_workflowReplacesModuleCachePopulated) {
    _workflowReplacesModuleCachePopulated = true;
    try {
      const all = workflowAutomationEngine.list?.() || [];
      for (const wf of all) {
        if (wf?.enabled === false) continue;
        const replaces = wf?.metadata?.replaces?.module;
        if (replaces) _workflowReplacesModuleCache.add(replaces);
      }
    } catch { /* best effort */ }
  }
  return _workflowReplacesModuleCache.has(moduleName);
}

function allowWorkflowEvent(dedupKey, windowMs = workflowEventDedupWindowMs) {
  if (!dedupKey) return true;
  const now = Date.now();
  const last = workflowEventDedup.get(dedupKey) || 0;
  if (now - last < windowMs) return false;
  workflowEventDedup.set(dedupKey, now);
  if (workflowEventDedup.size > 1000) {
    const cutoff = now - windowMs * 2;
    for (const [key, ts] of workflowEventDedup) {
      if (ts < cutoff) workflowEventDedup.delete(key);
    }
  }
  return true;
}

function buildWorkflowEventPayload(eventType, eventData = {}) {
  const payload =
    eventData && typeof eventData === "object" ? { ...eventData } : {};
  payload.eventType = eventType;
  if (String(eventType || "").startsWith("pr.")) {
    const prEvent = String(eventType).slice(3).trim();
    if (prEvent) payload.prEvent = prEvent;
  }
  payload._triggerSource = "monitor-event";
  payload._triggerEventType = eventType;
  payload._triggeredAt = new Date().toISOString();
  return payload;
}

const DEFAULT_WORKFLOW_RECOVERY_POLICY = Object.freeze({
  maxAttempts: 5,
  escalationWarnAfterAttempts: 3,
  baseBackoffMs: 5000,
  maxBackoffMs: 60_000,
  jitterRatio: 0.2,
});

let workflowRecoveryPolicy = DEFAULT_WORKFLOW_RECOVERY_POLICY;

const workflowRecoveryState = new Map();
const workflowRecoveryTimers = new Map();

function emitWorkflowRecoveryTelemetry(eventName, details = {}) {
  const payload = {
    ts: new Date().toISOString(),
    component: "monitor.workflow-recovery",
    event: eventName,
    ...details,
  };
  console.log(`[monitor-telemetry] ${JSON.stringify(payload)}`);
}

function normalizeWorkflowRecoveryPolicy(candidate = {}) {
  const policy =
    candidate && typeof candidate === "object" ? candidate : {};
  const maxAttempts = parseEnvInteger(
    policy.maxAttempts,
    DEFAULT_WORKFLOW_RECOVERY_POLICY.maxAttempts,
    { min: 1, max: 20 },
  );
  const escalationWarnAfterAttempts = parseEnvInteger(
    policy.escalationWarnAfterAttempts,
    DEFAULT_WORKFLOW_RECOVERY_POLICY.escalationWarnAfterAttempts,
    { min: 1, max: maxAttempts },
  );
  return Object.freeze({
    maxAttempts,
    escalationWarnAfterAttempts,
    baseBackoffMs: parseEnvInteger(
      policy.baseBackoffMs,
      DEFAULT_WORKFLOW_RECOVERY_POLICY.baseBackoffMs,
      { min: 50, max: 60_000 },
    ),
    maxBackoffMs: parseEnvInteger(
      policy.maxBackoffMs,
      DEFAULT_WORKFLOW_RECOVERY_POLICY.maxBackoffMs,
      { min: 1000, max: 30 * 60 * 1000 },
    ),
    jitterRatio: parseEnvNumber(
      policy.jitterRatio,
      DEFAULT_WORKFLOW_RECOVERY_POLICY.jitterRatio,
      { min: 0, max: 0.9 },
    ),
  });
}

function isWorkflowRecoveryPolicyEqual(left, right) {
  return (
    left?.maxAttempts === right?.maxAttempts &&
    left?.escalationWarnAfterAttempts === right?.escalationWarnAfterAttempts &&
    left?.baseBackoffMs === right?.baseBackoffMs &&
    left?.maxBackoffMs === right?.maxBackoffMs &&
    left?.jitterRatio === right?.jitterRatio
  );
}

function applyWorkflowRecoveryPolicy(nextPolicy, reason = "startup") {
  const normalized = normalizeWorkflowRecoveryPolicy(nextPolicy);
  const changed = !isWorkflowRecoveryPolicyEqual(
    workflowRecoveryPolicy,
    normalized,
  );
  workflowRecoveryPolicy = normalized;
  if (!changed) return;

  for (const operation of workflowRecoveryTimers.keys()) {
    clearWorkflowRecoveryTimer(operation);
  }
  workflowRecoveryState.clear();
  emitWorkflowRecoveryTelemetry("policy_updated", {
    reason,
    policy: normalized,
  });
}

function clearWorkflowRecoveryTimer(operation) {
  const existing = workflowRecoveryTimers.get(operation);
  if (existing) {
    clearTimeout(existing);
    workflowRecoveryTimers.delete(operation);
  }
}

function computeWorkflowRecoveryBackoffMs(attempt) {
  const cappedBase = Math.max(1, workflowRecoveryPolicy.baseBackoffMs);
  const expDelay = Math.min(
    cappedBase * Math.pow(2, Math.max(0, attempt - 1)),
    Math.max(cappedBase, workflowRecoveryPolicy.maxBackoffMs),
  );
  const jitterWindow = Math.max(
    0,
    Math.round(expDelay * workflowRecoveryPolicy.jitterRatio),
  );
  const jitter = jitterWindow > 0
    ? Math.floor(Math.random() * (jitterWindow * 2 + 1)) - jitterWindow
    : 0;
  return Math.max(0, Math.min(
    Math.round(expDelay + jitter),
    Math.max(cappedBase, workflowRecoveryPolicy.maxBackoffMs),
  ));
}

function emitWorkflowRecoverySuppressed(operation, state, reason, metadata = {}) {
  if (!state || !reason) return;
  const counters = state.suppressedCounters || {};
  const nextCount = Number(counters[reason] || 0) + 1;
  counters[reason] = nextCount;
  state.suppressedCounters = counters;
  workflowRecoveryState.set(operation, state);

  if (nextCount !== 1 && nextCount % 10 !== 0) return;
  emitWorkflowRecoveryTelemetry("suppressed", {
    operation,
    reason,
    suppressedCount: nextCount,
    attempts: Number(state.attempts || 0),
    terminalEscalated: state.terminalEscalated === true,
    inFlight: state.inFlight === true,
    nextRetryAt: state.nextRetryAt
      ? new Date(state.nextRetryAt).toISOString()
      : null,
    context: metadata || null,
  });
}

function runWorkflowRecoveryWithPolicy(operation, attemptFn, metadata = {}) {
  const op = String(operation || "").trim();
  if (!op || typeof attemptFn !== "function") return;

  const now = Date.now();
  const state = workflowRecoveryState.get(op) || {
    attempts: 0,
    warningEscalated: false,
    terminalEscalated: false,
    inFlight: false,
    nextRetryAt: 0,
    suppressedCounters: {},
  };
  if (state.terminalEscalated || state.inFlight) {
    emitWorkflowRecoverySuppressed(
      op,
      state,
      state.terminalEscalated ? "terminal-escalated" : "in-flight",
      metadata,
    );
    return;
  }
  if (state.nextRetryAt > now) {
    emitWorkflowRecoverySuppressed(op, state, "cooldown", metadata);
    return;
  }

  const attempt = state.attempts + 1;
  state.inFlight = true;
  workflowRecoveryState.set(op, state);
  emitWorkflowRecoveryTelemetry("attempt", {
    operation: op,
    attempt,
    maxAttempts: workflowRecoveryPolicy.maxAttempts,
    escalationWarnAfterAttempts: workflowRecoveryPolicy.escalationWarnAfterAttempts,
    trigger: metadata?.trigger || "manual",
    context: metadata || null,
  });

  const startedAt = Date.now();
  void Promise.resolve()
    .then(() => attemptFn({ operation: op, attempt }))
    .then(() => {
      clearWorkflowRecoveryTimer(op);
      workflowRecoveryState.delete(op);
      emitWorkflowRecoveryTelemetry("success", {
        operation: op,
        attempt,
        durationMs: Date.now() - startedAt,
        context: metadata || null,
      });
    })
    .catch((err) => {
      const errorMessage = formatMonitorError(err);
      const failureAt = Date.now();
      const willWarnEscalate =
        !state.warningEscalated &&
        attempt >= workflowRecoveryPolicy.escalationWarnAfterAttempts;
      const terminalEscalated = attempt >= workflowRecoveryPolicy.maxAttempts;
      state.attempts = attempt;
      state.lastError = errorMessage;
      state.lastFailureAt = failureAt;
      state.inFlight = false;
      if (willWarnEscalate) {
        state.warningEscalated = true;
      }

      if (terminalEscalated) {
        state.terminalEscalated = true;
        state.nextRetryAt = 0;
        workflowRecoveryState.set(op, state);
        clearWorkflowRecoveryTimer(op);
        emitWorkflowRecoveryTelemetry("escalated", {
          operation: op,
          attempt,
          escalationState: "terminal",
          error: errorMessage,
          durationMs: failureAt - startedAt,
          context: metadata || null,
        });
        console.warn(
          `[workflows] recovery escalated for ${op} after ${attempt} attempt(s): ${errorMessage}`,
        );
        return;
      }

      const backoffMs = computeWorkflowRecoveryBackoffMs(attempt);
      state.nextRetryAt = failureAt + backoffMs;
      workflowRecoveryState.set(op, state);
      emitWorkflowRecoveryTelemetry("retry_scheduled", {
        operation: op,
        attempt,
        error: errorMessage,
        backoffMs,
        nextRetryAt: new Date(state.nextRetryAt).toISOString(),
        escalationState: state.warningEscalated ? "warning" : "none",
        durationMs: failureAt - startedAt,
        context: metadata || null,
      });
      if (willWarnEscalate) {
        console.warn(
          `[workflows] recovery warning for ${op}: ${attempt} consecutive failures (threshold ${workflowRecoveryPolicy.escalationWarnAfterAttempts})`,
        );
      }

      clearWorkflowRecoveryTimer(op);
      const timer = setTimeout(() => {
        workflowRecoveryTimers.delete(op);
        runWorkflowRecoveryWithPolicy(op, attemptFn, {
          ...metadata,
          trigger: "retry-timer",
        });
      }, backoffMs);
      if (typeof timer.unref === "function") timer.unref();
      workflowRecoveryTimers.set(op, timer);
    })
    .finally(() => {
      const current = workflowRecoveryState.get(op);
      if (current) current.inFlight = false;
    });
}

async function ensureWorkflowAutomationEngine() {
  if (!workflowAutomationEnabled || process.env.VITEST) return null;
  if (workflowAutomationEngine) return workflowAutomationEngine;
  if (workflowAutomationInitDone) return null;
  if (workflowAutomationInitPromise) return workflowAutomationInitPromise;

  workflowAutomationInitPromise = (async () => {
    try {
      const childProcessCapability = checkChildProcessLaunch();
      if (!childProcessCapability.ok) {
        throw new Error(
          `workflow automation blocked: Node child-process launch unavailable (${childProcessCapability.code || "unknown"}: ${childProcessCapability.message || "child_process_launch_failed"})`,
        );
      }
      const [{ getWorkflowEngine }, { createTask, getTask }, wfNodes, workflowTemplates] = await Promise.all([
        import("../workflow/workflow-engine.mjs"),
        import("../kanban/kanban-adapter.mjs"),
        import("../workflow/workflow-nodes.mjs"),
        import("../workflow/workflow-templates.mjs"),
      ]);
      if (!wfNodes) {
        throw new Error("workflow nodes unavailable");
      }
      if (typeof wfNodes.ensureWorkflowNodeTypesLoaded === "function") {
        await wfNodes.ensureWorkflowNodeTypesLoaded({ repoRoot });
      }

      const kanbanService = {
        createTask: async (projectIdOrTaskData = {}, taskDataArg = undefined) => {
          const invokedWithProjectId = typeof projectIdOrTaskData === "string";
          const payloadCandidate = invokedWithProjectId ? taskDataArg : projectIdOrTaskData;
          const payload =
            payloadCandidate && typeof payloadCandidate === "object" && !Array.isArray(payloadCandidate)
              ? { ...payloadCandidate }
              : {};
          const backend = getActiveKanbanBackend();
          const projectId = String(
            (invokedWithProjectId ? projectIdOrTaskData : payload?.projectId) ||
              getConfiguredKanbanProjectId(backend) ||
              "",
          ).trim();
          if (!projectId) {
            throw new Error(
              `No project ID configured for backend=${backend} (required for workflow action.create_task)`,
            );
          }
          delete payload.projectId;
          return createTask(projectId, payload);
        },
        updateTaskStatus: async (taskId, status, options = {}) =>
          updateTaskStatus(
            String(taskId || ""),
            String(status || ""),
            options && typeof options === "object" ? options : {},
          ),
        // Required by workflow action.update_task_status to persist patch fields
        // such as blockedReason, branchName, prNumber, prUrl. Without this, the
        // node's `typeof kanban.updateTask === "function"` guard evaluates false
        // and blocked-state transitions land with empty blockedReason, which
        // breaks downstream diagnosis (kanban UI / recovery / Telegram alerts).
        updateTask: async (taskId, patch) =>
          updateKanbanTask(
            String(taskId || "").trim(),
            patch && typeof patch === "object" ? patch : {},
          ),
        listTasks: async (projectId, filters = {}) =>
          listKanbanTasks(String(projectId || ""), filters || {}),
        getTask: async (taskId) =>
          getTask(String(taskId || "").trim()),
      };

      const agentPoolService = {
        launchEphemeralThread,
        launchOrResumeThread,
        execWithRetry,
        async continueSession(sessionId, prompt, opts = {}) {
          const timeout = Number(opts.timeout) || 60 * 60 * 1000;
          const cwd = opts.cwd || process.cwd();
          return launchOrResumeThread(prompt, cwd, timeout, {
            taskKey: sessionId,
            sdk: opts.sdk,
            model: opts.model,
          });
        },
      };

      const telegramService =
        telegramToken && telegramChatId
          ? {
              async sendMessage(chatId, text, options = {}) {
                const target = chatId || telegramChatId;
                if (!target) return;
                await sendTelegramMessage(String(text || ""), {
                  chatId: String(target),
                  silent: Boolean(options?.silent),
                  parseMode: options?.parseMode || undefined,
                });
              },
            }
          : null;

      let meetingService = null;
      try {
        const { createMeetingWorkflowService } = await import("../workflow/meeting-workflow-service.mjs");
        meetingService = createMeetingWorkflowService();
      } catch (err) {
        console.warn(`[workflows] meeting service unavailable: ${err?.message || err}`);
      }

      const plannerPromptInfo = resolvePlannerPromptFallback();
      const promptServices =
        agentPrompts && typeof agentPrompts === "object"
          ? { ...agentPrompts }
          : {};
      if (!normalizePromptBody(promptServices.planner) && plannerPromptInfo.prompt) {
        promptServices.planner = plannerPromptInfo.prompt;
      }
      if (normalizePromptBody(promptServices.planner)) {
        console.log(
          `[workflows] planner prompt source: ${plannerPromptInfo.source} (${plannerPromptInfo.details})`,
        );
      }

      const services = {
        telegram: telegramService,
        kanban: kanbanService,
        taskStore: {
          canStartTask,
        },
        agentPool: agentPoolService,
        meeting: meetingService,
        prompts: Object.keys(promptServices).length > 0 ? promptServices : null,
        anomalyDetector: anomalyDetector || null,
        scheduler: executorScheduler,
        isolatedRunner: {
          run: runInIsolatedRunner,
          getStatus: getIsolatedRunnerPoolStatus,
        },
      };

      const engine = getWorkflowEngine({
        services,
        workflowDir: resolve(repoRoot, ".bosun", "workflows"),
        runsDir: resolve(repoRoot, ".bosun", "workflow-runs"),
        configDir: repoRoot,
      });

      if (!engine.__bosunWorkflowStatusBroadcastAttached) {
        engine.__bosunWorkflowStatusBroadcastAttached = true;
        engine.on("workflow:status", (payload) => {
          try {
            globalThis.__bosun_broadcastWorkflowStatusEvent?.(payload);
          } catch {
            // best effort; TUI clients can still read persisted history
          }
        });
      }

      const configuredWorkflowProfile =
        config?.workflowDefaults && typeof config.workflowDefaults === "object"
          ? config.workflowDefaults.profile || "balanced"
          : "balanced";
      const configuredWorkflowTemplates =
        config?.workflowDefaults && typeof config.workflowDefaults === "object"
          ? config.workflowDefaults.templates || []
          : [];
      const typedWorkflowTemplateConfig =
        typeof workflowTemplates?.resolveWorkflowTemplateConfig === "function"
          ? workflowTemplates.resolveWorkflowTemplateConfig(config?.workflows || [])
          : { templateIds: [], overridesById: {} };

      const requestedTemplateIds = new Set(
        typeof workflowTemplates?.resolveWorkflowTemplateIds === "function"
          ? workflowTemplates.resolveWorkflowTemplateIds({
              profileId: configuredWorkflowProfile,
              templateIds: configuredWorkflowTemplates,
              workflows: config?.workflows || [],
            })
          : [],
      );
      for (const templateId of typedWorkflowTemplateConfig.templateIds || []) {
        const overrides = typedWorkflowTemplateConfig.overridesById?.[templateId] || {};
        let installed = (engine.list?.() || []).find(
          (wf) => String(wf?.metadata?.installedFrom || "").trim() === templateId,
        );

        if (!installed && typeof workflowTemplates?.installTemplate === "function") {
          installed = workflowTemplates.installTemplate(templateId, engine, overrides);
        }

        if (!installed) continue;
        const def = engine.get?.(installed.id);
        if (!def) continue;

        // Respect pausedByWorkflow — don't force-enable workflows that were
        // temporarily paused by another workflow (e.g. PR watchdog pausing
        // Task Lifecycle while repair work is in progress).
        if (!def.metadata?.pausedByWorkflow) {
          def.enabled = true;
        }
        def.variables = {
          ...(def.variables || {}),
          ...overrides,
        };
        def.metadata = {
          ...(def.metadata || {}),
          configuredFrom: "workflows.config",
        };
        engine.save(def);
      }

      const staleWorkflowTemplateIds = ["template-task-batch-pr", "template-continuation-loop"];
      if (typeof workflowTemplates?.reconcileInstalledTemplates === "function") {
        const reconcile = workflowTemplates.reconcileInstalledTemplates(engine, {
          autoUpdateUnmodified: true,
          forceUpdateTemplateIds: [
            "template-task-batch-processor",
            "template-task-lifecycle",
            "template-task-finalization-guard",
            "template-agent-session-monitor",
            "template-bosun-pr-watchdog",
            "template-bosun-pr-progressor",
            "template-github-kanban-sync",
            "template-recover-blocked-task",
            "template-recover-blocked-worktrees",
          ],
        });
        if (Number(reconcile?.autoUpdated || 0) > 0) {
          console.log(
            `[workflows] reconciled template-backed workflow(s): ${reconcile.autoUpdated} updated` +
              (Array.isArray(reconcile?.forceUpdated) && reconcile.forceUpdated.length > 0
                ? ` (${reconcile.forceUpdated.length} forced)`
                : ""),
          );
        }
        if (Array.isArray(reconcile?.criticalRemaining) && reconcile.criticalRemaining.length > 0) {
          const criticalSummary = reconcile.criticalRemaining
            .map((entry) => {
              const workflowId = String(entry?.workflowId || "").trim() || "workflow-unknown";
              const templateId = String(entry?.templateId || "").trim() || "template-unknown";
              const issueCodes = (Array.isArray(entry?.issues) ? entry.issues : [])
                .map((issue) => String(issue?.code || "").trim())
                .filter(Boolean)
                .join(",");
              return `${workflowId}:${templateId}${issueCodes ? `:${issueCodes}` : ""}`;
            })
            .join("; ");
          throw new Error(`Startup-critical workflow template mismatch remains after reconcile: ${criticalSummary}`);
        }
        if (
          typeof engine.load === "function" &&
          (Number(reconcile?.autoUpdated || 0) > 0 ||
            Number(reconcile?.metadataUpdated || 0) > 0 ||
            (Array.isArray(reconcile?.updatedWorkflowIds) &&
              reconcile.updatedWorkflowIds.length > 0))
        ) {
          engine.load();
        }
      }
      for (const summary of engine.list?.() || []) {
        const installedFrom = String(summary?.metadata?.installedFrom || "").trim();
        if (!staleWorkflowTemplateIds.includes(installedFrom)) continue;
        if (requestedTemplateIds.has(installedFrom)) continue;
        if (summary?.enabled === false) continue;
        const def = engine.get?.(summary.id);
        if (!def || def.enabled === false) continue;
        def.enabled = false;
        def.metadata = {
          ...(def.metadata || {}),
          autoDisabledReason:
            "disabled on startup because the template is no longer requested by workflowDefaults/workflows config",
        };
        engine.save(def);
        console.log(
          "[workflows] auto-disabled stale workflow " + (def.name || def.id) + " (" + installedFrom + ")",
        );
      }

      workflowAutomationEngine = engine;
      bindWorkflowEngineToAnomalyDetector(engine);

      if (!workflowAutomationReadyLogged) {
        workflowAutomationReadyLogged = true;
        const all = engine.list?.() || [];
        const total = all.length;
        const enabled = all.filter((wf) => wf?.enabled !== false).length;
        console.log(
          `[workflows] automation enabled — loaded ${enabled}/${total} workflow(s)`,
        );

        // Populate the legacy-module replacement cache so callers of
        // isWorkflowReplacingModule() get instant answers.
        _workflowReplacesModuleCachePopulated = true;
        _workflowReplacesModuleCache.clear();
        const replaced = [];
        for (const wf of all) {
          if (wf?.enabled === false) continue;
          const mod = wf?.metadata?.replaces?.module;
          if (mod) {
            _workflowReplacesModuleCache.add(mod);
            replaced.push(mod);
          }
        }
        if (replaced.length > 0) {
          console.log(
            `[workflows] legacy modules paused (replaced by workflows): ${replaced.join(", ")}`,
          );
        }
      }

      workflowAutomationInitDone = true;
      return engine;
    } catch (err) {
      workflowAutomationInitDone = false;
      if (!workflowAutomationUnavailableLogged) {
        workflowAutomationUnavailableLogged = true;
        console.warn(
          `[workflows] automation unavailable: ${err?.message || err}`,
        );
      }
      return null;
    } finally {
      workflowAutomationInitPromise = null;
    }
  })();

  return workflowAutomationInitPromise;
}

async function dispatchWorkflowEvent(eventType, eventData = {}, opts = {}) {
  try {
  if (!workflowAutomationEnabled && !opts?.engine) return false;
  const dedupKey = String(opts?.dedupKey || "").trim();
  if (dedupKey && !allowWorkflowEvent(dedupKey)) {
    return false;
  }

  const engine = opts?.engine || await ensureWorkflowAutomationEngine();
  if (!engine?.evaluateTriggers || !engine?.execute) return false;

  const payload = buildWorkflowEventPayload(eventType, eventData);
  let triggered = [];
  try {
    triggered = await engine.evaluateTriggers(eventType, payload);
  } catch (err) {
    console.warn(
      `[workflows] trigger evaluation failed for ${eventType}: ${err?.message || err}`,
    );
    return false;
  }

  if (!Array.isArray(triggered) || triggered.length === 0) {
    return false;
  }
  const awaitRuns = opts?.awaitRuns === true;
  const runPromises = [];
  for (const match of triggered) {
    const workflowId = String(match?.workflowId || "").trim();
    if (!workflowId) continue;
    const runPayload = {
      ...payload,
      _triggeredBy: match?.triggeredBy || null,
    };
    const runPromise = engine
      .execute(workflowId, runPayload)
      .then((ctx) => {
        const runId = ctx?.id || "unknown";
        const runStatus =
          Array.isArray(ctx?.errors) && ctx.errors.length > 0
            ? "failed"
            : "completed";
        console.log(
          `[workflows] auto-run ${runStatus} workflow=${workflowId} runId=${runId} event=${eventType}`,
        );
        return { workflowId, runId, runStatus, ctx };
      })
      .catch((err) => {
        console.warn(
          `[workflows] auto-run failed workflow=${workflowId} event=${eventType}: ${err?.message || err}`,
        );
        if (awaitRuns) {
          throw err;
        }
        return null;
      });
    if (awaitRuns) {
      runPromises.push(runPromise);
    } else {
      void runPromise;
    }
  }

  console.log(
    `[workflows] event "${eventType}" triggered ${triggered.length} workflow run(s)`,
  );
  if (awaitRuns) {
    return {
      triggered: true,
      triggeredCount: triggered.length,
      runs: (await Promise.all(runPromises)).filter(Boolean),
    };
  }
  return true;
  } catch (err) {
    console.warn(`[workflows] dispatchWorkflowEvent error for ${eventType}: ${err?.message || err}`);
    return false;
  }
}

function queueWorkflowEvent(eventType, eventData = {}, opts = {}) {
  dispatchWorkflowEvent(eventType, eventData, opts).catch(() => {});
}

const REVIEW_FIX_HANDOFF_MODES = Object.freeze({
  ACTIVE_SESSION_STEERING: "active_session_steering",
  REVIEW_REDISPATCH: "review_redispatch",
});

const REVIEW_FIX_HANDOFF_STATES = Object.freeze({
  ACTIVE_SESSION_ATTACHED: "active_session_attached",
  SESSION_REBIND_REQUESTED: "session_rebind_requested",
});

// ── GitHub webhook → workflow-engine bridge ──────────────────────────────────
// Forwards GitHub App webhook events from the OAuth portal's EventEmitter into
// the workflow trigger engine so that trigger.event nodes with
// eventType: "github:*" fire in real-time instead of requiring polling.

const _GITHUB_BRIDGE_EVENTS = [
  "github:pull_request",
  "github:pull_request_review",
  "github:pull_request_review_comment",
  "github:check_run",
  "github:check_suite",
  "github:push",
  "github:issue_comment",
  "github:status",
  "github:workflow_run",
  "github:workflow_job",
  "github:installation",
  "github:installation_repositories",
];

let _githubWebhookBridgeSetup = false;

function setupGitHubWebhookBridge() {
  if (_githubWebhookBridgeSetup) return;
  _githubWebhookBridgeSetup = true;
  try {
    for (const eventType of _GITHUB_BRIDGE_EVENTS) {
      _githubWebhookEvents.on(eventType, ({ action, payload } = {}) => {
        const pr = payload?.pull_request;
        const cr = payload?.check_run;
        queueWorkflowEvent(eventType, {
          eventType,
          action:          action ?? null,
          repo:            payload?.repository?.full_name ?? null,
          // PR fields (available in pull_request, review, and review_comment events)
          prNumber:        pr?.number ?? payload?.number ?? cr?.pull_requests?.[0]?.number ?? null,
          prTitle:         pr?.title ?? null,
          prBranch:        pr?.head?.ref ?? cr?.head_branch ?? null,
          prBaseBranch:    pr?.base?.ref ?? null,
          prAuthor:        pr?.user?.login ?? null,
          prUrl:           pr?.html_url ?? null,
          // Check run fields
          checkName:       cr?.name ?? null,
          checkConclusion: cr?.conclusion ?? null,
          checkStatus:     cr?.status ?? null,
          // Review fields
          reviewState:     payload?.review?.state ?? null,
          // Push / ref fields
          ref:             payload?.ref ?? null,
          commitSha:       payload?.after ?? payload?.head_commit?.id ?? null,
          // Full payload available for complex filter expressions
          payload,
        });
      });
    }
    console.log("[workflows] GitHub webhook bridge active — forwarding " + _GITHUB_BRIDGE_EVENTS.length + " event type(s)");
  } catch (err) {
    console.warn(`[workflows] GitHub webhook bridge setup failed: ${err?.message || err}`);
  }
}

function normalizePromptBody(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolvePlannerPromptCandidate(prompt, source, details, sourcePath, documentationContext = false) {
  const normalizedPrompt = normalizePromptBody(prompt);
  if (!normalizedPrompt) return null;

  const decision = evaluateMarkdownSafety(
    normalizedPrompt,
    {
      channel: "planner-prompt",
      sourceKind: "prompt",
      sourcePath,
      sourceRoot: repoRoot || process.cwd(),
      documentationContext,
    },
    config?.markdownSafety || {},
  );
  if (!decision.blocked) {
    return {
      prompt: normalizedPrompt,
      source,
      details,
    };
  }

  recordMarkdownSafetyAuditEvent(
    {
      channel: "planner-prompt",
      sourceKind: "prompt",
      sourcePath,
      source,
      details,
      reasons: decision.safety.reasons,
      score: decision.safety.score,
      findings: decision.safety.findings,
    },
    { policy: config?.markdownSafety || {}, rootDir: repoRoot || process.cwd() },
  );
  console.warn(
    `[workflows] blocked unsafe planner prompt from ${sourcePath}: ${decision.safety.reasons.join(", ")}`,
  );
  return null;
}

function resolvePlannerPromptFallback() {
  const explicitPlannerPrompt = normalizePromptBody(agentPrompts?.planner);
  if (explicitPlannerPrompt) {
    return {
      prompt: explicitPlannerPrompt,
      source: "config",
      details: "agentPrompts.planner",
    };
  }

  const envPlannerPath = String(process.env.BOSUN_PROMPT_PLANNER || "").trim();
  if (envPlannerPath) {
    try {
      if (existsSync(envPlannerPath)) {
        const promptFromEnvPath = resolvePlannerPromptCandidate(
          readFileSync(envPlannerPath, "utf8"),
          "env",
          `BOSUN_PROMPT_PLANNER=${envPlannerPath}`,
          envPlannerPath,
        );
        if (promptFromEnvPath) {
          return promptFromEnvPath;
        }
      }
    } catch {
      // best effort
    }
  }

  const workspaceRoot = String(repoRoot || process.cwd()).trim() || process.cwd();
  try {
    syncAutoDiscoveredLibraryEntries(workspaceRoot);
  } catch {
    // best effort
  }
  try {
    const resolved = resolveEntry(workspaceRoot, "task-planner");
    const promptFromLibrary = resolvePlannerPromptCandidate(
      resolved?.content,
      `library:${resolved?.source || "workspace"}`,
      "entry id task-planner",
      resolved?.sourcePath || resolved?.path || "task-planner",
    );
    if (promptFromLibrary) {
      return promptFromLibrary;
    }
  } catch {
    // best effort
  }

  const promptPath = resolve(workspaceRoot, ".bosun", "agents", "task-planner.md");
  try {
    if (existsSync(promptPath)) {
      const promptFromFile = resolvePlannerPromptCandidate(
        readFileSync(promptPath, "utf8"),
        "file",
        promptPath,
        promptPath,
      );
      if (promptFromFile) {
        return promptFromFile;
      }
    }
  } catch {
    // best effort
  }

  return {
    prompt: "",
    source: "none",
    details: "not found",
  };
}

const PLANNER_PATTERN_COUNTER_RELATIVE_PATH =
  ".bosun/workflow-runs/planner-pattern-feedback.json";
const PLANNER_FAILURE_SIGNAL_WEIGHTS = Object.freeze({
  agentAttempts: 0.35,
  consecutiveNoCommits: 1.25,
  blockedReason: 1.5,
  debtTrend: 0.4,
  taskDebt: 0.5,
});
const PLANNER_FAILURE_COUNTER_DECAY = 0.8;
const PLANNER_FAILURE_COUNTER_IDLE_DECAY = 0.95;
const PLANNER_FAILURE_THRESHOLD = 2.5;

function normalizePlannerAreaKey(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePlannerArchetypeKey(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "general";
}

function inferPlannerTaskArchetype(task) {
  const explicit =
    task?.meta?.planner?.archetype ||
    task?.meta?.archetype ||
    task?.archetype ||
    "";
  if (String(explicit || "").trim()) {
    return normalizePlannerArchetypeKey(explicit);
  }
  const title = String(task?.title || "").trim().toLowerCase();
  const conventional = title.match(
    /^(?:\[[^\]]+\]\s*)?([a-z][a-z0-9_-]*)(?:\([^)]*\))?:/,
  );
  if (conventional?.[1]) return normalizePlannerArchetypeKey(conventional[1]);
  if (title.includes("test")) return "test";
  if (title.includes("doc")) return "docs";
  if (title.includes("refactor")) return "refactor";
  return "general";
}

function resolvePlannerTaskPatternAreas(task) {
  const candidates = []
    .concat(Array.isArray(task?.repo_areas) ? task.repo_areas : [])
    .concat(Array.isArray(task?.repoAreas) ? task.repoAreas : [])
    .concat(Array.isArray(task?.meta?.repo_areas) ? task.meta.repo_areas : [])
    .concat(Array.isArray(task?.meta?.repoAreas) ? task.meta.repoAreas : [])
    .concat(
      Array.isArray(task?.meta?.planner?.repo_areas)
        ? task.meta.planner.repo_areas
        : [],
    )
    .concat(
      Array.isArray(task?.meta?.planner?.repoAreas)
        ? task.meta.planner.repoAreas
        : [],
    );
  if (!candidates.length) return ["global"];
  const dedup = new Set();
  const areas = [];
  for (const candidate of candidates) {
    const areaKey = normalizePlannerAreaKey(candidate);
    if (!areaKey || dedup.has(areaKey)) continue;
    dedup.add(areaKey);
    areas.push(areaKey);
  }
  return areas.length > 0 ? areas : ["global"];
}

function buildPlannerPatternKey(repoArea, archetype) {
  return `${normalizePlannerAreaKey(repoArea) || "global"}::${normalizePlannerArchetypeKey(archetype)}`;
}

function readPlannerPatternCounterState(baseDir) {
  const statePath = resolve(
    baseDir || process.cwd(),
    PLANNER_PATTERN_COUNTER_RELATIVE_PATH,
  );
  if (!existsSync(statePath)) {
    return { statePath, state: { patterns: {} } };
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    const patterns =
      parsed?.patterns && typeof parsed.patterns === "object"
        ? parsed.patterns
        : {};
    return {
      statePath,
      state: {
        updatedAt: String(parsed?.updatedAt || "").trim() || null,
        patterns,
      },
    };
  } catch {
    return { statePath, state: { patterns: {} } };
  }
}

function writePlannerPatternCounterState(statePath, state) {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          patterns:
            state?.patterns && typeof state.patterns === "object"
              ? state.patterns
              : {},
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    // best effort
  }
}

function buildPlannerFeedback() {
  const tasks = Array.isArray(getAllInternalTasks?.()) ? getAllInternalTasks() : [];
  const statusCounts = {
    todo: 0,
    inprogress: 0,
    inreview: 0,
    blocked: 0,
    done: 0,
    other: 0,
  };
  const blockedReasonCounts = new Map();
  const hotTasks = [];
  const patternObservations = new Map();
  const taskDebtWeightById = new Map();
  let attemptedCount = 0;
  let noCommitCount = 0;

  let debtEntries = [];
  try {
    debtEntries = readTaskDebtEntries({ baseDir: repoRoot, limit: 300 });
  } catch {
    debtEntries = [];
  }

  const now = Date.now();
  const recentWindowMs = 7 * 24 * 60 * 60 * 1000;
  const previousWindowMs = 14 * 24 * 60 * 60 * 1000;
  const recentDebtEntries = debtEntries.filter((entry) => {
    const ts = Date.parse(String(entry?.recordedAt || ""));
    return Number.isFinite(ts) && now - ts <= recentWindowMs;
  });
  const previousDebtEntries = debtEntries.filter((entry) => {
    const ts = Date.parse(String(entry?.recordedAt || ""));
    return Number.isFinite(ts) && now - ts > recentWindowMs && now - ts <= previousWindowMs;
  });
  const debtSeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  const previousDebtSeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const entry of recentDebtEntries) {
    for (const item of Array.isArray(entry?.debtItems) ? entry.debtItems : []) {
      const severity = String(item?.severity || "").trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(debtSeverityCounts, severity)) {
        debtSeverityCounts[severity] += 1;
        const taskId = String(entry?.taskId || "").trim();
        if (taskId) {
          const severityWeight = severity === "critical"
            ? 2
            : severity === "high"
              ? 1.5
              : severity === "medium"
                ? 1
                : 0.5;
          taskDebtWeightById.set(
            taskId,
            (taskDebtWeightById.get(taskId) || 0) + severityWeight,
          );
        }
      }
    }
  }
  for (const entry of previousDebtEntries) {
    for (const item of Array.isArray(entry?.debtItems) ? entry.debtItems : []) {
      const severity = String(item?.severity || "").trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(previousDebtSeverityCounts, severity)) {
        previousDebtSeverityCounts[severity] += 1;
      }
    }
  }

  const weightedDebtSeverity = (counts) =>
    (counts.critical * 2) + (counts.high * 1.5) + counts.medium + (counts.low * 0.5);
  const recentDebtWeighted = weightedDebtSeverity(debtSeverityCounts);
  const previousDebtWeighted = weightedDebtSeverity(previousDebtSeverityCounts);
  const debtTrendDelta = recentDebtWeighted - previousDebtWeighted;
  const debtTrendPenalty = debtTrendDelta > 0
    ? Math.min(2, (debtTrendDelta / 8) * PLANNER_FAILURE_SIGNAL_WEIGHTS.debtTrend)
    : 0;

  for (const task of tasks) {
    const status = String(task?.status || "").trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(statusCounts, status)) {
      statusCounts[status] += 1;
    } else {
      statusCounts.other += 1;
    }

    const taskId = String(task?.id || "").trim();
    const agentAttempts = Number(task?.agentAttempts || 0);
    const consecutiveNoCommits = Number(task?.consecutiveNoCommits || 0);
    const blockedReason = String(task?.blockedReason || "").trim();
    if (agentAttempts > 0) attemptedCount += 1;
    if (consecutiveNoCommits > 0) noCommitCount += 1;
    if (blockedReason) {
      blockedReasonCounts.set(
        blockedReason,
        (blockedReasonCounts.get(blockedReason) || 0) + 1,
      );
    }

    const attemptPenalty =
      Math.min(Math.max(0, agentAttempts), 6) * PLANNER_FAILURE_SIGNAL_WEIGHTS.agentAttempts;
    const noCommitPenalty =
      Math.min(Math.max(0, consecutiveNoCommits), 4) * PLANNER_FAILURE_SIGNAL_WEIGHTS.consecutiveNoCommits;
    const blockedPenalty = blockedReason ? PLANNER_FAILURE_SIGNAL_WEIGHTS.blockedReason : 0;
    const taskDebtPenalty =
      Math.min(2, (taskDebtWeightById.get(taskId) || 0) * PLANNER_FAILURE_SIGNAL_WEIGHTS.taskDebt);
    const failureSignal =
      attemptPenalty +
      noCommitPenalty +
      blockedPenalty +
      taskDebtPenalty +
      debtTrendPenalty;
    const terminalSuccess = ["done", "completed", "closed"].includes(status);
    const successSignal =
      terminalSuccess &&
      agentAttempts > 0 &&
      consecutiveNoCommits <= 0 &&
      !blockedReason
        ? 1
        : 0;
    const archetype = inferPlannerTaskArchetype(task);
    const areas = resolvePlannerTaskPatternAreas(task);

    for (const area of areas) {
      const key = buildPlannerPatternKey(area, archetype);
      let entry = patternObservations.get(key);
      if (!entry) {
        entry = {
          key,
          repoArea: area,
          archetype,
          failures: 0,
          successes: 0,
          failureSignalTotal: 0,
          successSignalTotal: 0,
        };
        patternObservations.set(key, entry);
      }
      if (failureSignal > 0) {
        entry.failureSignalTotal += failureSignal;
      }
      if (failureSignal >= 0.75) {
        entry.failures += 1;
      }
      if (successSignal > 0) {
        entry.successSignalTotal += successSignal;
        entry.successes += 1;
      }
    }

    if (
      agentAttempts > 0 ||
      consecutiveNoCommits > 0 ||
      blockedReason ||
      status === "blocked"
    ) {
      hotTasks.push({
        taskId,
        title: String(task?.title || "").trim(),
        status: status || null,
        agentAttempts: agentAttempts || 0,
        consecutiveNoCommits: consecutiveNoCommits || 0,
        blockedReason: blockedReason || null,
        failureSignal: Number(failureSignal.toFixed(2)),
        archetype,
        repoAreas: areas,
      });
    }
  }

  hotTasks.sort((a, b) => {
    if ((b.failureSignal || 0) !== (a.failureSignal || 0)) {
      return (b.failureSignal || 0) - (a.failureSignal || 0);
    }
    if ((b.consecutiveNoCommits || 0) !== (a.consecutiveNoCommits || 0)) {
      return (b.consecutiveNoCommits || 0) - (a.consecutiveNoCommits || 0);
    }
    if ((b.agentAttempts || 0) !== (a.agentAttempts || 0)) {
      return (b.agentAttempts || 0) - (a.agentAttempts || 0);
    }
    return String(a.taskId || "").localeCompare(String(b.taskId || ""));
  });

  const persistedCounter = readPlannerPatternCounterState(repoRoot);
  const previousPatternState =
    persistedCounter?.state?.patterns && typeof persistedCounter.state.patterns === "object"
      ? persistedCounter.state.patterns
      : {};
  const nextPatternState = {};
  const observedKeys = new Set(patternObservations.keys());

  for (const [key, observation] of patternObservations.entries()) {
    const previous = previousPatternState[key] || {};
    const previousCounter = Number(previous.failureCounter || 0);
    const nextCounter = Math.max(
      0,
      (previousCounter * PLANNER_FAILURE_COUNTER_DECAY) +
        observation.failureSignalTotal -
        (observation.successSignalTotal * 1.1),
    );
    nextPatternState[key] = {
      key,
      repoArea: observation.repoArea,
      archetype: observation.archetype,
      observations: Number(previous.observations || 0) + 1,
      failures: Number(previous.failures || 0) + observation.failures,
      successes: Number(previous.successes || 0) + observation.successes,
      failureSignal: Number(observation.failureSignalTotal.toFixed(2)),
      successSignal: Number(observation.successSignalTotal.toFixed(2)),
      failureCounter: Number(nextCounter.toFixed(3)),
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  for (const [key, previous] of Object.entries(previousPatternState)) {
    if (observedKeys.has(key)) continue;
    const previousCounter = Number(previous?.failureCounter || 0);
    if (previousCounter <= 0) continue;
    nextPatternState[key] = {
      ...previous,
      failureCounter: Number(
        Math.max(0, previousCounter * PLANNER_FAILURE_COUNTER_IDLE_DECAY).toFixed(3),
      ),
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  writePlannerPatternCounterState(persistedCounter.statePath, {
    patterns: nextPatternState,
  });

  const rankedPatternCounters = Object.values(nextPatternState)
    .map((entry) => {
      const failureCounter = Number(entry?.failureCounter || 0);
      const negativePrior = failureCounter > PLANNER_FAILURE_THRESHOLD
        ? Number(((failureCounter - PLANNER_FAILURE_THRESHOLD) * 0.6).toFixed(3))
        : 0;
      return {
        key: String(entry?.key || "").trim(),
        repoArea: String(entry?.repoArea || "").trim() || "global",
        archetype: normalizePlannerArchetypeKey(entry?.archetype),
        failureCounter,
        failures: Number(entry?.failures || 0),
        successes: Number(entry?.successes || 0),
        negativePrior,
      };
    })
    .sort((a, b) => {
      if ((b.negativePrior || 0) !== (a.negativePrior || 0)) {
        return (b.negativePrior || 0) - (a.negativePrior || 0);
      }
      if ((b.failureCounter || 0) !== (a.failureCounter || 0)) {
        return (b.failureCounter || 0) - (a.failureCounter || 0);
      }
      return String(a.key || "").localeCompare(String(b.key || ""));
    })
    .slice(0, 50);

  const blockedTop = [...blockedReasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));
  const hotTaskSignals = hotTasks.slice(0, 10);

  const summaryParts = [
    `tasks=${tasks.length}`,
    `todo=${statusCounts.todo}`,
    `inprogress=${statusCounts.inprogress}`,
    `inreview=${statusCounts.inreview}`,
    `blocked=${statusCounts.blocked}`,
    `attempted=${attemptedCount}`,
    `noCommitHot=${noCommitCount}`,
    `debtRecent7d=${recentDebtEntries.length}`,
    `debtCriticalHigh=${debtSeverityCounts.critical + debtSeverityCounts.high}`,
    `debtTrendDelta=${Number(debtTrendDelta.toFixed(2))}`,
    `penalizedPatterns=${rankedPatternCounters.filter((entry) => entry.negativePrior > 0).length}`,
  ];
  const blockedSummary = blockedTop.length > 0
    ? blockedTop.map((item) => `${item.reason}(${item.count})`).join(", ")
    : "none";
  const feedbackSummary =
    `Planner feedback: ${summaryParts.join(", ")}. ` +
    `Top blocked reasons: ${blockedSummary}.`;

  return {
    generatedAt: new Date().toISOString(),
    summary: feedbackSummary,
    taskStore: {
      taskCount: tasks.length,
      statusCounts,
      attemptedCount,
      noCommitCount,
      blockedReasons: blockedTop,
      hotTasks: hotTaskSignals,
    },
    debtLedger: {
      totalEntries: debtEntries.length,
      recentEntries7d: recentDebtEntries.length,
      severityCounts7d: debtSeverityCounts,
      previousSeverityCounts7d: previousDebtSeverityCounts,
      trendDelta: Number(debtTrendDelta.toFixed(2)),
    },
    rankingSignals: {
      failureThreshold: PLANNER_FAILURE_THRESHOLD,
      debtTrendDelta: Number(debtTrendDelta.toFixed(2)),
      debtTrendPenalty: Number(debtTrendPenalty.toFixed(3)),
      weights: PLANNER_FAILURE_SIGNAL_WEIGHTS,
      patterns: rankedPatternCounters,
    },
  };
}

function resolvePlannerWorkspaceDefaults() {
  const activeWorkspace = String(
    config?.activeWorkspace || process.env.BOSUN_WORKSPACE || "",
  ).trim();
  const repositories = Array.isArray(config?.repositories)
    ? config.repositories
    : [];
  const scopedRepositories = activeWorkspace
    ? repositories.filter((repo) =>
      String(repo?.workspace || "").trim().toLowerCase() === activeWorkspace.toLowerCase())
    : repositories;
  const candidateRepositories = scopedRepositories.length > 0
    ? scopedRepositories
    : repositories;
  const selectedRepository =
    candidateRepositories.find((repo) => repo?.primary) ||
    candidateRepositories[0] ||
    null;
  const repository = String(
    selectedRepository?.repository ||
      selectedRepository?.name ||
      repoSlug ||
      process.env.GITHUB_REPOSITORY ||
      "",
  ).trim();
  const workspace = String(
    activeWorkspace || selectedRepository?.workspace || "",
  ).trim();
  return {
    workspace,
    repository,
  };
}

async function triggerTaskPlanner(options = {}) {
  try {
    if (!workflowAutomationEnabled) {
      return {
        ok: false,
        error: "workflow automation disabled",
      };
    }

    const engine = await ensureWorkflowAutomationEngine();
    if (!engine?.execute || !engine?.list) {
      return {
        ok: false,
        error: "workflow engine not available",
      };
    }

    const templateId = "template-task-planner";
    const workflowTemplates = await import("../workflow/workflow-templates.mjs");
    const template = workflowTemplates.getTemplate(templateId);
    if (!template) {
      return {
        ok: false,
        error: `workflow template not found: ${templateId}`,
      };
    }

    let workflow = (engine.list() || []).find(
      (entry) => entry?.metadata?.installedFrom === templateId || entry?.id === templateId,
    );
    if (!workflow) {
      workflow = workflowTemplates.installTemplate(templateId, engine);
    }

    const parsedTaskCount = Number(options?.taskCount);
    const taskCount = Number.isFinite(parsedTaskCount) && parsedTaskCount > 0
      ? Math.max(1, Math.min(100, Math.trunc(parsedTaskCount)))
      : null;
    const prompt = String(options?.prompt || "").trim();
    const reason = String(options?.reason || "manual-trigger").trim() || "manual-trigger";
    const source = String(options?.source || "monitor").trim() || "monitor";
    const defaults = resolvePlannerWorkspaceDefaults();
    const plannerFeedback = buildPlannerFeedback();

    const executeInput = {
      _plannerReason: reason,
      _triggerSource: source,
      _plannerFeedback: plannerFeedback,
      _plannerFeedbackSummary: plannerFeedback.summary,
      ...(taskCount ? { taskCount } : {}),
      ...(prompt ? { prompt } : {}),
      ...(defaults.workspace ? { workspace: defaults.workspace, workspaceId: defaults.workspace } : {}),
      ...(defaults.repository ? { repository: defaults.repository, _targetRepo: defaults.repository } : {}),
      ...(options?.input && typeof options.input === "object" ? options.input : {}),
    };

    const result = await engine.execute(workflow.id, executeInput, { force: true });
    const materializeOutput = result?.getNodeOutput?.("materialize-tasks") ||
      result?.nodeOutputs?.get?.("materialize-tasks") ||
      null;
    const parsedCount = Number(materializeOutput?.parsedCount || 0);
    const createdCount = Number(materializeOutput?.createdCount || 0);
    const runFailed = Array.isArray(result?.errors) && result.errors.length > 0;

    if (runFailed) {
      return {
        ok: false,
        workflowId: workflow.id,
        runId: result?.id || null,
        parsedCount,
        createdCount,
        error: String(result.errors?.[0]?.error || result.errors?.[0]?.message || "workflow execution failed"),
      };
    }

    return {
      ok: true,
      workflowId: workflow.id,
      runId: result?.id || null,
      parsedCount,
      createdCount,
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err),
    };
  }
}

async function maybeTriggerTaskPlanner(reason = "auto", metadata = {}) {
  const result = await triggerTaskPlanner({
    source: "monitor-auto",
    reason,
    input:
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata
        : {},
  });
  if (!result.ok) {
    console.warn(
      `[monitor] planner trigger skipped (${reason}): ${result.error || "unknown error"}`,
    );
    return false;
  }
  console.log(
    `[monitor] planner trigger complete (${reason}): created ${result.createdCount} task(s) from ${result.parsedCount} parsed item(s)`,
  );
  return true;
}

function configureExecutorTaskStatusTransitions() {
  if (!workflowAutomationEnabled) {
    setTaskStatusTransitionHandler(null);
    return;
  }

  setTaskStatusTransitionHandler(async (taskId, status, options = {}) => {
    const normalizedTaskId = String(taskId || "").trim();
    const normalizedStatus = String(status || "").trim().toLowerCase();
    if (!normalizedTaskId || !normalizedStatus) return false;
    const payload =
      options && typeof options === "object" ? { ...options } : {};

    if (payload.bypassWorkflowOwnership === true) {
      return updateTaskStatus(normalizedTaskId, normalizedStatus, {
        ...payload,
        bypassWorkflowOwnership: true,
      });
    }

    queueWorkflowEvent(
      "task.transition.requested",
      {
        taskId: normalizedTaskId,
        targetStatus: normalizedStatus,
        status: normalizedStatus,
        taskTitle: String(payload.taskTitle || "").trim() || null,
        source: String(payload.source || "task-executor").trim() || "task-executor",
        branch: payload.branch || null,
        baseBranch: payload.baseBranch || null,
        worktreePath: payload.worktreePath || null,
        prNumber: payload.prNumber || null,
        prUrl: payload.prUrl || null,
        error: payload.error || null,
      },
      {
        dedupKey:
          payload.workflowDedupKey ||
          `workflow-event:task.transition.requested:${normalizedTaskId}:${normalizedStatus}`,
      },
    );
    return true;
  });
}

async function pollAgentAlerts() {
  if (process.env.VITEST) return;
  const path = getAgentAlertsPath();
  if (!existsSync(path)) return;
  let data;
  try {
    data = await readFile(path, "utf8");
  } catch {
    return;
  }
  if (data.length < agentAlertsOffset) {
    agentAlertsOffset = 0;
  }
  if (!data || data.length <= agentAlertsOffset) return;
  const chunk = data.slice(agentAlertsOffset);
  agentAlertsOffset = data.length;
  const lines = chunk.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let alert;
    try {
      alert = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const dedupKey = `${alert.type || "alert"}:${alert.attempt_id || "unknown"}:${alert.timestamp || ""}`;
    if (agentAlertsDedup.has(dedupKey)) continue;
    rememberAlert(dedupKey);
    console.warn(
      `[agent-work-analyzer] ${alert.severity || "medium"} ${alert.type || "alert"} ${alert.attempt_id || ""}`,
    );
    if (
      telegramToken &&
      telegramChatId &&
      process.env.AGENT_ALERTS_NOTIFY === "true"
    ) {
      runDetached("agent-alerts:notify", () =>
        sendTelegramMessage(formatAgentAlert(alert), {
          dedupKey: `agent-alert:${alert.type || "alert"}:${alert.attempt_id || "unknown"}`,
        }),
      );
    }

    // Act on failed-session alerts: apply a cooldown so task-executor does not
    // immediately restart the same session against a failing API/provider.
    if (
      (alert.type === "failed_session_high_errors" || alert.type === "failed_session_transient_errors") &&
      alert.task_id &&
      internalTaskExecutor
    ) {
      try {
        const taskId = alert.task_id;
        const cooldownMs = alert.type === "failed_session_transient_errors"
          ? 30 * 60_000
          : 15 * 60_000;
        const cooldownUntil = Date.now() + cooldownMs;
        if (typeof internalTaskExecutor.applyTaskCooldown === "function") {
          internalTaskExecutor.applyTaskCooldown(taskId, cooldownUntil);
        } else if (internalTaskExecutor._skipUntil instanceof Map) {
          internalTaskExecutor._skipUntil.set(taskId, cooldownUntil);
        }
        console.warn(
          `[monitor] ${Math.round(cooldownMs / 60_000)}m cooldown applied to task ${taskId} after ${alert.error_count || "?"} API errors (${alert.type}, executor: ${alert.executor || "unknown"})`,
        );
      } catch { /* best effort */ }
    }
  }
  saveAgentAlertsState();
}

function startAgentWorkAnalyzer() {
  if (agentWorkAnalyzerActive) return;
  if (process.env.AGENT_WORK_ANALYZER_ENABLED === "false") return;
  try {
    startAnalyzer().catch((err) => {
      console.warn(`[monitor] agent-work analyzer async error: ${err.message}`);
      agentWorkAnalyzerActive = false;
    });
    agentWorkAnalyzerActive = true;
    console.log("[monitor] agent-work analyzer started");
  } catch (err) {
    console.warn(`[monitor] agent-work analyzer failed to start: ${err.message}`);
  }
}

function stopAgentWorkAnalyzer() {
  if (!agentWorkAnalyzerActive) return;
  try {
    stopAnalyzer();
  } catch {
    /* ignore */
  }
  agentWorkAnalyzerActive = false;
}

function startAgentAlertTailer() {
  if (agentAlertsTimer) return;
  initializeAgentAlertsOffset();
  agentAlertsTimer = setInterval(() => {
    runDetached("agent-alerts:poll-interval", pollAgentAlerts);
  }, AGENT_ALERT_POLL_MS);
  agentAlertsTimer.unref?.();
  runDetached("agent-alerts:poll-startup", pollAgentAlerts);
}

function stopAgentAlertTailer() {
  if (agentAlertsTimer) {
    clearInterval(agentAlertsTimer);
    agentAlertsTimer = null;
  }
}

/**
 * Write an anomaly signal to the shared signal file for the orchestrator to pick up.
 * The orchestrator reads this file in Process-AnomalySignals and acts accordingly.
 */
function writeAnomalySignal(anomaly) {
  try {
    const dir = resolve(__dirname, "..", ".cache");
    mkdirSync(dir, { recursive: true });
    let signals = [];
    try {
      const raw = readFileSync(ANOMALY_SIGNAL_PATH, "utf8");
      signals = JSON.parse(raw);
      if (!Array.isArray(signals)) signals = [];
    } catch {
      /* file doesn't exist yet */
    }
    signals.push({
      type: anomaly.type,
      severity: anomaly.severity,
      action: anomaly.action,
      shortId: anomaly.shortId,
      processId: anomaly.processId,
      message: anomaly.message,
      timestamp: new Date().toISOString(),
    });
    // Cap at 50 signals to prevent unbounded growth
    if (signals.length > 50) signals = signals.slice(-50);
    writeFileSync(ANOMALY_SIGNAL_PATH, JSON.stringify(signals, null, 2));
  } catch (err) {
    console.warn(
      `[anomaly-detector] writeAnomalySignal failed: ${err.message}`,
    );
  }
}

// ── Configure logging before anything else ──────────────────────────────────
configureFromArgs(process.argv.slice(2));
const isMonitorTestRuntime =
  ["1", "true", "yes", "on"].includes(
    String(process.env.VITEST || "")
      .trim()
      .toLowerCase(),
  ) || String(process.env.NODE_ENV || "").trim().toLowerCase() === "test";
// Shared schedule poll hook used across startup/timer sections.
let pollWorkflowSchedulesOnce = async () => {};

// ── Load unified configuration ──────────────────────────────────────────────
let config;
try {
  config = loadConfig();
} catch (err) {
  const message = err?.message || String(err);
  console.error(`[monitor] configuration error: ${message}`);
  process.exit(1);
}
function writeStdoutSafely(chunk) {
  try {
    if (!process.stdout || process.stdout.destroyed || process.stdout.writableEnded) {
      return false;
    }
    process.stdout.write(chunk);
    return true;
  } catch {
    return false;
  }
}

function writeStderrSafely(chunk) {
  try {
    if (!process.stderr || process.stderr.destroyed || process.stderr.writableEnded) {
      return false;
    }
    process.stderr.write(chunk);
    return true;
  } catch {
    return false;
  }
}

function writeMonitorStreamSafely(chunk, { prefer = "stderr" } = {}) {
  if (prefer === "stdout") {
    return writeStdoutSafely(chunk) || writeStderrSafely(chunk);
  }
  return writeStderrSafely(chunk) || writeStdoutSafely(chunk);
}

function appendMonitorCrashBreadcrumb(line) {
  try {
    const crashDir = config?.logDir || resolve(__dirname, "..", "logs");
    mkdirSync(crashDir, { recursive: true });
    appendFileSync(
      resolve(crashDir, "monitor-crash-breadcrumb.log"),
      String(line).endsWith("\n") ? String(line) : `${line}\n`,
    );
  } catch {
    /* best effort */
  }
}
workflowAutomationEnabled = parseEnvBoolean(
  process.env.WORKFLOW_AUTOMATION_ENABLED,
  true,
);
{
  const dedupMs = Number(process.env.WORKFLOW_EVENT_DEDUP_WINDOW_MS || "15000");
  workflowEventDedupWindowMs = Number.isFinite(dedupMs) && dedupMs > 0
    ? dedupMs
    : 15_000;
}
// Wire real-time GitHub webhook events into the workflow trigger engine.
// queueWorkflowEvent is a no-op when automation is disabled, so this is safe
// to call unconditionally at module init time.
if (!process.env.VITEST) setupGitHubWebhookBridge();

// Initialize runtime accumulator for persistent stats across restarts
const runtimeStats = initRuntimeAccumulator();
globalThis.__bosun_runtimeMs = runtimeStats.runtimeMs;
globalThis.__bosun_totalCostUsd = runtimeStats.totalCostUsd;
globalThis.__bosun_sessionTokens = getSessionTokens;

configureExecutorTaskStatusTransitions();

// Install console interceptor with log file (after config provides logDir)
{
  if (!isMonitorTestRuntime) {
    const _logDir = config.logDir || resolve(__dirname, "..", "logs");
    const _logFile = resolve(_logDir, "monitor.log");
    const _errorLogFile = resolve(_logDir, "monitor-error.log");
    installConsoleInterceptor({ logFile: _logFile });
    setErrorLogFile(_errorLogFile);
  }
}

// Guard against core.bare=true corruption on the Bosun repo at startup.
fixGitConfigCorruption(resolve(__dirname, ".."));

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
        const data = JSON.parse(raw);
        const pid = Number(data?.pid);
        if (!canSignalProcess(pid)) {
          await unlink(telegramPollLockPath);
          return await acquireTelegramPollLock(owner);
        }
      } catch {
        /* best effort */
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

let {
  projectName,
  scriptPath,
  scriptArgs,
  restartDelayMs,
  maxRestarts,
  logDir,
  logMaxSizeMb,
  logCleanupIntervalMin,
  watchEnabled,
  watchPath: configWatchPath,
  echoLogs,
  interactiveShellEnabled,
  autoFixEnabled,
  preflightEnabled: configPreflightEnabled,
  preflightRetryMs: configPreflightRetryMs,
  primaryAgent,
  primaryAgentEnabled,
  agentPoolEnabled,
  repoRoot,
  agentRepoRoot,
  statusPath,
  telegramPollLockPath,
  telegramToken,
  telegramChatId,
  telegramIntervalMin,
  telegramCommandPollTimeoutSec,
  telegramCommandConcurrency,
  telegramCommandMaxBatch,
  telegramBotEnabled,
  telegramCommandEnabled,
  repoSlug,
  repoUrlBase,
  kanban: kanbanConfig,
  triggerSystem: configTriggerSystem,
  agentPrompts,
  executorConfig: configExecutorConfig,
  scheduler: executorScheduler,
  agentSdk,
  envPaths,
  dependabotAutoMerge,
  dependabotAutoMergeIntervalMin,
  dependabotMergeMethod,
  dependabotAuthors,
  branchRouting,
  telegramVerbosity,
  fleet: fleetConfig,
  internalExecutor: internalExecutorConfig,
  workflowRecovery: configWorkflowRecovery,
  executorMode: configExecutorMode,
} = config;

applyWorkflowRecoveryPolicy(configWorkflowRecovery, "startup-config");

const telegramWeeklyReportEnabled = parseEnvBoolean(
  process.env.TELEGRAM_WEEKLY_REPORT_ENABLED,
  false,
);
const telegramWeeklyReportDay = parseEnvInteger(
  process.env.TELEGRAM_WEEKLY_REPORT_DAY,
  0,
  { min: 0, max: 6 },
);
const telegramWeeklyReportHour = parseEnvInteger(
  process.env.TELEGRAM_WEEKLY_REPORT_HOUR,
  9,
  { min: 0, max: 23 },
);
const telegramWeeklyReportDays = parseEnvInteger(
  process.env.TELEGRAM_WEEKLY_REPORT_DAYS,
  7,
  { min: 1, max: 30 },
);

let watchPath = resolve(configWatchPath);
let codexEnabled = config.codexEnabled;
let triggerSystemConfig =
  configTriggerSystem && typeof configTriggerSystem === "object"
    ? configTriggerSystem
    : { enabled: false, templates: [], defaults: { executor: "auto", model: "auto" } };
let kanbanBackend = String(kanbanConfig?.backend || "internal").toLowerCase();
let executorMode = configExecutorMode || getExecutorMode();
let chdirUnsupportedInRuntime = false;

function isChdirUnsupportedError(err) {
  if (!err) {
    return false;
  }
  const code = String(err.code || "");
  const message = String(err.message || "").toLowerCase();
  return (
    code === "ERR_WORKER_UNSUPPORTED_OPERATION" ||
    message.includes("process.chdir() is not supported in workers")
  );
}

function normalizePathForCompare(pathValue) {
  const normalized = String(pathValue || "")
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

// ── Ensure CWD is the repo root ─────────────────────────────────────────────
// The daemon is spawned with cwd=homedir (to avoid deleted worktree paths).
// Re-anchor CWD to repoRoot so child processes (esp. Codex CLI) inherit a
// trusted git directory, preventing "Not inside a trusted directory" errors.
// Prefer agentRepoRoot (workspace-aware) over raw repoRoot.
const effectiveRepoRoot = agentRepoRoot || repoRoot;
const needsChdir =
  effectiveRepoRoot &&
  normalizePathForCompare(process.cwd()) !==
    normalizePathForCompare(effectiveRepoRoot);
if (!isMainThread || chdirUnsupportedInRuntime) {
  // Worker threads cannot call process.chdir(); skip to avoid noisy warnings.
} else if (needsChdir) {
  try {
    process.chdir(effectiveRepoRoot);
    console.log(`[monitor] changed CWD to repo root: ${effectiveRepoRoot}`);
    if (agentRepoRoot && agentRepoRoot !== repoRoot) {
      console.log(`[monitor] agent repo root (workspace): ${agentRepoRoot}`);
      console.log(`[monitor] developer repo root: ${repoRoot}`);
    }
  } catch (err) {
    if (isChdirUnsupportedError(err)) {
      chdirUnsupportedInRuntime = true;
      console.log("[monitor] runtime does not support process.chdir(); skipping CWD re-anchor.");
    } else {
      console.warn(`[monitor] could not chdir to ${effectiveRepoRoot}: ${err.message}`);
      // Fall back to repoRoot if agentRepoRoot failed
      if (
        agentRepoRoot &&
        repoRoot &&
        agentRepoRoot !== repoRoot &&
        normalizePathForCompare(process.cwd()) !== normalizePathForCompare(repoRoot)
      ) {
        try {
          process.chdir(repoRoot);
          console.log(`[monitor] fell back to developer repo root: ${repoRoot}`);
        } catch (e2) {
          if (isChdirUnsupportedError(e2)) {
            chdirUnsupportedInRuntime = true;
            console.log("[monitor] runtime does not support process.chdir(); fallback skipped.");
          } else {
            console.warn(`[monitor] could not chdir to fallback ${repoRoot}: ${e2.message}`);
          }
        }
      }
    }
  }
}

// ── Workspace Bootstrap ─────────────────────────────────────────────────────
// If workspaces are configured, ensure workspace repos are cloned and have .git
// before any agent execution begins.
{
  const wsArray = config.repositories?.filter((r) => r.workspace) || [];
  if (wsArray.length > 0) {
    const workspaceIds = [...new Set(wsArray.map((r) => r.workspace).filter(Boolean))];
    for (const wsId of workspaceIds) {
      const wsRepos = wsArray.filter((r) => r.workspace === wsId);
      let needsClone = false;
      for (const repo of wsRepos) {
        const gitPath = resolve(repo.path, ".git");
        if (!existsSync(gitPath)) {
          console.log(`[monitor] workspace repo missing .git: ${repo.path}`);
          needsClone = true;
          break;
        }
      }
      if (needsClone) {
        try {
          const results = pullWorkspaceRepos(config.configDir, wsId);
          for (const r of results) {
            if (r.success) {
              console.log(`[monitor] ✓ workspace repo ready: ${r.name}`);
            } else {
              console.warn(`[monitor] :alert: workspace repo failed: ${r.name} — ${r.error}`);
            }
          }
        } catch (err) {
          console.warn(`[monitor] workspace bootstrap failed for ${wsId}: ${err.message}`);
          console.warn(`[monitor] falling back to REPO_ROOT for agent execution`);
        }
      }
    }
  }
}

// ── Periodic Workspace Sync ─────────────────────────────────────────────────
// Every 30 minutes, fetch latest changes for all workspace repos so agents
// always work against recent upstream. Only runs if workspaces are configured.
const WORKSPACE_SYNC_INTERVAL_MS = parseEnvInteger(
  process.env.BOSUN_WORKSPACE_SYNC_INTERVAL_MS,
  30 * 60 * 1000,
  { min: 60 * 1000, max: 120 * 60 * 1000 },
); // 1m..120m (default 30m)
const WORKSPACE_SYNC_INITIAL_DELAY_MS = parseEnvInteger(
  isDevMode()
    ? process.env.DEVMODE_WORKSPACE_SYNC_INITIAL_DELAY_MS
    : process.env.BOSUN_WORKSPACE_SYNC_INITIAL_DELAY_MS,
  60 * 1000,
  { min: 0, max: 10 * 60 * 1000 },
); // 0s..5m (default 60s)
const WORKSPACE_SYNC_INITIAL_JITTER_MS = parseEnvInteger(
  process.env.BOSUN_WORKSPACE_SYNC_INITIAL_JITTER_MS,
  5 * 1000,
  { min: 0, max: 60 * 1000 },
); // 0s..60s (default 5s)
const WORKSPACE_SYNC_WARN_THROTTLE_MS = parseEnvInteger(
  isDevMode()
    ? process.env.DEVMODE_WORKSPACE_SYNC_WARN_THROTTLE_MS
    : process.env.BOSUN_WORKSPACE_SYNC_WARN_THROTTLE_MS,
  isDevMode() ? 30 * 60 * 1000 : 6 * 60 * 60 * 1000,
  { min: 10 * 1000, max: 24 * 60 * 60 * 1000 },
); // 10s..24h (default dev 30m, prod 6h)
const WORKSPACE_SYNC_SLOW_WARN_MS = parseEnvInteger(
  isDevMode()
    ? process.env.DEVMODE_WORKSPACE_SYNC_SLOW_WARN_MS
    : process.env.BOSUN_WORKSPACE_SYNC_SLOW_WARN_MS,
  isDevMode() ? 30 * 1000 : 90 * 1000,
  { min: 5 * 1000, max: 10 * 60 * 1000 },
); // 5s..10m (default dev 30s, prod 90s)
const WORKSPACE_SYNC_WARN_MAX_KEYS = parseEnvInteger(
  isDevMode()
    ? process.env.DEVMODE_WORKSPACE_SYNC_WARN_MAX_KEYS
    : process.env.BOSUN_WORKSPACE_SYNC_WARN_MAX_KEYS,
  500,
  { min: 10, max: 5000 },
); // 10..5000 (default 500)
const WORKSPACE_SYNC_WARN_STATE_FILE = "ve-workspace-sync-warn-state.json";
const WORKSPACE_SYNC_WARN_STATE_TMP_FILE = "ve-workspace-sync-warn-state.json.tmp";
const WORKSPACE_SYNC_WARN_STATE_WRITE_GAP_MS = isDevMode()
  ? parseEnvInteger(
      process.env.DEVMODE_WORKSPACE_SYNC_WARN_STATE_WRITE_GAP_MS,
      2 * 1000,
      { min: 200, max: 60 * 1000 },
    )
  : parseEnvInteger(
      process.env.BOSUN_WORKSPACE_SYNC_WARN_STATE_WRITE_GAP_MS,
      5 * 1000,
      { min: 200, max: 60 * 1000 },
    );
const WORKSPACE_SYNC_WARN_STALE_EXPIRY_MS = 24 * 60 * 60 * 1000;
const WORKSPACE_SYNC_WARN_ARCHIVE_MAX_FILES = 5;
const WORKSPACE_SYNC_WARN_ARCHIVE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
let workspaceSyncTimer = null;
let workspaceSyncInitialTimer = null;
let workspaceSyncInFlight = false;
let workspaceSyncWarnStateWriteTimer = null;
let workspaceSyncWarnStateWriteConfigDir = null;
const workspaceSyncWarnSeen = new Map();
function resolveWorkspaceSyncWarnStatePaths(configDir) {
  const cacheDir = resolve(configDir || process.cwd(), ".cache");
  const statePath = resolve(cacheDir, WORKSPACE_SYNC_WARN_STATE_FILE);
  const tmpPath = resolve(cacheDir, WORKSPACE_SYNC_WARN_STATE_TMP_FILE);
  return { cacheDir, statePath, tmpPath };
}
function pruneWorkspaceSyncWarnSeen(now = Date.now()) {
  let changed = false;
  for (const [seenKey, seenAt] of workspaceSyncWarnSeen.entries()) {
    const updatedAt = Number(seenAt || 0);
    if (now - updatedAt >= WORKSPACE_SYNC_WARN_STALE_EXPIRY_MS) {
      workspaceSyncWarnSeen.delete(seenKey);
      changed = true;
    }
  }
  return changed;
}
function evictWorkspaceSyncWarnSeenOverflow() {
  let changed = false;
  // Evict oldest entries so warn state remains bounded.
  while (workspaceSyncWarnSeen.size > WORKSPACE_SYNC_WARN_MAX_KEYS) {
    const oldestKey = workspaceSyncWarnSeen.keys().next().value;
    if (!oldestKey) break;
    workspaceSyncWarnSeen.delete(oldestKey);
    changed = true;
  }
  return changed;
}
function cleanupWorkspaceSyncWarnStateArchives(configDir, now = Date.now()) {
  const { cacheDir, statePath } = resolveWorkspaceSyncWarnStatePaths(configDir);
  const archivePrefix = `${WORKSPACE_SYNC_WARN_STATE_FILE}.archive.`;
  let entries = [];
  try {
    entries = readdirSync(cacheDir)
      .filter((name) => name.startsWith(archivePrefix))
      .map((name) => {
        const path = resolve(cacheDir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = Number(statSync(path).mtimeMs || 0);
        } catch {
          // Ignore files that disappear during cleanup.
        }
        return { name, path, mtimeMs };
      });
  } catch {
    return;
  }
  const keep = [];
  for (const entry of entries) {
    if (!entry.mtimeMs || now - entry.mtimeMs > WORKSPACE_SYNC_WARN_ARCHIVE_MAX_AGE_MS) {
      try {
        unlinkSync(entry.path);
      } catch {
        // Ignore cleanup failures; best effort.
      }
      continue;
    }
    keep.push(entry);
  }
  keep.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of keep.slice(WORKSPACE_SYNC_WARN_ARCHIVE_MAX_FILES)) {
    try {
      unlinkSync(entry.path);
    } catch {
      // Ignore cleanup failures; best effort.
    }
  }
  if (keep.length > WORKSPACE_SYNC_WARN_ARCHIVE_MAX_FILES) {
    console.log(
      `[monitor] workspace sync warn archive cleanup: kept ${WORKSPACE_SYNC_WARN_ARCHIVE_MAX_FILES} newest archives for ${basename(statePath)}`,
    );
  }
}
function archiveWorkspaceSyncWarnStateFile(configDir, reason = "corrupt") {
  const { cacheDir, statePath } = resolveWorkspaceSyncWarnStatePaths(configDir);
  if (!existsSync(statePath)) return;
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const archiveName = `${WORKSPACE_SYNC_WARN_STATE_FILE}.archive.${timestamp}.${reason}.json`;
  const archivePath = resolve(cacheDir, archiveName);
  try {
    renameSync(statePath, archivePath);
    console.warn(
      `[monitor] workspace sync warn state archived (${reason}): ${basename(archivePath)}`,
    );
  } catch (err) {
    console.warn(
      `[monitor] workspace sync warn state archive failed (${reason}): ${err?.message || err}`,
    );
  }
}
function persistWorkspaceSyncWarnState(configDir) {
  const { cacheDir, statePath, tmpPath } = resolveWorkspaceSyncWarnStatePaths(configDir);
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch (err) {
    console.warn(
      `[monitor] workspace sync warn state: unable to create cache dir: ${err?.message || err}`,
    );
    return;
  }
  const now = Date.now();
  pruneWorkspaceSyncWarnSeen(now);
  evictWorkspaceSyncWarnSeenOverflow();
  const entries = [];
  for (const [key, value] of workspaceSyncWarnSeen.entries()) {
    entries.push({ key, updatedAt: Number(value || 0) });
  }
  const payload = JSON.stringify(
    {
      version: 1,
      updatedAt: now,
      entries,
    },
    null,
    2,
  );
  let tmpWritten = false;
  try {
    writeFileSync(tmpPath, payload, "utf8");
    tmpWritten = true;
    renameSync(tmpPath, statePath);
  } catch (err) {
    console.warn(
      `[monitor] workspace sync warn state persist failed: ${err?.message || err}`,
    );
    if (tmpWritten || existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Ignore temp cleanup failures.
      }
    }
  }
}
function scheduleWorkspaceSyncWarnStatePersist(configDir, { immediate = false } = {}) {
  workspaceSyncWarnStateWriteConfigDir = configDir || workspaceSyncWarnStateWriteConfigDir || process.cwd();
  if (immediate || WORKSPACE_SYNC_WARN_STATE_WRITE_GAP_MS <= 0) {
    if (workspaceSyncWarnStateWriteTimer) {
      clearTimeout(workspaceSyncWarnStateWriteTimer);
      workspaceSyncWarnStateWriteTimer = null;
    }
    persistWorkspaceSyncWarnState(workspaceSyncWarnStateWriteConfigDir);
    return;
  }
  if (workspaceSyncWarnStateWriteTimer) {
    clearTimeout(workspaceSyncWarnStateWriteTimer);
    workspaceSyncWarnStateWriteTimer = null;
  }
  workspaceSyncWarnStateWriteTimer = safeSetTimeout("workspace-sync-warn-state-persist", () => {
    workspaceSyncWarnStateWriteTimer = null;
    persistWorkspaceSyncWarnState(workspaceSyncWarnStateWriteConfigDir);
  }, WORKSPACE_SYNC_WARN_STATE_WRITE_GAP_MS);
  if (workspaceSyncWarnStateWriteTimer?.unref) workspaceSyncWarnStateWriteTimer.unref();
}
function loadWorkspaceSyncWarnState(configDir) {
  const { statePath } = resolveWorkspaceSyncWarnStatePaths(configDir);
  // Run archive cleanup during monitor startup initialization.
  cleanupWorkspaceSyncWarnStateArchives(configDir);
  if (!existsSync(statePath)) return;
  try {
    const raw = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.entries)
      ? parsed.entries
      : Object.entries(parsed || {}).map(([key, updatedAt]) => ({ key, updatedAt }));
    workspaceSyncWarnSeen.clear();
    for (const entry of entries) {
      const key = String(entry?.key || "").trim();
      const updatedAt = Number(entry?.updatedAt || entry?.timestamp || 0);
      if (!key || !Number.isFinite(updatedAt) || updatedAt <= 0) continue;
      workspaceSyncWarnSeen.set(key, updatedAt);
    }
    const now = Date.now();
    const changed = pruneWorkspaceSyncWarnSeen(now) || evictWorkspaceSyncWarnSeenOverflow();
    if (changed) scheduleWorkspaceSyncWarnStatePersist(configDir, { immediate: true });
  } catch (err) {
    console.warn(
      `[monitor] workspace sync warn state load failed; archiving corrupt file: ${err?.message || err}`,
    );
    archiveWorkspaceSyncWarnStateFile(configDir, "corrupt");
  }
}
function stopWorkspaceSyncTimers() {
  if (workspaceSyncInitialTimer) {
    clearTimeout(workspaceSyncInitialTimer);
    workspaceSyncInitialTimer = null;
  }
  if (workspaceSyncTimer) {
    clearInterval(workspaceSyncTimer);
    workspaceSyncTimer = null;
  }
  if (workspaceSyncWarnStateWriteTimer) {
    clearTimeout(workspaceSyncWarnStateWriteTimer);
    workspaceSyncWarnStateWriteTimer = null;
    scheduleWorkspaceSyncWarnStatePersist(
      workspaceSyncWarnStateWriteConfigDir || config?.configDir || process.cwd(),
      { immediate: true },
    );
  }
}
function shouldEmitWorkspaceSyncWarn(key, now = Date.now()) {
  const stateConfigDir = config?.configDir || process.cwd();
  let changed = false;
  for (const [seenKey, seenAt] of workspaceSyncWarnSeen.entries()) {
    if (now - Number(seenAt || 0) >= WORKSPACE_SYNC_WARN_THROTTLE_MS) {
      workspaceSyncWarnSeen.delete(seenKey);
      changed = true;
    }
  }
  changed = pruneWorkspaceSyncWarnSeen(now) || changed;
  const last = Number(workspaceSyncWarnSeen.get(key) || 0);
  if (last > 0 && now - last < WORKSPACE_SYNC_WARN_THROTTLE_MS) return false;
  // Refresh key insertion order so oldest eviction works predictably.
  workspaceSyncWarnSeen.delete(key);
  workspaceSyncWarnSeen.set(key, now);
  changed = true;
  // keep memory bounded
  changed = evictWorkspaceSyncWarnSeenOverflow() || changed;
  if (changed) scheduleWorkspaceSyncWarnStatePersist(stateConfigDir);
  return true;
}
function clearWorkspaceSyncWarnForWorkspace(workspaceId) {
  let changed = false;
  const prefix = `${workspaceId}:`;
  for (const key of workspaceSyncWarnSeen.keys()) {
    if (String(key).startsWith(prefix)) {
      workspaceSyncWarnSeen.delete(key);
      changed = true;
    }
  }
  if (changed) {
    scheduleWorkspaceSyncWarnStatePersist(config?.configDir || process.cwd());
  }
}
function isBenignWorkspaceSyncFailure(errorText) {
  const raw = String(errorText || "");
  const text = raw.toLowerCase();
  if (!text) return false;
  if (
    text.includes("uncommitted changes") ||
    text.includes("unstaged changes") ||
    text.includes("your index contains uncommitted changes") ||
    text.includes("cannot pull with rebase") ||
    text.includes("cannot rebase") ||
    text.includes("please commit or stash") ||
    text.includes("please commit your changes or stash them") ||
    text.includes("would be overwritten by merge") ||
    text.includes("working tree contains unstaged changes") ||
    text.includes("non-fast-forward") ||
    text.includes("fetch first") ||
    text.includes("local changes would be overwritten by checkout") ||
    text.includes("cannot fast-forward") ||
    text.includes("is behind")
  ) {
    return true;
  }
  // git fetch / pull writes informational ref updates to stderr that some
  // callers surface as "errors" even though the underlying command succeeded.
  // Treat output that consists only of these benign ref-update lines as a
  // non-failure so we don't spam the warn log on every poll cycle.
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  const benignLine = (l) =>
    /^From\s+\S+/i.test(l) ||
    /\* \[new (branch|tag|ref)\]/i.test(l) ||
    /\[deleted\]/i.test(l) ||
    /\bup to date\b/i.test(l) ||
    /^\s*[a-f0-9]{6,40}\.\.[a-f0-9]{6,40}\s+\S+\s+->\s+\S+/i.test(l) ||
    /^\s*\+\s*[a-f0-9]{6,40}\.\.\.[a-f0-9]{6,40}\s+\S+\s+->\s+\S+\s+\(forced update\)/i.test(l) ||
    /\(forced update\)$/i.test(l);
  return lines.every(benignLine);
}
{
  const wsArray = config.repositories?.filter((r) => r.workspace) || [];
  if (wsArray.length > 0) {
    loadWorkspaceSyncWarnState(config?.configDir || process.cwd());
    const workspaceIds = [...new Set(wsArray.map((r) => r.workspace).filter(Boolean))];
    const doWorkspaceSync = () => {
      if (shuttingDown) return;
      if (workspaceSyncInFlight) {
        console.log("[monitor] workspace sync: previous run still in progress — skipping overlap");
        return;
      }
      workspaceSyncInFlight = true;
      const runStartedAt = Date.now();
      let workspaceCount = 0;
      let repoCount = 0;
      let failedRepoCount = 0;
      let nonBenignFailedRepoCount = 0;
      let benignFailedRepoCount = 0;
      let workspaceExceptionCount = 0;
      try {
        for (const wsId of workspaceIds) {
          workspaceCount += 1;
          if (shuttingDown) break;
          try {
            const results = pullWorkspaceRepos(config.configDir, wsId);
            repoCount += Array.isArray(results) ? results.length : 0;
            const failed = results.filter((r) => !r.success);
            failedRepoCount += failed.length;
            if (failed.length > 0) {
              const benignFailed = failed.filter((r) => isBenignWorkspaceSyncFailure(r?.error));
              const nonBenignFailed = failed.filter((r) => !isBenignWorkspaceSyncFailure(r?.error));
              benignFailedRepoCount += benignFailed.length;
              nonBenignFailedRepoCount += nonBenignFailed.length;
              if (nonBenignFailed.length === 0) {
                clearWorkspaceSyncWarnForWorkspace(wsId);
                console.log(
                  `[monitor] workspace sync: ${wsId} skipped ${failed.length} repo(s) with local changes`,
                );
              } else {
                const sampleSource = nonBenignFailed[0] || failed[0];
                const sample = String(sampleSource?.error || "unknown error")
                  .replace(/\s+/g, " ")
                  .trim();
                const snippet = sample.slice(0, 180);
                const fingerprint = normalizeDedupKey(getErrorFingerprint(snippet)).slice(0, 120);
                const repoSample = Array.from(
                  new Set(
                    nonBenignFailed
                      .map((r) => String(r?.name || "").trim())
                      .filter(Boolean),
                  ),
                )
                  .sort((a, b) => a.localeCompare(b))
                  .slice(0, 3);
                const repoLabel = repoSample.length ? ` [repos: ${repoSample.join(", ")}]` : "";
                const benignSuffix = benignFailed.length
                  ? ` (+${benignFailed.length} benign skipped)`
                  : "";
                const warnKey = `${wsId}:${nonBenignFailed.length}:${repoSample.join("|")}:${fingerprint}`;
                if (shouldEmitWorkspaceSyncWarn(warnKey)) {
                  console.warn(
                    `[monitor] workspace sync: ${nonBenignFailed.length} repo(s) failed in ${wsId}${benignSuffix}${repoLabel} (sample: ${snippet || "unknown error"})`,
                  );
                } else {
                  console.log(
                    `[monitor] workspace sync: ${nonBenignFailed.length} repo(s) failed in ${wsId}${benignSuffix}${repoLabel} (duplicate warning suppressed)`,
                  );
                }
              }
            } else {
              clearWorkspaceSyncWarnForWorkspace(wsId);
              console.log(`[monitor] workspace sync: ${wsId} up to date (${results.length} repos)`);
            }
          } catch (err) {
            failedRepoCount += 1;
            nonBenignFailedRepoCount += 1;
            workspaceExceptionCount += 1;
            const errText = formatMonitorError(err).replace(/\s+/g, " ").trim();
            const errSnippet = (errText || "unknown error").slice(0, 180);
            const errFingerprint = normalizeDedupKey(getErrorFingerprint(errSnippet)).slice(0, 120);
            const warnKey = `${wsId}:exception:${errFingerprint}`;
            if (shouldEmitWorkspaceSyncWarn(warnKey)) {
              console.warn(`[monitor] workspace sync failed for ${wsId}: ${errSnippet}`);
            } else {
              console.log(`[monitor] workspace sync failed for ${wsId} (duplicate warning suppressed)`);
            }
          }
        }
      } finally {
        const durationMs = Date.now() - runStartedAt;
        const summary = `[monitor] workspace sync: cycle complete (${workspaceCount} workspace(s), ${repoCount} repo(s), ${failedRepoCount} failure(s), ${nonBenignFailedRepoCount} non-benign, ${benignFailedRepoCount} benign, ${workspaceExceptionCount} exception(s), ${Math.round(durationMs / 1000)}s)`;
        if (repoCount > 0 && nonBenignFailedRepoCount >= repoCount) {
          console.warn(
            `[monitor] workspace sync: all repos failed this cycle (${nonBenignFailedRepoCount}/${repoCount})`,
          );
        }
        if (workspaceExceptionCount > 0) {
          console.warn(
            `[monitor] workspace sync: ${workspaceExceptionCount} workspace exception(s) this cycle`,
          );
        }
        if (workspaceCount > 0 && workspaceExceptionCount >= workspaceCount) {
          console.warn(
            `[monitor] workspace sync: all workspaces raised exceptions this cycle (${workspaceExceptionCount}/${workspaceCount})`,
          );
        }
        if (workspaceCount > 0 && repoCount === 0) {
          console.warn(
            `[monitor] workspace sync: no repos processed across ${workspaceCount} workspace(s) this cycle`,
          );
        }
        if (durationMs >= WORKSPACE_SYNC_SLOW_WARN_MS) {
          console.warn(`${summary} [slow>=${Math.round(WORKSPACE_SYNC_SLOW_WARN_MS / 1000)}s]`);
        } else {
          console.log(summary);
        }
        workspaceSyncInFlight = false;
      }
    };
    const workspaceSyncInitialJitterMs =
      WORKSPACE_SYNC_INITIAL_JITTER_MS > 0
        ? Math.floor(Math.random() * (WORKSPACE_SYNC_INITIAL_JITTER_MS + 1))
        : 0;
    const workspaceSyncInitialDelayEffectiveMs = Math.max(
      0,
      WORKSPACE_SYNC_INITIAL_DELAY_MS + workspaceSyncInitialJitterMs,
    );
    workspaceSyncInitialTimer = safeSetTimeout("workspace-sync-initial", () => {
      workspaceSyncInitialTimer = null;
      doWorkspaceSync();
    }, workspaceSyncInitialDelayEffectiveMs);
    if (workspaceSyncInitialTimer?.unref) workspaceSyncInitialTimer.unref();
    workspaceSyncTimer = safeSetInterval(
      "workspace-sync-cycle",
      doWorkspaceSync,
      WORKSPACE_SYNC_INTERVAL_MS,
    );
    // Unref so the timer doesn't keep the process alive during shutdown
    if (workspaceSyncTimer?.unref) workspaceSyncTimer.unref();
    console.log(
      `[monitor] workspace sync: scheduled every ${WORKSPACE_SYNC_INTERVAL_MS / 60000} min for ${workspaceIds.length} workspace(s); initial run in ${Math.round(workspaceSyncInitialDelayEffectiveMs / 1000)}s (base=${Math.round(WORKSPACE_SYNC_INITIAL_DELAY_MS / 1000)}s, jitter<=${Math.round(WORKSPACE_SYNC_INITIAL_JITTER_MS / 1000)}s)`,
    );
    console.log(
      `[monitor] workspace sync: warn-throttle=${Math.round(WORKSPACE_SYNC_WARN_THROTTLE_MS / 60000)}m slow-threshold=${Math.round(WORKSPACE_SYNC_SLOW_WARN_MS / 1000)}s max-warn-keys=${WORKSPACE_SYNC_WARN_MAX_KEYS}`,
    );
    if (WORKSPACE_SYNC_WARN_THROTTLE_MS < WORKSPACE_SYNC_INTERVAL_MS) {
      console.warn(
        `[monitor] workspace sync: warn-throttle (${Math.round(WORKSPACE_SYNC_WARN_THROTTLE_MS / 1000)}s) is below interval (${Math.round(WORKSPACE_SYNC_INTERVAL_MS / 1000)}s); duplicate warning suppression may be ineffective`,
      );
    }
    if (WORKSPACE_SYNC_SLOW_WARN_MS >= WORKSPACE_SYNC_INTERVAL_MS) {
      console.warn(
        `[monitor] workspace sync: slow-threshold (${Math.round(WORKSPACE_SYNC_SLOW_WARN_MS / 1000)}s) is >= interval (${Math.round(WORKSPACE_SYNC_INTERVAL_MS / 1000)}s); slow-cycle warnings may be delayed`,
      );
    }
    if (workspaceSyncInitialDelayEffectiveMs >= WORKSPACE_SYNC_INTERVAL_MS) {
      console.warn(
        `[monitor] workspace sync: effective initial-delay (${Math.round(workspaceSyncInitialDelayEffectiveMs / 1000)}s) is >= interval (${Math.round(WORKSPACE_SYNC_INTERVAL_MS / 1000)}s); startup sync may not run before first periodic cycle`,
      );
    }
  }
}

console.log(`[monitor] kanban backend: ${kanbanBackend}`);
if (config?.kanbanSource) {
  const src = config.kanbanSource;
  const sourceLabel = src.sourcePath
    ? `${src.source} (${src.sourcePath})`
    : src.source;
  console.log(
    `[monitor] kanban backend source: ${sourceLabel} (raw=${src.rawValue})`,
  );
}
console.log(`[monitor] executor mode: ${executorMode}`);
let primaryAgentName = primaryAgent;
let primaryAgentReady = primaryAgentEnabled;

try {
  setKanbanBackend(kanbanBackend);
} catch (err) {
  console.warn(
    `[monitor] failed to set initial kanban backend "${kanbanBackend}": ${err?.message || err}`,
  );
}

function getActiveKanbanBackend() {
  try {
    return String(getKanbanBackendName() || kanbanBackend || "internal")
      .trim()
      .toLowerCase();
  } catch {
    return String(kanbanBackend || "internal")
      .trim()
      .toLowerCase();
  }
}

// ── Workspace monitor: track agent workspaces with git state + stuck detection ──
const workspaceMonitor = new WorkspaceMonitor({
  cacheDir: resolve(repoRoot, ".cache", "workspace-logs"),
  repoRoot,
  onStuckDetected: ({ attemptId, reason, recommendation }) => {
    const msg = `:alert: Agent ${attemptId.substring(0, 8)} stuck: ${reason}\nRecommendation: ${recommendation}`;
    console.warn(`[workspace-monitor] ${msg}`);
    runDetached("workspace-monitor:stuck-notify", () =>
      notify?.(msg, { dedupKey: `stuck-${attemptId.substring(0, 8)}` }));
  },
});

function isTruthyFlag(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

function isFalsyFlag(value) {
  return ["0", "false", "no", "off"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

function isReviewAgentEnabled() {
  const explicit = process.env.INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED;
  if (explicit !== undefined && String(explicit).trim() !== "") {
    return !isFalsyFlag(explicit);
  }

  // When the workflow version is handling reviews, the legacy review agent
  // must be disabled to prevent duplicate reviews on the same PR.
  if (isWorkflowReplacingModule("review-agent.mjs")) return false;

  if (typeof internalExecutorConfig?.reviewAgentEnabled === "boolean") {
    return internalExecutorConfig.reviewAgentEnabled;
  }
  return true;
}

function isFlowPrimaryEnabled() {
  const explicit = process.env.BOSUN_FLOW_PRIMARY;
  if (explicit !== undefined && String(explicit).trim() !== "") {
    return !isFalsyFlag(explicit);
  }
  return !isFalsyFlag(flowPrimaryDefault);
}

function isFlowReviewGateEnabled() {
  const explicit = process.env.BOSUN_FLOW_REQUIRE_REVIEW;
  if (explicit !== undefined && String(explicit).trim() !== "") {
    return !isFalsyFlag(explicit);
  }
  return !isFalsyFlag(flowRequireReviewDefault);
}


function isSelfRestartWatcherEnabled() {
  const devMode = isDevMode();
  const force = process.env.SELF_RESTART_WATCH_FORCE;
  const forceEnabled = isTruthyFlag(force);
  const npmLifecycleEvent = String(process.env.npm_lifecycle_event || "")
    .trim()
    .toLowerCase();
  const launchedViaNpmStartScript =
    npmLifecycleEvent === "start" || npmLifecycleEvent.startsWith("start:");
  const explicit = process.env.SELF_RESTART_WATCH_ENABLED;
  if (explicit !== undefined && String(explicit).trim() !== "") {
    return !isFalsyFlag(explicit);
  }
  if (!devMode && !forceEnabled) {
    return false;
  }
  if (devMode && !forceEnabled && !launchedViaNpmStartScript) {
    // Plain `bosun` command launches from a source checkout should behave like
    // npm/prod installs by default: no self-restart watcher unless explicitly
    // enabled. Auto-updates still handle published package changes.
    return false;
  }
  if (
    String(executorMode || "")
      .trim()
      .toLowerCase() === "internal" ||
    String(executorMode || "")
      .trim()
      .toLowerCase() === "hybrid"
  ) {
    // Internal/hybrid mode continuously mutates source as tasks run.
    // Auto self-restart from file churn causes unnecessary restart storms.
    return false;
  }
  // Dev mode (source checkout / monorepo) → watch for code changes.
  // npm mode (installed via npm) → do NOT watch; source only changes via
  // npm update, which is handled by the auto-update loop instead.
  return devMode;
}


// ── Interactive shell state ────────────────────────────────────────────────
const shellState = {
  enabled: !!interactiveShellEnabled,
  active: false,
  rl: null,
  prompt: "",
  agentStreaming: false,
  agentStreamed: false,
  agentPrefixPrinted: false,
  abortController: null,
  queue: Promise.resolve(),
};
const shellIsTTY = process.stdin.isTTY && process.stdout.isTTY;
const shellAnsi = {
  cyan: (s) => (process.stdout.isTTY ? `\x1b[36m${s}\x1b[0m` : s),
  green: (s) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  dim: (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[22m` : s),
  red: (s) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s),
};
const shellPromptText = shellAnsi.cyan("[agent]") + " > ";
const shellInfoPrefix = shellAnsi.dim("[shell]") + " ";

function shellWriteRaw(chunk) {
  writeMonitorStreamSafely(chunk, { prefer: "stdout" });
}

function shellWriteLine(text) {
  shellWriteRaw(`${shellInfoPrefix}${text}\n`);
}

function startInteractiveShell() {
  if (!shellIsTTY || shellState.active) {
    return;
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: shellPromptText,
    terminal: true,
  });
  shellState.rl = rl;
  shellState.active = true;
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }
    if (["exit", "quit"].includes(trimmed.toLowerCase())) {
      rl.close();
      return;
    }
    shellState.queue = shellState.queue
      .then(async () => {
        if (!primaryAgentReady) {
          shellWriteLine("Primary agent not ready.");
          return;
        }
        await execPrimaryPrompt(trimmed, { timeoutMs: 15 * 60 * 1000 });
      })
      .catch((err) => {
        shellWriteLine(`Error: ${err.message || err}`);
      })
      .finally(() => {
        rl.prompt();
      });
  });
  rl.on("close", () => {
    shellState.active = false;
    shellState.rl = null;
  });
  rl.prompt();
}
let codexDisabledReason = codexEnabled
  ? ""
  : isTruthyFlag(process.env.CODEX_SDK_DISABLED)
    ? "disabled via CODEX_SDK_DISABLED"
    : agentSdk?.primary && agentSdk.primary !== "codex"
      ? `disabled via agent_sdk.primary=${agentSdk.primary}`
      : "disabled via --no-codex";
setPrimaryAgent(primaryAgentName);
let preflightEnabled = configPreflightEnabled;
let preflightRetryMs = configPreflightRetryMs;
let shuttingDown = false;
if (primaryAgentReady) {
  runDetached("primary-agent:init-startup", () =>
    initPrimaryAgent(primaryAgentName));
}

// Merge strategy: now handled by PR_MERGE_STRATEGY workflow template
const mergeStrategyMode = String(
  process.env.MERGE_STRATEGY_MODE || "smart",
).toLowerCase();
const flowPrimaryDefault = "true";
const flowRequireReviewDefault = "true";
const codexResolveConflictsEnabled =
  agentPoolEnabled &&
  (process.env.CODEX_RESOLVE_CONFLICTS || "true").toLowerCase() !== "false";
const conflictResolutionTimeoutMs = Number(
  process.env.MERGE_CONFLICT_RESOLUTION_TIMEOUT_MS || "600000",
);
// When telegram-bot.mjs is active it owns getUpdates — monitor must NOT poll
// to avoid HTTP 409 "Conflict: terminated by other getUpdates request".
let telegramPollLockHeld = false;
let preflightInProgress = false;
let preflightLastResult = null;
let preflightLastRunAt = 0;
let preflightRetryTimer = null;

let CodexClient = null;

let restartCount = 0;
let currentChild = null;
let pendingRestart = false;
let skipNextAnalyze = false;
let skipNextRestartCount = false;

// Cached project ID (lazy loaded)
let cachedProjectId = null;
let watcher = null;
let watcherDebounce = null;
let watchFileName = null;
let watcherMissingPathLogged = false;
let envWatchers = [];
let envWatcherDebounce = null;
let envPathMtimes = new Map();
let removeConfigReloadListener = null;
let stopTuiConfigReloadListener = null;

// ── Self-restart: exit code 75 signals cli.mjs to re-fork with fresh ESM cache
const SELF_RESTART_EXIT_CODE = 75;
const SELF_RESTART_QUIET_MS = Math.max(
  90_000,
  Number(process.env.SELF_RESTART_QUIET_MS || "180000"),
);
const ENV_RELOAD_DELAY_MS = Math.max(
  500,
  Number(process.env.ENV_RELOAD_DELAY_MS || "5000") || 5000,
);
const SELF_RESTART_RETRY_MS = Math.max(
  15_000,
  Number(process.env.SELF_RESTART_RETRY_MS || "30000"),
);
const ALLOW_INTERNAL_RUNTIME_RESTARTS = isTruthyFlag(
  process.env.ALLOW_INTERNAL_RUNTIME_RESTARTS || "false",
);
const SELF_RESTART_DEFER_HARD_CAP = Math.max(
  1,
  Number(process.env.SELF_RESTART_DEFER_HARD_CAP || "6") || 6,
);
const SELF_RESTART_MAX_DEFER_MS = Math.max(
  60_000,
  Number(process.env.SELF_RESTART_MAX_DEFER_MS || "180000") || 180000,
);
const SELF_RESTART_FORCE_ACTIVE_SLOT_MIN_AGE_MS = Math.max(
  60_000,
  Number(
    process.env.SELF_RESTART_FORCE_ACTIVE_SLOT_MIN_AGE_MS ||
      String(SELF_RESTART_MAX_DEFER_MS),
  ) || SELF_RESTART_MAX_DEFER_MS,
);
const RUNTIME_RESTART_REQUEST_POLL_MS = Math.max(
  1_000,
  Number(process.env.BOSUN_RESTART_REQUEST_POLL_MS || "2000") || 2000,
);
let selfWatcher = null;
let selfWatcherLib = null;
let selfWatcherExtra = []; // watchers for sibling source dirs (task/, workspace/, etc.)
let selfWatcherDebounce = null;
let selfWatcherMtimes = new Map();
let selfRestartTimer = null;
let selfRestartLastChangeAt = 0;
let selfRestartLastFile = null;
let pendingSelfRestart = null; // filename that triggered a deferred restart
let selfRestartDeferCount = 0;
let selfRestartFirstDeferredAt = 0;
let deferredMonitorRestartTimer = null;
let pendingMonitorRestartReason = "";
let selfRestartWatcherEnabled = isSelfRestartWatcherEnabled();

function buildCodexSdkOptionsForMonitor() {
  const { env: resolvedEnv } = resolveCodexProfileRuntime(process.env);
  const baseUrl = resolvedEnv.OPENAI_BASE_URL || "";
  const isAzureOpenAIBaseUrl = (url) => {
    try {
      const parsed = new URL(url);
      const host = String(parsed.hostname || "").toLowerCase();
      return host === "openai.azure.com" || host.endsWith(".openai.azure.com") || host.endsWith(".cognitiveservices.azure.com");
    } catch {
      return false;
    }
  };
  const isAzure = isAzureOpenAIBaseUrl(baseUrl);
  const env = { ...resolvedEnv };
  // For SDK compatibility, pass Azure endpoint via provider config instead of OPENAI_BASE_URL.
  delete env.OPENAI_BASE_URL;

  if (isAzure) {
    if (env.OPENAI_API_KEY && !env.AZURE_OPENAI_API_KEY) {
      env.AZURE_OPENAI_API_KEY = env.OPENAI_API_KEY;
    }
    try {
      const configDefaults = readCodexConfigRuntimeDefaults();
      const allProviders = configDefaults?.providers || {};
      for (const [sectionName, section] of Object.entries(allProviders)) {
        if (sectionName === "azure") continue;
        const otherBaseUrl = (section.baseUrl || "").trim();
        const otherEnvKey = (section.envKey || "").trim();
        if (!otherBaseUrl || !isAzureOpenAIBaseUrl(otherBaseUrl)) continue;
        if (!otherEnvKey || otherEnvKey === "AZURE_OPENAI_API_KEY") continue;
        delete env[otherEnvKey];
      }
    } catch {
      // best effort — if config reading fails, don't block execution
    }
    const azureModel = env.CODEX_MODEL || undefined;
    return {
      env,
      config: {
        model_provider: "azure",
        model_providers: {
          azure: {
            name: "Azure OpenAI",
            base_url: baseUrl,
            env_key: "AZURE_OPENAI_API_KEY",
            wire_api: "responses",
          },
        },
        features: {
          remote_models: false,
        },
        ...(azureModel ? { model: azureModel } : {}),
      },
    };
  }

  return { env };
}

// ── Self-restart marker: detect if this process was spawned by a code-change restart
const runtimeRestartRequestPath = resolve(
  config.cacheDir || resolve(config.repoRoot, ".cache"),
  "bosun-restart-request.json",
);
const selfRestartMarkerPath = resolve(
  config.cacheDir || resolve(config.repoRoot, ".cache"),
  "ve-self-restart.marker",
);
let lastHandledRuntimeRestartRequestId = "";
let isSelfRestart = false;
try {
  if (existsSync(selfRestartMarkerPath)) {
    const ts = Number(
      (await import("node:fs")).readFileSync(selfRestartMarkerPath, "utf8"),
    );
    // Marker is valid if written within the last 30 seconds
    if (Date.now() - ts < 30_000) {
      isSelfRestart = true;
      console.log(
        "[monitor] detected self-restart marker — suppressing startup notifications",
      );
    }
    // Clean up marker regardless
    try {
      (await import("node:fs")).unlinkSync(selfRestartMarkerPath);
    } catch {
      /* best effort */
    }
  }
} catch {
  /* first start or missing file */
}

let telegramNotifierInterval = null;
let telegramNotifierTimeout = null;
let weeklyReportLastSentAt = null;
let weeklyReportStateLoaded = false;
const weeklyReportStatePath = getWeeklyReportStatePath();
const monitorRestartReason = String(
  process.env.BOSUN_MONITOR_RESTART_REASON || "",
)
  .trim()
  .toLowerCase();

function getTelegramBotStartOptions() {
  const restartReason = isSelfRestart
    ? "self-restart"
    : monitorRestartReason;
  const allowDaemonPortalAutoOpen = isTruthyFlag(
    process.env.BOSUN_UI_AUTO_OPEN_ON_DAEMON,
  );
  return {
    restartReason,
    suppressPortalAutoOpen:
      restartReason.length > 0 || !allowDaemonPortalAutoOpen,
  };
}

function _getTuiMonitorStatsForPortal() {
  try {
    const executorStats = typeof internalTaskExecutor?.getTuiStats === "function"
      ? (internalTaskExecutor.getTuiStats() || {})
      : {};
    const runtimeStats = getRuntimeStats();
    const activeSessions = getSessionTracker().listAllSessions({ includePersisted: false })
      .filter((session) => session?.runtimeIsLive === true);
    return buildMonitorStatsPayload({
      agentPool: {
        ...executorStats,
        activeSessions,
      },
      runtimeStats: {
        ...runtimeStats,
        activeSessions,
      },
      uptimeMs: runtimeStats?.startedAt ? Date.now() - Number(runtimeStats.startedAt) : process.uptime() * 1000,
    });
  } catch {
    return {};
  }
}

async function ensureTelegramSurfaceRuntimeStarted(options = {}) {
  const restartReason = String(
    options.restartReason || process.env.BOSUN_MONITOR_RESTART_REASON || "",
  )
    .trim()
    .toLowerCase();
  const suppressPortalAutoOpen =
    options.suppressPortalAutoOpen === true || restartReason.length > 0;
  const autoOpenOptIn = ["1", "true", "yes", "on"].includes(
    String(process.env.BOSUN_UI_AUTO_OPEN_BROWSER || "").toLowerCase(),
  );
  await startTelegramSurfaceRuntime({
    skipAutoOpen: suppressPortalAutoOpen || !autoOpenOptIn,
    restartReason,
    dependencies: {
      getInternalExecutor: () => internalTaskExecutor,
      getTuiMonitorStats: () => _getTuiMonitorStatsForPortal(),
      getExecutorMode: () => executorMode,
      getAgentEventBus: () => agentEventBus,
      handleUiCommand,
      getSyncEngine: () => syncEngine,
      onProjectSyncAlert: async (alert) => {
        if (!sendTelegramMessage) return;
        const text = String(alert?.message || "Project sync alert");
        await sendTelegramMessage(`:alert: ${text}`);
      },
    },
  });
}

async function startTelegramSurfaceAndBot(options = {}) {
  await ensureTelegramSurfaceRuntimeStarted(options);
  await startTelegramBot(options);
}

function stopTelegramSurfaceAndBot(options = {}) {
  stopTelegramBot(options);
  stopTelegramSurfaceRuntime();
}

// ── Anomaly detector — plaintext pattern matching for death loops, stalls, etc. ──
let anomalyDetector = null;
const smartPrAllowRecreateClosed = isTruthyFlag(
  process.env.VE_SMARTPR_ALLOW_RECREATE_CLOSED,
);
const smartPrPrePrAssessmentEnabled = !isFalsyFlag(
  process.env.VE_SMARTPR_PRE_PR_ASSESSMENT ?? "1",
);
const githubToken =
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  process.env.GITHUB_PAT ||
  process.env.GITHUB_PAT_TOKEN ||
  "";
let monitorFailureHandling = false;
const monitorFailureTimestamps = [];
const monitorFailureWindowMs = 10 * 60 * 1000;
const monitorRestartCooldownMs = 60 * 1000;
let lastMonitorRestartAt = 0;
const orchestratorRestartTimestamps = [];
const orchestratorRestartWindowMs = 5 * 60 * 1000;
const orchestratorRestartThreshold = 8;
const orchestratorPauseMs = 10 * 60 * 1000;
let orchestratorHaltedUntil = 0;
let orchestratorLoopFixInProgress = false;
let monitorSafeModeUntil = 0;
let orchestratorResumeTimer = null;

// ── Mutex / restart-loop prevention ─────────────────────────────────────────
// When the orchestrator exits because "Another orchestrator instance is already
// running" (mutex held), the monitor must NOT restart immediately — the old
// instance still has the mutex and a tight restart loop will form.
const restartController = new RestartController();

let logRemainder = "";
let lastErrorLine = "";
let lastErrorAt = 0;
const mergeNotified = new Set();
const pendingMerges = new Set();
const errorNotified = new Map();
const mergeFailureNotified = new Map();
const telegramDedup = new Map();

// ── Deduplication tracking (utilities imported from utils.mjs) ───────────────

// ── Internal crash loop circuit breaker ──────────────────────────────────────
// Detects rapid failure bursts independently of Telegram dedup.
// When tripped, kills the orchestrator child and pauses everything.
const CIRCUIT_BREAKER_WINDOW_MS = 60_000; // 1 minute
const CIRCUIT_BREAKER_THRESHOLD = 5; // 5 failures in window = circuit trips
const CIRCUIT_BREAKER_PAUSE_MS = 5 * 60_000; // 5-minute hard pause
let circuitBreakerTripped = false;
let circuitBreakerResetAt = 0;
let circuitBreakerNotified = false;
const circuitBreakerTimestamps = [];

function recordCircuitBreakerEvent() {
  const now = Date.now();
  circuitBreakerTimestamps.push(now);
  // Prune events outside window
  while (
    circuitBreakerTimestamps.length &&
    now - circuitBreakerTimestamps[0] > CIRCUIT_BREAKER_WINDOW_MS
  ) {
    circuitBreakerTimestamps.shift();
  }
  return circuitBreakerTimestamps.length;
}

function isCircuitBreakerTripped() {
  const now = Date.now();
  // If paused, check if pause expired
  if (circuitBreakerTripped && now >= circuitBreakerResetAt) {
    circuitBreakerTripped = false;
    circuitBreakerNotified = false;
    circuitBreakerTimestamps.length = 0;
    console.warn("[monitor] circuit breaker reset — resuming normal operation");
    return false;
  }
  return circuitBreakerTripped;
}

function tripCircuitBreaker(failureCount) {
  if (circuitBreakerTripped) return; // already tripped
  circuitBreakerTripped = true;
  circuitBreakerResetAt = Date.now() + CIRCUIT_BREAKER_PAUSE_MS;
  const pauseMin = Math.round(CIRCUIT_BREAKER_PAUSE_MS / 60_000);
  console.error(
    `[monitor] :plug: CIRCUIT BREAKER TRIPPED: ${failureCount} failures in ${Math.round(CIRCUIT_BREAKER_WINDOW_MS / 1000)}s. ` +
      `Killing orchestrator and pausing all restarts for ${pauseMin} minutes.`,
  );

  // Kill the orchestrator child if running
  if (currentChild) {
    try {
      currentChild.kill("SIGTERM");
    } catch {
      /* best effort */
    }
  }

  // Block orchestrator restarts via safe mode
  monitorSafeModeUntil = circuitBreakerResetAt;

  // Send ONE summary Telegram message (if not already notified)
  if (!circuitBreakerNotified && telegramToken && telegramChatId) {
    circuitBreakerNotified = true;
    const msg =
      `:plug: Circuit breaker tripped: ${failureCount} failures in ${Math.round(CIRCUIT_BREAKER_WINDOW_MS / 1000)}s.\n` +
      `Orchestrator killed. All restarts paused for ${pauseMin} minutes.\n` +
      `Will auto-resume at ${new Date(circuitBreakerResetAt).toLocaleTimeString()}.`;
    // Fire-and-forget with skipDedup to ensure it gets through
    sendTelegramMessage(msg, { skipDedup: true }).catch(() => {});
  }
}

let allCompleteNotified = false;
const monitorStateCacheDir = resolve(repoRoot, ".bosun", ".cache");
const triggerStatePath = resolve(
  monitorStateCacheDir,
  "trigger-template-state.json",
);

// ── Telegram history ring buffer ────────────────────────────────────────────
// Stores the last N sent messages for context enrichment (fed to autofix prompts)
const TELEGRAM_HISTORY_MAX = 25;
const telegramHistory = [];
let telegramUpdateOffset = 0;
const telegramCommandQueue = [];
let telegramCommandActive = 0;
let telegramCommandPolling = false;

function pushTelegramHistory(text) {
  const stamp = new Date().toISOString().slice(11, 19);
  telegramHistory.push(`[${stamp}] ${text.slice(0, 300)}`);
  if (telegramHistory.length > TELEGRAM_HISTORY_MAX) {
    telegramHistory.shift();
  }
}

function recordMonitorFailure() {
  const now = Date.now();
  monitorFailureTimestamps.push(now);
  while (
    monitorFailureTimestamps.length &&
    now - monitorFailureTimestamps[0] > monitorFailureWindowMs
  ) {
    monitorFailureTimestamps.shift();
  }
  return monitorFailureTimestamps.length;
}

function shouldRestartMonitor() {
  const now = Date.now();
  if (now - lastMonitorRestartAt < monitorRestartCooldownMs) {
    return false;
  }
  return monitorFailureTimestamps.length >= 3;
}

function schedulePreflightRetry(waitMs) {
  if (preflightRetryTimer) return;
  const delay = Math.max(30000, waitMs || preflightRetryMs);
  preflightRetryTimer = setTimeout(() => {
    preflightRetryTimer = null;
    startProcess();
  }, delay);
}

async function ensurePreflightReady(reason) {
  if (!preflightEnabled) return true;
  if (preflightInProgress) return false;
  const now = Date.now();
  if (preflightLastResult && !preflightLastResult.ok) {
    const elapsed = now - preflightLastRunAt;
    if (elapsed < preflightRetryMs) {
      schedulePreflightRetry(preflightRetryMs - elapsed);
      return false;
    }
  }
  preflightInProgress = true;
  const result = runPreflightChecks({ repoRoot });
  preflightInProgress = false;
  preflightLastResult = result;
  preflightLastRunAt = Date.now();
  const report = formatPreflightReport(result, {
    retryMs: result.ok ? 0 : preflightRetryMs,
  });
  if (!result.ok) {
    console.error(report);
    console.warn(
      `[monitor] preflight failed (${reason || "startup"}); blocking orchestrator start.`,
    );
    schedulePreflightRetry(preflightRetryMs);
    return false;
  }
  console.log(report);
  return true;
}

function maybeHandleQueuedRuntimeRestartRequest(trigger = "interval") {
  if (shuttingDown) return false;
  if (!existsSync(runtimeRestartRequestPath)) return false;

  let payload = null;
  try {
    payload = JSON.parse(readFileSync(runtimeRestartRequestPath, "utf8"));
  } catch (err) {
    console.warn(
      `[monitor] invalid runtime restart request at ${runtimeRestartRequestPath}: ${err?.message || err}`,
    );
    try {
      unlinkSync(runtimeRestartRequestPath);
    } catch {
      /* best effort */
    }
    return false;
  }

  const requestId = String(
    payload?.id ||
      `${payload?.requestedAt || ""}:${payload?.requesterPid || ""}:${payload?.reason || ""}:${payload?.targetPid || ""}`,
  ).trim();
  const requestType = String(payload?.type || "code-reload").trim().toLowerCase();
  const targetPid = Number(payload?.targetPid || 0);

  if (requestId && requestId === lastHandledRuntimeRestartRequestId) {
    try {
      unlinkSync(runtimeRestartRequestPath);
    } catch {
      /* best effort */
    }
    return false;
  }

  if (requestType !== "code-reload") {
    console.warn(
      `[monitor] ignoring runtime restart request with unsupported type "${requestType}"`,
    );
    try {
      unlinkSync(runtimeRestartRequestPath);
    } catch {
      /* best effort */
    }
    return false;
  }

  if (targetPid > 0 && targetPid !== process.pid) {
    console.warn(
      `[monitor] ignoring runtime restart request for pid ${targetPid} (current pid ${process.pid})`,
    );
    try {
      unlinkSync(runtimeRestartRequestPath);
    } catch {
      /* best effort */
    }
    return false;
  }

  try {
    unlinkSync(runtimeRestartRequestPath);
  } catch {
    /* best effort */
  }
  lastHandledRuntimeRestartRequestId = requestId || `restart-${Date.now()}`;

  const reason = String(payload?.reason || "external-restart-request").trim() ||
    "external-restart-request";
  const requesterPid = Number(payload?.requesterPid || 0);
  const requesterLabel = requesterPid > 0 ? ` from pid ${requesterPid}` : "";
  console.warn(
    `[monitor] queued runtime reload requested (${reason})${requesterLabel} via ${trigger}; preserving current launch provenance.`,
  );
  restartSelf(`queued-runtime-restart:${reason}`);
  return true;
}

function restartSelf(reason) {
  if (shuttingDown) return;
  const protection = getRuntimeRestartProtection();
  if (protection.defer) {
    const retrySec = Math.round(SELF_RESTART_RETRY_MS / 1000);
    pendingMonitorRestartReason = reason || pendingMonitorRestartReason || "";
    if (!deferredMonitorRestartTimer) {
      console.warn(
        `[monitor] deferring monitor restart (${reason || "unknown"}) — ${protection.reason}; retrying in ${retrySec}s`,
      );
      deferredMonitorRestartTimer = safeSetTimeout("deferred-monitor-restart", () => {
        deferredMonitorRestartTimer = null;
        const deferredReason = pendingMonitorRestartReason || "deferred";
        pendingMonitorRestartReason = "";
        restartSelf(deferredReason);
      }, SELF_RESTART_RETRY_MS);
    }
    return;
  }
  pendingMonitorRestartReason = "";
  if (deferredMonitorRestartTimer) {
    clearTimeout(deferredMonitorRestartTimer);
    deferredMonitorRestartTimer = null;
  }
  const now = Date.now();
  lastMonitorRestartAt = now;

  // ── Graceful restart: use exit code 75 so cli.mjs re-forks cleanly ──
  // Previously this spawned a detached orphan + exit(1), which:
  //   - Triggered the crash handler in cli.mjs ("Monitor crashed exit code 1")
  //   - Created an unmanaged orphan process instead of using cli's fork loop
  //   - Killed in-flight agents without draining
  // Now we do the same graceful shutdown as selfRestartForSourceChange().
  console.warn(`[monitor] graceful restart — ${reason || "unknown"}`);
  shuttingDown = true;
  const shutdownPromises = [];
  if (agentEndpoint) {
    shutdownPromises.push(
      Promise.resolve(agentEndpoint.stop()).catch((e) =>
        console.warn(`[monitor] endpoint stop error: ${e.message}`),
      ),
    );
  }
  stopHeartbeatMonitor();
  stopAutoUpdateLoop();
  stopAgentAlertTailer();
  stopAgentWorkAnalyzer();
  stopSelfWatcher();
  stopWatcher();
  stopEnvWatchers();
  if (currentChild) {
    currentChild.kill("SIGTERM");
    setTimeout(() => {
      if (currentChild && !currentChild.killed) {
        currentChild.kill("SIGKILL");
      }
    }, 3000);
  }
  runDetachedDuringShutdown("poll-lock-release:restart-self", () =>
    releaseTelegramPollLock(),
  );
  stopTelegramSurfaceAndBot({ preserveDigest: true });
  stopWhatsAppChannel();
  if (isContainerEnabled()) {
    runDetachedDuringShutdown("containers-stop:restart-self", () =>
      stopAllContainers(),
    );
  }
  // Write self-restart marker so the new process suppresses startup notifications
  try {
    writeFileSync(
      resolve(repoRoot, ".cache", "ve-self-restart.marker"),
      String(Date.now()),
    );
  } catch {
    /* best effort */
  }
  // Wait for shutdown, then exit with code 75 — cli.mjs re-forks cleanly
  Promise.allSettled(shutdownPromises).then(() => {
    setTimeout(() => process.exit(SELF_RESTART_EXIT_CODE), 500);
  });
  // Safety net: exit after 10s even if shutdown hangs
  setTimeout(() => process.exit(SELF_RESTART_EXIT_CODE), 10000);
}

function recordOrchestratorRestart() {
  const now = Date.now();
  orchestratorRestartTimestamps.push(now);
  while (
    orchestratorRestartTimestamps.length &&
    now - orchestratorRestartTimestamps[0] > orchestratorRestartWindowMs
  ) {
    orchestratorRestartTimestamps.shift();
  }
  return orchestratorRestartTimestamps.length;
}

function shouldHaltOrchestrator() {
  const now = Date.now();
  if (now < orchestratorHaltedUntil) {
    return true;
  }
  return orchestratorRestartTimestamps.length >= orchestratorRestartThreshold;
}

function detectChangedFiles(repoRootPath) {
  try {
    const output = execSync("git diff --name-only", {
      cwd: repoRootPath,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getChangeSummary(repoRootPath, files) {
  if (!files.length) return "(no file changes detected)";
  try {
    const diff = execSync("git diff --stat", {
      cwd: repoRootPath,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return diff.trim() || files.join(", ");
  } catch {
    return files.join(", ");
  }
}

const monitorFixAttempts = new Map();
const monitorFixMaxAttempts = 2;
const monitorFixCooldownMs = 5 * 60 * 1000;

function canAttemptMonitorFix(signature) {
  const record = monitorFixAttempts.get(signature);
  if (!record) return true;
  if (record.count >= monitorFixMaxAttempts) return false;
  if (Date.now() - record.lastAt < monitorFixCooldownMs) return false;
  return true;
}

function recordMonitorFixAttempt(signature) {
  const record = monitorFixAttempts.get(signature) || { count: 0, lastAt: 0 };
  record.count += 1;
  record.lastAt = Date.now();
  monitorFixAttempts.set(signature, record);
  return record.count;
}

async function attemptMonitorFix({ error, logText }) {
  if (!autoFixEnabled) return { fixed: false, outcome: "autofix-disabled" };
  if (!codexEnabled) return { fixed: false, outcome: "codex-disabled" };

  const signature = error?.message || "monitor-crash";
  if (!canAttemptMonitorFix(signature)) {
    return { fixed: false, outcome: "monitor-fix-exhausted" };
  }

  const attemptNum = recordMonitorFixAttempt(signature);
  const fallbackPrompt = `You are debugging the ${projectName} bosun.

The monitor process hit an unexpected exception and needs a fix.
Please inspect and fix code in the bosun directory:
- monitor.mjs
- autofix.mjs
- maintenance.mjs

Crash info:
${error?.stack || error?.message || String(error)}

Recent log context:
${logText.slice(-4000)}

Instructions:
1) Identify the root cause of the crash in bosun.
2) Apply a minimal fix.
3) Do not refactor unrelated code.
4) Keep behavior stable and production-safe.`;
  const prompt = resolvePromptTemplate(
    agentPrompts?.monitorCrashFix,
    {
      PROJECT_NAME: projectName,
      CRASH_INFO: error?.stack || error?.message || String(error),
      LOG_TAIL: logText.slice(-4000),
    },
    fallbackPrompt,
  );

  const filesBefore = detectChangedFiles(repoRoot);
  const result = await runCodexExec(prompt, repoRoot);
  const filesAfter = detectChangedFiles(repoRoot);
  const newChanges = filesAfter.filter((f) => !filesBefore.includes(f));
  const changeSummary = getChangeSummary(repoRoot, newChanges);

  const stamp = nowStamp();
  const auditPath = resolve(
    logDir,
    `monitor-fix-${stamp}-attempt${attemptNum}.log`,
  );
  await writeFile(
    auditPath,
    [
      `# Monitor fix attempt #${attemptNum}`,
      `# Signature: ${signature}`,
      `# Timestamp: ${new Date().toISOString()}`,
      "",
      "## Prompt sent to Codex:",
      prompt,
      "",
      "## Codex result:",
      result.output || "(no output)",
      result.error ? `## Error: ${result.error}` : "",
      `## Files changed: ${newChanges.join(", ") || "none"}`,
      "",
      "## Diff summary:",
      changeSummary,
    ].join("\n"),
    "utf8",
  );

  if (result.success && newChanges.length > 0) {
    return { fixed: true, outcome: `changes: ${changeSummary}` };
  }

  return {
    fixed: false,
    outcome: result.error || "no changes written",
  };
}

// Hard cap: if we hit this many failures in the window, enter degraded mode.
const MONITOR_FAILURE_HARD_CAP = 30;
// Minimum interval between handleMonitorFailure executions (prevent Telegram spam).
const MONITOR_FAILURE_COOLDOWN_MS = 5000;
let lastMonitorFailureHandledAt = 0;

async function handleMonitorFailure(reason, err) {
  if (monitorFailureHandling) return;
  const now = Date.now();

  // ── Circuit breaker: if tripped, suppress ALL handling silently ──
  if (isCircuitBreakerTripped()) return;

  // Rate-limit: don't re-enter within cooldown
  if (now - lastMonitorFailureHandledAt < MONITOR_FAILURE_COOLDOWN_MS) return;
  monitorFailureHandling = true;
  lastMonitorFailureHandledAt = now;
  const failureCount = recordMonitorFailure();
  const message = err && err.message ? err.message : String(err || reason);

  // ── Circuit breaker: track rapid failure bursts ──
  const burstCount = recordCircuitBreakerEvent();
  if (burstCount >= CIRCUIT_BREAKER_THRESHOLD) {
    tripCircuitBreaker(burstCount);
    monitorFailureHandling = false;
    return; // circuit breaker sends its own summary message
  }

  // Hard cap: never kill monitor; degrade into safe mode and pause restarts.
  if (failureCount >= MONITOR_FAILURE_HARD_CAP) {
    const pauseMs = Math.max(orchestratorPauseMs, 30 * 60 * 1000);
    const pauseMin = Math.max(1, Math.round(pauseMs / 60_000));
    const msg =
      `:close: bosun hit hard failure cap (${failureCount}). ` +
      `Entering safe mode for ${pauseMin} minute(s); monitor process will stay alive.`;
    console.error(`[monitor] ${msg}`);
    if (telegramToken && telegramChatId) {
      try {
        await sendTelegramMessage(msg);
      } catch {
        /* best effort */
      }
    }
    monitorSafeModeUntil = Math.max(monitorSafeModeUntil, Date.now() + pauseMs);
    // Prevent immediate retrigger loops after entering hard-cap safe mode.
    monitorFailureTimestamps.length = 0;
    // Stop currently running child orchestrator while keeping monitor alive.
    if (currentChild) {
      try {
        currentChild.kill("SIGTERM");
      } catch {
        /* best effort */
      }
    }
    // Ensure we retry after safe-mode window if still running.
    if (!shuttingDown) {
      safeSetTimeout("monitor-failure-hard-cap-resume", () => {
        if (!shuttingDown) {
          runDetached("monitor-failure-hard-cap-resume", startProcess);
        }
      }, pauseMs + 1000);
    }
    return;
  }

  try {
    await ensureLogDir();
    const crashPath = resolve(logDir, `monitor-crash-${nowStamp()}.log`);
    const payload = [
      `# Monitor crash: ${reason}`,
      `# Timestamp: ${new Date().toISOString()}`,
      "",
      "## Error:",
      err?.stack || message,
      "",
      "## Recent logs:",
      logRemainder.slice(-8000),
    ].join("\n");
    await writeFile(crashPath, payload, "utf8");

    if (telegramToken && telegramChatId) {
      try {
        const shortMsg = message.length > 200 ? message.slice(0, 200) + "…" : message;
        await sendTelegramMessage(
          `:alert: bosun exception (${reason}): ${shortMsg}\n\nAttempting recovery (count=${failureCount}).`,
        );
      } catch {
        /* suppress Telegram errors during failure handling */
      }
    }

    const fixResult = await attemptMonitorFix({
      error: err || new Error(reason),
      logText: logRemainder,
    });

    if (fixResult.fixed) {
      if (telegramToken && telegramChatId) {
        try {
          await sendTelegramMessage(
            `:u1f6e0: bosun auto-fix applied. Restarting monitor.\n${fixResult.outcome}`,
          );
        } catch {
          /* best effort */
        }
      }
      restartSelf("monitor-fix-applied");
      return;
    }

    if (shouldRestartMonitor()) {
      monitorSafeModeUntil = Date.now() + orchestratorPauseMs;
      const pauseMin = Math.round(orchestratorPauseMs / 60000);
      if (telegramToken && telegramChatId) {
        try {
          await sendTelegramMessage(
            `:close: bosun entering safe mode after repeated failures (${failureCount} in 10m). Pausing restarts for ${pauseMin} minutes.`,
          );
        } catch {
          /* best effort */
        }
      }
      return;
    }
  } catch (fatal) {
    writeMonitorStreamSafely(
      `[monitor] failure handler crashed: ${fatal.message || fatal}\n`,
      { prefer: "stdout" },
    );
  } finally {
    monitorFailureHandling = false;
  }
}

function reportGuardedFailure(reason, err) {
  if (shuttingDown) return;
  const error = err instanceof Error ? err : new Error(formatMonitorError(err));
  console.error("[monitor] " + reason + " failed: " + (error.stack || error.message));
  handleMonitorFailure(reason, error).catch((failureErr) => {
    writeMonitorStreamSafely(
      "[monitor] handleMonitorFailure failed: " + (failureErr?.message || failureErr) + "\n",
      { prefer: "stdout" },
    );
  });
}

function runGuarded(reason, fn) {
  if (shuttingDown) return;
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      result.catch((err) => reportGuardedFailure(reason, err));
    }
  } catch (err) {
    reportGuardedFailure(reason, err);
  }
}

function runDetached(label, promiseOrFn) {
  if (shuttingDown) return;
  try {
    const pending =
      typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn;
    if (pending && typeof pending.then === "function") {
      pending.catch((err) => {
        const error = err instanceof Error ? err : new Error(formatMonitorError(err));
        console.warn(
          `[monitor] detached task failed (${label}): ${error.stack || error.message}`,
        );
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(formatMonitorError(err));
    console.warn(
      `[monitor] detached task failed (${label}): ${error.stack || error.message}`,
    );
  }
}

function runDetachedDuringShutdown(label, promiseOrFn) {
  try {
    const pending =
      typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn;
    if (pending && typeof pending.then === "function") {
      pending.catch((err) => {
        const error = err instanceof Error ? err : new Error(formatMonitorError(err));
        console.warn(
          `[monitor] shutdown task failed (${label}): ${error.stack || error.message}`,
        );
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(formatMonitorError(err));
    console.warn(
      `[monitor] shutdown task failed (${label}): ${error.stack || error.message}`,
    );
  }
}

function safeSetInterval(reason, fn, ms) {
  const normalized = Number(ms);
  const clamped = Number.isFinite(normalized) && normalized > 0
    ? Math.min(normalized, 2_147_483_647)
    : 1;
  if (clamped !== normalized) {
    console.warn(
      `[monitor] timer delay clamped for interval:${reason} (${normalized}ms -> ${clamped}ms)`,
    );
  }
  let inFlight = false;
  return setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    runGuarded(`interval:${reason}`, () => {
      let result;
      try {
        result = fn();
      } catch (err) {
        inFlight = false;
        throw err;
      }
      if (result && typeof result.then === "function") {
        return Promise.resolve(result).finally(() => {
          inFlight = false;
        });
      }
      inFlight = false;
      return result;
    });
  }, clamped);
}

function safeSetTimeout(reason, fn, ms) {
  const normalized = Number(ms);
  const clamped = Number.isFinite(normalized) && normalized > 0
    ? Math.min(normalized, 2_147_483_647)
    : 1;
  if (clamped !== normalized) {
    console.warn(
      `[monitor] timer delay clamped for timeout:${reason} (${normalized}ms -> ${clamped}ms)`,
    );
  }
  return setTimeout(() => runGuarded(`timeout:${reason}`, fn), clamped);
}

function scheduleStartProcess(reason, delayMs) {
  return safeSetTimeout(reason, () => {
    if (!shuttingDown) {
      runDetached(`start-process:${reason}`, startProcess);
    }
  }, delayMs);
}

const crashLoopFixAttempts = new Map();
const crashLoopFixMaxAttempts = 2;
const crashLoopFixCooldownMs = 10 * 60 * 1000;

function canAttemptCrashLoopFix(signature) {
  const record = crashLoopFixAttempts.get(signature);
  if (!record) return true;
  if (record.count >= crashLoopFixMaxAttempts) return false;
  if (Date.now() - record.lastAt < crashLoopFixCooldownMs) return false;
  return true;
}

function recordCrashLoopFixAttempt(signature) {
  const record = crashLoopFixAttempts.get(signature) || { count: 0, lastAt: 0 };
  record.count += 1;
  record.lastAt = Date.now();
  crashLoopFixAttempts.set(signature, record);
  return record.count;
}

async function attemptCrashLoopFix({ reason, logText }) {
  if (!autoFixEnabled || !codexEnabled) {
    return { fixed: false, outcome: "codex-disabled" };
  }
  const signature = `crash-loop:${reason}`;
  if (!canAttemptCrashLoopFix(signature)) {
    return { fixed: false, outcome: "crash-loop-fix-exhausted" };
  }

  const attemptNum = recordCrashLoopFixAttempt(signature);
  const fallbackPrompt = `You are a reliability engineer debugging a crash loop in ${projectName} automation.

The orchestrator is restarting repeatedly within minutes.
Please diagnose the likely root cause and apply a minimal fix.

Targets (edit only if needed):
- ${scriptPath}
- bosun/monitor.mjs
- bosun/autofix.mjs
- bosun/maintenance.mjs

Recent log excerpt:
${logText.slice(-6000)}

Constraints:
1) Prevent rapid restart loops (introduce backoff or safe-mode).
2) Keep behavior stable and production-safe.
3) Do not refactor unrelated code.
4) Prefer small guardrails over big rewrites.`;
  const prompt = resolvePromptTemplate(
    agentPrompts?.monitorRestartLoopFix,
    {
      PROJECT_NAME: projectName,
      SCRIPT_PATH: scriptPath,
      LOG_TAIL: logText.slice(-6000),
    },
    fallbackPrompt,
  );

  const filesBefore = detectChangedFiles(repoRoot);
  const result = await runCodexExec(prompt, repoRoot, 1_800_000);
  const filesAfter = detectChangedFiles(repoRoot);
  const newChanges = filesAfter.filter((f) => !filesBefore.includes(f));
  const changeSummary = getChangeSummary(repoRoot, newChanges);

  const stamp = nowStamp();
  const auditPath = resolve(
    logDir,
    `crash-loop-fix-${stamp}-attempt${attemptNum}.log`,
  );
  await writeFile(
    auditPath,
    [
      `# Crash-loop fix attempt #${attemptNum}`,
      `# Signature: ${signature}`,
      `# Timestamp: ${new Date().toISOString()}`,
      "",
      "## Prompt sent to Codex:",
      prompt,
      "",
      "## Codex result:",
      result.output || "(no output)",
      result.error ? `## Error: ${result.error}` : "",
      `## Files changed: ${newChanges.join(", ") || "none"}`,
      "",
      "## Diff summary:",
      changeSummary,
    ].join("\n"),
    "utf8",
  );

  if (result.success && newChanges.length > 0) {
    return { fixed: true, outcome: `changes: ${changeSummary}` };
  }
  return { fixed: false, outcome: result.error || "no changes written" };
}

export function getTelegramHistory() {
  return [...telegramHistory];
}

// ── Repeating error detection (loop detector) ───────────────────────────────────
// Tracks fingerprints of error lines. When the same error appears
// LOOP_THRESHOLD times within LOOP_WINDOW_MS, triggers Codex autofix.
const LOOP_THRESHOLD = 4;
const LOOP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const LOOP_COOLDOWN_MS = 15 * 60 * 1000; // 15 min cooldown per fingerprint

/** @type {Map<string, {timestamps: number[], fixTriggeredAt: number}>} */
const errorFrequency = new Map();
let loopFixInProgress = false;

// Infrastructure error patterns that should NEVER trigger loop-fix autofix.
// These are transient git/rebase failures handled by persistent cooldowns.
const infraErrorPatterns = [
  /Direct rebase failed/i,
  /checkout failed/i,
  /rebase cooldown/i,
  /worktree.*has (rebase in progress|uncommitted changes)/i,
  /No worktree found/i,
  /rebase (failed|unavailable)/i,
  /git fetch failed in worktree/i,
  /Cannot rebase/i,
  /merge conflict.*not auto-resolvable/i,
];

function isInfraError(line) {
  return infraErrorPatterns.some((p) => p.test(line));
}

function trackErrorFrequency(line) {
  // Skip infrastructure errors — they have their own cooldown/retry logic
  if (isInfraError(line)) return;

  const fingerprint = getErrorFingerprint(line);
  if (!fingerprint) return;

  const now = Date.now();
  let record = errorFrequency.get(fingerprint);
  if (!record) {
    record = { timestamps: [], fixTriggeredAt: 0 };
    errorFrequency.set(fingerprint, record);
  }

  record.timestamps.push(now);
  // Trim old entries outside window
  record.timestamps = record.timestamps.filter((t) => now - t < LOOP_WINDOW_MS);

  // Check threshold
  if (
    record.timestamps.length >= LOOP_THRESHOLD &&
    now - record.fixTriggeredAt > LOOP_COOLDOWN_MS &&
    !loopFixInProgress
  ) {
    record.fixTriggeredAt = now;
    console.log(
      `[monitor] repeating error detected (${record.timestamps.length}x): ${fingerprint.slice(0, 80)}`,
    );
    triggerLoopFix(line, record.timestamps.length);
  }
}

function triggerLoopFix(errorLine, repeatCount) {
  if (!autoFixEnabled) return;
  loopFixInProgress = true;

  const telegramFn =
    telegramToken && telegramChatId
      ? (msg) => void sendTelegramMessage(msg)
      : null;

  // Fire-and-forget: never block the stdout pipeline
  void (async () => {
    try {
      const result = await fixLoopingError({
        errorLine,
        repeatCount,
        repoRoot,
        logDir,
        onTelegram: telegramFn,
        recentMessages: getTelegramHistory(),
        promptTemplate: agentPrompts?.autofixLoop,
      });

      if (result.fixed) {
        console.log(
          "[monitor] loop fix applied — file watcher will restart orchestrator",
        );
      } else {
        console.log(
          `[monitor] loop fix returned no changes: ${result.outcome || "no-fix"}`,
        );
      }
    } catch (err) {
      console.warn(`[monitor] loop fix error: ${err.message || err}`);
      if (telegramFn) {
        telegramFn(`:repeat: Loop fix crashed: ${err.message || err}`);
      }
    } finally {
      loopFixInProgress = false;
    }
  })();
}

const contextPatterns = [
  "ContextWindowExceeded",
  "context window",
  "ran out of room",
  "prompt token count",
  "token count of",
  "context length exceeded",
  "maximum context length",
  "exceeds the limit",
  "token limit",
  "too many tokens",
  "prompt too large",
  "failed to get response from the ai model",
  "capierror",
];

const errorPatterns = [
  /\bERROR\b/i,
  /Exception/i,
  /Traceback/i,
  /SetValueInvocationException/i,
  /Cannot bind argument/i,
  /Unhandled/i,
  /\bFailed to compile\b/i,
  /\bFailed to start\b/i,
  /\bFATAL\b/i,
  /Copilot assignment failed/i,
];

const errorNoisePatterns = [
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Status:/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Initial sync:/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+SyncCopilotState:/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+CI (pending|failing)/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+PR #\d+ .*CI=/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Merge failed for PR/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Merge failure reason:/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Retry merge failed for PR/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Auto-merge enable failed:/i,
  // Stats summary line (contains "Failed" as a counter, not an error)
  /First-shot:.*Failed:/i,
  // Attempt lifecycle lines that include "failed" but are expected status updates
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Attempt [0-9a-f]{8} finished \(failed\)\s+—\s+marking review/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Attempt [0-9a-f]{8} failed in workspace — requires agent attention/i,
  // Agent work logger noise (handled separately, not a monitor crash)
  /^\s*\[agent-logger\]\s+Session ended:/i,
  /^\s*\[agent-logger\]\s+Error logged:/i,
  // Attempt lifecycle lines that include "failed" but are normal status updates
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Attempt [0-9a-f]{8} finished \(failed\)\s+—\s+marking review/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Attempt [0-9a-f]{8} failed in workspace — requires agent attention/i,
  // Box-drawing cycle summary lines
  /^\s*[│┃|]\s*(Elapsed|Submitted|Tracked|First-shot):/i,
  /^\s*[─┄╌═]+/,
  /^\s*[└┗╚][─┄╌═]+/,
  /^\s*[╔╗╚╝║═]+/,
  // "No remote branch" is handled by smartPR, not an error
  /No remote branch for .* — agent must push/i,
  // Telegram 409 conflicts (harmless, handled by auto-disable)
  /telegram getUpdates failed: 409/i,
  /getUpdates failed: 409/i,
  // ── Infrastructure failures: rebase/checkout/worktree issues ──
  // These are transient git infra failures, NOT code bugs.
  // The orchestrator handles them with cooldowns; do NOT trigger autofix.
  /Direct rebase failed:.*checkout failed/i,
  /Direct rebase failed:.*merge conflict/i,
  /Direct rebase failed:.*push failed/i,
  /Direct rebase failed:.*setting cooldown/i,
  /Direct merge-rebase (succeeded|failed)/i,
  /Branch .* is on rebase cooldown/i,
  /Worktree .* has (rebase in progress|uncommitted changes)/i,
  /No worktree found for .* — skipping/i,
  /Cannot rebase: (working tree is dirty|git rebase already in progress)/i,
  /git fetch failed in worktree/i,
  // ── Benign "error" mentions in summary/stats lines ──
  /errors?[=:]\s*0\b/i,
  /\b0\s+errors?\b/i,
  /\bno\s+errors?\b/i,
  /errors?\s*(count|total|sum|rate)\s*[=:]\s*0/i,
  /\bcomplete\b.*\berrors?[=:]\s*0/i,
  /\bsuccess\b.*\berrors?\b/i,
];

function notifyErrorLine(line) {
  if (!telegramToken || !telegramChatId) {
    return;
  }

  // Track error frequency for loop detection (always, even if deduped for Telegram)
  trackErrorFrequency(line);

  const key = line.trim();
  if (!key) {
    return;
  }
  const now = Date.now();
  const last = errorNotified.get(key) || 0;
  if (now - last < 5 * 60 * 1000) {
    return;
  }
  errorNotified.set(key, now);
  queueErrorMessage(line.trim());
}

function notifyCodexTrigger(context) {
  if (!telegramToken || !telegramChatId) {
    return;
  }
  void sendTelegramMessage(`Codex triggered: ${context}`);
}

async function runCodexRecovery(reason) {
  if (!codexEnabled) {
    return null;
  }
  try {
    if (!CodexClient) {
      const ready = await ensureCodexSdkReady();
      if (!ready) {
        throw new Error(codexDisabledReason || "Codex SDK not available");
      }
    }
    const codex = new CodexClient(buildCodexSdkOptionsForMonitor());
    const thread = codex.startThread({ skipGitRepoCheck: true, workingDirectory: repoRoot, approvalPolicy: "never" });
    const prompt = `You are monitoring a Node.js orchestrator.
A service issue was detected.
Provide a short recovery plan and validate environment assumptions.
Reason: ${reason}`;
    const result = await thread.run(prompt);
    const outPath = resolve(logDir, `codex-recovery-${nowStamp()}.txt`);
    await writeFile(outPath, formatCodexResult(result), "utf8");
    return outPath;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const outPath = resolve(logDir, `codex-recovery-${nowStamp()}.txt`);
    await writeFile(outPath, `Codex recovery failed: ${message}\n`, "utf8");
    return null;
  }
}

function ensureAnomalyDetector() {
  if (anomalyDetector) return anomalyDetector;
  if (process.env.VITEST) return null;
  if (isWorkflowReplacingModule("anomaly-detector.mjs")) {
    console.log("[monitor] skipping legacy anomaly detector — handled by workflow");
    return null;
  }
  anomalyDetector = createAnomalyDetector({
    onAnomaly: wrapAnomalyCallback((anomaly) => {
      const icon =
        anomaly.severity === "CRITICAL"
          ? ":dot:"
          : anomaly.severity === "HIGH"
            ? ":u1f7e0:"
            : ":dot:";
      console.warn(
        `[anomaly-detector] ${icon} ${anomaly.severity} ${anomaly.type} [${anomaly.shortId}]: ${anomaly.message}`,
      );

      // Act on kill/restart actions — write signal file for the orchestrator.
      // The signal file ensures the orchestrator also
      // archives and retries the attempt on its next loop.
      if (anomaly.action === "kill" || anomaly.action === "restart") {
        console.warn(
          `[anomaly-detector] writing signal for action="${anomaly.action}" ${anomaly.type} on process ${anomaly.shortId}`,
        );
        writeAnomalySignal(anomaly);
      }
    }),
    notify: (text, options) => {
      sendTelegramMessage(text, options).catch(() => {});
    },
  });
  if (workflowAutomationEngine?.services) {
    workflowAutomationEngine.services.anomalyDetector = anomalyDetector;
  }
  console.log("[monitor] anomaly detector started");
  return anomalyDetector;
}

function getAnomalyStatusReport() {
  if (!anomalyDetector) {
    ensureAnomalyDetector();
  }
  return anomalyDetector
    ? anomalyDetector.getStatusReport()
    : "Anomaly detector not running.";
}

/**
 * GET /api/task-attempts/:id/branch-status
 * Returns branch status data for an attempt (commits ahead/behind, conflicts, etc.)
 */
async function fetchBranchStatus(attemptId) {
  // Branch status is now unavailable via external API
  return null;
}

async function getAttemptInfo(attemptId) {
  try {
    const statusData = await readStatusData();
    const attempts = statusData?.active_attempts || [];
    const match = attempts.find((a) => a.id === attemptId);
    if (match) return match;
  } catch {
    /* best effort */
  }
  return null;
}

function ghAvailable() {
  const res = spawnSync("gh", ["--version"], { stdio: "ignore", timeout: 8000 });
  return res.status === 0;
}

/**
 * Find the worktree path for a given branch.
 * Delegates to the centralized WorktreeManager; falls back to direct git parsing
 * for branches not tracked in the registry.
 */
function findWorktreeForBranch(branch) {
  if (!branch) return null;
  // Try centralized manager first (has registry + git porcelain search)
  try {
    const managed = findManagedWorktree(branch);
    if (managed) return managed;
  } catch {
    // Manager may not be initialized — fall through
  }
  // Fallback: direct git worktree list parsing
  try {
    const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
      encoding: "utf8",
      shell: false,
    });
    if (result.status !== 0 || !result.stdout) return null;

    const lines = result.stdout.split("\n");
    let currentPath = null;
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice(9).trim();
      } else if (line.startsWith("branch ") && currentPath) {
        const branchRef = line.slice(7).trim();
        const branchName = branchRef.replace(/^refs\/heads\//, "");
        if (branchName === branch) {
          return currentPath;
        }
      } else if (line.trim() === "") {
        currentPath = null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function findExistingPrForBranch(branch) {
  if (!branch || !ghAvailable()) return null;
  const normalizedRepo = normalizeRepoSlugCandidate(repoSlug);
  return await findExistingPrForBranchInRepo(branch, normalizedRepo);
}

async function findExistingPrForBranchInRepo(branch, repoOverride = "") {
  if (!branch || !ghAvailable()) return null;
  const resolvedRepo =
    normalizeRepoSlugCandidate(repoOverride) ||
    normalizeRepoSlugCandidate(repoSlug);
  const args = [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--limit",
    "5",
    "--json",
    "number,state,title,url,mergedAt,closedAt",
  ];
  if (resolvedRepo) args.push("--repo", resolvedRepo);
  const res = spawnSync(
    "gh",
    args,
    { encoding: "utf8", timeout: 15000 },
  );
  if (res.status !== 0) {
    return null;
  }
  try {
    const items = JSON.parse(res.stdout || "[]");
    return Array.isArray(items) && items.length > 0 ? items[0] : null;
  } catch {
    return null;
  }
}

async function findExistingPrForBranchApi(branch) {
  const normalizedRepo = normalizeRepoSlugCandidate(repoSlug);
  return await findExistingPrForBranchApiInRepo(branch, normalizedRepo);
}

async function findExistingPrForBranchApiInRepo(branch, repoOverride = "") {
  if (!branch || !githubToken) return null;
  const resolvedRepo =
    normalizeRepoSlugCandidate(repoOverride) ||
    normalizeRepoSlugCandidate(repoSlug);
  if (!resolvedRepo) return null;
  const [owner, repo] = resolvedRepo.split("/");
  if (!owner || !repo) return null;
  const head = `${owner}:${branch}`;
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=all&head=${encodeURIComponent(
    head,
  )}`;
  try {
    const abort = new AbortController();
    const abortTimer = setTimeout(() => abort.abort(), 15000);
    let res;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "bosun",
        },
        signal: abort.signal,
      });
    } finally {
      clearTimeout(abortTimer);
    }
    if (!res || !res.ok) {
      const text = res ? await res.text().catch(() => "") : "";
      const status = res?.status || "no response";
      console.warn(
        `[monitor] GitHub API PR lookup failed (${status}): ${text.slice(0, 120)}`,
      );
      return null;
    }
    const items = await res.json();
    return Array.isArray(items) && items.length > 0 ? items[0] : null;
  } catch (err) {
    console.warn(
      `[monitor] GitHub API PR lookup error: ${err?.message || err}`,
    );
    return null;
  }
}

async function getPullRequestByNumber(prNumber, repoOverride = "") {
  if (!Number.isFinite(prNumber) || prNumber <= 0) return null;
  const resolvedRepo =
    normalizeRepoSlugCandidate(repoOverride) ||
    normalizeRepoSlugCandidate(repoSlug);
  if (ghAvailable()) {
    const args = [
      "pr",
      "view",
      String(prNumber),
      "--json",
      "number,state,title,url,mergedAt,closedAt,mergeable,mergeStateStatus",
    ];
    if (resolvedRepo) args.push("--repo", resolvedRepo);
    const res = spawnSync(
      "gh",
      args,
      { encoding: "utf8", timeout: 15000 },
    );
    if (res.status === 0) {
      try {
        return JSON.parse(res.stdout || "{}");
      } catch {
        /* fall through */
      }
    }
  }
  if (!githubToken || !resolvedRepo) return null;
  const [owner, repo] = resolvedRepo.split("/");
  if (!owner || !repo) return null;
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
  try {
    const abort = new AbortController();
    const abortTimer = setTimeout(() => abort.abort(), 15000);
    let res;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "bosun",
        },
        signal: abort.signal,
      });
    } finally {
      clearTimeout(abortTimer);
    }
    if (!res || !res.ok) {
      const text = res ? await res.text().catch(() => "") : "";
      const status = res?.status || "no response";
      console.warn(
        `[monitor] GitHub API PR ${prNumber} lookup failed (${status}): ${text.slice(0, 120)}`,
      );
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(
      `[monitor] GitHub API PR ${prNumber} lookup error: ${err?.message || err}`,
    );
    return null;
  }
}

/**
 * Find the matching project by projectName, with caching.
 * Falls back to the first project if no name match.
 * Works with any kanban backend (internal, GitHub, Jira).
 */
async function findKanbanProjectId() {
  if (cachedProjectId) return cachedProjectId;

  try {
    const projects = await listKanbanProjects();
    if (!Array.isArray(projects) || projects.length === 0) {
      console.warn("[monitor] No projects found in kanban backend");
      return null;
    }

    // Match by projectName (case-insensitive)
    const match = projects.find(
      (p) => p.name?.toLowerCase() === projectName?.toLowerCase(),
    );
    const project = match || projects[0];
    if (!project?.id) {
      console.warn("[monitor] No valid project found in kanban backend");
      return null;
    }
    if (!match) {
      console.warn(
        `[monitor] No project matching "${projectName}" — using "${project.name}" as fallback`,
      );
    }
    cachedProjectId = project.id;
    console.log(
      `[monitor] Cached project_id: ${String(cachedProjectId).substring(0, 16)}... (${project.name})`,
    );
    return cachedProjectId;
  } catch (err) {
    console.warn(`[monitor] Failed to fetch projects: ${err.message}`);
    return null;
  }
}

/**
 * POST /api/task-attempts/:id/rebase
 * Rebases the attempt's worktree onto target branch.
 */
async function rebaseAttempt(attemptId, baseBranch) {
  // Backend removed — rebase via external API is no longer available
  return { success: false, error: "backend_removed", message: "Backend removed" };
}

/**
 * POST /api/task-attempts/:id/pr
 * Creates a PR via the backend API (triggers prepush hooks in the worktree).
 */
async function createPRViaBackend(attemptId, prOpts = {}) {
  // Backend removed — PR creation via external API is no longer available
  return { success: false, error: "backend_removed", _elapsedMs: 0 };
}

/**
 * POST /api/task-attempts/:id/resolve-conflicts
 * Auto-resolves merge conflicts after a failed rebase by accepting "ours" changes.
 */
async function resolveConflicts(attemptId) {
  // Backend removed
  return null;
}

/**
 * POST /api/task-attempts/:id/archive
 * Archives a stale attempt (0 commits, many behind).
 */
async function archiveAttempt(attemptId) {
  // Backend removed
  return null;
}

// ── Fresh session retry system ──────────────────────────────────────────────
// When an agent gets stuck (context window exhausted, crash loop, repeated
// failures), starting a fresh session in the SAME workspace is often the
// most effective recovery — the new agent gets clean context but inherits
// the existing worktree and file changes.

/**
 * Build a retry prompt that gives the fresh agent full task context.
 * Mirrors the format the user showed: failure notice + task context block.
 *
 * @param {object} attemptInfo - { task_id, task_title, task_description, branch, id }
 * @param {string} reason      - Why we're retrying (e.g., "context_window_exhausted")
 * @param {string} [logTail]   - Last N chars of log for diagnosis
 * @returns {string} The follow-up prompt
 */
function buildRetryPrompt(attemptInfo, reason, logTail) {
  const parts = [
    `Detected a failure (${reason}). Please retry your task. If it fails again, I will start a fresh session.`,
    "",
    "Task context:",
    `Branch: ${attemptInfo.branch || "unknown"}`,
    `Title: ${attemptInfo.task_title || attemptInfo.name || "unknown"}`,
  ];

  if (attemptInfo.task_description) {
    parts.push(`Description:\n${attemptInfo.task_description}`);
  }

  parts.push(
    "",
    "If VE_TASK_TITLE/VE_TASK_DESCRIPTION are missing, treat this as an orchestrated task:",
    "Worktree paths often include .git/worktrees/ or a task runner path.",
    "Tasks typically map to a ve/<id>-<slug> branch.",
    "Resume with the context above, then commit/push/PR as usual.",
  );

  if (logTail) {
    const trimmed = logTail.slice(-2000).trim();
    if (trimmed) {
      parts.push("", "Recent log output:", "```", trimmed, "```");
    }
  }

  return parts.join("\n");
}

/**
 * Get the currently active attempt info from status data.
 * @returns {Promise<object|null>} Attempt info with task context, or null
 */
async function getActiveAttemptInfo() {
  try {
    const statusData = await readStatusData();
    const attempts = statusData?.active_attempts || [];
    // Find the running/most recent attempt
    const running =
      attempts.find((a) => a.status === "running") ||
      attempts.find((a) => a.status === "error") ||
      attempts[0];

    if (!running) return null;

    // Enrich with task description if available from local data
    return running;
  } catch {
    return null;
  }
}

// Rate-limit fresh session creation to avoid spam
const FRESH_SESSION_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
let lastFreshSessionAt = 0;
let freshSessionCount = 0;
const FRESH_SESSION_MAX_PER_TASK = 3; // max retries per task before giving up
const freshSessionTaskRetries = new Map();

/**
 * Start a fresh session in the same workspace and send a retry prompt.
 * This is the nuclear option when an agent is irrecoverably stuck.
 *
 * @param {string} workspaceId - The workspace/attempt UUID
 * @param {string} prompt      - The follow-up prompt with task context
 * @param {string} taskId      - Task ID for retry tracking
 * @returns {Promise<{success: boolean, sessionId?: string, reason?: string}>}
 */
async function startFreshSession(workspaceId, prompt, taskId) {
  // Guard: internal executor mode runs tasks via agent-pool, not external sessions
  const execMode = configExecutorMode || getExecutorMode();
  if (execMode === "internal") {
    console.log(
      `[monitor] startFreshSession skipped — executor mode is "internal"`,
    );
    return {
      success: false,
      reason: "internal executor mode — external sessions disabled",
    };
  }

  const now = Date.now();

  // Rate limit
  if (now - lastFreshSessionAt < FRESH_SESSION_COOLDOWN_MS) {
    const waitSec = Math.round(
      (FRESH_SESSION_COOLDOWN_MS - (now - lastFreshSessionAt)) / 1000,
    );
    console.warn(`[monitor] fresh session rate-limited, ${waitSec}s remaining`);
    return { success: false, reason: `rate-limited (${waitSec}s)` };
  }

  // Per-task retry limit
  if (taskId) {
    const retries = freshSessionTaskRetries.get(taskId) || 0;
    if (retries >= FRESH_SESSION_MAX_PER_TASK) {
      console.warn(
        `[monitor] fresh session limit reached for task ${taskId.slice(0, 8)} (${retries}/${FRESH_SESSION_MAX_PER_TASK})`,
      );
      return {
        success: false,
        reason: `max retries (${FRESH_SESSION_MAX_PER_TASK}) reached for task`,
      };
    }
    freshSessionTaskRetries.set(taskId, retries + 1);
  }

  lastFreshSessionAt = now;
  freshSessionCount += 1;

  try {
    // External session creation removed — fresh sessions are handled by internal executor
    console.log("[monitor] external session creation removed — use internal executor");
    return { success: false, reason: "backend_removed" };
  } catch (err) {
    console.warn(`[monitor] fresh session error: ${err.message || err}`);
    return { success: false, reason: err.message || String(err) };
  }
}

/**
 * High-level: detect a stuck agent, build retry prompt, start fresh session.
 * Call this from handleExit, crash loop detection, or smartPRFlow stale detection.
 *
 * @param {string} reason  - Why we're retrying
 * @param {string} [logTail] - Recent log output for context
 * @returns {Promise<boolean>} true if fresh session started
 */
async function attemptFreshSessionRetry(reason, logTail) {
  // Guard: internal executor mode runs tasks via agent-pool, not external sessions
  const execMode = configExecutorMode || getExecutorMode();
  if (execMode === "internal") {
    console.log(
      `[monitor] attemptFreshSessionRetry skipped — executor mode is "internal"`,
    );
    return false;
  }

  const attemptInfo = await getActiveAttemptInfo();
  if (!attemptInfo?.id) {
    console.log("[monitor] fresh session retry skipped — no active attempt");
    return false;
  }

  const prompt = buildRetryPrompt(attemptInfo, reason, logTail);
  const result = await startFreshSession(
    attemptInfo.id,
    prompt,
    attemptInfo.task_id,
  );

  if (result.success) {
    if (telegramToken && telegramChatId) {
      const taskLabel =
        attemptInfo.task_title || attemptInfo.branch || "unknown";
      void sendTelegramMessage(
        `:refresh: Fresh session started for "${taskLabel}" (${reason}).\nNew session: ${result.sessionId}`,
      );
    }
    return true;
  }

  console.warn(`[monitor] fresh session retry failed: ${result.reason}`);
  if (telegramToken && telegramChatId) {
    void sendTelegramMessage(
      `:alert: Fresh session retry failed (${reason}): ${result.reason}`,
    );
  }
  return false;
}

/**
 * Calculate how long a task has been in its current state (ms).
 * Uses `updated_at` if available, otherwise `created_at`.
 * @param {object} task - Task object with `updated_at` / `created_at`
 * @returns {number} Age in milliseconds, or 0 if no timestamp available
 */
function getTaskAgeMs(task) {
  const ts = task?.updated_at || task?.created_at;
  if (!ts) return 0;
  const parsed = new Date(ts).getTime();
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, Date.now() - parsed);
}

/**
 * Return the task's "version" timestamp used for cache invalidation.
 * Prefers updated_at, falls back to created_at.
 * @param {object} task
 * @returns {string} ISO-ish timestamp string or empty string
 */
function getTaskUpdatedAt(task) {
  return task?.updated_at || task?.created_at || "";
}

function parseGitHubIssueNumber(value) {
  if (value == null) return null;
  const numeric = String(value)
    .trim()
    .match(/^#?(\d+)$/);
  if (numeric?.[1]) return numeric[1];
  const urlMatch = String(value).match(/\/issues\/(\d+)(?:\b|$)/i);
  return urlMatch?.[1] || null;
}

function getConfiguredKanbanProjectId(backend) {
  const githubProjectId =
    process.env.GITHUB_REPOSITORY ||
    (process.env.GITHUB_REPO_OWNER && process.env.GITHUB_REPO_NAME
      ? `${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}`
      : null) ||
    repoSlug ||
    null;
  const jiraProjectKey =
    process.env.JIRA_PROJECT_KEY || config?.jira?.projectKey || null;
  return (
    process.env.INTERNAL_EXECUTOR_PROJECT_ID ||
    internalExecutorConfig?.projectId ||
    config?.kanban?.projectId ||
    process.env.KANBAN_PROJECT_ID ||
    (backend === "github"
      ? githubProjectId
      : backend === "jira"
        ? jiraProjectKey
        : null)
  );
}

function hasUnresolvedTemplateToken(value) {
  return /{{[^{}]+}}/.test(String(value || ""));
}

function resolveTaskIdForBackend(taskId, backend) {
  const rawId = String(taskId || "").trim();
  if (!rawId || hasUnresolvedTemplateToken(rawId)) return null;
  if (backend !== "github") return rawId;
  const directMatch = parseGitHubIssueNumber(rawId);
  if (directMatch) return directMatch;
  try {
    const internalTasks = getAllInternalTasks();
    const internalTask = internalTasks.find(
      (t) =>
        String(t?.id || "").trim() === rawId ||
        String(t?.externalId || "").trim() === rawId,
    );
    return (
      parseGitHubIssueNumber(internalTask?.externalId) ||
      parseGitHubIssueNumber(internalTask?.id) ||
      null
    );
  } catch {
    return null;
  }
}

/**
 * GET /api/projects/:project_id/tasks?status=<status>
 * Fetches tasks by status from active kanban backend.
 * @param {string} status - Task status (e.g., "inreview", "todo", "done")
 * @returns {Promise<Array>} Array of task objects, or empty array on failure
 */
async function fetchTasksByStatus(status) {
  const backend = getActiveKanbanBackend();
  try {
    // Internal backend uses file-based storage — no project ID required.
    if (backend === "internal") {
      const tasks = status
        ? getInternalTasksByStatus(status)
        : getAllInternalTasks();
      return Array.isArray(tasks) ? tasks : [];
    }

    const projectId = getConfiguredKanbanProjectId(backend);
    if (!projectId) {
      console.warn(
        `[monitor] No project ID configured for backend=${backend} task query`,
      );
      return [];
    }
    const tasks = await listKanbanTasks(projectId, { status });
    return Array.isArray(tasks) ? tasks : [];
  } catch (err) {
    console.warn(
      `[monitor] Error fetching tasks by status from ${backend}: ${err.message || err}`,
    );
    return [];
  }
}

/**
 * Updates task status via active kanban backend.
 * @param {string} taskId - Task ID (UUID for internal, issue number for GitHub)
 * @param {string} newStatus - New status ("todo", "inprogress", "inreview", "done", "cancelled")
 * @returns {Promise<boolean>} true if successful, false otherwise
 */
async function updateTaskStatus(taskId, newStatus, options = {}) {
  const normalizedTaskId = String(taskId || "").trim();
  const normalizedStatus = String(newStatus || "").trim().toLowerCase();
  const taskData =
    options?.taskData && typeof options.taskData === "object"
      ? options.taskData
      : null;
  const workflowData =
    options?.workflowData && typeof options.workflowData === "object"
      ? options.workflowData
      : null;
  const taskTitle = String(
    options?.taskTitle || taskData?.title || getInternalTask(normalizedTaskId)?.title || "",
  ).trim();
  const previousStatus = String(
    options?.previousStatus || workflowTaskStatusSnapshot.get(normalizedTaskId) || "",
  )
    .trim()
    .toLowerCase();
  const baseWorkflowPayload = {
    taskId: normalizedTaskId,
    taskTitle,
    previousStatus: previousStatus || null,
    status: normalizedStatus,
    branch: String(
      options?.branch ||
        taskData?.branch ||
        taskData?.branchName ||
        taskData?.meta?.branch_name ||
        workflowData?.branch ||
        "",
    ).trim() || null,
    baseBranch: String(
      options?.baseBranch ||
        taskData?.baseBranch ||
        taskData?.base_branch ||
        taskData?.meta?.base_branch ||
        workflowData?.baseBranch ||
        "",
    ).trim() || null,
    worktreePath: String(
      options?.worktreePath ||
        taskData?.worktreePath ||
        taskData?.meta?.worktreePath ||
        workflowData?.worktreePath ||
        "",
    ).trim() || null,
    prNumber: String(
      options?.prNumber ||
        taskData?.prNumber ||
        taskData?.meta?.pr_number ||
        workflowData?.prNumber ||
        "",
    ).trim() || null,
    prUrl: String(
      options?.prUrl ||
        taskData?.prUrl ||
        taskData?.meta?.pr_url ||
        workflowData?.prUrl ||
        "",
    ).trim() || null,
  };
  const queueTaskStatusWorkflowEvents = () => {
    const statusChanged = previousStatus !== normalizedStatus;
    const shouldEmitLifecycle =
      statusChanged || ["done", "inreview"].includes(normalizedStatus);
    workflowTaskStatusSnapshot.set(normalizedTaskId, normalizedStatus);

    if (!normalizedTaskId || !normalizedStatus || !shouldEmitLifecycle) {
      return;
    }

    queueWorkflowEvent(
      "task.status_changed",
      baseWorkflowPayload,
      { dedupKey: `workflow-event:task.status_changed:${normalizedTaskId}:${normalizedStatus}` },
    );
    queueWorkflowEvent(
      `task.${normalizedStatus}`,
      baseWorkflowPayload,
      { dedupKey: `workflow-event:task.${normalizedStatus}:${normalizedTaskId}` },
    );

    if (normalizedStatus === "done") {
      queueWorkflowEvent(
        "task.completed",
        baseWorkflowPayload,
        { dedupKey: `workflow-event:task.completed:${normalizedTaskId}` },
      );
    } else if (normalizedStatus === "inreview") {
      queueWorkflowEvent(
        "task.in_review",
        baseWorkflowPayload,
        { dedupKey: `workflow-event:task.in_review:${normalizedTaskId}` },
      );
    }

    if (options?.workflowEvent) {
      const eventName = String(options.workflowEvent || "").trim();
      if (eventName) {
        const extraPayload =
          options?.workflowData && typeof options.workflowData === "object"
            ? options.workflowData
            : {};
        queueWorkflowEvent(
          eventName,
          {
            ...baseWorkflowPayload,
            ...extraPayload,
          },
          {
            dedupKey:
              options?.workflowDedupKey ||
              `workflow-event:${eventName}:${normalizedTaskId}:${normalizedStatus}`,
          },
        );
      }
    }
  };

  const transitionSource = String(options?.source || "").trim().toLowerCase();
  const workflowBypass = options?.bypassWorkflowOwnership === true;
  if (workflowAutomationEnabled && transitionSource !== "workflow" && !workflowBypass) {
    const engine = await ensureWorkflowAutomationEngine().catch(() => null);
    if (engine) {
      queueWorkflowEvent(
        "task.transition.requested",
        {
          ...baseWorkflowPayload,
          targetStatus: normalizedStatus,
          source: transitionSource || "legacy-monitor",
          error: options?.error || null,
        },
        {
          dedupKey:
            options?.workflowDedupKey ||
            `workflow-event:task.transition.requested:${normalizedTaskId}:${normalizedStatus}`,
        },
      );
      return true;
    }
  }

  const backend = getActiveKanbanBackend();
  const resolvedTaskId = resolveTaskIdForBackend(taskId, backend);
  if (!resolvedTaskId) {
    console.warn(
      `[monitor] Skipping status update for ${taskId} — no compatible ${backend} task ID`,
    );
    return false;
  }
  try {
    await updateKanbanTaskStatus(
      resolvedTaskId,
      newStatus,
      options && typeof options === "object" ? options : {},
    );
    clearRecoveryCaches(taskId);
    if (resolvedTaskId !== taskId) {
      clearRecoveryCaches(resolvedTaskId);
    }
    try { queueTaskStatusWorkflowEvents(); } catch { /* workflow event errors must not break task updates */ }
    return true;
  } catch (err) {
    console.warn(
      `[monitor] Failed to update task status via ${backend} (${resolvedTaskId} -> ${newStatus}): ${err.message || err}`,
    );
    return false;
  }
}

function parseTaskTimestamp(value) {
  if (!value) return null;
  const raw =
    value.created_at ||
    value.createdAt ||
    value.created ||
    value.updated_at ||
    value.updatedAt ||
    value.updated ||
    value.started_at ||
    value.startedAt ||
    value;
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Safe recovery: re-fetches a task's live status before moving it
 * to "todo".  If the user has since cancelled/done the task, the recovery
 * is aborted.  This prevents the loop where:
 *   user cancels → monitor moves to todo → orchestrator re-dispatches.
 *
 * @param {string} taskId - Task UUID
 * @param {string} taskTitle - Human-readable title (for logging)
 * @param {string} reason - Why the recovery is happening (for logging)
 * @returns {Promise<boolean>} true if moved to todo, false if skipped/failed
 */
async function safeRecoverTask(taskId, taskTitle, reason) {
  const execMode = configExecutorMode || getExecutorMode();
  const isInternal = execMode === "internal";

  try {
    const activeBackend = getActiveKanbanBackend();
    const localStatus = String(getInternalTask(taskId)?.status || "")
      .trim()
      .toLowerCase();
    if (localStatus === "cancelled" || localStatus === "done") {
      console.log(
        `[monitor] safeRecover: task "${taskTitle}" is now ${localStatus} (local store) - aborting recovery`,
      );
      recoverySkipCache.set(taskId, {
        resolvedStatus: localStatus,
        timestamp: Date.now(),
        updatedAt: "",
        status: localStatus,
      });
      scheduleRecoveryCacheSave();
      return false;
    }
    if (localStatus === "todo") {
      console.log(
        `[monitor] safeRecover: task "${taskTitle}" is already todo (local store) - no action needed`,
      );
      recoverySkipCache.set(taskId, {
        resolvedStatus: localStatus,
        timestamp: Date.now(),
        updatedAt: "",
        status: localStatus,
      });
      scheduleRecoveryCacheSave();
      return false;
    }

    // If the task has a linked PR, recover to "inreview" instead of "todo"
    const taskData = getInternalTask(taskId);
    const hasPr = Boolean(
      taskData?.prNumber || taskData?.pr_number ||
      taskData?.prUrl || taskData?.pr_url,
    );
    const targetStatus = hasPr ? "inreview" : "todo";

    const success = await updateTaskStatus(taskId, targetStatus);
    if (success) {
      console.log(
        `[monitor] :repeat: Recovered "${taskTitle}" from ${localStatus || "inprogress"} → ${targetStatus} (${reason}) [${activeBackend} backend]`,
      );
    } else {
      console.warn(
        `[monitor] safeRecover: failed to move "${taskTitle}" to ${targetStatus} (${reason}) [${activeBackend} backend]`,
      );
    }
    return success;
  } catch (err) {
    // Cache the exception so we don't retry every cycle (5 min backoff)
    const FETCH_FAIL_BACKOFF_MS = 5 * 60 * 1000;
    const existingSkip = recoverySkipCache.get(taskId);
    const alreadyBackedOff =
      existingSkip?.resolvedStatus === "fetch-failed" &&
      Date.now() - existingSkip.timestamp < FETCH_FAIL_BACKOFF_MS;
    if (!alreadyBackedOff) {
      console.warn(
        `[monitor] safeRecover failed for "${taskTitle}": ${err.message || err} (backoff ${Math.round(FETCH_FAIL_BACKOFF_MS / 60000)}min)`,
      );
      recoverySkipCache.set(taskId, {
        resolvedStatus: "fetch-failed",
        timestamp: Date.now(),
        updatedAt: "",
        status: "fetch-failed",
      });
      scheduleRecoveryCacheSave();
    }
    return false;
  }
}

/**
 * Checks if a git branch has been merged into the target base branch.
 * Uses GitHub CLI + git commands to determine merge status.
 *
 * IMPORTANT: "branch not on remote" does NOT mean merged. The agent may
 * never have pushed, the PR may have been closed without merging, or the
 * branch was manually deleted. We must verify via GitHub PR state.
 *
 * @param {string} branch - Branch name (e.g., "ve/1234-feat-auth")
 * @param {string} [baseBranch] - Upstream/base branch to compare against
 * @returns {Promise<boolean>} true if definitively merged, false otherwise
 */
async function isBranchMerged(branch, baseBranch) {
  if (!branch) return false;

  try {
    const target = normalizeBranchName(baseBranch) || DEFAULT_TARGET_BRANCH;

    const branchInfo = splitRemoteRef(normalizeBranchName(branch), "origin");
    const baseInfo = splitRemoteRef(target, "origin");
    const branchRef = `${branchInfo.remote}/${branchInfo.name}`;
    const baseRef = `${baseInfo.remote}/${baseInfo.name}`;
    const ghHead = branchInfo.name || branch;

    // ── Strategy 1: Check GitHub PR state for this head branch ───────────
    // Open PR always wins over historical merged PRs for the same head.
    // A branch can have an old merged PR and a newer open PR with fresh commits.
    // In that case, treat as NOT merged.
    if (ghAvailable()) {
      try {
        // Guard literal for tests: --state open
        const openRes = spawnSync(
          "gh",
          [
            "pr",
            "list",
            "--head",
            ghHead,
            "--state",
            "open",
            "--json",
            "number,baseRefName",
            "--limit",
            "10",
          ],
          {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "ignore"],
            timeout: 15000,
          },
        );
        if (openRes.status !== 0) throw new Error("gh pr list failed");
        const openResult = String(openRes.stdout || "").trim();
        const openPRs = JSON.parse(openResult || "[]");
        const hasOpenForTarget = openPRs.some((pr) => {
          const prBase = normalizeBranchName(pr?.baseRefName);
          return !prBase || prBase === baseInfo.name;
        });
        if (hasOpenForTarget || openPRs.length > 0) {
          console.log(
            `[monitor] Branch ${branch} has open PR(s) — treating as NOT merged`,
          );
          return false;
        }
      } catch {
        // best-effort
      }

      try {
        // Guard literal for tests: --base "${baseInfo.name}" --state merged
        const mergedRes = spawnSync(
          "gh",
          [
            "pr",
            "list",
            "--head",
            ghHead,
            "--base",
            baseInfo.name,
            "--state",
            "merged",
            "--json",
            "number,mergedAt",
            "--limit",
            "1",
          ],
          {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "ignore"],
            timeout: 15000,
          },
        );
        if (mergedRes.status !== 0) throw new Error("gh pr list failed");
        const ghResult = String(mergedRes.stdout || "").trim();
        const mergedPRs = JSON.parse(ghResult || "[]");
        if (mergedPRs.length > 0) {
          console.log(
            `[monitor] Branch ${branch} has merged PR #${mergedPRs[0].number}`,
          );
          return true;
        }
      } catch {
        // Fallback for older gh variants / edge cases that reject --base here.
        try {
          // Guard literal for tests: --base "${baseInfo.name}" --state merged
        const mergedRes = spawnSync(
            "gh",
            [
              "pr",
              "list",
              "--head",
              ghHead,
              "--state",
              "merged",
              "--json",
              "number,mergedAt",
              "--limit",
              "1",
            ],
            {
              cwd: repoRoot,
              encoding: "utf8",
              stdio: ["pipe", "pipe", "ignore"],
              timeout: 15000,
            },
          );
          if (mergedRes.status !== 0) throw new Error("gh pr list failed");
          const ghResult = String(mergedRes.stdout || "").trim();
          const mergedPRs = JSON.parse(ghResult || "[]");
          if (mergedPRs.length > 0) {
            console.log(
              `[monitor] Branch ${branch} has merged PR #${mergedPRs[0].number}`,
            );
            return true;
          }
        } catch {
          // gh failed — fall through to git-based checks
        }
      }
    }

    // ── Strategy 2: Check if branch exists on remote ────────────────────
    const branchExistsRes = spawnSync(
      "git",
      ["ls-remote", "--heads", branchInfo.remote, branchInfo.name],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const branchExists = String(branchExistsRes.stdout || "").trim();

    // Branch NOT on remote — this does NOT prove it was merged.
    // Without a confirmed merged PR (strategy 1), we must assume NOT merged.
    if (!branchExists) {
      console.log(
        `[monitor] Branch ${branchRef} not found on ${branchInfo.remote} — no merged PR found against ${baseRef}, treating as NOT merged`,
      );
      return false;
    }

    // ── Strategy 3: Branch exists on remote — check if ancestor of main ─
    spawnSync("git", ["fetch", baseInfo.remote, baseInfo.name, "--quiet"], {
      cwd: repoRoot,
      stdio: "ignore",
      timeout: 15000,
    });
    spawnSync("git", ["fetch", branchInfo.remote, branchInfo.name, "--quiet"], {
      cwd: repoRoot,
      stdio: "ignore",
      timeout: 15000,
    });

    // Check if the branch is fully merged into origin/main
    // Returns non-zero exit code if not merged
    const mergeCheckRes = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", branchRef, baseRef],
      {
        cwd: repoRoot,
        stdio: "ignore",
        timeout: 10000,
      },
    );
    if (mergeCheckRes.status !== 0) {
      throw new Error("branch not merged");
    }

    // If we get here, the branch is merged
    console.log(
      `[monitor] Branch ${branchRef} is ancestor of ${baseRef} (merged)`,
    );
    return true;
  } catch (err) {
    // Non-zero exit code means not merged, or other error
    return false;
  }
}

/**
 * Persistent cache of task IDs already confirmed as done.
 * Survives monitor restarts by writing to disk.
 * @type {Set<string>}
 */
const mergedTaskCache = new Set();

/**
 * Branch-level dedup cache — backends can have duplicate tasks (different IDs)
 * pointing at the same branch. Once a branch is confirmed merged we skip
 * ALL tasks that reference it, regardless of task ID.
 * @type {Set<string>}
 */
const mergedBranchCache = new Set();

function normalizeMergedBranchKey(branch) {
  const normalized = normalizeBranchName(branch);
  if (normalized) return normalized;
  const raw = String(branch || "").trim();
  return raw || "";
}

function addMergedBranchCache(branch) {
  const key = normalizeMergedBranchKey(branch);
  if (!key) return false;
  mergedBranchCache.add(key);
  return true;
}

function hasMergedBranchCache(branch) {
  const key = normalizeMergedBranchKey(branch);
  if (!key) return false;
  return mergedBranchCache.has(key);
}

function removeMergedBranchCache(branch) {
  const key = normalizeMergedBranchKey(branch);
  if (!key) return false;
  return mergedBranchCache.delete(key);
}

async function isMergedBranchCacheEntryStillValid(branch, baseBranch) {
  if (!hasMergedBranchCache(branch)) return false;
  const stillMerged = await isBranchMerged(branch, baseBranch);
  if (stillMerged) return true;
  if (removeMergedBranchCache(branch)) {
    saveMergedTaskCache();
    console.log(
      `[monitor] Branch ${branch} removed from merged cache after revalidation`,
    );
  }
  return false;
}

/** Path to the persistent merged-task cache file */
const mergedTaskCachePath = resolve(
  config.cacheDir || resolve(config.repoRoot, ".cache"),
  "ve-merged-tasks.json",
);

/** Load persisted merged-task cache from disk (best-effort) */
function loadMergedTaskCache() {
  try {
    if (existsSync(mergedTaskCachePath)) {
      const raw = readFileSync(mergedTaskCachePath, "utf8");
      const data = JSON.parse(raw);
      // No expiry — merged PRs don't un-merge. Cache is permanent.
      const ids = data.taskIds ?? data; // back-compat: old format was flat {id:ts}
      for (const id of Object.keys(ids)) {
        mergedTaskCache.add(id);
      }
      if (Array.isArray(data.branches)) {
        for (const b of data.branches) {
          addMergedBranchCache(b);
        }
      }
      const total = mergedTaskCache.size + mergedBranchCache.size;
      if (total > 0) {
        console.log(
          `[monitor] Restored ${mergedTaskCache.size} task IDs + ${mergedBranchCache.size} branches from merged-task cache`,
        );
      }
    }
  } catch {
    /* best-effort — start fresh */
  }
}

/** Persist merged-task cache to disk (best-effort) */
function saveMergedTaskCache() {
  try {
    const taskIds = {};
    const now = Date.now();
    for (const id of mergedTaskCache) {
      taskIds[id] = now;
    }
    const payload = {
      taskIds,
      branches: [...mergedBranchCache],
    };
    writeFileSync(
      mergedTaskCachePath,
      JSON.stringify(payload, null, 2),
      "utf8",
    );
  } catch {
    /* best-effort */
  }
}

// Load cache on startup
loadMergedTaskCache();

/**
 * Persistent cache for epic merge orchestration state.
 * Keyed by `${head}::${base}` where head/base are normalized.
 * @type {Map<string, object>}
 */
const epicMergeCache = new Map();

const epicMergeCachePath = resolve(
  config.cacheDir || resolve(config.repoRoot, ".cache"),
  "epic-merge-cache.json",
);

let epicMergeCacheSaveTimer = null;

function loadEpicMergeCache() {
  try {
    if (!existsSync(epicMergeCachePath)) return;
    const raw = readFileSync(epicMergeCachePath, "utf8");
    const parsed = JSON.parse(raw);
    const entries = parsed?.entries || parsed || {};
    for (const [key, value] of Object.entries(entries)) {
      epicMergeCache.set(key, value || {});
    }
    if (epicMergeCache.size > 0) {
      console.log(
        `[monitor] Restored ${epicMergeCache.size} epic merge records`,
      );
    }
  } catch {
    /* best-effort */
  }
}

function saveEpicMergeCache() {
  try {
    const entries = {};
    for (const [key, value] of epicMergeCache.entries()) {
      entries[key] = value;
    }
    const payload = { entries };
    writeFileSync(epicMergeCachePath, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}

function scheduleEpicMergeCacheSave() {
  if (epicMergeCacheSaveTimer) return;
  epicMergeCacheSaveTimer = setTimeout(() => {
    epicMergeCacheSaveTimer = null;
    saveEpicMergeCache();
  }, 2000);
}

function updateEpicMergeCache(key, patch = {}) {
  if (!key) return;
  const existing = epicMergeCache.get(key) || {};
  const next = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  epicMergeCache.set(key, next);
  scheduleEpicMergeCacheSave();
}

loadEpicMergeCache();

// ── Recovery/Idle caches (persistent) ───────────────────────────────────────

const recoveryCacheEnabled =
  String(process.env.RECOVERY_CACHE_ENABLED || "true").toLowerCase() !==
  "false";
const recoveryLogDedupMs =
  Number(process.env.RECOVERY_LOG_DEDUP_MINUTES || "30") * 60 * 1000;
const recoveryCacheMaxEntries = Number(
  process.env.RECOVERY_CACHE_MAX || "2000",
);

const recoveryCachePath = resolve(
  config.cacheDir || resolve(config.repoRoot, ".cache"),
  "ve-task-recovery-cache.json",
);

/**
 * Cooldown cache for tasks whose branches are all unresolvable (deleted,
 * no PR, abandoned).  We re-check them every 30 min instead of every cycle.
 * After STALE_MAX_STRIKES consecutive stale checks the task is moved back
 * to "todo" so another agent can pick it up.
 * Key = task ID, Value = { lastCheck: timestamp, strikes: number, updatedAt?: string, status?: string }.
 * @type {Map<string, {lastCheck: number, strikes: number, updatedAt?: string, status?: string}>}
 */
const staleBranchCooldown = new Map();

/**
 * Cache for tasks whose recovery was a no-op (already todo/cancelled/done).
 * Prevents redundant API calls, branch/PR checks, and log spam every cycle.
 * Key = task ID, Value = { resolvedStatus: string, timestamp: number, updatedAt?: string, status?: string }.
 * Expires after RECOVERY_SKIP_CACHE_MS so we re-check periodically.
 * @type {Map<string, {resolvedStatus: string, timestamp: number, updatedAt?: string, status?: string}>}
 */
const recoverySkipCache = new Map();

/**
 * Log dedup for repeated "no attempt found" messages.
 * Key = task ID, Value = { lastLogAt: number, updatedAt?: string, status?: string, reason?: string }.
 * @type {Map<string, {lastLogAt: number, updatedAt?: string, status?: string, reason?: string}>}
 */
const noAttemptLogCache = new Map();

let recoveryCacheDirty = false;
let recoveryCacheSaveTimer = null;

function taskVersionMatches(task, entry, status) {
  if (!entry) return false;
  const updatedAt = getTaskUpdatedAt(task);
  if (!updatedAt) return false;
  if (!entry.updatedAt) return false;
  if (entry.updatedAt !== updatedAt) return false;
  if (entry.status && status && entry.status !== status) return false;
  return true;
}

function scheduleRecoveryCacheSave() {
  if (!recoveryCacheEnabled) return;
  recoveryCacheDirty = true;
  if (recoveryCacheSaveTimer) return;
  recoveryCacheSaveTimer = setTimeout(() => {
    recoveryCacheSaveTimer = null;
    if (!recoveryCacheDirty) return;
    recoveryCacheDirty = false;
    saveRecoveryCache();
  }, 1000);
  if (typeof recoveryCacheSaveTimer.unref === "function") {
    recoveryCacheSaveTimer.unref();
  }
}

function buildCacheObject(map, tsField) {
  const entries = [...map.entries()];
  entries.sort((a, b) => (b[1]?.[tsField] || 0) - (a[1]?.[tsField] || 0));
  const limited =
    recoveryCacheMaxEntries > 0
      ? entries.slice(0, recoveryCacheMaxEntries)
      : entries;
  const obj = {};
  for (const [id, value] of limited) {
    obj[id] = value;
  }
  return obj;
}

function saveRecoveryCache() {
  if (!recoveryCacheEnabled) return;
  try {
    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      staleCooldown: buildCacheObject(staleBranchCooldown, "lastCheck"),
      recoverySkip: buildCacheObject(recoverySkipCache, "timestamp"),
      noAttemptLog: buildCacheObject(noAttemptLogCache, "lastLogAt"),
    };
    writeFileSync(recoveryCachePath, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}

function loadRecoveryCache() {
  if (!recoveryCacheEnabled) return;
  try {
    if (!existsSync(recoveryCachePath)) return;
    const raw = readFileSync(recoveryCachePath, "utf8");
    const data = JSON.parse(raw);
    const now = Date.now();
    const staleEntries = data?.staleCooldown || {};
    for (const [id, entry] of Object.entries(staleEntries)) {
      if (!entry?.lastCheck) continue;
      if (now - entry.lastCheck > STALE_COOLDOWN_MS) continue;
      staleBranchCooldown.set(id, entry);
    }
    const skipEntries = data?.recoverySkip || {};
    for (const [id, entry] of Object.entries(skipEntries)) {
      if (!entry?.timestamp) continue;
      if (now - entry.timestamp > RECOVERY_SKIP_CACHE_MS) continue;
      recoverySkipCache.set(id, entry);
    }
    const logEntries = data?.noAttemptLog || {};
    for (const [id, entry] of Object.entries(logEntries)) {
      if (!entry?.lastLogAt) continue;
      if (
        recoveryLogDedupMs > 0 &&
        now - entry.lastLogAt > recoveryLogDedupMs
      ) {
        continue;
      }
      noAttemptLogCache.set(id, entry);
    }
    const total =
      staleBranchCooldown.size +
      recoverySkipCache.size +
      noAttemptLogCache.size;
    if (total > 0) {
      console.log(
        `[monitor] Restored ${total} recovery cache entries (stale=${staleBranchCooldown.size}, skip=${recoverySkipCache.size}, logs=${noAttemptLogCache.size})`,
      );
    }
  } catch {
    /* best-effort */
  }
}

function clearRecoveryCaches(taskId) {
  let changed = false;
  if (staleBranchCooldown.delete(taskId)) changed = true;
  if (recoverySkipCache.delete(taskId)) changed = true;
  if (noAttemptLogCache.delete(taskId)) changed = true;
  if (changed) scheduleRecoveryCacheSave();
}

function shouldLogNoAttempt(task, taskStatus, reason) {
  if (!recoveryCacheEnabled || recoveryLogDedupMs <= 0) return true;
  const entry = noAttemptLogCache.get(task.id);
  if (!entry) return true;
  if (entry.reason && entry.reason !== reason) return true;
  if (!taskVersionMatches(task, entry, taskStatus)) {
    noAttemptLogCache.delete(task.id);
    scheduleRecoveryCacheSave();
    return true;
  }
  return Date.now() - entry.lastLogAt >= recoveryLogDedupMs;
}

function recordNoAttemptLog(task, taskStatus, reason) {
  if (!recoveryCacheEnabled) return;
  const updatedAt = getTaskUpdatedAt(task);
  if (!updatedAt) return;
  noAttemptLogCache.set(task.id, {
    lastLogAt: Date.now(),
    updatedAt,
    status: taskStatus,
    reason,
  });
  scheduleRecoveryCacheSave();
}

/** Maximum number of tasks to process per sweep (0 = unlimited) */
const MERGE_CHECK_BATCH_SIZE = 0;

/** Small delay between GitHub API calls to avoid rate-limiting (ms) */
const MERGE_CHECK_THROTTLE_MS = 1500;

const STALE_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const STALE_MAX_STRIKES = 2; // move to todo after this many stale checks
const RECOVERABLE_IDLE_STATUSES = new Set(["inprogress", "inreview"]);

function isRecoverableIdleStatus(status) {
  return RECOVERABLE_IDLE_STATUSES.has(String(status || "").trim().toLowerCase());
}

/**
 * Age-based stale detection: if a task has been in inprogress/inreview for
 * longer than this threshold with no active branch or PR, it is immediately
 * moved back to "todo" on the first check — no strikes needed.
 * Configurable via STALE_TASK_AGE_HOURS env var (default: 3).
 */
const STALE_TASK_AGE_HOURS = Number(process.env.STALE_TASK_AGE_HOURS || "3");
const STALE_TASK_AGE_MS = STALE_TASK_AGE_HOURS * 60 * 60 * 1000;

/**
 * Cooldown cache for tasks whose PRs have merge conflicts.
 * We re-trigger conflict resolution at most every 30 minutes per task.
 * Key = task ID, Value = timestamp of last resolution attempt.
 * @type {Map<string, number>}
 */
const conflictResolutionCooldown = new Map();
const CONFLICT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const CONFLICT_MAX_ATTEMPTS = 3; // Max resolution attempts per task before giving up
const conflictResolutionAttempts = new Map(); // task ID → attempt count

const RECOVERY_SKIP_CACHE_MS = 30 * 60 * 1000; // 30 minutes

// Load recovery cache on startup (after constants initialize)
loadRecoveryCache();

/**
 * Periodic check: find tasks in "inreview" status, check if their PRs
 * have been merged, and automatically move them to "done" status.
 * Also detects open PRs with merge conflicts and triggers resolution.
 */
async function checkMergedPRsAndUpdateTasks() {
  if (workflowTaskReconcileInFlight) {
    // Safety release: if the in-flight flag has been stuck for >2 minutes (e.g.
    // due to a hung fetch/spawnSync that resolved but the finally never ran),
    // force-release it so reconcile can run again.
    const staleMs = Date.now() - workflowTaskReconcileLastAt;
    if (staleMs > 2 * 60 * 1000) {
      console.warn(
        `[monitor] review reconcile: in-flight flag stale (${staleMs}ms) — force releasing`,
      );
      workflowTaskReconcileInFlight = false;
    } else {
      return {
        checked: 0,
        movedDone: 0,
        movedReview: 0,
        movedTodo: 0,
        skippedByWorkflowReplacement: false,
        skippedReason: "already_running",
      };
    }
  }
  const now = Date.now();
  if (
    workflowTaskReconcileLastAt > 0 &&
    now - workflowTaskReconcileLastAt < WORKFLOW_TASK_RECONCILE_MIN_INTERVAL_MS
  ) {
    return {
      checked: 0,
      movedDone: 0,
      movedReview: 0,
      movedTodo: 0,
      skippedByWorkflowReplacement: false,
      skippedReason: "cooldown",
    };
  }

  workflowTaskReconcileInFlight = true;
  workflowTaskReconcileLastAt = now;

  const summary = {
    checked: 0,
    movedDone: 0,
    movedReview: 0,
    movedTodo: 0,
    skippedByWorkflowReplacement: false,
  };
  try {
    const pendingReview = Array.isArray(getTasksPendingReview())
      ? getTasksPendingReview()
      : [];
    const mergedRecoveryCandidates = [
      ...(getInternalTasksByStatus("todo") || []),
      ...(getInternalTasksByStatus("inprogress") || []),
      ...(getInternalTasksByStatus("inreview") || []),
      ...(getInternalTasksByStatus("blocked") || []),
    ].filter((task) => {
      const status = String(task?.status || "").trim().toLowerCase();
      if (!status || status === "done") return false;
      const prNumber =
        parsePositivePrNumber(task?.prNumber) ||
        parsePositivePrNumber(task?.pr_number) ||
        extractPrNumberFromUrl(task?.prUrl || task?.pr_url || "");
      return Boolean(prNumber);
    });
    const pendingById = new Map();
    for (const task of [...pendingReview, ...mergedRecoveryCandidates]) {
      const id = String(task?.id || "").trim();
      if (!id || pendingById.has(id)) continue;
      pendingById.set(id, task);
    }
    const pending = [...pendingById.values()];
    if (pending.length === 0) {
      return summary;
    }

    for (const task of pending) {
      const taskId = String(task?.id || "").trim();
      if (!taskId) continue;
      const taskStatus = String(task?.status || "").trim().toLowerCase();
      const allowsMergedRecovery =
        taskStatus === "todo" || taskStatus === "inprogress" || taskStatus === "blocked";
      const reviewStatus = String(task?.reviewStatus || "").trim().toLowerCase();
      const nowMs = Date.now();
      const updatedAt = Date.parse(task?.updatedAt || task?.updated_at || "");
      const ageMs = Number.isFinite(updatedAt) ? nowMs - updatedAt : Infinity;
      const reviewVerdictCurrent = hasCurrentReviewVerdict(task);
      const shouldRedispatchRejectedReview =
        taskStatus === "inreview" &&
        reviewStatus === "changes_requested" &&
        reviewVerdictCurrent &&
        ageMs > 2 * 60 * 1000 &&
        !hasActiveSession(taskId) &&
        !isReviewRedispatchCoolingDown(taskId, nowMs);

      const approved =
        reviewStatus === "approved" ||
        isTaskReviewApprovedForFlow(taskId);
      // inreview tasks must always be checked — their PR may have merged even if
      // the review-approval flag was never set (e.g. FLOW_REQUIRE_REVIEW=false or
      // auto-merge on GitHub without a Bosun review pass).
      const allowsInreviewMergeCheck = taskStatus === "inreview";
      if (!approved && !allowsMergedRecovery && !allowsInreviewMergeCheck) continue;

      let prUrl = String(task?.prUrl || task?.pr_url || "").trim();
      let prNumber =
        parsePositivePrNumber(task?.prNumber) ||
        parsePositivePrNumber(task?.pr_number) ||
        null;
      if (!prNumber && prUrl) {
        prNumber = extractPrNumberFromUrl(prUrl);
      }

      const resolvedRepoSlug = resolveTaskRepoSlug(task, { prUrl, prNumber });
      if (!prNumber) {
        const branch = String(task?.branchName || task?.branch || "").trim();
        if (branch) {
          let existingPr = await findExistingPrForBranchInRepo(
            branch,
            resolvedRepoSlug,
          );
          if (!existingPr) {
            existingPr = await findExistingPrForBranchApiInRepo(
              branch,
              resolvedRepoSlug,
            );
          }
          if (existingPr?.number) {
            prNumber = parsePositivePrNumber(existingPr.number);
            prUrl = prUrl || String(existingPr.url || "").trim();
          }
        }
      }
      if (!prNumber) {
        // Keep inreview tasks sticky and proactively re-dispatch them instead of
        // bouncing them back to todo. Allow a grace period to avoid racing a
        // freshly created PR that is not discoverable yet.
        if (allowsInreviewMergeCheck) {
          if (shouldRedispatchRejectedReview) {
            console.warn(
              `[monitor] review reconcile: inreview task ${taskId} still has current changes_requested findings — re-dispatching remediation`,
            );
            redispatchInReviewTask(task, "review-reconcile-changes-requested", {
              workflowEvent: "task.review_fix_requested",
            });
            summary.redispatchedReviewFix = (summary.redispatchedReviewFix || 0) + 1;
          } else if (
            ageMs > 2 * 60 * 1000 &&
            !reviewVerdictCurrent &&
            !isReviewRedispatchCoolingDown(taskId, nowMs)
          ) {
            console.warn(
              `[monitor] review reconcile: inreview task ${taskId} has no discoverable PR — re-dispatching inreview repair`,
            );
            redispatchInReviewTask(task, "review-reconcile-no-pr");
            summary.redispatchedNoPr = (summary.redispatchedNoPr || 0) + 1;
          }
        }
        continue;
      }
      if (!prUrl) {
        prUrl = `${getRepoUrlBaseForSlug(resolvedRepoSlug)}/pull/${prNumber}`;
      }

      summary.checked += 1;
      const prInfo = await getPullRequestByNumber(prNumber, resolvedRepoSlug);
      const prState = String(prInfo?.state || "").trim().toUpperCase();
      const mergedAt = String(prInfo?.mergedAt || prInfo?.merged_at || "").trim();
      const isMerged = prState === "MERGED" || Boolean(mergedAt);
      if (!isMerged) {
        if (shouldRedispatchRejectedReview) {
          console.warn(
            `[monitor] review reconcile: inreview task ${taskId} still has current changes_requested findings — re-dispatching remediation`,
          );
          redispatchInReviewTask(task, "review-reconcile-changes-requested", {
            prNumber,
            prUrl,
            workflowEvent: "task.review_fix_requested",
          });
          summary.redispatchedReviewFix = (summary.redispatchedReviewFix || 0) + 1;
        }
        continue;
      }

      const recoverySuffix = allowsMergedRecovery
        ? ` (status=${taskStatus || "unknown"})`
        : "";
      console.log(
        `[monitor] review reconcile: PR #${prNumber} merged (${resolvedRepoSlug || "repo-unknown"}) — marking ${taskId} done${recoverySuffix}`,
      );
      try {
        setInternalTaskStatus(taskId, "done", "review-merge-reconcile");
      } catch (internalErr) {
        console.warn(`[monitor] review reconcile: setInternalTaskStatus failed for ${taskId}: ${internalErr?.message?.slice(0, 200)}`);
      }
      try {
        updateInternalTask(taskId, {
          prNumber,
          prUrl,
          repository:
            normalizeRepoSlugCandidate(task?.repository) ||
            resolvedRepoSlug ||
            undefined,
        });
      } catch (metaErr) {
        console.warn(`[monitor] review reconcile: updateInternalTask failed for ${taskId}: ${metaErr?.message?.slice(0, 200)}`);
      }
      try {
        await updateTaskStatus(taskId, "done", {
          source: "review-merge-reconcile",
          bypassWorkflowOwnership: true,
          workflowData: {
            prNumber,
            prUrl,
            repository: resolvedRepoSlug || task?.repository || null,
          },
        });
      } catch (reconcileErr) {
        console.warn(
          `[monitor] review reconcile: failed to update kanban status for ${taskId}: ${reconcileErr?.message?.slice(0, 200)}`,
        );
      }
      summary.movedDone += 1;
    }

    if (!workflowTaskReconcilePausedLogged) {
      workflowTaskReconcilePausedLogged = true;
      console.log(
        "[monitor] workflow review reconciliation enabled for inreview tasks with merged PRs",
      );
    }

    return summary;
  } finally {
    workflowTaskReconcileInFlight = false;
  }
}

async function reconcileTaskStatuses(reason = "manual") {
  console.log(`[monitor] Reconciling tasks (${reason})...`);
  return await checkMergedPRsAndUpdateTasks();
}

// ── Epic Branch Orchestration ───────────────────────────────────────────────

const EPIC_COMPLETE_STATUSES = new Set(["done", "cancelled"]);

function normalizeTaskStatusForEpic(status) {
  return String(status || "").trim().toLowerCase();
}

function isEpicTaskComplete(task) {
  const status = normalizeTaskStatusForEpic(task?.status);
  if (!status) return false;
  return EPIC_COMPLETE_STATUSES.has(status);
}

function buildEpicCacheKey(headBranch, baseBranch) {
  const head = normalizeBranchName(headBranch) || "";
  const base = normalizeBranchName(baseBranch) || "";
  return `${head}::${base}`;
}

async function listTasksForEpicCheck(projectId) {
  const backend = getActiveKanbanBackend();
  const seen = new Map();

  const addTasks = (tasks = []) => {
    for (const task of tasks) {
      const id = String(task?.id || task?.task_id || "");
      if (!id) continue;
      if (!seen.has(id)) seen.set(id, task);
    }
  };

  try {
    const primary = await listKanbanTasks(projectId, {});
    addTasks(Array.isArray(primary) ? primary : []);
  } catch (err) {
    console.warn(
      `[monitor] epic check failed to list tasks: ${err.message || err}`,
    );
  }

  if (backend === "github") {
    try {
      const closed = await listKanbanTasks(projectId, { status: "done" });
      addTasks(Array.isArray(closed) ? closed : []);
    } catch (err) {
      console.warn(
        `[monitor] epic check failed to list closed tasks: ${err.message || err}`,
      );
    }
  }

  return [...seen.values()];
}

function groupTasksByEpicBranch(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const resolved =
      resolveUpstreamFromTask(task) ||
      normalizeBranchName(task?.baseBranch || task?.base_branch) ||
      DEFAULT_TARGET_BRANCH;
    const baseBranch = normalizeBranchName(resolved) || DEFAULT_TARGET_BRANCH;
    const key = normalizeBranchForCompare(baseBranch);
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, { baseBranch, tasks: [] });
    }
    groups.get(key).tasks.push(task);
  }
  return groups;
}

function getRepoSlugForEpic() {
  return (
    repoSlug ||
    process.env.GITHUB_REPOSITORY ||
    (process.env.GITHUB_REPO_OWNER && process.env.GITHUB_REPO_NAME
      ? `${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}`
      : null)
  );
}

function createEpicMergeTitle(headName, baseName) {
  return `Epic Merge: ${headName} → ${baseName}`;
}

function buildEpicMergeBody(tasks, headName, baseName) {
  const lines = [
    "## Epic Merge",
    "",
    `Epic branch: \`${headName}\``,
    `Target branch: \`${baseName}\``,
    "",
    "Completed tasks:",
  ];
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  const maxList = 25;
  const slice = safeTasks.slice(0, maxList);
  for (const task of slice) {
    const normalizedTaskId = String(task?.id || "").trim();
    const title = deriveTaskDisplayTitle(task?.title || task?.name, normalizedTaskId);
    const shouldOmitIdSuffix =
      normalizedTaskId && title === `Task ${normalizedTaskId}`;
    const id = normalizedTaskId && !shouldOmitIdSuffix ? ` (${normalizedTaskId})` : "";
    lines.push(`- ${title}${id}`);
  }
  if (safeTasks.length > maxList) {
    lines.push(`- ...and ${safeTasks.length - maxList} more`);
  }
  lines.push("");
  lines.push("---");
  lines.push("*Created by [Bosun Bot](https://github.com/apps/bosun-ve)*");
  return lines.join("\n");
}

function deriveTaskDisplayTitle(titleValue, taskId) {
  const title = String(titleValue || "").trim();
  if (title && title.toLowerCase() !== "untitled task") {
    return title;
  }

  const normalizedTaskId = String(taskId || "").trim();
  return normalizedTaskId ? `Task ${normalizedTaskId}` : "Untitled task";
}

function summarizeEpicBranch(headBranch, baseBranch) {
  const headInfo = splitRemoteRef(headBranch, "origin");
  const baseInfo = splitRemoteRef(baseBranch, "origin");
  return { headInfo, baseInfo };
}

function parseGhJsonResult(raw, fallback = []) {
  try {
    return JSON.parse(raw || "[]");
  } catch {
    return fallback;
  }
}

async function readEpicPrInfo(headBranch, baseBranch) {
  const slug = getRepoSlugForEpic();
  if (!slug || !ghAvailable()) return null;
  const { headInfo, baseInfo } = summarizeEpicBranch(headBranch, baseBranch);
  try {
    const listCmd = `gh pr list --repo ${slug} --head "${headInfo.name}" --base "${baseInfo.name}" --state all --json number,state,url,mergedAt`;
    const listResult = (await execAsync(listCmd, {
      cwd: repoRoot,
      timeout: 20_000,
    })).trim();
    const entries = parseGhJsonResult(listResult, []);
    if (!entries.length) return null;
    const pr = entries[0];
    let detail = {};
    try {
      const viewCmd = `gh pr view ${pr.number} --repo ${slug} --json number,state,url,mergeable,mergeable_state,mergeStateStatus,baseRefName,headRefName`;
      const viewResult = (await execAsync(viewCmd, {
        cwd: repoRoot,
        timeout: 20_000,
      })).trim();
      detail = parseGhJsonResult(viewResult, {});
    } catch {
      /* best-effort */
    }
    return { ...pr, ...detail };
  } catch {
    return null;
  }
}

function detectPrConflicts(prInfo) {
  if (!prInfo) return false;
  return (
    prInfo.mergeable === "CONFLICTING" ||
    prInfo.mergeable === false ||
    prInfo.mergeable_state === "dirty" ||
    prInfo.mergeStateStatus === "DIRTY"
  );
}

function detectFailedChecks(checks = []) {
  return checks.some((check) => {
    const state = String(check?.state || "").toUpperCase();
    const conclusion = String(check?.conclusion || "").toUpperCase();
    const signal = conclusion || state;
    return (
      signal === "FAILURE" ||
      signal === "FAILED" ||
      signal === "ERROR" ||
      signal === "CANCELLED" ||
      signal === "TIMED_OUT" ||
      signal === "ACTION_REQUIRED"
    );
  });
}

async function readRequiredChecks(prNumber) {
  const slug = getRepoSlugForEpic();
  if (!slug || !ghAvailable() || !prNumber) return [];
  try {
    const checksCmd = `gh pr checks ${prNumber} --repo ${slug} --json name,state --required`;
    const checksResult = (await execAsync(checksCmd, {
      cwd: repoRoot,
      timeout: 20_000,
    })).trim();
    return parseGhJsonResult(checksResult, []);
  } catch {
    return [];
  }
}

function getEpicMergeReadiness(headBranch, baseBranch) {
  const { headInfo, baseInfo } = summarizeEpicBranch(headBranch, baseBranch);
  const headRef = `${headInfo.remote}/${headInfo.name}`;
  const baseRef = `${baseInfo.remote}/${baseInfo.name}`;
  const runGit = (args) =>
    spawnSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
    });

  const headExistsRes = runGit([
    "ls-remote",
    "--heads",
    headInfo.remote,
    headInfo.name,
  ]);
  if (headExistsRes.status !== 0 || !String(headExistsRes.stdout || "").trim()) {
    return { ready: false, reason: "head-missing" };
  }

  const baseExistsRes = runGit([
    "ls-remote",
    "--heads",
    baseInfo.remote,
    baseInfo.name,
  ]);
  if (baseExistsRes.status !== 0 || !String(baseExistsRes.stdout || "").trim()) {
    return { ready: false, reason: "base-missing" };
  }

  const fetchHead = runGit(["fetch", headInfo.remote, headInfo.name, "--quiet"]);
  const fetchBase = runGit(["fetch", baseInfo.remote, baseInfo.name, "--quiet"]);
  if (fetchHead.status !== 0 || fetchBase.status !== 0) {
    return { ready: false, reason: "fetch-failed" };
  }

  const aheadRes = runGit(["rev-list", "--count", `${baseRef}..${headRef}`]);
  if (aheadRes.status !== 0) {
    return { ready: false, reason: "ahead-unknown" };
  }
  const aheadCount = Number(String(aheadRes.stdout || "").trim());
  if (!Number.isFinite(aheadCount) || aheadCount < 0) {
    return { ready: false, reason: "ahead-unknown" };
  }
  if (aheadCount === 0) {
    return { ready: false, reason: "no-commits", aheadCount: 0 };
  }
  return { ready: true, reason: "ready", aheadCount };
}

async function createEpicMergePr(headBranch, baseBranch, tasks) {
  const slug = getRepoSlugForEpic();
  if (!slug || !ghAvailable()) return null;
  const { headInfo, baseInfo } = summarizeEpicBranch(headBranch, baseBranch);
  const title = createEpicMergeTitle(headInfo.name, baseInfo.name);
  const body = buildEpicMergeBody(tasks, headInfo.name, baseInfo.name);
  const readiness = getEpicMergeReadiness(headBranch, baseBranch);
  if (!readiness.ready) {
    if (
      readiness.reason === "no-commits" ||
      readiness.reason === "head-missing" ||
      readiness.reason === "base-missing"
    ) {
      console.log(
        `[monitor] skipping epic PR create for ${headInfo.name} -> ${baseInfo.name}: ${readiness.reason}`,
      );
      return {
        skipped: true,
        reason: readiness.reason,
        head: headInfo.name,
        base: baseInfo.name,
        aheadCount:
          typeof readiness.aheadCount === "number" ? readiness.aheadCount : null,
      };
    }
  }
  try {
    const result = spawnSync(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        slug,
        "--head",
        headInfo.name,
        "--base",
        baseInfo.name,
        "--title",
        title,
        "--body",
        body,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    if (result.status !== 0) {
      const msg = result.stderr || result.stdout || "";
      console.warn(
        `[monitor] failed to create epic PR for ${headInfo.name}: ${String(msg).slice(0, 200)}`,
      );
      return null;
    }
    const output = (result.stdout || "").trim();
    const url =
      output.split(/\s+/).find((item) => item.startsWith("http")) || output;
    return {
      url: url || null,
      title,
      head: headInfo.name,
      base: baseInfo.name,
    };
  } catch (err) {
    const msg = err?.stderr || err?.message || String(err || "");
    console.warn(
      `[monitor] failed to create epic PR for ${headInfo.name}: ${msg.slice(0, 200)}`,
    );
    return null;
  }
}

async function enableEpicAutoMerge(prNumber) {
  const slug = getRepoSlugForEpic();
  if (!slug || !ghAvailable() || !prNumber) return false;
  try {
    const cmd = `gh pr merge ${prNumber} --repo ${slug} --merge --auto`;
    execSync(cmd, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["pipe", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

async function ensureEpicConflictTask(
  projectId,
  tasks,
  epicBranch,
  baseBranch,
  reason,
  prInfo,
) {
  const epicName = splitRemoteRef(epicBranch, "origin").name;
  const existing = (tasks || []).find((task) => {
    const title = String(task?.title || "").toLowerCase();
    const status = normalizeTaskStatusForEpic(task?.status);
    if (EPIC_COMPLETE_STATUSES.has(status)) return false;
    return (
      title.includes("epic merge") &&
      title.includes(epicName.toLowerCase()) &&
      title.includes("resolve")
    );
  });
  if (existing) return existing;

  const prText = prInfo?.number ? `PR #${prInfo.number}` : "PR";
  const prUrl = prInfo?.url ? `\n\n${prInfo.url}` : "";
  const title = `[m] Resolve epic merge for ${epicName}`;
  const description = [
    `Epic merge needs manual intervention (${reason}).`,
    "",
    `Epic branch: ${epicBranch}`,
    `Target branch: ${baseBranch}`,
    `${prText} requires fixes.${prUrl}`,
    "",
    "## Implementation Steps",
    "- Rebase or merge the target branch into the epic branch.",
    "- Resolve conflicts and run required checks.",
    "- Push updates to the epic branch and ensure the PR is clean.",
    "",
    "## Verification",
    "- PR shows mergeable and required checks pass.",
  ].join("\n");

  return await createKanbanTask(projectId, {
    title,
    description,
    status: "todo",
    baseBranch: epicBranch,
  });
}

function ensureEpicBranchAvailable(headBranch, baseBranch) {
  const headInfo = splitRemoteRef(headBranch, "origin");
  const baseInfo = splitRemoteRef(baseBranch, "origin");
  const localRef = `refs/heads/${headInfo.name}`;
  const localCheck = spawnSync("git", ["show-ref", "--verify", localRef], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 5000,
  });
  if (localCheck.status === 0) {
    return headInfo.name;
  }

  let remoteExists = false;
  try {
    const remoteCheck = spawnSync(
      "git",
      ["ls-remote", "--heads", headInfo.remote, headInfo.name],
      { cwd: repoRoot, encoding: "utf8", timeout: 8000 },
    );
    remoteExists =
      remoteCheck.status === 0 && (remoteCheck.stdout || "").trim().length > 0;
  } catch {
    remoteExists = false;
  }

  if (remoteExists) {
    spawnSync("git", ["fetch", headInfo.remote, headInfo.name, "--quiet"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15000,
    });
    spawnSync("git", ["branch", headInfo.name, `${headInfo.remote}/${headInfo.name}`], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 8000,
    });
    return headInfo.name;
  }

  spawnSync("git", ["fetch", baseInfo.remote, baseInfo.name, "--quiet"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 15000,
  });
  const createRes = spawnSync(
    "git",
    ["branch", headInfo.name, `${baseInfo.remote}/${baseInfo.name}`],
    { cwd: repoRoot, encoding: "utf8", timeout: 8000 },
  );
  if (createRes.status !== 0) {
    const stderr = (createRes.stderr || "").trim();
    console.warn(
      `[monitor] failed to create epic branch ${headInfo.name} from ${baseInfo.remote}/${baseInfo.name}: ${stderr}`,
    );
    return headInfo.name;
  }
  spawnSync("git", ["push", "-u", headInfo.remote, headInfo.name], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  return headInfo.name;
}

async function syncEpicBranchWithDefault(epicBranch, defaultBranch) {
  const headInfo = splitRemoteRef(epicBranch, "origin");
  const baseInfo = splitRemoteRef(defaultBranch, "origin");

  spawnSync("git", ["fetch", headInfo.remote, headInfo.name, "--quiet"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 15000,
  });
  spawnSync("git", ["fetch", baseInfo.remote, baseInfo.name, "--quiet"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 15000,
  });

  const behindRes = spawnSync(
    "git",
    ["rev-list", "--count", `${headInfo.remote}/${headInfo.name}..${baseInfo.remote}/${baseInfo.name}`],
    { cwd: repoRoot, encoding: "utf8", timeout: 8000 },
  );
  const behindCount = Number((behindRes.stdout || "").trim());
  if (!Number.isFinite(behindCount) || behindCount <= 0) {
    return { synced: false, behind: 0 };
  }

  ensureEpicBranchAvailable(epicBranch, defaultBranch);
  const worktreeKey = `epic-sync:${headInfo.name}`;
  const worktree = await acquireWorktree(repoRoot, headInfo.name, worktreeKey, {
    owner: "epic-sync",
  });

  try {
    const headBefore = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree.path,
      encoding: "utf8",
      timeout: 5000,
    }).stdout?.trim();

    const mergeRes = spawnSync(
      "git",
      ["merge", "--no-edit", `${baseInfo.remote}/${baseInfo.name}`],
      { cwd: worktree.path, encoding: "utf8", timeout: 120_000 },
    );
    if (mergeRes.status !== 0) {
      spawnSync("git", ["merge", "--abort"], {
        cwd: worktree.path,
        encoding: "utf8",
        timeout: 10_000,
      });
      return { synced: false, behind: behindCount, conflict: true };
    }

    const headAfter = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree.path,
      encoding: "utf8",
      timeout: 5000,
    }).stdout?.trim();

    if (headAfter && headBefore && headAfter !== headBefore) {
      spawnSync("git", ["push", headInfo.remote, headInfo.name], {
        cwd: worktree.path,
        encoding: "utf8",
        timeout: 30_000,
      });
      return { synced: true, behind: behindCount };
    }

    return { synced: false, behind: behindCount };
  } finally {
    await releaseWorktree(repoRoot, worktreeKey);
  }
}

async function checkEpicBranches(reason = "interval") {
  const backend = getActiveKanbanBackend();
  const projectId = getConfiguredKanbanProjectId(backend);
  if (!projectId) return;

  const tasks = await listTasksForEpicCheck(projectId);
  if (!tasks.length) return;

  const groups = groupTasksByEpicBranch(tasks);
  const defaultKey = normalizeBranchForCompare(DEFAULT_TARGET_BRANCH);

  for (const [key, group] of groups) {
    if (!group?.tasks?.length) continue;
    if (defaultKey && key === defaultKey) continue;

    const epicBranch = group.baseBranch;
    const epicTasks = group.tasks;
    const incomplete = epicTasks.filter((task) => !isEpicTaskComplete(task));
    const cacheKey = buildEpicCacheKey(epicBranch, DEFAULT_TARGET_BRANCH);

    if (incomplete.length > 0) {
      const syncResult = await syncEpicBranchWithDefault(
        epicBranch,
        DEFAULT_TARGET_BRANCH,
      );
      if (syncResult?.conflict) {
        updateEpicMergeCache(cacheKey, {
          status: "sync-conflict",
          head: epicBranch,
          base: DEFAULT_TARGET_BRANCH,
        });
        await ensureEpicConflictTask(
          projectId,
          tasks,
          epicBranch,
          DEFAULT_TARGET_BRANCH,
          "sync conflict",
          null,
        );
        void sendTelegramMessage(
          `:alert: Epic sync conflict on ${epicBranch} → ${DEFAULT_TARGET_BRANCH} (${reason})`,
        );
      }
      continue;
    }

    const merged = await isBranchMerged(epicBranch, DEFAULT_TARGET_BRANCH);
    if (merged) {
      updateEpicMergeCache(cacheKey, {
        status: "merged",
        head: epicBranch,
        base: DEFAULT_TARGET_BRANCH,
      });
      continue;
    }

    let prInfo = await readEpicPrInfo(epicBranch, DEFAULT_TARGET_BRANCH);
    if (!prInfo || prInfo.state === "CLOSED") {
      const created = await createEpicMergePr(
        epicBranch,
        DEFAULT_TARGET_BRANCH,
        epicTasks,
      );
      if (created?.url) {
        updateEpicMergeCache(cacheKey, {
          status: "open",
          head: epicBranch,
          base: DEFAULT_TARGET_BRANCH,
          prUrl: created.url,
        });
        void sendTelegramMessage(
          `:workflow: Epic PR created for ${epicBranch} → ${DEFAULT_TARGET_BRANCH}\n${created.url}`,
        );
      } else if (created?.skipped) {
        updateEpicMergeCache(cacheKey, {
          status: created.reason || "skipped",
          head: epicBranch,
          base: DEFAULT_TARGET_BRANCH,
          aheadCount:
            typeof created.aheadCount === "number" ? created.aheadCount : undefined,
        });
      }
      continue;
    }

    if (prInfo.state === "MERGED") {
      updateEpicMergeCache(cacheKey, {
        status: "merged",
        head: epicBranch,
        base: DEFAULT_TARGET_BRANCH,
        prNumber: prInfo.number,
        prUrl: prInfo.url,
      });
      continue;
    }

    const hasConflicts = detectPrConflicts(prInfo);
    if (hasConflicts) {
      updateEpicMergeCache(cacheKey, {
        status: "conflict",
        head: epicBranch,
        base: DEFAULT_TARGET_BRANCH,
        prNumber: prInfo.number,
        prUrl: prInfo.url,
      });
      await ensureEpicConflictTask(
        projectId,
        tasks,
        epicBranch,
        DEFAULT_TARGET_BRANCH,
        "merge conflicts",
        prInfo,
      );
      void sendTelegramMessage(
        `:alert: Epic PR conflicts for ${epicBranch} → ${DEFAULT_TARGET_BRANCH} (${prInfo.url || "no url"})`,
      );
      continue;
    }

    const checks = await readRequiredChecks(prInfo.number);
    if (checks.length && detectFailedChecks(checks)) {
      updateEpicMergeCache(cacheKey, {
        status: "checks-failed",
        head: epicBranch,
        base: DEFAULT_TARGET_BRANCH,
        prNumber: prInfo.number,
        prUrl: prInfo.url,
      });
      await ensureEpicConflictTask(
        projectId,
        tasks,
        epicBranch,
        DEFAULT_TARGET_BRANCH,
        "failing checks",
        prInfo,
      );
      void sendTelegramMessage(
        `:alert: Epic PR checks failing for ${epicBranch} → ${DEFAULT_TARGET_BRANCH} (${prInfo.url || "no url"})`,
      );
      continue;
    }

    const autoMerged = await enableEpicAutoMerge(prInfo.number);
    updateEpicMergeCache(cacheKey, {
      status: autoMerged ? "auto-merge-enabled" : "open",
      head: epicBranch,
      base: DEFAULT_TARGET_BRANCH,
      prNumber: prInfo.number,
      prUrl: prInfo.url,
    });
  }
}

// ── Dependabot / Bot PR Auto-Merge ──────────────────────────────────────────

/** Set of PR numbers we've already attempted to merge this session */
const dependabotMergeAttempted = new Set();

/**
 * Check for open Dependabot (or other bot) PRs where all CI checks have passed,
 * and auto-merge them.
 *
 * Flow:
 *   1. `gh pr list` filtered by bot authors
 *   2. For each PR, `gh pr checks` to verify all CI passed
 *   3. `gh pr merge --squash` (or configured method)
 *   4. Notify via Telegram
 */
async function checkAndMergeDependabotPRs() {
  if (!dependabotAutoMerge) return;
  if (!repoSlug || repoSlug === "unknown/unknown") {
    console.warn("[dependabot] auto-merge disabled — no repo slug configured");
    return;
  }

  const authorFilter = dependabotAuthors.map((a) => `author:${a}`).join(" ");

  try {
    // List open PRs by bot authors
    const listCmd = `gh pr list --repo ${repoSlug} --state open --json number,title,author,headRefName,statusCheckRollup --limit 20`;
    const listResult = execSync(listCmd, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();

    const prs = JSON.parse(listResult || "[]");
    if (prs.length === 0) return;

    // Filter to only bot-authored PRs
    const botPRs = prs.filter((pr) => {
      const login = pr.author?.login || pr.author?.name || "";
      return dependabotAuthors.some(
        (a) =>
          login === a ||
          login === a.replace("app/", "") ||
          a === `app/${login}`,
      );
    });

    if (botPRs.length === 0) return;
    console.log(
      `[dependabot] found ${botPRs.length} bot PR(s): ${botPRs.map((p) => `#${p.number}`).join(", ")}`,
    );

    for (const pr of botPRs) {
      if (dependabotMergeAttempted.has(pr.number)) continue;

      try {
        // Check CI status — all checks must pass
        const checksCmd = `gh pr checks ${pr.number} --repo ${repoSlug} --json name,state --required`;
        let checksResult;
        try {
          checksResult = execSync(checksCmd, {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: 15_000,
          }).trim();
        } catch (checksErr) {
          // gh pr checks returns exit code 1 if any check failed/pending
          // Parse the output anyway if available
          checksResult = checksErr.stdout?.trim() || "";
          if (!checksResult) {
            console.log(
              `[dependabot] PR #${pr.number}: checks still pending or failed`,
            );
            continue;
          }
        }

        let checks;
        try {
          checks = JSON.parse(checksResult || "[]");
        } catch {
          // JSON parse failed — might be old gh version, try simpler check
          console.log(
            `[dependabot] PR #${pr.number}: could not parse checks output`,
          );
          continue;
        }

        // All required checks must be in a passing state
        const allPassed =
          checks.length > 0 &&
          checks.every((c) => {
            const state = String(c?.state || "").toUpperCase();
            const conclusion = String(c?.conclusion || "").toUpperCase();
            const signal = conclusion || state;
            return (
              signal === "SUCCESS" ||
              signal === "PASSED" ||
              signal === "PASS" ||
              signal === "NEUTRAL" ||
              signal === "SKIPPED" ||
              signal === "COMPLETED"
            );
          });

        if (!allPassed) {
          const pending = checks.filter((c) => {
            const state = String(c?.state || "").toUpperCase();
            const conclusion = String(c?.conclusion || "").toUpperCase();
            return (
              !conclusion ||
              state === "PENDING" ||
              state === "IN_PROGRESS" ||
              state === "QUEUED" ||
              state === "WAITING"
            );
          });
          const failed = checks.filter((c) => {
            const state = String(c?.state || "").toUpperCase();
            const conclusion = String(c?.conclusion || "").toUpperCase();
            const signal = conclusion || state;
            return (
              signal === "FAILURE" ||
              signal === "FAILED" ||
              signal === "ERROR" ||
              signal === "TIMED_OUT" ||
              signal === "CANCELLED" ||
              signal === "ACTION_REQUIRED"
            );
          });
          if (failed.length > 0) {
            console.log(
              `[dependabot] PR #${pr.number}: ${failed.length} check(s) failed — skipping`,
            );
            dependabotMergeAttempted.add(pr.number); // don't retry failed
          } else if (pending.length > 0) {
            console.log(
              `[dependabot] PR #${pr.number}: ${pending.length} check(s) still pending`,
            );
          } else if (checks.length === 0) {
            console.log(
              `[dependabot] PR #${pr.number}: no required checks found — waiting`,
            );
          }
          continue;
        }

        // All checks passed — merge!
        console.log(
          `[dependabot] PR #${pr.number}: all ${checks.length} check(s) passed — merging (${dependabotMergeMethod})`,
        );
        dependabotMergeAttempted.add(pr.number);

        const mergeCmd = `gh pr merge ${pr.number} --repo ${repoSlug} --${dependabotMergeMethod} --delete-branch --auto`;
        try {
          execSync(mergeCmd, {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: 30_000,
          });
          console.log(`[dependabot] :check: PR #${pr.number} merged: ${pr.title}`);
          void sendTelegramMessage(
            `:check: Auto-merged bot PR #${pr.number}: ${pr.title}`,
          );
        } catch (mergeErr) {
          const errMsg = mergeErr.stderr || mergeErr.message || "";
          console.warn(
            `[dependabot] merge failed for PR #${pr.number}: ${errMsg.slice(0, 200)}`,
          );
          // If auto-merge was enabled (queued), that's fine — gh returns success for --auto
          if (errMsg.includes("auto-merge")) {
            console.log(
              `[dependabot] PR #${pr.number}: auto-merge enabled, will merge when protection rules are met`,
            );
            void sendTelegramMessage(
              `:refresh: Auto-merge enabled for bot PR #${pr.number}: ${pr.title}`,
            );
          }
        }
      } catch (prErr) {
        console.warn(
          `[dependabot] error processing PR #${pr.number}: ${prErr.message || prErr}`,
        );
      }
    }
  } catch (err) {
    console.warn(`[dependabot] error listing bot PRs: ${err.message || err}`);
  }
}

// ── Merge Strategy Analysis ─────────────────────────────────────────────────

function getReviewGateSnapshot(taskId) {
  const id = String(taskId || "").trim();
  if (!id) return null;

  const runtime = reviewGateResults.get(id);
  if (runtime) {
    return {
      approved: runtime.approved === true,
      reviewedAt: runtime.reviewedAt || null,
      source: "runtime",
    };
  }

  try {
    const task = getInternalTask(id);
    if (!task) return null;
    return {
      approved: task.reviewStatus === "approved",
      reviewedAt: task.reviewedAt || null,
      source: "task-store",
    };
  } catch {
    return null;
  }
}

function hasCurrentReviewVerdict(task) {
  const reviewStatus = String(task?.reviewStatus || "").trim().toLowerCase();
  if (!["approved", "changes_requested"].includes(reviewStatus)) {
    return false;
  }
  const reviewedAtMs = Date.parse(String(task?.reviewedAt || ""));
  return Number.isFinite(reviewedAtMs);
}

function isTaskReviewApprovedForFlow(taskId) {
  const snapshot = getReviewGateSnapshot(taskId);
  return snapshot?.approved === true;
}

function rememberPendingMergeStrategy(ctx, reason = "review_pending") {
  const taskId = String(ctx?.taskId || "").trim();
  if (!taskId) return false;
  pendingMergeStrategyByTask.set(taskId, {
    ...ctx,
    _flowDeferredAt: new Date().toISOString(),
    _flowDeferredReason: reason,
  });
  return true;
}

function dequeuePendingMergeStrategy(taskId) {
  const id = String(taskId || "").trim();
  if (!id) return null;
  const ctx = pendingMergeStrategyByTask.get(id) || null;
  if (ctx) pendingMergeStrategyByTask.delete(id);
  return ctx;
}

async function queueFlowReview(taskId, ctx, reason = "") {
  if (!reviewAgent) return false;
  const id = String(taskId || "").trim();
  if (!id) return false;
  try {
    const task = getInternalTask(id);
    const resolvedRepoSlug = resolveTaskRepoSlug(task, ctx);
    const resolvedRepoUrlBase = getRepoUrlBaseForSlug(resolvedRepoSlug);
    const resolvedPrNumber =
      parsePositivePrNumber(ctx?.prNumber) ||
      parsePositivePrNumber(task?.prNumber) ||
      parsePositivePrNumber(task?.pr_number) ||
      null;
    const prUrl =
      ctx?.prUrl ||
      (resolvedPrNumber ? `${resolvedRepoUrlBase}/pull/${resolvedPrNumber}` : "");
    await reviewAgent.queueReview({
      id,
      title: ctx?.taskTitle || id,
      branchName: ctx?.branch || "",
      prUrl,
      prNumber: resolvedPrNumber,
      repoSlug: resolvedRepoSlug || undefined,
      description: ctx?.taskDescription || "",
      taskContext: reason ? `Flow gate reason: ${reason}` : "",
      worktreePath: ctx?.worktreeDir || null,
      sessionMessages: "",
      diffStats: "",
    });
    return true;
  } catch (err) {
    console.warn(
      `[flow-gate] failed to queue review for ${id}: ${err.message || err}`,
    );
    return false;
  }
}

function redispatchInReviewTask(task, reason, extra = {}) {
  const handoff = buildReviewFixTaskHandoff(task, reason, {
    ...extra,
    mode: REVIEW_FIX_HANDOFF_MODES.REVIEW_REDISPATCH,
  });
  const taskId = handoff?.taskId || "";
  if (!taskId) return false;
  const now = Date.now();
  const existing = reviewRedispatchCooldownByTask.get(taskId);
  if (existing && now - existing.at < REVIEW_REDISPATCH_COOLDOWN_MS) {
    return false;
  }
  reviewRedispatchCooldownByTask.set(taskId, {
    at: now,
    reason: handoff.reason,
  });
  persistReviewFixTaskHandoff(taskId, handoff);
  queueWorkflowEvent(handoff.eventType, handoff.workflowPayload, {
    dedupKey: `workflow-event:${handoff.eventType}:${taskId}:${handoff.workflowPayload?.taskStatus || "todo"}:${handoff.reason}:${handoff.mode}`,
  });
  return true;
}

function buildReviewFixTaskHandoff(task, reason, extra = {}) {
  const taskId = String(task?.id || extra?.taskId || "").trim();
  const taskTitle = String(task?.title || extra?.taskTitle || taskId).trim() || taskId;
  const normalizedReason = String(reason || "inreview_redispatch").trim() || "inreview_redispatch";
  const eventType = String(extra.workflowEvent || "task.review_fix_requested").trim() || "task.review_fix_requested";
  const mode = String(extra.mode || REVIEW_FIX_HANDOFF_MODES.REVIEW_REDISPATCH).trim()
    || REVIEW_FIX_HANDOFF_MODES.REVIEW_REDISPATCH;
  const branchName = String(task?.branchName || task?.branch || extra.branch || extra.branchName || "").trim() || null;
  const worktreePath = String(
    task?.worktreePath || task?.meta?.worktreePath || extra.worktreePath || "",
  ).trim() || null;
  const prNumber =
    parsePositivePrNumber(extra.prNumber) ||
    parsePositivePrNumber(task?.prNumber) ||
    parsePositivePrNumber(task?.pr_number) ||
    null;
  const prUrl = String(extra.prUrl || task?.prUrl || task?.pr_url || "").trim() || null;
  const reviewIssuesSource = Array.isArray(extra.reviewIssues)
    ? extra.reviewIssues
    : (Array.isArray(task?.reviewIssues) ? task.reviewIssues : []);
  const reviewIssues = reviewIssuesSource
    .map((issue, index) => {
      if (!issue || typeof issue !== "object") {
        const description = String(issue || "").trim();
        return description
          ? { severity: "major", category: "review", description, order: index }
          : null;
      }
      const normalized = {
        severity: String(issue.severity || "major").trim() || "major",
        category: String(issue.category || "review").trim() || "review",
        file: String(issue.file || issue.path || "").trim() || null,
        line: parsePositivePrNumber(issue.line) || null,
        description: String(issue.description || issue.message || issue.body || "").trim() || null,
        code: String(issue.code || "").trim() || null,
        source: String(issue.source || issue.kind || "").trim() || null,
        author: String(issue.author || issue.reviewer || "").trim() || null,
        url: String(issue.url || "").trim() || null,
        order: index,
      };
      return Object.fromEntries(
        Object.entries(normalized).filter(([, value]) => value !== null && value !== ""),
      );
    })
    .filter(Boolean);
  const issueCount = reviewIssues.length;
  const reviewStatus = String(task?.reviewStatus || extra.reviewStatus || "").trim() || null;
  const nowIso = String(extra.requestedAt || new Date().toISOString());
  const requiresNewSession = mode === REVIEW_FIX_HANDOFF_MODES.REVIEW_REDISPATCH;
  const handoffState = requiresNewSession
    ? REVIEW_FIX_HANDOFF_STATES.SESSION_REBIND_REQUESTED
    : REVIEW_FIX_HANDOFF_STATES.ACTIVE_SESSION_ATTACHED;
  const issueSummary = reviewIssues
    .slice(0, 5)
    .map((issue) => {
      const severity = String(issue?.severity || "major");
      const category = String(issue?.category || "review");
      const file = String(issue?.file || "(unknown)");
      const line = Number.isFinite(Number(issue?.line))
        ? `:${Number(issue.line)}`
        : "";
      const description = String(issue?.description || "").trim();
      return `- [${severity}/${category}] ${file}${line}${description ? ` - ${description}` : ""}`;
    })
    .join("\n");
  const prompt = [
    `Review requested changes for task "${taskTitle}".`,
    issueSummary
      ? `Fix these review issues first:\n${issueSummary}`
      : "Fix the reported review issues first.",
    "Stay on the current branch, run relevant tests, commit the fixes, and continue toward PR update.",
  ].join("\n\n");
  const reviewFixLifecycle = {
    mode,
    state: handoffState,
    reason: normalizedReason,
    requestedAt: nowIso,
    branchName,
    prNumber,
    prUrl,
    reviewIssueCount: issueCount,
  };
  const existingMeta = task?.meta && typeof task.meta === "object" ? task.meta : {};
  const taskPatch = {
    branchName,
    prNumber,
    prUrl,
    reviewIssues,
    reviewIssueCount: issueCount,
    reviewFixDispatchMode: mode,
    reviewFixState: handoffState,
    reviewFixRequestedAt: nowIso,
    reviewStatus: reviewStatus || undefined,
    meta: {
      ...existingMeta,
      reviewFixLifecycle,
    },
  };
  if (requiresNewSession) {
    taskPatch.status = "todo";
    taskPatch.sessionId = null;
    taskPatch.latestSessionId = null;
  }
  const workflowTask = {
    id: taskId,
    title: taskTitle,
    status: requiresNewSession ? "todo" : (String(task?.status || "").trim() || "inreview"),
    branchName,
    worktreePath,
    prNumber,
    prUrl,
    reviewStatus,
    reviewIssues,
    reviewIssueCount: issueCount,
    reviewFixDispatchMode: mode,
    reviewFixState: handoffState,
    reviewFixRequestedAt: nowIso,
    sessionId: requiresNewSession ? null : (task?.sessionId || null),
    latestSessionId: requiresNewSession ? null : (task?.latestSessionId || null),
  };
  return {
    taskId,
    taskTitle,
    reason: normalizedReason,
    eventType,
    mode,
    prompt,
    issueCount,
    reviewIssues,
    taskPatch,
    workflowPayload: {
      taskId,
      taskTitle,
      taskStatus: workflowTask.status,
      branch: branchName,
      branchName,
      worktreePath,
      prNumber,
      prUrl,
      reviewStatus,
      reviewIssues,
      reviewIssueCount: issueCount,
      reviewFixDispatchMode: mode,
      reviewFixState: handoffState,
      reviewFixRequestedAt: nowIso,
      reviewRedispatchReason: normalizedReason,
      task: workflowTask,
      ...extra,
      mode,
    },
  };
}

function persistReviewFixTaskHandoff(taskId, handoff) {
  if (!taskId || !handoff?.taskPatch) return;
  const nextStatus = String(handoff.taskPatch.status || "").trim().toLowerCase();
  if (nextStatus) {
    try {
      setInternalTaskStatus(taskId, nextStatus, handoff.reason || "review-fix");
    } catch {
      /* best-effort */
    }
    try {
      updateTaskStatus(taskId, nextStatus);
    } catch {
      /* best-effort */
    }
  }
  try {
    updateInternalTask(taskId, handoff.taskPatch);
  } catch {
    /* best-effort */
  }
}

function isReviewRedispatchCoolingDown(taskId, now = Date.now()) {
  const normalizedTaskId = String(taskId || "").trim();
  if (!normalizedTaskId) return false;
  const existing = reviewRedispatchCooldownByTask.get(normalizedTaskId);
  return Boolean(
    existing &&
    Number.isFinite(existing.at) &&
    now - existing.at < REVIEW_REDISPATCH_COOLDOWN_MS
  );
}

function parsePositivePrNumber(value) {
  const parsed = Number(String(value || "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function extractPrNumberFromUrl(prUrl) {
  const raw = String(prUrl || "");
  return parsePositivePrNumber(parsePrNumberFromUrl(raw));
}

function normalizeRepoSlugCandidate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const trimmed = raw
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^github\.com\//i, "")
    .replace(/\/+$/g, "");
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length < 2) return "";
  const owner = String(parts[0] || "").trim();
  const repo = String(parts[1] || "").trim();
  if (!owner || !repo) return "";
  return `${owner}/${repo}`;
}

function extractRepoSlugFromPrUrl(prUrl) {
  const raw = String(prUrl || "").trim();
  if (!raw) return "";
  const match = raw.match(/github\.com\/([^/]+\/[^/#?]+)\/pull\//i);
  return normalizeRepoSlugCandidate(match?.[1] || "");
}

function resolveTaskRepoSlug(task, context = {}) {
  return (
    normalizeRepoSlugCandidate(context?.repoSlug) ||
    normalizeRepoSlugCandidate(context?.repository) ||
    extractRepoSlugFromPrUrl(context?.prUrl) ||
    normalizeRepoSlugCandidate(task?.repository) ||
    normalizeRepoSlugCandidate(task?.repoSlug) ||
    extractRepoSlugFromPrUrl(task?.prUrl || task?.pr_url || "") ||
    normalizeRepoSlugCandidate(repoSlug)
  );
}

function getRepoUrlBaseForSlug(slug) {
  const normalizedSlug = normalizeRepoSlugCandidate(slug);
  if (normalizedSlug) return `https://github.com/${normalizedSlug}`;
  return String(repoUrlBase || "https://github.com").replace(/\/+$/g, "");
}

function buildFlowGateMergeBody(taskTitle, taskId) {
  const safeTitle = String(taskTitle || "Task").trim() || "Task";
  const safeId = String(taskId || "").trim();
  const lines = [
    `Merged by Bosun flow gate for: ${safeTitle}`,
    safeId ? `Task: ${safeId}` : "",
  ].filter(Boolean);
  if (shouldAddBosunCoAuthor({ taskId: safeId })) {
    lines.push("", getBosunCoAuthorTrailer());
  }
  return lines.join("\n");
}

async function triggerFlowPostReviewMerge(taskId, context = {}) {
  if (!isFlowPrimaryEnabled() || !isFlowReviewGateEnabled()) {
    return false;
  }
  if (!ghAvailable()) {
    return false;
  }

  const id = String(taskId || "").trim();
  if (!id) return false;

  const task = getInternalTask(id);
  const resolvedRepoSlug = resolveTaskRepoSlug(task, context);
  const resolvedRepoUrlBase = getRepoUrlBaseForSlug(resolvedRepoSlug);
  const branch = String(
    context.branch || task?.branchName || task?.branch || "",
  ).trim();
  const taskTitle = String(
    context.taskTitle || task?.title || id,
  ).trim();
  let prNumber =
    parsePositivePrNumber(context.prNumber) ||
    parsePositivePrNumber(task?.prNumber) ||
    parsePositivePrNumber(task?.pr_number) ||
    null;
  let prUrl = String(
    context.prUrl || task?.prUrl || task?.pr_url || "",
  ).trim();
  if (!prNumber && prUrl) {
    prNumber = extractPrNumberFromUrl(prUrl);
  }

  if (!prNumber && branch) {
    let existingPr = await findExistingPrForBranchInRepo(
      branch,
      resolvedRepoSlug,
    );
    if (!existingPr) {
      existingPr = await findExistingPrForBranchApiInRepo(
        branch,
        resolvedRepoSlug,
      );
    }
    if (existingPr?.number) {
      prNumber = parsePositivePrNumber(existingPr.number);
      prUrl = prUrl || String(existingPr.url || "").trim();
    }
  }

  if (!prNumber) {
    console.warn(
      `[flow-gate] review approved for ${id}, but no PR number could be resolved yet`,
    );
    return false;
  }
  if (!prUrl) {
    prUrl = `${resolvedRepoUrlBase}/pull/${prNumber}`;
  }

  const autoArgs = ["pr", "merge", String(prNumber)];
  if (resolvedRepoSlug) autoArgs.push("--repo", resolvedRepoSlug);
  autoArgs.push("--body", buildFlowGateMergeBody(taskTitle, id));
  const mergeMethod = process.env.BOSUN_MERGE_METHOD || "merge";
  autoArgs.push("--auto", `--${mergeMethod}`);

  const autoResult = spawnSync("gh", autoArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (autoResult.status === 0) {
    console.log(
      `[flow-gate] review approved for "${taskTitle}" (${id}) — auto-merge queued for PR #${prNumber}`,
    );
    return true;
  }

  const autoErr = String(
    autoResult.stderr || autoResult.stdout || "",
  ).trim();
  if (/clean status|not in the correct state/i.test(autoErr)) {
    const directArgs = ["pr", "merge", String(prNumber)];
    if (resolvedRepoSlug) directArgs.push("--repo", resolvedRepoSlug);
    directArgs.push("--body", buildFlowGateMergeBody(taskTitle, id));
    directArgs.push(`--${mergeMethod}`);
    const directResult = spawnSync("gh", directArgs, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (directResult.status === 0) {
      console.log(
        `[flow-gate] review approved for "${taskTitle}" (${id}) — directly merged PR #${prNumber}`,
      );
      return true;
    }
    const directErr = String(
      directResult.stderr || directResult.stdout || "",
    ).trim();
    console.warn(
      `[flow-gate] direct merge failed after approval for PR #${prNumber}: ${directErr.slice(0, 220)}`,
    );
    return false;
  }

  if (/auto-merge/i.test(autoErr) && /enabled|already/i.test(autoErr)) {
    console.log(
      `[flow-gate] review approved for "${taskTitle}" (${id}) — auto-merge already queued for PR #${prNumber}`,
    );
    return true;
  }

  console.warn(
    `[flow-gate] could not queue auto-merge for approved task ${id} (PR #${prNumber}): ${autoErr.slice(0, 220)}`,
  );
  return false;
}

async function canEnableMergeForFlow(ctx) {
  if (!isFlowPrimaryEnabled() || !isFlowReviewGateEnabled()) {
    return { allowed: true };
  }

  const taskId = String(ctx?.taskId || "").trim();
  if (!taskId) {
    return { allowed: false, reason: "missing_task_id_for_review_gate" };
  }

  if (!isTaskReviewApprovedForFlow(taskId)) {
    return { allowed: false, reason: "task_review_not_approved" };
  }

  return { allowed: true };
}

async function shouldFinalizeMergedTask(task, context = {}) {
  if (!isFlowPrimaryEnabled() || !isFlowReviewGateEnabled()) {
    return true;
  }

  const taskId = String(task?.id || "").trim();
  if (!taskId) return false;
  if (isTaskReviewApprovedForFlow(taskId)) return true;

  const branch = context.branch || task?.branch || task?.workspace_branch || "";
  const prNumber = context.prNumber || task?.pr_number || null;
  const resolvedRepoSlug = resolveTaskRepoSlug(task, context);
  const resolvedRepoUrlBase = getRepoUrlBaseForSlug(resolvedRepoSlug);
  const reason = context.reason || "merged_before_review";
  console.log(
    `[flow-gate] Task "${task?.title || taskId}" merged but review is not approved yet — holding in inreview`,
  );
  const currentStatus = String(task?.status || "").toLowerCase();
  if (currentStatus && currentStatus !== "inreview") {
    try {
      await updateTaskStatus(taskId, "inreview");
    } catch {
      /* best effort */
    }
  }
  await queueFlowReview(taskId, {
    taskId,
    taskTitle: task?.title || taskId,
    taskDescription: task?.description || task?.body || "",
    branch,
    prNumber,
    repoSlug: resolvedRepoSlug || null,
    prUrl:
      context.prUrl ||
      task?.prUrl ||
      task?.pr_url ||
      (prNumber ? `${resolvedRepoUrlBase}/pull/${prNumber}` : ""),
  }, reason);
  return false;
}

/**
 * Run the Codex-powered merge strategy analysis for a completed task.
 * This is fire-and-forget (void) — it runs async in the background and
 * handles its own errors/notifications.
 *
 * @param {import("../merge-strategy.mjs").MergeContext} ctx
 */
async function runMergeStrategyAnalysis(ctx, opts = {}) {
  void ctx;
  void opts;
  console.log(
    "[monitor] legacy merge-strategy automation path removed — use workflows",
  );
}

// ── Auto-Rebase Downstream Tasks on PR Merge ────────────────────────────────

/**
 * When a PR is merged into an upstream branch, find all active tasks that
 * share the same upstream and trigger a rebase on each of them.
 *
 * This prevents tasks from drifting behind their upstream and accumulating
 * merge conflicts.
 *
 * @param {string} mergedUpstreamBranch - The branch the PR was merged into
 * @param {string} [excludeAttemptId]   - Attempt to exclude (the one that just merged)
 */
async function rebaseDownstreamTasks(mergedUpstreamBranch, excludeAttemptId) {
  if (!branchRouting?.autoRebaseOnMerge) {
    console.log("[rebase-downstream] auto-rebase disabled in config");
    return;
  }

  const tag = "rebase-downstream";
  console.log(
    `[${tag}] PR merged into ${mergedUpstreamBranch} — checking for downstream tasks to rebase`,
  );

  try {
    // Get all active tasks
    const statuses = ["inprogress", "inreview"];
    const tasksByStatus = await Promise.all(
      statuses.map((status) => fetchTasksByStatus(status)),
    );
    const allTasks = [];
    for (const tasks of tasksByStatus) {
      for (const task of tasks) {
        if (task?.id) allTasks.push(task);
      }
    }

    // Get active attempts from status file
    const statusData = await readStatusData();
    const attempts = Array.isArray(statusData?.active_attempts)
      ? statusData.active_attempts
      : Object.values(statusData?.attempts || {});

    let rebasedCount = 0;
    let failedCount = 0;
    const rebaseResults = [];

    for (const task of allTasks) {
      // Resolve this task's upstream branch
      const taskUpstream =
        resolveUpstreamFromTask(task) || DEFAULT_TARGET_BRANCH;

      // Normalize both branches for comparison (strip "origin/" prefix)
      const normalize = (b) => b?.replace(/^origin\//, "") || "";
      if (normalize(taskUpstream) !== normalize(mergedUpstreamBranch)) {
        continue; // Different upstream — not affected
      }

      // Find the attempt for this task
      let attempt = attempts.find((a) => a?.task_id === task.id);

      if (!attempt || attempt.id === excludeAttemptId) continue;
      if (!attempt.branch) continue;

      console.log(
        `[${tag}] refreshing task "${task.title}" (${attempt.id.substring(0, 8)}) onto ${mergedUpstreamBranch}`,
      );

      try {
        const rebaseResult = await rebaseAttempt(
          attempt.id,
          mergedUpstreamBranch,
        );

        if (rebaseResult?.success || rebaseResult?.data?.success) {
          rebasedCount++;
          rebaseResults.push({
            taskTitle: task.title,
            attemptId: attempt.id,
            status: "success",
          });
          console.log(
            `[${tag}] ✓ refreshed "${task.title}" (${attempt.id.substring(0, 8)}) onto ${mergedUpstreamBranch}`,
          );
        } else {
          failedCount++;
          const error =
            rebaseResult?.error || rebaseResult?.message || "unknown";
          rebaseResults.push({
            taskTitle: task.title,
            attemptId: attempt.id,
            status: "failed",
            error,
          });
          console.warn(
            `[${tag}] ✗ refresh failed for "${task.title}" (${attempt.id.substring(0, 8)}): ${error}`,
          );

          // ── Run task assessment on refresh failure ──────────────
          if (branchRouting?.assessWithSdk && agentPoolEnabled) {
            void runTaskAssessment({
              taskId: task.id,
              taskTitle: task.title,
              taskDescription: task.description,
              attemptId: attempt.id,
              shortId: attempt.id.substring(0, 8),
              trigger: "rebase_failed",
              branch: attempt.branch,
              upstreamBranch: mergedUpstreamBranch,
              rebaseError: error,
              conflictFiles:
                rebaseResult?.conflicted_files ||
                rebaseResult?.data?.conflicted_files ||
                [],
            });
          }
        }
      } catch (err) {
        failedCount++;
        rebaseResults.push({
          taskTitle: task.title,
          attemptId: attempt.id,
          status: "error",
          error: err.message || String(err),
        });
        console.warn(
          `[${tag}] error refreshing "${task.title}": ${err.message || err}`,
        );
      }
    }

    if (rebasedCount > 0 || failedCount > 0) {
      const summary = `Downstream refresh after merge to ${mergedUpstreamBranch}: ${rebasedCount} refreshed, ${failedCount} failed`;
      console.log(`[${tag}] ${summary}`);
      void sendTelegramMessage(
        `:refresh: ${summary}\n${rebaseResults.map((r) => `  ${r.status === "success" ? "✓" : "✗"} ${r.taskTitle}`).join("\n")}`,
      );
    } else {
      console.log(
        `[${tag}] no downstream tasks found on upstream ${mergedUpstreamBranch}`,
      );
    }
  } catch (err) {
    console.warn(`[${tag}] error: ${err.message || err}`);
  }
}

// ── Task Assessment Integration ─────────────────────────────────────────────

/**
 * Run a full task lifecycle assessment using Codex/Copilot SDK.
 * First tries quickAssess (heuristic, no SDK call), then falls back to
 * full SDK assessment if needed.
 *
 * After getting a decision, ACTS on it — sends prompts, triggers retries, etc.
 *
 * @param {import("../task/task-assessment.mjs").TaskAssessmentContext} ctx
 */
async function runTaskAssessment(ctx) {
  const tag = `assessment(${ctx.shortId})`;
  try {
    // ── Quick heuristic assessment first ───────────────────
    const quick = quickAssess(ctx);
    if (quick) {
      console.log(
        `[${tag}] quick decision: ${quick.action} — ${(quick.reason || "").slice(0, 100)}`,
      );
      await actOnAssessment(ctx, quick);
      return;
    }

    // ── Full SDK assessment ───────────────────────────────
    if (!agentPoolEnabled) {
      console.log(`[${tag}] skipping SDK assessment — agent disabled`);
      return;
    }

    const telegramFn =
      telegramToken && telegramChatId
        ? (msg) => void sendTelegramMessage(msg)
        : null;

    const decision = await assessTask(ctx, {
      execCodex: execPooledPrompt,
      timeoutMs: 5 * 60 * 1000,
      logDir,
      onTelegram: telegramFn,
    });

    if (!decision?.success) {
      console.warn(`[${tag}] assessment failed — no action taken`);
      return;
    }

    await actOnAssessment(ctx, decision);
  } catch (err) {
    console.warn(`[${tag}] error: ${err.message || err}`);
  }
}

function summarizeDebtItemsForMessage(debtItems) {
  if (!Array.isArray(debtItems) || debtItems.length === 0) return "none";
  const preview = debtItems
    .slice(0, 3)
    .map((item) => {
      const severity = String(item?.severity || "medium")
        .trim()
        .toLowerCase();
      const text = String(
        item?.description || item?.criterion || item?.type || "debt item",
      ).trim();
      return `[${severity}] ${text}`;
    })
    .join("; ");
  const remaining = debtItems.length - 3;
  if (remaining > 0) return `${preview}; +${remaining} more`;
  return preview;
}

async function sendAssessmentTelegram(tag, message) {
  try {
    await sendTelegramMessage(message);
  } catch (err) {
    console.warn(`[${tag}] telegram send failed: ${err?.message || err}`);
  }
}

function normalizeSplitTasksFromDecision(rawSplitTasks) {
  if (!Array.isArray(rawSplitTasks)) return [];
  return rawSplitTasks
    .map((task) => {
      if (!task || typeof task !== "object") return null;
      const title = String(task.title || task.name || "").trim();
      if (!title) return null;
      const description = String(task.description || "").trim();
      const priority = String(task.priority || "").trim().toLowerCase();
      const tags = Array.isArray(task.tags)
        ? task.tags.map((tag) => String(tag || "").trim()).filter(Boolean)
        : [];
      const acceptanceCriteriaRaw =
        task.acceptance_criteria || task.acceptanceCriteria;
      const acceptanceCriteria = Array.isArray(acceptanceCriteriaRaw)
        ? acceptanceCriteriaRaw
          .map((criterion) => String(criterion || "").trim())
          .filter(Boolean)
        : [];
      return {
        title,
        description,
        priority:
          ["critical", "high", "medium", "low"].includes(priority)
            ? priority
            : undefined,
        tags,
        acceptanceCriteria,
      };
    })
    .filter(Boolean);
}

function normalizeAcceptanceCriteriaList(rawCriteria) {
  if (!Array.isArray(rawCriteria)) return [];
  const dedup = new Set();
  const criteria = [];
  for (const value of rawCriteria) {
    const text = String(value || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (dedup.has(key)) continue;
    dedup.add(key);
    criteria.push(text);
  }
  return criteria;
}

function extractAcceptanceCriteriaFromTask(task) {
  if (!task || typeof task !== "object") return [];

  const directCriteria = normalizeAcceptanceCriteriaList(
    task.acceptance_criteria || task.acceptanceCriteria,
  );
  if (directCriteria.length > 0) return directCriteria;

  const description = String(task.description || task.body || "").trim();
  if (!description) return [];

  const lines = description.split(/\r?\n/);
  const sectionCriteria = [];
  let inSection = false;
  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!inSection) {
      const lower = trimmed.toLowerCase();
      const plainHeader =
        lower === "acceptance criteria" || lower === "acceptance criteria:";
      const headingText = trimmed.startsWith("#")
        ? trimmed.slice(trimmed.lastIndexOf("#") + 1).trimStart().toLowerCase()
        : "";
      const markdownHeader =
        headingText === "acceptance criteria" ||
        headingText === "acceptance criteria:";
      if (plainHeader || markdownHeader) {
        inSection = true;
      }
      continue;
    }

    if (trimmed.startsWith("#") && trimmed.slice(1).trim()) break;
    if (!trimmed) continue;

    const dotIdx = trimmed.indexOf(".");
    const numberedPrefix = dotIdx > 0 ? trimmed.slice(0, dotIdx) : "";
    const isNumberedBullet =
      dotIdx > 0 &&
      trimmed[dotIdx + 1] === " " &&
      numberedPrefix.split("").every((ch) => ch >= "0" && ch <= "9");
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      sectionCriteria.push(trimmed.slice(2));
      continue;
    }
    if (isNumberedBullet) {
      sectionCriteria.push(trimmed.slice(dotIdx + 2));
      continue;
    }
    sectionCriteria.push(trimmed);
  }

  return normalizeAcceptanceCriteriaList(sectionCriteria);
}

function shouldSmartPrCreatePrForAssessmentAction(action) {
  const normalized = String(action || "")
    .trim()
    .toLowerCase();
  return normalized === "merge" || normalized === "noop";
}

async function createAssessmentSplitTasks(ctx, splitTasks) {
  const backend = getActiveKanbanBackend();
  const normalizedTasks = normalizeSplitTasksFromDecision(splitTasks).slice(0, 10);
  if (normalizedTasks.length === 0) {
    return { created: [], failed: [], backend, projectId: "" };
  }

  let projectId = "";
  if (backend !== "internal") {
    projectId = getConfiguredKanbanProjectId(backend) || "";
  }

  if (!projectId && backend !== "internal") {
    return {
      created: [],
      failed: normalizedTasks.map((task) => ({
        title: task.title,
        error: `No project configured for backend ${backend}`,
      })),
      backend,
      projectId,
    };
  }

  const parentTitle = String(ctx?.taskTitle || "").trim();
  const parentTaskId = String(ctx?.taskId || "").trim();
  const created = [];
  const failed = [];

  for (const task of normalizedTasks) {
    const sections = [];
    if (task.description) sections.push(task.description);
    if (task.acceptanceCriteria.length > 0) {
      sections.push(
        [
          "## Acceptance Criteria",
          ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
        ].join("\n"),
      );
    }
    if (parentTaskId || parentTitle) {
      sections.push(
        [
          "## Parent Context",
          parentTaskId ? `- Parent Task ID: ${parentTaskId}` : "",
          parentTitle ? `- Parent Task: ${parentTitle}` : "",
          "- Created by assessment split_task decision.",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    const payload = {
      title: task.title,
      description: sections.filter(Boolean).join("\n\n").trim(),
      status: "todo",
      priority: task.priority,
      tags: [...new Set(["assessment-split", ...task.tags])],
    };

    try {
      const createdTask = await createKanbanTask(projectId, payload);
      created.push({
        id: createdTask?.id || null,
        title: task.title,
      });
    } catch (err) {
      failed.push({
        title: task.title,
        error: err?.message || String(err),
      });
    }
  }

  return { created, failed, backend, projectId };
}

/**
 * Act on an assessment decision — execute the recommended action.
 *
 * @param {import("../task/task-assessment.mjs").TaskAssessmentContext} ctx
 * @param {import("../task/task-assessment.mjs").TaskAssessmentDecision} decision
 */
async function actOnAssessment(ctx, decision) {
  const tag = `assessment-act(${ctx.shortId})`;

  switch (decision.action) {
    case "merge":
      console.log(`[${tag}] → merge`);
      // Handled by cleanup script / auto-merge
      break;

    case "reprompt_same":
      console.log(`[${tag}] → reprompt same session`);
      if (decision.prompt && agentPoolEnabled) {
        execPooledPrompt(decision.prompt, { timeoutMs: 15 * 60 * 1000 }).catch(
          (err) => {
            console.warn(
              `[${tag}] reprompt_same failed: ${err?.message || err}`,
            );
          },
        );
      }
      break;

    case "reprompt_new_session":
      console.log(`[${tag}] → reprompt new session`);
      if (typeof startFreshSession === "function") {
        startFreshSession(
          null,
          decision.prompt || `Resume task: ${ctx.taskTitle}`,
          ctx.taskId || null,
        );
      } else if (typeof attemptFreshSessionRetry === "function") {
        await attemptFreshSessionRetry(
          "assessment_new_session",
          decision.reason || "Assessment recommended new session",
        );
      }
      break;

    case "new_attempt":
      console.log(
        `[${tag}] → new attempt (agent: ${decision.agentType || "auto"})`,
      );
      // Move task back to todo for re-scheduling
      if (ctx.taskId) {
        await updateTaskStatus(ctx.taskId, "todo");
      }
      void sendTelegramMessage(
        `:star: Assessment: starting new attempt for "${ctx.taskTitle}" — ${decision.reason || ""}`,
      );
      break;

    case "wait": {
      const waitSec = decision.waitSeconds || 300;
      console.log(`[${tag}] → wait ${waitSec}s`);
      setTimeout(() => {
        void runTaskAssessment({
          ...ctx,
          trigger: "reassessment",
        });
      }, waitSec * 1000);
      break;
    }

    case "manual_review":
      console.log(`[${tag}] → manual review`);
      void sendTelegramMessage(
        `:eye: Assessment: manual review needed for "${ctx.taskTitle}" — ${decision.reason || ""}`,
      );
      break;

    case "close_and_replan":
      console.log(`[${tag}] → close and replan`);
      if (ctx.taskId) {
        await updateTaskStatus(ctx.taskId, "todo");
      }
      void sendTelegramMessage(
        `:ban: Assessment: closing and replanning "${ctx.taskTitle}" — ${decision.reason || ""}`,
      );
      break;

    case "accept_with_debt": {
      console.log(`[${tag}] → accept with debt`);
      const debtItems = normalizeAssessmentDebtItems(
        decision.debtItems,
        decision.reason || "Task accepted with explicit debt",
      );
      let ledgerPath = "";
      try {
        const recorded = recordTaskDebt(
          {
            taskId: ctx.taskId,
            taskTitle: ctx.taskTitle,
            attemptId: ctx.attemptId,
            trigger: ctx.trigger,
            action: "accept_with_debt",
            reason: decision.reason || "",
            debtItems,
            metadata: {
              shortId: ctx.shortId || "",
              branch: ctx.branch || "",
              upstreamBranch: ctx.upstreamBranch || "",
              agentType: ctx.agentType || "",
            },
          },
          { baseDir: repoRoot },
        );
        ledgerPath = recorded.ledgerPath;
      } catch (err) {
        console.warn(
          `[${tag}] failed to record debt ledger entry: ${err?.message || err}`,
        );
      }
      if (ctx.taskId) {
        await updateTaskStatus(ctx.taskId, "inreview", {
          workflowData: {
            assessmentAction: "accept_with_debt",
            debtCount: debtItems.length,
          },
        });
      }
      await sendAssessmentTelegram(
        tag,
        `:memo: Assessment: accepted "${ctx.taskTitle}" with debt (${debtItems.length} item(s)). ` +
          `Summary: ${summarizeDebtItemsForMessage(debtItems)}.` +
          (ledgerPath ? `\nLedger: ${ledgerPath}` : ""),
      );
      break;
    }

    case "split_task": {
      console.log(`[${tag}] → split task`);
      const splitTasks = normalizeSplitTasksFromDecision(decision.splitTasks);
      if (splitTasks.length === 0) {
        console.warn(`[${tag}] split_task selected without split tasks payload`);
        await sendAssessmentTelegram(
          tag,
          `:warning: Assessment requested split for "${ctx.taskTitle}" but no split tasks were provided.`,
        );
        break;
      }
      const result = await createAssessmentSplitTasks(ctx, splitTasks);
      if (ctx.taskId) {
        await updateTaskStatus(ctx.taskId, "todo", {
          workflowData: {
            assessmentAction: "split_task",
            createdChildren: result.created.length,
            failedChildren: result.failed.length,
          },
        });
      }
      await sendAssessmentTelegram(
        tag,
        `:split: Assessment: split "${ctx.taskTitle}" into ${result.created.length}/${splitTasks.length} task(s)` +
          (result.failed.length
            ? ` (${result.failed.length} failed: ${result.failed.map((f) => f.title).join(", ")})`
            : ""),
      );
      break;
    }

    case "escalate_to_replan":
      console.log(`[${tag}] → escalate to replan`);
      if (ctx.taskId) {
        await updateTaskStatus(ctx.taskId, "todo", {
          workflowData: {
            assessmentAction: "escalate_to_replan",
          },
        });
      }
      await sendAssessmentTelegram(
        tag,
        `:warning: Assessment: escalated "${ctx.taskTitle}" to replan lane — ${decision.reason || ""}`,
      );
      break;

    case "noop":
      console.log(`[${tag}] → noop`);
      break;

    default:
      console.warn(`[${tag}] unknown action: ${decision.action}`);
  }
}

async function runSmartPrPreCreationAssessment({
  attemptId,
  shortId,
  status,
  attempt,
  taskData,
  branchStatus,
  targetBranch,
}) {
  const tag = `smartPR-assess(${shortId})`;
  if (!smartPrPrePrAssessmentEnabled) return true;
  if (!branchRouting?.assessWithSdk || !agentPoolEnabled) return true;

  const acceptanceCriteria = extractAcceptanceCriteriaFromTask(
    taskData || attempt || {},
  );
  if (acceptanceCriteria.length === 0) return true;

  const assessmentCtx = {
    taskId: attempt?.task_id || taskData?.id || "",
    taskTitle:
      attempt?.task_title || taskData?.title || attempt?.task_id || shortId,
    taskDescription:
      attempt?.task_description || taskData?.description || taskData?.body || "",
    attemptId,
    shortId,
    trigger: "agent_completed",
    branch: attempt?.branch || branchStatus?.branch || "",
    upstreamBranch: targetBranch,
    agentLastMessage: `smartPR preflight status=${status}`,
    agentType: attempt?.agent_type || attempt?.agentType || "",
    commitsAhead: branchStatus?.commits_ahead,
    commitsBehind: branchStatus?.commits_behind,
    diffStat: branchStatus?.diff_stats || branchStatus?.diffStat || "",
    acceptanceCriteria,
  };

  const quickDecision = quickAssess(assessmentCtx);
  let decision = quickDecision;
  if (!decision) {
    const onTelegram =
      telegramToken && telegramChatId
        ? (msg) =>
            sendTelegramMessage(msg).catch((err) => {
              console.warn(
                `[${tag}] telegram send failed: ${err?.message || err}`,
              );
            })
        : null;
    decision = await assessTask(assessmentCtx, {
      execCodex: execPooledPrompt,
      timeoutMs: 5 * 60 * 1000,
      logDir,
      onTelegram,
    });
  }

  if (!decision?.success) {
    console.warn(
      `[monitor] ${tag}: assessment failed before auto-PR; continuing with PR flow`,
    );
    return true;
  }

  if (shouldSmartPrCreatePrForAssessmentAction(decision.action)) {
    console.log(
      `[monitor] ${tag}: assessment cleared auto-PR (action=${decision.action})`,
    );
    return true;
  }

  console.log(
    `[monitor] ${tag}: assessment gated auto-PR (action=${decision.action})`,
  );
  await actOnAssessment(assessmentCtx, decision);
  return false;
}

// ── Smart PR creation flow ──────────────────────────────────────────────────

// Use config-driven branch routing instead of hardcoded defaults
const DEFAULT_TARGET_BRANCH =
  branchRouting?.defaultBranch || "origin/main";
const DEFAULT_BOSUN_UPSTREAM =
  branchRouting?.scopeMap?.["bosun"] ||
  process.env.BOSUN_TASK_UPSTREAM ||
  "origin/ve/bosun-generic";

/**
 * Extract the conventional commit scope from a task title.
 * E.g. "feat(bosun): add caching" → "bosun"
 *      "[P1] fix(veid): broken flow"      → "veid"
 *      "chore(provider): cleanup"         → "provider"
 * @param {string} title
 * @returns {string|null}
 */
function extractScopeFromTitle(title) {
  if (!title) return null;
  const text = String(title).trim();
  const withoutPriority = text.startsWith("[P")
    ? text.slice(text.indexOf("]") + 1).trimStart()
    : text;
  const openIdx = withoutPriority.indexOf("(");
  const closeIdx = withoutPriority.indexOf(")", openIdx + 1);
  const colonIdx = withoutPriority.indexOf(":", closeIdx + 1);
  if (openIdx <= 0 || closeIdx <= openIdx || colonIdx <= closeIdx) return null;
  const type = withoutPriority.slice(0, openIdx).trim().toLowerCase();
  const allowed = new Set([
    "feat",
    "fix",
    "docs",
    "style",
    "refactor",
    "perf",
    "test",
    "build",
    "ci",
    "chore",
    "revert",
  ]);
  if (!allowed.has(type)) return null;
  const scope = withoutPriority.slice(openIdx + 1, closeIdx).trim().toLowerCase();
  return scope || null;
}

/**
 * Resolve the upstream branch for a task using config-based scope routing.
 * Priority:
 *   1. Task-level explicit fields (target_branch, base_branch, etc.)
 *   2. Task metadata fields
 *   3. Task labels with upstream/base/target patterns
 *   4. Text body extraction
 *   5. Config scopeMap matching (title scope → branch)
 *   6. Config scopeMap matching (keyword-based)
 *   7. Legacy bosun keyword detection
 *   8. Config defaultBranch
 * @param {object} task
 * @returns {string|null}
 */
function resolveUpstreamFromConfig(task) {
  if (!task) return null;

  // ── Priority 5+: Config-based scope routing ──────────────
  const scope = extractScopeFromTitle(task.title || task.name);
  if (scope && branchRouting?.scopeMap) {
    // Exact scope match
    const exactMatch = branchRouting.scopeMap[scope];
    if (exactMatch) return exactMatch;

    // Partial scope match — check if any config key is contained in the scope
    for (const [key, branch] of Object.entries(branchRouting.scopeMap)) {
      if (scope.includes(key) || key.includes(scope)) return branch;
    }
  }

  // ── Priority 6: Keyword-based scope matching from task text ─
  if (branchRouting?.scopeMap) {
    const text = getTaskTextBlob(task).toLowerCase();
    for (const [key, branch] of Object.entries(branchRouting.scopeMap)) {
      // Check if the routing key appears as a keyword in the task text
      if (text.includes(key.toLowerCase())) return branch;
    }
  }

  return null;
}

function normalizeBranchName(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (
    trimmed.includes("..") ||
    trimmed.includes("\\") ||
    trimmed.includes("~") ||
    trimmed.includes("^") ||
    trimmed.includes(":") ||
    trimmed.includes("?") ||
    trimmed.includes("*") ||
    trimmed.includes("[") ||
    trimmed.includes("@{") ||
    trimmed.startsWith("-")
  ) {
    return null;
  }
  return /^[A-Za-z0-9._/-]+$/.test(trimmed) ? trimmed : null;
}

let cachedGitRemotes = null;

function getGitRemoteNames(defaultRemote = "origin") {
  if (cachedGitRemotes) return cachedGitRemotes;
  const remotes = new Set(["origin", "upstream", defaultRemote]);
  try {
    const res = spawnSync("git", ["remote"], {
      cwd: repoRoot || process.cwd(),
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res.status === 0) {
      for (const line of String(res.stdout || "").split(/\r?\n/)) {
        const remote = line.trim();
        if (remote) remotes.add(remote);
      }
    }
  } catch {
    // Best-effort only; callers fall back to default remote.
  }
  cachedGitRemotes = remotes;
  return cachedGitRemotes;
}

function splitRemoteRef(ref, defaultRemote = "origin") {
  const normalized = normalizeBranchName(ref);
  if (!normalized) return { remote: defaultRemote, name: ref };
  const match = normalized.match(/^([^/]+)\/(.+)$/);
  if (!match) return { remote: defaultRemote, name: normalized };
  const [, remoteCandidate, remainder] = match;
  const remotes = getGitRemoteNames(defaultRemote);
  if (remoteCandidate && remainder && remotes.has(remoteCandidate)) {
    return { remote: remoteCandidate, name: remainder };
  }
  // Branch names like "ve/bosun-generic" are not remote-qualified refs.
  return { remote: defaultRemote, name: normalized };
}

function normalizeBranchForCompare(ref) {
  const normalized = normalizeBranchName(ref);
  if (!normalized) return null;
  const info = splitRemoteRef(normalized, "origin");
  return info?.name || normalized;
}

function extractUpstreamFromText(text) {
  if (!text) return null;
  const match = String(text).match(
    /\b(?:upstream|base|target)(?:_branch| branch)?\s*[:=]\s*([A-Za-z0-9._/-]+)/i,
  );
  if (!match) return null;
  return normalizeBranchName(match[1]);
}

function collectTaskLabels(task) {
  const labels = [];
  if (!task) return labels;
  for (const field of [
    "labels",
    "label",
    "tags",
    "tag",
    "categories",
    "category",
  ]) {
    const value = task[field];
    if (!value) continue;
    if (typeof value === "string") {
      labels.push(value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!item) continue;
        if (typeof item === "string") labels.push(item);
        else if (item.name) labels.push(item.name);
        else if (item.label) labels.push(item.label);
        else if (item.title) labels.push(item.title);
      }
    }
  }
  if (task.metadata) {
    for (const field of ["labels", "tags"]) {
      const value = task.metadata[field];
      if (!value) continue;
      if (typeof value === "string") labels.push(value);
      else if (Array.isArray(value)) labels.push(...value);
    }
  }
  return labels;
}

function getTaskTextBlob(task) {
  const parts = [];
  if (!task) return "";
  for (const field of [
    "title",
    "name",
    "description",
    "body",
    "details",
    "content",
  ]) {
    const value = task[field];
    if (value) parts.push(value);
  }
  const labels = collectTaskLabels(task);
  if (labels.length) parts.push(labels.join(" "));
  return parts.join("\n");
}

function resolveUpstreamFromTask(task) {
  if (!task) return null;

  const directFields = [
    "target_branch",
    "base_branch",
    "upstream_branch",
    "upstream",
    "target",
    "base",
    "targetBranch",
    "baseBranch",
  ];
  for (const field of directFields) {
    if (task[field]) return normalizeBranchName(task[field]);
  }
  if (task.metadata) {
    for (const field of directFields) {
      if (task.metadata[field])
        return normalizeBranchName(task.metadata[field]);
    }
  }

  for (const label of collectTaskLabels(task)) {
    const match = String(label).match(
      /^(?:upstream|base|target)(?:_branch)?[:=]\s*([A-Za-z0-9._/-]+)$/i,
    );
    if (match) return normalizeBranchName(match[1]);
  }

  const fromText = extractUpstreamFromText(getTaskTextBlob(task));
  if (fromText) return fromText;

  // ── Config-based scope routing ────────────────────────────
  const fromConfig = resolveUpstreamFromConfig(task);
  if (fromConfig) return fromConfig;

  // ── Legacy bosun keyword detection ────────────────
  const text = getTaskTextBlob(task).toLowerCase();
  if (
    text.includes("bosun") ||
    text.includes("codex monitor") ||
    text.includes("bosun") ||
    text.includes("scripts/bosun")
  ) {
    return DEFAULT_BOSUN_UPSTREAM;
  }

  return null;
}

// ── Conflict Classification ─────────────────────────────────────────────────
// Auto-resolvable file patterns for rebase conflicts:
//   "theirs" = accept upstream version (lock files, generated files)
//   "ours"   = keep our version (changelogs, coverage reports)
const AUTO_RESOLVE_THEIRS = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "go.sum",
];
const AUTO_RESOLVE_OURS = ["CHANGELOG.md", "coverage.txt", "results.txt"];
const AUTO_RESOLVE_LOCK_EXTENSIONS = [".lock"];

/**
 * Classify conflicted files into auto-resolvable and manual categories.
 * @param {string[]} files - List of conflicted file paths
 * @returns {{ allResolvable: boolean, manualFiles: string[], summary: string }}
 */
function classifyConflictedFiles(files) {
  const manualFiles = [];
  const strategies = [];

  for (const file of files) {
    const fileName = file.split("/").pop();
    let strategy = null;

    if (AUTO_RESOLVE_THEIRS.includes(fileName)) {
      strategy = "theirs";
    } else if (AUTO_RESOLVE_OURS.includes(fileName)) {
      strategy = "ours";
    } else if (
      AUTO_RESOLVE_LOCK_EXTENSIONS.some((ext) => fileName.endsWith(ext))
    ) {
      strategy = "theirs";
    }

    if (strategy) {
      strategies.push(`${fileName}→${strategy}`);
    } else {
      manualFiles.push(file);
    }
  }

  return {
    allResolvable: manualFiles.length === 0,
    manualFiles,
    summary: strategies.join(", ") || "none",
  };
}

function resolveAttemptTargetBranch(attempt, task) {
  if (attempt) {
    const candidate =
      attempt.target_branch ||
      attempt.targetBranch ||
      attempt.base_branch ||
      attempt.baseBranch ||
      attempt.upstream_branch;
    const normalized = normalizeBranchName(candidate);
    if (normalized) return normalized;
    if (Array.isArray(attempt.repos) && attempt.repos.length) {
      const repoTarget =
        attempt.repos[0].target_branch || attempt.repos[0].targetBranch;
      const repoNorm = normalizeBranchName(repoTarget);
      if (repoNorm) return repoNorm;
    }
  }

  const fromTask = resolveUpstreamFromTask(task);
  if (fromTask) return fromTask;

  return DEFAULT_TARGET_BRANCH;
}

/**
 * Intelligent multi-step PR creation:
 *
 *   1. Check branch-status → decide action
 *   2. Stale detection: 0 commits AND far behind → merge-refresh first, archive on error
 *   3. Refresh onto main (resolve conflicts automatically if possible)
 *   4. Create PR via /pr endpoint
 *   5. Distinguish fast-fail (<2s = worktree issue) vs slow-fail (>30s = prepush)
 *   6. On prepush failure → prompt agent to fix lint/test issues and push
 *
 * @param {string} attemptId - Full attempt UUID
 * @param {string} shortId   - Short ID for logging (4-8 chars)
 * @param {string} status    - "completed", "failed", or "no-remote-branch"
 */
async function smartPRFlow(attemptId, shortId, status) {
  const tag = `smartPR(${shortId})`;
  try {
    // ── Step 0: Check if task/branch is already merged ───────────
    // Prevents infinite retry loops for tasks that were completed in previous sessions
    const attemptInfo = await getAttemptInfo(attemptId);
    let taskData = null;
    if (attemptInfo?.branch) {
      if (
        await isMergedBranchCacheEntryStillValid(
          attemptInfo.branch,
          attemptInfo?.target_branch ||
            attemptInfo?.targetBranch ||
            attemptInfo?.base_branch ||
            attemptInfo?.baseBranch ||
            null,
        )
      ) {
        console.log(
          `[monitor] ${tag}: branch already in merged cache — archiving`,
        );
        await archiveAttempt(attemptId);
        return;
      }
      const merged = await isBranchMerged(attemptInfo.branch);
      if (merged) {
        let canFinalize = true;
        if (attemptInfo.task_id) {
          canFinalize = await shouldFinalizeMergedTask(
            {
              id: attemptInfo.task_id,
              title: attemptInfo.task_title || attemptInfo.task_id,
              description: attemptInfo.task_description || "",
              pr_number: attemptInfo.pr_number || null,
              pr_url: attemptInfo.pr_url || "",
            },
            {
              branch: attemptInfo.branch,
              prNumber: attemptInfo.pr_number || null,
              reason: "smartpr_initial_merged_branch",
            },
          );
        }
        console.log(
          `[monitor] ${tag}: branch ${attemptInfo.branch} confirmed merged — ${canFinalize ? "completing task" : "awaiting review gate"}`,
        );
        addMergedBranchCache(attemptInfo.branch);
        if (attemptInfo.task_id && canFinalize) {
          mergedTaskCache.add(attemptInfo.task_id);
          pendingMergeStrategyByTask.delete(
            String(attemptInfo.task_id || "").trim(),
          );
          void updateTaskStatus(attemptInfo.task_id, "done");
        }
        await archiveAttempt(attemptId);
        saveMergedTaskCache();
        return;
      }
    }

    // ── Step 0b: Check task description for "already completed" signals ──
    if (attemptInfo?.task_id) {
      try {
        // Task data enrichment via local status only
        taskData = null;
        const desc = String(
          taskData?.description || taskData?.body || "",
        ).toLowerCase();
        const completionSignals = [
          "superseded by",
          "already completed",
          "this task has been completed",
          "merged in",
          "completed via",
          "no longer needed",
          "already merged",
        ];
        const isDescComplete = completionSignals.some((s) => desc.includes(s));
        if (isDescComplete) {
          console.log(
            `[monitor] ${tag}: task description indicates already completed — archiving`,
          );
          void updateTaskStatus(attemptInfo.task_id, "done");
          await archiveAttempt(attemptId);
          return;
        }
      } catch {
        /* best effort */
      }
    }

    // ── Step 1: Check branch status ─────────────────────────────
    const branchStatus = await fetchBranchStatus(attemptId);
    if (!branchStatus) {
      console.log(`[monitor] ${tag}: cannot fetch branch-status, skipping`);
      return;
    }

    const { commits_ahead, commits_behind, has_uncommitted_changes } =
      branchStatus;

    // ── Step 2: Stale attempt detection ─────────────────────────
    // 0 commits ahead, 0 uncommitted changes, many behind → stale
    const isStale =
      commits_ahead === 0 && !has_uncommitted_changes && commits_behind > 10;
    if (isStale) {
      console.warn(
        `[monitor] ${tag}: stale attempt — 0 commits, ${commits_behind} behind. Trying merge refresh first.`,
      );
    }

    // No commits and no changes → archive stale attempt (unless called for conflict resolution)
    if (
      commits_ahead === 0 &&
      !has_uncommitted_changes &&
      status !== "conflict"
    ) {
      console.warn(
        `[monitor] ${tag}: no commits ahead, no changes — archiving stale attempt`,
      );
      await archiveAttempt(attemptId);
      if (telegramToken && telegramChatId) {
        void sendTelegramMessage(
          `:trash: Archived attempt ${shortId}: no commits, no changes (status=${status}). Task will be reattempted.`,
        );
      }
      return;
    }

    // Uncommitted changes but no commits → agent didn't commit
    if (has_uncommitted_changes && commits_ahead === 0) {
      console.log(
        `[monitor] ${tag}: uncommitted changes but no commits — agent needs to commit first`,
      );
      // Ask the agent to commit via primary agent
      if (primaryAgentReady) {
        void execPooledPrompt(
          `Task attempt ${shortId} has uncommitted changes but no commits.\n` +
            `Please navigate to the worktree for this attempt and:\n` +
            `1. Stage all changes: git add -A\n` +
            `2. Create a conventional commit\n` +
            `3. Push and create a PR`,
          { timeoutMs: 10 * 60 * 1000 },
        );
      }
      return;
    }

    // ── Resolve target branch (task-level upstream overrides) ───
    const attempt = await getAttemptInfo(attemptId);
    if (!taskData && attempt?.task_id) {
      // Task enrichment is now local-only
    }
    const targetBranch = resolveAttemptTargetBranch(attempt, taskData);

    // ── Step 3: Refresh onto target branch ───────────────────────
    console.log(`[monitor] ${tag}: refreshing onto ${targetBranch}...`);
    const rebaseResult = await rebaseAttempt(attemptId, targetBranch);

    if (rebaseResult && !rebaseResult.success) {
      if (isStale) {
        console.warn(
          `[monitor] ${tag}: stale attempt refresh failed — archiving and reattempting next cycle.`,
        );
        await archiveAttempt(attemptId);
        const freshStarted = await attemptFreshSessionRetry(
          "stale_attempt_rebase_failed",
          `Attempt ${shortId} was stale and rebase failed.`,
        );
        if (telegramToken && telegramChatId) {
          const action = freshStarted
            ? "Fresh session started for reattempt."
            : "Will reattempt on next cycle.";
          void sendTelegramMessage(
            `:trash: Archived stale attempt ${shortId} after failed rebase. ${action}`,
          );
        }
        return;
      }
      const errorData = rebaseResult.error_data;
      // Rebase has conflicts → try smart auto-resolve based on file type
      if (errorData?.type === "merge_conflicts") {
        const files = errorData.conflicted_files || [];
        console.warn(
          `[monitor] ${tag}: merge conflicts in ${files.join(", ")} — attempting smart auto-resolve`,
        );

        // Classify conflicted files
        const autoResolvable = classifyConflictedFiles(files);
        if (autoResolvable.allResolvable) {
          console.log(
            `[monitor] ${tag}: all ${files.length} conflicted files are auto-resolvable (${autoResolvable.summary})`,
          );
        } else {
          console.warn(
            `[monitor] ${tag}: ${autoResolvable.manualFiles.length} files need manual resolution: ${autoResolvable.manualFiles.join(", ")}`,
          );
        }

        // Try resolve-conflicts API first (it does "accept ours")
        const resolveResult = await resolveConflicts(attemptId);
        if (resolveResult?.success) {
          console.log(`[monitor] ${tag}: conflicts resolved via API`);
        } else {
          const attemptInfo = await getAttemptInfo(attemptId);
          let worktreeDir =
            attemptInfo?.worktree_dir || attemptInfo?.worktree || null;
          // Fallback: look up worktree by branch name from git
          if (!worktreeDir && (attemptInfo?.branch || attempt?.branch)) {
            worktreeDir = findWorktreeForBranch(
              attemptInfo?.branch || attempt?.branch,
            );
          }
          if (codexResolveConflictsEnabled) {
            console.warn(
              `[monitor] ${tag}: auto-resolve failed — running Codex SDK conflict resolution (worktree: ${worktreeDir || "UNKNOWN"})`,
            );
            const classification = classifyConflictedFiles(files);
            const fileGuidance = files
              .map((f) => {
                const fn = f.split("/").pop();
                if (
                  AUTO_RESOLVE_THEIRS.includes(fn) ||
                  AUTO_RESOLVE_LOCK_EXTENSIONS.some((ext) => fn.endsWith(ext))
                ) {
                  return `  - ${f}: Accept THEIRS (upstream version — lock/generated file)`;
                }
                if (AUTO_RESOLVE_OURS.includes(fn)) {
                  return `  - ${f}: Accept OURS (keep our version)`;
                }
                return `  - ${f}: Resolve MANUALLY (inspect both sides, merge intelligently)`;
              })
              .join("\n");
            const prompt = `You are fixing a git merge conflict in a worktree.
Worktree: ${worktreeDir || "(unknown)"}
Attempt: ${shortId}
Conflicted files: ${files.join(", ") || "(unknown)"}

Per-file resolution strategy:
${fileGuidance}

Instructions:
1) cd into the worktree directory.
2) For each conflicted file, apply the strategy above:
   - THEIRS: git checkout --theirs -- <file> && git add <file>
   - OURS: git checkout --ours -- <file> && git add <file>
   - MANUAL: Open the file, remove conflict markers (<<<< ==== >>>>), merge both sides intelligently, then git add <file>
3) After resolving all files, run: git merge --continue
4) If more conflicts appear, repeat steps 2-3.
5) Once the merge completes, push the branch: git push --force-with-lease
6) Verify the build still passes if possible.
Return a short summary of what you did and any files that needed manual resolution.`;
            const codexResult = await runCodexExec(
              prompt,
              worktreeDir || repoRoot,
              conflictResolutionTimeoutMs,
            );
            const logPath = resolve(
              logDir,
              `codex-conflict-${shortId}-${nowStamp()}.log`,
            );
            await writeFile(
              logPath,
              codexResult.output || codexResult.error || "(no output)",
              "utf8",
            );
            if (codexResult.success) {
              console.log(
                `[monitor] ${tag}: Codex conflict resolution succeeded`,
              );
              if (telegramToken && telegramChatId) {
                void sendTelegramMessage(
                  `:check: Codex resolved merge conflicts for ${shortId}. Log: ${logPath}`,
                );
              }
              return;
            }
            console.warn(
              `[monitor] ${tag}: Codex conflict resolution failed — prompting agent`,
            );
            if (telegramToken && telegramChatId) {
              void sendTelegramMessage(
                `:alert: Codex failed to resolve conflicts for ${shortId}. Log: ${logPath}`,
              );
            }
          }
          // Auto-resolve failed — ask agent to fix
          console.warn(
            `[monitor] ${tag}: auto-resolve failed — prompting agent`,
          );
          if (telegramToken && telegramChatId) {
            void sendTelegramMessage(
              `:alert: Attempt ${shortId} has unresolvable merge conflicts: ${files.join(", ")}`,
            );
          }
          if (primaryAgentReady) {
            void execPooledPrompt(
              `Task attempt ${shortId} has rebase conflicts in: ${files.join(", ")}.\n` +
                `Please resolve the conflicts, commit, push, and create a PR.`,
              { timeoutMs: 15 * 60 * 1000 },
            );
          }
          return;
        }
      }
    }

    // ── Step 4: Build PR title & description from task ─────

    let prTitle = attempt?.task_title || attempt?.branch || shortId;

    // Build PR description from task description + auto-created footer
    let prDescription = "";
    if (attempt?.task_description) {
      prDescription = attempt.task_description.trim();
      prDescription += `\n\n---\n_Auto-created by bosun (${status})_`;
    } else {
      prDescription = `Auto-created by bosun after ${status} status.`;
    }

    const branchName = attempt?.branch || branchStatus?.branch || null;
    const allowAutoPr = await runSmartPrPreCreationAssessment({
      attemptId,
      shortId,
      status,
      attempt,
      taskData,
      branchStatus,
      targetBranch,
    });
    if (!allowAutoPr) {
      console.log(
        `[monitor] ${tag}: auto-PR deferred until assessment follow-up completes`,
      );
      return;
    }

    if (attempt?.pr_number || attempt?.pr_url) {
      console.log(
        `[monitor] ${tag}: attempt already linked to PR (${attempt.pr_number || attempt.pr_url}) — skipping`,
      );
      return;
    }
    if (branchName) {
      let existingPr = null;
      if (ghAvailable()) {
        existingPr = await findExistingPrForBranch(branchName);
      }
      if (!existingPr) {
        existingPr = await findExistingPrForBranchApi(branchName);
      }
      if (existingPr) {
        const state = (existingPr.state || "").toUpperCase();
        if (state === "CLOSED" && smartPrAllowRecreateClosed) {
          console.log(
            `[monitor] ${tag}: existing CLOSED PR #${existingPr.number} found, recreating allowed by VE_SMARTPR_ALLOW_RECREATE_CLOSED`,
          );
        } else {
          console.log(
            `[monitor] ${tag}: existing PR #${existingPr.number} (${state}) for ${branchName} — skipping auto-PR`,
          );
          if (telegramToken && telegramChatId) {
            void sendTelegramMessage(
              `:alert: Auto-PR skipped for ${shortId}: existing PR #${existingPr.number} (${state}) already linked to ${branchName}.`,
            );
          }
          return;
        }
      }
    }

    // ── Step 5: Create PR via backend API ────────────────────────────
    console.log(`[monitor] ${tag}: creating PR "${prTitle}"...`);
    const prResult = await createPRViaBackend(attemptId, {
      title: prTitle,
      description: prDescription,
      draft: false,
      base: targetBranch,
    });

    if (prResult?.success) {
      const prUrl = prResult.data?.url || prResult.data?.html_url || "";
      const prNum = prResult.data?.number || null;
      console.log(
        `[monitor] ${tag}: PR created successfully${prUrl ? " — " + prUrl : ""}`,
      );
      if (telegramToken && telegramChatId) {
        void sendTelegramMessage(
          `:check: Auto-created PR for ${shortId}${prUrl ? ": " + prUrl : ""}`,
        );
      }

      return;
    }

    // ── Step 6: Handle PR creation failure ──────────────────────
    const elapsed = prResult._elapsedMs || 0;
    const isFastFail = elapsed < 2000; // < 2s = instant (worktree/config issue)

    if (prResult.error === "repo_id_missing") {
      console.warn(
        `[monitor] ${tag}: PR creation failed — repo_id missing (config/API issue)`,
      );
      if (telegramToken && telegramChatId) {
        void sendTelegramMessage(
          `:alert: Auto-PR for ${shortId} failed: repo_id missing. Check kanban backend configuration.`,
        );
      }
      return;
    }

    if (isFastFail) {
      // Instant failure — worktree issue, ask agent to handle everything
      console.warn(
        `[monitor] ${tag}: PR creation fast-failed (${elapsed}ms) — worktree/config issue`,
      );
      if (telegramToken && telegramChatId) {
        void sendTelegramMessage(
          `:alert: Auto-PR for ${shortId} fast-failed (${elapsed}ms) — likely worktree issue. Prompting agent.`,
        );
      }
      if (primaryAgentReady) {
        void execPooledPrompt(
          `Task attempt ${shortId} needs to create a PR but the automated PR creation ` +
            `failed instantly (worktree or config issue).\n` +
            `Branch: ${attempt?.branch || shortId}\n\n` +
            `Please:\n` +
            `1. Navigate to the worktree\n` +
            `2. Ensure git status is clean and commits exist\n` +
            `3. Run: git push --set-upstream origin ${attempt?.branch || shortId}\n` +
            `4. Create a PR targeting main`,
          { timeoutMs: 15 * 60 * 1000 },
        );
      }
    } else {
      // Slow failure — prepush hooks failed (lint/test/build)
      console.warn(
        `[monitor] ${tag}: PR creation slow-failed (${Math.round(elapsed / 1000)}s) — prepush hook failure`,
      );
      if (telegramToken && telegramChatId) {
        void sendTelegramMessage(
          `:alert: Auto-PR for ${shortId} failed after ${Math.round(elapsed / 1000)}s (prepush hooks). Prompting agent to fix.`,
        );
      }
      if (primaryAgentReady) {
        void execPooledPrompt(
          `Task attempt ${shortId}: the prepush hooks (lint/test/build) failed ` +
            `when trying to create a PR.\n` +
            `Branch: ${attempt?.branch || shortId}\n\n` +
            `Please:\n` +
            `1. Navigate to the worktree for this branch\n` +
            `2. Fix any lint, test, or build errors\n` +
            `3. Commit the fixes\n` +
            `4. Merge main into the branch: git pull --no-rebase origin main\n` +
            `5. Push: git push --set-upstream origin ${attempt?.branch || shortId}\n` +
            `6. Create a PR targeting main`,
          { timeoutMs: 15 * 60 * 1000 },
        );
      }
    }
  } catch (err) {
    console.warn(`[monitor] ${tag}: error — ${err.message || err}`);
  }
}

// Tracks attempts we've already tried smartPR for (dedup)
const smartPRAttempted = new Set();

/**
 * Check if a shortId (or a prefix/suffix of it) is already tracked.
 * Handles the case where the orchestrator emits different-length prefixes
 * for the same attempt UUID (e.g., "2f71" and "2f7153e7").
 */
function isSmartPRAttempted(shortId) {
  if (smartPRAttempted.has(shortId)) return true;
  for (const existing of smartPRAttempted) {
    if (existing.startsWith(shortId) || shortId.startsWith(existing)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve a short (4-8 char) attempt ID prefix to the full UUID and trigger
 * smartPRFlow. De-duplicated so each attempt is only processed once per
 * monitor lifetime.
 */
async function resolveAndTriggerSmartPR(shortId, status) {
  if (isSmartPRAttempted(shortId)) return;
  smartPRAttempted.add(shortId);

  try {
    const statusData = await readStatusData();
    const attempts = statusData?.active_attempts || [];
    const match = attempts.find((a) => a.id?.startsWith(shortId));

    // ── Early merged-branch check: skip if branch is already merged ──
    const resolvedAttempt = match;
    if (resolvedAttempt?.branch) {
      if (
        await isMergedBranchCacheEntryStillValid(
          resolvedAttempt.branch,
          resolvedAttempt?.target_branch ||
            resolvedAttempt?.targetBranch ||
            resolvedAttempt?.base_branch ||
            resolvedAttempt?.baseBranch ||
            null,
        )
      ) {
        console.log(
          `[monitor] smartPR(${shortId}): branch ${resolvedAttempt.branch} already in mergedBranchCache — skipping`,
        );
        return;
      }
      // Check GitHub for a merged PR with this head branch
      const merged = await isBranchMerged(resolvedAttempt.branch);
      if (merged) {
        let canFinalize = true;
        if (resolvedAttempt.task_id) {
          canFinalize = await shouldFinalizeMergedTask(
            {
              id: resolvedAttempt.task_id,
              title: resolvedAttempt.task_title || resolvedAttempt.task_id,
              description: resolvedAttempt.task_description || "",
              pr_number: resolvedAttempt.pr_number || null,
              pr_url: resolvedAttempt.pr_url || "",
            },
            {
              branch: resolvedAttempt.branch,
              prNumber: resolvedAttempt.pr_number || null,
              reason: "resolve_smartpr_merged_branch",
            },
          );
        }
        console.log(
          `[monitor] smartPR(${shortId}): branch ${resolvedAttempt.branch} confirmed merged — ${canFinalize ? "completing task and skipping PR flow" : "awaiting review gate"}`,
        );
        addMergedBranchCache(resolvedAttempt.branch);
        if (resolvedAttempt.task_id && canFinalize) {
          mergedTaskCache.add(resolvedAttempt.task_id);
          pendingMergeStrategyByTask.delete(
            String(resolvedAttempt.task_id || "").trim(),
          );
          void updateTaskStatus(resolvedAttempt.task_id, "done");
        }
        await archiveAttempt(resolvedAttempt.id || shortId);
        saveMergedTaskCache();
        return;
      }
    }

    if (!match) {
      console.log(
        `[monitor] smartPR(${shortId}): attempt not found in status data`,
      );
      return;
    }
    await smartPRFlow(match.id, shortId, status);
  } catch (err) {
    console.warn(`[monitor] resolveSmartPR(${shortId}): ${err.message || err}`);
  }
}

const errorQueue = [];

function queueErrorMessage(line) {
  errorQueue.push(stripAnsi(line));
  if (errorQueue.length >= 3) {
    void flushErrorQueue();
  }
}

async function flushErrorQueue() {
  if (!telegramToken || !telegramChatId) {
    return;
  }
  if (errorQueue.length === 0) {
    return;
  }
  const lines = errorQueue.splice(0, errorQueue.length);
  const message = [`${projectName} Orchestrator Error`, ...lines].join("\n");
  await sendTelegramMessage(message);
}

function notifyMerge(line) {
  const match = line.match(/PR\s+#(\d+)/i);
  if (!match) {
    return;
  }
  const pr = match[1];
  if (mergeNotified.has(pr)) {
    return;
  }
  mergeNotified.add(pr);
  pendingMerges.add(pr);
}

function notifyMergeFailure(line) {
  if (!telegramToken || !telegramChatId) {
    return;
  }
  const match = line.match(
    /Merge notify: PR #(\d+)\s+stage=([^\s]+)\s+category=([^\s]+)\s+action=([^\s]+)\s+reason=(.+)$/i,
  );
  if (!match) {
    return;
  }
  const pr = match[1];
  const stage = match[2];
  const category = match[3];
  const action = match[4];
  const reason = match[5];
  if (stage !== "manual_review") {
    return;
  }
  if (mergeFailureNotified.has(pr)) {
    return;
  }
  mergeFailureNotified.set(pr, Date.now());
  const message = [
    `Merge failed for PR #${pr} (${stage})`,
    `Category: ${category}`,
    `Action: ${action}`,
    `Reason: ${reason}`,
    `${repoUrlBase}/pull/${pr}`,
  ].join("\n");
  void sendTelegramMessage(message);
}

async function flushMergeNotifications() {
  if (!telegramToken || !telegramChatId) {
    return;
  }
  if (pendingMerges.size === 0) {
    return;
  }
  const merged = Array.from(pendingMerges);
  pendingMerges.clear();
  const formatted = merged
    .map((pr) => `#${pr} ${repoUrlBase}/pull/${pr}`)
    .join(", ");
  const message = `Merged PRs: ${formatted}`;
  await sendTelegramMessage(message);
}

async function readStatusData() {
  try {
    const raw = await readFile(statusPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readStatusSummary() {
  try {
    const status = await readStatusData();
    if (!status) {
      return {
        text: `${projectName} Orchestrator Update\nStatus: unavailable (missing status file)`,
        parseMode: null,
      };
    }

    const counts = status.counts || {};
    const submitted = Array.isArray(status.submitted_tasks)
      ? status.submitted_tasks
      : [];
    const completed = Array.isArray(status.completed_tasks)
      ? status.completed_tasks
      : [];
    const followups = Array.isArray(status.followup_events)
      ? status.followup_events
      : [];
    const copilotRequests = Array.isArray(status.copilot_requests)
      ? status.copilot_requests
      : [];
    const attempts = status.attempts || {};
    const manualReviewTasks = Array.isArray(status.manual_review_tasks)
      ? status.manual_review_tasks
      : [];

    const now = Date.now();
    const intervalMs = telegramIntervalMin * 60 * 1000;
    const cutoff = now - intervalMs;

    const recentSubmitted = submitted.filter((item) => {
      if (!item.submitted_at) {
        return false;
      }
      const ts = Date.parse(item.submitted_at);
      return Number.isFinite(ts) && ts >= cutoff;
    });

    const recentCompleted = completed.filter((item) => {
      if (!item.completed_at) {
        return false;
      }
      const ts = Date.parse(item.completed_at);
      return Number.isFinite(ts) && ts >= cutoff;
    });

    const recentFollowups = followups.filter((item) => {
      if (!item.occurred_at) {
        return false;
      }
      const ts = Date.parse(item.occurred_at);
      return Number.isFinite(ts) && ts >= cutoff;
    });

    const recentCopilot = copilotRequests.filter((item) => {
      if (!item.occurred_at) {
        return false;
      }
      const ts = Date.parse(item.occurred_at);
      return Number.isFinite(ts) && ts >= cutoff;
    });

    const manualReviewLines = manualReviewTasks.length
      ? manualReviewTasks.map((taskId) => {
          const attempt = Object.values(attempts).find(
            (item) =>
              item &&
              item.task_id === taskId &&
              item.status === "manual_review",
          );
          if (attempt && attempt.pr_number) {
            const prNumber = `#${attempt.pr_number}`;
            return `- ${formatHtmlLink(
              `${repoUrlBase}/pull/${attempt.pr_number}`,
              prNumber,
            )}`;
          }
          return `- ${escapeHtml(taskId)}`;
        })
      : ["- none"];

    const createdLines = recentSubmitted.length
      ? recentSubmitted.map((item) => {
          const title = item.task_title || item.task_id || "(task)";
          const link = item.task_url
            ? formatHtmlLink(item.task_url, title)
            : escapeHtml(title);
          return `- ${link}`;
        })
      : ["- none"];

    const mergedLines = recentCompleted.length
      ? recentCompleted.map((item) => {
          const prNumber = item.pr_number ? `#${item.pr_number}` : "";
          const title = item.pr_title || prNumber || "(PR)";
          const link = item.pr_url
            ? formatHtmlLink(item.pr_url, title)
            : escapeHtml(title);
          const suffix =
            prNumber && !title.includes(prNumber) ? ` (${prNumber})` : "";
          return `- ${link}${suffix}`;
        })
      : ["- none"];

    const followupLines = recentFollowups.length
      ? recentFollowups.map((item) => {
          const title = item.task_title || item.task_id || "(task)";
          const link = item.task_url
            ? formatHtmlLink(item.task_url, title)
            : escapeHtml(title);
          const reason = item.reason ? `: ${escapeHtml(item.reason)}` : "";
          return `- ${link}${reason}`;
        })
      : ["- none"];

    const copilotLines = recentCopilot.length
      ? recentCopilot.map((item) => {
          const prNumber = item.pr_number ? `#${item.pr_number}` : "";
          const title = item.pr_title || prNumber || "(PR)";
          const link = item.pr_url
            ? formatHtmlLink(item.pr_url, title)
            : escapeHtml(title);
          const reason = item.reason ? `: ${escapeHtml(item.reason)}` : "";
          return `- ${link}${reason}`;
        })
      : ["- none"];

    const running = counts.running ?? 0;
    const review = counts.review ?? 0;
    const error = counts.error ?? 0;
    const manualReview = counts.manual_review ?? 0;

    // Success rate metrics
    const sm = status.success_metrics || {};
    const firstShot = sm.first_shot_success ?? 0;
    const neededFix = sm.needed_fix ?? 0;
    const failed = sm.failed ?? 0;
    const firstShotRate = sm.first_shot_rate ?? 0;
    const totalDecided = firstShot + neededFix + failed;
    const successLine =
      totalDecided > 0
        ? `First-shot: ${firstShotRate}% (${firstShot}/${totalDecided}) | Fix: ${neededFix} | Failed: ${failed}`
        : "No completed tasks yet";

    const message = [
      `${projectName} Orchestrator ${telegramIntervalMin}-min Update`,
      `New tasks created (${recentSubmitted.length}):`,
      ...createdLines,
      `Merged tasks (${recentCompleted.length}):`,
      ...mergedLines,
      `Task follow-ups (${recentFollowups.length}):`,
      ...followupLines,
      `Copilot triggered (${recentCopilot.length}):`,
      ...copilotLines,
      `Manual review (${manualReviewTasks.length}):`,
      ...manualReviewLines,
      `Counts: running=${running}, review=${review}, error=${error}, manual_review=${manualReview}, conflict_resolving=${conflictResolutionCooldown.size}`,
      `Success: ${successLine}`,
    ].join("\n");

    return { text: message, parseMode: "HTML" };
  } catch (err) {
    return {
      text: `${projectName} Orchestrator Update\nStatus: unavailable (missing status file)`,
      parseMode: null,
    };
  }
}

function truncateText(value, maxChars = 1200) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

function formatRecentStatusItems(items, timestampField, maxItems = 6) {
  if (!Array.isArray(items) || items.length === 0) return [];
  return [...items]
    .sort((a, b) => {
      const ta = Date.parse(a?.[timestampField] || 0);
      const tb = Date.parse(b?.[timestampField] || 0);
      return tb - ta;
    })
    .slice(0, maxItems)
    .map((entry) => {
      const id = (entry?.task_id || entry?.id || "").toString().slice(0, 8);
      const title = deriveTaskDisplayTitle(entry?.task_title || entry?.title, id);
      const suffix =
        id && title !== `Task ${id}` ? ` (${id})` : "";
      return `- ${title}${suffix}`;
    });
}

function safeJsonBlock(value, maxChars = 1600) {
  const serialized = safeStringify(value);
  if (!serialized) return "(unavailable)";
  return truncateText(serialized, maxChars);
}

function readRecentGitCommits(limit = 12) {
  try {
    const output = execSync(`git log --oneline -${Math.max(1, limit)}`, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Extract a conventional-commit scope from a task title and return the
 * corresponding module branch ref (e.g. "origin/veid").
 * Respects TASK_BRANCH_AUTO_MODULE env var (default: true) and
 * MODULE_BRANCH_PREFIX (default: "origin/").
 */
function extractModuleBaseBranchFromTitle(title) {
  const enabled = (process.env.TASK_BRANCH_AUTO_MODULE ?? "true") !== "false";
  if (!enabled || !title) return null;
  const match = String(title).match(
    /(?:^\[[^\]]+\]\s*)?(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)\(([^)]+)\)/i,
  );
  if (!match) return null;
  const scope = match[1].toLowerCase().trim();
  // Exclude generic scopes that don't map to real module branches
  const generic = new Set(["deps", "app", "sdk", "cli", "api"]);
  if (generic.has(scope)) return null;
  const prefix = (process.env.MODULE_BRANCH_PREFIX || "origin/").replace(/\/*$/, "/");
  return `${prefix}${scope}`;
}

// GitHub reconciler hooks are currently optional; keep shutdown/reload calls safe.
function restartGitHubReconciler() {}
function stopGitHubReconciler() {}

async function sendTelegramMessage(text, options = {}) {
  const targetChatId = options.chatId ?? telegramChatId;
  if (!telegramToken || !targetChatId) {
    return;
  }
  const rawDedupKey = options.dedupKey ?? String(text || "").trim();
  // Use fuzzy normalization so structural duplicates with different numbers match
  const dedupKey = options.exactDedup
    ? rawDedupKey
    : normalizeDedupKey(rawDedupKey);
  if (dedupKey && !options.skipDedup) {
    const now = Date.now();
    const last = telegramDedup.get(dedupKey) || 0;
    if (now - last < 5 * 60 * 1000) {
      return;
    }
    telegramDedup.set(dedupKey, now);
  }

  // Always record to history ring buffer (even deduped messages are useful context)
  pushTelegramHistory(String(text || ""));

  // Determine priority based on message content
  const textLower = String(text || "").toLowerCase();
  let priority = 4; // default: info
  let category = "general";

  // Positive signals override negative keyword matches — a ":check: Task completed"
  // message should never be classified as an error even when the task title
  // happens to contain words like "error" or "failed".
  // Orchestrator periodic updates contain counter labels like "Failed: 0" and
  // "error=0" which should NOT trigger error classification.
  // Status updates contain "Last error: none" which
  // is informational, not an actual error.
  const isPositive =
    textLower.includes(":check:") ||
    textLower.includes("task completed") ||
    textLower.includes("branch merged") ||
    textLower.includes("pr merged") ||
    (textLower.includes("orchestrator") && textLower.includes("-min update")) ||
    (textLower.includes("update") && textLower.includes("last error: none")) ||
    (textLower.includes("update") && textLower.includes("- reason:"));

  // Priority 1: Critical/Fatal
  if (
    !isPositive &&
    (textLower.includes("fatal") ||
      textLower.includes("critical") ||
      textLower.includes(":zap:"))
  ) {
    priority = 1;
    category = "critical";
  }
  // Priority 2: Errors
  else if (
    !isPositive &&
    (textLower.includes("error") ||
      textLower.includes("failed") ||
      textLower.includes(":close:") ||
      textLower.includes("auto-fix gave up"))
  ) {
    priority = 2;
    category = "error";
  }
  // Priority 3: Warnings
  else if (
    !isPositive &&
    (textLower.includes("warning") || textLower.includes(":alert:"))
  ) {
    priority = 3;
    category = "warning";
  }
  // Priority 4: Info (default)
  else {
    // Categorize info messages
    if (textLower.includes("pr") || textLower.includes("pull request")) {
      category = "pr";
    } else if (textLower.includes("task") || textLower.includes("completed")) {
      category = "task";
    } else if (textLower.includes("codex") || textLower.includes("analysis")) {
      category = "analysis";
    } else if (
      textLower.includes("auto-created") ||
      textLower.includes("merged")
    ) {
      category = "git";
    }
  }

  // Allow caller to explicitly override the computed priority (e.g. auto-update
  // restart notifications should always arrive as direct messages, not digest).
  if (options.priority !== undefined) priority = Number(options.priority);

  // Route through batching system — apply verbosity filter first.
  // minimal: only priority 1-2 (critical + error)
  // summary: priority 1-4 (everything except debug) — DEFAULT
  // detailed: priority 1-5 (everything)
  const maxPriority =
    telegramVerbosity === "minimal"
      ? 2
      : telegramVerbosity === "detailed"
        ? 5
        : 4;
  if (priority > maxPriority) return; // filtered out by verbosity setting

  // Also bridge critical/error notifications to WhatsApp (if enabled)
  if (priority <= 2 && isWhatsAppEnabled()) {
    notifyWhatsApp(stripAnsi(String(text || ""))).catch(() => {});
  }

  return notify(text, priority, {
    category,
    silent: options.silent,
    data: { parseMode: options.parseMode, chatId: targetChatId },
  });
}

async function ensureWeeklyReportStateLoaded() {
  if (weeklyReportStateLoaded) return;
  weeklyReportStateLoaded = true;
  try {
    const state = await readWeeklyReportScheduleState({
      statePath: weeklyReportStatePath,
    });
    weeklyReportLastSentAt = state?.lastSentAt || null;
  } catch (err) {
    console.warn(
      `[monitor] failed loading weekly report state from ${weeklyReportStatePath}: ${err?.message || err}`,
    );
    weeklyReportLastSentAt = null;
  }
}

async function maybeSendWeeklyReport(nowInput = new Date()) {
  if (!telegramWeeklyReportEnabled) return;
  if (!telegramToken || !telegramChatId) return;
  await ensureWeeklyReportStateLoaded();
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  if (!Number.isFinite(now.getTime())) return;

  if (!shouldSendWeeklyReport({
    now,
    dayOfWeek: telegramWeeklyReportDay,
    hourUtc: telegramWeeklyReportHour,
    lastSentAt: weeklyReportLastSentAt,
  })) return;

  try {
    const report = await generateWeeklyAgentWorkReport({
      days: telegramWeeklyReportDays,
      now,
    });
    await sendTelegramMessage(report.text, {
      dedupKey: `weekly-report:${now.toISOString().slice(0, 10)}`,
      exactDedup: true,
      skipDedup: true,
    });
    weeklyReportLastSentAt = now.toISOString();
    await writeWeeklyReportScheduleState(weeklyReportLastSentAt, {
      statePath: weeklyReportStatePath,
    });
    if (Array.isArray(report.warnings) && report.warnings.length > 0) {
      console.warn(
        `[monitor] weekly report generated with warnings: ${report.warnings.join(" | ")}`,
      );
    }
  } catch (err) {
    console.warn(`[monitor] weekly report generation failed: ${err?.message || err}`);
    await sendTelegramMessage(
      `:alert: Weekly report failed: ${err?.message || err}`,
      { dedupKey: "weekly-report:failed", exactDedup: true },
    );
  }
}

globalThis.__bosunNotifyAnomaly = (anomaly) => {
  if (process.env.BOSUN_INTERNAL_ANOMALY_NOTIFY === "false") return;
  if (!telegramToken || !telegramChatId) return;
  const icon =
    anomaly.severity === "CRITICAL"
      ? ":dot:"
      : anomaly.severity === "HIGH"
        ? ":u1f7e0:"
        : anomaly.severity === "MEDIUM"
          ? ":dot:"
          : ":dot:";
  const lines = [
    `${icon} Internal Anomaly: ${anomaly.type}`,
    `Attempt: ${anomaly.processId || anomaly.shortId || "unknown"}`,
    anomaly.message ? `Message: ${anomaly.message}` : null,
  ].filter(Boolean);
  void sendTelegramMessage(lines.join("\n"), {
    dedupKey: `internal-anomaly:${anomaly.type}:${anomaly.processId || anomaly.shortId || "unknown"}`,
  }).catch(() => {});
};

function enqueueTelegramCommand(handler) {
  telegramCommandQueue.push(handler);
  runDetached("telegram-commands:drain", drainTelegramCommandQueue);
}

function drainTelegramCommandQueue() {
  while (
    telegramCommandActive < telegramCommandConcurrency &&
    telegramCommandQueue.length > 0
  ) {
    const job = telegramCommandQueue.shift();
    if (!job) {
      continue;
    }
    telegramCommandActive += 1;
    Promise.resolve()
      .then(job)
      .catch((err) => {
        console.warn(
          `[monitor] telegram command handler failed: ${err?.message || err}`,
        );
      })
      .finally(() => {
        telegramCommandActive -= 1;
        setImmediate(() => drainTelegramCommandQueue());
      });
  }
}

function normalizeTelegramCommand(text) {
  if (!text) {
    return null;
  }
  const trimmed = String(text).trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const [raw, ...rest] = trimmed.split(/\s+/);
  const command = raw.split("@")[0].toLowerCase();
  return { command, args: rest.join(" ") };
}

function isAllowedTelegramChat(chatId) {
  if (!telegramChatId) {
    return true;
  }
  return String(chatId) === String(telegramChatId);
}

function limitLines(lines, limit = 8) {
  if (lines.length <= limit) {
    return lines;
  }
  const remaining = lines.length - limit;
  return [...lines.slice(0, limit), `- ...and ${remaining} more`];
}

function buildTaskUrl(task, projectId) {
  if (!task) {
    return null;
  }

  const taskId = task.id || task;
  const backend = getActiveKanbanBackend();

  // For GitHub, task object might have URL in meta
  if (backend === "github") {
    if (typeof task === "object" && task.meta?.url) {
      return task.meta.url;
    }
    // GitHub issue URL format
    const cfg = loadConfig();
    const slug = process.env.GITHUB_REPOSITORY || cfg?.repoSlug || "";
    if (!slug || slug === "unknown/unknown") {
      return null;
    }
    return `https://github.com/${slug}/issues/${String(taskId).replace(/^#/, "")}`;
  }

  // Fallback for other backends
  return null;
}

function formatTaskLink(item) {
  const title = item.task_title || item.task_id || "(task)";
  if (item.task_url) {
    return formatHtmlLink(item.task_url, title);
  }
  return escapeHtml(title);
}

function formatAttemptLine(attempt) {
  if (!attempt) {
    return null;
  }
  const taskId = attempt.task_id ? escapeHtml(attempt.task_id) : "(task)";
  const branch = attempt.branch ? ` (${escapeHtml(attempt.branch)})` : "";
  const status = attempt.status ? ` — ${escapeHtml(attempt.status)}` : "";
  if (attempt.pr_number) {
    const prLabel = `#${attempt.pr_number}`;
    const prLink = formatHtmlLink(
      `${repoUrlBase}/pull/${attempt.pr_number}`,
      prLabel,
    );
    return `- ${taskId} ${prLink}${branch}${status}`;
  }
  return `- ${taskId}${branch}${status}`;
}

async function buildTasksResponse() {
  const status = await readStatusData();
  if (!status) {
    return {
      text: "Status unavailable (missing status file).",
      parseMode: null,
    };
  }

  const counts = status.counts || {};
  const attempts = status.attempts || {};
  const runningAttempts = Object.values(attempts).filter(
    (attempt) => attempt && attempt.status === "running",
  );

  const reviewTasks = Array.isArray(status.review_tasks)
    ? status.review_tasks
    : [];
  const errorTasks = Array.isArray(status.error_tasks)
    ? status.error_tasks
    : [];
  const manualReviewTasks = Array.isArray(status.manual_review_tasks)
    ? status.manual_review_tasks
    : [];
  const submitted = Array.isArray(status.submitted_tasks)
    ? status.submitted_tasks
    : [];

  const runningLines = limitLines(
    runningAttempts
      .map((attempt) => formatAttemptLine(attempt))
      .filter(Boolean),
  );
  const submittedLines = limitLines(
    submitted.map((item) => `- ${formatTaskLink(item)}`),
  );

  const reviewLines = reviewTasks.length
    ? limitLines(reviewTasks.map((taskId) => `- ${escapeHtml(taskId)}`))
    : ["- none"];
  const errorLines = errorTasks.length
    ? limitLines(errorTasks.map((taskId) => `- ${escapeHtml(taskId)}`))
    : ["- none"];
  const manualLines = manualReviewTasks.length
    ? limitLines(manualReviewTasks.map((taskId) => `- ${escapeHtml(taskId)}`))
    : ["- none"];

  const message = [
    `${projectName} Task Snapshot`,
    `Counts: running=${counts.running ?? 0}, review=${counts.review ?? 0}, error=${counts.error ?? 0}, manual_review=${counts.manual_review ?? 0}`,
    `Backlog remaining: ${status.backlog_remaining ?? 0}`,
    "Running attempts:",
    ...(runningLines.length ? runningLines : ["- none"]),
    "Recently submitted:",
    ...(submittedLines.length ? submittedLines : ["- none"]),
    "Needs review:",
    ...reviewLines,
    "Errors:",
    ...errorLines,
    "Manual review:",
    ...manualLines,
  ].join("\n");

  return { text: message, parseMode: "HTML" };
}

async function buildAgentResponse() {
  const status = await readStatusData();
  const attempts = status?.attempts || {};
  const runningAttempts = Object.values(attempts).filter(
    (attempt) => attempt && attempt.status === "running",
  );
  const activeLines = limitLines(
    runningAttempts
      .map((attempt) => formatAttemptLine(attempt))
      .filter(Boolean),
  );
  const orchestratorState = currentChild
    ? `Orchestrator running (pid ${currentChild.pid}).`
    : "Orchestrator not running.";
  const message = [
    `${projectName} Agent Status`,
    orchestratorState,
    `Active attempts: ${runningAttempts.length}`,
    ...(activeLines.length ? activeLines : ["- none"]),
  ].join("\n");
  return { text: message, parseMode: "HTML" };
}

async function buildBackgroundResponse() {
  const now = Date.now();
  const halted =
    now < orchestratorHaltedUntil
      ? `halted until ${new Date(orchestratorHaltedUntil).toISOString()}`
      : "active";
  const safeMode =
    now < monitorSafeModeUntil
      ? `safe-mode until ${new Date(monitorSafeModeUntil).toISOString()}`
      : "normal";
  const message = [
    `${projectName} Background Status`,
    currentChild
      ? `Orchestrator: running (pid ${currentChild.pid})`
      : "Orchestrator: stopped",
    `Monitor state: ${halted}, ${safeMode}`,
  ].join("\n");
  return { text: message, parseMode: null };
}

async function buildHealthResponse() {
  const status = await readStatusData();
  const updatedAt = status?.updated_at
    ? new Date(status.updated_at).toISOString()
    : "unknown";
  const message = [
    `${projectName} Health`,
    `Orchestrator: ${currentChild ? "running" : "stopped"}`,
    `Status updated: ${updatedAt}`,
  ].join("\n");
  return { text: message, parseMode: null };
}

async function handleTelegramUpdate(update) {
  if (!update) {
    return;
  }
  const message =
    update.message || update.edited_message || update.callback_query?.message;
  if (!message) {
    return;
  }
  const chatId = message.chat?.id;
  if (!chatId || !isAllowedTelegramChat(chatId)) {
    return;
  }
  const parsed = normalizeTelegramCommand(message.text || "");
  if (!parsed) {
    return;
  }

  let response = null;
  switch (parsed.command) {
    case "/status":
      response = await readStatusSummary();
      break;
    case "/tasks":
      response = await buildTasksResponse();
      break;
    case "/agent":
      response = await buildAgentResponse();
      break;
    case "/background":
      response = await buildBackgroundResponse();
      break;
    case "/health":
      response = await buildHealthResponse();
      break;
    case "/help":
    case "/start":
      response = {
        text: [
          `${projectName} Command Help`,
          "/status — summary snapshot",
          "/tasks — task breakdown",
          "/agent — active agent status",
          "/background — monitor status",
          "/health — service health",
        ].join("\n"),
        parseMode: null,
      };
      break;
    default:
      response = {
        text: "Unknown command. Send /help for available commands.",
        parseMode: null,
      };
      break;
  }

  if (!response || !response.text) {
    return;
  }

  await sendTelegramMessage(response.text, {
    chatId,
    parseMode: response.parseMode,
    disablePreview: true,
    skipDedup: true,
  });
}

async function fetchTelegramUpdates() {
  const url = `https://api.telegram.org/bot${telegramToken}/getUpdates`;
  const params = new URLSearchParams({
    offset: String(telegramUpdateOffset),
    timeout: String(Math.max(5, telegramCommandPollTimeoutSec)),
    limit: String(Math.max(1, telegramCommandMaxBatch)),
  });

  const controller = new AbortController();
  const timeoutMs = (telegramCommandPollTimeoutSec + 5) * 1000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!res || !res.ok) {
      const body = res ? await res.text() : "";
      const status = res?.status || "no response";
      console.warn(`[monitor] telegram getUpdates failed: ${status} ${body}`);
      if (res?.status === 409) {
        telegramCommandEnabled = false;
        await releaseTelegramPollLock();
      }
      return [];
    }
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result)) {
      return [];
    }
    return data.result;
  } catch (err) {
    if (err?.name !== "AbortError") {
      console.warn(
        `[monitor] telegram getUpdates error: ${err?.message || err}`,
      );
    }
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function pollTelegramCommands() {
  if (shuttingDown) {
    telegramCommandPolling = false;
    return;
  }
  if (!telegramCommandEnabled) {
    telegramCommandPolling = false;
    return;
  }
  try {
    const updates = await fetchTelegramUpdates();
    if (updates.length) {
      for (const update of updates) {
        if (typeof update.update_id === "number") {
          telegramUpdateOffset = update.update_id + 1;
        }
        enqueueTelegramCommand(async () => {
          try {
            await handleTelegramUpdate(update);
          } catch (err) {
            const message =
              err && err.message ? err.message : String(err || "unknown error");
            console.warn(`[monitor] telegram command crashed: ${message}`);
            const chatId = update.message?.chat?.id;
            if (chatId && isAllowedTelegramChat(chatId)) {
              await sendTelegramMessage(`Command failed: ${message}`, {
                chatId,
                skipDedup: true,
              });
            }
          }
        });
      }
    }
    const delayMs = updates.length ? 0 : 1000;
    safeSetTimeout("telegram-commands:poll-loop", () =>
      runDetached("telegram-commands:poll-loop", pollTelegramCommands), delayMs);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn(`[monitor] telegram command poll error: ${message}`);
    safeSetTimeout("telegram-commands:poll-error-retry", () =>
      runDetached("telegram-commands:poll-error-retry", pollTelegramCommands), 3000);
  }
}

function startTelegramCommandListener() {
  if (!telegramToken || !telegramCommandEnabled) {
    return;
  }
  if (telegramCommandPolling) {
    return;
  }
  runDetached("telegram-commands:acquire-lock", async () => {
    const ok = await acquireTelegramPollLock("monitor");
    if (!ok) {
      telegramCommandEnabled = false;
      return;
    }
    telegramCommandPolling = true;
    runDetached("telegram-commands:poll", pollTelegramCommands);
  });
}

async function startTelegramNotifier() {
  if (telegramNotifierInterval) {
    clearInterval(telegramNotifierInterval);
    telegramNotifierInterval = null;
  }
  if (telegramNotifierTimeout) {
    clearTimeout(telegramNotifierTimeout);
    telegramNotifierTimeout = null;
  }
  if (!telegramToken || !telegramChatId) {
    console.warn(
      "[monitor] telegram notifier disabled (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)",
    );
    return;
  }
  if (!Number.isFinite(telegramIntervalMin) || telegramIntervalMin <= 0) {
    console.warn("[monitor] telegram notifier disabled (invalid interval)");
    return;
  }
  const intervalMs = telegramIntervalMin * 60 * 1000;
  const sendUpdate = async () => {
    const summary = await readStatusSummary();
    if (summary && summary.text) {
      // Push to the pinned status board (edits in-place) when available.
      // Fall back to a regular new message only if the board hasn't been set up.
      const routed = pushStatusBoardUpdate(summary.text, {
        parseMode: summary.parseMode,
      });
      if (!routed) {
        await sendTelegramMessage(summary.text, {
          parseMode: summary.parseMode,
          disablePreview: true,
        });
      }
    }
    await flushMergeNotifications();
    await checkStatusMilestones();
  };

  // Suppress "Notifier started" message on rapid restarts (e.g. code-change restarts).
  // If the last start was <60s ago, skip the notification — just log locally.
  const lastStartPath = resolve(
    repoRoot,
    ".cache",
    "ve-last-notifier-start.txt",
  );
  let suppressStartup = isSelfRestart;
  if (!suppressStartup) {
    try {
      const prev = await readFile(lastStartPath, "utf8");
      const elapsed = Date.now() - Number(prev);
      if (elapsed < 60_000) suppressStartup = true;
    } catch {
      /* first start or missing file */
    }
  }
  await writeFile(lastStartPath, String(Date.now())).catch(() => {});

  if (suppressStartup) {
    console.log(
      `[monitor] notifier restarted (suppressed telegram notification — rapid restart)`,
    );
  } else {
    runDetached("telegram-notifier:startup-message", () =>
      sendTelegramMessage(`${projectName} Orchestrator Notifier started.`),
    );
  }
  telegramNotifierTimeout = setTimeout(
    () => runDetached("telegram-notifier:timeout-update", sendUpdate),
    intervalMs,
  );
  telegramNotifierInterval = setInterval(
    () => runDetached("telegram-notifier:interval-update", sendUpdate),
    intervalMs,
  );
}

async function checkStatusMilestones() {
  const status = await readStatusData();
  if (!status) {
    return;
  }
  const counts = status.counts || {};
  const backlogRemaining = status.backlog_remaining ?? 0;
  const running = counts.running ?? 0;
  const review = counts.review ?? 0;
  const error = counts.error ?? 0;
  const localMaxParallel = getMaxParallelFromArgs(scriptArgs) || running || 1;

  // Fleet-aware capacity: use total fleet slots when fleet is active
  const fleet = fleetConfig?.enabled ? getFleetState() : null;
  const maxParallel =
    fleet && fleet.mode === "fleet" && fleet.totalSlots > 0
      ? fleet.totalSlots
      : localMaxParallel;
  const backlogPerCapita =
    maxParallel > 0 ? backlogRemaining / maxParallel : backlogRemaining;
  const idleSlots = Math.max(0, maxParallel - running);
  const staleTaskAgeHours = Number(process.env.STALE_TASK_AGE_HOURS || "24");
  const staleTaskCutoffMs =
    Date.now() - Math.max(1, staleTaskAgeHours) * 60 * 60 * 1000;
  const staleInProgressCount = (getInternalTasksByStatus("inprogress") || []).filter(
    (task) => {
      const updatedAt =
        Date.parse(task?.updated_at || task?.updatedAt || task?.meta?.updatedAt || 0) ||
        Date.parse(task?.created_at || task?.createdAt || 0);
      return Number.isFinite(updatedAt) && updatedAt > 0 && updatedAt <= staleTaskCutoffMs;
    },
  ).length;

  const triggerContext = {
    backlogRemaining,
    backlogPerCapita,
    running,
    review,
    error,
    idleSlots,
    maxParallel,
    staleInProgressCount,
  };

  await evaluateTriggerTemplates(triggerContext);

  // Fleet-aware backlog depth check: if fleet is active, check if we need
  // more tasks to keep all workstations busy
  if (fleet && fleet.mode === "fleet") {
    const depth = calculateBacklogDepth({
      totalSlots: fleet.totalSlots,
      currentBacklog: backlogRemaining,
      bufferMultiplier: fleetConfig?.bufferMultiplier || 3,
    });
    if (depth.shouldGenerate && depth.deficit > 0) {
      // Fleet deficit detected — trigger templates handle this now
    }

    // Maintenance mode detection
    const maintenance = detectMaintenanceMode({
      backlog_remaining: backlogRemaining,
      counts,
    });
    if (maintenance.isMaintenanceMode && isFleetCoordinator()) {
      if (!allCompleteNotified) {
        allCompleteNotified = true;
        await sendTelegramMessage(
          `:server: Fleet entering maintenance mode: ${maintenance.reason}`,
        );
      }
      return;
    }
  }

  if (
    !allCompleteNotified &&
    backlogRemaining === 0 &&
    running === 0 &&
    review === 0 &&
    error === 0
  ) {
    allCompleteNotified = true;
    await sendTelegramMessage(
      "All tasks completed. Orchestrator backlog is empty.",
    );
    return;
  }
}

function compareTriggerMetric(left, operator, right) {
  switch (String(operator || "eq").toLowerCase()) {
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
    case "neq":
      return left !== right;
    case "eq":
    default:
      return left === right;
  }
}

function getTriggerTemplateState(state, templateId) {
  const map = state?.trigger_templates;
  if (!map || typeof map !== "object") return null;
  return map[templateId] || null;
}

async function readTriggerState() {
  try {
    const raw = await readFile(triggerStatePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeTriggerState(state) {
  try {
    await mkdir(dirname(triggerStatePath), { recursive: true });
    await writeFile(triggerStatePath, JSON.stringify(state, null, 2));
  } catch {
    /* best effort */
  }
}

async function updateTriggerTemplateState(templateId, patch) {
  const current = (await readTriggerState()) || {};
  const templates =
    current.trigger_templates && typeof current.trigger_templates === "object"
      ? { ...current.trigger_templates }
      : {};
  templates[templateId] = {
    ...(templates[templateId] || {}),
    ...patch,
  };
  await writeTriggerState({
    ...current,
    trigger_templates: templates,
  });
}

function resolveTemplateMinIntervalMs(template) {
  const minIntervalMinutes = Number(template?.minIntervalMinutes || 0);
  if (Number.isFinite(minIntervalMinutes) && minIntervalMinutes > 0) {
    return minIntervalMinutes * 60 * 1000;
  }
  return 6 * 60 * 60 * 1000; // 6 hour default
}

function evaluateTemplateCondition(condition, context, lastSuccessMs) {
  if (!condition || typeof condition !== "object") return false;
  const kind = String(condition.kind || "metric").toLowerCase();
  if (kind === "interval") {
    const minutes = Number(condition.minutes || 0);
    if (!Number.isFinite(minutes) || minutes <= 0) return false;
    if (!Number.isFinite(lastSuccessMs) || lastSuccessMs <= 0) return true;
    return Date.now() - lastSuccessMs >= minutes * 60 * 1000;
  }
  const metric = String(condition.metric || "").trim();
  if (!metric || !(metric in context)) return false;
  const left = Number(context[metric]);
  const right = Number(condition.value);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return compareTriggerMetric(left, condition.operator, right);
}

async function evaluateTriggerTemplates(context) {
  const system = triggerSystemConfig || {};
  if (!system.enabled) return;
  const templates = Array.isArray(system.templates) ? system.templates : [];
  if (templates.length === 0) return;

  const state = (await readTriggerState()) || {};

  for (const template of templates) {
    if (!template || template.enabled !== true) continue;
    const templateId = String(template.id || template.name || "").trim();
    if (!templateId) continue;

    const templateState = getTriggerTemplateState(state, templateId);
    const lastSuccessMs = Date.parse(templateState?.last_success_at || 0);
    const minIntervalMs = resolveTemplateMinIntervalMs(template);
    if (Number.isFinite(lastSuccessMs) && lastSuccessMs > 0) {
      const elapsed = Date.now() - lastSuccessMs;
      if (elapsed < minIntervalMs) {
        continue;
      }
    }

    const rules = Array.isArray(template?.trigger?.anyOf)
      ? template.trigger.anyOf
      : [];
    if (rules.length === 0) continue;

    const shouldRun = rules.some((condition) =>
      evaluateTemplateCondition(condition, context, lastSuccessMs),
    );
    if (!shouldRun) continue;

    try {
      const action = String(template.action || "").toLowerCase();
      const templateConfig =
        template.config && typeof template.config === "object"
          ? template.config
          : {};
      const defaultExecutor =
        system.defaults && typeof system.defaults === "object"
          ? String(system.defaults.executor || "auto")
          : "auto";
      const defaultModel =
        system.defaults && typeof system.defaults === "object"
          ? String(system.defaults.model || "auto")
          : "auto";
      const executorOverride =
        String(templateConfig.executor || defaultExecutor || "auto").trim();
      const modelOverride =
        String(templateConfig.model || defaultModel || "auto").trim();

      if (action === "create-task") {
        const title = String(templateConfig.title || "").trim();
        if (!title) continue;
        const dedup = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        const existing = [
          ...(getInternalTasksByStatus("todo") || []),
          ...(getInternalTasksByStatus("inprogress") || []),
          ...(getInternalTasksByStatus("inreview") || []),
        ].some((task) => String(task?.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === dedup);
        if (!existing) {
          addInternalTask({
            id: randomUUID(),
            title,
            description: String(templateConfig.description || "").trim(),
            status: "todo",
            priority: String(templateConfig.priority || "").trim() || undefined,
            projectId: process.env.INTERNAL_EXECUTOR_PROJECT_ID || "internal",
            syncDirty: true,
            meta: {
              triggerTemplate: {
                id: templateId,
                source: "trigger-system",
                createdAt: new Date().toISOString(),
              },
              execution: {
                executor:
                  executorOverride && executorOverride !== "auto"
                    ? executorOverride
                    : undefined,
                model:
                  modelOverride && modelOverride !== "auto"
                    ? modelOverride
                    : undefined,
              },
            },
          });
        }
      }

      await updateTriggerTemplateState(templateId, {
        last_triggered_at: new Date().toISOString(),
        last_success_at: new Date().toISOString(),
        last_error: null,
      });
    } catch (err) {
      await updateTriggerTemplateState(templateId, {
        last_triggered_at: new Date().toISOString(),
        last_error: err?.message || String(err || "unknown"),
        last_failure_at: new Date().toISOString(),
      });
      console.warn(
        `[monitor] trigger template failed (${template?.id || template?.name || "unknown"}): ${err?.message || err}`,
      );
    }
  }
}

async function ensureLogDir() {
  await mkdir(logDir, { recursive: true });
}

/**
 * Truncate the log directory to stay within logMaxSizeMb.
 * Deletes oldest files first until total size is under the limit.
 * Returns { deletedCount, freedBytes, totalBefore, totalAfter }.
 */
async function truncateOldLogs() {
  if (!logMaxSizeMb || logMaxSizeMb <= 0)
    return { deletedCount: 0, freedBytes: 0 };
  const { readdir, stat: fsStat } = await import("node:fs/promises");
  const maxBytes = logMaxSizeMb * 1024 * 1024;
  let entries;
  try {
    entries = await readdir(logDir);
  } catch {
    return { deletedCount: 0, freedBytes: 0 };
  }
  // Gather file info
  const files = [];
  for (const name of entries) {
    const filePath = resolve(logDir, name);
    try {
      const s = await fsStat(filePath);
      if (s.isFile()) {
        files.push({ name, path: filePath, size: s.size, mtimeMs: s.mtimeMs });
      }
    } catch {
      /* skip inaccessible files */
    }
  }
  const totalBefore = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBefore <= maxBytes) {
    return {
      deletedCount: 0,
      freedBytes: 0,
      totalBefore,
      totalAfter: totalBefore,
    };
  }
  // Sort oldest first
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let currentSize = totalBefore;
  let deletedCount = 0;
  let freedBytes = 0;
  for (const f of files) {
    if (currentSize <= maxBytes) break;
    try {
      await unlink(f.path);
      currentSize -= f.size;
      freedBytes += f.size;
      deletedCount++;
    } catch {
      /* skip locked/active files */
    }
  }
  const totalAfter = currentSize;
  if (deletedCount > 0) {
    const mbFreed = (freedBytes / 1024 / 1024).toFixed(1);
    const mbAfter = (totalAfter / 1024 / 1024).toFixed(1);
    console.log(
      `[monitor] log rotation: deleted ${deletedCount} old log files, freed ${mbFreed} MB (${mbAfter} MB / ${logMaxSizeMb} MB limit)`,
    );
  }
  return { deletedCount, freedBytes, totalBefore, totalAfter };
}

async function finalizeActiveLog(activePath, archivePath) {
  try {
    await rename(activePath, archivePath);
  } catch {
    try {
      await copyFile(activePath, archivePath);
      await unlink(activePath);
    } catch {
      // Best effort only.
    }
  }
}

function nowStamp() {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function commandExists(cmd) {
  try {
    execSync(`${process.platform === "win32" ? "where" : "which"} ${cmd}`, {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function safeStringify(value) {
  const seen = new Set();
  try {
    return JSON.stringify(
      value,
      (key, val) => {
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) {
            return "[Circular]";
          }
          seen.add(val);
        }
        if (typeof val === "bigint") {
          return val.toString();
        }
        return val;
      },
      2,
    );
  } catch {
    return null;
  }
}

function formatCodexResult(result) {
  if (result === null || result === undefined) {
    return "";
  }
  if (typeof result === "string") {
    return result;
  }
  if (typeof result === "number" || typeof result === "boolean") {
    return String(result);
  }
  if (typeof result === "object") {
    const candidates = [
      result.finalResponse,
      result.output,
      result.text,
      result.message,
      result.content,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate;
      }
    }
    const serialized = safeStringify(result);
    if (serialized) {
      return serialized;
    }
  }
  return String(result);
}

async function analyzeWithCodex(logPath, logText, reason) {
  if (!codexEnabled) {
    return;
  }
  notifyCodexTrigger(`orchestrator analysis (${reason})`);

  // ── Build a workspace-aware prompt ────────────────────────────────────
  // The old approach used CodexClient SDK (chat-only, no file access).
  // The new approach uses `codex exec` with --full-auto so the agent can
  // actually read files, inspect git status, and give a real diagnosis.
  const logTail = logText.slice(-12000);
  const prompt = `You are diagnosing why the bosun orchestrator exited.
You have FULL READ ACCESS to the workspace. Use it.

## Context
- Exit reason: ${reason}
- Orchestrator script: ${scriptPath}
- Repository root: ${repoRoot}
- Active log file: ${logPath}
- Monitor script: scripts/bosun/monitor.mjs
- Git branch: ${(() => {
    try {
      return execSync("git branch --show-current", {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim();
    } catch {
      return "unknown";
    }
  })()}

## Log tail (last ~12k chars)
\`\`\`
${logTail}
\`\`\`

## Instructions
1. READ the orchestrator script (${scriptPath}) to understand the code flow
2. READ any relevant source files referenced in the log
3. Check git status/diff if relevant
4. Diagnose the ROOT CAUSE — not surface symptoms
5. Do NOT edit or create any files. Analysis only.
6. Common issues:
   - Path errors: worktree paths don't contain the orchestrator script
   - Mutex contention: multiple instances fighting over named mutex
   - API failures: wrong HTTP method, endpoint down, auth issues
   - Git rebase conflicts: agent branches conflict with main
   - Exit 64 / ENOENT: shell runtime can't locate the orchestrator target
   - SIGKILL: OOM or external termination
7. Return a SHORT, ACTIONABLE diagnosis with the concrete fix.`;

  try {
    // Use runCodexExec from autofix.mjs — gives Codex workspace access
    const result = await runCodexExec(prompt, repoRoot, 1_800_000);

    const analysisPath = logPath.replace(/\.log$/, "-analysis.txt");
    const analysisText = result.output || result.error || "(no output)";
    await writeFile(analysisPath, analysisText, "utf8");

    if (telegramToken && telegramChatId) {
      const summary = analysisText.slice(0, 500).replace(/\n{3,}/g, "\n\n");
      void sendTelegramMessage(
        `:search: Codex Analysis Result (${reason}):\n${summary}${analysisText.length > 500 ? "\n...(truncated)" : ""}`,
      );
    }
  } catch (err) {
    // Fallback: try the SDK chat approach if exec is unavailable
    try {
      if (!CodexClient) {
        const ready = await ensureCodexSdkReady();
        if (!ready) throw new Error(codexDisabledReason || "Codex SDK N/A");
      }
      const codex = new CodexClient(buildCodexSdkOptionsForMonitor());
      const thread = codex.startThread({ skipGitRepoCheck: true, workingDirectory: repoRoot, approvalPolicy: "never" });
      const result = await thread.run(prompt);
      const analysisPath = logPath.replace(/\.log$/, "-analysis.txt");
      const analysisText = formatCodexResult(result);
      await writeFile(analysisPath, analysisText, "utf8");
      if (telegramToken && telegramChatId) {
        const summary = analysisText.slice(0, 500).replace(/\n{3,}/g, "\n\n");
        void sendTelegramMessage(
          `:search: Codex Analysis Result (${reason}):\n${summary}${analysisText.length > 500 ? "\n...(truncated)" : ""}`,
        );
      }
    } catch (fallbackErr) {
      const analysisPath = logPath.replace(/\.log$/, "-analysis.txt");
      const message = fallbackErr?.message || String(fallbackErr);
      await writeFile(
        analysisPath,
        `Codex analysis failed: ${message}\n`,
        "utf8",
      );
      if (telegramToken && telegramChatId) {
        void sendTelegramMessage(`:search: Codex Analysis Failed: ${message}`);
      }
    }
  }
}

async function loadCodexSdk() {
  const result = await tryImportCodex();
  if (result) {
    return result;
  }

  const installResult = installDependencies();
  if (!installResult) {
    return null;
  }

  return await tryImportCodex();
}

async function tryImportCodex() {
  try {
    const mod = await import("@openai/" + "codex-sdk");
    return mod.Codex;
  } catch (err) {
    return null;
  }
}

function installDependencies() {
  const cwd = __dirname;
  const pnpm = spawnSync("pnpm", ["--version"], { stdio: "ignore" });
  if (pnpm.status === 0) {
    const res = spawnSync("pnpm", ["install"], { cwd, stdio: "inherit" });
    return res.status === 0;
  }

  const corepack = spawnSync("corepack", ["--version"], { stdio: "ignore" });
  if (corepack.status === 0) {
    const res = spawnSync("corepack", ["pnpm", "install"], {
      cwd,
      stdio: "inherit",
    });
    return res.status === 0;
  }

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const npm = spawnSync(npmCommand, ["install"], { cwd, stdio: "inherit" });
  return npm.status === 0;
}

async function ensureCodexSdkReady() {
  if (!codexEnabled) {
    return false;
  }
  const client = await loadCodexSdk();
  if (!client) {
    codexEnabled = false;
    codexDisabledReason =
      "Codex SDK not available (install failed or module missing)";
    console.warn(`[monitor] ${codexDisabledReason}`);
    return false;
  }
  CodexClient = client;
  return true;
}

function hasContextWindowError(text) {
  return contextPatterns.some((pattern) =>
    text.toLowerCase().includes(pattern.toLowerCase()),
  );
}

async function handleExit(code, signal, logPath) {
  if (shuttingDown) {
    return;
  }

  const logText = await readFile(logPath, "utf8").catch(() => "");
  const reason = signal ? `signal ${signal}` : `exit ${code}`;
  const isSigKill = signal === "SIGKILL";

  // ── Check if this is an intentional restart BEFORE clearing flags ──
  const isFileChangeRestart = pendingRestart && skipNextAnalyze;
  const isAbnormalExit = Boolean(signal) || code !== 0;
  const isCleanExit = !isAbnormalExit; // exit code 0, no signal

  if (pendingRestart) {
    pendingRestart = false;
    skipNextAnalyze = false;
    if (!skipNextRestartCount) {
      restartCount += 1;
    }
    skipNextRestartCount = false;

    // File-change restarts don't need analysis or auto-fix
    if (isFileChangeRestart) {
      console.log(
        `[monitor] intentional restart (${reason}) — skipping autofix`,
      );
      startProcess();
      return;
    }
  }

  // ── Track quick exits for crash-loop detection ──────────────────────
  const runDurationMs = restartController.lastProcessStartAt
    ? Date.now() - restartController.lastProcessStartAt
    : Infinity;

  // ── Mutex-held: orchestrator found another instance holding the mutex ──
  const isMutexHeld =
    restartController.mutexHeldDetected ||
    logText.includes("Another orchestrator instance is already running") ||
    logText.includes("mutex held");
  const exitState = restartController.recordExit(runDurationMs, isMutexHeld);

  if (exitState.backoffReset) {
    console.log("[monitor] orchestrator ran >20s — resetting mutex backoff");
  }

  if (exitState.isMutexHeld) {
    console.warn(
      `[monitor] mutex held detected — backing off ${exitState.backoffMs / 1000}s ` +
        `(consecutive quick exits: ${exitState.consecutiveQuickExits})`,
    );
    if (telegramToken && telegramChatId) {
      void sendTelegramMessage(
        `:clock: Mutex held — backing off ${exitState.backoffMs / 1000}s before retry`,
      );
    }
    restartCount += 1;
    scheduleStartProcess("handle-exit:mutex-held", exitState.backoffMs);
    return;
  }

  // ── External kill (SIGKILL): treat as non-actionable, restart quietly ──
  if (isSigKill) {
    console.warn(
      `[monitor] orchestrator killed by ${reason} — skipping autofix/analysis`,
    );
    restartCount += 1;
    scheduleStartProcess("handle-exit:sigkill", restartDelayMs);
    return;
  }

  // ── Benign exit 1: orchestrator ran normally but PowerShell propagated a
  // non-zero $LASTEXITCODE from the last native command (git/gh).  Detect by
  // checking that the log has no actual errors — just normal cycle messages.
  if (
    code === 1 &&
    !signal &&
    logText.length > 200 &&
    !logText.includes("ERROR") &&
    !logText.includes("FATAL") &&
    !logText.includes("Unhandled exception") &&
    (logText.includes("Sleeping") || logText.includes("next cycle"))
  ) {
    console.log(
      `[monitor] benign exit 1 detected (no errors in log, normal cycles) — restarting without autofix`,
    );
    restartCount += 1;
    scheduleStartProcess("handle-exit:benign-exit-1", restartDelayMs);
    return;
  }

  // ── Clean exit: skip autofix/analysis, handle backlog-empty gracefully ──
  if (isCleanExit) {
    const isEmptyBacklog =
      logText.includes("ALL TASKS COMPLETE") ||
      logText.includes("No more todo tasks in backlog") ||
      logText.includes("All tasks completed");

    if (isEmptyBacklog) {
      if (triggerSystemConfig?.enabled) {
        console.log(
          "[monitor] clean exit with empty backlog — triggering task planner",
        );
        await maybeTriggerTaskPlanner("backlog-empty-exit", {
          reason: "Orchestrator exited cleanly with empty backlog",
        });
      }
      // Wait before restarting so the planner has time to create tasks
      const plannerWaitMs = 2 * 60 * 1000; // 2 minutes
      console.log(
        `[monitor] waiting ${plannerWaitMs / 1000}s for planner before restart`,
      );
      scheduleStartProcess("handle-exit:planner-wait", plannerWaitMs);
      return;
    }

    // Other clean exits (e.g., Stop-Requested) — just restart normally
    console.log(
      `[monitor] clean exit (${reason}) — restarting without analysis`,
    );
    restartCount += 1;
    scheduleStartProcess("handle-exit:clean-exit", restartDelayMs);
    return;
  }

  // ── Auto-fix: runs in BACKGROUND only for genuine monitor/orchestrator crashes ──
  // STRICT trigger: only fire when the orchestrator ITSELF crashed (unhandled
  // exception, stack trace from our code, import error, etc.) — NOT when the
  // log merely contains "ERROR" from normal task lifecycle messages.
  //
  // If autofix writes changes, the devmode file watcher triggers a clean restart.
  // If no changes are needed, autofix just logs the outcome — no restart.
  const hasMonitorCrash =
    logText.includes("Unhandled exception") ||
    logText.includes("Unhandled rejection") ||
    logText.includes("SyntaxError:") ||
    logText.includes("ReferenceError:") ||
    logText.includes("TypeError:") ||
    logText.includes("Cannot find module") ||
    logText.includes("FATAL ERROR") ||
    logText.includes("Traceback (most recent call last)") ||
    // PowerShell internal crash
    logText.includes("TerminatingError") ||
    logText.includes("script block termination") ||
    // Very short runtime with high exit code = likely startup crash
    (code > 1 && runDurationMs < 30_000);

  if (autoFixEnabled && logText.length > 0 && hasMonitorCrash) {
    const telegramFn =
      telegramToken && telegramChatId
        ? (msg) => void sendTelegramMessage(msg)
        : null;

    // Fire-and-forget: autofix runs in background, orchestrator restarts now
    void (async () => {
      try {
        const result = await attemptAutoFix({
          logText: logText.slice(-15000),
          reason,
          repoRoot,
          logDir,
          onTelegram: telegramFn,
          recentMessages: getTelegramHistory(),
          promptTemplates: {
            autofixFix: agentPrompts?.autofixFix,
            autofixFallback: agentPrompts?.autofixFallback,
          },
        });

        if (result.fixed) {
          console.log(
            "[monitor] background auto-fix applied — file watcher will restart orchestrator if needed",
          );
          return;
        }

        if (result.outcome && result.outcome !== "clean-exit-skip") {
          console.log(
            `[monitor] background auto-fix outcome: ${result.outcome.slice(0, 100)}`,
          );
        }

        // Auto-fix couldn't help — run diagnostic analysis in background too
        console.log(
          "[monitor] auto-fix unsuccessful — running background Codex analysis",
        );
        await analyzeWithCodex(logPath, logText.slice(-15000), reason);
      } catch (err) {
        console.warn(
          `[monitor] background auto-fix error: ${err.message || err}`,
        );
      }
    })();
  } else if (autoFixEnabled && logText.length > 0 && !hasMonitorCrash) {
    // Not a monitor crash — normal exit with task errors. Skip autofix entirely.
    console.log(
      `[monitor] exit ${reason} — no monitor crash detected — skipping autofix`,
    );
  }

  // ── Context window exhaustion: attempt fresh session (non-blocking) ───
  if (hasContextWindowError(logText)) {
    console.log(
      "[monitor] context window exhaustion detected — attempting fresh session in background",
    );
    void (async () => {
      const freshStarted = await attemptFreshSessionRetry(
        "context_window_exhausted",
        logText.slice(-3000),
      );
      if (freshStarted) {
        console.log(
          "[monitor] fresh session started for context-exhausted task",
        );
      } else {
        await writeFile(
          logPath.replace(/\.log$/, "-context.txt"),
          "Detected context window error. Fresh session retry failed — consider manual recovery.\n",
          "utf8",
        );
      }
    })();
  }

  if (isAbnormalExit) {
    const restartCountNow = recordOrchestratorRestart();
    if (restartCountNow >= orchestratorRestartThreshold) {
      if (Date.now() >= orchestratorHaltedUntil) {
        orchestratorHaltedUntil = Date.now() + orchestratorPauseMs;
        const pauseMin = Math.round(orchestratorPauseMs / 60000);
        console.warn(
          `[monitor] crash loop detected (${restartCountNow} exits in 5m). Pausing orchestrator restarts for ${pauseMin}m.`,
        );
        if (!orchestratorResumeTimer) {
          orchestratorResumeTimer = safeSetTimeout("handle-exit:pause-resume", () => {
            orchestratorResumeTimer = null;
            runDetached("start-process:handle-exit-pause-resume", startProcess);
          }, orchestratorPauseMs);
        }
        if (telegramToken && telegramChatId) {
          void sendTelegramMessage(
            `:close: Crash loop detected (${restartCountNow} exits in 5m). Pausing orchestrator restarts for ${pauseMin} minutes. Background fix running.`,
          );
        }
        // ── Background crash-loop fix: runs while orchestrator is paused ──
        // Does NOT block handleExit. If it writes changes, file watcher restarts.
        // If it fails, the pause timer will restart the orchestrator anyway.
        if (!orchestratorLoopFixInProgress) {
          orchestratorLoopFixInProgress = true;
          void (async () => {
            try {
              const fixResult = await attemptCrashLoopFix({
                reason,
                logText,
              });
              if (fixResult.fixed) {
                console.log(
                  "[monitor] background crash-loop fix applied — file watcher will handle restart",
                );
                if (telegramToken && telegramChatId) {
                  void sendTelegramMessage(
                    `:u1f6e0: Crash-loop fix applied. File watcher will restart orchestrator.\n${fixResult.outcome}`,
                  );
                }
              } else {
                console.log(
                  `[monitor] background crash-loop fix unsuccessful: ${fixResult.outcome}`,
                );
                // Try fresh session as background last resort
                const freshStarted = await attemptFreshSessionRetry(
                  "crash_loop_unresolvable",
                  logText.slice(-3000),
                );
                if (freshStarted && telegramToken && telegramChatId) {
                  void sendTelegramMessage(
                    `:refresh: Crash-loop fix failed but fresh session started. New agent will retry.`,
                  );
                } else if (!freshStarted && telegramToken && telegramChatId) {
                  void sendTelegramMessage(
                    `:alert: Crash-loop fix failed: ${fixResult.outcome}. Orchestrator will resume after ${pauseMin}m pause.`,
                  );
                }
              }
            } catch (err) {
              console.warn(
                `[monitor] background crash-loop fix error: ${err.message || err}`,
              );
            } finally {
              orchestratorLoopFixInProgress = false;
            }
          })();
        }
      }
      return;
    }
  }

  if (maxRestarts > 0 && restartCount >= maxRestarts) {
    return;
  }

  const now = Date.now();
  if (now < orchestratorHaltedUntil || now < monitorSafeModeUntil) {
    const waitMs = Math.max(
      orchestratorHaltedUntil - now,
      monitorSafeModeUntil - now,
    );
    const waitSec = Math.max(5, Math.round(waitMs / 1000));
    console.warn(`[monitor] restart paused; retrying in ${waitSec}s`);
    scheduleStartProcess("handle-exit:restart-paused", waitSec * 1000);
    return;
  }

  restartCount += 1;
  scheduleStartProcess("handle-exit:default", restartDelayMs);
}

// ── Devmode Monitor-Monitor supervisor (24/7 + auto-resume + failover) ─────

function normalizeSdkName(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (raw.startsWith("copilot")) return "copilot";
  if (raw.startsWith("claude")) return "claude";
  if (raw.startsWith("codex")) return "codex";
  return raw;
}

function roleRank(role) {
  const raw = String(role || "")
    .trim()
    .toLowerCase();
  if (raw === "primary") return 0;
  if (raw === "backup") return 1;
  if (raw === "tertiary") return 2;
  const match = raw.match(/^executor-(\d+)$/);
  if (match) return 100 + Number(match[1]);
  return 50;
}

function buildMonitorMonitorSdkOrder() {
  const order = [];
  const seen = new Set();
  const add = (candidate) => {
    const sdk = normalizeSdkName(candidate);
    if (!["codex", "copilot", "claude"].includes(sdk)) return;
    if (seen.has(sdk)) return;
    seen.add(sdk);
    order.push(sdk);
  };

  add(primaryAgentName);

  const executors = Array.isArray(configExecutorConfig?.executors)
    ? [...configExecutorConfig.executors]
    : [];
  executors.sort((a, b) => roleRank(a?.role) - roleRank(b?.role));
  for (const profile of executors) {
    add(executorToSdk(profile?.executor));
  }

  for (const sdk of getAvailableSdks()) {
    add(sdk);
  }

  if (!order.length) {
    add("codex");
  }
  return order;
}

const monitorMonitor = {
  enabled: false,
  running: false,
  timer: null,
  statusTimer: null,
  startupCycleTimer: null,
  startupStatusTimer: null,
  intervalMs: 0,
  statusIntervalMs: 0,
  timeoutMs: 0,
  branch: "",
  sdkOrder: [],
  sdkIndex: 0,
  sdkFailures: new Map(),
  supervisorStartTimes: [],
  supervisorRestartCountWindow: 0,
  supervisorRestartLastWarnAt: 0,
  supervisorStartCountTotal: 0,
  supervisorLastStartedAt: 0,
  lastRunAt: 0,
  lastStatusAt: 0,
  lastStatusReason: "",
  lastStatusText: "",
  lastTrigger: "",
  lastOutcome: "",
  lastError: "",
  lastDigestText: "",
  lastAttemptAt: 0,
  lastAttemptTrigger: "",
  lastSkipAt: 0,
  lastSkipReason: "",
  skipStreak: 0,
  lastSkipStreakWarned: 0,
  lastSkipStreakWarnAt: 0,
  heartbeatAt: 0,
  consecutiveFailures: 0,
  abortController: null,
  _watchdogAbortCount: 0,
  _watchdogForceResetTimer: null,
};

function getCurrentMonitorSdk() {
  if (!monitorMonitor.sdkOrder.length) {
    monitorMonitor.sdkOrder = buildMonitorMonitorSdkOrder();
  }
  if (monitorMonitor.sdkIndex >= monitorMonitor.sdkOrder.length) {
    monitorMonitor.sdkIndex = 0;
  }
  return monitorMonitor.sdkOrder[monitorMonitor.sdkIndex] || "codex";
}

function rotateMonitorSdk(reason = "") {
  if (monitorMonitor.sdkOrder.length < 2) return false;
  monitorMonitor.sdkIndex =
    (monitorMonitor.sdkIndex + 1) % monitorMonitor.sdkOrder.length;
  const nextSdk = getCurrentMonitorSdk();
  console.warn(
    `[monitor-monitor] failover -> ${nextSdk}${reason ? ` (${reason})` : ""}`,
  );
  return true;
}

/**
 * Record a failure for a specific monitor-monitor SDK.
 * After 5 failures → 15min exclusion; after 10 failures → 60min exclusion.
 * @param {string} sdk
 */
function recordMonitorSdkFailure(sdk) {
  if (!sdk) return;
  const entry = monitorMonitor.sdkFailures.get(sdk) || {
    count: 0,
    excludedUntil: 0,
  };
  entry.count += 1;
  if (entry.count >= 10) {
    entry.excludedUntil = Date.now() + 60 * 60_000; // 60 min
    console.warn(
      `[monitor-monitor] ${sdk} excluded for 60min after ${entry.count} failures`,
    );
  } else if (entry.count >= 5) {
    entry.excludedUntil = Date.now() + 15 * 60_000; // 15 min
    console.warn(
      `[monitor-monitor] ${sdk} excluded for 15min after ${entry.count} failures`,
    );
  }
  monitorMonitor.sdkFailures.set(sdk, entry);
  rebuildMonitorSdkOrder();
}

/**
 * Clear failure count for a monitor-monitor SDK (on success).
 * @param {string} sdk
 */
function clearMonitorSdkFailure(sdk) {
  if (!sdk) return;
  if (monitorMonitor.sdkFailures.has(sdk)) {
    monitorMonitor.sdkFailures.delete(sdk);
    rebuildMonitorSdkOrder();
  }
}

/**
 * Check if a monitor-monitor SDK is currently excluded.
 * @param {string} sdk
 * @returns {boolean}
 */
function isMonitorSdkExcluded(sdk) {
  const entry = monitorMonitor.sdkFailures.get(sdk);
  if (!entry || !entry.excludedUntil) return false;
  if (Date.now() >= entry.excludedUntil) {
    // Exclusion expired — clear it
    entry.excludedUntil = 0;
    entry.count = 0;
    monitorMonitor.sdkFailures.set(sdk, entry);
    console.log(`[monitor-monitor] ${sdk} exclusion expired, re-enabling`);
    return false;
  }
  return true;
}

/**
 * Rebuild the SDK order excluding currently-excluded SDKs.
 * If all SDKs are excluded, force the primary back in.
 */
function rebuildMonitorSdkOrder() {
  const original = buildMonitorMonitorSdkOrder();
  const filtered = original.filter((sdk) => !isMonitorSdkExcluded(sdk));
  if (filtered.length === 0) {
    // All excluded — force primary back
    const primary = original[0] || "codex";
    console.warn(
      `[monitor-monitor] all SDKs excluded, forcing ${primary} back`,
    );
    monitorMonitor.sdkOrder = [primary];
  } else {
    monitorMonitor.sdkOrder = filtered;
  }
  // Reset index if out of bounds
  if (monitorMonitor.sdkIndex >= monitorMonitor.sdkOrder.length) {
    monitorMonitor.sdkIndex = 0;
  }
}

function shouldFailoverMonitorSdk(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return false;
  const patterns = [
    /rate.?limit/,
    /\b429\b/,
    /too many requests/,
    /quota/,
    /context window/,
    /context length/,
    /maximum context length/,
    /token limit/,
    /timeout/,
    /timed out/,
    /deadline exceeded/,
    /abort(?:ed|ing) due to timeout/,
    /\b500\b/,
    /\b502\b/,
    /\b503\b/,
    /\b504\b/,
    /server error/,
    /internal server error/,
    /gateway timeout/,
    /overloaded/,
    /temporarily unavailable/,
    /api error/,
    /econnreset/,
    /socket hang up/,
    /codex exec exited/,
    /reading prompt from stdin/,
    /exit code 3221225786/,
    /exit code 3221226505/,
    /exit code 1073807364/,
    /unexpected content type/,
    /streamable_http_client/,
    /memory allocation .* failed/,
    /allocation of .* bytes failed/,
    /serde error expected value/,
  ];
  return patterns.some((p) => p.test(text));
}

function formatElapsedMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m ago` : `${hr}h ago`;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

function buildMonitorMonitorStatusText(
  reason = "heartbeat",
  currentSdk = getCurrentMonitorSdk(),
) {
  const now = Date.now();
  const runAgeMs =
    monitorMonitor.running && Number.isFinite(monitorMonitor.heartbeatAt)
      ? now - monitorMonitor.heartbeatAt
      : null;
  const lastRun = monitorMonitor.lastRunAt
    ? formatElapsedMs(now - monitorMonitor.lastRunAt)
    : runAgeMs !== null
      ? `in progress (${formatDurationMs(runAgeMs)})`
      : "never";
  const lastStatus = monitorMonitor.lastStatusAt
    ? formatElapsedMs(now - monitorMonitor.lastStatusAt)
    : "first update";
  const lastOutcome =
    monitorMonitor.running &&
    String(monitorMonitor.lastOutcome || "").toLowerCase() === "not-started"
      ? "in-progress"
      : monitorMonitor.lastOutcome || "unknown";
  const lastDigestLine = String(monitorMonitor.lastDigestText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const lastAttemptTrigger =
    monitorMonitor.lastAttemptTrigger || monitorMonitor.lastTrigger || "";
  const lastAttempted =
    monitorMonitor.lastAttemptAt && Number.isFinite(monitorMonitor.lastAttemptAt)
      ? formatElapsedMs(now - monitorMonitor.lastAttemptAt)
      : "never";
  const lastSkipReason = String(monitorMonitor.lastSkipReason || "").trim();
  const lastSkipped =
    monitorMonitor.lastSkipAt && Number.isFinite(monitorMonitor.lastSkipAt)
      ? formatElapsedMs(now - monitorMonitor.lastSkipAt)
      : "never";
  const supervisorLastStarted =
    monitorMonitor.supervisorLastStartedAt &&
    Number.isFinite(monitorMonitor.supervisorLastStartedAt)
      ? formatElapsedMs(now - monitorMonitor.supervisorLastStartedAt)
      : "never";
  const supervisorRestartWindowMin = Math.max(
    1,
    Math.round(MONITOR_MONITOR_SUPERVISOR_RESTART_WARN_WINDOW_MS / 60_000),
  );
  const supervisorRestartCountWindow = Math.max(
    0,
    Number(monitorMonitor.supervisorRestartCountWindow || 0),
  );
  const supervisorRestartsUntilWarn = Math.max(
    0,
    Number(MONITOR_MONITOR_SUPERVISOR_RESTART_WARN_THRESHOLD || 0) -
      supervisorRestartCountWindow,
  );

  const lines = [
    ":server: Bosun-Monitor Update",
    `- Reason: ${reason}`,
    `- Running: ${monitorMonitor.running ? "yes" : "no"}`,
    `- Current SDK: ${currentSdk}`,
    `- SDK order: ${monitorMonitor.sdkOrder.join(" -> ") || "codex"}`,
    `- Last attempt trigger: ${lastAttemptTrigger || "n/a"} (${lastAttempted})`,
    `- Last skip: ${lastSkipReason || "none"} (${lastSkipped})`,
    `- Skip streak: ${Math.max(0, Number(monitorMonitor.skipStreak || 0))}`,
    `- Supervisor restarts (window ${supervisorRestartWindowMin}m): ${supervisorRestartCountWindow}`,
    `- Supervisor restarts until warn: ${supervisorRestartsUntilWarn}`,
    `- Supervisor starts: total=${Math.max(0, Number(monitorMonitor.supervisorStartCountTotal || 0))}, last=${supervisorLastStarted}`,
    `- Last trigger: ${monitorMonitor.lastTrigger || "n/a"}`,
    `- Last run: ${lastRun}`,
    `- Previous status: ${lastStatus}`,
    `- Consecutive failures: ${monitorMonitor.consecutiveFailures}`,
    `- Last outcome: ${lastOutcome}`,
  ];

  if (monitorMonitor.lastError) {
    lines.push(
      `- Last error: ${String(monitorMonitor.lastError).slice(0, 180)}`,
    );
  }
  if (lastDigestLine) {
    lines.push(`- Latest digest: ${lastDigestLine.slice(0, 180)}`);
  }
  return lines.join("\n");
}

async function publishMonitorMonitorStatus(reason = "heartbeat") {
  const now = Date.now();
  const statusSdk = getCurrentMonitorSdk();
  const text = buildMonitorMonitorStatusText(reason, statusSdk);
  const persistedStartupStatusAt =
    reason === "startup" ? readStartupStatusGateTs() : 0;
  const latestStartupStatusAt = Math.max(
    Number(monitorMonitor.lastStatusAt || 0),
    Number(persistedStartupStatusAt || 0),
  );
  const startupStatusSeenRecently =
    monitorMonitor.lastStatusReason === "startup" || persistedStartupStatusAt > 0;
  if (
    reason === "startup" &&
    startupStatusSeenRecently &&
    latestStartupStatusAt > 0 &&
    Number(monitorMonitor.lastRunAt || 0) <= latestStartupStatusAt &&
    now - latestStartupStatusAt < MONITOR_MONITOR_STARTUP_STATUS_MIN_GAP_MS
  ) {
    console.log(
      `[monitor-monitor] status (startup) skipped (duplicate within ${Math.round(MONITOR_MONITOR_STARTUP_STATUS_MIN_GAP_MS / 1000)}s)`,
    );
    return;
  }
  const prevStatusAt = monitorMonitor.lastStatusAt;
  const prevStatusReason = monitorMonitor.lastStatusReason;
  const prevStatusText = monitorMonitor.lastStatusText;
  monitorMonitor.lastStatusAt = now;
  monitorMonitor.lastStatusReason = reason;
  monitorMonitor.lastStatusText = text;
  try {
    if (telegramToken && telegramChatId) {
      await sendTelegramMessage(text, {
        dedupKey: `monitor-monitor-status-${reason}-${statusSdk}`,
        exactDedup: true,
        skipDedup: reason === "interval",
      });
    }
    if (reason === "startup") {
      writeStartupStatusGateTs(now);
    }
    console.log(
      `[monitor-monitor] status (${reason}) sdk=${statusSdk} failures=${monitorMonitor.consecutiveFailures}`,
    );
  } catch (err) {
    monitorMonitor.lastStatusAt = prevStatusAt;
    monitorMonitor.lastStatusReason = prevStatusReason;
    monitorMonitor.lastStatusText = prevStatusText;
    console.warn(
      `[monitor-monitor] status (${reason}) publish failed: ${err?.message || err}`,
    );
    throw err;
  }
}

async function readLogTail(
  filePath,
  { maxLines = 120, maxChars = 12000 } = {},
) {
  try {
    if (!existsSync(filePath)) {
      return `(missing: ${filePath})`;
    }
    const raw = await readFile(filePath, "utf8");
    const tail = raw.split(/\r?\n/).slice(-maxLines).join("\n");
    if (tail.length <= maxChars) return tail;

    // When maxChars cuts mid-line, drop the partial head fragment so monitor-
    // monitor does not ingest stale/truncated orphan text without timestamps.
    const sliced = tail.slice(-maxChars);
    const firstNl = sliced.indexOf("\n");
    if (firstNl <= 0) return sliced;
    return sliced.slice(firstNl + 1);
  } catch (err) {
    return `(unable to read ${filePath}: ${err.message || err})`;
  }
}

async function readLatestLogTail(
  dirPath,
  prefix,
  { maxLines = 120, maxChars = 12000 } = {},
) {
  try {
    const { readdir, stat } = await import("node:fs/promises");
    const entries = await readdir(dirPath);
    const candidates = entries.filter(
      (name) => name.startsWith(prefix) && name.endsWith(".log"),
    );
    if (!candidates.length) return null;
    const stats = await Promise.all(
      candidates.map(async (name) => {
        const path = resolve(dirPath, name);
        const info = await stat(path);
        return { name, path, mtimeMs: info.mtimeMs };
      }),
    );
    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const latest = stats[0];
    const tail = await readLogTail(latest.path, { maxLines, maxChars });
    return { name: latest.name, tail };
  } catch {
    return null;
  }
}

function formatDigestLines(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "(no digest entries)";
  }
  return entries
    .slice(-40)
    .map((entry) => {
      const time = entry?.time || "--:--:--";
      const emoji = entry?.emoji || "";
      const text = entry?.text || safeStringify(entry) || "(invalid entry)";
      return `${time} ${emoji} ${text}`.trim();
    })
    .join("\n");
}

function parseCsvList(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getMonitorClaudeAllowedTools() {
  const explicit = parseCsvList(
    process.env.DEVMODE_MONITOR_MONITOR_CLAUDE_ALLOWED_TOOLS,
  );
  if (explicit.length) return explicit;
  const standard = parseCsvList(process.env.CLAUDE_ALLOWED_TOOLS);
  if (standard.length) return standard;
  return [
    "Read",
    "Write",
    "Edit",
    "Grep",
    "Glob",
    "Bash",
    "WebSearch",
    "Task",
    "Skill",
  ];
}

function refreshMonitorMonitorRuntime() {
  const wasEnabled = monitorMonitor.enabled;
  const previousSdk = monitorMonitor.sdkOrder[monitorMonitor.sdkIndex] || null;

  monitorMonitor.enabled = isMonitorMonitorEnabled();
  monitorMonitor.intervalMs = Math.max(
    60_000,
    Number(
      process.env.DEVMODE_MONITOR_MONITOR_INTERVAL_MS ||
        process.env.DEVMODE_AUTO_CODE_FIX_CYCLE_INTERVAL ||
        "300000",
    ),
  );
  monitorMonitor.timeoutMs = resolveMonitorMonitorTimeoutMs();
  monitorMonitor.statusIntervalMs = Math.max(
    5 * 60_000,
    Number(process.env.DEVMODE_MONITOR_MONITOR_STATUS_INTERVAL_MS || "1800000"),
  );
  monitorMonitor.branch =
    process.env.DEVMODE_MONITOR_MONITOR_BRANCH ||
    process.env.DEVMODE_AUTO_CODE_FIX_BRANCH ||
    monitorMonitor.branch ||
    "";

  monitorMonitor.sdkOrder = buildMonitorMonitorSdkOrder();
  if (previousSdk) {
    const idx = monitorMonitor.sdkOrder.indexOf(previousSdk);
    monitorMonitor.sdkIndex = idx >= 0 ? idx : 0;
  } else {
    monitorMonitor.sdkIndex = 0;
  }

  if (wasEnabled !== monitorMonitor.enabled) {
    if (monitorMonitor.enabled) {
      console.log(
        `[monitor] monitor-monitor enabled (interval ${Math.round(monitorMonitor.intervalMs / 1000)}s, status ${Math.round(monitorMonitor.statusIntervalMs / 60_000)}m, timeout ${Math.round(monitorMonitor.timeoutMs / 1000)}s)`,
      );
    } else {
      console.log("[monitor] monitor-monitor disabled");
    }
  }
}

function snapshotMonitorMonitorRuntime() {
  return {
    enabled: !!monitorMonitor.enabled,
    intervalMs: Number(monitorMonitor.intervalMs || 0),
    statusIntervalMs: Number(monitorMonitor.statusIntervalMs || 0),
    timeoutMs: Number(monitorMonitor.timeoutMs || 0),
    branch: String(monitorMonitor.branch || ""),
    sdkOrder: Array.isArray(monitorMonitor.sdkOrder)
      ? [...monitorMonitor.sdkOrder]
      : [],
  };
}

function didMonitorMonitorRuntimeChange(previousRuntime) {
  const prev = previousRuntime && typeof previousRuntime === "object"
    ? previousRuntime
    : {
      enabled: false,
      intervalMs: 0,
      statusIntervalMs: 0,
      timeoutMs: 0,
      branch: "",
      sdkOrder: [],
    };
  const next = snapshotMonitorMonitorRuntime();
  if (
    prev.enabled !== next.enabled ||
    prev.intervalMs !== next.intervalMs ||
    prev.statusIntervalMs !== next.statusIntervalMs ||
    prev.timeoutMs !== next.timeoutMs ||
    prev.branch !== next.branch
  ) {
    return true;
  }
  if (prev.sdkOrder.length !== next.sdkOrder.length) {
    return true;
  }
  for (let i = 0; i < prev.sdkOrder.length; i += 1) {
    if (prev.sdkOrder[i] !== next.sdkOrder[i]) {
      return true;
    }
  }
  return false;
}

function getMonitorMonitorStatusSnapshot() {
  const currentSdk = getCurrentMonitorSdk();
  return {
    enabled: !!monitorMonitor.enabled,
    running: !!monitorMonitor.running,
    currentSdk,
    sdkOrder: [...(monitorMonitor.sdkOrder || [])],
    intervalMs: monitorMonitor.intervalMs,
    statusIntervalMs: monitorMonitor.statusIntervalMs,
    timeoutMs: monitorMonitor.timeoutMs,
    lastAttemptAt: monitorMonitor.lastAttemptAt || 0,
    lastAttemptTrigger: monitorMonitor.lastAttemptTrigger || "",
    lastSkipAt: monitorMonitor.lastSkipAt || 0,
    lastSkipReason: monitorMonitor.lastSkipReason || "",
    skipStreak: monitorMonitor.skipStreak || 0,
    lastSkipStreakWarned: monitorMonitor.lastSkipStreakWarned || 0,
    lastSkipStreakWarnAt: monitorMonitor.lastSkipStreakWarnAt || 0,
    supervisorRestartCountWindow:
      monitorMonitor.supervisorRestartCountWindow || 0,
    supervisorRestartLastWarnAt:
      monitorMonitor.supervisorRestartLastWarnAt || 0,
    supervisorRestartWarnWindowMs:
      MONITOR_MONITOR_SUPERVISOR_RESTART_WARN_WINDOW_MS,
    supervisorRestartWarnThreshold:
      MONITOR_MONITOR_SUPERVISOR_RESTART_WARN_THRESHOLD,
    supervisorRestartsUntilWarn: Math.max(
      0,
      Number(MONITOR_MONITOR_SUPERVISOR_RESTART_WARN_THRESHOLD || 0) -
        Number(monitorMonitor.supervisorRestartCountWindow || 0),
    ),
    supervisorStartCountTotal: monitorMonitor.supervisorStartCountTotal || 0,
    supervisorLastStartedAt: monitorMonitor.supervisorLastStartedAt || 0,
    lastRunAt: monitorMonitor.lastRunAt || 0,
    lastStatusAt: monitorMonitor.lastStatusAt || 0,
    lastTrigger: monitorMonitor.lastTrigger || "",
    lastOutcome: monitorMonitor.lastOutcome || "",
    consecutiveFailures: monitorMonitor.consecutiveFailures || 0,
    lastError: monitorMonitor.lastError || "",
  };
}

function resolveMonitorMonitorErrorTailWindowMs() {
  const intervalMs = Number(monitorMonitor?.intervalMs);
  const normalizedIntervalMs =
    Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 5 * 60_000;
  const defaultWindowMs = Math.max(
    10 * 60_000,
    Math.min(20 * 60_000, normalizedIntervalMs * 3),
  );
  const raw = Number(
    process.env.DEVMODE_MONITOR_MONITOR_ERROR_TAIL_WINDOW_MS ||
      String(defaultWindowMs),
  );
  if (!Number.isFinite(raw) || raw <= 0) return defaultWindowMs;
  return Math.max(60_000, raw);
}

function resolveMonitorMonitorStartupErrorTailWindowMs(baseWindowMs) {
  const base = Number.isFinite(Number(baseWindowMs)) && Number(baseWindowMs) > 0
    ? Number(baseWindowMs)
    : resolveMonitorMonitorErrorTailWindowMs();
  const raw = Number(
    process.env.DEVMODE_MONITOR_MONITOR_STARTUP_ERROR_TAIL_WINDOW_MS || "120000",
  );
  const startupWindow = Number.isFinite(raw) && raw > 0 ? raw : 120_000;
  return Math.max(30_000, Math.min(base, startupWindow));
}

function filterMonitorTailByRecency(tail, { windowMs } = {}) {
  const text = String(tail || "");
  if (!text) return text;

  const parsedWindow = Number(windowMs);
  if (!Number.isFinite(parsedWindow) || parsedWindow <= 0) return text;
  const cutoff = Date.now() - parsedWindow;

  const lines = text.split("\n");
  const blocks = [];
  let current = null;

  const flushCurrent = () => {
    if (!current) return;
    blocks.push(current);
    current = null;
  };

  for (const line of lines) {
    const currentLine = String(line || "");
    const tsMatch = currentLine.match(
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/,
    );
    if (tsMatch) {
      flushCurrent();
      const tsMs = Date.parse(tsMatch[1]);
      current = {
        tsMs: Number.isFinite(tsMs) ? tsMs : null,
        lines: [currentLine],
      };
      continue;
    }

    if (current) {
      current.lines.push(currentLine);
    } else {
      const trimmed = currentLine.trim();
      if (!trimmed) continue;

      // Keep only explicit diagnostics as orphan blocks. Untimestamped trailing
      // fragments are usually mid-line truncation artifacts and can surface stale
      // noise in monitor-monitor prompts.
      const isDiagnosticOrphan =
        /^\(missing:/.test(trimmed) ||
        /^\(unable to read /.test(trimmed) ||
        /^\[fallback:/.test(trimmed);
      if (isDiagnosticOrphan) {
        blocks.push({ tsMs: null, lines: [currentLine] });
      }
    }
  }
  flushCurrent();

  return blocks
    .filter((block) => block.tsMs === null || block.tsMs >= cutoff)
    .map((block) => block.lines.join("\n"))
    .join("\n")
    .trimEnd();
}

function sanitizeMonitorTailForPrompt(tail, backend) {
  return sanitizeMonitorTailForPromptShared(tail, backend);
}

function formatOrchestratorTailForMonitorPrompt({
  mode,
  activeKanbanBackend,
  orchestratorTail,
}) {
  try {
    const resolvedMode = String(mode || "unknown").trim().toLowerCase();
    const backendLabel = String(activeKanbanBackend || "unknown")
      .trim()
      .toLowerCase();
    if (
      mode === "internal" ||
      mode === "disabled" ||
      resolvedMode === "internal" ||
      resolvedMode === "disabled" ||
      resolvedMode === "none" ||
      resolvedMode === "monitor-only"
    ) {
      return (
        `(not applicable: executor mode "${resolvedMode}" runs without external orchestrator logs)` +
        ` [backend=${backendLabel}]`
      );
    }

    const tailText = String(orchestratorTail || "").trim();
    if (tailText) return tailText;

    return `(missing: orchestrator tail unavailable for mode "${resolvedMode}")`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `(missing: failed to format orchestrator tail: ${message})`;
  }
}

async function buildMonitorMonitorPrompt({ trigger, entries, text }) {
  const digestSnapshot = getDigestSnapshot();
  const digestEntries =
    Array.isArray(entries) && entries.length
      ? entries
      : digestSnapshot?.entries || [];
  const latestDigestText = String(text || monitorMonitor.lastDigestText || "");
  const actionableEntries = digestEntries.filter(
    (entry) => Number(entry?.priority || 99) <= 3,
  );
  const modeHint =
    actionableEntries.length > 0 ? "reliability-fix" : "code-analysis";
  const currentSdk = getCurrentMonitorSdk();
  const branchInstruction = monitorMonitor.branch
    ? `Work on branch ${monitorMonitor.branch}. Do not create a new branch.`
    : "Work on the current branch. Do not create a new branch.";

  const activeKanbanBackend = getActiveKanbanBackend();
  const runtimeExecutorMode = String(
    configExecutorMode || getExecutorMode() || "internal",
  )
    .trim()
    .toLowerCase();
  const usesExternalOrchestratorLog =
    runtimeExecutorMode !== "internal" && !isExecutorDisabled();
  let orchestratorTail = "";
  if (usesExternalOrchestratorLog) {
    orchestratorTail = await readLogTail(resolve(logDir, "orchestrator-active.log"), {
      maxLines: 140,
      maxChars: 14000,
    });
    if (orchestratorTail.startsWith("(missing:")) {
      const fallback = await readLatestLogTail(logDir, "orchestrator-", {
        maxLines: 140,
        maxChars: 14000,
      });
      if (fallback?.tail) {
        orchestratorTail = `[fallback: ${fallback.name}]\n${fallback.tail}`;
      } else {
        const defaultLogDir = resolve(__dirname, "logs");
        if (defaultLogDir !== logDir) {
          const alt = await readLatestLogTail(defaultLogDir, "orchestrator-", {
            maxLines: 140,
            maxChars: 14000,
          });
          if (alt?.tail) {
            orchestratorTail = `[fallback: ${alt.name}]\n${alt.tail}`;
          }
        }
      }
    }
  }
  orchestratorTail = formatOrchestratorTailForMonitorPrompt({
    mode: runtimeExecutorMode,
    activeKanbanBackend,
    orchestratorTail,
  });
  const monitorTailWindowMs = resolveMonitorMonitorErrorTailWindowMs();
  const effectiveMonitorTailWindowMs =
    String(trigger || "").trim().toLowerCase() === "startup"
      ? resolveMonitorMonitorStartupErrorTailWindowMs(monitorTailWindowMs)
      : monitorTailWindowMs;
  const rawMonitorTail = await readLogTail(resolve(logDir, "monitor-error.log"), {
    maxLines: 120,
    maxChars: 12000,
  });
  const recentMonitorTail = filterMonitorTailByRecency(rawMonitorTail, {
    windowMs: effectiveMonitorTailWindowMs,
  });
  const monitorTail = sanitizeMonitorTailForPrompt(
    recentMonitorTail,
    activeKanbanBackend,
  );
  const monitorTailForPrompt =
    String(monitorTail || "").trim() ||
    `(no recent monitor errors in last ${Math.round(effectiveMonitorTailWindowMs / 60_000)}m)`;

  const anomalyReport = getAnomalyStatusReport();
  const monitorPrompt = agentPrompts?.monitorMonitor || "";
  const claudeTools = getMonitorClaudeAllowedTools();

  return [
    monitorPrompt,
    "",
    "## Runtime Contract",
    "- You are running under monitor.mjs in devmode.",
    "- Fix reliability issues immediately; if smooth, perform code-analysis improvements.",
    "- Apply fixes directly in scripts/bosun and related prompt/config files.",
    "- Do not commit, push, or open PRs from this run.",
    `- ${branchInstruction}`,
    "",
    "## Orchestrator Requirements To Enforce",
    "- Monitor-Monitor must run continuously (24/7 in devmode).",
    "- If this run fails due to rate limit/API/context/server errors, next SDK must be used automatically.",
    "- Keep monitoring after each improvement; regressions must be fixed immediately.",
    "",
    "## Current Context",
    `- Trigger: ${trigger}`,
    `- Mode hint: ${modeHint}`,
    `- Current SDK slot: ${currentSdk}`,
    `- SDK failover order: ${monitorMonitor.sdkOrder.join(" -> ") || "codex"}`,
    `- Consecutive monitor failures: ${monitorMonitor.consecutiveFailures}`,
    `- Claude allowed tools: ${claudeTools.join(", ")}`,
    "",
    "## Live Digest (latest)",
    latestDigestText || "(no digest text)",
    "",
    "## Actionable Digest Entries",
    formatDigestLines(actionableEntries),
    "",
    "## Anomaly Report",
    anomalyReport || "(none)",
    "",
    "## Monitor Error Log Tail",
    monitorTailForPrompt,
    "",
    "## Orchestrator Log Tail",
    orchestratorTail,
    "",
    "## Deliverable",
    "1. Diagnose current reliability issues first and patch root causes.",
    "2. If no active reliability issue exists, implement one meaningful bosun quality/reliability improvement.",
    "3. Run focused validation commands for touched files.",
    "4. Summarize what changed and why.",
  ].join("\n");
}

function clearMonitorMonitorWatchdogTimer({ preserveRunning = false } = {}) {
  if (!monitorMonitor._watchdogForceResetTimer) return;
  if (preserveRunning && monitorMonitor.running) return;
  clearTimeout(monitorMonitor._watchdogForceResetTimer);
  monitorMonitor._watchdogForceResetTimer = null;
}

function recordMonitorMonitorSkip(reason = "unknown") {
  monitorMonitor.lastSkipReason = String(reason || "unknown");
  monitorMonitor.lastSkipAt = Date.now();
  const skipStreak = Math.max(
    0,
    Number(monitorMonitor.skipStreak || 0),
  ) + 1;
  monitorMonitor.skipStreak = skipStreak;
  const lastWarned = Math.max(
    0,
    Number(monitorMonitor.lastSkipStreakWarned || 0),
  );
  const now = Date.now();
  const lastWarnAt = Math.max(
    0,
    Number(monitorMonitor.lastSkipStreakWarnAt || 0),
  );
  if (skipStreak < MONITOR_MONITOR_SKIP_STREAK_WARN_THRESHOLD) return;
  if (
    lastWarned > 0 &&
    skipStreak - lastWarned < MONITOR_MONITOR_SKIP_STREAK_WARN_THRESHOLD
  ) {
    return;
  }
  if (
    lastWarnAt > 0 &&
    now - lastWarnAt < MONITOR_MONITOR_SKIP_STREAK_WARN_MIN_GAP_MS
  ) {
    return;
  }
  monitorMonitor.lastSkipStreakWarned = skipStreak;
  monitorMonitor.lastSkipStreakWarnAt = now;
  console.warn(
    `[monitor-monitor] skip streak ${skipStreak} (reason=${monitorMonitor.lastSkipReason}) while prior run is still active`,
  );
}

async function runMonitorMonitorCycle({
  trigger = "interval",
  entries = [],
  text = "",
} = {}) {
  refreshMonitorMonitorRuntime();
  if (!monitorMonitor.enabled) return;
  monitorMonitor.lastAttemptTrigger = trigger;
  monitorMonitor.lastAttemptAt = Date.now();

  if (monitorMonitor.running) {
    const heartbeatAt = Number(monitorMonitor.heartbeatAt || 0);
    const runAge =
      Number.isFinite(heartbeatAt) && heartbeatAt > 0
        ? Date.now() - heartbeatAt
        : Number.POSITIVE_INFINITY;
    const runStaleThresholdMs =
      monitorMonitor.timeoutMs + MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS;
    if (!monitorMonitor.abortController) {
      if (runAge > runStaleThresholdMs) {
        console.warn(
          `[monitor-monitor] force-resetting stale run without abort controller after ${Math.round(runAge / 1000)}s`,
        );
        monitorMonitor.running = false;
        monitorMonitor._watchdogAbortCount = 0;
        clearMonitorMonitorWatchdogTimer();
        monitorMonitor.consecutiveFailures += 1;
        recordMonitorSdkFailure(getCurrentMonitorSdk());
        monitorMonitor.lastOutcome = "force-reset (no-abort-controller)";
        monitorMonitor.lastError = `stale running=true without abort controller after ${Math.round(runAge / 1000)}s`;
      } else {
        recordMonitorMonitorSkip("running-no-abort-controller");
        return;
      }
    } else if (runAge > runStaleThresholdMs) {
      const watchdogCount = (monitorMonitor._watchdogAbortCount || 0) + 1;
      monitorMonitor._watchdogAbortCount = watchdogCount;
      console.warn(
        `[monitor-monitor] watchdog abort #${watchdogCount} after ${Math.round(runAge / 1000)}s (stuck run)`,
      );
      try {
        monitorMonitor.abortController.abort("watchdog-timeout");
      } catch {
        /* best effort */
      }
      // After 2 consecutive watchdog aborts (abort signal didn't kill the run),
      // force-reset the running flag so the next cycle can start fresh.
      if (watchdogCount >= 2) {
        console.warn(
          `[monitor-monitor] force-resetting stuck run after ${watchdogCount} watchdog aborts`,
        );
        monitorMonitor.running = false;
        monitorMonitor.abortController = null;
        monitorMonitor._watchdogAbortCount = 0;
        clearMonitorMonitorWatchdogTimer();
        monitorMonitor.consecutiveFailures += 1;
        recordMonitorSdkFailure(getCurrentMonitorSdk());
        monitorMonitor.lastOutcome = "force-reset (watchdog)";
        monitorMonitor.lastError = `watchdog force-reset after ${Math.round(runAge / 1000)}s`;
        // Don't return — allow the cycle to start fresh below
      } else {
        // Schedule an accelerated force-reset instead of waiting for
        // the next full interval cycle (which could be 5+ minutes away).
        // If the abort signal actually kills the run, the scheduled callback
        // will find monitorMonitor.running === false and no-op.
        if (!monitorMonitor._watchdogForceResetTimer) {
          const watchdogRunHeartbeatAt = Number(monitorMonitor.heartbeatAt || 0);
          monitorMonitor._watchdogForceResetTimer = setTimeout(() => {
            monitorMonitor._watchdogForceResetTimer = null;
            if (!monitorMonitor.running) return; // Already resolved
            // Ignore stale timer from an earlier run that already completed and
            // got replaced by a new run before this timeout fired.
            if (
              watchdogRunHeartbeatAt > 0 &&
              Number(monitorMonitor.heartbeatAt || 0) !== watchdogRunHeartbeatAt
            ) {
              return;
            }
            console.warn(
              `[monitor-monitor] accelerated force-reset — abort signal was ignored for ${Math.round(MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS / 1000)}s`,
            );
            monitorMonitor.running = false;
            monitorMonitor.abortController = null;
            monitorMonitor._watchdogAbortCount = 0;
            monitorMonitor.consecutiveFailures += 1;
            recordMonitorSdkFailure(getCurrentMonitorSdk());
            monitorMonitor.lastOutcome = "force-reset (watchdog-accelerated)";
            monitorMonitor.lastError = `watchdog accelerated force-reset after ${Math.round((Date.now() - monitorMonitor.heartbeatAt) / 1000)}s`;
          }, MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS);
        }
        recordMonitorMonitorSkip("running-watchdog-await");
        return;
      }
    } else {
      recordMonitorMonitorSkip("running-active");
      return;
    }
  }

  clearMonitorMonitorWatchdogTimer({ preserveRunning: true });
  monitorMonitor.lastTrigger = trigger;
  monitorMonitor.lastSkipReason = "";
  monitorMonitor.lastSkipAt = 0;
  monitorMonitor.skipStreak = 0;
  monitorMonitor.lastSkipStreakWarned = 0;
  monitorMonitor.lastSkipStreakWarnAt = 0;
  monitorMonitor.running = true;
  monitorMonitor.heartbeatAt = Date.now();
  monitorMonitor._watchdogAbortCount = 0;
  if (typeof text === "string" && text.trim()) {
    monitorMonitor.lastDigestText = text;
  }

  let prompt = "";
  try {
    prompt = await buildMonitorMonitorPrompt({ trigger, entries, text });
  } catch (err) {
    monitorMonitor.running = false;
    console.warn(
      `[monitor-monitor] prompt build failed: ${err.message || err}`,
    );
    return;
  }

  const runOnce = async (sdk) => {
    const abortController = new AbortController();
    monitorMonitor.abortController = abortController;
    return await launchOrResumeThread(
      prompt,
      repoRoot,
      monitorMonitor.timeoutMs,
      {
        taskKey: "monitor-monitor",
        sdk,
        abortController,
        claudeAllowedTools: getMonitorClaudeAllowedTools(),
      },
    );
  };

  const runLogDir = resolve(repoRoot, ".cache", "monitor-monitor-logs");
  try {
    await mkdir(runLogDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const sdkForLog = getCurrentMonitorSdk();
    await writeFile(
      resolve(
        runLogDir,
        `monitor-monitor-${stamp}-${trigger}-${sdkForLog}.prompt.md`,
      ),
      prompt,
      "utf8",
    );
  } catch {
    /* best effort */
  }

  let sdk = getCurrentMonitorSdk();
  let result;
  const runStartTime = Date.now();

  try {
    result = await runOnce(sdk);
    const runDuration = Math.round((Date.now() - runStartTime) / 1000);

    if (!result.success && shouldFailoverMonitorSdk(result.error)) {
      const canRotate = rotateMonitorSdk(result.error || "retryable failure");
      if (canRotate) {
        sdk = getCurrentMonitorSdk();
        const isTimeout = result.error?.includes("timeout");
        console.warn(
          `[monitor-monitor] retrying with ${sdk} (previous ${isTimeout ? "timeout" : "failure"} after ${runDuration}s)`,
        );
        result = await runOnce(sdk);
      }
    }

    if (result.success) {
      const totalDuration = Math.round((Date.now() - runStartTime) / 1000);
      monitorMonitor.consecutiveFailures = 0;
      clearMonitorSdkFailure(sdk);
      monitorMonitor.lastOutcome = `success (${sdk})`;
      monitorMonitor.lastError = "";
      console.log(
        `[monitor-monitor] cycle complete via ${sdk} in ${totalDuration}s${trigger ? ` (${trigger})` : ""}`,
      );
    } else {
      const totalDuration = Math.round((Date.now() - runStartTime) / 1000);
      monitorMonitor.consecutiveFailures += 1;
      recordMonitorSdkFailure(sdk);
      const errMsg = result.error || "unknown error";
      const isTimeout = errMsg.includes("timeout");
      monitorMonitor.lastOutcome = `failed (${sdk})`;
      monitorMonitor.lastError = errMsg;
      console.warn(
        `[monitor-monitor] run failed via ${sdk} after ${totalDuration}s${isTimeout ? " [TIMEOUT]" : ""}: ${errMsg}`,
      );
      if (shouldFailoverMonitorSdk(errMsg)) {
        rotateMonitorSdk("prepare next cycle");
      }
      runDetached("monitor-monitor:failure-notify", () =>
        notify?.(
          `:alert: Monitor-Monitor failed (${sdk}): ${String(errMsg).slice(0, 240)}`,
          3,
          { dedupKey: "monitor-monitor-failed" },
        ));
      try {
        await publishMonitorMonitorStatus("failure");
      } catch {
        /* best effort */
      }
    }
  } catch (runErr) {
    // Uncaught exception during execution (e.g. launchOrResumeThread threw)
    monitorMonitor.consecutiveFailures += 1;
    recordMonitorSdkFailure(sdk);
    const errMsg = String(runErr?.message || runErr || "unknown exception");
    monitorMonitor.lastOutcome = `exception (${sdk})`;
    monitorMonitor.lastError = errMsg;
    console.error(`[monitor-monitor] uncaught exception via ${sdk}: ${errMsg}`);
    runDetached("monitor-monitor:exception-notify", () =>
      notify?.(
        `:alert: Monitor-Monitor exception (${sdk}): ${errMsg.slice(0, 240)}`,
        3,
        { dedupKey: "monitor-monitor-exception" },
      ));
    if (shouldFailoverMonitorSdk(errMsg)) {
      rotateMonitorSdk("prepare next cycle (exception)");
    }
    try {
      await publishMonitorMonitorStatus("failure");
    } catch {
      /* best effort */
    }
  } finally {
    // CRITICAL: Always reset running flag, even if runOnce throws or times out
    clearMonitorMonitorWatchdogTimer();
    monitorMonitor.lastRunAt = Date.now();
    monitorMonitor.running = false;
    monitorMonitor.abortController = null;
  }
}

function startMonitorMonitorSupervisor() {
  refreshMonitorMonitorRuntime();
  if (!monitorMonitor.enabled) return;
  const now = Date.now();
  const restartWindowMs = Math.max(
    60_000,
    MONITOR_MONITOR_SUPERVISOR_RESTART_WARN_WINDOW_MS,
  );
  const recentStarts = Array.isArray(monitorMonitor.supervisorStartTimes)
    ? monitorMonitor.supervisorStartTimes.filter(
        (ts) => Number.isFinite(ts) && ts > 0 && now - ts <= restartWindowMs,
      )
    : [];
  recentStarts.push(now);
  monitorMonitor.supervisorStartTimes = recentStarts.slice(-200);
  monitorMonitor.supervisorRestartCountWindow = recentStarts.length;
  monitorMonitor.supervisorStartCountTotal = Math.max(
    0,
    Number(monitorMonitor.supervisorStartCountTotal || 0),
  ) + 1;
  monitorMonitor.supervisorLastStartedAt = now;
  if (
    recentStarts.length >= MONITOR_MONITOR_SUPERVISOR_RESTART_WARN_THRESHOLD &&
    now - Number(monitorMonitor.supervisorRestartLastWarnAt || 0) >= restartWindowMs
  ) {
    monitorMonitor.supervisorRestartLastWarnAt = now;
    console.warn(
      `[monitor] monitor-monitor supervisor restarted ${recentStarts.length} times within ${Math.round(restartWindowMs / 60_000)}m window`,
    );
  }

  if (monitorMonitor.timer) {
    clearInterval(monitorMonitor.timer);
    monitorMonitor.timer = null;
  }
  if (monitorMonitor.statusTimer) {
    clearInterval(monitorMonitor.statusTimer);
    monitorMonitor.statusTimer = null;
  }
  if (monitorMonitor.startupCycleTimer) {
    clearTimeout(monitorMonitor.startupCycleTimer);
    monitorMonitor.startupCycleTimer = null;
  }
  if (monitorMonitor.startupStatusTimer) {
    clearTimeout(monitorMonitor.startupStatusTimer);
    monitorMonitor.startupStatusTimer = null;
  }
  clearMonitorMonitorWatchdogTimer({ preserveRunning: true });

  monitorMonitor.timer = safeSetInterval("monitor-monitor-cycle", () => {
    if (shuttingDown) return;
    return runMonitorMonitorCycle({ trigger: "interval" });
  }, monitorMonitor.intervalMs);
  monitorMonitor.statusTimer = safeSetInterval("monitor-monitor-status", () => {
    if (shuttingDown) return;
    return publishMonitorMonitorStatus("interval");
  }, monitorMonitor.statusIntervalMs);

  console.log(
    `[monitor] monitor-monitor supervisor started (${Math.round(monitorMonitor.intervalMs / 1000)}s run interval, ${Math.round(monitorMonitor.statusIntervalMs / 60_000)}m status interval, sdk order: ${monitorMonitor.sdkOrder.join(" -> ")})`,
  );
  console.log(
    `[monitor] monitor-monitor startup gate: status-gap=${Math.round(MONITOR_MONITOR_STARTUP_STATUS_MIN_GAP_MS / 1000)}s jitter<=${Math.round(MONITOR_MONITOR_STARTUP_JITTER_MS / 1000)}s corrupt-retain=${MONITOR_MONITOR_STARTUP_STATUS_GATE_CORRUPT_MAX_FILES}`,
  );
  if (MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS >= monitorMonitor.intervalMs) {
    console.warn(
      `[monitor] monitor-monitor watchdog delay (${Math.round(MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS / 1000)}s) is >= run interval (${Math.round(monitorMonitor.intervalMs / 1000)}s); accelerated force-reset may not preempt the next scheduled cycle`,
    );
  }
  if (MONITOR_MONITOR_STARTUP_STATUS_DELAY_MS < MONITOR_MONITOR_STARTUP_CYCLE_DELAY_MS) {
    console.warn(
      `[monitor] monitor-monitor startup status delay (${Math.round(MONITOR_MONITOR_STARTUP_STATUS_DELAY_MS / 1000)}s) is below startup cycle delay (${Math.round(MONITOR_MONITOR_STARTUP_CYCLE_DELAY_MS / 1000)}s); startup status may post before first cycle begins`,
    );
  }
  const startupJitterMs =
    MONITOR_MONITOR_STARTUP_JITTER_MS > 0
      ? Math.floor(Math.random() * (MONITOR_MONITOR_STARTUP_JITTER_MS + 1))
      : 0;
  const startupCycleDelayEffectiveMs = Math.max(
    0,
    MONITOR_MONITOR_STARTUP_CYCLE_DELAY_MS + startupJitterMs,
  );
  const startupStatusDelayEffectiveMs = Math.max(
    0,
    MONITOR_MONITOR_STARTUP_STATUS_DELAY_MS + startupJitterMs,
  );
  let startupStatusDelayAdjustedMs = startupStatusDelayEffectiveMs;
  if (startupStatusDelayAdjustedMs < startupCycleDelayEffectiveMs) {
    startupStatusDelayAdjustedMs =
      startupCycleDelayEffectiveMs +
      Math.max(0, MONITOR_MONITOR_STARTUP_STATUS_AFTER_CYCLE_MIN_MS);
    console.warn(
      `[monitor] monitor-monitor startup status delay auto-adjusted to ${Math.round(startupStatusDelayAdjustedMs / 1000)}s to follow startup cycle (${Math.round(startupCycleDelayEffectiveMs / 1000)}s)`,
    );
  }
  if (startupJitterMs > 0) {
    console.log(
      `[monitor] monitor-monitor startup jitter applied: +${Math.round(startupJitterMs / 1000)}s (cycle=${Math.round(startupCycleDelayEffectiveMs / 1000)}s, status=${Math.round(startupStatusDelayAdjustedMs / 1000)}s)`,
    );
  }

  monitorMonitor.startupCycleTimer = safeSetTimeout("monitor-monitor-startup-cycle", () => {
    monitorMonitor.startupCycleTimer = null;
    if (shuttingDown) return;
    return runMonitorMonitorCycle({ trigger: "startup" });
  }, startupCycleDelayEffectiveMs);
  monitorMonitor.startupStatusTimer = safeSetTimeout("monitor-monitor-startup-status", () => {
    monitorMonitor.startupStatusTimer = null;
    if (shuttingDown) return;
    return publishMonitorMonitorStatus("startup");
  }, startupStatusDelayAdjustedMs);
}

function stopMonitorMonitorSupervisor({ preserveRunning = false } = {}) {
  if (monitorMonitor.timer) {
    clearInterval(monitorMonitor.timer);
    monitorMonitor.timer = null;
  }
  if (monitorMonitor.statusTimer) {
    clearInterval(monitorMonitor.statusTimer);
    monitorMonitor.statusTimer = null;
  }
  if (monitorMonitor.startupCycleTimer) {
    clearTimeout(monitorMonitor.startupCycleTimer);
    monitorMonitor.startupCycleTimer = null;
  }
  if (monitorMonitor.startupStatusTimer) {
    clearTimeout(monitorMonitor.startupStatusTimer);
    monitorMonitor.startupStatusTimer = null;
  }
  clearMonitorMonitorWatchdogTimer({ preserveRunning });
  // Only abort a running cycle if explicitly requested (hard shutdown).
  // During self-restart, preserve the running agent so it completes its work.
  if (!preserveRunning && monitorMonitor.abortController) {
    try {
      monitorMonitor.abortController.abort("monitor-shutdown");
    } catch {
      /* best effort */
    }
    monitorMonitor.abortController = null;
  }
  if (!preserveRunning) {
    monitorMonitor.running = false;
  }
}

function isHeartbeatMonitorEnabled() {
  if (isMonitorTestRuntime) return false;
  const raw = String(process.env.BOSUN_HEARTBEAT_MONITOR_ENABLED || "true")
    .trim()
    .toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

function restartHeartbeatMonitor() {
  heartbeatRuntimeState.current?.stop?.();
  heartbeatRuntimeState.current = null;

  if (!isHeartbeatMonitorEnabled()) return;
  const configDir = String(config?.configDir || "").trim();
  if (!configDir) return;

  heartbeatRuntimeState.current = createHeartbeatMonitor({
    configDir,
    logDir,
    intervalMs: Number(process.env.BOSUN_HEARTBEAT_INTERVAL_MS || 30_000),
    timeoutMs: Number(process.env.BOSUN_HEARTBEAT_TIMEOUT_MS || 5_000),
    successLogIntervalMs: Number(
      process.env.BOSUN_HEARTBEAT_SUCCESS_LOG_INTERVAL_MS || 10 * 60_000,
    ),
    eventLoopWarnMs: Number(process.env.BOSUN_HEARTBEAT_LAG_WARN_MS || 1000),
    logger: console,
  });
  heartbeatRuntimeState.current.start();
  console.log("[monitor] heartbeat monitor started");
}

function stopHeartbeatMonitor() {
  heartbeatRuntimeState.current?.stop?.();
  heartbeatRuntimeState.current = null;
}

/**
 * Called when a Live Digest window is sealed.
 * This provides fresh high-priority context and triggers an immediate run.
 */
async function handleDigestSealed({ entries, text }) {
  if (!monitorMonitor.enabled) return;

  const actionableEntries = (entries || []).filter(
    (entry) => Number(entry?.priority || 99) <= 3,
  );

  if (!actionableEntries.length) {
    if (typeof text === "string" && text.trim()) {
      monitorMonitor.lastDigestText = text;
    }
    return;
  }

  console.log(
    `[monitor-monitor] digest trigger (${actionableEntries.length} actionable entries)`,
  );
  runDetached("monitor-monitor:digest-trigger", () =>
    runMonitorMonitorCycle({
      trigger: "digest",
      entries: actionableEntries,
      text,
    }));
}

async function startProcess() {
  try {
    // Guard: never spawn orchestrator when executor mode is internal or disabled
    const execMode = configExecutorMode || getExecutorMode();
    if (execMode === "internal" || isExecutorDisabled()) {
      console.log(
        `[monitor] startProcess skipped — executor mode is "${execMode}" (orchestrator not needed)`,
      );
      try {
        await ensureLogDir();
        const backend = getActiveKanbanBackend();
        const activeLogPath = resolve(logDir, "orchestrator-active.log");
        const message =
          `[monitor] orchestrator inactive in executor mode "${execMode}" (backend=${backend})`;
        await writeFile(activeLogPath, `${message}\n`, "utf8");
      } catch {
        /* best effort */
      }
      return;
    }

    const now = Date.now();

  // ── Minimum restart interval — never restart faster than 15s ──────
  if (restartController.lastProcessStartAt > 0) {
    const sinceLast = now - restartController.lastProcessStartAt;
    const waitMs = restartController.getMinRestartDelay(now);
    if (waitMs > 0) {
      console.log(
        `[monitor] throttling restart — only ${Math.round(sinceLast / 1000)}s since last start, waiting ${Math.round(waitMs / 1000)}s`,
      );
      scheduleStartProcess("start-process:min-restart-delay", waitMs);
      return;
    }
  }

  if (now < orchestratorHaltedUntil || now < monitorSafeModeUntil) {
    const waitMs = Math.max(
      orchestratorHaltedUntil - now,
      monitorSafeModeUntil - now,
    );
    const waitSec = Math.max(5, Math.round(waitMs / 1000));
    console.warn(
      `[monitor] orchestrator start blocked; retrying in ${waitSec}s`,
    );
    scheduleStartProcess("start-process:halted-or-safe-mode", waitSec * 1000);
    return;
  }
  if (!(await ensurePreflightReady("start"))) {
    return;
  }
  await ensureLogDir();
  const activeLogPath = resolve(logDir, "orchestrator-active.log");
  const archiveLogPath = resolve(logDir, `orchestrator-${nowStamp()}.log`);
  const logStream = await writeFile(activeLogPath, "", "utf8").then(() => null);

  // ── Workspace monitor: initialize for this process session ──
  try {
    await workspaceMonitor.init();
  } catch (err) {
    console.warn(`[monitor] workspace monitor init failed: ${err.message}`);
  }

  // ── Agent log streaming: fan out per-attempt log lines to .cache/agent-logs/ ──
  const agentLogDir = resolve(repoRoot, ".cache", "agent-logs");
  try {
    await mkdir(agentLogDir, { recursive: true });
  } catch {
    /* best effort */
  }
  /** @type {Map<string, import('fs').WriteStream>} */
  const agentLogStreams = new Map();
  const AGENT_LOG_PATTERN =
    /\b([0-9a-f]{8})(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/i;

  /**
   * Stream a log line to the per-attempt log file if it contains an attempt short ID.
   * @param {string} line - The log line
   */
  function streamToAgentLog(line) {
    const match = line.match(AGENT_LOG_PATTERN);
    if (!match) return;
    const shortId = match[1].toLowerCase();
    // Filter out common false positives (git SHAs in non-attempt context)
    if (
      line.includes("HEAD") ||
      line.includes("commit ") ||
      line.includes("Deleted branch")
    ) {
      return;
    }
    const logPath = resolve(agentLogDir, `${shortId}.log`);
    try {
      appendFileSync(logPath, `${line}\n`);
    } catch {
      /* best effort — non-critical */
    }
  }

  // Guard: verify script exists before spawning to avoid cryptic exit 64
  if (!existsSync(scriptPath)) {
    console.error(
      `[monitor] orchestrator script not found: ${scriptPath}\n` +
        `  Set ORCHESTRATOR_SCRIPT to an absolute path or fix the relative path in .env`,
    );
    if (telegramToken && telegramChatId) {
      void sendTelegramMessage(
        `:close: Orchestrator script not found: ${scriptPath}\nSet ORCHESTRATOR_SCRIPT to a valid path.`,
      );
    }
    return;
  }

  // Reset mutex flag before spawn — will be re-set if this instance hits mutex
  restartController.noteProcessStarted(Date.now());

  const scriptLower = String(scriptPath).toLowerCase();
  let orchestratorCmd = scriptPath;
  let orchestratorArgs = [...scriptArgs];

  if (scriptLower.endsWith(".ps1")) {
    const pwshRuntime = resolvePwshRuntime({ preferBundled: true });
    if (!pwshRuntime.exists) {
      const pwshLabel =
        pwshRuntime.source === "env"
          ? `PWSH_PATH (${pwshRuntime.command})`
          : pwshRuntime.source === "bundled"
            ? `bundled pwsh (${pwshRuntime.command})`
            : pwshRuntime.source === "powershell"
              ? `powershell on PATH`
              : "pwsh on PATH";
      const pauseMs = Math.max(orchestratorPauseMs, 60_000);
      const pauseMin = Math.max(1, Math.round(pauseMs / 60_000));
      monitorSafeModeUntil = Math.max(monitorSafeModeUntil, Date.now() + pauseMs);
      console.error(
        `[monitor] .ps1 orchestrator selected but PowerShell runtime is unavailable (${pwshLabel}). ` +
          `Install PowerShell 7+ or set PWSH_PATH correctly. Pausing restarts for ${pauseMin}m.`,
      );
      if (telegramToken && telegramChatId) {
        void sendTelegramMessage(
          `:close: .ps1 orchestrator selected, but PowerShell runtime is unavailable (${pwshLabel}).\n` +
            `Install PowerShell 7+ or set PWSH_PATH to a valid executable path. ` +
            `Pausing restarts for ${pauseMin} minute(s).`,
        );
      }
      scheduleStartProcess("start-process:pwsh-runtime-missing", pauseMs);
      return;
    }
    orchestratorCmd = pwshRuntime.command;
    orchestratorArgs = ["-File", scriptPath, ...scriptArgs];
  } else if (scriptLower.endsWith(".sh")) {
    const shellCmd =
      process.platform === "win32"
        ? commandExists("bash")
          ? "bash"
          : commandExists("sh")
            ? "sh"
            : ""
        : commandExists("bash")
          ? "bash"
          : commandExists("sh")
            ? "sh"
            : "";
    if (!shellCmd) {
      console.error(
        "[monitor] shell-mode orchestrator selected (.sh) but no bash/sh runtime is available on PATH.",
      );
      if (telegramToken && telegramChatId) {
        void sendTelegramMessage(
          ":close: shell-mode orchestrator selected (.sh), but bash/sh is missing on PATH.",
        );
      }
      return;
    }
    orchestratorCmd = shellCmd;
    orchestratorArgs = [scriptPath, ...scriptArgs];
  }

  const child = spawn(orchestratorCmd, orchestratorArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  currentChild = child;

  const append = async (chunk) => {
    if (echoLogs) {
      try {
        shellWriteRaw(chunk);
      } catch {
        /* EPIPE — ignore */
      }
    }
    const text = chunk.toString();
    try {
      await writeFile(activeLogPath, text, { flag: "a" });
    } catch {
      /* log file write failed — ignore */
    }
    logRemainder += text;
    const lines = logRemainder.split(/\r?\n/);
    logRemainder = lines.pop() || "";
    for (const line of lines) {
      // ── Agent log streaming: fan out to per-attempt log files ──
      streamToAgentLog(line);

      // ── Workspace monitoring: detect attempt lifecycle from orchestrator logs ──
      const trackMatch = line.match(
        /Tracking new attempt:\s+([0-9a-f]{8})\s*→\s*(\S+)/i,
      );
      if (trackMatch) {
        const shortId = trackMatch[1];
        const branch = trackMatch[2];
        const worktreePath = findWorktreeForBranch(branch);
        if (worktreePath) {
          void workspaceMonitor
            .startMonitoring(shortId, worktreePath, {
              taskId: shortId,
              executor: "unknown",
              branch,
            })
            .catch((err) =>
              console.warn(
                `[workspace-monitor] failed to start for ${shortId}: ${err.message}`,
            ),
          );
        }
        if (
          typeof engine.load === "function" &&
          ((Array.isArray(reconcile?.updatedWorkflowIds) && reconcile.updatedWorkflowIds.length > 0) ||
            Number(reconcile?.metadataUpdated || 0) > 0)
        ) {
          engine.load();
        }
      }

      if (isErrorLine(line, errorPatterns, errorNoisePatterns)) {
        lastErrorLine = line;
        lastErrorAt = Date.now();
        notifyErrorLine(line);
      }
      if (line.includes("Merged PR") || line.includes("Marking task")) {
        notifyMerge(line);
      }
      if (line.includes("Merge notify: PR #")) {
        notifyMergeFailure(line);
      }
      // ── Mutex-held detection ─────────────────────────────────────
      restartController.noteLogLine(line);
      // ── Smart PR creation: detect completed/failed attempts ──────
      const prFlowMatch = line.match(
        /Attempt\s+([0-9a-f]{8})\s+finished\s+\((completed|failed)\)\s*[—–-]\s*marking review/i,
      );
      if (prFlowMatch) {
        const shortId = prFlowMatch[1];
        const finishStatus = prFlowMatch[2];
        void resolveAndTriggerSmartPR(shortId, finishStatus);
        // Stop workspace monitoring for this attempt
        void workspaceMonitor
          .stopMonitoring(shortId, finishStatus)
          .catch(() => {});
      }
      // ── "No remote branch" → trigger smart PR flow ──────────────
      const noBranchMatch = line.match(
        /No remote branch for (ve\/([0-9a-f]{4})-\S+)/i,
      );
      if (noBranchMatch) {
        const shortId = noBranchMatch[2]; // 4-char prefix
        runDetached("smart-pr:no-remote-branch", () =>
          resolveAndTriggerSmartPR(shortId, "no-remote-branch"));
      }
      if (line.includes("ALL TASKS COMPLETE")) {
        if (!allCompleteNotified) {
          allCompleteNotified = true;
          runDetached("orchestrator:all-complete-notify", () =>
            sendTelegramMessage(
              "All tasks completed. Orchestrator backlog is empty.",
            ));
          runDetached("orchestrator:all-complete-trigger-planner", () =>
            triggerTaskPlanner());
        }
      }
    }
  };

  child.stdout.on("data", (data) => append(data));
  child.stderr.on("data", (data) => append(data));
  // Prevent stream errors from bubbling up as uncaughtException
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});

  child.on("exit", (code, signal) => {
    if (currentChild === child) {
      currentChild = null;
    }
    finalizeActiveLog(activeLogPath, archiveLogPath).finally(() => {
      handleExit(code, signal, archiveLogPath);
    });
  });
  } catch (err) {
    reportGuardedFailure("startProcess", err);
    if (!shuttingDown) {
      const retryMs = Math.max(5_000, restartDelayMs || 0);
      safeSetTimeout("startProcess-retry", () => {
        if (!shuttingDown) runDetached("startProcess-retry", startProcess);
      }, retryMs);
    }
  }
}

function requestRestart(reason) {
  if (shuttingDown) {
    return;
  }
  if (pendingRestart) {
    return;
  }
  // ── Suppress file-change restarts during mutex backoff ──────────
  if (restartController.shouldSuppressRestart(reason)) {
    console.log(
      `[monitor] suppressing file-change restart — mutex backoff active (${restartController.mutexBackoffMs / 1000}s)`,
    );
    return;
  }
  pendingRestart = true;
  skipNextAnalyze = true;
  skipNextRestartCount = true;

  console.log(`[monitor] restart requested (${reason})`);
  if (currentChild) {
    currentChild.kill("SIGTERM");
    setTimeout(() => {
      if (currentChild && !currentChild.killed) {
        currentChild.kill("SIGKILL");
      }
    }, 5000);
  } else {
    pendingRestart = false;
    startProcess();
  }
}

/**
 * Perform a FULL Bosun restart triggered manually (e.g. via /restart on Telegram).
 * This exits monitor.mjs with SELF_RESTART_EXIT_CODE (75) so cli.mjs re-forks a
 * completely fresh monitor process — equivalent to Ctrl+C and restarting Bosun.
 *
 * Unlike requestRestart() which only restarts the agent child, this tears down
 * everything: agent child, telegram bot, agent endpoint, all watchers, then exits.
 * cli.mjs detects exit code 75 and spawns a fresh monitor.mjs from scratch.
 *
 * @param {string} [reason] - Label used for logging.
 */
function requestManualFullRestart(reason = "manual-telegram-restart") {
  if (shuttingDown) {
    console.log(`[monitor] full restart already in progress — ignoring duplicate request (${reason})`);
    return;
  }
  shuttingDown = true;
  console.log(`\n[monitor] FULL RESTART requested via Telegram (${reason})`);
  console.log("[monitor] shutting down all services before re-fork...");

  // Write self-restart marker so the new process suppresses duplicate startup notifications
  try {
    writeFileSync(
      resolve(repoRoot, ".cache", "ve-self-restart.marker"),
      String(Date.now()),
    );
  } catch {
    /* best effort */
  }

  const shutdownPromises = [];

  // Stop agent endpoint so new process can bind the port
  if (agentEndpoint) {
    shutdownPromises.push(
      Promise.resolve(agentEndpoint.stop()).catch((e) =>
        console.warn(`[monitor] endpoint stop error during full restart: ${e.message}`),
      ),
    );
  }

  stopAutoUpdateLoop();
  stopAgentAlertTailer();
  stopAgentWorkAnalyzer();
  stopSelfWatcher();
  stopWatcher();
  stopEnvWatchers();

  // Kill agent child
  if (currentChild) {
    currentChild.kill("SIGTERM");
    setTimeout(() => {
      if (currentChild && !currentChild.killed) {
        currentChild.kill("SIGKILL");
      }
    }, 3000);
  }

  void releaseTelegramPollLock();
  // NOTE: telegram bot is intentionally stopped AFTER this function returns so
  // the caller (cmdRestart) can send the final confirmation message first.
  // The 1.5 s delay below gives the bot time to flush the outbound message.
  setTimeout(() => {
    stopTelegramSurfaceAndBot({ preserveDigest: true });
    stopWhatsAppChannel();
    if (isContainerEnabled()) {
      void stopAllContainers().catch(() => {});
    }
    // Wait for async shutdowns, then exit with code 75 — cli.mjs re-forks cleanly
    Promise.allSettled(shutdownPromises).then(() => {
      setTimeout(() => process.exit(SELF_RESTART_EXIT_CODE), 400);
    });
    // Safety net: force exit after 10s even if shutdown hangs
    setTimeout(() => process.exit(SELF_RESTART_EXIT_CODE), 10000);
  }, 1500);
}

function stopWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  watcherDebounce = null;
  watchFileName = null;
}

// ── Self-monitor watcher: restart when own .mjs files change ─────────────────
function stopSelfWatcher() {
  if (selfWatcher) {
    selfWatcher.close();
    selfWatcher = null;
  }
  if (selfWatcherLib) {
    selfWatcherLib.close();
    selfWatcherLib = null;
  }
  for (const w of selfWatcherExtra) {
    try { w.close(); } catch {}
  }
  selfWatcherExtra = [];
  if (selfWatcherDebounce) {
    clearTimeout(selfWatcherDebounce);
    selfWatcherDebounce = null;
  }
  if (selfRestartTimer) {
    clearTimeout(selfRestartTimer);
    selfRestartTimer = null;
  }
  selfWatcherMtimes = new Map();
  pendingSelfRestart = null;
}

function snapshotSelfWatcherDirMtimes(rootDir) {
  if (!existsSync(rootDir)) return;
  try {
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      const entryPath = resolve(rootDir, entry.name);
      if (entry.isDirectory()) continue;
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".mjs")) continue;
      try {
        selfWatcherMtimes.set(entryPath, Number(statSync(entryPath).mtimeMs || 0));
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* best effort */
  }
}

function resolveSelfWatcherChangedPath(filename, watchedRoots = []) {
  const normalizedName = String(filename || "").trim();
  if (!normalizedName) return null;
  const isAbsolute = /^[a-zA-Z]:[\\/]|^\//.test(normalizedName);
  if (isAbsolute) {
    return resolve(normalizedName);
  }
  for (const rootDir of watchedRoots) {
    const candidate = resolve(rootDir, normalizedName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return watchedRoots.length > 0 ? resolve(watchedRoots[0], normalizedName) : resolve(normalizedName);
}

function formatSelfWatcherLabel(filePath) {
  const repoRoot = resolve(__dirname, "..");
  const normalized = resolve(String(filePath || ""));
  if (normalized.startsWith(`${repoRoot}\\`) || normalized.startsWith(`${repoRoot}/`)) {
    return normalized.slice(repoRoot.length + 1).replace(/\\/g, "/");
  }
  return normalized.replace(/\\/g, "/");
}

function getInternalActiveSlotCount() {
  try {
    if (!internalTaskExecutor) return 0;
    const status = internalTaskExecutor.getStatus?.();
    if (Number.isFinite(status?.activeSlots)) {
      return Number(status.activeSlots);
    }
    if (
      internalTaskExecutor._activeSlots &&
      Number.isFinite(internalTaskExecutor._activeSlots.size)
    ) {
      return Number(internalTaskExecutor._activeSlots.size);
    }
  } catch {
    /* best effort */
  }
  return 0;
}

function getActiveWorkflowRunSummaries() {
  try {
    if (!workflowAutomationEngine || typeof workflowAutomationEngine.getActiveRuns !== "function") {
      return [];
    }
    const activeRuns = workflowAutomationEngine.getActiveRuns();
    return Array.isArray(activeRuns) ? activeRuns.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function getActiveWorkflowRunCount() {
  return getActiveWorkflowRunSummaries().length;
}

function getRuntimeRestartProtection() {
  if (ALLOW_INTERNAL_RUNTIME_RESTARTS) {
    return { defer: false, reason: "" };
  }
  const execMode = configExecutorMode || getExecutorMode();
  if (execMode !== "internal" && execMode !== "hybrid") {
    return { defer: false, reason: "" };
  }
  const activeSlots = getInternalActiveSlotCount();
  if (activeSlots > 0) {
    return {
      defer: true,
      reason: `${activeSlots} internal task agent(s) active`,
    };
  }
  const activeWorkflowRuns = getActiveWorkflowRunCount();
  if (activeWorkflowRuns > 0) {
    return {
      defer: true,
      reason: `${activeWorkflowRuns} workflow run(s) active`,
    };
  }
  return { defer: false, reason: "" };
}

function getYoungActiveAgentRestartDeferralInfo(now = Date.now()) {
  if (SELF_RESTART_FORCE_ACTIVE_SLOT_MIN_AGE_MS <= 0) return null;
  if (!internalTaskExecutor || typeof internalTaskExecutor.getStatus !== "function") {
    return null;
  }
  try {
    const status = internalTaskExecutor.getStatus();
    const slots = Array.isArray(status?.slots) ? status.slots : [];
    const activeSlots = Math.max(0, Number(status?.activeSlots || slots.length || 0));
    if (activeSlots <= 0) return null;

    let oldestRunningMs = 0;
    for (const slot of slots) {
      let runningMs = 0;
      const runningForSec = Number(slot?.runningFor);
      const startedAt = Number(slot?.startedAt);
      if (Number.isFinite(runningForSec) && runningForSec >= 0) {
        runningMs = runningForSec * 1000;
      } else if (Number.isFinite(startedAt) && startedAt > 0) {
        runningMs = Math.max(0, now - startedAt);
      }
      oldestRunningMs = Math.max(oldestRunningMs, runningMs);
    }

    if (oldestRunningMs >= SELF_RESTART_FORCE_ACTIVE_SLOT_MIN_AGE_MS) {
      return null;
    }

    return {
      activeSlots,
      oldestRunningMs,
      minAgeMs: SELF_RESTART_FORCE_ACTIVE_SLOT_MIN_AGE_MS,
    };
  } catch {
    return null;
  }
}

function selfRestartForSourceChange(
  filename,
  { forceActiveAgentExit = false } = {},
) {
  pendingSelfRestart = null;

  // ── SAFETY NET: Double-check no agents are running before killing process ──
  // This should never trigger because attemptSelfRestartAfterQuiet() already
  // defers, but provides defense-in-depth against race conditions.
  const activeSlots = getInternalActiveSlotCount();
  const activeWorkflowRuns = getActiveWorkflowRunCount();
  if (activeSlots > 0 && !forceActiveAgentExit) {
    console.warn(
      `[monitor] SAFETY NET: selfRestartForSourceChange called with ${activeSlots} active agent(s)! Deferring instead of killing.`,
    );
    pendingSelfRestart = filename;
    selfRestartTimer = safeSetTimeout("self-restart-safety-net-retry", retryDeferredSelfRestart, 30_000);
    return;
  }
  if (activeWorkflowRuns > 0) {
    console.warn(
      `[monitor] SAFETY NET: selfRestartForSourceChange called with ${activeWorkflowRuns} active workflow run(s)! Deferring instead of killing.`,
    );
    pendingSelfRestart = filename;
    selfRestartTimer = safeSetTimeout("self-restart-safety-net-retry", retryDeferredSelfRestart, 30_000);
    return;
  }
  if (activeSlots > 0 && forceActiveAgentExit) {
    console.warn(
      `[monitor] FORCED self-restart: proceeding with ${activeSlots} active agent(s) after defer hard cap`,
    );
  }
  console.log(
    `\n[monitor] source files stable for ${Math.round(SELF_RESTART_QUIET_MS / 1000)}s — restarting (${filename})`,
  );
  console.log("[monitor] exiting for self-restart (fresh ESM modules)...");
  shuttingDown = true;
  // ── Agent isolation: by default, do NOT stop internal executor on self-restart ──
  // Task agents run as in-process SDK async iterators. Stopping the executor
  // during a normal restart is unnecessary because process.exit(75) kills them.
  // Forced restarts are different: request stop to reduce abrupt termination.
  const shutdownPromises = [];
  if (forceActiveAgentExit && internalTaskExecutor) {
    shutdownPromises.push(
      Promise.resolve(internalTaskExecutor.stop()).catch(() => {}),
    );
  }
  // Agent endpoint is lightweight — stop it so the new process can bind the port.
  if (agentEndpoint) {
    shutdownPromises.push(
      Promise.resolve(agentEndpoint.stop()).catch((e) =>
        console.warn(`[monitor] endpoint stop error: ${e.message}`),
      ),
    );
  }
  stopAutoUpdateLoop();
  stopAgentAlertTailer();
  stopAgentWorkAnalyzer();
  stopSelfWatcher();
  stopWatcher();
  stopEnvWatchers();
  if (currentChild) {
    currentChild.kill("SIGTERM");
    setTimeout(() => {
      if (currentChild && !currentChild.killed) {
        currentChild.kill("SIGKILL");
      }
    }, 3000);
  }
  runDetachedDuringShutdown("poll-lock-release:self-restart-source-change", () =>
    releaseTelegramPollLock(),
  );
  stopTelegramSurfaceAndBot({ preserveDigest: true });
  stopWhatsAppChannel();
  if (isContainerEnabled()) {
    runDetachedDuringShutdown("containers-stop:self-restart-source-change", () =>
      stopAllContainers(),
    );
  }
  // Write self-restart marker so the new process suppresses startup notifications
  try {
    writeFileSync(
      resolve(repoRoot, ".cache", "ve-self-restart.marker"),
      String(Date.now()),
    );
  } catch {
    /* best effort */
  }
  // Wait for executor/endpoint shutdown, then exit
  Promise.allSettled(shutdownPromises).then(() => {
    // Exit with special code — cli.mjs re-forks with fresh module cache
    setTimeout(() => process.exit(SELF_RESTART_EXIT_CODE), 500);
  });
  // Safety net: exit after 10s even if shutdown hangs
  setTimeout(() => process.exit(SELF_RESTART_EXIT_CODE), 10000);
}

function attemptSelfRestartAfterQuiet() {
  if (selfRestartTimer) {
    clearTimeout(selfRestartTimer);
    selfRestartTimer = null;
  }
  if (!selfRestartLastChangeAt) return;
  const now = Date.now();
  const sinceLastChange = now - selfRestartLastChangeAt;
  if (sinceLastChange < SELF_RESTART_QUIET_MS) {
    const waitMs = SELF_RESTART_QUIET_MS - sinceLastChange;
    selfRestartTimer = safeSetTimeout("self-restart-quiet-wait", attemptSelfRestartAfterQuiet, waitMs);
    return;
  }
  const filename = selfRestartLastFile || "unknown";
  const protection = getRuntimeRestartProtection();
  if (protection.defer) {
    pendingSelfRestart = filename;
    if (!selfRestartFirstDeferredAt) {
      selfRestartFirstDeferredAt = now;
    }
    const deferCount = (selfRestartDeferCount =
      (selfRestartDeferCount || 0) + 1);
    const deferElapsedMs = Math.max(0, now - selfRestartFirstDeferredAt);
    const retrySec = Math.round(SELF_RESTART_RETRY_MS / 1000);
    const hitCountCap = deferCount >= SELF_RESTART_DEFER_HARD_CAP;
    const hitTimeCap = deferElapsedMs >= SELF_RESTART_MAX_DEFER_MS;

    // Hard caps: after too many deferrals or too much deferred time the
    // active agent is likely stuck. Force-stop and restart so changes apply.
    // Workflow-owned runs are different: restarting the monitor tears down
    // real backlog work, so keep deferring until the workflow run clears.
    if (hitCountCap || hitTimeCap) {
      const activeWorkflowRuns = getActiveWorkflowRunCount();
      if (activeWorkflowRuns > 0) {
        console.warn(
          `[monitor] self-restart deferred ${deferCount} times over ${Math.round(deferElapsedMs / 1000)}s while waiting for ${activeWorkflowRuns} active workflow run(s) — continuing to defer until workflow work clears`,
        );
        selfRestartTimer = safeSetTimeout(
          "self-restart-deferred-retry",
          retryDeferredSelfRestart,
          SELF_RESTART_RETRY_MS,
        );
        return;
      }

      const youngAgentInfo = getYoungActiveAgentRestartDeferralInfo(now);
      if (youngAgentInfo) {
        console.warn(
          `[monitor] self-restart defer cap reached, but ${youngAgentInfo.activeSlots} active agent(s) are still young (oldest ${Math.round(youngAgentInfo.oldestRunningMs / 1000)}s < ${Math.round(youngAgentInfo.minAgeMs / 1000)}s). Extending defer window.`,
        );
        selfRestartDeferCount = 0;
        selfRestartFirstDeferredAt = now;
        selfRestartTimer = safeSetTimeout(
          "self-restart-deferred-retry",
          retryDeferredSelfRestart,
          SELF_RESTART_RETRY_MS,
        );
        return;
      }

      const elapsedSec = Math.max(1, Math.round(deferElapsedMs / 1000));
      const capReason = hitCountCap
        ? `hard cap ${SELF_RESTART_DEFER_HARD_CAP}`
        : `max defer ${Math.round(SELF_RESTART_MAX_DEFER_MS / 1000)}s`;
      console.warn(
        `[monitor] self-restart deferred ${deferCount} times over ${elapsedSec}s (${capReason}) — force-stopping active agents and restarting`,
      );
      selfRestartDeferCount = 0;
      selfRestartFirstDeferredAt = 0;
      selfRestartForSourceChange(filename, { forceActiveAgentExit: true });
      return;
    }

    if (deferCount % 20 === 0) {
      console.warn(
        `[monitor] self-restart deferred ${deferCount} times over ${Math.round(deferElapsedMs / 1000)}s — still waiting for ${protection.reason}; continuing to defer (caps: count=${SELF_RESTART_DEFER_HARD_CAP}, time=${Math.round(SELF_RESTART_MAX_DEFER_MS / 1000)}s)`,
      );
    }
    console.log(
      `[monitor] deferring self-restart (${filename}) — ${protection.reason}; retrying in ${retrySec}s (defer #${deferCount})`,
    );
    selfRestartTimer = safeSetTimeout(
      "self-restart-deferred-retry",
      retryDeferredSelfRestart,
      SELF_RESTART_RETRY_MS,
    );
    return;
  }
  selfRestartDeferCount = 0;
  selfRestartFirstDeferredAt = 0;

  // ── Agent isolation: defer restart if task agents are actively running ──
  // Task agents run inside this process. If we exit now, all running agents
  // die and their work is lost. Wait for them to finish naturally.
  if (internalTaskExecutor) {
    const status = internalTaskExecutor.getStatus();
    if (status.activeSlots > 0) {
      if (!selfRestartFirstDeferredAt) {
        selfRestartFirstDeferredAt = now;
      }
      const deferCount = (selfRestartDeferCount =
        (selfRestartDeferCount || 0) + 1);
      const deferElapsedMs = Math.max(0, now - selfRestartFirstDeferredAt);
      const hitCountCap = deferCount >= SELF_RESTART_DEFER_HARD_CAP;
      const hitTimeCap = deferElapsedMs >= SELF_RESTART_MAX_DEFER_MS;
      if (hitCountCap || hitTimeCap) {
        const youngAgentInfo = getYoungActiveAgentRestartDeferralInfo(now);
        if (youngAgentInfo) {
          console.warn(
            `[monitor] self-restart deferred ${deferCount} times over ${Math.round(deferElapsedMs / 1000)}s while waiting for active agents, but ${youngAgentInfo.activeSlots} agent(s) are still young (oldest ${Math.round(youngAgentInfo.oldestRunningMs / 1000)}s < ${Math.round(youngAgentInfo.minAgeMs / 1000)}s). Extending defer window.`,
          );
          selfRestartDeferCount = 0;
          selfRestartFirstDeferredAt = now;
          selfRestartTimer = safeSetTimeout(
            "self-restart-agent-wait-retry",
            attemptSelfRestartAfterQuiet,
            60_000,
          );
          return;
        }

        console.warn(
          `[monitor] self-restart deferred ${deferCount} times over ${Math.round(deferElapsedMs / 1000)}s while waiting for active agents — restarting anyway`,
        );
        selfRestartDeferCount = 0;
        selfRestartFirstDeferredAt = 0;
        selfRestartForSourceChange(filename, { forceActiveAgentExit: true });
        return;
      }
      const slotNames = (status.slots || []).map((s) => s.taskTitle).join(", ");
      console.log(
        `[monitor] self-restart deferred — ${status.activeSlots} agent(s) still running: ${slotNames}`,
      );
      console.log(
        `[monitor] will retry restart in 60s (agents must finish first)` +
          ` (defer #${deferCount}, elapsed ${Math.round(deferElapsedMs / 1000)}s)`,
      );
      selfRestartTimer = safeSetTimeout("self-restart-agent-wait-retry", attemptSelfRestartAfterQuiet, 60_000);
      return;
    }
  }

  const activeWorkflowRuns = getActiveWorkflowRunSummaries();
  if (activeWorkflowRuns.length > 0) {
    if (!selfRestartFirstDeferredAt) {
      selfRestartFirstDeferredAt = now;
    }
    const deferCount = (selfRestartDeferCount =
      (selfRestartDeferCount || 0) + 1);
    const deferElapsedMs = Math.max(0, now - selfRestartFirstDeferredAt);
    const hitCountCap = deferCount >= SELF_RESTART_DEFER_HARD_CAP;
    const hitTimeCap = deferElapsedMs >= SELF_RESTART_MAX_DEFER_MS;
    if (hitCountCap || hitTimeCap) {
      console.warn(
        `[monitor] self-restart deferred ${deferCount} times over ${Math.round(deferElapsedMs / 1000)}s while waiting for active workflow runs — continuing to defer until workflow work clears`,
      );
      selfRestartTimer = safeSetTimeout(
        "self-restart-workflow-wait-retry",
        attemptSelfRestartAfterQuiet,
        60_000,
      );
      return;
    }
    const runNames = activeWorkflowRuns
      .slice(0, 5)
      .map((run) => String(run?.workflowName || run?.runId || "workflow").trim())
      .filter(Boolean)
      .join(", ");
    console.log(
      `[monitor] self-restart deferred — ${activeWorkflowRuns.length} workflow run(s) still active: ${runNames}`,
    );
    console.log(
      `[monitor] will retry restart in 60s (workflow runs must finish first)` +
        ` (defer #${deferCount}, elapsed ${Math.round(deferElapsedMs / 1000)}s)`,
    );
    selfRestartTimer = safeSetTimeout("self-restart-workflow-wait-retry", attemptSelfRestartAfterQuiet, 60_000);
    return;
  }

  selfRestartDeferCount = 0;
  selfRestartFirstDeferredAt = 0;
  selfRestartForSourceChange(filename);
}

function queueSelfRestart(filename) {
  selfRestartLastChangeAt = Date.now();
  selfRestartLastFile = filename;
  selfRestartDeferCount = 0;
  selfRestartFirstDeferredAt = 0;
  if (selfRestartTimer) {
    clearTimeout(selfRestartTimer);
  }
  console.log(
    `\n[monitor] source file changed: ${filename} — waiting ${Math.round(SELF_RESTART_QUIET_MS / 1000)}s for quiet before restart`,
  );
  selfRestartTimer = safeSetTimeout(
    "self-restart-queue",
    attemptSelfRestartAfterQuiet,
    SELF_RESTART_QUIET_MS,
  );
}

function retryDeferredSelfRestart() {
  if (!pendingSelfRestart) return;
  selfRestartLastFile = pendingSelfRestart;
  selfRestartLastChangeAt = Date.now() - SELF_RESTART_QUIET_MS;
  attemptSelfRestartAfterQuiet();
}

function startSelfWatcher() {
  stopSelfWatcher();
  if (!watchEnabled) {
    return;
  }
  try {
    const watchedRootPaths = [];
    const handleSourceChange = (_event, filename) => {
      // Only react to .mjs source files
      if (!filename || !filename.endsWith(".mjs")) return;
      // Ignore node_modules and log artifacts
      if (filename.includes("node_modules")) return;
      const fullPath = resolveSelfWatcherChangedPath(filename, watchedRootPaths);
      if (!fullPath) return;
      let newMtime = 0;
      try {
        newMtime = Number(statSync(fullPath).mtimeMs || 0);
      } catch {
        return;
      }
      const prevMtime = Number(selfWatcherMtimes.get(fullPath) || 0);
      if (newMtime <= prevMtime) {
        return;
      }
      selfWatcherMtimes.set(fullPath, newMtime);
      const restartLabel = formatSelfWatcherLabel(fullPath);
      if (selfWatcherDebounce) {
        clearTimeout(selfWatcherDebounce);
      }
      selfWatcherDebounce = safeSetTimeout("self-watcher-debounce", () => {
        queueSelfRestart(restartLabel);
      }, 1000);
    };
    selfWatcher = watch(__dirname, { persistent: true }, handleSourceChange);
    watchedRootPaths.push(__dirname);
    snapshotSelfWatcherDirMtimes(__dirname);
    const libDir = resolve(__dirname, "lib");
    if (existsSync(libDir)) {
      selfWatcherLib = watch(libDir, { persistent: true }, handleSourceChange);
      watchedRootPaths.push(libDir);
      snapshotSelfWatcherDirMtimes(libDir);
    }
    // Watch sibling source directories that contain runtime-critical modules
    const repoRoot = resolve(__dirname, "..");
    const siblingDirs = ["task", "workspace", "workflow", "workflow-templates", "agent", "shell", "kanban", "github", "config"];
    const watchedDirs = ["infra/", "infra/lib/"];
    for (const dir of siblingDirs) {
      const dirPath = resolve(repoRoot, dir);
      if (existsSync(dirPath)) {
        try {
          selfWatcherExtra.push(watch(dirPath, { persistent: true }, handleSourceChange));
          watchedRootPaths.push(dirPath);
          snapshotSelfWatcherDirMtimes(dirPath);
          watchedDirs.push(`${dir}/`);
        } catch {}
      }
    }
    console.log(`[monitor] watching source files for self-restart: ${watchedDirs.join(", ")}`);
  } catch (err) {
    console.warn(`[monitor] self-watcher failed: ${err.message}`);
  }
}

async function startWatcher(force = false) {
  if (!watchEnabled) {
    stopWatcher();
    return;
  }
  if (watcher && !force) {
    return;
  }
  if (watcher && force) {
    stopWatcher();
  }
  let targetPath = watchPath;
  try {
    const stats = await (await import("node:fs/promises")).stat(watchPath);
    if (stats.isFile()) {
      watchFileName = watchPath.split(/[\\/]/).pop();
      targetPath = watchPath.split(/[\\/]/).slice(0, -1).join("/") || ".";
    }
  } catch {
    // The configured path does not exist.  Previous behaviour fell back to
    // watching the parent directory, which could be extremely broad (e.g. the
    // entire AppData/Roaming tree) and trigger spurious restarts.  Try the
    // running entry script (process.argv[1]) as a sensible fallback so the
    // watcher still self-restarts on monitor-script edits, then disable
    // entirely if that's also missing.
    let fallbackScript = null;
    try {
      const argvScript = String(process.argv?.[1] || "").trim();
      if (argvScript && existsSync(argvScript)) {
        fallbackScript = resolve(argvScript);
      }
    } catch {
      fallbackScript = null;
    }
    if (fallbackScript) {
      if (!watcherMissingPathLogged) {
        console.log(
          `[monitor] configured watch path missing (${watchPath}); falling back to entry script ${fallbackScript}`,
        );
        watcherMissingPathLogged = true;
      }
      watchPath = fallbackScript;
      watchFileName = fallbackScript.split(/[\\/]/).pop();
      targetPath = fallbackScript.split(/[\\/]/).slice(0, -1).join("/") || ".";
    } else {
      if (!watcherMissingPathLogged) {
        console.warn(
          `[monitor] watcher disabled — configured watch path does not exist: ${watchPath}`,
        );
        watcherMissingPathLogged = true;
      }
      return;
    }
  }

  if (!existsSync(targetPath)) {
    console.warn(
      `[monitor] watcher disabled — target path does not exist: ${targetPath}`,
    );
    return;
  }

  try {
    watcher = watch(targetPath, { persistent: true }, (_event, filename) => {
      if (watchFileName && filename && filename !== watchFileName) {
        return;
      }
      if (watcherDebounce) {
        clearTimeout(watcherDebounce);
      }
      watcherDebounce = safeSetTimeout("watcher-file-change-debounce", () => {
        requestRestart("file-change");
      }, 5000);
    });
  } catch (err) {
    console.warn(
      `[monitor] watcher failed for ${targetPath}: ${err?.message || err}`,
    );
  }
}

function stopEnvWatchers() {
  for (const w of envWatchers) {
    try {
      w.close();
    } catch {
      /* best effort */
    }
  }
  envWatchers = [];
  envWatcherDebounce = null;
  envPathMtimes = new Map();
}

function scheduleEnvReload(reason) {
  if (envWatcherDebounce) {
    clearTimeout(envWatcherDebounce);
  }
  envWatcherDebounce = safeSetTimeout("env-reload-debounce", () => {
    runDetached("config-reload:env-change", () =>
      reloadConfig(reason || "env-change"),
    );
  }, ENV_RELOAD_DELAY_MS);
}

function startEnvWatchers() {
  stopEnvWatchers();
  if (!envPaths || envPaths.length === 0) {
    return;
  }
  const dirMap = new Map();
  for (const envPath of envPaths) {
    const dir = resolve(envPath, "..");
    const file = envPath.split(/[\\/]/).pop();
    if (!file) continue;
    if (!dirMap.has(dir)) {
      dirMap.set(dir, new Set());
    }
    dirMap.get(dir).add(file);
  }
  // Snapshot initial mtimes so we can detect real writes vs. spurious
  // read-only access events (antivirus, Windows Search Indexer, etc.)
  for (const envPath of envPaths) {
    try {
      envPathMtimes.set(envPath, statSync(envPath).mtimeMs);
    } catch {
      envPathMtimes.set(envPath, 0);
    }
  }
  for (const [dir, files] of dirMap.entries()) {
    try {
      const w = watch(dir, { persistent: true }, (_event, filename) => {
        if (!filename) return;
        if (!files.has(filename)) return;
        // Resolve the full path to compare against the known mtime snapshot
        const fullPath = resolve(dir, filename);
        let newMtime = 0;
        try {
          newMtime = statSync(fullPath).mtimeMs;
        } catch {
          // file removed — still a real change
          newMtime = -1;
        }
        const prevMtime = envPathMtimes.get(fullPath) ?? envPathMtimes.get(filename) ?? null;
        if (prevMtime !== null && newMtime === prevMtime) return; // no actual write
        envPathMtimes.set(fullPath, newMtime);
        scheduleEnvReload(`env:${filename}`);
      });
      envWatchers.push(w);
    } catch {
      /* best effort */
    }
  }
}

function applyConfig(nextConfig, options = {}) {
  const { restartIfChanged = false, reason = "config-change" } = options;
  const prevScriptPath = scriptPath;
  const prevArgs = scriptArgs?.join(" ") || "";
  const prevWatchPath = watchPath;
  const prevTelegramInterval = telegramIntervalMin;
  const prevCodexEnabled = codexEnabled;
  const prevPrimaryAgentName = primaryAgentName;
  const prevPrimaryAgentReady = primaryAgentReady;
  const prevTelegramCommandEnabled = telegramCommandEnabled;
  const prevTelegramBotEnabled = telegramBotEnabled;
  const prevPreflightEnabled = preflightEnabled;
  const prevSelfRestartWatcherEnabled = selfRestartWatcherEnabled;

  config = nextConfig;
  projectName = nextConfig.projectName;
  scriptPath = nextConfig.scriptPath;
  scriptArgs = nextConfig.scriptArgs;
  restartDelayMs = nextConfig.restartDelayMs;
  maxRestarts = nextConfig.maxRestarts;
  logDir = nextConfig.logDir;
  watchEnabled = nextConfig.watchEnabled;
  watchPath = resolve(nextConfig.watchPath);
  watcherMissingPathLogged = false;
  echoLogs = nextConfig.echoLogs;
  autoFixEnabled = nextConfig.autoFixEnabled;
  shellState.enabled = !!nextConfig.interactiveShellEnabled;
  preflightEnabled = nextConfig.preflightEnabled;
  preflightRetryMs = nextConfig.preflightRetryMs;
  repoRoot = nextConfig.repoRoot;
  statusPath = nextConfig.statusPath;
  telegramPollLockPath = nextConfig.telegramPollLockPath;
  telegramToken = nextConfig.telegramToken;
  telegramChatId = nextConfig.telegramChatId;
  telegramIntervalMin = nextConfig.telegramIntervalMin;
  telegramCommandPollTimeoutSec = nextConfig.telegramCommandPollTimeoutSec;
  telegramCommandConcurrency = nextConfig.telegramCommandConcurrency;
  telegramCommandMaxBatch = nextConfig.telegramCommandMaxBatch;
  telegramBotEnabled = nextConfig.telegramBotEnabled;
  telegramCommandEnabled = nextConfig.telegramCommandEnabled;
  repoSlug = nextConfig.repoSlug;
  repoUrlBase = nextConfig.repoUrlBase;
  cachedProjectId = null;
  kanbanBackend = String(nextConfig.kanban?.backend || kanbanBackend || "internal")
    .trim()
    .toLowerCase();
  if (nextConfig?.kanbanSource) {
    const src = nextConfig.kanbanSource;
    const sourceLabel = src.sourcePath
      ? `${src.source} (${src.sourcePath})`
      : src.source;
    console.log(
      `[monitor] kanban backend source: ${sourceLabel} (raw=${src.rawValue})`,
    );
  }
  try {
    setKanbanBackend(kanbanBackend);
  } catch (err) {
    console.warn(
      `[monitor] failed to switch kanban backend to "${kanbanBackend}": ${err?.message || err}`,
    );
  }
  executorMode = nextConfig.executorMode || getExecutorMode();
  workflowAutomationEnabled = parseEnvBoolean(
    process.env.WORKFLOW_AUTOMATION_ENABLED,
    workflowAutomationEnabled,
  );
  applyWorkflowRecoveryPolicy(
    nextConfig.workflowRecovery,
    `config-reload:${reason || "unknown"}`,
  );
  {
    const dedupMs = Number(
      process.env.WORKFLOW_EVENT_DEDUP_WINDOW_MS || workflowEventDedupWindowMs || "15000",
    );
    workflowEventDedupWindowMs = Number.isFinite(dedupMs) && dedupMs > 0
      ? dedupMs
      : 15_000;
  }
  triggerSystemConfig =
    nextConfig.triggerSystem && typeof nextConfig.triggerSystem === "object"
      ? nextConfig.triggerSystem
      : { enabled: false, templates: [], defaults: { executor: "auto", model: "auto" } };
  configureExecutorTaskStatusTransitions();
  if (workflowAutomationEnabled) {
    ensureWorkflowAutomationEngine().catch(() => {});
  }
  agentPrompts = nextConfig.agentPrompts;
  configExecutorConfig = nextConfig.executorConfig;
  executorScheduler = nextConfig.scheduler;
  agentSdk = nextConfig.agentSdk;
  envPaths = nextConfig.envPaths;
  selfRestartWatcherEnabled = isSelfRestartWatcherEnabled();

  // ── Internal executor hot-reload ──────────────────────────────────────
  if (nextConfig.internalExecutor) {
    internalExecutorConfig = nextConfig.internalExecutor;
  }

  codexEnabled = nextConfig.codexEnabled;
  primaryAgentName = nextConfig.primaryAgent;
  primaryAgentReady = nextConfig.primaryAgentEnabled;
  codexDisabledReason = codexEnabled
    ? ""
    : isTruthyFlag(process.env.CODEX_SDK_DISABLED)
      ? "disabled via CODEX_SDK_DISABLED"
      : agentSdk?.primary && agentSdk.primary !== "codex"
        ? `disabled via agent_sdk.primary=${agentSdk.primary}`
        : "disabled via --no-codex";

  const primaryAgentChanged = prevPrimaryAgentName !== primaryAgentName;
  if (primaryAgentChanged) {
    setPrimaryAgent(primaryAgentName);
  }
  if (
    (primaryAgentChanged && primaryAgentReady) ||
    (!prevPrimaryAgentReady && primaryAgentReady)
  ) {
    runDetached("primary-agent:init-config-reload", () =>
      initPrimaryAgent(primaryAgentName));
  }

  if (prevWatchPath !== watchPath || watchEnabled === false) {
    void startWatcher(true);
  }
  if (prevSelfRestartWatcherEnabled !== selfRestartWatcherEnabled) {
    if (selfRestartWatcherEnabled) {
      startSelfWatcher();
      console.log(
        "[monitor] self-restart watcher enabled (devmode or SELF_RESTART_WATCH_ENABLED=1)",
      );
    } else {
      stopSelfWatcher();
      console.log(
        "[monitor] self-restart watcher disabled (set SELF_RESTART_WATCH_FORCE=1 to allow in npm/prod mode)",
      );
    }
  }
  startEnvWatchers();

  if (prevTelegramInterval !== telegramIntervalMin) {
    runDetached("telegram-notifier:restart-config-reload", () =>
      startTelegramNotifier());
  }
  if (!prevTelegramCommandEnabled && telegramCommandEnabled) {
    startTelegramCommandListener();
  }
  if (prevTelegramBotEnabled !== telegramBotEnabled) {
    if (telegramBotEnabled) {
      runDetached("telegram-bot:start-config-reload", () =>
        startTelegramSurfaceAndBot(getTelegramBotStartOptions()));
    } else {
      stopTelegramSurfaceAndBot();
    }
  }
  if (prevCodexEnabled && !codexEnabled) {
    console.warn(
      `[monitor] Codex disabled: ${codexDisabledReason || "disabled"}`,
    );
  }
  if (!prevCodexEnabled && codexEnabled) {
    void ensureCodexSdkReady().catch((err) => {
      console.warn(
        `[monitor] ensureCodexSdkReady reload check failed: ${err?.message || err}`,
      );
    });
  }
  if (prevPreflightEnabled && !preflightEnabled && preflightRetryTimer) {
    clearTimeout(preflightRetryTimer);
    preflightRetryTimer = null;
  }

  if (shellState.enabled && !shellState.active) {
    startInteractiveShell();
  } else if (!shellState.enabled && shellState.active && shellState.rl) {
    shellState.rl.close();
  }

  if (workflowAutomationEnabled) {
    ensureWorkflowAutomationEngine().catch((err) => {
      console.warn(`[monitor] planner workflow init failed: ${err?.message || err}`);
    });
  }

  const previousMonitorRuntime = snapshotMonitorMonitorRuntime();
  refreshMonitorMonitorRuntime();
  const monitorRuntimeChanged = didMonitorMonitorRuntimeChange(
    previousMonitorRuntime,
  );
  if (monitorMonitor.enabled) {
    if (monitorRuntimeChanged || !monitorMonitor.timer || !monitorMonitor.statusTimer) {
      startMonitorMonitorSupervisor();
    }
  } else {
    stopMonitorMonitorSupervisor();
  }
  restartHeartbeatMonitor();
  restartGitHubReconciler();

  const nextArgs = scriptArgs?.join(" ") || "";
  const scriptChanged = prevScriptPath !== scriptPath || prevArgs !== nextArgs;
  if (restartIfChanged && scriptChanged) {
    requestRestart(`config-change (${reason})`);
  }
}

async function reloadConfig(reason) {
  try {
    const nextConfig = loadConfig(process.argv, { reloadEnv: true });
    applyConfig(nextConfig, { restartIfChanged: true, reason });
    console.log(`[monitor] config reloaded (${reason})`);
    if (telegramToken && telegramChatId) {
      try {
        await sendTelegramMessage(
          `:refresh: .env reloaded (${reason}). Runtime config updated.`,
          { dedupKey: "env-reload" },
        );
      } catch {
        /* best effort */
      }
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn(`[monitor] failed to reload config: ${message}`);
  }
}

function ensureConfigReloadBusListener() {
  if (removeConfigReloadListener) return;
  removeConfigReloadListener = addConfigReloadListener((event) => {
    const reason = String(event?.reason || "event-bus").trim() || "event-bus";
    runDetached(`config-reload:${reason}`, () => reloadConfig(reason));
  });
}

function ensureTuiConfigReloadListener() {
  if (stopTuiConfigReloadListener) return;
  stopTuiConfigReloadListener = onConfigReload((payload = {}) => {
    const reason = String(payload?.reason || "tui").trim() || "tui";
    runDetached(`config-reload:${reason}`, () => reloadConfig(reason));
  });
}

process.on("SIGINT", async () => {
  shuttingDown = true;
  stopWorkspaceSyncTimers();
  stopHeartbeatMonitor();
  stopAutoUpdateLoop();
  stopAgentAlertTailer();
  stopAgentWorkAnalyzer();
  stopSelfWatcher();
  stopEnvWatchers();
  if (removeConfigReloadListener) {
    removeConfigReloadListener();
    removeConfigReloadListener = null;
  }
  if (stopTuiConfigReloadListener) {
    stopTuiConfigReloadListener();
    stopTuiConfigReloadListener = null;
  }
  if (watcher) {
    watcher.close();
  }
  if (currentChild) {
    currentChild.kill("SIGTERM");
  }
  runDetachedDuringShutdown("workspace-monitor-shutdown:sigint", () =>
    workspaceMonitor.shutdown(),
  );
  runDetachedDuringShutdown("poll-lock-release:sigint", () =>
    releaseTelegramPollLock(),
  );
  stopWhatsAppChannel();
  if (agentSupervisor) {
    agentSupervisor.stop();
  }
  if (isContainerEnabled()) {
    await stopAllContainers().catch((e) =>
      console.warn(`[monitor] container cleanup error: ${e.message}`),
    );
  }

  // Wait for active task agents to finish gracefully (up to 5 minutes)
  if (internalTaskExecutor) {
    const status = internalTaskExecutor.getStatus();
    if (status.activeSlots > 0) {
      const slotNames = (status.slots || []).map((s) => s.taskTitle).join(", ");
      console.log(
        `[monitor] SIGINT: waiting for ${status.activeSlots} active agent(s) to finish: ${slotNames}`,
      );
      console.log(`[monitor] (press Ctrl+C again to force exit)`);
      await internalTaskExecutor.stop();
    }
    stopStatusFileWriter();
  }
  process.exit(0);
});

// Windows: closing the terminal window doesn't send SIGINT/SIGTERM reliably.
process.on("exit", () => {
  try { stopTuiConfigReloadListener?.(); } catch { /* best effort */ }
  shuttingDown = true;
  stopWorkspaceSyncTimers();
  stopHeartbeatMonitor();
  stopAgentAlertTailer();
  stopAgentWorkAnalyzer();
  if (removeConfigReloadListener) {
    removeConfigReloadListener();
    removeConfigReloadListener = null;
  }
  runDetachedDuringShutdown("workspace-monitor-shutdown:exit", () =>
    workspaceMonitor.shutdown(),
  );
  runDetachedDuringShutdown("poll-lock-release:exit", () =>
    releaseTelegramPollLock(),
  );
});

process.on("SIGTERM", async () => {
  shuttingDown = true;
  stopWorkspaceSyncTimers();
  stopHeartbeatMonitor();
  stopAutoUpdateLoop();
  stopAgentAlertTailer();
  stopAgentWorkAnalyzer();
  stopSelfWatcher();
  stopEnvWatchers();
  if (removeConfigReloadListener) {
    removeConfigReloadListener();
    removeConfigReloadListener = null;
  }
  if (stopTuiConfigReloadListener) {
    stopTuiConfigReloadListener();
    stopTuiConfigReloadListener = null;
  }
  if (watcher) {
    watcher.close();
  }
  if (currentChild) {
    currentChild.kill("SIGTERM");
  }
  runDetachedDuringShutdown("workspace-monitor-shutdown:sigterm", () =>
    workspaceMonitor.shutdown(),
  );
  runDetachedDuringShutdown("poll-lock-release:sigterm", () =>
    releaseTelegramPollLock(),
  );
  stopTelegramSurfaceAndBot();
  stopWhatsAppChannel();
  if (agentSupervisor) {
    agentSupervisor.stop();
  }
  if (isContainerEnabled()) {
    await stopAllContainers().catch((e) =>
      console.warn(`[monitor] container cleanup error: ${e.message}`),
    );
  }

  // Wait for active task agents to finish gracefully (up to 5 minutes)
  if (internalTaskExecutor) {
    const status = internalTaskExecutor.getStatus();
    if (status.activeSlots > 0) {
      const slotNames = (status.slots || []).map((s) => s.taskTitle).join(", ");
      console.log(
        `[monitor] SIGTERM: waiting for ${status.activeSlots} active agent(s) to finish: ${slotNames}`,
      );
      await internalTaskExecutor.stop();
    }
  }
  process.exit(0);
});

// Stream noise patterns that should NEVER trigger recovery —
// they happen when child processes die or pipes break and are harmless.
function isStreamNoise(msg) {
  return (
    msg.includes("EPIPE") ||
    msg.includes("write EOF") ||
    msg.includes("ERR_STREAM_PREMATURE_CLOSE") ||
    msg.includes("ERR_STREAM_DESTROYED") ||
    msg.includes("stream was destroyed") ||
    msg.includes("Cannot call write after a stream was destroyed") ||
    msg.includes("write after end") ||
    msg.includes("write after a stream was destroyed") ||
    msg.includes("Cannot call write after") ||
    msg.includes("This socket has been ended") ||
    msg.includes("Cannot read properties of null") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("socket hang up") ||
    msg.includes("AbortError") ||
    msg.includes("The operation was aborted") ||
    msg.includes("This operation was aborted") ||
    msg.includes("setRawMode EIO") ||
    msg.includes("hard_timeout") ||
    msg.includes("watchdog-timeout") ||
    // Spawn failures: codex/copilot binary not found — transient noise, not a monitor bug
    msg.includes("ENOENT") ||
    msg.includes("The system cannot find the file specified") ||
    msg.includes("os error 2") ||
    msg.includes("spawn failed")
  );
}

process.on("uncaughtException", (err) => {
  const msg = (err?.code ? err.code + ": " : "") + (err?.message || "");
  // Always suppress stream noise — not just during shutdown
  if (isStreamNoise(msg)) {
    appendMonitorCrashBreadcrumb(
      `[${new Date().toISOString()}] uncaughtException suppressed stream noise ` +
        `(shuttingDown=${shuttingDown}): ${err?.stack || msg || String(err)}`,
    );
    return;
  }
  // Always log the exception — even during shutdown — so the crash is traceable.
  const detail = err?.stack || msg || String(err);
  writeMonitorStreamSafely("[monitor] uncaughtException: " + detail + "\n", {
    prefer: "stdout",
  });
  appendMonitorCrashBreadcrumb(
    `[${new Date().toISOString()}] uncaughtException (shuttingDown=${shuttingDown}): ${detail}`,
  );
  if (shuttingDown) return;
  writeMonitorStreamSafely("[monitor] uncaughtException: " + detail + "\n");
  handleMonitorFailure("uncaughtException", err).catch((failureErr) => {
    writeMonitorStreamSafely(
      "[monitor] uncaughtException handler failed: " +
        (failureErr?.message || failureErr) +
        "\n",
      { prefer: "stdout" },
    );
  });
});

process.on("unhandledRejection", (reason) => {
  const msg = (reason?.code ? reason.code + ": " : "") + (reason?.message || String(reason || ""));
  // Always write breadcrumb — unhandled rejections can cause exit code 1
  const detail = reason instanceof Error ? (reason.stack || msg) : msg;
  appendMonitorCrashBreadcrumb(
    `[${new Date().toISOString()}] unhandledRejection (shuttingDown=${shuttingDown}): ${detail}`,
  );
  // Always suppress stream noise
  if (isStreamNoise(msg)) {
    appendMonitorCrashBreadcrumb(
      `[${new Date().toISOString()}] unhandledRejection suppressed stream noise ` +
        `(shuttingDown=${shuttingDown}): ${detail}`,
    );
    return;
  }
  if (shuttingDown) return;
  const err =
    reason instanceof Error ? reason : new Error(String(reason || ""));
  writeMonitorStreamSafely("[monitor] unhandledRejection: " + (err?.stack || msg) + "\n");
  handleMonitorFailure("unhandledRejection", err).catch((failureErr) => {
    writeMonitorStreamSafely(
      "[monitor] unhandledRejection handler failed: " +
        (failureErr?.message || failureErr) +
        "\n",
      { prefer: "stdout" },
    );
  });
});

// ── Exit diagnostic: always log the exit code so crashes are traceable ──────
process.on("exit", (code) => {
  if (code === 0 || code === SELF_RESTART_EXIT_CODE) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] process exiting with code ${code} (shuttingDown=${shuttingDown}, uptime=${Math.round(process.uptime())}s)`;
  writeMonitorStreamSafely("[monitor] " + line + "\n", { prefer: "stdout" });
  // Persist breadcrumb to disk so the crash is always traceable even when
  // stderr output is lost (e.g., background daemon, piped output).
  appendMonitorCrashBreadcrumb(line);
});

const workflowStartupRecoveryGraceMs = Math.max(
  0,
  Number(configWorkflowRecovery?.startupGraceMs || 0),
);
const workflowStartupRecoveryStepDelayMs = Math.max(
  0,
  Number(configWorkflowRecovery?.startupStepDelayMs || 0),
);
const workflowStartupHistoryRecoveryDelayMs = Math.max(
  0,
  Number(process.env.WORKFLOW_STARTUP_HISTORY_RECOVERY_DELAY_MS || 120_000),
);

function scheduleStartupWorkflowRecovery(name, handler, step = 0, extraDelayMs = 0) {
  const delayMs =
    workflowStartupRecoveryGraceMs +
    Math.max(0, step) * workflowStartupRecoveryStepDelayMs +
    Math.max(0, Number(extraDelayMs) || 0);
  safeSetTimeout(name, handler, delayMs);
}

if (!isMonitorTestRuntime) {
  const DUPLICATE_START_EXIT_STATE_FILE =
    "monitor-duplicate-start-exit-state.json";
  const MONITOR_PID_FILE_NAME = "bosun.pid";
  const DUPLICATE_START_EXIT_THROTTLE_MS = Math.max(
    5_000,
    Number(process.env.MONITOR_DUPLICATE_START_WARN_THROTTLE_MS || "60000") ||
      60000,
  );

  function readMonitorLockOwnerPid(cacheDir) {
    const pidPath = resolve(cacheDir, MONITOR_PID_FILE_NAME);
    try {
      const raw = String(readFileSync(pidPath, "utf8") || "").trim();
      if (!raw) return null;
      if (raw.startsWith("{")) {
        const parsed = JSON.parse(raw);
        const pid = Number(parsed?.pid);
        return Number.isFinite(pid) && pid > 0 ? pid : null;
      }
      const pid = Number(raw);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  function writeDuplicateStartExitNotice(cacheDir) {
    const statePath = resolve(cacheDir, DUPLICATE_START_EXIT_STATE_FILE);
    const now = Date.now();
    const ownerPid = readMonitorLockOwnerPid(cacheDir);
    let state = {};
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      state = {};
    }

    const lastPid = Number(state?.pid || 0);
    const samePid = Number(ownerPid) > 0 && lastPid === Number(ownerPid);
    const lastLoggedAt = Number(state?.lastLoggedAt || 0);
    const suppressed = Math.max(0, Number(state?.suppressed || 0));
    if (samePid && now - lastLoggedAt < DUPLICATE_START_EXIT_THROTTLE_MS) {
      try {
        writeFileSync(
          statePath,
          JSON.stringify({
            pid: ownerPid,
            lastLoggedAt,
            suppressed: suppressed + 1,
          }),
          "utf8",
        );
      } catch {
        /* best effort */
      }
      return;
    }

    const suffix =
      samePid && suppressed > 0
        ? " (suppressed " +
          suppressed +
          " duplicate-start exits in last " +
          Math.round(DUPLICATE_START_EXIT_THROTTLE_MS / 1000) +
          "s)"
        : "";
    const pidSuffix = Number(ownerPid) > 0 ? ` (PID ${ownerPid})` : "";
    // Duplicate-start lock contention exits with code 0; emit on stdout to avoid error-tail noise.
    writeMonitorStreamSafely(
      "[monitor] another bosun instance holds the lock" +
        pidSuffix +
        " — duplicate start ignored (exit code 0)." +
        suffix +
        "\n",
      { prefer: "stdout" },
    );

    try {
      writeFileSync(
        statePath,
        JSON.stringify({
          pid: Number(ownerPid) > 0 ? ownerPid : null,
          lastLoggedAt: now,
          suppressed: 0,
        }),
        "utf8",
      );
    } catch {
      /* best effort */
    }
  }

  // ── Singleton guard: prevent ghost monitors ─────────────────────────────────
  if (!acquireMonitorLock(config.cacheDir)) {
    // During source-change self-restart, the previous monitor can still be
    // shutting down and holding the lock briefly. Ask cli.mjs to retry instead
    // of treating this as a hard crash.
    if (isSelfRestart) {
      // Write through the guarded monitor stream helper so lock-handoff retries
      // do not crash if the parent process has already closed its pipes.
      writeMonitorStreamSafely(
        "[monitor] self-restart lock handoff still busy — retrying startup\n",
        { prefer: "stdout" },
      );
      process.exit(SELF_RESTART_EXIT_CODE);
    }
    // Duplicate start (lock held by another healthy monitor) is benign.
    // Exit 0 so daemon/service wrappers do not treat this as a crash loop.
    writeDuplicateStartExitNotice(config.cacheDir);
    process.exit(0);
  }

// ── Codex CLI config.toml: ensure global defaults + stream timeouts ─────────
try {
  const allowRuntimeCodexMutation = isTruthyFlag(
    process.env.BOSUN_ALLOW_RUNTIME_GLOBAL_CODEX_MUTATION,
  );
  const tomlResult = ensureCodexConfig({
    dryRun: !allowRuntimeCodexMutation,
  });
  if (!tomlResult.noChanges) {
    if (!allowRuntimeCodexMutation) {
      console.log(
        "[monitor] Codex config drift detected (runtime is read-only; run `node cli.mjs --setup` to apply).",
      );
    } else {
      console.log("[monitor] updated ~/.codex/config.toml:");
    }
    printConfigSummary(tomlResult);
  }
} catch (err) {
  console.warn(
    `[monitor] config.toml check failed (non-fatal): ${err.message}`,
  );
}

console.log("[monitor] legacy maintenance sweep removed — use workflow schedules");

safeSetInterval("helper-process-reaper", () => {
  try {
    reapStaleBosunHelperProcesses(HELPER_PROCESS_MAX_AGE_MS);
  } catch (err) {
    console.warn(`[monitor] helper-process reaper error: ${err?.message || err}`);
  }
}, HELPER_PROCESS_REAP_INTERVAL_MS);

safeSetInterval("flush-error-queue", () => flushErrorQueue(), 60 * 1000);

safeSetInterval("queued-runtime-restart-request", () => {
  maybeHandleQueuedRuntimeRestartRequest("interval");
}, RUNTIME_RESTART_REQUEST_POLL_MS);

// Legacy periodic maintenance sweep removed (workflow-only control).

// ── Workflow schedule trigger polling ───────────────────────────────────────
// Check all installed polling workflows (trigger.schedule, trigger.scheduled_once,
// trigger.task_available, trigger.task_low) and fire any whose interval has elapsed.
// This keeps scheduled and task-poll lifecycle templates executing without hardcoded
// per-workflow timers.  Workspace-aware: skips workflows for paused/disabled workspaces.
const scheduleCheckIntervalMs = 60 * 1000; // check every 60s
pollWorkflowSchedulesOnce = async function pollWorkflowSchedulesOnce(
  triggerSource = "schedule-poll",
  opts = {},
) {
  try {
    const engine = await ensureWorkflowAutomationEngine();
    if (!engine?.evaluateScheduleTriggers) {
      if (opts?.requireEngine) {
        throw new Error("workflow automation engine unavailable");
      }
      return;
    }
    const includeTaskPoll = opts?.includeTaskPoll !== false;
    const includeScheduled = opts?.includeScheduled !== false;

    const triggered = engine.evaluateScheduleTriggers({ configDir: repoRoot });
    if (!Array.isArray(triggered) || triggered.length === 0) return;

    for (const match of triggered) {
      const workflowId = String(match?.workflowId || "").trim();
      if (!workflowId) continue;
      const workflow = typeof engine.get === "function" ? engine.get(workflowId) : null;
      const triggerNode = Array.isArray(workflow?.nodes)
        ? workflow.nodes.find((node) => node?.id === match?.triggeredBy)
        : null;
      const isTaskPollTrigger =
        triggerNode?.type === "trigger.task_available" ||
        triggerNode?.type === "trigger.task_low";
      if (!includeTaskPoll && isTaskPollTrigger) {
        continue;
      }
      if (!includeScheduled && !isTaskPollTrigger) {
        continue;
      }
      void engine
        .execute(workflowId, {
          _triggerSource: triggerSource,
          _triggeredBy: match?.triggeredBy || null,
          _workspaceId: match?.workspaceId || null,
          repoRoot,
        })
        .then((ctx) => {
          const runId = ctx?.id || "unknown";
          // Quiet mode: don't log completed runs where trigger didn't fire
          const triggerNodeId = match?.triggeredBy;
          const triggerOutput = triggerNodeId ? ctx?.getNodeOutput?.(triggerNodeId) : null;
          if (triggerOutput?.triggered === false) return; // silent — trigger didn't fire
          const runStatus =
            Array.isArray(ctx?.errors) && ctx.errors.length > 0
              ? "failed"
              : "completed";
          console.log(
            `[workflows] schedule-run ${runStatus} workflow=${workflowId} runId=${runId}`,
          );
        })
        .catch((err) => {
          console.warn(
            `[workflows] schedule-run failed workflow=${workflowId}: ${err?.message || err}`,
          );
        });
    }

    if (triggered.length > 0) {
      console.log(
        `[workflows] schedule poll triggered ${triggered.length} workflow run(s)`,
      );
    }
  } catch (err) {
    console.warn(`[workflows] schedule-check error: ${err?.message || err}`);
    if (opts?.throwOnError) throw err;
  }
};

safeSetInterval("workflow-schedule-check", async () => {
  await pollWorkflowSchedulesOnce();
}, scheduleCheckIntervalMs);

// ── Periodic workflow run file pruning: once per day ─────────────────────
// Deletes run detail files beyond MAX_PERSISTED_RUNS to keep the workflow-runs
// directory bounded and prevent O(n) dir-scan slowdown on history API calls.
safeSetInterval("workflow-run-file-prune", async () => {
  try {
    const engine = await ensureWorkflowAutomationEngine();
    if (typeof engine?.pruneOldRunFiles !== "function") return;
    const result = engine.pruneOldRunFiles();
    if (result.deleted > 0) {
      console.log(`[workflows] pruned ${result.deleted} old run file(s), kept ${result.kept}`);
    }
  } catch (err) {
    console.warn(`[workflows] run-file prune error: ${err?.message || err}`);
  }
}, 24 * 60 * 60 * 1000);

safeSetInterval("workflow-review-merge-reconcile", async () => {
  const result = await checkMergedPRsAndUpdateTasks();
  if ((result?.movedDone || 0) > 0) {
    console.log(
      `[monitor] review merge reconcile moved ${result.movedDone} task(s) to done`,
    );
  }
}, scheduleCheckIntervalMs);

// ── Periodic blocked-task recovery: every 2 min ────────────────────────────
// Recovers worktree-failure blocked tasks past their cooldown and unblocks
// parent tasks whose child subtasks are all done/cancelled.
safeSetInterval("blocked-task-recovery", () => {
  try {
    const result = recoverAutoBlockedTasks();
    if (result.recoveredCount > 0) {
      console.log(
        `[monitor] auto-recovered ${result.recoveredCount} blocked task(s): ${result.recoveredTaskIds.join(", ")}`,
      );
    }
  } catch (err) {
    console.warn(`[monitor] blocked-task recovery error: ${err?.message || err}`);
  }
}, 2 * 60 * 1000);

// Legacy merged PR check removed (workflow-only control).

// ── Periodic stale worktree sync: every 5 min ─────────────────────────────
// Detects task worktrees that are diverged from their remote (local commits
// not pushed, or remote has newer commits from a previous run).  For each
// diverged worktree it: fetches remote, rebases local onto the remote tracking
// ref for that branch, then pushes with --force-with-lease.  This keeps the
// VS Code source-control view clean and unblocks tasks that got stuck mid-push.
async function syncDivergedWorktrees() {
  const worktrees = listActiveWorktrees(repoRoot);
  let synced = 0;
  let failed = 0;

  for (const wt of worktrees) {
    const { path: wtPath, branch } = wt;
    if (!wtPath || !branch || !branch.startsWith("task/")) continue;

    try {
      // Fetch remote to update tracking refs
      await execAsync("git fetch origin --no-tags", {
        cwd: wtPath, timeout: 30_000,
      });

      // Check ahead/behind vs remote tracking ref
      const remoteRef = `origin/${branch}`;
      let remoteExists = false;
      try {
        await execAsync(`git rev-parse --verify ${remoteRef}`, {
          cwd: wtPath, timeout: 5_000,
        });
        remoteExists = true;
      } catch { /* branch not yet pushed — nothing to sync */ }

      if (!remoteExists) continue;

      const ahead = parseInt(
        (await execAsync(`git rev-list --count ${remoteRef}..HEAD`, {
          cwd: wtPath, timeout: 10_000,
        })).trim(), 10);
      const behind = parseInt(
        (await execAsync(`git rev-list --count HEAD..${remoteRef}`, {
          cwd: wtPath, timeout: 10_000,
        })).trim(), 10);

      // Only act on diverged worktrees (behind > 0 AND ahead > 0)
      if (ahead === 0 || behind === 0) continue;

      console.log(
        `[monitor:worktree-sync] ${branch} diverged: ${ahead} ahead, ${behind} behind — merging and pushing`,
      );

      // Merge local with remote tracking ref to incorporate remote commits
      let merged = false;
      try {
        await execAsync(`git merge --no-edit ${remoteRef}`, {
          cwd: wtPath, timeout: 60_000,
        });
        merged = true;
      } catch (mergeErr) {
        console.warn(
          `[monitor:worktree-sync] ${branch} merge conflict — skipping push: ${mergeErr.message?.slice(0, 200)}`,
        );
        failed++;
        continue;
      }

      // Safety: refuse to push if HEAD now equals origin/main (would wipe PR changes)
      try {
        const headSha = (await execAsync("git rev-parse HEAD", { cwd: wtPath, timeout: 5_000 })).trim();
        const mainSha = (await execAsync("git rev-parse origin/main", { cwd: wtPath, timeout: 5_000 })).trim();
        if (headSha === mainSha) {
          console.warn(`[monitor:worktree-sync] ${branch} HEAD matches origin/main after merge — aborting push to prevent PR wipe`);
          failed++;
          continue;
        }
      } catch { /* best-effort check */ }

      // Push with --force-with-lease (safe: we just fetched fresh remote refs)
      try {
        await execAsync(`git push --force-with-lease --set-upstream origin HEAD`, {
          cwd: wtPath, timeout: 30_000,
        });
        console.log(`[monitor:worktree-sync] ${branch} sync-pushed successfully`);
        synced++;
      } catch (pushErr) {
        console.warn(
          `[monitor:worktree-sync] ${branch} push failed: ${pushErr.message?.slice(0, 200)}`,
        );
        failed++;
      }
    } catch (err) {
      console.warn(`[monitor:worktree-sync] ${branch} error: ${err.message?.slice(0, 200)}`);
      failed++;
    }
  }

  if (synced > 0 || failed > 0) {
    console.log(`[monitor:worktree-sync] cycle complete — synced=${synced} failed=${failed}`);
  }
}

const worktreeSyncIntervalMs = 5 * 60 * 1000; // 5 min
safeSetInterval("worktree-sync", syncDivergedWorktrees, worktreeSyncIntervalMs);

// ── Periodic epic branch sync/merge: every 15 min ──────────────────────────
const epicMergeIntervalMs = 15 * 60 * 1000;
safeSetInterval("epic-merge-check", () => checkEpicBranches("interval"), epicMergeIntervalMs);

// ── Log rotation: truncate oldest logs when folder exceeds size limit ───────
if (logMaxSizeMb > 0) {
  // Run once at startup (delayed 10s)
  safeSetTimeout("startup-log-rotation", () => truncateOldLogs(), 10 * 1000);
  if (logCleanupIntervalMin > 0) {
    const logCleanupIntervalMs = logCleanupIntervalMin * 60 * 1000;
    safeSetInterval("log-rotation", () => truncateOldLogs(), logCleanupIntervalMs);
    console.log(
      `[monitor] log rotation enabled — max ${logMaxSizeMb} MB, checking every ${logCleanupIntervalMin} min`,
    );
  } else {
    console.log(
      `[monitor] log rotation enabled — max ${logMaxSizeMb} MB (startup check only)`,
    );
  }
}

const STARTUP_EPIC_CHECK_DELAY_MS = parseEnvInteger(
  process.env.BOSUN_STARTUP_EPIC_CHECK_DELAY_MS,
  2 * 60 * 1000,
  { min: 30 * 1000, max: 30 * 60 * 1000 },
);
const STARTUP_DEPENDABOT_CHECK_DELAY_MS = parseEnvInteger(
  process.env.BOSUN_STARTUP_DEPENDABOT_CHECK_DELAY_MS,
  STARTUP_EPIC_CHECK_DELAY_MS + 30 * 1000,
  { min: STARTUP_EPIC_CHECK_DELAY_MS, max: 30 * 60 * 1000 },
);

// Stagger the heaviest git/gh maintenance away from initial startup so the UI
// server can answer readiness probes before long-running repo checks begin.
safeSetTimeout("startup-epic-check", () => checkEpicBranches("startup"), STARTUP_EPIC_CHECK_DELAY_MS);
safeSetTimeout("startup-dependabot-auto-merge", () => checkAndMergeDependabotPRs(), STARTUP_DEPENDABOT_CHECK_DELAY_MS);

// ── Fleet Coordination ───────────────────────────────────────────────────────
if (fleetConfig?.enabled) {
  const maxParallel = getMaxParallelFromArgs(scriptArgs) || internalExecutorConfig?.maxParallel || 6;
  void initFleet({
    repoRoot,
    localSlots: maxParallel,
    ttlMs: fleetConfig.presenceTtlMs,
  })
    .then((state) => {
      console.log(
        `[fleet] ready: mode=${state.mode}, peers=${state.fleetSize}, totalSlots=${state.totalSlots}`,
      );
      void persistFleetState(repoRoot);
    })
    .catch((err) => {
      console.warn(`[fleet] init failed (continuing solo): ${err.message}`);
    });

  // Periodic fleet sync
  const syncMs = fleetConfig.syncIntervalMs || 2 * 60 * 1000;
  safeSetInterval("fleet-sync", async () => {
    try {
      await refreshFleet({ ttlMs: fleetConfig.presenceTtlMs });
      await persistFleetState(repoRoot);
    } catch (err) {
      console.warn(`[fleet] sync error: ${err.message}`);
    }
  }, syncMs);
  console.log(
    `[fleet] sync every ${Math.round(syncMs / 1000)}s, TTL=${Math.round((fleetConfig.presenceTtlMs || 300000) / 1000)}s`,
  );

  // Shared knowledge system
  if (fleetConfig.knowledgeEnabled) {
    initSharedKnowledge({
      repoRoot,
      targetFile: fleetConfig.knowledgeFile || "AGENTS.md",
    });
    console.log(
      `[fleet] shared knowledge enabled → ${fleetConfig.knowledgeFile || "AGENTS.md"}`,
    );
  }
} else {
  console.log("[fleet] disabled (set FLEET_ENABLED=true to enable)");
}

// ── Periodic Dependabot auto-merge check ─────────────────────────────────────
if (dependabotAutoMerge) {
  const depIntervalMs = (dependabotAutoMergeIntervalMin || 10) * 60 * 1000;
  safeSetInterval("dependabot-auto-merge", () => checkAndMergeDependabotPRs(), depIntervalMs);
  console.log(
    `[dependabot] auto-merge enabled — checking every ${dependabotAutoMergeIntervalMin || 10} min for: ${dependabotAuthors.join(", ")}`,
  );
}

if (telegramWeeklyReportEnabled) {
  const weeklyReportPollMs = 60 * 1000;
  const nextWeeklyReportTime = getNextWeeklyReportTime({
    now: new Date(),
    dayOfWeek: telegramWeeklyReportDay,
    hourUtc: telegramWeeklyReportHour,
  });
  safeSetInterval("telegram-weekly-report", () => maybeSendWeeklyReport(), weeklyReportPollMs);
  safeSetTimeout("telegram-weekly-report-initial", () => maybeSendWeeklyReport(), 45 * 1000);
  console.log(
    `[monitor] weekly Telegram report scheduler enabled (day=${telegramWeeklyReportDay}, hourUtc=${telegramWeeklyReportHour}, lookbackDays=${telegramWeeklyReportDays}); next scheduled send at ${nextWeeklyReportTime.toISOString()}`,
  );
}

// ── Self-updating: poll npm every 10 min, auto-install + restart ────────────
const isDaemonChildForAutoUpdate =
  process.argv.includes("--daemon-child") || process.env.BOSUN_DAEMON === "1";
startAutoUpdateLoop({
  onRestart: (reason) => restartSelf(reason),
  onNotify: (msg) =>
    // Priority 1 (critical) bypasses the live digest so the user gets a
    // direct push notification for update-detected and restarting events.
    sendTelegramMessage(msg, { priority: 1, skipDedup: true }).catch(() => {}),
  trackParent: !isDaemonChildForAutoUpdate,
});

startWatcher();
startEnvWatchers();
ensureConfigReloadBusListener();
ensureTuiConfigReloadListener();
if (selfRestartWatcherEnabled) {
  startSelfWatcher();
} else {
  const normalizedExecutorMode = String(executorMode || "")
    .trim()
    .toLowerCase();
  const explicitSelfRestartWatch = process.env.SELF_RESTART_WATCH_ENABLED;
  const hasExplicitSelfRestartWatch =
    explicitSelfRestartWatch !== undefined &&
    String(explicitSelfRestartWatch).trim() !== "";
  const forceSelfRestartWatch = isTruthyFlag(process.env.SELF_RESTART_WATCH_FORCE);
  const npmLifecycleEvent = String(process.env.npm_lifecycle_event || "")
    .trim()
    .toLowerCase();
  const launchedViaNpmStartScript =
    npmLifecycleEvent === "start" || npmLifecycleEvent.startsWith("start:");
  const disabledReason = hasExplicitSelfRestartWatch
    ? "explicitly"
    : !isDevMode()
    ? "npm/prod mode — updates via auto-update loop"
    : !forceSelfRestartWatch && !launchedViaNpmStartScript
      ? "CLI command mode in source checkout — use npm run start or SELF_RESTART_WATCH_ENABLED=1 to enable"
    : normalizedExecutorMode === "internal" || normalizedExecutorMode === "hybrid"
      ? `executor mode "${normalizedExecutorMode}" (continuous task-driven code changes)`
      : "explicitly";
  console.log(
    `[monitor] self-restart file watcher disabled (${disabledReason})`,
  );
}
startInteractiveShell();
void ensureCodexSdkReady().then(() => {
  if (!codexEnabled) {
    const reason = codexDisabledReason || "disabled";
    console.warn(`[monitor] Codex disabled: ${reason}`);
  } else {
    console.log("[monitor] Codex enabled.");
  }
}).catch((err) => {
  console.warn(
    `[monitor] ensureCodexSdkReady startup check failed: ${err?.message || err}`,
  );
});

// ── Log complexity routing matrix at startup ──────────────────────────────────
try {
  const complexityMatrix = getComplexityMatrix(config.complexityRouting);
  const matrixLines = [];
  for (const [exec, tiers] of Object.entries(complexityMatrix)) {
    for (const [tier, profile] of Object.entries(tiers)) {
      matrixLines.push(
        `  ${exec}/${tier}: ${profile.model || "default"} (${profile.reasoningEffort || "default"})`,
      );
    }
  }
  console.log(
    `[monitor] complexity routing matrix:\n${matrixLines.join("\n")}`,
  );
} catch (err) {
  console.warn(`[monitor] complexity matrix log failed: ${err.message}`);
}

// ── Clean stale status data on startup ─────────────────────────────────────
try {
  const statusRaw = existsSync(statusPath)
    ? readFileSync(statusPath, "utf8")
    : null;
  if (statusRaw) {
    const statusData = JSON.parse(statusRaw);
    const attempts = statusData.attempts || {};
    const STALE_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours
    const now = Date.now();
    let cleaned = 0;
    for (const [key, attempt] of Object.entries(attempts)) {
      const ts = attempt?.updated_at || attempt?.created_at;
      if (!ts) continue;
      const age = now - Date.parse(ts);
      if (age > STALE_AGE_MS && attempt.status === "running") {
        // Mark stale running attempts as "stale" so they don't show as active
        attempt.status = "stale";
        attempt._stale_reason = `No update for ${Math.round(age / 3600000)}h — marked stale on startup`;
        cleaned++;
      }
    }
    if (cleaned > 0) {
      statusData.updated_at = new Date().toISOString();
      writeFileSync(statusPath, JSON.stringify(statusData, null, 2), "utf8");
      console.log(
        `[monitor] cleaned ${cleaned} stale attempts from status file`,
      );
    }
  }
} catch (err) {
  console.warn(`[monitor] stale cleanup failed: ${err.message}`);
}
} else {
  console.log(
    "[monitor] test runtime detected (VITEST/NODE_ENV=test) — startup maintenance loops disabled",
  );
}

// ── Internal Executor / Orchestrator startup ──────────────────────────────────
/** @type {import("../task/task-executor.mjs").TaskExecutor|null} */
let internalTaskExecutor = null;
const workflowOwnsTaskExecutorLifecycle = isWorkflowReplacingModule("task-executor.mjs");
async function runWorkflowOwnedTaskRecoveryPass(source) {
  if (
    !workflowOwnsTaskExecutorLifecycle ||
    !internalTaskExecutor ||
    typeof internalTaskExecutor._runInProgressRecoverySafely !== "function"
  ) {
    return;
  }
  await internalTaskExecutor._runInProgressRecoverySafely(source);
}
/** @type {import("../agent/agent-endpoint.mjs").AgentEndpoint|null} */
let agentEndpoint = null;
/** @type {import("../agent/agent-event-bus.mjs").AgentEventBus|null} */
let agentEventBus = null;
/** @type {import("../agent/review-agent.mjs").ReviewAgent|null} */
let reviewAgent = null;
/** @type {Map<string, { approved: boolean, reviewedAt: string }>} */
const reviewGateResults = new Map();
const pendingMergeStrategyByTask = new Map();
const reviewRedispatchCooldownByTask = new Map();
const REVIEW_REDISPATCH_COOLDOWN_MS = 5 * 60 * 1000;
/** @type {null} Sync engine lifecycle now managed by workflow template */
let syncEngine = null;
/** @type {import("./error-detector.mjs").ErrorDetector|null} */
let errorDetector = null;
/** @type {import("../agent/agent-supervisor.mjs").AgentSupervisor|null} */
let agentSupervisor = null;

if (!isMonitorTestRuntime) {
  if (workflowAutomationEnabled) {
    await ensureWorkflowAutomationEngine().catch(() => {});
    scheduleStartupWorkflowRecovery(
      "startup-stale-dispatch-unstick",
      () =>
        void runWorkflowRecoveryWithPolicy(
          "stale-dispatch-unstick",
          () =>
            pollWorkflowSchedulesOnce("startup", {
              includeTaskPoll: false,
              requireEngine: true,
              throwOnError: true,
            }),
          {
            trigger: "startup",
            operationType: "stale-dispatch-unstick",
            includeTaskPoll: false,
          },
        ),
      0,
    );
    scheduleStartupWorkflowRecovery(
      "startup-workflow-history-unstick",
      () =>
        void runWorkflowRecoveryWithPolicy(
          "workflow-history-unstick",
          async () => {
            const engine = await ensureWorkflowAutomationEngine();
            if (!engine?.resumeInterruptedRuns) {
              throw new Error("workflow engine resumeInterruptedRuns unavailable");
            }
            await engine.resumeInterruptedRuns();
            await runWorkflowOwnedTaskRecoveryPass(
              "startup-workflow-history-unstick",
            );
          },
          {
            trigger: "startup",
            operationType: "workflow-history-unstick",
          },
        ),
      1,
      workflowStartupHistoryRecoveryDelayMs,
    );
  } else {
    console.log(
      "[workflows] automation disabled (set WORKFLOW_AUTOMATION_ENABLED=true to enable event-driven workflow triggers)",
    );
  }
// ── Task Management Subsystem Initialization ────────────────────────────────
try {
  mkdirSync(monitorStateCacheDir, { recursive: true });
  configureTaskStore({
    storePath: resolve(monitorStateCacheDir, "kanban-state.json"),
  });
  console.log(`[monitor] trigger state path: ${triggerStatePath}`);
  console.log(`[monitor] task store path: ${getStorePath()}`);
  loadTaskStore();
  console.log("[monitor] internal task store loaded");
} catch (err) {
  console.warn(`[monitor] task store init warning: ${err.message}`);
}

// Error detector
try {
  errorDetector = createErrorDetector({
    sendTelegram:
      telegramToken && telegramChatId
        ? (msg) => void sendTelegramMessage(msg)
        : null,
  });
  console.log("[monitor] error detector initialized");
} catch (err) {
  console.warn(`[monitor] error detector init failed: ${err.message}`);
}

if (isExecutorDisabled()) {
  console.log(
    `[monitor] :ban: task execution DISABLED (EXECUTOR_MODE=${executorMode}) — no tasks will be executed`,
  );
} else if (executorMode === "internal" || executorMode === "hybrid") {
  // Start internal executor
  try {
    if (workflowOwnsTaskExecutorLifecycle) {
      console.log(
        "[monitor] task-executor lifecycle delegation enabled — finalization/recovery handled by workflow replacement",
      );
    }
    const workflowRunsDir =
      config?.configDir &&
      String(config?.activeWorkspace || process.env.BOSUN_WORKSPACE || "").trim()
        ? resolve(
            config.configDir,
            "workspaces",
            String(config?.activeWorkspace || process.env.BOSUN_WORKSPACE || "").trim(),
            String(repoSlug || "").split("/").filter(Boolean).pop() || "bosun",
            ".bosun",
            "workflow-runs",
          )
        : null;
    const execOpts = {
      ...internalExecutorConfig,
      repoRoot,
      repoSlug,
      workflowRunsDir,
      agentPrompts,
      workflowOwnsTaskLifecycle: workflowOwnsTaskExecutorLifecycle,
      sendTelegram:
        telegramToken && telegramChatId
          ? (msg) => void sendTelegramMessage(msg)
          : null,
      onTaskStarted: (task, slot) => {
        const agentId =
          Number.isFinite(slot?.agentInstanceId) && slot.agentInstanceId > 0
            ? `#${slot.agentInstanceId}`
            : "n/a";
        const taskId = String(task?.id || task?.task_id || "").trim();
        console.log(
          `[task-executor] :rocket: started: "${task.title}" (${slot.sdk}) agent=${agentId} branch=${slot.branch} worktree=${slot.worktreePath || "(pending)"}`,
        );
        if (agentEventBus) agentEventBus.onTaskStarted(task, slot);
        if (taskId) {
          queueWorkflowEvent(
            "task.assigned",
            {
              taskId,
              taskTitle: task?.title || "",
              taskStatus: "inprogress",
              sdk: slot?.sdk || null,
              branch: slot?.branch || null,
              worktreePath: slot?.worktreePath || null,
            },
            { dedupKey: `workflow-event:task.assigned:${taskId}` },
          );
          queueWorkflowEvent(
            "agent.started",
            {
              taskId,
              taskTitle: task?.title || "",
              sdk: slot?.sdk || null,
              branch: slot?.branch || null,
              agentInstanceId: slot?.agentInstanceId ?? null,
            },
            { dedupKey: `workflow-event:agent.started:${taskId}:${slot?.agentInstanceId ?? "na"}` },
          );
        }
      },
      onTaskCompleted: (task, result) => {
        const taskId = String(task?.id || task?.task_id || "").trim();
        const finalizationFailed =
          result?.finalized === false ||
          String(result?.finalizationReason || "").trim().toLowerCase() ===
            "no_commits";
        const branch = String(
          result?.branch ||
            task?.branchName ||
            task?.meta?.branch_name ||
            "",
        ).trim() || null;
        const worktreePath = String(
          result?.worktreePath ||
            task?.worktreePath ||
            task?.meta?.worktreePath ||
            "",
        ).trim() || null;
        const prNumber = result?.prNumber
          ? String(result.prNumber)
          : null;
        const prUrl = String(result?.prUrl || "").trim() || null;
        const baseBranch = String(
          result?.baseBranch ||
            task?.baseBranch ||
            task?.base_branch ||
            task?.meta?.base_branch ||
            "",
        ).trim() || null;
        console.log(
          finalizationFailed
            ? `[task-executor] :alert: completed without finalization: "${task.title}" (${result.attempts} attempt(s), reason=${result?.finalizationReason || "unknown"})`
            : `[task-executor] :check: completed: "${task.title}" (${result.attempts} attempt(s))`,
        );
        if (!finalizationFailed && agentEventBus) {
          agentEventBus.onTaskCompleted(task, result);
        } else if (!finalizationFailed) {
          // Fallback: queue review directly if event bus not ready
          if (reviewAgent && result.success) {
            try {
              reviewAgent.queueReview({
                id: task.id || task.task_id,
                title: task.title,
                branchName: task.branchName || task.meta?.branch_name,
                description: task.description || "",
                taskContext: task?._taskContextBlock || task?.meta?.taskContextBlock || "",
              });
            } catch {
              /* best-effort */
            }
          }
        }
        if (taskId) {
          if (finalizationFailed) {
            queueWorkflowEvent(
              "task.finalization_failed",
              {
                taskId,
                taskTitle: task?.title || "",
                taskStatus: "todo",
                attempts: Number(result?.attempts || 0),
                success: false,
                branch,
                worktreePath,
                prNumber,
                prUrl,
                baseBranch,
                reason: result?.finalizationReason || "unknown",
              },
              {
                dedupKey: `workflow-event:task.finalization_failed:${taskId}:${result?.attempts || 0}:${result?.finalizationReason || "unknown"}`,
              },
            );
          } else {
            queueWorkflowEvent(
              "task.completed",
              {
                taskId,
                taskTitle: task?.title || "",
                taskStatus: "completed",
                attempts: Number(result?.attempts || 0),
                success: result?.success !== false,
                branch,
                worktreePath,
                prNumber,
                prUrl,
                baseBranch,
              },
              { dedupKey: `workflow-event:task.completed:${taskId}:${result?.attempts || 0}` },
            );
          }
        }
      },
      onTaskFailed: (task, err) => {
        const taskId = String(task?.id || task?.task_id || "").trim();
        const branch = String(
          err?.branch ||
            task?.branchName ||
            task?.meta?.branch_name ||
            "",
        ).trim() || null;
        const worktreePath = String(
          err?.worktreePath ||
            task?.worktreePath ||
            task?.meta?.worktreePath ||
            "",
        ).trim() || null;
        const baseBranch = String(
          err?.baseBranch ||
            task?.baseBranch ||
            task?.base_branch ||
            task?.meta?.base_branch ||
            "",
        ).trim() || null;
        const attempts =
          Number(err?.attempts || 0) > 0 ? Number(err.attempts) : null;
        console.warn(
          `[task-executor] :close: failed: "${task.title}" — ${formatMonitorError(err)}`,
        );
        if (agentEventBus) agentEventBus.onTaskFailed(task, err);
        if (taskId) {
          const errorMessage = formatMonitorError(err);
          queueWorkflowEvent(
            "task.failed",
            {
              taskId,
              taskTitle: task?.title || "",
              taskStatus: "failed",
              error: errorMessage,
              branch,
              worktreePath,
              baseBranch,
              attempts,
            },
            { dedupKey: `workflow-event:task.failed:${taskId}:${errorMessage}` },
          );
          queueWorkflowEvent(
            "agent.crashed",
            {
              taskId,
              taskTitle: task?.title || "",
              error: errorMessage,
            },
            { dedupKey: `workflow-event:agent.crashed:${taskId}:${errorMessage}` },
          );
        }
      },
    };
    internalTaskExecutor = getTaskExecutor(execOpts);
    internalTaskExecutor.start();
    if (workflowOwnsTaskExecutorLifecycle) {
      scheduleStartupWorkflowRecovery(
        "startup-stale-dispatch-task-poll-unstick",
        () =>
          void runWorkflowRecoveryWithPolicy(
            "stale-dispatch-task-poll-unstick",
            async () => {
              await pollWorkflowSchedulesOnce("startup", {
                includeScheduled: false,
                requireEngine: true,
                throwOnError: true,
              });
              await runWorkflowOwnedTaskRecoveryPass(
                "startup-stale-dispatch-task-poll-unstick",
              );
            },
            {
              trigger: "startup",
              operationType: "stale-dispatch-task-poll-unstick",
              includeTaskPoll: true,
            },
          ),
        2,
      );
    }

    // Write executor slots to status file every 30s for Telegram /tasks
    startStatusFileWriter(30000);
    console.log(
      `[monitor] internal executor started (maxParallel=${execOpts.maxParallel || 3}, sdk=${execOpts.sdk || "auto"})`,
    );

    // ── Agent Endpoint ──
    try {
      const requestedAgentEndpointPort = resolveMonitorAgentEndpointPort(repoRoot);
      syncAgentEndpointPortEnv(requestedAgentEndpointPort);
      agentEndpoint = createAgentEndpoint({
        port: requestedAgentEndpointPort,
        allowConflictKill: parseEnvBoolean(
          process.env.BOSUN_AGENT_ENDPOINT_REAP_CONFLICTS,
          false,
        ),
        taskStore: {
          listTasks: (_projectId, { status } = {}) => {
            const normalized = String(status || "")
              .trim()
              .toLowerCase();
            if (!normalized) return getAllInternalTasks();
            return getInternalTasksByStatus(normalized);
          },
          getTask: (taskId) => getInternalTask(taskId),
          addTask: (taskData) => addInternalTask(taskData),
          updateTaskStatus: (taskId, status) =>
            setInternalTaskStatus(taskId, status, "agent-endpoint"),
          update: (taskId, updates) => updateInternalTask(taskId, updates),
          recordAgentAttempt: (taskId, info) =>
            recordAgentAttempt(taskId, info),
          recordErrorPattern: (taskId, pattern) =>
            recordErrorPattern(taskId, pattern),
        },
        getExecutorStatus: () => {
          if (!internalTaskExecutor) {
            return { running: false, paused: false, activeSlots: 0 };
          }
          return internalTaskExecutor.getStatus();
        },
        onPauseTasks: () => {
          if (!internalTaskExecutor) {
            return {
              paused: false,
              changed: false,
              reason: "executor-not-ready",
            };
          }
          const changed = internalTaskExecutor.pause();
          return {
            paused: true,
            changed,
            status: internalTaskExecutor.getStatus(),
          };
        },
        onResumeTasks: () => {
          if (!internalTaskExecutor) {
            return {
              paused: false,
              changed: false,
              reason: "executor-not-ready",
            };
          }
          const changed = internalTaskExecutor.resume();
          return {
            paused: internalTaskExecutor.isPaused(),
            changed,
            status: internalTaskExecutor.getStatus(),
          };
        },
        onTaskComplete: (taskId, body) => {
          console.log(`[monitor] agent self-reported complete for ${taskId}`);
          if (agentEventBus) {
            agentEventBus.onAgentComplete(taskId, body);
          } else {
            try {
              setInternalTaskStatus(taskId, "inreview", "agent-endpoint");
            } catch {
              /* best-effort */
            }
            if (reviewAgent) {
              const task = internalTaskExecutor?._activeSlots?.get(taskId);
              if (task)
                reviewAgent.queueReview({
                  id: taskId,
                  title: task.taskTitle,
                  prNumber: body?.prNumber,
                  branchName: task.branch,
                  description: body?.description || "",
                  taskContext: task.taskContext || task.taskContextBlock || "",
                });
            }
          }
        },
        onTaskError: (taskId, body) => {
          console.warn(
            `[monitor] agent self-reported error for ${taskId}: ${body?.error}`,
          );
          if (agentEventBus) {
            agentEventBus.onAgentError(taskId, body);
          } else if (errorDetector) {
            const classification = errorDetector.classify(
              body?.output || "",
              body?.error || "",
            );
            errorDetector.recordError(taskId, classification);
          }
        },
        onStatusChange: (taskId, newStatus) => {
          console.log(
            `[monitor] agent status change for ${taskId}: ${newStatus}`,
          );
          if (agentEventBus) {
            agentEventBus.onStatusChange(taskId, newStatus, "agent");
          } else {
            try {
              setInternalTaskStatus(taskId, newStatus, "agent-endpoint");
            } catch {
              /* best-effort */
            }
          }
        },
      });
      await agentEndpoint.start();
      syncAgentEndpointPortEnv(agentEndpoint.getPort());
      console.log(`[monitor] agent endpoint started on port ${agentEndpoint.getPort()}`);
    } catch (err) {
      console.warn(`[monitor] agent endpoint creation failed: ${err.message}`);
      agentEndpoint = null;
    }

    // ── Agent Event Bus ──
    try {
      agentEventBus = createAgentEventBus({
        errorDetector: errorDetector || undefined,
        sendTelegram:
          telegramToken && telegramChatId
            ? (msg, options) => void sendTelegramMessage(msg, options)
            : null,
        getTask: (taskId) => getInternalTask(taskId),
        setTaskStatus: (taskId, status, source) =>
          setInternalTaskStatus(taskId, status, source),
        updateTask: (taskId, updates) =>
          updateInternalTask(taskId, updates),
        retryReviewThreshold: Number(internalExecutorConfig?.retryReviewThreshold || 0),
        retryDelayMs: Number(internalExecutorConfig?.retryDelayMs || 15_000),
        onRetryThresholdExceeded: ({ taskId }) => {
          const normalizedTaskId = String(taskId || "").trim();
          if (!normalizedTaskId) return;
          const task = getInternalTask(normalizedTaskId);
          if (!task) return;
          redispatchInReviewTask(task, "retry-threshold-review-fix", {
            workflowEvent: "task.review_fix_requested",
          });
        },
        // broadcastUiEvent is wired later when UI server starts via
        // injectUiDependencies → setBroadcastFn pattern
      });
      agentEventBus.start();
      console.log("[monitor] agent event bus started");
    } catch (err) {
      console.warn(`[monitor] agent event bus failed: ${err.message}`);
      agentEventBus = null;
    }

    // ── Agent Supervisor ──
    try {
      agentSupervisor = createAgentSupervisor({
        sessionTracker: (() => {
          try { return getSessionTracker(); } catch { return null; }
        })(),
        errorDetector: errorDetector || undefined,
        eventBus: agentEventBus || undefined,
        sendTelegram:
          telegramToken && telegramChatId
            ? (msg, options) => void sendTelegramMessage(msg, options)
            : null,
        getTask: (taskId) => getInternalTask(taskId),
        setTaskStatus: (taskId, status, source) =>
          setInternalTaskStatus(taskId, status, source),
        updateTask: (taskId, updates) =>
          updateInternalTask(taskId, updates),
        assessIntervalMs: 30_000,
        // ── Intervention callbacks (steering, thread management) ──
        forceNewThread: (taskId, reason) => {
          console.log(`[monitor] supervisor forcing new thread for ${taskId}: ${reason}`);
          forceNewThread(taskId, reason);
        },
        injectPrompt: (taskId, prompt) => {
          if (hasActiveSession(taskId)) {
            console.log(`[monitor] supervisor steering active session for ${taskId}`);
            steerActiveThread(taskId, prompt);
          } else {
            console.warn(`[monitor] supervisor inject: no active session for ${taskId}, prompt dropped`);
          }
        },
        sendContinueSignal: (taskId) => {
          if (hasActiveSession(taskId)) {
            console.log(`[monitor] supervisor sending continue signal to ${taskId}`);
            steerActiveThread(taskId, "Continue executing your current task. Do NOT restart or re-read files you already processed.");
          } else {
            console.warn(`[monitor] supervisor continue: no active session for ${taskId}`);
          }
        },
        dispatchFixTask: (taskId, issues) => {
          const normalizedTaskId = String(taskId || "").trim();
          if (!normalizedTaskId) {
            return {
              dispatched: false,
              reason: "missing_task_id",
            };
          }
          const task = getInternalTask(normalizedTaskId);
          const issueList = Array.isArray(issues) ? issues : [];
          const issueCount = issueList.length;
          const status = String(task?.status || "").trim().toLowerCase();

          if (status && status !== "inreview") {
            console.warn(
              `[monitor] supervisor dispatch-fix skipped for ${normalizedTaskId}: status=${status}`,
            );
            return {
              dispatched: false,
              reason: "status_not_inreview",
              status,
              issueCount,
              taskId: normalizedTaskId,
              taskTitle: task?.title || normalizedTaskId,
            };
          }

          if (hasActiveSession(normalizedTaskId)) {
            const handoff = buildReviewFixTaskHandoff(
              task || { id: normalizedTaskId, title: normalizedTaskId },
              "review-fix-active-session",
              {
                mode: REVIEW_FIX_HANDOFF_MODES.ACTIVE_SESSION_STEERING,
                reviewIssues: issueList,
                workflowEvent: "task.review_fix_requested",
              },
            );
            persistReviewFixTaskHandoff(normalizedTaskId, handoff);
            console.log(
              `[monitor] supervisor dispatch-fix steering active session for ${normalizedTaskId} ` +
              `(mode=${handoff.mode} state=${handoff.taskPatch.reviewFixState})`,
            );
            steerActiveThread(normalizedTaskId, handoff.prompt);
            return {
              dispatched: true,
              mode: handoff.mode,
              issueCount: handoff.issueCount,
              taskId: normalizedTaskId,
              taskTitle: task?.title || normalizedTaskId,
            };
          }

          console.warn(
            `[monitor] supervisor dispatch-fix: no active session for ${normalizedTaskId}; ` +
            `re-dispatching inreview session with session rebind`,
          );
          redispatchInReviewTask(task || { id: normalizedTaskId, title: normalizedTaskId }, "review-fix-redispatch", {
            reviewIssueCount: issueCount,
            reviewIssues: issueList,
            workflowEvent: "task.review_fix_requested",
          });
          return {
            dispatched: true,
            mode: REVIEW_FIX_HANDOFF_MODES.REVIEW_REDISPATCH,
            issueCount,
            taskId: normalizedTaskId,
            taskTitle: task?.title || normalizedTaskId,
          };
        },
      });
      agentSupervisor.start();

      // Wire supervisor into event bus and review agent
      if (agentEventBus) agentEventBus.setSupervisor(agentSupervisor);

      console.log("[monitor] agent supervisor started");
    } catch (err) {
      console.warn(`[monitor] agent supervisor failed: ${err.message}`);
      agentSupervisor = null;
    }

    // ── Review Agent ──
    if (isReviewAgentEnabled()) {
      try {
        reviewAgent = createReviewAgent({
          maxConcurrentReviews: Number(
            process.env.INTERNAL_EXECUTOR_REVIEW_MAX_CONCURRENT ||
              internalExecutorConfig?.reviewMaxConcurrent ||
              2,
          ),
          reviewTimeoutMs: Number(
            process.env.INTERNAL_EXECUTOR_REVIEW_TIMEOUT_MS ||
              internalExecutorConfig?.reviewTimeoutMs ||
              300_000,
          ),
          sendTelegram:
            telegramToken && telegramChatId
              ? (msg, options) => void sendTelegramMessage(msg, options)
              : null,
          promptTemplate: agentPrompts?.reviewer,
          onReviewComplete: (taskId, result) => {
            const normalizedTaskId = String(taskId || "").trim();
            console.log(
              `[monitor] review complete for ${taskId}: ${result?.approved ? "approved" : "changes_requested"} — prMerged: ${result?.prMerged}`,
            );
            reviewGateResults.set(normalizedTaskId, {
              approved: result?.approved === true,
              reviewedAt: result?.reviewedAt || new Date().toISOString(),
            });
            try {
              setReviewResult(taskId, {
                approved: result?.approved ?? false,
                issues: result?.issues || [],
              });
            } catch {
              /* best-effort */
            }
            const pendingCtx = result?.approved
              ? dequeuePendingMergeStrategy(normalizedTaskId)
              : null;

            if (result?.approved && result?.prMerged) {
              // PR merged and reviewer happy — fully done
              console.log(
                `[monitor] review approved + PR merged — marking ${taskId} as done`,
              );
              try {
                setInternalTaskStatus(taskId, "done", "review-agent");
              } catch {
                /* best-effort */
              }
              try {
                updateTaskStatus(taskId, "done");
              } catch {
                /* best-effort */
              }
            } else if (result?.approved && !result?.prMerged) {
              // Approved but PR not yet merged — stays in review
              console.log(
                `[monitor] review approved but PR not merged — ${taskId} stays inreview`,
              );
              void triggerFlowPostReviewMerge(taskId, {
                taskTitle: pendingCtx?.taskTitle || getInternalTask(taskId)?.title || taskId,
                taskDescription: pendingCtx?.taskDescription || "",
                branch: pendingCtx?.branch || "",
                prNumber: pendingCtx?.prNumber || null,
                prUrl: pendingCtx?.prUrl || "",
                repoSlug:
                  pendingCtx?.repoSlug ||
                  resolveTaskRepoSlug(getInternalTask(taskId), pendingCtx || {}),
              });
            } else {
              console.log(
                `[monitor] review found ${result?.issues?.length || 0} issue(s) for ${taskId} — task stays inreview`,
              );
              if (pendingMergeStrategyByTask.has(normalizedTaskId)) {
                console.log(
                  `[monitor] flow gate remains active for ${taskId} — merge strategy stays deferred`,
                );
              }
            }
          },
        });
        reviewAgent.start();

        // Connect review agent to supervisor for review enforcement
        if (agentSupervisor) {
          reviewAgent.setSupervisor(agentSupervisor);
        }

        // Connect review agent to task executor for handoff
        if (internalTaskExecutor) {
          internalTaskExecutor.setReviewAgent(reviewAgent);
        }

        // Re-hydrate inreview tasks after restart so review queue is not empty
        // while task-store still reports tasks awaiting review.
        try {
          const pending = getTasksPendingReview();
          if (Array.isArray(pending) && pending.length > 0) {
            let requeued = 0;
            let redispatchedMissingRefs = 0;
            let skippedReviewed = 0;
            for (const task of pending) {
              const taskId = String(task?.id || "").trim();
              if (!taskId) continue;
              const reviewStatus = String(task?.reviewStatus || "").trim().toLowerCase();
              if (hasCurrentReviewVerdict(task)) {
                if (
                  reviewStatus === "changes_requested" &&
                  !hasActiveSession(taskId) &&
                  !isReviewRedispatchCoolingDown(taskId)
                ) {
                  redispatchInReviewTask(task, "review-agent-rehydrate-review-fix", {
                    workflowEvent: "task.review_fix_requested",
                  });
                  redispatchedMissingRefs += 1;
                  continue;
                }
                skippedReviewed += 1;
                continue;
              }
              const branchName = String(task?.branchName || "").trim();
              let prUrl = String(task?.prUrl || "").trim();
              let prNumber = String(task?.prNumber || "").trim();
              const taskRepoSlug = resolveTaskRepoSlug(task, {
                prUrl,
                prNumber,
                branch: branchName,
              });
              if (!prUrl && !prNumber && branchName) {
                let existingPr = await findExistingPrForBranchInRepo(
                  branchName,
                  taskRepoSlug,
                );
                if (!existingPr) {
                  existingPr = await findExistingPrForBranchApiInRepo(
                    branchName,
                    taskRepoSlug,
                  );
                }
                if (existingPr?.number) {
                  prNumber = String(existingPr.number).trim();
                  prUrl = String(existingPr.url || "").trim();
                  try {
                    updateInternalTask(taskId, {
                      branchName,
                      prNumber: parsePositivePrNumber(prNumber),
                      prUrl: prUrl || undefined,
                    });
                  } catch {
                    /* best-effort */
                  }
                }
              }
              if (!prUrl && prNumber) {
                prUrl = `${getRepoUrlBaseForSlug(taskRepoSlug)}/pull/${prNumber}`;
              }
              const hasReviewReference = Boolean(prUrl || prNumber);
              if (!hasReviewReference) {
                console.warn(
                  `[monitor] review rehydrate redispatch ${taskId}: missing prUrl/prNumber`,
                );
                redispatchInReviewTask(task, "review-agent-rehydrate", {
                  branch: branchName || null,
                });
                redispatchedMissingRefs += 1;
                continue;
              }
              await reviewAgent.queueReview({
                id: taskId,
                title: task?.title || taskId,
                branchName,
                prUrl,
                prNumber,
                repoSlug: taskRepoSlug || undefined,
                description: task?.description || "",
                taskContext: task?._taskContextBlock || task?.meta?.taskContextBlock || "",
                worktreePath: null,
                sessionMessages: "",
                diffStats: "",
              });
              requeued += 1;
            }
            if (requeued > 0) {
              console.log(
                `[monitor] review agent rehydrated ${requeued} inreview task(s) from task-store`,
              );
            }
            if (redispatchedMissingRefs > 0) {
              console.warn(
                `[monitor] review agent redispatched ${redispatchedMissingRefs} inreview task(s) with missing review references`,
              );
            }
            if (skippedReviewed > 0) {
              console.log(
                `[monitor] review agent skipped ${skippedReviewed} already-reviewed inreview task(s) during rehydrate`,
              );
            }
          }
        } catch (err) {
          console.warn(
            `[monitor] review agent rehydrate failed: ${err.message || err}`,
          );
        }

        console.log("[monitor] review agent started");

        // Wire review agent into event bus
        if (agentEventBus) {
          agentEventBus._reviewAgent = reviewAgent;
        }
      } catch (err) {
        console.warn(`[monitor] review agent failed to start: ${err.message}`);
      }
    } else {
      reviewAgent = null;
      console.log(
        "[monitor] review agent disabled (INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED=0 or config override)",
      );
    }

    // ── Sync Engine ──
    // Sync engine lifecycle is now managed by the template-sync-engine workflow.
    // The workflow fires on `sync.requested` events instead of a fixed-interval timer.

  } catch (err) {
    console.error(
      `[monitor] internal executor failed to start: ${err.message}`,
    );
  }
}

if (isExecutorDisabled()) {
  // Already logged above
} else {
  console.log("[monitor] executor mode = internal");
}
if (telegramCommandEnabled) {
  startTelegramCommandListener();
}
// Restore live digest state BEFORE any messages flow — so restarts continue the
// existing digest message instead of creating a new one.
// Chain notifier start after restore to prevent race conditions.
// Also initialise the pinned status board (creates/restores the persistent message).
runDetached("telegram-bootstrap:restore-digest-notifier-status", async () => {
  await restoreLiveDigest().catch(() => {});
  await startTelegramNotifier();
  await initStatusBoard().catch(() => {});
});

// ── Start agent work analyzer and alert tailer ─────────────────────────────
startAgentWorkAnalyzer();
startAgentAlertTailer();

// ── Two-way Telegram :workflow: primary agent ────────────────────────────────────────
injectMonitorFunctions({
  sendTelegramMessage,
  readStatusData,
  readStatusSummary,
  getCurrentChild: () => currentChild,
  startProcess,
  requestFullBosunRestart: requestManualFullRestart,
  getRepoRoot: () => repoRoot,
  startFreshSession,
  attemptFreshSessionRetry,
  buildRetryPrompt,
  getActiveAttemptInfo,
  reconcileTaskStatuses,
  getAnomalyReport: () => getAnomalyStatusReport(),
  getInternalExecutor: () => internalTaskExecutor,
  getExecutorMode: () => executorMode,
  getAgentEndpoint: () => agentEndpoint,
  getAgentEventBus: () => agentEventBus,
  getReviewAgent: () => reviewAgent,
  getAgentSupervisor: () => agentSupervisor,
  getReviewAgentEnabled: () => isReviewAgentEnabled(),
  getSyncEngine: () => syncEngine,
  getErrorDetector: () => errorDetector,
  getTuiMonitorStats: () => _getTuiMonitorStatsForPortal(),
  getWorkspaceMonitor: () => workspaceMonitor,
  getTaskStoreStats: () => {
    try {
      return getTaskStoreStats();
    } catch {
      return null;
    }
  },
  getTasksPendingReview: () => {
    try {
      return getTasksPendingReview();
    } catch {
      return [];
    }
  },
  triggerTaskPlanner,
  telegramUiRuntime: createTelegramUiRuntime(),
});
const portalWantsStart =
  ["1", "true", "yes"].includes(String(process.env.TELEGRAM_MINIAPP_ENABLED || "").toLowerCase()) ||
  Number(process.env.TELEGRAM_UI_PORT || "0") > 0;
if (telegramBotEnabled || portalWantsStart) {
  runDetached("telegram-bot:start-startup", () =>
    startTelegramSurfaceAndBot(getTelegramBotStartOptions()));

  // Process any commands queued by telegram-sentinel while monitor was down
  try {
    const { getQueuedCommands } = await import("../telegram/telegram-sentinel.mjs");
    const queued = getQueuedCommands();
    if (queued && queued.length > 0) {
      console.log(
        `[monitor] processing ${queued.length} queued sentinel command(s)`,
      );
      for (const cmd of queued) {
        try {
          console.log(
            `[monitor] replaying sentinel command: ${cmd.command || cmd.type || JSON.stringify(cmd)}`,
          );
          // Handle known commands
          if (cmd.command === "/status" || cmd.type === "status") {
            // Will be covered by next status report
            console.log(
              "[monitor] sentinel queued /status — will send on next cycle",
            );
          } else if (cmd.command === "/pause" || cmd.type === "pause") {
            console.log(
              "[monitor] sentinel queued /pause — pausing task dispatch",
            );
            // Signal pause if task executor supports it
          } else if (cmd.command === "/resume" || cmd.type === "resume") {
            console.log("[monitor] sentinel queued /resume — resuming");
          }
        } catch (cmdErr) {
          console.warn(
            `[monitor] failed to process queued command: ${cmdErr.message}`,
          );
        }
      }
    }
  } catch {
    // telegram-sentinel not available — ignore
  }
}

// ── Start WhatsApp channel (when configured) ──────────────────────────────────
if (isWhatsAppEnabled()) {
  try {
    await startWhatsAppChannel({
      onMessage: async (msg) => {
        // Route WhatsApp messages to primary agent (same as Telegram user messages)
        if (primaryAgentReady && msg.text) {
          try {
            const response = await execPrimaryPrompt(msg.text);
            if (response) {
              await notifyWhatsApp(response);
            }
          } catch (err) {
            console.warn(`[monitor] WhatsApp→agent failed: ${err.message}`);
          }
        }
      },
      onStatusChange: (status) => {
        console.log(`[monitor] WhatsApp status: ${status}`);
      },
      logger: (level, ...args) => console.log(`[whatsapp] [${level}]`, ...args),
    });
    console.log("[monitor] WhatsApp channel started");
  } catch (err) {
    console.warn(`[monitor] WhatsApp channel failed to start: ${err.message}`);
  }
}

// ── Container runtime initialization (when configured) ────────────────────
if (isContainerEnabled()) {
  try {
    await ensureContainerRuntime();
    await cleanupOrphanedContainers();
    console.log("[monitor] Container runtime ready:", getContainerStatus());
  } catch (err) {
    console.warn(`[monitor] Container runtime not available: ${err.message}`);
    console.warn(
      "[monitor] Container isolation will be disabled for this session",
    );
  }
}

// ── Start PR Watchdog & Kanban Sync handled by workflow templates ────────────
// PR conflict resolution, CI repair, and GitHub↔kanban sync are now managed
// by the BOSUN_PR_WATCHDOG_TEMPLATE and GITHUB_KANBAN_SYNC_TEMPLATE workflows.
} else {
  console.log(
    "[monitor] test runtime detected (VITEST/NODE_ENV=test) — runtime services disabled",
  );
}

// ── Named exports for testing ───────────────────────────────────────────────
export {
  updateTaskStatus,
  reconcileTaskStatuses,
  safeRecoverTask,
  recoverySkipCache,
  getTaskAgeMs,
  classifyConflictedFiles,
  AUTO_RESOLVE_THEIRS,
  AUTO_RESOLVE_OURS,
  AUTO_RESOLVE_LOCK_EXTENSIONS,
  extractScopeFromTitle,
  resolveUpstreamFromConfig,
  extractAcceptanceCriteriaFromTask,
  shouldSmartPrCreatePrForAssessmentAction,
  rebaseDownstreamTasks,
  runTaskAssessment,
  // Internal executor
  internalTaskExecutor,
  // Task management subsystems
  agentEndpoint,
  reviewAgent,
  syncEngine,
  errorDetector,
  // Fleet coordination re-exports for external consumers
  getFleetState,
  isFleetCoordinator,
  getFleetMode,
  formatFleetSummary,
  buildExecutionWaves,
  calculateBacklogDepth,
  detectMaintenanceMode,
  appendKnowledgeEntry,
  buildKnowledgeEntry,
  formatKnowledgeSummary,
  formatCodexResult,
  // Container runner re-exports
  getContainerStatus,
  isContainerEnabled,
  dispatchWorkflowEvent,
  // Workflow event bridge — for fleet/kanban modules to emit events
  queueWorkflowEvent,
};
