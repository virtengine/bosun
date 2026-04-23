/**
 * @module task-executor
 * @description Internal Task Executor — runs agents locally using the SDK agent pool.
 * Composes kanban-adapter, agent-pool,
 * and worktree-manager to provide full task lifecycle management with configurable
 * parallelism, SDK selection, and thread persistence/resume.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  existsSync,
  appendFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import {
  getKanbanAdapter,
  getKanbanBackendName,
  listTasks,
  listProjects,
  getTask,
  updateTaskStatus as updateKanbanTaskStatus,
  addComment,
} from "../kanban/kanban-adapter.mjs";
import {
  listTaskAttachments,
  mergeTaskAttachments,
} from "./task-attachments.mjs";
import {
  launchOrResumeThread,
  execWithRetry,
  invalidateThread,
  forceNewThread,
  pruneAllExhaustedThreads,
  getActiveThreads,
  getPoolSdkName,
  ensureThreadRegistryLoaded,
} from "../agent/agent-pool.mjs";
import {
  WorktreeManager,
  getWorktreeStats,
} from "../workspace/worktree-manager.mjs";
import {
  loadConfig,
  ExecutorScheduler,
  loadExecutorConfig,
} from "../config/config.mjs";
import { resolvePromptTemplate } from "../agent/agent-prompts.mjs";
import {
  loadStore as loadTaskStore,
  setTaskStatus as setInternalStatus,
  recordAgentAttempt,
  recordErrorPattern,
  setTaskCooldown,
  clearTaskCooldown,
  isTaskCoolingDown,
  updateTask as updateInternalTask,
  getTask as getInternalTask,
  getAllTasks as getAllInternalTasks,
  addTask as addInternalTask,
} from "./task-store.mjs";
import { createErrorDetector } from "../infra/error-detector.mjs";
import { getSessionTracker } from "../infra/session-tracker.mjs";
import { getCurrentTraceContext, traceTaskExecution } from "../infra/tracing.mjs";
import {
  getCompactDiffSummary,
  getRecentCommits,
  collectDiffStats,
} from "../git/diff-stats.mjs";
import {
  getBosunCoAuthorTrailer,
  shouldAddBosunCoAuthor,
} from "../git/git-commit-helpers.mjs";
import { createAnomalyDetector } from "../infra/anomaly-detector.mjs";
import { normalizeDedupKey, yieldToEventLoop, withRetry } from "../utils.mjs";
import {
  resolveExecutorForTask,
  executorToSdk,
  formatComplexityDecision,
  normalizeExecutorKey,
} from "./task-complexity.mjs";
import {
  evaluateBranchSafetyForPush,
  normalizeBaseBranch,
  sanitizeGitEnv,
} from "../git/git-safety.mjs";
import {
  loadHooks,
  registerBuiltinHooks,
  executeHooks,
  executeBlockingHooks,
} from "../agent/agent-hooks.mjs";
import {
  initTaskClaims,
  claimTask,
  renewClaim,
  getClaim,
  releaseTask as releaseTaskClaim,
} from "./task-claims.mjs";
import { initPresence, getPresenceState } from "../infra/presence.mjs";
import { getSharedState } from "../workspace/shared-state-manager.mjs";
import {
  createExecutionPipeline as createTaskExecutionPipeline,
  runExecutionPipeline as runTaskExecutionPipeline,
  runExecutionPipelineAgent,
} from "./task-executor-pipeline.mjs";

// ── Constants ───────────────────────────────────────────────────────────────

const TAG = "[task-executor]";
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const CONTEXT_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const GRACEFUL_SHUTDOWN_MS = 5 * 60_000; // 5 minutes — give agents time to commit/push
const MAX_NO_COMMIT_ATTEMPTS = 3; // Stop picking up a task after N consecutive no-commit completions
const NO_COMMIT_COOLDOWN_BASE_MS = 15 * 60 * 1000; // 15 minutes base cooldown for no-commit
const NO_COMMIT_MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const CLAIM_CONFLICT_COMMENT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const LIST_TASKS_CACHE_TTL_MS = 5000;
const LIST_TASKS_CACHE_MAX_ENTRIES = 12;
const REPO_AREA_SLOW_MERGE_LATENCY_MS = 4 * 60 * 60 * 1000;
const REPO_AREA_VERY_SLOW_MERGE_LATENCY_MS = 8 * 60 * 60 * 1000;
const REPO_AREA_STARVATION_WAIT_MS = 2 * 60 * 1000;
const REPO_AREA_STARVATION_BLOCKED_CYCLES = 3;
const REPO_AREA_CONTENTION_EVENT_LIMIT = 60;
const WORKFLOW_ACTIVE_RUNS_INDEX = "_active-runs.json";
const WORKFLOW_RUNS_HISTORY_INDEX = "index.json";
const ACTIVE_WORKFLOW_RUN_STATUSES = new Set([
  "running",
  "queued",
  "pending",
  "inprogress",
  "in_progress",
  "active",
]);
const TERMINAL_WORKFLOW_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "blocked",
  "done",
  "success",
  "stale",
]);
const FATAL_CLAIM_RENEW_ERRORS = new Set([
  "task_claimed_by_different_instance",
  "claim_token_mismatch",
  "task_not_claimed",
  // Shared-state token mismatches — another orchestrator instance has taken
  // over the task in the shared state registry.  Treat exactly the same as a
  // direct claim-token mismatch: abort the now-orphaned local agent.
  "attempt_token_mismatch",
  "owner_mismatch",
]);
const CODEX_TASK_LABELS = (() => {
  const raw = String(
    process.env.BOSUN_TASK_LABELS || "bosun,codex-mointor",
  );
  const labels = raw
    .split(",")
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean);
  return new Set(labels.length > 0 ? labels : ["bosun"]);
})();
const EXPECTED_NO_COMMIT_LABELS = new Set([
  "no-code-change-expected",
  "analysis-only",
  "diagnostic",
  "preflight",
]);
const EXPECTED_NO_COMMIT_TAGS = new Set([
  "no-code-change-expected",
  "analysis-only",
  "diagnostic",
  "preflight",
]);

/** @type {null|((taskId: string, status: string, options?: object) => Promise<boolean>|boolean)} */
let taskStatusTransitionHandler = null;

export function setTaskStatusTransitionHandler(handler) {
  taskStatusTransitionHandler = typeof handler === "function" ? handler : null;
}

function hasExternalTaskStatusTransitionHandler() {
  return typeof taskStatusTransitionHandler === "function";
}

async function transitionTaskStatus(taskId, status, options = {}) {
  if (hasExternalTaskStatusTransitionHandler()) {
    const result = await taskStatusTransitionHandler(taskId, status, options);
    return result !== false;
  }
  await updateKanbanTaskStatus(taskId, status, options);
  return true;
}

function transitionInternalTaskStatus(taskId, status, source) {
  if (hasExternalTaskStatusTransitionHandler()) return null;
  return setInternalStatus(taskId, status, source);
}

function isMatchingLocalClaimProcessAlive(ownerId, claim) {
  if (!ownerId || !claim) return null;
  const claimInstanceId = String(claim.instance_id || claim.instanceId || "");
  if (!claimInstanceId || claimInstanceId !== String(ownerId)) return null;
  const claimHost = String(claim?.metadata?.host || "").trim();
  if (!claimHost || claimHost.toLowerCase() !== os.hostname().toLowerCase()) {
    return null;
  }
  const claimPid = Number(claim?.metadata?.pid);
  if (!Number.isFinite(claimPid) || claimPid <= 0) return null;
  try {
    process.kill(Math.floor(claimPid), 0);
    return true;
  } catch {
    return false;
  }
}

function parseNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function isDisabledFlag(value) {
  return ["0", "false", "no", "off"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

function isFlowReviewGateRequired(defaultValue = true) {
  const primaryRaw = process.env.BOSUN_FLOW_PRIMARY;
  if (primaryRaw !== undefined && String(primaryRaw).trim() !== "") {
    if (isDisabledFlag(primaryRaw)) return false;
  }

  const reviewRaw = process.env.BOSUN_FLOW_REQUIRE_REVIEW;
  if (reviewRaw !== undefined && String(reviewRaw).trim() !== "") {
    return !isDisabledFlag(reviewRaw);
  }

  return defaultValue;
}

function sanitizePathSegment(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function truncateText(text, maxChars) {
  const raw = String(text || "");
  if (!maxChars || raw.length <= maxChars) return raw;
  return `${raw.slice(0, Math.max(0, maxChars - 3))}...`;
}

function sanitizeRepoContextText(text) {
  return String(text || "")
    .replace(/\0/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function truncateUtf8Bytes(text, maxBytes = 12000) {
  const raw = String(text || "");
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";

  const suffix = "\n...(truncated)";
  if (Buffer.byteLength(raw, "utf8") <= maxBytes) {
    return raw;
  }

  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (maxBytes <= suffixBytes) {
    return suffix.slice(0, Math.max(0, maxBytes));
  }

  const targetBytes = maxBytes - suffixBytes;
  let low = 0;
  let high = raw.length;
  let best = "";

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = raw.slice(0, mid);
    if (Buffer.byteLength(candidate, "utf8") <= targetBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return `${best}${suffix}`;
}

function normalizeRepoAreaKey(value) {
  return String(value || "").trim().toLowerCase();
}

function extractRepoAreasFromTaskLike(task) {
  const values = [];
  const pushValues = (input) => {
    if (!input) return;
    if (Array.isArray(input)) {
      for (const entry of input) pushValues(entry);
      return;
    }
    const normalized = normalizeRepoAreaKey(input);
    if (!normalized) return;
    values.push(normalized);
  };

  pushValues(task?.repo_areas);
  pushValues(task?.repoAreas);
  pushValues(task?.meta?.repo_areas);
  pushValues(task?.meta?.repoAreas);
  pushValues(task?.task?.repo_areas);
  pushValues(task?.task?.repoAreas);
  pushValues(task?.task?.meta?.repo_areas);
  pushValues(task?.task?.meta?.repoAreas);

  return [...new Set(values)].slice(0, 10);
}

function normalizeRepoAreaTelemetryEntry(raw = {}) {
  const recentOutcomes = Array.isArray(raw?.recentOutcomes)
    ? raw.recentOutcomes
      .map((value) => Number(value))
      .filter((value) => value === 0 || value === 1)
      .slice(-20)
    : [];
  const mergeLatencySamples = Array.isArray(raw?.mergeLatencySamples)
    ? raw.mergeLatencySamples
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .slice(-12)
    : [];
  return {
    conflictCount: Math.max(0, Math.trunc(Number(raw?.conflictCount || 0))),
    totalWaitMs: Math.max(0, Math.trunc(Number(raw?.totalWaitMs || 0))),
    lastWaitMs: Math.max(0, Math.trunc(Number(raw?.lastWaitMs || 0))),
    maxWaitMs: Math.max(0, Math.trunc(Number(raw?.maxWaitMs || 0))),
    lastBlockedAt: Math.max(0, Math.trunc(Number(raw?.lastBlockedAt || 0))),
    lastOutcomeAt: Math.max(0, Math.trunc(Number(raw?.lastOutcomeAt || 0))),
    recentOutcomes,
    mergeLatencySamples,
  };
}

function createEmptyRepoAreaTelemetryEntry() {
  return normalizeRepoAreaTelemetryEntry();
}

function normalizeRepoAreaResolutionReason(value, fallback = "resolved") {
  const normalized = normalizeRepoAreaKey(value);
  return normalized || fallback;
}

function averageNumbers(values = []) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + Number(value || 0), 0);
  return total / values.length;
}

function buildRepoAreaAdaptiveSignals(entry, baseLimit) {
  const normalizedBase = Number(baseLimit || 0);
  const outcomes = Array.isArray(entry?.recentOutcomes) ? entry.recentOutcomes : [];
  const failures = outcomes.reduce((sum, value) => sum + (Number(value) > 0 ? 1 : 0), 0);
  const samples = outcomes.length;
  const failureRate = samples > 0 ? failures / samples : 0;
  const mergeLatencyAvgMs = averageNumbers(entry?.mergeLatencySamples || []);
  const adaptiveReasons = [];
  if (samples >= 4 && failureRate >= 0.5) adaptiveReasons.push("failure_rate");
  if (
    (entry?.mergeLatencySamples?.length || 0) >= 3 &&
    mergeLatencyAvgMs >= REPO_AREA_SLOW_MERGE_LATENCY_MS
  ) {
    adaptiveReasons.push("merge_latency");
  }
  const adaptivePenalty =
    normalizedBase > 1 && adaptiveReasons.length > 0 ? 1 : 0;
  const effectiveLimit =
    normalizedBase > 0
      ? Math.max(1, normalizedBase - adaptivePenalty)
      : 0;
  return {
    recentSamples: samples,
    failureRate,
    mergeLatencyAvgMs,
    adaptivePenalty,
    adaptiveReasons,
    effectiveLimit,
    severeMergeLatency:
      (entry?.mergeLatencySamples?.length || 0) >= 3 &&
      mergeLatencyAvgMs >= REPO_AREA_VERY_SLOW_MERGE_LATENCY_MS,
  };
}

function computeRepoAreaAdaptiveState({
  configuredLimit = 0,
  signal = null,
  telemetry = null,
  historicalAdaptive = null,
} = {}) {
  const normalizedConfiguredLimit = Math.max(
    0,
    Math.trunc(Number(configuredLimit || 0)),
  );
  const normalizedSignal = signal && typeof signal === "object"
    ? signal
    : {
      active: 0,
      retrying: 0,
      mergeLatencyMsTotal: 0,
      mergeLatencySamples: 0,
      maxMergeLatencyMs: 0,
    };
  const normalizedTelemetry = normalizeRepoAreaTelemetryEntry(telemetry);
  const normalizedHistorical = historicalAdaptive || buildRepoAreaAdaptiveSignals(
    normalizedTelemetry,
    normalizedConfiguredLimit,
  );

  const activeFailureRate =
    normalizedSignal.active > 0
      ? normalizedSignal.retrying / normalizedSignal.active
      : 0;
  const outcomeFailures = normalizedTelemetry.recentOutcomes.reduce(
    (sum, value) => sum + (Number(value) > 0 ? 1 : 0),
    0,
  );
  const outcomeFailureRate =
    normalizedTelemetry.recentOutcomes.length > 0
      ? outcomeFailures / normalizedTelemetry.recentOutcomes.length
      : 0;
  const averageMergeLatencyMs =
    normalizedSignal.mergeLatencySamples > 0
      ? normalizedSignal.mergeLatencyMsTotal / normalizedSignal.mergeLatencySamples
      : 0;
  const telemetryMergeLatencyMs = averageNumbers(
    normalizedTelemetry.mergeLatencySamples,
  );
  const adaptiveFailureRate = Math.max(activeFailureRate, outcomeFailureRate);
  const adaptiveMergeLatencyMs = Math.max(
    averageMergeLatencyMs,
    telemetryMergeLatencyMs,
  );

  const adaptiveReasons = new Set(normalizedHistorical.adaptiveReasons || []);
  let penalty = 0;
  if (
    (normalizedSignal.active > 0 || normalizedTelemetry.recentOutcomes.length >= 4) &&
    adaptiveFailureRate >= 0.5
  ) {
    penalty += 1;
    adaptiveReasons.add("failure_rate");
    if (normalizedSignal.active > 0 && activeFailureRate >= 0.5) {
      adaptiveReasons.add("active_failure_rate");
    }
    if (normalizedTelemetry.recentOutcomes.length >= 4 && outcomeFailureRate >= 0.5) {
      adaptiveReasons.add("outcome_failure_rate");
    }
  }
  if (
    (normalizedSignal.active > 0 ||
      normalizedTelemetry.mergeLatencySamples.length >= 3) &&
    adaptiveMergeLatencyMs >= REPO_AREA_SLOW_MERGE_LATENCY_MS
  ) {
    penalty += 1;
    adaptiveReasons.add("merge_latency");
    if (
      normalizedSignal.active > 0 &&
      averageMergeLatencyMs >= REPO_AREA_SLOW_MERGE_LATENCY_MS
    ) {
      adaptiveReasons.add("active_merge_latency");
    }
    if (
      normalizedTelemetry.mergeLatencySamples.length >= 3 &&
      telemetryMergeLatencyMs >= REPO_AREA_SLOW_MERGE_LATENCY_MS
    ) {
      adaptiveReasons.add("historical_merge_latency");
    }
  }
  if (
    (normalizedSignal.active > 1 || normalizedTelemetry.recentOutcomes.length >= 6) &&
    adaptiveFailureRate >= 0.75 &&
    adaptiveMergeLatencyMs >= REPO_AREA_VERY_SLOW_MERGE_LATENCY_MS
  ) {
    penalty += 1;
    adaptiveReasons.add("severe_lock_pressure");
  }

  const liveLimit =
    normalizedConfiguredLimit > 0
      ? Math.max(
        1,
        normalizedConfiguredLimit -
          Math.min(normalizedConfiguredLimit - 1, penalty),
      )
      : 0;
  const effectiveLimit =
    normalizedConfiguredLimit > 0
      ? Math.min(normalizedHistorical.effectiveLimit, liveLimit)
      : 0;

  return {
    activeFailureRate,
    outcomeFailureRate,
    adaptiveFailureRate,
    averageMergeLatencyMs,
    telemetryMergeLatencyMs,
    adaptiveMergeLatencyMs,
    adaptivePenalty: Math.max(
      0,
      normalizedConfiguredLimit > 0
        ? normalizedConfiguredLimit - effectiveLimit
        : 0,
    ),
    adaptiveReasons: Array.from(adaptiveReasons),
    historicalFailureRate: normalizedHistorical.failureRate,
    historicalMergeLatencyMs: normalizedHistorical.mergeLatencyAvgMs,
    effectiveLimit,
    liveLimit,
  };
}

function buildRepoAreaWaitingCounts(blockedTasks = new Map()) {
  const waitingCounts = new Map();
  for (const blocked of blockedTasks.values()) {
    const areas = Array.isArray(blocked?.areas) ? blocked.areas : [];
    for (const area of areas) {
      const areaKey = normalizeRepoAreaKey(area);
      if (!areaKey) continue;
      waitingCounts.set(areaKey, (waitingCounts.get(areaKey) || 0) + 1);
    }
  }
  return waitingCounts;
}

function buildRepoAreaLockStatusSnapshot({
  repoAreaParallelLimit = 0,
  activeSlots = [],
  telemetryByArea = new Map(),
  blockedTasks = new Map(),
  dispatchCycles = 0,
  totalConflicts = 0,
} = {}) {
  const baseLimit = Math.max(0, Math.trunc(Number(repoAreaParallelLimit || 0)));
  const activeCounts = new Map();
  for (const slot of activeSlots) {
    const areas = extractRepoAreasFromTaskLike(slot);
    for (const area of areas) {
      activeCounts.set(area, (activeCounts.get(area) || 0) + 1);
    }
  }

  const waitingCounts = buildRepoAreaWaitingCounts(blockedTasks);
  const allAreas = new Set([
    ...activeCounts.keys(),
    ...waitingCounts.keys(),
    ...telemetryByArea.keys(),
  ]);

  const areas = {};
  const hotAreas = [];
  for (const area of Array.from(allAreas).sort()) {
    const telemetry = normalizeRepoAreaTelemetryEntry(telemetryByArea.get(area));
    const adaptive = buildRepoAreaAdaptiveSignals(telemetry, baseLimit);
    const snapshot = {
      baseLimit,
      effectiveLimit: adaptive.effectiveLimit,
      active: activeCounts.get(area) || 0,
      waiting: waitingCounts.get(area) || 0,
      conflictCount: telemetry.conflictCount,
      totalWaitMs: telemetry.totalWaitMs,
      lastWaitMs: telemetry.lastWaitMs,
      maxWaitMs: telemetry.maxWaitMs,
      failureRate: adaptive.failureRate,
      mergeLatencyAvgMs: adaptive.mergeLatencyAvgMs,
      recentSamples: adaptive.recentSamples,
      adaptivePenalty: adaptive.adaptivePenalty,
      adaptiveReasons: adaptive.adaptiveReasons,
      severeMergeLatency: adaptive.severeMergeLatency,
      lastBlockedAt: telemetry.lastBlockedAt,
      lastOutcomeAt: telemetry.lastOutcomeAt,
    };
    areas[area] = snapshot;
    hotAreas.push({ area, ...snapshot });
  }

  hotAreas.sort((a, b) => {
    if (b.waiting !== a.waiting) return b.waiting - a.waiting;
    if (b.adaptivePenalty !== a.adaptivePenalty) {
      return b.adaptivePenalty - a.adaptivePenalty;
    }
    if (b.conflictCount !== a.conflictCount) return b.conflictCount - a.conflictCount;
    return a.area.localeCompare(b.area);
  });

  return {
    enabled: baseLimit > 0,
    baseLimit,
    dispatchCycles: Math.max(0, Math.trunc(Number(dispatchCycles || 0))),
    totalConflicts: Math.max(0, Math.trunc(Number(totalConflicts || 0))),
    waitingTasks: blockedTasks.size,
    areas,
    hotAreas: hotAreas.slice(0, 5),
  };
}

function isBosunStateComment(text) {
  const raw = String(text || "").toLowerCase();
  if (!raw) return false;
  return raw.includes("bosun-state") || raw.includes("codex:ignore");
}

function normalizeTaskComments(task, maxComments, maxChars) {
  const rawComments = Array.isArray(task?.comments)
    ? task.comments
    : Array.isArray(task?.meta?.comments)
      ? task.meta.comments
      : [];
  const normalized = rawComments
    .map((comment) => {
      if (comment == null) return null;
      const body = typeof comment === "string"
        ? comment
        : comment.body || comment.text || comment.content || "";
      const trimmed = String(body || "").trim();
      if (!trimmed || isBosunStateComment(trimmed)) return null;
      return {
        id: typeof comment === "object" ? comment.id || null : null,
        author: typeof comment === "object"
          ? comment.author || comment.user || comment.by || null
          : null,
        createdAt: typeof comment === "object"
          ? comment.createdAt || comment.created_at || null
          : null,
        body: truncateText(trimmed.replace(/\s+/g, " "), maxChars),
      };
    })
    .filter(Boolean);
  if (!Number.isFinite(maxComments) || maxComments <= 0) return [];
  if (normalized.length <= maxComments) return normalized;
  return normalized.slice(-maxComments);
}

function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return "";
  const value = Number(bytes);
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(
    units.length - 1,
    Math.floor(Math.log(value) / Math.log(1024)),
  );
  const size = value / Math.pow(1024, idx);
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[idx]}`;
}

function normalizeTaskAttachments(task, backend, maxAttachments) {
  const base = []
    .concat(Array.isArray(task?.attachments) ? task.attachments : [])
    .concat(Array.isArray(task?.meta?.attachments) ? task.meta.attachments : []);
  const local = listTaskAttachments(task?.id || task?.task_id, backend);
  const merged = mergeTaskAttachments(base, local);
  if (!Number.isFinite(maxAttachments) || maxAttachments <= 0) return [];
  if (merged.length <= maxAttachments) return merged;
  return merged.slice(0, maxAttachments);
}

function formatAttachmentLine(attachment) {
  if (!attachment) return "";
  const name = attachment.name || attachment.filename || attachment.title || "attachment";
  const kind = attachment.kind ? ` (${attachment.kind})` : "";
  const sizeText = attachment.size ? `, ${formatBytes(attachment.size)}` : "";
  const source = attachment.source ? ` | ${attachment.source}` : "";
  const location =
    attachment.filePath ||
    attachment.path ||
    attachment.url ||
    attachment.uri ||
    "";
  const suffix = location ? ` — ${location}` : "";
  return `- ${name}${kind}${sizeText}${source}${suffix}`;
}

function formatCommentLine(comment) {
  const author = comment.author ? `@${comment.author}` : "comment";
  const timestamp = comment.createdAt ? ` (${comment.createdAt})` : "";
  return `- ${author}${timestamp}: ${comment.body}`;
}

function buildTaskContextBlock(task, backend) {
  const maxComments = parseNumberEnv("BOSUN_TASK_CONTEXT_MAX_COMMENTS", 8);
  const maxCommentChars = parseNumberEnv("BOSUN_TASK_CONTEXT_MAX_COMMENT_CHARS", 1200);
  const maxAttachments = parseNumberEnv("BOSUN_TASK_CONTEXT_MAX_ATTACHMENTS", 20);
  const comments = normalizeTaskComments(task, maxComments, maxCommentChars);
  const attachments = normalizeTaskAttachments(task, backend, maxAttachments);
  if (comments.length === 0 && attachments.length === 0) {
    return { block: "", comments, attachments };
  }
  const lines = ["## Task Context"];
  if (comments.length > 0) {
    lines.push("### Comments");
    for (const comment of comments) {
      lines.push(formatCommentLine(comment));
    }
  }
  if (attachments.length > 0) {
    lines.push("### Attachments");
    for (const attachment of attachments) {
      lines.push(formatAttachmentLine(attachment));
    }
  }
  return { block: lines.join("\n"), comments, attachments };
}

function writeTaskContextFile(task, payload, repoRoot) {
  if (!payload || !repoRoot) return null;
  const taskId = task?.id || task?.task_id;
  if (!taskId) return null;
  const dir = resolve(repoRoot, ".bosun", ".cache", "task-context");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  const safeId = sanitizePathSegment(taskId);
  const filePath = resolve(dir, `${safeId}.json`);
  try {
    writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    return null;
  }
  return filePath;
}
/** Watchdog interval: how often to check for stalled agent slots */
const WATCHDOG_INTERVAL_MS = 60_000; // 1 minute

// ── Error categorization ───────────────────────────────────────────────────

/**
 * Categorize an error for smarter retry/backoff decisions.
 * @param {unknown} err
 * @returns {'transient'|'auth'|'network'|'conflict'|'permanent'|'unknown'}
 */
function categorizeError(err) {
  const msg = (err?.message || err?.stderr || String(err ?? "")).toLowerCase();
  if (/rate.?limit|too many requests|429/i.test(msg)) return "transient";
  if (/auth|token|unauthorized|forbidden|403|401/i.test(msg)) return "auth";
  if (/network|econnrefused|enotfound|etimedout|econnreset|socket/i.test(msg)) return "network";
  if (/conflict|merge conflict|rebase conflict|CONFLICT/i.test(msg)) return "conflict";
  if (/fatal|crash|exit code 1|exit code 127|SIGKILL/i.test(msg)) return "permanent";
  return "unknown";
}

/**
 * Returns the Co-authored-by trailer for bosun-ve[bot].
 *
 * By default this is task-scoped and only enabled during Bosun-managed tasks.
 * BOSUN_COAUTHOR_MODE=always can force global attribution when explicitly
 * desired (for internal Bosun repo workflows, etc).
 */
function getBosunCoAuthorLine(taskOrTaskId = null) {
  const taskId = (() => {
    if (taskOrTaskId == null) return "";
    if (typeof taskOrTaskId === "string") return taskOrTaskId.trim();
    const value = taskOrTaskId.id || taskOrTaskId.task_id || "";
    return String(value || "").trim();
  })();

  if (!shouldAddBosunCoAuthor({ taskId })) return "";
  return getBosunCoAuthorTrailer();
}

/**
 * Returns a prompt instruction block telling the agent to append the Bosun
 * co-author trailer to every commit.
 */
function getBosunCoAuthorInstruction(taskOrTaskId = null) {
  const line = getBosunCoAuthorLine(taskOrTaskId);
  if (!line) return "";
  return `\n**Attribution (required — do not omit):**
Every commit message MUST end with a blank line then this exact trailer:
\`\`\`
${line}
\`\`\`
`;
}
/** Grace period after task timeout before watchdog force-kills the slot */
const WATCHDOG_GRACE_MS = 10 * 60_000; // 10 minutes — generous buffer, stream analysis handles real issues
/** Max age for in-progress tasks to auto-resume after monitor restart */
const INPROGRESS_RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours — agents should be resumable for a full day
/** Unstarted in-progress tasks older than this are treated as stranded and reset to todo */
const INPROGRESS_RECOVERY_UNSTARTED_RESET_MS = 20 * 60 * 1000;
/** Periodic in-progress recovery cadence while executor is running */
const INPROGRESS_RECOVERY_INTERVAL_MS = 5 * 60 * 1000;
const INPROGRESS_RECOVERY_HISTORY_LIMIT = 12;
const WORKFLOW_RUN_RECOVERY_GRACE_MS = 60 * 60 * 1000; // 60 minutes — agent phases (plan/tests/implement) can run >15 min between dag updates
const WORKFLOW_RUN_STARTUP_STALL_RECOVERY_MS = INPROGRESS_RECOVERY_UNSTARTED_RESET_MS;
const UNRESOLVED_TEMPLATE_TOKEN_RE = /\{\{[^{}]+\}\}/;

function normalizeSelector(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeModel(value) {
  const model = String(value || "").trim();
  return model ? model : null;
}

function normalizeSdkOverride(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "auto") return "auto";
  if (raw === "codex-sdk") return "codex";
  if (raw === "copilot-sdk") return "copilot";
  if (raw === "claude-sdk") return "claude";
  if (raw === "gemini-sdk") return "gemini";
  if (raw === "opencode-sdk") return "opencode";
  if (["codex", "copilot", "claude", "gemini", "opencode"].includes(raw)) {
    return raw;
  }
  return null;
}

function resolveTaskExecutionOverrides(task = {}, options = {}) {
  const fromTask = task && typeof task === "object" ? task : {};
  const meta = fromTask.meta && typeof fromTask.meta === "object" ? fromTask.meta : {};
  const execution =
    meta.execution && typeof meta.execution === "object" ? meta.execution : {};

  const explicitSdk =
    normalizeSdkOverride(options?.sdk) ||
    normalizeSdkOverride(fromTask?.sdk) ||
    normalizeSdkOverride(fromTask?.executor) ||
    normalizeSdkOverride(meta?.sdk) ||
    normalizeSdkOverride(meta?.executor) ||
    normalizeSdkOverride(execution?.sdk) ||
    normalizeSdkOverride(execution?.executor) ||
    (() => {
      const normalized = normalizeExecutorKey(execution?.executor || meta?.executor || fromTask?.executor);
      return normalized ? normalizeSdkOverride(normalized) : null;
    })();

  const explicitModel =
    normalizeModel(options?.model) ||
    normalizeModel(fromTask?.model) ||
    normalizeModel(meta?.model) ||
    normalizeModel(execution?.model);

  return {
    sdk: explicitSdk,
    model: explicitModel,
    explicit: Boolean(
      (explicitSdk && explicitSdk !== "auto") || explicitModel,
    ),
  };
}

// ── Stream-Based Health Monitoring Constants ──────────────────────────────
/** How long an agent can be truly silent (zero events) before we consider intervention */
const STREAM_SILENT_THRESHOLD_MS = 10 * 60_000; // 10 minutes of absolute silence
/** How long an agent can be idle (no meaningful progress) before we send CONTINUE */
const STREAM_IDLE_THRESHOLD_MS = 5 * 60_000; // 5 minutes idle = send continue
/** How long truly stalled (no events after continues) before force-kill */
const STREAM_STALLED_KILL_MS = 20 * 60_000; // 20 minutes stalled after continues = kill
/** Maximum idle continues before escalating to abort */
const MAX_IDLE_CONTINUES = 5;
/** Minimum elapsed time before watchdog even starts checking (agent setup phase) */
const WATCHDOG_WARMUP_MS = 5 * 60_000; // 5 minutes warmup
const SHARED_STATE_ENABLED = process.env.SHARED_STATE_ENABLED !== "false";
const SHARED_STATE_STALE_THRESHOLD_MS =
  Number(process.env.SHARED_STATE_STALE_THRESHOLD_MS) || 600_000;
const NO_COMMIT_STATE_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".cache",
  "no-commit-state.json",
);
const DEFAULT_PAUSE_REASON = "manual";
const RUNTIME_STATE_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".cache",
  "task-executor-runtime.json",
);
const ORCHESTRATOR_PAUSE_FILE = (() => {
  try {
    const cfg = loadConfig();
    const base = cfg?.statusPath ? dirname(cfg.statusPath) : null;
    if (base) return resolve(base, "orchestrator-pause.json");
  } catch {
    /* best effort */
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", ".cache", "orchestrator-pause.json");
})();

const PRIORITY_RANK = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const FIRE_PRIORITY_SET = new Set(["fire", "critical"]);
const FIRE_TAG_SET = new Set(["fire", "urgent", "p0"]);

const REQUIREMENTS_PROFILES = new Set([
  "simple-feature",
  "feature",
  "large-feature",
  "system",
  "multi-system",
]);

function normalizePriority(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  if (key === "critical" || key === "high" || key === "medium" || key === "low") {
    return key;
  }
  return "medium";
}

const UPSTREAM_LABEL_REGEX =
  /^(?:upstream|base|target)(?:_branch)?[:=]\s*([A-Za-z0-9._/-]+)$/i;

function normalizeBranchName(value) {
  if (!value) return null;
  const trimmed = String(value || "").trim();
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

function extractScopeFromTitle(title) {
  if (!title) return null;
  const match = String(title).match(
    /(?:^\[[^\]]+\]\s*)?(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)\(([^)]+)\)/i,
  );
  return match ? match[1].toLowerCase().trim() : null;
}

