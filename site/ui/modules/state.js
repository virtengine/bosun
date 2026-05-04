/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Reactive State Layer
 *  All signals, data loaders, toast system, and tab refresh logic
 * ────────────────────────────────────────────────────────────── */

import { signal } from "@preact/signals";
import { apiFetch, onWsMessage, withLoadingSuppressed, withLoadingTracked } from "./api.js";
import { cloneValue } from "./utils.js";
import { generateId } from "./utils.js";
import { cloudStorageGet } from "./telegram.js";

/* ═══════════════════════════════════════════════════════════════
 *  CLOUD STORAGE HELPER — mirrors settings.js pattern
 * ═══════════════════════════════════════════════════════════════ */

/** @param {string} key @returns {Promise<any>} */
function _cloudGet(key) {
  return new Promise((resolve) => {
    cloudStorageGet(key)
      .then((val) => {
        if (val == null) {
          try {
            const v = localStorage.getItem("ve_settings_" + key);
            resolve(v != null ? JSON.parse(v) : null);
          } catch {
            resolve(null);
          }
          return;
        }
        try { resolve(JSON.parse(val)); }
        catch { resolve(val); }
      })
      .catch(() => {
        try {
          const v = localStorage.getItem("ve_settings_" + key);
          resolve(v != null ? JSON.parse(v) : null);
        } catch {
          resolve(null);
        }
      });
  });
}

/* ═══════════════════════════════════════════════════════════════
 *  API RESPONSE CACHE — stale-while-revalidate
 * ═══════════════════════════════════════════════════════════════ */

const _apiCache = new Map();
const CACHE_TTL = {
  status: 5000, executor: 5000, tasks: 10000, agents: 5000,
  threads: 5000, logs: 15000, worktrees: 30000, workspaces: 30000,
  presence: 30000, config: 60000, projects: 60000, git: 20000,
  infra: 30000,
  benchmarks: 8000,
  telemetry: 15000,
  analytics: 30000,
  "server-state": 5000,
  "retry-queue": 5000,
};

function _cacheKey(url) { return url; }
function _cacheGet(url) { return _apiCache.get(url) || null; }
function _cacheSet(url, data) { _apiCache.set(url, { data, fetchedAt: Date.now() }); }
function _cacheFresh(url, group) {
  const e = _apiCache.get(url);
  return e ? (Date.now() - e.fetchedAt) < (CACHE_TTL[group] || 10000) : false;
}
function mergeTaskLinkageRecords(...sources) {
  const merged = [];
  const indexByKey = new Map();
  const keyFor = (record) => {
    if (!record || typeof record !== "object") return "";
    const branchName = String(record.branchName || "").trim().toLowerCase();
    const prUrl = String(record.prUrl || "").trim().toLowerCase();
    const prNumber = Number.parseInt(String(record.prNumber ?? ""), 10);
    return [branchName, Number.isFinite(prNumber) && prNumber > 0 ? prNumber : "", prUrl].join("|");
  };
  for (const source of sources) {
    const records = Array.isArray(source) ? source : [];
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const normalized = { ...record };
      const key = keyFor(normalized);
      if (!key) continue;
      if (indexByKey.has(key)) {
        const idx = indexByKey.get(key);
        merged[idx] = { ...merged[idx], ...normalized };
        continue;
      }
      indexByKey.set(key, merged.length);
      merged.push(normalized);
    }
  }
  return merged;
}

export function mergeTaskRecords(existingTask, incomingTask) {
  const merged = { ...(existingTask || {}), ...(incomingTask || {}) };
  const existingMeta = existingTask?.meta && typeof existingTask.meta === "object" ? existingTask.meta : {};
  const incomingMeta = incomingTask?.meta && typeof incomingTask.meta === "object" ? incomingTask.meta : {};
  merged.meta = { ...existingMeta, ...incomingMeta };
  const linkage = mergeTaskLinkageRecords(
    existingTask?.prLinkage,
    existingMeta?.prLinkage,
    incomingTask?.prLinkage,
    incomingMeta?.prLinkage,
  );
  if (linkage.length > 0) {
    merged.prLinkage = linkage;
    merged.meta.prLinkage = linkage;
    const primaryLinkage = linkage[0] || null;
    if (primaryLinkage?.branchName) merged.branchName = primaryLinkage.branchName;
    if (primaryLinkage?.prUrl) merged.prUrl = primaryLinkage.prUrl;
    if (Number.isFinite(primaryLinkage?.prNumber) && primaryLinkage.prNumber > 0) merged.prNumber = primaryLinkage.prNumber;
    merged.meta.prLinkageSource = primaryLinkage?.source || incomingMeta?.prLinkageSource || existingMeta?.prLinkageSource || null;
    merged.meta.prLinkageFreshness = primaryLinkage?.freshness || incomingMeta?.prLinkageFreshness || existingMeta?.prLinkageFreshness || null;
    merged.meta.prLinkageUpdatedAt = primaryLinkage?.updatedAt || incomingMeta?.prLinkageUpdatedAt || existingMeta?.prLinkageUpdatedAt || null;
  }
  return merged;
}

function _cacheClearGroup(group) {
  for (const k of _apiCache.keys()) {
    if (k.includes(group) || group === '*') _apiCache.delete(k);
  }
}

function getRetainedLoaderFallback(url, currentValue, applyCachedValue = null) {
  const cached = _cacheGet(url);
  const fallback = cached?.data ?? currentValue ?? null;
  if (cached && typeof applyCachedValue === "function") {
    applyCachedValue(cached.data);
  }
  return { cached, fallback };
}

/** Tracks last-fetch timestamps per data group for "Updated Xs ago" UI. */
export const dataFreshness = signal({});
function _markFresh(group) {
  dataFreshness.value = { ...dataFreshness.value, [group]: Date.now() };
}
export function sanitizeTaskText(value) {
  let text = String(value ?? "");
  for (const [pattern, replacement] of TASK_TEXT_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s{2,}/g, " ").trim();
}

