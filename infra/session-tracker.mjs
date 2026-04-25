/**
 * session-tracker.mjs — Captures the last N agent messages for review handoff.
 *
 * When an agent completes (DONE/idle), the session tracker provides the last 10
 * messages as context for the reviewer agent, including both agent outputs and
 * tool calls/results.
 *
 * Supports disk persistence: each session is stored as a JSON file in
 * `logs/sessions/<sessionId>.json` and auto-loaded on init.
 *
 * @module session-tracker
 */

import { createRequire } from "node:module";
import { resolve, dirname, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildSessionInsights } from "../lib/session-insights.mjs";
import {
  deleteSessionRecordFromStateLedger,
  getSessionActivityFromStateLedger,
  upsertSessionRecordToStateLedger,
} from "../lib/state-ledger-sqlite.mjs";
import { isTestRuntime } from "./test-runtime.mjs";
import { addCompletedSession } from "./runtime-accumulator.mjs";
import { recordHarnessTelemetryEvent } from "./session-telemetry.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const requireModule = createRequire(import.meta.url);
const { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } = requireModule("node:fs");
const WORKSPACE_MIRROR_MARKER = `${sep}.bosun${sep}workspaces${sep}`.toLowerCase();

function resolveSessionTrackerSourceRepoRoot(startDir = __dirname) {
  const normalized = resolve(startDir);
  const lower = normalized.toLowerCase();
  const mirrorIndex = lower.indexOf(WORKSPACE_MIRROR_MARKER);
  if (mirrorIndex >= 0) {
    return normalized.slice(0, mirrorIndex);
  }
  return resolve(normalized, "..");
}

const SESSION_TRACKER_REPO_ROOT = resolveSessionTrackerSourceRepoRoot(__dirname);
const SESSIONS_DIR = resolve(SESSION_TRACKER_REPO_ROOT, "logs", "sessions");

const TAG = "[session-tracker]";

/** Default: keep last 300 messages per task session.
 *  Previously 10 — far too few for historic session review. */
const DEFAULT_MAX_MESSAGES = 300;

/** Default: keep a bounded history for manual/primary chat sessions. */
const DEFAULT_CHAT_MAX_MESSAGES = 600;

/** Maximum characters per message entry to prevent pathological memory bloat.
 *  100 000 chars (~25 000 words) is generous enough for any real agent response
 *  while still guarding against a runaway stream filling memory.
 */
const MAX_MESSAGE_CHARS = 100_000;

/** Maximum total sessions to keep in memory. */
const MAX_SESSIONS = 100;
const RETIRED_SESSION_SUPPRESSION_MS = 5 * 60 * 1000;
const TERMINAL_SESSION_STATUSES = new Set([
  "completed",
  "failed",
  "idle",
  "archived",
  "stalled",
  "blocked_by_repo",
  "blocked_by_env",
  "no_output",
  "implementation_done_commit_blocked",
]);

const SESSION_PLACEHOLDER_OUTPUTS = new Set([
  "continued",
  "model response continued",
  "turn completed",
  "session completed",
  "agent is composing a response...",
  "agent is composing a response…",
]);

const REPO_BLOCK_PATTERNS = [
  /merge conflict/i,
  /unmerged files/i,
  /protected branch/i,
  /non-fast-forward/i,
  /failed to push/i,
  /push rejected/i,
  /cannot rebase/i,
  /pre-push hook/i,
  /hook declined/i,
  /working tree has changes/i,
  /index contains uncommitted changes/i,
];

const ENV_BLOCK_PATTERNS = [
  /prompt quality/i,
  /missing task (description|url)/i,
  /missing tool/i,
  /not recognized as an internal or external command/i,
  /command not found/i,
  /spawn .*enoent/i,
  /enoent/i,
  /permission denied/i,
  /access is denied/i,
  /authentication failed/i,
  /not authenticated/i,
  /missing credentials/i,
  /token/i,
  /connection refused/i,
  /connection reset/i,
  /network/i,
  /timeout/i,
  /sdk unavailable/i,
  /failed to list models/i,
];

const COMMIT_BLOCK_PATTERNS = [
  /commit blocked/i,
  /implementation_done_commit_blocked/i,
  /git commit/i,
  /git push/i,
  /pre-push hook/i,
  /hook/i,
];

function isTerminalSessionStatus(status) {
  return TERMINAL_SESSION_STATUSES.has(String(status || "").trim().toLowerCase());
}

function randomToken(length = 8) {
  return randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}

function resolveSessionTrackerPersistDir(options = {}) {
  if (options.persistDir !== undefined) {
    return options.persistDir;
  }
  return isTestRuntime() ? null : SESSIONS_DIR;
}

export const _test = Object.freeze({
  resolveSessionTrackerSourceRepoRoot,
  resolveSessionTrackerPersistDir,
  deriveTerminalSessionStatus,
});

function normalizeSessionStatus(status, fallback = "completed") {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized || fallback;
}

function getSessionMessageText(message) {
  return String(message?.content || message?.summary || "").trim();
}

function hasMeaningfulSessionOutput(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  return messages.some((message) => {
    const text = getSessionMessageText(message);
    if (!text) return false;
    const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
    if (!normalized || SESSION_PLACEHOLDER_OUTPUTS.has(normalized)) return false;
    const messageType = String(message?.type || "").trim().toLowerCase();
    const messageRole = String(message?.role || "").trim().toLowerCase();
    if (messageType === "agent_message" || messageType === "assistant" || messageRole === "assistant") {
      return true;
    }
    if (message?.type === "tool_call" || message?.type === "tool_result") return true;
    if (message?.type === "error") return true;
    return /edit|write|create|patch|commit|push|search|diff|test/i.test(text);
  });
}

function classifyBlockedSessionText(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (COMMIT_BLOCK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "implementation_done_commit_blocked";
  }
  if (REPO_BLOCK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "blocked_by_repo";
  }
  if (ENV_BLOCK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "blocked_by_env";
  }
  return null;
}

function deriveIdleTerminalSessionStatus(session) {
  return hasMeaningfulSessionOutput(session) ? "stalled" : "no_output";
}

function deriveTerminalSessionStatus(session, requestedStatus = "completed") {
  const normalizedRequested = normalizeSessionStatus(requestedStatus);
  if (
    normalizedRequested !== "completed" &&
    normalizedRequested !== "idle" &&
    normalizedRequested !== "active"
  ) {
    return normalizedRequested;
  }

  if (normalizedRequested === "idle" || normalizedRequested === "active") {
    return deriveIdleTerminalSessionStatus(session);
  }

  const messages = Array.isArray(session?.messages) ? session.messages : [];
  if (!messages.length || !hasMeaningfulSessionOutput(session)) {
    return "no_output";
  }

  const recentText = messages
    .slice(-8)
    .map((message) => getSessionMessageText(message))
    .filter(Boolean)
    .join("\n");
  const blockedStatus = classifyBlockedSessionText(recentText);
  if (blockedStatus) return blockedStatus;

  return "completed";
}

function resolveSessionMaxMessages(type, metadata, explicitMax, fallbackMax) {
  if (Number.isFinite(explicitMax)) {
    return explicitMax > 0 ? explicitMax : 0;
  }
  if (Number.isFinite(metadata?.maxMessages)) {
    return metadata.maxMessages > 0 ? metadata.maxMessages : 0;
  }
  const normalizedType = String(type || "").toLowerCase();
  if (["primary", "manual", "chat"].includes(normalizedType)) {
    return DEFAULT_CHAT_MAX_MESSAGES;
  }
  return fallbackMax;
}

function normalizeSessionMetadata(metadata = {}) {
  const source =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata
      : {};
  const normalized = { ...source };
  const trimKeys = [
    "title",
    "workspaceId",
    "workspaceDir",
    "workspaceRoot",
    "branch",
    "workflowId",
    "workflowName",
    "sourceNodeId",
    "rootTaskId",
    "parentTaskId",
    "rootSessionId",
    "parentSessionId",
    "rootRunId",
    "parentRunId",
    "taskSessionId",
  ];
  for (const key of trimKeys) {
    if (normalized[key] == null) continue;
    const text = String(normalized[key] || "").trim();
    normalized[key] = text || undefined;
  }
  const delegationDepth = Number(normalized.delegationDepth);
  normalized.delegationDepth = Number.isFinite(delegationDepth)
    ? Math.max(0, Math.trunc(delegationDepth))
    : 0;
  if (Array.isArray(source.queuedFollowups)) {
    normalized.queuedFollowups = source.queuedFollowups
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const content = String(entry.content ?? entry.message ?? "").trim();
        const attachments = Array.isArray(entry.attachments) ? entry.attachments.filter(Boolean).slice(0, 20) : [];
        if (!content && attachments.length === 0) return null;
        return {
          id: String(entry.id || `queued-${randomToken(10)}`).trim(),
          content: content.slice(0, MAX_MESSAGE_CHARS),
          queuedAt: String(entry.queuedAt || entry.createdAt || new Date().toISOString()).trim() || new Date().toISOString(),
          deliveryMode: String(entry.deliveryMode || entry.mode || "queue").trim() || "queue",
          agent: String(entry.agent || "").trim() || null,
          model: String(entry.model || "").trim() || null,
          attachments,
        };
      })
      .filter(Boolean)
      .slice(0, 50);
  }
  return normalized;
}

function buildSessionRecordFromPersistedData(data, idleThresholdMs) {
  if (!data || typeof data !== "object") return null;
  const id = String(data.id || data.taskId || "").trim();
  if (!id) return null;

  const createdAt = String(data.createdAt || "").trim() || new Date().toISOString();
  const lastActiveAt = String(data.lastActiveAt || data.updatedAt || "").trim() || createdAt;
  const lastActiveMs = Date.parse(lastActiveAt) || Date.parse(createdAt) || Date.now();

  let status = normalizeSessionStatus(data.status || "completed");
  let endedAt = data.endedAt || null;
  if (status === "active" && lastActiveMs > 0) {
    const ageMs = Date.now() - lastActiveMs;
    if (ageMs > idleThresholdMs) {
      status = deriveIdleTerminalSessionStatus(data);
      endedAt = endedAt || lastActiveMs;
    }
  }

  const messages = Array.isArray(data.messages) ? data.messages : [];
  const metadata = normalizeSessionMetadata(data.metadata || {});
  return {
    id,
    taskId: data.taskId || id,
    taskTitle: data.taskTitle || data.title || metadata.title || id,
    sessionKey:
      String(data.sessionKey || "").trim() ||
      `${data.taskId || id}:${data.startedAt || lastActiveMs}:${endedAt || data.startedAt || lastActiveMs}`,
    type: data.type || "task",
    status,
    createdAt,
    lastActiveAt,
    startedAt: data.startedAt || (createdAt ? new Date(createdAt).getTime() : lastActiveMs),
    endedAt,
    messages,
    totalEvents: messages.length,
    turnCount: data.turnCount || 0,
    turns: Array.isArray(data.turns) ? data.turns : [],
    accumulatedAt: data.accumulatedAt || null,
    lastActivityAt: lastActiveMs,
    workspaceId: String(data.workspaceId || metadata.workspaceId || "").trim() || null,
    workspaceDir: String(data.workspaceDir || metadata.workspaceDir || "").trim() || null,
    workspaceRoot: String(data.workspaceRoot || metadata.workspaceRoot || "").trim() || null,
    metadata,
    insights: data.insights || buildSessionInsights({ messages }),
    trajectory: data.trajectory || { version: 1, replayable: true, steps: [] },
    summary: data.summary || null,
  };
}

// ── Message Types ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} SessionMessage
 * @property {string} type        - "agent_message"|"tool_call"|"tool_result"|"error"|"system"
 * @property {string} content     - Message content (capped at MAX_MESSAGE_CHARS)
 * @property {string} timestamp   - ISO timestamp
 * @property {Object} [meta]      - Optional metadata (tool name, etc.)
 */

/**
 * @typedef {Object} SessionRecord
 * @property {string} taskId
 * @property {string} taskTitle
 * @property {number} startedAt
 * @property {number|null} endedAt
 * @property {SessionMessage[]} messages
 * @property {number} totalEvents     - Total events received (before truncation)
 * @property {Array<Object>} [turns]   - Per-turn rollup timeline
 * @property {string} status          - "active"|"completed"|"idle"|"failed"
 * @property {number} lastActivityAt  - Timestamp of last event
 */

function parseTimestampMs(value, fallback = Date.now()) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeTokenNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.round(num) : 0;
}

function extractUsageFromMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  const usage = meta.usage && typeof meta.usage === "object"
    ? meta.usage
    : (meta.tokenUsage && typeof meta.tokenUsage === "object" ? meta.tokenUsage : meta);
  const inputTokens = normalizeTokenNumber(
    usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens,
  );
  const outputTokens = normalizeTokenNumber(
    usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens,
  );
  const totalTokens = normalizeTokenNumber(
    usage.totalTokens ?? usage.total_tokens ?? (inputTokens + outputTokens),
  );
  const cacheInputTokens = normalizeTokenNumber(
    usage.cacheInputTokens
    ?? usage.cachedInputTokens
    ?? usage.cache_input_tokens
    ?? usage.cached_input_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_tokens_details?.cached_tokens,
  );
  if (inputTokens <= 0 && outputTokens <= 0 && totalTokens <= 0 && cacheInputTokens <= 0) return null;
  return { inputTokens, outputTokens, totalTokens, cacheInputTokens };
}

function cloneTurns(turns) {
  return Array.isArray(turns) ? turns.map((turn) => ({ ...turn })) : [];
}

