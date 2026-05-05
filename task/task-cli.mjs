/**
 * task-cli.mjs — CLI task management for Bosun
 *
 * Provides a complete CRUD interface for kanban tasks via the command line.
 * Used by both human operators and AI agents to manage the backlog.
 *
 * Usage:
 *   bosun task list [--status <status>] [--priority <priority>] [--tag <tag>] [--json]
 *   bosun task create <json-string>
 *   bosun task create --title "..." [--description "..."] [--priority high] [--tags ui,fix] [--branch main]
 *   bosun task get <task-id> [--json]
 *   bosun task update <task-id> <json-patch>
 *   bosun task update <task-id> --status todo --priority high
 *   bosun task delete <task-id>
 *   bosun task stats [--json] [--debug]
 *   bosun task import <json-file>
 *
 * EXPORTS:
 *   runTaskCli(args)      — Main entry point for CLI routing
 *   taskCreate(data)      — Programmatic task creation
 *   taskList(filters)     — Programmatic task listing
 *   taskGet(id)           — Programmatic task fetch
 *   taskUpdate(id, patch) — Programmatic task update
 *   taskDelete(id)        — Programmatic task deletion
 *   taskStats()           — Programmatic stats
 */

import { resolve, dirname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  normalizeWorkspaceStorageKey,
  normalizeWorkspaceStorageKeys,
} from "./task-store.mjs";
import { getTaskLifetimeTotals } from "../infra/runtime-accumulator.mjs";