export function isPlaceholderTaskDescription(value) {
  const text = sanitizeTaskText(value || "");
  if (!text) return false;
  const normalized = text.toLowerCase();
  return (
    TASK_TEMPLATE_PLACEHOLDER_RE.test(text) ||
    normalized === "internal server error" ||
    normalized === "{\"ok\":false,\"error\":\"internal server error\"}" ||
    normalized === "{\"error\":\"internal server error\"}"
  );
}

function synthesizeTaskDescription(task) {
  const title = sanitizeTaskText(task?.title || "");
  if (!title) {
    return "No description provided yet. Add scope, key files, and acceptance checks before dispatch.";
  }
  return `Implementation notes for "${title}". Include scope, key files, risks, and acceptance checks before dispatch.`;
}

function normalizeTaskDiagnosticsForUi(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object") return diagnostics;
  const stableCause = diagnostics.stableCause && typeof diagnostics.stableCause === "object"
    ? {
        ...diagnostics.stableCause,
        code: sanitizeTaskText(diagnostics.stableCause.code || ""),
        title: sanitizeTaskText(diagnostics.stableCause.title || ""),
        summary: sanitizeTaskText(diagnostics.stableCause.summary || ""),
      }
    : diagnostics.stableCause;
  return {
    ...diagnostics,
    stableCause,
    lastError: sanitizeTaskText(diagnostics.lastError || "") || null,
    errorPattern: sanitizeTaskText(diagnostics.errorPattern || "") || null,
    blockedReason: sanitizeTaskText(diagnostics.blockedReason || "") || null,
  };
}

function normalizeTaskForUi(task) {
  if (!task || typeof task !== "object") return task;
  const hydratedTask = mergeTaskRecords(null, task);
  const title = sanitizeTaskText(hydratedTask.title || "");
  const rawDescription = sanitizeTaskText(hydratedTask.description || "");
  const description = isPlaceholderTaskDescription(rawDescription) ? "" : rawDescription;
  const diagnostics = normalizeTaskDiagnosticsForUi(hydratedTask.diagnostics);
  const meta = hydratedTask.meta && typeof hydratedTask.meta === "object"
    ? {
        ...hydratedTask.meta,
        title: hydratedTask.meta.title != null ? sanitizeTaskText(hydratedTask.meta.title) : hydratedTask.meta.title,
        description:
          hydratedTask.meta.description != null
            ? (isPlaceholderTaskDescription(hydratedTask.meta.description)
              ? ""
              : sanitizeTaskText(hydratedTask.meta.description))
            : hydratedTask.meta.description,
        diagnostics: normalizeTaskDiagnosticsForUi(hydratedTask.meta.diagnostics),
      }
    : hydratedTask.meta;
  return {
    ...hydratedTask,
    title,
    description: description || synthesizeTaskDescription({ ...hydratedTask, title }),
    diagnostics,
    meta,
  };
}

function mergeTaskPages(existingTasks = [], incomingTasks = []) {
  const indexById = new Map();
  const merged = [];
  for (const task of existingTasks) {
    merged.push(task);
    indexById.set(String(task?.id ?? merged.length - 1), merged.length - 1);
  }
  for (const task of incomingTasks) {
    const key = String(task?.id ?? "");
    if (!key || !indexById.has(key)) {
      merged.push(task);
      if (key) indexById.set(key, merged.length - 1);
      continue;
    }
    merged[indexById.get(key)] = mergeTaskRecords(merged[indexById.get(key)], task);
  }
  return merged;
}


/* ═══════════════════════════════════════════════════════════════
 *  SIGNALS — Single source of truth for UI state
 * ═══════════════════════════════════════════════════════════════ */

// ── Overall connectivity
export const connected = signal(false);

// ── Dashboard
export const statusData = signal(null);
export const executorData = signal(null);
export const projectSummary = signal(null);
export const serverStateData = signal(null);

// ── Tasks
export const tasksLoaded = signal(false);
export const tasksData = signal([]);
export const tasksPage = signal(0);
export const tasksPageSize = signal(25);
export const tasksFilter = signal("all");
export const tasksPriority = signal("all");
export const tasksSearch = signal("");
export const tasksSort = signal("updated");
export const tasksTotalPages = signal(1);
export const tasksTotal = signal(0);
export const tasksStatusCounts = signal({ draft: 0, backlog: 0, blocked: 0, inProgress: 0, inReview: 0, done: 0 });

// ── Retry Queue
export const retryQueueData = signal({ count: 0, items: [] });
export const retryQueueLoaded = signal(false);

function normalizeRetryQueuePayload(payload) {
  return {
    count: Number(payload?.count || 0),
    items: Array.isArray(payload?.items) ? payload.items : [],
    stats: payload?.stats && typeof payload.stats === "object"
      ? {
          totalRetriesToday: Number(payload.stats.totalRetriesToday || 0),
          peakRetryDepth: Number(payload.stats.peakRetryDepth || 0),
          exhaustedTaskIds: Array.isArray(payload.stats.exhaustedTaskIds) ? payload.stats.exhaustedTaskIds : [],
        }
      : {
          totalRetriesToday: 0,
          peakRetryDepth: 0,
          exhaustedTaskIds: [],
        },
  };
}

export async function loadRetryQueue() {
  const url = "/api/retry-queue";
  if (_cacheFresh(url, "retry-queue")) return;
  const fallback = retryQueueData.value ?? { ok: false, items: [], count: 0, stats: null };
  const cached = _cacheGet(url);
  if (cached?.data) {
    retryQueueData.value = cached.data;
  }
  const res = await apiFetch(url, { _silent: true }).catch(() => (cached?.data ?? fallback));
  retryQueueData.value = normalizeRetryQueuePayload(res);
  _cacheSet(url, retryQueueData.value);
  _markFresh("retry-queue");
  retryQueueLoaded.value = true;
}