function sumTurnTokenUsage(turns = []) {
  return (Array.isArray(turns) ? turns : []).reduce((acc, turn) => ({
    inputTokens: acc.inputTokens + (Number(turn?.inputTokens) || 0),
    outputTokens: acc.outputTokens + (Number(turn?.outputTokens) || 0),
    totalTokens: acc.totalTokens + (Number(turn?.totalTokens) || 0),
    cacheInputTokens: acc.cacheInputTokens + (Number(turn?.cacheInputTokens) || 0),
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheInputTokens: 0 });
}

function resolveSessionTokenUsage(session, turns = null) {
  const safeTurns = Array.isArray(turns) ? turns : cloneTurns(session?.turns);
  const turnTokenUsage = sumTurnTokenUsage(safeTurns);
  return extractUsageFromMeta(session?.insights?.tokenUsage)
    || extractUsageFromMeta(session?.tokenUsage)
    || (turnTokenUsage.totalTokens > 0 || turnTokenUsage.inputTokens > 0 || turnTokenUsage.outputTokens > 0
      ? turnTokenUsage
      : {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheInputTokens: 0,
        });
}

function scanSessionActivity(messages = []) {
  let hasEdits = false;
  let hasCommits = false;
  let lastToolName = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (String(message?.type || "").toLowerCase() !== "tool_call") continue;
    const content = String(message?.content || "").toLowerCase();
    if (
      content.includes("write") ||
      content.includes("edit") ||
      content.includes("create") ||
      content.includes("replace") ||
      content.includes("patch") ||
      content.includes("append")
    ) {
      hasEdits = true;
    }
    if (content.includes("git commit") || content.includes("git push")) {
      hasCommits = true;
    }
    const toolName = String(message?.meta?.toolName || "").trim();
    if (toolName) lastToolName = toolName;
  }
  return { hasEdits, hasCommits, lastToolName };
}

function normalizeSessionFileCounts(fileCounts) {
  const counts = fileCounts && typeof fileCounts === "object" ? fileCounts : {};
  return {
    openedFiles: Math.max(0, Number(counts.openedFiles) || 0),
    editedFiles: Math.max(0, Number(counts.editedFiles) || 0),
    referencedFiles: Math.max(0, Number(counts.referencedFiles) || 0),
    openOps: Math.max(0, Number(counts.openOps) || 0),
    editOps: Math.max(0, Number(counts.editOps) || 0),
  };
}

function normalizeTopTools(topTools, limit = 5) {
  return (Array.isArray(topTools) ? topTools : [])
    .map((entry) => ({
      name: String(entry?.name || "").trim(),
      count: Math.max(0, Number(entry?.count) || 0),
    }))
    .filter((entry) => entry.name && entry.count > 0)
    .slice(0, limit);
}

function normalizeRecentActions(recentActions, limit = 6) {
  return (Array.isArray(recentActions) ? recentActions : [])
    .map((entry) => ({
      type: String(entry?.type || "").trim() || "event",
      label: String(entry?.label || "").trim(),
      level: String(entry?.level || "info").trim() || "info",
      timestamp: String(entry?.timestamp || "").trim() || null,
    }))
    .filter((entry) => entry.label)
    .slice(0, limit);
}

function normalizeContextWindow(contextWindow, tokenUsage = null) {
  const snapshot = contextWindow && typeof contextWindow === "object" ? contextWindow : {};
  const usedTokens = normalizeTokenNumber(snapshot.usedTokens ?? tokenUsage?.totalTokens ?? 0);
  const totalTokensRaw = Number(snapshot.totalTokens);
  const totalTokens = Number.isFinite(totalTokensRaw) && totalTokensRaw > 0
    ? Math.round(totalTokensRaw)
    : null;
  const percentRaw = Number(snapshot.percent);
  const percent = Number.isFinite(percentRaw)
    ? Math.max(0, Math.min(100, Number(percentRaw.toFixed(1))))
    : (usedTokens > 0 && totalTokens
      ? Math.max(0, Math.min(100, Number(((usedTokens / totalTokens) * 100).toFixed(1))))
      : null);
  return {
    usedTokens,
    totalTokens,
    percent,
  };
}

function getContextPressureLevel(percent) {
  if (!Number.isFinite(Number(percent))) return "unknown";
  const safePercent = Number(percent);
  if (safePercent >= 95) return "critical";
  if (safePercent >= 85) return "high";
  if (safePercent >= 70) return "medium";
  return "low";
}

function normalizeTerminalRuntimeState(lifecycleStatus, { live = false } = {}) {
  const normalizedStatus = String(lifecycleStatus || "").trim() || "unknown";
  if (live) return normalizedStatus;
  if (normalizedStatus === "implementation_done_commit_blocked") return "completed";
  return normalizedStatus;
}

function buildRuntimeHealth(session, progress, telemetry) {
  const live = Boolean(progress && progress.status !== "ended" && progress.status !== "not_found");
  const progressStatus = String(progress?.status || "").trim();
  const lifecycleStatus = String(session?.status || "active").trim() || "active";
  let state = lifecycleStatus;
  if (progressStatus === "stalled") state = "stalled";
  else if (progressStatus === "idle") state = "idle";
  else if (lifecycleStatus === "active" && telemetry.hasCommits) state = "committing";
  else if (lifecycleStatus === "active" && telemetry.hasEdits) state = "editing";
  else if (lifecycleStatus === "active" && (telemetry.toolCalls > 0 || telemetry.toolResults > 0)) state = "working";
  else if (lifecycleStatus === "active") state = "active";
  state = normalizeTerminalRuntimeState(state, { live });

  const reasons = [];
  if (progressStatus === "stalled") reasons.push("stalled");
  else if (progressStatus === "idle") reasons.push("idle");
  if (telemetry.contextPressure === "critical") reasons.push("critical_context");
  else if (telemetry.contextPressure === "high") reasons.push("high_context");
  if (telemetry.errors > 0) reasons.push("errors");
  if (telemetry.hasCommits) reasons.push("commits");
  else if (telemetry.hasEdits) reasons.push("edits");

  let severity = "info";
  if (state === "stalled" || telemetry.contextPressure === "critical") severity = "critical";
  else if (
    state === "idle" ||
    telemetry.contextPressure === "high" ||
    telemetry.errors > 0 ||
    lifecycleStatus.startsWith("blocked_") ||
    lifecycleStatus === "implementation_done_commit_blocked"
  ) {
    severity = "warning";
  }

  return {
    state,
    severity,
    live,
    idleMs: Math.max(0, Number(progress?.idleMs) || 0),
    contextPressure: telemetry.contextPressure,
    contextUsagePercent: telemetry.contextUsagePercent,
    toolCalls: telemetry.toolCalls,
    toolResults: telemetry.toolResults,
    errors: telemetry.errors,
    hasEdits: telemetry.hasEdits,
    hasCommits: telemetry.hasCommits,
    reasons,
  };
}

function buildSessionTelemetry(session, progress = null, turns = null) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const insights = session?.insights && typeof session.insights === "object" ? session.insights : {};
  const totals = insights.totals && typeof insights.totals === "object" ? insights.totals : {};
  const safeTurns = Array.isArray(turns) ? turns : cloneTurns(session?.turns);
  const tokenUsage = resolveSessionTokenUsage(session, safeTurns);
  const contextWindow = normalizeContextWindow(insights.contextWindow, tokenUsage);
  const activity = scanSessionActivity(messages);
  const recentActions = normalizeRecentActions(insights.recentActions, 6);
  const telemetry = {
    totalEvents: Math.max(0, Number(session?.totalEvents) || 0),
    lastEventType: messages.at(-1)?.type || messages.at(-1)?.role || null,
    hasEdits: activity.hasEdits,
    hasCommits: activity.hasCommits,
    toolCalls: Math.max(0, Number(totals.toolCalls) || 0),
    toolResults: Math.max(0, Number(totals.toolResults) || 0),
    errors: Math.max(0, Number(totals.errors) || 0),
    commandExecutions: Math.max(0, Number(totals.commandExecutions) || 0),
    fileCounts: normalizeSessionFileCounts(insights.fileCounts),
    topTools: normalizeTopTools(insights.topTools, 5),
    recentActions,
    contextWindow,
    contextUsagePercent: contextWindow.percent,
    contextPressure: getContextPressureLevel(contextWindow.percent),
    lastToolName: activity.lastToolName,
    lastActionAt: recentActions[0]?.timestamp || session?.lastActiveAt || null,
  };
  telemetry.runtimeHealth = buildRuntimeHealth(session, progress, telemetry);
  return telemetry;
}

function buildSessionSummaryRecord(session, { progress = null, preview = null, runtimeUpdatedAt = null, runtimeIsLive = null } = {}) {
  const s = session;
  const sessionId = session?.id || session?.taskId;
  const turns = Array.isArray(session?.turns)
    ? cloneTurns(session.turns)
    : (Array.isArray(session?.insights?.turnTimeline)
      ? cloneTurns(session.insights.turnTimeline)
      : []);
  const effectiveTokenUsage = resolveSessionTokenUsage(session, turns);
  const telemetry = buildSessionTelemetry(session, progress, turns);
  const lastActiveAt = String(
    session?.lastActiveAt
      || runtimeUpdatedAt
      || (session?.lastActivityAt ? new Date(session.lastActivityAt).toISOString() : "")
      || new Date(session?.startedAt || Date.now()).toISOString(),
  ).trim();
  const lifecycleStatus = String(session?.status || "active").trim() || "active";
  const derivedRuntimeState = String(
    telemetry?.runtimeHealth?.state || "",
  ).trim() || null;
  const progressStatus = String(progress?.status || "").trim() || null;
  const runtimeState = (() => {
    if (!progressStatus) return derivedRuntimeState;
    if (progressStatus === "ended" || progressStatus === "not_found") {
      return derivedRuntimeState || progressStatus;
    }
    if (progressStatus === "idle" || progressStatus === "stalled") {
      return progressStatus;
    }
    return derivedRuntimeState || progressStatus;
  })();
  const isLive = runtimeIsLive == null
    ? Boolean(progress && progress.status === "active")
    : Boolean(runtimeIsLive);
  const status = progressStatus === "ended"
    ? lifecycleStatus
    : (runtimeState || lifecycleStatus);
  const normalizedPreview = preview == null ? null : String(preview || "").trim() || null;

  return {
    id: sessionId,
    taskId: session?.taskId || sessionId,
    title: session?.taskTitle || session?.title || null,
    type: session?.type || "task",
    status,
    lifecycleStatus,
    runtimeState,
    runtimeUpdatedAt: lastActiveAt,
    runtimeIsLive: isLive,
    workspaceId: String(s?.metadata?.workspaceId || "").trim() || null,
    workspaceDir: String(s?.metadata?.workspaceDir || "").trim() || null,
    workspaceRoot: String(s?.metadata?.workspaceRoot || "").trim() || null,
    branch: String(session?.metadata?.branch || "").trim() || null,
    workflowId: String(session?.metadata?.workflowId || "").trim() || null,
    workflowName: String(session?.metadata?.workflowName || "").trim() || null,
    rootTaskId: String(session?.metadata?.rootTaskId || "").trim() || null,
    parentTaskId: String(session?.metadata?.parentTaskId || "").trim() || null,
    rootSessionId: String(session?.metadata?.rootSessionId || "").trim() || null,
    parentSessionId: String(session?.metadata?.parentSessionId || "").trim() || null,
    rootRunId: String(session?.metadata?.rootRunId || "").trim() || null,
    parentRunId: String(session?.metadata?.parentRunId || "").trim() || null,
    delegationDepth: Number.isFinite(Number(session?.metadata?.delegationDepth))
      ? Math.max(0, Math.trunc(Number(session.metadata.delegationDepth)))
      : 0,
    turnCount: Math.max(0, Number(session?.turnCount) || 0),
    turns,
    tokenCount: effectiveTokenUsage.totalTokens || 0,
    inputTokens: effectiveTokenUsage.inputTokens || 0,
    outputTokens: effectiveTokenUsage.outputTokens || 0,
    cacheInputTokens: effectiveTokenUsage.cacheInputTokens || 0,
    tokenUsage: effectiveTokenUsage,
    createdAt: session?.createdAt || new Date(session?.startedAt || Date.now()).toISOString(),
    lastActiveAt,
    idleMs: progress?.idleMs ?? 0,
    elapsedMs: progress?.elapsedMs ?? Math.max(
      0,
      Number(session?.endedAt || Date.now()) - Number(session?.startedAt || Date.now()),
    ),
    recommendation: progress?.recommendation || "none",
    preview: normalizedPreview,
    lastMessage: normalizedPreview,
    totalTokens: effectiveTokenUsage.totalTokens || 0,
    insights: session?.insights || null,
    ...telemetry,
  };
}