const VERIFICATION_STATUS = Object.freeze({
  PASSED: "passed",
  FAILED: "failed",
  PARTIAL: "partial",
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TAG = "[task-cli]";
const DEFAULT_EXECUTOR_RUNTIME_STATE_FILE = resolve(
  __dirname,
  "..",
  ".cache",
  "task-executor-runtime.json",
);
const REPO_AREA_SLOW_MERGE_LATENCY_MS = 4 * 60 * 60 * 1000;
const REPO_AREA_VERY_SLOW_MERGE_LATENCY_MS = 8 * 60 * 60 * 1000;

// ── Store helpers ─────────────────────────────────────────────────────────────

let _storeReady = false;
let _resolvedStorePath = null;

function normalizeStorePath(pathLike) {
  const resolvedPath = resolve(String(pathLike || ""));
  return process.platform === "win32"
    ? resolvedPath.toLowerCase()
    : resolvedPath;
}

function rethrowKeyCollision(err) {
  if (err?.code === "TASK_STORE_KEY_COLLISION") {
    throw err;
  }
}

function normalizeStoreScopeKey(value) {
  return normalizeWorkspaceStorageKey(value);
}

function assertNoStoreKeyCollisions(values, kind) {
  normalizeWorkspaceStorageKeys(values, { kind });
}

function ensureStore() {
  if (_storeReady) return;
  // Import is sync-cached after first call
  const { configureTaskStore, loadStore } = _getTaskStore();
  configureTaskStore();
  loadStore();
  _storeReady = true;
}

/** Lazy-load task-store to avoid circular deps */
let _taskStoreModule = null;
function _getTaskStore() {
  if (!_taskStoreModule) {
    // Dynamic import is async but we need sync access — use the fact that
    // ES module imports are cached and we can do a synchronous re-import
    // via import.meta.resolve. Instead, we eagerly import at runTaskCli().
    throw new Error("task-store not loaded — call initStore() first");
  }
  return _taskStoreModule;
}

async function initStore() {
  if (!_taskStoreModule) {
    _taskStoreModule = await import("./task-store.mjs");
  }
  const storePath = resolveKanbanStorePath();
  const normalizedStorePath = normalizeStorePath(storePath);
  await flushStoreWrites(_taskStoreModule);
  _taskStoreModule.configureTaskStore({ storePath });
  _taskStoreModule.loadStore();
  _storeReady = true;
  _resolvedStorePath = normalizedStorePath;
  return _taskStoreModule;
}
async function flushStoreWrites(store) {
  if (typeof store?.waitForStoreWrites === "function") {
    await store.waitForStoreWrites();
  }
}

/**
 * Resolve the kanban store path with priority:
 *   1. BOSUN_STORE_PATH env var (explicit override)
 *   2. Explicit REPO_ROOT env var
 *   3. Active workspace store derived from global bosun.config.json
 *   4. Repo root walked from CWD (legacy fallback)
 */
export function resolveKanbanStorePath() {
  if (process.env.BOSUN_STORE_PATH) return process.env.BOSUN_STORE_PATH;
  if (process.env.REPO_ROOT) {
    return resolve(process.env.REPO_ROOT, ".bosun", ".cache", "kanban-state.json");
  }

  try {
    const bosunHome = _deriveBosunHome();
    if (bosunHome) {
      const configPath = resolve(bosunHome, "bosun.config.json");
      if (existsSync(configPath)) {
        const cfg = JSON.parse(readFileSync(configPath, "utf8"));
        const workspacesDir = cfg.workspacesDir || resolve(bosunHome, "workspaces");
        const activeWs = String(cfg?.activeWorkspace || "").trim();
        const workspaceEntries = Array.isArray(cfg?.workspaces) ? cfg.workspaces : [];
        assertNoStoreKeyCollisions(
          workspaceEntries.map((entry) => entry?.id),
          "bosun.config.workspaces",
        );
        if (activeWs && workspacesDir) {
          const activeWorkspaceKey = normalizeStoreScopeKey(activeWs);
          const ws =
            workspaceEntries.find(
              (entry) => normalizeStoreScopeKey(entry?.id) === activeWorkspaceKey,
            ) || null;
          const repos = Array.isArray(ws?.repos) ? ws.repos : [];
          assertNoStoreKeyCollisions(
            repos.map((repo) => repo?.slug || repo?.name),
            "bosun.config.repos",
          );
          const activeRepoKey = normalizeStoreScopeKey(ws?.activeRepo);
          const selectedRepo =
            (activeRepoKey
              ? repos.find(
                  (repo) =>
                    normalizeStoreScopeKey(repo?.slug || repo?.name)
                    === activeRepoKey,
                )
              : null) ||
            repos.find((repo) => repo?.primary) ||
            null;
          const fallbackRepoName = (cfg.repos || []).find((r) => r.primary)?.name;
          const primaryRepoName = normalizeStoreScopeKey(
            selectedRepo?.name || selectedRepo?.slug || fallbackRepoName,
          );
          if (primaryRepoName) {
            const wsStorePath = resolve(
              workspacesDir,
              activeWorkspaceKey,
              primaryRepoName,
              ".bosun",
              ".cache",
              "kanban-state.json",
            );
            // Use this path if the containing directory already exists
            // (daemon has initialised the workspace) or we can create it
            const wsStoreDir = dirname(wsStorePath);
            if (existsSync(wsStoreDir) || existsSync(dirname(wsStoreDir))) {
              return wsStorePath;
            }
          }
        }
      }
    }
  } catch (err) {
    rethrowKeyCollision(err);
    // fall through to legacy CWD-based resolution
  }

  const repoRoot = findTrueRepoRoot(process.cwd()) || process.cwd();
  return resolve(repoRoot, ".bosun", ".cache", "kanban-state.json");
}

function resolveActiveWorkspaceDefaults() {
  try {
    const bosunHome = _deriveBosunHome();
    if (!bosunHome) return { workspace: "", repository: "" };
    const configPath = resolve(bosunHome, "bosun.config.json");
    if (!existsSync(configPath)) return { workspace: "", repository: "" };
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    const activeWsId = normalizeStoreScopeKey(cfg?.activeWorkspace);
    const workspaces = Array.isArray(cfg?.workspaces) ? cfg.workspaces : [];
    assertNoStoreKeyCollisions(
      workspaces.map((entry) => entry?.id),
      "bosun.config.workspaces",
    );
    const workspace =
      (activeWsId
        ? workspaces.find(
            (entry) => normalizeStoreScopeKey(entry?.id) === activeWsId,
          )
        : null) ||
      workspaces[0] ||
      null;
    const repos = Array.isArray(workspace?.repos) ? workspace.repos : [];
    assertNoStoreKeyCollisions(
      repos.map((repo) => repo?.slug || repo?.name),
      "bosun.config.repos",
    );
    const activeRepoName = normalizeStoreScopeKey(workspace?.activeRepo);
    const selectedRepo =
      (activeRepoName
        ? repos.find(
            (repo) =>
              normalizeStoreScopeKey(repo?.slug || repo?.name)
              === activeRepoName,
          )
        : null) ||
      repos.find((repo) => repo?.primary) ||
      repos[0] ||
      null;
    const repository = normalizeStoreScopeKey(
      selectedRepo?.slug || selectedRepo?.name || "",
    );
    return {
      workspace: normalizeStoreScopeKey(workspace?.id || activeWsId || ""),
      repository,
    };
  } catch (err) {
    rethrowKeyCollision(err);
    return { workspace: "", repository: "" };
  }
}

function _deriveBosunHome() {
  if (process.env.BOSUN_HOME) return process.env.BOSUN_HOME;
  if (process.env.BOSUN_DIR) return process.env.BOSUN_DIR;
  // Windows: %APPDATA%/bosun, Unix: ~/.bosun
  if (process.env.APPDATA) return resolve(process.env.APPDATA, "bosun");
  return resolve(homedir(), ".bosun");
}

/**
 * Walk up from startDir to find the first directory with a real .git directory
 * (a directory, not a file — files indicate submodules/worktrees).
 * Falls back to the first .git of any kind.
 */
function findTrueRepoRoot(startDir) {
  let current = resolve(startDir);
  let firstGitAnything = null;
  while (true) {
    const gitPath = resolve(current, ".git");
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isDirectory()) return current;
        if (!firstGitAnything) firstGitAnything = current;
      } catch {
        if (!firstGitAnything) firstGitAnything = current;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return firstGitAnything;
}

// ── Arg parsing helpers ───────────────────────────────────────────────────────

function getArgValue(args, flag) {
  const match = args.find((a) => a.startsWith(`${flag}=`));
  if (match) return match.slice(flag.length + 1).trim();
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--")) {
    return args[idx + 1].trim();
  }
  return null;
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function isDebugModeEnabled(args = []) {
  if (hasFlag(args, "--debug")) return true;
  const envValue = String(process.env.BOSUN_DEBUG || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(envValue);
}

// ── Programmatic API ──────────────────────────────────────────────────────────

/**
 * Create a new task. Accepts a plain object with task fields.
 * Returns the created task or throws on error.
 */
function buildTaskInput(data, store) {
  const normalizeKey = store.normalizeWorkspaceStorageKey || normalizeStoreScopeKey;
  const normalizeKeys =
    store.normalizeWorkspaceStorageKeys
    || ((values, options = {}) => normalizeWorkspaceStorageKeys(values, options));
  const id = data.id || randomUUID();
  const parsedCandidateCount = Number(data?.candidateCount);
  const candidateCount = Number.isFinite(parsedCandidateCount)
    ? Math.max(1, Math.min(12, Math.trunc(parsedCandidateCount)))
    : null;
  const inputMeta =
    data?.meta && typeof data.meta === "object" && !Array.isArray(data.meta)
      ? { ...data.meta }
      : {};
  const executionMeta =
    inputMeta.execution && typeof inputMeta.execution === "object"
      ? { ...inputMeta.execution }
      : {};
  if (candidateCount && candidateCount > 1) {
    executionMeta.candidateCount = candidateCount;
  }
  if (Object.keys(executionMeta).length > 0) {
    inputMeta.execution = executionMeta;
  }
  const defaults = resolveActiveWorkspaceDefaults();
  const rawWorkspace = data.workspace || defaults.workspace || process.cwd();
  const workspaceKey = normalizeKey(rawWorkspace);
  const workspaceValue = typeof rawWorkspace === "string" && isAbsolute(rawWorkspace)
    ? rawWorkspace
    : (workspaceKey || null);
  const repositoryKey = normalizeKey(data.repository || defaults.repository || "");
  const repositoryKeys = normalizeKeys(
    [repositoryKey, ...(Array.isArray(data.repositories) ? data.repositories : [])],
    { kind: `task-cli:create:${id}:repositories` },
  );
  const taskData = {
    id,
    title: data.title,
    description: data.description || "",
    status: data.status || "draft",
    draft: data.draft ?? (data.status === "draft" || !data.status),
    priority: data.priority || "medium",
    tags: normalizeTags(data.tags),
    baseBranch: data.baseBranch || data.base_branch || "main",
    workspace: workspaceValue,
    repository: repositoryKey || null,
    repositories: repositoryKeys,
    candidateCount: candidateCount && candidateCount > 1 ? candidateCount : undefined,
    meta: inputMeta,
  };
  if (taskData.workspace && !taskData.meta.workspace) {
    taskData.meta.workspace = taskData.workspace;
  }
  if (taskData.repository && !taskData.meta.repository) {
    taskData.meta.repository = taskData.repository;
  }

  // Format description from structured fields if provided
  if (data.implementation_steps || data.acceptance_criteria || data.verification) {
    const parts = [taskData.description || ""];
    if (data.implementation_steps?.length) {
      parts.push("", "## Implementation Steps");
      for (const step of data.implementation_steps) {
        parts.push(`- ${step}`);
      }
    }
    if (data.acceptance_criteria?.length) {
      parts.push("", "## Acceptance Criteria");
      for (const c of data.acceptance_criteria) {
        parts.push(`- ${c}`);
      }
    }
    if (data.verification?.length) {
      parts.push("", "## Verification");
      for (const v of data.verification) {
        parts.push(`- ${v}`);
      }
    }
    taskData.description = parts.join("\n");
  }

  return taskData;
}

function buildImportedTaskInput(data, store) {
  const taskData = buildTaskInput(data, store);
  return {
    ...data,
    ...taskData,
    meta: taskData.meta,
  };
}

export async function taskCreate(data) {
  const store = await initStore();
  const taskData = buildTaskInput(data, store);

  const result = store.addTask(taskData);
  if (!result) {
    throw new Error(`Failed to create task — addTask returned null`);
  }
  await flushStoreWrites(store);
  return result;
}

/**
 * List tasks with optional filters.
 * @param {object} [filters] - { status, priority, tag, search, limit }
 * @returns {object[]} Array of tasks
 */
export async function taskList(filters = {}) {
  const store = await initStore();
  let tasks = store.getAllTasks();

  const statusFilters = Array.isArray(filters.statuses)
    ? filters.statuses
    : (typeof filters.status === "string"
      ? filters.status.split(",").map((value) => value.trim()).filter(Boolean)
      : []);
  if (statusFilters.length === 1) {
    tasks = tasks.filter((t) => t.status === statusFilters[0]);
  } else if (statusFilters.length > 1) {
    const allowedStatuses = new Set(statusFilters);
    tasks = tasks.filter((t) => allowedStatuses.has(String(t?.status || "").trim()));
  }
  if (filters.priority) {
    tasks = tasks.filter((t) => t.priority === filters.priority);
  }
  if (filters.tag) {
    const tag = filters.tag.toLowerCase();
    tasks = tasks.filter((t) => (t.tags || []).includes(tag));
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    tasks = tasks.filter(
      (t) =>
        (t.title || "").toLowerCase().includes(q) ||
        (t.description || "").toLowerCase().includes(q),
    );
  }

  // Sort: priority (critical > high > medium > low), then by createdAt desc
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  tasks.sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 99;
    const pb = priorityOrder[b.priority] ?? 99;
    if (pa !== pb) return pa - pb;
    return (b.createdAt || "").localeCompare(a.createdAt || "");
  });

  if (filters.limit) {
    tasks = tasks.slice(0, filters.limit);
  }

  return tasks;
}

function withTaskLifetimeTotals(task) {
  if (!task || typeof task !== "object") return task;
  const taskId = String(task.id || task.taskId || "").trim();
  const lifetimeTotals = taskId ? getTaskLifetimeTotals(taskId) : null;
  return {
    ...task,
    lifetimeTotals,
    meta: {
      ...(task.meta || {}),
      lifetimeTotals,
    },
  };
}

function formatDurationMs(ms) {
  const value = Number(ms || 0);
  if (!Number.isFinite(value) || value <= 0) return "0s";
  if (value < 1000) return `${Math.round(value)}ms`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return remSeconds > 0 ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function getTaskVerificationCommands(task) {
  if (!Array.isArray(task?.verification)) return [];
  return task.verification.filter(isNonEmptyString).map((command) => command.trim());
}

function createVerificationPrefix(index, total) {
  return `[verify ${index}/${total}]`;
}

function prefixOutputChunk(chunk, prefix) {
  const text = String(chunk || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text) return "";
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) lines.pop();
  return lines.map((line) => `${prefix} ${line}`).join("\n") + (trailingNewline ? "\n" : "");
}

function writePrefixedChunk(stream, chunk, prefix) {
  const formatted = prefixOutputChunk(chunk, prefix);
  if (formatted) stream.write(formatted);
}

async function runVerificationCommand(command, { cwd, index, total }) {
  const prefix = createVerificationPrefix(index, total);
  return await new Promise((resolve) => {
    const child = spawn(command, [], { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk) => writePrefixedChunk(process.stdout, chunk, prefix));
    child.stderr?.on("data", (chunk) => writePrefixedChunk(process.stderr, chunk, prefix));
    child.on("error", (error) => {
      writePrefixedChunk(process.stderr, error?.message || String(error), prefix);
      resolve({ status: 1, error });
    });
    child.on("close", (code, signal) => {
      const status = Number.isInteger(code) ? code : 1;
      if (signal) {
        writePrefixedChunk(process.stderr, `Process terminated with signal ${signal}`, prefix);
      }
      resolve({ status, signal: signal || null });
    });
  });
}

function getVerificationFailureStatus(completedCount, total) {
  return completedCount > 0 && completedCount < total
    ? VERIFICATION_STATUS.PARTIAL
    : VERIFICATION_STATUS.FAILED;
}

/**
 * Get a single task by ID.
 * @param {string} id - Task ID (UUID or partial prefix)
 * @returns {object|null} Task or null
 */
export async function taskGet(id) {
  const store = await initStore();

  // Try exact match first
  let task = store.getTask(id);
  if (task) return withTaskLifetimeTotals(task);

  // Try prefix match
  const all = store.getAllTasks();
  const matches = all.filter((t) => t.id?.startsWith(id));
  if (matches.length === 1) return withTaskLifetimeTotals(matches[0]);
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous task ID prefix "${id}" — matches ${matches.length} tasks. Use a longer prefix.`,
    );
  }
  return null;
}

/**
 * Update a task by ID with a partial patch.
 * @param {string} id - Task ID
 * @param {object} patch - Fields to update
 * @returns {object} Updated task
 */
export async function taskUpdate(id, patch) {
  const store = await initStore();

  // Resolve prefix
  const task = await taskGet(id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }

  // Normalize certain fields
  const updates = { ...patch };
  if (updates.tags) {
    updates.tags = normalizeTags(updates.tags);
  }
  if (updates.base_branch) {
    updates.baseBranch = updates.base_branch;
    delete updates.base_branch;
  }

  // Use setTaskStatus for status changes (tracks history)
  if (updates.status && updates.status !== task.status) {
    store.setTaskStatus(task.id, updates.status, "external");
    delete updates.status;
    await flushStoreWrites(store);
  }

  // Apply remaining updates
  const remaining = Object.keys(updates).filter((k) => k !== "id");
  if (remaining.length > 0) {
    const result = store.updateTask(task.id, updates);
    if (!result) {
      throw new Error(`Failed to update task ${task.id}`);
    }
    await flushStoreWrites(store);
    return result;
  }

  return store.getTask(task.id);
}

/**
 * Delete a task by ID.
 * @param {string} id - Task ID
 * @returns {boolean} True if deleted
 */
export async function taskDelete(id) {
  const store = await initStore();
  const task = await taskGet(id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }
  const removed = store.removeTask(task.id);
  if (removed) {
    await flushStoreWrites(store);
  }
  return removed;
}

/**
 * Get aggregate task statistics.
 * @returns {object} Stats object
 */
export async function taskStats() {
  const store = await initStore();
  const stats = store.getStats();
  return {
    ...stats,
    repoAreaLocks: readRepoAreaLocksFromRuntimeState(),
  };
}

function resolveExecutorRuntimeStateFile() {
  const explicit = String(process.env.BOSUN_TASK_EXECUTOR_RUNTIME_FILE || "").trim();
  if (explicit) return resolve(explicit);
  return DEFAULT_EXECUTOR_RUNTIME_STATE_FILE;
}

function readRepoAreaLocksFromRuntimeState() {
  const runtimeStateFile = resolveExecutorRuntimeStateFile();
  if (!existsSync(runtimeStateFile)) return null;
  try {
    const raw = readFileSync(runtimeStateFile, "utf8");
    const parsed = JSON.parse(raw);
    const configuredLimit = Math.max(
      0,
      Math.trunc(Number(parsed?.repoAreaParallelLimit || 0)),
    );
    const lockMetrics =
      parsed?.repoAreaLockMetrics && typeof parsed.repoAreaLockMetrics === "object"
        ? parsed.repoAreaLockMetrics
        : {};
    const telemetryByArea =
      parsed?.repoAreaTelemetry && typeof parsed.repoAreaTelemetry === "object"
        ? parsed.repoAreaTelemetry
        : {};
    const blockedTasks =
      parsed?.repoAreaBlockedTasks && typeof parsed.repoAreaBlockedTasks === "object"
        ? parsed.repoAreaBlockedTasks
        : {};
    const taskAreas =
      parsed?.repoAreaTaskAreas && typeof parsed.repoAreaTaskAreas === "object"
        ? parsed.repoAreaTaskAreas
        : {};
    const runtimeSlots =
      parsed?.slots && typeof parsed.slots === "object"
        ? parsed.slots
        : {};
    const dispatchCycle =
      parsed?.repoAreaDispatchCycle && typeof parsed.repoAreaDispatchCycle === "object"
        ? parsed.repoAreaDispatchCycle
        : {};
    const contentionEvents = Array.isArray(parsed?.repoAreaContentionEvents)
      ? parsed.repoAreaContentionEvents
          .slice(-60)
          .map((event) => ({
            at: event?.at ? String(event.at) : null,
            taskId: normalizeTaskId(event?.taskId),
            area: normalizeRepoAreaKey(event?.area),
            waitMs: Math.max(0, Math.trunc(Number(event?.waitMs || 0))),
            resolutionReason: normalizeRepoAreaResolutionReason(
              event?.resolutionReason,
            ),
          }))
          .filter((event) => event.taskId && event.area)
      : [];
    const contentionByReason = Object.create(null);
    for (const event of contentionEvents) {
      const reason = normalizeRepoAreaResolutionReason(event.resolutionReason);
      contentionByReason[reason] = (contentionByReason[reason] || 0) + 1;
    }
    const activeSignals = new Map();
    const activeCounts = new Map();
    for (const [taskId, slot] of Object.entries(runtimeSlots)) {
      const normalizedTaskId = normalizeTaskId(taskId);
      if (!normalizedTaskId) continue;
      const repoAreas = Array.isArray(slot?.repoAreas)
        ? slot.repoAreas
        : taskAreas[normalizedTaskId];
      const areas = normalizeRepoAreas(repoAreas);
      if (areas.length === 0) continue;
      const startedAt = Math.max(0, Math.trunc(Number(slot?.startedAt || 0)));
      const activeAgeMs = startedAt > 0 ? Math.max(0, Date.now() - startedAt) : 0;
      const mergeLatencyMs = Number(slot?.mergeLatencyMs || slot?.mergeLatency || 0);
      const latencySampleMs = mergeLatencyMs > 0 ? mergeLatencyMs : activeAgeMs;
      const attempt = Number(slot?.attempt || 0);
      const status = String(slot?.status || "").trim().toLowerCase();
      for (const area of areas) {
        activeCounts.set(area, (activeCounts.get(area) || 0) + 1);
        let signal = activeSignals.get(area);
        if (!signal) {
          signal = {
            active: 0,
            retrying: 0,
            mergeLatencyMsTotal: 0,
            mergeLatencySamples: 0,
            maxMergeLatencyMs: 0,
          };
          activeSignals.set(area, signal);
        }
        signal.active += 1;
        if (attempt > 1 || status === "failed") signal.retrying += 1;
        if (latencySampleMs > 0) {
          signal.mergeLatencyMsTotal += latencySampleMs;
          signal.mergeLatencySamples += 1;
          signal.maxMergeLatencyMs = Math.max(signal.maxMergeLatencyMs, latencySampleMs);
        }
      }
    }

    const blockedByArea = new Map();
    for (const blocked of Object.values(blockedTasks)) {
      const areas = normalizeRepoAreas(blocked?.areas);
      for (const area of areas) {
        blockedByArea.set(area, (blockedByArea.get(area) || 0) + 1);
      }
    }

    const allAreas = new Set([
      ...Object.keys(lockMetrics).map((area) => normalizeRepoAreaKey(area)).filter(Boolean),
      ...Object.keys(telemetryByArea).map((area) => normalizeRepoAreaKey(area)).filter(Boolean),
      ...activeCounts.keys(),
      ...blockedByArea.keys(),
    ]);

    const areas = Array.from(allAreas)
      .sort()
      .map((area) => {
        const metric = lockMetrics[area] || {};
        const signal = activeSignals.get(area) || {
          active: 0,
          retrying: 0,
          mergeLatencyMsTotal: 0,
          mergeLatencySamples: 0,
          maxMergeLatencyMs: 0,
        };
        const telemetry = normalizeRepoAreaTelemetryEntry(telemetryByArea[area]);
        const historicalAdaptive = buildRepoAreaAdaptiveSignals(telemetry, configuredLimit);
        const adaptiveState = computeRepoAreaAdaptiveState({
          configuredLimit,
          telemetry,
          signal,
          historicalAdaptive
        });
        const effectiveLimit = computeRepoAreaEffectiveLimit({
          configuredLimit,
          activeSignals: signal,
          telemetry,
          historicalAdaptive,
        });

        return {
          area,
          configuredLimit,
          effectiveLimit,
          activeSlots: activeCounts.get(area) || 0,
          waitingTasks: blockedByArea.get(area) || 0,
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
          conflicts: Math.max(0, Math.trunc(Number(metric?.conflicts || 0))),
          blockedDispatches: Math.max(
            0,
            Math.trunc(Number(metric?.blockedDispatches || 0)),
          ),
          selectedDispatches: Math.max(
            0,
            Math.trunc(Number(metric?.selectedDispatches || 0)),
          ),
          averageWaitMs:
            Number(metric?.waitSamples || 0) > 0
              ? Number(metric?.waitMsTotal || 0) / Number(metric?.waitSamples || 0)
              : 0,
          maxWaitMs: Math.max(0, Math.trunc(Number(metric?.maxWaitMs || 0))),
          waitSamples: Math.max(0, Math.trunc(Number(metric?.waitSamples || 0))),
          lastConflictAt: metric?.lastConflictAt ? String(metric.lastConflictAt) : null,
          lastSelectedAt: metric?.lastSelectedAt ? String(metric.lastSelectedAt) : null,
        };
      })
      .sort((a, b) => b.blockedDispatches - a.blockedDispatches || a.area.localeCompare(b.area));

    return {
      enabled: configuredLimit > 0,
      configuredLimit,
      dispatchCycles: Math.max(0, Math.trunc(Number(parsed?.repoAreaDispatchCycles || 0))),
      conflictEvents: Math.max(0, Math.trunc(Number(parsed?.repoAreaConflictCount || 0))),
      blockedTasksTracked: Object.keys(blockedTasks).length,
      lastDispatch: {
        cycle: Math.max(0, Math.trunc(Number(dispatchCycle?.cycle || 0))),
        at: dispatchCycle?.at ? String(dispatchCycle.at) : null,
        candidateCount: Math.max(0, Math.trunc(Number(dispatchCycle?.candidateCount || 0))),
        remaining: Math.max(0, Math.trunc(Number(dispatchCycle?.remaining || 0))),
        selectedCount: Math.max(0, Math.trunc(Number(dispatchCycle?.selectedCount || 0))),
        blockedTasks: Math.max(0, Math.trunc(Number(dispatchCycle?.blockedTasks || 0))),
        conflictEvents: Math.max(0, Math.trunc(Number(dispatchCycle?.conflictEvents || 0))),
        waitMsTotal: Math.max(0, Math.trunc(Number(dispatchCycle?.waitMsTotal || 0))),
        waitSamples: Math.max(0, Math.trunc(Number(dispatchCycle?.waitSamples || 0))),
        maxWaitMs: Math.max(0, Math.trunc(Number(dispatchCycle?.maxWaitMs || 0))),
        blockedByArea:
          dispatchCycle?.blockedByArea && typeof dispatchCycle.blockedByArea === "object"
            ? { ...dispatchCycle.blockedByArea }
            : {},
        saturatedAreas: Array.isArray(dispatchCycle?.saturatedAreas)
          ? dispatchCycle.saturatedAreas.map((area) => String(area || "").trim()).filter(Boolean)
          : [],
        cycleAreaMetrics:
          dispatchCycle?.cycleAreaMetrics &&
          typeof dispatchCycle.cycleAreaMetrics === "object"
            ? { ...dispatchCycle.cycleAreaMetrics }
            : {},
        areaLimits:
          dispatchCycle?.areaLimits &&
          typeof dispatchCycle.areaLimits === "object"
            ? { ...dispatchCycle.areaLimits }
            : {},
      },
      totals: {
        dispatchCycles: Math.max(0, Math.trunc(Number(parsed?.repoAreaDispatchCycles || 0))),
        conflictEvents: Math.max(0, Math.trunc(Number(parsed?.repoAreaConflictCount || 0))),
        conflicts: areas.reduce((sum, area) => sum + (area.conflicts || 0), 0),
        blockedDispatches: areas.reduce(
          (sum, area) => sum + (area.blockedDispatches || 0),
          0,
        ),
        waitMsTotal: areas.reduce(
          (sum, area) => sum + ((area.averageWaitMs || 0) * (area.waitSamples || 0)),
          0,
        ),
        waitSamples: areas.reduce((sum, area) => sum + (area.waitSamples || 0), 0),
        waitingTasks: areas.reduce((sum, area) => sum + (area.waitingTasks || 0), 0),
        contentionEvents: contentionEvents.length,
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
        cycles: Math.max(0, Math.trunc(Number(parsed?.repoAreaDispatchCycles || 0))),
        conflicts: Math.max(0, Math.trunc(Number(parsed?.repoAreaConflictCount || 0))),
        blockedTasksTracked: Object.keys(blockedTasks).length,
        recent: Array.isArray(parsed?.repoAreaDispatchHistory)
          ? parsed.repoAreaDispatchHistory
            .slice(-10)
            .map((entry) => ({
              cycle: Math.max(0, Math.trunc(Number(entry?.cycle || 0))),
              at: entry?.at ? String(entry.at) : null,
              candidateCount: Math.max(
                0,
                Math.trunc(Number(entry?.candidateCount || 0)),
              ),
              remaining: Math.max(0, Math.trunc(Number(entry?.remaining || 0))),
              selectedCount: Math.max(
                0,
                Math.trunc(Number(entry?.selectedCount || 0)),
              ),
              blockedTasks: Math.max(
                0,
                Math.trunc(Number(entry?.blockedTasks || 0)),
              ),
              conflictEvents: Math.max(
                0,
                Math.trunc(Number(entry?.conflictEvents || 0)),
              ),
              waitMsTotal: Math.max(0, Math.trunc(Number(entry?.waitMsTotal || 0))),
              waitSamples: Math.max(0, Math.trunc(Number(entry?.waitSamples || 0))),
              maxWaitMs: Math.max(0, Math.trunc(Number(entry?.maxWaitMs || 0))),
              blockedByArea:
                entry?.blockedByArea && typeof entry.blockedByArea === "object"
                  ? { ...entry.blockedByArea }
                  : {},
              saturatedAreas: Array.isArray(entry?.saturatedAreas)
                ? entry.saturatedAreas.map((area) => String(area || "").trim()).filter(Boolean)
                : [],
              cycleAreaMetrics:
                entry?.cycleAreaMetrics && typeof entry.cycleAreaMetrics === "object"
                  ? { ...entry.cycleAreaMetrics }
                  : {},
              areaLimits:
                entry?.areaLimits && typeof entry.areaLimits === "object"
                  ? { ...entry.areaLimits }
                  : {},
            }))
          : [],
      },
      areas,
    };
  } catch (err) {
    console.warn(`${TAG} failed to read executor lock state: ${err.message}`);
    return null;
  }
}

function normalizeTaskId(value) {
  return String(value || "").trim();
}

function normalizeRepoAreaKey(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeRepoAreaResolutionReason(value, fallback = "resolved") {
  const normalized = normalizeRepoAreaKey(value);
  return normalized || fallback;
}

function normalizeRepoAreas(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((value) => normalizeRepoAreaKey(value)).filter(Boolean))];
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
    recentOutcomes,
    mergeLatencySamples,
  };
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
    failureRate,
    mergeLatencyAvgMs,
    adaptiveReasons,
    effectiveLimit,
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
  };
}

function computeRepoAreaEffectiveLimit({
  configuredLimit,
  activeSignals = {},
  telemetry = { recentOutcomes: [], mergeLatencySamples: [] },
  historicalAdaptive = { effectiveLimit: 0 },
} = {}) {
  return computeRepoAreaAdaptiveState({
    configuredLimit,
    signal: activeSignals,
    telemetry,
    historicalAdaptive,
  }).effectiveLimit;
}

/**
 * Bulk import tasks from a JSON file or array.
 * @param {object[]|string} source - Array of task objects or path to JSON file
 * @returns {{ created: number, failed: number, errors: string[] }}
 */
export async function taskImport(source) {
  let tasks;
  if (typeof source === "string") {
    // File path
    const raw = readFileSync(resolve(source), "utf8");
    const parsed = JSON.parse(raw);
    tasks = parsed.tasks || parsed.backlog || parsed;
    if (!Array.isArray(tasks)) {
      throw new Error("JSON must contain an array of tasks (top-level or under 'tasks' key)");
    }
  } else if (Array.isArray(source)) {
    tasks = source;
  } else {
    throw new Error("Source must be a file path or array of task objects");
  }

  let created = 0;
  let failed = 0;
  const errors = [];
  const store = await initStore();

  for (const t of tasks) {
    try {
      const importedTask = buildImportedTaskInput(t, store);
      const result = store.addTask(importedTask);
      if (!result) {
        throw new Error("Failed to create task — addTask returned null");
      }
      await flushStoreWrites(store);
      created++;
    } catch (err) {
      failed++;
      errors.push(`${t.title || "untitled"}: ${err.message}`);
    }
  }

  return { created, failed, errors };
}

// ── CLI Router ────────────────────────────────────────────────────────────────

/**
 * Main CLI entry point. Parses args and routes to subcommands.
 * @param {string[]} args - CLI arguments after "task" (e.g., ["list", "--status", "todo"])
 */
export async function runTaskCli(args) {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  // Top-level help: `bosun task --help`, `bosun task -h`, `bosun task help`, or bare `bosun task`
  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    showTaskHelp();
    process.exit(0);
  }

  switch (subcommand) {
    case "list":
    case "ls":
      return await cliList(subArgs);
    case "create":
    case "add":
      return await cliCreate(subArgs);
    case "get":
    case "show":
      return await cliGet(subArgs);
    case "update":
    case "edit":
      return await cliUpdate(subArgs);
    case "delete":
    case "rm":
    case "remove":
      return await cliDelete(subArgs);
    case "plan":
      console.log("\n  Task planner has been removed. Use workflow templates instead.");
      console.log("  See: bosun workflow list\n");
      return;
    case "stats":
      return await cliStats(subArgs);
    case "verify":
      return await cliVerify(subArgs);
    case "import":
      return await cliImport(subArgs);
    default:
      showTaskHelp();
      process.exit(subcommand ? 1 : 0);
  }
}

// ── CLI Subcommands ───────────────────────────────────────────────────────────

async function cliList(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(`
  bosun task list — List tasks with optional filters

  USAGE
    bosun task list [options]

  OPTIONS
    --status <s>      Filter: draft|todo|inprogress|inreview|done|blocked
    --priority <p>    Filter: low|medium|high|critical
    --tag <tag>       Filter by tag
    --search <text>   Full-text search in title/description
    --limit <n>       Max results to return
    --json            Output as JSON array

  EXAMPLES
    bosun task list
    bosun task list --status todo
    bosun task list --priority high --json
    bosun task list --tag ui --limit 10
    bosun task list --search 'retry queue'
`);
    return;
  }
  const filters = {};
  const status = getArgValue(args, "--status");
  const priority = getArgValue(args, "--priority");
  const tag = getArgValue(args, "--tag");
  const search = getArgValue(args, "--search");
  const limit = getArgValue(args, "--limit");
  const json = hasFlag(args, "--json");

  if (status) {
    const statuses = status.split(",").map((value) => value.trim()).filter(Boolean);
    if (statuses.length > 1) filters.statuses = statuses;
    else filters.status = statuses[0];
  }
  if (priority) filters.priority = priority;
  if (tag) filters.tag = tag;
  if (search) filters.search = search;
  if (limit) filters.limit = parseInt(limit, 10);

  const tasks = await taskList(filters);

  if (json) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }

  if (tasks.length === 0) {
    console.log("\n  No tasks found.\n");
    return;
  }

  console.log(`\n  ${tasks.length} task(s):\n`);
  for (const t of tasks) {
    const tags = (t.tags || []).join(", ");
    const id = t.id?.slice(0, 8) || "????????";
    const prio = (t.priority || "?").padEnd(8);
    const status = (t.status || "?").padEnd(12);
    console.log(`  ${id}  [${status}] ${prio} ${t.title || "(untitled)"}`);
    if (tags) console.log(`           tags: ${tags}`);
  }
  console.log("");
}

async function cliCreate(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    showCreateHelp();
    return;
  }

  let data;

  // Check if first positional arg (not a flag value) is a JSON string.
  // Skip args that are values of flag options (--title <value>, etc).
  let firstArg = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      // Skip the flag and its value (if next arg is not a flag)
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        i++; // skip the value
      }
      continue;
    }
    firstArg = args[i];
    break;
  }

  if (firstArg && (firstArg.startsWith("{") || firstArg.startsWith("["))) {
    try {
      const parsed = JSON.parse(firstArg);
      if (Array.isArray(parsed)) {
        // Bulk create
        let ok = 0;
        for (const item of parsed) {
          const result = await taskCreate(item);
          console.log(`  ✓ ${result.id.slice(0, 8)} ${result.title}`);
          ok++;
        }
        console.log(`\n  Created ${ok} task(s).\n`);
        return;
      }
      data = parsed;
    } catch (err) {
      console.error(`  Error: Invalid JSON — ${err.message}`);
      process.exit(1);
    }
  } else {
    // Build from flags
    const title = getArgValue(args, "--title");
    if (!title) {
      console.error("  Error: --title is required (or pass a JSON string)");
      console.error("  Usage: bosun task create --title 'Fix bug' --priority high");
      console.error("         bosun task create '{\"title\": \"Fix bug\", \"priority\": \"high\"}'");
      process.exit(1);
    }
    data = {
      title,
      description: getArgValue(args, "--description") || getArgValue(args, "--desc") || "",
      status: getArgValue(args, "--status") || "draft",
      priority: getArgValue(args, "--priority") || "medium",
      tags: getArgValue(args, "--tags")?.split(",").map((t) => t.trim()) || [],
      baseBranch: getArgValue(args, "--branch") || getArgValue(args, "--base-branch") || "main",
      workspace: getArgValue(args, "--workspace") || process.cwd(),
      repository: getArgValue(args, "--repository") || getArgValue(args, "--repo") || "",
    };
    // Collect repeatable structured-section flags
    const steps = [], acceptance = [], verification = [];
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '--step' || args[i] === '--implementation-step') && args[i + 1] && !args[i + 1].startsWith('--')) {
        steps.push(args[++i]);
      } else if ((args[i] === '--ac' || args[i] === '--acceptance') && args[i + 1] && !args[i + 1].startsWith('--')) {
        acceptance.push(args[++i]);
      } else if ((args[i] === '--verify' || args[i] === '--verification') && args[i + 1] && !args[i + 1].startsWith('--')) {
        verification.push(args[++i]);
      }
    }
    if (steps.length) data.implementation_steps = steps;
    if (acceptance.length) data.acceptance_criteria = acceptance;
    if (verification.length) data.verification = verification;
  }

  try {
    // Read description from stdin if --desc-stdin flag is present
    if (hasFlag(args, "--desc-stdin") || hasFlag(args, "--stdin")) {
      data.description = await readStdin();
    }

    // Read description from file if --desc-file <path> is provided
    const descFile = getArgValue(args, "--desc-file");
    if (descFile) {
      const descPath = resolve(descFile);
      if (!existsSync(descPath)) {
        console.error(`  Error: description file not found: ${descPath}`);
        process.exit(1);
      }
      data.description = readFileSync(descPath, "utf8");
    }

    const result = await taskCreate(data);
    if (hasFlag(args, "--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n  ✓ Created task ${result.id.slice(0, 8)}: ${result.title}\n`);
    }
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    process.exit(1);
  }
}