const TASK_IGNORE_LABEL = "codex:ignore";
const TASK_TEMPLATE_PLACEHOLDER_RE = /^\{\{\s*[\w.-]+\s*\}\}$/;
const TASK_TEXT_REPLACEMENTS = [
  [/\u00D4\u00C7\u00F6/g, "-"],
  [/\u00D4\u00C7\u00A3/g, "\""],
  [/\u00D4\u00C7\u00A5/g, "\""],
  [/\u00D4\u00C7\u00BF/g, "'"],
  [/\u00D4\u00C7\u2013/g, "'"],
  [/\u00E2\u20AC\u201D/g, "-"],
  [/\u00E2\u20AC\u201C/g, "-"],
  [/\u00E2\u20AC\u0153/g, "\""],
  [/\u00E2\u20AC\u009D/g, "\""],
  [/\u00E2\u20AC\u02DC/g, "'"],
  [/\u00E2\u20AC\u2122/g, "'"],
  [/\u00E2\u20AC\u00A6/g, "..."],
  [/\u00C2/g, " "],
];
const TASK_LIFECYCLE_IN_PROGRESS = new Set([
  "inprogress",
  "in-progress",
  "working",
  "active",
  "assigned",
  "running",
]);

const TASK_LIFECYCLE_BACKLOG = new Set([
  "todo",
  "backlog",
  "open",
  "new",
  "draft",
]);

export function normalizeTaskLifecycleStatus(status) {
  const raw = String(status || "").trim().toLowerCase();
  if (!raw) return "todo";
  if (TASK_LIFECYCLE_IN_PROGRESS.has(raw)) return "inprogress";
  if (raw === "inreview" || raw === "in-review" || raw === "review")
    return "inreview";
  if (raw === "done" || raw === "completed" || raw === "merged" || raw === "closed")
    return "done";
  if (raw === "cancelled" || raw === "canceled") return "cancelled";
  if (raw === "blocked") return "blocked";
  if (TASK_LIFECYCLE_BACKLOG.has(raw)) return raw === "draft" ? "draft" : "todo";
  return raw;
}

export function classifyTaskLifecycleAction(currentStatus, nextStatus) {
  const prev = normalizeTaskLifecycleStatus(currentStatus);
  const next = normalizeTaskLifecycleStatus(nextStatus);
  if (prev === next) return "noop";
  if (next === "inprogress" && prev !== "inprogress") return "start";
  if (prev === "inprogress" && (next === "todo" || next === "draft"))
    return "pause";
  return "update";
}


// ── Agents
export const agentsData = signal([]);
export const agentWorkspaceTarget = signal(null);
export const guardrailsData = signal(null);

// ── Infra
export const worktreeData = signal([]);
export const sharedWorkspaces = signal([]);
export const presenceInstances = signal([]);
export const coordinatorInfo = signal(null);
export const infraData = signal(null);

// ── Logs
export const logsData = signal(null);
export const logsLines = signal(100);
export const gitDiff = signal(null);
export const gitBranches = signal([]);
export const agentLogFiles = signal([]);
export const agentLogFilesMeta = signal({
  total: 0,
  offset: 0,
  limit: 100,
  count: 0,
  hasMore: false,
  nextOffset: 0,
  filterSummary: null,
});
export const agentLogFile = signal("");
export const agentLogTail = signal(null);
export const agentLogLines = signal(200);
export const agentLogQuery = signal("");
export const agentContext = signal(null);

// ── Telemetry
export const telemetrySummary = signal(null);
export const telemetryErrors = signal([]);
export const telemetryExecutors = signal({});
export const telemetryAlerts = signal([]);

// ── Context Shredding Telemetry
export const shreddingTelemetry = signal(null);

// ── Usage Analytics
export const usageAnalytics = signal(null);

// ── Config (routing, regions, etc.)
export const configData = signal(null);

// ── Benchmarks
export const benchmarksData = signal(null);
export const benchmarksLoaded = signal(false);

// ── Toasts
export const toasts = signal([]);

// ── Notification Preferences (loaded from CloudStorage)
export const notificationPrefs = signal({
  notifyUpdates: true,
  notifyErrors: true,
  notifyCompletion: true,
});

// ── Global unsaved-change registry
export const pendingChanges = signal({});
export const hasPendingChanges = signal(false);

function syncPendingFlag(next) {
  hasPendingChanges.value = Object.keys(next || {}).length > 0;
}

export function setPendingChange(source, isDirty = true) {
  const key = String(source || "").trim();
  if (!key) return;
  const current = pendingChanges.value || {};
  const next = { ...current };
  if (isDirty) {
    next[key] = Date.now();
  } else {
    delete next[key];
  }
  pendingChanges.value = next;
  syncPendingFlag(next);
}

export function clearPendingChange(source) {
  setPendingChange(source, false);
}

export function clearAllPendingChanges() {
  pendingChanges.value = {};
  hasPendingChanges.value = false;
}

/* ═══════════════════════════════════════════════════════════════
 *  NOTIFICATION PREFERENCES
 * ═══════════════════════════════════════════════════════════════ */

/** Load notification preferences from CloudStorage into signal */
export async function loadNotificationPrefs() {
  const [nu, ne, nc] = await Promise.all([
    _cloudGet("notifyUpdates"),
    _cloudGet("notifyErrors"),
    _cloudGet("notifyCompletion"),
  ]);
  notificationPrefs.value = {
    notifyUpdates: nu != null ? nu : true,
    notifyErrors: ne != null ? ne : true,
    notifyCompletion: nc != null ? nc : true,
  };
}

/** Critical message patterns that always show regardless of prefs */
const CRITICAL_PATTERNS = /\b(connection\s*lost|auth\s*(fail|error)|authentication\s*(fail|error)|unauthorized)\b/i;