function buildLightweightSessionSummaryRecord(
  session,
  { progress = null, preview = null, runtimeUpdatedAt = null, runtimeIsLive = null } = {},
) {
  const s = session;
  const sessionId = session?.id || session?.taskId;
  const turns = Array.isArray(session?.turns)
    ? cloneTurns(session.turns)
    : (Array.isArray(session?.insights?.turnTimeline)
      ? cloneTurns(session.insights.turnTimeline)
      : []);
  const lastActiveAt = String(
    session?.lastActiveAt
      || runtimeUpdatedAt
      || (session?.lastActivityAt ? new Date(session.lastActivityAt).toISOString() : "")
      || new Date(session?.startedAt || Date.now()).toISOString(),
  ).trim();
  const lifecycleStatus = String(session?.status || "active").trim() || "active";
  const progressStatus = String(progress?.status || "").trim() || null;
  const runtimeState = (() => {
    if (!progressStatus || progressStatus === "ended" || progressStatus === "not_found") {
      return null;
    }
    return progressStatus;
  })();
  const isLive = runtimeIsLive == null
    ? Boolean(progress && progress.status === "active")
    : Boolean(runtimeIsLive);
  const status = progressStatus === "ended"
    ? lifecycleStatus
    : (runtimeState || lifecycleStatus);
  const normalizedPreview = preview == null ? null : String(preview || "").trim() || null;
  const turnCount = Math.max(
    0,
    Number(session?.turnCount) || 0,
    turns.length,
  );
  const totalEvents = Math.max(
    0,
    Number(session?.totalEvents ?? session?.eventCount ?? 0) || 0,
  );
  const tokenUsage =
    resolveSessionTokenUsage(
      session,
      Array.isArray(session?.turns)
        ? cloneTurns(session.turns)
        : (Array.isArray(session?.insights?.turnTimeline)
          ? cloneTurns(session.insights.turnTimeline)
          : []),
    )
    || (session?.tokenUsage && typeof session.tokenUsage === "object"
      ? session.tokenUsage
      : {});

  return {
    id: sessionId,
    taskId: session?.taskId || sessionId,
    title: session?.taskTitle || session?.title || null,
    type: session?.type || "task",
    status,
    lifecycleStatus,
    runtimeState,
    runtimeUpdatedAt: lastActiveAt,
    runtimeIsLive: isLive,
    workspaceId: String(s?.metadata?.workspaceId || "").trim() || null,
    workspaceDir: String(s?.metadata?.workspaceDir || "").trim() || null,
    workspaceRoot: String(s?.metadata?.workspaceRoot || "").trim() || null,
    branch: String(session?.metadata?.branch || "").trim() || null,
    workflowId: String(session?.metadata?.workflowId || "").trim() || null,
    workflowName: String(session?.metadata?.workflowName || "").trim() || null,
    rootTaskId: String(session?.metadata?.rootTaskId || "").trim() || null,
    parentTaskId: String(session?.metadata?.parentTaskId || "").trim() || null,
    rootSessionId: String(session?.metadata?.rootSessionId || "").trim() || null,
    parentSessionId: String(session?.metadata?.parentSessionId || "").trim() || null,
    rootRunId: String(session?.metadata?.rootRunId || "").trim() || null,
    parentRunId: String(session?.metadata?.parentRunId || "").trim() || null,
    delegationDepth: Number.isFinite(Number(session?.metadata?.delegationDepth))
      ? Math.max(0, Math.trunc(Number(session.metadata.delegationDepth)))
      : 0,
    turnCount,
    turns,
    tokenCount: Number(session?.tokenCount ?? tokenUsage.totalTokens ?? session?.totalTokens ?? 0) || 0,
    inputTokens: Number(session?.inputTokens ?? tokenUsage.inputTokens ?? 0) || 0,
    outputTokens: Number(session?.outputTokens ?? tokenUsage.outputTokens ?? 0) || 0,
    cacheInputTokens: Number(session?.cacheInputTokens ?? tokenUsage.cacheInputTokens ?? 0) || 0,
    tokenUsage: {
      totalTokens: Number(session?.tokenCount ?? tokenUsage.totalTokens ?? session?.totalTokens ?? 0) || 0,
      inputTokens: Number(session?.inputTokens ?? tokenUsage.inputTokens ?? 0) || 0,
      outputTokens: Number(session?.outputTokens ?? tokenUsage.outputTokens ?? 0) || 0,
      cacheInputTokens: Number(session?.cacheInputTokens ?? tokenUsage.cacheInputTokens ?? 0) || 0,
    },
    createdAt: session?.createdAt || new Date(session?.startedAt || Date.now()).toISOString(),
    lastActiveAt,
    idleMs: progress?.idleMs ?? 0,
    elapsedMs: progress?.elapsedMs ?? Math.max(
      0,
      Number(session?.endedAt || Date.now()) - Number(session?.startedAt || Date.now()),
    ),
    recommendation: progress?.recommendation || "none",
    preview: normalizedPreview,
    lastMessage: normalizedPreview,
    totalTokens: Number(session?.totalTokens ?? tokenUsage.totalTokens ?? session?.tokenCount ?? 0) || 0,
    totalEvents,
    eventCount: totalEvents,
    insights: session?.insights || null,
    metadata:
      session?.metadata && typeof session.metadata === "object"
        ? { ...session.metadata }
        : {},
  };
}

function cloneSessionMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({ ...message }));
}

function buildStateLedgerSessionRecord(session) {
  if (!session) return null;
  const preview = getSessionMessageText(session.messages?.at(-1)) || null;
  const summary = buildSessionSummaryRecord(session, {
    preview,
    runtimeUpdatedAt: session.lastActiveAt || new Date(session.lastActivityAt || Date.now()).toISOString(),
    runtimeIsLive: session.status === "active",
  });
  return {
    sessionId: summary.id,
    sessionType: summary.type,
    workspaceId: summary.workspaceId,
    agentId: String(session?.metadata?.agentId || session?.metadata?.agent || "").trim() || null,
    taskId: summary.taskId,
    taskTitle: summary.title,
    workflowId: summary.workflowId,
    workflowName: summary.workflowName,
    latestEventType: summary.lastEventType,
    status: summary.lifecycleStatus || summary.status,
    updatedAt: summary.lastActiveAt,
    startedAt: session.startedAt || summary.createdAt,
    eventCount: Math.max(0, Number(session.totalEvents) || 0),
    preview,
    document: {
      ...summary,
      sessionId: summary.id,
      sessionKey: session.sessionKey || null,
      metadata: session.metadata || {},
      createdAt: session.createdAt || summary.createdAt,
      startedAt: session.startedAt || null,
      endedAt: session.endedAt || null,
      lastActiveAt: summary.lastActiveAt,
      totalEvents: Math.max(0, Number(session.totalEvents) || 0),
      eventCount: Math.max(0, Number(session.totalEvents) || 0),
      turnCount: Math.max(0, Number(session.turnCount) || 0),
      turns: cloneTurns(session.turns),
      messages: cloneSessionMessages(session.messages),
      trajectory: session.trajectory || null,
      summary: session.summary || null,
      updatedAt: summary.lastActiveAt,
    },
  };
}

function mergeSessionLedgerRecordWithExisting(record, existingActivity) {
  if (!record || !existingActivity || typeof existingActivity !== "object") {
    return record;
  }
  const currentDoc = record.document && typeof record.document === "object" ? record.document : {};
  const existingDoc = existingActivity.document && typeof existingActivity.document === "object"
    ? existingActivity.document
    : {};
  const currentMeta = currentDoc.metadata && typeof currentDoc.metadata === "object" ? currentDoc.metadata : {};
  const existingMeta = existingDoc.metadata && typeof existingDoc.metadata === "object" ? existingDoc.metadata : {};
  const pickString = (...values) => {
    for (const value of values) {
      const normalized = String(value || "").trim();
      if (normalized) return normalized;
    }
    return null;
  };
  const pickArray = (currentValue, fallbackValue) => {
    if (Array.isArray(currentValue) && currentValue.length > 0) {
      return currentValue.map((entry) => ({ ...entry }));
    }
    if (Array.isArray(fallbackValue) && fallbackValue.length > 0) {
      return fallbackValue.map((entry) => ({ ...entry }));
    }
    return Array.isArray(currentValue) ? [] : currentValue;
  };
  const currentStatus = String(record.status || currentDoc.lifecycleStatus || currentDoc.status || "").trim().toLowerCase();
  const existingStatus = String(existingActivity.latestStatus || existingDoc.lifecycleStatus || existingDoc.status || "").trim().toLowerCase();
  const currentIsLiveShell = currentStatus === "active" && (!currentDoc.messages || currentDoc.messages.length === 0);
  const existingIsDurable = Boolean(existingDoc.taskId || existingDoc.title || existingDoc.taskTitle || existingStatus && existingStatus !== "active");
  const preferExistingIdentity = existingIsDurable && currentIsLiveShell;
  const document = {
    ...existingDoc,
    ...currentDoc,
    taskId: preferExistingIdentity
      ? pickString(existingDoc.taskId, currentDoc.taskId)
      : pickString(currentDoc.taskId, existingDoc.taskId),
    taskTitle: preferExistingIdentity
      ? pickString(existingDoc.taskTitle, existingDoc.title, currentDoc.taskTitle, currentDoc.title)
      : pickString(currentDoc.taskTitle, currentDoc.title, existingDoc.taskTitle, existingDoc.title),
    title: preferExistingIdentity
      ? pickString(existingDoc.title, existingDoc.taskTitle, currentDoc.title, currentDoc.taskTitle)
      : pickString(currentDoc.title, currentDoc.taskTitle, existingDoc.title, existingDoc.taskTitle),
    workspaceId: pickString(currentDoc.workspaceId, existingDoc.workspaceId, existingMeta.workspaceId),
    workspaceDir: pickString(currentDoc.workspaceDir, existingDoc.workspaceDir, existingMeta.workspaceDir),
    workspaceRoot: pickString(currentDoc.workspaceRoot, existingDoc.workspaceRoot, existingMeta.workspaceRoot),
    preview: pickString(currentDoc.preview, currentDoc.lastMessage, existingDoc.preview, existingDoc.lastMessage),
    lastMessage: pickString(currentDoc.lastMessage, currentDoc.preview, existingDoc.lastMessage, existingDoc.preview),
    turns: pickArray(currentDoc.turns, existingDoc.turns),
    messages: pickArray(currentDoc.messages, existingDoc.messages),
    trajectory: currentDoc.trajectory || existingDoc.trajectory || null,
    summary: currentDoc.summary || existingDoc.summary || null,
    metadata: {
      ...existingMeta,
      ...currentMeta,
      ...(pickString(currentMeta.workspaceId, existingMeta.workspaceId, existingDoc.workspaceId) ? { workspaceId: pickString(currentMeta.workspaceId, existingMeta.workspaceId, existingDoc.workspaceId) } : {}),
      ...(pickString(currentMeta.workspaceDir, existingMeta.workspaceDir, existingDoc.workspaceDir) ? { workspaceDir: pickString(currentMeta.workspaceDir, existingMeta.workspaceDir, existingDoc.workspaceDir) } : {}),
      ...(pickString(currentMeta.workspaceRoot, existingMeta.workspaceRoot, existingDoc.workspaceRoot) ? { workspaceRoot: pickString(currentMeta.workspaceRoot, existingMeta.workspaceRoot, existingDoc.workspaceRoot) } : {}),
    },
  };
  return {
    ...existingActivity,
    ...record,
    workspaceId: pickString(record.workspaceId, existingActivity.workspaceId, document.workspaceId, document.metadata?.workspaceId),
    taskId: preferExistingIdentity
      ? pickString(existingActivity.latestTaskId, document.taskId, record.taskId)
      : pickString(record.taskId, existingActivity.latestTaskId, document.taskId),
    taskTitle: preferExistingIdentity
      ? pickString(existingActivity.latestTaskTitle, document.taskTitle, document.title, record.taskTitle)
      : pickString(record.taskTitle, existingActivity.latestTaskTitle, document.taskTitle, document.title),
    preview: pickString(record.preview, existingDoc.preview, document.preview),
    status: preferExistingIdentity
      ? pickString(existingActivity.latestStatus, existingDoc.lifecycleStatus, existingDoc.status, record.status)
      : pickString(record.status, existingActivity.latestStatus, currentDoc.lifecycleStatus, currentDoc.status),
    document,
  };
}

function persistSessionRecordToStateLedger(session) {
  const record = buildStateLedgerSessionRecord(session);
  if (!record) return;
  const ledgerOptions = resolveSessionLedgerPersistenceOptions();
  try {
    const existing = getSessionActivityFromStateLedger(record.sessionId, ledgerOptions);
    upsertSessionRecordToStateLedger(
      mergeSessionLedgerRecordWithExisting(record, existing),
      ledgerOptions,
    );
  } catch {
    // Best-effort persistence — session tracking should continue even if the
    // durable index is temporarily unavailable.
  }
}

function resolveSessionLedgerPersistenceOptions() {
  const explicitLedgerPath = String(process.env.BOSUN_STATE_LEDGER_PATH || "").trim();
  const explicitRepoRoot = String(process.env.REPO_ROOT || "").trim();
  return explicitRepoRoot
    ? { repoRoot: resolve(explicitRepoRoot) }
    : explicitLedgerPath && isTestRuntime()
      ? { ledgerPath: explicitLedgerPath }
      : { repoRoot: SESSION_TRACKER_REPO_ROOT };
}

function deleteSessionRecordFromDurableLedger(sessionId) {
  try {
    deleteSessionRecordFromStateLedger(sessionId, resolveSessionLedgerPersistenceOptions());
  } catch {
    // Best-effort persistence — session tracking should continue even if the
    // durable index is temporarily unavailable.
  }
}

function ensureSessionTurns(session) {
  if (!Array.isArray(session.turns)) session.turns = [];
  return session.turns;
}

function getOrCreateTurnEntry(session, turnIndex, timestamp) {
  const turns = ensureSessionTurns(session);
  const safeTurnIndex = Number.isFinite(Number(turnIndex)) ? Number(turnIndex) : Math.max(0, turns.length);
  let entry = turns.find((turn) => turn?.turnIndex === safeTurnIndex);
  if (!entry) {
    entry = {
      turnIndex: safeTurnIndex,
      startedAt: timestamp,
      endedAt: timestamp,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      userMessageId: null,
      assistantMessageId: null,
      status: "pending",
    };
    turns.push(entry);
    turns.sort((a, b) => Number(a?.turnIndex || 0) - Number(b?.turnIndex || 0));
  }
  return entry;
}