async function cliGet(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(`
  bosun task get — Show task details by ID

  USAGE
    bosun task get <id> [--json]

  ARGUMENTS
    <id>    Task ID or prefix (minimum 4 chars)

  OPTIONS
    --json  Output as JSON

  EXAMPLES
    bosun task get abc123
    bosun task get b500 --json
`);
    return;
  }
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("  Error: task ID required. Usage: bosun task get <id>");
    process.exit(1);
  }

  try {
    const task = await taskGet(id);
    if (!task) {
      console.error(`  Task not found: ${id}`);
      process.exit(1);
    }

    if (hasFlag(args, "--json")) {
      console.log(JSON.stringify(task, null, 2));
      return;
    }

    console.log(`\n  Task: ${task.id}`);
    console.log(`  Title:       ${task.title}`);
    console.log(`  Status:      ${task.status}`);
    console.log(`  Priority:    ${task.priority || "medium"}`);
    console.log(`  Tags:        ${(task.tags || []).join(", ") || "(none)"}`);
    console.log(`  Branch:      ${task.baseBranch || "main"}`);
    console.log(`  Created:     ${task.createdAt || "?"}`);
    console.log(`  Updated:     ${task.updatedAt || "?"}`);
    const lifetimeTotals = task.lifetimeTotals || task.meta?.lifetimeTotals || null;
    if (lifetimeTotals) {
      console.log(`  Attempts count:                     ${lifetimeTotals.attemptsCount || 0}`);
      console.log(`  Total tokens across all attempts:   ${lifetimeTotals.tokenCount || 0}`);
      console.log(`  Total runtime across all attempts:  ${formatDurationMs(lifetimeTotals.durationMs || 0)}`);
    }
    if (task.workspace) console.log(`  Workspace:   ${task.workspace}`);
    if (task.repository) console.log(`  Repository:  ${task.repository}`);
    if (task.description) {
      console.log(`\n  Description:\n`);
      for (const line of task.description.split("\n")) {
        console.log(`    ${line}`);
      }
    }
    console.log("");
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    process.exit(1);
  }
}