/**
 * Determine if a toast should be rendered based on notification prefs.
 * Filtering happens at render time so toasts are still logged even if hidden.
 * @param {{ id: string, message: string, type: string }} toast
 * @returns {boolean}
 */
export function shouldShowToast(toast) {
  if (CRITICAL_PATTERNS.test(toast.message)) return true;

  const prefs = notificationPrefs.value;

  if (!prefs.notifyUpdates && (toast.type === "info" || toast.type === "success")) {
    return false;
  }
  if (!prefs.notifyErrors && toast.type === "error") {
    return false;
  }
  if (!prefs.notifyCompletion && /\b(complete[ds]?|done)\b/i.test(toast.message)) {
    return false;
  }

  return true;
}

/* ═══════════════════════════════════════════════════════════════
 *  LEGACY STORED DEFAULTS MIGRATION HOOK
 * ═══════════════════════════════════════════════════════════════ */

let _defaultsApplied = false;

/**
 * Reserved for one-time client preference migrations.
 * Executor runtime defaults now live only in Server Config.
 */
export async function applyStoredDefaults() {
  if (_defaultsApplied) return;
  _defaultsApplied = true;
}

/* ═══════════════════════════════════════════════════════════════
 *  TOAST SYSTEM
 * ═══════════════════════════════════════════════════════════════ */

/**
 * Show a toast notification that auto-dismisses after 3 s.
 * @param {string} message
 * @param {'info'|'success'|'error'|'warning'} type
 */
export function showToast(message, type = "info") {
  const id = generateId();
  toasts.value = [...toasts.value, { id, message, type }];
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, 3000);
}

// Listen for api-error events dispatched by the api module
if (typeof globalThis !== "undefined") {
  try {
    globalThis.addEventListener("ve:api-error", (e) => {
      showToast(e.detail?.message || "Request failed", "error");
    });
  } catch {
    /* SSR guard */
  }
}

/* ═══════════════════════════════════════════════════════════════
 *  DATA LOADERS — each calls apiFetch and updates its signal(s)
 * ═══════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════
 *  DASHBOARD HISTORY — localStorage-backed trend tracking
 * ═══════════════════════════════════════════════════════════════ */

const HISTORY_KEY = "ve-dashboard-history";
const HISTORY_MAX = 50;
const HISTORY_MIN_INTERVAL_MS = 30_000;

/** Read stored history from localStorage. */
export function getDashboardHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Compute trend delta between latest and previous snapshot for a metric.
 * Returns 0 when insufficient history.
 * @param {string} metric - one of: total, running, done, errors, successRate
 * @returns {number}
 */
export function getTrend(metric) {
  const hist = getDashboardHistory();
  if (hist.length < 2) return 0;
  const latest = hist[hist.length - 1];
  const prev = hist[hist.length - 2];
  return (latest[metric] ?? 0) - (prev[metric] ?? 0);
}

/** Save a dashboard snapshot after a successful status load. */
function _saveDashboardSnapshot() {
  try {
    const s = statusData.value;
    if (!s) return;
    const counts = s.counts || {};
    const running = Number(counts.running || counts.inprogress || 0);
    const review = Number(counts.review || counts.inreview || 0);
    const blocked = Number(counts.blocked ?? counts.error ?? 0);
    const done = Number(counts.done || 0);
    const backlog = Number(s.backlog_remaining || counts.todo || 0);
    const total = running + review + blocked + backlog + done;
    const successRate = total > 0 ? +((done / total) * 100).toFixed(1) : 0;

    const snap = { ts: Date.now(), total, running, done, errors: blocked, successRate };

    const hist = getDashboardHistory();

    // Deduplicate: skip if too recent and values unchanged
    if (hist.length > 0) {
      const last = hist[hist.length - 1];
      const elapsed = snap.ts - (last.ts || 0);
      const same =
        last.total === snap.total &&
        last.running === snap.running &&
        last.done === snap.done &&
        last.errors === snap.errors;
      if (elapsed < HISTORY_MIN_INTERVAL_MS && same) return;
    }

    hist.push(snap);
    // Trim to max length
    while (hist.length > HISTORY_MAX) hist.shift();

    localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
  } catch {
    /* localStorage may be unavailable */
  }
}

/** Load system status → statusData */
export async function loadStatus() {
  const url = "/api/status";
  const cached = _cacheGet(url);
  if (_cacheFresh(url, "status")) return;
  const fallback = cached?.data ?? statusData.value ?? null;
  if (cached) { statusData.value = cached.data; connected.value = true; }
  const res = await apiFetch(url, { _silent: true }).catch(() => ({
    data: fallback,
  }));
  statusData.value = res.data ?? fallback;
  const embeddedServerState = res?.serverState ?? statusData.value?.serverState ?? null;
  if (embeddedServerState) {
    serverStateData.value = embeddedServerState;
    _cacheSet("/api/server-state", serverStateData.value);
    _markFresh("server-state");
  }
  connected.value = true;
  _cacheSet(url, statusData.value);
  _markFresh("status");
  _saveDashboardSnapshot();
}

export async function loadServerState(options = {}) {
  const params = new URLSearchParams();
  if (options?.details) params.set("details", "1");
  const url = params.size > 0 ? `/api/server-state?${params}` : "/api/server-state";
  const cached = _cacheGet(url);
  if (_cacheFresh(url, "server-state")) return;
  const fallback = cached?.data ?? serverStateData.value ?? null;
  if (cached?.data) serverStateData.value = cached.data;
  const res = await apiFetch(url, { _silent: true }).catch(() => ({
    data: fallback,
  }));
  serverStateData.value = res?.data ?? res ?? fallback;
  _cacheSet(url, serverStateData.value);
  _markFresh("server-state");
}