/**
 * If TASK_BRANCH_AUTO_MODULE=true (default), extract the conventional-commit
 * scope from a task title and return the corresponding module branch ref.
 *
 * e.g. "[m] feat(veid): add verification" → "origin/veid"
 *       "[s] fix(market): resolve bid race" → "origin/market"
 */
function resolveModuleAutoBaseBranch(title) {
  const enabled = (process.env.TASK_BRANCH_AUTO_MODULE ?? "true") !== "false";
  if (!enabled) return null;
  const scope = extractScopeFromTitle(title);
  if (!scope) return null;
  // Exclude generic scopes that don't map to real module branches
  const generic = new Set(["deps", "app", "sdk", "cli", "api"]);
  if (generic.has(scope)) return null;
  const prefix = (process.env.MODULE_BRANCH_PREFIX || "origin/").replace(/\/*$/, "/");
  return `${prefix}${scope}`;
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
  if (task.meta) {
    for (const field of ["labels", "tags"]) {
      const value = task.meta[field];
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

function extractUpstreamFromText(text) {
  if (!text) return null;
  const match = String(text).match(
    /\b(?:upstream|base|target)(?:_branch| branch)?\s*[:=]\s*([A-Za-z0-9._/-]+)/i,
  );
  if (!match) return null;
  return normalizeBranchName(match[1]);
}

function resolveUpstreamFromConfig(task, branchRouting) {
  if (!task || !branchRouting?.scopeMap) return null;

  const scope = extractScopeFromTitle(task.title || task.name);
  if (scope) {
    const exactMatch = branchRouting.scopeMap[scope];
    if (exactMatch) return exactMatch;
    for (const [key, branch] of Object.entries(branchRouting.scopeMap)) {
      if (scope.includes(key) || key.includes(scope)) return branch;
    }
  }

  const text = getTaskTextBlob(task).toLowerCase();
  for (const [key, branch] of Object.entries(branchRouting.scopeMap)) {
    if (text.includes(String(key).toLowerCase())) return branch;
  }

  return null;
}

function resolveTaskBaseBranch(task, branchRouting, defaultTargetBranch) {
  if (!task) return normalizeBranchName(defaultTargetBranch);

  const directFields = [
    "target_branch",
    "base_branch",
    "upstream_branch",
    "upstream",
    "target",
    "base",
    "targetBranch",
    "baseBranch",
    "upstreamBranch",
  ];
  for (const field of directFields) {
    if (task[field]) return normalizeBranchName(task[field]);
  }
  if (task.metadata) {
    for (const field of directFields) {
      if (task.metadata[field]) return normalizeBranchName(task.metadata[field]);
    }
  }
  if (task.meta) {
    for (const field of directFields) {
      if (task.meta[field]) return normalizeBranchName(task.meta[field]);
    }
  }

  for (const label of collectTaskLabels(task)) {
    const match = String(label).match(UPSTREAM_LABEL_REGEX);
    if (match?.[1]) return normalizeBranchName(match[1]);
  }

  const fromText = extractUpstreamFromText(getTaskTextBlob(task));
  if (fromText) return fromText;

  const fromConfig = resolveUpstreamFromConfig(task, branchRouting);
  if (fromConfig) return normalizeBranchName(fromConfig);

  // Auto-detect module branch from conventional commit scope in title
  const moduleAuto = resolveModuleAutoBaseBranch(task.title || task.name);
  if (moduleAuto) return normalizeBranchName(moduleAuto);

  return normalizeBranchName(defaultTargetBranch);
}

function normalizeBaseBranchKey(baseBranch, defaultTargetBranch) {
  const candidate =
    normalizeBranchName(baseBranch) || normalizeBranchName(defaultTargetBranch);
  if (!candidate) return null;
  try {
    return normalizeBaseBranch(candidate, "origin").branch;
  } catch {
    return candidate;
  }
}

function ensureBaseBranchAvailable(repoRoot, baseBranch, defaultTargetBranch) {
  const fallback = normalizeBranchName(defaultTargetBranch) || "origin/main";
  let candidate = normalizeBranchName(baseBranch) || fallback;
  let normalized;
  try {
    normalized = normalizeBaseBranch(candidate, "origin");
  } catch {
    normalized = normalizeBaseBranch(fallback, "origin");
    candidate = fallback;
  }
  const { branch, remoteRef } = normalized;

  const localRef = `refs/heads/${branch}`;
  const localCheck = spawnSync("git", ["show-ref", "--verify", localRef], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 5000,
    env: sanitizeGitEnv(),
  });
  if (localCheck.status === 0) {
    return branch;
  }

  let remoteExists = false;
  const remoteHeadRef = `refs/remotes/origin/${branch}`;
  const remoteLocalCheck = spawnSync("git", ["show-ref", "--verify", remoteHeadRef], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 8000,
    env: sanitizeGitEnv(),
  });
  remoteExists = remoteLocalCheck.status === 0;
  if (!remoteExists) {
    try {
      spawnSync("git", ["fetch", "origin", "--prune", "--quiet"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 15000,
        env: sanitizeGitEnv(),
      });
      const refreshedCheck = spawnSync("git", ["show-ref", "--verify", remoteHeadRef], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 8000,
        env: sanitizeGitEnv(),
      });
      remoteExists = refreshedCheck.status === 0;
    } catch {
      remoteExists = false;
    }
  }

  if (remoteExists) {
    spawnSync("git", ["branch", branch, remoteRef], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 8000,
      env: sanitizeGitEnv(),
    });
    return branch;
  }

  const fallbackNorm = normalizeBaseBranch(fallback, "origin");
  try {
    spawnSync("git", ["fetch", "origin", "--prune", "--quiet"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15000,
      env: sanitizeGitEnv(),
    });
  } catch {
    /* best-effort */
  }

  const createRes = spawnSync(
    "git",
    ["branch", branch, fallbackNorm.remoteRef],
    { cwd: repoRoot, encoding: "utf8", timeout: 8000, env: sanitizeGitEnv() },
  );
  if (createRes.status !== 0) {
    const stderr = (createRes.stderr || "").trim();
    console.warn(
      `${TAG} failed to create base branch ${branch} from ${fallbackNorm.remoteRef}: ${stderr}`,
    );
    return fallbackNorm.remoteRef;
  }

  spawnSync("git", ["push", "-u", "origin", branch], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: sanitizeGitEnv(),
  });
  return branch;
}

function writeOrchestratorPauseState(paused, reason, extra = {}) {
  try {
    mkdirSync(dirname(ORCHESTRATOR_PAUSE_FILE), { recursive: true });
    const payload = {
      paused: Boolean(paused),
      reason: reason ? String(reason) : null,
      pausedAt:
        Number.isFinite(extra.pausedAt) && extra.pausedAt > 0
          ? new Date(extra.pausedAt).toISOString()
          : null,
      pauseUntil: Number.isFinite(extra.pauseUntil)
        ? new Date(extra.pauseUntil).toISOString()
        : null,
      updatedAt: new Date().toISOString(),
      source: extra.source || "task-executor",
    };
    writeFileSync(
      ORCHESTRATOR_PAUSE_FILE,
      JSON.stringify(payload, null, 2),
      "utf8",
    );
  } catch (err) {
    console.warn(`${TAG} failed to write orchestrator pause state: ${err.message}`);
  }
}

function normalizeRequirementsProfile(value) {
  const profile = String(value || "")
    .trim()
    .toLowerCase();
  if (REQUIREMENTS_PROFILES.has(profile)) {
    return profile;
  }
  return "feature";
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function isSharedHeartbeatStale(heartbeat, thresholdMs) {
  if (!heartbeat) return true;
  const ts = new Date(heartbeat).getTime();
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > thresholdMs;
}

function normalizeTaskIdKey(taskId) {
  const normalized = String(taskId ?? "").trim();
  return normalized;
}

function normalizeAuthoritativeWorkflowTaskId(taskId) {
  const normalized = normalizeTaskIdKey(taskId);
  if (!normalized) return "";
  if (UNRESOLVED_TEMPLATE_TOKEN_RE.test(normalized)) return "";
  return normalized;
}

function collectWorkflowEvidenceTaskIds(target, value) {
  if (!(target instanceof Set) || value == null) return target;
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectWorkflowEvidenceTaskIds(target, entry);
    }
    return target;
  }
  const normalized = normalizeAuthoritativeWorkflowTaskId(value);
  if (normalized) target.add(normalized);
  return target;
}

function collectWorkflowEvidenceScalarTaskIds(target, ...values) {
  if (!(target instanceof Set)) return target;
  for (const value of values) {
    if (Array.isArray(value)) continue;
    collectWorkflowEvidenceTaskIds(target, value);
  }
  return target;
}

function normalizeWorkflowRecoveryEvidenceEntry(entry = {}) {
  return {
    taskId: normalizeTaskIdKey(entry?.taskId),
    runId: String(entry?.runId || "").trim() || null,
    source: String(entry?.source || "").trim() || "workflow",
    reason: String(entry?.reason || "").trim() || "workflow_liveness",
    status: String(entry?.status || "").trim().toLowerCase() || null,
    lastActivityAt: toIsoTimestamp(entry?.lastActivityAt) || null,
  };
}

function createEmptyInProgressRecoverySnapshot() {
  return {
    totals: {
      runs: 0,
      failures: 0,
      resumed: 0,
      resetToTodo: 0,
      reconciledDrift: 0,
      skippedForActiveClaim: 0,
      skippedForNoCommitBlock: 0,
      resetUnstarted: 0,
      staleSharedClaim: 0,
      workflowOwnerlessReset: 0,
    },
    lastRun: null,
    recentRuns: [],
  };
}

function toNonNegativeInt(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.max(0, Math.trunc(numeric));
}

function normalizeInProgressRecoveryRun(run = {}) {
  return {
    trigger: String(run?.trigger || "").trim() || "interval",
    startedAt: String(run?.startedAt || "").trim() || null,
    finishedAt: String(run?.finishedAt || "").trim() || null,
    durationMs: toNonNegativeInt(run?.durationMs),
    scannedCount: toNonNegativeInt(run?.scannedCount),
    availableSlots: toNonNegativeInt(run?.availableSlots),
    resumedCount: toNonNegativeInt(run?.resumedCount),
    resetToTodoCount: toNonNegativeInt(run?.resetToTodoCount),
    reconciledDriftCount: toNonNegativeInt(run?.reconciledDriftCount),
    skippedForActiveClaimCount: toNonNegativeInt(run?.skippedForActiveClaimCount),
    skippedForNoCommitBlockCount: toNonNegativeInt(run?.skippedForNoCommitBlockCount),
    resetUnstartedCount: toNonNegativeInt(run?.resetUnstartedCount),
    staleSharedClaimCount: toNonNegativeInt(run?.staleSharedClaimCount),
    workflowOwnerlessResetCount: toNonNegativeInt(run?.workflowOwnerlessResetCount),
    prunedRuntimeCount: toNonNegativeInt(run?.prunedRuntimeCount),
    workflowEvidenceKept: Array.isArray(run?.workflowEvidenceKept)
      ? run.workflowEvidenceKept
        .map((entry) => normalizeWorkflowRecoveryEvidenceEntry(entry))
        .filter((entry) => entry.runId)
        .slice(-INPROGRESS_RECOVERY_HISTORY_LIMIT)
      : [],
    failed: run?.failed === true,
    error: String(run?.error || "").trim() || null,
  };
}

function normalizeInProgressRecoverySnapshot(snapshot = {}) {
  const base = createEmptyInProgressRecoverySnapshot();
  const totals = snapshot?.totals && typeof snapshot.totals === "object"
    ? snapshot.totals
    : {};
  base.totals = {
    runs: toNonNegativeInt(totals.runs),
    failures: toNonNegativeInt(totals.failures),
    resumed: toNonNegativeInt(totals.resumed),
    resetToTodo: toNonNegativeInt(totals.resetToTodo),
    reconciledDrift: toNonNegativeInt(totals.reconciledDrift),
    skippedForActiveClaim: toNonNegativeInt(totals.skippedForActiveClaim),
    skippedForNoCommitBlock: toNonNegativeInt(totals.skippedForNoCommitBlock),
    resetUnstarted: toNonNegativeInt(totals.resetUnstarted),
    staleSharedClaim: toNonNegativeInt(totals.staleSharedClaim),
    workflowOwnerlessReset: toNonNegativeInt(totals.workflowOwnerlessReset),
  };
  base.lastRun = snapshot?.lastRun ? normalizeInProgressRecoveryRun(snapshot.lastRun) : null;
  base.recentRuns = Array.isArray(snapshot?.recentRuns)
    ? snapshot.recentRuns
      .map((run) => normalizeInProgressRecoveryRun(run))
      .slice(-INPROGRESS_RECOVERY_HISTORY_LIMIT)
    : [];
  return base;
}

function extractBacklogCandidates(outputText) {
  const text = String(outputText || "");
  if (!text.trim()) return [];

  const fencedMatch = text.match(
    /```(?:bosun-backlog|json)?\s*([\s\S]*?)```/i,
  );
  if (fencedMatch?.[1]) {
    try {
      const parsed = JSON.parse(fencedMatch[1].trim());
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.backlog_tasks)) return parsed.backlog_tasks;
    } catch {
      /* continue */
    }
  }

  const objectMatch = text.match(/\{[\s\S]*"backlog_tasks"\s*:\s*\[[\s\S]*\][\s\S]*\}/i);
  if (objectMatch?.[0]) {
    try {
      const parsed = JSON.parse(objectMatch[0]);
      if (Array.isArray(parsed?.backlog_tasks)) return parsed.backlog_tasks;
    } catch {
      /* continue */
    }
  }

  return [];
}

function hasBacklogCandidateHint(outputText) {
  const text = String(outputText || "");
  if (!text.trim()) return false;
  return /(?:bosun-backlog|backlog_tasks|follow-up\s+tasks?)/i.test(text);
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Agent Log Streaming ─────────────────────────────────────────────────────

const AGENT_LOGS_DIR = resolve(__dirname, "..", "logs", "agents");
const AGENT_WORK_DIR = resolve(__dirname, "..", ".cache", "agent-work-logs");
const AGENT_WORK_STREAM = resolve(AGENT_WORK_DIR, "agent-work-stream.jsonl");
const AGENT_WORK_ERRORS = resolve(AGENT_WORK_DIR, "agent-errors.jsonl");
const AGENT_WORK_METRICS = resolve(AGENT_WORK_DIR, "agent-metrics.jsonl");
const AGENT_WORK_SESSIONS = resolve(AGENT_WORK_DIR, "agent-sessions");
const INTERNAL_ANOMALY_SIGNAL_PATH = resolve(
  __dirname,
  "..",
  ".cache",
  "anomaly-signals.json",
);
const agentWorkSessionStarts = new Map();
const attemptTelemetry = new Map();
const anomalyAbortTargets = new Map();
const internalAnomalyEnabled = process.env.BOSUN_INTERNAL_ANOMALY !== "false";
const TELEMETRY_SAMPLE_RATE = (() => {
  const raw = Number(process.env.BOSUN_TELEMETRY_SAMPLE_RATE || "1");
  if (!Number.isFinite(raw)) return 1;
  return Math.min(1, Math.max(0, raw));
})();
const anomalyDetector = internalAnomalyEnabled
  ? createAnomalyDetector({
      onAnomaly: (anomaly) => {
        console.warn(
          `${TAG} anomaly ${anomaly.severity} ${anomaly.type} [${anomaly.shortId}]: ${anomaly.message}`,
        );
        writeInternalAnomalySignal(anomaly);
        const notifyFn = globalThis.__bosunNotifyAnomaly;
        if (typeof notifyFn === "function") {
          try {
            notifyFn(anomaly);
          } catch {
            /* best effort */
          }
        }
        if (anomaly?.processId && attemptTelemetry.has(anomaly.processId)) {
          const telemetry = attemptTelemetry.get(anomaly.processId);
          telemetry.anomaly_actions = telemetry.anomaly_actions || [];
          telemetry.anomaly_actions.push({
            type: anomaly.type,
            action: anomaly.action,
            severity: anomaly.severity,
            timestamp: Date.now(),
          });
        }
        if (anomaly.action === "kill" || anomaly.action === "restart") {
          const target = anomalyAbortTargets.get(anomaly.processId);
          if (target && !target.signal.aborted) {
            target.abort(`anomaly:${anomaly.type}`);
          }
        }
      },
    })
  : null;

function ensureAgentWorkDirs() {
  try {
    mkdirSync(AGENT_WORK_DIR, { recursive: true });
    mkdirSync(AGENT_WORK_SESSIONS, { recursive: true });
  } catch {
    /* best effort */
  }
}

function writeAgentWorkEvent(entry) {
  const eventType = String(entry?.event_type || "");
  const shouldSample =
    TELEMETRY_SAMPLE_RATE < 1 &&
    ["agent_output", "tool_call", "tool_result", "usage"].includes(eventType);
  if (shouldSample && Math.random() > TELEMETRY_SAMPLE_RATE) {
    return;
  }

  ensureAgentWorkDirs();
  const line = JSON.stringify(entry);
  appendFileSync(AGENT_WORK_STREAM, `${line}\n`, "utf8");
  if (entry.event_type === "error") {
    appendFileSync(AGENT_WORK_ERRORS, `${line}\n`, "utf8");
  }
  if (entry.attempt_id) {
    const sessionPath = resolve(AGENT_WORK_SESSIONS, `${entry.attempt_id}.jsonl`);
    appendFileSync(sessionPath, `${line}\n`, "utf8");
  }
}

function getAttemptTelemetry(attemptId) {
  if (!attemptTelemetry.has(attemptId)) {
    attemptTelemetry.set(attemptId, {
      tool_calls: 0,
      tool_results: 0,
      tool_failures: 0,
      commands: 0,
      command_failures: 0,
      permission_requests: 0,
      permission_denied: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
      model: null,
      anomaly_actions: [],
      auto_resume: false,
    });
  }
  return attemptTelemetry.get(attemptId);
}

function applyUsage(telemetry, usage) {
  if (!usage) return;
  const prompt =
    usage.prompt_tokens ??
    usage.input_tokens ??
    usage.tokens_in ??
    usage.promptTokens ??
    0;
  const completion =
    usage.completion_tokens ??
    usage.output_tokens ??
    usage.tokens_out ??
    usage.completionTokens ??
    0;
  const total =
    usage.total_tokens ??
    usage.totalTokens ??
    usage.tokens ??
    (prompt + completion);
  if (prompt) telemetry.prompt_tokens += Number(prompt) || 0;
  if (completion) telemetry.completion_tokens += Number(completion) || 0;
  if (total) telemetry.total_tokens += Number(total) || 0;
  const cost =
    usage.cost_usd ??
    usage.cost ??
    usage.total_cost ??
    usage.usd ??
    0;
  if (cost) telemetry.cost_usd += Number(cost) || 0;
}

function extractUsageFromEvent(event) {
  return (
    event?.usage ||
    event?.data?.usage ||
    event?.item?.usage ||
    event?.message?.usage ||
    event?.response?.usage ||
    event?.metrics?.usage ||
    event?.data?.metrics?.usage ||
    event?.result?.usage ||
    null
  );
}

function classifyError(errorDetector, message, stderr) {
  if (!errorDetector) return { category: "unknown", confidence: 0 };
  const result = errorDetector.classify(message || "", stderr || "");
  return {
    category: result.pattern || "unknown",
    confidence: result.confidence || 0,
    details: result.details,
    rawMatch: result.rawMatch,
  };
}

function writeInternalAnomalySignal(anomaly) {
  try {
    const dir = resolve(__dirname, "..", ".cache");
    mkdirSync(dir, { recursive: true });
    let signals = [];
    try {
      const raw = readFileSync(INTERNAL_ANOMALY_SIGNAL_PATH, "utf8");
      signals = JSON.parse(raw);
      if (!Array.isArray(signals)) signals = [];
    } catch {
      /* ignore */
    }
    signals.push({
      source: "internal",
      type: anomaly.type,
      severity: anomaly.severity,
      action: anomaly.action,
      shortId: anomaly.shortId,
      processId: anomaly.processId,
      message: anomaly.message,
      timestamp: new Date().toISOString(),
    });
    if (signals.length > 50) signals = signals.slice(-50);
    writeFileSync(INTERNAL_ANOMALY_SIGNAL_PATH, JSON.stringify(signals, null, 2));
  } catch {
    /* best effort */
  }
}

function startAgentWorkSession({ attemptId, taskMeta, executorInfo, gitContext, prompt }) {
  agentWorkSessionStarts.set(attemptId, Date.now());
  writeAgentWorkEvent({
    timestamp: new Date().toISOString(),
    attempt_id: attemptId,
    event_type: "session_start",
    data: { prompt_type: "initial", ...(prompt ? { prompt } : {}) },
    ...taskMeta,
    ...executorInfo,
    ...gitContext,
  });
}

function stopAgentWorkSession({
  attemptId,
  status,
  executorInfo,
  taskMeta,
  gitContext,
  metrics,
}) {
  const startedAt = agentWorkSessionStarts.get(attemptId);
  const durationMs = startedAt ? Date.now() - startedAt : null;
  const telemetry = attemptTelemetry.get(attemptId) || {};
  const mergedMetrics = {
    ...telemetry,
    ...metrics,
  };
  writeAgentWorkEvent({
    timestamp: new Date().toISOString(),
    attempt_id: attemptId,
    event_type: "session_end",
    data: {
      completion_status: status,
      duration_ms: durationMs ?? undefined,
      ...mergedMetrics,
    },
    ...taskMeta,
    ...executorInfo,
    ...gitContext,
  });

  if (mergedMetrics) {
    appendFileSync(
      AGENT_WORK_METRICS,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        attempt_id: attemptId,
        ...taskMeta,
        ...executorInfo,
        metrics: mergedMetrics,
      })}\n`,
      "utf8",
    );
  }
  attemptTelemetry.delete(attemptId);
}

function synthesizeAnomalyLine(event) {
  try {
    if (event?.type === "item.completed" && event.item) {
      const item = event.item;
      if (item.type === "function_call") {
        return JSON.stringify({
          ToolCall: {
            title: item.name || "ToolCall",
            rawInput: item.arguments || "",
          },
        });
      }
      if (item.type === "function_call_output") {
        return JSON.stringify({
          ToolUpdate: { status: item.status || "completed" },
        });
      }
      if (item.type === "commandExecution") {
        return JSON.stringify(item);
      }
      if (item.type === "reasoning" && item.summary) {
        return JSON.stringify({ type: "reasoning", summary: [item.summary] });
      }
    }
    if (event?.type === "error") {
      return String(event.error || event.message || "error");
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Create an onEvent callback that streams agent SDK events to a per-task log file
 * AND feeds the session tracker for review handoff context.
 * @param {string} taskId
 * @param {string} taskTitle
 * @returns {Function}
 */
function createAgentLogStreamer({
  attemptId,
  taskId,
  taskTitle,
  taskMeta,
  executorInfo,
  gitContext,
  errorDetector,
}) {
  const shortId = taskId.substring(0, 8);
  const logFile = resolve(AGENT_LOGS_DIR, `agent-${shortId}.log`);
  const tracker = getSessionTracker();
  const telemetry = getAttemptTelemetry(attemptId);

  // Ensure log dir exists
  try {
    mkdirSync(AGENT_LOGS_DIR, { recursive: true });
  } catch {
    /* ok */
  }

  // Write header
  try {
    appendFileSync(
      logFile,
      `\n${"=".repeat(80)}\n[${new Date().toISOString()}] Task: ${taskTitle}\nTask ID: ${taskId}\n${"=".repeat(80)}\n`,
      "utf8",
    );
  } catch {
    /* ok */
  }

  return (event) => {
    // Feed to session tracker (for review handoff)
    try {
      tracker.recordEvent(taskId, event);
    } catch {
      /* never let tracking crash the agent */
    }

    if (anomalyDetector) {
      const line = synthesizeAnomalyLine(event);
      if (line) {
        anomalyDetector.processLine(line, {
          processId: attemptId,
          attemptId,
          taskTitle,
          branch: gitContext?.branch,
        });
      }
    }

    try {
      const ts = new Date().toISOString();
      if (event?.model && !telemetry.model) telemetry.model = event.model;
      if (event?.data?.model && !telemetry.model)
        telemetry.model = event.data.model;
      if (event?.message?.model && !telemetry.model)
        telemetry.model = event.message.model;

      const usage = extractUsageFromEvent(event);
      applyUsage(telemetry, usage);
      if (usage) {
        writeAgentWorkEvent({
          timestamp: ts,
          attempt_id: attemptId,
          event_type: "usage",
          data: usage,
          ...taskMeta,
          ...executorInfo,
          ...gitContext,
        });
      }

      if (String(event?.type || "").toLowerCase().includes("permission")) {
        telemetry.permission_requests += 1;
        if (String(event?.action || "").toLowerCase().includes("deny")) {
          telemetry.permission_denied += 1;
        }
      }

      if (event.type === "item.completed" && event.item) {
        const item = event.item;
        if (item.type === "agent_message" && item.text) {
          const text = item.text;
          writeAgentWorkEvent({
            timestamp: ts,
            attempt_id: attemptId,
            event_type: "agent_output",
            data: { output: text, stream_type: "stdout" },
            ...taskMeta,
            ...executorInfo,
            ...gitContext,
          });
          appendFileSync(
            logFile,
            `[${ts}] AGENT: ${text.slice(0, 2000)}\n`,
            "utf8",
          );
        } else if (item.type === "function_call") {
          telemetry.tool_calls += 1;
          writeAgentWorkEvent({
            timestamp: ts,
            attempt_id: attemptId,
            event_type: "tool_call",
            data: { tool_name: item.name, tool_params: item.arguments || "" },
            ...taskMeta,
            ...executorInfo,
            ...gitContext,
          });
          appendFileSync(
            logFile,
            `[${ts}] TOOL: ${item.name}(${(item.arguments || "").slice(0, 200)})\n`,
            "utf8",
          );
        } else if (item.type === "function_call_output") {
          const out = (item.output || "").slice(0, 500);
          telemetry.tool_results += 1;
          const failed =
            item.status === "failed" ||
            item.success === false ||
            String(item.output || "").toLowerCase().includes("error");
          if (failed) telemetry.tool_failures += 1;
          writeAgentWorkEvent({
            timestamp: ts,
            attempt_id: attemptId,
            event_type: "tool_result",
            data: {
              tool_name: item.name,
              result: item.output || "",
              status: item.status || (failed ? "failed" : "completed"),
            },
            ...taskMeta,
            ...executorInfo,
            ...gitContext,
          });
          appendFileSync(logFile, `[${ts}] RESULT: ${out}\n`, "utf8");
        } else if (item.type === "commandExecution") {
          telemetry.commands += 1;
          if (item.status === "failed") telemetry.command_failures += 1;
        } else {
          appendFileSync(
            logFile,
            `[${ts}] ITEM[${item.type}]: ${JSON.stringify(item).slice(0, 300)}\n`,
            "utf8",
          );
        }
      } else if (event.type === "assistant.message") {
        const content = event.data?.content || "";
        if (content) {
          writeAgentWorkEvent({
            timestamp: ts,
            attempt_id: attemptId,
            event_type: "agent_output",
            data: { output: content, stream_type: "stdout" },
            ...taskMeta,
            ...executorInfo,
            ...gitContext,
          });
        }
      } else if (event.type === "assistant.message_delta") {
        const delta = event.data?.deltaContent || "";
        if (delta && delta.length > 40) {
          writeAgentWorkEvent({
            timestamp: ts,
            attempt_id: attemptId,
            event_type: "agent_output",
            data: { output: delta, stream_type: "stdout", delta: true },
            ...taskMeta,
            ...executorInfo,
            ...gitContext,
          });
        }
      } else if (event.type === "tool_call") {
        telemetry.tool_calls += 1;
        writeAgentWorkEvent({
          timestamp: ts,
          attempt_id: attemptId,
          event_type: "tool_call",
          data: {
            tool_name: event.tool_name || event.data?.tool_name || "",
            tool_params: event.tool_params || event.data?.tool_params || "",
          },
          ...taskMeta,
          ...executorInfo,
          ...gitContext,
        });
      } else if (event.type === "item.created") {
        const item = event.item || {};
        appendFileSync(
          logFile,
          `[${ts}] +${item.type || event.type}\n`,
          "utf8",
        );
      } else if (event.type) {
        // Log any other event type for debugging
        appendFileSync(logFile, `[${ts}] EVT[${event.type}]\n`, "utf8");
      }

      if (event.type === "error") {
        const errText = event.error || event.message || "unknown error";
        const classification = classifyError(errorDetector, errText);
        const fingerprint = normalizeDedupKey(errText).slice(0, 120);
        writeAgentWorkEvent({
          timestamp: ts,
          attempt_id: attemptId,
          event_type: "error",
          data: {
            error_message: errText,
            error_category: classification.category,
            error_fingerprint: fingerprint,
            error_confidence: classification.confidence,
          },
          ...taskMeta,
          ...executorInfo,
          ...gitContext,
        });
      } else if (
        event?.item?.type === "commandExecution" &&
        event.item?.status === "failed"
      ) {
        const errText =
          event.item?.error ||
          event.item?.stderr ||
          event.item?.message ||
          "command failed";
        const classification = classifyError(errorDetector, errText);
        const fingerprint = normalizeDedupKey(errText).slice(0, 120);
        writeAgentWorkEvent({
          timestamp: ts,
          attempt_id: attemptId,
          event_type: "error",
          data: {
            error_message: errText,
            error_category: classification.category,
            error_fingerprint: fingerprint,
            error_confidence: classification.confidence,
            source: "commandExecution",
          },
          ...taskMeta,
          ...executorInfo,
          ...gitContext,
        });
      }
    } catch {
      /* never let logging crash the agent */
    }
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert text to a URL/branch-safe slug.
 * @param {string} text
 * @returns {string}
 */
function slugify(text) {
  return (text || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
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

function getGitHubIssueNumber(task) {
  if (!task) return null;
  const candidates = [
    task.externalId,
    task.external_id,
    task.meta?.externalId,
    task.meta?.external_id,
    task.id,
    task.meta?.number,
    task.meta?.id,
    task.taskUrl,
    task.url,
    task.meta?.url,
    task.meta?.task_url,
  ];
  for (const candidate of candidates) {
    const issueNumber = parseGitHubIssueNumber(candidate);
    if (issueNumber) return issueNumber;
  }
  return null;
}

function getTaskAgeMs(task) {
  const ts =
    task?.updated_at || task?.updatedAt || task?.created_at || task?.createdAt;
  if (!ts) return 0;
  const parsed = new Date(ts).getTime();
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Date.now() - parsed);
}

function parseTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

function toIsoTimestamp(value) {
  const parsed = parseTimestampMs(value);
  if (parsed <= 0) return null;
  return new Date(parsed).toISOString();
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

function isPlannerTaskData(task) {
  if (!task) return false;
  const title = String(task.title || "").toLowerCase();
  const desc = String(task.description || task.body || "").toLowerCase();
  if (title.includes("plan next tasks") || title.includes("plan next phase")) {
    return true;
  }
  if (title.includes("task planner")) {
    return true;
  }
  return (
    desc.includes("task planner — auto-created by bosun") ||
    desc.includes("task planner - auto-created by bosun")
  );
}

function isExpectedNoCommitTask(task) {
  if (!task) return false;

  const labelSet = getTaskLabelSet(task);
  for (const label of labelSet) {
    if (EXPECTED_NO_COMMIT_LABELS.has(label)) return true;
  }

  const tagSet = getTaskTagSet(task);
  for (const tag of tagSet) {
    if (EXPECTED_NO_COMMIT_TAGS.has(tag)) return true;
  }

  const title = String(task.title || "").toLowerCase();
  const desc = String(task.description || task.body || "").toLowerCase();
  const combined = `${title}\n${desc}`;
  const isPreflightTask = combined.includes("preflight");
  if (!isPreflightTask) return false;

  const hasDiagnosticIntent =
    /\b(detect|check|verify|validate|inspect|audit|diagnos|investigat|triage)\b/.test(
      combined,
    ) || combined.includes("guide remediation");
  if (!hasDiagnosticIntent) return false;

  const hasGuidedFixIntent =
    /\b(one-command|single-command|suggested|recommended|provide|include|guide)\b[\s\S]{0,80}\bfix\b/.test(
      combined,
    ) ||
    /\bfix\b[\s\S]{0,80}\b(command|script|instructions?)\b/.test(combined);
  const hasCodeChangeIntent =
    /\b(implement|refactor|patch|write test|add test|code change)\b/.test(
      combined,
    ) ||
    (/\bfix\b/.test(combined) && !hasGuidedFixIntent);
  return !hasCodeChangeIntent;
}
function getTaskLabelSet(task) {
  const labels = Array.isArray(task?.meta?.labels)
    ? task.meta.labels
    : Array.isArray(task?.labels)
      ? task.labels
      : [];
  return new Set(
    labels
      .map((entry) => (typeof entry === "string" ? entry : entry?.name))
      .map((entry) =>
        String(entry || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
}

function getTaskTagSet(task) {
  const tags = Array.isArray(task?.tags)
    ? task.tags
    : Array.isArray(task?.meta?.tags)
      ? task.meta.tags
      : [];
  return new Set(
    tags
      .map((entry) => String(entry || "").trim().toLowerCase())
      .filter(Boolean),
  );
}

function isFireTask(task) {
  if (!task) return false;
  const priority = String(task?.priority || "").trim().toLowerCase();
  if (FIRE_PRIORITY_SET.has(priority)) return true;
  if (task?.fire === true || task?.meta?.fire === true) return true;
  const labelSet = getTaskLabelSet(task);
  for (const label of labelSet) {
    if (FIRE_TAG_SET.has(label)) return true;
  }
  const tagSet = getTaskTagSet(task);
  for (const tag of tagSet) {
    if (FIRE_TAG_SET.has(tag)) return true;
  }
  return false;
}

const BACKLOG_ORDER_KEYS = [
  "backlog_order",
  "backlogOrder",
  "order",
  "sort_order",
  "sortOrder",
  "sort",
  "position",
  "pos",
  "rank",
  "index",
  "order_index",
  "orderIndex",
  "sort_index",
  "sortIndex",
  "priority_order",
  "priorityOrder",
];

function parseOrderValue(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function getBacklogOrderValue(task) {
  if (!task) return null;
  for (const key of BACKLOG_ORDER_KEYS) {
    if (task[key] != null) {
      const parsed = parseOrderValue(task[key]);
      if (parsed != null) return parsed;
    }
  }
  const meta = task?.meta || {};
  for (const key of BACKLOG_ORDER_KEYS) {
    if (meta[key] != null) {
      const parsed = parseOrderValue(meta[key]);
      if (parsed != null) return parsed;
    }
  }
  return null;
}

function getCreatedTimestamp(task) {
  if (!task) return null;
  const raw = task.created_at || task.createdAt || task.created;
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

function getUpdatedTimestamp(task) {
  if (!task) return null;
  const raw = task.updated_at || task.updatedAt || task.updated;
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

function sortEligibleTasks(tasks) {
  return tasks
    .map((task, index) => ({
      task,
      index,
      isFire: isFireTask(task),
      backlogOrder: getBacklogOrderValue(task),
      createdAt: getCreatedTimestamp(task),
      updatedAt: getUpdatedTimestamp(task),
    }))
    .sort((a, b) => {
      if (a.isFire !== b.isFire) return a.isFire ? -1 : 1;
      if (a.backlogOrder != null || b.backlogOrder != null) {
        if (a.backlogOrder == null) return 1;
        if (b.backlogOrder == null) return -1;
        if (a.backlogOrder !== b.backlogOrder) {
          return a.backlogOrder - b.backlogOrder;
        }
      }
      if (a.createdAt != null || b.createdAt != null) {
        if (a.createdAt == null) return 1;
        if (b.createdAt == null) return -1;
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      }
      if (a.updatedAt != null || b.updatedAt != null) {
        if (a.updatedAt == null) return 1;
        if (b.updatedAt == null) return -1;
        if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.task);
}

function isDraftTask(task) {
  if (!task) return false;
  const status = String(task.status || "").toLowerCase();
  if (status === "draft") return true;
  if (task.draft === true || task?.meta?.draft === true || task?.meta?.isDraft === true) {
    return true;
  }
  const labelSet = getTaskLabelSet(task);
  if (labelSet.has("draft")) return true;
  const tags = Array.isArray(task?.tags)
    ? task.tags
    : Array.isArray(task?.meta?.tags)
      ? task.meta.tags
      : [];
  return tags.some((tag) => String(tag || "").trim().toLowerCase() === "draft");
}

function isCodexScopedTask(task) {
  if (!isGitHubBackend(task)) return true;
  const labelSet = getTaskLabelSet(task);
  for (const label of CODEX_TASK_LABELS) {
    if (labelSet.has(label)) return true;
  }
  return false;
}

// ── Issue Tracking Helpers ──────────────────────────────────────────────────

/**
 * Check whether the current kanban backend is GitHub Issues.
 * @param {Object} [task] Optional task with backend info.
 * @returns {boolean}
 */
function isGitHubBackend(task) {
  const backend = String(
    task?.backend || task?.externalBackend || getKanbanBackendName(),
  ).toLowerCase();
  return backend === "github";
}

/**
 * Get the list of commits between two git refs, with titles and changed files.
 * @param {string} worktreePath Git working directory.
 * @param {string} fromRef      Starting ref (exclusive).
 * @param {string} toRef        Ending ref (inclusive). Defaults to HEAD.
 * @returns {{ sha: string, title: string, files: string[] }[]}
 */
function getCommitDetails(worktreePath, fromRef, toRef = "HEAD") {
  if (!worktreePath || !fromRef) return [];
  try {
    // Get commit SHAs and messages
    const logResult = spawnSync(
      "git",
      ["log", "--format=%H|%s", `${fromRef}..${toRef}`],
      { cwd: worktreePath, encoding: "utf8", timeout: 10_000 },
    );
    if (logResult.status !== 0 || !logResult.stdout?.trim()) return [];

    const commits = logResult.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, ...titleParts] = line.split("|");
        return {
          sha: sha.trim(),
          title: titleParts.join("|").trim(),
          files: [],
        };
      });

    // Get changed files per commit
    for (const commit of commits) {
      try {
        const filesResult = spawnSync(
          "git",
          ["diff-tree", "--no-commit-id", "--name-only", "-r", commit.sha],
          { cwd: worktreePath, encoding: "utf8", timeout: 5_000 },
        );
        if (filesResult.status === 0 && filesResult.stdout) {
          commit.files = filesResult.stdout.trim().split("\n").filter(Boolean);
        }
      } catch {
        /* best-effort */
      }
    }

    return commits;
  } catch {
    return [];
  }
}

/**
 * Get the overall changed-file summary between two refs.
 * @param {string} worktreePath
 * @param {string} fromRef
 * @param {string} toRef
 * @returns {string} Formatted diff stat or empty string.
 */
function getChangedFilesSummary(worktreePath, fromRef, toRef = "HEAD") {
  if (!worktreePath || !fromRef) return "";
  try {
    const result = spawnSync(
      "git",
      ["diff", "--stat", `${fromRef}..${toRef}`],
      { cwd: worktreePath, encoding: "utf8", timeout: 10_000 },
    );
    return result.status === 0 ? (result.stdout || "").trim() : "";
  } catch {
    return "";
  }
}

/**
 * Post a structured comment on a GitHub issue for a task, if the backend is GitHub.
 * Non-blocking, best-effort — failures are logged but don't affect task flow.
 * @param {Object} task         Task object (must have id).
 * @param {string} commentBody  Markdown body for the comment.
 * @returns {Promise<boolean>}  true if comment was posted.
 */
async function commentOnIssue(task, commentBody) {
  if (!isGitHubBackend(task)) return false;
  const issueNumber = getGitHubIssueNumber(task);
  if (!issueNumber) return false;
  try {
    return await addComment(issueNumber, commentBody);
  } catch (err) {
    console.warn(
      `${TAG} failed to comment on issue #${issueNumber}: ${err.message}`,
    );
    return false;
  }
}