function updateTurnTimeline(session, msg) {
  if (!session || !msg) return;
  const timestampMs = parseTimestampMs(msg.timestamp, session.lastActivityAt || Date.now());
  const derivedTurnIndex = Number.isFinite(Number(msg.turnIndex))
    ? Number(msg.turnIndex)
    : Math.max(0, Number(session.turnCount || 0) - (String(msg.role || "").toLowerCase() === "assistant" ? 1 : 0));
  const turnIndex = derivedTurnIndex;
  const turn = getOrCreateTurnEntry(session, turnIndex, timestampMs);
  turn.startedAt = Math.min(Number(turn.startedAt || timestampMs), timestampMs);
  turn.endedAt = Math.max(Number(turn.endedAt || timestampMs), timestampMs);

  const role = String(msg.role || "").toLowerCase();
  if (role === "user") {
    turn.userMessageId = msg.id || turn.userMessageId;
    turn.startedAt = timestampMs;
    if (turn.status === "pending") turn.status = "in_progress";
  }
  if (role === "assistant") {
    turn.assistantMessageId = msg.id || turn.assistantMessageId;
    turn.endedAt = timestampMs;
    turn.status = "completed";
  }

  const usage = extractUsageFromMeta(msg.meta);
  if (usage) {
    turn.inputTokens = Math.max(turn.inputTokens || 0, usage.inputTokens || 0);
    turn.outputTokens = Math.max(turn.outputTokens || 0, usage.outputTokens || 0);
    turn.totalTokens = Math.max(turn.totalTokens || 0, usage.totalTokens || 0);
    turn.cacheInputTokens = Math.max(turn.cacheInputTokens || 0, usage.cacheInputTokens || 0);
    if (!session.insights || typeof session.insights !== "object") {
      session.insights = {};
    }
    const priorUsage = extractUsageFromMeta(session.insights.tokenUsage) || {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheInputTokens: 0,
    };
    session.insights.tokenUsage = {
      inputTokens: Math.max(priorUsage.inputTokens, usage.inputTokens || 0),
      outputTokens: Math.max(priorUsage.outputTokens, usage.outputTokens || 0),
      totalTokens: Math.max(priorUsage.totalTokens, usage.totalTokens || 0),
      cacheInputTokens: Math.max(priorUsage.cacheInputTokens, usage.cacheInputTokens || 0),
    };
  }
  turn.durationMs = Math.max(0, Number(turn.endedAt || timestampMs) - Number(turn.startedAt || timestampMs));
  const derivedInsights = buildSessionInsights({
    ...session,
    insights: null,
    messages: Array.isArray(session.messages) ? session.messages : [],
  });
  session.insights = {
    ...(session.insights && typeof session.insights === "object" ? session.insights : {}),
    ...derivedInsights,
    turnTimeline: derivedInsights.turnTimeline,
    turns: derivedInsights.turns,
  };
}

/** Debounce interval for disk writes (ms). */
const FLUSH_INTERVAL_MS = 2000;
const DERIVED_STATE_REFRESH_MS = 250;
const PERSISTED_SESSION_LIST_CACHE_TTL_MS = 5000;

const SESSION_EVENT_LISTENERS = new Set();
const SESSION_STATE_LISTENERS = new Set();

export function addSessionEventListener(listener) {
  if (typeof listener !== "function") return () => {};
  SESSION_EVENT_LISTENERS.add(listener);
  return () => SESSION_EVENT_LISTENERS.delete(listener);
}

export function addSessionStateListener(listener) {
  if (typeof listener !== "function") return () => {};
  SESSION_STATE_LISTENERS.add(listener);
  return () => SESSION_STATE_LISTENERS.delete(listener);
}

function emitSessionEvent(session, message) {
  if (!session || !message || SESSION_EVENT_LISTENERS.size === 0) return;
  const summary = buildSessionSummaryRecord(session, {
    preview: getSessionMessageText(message) || null,
    runtimeUpdatedAt: session.lastActiveAt || new Date().toISOString(),
    runtimeIsLive: session.status === "active",
  });
  const payload = {
    sessionId: session.id || session.taskId,
    taskId: session.taskId || session.id,
    message,
    session: summary,
  };
  for (const listener of SESSION_EVENT_LISTENERS) {
    try {
      listener(payload);
    } catch {
      // best-effort listeners
    }
  }
}

function buildSessionTelemetryEvent(session, eventType, payload = {}, message = null) {
  const tokenUsage = message?.meta?.usage && typeof message.meta.usage === "object"
    ? {
        inputTokens: Number(message.meta.usage.inputTokens || message.meta.usage.promptTokens || 0),
        outputTokens: Number(message.meta.usage.outputTokens || message.meta.usage.completionTokens || 0),
        totalTokens: Number(message.meta.usage.totalTokens || 0),
        cacheInputTokens: Number(
          message.meta.usage.cacheInputTokens
          || message.meta.usage.cachedInputTokens
          || message.meta.usage.prompt_tokens_details?.cached_tokens
          || 0,
        ),
      }
    : null;
  return {
    timestamp: payload.timestamp || message?.timestamp || session?.lastActiveAt || new Date().toISOString(),
    eventType,
    type: eventType,
    source: "session-tracker",
    category: "session",
    taskId: session?.taskId || session?.id,
    sessionId: session?.id || session?.taskId,
    runId: session?.metadata?.rootRunId || session?.metadata?.taskSessionId || null,
    rootRunId: session?.metadata?.rootRunId || null,
    parentRunId: session?.metadata?.parentRunId || null,
    workflowId: session?.metadata?.workflowId || null,
    workflowName: session?.metadata?.workflowName || null,
    threadId: session?.metadata?.threadId || session?.metadata?.activeThreadId || null,
    providerId: session?.metadata?.providerId || session?.executor || null,
    modelId: session?.model || session?.metadata?.modelId || null,
    toolId: message?.name || payload.toolId || null,
    toolName: message?.name || payload.toolName || null,
    approvalId: payload.approvalId || null,
    actor: payload.actor || session?.metadata?.agentId || session?.type || "session",
    status: payload.status || session?.status || null,
    retryCount: payload.retryCount || null,
    tokenUsage,
    summary: payload.summary || message?.content || session?.taskTitle || null,
    reason: payload.reason || null,
    message: message?.content || null,
    payload: {
      messageType: message?.type || null,
      role: message?.role || null,
      status: payload.status || session?.status || null,
      eventCount: Number(session?.totalEvents || 0),
    },
    meta: {
      source: "session-tracker",
      workspaceId: session?.metadata?.workspaceId || null,
      workspaceDir: session?.metadata?.workspaceDir || null,
      branch: session?.metadata?.branch || null,
    },
  };
}

function emitSessionStateEvent(session, reason, extra = {}) {
  if (!session || SESSION_STATE_LISTENERS.size === 0) return;
  const normalizedReason = String(reason || "updated").trim() || "updated";
  const summary = buildSessionSummaryRecord(session, {
    preview: getSessionMessageText(session.messages?.at(-1)) || null,
    runtimeUpdatedAt: session.lastActiveAt || new Date().toISOString(),
    runtimeIsLive: session.status === "active",
  });
  const payload = {
    sessionId: session.id || session.taskId,
    taskId: session.taskId || session.id,
    reason: normalizedReason,
    session: summary,
    event: {
      kind: "state",
      reason: normalizedReason,
      ...extra,
    },
  };
  for (const listener of SESSION_STATE_LISTENERS) {
    try {
      listener(payload);
    } catch {
      // best-effort listeners
    }
  }
}

// ── SessionTracker Class ────────────────────────────────────────────────────

export class SessionTracker {
  /** @type {Map<string, SessionRecord>} taskId → session record */
  #sessions = new Map();

  /** @type {number} */
  #maxMessages;

  /** @type {number} idle threshold (ms) — 2 minutes without events = idle */
  #idleThresholdMs;

  /** @type {string|null} directory for session JSON files */
  #persistDir;

  /** @type {Set<string>} session IDs with pending disk writes */
  #dirty = new Set();

  /** @type {Map<string, number>} recently retired session IDs suppressed from auto-recreation */
  #retiredSessions = new Map();

  /** @type {{ loadedAt: number, sessions: Array<Object> }} */
  #persistedSummaryCache = { loadedAt: 0, sessions: [] };

  /** @type {Set<string>} persisted sessions already rebuilt into sqlite */
  #backfilledSessionIds = new Set();

  /** @type {ReturnType<typeof setInterval>|null} */
  #flushTimer = null;

  /** @type {ReturnType<typeof setInterval>|null} */
  #reaperTimer = null;

  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  #derivedRefreshTimers = new Map();