/** Load executor state → executorData */
export async function loadExecutor() {
  const url = "/api/executor";
  const cached = _cacheGet(url);
  if (_cacheFresh(url, "executor")) return;
  const fallback = cached?.data ?? executorData.value ?? null;
  if (cached) executorData.value = cached.data;
  const res = await apiFetch(url, { _silent: true }).catch(() => fallback);
  executorData.value = res ?? fallback;
  _cacheSet(url, executorData.value);
  _markFresh("executor");
}

/** Large page size for kanban mode to load all tasks in one request */
export const KANBAN_PAGE_SIZE = 500;

/** Load tasks with current filter/page/sort → tasksData + tasksTotalPages */
export async function loadTasks(options = {}) {
  const append = Boolean(options?.append);
  const pageSizeOverride = options?.pageSize;
  // When doing a full (non-append) refresh, always reset to page 0 so we
  // don't accidentally fetch a stale later page and overwrite the full list.
  if (!append && tasksPage.value !== 0) {
    tasksPage.value = 0;
  }
  const effectivePageSize = pageSizeOverride || tasksPageSize.value;
  const params = new URLSearchParams({
    page: String(tasksPage.value),
    pageSize: String(effectivePageSize),
  });
  if (tasksFilter.value && tasksFilter.value !== "all")
    params.set("status", tasksFilter.value);
  if (tasksPriority.value && tasksPriority.value !== "all")
    params.set("priority", tasksPriority.value);
  if (tasksSearch.value) params.set("search", tasksSearch.value);
  if (tasksSort.value) params.set("sort", tasksSort.value);
  if (options?.fullRuntime === true) {
    params.set("includeStartGuards", "1");
    params.set("includeBlockedDiagnostics", "1");
    params.set("includeWorkflowRuns", "1");
    params.set("includeSupervisorDiagnostics", "1");
  } else {
    params.set("includeStartGuards", "0");
    params.set("includeBlockedDiagnostics", "0");
    params.set("includeWorkflowRuns", "0");
    params.set("includeSupervisorDiagnostics", "0");
  }

  const res = await apiFetch(`/api/tasks?${params}`, { _silent: true }).catch(
    (err) => {
      console.warn("[state] loadTasks fetch failed, keeping previous data:", err?.message || err);
      return {
        data: tasksData.value || [],
        total: tasksTotal.value || 0,
        totalPages: tasksTotalPages.value || 1,
        statusCounts: tasksStatusCounts.value || {},
        _fetchFailed: true,
      };
    },
  );
  const nextTasks = Array.isArray(res.data)
    ? res.data.map(normalizeTaskForUi)
    : [];
  tasksData.value = append
    ? mergeTaskPages(tasksData.value || [], nextTasks)
    : nextTasks;
  tasksTotalPages.value =
    res.totalPages ||
    Math.max(1, Math.ceil((res.total || 0) / effectivePageSize));
  tasksTotal.value = Math.max(0, Number(res.total || 0));
  tasksStatusCounts.value = {
    draft: Number(res?.statusCounts?.draft || 0),
    backlog: Number(res?.statusCounts?.backlog || 0),
    blocked: Number(res?.statusCounts?.blocked || 0),
    inProgress: Number(res?.statusCounts?.inProgress || 0),
    inReview: Number(res?.statusCounts?.inReview || 0),
    done: Number(res?.statusCounts?.done || 0),
  };
  tasksLoaded.value = true;
  _cacheSet(`/api/tasks?${params}`, { data: tasksData.value, totalPages: tasksTotalPages.value });
  _markFresh("tasks");
}

function normalizeLabelName(label) {
  return String(typeof label === "string" ? label : label?.name || "")
    .trim()
    .toLowerCase();
}

export function updateTaskManualState(taskId, isManual, reason = "") {
  if (!taskId) return;
  tasksData.value = tasksData.value.map((task) => {
    if (task?.id !== taskId) return task;
    const meta = { ...(task.meta || {}) };
    const codex = {
      ...(meta.codex || {}),
      isIgnored: Boolean(isManual),
      ...(isManual && reason ? { ignoreReason: reason } : {}),
    };
    if (!isManual && codex.ignoreReason) {
      delete codex.ignoreReason;
    }
    meta.codex = codex;

    const hadLabels = Array.isArray(meta.labels);
    const labels = hadLabels ? [...meta.labels] : [];
    const filtered = labels.filter(
      (label) => normalizeLabelName(label) !== TASK_IGNORE_LABEL,
    );
    if (isManual) filtered.push(TASK_IGNORE_LABEL);
    if (filtered.length || hadLabels) meta.labels = filtered;

    return { ...task, meta };
  });
}

/** Load active agents → agentsData */
export async function loadAgents() {
  const url = "/api/agents";
  if (_cacheFresh(url, "agents")) return;
  const { fallback } = getRetainedLoaderFallback(url, agentsData.value, (cachedData) => {
    agentsData.value = cachedData;
  });
  const res = await apiFetch(url, { _silent: true }).catch(() => ({
    data: fallback ?? [],
  }));
  agentsData.value = res.data ?? fallback ?? [];
  _cacheSet(url, agentsData.value);
  _markFresh("agents");
}

/** Load worktrees → worktreeData */
export async function loadWorktrees() {
  const url = "/api/worktrees";
  if (_cacheFresh(url, "worktrees")) return;
  const { fallback } = getRetainedLoaderFallback(url, worktreeData.value, (cachedData) => {
    worktreeData.value = cachedData;
  });
  const fallbackRows = Array.isArray(fallback)
    ? fallback
    : Array.isArray(fallback?.data)
      ? fallback.data
      : [];
  const fallbackStats = !Array.isArray(fallback) && fallback && typeof fallback === "object"
    ? fallback.stats ?? null
    : null;
  const res = await apiFetch(url, { _silent: true }).catch(() => ({
    data: fallbackRows,
    stats: fallbackStats,
  }));
  const payload = res?.stats
    ? { data: res.data || [], stats: res.stats }
    : res.data ?? fallbackRows;
  worktreeData.value = payload;
  _cacheSet(url, payload);
  _markFresh("worktrees");
}