// ── Typedefs ────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} TaskExecutorOptions
 * @property {string}   mode            - "internal" | "hybrid"
 * @property {number}   maxParallel     - Max concurrent agent slots (default: 3)
 * @property {number}   baseBranchParallelLimit - Max concurrent tasks per base branch (0 = unlimited)
 * @property {number}   repoAreaParallelLimit - Max concurrent tasks per repo area (0 = unlimited)
 * @property {number}   pollIntervalMs  - How often to check for tasks (default: 30000)
 * @property {string}   sdk             - SDK preference: "codex" | "copilot" | "claude" | "auto"
 * @property {number}   taskTimeoutMs   - Timeout per task execution (default: 90 * 60 * 1000)
 * @property {number}   maxRetries      - Retries per task via execWithRetry (default: 2)
 * @property {boolean}  autoCreatePr    - Record PR lifecycle handoff after agent completes (default: true)
 * @property {boolean}  flowReviewGateRequired - Block PR merge automation until review is approved (default: true)
 * @property {string}   projectId       - External project ID to poll (null = auto-detect first project)
 * @property {string}   repoRoot        - Repository root path
 * @property {string}   repoSlug        - "owner/repo" for gh CLI
 * @property {Object}   branchRouting   - Branch routing config (scopeMap/defaultBranch)
 * @property {string}   defaultTargetBranch - Default upstream branch
 * @property {Function} onTaskStarted   - callback(task, slotInfo)
 * @property {Function} onTaskCompleted - callback(task, result)
 * @property {Function} onTaskFailed    - callback(task, error)
 * @property {Function} sendTelegram    - optional telegram notifier function
 * @property {Object}   agentPrompts    - optional prompt templates loaded from config
 * @property {boolean}  workflowOwnsTaskLifecycle - Delegate finalization/recovery to workflow automation
 */

/**
 * @typedef {Object} SlotInfo
 * @property {string} taskId
 * @property {string} taskTitle
 * @property {string} branch
 * @property {string|null} baseBranch
 * @property {string} worktreePath
 * @property {string} threadKey       - agent-pool thread key (taskId used as threadKey)
 * @property {number} startedAt       - timestamp
 * @property {number|null} agentInstanceId - monotonic task-agent instance ID
 * @property {string} sdk             - which SDK is running this
 * @property {string} model           - model override (if any)
 * @property {number} attempt         - current attempt number
 * @property {"running"|"completing"|"failed"} status
 * @property {string|null} executorProfile - executor profile name, if resolved
 * @property {object|null} complexity - complexity decision metadata
 */

// ── TaskExecutor Class ──────────────────────────────────────────────────────

class TaskExecutor {
  /**
   * Create a new TaskExecutor.
   * @param {TaskExecutorOptions} options
   */
  constructor(options = {}) {
    const defaults = {
      mode: "internal",
      maxParallel: 3,
      baseBranchParallelLimit: 0,
      repoAreaParallelLimit: 0,
      pollIntervalMs: 30_000,
      sdk: "auto",
      taskTimeoutMs: 6 * 60 * 60 * 1000, // 6 hours — stream-based watchdog handles real issues
      maxRetries: 2,
      autoCreatePr: true,
      flowReviewGateRequired: isFlowReviewGateRequired(true),
      projectId: null,
      repoRoot: process.cwd(),
      repoSlug: "",
      repositories: [],
      activeWorkspace: "",
      branchRouting: null,
      defaultTargetBranch: null,
      workflowRunsDir: null,
      onTaskStarted: null,
      onTaskCompleted: null,
      onTaskFailed: null,
      sendTelegram: null,
      agentPrompts: {},
      workflowOwnsTaskLifecycle: true,
    };

    const merged = { ...defaults, ...options };

    this.mode = merged.mode;
    this.maxParallel = merged.maxParallel;
    this.baseBranchParallelLimit = clampInt(
      merged.baseBranchParallelLimit,
      0,
      1000,
      0,
    );
    this.repoAreaParallelLimit = clampInt(
      merged.repoAreaParallelLimit,
      0,
      1000,
      0,
    );
    this.pollIntervalMs = merged.pollIntervalMs;
    this.sdk = merged.sdk;
    this.taskTimeoutMs = merged.taskTimeoutMs;
    this.maxRetries = merged.maxRetries;
    this.autoCreatePr = merged.autoCreatePr;
    this.flowReviewGateRequired = merged.flowReviewGateRequired !== false;
    this.projectId = merged.projectId;
    this.repoRoot = merged.repoRoot;
    this.repoSlug = merged.repoSlug;
    this.repositories = Array.isArray(merged.repositories)
      ? merged.repositories
      : [];
    this.activeWorkspace = String(merged.activeWorkspace || "").trim();
    this.branchRouting = merged.branchRouting || null;
    this.defaultTargetBranch =
      merged.defaultTargetBranch ||
      merged.branchRouting?.defaultBranch ||
      process.env.BOSUN_TARGET_BRANCH ||
      "origin/main";
    this.workflowRunsDir =
      typeof merged.workflowRunsDir === "string" &&
      String(merged.workflowRunsDir).trim()
        ? resolve(String(merged.workflowRunsDir))
        : null;
    this.onTaskStarted = merged.onTaskStarted;
    this.onTaskCompleted = merged.onTaskCompleted;
    this.onTaskFailed = merged.onTaskFailed;
    this.sendTelegram = merged.sendTelegram;
    this.workflowOwnsTaskLifecycle = merged.workflowOwnsTaskLifecycle === true;
    this._agentPrompts =
      merged.agentPrompts && typeof merged.agentPrompts === "object"
        ? merged.agentPrompts
        : {};
    this._projectRequirements = {
      profile: normalizeRequirementsProfile(
        merged.projectRequirements?.profile ||
          process.env.PROJECT_REQUIREMENTS_PROFILE ||
          "feature",
      ),
      notes: String(
        merged.projectRequirements?.notes ||
          process.env.PROJECT_REQUIREMENTS_NOTES ||
          "",
      ).trim(),
    };
    const replenishment = merged.backlogReplenishment || {};
    const replenishmentMin = clampInt(
      replenishment.minNewTasks ||
        process.env.INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS ||
        1,
      1,
      2,
      1,
    );
    const replenishmentMaxRaw = clampInt(
      replenishment.maxNewTasks ||
        process.env.INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS ||
        2,
      1,
      3,
      2,
    );
    this._backlogReplenishment = {
      enabled:
        replenishment.enabled === true ||
        ["1", "true", "yes", "on"].includes(
          String(process.env.INTERNAL_EXECUTOR_REPLENISH_ENABLED || "")
            .trim()
            .toLowerCase(),
        ),
      minNewTasks: replenishmentMin,
      maxNewTasks: Math.max(replenishmentMin, replenishmentMaxRaw),
      requirePriority: replenishment.requirePriority !== false,
    };

    // Initialize executor scheduler for per-task SDK routing
    /** @type {ExecutorScheduler|null} */
    this._executorScheduler = null;
    try {
      const execConfig = loadExecutorConfig(
        merged.repoRoot || process.cwd(),
        null,
      );
      this._executorScheduler = new ExecutorScheduler(execConfig);
    } catch {
      // Executor config not available — fall back to sdk field
    }

    /** @type {Map<string, SlotInfo>} */
    this._activeSlots = new Map();
    /** @type {Map<string, number>} taskId → timestamp */
    this._taskCooldowns = new Map();
    this._running = false;
    this._paused = false;
    this._pausedAt = null;
    this._pauseUntil = null;
    this._pauseReason = null;
    this._pauseTimer = null;
    this._pollTimer = null;
    this._pollInProgress = false;
    this._recoveryTimer = null;
    this._inProgressRecoveryInFlight = false;
    this._inProgressRecovery = createEmptyInProgressRecoverySnapshot();
    this._resolvedProjectId = null;
    this._taskClaimsReady = false;
    this._taskClaimsInitPromise = null;
    this._claimConflictNotifiedAt = new Map();
    this._instanceIdExplicit =
      String(process.env.VE_INSTANCE_ID || "").trim() !== "" ||
      String(process.env.BOSUN_INSTANCE_ID || "").trim() !== "";
    this._instanceId =
      String(
        process.env.VE_INSTANCE_ID ||
          process.env.BOSUN_INSTANCE_ID ||
          `${os.hostname() || "host"}-${process.pid}`,
      ).trim() || `executor-${process.pid}`;
    this.taskClaimOwnerStaleTtlMs = Math.max(
      60_000,
      Number(
        process.env.TASK_CLAIM_OWNER_STALE_TTL_MS ||
          merged.taskClaimOwnerStaleTtlMs ||
          10 * 60 * 1000,
      ),
    );
    this.taskClaimRenewIntervalMs = Math.max(
      30_000,
      Number(
        process.env.TASK_CLAIM_RENEW_INTERVAL_MS ||
          merged.taskClaimRenewIntervalMs ||
          5 * 60 * 1000,
      ),
    );
    this._taskClaimRenewTimers = new Map();

    // Per-repository worktree managers for true multi-repo task execution.
    this._worktreeManagers = new Map();

    /** @type {Map<string, AbortController>} taskId → AbortController for per-slot abort */
    this._slotAbortControllers = new Map();
    /** @type {NodeJS.Timeout|null} watchdog interval handle */
    this._watchdogTimer = null;

    // Idle-continue tracking: how many times we've sent CONTINUE for a still-running task
    /** @type {Map<string, number>} taskId → idle-continue count */
    this._idleContinueCounts = new Map();

    // Anti-thrash: track consecutive no-commit completions per task
    /** @type {Map<string, number>} taskId → consecutive no-commit count */
    this._noCommitCounts = new Map();
    /** @type {Map<string, number>} taskId → skip-until timestamp */
    this._skipUntil = new Map();
    /** @type {Map<string, { conflicts: number, blockedDispatches: number, selectedDispatches: number, waitMsTotal: number, waitSamples: number, maxWaitMs: number, starvationEvents: number, maxStarvationWaitMs: number, maxStarvationCycles: number, lastConflictAt: string|null, lastSelectedAt: string|null, lastStarvationAt: string|null }>} */
    this._repoAreaLockMetrics = new Map();
    /** @type {Map<string, { taskId: string, area: string, startedAt: number, blockedCycles: number, starvationCounted: boolean, lastObservedAt: number }>} */
    this._repoAreaPendingWaits = new Map();
    /** @type {Map<string, { workerId: string, area: string, waitMsTotal: number, waitSamples: number, lastWaitMs: number, maxWaitMs: number, starvationEvents: number, maxStarvationWaitMs: number, maxStarvationCycles: number, lastBlockedAt: string|null, lastSelectedAt: string|null, lastStarvationAt: string|null }>} */
    this._repoAreaWorkerMetrics = new Map();
    this._repoAreaFairQueueCursor = 0;
    this._repoAreaDispatchCycle = {
      cycle: 0,
      at: null,
      policy: "round_robin_oldest_wait",
      candidateCount: 0,
      remaining: 0,
      selectedCount: 0,
      blockedTasks: 0,
      conflictEvents: 0,
      starvationEvents: 0,
      waitMsTotal: 0,
      waitSamples: 0,
      maxWaitMs: 0,
      blockedByArea: {},
      saturatedAreas: [],
      starvingAreas: [],
      cycleAreaMetrics: {},
      areaLimits: {},
    };
    /** @type {Array<{ cycle: number, at: string|null, policy: string, candidateCount: number, remaining: number, selectedCount: number, blockedTasks: number, conflictEvents: number, starvationEvents: number, waitMsTotal: number, waitSamples: number, maxWaitMs: number, blockedByArea: Record<string, number>, saturatedAreas: string[], starvingAreas: string[], cycleAreaMetrics: Record<string, { conflicts: number, blockedDispatches: number, selectedDispatches: number, starvationEvents: number, waitMsTotal: number, waitSamples: number, maxWaitMs: number }>, areaLimits: Record<string, { configuredLimit: number, effectiveLimit: number, adaptivePenalty: number, adaptiveReasons: string[], activeSlots: number, activeFailureRate: number, adaptiveFailureRate: number, averageMergeLatencyMs: number, adaptiveMergeLatencyMs: number }> }>} */
    this._repoAreaDispatchHistory = [];

    // Track tasks that have already been completed with a PR (prevents re-dispatch loop)
    /** @type {Set<string>} taskId set */
    this._completedWithPR = new Set();
    /** @type {Set<string>} taskId set — tracks tasks where a PR has been created for their branch */
    this._prCreatedForBranch = new Set();

    // Throttle repeated listTasks failures to avoid log spam during backend outages
    this._listTasksFailureWindowStart = 0;
    this._listTasksFailureCount = 0;
    this._listTasksBackoffUntil = 0;
    this._listTasksBackoffReason = "";
    this._listTasksCache = new Map();
    this._listTasksInflight = new Map();
    // Throttle draft-task filtering log messages (every 5 min max)
    this._lastDraftFilterLogAt = 0;
    this._projectResolveFailureWindowStart = 0;
    this._projectResolveFailureCount = 0;
    this._projectResolveBackoffUntil = 0;
    this._projectResolveBackoffReason = "";
    this._projectResolvePromise = null;
    this._noProjectsWarnedAt = 0;

    /** @type {Map<string, { taskId: string, taskTitle: string, branch: string, sdk: string, model: string, attempt: number, startedAt: number, agentInstanceId: number|null, status: string, updatedAt: number }>} */
    this._slotRuntimeState = new Map();
    this._nextAgentInstanceId = 1;
    /** @type {Map<string, ReturnType<typeof normalizeRepoAreaTelemetryEntry>>} */
    this._repoAreaTelemetry = new Map();
    /** @type {Map<string, { blockedAt: number, lastObservedWaitMs: number, areas: string[] }>} */
    this._repoAreaBlockedTasks = new Map();
    /** @type {Map<string, string[]>} */
    this._repoAreaTaskAreas = new Map();
    /** @type {Map<string, number>} */
    this._repoAreaTaskStartedAt = new Map();
    /** @type {Array<{ at: string, taskId: string, area: string, waitMs: number, resolutionReason: string }>} */
    this._repoAreaContentionEvents = [];
    this._repoAreaDispatchCycles = 0;
    this._repoAreaConflictCount = 0;

    // Repo context cache (AGENTS.md, copilot-instructions.md)
    this._contextCache = null;
    this._contextCacheTime = 0;
    this._contextCacheByRepo = new Map();

    // Error detector for classifying agent failures
    this._errorDetector = createErrorDetector({
      sendTelegram: this.sendTelegram,
      onErrorDetected: (taskId, classification) => {
        console.log(
          `${TAG} error detected for ${taskId}: ${classification.pattern} (${classification.confidence.toFixed(2)})`,
        );
      },
    });

    console.log(
      `${TAG} initialized (mode=${this.mode}, maxParallel=${this.maxParallel}, baseBranchParallelLimit=${this.baseBranchParallelLimit}, repoAreaParallelLimit=${this.repoAreaParallelLimit}, sdk=${this.sdk})`,
    );
  }

  /** Load anti-thrash state from disk (survives restarts). */
  _loadNoCommitState() {
    try {
      if (existsSync(NO_COMMIT_STATE_FILE)) {
        const raw = readFileSync(NO_COMMIT_STATE_FILE, "utf8");
        const data = JSON.parse(raw);
        if (data && typeof data === "object") {
          for (const [id, count] of Object.entries(data.noCommitCounts || {})) {
            const key = normalizeTaskIdKey(id);
            const parsed = Number(count);
            if (!key || !Number.isFinite(parsed) || parsed <= 0) continue;
            this._noCommitCounts.set(key, parsed);
          }
          for (const [id, until] of Object.entries(data.skipUntil || {})) {
            const key = normalizeTaskIdKey(id);
            if (!key) continue;
            if (until > Date.now()) {
              this._skipUntil.set(key, until);
            }
          }
          // Restore completed-with-PR tracking
          if (Array.isArray(data.completedWithPR)) {
            for (const id of data.completedWithPR) {
              const key = normalizeTaskIdKey(id);
              if (key) this._completedWithPR.add(key);
            }
          }
          if (Array.isArray(data.prCreatedForBranch)) {
            for (const id of data.prCreatedForBranch) {
              const key = normalizeTaskIdKey(id);
              if (key) this._prCreatedForBranch.add(key);
            }
          }
          console.log(
            `${TAG} restored anti-thrash state: ${this._noCommitCounts.size} tasks tracked, ${this._completedWithPR.size} completed with PR`,
          );
        }
      }
    } catch (err) {
      console.warn(`${TAG} failed to load anti-thrash state: ${err.message}`);
    }
  }

  /** Persist anti-thrash state to disk. */
  _saveNoCommitState() {
    try {
      const dir = resolve(__dirname, "..", ".cache");
      mkdirSync(dir, { recursive: true });
      const data = {
        noCommitCounts: Object.fromEntries(this._noCommitCounts),
        skipUntil: Object.fromEntries(this._skipUntil),
        completedWithPR: Array.from(this._completedWithPR),
        prCreatedForBranch: Array.from(this._prCreatedForBranch),
        savedAt: new Date().toISOString(),
      };
      writeFileSync(
        NO_COMMIT_STATE_FILE,
        JSON.stringify(data, null, 2),
        "utf8",
      );
    } catch (err) {
      console.warn(`${TAG} failed to save anti-thrash state: ${err.message}`);
    }
  }