async function cliUpdate(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(`
  bosun task update — Update task fields by ID

  USAGE
    bosun task update <id> [flags]
    bosun task update <id> '<json-patch>'

  ARGUMENTS
    <id>           Task ID or prefix

  FLAGS
    --status <s>   New status: draft|todo|inprogress|inreview|done|blocked
    --priority <p> New priority: low|medium|high|critical
    --title <t>    New title
    --description, --desc <d>  New description
    --tags <t>     Replace tags (comma-separated)
    --branch <b>   Change base branch
    --draft        Mark as draft
    --undraft      Remove draft flag
    --json         Output updated task as JSON

  EXAMPLES
    bosun task update abc123 --status todo
    bosun task update abc123 --priority critical --tags 'ui,urgent'
    bosun task update abc123 '{"status":"inprogress","priority":"high"}'
`);
    return;
  }
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("  Error: task ID required. Usage: bosun task update <id> [--status todo] [--priority high]");
    process.exit(1);
  }

  const subArgs = args.filter((a) => a !== id);

  let patch = {};

  // Check if second non-flag arg is JSON
  const jsonArg = subArgs.find((a) => !a.startsWith("--") && a.startsWith("{"));
  if (jsonArg) {
    try {
      patch = JSON.parse(jsonArg);
    } catch (err) {
      console.error(`  Error: Invalid JSON — ${err.message}`);
      process.exit(1);
    }
  } else {
    // Build from flags
    const status = getArgValue(subArgs, "--status");
    const priority = getArgValue(subArgs, "--priority");
    const title = getArgValue(subArgs, "--title");
    const description = getArgValue(subArgs, "--description") || getArgValue(subArgs, "--desc");
    const tags = getArgValue(subArgs, "--tags");
    const branch = getArgValue(subArgs, "--branch") || getArgValue(subArgs, "--base-branch");
    const draft = hasFlag(subArgs, "--draft");
    const undraft = hasFlag(subArgs, "--undraft") || hasFlag(subArgs, "--no-draft");

    if (status) patch.status = status;
    if (priority) patch.priority = priority;
    if (title) patch.title = title;
    if (description) patch.description = description;
    if (tags) patch.tags = tags.split(",").map((t) => t.trim());
    if (branch) patch.baseBranch = branch;
    if (draft) patch.draft = true;
    if (undraft) patch.draft = false;
  }

  if (Object.keys(patch).length === 0) {
    console.error("  Error: nothing to update. Provide --status, --priority, --title, etc.");
    process.exit(1);
  }

  try {
    const result = await taskUpdate(id, patch);
    if (hasFlag(args, "--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n  ✓ Updated task ${result.id.slice(0, 8)}: ${result.title}\n`);
    }
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    process.exit(1);
  }
}