/** Load infrastructure overview → infraData */
export async function loadInfra() {
  const url = "/api/infra";
  const cached = _cacheGet(url);
  if (_cacheFresh(url, "infra")) return;
  const fallback = cached?.data ?? infraData.value ?? null;
  if (cached) infraData.value = cached.data;
  const res = await apiFetch(url, { _silent: true }).catch(() => ({
    data: fallback,
  }));
  infraData.value = res.data ?? fallback;
  const embeddedServerState = res?.serverState ?? infraData.value?.serverState ?? null;
  if (embeddedServerState) {
    serverStateData.value = embeddedServerState;
    _cacheSet("/api/server-state", serverStateData.value);
    _markFresh("server-state");
  }
  _cacheSet(url, infraData.value);
  _markFresh("infra");
}

/** Load system logs → logsData */
export async function loadLogs(options = {}) {
  const url = `/api/logs?lines=${logsLines.value}`;
  const force = Boolean(options?.force);
  const cached = _cacheGet(url);
  if (!force && _cacheFresh(url, "logs")) return;
  const fallback = cached?.data ?? logsData.value ?? null;
  if (cached && !force) logsData.value = cached.data;
  const res = await apiFetch(url, { _silent: true }).catch(() => ({ data: fallback }));
  logsData.value = res.data ?? fallback;
  _cacheSet(url, logsData.value);
  _markFresh("logs");
}

/** Load git branches + diff → gitBranches, gitDiff */
export async function loadGit() {
  const branchFallback = Array.isArray(gitBranches.value) ? gitBranches.value : [];
  const diffFallback = typeof gitDiff.value === "string" ? gitDiff.value : "";
  const [branches, diff] = await Promise.all([
    apiFetch("/api/git/branches", { _silent: true }).catch(() => ({
      data: branchFallback,
    })),
    apiFetch("/api/git/diff", { _silent: true }).catch(() => ({ data: diffFallback })),
  ]);
  const branchRows = Array.isArray(branches?.data)
    ? branches.data
    : Array.isArray(branches)
      ? branches
      : Array.isArray(branches?.branches)
        ? branches.branches
        : [];
  gitBranches.value = branchRows;
  gitDiff.value = typeof diff?.data === "string" ? diff.data : (typeof diff === "string" ? diff : diffFallback);
}

/** Load agent log file list → agentLogFiles */
export async function loadAgentLogFileList(options = {}) {
  const offset = Math.max(0, Number(options?.offset || 0));
  const limit = Math.max(20, Math.min(500, Number(options?.limit || 100)));
  const sortBy = String(options?.sortBy || "modified");
  const sortDir = String(options?.sortDir || "desc");
  const age = String(options?.age || "all");
  const staleDays = Math.max(1, Math.min(90, Number(options?.staleDays || 7)));
  const params = new URLSearchParams();
  if (agentLogQuery.value) params.set("query", agentLogQuery.value);
  params.set("offset", String(offset));
  params.set("limit", String(limit));
  params.set("sortBy", sortBy);
  params.set("sortDir", sortDir);
  params.set("age", age);
  params.set("staleDays", String(staleDays));
  const path = params.toString()
    ? `/api/agent-logs?${params}`
    : "/api/agent-logs";
  const fallback = Array.isArray(agentLogFiles.value) ? agentLogFiles.value : [];
  const res = await apiFetch(path, { _silent: true }).catch(() => ({
    data: fallback,
    pagination: {
      total: 0,
      offset,
      limit,
      count: 0,
      hasMore: false,
      nextOffset: 0,
    },
  }));
  agentLogFiles.value = res.data ?? fallback;
  const pagination = res?.pagination || {
    total: agentLogFiles.value.length,
    offset,
    limit,
    count: agentLogFiles.value.length,
    hasMore: false,
    nextOffset: offset + agentLogFiles.value.length,
  };
  agentLogFilesMeta.value = {
    ...pagination,
    filterSummary: res?.filterSummary || null,
  };
}

/** Load tail of the currently selected agent log → agentLogTail */
export async function loadAgentLogTailData(options = {}) {
  if (!agentLogFile.value) {
    agentLogTail.value = null;
    return;
  }
  const params = new URLSearchParams({
    file: agentLogFile.value,
    lines: String(agentLogLines.value),
  });
  const query = String(agentLogQuery.value || "").trim();
  if (query) params.set("query", query);
  const url = `/api/agent-logs/tail?${params}`;
  const cached = _cacheGet(url);
  const fallback = cached?.data ?? agentLogTail.value ?? null;
  if (!options?.force && _cacheFresh(url, "logs")) {
    if (cached) {
      agentLogTail.value = cached.data;
      return;
    }
  }
  const res = await apiFetch(url, {
    _silent: true,
  }).catch(() => ({ data: fallback }));
  agentLogTail.value = res.data ?? res ?? fallback;
  _cacheSet(url, agentLogTail.value);
  _markFresh("logs");
}

/**
 * Load worktree context for a branch/query → agentContext
 * @param {string} query
 */
export async function loadAgentContextData(query) {
  if (!query) {
    agentContext.value = null;
    return;
  }
  const res = await apiFetch(
    `/api/agent-context?query=${encodeURIComponent(query)}`,
    { _silent: true },
  ).catch(() => ({ data: null }));
  agentContext.value = res.data ?? res ?? null;
}