  /**
   * @param {Object} [options]
   * @param {number} [options.maxMessages=10]
   * @param {number} [options.idleThresholdMs=120000]
   * @param {string|null} [options.persistDir] — null disables persistence
   */
  constructor(options = {}) {
    this.#maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.#idleThresholdMs = options.idleThresholdMs ?? 180_000; // 3 minutes — gives agents breathing room
    this.#persistDir = options.persistDir !== undefined ? options.persistDir : null;

    if (this.#persistDir) {
      this.#ensureDir();
      this.#loadFromDisk();
      this.#flushTimer = setInterval(() => this.#flushDirty(), FLUSH_INTERVAL_MS);
      if (this.#flushTimer.unref) this.#flushTimer.unref();
    }

    // Idle reaper — runs periodically to mark stale "active" sessions as "completed"
    const reaperInterval = Math.max(60_000, this.#idleThresholdMs);
    this.#reaperTimer = setInterval(() => this.#reapIdleSessions(), reaperInterval);
    if (this.#reaperTimer.unref) this.#reaperTimer.unref();
  }

  /**
   * Start tracking a new session for a task.
   * If a session already exists, it's replaced.
   *
   * @param {string} taskId
   * @param {string} taskTitle
   */
  startSession(taskId, taskTitle) {
    // Evict oldest sessions if at capacity
    if (this.#sessions.size >= MAX_SESSIONS && !this.#sessions.has(taskId)) {
      this.#evictOldest();
    }

    this.#sessions.set(taskId, {
      taskId,
      taskTitle,
      id: taskId,
      sessionKey: `${taskId}:${Date.now()}:${randomToken(8)}`,
      type: "task",
      maxMessages: this.#maxMessages,
      startedAt: Date.now(),
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      endedAt: null,
      messages: [],
      totalEvents: 0,
      turnCount: 0,
      turns: [],
      status: "active",
      accumulatedAt: null,
      lastActivityAt: Date.now(),
      metadata: {},
      insights: buildSessionInsights({ messages: [] }),
      trajectory: { version: 1, replayable: true, steps: [] },
      summary: null,
    });
    const session = this.#sessions.get(taskId);
    this.#markDirty(taskId);
    recordHarnessTelemetryEvent(buildSessionTelemetryEvent(session, "session.started", {
      summary: taskTitle || taskId,
      status: session.status,
    }));
    emitSessionStateEvent(session, "session-created", { title: taskTitle || taskId });
  }

  /**
   * Record an agent SDK event for a task session.
   * Call this from the `onEvent` callback inside `execWithRetry`.
   *
   * Normalizes events from all 3 SDKs:
   * - Codex: { type: "item.completed"|"item.created", item: {...} }
   * - Copilot: { type: "message"|"tool_call"|"tool_result", ... }
   * - Claude: { type: "content_block_delta"|"message_stop", ... }
   *
   * Also supports direct message objects: { role, content, timestamp, turnIndex }
   *
   * Auto-creates sessions for unknown taskIds when the event carries enough info.
   *
   * @param {string} taskId
   * @param {Object} event - Raw SDK event or direct message object
   */
  recordEvent(taskId, event) {
    let session = this.#sessions.get(taskId);

    // Auto-create session if it doesn't exist yet
    if (!session) {
      this.getSessionMessages(taskId);
      session = this.#sessions.get(taskId);
    }
    if (!session) {
      if (this.#isSessionRetired(taskId)) return;
      if (event && (event.role || event.type)) {
        this.#autoCreateSession(taskId, event);
        session = this.#sessions.get(taskId);
      }
      if (!session) return;
    }

    const maxMessages =
      session.maxMessages === null || session.maxMessages === undefined
        ? this.#maxMessages
        : session.maxMessages;
    const markActivity = () => {
      session.totalEvents++;
      session.lastActivityAt = Date.now();
      session.lastActiveAt = new Date().toISOString();
    };

    if (typeof event === "string" && event.trim()) {
      markActivity();
      const msg = {
        type: "system",
        content: event.trim().slice(0, MAX_MESSAGE_CHARS),
        timestamp: new Date().toISOString(),
      };
      session.messages.push(msg);
      updateTurnTimeline(session, msg);
      if (Number.isFinite(maxMessages) && maxMessages > 0) {
        while (session.messages.length > maxMessages) session.messages.shift();
      }
      this.#appendTrajectoryStep(session, event);
      this.#scheduleDerivedStateRefresh(session);
      this.#markDirty(taskId);
      persistSessionRecordToStateLedger(session);
      recordHarnessTelemetryEvent(buildSessionTelemetryEvent(session, "session.event", {}, msg));
      emitSessionEvent(session, msg);
      return;
    }

    // Direct message format (role/content)
    if (event && event.role && event.content !== undefined) {
      markActivity();
      const role = String(event.role || "").toLowerCase();
      const isAssistantTurn = role === "assistant";
      const msg = {
        id: event.id || `msg-${Date.now()}-${randomToken(6)}`,
        type: event.type || undefined,
        role: event.role,
        content: String(event.content).slice(0, MAX_MESSAGE_CHARS),
        timestamp: event.timestamp || new Date().toISOString(),
        turnIndex: event.turnIndex ?? session.turnCount,
        attachments: Array.isArray(event.attachments) ? event.attachments : undefined,
        meta:
          event.meta && typeof event.meta === "object"
            ? { ...event.meta }
            : undefined,
        _compressed: event._compressed || undefined,
        _originalLength:
          Number.isFinite(Number(event._originalLength))
            ? Number(event._originalLength)
            : undefined,
        _cachedLogId: event._cachedLogId || undefined,
      };
      if (isAssistantTurn) {
        session.turnCount += 1;
      }
      session.messages.push(msg);
      updateTurnTimeline(session, msg);
      if (Number.isFinite(maxMessages) && maxMessages > 0) {
        while (session.messages.length > maxMessages) session.messages.shift();
      }
      this.#appendTrajectoryStep(session, event);
      this.#scheduleDerivedStateRefresh(session);
      this.#markDirty(taskId);
      persistSessionRecordToStateLedger(session);
      recordHarnessTelemetryEvent(buildSessionTelemetryEvent(session, "session.message", {}, msg));
      emitSessionEvent(session, msg);
      return;
    }

    const msg = this.#normalizeEvent(event);
    if (msg && !Number.isFinite(Number(msg.turnIndex))) {
      msg.turnIndex = session.turnCount || 0;
    }
    if (!msg) {
      return; // Ignore low-signal events that should not mask idle/stalled sessions
    }

    markActivity();
    // Push to ring buffer (keep only last N)
    session.messages.push(msg);
    updateTurnTimeline(session, msg);
    if (Number.isFinite(maxMessages) && maxMessages > 0) {
      while (session.messages.length > maxMessages) session.messages.shift();
    }
    this.#appendTrajectoryStep(session, event);
    this.#scheduleDerivedStateRefresh(session);
    this.#markDirty(taskId);
    persistSessionRecordToStateLedger(session);
    recordHarnessTelemetryEvent(buildSessionTelemetryEvent(session, "session.activity", {}, msg));
    emitSessionEvent(session, msg);
  }

  /**
   * Backward-compatible alias for older callers/tests.
   * @param {string} taskId
   * @param {Object|string} event
   */
  appendEvent(taskId, event) {
    return this.recordEvent(taskId, event);
  }

  /**
   * Mark a session as completed.
   * @param {string} taskId
   * @param {string} [status="completed"]
   */
  endSession(taskId, status = "completed") {
    const session = this.#sessions.get(taskId);
    if (!session) return;

    session.endedAt = Date.now();
    session.status = deriveTerminalSessionStatus(session, status);
    this.#scheduleDerivedStateRefresh(session, { force: true });
    this.#accumulateCompletedSession(session, taskId);
    this.#markDirty(taskId);
    this.#flushDirty();
    persistSessionRecordToStateLedger(session);
    recordHarnessTelemetryEvent(buildSessionTelemetryEvent(session, "session.ended", {
      status: session.status,
      reason: "session-ended",
    }));
    emitSessionStateEvent(session, "session-ended", { status: session.status });
  }

  /**
   * Get the last N messages for a task session.
   * @param {string} taskId
   * @param {number} [n] - defaults to maxMessages
   * @returns {SessionMessage[]}
   */
  getLastMessages(taskId, n) {
    const session = this.#sessions.get(taskId);
    if (!session) return [];
    const count = n ?? this.#maxMessages;
    return session.messages.slice(-count);
  }

  /**
   * Get a formatted summary of the last N messages.
   * This is the string that gets passed to the review agent.
   *
   * @param {string} taskId
   * @param {number} [n]
   * @returns {string}
   */
  getMessageSummary(taskId, n) {
    const messages = this.getLastMessages(taskId, n);
    if (messages.length === 0) return "(no session messages recorded)";

    const session = this.#sessions.get(taskId);
    const header = [
      `Session: ${session?.taskTitle || taskId}`,
      `Total events: ${session?.totalEvents ?? 0}`,
      `Duration: ${session ? Math.round((Date.now() - session.startedAt) / 1000) : 0}s`,
      `Status: ${session?.status ?? "unknown"}`,
      `--- Last ${messages.length} messages ---`,
    ].join("\n");

    const lines = messages.map((msg) => {
      const ts = new Date(msg.timestamp).toISOString().slice(11, 19);
      const prefix = this.#typePrefix(msg.type || msg.role || "unknown");
      const meta = msg.meta?.toolName ? ` [${msg.meta.toolName}]` : "";
      return `[${ts}] ${prefix}${meta}: ${msg.content}`;
    });

    return `${header}\n${lines.join("\n")}`;
  }

  /**
   * Check if a session appears to be idle (no events for > idleThreshold).
   * @param {string} taskId
   * @returns {boolean}
   */
  isSessionIdle(taskId) {
    const session = this.#sessions.get(taskId);
    if (!session || session.status !== "active") return false;
    return Date.now() - session.lastActivityAt > this.#idleThresholdMs;
  }

  /**
   * Get detailed progress status for a running session.
   * Returns a structured assessment of agent progress suitable for mid-execution monitoring.
   *
   * @param {string} taskId
   * @returns {{ status: "active"|"idle"|"stalled"|"not_found"|"ended", idleMs: number, totalEvents: number, lastEventType: string|null, hasEdits: boolean, hasCommits: boolean, elapsedMs: number, recommendation: "none"|"continue"|"nudge"|"abort" }}
   */
  getProgressStatus(taskId) {
    const session = this.#sessions.get(taskId);
    if (!session) {
      return {
        status: "not_found", idleMs: 0, totalEvents: 0,
        lastEventType: null, hasEdits: false, hasCommits: false,
        elapsedMs: 0, recommendation: "none",
      };
    }

    if (session.status !== "active") {
      return {
        status: "ended", idleMs: 0, totalEvents: session.totalEvents,
        lastEventType: session.messages.at(-1)?.type ?? null,
        hasEdits: false, hasCommits: false,
        elapsedMs: (session.endedAt || Date.now()) - session.startedAt,
        recommendation: "none",
      };
    }

    const now = Date.now();
    const idleMs = now - session.lastActivityAt;
    const elapsedMs = now - session.startedAt;
    const activity = scanSessionActivity(session.messages);

    // Determine status — check stalled FIRST (it's the stricter condition)
    let status = "active";
    if (idleMs > this.#idleThresholdMs * 2) {
      status = "stalled";
    } else if (idleMs > this.#idleThresholdMs) {
      status = "idle";
    }

    // Determine recommendation
    let recommendation = "none";
    if (status === "stalled") {
      recommendation = "abort";
    } else if (status === "idle") {
      // If agent was idle but had some activity, try CONTINUE
      recommendation = session.totalEvents > 0 ? "continue" : "nudge";
    } else if (elapsedMs > 30 * 60_000 && session.totalEvents < 5) {
      // 30 min with < 5 events — agent is stalled even if not technically idle
      recommendation = "continue";
    }

    return {
      status, idleMs, totalEvents: session.totalEvents,
      lastEventType: session.messages.at(-1)?.type ?? null,
      hasEdits: activity.hasEdits, hasCommits: activity.hasCommits, elapsedMs, recommendation,
    };
  }

  /**
   * Get all active sessions (for watchdog scanning).
   * @returns {Array<{ taskId: string, taskTitle: string, idleMs: number, totalEvents: number, elapsedMs: number }>}
   */
  getActiveSessions() {
    const result = [];
    const now = Date.now();
    for (const [taskId, session] of this.#sessions) {
      if (session.status !== "active") continue;
      result.push({
        taskId,
        taskTitle: session.taskTitle,
        idleMs: now - session.lastActivityAt,
        totalEvents: session.totalEvents,
        elapsedMs: now - session.startedAt,
      });
    }
    return result;
  }

  /**
   * Get the full session record.
   * @param {string} taskId
   * @returns {SessionRecord|null}
   */
  getSession(taskId) {
    return this.#sessions.get(taskId) ?? null;
  }

  /**
   * Remove a session from tracking (after review handoff).
   * @param {string} taskId
   */
  removeSession(taskId) {
    this.#markSessionRetired(taskId);
    const session = this.#sessions.get(taskId);
    this.#accumulateCompletedSession(session, taskId);
    this.#sessions.delete(taskId);
    this.#dirty.delete(taskId);
    this.#invalidatePersistedSummaryCache();
    deleteSessionRecordFromDurableLedger(taskId);
    // Remove persisted session file if it exists
    if (this.#persistDir) {
      try {
        const filePath = this.#sessionFilePath(taskId);
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch { /* best effort */ }
    }
  }

  /**
   * Get stats about tracked sessions.
   * @returns {{ active: number, completed: number, total: number }}
   */
  getStats() {
    let active = 0;
    let completed = 0;
    for (const session of this.#sessions.values()) {
      if (session.status === "active") active++;
      else completed++;
    }
    return { active, completed, total: this.#sessions.size };
  }

  // ── Persistence API ─────────────────────────────────────────────────────

  /**
   * Create a new session with explicit options.
   * @param {{ id: string, type?: string, taskId?: string, metadata?: Object }} opts
   */
  createSession({ id, type = "manual", taskId, metadata = {}, maxMessages, sessionKey }) {
    this.#clearRetiredSession(id);
    // Evict oldest non-active sessions if at capacity
    if (this.#sessions.size >= MAX_SESSIONS && !this.#sessions.has(id)) {
      this.#evictOldest();
    }

    const now = new Date().toISOString();
    const normalizedMetadata = normalizeSessionMetadata(metadata);
    const resolvedMax = resolveSessionMaxMessages(
      type,
      normalizedMetadata,
      maxMessages,
      this.#maxMessages,
    );
    const session = {
      id,
      taskId: taskId || id,
      taskTitle: normalizedMetadata.title || id,
      sessionKey:
        String(sessionKey || "").trim() ||
        `${taskId || id}:${Date.now()}:${randomToken(8)}`,
      type,
      status: "active",
      createdAt: now,
      lastActiveAt: now,
      startedAt: Date.now(),
      endedAt: null,
      messages: [],
      totalEvents: 0,
      turnCount: 0,
      turns: [],
      lastActivityAt: Date.now(),
      accumulatedAt: null,
      metadata: normalizedMetadata,
      maxMessages: resolvedMax,
      insights: buildSessionInsights({ messages: [] }),
      trajectory: { version: 1, replayable: true, steps: [] },
      summary: null,
    };
    this.#sessions.set(id, session);
    this.#markDirty(id);
    this.#flushDirty(); // immediate write for create
    persistSessionRecordToStateLedger(session);
    emitSessionStateEvent(session, "session-created");
    return session;
  }

  /**
   * List all sessions (metadata only, no full messages).
   * Sorted by lastActiveAt descending.
   * @param {{ includePersisted?: boolean }} [options]
   * @returns {Array<Object>}
   */
  listAllSessions(options = {}) {
    const includePersisted = options.includePersisted !== false;
    const lightweight = options.lightweight === true;
    const includeRuntimeProgress = options.includeRuntimeProgress !== false;
    const byId = new Map();
    const addSummary = (s) => {
      if (!s) return;
      const sessionId = s.id || s.taskId;
      const progress = includeRuntimeProgress && s.status === "active"
        ? this.getProgressStatus(sessionId)
        : null;
      const summaryBuilder = lightweight
        ? buildLightweightSessionSummaryRecord
        : buildSessionSummaryRecord;
      byId.set(sessionId, summaryBuilder(s, {
        progress,
        preview: this.#lastMessagePreview(s),
      }));
    };

    for (const s of this.#sessions.values()) {
      addSummary(s);
    }

    if (includePersisted) {
      for (const persisted of this.#readPersistedSessionSummaries({ lightweight })) {
        if (!persisted) continue;
        const sessionId = persisted.id || persisted.taskId;
        if (!sessionId || byId.has(sessionId)) continue;
        byId.set(sessionId, lightweight
          ? {
              ...persisted,
              metadata:
                persisted?.metadata && typeof persisted.metadata === "object"
                  ? { ...persisted.metadata }
                  : {},
            }
          : {
              ...persisted,
              turns: Array.isArray(persisted.turns)
                ? persisted.turns.map((turn) => ({ ...turn }))
                : [],
            });
      }
    }

    const list = [...byId.values()];
    list.sort((a, b) => (b.lastActiveAt || "").localeCompare(a.lastActiveAt || ""));
    return list;
  }

  /**
   * Get full session including all messages, read from disk if needed.
   * @param {string} sessionId
   * @returns {Object|null}
   */
  getSessionMessages(sessionId) {
    let session = this.#sessions.get(sessionId);
    if (!session && this.#persistDir) {
      try {
        const filePath = this.#sessionFilePath(sessionId);
        if (existsSync(filePath)) {
          const raw = readFileSync(filePath, "utf8");
          const restored = buildSessionRecordFromPersistedData(JSON.parse(raw || "{}"), this.#idleThresholdMs);
          if (restored) {
            if (this.#sessions.size >= MAX_SESSIONS && !this.#sessions.has(restored.id)) {
              this.#evictOldest();
            }
            this.#sessions.set(restored.id, restored);
            this.#backfillSessionToStateLedger(restored);
            session = restored;
          }
        }
      } catch {
        session = null;
      }
    }
    if (!session) return null;
    return { ...session };
  }

  /**
   * Get a session by id (alias for getSession with id lookup).
   * @param {string} sessionId
   * @returns {Object|null}
   */
  getSessionById(sessionId) {
    return this.#sessions.get(sessionId) ?? null;
  }

  /**
   * Update session status.
   * @param {string} sessionId
   * @param {string} status
   */
  updateSessionStatus(sessionId, status) {
    let session = this.#sessions.get(sessionId);
    if (!session) {
      this.getSessionMessages(sessionId);
      session = this.#sessions.get(sessionId);
    }
    if (!session) return;
    session.status = isTerminalSessionStatus(status)
      ? deriveTerminalSessionStatus(session, status)
      : normalizeSessionStatus(status, "active");
    if (isTerminalSessionStatus(session.status)) {
      session.endedAt = Date.now();
    }
    this.#scheduleDerivedStateRefresh(session, { force: true });
    this.#accumulateCompletedSession(session, sessionId);
    this.#markDirty(sessionId);
    persistSessionRecordToStateLedger(session);
    emitSessionStateEvent(session, "session-status", { status: session.status });
  }

  touchSession(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session) return false;
    session.lastActivityAt = Date.now();
    session.lastActiveAt = new Date().toISOString();
    this.#scheduleDerivedStateRefresh(session, { force: true });
    this.#markDirty(sessionId);
    persistSessionRecordToStateLedger(session);
    return true;
  }

  updateSessionMetadata(sessionId, updater) {
    const session = this.#sessions.get(sessionId);
    if (!session) return null;
    const currentMetadata =
      session.metadata && typeof session.metadata === "object" && !Array.isArray(session.metadata)
        ? { ...session.metadata }
        : {};
    const nextValue = typeof updater === "function"
      ? updater(currentMetadata)
      : { ...currentMetadata, ...(updater && typeof updater === "object" ? updater : {}) };
    const nextMetadata = normalizeSessionMetadata(nextValue || {});
    session.metadata = nextMetadata;
    session.lastActivityAt = Date.now();
    session.lastActiveAt = new Date().toISOString();
    this.#scheduleDerivedStateRefresh(session, { force: true });
    this.#markDirty(sessionId);
    persistSessionRecordToStateLedger(session);
    emitSessionStateEvent(session, "session-metadata", { metadata: nextMetadata });
    return nextMetadata;
  }

  enqueueFollowup(sessionId, payload = {}) {
    const content = String(payload?.content ?? payload?.message ?? "").trim();
    const attachments = Array.isArray(payload?.attachments) ? payload.attachments.filter(Boolean).slice(0, 20) : [];
    if (!content && attachments.length === 0) return null;
    let queuedEntry = null;
    const metadata = this.updateSessionMetadata(sessionId, (currentMetadata = {}) => {
      const queuedFollowups = Array.isArray(currentMetadata.queuedFollowups)
        ? currentMetadata.queuedFollowups.slice()
        : [];
        queuedEntry = {
          id: `queued-${Date.now()}-${randomToken(6)}`,
          content: content.slice(0, MAX_MESSAGE_CHARS),
          queuedAt: new Date().toISOString(),
          deliveryMode: String(payload?.deliveryMode || payload?.mode || "queue").trim() || "queue",
          agent: String(payload?.agent || "").trim() || null,
          model: String(payload?.model || "").trim() || null,
          attachments,
        };
      queuedFollowups.push(queuedEntry);
      return {
        ...currentMetadata,
        queuedFollowups,
      };
    });
    if (!metadata || !queuedEntry) return null;
    return {
      entry: queuedEntry,
      queuedFollowups: Array.isArray(metadata.queuedFollowups) ? metadata.queuedFollowups.slice() : [],
    };
  }

  dequeueFollowup(sessionId) {
    let dequeuedEntry = null;
    const metadata = this.updateSessionMetadata(sessionId, (currentMetadata = {}) => {
      const queuedFollowups = Array.isArray(currentMetadata.queuedFollowups)
        ? currentMetadata.queuedFollowups.slice()
        : [];
      dequeuedEntry = queuedFollowups.shift() || null;
      return {
        ...currentMetadata,
        queuedFollowups,
      };
    });
    return {
      entry: dequeuedEntry,
      queuedFollowups: Array.isArray(metadata?.queuedFollowups) ? metadata.queuedFollowups.slice() : [],
    };
  }

  /**
   * Rename a session (update its title).
   * @param {string} sessionId
   * @param {string} newTitle
   */
  renameSession(sessionId, newTitle) {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    session.taskTitle = newTitle;
    session.title = newTitle;
    session.metadata = session.metadata && typeof session.metadata === "object"
      ? session.metadata
      : {};
    session.metadata.title = newTitle;
    this.#markDirty(sessionId);
    persistSessionRecordToStateLedger(session);
    emitSessionStateEvent(session, "session-renamed", { title: newTitle });
  }

  /**
   * Edit a previously recorded user message in-place.
   * @param {string} sessionId
   * @param {Object} payload
   * @param {string} [payload.messageId]
   * @param {string} [payload.timestamp]
   * @param {string} [payload.previousContent]
   * @param {string} payload.content
   * @returns {{ok:boolean,error?:string,message?:object,index?:number}}
   */
  editUserMessage(sessionId, payload = {}) {
    const session = this.#sessions.get(sessionId);
    if (!session) return { ok: false, error: "Session not found" };

    const nextContent = String(payload?.content || "").trim();
    if (!nextContent) return { ok: false, error: "content is required" };

    const messageId = String(payload?.messageId || "").trim();
    const timestamp = String(payload?.timestamp || "").trim();
    const previousContent = payload?.previousContent != null
      ? String(payload.previousContent)
      : "";
    const messages = Array.isArray(session.messages) ? session.messages : [];

    let idx = -1;
    if (messageId) {
      idx = messages.findIndex((msg) => String(msg?.id || "") === messageId);
    }

    if (idx < 0 && timestamp) {
      idx = messages.findIndex((msg) => {
        if (String(msg?.role || "").toLowerCase() !== "user") return false;
        if (String(msg?.timestamp || "") !== timestamp) return false;
        if (!previousContent) return true;
        return String(msg?.content || "") === previousContent;
      });
    }

    if (idx < 0 && previousContent) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (String(msg?.role || "").toLowerCase() !== "user") continue;
        if (String(msg?.content || "") === previousContent) {
          idx = i;
          break;
        }
      }
    }

    if (idx < 0) return { ok: false, error: "Message not found" };

    const target = messages[idx];
    if (String(target?.role || "").toLowerCase() !== "user") {
      return { ok: false, error: "Only user messages can be edited" };
    }

    target.id = target.id || `msg-${Date.now()}-${randomToken(6)}`;
    target.content = nextContent.slice(0, MAX_MESSAGE_CHARS);
    target.edited = true;
    target.editedAt = new Date().toISOString();
    session.lastActivityAt = Date.now();
    session.lastActiveAt = new Date().toISOString();
    this.#scheduleDerivedStateRefresh(session, { force: true });
    this.#markDirty(sessionId);
    persistSessionRecordToStateLedger(session);

    return { ok: true, message: { ...target }, index: idx };
  }

  /**
   * Flush all dirty sessions to disk immediately.
   */
  flush() {
    this.#flushDirty();
  }

  /**
   * Flush all dirty sessions to disk immediately (alias for flush).
   */
  flushNow() {
    this.#flushDirty();
  }

  /**
   * Stop all timers and flush pending writes (for cleanup).
   */
  destroy() {
    if (this.#flushTimer) {
      clearInterval(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (this.#reaperTimer) {
      clearInterval(this.#reaperTimer);
      this.#reaperTimer = null;
    }
    for (const [sessionId, timer] of this.#derivedRefreshTimers.entries()) {
      clearTimeout(timer);
      this.#derivedRefreshTimers.delete(sessionId);
      const session = this.#sessions.get(sessionId);
      if (session) this.#refreshDerivedState(session);
    }
    this.#flushDirty();
  }

  /**
   * Merge any on-disk session updates into memory.
   * Useful when another process writes session files.
   * Respects MAX_SESSIONS and heals stale "active" status.
   */
  refreshFromDisk() {
    if (!this.#persistDir) return;
    this.#ensureDir();
    this.#invalidatePersistedSummaryCache();
    let files = [];
    try {
      files = readdirSync(this.#persistDir).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }

    // Pre-parse for sorting
    /** @type {Array<{file: string, data: Object, lastActive: number}>} */
    const parsed = [];
    for (const file of files) {
      const filePath = resolve(this.#persistDir, file);
      try {
        const raw = readFileSync(filePath, "utf8");
        const data = JSON.parse(raw || "{}");
        const sessionId = String(data.id || data.taskId || "").trim();
        if (!sessionId) continue;
        const lastActiveAt =
          Date.parse(data.lastActiveAt || "") ||
          Date.parse(data.updatedAt || "") ||
          0;
        // Skip if already in memory and newer
        const existing = this.#sessions.get(sessionId);
        const existingLast =
          existing?.lastActivityAt ||
          Date.parse(existing?.lastActiveAt || "") ||
          0;
        if (existing && existingLast >= lastActiveAt) continue;
        parsed.push({ file, data, lastActive: lastActiveAt });
      } catch {
        /* ignore corrupt session file */
      }
    }

    // Sort by lastActive descending and limit to MAX_SESSIONS
    parsed.sort((a, b) => b.lastActive - a.lastActive);
    const available = MAX_SESSIONS - this.#sessions.size;
    const toLoad = parsed.slice(0, Math.max(0, available));

    for (const { data } of toLoad) {
      const restored = buildSessionRecordFromPersistedData(data, this.#idleThresholdMs);
      if (!restored) continue;
      this.#sessions.set(restored.id, restored);
      this.#backfillSessionToStateLedger(restored);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Auto-create a session when recordEvent is called for an unknown taskId. */
  #autoCreateSession(taskId, event) {
    if (this.#isSessionRetired(taskId)) return;
    const type = event._sessionType || "task";
    this.createSession({
      id: taskId,
      sessionKey: `${taskId}:${Date.now()}:${randomToken(8)}`,
      type,
      taskId,
      metadata: { autoCreated: true },
    });
  }

  #markSessionRetired(taskId, ttlMs = RETIRED_SESSION_SUPPRESSION_MS) {
    const sessionId = String(taskId || "").trim();
    if (!sessionId) return;
    const ttl = Number(ttlMs);
    const expiresAt = Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl : 0);
    this.#retiredSessions.set(sessionId, expiresAt);
  }

  #clearRetiredSession(taskId) {
    const sessionId = String(taskId || "").trim();
    if (!sessionId) return;
    this.#retiredSessions.delete(sessionId);
  }

  #isSessionRetired(taskId) {
    const sessionId = String(taskId || "").trim();
    if (!sessionId) return false;
    const expiresAt = Number(this.#retiredSessions.get(sessionId) || 0);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.#retiredSessions.delete(sessionId);
      return false;
    }
    return true;
  }

  /**
   * Evict the oldest 25% of sessions, preferring completed/idle sessions first.
   * Active sessions are only evicted as a last resort.
   */
  #evictOldest() {
    const evictCount = Math.max(1, Math.ceil(MAX_SESSIONS / 4));
    // Prefer evicting completed/idle/failed sessions before active ones
    const sorted = [...this.#sessions.entries()]
      .sort((a, b) => {
        const aActive = a[1].status === "active" ? 1 : 0;
        const bActive = b[1].status === "active" ? 1 : 0;
        if (aActive !== bActive) return aActive - bActive; // non-active first
        return (a[1].lastActivityAt || a[1].startedAt) - (b[1].lastActivityAt || b[1].startedAt);
      });
    const toEvict = sorted.slice(0, evictCount);
    for (const [id, session] of toEvict) {
      this.#accumulateCompletedSession(session, id);
      this.#sessions.delete(id);
    }
  }

  /**
   * Reap idle sessions: mark sessions as "completed" if they have been
   * inactive for longer than the idle threshold.
   * Called periodically by the reaper interval.
   */
  #reapIdleSessions() {
    const now = Date.now();
    let reaped = 0;
    for (const [id, session] of this.#sessions) {
      if (session.status !== "active") continue;
      const idleMs = now - (session.lastActivityAt || session.startedAt || now);
      if (idleMs > this.#idleThresholdMs) {
        session.status = deriveIdleTerminalSessionStatus(session);
        session.endedAt = now;
        this.#refreshDerivedState(session);
        this.#accumulateCompletedSession(session, id);
        this.#markDirty(id);
        emitSessionStateEvent(session, "session-idle-timeout", { status: session.status, idleMs });
        reaped++;
      }
    }
    if (reaped > 0) {
      console.log(`${TAG} idle reaper: marked ${reaped} stale session(s) as completed`);
    }
  }

  /** Get preview text from last message */
  #lastMessagePreview(session) {
    const last = session.messages?.at(-1);
    if (!last) return "";
    const content = last.content || "";
    return content.slice(0, 100);
  }

  #markDirty(sessionId) {
    if (this.#persistDir) {
      this.#dirty.add(sessionId);
    }
  }

  #accumulateCompletedSession(session, fallbackTaskId = "") {
    if (!session || session.accumulatedAt) return false;
    if (!isTerminalSessionStatus(session.status)) return false;
    const taskId = String(session.taskId || session.id || fallbackTaskId || "").trim();
    if (!taskId) return false;

    const now = Date.now();
    const endedAt = Number.isFinite(Number(session.endedAt)) && Number(session.endedAt) > 0
      ? Number(session.endedAt)
      : now;
    const startedAt = Number.isFinite(Number(session.startedAt))
      ? Number(session.startedAt)
      : endedAt;
    const turns = Array.isArray(session.turns) ? session.turns : [];
    const tokenUsage = resolveSessionTokenUsage(session, turns);
    const telemetry = buildSessionTelemetry(session, null, turns);

    addCompletedSession({
      id: session.id || taskId,
      sessionId: session.id || taskId,
      sessionKey: session.sessionKey || `${taskId}:${startedAt}:${endedAt}`,
      taskId,
      taskTitle: session.taskTitle,
      executor: session.executor,
      model: session.model,
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      turnCount: session.turnCount || 0,
      turns: turns.map((turn) => ({ ...turn })),
      tokenCount: tokenUsage?.totalTokens || 0,
      inputTokens: tokenUsage?.inputTokens || 0,
      outputTokens: tokenUsage?.outputTokens || 0,
      tokenUsage,
      insights: session.insights || null,
      status: String(session.status || "completed"),
      totalEvents: telemetry.totalEvents,
      lastEventType: telemetry.lastEventType,
      hasEdits: telemetry.hasEdits,
      hasCommits: telemetry.hasCommits,
      toolCalls: telemetry.toolCalls,
      toolResults: telemetry.toolResults,
      errors: telemetry.errors,
      commandExecutions: telemetry.commandExecutions,
      fileCounts: telemetry.fileCounts,
      topTools: telemetry.topTools,
      recentActions: telemetry.recentActions,
      contextWindow: telemetry.contextWindow,
      contextUsagePercent: telemetry.contextUsagePercent,
      contextPressure: telemetry.contextPressure,
      lastToolName: telemetry.lastToolName,
      runtimeHealth: telemetry.runtimeHealth,
    });
    session.accumulatedAt = new Date().toISOString();
    return true;
  }

  #backfillSessionToStateLedger(session, { force = false } = {}) {
    if (!session) return;
    const sessionId = String(session.id || session.taskId || "").trim();
    if (!sessionId) return;
    if (!force && this.#backfilledSessionIds.has(sessionId)) return;
    persistSessionRecordToStateLedger(session);
    this.#backfilledSessionIds.add(sessionId);
  }

  #appendTrajectoryStep(session, event) {
    if (!session) return;
    if (!session.trajectory) {
      session.trajectory = { version: 1, replayable: true, steps: [] };
    }
    const step = this.#extractTrajectoryStep(event, session);
    if (step) {
      session.trajectory.steps.push(step);
    }
  }

  #extractTrajectoryStep(event, session) {
    const ts = new Date().toISOString();
    const eventTimestamp = String(event?.timestamp || event?.item?.timestamp || "").trim() || ts;
    const id = `step-${Date.now()}-${randomToken(6)}`;

    // String event
    if (typeof event === "string") {
      return { id, kind: "system", summary: event.trim().slice(0, 200), timestamp: ts };
    }

    // Direct message format (role/content)
    if (event?.role && event?.content !== undefined) {
      const content = String(event.content).slice(0, 200);
      const timestamp = event.timestamp || ts;
      if (event.role === "user") return { id, kind: "user_message", summary: content, timestamp };
      if (event.role === "assistant") return { id, kind: "assistant", summary: content, timestamp };
      return { id, kind: event.role, summary: content, timestamp };
    }

    // SDK item.started events
    if (event?.type === "item.started" && event?.item) {
      const item = event.item;
      if (item.type === "command_execution") {
        return { id, kind: "tool_call", summary: `Ran ${item.command || "unknown"}`, timestamp: eventTimestamp };
      }
      if (item.type === "reasoning") {
        return { id, kind: "reasoning", summary: item.text || "", timestamp: eventTimestamp };
      }
      if (item.type === "function_call" || item.type === "mcp_tool_call") {
        return { id, kind: "tool_call", summary: `${item.name || "call"} ${item.arguments || ""}`.trim(), timestamp: eventTimestamp };
      }
      return null;
    }

    // SDK item.completed events
    if (event?.type === "item.completed" && event?.item) {
      const item = event.item;
      if (item.type === "reasoning") {
        return { id, kind: "reasoning", summary: item.text || "", timestamp: eventTimestamp };
      }
      if (item.type === "function_call" || item.type === "mcp_tool_call") {
        return { id, kind: "tool_call", summary: `${item.name || "call"} ${item.arguments || ""}`.trim(), timestamp: eventTimestamp };
      }
      if (item.type === "command_execution") {
        const cmd = item.command || "";
        const hasPriorStart = (session?.trajectory?.steps || []).some(
          (s) => s.kind === "tool_call" && s.summary === `Ran ${cmd}`,
        );
        if (hasPriorStart) {
          return { id, kind: "tool_result", summary: `${cmd} (exit ${item.exit_code ?? "?"})`, timestamp: eventTimestamp };
        }
        return { id, kind: "command", summary: cmd, timestamp: eventTimestamp };
      }
      if (item.type === "agent_message") {
        return { id, kind: "assistant", summary: item.text || "", timestamp: eventTimestamp };
      }
      return null;
    }

    // Assistant message events
    if (event?.type === "assistant.message") {
      const content = event?.data?.content || event?.content || "";
      return { id, kind: "agent_message", summary: content.slice(0, 200), timestamp: eventTimestamp };
    }

    if (event?.type === "session.turn.complete" && event?.text) {
      return {
        id,
        kind: "agent_message",
        summary: String(event.text).slice(0, 200),
        timestamp: eventTimestamp,
      };
    }

    return null;
  }

  #refreshDerivedState(session) {
    if (!session) return;
    try {
      session.insights = buildSessionInsights({
        ...session,
        insights: null,
      });
      const priorTurns = Array.isArray(session.turns) ? session.turns : [];
      const priorTurnsByIndex = new Map(
        priorTurns.map((turn) => [Number(turn?.turnIndex || 0), turn]),
      );
      session.turns = Array.isArray(session.insights?.turnTimeline)
        ? session.insights.turnTimeline.map((turn) => {
            const turnIndex = Number(turn?.turnIndex || 0);
            const priorTurn = priorTurnsByIndex.get(turnIndex) || {};
            return {
              turnIndex,
              startedAt: turn?.startedAt ? parseTimestampMs(turn.startedAt) : (priorTurn.startedAt ?? null),
              endedAt: turn?.endedAt ? parseTimestampMs(turn.endedAt) : (priorTurn.endedAt ?? null),
              durationMs: Math.max(0, Number(turn?.durationMs || priorTurn.durationMs || 0)),
              inputTokens: Math.max(
                normalizeTokenNumber(turn?.inputTokens),
                normalizeTokenNumber(priorTurn.inputTokens),
              ),
              outputTokens: Math.max(
                normalizeTokenNumber(turn?.outputTokens),
                normalizeTokenNumber(priorTurn.outputTokens),
              ),
              totalTokens: Math.max(
                normalizeTokenNumber(turn?.totalTokens),
                normalizeTokenNumber(priorTurn.totalTokens),
              ),
              userMessageId: priorTurn.userMessageId || null,
              assistantMessageId: priorTurn.assistantMessageId || null,
              status: priorTurn.status || (turn?.endedAt ? "completed" : "in_progress"),
            };
          })
        : priorTurns;
    } catch {
      // Inspector insights are best-effort only.
    }
    try {
      const steps = session.trajectory?.steps || [];
      const totalSteps = steps.length;
      const isFailed = session.status === "failed";
      const isLong = totalSteps > 12;
      const failedOrLongRun = isFailed || isLong;
      const resumable = failedOrLongRun;
      const shortSteps = steps.slice(-12).map((s) => ({ kind: s.kind, summary: s.summary }));
      const latestStep =
        steps.length > 0
          ? { kind: steps[steps.length - 1].kind, summary: steps[steps.length - 1].summary }
          : null;
      session.summary = { failedOrLongRun, resumable, totalSteps, shortSteps, latestStep };
    } catch {
      // Summary computation is best-effort only.
    }
  }

  #scheduleDerivedStateRefresh(session, options = {}) {
    if (!session) return;
    const sessionId = String(session.id || session.taskId || "").trim();
    if (!sessionId) {
      this.#refreshDerivedState(session);
      return;
    }
    const force = options.force === true;
    const existingTimer = this.#derivedRefreshTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.#derivedRefreshTimers.delete(sessionId);
    }
    if (force) {
      this.#refreshDerivedState(session);
      session._derivedStateRefreshedAt = Date.now();
      return;
    }
    const now = Date.now();
    const lastRefreshedAt = Number(session._derivedStateRefreshedAt || 0);
    const elapsedMs = now - lastRefreshedAt;
    if (elapsedMs >= DERIVED_STATE_REFRESH_MS) {
      this.#refreshDerivedState(session);
      session._derivedStateRefreshedAt = now;
      return;
    }
    const delayMs = Math.max(0, DERIVED_STATE_REFRESH_MS - elapsedMs);
    const timer = setTimeout(() => {
      this.#derivedRefreshTimers.delete(sessionId);
      const currentSession = this.#sessions.get(sessionId);
      if (!currentSession) return;
      this.#refreshDerivedState(currentSession);
      currentSession._derivedStateRefreshedAt = Date.now();
    }, delayMs);
    if (timer.unref) timer.unref();
    this.#derivedRefreshTimers.set(sessionId, timer);
  }

  #ensureDir() {
    if (this.#persistDir && !existsSync(this.#persistDir)) {
      mkdirSync(this.#persistDir, { recursive: true });
    }
  }

  #safeSessionFileMtime(file) {
    try {
      return statSync(resolve(this.#persistDir, file)).mtimeMs;
    } catch {
      return 0;
    }
  }

  #sessionFilePath(sessionId) {
    // Sanitize sessionId for filesystem safety
    const safe = String(sessionId).replace(/[^a-zA-Z0-9_\-\.]/g, "_");
    return resolve(this.#persistDir, `${safe}.json`);
  }

  #flushDirty() {
    if (!this.#persistDir || this.#dirty.size === 0) return;
    this.#ensureDir();
    for (const sessionId of this.#dirty) {
      const session = this.#sessions.get(sessionId);
      if (!session) continue;
      try {
        this.#refreshDerivedState(session);
        session._derivedStateRefreshedAt = Date.now();
        const filePath = this.#sessionFilePath(sessionId);
        const data = {
          id: session.id || session.taskId,
          taskId: session.taskId,
          title: session.taskTitle || session.title || null,
          taskTitle: session.taskTitle || null,
          sessionKey: session.sessionKey || null,
          type: session.type || "task",
          status: session.status,
          createdAt: session.createdAt || new Date(session.startedAt).toISOString(),
          lastActiveAt: session.lastActiveAt || new Date(session.lastActivityAt).toISOString(),
          startedAt: session.startedAt || null,
          endedAt: session.endedAt || null,
          accumulatedAt: session.accumulatedAt || null,
          turnCount: session.turnCount || 0,
          turns: Array.isArray(session.turns) ? session.turns : [],
          messages: session.messages || [],
          metadata: session.metadata || {},
          insights: session.insights || null,
          trajectory: session.trajectory || null,
          summary: session.summary || null,
        };
        writeFileSync(filePath, JSON.stringify(data, null, 2));
      } catch (err) {
        // Silently ignore write errors — disk persistence is best-effort
      }
    }
    this.#dirty.clear();
    this.#invalidatePersistedSummaryCache();
  }

  /** @type {Set<string>} filenames loaded during #loadFromDisk (for purge) */
  #loadedFiles = new Set();

  #loadFromDisk() {
    if (!this.#persistDir || !existsSync(this.#persistDir)) return;
    try {
      const files = readdirSync(this.#persistDir).filter((f) => f.endsWith(".json"));

      // Keep startup bounded by loading only the newest session files into memory.
      // Older sessions remain on disk and are listed/lazy-loaded on demand.
      const recentFiles = files
        .map((file) => ({ file, mtimeMs: Number(this.#safeSessionFileMtime(file)) || 0 }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, MAX_SESSIONS);

      for (const { file } of recentFiles) {
        try {
          const raw = readFileSync(resolve(this.#persistDir, file), "utf8");
          const data = JSON.parse(raw);
          if (!data.id && !data.taskId) continue;
          const restored = buildSessionRecordFromPersistedData(data, this.#idleThresholdMs);
          if (!restored) continue;
          const id = restored.id;
          if (this.#sessions.has(id)) continue;
          this.#sessions.set(id, restored);
          this.#backfillSessionToStateLedger(restored);
          // Skip completed-session accumulation during startup hydration to keep disk-backed reloads fast.
          // Sessions are still available for listing and lazy message reads from disk.
        } catch {
          // Skip corrupt files
        }
      }
    } catch {
      // Directory read failed — proceed without disk data
    }
    this.#invalidatePersistedSummaryCache();
  }

  #invalidatePersistedSummaryCache() {
    this.#persistedSummaryCache = { loadedAt: 0, sessions: [] };
  }

  #readPersistedSessionSummaries(options = {}) {
    if (!this.#persistDir || !existsSync(this.#persistDir)) {
      return [];
    }

    const lightweight = options.lightweight === true;

    const now = Date.now();
    if (
      Array.isArray(this.#persistedSummaryCache.sessions) &&
      now - Number(this.#persistedSummaryCache.loadedAt || 0) <
        PERSISTED_SESSION_LIST_CACHE_TTL_MS
    ) {
      return lightweight
        ? this.#persistedSummaryCache.sessions.map((session) => ({
            ...session,
            metadata:
              session?.metadata && typeof session.metadata === "object"
                ? { ...session.metadata }
                : {},
          }))
        : this.#persistedSummaryCache.sessions;
    }

    const sessions = [];
    try {
      const files = readdirSync(this.#persistDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const raw = readFileSync(resolve(this.#persistDir, file), "utf8");
          const restored = buildSessionRecordFromPersistedData(
            JSON.parse(raw || "{}"),
            this.#idleThresholdMs,
          );
          if (!restored) continue;
          this.#backfillSessionToStateLedger(restored);
          const sessionId = restored.id || restored.taskId;
          const lastActiveAt =
            restored.lastActiveAt || new Date(restored.lastActivityAt).toISOString();
          sessions.push(buildSessionSummaryRecord(restored, {
            preview: this.#lastMessagePreview(restored),
            runtimeUpdatedAt: lastActiveAt,
            runtimeIsLive: false,
          }));
        } catch {
          // Ignore corrupt session files in summary listing
        }
      }
    } catch {
      // Best-effort disk-backed listing only
    }

    sessions.sort((a, b) => (b.lastActiveAt || "").localeCompare(a.lastActiveAt || ""));
    this.#persistedSummaryCache = {
      loadedAt: now,
      sessions,
    };
    return sessions;
  }

  /**
   * Remove session files that were NOT loaded into memory (excess beyond MAX_SESSIONS).
   * This runs once at startup to clean up historical bloat.
   */
  #purgeExcessFiles() {
    this.#loadedFiles.clear();
  }

  /**
   * Normalize a raw SDK event into a SessionMessage.
   * Returns null for events that shouldn't be tracked (noise).
   *
   * @param {Object} event
   * @returns {SessionMessage|null}
   * @private
   */
  #normalizeEvent(event) {
    if (!event || !event.type) return null;

    const ts = new Date().toISOString();
    const eventTimestamp = String(event.timestamp || "").trim() || ts;
    const toText = (value) => {
      if (value == null) return "";
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };

    // ── Codex SDK events ──
    if ((event.type === "item.completed" || event.type === "item.updated") && event.item) {
      const item = event.item;
      const itemType = String(item.type || "").toLowerCase();

      if (itemType === "agent_message" && item.text) {
        return {
          id: item.id || event.itemId || undefined,
          type: "agent_message",
          content: item.text.slice(0, MAX_MESSAGE_CHARS),
          timestamp: ts,
          meta: item._compressed || item._cachedLogId
            ? {
                compression: {
                  kind: item._compressed || (item._cachedLogId ? "tool_cache" : "compressed"),
                  originalLength:
                    Number.isFinite(Number(item._originalLength))
                      ? Number(item._originalLength)
                      : undefined,
                  cachedLogId: item._cachedLogId || undefined,
                },
              }
            : undefined,
        };
      }

      if (itemType === "function_call") {
        return {
          id: item.id || event.itemId || undefined,
          type: "tool_call",
          content: `${item.name}(${(item.arguments || "").slice(0, 500)})`,
          timestamp: ts,
          meta: { toolName: item.name },
        };
      }

      if (itemType === "function_call_output") {
        return {
          id: item.id || event.itemId || item.toolCallId || undefined,
          type: "tool_result",
          content: (item.output || "").slice(0, MAX_MESSAGE_CHARS),
          timestamp: ts,
          meta: item._cachedLogId || item._compressed
            ? {
                compression: {
                  kind: item._compressed || (item._cachedLogId ? "tool_cache" : "compressed"),
                  originalLength:
                    Number.isFinite(Number(item._originalLength))
                      ? Number(item._originalLength)
                      : undefined,
                  cachedLogId: item._cachedLogId || undefined,
                },
              }
            : undefined,
        };
      }

      if (itemType === "command_execution" || itemType === "commandexecution") {
        const command = toText(item.command || item.input || "").trim();
        const exitCode = Number.isFinite(Number(item.exit_code)) ? Number(item.exit_code) : null;
        const status = toText(item.status || "").trim();
        const statusParts = [];
        if (status) statusParts.push(status);
        if (exitCode !== null) statusParts.push(`exit=${exitCode}`);
        const statusLabel = statusParts.length ? ` [${statusParts.join(", ")}]` : "";
        const output = toText(
          item.aggregated_output || item.output || item.stderr || item.stdout || "",
        ).trim();
        const content = output
          ? `${command || "(command)"}${statusLabel}
${output}`
          : `${command || "(command)"}${statusLabel}`;
        return {
          id: item.id || event.itemId || undefined,
          type: "tool_call",
          content: content.slice(0, MAX_MESSAGE_CHARS),
          timestamp: ts,
          meta: { toolName: "command_execution" },
        };
      }

      if (itemType === "reasoning") {
        const detail = toText(item.text || item.summary || "");
        if (!detail) return null;
        return {
          id: item.id || event.itemId || undefined,
          type: "system",
          content: detail.slice(0, MAX_MESSAGE_CHARS),
          timestamp: ts,
        };
      }

      if (
        itemType === "agent_message" &&
        event.type === "item.updated" &&
        (item.text || item.delta)
      ) {
        const partial = toText(item.text || item.delta);
        if (!partial) return null;
        return {
          id: item.id || event.itemId || undefined,
          type: "agent_message",
          content: partial.slice(0, MAX_MESSAGE_CHARS),
          timestamp: ts,
        };
      }

      if (itemType === "file_change") {
        const changes = Array.isArray(item.changes)
          ? item.changes
              .map((change) => {
                const kind = toText(change?.kind || "update").trim();
                const filePath = toText(change?.path || change?.file || "").trim();
                return filePath ? `${kind} ${filePath}` : kind;
              })
              .filter(Boolean)
          : [];
        const summary = changes.length
          ? `file changes: ${changes.slice(0, 5).join(", ")}`
          : "file changes detected";
        return {
          type: "system",
          content: summary.slice(0, MAX_MESSAGE_CHARS),
          timestamp: ts,
        };
      }

      if (itemType === "todo_list") {
        const items = Array.isArray(item.items)
          ? item.items
              .map((entry) => {
                const detail = toText(entry?.text || "").trim();
                if (!detail) return "";
                return `${entry?.completed ? "[x]" : "[ ]"} ${detail}`;
              })
              .filter(Boolean)
          : [];
        const summary = items.length ? `todo:
${items.join("\n")}` : "todo updated";
        return {
          type: "system",
          content: summary.slice(0, MAX_MESSAGE_CHARS),
          timestamp: ts,
        };
      }

      if (item.text || item.content) {
        const fallback = toText(item.text || item.content);
        if (fallback) {
          return {
            type: "system",
            content: fallback.slice(0, MAX_MESSAGE_CHARS),
            timestamp: ts,
          };
        }
      }

      return null; // Skip other item types
    }

    if (event.type === "item.started" && event.item) {
      const item = event.item;
      const itemType = String(item.type || "").toLowerCase();

      if (itemType === "command_execution") {
        const command = toText(item.command || item.input || "").trim();
        return {
          type: "tool_call",
          content: command || "(command)",
          timestamp: ts,
          meta: { toolName: "command_execution" },
        };
      }

      if (itemType === "reasoning") {
        const detail = toText(item.text || item.summary || "").trim();
        if (!detail) return null;
        return {
          type: "system",
          content: detail.slice(0, MAX_MESSAGE_CHARS),
          timestamp: ts,
        };
      }

      // ── Additional item.started subtypes ──────────────────────────────
      // Emit lifecycle events so the streaming module keeps the
      // "thinking / executing" indicator alive and the chat UI shows
      // real-time progress instead of going silent for minutes.
      if (itemType === "agent_message") {
        return {
          type: "system",
          content: "Agent is composing a response…",
          timestamp: ts,
          meta: { lifecycle: "started", itemType },
        };
      }

      if (itemType === "function_call") {
        const name = toText(item.name || "").trim();
        return {
          type: "tool_call",
          content: name ? `${name}(…)` : "(tool call starting)",
          timestamp: ts,
          meta: { toolName: name || "function_call", lifecycle: "started" },
        };
      }

      if (itemType === "mcp_tool_call") {
        const server = toText(item.server || "").trim();
        const tool = toText(item.tool || "").trim();
        return {
          type: "tool_call",
          content: `MCP [${server || "?"}]: ${tool || "(starting)"}`,
          timestamp: ts,
          meta: { toolName: tool || "mcp_tool_call", lifecycle: "started" },
        };
      }

      if (itemType === "web_search") {
        const query = toText(item.query || "").trim();
        return {
          type: "system",
          content: query ? `Searching: ${query}` : "Web search…",
          timestamp: ts,
          meta: { lifecycle: "started", itemType },
        };
      }

      if (itemType === "file_change") {
        return {
          type: "system",
          content: "Editing files…",
          timestamp: ts,
          meta: { lifecycle: "started", itemType },
        };
      }

      if (itemType === "todo_list") {
        return {
          type: "system",
          content: "Updating plan…",
          timestamp: ts,
          meta: { lifecycle: "started", itemType },
        };
      }
    }

    // ── Turn lifecycle events ──────────────────────────────────────────
    // Without these, the streaming module sees no events between the last
    // item.completed and the response finishing, causing the indicator
    // to flip between "thinking" and "idle".
    if (event.type === "turn.completed") {
      return {
        type: "system",
        content: "Turn completed",
        timestamp: eventTimestamp,
        meta: { lifecycle: "turn_completed" },
      };
    }

    if (event.type === "session.turn.complete" && event.text) {
      return {
        type: "agent_message",
        content: toText(event.text).slice(0, MAX_MESSAGE_CHARS),
        timestamp: eventTimestamp,
        meta: { lifecycle: "session_turn_complete" },
      };
    }

    if (event.type === "session.idle" || event.type === "session.completed") {
      return {
        type: "system",
        content: "Session completed",
        timestamp: eventTimestamp,
        meta: { lifecycle: "session_completed" },
      };
    }

    if (event.type === "turn.failed") {
      const detail = toText(event.error?.message || "unknown error");
      return {
        type: "error",
        content: `Turn failed: ${detail}`.slice(0, MAX_MESSAGE_CHARS),
        timestamp: eventTimestamp,
      };
    }

    if (event.type === "assistant.message" && event.data?.content) {
      return {
        type: "agent_message",
        content: toText(event.data.content).slice(0, MAX_MESSAGE_CHARS),
        timestamp: eventTimestamp,
      };
    }

    if (event.type === "assistant.message_delta" && event.data?.deltaContent) {
      return {
        type: "agent_message",
        content: toText(event.data.deltaContent).slice(0, MAX_MESSAGE_CHARS),
        timestamp: eventTimestamp,
      };
    }

    // ── Copilot SDK events ──
    if (event.type === "message" && event.content) {
      return {
        type: "agent_message",
        content: (typeof event.content === "string" ? event.content : JSON.stringify(event.content))
          .slice(0, MAX_MESSAGE_CHARS),
        timestamp: eventTimestamp,
      };
    }

    if (event.type === "tool_call") {
      return {
        type: "tool_call",
        content: `${event.name || event.tool || "tool"}(${(event.arguments || event.input || "").slice(0, 500)})`,
        timestamp: eventTimestamp,
        meta: { toolName: event.name || event.tool },
      };
    }

    if (event.type === "tool_result" || event.type === "tool_output") {
      return {
        type: "tool_result",
        content: (event.output || event.result || "").slice(0, MAX_MESSAGE_CHARS),
        timestamp: eventTimestamp,
      };
    }

    // ── Claude SDK events ──
    if (event.type === "content_block_delta" && event.delta?.text) {
      return {
        type: "agent_message",
        content: event.delta.text.slice(0, MAX_MESSAGE_CHARS),
        timestamp: eventTimestamp,
      };
    }

    if (event.type === "message_stop" || event.type === "message_delta") {
      const lifecycle = event.type === "message_stop" ? "turn_completed" : undefined;
      return {
        type: "system",
        content: `${event.type}${event.delta?.stop_reason ? ` (${event.delta.stop_reason})` : ""}`,
        timestamp: eventTimestamp,
        ...(lifecycle ? { meta: { lifecycle } } : {}),
      };
    }

    // ── Error events (any SDK) ──
    if (event.type === "error" || event.type === "stream_error") {
      return {
        type: "error",
        content: (event.error?.message || event.message || JSON.stringify(event)).slice(0, MAX_MESSAGE_CHARS),
        timestamp: eventTimestamp,
      };
    }

    // ── Voice events ──
    if (event.type === "voice.start") {
      return {
        type: "system",
        content: `Voice session started (provider: ${event.provider || "unknown"}, tier: ${event.tier || "?"})`,
        timestamp: eventTimestamp,
        meta: { voiceEvent: "start", provider: event.provider, tier: event.tier },
      };
    }
    if (event.type === "voice.end") {
      return {
        type: "system",
        content: `Voice session ended (duration: ${event.duration || 0}s)`,
        timestamp: eventTimestamp,
        meta: { voiceEvent: "end", duration: event.duration },
      };
    }
    if (event.type === "voice.transcript") {
      return {
        type: "user",
        content: (event.text || event.transcript || "").slice(0, MAX_MESSAGE_CHARS),
        timestamp: eventTimestamp,
        meta: { voiceEvent: "transcript" },
      };
    }
    if (event.type === "voice.response") {
      return {
        type: "agent_message",
        content: (event.text || event.response || "").slice(0, MAX_MESSAGE_CHARS),
        timestamp: eventTimestamp,
        meta: { voiceEvent: "response" },
      };
    }
    if (event.type === "voice.tool_call") {
      return {
        type: "tool_call",
        content: `voice:${event.name || "tool"}(${(event.arguments || "").slice(0, 500)})`,
        timestamp: eventTimestamp,
        meta: { voiceEvent: "tool_call", toolName: event.name },
      };
    }
    if (event.type === "voice.delegate") {
      return {
        type: "system",
        content: `Voice delegated to ${event.executor || "agent"}: ${(event.message || "").slice(0, 500)}`,
        timestamp: eventTimestamp,
        meta: { voiceEvent: "delegate", executor: event.executor },
      };
    }

    return null;
  }

  /**
   * Get a display prefix for a message type.
   * @param {string} type
   * @returns {string}
   * @private
   */
  #typePrefix(type) {
    switch (type) {
      case "agent_message": return "AGENT";
      case "tool_call":     return "TOOL";
      case "tool_result":   return "RESULT";
      case "error":         return "ERROR";
      case "system":        return "SYS";
      case "user":          return "USER";
      case "assistant":     return "ASSISTANT";
      case "voice":         return "VOICE";
      default:              return type.toUpperCase();
    }
  }
}

// ── Standalone exported functions (delegate to singleton) ───────────────────

/**
 * List all sessions (metadata only).
 * @param {{ includePersisted?: boolean }} [options]
 * @returns {Array<Object>}
 */
export function listAllSessions(options) {
  return getSessionTracker().listAllSessions(options);
}

/**
 * Get full session with all messages.
 * @param {string} sessionId
 * @returns {Object|null}
 */
export function getSessionMessages(sessionId) {
  return getSessionTracker().getSessionMessages(sessionId);
}

/**
 * Create a new session.
 * @param {{ id: string, type?: string, taskId?: string, metadata?: Object }} opts
 * @returns {Object}
 */
export async function createSession(opts) {
  return getSessionTracker().createSession(opts);
}

/**
 * Append an event/message to an existing session.
 * @param {string} sessionId
 * @param {Object|string} event
 */
export function appendEvent(sessionId, event) {
  return getSessionTracker().appendEvent(sessionId, event);
}

/**
 * Backward-compatible alias used by module-level callers that historically
 * expected a recordEvent export on the session-tracker module.
 * @param {string} sessionId
 * @param {Object|string} event
 */
export function recordEvent(sessionId, event) {
  return getSessionTracker().recordEvent(sessionId, event);
}

/**
 * Update session status.
 * @param {string} sessionId
 * @param {string} status
 */
export function updateSessionStatus(sessionId, status) {
  return getSessionTracker().updateSessionStatus(sessionId, status);
}

/**
 * Get a session by id.
 * @param {string} sessionId
 * @returns {Object|null}
 */
export function getSessionById(sessionId) {
  return getSessionTracker().getSessionById(sessionId);
}

// ── Singleton ───────────────────────────────────────────────────────────────

/** @type {SessionTracker|null} */
let _instance = null;

/**
 * Get or create the singleton SessionTracker.
 * @param {Object} [options]
 * @returns {SessionTracker}
 */
export function getSessionTracker(options) {
  if (!_instance) {
    const persistDir = resolveSessionTrackerPersistDir(options || {});
    _instance = new SessionTracker({
      ...options,
      persistDir,
    });
    console.log(`${TAG} initialized (maxMessages=${_instance.getStats ? DEFAULT_MAX_MESSAGES : "?"})`);
  }
  return _instance;
}

/**
 * Create a standalone SessionTracker (for testing).
 * @param {Object} [options]
 * @returns {SessionTracker}
 */
export function createSessionTracker(options) {
  return new SessionTracker(options);
}

/**
 * Reset the singleton so the next `getSessionTracker()` call creates a fresh
 * instance.  Intended **only** for tests — prevents test-created sessions from
 * leaking into the real `logs/sessions/` directory on disk.
 *
 * @param {Object} [nextOptions] — options forwarded to the *next* singleton
 *   creation.  Pass `{ persistDir: null }` to disable disk writes entirely.
 */
export function _resetSingleton(nextOptions) {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
  if (nextOptions) {
    // Pre-create with the supplied options so the next getSessionTracker()
    // call doesn't fall back to the default persistDir.
    _instance = new SessionTracker(nextOptions);
  }
}