async function cliDelete(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(`
  bosun task delete — Delete a task by ID

  USAGE
    bosun task delete <id>

  EXAMPLES
    bosun task delete abc123
    bosun task delete b500
`);
    return;
  }
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("  Error: task ID required. Usage: bosun task delete <id>");
    process.exit(1);
  }

  try {
    const task = await taskGet(id);
    if (!task) {
      console.error(`  Task not found: ${id}`);
      process.exit(1);
    }
    await taskDelete(id);
    console.log(`\n  ✓ Deleted task ${task.id.slice(0, 8)}: ${task.title}\n`);
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    process.exit(1);
  }
}

async function cliStats(args) {
  const stats = await taskStats();
  const debugMode = isDebugModeEnabled(args);

  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log(`\n  Task Statistics:`);
  console.log(`    Draft:       ${stats.draft || 0}`);
  console.log(`    Todo:        ${stats.todo || 0}`);
  console.log(`    In Progress: ${stats.inprogress || 0}`);
  console.log(`    In Review:   ${stats.inreview || 0}`);
  console.log(`    Done:        ${stats.done || 0}`);
  console.log(`    Blocked:     ${stats.blocked || 0}`);
  console.log(`    Total:       ${stats.total || 0}`);
  if (debugMode && stats.repoAreaLocks) {
    const lockState = stats.repoAreaLocks;
    const totals = lockState.totals || {};
    const contention = lockState.contention || {};
    console.log(`\n  Repo Area Locks:`);
    console.log(`    Dispatch Cycles:   ${totals.dispatchCycles || lockState.dispatchCycles || 0}`);
    console.log(`    Conflict Events:   ${totals.conflictEvents || lockState.conflictEvents || 0}`);
    console.log(`    Blocked Tracked:   ${lockState.blockedTasksTracked || lockState.dispatch?.blockedTasksTracked || 0}`);
    console.log(`    Contention Events: ${totals.contentionEvents || contention.events || 0}`);
    const totalWaitSamples = Number(totals.waitSamples || 0);
    const totalWaitMs = Number(totals.waitMsTotal || 0);
    const globalAvgWaitMs =
      totalWaitSamples > 0 ? Math.round(totalWaitMs / totalWaitSamples) : 0;
    console.log(`    Avg Wait (global): ${globalAvgWaitMs}`);
    const lastDispatch = lockState.lastDispatch || null;
    if (lastDispatch && Number(lastDispatch.cycle || 0) > 0) {
      console.log(
        `    Last Cycle:        #${lastDispatch.cycle} conflicts=${lastDispatch.conflictEvents || 0}, waitMs=${Math.round(lastDispatch.waitMsTotal || 0)}`,
      );
    }
    if (Number(lockState.configuredLimit || 0) > 0) {
      console.log(`    Configured Limit:  ${lockState.configuredLimit}`);
    }
    const topAreas = Array.isArray(lockState.areas)
      ? lockState.areas.slice(0, 3)
      : [];
    for (const area of topAreas) {
      console.log(
        `    - ${area.area}: blocked=${area.blockedDispatches || 0}, selected=${area.selectedDispatches || 0}, limit=${area.effectiveLimit || 0}/${area.configuredLimit || lockState.configuredLimit || 0}, avgWaitMs=${Math.round(area.averageWaitMs || 0)}`,
      );
    }
    const recentEvents = Array.isArray(contention.recent)
      ? contention.recent.slice(-3)
      : [];
    for (const event of recentEvents) {
      console.log(
        `    - contention: area=${event.area || "unknown"}, waitMs=${Math.max(0, Math.trunc(Number(event.waitMs || 0)))}, reason=${normalizeRepoAreaResolutionReason(event.resolutionReason)}, task=${String(event.taskId || "").slice(0, 8)}`,
      );
    }
  }
  console.log("");
}