/** Load shared workspaces → sharedWorkspaces */
export async function loadSharedWorkspaces() {
  const url = "/api/shared-workspaces";
  if (_cacheFresh(url, "workspaces")) return;
  const { fallback } = getRetainedLoaderFallback(url, sharedWorkspaces.value, (cachedData) => {
    sharedWorkspaces.value = cachedData;
  });
  const res = await apiFetch(url, { _silent: true }).catch(
    () => ({
      data: Array.isArray(fallback) ? fallback : [],
    }),
  );
  sharedWorkspaces.value = res.data ?? res.workspaces ?? fallback ?? [];
  _cacheSet(url, sharedWorkspaces.value);
  _markFresh("workspaces");
}

/** Load presence / coordinator → presenceInstances, coordinatorInfo */
export async function loadPresence() {
  const url = "/api/presence";
  if (_cacheFresh(url, "presence")) return;
  const fallback = {
    instances: Array.isArray(presenceInstances.value) ? presenceInstances.value : [],
    coordinator: coordinatorInfo.value ?? null,
  };
  const cached = _cacheGet(url);
  if (cached?.data && typeof cached.data === "object") {
    presenceInstances.value = Array.isArray(cached.data.instances) ? cached.data.instances : fallback.instances;
    coordinatorInfo.value = cached.data.coordinator ?? fallback.coordinator;
  }
  const res = await apiFetch(url, { _silent: true }).catch(() => ({
    data: cached?.data ?? fallback,
  }));
  const data = res.data ?? res ?? fallback;
  presenceInstances.value = data.instances || fallback.instances;
  coordinatorInfo.value = data.coordinator ?? fallback.coordinator;
  _cacheSet(url, data);
  _markFresh("presence");
}

/** Load project summary → projectSummary */
export async function loadProjectSummary() {
  const url = "/api/project-summary";
  const cached = _cacheGet(url);
  if (_cacheFresh(url, "projects")) return;
  const fallback = cached?.data ?? projectSummary.value ?? null;
  if (cached) projectSummary.value = cached.data;
  const res = await apiFetch(url, { _silent: true }).catch(
    () => ({
      data: fallback,
    }),
  );
  projectSummary.value = res.data ?? fallback;
  _cacheSet(url, projectSummary.value);
  _markFresh("projects");
}

/** Load config (routing, regions, etc.) → configData */
export async function loadConfig() {
  const url = "/api/config";
  const cached = _cacheGet(url);
  if (_cacheFresh(url, "config")) return;
  const fallback = cached?.data ?? configData.value ?? null;
  if (cached?.data) configData.value = cached.data;
  const res = await apiFetch(url, { _silent: true }).catch(() => null);
  configData.value = res?.ok ? res : fallback;
  _cacheSet(url, configData.value);
  _markFresh("config");
}

export async function loadTelemetrySummary() {
  const url = "/api/telemetry/summary";
  if (_cacheFresh(url, "telemetry")) return;
  const res = await apiFetch(url, { _silent: true }).catch(() => ({
    ok: false,
  }));
  telemetrySummary.value = res?.data ?? res ?? null;
  _cacheSet(url, telemetrySummary.value);
  _markFresh("telemetry");
}

export async function loadTelemetryErrors() {
  const url = "/api/telemetry/errors";
  if (_cacheFresh(url, "telemetry")) return;
  const res = await apiFetch(url, { _silent: true }).catch(() => ({
    ok: false,
  }));
  telemetryErrors.value = res?.data ?? res ?? [];
  _cacheSet(url, telemetryErrors.value);
  _markFresh("telemetry");
}

export async function loadTelemetryExecutors() {
  const url = "/api/telemetry/executors";
  if (_cacheFresh(url, "telemetry")) return;
  const res = await apiFetch(url, { _silent: true }).catch(() => ({
    ok: false,
  }));
  telemetryExecutors.value = res?.data ?? res ?? {};
  _cacheSet(url, telemetryExecutors.value);
  _markFresh("telemetry");
}

export async function loadTelemetryAlerts() {
  const url = "/api/telemetry/alerts";
  if (_cacheFresh(url, "telemetry")) return;
  const res = await apiFetch(url, { _silent: true }).catch(() => ({
    ok: false,
  }));
  telemetryAlerts.value = res?.data ?? res ?? [];
  _cacheSet(url, telemetryAlerts.value);
  _markFresh("telemetry");
}

export async function loadShreddingTelemetry(days = 30) {
  const url = `/api/telemetry/shredding?days=${days}`;
  const res = await apiFetch(url, { _silent: true }).catch(() => ({ ok: false }));
  shreddingTelemetry.value = res?.data ?? null;
}

/**
 * Load usage analytics. Pass `days=0` for all-time data.
 * The result is stored in the `usageAnalytics` signal.
 *
 * @param {number} [days=30]
 */
export async function loadUsageAnalytics(days = 30) {
  const url = `/api/analytics/usage?days=${days}`;
  // Don't use _cacheFresh here — callers pass explicit day window
  // and the period toggle must always trigger a fresh load.
  try {
    const res = await apiFetch(url, { _silent: true }).catch(() => ({ ok: false }));
    usageAnalytics.value = res?.data ?? null;
    _cacheSet(url, usageAnalytics.value);
    _markFresh("analytics");
  } catch {
    /* best effort */
  }
}

export async function loadBenchmarks(providerId = "") {
  const params = new URLSearchParams();
  if (providerId) params.set("provider", providerId);
  const url = params.size > 0 ? `/api/benchmarks?${params}` : "/api/benchmarks";
  const cached = _cacheGet(url);
  if (_cacheFresh(url, "benchmarks")) return;
  if (cached) benchmarksData.value = cached.data;
  const res = await apiFetch(url, { _silent: true }).catch(() => ({ ok: false }));
  benchmarksData.value = res?.data ?? null;
  benchmarksLoaded.value = true;
  _cacheSet(url, benchmarksData.value);
  _markFresh("benchmarks");
}