  /** Load active slot runtime state (instance IDs + startedAt) from disk. */
  _loadRuntimeState() {
    try {
      if (!existsSync(RUNTIME_STATE_FILE)) return;
      const raw = readFileSync(RUNTIME_STATE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed?.paused === "boolean") {
        this._paused = parsed.paused;
        const pausedAt = Number(parsed?.pausedAt || 0);
        this._pausedAt =
          parsed.paused && Number.isFinite(pausedAt) && pausedAt > 0
            ? pausedAt
            : parsed.paused
              ? Date.now()
              : null;
        const pauseUntil = Number(parsed?.pauseUntil || 0);
        this._pauseUntil =
          parsed.paused && Number.isFinite(pauseUntil) && pauseUntil > 0
            ? pauseUntil
            : null;
        this._pauseReason =
          parsed.paused && parsed?.pauseReason
            ? String(parsed.pauseReason)
            : null;
        if (this._paused && !this._pauseReason) {
          this._pauseReason = this._pauseUntil ? "timed" : DEFAULT_PAUSE_REASON;
        }
        if (this._pauseUntil && this._pauseUntil <= Date.now()) {
          this._paused = false;
          this._pausedAt = null;
          this._pauseUntil = null;
          this._pauseReason = null;
        } else if (this._paused && this._pauseUntil) {
          this._schedulePauseExpiry();
        }
        writeOrchestratorPauseState(this._paused, this._pauseReason, {
          pausedAt: this._pausedAt,
          pauseUntil: this._pauseUntil,
          source: "runtime-restore",
        });
      }
      const nextId = Number(parsed?.nextAgentInstanceId || 1);
      if (Number.isFinite(nextId) && nextId > 0) {
        this._nextAgentInstanceId = Math.floor(nextId);
      }
      this._inProgressRecovery = normalizeInProgressRecoverySnapshot(
        parsed?.inProgressRecovery,
      );

      this._repoAreaDispatchCycles = Math.max(
        0,
        Math.trunc(Number(parsed?.repoAreaDispatchCycles || 0)),
      );
      this._repoAreaConflictCount = Math.max(
        0,
        Math.trunc(Number(parsed?.repoAreaConflictCount || 0)),
      );
      this._repoAreaFairQueueCursor = Math.max(
        0,
        Math.trunc(Number(parsed?.repoAreaFairQueueCursor || 0)),
      );
      this._repoAreaLockMetrics.clear();
      for (const [area, raw] of Object.entries(parsed?.repoAreaLockMetrics || {})) {
        const areaKey = normalizeRepoAreaKey(area);
        if (!areaKey) continue;
        this._repoAreaLockMetrics.set(areaKey, {
          conflicts: Math.max(0, Math.trunc(Number(raw?.conflicts || 0))),
          blockedDispatches: Math.max(
            0,
            Math.trunc(Number(raw?.blockedDispatches || 0)),
          ),
          selectedDispatches: Math.max(
            0,
            Math.trunc(Number(raw?.selectedDispatches || 0)),
          ),
          waitMsTotal: Math.max(0, Math.trunc(Number(raw?.waitMsTotal || 0))),
          waitSamples: Math.max(0, Math.trunc(Number(raw?.waitSamples || 0))),
          maxWaitMs: Math.max(0, Math.trunc(Number(raw?.maxWaitMs || 0))),
          starvationEvents: Math.max(
            0,
            Math.trunc(Number(raw?.starvationEvents || 0)),
          ),
          maxStarvationWaitMs: Math.max(
            0,
            Math.trunc(Number(raw?.maxStarvationWaitMs || 0)),
          ),
          maxStarvationCycles: Math.max(
            0,
            Math.trunc(Number(raw?.maxStarvationCycles || 0)),
          ),
          lastConflictAt: raw?.lastConflictAt ? String(raw.lastConflictAt) : null,
          lastSelectedAt: raw?.lastSelectedAt ? String(raw.lastSelectedAt) : null,
          lastStarvationAt: raw?.lastStarvationAt
            ? String(raw.lastStarvationAt)
            : null,
        });
      }
      this._repoAreaWorkerMetrics.clear();
      for (const [key, raw] of Object.entries(parsed?.repoAreaWorkerMetrics || {})) {
        const areaKey = normalizeRepoAreaKey(raw?.area);
        const workerId = String(raw?.workerId || "").trim() || "executor";
        if (!areaKey) continue;
        this._repoAreaWorkerMetrics.set(String(key || `${areaKey}::${workerId}`), {
          workerId,
          area: areaKey,
          waitMsTotal: Math.max(0, Math.trunc(Number(raw?.waitMsTotal || 0))),
          waitSamples: Math.max(0, Math.trunc(Number(raw?.waitSamples || 0))),
          lastWaitMs: Math.max(0, Math.trunc(Number(raw?.lastWaitMs || 0))),
          maxWaitMs: Math.max(0, Math.trunc(Number(raw?.maxWaitMs || 0))),
          starvationEvents: Math.max(
            0,
            Math.trunc(Number(raw?.starvationEvents || 0)),
          ),
          maxStarvationWaitMs: Math.max(
            0,
            Math.trunc(Number(raw?.maxStarvationWaitMs || 0)),
          ),
          maxStarvationCycles: Math.max(
            0,
            Math.trunc(Number(raw?.maxStarvationCycles || 0)),
          ),
          lastBlockedAt: raw?.lastBlockedAt ? String(raw.lastBlockedAt) : null,
          lastSelectedAt: raw?.lastSelectedAt ? String(raw.lastSelectedAt) : null,
          lastStarvationAt: raw?.lastStarvationAt
            ? String(raw.lastStarvationAt)
            : null,
        });
      }
      this._repoAreaDispatchCycle = {
        cycle: Math.max(
          0,
          Math.trunc(Number(parsed?.repoAreaDispatchCycle?.cycle || 0)),
        ),
        at: parsed?.repoAreaDispatchCycle?.at
          ? String(parsed.repoAreaDispatchCycle.at)
          : null,
        policy:
          String(parsed?.repoAreaDispatchCycle?.policy || "").trim() ||
          "round_robin_oldest_wait",
        candidateCount: Math.max(
          0,
          Math.trunc(Number(parsed?.repoAreaDispatchCycle?.candidateCount || 0)),
        ),
        remaining: Math.max(
          0,
          Math.trunc(Number(parsed?.repoAreaDispatchCycle?.remaining || 0)),
        ),
        selectedCount: Math.max(
          0,
          Math.trunc(Number(parsed?.repoAreaDispatchCycle?.selectedCount || 0)),
        ),
        blockedTasks: Math.max(
          0,
          Math.trunc(Number(parsed?.repoAreaDispatchCycle?.blockedTasks || 0)),
        ),
        conflictEvents: Math.max(
          0,
          Math.trunc(Number(parsed?.repoAreaDispatchCycle?.conflictEvents || 0)),
        ),
        starvationEvents: Math.max(
          0,
          Math.trunc(Number(parsed?.repoAreaDispatchCycle?.starvationEvents || 0)),
        ),
        waitMsTotal: Math.max(
          0,
          Math.trunc(Number(parsed?.repoAreaDispatchCycle?.waitMsTotal || 0)),
        ),
        waitSamples: Math.max(
          0,
          Math.trunc(Number(parsed?.repoAreaDispatchCycle?.waitSamples || 0)),
        ),
        maxWaitMs: Math.max(
          0,
          Math.trunc(Number(parsed?.repoAreaDispatchCycle?.maxWaitMs || 0)),
        ),
        blockedByArea:
          parsed?.repoAreaDispatchCycle?.blockedByArea &&
          typeof parsed.repoAreaDispatchCycle.blockedByArea === "object"
            ? Object.assign(
              Object.create(null),
              Object.fromEntries(
                Object.entries(parsed.repoAreaDispatchCycle.blockedByArea)
                  .map(([key, val]) => [
                    normalizeRepoAreaKey(key),
                    Math.max(0, Math.trunc(Number(val || 0))),
                  ])
                  .filter(([key]) => Boolean(key)),
              ),
            )
            : Object.create(null),
        saturatedAreas: Array.isArray(parsed?.repoAreaDispatchCycle?.saturatedAreas)
          ? parsed.repoAreaDispatchCycle.saturatedAreas
              .map((area) => normalizeRepoAreaKey(area))
              .filter(Boolean)
          : [],
        starvingAreas: Array.isArray(parsed?.repoAreaDispatchCycle?.starvingAreas)
          ? parsed.repoAreaDispatchCycle.starvingAreas
              .map((area) => normalizeRepoAreaKey(area))
              .filter(Boolean)
          : [],
        cycleAreaMetrics:
          parsed?.repoAreaDispatchCycle?.cycleAreaMetrics &&
          typeof parsed.repoAreaDispatchCycle.cycleAreaMetrics === "object"
            ? Object.fromEntries(
              Object.entries(parsed.repoAreaDispatchCycle.cycleAreaMetrics)
                .map(([area, metric]) => [
                  normalizeRepoAreaKey(area),
                  {
                    conflicts: Math.max(0, Math.trunc(Number(metric?.conflicts || 0))),
                    blockedDispatches: Math.max(
                      0,
                      Math.trunc(Number(metric?.blockedDispatches || 0)),
                    ),
                    selectedDispatches: Math.max(
                      0,
                      Math.trunc(Number(metric?.selectedDispatches || 0)),
                    ),
                    starvationEvents: Math.max(
                      0,
                      Math.trunc(Number(metric?.starvationEvents || 0)),
                    ),
                    waitMsTotal: Math.max(
                      0,
                      Math.trunc(Number(metric?.waitMsTotal || 0)),
                    ),
                    waitSamples: Math.max(
                      0,
                      Math.trunc(Number(metric?.waitSamples || 0)),
                    ),
                    maxWaitMs: Math.max(0, Math.trunc(Number(metric?.maxWaitMs || 0))),
                  },
                ])
                .filter(([area]) => Boolean(area)),
            )
            : {},
        areaLimits:
          parsed?.repoAreaDispatchCycle?.areaLimits &&
          typeof parsed.repoAreaDispatchCycle.areaLimits === "object"
            ? Object.fromEntries(
              Object.entries(parsed.repoAreaDispatchCycle.areaLimits)
                .map(([area, limit]) => [
                  normalizeRepoAreaKey(area),
                  {
                    configuredLimit: Math.max(
                      0,
                      Math.trunc(Number(limit?.configuredLimit || 0)),
                    ),
                    effectiveLimit: Math.max(
                      0,
                      Math.trunc(Number(limit?.effectiveLimit || 0)),
                    ),
                    adaptivePenalty: Math.max(
                      0,
                      Math.trunc(Number(limit?.adaptivePenalty || 0)),
                    ),
                    adaptiveReasons: Array.isArray(limit?.adaptiveReasons)
                      ? limit.adaptiveReasons
                        .map((reason) => String(reason || "").trim())
                        .filter(Boolean)
                      : [],
                    activeSlots: Math.max(0, Math.trunc(Number(limit?.activeSlots || 0))),
                    activeFailureRate: Math.max(0, Number(limit?.activeFailureRate || 0)),
                    adaptiveFailureRate: Math.max(
                      0,
                      Number(limit?.adaptiveFailureRate || 0),
                    ),
                    averageMergeLatencyMs: Math.max(
                      0,
                      Number(limit?.averageMergeLatencyMs || 0),
                    ),
                    adaptiveMergeLatencyMs: Math.max(
                      0,
                      Number(limit?.adaptiveMergeLatencyMs || 0),
                    ),
                  },
                ])
                .filter(([area]) => Boolean(area)),
            )
            : {},
      };
      this._repoAreaTelemetry.clear();
      for (const [area, raw] of Object.entries(parsed?.repoAreaTelemetry || {})) {
        const areaKey = normalizeRepoAreaKey(area);
        if (!areaKey) continue;
        this._repoAreaTelemetry.set(areaKey, normalizeRepoAreaTelemetryEntry(raw));
      }
      this._repoAreaBlockedTasks.clear();
      for (const [taskId, raw] of Object.entries(parsed?.repoAreaBlockedTasks || {})) {
        const key = normalizeTaskIdKey(taskId);
        if (!key) continue;
        const blockedAt = Math.max(0, Math.trunc(Number(raw?.blockedAt || 0)));
        const lastObservedWaitMs = Math.max(
          0,
          Math.trunc(Number(raw?.lastObservedWaitMs || 0)),
        );
        const areas = Array.isArray(raw?.areas)
          ? raw.areas.map((area) => normalizeRepoAreaKey(area)).filter(Boolean)
          : [];
        if (!blockedAt || areas.length === 0) continue;
        this._repoAreaBlockedTasks.set(key, {
          blockedAt,
          lastObservedWaitMs,
          areas: [...new Set(areas)],
        });
      }
      this._repoAreaTaskAreas.clear();
      for (const [taskId, rawAreas] of Object.entries(parsed?.repoAreaTaskAreas || {})) {
        const key = normalizeTaskIdKey(taskId);
        if (!key) continue;
        const areas = Array.isArray(rawAreas)
          ? rawAreas.map((area) => normalizeRepoAreaKey(area)).filter(Boolean)
          : [];
        if (areas.length === 0) continue;
        this._repoAreaTaskAreas.set(key, [...new Set(areas)]);
      }
      this._repoAreaTaskStartedAt.clear();
      for (const [taskId, rawStartedAt] of Object.entries(parsed?.repoAreaTaskStartedAt || {})) {
        const key = normalizeTaskIdKey(taskId);
        const startedAt = Math.max(0, Math.trunc(Number(rawStartedAt || 0)));
        if (!key || !startedAt) continue;
        this._repoAreaTaskStartedAt.set(key, startedAt);
      }
      this._repoAreaContentionEvents = Array.isArray(parsed?.repoAreaContentionEvents)
        ? parsed.repoAreaContentionEvents
          .slice(-REPO_AREA_CONTENTION_EVENT_LIMIT)
          .map((event) => ({
            at: event?.at
              ? String(event.at)
              : new Date().toISOString(),
            taskId: normalizeTaskIdKey(event?.taskId) || "",
            area: normalizeRepoAreaKey(event?.area) || "",
            waitMs: Math.max(0, Math.trunc(Number(event?.waitMs || 0))),
            resolutionReason: normalizeRepoAreaResolutionReason(
              event?.resolutionReason,
            ),
          }))
          .filter((event) => event.taskId && event.area)
        : [];
      this._repoAreaDispatchHistory = Array.isArray(parsed?.repoAreaDispatchHistory)
        ? parsed.repoAreaDispatchHistory
          .slice(-20)
          .map((entry) => ({
            cycle: Math.max(0, Math.trunc(Number(entry?.cycle || 0))),
            at: entry?.at ? String(entry.at) : null,
            policy:
              String(entry?.policy || "").trim() || "round_robin_oldest_wait",
            candidateCount: Math.max(0, Math.trunc(Number(entry?.candidateCount || 0))),
            remaining: Math.max(0, Math.trunc(Number(entry?.remaining || 0))),
            selectedCount: Math.max(0, Math.trunc(Number(entry?.selectedCount || 0))),
            blockedTasks: Math.max(0, Math.trunc(Number(entry?.blockedTasks || 0))),
            conflictEvents: Math.max(
              0,
              Math.trunc(Number(entry?.conflictEvents || 0)),
            ),
            starvationEvents: Math.max(
              0,
              Math.trunc(Number(entry?.starvationEvents || 0)),
            ),
            waitMsTotal: Math.max(0, Math.trunc(Number(entry?.waitMsTotal || 0))),
            waitSamples: Math.max(0, Math.trunc(Number(entry?.waitSamples || 0))),
            maxWaitMs: Math.max(0, Math.trunc(Number(entry?.maxWaitMs || 0))),
            blockedByArea:
              entry?.blockedByArea && typeof entry.blockedByArea === "object"
                ? Object.fromEntries(
                  Object.entries(entry.blockedByArea)
                    .map(([area, count]) => [
                      normalizeRepoAreaKey(area),
                      Math.max(0, Math.trunc(Number(count || 0))),
                    ])
                    .filter(([area]) => Boolean(area)),
                )
                : {},
            saturatedAreas: Array.isArray(entry?.saturatedAreas)
              ? entry.saturatedAreas
                .map((area) => normalizeRepoAreaKey(area))
                .filter(Boolean)
              : [],
            starvingAreas: Array.isArray(entry?.starvingAreas)
              ? entry.starvingAreas
                .map((area) => normalizeRepoAreaKey(area))
                .filter(Boolean)
              : [],
            cycleAreaMetrics:
              entry?.cycleAreaMetrics && typeof entry.cycleAreaMetrics === "object"
                ? Object.fromEntries(
                  Object.entries(entry.cycleAreaMetrics)
                    .map(([area, metric]) => [
                      normalizeRepoAreaKey(area),
                      {
                        conflicts: Math.max(
                          0,
                          Math.trunc(Number(metric?.conflicts || 0)),
                        ),
                        blockedDispatches: Math.max(
                          0,
                          Math.trunc(Number(metric?.blockedDispatches || 0)),
                        ),
                        selectedDispatches: Math.max(
                          0,
                          Math.trunc(Number(metric?.selectedDispatches || 0)),
                        ),
                        starvationEvents: Math.max(
                          0,
                          Math.trunc(Number(metric?.starvationEvents || 0)),
                        ),
                        waitMsTotal: Math.max(
                          0,
                          Math.trunc(Number(metric?.waitMsTotal || 0)),
                        ),
                        waitSamples: Math.max(
                          0,
                          Math.trunc(Number(metric?.waitSamples || 0)),
                        ),
                        maxWaitMs: Math.max(
                          0,
                          Math.trunc(Number(metric?.maxWaitMs || 0)),
                        ),
                      },
                    ])
                    .filter(([area]) => Boolean(area)),
                )
                : {},
            areaLimits:
              entry?.areaLimits && typeof entry.areaLimits === "object"
                ? Object.fromEntries(
                  Object.entries(entry.areaLimits)
                    .map(([area, limit]) => [
                      normalizeRepoAreaKey(area),
                      {
                        configuredLimit: Math.max(
                          0,
                          Math.trunc(Number(limit?.configuredLimit || 0)),
                        ),
                        effectiveLimit: Math.max(
                          0,
                          Math.trunc(Number(limit?.effectiveLimit || 0)),
                        ),
                        adaptivePenalty: Math.max(
                          0,
                          Math.trunc(Number(limit?.adaptivePenalty || 0)),
                        ),
                        adaptiveReasons: Array.isArray(limit?.adaptiveReasons)
                          ? limit.adaptiveReasons
                            .map((reason) => String(reason || "").trim())
                            .filter(Boolean)
                          : [],
                        activeSlots: Math.max(0, Math.trunc(Number(limit?.activeSlots || 0))),
                        activeFailureRate: Math.max(
                          0,
                          Number(limit?.activeFailureRate || 0),
                        ),
                        adaptiveFailureRate: Math.max(
                          0,
                          Number(limit?.adaptiveFailureRate || 0),
                        ),
                        averageMergeLatencyMs: Math.max(
                          0,
                          Number(limit?.averageMergeLatencyMs || 0),
                        ),
                        adaptiveMergeLatencyMs: Math.max(
                          0,
                          Number(limit?.adaptiveMergeLatencyMs || 0),
                        ),
                      },
                    ])
                    .filter(([area]) => Boolean(area)),
                )
                : {},
          }))
        : [];

      const slots = parsed?.slots || {};
      let restored = 0;
      for (const [taskId, entry] of Object.entries(slots)) {
        const startedAt = Number(entry?.startedAt || 0);
        if (!taskId || !Number.isFinite(startedAt) || startedAt <= 0) continue;
        const agentInstanceIdRaw = Number(entry?.agentInstanceId);
        const agentInstanceId =
          Number.isFinite(agentInstanceIdRaw) && agentInstanceIdRaw > 0
            ? Math.floor(agentInstanceIdRaw)
            : null;
        if (agentInstanceId) {
          this._nextAgentInstanceId = Math.max(
            this._nextAgentInstanceId,
            agentInstanceId + 1,
          );
        }
        this._slotRuntimeState.set(taskId, {
          taskId,
          taskTitle: String(entry?.taskTitle || ""),
          branch: String(entry?.branch || ""),
          sdk: String(entry?.sdk || ""),
          model: String(entry?.model || ""),
          attempt: Number(entry?.attempt || 0),
          startedAt,
          agentInstanceId,
          status: String(entry?.status || "running"),
          updatedAt: Number(entry?.updatedAt || Date.now()),
        });
        restored++;
      }
      if (restored > 0) {
        console.log(
          `${TAG} restored runtime slot state for ${restored} task(s), next agent instance #${this._nextAgentInstanceId}`,
        );
      }
    } catch (err) {
      console.warn(`${TAG} failed to load runtime slot state: ${err.message}`);
    }
  }

  /** Persist active slot runtime state to disk (survives monitor restart). */
  _saveRuntimeState() {
    try {
      const dir = resolve(__dirname, "..", ".cache");
      mkdirSync(dir, { recursive: true });

      const slots = {};
      for (const [taskId, entry] of this._slotRuntimeState.entries()) {
        slots[taskId] = {
          taskId,
          taskTitle: entry.taskTitle || "",
          branch: entry.branch || "",
          sdk: entry.sdk || "",
          model: entry.model || "",
          attempt: Number(entry.attempt || 0),
          startedAt: Number(entry.startedAt || Date.now()),
          agentInstanceId:
            Number.isFinite(entry.agentInstanceId) && entry.agentInstanceId > 0
              ? Number(entry.agentInstanceId)
            : null,
          status: entry.status || "running",
          updatedAt: Number(entry.updatedAt || Date.now()),
        };
      }

      const payloadRecord = {
        paused: this._paused,
        pausedAt: this._pausedAt,
        pauseUntil: this._pauseUntil,
        pauseReason: this._pauseReason,
        nextAgentInstanceId: this._nextAgentInstanceId,
        inProgressRecovery: this._inProgressRecovery,
        repoAreaParallelLimit: this.repoAreaParallelLimit,
        repoAreaDispatchCycles: this._repoAreaDispatchCycles,
        repoAreaConflictCount: this._repoAreaConflictCount,
        repoAreaFairQueueCursor: this._repoAreaFairQueueCursor,
        repoAreaLockMetrics: Object.fromEntries(this._repoAreaLockMetrics),
        repoAreaWorkerMetrics: Object.fromEntries(this._repoAreaWorkerMetrics),
        repoAreaDispatchCycle: {
          ...this._repoAreaDispatchCycle,
          blockedByArea: { ...this._repoAreaDispatchCycle.blockedByArea },
          saturatedAreas: [...this._repoAreaDispatchCycle.saturatedAreas],
          starvingAreas: [...(this._repoAreaDispatchCycle.starvingAreas || [])],
          cycleAreaMetrics: { ...this._repoAreaDispatchCycle.cycleAreaMetrics },
          areaLimits: { ...(this._repoAreaDispatchCycle.areaLimits || {}) },
        },
        repoAreaTelemetry: Object.fromEntries(this._repoAreaTelemetry),
        repoAreaBlockedTasks: Object.fromEntries(this._repoAreaBlockedTasks),
        repoAreaTaskAreas: Object.fromEntries(this._repoAreaTaskAreas),
        repoAreaTaskStartedAt: Object.fromEntries(this._repoAreaTaskStartedAt),
        repoAreaContentionEvents: this._repoAreaContentionEvents.slice(
          -REPO_AREA_CONTENTION_EVENT_LIMIT,
        ),
        repoAreaDispatchHistory: this._repoAreaDispatchHistory.slice(-20),
        repoAreaLockStatus: this._buildRepoAreaLockStatus(),
        slots,
      };
      const comparablePayload = JSON.stringify(payloadRecord);
      if (comparablePayload === this._lastRuntimeStatePayload) return;
      const payload = JSON.stringify(
        {
          ...payloadRecord,
          savedAt: new Date().toISOString(),
        },
        null,
        2,
      );
      writeFileSync(RUNTIME_STATE_FILE, payload, "utf8");
      this._lastRuntimeStatePayload = comparablePayload;
    } catch (err) {
      console.warn(`${TAG} failed to save runtime slot state: ${err.message}`);
    }
  }

  /**
   * Mirror slot fields into persisted runtime state.
   * @param {SlotInfo} slot
   */
  _upsertRuntimeSlot(slot) {
    if (!slot?.taskId) return;
    this._slotRuntimeState.set(slot.taskId, {
      taskId: slot.taskId,
      taskTitle: slot.taskTitle || "",
      branch: slot.branch || "",
      sdk: slot.sdk || "",
      model: slot.model || "",
      attempt: Number(slot.attempt || 0),
      startedAt: Number(slot.startedAt || Date.now()),
      agentInstanceId:
        Number.isFinite(slot.agentInstanceId) && slot.agentInstanceId > 0
          ? Number(slot.agentInstanceId)
          : null,
      status: slot.status || "running",
      updatedAt: Date.now(),
    });
    this._saveRuntimeState();
  }

  _ensureRepoAreaTelemetry(areaKey) {
    const normalized = normalizeRepoAreaKey(areaKey);
    if (!normalized) return null;
    let entry = this._repoAreaTelemetry.get(normalized);
    if (!entry) {
      entry = createEmptyRepoAreaTelemetryEntry();
      this._repoAreaTelemetry.set(normalized, entry);
    }
    return entry;
  }

  _rememberTaskRepoAreas(task, now = Date.now()) {
    const taskId = normalizeTaskIdKey(task?.id || task?.taskId || task?.task_id);
    if (!taskId) return [];
    const areas = extractRepoAreasFromTaskLike(task);
    if (areas.length > 0) {
      this._repoAreaTaskAreas.set(taskId, areas);
      if (!this._repoAreaTaskStartedAt.has(taskId)) {
        this._repoAreaTaskStartedAt.set(taskId, now);
      }
    }
    return areas;
  }

  _clearRepoAreaBlockedTask(taskId) {
    const key = normalizeTaskIdKey(taskId);
    if (!key) return;
    this._repoAreaBlockedTasks.delete(key);
  }

  _recordRepoAreaConflict(task, blockedAreas, now = Date.now()) {
    const taskId = normalizeTaskIdKey(task?.id || task?.taskId || task?.task_id);
    if (!taskId || !Array.isArray(blockedAreas) || blockedAreas.length === 0) return;
    const normalizedAreas = [...new Set(blockedAreas.map((area) => normalizeRepoAreaKey(area)).filter(Boolean))];
    if (normalizedAreas.length === 0) return;
    const current = this._repoAreaBlockedTasks.get(taskId) || {
      blockedAt: now,
      lastObservedWaitMs: 0,
      areas: normalizedAreas,
    };
    current.areas = normalizedAreas;
    const waitMs = Math.max(0, now - current.blockedAt);
    const waitDelta = Math.max(0, waitMs - Number(current.lastObservedWaitMs || 0));
    current.lastObservedWaitMs = waitMs;
    this._repoAreaBlockedTasks.set(taskId, current);
    this._repoAreaConflictCount += 1;
    for (const areaKey of normalizedAreas) {
      const entry = this._ensureRepoAreaTelemetry(areaKey);
      if (!entry) continue;
      entry.conflictCount += 1;
      entry.totalWaitMs += waitDelta;
      entry.lastWaitMs = waitMs;
      entry.maxWaitMs = Math.max(entry.maxWaitMs, waitMs);
      entry.lastBlockedAt = now;
      const lockMetric = this._getRepoAreaLockMetric(areaKey);
      if (lockMetric) lockMetric.conflicts += 1;
      const workerMetric = this._getRepoAreaWorkerMetric(areaKey);
      if (workerMetric) workerMetric.lastBlockedAt = new Date(now).toISOString();
    }
  }

  _getEffectiveRepoAreaLimit(areaKey) {
    const baseLimit = Number(this.repoAreaParallelLimit || 0);
    if (!Number.isFinite(baseLimit) || baseLimit <= 0) return 0;
    const entry = this._repoAreaTelemetry.get(normalizeRepoAreaKey(areaKey));
    return buildRepoAreaAdaptiveSignals(entry, baseLimit).effectiveLimit;
  }

  noteRepoAreaOutcome(taskOrTaskId, outcome = {}) {
    const taskId = normalizeTaskIdKey(
      typeof taskOrTaskId === "string"
        ? taskOrTaskId
        : taskOrTaskId?.id || taskOrTaskId?.taskId || taskOrTaskId?.task_id,
    );
    if (!taskId) return false;

    const areas =
      typeof taskOrTaskId === "string"
        ? this._repoAreaTaskAreas.get(taskId) || []
        : this._rememberTaskRepoAreas(taskOrTaskId);
    if (!Array.isArray(areas) || areas.length === 0) return false;

    const now = Date.now();
    const status = normalizeRepoAreaKey(outcome.status);
    const isFailure =
      outcome.failed === true ||
      ["blocked", "failed", "error", "errored"].includes(status);
    const isSuccess =
      outcome.failed !== true &&
      ["done", "inreview", "complete", "completed", "merged", "success"].includes(status);
    let mergeLatencyMs = Number(outcome.mergeLatencyMs || 0);
    if ((!Number.isFinite(mergeLatencyMs) || mergeLatencyMs <= 0) && isSuccess) {
      const startedAt = Number(this._repoAreaTaskStartedAt.get(taskId) || 0);
      if (startedAt > 0) mergeLatencyMs = Math.max(0, now - startedAt);
    }

    for (const areaKey of areas) {
      const entry = this._ensureRepoAreaTelemetry(areaKey);
      if (!entry) continue;
      if (isFailure || isSuccess) {
        entry.recentOutcomes.push(isFailure ? 1 : 0);
        entry.recentOutcomes = entry.recentOutcomes.slice(-20);
        entry.lastOutcomeAt = now;
      }
      if (Number.isFinite(mergeLatencyMs) && mergeLatencyMs > 0) {
        entry.mergeLatencySamples.push(Math.trunc(mergeLatencyMs));
        entry.mergeLatencySamples = entry.mergeLatencySamples.slice(-12);
        entry.lastOutcomeAt = now;
      }
    }

    this._clearRepoAreaWaitsForTask(
      typeof taskOrTaskId === "string" ? { id: taskId, repo_areas: areas } : taskOrTaskId,
      now,
      "abandoned",
    );
    this._clearRepoAreaBlockedTask(taskId);
    if (isFailure || isSuccess) {
      this._repoAreaTaskStartedAt.delete(taskId);
    }
    this._saveRuntimeState();
    return true;
  }

  _buildRepoAreaLockStatus() {
    return buildRepoAreaLockStatusSnapshot({
      repoAreaParallelLimit: this.repoAreaParallelLimit,
      activeSlots: Array.from(this._activeSlots.values()),
      telemetryByArea: this._repoAreaTelemetry,
      blockedTasks: this._repoAreaBlockedTasks,
      dispatchCycles: this._repoAreaDispatchCycles,
      totalConflicts: this._repoAreaConflictCount,
    });
  }

  /**
   * Delete runtime state for a task slot after completion/failure reset.
   * @param {string} taskId
   */
  _removeRuntimeSlot(taskId) {
    if (!taskId) return;
    if (this._slotRuntimeState.delete(taskId)) {
      this._saveRuntimeState();
    }
  }

  _shouldBackoffListTasks() {
    return (
      this._listTasksBackoffUntil && Date.now() < this._listTasksBackoffUntil
    );
  }

  _shouldBackoffProjectResolution() {
    return (
      this._projectResolveBackoffUntil &&
      Date.now() < this._projectResolveBackoffUntil
    );
  }

  _resetListTasksBackoff() {
    this._listTasksFailureWindowStart = 0;
    this._listTasksFailureCount = 0;
    this._listTasksBackoffUntil = 0;
    this._listTasksBackoffReason = "";
  }

  _noteListTasksFailure(err) {
    const now = Date.now();
    const windowMs = 30_000;
    const threshold = 3;
    const backoffMs = 60_000;
    if (
      !this._listTasksFailureWindowStart ||
      now - this._listTasksFailureWindowStart > windowMs
    ) {
      this._listTasksFailureWindowStart = now;
      this._listTasksFailureCount = 0;
    }
    this._listTasksFailureCount += 1;
    const message = err?.message || String(err);
    if (this._listTasksFailureCount >= threshold) {
      this._listTasksBackoffUntil = now + backoffMs;
      this._listTasksBackoffReason = message;
      this._listTasksFailureCount = 0;
      this._listTasksFailureWindowStart = now;
      console.warn(
        `${TAG} listTasks backing off for ${Math.round(
          backoffMs / 1000,
        )}s after repeated failures: ${message}`,
      );
      return;
    }
    console.warn(`${TAG} failed to list tasks: ${message}`);
  }

  _resetProjectResolutionBackoff() {
    this._projectResolveFailureWindowStart = 0;
    this._projectResolveFailureCount = 0;
    this._projectResolveBackoffUntil = 0;
    this._projectResolveBackoffReason = "";
  }

  _noteProjectResolutionFailure(err) {
    const now = Date.now();
    const windowMs = 60_000;
    const threshold = 3;
    const backoffMs = 2 * 60_000;
    if (
      !this._projectResolveFailureWindowStart ||
      now - this._projectResolveFailureWindowStart > windowMs
    ) {
      this._projectResolveFailureWindowStart = now;
      this._projectResolveFailureCount = 0;
    }
    this._projectResolveFailureCount += 1;
    const message = err?.message || String(err);
    if (this._projectResolveFailureCount >= threshold) {
      this._projectResolveBackoffUntil = now + backoffMs;
      this._projectResolveBackoffReason = message;
      this._projectResolveFailureCount = 0;
      this._projectResolveFailureWindowStart = now;
      console.warn(
        `${TAG} project resolution backing off for ${Math.round(
          backoffMs / 1000,
        )}s after repeated failures: ${message}`,
      );
      return;
    }
    console.warn(`${TAG} failed to list projects: ${message}`);
  }