async function cliImport(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(`
  bosun task import — Bulk import tasks from a JSON file

  USAGE
    bosun task import <file.json>

  FILE FORMAT
    JSON file must contain an array at top level, or under a "tasks" key.
    Each task object supports all fields including structured sections:

    {
      "tasks": [
        {
          "title": "feat(ui): Add tabular numerals",
          "description": "Optional free-text description",
          "priority": "high",
          "status": "todo",
          "tags": ["ui", "css"],
          "implementation_steps": ["Edit variables.css", "Test in portal"],
          "acceptance_criteria": ["Numbers align in tables across all tabs"],
          "verification": ["Visual check in agents tab with live data"]
        }
      ]
    }

  EXAMPLES
    bosun task import ./backlog.json
    bosun task import ./tasks/sprint-1.json
`);
    return;
  }
  const filePath = args.find((a) => !a.startsWith("--"));
  if (!filePath) {
    console.error("  Error: file path required. Usage: bosun task import <path.json>");
    process.exit(1);
  }

  if (!existsSync(resolve(filePath))) {
    console.error(`  Error: file not found: ${filePath}`);
    process.exit(1);
  }

  try {
    const result = await taskImport(filePath);
    console.log(`\n  Import complete: ${result.created} created, ${result.failed} failed`);
    if (result.errors.length > 0) {
      console.log("  Errors:");
      for (const err of result.errors) {
        console.log(`    ✗ ${err}`);
      }
    }
    console.log("");
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    process.exit(1);
  }
}