export async function loadGuardrails() {
  const url = "/api/guardrails";
  const cached = _cacheGet(url);
  if (_cacheFresh(url, "config")) return;
  if (cached) guardrailsData.value = cached.data;
  const res = await apiFetch(url, { _silent: true }).catch(() => ({ ok: false }));
  guardrailsData.value = res?.snapshot ?? null;
  _cacheSet(url, guardrailsData.value);
  _markFresh("config");
}

/* ═══════════════════════════════════════════════════════════════
 *  TAB REFRESH — map tab names to their required loaders
 * ═══════════════════════════════════════════════════════════════ */

const TAB_LOADERS = {
  dashboard: () =>
    Promise.all([
      loadStatus(),
      loadExecutor(),
      loadProjectSummary(),
      loadRetryQueue(),
      loadTasks({ pageSize: KANBAN_PAGE_SIZE }),
    ]),
  tasks: () => loadTasks({ pageSize: KANBAN_PAGE_SIZE }),
  benchmarks: () => loadBenchmarks(),
  agents: () => Promise.all([loadAgents(), loadExecutor(), import("../components/session-list.js").then((m) => m.loadSessions()).catch(() => {})]),
  guardrails: () => loadGuardrails(),
  infra: () =>
    Promise.all([
      loadWorktrees(),
      loadInfra(),
      loadSharedWorkspaces(),
      loadPresence(),
    ]),
  control: () => Promise.all([loadExecutor(), loadConfig()]),
  logs: () =>
    Promise.all([loadLogs(), loadGit(), loadAgentLogFileList(), loadAgentLogTailData()]),
  telemetry: () =>
    Promise.all([
      loadTelemetrySummary(),
      loadTelemetryErrors(),
      loadTelemetryExecutors(),
      loadTelemetryAlerts(),
      loadUsageAnalytics(30),
      loadRetryQueue(),
    ]),
  settings: () => Promise.all([loadStatus(), loadConfig(), loadServerState()]),
};

/**
 * Refresh all data for a given tab.
 * @param {string} tabName
 * @param {{ force?: boolean, background?: boolean, manual?: boolean }} [opts]
 */
async function runTabRefresh(tabName, opts = {}) {
  if (opts.force) _apiCache.clear();
  const loader = TAB_LOADERS[tabName];
  if (loader) {
    try {
      await loader();
    } catch {
      /* errors handled by individual loaders */
    }
  }
}

export async function refreshTab(tabName, opts = {}) {
  if (opts.background) {
    return withLoadingSuppressed(() => runTabRefresh(tabName, opts));
  }

  if (opts.manual !== false) {
    return withLoadingTracked(() => runTabRefresh(tabName, opts));
  }

  return runTabRefresh(tabName, opts);
}

/* ═══════════════════════════════════════════════════════════════
 *  HELPERS
 * ═══════════════════════════════════════════════════════════════ */

/**
 * Optimistic update pattern:
 * 1. Apply the optimistic change immediately
 * 2. Run the async fetch
 * 3. On error, revert via rollback
 *
 * @param {() => void} applyFn   – mutate signals optimistically
 * @param {() => Promise<any>} fetchFn  – the actual API call
 * @param {() => void} revertFn  – undo the optimistic change on error
 * @returns {Promise<any>}
 */
export async function runOptimistic(applyFn, fetchFn, revertFn) {
  try {
    applyFn();
    return await fetchFn();
  } catch (err) {
    if (typeof revertFn === "function") revertFn();
    throw err;
  }
}

/** @type {ReturnType<typeof setTimeout>|null} */
let _scheduleTimer = null;

/**
 * Schedule a tab refresh after a short delay (debounced).
 * Uses the the current activeTab from the router layer via import.
 * Falls back to refreshing 'dashboard'.
 *
 * @param {number} ms
 */
export function scheduleRefresh(ms = 5000) {
  if (_scheduleTimer) clearTimeout(_scheduleTimer);
  _scheduleTimer = setTimeout(async () => {
    _scheduleTimer = null;
    // Dynamic import to avoid circular dependency at module load time
    try {
      const { activeTab } = await import("./router.js");
      await refreshTab(activeTab.value, { background: true, manual: false });
    } catch {
      await refreshTab("dashboard", { background: true, manual: false });
    }
  }, ms);
}

/* ─── WebSocket invalidation listener ─── */

const WS_CHANNEL_MAP = {
  dashboard: ["overview", "executor", "tasks", "agents", "retry-queue"],
  tasks: ["tasks"],
  benchmarks: ["benchmarks", "tasks", "executor", "workflows", "workspaces", "library"],
  agents: ["agents", "executor"],
  infra: ["worktrees", "workspaces", "presence"],
  control: ["executor", "overview"],
  logs: ["*"],
  marketplace: ["library"],
  telemetry: ["*", "retry-queue"],
  settings: ["overview"],
};

/** Start listening for WS invalidation messages and auto-refreshing. */
export function initWsInvalidationListener() {
  onWsMessage((msg) => {
    if (msg?.type === "retry-queue-updated") {
      retryQueueData.value = normalizeRetryQueuePayload(msg?.payload);
      _cacheSet("/api/retry-queue", retryQueueData.value);
      _markFresh("retry-queue");
      retryQueueLoaded.value = true;
      return;
    }
    if (msg?.type !== "invalidate") return;
    const channels = Array.isArray(msg.channels) ? msg.channels : [];
    // Clear cache for invalidated channels so next fetch is fresh
    channels.forEach((ch) => _cacheClearGroup(ch));

    // Determine interested channels based on active tab
    import("./router.js")
      .then(({ activeTab }) => {
        const interested = WS_CHANNEL_MAP[activeTab.value] || ["*"];
        if (
          channels.includes("*") ||
          channels.some((c) => interested.includes(c))
        ) {
          scheduleRefresh(150);
        }
      })
      .catch(() => {
        /* noop */
      });
  });
}