  _warnNoProjects() {
    const now = Date.now();
    if (now - this._noProjectsWarnedAt < 60_000) {
      return;
    }
    this._noProjectsWarnedAt = now;
    if (this._shouldBackoffProjectResolution()) {
      const waitMs = Math.max(0, this._projectResolveBackoffUntil - now);
      const reason = this._projectResolveBackoffReason
        ? ` (${this._projectResolveBackoffReason})`
        : "";
      console.warn(
        `${TAG} no projects found — skipping poll for ${Math.round(
          waitMs / 1000,
        )}s${reason}`,
      );
      return;
    }
    console.warn(`${TAG} no projects found — skipping poll`);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start the periodic poll loop for tasks.
   */
  start() {
    // Load internal task store
    try {
      loadTaskStore();
    } catch (err) {
      console.warn(`${TAG} task store load warning: ${err.message}`);
    }

    // Initialize agent lifecycle hooks
    try {
      loadHooks();
      registerBuiltinHooks();
      console.log(`${TAG} agent lifecycle hooks initialized`);
    } catch (err) {
      console.warn(`${TAG} hook initialization warning: ${err.message}`);
    }

    // Restore anti-thrash state from disk
    this._loadNoCommitState();
    // Restore active slot metadata (agent instance IDs + original startedAt)
    this._loadRuntimeState();

    this._running = true;
    // Start watchdog to detect and kill stalled agent slots
    this._startWatchdog();

    const startRecovery = async () => {
      try {
        await ensureThreadRegistryLoaded();
      } catch (err) {
        console.warn(
          `${TAG} thread registry load warning: ${err?.message || err}`,
        );
      }

      const pruned = pruneAllExhaustedThreads();
      if (pruned > 0) {
        console.log(
          `${TAG} cleaned up ${pruned} stale agent threads on startup`,
        );
      }

      try {
        await this._runInProgressRecoverySafely("startup");
      } catch {
        // _runInProgressRecoverySafely already logs details
      }
    };

    startRecovery()
      .catch((err) => {
        console.warn(`${TAG} thread recovery error: ${err?.message || err}`);
      })
      .finally(() => {
        if (!this.workflowOwnsTaskLifecycle) this._runPollLoopSafely();
      });

    if (this._recoveryTimer) {
      clearInterval(this._recoveryTimer);
      this._recoveryTimer = null;
    }
    this._recoveryTimer = setInterval(() => {
      void this._runInProgressRecoverySafely("interval");
    }, INPROGRESS_RECOVERY_INTERVAL_MS);

    if (this.workflowOwnsTaskLifecycle) {
      console.log(
        `${TAG} started — workflow-owned lifecycle active, poll loop disabled (workflows handle task dispatch)`,
      );
    } else {
      this._pollTimer = setInterval(
        () => this._runPollLoopSafely(),
        this.pollIntervalMs,
      );
      console.log(
        `${TAG} started — polling every ${this.pollIntervalMs / 1000}s for up to ${this.maxParallel} parallel tasks`,
      );
    }
  }

  /**
   * Gracefully stop the executor, waiting for active tasks to finish.
   * @returns {Promise<void>}
   */
  async stop() {
    this._running = false;
    this._stopWatchdog();
    this._stopAllTaskClaimRenewals();
    if (this._pauseTimer) {
      clearTimeout(this._pauseTimer);
      this._pauseTimer = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._recoveryTimer) {
      clearInterval(this._recoveryTimer);
      this._recoveryTimer = null;
    }

    // Persist runtime state before waiting so unexpected exits still recover
    this._saveRuntimeState();

    const activeCount = this._activeSlots.size;
    if (activeCount > 0) {
      console.log(
        `${TAG} stopping — waiting for ${activeCount} active task(s) to finish (${GRACEFUL_SHUTDOWN_MS / 1000}s grace)...`,
      );
      const deadline = Date.now() + GRACEFUL_SHUTDOWN_MS;
      while (this._activeSlots.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    console.log(`${TAG} stopped (${this._activeSlots.size} tasks were active)`);
  }

  /**
   * Pause task dispatch — running tasks continue, but no new tasks are picked up.
   * @returns {boolean} true if paused (false if already paused)
   */
  pause(reason = null) {
    if (this._paused) return false;
    this._paused = true;
    this._pausedAt = Date.now();
    this._pauseReason =
      reason ? String(reason) : this._pauseReason || DEFAULT_PAUSE_REASON;
    this._saveRuntimeState();
    writeOrchestratorPauseState(true, this._pauseReason, {
      pausedAt: this._pausedAt,
      pauseUntil: this._pauseUntil,
    });
    console.log(
      `${TAG} paused — no new tasks will be dispatched (active: ${this._activeSlots.size})`,
    );
    return true;
  }

  /**
   * Resume task dispatch after a pause.
   * @returns {boolean} true if resumed (false if not paused)
   */
  resume() {
    if (!this._paused) return false;
    const pauseDuration = this._pausedAt
      ? Math.round((Date.now() - this._pausedAt) / 1000)
      : 0;
    this._paused = false;
    this._pausedAt = null;
    this._pauseUntil = null;
    this._pauseReason = null;
    if (this._pauseTimer) {
      clearTimeout(this._pauseTimer);
      this._pauseTimer = null;
    }
    this._saveRuntimeState();
    writeOrchestratorPauseState(false, null, { pauseUntil: null });
    console.log(
      `${TAG} resumed after ${pauseDuration}s pause — will pick up tasks on next poll`,
    );
    return true;
  }

  /**
   * Abort a running task by task ID (manual takeover / emergency stop).
   * @param {string} taskId
   * @param {string} [reason]
   * @returns {{ ok: boolean, reason: string }}
   */
  abortTask(taskId, reason = "manual") {
    const normalized = String(taskId || "").trim();
    if (!normalized) {
      return { ok: false, reason: "task_id_required" };
    }
    const ac = this._slotAbortControllers.get(normalized);
    if (!ac || ac.signal.aborted) {
      return { ok: false, reason: "not_active" };
    }
    ac.abort(String(reason || "manual"));
    return { ok: true, reason: String(reason || "manual") };
  }

  /**
   * Pause task dispatch for a fixed duration.
   * @param {number} durationMs
   * @param {string|null} reason
   * @returns {boolean}
   */
  pauseFor(durationMs, reason = null) {
    const changed = this.pause(reason);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return changed;
    }
    this._pauseUntil = Date.now() + durationMs;
    this._pauseReason =
      reason ? String(reason) : this._pauseReason || DEFAULT_PAUSE_REASON;
    this._schedulePauseExpiry();
    this._saveRuntimeState();
    writeOrchestratorPauseState(true, this._pauseReason, {
      pausedAt: this._pausedAt,
      pauseUntil: this._pauseUntil,
    });
    console.log(
      `${TAG} pause expires in ${Math.round(durationMs / 1000)}s (${reason || "unspecified"})`,
    );
    return changed;
  }

  /**
   * Check if executor is paused.
   * @returns {boolean}
   */
  isPaused() {
    return this._paused;
  }

  /**
   * Get pause info for status display.
   * @returns {{ paused: boolean, pausedAt: number|null, pauseUntil: number|null, pauseReason: string|null, pauseDuration: number }}
   */
  getPauseInfo() {
    return {
      paused: this._paused,
      pausedAt: this._pausedAt,
      pauseUntil: this._pauseUntil,
      pauseReason: this._pauseReason,
      pauseDuration: this._pausedAt
        ? Math.round((Date.now() - this._pausedAt) / 1000)
        : 0,
    };
  }

  _schedulePauseExpiry() {
    if (!this._pauseUntil) return;
    const delay = Math.max(0, this._pauseUntil - Date.now());
    if (this._pauseTimer) {
      clearTimeout(this._pauseTimer);
    }
    this._pauseTimer = setTimeout(() => {
      if (this._paused && this._pauseUntil && Date.now() >= this._pauseUntil) {
        this.resume();
      }
    }, delay);
    if (this._pauseTimer?.unref) {
      this._pauseTimer.unref();
    }
  }

  // ── Slot Watchdog ──────────────────────────────────────────────────────

  /**
   * Start the watchdog timer that periodically checks for stalled agent slots.
   * @private
   */
  _startWatchdog() {
    this._watchdogTimer = setInterval(
      () => this._watchdog(),
      WATCHDOG_INTERVAL_MS,
    );
    console.log(
      `${TAG} stream-based watchdog started — analyzing agent health every ${WATCHDOG_INTERVAL_MS / 1000}s ` +
        `(idle threshold: ${STREAM_IDLE_THRESHOLD_MS / 60000}min, stalled kill: ${STREAM_STALLED_KILL_MS / 60000}min, ` +
        `max continues: ${MAX_IDLE_CONTINUES}, absolute limit: ${Math.round((this.taskTimeoutMs + WATCHDOG_GRACE_MS) / 60000)}min)`,
    );
  }

  /**
   * Stop the watchdog timer.
   * @private
   */
  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  /**
   * Stream-Based Watchdog: Monitors agent health by analyzing the REAL event
   * stream instead of relying on fixed timeouts. Only intervenes when actual
   * problems are detected in the agent's output stream.
   *
   * Intervention ladder:
   *  1. Agent idle for STREAM_IDLE_THRESHOLD_MS → send CONTINUE signal
   *  2. Agent silent for STREAM_SILENT_THRESHOLD_MS after continues → escalate
   *  3. Agent stalled for STREAM_STALLED_KILL_MS with no recovery → force-kill
   *  4. Hard deadline (taskTimeoutMs + WATCHDOG_GRACE_MS) as absolute safety net
   *
   * This replaces the old approach of killing agents based on arbitrary time limits.
   * Agents that are actively producing events (tool calls, messages, edits) are
   * NEVER interrupted regardless of how long they've been running.
   * @private
   */
  _watchdog() {
    const now = Date.now();
    const absoluteDeadline = this.taskTimeoutMs + WATCHDOG_GRACE_MS;
    const sessionTracker = getSessionTracker();

    for (const [taskId, slot] of this._activeSlots) {
      const elapsed = now - slot.startedAt;

      // ── 0. Warmup phase — never interfere with agent setup ──
      if (elapsed < WATCHDOG_WARMUP_MS) continue;

      const progress = sessionTracker.getProgressStatus(taskId);
      const continueCount = this._idleContinueCounts.get(taskId) || 0;
      const ac = this._slotAbortControllers.get(taskId);

      // ── 1. Stream health analysis — is the agent ACTUALLY working? ──
      const isActivelyWorking =
        progress.status === "active" &&
        progress.totalEvents > 0 &&
        progress.idleMs < STREAM_IDLE_THRESHOLD_MS;

      // If agent is actively producing events, skip ALL intervention
      if (isActivelyWorking) {
        // Reset continue count when agent shows life
        if (continueCount > 0) {
          this._idleContinueCounts.set(taskId, 0);
        }
        continue;
      }

      // ── 2. Agent has meaningful progress (edits/commits) — be very patient ──
      if (progress.hasEdits || progress.hasCommits) {
        // Agent has done real work. Only intervene if it's been truly silent
        // for a very long time (double the normal threshold)
        if (progress.idleMs < STREAM_SILENT_THRESHOLD_MS * 2) {
          continue; // Still within tolerance for an agent that has done work
        }
      }

      // ── 3. Idle detection — agent went silent, try CONTINUE ──
      if (
        (progress.status === "idle" || progress.status === "stalled") &&
        progress.idleMs >= STREAM_IDLE_THRESHOLD_MS
      ) {
        const idleSec = Math.round(progress.idleMs / 1000);

        if (continueCount < MAX_IDLE_CONTINUES) {
          if (ac && !ac.signal.aborted) {
            console.log(
              `${TAG} WATCHDOG: agent "${slot.taskTitle}" idle for ${idleSec}s ` +
                `(events: ${progress.totalEvents}, edits: ${progress.hasEdits}, ` +
                `commits: ${progress.hasCommits}) — sending CONTINUE signal ` +
                `(${continueCount + 1}/${MAX_IDLE_CONTINUES})`,
            );
            this._idleContinueCounts.set(taskId, continueCount + 1);
            ac.abort("idle_continue");
          }
          continue;
        }

        // ── 4. Exhausted continues — check if truly stalled ──
        if (progress.idleMs >= STREAM_STALLED_KILL_MS) {
          const elapsedMin = Math.round(elapsed / 60000);
          console.warn(
            `${TAG} :alert: WATCHDOG: agent "${slot.taskTitle}" stalled for ` +
              `${Math.round(progress.idleMs / 60000)}min after ${continueCount} continues ` +
              `(total runtime: ${elapsedMin}min, events: ${progress.totalEvents}) — force-aborting`,
          );
          if (ac && !ac.signal.aborted) {
            ac.abort("watchdog_stalled");
          }
          this._taskCooldowns.set(taskId, now);
          this.sendTelegram?.(
            `:alert: Watchdog killed stalled agent: "${slot.taskTitle}" ` +
              `(idle ${Math.round(progress.idleMs / 60000)}min after ${continueCount} continues, ` +
              `total ${elapsedMin}min, ${progress.totalEvents} events)`,
          );
          continue;
        }
      }

      // ── 5. Absolute safety net — only triggers if stream analysis somehow missed ──
      if (elapsed > absoluteDeadline) {
        const elapsedMin = Math.round(elapsed / 60000);
        const deadlineMin = Math.round(absoluteDeadline / 60000);
        console.warn(
          `${TAG} :alert: WATCHDOG: absolute deadline exceeded for "${slot.taskTitle}" ` +
            `(${elapsedMin}min > ${deadlineMin}min, events: ${progress.totalEvents}, ` +
            `edits: ${progress.hasEdits}, commits: ${progress.hasCommits}) — force-aborting`,
        );
        if (ac && !ac.signal.aborted) {
          ac.abort("watchdog_timeout");
        } else if (!ac) {
          console.warn(
            `${TAG} WATCHDOG: no AbortController for "${slot.taskTitle}" — slot may be stuck permanently`,
          );
        }
        this._taskCooldowns.set(taskId, now);
        this.sendTelegram?.(
          `:alert: Watchdog hard limit: "${slot.taskTitle}" (${elapsedMin}min > ${deadlineMin}min absolute limit)`,
        );
      }
    }
  }

  _requiresKanbanProjectId() {
    try {
      const backend = String(getKanbanBackendName() || "")
        .trim()
        .toLowerCase();
      return backend === "jira";
    } catch {
      return true;
    }
  }

  async _ensureResolvedProjectId() {
    if (this._resolvedProjectId) return this._resolvedProjectId;
    if (this.projectId) {
      this._resolvedProjectId = this.projectId;
      return this._resolvedProjectId;
    }
    if (!this._requiresKanbanProjectId()) {
      return null;
    }
    if (this._shouldBackoffProjectResolution()) {
      return null;
    }
    if (this._projectResolvePromise) {
      return this._projectResolvePromise;
    }

    this._projectResolvePromise = (async () => {
      try {
        const projects = await listProjects();
        if (projects && projects.length > 0) {
          const wantName = (
            process.env.PROJECT_NAME ||
            process.env.VK_PROJECT_NAME ||
            ""
          ).toLowerCase();
          let matched;
          if (wantName) {
            matched = projects.find(
              (p) => (p.name || p.title || "").toLowerCase() === wantName,
            );
          }
          if (matched) {
            this._resolvedProjectId = matched.id || matched.project_id;
            console.log(
              `${TAG} matched project by name "${wantName}": ${this._resolvedProjectId}`,
            );
          } else {
            this._resolvedProjectId = projects[0].id || projects[0].project_id;
            console.log(
              `${TAG} auto-detected project (first): ${this._resolvedProjectId}`,
            );
          }
          this._resetProjectResolutionBackoff();
        }
        return this._resolvedProjectId || null;
      } catch (err) {
        this._noteProjectResolutionFailure(err);
        return null;
      } finally {
        this._projectResolvePromise = null;
      }
    })();

    return this._projectResolvePromise;
  }

  _buildListTasksCacheKey(projectId, options = {}) {
    const normalizedProjectId = String(projectId || "").trim() || "*";
    const normalizedStatus = String(options?.status || "").trim().toLowerCase() || "*";
    return `${normalizedProjectId}|${normalizedStatus}`;
  }

  _storeListTasksCacheEntry(key, tasks) {
    this._listTasksCache.set(key, {
      ts: Date.now(),
      tasks: Array.isArray(tasks) ? tasks : [],
    });
    if (this._listTasksCache.size > LIST_TASKS_CACHE_MAX_ENTRIES) {
      const oldestKey = this._listTasksCache.keys().next().value;
      if (oldestKey) this._listTasksCache.delete(oldestKey);
    }
  }

  async _listTasksCached(projectId, options = {}, ttlMs = LIST_TASKS_CACHE_TTL_MS) {
    const key = this._buildListTasksCacheKey(projectId, options);
    const now = Date.now();
    const cached = this._listTasksCache.get(key);
    if (cached && now - Number(cached.ts || 0) <= ttlMs) {
      return cached.tasks;
    }

    const inflight = this._listTasksInflight.get(key);
    if (inflight) return inflight;

    const pending = Promise.resolve()
      .then(() => listTasks(projectId || undefined, options))
      .then((tasks) => {
        const normalized = Array.isArray(tasks) ? tasks : [];
        this._storeListTasksCacheEntry(key, normalized);
        return normalized;
      })
      .finally(() => {
        this._listTasksInflight.delete(key);
      });

    this._listTasksInflight.set(key, pending);
    return pending;
  }

  async _recoverInterruptedInProgressTasks(trigger = "interval") {
    const startedAtMs = Date.now();
    const summary = {
      trigger,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: null,
      durationMs: 0,
      scannedCount: 0,
      availableSlots: 0,
      resumedCount: 0,
      resetToTodoCount: 0,
      reconciledDriftCount: 0,
      skippedForActiveClaimCount: 0,
      skippedForNoCommitBlockCount: 0,
      resetUnstartedCount: 0,
      staleSharedClaimCount: 0,
      workflowOwnerlessResetCount: 0,
      workflowEvidenceKept: [],
      prunedRuntimeCount: 0,
      failed: false,
      error: null,
    };
    if (!this._running) return;
    if (this._paused) return;
    if (this._activeSlots.size >= this.maxParallel) return summary;
    if (this._shouldBackoffListTasks()) return;
    await ensureThreadRegistryLoaded().catch(() => {
      /* best effort */
    });

    const projectId = await this._ensureResolvedProjectId();
    const requiresProjectId = this._requiresKanbanProjectId();
    if (requiresProjectId && !projectId) return summary;

    let inProgressTasks = [];
    try {
      const fetched = await this._listTasksCached(projectId || undefined, {
        status: "inprogress",
      });
      if (Array.isArray(fetched)) {
        inProgressTasks = fetched.filter(
          (task) => task?.status === "inprogress",
        );
      }
      this._resetListTasksBackoff();
    } catch (err) {
      this._noteListTasksFailure(err);
      return summary;
    }

    summary.scannedCount = inProgressTasks.length;
    if (!inProgressTasks.length) {
      summary.finishedAt = new Date().toISOString();
      summary.durationMs = Date.now() - startedAtMs;
      return summary;
    }

    // Runtime metadata can outlive crashes. Drop stale records that are no
    // longer in-progress so new runs get fresh instance IDs and start times.
    const inProgressIds = new Set(
      inProgressTasks
        .map((task) => task?.id || task?.task_id)
        .filter((id) => !!id),
    );
    let prunedRuntime = 0;
    for (const taskId of Array.from(this._slotRuntimeState.keys())) {
      if (!inProgressIds.has(taskId) && !this._activeSlots.has(taskId)) {
        this._slotRuntimeState.delete(taskId);
        prunedRuntime++;
      }
    }
    if (prunedRuntime > 0) {
      this._saveRuntimeState();
    }
    summary.prunedRuntimeCount = prunedRuntime;

    const activeThreads = new Set(
      getActiveThreads()
        .map((entry) => String(entry?.taskKey || "").trim())
        .filter(Boolean),
    );
    const activeWorkflowEvidenceByTaskId = this.workflowOwnsTaskLifecycle
      ? this._readActiveWorkflowEvidenceByTaskId()
      : new Map();

    const available = Math.max(0, this.maxParallel - this._activeSlots.size);
    summary.availableSlots = available;
    if (available === 0) {
      summary.finishedAt = new Date().toISOString();
      summary.durationMs = Date.now() - startedAtMs;
      return summary;
    }

    /** @type {Array<Object>} */
    const resumable = [];
    let resetToTodo = 0;
    let reconciledDrift = 0;
    let skippedForActiveClaim = 0;
    let skippedForNoCommitBlock = 0;
    let resetUnstarted = 0;
    let staleSharedClaimCount = 0;
    let workflowOwnerlessResetCount = 0;
    const recoveryTransitionOptions = (source) => ({
      source,
      ...(this.workflowOwnsTaskLifecycle
        ? { bypassWorkflowOwnership: true }
        : {}),
    });

    for (const task of inProgressTasks) {
      const id = normalizeTaskIdKey(task?.id || task?.task_id);
      if (!id || this._activeSlots.has(id)) continue;

      const internalTask = getInternalTask(id);
      const internalStatus = internalTask?.status || null;
      if (internalTask && internalStatus && internalStatus !== "inprogress") {
        try {
          await transitionTaskStatus(
            id,
            internalStatus,
            recoveryTransitionOptions("task-executor-recovery-drift"),
          );
        } catch {
          /* best effort */
        }
        this._removeRuntimeSlot(id);
        reconciledDrift++;
        continue;
      }

      let hasStaleSharedClaim = false;
      if (SHARED_STATE_ENABLED) {
        try {
          const sharedState = await getSharedState(id, this.repoRoot);
          const ownerId = sharedState?.ownerId || null;
          const heartbeat =
            sharedState?.ownerHeartbeat || sharedState?.heartbeat || null;
          // Any non-stale owner (workflow run or executor instance) should
          // block recovery re-dispatch. Removing the ownerId !== instanceId
          // guard ensures workflow-owned tasks (wf-<uuid> owners) are also
          // protected when action.claim_task IS used.
          if (ownerId) {
            const heartbeatIsFresh = !isSharedHeartbeatStale(
              heartbeat,
              SHARED_STATE_STALE_THRESHOLD_MS,
            );
            if (heartbeatIsFresh) {
              const claim = await getClaim(id).catch(() => null);
              const localClaimAlive = isMatchingLocalClaimProcessAlive(
                ownerId,
                claim,
              );
              if (localClaimAlive !== false) {
                skippedForActiveClaim++;
                continue;
              }
            }
            hasStaleSharedClaim = true;
            staleSharedClaimCount++;
          }
        } catch {
          /* best effort */
        }
      }

      const noCommitCount = this._noCommitCounts.get(id) || 0;
      if (noCommitCount >= MAX_NO_COMMIT_ATTEMPTS) {
        try {
          await transitionTaskStatus(
            id,
            "todo",
            recoveryTransitionOptions("task-executor-recovery-no-commit-block"),
          );
        } catch {
          /* best effort */
        }
        try {
          transitionInternalTaskStatus(
            id,
            "todo",
            "task-executor-recovery-no-commit-block",
          );
        } catch {
          /* best effort */
        }
        this._removeRuntimeSlot(id);
        skippedForNoCommitBlock++;
        continue;
      }

      let ageMs = getTaskAgeMs(task);
      if (internalTask) {
        const internalAge = getTaskAgeMs(internalTask);
        if (internalAge > 0) {
          ageMs = ageMs > 0 ? Math.min(ageMs, internalAge) : internalAge;
        }
      }
      const hasThread = activeThreads.has(String(id));
      const rawAttempts =
        task?.agentAttempts ?? task?.agent_attempts ?? task?.meta?.agentAttempts;
      const attempts = Number.isFinite(Number(rawAttempts))
        ? Number(rawAttempts)
        : 0;
      const isUnstartedStale =
        !hasThread &&
        attempts <= 0 &&
        ageMs > INPROGRESS_RECOVERY_UNSTARTED_RESET_MS;
      if (isUnstartedStale && !hasStaleSharedClaim) {
        try {
          await transitionTaskStatus(
            id,
            "todo",
            recoveryTransitionOptions("task-executor-recovery-unstarted"),
          );
        } catch {
          /* best effort */
        }
        try {
          transitionInternalTaskStatus(
            id,
            "todo",
            "task-executor-recovery-unstarted",
          );
        } catch {
          /* best effort */
        }
        this._clearRecoveredWorkflowState(id, task, internalTask);
        this._removeRuntimeSlot(id);
        resetToTodo++;
        resetUnstarted++;
        continue;
      }
      const isFreshEnough =
        ageMs === 0 || ageMs <= INPROGRESS_RECOVERY_MAX_AGE_MS;
      // In workflow-owned mode, the authoritative liveness signals are the
      // persisted workflow active-runs index, then any live executor thread,
      // then the shared-state owner. If none of those exist, the task is
      // ownerless and must be reset even when still "fresh".
      if (this.workflowOwnsTaskLifecycle) {
        let recentWorkflowEvidence = this._resolveRecentWorkflowEvidence(
          task,
          internalTask,
          activeWorkflowEvidenceByTaskId,
        );
        if (!recentWorkflowEvidence) {
          // Recovery snapshots can race a just-started workflow run. Re-read the
          // active-runs/index evidence before treating the task as ownerless.
          recentWorkflowEvidence = this._resolveRecentWorkflowEvidence(
            task,
            internalTask,
          );
        }
        const hasWorkflowEvidence = Boolean(recentWorkflowEvidence);
        const hasWorkflowLiveness = hasWorkflowEvidence || hasThread;
        if (hasStaleSharedClaim) {
          if (hasWorkflowEvidence) {
            if (recentWorkflowEvidence?.runId) {
              summary.workflowEvidenceKept.push({
                taskId: id,
                runId: recentWorkflowEvidence.runId,
                source: recentWorkflowEvidence.source,
                reason: "stale_shared_claim",
                status: recentWorkflowEvidence.status,
                lastActivityAt: recentWorkflowEvidence.lastActivityAt,
              });
            }
            skippedForActiveClaim++;
            continue;
          }
          try {
            await transitionTaskStatus(
              id,
              "todo",
              recoveryTransitionOptions(
                "task-executor-recovery-stale-workflow-claim",
              ),
            );
          } catch {
            /* best effort */
          }
          try {
            transitionInternalTaskStatus(
              id,
              "todo",
              "task-executor-recovery-stale-workflow-claim",
            );
          } catch {
            /* best effort */
          }
          await this._releaseRecoveredWorkflowClaim(id);
          this._clearRecoveredWorkflowState(id, task, internalTask);
          invalidateThread(id);
          this._removeRuntimeSlot(id);
          resetToTodo++;
          workflowOwnerlessResetCount++;
          continue;
        }
        if (hasWorkflowLiveness) {
          if (recentWorkflowEvidence?.runId) {
            summary.workflowEvidenceKept.push({
              taskId: id,
              runId: recentWorkflowEvidence.runId,
              source: recentWorkflowEvidence.source,
              reason: "workflow_liveness",
              status: recentWorkflowEvidence.status,
              lastActivityAt: recentWorkflowEvidence.lastActivityAt,
            });
          }
          skippedForActiveClaim++;
          continue;
        }
        try {
          await transitionTaskStatus(
            id,
            "todo",
            recoveryTransitionOptions(
              "task-executor-recovery-missing-workflow-run",
            ),
          );
        } catch {
          /* best effort */
        }
        try {
          transitionInternalTaskStatus(
            id,
            "todo",
            "task-executor-recovery-missing-workflow-run",
          );
        } catch {
          /* best effort */
        }
        await this._releaseRecoveredWorkflowClaim(id);
        this._clearRecoveredWorkflowState(id, task, internalTask);
        invalidateThread(id);
        this._removeRuntimeSlot(id);
        resetToTodo++;
        workflowOwnerlessResetCount++;
        continue;
      }

      if (hasThread || isFreshEnough) {
        if (!internalTask) {
          try {
            addInternalTask({
              id,
              title: task?.title || "",
              description: task?.description || "",
              status: "inprogress",
              externalStatus: "inprogress",
              externalId: task?.externalId || null,
              externalBackend: task?.backend || null,
              projectId: task?.projectId || null,
            });
          } catch {
            /* best effort */
          }
        }
        resumable.push({ ...task, id });
        continue;
      }

      try {
        await transitionTaskStatus(
          id,
          "todo",
          recoveryTransitionOptions("task-executor-recovery"),
        );
      } catch {
        /* best effort */
      }
      try {
        transitionInternalTaskStatus(id, "todo", "task-executor-recovery");
      } catch {
        /* best effort */
      }
      this._clearRecoveredWorkflowState(id, task, internalTask);
      this._removeRuntimeSlot(id);
      resetToTodo++;
    }

    const toDispatch = this._selectTasksForBaseBranchLimit(
      resumable,
      available,
    );
    for (const task of toDispatch) {
      void this.executeTask(task, { recoveredFromInProgress: true }).catch((err) => {
        console.error(
          `${TAG} in-progress recovery executeTask failed for "${task?.title || task?.id}": ${err.message || err}`,
        );
      });
    }

    if (toDispatch.length > 0 || resetToTodo > 0 || skippedForNoCommitBlock > 0) {
      console.log(
        `${TAG} in-progress recovery: resumed ${toDispatch.length}, reset ${resetToTodo} stale task(s) to todo` +
          (reconciledDrift > 0
            ? `, reconciled ${reconciledDrift} drifted task(s)`
            : "") +
          (resetUnstarted > 0
            ? `, reset ${resetUnstarted} unstarted task(s)`
            : "") +
          (skippedForActiveClaim > 0
            ? `, skipped ${skippedForActiveClaim} active claim(s)`
            : "") +
          (skippedForNoCommitBlock > 0
            ? `, skipped ${skippedForNoCommitBlock} no-commit blocked task(s)`
            : ""),
      );
    }
    summary.resumedCount = toDispatch.length;
    summary.resetToTodoCount = resetToTodo;
    summary.reconciledDriftCount = reconciledDrift;
    summary.skippedForActiveClaimCount = skippedForActiveClaim;
    summary.skippedForNoCommitBlockCount = skippedForNoCommitBlock;
    summary.resetUnstartedCount = resetUnstarted;
    summary.staleSharedClaimCount = staleSharedClaimCount;
    summary.workflowOwnerlessResetCount = workflowOwnerlessResetCount;
    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - startedAtMs;
    return summary;
  }

  _readActiveWorkflowEvidenceByTaskId() {
    const evidenceByTaskId = new Map();
    for (const workflowRunsDir of this._getWorkflowRunsDirs()) {
      const activeRunsPath = resolve(workflowRunsDir, WORKFLOW_ACTIVE_RUNS_INDEX);
      if (!existsSync(activeRunsPath)) continue;
      let activeRuns = [];
      try {
        const parsed = JSON.parse(readFileSync(activeRunsPath, "utf8"));
        activeRuns = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.runs)
            ? parsed.runs
            : [];
      } catch {
        continue;
      }

      for (const entry of activeRuns) {
        const runId = String(entry?.runId || entry?.id || "").trim();
        if (!runId) continue;
        const detail = this._readWorkflowRunDetail(runId, workflowRunsDir);
        const taskIds = new Set();
        collectWorkflowEvidenceScalarTaskIds(
          taskIds,
          entry?.taskId,
          entry?.activeTaskId,
          detail?.taskId,
          detail?.data?.taskId,
          detail?.data?.activeTaskId,
          detail?.inputData?.taskId,
          detail?.inputData?.activeTaskId,
        );
        if (taskIds.size === 0) {
          collectWorkflowEvidenceTaskIds(taskIds, entry?.taskIds);
          collectWorkflowEvidenceTaskIds(taskIds, detail?.taskIds);
          collectWorkflowEvidenceTaskIds(taskIds, detail?.data?.taskIds);
          collectWorkflowEvidenceTaskIds(taskIds, detail?.inputData?.taskIds);
        }
        if (taskIds.size === 0) continue;

        for (const taskId of taskIds) {
          const existing = evidenceByTaskId.get(taskId) || [];
          if (!existing.some((candidate) => String(candidate?.runId || "").trim() === runId)) {
            existing.push({
              runId,
              taskId,
              source: "active-runs",
              fallbackEntry: entry,
              detail,
              workflowRunsDir,
            });
          }
          evidenceByTaskId.set(taskId, existing);
        }
      }
    }
    return evidenceByTaskId;
  }

  _resolveRecentWorkflowEvidence(task, internalTask = null, activeWorkflowEvidenceByTaskId = null) {
    const candidates = this._collectRecentWorkflowEvidenceCandidates(
      task,
      internalTask,
      activeWorkflowEvidenceByTaskId,
    );
    return this._selectBestRecentWorkflowEvidenceCandidate(
      candidates,
      normalizeTaskIdKey(task?.id || internalTask?.id),
    );
  }

  _selectBestRecentWorkflowEvidenceCandidate(candidates, expectedTaskId = "") {
    for (const candidate of candidates) {
      const ranked = this._rankWorkflowEvidenceCandidate(candidate, expectedTaskId);
      if (ranked?.hasRecentEvidence) return ranked;
    }
    return null;
  }

  _resolveWorkflowEvidenceTurnSessionId(candidate, taskId = "") {
    const runId = String(candidate?.runId || "").trim();
    const checkpoint = candidate?.detail?.latestCheckpoint || null;
    const nodeId = String(checkpoint?.nodeId || "").trim();
    const normalizedTaskId = normalizeTaskIdKey(taskId || candidate?.taskId);
    if (!runId || !nodeId) return "";

    const expectedSessionId = normalizedTaskId
      ? `${normalizedTaskId}:agent:${runId}:${nodeId}:turn`
      : "";
    const sessionIds = new Set();
    const addSessionIds = (values) => {
      for (const value of Array.isArray(values) ? values : [values]) {
        const sessionId = String(value || "").trim();
        if (sessionId) sessionIds.add(sessionId);
      }
    };

    addSessionIds(candidate?.detail?.sessionIds);
    addSessionIds(candidate?.fallbackEntry?.sessionIds);

    if (expectedSessionId && sessionIds.has(expectedSessionId)) {
      return expectedSessionId;
    }

    const turnSuffix = `:${nodeId}:turn`;
    for (const sessionId of sessionIds) {
      if (!sessionId.endsWith(turnSuffix)) continue;
      if (!normalizedTaskId) return sessionId;
      if (sessionId.startsWith(`${normalizedTaskId}:agent:${runId}:`)) {
        return sessionId;
      }
    }

    return expectedSessionId;
  }

  _isStartupOnlyWorkflowEvidenceStalled(candidate) {
    const checkpoint = candidate?.detail?.latestCheckpoint || null;
    const eventType = String(checkpoint?.eventType || "").trim().toLowerCase();
    const nodeId = String(checkpoint?.nodeId || "").trim();
    if (eventType !== "agent.started" || !nodeId.startsWith("run-agent-")) {
      return false;
    }

    const counters = checkpoint?.counters && typeof checkpoint.counters === "object"
      ? checkpoint.counters
      : {};
    const toolCallCount = Number(counters.toolCallCount ?? checkpoint?.toolCallCount ?? 0) || 0;
    const toolResultCount = Number(counters.toolResultCount ?? checkpoint?.toolResultCount ?? 0) || 0;
    const spillCount = Number(counters.spillCount ?? checkpoint?.spillCount ?? 0) || 0;
    if (toolCallCount > 0 || toolResultCount > 0 || spillCount > 0) {
      return false;
    }

    const lastActivityMs = Number(candidate?.lastActivityMs || 0);
    if (!Number.isFinite(lastActivityMs) || lastActivityMs <= 0) {
      return false;
    }
    if (Date.now() - lastActivityMs < WORKFLOW_RUN_STARTUP_STALL_RECOVERY_MS) {
      return false;
    }

    const turnSessionId = this._resolveWorkflowEvidenceTurnSessionId(
      candidate,
      candidate?.taskId || "",
    );
    const progress = turnSessionId
      ? getSessionTracker().getProgressStatus(turnSessionId)
      : {
          status: "not_found",
          totalEvents: 0,
          hasEdits: false,
          hasCommits: false,
          elapsedMs: 0,
        };
    if (progress?.hasEdits || progress?.hasCommits) {
      return false;
    }

    const totalEvents = Number(progress?.totalEvents || 0);
    if (progress?.status === "not_found") {
      return true;
    }

    const elapsedMs = Number(progress?.elapsedMs || 0);
    return totalEvents <= 1 && elapsedMs >= WORKFLOW_RUN_STARTUP_STALL_RECOVERY_MS;
  }

  _rankWorkflowEvidenceCandidate(candidate, expectedTaskId = "") {
    const runId = String(candidate?.runId || "").trim();
    if (!runId) return null;

    const fallbackEntry =
      candidate?.fallbackEntry && typeof candidate.fallbackEntry === "object"
        ? candidate.fallbackEntry
        : null;
    const workflowRunsDir = String(
      candidate?.workflowRunsDir ||
        fallbackEntry?.workflowRunsDir ||
        "",
    ).trim();
    const detail =
      candidate?.detail && typeof candidate.detail === "object"
        ? candidate.detail
        : this._readWorkflowRunDetail(runId, workflowRunsDir);
    const dagState = detail?.data?._dagState || detail?._dagState || null;
    const taskIds = new Set();
    collectWorkflowEvidenceScalarTaskIds(
      taskIds,
      candidate?.taskId,
      fallbackEntry?.taskId,
      fallbackEntry?.activeTaskId,
      detail?.taskId,
      detail?.data?.taskId,
      detail?.data?.activeTaskId,
      detail?.inputData?.taskId,
      detail?.inputData?.activeTaskId,
    );
    if (taskIds.size === 0) {
      collectWorkflowEvidenceTaskIds(taskIds, fallbackEntry?.taskIds);
      collectWorkflowEvidenceTaskIds(taskIds, detail?.taskIds);
      collectWorkflowEvidenceTaskIds(taskIds, detail?.data?.taskIds);
      collectWorkflowEvidenceTaskIds(taskIds, detail?.inputData?.taskIds);
    }
    const authoritativeTaskId = expectedTaskId && taskIds.has(expectedTaskId)
      ? expectedTaskId
      : (taskIds.values().next().value || "");
    if (expectedTaskId && authoritativeTaskId && authoritativeTaskId !== expectedTaskId) {
      return null;
    }

    const status = String(
      dagState?.status || detail?.status || fallbackEntry?.status || fallbackEntry?.outcome || "",
    )
      .trim()
      .toLowerCase();
    const endedAtMs = Math.max(
      parseTimestampMs(detail?.endedAt),
      parseTimestampMs(dagState?.endedAt),
      parseTimestampMs(fallbackEntry?.endedAt),
    );
    const lastActivityMs = Math.max(
      parseTimestampMs(dagState?.updatedAt),
      parseTimestampMs(dagState?.lastStatusAt),
      parseTimestampMs(dagState?.createdAt),
      parseTimestampMs(detail?.lastProgressAt),
      parseTimestampMs(detail?.updatedAt),
      parseTimestampMs(detail?.startedAt),
      parseTimestampMs(fallbackEntry?.updatedAt),
      parseTimestampMs(fallbackEntry?.lastStatusAt),
      parseTimestampMs(fallbackEntry?.createdAt),
      parseTimestampMs(fallbackEntry?.startedAt),
    );
    const hasRecentEvidence =
      endedAtMs <= 0 &&
      !TERMINAL_WORKFLOW_RUN_STATUSES.has(status) &&
      lastActivityMs > 0 &&
      Date.now() - lastActivityMs <= WORKFLOW_RUN_RECOVERY_GRACE_MS;
    const source = String(candidate?.source || fallbackEntry?.source || "history")
      .trim()
      .toLowerCase();
    const sourcePriority = ({
      "active-runs": 4,
      history: 3,
      timeline: 2,
      "workflow-runs": 2,
      topology: 1,
      direct: 1,
    })[source] || 0;
    const ranked = {
      ...candidate,
      runId,
      detail,
      fallbackEntry,
      workflowRunsDir: workflowRunsDir || null,
      taskId: authoritativeTaskId || expectedTaskId || "",
      source,
      status,
      endedAtMs,
      lastActivityMs,
      lastActivityAt: toIsoTimestamp(lastActivityMs),
      hasRecentEvidence,
      sourcePriority,
      hasDagState: Boolean(dagState),
      hasDetail: Boolean(detail),
    };

    if (ranked.hasRecentEvidence && this._isStartupOnlyWorkflowEvidenceStalled(ranked)) {
      ranked.hasRecentEvidence = false;
      ranked.startupStalled = true;
    }

    return ranked;
  }

  _compareWorkflowEvidenceCandidates(a, b) {
    return (
      Number(b?.hasRecentEvidence === true) - Number(a?.hasRecentEvidence === true) ||
      (Number(b?.lastActivityMs || 0) - Number(a?.lastActivityMs || 0)) ||
      (Number(b?.sourcePriority || 0) - Number(a?.sourcePriority || 0)) ||
      Number(b?.hasDagState === true) - Number(a?.hasDagState === true) ||
      Number(b?.hasDetail === true) - Number(a?.hasDetail === true) ||
      String(b?.runId || "").localeCompare(String(a?.runId || ""))
    );
  }

  _readActiveWorkflowTaskIds() {
    const taskIds = new Set();
    for (const [taskId, candidates] of this._readActiveWorkflowEvidenceByTaskId()) {
      if (this._selectBestRecentWorkflowEvidenceCandidate(candidates, taskId)) {
        taskIds.add(taskId);
      }
    }
    return taskIds;
  }

  _hasRecentWorkflowRunEvidence(task, internalTask = null) {
    return Boolean(this._resolveRecentWorkflowEvidence(task, internalTask));
  }

  _resolveRecentWorkflowEvidenceRunId(task, internalTask = null) {
    return String(this._resolveRecentWorkflowEvidence(task, internalTask)?.runId || "").trim();
  }

  _findRecentWorkflowEvidenceRunIdByTaskId(taskId) {
    const [firstRunId] = this._findRecentWorkflowEvidenceRunIdsByTaskId(taskId);
    return firstRunId || "";
  }

  _collectRecentWorkflowEvidenceCandidates(task, internalTask = null, activeWorkflowEvidenceByTaskId = null) {
    const candidates = [];
    const seenRunIds = new Set();
    const addCandidate = (runId, fallbackEntry = null, source = "", taskId = "", detail = null) => {
      const normalizedRunId = String(runId || "").trim();
      if (!normalizedRunId || seenRunIds.has(normalizedRunId)) return;
      seenRunIds.add(normalizedRunId);
      candidates.push({
        runId: normalizedRunId,
        fallbackEntry,
        source,
        taskId,
        detail,
      });
    };

    const taskId = normalizeTaskIdKey(task?.id || internalTask?.id);
    const directRunId = String(
      task?.topology?.latestRunId ||
        internalTask?.topology?.latestRunId ||
        task?.workflowRunId ||
        task?.meta?.workflowRunId ||
        task?.meta?.workflow?.runId ||
        "",
    ).trim();
    if (directRunId) {
      addCandidate(directRunId, null, "topology", taskId);
    }

    const workflowRuns = [
      ...(Array.isArray(task?.workflowRuns) ? task.workflowRuns : []),
      ...(Array.isArray(internalTask?.workflowRuns) ? internalTask.workflowRuns : []),
    ];
    for (let index = workflowRuns.length - 1; index >= 0; index -= 1) {
      const entry = workflowRuns[index];
      if (!entry || typeof entry !== "object") continue;
      addCandidate(entry?.runId || entry?.id, entry, "workflow-runs", taskId);
    }

    const timelineEntries = Array.isArray(task?.timeline) ? task.timeline : [];
    for (let index = timelineEntries.length - 1; index >= 0; index -= 1) {
      const entry = timelineEntries[index];
      if (!entry || typeof entry !== "object") continue;
      addCandidate(
        entry?.payload?.runId || entry?.payload?.workflowRunId,
        entry?.payload || entry,
        "timeline",
        taskId,
      );
    }

    if (taskId) {
      const activeEvidence =
        activeWorkflowEvidenceByTaskId instanceof Map
          ? activeWorkflowEvidenceByTaskId.get(taskId) || []
          : this._readActiveWorkflowEvidenceByTaskId().get(taskId) || [];
      for (const entry of activeEvidence) {
        addCandidate(
          entry?.runId || entry?.id,
          entry?.fallbackEntry || entry,
          entry?.source || "active-runs",
          taskId,
          entry?.detail || null,
        );
      }
      for (const historyEntry of this._findRecentWorkflowEvidenceEntriesByTaskId(taskId)) {
        addCandidate(historyEntry?.runId || historyEntry?.id, historyEntry, "history", taskId);
      }
    }

    return candidates
      .map((candidate) => this._rankWorkflowEvidenceCandidate(candidate, taskId))
      .filter(Boolean)
      .sort((left, right) => this._compareWorkflowEvidenceCandidates(left, right));
  }

  _findRecentWorkflowEvidenceEntriesByTaskId(taskId) {
    const normalizedTaskId = normalizeTaskIdKey(taskId);
    if (!normalizedTaskId) return [];

    const matches = [];
    const seenRunIds = new Set();
    for (const workflowRunsDir of this._getWorkflowRunsDirs()) {
      const indexPath = resolve(workflowRunsDir, WORKFLOW_RUNS_HISTORY_INDEX);
      if (!existsSync(indexPath)) continue;

      try {
        const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
        const runs = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.runs)
            ? parsed.runs
            : [];
        for (const entry of runs) {
          const entryTaskId = normalizeAuthoritativeWorkflowTaskId(
            entry?.taskId ||
              entry?.activeTaskId,
          );
          if (entryTaskId !== normalizedTaskId) continue;

          const endedAtMs = parseTimestampMs(entry?.endedAt);
          const status = String(entry?.status || entry?.outcome || "")
            .trim()
            .toLowerCase();
          if (
            endedAtMs > 0 ||
            TERMINAL_WORKFLOW_RUN_STATUSES.has(status)
          ) {
            continue;
          }

          const runId = String(entry?.runId || entry?.id || "").trim();
          if (!runId || seenRunIds.has(runId)) continue;
          seenRunIds.add(runId);
          matches.push({
            ...entry,
            workflowRunsDir,
          });
        }
      } catch {
        continue;
      }
    }
    return matches;
  }