// ── Help ──────────────────────────────────────────────────────────────────────

function showCreateHelp() {
  console.log(`
  bosun task create — Create a new task

  USAGE
    bosun task create --title "..." [flags]
    bosun task create '<json-object>'
    bosun task create '<json-array>'    (bulk create — all tasks at once)

  FLAGS
    --title <t>                 Task title (required when using flags)
    --description, --desc <d>   Task description (single-line inline)
    --status <s>                Initial status (default: draft)
                                  draft|todo|inprogress|inreview|done|blocked
    --priority <p>              Priority (default: medium)
                                  low|medium|high|critical
    --tags <t>                  Comma-separated tags  e.g. "ui,css,fix"
    --branch <b>                Target base branch (default: main)
    --workspace <w>             Workspace directory path
    --repo <r>                  Repository identifier  e.g. "org/repo"
    --stdin                     Read description from stdin (pipe-friendly)
    --desc-file <path>          Read description from file (supports multiline markdown)
    --step <text>               Add an implementation step (repeatable)
    --ac <text>                 Add an acceptance criterion (repeatable)
    --verify <text>             Add a verification step (repeatable)
    --json                      Output created task as JSON

  JSON OBJECT FIELDS
    title, description, status, priority, tags[],
    baseBranch, workspace, repository,
    implementation_steps[], acceptance_criteria[], verification[]

  EXAMPLES

    # Simple
    bosun task create --title "feat(ui): Add tabular numerals" --priority high --tags "ui,css"

    # With structured sections (repeatable flags)
    bosun task create \\
      --title "feat(dashboard): Live/Offline connection badge" \\
      --priority medium --status todo --tags "ui,ux" \\
      --step "Add badge component to portal header" \\
      --step "Listen for WebSocket connect/disconnect events" \\
      --ac "Badge shows green dot when connected" \\
      --ac "Badge shows grey dot when disconnected or reconnecting" \\
      --verify "Open portal, kill server, confirm badge changes state"

    # Multiline description from a file
    bosun task create --title "refactor(css): CSS vars audit" --desc-file ./tasks/css-audit.md

    # Pipe description from stdin
    echo "Fix retry backoff to use exponential intervals" | \\
      bosun task create --title "fix(retry): exponential backoff" --stdin

    # Inline JSON with structured sections
    bosun task create '{
      "title": "feat(dashboard): retry queue section",
      "priority": "high",
      "status": "todo",
      "tags": ["ui", "dashboard"],
      "implementation_steps": ["Add RetryQueue component", "Wire to /api/status"],
      "acceptance_criteria": ["Shows issue ID, attempt #, due-at, last error"],
      "verification": ["Trigger a failing task, confirm it appears in retry queue"]
    }'

    # Bulk create from JSON array
    bosun task create '[{"title":"Task A","priority":"high"},{"title":"Task B"}]'

    # Bulk import from file (best for many tasks)
    bosun task import ./backlog.json
`);
}

