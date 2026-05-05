// CLAUDE:SUMMARY — workflow-engine
// Orchestrates workflow execution, persistence, retries, history, concurrency,
// and node dispatch for Bosun workflows and their runtime bookkeeping.

/**
 * workflow-engine.mjs — Bosun Workflow Engine
 *
 * A modular, declarative workflow execution engine that replaces hardcoded
 * supervisor logic with composable, user-editable workflow definitions.
 *
 * Workflows are directed graphs of nodes. Each node has a type (trigger,
 * condition, action, validation, transform, loop) and connects to
 * downstream nodes via edges. The engine evaluates triggers, routes
 * through conditions, executes actions, and validates results.
 *
 * While most workflows are DAGs, the engine supports back-edges
 * (edges with `backEdge: true`) for convergence loops. Back-edges
 * allow downstream nodes to route execution back to an upstream node,
 * enabling iterative patterns like generate→verify→revise cycles.
 * Back-edges are capped at a configurable iteration limit to prevent
 * infinite loops.
 *
 * Users define workflows via JSON (or the visual builder UI) — no custom
 * code required. Built-in templates cover common patterns like:
 *   - Task Planner (auto-replenish backlog when tasks run low)
 *   - Frontend Agent (screenshot validation before task completion)
 *   - Review Agent (automated PR review flow)
 *   - Custom agent profiles with validation gates
 *
 * EXPORTS:
 *   WorkflowEngine    — main engine class
 *   loadWorkflows()   — load all workflow definitions from disk
 *   saveWorkflow()    — persist a workflow definition
 *   deleteWorkflow()  — remove a workflow
 *   listWorkflows()   — list all available workflows
 *   getWorkflow()     — get a single workflow by ID
 *   executeWorkflow() — run a workflow by ID with given context
 *
 * Transitional architecture note:
 * The workflow engine remains the graph scheduler, but harness-backed session,
 * tool, approval, and subagent semantics must delegate to canonical harness
 * nodes and control-plane modules. This file must not become a second agent
 * runtime or a second approval/provider control plane.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync, renameSync, openSync, readSync, closeSync } from "node:fs";
import { resolve, basename, extname, join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import os from "node:os";
import {
  ensureTestRuntimeSandbox,
  resolvePathForTestRuntime,
} from "../infra/test-runtime.mjs";
import { getTemplate } from "./workflow-templates.mjs";
import { WorkflowExecutionLedger } from "./execution-ledger.mjs";
import { buildWorkflowStatusPayload } from "../infra/tui-bridge.mjs";
import { getCurrentTraceContext, traceWorkflowNode, traceWorkflowRun } from "../infra/tracing.mjs";
import { getBosunSessionManager } from "../agent/session-manager.mjs";
import { repairCommonMojibake } from "../lib/mojibake-repair.mjs";
import {
  getWorkflowRunFromStateLedger,
  getWorkflowSnapshotFromStateLedger,
  getWorkflowRunDetailFromStateLedger,
  listWorkflowSnapshotsFromStateLedger,
  listWorkflowRunSummariesPageFromStateLedger,
  writeWorkflowSnapshotToStateLedger,
  writeWorkflowRunDetailToStateLedger,
} from "../lib/state-ledger-sqlite.mjs";
import { recordHarnessTelemetryEvent } from "../infra/session-telemetry.mjs";
import { getTask as getKanbanTask, linkTaskWorkflowRun } from "../task/task-store.mjs";
import {
  buildDelegationWatchdogDecision,
  extractDelegationGuardMap,
  extractDelegationTrail,
  getDelegationAuditTrail,
  getDelegationTransitionGuard,
  hydrateDelegationReadModel,
  normalizeDelegationTrail,
  recordDelegationEvent as recordDelegationRuntimeEvent,
  setDelegationTransitionGuard as setDelegationRuntimeTransitionGuard,
} from "./delegation-runtime.mjs";

// Lazy-loaded workspace manager for workspace-aware scheduling
let _workspaceManagerMod = null;
async function ensureWorkspaceManager() {
  if (_workspaceManagerMod) return _workspaceManagerMod;
  try {
    _workspaceManagerMod = await import("../workspace/workspace-manager.mjs");
  } catch {
    _workspaceManagerMod = null;
  }
  return _workspaceManagerMod;
}
function ensureWorkspaceManagerSync() {
  if (_workspaceManagerMod) return _workspaceManagerMod;
  return null;
}

// ── Constants ───────────────────────────────────────────────────────────────

const TAG = "[workflow-engine]";

function getHarnessRuntimeSlotStatus() {
  try {
    const snapshot = getBosunSessionManager()?.snapshot?.();
    const pools = Array.isArray(snapshot?.subagentPool?.pools) ? snapshot.subagentPool.pools : [];
    if (pools.length === 0) return null;
    const totals = pools.reduce((acc, pool) => {
      acc.maxParallel += Math.max(0, Number(pool?.maxConcurrent || 0));
      acc.activeSlots += Math.max(0, Number(pool?.activeCount || 0));
      acc.queuedSlots += Math.max(0, Number(pool?.queueDepth || 0));
      return acc;
    }, {
      maxParallel: 0,
      activeSlots: 0,
      queuedSlots: 0,
    });
    return totals.maxParallel > 0 ? totals : null;
  } catch {
    return null;
  }
}

// Run history in-process cache (2s TTL)
const RUN_HISTORY_CACHE_TTL_MS = 2000;
const RUN_HISTORY_CACHE = new Map();

function clearRunHistoryCache() {
  RUN_HISTORY_CACHE.clear();
}

const WORKFLOW_DIR_NAME = "workflows";
const WORKFLOW_RUNS_DIR = "workflow-runs";
const WORKFLOW_TRAJECTORIES_DIR = "trajectories";
function getRuntimeProcess() {
  return globalThis.process;
}

function getRuntimeEnv() {
  return getRuntimeProcess()?.env || {};
}

function getWorkflowResumeTraceTaskIds() {
  const raw = String(getRuntimeEnv().WORKFLOW_RESUME_TRACE_TASK_IDS || "").trim();
  if (!raw) return null;
  const taskIds = raw
    .split(/[,\s]+/)
    .map((value) => normalizeWorkflowIdentityText(value))
    .filter(Boolean);
  return taskIds.length > 0 ? new Set(taskIds) : null;
}

function shouldQuietWorkflowTraceLogs() {
  const env = getRuntimeEnv();
  return (env.VITEST === "true" || env.NODE_ENV === "test")
    && env.BOSUN_TEST_VERBOSE_WORKFLOW_TRACE !== "1";
}

function logWorkflowTrace(message) {
  if (shouldQuietWorkflowTraceLogs()) return;
  console.log(message);
}

function normalizeWorkflowRunText(value) {
  const normalized = typeof value === "string" ? value : String(value || "");
  if (!normalized) return normalized;
  return repairCommonMojibake(normalized);
}

function attachWorkflowContextAlias(ctx) {
  if (!ctx || typeof ctx !== "object" || Object.prototype.hasOwnProperty.call(ctx, "ctx")) {
    return ctx;
  }
  Object.defineProperty(ctx, "ctx", {
    value: ctx,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return ctx;
}

const UNRESOLVED_WORKFLOW_TEMPLATE_TOKEN_RE = /\{\{[^{}]+\}\}/;

function normalizeWorkflowIdentityText(value) {
  const normalized = normalizeWorkflowRunText(value).trim();
  if (!normalized) return "";
  if (UNRESOLVED_WORKFLOW_TEMPLATE_TOKEN_RE.test(normalized)) return "";
  return normalized;
}

function resolveWorkflowRunTaskId(data = {}) {
  return normalizeWorkflowIdentityText(
    data?.taskId
    || data?.task?.id
    || data?.taskDetail?.id
    || "",
  ) || null;
}

function resolveWorkflowRunTaskTitle(data = {}) {
  return normalizeWorkflowIdentityText(
    data?.taskTitle
    || data?.task?.title
    || data?.taskDetail?.title
    || "",
  ) || null;
}

function normalizeWorkflowTaskStatus(task = {}) {
  const value = normalizeWorkflowIdentityText(
    task?.status
    || task?.state
    || task?.taskStatus
    || task?.task_status
    || task?.meta?.status
    || task?.meta?.state
    || task?.meta?.taskStatus
    || task?.meta?.task_status
    || "",
  ).toLowerCase().replace(/[\s_-]+/g, "");
  if (!value) return "";
  if (value === "completed") return "done";
  if (value === "canceled") return "cancelled";
  return value;
}

function isWorkflowTaskTerminal(task = {}) {
  const status = normalizeWorkflowTaskStatus(task);
  return status === "done" || status === "cancelled";
}

function resolveWorkflowRunSessionScope(data = {}) {
  return resolveWorkflowRunTaskId(data) ? "workflow-task" : "workflow-flow";
}

function resolveWorkflowRunSessionBinding({ ctx, workflowId, workflowName } = {}) {
  const data = ctx?.data || {};
  const taskId = resolveWorkflowRunTaskId(data);
  const taskTitle = resolveWorkflowRunTaskTitle(data);
  const explicitSessionId = normalizeWorkflowIdentityText(
    data._workflowSessionId
    || data.sessionId
    || "",
  );
  const rootSessionId = normalizeWorkflowIdentityText(
    data._workflowRootSessionId
    || explicitSessionId
    || taskId
    || ctx?.id
    || "",
  ) || null;
  const sessionId = explicitSessionId || taskId || `workflow:${workflowId}:${ctx?.id || "run"}`;
  const parentSessionId = normalizeWorkflowIdentityText(
    data._workflowParentSessionId
    || (sessionId !== rootSessionId ? rootSessionId : "")
    || "",
  ) || null;
  return {
    sessionId,
    rootSessionId: rootSessionId || sessionId,
    parentSessionId,
    taskId,
    taskTitle,
    scope: resolveWorkflowRunSessionScope(data),
    cwd: normalizeWorkflowRunText(
      data.worktreePath
      || data.repoRoot
      || process.cwd(),
    ).trim() || process.cwd(),
    workflowId: normalizeWorkflowIdentityText(workflowId),
    workflowName: normalizeWorkflowIdentityText(workflowName),
  };
}

let _harnessSessionNodeMod = null;
async function loadHarnessSessionNodeModule() {
  if (_harnessSessionNodeMod) return _harnessSessionNodeMod;
  _harnessSessionNodeMod = await import("./harness-session-node.mjs");
  return _harnessSessionNodeMod;
}

function hasUnresolvedWorkflowTemplateToken(value) {
  return UNRESOLVED_WORKFLOW_TEMPLATE_TOKEN_RE.test(String(value || ""));
}

function readWorkflowNestedValue(target, path = []) {
  let current = target;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function writeWorkflowNestedValue(target, path = [], value) {
  if (!target || typeof target !== "object" || !Array.isArray(path) || path.length === 0) return;
  let current = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!current[key] || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key];
  }
  current[path[path.length - 1]] = value;
}

function deleteWorkflowNestedValue(target, path = []) {
  if (!target || typeof target !== "object" || !Array.isArray(path) || path.length === 0) return;
  let current = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!current || typeof current !== "object" || !current[key] || typeof current[key] !== "object") {
      return;
    }
    current = current[key];
  }
  if (current && typeof current === "object") {
    delete current[path[path.length - 1]];
  }
}

function recordWorkflowRunIdentityIssue(issues, path, value) {
  if (!Array.isArray(issues) || !Array.isArray(path)) return;
  issues.push({
    path: path.join("."),
    value: normalizeWorkflowRunText(value).trim(),
  });
}

function buildWorkflowRunIdentityValidationMessage(issues = []) {
  const fields = Array.isArray(issues)
    ? issues.map((entry) => String(entry?.path || "").trim()).filter(Boolean)
    : [];
  const preview = fields.slice(0, 6);
  const suffix = fields.length > preview.length ? ` (+${fields.length - preview.length} more)` : "";
  return `workflow run identity validation failed: unresolved template token(s) in ${preview.join(", ")}${suffix}`;
}

function sanitizeWorkflowIdentityField(target, path, issues) {
  const current = readWorkflowNestedValue(target, path);
  const normalizedInput = normalizeWorkflowRunText(current).trim();
  if (!normalizedInput) return;
  const normalizedValue = normalizeWorkflowIdentityText(normalizedInput);
  if (!normalizedValue) {
    if (hasUnresolvedWorkflowTemplateToken(normalizedInput)) {
      recordWorkflowRunIdentityIssue(issues, path, normalizedInput);
    }
    deleteWorkflowNestedValue(target, path);
    return;
  }
  if (normalizedValue !== current) {
    writeWorkflowNestedValue(target, path, normalizedValue);
  }
}

function sanitizeWorkflowRunIdentityPayload(detail = null) {
  const nextDetail = sanitizeJsonValue(detail) || {};
  const issues = [];
  const simpleFieldPaths = [
    ["taskId"],
    ["taskTitle"],
    ["branch"],
    ["branchName"],
    ["data", "taskId"],
    ["data", "activeTaskId"],
    ["data", "taskTitle"],
    ["data", "activeTaskTitle"],
    ["data", "_taskTitle"],
    ["data", "branch"],
    ["data", "branchName"],
    ["data", "_workflowRootTaskId"],
    ["data", "_workflowParentTaskId"],
    ["inputData", "taskId"],
    ["inputData", "taskTitle"],
    ["inputData", "branch"],
    ["inputData", "branchName"],
  ];
  for (const path of simpleFieldPaths) {
    sanitizeWorkflowIdentityField(nextDetail, path, issues);
  }

  const taskObjectPaths = [
    ["data", "task"],
    ["data", "taskInfo"],
    ["data", "taskDetail"],
    ["inputData", "task"],
    ["inputData", "taskInfo"],
    ["inputData", "taskDetail"],
  ];
  for (const path of taskObjectPaths) {
    const taskRecord = readWorkflowNestedValue(nextDetail, path);
    if (!taskRecord || typeof taskRecord !== "object") continue;
    sanitizeWorkflowIdentityField(nextDetail, [...path, "taskId"], issues);
    sanitizeWorkflowIdentityField(nextDetail, [...path, "id"], issues);
    sanitizeWorkflowIdentityField(nextDetail, [...path, "task_id"], issues);
    sanitizeWorkflowIdentityField(nextDetail, [...path, "title"], issues);
    sanitizeWorkflowIdentityField(nextDetail, [...path, "taskTitle"], issues);
    sanitizeWorkflowIdentityField(nextDetail, [...path, "branch"], issues);
    sanitizeWorkflowIdentityField(nextDetail, [...path, "branchName"], issues);
  }

  const topologyPaths = [
    ["delegationTopology"],
    ["data", "_delegationTopology"],
  ];
  for (const path of topologyPaths) {
    const topology = readWorkflowNestedValue(nextDetail, path);
    if (!topology || typeof topology !== "object") continue;
    sanitizeWorkflowIdentityField(nextDetail, [...path, "taskId"], issues);
    sanitizeWorkflowIdentityField(nextDetail, [...path, "rootTaskId"], issues);
    sanitizeWorkflowIdentityField(nextDetail, [...path, "parentTaskId"], issues);
    sanitizeWorkflowIdentityField(nextDetail, [...path, "branch"], issues);
    sanitizeWorkflowIdentityField(nextDetail, [...path, "branchName"], issues);
  }

  const taskEventLists = [
    ["data", "_taskWorkflowEvents"],
  ];
  for (const path of taskEventLists) {
    const events = readWorkflowNestedValue(nextDetail, path);
    if (!Array.isArray(events)) continue;
    for (let index = 0; index < events.length; index += 1) {
      sanitizeWorkflowIdentityField(nextDetail, [...path, index, "id"], issues);
      sanitizeWorkflowIdentityField(nextDetail, [...path, index, "task_id"], issues);
      sanitizeWorkflowIdentityField(nextDetail, [...path, index, "taskId"], issues);
      sanitizeWorkflowIdentityField(nextDetail, [...path, index, "title"], issues);
      sanitizeWorkflowIdentityField(nextDetail, [...path, index, "taskTitle"], issues);
      sanitizeWorkflowIdentityField(nextDetail, [...path, index, "branch"], issues);
      sanitizeWorkflowIdentityField(nextDetail, [...path, index, "branchName"], issues);
    }
  }

  if (issues.length > 0) {
    const validation = {
      code: "invalid_task_identity",
      reason: "unresolved_template_tokens",
      invalidFields: issues.map((entry) => entry.path),
      message: buildWorkflowRunIdentityValidationMessage(issues),
      issueCount: issues.length,
    };
    nextDetail.identityValidation = validation;
    nextDetail.data = nextDetail.data && typeof nextDetail.data === "object"
      ? {
          ...nextDetail.data,
          _workflowIdentityValidation: validation,
        }
      : { _workflowIdentityValidation: validation };
  }

  return {
    detail: nextDetail,
    issues,
    validation: nextDetail.identityValidation || null,
  };
}

function sanitizeWorkflowRunSummaryIdentity(summary = null) {
  if (!summary || typeof summary !== "object") return summary;
  const normalized = { ...summary };
  const issues = [];
  const rawTaskId = normalizeWorkflowRunText(summary.taskId).trim();
  const taskId = normalizeWorkflowIdentityText(rawTaskId);
  if (rawTaskId && !taskId && hasUnresolvedWorkflowTemplateToken(rawTaskId)) {
    recordWorkflowRunIdentityIssue(issues, ["taskId"], rawTaskId);
  }
  normalized.taskId = taskId || null;

  const rawTaskTitle = normalizeWorkflowRunText(summary.taskTitle).trim();
  const taskTitle = normalizeWorkflowIdentityText(rawTaskTitle);
  if (rawTaskTitle && !taskTitle && hasUnresolvedWorkflowTemplateToken(rawTaskTitle)) {
    recordWorkflowRunIdentityIssue(issues, ["taskTitle"], rawTaskTitle);
  }
  normalized.taskTitle = taskTitle || null;

  normalized.taskIds = Array.isArray(summary.taskIds)
    ? summary.taskIds
      .map((value) => {
        const raw = normalizeWorkflowRunText(value).trim();
        const nextValue = normalizeWorkflowIdentityText(raw);
        if (raw && !nextValue && hasUnresolvedWorkflowTemplateToken(raw)) {
          recordWorkflowRunIdentityIssue(issues, ["taskIds"], raw);
        }
        return nextValue;
      })
      .filter(Boolean)
    : [];

  if (summary.delegationTopology && typeof summary.delegationTopology === "object") {
    normalized.delegationTopology = { ...summary.delegationTopology };
    for (const key of ["taskId", "rootTaskId", "parentTaskId", "branch", "branchName"]) {
      const raw = normalizeWorkflowRunText(summary.delegationTopology[key]).trim();
      const nextValue = normalizeWorkflowIdentityText(raw);
      if (raw && !nextValue && hasUnresolvedWorkflowTemplateToken(raw)) {
        recordWorkflowRunIdentityIssue(issues, ["delegationTopology", key], raw);
      }
      if (nextValue) normalized.delegationTopology[key] = nextValue;
      else delete normalized.delegationTopology[key];
    }
  }

  if (issues.length > 0 || summary.invalidTaskIdentity === true) {
    normalized.invalidTaskIdentity = true;
    normalized.identityValidation = {
      code: "invalid_task_identity",
      reason: "unresolved_template_tokens",
      invalidFields: issues.map((entry) => entry.path),
      message: issues.length > 0
        ? buildWorkflowRunIdentityValidationMessage(issues)
        : "workflow run identity validation failed",
      issueCount: issues.length,
    };
  }

  return normalized;
}

function normalizeWorkflowRunTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value || "").trim();
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function repairWorkflowRunDetail(detail = null) {
  if (!detail || typeof detail !== "object") return detail;
  const nextDetail = { ...detail };
  const nextData =
    detail.data && typeof detail.data === "object"
      ? { ...detail.data }
      : null;
  const nextIssueAdvisor =
    detail.issueAdvisor && typeof detail.issueAdvisor === "object"
      ? { ...detail.issueAdvisor }
      : null;

  if (typeof nextDetail.workflowName === "string") {
    nextDetail.workflowName = normalizeWorkflowRunText(nextDetail.workflowName);
  }
  if (typeof nextDetail.taskTitle === "string") {
    nextDetail.taskTitle = normalizeWorkflowRunText(nextDetail.taskTitle);
  }
  if (typeof nextDetail.primaryGoalTitle === "string") {
    nextDetail.primaryGoalTitle = normalizeWorkflowRunText(nextDetail.primaryGoalTitle);
  }
  if (nextIssueAdvisor && typeof nextIssueAdvisor.summary === "string") {
    nextIssueAdvisor.summary = normalizeWorkflowRunText(nextIssueAdvisor.summary);
    nextDetail.issueAdvisor = nextIssueAdvisor;
  }
  if (nextData) {
    for (const key of [
      "_workflowName",
      "workflowName",
      "taskTitle",
      "activeTaskTitle",
      "_workflowTerminalMessage",
      "_taskTitle",
      "primaryGoalTitle",
    ]) {
      if (typeof nextData[key] === "string") {
        nextData[key] = normalizeWorkflowRunText(nextData[key]);
      }
    }
    nextDetail.data = nextData;
  }

  return sanitizeWorkflowRunIdentityPayload(nextDetail).detail;
}

function getRuntimeCwd() {
  return getRuntimeProcess()?.cwd?.() || ".";
}

function readBoundedEnvInt(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(getRuntimeEnv()[name]);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  return Math.min(max, Math.max(min, rounded));
}

const MAX_NODE_RETRIES = readBoundedEnvInt("WORKFLOW_NODE_MAX_RETRIES", 3, {
  min: 0,
  max: 20,
});
const NODE_TIMEOUT_MIN_MS = 1000;
const NODE_TIMEOUT_MAX_MS = 21_600_000;
const NODE_TIMEOUT_MS = readBoundedEnvInt("WORKFLOW_NODE_TIMEOUT_MS", 10 * 60 * 1000, {
  min: NODE_TIMEOUT_MIN_MS,
  max: NODE_TIMEOUT_MAX_MS,
});
const MAX_CONCURRENT_BRANCHES = readBoundedEnvInt("WORKFLOW_MAX_CONCURRENT_BRANCHES", 8, {
  min: 1,
  max: 64,
});
const MAX_CONCURRENT_RUNS = readBoundedEnvInt("WORKFLOW_MAX_CONCURRENT_RUNS", 16, {
  min: 1,
  max: 256,
});
const MAX_PERSISTED_RUNS = readBoundedEnvInt("WORKFLOW_MAX_PERSISTED_RUNS", 2000, {
  min: 20,
  max: 20000,
});
const MAX_INTERRUPTED_ORPHAN_SCAN_FILES = readBoundedEnvInt(
  "WORKFLOW_INTERRUPTED_ORPHAN_SCAN_MAX_FILES",
  200,
  { min: 0, max: 5000 },
);
const INTERRUPTED_ORPHAN_SCAN_WINDOW_MS = readBoundedEnvInt(
  "WORKFLOW_INTERRUPTED_ORPHAN_SCAN_WINDOW_MS",
  7 * 24 * 60 * 60 * 1000,
  { min: 0, max: 90 * 24 * 60 * 60 * 1000 },
);
const INTERRUPTED_RESUME_YIELD_EVERY = readBoundedEnvInt(
  "WORKFLOW_INTERRUPTED_RESUME_YIELD_EVERY",
  25,
  { min: 1, max: 1000 },
);
const DEFAULT_RUN_STUCK_THRESHOLD_MS = readBoundedEnvInt(
  "WORKFLOW_RUN_STUCK_THRESHOLD_MS",
  5 * 60 * 1000,
  { min: 10000, max: 7_200_000 },
);
const MAX_BACK_EDGE_ITERATIONS = readBoundedEnvInt(
  "WORKFLOW_MAX_BACK_EDGE_ITERATIONS",
  20,
  { min: 1, max: 200 },
);

// ── Auto-Retry Defaults ─────────────────────────────────────────────────────
const DEFAULT_AUTO_RETRY_MAX_ATTEMPTS = readBoundedEnvInt(
  "WORKFLOW_AUTO_RETRY_MAX_ATTEMPTS",
  3,
  { min: 0, max: 10 },
);
const DEFAULT_AUTO_RETRY_COOLDOWN_MS = readBoundedEnvInt(
  "WORKFLOW_AUTO_RETRY_COOLDOWN_MS",
  20 * 60 * 1000, // 20 minutes
  { min: 0, max: 3_600_000 },
);
const CHECKPOINT_DEBOUNCE_MS = readBoundedEnvInt(
  "WORKFLOW_CHECKPOINT_DEBOUNCE_MS",
  500,
  { min: 50, max: 10000 },
);
const ACTIVE_RUNS_INDEX = "_active-runs.json";
const MAX_TASK_TRACE_EVENTS_PER_RUN = readBoundedEnvInt(
  "WORKFLOW_TASK_TRACE_MAX_EVENTS",
  250,
  { min: 20, max: 5000 },
);

function resolveWorkflowRootRunId(inputData = {}, opts = {}) {
  return String(
    opts?._rootRunId ||
      inputData?._workflowRootRunId ||
      inputData?._rootRunId ||
      "",
  ).trim() || null;
}

function maybeYieldInterruptedResumeWork(iteration) {
  if (INTERRUPTED_RESUME_YIELD_EVERY <= 0) return null;
  if (iteration % INTERRUPTED_RESUME_YIELD_EVERY !== 0) return null;
  return new Promise((resolve) => setImmediate(resolve));
}

const DEFAULT_DELEGATION_WATCHDOG_TIMEOUT_MS = readBoundedEnvInt(
  "WORKFLOW_DELEGATION_WATCHDOG_TIMEOUT_MS",
  5 * 60 * 1000,
  { min: 1000, max: NODE_TIMEOUT_MAX_MS },
);
const DEFAULT_DELEGATION_WATCHDOG_MAX_RECOVERIES = readBoundedEnvInt(
  "WORKFLOW_DELEGATION_WATCHDOG_MAX_RECOVERIES",
  1,
  { min: 0, max: 10 },
);

function resolveNodeTimeoutMs(node, resolvedConfig) {
  // For gate/approval nodes, `timeoutMs` is the gate's own internal wait
  // limit (how long to poll for approval), NOT the outer execution timeout.
  // If we used it as the engine wrapper timeout they would race — the wrapper
  // would fire at the same instant the gate is trying to return gracefully.
  // Skip `timeoutMs` for these node types and fall through to the default.
  const isGateNode = node?.type === "flow.gate" || node?.type === "harness.approval";

  const candidates = [
    resolvedConfig?.timeout,
    isGateNode ? null : resolvedConfig?.timeoutMs,
    node?.timeout,
    isGateNode ? null : node?.timeoutMs,
    NODE_TIMEOUT_MS,
  ];

  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    return Math.min(
      NODE_TIMEOUT_MAX_MS,
      Math.max(1, Math.round(parsed)),
    );
  }

  return NODE_TIMEOUT_MS;
}

function resolveTraceTaskId(data = {}) {
  return String(
    data?.taskId ||
      data?.task?.id ||
      data?.taskDetail?.id ||
      data?.taskInfo?.id ||
      "",
  ).trim() || null;
}

function resolveTraceAgentId(data = {}, fallback = "") {
  return String(
    data?.agentId ||
      data?.agentProfile ||
      data?.task?.assignee ||
      data?.taskDetail?.assignee ||
      data?.taskInfo?.assignee ||
      fallback ||
      "",
  ).trim() || null;
}

// ── Node Status ─────────────────────────────────────────────────────────────

const WORKFLOW_TEAM_STATE_VERSION = 1;
const WORKFLOW_TEAM_TASK_STATUSES = new Set([
  "open",
  "claimed",
  "completed",
  "released",
  "blocked",
  "cancelled",
]);

function normalizeWorkflowStringList(raw, maxLength = 120) {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(
    raw
      .map((value) => normalizeWorkflowText(value, maxLength))
      .filter(Boolean),
  ));
}

function normalizeWorkflowIsoTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  const text = String(value || "").trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeWorkflowTeamMember(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const memberId = normalizeWorkflowText(
    raw.memberId || raw.id || raw.agentId || raw.name || "",
    120,
  );
  if (!memberId) return null;
  return {
    memberId,
    name: normalizeWorkflowText(raw.name || raw.label || memberId, 160) || memberId,
    role: normalizeWorkflowText(raw.role || raw.coordinationRole || "", 80) || null,
    reportsTo: normalizeWorkflowText(raw.reportsTo || raw.coordinationReportsTo || "", 120) || null,
    level: normalizeWorkflowInteger(raw.level ?? raw.coordinationLevel, { min: 0, max: 100 }),
    channels: normalizeWorkflowStringList(raw.channels, 120),
    tags: normalizeWorkflowStringList(raw.tags, 80),
    skills: normalizeWorkflowStringList(raw.skills, 120),
    metadata:
      raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
        ? sanitizeJsonValue(raw.metadata)
        : {},
    joinedAt:
      normalizeWorkflowIsoTime(raw.joinedAt) ||
      normalizeWorkflowIsoTime(raw.createdAt) ||
      null,
    active: raw.active !== false,
  };
}

function normalizeWorkflowTeamChannel(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const channelId = normalizeWorkflowText(raw.channelId || raw.id || raw.name || "", 120);
  if (!channelId) return null;
  return {
    channelId,
    name: normalizeWorkflowText(raw.name || channelId, 160) || channelId,
    kind: normalizeWorkflowText(raw.kind || "channel", 40) || "channel",
    members: normalizeWorkflowStringList(raw.members, 120),
    topic: normalizeWorkflowText(raw.topic || "", 240) || null,
    metadata:
      raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
        ? sanitizeJsonValue(raw.metadata)
        : {},
    createdAt:
      normalizeWorkflowIsoTime(raw.createdAt) ||
      normalizeWorkflowIsoTime(raw.joinedAt) ||
      null,
  };
}

function normalizeWorkflowTeamClaimHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      action: normalizeWorkflowText(entry.action || "claim", 40) || "claim",
      memberId: normalizeWorkflowText(entry.memberId || entry.actorId || "", 120) || null,
      at:
        normalizeWorkflowIsoTime(entry.at) ||
        normalizeWorkflowIsoTime(entry.timestamp) ||
        new Date().toISOString(),
      note: normalizeWorkflowText(entry.note || "", 240) || null,
    }))
    .sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));
}

function normalizeWorkflowTeamTask(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const taskId = normalizeWorkflowText(raw.taskId || raw.id || "", 120);
  if (!taskId) return null;
  const normalizedStatus = String(raw.status || "open").trim().toLowerCase() || "open";
  return {
    taskId,
    title: normalizeWorkflowText(raw.title || raw.summary || taskId, 240) || taskId,
    description: normalizeWorkflowText(raw.description || raw.details || "", 2000) || null,
    status: WORKFLOW_TEAM_TASK_STATUSES.has(normalizedStatus) ? normalizedStatus : "open",
    priority: normalizeWorkflowText(raw.priority || "", 40) || null,
    availableTo: normalizeWorkflowStringList(raw.availableTo, 120),
    labels: normalizeWorkflowStringList(raw.labels, 80),
    tags: normalizeWorkflowStringList(raw.tags, 80),
    channelId: normalizeWorkflowText(raw.channelId || "", 120) || null,
    createdBy: normalizeWorkflowText(raw.createdBy || raw.actorId || "", 120) || null,
    claimedBy: normalizeWorkflowText(raw.claimedBy || "", 120) || null,
    completedBy: normalizeWorkflowText(raw.completedBy || "", 120) || null,
    releasedBy: normalizeWorkflowText(raw.releasedBy || "", 120) || null,
    createdAt:
      normalizeWorkflowIsoTime(raw.createdAt) ||
      normalizeWorkflowIsoTime(raw.timestamp) ||
      null,
    claimedAt: normalizeWorkflowIsoTime(raw.claimedAt) || null,
    completedAt: normalizeWorkflowIsoTime(raw.completedAt) || null,
    releasedAt: normalizeWorkflowIsoTime(raw.releasedAt) || null,
    claimHistory: normalizeWorkflowTeamClaimHistory(raw.claimHistory),
    metadata:
      raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
        ? sanitizeJsonValue(raw.metadata)
        : {},
  };
}

function normalizeWorkflowTeamMessage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const messageId = normalizeWorkflowText(raw.messageId || raw.id || "", 120);
  if (!messageId) return null;
  return {
    messageId,
    kind: normalizeWorkflowText(raw.kind || (raw.to ? "direct" : "channel"), 40) || "channel",
    fromMemberId:
      normalizeWorkflowText(raw.fromMemberId || raw.from || raw.senderId || "", 120) || null,
    toMemberIds:
      Array.isArray(raw.toMemberIds)
        ? normalizeWorkflowStringList(raw.toMemberIds, 120)
        : normalizeWorkflowStringList(raw.to || [], 120),
    channelId: normalizeWorkflowText(raw.channelId || raw.channel || "", 120) || null,
    subject: normalizeWorkflowText(raw.subject || "", 200) || null,
    content: normalizeWorkflowText(raw.content || raw.message || raw.summary || "", 4000) || null,
    taskId: normalizeWorkflowText(raw.taskId || "", 120) || null,
    metadata:
      raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
        ? sanitizeJsonValue(raw.metadata)
        : {},
    readBy: normalizeWorkflowStringList(raw.readBy, 120),
    createdAt:
      normalizeWorkflowIsoTime(raw.createdAt) ||
      normalizeWorkflowIsoTime(raw.timestamp) ||
      null,
  };
}

function normalizeWorkflowTeamEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const eventId = normalizeWorkflowText(raw.eventId || raw.id || "", 120);
  if (!eventId) return null;
  return {
    eventId,
    type: normalizeWorkflowText(raw.type || raw.eventType || "event", 80) || "event",
    actorId: normalizeWorkflowText(raw.actorId || raw.memberId || "", 120) || null,
    memberId: normalizeWorkflowText(raw.memberId || raw.actorId || "", 120) || null,
    taskId: normalizeWorkflowText(raw.taskId || "", 120) || null,
    messageId: normalizeWorkflowText(raw.messageId || "", 120) || null,
    status: normalizeWorkflowText(raw.status || "", 40) || null,
    summary: normalizeWorkflowText(raw.summary || raw.message || "", 320) || null,
    at:
      normalizeWorkflowIsoTime(raw.at) ||
      normalizeWorkflowIsoTime(raw.timestamp) ||
      new Date().toISOString(),
    metadata:
      raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
        ? sanitizeJsonValue(raw.metadata)
        : {},
  };
}

function normalizeWorkflowTeamState(raw = {}) {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw
      : {};
  const dedupeBy = (items, key) => {
    const map = new Map();
    for (const item of items) {
      const itemKey = String(item?.[key] || "").trim();
      if (!itemKey) continue;
      map.set(itemKey, item);
    }
    return [...map.values()];
  };
  const normalized = {
    version: WORKFLOW_TEAM_STATE_VERSION,
    teamId: normalizeWorkflowText(source.teamId || source.id || "", 120) || null,
    name: normalizeWorkflowText(source.name || source.teamName || "", 160) || null,
    leadId: normalizeWorkflowText(source.leadId || source.ownerId || "", 120) || null,
    defaultChannel: normalizeWorkflowText(source.defaultChannel || "team", 120) || "team",
    initializedAt:
      normalizeWorkflowIsoTime(source.initializedAt) ||
      normalizeWorkflowIsoTime(source.createdAt) ||
      null,
    updatedAt:
      normalizeWorkflowIsoTime(source.updatedAt) ||
      normalizeWorkflowIsoTime(source.initializedAt) ||
      null,
    roster: dedupeBy(
      Array.isArray(source.roster)
        ? source.roster.map((entry) => normalizeWorkflowTeamMember(entry)).filter(Boolean)
        : [],
      "memberId",
    ),
    channels: dedupeBy(
      Array.isArray(source.channels)
        ? source.channels.map((entry) => normalizeWorkflowTeamChannel(entry)).filter(Boolean)
        : [],
      "channelId",
    ),
    tasks: dedupeBy(
      Array.isArray(source.tasks)
        ? source.tasks.map((entry) => normalizeWorkflowTeamTask(entry)).filter(Boolean)
        : [],
      "taskId",
    ).sort((a, b) => {
      const aTime = Date.parse(a.createdAt || a.claimedAt || a.completedAt || 0) || 0;
      const bTime = Date.parse(b.createdAt || b.claimedAt || b.completedAt || 0) || 0;
      return aTime - bTime;
    }),
    messages: dedupeBy(
      Array.isArray(source.messages)
        ? source.messages.map((entry) => normalizeWorkflowTeamMessage(entry)).filter(Boolean)
        : [],
      "messageId",
    ).sort((a, b) => {
      const aTime = Date.parse(a.createdAt || 0) || 0;
      const bTime = Date.parse(b.createdAt || 0) || 0;
      return aTime - bTime;
    }),
    events: dedupeBy(
      Array.isArray(source.events)
        ? source.events.map((entry) => normalizeWorkflowTeamEvent(entry)).filter(Boolean)
        : [],
      "eventId",
    ).sort((a, b) => {
      const aTime = Date.parse(a.at || 0) || 0;
      const bTime = Date.parse(b.at || 0) || 0;
      return aTime - bTime;
    }),
  };
  if (normalized.leadId && !normalized.roster.some((member) => member.memberId === normalized.leadId)) {
    normalized.roster.push({
      memberId: normalized.leadId,
      name: normalized.leadId,
      role: "lead",
      reportsTo: null,
      level: 0,
      channels: [],
      tags: [],
      skills: [],
      metadata: {},
      joinedAt: normalized.initializedAt,
      active: true,
    });
  }
  if (!normalized.channels.some((channel) => channel.channelId === normalized.defaultChannel)) {
    normalized.channels.push({
      channelId: normalized.defaultChannel,
      name: normalized.defaultChannel,
      kind: "channel",
      members: [],
      topic: null,
      metadata: {},
      createdAt: normalized.initializedAt,
    });
  }
  return normalized;
}

function cloneWorkflowTeamState(state) {
  return sanitizeJsonValue(normalizeWorkflowTeamState(state || {})) || null;
}

function hasWorkflowTeamStateData(state) {
  return Boolean(
    state &&
    typeof state === "object" &&
    !Array.isArray(state) &&
    (
      state.teamId ||
      state.leadId ||
      (Array.isArray(state.roster) && state.roster.length > 0) ||
      (Array.isArray(state.tasks) && state.tasks.length > 0) ||
      (Array.isArray(state.messages) && state.messages.length > 0) ||
      (Array.isArray(state.events) && state.events.length > 0)
    )
  );
}

function buildWorkflowTeamSummary(state) {
  const normalized = normalizeWorkflowTeamState(state || {});
  const openTaskCount = normalized.tasks.filter((task) => task.status === "open" || task.status === "released").length;
  const claimedTaskCount = normalized.tasks.filter((task) => task.status === "claimed").length;
  const completedTaskCount = normalized.tasks.filter((task) => task.status === "completed").length;
  const blockedTaskCount = normalized.tasks.filter((task) => task.status === "blocked").length;
  const directMessageCount = normalized.messages.filter((message) => message.kind === "direct").length;
  const channelMessageCount = normalized.messages.length - directMessageCount;
  return {
    teamId: normalized.teamId || null,
    name: normalized.name || null,
    leadId: normalized.leadId || null,
    defaultChannel: normalized.defaultChannel || null,
    rosterCount: normalized.roster.length,
    channelCount: normalized.channels.length,
    taskCount: normalized.tasks.length,
    openTaskCount,
    claimedTaskCount,
    completedTaskCount,
    blockedTaskCount,
    messageCount: normalized.messages.length,
    directMessageCount,
    channelMessageCount,
    eventCount: normalized.events.length,
    lastUpdatedAt: normalized.updatedAt || normalized.initializedAt || null,
  };
}

export const NodeStatus = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  SKIPPED: "skipped",
  WAITING: "waiting",
});

export const WorkflowStatus = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  PAUSED: "paused",
});

// ── Node Type Registry ──────────────────────────────────────────────────────

const _nodeTypeRegistry = new Map();
const _nodeTypeMetaRegistry = new Map();
const _normalizedHandlerCache = new WeakMap();

function clonePortDescriptor(port) {
  if (!port || typeof port !== "object") return null;
  return {
    name: String(port.name || "default").trim() || "default",
    label: String(port.label || port.name || "default").trim() || "default",
    type: String(port.type || "Any").trim() || "Any",
    description: String(port.description || "").trim(),
    color: typeof port.color === "string" && port.color.trim() ? port.color.trim() : null,
    accepts: Array.isArray(port.accepts)
      ? Array.from(new Set(port.accepts.map((value) => String(value || "").trim()).filter(Boolean)))
      : [],
  };
}

function normalizePortDescriptor(port, direction, index) {
  const fallbackName = index === 0 ? "default" : `${direction}-${index + 1}`;
  if (typeof port === "string") {
    return {
      name: fallbackName,
      label: fallbackName,
      type: port,
      description: "",
      color: null,
      accepts: [],
    };
  }

  if (!port || typeof port !== "object") {
    return {
      name: fallbackName,
      label: fallbackName,
      type: "Any",
      description: "",
      color: null,
      accepts: [],
    };
  }

  return clonePortDescriptor({
    ...port,
    name: port.name || fallbackName,
    label: port.label || port.name || fallbackName,
    type: port.type || "Any",
  });
}

function normalizePortList(ports, direction) {
  if (!Array.isArray(ports)) return [];
  return ports
    .map((port, index) => normalizePortDescriptor(port, direction, index))
    .filter(Boolean);
}

function normalizeNodeUi(ui = {}) {
  const primaryFields = Array.isArray(ui?.primaryFields)
    ? Array.from(new Set(ui.primaryFields.map((value) => String(value || "").trim()).filter(Boolean)))
    : [];
  return {
    ...ui,
    primaryFields,
  };
}

function normalizeHandlerMetadata(handler) {
  if (_normalizedHandlerCache.has(handler)) {
    return _normalizedHandlerCache.get(handler);
  }

  const inputPorts = normalizePortList(handler?.inputs ?? handler?.ports?.inputs, "input");
  const outputPorts = normalizePortList(handler?.outputs ?? handler?.ports?.outputs, "output");

  const normalized = {
    ...handler,
    ports: {
      inputs: inputPorts,
      outputs: outputPorts,
    },
    ui: normalizeNodeUi(handler?.ui),
  };
  _normalizedHandlerCache.set(handler, normalized);
  return normalized;
}

function buildNamedPorts(names = [], direction = "output") {
  return Array.from(new Set((Array.isArray(names) ? names : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)))
    .map((name, index) => normalizePortDescriptor({ name, label: name, type: "Any" }, direction, index));
}

function inferLlmParseOutputPorts(node) {
  const outputPortField = String(node?.config?.outputPort || "").trim();
  if (!outputPortField) return [];

  const keywordPorts = Array.isArray(node?.config?.keywords?.[outputPortField])
    ? node.config.keywords[outputPortField]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean)
    : [];

  const pattern = String(node?.config?.patterns?.[outputPortField] || "").trim();
  const match = pattern.match(/\(([^()]+)\)/);
  const patternPorts = match
    ? match[1]
      .split("|")
      .map((value) => value.replace(/^\?:/, "").trim().toLowerCase())
      .filter((value) => value && !value.includes("\\"))
    : [];

  return Array.from(new Set([...keywordPorts, ...patternPorts]));
}

function getConfiguredNodeInputs(node) {
  return buildNamedPorts(node?.inputs, "input");
}

function getConfiguredNodeOutputs(node) {
  const explicitOutputNames = Array.isArray(node?.outputs)
    ? Array.from(new Set(node.outputs.map((value) => String(value || "").trim()).filter(Boolean)))
    : [];

  if (node?.type === "condition.switch") {
    const caseOutputs = Object.values(node?.config?.cases || {})
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const mergedOutputs = Array.from(new Set([
      ...(explicitOutputNames.length > 0 ? explicitOutputNames : ["default"]),
      ...caseOutputs,
    ]));
    return buildNamedPorts(mergedOutputs, "output");
  }

  if (String(node?.type || "").startsWith("condition.")) {
    const mergedOutputs = Array.from(new Set([
      "default",
      ...(explicitOutputNames.length > 0 ? explicitOutputNames : []),
      "yes",
      "no",
    ]));
    return buildNamedPorts(mergedOutputs, "output");
  }

  if (node?.type === "transform.llm_parse") {
    const inferredOutputs = inferLlmParseOutputPorts(node);
    const mergedOutputs = Array.from(new Set([
      ...(explicitOutputNames.length > 0 ? explicitOutputNames : ["default"]),
      ...inferredOutputs,
    ]));
    return buildNamedPorts(mergedOutputs, "output");
  }

  return buildNamedPorts(explicitOutputNames, "output");
}

function resolveNodePorts(node) {
  const rawHandler = node?.type ? _nodeTypeRegistry.get(node.type) : null;
  const handler = rawHandler ? normalizeHandlerMetadata(rawHandler) : null;
  const handlerPorts = handler?.ports || {};
  const inputPorts = normalizePortList(node?.inputPorts, "input");
  const outputPorts = normalizePortList(node?.outputPorts, "output");
  const configuredInputs = getConfiguredNodeInputs(node);
  const configuredOutputs = getConfiguredNodeOutputs(node);
  const handlerInputs = normalizePortList(handlerPorts.inputs, "input");
  const handlerOutputs = normalizePortList(handlerPorts.outputs, "output");

  // Merge explicit outputPorts with configuredOutputs so that type-specific
  // ports (yes/no for conditions, case names for switches, etc.) are always
  // present even when outputPorts was auto-persisted with only "default".
  // When handler ports exist, refresh stored port type/accepts to avoid stale
  // port metadata causing false validation failures after handler updates.
  let resolvedOutputs;
  if (handlerOutputs.length > 0) {
    const handlerByName = new Map(handlerOutputs.map((p) => [p.name, p]));
    const storedBase = outputPorts.length > 0 ? outputPorts : configuredOutputs;
    if (storedBase.length > 0) {
      // Refresh stored ports with handler type/accepts where names match; preserve
      // extra stored ports (dynamic switch/condition outputs not in the handler).
      const refreshed = storedBase.map((p) => {
        const hp = handlerByName.get(p.name);
        return hp ? { ...p, type: hp.type, accepts: hp.accepts } : p;
      });
      const storedNames = new Set(storedBase.map((p) => p.name));
      const extra = configuredOutputs.filter((p) => !storedNames.has(p.name) && !handlerByName.has(p.name));
      const missingHandlerPorts = handlerOutputs.filter((p) => !storedNames.has(p.name));
      resolvedOutputs = [...refreshed, ...extra, ...missingHandlerPorts];
    } else {
      resolvedOutputs = handlerOutputs;
    }
  } else if (outputPorts.length > 0 && configuredOutputs.length > 0) {
    const existingNames = new Set(outputPorts.map((p) => p.name));
    const additional = configuredOutputs.filter((p) => !existingNames.has(p.name));
    resolvedOutputs = [...outputPorts, ...additional];
  } else if (outputPorts.length > 0) {
    resolvedOutputs = outputPorts;
  } else if (configuredOutputs.length > 0) {
    resolvedOutputs = configuredOutputs;
  } else {
    resolvedOutputs = [normalizePortDescriptor({ name: "default", label: "default", type: "Any" }, "output", 0)];
  }

  // For inputs, always prefer the handler definition over persisted ports.
  // Input ports are purely derived from node type registrations — they are never
  // authored by users — so stale persisted types must not override fresh handler
  // definitions (which may have expanded accepts lists in later versions).
  return {
    inputs: handlerInputs.length > 0
      ? handlerInputs
      : (inputPorts.length > 0
        ? inputPorts
        : (configuredInputs.length > 0
          ? configuredInputs
          : [normalizePortDescriptor({ name: "default", label: "default", type: "Any" }, "input", 0)])),
    outputs: resolvedOutputs,
  };
}

function resolvePortByName(ports, requestedName, direction) {
  if (!Array.isArray(ports) || ports.length === 0) return null;
  const normalizedName = String(requestedName || "").trim();
  if (!normalizedName) return ports[0];
  const directMatch = ports.find((port) => port.name === normalizedName);
  if (directMatch) return directMatch;

  if (direction === "output") {
    if (normalizedName === "true") {
      return ports.find((port) => port.name === "yes") || null;
    }
    if (normalizedName === "false") {
      return ports.find((port) => port.name === "no") || null;
    }
  }

  return null;
}

function resolveRequestedPortName(edge, key, alias) {
  return String(edge?.[key] ?? edge?.[alias] ?? "").trim();
}

function buildUnknownPortValidationIssue(edge, direction, requestedPortName, availablePorts = []) {
  const safeRequestedPortName = String(requestedPortName || "").trim() || "default";
  const portLabel = direction === "output" ? "output" : "input";
  const availableNames = (Array.isArray(availablePorts) ? availablePorts : [])
    .map((port) => String(port?.name || "").trim())
    .filter(Boolean);
  const availableSuffix = availableNames.length
    ? ` Available ${portLabel} ports: ${availableNames.join(", ")}.`
    : "";

  return {
    edgeId: edge.id || `${edge.source}->${edge.target}`,
    source: edge.source,
    target: edge.target,
    sourcePort: direction === "output"
      ? safeRequestedPortName
      : String(resolveRequestedPortName(edge, "sourcePort", "fromPort") || "default").trim() || "default",
    targetPort: direction === "input"
      ? safeRequestedPortName
      : String(resolveRequestedPortName(edge, "targetPort", "toPort") || "default").trim() || "default",
    sourceType: null,
    targetType: null,
    severity: "error",
    message: `Unknown ${portLabel} port "${safeRequestedPortName}" on edge ${edge.id || `${edge.source}->${edge.target}`}.${availableSuffix}`,
  };
}

function isWildcardPortType(type) {
  const normalized = String(type || "").trim();
  return normalized === "*" || normalized === "Any";
}

function normalizePortTypeForCompatibility(type) {
  const normalized = String(type || "").trim();
  if (!normalized) return "Any";
  const lowered = normalized.toLowerCase();
  if (["*", "any"].includes(lowered)) return "Any";
  if (["taskdef"].includes(lowered)) return "json";
  if (["json", "object"].includes(lowered)) return "json";
  if (["string", "text"].includes(lowered)) return "string";
  if (["boolean", "bool"].includes(lowered)) return "boolean";
  if (["number", "numeric", "float", "int", "integer"].includes(lowered)) return "number";
  return lowered;
}

export function isPortConnectionCompatible(sourcePort, targetPort) {
  if (!sourcePort || !targetPort) {
    return { compatible: true, reason: null };
  }

  const sourceType = String(sourcePort.type || "Any").trim() || "Any";
  const targetType = String(targetPort.type || "Any").trim() || "Any";
  const normalizedSourceType = normalizePortTypeForCompatibility(sourceType);
  const normalizedTargetType = normalizePortTypeForCompatibility(targetType);
  const accepted = new Set(
    [targetType, ...(Array.isArray(targetPort.accepts) ? targetPort.accepts : [])]
      .map((value) => normalizePortTypeForCompatibility(value))
      .filter(Boolean),
  );

  if (
    isWildcardPortType(sourceType)
    || isWildcardPortType(targetType)
    || accepted.has(normalizePortTypeForCompatibility("*"))
    || accepted.has(normalizePortTypeForCompatibility("Any"))
  ) {
    return { compatible: true, reason: null };
  }

  if (normalizedSourceType === normalizedTargetType || accepted.has(normalizedSourceType)) {
    return { compatible: true, reason: null };
  }

  return {
    compatible: false,
    reason: `${sourcePort.label || sourcePort.name} emits ${sourceType}, but ${targetPort.label || targetPort.name} expects ${targetType}`,
  };
}

function getExplicitNodeOutputs(node) {
  return Array.isArray(node?.outputs)
    ? Array.from(new Set(node.outputs.map((value) => String(value || "").trim()).filter(Boolean)))
    : undefined;
}

function hydrateWorkflowNode(node, nodeMap) {
  const ports = resolveNodePorts(node);
  const explicitOutputs = getExplicitNodeOutputs(node);
  const nextNode = {
    ...node,
    inputPorts: ports.inputs.map((port) => clonePortDescriptor(port)),
    outputPorts: ports.outputs.map((port) => clonePortDescriptor(port)),
    ...(explicitOutputs !== undefined ? { outputs: explicitOutputs } : {}),
  };
  nodeMap.set(nextNode.id, nextNode);
  return nextNode;
}

function buildPortValidationIssue(edge, sourcePort, targetPort, compatibility) {
  return {
    edgeId: edge.id || `${edge.source}->${edge.target}`,
    source: edge.source,
    target: edge.target,
    sourcePort: sourcePort?.name || "default",
    targetPort: targetPort?.name || "default",
    sourceType: sourcePort?.type || null,
    targetType: targetPort?.type || null,
    severity: "error",
    message: compatibility.reason,
  };
}

function hydrateWorkflowEdge(edge, nodeMap, issues) {
  const sourceNode = nodeMap.get(edge.source);
  const targetNode = nodeMap.get(edge.target);
  const sourcePorts = resolveNodePorts(sourceNode);
  const targetPorts = resolveNodePorts(targetNode);
  const requestedSourcePortName = resolveRequestedPortName(edge, "sourcePort", "fromPort");
  const requestedTargetPortName = resolveRequestedPortName(edge, "targetPort", "toPort");
  const sourcePort = resolvePortByName(
    sourcePorts.outputs,
    requestedSourcePortName || "default",
    "output",
  );
  const targetPort = resolvePortByName(
    targetPorts.inputs,
    requestedTargetPortName || "default",
    "input",
  );

  if (requestedSourcePortName && !sourcePort) {
    issues.push(buildUnknownPortValidationIssue(edge, "output", requestedSourcePortName, sourcePorts.outputs));
  }
  if (requestedTargetPortName && !targetPort) {
    issues.push(buildUnknownPortValidationIssue(edge, "input", requestedTargetPortName, targetPorts.inputs));
  }

  if (sourcePort && targetPort) {
    const compatibility = isPortConnectionCompatible(sourcePort, targetPort);
    if (!compatibility.compatible) {
      issues.push(buildPortValidationIssue(edge, sourcePort, targetPort, compatibility));
    }
  }

  return {
    ...edge,
    sourcePort: sourcePort?.name || requestedSourcePortName || "default",
    targetPort: targetPort?.name || requestedTargetPortName || "default",
    sourcePortType: sourcePort?.type || null,
    targetPortType: targetPort?.type || null,
  };
}

function hydrateWorkflowDefinition(def, { strict = false } = {}) {
  const normalized = {
    ...(def || {}),
    nodes: Array.isArray(def?.nodes) ? def.nodes.map((node) => ({ ...node })) : [],
    edges: Array.isArray(def?.edges) ? def.edges.map((edge) => ({ ...edge })) : [],
    metadata: { ...(def?.metadata || {}) },
  };

  const nodeMap = new Map();
  normalized.nodes = normalized.nodes.map((node) => hydrateWorkflowNode(node, nodeMap));

  const issues = [];
  normalized.edges = normalized.edges.map((edge) => hydrateWorkflowEdge(edge, nodeMap, issues));
  normalized.metadata.validationIssues = issues;

  if (strict && issues.length > 0) {
    throw new Error(`Workflow port validation failed: ${issues.map((issue) => issue.message).join("; ")}`);
  }

  return normalized;
}

function cloneRunSnapshot(value) {
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch {}
  return JSON.parse(JSON.stringify(value));
}

function sanitizeJsonValue(value, seen = new WeakSet()) {
  if (value == null) return value;
  const valueType = typeof value;
  if (
    valueType === "string" ||
    valueType === "number" ||
    valueType === "boolean"
  ) {
    return value;
  }
  if (valueType === "bigint") return String(value);
  if (valueType === "function" || valueType === "symbol") return undefined;
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isFinite(ts) ? value.toISOString() : null;
  }
  if (value instanceof Error) {
    return cleanObject({
      name: value.name || "Error",
      message: value.message || String(value),
      stack: value.stack || undefined,
    });
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }
  if (valueType !== "object") {
    return String(value);
  }
  const ctorName = String(value?.constructor?.name || "");
  if (
    ctorName === "Timeout" ||
    ctorName === "Immediate" ||
    ctorName === "AbortSignal" ||
    ctorName === "Promise"
  ) {
    return `[${ctorName}]`;
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => {
        const sanitized = sanitizeJsonValue(entry, seen);
        return sanitized === undefined ? null : sanitized;
      });
    }
    if (value instanceof Map) {
      const out = {};
      for (const [entryKey, entryValue] of value.entries()) {
        const normalizedKey = String(entryKey || "").trim();
        if (!normalizedKey) continue;
        const sanitized = sanitizeJsonValue(entryValue, seen);
        if (sanitized !== undefined) out[normalizedKey] = sanitized;
      }
      return out;
    }
    if (value instanceof Set) {
      const out = [];
      for (const entry of value.values()) {
        const sanitized = sanitizeJsonValue(entry, seen);
        if (sanitized !== undefined) out.push(sanitized);
      }
      return out;
    }
    const out = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      const sanitized = sanitizeJsonValue(entryValue, seen);
      if (sanitized !== undefined) out[entryKey] = sanitized;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function cleanObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

const MAX_PERSISTED_RUN_STRING_LENGTH = 4_000;
const MAX_PERSISTED_RUN_COMMAND_OUTPUT_LENGTH = 128_000;
const MAX_PERSISTED_RUN_ARRAY_ITEMS = 25;
const MAX_PERSISTED_RUN_OBJECT_KEYS = 40;
const MAX_PERSISTED_RUN_DEPTH = 6;
const MAX_PERSISTED_RUN_LOG_ENTRIES = 400;
const MAX_PERSISTED_RUN_EVENT_ENTRIES = 600;

function truncatePersistedRunString(value, limit = MAX_PERSISTED_RUN_STRING_LENGTH) {
  const text = String(value ?? "");
  if (!text) return text;
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function resolvePersistedRunStringLimit(key = "") {
  return key === "output"
    ? MAX_PERSISTED_RUN_COMMAND_OUTPUT_LENGTH
    : MAX_PERSISTED_RUN_STRING_LENGTH;
}

function shouldPreservePersistedFullInlineCommandOutput(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.output !== "string") return false;
  const budgetPolicy = String(
    value.outputBudgetPolicy || value.outputContextEnvelope?.meta?.budgetPolicy || "",
  ).trim().toLowerCase();
  if (budgetPolicy !== "full-inline") return false;
  const excerptStrategy = String(value.outputContextEnvelope?.meta?.excerptStrategy || "")
    .trim()
    .toLowerCase();
  if (excerptStrategy && excerptStrategy !== "full") return false;
  const originalChars = Number(
    value.rawOutputChars || value.outputContextEnvelope?.meta?.originalChars || 0,
  );
  const compactedChars = Number(
    value.compactedOutputChars || value.outputContextEnvelope?.meta?.compactedChars || 0,
  );
  if (originalChars > 0 && compactedChars > 0 && originalChars !== compactedChars) {
    return false;
  }
  return true;
}

function buildPersistedValueSummary(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return `[Array(${value.length})]`;
  if (typeof value === "object") {
    const ctorName = String(value?.constructor?.name || "Object");
    const keyCount = Object.keys(value || {}).length;
    return `[${ctorName} keys=${keyCount}]`;
  }
  return truncatePersistedRunString(value, 200);
}

function summarizePersistedTaskMeta(meta = {}) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const worktreeFailure = meta.worktreeFailure && typeof meta.worktreeFailure === "object"
    ? cleanObject({
        branch: truncatePersistedRunString(meta.worktreeFailure.branch, 240) || undefined,
        repoRoot: truncatePersistedRunString(meta.worktreeFailure.repoRoot, 400) || undefined,
        worktreePath: truncatePersistedRunString(meta.worktreeFailure.worktreePath, 400) || undefined,
        baseBranch: truncatePersistedRunString(meta.worktreeFailure.baseBranch, 120) || undefined,
        defaultTargetBranch: truncatePersistedRunString(
          meta.worktreeFailure.defaultTargetBranch,
          120,
        ) || undefined,
      })
    : undefined;
  const autoRecovery = meta.autoRecovery && typeof meta.autoRecovery === "object"
    ? cleanObject({
        active: meta.autoRecovery.active === true,
        recoveredAt: truncatePersistedRunString(meta.autoRecovery.recoveredAt, 120) || undefined,
        recoveredStatus: truncatePersistedRunString(
          meta.autoRecovery.recoveredStatus,
          120,
        ) || undefined,
      })
    : undefined;
  const summary = cleanObject({
    blockedReason: truncatePersistedRunString(meta.blockedReason, 240) || undefined,
    repairState: truncatePersistedRunString(meta.repairState, 120) || undefined,
    worktreeFailure: worktreeFailure && Object.keys(worktreeFailure).length > 0
      ? worktreeFailure
      : undefined,
    autoRecovery: autoRecovery && Object.keys(autoRecovery).length > 0
      ? autoRecovery
      : undefined,
    prLinkageCount: Array.isArray(meta.prLinkage) ? meta.prLinkage.length : undefined,
    timelineCount: Array.isArray(meta.timeline) ? meta.timeline.length : undefined,
    statusHistoryCount: Array.isArray(meta.statusHistory) ? meta.statusHistory.length : undefined,
    commentCount: Array.isArray(meta.comments) ? meta.comments.length : undefined,
    attachmentCount: Array.isArray(meta.attachments) ? meta.attachments.length : undefined,
  });
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function isTaskLikePersistedValue(value, { key = "" } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const normalizedKey = String(key || "").trim().toLowerCase();
  if (
    normalizedKey.includes("workflowevents")
    || normalizedKey.includes("traceevents")
    || value?.eventType
    || (
      normalizedKey === "tasks" &&
      (
        value?.claimedBy != null ||
        value?.completedBy != null ||
        value?.assignee != null ||
        value?.memberId != null ||
        value?.channelId != null
      )
    )
  ) {
    return false;
  }
  if (
    Array.isArray(value?.nodes) ||
    Array.isArray(value?.edges) ||
    Array.isArray(value?._taskWorkflowEvents) ||
    Array.isArray(value?.goalAncestry) ||
    Array.isArray(value?.delegationAuditTrail) ||
    Array.isArray(value?.delegationTrail) ||
    (value?._workflowTeamState && typeof value._workflowTeamState === "object") ||
    (value?.workflowTeamState && typeof value.workflowTeamState === "object") ||
    (value?.delegationTopology && typeof value.delegationTopology === "object") ||
    value.sessionId ||
    value.threadId
  ) {
    return false;
  }
  const keySignalsTask =
    normalizedKey === "task" ||
    normalizedKey === "taskinfo" ||
    normalizedKey === "taskdetail" ||
    normalizedKey.endsWith("task");
  const hasTaskIdentity = Boolean(
    value.taskId ||
    value.taskTitle ||
    ((value.id || value.title) && (value.status !== undefined || value.branch || value.branchName)) ||
    value.meta?.worktreeFailure,
  );
  const hasTaskLocation = Boolean(
    value.branch ||
    value.branchName ||
    value.repoRoot ||
    value.worktreePath ||
    value.baseBranch ||
    value.defaultTargetBranch ||
    value.meta?.worktreeFailure,
  );
  const hasTaskState = value.status !== undefined || Boolean(value.meta?.worktreeFailure);
  if (!hasTaskIdentity && !keySignalsTask) return false;
  return keySignalsTask || hasTaskLocation || hasTaskState;
}

function summarizePersistedTaskValue(value, { key = "" } = {}) {
  if (!isTaskLikePersistedValue(value, { key })) return value;
  const taskId = truncatePersistedRunString(value.taskId || value.id, 160) || undefined;
  const taskTitle = truncatePersistedRunString(value.taskTitle || value.title, 240) || undefined;
  const branchName = truncatePersistedRunString(value.branchName || value.branch, 240) || undefined;
  const taskSummary = cleanObject({
    id: taskId,
    taskId,
    title: taskTitle,
    taskTitle,
    status: truncatePersistedRunString(value.status, 80) || undefined,
    branch: branchName,
    branchName,
    repoRoot: truncatePersistedRunString(value.repoRoot || value.workspace, 400) || undefined,
    worktreePath: truncatePersistedRunString(value.worktreePath, 400) || undefined,
    repository: truncatePersistedRunString(value.repository, 200) || undefined,
    baseBranch: truncatePersistedRunString(value.baseBranch, 120) || undefined,
    defaultTargetBranch: truncatePersistedRunString(value.defaultTargetBranch, 120) || undefined,
    meta: summarizePersistedTaskMeta(value.meta),
  });
  return Object.keys(taskSummary).length > 0 ? taskSummary : buildPersistedValueSummary(value);
}

function summarizePersistedLoopResult(result, depth) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return summarizePersistedWorkflowValue(result, { depth, key: "result" });
  }
  return cleanObject({
    index: Number.isFinite(Number(result.index)) ? Number(result.index) : undefined,
    success: result.success === true,
    queued: result.queued === true || undefined,
    mode: truncatePersistedRunString(result.mode, 80) || undefined,
    workflowId: truncatePersistedRunString(result.workflowId, 160) || undefined,
    runId: truncatePersistedRunString(result.runId, 160) || undefined,
    error: result.error
      ? summarizePersistedWorkflowValue(result.error, { depth: depth + 1, key: "error" })
      : undefined,
    item: result.item
      ? summarizePersistedWorkflowValue(result.item, { depth: depth + 1, key: "item" })
      : undefined,
  });
}

function summarizePersistedArray(value, { depth = 0, key = "" } = {}) {
  const normalized = Array.isArray(value) ? value : [];
  const limit = key === "logs"
    ? MAX_PERSISTED_RUN_LOG_ENTRIES
    : key === "nodeStatusEvents"
      ? MAX_PERSISTED_RUN_EVENT_ENTRIES
      : key === "results"
        ? 20
        : key === "output"
          ? 20
          : key === "timeline" || key === "statusHistory"
            ? 12
            : MAX_PERSISTED_RUN_ARRAY_ITEMS;
  const out = normalized
    .slice(0, limit)
    .map((entry) => summarizePersistedWorkflowValue(entry, { depth: depth + 1, key }));
  if (normalized.length > limit) {
    out.push({ _truncatedItems: normalized.length - limit });
  }
  return out;
}

function summarizePersistedObject(value, { depth = 0, key = "" } = {}) {
  if (isTaskLikePersistedValue(value, { key })) {
    return summarizePersistedTaskValue(value, { key });
  }

  if (
    Array.isArray(value?.results) &&
    (value?.variable !== undefined || value?.count !== undefined || value?.totalItems !== undefined)
  ) {
    return cleanObject({
      count: Number.isFinite(Number(value.count)) ? Number(value.count) : undefined,
      totalItems: Number.isFinite(Number(value.totalItems)) ? Number(value.totalItems) : undefined,
      variable: truncatePersistedRunString(value.variable, 120) || undefined,
      successCount: Number.isFinite(Number(value.successCount)) ? Number(value.successCount) : undefined,
      failCount: Number.isFinite(Number(value.failCount)) ? Number(value.failCount) : undefined,
      items: Array.isArray(value.items)
        ? summarizePersistedArray(value.items, { depth: depth + 1, key: "items" })
        : undefined,
      results: summarizePersistedArray(value.results, { depth: depth + 1, key: "results" }),
    });
  }

  const entries = Object.entries(value || {});
  const limit = key === "nodeOutputs"
    ? 80
    : key === "nodeInputs"
      ? 40
      : MAX_PERSISTED_RUN_OBJECT_KEYS;
  const out = {};
  const preserveFullInlineOutput = shouldPreservePersistedFullInlineCommandOutput(value);
  for (const [entryKey, entryValue] of entries.slice(0, limit)) {
    if (preserveFullInlineOutput && entryKey === "output" && typeof entryValue === "string") {
      out[entryKey] = String(entryValue);
      continue;
    }
    out[entryKey] = summarizePersistedWorkflowValue(entryValue, {
      depth: depth + 1,
      key: entryKey,
    });
  }
  if (entries.length > limit) out._truncatedKeys = entries.length - limit;
  return out;
}

function summarizePersistedWorkflowValue(value, { depth = 0, key = "" } = {}) {
  if (value == null) return value;
  const valueType = typeof value;
  if (valueType === "string") {
    return truncatePersistedRunString(value, resolvePersistedRunStringLimit(key));
  }
  if (valueType === "number" || valueType === "boolean") return value;
  if (valueType === "bigint") return String(value);
  if (valueType === "function" || valueType === "symbol") return undefined;
  if (depth >= MAX_PERSISTED_RUN_DEPTH) return buildPersistedValueSummary(value);
  if (Array.isArray(value)) return summarizePersistedArray(value, { depth, key });
  if (valueType === "object") return summarizePersistedObject(value, { depth, key });
  return truncatePersistedRunString(value, resolvePersistedRunStringLimit(key));
}

function preservePersistedRunIdentityData(sourceData, summarizedData) {
  if (!sourceData || typeof sourceData !== "object") return summarizedData;

  const nextData =
    summarizedData && typeof summarizedData === "object" && !Array.isArray(summarizedData)
      ? { ...summarizedData }
      : {};

  for (const key of [
    "taskId",
    "activeTaskId",
    "taskTitle",
    "_taskTitle",
    "activeTaskTitle",
    "branchName",
    "_workflowName",
    "workflowName",
  ]) {
    if (nextData[key] !== undefined) continue;
    const value = summarizePersistedWorkflowValue(sourceData[key], {
      depth: 1,
      key,
    });
    if (value !== undefined) nextData[key] = value;
  }

  for (const key of ["task", "taskInfo", "taskDetail"]) {
    const value = sourceData[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (nextData[key] !== undefined) continue;
    const summarized = summarizePersistedTaskValue(value, { key });
    if (summarized !== undefined) nextData[key] = summarized;
  }

  return nextData;
}

function compactPersistedRunDetail(detail = {}) {
  const nextDetail = detail && typeof detail === "object" ? { ...detail } : {};
  if (nextDetail.data && typeof nextDetail.data === "object") {
    const sourceData = nextDetail.data;
    nextDetail.data = summarizePersistedWorkflowValue(sourceData, { key: "data" });
    nextDetail.data = preservePersistedRunIdentityData(sourceData, nextDetail.data);
  }
  if (nextDetail.nodeOutputs && typeof nextDetail.nodeOutputs === "object") {
    nextDetail.nodeOutputs = summarizePersistedWorkflowValue(nextDetail.nodeOutputs, {
      key: "nodeOutputs",
    });
  }
  if (nextDetail.nodeInputs && typeof nextDetail.nodeInputs === "object") {
    nextDetail.nodeInputs = summarizePersistedWorkflowValue(nextDetail.nodeInputs, {
      key: "nodeInputs",
    });
  }
  if (Array.isArray(nextDetail.logs)) {
    nextDetail.logs = summarizePersistedArray(nextDetail.logs, { key: "logs" });
  }
  if (Array.isArray(nextDetail.errors)) {
    nextDetail.errors = summarizePersistedArray(nextDetail.errors, { key: "errors" });
  }
  if (Array.isArray(nextDetail.nodeStatusEvents)) {
    nextDetail.nodeStatusEvents = summarizePersistedArray(nextDetail.nodeStatusEvents, {
      key: "nodeStatusEvents",
    });
  }
  if (nextDetail.workflowDefinition && typeof nextDetail.workflowDefinition === "object") {
    nextDetail.workflowDefinition = summarizePersistedWorkflowValue(
      nextDetail.workflowDefinition,
      { key: "workflowDefinition" },
    );
  }
  if (nextDetail.dagState && typeof nextDetail.dagState === "object") {
    nextDetail.dagState = summarizePersistedWorkflowValue(nextDetail.dagState, {
      key: "dagState",
    });
  }
  if (nextDetail.issueAdvisor && typeof nextDetail.issueAdvisor === "object") {
    nextDetail.issueAdvisor = summarizePersistedWorkflowValue(nextDetail.issueAdvisor, {
      key: "issueAdvisor",
    });
  }
  return nextDetail;
}

function normalizeWorkflowText(value, maxLength = 240) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (!Number.isFinite(maxLength) || maxLength <= 0 || text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeWorkflowInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.trunc(parsed);
  return Math.max(min, Math.min(max, rounded));
}

function normalizeGoalAncestry(raw, fallbackGoal = null) {
  const source = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.goalAncestry)
      ? raw.goalAncestry
      : Array.isArray(raw?.ancestry)
        ? raw.ancestry
        : [];
  const normalized = source
    .filter((entry) => entry && typeof entry === "object")
    .map((entry, index) => {
      const goalId = normalizeWorkflowText(
        entry.goalId || entry.id || entry.goal?.id || entry.goal?.goalId || "",
        160,
      );
      const title = normalizeWorkflowText(
        entry.title || entry.goalTitle || entry.name || entry.goal?.title || entry.goal?.name || "",
        240,
      );
      const depth = normalizeWorkflowInteger(entry.depth ?? index, { min: 0, max: 1_000 });
      if (!goalId && !title) return null;
      return cleanObject({
        goalId: goalId || null,
        title: title || null,
        parentGoalId: normalizeWorkflowText(entry.parentGoalId || entry.parentId || "", 160) || null,
        kind: normalizeWorkflowText(entry.kind || entry.type || "", 80) || null,
        status: normalizeWorkflowText(entry.status || "", 80) || null,
        source: normalizeWorkflowText(entry.source || "", 120) || null,
        depth,
      });
    })
    .filter(Boolean);
  if (normalized.length > 0) return normalized;

  if (!fallbackGoal || typeof fallbackGoal !== "object") return [];
  const fallbackGoalId = normalizeWorkflowText(fallbackGoal.goalId || fallbackGoal.id || "", 160);
  const fallbackTitle = normalizeWorkflowText(fallbackGoal.title || fallbackGoal.name || "", 240);
  if (!fallbackGoalId && !fallbackTitle) return [];
  return [cleanObject({
    goalId: fallbackGoalId || null,
    title: fallbackTitle || null,
    kind: normalizeWorkflowText(fallbackGoal.kind || fallbackGoal.type || "", 80) || null,
    status: normalizeWorkflowText(fallbackGoal.status || "", 80) || null,
    source: normalizeWorkflowText(fallbackGoal.source || "", 120) || null,
    depth: 0,
  })];
}

function buildGoalState(data = {}) {
  const primaryGoalSource =
    data?.primaryGoal ||
    data?._primaryGoal ||
    data?.goal ||
    data?._goal ||
    null;
  const goalAncestry = normalizeGoalAncestry(
    data?.goalAncestry || data?._goalAncestry || data?.workflowGoalAncestry || data?._workflowGoalAncestry,
    primaryGoalSource,
  );
  const primaryGoal = goalAncestry.at(-1) || null;
  return {
    goalAncestry,
    primaryGoalId: primaryGoal?.goalId || normalizeWorkflowText(data?.primaryGoalId || data?._primaryGoalId || "", 160) || null,
    primaryGoalTitle: primaryGoal?.title || normalizeWorkflowText(data?.primaryGoalTitle || data?._primaryGoalTitle || "", 240) || null,
    goalDepth: primaryGoal ? normalizeWorkflowInteger(primaryGoal.depth, { min: 0, max: 1_000 }) ?? Math.max(goalAncestry.length - 1, 0) : null,
  };
}

function normalizeHeartbeatRun(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const runId = normalizeWorkflowText(raw.runId || raw.heartbeatRunId || raw.id || "", 160);
  const status = normalizeWorkflowText(raw.status || raw.state || "", 80);
  const sourceRunId = normalizeWorkflowText(raw.sourceRunId || raw.parentRunId || raw.originRunId || "", 160);
  const wakeAt = normalizeWorkflowText(raw.wakeAt || raw.resumeAt || raw.nextWakeAt || "", 80);
  const lastHeartbeatAt = normalizeWorkflowText(raw.lastHeartbeatAt || raw.heartbeatAt || raw.lastSeenAt || "", 80);
  const attempt = normalizeWorkflowInteger(raw.attempt ?? raw.retryCount, { min: 0, max: 10_000 });
  if (!runId && !status && !sourceRunId && !wakeAt && !lastHeartbeatAt && attempt == null) return null;
  return cleanObject({
    runId: runId || null,
    status: status || null,
    sourceRunId: sourceRunId || null,
    wakeAt: wakeAt || null,
    lastHeartbeatAt: lastHeartbeatAt || null,
    trigger: normalizeWorkflowText(raw.trigger || raw.reason || "", 160) || null,
    attempt,
  });
}

function normalizeWakeupRequest(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const requestId = normalizeWorkflowText(raw.requestId || raw.id || raw.wakeupRequestId || "", 160);
  const source = normalizeWorkflowText(raw.source || raw.reason || raw.trigger || "", 160);
  const requestedAt = normalizeWorkflowText(raw.requestedAt || raw.createdAt || "", 80);
  const wakeAt = normalizeWorkflowText(raw.wakeAt || raw.resumeAt || raw.scheduledFor || "", 80);
  if (!requestId && !source && !requestedAt && !wakeAt) return null;
  return cleanObject({
    requestId: requestId || null,
    source: source || null,
    requestedAt: requestedAt || null,
    wakeAt: wakeAt || null,
    taskId: normalizeWorkflowText(raw.taskId || "", 160) || null,
    sessionId: normalizeWorkflowText(raw.sessionId || raw.threadId || "", 160) || null,
  });
}

function normalizeBudgetPolicy(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const budgetWindow = normalizeWorkflowText(raw.budgetWindow || raw.window || raw.period || "", 160);
  const budgetCents = normalizeWorkflowInteger(raw.budgetCents ?? raw.limitCents ?? raw.limit, { min: 0 });
  const spentCents = normalizeWorkflowInteger(raw.spentCents ?? raw.usedCents ?? raw.actualCents ?? raw.spent, { min: 0 });
  const reservedCents = normalizeWorkflowInteger(raw.reservedCents ?? raw.pendingCents, { min: 0 });
  const remainingCents = normalizeWorkflowInteger(
    raw.remainingCents ?? (budgetCents != null ? budgetCents - (spentCents || 0) - (reservedCents || 0) : null),
    { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER },
  );
  const nearLimitThreshold = normalizeWorkflowInteger(raw.nearLimitThresholdCents ?? raw.warningCents, { min: 0 });
  if (budgetWindow == null && budgetCents == null && spentCents == null && reservedCents == null && remainingCents == null) return null;
  return cleanObject({
    budgetWindow: budgetWindow || null,
    budgetCents,
    spentCents: spentCents ?? 0,
    reservedCents: reservedCents ?? 0,
    remainingCents,
    nearLimitThresholdCents: nearLimitThreshold,
    currency: normalizeWorkflowText(raw.currency || "USD", 16) || "USD",
    approvalRequired: raw.approvalRequired === true,
    owner: normalizeWorkflowText(raw.owner || raw.team || "", 160) || null,
  });
}

function buildBudgetOutcome(policy = null) {
  if (!policy || typeof policy !== "object") return null;
  const budgetCents = normalizeWorkflowInteger(policy.budgetCents, { min: 0 });
  const spentCents = normalizeWorkflowInteger(policy.spentCents, { min: 0 }) ?? 0;
  const reservedCents = normalizeWorkflowInteger(policy.reservedCents, { min: 0 }) ?? 0;
  const effectiveSpend = spentCents + reservedCents;
  const remainingCents = normalizeWorkflowInteger(
    policy.remainingCents ?? (budgetCents != null ? budgetCents - effectiveSpend : null),
    { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER },
  );
  const utilizationRatio = budgetCents && budgetCents > 0
    ? Math.max(0, Number((effectiveSpend / budgetCents).toFixed(3)))
    : 0;
  const nearLimitThreshold = normalizeWorkflowInteger(policy.nearLimitThresholdCents, { min: 0 });
  const exceeded = budgetCents != null ? effectiveSpend > budgetCents : false;
  const nearLimit = !exceeded && budgetCents != null
    ? (
        (nearLimitThreshold != null && remainingCents != null && remainingCents <= nearLimitThreshold) ||
        utilizationRatio >= 0.9
      )
    : false;
  return cleanObject({
    status: exceeded ? "exceeded" : (nearLimit ? "near_limit" : "ok"),
    budgetCents,
    spentCents,
    reservedCents,
    remainingCents,
    utilizationRatio,
    exceeded,
    nearLimit,
    approvalRequired: policy.approvalRequired === true,
  });
}

function normalizePolicyViolation(entry = {}, index = 0) {
  const ruleId = normalizeWorkflowText(entry.ruleId || entry.id || `${index}`, 160);
  const message = normalizeWorkflowText(entry.message || entry.reason || entry.summary || "", 260);
  if (!ruleId && !message) return null;
  return cleanObject({
    ruleId: ruleId || null,
    message: message || null,
    severity: normalizeWorkflowText(entry.severity || "warning", 40) || "warning",
    blocking: entry.blocking === true || entry.blocked === true,
    nodeId: normalizeWorkflowText(entry.nodeId || "", 160) || null,
  });
}

function normalizeExecutionPolicy(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const violations = Array.isArray(raw.violations)
    ? raw.violations.map((entry, index) => normalizePolicyViolation(entry, index)).filter(Boolean)
    : [];
  const blocked = raw.blocked === true || raw.requiresApproval === true && raw.approvalState === "pending";
  if (violations.length === 0 && !blocked && !raw.approvalRequired && !raw.approvalState && !raw.mode) return null;
  return cleanObject({
    mode: normalizeWorkflowText(raw.mode || raw.policyMode || "", 80) || null,
    blocked,
    approvalRequired: raw.approvalRequired === true || raw.requiresApproval === true,
    approvalState: normalizeWorkflowText(raw.approvalState || raw.state || "", 80) || null,
    violations,
  });
}

function buildPolicyOutcome(policy = null) {
  if (!policy || typeof policy !== "object") return null;
  const violations = Array.isArray(policy.violations) ? policy.violations : [];
  const blockingViolationCount = violations.filter((entry) => entry?.blocking === true).length;
  const violationCount = violations.length;
  const blocked = policy.blocked === true || blockingViolationCount > 0;
  return cleanObject({
    status: blocked ? "blocked" : (violationCount > 0 ? "warning" : "ok"),
    blocked,
    approvalRequired: policy.approvalRequired === true,
    approvalState: policy.approvalState || null,
    violationCount,
    blockingViolationCount,
  });
}

function buildWorkflowGovernanceState(data = {}) {
  const goalState = buildGoalState(data);
  const heartbeatRun = normalizeHeartbeatRun(
    data?.heartbeatRun || data?._heartbeatRun || data?.workflowHeartbeatRun || data?._workflowHeartbeatRun,
  );
  const wakeupRequest = normalizeWakeupRequest(
    data?.wakeupRequest || data?._wakeupRequest || data?.workflowWakeupRequest || data?._workflowWakeupRequest,
  );
  const budgetPolicy = normalizeBudgetPolicy(
    data?.budgetPolicy || data?._budgetPolicy || data?.workflowBudgetPolicy || data?._workflowBudgetPolicy,
  );
  const executionPolicy = normalizeExecutionPolicy(
    data?.executionPolicy || data?._executionPolicy || data?.workflowExecutionPolicy || data?._workflowExecutionPolicy,
  );
  return cleanObject({
    ...goalState,
    heartbeatRun,
    wakeupRequest,
    budgetPolicy,
    executionPolicy,
    budgetOutcome: buildBudgetOutcome(budgetPolicy),
    policyOutcome: buildPolicyOutcome(executionPolicy),
  });
}

function toWorkflowGovernanceData(state = {}) {
  return cleanObject({
    _workflowGovernance: state,
    _goalAncestry: state.goalAncestry,
    _primaryGoalId: state.primaryGoalId || undefined,
    _primaryGoalTitle: state.primaryGoalTitle || undefined,
    _goalDepth: state.goalDepth ?? undefined,
    _heartbeatRun: state.heartbeatRun || undefined,
    _wakeupRequest: state.wakeupRequest || undefined,
    _budgetPolicy: state.budgetPolicy || undefined,
    _executionPolicy: state.executionPolicy || undefined,
    _budgetOutcome: state.budgetOutcome || undefined,
    _policyOutcome: state.policyOutcome || undefined,
  });
}

function normalizeDagText(value, maxLength = 240) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (!Number.isFinite(maxLength) || maxLength <= 0 || text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function cloneDagGraphNode(node = {}) {
  return {
    nodeId: String(node.nodeId || "").trim(),
    label: node.label || null,
    type: node.type || null,
    status: node.status || NodeStatus.PENDING,
    dependencies: Array.isArray(node.dependencies) ? [...node.dependencies] : [],
    attempts: Number(node.attempts || 0) || 0,
    lastError: node.lastError || null,
    issueFindingCount: Array.isArray(node.issueFindings) ? node.issueFindings.length : 0,
    completionEvidenceCount: Array.isArray(node.completionEvidence) ? node.completionEvidence.length : 0,
  };
}

function buildDagGraphSnapshot(dagState = {}) {
  const nodes = Object.values(dagState?.nodes || {})
    .map((node) => cloneDagGraphNode(node))
    .filter((node) => node.nodeId);
  const edges = Array.isArray(dagState?.edges)
    ? dagState.edges
      .map((edge) => ({
        edgeId: String(edge?.edgeId || edge?.id || `${edge?.source || ""}->${edge?.target || ""}`).trim(),
        source: String(edge?.source || "").trim(),
        target: String(edge?.target || "").trim(),
        label: edge?.label || null,
        condition: edge?.condition || null,
      }))
      .filter((edge) => edge.source && edge.target)
    : [];
  return { nodes, edges };
}

function detectDagFindingSource(node = {}, result = {}, errorMessage = "") {
  const nodeType = String(node?.type || "").trim().toLowerCase();
  const reason = String(result?.reason || "").trim().toLowerCase();
  const combined = `${errorMessage} ${result?.output || ""} ${result?.stderr || ""} ${result?.reviewOutput || ""}`.toLowerCase();

  if (nodeType.includes("model_review") || reason.includes("manual_review") || combined.includes("changes requested")) {
    return "review";
  }
  if (
    nodeType.startsWith("validation.") ||
    combined.includes("validation") ||
    combined.includes("tests red") ||
    combined.includes("test failed")
  ) {
    return "validation";
  }
  if (
    combined.includes("dependency") ||
    combined.includes("module not found") ||
    combined.includes("cannot find module") ||
    combined.includes("api changed") ||
    combined.includes("contract") ||
    combined.includes("schema")
  ) {
    return "workflow_diagnostics";
  }
  return "execution";
}

function detectDagRecommendedAction(node = {}, result = {}, errorMessage = "") {
  const reason = String(result?.reason || "").trim().toLowerCase();
  const combined = `${errorMessage} ${result?.output || ""} ${result?.stderr || ""} ${result?.reviewOutput || ""}`.toLowerCase();
  const source = detectDagFindingSource(node, result, errorMessage);

  if (
    combined.includes("timeout") ||
    combined.includes("timed out") ||
    combined.includes("temporar") ||
    combined.includes("network") ||
    combined.includes("econnreset") ||
    combined.includes("service unavailable") ||
    combined.includes("rate limit")
  ) {
    return "rerun_same_step";
  }
  if (source === "review") {
    return "spawn_fix_step";
  }
  if (
    source === "workflow_diagnostics" ||
    combined.includes("dependency") ||
    combined.includes("module not found") ||
    combined.includes("cannot find module") ||
    combined.includes("api changed") ||
    combined.includes("schema") ||
    combined.includes("contract")
  ) {
    return "replan_subgraph";
  }
  if (reason === "manual_review_required") {
    return "spawn_fix_step";
  }
  if (source === "validation") {
    return "replan_from_failed";
  }
  return "inspect_failure";
}

function collectDagIssueFindings(node = {}, result = undefined, errorMessage = "") {
  const output = result && typeof result === "object" ? result : {};
  const message = normalizeDagText(
    errorMessage || output?.reviewOutput || output?.stderr || output?.output || output?.reason || "",
    260,
  );
  const failed = Boolean(errorMessage) || output?.passed === false || output?._failed === true;
  if (!failed || !message) return [];

  const source = detectDagFindingSource(node, output, message);
  const recommendedAction = detectDagRecommendedAction(node, output, message);
  return [cleanObject({
    nodeId: node?.id || node?.nodeId || null,
    label: node?.label || null,
    source,
    severity: source === "review" ? "high" : (source === "workflow_diagnostics" ? "high" : "medium"),
    summary: message,
    reason: output?.reason || null,
    exitCode: Number.isFinite(Number(output?.exitCode)) ? Number(output.exitCode) : null,
    command: normalizeDagText(output?.command || "", 140) || null,
    recommendedAction,
    suggestedRerun: output?.outputSuggestedRerun || output?.outputDiagnostics?.suggestedRerun || null,
  })];
}

function collectDagCompletionEvidence(node = {}, result = undefined) {
  const output = result && typeof result === "object" ? result : {};
  const passed = output?.passed !== false && output?._failed !== true;
  if (!passed) return [];

  const evidence = [];
  const summary = normalizeDagText(
    output?.summary || output?.outputHint || output?.narrative || output?.output || output?.reviewPath || "",
    220,
  );
  if (summary) {
    evidence.push({
      nodeId: node?.id || node?.nodeId || null,
      label: node?.label || null,
      kind: "summary",
      summary,
    });
  }
  const command = normalizeDagText(output?.command || "", 140);
  if (command) {
    evidence.push(cleanObject({
      nodeId: node?.id || node?.nodeId || null,
      label: node?.label || null,
      kind: "command",
      command,
      exitCode: Number.isFinite(Number(output?.exitCode)) ? Number(output.exitCode) : 0,
    }));
  }
  const artifactPath = normalizeDagText(output?.reviewPath || output?.evidenceDir || output?.path || "", 180);
  if (artifactPath) {
    evidence.push({
      nodeId: node?.id || node?.nodeId || null,
      label: node?.label || null,
      kind: "artifact",
      path: artifactPath,
    });
  }
  return evidence;
}

function summarizeDagEvidence(evidence = [], limit = 3) {
  if (!Array.isArray(evidence) || evidence.length === 0) return [];
  return evidence.slice(0, Math.max(1, limit)).map((entry) => {
    if (entry?.summary) return entry.summary;
    if (entry?.command) return `Command: ${entry.command}`;
    if (entry?.path) return `Artifact: ${entry.path}`;
    return normalizeDagText(JSON.stringify(entry), 140);
  }).filter(Boolean);
}
/**
 * Register a node type handler.
 * @param {string} type - Node type identifier (e.g., "trigger.task_low", "action.run_agent")
 * @param {object} handler - { execute(node, context, engine), validate?(node), describe?() }
 */
export function registerNodeType(type, handler, options = {}) {
  if (!handler || typeof handler.execute !== "function") {
    throw new Error(`${TAG} Node type "${type}" must have an execute function`);
  }
  const normalized = normalizeHandlerMetadata(handler);
  _nodeTypeRegistry.set(type, normalized);
  _nodeTypeMetaRegistry.set(type, {
    source: String(options.source || handler.source || "builtin"),
    badge: options.badge || handler.badge || null,
    isCustom: options.isCustom === true || handler.isCustom === true || String(options.source || handler.source || "").toLowerCase() === "custom",
    filePath: options.filePath || handler.filePath || null,
    inputs: Array.isArray(options.inputs)
      ? options.inputs
      : Array.isArray(handler.inputs)
        ? handler.inputs
        : (normalized.ports?.inputs || []).map((port) => port?.name || "default"),
    outputs: Array.isArray(options.outputs)
      ? options.outputs
      : Array.isArray(handler.outputs)
        ? handler.outputs
        : (normalized.ports?.outputs || []).map((port) => port?.name || "default"),
  });
}

/**
 * Get a registered node type handler.
 * @param {string} type
 * @returns {object|null}
 */
export function getNodeType(type) {
  return _nodeTypeRegistry.get(type) || null;
}

export function getNodeTypeMeta(type) {
  return _nodeTypeMetaRegistry.get(type) || null;
}

export function unregisterNodeType(type) {
  _nodeTypeRegistry.delete(type);
  _nodeTypeMetaRegistry.delete(type);
}

/**
 * List all registered node types with metadata.
 * @returns {Array<{type: string, category: string, description: string}>}
 */
export function listNodeTypes() {
  const result = [];
  for (const [type, handler] of _nodeTypeRegistry) {
    const [category] = type.split(".");
    const metadata = _nodeTypeMetaRegistry.get(type) || {};
    result.push({
      type,
      category,
      description: handler.describe?.() || type,
      schema: handler.schema || null,
      source: metadata.source || "builtin",
      badge: metadata.badge || null,
      isCustom: metadata.isCustom === true,
      filePath: metadata.filePath || null,
      inputs: Array.isArray(metadata.inputs) ? [...metadata.inputs] : [],
      outputs: Array.isArray(metadata.outputs) ? [...metadata.outputs] : [],
      ports: {
        inputs: (handler.ports?.inputs || []).map((port) => clonePortDescriptor(port)),
        outputs: (handler.ports?.outputs || []).map((port) => clonePortDescriptor(port)),
      },
      ui: normalizeNodeUi(handler.ui),
    });
  }
  return result;
}

// ── Workflow Definition Schema ──────────────────────────────────────────────

/**
 * @typedef {object} WorkflowNode
 * @property {string} id - Unique node identifier
 * @property {string} type - Node type from registry (e.g., "trigger.task_low")
 * @property {string} label - Display label
 * @property {object} config - Node-specific configuration
 * @property {object} position - {x, y} canvas position for visual builder
 * @property {string[]} [outputs] - Named output ports (default: ["default"])
 */

/**
 * @typedef {object} WorkflowEdge
 * @property {string} id - Unique edge identifier
 * @property {string} source - Source node ID
 * @property {string} target - Target node ID
 * @property {string} [sourcePort] - Output port name (default: "default")
 * @property {string} [condition] - Optional JS expression for conditional routing
 * @property {boolean} [backEdge] - When true, this edge routes execution back
 *   to a previously-executed node, creating a convergence loop. Back-edges
 *   are excluded from in-degree calculation and have a per-edge iteration
 *   cap (default: MAX_BACK_EDGE_ITERATIONS).
 * @property {number} [maxIterations] - Override iteration cap for this back-edge
 */

/**
 * @typedef {object} WorkflowDefinition
 * @property {string} id - Unique workflow identifier
 * @property {string} name - Human-readable name
 * @property {string} [description] - What this workflow does
 * @property {string} [category] - Grouping category
 * @property {boolean} [enabled] - Whether this workflow is active
 * @property {boolean} [core] - Core workflows cannot be disabled or deleted
 * @property {string} [trigger] - Primary trigger type
 * @property {WorkflowNode[]} nodes - All nodes in the workflow
 * @property {WorkflowEdge[]} edges - Connections between nodes
 * @property {object} [variables] - Workflow-level variables/defaults
 * @property {object} [metadata] - Version, author, timestamps
 */

// ── Workflow Execution Context ──────────────────────────────────────────────

/**
 * Runtime context passed through workflow execution.
 * Accumulates data from each node's output.
 */
function collectValidationFailures(detail = {}) {
  const nodeOutputs = detail?.nodeOutputs && typeof detail.nodeOutputs === "object"
    ? detail.nodeOutputs
    : {};
  const dagNodes = detail?.dagState?.nodes && typeof detail.dagState.nodes === "object"
    ? detail.dagState.nodes
    : {};
  return Object.entries(nodeOutputs)
    .map(([nodeId, output]) => {
      if (!output || typeof output !== "object") return null;
      const diagnostic = output.failureDiagnostic && typeof output.failureDiagnostic === "object"
        ? output.failureDiagnostic
        : null;
      const failureKind = String(output.failureKind || diagnostic?.category || "").trim();
      const hasRetryability = typeof output.retryable === "boolean" || typeof diagnostic?.retryable === "boolean";
      if (!failureKind && !diagnostic && !hasRetryability) return null;
      return {
        nodeId,
        nodeType: dagNodes?.[nodeId]?.type || null,
        nodeLabel: dagNodes?.[nodeId]?.label || null,
        failureKind: failureKind || diagnostic?.category || null,
        retryable: typeof output.retryable === "boolean"
          ? output.retryable
          : diagnostic?.retryable === true,
        blocked: output.blocked === true || diagnostic?.blocked === true,
        exitCode: diagnostic?.exitCode ?? output.exitCode ?? null,
        summary:
          diagnostic?.summary ||
          output.outputHint ||
          output.outputDiagnostics?.summary ||
          null,
        detail: diagnostic?.detail || null,
      };
    })
    .filter(Boolean);
}

const ATOMIC_RENAME_FALLBACK_CODES = new Set(["EXDEV", "EPERM", "EACCES", "EBUSY"]);

function writeJsonFileAtomically(filePath, value) {
  const dirPath = dirname(filePath);
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const json = JSON.stringify(value, null, 2);
  writeFileSync(tmpPath, json, "utf8");
  try {
    renameSync(tmpPath, filePath);
  } catch (renameErr) {
    if (!ATOMIC_RENAME_FALLBACK_CODES.has(renameErr?.code)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best effort */
      }
      throw renameErr;
    }
    writeFileSync(filePath, json, "utf8");
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best effort */
    }
  }
}

function collectRunTaskIds(detail = {}, options = {}) {
  const currentRunId = normalizeWorkflowIdentityText(options?.currentRunId || "");
  const includeTopologyIds = options?.includeTopologyIds !== false;
  const ids = new Set();
  const push = (value) => {
    const normalized = normalizeWorkflowIdentityText(value);
    if (normalized) ids.add(normalized);
  };

  push(detail?.data?.taskId);
  push(detail?.data?.activeTaskId);
  push(detail?.data?.task?.id);
  push(detail?.data?.taskInfo?.id);
  push(detail?.data?.taskDetail?.id);
  if (includeTopologyIds) {
    push(detail?.data?._workflowRootTaskId);
    push(detail?.data?._workflowParentTaskId);
  }

  for (const event of Array.isArray(detail?.data?._taskWorkflowEvents) ? detail.data._taskWorkflowEvents : []) {
    if (currentRunId) {
      const eventRunId = normalizeWorkflowIdentityText(event?.runId);
      if (eventRunId && eventRunId !== currentRunId) continue;
    }
    push(event?.taskId);
    push(event?.id);
  }

  return [...ids];
}

function resolveRunTaskTitle(detail = {}, options = {}) {
  const currentRunId = normalizeWorkflowIdentityText(options?.currentRunId || "");
  const direct = [
    detail?.data?.taskTitle,
    detail?.data?.task?.title,
    detail?.data?.taskInfo?.title,
    detail?.data?.taskDetail?.title,
  ]
    .map((value) => normalizeWorkflowIdentityText(value))
    .find(Boolean);
  if (direct) return direct;

  for (const event of Array.isArray(detail?.data?._taskWorkflowEvents) ? detail.data._taskWorkflowEvents : []) {
    if (currentRunId) {
      const eventRunId = normalizeWorkflowIdentityText(event?.runId);
      if (eventRunId && eventRunId !== currentRunId) continue;
    }
    const title = normalizeWorkflowIdentityText(event?.taskTitle || event?.title);
    if (title) return title;
  }

  return null;
}

function resolveWorkflowTemplateSource(runSummary = null, detail = null) {
  return normalizeWorkflowIdentityText(
    detail?.workflowDefinition?.metadata?.installedFrom ||
      detail?.data?._workflowDefinitionSnapshot?.metadata?.installedFrom ||
      runSummary?.metadata?.installedFrom ||
      "",
  ).toLowerCase();
}

function isConcreteTaskIdentityRequired(runSummary = null, detail = null) {
  const templateSource = resolveWorkflowTemplateSource(runSummary, detail);
  if (templateSource === "template-task-lifecycle") return true;
  const workflowName = normalizeWorkflowIdentityText(
    detail?.workflowName ||
      detail?.data?._workflowName ||
      runSummary?.workflowName ||
      "",
  ).toLowerCase();
  return workflowName === "task lifecycle";
}

function resolveRunTaskIdentityForResumeGuard(runSummary = null, detail = null) {
  return normalizeWorkflowIdentityText(
    detail?.data?.taskId ||
      detail?.inputData?.taskId ||
      detail?.taskId ||
      detail?.delegationTopology?.taskId ||
      detail?.data?._delegationTopology?.taskId ||
      runSummary?.taskId ||
      "",
  );
}

function resolveIndexedRunTaskIdentity(runSummary = null) {
  return normalizeWorkflowIdentityText(
    runSummary?.taskId ||
      (Array.isArray(runSummary?.taskIds) ? runSummary.taskIds[0] : "") ||
      runSummary?.rootTaskId ||
      "",
  );
}

function isTasklessScheduledResumeRun(runSummary = null, detail = null) {
  if (resolveRunTaskIdentityForResumeGuard(runSummary, detail)) return false;
  if (isConcreteTaskIdentityRequired(runSummary, detail)) return false;

  const triggerSource = normalizeWorkflowIdentityText(
    runSummary?.triggerSource ||
      detail?.triggerSource ||
      detail?.data?._workflowTriggerSource ||
      "",
  ).toLowerCase();
  if (triggerSource === "schedule-poll" || triggerSource === "startup") return true;

  const workflowName = normalizeWorkflowIdentityText(
    detail?.workflowName ||
      detail?.data?._workflowName ||
      runSummary?.workflowName ||
      "",
  ).toLowerCase();
  return workflowName === "bosun pr watchdog" || workflowName === "task batch processor";
}

function collectRunSessionIds(detail = {}, options = {}) {
  const currentRunId = normalizeWorkflowIdentityText(options?.currentRunId || "");
  const ids = [];
  const seen = new Set();
  const push = (value) => {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    ids.push(normalized);
  };

  for (const value of [
    detail?.data?._workflowSessionId,
    detail?.data?._workflowRootSessionId,
    detail?.data?._workflowParentSessionId,
    detail?.data?.sessionId,
    detail?.data?.threadId,
    detail?.data?.task?.sessionId,
    detail?.data?.task?.threadId,
  ]) {
    push(value);
  }
  for (const value of Array.isArray(detail?.data?._delegatedSessionIds) ? detail.data._delegatedSessionIds : []) {
    push(value);
  }

  for (const event of Array.isArray(detail?.data?._taskWorkflowEvents) ? detail.data._taskWorkflowEvents : []) {
    if (currentRunId) {
      const eventRunId = normalizeWorkflowIdentityText(event?.runId);
      if (eventRunId && eventRunId !== currentRunId) continue;
    }
    for (const value of [
      event?.sessionId,
      event?.threadId,
      event?.meta?.sessionId,
      event?.meta?.threadId,
    ]) {
      push(value);
    }
  }

  return ids;
}

function buildRunDelegationTopology({ runId = null, detail = {}, runGraph = null } = {}) {
  const currentRunId = String(runId || detail?.id || "").trim();
  const taskIds = collectRunTaskIds(detail, {
    currentRunId,
    includeTopologyIds: false,
  });
  const sessionIds = collectRunSessionIds(detail, {
    currentRunId,
  });
  const requestedRunId = currentRunId || null;
  const requestedRun =
    Array.isArray(runGraph?.runs) && requestedRunId
      ? runGraph.runs.find((entry) => String(entry?.runId || "") === requestedRunId) || null
      : null;
  const rootRunId = String(
    detail?.dagState?.rootRunId ||
      detail?.data?._workflowRootRunId ||
      requestedRun?.rootRunId ||
      requestedRunId ||
      "",
  ).trim() || null;
  const parentRunId = String(
    detail?.dagState?.parentRunId ||
      detail?.data?._workflowParentRunId ||
      requestedRun?.parentRunId ||
      "",
  ).trim() || null;
  const taskId = String(taskIds[0] || requestedRun?.taskId || "").trim() || null;
  const rootTaskId = String(
    detail?.data?._workflowRootTaskId ||
      requestedRun?.rootTaskId ||
      taskId ||
      "",
  ).trim() || taskId || null;
  const parentTaskId = String(
    detail?.data?._workflowParentTaskId ||
      requestedRun?.parentTaskId ||
      "",
  ).trim() || null;
  const sessionId = String(
    detail?.data?._workflowSessionId ||
      sessionIds[0] ||
      requestedRun?.sessionId ||
      "",
  ).trim() || (sessionIds[0] || null);
  const rootSessionId = String(
    detail?.data?._workflowRootSessionId ||
      requestedRun?.rootSessionId ||
      sessionId ||
      "",
  ).trim() || sessionId || null;
  const parentSessionId = String(
    detail?.data?._workflowParentSessionId ||
      requestedRun?.parentSessionId ||
      "",
  ).trim() || null;
  const delegationDepthRaw = Number(
    detail?.data?._workflowDelegationDepth ??
      requestedRun?.delegationDepth ??
      0,
  );
  const delegationDepth = Number.isFinite(delegationDepthRaw)
    ? Math.max(0, Math.trunc(delegationDepthRaw))
    : 0;
  const childRunIds = Array.isArray(runGraph?.runs) && requestedRunId
    ? runGraph.runs
        .filter((entry) => String(entry?.parentRunId || "") === requestedRunId)
        .map((entry) => String(entry?.runId || "").trim())
        .filter(Boolean)
    : [];
  const childSessionIds = Array.isArray(runGraph?.runs)
    ? [...new Set(
        runGraph.runs
          .filter((entry) => String(entry?.parentRunId || "") === requestedRunId)
          .map((entry) => String(entry?.sessionId || "").trim())
          .filter(Boolean),
      )]
    : [];
  const familyRunIds = Array.isArray(runGraph?.runs)
    ? [...new Set(runGraph.runs.map((entry) => String(entry?.runId || "").trim()).filter(Boolean))]
    : [];
  const familySessionIds = Array.isArray(runGraph?.runs)
    ? [...new Set(runGraph.runs.map((entry) => String(entry?.sessionId || "").trim()).filter(Boolean))]
    : [];
  return cleanObject({
    runId: requestedRunId,
    rootRunId,
    parentRunId,
    taskId,
    rootTaskId,
    parentTaskId,
    taskIds,
    sessionId,
    rootSessionId,
    parentSessionId,
    sessionIds,
    delegationDepth,
    childRunIds,
    childSessionIds,
    familyRunIds,
    familySessionIds,
  });
}

function buildActiveRunIndexEntry(runId, workflowId, workflowName, ctx) {
  const detail = ctx?.toJSON?.(Date.now()) || {};
  const topology = buildRunDelegationTopology({
    runId,
    detail,
  });
  return cleanObject({
    runId,
    workflowId,
    workflowName,
    startedAt: ctx?.startedAt || Date.now(),
    rootRunId: topology.rootRunId || undefined,
    parentRunId: topology.parentRunId || undefined,
    taskId: topology.taskId || undefined,
    rootTaskId: topology.rootTaskId || undefined,
    parentTaskId: topology.parentTaskId || undefined,
    taskIds: Array.isArray(topology.taskIds) && topology.taskIds.length > 0
      ? topology.taskIds
      : undefined,
    taskTitle: resolveRunTaskTitle(detail, { currentRunId: runId }) || undefined,
    sessionId: topology.sessionId || undefined,
    rootSessionId: topology.rootSessionId || undefined,
    parentSessionId: topology.parentSessionId || undefined,
    sessionIds: Array.isArray(topology.sessionIds) && topology.sessionIds.length > 0
      ? topology.sessionIds
      : undefined,
    delegationDepth: Number.isFinite(Number(topology.delegationDepth))
      ? Number(topology.delegationDepth)
      : undefined,
  });
}

export class WorkflowContext {
  constructor(initialData = {}) {
    this.id = randomUUID();
    this.startedAt = Date.now();
    this.data = { ...initialData };
    this.nodeOutputs = new Map();
    this.nodeStatuses = new Map();
    this.logs = [];
    this.errors = [];
    this.nodeStatusEvents = [];
    this.variables = {};
    this.retryAttempts = new Map();
    this._nodeTimings = Object.create(null);
    this._nodeInputs = Object.create(null);
  }

  /** Target repo for multi-repo workspaces (convenience accessor) */
  get targetRepo() {
    return this.data._targetRepo || "";
  }

  /** Trigger variables passed from a caller workflow or manual dispatch */
  get triggerVars() {
    return this.data._triggerVars || {};
  }

  /** Get current retry count for a node */
  getRetryCount(nodeId) {
    return this.retryAttempts.get(nodeId) || 0;
  }

  /** Increment and return the new retry count for a node */
  incrementRetry(nodeId) {
    const count = this.getRetryCount(nodeId) + 1;
    this.retryAttempts.set(nodeId, count);
    return count;
  }

  /**
   * Fork this context for sub-execution (e.g. loop iteration).
   * Creates a shallow clone with deep-copied data and fresh node tracking.
   */
  fork(overrides = {}) {
    const forked = new WorkflowContext({ ...this.data, ...overrides });
    forked.id = this.id; // Same run
    forked.startedAt = this.startedAt;
    forked.variables = { ...this.variables };
    // Copy existing node outputs so forked context can reference upstream nodes
    for (const [k, v] of this.nodeOutputs) {
      forked.nodeOutputs.set(k, v);
    }
    return forked;
  }

  /** Set a timing field for a node (startedAt / endedAt) */
  setNodeTiming(nodeId, field, value) {
    const key = String(nodeId);
    const fieldKey = String(field);
    if (!this._nodeTimings[key] || typeof this._nodeTimings[key] !== "object") {
      this._nodeTimings[key] = Object.create(null);
    }
    this._nodeTimings[key][fieldKey] = value;
  }

  /** Get timing data for a node */
  getNodeTiming(nodeId) {
    return this._nodeTimings[String(nodeId)] || null;
  }

  /** Store the resolved input snapshot for a node */
  setNodeInput(nodeId, input) {
    this._nodeInputs[String(nodeId)] = input;
  }

  /** Get the stored input snapshot for a node */
  getNodeInput(nodeId) {
    return this._nodeInputs[String(nodeId)] || null;
  }

  /** Merge metadata into an existing DAGState node entry */
  annotateDagNode(nodeId, patch = {}) {
    const dagState = this.data?._dagState;
    if (!dagState || typeof dagState !== "object" || !dagState.nodes || typeof dagState.nodes !== "object") {
      return;
    }
    const existing = dagState.nodes[nodeId];
    if (!existing || typeof existing !== "object") return;
    dagState.nodes[nodeId] = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Set output from a node */
  setNodeOutput(nodeId, output) {
    this.nodeOutputs.set(nodeId, output);
  }

  /** Get output from a previously executed node */
  getNodeOutput(nodeId) {
    return this.nodeOutputs.get(nodeId);
  }

  /** Set node execution status */
  setNodeStatus(nodeId, status) {
    this.nodeStatuses.set(nodeId, status);
    this.nodeStatusEvents.push({ nodeId, status, timestamp: Date.now() });
    const dagNode = this.data?._dagState?.nodes?.[nodeId];
    if (dagNode && typeof dagNode === "object") {
      dagNode.status = status;
      dagNode.lastStatusAt = new Date().toISOString();
    }
  }

  /** Get node execution status */
  getNodeStatus(nodeId) {
    return this.nodeStatuses.get(nodeId) || NodeStatus.PENDING;
  }

  /** Add a log entry */
  log(nodeId, message, level = "info") {
    this.logs.push({ nodeId, message, level, timestamp: Date.now() });
  }

  getDelegationAuditTrail() {
    return getDelegationAuditTrail(this);
  }

  recordDelegationEvent(event = {}) {
    return recordDelegationRuntimeEvent(this, event);
  }

  getDelegationTransitionGuard(key) {
    return getDelegationTransitionGuard(this, key);
  }

  setDelegationTransitionGuard(key, value = {}) {
    return setDelegationRuntimeTransitionGuard(this, key, value);
  }

  getWorkflowTeamState() {
    return cloneWorkflowTeamState(
      this?.__workflowRuntimeState?.workflowTeamState ??
      this?.data?._workflowTeamState ??
      this?.data?.workflowTeamState ??
      {},
    );
  }

  setWorkflowTeamState(state = {}) {
    const normalized = normalizeWorkflowTeamState(state || {});
    if (!this.data || typeof this.data !== "object") this.data = {};
    this.data._workflowTeamState = normalized;
    this.data.workflowTeamState = normalized;
    if (!this.__workflowRuntimeState || typeof this.__workflowRuntimeState !== "object") {
      this.__workflowRuntimeState = {};
    }
    this.__workflowRuntimeState.workflowTeamState = normalized;
    return cloneWorkflowTeamState(normalized);
  }

  updateWorkflowTeamState(updater) {
    const current = this.getWorkflowTeamState();
    const next = typeof updater === "function"
      ? updater(cloneWorkflowTeamState(current))
      : { ...current, ...(updater || {}) };
    return this.setWorkflowTeamState(next || current);
  }

  /** Record an error */
  error(nodeId, error) {
    const msg = error instanceof Error ? error.message : String(error);
    this.errors.push({ nodeId, error: msg, timestamp: Date.now() });
    this.log(nodeId, `ERROR: ${msg}`, "error");
  }

  /** Resolve a template string against context data */
  resolve(template) {
    if (typeof template !== "string") return template;
    const resolvePathValue = (path) => {
      const parts = path.split(".");

      // Try context data first
      let value = this.data;
      for (const part of parts) {
        if (value == null) break;
        value = value[part];
      }
      if (value != null) return value;

      // Fall back to node outputs (e.g. {{step1.count}} → nodeOutputs["step1"].count)
      const [nodeId, ...rest] = parts;
      const nodeOut = this.nodeOutputs.get(nodeId);
      if (nodeOut != null) {
        let val = nodeOut;
        for (const p of rest) {
          if (val == null) return undefined;
          val = val[p];
        }
        if (val != null) return val;
      }
      return undefined;
    };

    // Evaluate a {{$data.x || $ctx.foo() || 'literal'}} JS-expression template using
    // the same sandbox as condition.expression. Returns { ok, value } so callers can
    // distinguish a real evaluation from a parse/eval failure.
    const evalExpression = (expr) => {
      const blockedPatterns = [
        /(?:^|[^\w$.])(globalThis|global|window|document|process|require|module|exports)(?:[^\w$]|$)/,
        /(?:^|[^\w$.])(Function|eval)(?:[^\w$]|$)/,
      ];
      const trimmed = String(expr).trim();
      if (!trimmed) return { ok: false };
      if (blockedPatterns.some((pattern) => pattern.test(trimmed))) return { ok: false };
      try {
        const fn = new Function("$data", "$ctx", "$output", `"use strict"; return (${trimmed});`);
        const allOutputs = {};
        for (const [k, v] of this.nodeOutputs) allOutputs[k] = v;
        const value = fn(this.data, this, allOutputs);
        return { ok: true, value };
      } catch {
        return { ok: false };
      }
    };

    // If template is exactly one placeholder, preserve raw value type.
    // This allows numbers/booleans/objects to flow into node configs.
    const exactMatch = template.match(/^\{\{([A-Za-z0-9_][A-Za-z0-9_.-]*)\}\}$/);
    if (exactMatch) {
      const raw = resolvePathValue(exactMatch[1]);
      return raw != null ? raw : template;
    }

    // Support full JS-expression templates: {{ <js expr> }} where the expression
    // contains any non-identifier characters (e.g. `?.`, `||`, `()`, `'literal'`).
    // Fall back gracefully to the literal template if evaluation fails.
    const exactExprMatch = template.match(/^\{\{([\s\S]+)\}\}$/);
    if (exactExprMatch && /[^A-Za-z0-9_.\-\s]/.test(exactExprMatch[1])) {
      const evaluated = evalExpression(exactExprMatch[1]);
      if (evaluated.ok) return evaluated.value != null ? evaluated.value : template;
    }

    // Inline JS-expression placeholders inside a larger string, e.g.
    //   "blocked: {{$ctx.getNodeOutput('x')?.error || 'unknown'}} at end"
    // We use a non-greedy match and require the inner expression to contain at
    // least one non-identifier character (otherwise the simple-path replacer below
    // handles it).
    const exprPlaceholderRe = /\{\{([^{}]+?)\}\}/g;
    let replaced = template;
    if (exprPlaceholderRe.test(template)) {
      replaced = template.replace(/\{\{([^{}]+?)\}\}/g, (match, inner) => {
        // Skip simple identifier paths — handled by the regex below for back-compat.
        if (/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(inner.trim())) return match;
        const evaluated = evalExpression(inner);
        if (!evaluated.ok || evaluated.value == null) return match;
        const v = evaluated.value;
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
        try { return JSON.stringify(v); } catch { return String(v); }
      });
    }

    return replaced.replace(/\{\{([A-Za-z0-9_][A-Za-z0-9_.-]*)\}\}/g, (match, path) => {
      const value = resolvePathValue(path);
      if (value == null) return match;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
      try { return JSON.stringify(value); } catch { return String(value); }
    });
  }

  /** Get a serializable summary of the execution */
  toJSON(endedAt = Date.now()) {
    const finishedAt = Number.isFinite(endedAt) ? endedAt : Date.now();
    const detail = {
      id: this.id,
      startedAt: this.startedAt,
      endedAt: finishedAt,
      duration: Math.max(0, finishedAt - this.startedAt),
      data: this.data,
      nodeOutputs: Object.fromEntries(this.nodeOutputs),
      nodeStatuses: Object.fromEntries(this.nodeStatuses),
      retryAttempts: Object.fromEntries(this.retryAttempts),
      logs: this.logs,
      errors: this.errors,
      nodeStatusEvents: this.nodeStatusEvents,
      nodeTimings: { ...this._nodeTimings },
      nodeInputs: { ...this._nodeInputs },
      dagState: this.data?._dagState || null,
      issueAdvisor: this.data?._issueAdvisor || null,
      replayTrajectory: this.data?._replayTrajectory || null,
      delegationAuditTrail: this.getDelegationAuditTrail(),
      delegationTrail: this.getDelegationAuditTrail(),
      delegationTransitionGuards:
        this.data?._delegationTransitionGuards && typeof this.data._delegationTransitionGuards === "object"
          ? { ...this.data._delegationTransitionGuards }
          : {},
      workflowTeamState: hasWorkflowTeamStateData(this.getWorkflowTeamState())
        ? this.getWorkflowTeamState()
        : null,
      teamSummary: hasWorkflowTeamStateData(this.getWorkflowTeamState())
        ? buildWorkflowTeamSummary(this.getWorkflowTeamState())
        : null,
      stepSummaries: Array.isArray(this.data?._replayTrajectory?.steps)
        ? this.data._replayTrajectory.steps.map((s) => ({
            nodeId: s.nodeId,
            label: s.label,
            status: s.status,
            summary: s.summary,
          }))
        : [],
    };
    const validationFailures = collectValidationFailures(detail);
    if (validationFailures.length > 0) {
      detail.validationFailures = validationFailures;
      detail.latestValidationFailure = validationFailures.at(-1) || null;
    }
    return detail;
  }
}

// ── Workflow Engine ─────────────────────────────────────────────────────────

export class WorkflowEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.workflowDir - Directory to store workflow definitions
   * @param {string} [opts.runsDir] - Directory to store execution logs
   * @param {object} [opts.services] - Injected service references (kanban, agent-pool, etc.)
   */
  constructor(opts = {}) {
    super();
    const sandbox = ensureTestRuntimeSandbox();
    const runtimeCwd = getRuntimeCwd();
    const defaultWorkflowDir = resolve(runtimeCwd, ".bosun", WORKFLOW_DIR_NAME);
    const defaultRunsDir = resolve(runtimeCwd, ".bosun", WORKFLOW_RUNS_DIR);
    this.workflowDir = resolvePathForTestRuntime(
      opts.workflowDir || defaultWorkflowDir,
      defaultWorkflowDir,
      sandbox?.workflowDir,
    );
    this.runsDir = resolvePathForTestRuntime(
      opts.runsDir || defaultRunsDir,
      defaultRunsDir,
      sandbox?.runsDir,
    );
    this._configDir = opts.configDir || runtimeCwd;
    const env = getRuntimeEnv();
    this.detectInterruptedRuns = opts.detectInterruptedRuns !== false &&
      env.WORKFLOW_DETECT_INTERRUPTED_RUNS !== "0" &&
      env.WORKFLOW_DETECT_INTERRUPTED_RUNS !== "false";
    this.services = opts.services || {};
    this._workflows = new Map();
    this._activeRuns = new Map();
    this._triggerSubscriptions = new Map();
    this._loaded = false;
    this._checkpointTimers = new Map(); // runId → debounce timer
    this._resumingRuns = false;
    this._startupInterruptedRunIds = null;
    this._taskTraceHooks = new Set();
    if (typeof opts.onTaskWorkflowEvent === "function") {
      this._taskTraceHooks.add(opts.onTaskWorkflowEvent);
    }
    if (typeof opts.taskTraceHook === "function") {
      this._taskTraceHooks.add(opts.taskTraceHook);
    }
    if (Array.isArray(opts.taskTraceHooks)) {
      for (const hook of opts.taskTraceHooks) {
        if (typeof hook === "function") this._taskTraceHooks.add(hook);
      }
    }

    // ── Concurrency control ───────────────────────────────────────────
    this._runSlots = 0;              // current number of executing runs
    this._runQueue = [];             // FIFO queue of { resolve, reject, args }
    this._rootRunSlotRefs = new Map(); // rootRunId -> nested executions sharing a single slot
    this._runIndexCache = null;      // cached run index (invalidated on writes)
    this._runIndexCacheMtime = 0;    // mtime of the cached index file
    this._executionLedger = new WorkflowExecutionLedger({ runsDir: this.runsDir });

    // Lazy-load workspace manager for schedule evaluation
    void ensureWorkspaceManager().catch(() => {});
  }
  _emitWorkflowStatus(payload = {}) {
    const event = buildWorkflowStatusPayload(payload);
    if (!event.runId || !event.workflowId || !event.eventType) return;
    this.emit("workflow:status", event);
  }


  _initializeDagState(def, ctx, extra = {}) {
    const dependencyMap = new Map();
    const edges = [];
    for (const node of def?.nodes || []) {
      dependencyMap.set(node.id, []);
    }
    for (const edge of def?.edges || []) {
      if (!edge?.source || !edge?.target || edge.backEdge === true) continue;
      const deps = dependencyMap.get(edge.target) || [];
      deps.push(edge.source);
      dependencyMap.set(edge.target, deps);
      edges.push({
        edgeId: String(edge.id || `${edge.source}->${edge.target}`),
        source: edge.source,
        target: edge.target,
        label: edge.label || null,
        condition: edge.condition || null,
      });
    }

    const nowIso = new Date(ctx.startedAt).toISOString();
    const dagState = {
      version: 1,
      runId: ctx.id,
      workflowId: def?.id || ctx.data?._workflowId || null,
      workflowName: def?.name || ctx.data?._workflowName || null,
      rootRunId: extra.rootRunId || ctx.data?._workflowRootRunId || ctx.id,
      parentRunId: extra.parentRunId || ctx.data?._workflowParentRunId || null,
      retryOf: extra.retryOf || ctx.data?._retryOf || null,
      retryMode: extra.retryMode || null,
      revisionReason: extra.revisionReason || null,
      createdAt: nowIso,
      updatedAt: nowIso,
      status: WorkflowStatus.RUNNING,
      revisions: [],
      counts: {
        total: Array.isArray(def?.nodes) ? def.nodes.length : 0,
        pending: Array.isArray(def?.nodes) ? def.nodes.length : 0,
        running: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
      },
      edges,
      nodes: Object.fromEntries(
        (def?.nodes || []).map((node) => [
          node.id,
          {
            nodeId: node.id,
            type: node.type,
            label: node.label || null,
            status: NodeStatus.PENDING,
            dependencies: dependencyMap.get(node.id) || [],
            attempts: 0,
            lastError: null,
            outputSummary: null,
            issueFindings: [],
            completionEvidence: [],
            startedAt: null,
            endedAt: null,
            updatedAt: nowIso,
          },
        ]),
      ),
    };
    ctx.data._workflowRootRunId = dagState.rootRunId;
    if (dagState.parentRunId) ctx.data._workflowParentRunId = dagState.parentRunId;
    ctx.data._dagState = dagState;
    this._refreshDagState(ctx, dagState.status);
    return dagState;
  }

  _recordDagRevision(ctx, revision = {}) {
    const dagState = ctx?.data?._dagState;
    if (!dagState || typeof dagState !== "object" || !dagState.nodes || typeof dagState.nodes !== "object") {
      return null;
    }
    if (!Array.isArray(dagState.revisions)) dagState.revisions = [];
    const nodes = Object.values(dagState.nodes);
    const counts = {
      total: nodes.length,
      pending: nodes.filter((node) => node?.status === NodeStatus.PENDING).length,
      running: nodes.filter((node) => node?.status === NodeStatus.RUNNING || node?.status === NodeStatus.WAITING).length,
      completed: nodes.filter((node) => node?.status === NodeStatus.COMPLETED).length,
      failed: nodes.filter((node) => node?.status === NodeStatus.FAILED).length,
      skipped: nodes.filter((node) => node?.status === NodeStatus.SKIPPED).length,
    };
    const completedNodeIds = nodes.filter((node) => node?.status === NodeStatus.COMPLETED).map((node) => node.nodeId);
    const failedNodeIds = nodes.filter((node) => node?.status === NodeStatus.FAILED).map((node) => node.nodeId);
    const pendingNodeIds = nodes
      .filter((node) => node?.status === NodeStatus.PENDING || node?.status === NodeStatus.WAITING)
      .map((node) => node.nodeId);
    const graphBefore = revision.graphBefore && typeof revision.graphBefore === "object"
      ? revision.graphBefore
      : (dagState.revisions.length > 0 ? dagState.revisions[dagState.revisions.length - 1]?.graphAfter || null : null);
    const graphAfter = revision.graphAfter && typeof revision.graphAfter === "object"
      ? revision.graphAfter
      : buildDagGraphSnapshot(dagState);
    const issueFindings = nodes.flatMap((node) => Array.isArray(node?.issueFindings) ? node.issueFindings : []);
    const completionEvidence = nodes.flatMap((node) => Array.isArray(node?.completionEvidence) ? node.completionEvidence : []);
    const snapshot = {
      index: dagState.revisions.length,
      recordedAt: new Date().toISOString(),
      reason: revision.reason || "update",
      sourceRunId: revision.sourceRunId || null,
      retryMode: dagState.retryMode || null,
      status: dagState.status || WorkflowStatus.RUNNING,
      counts,
      preservedCompletedNodeIds: Array.isArray(revision.preservedCompletedNodeIds)
        ? [...new Set(revision.preservedCompletedNodeIds.map((id) => String(id || "").trim()).filter(Boolean))]
        : completedNodeIds,
      focusNodeIds: Array.isArray(revision.focusNodeIds)
        ? [...new Set(revision.focusNodeIds.map((id) => String(id || "").trim()).filter(Boolean))]
        : (failedNodeIds.length ? failedNodeIds : pendingNodeIds),
      failedNodeIds,
      pendingNodeIds,
      issueFindingCount: issueFindings.length,
      completionEvidenceCount: completionEvidence.length,
      issueFindingsPreview: issueFindings.slice(0, 6),
      completionEvidencePreview: completionEvidence.slice(0, 6),
      graphBefore,
      graphAfter,
      edgeCount: Array.isArray(dagState.edges) ? dagState.edges.length : 0,
      nodeCount: nodes.length,
    };
    dagState.revisions.push(snapshot);
    dagState.updatedAt = snapshot.recordedAt;
    return snapshot;
  }
  _refreshDagState(ctx, status = null) {
    const dagState = ctx?.data?._dagState;
    if (!dagState || typeof dagState !== "object" || !dagState.nodes || typeof dagState.nodes !== "object") {
      return null;
    }
    const nodes = Object.values(dagState.nodes);
    const counts = {
      total: nodes.length,
      pending: nodes.filter((node) => node?.status === NodeStatus.PENDING).length,
      running: nodes.filter((node) => node?.status === NodeStatus.RUNNING || node?.status === NodeStatus.WAITING).length,
      completed: nodes.filter((node) => node?.status === NodeStatus.COMPLETED).length,
      failed: nodes.filter((node) => node?.status === NodeStatus.FAILED).length,
      skipped: nodes.filter((node) => node?.status === NodeStatus.SKIPPED).length,
    };
    dagState.counts = counts;
    dagState.status = status || dagState.status || WorkflowStatus.RUNNING;
    dagState.updatedAt = new Date().toISOString();

    const failedNodes = nodes.filter((node) => node?.status === NodeStatus.FAILED);
    const pendingNodes = nodes.filter((node) => node?.status === NodeStatus.PENDING || node?.status === NodeStatus.WAITING);
    const firstFailed = failedNodes[0] || null;
    const firstPending = pendingNodes[0] || null;
    const issueFindings = nodes.flatMap((node) => Array.isArray(node?.issueFindings) ? node.issueFindings : []);
    const completionEvidence = nodes.flatMap((node) => Array.isArray(node?.completionEvidence) ? node.completionEvidence : []);
    const firstFinding = issueFindings[0] || null;
    const terminalCompleted = dagState.status === WorkflowStatus.COMPLETED;
    const completedWithInactivePending =
      terminalCompleted && failedNodes.length === 0 && pendingNodes.length > 0;

    let recommendedAction = "continue";
    let summary = completedWithInactivePending
      ? `Workflow completed on the executed path; ${pendingNodes.length} node(s) remained pending on inactive branches.`
      : (terminalCompleted
          ? "Workflow completed successfully."
          : "Workflow is ready to continue.");
    if (failedNodes.length > 0) {
      const preferredAction = firstFinding?.recommendedAction || null;
      recommendedAction = preferredAction;
      if (!recommendedAction || (recommendedAction === "inspect_failure" && counts.completed > 0)) {
        recommendedAction = counts.completed > 0 ? "replan_from_failed" : "inspect_failure";
      }
      summary = firstFinding?.summary
        ? `Failed at ${firstFailed?.label || firstFailed?.nodeId || "a workflow step"}: ${firstFinding.summary}`
        : (firstFailed?.lastError
            ? `Failed at ${firstFailed.label || firstFailed.nodeId}: ${firstFailed.lastError}`
            : `Workflow has ${failedNodes.length} failed node(s).`);
    } else if (!terminalCompleted && pendingNodes.length > 0 && counts.completed > 0) {
      recommendedAction = "resume_remaining";
      summary = `Resume from ${firstPending?.label || firstPending?.nodeId || "the next pending node"}.`;
    }

    const nextStepGuidance = failedNodes.length > 0
      ? [
        recommendedAction === "rerun_same_step"
          ? "Preserve completed work and rerun the same failed step with the suggested command or fix."
          : (recommendedAction === "spawn_fix_step"
              ? "Preserve completed work and insert a targeted fix step before resuming downstream execution."
              : (recommendedAction === "replan_subgraph"
                  ? "Preserve completed work and replan the impacted downstream subgraph before continuing."
                  : "Preserve completed work and replan from the failed boundary.")),
        firstFailed?.label ? `Focus next on ${firstFailed.label}.` : null,
        firstFinding?.suggestedRerun ? `Suggested rerun: ${firstFinding.suggestedRerun}` : null,
        firstFailed?.lastError ? `Address failure: ${firstFailed.lastError}` : null,
      ].filter(Boolean).join(" ")
      : (!terminalCompleted && pendingNodes.length > 0 && counts.completed > 0
        ? [
          "Preserve completed work and continue from the next pending node.",
          firstPending?.label ? `Next step: ${firstPending.label}.` : null,
        ].filter(Boolean).join(" ")
        : (completedWithInactivePending
            ? "Workflow reached a terminal completed state; pending nodes remained on inactive or skipped branches, so no further action is required."
            : (terminalCompleted
                ? "Workflow reached a terminal completed state; no further action is required."
                : "Plan is healthy; continue executing the remaining graph.")));

    const issueAdvisor = {
      status: dagState.status,
      summary,
      recommendedAction,
      failedNodeCount: failedNodes.length,
      pendingNodeCount: pendingNodes.length,
      completedNodeCount: counts.completed,
      suggestedRerun: firstFailed?.suggestedRerun || firstFinding?.suggestedRerun || null,
      retryDecisionClass:
        recommendedAction === "rerun_same_step"
          ? "rerun_same_step"
          : (recommendedAction === "spawn_fix_step"
              ? "spawn_fix_step"
              : ((recommendedAction === "replan_subgraph" || recommendedAction === "replan_from_failed")
                  ? "replan_entire_subgraph"
                  : "inspect_failure")),
      failedNodes: failedNodes.slice(0, 6).map((node) => ({
        nodeId: node.nodeId,
        label: node.label || null,
        error: node.lastError || null,
        attempts: node.attempts || 0,
        issueFindings: Array.isArray(node.issueFindings) ? node.issueFindings.slice(0, 3) : [],
        completionEvidence: Array.isArray(node.completionEvidence) ? node.completionEvidence.slice(0, 3) : [],
      })),
      issueFindings: issueFindings.slice(0, 8),
      completionEvidence: completionEvidence.slice(0, 8),
      updatedAt: dagState.updatedAt,
      nextStepGuidance,
      dagRevisionCount: Array.isArray(dagState.revisions) ? dagState.revisions.length : 0,
    };

    ctx.data._issueAdvisor = issueAdvisor;
    const existingFeedback =
      ctx.data?._plannerFeedback && typeof ctx.data._plannerFeedback === "object" && !Array.isArray(ctx.data._plannerFeedback)
        ? ctx.data._plannerFeedback
        : {};
    ctx.data._plannerFeedback = {
      ...existingFeedback,
      issueAdvisor,
      issueAdvisorSummary: [summary, nextStepGuidance].filter(Boolean).join("\n"),
      dagStateSummary: {
        revisionCount: Array.isArray(dagState.revisions) ? dagState.revisions.length : 0,
        runId: dagState.runId,
        workflowId: dagState.workflowId,
        status: dagState.status,
        counts,
        issueFindingCount: issueFindings.length,
        completionEvidenceCount: completionEvidence.length,
        graph: buildDagGraphSnapshot(dagState),
      },
    };
    return issueAdvisor;
  }

  _buildStepSummary(node, { status = null, result = undefined, error = null } = {}) {
    const nodeId = String(node?.id || "").trim() || null;
    const label = String(node?.label || nodeId || "step").trim();
    const normalizedStatus = String(status || "unknown").trim().toLowerCase() || "unknown";
    let detail = null;
    if (error) {
      detail = String(error).trim();
    } else if (result !== undefined) {
      detail = this._summarizeTaskTraceNodeResult(result);
    }
    if (!detail) {
      detail = normalizedStatus === "completed"
        ? "Step completed successfully."
        : (normalizedStatus === "failed" ? "Step failed." : `Step ${normalizedStatus}.`);
    }
    return {
      nodeId,
      label,
      status: normalizedStatus,
      summary: `${label}: ${detail}`,
    };
  }

  _appendReplayTrajectoryStep(ctx, node, { status = null, result = undefined, error = null, attempt = undefined } = {}) {
    if (!ctx || !node?.id) return;
    const timing = ctx.getNodeTiming(node.id) || {};
    const outputSummary = result !== undefined ? this._summarizeTaskTraceNodeResult(result) : null;
    const replay =
      ctx.data?._replayTrajectory && typeof ctx.data._replayTrajectory === "object"
        ? ctx.data._replayTrajectory
        : { runId: ctx.id, restoredFrom: ctx.data?._restoredFrom || null, steps: [] };
    const step = {
      nodeId: node.id,
      type: node.type || null,
      label: node.label || null,
      status: status || null,
      attempt: Number.isFinite(Number(attempt)) ? Number(attempt) : ctx.getRetryCount(node.id),
      startedAt: Number.isFinite(Number(timing.startedAt)) ? Number(timing.startedAt) : null,
      endedAt: Number.isFinite(Number(timing.endedAt)) ? Number(timing.endedAt) : null,
      input: ctx.getNodeInput(node.id) || null,
      outputSummary,
      error: error ? String(error) : null,
      summary: this._buildStepSummary(node, { status, result, error }).summary,
    };
    replay.runId = ctx.id;
    replay.restoredFrom = ctx.data?._restoredFrom || replay.restoredFrom || null;
    replay.steps = Array.isArray(replay.steps) ? replay.steps.filter((entry) => entry?.nodeId !== node.id) : [];
    replay.steps.push(step);
    ctx.data._replayTrajectory = replay;
  }

  _recordDagNodeOutcome(ctx, node, {
    status,
    result = undefined,
    error = null,
    attempt = undefined,
  } = {}) {
    if (!ctx || !node?.id) return;
    const timing = ctx.getNodeTiming(node.id) || {};
    const issueFindings = collectDagIssueFindings(node, result, error ? String(error) : "");
    const completionEvidence = collectDagCompletionEvidence(node, result);
    const existingDagNode = ctx.data?._dagState?.nodes?.[node.id] || {};
    const nodePatch = cleanObject({
      status,
      attempts: Number.isFinite(Number(attempt)) ? Number(attempt) : ctx.getRetryCount(node.id),
      lastError: error ? String(error) : null,
      outputSummary: result !== undefined ? this._summarizeTaskTraceNodeResult(result) : undefined,
      issueFindings: issueFindings.length > 0 ? issueFindings : (status === NodeStatus.COMPLETED ? [] : (existingDagNode.issueFindings || undefined)),
      completionEvidence: completionEvidence.length > 0
        ? [...(Array.isArray(existingDagNode.completionEvidence) ? existingDagNode.completionEvidence : []), ...completionEvidence]
        : (status === NodeStatus.FAILED ? (existingDagNode.completionEvidence || undefined) : undefined),
      startedAt: Number.isFinite(Number(timing.startedAt)) ? new Date(Number(timing.startedAt)).toISOString() : null,
      endedAt: Number.isFinite(Number(timing.endedAt)) ? new Date(Number(timing.endedAt)).toISOString() : null,
      suggestedRerun:
        result && typeof result === "object"
          ? (result.outputSuggestedRerun || result.outputDiagnostics?.suggestedRerun || undefined)
          : undefined,
      outputHint:
        result && typeof result === "object" && result.outputHint
          ? String(result.outputHint)
          : undefined,
      outputDeltaSummary:
        result && typeof result === "object" && result.outputDeltaSummary
          ? String(result.outputDeltaSummary)
          : undefined,
      outputBudgetPolicy:
        result && typeof result === "object" && result.outputBudgetPolicy
          ? String(result.outputBudgetPolicy)
          : undefined,
      outputBudgetReason:
        result && typeof result === "object" && result.outputBudgetReason
          ? String(result.outputBudgetReason)
          : undefined,
    });
    ctx.annotateDagNode(node.id, nodePatch);
    this._appendReplayTrajectoryStep(ctx, node, { status, result, error, attempt });
    const workflowStatus = error
      ? WorkflowStatus.FAILED
      : (ctx.data?._workflowTerminalStatus || WorkflowStatus.RUNNING);
    this._refreshDagState(ctx, workflowStatus);
  }

  _recordLedgerEvent(event = {}) {
    try {
      this._executionLedger.appendEvent(event);
    } catch (err) {
      console.warn(`${TAG} execution ledger write failed: ${String(err?.message || err)}`);
    }
  }

  _buildLedgerTaskMeta(ctx, extra = {}) {
    const taskId = String(
      ctx?.data?.taskId ||
      ctx?.data?.task?.id ||
      ctx?.data?.taskInfo?.id ||
      ctx?.data?.taskDetail?.id ||
      "",
    ).trim();
    const taskTitle = String(
      ctx?.data?.taskTitle ||
      ctx?.data?.task?.title ||
      ctx?.data?.taskInfo?.title ||
      ctx?.data?.taskDetail?.title ||
      "",
    ).trim();
    const governanceState = buildWorkflowGovernanceState(ctx?.data || {});
    return cleanObject({
      ...extra,
      taskId: taskId || undefined,
      taskTitle: taskTitle || undefined,
      goalAncestry: governanceState.goalAncestry?.length ? governanceState.goalAncestry : undefined,
      primaryGoalId: governanceState.primaryGoalId || undefined,
      primaryGoalTitle: governanceState.primaryGoalTitle || undefined,
      goalDepth: governanceState.goalDepth ?? undefined,
      heartbeatRun: governanceState.heartbeatRun || undefined,
      wakeupRequest: governanceState.wakeupRequest || undefined,
      budgetPolicy: governanceState.budgetPolicy || undefined,
      budgetOutcome: governanceState.budgetOutcome || undefined,
      executionPolicy: governanceState.executionPolicy || undefined,
      policyOutcome: governanceState.policyOutcome || undefined,
    });
  }


  /**
   * Register a per-engine hook for task-linked workflow trace events.
   * The hook is invoked only when a task context is resolved.
   * @param {(event: object) => (void|Promise<void>)} hook
   * @returns {() => void} unsubscribe function
   */
  registerTaskTraceHook(hook) {
    if (typeof hook !== "function") return () => {};
    this._taskTraceHooks.add(hook);
    return () => {
      this._taskTraceHooks.delete(hook);
    };
  }

  _sanitizeTaskId(value) {
    const normalized = String(value ?? "").trim();
    return normalized || "";
  }

  _resolveTemplateDefaultVariable(def, key) {
    if (!def || typeof def !== "object") return undefined;
    if (def?.metadata?.templateState?.isCustomized === true) return undefined;
    const templateId = String(def?.metadata?.installedFrom || "").trim();
    if (!templateId) return undefined;
    const template = getTemplate(templateId);
    if (!template?.variables || typeof template.variables !== "object") return undefined;
    return Object.prototype.hasOwnProperty.call(template.variables, key)
      ? template.variables[key]
      : undefined;
  }

  _applyResumeInputMigrations(def, data = {}) {
    if (!data || typeof data !== "object") return data;
    const next = { ...data };
    const templateId = String(def?.metadata?.installedFrom || "").trim();
    if (templateId === "template-task-lifecycle") {
      const currentValue = next.prePrValidationCommand;
      const nextDefault =
        this._resolveTemplateDefaultVariable(def, "prePrValidationCommand")
        ?? def?.variables?.prePrValidationCommand;
      if (currentValue === "npm run prepush:check" && nextDefault === "auto") {
        next.prePrValidationCommand = nextDefault;
      }
    }
    return next;
  }

  _stripRetryResumeEphemeralData(def, data = {}) {
    if (!data || typeof data !== "object") return data;
    const next = { ...data };
    for (const key of [
      "_workflowSessionId",
      "_workflowRootSessionId",
      "_workflowParentSessionId",
      "_workflowSessionScope",
      "_workflowTaskId",
      "_workflowRunThreadId",
      "_delegatedSessionIds",
    ]) {
      delete next[key];
    }
    const templateId = String(def?.metadata?.installedFrom || "").trim();
    if (templateId === "template-task-lifecycle") {
      for (const key of [
        "claimToken",
        "_claimToken",
        "worktreePath",
        "_worktreeCreated",
        "_worktreeManaged",
        "_pushSkipped",
        "_changedFileCount",
      ]) {
        delete next[key];
      }
    }
    return next;
  }

  _resolveRetryResumeResetStartNodeId(def, data = {}, nodeOutputs = {}, nodeStatuses = {}, retryMode = "from_failed") {
    const templateId = String(def?.metadata?.installedFrom || "").trim();
    if (templateId !== "template-task-lifecycle") return null;
    const claimTaskOutput =
      nodeOutputs?.["claim-task"] && typeof nodeOutputs["claim-task"] === "object"
        ? nodeOutputs["claim-task"]
        : {};
    const claimOkOutput =
      nodeOutputs?.["claim-ok"] && typeof nodeOutputs["claim-ok"] === "object"
        ? nodeOutputs["claim-ok"]
        : {};
    const acquireWorktreeOutput =
      nodeOutputs?.["acquire-worktree"] && typeof nodeOutputs["acquire-worktree"] === "object"
        ? nodeOutputs["acquire-worktree"]
        : {};
    const retryAcquireWorktreeOutput =
      nodeOutputs?.["retry-acquire-wt"] && typeof nodeOutputs["retry-acquire-wt"] === "object"
        ? nodeOutputs["retry-acquire-wt"]
        : {};
    const claimTaskFailedBeforeWorktree =
      nodeStatuses?.["claim-task"] === NodeStatus.COMPLETED &&
      (
        claimOkOutput?.result === false ||
        claimOkOutput?.value === false ||
        nodeStatuses?.["release-slot-claim-failed"] === NodeStatus.COMPLETED ||
        nodeStatuses?.["log-claim-failed"] === NodeStatus.COMPLETED
      );
    if (claimTaskFailedBeforeWorktree) {
      return Array.isArray(def?.nodes) && def.nodes.some((node) => String(node?.id || "").trim() === "claim-task")
        ? "claim-task"
        : null;
    }
    const hadClaimOrWorktreeState = Boolean(
      String(data?.claimToken || data?._claimToken || "").trim()
      || String(data?.worktreePath || "").trim()
      || String(claimTaskOutput.claimToken || claimTaskOutput.id || claimTaskOutput.taskId || "").trim()
      || String(retryAcquireWorktreeOutput.worktreePath || "").trim()
      || String(acquireWorktreeOutput.worktreePath || "").trim(),
    );
    if (!hadClaimOrWorktreeState) return null;
    const latestRetriedWorktreePath = String(retryAcquireWorktreeOutput.worktreePath || "").trim();
    if (
      latestRetriedWorktreePath
      && (
        !existsSync(latestRetriedWorktreePath)
        || !existsSync(join(latestRetriedWorktreePath, ".git"))
      )
    ) {
      return Array.isArray(def?.nodes) && def.nodes.some((node) => String(node?.id || "").trim() === "claim-task")
        ? "claim-task"
        : null;
    }
    const explicitReplanRetry =
      retryMode === "replan_from_failed"
      || retryMode === "replan_subgraph";
    const persistedClaimToken = String(
      data?.claimToken
      || data?._claimToken
      || claimTaskOutput?.claimToken
      || "",
    ).trim();
    const hasCompletedProgressBeyondTaskResources = Object.entries(nodeStatuses || {}).some(
      ([nodeId, status]) =>
        status === NodeStatus.COMPLETED
        && !new Set([
          "trigger",
          "claim-task",
          "claim-ok",
          "acquire-worktree",
        ]).has(String(nodeId || "").trim()),
    );
    if (persistedClaimToken && !explicitReplanRetry && hasCompletedProgressBeyondTaskResources) {
      return null;
    }
    const taskId = this._sanitizeTaskId(
      data?.taskId
      || data?._workflowTaskId
      || claimTaskOutput.taskId
      || claimTaskOutput.id
      || claimOkOutput.taskId
      || claimOkOutput.id,
    );
    if (taskId && this._getLiveLocalTaskClaim(taskId)) {
      return null;
    }
    return Array.isArray(def?.nodes) && def.nodes.some((node) => String(node?.id || "").trim() === "claim-task")
      ? "claim-task"
      : null;
  }

  _resolveNextPendingDagNode(detail = {}, def = null) {
    const pendingStatuses = new Set([NodeStatus.PENDING, NodeStatus.WAITING]);
    const dagNodes =
      detail?.dagState?.nodes && typeof detail.dagState.nodes === "object"
        ? Object.values(detail.dagState.nodes)
        : [];
    const nextFromDag = dagNodes.find((node) =>
      pendingStatuses.has(String(node?.status || "").trim().toLowerCase()),
    );
    if (nextFromDag) {
      const nodeId = String(nextFromDag.nodeId || "").trim();
      const nodeDef = Array.isArray(def?.nodes)
        ? def.nodes.find((entry) => String(entry?.id || "").trim() === nodeId) || null
        : null;
      return {
        nodeId,
        label: String(nextFromDag.label || nodeDef?.label || nodeId || "").trim() || null,
        type: String(nextFromDag.type || nodeDef?.type || "").trim() || null,
        config: nodeDef?.config && typeof nodeDef.config === "object" ? nodeDef.config : {},
      };
    }

    if (!Array.isArray(def?.nodes)) return null;
    const nodeStatuses =
      detail?.nodeStatuses && typeof detail.nodeStatuses === "object"
        ? detail.nodeStatuses
        : {};
    for (const node of def.nodes) {
      const nodeId = String(node?.id || "").trim();
      if (!nodeId) continue;
      const status = String(nodeStatuses[nodeId] || NodeStatus.PENDING).trim().toLowerCase();
      if (!pendingStatuses.has(status)) continue;
      return {
        nodeId,
        label: String(node?.label || nodeId).trim() || null,
        type: String(node?.type || "").trim() || null,
        config: node?.config && typeof node.config === "object" ? node.config : {},
      };
    }
    return null;
  }

  _resolvePersistedResumeCheckpoint(runOrDetail, def = null) {
    const run =
      runOrDetail?.detail && typeof runOrDetail.detail === "object"
        ? runOrDetail
        : null;
    const detail = run?.detail || runOrDetail || {};
    const checkpoint = detail?.checkpoint && typeof detail.checkpoint === "object"
      ? detail.checkpoint
      : (detail?.data?._workflowCheckpoint && typeof detail.data._workflowCheckpoint === "object"
        ? detail.data._workflowCheckpoint
        : null);
    if (!checkpoint) return null;
    const workflowDefinition = def || detail?.workflowDefinition || detail?.data?._workflowDefinitionSnapshot || null;
    const nextPendingNodeId = String(checkpoint.nextPendingNodeId || "").trim();
    if (nextPendingNodeId) {
      const nodeDef = Array.isArray(workflowDefinition?.nodes)
        ? workflowDefinition.nodes.find((node) => String(node?.id || "").trim() === nextPendingNodeId) || null
        : null;
      return {
        nodeId: nextPendingNodeId,
        label: String(checkpoint.nextPendingNodeLabel || nodeDef?.label || nextPendingNodeId).trim() || null,
        type: String(checkpoint.nextPendingNodeType || nodeDef?.type || "").trim() || null,
        planningTaskRef: checkpoint.planningTaskRef && typeof checkpoint.planningTaskRef === "object"
          ? checkpoint.planningTaskRef
          : null,
        reason: String(checkpoint.reason || "checkpoint.next_pending_node").trim() || "checkpoint.next_pending_node",
        source: "persisted_checkpoint",
      };
    }
    const lastCompletedNodeId = String(checkpoint.lastCompletedNodeId || "").trim();
    if (!lastCompletedNodeId) return null;
    return {
      nodeId: lastCompletedNodeId,
      label: String(checkpoint.lastCompletedNodeLabel || lastCompletedNodeId).trim() || null,
      type: null,
      planningTaskRef: checkpoint.planningTaskRef && typeof checkpoint.planningTaskRef === "object"
        ? checkpoint.planningTaskRef
        : null,
      reason: String(checkpoint.reason || "checkpoint.last_completed_node").trim() || "checkpoint.last_completed_node",
      source: "persisted_checkpoint",
    };
  }

  _resolvePendingCreateTasksGuard(runOrDetail, def = null) {
    const run =
      runOrDetail?.detail && typeof runOrDetail.detail === "object"
        ? runOrDetail
        : null;
    const detail = run?.detail || runOrDetail || {};
    const runStatus = String(run?.status || detail?.status || "").trim().toLowerCase();
    if (runStatus !== WorkflowStatus.PAUSED) return null;

    const checkpointResume = this._resolvePersistedResumeCheckpoint(detail, def);
    const nextPending = checkpointResume?.nodeId
      ? {
          nodeId: checkpointResume.nodeId,
          label: checkpointResume.label,
          type: checkpointResume.type,
          config: Array.isArray(def?.nodes)
            ? (def.nodes.find((node) => String(node?.id || "").trim() === checkpointResume.nodeId)?.config || {})
            : {},
        }
      : this._resolveNextPendingDagNode(detail, def);
    if (!nextPending || String(nextPending.type || "").trim() !== "action.materialize_planner_tasks") {
      return null;
    }

    const dedupEnabled = nextPending.config?.dedup !== false;
    const hasListTasks = typeof this.services?.kanban?.listTasks === "function";
    const safeResume = dedupEnabled && hasListTasks;
    const blockers = [];
    if (!dedupEnabled) blockers.push("dedup is disabled on the Create Tasks node");
    if (!hasListTasks) blockers.push("the Kanban adapter cannot list existing tasks for idempotent recovery");
    const nextNodeLabel = nextPending.label || nextPending.nodeId || "Create Tasks";
    const summary =
      `Run is paused with ${nextNodeLabel} as the next pending node, and task creation may already be partially applied.`;

    return {
      code: "create_tasks_pending",
      nextNodeId: nextPending.nodeId,
      nextNodeLabel,
      nextNodeType: nextPending.type,
      safeResume,
      dedupEnabled,
      hasListTasks,
      blockers,
      summary,
      manualRetryMessage:
        `${summary} Manual retry is blocked to avoid duplicate task creation. ` +
        `${safeResume
          ? "Use interrupted-run resume so existing tasks can be prefetched and skipped."
          : "Interrupted-run resume is also blocked until idempotent recovery is available."}`,
      resumeBlockedMessage:
        `${summary} Interrupted-run resume is blocked because ${blockers.join(" and ") || "idempotent recovery is not available"}.`,
      resumeAllowedMessage:
        `${summary} Interrupted-run resume is allowed because dedup is enabled and existing tasks can be prefetched before re-running Create Tasks.`,
    };
  }

  resolveOperatorRetry(runId, requestedMode = "from_failed") {
    const run = this.getRunDetail(runId);
    if (!run) {
      throw new Error(`${TAG} Run "${runId}" not found — cannot resolve retry request`);
    }

    const mode = ["from_scratch", "replan_from_failed", "replan_subgraph"].includes(
      String(requestedMode || "").trim().toLowerCase(),
    )
      ? String(requestedMode || "").trim().toLowerCase()
      : "from_failed";
    const retryOptions = this.getRetryOptions(runId);
    const selectedOption = Array.isArray(retryOptions?.options)
      ? retryOptions.options.find((entry) => String(entry?.mode || "").trim().toLowerCase() === mode) || null
      : null;
    const guardedState =
      retryOptions?.guardedState && typeof retryOptions.guardedState === "object"
        ? retryOptions.guardedState
        : null;
    const createTasksResume =
      String(run?.status || "").trim().toLowerCase() === WorkflowStatus.PAUSED &&
      mode === "from_failed" &&
      guardedState?.code === "create_tasks_pending" &&
      guardedState?.safeResume === true;
    const operatorAction = createTasksResume
      ? "resume"
      : (mode === "from_scratch" ? "restart" : "retry");
    const decisionReason = createTasksResume
      ? String(
          selectedOption?.reason ||
          retryOptions?.recommendedReason ||
          "create_tasks_pending.resume_only",
        ).trim()
      : null;
    const blocked = selectedOption?.available === false;
    let blockedMessage = null;
    if (blocked) {
      blockedMessage = String(
        selectedOption?.description ||
        retryOptions?.summary ||
        "",
      ).trim() || null;
      const recommendedMode = String(retryOptions?.recommendedMode || "").trim().toLowerCase();
      const recommendedOption = recommendedMode && Array.isArray(retryOptions?.options)
        ? retryOptions.options.find((entry) => String(entry?.mode || "").trim().toLowerCase() === recommendedMode) || null
        : null;
      if (recommendedOption && recommendedMode !== mode) {
        const recommendedMessage = [
          recommendedOption?.label ? `Recommended alternative: ${recommendedOption.label}.` : null,
          String(recommendedOption?.description || "").trim() || null,
        ].filter(Boolean).join(" ");
        if (recommendedMessage) {
          blockedMessage = [blockedMessage, recommendedMessage].filter(Boolean).join(" ");
        }
      }
    }

    return {
      runId: run.runId,
      status: run.status,
      mode,
      operatorAction,
      decisionReason,
      blocked,
      blockedMessage,
      guardedState,
      selectedOption,
      retryOptions,
      retryArgs: {
        mode,
        ...(createTasksResume ? { _resumeInterrupted: true } : {}),
        ...(decisionReason ? { _decisionReason: decisionReason } : {}),
      },
    };
  }

  _rehydrateTaskLifecycleRetryState(ctx, data = {}, nodeOutputs = {}) {
    if (!ctx?.data || typeof ctx.data !== "object") return;
    const claimTaskOutput =
      nodeOutputs?.["claim-task"] && typeof nodeOutputs["claim-task"] === "object"
        ? nodeOutputs["claim-task"]
        : {};
    const acquireWorktreeOutput =
      nodeOutputs?.["acquire-worktree"] && typeof nodeOutputs["acquire-worktree"] === "object"
        ? nodeOutputs["acquire-worktree"]
        : {};
    const persistedClaimToken = String(
      ctx.data?._claimToken
      || data?._claimToken
      || data?.claimToken
      || claimTaskOutput?.claimToken
      || "",
    ).trim();
    if (persistedClaimToken) {
      ctx.data._claimToken = persistedClaimToken;
    }
    const persistedClaimInstanceId = String(
      ctx.data?._claimInstanceId
      || data?._claimInstanceId
      || data?.claimInstanceId
      || claimTaskOutput?.instanceId
      || "",
    ).trim();
    if (persistedClaimInstanceId) {
      ctx.data._claimInstanceId = persistedClaimInstanceId;
    }
    const persistedWorktreePath = String(
      ctx.data?.worktreePath
      || data?.worktreePath
      || acquireWorktreeOutput?.worktreePath
      || data?.task?.worktreePath
      || "",
    ).trim();
    if (persistedWorktreePath) {
      ctx.data.worktreePath = persistedWorktreePath;
      if (ctx.data.task && typeof ctx.data.task === "object" && !String(ctx.data.task.worktreePath || "").trim()) {
        ctx.data.task.worktreePath = persistedWorktreePath;
      }
    }
    if (ctx.data._worktreeCreated == null) {
      if (typeof data?._worktreeCreated === "boolean") {
        ctx.data._worktreeCreated = data._worktreeCreated;
      } else if (typeof acquireWorktreeOutput?.created === "boolean") {
        ctx.data._worktreeCreated = acquireWorktreeOutput.created;
      }
    }
    if (ctx.data._worktreeManaged == null) {
      if (typeof data?._worktreeManaged === "boolean") {
        ctx.data._worktreeManaged = data._worktreeManaged;
      } else if (persistedWorktreePath) {
        ctx.data._worktreeManaged = true;
      }
    }
  }

  _resolveTaskTraceContext(ctx, node = null, result = null) {
    const nodeTaskIdCandidate = (() => {
      if (!node?.config || typeof node.config !== "object") return "";
      try {
        const resolved = ctx.resolve(node.config.taskId || node.config.id || "");
        return this._sanitizeTaskId(resolved);
      } catch {
        return "";
      }
    })();

    const resultTaskId = this._sanitizeTaskId(
      result?.taskId ||
      result?.id ||
      result?.task?.id ||
      result?.task?.task_id,
    );
    const taskId = this._sanitizeTaskId(
      ctx?.data?.taskId ||
      ctx?.data?.activeTaskId ||
      ctx?.data?.task?.id ||
      ctx?.data?.task?.task_id ||
      nodeTaskIdCandidate ||
      resultTaskId,
    );
    if (!taskId) return null;

    const nodeTaskTitleCandidate = (() => {
      if (!node?.config || typeof node.config !== "object") return "";
      try {
        const resolved = ctx.resolve(node.config.taskTitle || node.config.title || "");
        return String(resolved || "").trim();
      } catch {
        return "";
      }
    })();

    const taskTitle = String(
      ctx?.data?.taskTitle ||
      ctx?.data?.task?.title ||
      result?.taskTitle ||
      result?.title ||
      result?.task?.title ||
      nodeTaskTitleCandidate ||
      "",
    ).trim() || null;

    return {
      taskId,
      taskTitle,
      branch: String(
        ctx?.data?.branch ||
        ctx?.data?.branchName ||
        result?.branch ||
        result?.branchName ||
        "",
      ).trim() || null,
      prNumber: String(
        ctx?.data?.prNumber ||
        result?.prNumber ||
        "",
      ).trim() || null,
      prUrl: String(
        ctx?.data?.prUrl ||
        result?.prUrl ||
        "",
      ).trim() || null,
      workspaceId: String(
        ctx?.data?._workspaceId ||
        ctx?.data?.workspaceId ||
        ctx?.data?.task?.meta?.workspaceId ||
        result?.workspaceId ||
        result?.task?.meta?.workspaceId ||
        "",
      ).trim() || null,
      sessionId: String(
        ctx?.data?.sessionId ||
        ctx?.data?.threadId ||
        ctx?.data?.task?.meta?.sessionId ||
        result?.sessionId ||
        result?.threadId ||
        "",
      ).trim() || null,
      agentId: String(
        ctx?.data?.agentId ||
        ctx?.data?.task?.assignee ||
        result?.agentId ||
        result?.task?.assignee ||
        "",
      ).trim() || null,
    };
  }

  _summarizeTaskTraceNodeResult(result) {
    if (result == null) return null;
    if (typeof result === "string") {
      const text = result.trim();
      return text.length > 240 ? `${text.slice(0, 239)}…` : text;
    }
    if (typeof result === "number" || typeof result === "boolean") {
      return String(result);
    }
    if (Array.isArray(result)) {
      return `array(${result.length})`;
    }
    if (typeof result === "object") {
      if (result.error) return String(result.error);
      if (result.message) return String(result.message);
      if (result.output && typeof result.output === "string") {
        const text = result.output.trim();
        return text.length > 240 ? `${text.slice(0, 239)}…` : text;
      }
      const keys = Object.keys(result).filter(Boolean).slice(0, 8);
      return keys.length ? `object{${keys.join(",")}}` : "object";
    }
    return null;
  }

  _appendTaskTraceToContext(ctx, event) {
    if (!ctx?.data || typeof ctx.data !== "object") return;
    const existing = Array.isArray(ctx.data._taskWorkflowEvents)
      ? ctx.data._taskWorkflowEvents
      : [];
    existing.push(event);
    if (existing.length > MAX_TASK_TRACE_EVENTS_PER_RUN) {
      ctx.data._taskWorkflowEvents = existing.slice(-MAX_TASK_TRACE_EVENTS_PER_RUN);
      return;
    }
    ctx.data._taskWorkflowEvents = existing;
  }

  async _dispatchTaskTrace(event) {
    const handlers = [];
    for (const hook of this._taskTraceHooks) {
      if (typeof hook === "function") handlers.push(hook);
    }

    const directHandler = this.services?.onTaskWorkflowEvent;
    if (typeof directHandler === "function") handlers.push(directHandler);

    const serviceObjects = [
      this.services?.taskTraceCollector,
      this.services?.taskTimeline,
      this.services?.taskEvents,
      this.services?.taskState,
    ].filter(Boolean);
    const methodNames = [
      "onTaskWorkflowEvent",
      "collectTaskWorkflowEvent",
      "appendWorkflowEvent",
      "collect",
      "append",
      "handleEvent",
    ];
    for (const service of serviceObjects) {
      for (const methodName of methodNames) {
        const fn = service?.[methodName];
        if (typeof fn === "function") {
          handlers.push((payload) => fn.call(service, payload));
          break;
        }
      }
    }

    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (err) {
        console.warn(
          `${TAG} task trace handler failed: ${String(err?.message || err)}`,
        );
      }
    }
  }

  async _emitTaskTraceEvent(kind, {
    ctx,
    workflowId,
    workflowName,
    runId,
    node = null,
    result = null,
    status = null,
    error = null,
    durationMs = null,
    extra = null,
  } = {}) {
    const taskContext = this._resolveTaskTraceContext(ctx, node, result);
    if (!taskContext) return null;

    const nowMs = Date.now();
    const activeTrace = getCurrentTraceContext();
    const event = {
      eventType: String(kind || "").trim(),
      timestamp: new Date(nowMs).toISOString(),
      timestampMs: nowMs,
      taskId: taskContext.taskId,
      taskTitle: taskContext.taskTitle,
      workflowId: workflowId || ctx?.data?._workflowId || null,
      workflowName: workflowName || ctx?.data?._workflowName || null,
      runId: runId || ctx?.id || null,
      status: status || null,
      nodeId: node?.id || null,
      nodeType: node?.type || null,
      nodeLabel: node?.label || null,
      summary: this._summarizeTaskTraceNodeResult(result),
      error: error ? String(error) : null,
      durationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : null,
      branch: taskContext.branch,
      prNumber: taskContext.prNumber,
      prUrl: taskContext.prUrl,
      workspaceId: taskContext.workspaceId,
      sessionId: taskContext.sessionId,
      agentId: taskContext.agentId,
      traceId: activeTrace?.traceId || null,
      spanId: activeTrace?.spanId || null,
      parentSpanId: activeTrace?.parentSpanId || null,
      benchmarkHint:
        kind === "workflow.run.end" || kind === "workflow.run.error"
          ? sanitizeJsonValue(ctx?.data?._selfImprovementInsights?.benchmark || null)
          : null,
      meta: extra && typeof extra === "object" ? extra : null,
    };

    this._appendTaskTraceToContext(ctx, event);
    this.emit("task:trace", event);
    await this._dispatchTaskTrace(event);
    recordHarnessTelemetryEvent({
      timestamp: event.timestamp,
      eventType: event.eventType,
      type: event.eventType,
      source: "workflow-engine",
      category: "workflow",
      taskId: event.taskId,
      sessionId: event.sessionId || event.runId || event.taskId,
      runId: event.runId,
      workflowId: event.workflowId,
      workflowName: event.workflowName,
      status: event.status,
      durationMs: event.durationMs,
      summary: event.summary,
      message: event.error || event.summary || null,
      traceId: event.traceId,
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      payload: {
        nodeId: event.nodeId,
        nodeType: event.nodeType,
        nodeLabel: event.nodeLabel,
        error: event.error,
        meta: event.meta,
      },
      meta: {
        source: "workflow-engine",
        taskTitle: event.taskTitle,
        workspaceId: event.workspaceId,
        agentId: event.agentId,
        branch: event.branch,
        prNumber: event.prNumber,
        prUrl: event.prUrl,
      },
    }, { configDir: process.cwd() });
    return event;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Load all workflow definitions from disk */
  load() {
    this._ensureDirs();
    this._workflows.clear();
    if (!existsSync(this.workflowDir)) return;

    const files = readdirSync(this.workflowDir).filter(
      (f) => extname(f) === ".json"
    );
    for (const file of files) {
      try {
        const raw = readFileSync(resolve(this.workflowDir, file), "utf8");
        const def = hydrateWorkflowDefinition(JSON.parse(raw));
        if (def.id) {
          this._workflows.set(def.id, def);
        }
      } catch (err) {
        console.error(`${TAG} Failed to load workflow ${file}:`, err.message);
      }
    }
    this._loaded = true;
    this.emit("loaded", { count: this._workflows.size });

    // Detect runs that were interrupted by a previous shutdown.
    // These are runs persisted to disk with status=RUNNING that are
    // NOT in our in-memory _activeRuns (because we just booted).
    if (this.detectInterruptedRuns) {
      this._detectInterruptedRuns();
    }
  }

  /** Ensure storage directories exist */
  _ensureDirs() {
    mkdirSync(this.workflowDir, { recursive: true });
    mkdirSync(this.runsDir, { recursive: true });
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  /** List all workflows */
  list() {
    if (!this._loaded) this.load();
    return Array.from(this._workflows.values()).map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      category: w.category,
      enabled: w.enabled !== false,
      core: w.core === true,
      trigger: w.trigger,
      nodeCount: w.nodes?.length || 0,
      edgeCount: w.edges?.length || 0,
      metadata: w.metadata,
    }));
  }

  /** Get a single workflow definition */
  get(id) {
    if (!this._loaded) this.load();
    const workflowId = String(id || "").trim();
    if (!workflowId) return null;
    const exact = this._workflows.get(workflowId);
    if (exact) return exact;
    for (const workflow of this._workflows.values()) {
      if (workflow?.metadata?.installedFrom === workflowId) {
        return workflow;
      }
    }
    return null;
  }

  _resolveEnabledInstalledWorkflow(workflowId) {
    if (!this._loaded) this.load();
    const requestedId = String(workflowId || "").trim();
    if (!requestedId) return null;
    const candidates = [];
    for (const workflow of this._workflows.values()) {
      if (workflow?.metadata?.installedFrom !== requestedId) continue;
      const hydrated = hydrateWorkflowDefinition(workflow, { strict: true });
      if (hydrated.enabled === false) continue;
      candidates.push(hydrated);
    }
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => {
      const leftUpdatedAt = Date.parse(left?.metadata?.updatedAt || "") || 0;
      const rightUpdatedAt = Date.parse(right?.metadata?.updatedAt || "") || 0;
      return rightUpdatedAt - leftUpdatedAt;
    });
    return candidates[0];
  }

  /** Save (create or update) a workflow definition */
  save(def) {
    def = hydrateWorkflowDefinition(def, { strict: true });
    if (!def.id) def.id = randomUUID();
    if (!def.metadata) def.metadata = {};
    def.metadata.updatedAt = new Date().toISOString();
    if (!def.metadata.createdAt) {
      def.metadata.createdAt = def.metadata.updatedAt;
    }
    def.metadata.version = (def.metadata.version || 0) + 1;

    // Prevent disabling core workflows — unless paused by another workflow
    const existing = this._workflows.get(def.id);
    if (existing?.core === true && def.enabled === false) {
      if (!def.metadata?.pausedByWorkflow) {
        def.enabled = true;
      }
    }
    // Preserve core flag — cannot be removed via save
    if (existing?.core === true) {
      def.core = true;
    }

    this._ensureDirs();
    this._workflows.set(def.id, def);
    const filePath = resolve(this.workflowDir, `${def.id}.json`);
    writeFileSync(filePath, JSON.stringify(def, null, 2), "utf8");
    this.emit("saved", { id: def.id, name: def.name });

    // ── Grouped flows: auto-enable required sibling workflows ───────────
    // When a template-backed workflow is enabled, ensure all workflows from
    // its requiredTemplates group are also enabled so chains don't break.
    if (def.enabled !== false && def.metadata?.installedFrom) {
      this._autoEnableGroupedWorkflows(def);
    }

    return def;
  }

  /**
   * When a workflow from a grouped template is enabled, find sibling
   * workflows installed from that template's requiredTemplates and enable
   * them if they're currently disabled.
   * @private
   */
  _autoEnableGroupedWorkflows(def) {
    try {
      // requiredTemplates is stored in the workflow's own metadata
      // (carried over from the template definition during install)
      const requiredIds = def.metadata?.requiredTemplates;
      if (!Array.isArray(requiredIds) || requiredIds.length === 0) return;

      for (const depId of requiredIds) {
        for (const [, wf] of this._workflows) {
          if (wf.metadata?.installedFrom === depId && wf.enabled === false) {
            wf.enabled = true;
            wf.metadata.updatedAt = new Date().toISOString();
            wf.metadata.version = (wf.metadata.version || 0) + 1;
            const fp = resolve(this.workflowDir, `${wf.id}.json`);
            writeFileSync(fp, JSON.stringify(wf, null, 2), "utf8");
            this.emit("saved", { id: wf.id, name: wf.name });
          }
        }
      }
    } catch {
      /* best-effort — should not crash save() */
    }
  }

  /** Delete a workflow */
  delete(id) {
    const existing = this._workflows.get(id);
    if (existing?.core === true) {
      throw new Error(`Cannot delete core workflow "${existing.name || id}"`);
    }
    this._workflows.delete(id);
    const filePath = resolve(this.workflowDir, `${id}.json`);
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch { /* ignore */ }
    this.emit("deleted", { id });
    return true;
  }

  /** Import a workflow from JSON */
  import(json) {
    const def = typeof json === "string" ? JSON.parse(json) : json;
    def.id = randomUUID(); // Always assign new ID on import
    return this.save(def);
  }

  /** Export a workflow as JSON string */
  export(id) {
    const def = this.get(id);
    if (!def) throw new Error(`Workflow "${id}" not found`);
    return JSON.stringify(def, null, 2);
  }

  // ── Concurrency Stats ───────────────────────────────────────────────

  /**
   * Return live concurrency stats for monitoring / dashboards.
   * @returns {{ activeRuns: number, maxConcurrentRuns: number, queuedRuns: number, maxConcurrentBranches: number }}
   */
  getConcurrencyStats() {
    let agentSlots;
    agentSlots = getHarnessRuntimeSlotStatus();
    return {
      activeRuns: this._runSlots,
      maxConcurrentRuns: MAX_CONCURRENT_RUNS,
      queuedRuns: this._runQueue.length,
      sharedRootRuns: this._rootRunSlotRefs.size,
      maxConcurrentBranches: MAX_CONCURRENT_BRANCHES,
      ...(agentSlots && {
        agentSlots: {
          active: agentSlots.activeSlots,
          max: agentSlots.maxParallel,
          queued: agentSlots.queuedSlots,
        },
      }),
    };
  }

  async _acquireRunSlot({ workflowId, workflowName, inputData = {}, opts = {} } = {}) {
    const rootRunId = resolveWorkflowRootRunId(inputData, opts);
    if (rootRunId && this._rootRunSlotRefs.has(rootRunId)) {
      this._rootRunSlotRefs.set(rootRunId, (this._rootRunSlotRefs.get(rootRunId) || 0) + 1);
      return { rootRunId, shared: true };
    }

    if (this._runSlots >= MAX_CONCURRENT_RUNS) {
      this.emit("run:queued", {
        workflowId,
        name: workflowName,
        queueDepth: this._runQueue.length + 1,
        rootRunId,
      });
      await new Promise((resolve, reject) => {
        this._runQueue.push({ resolve, reject, rootRunId });
      });
    }

    this._runSlots++;
    if (rootRunId) {
      this._rootRunSlotRefs.set(rootRunId, 1);
    }
    return { rootRunId, shared: false };
  }

  _releaseRunSlot(slotLease = null) {
    if (slotLease?._released) {
      return;
    }
    if (slotLease && typeof slotLease === "object") {
      slotLease._released = true;
    }

    if (slotLease?.rootRunId && this._rootRunSlotRefs.has(slotLease.rootRunId)) {
      const remainingRefs = (this._rootRunSlotRefs.get(slotLease.rootRunId) || 0) - 1;
      if (remainingRefs > 0) {
        this._rootRunSlotRefs.set(slotLease.rootRunId, remainingRefs);
      } else {
        this._rootRunSlotRefs.delete(slotLease.rootRunId);
      }
    }

    if (slotLease?.shared) {
      return;
    }

    this._runSlots = Math.max(0, this._runSlots - 1);
    if (this._runQueue.length > 0) {
      const next = this._runQueue.shift();
      next.resolve();
    }
  }

  _adoptRunSlotRootId(slotLease = null, runId = null) {
    if (!slotLease || slotLease.shared || slotLease.rootRunId || !runId) return;
    slotLease.rootRunId = String(runId);
    this._rootRunSlotRefs.set(slotLease.rootRunId, 1);
  }

  // ── Execution ─────────────────────────────────────────────────────────


  /**
   * Execute a workflow with given input data.
   * @param {string} workflowId
   * @param {object} inputData - Initial context data
   * @param {object} [opts] - { dryRun, timeout }
   * @returns {Promise<WorkflowContext>}
   */
  async execute(workflowId, inputData = {}, opts = {}) {
    const persistedDef = this.get(workflowId);
    if (!persistedDef) throw new Error(`${TAG} Workflow "${workflowId}" not found`);
    let def = hydrateWorkflowDefinition(persistedDef, { strict: true });
    if (def.enabled === false && !opts.force) {
      const installedAlias = this._resolveEnabledInstalledWorkflow(workflowId);
      if (installedAlias) {
        def = installedAlias;
      }
    }
    if (def.enabled === false && !opts.force) {
      throw new Error(`${TAG} Workflow "${def.name}" is disabled`);
    }

    const slotLease = await this._acquireRunSlot({
      workflowId,
      workflowName: def.name,
      inputData,
      opts,
    });

    try {
      return await traceWorkflowRun(
        {
          workflowId,
          name: def.name,
          triggerSource: inputData?._triggerSource || null,
          taskId: resolveTraceTaskId(inputData),
          agentId: resolveTraceAgentId(inputData),
          parentRunId: opts._parentRunId || inputData?._workflowParentRunId || inputData?._parentRunId || null,
          rootRunId: opts._rootRunId || inputData?._workflowRootRunId || inputData?._rootRunId || null,
        },
        async (span) => {
          const ctx = await this._executeInner(def, workflowId, inputData, {
            ...opts,
            _slotLease: slotLease,
          });
          attachWorkflowContextAlias(ctx);
          span.attributes["bosun.workflow.run_id"] = ctx?.id || span.attributes["bosun.workflow.run_id"];
          span.attributes["bosun.workflow.parent_run_id"] =
            ctx?.data?._workflowParentRunId || span.attributes["bosun.workflow.parent_run_id"];
          span.attributes["bosun.workflow.root_run_id"] =
            ctx?.data?._workflowRootRunId || ctx?.id || span.attributes["bosun.workflow.root_run_id"];
          return ctx;
        },
      );
    } finally {
      this._releaseRunSlot(slotLease);
    }
  }

  /**
   * Execute an ephemeral workflow definition without saving it to the registry.
   * Useful for inline/embedded workflow composition where the child flow should
   * have its own run/context history but not become an installed workflow.
   *
   * @param {object} workflowDef
   * @param {object} inputData
   * @param {object} [opts]
   * @returns {Promise<WorkflowContext>}
   */
  async executeDefinition(workflowDef, inputData = {}, opts = {}) {
    const requestedId = String(workflowDef?.id || opts.inlineWorkflowId || "").trim();
    const workflowId = requestedId || `inline:${randomUUID()}`;
    const normalized = hydrateWorkflowDefinition({
      enabled: true,
      trigger: workflowDef?.trigger || "trigger.workflow_call",
      ...workflowDef,
      id: workflowId,
      name: String(workflowDef?.name || opts.inlineWorkflowName || workflowId).trim() || workflowId,
      metadata: {
        ...(workflowDef?.metadata || {}),
        inline: true,
        ephemeral: true,
        sourceNodeId: opts.sourceNodeId || workflowDef?.metadata?.sourceNodeId || null,
      },
    }, { strict: true });

    if (normalized.enabled === false && !opts.force) {
      throw new Error(`${TAG} Inline workflow "${normalized.name}" is disabled`);
    }

    const slotLease = await this._acquireRunSlot({
      workflowId: normalized.id,
      workflowName: normalized.name,
      inputData,
      opts,
    });

    try {
      return await traceWorkflowRun(
        {
          workflowId: normalized.id,
          name: normalized.name,
          triggerSource: inputData?._triggerSource || normalized.trigger || null,
          taskId: resolveTraceTaskId(inputData),
          agentId: resolveTraceAgentId(inputData, opts.sourceNodeId || ""),
          parentRunId: opts._parentRunId || inputData?._workflowParentRunId || inputData?._parentRunId || null,
          rootRunId: opts._rootRunId || inputData?._workflowRootRunId || inputData?._rootRunId || null,
        },
        async (span) => {
          const ctx = await this._executeInner(normalized, normalized.id, inputData, {
            ...opts,
            _slotLease: slotLease,
            force: true,
          });
          attachWorkflowContextAlias(ctx);
          span.attributes["bosun.workflow.run_id"] = ctx?.id || span.attributes["bosun.workflow.run_id"];
          span.attributes["bosun.workflow.parent_run_id"] =
            ctx?.data?._workflowParentRunId || span.attributes["bosun.workflow.parent_run_id"];
          span.attributes["bosun.workflow.root_run_id"] =
            ctx?.data?._workflowRootRunId || ctx?.id || span.attributes["bosun.workflow.root_run_id"];
          return ctx;
        },
      );
    } finally {
      this._releaseRunSlot(slotLease);
    }
  }

  /**
   * Inner execute logic — called only once a concurrency slot is acquired.
   * @private
   */
  async _executeInner(def, workflowId, inputData, opts) {
    const initialData = this._applyResumeInputMigrations(def, {
      ...def.variables,
      ...inputData,
    });
    const governanceState = buildWorkflowGovernanceState(initialData);

    const ctx = new WorkflowContext({
      ...initialData,
      ...toWorkflowGovernanceData(governanceState),
      _workflowId: workflowId,
      _workflowName: def.name,
      _workflowDefinitionSnapshot: cloneRunSnapshot(def),
      ...(opts._decisionReason ? { _retryDecisionReason: opts._decisionReason } : {}),
      ...(opts._parentExecutionId ? { _workflowParentExecutionId: opts._parentExecutionId } : {}),
    });
    const workflowRunSession = resolveWorkflowRunSessionBinding({
      ctx,
      workflowId,
      workflowName: def.name,
    });
    ctx.data._workflowSessionId = workflowRunSession.sessionId;
    ctx.data._workflowRootSessionId = workflowRunSession.rootSessionId;
    ctx.data._workflowParentSessionId = workflowRunSession.parentSessionId;
    ctx.data._workflowSessionScope = workflowRunSession.scope;
    ctx.data._workflowTaskId = workflowRunSession.taskId;
    ctx.variables = { ...def.variables };
    this._initializeDagState(def, ctx, {
      rootRunId:
        opts._rootRunId ||
        initialData._workflowRootRunId ||
        initialData._rootRunId ||
        null,
      parentRunId:
        opts._parentRunId ||
        initialData._workflowParentRunId ||
        initialData._parentRunId ||
        null,
      retryOf: opts._originalRunId || initialData._retryOf || null,
      retryMode: opts._retryMode || null,
    });

    const runId = ctx.id;
    ctx.data._workflowRunThreadId = runId;
    this._adoptRunSlotRootId(opts?._slotLease, runId);
    this._activeRuns.set(runId, {
      workflowId,
      workflowName: def.name,
      ctx,
      startedAt: ctx.startedAt,
      status: WorkflowStatus.RUNNING,
    });
    const harnessSessionNode = await loadHarnessSessionNodeModule();
    const workflowSessionLink = harnessSessionNode.beginWorkflowLinkedSessionExecution(
      ctx,
      {
        id: "workflow-run",
        label: def.name,
      },
      this,
      {
        sessionId: workflowRunSession.sessionId,
        threadId: runId,
        parentSessionId: workflowRunSession.parentSessionId,
        rootSessionId: workflowRunSession.rootSessionId,
        taskId: workflowRunSession.taskId,
        taskTitle: workflowRunSession.taskTitle,
        taskKey: workflowRunSession.taskId || workflowRunSession.sessionId,
        cwd: workflowRunSession.cwd,
        status: "running",
        sessionType: "workflow-overseer",
        scope: workflowRunSession.scope,
        runtimeRole: "overseer",
        source: "workflow-engine-run",
        metadata: {
          workflowRunId: runId,
          workflowId,
          workflowName: def.name,
          runtimeRole: "overseer",
        },
        deferWorkerAttachment: false,
      },
    );

    // ── Persist run immediately so it survives process restarts ──────
    this._persistActiveRunState(runId, workflowId, def.name, ctx);
    try {
      this._executionLedger.ensureRun({
        runId,
        workflowId,
        workflowName: def.name,
        rootRunId: ctx.data?._workflowRootRunId || runId,
        parentRunId: ctx.data?._workflowParentRunId || null,
        sessionId: ctx.data?._workflowSessionId || ctx.data?.sessionId || null,
        threadId: ctx.data?._workflowRunThreadId || ctx.data?.threadId || ctx.data?._workflowSessionId || null,
        retryOf: ctx.data?._retryOf || null,
        retryMode: opts._retryMode || null,
        startedAt: new Date(ctx.startedAt).toISOString(),
        status: WorkflowStatus.RUNNING,
        ...governanceState,
      });
    } catch (err) {
      console.warn(`${TAG} execution ledger ensureRun failed: ${String(err?.message || err)}`);
    }

    this.emit("run:start", { runId, workflowId, name: def.name });
    this._emitWorkflowStatus({
      runId,
      workflowId,
      workflowName: def.name,
      eventType: "run:start",
      status: WorkflowStatus.RUNNING,
      meta: {
        triggerSource: ctx.data?._triggerSource || null,
      },
    });
    this._recordLedgerEvent({
      eventType: "run.start",
      runId,
      workflowId,
      workflowName: def.name,
      rootRunId: ctx.data?._workflowRootRunId || runId,
      parentRunId: ctx.data?._workflowParentRunId || null,
      sessionId: ctx.data?._workflowSessionId || ctx.data?.sessionId || null,
      threadId: ctx.data?._workflowRunThreadId || ctx.data?.threadId || ctx.data?._workflowSessionId || null,
      rootSessionId: ctx.data?._workflowRootSessionId || ctx.data?._workflowSessionId || ctx.data?.sessionId || null,
      parentSessionId: ctx.data?._workflowParentSessionId || null,
      delegationDepth: ctx.data?._workflowDelegationDepth ?? 0,
      retryOf: ctx.data?._retryOf || null,
      retryMode: opts._retryMode || null,
      parentExecutionId: ctx.data?._workflowParentExecutionId || null,
      status: WorkflowStatus.RUNNING,
      meta: this._buildLedgerTaskMeta(ctx, {
        triggerSource: ctx.data?._triggerSource || null,
        targetRepo: ctx.data?._targetRepo || null,
        decisionReason: opts._decisionReason || null,
      }),
    });
    await this._emitTaskTraceEvent("workflow.run.start", {
      ctx,
      runId,
      workflowId,
      workflowName: def.name,
      status: WorkflowStatus.RUNNING,
    });

    try {
      // Build adjacency map
      const adjacency = this._buildAdjacency(def);

      // Find trigger/entry nodes (nodes with no incoming edges)
      const entryNodes = this._findEntryNodes(def);
      if (entryNodes.length === 0) {
        throw new Error("Workflow has no entry nodes (no triggers or unconnected nodes)");
      }

      // Execute the DAG
      await this._executeDag(def, entryNodes, adjacency, ctx, opts);

      const status = this._resolveWorkflowStatus(ctx);
      this._activeRuns.get(runId).status = status;
      this._refreshDagState(ctx, status);
      const terminalError = Array.isArray(ctx.errors) && ctx.errors.length
        ? String(ctx.errors[ctx.errors.length - 1]?.error || "").trim()
        : "";
      if (status === WorkflowStatus.FAILED && terminalError) {
        this.emit("run:error", { runId, workflowId, error: terminalError });
        this._emitWorkflowStatus({
          runId,
          workflowId,
          workflowName: def.name,
          eventType: "run:error",
          status: WorkflowStatus.FAILED,
          error: terminalError,
          durationMs: Date.now() - ctx.startedAt,
        });
      }
      this.emit("run:end", { runId, workflowId, status, duration: Date.now() - ctx.startedAt });
      this._emitWorkflowStatus({
        runId,
        workflowId,
        workflowName: def.name,
        eventType: "run:end",
        status,
        durationMs: Date.now() - ctx.startedAt,
      });
      this._recordLedgerEvent({
        eventType: "run.end",
        runId,
        workflowId,
        workflowName: def.name,
        rootRunId: ctx.data?._workflowRootRunId || runId,
        parentRunId: ctx.data?._workflowParentRunId || null,
        sessionId: ctx.data?._workflowSessionId || ctx.data?.sessionId || null,
        threadId: ctx.data?._workflowRunThreadId || ctx.data?.threadId || ctx.data?._workflowSessionId || null,
        rootSessionId: ctx.data?._workflowRootSessionId || ctx.data?._workflowSessionId || ctx.data?.sessionId || null,
        parentSessionId: ctx.data?._workflowParentSessionId || null,
        delegationDepth: ctx.data?._workflowDelegationDepth ?? 0,
        retryOf: ctx.data?._retryOf || null,
        retryMode: opts._retryMode || null,
        parentExecutionId: ctx.data?._workflowParentExecutionId || null,
        status,
        durationMs: Date.now() - ctx.startedAt,
        summary: ctx.data?._issueAdvisor?.summary || null,
        meta: this._buildLedgerTaskMeta(ctx, {
          decisionReason: opts._decisionReason || null,
        }),
      });
      await this._emitTaskTraceEvent("workflow.run.end", {
        ctx,
        runId,
        workflowId,
        workflowName: def.name,
        status,
        durationMs: Date.now() - ctx.startedAt,
      });
      harnessSessionNode.finalizeWorkflowLinkedSessionExecution(workflowSessionLink, {
        sessionId: workflowRunSession.sessionId,
        threadId: runId,
        success: status !== WorkflowStatus.FAILED,
        status: status === WorkflowStatus.FAILED ? "failed" : "completed",
        result: {
          runId,
          workflowId,
          workflowName: def.name,
          status,
        },
        output: ctx.data?._workflowTerminalOutput || null,
        error: status === WorkflowStatus.FAILED ? terminalError || "workflow_failed" : null,
      });
    } catch (err) {
      ctx.error("_engine", err);
      this._activeRuns.get(runId).status = WorkflowStatus.FAILED;
      this._refreshDagState(ctx, WorkflowStatus.FAILED);
      this.emit("run:error", { runId, workflowId, error: err.message });
      this._emitWorkflowStatus({
        runId,
        workflowId,
        workflowName: def.name,
        eventType: "run:error",
        status: WorkflowStatus.FAILED,
        error: err.message,
        durationMs: Date.now() - ctx.startedAt,
      });
      this._recordLedgerEvent({
        eventType: "run.error",
        runId,
        workflowId,
        workflowName: def.name,
        rootRunId: ctx.data?._workflowRootRunId || runId,
        parentRunId: ctx.data?._workflowParentRunId || null,
        sessionId: ctx.data?._workflowSessionId || ctx.data?.sessionId || null,
        threadId: ctx.data?._workflowRunThreadId || ctx.data?.threadId || ctx.data?._workflowSessionId || null,
        rootSessionId: ctx.data?._workflowRootSessionId || ctx.data?._workflowSessionId || ctx.data?.sessionId || null,
        parentSessionId: ctx.data?._workflowParentSessionId || null,
        delegationDepth: ctx.data?._workflowDelegationDepth ?? 0,
        retryOf: ctx.data?._retryOf || null,
        retryMode: opts._retryMode || null,
        parentExecutionId: ctx.data?._workflowParentExecutionId || null,
        status: WorkflowStatus.FAILED,
        durationMs: Date.now() - ctx.startedAt,
        error: err.message,
        summary: ctx.data?._issueAdvisor?.summary || null,
        meta: this._buildLedgerTaskMeta(ctx, {
          decisionReason: opts._decisionReason || null,
        }),
      });
      await this._emitTaskTraceEvent("workflow.run.error", {
        ctx,
        runId,
        workflowId,
        workflowName: def.name,
        status: WorkflowStatus.FAILED,
        error: err?.message || String(err),
        durationMs: Date.now() - ctx.startedAt,
      });
      harnessSessionNode.finalizeWorkflowLinkedSessionExecution(workflowSessionLink, {
        sessionId: workflowRunSession.sessionId,
        threadId: runId,
        success: false,
        status: "failed",
        result: {
          runId,
          workflowId,
          workflowName: def.name,
          status: WorkflowStatus.FAILED,
        },
        error: err?.message || String(err),
      });
    }

    // Persist final run log and remove from active-runs index
    this._persistRun(runId, workflowId, ctx);
    this._clearActiveRunState(runId);
    this._activeRuns.delete(runId);

    // ── Auto-retry on failure ───────────────────────────────────────────
    // If the workflow failed and auto-retry is enabled, kick off the
    // escalating retry strategy asynchronously. The caller still receives the
    // original (failed) context immediately so we never block the event loop.
    const finalStatus = this._resolveWorkflowStatus(ctx);
    if (finalStatus === WorkflowStatus.FAILED && !opts._isRetry) {
      const retryConfig = this._resolveAutoRetryConfig(def);
      if (retryConfig.enabled) {
        // Fire-and-forget — errors are logged, never thrown.
        this._autoRetryLoop(runId, workflowId, inputData, retryConfig, opts).catch((err) => {
          console.error(`${TAG} Auto-retry loop error for run ${runId}:`, err.message);
        });
      }
    }

    return ctx;
  }

  // ── Run Retry ───────────────────────────────────────────────────────────

  /**
   * Retry a previously completed (failed) run.
   *
   * @param {string} runId - The original run ID to retry.
   * @param {object} [retryOpts]
   * @param {"from_failed"|"from_scratch"|"replan_from_failed"|"replan_subgraph"} [retryOpts.mode="from_failed"]
   *   - `"from_failed"` — re-execute starting from the first failed node,
   *     pre-populating the context with already-completed node outputs.
   *   - `"from_scratch"` — re-execute the entire workflow from the beginning
   *     with the same input data that was used originally.
   *   - `"replan_from_failed"` / `"replan_subgraph"` — preserve completed
   *     outputs like `from_failed` while keeping the requested replan mode
   *     explicit for planner-aware downstream steps.
   * @returns {Promise<{retryRunId: string, mode: string, ctx: WorkflowContext}>}
   */
  async retryRun(runId, retryOpts = {}) {
    const requestedMode = String(retryOpts.mode || "").trim().toLowerCase();
    const mode =
      requestedMode === "from_scratch" ||
      requestedMode === "replan_from_failed" ||
      requestedMode === "replan_subgraph"
        ? requestedMode
        : "from_failed";
    const decisionReason = String(retryOpts._decisionReason || "").trim() || null;
    const originalRun = this.getRunDetail(runId);
    if (!originalRun) {
      throw new Error(`${TAG} Run "${runId}" not found — cannot retry`);
    }

    const workflowId = originalRun.workflowId || originalRun.detail?.data?._workflowId;
    if (!workflowId) {
      throw new Error(`${TAG} Cannot determine workflowId from run "${runId}"`);
    }

    const def = this.get(workflowId);
    if (!def) {
      throw new Error(`${TAG} Workflow "${workflowId}" no longer exists — cannot retry`);
    }
    const createTasksGuard = this._resolvePendingCreateTasksGuard(originalRun, def);
    const isResumeLikeRetry =
      mode === "from_failed"
      || mode === "replan_from_failed"
      || mode === "replan_subgraph";
    const blocksManualRestart = mode === "from_scratch" && createTasksGuard?.safeResume;
    if (createTasksGuard && (isResumeLikeRetry || blocksManualRestart)) {
      if (retryOpts._resumeInterrupted === true) {
        if (!createTasksGuard.safeResume) {
          throw new Error(`${TAG} ${createTasksGuard.resumeBlockedMessage}`);
        }
      } else {
        throw new Error(`${TAG} ${createTasksGuard.manualRetryMessage}`);
      }
    }

    // Recover original input data (strip internal enrichment keys).
    const originalData = { ...(originalRun.detail?.data || {}) };
    delete originalData._workflowId;
    delete originalData._workflowName;
    const retryData = this._stripRetryResumeEphemeralData(
      def,
      this._applyResumeInputMigrations(def, originalData),
    );

    this.emit("run:retry", {
      originalRunId: runId,
      workflowId,
      mode,
      attempt: retryOpts._attempt || 1,
      decisionReason,
    });

    if (mode === "from_scratch") {
      const originalRootRunId =
        originalRun.detail?.dagState?.rootRunId ||
        originalRun.detail?.data?._workflowRootRunId ||
        originalRun.runId ||
        runId;
      const ctx = await this.execute(workflowId, retryData, {
        ...retryOpts,
        _isRetry: true,
        _originalRunId: runId,
        _parentRunId: runId,
        _rootRunId: originalRootRunId,
        _retryMode: mode,
        _dagRevisionReason: "retry_replan_subgraph",
        force: true,
      });
      return { retryRunId: ctx.id, mode, originalRunId: runId, ctx };
    }

    // ── "from_failed" — resume from the first failed node ────────────
    const detail = originalRun.detail || {};
    const nodeStatuses = detail.nodeStatuses || {};
    const nodeOutputs = detail.nodeOutputs || {};
    const adjacency = this._buildAdjacency(def);
    const resumeResetStartNodeId = this._resolveRetryResumeResetStartNodeId(
      def,
      originalData,
      nodeOutputs,
      nodeStatuses,
      mode,
    );
    const resumeResetNodeIds = resumeResetStartNodeId
      ? this._collectSubgraph(resumeResetStartNodeId, adjacency)
      : new Set();

    // Build a fresh context but pre-seed completed node outputs.
    const ctx = new WorkflowContext({
      ...def.variables,
      ...retryData,
      _workflowId: workflowId,
      _workflowName: def.name,
      _workflowDefinitionSnapshot: cloneRunSnapshot(def),
      _retryOf: runId,
    });
    ctx.variables = { ...def.variables };
    this._initializeDagState(def, ctx, {
      rootRunId:
        originalRun.detail?.dagState?.rootRunId ||
        originalRun.detail?.data?._workflowRootRunId ||
        runId,
      parentRunId: runId,
      retryOf: runId,
      retryMode: mode,
    });

    // Pre-populate nodes that already succeeded.
    const preservedCompletedNodeIds = [];
    const focusNodeIds = [];
    for (const [nodeId, status] of Object.entries(nodeStatuses)) {
      if (resumeResetNodeIds.has(nodeId)) {
        focusNodeIds.push(nodeId);
        continue;
      }
      if (status === NodeStatus.COMPLETED) {
        preservedCompletedNodeIds.push(nodeId);
        ctx.setNodeStatus(nodeId, NodeStatus.COMPLETED);
        if (nodeOutputs[nodeId] !== undefined) {
          ctx.setNodeOutput(nodeId, nodeOutputs[nodeId]);
        }
        this._recordDagNodeOutcome(ctx, { id: nodeId }, {
          status: NodeStatus.COMPLETED,
          result: nodeOutputs[nodeId],
        });
      } else if (status) {
        focusNodeIds.push(nodeId);
      }
      // Reset failed / skipped nodes so the DAG will re-run them.
    }
    this._rehydrateTaskLifecycleRetryState(ctx, originalData, nodeOutputs);

    this._recordDagRevision(ctx, {
      reason: "retry_resume",
      sourceRunId: runId,
      preservedCompletedNodeIds,
      resetStartNodeId: resumeResetStartNodeId || undefined,
      resetNodeIds: resumeResetNodeIds.size > 0 ? [...resumeResetNodeIds] : undefined,
    });

    this._recordDagRevision(ctx, {
      reason:
        mode === "from_failed" || mode === "replan_from_failed"
          ? "retry_replan_from_failed"
          : `retry_${mode}`,
      sourceRunId: runId,
      preservedCompletedNodeIds,
      focusNodeIds,
      resetStartNodeId: resumeResetStartNodeId || undefined,
      resetNodeIds: resumeResetNodeIds.size > 0 ? [...resumeResetNodeIds] : undefined,
    });

    const retryRunId = ctx.id;
    this._activeRuns.set(retryRunId, {
      workflowId,
      workflowName: def.name,
      ctx,
      startedAt: ctx.startedAt,
      status: WorkflowStatus.RUNNING,
    });
    this._persistActiveRunState(retryRunId, workflowId, def.name, ctx);
    this.emit("run:start", { runId: retryRunId, workflowId, name: def.name, retryOf: runId, mode });
    this._emitWorkflowStatus({
      runId: retryRunId,
      workflowId,
      workflowName: def.name,
      eventType: "run:start",
      status: WorkflowStatus.RUNNING,
      meta: { retryOf: runId, mode },
    });
    this._recordLedgerEvent({
      eventType: "run.start",
      runId: retryRunId,
      workflowId,
      workflowName: def.name,
      rootRunId: ctx.data?._workflowRootRunId || retryRunId,
      parentRunId: runId,
      retryOf: runId,
      retryMode: mode,
      status: WorkflowStatus.RUNNING,
      meta: this._buildLedgerTaskMeta(ctx, {
        decisionReason,
      }),
    });
    await this._emitTaskTraceEvent("workflow.run.start", {
      ctx,
      runId: retryRunId,
      workflowId,
      workflowName: def.name,
      status: WorkflowStatus.RUNNING,
      extra: { retryOf: runId, mode },
    });

    try {
      const entryNodes = this._findEntryNodes(def);
      if (entryNodes.length === 0) {
        throw new Error("Workflow has no entry nodes (no triggers or unconnected nodes)");
      }

      // _executeDag naturally skips nodes that are already COMPLETED because
      // they were pre-seeded above, so it resumes from the failed point.
      await this._executeDag(def, entryNodes, adjacency, ctx, { ...retryOpts, _isRetry: true });

      const status = this._resolveWorkflowStatus(ctx);
      this._activeRuns.get(retryRunId).status = status;
      this._refreshDagState(ctx, status);
      this.emit("run:end", {
        runId: retryRunId,
        workflowId,
        status,
        duration: Date.now() - ctx.startedAt,
        retryOf: runId,
        mode,
      });
      this._emitWorkflowStatus({
        runId: retryRunId,
        workflowId,
        workflowName: def.name,
        eventType: "run:end",
        status,
        durationMs: Date.now() - ctx.startedAt,
        meta: { retryOf: runId, mode },
      });
      this._recordLedgerEvent({
        eventType: "run.end",
        runId: retryRunId,
        workflowId,
        workflowName: def.name,
        rootRunId: ctx.data?._workflowRootRunId || retryRunId,
        parentRunId: runId,
        retryOf: runId,
        retryMode: mode,
        status,
        durationMs: Date.now() - ctx.startedAt,
        summary: ctx.data?._issueAdvisor?.summary || null,
        meta: {
          decisionReason,
        },
      });
      await this._emitTaskTraceEvent("workflow.run.end", {
        ctx,
        runId: retryRunId,
        workflowId,
        workflowName: def.name,
        status,
        durationMs: Date.now() - ctx.startedAt,
        extra: { retryOf: runId, mode },
      });
    } catch (err) {
      ctx.error("_engine", err);
      this._activeRuns.get(retryRunId).status = WorkflowStatus.FAILED;
      this._refreshDagState(ctx, WorkflowStatus.FAILED);
      this.emit("run:error", { runId: retryRunId, workflowId, error: err.message, retryOf: runId });
      this._emitWorkflowStatus({
        runId: retryRunId,
        workflowId,
        workflowName: def.name,
        eventType: "run:error",
        status: WorkflowStatus.FAILED,
        error: err.message,
        durationMs: Date.now() - ctx.startedAt,
        meta: { retryOf: runId, mode },
      });
      this._recordLedgerEvent({
        eventType: "run.error",
        runId: retryRunId,
        workflowId,
        workflowName: def.name,
        rootRunId: ctx.data?._workflowRootRunId || retryRunId,
        parentRunId: runId,
        retryOf: runId,
        retryMode: mode,
        status: WorkflowStatus.FAILED,
        durationMs: Date.now() - ctx.startedAt,
        error: err.message,
        summary: ctx.data?._issueAdvisor?.summary || null,
        meta: {
          decisionReason,
        },
      });
      await this._emitTaskTraceEvent("workflow.run.error", {
        ctx,
        runId: retryRunId,
        workflowId,
        workflowName: def.name,
        status: WorkflowStatus.FAILED,
        error: err?.message || String(err),
        durationMs: Date.now() - ctx.startedAt,
        extra: { retryOf: runId, mode },
      });
    }

    this._persistRun(retryRunId, workflowId, ctx);
    this._clearActiveRunState(retryRunId);
    this._activeRuns.delete(retryRunId);

    return { retryRunId, mode, originalRunId: runId, ctx };
  }

  async _shouldResumeTaskScopedRunFromScratch(run, detail, def) {
    const taskId = this._resolveRunTaskIdentity(run, detail)?.taskId || "";
    if (!taskId) return false;

    const nodes = Array.isArray(def?.nodes) ? def.nodes : [];
    const hasClaimNode = nodes.some(
      (node) => String(node?.type || "").trim().toLowerCase() === "action.claim_task",
    );
    if (!hasClaimNode) return false;

    const persistedClaimToken = String(
      detail?.data?._claimToken ||
      detail?._claimToken ||
      detail?.nodeOutputs?.["claim-task"]?.claimToken ||
      "",
    ).trim();
    if (persistedClaimToken) return false;

    try {
      const { listClaims } = await import("../task/task-claims.mjs");
      if (typeof listClaims !== "function") return false;
      const activeClaims = await listClaims();
      return !activeClaims.some((claim) => String(claim?.task_id || "").trim() === taskId);
    } catch {
      return false;
    }
  }

  // ── Auto-retry escalating strategy ───────────────────────────────────

  /**
   * Resolve the auto-retry configuration for a workflow definition.
   * Supports per-workflow overrides via `def.autoRetry`.
   */
  _resolveAutoRetryConfig(def) {
    const raw = def?.autoRetry || {};
    // Auto-retry is opt-in: workflows must explicitly set autoRetry.enabled = true.
    // This prevents unexpected background retries for workflows that don't want them.
    const enabled = Boolean(raw.enabled);
    const maxAttempts = Number.isFinite(Number(raw.maxAttempts))
      ? Math.max(0, Math.trunc(Number(raw.maxAttempts)))
      : DEFAULT_AUTO_RETRY_MAX_ATTEMPTS;
    const cooldownMs = Number.isFinite(Number(raw.cooldownMs))
      ? Math.max(0, Math.trunc(Number(raw.cooldownMs)))
      : DEFAULT_AUTO_RETRY_COOLDOWN_MS;
    return { enabled: enabled && maxAttempts > 0, maxAttempts, cooldownMs };
  }

  _resolveWorkflowStatus(ctx) {
    const terminalRaw = String(ctx?.data?._workflowTerminalStatus || "")
      .trim()
      .toLowerCase();
    if (terminalRaw === WorkflowStatus.FAILED || terminalRaw === "error") {
      return WorkflowStatus.FAILED;
    }
    if (terminalRaw === WorkflowStatus.CANCELLED) {
      return WorkflowStatus.CANCELLED;
    }
    if (terminalRaw === WorkflowStatus.COMPLETED || terminalRaw === "success") {
      return WorkflowStatus.COMPLETED;
    }
    return ctx.errors.length > 0 ? WorkflowStatus.FAILED : WorkflowStatus.COMPLETED;
  }

  _chooseRetryModeFromDetail(detail, options = {}) {
    const fallbackMode = options.fallbackMode === "from_scratch"
      ? "from_scratch"
      : "from_failed";
    const issueAdvisor =
      detail?.issueAdvisor && typeof detail.issueAdvisor === "object"
        ? detail.issueAdvisor
        : null;
    const dagCounts =
      detail?.dagState?.counts && typeof detail.dagState.counts === "object"
        ? detail.dagState.counts
        : null;
    const counts = dagCounts || this._countNodeStatuses(detail?.nodeStatuses || {});
    const completedCount = Number(counts.completed ?? counts.completedCount ?? 0) || 0;
    const failedCount = Number(counts.failed ?? counts.failedCount ?? 0) || 0;

    let mode = fallbackMode;
    let reason = `fallback:${fallbackMode}`;

    if (issueAdvisor?.recommendedAction === "resume_remaining") {
      mode = "from_failed";
      reason = "issue_advisor.resume_remaining";
    } else if (issueAdvisor?.recommendedAction === "rerun_same_step") {
      mode = "from_failed";
      reason = "issue_advisor.rerun_same_step";
    } else if (issueAdvisor?.recommendedAction === "spawn_fix_step") {
      mode = "from_failed";
      reason = "issue_advisor.spawn_fix_step";
    } else if (issueAdvisor?.recommendedAction === "replan_subgraph") {
      mode = "replan_subgraph";
      reason = "issue_advisor.replan_subgraph";
    } else if (issueAdvisor?.recommendedAction === "replan_from_failed") {
      mode = "replan_from_failed";
      reason = "issue_advisor.replan_from_failed";
    } else if (issueAdvisor?.recommendedAction === "inspect_failure") {
      mode = "from_scratch";
      reason = "issue_advisor.inspect_failure";
    } else if (completedCount <= 0) {
      mode = "from_scratch";
      reason = "dag_state.no_completed_nodes";
    } else if (failedCount > 1) {
      mode = "from_scratch";
      reason = "dag_state.multiple_failures";
    } else if (completedCount > 0) {
      mode = "from_failed";
      reason = "dag_state.localized_resume";
    }

    return {
      mode,
      reason,
      suggestedRetryMode: mode,
      fallbackMode,
      completedCount,
      failedCount,
      issueAdvisorRecommendation: issueAdvisor?.recommendedAction || null,
      issueAdvisorSummary: issueAdvisor?.summary || null,
    };
  }

  _chooseRetryModeForRun(runDetail, options = {}) {
    return this._chooseRetryModeFromDetail(runDetail?.detail || {}, options);
  }

  /**
   * Escalating auto-retry loop.
   *
   * Strategy (configurable, defaults to 3 attempts):
   *   Attempt 1 → from_failed (immediate)
   *   Attempt 2 → from_scratch (immediate)
   *   Attempt 3 → from_scratch (after cooldown period, default 20 min)
   *
   * If the workflow succeeds at any point the loop stops.
   * Results are persisted as separate runs linked via `_retryOf`.
   */
  async _autoRetryLoop(originalRunId, workflowId, inputData, retryConfig, baseOpts) {
    const { maxAttempts, cooldownMs } = retryConfig;
    const originalRun = this.getRunDetail(originalRunId);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const retryDecision = this._chooseRetryModeForRun(originalRun, {
        fallbackMode: attempt === 1 ? "from_failed" : "from_scratch",
      });
      const mode = attempt === 1 ? retryDecision.mode : "from_scratch";
      const needsCooldown = attempt >= 3 && cooldownMs > 0;

      if (needsCooldown) {
        console.log(
          `${TAG} Auto-retry attempt ${attempt}/${maxAttempts} for run ${originalRunId} ` +
          `— cooling down for ${Math.round(cooldownMs / 1000)}s before retry`,
        );
        this.emit("run:retry:cooldown", {
          originalRunId,
          workflowId,
          attempt,
          cooldownMs,
        });
        await new Promise((r) => setTimeout(r, cooldownMs));
      }

      console.log(
        `${TAG} Auto-retry attempt ${attempt}/${maxAttempts} for run ${originalRunId} ` +
        `(mode=${mode}, reason=${retryDecision.reason})`,
      );

      try {
        const { ctx, retryRunId } = await this.retryRun(originalRunId, {
          mode,
          _isRetry: true,
          _attempt: attempt,
          _decisionReason: retryDecision.reason,
        });

        if (!ctx.errors || ctx.errors.length === 0) {
          console.log(
            `${TAG} Auto-retry succeeded on attempt ${attempt}/${maxAttempts} ` +
            `for run ${originalRunId} → new run ${retryRunId}`,
          );
          this.emit("run:retry:success", {
            originalRunId,
            retryRunId,
            workflowId,
            attempt,
            mode,
            decisionReason: retryDecision.reason,
          });
          return; // Success — stop retrying
        }

        console.warn(
          `${TAG} Auto-retry attempt ${attempt}/${maxAttempts} failed ` +
          `for run ${originalRunId} → new run ${retryRunId}`,
        );
        this.emit("run:retry:failed", {
          originalRunId,
          retryRunId,
          workflowId,
          attempt,
          mode,
          decisionReason: retryDecision.reason,
          errors: ctx.errors,
        });
      } catch (err) {
        console.error(
          `${TAG} Auto-retry attempt ${attempt}/${maxAttempts} threw for run ${originalRunId}:`,
          err.message,
        );
        this.emit("run:retry:failed", {
          originalRunId,
          workflowId,
          attempt,
          mode,
          decisionReason: retryDecision.reason,
          errors: [{ error: err.message }],
        });
      }
    }

    console.error(
      `${TAG} All ${maxAttempts} auto-retry attempts exhausted for run ${originalRunId}`,
    );
    this.emit("run:retry:exhausted", { originalRunId, workflowId, maxAttempts });
  }

  /**
   * Evaluate trigger conditions to see if a workflow should fire.
   * Called by the supervisor loop or event bus.
   */
  async evaluateTriggers(eventType, eventData = {}) {
    if (!this._loaded) this.load();

    const triggered = [];
    for (const [id, def] of this._workflows) {
      if (def.enabled === false) continue;

      // Find trigger nodes
      const triggerNodes = (def.nodes || []).filter((n) =>
        n.type.startsWith("trigger.")
      );
      for (const tNode of triggerNodes) {
        // Event-driven evaluation should only run event-capable trigger types.
        // Polling/manual triggers (schedule, task_low, manual, scheduled_once)
        // are intentionally excluded here.
        if (
          tNode.type !== "trigger.event" &&
          tNode.type !== "trigger.pr_event" &&
          tNode.type !== "trigger.task_assigned" &&
          tNode.type !== "trigger.anomaly" &&
          tNode.type !== "trigger.webhook" &&
          tNode.type !== "trigger.meeting.wake_phrase"
        ) {
          continue;
        }
        if (tNode.type === "trigger.pr_event") {
          const hasPrSignal =
            String(eventType || "").startsWith("pr.") ||
            !!eventData?.prEvent;
          if (!hasPrSignal) continue;
        }
        if (
          tNode.type === "trigger.task_assigned"
          && eventType !== "task.assigned"
          && eventType !== "task.review_fix_requested"
        ) {
          continue;
        }
        if (tNode.type === "trigger.anomaly") {
          const anomalyEvent =
            eventType === "anomaly" ||
            eventType === "agent.anomaly";
          if (!anomalyEvent) continue;
        }
        if (tNode.type === "trigger.webhook" && !String(eventType || "").startsWith("webhook")) {
          continue;
        }
        if (tNode.type === "trigger.meeting.wake_phrase") {
          const meetingEvent =
            eventType === "meeting.transcript" ||
            eventType === "voice.transcript" ||
            eventType === "meeting.wake_phrase";
          if (!meetingEvent) continue;
        }

        const handler = getNodeType(tNode.type);
        if (!handler) continue;

        try {
          const shouldFire = await handler.execute(tNode, {
            data: eventData,
            eventType,
          });
          if (shouldFire?.triggered) {
            triggered.push({ workflowId: id, triggeredBy: tNode.id, eventData });
          }
        } catch {
          // Trigger evaluation errors are non-fatal
        }
      }
    }
    return triggered;
  }

  // ── Schedule trigger evaluation ──────────────────────────────────────────

  /**
   * Evaluate polling workflows.
   * Unlike evaluateTriggers() (event-driven), this is polling-based and should
   * be called periodically (e.g. every 60s) by the monitor.
   *
   * Returns an array of { workflowId, triggeredBy, workspaceId } for workflows
   * whose polling interval has elapsed since their last completed run.
   *
   * @param {{ configDir?: string }} [opts] Options for workspace-aware evaluation.
   */
  evaluateScheduleTriggers(opts = {}) {
    if (!this._loaded) this.load();

    const triggered = [];
    const runIndex = this._listPersistedRunSummaries(null, MAX_PERSISTED_RUNS).runs;
    const latestRunAtByWorkflow = new Map();
    for (const entry of runIndex) {
      const workflowId = entry?.workflowId;
      if (!workflowId) continue;
      const ts = Number(entry?.startedAt || entry?.completedAt || 0);
      if (!Number.isFinite(ts) || ts <= 0) continue;
      const previous = latestRunAtByWorkflow.get(workflowId) || 0;
      if (ts > previous) {
        latestRunAtByWorkflow.set(workflowId, ts);
      }
    }

    // Load workspace state for filtering
    const wsMgr = ensureWorkspaceManagerSync();
    const configDir = opts?.configDir || this._configDir || getRuntimeCwd();
    let workspaceSummary = null;
    if (wsMgr?.getWorkspaceStateSummary) {
      try {
        workspaceSummary = wsMgr.getWorkspaceStateSummary(configDir);
      } catch { /* workspace manager not available — skip workspace filtering */ }
    }
    const batchDispatcherEnabled = Array.from(this._workflows.values()).some(
      (workflow) =>
        workflow?.enabled !== false &&
        String(workflow?.metadata?.installedFrom || "").trim() === "template-task-batch-processor",
    );

    for (const [id, def] of this._workflows) {
      if (def.enabled === false) continue;
      const templateId = String(def?.metadata?.installedFrom || "").trim();
      if (batchDispatcherEnabled && templateId === "template-task-lifecycle") {
        continue;
      }

      // ── Workspace gate ──────────────────────────────────────────────
      const wfWorkspaceId = def.workspaceId || def.workspace || null;
      if (wfWorkspaceId && workspaceSummary) {
        const ws = workspaceSummary.find((w) => w.id === wfWorkspaceId);
        if (ws && !ws.isActive) {
          continue; // workspace paused or disabled — skip
        }
        if (ws && wsMgr?.isWorkflowAllowedForWorkspace) {
          const fullWs = wsMgr.getWorkspace(configDir, wfWorkspaceId);
          if (fullWs && !wsMgr.isWorkflowAllowedForWorkspace(fullWs, id)) {
            continue; // workflow blacklisted or not in whitelist for this workspace
          }
        }
      }

      // Skip workflows that are already running
      const alreadyRunning = Array.from(this._activeRuns.values()).some(
        (info) => info?.workflowId === id,
      );
      if (alreadyRunning) continue;

      const triggerNodes = (def.nodes || []).filter((n) =>
        n.type === "trigger.schedule"
        || n.type === "trigger.scheduled_once"
        || n.type === "trigger.task_available"
        || n.type === "trigger.task_low",
      );

      const scheduleCtx = new WorkflowContext({
        ...(def.variables || {}),
        ...(def.data || {}),
      });

      const resolvePositiveInterval = (rawValue, fallbackMs) => {
        const resolved = scheduleCtx.resolve(rawValue);
        const parsed = Number(resolved);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
      };

      for (const tNode of triggerNodes) {
        let intervalMs = 3600000;
        if (tNode.type === "trigger.task_available") {
          intervalMs = resolvePositiveInterval(tNode.config?.pollIntervalMs, 30000);
        } else if (tNode.type === "trigger.task_low") {
          intervalMs = resolvePositiveInterval(tNode.config?.pollIntervalMs, 60000);
        } else {
          intervalMs = resolvePositiveInterval(tNode.config?.intervalMs, 3600000);
        }

        const lastRunAt = latestRunAtByWorkflow.get(id) || 0;

        const elapsed = Date.now() - lastRunAt;
        if (elapsed >= intervalMs) {
          triggered.push({ workflowId: id, triggeredBy: tNode.id, workspaceId: wfWorkspaceId });

          // For scheduled_once, only fire if never run before
          if (tNode.type === "trigger.scheduled_once" && lastRunAt > 0) {
            triggered.pop(); // undo — already ran once
          }
        }
      }
    }
    return triggered;
  }

  /** Get status of active runs */
  getActiveRuns() {
    return Array.from(this._activeRuns.entries())
      .map(([runId, info]) => this._buildActiveRunSummary(runId, info))
      .filter(Boolean);
  }

  _pruneTaskLifecycleSlotReservations() {
    if (!(this._taskLifecycleSlotReservations instanceof Map)) {
      this._taskLifecycleSlotReservations = new Map();
      return this._taskLifecycleSlotReservations;
    }
    for (const [runId, reservation] of this._taskLifecycleSlotReservations.entries()) {
      if (!this._activeRuns.has(runId) || !reservation || typeof reservation !== "object") {
        this._taskLifecycleSlotReservations.delete(runId);
        continue;
      }
      if (String(reservation.status || "").trim().toLowerCase() === "released") {
        this._taskLifecycleSlotReservations.delete(runId);
      }
    }
    return this._taskLifecycleSlotReservations;
  }

  releaseTaskLifecycleSlotReservation(runId) {
    const normalizedRunId = String(runId || "").trim();
    if (!normalizedRunId) return;
    this._pruneTaskLifecycleSlotReservations().delete(normalizedRunId);
  }

  reserveTaskLifecycleSlot(options = {}) {
    const runId = String(options?.runId || "").trim();
    const taskId = String(options?.taskId || "").trim();
    const maxParallel = Number(options?.maxParallel ?? 0) || 0;
    const baseBranchLimit = Number(options?.baseBranchLimit ?? 0) || 0;
    const baseBranch = String(options?.baseBranch || "").trim().replace(/^origin\//, "");
    const reservations = this._pruneTaskLifecycleSlotReservations();
    const snapshot = this.getTaskLifecycleSlotSnapshot({ excludeTaskId: taskId });
    const activeSlotCount = Number(snapshot?.activeSlotCount || 0) || 0;
    const slotsAvailable = activeSlotCount < maxParallel;
    let baseBranchOk = true;
    if (baseBranchLimit > 0 && baseBranch) {
      const counts = snapshot?.baseBranchSlotCounts || {};
      baseBranchOk = (counts[baseBranch] ?? 0) < baseBranchLimit;
    }
    const result = slotsAvailable && baseBranchOk;

    if (result && runId && taskId) {
      reservations.set(runId, {
        taskId,
        baseBranch,
        reservedAt: Date.now(),
        status: "reserved",
      });
    }

    return { result, slotsAvailable, baseBranchOk, activeSlotCount, maxParallel };
  }

  getTaskLifecycleSlotSnapshot(options = {}) {
    const excludeTaskId = String(options?.excludeTaskId || "").trim();
    const activeTaskIds = [];
    const baseBranchSlotCounts = {};
    const slotEntries = new Map();

    const registerSlot = (slotInfo = null) => {
      const taskId = String(slotInfo?.taskId || "").trim();
      if (!taskId || taskId === excludeTaskId || slotEntries.has(taskId)) return;
      slotEntries.set(taskId, {
        taskId,
        baseBranch: String(slotInfo?.baseBranch || "").trim().replace(/^origin\//, ""),
      });
    };

    for (const info of this._activeRuns.values()) {
      const workflowName = String(
        info?.workflowName || info?.ctx?.data?._workflowName || "",
      ).trim().toLowerCase();
      if (workflowName !== "task lifecycle") continue;

      const allocatedSlotInfo =
        info?.ctx?.data?._allocatedSlot
        && typeof info.ctx.data._allocatedSlot === "object"
          ? info.ctx.data._allocatedSlot
          : null;
      if (!allocatedSlotInfo || String(allocatedSlotInfo.status || "").trim().toLowerCase() === "released") {
        continue;
      }
      registerSlot(allocatedSlotInfo);
    }

    for (const reservation of this._pruneTaskLifecycleSlotReservations().values()) {
      if (String(reservation?.status || "").trim().toLowerCase() === "released") continue;
      registerSlot(reservation);
    }

    for (const slotInfo of slotEntries.values()) {
      activeTaskIds.push(slotInfo.taskId);
      if (slotInfo.baseBranch) {
        baseBranchSlotCounts[slotInfo.baseBranch] = (baseBranchSlotCounts[slotInfo.baseBranch] || 0) + 1;
      }
    }

    return {
      activeSlotCount: slotEntries.size,
      activeTaskIds,
      baseBranchSlotCounts,
    };
  }

  _listPersistedRunSummaries(workflowId = null, limit = MAX_PERSISTED_RUNS) {
    const normalizedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Math.min(MAX_PERSISTED_RUNS, Math.max(1, Math.floor(Number(limit))))
      : MAX_PERSISTED_RUNS;
    const indexedRuns = this._readRunIndex()
      .map((entry) => this._normalizeRunSummary(entry))
      .filter(Boolean);
    if (indexedRuns.length > 0) {
      const filtered = workflowId
        ? indexedRuns.filter((entry) => entry.workflowId === workflowId)
        : indexedRuns;
      filtered.sort(
        (a, b) =>
          normalizeWorkflowRunTimestampMs(b?.startedAt || b?.updatedAt)
          - normalizeWorkflowRunTimestampMs(a?.startedAt || a?.updatedAt),
      );
      return {
        runs: filtered.slice(0, normalizedLimit),
        total: filtered.length,
      };
    }
    try {
      const page = listWorkflowRunSummariesPageFromStateLedger({
        anchorPath: this.runsDir,
        ...(workflowId ? { workflowId } : {}),
        offset: 0,
        limit: normalizedLimit,
      });
      const runs = Array.isArray(page?.runs)
        ? page.runs.map((entry) => this._normalizeRunSummary(entry)).filter(Boolean)
        : [];
      if (runs.length > 0 || Number(page?.total || 0) > 0) {
        return {
          runs,
          total: Number.isFinite(Number(page?.total)) ? Number(page.total) : runs.length,
        };
      }
    } catch {
      // Best-effort SQL-backed read; fall back to legacy file/index history below.
    }

    const runs = this._hydrateRunIndexFromDetails(normalizedLimit)
      .map((entry) => this._normalizeRunSummary(entry))
      .filter(Boolean);
    return { runs, total: runs.length };
  }

  _listPersistedRunSummariesPage(workflowId = null, options = {}) {
    const rawOffset = Number(options?.offset);
    const rawLimit = Number(options?.limit);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0
      ? Math.max(0, Math.floor(rawOffset))
      : 0;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(MAX_PERSISTED_RUNS, Math.max(1, Math.floor(rawLimit)))
      : 20;
    const indexedRuns = this._readRunIndex()
      .map((entry) => this._normalizeRunSummary(entry))
      .filter(Boolean);
    if (indexedRuns.length > 0) {
      const filtered = workflowId
        ? indexedRuns.filter((entry) => entry.workflowId === workflowId)
        : indexedRuns;
      filtered.sort(
        (a, b) =>
          normalizeWorkflowRunTimestampMs(b?.startedAt || b?.updatedAt)
          - normalizeWorkflowRunTimestampMs(a?.startedAt || a?.updatedAt),
      );
      const runs = filtered.slice(offset, offset + limit);
      const total = filtered.length;
      const nextOffset = offset + runs.length;
      return {
        runs,
        total,
        offset,
        limit,
        count: runs.length,
        hasMore: nextOffset < total,
        nextOffset: nextOffset < total ? nextOffset : null,
      };
    }
    try {
      const page = listWorkflowRunSummariesPageFromStateLedger({
        anchorPath: this.runsDir,
        ...(workflowId ? { workflowId } : {}),
        offset,
        limit,
      });
      const runs = Array.isArray(page?.runs)
        ? page.runs.map((entry) => this._normalizeRunSummary(entry)).filter(Boolean)
        : [];
      if (runs.length > 0 || Number(page?.total || 0) > 0) {
        const total = Number.isFinite(Number(page?.total)) ? Number(page.total) : runs.length;
        const nextOffset = offset + runs.length;
        return {
          runs,
          total,
          offset,
          limit,
          count: runs.length,
          hasMore: nextOffset < total,
          nextOffset: nextOffset < total ? nextOffset : null,
        };
      }
    } catch {
      // Best-effort SQL-backed read; fall back to legacy projection below.
    }

    const persistedResult = this._listPersistedRunSummaries(
      workflowId || null,
      Math.max(offset + limit, 50),
    );
    const runs = persistedResult.runs.slice(offset, offset + limit);
    const total = Number.isFinite(Number(persistedResult.total))
      ? Number(persistedResult.total)
      : persistedResult.runs.length;
    const nextOffset = offset + runs.length;
    return {
      runs,
      total,
      offset,
      limit,
      count: runs.length,
      hasMore: nextOffset < total,
      nextOffset: nextOffset < total ? nextOffset : null,
    };
  }

  /** Get historical run logs */
  getRunHistory(workflowId, limit = null) {
    // TTL cache for run history to reduce repeated hydration cost.
    const cache = RUN_HISTORY_CACHE;
    const key = `${String(this.runsDir || "")}|${String(workflowId ?? 'ALL')}|${String(limit ?? '')}`;
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && (now - cached.ts) <= RUN_HISTORY_CACHE_TTL_MS) {
      return cached.value;
    }
    const normalizedLimit = Number(limit);
    const hasLimit = Number.isFinite(normalizedLimit) && normalizedLimit > 0;
    const resolvedLimit = hasLimit ? Math.floor(normalizedLimit) : null;
    const targetCount = hasLimit
      ? Math.min(MAX_PERSISTED_RUNS, Math.max(resolvedLimit, 200))
      : MAX_PERSISTED_RUNS;
    const persisted = this._listPersistedRunSummaries(workflowId || null, targetCount).runs;

    const active = this.getActiveRuns();
    const activeRunIds = new Set(active.map((run) => run.runId));

    let runs = [...active, ...persisted.filter((run) => !activeRunIds.has(run.runId))];
    if (workflowId) runs = runs.filter((r) => r.workflowId === workflowId);
    const shouldHydrateDetails = !hasLimit || resolvedLimit <= 50 || Boolean(workflowId);
    const shouldDecorateDetails = Boolean(workflowId) || (!hasLimit ? false : resolvedLimit <= 20);
    if (shouldHydrateDetails) {
      runs = runs.map((run) => this.getRunDetail(run.runId, { decorate: shouldDecorateDetails }) || run);
    }
    runs.sort((a, b) => Number(b?.startedAt || 0) - Number(a?.startedAt || 0));
    cache.set(key, {
      ts: now,
      value: hasLimit ? runs.slice(0, resolvedLimit) : runs,
    });
    if (hasLimit) {
      return runs.slice(0, resolvedLimit);
    }
    return runs;
  }

  getRunHistoryPage(workflowId, options = {}) {
    const rawOffset = Number(options?.offset);
    const rawLimit = Number(options?.limit);
    const shouldHydrate = options?.hydrate !== false;
    const offset = Number.isFinite(rawOffset) && rawOffset > 0
      ? Math.max(0, Math.floor(rawOffset))
      : 0;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(MAX_PERSISTED_RUNS, Math.max(1, Math.floor(rawLimit)))
      : 20;
    const active = this.getActiveRuns();
    if (active.length === 0) {
      const persistedPage = this._listPersistedRunSummariesPage(workflowId || null, { offset, limit });
      const runs = Array.isArray(persistedPage?.runs)
        ? persistedPage.runs.map((run) => (
            shouldHydrate
              ? this._hydrateRunHistoryPageSummary(run)
              : (this._normalizeRunSummary(run) || run)
          ))
        : [];
      const total = Number.isFinite(Number(persistedPage?.total))
        ? Number(persistedPage.total)
        : runs.length;
      const nextOffset = offset + runs.length;
      return {
        items: runs,
        runs,
        total,
        offset,
        limit,
        count: runs.length,
        hasMore: persistedPage?.hasMore === true || nextOffset < total,
        nextOffset: persistedPage?.nextOffset ?? (nextOffset < total ? nextOffset : null),
      };
    }
    const persistedResult = this._listPersistedRunSummaries(
      workflowId || null,
      Math.max(offset + limit + active.length, 50),
    );
    const persisted = persistedResult.runs;
    const activeRunIds = new Set(active.map((run) => run.runId));
    const persistedRunIds = new Set(persisted.map((run) => run.runId));
    let allRuns = [...active, ...persisted.filter((run) => !activeRunIds.has(run.runId))];
    if (workflowId) allRuns = allRuns.filter((run) => run.workflowId === workflowId);
    allRuns.sort(
      (a, b) =>
        normalizeWorkflowRunTimestampMs(b?.startedAt || b?.updatedAt)
        - normalizeWorkflowRunTimestampMs(a?.startedAt || a?.updatedAt),
    );
    const activeOnlyCount = active.filter((run) => !persistedRunIds.has(run.runId)).length;
    const total = Math.max(
      allRuns.length,
      Number.isFinite(Number(persistedResult.total))
        ? Number(persistedResult.total) + activeOnlyCount
        : allRuns.length,
    );
    const runs = allRuns
      .slice(offset, offset + limit)
      .map((run) => (
        shouldHydrate
          ? this._hydrateRunHistoryPageSummary(run)
          : (this._normalizeRunSummary(run) || run)
      ));
    const nextOffset = offset + runs.length;
    return {
      items: runs,
      runs,
      total,
      offset,
      limit,
      count: runs.length,
      hasMore: nextOffset < total,
      nextOffset: nextOffset < total ? nextOffset : null,
    };
  }

  _hydrateRunHistoryPageSummary(run) {
    const normalized = this._normalizeRunSummary(run);
    if (!normalized?.runId) return normalized;
    const hasDuration = Number.isFinite(Number(normalized.duration));
    const hasNodeCount = Number.isFinite(Number(normalized.nodeCount));
    const hasTrigger =
      String(normalized.triggerSource || "").trim().length > 0
      || String(normalized.triggerEvent || "").trim().length > 0;
    const hasEndedAt = Number.isFinite(Number(normalized.endedAt));
    const status = String(normalized.status || "").trim().toLowerCase();
    const needsHydration =
      !hasDuration
      || !hasNodeCount
      || !hasTrigger
      || (status && status !== WorkflowStatus.RUNNING && !hasEndedAt);
    if (!needsHydration) return normalized;

    const hydrated = this.getRunDetail(normalized.runId, { decorate: false });
    if (!hydrated) return normalized;
    const {
      detail: _detail,
      ledger: _ledger,
      runGraph: _runGraph,
      plannerTimeline: _plannerTimeline,
      proofBundle: _proofBundle,
      executionTree: _executionTree,
      auditActivity: _auditActivity,
      ...summaryOnly
    } = hydrated;
    return this._normalizeRunSummary(summaryOnly) || normalized;
  }

  _hydrateRunIndexFromDetails(targetCount = MAX_PERSISTED_RUNS) {
    // Invalidate run history cache to avoid stale runs being cached.
    clearRunHistoryCache();
    const normalizedTarget = Number.isFinite(Number(targetCount)) && Number(targetCount) > 0
      ? Math.min(MAX_PERSISTED_RUNS, Math.max(20, Math.floor(Number(targetCount))))
      : MAX_PERSISTED_RUNS;
    const runs = this._readRunIndex();
    if (runs.length >= normalizedTarget) return runs;
    if (!existsSync(this.runsDir)) return runs;

    try {
      const seen = new Set(
        runs
          .map((entry) => String(entry?.runId || "").trim())
          .filter(Boolean),
      );
      const detailFiles = readdirSync(this.runsDir)
        .filter((file) =>
          extname(file) === ".json" &&
          file !== "index.json" &&
          file !== ACTIVE_RUNS_INDEX,
        )
        .map((file) => {
          const detailPath = resolve(this.runsDir, file);
          let mtimeMs = 0;
          try {
            mtimeMs = statSync(detailPath).mtimeMs || 0;
          } catch {
            mtimeMs = 0;
          }
          return { file, detailPath, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      let didHydrate = false;
      for (const detailFile of detailFiles) {
        if (runs.length >= normalizedTarget) break;
        const runId = basename(detailFile.file, ".json");
        if (!runId || seen.has(runId)) continue;
        try {
          const detail = JSON.parse(readFileSync(detailFile.detailPath, "utf8"));
          const summary = this._buildSummaryFromDetail({
            runId,
            workflowId: detail?.data?._workflowId || null,
            workflowName: detail?.data?._workflowName || null,
            status: detail?.status || WorkflowStatus.COMPLETED,
            detail,
          });
          if (!summary) continue;
          runs.push(summary);
          seen.add(runId);
          didHydrate = true;
        } catch {
          // ignore malformed legacy run files
        }
      }

      if (!didHydrate) return runs;

      runs.sort((a, b) => Number(a?.startedAt || 0) - Number(b?.startedAt || 0));
      if (runs.length > MAX_PERSISTED_RUNS) {
        runs.splice(0, runs.length - MAX_PERSISTED_RUNS);
      }
      this._writeRunIndex(runs);
      return runs;
    } catch {
      return runs;
    }
  }

  _getPersistedRunSummaryFromLedger(runId) {
    try {
      const persisted = getWorkflowRunFromStateLedger(runId, { anchorPath: this.runsDir });
      if (!persisted) return null;
      if (persisted.workflowId && persisted.workflowName && persisted.status) {
        return this._normalizeRunSummary(persisted);
      }
      const detail = getWorkflowRunDetailFromStateLedger(runId, { anchorPath: this.runsDir });
      const terminalRaw = String(detail?.data?._workflowTerminalStatus || "")
        .trim()
        .toLowerCase();
      const status = terminalRaw === WorkflowStatus.FAILED || terminalRaw === "error"
        ? WorkflowStatus.FAILED
        : (terminalRaw === WorkflowStatus.CANCELLED
            ? WorkflowStatus.CANCELLED
            : (Array.isArray(detail?.errors) && detail.errors.length > 0
                ? WorkflowStatus.FAILED
                : (persisted.status || WorkflowStatus.COMPLETED)));
      return this._normalizeRunSummary({
        ...persisted,
        workflowId: persisted.workflowId || detail?.data?._workflowId || null,
        workflowName: persisted.workflowName || detail?.data?._workflowName || null,
        status,
      });
    } catch {
      return null;
    }
  }

  /**
   * Request cancellation for a running workflow run.
   * Cancellation is cooperative: currently running nodes are allowed to finish,
   * then the DAG exits with status "cancelled" before scheduling new work.
   */
  cancelRun(runId, opts = {}) {
    const normalizedRunId = basename(String(runId || "")).replace(/\.json$/i, "");
    if (!normalizedRunId) {
      return { ok: false, error: "runId is required" };
    }

    const active = this._activeRuns.get(normalizedRunId);
    if (!active) {
      const existing = this.getRunDetail(normalizedRunId);
      if (!existing) {
        return { ok: false, error: "Workflow run not found", runId: normalizedRunId };
      }
      return {
        ok: false,
        error: `Workflow run is not active (status=${existing.status || "unknown"})`,
        runId: normalizedRunId,
        status: existing.status || "unknown",
      };
    }

    if (active.cancelRequested) {
      return {
        ok: true,
        alreadyRequested: true,
        runId: normalizedRunId,
        status: active.status || WorkflowStatus.RUNNING,
        cancelRequestedAt: active.cancelRequestedAt || Date.now(),
      };
    }

    const reason = String(opts?.reason || "Run cancelled by user").trim() || "Run cancelled by user";
    active.cancelRequested = true;
    active.cancelRequestedAt = Date.now();
    active.cancelReason = reason;
    if (active.ctx?.data && typeof active.ctx.data === "object") {
      active.ctx.data._workflowCancelRequested = true;
      active.ctx.data._workflowCancelReason = reason;
      active.ctx.data._workflowCancelRequestedAt = active.cancelRequestedAt;
    }
    this.emit("run:cancel:requested", {
      runId: normalizedRunId,
      workflowId: active.workflowId || null,
      workflowName: active.workflowName || null,
      reason,
      requestedAt: active.cancelRequestedAt,
    });
    this._recordLedgerEvent({
      eventType: "run.cancel.requested",
      runId: normalizedRunId,
      workflowId: active.workflowId || null,
      workflowName: active.workflowName || null,
      rootRunId: active.ctx?.data?._workflowRootRunId || normalizedRunId,
      parentRunId: active.ctx?.data?._workflowParentRunId || null,
      retryOf: active.ctx?.data?._retryOf || null,
      status: active.status || WorkflowStatus.RUNNING,
      reason,
    });
    if (active.ctx) this._checkpointRun(active.ctx);

    return {
      ok: true,
      runId: normalizedRunId,
      status: active.status || WorkflowStatus.RUNNING,
      cancelRequested: true,
      cancelRequestedAt: active.cancelRequestedAt,
      reason,
    };
  }

  _collectOutputArtifactEntries(nodeId, nodeLabel, output) {
    const entries = [];
    if (!output || typeof output !== "object") return entries;

    const pushEntry = (entry = {}) => {
      const path = normalizeDagText(entry?.path || entry?.artifactPath || entry?.reviewPath || entry?.evidenceDir || "", 320);
      const summary = normalizeDagText(entry?.summary || entry?.label || entry?.name || path || "", 220);
      if (!path && !summary) return;
      entries.push(cleanObject({
        source: "node-output",
        nodeId,
        nodeLabel: nodeLabel || null,
        kind: entry?.kind || (path ? "artifact" : "evidence"),
        label: normalizeDagText(entry?.label || entry?.name || "", 180) || null,
        path: path || null,
        retrieveCommand: entry?.retrieveCommand || null,
        summary: summary || null,
      }));
    };

    for (const artifact of Array.isArray(output.artifactPointers) ? output.artifactPointers : []) {
      pushEntry(artifact);
    }
    for (const artifact of Array.isArray(output.artifacts) ? output.artifacts : []) {
      pushEntry(artifact);
    }
    for (const path of Array.isArray(output.artifactPaths) ? output.artifactPaths : []) {
      pushEntry({ path, kind: "artifact" });
    }
    for (const path of [
      output.reviewPath,
      output.evidenceDir,
      output.artifactRoot,
      output.path,
    ]) {
      pushEntry({ path, kind: "artifact" });
    }

    return entries;
  }

  _buildPlannerTimeline(run = {}, detail = null, runGraph = null) {
    const requestedRunId = String(run?.runId || "").trim();
    const sourceTimeline = Array.isArray(runGraph?.timeline)
      ? runGraph.timeline
      : (Array.isArray(run?.ledger?.events) ? run.ledger.events : []);
    const timeline = sourceTimeline
      .filter((event) => {
        if (!String(event?.eventType || "").startsWith("planner.")) return false;
        const eventRunId = String(event?.runId || "").trim();
        return !requestedRunId || !eventRunId || eventRunId === requestedRunId;
      })
      .map((event) => {
        const eventType = String(event?.eventType || "").trim();
        const normalizedEventType =
          event?.meta?.normalizedEventType
          || (eventType === "planner.plan_reasoning"
            ? "plan_reasoning"
            : (eventType === "planner.plan_initialized" || eventType === "planner.plan_completed" || eventType === "planner.plan_failed")
              ? "plan"
              : (eventType === "planner.step_started")
                ? "current_plan_step"
                : (eventType === "planner.step_completed" || eventType === "planner.step_blocked" || eventType === "planner.post_attachment")
                  ? "step_result"
                  : null);
        return cleanObject({
        id: event?.id || null,
        seq: Number.isFinite(Number(event?.seq)) ? Number(event.seq) : null,
        timestamp: event?.timestamp || null,
        eventType: eventType || null,
        normalizedEventType,
        runId: event?.runId || run?.runId || null,
        nodeId: event?.nodeId || null,
        nodeLabel: event?.nodeLabel || null,
        status: event?.status || null,
        summary: normalizeDagText(event?.summary || event?.reason || event?.error || "", 240) || null,
        reason: normalizeDagText(event?.reason || "", 180) || null,
        error: normalizeDagText(event?.error || "", 220) || null,
        stepKey: event?.meta?.stepKey || event?.executionKey || event?.executionId || null,
        stepLabel: event?.meta?.stepLabel || event?.executionLabel || event?.nodeLabel || event?.nodeId || null,
        attachmentKind: event?.meta?.attachmentKind || null,
        taskCount: Number.isFinite(Number(event?.meta?.taskCount)) ? Number(event.meta.taskCount) : null,
        parsedCount: Number.isFinite(Number(event?.meta?.parsedCount)) ? Number(event.meta.parsedCount) : null,
        createdCount: Number.isFinite(Number(event?.meta?.createdCount)) ? Number(event.meta.createdCount) : null,
        skippedCount: Number.isFinite(Number(event?.meta?.skippedCount)) ? Number(event.meta.skippedCount) : null,
        itemCount: Number.isFinite(Number(event?.meta?.itemCount)) ? Number(event.meta.itemCount) : null,
        threadId: event?.meta?.threadId || null,
        plan: event?.meta?.plan || (normalizedEventType === "plan"
          ? {
              phase: event?.executionKind || null,
              stepLabel: event?.meta?.stepLabel || event?.executionLabel || event?.nodeLabel || event?.nodeId || null,
              status: event?.status || null,
              summary: normalizeDagText(event?.summary || "", 240) || null,
              reason: normalizeDagText(event?.reason || "", 180) || null,
            }
          : null),
        currentPlanStep: event?.meta?.currentPlanStep || (normalizedEventType === "current_plan_step"
          ? {
              phase: event?.executionKind || null,
              stepLabel: event?.meta?.stepLabel || event?.executionLabel || event?.nodeLabel || event?.nodeId || null,
              status: event?.status || null,
            }
          : null),
        stepResult: event?.meta?.stepResult || (normalizedEventType === "step_result"
          ? {
              phase: event?.executionKind || null,
              stepLabel: event?.meta?.stepLabel || event?.executionLabel || event?.nodeLabel || event?.nodeId || null,
              status: event?.status || null,
              summary: normalizeDagText(event?.summary || "", 240) || null,
              reason: normalizeDagText(event?.reason || "", 180) || null,
              attachmentKind: event?.meta?.attachmentKind || null,
            }
          : null),
      });
      })
      .sort((left, right) => {
        const delta = new Date(left?.timestamp || 0).getTime() - new Date(right?.timestamp || 0).getTime();
        if (delta !== 0) return delta;
        return Number(left?.seq || 0) - Number(right?.seq || 0);
      });
    const deduped = [];
    const seen = new Set();
    for (const entry of timeline) {
      const key = JSON.stringify([
        entry?.runId || "",
        entry?.eventType || "",
        entry?.nodeId || "",
        entry?.stepKey || "",
        entry?.attachmentKind || "",
        entry?.summary || "",
        entry?.reason || "",
        entry?.error || "",
        entry?.taskCount ?? "",
        entry?.parsedCount ?? "",
        entry?.createdCount ?? "",
        entry?.skippedCount ?? "",
        entry?.itemCount ?? "",
      ]);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(entry);
    }
    return deduped;
  }

  _buildRunProofBundle(run = {}, detail = null, runGraph = null, plannerTimeline = []) {
    const dagNodes = detail?.dagState?.nodes && typeof detail.dagState.nodes === "object"
      ? Object.values(detail.dagState.nodes)
      : [];
    const ledgerEvents = Array.isArray(run?.ledger?.events) ? run.ledger.events : [];

    const evidence = [];
    for (const node of dagNodes) {
      const nodeId = String(node?.nodeId || "").trim() || null;
      const nodeLabel = String(node?.label || nodeId || "").trim() || null;
      for (const entry of Array.isArray(node?.completionEvidence) ? node.completionEvidence : []) {
        evidence.push(cleanObject({
          source: "completion-evidence",
          nodeId,
          nodeLabel,
          kind: entry?.kind || "evidence",
          label: normalizeDagText(entry?.label || entry?.title || "", 180) || null,
          path: normalizeDagText(entry?.path || "", 320) || null,
          summary: normalizeDagText(entry?.summary || entry?.message || entry?.path || "", 220) || null,
          value: entry?.value ?? null,
          status: node?.status || null,
        }));
      }
      evidence.push(...this._collectOutputArtifactEntries(
        nodeId,
        nodeLabel,
        detail?.nodeOutputs?.[nodeId] || null,
      ));
    }
    const skillbookGuidance =
      detail?.skillbookGuidance && typeof detail.skillbookGuidance === "object"
        ? detail.skillbookGuidance
        : null;
    for (const strategy of Array.isArray(skillbookGuidance?.strategies) ? skillbookGuidance.strategies.slice(0, 8) : []) {
      evidence.push(cleanObject({
        source: "skillbook",
        kind: "reusable_strategy",
        label: normalizeDagText(strategy?.recommendation || strategy?.strategyId || "", 180) || null,
        summary: normalizeDagText(strategy?.rationale || strategy?.workflowId || "", 220) || null,
        status: strategy?.status || null,
        value: strategy?.confidence ?? null,
      }));
    }

    const decisions = [];
    const issueAdvisor = detail?.issueAdvisor && typeof detail.issueAdvisor === "object"
      ? detail.issueAdvisor
      : null;
    if (issueAdvisor) {
      decisions.push(cleanObject({
        source: "issue-advisor",
        decision: issueAdvisor.recommendedAction || null,
        decisionClass: issueAdvisor.retryDecisionClass || null,
        summary: normalizeDagText(issueAdvisor.summary || "", 220) || null,
        guidance: normalizeDagText(issueAdvisor.nextStepGuidance || "", 260) || null,
      }));
    }
    if (run?.retryDecisionReason) {
      decisions.push({
        source: "retry-policy",
        decision: run.retryMode || null,
        decisionClass: "retry",
        summary: normalizeDagText(run.retryDecisionReason, 220),
      });
    }
    const selfImprovementRatchet =
      detail?.selfImprovementRatchet && typeof detail.selfImprovementRatchet === "object"
        ? detail.selfImprovementRatchet
        : null;
    if (selfImprovementRatchet) {
      decisions.push(cleanObject({
        source: "self-improvement-ratchet",
        decision: selfImprovementRatchet.decision || null,
        decisionClass: selfImprovementRatchet.decision || null,
        summary: normalizeDagText(selfImprovementRatchet.summary || "", 220) || null,
        guidance: normalizeDagText(selfImprovementRatchet.rationale || "", 260) || null,
      }));
    }
    if (skillbookGuidance?.guidanceSummary || skillbookGuidance?.summary) {
      decisions.push(cleanObject({
        source: "skillbook",
        decision: "reuse_strategies",
        decisionClass: "guidance",
        summary: normalizeDagText(skillbookGuidance.guidanceSummary || skillbookGuidance.summary || "", 220) || null,
        guidance: normalizeDagText(
          skillbookGuidance.strategies?.[0]?.recommendation || skillbookGuidance.strategies?.[0]?.rationale || "",
          260,
        ) || null,
      }));
    }
    for (const event of plannerTimeline) {
      if (!event?.summary && !event?.reason && !event?.error) continue;
      decisions.push(cleanObject({
        source: "planner",
        decision: event.eventType || null,
        decisionClass: event.status || null,
        summary: event.summary || event.reason || event.error || null,
        nodeId: event.nodeId || null,
        stepKey: event.stepKey || null,
        timestamp: event.timestamp || null,
      }));
    }

    const artifacts = [
      ...evidence.filter((entry) => entry?.path),
      ...ledgerEvents
        .filter((event) =>
          String(event?.eventType || "") === "planner.post_attachment" ||
          String(event?.eventType || "").startsWith("artifact.") ||
          String(event?.eventType || "").startsWith("proof."),
        )
        .map((event) => cleanObject({
          source: "ledger",
          nodeId: event?.nodeId || null,
          nodeLabel: event?.nodeLabel || null,
          kind: event?.meta?.attachmentKind || event?.meta?.kind || "attachment",
          label: normalizeDagText(event?.summary || event?.executionLabel || "", 180) || null,
          path: normalizeDagText(event?.meta?.path || event?.meta?.artifactPath || "", 320) || null,
          summary: normalizeDagText(event?.summary || event?.reason || "", 220) || null,
          retrieveCommand: event?.meta?.retrieveCommand || null,
          timestamp: event?.timestamp || null,
          created: Array.isArray(event?.meta?.created) ? event.meta.created : undefined,
          skipped: Array.isArray(event?.meta?.skipped) ? event.meta.skipped : undefined,
        })),
    ];

    const dedupe = (items, keyFn, limit = 80) => {
      const out = [];
      const seen = new Set();
      for (const item of items) {
        if (!item) continue;
        const key = keyFn(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(item);
        if (out.length >= limit) break;
      }
      return out;
    };

    const normalizedEvidence = dedupe(
      evidence,
      (entry) => JSON.stringify([
        entry?.source || "",
        entry?.nodeId || "",
        entry?.kind || "",
        entry?.path || "",
        entry?.summary || "",
      ]),
    );
    const normalizedArtifacts = dedupe(
      artifacts,
      (entry) => JSON.stringify([
        entry?.source || "",
        entry?.nodeId || "",
        entry?.kind || "",
        entry?.path || "",
        entry?.label || "",
        entry?.summary || "",
      ]),
    );
    const normalizedDecisions = dedupe(
      decisions,
      (entry) => JSON.stringify([
        entry?.source || "",
        entry?.decision || "",
        entry?.decisionClass || "",
        entry?.summary || "",
        entry?.nodeId || "",
        entry?.timestamp || "",
      ]),
      40,
    );

    return {
      summary: {
        plannerEventCount: plannerTimeline.length,
        decisionCount: normalizedDecisions.length,
        evidenceCount: normalizedEvidence.length,
        artifactCount: normalizedArtifacts.length,
      },
      plannerTimeline,
      decisions: normalizedDecisions,
      evidence: normalizedEvidence,
      artifacts: normalizedArtifacts,
    };
  }

  _buildExecutionTree(runGraph, startRunId) {
    if (!runGraph || !Array.isArray(runGraph.runs) || runGraph.runs.length === 0) return null;
    const runMap = new Map(runGraph.runs.map((entry) => [entry.runId, { ...entry, children: [] }]));
    for (const edge of Array.isArray(runGraph.edges) ? runGraph.edges : []) {
      if (edge?.type !== "parent-child") continue;
      const parent = runMap.get(edge.parentRunId);
      const child = runMap.get(edge.childRunId);
      if (parent && child) parent.children.push(child);
    }
    const requestedRunId = String(startRunId || runGraph.requestedRunId || runGraph.rootRunId || "").trim();
    return runMap.get(requestedRunId) || runMap.get(runGraph.rootRunId) || null;
  }

  _extractDelegationTrail(detail, run = null) {
    return extractDelegationTrail(detail, run);
  }

  _decorateRunDetail(run) {
    if (!run?.runId) return run;
    const runGraph = this.getRunGraph(run.runId);
    const delegationTrail = this._extractDelegationTrail(run?.detail, run);
    const delegationTransitionGuards = extractDelegationGuardMap(run?.detail, run);
    const workflowTeamState = hasWorkflowTeamStateData(
      run?.detail?.workflowTeamState ??
      run?.detail?.data?._workflowTeamState ??
      run?.detail?.data?.workflowTeamState,
    )
      ? cloneWorkflowTeamState(
          run?.detail?.workflowTeamState ??
          run?.detail?.data?._workflowTeamState ??
          run?.detail?.data?.workflowTeamState,
        )
      : null;
    const teamSummary = workflowTeamState
      ? buildWorkflowTeamSummary(workflowTeamState)
      : (run?.teamSummary || null);
    const detail =
      run?.detail && typeof run.detail === "object"
        ? {
            ...run.detail,
            data:
              run.detail.data && typeof run.detail.data === "object"
                ? { ...run.detail.data }
                : run.detail.data,
          }
        : run?.detail;
    hydrateDelegationReadModel(detail, {
      run,
      trail: delegationTrail,
      guards: delegationTransitionGuards,
    });
    if (workflowTeamState && detail && typeof detail === "object") {
      if (!detail.data || typeof detail.data !== "object") {
        detail.data = {};
      }
      if (!detail.data._workflowTeamState || typeof detail.data._workflowTeamState !== "object") {
        detail.data._workflowTeamState = cloneWorkflowTeamState(workflowTeamState);
      }
      if (!detail.data.workflowTeamState || typeof detail.data.workflowTeamState !== "object") {
        detail.data.workflowTeamState = cloneWorkflowTeamState(workflowTeamState);
      }
      if (!detail.data._workflowTeamSummary || typeof detail.data._workflowTeamSummary !== "object") {
        detail.data._workflowTeamSummary = teamSummary;
      }
      if (!detail.workflowTeamState || typeof detail.workflowTeamState !== "object") {
        detail.workflowTeamState = cloneWorkflowTeamState(workflowTeamState);
      }
      if (!detail.teamSummary || typeof detail.teamSummary !== "object") {
        detail.teamSummary = teamSummary;
      }
    }
    const plannerTimeline = this._buildPlannerTimeline(run, detail, runGraph);
    const proofBundle = this._buildRunProofBundle(run, detail, runGraph, plannerTimeline);
    const delegationTopology = buildRunDelegationTopology({
      runId: run.runId,
      detail,
      runGraph,
    });
    if (delegationTopology && detail && typeof detail === "object") {
      if (!detail.data || typeof detail.data !== "object") {
        detail.data = {};
      }
      if (!detail.data._delegationTopology || typeof detail.data._delegationTopology !== "object") {
        detail.data._delegationTopology = delegationTopology;
      }
      if (!detail.delegationTopology || typeof detail.delegationTopology !== "object") {
        detail.delegationTopology = delegationTopology;
      }
    }
    return {
      ...run,
      detail,
      runGraph,
      plannerTimeline,
      proofBundle,
      executionTree: this._buildExecutionTree(runGraph, run.runId),
      delegationTopology,
      delegationTrail,
      delegationAuditTrail: delegationTrail,
      latestDelegationEvent: delegationTrail.at(-1) || null,
      delegationTransitionGuards,
      workflowTeamState,
      teamSummary,
      teamId: teamSummary?.teamId || run?.teamId || null,
      teamLeadId: teamSummary?.leadId || run?.teamLeadId || null,
    };
  }

  /** Get full run detail for a specific runId */
  getRunDetail(runId, options = {}) {
    const normalizedRunId = basename(String(runId || "")).replace(/\.json$/i, "");
    if (!normalizedRunId) return null;
    const ledger = this.getRunLedger(normalizedRunId);
    const decorate = options?.decorate !== false;

    const activeRun = this._activeRuns.get(normalizedRunId);
    if (activeRun?.ctx) {
      const summary = this._buildActiveRunSummary(normalizedRunId, activeRun);
      if (!summary) return null;
      const hydrated = {
        ...summary,
        detail: this._serializeRunContext(activeRun.ctx, true),
        ledger,
      };
      return decorate ? this._decorateRunDetail(hydrated) : hydrated;
    }

    const sqlDetail = getWorkflowRunDetailFromStateLedger(normalizedRunId, { anchorPath: this.runsDir });
    if (sqlDetail && typeof sqlDetail === "object") {
      const detail = repairWorkflowRunDetail(sqlDetail);
      const summary = this._normalizeRunSummary(
        this._getPersistedRunSummaryFromLedger(normalizedRunId)
          || this._readRunIndex().find((entry) => entry?.runId === normalizedRunId)
          || null,
      );
      if (summary) {
        const recomputed = this._buildSummaryFromDetail({
          runId: normalizedRunId,
          workflowId: summary.workflowId,
          workflowName: summary.workflowName,
          status: summary.status || WorkflowStatus.COMPLETED,
          detail,
        });
        const hydrated = { ...summary, ...recomputed, detail, ledger };
        return decorate ? this._decorateRunDetail(hydrated) : hydrated;
      }
      const terminalRaw = String(detail?.data?._workflowTerminalStatus || "")
        .trim()
        .toLowerCase();
      const status = terminalRaw === WorkflowStatus.FAILED || terminalRaw === "error"
        ? WorkflowStatus.FAILED
        : (terminalRaw === WorkflowStatus.CANCELLED
            ? WorkflowStatus.CANCELLED
            : (Array.isArray(detail?.errors) && detail.errors.length > 0
                ? WorkflowStatus.FAILED
                : WorkflowStatus.COMPLETED));
      const computed = this._buildSummaryFromDetail({
        runId: normalizedRunId,
        workflowId: detail?.data?._workflowId || null,
        workflowName: detail?.data?._workflowName || null,
        status,
        detail,
      });
      const hydrated = { ...computed, detail, ledger };
      return decorate ? this._decorateRunDetail(hydrated) : hydrated;
    }

    const detailPath = resolve(this.runsDir, `${normalizedRunId}.json`);
    if (!existsSync(detailPath)) return null;

    try {
      const detail = repairWorkflowRunDetail(JSON.parse(readFileSync(detailPath, "utf8")));
      const summary = this._normalizeRunSummary(
        this._getPersistedRunSummaryFromLedger(normalizedRunId)
          || this._readRunIndex().find((entry) => entry?.runId === normalizedRunId)
          || null,
      );
      if (summary) {
        const recomputed = this._buildSummaryFromDetail({
          runId: normalizedRunId,
          workflowId: summary.workflowId,
          workflowName: summary.workflowName,
          status: summary.status || WorkflowStatus.COMPLETED,
          detail,
        });
        const hydrated = { ...summary, ...recomputed, detail, ledger };
        return decorate ? this._decorateRunDetail(hydrated) : hydrated;
      }
      const terminalRaw = String(detail?.data?._workflowTerminalStatus || "")
        .trim()
        .toLowerCase();
      const status = terminalRaw === WorkflowStatus.FAILED || terminalRaw === "error"
        ? WorkflowStatus.FAILED
        : (terminalRaw === WorkflowStatus.CANCELLED
            ? WorkflowStatus.CANCELLED
            : (Array.isArray(detail?.errors) && detail.errors.length > 0
                ? WorkflowStatus.FAILED
                : WorkflowStatus.COMPLETED));
      const computed = this._buildSummaryFromDetail({
        runId: normalizedRunId,
        workflowId: detail?.data?._workflowId || null,
        workflowName: detail?.data?._workflowName || null,
        status,
        detail,
      });
      const hydrated = { ...computed, detail, ledger };
      return decorate ? this._decorateRunDetail(hydrated) : hydrated;
    } catch {
      return null;
    }
  }

  getRunLedger(runId) {
    const normalizedRunId = basename(String(runId || "")).replace(/\.json$/i, "");
    if (!normalizedRunId) return null;
    return this._executionLedger.getRunLedger(normalizedRunId);
  }

  getRunGraph(runId) {
    const normalizedRunId = basename(String(runId || "")).replace(/\.json$/i, "");
    if (!normalizedRunId) return null;
    return this._executionLedger.buildRunGraph(normalizedRunId);
  }

  diffRunGraphs(baseRunId, comparisonRunId) {
    const normalizedBaseRunId = basename(String(baseRunId || "")).replace(/\.json$/i, "");
    const normalizedComparisonRunId = basename(String(comparisonRunId || "")).replace(/\.json$/i, "");
    if (!normalizedBaseRunId || !normalizedComparisonRunId) return null;
    return this._executionLedger.diffRunGraphs(normalizedBaseRunId, normalizedComparisonRunId);
  }

  getRetryOptions(runId) {
    const run = this.getRunDetail(runId);
    if (!run) return null;
    const workflowId = run.workflowId || run.detail?.data?._workflowId || null;
    const def = workflowId ? this.get(workflowId) : null;
    const createTasksGuard = this._resolvePendingCreateTasksGuard(run, def);
    const issueAdvisor =
      run?.detail?.issueAdvisor && typeof run.detail.issueAdvisor === "object"
        ? run.detail.issueAdvisor
        : null;
    const nodeStatuses =
      run?.detail?.nodeStatuses && typeof run.detail.nodeStatuses === "object"
        ? run.detail.nodeStatuses
        : {};
    const failedNodesFromAdvisor = Array.isArray(issueAdvisor?.failedNodes)
      ? issueAdvisor.failedNodes
          .map((entry) => String(entry?.nodeId || "").trim())
          .filter(Boolean)
      : [];
    const failedNodesFromStatuses = Object.entries(nodeStatuses)
      .filter(([, status]) => String(status || "").trim().toLowerCase() === NodeStatus.FAILED)
      .map(([nodeId]) => String(nodeId || "").trim())
      .filter(Boolean);
    const failedNodes = Array.from(new Set([
      ...failedNodesFromAdvisor,
      ...failedNodesFromStatuses,
    ]));
    const retryDecision = this._chooseRetryModeForRun(run, {
      fallbackMode: "from_failed",
    });
    const canResumeFromFailed = retryDecision.completedCount > 0 || failedNodes.length > 0;
    const isPausedResume = String(run?.status || "").trim().toLowerCase() === WorkflowStatus.PAUSED;
    const guardForcesResumeOnly = Boolean(createTasksGuard?.safeResume);
    const guardForcesRestart = Boolean(createTasksGuard) && !guardForcesResumeOnly;
    const effectiveRecommendedMode = guardForcesResumeOnly
      ? "from_failed"
      : (guardForcesRestart ? "from_scratch" : retryDecision.mode);
    const effectiveRecommendedReason = guardForcesResumeOnly
      ? "create_tasks_pending.resume_only"
      : (guardForcesRestart ? "create_tasks_pending.requires_restart" : retryDecision.reason);
    const fromFailedLabel = isPausedResume
      ? "Resume from next pending step"
      : "Retry from last failed step";
    const fromFailedDescription = createTasksGuard
      ? (
        createTasksGuard.safeResume
          ? `Resume at ${createTasksGuard.nextNodeLabel}. Manual retry is blocked because task creation may already be partially applied; interrupted-run resume remains safe because existing tasks can be listed and skipped.`
          : `Blocked: ${createTasksGuard.nextNodeLabel} is the next pending node and task creation may already be partially applied. Safe interrupted-run resume requires dedup=true and kanban.listTasks support.`
      )
      : (
        canResumeFromFailed
          ? "Reuse already completed node outputs and resume remaining workflow work."
          : "Resume state is limited; this may behave similarly to a fresh rerun."
      );
    const fromScratchDescription = createTasksGuard
      ? (
        createTasksGuard.safeResume
          ? `Blocked: ${createTasksGuard.nextNodeLabel} is the next pending node and task creation may already be partially applied. Manual restart is blocked; use interrupted-run resume instead.`
          : `Re-run the workflow from the beginning with the original input data. Verify whether ${createTasksGuard.nextNodeLabel} already created tasks before using this path.`
      )
      : "Re-run the workflow from the beginning with the original input data.";
    const replanFromFailedDescription = createTasksGuard
      ? `Blocked: ${createTasksGuard.nextNodeLabel} is the next pending node, so replanning from the failed boundary is treated as a manual retry and may duplicate task creation. ${createTasksGuard.safeResume ? createTasksGuard.resumeAllowedMessage : createTasksGuard.resumeBlockedMessage}`
      : "Preserve completed node outputs and rerun the planner or replanner path from the failed boundary.";
    const replanSubgraphDescription = createTasksGuard
      ? `Blocked: ${createTasksGuard.nextNodeLabel} is the next pending node, so replanning the impacted subgraph is treated as a manual retry and may duplicate task creation. ${createTasksGuard.safeResume ? createTasksGuard.resumeAllowedMessage : createTasksGuard.resumeBlockedMessage}`
      : "Preserve completed work and rerun planner-aware downstream steps for the impacted subgraph.";
    const summary = [retryDecision.issueAdvisorSummary, createTasksGuard?.summary].filter(Boolean).join(" ");

    return {
      runId: run.runId,
      status: run.status,
      recommendedMode: effectiveRecommendedMode,
      recommendedReason: effectiveRecommendedReason,
      recommendedAction: retryDecision.issueAdvisorRecommendation,
      summary,
      failedNodes,
      guardedState: createTasksGuard
        ? {
            code: createTasksGuard.code,
            nextNodeId: createTasksGuard.nextNodeId,
            nextNodeLabel: createTasksGuard.nextNodeLabel,
            nextNodeType: createTasksGuard.nextNodeType,
            safeResume: createTasksGuard.safeResume,
            blockers: [...createTasksGuard.blockers],
            summary: createTasksGuard.summary,
          }
        : null,
      options: [
        {
          mode: "from_failed",
          label: fromFailedLabel,
          description: fromFailedDescription,
          recommended: effectiveRecommendedMode === "from_failed",
          reason: effectiveRecommendedMode === "from_failed" ? effectiveRecommendedReason : null,
          available: canResumeFromFailed && (!createTasksGuard || createTasksGuard.safeResume),
          failedNodes,
        },
        {
          mode: "replan_from_failed",
          label: "Replan from failed boundary",
          description: replanFromFailedDescription,
          recommended: effectiveRecommendedMode === "replan_from_failed",
          reason: effectiveRecommendedMode === "replan_from_failed" ? effectiveRecommendedReason : null,
          available: canResumeFromFailed && !createTasksGuard,
          failedNodes,
        },
        {
          mode: "replan_subgraph",
          label: "Replan impacted subgraph",
          description: replanSubgraphDescription,
          recommended: effectiveRecommendedMode === "replan_subgraph",
          reason: effectiveRecommendedMode === "replan_subgraph" ? effectiveRecommendedReason : null,
          available: canResumeFromFailed && !createTasksGuard,
          failedNodes,
        },
        {
          mode: "from_scratch",
          label: "Retry from scratch",
          description: fromScratchDescription,
          recommended: effectiveRecommendedMode === "from_scratch",
          reason: effectiveRecommendedMode === "from_scratch" ? effectiveRecommendedReason : null,
          available: !guardForcesResumeOnly,
          failedNodes,
        },
      ],
    };
  }


  /**
   * Get task-linked workflow trace events for a run.
   * Returns [] when run is unknown or has no task trace data.
   *
   * @param {string} runId
   * @returns {Array<object>}
   */
  getTaskTraceEvents(runId) {
    const detail = this.getRunDetail(runId, { decorate: false })?.detail;
    const events = Array.isArray(detail?.data?._taskWorkflowEvents)
      ? detail.data._taskWorkflowEvents
      : [];
    return events.map((event) => sanitizeJsonValue(event) || {});
  }

  _ensureForensicsRunSurfaces(run) {
    if (!run || typeof run !== "object") return run;
    if (Array.isArray(run.plannerTimeline) && run.proofBundle && typeof run.proofBundle === "object") {
      return run;
    }
    return this._decorateRunDetail(run);
  }

  /**
   * Get detailed forensics for a single node in a run.
   * @param {string} runId
   * @param {string} nodeId
   * @returns {object|null}
   */
  getNodeForensics(runId, nodeId, preloadedRun = null) {
    const run = this._ensureForensicsRunSurfaces(
      preloadedRun || this.getRunDetail(runId, { decorate: false }),
    );
    if (!run) return null;
    const detail = run.detail || {};
    const nodeStatuses = detail.nodeStatuses || {};
    if (!(nodeId in nodeStatuses)) return null;

    const timings = detail.nodeTimings?.[nodeId] || {};
    const startedAt = timings.startedAt || null;
    const endedAt = timings.endedAt || null;
    const durationMs = startedAt && endedAt ? Math.max(0, endedAt - startedAt) : null;

    return {
      nodeId,
      status: nodeStatuses[nodeId] || null,
      startedAt,
      endedAt,
      durationMs,
      input: detail.nodeInputs?.[nodeId] || null,
      output: detail.nodeOutputs?.[nodeId] || null,
      errors: (detail.errors || []).filter((e) => e.nodeId === nodeId),
      retryAttempts: detail.retryAttempts?.[nodeId] || 0,
      statusEvents: (detail.nodeStatusEvents || []).filter((e) => e.nodeId === nodeId),
      issueFindings: Array.isArray(detail?.dagState?.nodes?.[nodeId]?.issueFindings)
        ? detail.dagState.nodes[nodeId].issueFindings
        : [],
      completionEvidence: Array.isArray(detail?.dagState?.nodes?.[nodeId]?.completionEvidence)
        ? detail.dagState.nodes[nodeId].completionEvidence
        : [],
      plannerTimeline: Array.isArray(run?.plannerTimeline)
        ? run.plannerTimeline.filter((entry) => String(entry?.nodeId || "").trim() === nodeId)
        : [],
      proofArtifacts: Array.isArray(run?.proofBundle?.artifacts)
        ? run.proofBundle.artifacts.filter((entry) => String(entry?.nodeId || "").trim() === nodeId)
        : [],
    };
  }

  /**
   * Get forensics for all nodes in a run.
   * @param {string} runId
   * @returns {object|null}
   */
  getRunForensics(runId) {
    const run = this._ensureForensicsRunSurfaces(
      this.getRunDetail(runId, { decorate: false }),
    );
    if (!run) return null;
    const detail = run.detail || {};
    const nodeStatuses = detail.nodeStatuses || {};
    const nodes = {};
    for (const nodeId of Object.keys(nodeStatuses)) {
      nodes[nodeId] = this.getNodeForensics(runId, nodeId, run);
    }
    return {
      runId,
      status: run.status || null,
      startedAt: detail.startedAt || null,
      endedAt: detail.endedAt || null,
      durationMs: detail.duration || null,
      plannerTimeline: run?.plannerTimeline || [],
      proofBundle: run?.proofBundle || null,
      runGraph: run?.runGraph || null,
      nodes,
    };
  }

  /**
   * Create a snapshot of a completed run for later restore.
   * @param {string} runId
   * @returns {{ snapshotId: string, path: string }|null}
   */
  createRunSnapshot(runId) {
    const run = this.getRunDetail(runId, { decorate: false });
    if (!run) return null;
    const detail = run.detail || {};
    const workflowId = run.workflowId || detail.data?._workflowId;
    const snapshotsDir = resolve(this.runsDir, "snapshots");
    const trajectoriesDir = resolve(this.runsDir, WORKFLOW_TRAJECTORIES_DIR);
    mkdirSync(snapshotsDir, { recursive: true });
    mkdirSync(trajectoriesDir, { recursive: true });
    const snapshotId = runId;
    const snapshotPath = resolve(snapshotsDir, `${snapshotId}.json`);
    const trajectoryPath = resolve(trajectoriesDir, `${snapshotId}.json`);
    const replayTrajectory =
      detail.replayTrajectory && typeof detail.replayTrajectory === "object"
        ? detail.replayTrajectory
        : { runId, restoredFrom: detail?.data?._restoredFrom || null, steps: [] };
    const snapshot = {
      snapshotId,
      runId,
      workflowId,
      createdAt: Date.now(),
      nodeStatuses: detail.nodeStatuses || {},
      nodeOutputs: detail.nodeOutputs || {},
      nodeTimings: detail.nodeTimings || {},
      nodeInputs: detail.nodeInputs || {},
      retryAttempts: detail.retryAttempts || {},
      variables: detail.data || {},
      errors: detail.errors || [],
      replayTrajectory,
      stepSummaries: detail.stepSummaries || [],
    };
    try {
      writeWorkflowSnapshotToStateLedger(snapshot, { anchorPath: this.runsDir });
    } catch (err) {
      console.warn(`${TAG} workflow snapshot sync failed: ${String(err?.message || err)}`);
    }
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
    writeFileSync(trajectoryPath, JSON.stringify(replayTrajectory, null, 2), "utf8");
    return { snapshotId, path: snapshotPath, trajectoryPath };
  }

  /**
   * Restore a run from a snapshot — creates a new execution pre-seeded
   * with completed node state from the snapshot.
   * @param {string} snapshotId
   * @param {object} [opts]
   * @param {object} [opts.variables] - Override variables
   * @returns {Promise<object>}
   */
  async restoreFromSnapshot(snapshotId, opts = {}) {
    const snapshotPath = resolve(this.runsDir, "snapshots", `${snapshotId}.json`);
    let snapshot = null;
    try {
      snapshot = getWorkflowSnapshotFromStateLedger(snapshotId, { anchorPath: this.runsDir });
    } catch (err) {
      console.warn(`${TAG} workflow snapshot lookup failed: ${String(err?.message || err)}`);
    }
    if (!snapshot && existsSync(snapshotPath)) {
      snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    }
    if (!snapshot) {
      throw new Error(`Snapshot "${snapshotId}" not found`);
    }
    const workflowId = snapshot.workflowId;
    const def = this.get(workflowId);
    if (!def) {
      throw new Error(`Workflow "${workflowId}" no longer exists — cannot restore`);
    }

    const inputData = {
      ...def.variables,
      ...(snapshot.variables || {}),
      ...(opts.variables || {}),
      _workflowId: workflowId,
      _workflowName: def.name,
      _restoredFrom: snapshotId,
    };

    // Remove internal keys that should be regenerated
    delete inputData._workflowId;
    delete inputData._workflowName;

    const ctx = new WorkflowContext(inputData);
    ctx.data._workflowId = workflowId;
    ctx.data._workflowName = def.name;
    ctx.data._restoredFrom = snapshotId;
    ctx.data._replayTrajectory = {
      runId: ctx.id,
      restoredFrom: snapshotId,
      steps: Array.isArray(snapshot.replayTrajectory?.steps)
        ? snapshot.replayTrajectory.steps.map((step) => ({ ...step }))
        : [],
    };
    ctx.variables = { ...def.variables, ...(opts.variables || {}) };

    // Pre-seed completed nodes from snapshot
    const nodeStatuses = snapshot.nodeStatuses || {};
    const nodeOutputs = snapshot.nodeOutputs || {};
    const preservedCompletedNodeIds = [];
    const focusNodeIds = [];
    for (const [nodeId, status] of Object.entries(nodeStatuses)) {
      if (status === "completed") {
        preservedCompletedNodeIds.push(nodeId);
        ctx.setNodeStatus(nodeId, NodeStatus.COMPLETED);
        if (nodeOutputs[nodeId] !== undefined) {
          ctx.setNodeOutput(nodeId, nodeOutputs[nodeId]);
        }
      }
    }

    this._recordDagRevision(ctx, {
      reason: (opts.mode === "from_failed") ? "retry_replan_from_failed" : `retry_${opts.mode || "snapshot"}`,
      sourceRunId: snapshotId,
      preservedCompletedNodeIds,
      focusNodeIds,
    });

    const retryRunId = ctx.id;
    this._activeRuns.set(retryRunId, {
      workflowId,
      workflowName: def.name,
      ctx,
      startedAt: ctx.startedAt,
      status: WorkflowStatus.RUNNING,
    });
    this._persistActiveRunState(retryRunId, workflowId, def.name, ctx);
    this.emit("run:start", { runId: retryRunId, workflowId, name: def.name, restoredFrom: snapshotId });
    this._emitWorkflowStatus({
      runId: retryRunId,
      workflowId,
      workflowName: def.name,
      eventType: "run:start",
      status: WorkflowStatus.RUNNING,
      meta: { restoredFrom: snapshotId },
    });

    try {
      const adjacency = this._buildAdjacency(def);
      const entryNodes = this._findEntryNodes(def);
      await this._executeDag(def, entryNodes, adjacency, ctx, opts);
      const finalStatus = ctx.errors.length > 0 ? WorkflowStatus.FAILED : WorkflowStatus.COMPLETED;
      this._persistRun(retryRunId, workflowId, ctx);
      this._clearActiveRunState(retryRunId);
      this._activeRuns.delete(retryRunId);
      return { runId: retryRunId, snapshotId, workflowId, ctx, status: finalStatus };
    } catch (err) {
      this._persistRun(retryRunId, workflowId, ctx);
      this._clearActiveRunState(retryRunId);
      this._activeRuns.delete(retryRunId);
      throw err;
    }
  }

  /**
   * List available snapshots, optionally filtered by workflowId.
   * @param {string} [workflowId]
   * @returns {Array<object>}
   */
  listSnapshots(workflowId) {
    try {
      const sqlSnapshots = listWorkflowSnapshotsFromStateLedger({
        anchorPath: this.runsDir,
        workflowId,
      });
      if (Array.isArray(sqlSnapshots) && sqlSnapshots.length > 0) {
        return sqlSnapshots;
      }
    } catch (err) {
      console.warn(`${TAG} workflow snapshot list failed: ${String(err?.message || err)}`);
    }
    const snapshotsDir = resolve(this.runsDir, "snapshots");
    if (!existsSync(snapshotsDir)) return [];
    const files = readdirSync(snapshotsDir).filter((f) => f.endsWith(".json"));
    const snapshots = [];
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(resolve(snapshotsDir, file), "utf8"));
        if (workflowId && data.workflowId !== workflowId) continue;
        const trajectoryFile = resolve(snapshotsDir, "..", WORKFLOW_TRAJECTORIES_DIR, `${data.snapshotId}.json`);
        snapshots.push({
          snapshotId: data.snapshotId,
          runId: data.runId,
          workflowId: data.workflowId,
          createdAt: data.createdAt,
          hasTrajectory: existsSync(trajectoryFile),
        });
      } catch {
        // skip corrupt snapshot files
      }
    }
    return snapshots.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  // ── Internal DAG Execution ────────────────────────────────────────────

  _buildAdjacency(def) {
    const adj = new Map();
    for (const node of def.nodes || []) {
      adj.set(node.id, []);
    }
    for (const edge of def.edges || []) {
      const list = adj.get(edge.source) || [];
      list.push(edge);
      adj.set(edge.source, list);
    }
    return adj;
  }

  /**
   * Collect the set of node IDs reachable from `startId` via forward
   * (non-back) edges.  Used by back-edge handling to know which nodes
   * must be reset when a loop cycles.
   */
  _collectSubgraph(startId, adjacency) {
    const visited = new Set();
    const stack = [startId];
    while (stack.length > 0) {
      const nid = stack.pop();
      if (visited.has(nid)) continue;
      visited.add(nid);
      for (const edge of adjacency.get(nid) || []) {
        if (!edge.backEdge) stack.push(edge.target);
      }
    }
    return visited;
  }

  _findEntryNodes(def) {
    const hasIncoming = new Set();
    for (const edge of def.edges || []) {
      hasIncoming.add(edge.target);
    }
    return (def.nodes || []).filter((n) => !hasIncoming.has(n.id));
  }

  async _executeDag(def, entryNodes, adjacency, ctx, opts) {
    // BFS execution with respect for dependencies
    const executed = new Set();
    const queue = [...entryNodes.map((n) => n.id)];
    const nodeMap = new Map((def.nodes || []).map((n) => [n.id, n]));
    const workflowId = ctx?.data?._workflowId || null;
    const workflowName = ctx?.data?._workflowName || null;
    const emitNodeEvent = (type, node, payload = {}) => {
      this.emit(type, {
        runId: ctx.id,
        workflowId,
        workflowName,
        nodeId: node?.id || payload?.nodeId || null,
        nodeType: node?.type || payload?.nodeType || null,
        nodeLabel: node?.label || payload?.nodeLabel || null,
        ...payload,
      });
    };
    const emitEdgeFlow = (edge, payload = {}) => {
      if (!edge) return;
      this.emit("edge:flow", {
        runId: ctx.id,
        workflowId,
        workflowName,
        edgeId: edge.id || `${edge.source}->${edge.target}`,
        source: edge.source,
        target: edge.target,
        sourcePort: String(edge.sourcePort || "default").trim() || "default",
        backEdge: edge.backEdge === true,
        ...payload,
      });
    };
    const markNodeSkipped = (nodeId, reason = "skipped", payload = {}) => {
      if (ctx.getNodeStatus(nodeId) === NodeStatus.COMPLETED) return;
      const node = nodeMap.get(nodeId) || null;
      ctx.setNodeStatus(nodeId, NodeStatus.SKIPPED);
      this._recordDagNodeOutcome(ctx, node || { id: nodeId }, {
        status: NodeStatus.SKIPPED,
        error: payload?.error || null,
      });
      emitNodeEvent("node:skip", node, {
        status: NodeStatus.SKIPPED,
        reason,
        ...payload,
      });
      this._recordLedgerEvent({
        eventType: "node.skipped",
        runId: ctx.id,
        workflowId,
        workflowName,
        rootRunId: ctx.data?._workflowRootRunId || ctx.id,
        parentRunId: ctx.data?._workflowParentRunId || null,
        retryOf: ctx.data?._retryOf || null,
        nodeId,
        nodeType: node?.type || null,
        nodeLabel: node?.label || null,
        status: NodeStatus.SKIPPED,
        reason,
        meta: payload && typeof payload === "object" ? payload : undefined,
      });
    };

    // Track in-degree for proper scheduling (exclude back-edges)
    const inDegree = new Map();
    const incomingSatisfiedCount = new Map();
    for (const node of def.nodes || []) {
      inDegree.set(node.id, 0);
      incomingSatisfiedCount.set(node.id, 0);
    }
    for (const edge of def.edges || []) {
      if (!edge.backEdge) {
        inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
      }
    }

    // Back-edge iteration counters: Map<edgeId, number>
    const backEdgeIterations = new Map();

    const countForwardIncomingEdges = (targetNodeId) =>
      (def.edges || []).filter((edge) => edge.target === targetNodeId && !edge.backEdge).length;

    const resolveSelectedPortForOutput = (node, edges, sourceOutput) => {
      const explicitEdgePorts = new Set(
        edges
          .map((edge) => String(edge?.sourcePort || "default").trim() || "default")
          .filter((portName) => portName && portName !== "default"),
      );
      const inferredConditionPort =
        !sourceOutput?.matchedPort
        && !sourceOutput?.port
        && node?.type?.startsWith("condition.")
        && typeof sourceOutput?.result === "boolean"
        ? (sourceOutput.result ? "yes" : "no")
        : null;
      const selectedPortRaw =
        sourceOutput?.matchedPort ??
        sourceOutput?.port ??
        (inferredConditionPort && explicitEdgePorts.has(inferredConditionPort) ? inferredConditionPort : null);
      if (typeof selectedPortRaw !== "string" || !selectedPortRaw.trim()) return null;
      const selectedPort = selectedPortRaw.trim();
      if (selectedPort === "default") return "default";
      return explicitEdgePorts.has(selectedPort) ? selectedPort : null;
    };

    const propagateResumeSkip = (skippedNodeId) => {
      if (countForwardIncomingEdges(skippedNodeId) > 1) return;
      const skippedEdges = adjacency.get(skippedNodeId) || [];
      for (const skippedEdge of skippedEdges) {
        if (skippedEdge.backEdge) continue;
        consumeReplayDependency(skippedEdge.target, false);
      }
    };

    const consumeReplayDependency = (targetNodeId, matched) => {
      const nextDegree = (inDegree.get(targetNodeId) || 1) - 1;
      inDegree.set(targetNodeId, nextDegree);
      if (matched) {
        incomingSatisfiedCount.set(
          targetNodeId,
          (incomingSatisfiedCount.get(targetNodeId) || 0) + 1,
        );
      }
      if (nextDegree <= 0 && !executed.has(targetNodeId) && (incomingSatisfiedCount.get(targetNodeId) || 0) <= 0) {
        ctx.setNodeStatus(targetNodeId, NodeStatus.SKIPPED);
        executed.add(targetNodeId);
        propagateResumeSkip(targetNodeId);
      }
    };

    // ── Resume support (retry from_failed) ──────────────────────────────
    // If nodes are already marked COMPLETED in the context (pre-seeded by
    // retryRun), treat them as already executed and replay only the branch
    // edges that were actually satisfied by their persisted outputs.
    const preservedCompletedNodeIds = [];
    for (const [nodeId, status] of ctx.nodeStatuses) {
      if (status === NodeStatus.COMPLETED) {
        preservedCompletedNodeIds.push(nodeId);
        executed.add(nodeId);
      }
    }

    for (const nodeId of preservedCompletedNodeIds) {
      const node = nodeMap.get(nodeId);
      const edges = adjacency.get(nodeId) || [];
      const sourceOutput = ctx.getNodeOutput(nodeId);
      const triggerBlocked = node?.type?.startsWith("trigger.") && sourceOutput?.triggered === false;
      const selectedPort = resolveSelectedPortForOutput(node, edges, sourceOutput);
      for (const edge of edges) {
        if (edge.backEdge) continue;
        if (triggerBlocked) {
          consumeReplayDependency(edge.target, false);
          continue;
        }
        const edgePort = String(edge?.sourcePort || "default").trim() || "default";
        if (selectedPort && edgePort !== selectedPort) {
          consumeReplayDependency(edge.target, false);
          continue;
        }
        if (edge.condition) {
          try {
            const condResult = this._evaluateCondition(edge.condition, ctx, nodeId);
            if (!condResult) {
              consumeReplayDependency(edge.target, false);
              continue;
            }
          } catch {
            continue;
          }
        }
        consumeReplayDependency(edge.target, true);
      }
    }

    // Ready set = entry nodes (or nodes with no remaining unsatisfied deps)
    const ready = new Set();
    for (const nid of queue) {
      if (!executed.has(nid)) {
        ready.add(nid);
      }
    }
    // Also add any non-entry nodes whose in-degree is now 0 due to pre-
    // completed predecessors (this makes "from_failed" resume work).
    for (const [nid, deg] of inDegree) {
      if (
        deg <= 0
        && !executed.has(nid)
        && !ready.has(nid)
        && ((incomingSatisfiedCount.get(nid) || 0) > 0 || countForwardIncomingEdges(nid) === 0)
      ) {
        ready.add(nid);
      }
    }

    while (ready.size > 0) {
      const activeRun = this._activeRuns.get(ctx.id);
      if (activeRun?.cancelRequested) {
        ctx.data._workflowTerminalStatus = WorkflowStatus.CANCELLED;
        ctx.data._workflowTerminalMessage = String(activeRun.cancelReason || "Run cancelled by user");
        ctx.data._workflowTerminalAt = Date.now();
        for (const [nid] of nodeMap) {
          if (!executed.has(nid)) {
            markNodeSkipped(nid, "run-cancelled");
            executed.add(nid);
          }
        }
        return;
      }
      // Execute ready nodes in bounded parallel batches.
      const pendingReady = Array.from(ready);
      const batch = pendingReady.slice(0, MAX_CONCURRENT_BRANCHES);
      ready.clear();
      for (const deferredNodeId of pendingReady.slice(MAX_CONCURRENT_BRANCHES)) {
        ready.add(deferredNodeId);
      }

      const results = await Promise.allSettled(
        batch.map(async (nodeId) => {
          if (executed.has(nodeId)) return;
          const node = nodeMap.get(nodeId);
          if (!node) return;

          const activeInfo = this._activeRuns.get(ctx.id);
          if (activeInfo?.cancelRequested) {
            markNodeSkipped(nodeId, "run-cancelled");
            executed.add(nodeId);
            return { nodeId, result: null, skipped: true };
          }

          ctx.setNodeStatus(nodeId, NodeStatus.RUNNING);
          this._recordDagNodeOutcome(ctx, node, {
            status: NodeStatus.RUNNING,
            attempt: ctx.getRetryCount(nodeId),
          });
          const isTriggerNode = node.type?.startsWith("trigger.");
          if (!isTriggerNode) {
            logWorkflowTrace(`${TAG} node:start ${nodeId} (${node.type}) [${node.label || ""}] wf=${ctx.data?._workflowName || ctx.data?._workflowId || "?"}`);
          }
          emitNodeEvent("node:start", node, { status: NodeStatus.RUNNING });
          this._recordLedgerEvent({
            eventType: "node.started",
            runId: ctx.id,
            workflowId,
            workflowName,
            rootRunId: ctx.data?._workflowRootRunId || ctx.id,
            parentRunId: ctx.data?._workflowParentRunId || null,
            retryOf: ctx.data?._retryOf || null,
            nodeId,
            nodeType: node?.type || null,
            nodeLabel: node?.label || null,
            status: NodeStatus.RUNNING,
          });
          await this._emitTaskTraceEvent("workflow.node.start", {
            ctx,
            runId: ctx.id,
            workflowId,
            workflowName,
            node,
            status: NodeStatus.RUNNING,
          });

          // Retry loop — uses per-node maxRetries/retryDelayMs with global fallbacks.
          const resolvedMaxRetriesRaw =
            node.config?.maxRetries !== undefined
              ? Number(ctx.resolve(node.config.maxRetries))
              : MAX_NODE_RETRIES;
          const maxRetries = node.config?.retryable === false
            ? 0
            : Number.isFinite(resolvedMaxRetriesRaw)
              ? Math.max(0, Math.trunc(resolvedMaxRetriesRaw))
              : MAX_NODE_RETRIES;
          const resolvedRetryDelayRaw =
            node.config?.retryDelayMs !== undefined
              ? Number(ctx.resolve(node.config.retryDelayMs))
              : 1000;
          const baseRetryDelay = Number.isFinite(resolvedRetryDelayRaw)
            ? Math.max(0, Math.trunc(resolvedRetryDelayRaw))
            : 1000;
          let lastErr;

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
              if (attempt > 0) {
                ctx.incrementRetry(nodeId);
                const backoffMs = Math.min(baseRetryDelay * Math.pow(2, attempt - 1), 30000);
                ctx.log(nodeId, `Retry ${attempt}/${maxRetries} after ${backoffMs}ms`, "warn");
                emitNodeEvent("node:retry", node, { attempt, maxRetries, backoffMs });
                this._recordLedgerEvent({
                  eventType: "node.retry",
                  runId: ctx.id,
                  workflowId,
                  workflowName,
                  rootRunId: ctx.data?._workflowRootRunId || ctx.id,
                  parentRunId: ctx.data?._workflowParentRunId || null,
                  retryOf: ctx.data?._retryOf || null,
                  nodeId,
                  nodeType: node?.type || null,
                  nodeLabel: node?.label || null,
                  status: NodeStatus.RUNNING,
                  attempt,
                  meta: { maxRetries, backoffMs },
                });
                await new Promise((r) => setTimeout(r, backoffMs));
                ctx.setNodeStatus(nodeId, NodeStatus.RUNNING);
                this._recordDagNodeOutcome(ctx, node, {
                  status: NodeStatus.RUNNING,
                  attempt: ctx.getRetryCount(nodeId),
                });
              }
              const result = await this._executeNode(node, ctx, opts);
              ctx.setNodeOutput(nodeId, result);
              ctx.setNodeStatus(nodeId, NodeStatus.COMPLETED);
              this._recordDagNodeOutcome(ctx, node, {
                status: NodeStatus.COMPLETED,
                result,
                attempt: ctx.getRetryCount(nodeId),
              });
              executed.add(nodeId);
              // Quiet mode for trigger nodes: only log when they actually fire
              if (isTriggerNode) {
                if (result?.triggered === true) {
                  logWorkflowTrace(`${TAG} trigger:fired ${nodeId} (${node.type}) [${node.label || ""}] wf=${ctx.data?._workflowName || ctx.data?._workflowId || "?"}`);
                }
                // triggered: false → silent (reduces noise from non-firing polls)
              } else {
                const resultSuffix = node.type?.startsWith("condition.") ? ` result=${JSON.stringify(result?.result ?? result)}` : "";
                logWorkflowTrace(`${TAG} node:complete ${nodeId} (${node.type}) [${node.label || ""}]${resultSuffix}`);
              }
              emitNodeEvent("node:complete", node, {
                status: NodeStatus.COMPLETED,
                output: result,
              });
              this._emitWorkflowStatus({
                runId: ctx.id,
                workflowId,
                workflowName,
                eventType: "node:complete",
                status: NodeStatus.COMPLETED,
                nodeId,
                nodeType: node?.type || null,
                nodeLabel: node?.label || null,
                meta: { attempt: ctx.getRetryCount(nodeId) },
              });
              this._recordLedgerEvent({
                eventType: "node.completed",
                runId: ctx.id,
                workflowId,
                workflowName,
                rootRunId: ctx.data?._workflowRootRunId || ctx.id,
                parentRunId: ctx.data?._workflowParentRunId || null,
                retryOf: ctx.data?._retryOf || null,
                nodeId,
                nodeType: node?.type || null,
                nodeLabel: node?.label || null,
                status: NodeStatus.COMPLETED,
                attempt: ctx.getRetryCount(nodeId),
                durationMs: Number(ctx.getNodeTiming(nodeId)?.endedAt || 0) - Number(ctx.getNodeTiming(nodeId)?.startedAt || 0),
                summary: this._summarizeTaskTraceNodeResult(result),
              });
              await this._emitTaskTraceEvent("workflow.node.complete", {
                ctx,
                runId: ctx.id,
                workflowId,
                workflowName,
                node,
                result,
                status: NodeStatus.COMPLETED,
              });

              // Checkpoint progress to disk (debounced) so the run can
              // be resumed from here if the process is interrupted.
              this._checkpointRun(ctx);

              lastErr = null;
              return { nodeId, result };
            } catch (err) {
              lastErr = err;
              if (err.retryable === false) break; // permanent error — skip remaining retry attempts
            }
          }

          // All retries exhausted
          ctx.error(nodeId, lastErr);
          ctx.setNodeStatus(nodeId, NodeStatus.FAILED);
          this._recordDagNodeOutcome(ctx, node, {
            status: NodeStatus.FAILED,
            error: lastErr?.message || String(lastErr),
            attempt: ctx.getRetryCount(nodeId),
          });
          executed.add(nodeId);
          console.warn(`${TAG} node:FAILED ${nodeId} (${node.type}) [${node.label || ""}]: ${lastErr?.message || lastErr}`);
          emitNodeEvent("node:error", node, {
            status: NodeStatus.FAILED,
            error: lastErr.message,
            retries: ctx.getRetryCount(nodeId),
          });
          this._recordLedgerEvent({
            eventType: "node.failed",
            runId: ctx.id,
            workflowId,
            workflowName,
            rootRunId: ctx.data?._workflowRootRunId || ctx.id,
            parentRunId: ctx.data?._workflowParentRunId || null,
            retryOf: ctx.data?._retryOf || null,
            nodeId,
            nodeType: node?.type || null,
            nodeLabel: node?.label || null,
            status: NodeStatus.FAILED,
            attempt: ctx.getRetryCount(nodeId),
            error: lastErr?.message || String(lastErr),
          });
          await this._emitTaskTraceEvent("workflow.node.error", {
            ctx,
            runId: ctx.id,
            workflowId,
            workflowName,
            node,
            status: NodeStatus.FAILED,
            error: lastErr?.message || String(lastErr),
            extra: {
              retries: ctx.getRetryCount(nodeId),
            },
          });

          // Check if node has error handling config
          if (node.config?.continueOnError) {
            ctx.setNodeOutput(nodeId, { error: lastErr.message, _failed: true });
            return { nodeId, result: null, error: lastErr.message };
          }
          throw lastErr; // Propagate to stop workflow
        })
      );

      // Check for hard failures (non-continueOnError)
      for (const r of results) {
        if (r.status === "rejected") {
          // If any node fails hard, mark remaining as skipped
          for (const [nid] of nodeMap) {
            if (!executed.has(nid)) {
              markNodeSkipped(nid, "upstream-failed");
            }
          }
          return;
        }
      }

      const activeAfterBatch = this._activeRuns.get(ctx.id);
      if (activeAfterBatch?.cancelRequested) {
        ctx.data._workflowTerminalStatus = WorkflowStatus.CANCELLED;
        ctx.data._workflowTerminalMessage = String(activeAfterBatch.cancelReason || "Run cancelled by user");
        ctx.data._workflowTerminalAt = Date.now();
        for (const [nid] of nodeMap) {
          if (!executed.has(nid)) {
            markNodeSkipped(nid, "run-cancelled");
            executed.add(nid);
          }
        }
        return;
      }
      // Check for explicit terminal node requests (e.g. flow.end)
      let terminalSignal = null;
      for (const r of results) {
        if (r.status !== "fulfilled") continue;
        const signal = r.value?.result;
        if (signal && signal._workflowEnd === true) {
          terminalSignal = signal;
          break;
        }
      }
      if (terminalSignal) {
        const terminalStatus = String(terminalSignal.status || WorkflowStatus.COMPLETED)
          .trim()
          .toLowerCase();
        ctx.data._workflowTerminalStatus = terminalStatus === WorkflowStatus.FAILED
          ? WorkflowStatus.FAILED
          : WorkflowStatus.COMPLETED;
        if (terminalSignal.message) ctx.data._workflowTerminalMessage = String(terminalSignal.message);
        if (terminalSignal.output !== undefined) ctx.data._workflowTerminalOutput = terminalSignal.output;
        if (terminalSignal.nodeId) ctx.data._workflowTerminalNodeId = terminalSignal.nodeId;
        ctx.data._workflowTerminalAt = Date.now();

        for (const [nid] of nodeMap) {
          if (!executed.has(nid)) {
            markNodeSkipped(nid, "workflow-ended");
            executed.add(nid);
          }
        }
        return;
      }

      // Find newly ready nodes (all incoming edges satisfied)
      for (const nodeId of batch) {
        const node = nodeMap.get(nodeId);
        const edges = adjacency.get(nodeId) || [];
        const sourceOutput = ctx.getNodeOutput(nodeId);
        const triggerBlocked = node?.type?.startsWith("trigger.") && sourceOutput?.triggered === false;
        const selectedPort = resolveSelectedPortForOutput(node, edges, sourceOutput);

        if (triggerBlocked) {
          for (const edge of edges) {
            if (edge.backEdge) continue;
            const newDegree = (inDegree.get(edge.target) || 1) - 1;
            inDegree.set(edge.target, newDegree);
            if (newDegree <= 0 && !executed.has(edge.target)) {
              markNodeSkipped(edge.target, "trigger-not-fired", { sourceNodeId: nodeId });
              executed.add(edge.target);
            }
          }
          continue;
        }

        // Handle loop.for_each: iterate downstream subgraph per item
        if (node?.type === "loop.for_each" && ctx.getNodeStatus(nodeId) === NodeStatus.COMPLETED) {
          const loopOutput = ctx.getNodeOutput(nodeId);
          const items = loopOutput?.items || [];
          const varName = loopOutput?.variable || "item";

          if (items.length > 0) {
            // Collect direct downstream target IDs from this loop node
            const downstreamIds = edges.map((e) => e.target);
            const iterationResults = [];

            for (let i = 0; i < items.length; i++) {
              const item = items[i];
              this.emit("loop:iteration", { nodeId, index: i, total: items.length });

              // Fork context with loop variable injected
              const forked = ctx.fork({ [varName]: item, _loopIndex: i, _loopTotal: items.length });

              // Execute each downstream node in the forked context
              for (const targetId of downstreamIds) {
                const targetNode = nodeMap.get(targetId);
                if (!targetNode) continue;
                try {
                  forked.setNodeStatus(targetId, NodeStatus.RUNNING);
                  const result = await this._executeNode(targetNode, forked, opts);
                  forked.setNodeOutput(targetId, result);
                  forked.setNodeStatus(targetId, NodeStatus.COMPLETED);
                } catch (err) {
                  forked.error(targetId, err);
                  forked.setNodeStatus(targetId, NodeStatus.FAILED);
                  if (!targetNode.config?.continueOnError) break;
                }
              }
              iterationResults.push(forked.data);
              // Merge forked logs/errors back
              ctx.logs.push(...forked.logs);
              ctx.errors.push(...forked.errors);
            }

            // Mark downstream nodes as completed in main context & store aggregated results
            for (const targetId of downstreamIds) {
              executed.add(targetId);
              ctx.setNodeStatus(targetId, NodeStatus.COMPLETED);
              ctx.setNodeOutput(targetId, { _loopResults: iterationResults, iterations: items.length });
            }
            // Also queue any nodes downstream of the loop body
            for (const targetId of downstreamIds) {
              const targetEdges = adjacency.get(targetId) || [];
              for (const te of targetEdges) {
                const nd = (inDegree.get(te.target) || 1) - 1;
                inDegree.set(te.target, nd);
                if (nd <= 0 && !executed.has(te.target)) ready.add(te.target);
              }
            }
            continue; // Skip normal edge processing for loop node
          }
        }

        const propagateSkippedDependencies = (skippedNodeId) => {
          const skippedEdges = adjacency.get(skippedNodeId) || [];
          for (const skippedEdge of skippedEdges) {
            if (skippedEdge.backEdge) continue;
            consumeEdgeDependency(skippedEdge.target, false, {
              reason: "upstream-skipped",
              payload: {
                sourceNodeId: skippedNodeId,
                edgeId: skippedEdge.id || `${skippedEdge.source}->${skippedEdge.target}`,
              },
            });
          }
        };

        const consumeEdgeDependency = (targetNodeId, matched, skipInfo = null) => {
          const nextDegree = (inDegree.get(targetNodeId) || 1) - 1;
          inDegree.set(targetNodeId, nextDegree);
          if (matched) {
            incomingSatisfiedCount.set(
              targetNodeId,
              (incomingSatisfiedCount.get(targetNodeId) || 0) + 1,
            );
          }
          if (nextDegree <= 0 && !executed.has(targetNodeId)) {
            if ((incomingSatisfiedCount.get(targetNodeId) || 0) > 0) {
              ready.add(targetNodeId);
            } else {
              const priorStatus = ctx.getNodeStatus(targetNodeId);
              if (!matched && priorStatus === NodeStatus.COMPLETED) {
                executed.add(targetNodeId);
                return;
              }
              markNodeSkipped(targetNodeId, skipInfo?.reason || "skipped", skipInfo?.payload || {});
              executed.add(targetNodeId);
              const skippedNode = nodeMap.get(targetNodeId);
              logWorkflowTrace(`${TAG} node:SKIPPED ${targetNodeId} (${skippedNode?.type || "?"}) [${skippedNode?.label || ""}] — no satisfied edges`);
              propagateSkippedDependencies(targetNodeId);
            }
          }
        };

        for (const edge of edges) {
          const edgePort = String(edge?.sourcePort || "default").trim() || "default";
          if (selectedPort && edgePort !== selectedPort) {
            if (!edge.backEdge) {
              consumeEdgeDependency(edge.target, false, {
                reason: "edge-port-mismatch",
                payload: {
                  sourceNodeId: nodeId,
                  edgeId: edge.id || `${edge.source}->${edge.target}`,
                },
              });
            }
            continue;
          }

          // Check edge condition
          if (edge.condition) {
            try {
              const condResult = this._evaluateCondition(edge.condition, ctx, nodeId);
              if (!condResult) {
                // For back-edges, a false condition simply means "don't loop"
                if (!edge.backEdge) {
                  consumeEdgeDependency(edge.target, false, {
                    reason: "edge-condition-false",
                    payload: {
                      sourceNodeId: nodeId,
                      edgeId: edge.id || `${edge.source}->${edge.target}`,
                    },
                  });
                }
                continue;
              }
            } catch {
              continue;
            }
          }

          // ── Back-edge handling (convergence loops) ──────────────────────
          if (edge.backEdge) {
            const edgeKey = edge.id || `${edge.source}->${edge.target}`;
            const iterCount = (backEdgeIterations.get(edgeKey) || 0) + 1;
            // During dry-run, conditions return stub objects instead of real
            // booleans so loop-exit expressions never fire.  Cap iterations
            // to a small number (2) to validate the loop structure without
            // executing hundreds of iterations.
            const DRY_RUN_BACK_EDGE_CAP = 1;
            const maxIter = opts.dryRun
              ? Math.min(Number(edge.maxIterations) || MAX_BACK_EDGE_ITERATIONS, DRY_RUN_BACK_EDGE_CAP)
              : (Number(edge.maxIterations) || MAX_BACK_EDGE_ITERATIONS);

            if (iterCount > maxIter) {
              ctx.log(nodeId,
                `Back-edge "${edgeKey}" reached max iterations (${maxIter}) — stopping loop`,
                "warn");
              this.emit("loop:exhausted", { edgeId: edgeKey, iterations: maxIter, nodeId });
              continue; // Don't follow this back-edge
            }

            backEdgeIterations.set(edgeKey, iterCount);
            emitEdgeFlow(edge, {
              reason: "back-edge",
              iteration: iterCount,
              maxIterations: maxIter,
            });
            this.emit("loop:back_edge", {
              edgeId: edgeKey,
              source: edge.source,
              target: edge.target,
              iteration: iterCount,
              maxIterations: maxIter,
            });
            ctx.log(nodeId,
              `Back-edge → ${edge.target} (iteration ${iterCount}/${maxIter})`,
              "info");

            // Reset the target node and all forward-reachable nodes from it
            // so the sub-graph can be re-executed.
            const subgraph = this._collectSubgraph(edge.target, adjacency);
            for (const nid of subgraph) {
              executed.delete(nid);
              const priorStatus = ctx.getNodeStatus(nid);
              if (nid === edge.target || priorStatus !== NodeStatus.COMPLETED) {
                ctx.setNodeStatus(nid, NodeStatus.PENDING);
              }
              incomingSatisfiedCount.set(nid, 0);
              // Restore in-degree for nodes in the subgraph so they schedule
              // correctly on this new iteration.
              let deg = 0;
              for (const e of def.edges || []) {
                if (e.target === nid && !e.backEdge) deg++;
              }
              // Subtract 1 for each predecessor in the subgraph that will
              // re-execute (its edge will re-satisfy the in-degree).
              // But do NOT subtract for the back-edge source — the back-edge
              // itself is what triggers the target to be ready now.
              for (const e of def.edges || []) {
                if (e.target === nid && !e.backEdge && subgraph.has(e.source)) {
                  deg--;
                }
              }
              // The back-edge target itself has a satisfied edge (the back-edge)
              if (nid === edge.target) deg = 0;
              inDegree.set(nid, Math.max(0, deg));
            }
            ready.add(edge.target);
            continue;
          }

          // Decrement in-degree (forward edges only)
          emitEdgeFlow(edge, {
            reason: selectedPort ? "selected-port" : "forward",
          });
          consumeEdgeDependency(edge.target, true);
        }
      }
    }
  }

  async _executeNode(node, ctx, opts = {}) {
    const handler = getNodeType(node.type);
    if (!handler) {
      throw new Error(`Unknown node type: "${node.type}". Register it with registerNodeType().`);
    }

    // Resolve config templates against context
    const resolvedConfig = this._resolveConfig(node.config || {}, ctx, node.type);

    // Capture resolved input snapshot for forensics
    ctx.setNodeInput(node.id, resolvedConfig);

    // Dry run — skip capability checks and handler execution.
    // Services aren't needed for simulation; this keeps dry-run tests fast.
    if (opts.dryRun) {
      ctx.log(node.id, `[dry-run] Would execute ${node.type}`, "info");
      return { _dryRun: true, type: node.type, config: resolvedConfig };
    }

    return traceWorkflowNode(
      {
        workflowId: ctx?.data?._workflowId || null,
        workflowRunId: ctx?.id || null,
        rootRunId: ctx?.data?._workflowRootRunId || ctx?.id || null,
        parentRunId: ctx?.data?._workflowParentRunId || null,
        nodeId: node.id,
        nodeType: node.type,
        nodeLabel: node.label || null,
        taskId: resolveTraceTaskId(ctx?.data),
        agentId: resolveTraceAgentId(ctx?.data, resolvedConfig?.agentProfile || node.id),
      },
      async () => {
        // ── Capability pre-flight check ──────────────────────────────────────
        // Verify required services are present AFTER the dryRun early-return so
        // dry-run tests work without needing real service dependencies wired up.
        const requiredCapabilities = this._getNodeRequiredCapabilities(node.type);
        const missingCapabilities = [];
        for (const cap of requiredCapabilities) {
          if (!this._hasCapability(cap)) {
            missingCapabilities.push(cap);
          }
        }
        if (missingCapabilities.length > 0) {
          const detail = `Node "${node.label || node.id}" (${node.type}) requires capabilities: [${missingCapabilities.join(", ")}] which are not available. ` +
            `Check that the required services (agent pool, kanban adapter, etc.) are configured and the agent has the necessary permissions.`;
          ctx.log(node.id, detail, "error");
          const capErr = new Error(detail);
          capErr.retryable = false; // missing service is permanent — don't waste time retrying
          throw capErr;
        }

        // Execute with timeout — clear timer on completion to avoid resource leaks
        const timeout = resolveNodeTimeoutMs(node, resolvedConfig);
        let timer;
        ctx.setNodeTiming(node.id, "startedAt", Date.now());
        try {
          const result = await Promise.race([
            handler.execute(
              { ...node, config: resolvedConfig },
              ctx,
              this
            ),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error(`Node "${node.label || node.id}" timed out after ${timeout}ms`)), timeout);
            }),
          ]);
          ctx.setNodeTiming(node.id, "endedAt", Date.now());
          return result;
        } catch (err) {
          ctx.setNodeTiming(node.id, "endedAt", Date.now());
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
    );
  }

  _resolveConfig(config, ctx, nodeType = "", path = []) {
    if (Array.isArray(config)) {
      return config.map((item, index) => this._resolveConfig(item, ctx, nodeType, [...path, index]));
    }
    if (config == null || typeof config !== "object") {
      return config;
    }
    const resolved = {};
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === "string") {
        const preserveRawConditionExpression =
          nodeType === "condition.expression"
          && path.length === 0
          && key === "expression";
        resolved[key] = preserveRawConditionExpression ? value : ctx.resolve(value);
      } else if (typeof value === "object" && value !== null) {
        resolved[key] = this._resolveConfig(value, ctx, nodeType, [...path, key]);
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  // ── Capability helpers ──────────────────────────────────────────────────
  // Map node-type prefixes / names to the engine.services keys they need.
  // This lets _executeNode fail-fast with a clear message instead of letting
  // the handler throw a cryptic "cannot read property X of undefined".

  /** @returns {string[]} service keys the node type needs (may be empty) */
  _getNodeRequiredCapabilities(nodeType) {
    // Agent nodes need the agentPool service
    if (nodeType.startsWith("agent.")) {
      return ["agentPool"];
    }
    // Session continuation / restart also need agentPool
    if (nodeType === "action.continue_session" || nodeType === "action.restart_agent") {
      return ["agentPool"];
    }
    // Child workflow execution needs a live engine instance.
    if (nodeType === "action.execute_workflow") {
      return ["workflowEngine"];
    }
    // Meeting workflow nodes require the meeting service bridge.
    if (nodeType.startsWith("meeting.")) {
      return ["meeting"];
    }
    // Task-management nodes need kanban
    if (
      nodeType === "action.create_task" ||
      nodeType === "action.update_task_status" ||
      nodeType === "action.materialize_planner_tasks"
    ) {
      return ["kanban"];
    }
    // condition.task_has_tag reads from kanban
    if (nodeType === "condition.task_has_tag") {
      return ["kanban"];
    }
    // No special service required (file I/O, git, transforms, logs, etc.)
    return [];
  }

  /** Check whether a named capability (service key) is available */
  _hasCapability(cap) {
    if (cap === "workflowEngine") {
      return typeof this.execute === "function" && typeof this.get === "function";
    }
    const svc = this.services?.[cap];
    // A capability is "present" when its value is a non-null object or function.
    return svc != null && (typeof svc === "object" || typeof svc === "function");
  }

  _evaluateCondition(condition, ctx, sourceNodeId) {
    // Simple expression evaluator — supports basic comparisons
    // Variables: $output (source node output), $data (context data), $status
    const output = ctx.getNodeOutput(sourceNodeId);
    const data = ctx.data;
    const status = ctx.getNodeStatus(sourceNodeId);
    const resolvedCondition = typeof condition === "string" ? ctx.resolve(condition) : condition;
    if (typeof resolvedCondition === "boolean") return resolvedCondition;
    if (resolvedCondition == null) return false;
    const expression = String(resolvedCondition).trim();
    if (!expression) return false;

    // Safe subset evaluation
    try {
      const fn = new Function("$output", "$data", "$status", "$ctx", `return (${expression});`);
      return fn(output, data, status, ctx);
    } catch {
      return false;
    }
  }

  _readRunIndex() {
    const indexPath = resolve(this.runsDir, "index.json");
    if (!existsSync(indexPath)) {
      const ledgerRuns = this._readRunIndexFromStateLedger();
      if (ledgerRuns.length > 0) return ledgerRuns;
      this._runIndexCache = [];
      this._runIndexCacheMtime = 0;
      return [];
    }
    try {
      const mtimeMs = statSync(indexPath).mtimeMs || 0;
      if (Array.isArray(this._runIndexCache) && this._runIndexCacheMtime === mtimeMs) {
        return this._runIndexCache;
      }
      const index = JSON.parse(readFileSync(indexPath, "utf8"));
      const runs = Array.isArray(index?.runs) ? index.runs : [];
      if (runs.length === 0) {
        const ledgerRuns = this._readRunIndexFromStateLedger();
        if (ledgerRuns.length > 0) return ledgerRuns;
      }
      this._runIndexCache = runs;
      this._runIndexCacheMtime = mtimeMs;
      return runs;
    } catch {
      const ledgerRuns = this._readRunIndexFromStateLedger();
      return ledgerRuns.length > 0 ? ledgerRuns : [];
    }
  }

  _readRunDetailFile(runId) {
    const normalizedRunId = String(runId || "").trim();
    if (!normalizedRunId) return null;
    const detailPath = resolve(this.runsDir, `${normalizedRunId}.json`);
    if (!existsSync(detailPath)) return null;
    try {
      return JSON.parse(readFileSync(detailPath, "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * Read ONLY the identity-relevant fields from a run-detail file without
   * parsing the full document. Run details can grow to >100 MB (logs,
   * nodeOutputs, replayTrajectory) and parsing them all on monitor startup
   * has historically OOM'd the engine (V8 heap >4 GB during dedup of
   * paused+resumable runs). Identity fields are written near the top of
   * `toJSON()` output so a small head-of-file scan is sufficient.
   *
   * Returns a tiny synthetic object shaped enough for
   * `_resolveRunTaskIdentity()` and the rootRunId/_workflowRootRunId checks.
   */
  _readRunDetailIdentity(runId) {
    const normalizedRunId = String(runId || "").trim();
    if (!normalizedRunId) return null;
    const detailPath = resolve(this.runsDir, `${normalizedRunId}.json`);
    if (!existsSync(detailPath)) return null;

    // Try a small head read first; fall back to full parse if the head is
    // truncated mid-key (very unlikely for identity fields, but safe).
    const HEAD_BYTES = 64 * 1024;
    let head = "";
    let fd = -1;
    try {
      fd = openSync(detailPath, "r");
      const buf = Buffer.allocUnsafe(HEAD_BYTES);
      const bytesRead = readSync(fd, buf, 0, HEAD_BYTES, 0);
      head = buf.toString("utf8", 0, bytesRead);
    } catch {
      head = "";
    } finally {
      if (fd >= 0) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }

    if (!head) return null;

    const pickStringField = (fieldName) => {
      // Match  "fieldName": "value"  with basic JSON escape handling.
      const re = new RegExp(`"${fieldName}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
      const m = head.match(re);
      if (!m) return "";
      try {
        return JSON.parse(`"${m[1]}"`);
      } catch {
        return m[1];
      }
    };

    const taskId =
      pickStringField("taskId") ||
      pickStringField("task_id") ||
      "";
    const activeTaskId = pickStringField("activeTaskId") || "";
    const workflowId = pickStringField("_workflowId") || pickStringField("workflowId") || "";
    const workflowName = pickStringField("_workflowName") || "";
    const workflowRootRunId =
      pickStringField("_workflowRootRunId") ||
      pickStringField("rootRunId") ||
      "";

    if (!taskId && !activeTaskId && !workflowId && !workflowRootRunId) {
      return null;
    }

    return {
      data: {
        taskId: taskId || undefined,
        activeTaskId: activeTaskId || undefined,
        _workflowId: workflowId || undefined,
        _workflowName: workflowName || undefined,
        _workflowRootRunId: workflowRootRunId || undefined,
      },
      dagState: workflowRootRunId ? { rootRunId: workflowRootRunId } : null,
    };
  }

  _readRunIndexFromStateLedger() {
    try {
      const page = listWorkflowRunSummariesPageFromStateLedger({
        anchorPath: this.runsDir,
        offset: 0,
        limit: MAX_PERSISTED_RUNS,
      });
      const runs = Array.isArray(page?.runs)
        ? page.runs.map((entry) => this._normalizeRunSummary(entry)).filter(Boolean)
        : [];
      if (runs.length === 0) return [];
      this._runIndexCache = runs;
      this._runIndexCacheMtime = 0;
      return runs;
    } catch {
      return [];
    }
  }

  _getInterruptedOrphanRunCandidates() {
    if (!existsSync(this.runsDir)) return [];
    if (MAX_INTERRUPTED_ORPHAN_SCAN_FILES <= 0) return [];

    const cutoffMs = INTERRUPTED_ORPHAN_SCAN_WINDOW_MS > 0
      ? Date.now() - INTERRUPTED_ORPHAN_SCAN_WINDOW_MS
      : 0;
    const candidates = [];
    let totalCandidates = 0;

    try {
      for (const file of readdirSync(this.runsDir)) {
        if (
          extname(file) !== ".json" ||
          file === "index.json" ||
          file === ACTIVE_RUNS_INDEX
        ) {
          continue;
        }
        const detailPath = resolve(this.runsDir, file);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(detailPath).mtimeMs || 0;
        } catch {
          continue;
        }
        if (cutoffMs > 0 && mtimeMs < cutoffMs) continue;
        totalCandidates += 1;
        candidates.push({ file, detailPath, mtimeMs });
      }
    } catch {
      return [];
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (candidates.length > MAX_INTERRUPTED_ORPHAN_SCAN_FILES) {
      console.warn(
        `${TAG} Orphan interrupted-run scan limited to ${MAX_INTERRUPTED_ORPHAN_SCAN_FILES} recent files ` +
          `(${totalCandidates} candidate files in retention window)`,
      );
      candidates.length = MAX_INTERRUPTED_ORPHAN_SCAN_FILES;
    }
    return candidates;
  }

  _getRunStuckThresholdMs() {
    const raw = Number(getRuntimeEnv().WORKFLOW_RUN_STUCK_THRESHOLD_MS);
    if (Number.isFinite(raw) && raw > 0) return raw;
    return DEFAULT_RUN_STUCK_THRESHOLD_MS;
  }

  _getLastLogAt(logs = []) {
    let latest = 0;
    for (const entry of Array.isArray(logs) ? logs : []) {
      const ts = Number(entry?.timestamp);
      if (Number.isFinite(ts) && ts > latest) latest = ts;
    }
    return latest > 0 ? latest : null;
  }

  _getLastProgressAt(nodeStatusEvents = [], startedAt = null) {
    let latest = 0;
    for (const event of Array.isArray(nodeStatusEvents) ? nodeStatusEvents : []) {
      const ts = Number(event?.timestamp);
      if (Number.isFinite(ts) && ts > latest) latest = ts;
    }
    if (latest > 0) return latest;
    const normalizedStart = Number(startedAt);
    return Number.isFinite(normalizedStart) && normalizedStart > 0 ? normalizedStart : null;
  }

  _countNodeStatuses(nodeStatuses = {}) {
    const values = Object.values(nodeStatuses || {});
    return {
      nodeCount: values.length,
      completedCount: values.filter((value) => value === NodeStatus.COMPLETED).length,
      failedCount: values.filter((value) => value === NodeStatus.FAILED).length,
      skippedCount: values.filter((value) => value === NodeStatus.SKIPPED).length,
      activeNodeCount: values.filter(
        (value) => value === NodeStatus.RUNNING || value === NodeStatus.WAITING,
      ).length,
    };
  }

  _buildRunCheckpointState(ctx, detail = null) {
    const runDetail = detail && typeof detail === "object" ? detail : sanitizeJsonValue(ctx?.toJSON?.(Date.now())) || {};
    const data = runDetail?.data && typeof runDetail.data === "object" ? runDetail.data : {};
    const nodeStatuses = runDetail?.nodeStatuses && typeof runDetail.nodeStatuses === "object" ? runDetail.nodeStatuses : {};
    const nodeOutputs = runDetail?.nodeOutputs && typeof runDetail.nodeOutputs === "object" ? runDetail.nodeOutputs : {};
    const workflowDefinition =
      ctx?.data?._workflowDefinitionSnapshot ||
      data?._workflowDefinitionSnapshot ||
      runDetail?.workflowDefinition ||
      null;
    const defNodes = Array.isArray(workflowDefinition?.nodes) ? workflowDefinition.nodes : [];
    const completedNodeIds = Object.entries(nodeStatuses)
      .filter(([, status]) => status === NodeStatus.COMPLETED)
      .map(([nodeId]) => nodeId);
    const lastCompletedNodeId = completedNodeIds.length > 0 ? completedNodeIds[completedNodeIds.length - 1] : null;
    const lastCompletedNode = lastCompletedNodeId
      ? defNodes.find((node) => String(node?.id || "").trim() === lastCompletedNodeId) || null
      : null;
    const nextPending = workflowDefinition
      ? this._resolveNextPendingDagNode(runDetail, workflowDefinition)
      : null;
    const planningTaskRef = [
      "materialize-tasks",
      "planner",
      "agent-plan",
      "plan",
    ].reduce((best, key) => {
      if (best) return best;
      const value = nodeOutputs?.[key];
      return value && typeof value === "object" ? sanitizeJsonValue(value) : null;
    }, null);
    const checkpoint = {
      capturedAt: new Date().toISOString(),
      lastCompletedNodeId,
      lastCompletedNodeLabel: String(lastCompletedNode?.label || lastCompletedNodeId || "").trim() || null,
      nextPendingNodeId: String(nextPending?.nodeId || "").trim() || null,
      nextPendingNodeLabel: String(nextPending?.label || nextPending?.nodeId || "").trim() || null,
      nextPendingNodeType: String(nextPending?.type || "").trim() || null,
      planningTaskRef,
      nodeStatuses,
      reason: nextPending?.nodeId
        ? "checkpoint.next_pending_node"
        : (lastCompletedNodeId ? "checkpoint.last_completed_node" : "checkpoint.empty"),
    };
    return compactPersistedRunDetail(sanitizeJsonValue(checkpoint));
  }

  _serializeRunContext(ctx, isRunning = false) {
    const detail = sanitizeJsonValue(ctx.toJSON(Date.now())) || {};
    if (!detail.data || typeof detail.data !== "object") detail.data = {};
    const governanceState = buildWorkflowGovernanceState(ctx?.data || {});
    detail.data = {
      ...detail.data,
      ...toWorkflowGovernanceData(governanceState),
    };
    if (governanceState.goalAncestry?.length) detail.goalAncestry = governanceState.goalAncestry;
    if (governanceState.primaryGoalId) detail.primaryGoalId = governanceState.primaryGoalId;
    if (governanceState.primaryGoalTitle) detail.primaryGoalTitle = governanceState.primaryGoalTitle;
    if (governanceState.goalDepth != null) detail.goalDepth = governanceState.goalDepth;
    if (governanceState.heartbeatRun) detail.heartbeatRun = governanceState.heartbeatRun;
    if (governanceState.wakeupRequest) detail.wakeupRequest = governanceState.wakeupRequest;
    if (governanceState.budgetPolicy) detail.budgetPolicy = governanceState.budgetPolicy;
    if (governanceState.executionPolicy) detail.executionPolicy = governanceState.executionPolicy;
    if (governanceState.budgetOutcome) detail.budgetOutcome = governanceState.budgetOutcome;
    if (governanceState.policyOutcome) detail.policyOutcome = governanceState.policyOutcome;
    if (ctx?.data?._dagState) detail.dagState = sanitizeJsonValue(ctx.data._dagState);
    if (ctx?.data?._issueAdvisor) detail.issueAdvisor = sanitizeJsonValue(ctx.data._issueAdvisor);
    if (ctx?.data?._selfImprovementInsights) {
      detail.selfImprovementInsights = sanitizeJsonValue(ctx.data._selfImprovementInsights);
    }
    if (ctx?.data?._selfImprovementRatchet) {
      detail.selfImprovementRatchet = sanitizeJsonValue(ctx.data._selfImprovementRatchet);
    }
    if (ctx?.data?._lastRunEvaluation) {
      detail.runEvaluation = sanitizeJsonValue(ctx.data._lastRunEvaluation);
    }
    if (ctx?.data?._lastPromotedStrategy) {
      detail.promotedStrategy = sanitizeJsonValue(ctx.data._lastPromotedStrategy);
    }
    if (ctx?.data?._skillbookGuidance) {
      detail.skillbookGuidance = sanitizeJsonValue(ctx.data._skillbookGuidance);
    }
    const runtimeDelegationTrail = Array.isArray(ctx?.__workflowRuntimeState?.delegationAuditTrail)
      ? normalizeDelegationTrail(ctx.__workflowRuntimeState.delegationAuditTrail)
      : [];
    const persistedDelegationTrail = runtimeDelegationTrail.length > 0
      ? runtimeDelegationTrail
      : normalizeDelegationTrail(
          ctx?.data?._delegationAuditTrail ??
          ctx?.data?._workflowDelegationTrail ??
          ctx?.data?._delegationTrail,
        );
    hydrateDelegationReadModel(detail, {
      trail: persistedDelegationTrail,
      guards: extractDelegationGuardMap({ data: ctx?.data || {} }),
    });
    const runtimeTeamState = hasWorkflowTeamStateData(ctx?.__workflowRuntimeState?.workflowTeamState)
      ? cloneWorkflowTeamState(ctx.__workflowRuntimeState.workflowTeamState)
      : null;
    const persistedTeamState = runtimeTeamState || (
      hasWorkflowTeamStateData(ctx?.data?._workflowTeamState ?? ctx?.data?.workflowTeamState)
        ? cloneWorkflowTeamState(ctx?.data?._workflowTeamState ?? ctx?.data?.workflowTeamState)
        : null
    );
    if (persistedTeamState) {
      const teamSummary = buildWorkflowTeamSummary(persistedTeamState);
      detail.data._workflowTeamState = persistedTeamState;
      detail.data.workflowTeamState = persistedTeamState;
      detail.data._workflowTeamSummary = teamSummary;
      detail.workflowTeamState = persistedTeamState;
      detail.teamSummary = teamSummary;
    }
    if (ctx?.data?._workflowDefinitionSnapshot) {
      detail.workflowDefinition = sanitizeJsonValue(
        cloneRunSnapshot(ctx.data._workflowDefinitionSnapshot),
      );
    }
    detail.checkpoint = this._buildRunCheckpointState(ctx, detail);
    detail.data._workflowCheckpoint = detail.checkpoint;
    if (isRunning) {
      detail.endedAt = null;
      detail.duration = Math.max(0, Date.now() - Number(ctx?.startedAt || Date.now()));
    }
    return repairWorkflowRunDetail(isRunning ? detail : compactPersistedRunDetail(detail));
  }

  _buildSummaryFromDetail({ runId, workflowId, workflowName, status, detail }) {
    const startedAt = Number(detail?.startedAt) || null;
    const endedAtRaw = Number(detail?.endedAt);
    const normalizedStatus = status || WorkflowStatus.COMPLETED;
    const endedAt = normalizedStatus === WorkflowStatus.RUNNING
      ? null
      : (Number.isFinite(endedAtRaw) ? endedAtRaw : null);
    const duration = normalizedStatus === WorkflowStatus.RUNNING
      ? (startedAt ? Math.max(0, Date.now() - startedAt) : null)
      : (Number.isFinite(Number(detail?.duration)) ? Number(detail?.duration) : (startedAt && endedAt ? Math.max(0, endedAt - startedAt) : null));
    const nodeStatuses = detail?.nodeStatuses || {};
    const counts = this._countNodeStatuses(nodeStatuses);
    const errorCount = Array.isArray(detail?.errors) ? detail.errors.length : 0;
    const logCount = Array.isArray(detail?.logs) ? detail.logs.length : 0;
    const lastLogAt = this._getLastLogAt(detail?.logs || []);
    const lastProgressAt = this._getLastProgressAt(detail?.nodeStatusEvents || [], startedAt);
    const threshold = this._getRunStuckThresholdMs();
    const activityRef = Math.max(lastLogAt || 0, lastProgressAt || 0, startedAt || 0);
    const isRunning = normalizedStatus === WorkflowStatus.RUNNING;
    const stuckMs = isRunning && activityRef > 0 ? Math.max(0, Date.now() - activityRef) : 0;
    const isStuck = isRunning && stuckMs >= threshold;
    const triggerEvent =
      detail?.data?._triggerEventType ||
      detail?.data?.eventType ||
      null;
    const triggerSource =
      detail?.data?._triggerSource ||
      (triggerEvent ? "event" : "manual");
    const triggeredBy = detail?.data?._triggeredBy || null;
    const targetRepo = detail?.data?._targetRepo || null;
    const triggerVars = detail?.data?._triggerVars || null;
    const delegationTrail = extractDelegationTrail(detail);
    const delegationTransitionGuards = extractDelegationGuardMap(detail);
    const rootRunId =
      detail?.dagState?.rootRunId ||
      detail?.data?._workflowRootRunId ||
      null;
    const parentRunId =
      detail?.dagState?.parentRunId ||
      detail?.data?._workflowParentRunId ||
      null;
    const retryOf =
      detail?.dagState?.retryOf ||
      detail?.data?._retryOf ||
      null;
    const retryMode =
      detail?.dagState?.retryMode ||
      detail?.data?._retryMode ||
      null;
    const retryDecisionReason = detail?.data?._retryDecisionReason || null;
    const issueAdvisorRecommendation = detail?.issueAdvisor?.recommendedAction || null;
    const issueAdvisorSummary = detail?.issueAdvisor?.summary || null;
    const dagRevisionCount = Array.isArray(detail?.dagState?.revisions) ? detail.dagState.revisions.length : 0;
    const validationFailures = collectValidationFailures(detail);
    const identityValidation =
      detail?.identityValidation ||
      detail?.data?._workflowIdentityValidation ||
      null;
    const resumeResult = normalizeWorkflowRunText(
      detail?.resumeResult ??
      detail?.data?._resumeResult ??
      (identityValidation?.code === "invalid_task_identity" ? "invalid_task_identity" : null),
    );
    const resumeResultMessage = normalizeWorkflowRunText(
      detail?.resumeResultMessage ??
      detail?.data?._resumeResultMessage ??
      null,
    );
    const resumable =
      typeof detail?.resumable === "boolean"
        ? detail.resumable
        : identityValidation?.code === "invalid_task_identity"
          ? false
          : null;
    const taskIds = collectRunTaskIds(detail, {
      currentRunId: runId,
      includeTopologyIds: false,
    });
    const sessionIds = collectRunSessionIds(detail, {
      currentRunId: runId,
    });
    const taskTitle = normalizeWorkflowRunText(resolveRunTaskTitle(detail));
    const delegationTopology = buildRunDelegationTopology({ runId, detail });
    const governanceState = buildWorkflowGovernanceState(detail?.data || detail || {});
    const workflowTeamState = hasWorkflowTeamStateData(
      detail?.workflowTeamState ??
      detail?.data?._workflowTeamState ??
      detail?.data?.workflowTeamState,
    )
      ? normalizeWorkflowTeamState(
          detail?.workflowTeamState ??
          detail?.data?._workflowTeamState ??
          detail?.data?.workflowTeamState,
        )
      : null;
    const teamSummary = workflowTeamState
      ? buildWorkflowTeamSummary(workflowTeamState)
      : null;

    return {
      runId,
      workflowId,
      workflowName: normalizeWorkflowRunText(workflowName || workflowId || null),
      startedAt,
      endedAt,
      duration,
      status: normalizedStatus,
      errorCount,
      logCount,
      nodeCount: counts.nodeCount,
      completedCount: counts.completedCount,
      failedCount: counts.failedCount,
      skippedCount: counts.skippedCount,
      activeNodeCount: counts.activeNodeCount,
      lastLogAt,
      lastProgressAt,
      isStuck,
      stuckMs,
      stuckThresholdMs: threshold,
      delegationTrail,
      delegationAuditTrail: delegationTrail,
      latestDelegationEvent: delegationTrail.at(-1) || null,
      delegationTransitionGuards,
      delegationTopology,
      triggerEvent,
      triggerSource,
      triggeredBy,
      targetRepo,
      triggerVars,
      rootRunId,
      parentRunId,
      retryOf,
      retryMode,
      retryDecisionReason,
      issueAdvisorRecommendation,
      issueAdvisorSummary: normalizeWorkflowRunText(issueAdvisorSummary),
      dagRevisionCount,
      taskId: taskIds[0] || null,
      taskIds,
      taskTitle,
      invalidTaskIdentity: identityValidation?.code === "invalid_task_identity",
      ...(identityValidation ? { identityValidation } : {}),
      ...(resumable == null ? {} : { resumable }),
      ...(resumeResult ? { resumeResult } : {}),
      sessionId: sessionIds[0] || null,
      sessionIds,
      primarySessionId: sessionIds[0] || null,
      teamId: teamSummary?.teamId || null,
      teamLeadId: teamSummary?.leadId || null,
      teamSummary,
      goalAncestry: governanceState.goalAncestry || [],
      primaryGoalId: governanceState.primaryGoalId || null,
      primaryGoalTitle: normalizeWorkflowRunText(governanceState.primaryGoalTitle || null),
      goalDepth: governanceState.goalDepth ?? null,
      heartbeatRun: governanceState.heartbeatRun || null,
      wakeupRequest: governanceState.wakeupRequest || null,
      budgetPolicy: governanceState.budgetPolicy || null,
      executionPolicy: governanceState.executionPolicy || null,
      budgetOutcome: governanceState.budgetOutcome || null,
      policyOutcome: governanceState.policyOutcome || null,
      ...(resumeResultMessage ? { resumeResultMessage } : {}),
      ...(validationFailures.length > 0
        ? {
            validationFailures,
            latestValidationFailure: validationFailures.at(-1) || null,
          }
        : {}),
    };
  }

  _buildActiveRunSummary(runId, info) {
    if (!info?.ctx) return null;
    const detail = this._serializeRunContext(info.ctx, true);
    return this._buildSummaryFromDetail({
      runId,
      workflowId: info.workflowId,
      workflowName: info.workflowName || info.ctx?.data?._workflowName || info.workflowId,
      status: WorkflowStatus.RUNNING,
      detail,
    });
  }

  _normalizeRunSummary(summary) {
    if (!summary || !summary.runId) return null;
    const normalized = sanitizeWorkflowRunSummaryIdentity({
      ...summary,
      runId: String(summary.runId),
      status: summary.status || WorkflowStatus.COMPLETED,
      workflowName: normalizeWorkflowRunText(summary.workflowName || null),
      taskTitle: normalizeWorkflowRunText(summary.taskTitle || null),
      issueAdvisorSummary: normalizeWorkflowRunText(summary.issueAdvisorSummary || null),
      primaryGoalTitle: normalizeWorkflowRunText(summary.primaryGoalTitle || null),
      resumeResultMessage: normalizeWorkflowRunText(summary.resumeResultMessage || null),
    });
    if (!Number.isFinite(Number(normalized.stuckThresholdMs))) {
      normalized.stuckThresholdMs = this._getRunStuckThresholdMs();
    }
    if (!Number.isFinite(Number(normalized.activeNodeCount))) {
      normalized.activeNodeCount = 0;
    }
    if (normalized.status !== WorkflowStatus.RUNNING) {
      normalized.activeNodeCount = 0;
      if (!Number.isFinite(Number(normalized.endedAt))) {
        const fallbackEndedAt = Math.max(
          Number(normalized.interruptedAt) || 0,
          Number(normalized.lastProgressAt) || 0,
          Number(normalized.lastLogAt) || 0,
          Number(normalized.startedAt) || 0,
        );
        normalized.endedAt = fallbackEndedAt > 0 ? fallbackEndedAt : null;
      }
      normalized.isStuck = false;
      normalized.stuckMs = 0;
      return normalized;
    }
    const startedAt = Number(normalized.startedAt) || 0;
    const activityRef = Math.max(
      Number(normalized.lastLogAt) || 0,
      Number(normalized.lastProgressAt) || 0,
      startedAt,
    );
    normalized.stuckMs = activityRef > 0 ? Math.max(0, Date.now() - activityRef) : 0;
    normalized.isStuck = normalized.stuckMs >= Number(normalized.stuckThresholdMs);
    return normalized;
  }

  // ── Active-runs persistence (crash recovery) ─────────────────────────

  /**
   * Read the active-runs index (_active-runs.json).
   * Returns an array of { runId, workflowId, workflowName, startedAt }.
   */
  _readActiveRunsIndex() {
    try {
      const p = resolve(this.runsDir, ACTIVE_RUNS_INDEX);
      if (!existsSync(p)) return [];
      const raw = JSON.parse(readFileSync(p, "utf8"));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  _resolveTaskClaimsRepoRoot() {
    const candidates = [
      resolve(this.runsDir, ".."),
      resolve(this.runsDir, "..", ".."),
      this._configDir,
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    for (const candidate of candidates) {
      const claimsPath = resolve(candidate, ".cache", "bosun", "task-claims.json");
      if (existsSync(claimsPath)) return candidate;
    }
    return resolve(this.runsDir, "..");
  }

  _getLiveLocalTaskClaim(taskId) {
    const normalizedTaskId = normalizeWorkflowIdentityText(taskId || "");
    if (!normalizedTaskId) return null;
    try {
      const claimsPath = resolve(
        this._resolveTaskClaimsRepoRoot(),
        ".cache",
        "bosun",
        "task-claims.json",
      );
      if (!existsSync(claimsPath)) return null;
      const registry = JSON.parse(readFileSync(claimsPath, "utf8"));
      const claim = registry?.claims?.[normalizedTaskId] || null;
      if (!claim || typeof claim !== "object") return null;
      const claimHost = String(claim?.metadata?.host || "").trim().toLowerCase();
      if (claimHost && claimHost !== os.hostname().toLowerCase()) return null;
      const claimPid = Number(claim?.metadata?.pid);
      if (!Number.isFinite(claimPid) || claimPid <= 0) return null;
      process.kill(Math.trunc(claimPid), 0);
      return claim;
    } catch {
      return null;
    }
  }

  /** Write the active-runs index atomically. */
  _writeActiveRunsIndex(entries) {
    try {
      this._ensureDirs();
      const p = resolve(this.runsDir, ACTIVE_RUNS_INDEX);
      writeJsonFileAtomically(p, entries);
    } catch (err) {
      console.error(`${TAG} Failed to write active-runs index:`, err.message);
    }
  }

  _readPersistedRunDetail(runId) {
    const normalizedRunId = String(runId || "").trim();
    if (!normalizedRunId) return null;
    try {
      const detailPath = resolve(this.runsDir, `${normalizedRunId}.json`);
      if (!existsSync(detailPath)) return null;
      return JSON.parse(readFileSync(detailPath, "utf8"));
    } catch {
      return null;
    }
  }

  _shouldPreserveForeignActiveRunDetail(detail) {
    if (!detail || typeof detail !== "object") return true;
    const terminalStatus = String(detail?.data?._workflowTerminalStatus || "")
      .trim()
      .toLowerCase();
    if (
      terminalStatus === WorkflowStatus.COMPLETED
      || terminalStatus === WorkflowStatus.FAILED
      || terminalStatus === WorkflowStatus.CANCELLED
      || terminalStatus === WorkflowStatus.PAUSED
    ) {
      return false;
    }
    if (detail?.endedAt != null) return false;
    const counts = this._countNodeStatuses(detail?.nodeStatuses || {});
    if (counts.activeNodeCount > 0) return true;
    const startedAt = Number.isFinite(Number(detail?.startedAt))
      ? Number(detail.startedAt)
      : null;
    const activityRef = Math.max(
      this._getLastLogAt(detail?.logs || []) || 0,
      this._getLastProgressAt(detail?.nodeStatusEvents || [], startedAt) || 0,
      startedAt || 0,
    );
    if (activityRef <= 0) return true;
    return Math.max(0, Date.now() - activityRef) < this._getRunStuckThresholdMs();
  }

  _getPersistedForeignActiveRunIndexEntries(options = {}) {
    const omitRunId = String(options?.omitRunId || "").trim();
    const includeRunId = String(options?.includeRunId || "").trim();
    const managedRunIds = new Set(
      [...this._activeRuns.keys()]
        .map((runId) => String(runId || "").trim())
        .filter(Boolean),
    );
    if (includeRunId && !(omitRunId && includeRunId === omitRunId)) {
      managedRunIds.add(includeRunId);
    }
    const preservedEntries = [];
    for (const candidate of this._readActiveRunsIndex()) {
      const runId = String(candidate?.runId || "").trim();
      if (!runId || runId === omitRunId || managedRunIds.has(runId)) continue;
      const detail = this._readPersistedRunDetail(runId);
      if (detail && !this._shouldPreserveForeignActiveRunDetail(detail)) continue;
      const taskIdentity = this._resolveRunTaskIdentity(candidate, detail);
      const taskId = normalizeWorkflowIdentityText(
        taskIdentity?.taskId || candidate?.taskId || "",
      );
      if (!taskId || !this._getLiveLocalTaskClaim(taskId)) continue;
      preservedEntries.push(cleanObject({
        ...candidate,
        runId,
        workflowId:
          normalizeWorkflowIdentityText(candidate?.workflowId || detail?.data?._workflowId || "")
          || undefined,
        workflowName:
          normalizeWorkflowRunText(candidate?.workflowName || detail?.data?._workflowName || "")
          || undefined,
        startedAt: Number.isFinite(Number(candidate?.startedAt))
          ? Number(candidate.startedAt)
          : (Number.isFinite(Number(detail?.startedAt)) ? Number(detail.startedAt) : Date.now()),
        taskId,
        taskTitle:
          normalizeWorkflowRunText(taskIdentity?.taskTitle || candidate?.taskTitle || "")
          || undefined,
      }));
    }
    return preservedEntries;
  }

  _snapshotActiveRunIndexEntries(options = {}) {
    const omitRunId = String(options?.omitRunId || "").trim();
    const includeRunId = String(options?.includeRunId || "").trim();
    const includeWorkflowId = String(options?.includeWorkflowId || "").trim();
    const includeWorkflowName = String(options?.includeWorkflowName || "").trim();
    const includeCtx = options?.includeCtx || null;
    const entriesByRunId = new Map();
    for (const entry of this._getPersistedForeignActiveRunIndexEntries(options)) {
      entriesByRunId.set(String(entry?.runId || "").trim(), entry);
    }
    for (const [runId, info] of this._activeRuns.entries()) {
      if (omitRunId && runId === omitRunId) continue;
      const workflowId = String(info?.workflowId || "").trim();
      const workflowName = String(info?.workflowName || "").trim();
      const ctx = info?.ctx || null;
      if (!workflowId || !ctx) continue;
      entriesByRunId.set(
        runId,
        buildActiveRunIndexEntry(runId, workflowId, workflowName, ctx),
      );
    }
    if (
      includeRunId &&
      includeWorkflowId &&
      includeCtx &&
      !(omitRunId && includeRunId === omitRunId) &&
      !entriesByRunId.has(includeRunId)
    ) {
      entriesByRunId.set(
        includeRunId,
        buildActiveRunIndexEntry(
          includeRunId,
          includeWorkflowId,
          includeWorkflowName,
          includeCtx,
        ),
      );
    }
    return [...entriesByRunId.values()].sort(
      (left, right) =>
        Number(left?.startedAt || 0) - Number(right?.startedAt || 0) ||
        String(left?.runId || "").localeCompare(String(right?.runId || "")),
    );
  }

  /**
   * Persist a run to the active-runs index AND write an initial detail file.
   * Called at the very start of execute() / retryRun() so the run is on disk
   * before any node executes.
   */
  _syncTaskProjectionFromRunStart(runId, workflowId, workflowName, ctx) {
    if (!this.services?.kanban) return;
    try {
      const data = ctx?.data && typeof ctx.data === "object" ? ctx.data : {};
      const taskId = normalizeWorkflowIdentityText(
        data._workflowTaskId || data.taskId || data.task?.id || data.activeTaskId || "",
      );
      if (!taskId) return;
      const forcePromoteLatest = this._shouldForcePromoteTaskRunOnStart(taskId, runId);
      const startedAtMs = Number(ctx?.startedAt);
      linkTaskWorkflowRun(taskId, {
        runId,
        workflowId,
        workflowName,
        status: WorkflowStatus.RUNNING,
        startedAt: Number.isFinite(startedAtMs)
          ? new Date(startedAtMs).toISOString()
          : null,
        taskId,
        rootRunId: String(data._workflowRootRunId || data._rootRunId || runId || "").trim() || runId,
        parentRunId: String(data._workflowParentRunId || data._parentRunId || "").trim() || null,
        retryOf: String(data._retryOf || "").trim() || null,
        retryMode: String(data._retryMode || "").trim() || null,
        sessionId: String(data._workflowSessionId || data.sessionId || "").trim() || null,
        rootSessionId: String(
          data._workflowRootSessionId || data._workflowSessionId || data.sessionId || "",
        ).trim() || null,
        parentSessionId: String(data._workflowParentSessionId || "").trim() || null,
        rootTaskId: String(
          data._workflowRootTaskId || data.task?.topology?.rootTaskId || taskId || "",
        ).trim() || taskId,
        parentTaskId: String(data._workflowParentTaskId || data.task?.parentTaskId || "").trim() || null,
        delegationDepth: Number.isFinite(Number(data._workflowDelegationDepth))
          ? Math.max(0, Math.trunc(Number(data._workflowDelegationDepth)))
          : 0,
        source: "workflow",
        summary: `Workflow run ${runId} started`,
      }, {
        forcePromoteLatest,
      });
    } catch (err) {
      console.warn(`${TAG} Failed to sync task projection for run ${runId}: ${String(err?.message || err)}`);
    }
  }

  _hasRecentTaskRunLinkEvidence(task, runId) {
    const normalizedRunId = normalizeWorkflowIdentityText(runId || "");
    if (!normalizedRunId) return false;
    const workflowRuns = Array.isArray(task?.workflowRuns) ? task.workflowRuns : [];
    const runLink =
      workflowRuns.find(
        (entry) => normalizeWorkflowIdentityText(entry?.runId || "") === normalizedRunId,
      ) || null;
    const activeEntry =
      this._readActiveRunsIndex().find(
        (entry) => normalizeWorkflowIdentityText(entry?.runId || entry?.id || "") === normalizedRunId,
      ) || null;
    const detail = this._readPersistedRunDetail(normalizedRunId);
    const dagState = detail?.data?._dagState || detail?._dagState || null;
    const status = String(
      runLink?.status || dagState?.status || detail?.status || activeEntry?.status || activeEntry?.outcome || "",
    )
      .trim()
      .toLowerCase();
    if (
      status === WorkflowStatus.COMPLETED
      || status === WorkflowStatus.FAILED
      || status === WorkflowStatus.CANCELLED
      || status === WorkflowStatus.PAUSED
    ) {
      return false;
    }
    const lastActivityMs = Math.max(
      normalizeWorkflowRunTimestampMs(runLink?.startedAt),
      normalizeWorkflowRunTimestampMs(runLink?.endedAt),
      normalizeWorkflowRunTimestampMs(detail?.startedAt),
      normalizeWorkflowRunTimestampMs(detail?.lastProgressAt),
      normalizeWorkflowRunTimestampMs(detail?.updatedAt),
      normalizeWorkflowRunTimestampMs(dagState?.createdAt),
      normalizeWorkflowRunTimestampMs(dagState?.updatedAt),
      normalizeWorkflowRunTimestampMs(dagState?.lastStatusAt),
      normalizeWorkflowRunTimestampMs(activeEntry?.startedAt),
      normalizeWorkflowRunTimestampMs(activeEntry?.updatedAt),
      normalizeWorkflowRunTimestampMs(activeEntry?.lastStatusAt),
    );
    return lastActivityMs > 0 && Date.now() - lastActivityMs <= this._getRunStuckThresholdMs();
  }

  _shouldForcePromoteTaskRunOnStart(taskId, runId) {
    const normalizedTaskId = normalizeWorkflowIdentityText(taskId || "");
    const normalizedRunId = normalizeWorkflowIdentityText(runId || "");
    if (!normalizedTaskId || !normalizedRunId) return false;
    const task = getKanbanTask(normalizedTaskId);
    if (!task || typeof task !== "object") return false;
    const currentLatestRunId = normalizeWorkflowIdentityText(
      task?.topology?.latestRunId || task?.latestRunId || "",
    );
    if (!currentLatestRunId || currentLatestRunId === normalizedRunId) return false;
    return !this._hasRecentTaskRunLinkEvidence(task, currentLatestRunId);
  }

  _syncTaskProjectionFromRunSummary(summary, detail = null) {
    if (!this.services?.kanban || !summary || typeof summary !== "object") return;
    try {
      const runId = normalizeWorkflowIdentityText(summary.runId || "");
      if (!runId) return;
      const taskIdentity = this._resolveRunTaskIdentity(summary, detail);
      const taskId = normalizeWorkflowIdentityText(taskIdentity?.taskId || summary.taskId || "");
      if (!taskId) return;
      const topology =
        summary.delegationTopology && typeof summary.delegationTopology === "object"
          ? summary.delegationTopology
          : {};
      const startedAtMs = Number(summary.startedAt);
      const endedAtMs = Number(summary.endedAt);
      const status = normalizeWorkflowIdentityText(summary.status || "") || null;
      const summaryText =
        normalizeWorkflowRunText(summary.issueAdvisorSummary || "") ||
        `Workflow run ${runId} ${status || "updated"}`;
      linkTaskWorkflowRun(taskId, {
        runId,
        workflowId: normalizeWorkflowIdentityText(summary.workflowId || "") || null,
        workflowName: normalizeWorkflowRunText(summary.workflowName || "") || null,
        status,
        startedAt: Number.isFinite(startedAtMs) ? new Date(startedAtMs).toISOString() : null,
        endedAt: Number.isFinite(endedAtMs) ? new Date(endedAtMs).toISOString() : null,
        summary: summaryText,
        taskId,
        rootRunId: normalizeWorkflowIdentityText(
          summary.rootRunId || topology.rootRunId || runId,
        ) || runId,
        parentRunId: normalizeWorkflowIdentityText(
          summary.parentRunId || topology.parentRunId || "",
        ) || null,
        retryOf: normalizeWorkflowIdentityText(summary.retryOf || "") || null,
        retryMode: normalizeWorkflowIdentityText(summary.retryMode || "") || null,
        sessionId: normalizeWorkflowIdentityText(summary.sessionId || topology.sessionId || "") || null,
        rootSessionId: normalizeWorkflowIdentityText(
          topology.rootSessionId || summary.sessionId || topology.sessionId || "",
        ) || null,
        parentSessionId: normalizeWorkflowIdentityText(topology.parentSessionId || "") || null,
        rootTaskId: normalizeWorkflowIdentityText(topology.rootTaskId || taskId) || taskId,
        parentTaskId: normalizeWorkflowIdentityText(topology.parentTaskId || "") || null,
        delegationDepth: Number.isFinite(Number(topology.delegationDepth))
          ? Math.max(0, Math.trunc(Number(topology.delegationDepth)))
          : 0,
        outcome: normalizeWorkflowIdentityText(summary.resumeResult || status || "") || null,
        source: "workflow",
      });
    } catch (err) {
      console.warn(`${TAG} Failed to sync task projection for summary ${String(summary?.runId || "").trim() || "<unknown>"}: ${String(err?.message || err)}`);
    }
  }

  _persistActiveRunState(runId, workflowId, workflowName, ctx) {
    try {
      this._ensureDirs();

      // Active-runs is derived from the in-memory map plus any foreign
      // task-claimed entries still backed by a live local coordinator.
      this._writeActiveRunsIndex(this._snapshotActiveRunIndexEntries({
        includeRunId: runId,
        includeWorkflowId: workflowId,
        includeWorkflowName: workflowName,
        includeCtx: ctx,
      }));

      // Write initial detail file so we can resume from it
      const detail = this._serializeRunContext(ctx, true);
      this._writeRunDetail(runId, detail);
      this._writeRunDetailToStateLedger(runId, detail);

      // Also ensure the run appears in the main index (with RUNNING status)
      // so that getRunDetail() can find it even before completion.
      this._ensureRunInIndex(runId, workflowId, workflowName, detail);
      this._syncTaskProjectionFromRunStart(runId, workflowId, workflowName, ctx);
    } catch (err) {
      console.error(`${TAG} Failed to persist active run state:`, err.message);
    }
  }

  /**
   * Debounced checkpoint — writes the current run context to disk after each
   * node completes.  Debounced at CHECKPOINT_DEBOUNCE_MS to avoid disk
   * thrashing when many nodes finish in quick succession.
   */
  _checkpointRun(ctx) {
    const runId = ctx.id;
    // Clear any pending timer for this run
    const existing = this._checkpointTimers.get(runId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this._checkpointTimers.delete(runId);
      try {
        // If the run has already been finalized/removed, skip writing a
        // late checkpoint snapshot that could overwrite terminal detail.
        if (!this._activeRuns.has(runId)) return;
        this._ensureDirs();
        const detail = this._serializeRunContext(ctx, true);
        this._writeRunDetail(runId, detail);
        this._writeRunDetailToStateLedger(runId, detail);
      } catch (err) {
        console.error(`${TAG} Checkpoint failed for run ${runId}:`, err.message);
      }
    }, CHECKPOINT_DEBOUNCE_MS);

    // Don't let the timer prevent clean process exit
    if (timer.unref) timer.unref();
    this._checkpointTimers.set(runId, timer);
  }

  /**
   * Remove a run from the active-runs index and clear its checkpoint timer.
   * Called after a run completes (success or failure) so it won't be
   * mistakenly resumed on next boot.
   */
  _clearActiveRunState(runId) {
    try {
      // Clear debounce timer
      const timer = this._checkpointTimers.get(runId);
      if (timer) {
        clearTimeout(timer);
        this._checkpointTimers.delete(runId);
      }
      // Snapshot from the current active map and omit the run being finalized.
      this._writeActiveRunsIndex(this._snapshotActiveRunIndexEntries({ omitRunId: runId }));
    } catch (err) {
      console.error(`${TAG} Failed to clear active run state:`, err.message);
    }
  }

  /**
   * Ensure a run entry exists in the main runs index (index.json).
   * Deduplicates by runId — if the run already exists, updates it in place.
   */
  _ensureRunInIndex(runId, workflowId, workflowName, detail) {
    try {
      const runs = this._readRunIndex();
      const existingIdx = runs.findIndex((r) => r.runId === runId);

      const summary = this._buildSummaryFromDetail({
        runId,
        workflowId,
        workflowName,
        status: WorkflowStatus.RUNNING,
        detail,
      });

      if (existingIdx >= 0) {
        runs[existingIdx] = summary;
      } else {
        runs.push(summary);
      }
      if (runs.length > MAX_PERSISTED_RUNS) runs.splice(0, runs.length - MAX_PERSISTED_RUNS);
      this._writeRunIndex(runs);
    } catch (err) {
      console.error(`${TAG} Failed to ensure run in index:`, err.message);
    }
  }

  /**
   * Detect runs that were interrupted by a previous shutdown.
   * Scans the _active-runs.json index for entries that are NOT in our
   * in-memory _activeRuns map (which is empty on fresh boot). Marks them
   * as PAUSED in the main index and clears the active-runs index.
   */
  _detectInterruptedRuns() {
    try {
      const activeEntries = this._readActiveRunsIndex();
      const interrupted = [];
      const interruptedRunIds = new Set();
      const interruptedTaskIds = new Set();
      const reconcileTaskIds = new Set();
      const preservedActiveRunIds = new Set();
      const now = Date.now();
      const runs = this._readRunIndex();
      const runsById = new Map(
        runs
          .filter((run) => run?.runId)
          .map((run) => [String(run.runId), run]),
      );
      const maxResumableStaleRunsRaw = Number(getRuntimeEnv().WORKFLOW_INTERRUPTED_RESUME_MAX_RUNS);
      const maxResumableStaleRuns = Number.isFinite(maxResumableStaleRunsRaw)
        ? Math.max(1, Math.min(500, Math.floor(maxResumableStaleRunsRaw)))
        : 25;
      let resumableStaleRunsAssigned = 0;

      const markInterrupted = (runId, workflowId = null, workflowName = null, options = {}) => {
        const normalizedRunId = String(runId || "").trim();
        if (!normalizedRunId || interrupted.some((entry) => entry.runId === normalizedRunId)) return;
        let summary = runsById.get(normalizedRunId) || null;
        let detail = null;
        const detailPath = resolve(this.runsDir, `${normalizedRunId}.json`);
        if (existsSync(detailPath)) {
          try {
            detail = JSON.parse(readFileSync(detailPath, "utf8"));
          } catch {
            detail = null;
          }
        }
        if (!summary) {
          if (detail) {
            try {
              summary = this._buildSummaryFromDetail({
                runId: normalizedRunId,
                workflowId: workflowId || detail?.data?._workflowId || null,
                workflowName: workflowName || detail?.data?._workflowName || workflowId || null,
                status: WorkflowStatus.PAUSED,
                detail,
              });
              runs.push(summary);
              runsById.set(normalizedRunId, summary);
            } catch {
              // best-effort hydration only
            }
          }
        }
        const missingConcreteTaskIdentity =
          isConcreteTaskIdentityRequired(summary, detail) &&
          !this._resolveRunTaskIdentity(summary, detail)?.taskId;
        const interruptedTaskId = normalizeWorkflowIdentityText(
          this._resolveRunTaskIdentity(summary, detail)?.taskId || summary?.taskId || "",
        );
        if (interruptedTaskId && this._getLiveLocalTaskClaim(interruptedTaskId)) {
          preservedActiveRunIds.add(normalizedRunId);
          return;
        }
        const wantsResumable = options?.resumable !== false && !missingConcreteTaskIdentity;
        const forceResumable = options?.forceResumable === true && !missingConcreteTaskIdentity;
        const canResume = wantsResumable && (forceResumable || resumableStaleRunsAssigned < maxResumableStaleRuns);
        if (summary) {
          summary.status = WorkflowStatus.PAUSED;
          summary.resumable = canResume;
          summary.interruptedAt = now;
          summary.activeNodeCount = 0;
          if (!Number.isFinite(Number(summary.endedAt))) {
            summary.endedAt = now;
          }
          if (!canResume) {
            summary.resumeResult = missingConcreteTaskIdentity
              ? "invalid_task_identity"
              : "recovery_cap_exceeded";
          }
          if (interruptedTaskId) {
            interruptedTaskIds.add(interruptedTaskId);
            reconcileTaskIds.add(interruptedTaskId);
          }
          this._syncTaskProjectionFromRunSummary(summary, detail);
        }
        if (canResume && !forceResumable) resumableStaleRunsAssigned += 1;
        interrupted.push({
          runId: normalizedRunId,
          workflowId: workflowId || summary?.workflowId || null,
          workflowName: workflowName || summary?.workflowName || null,
        });
        interruptedRunIds.add(normalizedRunId);
      };

      // Primary source: persisted active-runs index from the previous process.
      for (const entry of activeEntries) {
        const runId = String(entry?.runId || "").trim();
        if (!runId || this._activeRuns.has(runId)) continue;
        markInterrupted(runId, entry.workflowId, entry.workflowName, { forceResumable: true });
      }

      // Secondary source: index entries still marked RUNNING with no active execution.
      for (const run of runs) {
        const runId = String(run?.runId || "").trim();
        if (!runId) continue;
        if (run.status !== WorkflowStatus.RUNNING) continue;
        if (this._activeRuns.has(runId)) continue;
        markInterrupted(runId, run.workflowId, run.workflowName);
      }

      // Existing paused+resumable index rows were already interrupted before
      // this process booted. Keep them in the startup cohort so delayed
      // recovery still sees older stranded task runs after a restart.
      for (const run of runs) {
        const runId = String(run?.runId || "").trim();
        if (!runId) continue;
        if (run.status !== WorkflowStatus.PAUSED || !run.resumable) continue;
        markInterrupted(runId, run.workflowId, run.workflowName, { forceResumable: true });
      }

      // Tertiary source: orphan detail files with no index entry and no end marker.
      // This is bounded to a recent subset so old archived run details cannot
      // stall startup when workflow-runs contains thousands of historical files.
      const orphanCandidates = this._getInterruptedOrphanRunCandidates();
      for (const candidate of orphanCandidates) {
        const runId = basename(candidate.file, ".json");
        if (!runId || this._activeRuns.has(runId) || runsById.has(runId)) continue;
        try {
          const detail = JSON.parse(readFileSync(candidate.detailPath, "utf8"));
          const hasRunningNode = Object.values(detail?.nodeStatuses || {}).some(
            (status) => status === NodeStatus.RUNNING || status === NodeStatus.WAITING,
          );
          if (detail?.endedAt != null && !hasRunningNode) continue;
          markInterrupted(
            runId,
            detail?.data?._workflowId || null,
            detail?.data?._workflowName || null,
          );
        } catch {
          // ignore malformed detail files
        }
      }

      if (this.services?.kanban) {
        const resumableRepairResults = new Set([
          "duplicate_task_run",
          "covered_by_root_interrupted_run",
          "resumed",
        ]);
        for (const run of runs) {
          const taskId = normalizeWorkflowIdentityText(run?.taskId || "");
          if (!taskId) continue;
          const status = normalizeWorkflowIdentityText(run?.status || "");
          const resumeResult = normalizeWorkflowRunText(run?.resumeResult).trim().toLowerCase();
          if (
            interruptedTaskIds.has(taskId) ||
            status === WorkflowStatus.RUNNING ||
            (
              status === WorkflowStatus.PAUSED &&
              (run?.resumable === true || resumableRepairResults.has(resumeResult))
            )
          ) {
            reconcileTaskIds.add(taskId);
          }
        }
      }

      if (interrupted.length > 0) {
        if (runs.length > MAX_PERSISTED_RUNS) runs.splice(0, runs.length - MAX_PERSISTED_RUNS);
        this._writeRunIndex(runs);
      }

      if (this.services?.kanban && reconcileTaskIds.size > 0) {
        const taskScopedRuns = runs
          .filter((run) => reconcileTaskIds.has(normalizeWorkflowIdentityText(run?.taskId || "")))
          .sort(
            (left, right) =>
              Number(left?.startedAt || 0) - Number(right?.startedAt || 0) ||
              String(left?.runId || "").localeCompare(String(right?.runId || "")),
          );
        for (const run of taskScopedRuns) {
          this._syncTaskProjectionFromRunSummary(run);
        }
      }

      const preservedActiveEntries = activeEntries.filter((entry) => {
        const runId = String(entry?.runId || "").trim();
        return runId && preservedActiveRunIds.has(runId);
      });
      this._writeActiveRunsIndex(preservedActiveEntries);

      if (interrupted.length > 0) {
        const sample = interrupted.slice(0, 20).map((entry) => entry.runId).join(", ");
        const suffix = interrupted.length > 20 ? ", ..." : "";
        console.log(
          `${TAG} Detected ${interrupted.length} interrupted run(s): ${sample}${suffix}`,
        );
        this.emit("runs:interrupted", { runs: interrupted });
      }
      this._startupInterruptedRunIds = interruptedRunIds.size > 0 ? interruptedRunIds : null;
    } catch (err) {
      this._startupInterruptedRunIds = null;
      console.error(`${TAG} Failed to detect interrupted runs:`, err.message);
    }
  }

  /**
   * Resume all interrupted (PAUSED + resumable) runs, plus failed task-scoped
   * descendants that became stranded after a previously resumed ancestor run
   * failed and no paused resumable representative remains.
   *
   * Should be called AFTER services are wired up (e.g. after workflow
   * engine is fully initialized with node executors).
   */
  async resumeInterruptedRuns() {
    if (this._resumingRuns) return;
    if (!this.detectInterruptedRuns) return;
    this._resumingRuns = true;

    try {
      const allRuns = this._readRunIndex();
      const startupInterruptedRunIds =
        this._startupInterruptedRunIds instanceof Set && this._startupInterruptedRunIds.size > 0
          ? new Set(this._startupInterruptedRunIds)
          : null;
      const pausedResumableRuns = allRuns.filter(
        (r) => r.status === WorkflowStatus.PAUSED && r.resumable,
      );
      const pausedResumableRunsById = new Map(
        pausedResumableRuns
          .map((run) => {
            const runId = String(run?.runId || "").trim();
            return runId ? [runId, run] : null;
          })
          .filter(Boolean),
      );
      const latestInterruptedAt = startupInterruptedRunIds
        ? 0
        : pausedResumableRuns.reduce((latest, run) => {
          const interruptedAt = Number(run?.interruptedAt || 0);
          return interruptedAt > latest ? interruptedAt : latest;
        }, 0);
      const latestInterruptedCohortWindowMs = 250;
      const startupInterruptedRuns = startupInterruptedRunIds
        ? Array.from(startupInterruptedRunIds)
            .map((runId) => pausedResumableRunsById.get(String(runId || "").trim()) || null)
            .filter(Boolean)
        : [];
      const startupInterruptedRunIdSet = new Set(
        startupInterruptedRuns
          .map((run) => String(run?.runId || "").trim())
          .filter(Boolean),
      );
        const runs = startupInterruptedRunIds
          ? [
              // Keep the current startup cohort first, but still drain older
              // paused resumable runs so unrelated tasks do not stay stranded.
              ...startupInterruptedRuns,
              ...pausedResumableRuns.filter((run) => {
                const runId = String(run?.runId || "").trim();
                return !runId || !startupInterruptedRunIdSet.has(runId);
              }),
            ]
          : pausedResumableRuns.filter((run) => {
              if (latestInterruptedAt > 0) {
                const interruptedAt = Number(run?.interruptedAt || 0);
                return interruptedAt >= (latestInterruptedAt - latestInterruptedCohortWindowMs);
              }
              return true;
            });

      // ── Deduplicate by taskId: keep only the most recent run per task ────
      // After N crash/restart cycles, N run entries accumulate for the same
      // taskId. Resuming all of them causes competing workflow runs that race
      // to claim the task → "claim was stolen" errors on every restart.
      // Solution: pre-scan detail files, keep latest startedAt per taskId,
      // and mark older duplicates as not-resumable before we even try them.
      //
      // MEMORY: Run-detail JSON files can grow to >100 MB (logs,
      // nodeOutputs, replayTrajectory). Caching parsed details for every
      // paused+resumable run has historically OOM'd the engine on monitor
      // restart (V8 4 GB heap exhausted). Use the lightweight identity
      // reader for the dedup scan and only parse full details for the
      // small set of runs we actually resume.
      const identityCache = new Map(); // runId → small identity object
      const allRunsById = new Map(
        allRuns
          .map((run) => {
            const runId = String(run?.runId || "").trim();
            return runId ? [runId, run] : null;
          })
          .filter(Boolean),
      );
      const latestByTaskId = new Map(); // taskId → representative interrupted/root task run
      const resolveRunStartedAtMs = (candidate) => {
        const rawStartedAt = candidate?.startedAt;
        const numericStartedAt = Number(rawStartedAt);
        if (Number.isFinite(numericStartedAt) && numericStartedAt > 0) {
          return numericStartedAt;
        }
        const parsedStartedAt = Date.parse(String(rawStartedAt || ""));
        return Number.isFinite(parsedStartedAt) && parsedStartedAt > 0 ? parsedStartedAt : 0;
      };
      const getIdentity = (runId) => {
        if (identityCache.has(runId)) return identityCache.get(runId);
        const ident = this._readRunDetailIdentity(runId);
        identityCache.set(runId, ident || null);
        return ident || null;
      };
      const resolveTaskIdentity = (run, ident = null) => {
        if (!run) return "";
        const indexedTaskId = resolveIndexedRunTaskIdentity(run);
        if (indexedTaskId) return indexedTaskId;
        const resolvedIdentity = ident ?? getIdentity(run.runId);
        return this._resolveRunTaskIdentity(run, resolvedIdentity)?.taskId || "";
      };
      const promotableResumeResults = new Set([
        "covered_by_root_interrupted_run",
        "duplicate_task_run",
      ]);
      const resumedAncestorResumeResults = new Set([
        "resumed",
      ]);
      const resumeTraceTaskIds = getWorkflowResumeTraceTaskIds();
      const hasRepresentativeActivitySignal = (candidate) =>
        Number(candidate?.activeNodeCount || 0) > 0;
      const canPromoteRepresentativeRun = (candidate) =>
        String(candidate?.status || "").trim() === WorkflowStatus.PAUSED &&
        promotableResumeResults.has(String(candidate?.resumeResult || "").trim()) &&
        hasRepresentativeActivitySignal(candidate);
      const hasResumedPausedAncestor = (candidate, taskId) => {
        const candidateRunId = String(candidate?.runId || "").trim();
        if (!candidateRunId || !taskId) return false;
        let currentRunId = normalizeWorkflowIdentityText(
          candidate?.parentRunId ||
          candidate?.retryOf ||
          "",
        );
        const visited = new Set([candidateRunId]);
        while (currentRunId && !visited.has(currentRunId)) {
          visited.add(currentRunId);
          const ancestor = allRunsById.get(currentRunId);
          if (!ancestor) break;
          const ancestorIdentity = getIdentity(currentRunId);
          const ancestorTaskId = resolveTaskIdentity(ancestor, ancestorIdentity);
          if (!ancestorTaskId || ancestorTaskId !== taskId) break;
          if (
            String(ancestor?.status || "").trim() === WorkflowStatus.PAUSED &&
            resumedAncestorResumeResults.has(String(ancestor?.resumeResult || "").trim())
          ) {
            return true;
          }
          currentRunId = normalizeWorkflowIdentityText(
            ancestor?.parentRunId ||
            ancestorIdentity?.data?._workflowParentRunId ||
            ancestorIdentity?.dagState?.parentRunId ||
            ancestor?.retryOf ||
            "",
          );
        }
        return false;
      };
      const canQueueStrandedFailedRepresentative = (candidate, taskId) =>
        String(candidate?.status || "").trim() === WorkflowStatus.FAILED &&
        hasResumedPausedAncestor(candidate, taskId);
      const canParticipateInResumeSelection = (candidate) => {
        const status = String(candidate?.status || "").trim();
        if (status === WorkflowStatus.RUNNING) return true;
        if (status !== WorkflowStatus.PAUSED) return false;
        return Boolean(candidate?.resumable) || canPromoteRepresentativeRun(candidate);
      };
      const resolveRepresentativeTaskRun = (run, taskId, ident = null) => {
        let representative = run;
        let representativeIdentity = ident ?? getIdentity(run?.runId);
        let selectedRepresentative = canParticipateInResumeSelection(representative)
          ? representative
          : null;
        const traceChain = [];
        const visited = new Set();
        while (representative) {
          const representativeRunId = String(representative?.runId || "").trim();
          if (!representativeRunId || visited.has(representativeRunId)) break;
          visited.add(representativeRunId);
          if (resumeTraceTaskIds?.has(taskId)) {
            traceChain.push(cleanObject({
              runId: representativeRunId,
              workflowName: representative?.workflowName || undefined,
              status: representative?.status || undefined,
              resumable: representative?.resumable,
              resumeResult: representative?.resumeResult || undefined,
              taskId,
              startedAt: representative?.startedAt || undefined,
              parentRunId:
                representative?.parentRunId ||
                representativeIdentity?.data?._workflowParentRunId ||
                representativeIdentity?.dagState?.parentRunId ||
                undefined,
            }));
          }
          const parentRunId = normalizeWorkflowIdentityText(
            representative?.parentRunId ||
            representativeIdentity?.data?._workflowParentRunId ||
            representativeIdentity?.dagState?.parentRunId ||
            "",
          );
          if (!parentRunId) break;
          const parentRun = allRunsById.get(parentRunId);
          if (!parentRun) break;
          const parentTaskId = resolveTaskIdentity(parentRun);
          if (!parentTaskId || parentTaskId !== taskId) break;
          const parentStatus = String(parentRun?.status || "").trim();
          const sameWorkflowFamily =
            normalizeWorkflowIdentityText(parentRun?.workflowId || "") ===
            normalizeWorkflowIdentityText(representative?.workflowId || "");
          representative = parentRun;
          representativeIdentity = getIdentity(parentRunId);
          if (parentStatus !== WorkflowStatus.RUNNING && parentStatus !== WorkflowStatus.PAUSED) break;
          if (
            canParticipateInResumeSelection(parentRun) &&
            (parentStatus === WorkflowStatus.RUNNING || hasRepresentativeActivitySignal(parentRun)) &&
            (!sameWorkflowFamily || !selectedRepresentative)
          ) {
            selectedRepresentative = parentRun;
          }
        }
        if (resumeTraceTaskIds?.has(taskId)) {
          console.log(
            `${TAG} Resume trace task ${taskId}: source=${String(run?.runId || "").trim() || "<unknown>"} ` +
            `selected=${String(selectedRepresentative?.runId || run?.runId || "").trim() || "<unknown>"} ` +
            `chain=${JSON.stringify(traceChain)}`,
          );
        }
        return selectedRepresentative || run;
      };

      let resumeLoopCount = 0;
      for (const run of allRuns) {
        const ident = run?.status === WorkflowStatus.RUNNING ? getIdentity(run.runId) : null;
        const tid = resolveTaskIdentity(run, ident);
        if (!tid) continue;
        const representative = resolveRepresentativeTaskRun(run, tid, ident);
        const prev = latestByTaskId.get(tid);
        if (!prev || resolveRunStartedAtMs(representative) >= resolveRunStartedAtMs(prev)) {
          latestByTaskId.set(tid, representative);
        }
        resumeLoopCount += 1;
        await maybeYieldInterruptedResumeWork(resumeLoopCount);
      }

      for (const run of runs) {
        const ident = getIdentity(run.runId);
        const tid = resolveTaskIdentity(run, ident);
        if (tid) {
          const representative = resolveRepresentativeTaskRun(run, tid, ident);
          const prev = latestByTaskId.get(tid);
          if (!prev || resolveRunStartedAtMs(representative) >= resolveRunStartedAtMs(prev)) {
            latestByTaskId.set(tid, representative);
          }
        }
        resumeLoopCount += 1;
        await maybeYieldInterruptedResumeWork(resumeLoopCount);
      }

      let promotedAncestorCount = 0;
      let promotedAncestorIndexDirty = false;
      const promotedRunIds = new Set();
      const promoteRepresentativeRun = (representative, sourceRun = null) => {
        const representativeRunId = String(representative?.runId || "").trim();
        if (!representativeRunId || promotedRunIds.has(representativeRunId)) return;
        if (!canPromoteRepresentativeRun(representative) || representative?.resumable) return;
        representative.resumable = true;
        delete representative.resumeResult;
        if (!Number.isFinite(Number(representative?.interruptedAt))) {
          const fallbackInterruptedAt = Number(sourceRun?.interruptedAt || Date.now());
          representative.interruptedAt = Number.isFinite(fallbackInterruptedAt)
            ? fallbackInterruptedAt
            : Date.now();
        }
        if (!pausedResumableRunsById.has(representativeRunId)) {
          pausedResumableRunsById.set(representativeRunId, representative);
          pausedResumableRuns.push(representative);
        }
        if (!runs.some((entry) => String(entry?.runId || "").trim() === representativeRunId)) {
          runs.unshift(representative);
        }
        if (this._startupInterruptedRunIds instanceof Set) {
          this._startupInterruptedRunIds.add(representativeRunId);
        }
        promotedRunIds.add(representativeRunId);
        promotedAncestorCount += 1;
        promotedAncestorIndexDirty = true;
      };

      for (const run of [...runs]) {
        const tid = resolveTaskIdentity(run);
        if (!tid) continue;
        const representative = latestByTaskId.get(tid);
        if (!representative) continue;
        promoteRepresentativeRun(representative, run);
      }

      const queuedFailedRepresentativeRunIds = new Set();
      for (const [taskId, representative] of latestByTaskId.entries()) {
        if (!canQueueStrandedFailedRepresentative(representative, taskId)) continue;
        const representativeRunId = String(representative?.runId || "").trim();
        if (!representativeRunId) continue;
        if (runs.some((entry) => String(entry?.runId || "").trim() === representativeRunId)) continue;
        runs.unshift(representative);
        if (this._startupInterruptedRunIds instanceof Set) {
          this._startupInterruptedRunIds.add(representativeRunId);
        }
        queuedFailedRepresentativeRunIds.add(representativeRunId);
      }

      if (promotedAncestorIndexDirty) {
        this._writeRunIndex(allRuns);
        console.log(
          `${TAG} Re-activated ${promotedAncestorCount} interrupted ancestor run(s) from duplicate descendants`,
        );
      }
      if (queuedFailedRepresentativeRunIds.size > 0) {
        console.log(
          `${TAG} Queued ${queuedFailedRepresentativeRunIds.size} stranded failed task run(s) ` +
          `after resumed ancestors failed`,
        );
      }
      if (!runs.length) {
        if (startupInterruptedRunIds) this._startupInterruptedRunIds = null;
        this._resumingRuns = false;
        return;
      }
      console.log(`${TAG} Resuming ${runs.length} interrupted run(s)...`);
      if (resumeTraceTaskIds?.size > 0) {
        for (const [taskId, representative] of latestByTaskId.entries()) {
          if (!resumeTraceTaskIds.has(taskId)) continue;
          console.log(
            `${TAG} Resume trace winner task ${taskId}: ` +
            `${JSON.stringify(cleanObject({
              runId: representative?.runId || undefined,
              workflowName: representative?.workflowName || undefined,
              status: representative?.status || undefined,
              resumable: representative?.resumable,
              resumeResult: representative?.resumeResult || undefined,
              startedAt: representative?.startedAt || undefined,
              parentRunId: representative?.parentRunId || undefined,
              rootRunId: representative?.rootRunId || undefined,
            }))}`,
          );
        }
      }

      // Mark older duplicate runs as not-resumable before entering the loop.
      // This must consider the full paused+resumable set so historical siblings
      // outside the current startup cohort are still retired when a newer run wins.
      let dedupedCount = 0;
      for (const run of pausedResumableRuns) {
        const ident = identityCache.get(run.runId) ?? getIdentity(run.runId);
        const tid = this._resolveRunTaskIdentity(run, ident)?.taskId || "";
        if (!tid) continue;
        const latest = latestByTaskId.get(tid);
        if (latest && latest.runId !== run.runId) {
          this._markRunUnresumable(run.runId, "duplicate_task_run");
          dedupedCount++;
        }
        resumeLoopCount += 1;
        await maybeYieldInterruptedResumeWork(resumeLoopCount);
      }
      if (dedupedCount > 0) {
        console.log(
          `${TAG} Skipped ${dedupedCount} duplicate interrupted run(s) (kept latest per taskId)`,
        );
      }

      // If an interrupted root workflow run is being resumed, do not also
      // resume its paused descendants from the same startup cohort. The root
      // resume will recreate or continue that family, and resuming both sides
      // can duplicate work and amplify startup memory pressure.
      const selectedRunIds = new Set(runs.map((run) => String(run?.runId || "").trim()).filter(Boolean));
      let familyDedupedCount = 0;
      for (const run of runs) {
        const ident = identityCache.get(run.runId) ?? getIdentity(run.runId);
        const rootRunId = normalizeWorkflowIdentityText(
          ident?.dagState?.rootRunId ||
          ident?.data?._workflowRootRunId ||
          run?.rootRunId ||
          "",
        );
        if (!rootRunId || rootRunId === String(run.runId || "").trim()) continue;
        if (!selectedRunIds.has(rootRunId)) continue;
        this._markRunUnresumable(run.runId, "covered_by_root_interrupted_run");
        familyDedupedCount += 1;
      }
      if (familyDedupedCount > 0) {
        console.log(
          `${TAG} Skipped ${familyDedupedCount} interrupted descendant run(s) covered by a root resume`,
        );
      }

      // Identity scan complete — release the small identity cache before the
      // resume loop loads full details for the (small) winning set.
      identityCache.clear();
      const runDetailCache = new Map(); // runId → fully parsed detail (only for resumed runs)
      const pendingResumes = [];

      for (const run of runs) {
        // Skip runs that were marked as duplicates above (cheap identity recheck)
        const _ident = this._readRunDetailIdentity(run.runId);
        const _rootRunId = normalizeWorkflowIdentityText(
          _ident?.dagState?.rootRunId ||
          _ident?.data?._workflowRootRunId ||
          run?.rootRunId ||
          "",
        );
        if (_rootRunId && _rootRunId !== String(run.runId || "").trim() && selectedRunIds.has(_rootRunId)) {
          continue;
        }
        if (isTasklessScheduledResumeRun(run, _ident)) {
          this._markRunUnresumable(run.runId, "scheduled_non_task_run");
          continue;
        }
        if (isConcreteTaskIdentityRequired(run, _ident) && !this._resolveRunTaskIdentity(run, _ident)?.taskId) {
          this._markRunUnresumable(run.runId, "invalid_task_identity");
          continue;
        }
        const _tid = this._resolveRunTaskIdentity(run, _ident)?.taskId || "";
        if (_tid) {
          const latest = latestByTaskId.get(_tid);
          if (latest && latest.runId !== run.runId) continue;
        }

        try {
          // Check if the workflow definition still exists
          const def = this.get(run.workflowId);
          if (!def) {
            console.warn(`${TAG} Cannot resume run ${run.runId}: workflow "${run.workflowId}" no longer exists`);
            this._markRunUnresumable(run.runId, "workflow_deleted");
            continue;
          }

          // Load the persisted detail file to get the context state
          const detailPath = resolve(this.runsDir, `${run.runId}.json`);
          if (!existsSync(detailPath)) {
            console.warn(`${TAG} Cannot resume run ${run.runId}: no detail file found`);
            this._markRunUnresumable(run.runId, "no_detail_file");
            continue;
          }

          // Reuse cached detail if available (already parsed above)
          const detail = runDetailCache.get(run.runId) ?? JSON.parse(readFileSync(detailPath, "utf8"));
          const resumedTaskId = this._resolveRunTaskIdentity(run, detail)?.taskId || "";
          if (resumedTaskId) {
            const taskAlreadyActive = Array.from(this._activeRuns.values()).some((info) => {
              const activeTaskId = normalizeWorkflowIdentityText(
                info?.ctx?.data?.taskId || info?.ctx?.data?.task?.id || "",
              );
              return activeTaskId === resumedTaskId;
            });
            if (taskAlreadyActive) {
              this._markRunUnresumable(run.runId, "task_already_active");
              continue;
            }
            if (typeof this.services?.kanban?.getTask === "function") {
              const currentTask = await Promise.resolve(
                this.services.kanban.getTask(resumedTaskId),
              ).catch(() => null);
              if (currentTask && isWorkflowTaskTerminal(currentTask)) {
                const terminalStatus = normalizeWorkflowTaskStatus(currentTask) || "done";
                const message =
                  `Task "${resumedTaskId}" is already ${terminalStatus}; interrupted run resume is not allowed for terminal tasks`;
                console.warn(`${TAG} Skipping run ${run.runId}: ${message}`);
                this._markRunUnresumable(run.runId, "terminal_task_status", message);
                continue;
              }
            }
          }
          const watchdogDecision = buildDelegationWatchdogDecision(detail, {
            defaultTimeoutMs: DEFAULT_DELEGATION_WATCHDOG_TIMEOUT_MS,
            defaultMaxRecoveries: DEFAULT_DELEGATION_WATCHDOG_MAX_RECOVERIES,
            minTimeoutMs: NODE_TIMEOUT_MIN_MS,
            maxTimeoutMs: NODE_TIMEOUT_MAX_MS,
          });
          if (watchdogDecision?.type === "exhausted") {
            console.warn(`${TAG} Skipping run ${run.runId}: ${watchdogDecision.reason}`);
            this._markRunUnresumable(run.runId, watchdogDecision.reason);
            continue;
          }

          const forceTaskRestart = await this._shouldResumeTaskScopedRunFromScratch(run, detail, def);
          const retryDecision = forceTaskRestart
            ? {
                mode: "from_scratch",
                reason: "task_claim_missing_on_resume",
              }
            : (watchdogDecision || this._chooseRetryModeFromDetail(detail, {
                fallbackMode: "from_scratch",
              }));
          const detailedRun = this.getRunDetail(run.runId) || run;
          const createTasksGuard = this._resolvePendingCreateTasksGuard(detailedRun, def);
          if (createTasksGuard && !createTasksGuard.safeResume) {
            console.warn(`${TAG} Skipping run ${run.runId}: ${createTasksGuard.resumeBlockedMessage}`);
            this._noteRunResumeResult(
              run.runId,
              "create_tasks_pending_guard",
              createTasksGuard.resumeBlockedMessage,
            );
            continue;
          }

          console.log(
            `${TAG} Resuming run ${run.runId} via retryRun(${retryDecision.mode}) ` +
            `[${retryDecision.reason}]...`,
          );
          pendingResumes.push(
            this.retryRun(run.runId, {
              mode: retryDecision.mode,
              _decisionReason: retryDecision.reason,
              _resumeInterrupted: true,
            })
              .then(() => {
                // Mark the original interrupted run as no longer resumable
                // (the retry/re-execute created a new run)
                this._markRunUnresumable(run.runId, "resumed");
              })
              .catch((err) => {
                console.error(`${TAG} Failed to resume run ${run.runId}:`, err.message);
                this._markRunUnresumable(run.runId, `retry_error: ${err.message}`);
              }),
          );
        } catch (err) {
          console.error(`${TAG} Error resuming run ${run.runId}:`, err.message);
          this._markRunUnresumable(run.runId, `error: ${err.message}`);
        }
        resumeLoopCount += 1;
        await maybeYieldInterruptedResumeWork(resumeLoopCount);
      }

      if (pendingResumes.length > 0) {
        await Promise.allSettled(pendingResumes);
      }
    } finally {
      this._resumingRuns = false;
    }
  }

  _resolveRunTaskIdentity(runSummary, detail = null) {
    const detailTaskId = normalizeWorkflowIdentityText(
      detail?.data?.taskId || detail?.inputData?.taskId || detail?.taskId || "",
    );
    if (detailTaskId) {
      return {
        taskId: detailTaskId,
        taskTitle: normalizeWorkflowIdentityText(
          detail?.data?.taskTitle || detail?.inputData?.taskTitle || "",
        ) || null,
        source: "detail",
      };
    }
    const topologyTaskId = normalizeWorkflowIdentityText(
      detail?.delegationTopology?.taskId ||
        detail?.data?._delegationTopology?.taskId ||
        "",
    );
    if (topologyTaskId) {
      return {
        taskId: topologyTaskId,
        taskTitle: normalizeWorkflowIdentityText(
          detail?.taskTitle || detail?.data?.taskTitle || "",
        ) || null,
        source: "topology",
      };
    }
    const summaryTaskId = normalizeWorkflowIdentityText(runSummary?.taskId || "");
    if (summaryTaskId) {
      return {
        taskId: summaryTaskId,
        taskTitle: normalizeWorkflowIdentityText(runSummary?.taskTitle || "") || null,
        source: "summary",
      };
    }
    const ledgerIdentity = this._executionLedger.getTaskIdentity(runSummary?.runId || detail?.id || "");
    const ledgerTaskId = normalizeWorkflowIdentityText(ledgerIdentity?.taskId || "");
    if (ledgerTaskId) {
      return {
        ...ledgerIdentity,
        taskId: ledgerTaskId,
        taskTitle: normalizeWorkflowIdentityText(ledgerIdentity?.taskTitle || "") || null,
      };
    }
    return null;
  }

  /**
   * Mark a run as no longer resumable in the main index.
   */
  _markRunUnresumable(runId, reason, message = null) {
    try {
      const runs = this._readRunIndex();
      const idx = runs.findIndex((r) => r.runId === runId);
      if (idx >= 0) {
        runs[idx].resumable = false;
        runs[idx].resumeResult = reason;
        if (message) runs[idx].resumeResultMessage = message;
        else delete runs[idx].resumeResultMessage;
        this._writeRunIndex(runs);
        this._syncTaskProjectionFromRunSummary(runs[idx]);
      }
      if (this._startupInterruptedRunIds instanceof Set) {
        this._startupInterruptedRunIds.delete(String(runId || "").trim());
        if (this._startupInterruptedRunIds.size === 0) {
          this._startupInterruptedRunIds = null;
        }
      }
    } catch (err) {
      console.error(`${TAG} Failed to mark run unresumable:`, err.message);
    }
  }

  _noteRunResumeResult(runId, reason, message = null) {
    try {
      const runs = this._readRunIndex();
      const idx = runs.findIndex((r) => r.runId === runId);
      if (idx >= 0) {
        runs[idx].resumeResult = reason;
        if (message) runs[idx].resumeResultMessage = message;
        else delete runs[idx].resumeResultMessage;
        this._writeRunIndex(runs);
        this._syncTaskProjectionFromRunSummary(runs[idx]);
      }
    } catch (err) {
      console.error(`${TAG} Failed to note run resume result:`, err.message);
    }
  }

  // ── Persist completed run ─────────────────────────────────────────────

  _persistRun(runId, workflowId, ctx) {
    try {
      this._ensureDirs();
      const workflow = this.get(workflowId);
      const workflowName = workflow?.name || ctx.data?._workflowName || workflowId;
      const detail = this._serializeRunContext(ctx, false);
      const identityValidation =
        detail?.identityValidation ||
        detail?.data?._workflowIdentityValidation ||
        null;
      if (identityValidation?.code === "invalid_task_identity") {
        const message = String(
          identityValidation.message ||
          "workflow run identity validation failed",
        ).trim();
        detail.errors = Array.isArray(detail.errors) ? [...detail.errors] : [];
        const alreadyRecorded = detail.errors.some(
          (entry) => String(entry?.message || "").trim() === message,
        );
        if (!alreadyRecorded) {
          detail.errors.push({
            nodeId: null,
            message,
            category: "validation",
            code: "invalid_task_identity",
            timestamp: Date.now(),
          });
        }
        console.warn(`${TAG} ${message} [runId=${runId}]`);
      }
      const summary = this._buildSummaryFromDetail({
        runId,
        workflowId,
        workflowName,
        status: identityValidation?.code === "invalid_task_identity"
          ? WorkflowStatus.FAILED
          : this._resolveWorkflowStatus(ctx),
        detail,
      });
      if (identityValidation?.code === "invalid_task_identity") {
        summary.invalidTaskIdentity = true;
        summary.identityValidation = identityValidation;
        summary.resumable = false;
        summary.resumeResult = "invalid_task_identity";
      }

      // Deduplicate: remove any existing entry for this runId before appending
      let runs = this._readRunIndex().filter((r) => r.runId !== runId);
      runs.push(summary);
      // Keep last N runs
      if (runs.length > MAX_PERSISTED_RUNS) runs = runs.slice(-MAX_PERSISTED_RUNS);
      this._writeRunIndex(runs);
      clearRunHistoryCache();
      this._syncTaskProjectionFromRunSummary(summary, detail);

      // Save full run detail
      this._writeRunDetail(runId, detail);
      this._writeRunDetailToStateLedger(runId, detail);
      this.emit("run:complete", {
        runId,
        workflowId,
        workflowName,
        status: summary.status,
        summary,
      });
    } catch (err) {
      console.error(`${TAG} Failed to persist run log:`, err.message);
    }
  }

  _writeRunDetail(runId, detail) {
    const detailPath = resolve(this.runsDir, `${runId}.json`);
    const trimmed = this._trimOversizedRunDetail(detail);
    writeJsonFileAtomically(detailPath, trimmed);
  }

  /**
   * Defensively trim a run-detail object so a single file cannot grow past
   * a hard ceiling (default 10 MB). Long-running agent workflows can
   * accumulate tens of MB of `logs`, `nodeOutputs[*].logs`, and
   * `replayTrajectory.steps`; thousands of such files have OOM'd the
   * monitor on restart (V8 heap >4 GB during interrupted-run dedup).
   *
   * Trimming preserves the most recent entries (which are most useful for
   * debugging the failure) and adds a `_truncated` marker so downstream
   * tooling can show the trim happened.
   */
  _trimOversizedRunDetail(detail) {
    const HARD_LIMIT_BYTES = 10 * 1024 * 1024; // 10 MB serialized
    if (!detail || typeof detail !== "object") return detail;

    const serializeDetail = (value) => {
      try {
        return JSON.stringify(value);
      } catch {
        return null;
      }
    };
    const withTruncationNotes = (value, notes, originalBytes = null) => {
      if (!value || typeof value !== "object" || !Array.isArray(notes) || notes.length === 0) return value;
      const existingTruncation =
        value._truncated && typeof value._truncated === "object" ? value._truncated : {};
      const existingNotes = Array.isArray(existingTruncation.notes)
        ? existingTruncation.notes.filter((note) => typeof note === "string" && note.trim())
        : [];
      return {
        ...value,
        _truncated: {
          at: new Date().toISOString(),
          originalBytes: Number.isFinite(Number(originalBytes))
            ? Number(originalBytes)
            : (
                Number.isFinite(Number(existingTruncation.originalBytes))
                  ? Number(existingTruncation.originalBytes)
                  : null
              ),
          notes: [...new Set([...existingNotes, ...notes])],
        },
      };
    };

    let serialized = serializeDetail(detail);
    if (!serialized) {
      const compacted = repairWorkflowRunDetail(compactPersistedRunDetail(detail));
      const compactedSerialized = serializeDetail(compacted);
      if (compactedSerialized) {
        if (compactedSerialized.length <= HARD_LIMIT_BYTES) {
          return withTruncationNotes(compacted, ["detail: compacted after serialization failure"]);
        }
        serialized = compactedSerialized;
      } else {
        return withTruncationNotes(
          repairWorkflowRunDetail({
            id: detail.id ?? null,
            startedAt: detail.startedAt ?? null,
            endedAt: detail.endedAt ?? null,
            duration: detail.duration ?? null,
            status: detail.status ?? null,
            nodeStatuses: summarizePersistedWorkflowValue(detail.nodeStatuses, {
              key: "nodeStatuses",
            }),
            data: preservePersistedRunIdentityData(detail.data, {}),
            errors: summarizePersistedWorkflowValue(detail.errors, { key: "errors" }),
            issueAdvisor: summarizePersistedWorkflowValue(detail.issueAdvisor, {
              key: "issueAdvisor",
            }),
          }),
          ["detail: fell back to minimal summary after serialization failure"],
        );
      }
    }
    if (!serialized || serialized.length <= HARD_LIMIT_BYTES) return detail;

    let trimmed = repairWorkflowRunDetail(compactPersistedRunDetail(detail));
    let trimmingNotes = [];
    let recheck = serializeDetail(trimmed);
    if (recheck && recheck.length <= HARD_LIMIT_BYTES) {
      return withTruncationNotes(
        trimmed,
        ["detail: compacted before persisting oversized run detail"],
        serialized.length,
      );
    }

    // Shallow-clone so we do not mutate the live in-memory detail object.
    trimmed = {
      ...(trimmed && typeof trimmed === "object" ? trimmed : detail),
    };
    const truncationNotes = [...trimmingNotes];

    const trimArray = (obj, key, keep, label) => {
      if (!obj || !Array.isArray(obj[key])) return;
      const arr = obj[key];
      if (arr.length <= keep) return;
      const dropped = arr.length - keep;
      obj[key] = arr.slice(arr.length - keep);
      truncationNotes.push(`${label}: dropped ${dropped} of ${arr.length} entries`);
    };

    // 1) Top-level logs
    trimArray(trimmed, "logs", 500, "logs");

    // 2) Replay trajectory steps
    if (trimmed.data && typeof trimmed.data === "object") {
      trimmed.data = { ...trimmed.data };
      if (trimmed.data._replayTrajectory && typeof trimmed.data._replayTrajectory === "object") {
        trimmed.data._replayTrajectory = { ...trimmed.data._replayTrajectory };
        trimArray(trimmed.data._replayTrajectory, "steps", 200, "replayTrajectory.steps");
      }
    }
    if (trimmed.replayTrajectory && typeof trimmed.replayTrajectory === "object") {
      trimmed.replayTrajectory = { ...trimmed.replayTrajectory };
      trimArray(trimmed.replayTrajectory, "steps", 200, "replayTrajectory.steps");
    }

    // 3) Per-node outputs (logs / events arrays)
    if (trimmed.nodeOutputs && typeof trimmed.nodeOutputs === "object") {
      const next = {};
      for (const [nodeId, output] of Object.entries(trimmed.nodeOutputs)) {
        if (output && typeof output === "object" && !Array.isArray(output)) {
          const cloned = { ...output };
          trimArray(cloned, "logs", 100, `nodeOutputs.${nodeId}.logs`);
          trimArray(cloned, "events", 100, `nodeOutputs.${nodeId}.events`);
          trimArray(cloned, "messages", 100, `nodeOutputs.${nodeId}.messages`);
          next[nodeId] = cloned;
        } else {
          next[nodeId] = output;
        }
      }
      trimmed.nodeOutputs = next;
    }

    // 4) nodeStatusEvents may grow without bound on long-running flows
    trimArray(trimmed, "nodeStatusEvents", 500, "nodeStatusEvents");

    // If we are still over the limit, drop the heaviest non-essential fields.
    recheck = serializeDetail(trimmed) || "";
    if (recheck && recheck.length > HARD_LIMIT_BYTES) {
      if (trimmed.data && typeof trimmed.data === "object") {
        const dataKeysToDrop = ["_replayTrajectory", "_dagState"];
        for (const key of dataKeysToDrop) {
          if (trimmed.data[key] != null) {
            delete trimmed.data[key];
            truncationNotes.push(`data.${key}: dropped (oversized)`);
          }
        }
      }
      recheck = serializeDetail(trimmed) || "";
      if (recheck && recheck.length > HARD_LIMIT_BYTES) {
        trimmed.nodeOutputs = {};
        truncationNotes.push("nodeOutputs: dropped (still oversized)");
      }
    }

    if (truncationNotes.length > 0) {
      trimmed._truncated = {
        at: new Date().toISOString(),
        originalBytes: serialized.length,
        notes: truncationNotes,
      };
    }
    return trimmed;
  }

  _writeRunDetailToStateLedger(runId, detail) {
    try {
      writeWorkflowRunDetailToStateLedger(runId, detail, { anchorPath: this.runsDir });
    } catch (err) {
      console.warn(`${TAG} workflow run detail sync failed: ${String(err?.message || err)}`);
    }
  }

  _writeRunIndex(runs) {
    const indexPath = resolve(this.runsDir, "index.json");
    writeJsonFileAtomically(indexPath, { runs });
    this._runIndexCache = runs;
    clearRunHistoryCache();
    try {
      this._runIndexCacheMtime = statSync(indexPath).mtimeMs || Date.now();
    } catch {
      this._runIndexCacheMtime = Date.now();
    }
  }

  /**
   * Delete run detail files older than the most recent `keepCount` files.
   * Keeps index.json and active-runs.json untouched.
   * Safe to call on startup and periodically (e.g. daily).
   *
   * @param {number} [keepCount] Number of most-recent run files to retain (default MAX_PERSISTED_RUNS).
   * @returns {{ deleted: number, kept: number, errors: number }}
   */
  pruneOldRunFiles(keepCount = MAX_PERSISTED_RUNS) {
    const PROTECTED = new Set(["index.json", ACTIVE_RUNS_INDEX]);
    const normalizedKeep = Math.max(20, Math.floor(Number(keepCount) || MAX_PERSISTED_RUNS));

    if (!existsSync(this.runsDir)) return { deleted: 0, kept: 0, errors: 0 };

    let allFiles;
    try {
      allFiles = readdirSync(this.runsDir)
        .filter((f) => f.endsWith(".json") && !PROTECTED.has(f))
        .map((f) => {
          const p = resolve(this.runsDir, f);
          let mtimeMs = 0;
          try { mtimeMs = statSync(p).mtimeMs || 0; } catch { /* ignore */ }
          return { file: f, path: p, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      return { deleted: 0, kept: 0, errors: 1 };
    }

    const toDelete = allFiles.slice(normalizedKeep);
    let deleted = 0;
    let errors = 0;
    for (const entry of toDelete) {
      try {
        unlinkSync(entry.path);
        deleted++;
      } catch {
        errors++;
      }
    }
    return { deleted, kept: allFiles.length - toDelete.length, errors };
  }
}

// ── Module-level convenience functions ──────────────────────────────────────

let _defaultEngine = null;

function shouldDisableDefaultInterruptedRunDetection(opts = {}) {
  const env = getRuntimeEnv();
  const isTestProcess = Boolean(env.VITEST) || env.NODE_ENV === "test";
  return isTestProcess && !opts.workflowDir && !opts.runsDir;
}

function mergeWorkflowServices(currentServices, incomingServices) {
  const current =
    currentServices && typeof currentServices === "object"
      ? { ...currentServices }
      : {};
  if (!incomingServices || typeof incomingServices !== "object") return current;

  for (const [key, value] of Object.entries(incomingServices)) {
    if (value === undefined) continue;
    if (value === null && current[key] != null) continue;
    current[key] = value;
  }
  return current;
}

/**
 * Get or create the default workflow engine instance.
 * @param {object} [opts]
 * @returns {WorkflowEngine}
 */
export function getWorkflowEngine(opts = {}) {
  if (!_defaultEngine) {
    const engineOpts = opts && typeof opts === "object" ? { ...opts } : {};
    if (
      engineOpts.detectInterruptedRuns === undefined &&
      shouldDisableDefaultInterruptedRunDetection(engineOpts)
    ) {
      engineOpts.detectInterruptedRuns = false;
    }
    _defaultEngine = new WorkflowEngine(engineOpts);
    _defaultEngine.load();
  } else if (opts && typeof opts === "object") {
    const workflowDir = typeof opts.workflowDir === "string" && opts.workflowDir
      ? resolve(opts.workflowDir)
      : null;
    const runsDir = typeof opts.runsDir === "string" && opts.runsDir
      ? resolve(opts.runsDir)
      : null;
    const configDir = typeof opts.configDir === "string" && opts.configDir
      ? resolve(opts.configDir)
      : null;
    const shouldReinitialize =
      (workflowDir && workflowDir !== _defaultEngine.workflowDir) ||
      (runsDir && runsDir !== _defaultEngine.runsDir) ||
      (configDir && configDir !== resolve(_defaultEngine._configDir || getRuntimeCwd()));

    if (shouldReinitialize) {
      const engineOpts = {
        ...opts,
        services: mergeWorkflowServices(_defaultEngine.services, opts.services || {}),
      };
      if (
        engineOpts.detectInterruptedRuns === undefined &&
        shouldDisableDefaultInterruptedRunDetection(engineOpts)
      ) {
        engineOpts.detectInterruptedRuns = false;
      }
      _defaultEngine = new WorkflowEngine(engineOpts);
      _defaultEngine.load();
    } else if (opts.services && typeof opts.services === "object") {
      _defaultEngine.services = mergeWorkflowServices(
        _defaultEngine.services,
        opts.services,
      );
    }
  }
  return _defaultEngine;
}

/** Reset the default engine (for testing) */
export function resetWorkflowEngine() {
  _defaultEngine = null;
}

export function loadWorkflows(opts) { return getWorkflowEngine(opts).list(); }
export function saveWorkflow(def, opts) { return getWorkflowEngine(opts).save(def); }
export function deleteWorkflow(id, opts) { return getWorkflowEngine(opts).delete(id); }
export function listWorkflows(opts) { return getWorkflowEngine(opts).list(); }
export function getWorkflow(id, opts) { return getWorkflowEngine(opts).get(id); }
export async function executeWorkflow(id, data, opts) { return getWorkflowEngine(opts).execute(id, data, opts); }
export async function retryWorkflowRun(runId, retryOpts, engineOpts) { return getWorkflowEngine(engineOpts).retryRun(runId, retryOpts); }