  _findRecentWorkflowEvidenceRunIdsByTaskId(taskId) {
    const evidenceByTaskId = this._readActiveWorkflowEvidenceByTaskId();
    return this._collectRecentWorkflowEvidenceCandidates(
      { id: taskId },
      null,
      evidenceByTaskId,
    )
      .filter((candidate) => candidate?.hasRecentEvidence)
      .map((candidate) => String(candidate?.runId || "").trim())
      .filter(Boolean);
  }

  _workflowRunCandidateHasRecentEvidence(candidate) {
    return this._rankWorkflowEvidenceCandidate(candidate)?.hasRecentEvidence === true;
  }

  _readWorkflowRunDetail(runId, preferredWorkflowRunsDir = null) {
    const normalizedRunId = String(runId || "").trim();
    if (!normalizedRunId) return null;

    const workflowRunsDirs = [];
    const preferredDir = String(preferredWorkflowRunsDir || "").trim();
    if (preferredDir) workflowRunsDirs.push(resolve(preferredDir));
    workflowRunsDirs.push(...this._getWorkflowRunsDirs());

    const seen = new Set();
    for (const workflowRunsDir of workflowRunsDirs) {
      const normalizedDir = String(workflowRunsDir || "").trim();
      if (!normalizedDir || seen.has(normalizedDir)) continue;
      seen.add(normalizedDir);
      const detailPath = resolve(normalizedDir, `${normalizedRunId}.json`);
      if (!existsSync(detailPath)) continue;

      try {
        return JSON.parse(readFileSync(detailPath, "utf8"));
      } catch {
        continue;
      }
    }
    return null;
  }

  _getWorkflowRunsDirs() {
    const dirs = [];
    if (this.workflowRunsDir) dirs.push(resolve(this.workflowRunsDir));
    if (this.repoRoot) {
      dirs.push(resolve(this.repoRoot, ".bosun", "workflow-runs"));
    }
    return [...new Set(dirs.filter(Boolean))];
  }

  _normalizeRecoveredWorkflowRunLink(entry) {
    if (!entry || typeof entry !== "object") return null;

    const status = String(entry?.status || "").trim().toLowerCase();
    const outcome = String(entry?.outcome || "").trim().toLowerCase();
    const endedAtMs = parseTimestampMs(entry?.endedAt);
    const looksActive =
      endedAtMs <= 0 &&
      (ACTIVE_WORKFLOW_RUN_STATUSES.has(status) ||
        ACTIVE_WORKFLOW_RUN_STATUSES.has(outcome));
    if (!looksActive) return entry;

    const detail = this._readWorkflowRunDetail(entry?.runId);
    const dagState = detail?.data?._dagState || detail?._dagState || null;
    const detailStatusRaw = String(dagState?.status || detail?.status || "")
      .trim();
    const detailStatus = detailStatusRaw.toLowerCase();
    const detailEndedAt =
      toIsoTimestamp(detail?.endedAt) ||
      toIsoTimestamp(dagState?.endedAt) ||
      toIsoTimestamp(entry?.endedAt);

    if (detailEndedAt || TERMINAL_WORKFLOW_RUN_STATUSES.has(detailStatus)) {
      return {
        ...entry,
        status: detailStatusRaw || entry.status || "completed",
        outcome: detailStatusRaw || entry.outcome || "completed",
        endedAt: detailEndedAt || entry.endedAt || null,
      };
    }

    return {
      ...entry,
      status: "stale",
      outcome: "stale",
      endedAt: entry.endedAt || null,
      summary: entry.summary || "Recovered stale workflow run link",
    };
  }

  _buildRecoveredWorkflowStatePatch(task, internalTask = null) {
    const taskLike =
      internalTask && typeof internalTask === "object"
        ? internalTask
        : (task && typeof task === "object" ? task : null);
    if (!taskLike) return null;

    const patch = {
      topology: {
        workflowId: null,
        workflowName: null,
        latestNodeId: null,
        latestRunId: null,
        rootRunId: null,
        parentRunId: null,
        latestSessionId: null,
        sessionId: null,
        rootSessionId: null,
        parentSessionId: null,
        delegationDepth: 0,
      },
    };

    if (Array.isArray(taskLike.workflowRuns) && taskLike.workflowRuns.length > 0) {
      patch.workflowRuns = taskLike.workflowRuns
        .map((entry) => this._normalizeRecoveredWorkflowRunLink(entry))
        .filter(Boolean);
    }

    return patch;
  }

  _clearRecoveredWorkflowState(taskId, task = null, internalTask = null) {
    const patch = this._buildRecoveredWorkflowStatePatch(task, internalTask);
    if (!patch) return;
    try {
      updateInternalTask(taskId, patch);
    } catch {
      /* best effort */
    }
  }

  async _releaseRecoveredWorkflowClaim(taskId) {
    const normalizedTaskId = normalizeTaskIdKey(taskId);
    if (!normalizedTaskId) return;
    try {
      await releaseTaskClaim({
        taskId: normalizedTaskId,
        force: true,
      });
    } catch {
      /* best effort */
    }
  }

  _recordInProgressRecoveryRun(run) {
    const normalized = normalizeInProgressRecoveryRun(run);
    const hasActivity =
      normalized.failed ||
      normalized.scannedCount > 0 ||
      normalized.resumedCount > 0 ||
      normalized.resetToTodoCount > 0 ||
      normalized.reconciledDriftCount > 0 ||
      normalized.skippedForActiveClaimCount > 0 ||
      normalized.skippedForNoCommitBlockCount > 0 ||
      normalized.staleSharedClaimCount > 0 ||
      normalized.workflowOwnerlessResetCount > 0;
    if (!hasActivity && normalized.trigger !== "startup") {
      return;
    }

    const current = normalizeInProgressRecoverySnapshot(this._inProgressRecovery);
    current.totals.runs += 1;
    if (normalized.failed) current.totals.failures += 1;
    current.totals.resumed += normalized.resumedCount;
    current.totals.resetToTodo += normalized.resetToTodoCount;
    current.totals.reconciledDrift += normalized.reconciledDriftCount;
    current.totals.skippedForActiveClaim += normalized.skippedForActiveClaimCount;
    current.totals.skippedForNoCommitBlock += normalized.skippedForNoCommitBlockCount;
    current.totals.resetUnstarted += normalized.resetUnstartedCount;
    current.totals.staleSharedClaim += normalized.staleSharedClaimCount;
    current.totals.workflowOwnerlessReset += normalized.workflowOwnerlessResetCount;
    current.lastRun = normalized;
    current.recentRuns = [...current.recentRuns, normalized].slice(
      -INPROGRESS_RECOVERY_HISTORY_LIMIT,
    );
    this._inProgressRecovery = current;
    this._saveRuntimeState();
  }

  /**
   * Returns the current executor status for monitoring / Telegram.
   * @returns {Object}
   */
  getStatus() {
    return {
      running: this._running,
      paused: this._paused,
      pausedAt: this._pausedAt,
      pauseUntil: this._pauseUntil,
      pauseReason: this._pauseReason,
      pauseDuration: this._pausedAt
        ? Math.round((Date.now() - this._pausedAt) / 1000)
        : 0,
      mode: this.mode,
      maxParallel: this.maxParallel,
      baseBranchParallelLimit: this.baseBranchParallelLimit,
      repoAreaParallelLimit: this.repoAreaParallelLimit,
      sdk: this.sdk === "auto" ? getPoolSdkName() : this.sdk,
      activeSlots: this._activeSlots.size,
      slots: Array.from(this._activeSlots.values()).map((s) => ({
        taskId: s.taskId,
        taskTitle: s.taskTitle,
        branch: s.branch,
        baseBranch: s.baseBranch || null,
        sdk: s.sdk,
        model: s.model || "",
        attempt: s.attempt,
        agentInstanceId: s.agentInstanceId ?? null,
        startedAt: s.startedAt,
        runningFor: Math.round((Date.now() - s.startedAt) / 1000),
        status: s.status,
      })),
      cooldowns: this._taskCooldowns.size,
      blockedTasks: this._getBlockedTaskIds(),
      noCommitCounts: Object.fromEntries(this._noCommitCounts),
      pollIntervalMs: this.pollIntervalMs,
      taskTimeoutMs: this.taskTimeoutMs,
      maxRetries: this.maxRetries,
      projectId: this._resolvedProjectId || this.projectId || null,
      inProgressRecovery: normalizeInProgressRecoverySnapshot(this._inProgressRecovery),
      backlogReplenishment: { ...this._backlogReplenishment },
      repoAreaLocks: this._buildRepoAreaLockStatus(),
      projectRequirements: { ...this._projectRequirements },
    };
  }

  getTuiStats() {
    const tokenTotals = Array.from(attemptTelemetry.values()).reduce((acc, telemetry) => {
      acc.tokensIn += Math.max(0, Number(telemetry?.prompt_tokens || 0) || 0);
      acc.tokensOut += Math.max(0, Number(telemetry?.completion_tokens || 0) || 0);
      acc.tokensTotal += Math.max(0, Number(telemetry?.total_tokens || 0) || 0);
      return acc;
    }, { tokensIn: 0, tokensOut: 0, tokensTotal: 0 });

    return {
      activeAgents: this._activeSlots.size,
      maxAgents: this.maxParallel,
      tokensIn: tokenTotals.tokensIn,
      tokensOut: tokenTotals.tokensOut,
      tokensTotal: tokenTotals.tokensTotal || (tokenTotals.tokensIn + tokenTotals.tokensOut),
      rateLimits: {},
      recovery: normalizeInProgressRecoverySnapshot(this._inProgressRecovery),
      executor: {
        mode: this.mode,
        paused: this._paused,
        activeSlots: this._activeSlots.size,
        maxParallel: this.maxParallel,
        slots: Array.from(this._activeSlots.values()).map((slot) => ({
          taskId: slot.taskId,
          taskTitle: slot.taskTitle,
          sdk: slot.sdk,
          model: slot.model || "",
          status: slot.status,
          runningFor: Math.round((Date.now() - slot.startedAt) / 1000),
        })),
      },
    };
  }

  getBacklogReplenishmentConfig() {
    return {
      ...this._backlogReplenishment,
      projectRequirements: { ...this._projectRequirements },
    };
  }

  resetTaskThrottleState(taskId, options = {}) {
    const key = normalizeTaskIdKey(taskId);
    if (!key) return false;

    let changed = false;
    if (options.clearNoCommit !== false && this._noCommitCounts.delete(key)) {
      changed = true;
    }
    if (options.clearSkipUntil !== false && this._skipUntil.delete(key)) {
      changed = true;
    }
    if (options.clearCooldowns !== false && this._taskCooldowns.delete(key)) {
      changed = true;
    }
    if (this._idleContinueCounts.delete(key)) {
      changed = true;
    }
    if (this._repoAreaBlockedTasks.has(key)) {
      this._repoAreaBlockedTasks.delete(key);
      changed = true;
    }

    if (changed) {
      this._saveNoCommitState();
    }
    return changed;
  }

  setBacklogReplenishmentConfig(patch = {}) {
    if (!patch || typeof patch !== "object") {
      return this.getBacklogReplenishmentConfig();
    }
    if (patch.enabled !== undefined) {
      this._backlogReplenishment.enabled = Boolean(patch.enabled);
    }
    if (patch.minNewTasks !== undefined) {
      this._backlogReplenishment.minNewTasks = clampInt(
        patch.minNewTasks,
        1,
        2,
        this._backlogReplenishment.minNewTasks,
      );
    }
    if (patch.maxNewTasks !== undefined) {
      this._backlogReplenishment.maxNewTasks = clampInt(
        patch.maxNewTasks,
        1,
        3,
        this._backlogReplenishment.maxNewTasks,
      );
    }
    if (
      this._backlogReplenishment.maxNewTasks <
      this._backlogReplenishment.minNewTasks
    ) {
      this._backlogReplenishment.maxNewTasks =
        this._backlogReplenishment.minNewTasks;
    }
    if (patch.requirePriority !== undefined) {
      this._backlogReplenishment.requirePriority = Boolean(
        patch.requirePriority,
      );
    }
    if (patch.projectRequirements && typeof patch.projectRequirements === "object") {
      this.setProjectRequirements(patch.projectRequirements);
    }
    return this.getBacklogReplenishmentConfig();
  }

  getProjectRequirements() {
    return { ...this._projectRequirements };
  }

  setProjectRequirements(patch = {}) {
    if (!patch || typeof patch !== "object") {
      return this.getProjectRequirements();
    }
    if (patch.profile !== undefined) {
      this._projectRequirements.profile = normalizeRequirementsProfile(
        patch.profile,
      );
    }
    if (patch.notes !== undefined) {
      this._projectRequirements.notes = String(patch.notes || "").trim();
    }
    return this.getProjectRequirements();
  }

  /**
   * Check if a task is currently managed by the internal executor
   * (active, in cooldown, or blocked). Used by monitor to avoid
   * double-recovering tasks.
   * @param {string} taskId
   * @returns {boolean}
   */
  isTaskManaged(taskId) {
    const key = normalizeTaskIdKey(taskId);
    if (!key) return false;
    // Currently executing
    if (this._activeSlots.has(key)) return true;
    // In anti-thrash cooldown
    const skipUntil = this._skipUntil.get(key);
    if (skipUntil && Date.now() < skipUntil) return true;
    // In failure cooldown
    const cooldownAt = this._taskCooldowns.get(key);
    if (cooldownAt && Date.now() - cooldownAt < COOLDOWN_MS) return true;
    // Permanently blocked for this session
    const noCommitCount = this._noCommitCounts.get(key) || 0;
    if (noCommitCount >= MAX_NO_COMMIT_ATTEMPTS) return true;
    return false;
  }

  /**
   * Get list of task IDs that are permanently blocked (exceeded no-commit limit).
   * @returns {string[]}
   * @private
   */
  _getBlockedTaskIds() {
    const blocked = [];
    for (const [id, count] of this._noCommitCounts) {
      if (count >= MAX_NO_COMMIT_ATTEMPTS) blocked.push(id);
    }
    return blocked;
  }

  /**
   * Initialize distributed task claims backing store.
   * Best-effort: execution continues even if claims are unavailable.
   *
   * @returns {Promise<boolean>}
   * @private
   */
  async _ensureTaskClaimsInitialized() {
    // [LEGACY REMOVED] Replaced by workflow node: action.claim_task
    // See workflow-templates/task-lifecycle.mjs
    return false;
  }

  /**
   * Claim TTL should outlive long-running agents by a safe margin.
   *
   * @returns {number}
   * @private
   */
  _getTaskClaimTtlMinutes() {
    // [LEGACY REMOVED] Replaced by workflow node: action.claim_task
    // See workflow-templates/task-lifecycle.mjs
    return 90;
  }

  async _renewTaskClaim(taskId, claimToken, taskTitle = "") {
    // [LEGACY REMOVED] Replaced by workflow node: action.claim_task (renewal)
    // See workflow-templates/task-lifecycle.mjs
    return null;
  }

  _handleTaskClaimRenewalFailure(
    taskId,
    taskTitle,
    reason,
    { fatal = false } = {},
    // [LEGACY REMOVED] Replaced by workflow node: action.claim_task (failure handling)
    // See workflow-templates/task-lifecycle.mjs
  ) {
    if (!taskId) return;
    this._stopTaskClaimRenewal(taskId);
    const slot = this._activeSlots.get(taskId);
    const taskLabel = taskTitle || slot?.taskTitle || taskId;
    const normalizedReason = String(reason || "unknown");
    const message = fatal
      ? `${TAG} claim ownership lost for "${taskLabel}" (${normalizedReason}) — aborting task to avoid duplicate execution`
      : `${TAG} claim renewal failure for "${taskLabel}" (${normalizedReason}) — aborting task to trigger cleanup`;
    console.warn(message);
    const ac = this._slotAbortControllers.get(taskId);
    if (ac && !ac.signal.aborted) {
      ac.abort(`claim_renewal:${normalizedReason}`);
    }
  }

  _startTaskClaimRenewal(taskId, claimToken, taskTitle = "") {
    // [LEGACY REMOVED] Replaced by workflow node: action.claim_task (renewal timer)
    // See workflow-templates/task-lifecycle.mjs
  }