function showTaskHelp() {
  console.log(`
  bosun task — Task management CLI

  SUBCOMMANDS
    list, ls    List tasks                  bosun task list --help
    create, add Create a new task           bosun task create --help
    get, show   Show task details           bosun task get --help
    update, edit Update task fields         bosun task update --help
    delete, rm  Delete a task              bosun task delete --help
    stats       Aggregate statistics        bosun task stats --json/--debug
    import      Bulk import from JSON file  bosun task import --help
    verify      Run verification commands   bosun task verify --help

  QUICK REFERENCE

    # Create (flag-based)
    bosun task create --title "feat(ui): Add tabular numerals" --priority high --tags "ui,css" --status todo

    # Create with structured steps, acceptance criteria, and verification
    bosun task create \\
      --title "feat(dashboard): retry queue section" \\
      --priority high --status todo --tags "ui,dashboard" \\
      --step "Add RetryQueueSection component to dashboard" \\
      --step "Poll /api/status retrying[] array every 2s" \\
      --step "Add empty state for when queue is empty" \\
      --ac "Shows issue ID, attempt #, due-at time, and last error per row" \\
      --ac "Disappears / shows empty state when retry queue empties" \\
      --verify "Trigger a failing task, confirm it appears with correct fields"

    # Create (inline JSON — supports all fields)
    bosun task create '{"title":"...","priority":"high","tags":["ui"],"implementation_steps":["..."],"acceptance_criteria":["..."]}'

    # Create (bulk from JSON array)
    bosun task create '[{"title":"Task A"},{"title":"Task B","priority":"high"}]'

    # Bulk import from file (recommended for 3+ tasks)
    bosun task import ./backlog.json

    # List and filter
    bosun task list --status todo --priority high
    bosun task list --tag ui --json

    # Update
    bosun task update <id> --status inprogress
    bosun task update <id> --priority critical --tags "urgent,ui"

  STATUS VALUES
    draft · todo · inprogress · inreview · done · blocked

  PRIORITY VALUES
    low · medium · high · critical

  IMPORT FILE FORMAT  (bosun task import ./backlog.json)
    {
      "tasks": [
        {
          "title": "feat(ui): Add tabular numerals",
          "priority": "high",
          "status": "todo",
          "tags": ["ui", "css"],
          "implementation_steps": ["Edit variables.css", "Verify in portal"],
          "acceptance_criteria": ["Numeric columns align correctly"],
          "verification": ["Visual check in agents tab"]
        }
      ]
    }
`);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function normalizeTags(raw) {
  if (!raw) return [];
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  }
  return [];
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", reject);
    // If stdin is a TTY (no pipe), resolve empty after a short timeout
    if (process.stdin.isTTY) {
      resolve("");
    }
  });
}

// ── Direct execution support ──────────────────────────────────────────────────

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  runTaskCli(process.argv.slice(2)).catch((err) => {
    console.error(`${TAG} Fatal: ${err.message}`);
    process.exit(1);
  });
}