  _stopTaskClaimRenewal(taskId) {
    const timer = this._taskClaimRenewTimers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this._taskClaimRenewTimers.delete(taskId);
    }
  }

  _stopAllTaskClaimRenewals() {
    for (const timer of this._taskClaimRenewTimers.values()) {
      clearInterval(timer);
    }
    this._taskClaimRenewTimers.clear();
  }

  _resolveTaskBaseBranch(task) {
    return resolveTaskBaseBranch(
      task,
      this.branchRouting,
      this.defaultTargetBranch,
    );
  }

  _resolveTaskBaseBranchKey(task) {
    return normalizeBaseBranchKey(
      this._resolveTaskBaseBranch(task),
      this.defaultTargetBranch,
    );
  }

  _buildActiveBaseBranchCounts() {
    const counts = new Map();
    for (const slot of this._activeSlots.values()) {
      const key = normalizeBaseBranchKey(
        slot.baseBranch,
        this.defaultTargetBranch,
      );
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }


  _extractTaskRepoAreas(task) {
    const values = [];
    const pushValues = (input) => {
      if (!input) return;
      if (Array.isArray(input)) {
        for (const entry of input) pushValues(entry);
        return;
      }
      const normalized = String(input || "").trim().toLowerCase();
      if (!normalized) return;
      values.push(normalized);
    };

    pushValues(task?.repo_areas);
    pushValues(task?.repoAreas);
    pushValues(task?.meta?.repo_areas);
    pushValues(task?.meta?.repoAreas);
    pushValues(task?.task?.repo_areas);
    pushValues(task?.task?.repoAreas);
    pushValues(task?.task?.meta?.repo_areas);
    pushValues(task?.task?.meta?.repoAreas);

    return [...new Set(values)].slice(0, 10);
  }

  _buildActiveRepoAreaCounts() {
    const counts = new Map();
    for (const slot of this._activeSlots.values()) {
      const areas = this._extractTaskRepoAreas(slot);
      for (const area of areas) {
        counts.set(area, (counts.get(area) || 0) + 1);
      }
    }
    return counts;
  }

  _getRepoAreaLockMetric(area) {
    if (!area) return null;
    if (!this._repoAreaLockMetrics.has(area)) {
      this._repoAreaLockMetrics.set(area, {
        conflicts: 0,
        blockedDispatches: 0,
        selectedDispatches: 0,
        waitMsTotal: 0,
        waitSamples: 0,
        maxWaitMs: 0,
        starvationEvents: 0,
        maxStarvationWaitMs: 0,
        maxStarvationCycles: 0,
        lastConflictAt: null,
        lastSelectedAt: null,
        lastStarvationAt: null,
      });
    }
    return this._repoAreaLockMetrics.get(area);
  }

  _buildRepoAreaWorkerMetricKey(area) {
    const normalizedArea = normalizeRepoAreaKey(area);
    if (!normalizedArea) return "";
    const workerId = String(this._instanceId || "").trim() || "executor";
    return `${normalizedArea}::${workerId}`;
  }

  _getRepoAreaWorkerMetric(area) {
    const key = this._buildRepoAreaWorkerMetricKey(area);
    if (!key) return null;
    if (!this._repoAreaWorkerMetrics.has(key)) {
      this._repoAreaWorkerMetrics.set(key, {
        workerId: String(this._instanceId || "").trim() || "executor",
        area: normalizeRepoAreaKey(area),
        waitMsTotal: 0,
        waitSamples: 0,
        lastWaitMs: 0,
        maxWaitMs: 0,
        starvationEvents: 0,
        maxStarvationWaitMs: 0,
        maxStarvationCycles: 0,
        lastBlockedAt: null,
        lastSelectedAt: null,
        lastStarvationAt: null,
      });
    }
    return this._repoAreaWorkerMetrics.get(key);
  }

  _makeRepoAreaWaitKey(taskId, area) {
    const normalizedTaskId = normalizeTaskIdKey(taskId);
    if (!normalizedTaskId || !area) return "";
    return `${normalizedTaskId}::${area}`;
  }

  _beginRepoAreaWait(taskId, area, now = Date.now()) {
    const key = this._makeRepoAreaWaitKey(taskId, area);
    if (!key) return { starvationDetected: false, waitMs: 0, blockedCycles: 0 };
    const existing = this._repoAreaPendingWaits.get(key);
    if (existing) {
      existing.blockedCycles = Math.max(
        1,
        Math.trunc(Number(existing.blockedCycles || 0)),
      ) + 1;
      existing.lastObservedAt = now;
      const waitMs = Math.max(0, now - Number(existing.startedAt || now));
      const shouldMarkStarved =
        !existing.starvationCounted &&
        (
          waitMs >= REPO_AREA_STARVATION_WAIT_MS ||
          existing.blockedCycles >= REPO_AREA_STARVATION_BLOCKED_CYCLES
        );
      if (shouldMarkStarved) {
        existing.starvationCounted = true;
        this._recordRepoAreaStarvation(
          area,
          waitMs,
          existing.blockedCycles,
          now,
        );
      }
      return {
        starvationDetected: shouldMarkStarved,
        waitMs,
        blockedCycles: existing.blockedCycles,
      };
    }
    this._repoAreaPendingWaits.set(key, {
      taskId: normalizeTaskIdKey(taskId),
      area,
      startedAt: now,
      blockedCycles: 1,
      starvationCounted: false,
      lastObservedAt: now,
    });
    return { starvationDetected: false, waitMs: 0, blockedCycles: 1 };
  }

  _recordRepoAreaContentionEvent(taskId, area, waitMs, resolutionReason) {
    const normalizedTaskId = normalizeTaskIdKey(taskId);
    const normalizedArea = normalizeRepoAreaKey(area);
    if (!normalizedTaskId || !normalizedArea) return;
    this._repoAreaContentionEvents.push({
      at: new Date().toISOString(),
      taskId: normalizedTaskId,
      area: normalizedArea,
      waitMs: Math.max(0, Math.trunc(Number(waitMs || 0))),
      resolutionReason: normalizeRepoAreaResolutionReason(resolutionReason),
    });
    if (this._repoAreaContentionEvents.length > REPO_AREA_CONTENTION_EVENT_LIMIT) {
      this._repoAreaContentionEvents = this._repoAreaContentionEvents.slice(
        -REPO_AREA_CONTENTION_EVENT_LIMIT,
      );
    }
  }

  _finalizeRepoAreaWait(
    taskId,
    area,
    now = Date.now(),
    resolutionReason = "resolved",
  ) {
    const key = this._makeRepoAreaWaitKey(taskId, area);
    if (!key) return 0;
    const pending = this._repoAreaPendingWaits.get(key);
    if (!pending) return 0;
    this._repoAreaPendingWaits.delete(key);
    const durationMs = Math.max(0, now - Number(pending.startedAt || now));
    const metric = this._getRepoAreaLockMetric(area);
    if (metric && durationMs > 0) {
      metric.waitMsTotal += durationMs;
      metric.waitSamples += 1;
      metric.maxWaitMs = Math.max(metric.maxWaitMs, durationMs);
    }
    const workerMetric = this._getRepoAreaWorkerMetric(area);
    if (workerMetric && durationMs > 0) {
      workerMetric.waitMsTotal += durationMs;
      workerMetric.waitSamples += 1;
      workerMetric.lastWaitMs = durationMs;
      workerMetric.maxWaitMs = Math.max(workerMetric.maxWaitMs, durationMs);
      workerMetric.lastSelectedAt = new Date(now).toISOString();
    }
    this._recordRepoAreaContentionEvent(
      pending.taskId,
      pending.area,
      durationMs,
      resolutionReason,
    );
    return durationMs;
  }

  _pruneRepoAreaPendingWaits(candidates, now = Date.now()) {
    const candidateIds = new Set(
      (Array.isArray(candidates) ? candidates : [])
        .map((task) => normalizeTaskIdKey(task?.id || task?.task_id))
        .filter(Boolean),
    );
    for (const pending of Array.from(this._repoAreaPendingWaits.values())) {
      if (
        !candidateIds.has(pending.taskId) &&
        !this._activeSlots.has(pending.taskId)
      ) {
        this._finalizeRepoAreaWait(pending.taskId, pending.area, now, "dequeued");
      }
    }
  }

  _clearRepoAreaWaitsForTask(task, now = Date.now(), resolutionReason = "resolved") {
    const taskId = normalizeTaskIdKey(task?.id || task?.task_id || task?.taskId);
    if (!taskId) return;
    for (const area of this._extractTaskRepoAreas(task)) {
      this._finalizeRepoAreaWait(taskId, area, now, resolutionReason);
    }
  }

  _recordRepoAreaStarvation(area, waitMs, blockedCycles, now = Date.now()) {
    const metric = this._getRepoAreaLockMetric(area);
    if (metric) {
      metric.starvationEvents += 1;
      metric.maxStarvationWaitMs = Math.max(
        metric.maxStarvationWaitMs,
        Math.max(0, Math.trunc(Number(waitMs || 0))),
      );
      metric.maxStarvationCycles = Math.max(
        metric.maxStarvationCycles,
        Math.max(0, Math.trunc(Number(blockedCycles || 0))),
      );
      metric.lastStarvationAt = new Date(now).toISOString();
    }
    const workerMetric = this._getRepoAreaWorkerMetric(area);
    if (workerMetric) {
      workerMetric.starvationEvents += 1;
      workerMetric.maxStarvationWaitMs = Math.max(
        workerMetric.maxStarvationWaitMs,
        Math.max(0, Math.trunc(Number(waitMs || 0))),
      );
      workerMetric.maxStarvationCycles = Math.max(
        workerMetric.maxStarvationCycles,
        Math.max(0, Math.trunc(Number(blockedCycles || 0))),
      );
      workerMetric.lastBlockedAt = new Date(now).toISOString();
      workerMetric.lastStarvationAt = new Date(now).toISOString();
    }
  }

  _getTaskRepoAreaPendingState(task, now = Date.now()) {
    const taskId = normalizeTaskIdKey(task?.id || task?.task_id);
    const areas = this._extractTaskRepoAreas(task);
    let maxWaitMs = 0;
    let maxBlockedCycles = 0;
    let starving = false;
    for (const area of areas) {
      const key = this._makeRepoAreaWaitKey(taskId, area);
      const pending = key ? this._repoAreaPendingWaits.get(key) : null;
      if (!pending) continue;
      const waitMs = Math.max(0, now - Number(pending.startedAt || now));
      maxWaitMs = Math.max(maxWaitMs, waitMs);
      maxBlockedCycles = Math.max(
        maxBlockedCycles,
        Math.max(0, Math.trunc(Number(pending.blockedCycles || 0))),
      );
      if (pending.starvationCounted) starving = true;
    }
    return {
      taskId,
      areas,
      maxWaitMs,
      maxBlockedCycles,
      starving,
      primaryArea: areas[0] || "__unscoped__",
    };
  }

  _orderCandidatesForRepoAreaFairQueue(candidates, now = Date.now()) {
    if (!Array.isArray(candidates) || candidates.length <= 1) return candidates || [];
    const grouped = new Map();
    for (let index = 0; index < candidates.length; index += 1) {
      const task = candidates[index];
      const pending = this._getTaskRepoAreaPendingState(task, now);
      const bucket = pending.primaryArea;
      if (!grouped.has(bucket)) grouped.set(bucket, []);
      grouped.get(bucket).push({ task, index, pending });
    }
    const groups = Array.from(grouped.entries()).map(([area, queue]) => {
      queue.sort((a, b) => {
        if (b.pending.maxBlockedCycles !== a.pending.maxBlockedCycles) {
          return b.pending.maxBlockedCycles - a.pending.maxBlockedCycles;
        }
        if (b.pending.maxWaitMs !== a.pending.maxWaitMs) {
          return b.pending.maxWaitMs - a.pending.maxWaitMs;
        }
        return a.index - b.index;
      });
      return {
        area,
        queue,
        oldestWaitMs: queue.reduce(
          (max, entry) => Math.max(max, entry.pending.maxWaitMs),
          0,
        ),
      };
    });
    groups.sort((a, b) => {
      if (b.oldestWaitMs !== a.oldestWaitMs) return b.oldestWaitMs - a.oldestWaitMs;
      return a.area.localeCompare(b.area);
    });
    if (groups.length === 0) return candidates.slice();

    let cursor = Math.max(
      0,
      Math.trunc(Number(this._repoAreaFairQueueCursor || 0)),
    ) % groups.length;
    const ordered = [];
    let remaining = candidates.length;
    while (remaining > 0) {
      let progressed = false;
      for (let offset = 0; offset < groups.length; offset += 1) {
        const idx = (cursor + offset) % groups.length;
        const group = groups[idx];
        if (!group || group.queue.length === 0) continue;
        const next = group.queue.shift();
        ordered.push(next.task);
        cursor = (idx + 1) % groups.length;
        remaining -= 1;
        progressed = true;
        break;
      }
      if (!progressed) break;
    }
    this._repoAreaFairQueueCursor = cursor;
    return ordered.length > 0 ? ordered : candidates.slice();
  }

  _buildActiveRepoAreaSignals(now = Date.now()) {
    const signals = new Map();
    for (const slot of this._activeSlots.values()) {
      const areas = this._extractTaskRepoAreas(slot);
      if (areas.length === 0) continue;
      const startedAt = Number(slot?.startedAt || 0);
      const activeAgeMs = startedAt > 0 ? Math.max(0, now - startedAt) : 0;
      const mergeLatencyMs = Number(
        slot?.mergeLatencyMs || slot?.mergeLatency || 0,
      );
      const latencySampleMs = mergeLatencyMs > 0 ? mergeLatencyMs : activeAgeMs;
      const attempt = Number(slot?.attempt || 0);
      const status = String(slot?.status || "").trim().toLowerCase();
      for (const area of areas) {
        let signal = signals.get(area);
        if (!signal) {
          signal = {
            active: 0,
            retrying: 0,
            mergeLatencyMsTotal: 0,
            mergeLatencySamples: 0,
            maxMergeLatencyMs: 0,
          };
          signals.set(area, signal);
        }
        signal.active += 1;
        if (attempt > 1 || status === "failed") {
          signal.retrying += 1;
        }
        if (latencySampleMs > 0) {
          signal.mergeLatencyMsTotal += latencySampleMs;
          signal.mergeLatencySamples += 1;
          signal.maxMergeLatencyMs = Math.max(
            signal.maxMergeLatencyMs,
            latencySampleMs,
          );
        }
      }
    }
    return signals;
  }

  _computeRepoAreaAdaptiveState(area, activeSignals = null) {
    const configuredLimit = Number(this.repoAreaParallelLimit || 0);
    if (!Number.isFinite(configuredLimit) || configuredLimit <= 0) {
      return {
        activeFailureRate: 0,
        outcomeFailureRate: 0,
        adaptiveFailureRate: 0,
        averageMergeLatencyMs: 0,
        telemetryMergeLatencyMs: 0,
        adaptiveMergeLatencyMs: 0,
        adaptivePenalty: 0,
        adaptiveReasons: [],
        historicalFailureRate: 0,
        historicalMergeLatencyMs: 0,
        effectiveLimit: 0,
        liveLimit: 0,
      };
    }
    if (configuredLimit <= 1) {
      return {
        activeFailureRate: 0,
        outcomeFailureRate: 0,
        adaptiveFailureRate: 0,
        averageMergeLatencyMs: 0,
        telemetryMergeLatencyMs: 0,
        adaptiveMergeLatencyMs: 0,
        adaptivePenalty: 0,
        adaptiveReasons: [],
        historicalFailureRate: 0,
        historicalMergeLatencyMs: 0,
        effectiveLimit: 1,
        liveLimit: 1,
      };
    }

    const normalizedArea = normalizeRepoAreaKey(area);
    const signal = activeSignals?.get(normalizedArea) || {
      active: 0,
      retrying: 0,
      mergeLatencyMsTotal: 0,
      mergeLatencySamples: 0,
      maxMergeLatencyMs: 0,
    };
    const telemetry = normalizeRepoAreaTelemetryEntry(
      this._repoAreaTelemetry.get(normalizedArea),
    );
    const historical = buildRepoAreaAdaptiveSignals(
      telemetry,
      configuredLimit,
    );
    return computeRepoAreaAdaptiveState({
      configuredLimit,
      signal,
      telemetry,
      historicalAdaptive: historical,
    });
  }

  _computeRepoAreaEffectiveLimit(area, activeSignals = null) {
    const adaptiveState = this._computeRepoAreaAdaptiveState(area, activeSignals);
    return Math.max(
      0,
      Math.trunc(Number(adaptiveState?.effectiveLimit || 0)),
    );
  }

  _buildRepoAreaLockStatus(now = Date.now()) {
    const activeCounts = this._buildActiveRepoAreaCounts();
    const activeSignals = this._buildActiveRepoAreaSignals(now);
    const blockedTaskWaitingCounts = buildRepoAreaWaitingCounts(
      this._repoAreaBlockedTasks,
    );
    const waitingCounts = new Map();
    const starvingCounts = new Map();
    const oldestWaitByArea = new Map();
    for (const pending of this._repoAreaPendingWaits.values()) {
      const waitMs = Math.max(0, now - Number(pending.startedAt || now));
      waitingCounts.set(
        pending.area,
        (waitingCounts.get(pending.area) || 0) + 1,
      );
      oldestWaitByArea.set(
        pending.area,
        Math.max(oldestWaitByArea.get(pending.area) || 0, waitMs),
      );
      if (pending.starvationCounted) {
        starvingCounts.set(
          pending.area,
          (starvingCounts.get(pending.area) || 0) + 1,
        );
      }
    }

    const areas = new Set([
      ...activeCounts.keys(),
      ...activeSignals.keys(),
      ...waitingCounts.keys(),
      ...starvingCounts.keys(),
      ...this._repoAreaLockMetrics.keys(),
    ]);

    const items = Array.from(areas)
      .sort()
      .map((area) => {
        const metric = this._getRepoAreaLockMetric(area) || {
          conflicts: 0,
          blockedDispatches: 0,
          selectedDispatches: 0,
          waitMsTotal: 0,
          waitSamples: 0,
          maxWaitMs: 0,
          starvationEvents: 0,
          maxStarvationWaitMs: 0,
          maxStarvationCycles: 0,
          lastConflictAt: null,
          lastSelectedAt: null,
          lastStarvationAt: null,
        };
        const signal = activeSignals.get(area) || {
          active: 0,
          retrying: 0,
          mergeLatencyMsTotal: 0,
          mergeLatencySamples: 0,
          maxMergeLatencyMs: 0,
        };
        const active = activeCounts.get(area) || 0;
        const waitingTasks = waitingCounts.get(area) || 0;
        const telemetry = normalizeRepoAreaTelemetryEntry(
          this._repoAreaTelemetry.get(area),
        );
        const historicalAdaptive = buildRepoAreaAdaptiveSignals(
          telemetry,
          Number(this.repoAreaParallelLimit || 0),
        );
        const adaptiveState = computeRepoAreaAdaptiveState({
          configuredLimit: Number(this.repoAreaParallelLimit || 0),
          signal,
          telemetry,
          historicalAdaptive,
        });

        return {
          area,
          configuredLimit: Number(this.repoAreaParallelLimit || 0),
          effectiveLimit: adaptiveState.effectiveLimit,
          activeSlots: active,
          waitingTasks: Math.max(waitingTasks, blockedTaskWaitingCounts.get(area) || 0),
          starvingTasks: starvingCounts.get(area) || 0,
          oldestWaitingMs: oldestWaitByArea.get(area) || 0,
          activeFailureRate: adaptiveState.activeFailureRate,
          outcomeFailureRate: adaptiveState.outcomeFailureRate,
          adaptiveFailureRate: adaptiveState.adaptiveFailureRate,
          historicalFailureRate: historicalAdaptive.failureRate,
          averageMergeLatencyMs: adaptiveState.averageMergeLatencyMs,
          telemetryMergeLatencyMs: adaptiveState.telemetryMergeLatencyMs,
          historicalMergeLatencyMs: historicalAdaptive.mergeLatencyAvgMs,
          adaptiveMergeLatencyMs: adaptiveState.adaptiveMergeLatencyMs,
          adaptivePenalty: adaptiveState.adaptivePenalty,
          adaptiveReasons: adaptiveState.adaptiveReasons,
          maxMergeLatencyMs: signal.maxMergeLatencyMs || 0,
          conflicts: metric.conflicts,
          blockedDispatches: metric.blockedDispatches,
          selectedDispatches: metric.selectedDispatches,
          averageWaitMs:
            metric.waitSamples > 0 ? metric.waitMsTotal / metric.waitSamples : 0,
          waitMsTotal: metric.waitMsTotal,
          maxWaitMs: metric.maxWaitMs,
          waitSamples: metric.waitSamples,
          starvationEvents: metric.starvationEvents,
          maxStarvationWaitMs: metric.maxStarvationWaitMs,
          maxStarvationCycles: metric.maxStarvationCycles,
          lastConflictAt: metric.lastConflictAt,
          lastSelectedAt: metric.lastSelectedAt,
          lastStarvationAt: metric.lastStarvationAt,
        };
      });
    const contentionByReason = Object.create(null);
    for (const event of this._repoAreaContentionEvents) {
      const reason = normalizeRepoAreaResolutionReason(event?.resolutionReason);
      contentionByReason[reason] = (contentionByReason[reason] || 0) + 1;
    }
    const contentionEvents = this._repoAreaContentionEvents.slice(
      -REPO_AREA_CONTENTION_EVENT_LIMIT,
    );

    const worker = Array.from(this._repoAreaWorkerMetrics.values())
      .map((entry) => ({
        workerId: String(entry?.workerId || "").trim() || "executor",
        area: normalizeRepoAreaKey(entry?.area),
        waitMsTotal: Math.max(0, Math.trunc(Number(entry?.waitMsTotal || 0))),
        waitSamples: Math.max(0, Math.trunc(Number(entry?.waitSamples || 0))),
        lastWaitMs: Math.max(0, Math.trunc(Number(entry?.lastWaitMs || 0))),
        maxWaitMs: Math.max(0, Math.trunc(Number(entry?.maxWaitMs || 0))),
        starvationEvents: Math.max(
          0,
          Math.trunc(Number(entry?.starvationEvents || 0)),
        ),
        maxStarvationWaitMs: Math.max(
          0,
          Math.trunc(Number(entry?.maxStarvationWaitMs || 0)),
        ),
        maxStarvationCycles: Math.max(
          0,
          Math.trunc(Number(entry?.maxStarvationCycles || 0)),
        ),
        lastBlockedAt: entry?.lastBlockedAt ? String(entry.lastBlockedAt) : null,
        lastSelectedAt: entry?.lastSelectedAt ? String(entry.lastSelectedAt) : null,
        lastStarvationAt: entry?.lastStarvationAt
          ? String(entry.lastStarvationAt)
          : null,
      }))
      .filter((entry) => Boolean(entry.area))
      .sort((a, b) => {
        if (b.starvationEvents !== a.starvationEvents) {
          return b.starvationEvents - a.starvationEvents;
        }
        if (b.maxWaitMs !== a.maxWaitMs) return b.maxWaitMs - a.maxWaitMs;
        const areaCmp = a.area.localeCompare(b.area);
        if (areaCmp !== 0) return areaCmp;
        return a.workerId.localeCompare(b.workerId);
      });

    return {
      enabled: Number(this.repoAreaParallelLimit || 0) > 0,
      configuredLimit: Number(this.repoAreaParallelLimit || 0),
      areas: items,
      totals: {
        dispatchCycles: Math.max(
          0,
          Number(this._repoAreaDispatchCycles || 0),
        ),
        conflictEvents: Math.max(
          0,
          Number(this._repoAreaConflictCount || 0),
        ),
        conflicts: items.reduce((sum, item) => sum + item.conflicts, 0),
        blockedDispatches: items.reduce(
          (sum, item) => sum + item.blockedDispatches,
          0,
        ),
        starvationEvents: items.reduce((sum, item) => sum + item.starvationEvents, 0),
        waitMsTotal: items.reduce((sum, item) => sum + item.waitMsTotal, 0),
        waitSamples: items.reduce((sum, item) => sum + item.waitSamples, 0),
        waitingTasks: items.reduce((sum, item) => sum + item.waitingTasks, 0),
        starvingTasks: items.reduce((sum, item) => sum + item.starvingTasks, 0),
        contentionEvents: contentionEvents.length,
      },
      worker,
      fairQueue: {
        policy: "round_robin_oldest_wait",
        cursor: Math.max(0, Math.trunc(Number(this._repoAreaFairQueueCursor || 0))),
        starvationWaitMs: REPO_AREA_STARVATION_WAIT_MS,
        starvationBlockedCycles: REPO_AREA_STARVATION_BLOCKED_CYCLES,
      },
      contention: {
        events: contentionEvents.length,
        waitMsTotal: contentionEvents.reduce(
          (sum, event) => sum + Math.max(0, Number(event?.waitMs || 0)),
          0,
        ),
        byReason: contentionByReason,
        recent: contentionEvents.slice(-10),
      },
      dispatch: {
        cycles: Math.max(0, Math.trunc(Number(this._repoAreaDispatchCycles || 0))),
        conflicts: Math.max(0, Math.trunc(Number(this._repoAreaConflictCount || 0))),
        blockedTasksTracked: this._repoAreaBlockedTasks.size,
        recent: this._repoAreaDispatchHistory.slice(-10),
      },
      lastDispatch: {
        ...this._repoAreaDispatchCycle,
        blockedByArea: { ...this._repoAreaDispatchCycle.blockedByArea },
        saturatedAreas: [...this._repoAreaDispatchCycle.saturatedAreas],
        starvingAreas: [...(this._repoAreaDispatchCycle.starvingAreas || [])],
        areaLimits:
          this._repoAreaDispatchCycle.areaLimits &&
          typeof this._repoAreaDispatchCycle.areaLimits === "object"
            ? { ...this._repoAreaDispatchCycle.areaLimits }
            : {},
      },
    };
  }
  _selectTasksForBaseBranchLimit(candidates, remaining) {
    if (!Array.isArray(candidates) || candidates.length === 0) return [];
    if (!Number.isFinite(remaining) || remaining <= 0) return [];

    const baseBranchLimit = Number(this.baseBranchParallelLimit || 0);
    const repoAreaLimit = Number(this.repoAreaParallelLimit || 0);
    const enforceBaseBranch = Number.isFinite(baseBranchLimit) && baseBranchLimit > 0;
    const enforceRepoArea = Number.isFinite(repoAreaLimit) && repoAreaLimit > 0;
    if (!enforceBaseBranch && !enforceRepoArea) {
      return candidates.slice(0, remaining);
    }

    const now = Date.now();
    this._pruneRepoAreaPendingWaits(candidates, now);
    const orderedCandidates = enforceRepoArea
      ? this._orderCandidatesForRepoAreaFairQueue(candidates, now)
      : candidates;

    const baseBranchCounts = enforceBaseBranch
      ? this._buildActiveBaseBranchCounts()
      : new Map();
    const repoAreaCounts = enforceRepoArea
      ? this._buildActiveRepoAreaCounts()
      : new Map();
    const activeRepoAreaSignals = enforceRepoArea
      ? this._buildActiveRepoAreaSignals(now)
      : new Map();
    const effectiveRepoAreaLimits = new Map();
    const cycleMetricBaseline = new Map();
    if (enforceRepoArea) {
      for (const [area, metric] of this._repoAreaLockMetrics.entries()) {
        cycleMetricBaseline.set(area, {
          conflicts: Math.max(0, Number(metric?.conflicts || 0)),
          blockedDispatches: Math.max(0, Number(metric?.blockedDispatches || 0)),
          selectedDispatches: Math.max(0, Number(metric?.selectedDispatches || 0)),
          starvationEvents: Math.max(0, Number(metric?.starvationEvents || 0)),
          waitMsTotal: Math.max(0, Number(metric?.waitMsTotal || 0)),
          waitSamples: Math.max(0, Number(metric?.waitSamples || 0)),
          maxWaitMs: Math.max(0, Number(metric?.maxWaitMs || 0)),
        });
      }
    }
    const cycleConflictBaseline = Math.max(
      0,
      Number(this._repoAreaConflictCount || 0),
    );
    this._repoAreaDispatchCycle = {
      cycle: Number(this._repoAreaDispatchCycle?.cycle || 0) + 1,
      at: new Date(now).toISOString(),
      policy: "round_robin_oldest_wait",
      candidateCount: orderedCandidates.length,
      remaining,
      selectedCount: 0,
      blockedTasks: 0,
      conflictEvents: 0,
      starvationEvents: 0,
      waitMsTotal: 0,
      waitSamples: 0,
      maxWaitMs: 0,
      blockedByArea: {},
      saturatedAreas: [],
      starvingAreas: [],
      cycleAreaMetrics: {},
      areaLimits: {},
    };
    this._repoAreaDispatchCycles = Math.max(
      0,
      Number(this._repoAreaDispatchCycles || 0),
    ) + 1;

    const selected = [];
    const starvingAreas = new Set();
    for (const task of orderedCandidates) {
      if (selected.length >= remaining) break;

      if (enforceBaseBranch) {
        const key = this._resolveTaskBaseBranchKey(task);
        if (key) {
          const current = baseBranchCounts.get(key) || 0;
          if (current >= baseBranchLimit) continue;
          baseBranchCounts.set(key, current + 1);
        }
      }

      if (enforceRepoArea) {
        const areas = this._extractTaskRepoAreas(task);
        const blockedAreas = areas.filter((area) => {
          if (!effectiveRepoAreaLimits.has(area)) {
            const adaptiveState = this._computeRepoAreaAdaptiveState(
              area,
              activeRepoAreaSignals,
            );
            effectiveRepoAreaLimits.set(area, adaptiveState.effectiveLimit);
            this._repoAreaDispatchCycle.areaLimits[area] = {
              configuredLimit: Math.max(0, Math.trunc(Number(repoAreaLimit || 0))),
              effectiveLimit: Math.max(
                0,
                Math.trunc(Number(adaptiveState.effectiveLimit || 0)),
              ),
              adaptivePenalty: Math.max(
                0,
                Math.trunc(Number(adaptiveState.adaptivePenalty || 0)),
              ),
              adaptiveReasons: Array.isArray(adaptiveState.adaptiveReasons)
                ? adaptiveState.adaptiveReasons.map((reason) => String(reason || "").trim()).filter(Boolean)
                : [],
              activeSlots: Math.max(0, Math.trunc(Number(repoAreaCounts.get(area) || 0))),
              activeFailureRate: Math.max(
                0,
                Number(adaptiveState.activeFailureRate || 0),
              ),
              adaptiveFailureRate: Math.max(
                0,
                Number(adaptiveState.adaptiveFailureRate || 0),
              ),
              averageMergeLatencyMs: Math.max(
                0,
                Number(adaptiveState.averageMergeLatencyMs || 0),
              ),
              adaptiveMergeLatencyMs: Math.max(
                0,
                Number(adaptiveState.adaptiveMergeLatencyMs || 0),
              ),
            };
          }
          const effectiveLimit = effectiveRepoAreaLimits.get(area) || repoAreaLimit;
          return (repoAreaCounts.get(area) || 0) >= effectiveLimit;
        });
        if (blockedAreas.length > 0) {
          if (enforceBaseBranch) {
            const key = this._resolveTaskBaseBranchKey(task);
            if (key) {
              const current = baseBranchCounts.get(key) || 0;
              baseBranchCounts.set(key, Math.max(0, current - 1));
            }
          }
          this._repoAreaDispatchCycle.blockedTasks += 1;
          for (const area of blockedAreas) {
            const metric = this._getRepoAreaLockMetric(area);
            if (metric) {
              metric.blockedDispatches += 1;
              metric.lastConflictAt = this._repoAreaDispatchCycle.at;
            }
            const waitState = this._beginRepoAreaWait(task?.id || task?.task_id, area, now);
            if (waitState.starvationDetected) {
              starvingAreas.add(area);
            }
            this._repoAreaDispatchCycle.blockedByArea[area] =
              (this._repoAreaDispatchCycle.blockedByArea[area] || 0) + 1;
          }
          this._recordRepoAreaConflict(task, blockedAreas, now);
          continue;
        }
        this._rememberTaskRepoAreas(task, now);
        this._clearRepoAreaBlockedTask(task?.id || task?.task_id);
        this._clearRepoAreaWaitsForTask(task, now, "selected");
        for (const area of areas) {
          repoAreaCounts.set(area, (repoAreaCounts.get(area) || 0) + 1);
          const metric = this._getRepoAreaLockMetric(area);
          if (metric) {
            metric.selectedDispatches += 1;
            metric.lastSelectedAt = this._repoAreaDispatchCycle.at;
          }
          const workerMetric = this._getRepoAreaWorkerMetric(area);
          if (workerMetric) {
            workerMetric.lastSelectedAt = this._repoAreaDispatchCycle.at;
          }
        }
      }

      selected.push(task);
    }

    this._repoAreaDispatchCycle.selectedCount = selected.length;
    const cycleAreaMetrics = {};
    for (const [area, metric] of this._repoAreaLockMetrics.entries()) {
      const baseline = cycleMetricBaseline.get(area) || {
        conflicts: 0,
        blockedDispatches: 0,
        selectedDispatches: 0,
        starvationEvents: 0,
        waitMsTotal: 0,
        waitSamples: 0,
        maxWaitMs: 0,
      };
      const delta = {
        conflicts: Math.max(
          0,
          Math.trunc(Number(metric?.conflicts || 0) - Number(baseline.conflicts || 0)),
        ),
        blockedDispatches: Math.max(
          0,
          Math.trunc(
            Number(metric?.blockedDispatches || 0) -
              Number(baseline.blockedDispatches || 0),
          ),
        ),
        selectedDispatches: Math.max(
          0,
          Math.trunc(
            Number(metric?.selectedDispatches || 0) -
              Number(baseline.selectedDispatches || 0),
          ),
        ),
        starvationEvents: Math.max(
          0,
          Math.trunc(
            Number(metric?.starvationEvents || 0) -
              Number(baseline.starvationEvents || 0),
          ),
        ),
        waitMsTotal: Math.max(
          0,
          Math.trunc(Number(metric?.waitMsTotal || 0) - Number(baseline.waitMsTotal || 0)),
        ),
        waitSamples: Math.max(
          0,
          Math.trunc(
            Number(metric?.waitSamples || 0) - Number(baseline.waitSamples || 0),
          ),
        ),
        maxWaitMs: Math.max(0, Math.trunc(Number(metric?.maxWaitMs || 0))),
      };
      if (
        delta.conflicts > 0 ||
        delta.blockedDispatches > 0 ||
        delta.selectedDispatches > 0 ||
        delta.starvationEvents > 0 ||
        delta.waitMsTotal > 0 ||
        delta.waitSamples > 0
      ) {
        cycleAreaMetrics[area] = delta;
      }
    }
    this._repoAreaDispatchCycle.conflictEvents = Math.max(
      0,
      Math.trunc(Number(this._repoAreaConflictCount || 0) - cycleConflictBaseline),
    );
    this._repoAreaDispatchCycle.waitMsTotal = Object.values(cycleAreaMetrics).reduce(
      (sum, metric) => sum + Number(metric?.waitMsTotal || 0),
      0,
    );
    this._repoAreaDispatchCycle.waitSamples = Object.values(cycleAreaMetrics).reduce(
      (sum, metric) => sum + Number(metric?.waitSamples || 0),
      0,
    );
    this._repoAreaDispatchCycle.maxWaitMs = Object.values(cycleAreaMetrics).reduce(
      (max, metric) => Math.max(max, Number(metric?.maxWaitMs || 0)),
      0,
    );
    this._repoAreaDispatchCycle.starvationEvents = Object.values(cycleAreaMetrics).reduce(
      (sum, metric) => sum + Number(metric?.starvationEvents || 0),
      0,
    );
    this._repoAreaDispatchCycle.cycleAreaMetrics = cycleAreaMetrics;
    this._repoAreaDispatchCycle.saturatedAreas = Object.keys(
      this._repoAreaDispatchCycle.blockedByArea,
    ).sort();
    this._repoAreaDispatchCycle.starvingAreas = Array.from(starvingAreas).sort();
    this._repoAreaDispatchHistory.push({
      cycle: this._repoAreaDispatchCycle.cycle,
      at: this._repoAreaDispatchCycle.at,
      policy: this._repoAreaDispatchCycle.policy,
      candidateCount: this._repoAreaDispatchCycle.candidateCount,
      remaining: this._repoAreaDispatchCycle.remaining,
      selectedCount: this._repoAreaDispatchCycle.selectedCount,
      blockedTasks: this._repoAreaDispatchCycle.blockedTasks,
      conflictEvents: this._repoAreaDispatchCycle.conflictEvents,
      starvationEvents: this._repoAreaDispatchCycle.starvationEvents,
      waitMsTotal: this._repoAreaDispatchCycle.waitMsTotal,
      waitSamples: this._repoAreaDispatchCycle.waitSamples,
      maxWaitMs: this._repoAreaDispatchCycle.maxWaitMs,
      blockedByArea: { ...this._repoAreaDispatchCycle.blockedByArea },
      saturatedAreas: [...this._repoAreaDispatchCycle.saturatedAreas],
      starvingAreas: [...this._repoAreaDispatchCycle.starvingAreas],
      cycleAreaMetrics: { ...this._repoAreaDispatchCycle.cycleAreaMetrics },
      areaLimits: { ...(this._repoAreaDispatchCycle.areaLimits || {}) },
    });
    this._repoAreaDispatchHistory = this._repoAreaDispatchHistory.slice(-20);
    if (enforceRepoArea) {
      this._saveRuntimeState();
    }

    return selected;
  }
  _isBaseBranchLimitReached(task) {
    const limit = Number(this.baseBranchParallelLimit || 0);
    if (!Number.isFinite(limit) || limit <= 0) return false;
    const key = this._resolveTaskBaseBranchKey(task);
    if (!key) return false;
    const counts = this._buildActiveBaseBranchCounts();
    return (counts.get(key) || 0) >= limit;
  }

  /**
   * Throttle duplicate "claimed by another orchestrator" issue comments.
   *
   * @param {string} taskId
   * @returns {boolean}
   * @private
   */
  _shouldNotifyClaimConflict(taskId) {
    // [LEGACY REMOVED] Replaced by workflow node: action.claim_task (conflict throttle)
    // See workflow-templates/task-lifecycle.mjs
    return false;
  }

  async _verifyPlannerTaskCompletion(task) {
    const projectId =
      task?.projectId ||
      task?.project_id ||
      this.projectId ||
      this._resolvedProjectId ||
      (await this._ensureResolvedProjectId());
    const requiresProjectId = this._requiresKanbanProjectId();
    if (requiresProjectId && !projectId) {
      return { completed: false, reason: "project_not_found", createdCount: 0 };
    }

    const tasks = await this._listTasksCached(projectId || undefined);
    const allTasks = Array.isArray(tasks) ? tasks : [];
    const sinceMs = parseTaskTimestamp(task) || Date.now();
    const candidates = allTasks.filter((candidate) => {
      if (!candidate) return false;
      if (
        String(candidate.id || "") === String(task?.id || task?.task_id || "")
      ) {
        return false;
      }
      if (isPlannerTaskData(candidate)) return false;
      const createdMs = parseTaskTimestamp(candidate);
      return Number.isFinite(createdMs) && createdMs > sinceMs;
    });
    const backlogCandidates = candidates.filter((candidate) => {
      const status = String(candidate?.status || "").toLowerCase();
      return (
        !status ||
        status === "todo" ||
        status === "inprogress" ||
        status === "inreview"
      );
    });
    const finalCandidates =
      backlogCandidates.length > 0 ? backlogCandidates : candidates;

    return {
      completed: finalCandidates.length > 0,
      createdCount: finalCandidates.length,
      reason: finalCandidates.length > 0 ? "tasks_created" : "no_new_tasks",
      sampleTitles: finalCandidates
        .slice(0, 3)
        .map((candidate) => candidate?.title || candidate?.id)
        .filter(Boolean),
    };
  }

  // ── Poll Loop ─────────────────────────────────────────────────────────────

  _runPollLoopSafely() {
    return this._pollLoop().catch((err) => {
      console.error(
        `${TAG} poll loop unexpected rejection: ${err?.message || err}`,
      );
    });
  }

  async _runInProgressRecoverySafely(trigger = "interval") {
    if (!this._running) return;
    if (this._inProgressRecoveryInFlight) return;
    this._inProgressRecoveryInFlight = true;
    try {
      const summary = await this._recoverInterruptedInProgressTasks(trigger);
      this._recordInProgressRecoveryRun(summary);
    } catch (err) {
      this._recordInProgressRecoveryRun({
        trigger,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        failed: true,
        error: err?.message || String(err),
      });
      console.warn(
        `${TAG} in-progress recovery warning (${trigger}): ${err?.message || err}`,
      );
    } finally {
      this._inProgressRecoveryInFlight = false;
    }
  }

  /**
   * Check kanban for todo tasks and dispatch execution.
   * Guarded against overlapping polls and slot saturation.
   * @private
   */
  async _pollLoop() {
    // [LEGACY REMOVED] Replaced by workflow node: trigger.task_available + condition.slot_available
    // See workflow-templates/task-lifecycle.mjs
  }

  createExecutionPipeline(mode = "single", agents = [], options = {}) {
    return createTaskExecutionPipeline(mode, agents, {
      ...options,
      agentRunner:
        options.agentRunner || this._runExecutionPipelineAgent.bind(this),
    });
  }

  async runExecutionPipeline(mode, agents, input, options = {}) {
    return await runTaskExecutionPipeline(mode, agents, input, {
      ...options,
      agentRunner:
        options.agentRunner || this._runExecutionPipelineAgent.bind(this),
    });
  }

  async _runExecutionPipelineAgent(agent, input, context) {
    return runExecutionPipelineAgent(agent, input, context, {
      execWithRetry,
      repoRoot: this.repoRoot || process.cwd(),
      timeoutMs: this.timeoutMs || 0,
    });
  }

  // ── Task Execution ────────────────────────────────────────────────────────

  _getWorktreeManager(repoRoot) {
    const normalizedRoot = resolve(repoRoot || this.repoRoot || process.cwd());
    let manager = this._worktreeManagers.get(normalizedRoot);
    if (!manager) {
      manager = new WorktreeManager(normalizedRoot);
      this._worktreeManagers.set(normalizedRoot, manager);
    }
    return manager;
  }

  _resolveTaskRepoContext(task) {
    const taskWorkspace = normalizeSelector(
      task?.workspace || task?.meta?.workspace || "",
    );
    const taskRepository = normalizeSelector(
      task?.repository ||
        task?.repo ||
        task?.meta?.repository ||
        task?.meta?.repo ||
        "",
    );
    // Multi-repo: task.repositories is an array of repo slugs/ids
    const taskRepositories = Array.isArray(task?.repositories) && task.repositories.length > 0
      ? task.repositories.map((r) => normalizeSelector(r)).filter(Boolean)
      : taskRepository ? [taskRepository] : [];

    const repoCandidates = Array.isArray(this.repositories)
      ? this.repositories
      : [];
    const scopedCandidates = taskWorkspace
      ? repoCandidates.filter(
          (repo) => normalizeSelector(repo.workspace) === taskWorkspace,
        )
      : repoCandidates;

    const resolveOne = (slug) =>
      scopedCandidates.find((r) => normalizeSelector(r.id) === slug) ||
      scopedCandidates.find((r) => normalizeSelector(r.name) === slug) ||
      scopedCandidates.find((r) => normalizeSelector(r.slug) === slug) ||
      scopedCandidates.find((r) => Array.isArray(r.aliases) && r.aliases.includes(slug)) ||
      null;

    let resolvedRepos = taskRepositories.map(resolveOne).filter(Boolean);

    // Fallback: if no explicit repos, use primary/first in workspace
    if (resolvedRepos.length === 0) {
      const fallbackRepo =
        scopedCandidates.find((repo) => repo.primary) || scopedCandidates[0] || null;
      if (fallbackRepo) resolvedRepos = [fallbackRepo];
    }

    const effectiveRepo = resolvedRepos[0] || null;
    const isMultiRepo = resolvedRepos.length > 1;

    // For multi-repo: spawn in workspace root (parent of repos) — not a git dir
    // For single repo: spawn inside that repo directory (git commands work)
    const repoRoot = isMultiRepo
      ? (effectiveRepo?.path ? dirname(effectiveRepo.path) : this.repoRoot)
      : (effectiveRepo?.path || this.repoRoot);

    return {
      repoRoot,
      repoSlug: effectiveRepo?.slug || this.repoSlug || "",
      workspace:
        taskWorkspace ||
        normalizeSelector(effectiveRepo?.workspace || this.activeWorkspace || "") ||
        "",
      repository:
        taskRepository ||
        normalizeSelector(effectiveRepo?.id || effectiveRepo?.name || "") ||
        "",
      resolvedRepos,
      isMultiRepo,
    };
  }

  /**
   * Execute a single task through its full lifecycle:
   * slot allocation → status update → worktree → agent → result → cleanup.
   * @param {Object} task - Task object from kanban adapter
   * @returns {Promise<void>}
   */
  async executeTask(task, options = {}) {
    const taskId = String(task?.id || task?.task_id || "").trim();
    if (!taskId) {
      return { skipped: true, reason: "missing_task_id" };
    }

    const workflowMeta =
      task?.meta?.workflow && typeof task.meta.workflow === "object" && !Array.isArray(task.meta.workflow)
        ? task.meta.workflow
        : {};
    const activeTrace = getCurrentTraceContext();
    const storedTraceparent = String(
      options?.traceparent || workflowMeta.traceparent || task?.traceparent || "",
    ).trim();
    const resolvedSdk = String(
      options?.sdk ||
        options?.executor ||
        task?.sdk ||
        task?.executor ||
        this.sdk ||
        "auto",
    ).trim() || "auto";
    const resolvedModel = String(
      options?.model ||
        task?.model ||
        task?.modelName ||
        task?.meta?.model ||
        "",
    ).trim();
    const branch = String(
      task?.branch ||
        task?.branchName ||
        task?.meta?.branch ||
        task?.meta?.branch_name ||
        "",
    ).trim() || `task/${taskId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "work"}`;

    return traceTaskExecution(
      {
        taskId,
        title: String(task?.title || task?.task_title || taskId).trim() || taskId,
        priority: task?.priority || task?.meta?.priority || null,
        assignee: task?.assignee || task?.owner || task?.meta?.assignee || workflowMeta.agentId || null,
        workflowId: options?.workflowId || task?.workflowId || workflowMeta.workflowId || null,
        workflowRunId: options?.workflowRunId || task?.runId || workflowMeta.runId || null,
        rootRunId: options?.rootRunId || workflowMeta.rootRunId || null,
        parentRunId: options?.parentRunId || workflowMeta.parentRunId || null,
        agentId: options?.agentId || task?.agentId || workflowMeta.agentId || task?.assignee || null,
        sdk: resolvedSdk,
        model: resolvedModel || null,
        branch,
        ...(storedTraceparent && !activeTrace ? { carrier: { traceparent: storedTraceparent } } : {}),
      },
      async () => {
        // When workflow automation owns lifecycle execution, emit a synthetic
        // "started" slot so monitor/ui hooks can dispatch trigger.task_assigned.
        if (this.workflowOwnsTaskLifecycle) {
          const now = Date.now();
          const taskTitle = String(task?.title || task?.task_title || taskId).trim() || taskId;
          const worktreePath = String(
            task?.worktreePath ||
              task?.meta?.worktreePath ||
              task?.meta?.worktree_path ||
              "",
          ).trim() || null;

          const slot = {
            taskId,
            taskTitle,
            branch,
            worktreePath,
            sdk: resolvedSdk,
            model: resolvedModel || null,
            attempt: 1,
            startedAt: now,
            status: "running",
            agentInstanceId: null,
          };

          if (typeof this.onTaskStarted === "function") {
            try {
              await this.onTaskStarted(task, slot);
            } catch (err) {
              console.warn(`${TAG} onTaskStarted hook failed for "${taskTitle}": ${err?.message || err}`);
            }
          }

          return {
            queued: false,
            started: true,
            dispatched: true,
            mode: "workflow-owned",
            taskId,
            sdk: resolvedSdk,
            model: resolvedModel || null,
          };
        }

        // [LEGACY REMOVED] Replaced by workflow node: TASK_LIFECYCLE_TEMPLATE (all nodes)
        // See workflow-templates/task-lifecycle.mjs
        return { skipped: true, reason: "legacy_removed" };
      },
    );
  }

  // ── Prompt Building ───────────────────────────────────────────────────────

  _resolveAgentPrompt(key, values, fallbackPrompt) {
    const template = this._agentPrompts?.[key];
    return resolvePromptTemplate(template, values, fallbackPrompt);
  }

  /**
   * Build a comprehensive prompt for the agent from task details and repo context.
   * @param {Object} task
   * @param {string} worktreePath
   * @returns {string}
   * @private
   */
  _buildTaskPrompt(task, worktreePath, opts = {}) {
    // [LEGACY REMOVED] Replaced by workflow node: action.build_task_prompt
    // See workflow-templates/task-lifecycle.mjs
    return "";
  }

  /**
   * Build a retry prompt for the agent after a failed attempt.
   * @param {Object} task
   * @param {Object} lastResult
   * @param {number} attemptNumber
   * @returns {string}
   * @private
   */
  _buildRetryPrompt(task, lastResult, attemptNumber) {
    // [LEGACY REMOVED] Replaced by workflow node: action.build_task_prompt (retry variant)
    // See workflow-templates/task-lifecycle.mjs
    return "";
  }

  /**
   * Build a CONTINUE prompt when the agent went idle (stopped producing events)
   * but has not yet completed the task. This is softer than a retry — it nudges
   * the agent to resume work rather than starting error recovery.
   *
   * @param {Object} task
   * @param {Object} lastResult
   * @param {number} attemptNumber
   * @returns {string}
   * @private
   */
  _buildContinuePrompt(task, lastResult, attemptNumber) {
    // [LEGACY REMOVED] Replaced by workflow node: action.build_task_prompt (continue variant)
    // See workflow-templates/task-lifecycle.mjs
    return "";
  }

  /**
   * Load and cache repo context files (AGENTS.md, copilot-instructions.md).
   * Cached for CONTEXT_CACHE_TTL to avoid re-reading on every task.
   * @returns {string|null}
   * @private
   */
  _getRepoContext(repoRoot = this.repoRoot) {
    const normalizedRoot = resolve(repoRoot || this.repoRoot || process.cwd());
    const now = Date.now();
    const cached = this._contextCacheByRepo.get(normalizedRoot);
    if (cached && now - cached.cachedAt < CONTEXT_CACHE_TTL) {
      return cached.context;
    }

    const parts = [];
    const contextFiles = [
      { rel: "AGENTS.md", label: "AGENTS.md" },
      { rel: ".github/copilot-instructions.md", label: "Copilot Instructions" },
    ];

    for (const cf of contextFiles) {
      try {
        const fullPath = resolve(normalizedRoot, cf.rel);
        if (existsSync(fullPath)) {
          const content = readFileSync(fullPath, "utf8");
          const truncated = truncateUtf8Bytes(sanitizeRepoContextText(content));
          parts.push(`### ${cf.label}\n\n${truncated}`);
        }
      } catch {
        // Ignore read errors
      }
    }

    const context = parts.length > 0 ? parts.join("\n\n---\n\n") : null;
    this._contextCacheByRepo.set(normalizedRoot, {
      context,
      cachedAt: now,
    });
    this._contextCache = context;
    this._contextCacheTime = now;
    return context;
  }

  // ── Result Handling ───────────────────────────────────────────────────────

  /**
   * Handle the result of a task execution — lifecycle handoff, status update, notifications.
   * @param {Object} task
   * @param {Object} result - { success, attempts, error, output }
   * @param {string} worktreePath
   * @returns {Promise<void>}
   * @private
   */
  async _handleTaskResult(task, result, worktreePath, execInfo = {}) {
    // [LEGACY REMOVED] Replaced by workflow node: action.detect_new_commits + action.push_branch
    // See workflow-templates/task-lifecycle.mjs
  }

  async _processBacklogReplenishment(task, result) {
    // [LEGACY REMOVED] Replaced by workflow node: workflow post-completion nodes
    // See workflow-templates/task-lifecycle.mjs
  }

  // ── Review Handoff ────────────────────────────────────────────────────────

  /**
   * Queue a task for review handoff after successful lifecycle handoff.
   * Collects diff stats + session context and passes to the review agent.
   *
   * @param {Object} task
   * @param {string} worktreePath
  /**
   * Determine if a task that reported "success" but made no commits
   * should be automatically resumed with a CONTINUE prompt.
   *
   * Returns true when the session analysis suggests the agent stopped
   * prematurely (false_completion, plan_stuck, analysis_paralysis, etc.)
   *
   * @param {string} taskId
   * @param {string} taskTitle
   * @param {Object} sessionAnalysis - from analyzeMessageSequence()
   * @param {Array} sessionMessages - raw messages
   * @returns {boolean}
   * @private
   */
  _shouldAutoResume(taskId, taskTitle, sessionAnalysis, sessionMessages) {
    // [LEGACY REMOVED] Replaced by workflow node: workflow condition nodes
    // See workflow-templates/task-lifecycle.mjs
    return false;
  }

  /**
   * Queue a completed task for review handoff.
   * @param {Object} task
   * @param {string} worktreePath
   * @param {Object} pr - { url, branch, prNumber }
   * @param {Object} execInfo - { sessionSummary, sessionAnalysis, ... }
   * @private
   */
  _queueReviewHandoff(task, worktreePath, pr, execInfo = {}) {
    // [LEGACY REMOVED] Replaced by workflow node: workflow review nodes
    // See workflow-templates/task-lifecycle.mjs
  }

  /**
   * Set the review agent instance (called by monitor.mjs during initialization).
   * @param {import("../agent/review-agent.mjs").ReviewAgent} agent
   */
  setReviewAgent(agent) {
    this._reviewAgent = agent;
    console.log(`${TAG} review agent connected`);
  }

  // ── Git Helpers ───────────────────────────────────────────────────────────

  /**
   * Check whether a worktree has unpushed commits.
   * @param {string} worktreePath
   * @returns {boolean}
   * @private
   */
  _hasUnpushedCommits(worktreePath, baseBranch = "main") {
    // [LEGACY REMOVED] Replaced by workflow node: action.detect_new_commits
    // See workflow-templates/task-lifecycle.mjs
    return false;
  }

  /**
   * Push the current branch to origin. Must be called before creating a PR.
   * Handles both fresh push (--set-upstream) and subsequent pushes.
   * Skips pre-push hooks to avoid blocking on lint/test (agent already validated).
   * @param {string} worktreePath
   * @param {string} branch
   * @returns {{ success: boolean, error?: string }}
   * @private
   */
  _pushBranch(worktreePath, branch, baseBranch = "main") {
    // [LEGACY REMOVED] Replaced by workflow node: action.push_branch
    // See workflow-templates/task-lifecycle.mjs
    return { success: false, reason: "legacy_removed" };
  }

  /**
   * Enable GitHub auto-merge on a PR so it merges automatically when CI passes.
   * When direct merge succeeds (no required checks), also closes the linked issue.
   * @param {string|number} prNumber
   * @param {string} worktreePath
   * @param {Object} [task] Optional task — used to close linked issue on direct merge.
   * @private
   */
  _enableAutoMerge(prNumber, worktreePath, task = null) {
    // [LEGACY REMOVED] Replaced by workflow node: workflow PR review/merge nodes
    // See workflow-templates/task-lifecycle.mjs
  }

  /**
   * Post a comment on the linked GitHub issue with commit details and PR info.
   * @param {Object} task
   * @param {string} worktreePath
   * @param {Object} execInfo  Contains preExecHead, postExecHead
   * @param {Object} pr        Contains url, branch, prNumber
   * @returns {Promise<void>}
   * @private
   */
  async _commentCommitsOnIssue(task, worktreePath, execInfo, pr) {
    // [LEGACY REMOVED] Replaced by workflow node: workflow completion notification nodes
    // See workflow-templates/task-lifecycle.mjs
  }

  /**
   * Close the linked GitHub issue after a PR is merged.
   * Posts a completion comment and updates the task status to done.
   * @param {Object} task
   * @param {string|number} prNumber
   * @returns {Promise<void>}
   * @private
   */
  async _closeIssueAfterMerge(task, prNumber) {
    // [LEGACY REMOVED] Replaced by workflow node: workflow completion nodes
    // See workflow-templates/task-lifecycle.mjs
  }

  /**
   * Record Bosun-managed PR lifecycle handoff for a completed task.
   * @param {Object} task
   * @param {string} worktreePath
   * @returns {Promise<{url: string, branch: string}|null>}
   * @private
   */
  async _createPR(task, worktreePath, opts = {}) {
    // [LEGACY REMOVED] Replaced by workflow node: workflow post-push PR lifecycle nodes
    // See workflow-templates/task-lifecycle.mjs
    return null;
  }
}

// ── Singleton & Module Exports ──────────────────────────────────────────────

/** @type {TaskExecutor|null} */
let _instance = null;

/**
 * Get or create the singleton TaskExecutor.
 * @param {TaskExecutorOptions} [opts]
 * @returns {TaskExecutor}
 */
export function getTaskExecutor(opts) {
  if (!_instance) {
    _instance = new TaskExecutor(opts || loadExecutorOptionsFromConfig());
  }
  return _instance;
}

/**
 * Load executor options from config/env.
 * @returns {TaskExecutorOptions}
 */
export function loadExecutorOptionsFromConfig() {
  let config;
  try {
    config = loadConfig();
  } catch {
    config = {};
  }

  const envMode = (process.env.EXECUTOR_MODE || "").toLowerCase();
  const configExec = config.internalExecutor || config.taskExecutor || {};
  const configReq = config.projectRequirements || configExec.projectRequirements || {};
  const reviewAgentRaw = process.env.INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED;
  const reviewAgentEnabled =
    reviewAgentRaw !== undefined && String(reviewAgentRaw).trim() !== ""
      ? !["0", "false", "no", "off"].includes(
          String(reviewAgentRaw).trim().toLowerCase(),
        )
      : configExec.reviewAgentEnabled !== false;

  return {
    mode: envMode || configExec.mode || "internal",
    maxParallel: Number(
      process.env.INTERNAL_EXECUTOR_PARALLEL || configExec.maxParallel || 5,
    ),
    baseBranchParallelLimit: Number(
      process.env.INTERNAL_EXECUTOR_BASE_BRANCH_PARALLEL ||
        configExec.baseBranchParallelLimit ||
        0,
    ),
    repoAreaParallelLimit: Number(
      process.env.INTERNAL_EXECUTOR_REPO_AREA_PARALLEL ||
        configExec.repoAreaParallelLimit ||
        0,
    ),
    pollIntervalMs: Number(
      process.env.INTERNAL_EXECUTOR_POLL_MS ||
        configExec.pollIntervalMs ||
        30_000,
    ),
    sdk: process.env.INTERNAL_EXECUTOR_SDK || configExec.sdk || "auto",
    taskTimeoutMs: Number(
      process.env.INTERNAL_EXECUTOR_TIMEOUT_MS ||
        configExec.taskTimeoutMs ||
        90 * 60 * 1000,
    ),
    maxRetries: Number(
      process.env.INTERNAL_EXECUTOR_MAX_RETRIES || configExec.maxRetries || 2,
    ),
    autoCreatePr: configExec.autoCreatePr !== false,
    flowReviewGateRequired: isFlowReviewGateRequired(
      configExec.flowRequireReview !== false,
    ),
    projectId:
      process.env.INTERNAL_EXECUTOR_PROJECT_ID || configExec.projectId || null,
    reviewAgentEnabled,
    reviewMaxConcurrent: Number(
      process.env.INTERNAL_EXECUTOR_REVIEW_MAX_CONCURRENT ||
        configExec.reviewMaxConcurrent ||
        2,
    ),
    reviewTimeoutMs: Number(
      process.env.INTERNAL_EXECUTOR_REVIEW_TIMEOUT_MS ||
        configExec.reviewTimeoutMs ||
        300000,
    ),
    taskClaimOwnerStaleTtlMs: Number(
      process.env.TASK_CLAIM_OWNER_STALE_TTL_MS ||
        configExec.taskClaimOwnerStaleTtlMs ||
        10 * 60 * 1000,
    ),
    taskClaimRenewIntervalMs: Number(
      process.env.TASK_CLAIM_RENEW_INTERVAL_MS ||
        configExec.taskClaimRenewIntervalMs ||
        5 * 60 * 1000,
    ),
    backlogReplenishment: {
      enabled:
        ["1", "true", "yes", "on"].includes(
          String(process.env.INTERNAL_EXECUTOR_REPLENISH_ENABLED || "")
            .trim()
            .toLowerCase(),
        ) || configExec.backlogReplenishment?.enabled === true,
      minNewTasks: Number(
        process.env.INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS ||
          configExec.backlogReplenishment?.minNewTasks ||
          1,
      ),
      maxNewTasks: Number(
        process.env.INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS ||
          configExec.backlogReplenishment?.maxNewTasks ||
          2,
      ),
      requirePriority:
        process.env.INTERNAL_EXECUTOR_REPLENISH_REQUIRE_PRIORITY === undefined
          ? configExec.backlogReplenishment?.requirePriority !== false
          : !["0", "false", "no", "off"].includes(
              String(process.env.INTERNAL_EXECUTOR_REPLENISH_REQUIRE_PRIORITY)
                .trim()
                .toLowerCase(),
            ),
    },
    projectRequirements: {
      profile:
        process.env.PROJECT_REQUIREMENTS_PROFILE || configReq.profile || "feature",
      notes:
        process.env.PROJECT_REQUIREMENTS_NOTES || configReq.notes || "",
    },
    repoRoot: config.repoRoot || process.cwd(),
    repoSlug: config.repoSlug || "",
    repositories: Array.isArray(config.repositories) ? config.repositories : [],
    activeWorkspace: config.activeWorkspace || "",
    branchRouting: config.branchRouting || null,
    defaultTargetBranch:
      config.branchRouting?.defaultBranch ||
      process.env.BOSUN_TARGET_BRANCH ||
      "origin/main",
    agentPrompts: config.agentPrompts || {},
  };
}

/**
 * Check whether internal executor mode is enabled.
 * @returns {boolean}
 */
export function isInternalExecutorEnabled() {
  const mode = (process.env.EXECUTOR_MODE || "").toLowerCase();
  if (DISABLED_MODES.has(mode)) return false;
  if (mode === "internal" || mode === "hybrid") return true;
  try {
    const config = loadConfig();
    const configMode = (
      config.internalExecutor?.mode ||
      config.taskExecutor?.mode ||
      ""
    ).toLowerCase();
    if (DISABLED_MODES.has(configMode)) return false;
    return configMode === "internal" || configMode === "hybrid";
  } catch {
    return false;
  }
}

/** Valid executor modes — "disabled"/"none"/"monitor-only" stop all task execution. */
const VALID_EXECUTOR_MODES = [
  "internal",
  "hybrid",
  "disabled",
  "none",
  "monitor-only",
];
const DISABLED_MODES = new Set(["disabled", "none", "monitor-only"]);

/**
 * Convenience: get executor mode.
 * @returns {"internal"|"hybrid"|"disabled"|"none"|"monitor-only"}
 */
export function getExecutorMode() {
  const mode = (process.env.EXECUTOR_MODE || "").toLowerCase();
  if (VALID_EXECUTOR_MODES.includes(mode)) return mode;
  try {
    const config = loadConfig();
    const configMode = (
      config.internalExecutor?.mode ||
      config.taskExecutor?.mode ||
      "internal"
    ).toLowerCase();
    if (VALID_EXECUTOR_MODES.includes(configMode)) return configMode;
  } catch {
    /* ignore */
  }
  return "internal";
}

/**
 * Check whether task execution is completely disabled.
 * @returns {boolean}
 */
export function isExecutorDisabled() {
  return DISABLED_MODES.has(getExecutorMode());
}

export { TaskExecutor };
export default TaskExecutor;
