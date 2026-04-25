/**
 * kanban-adapter.mjs — Unified Kanban Board Abstraction
 *
 * Provides a common interface over multiple task-tracking backends:
 *   - Internal Store          — default, source-of-truth local kanban
 *   - GitHub Issues           — native GitHub integration with shared state persistence
 *   - Jira                    — enterprise project management via Jira REST v3
 *   - RepoMirror (projection-only)  — optional repo-backed projection registration
 *
 * This module handles TASK LIFECYCLE (tracking, status, metadata) only.
 * Code execution is handled separately by agent-pool.mjs.
 *
 * Configuration:
 *   - `KANBAN_BACKEND` env var: "internal" | "github" | "jira" | "repo-mirror" (default: "internal")
 *   - `bosun.config.json` → `kanban.backend` field
 *
 * EXPORTS:
 *   getKanbanAdapter()                       → Returns the configured adapter instance
 *   setKanbanBackend(name)                   → Switch backend at runtime
 *   getAvailableBackends()                   → List available backends
 *   getKanbanBackendName()                   → Get active backend name
 *   listProjects()                           → Convenience: adapter.listProjects()
 *   listTasks(projectId, f?)                 → Convenience: adapter.listTasks()
 *   getTask(taskId)                          → Convenience: adapter.getTask()
 *   updateTaskStatus(id, s, opts?)           → Convenience: adapter.updateTaskStatus()
 *   createTask(projId, data)                 → Convenience: adapter.createTask()
 *   deleteTask(taskId)                       → Convenience: adapter.deleteTask()
 *   addComment(taskId, body)                 → Convenience: adapter.addComment()
 *   persistSharedStateToIssue(id, state)     → GitHub/Jira: persist agent state to issue
 *   readSharedStateFromIssue(id)             → GitHub/Jira: read agent state from issue
 *   markTaskIgnored(id, reason)              → GitHub/Jira: mark task as ignored
 *   unmarkTaskIgnored(id)                    → GitHub/Jira: remove ignore marker
 *
 * Each adapter implements the KanbanAdapter interface:
 *   - listTasks(projectId, filters?)         → Task[]
 *   - getTask(taskId)                        → Task
 *   - updateTaskStatus(taskId, status, opts?)→ Task
 *   - createTask(projectId, task)            → Task
 *   - deleteTask(taskId)                     → boolean
 *   - listProjects()                         → Project[]
 *   - addComment(taskId, body)               → boolean
 *
 * GitHub adapter implements shared state methods:
 *   - persistSharedStateToIssue(num, state)  → boolean
 *   - readSharedStateFromIssue(num)          → SharedState|null
 *   - markTaskIgnored(num, reason)           → boolean
 *   - unmarkTaskIgnored(num)                 → boolean
 *
 * Jira adapter shared state methods:
 *   - persistSharedStateToIssue(key, state)  → boolean
 *   - readSharedStateFromIssue(key)          → SharedState|null
 *   - markTaskIgnored(key, reason)           → boolean
 *   - unmarkTaskIgnored(key)                 → boolean
 */

import { loadConfig } from "../config/config.mjs";
import { fetchWithFallback } from "../infra/fetch-runtime.mjs";
import {
  getAllTasks as getInternalTasks,
  getTask as getInternalTask,
  addTask as addInternalTask,
  setTaskStatus as setInternalTaskStatus,
  removeTask as removeInternalTask,
  updateTask as patchInternalTask,
  waitForStoreWrites,
} from "../task/task-store.mjs";
import {
  listTaskAttachments,
  mergeTaskAttachments,
} from "../task/task-attachments.mjs";
import { randomUUID } from "node:crypto";
import {
  buildProjectedTaskDocument,
  deleteProjectedTask,
  ensureProjectionScaffold,
  listProjectedMessagesForTask,
  listProjectedRunsForTask,
  listProjectedTaskRecords,
  materializeProjectedTask,
  readProjectedTaskRecord,
  rebuildAgentsRegistry,
  resolveRepoMirrorProjectionConfig,
  upsertProjectedTask,
} from "./repo-mirror-projection-store.mjs";

const TAG = "[kanban]";

// ---------------------------------------------------------------------------
// Normalised Task & Project Types
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} KanbanTask
 * @property {string}      id          Unique task identifier.
 * @property {string}      title       Task title/summary.
 * @property {string}      description Full task description/body.
 * @property {string}      status      Normalised status: "todo"|"inprogress"|"inreview"|"done"|"cancelled".
 * @property {string|null} assignee    Assigned user/agent.
 * @property {string|null} priority    "low"|"medium"|"high"|"critical".
 * @property {string|null} projectId   Parent project identifier.
 * @property {string|null} baseBranch  Base/epic branch for PRs.
 * @property {string|null} branchName  Associated git branch.
 * @property {string|null} prNumber    Associated PR number.
 * @property {object}      meta        Backend-specific metadata.
 * @property {string}      backend     Which backend this came from.
 */

/**
 * @typedef {Object} KanbanProject
 * @property {string} id     Unique project identifier.
 * @property {string} name   Project name.
 * @property {object} meta   Backend-specific metadata.
 * @property {string} backend Which backend.
 */

// ---------------------------------------------------------------------------
// Status Normalisation
// ---------------------------------------------------------------------------

/** Map from various backend status strings to our canonical set */
const STATUS_MAP = {
  todo: "todo",
  draft: "draft",
  inprogress: "inprogress",
  started: "inprogress",
  "in-progress": "inprogress",
  in_progress: "inprogress",
  inreview: "inreview",
  "in-review": "inreview",
  in_review: "inreview",
  "in review": "inreview",
  blocked: "blocked",
  done: "done",
  cancelled: "cancelled",
  canceled: "cancelled",
  backlog: "todo",
  // GitHub Issues
  open: "todo",
  closed: "done",
  // Jira-style
  "to do": "todo",
  "in progress": "inprogress",
  review: "inreview",
  resolved: "done",
};

function normaliseStatus(raw) {
  if (!raw) return "todo";
  const key = String(raw).toLowerCase().trim();
  return STATUS_MAP[key] || "todo";
}

function resolveCreateTaskInput(projectIdOrTaskData, taskDataArg = {}) {
  const payloadOnlyCall =
    projectIdOrTaskData &&
    typeof projectIdOrTaskData === "object" &&
    !Array.isArray(projectIdOrTaskData);
  const rawTaskData = payloadOnlyCall ? projectIdOrTaskData : (taskDataArg || {});
  const projectId = payloadOnlyCall
    ? rawTaskData?.projectId ?? rawTaskData?.project_id
    : projectIdOrTaskData;
  const {
    projectId: _ignoredProjectId,
    project_id: _ignoredProjectIdSnake,
    ...taskData
  } = rawTaskData || {};
  return { projectId, taskData };
}

const STATUS_LABEL_KEYS = new Set([
  "draft",
  "todo",
  "backlog",
  "inprogress",
  "started",
  "in-progress",
  "in_progress",
  "inreview",
  "in-review",
  "in_review",
  "blocked",
]);

const PRIORITY_LABEL_KEYS = new Set([
  "critical",
  "high",
  "medium",
  "low",
]);

const CODEX_LABEL_KEYS = new Set([
  "codex:ignore",
  "codex:claimed",
  "codex:working",
  "codex:stale",
  "bosun",
  "codex-mointor",
]);

const SYSTEM_LABEL_KEYS = new Set([
  ...STATUS_LABEL_KEYS,
  ...PRIORITY_LABEL_KEYS,
  ...CODEX_LABEL_KEYS,
  "done",
  "closed",
  "cancelled",
  "canceled",
]);

function statusFromLabels(labels) {
  if (!Array.isArray(labels)) return null;
  for (const label of labels) {
    const key = String(label || "")
      .trim()
      .toLowerCase();
    if (STATUS_LABEL_KEYS.has(key)) {
      return normaliseStatus(key);
    }
  }
  return null;
}

function normalizeSharedStatePayload(sharedState) {
  if (!sharedState || typeof sharedState !== "object") return null;
  const normalized = { ...sharedState };
  if (!normalized.ownerId && normalized.owner_id) {
    normalized.ownerId = normalized.owner_id;
  }
  if (!normalized.attemptToken && normalized.attempt_token) {
    normalized.attemptToken = normalized.attempt_token;
  }
  if (!normalized.attemptStarted && normalized.attempt_started) {
    normalized.attemptStarted = normalized.attempt_started;
  }
  if (!normalized.heartbeat && normalized.ownerHeartbeat) {
    normalized.heartbeat = normalized.ownerHeartbeat;
  }
  if (
    normalized.retryCount == null &&
    normalized.retry_count != null &&
    Number.isFinite(Number(normalized.retry_count))
  ) {
    normalized.retryCount = Number(normalized.retry_count);
  }
  if (
    !normalized.status &&
    normalized.attemptStatus &&
    ["claimed", "working", "stale"].includes(normalized.attemptStatus)
  ) {
    normalized.status = normalized.attemptStatus;
  }
  return normalized;
}

/**
 * Configurable mapping from internal statuses to GitHub Project v2 status names.
 * Override via GITHUB_PROJECT_STATUS_* env vars.
 */
const PROJECT_STATUS_MAP = {
  todo: process.env.GITHUB_PROJECT_STATUS_TODO || "Todo",
  inprogress: process.env.GITHUB_PROJECT_STATUS_INPROGRESS || "In Progress",
  inreview: process.env.GITHUB_PROJECT_STATUS_INREVIEW || "In Review",
  done: process.env.GITHUB_PROJECT_STATUS_DONE || "Done",
  cancelled: process.env.GITHUB_PROJECT_STATUS_CANCELLED || "Cancelled",
};

function parseBooleanEnv(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const key = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(key)) return true;
  if (["0", "false", "no", "off"].includes(key)) return false;
  return fallback;
}

function parseDelayMs(value, fallback, min = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}
const GH_TRANSIENT_ERROR_PATTERNS = [
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
  /http\s*502/i,
  /http\s*503/i,
  /http\s*504/i,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /socket hang up/i,
  /network error/i,
  /temporarily unavailable/i,
  /invalid character '<' looking for beginning of value/i,
  /unexpected token </i,
];

function sleepMs(ms) {
  const delay = Number(ms);
  if (!Number.isFinite(delay) || delay <= 0) {
    return Promise.resolve();
  }
  const setTimeoutFn = globalThis?.setTimeout;
  if (typeof setTimeoutFn !== "function") {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeoutFn(resolve, delay));
}

// ---------------------------------------------------------------------------
// Module-level GH API response caches — shared across all adapter instances
// to eliminate redundant API calls within the same polling window.
// ---------------------------------------------------------------------------

const GH_ISSUE_LIST_CACHE_TTL_MS =
  Number(process.env.GITHUB_ISSUES_LIST_CACHE_TTL_MS) || 3 * 60 * 1000; // 3 min

const GH_SHARED_STATE_CACHE_TTL_MS =
  Number(process.env.GITHUB_SHARED_STATE_CACHE_TTL_MS) || 5 * 60 * 1000; // 5 min

const GH_ISSUE_VIEW_CACHE_TTL_MS =
  Number(process.env.GH_ISSUE_VIEW_CACHE_TTL_MS) || 60 * 1000; // 1 min

const GH_ISSUE_VIEW_NEGATIVE_CACHE_TTL_MS =
  Number(process.env.GH_ISSUE_VIEW_NEGATIVE_CACHE_TTL_MS) || 5 * 60 * 1000; // 5 min

const GH_ISSUE_LOCATOR_CACHE_TTL_MS =
  Number(process.env.GH_ISSUE_LOCATOR_CACHE_TTL_MS) || 30 * 60 * 1000; // 30 min

const GH_READ_CACHE_TTL_MS =
  Number(process.env.GH_READ_CACHE_TTL_MS) || 30 * 1000; // 30 sec

const GH_ERROR_COOLDOWN_MS =
  Number(process.env.GH_ERROR_COOLDOWN_MS) || 60 * 1000; // 1 min

const GH_NOT_FOUND_COOLDOWN_MS =
  Number(process.env.GH_NOT_FOUND_COOLDOWN_MS) || 5 * 60 * 1000; // 5 min

function buildGitHubAdapterCacheNamespace(owner, repo) {
  const normalizedOwner = String(owner || "").trim().toLowerCase();
  const normalizedRepo = String(repo || "").trim().toLowerCase();
  if (normalizedOwner && normalizedRepo) return `${normalizedOwner}/${normalizedRepo}`;
  if (normalizedRepo) return normalizedRepo;
  return normalizedOwner || "unknown";
}

const GH_ADAPTER_CACHE_BUCKETS = new Map();

function createGitHubAdapterCacheBucket() {
  return {
    issueList: new Map(),
    sharedState: new Map(),
    issueLocator: new Map(),
    missingIssue: new Map(),
    ghRead: new Map(),
    ghInflight: new Map(),
    ghErrorCooldown: new Map(),
  };
}

function getGitHubAdapterCacheBucket(owner, repo) {
  const namespace = buildGitHubAdapterCacheNamespace(owner, repo);
  if (!GH_ADAPTER_CACHE_BUCKETS.has(namespace)) {
    GH_ADAPTER_CACHE_BUCKETS.set(namespace, createGitHubAdapterCacheBucket());
  }
  return GH_ADAPTER_CACHE_BUCKETS.get(namespace);
}

function clearGitHubAdapterCacheBuckets() {
  GH_ADAPTER_CACHE_BUCKETS.clear();
}

/** Build a cache key for the issue-list cache (per adapter instance). */
function _issueListCacheKey(repoKey, state, limit) {
  const normalizedRepo = String(repoKey || "").trim().toLowerCase();
  return `${normalizedRepo}:${state}:${limit}`;
}

/** Build a cache key for the shared-state cache (per adapter instance). */
function _sharedStateCacheKey(num, repoKey = "") {
  const normalizedNum = String(num || "").trim();
  const normalizedRepo = String(repoKey || "").trim().toLowerCase();
  return normalizedRepo ? `${normalizedRepo}#${normalizedNum}` : normalizedNum;
}

function _issueLocatorCacheKey(num, repoKey = "", owner = "", repo = "") {
  const normalizedNum = String(num || "")
    .trim()
    .replace(/^#/, "");
  const normalizedRepoKey =
    String(repoKey || "")
      .trim()
      .toLowerCase() ||
    buildGitHubAdapterCacheNamespace(owner, repo);
  return _sharedStateCacheKey(normalizedNum, normalizedRepoKey);
}

function parseIssueLocator(issueNumber, defaultOwner, defaultRepo, issueUrl = "") {
  const urlText = String(issueUrl || issueNumber || "").trim();
  const urlMatch = urlText.match(
    /github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)(?:\b|$)/i,
  );
  if (urlMatch) {
    const owner = String(urlMatch[1] || "").trim();
    const repo = String(urlMatch[2] || "")
      .trim()
      .replace(/\.git$/i, "");
    const number = String(urlMatch[3] || "").trim();
    return {
      owner,
      repo,
      number,
      repoKey: `${owner}/${repo}`.toLowerCase(),
    };
  }
  const number = String(issueNumber || "")
    .trim()
    .replace(/^#/, "");
  const owner = String(defaultOwner || "").trim();
  const repo = String(defaultRepo || "").trim();
  return {
    owner,
    repo,
    number,
    repoKey: `${owner}/${repo}`.toLowerCase(),
  };
}

function parseIssueRefLocator(issueRef, defaultOwner, defaultRepo, issueUrl = "") {
  const raw = String(issueRef || "").trim();
  const explicit = raw.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (explicit) {
    const owner = String(explicit[1] || "").trim();
    const repo = String(explicit[2] || "")
      .trim()
      .replace(/\.git$/i, "");
    const number = String(explicit[3] || "").trim();
    return {
      owner,
      repo,
      number,
      repoKey: `${owner}/${repo}`.toLowerCase(),
    };
  }
  return parseIssueLocator(issueRef, defaultOwner, defaultRepo, issueUrl);
}

function isGhRateLimitError(text) {
  const errText = String(text || "").toLowerCase();
  if (!errText) return false;
  return (
    errText.includes("rate limit") ||
    errText.includes("api rate limit exceeded") ||
    (errText.includes("403") && errText.includes("limit"))
  );
}

function isGhTransientError(text) {
  const errText = String(text || "").toLowerCase();
  if (!errText) return false;
  if (isGhRateLimitError(errText)) return false;
  return GH_TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(errText));
}

const GH_NOT_FOUND_ERROR_PATTERNS = [
  /could not resolve to an issue or pull request with the number/i,
  /repository\.issue/i,
  /\bnot found\b/i,
  /http\s*404/i,
];

const GH_AUTH_ERROR_PATTERNS = [
  /bad credentials/i,
  /requires authentication/i,
  /must authenticate/i,
  /authentication failed/i,
  /resource not accessible by integration/i,
  /http\s*401/i,
];

function buildGhRequestKey(args, parseJson = true) {
  const parts = Array.isArray(args) ? args : [args];
  return `${parseJson ? "json" : "text"}:${parts
    .map((entry) => String(entry ?? ""))
    .join("\u001f")}`;
}

function isGhGraphqlMutation(args) {
  if (!Array.isArray(args)) return false;
  if (String(args[0] || "").toLowerCase() !== "api") return false;
  const queryArg = args.find(
    (entry) =>
      typeof entry === "string" &&
      (entry.startsWith("query=") || entry.startsWith("-fquery=")),
  );
  if (!queryArg) return false;
  return /\bmutation\b/i.test(queryArg);
}

function isGhReadOnlyCommand(args) {
  if (!Array.isArray(args) || args.length === 0) return false;
  const cmd = String(args[0] || "").toLowerCase();
  const sub = String(args[1] || "").toLowerCase();

  if (cmd === "issue") {
    return sub === "view" || sub === "list";
  }

  if (cmd === "project") {
    return ["list", "view", "field-list", "item-list"].includes(sub);
  }

  if (cmd === "api") {
    const methodFlagIndex = args.findIndex(
      (entry) => String(entry || "").toLowerCase() === "-x",
    );
    if (methodFlagIndex >= 0) {
      const method = String(args[methodFlagIndex + 1] || "GET")
        .trim()
        .toUpperCase();
      if (method && method !== "GET") return false;
    }
    if (isGhGraphqlMutation(args)) return false;
    return true;
  }

  return false;
}

function classifyGhDeterministicError(text) {
  const raw = String(text || "");
  if (!raw) return null;
  if (isGhRateLimitError(raw) || isGhTransientError(raw)) return null;
  if (GH_NOT_FOUND_ERROR_PATTERNS.some((pattern) => pattern.test(raw))) {
    return "not_found";
  }
  if (GH_AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(raw))) {
    return "auth";
  }
  return null;
}

function isGhNotFoundError(text) {
  const errText = String(text || "").toLowerCase();
  if (!errText) return false;
  return (
    errText.includes("http 404") ||
    errText.includes("not found (http 404)") ||
    errText.includes("could not resolve to an issue or pull request with the number") ||
    errText.includes("(repository.issue)")
  );
}

function parseRepoSlug(raw) {
  const text = String(raw || "").trim().replace(/^https?:\/\/github\.com\//i, "");
  if (!text) return null;
  const cleaned = text.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const [owner, repo] = cleaned.split("/", 2);
  if (!owner || !repo) return null;
  return { owner, repo };
}

function extractBranchFromText(text) {
  const raw = String(text || "");
  if (!raw) return null;
  const tableMatch = raw.match(/\|\s*\*\*Branch\*\*\s*\|\s*`?([^`|\s]+)`?\s*\|/i);
  if (tableMatch?.[1]) return tableMatch[1];
  const inlineMatch = raw.match(/branch:\s*`?([^\s`]+)`?/i);
  if (inlineMatch?.[1]) return inlineMatch[1];
  return null;
}

function extractPrFromText(text) {
  const raw = String(text || "");
  if (!raw) return null;
  const tableMatch = raw.match(/\|\s*\*\*PR\*\*\s*\|\s*#?(\d+)/i);
  if (tableMatch?.[1]) return tableMatch[1];
  const inlineMatch = raw.match(/pr:\s*#?(\d+)/i);
  if (inlineMatch?.[1]) return inlineMatch[1];
  const urlMatch = raw.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/i);
  if (urlMatch?.[1]) return urlMatch[1];
  return null;
}

function isBosunStateComment(text) {
  const raw = String(text || "").toLowerCase();
  if (!raw) return false;
  return raw.includes("bosun-state") || raw.includes("codex:ignore");
}

function normalizeAttachmentName(name, url) {
  const raw = String(name || "").trim();
  if (raw && !/^(?:https?:)?\/\//i.test(raw)) return raw;
  if (!url) return raw || "attachment";
  try {
    const parsed = new URL(url);
    const base = decodeURIComponent(parsed.pathname.split("/").pop() || "");
    return base || raw || "attachment";
  } catch {
    const parts = String(url).split("/").filter(Boolean);
    return parts[parts.length - 1] || raw || "attachment";
  }
}

function guessAttachmentKind(url, name, isImage) {
  const text = `${url || ""} ${name || ""}`.toLowerCase();
  if (isImage) return "image";
  if (/\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/i.test(text)) return "image";
  return "file";
}

function guessContentType(name, kind) {
  const text = String(name || "").toLowerCase();
  if (kind === "image") {
    if (text.endsWith(".png")) return "image/png";
    if (text.endsWith(".jpg") || text.endsWith(".jpeg")) return "image/jpeg";
    if (text.endsWith(".gif")) return "image/gif";
    if (text.endsWith(".webp")) return "image/webp";
    if (text.endsWith(".svg")) return "image/svg+xml";
  }
  if (text.endsWith(".pdf")) return "application/pdf";
  if (text.endsWith(".json")) return "application/json";
  if (text.endsWith(".csv")) return "text/csv";
  if (text.endsWith(".txt") || text.endsWith(".log")) return "text/plain";
  if (text.endsWith(".zip")) return "application/zip";
  if (text.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (text.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return kind === "image" ? "image/*" : "application/octet-stream";
}

function isLikelyAttachmentUrl(url, isImage = false) {
  if (!url) return false;
  const text = String(url).trim();
  if (isImage) return true;

  let parsed = null;
  try {
    parsed = new URL(text);
  } catch {
    parsed = null;
  }

  if (parsed) {
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host === "user-images.githubusercontent.com") return true;
    if (host === "github.com" && path.startsWith("/user-attachments/")) return true;
    if (path.includes("/attachments/") || path.includes("/files/")) return true;
  }

  const lowered = text.toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|svg|pdf|json|csv|txt|log|zip|gz|tgz|xz|tar|rar|7z|docx?|xlsx?|pptx?)(\?|#|$)/i.test(lowered);
}

function extractMarkdownLinks(text) {
  const raw = String(text || "");
  if (!raw) return [];
  const results = [];
  const imageRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  const htmlImgRe = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  const htmlLinkRe = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  const urlRe = /\bhttps?:\/\/[^\s<>()]+/gi;

  let match;
  while ((match = imageRe.exec(raw))) {
    const url = String(match[2] || "").trim().split(/\s+/)[0];
    if (url) results.push({ url, label: match[1] || "", isImage: true });
  }
  while ((match = linkRe.exec(raw))) {
    const url = String(match[2] || "").trim().split(/\s+/)[0];
    if (url) results.push({ url, label: match[1] || "", isImage: false });
  }
  while ((match = htmlImgRe.exec(raw))) {
    const url = String(match[1] || "").trim();
    if (url) results.push({ url, label: "", isImage: true });
  }
  while ((match = htmlLinkRe.exec(raw))) {
    const url = String(match[1] || "").trim();
    if (url) results.push({ url, label: "", isImage: false });
  }
  while ((match = urlRe.exec(raw))) {
    const url = String(match[0] || "").trim();
    if (url) results.push({ url, label: "", isImage: false });
  }

  return results;
}

function normalizePrLinkageEntry(entry = {}, fallback = {}) {
  const safeEntry = entry && typeof entry === "object" ? entry : {};
  const safeFallback = fallback && typeof fallback === "object" ? fallback : {};
  const branchName = typeof (safeEntry.branchName ?? safeFallback.branchName) === "string"
    ? String(safeEntry.branchName ?? safeFallback.branchName).trim()
    : "";
  const prUrl = typeof (safeEntry.prUrl ?? safeFallback.prUrl) === "string"
    ? String(safeEntry.prUrl ?? safeFallback.prUrl).trim()
    : "";
  const parsedPrNumber = Number.parseInt(String(safeEntry.prNumber ?? safeFallback.prNumber ?? ""), 10);
  const prNumber = Number.isFinite(parsedPrNumber) && parsedPrNumber > 0 ? parsedPrNumber : null;
  if (!branchName && !prUrl && !prNumber) return null;
  return {
    branchName: branchName || null,
    prUrl: prUrl || null,
    prNumber,
    source: typeof (safeEntry.source ?? safeFallback.source) === "string" && String(safeEntry.source ?? safeFallback.source).trim()
      ? String(safeEntry.source ?? safeFallback.source).trim()
      : null,
    freshness: typeof (safeEntry.freshness ?? safeFallback.freshness) === "string" && String(safeEntry.freshness ?? safeFallback.freshness).trim()
      ? String(safeEntry.freshness ?? safeFallback.freshness).trim()
      : null,
    linkedAt: typeof (safeEntry.linkedAt ?? safeFallback.linkedAt) === "string" && String(safeEntry.linkedAt ?? safeFallback.linkedAt).trim()
      ? String(safeEntry.linkedAt ?? safeFallback.linkedAt).trim()
      : null,
    updatedAt: typeof (safeEntry.updatedAt ?? safeFallback.updatedAt) === "string" && String(safeEntry.updatedAt ?? safeFallback.updatedAt).trim()
      ? String(safeEntry.updatedAt ?? safeFallback.updatedAt).trim()
      : null,
  };
}

function buildPrLinkageKey(entry = {}) {
  const branchName = String(entry?.branchName || "").trim().toLowerCase();
  const prUrl = String(entry?.prUrl || "").trim().toLowerCase();
  const prNumber = Number.isFinite(entry?.prNumber) ? entry.prNumber : "";
  return [branchName, prNumber, prUrl].join("|");
}

function mergePrLinkageRecords(...sources) {
  const merged = [];
  const indexByKey = new Map();
  for (const source of sources) {
    const entries = Array.isArray(source) ? source : [];
    for (const rawEntry of entries) {
      const entry = normalizePrLinkageEntry(rawEntry);
      if (!entry) continue;
      const key = buildPrLinkageKey(entry);
      if (!key) continue;
      if (indexByKey.has(key)) {
        const idx = indexByKey.get(key);
        merged[idx] = normalizePrLinkageEntry({ ...merged[idx], ...entry }, merged[idx]);
        continue;
      }
      indexByKey.set(key, merged.length);
      merged.push(entry);
    }
  }
  return merged;
}

function promotePrimaryPrLinkage(records = [], preferred = {}) {
  const entries = Array.isArray(records)
    ? records.map((entry) => normalizePrLinkageEntry(entry)).filter(Boolean)
    : [];
  if (entries.length === 0) return [];
  const branchName = typeof preferred?.branchName === "string"
    ? preferred.branchName.trim()
    : "";
  const prUrl = typeof preferred?.prUrl === "string"
    ? preferred.prUrl.trim()
    : "";
  const parsedPrNumber =
    preferred?.prNumber == null || preferred?.prNumber === ""
      ? null
      : Number.parseInt(String(preferred.prNumber), 10);
  const prNumber =
    Number.isFinite(parsedPrNumber) && parsedPrNumber > 0 ? parsedPrNumber : null;
  if (!branchName && !prUrl && !prNumber) return entries;
  const matchesPreferred = (entry) =>
    (branchName && entry?.branchName === branchName)
    || (prUrl && entry?.prUrl === prUrl)
    || (prNumber && entry?.prNumber === prNumber);
  const promoted = normalizePrLinkageEntry({
    ...(branchName ? { branchName } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(prNumber ? { prNumber } : {}),
    updatedAt: new Date().toISOString(),
  }, entries.find(matchesPreferred) || entries[0] || {});
  if (!promoted) return entries;
  const promotedKey = buildPrLinkageKey(promoted);
  let skippedPromoted = false;
  const remaining = entries.filter((entry) => {
    if (skippedPromoted) return true;
    if (buildPrLinkageKey(entry) !== promotedKey) return true;
    skippedPromoted = true;
    return false;
  });
  return [promoted, ...remaining];
}

function buildPrLinkagePatch(options = {}, currentTask = null) {
  const branchName = typeof options?.branchName === "string" ? options.branchName.trim() : "";
  const prUrl = typeof options?.prUrl === "string" ? options.prUrl.trim() : "";
  const prNumber = options?.prNumber == null || options?.prNumber === ""
    ? null
    : Number.parseInt(String(options.prNumber), 10);
  if (!branchName && !prUrl && !(Number.isFinite(prNumber) && prNumber > 0)) {
    return {};
  }
  const source = typeof options?.source === "string" && options.source.trim() ? options.source.trim() : null;
  const freshness = typeof options?.freshness === "string" && options.freshness.trim() ? options.freshness.trim() : null;
  const currentMeta = currentTask?.meta && typeof currentTask.meta === "object" ? currentTask.meta : {};
  const currentLinkage = mergePrLinkageRecords(currentTask?.prLinkage, currentMeta?.prLinkage);
  const nextEntry = normalizePrLinkageEntry({
    branchName,
    prUrl,
    prNumber: Number.isFinite(prNumber) && prNumber > 0 ? prNumber : null,
    source,
    freshness,
    updatedAt: new Date().toISOString(),
    linkedAt: currentLinkage[0]?.linkedAt || new Date().toISOString(),
  }, currentLinkage[0] || {});
  if (!nextEntry) return {};
  const prLinkage = promotePrimaryPrLinkage(
    mergePrLinkageRecords(currentLinkage, [nextEntry]),
    nextEntry,
  );
  return {
    ...(nextEntry.branchName ? { branchName: nextEntry.branchName } : {}),
    ...(nextEntry.prUrl ? { prUrl: nextEntry.prUrl } : {}),
    ...(Number.isFinite(nextEntry.prNumber) && nextEntry.prNumber > 0 ? { prNumber: nextEntry.prNumber } : {}),
    prLinkage,
    meta: {
      ...currentMeta,
      prLinkage,
      prLinkageSource: nextEntry.source || currentMeta.prLinkageSource || null,
      prLinkageFreshness: nextEntry.freshness || currentMeta.prLinkageFreshness || null,
      prLinkageUpdatedAt: nextEntry.updatedAt || currentMeta.prLinkageUpdatedAt || null,
    },
  };
}

function extractAttachmentsFromText(text, meta = {}) {
  const links = extractMarkdownLinks(text);
  const attachments = [];
  for (const link of links) {
    if (!isLikelyAttachmentUrl(link.url, link.isImage)) continue;
    const name = normalizeAttachmentName(link.label, link.url);
    const kind = guessAttachmentKind(link.url, name, link.isImage);
    attachments.push({
      id: meta?.id || null,
      name,
      url: link.url,
      kind,
      contentType: meta?.contentType || guessContentType(name, kind),
      size: meta?.size ?? null,
      source: meta?.source || "unknown",
      sourceType: meta?.sourceType || null,
      commentId: meta?.commentId || null,
      author: meta?.author || null,
      createdAt: meta?.createdAt || null,
    });
  }
  return attachments;
}

function normalizeCommentList(comments) {
  if (!Array.isArray(comments)) return [];
  return comments
    .map((comment) => {
      const body =
        comment?.body ||
        comment?.bodyText ||
        comment?.body_html ||
        comment?.text ||
        "";
      const trimmed = String(body || "").trim();
      if (!trimmed || isBosunStateComment(trimmed)) return null;
      return {
        id: comment?.id || comment?.databaseId || null,
        author:
          comment?.author?.login ||
          comment?.author?.displayName ||
          comment?.author?.name ||
          null,
        createdAt: comment?.createdAt || comment?.created || null,
        body: trimmed,
        url: comment?.url || null,
      };
    })
    .filter(Boolean);
}

class InternalAdapter {
  constructor() {
    this.name = "internal";
  }

  _normalizeTask(task) {
    if (!task) return null;
    const embeddedPayload =
      task.projectId && typeof task.projectId === "object" && !Array.isArray(task.projectId)
        ? task.projectId
        : null;
    const hasEmbeddedTitle = String(embeddedPayload?.title || "").trim().length > 0;
    const title = String(task.title || "").trim();
    const recoveredTitle =
      hasEmbeddedTitle && (!title || title.toLowerCase() === "untitled task")
        ? String(embeddedPayload.title || "").trim()
        : title;
    const description =
      hasEmbeddedTitle && !String(task.description || "").trim()
        ? String(embeddedPayload?.description || "").trim()
        : String(task.description || "").trim();
    const resolvedProjectId =
      typeof task.projectId === "string" && task.projectId.trim()
        ? task.projectId
        : "internal";
    const recoveredStatus = String(embeddedPayload?.status || "").trim();
    const tags = normalizeTags(task.tags || task.meta?.tags || []);
    const hasExplicitDraftFlag = typeof task.draft === "boolean";
    const draft = hasExplicitDraftFlag
      ? task.draft === true
      : Boolean(
          task.meta?.draft ||
            task.status === "draft" ||
            recoveredStatus === "draft",
        );
    const labelBag = []
      .concat(Array.isArray(task.labels) ? task.labels : [])
      .concat(Array.isArray(task.tags) ? task.tags : [])
      .concat(Array.isArray(task.meta?.labels) ? task.meta.labels : [])
      .concat(Array.isArray(task.meta?.tags) ? task.meta.tags : []);
    const baseBranch = normalizeBranchName(
      task.baseBranch ||
        task.base_branch ||
        task.meta?.baseBranch ||
        task.meta?.base_branch ||
        extractBaseBranchFromLabels(labelBag) ||
        extractBaseBranchFromText(task.description || task.body || ""),
    );
    const rawComments = Array.isArray(task.meta?.comments)
      ? task.meta.comments
      : [];
    const normalizedComments = normalizeCommentList(rawComments);
    const assignee = normalizeTaskStringField(resolveTaskField(task, "assignee"));
    const assignees = normalizeTaskStringList(
      resolveTaskField(task, "assignees", assignee ? [assignee] : []),
    );
    const epicId = normalizeTaskStringField(resolveTaskField(task, "epicId"));
    const storyPoints = normalizeTaskNumericField(resolveTaskField(task, "storyPoints"));
    const parentTaskId = normalizeTaskStringField(
      resolveTaskField(task, "parentTaskId"),
    );
    const dueDate = normalizeTaskStringField(resolveTaskField(task, "dueDate"));
    const consecutiveNoCommits = Number(
      normalizeTaskNumericField(resolveTaskField(task, "consecutiveNoCommits")) || 0,
    );
    const cooldownUntil = normalizeTaskStringField(
      resolveTaskField(task, "cooldownUntil"),
    );
    const existingAttachments = []
      .concat(Array.isArray(task.attachments) ? task.attachments : [])
      .concat(Array.isArray(task.meta?.attachments) ? task.meta.attachments : []);
    const localAttachments = listTaskAttachments(task.id, "internal");
    const mergedAttachments = mergeTaskAttachments(
      existingAttachments,
      localAttachments,
    );
    const prLinkage = mergePrLinkageRecords(task.prLinkage, task.meta?.prLinkage, [normalizePrLinkageEntry(task, task)]);
    const primaryPrLinkage = prLinkage[0] || null;
    return {
      id: String(task.id || ""),
      title: recoveredTitle || "",
      description,
      status: normaliseStatus(task.status || recoveredStatus),
      assignee: assignee || assignees[0] || null,
      assignees,
      epicId,
      storyPoints,
      parentTaskId,
      dueDate,
      priority: task.priority || null,
      tags,
      draft,
      projectId: resolvedProjectId,
      workspace: task.workspace || task.meta?.workspace || null,
      repository: task.repository || task.meta?.repository || null,
      repositories:
        Array.isArray(task.repositories) && task.repositories.length > 0
          ? task.repositories
          : Array.isArray(task.meta?.repositories)
            ? task.meta.repositories
            : [],
      baseBranch,
      branchName: task.branchName || primaryPrLinkage?.branchName || null,
      prLinkage,
      prNumber: task.prNumber || primaryPrLinkage?.prNumber || null,
      prUrl: task.prUrl || primaryPrLinkage?.prUrl || null,
      taskUrl: task.taskUrl || null,
      createdAt: task.createdAt || null,
      updatedAt: task.updatedAt || null,
      lastActivityAt: task.lastActivityAt || task.updatedAt || null,
      consecutiveNoCommits,
      cooldownUntil,
      timeline: Array.isArray(task.timeline) ? task.timeline : [],
      workflowRuns: Array.isArray(task.workflowRuns) ? task.workflowRuns : [],
      statusHistory: Array.isArray(task.statusHistory) ? task.statusHistory : [],
      backend: "internal",
      attachments: mergedAttachments,
      comments: normalizedComments,
      meta: {
        ...(task.meta || {}),
        timeline: Array.isArray(task.timeline) ? task.timeline : (Array.isArray(task.meta?.timeline) ? task.meta.timeline : []),
        workflowRuns: Array.isArray(task.workflowRuns) ? task.workflowRuns : (Array.isArray(task.meta?.workflowRuns) ? task.meta.workflowRuns : []),
        statusHistory: Array.isArray(task.statusHistory) ? task.statusHistory : (Array.isArray(task.meta?.statusHistory) ? task.meta.statusHistory : []),
        comments: normalizedComments,
        attachments: mergedAttachments,
        consecutiveNoCommits,
        cooldownUntil,
        prLinkage,
        prLinkageSource: primaryPrLinkage?.source || task.meta?.prLinkageSource || null,
        prLinkageFreshness: primaryPrLinkage?.freshness || task.meta?.prLinkageFreshness || null,
        prLinkageUpdatedAt: primaryPrLinkage?.updatedAt || task.meta?.prLinkageUpdatedAt || null,
      },
    };
  }

  async listProjects() {
    return [
      {
        id: "internal",
        name: "Internal Task Store",
        backend: "internal",
        meta: {},
      },
    ];
  }

  async listTasks(projectId, filters = {}) {
    const statusFilter = filters?.status ? normaliseStatus(filters.status) : null;
    const limit = Number(filters?.limit || 0);
    const normalizedProjectId = String(projectId || "internal").trim().toLowerCase();

    let tasks = getInternalTasks().map((task) => this._normalizeTask(task));
    if (normalizedProjectId && normalizedProjectId !== "internal") {
      tasks = tasks.filter(
        (task) =>
          String(task.projectId || "internal").trim().toLowerCase() ===
          normalizedProjectId,
      );
    }
    if (statusFilter) {
      tasks = tasks.filter((task) => normaliseStatus(task.status) === statusFilter);
    }
    if (Number.isFinite(limit) && limit > 0) {
      tasks = tasks.slice(0, limit);
    }
    return tasks;
  }

  async getTask(taskId) {
    return this._normalizeTask(getInternalTask(String(taskId || "")));
  }

  async updateTaskStatus(taskId, status, options = {}) {
    const normalizedId = String(taskId || "").trim();
    if (!normalizedId) {
      throw new Error("[kanban] internal updateTaskStatus requires taskId");
    }
    const normalizedStatus = normaliseStatus(status);
    const source =
      options && typeof options === "object" && options.source
        ? String(options.source)
        : "orchestrator";
    const updated = setInternalTaskStatus(
      normalizedId,
      normalizedStatus,
      source,
    );
    if (!updated) {
      throw new Error(`[kanban] internal task not found: ${normalizedId}`);
    }
    const current = getInternalTask(normalizedId);
    const linkagePatch = buildPrLinkagePatch(options, current);
    const branchName =
      typeof options?.branchName === "string" ? options.branchName.trim() : "";
    const prUrl = typeof options?.prUrl === "string" ? options.prUrl.trim() : "";
    const prNumber =
      options?.prNumber == null || options?.prNumber === ""
        ? null
        : Number.parseInt(String(options.prNumber), 10);
    if (branchName) linkagePatch.branchName = branchName;
    if (prUrl) linkagePatch.prUrl = prUrl;
    if (Number.isFinite(prNumber) && prNumber > 0) linkagePatch.prNumber = prNumber;
    if (Object.keys(linkagePatch).length > 0) {
      const patched = patchInternalTask(normalizedId, linkagePatch);
      await waitForStoreWrites();
      if (patched) return this._normalizeTask(patched);
    }
    await waitForStoreWrites();
    return this._normalizeTask(updated);
  }

  async updateTask(taskId, patch = {}) {
    const normalizedId = String(taskId || "").trim();
    if (!normalizedId) {
      throw new Error("[kanban] internal updateTask requires taskId");
    }
    const updates = {};
    const baseBranch = resolveBaseBranchInput(patch);
    const baseBranchProvided =
      hasOwnField(patch, "baseBranch") ||
      hasOwnField(patch, "base_branch") ||
      hasOwnField(patch, "upstream_branch") ||
      hasOwnField(patch, "upstreamBranch") ||
      hasOwnField(patch, "upstream") ||
      hasOwnField(patch, "target_branch") ||
      hasOwnField(patch, "targetBranch") ||
      hasOwnField(patch, "base") ||
      hasOwnField(patch, "target");
    if (typeof patch.title === "string") updates.title = patch.title;
    if (typeof patch.description === "string") updates.description = patch.description;
    if (typeof patch.status === "string" && patch.status.trim()) {
      updates.status = normaliseStatus(patch.status);
    }
    if (typeof patch.priority === "string") updates.priority = patch.priority;
    if (typeof patch.workspace === "string") updates.workspace = patch.workspace;
    if (typeof patch.repository === "string") updates.repository = patch.repository;
    if (Array.isArray(patch.repositories)) updates.repositories = patch.repositories;
    if (hasOwnField(patch, "workflowRuns")) updates.workflowRuns = patch.workflowRuns;
    if (hasOwnField(patch, "workflowHistory")) updates.workflowHistory = patch.workflowHistory;
    if (hasOwnField(patch, "workflows")) updates.workflows = patch.workflows;
      if (hasOwnField(patch, "consecutiveNoCommits")) {
        updates.consecutiveNoCommits = Number(
          normalizeTaskNumericField(patch.consecutiveNoCommits) || 0,
        );
      }
    if (hasOwnField(patch, "cooldownUntil")) {
      updates.cooldownUntil = normalizeTaskStringField(patch.cooldownUntil);
    }
    if (hasOwnField(patch, "blockedReason")) {
      updates.blockedReason = normalizeTaskStringField(patch.blockedReason);
    }
    if (typeof patch.branchName === "string") {
      updates.branchName = patch.branchName.trim() || null;
    }
    if (typeof patch.prUrl === "string") {
      updates.prUrl = patch.prUrl.trim() || null;
    }
    if (hasOwnField(patch, "prNumber")) {
      const parsedPrNumber =
        patch.prNumber == null || patch.prNumber === ""
          ? null
          : Number.parseInt(String(patch.prNumber), 10);
      updates.prNumber =
        Number.isFinite(parsedPrNumber) && parsedPrNumber > 0 ? parsedPrNumber : null;
    }
    const assigneeProvided = hasOwnField(patch, "assignee");
    const assigneesProvided = hasOwnField(patch, "assignees");
    const assignee = normalizeTaskStringField(patch.assignee ?? patch.meta?.assignee);
    const assignees = normalizeTaskStringList(
      assigneesProvided
        ? patch.assignees
        : patch.meta?.assignees ?? (assignee ? [assignee] : []),
    );
    const epicId = normalizeTaskStringField(patch.epicId ?? patch.meta?.epicId);
    const storyPoints = normalizeTaskNumericField(patch.storyPoints ?? patch.meta?.storyPoints);
    const parentTaskId = normalizeTaskStringField(
      patch.parentTaskId ?? patch.meta?.parentTaskId,
    );
    const dueDate = normalizeTaskStringField(patch.dueDate ?? patch.meta?.dueDate);
    if (Array.isArray(patch.tags) || Array.isArray(patch.labels) || typeof patch.tags === "string") {
      updates.tags = normalizeTags(patch.tags ?? patch.labels);
    }
    if (typeof patch.draft === "boolean") {
      updates.draft = patch.draft;
      if (!patch.status) {
        updates.status = patch.draft ? "draft" : "todo";
      }
    }
    const current = getInternalTask(normalizedId);
    const replaceMeta = patch.replaceMeta === true;
    if (baseBranchProvided) {
      updates.baseBranch = baseBranch || null;
    }
    if (assigneeProvided || assignee || assignees.length > 0) {
      updates.assignee = assignee || assignees[0] || null;
      updates.assignees = assignees.length > 0 ? assignees : assignee ? [assignee] : [];
    }
    if (hasOwnField(patch, "epicId") || epicId) updates.epicId = epicId;
    if (hasOwnField(patch, "storyPoints") || storyPoints != null) {
      updates.storyPoints = storyPoints;
    }
    if (hasOwnField(patch, "parentTaskId") || parentTaskId) {
      updates.parentTaskId = parentTaskId;
    }
    if (hasOwnField(patch, "dueDate") || dueDate) updates.dueDate = dueDate;

    if (patch.meta && typeof patch.meta === "object") {
      const baseMeta = replaceMeta ? {} : { ...(current?.meta || {}) };
      if (!replaceMeta) {
        const clearingBlockedState =
          Object.prototype.hasOwnProperty.call(patch, "cooldownUntil") && patch.cooldownUntil == null &&
          Object.prototype.hasOwnProperty.call(patch, "blockedReason") && patch.blockedReason == null;
        if (clearingBlockedState) {
          delete baseMeta.autoRecovery;
          delete baseMeta.blockedReason;
          delete baseMeta.worktreeFailure;
        }
      }
      updates.meta = {
        ...baseMeta,
        ...patch.meta,
        ...((assigneeProvided || assignee || assignees.length > 0)
          ? {
            assignee: assignee || assignees[0] || null,
            assignees: assignees.length > 0 ? assignees : assignee ? [assignee] : [],
          }
          : {}),
        ...((hasOwnField(patch, "epicId") || epicId) ? { epicId } : {}),
        ...((hasOwnField(patch, "storyPoints") || storyPoints != null) ? { storyPoints } : {}),
        ...((hasOwnField(patch, "parentTaskId") || parentTaskId) ? { parentTaskId } : {}),
        ...((hasOwnField(patch, "dueDate") || dueDate) ? { dueDate } : {}),
        ...(typeof patch.workspace === "string" ? { workspace: patch.workspace } : {}),
        ...(typeof patch.repository === "string" ? { repository: patch.repository } : {}),
        ...(Array.isArray(patch.repositories) ? { repositories: patch.repositories } : {}),
        ...(baseBranch ? { base_branch: baseBranch, baseBranch } : {}),
      };
      if (baseBranchProvided && !baseBranch) {
        delete updates.meta.baseBranch;
        delete updates.meta.base_branch;
      }
      for (const [key, value] of Object.entries(patch.meta)) {
        if (value == null && Object.prototype.hasOwnProperty.call(updates.meta, key)) {
          delete updates.meta[key];
        }
      }
    } else if (baseBranchProvided) {
      updates.meta = {
        ...(current?.meta || {}),
        ...(baseBranch ? { base_branch: baseBranch, baseBranch } : {}),
      };
      if (!baseBranch) {
        delete updates.meta.baseBranch;
        delete updates.meta.base_branch;
      }
    }
    const directLinkage = promotePrimaryPrLinkage(
      mergePrLinkageRecords(
        current?.prLinkage,
        current?.meta?.prLinkage,
        patch.prLinkage,
        patch.meta?.prLinkage,
        [normalizePrLinkageEntry(patch, patch)],
      ),
      {
        branchName: updates.branchName,
        prUrl: updates.prUrl,
        prNumber: updates.prNumber,
      },
    );
    if (directLinkage.length > 0) {
      const primaryPrLinkage = directLinkage[0] || null;
      updates.prLinkage = directLinkage;
      updates.branchName = updates.branchName ?? primaryPrLinkage?.branchName ?? null;
      updates.prUrl = updates.prUrl ?? primaryPrLinkage?.prUrl ?? null;
      updates.prNumber = updates.prNumber ?? primaryPrLinkage?.prNumber ?? null;
      updates.meta = {
        ...(updates.meta || current?.meta || {}),
        prLinkage: directLinkage,
        prLinkageSource: primaryPrLinkage?.source || updates.meta?.prLinkageSource || current?.meta?.prLinkageSource || null,
        prLinkageFreshness: primaryPrLinkage?.freshness || updates.meta?.prLinkageFreshness || current?.meta?.prLinkageFreshness || null,
        prLinkageUpdatedAt: primaryPrLinkage?.updatedAt || updates.meta?.prLinkageUpdatedAt || current?.meta?.prLinkageUpdatedAt || null,
      };
    }
    const updated = patchInternalTask(normalizedId, updates);
    if (patch.meta && typeof patch.meta === "object" && updates.meta && typeof updates.meta === "object") {
      for (const [key, value] of Object.entries(patch.meta)) {
        if (value == null && Object.prototype.hasOwnProperty.call(updates.meta, key)) {
          delete updates.meta[key];
        }
      }
    }
    if (!updated) {
      throw new Error(`[kanban] internal task not found: ${normalizedId}`);
    }
    await waitForStoreWrites();
    return this._normalizeTask(updated);
  }

  async createTask(projectIdOrTaskData, taskDataArg = {}) {
    const { projectId, taskData } = resolveCreateTaskInput(
      projectIdOrTaskData,
      taskDataArg,
    );
    const id = String(taskData.id || randomUUID());
    const tags = normalizeTags(taskData.tags || taskData.labels || []);
    const draft = Boolean(taskData.draft || taskData.status === "draft");
    const baseBranch = resolveBaseBranchInput(taskData);
    const assignee = normalizeTaskStringField(taskData.assignee ?? taskData.meta?.assignee);
    const assignees = normalizeTaskStringList(
      taskData.assignees ?? taskData.meta?.assignees ?? (assignee ? [assignee] : []),
    );
    const epicId = normalizeTaskStringField(taskData.epicId ?? taskData.meta?.epicId);
    const storyPoints = normalizeTaskNumericField(
      taskData.storyPoints ?? taskData.meta?.storyPoints,
    );
    const parentTaskId = normalizeTaskStringField(
      taskData.parentTaskId ?? taskData.meta?.parentTaskId,
    );
    const dueDate = normalizeTaskStringField(taskData.dueDate ?? taskData.meta?.dueDate);
    const blockedReason = normalizeTaskStringField(
      taskData.blockedReason ?? taskData.meta?.blockedReason,
    );
    const created = addInternalTask({
      id,
      title: taskData.title || "Untitled task",
      description: taskData.description || "",
      status: draft ? "draft" : normaliseStatus(taskData.status || "todo"),
      assignee: assignee || assignees[0] || null,
      assignees,
      epicId,
      storyPoints,
      parentTaskId,
      dueDate,
      blockedReason,
      priority: taskData.priority || null,
      tags,
      draft,
      projectId: taskData.projectId || projectId || "internal",
      workspace:
        taskData.workspace ||
        taskData.meta?.workspace ||
        null,
      repository:
        taskData.repository ||
        taskData.repo ||
        taskData.meta?.repository ||
        taskData.meta?.repo ||
        null,
      repositories:
        Array.isArray(taskData.repositories) && taskData.repositories.length > 0
          ? taskData.repositories
          : Array.isArray(taskData.meta?.repositories)
            ? taskData.meta.repositories
            : [],
      baseBranch,
      meta: {
        ...(taskData.meta || {}),
        ...((assignee || assignees.length > 0)
          ? {
            assignee: assignee || assignees[0] || null,
            assignees: assignees.length > 0 ? assignees : assignee ? [assignee] : [],
          }
          : {}),
        ...(epicId ? { epicId } : {}),
        ...(storyPoints != null ? { storyPoints } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
        ...(dueDate ? { dueDate } : {}),
        ...(blockedReason ? { blockedReason } : {}),
        ...(taskData.workspace ? { workspace: taskData.workspace } : {}),
        ...(taskData.repository || taskData.repo
          ? { repository: taskData.repository || taskData.repo }
          : {}),
        ...(Array.isArray(taskData.repositories) ? { repositories: taskData.repositories } : {}),
        ...(tags.length ? { tags } : {}),
        ...(draft ? { draft: true } : {}),
        ...(baseBranch ? { base_branch: baseBranch, baseBranch } : {}),
      },
    });
    if (!created) {
      throw new Error("[kanban] internal task creation failed");
    }
    await waitForStoreWrites();
    return this._normalizeTask(created);
  }

  async deleteTask(taskId) {
    return removeInternalTask(String(taskId || ""));
  }

  async addComment(taskId, body) {
    const id = String(taskId || "").trim();
    const comment = String(body || "").trim();
    if (!id || !comment) return false;

    const current = getInternalTask(id);
    if (!current) return false;

    const comments = Array.isArray(current?.meta?.comments)
      ? [...current.meta.comments]
      : [];
    comments.push({
      body: comment,
      createdAt: new Date().toISOString(),
      source: "kanban-adapter/internal",
    });

    const patched = patchInternalTask(id, {
      meta: {
        ...(current.meta || {}),
        comments,
      },
    });

    return Boolean(patched);
  }
}

function normalizeLabels(raw) {
  const values = Array.isArray(raw)
    ? raw
    : String(raw || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
  const seen = new Set();
  const labels = [];
  for (const value of values) {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    labels.push(normalized);
  }
  return labels;
}

function normalizeTags(raw) {
  return normalizeLabels(raw);
}

function hasOwnField(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function normalizeTaskStringField(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeTaskStringList(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const seen = new Set();
  const normalized = [];
  for (const entry of values) {
    const next = normalizeTaskStringField(entry?.login || entry?.name || entry);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    normalized.push(next);
  }
  return normalized;
}

function normalizeTaskNumericField(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function resolveTaskField(task, key, fallback = null) {
  if (task?.[key] != null) return task[key];
  if (task?.meta?.[key] != null) return task.meta[key];
  return fallback;
}

function parseTaskTimestampMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickLatestTimestamp(...values) {
  let winner = null;
  let winnerMs = 0;
  for (const value of values) {
    const normalized = normalizeTaskStringField(value);
    if (!normalized) continue;
    const parsed = parseTaskTimestampMs(normalized);
    if (!winner || parsed >= winnerMs) {
      winner = normalized;
      winnerMs = parsed;
    }
  }
  return winner;
}

function mergeTaskStringLists(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const value of normalizeTaskStringList(list)) {
      if (seen.has(value)) continue;
      seen.add(value);
      merged.push(value);
    }
  }
  return merged;
}

function mergeTaskCommentCollections(...lists) {
  const merged = new Map();
  let sequence = 0;
  for (const list of lists) {
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry || typeof entry !== "object") continue;
      const normalized = { ...entry };
      const key =
        normalizeTaskStringField(normalized.id) ||
        [
          normalizeTaskStringField(normalized.body),
          normalizeTaskStringField(normalized.author),
          normalizeTaskStringField(normalized.source),
          normalizeTaskStringField(normalized.createdAt),
        ].join("|") ||
        `comment-${sequence++}`;
      const current = merged.get(key) || {};
      merged.set(key, { ...current, ...normalized });
    }
  }
  return [...merged.values()].sort((left, right) =>
    String(left?.createdAt || "").localeCompare(String(right?.createdAt || "")),
  );
}

function mergeTaskWorkflowRunCollections(...lists) {
  const merged = new Map();
  let sequence = 0;
  for (const list of lists) {
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry || typeof entry !== "object") continue;
      const normalized = { ...entry };
      const key =
        normalizeTaskStringField(normalized.runId) ||
        [
          normalizeTaskStringField(normalized.workflowId),
          normalizeTaskStringField(normalized.startedAt),
          normalizeTaskStringField(normalized.endedAt),
          normalizeTaskStringField(normalized.source),
          normalizeTaskStringField(normalized.summary),
        ].join("|") ||
        `run-${sequence++}`;
      const current = merged.get(key) || {};
      merged.set(key, { ...current, ...normalized });
    }
  }
  return [...merged.values()].sort((left, right) =>
    String(left?.startedAt || left?.endedAt || "").localeCompare(
      String(right?.startedAt || right?.endedAt || ""),
    ),
  );
}

function mergeTaskTimelineCollections(...lists) {
  const merged = new Map();
  let sequence = 0;
  for (const list of lists) {
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry || typeof entry !== "object") continue;
      const normalized = { ...entry };
      const key =
        [
          normalizeTaskStringField(normalized.type),
          normalizeTaskStringField(normalized.status),
          normalizeTaskStringField(normalized.to_status || normalized.toStatus),
          normalizeTaskStringField(normalized.timestamp),
          normalizeTaskStringField(normalized.message),
          normalizeTaskStringField(normalized.source),
          normalizeTaskStringField(normalized.actor),
        ].join("|") ||
        `timeline-${sequence++}`;
      const current = merged.get(key) || {};
      merged.set(key, { ...current, ...normalized });
    }
  }
  return [...merged.values()].sort((left, right) =>
    String(left?.timestamp || "").localeCompare(String(right?.timestamp || "")),
  );
}

function mergeTaskStatusHistoryCollections(...lists) {
  const merged = new Map();
  let sequence = 0;
  for (const list of lists) {
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry || typeof entry !== "object") continue;
      const normalized = { ...entry };
      const key =
        [
          normalizeTaskStringField(normalized.status),
          normalizeTaskStringField(normalized.timestamp),
          normalizeTaskStringField(normalized.source),
          normalizeTaskStringField(normalized.actor),
        ].join("|") ||
        `status-history-${sequence++}`;
      const current = merged.get(key) || {};
      merged.set(key, { ...current, ...normalized });
    }
  }
  return [...merged.values()].sort((left, right) =>
    String(left?.timestamp || "").localeCompare(String(right?.timestamp || "")),
  );
}

function buildProjectedStatusHistory(projectedTask = {}) {
  const history = [];
  const timeline = Array.isArray(projectedTask?.meta?.timeline)
    ? projectedTask.meta.timeline
    : [];
  for (const entry of timeline) {
    const rawStatus = normalizeTaskStringField(
      entry?.to_status || entry?.toStatus || entry?.status,
    );
    if (!rawStatus) continue;
    history.push({
      status: normaliseStatus(rawStatus),
      source: normalizeTaskStringField(entry?.source) || "repo-mirror-projection",
      actor: normalizeTaskStringField(entry?.actor),
      timestamp: normalizeTaskStringField(entry?.timestamp),
    });
  }
  return history;
}

function mergeProjectedTaskIntoLocal(localTask = {}, projectedTask = null) {
  if (!projectedTask?.id) return localTask;
  const comments = mergeTaskCommentCollections(localTask.comments, projectedTask.comments);
  const attachments = mergeTaskAttachments(localTask.attachments, projectedTask.attachments);
  const workflowRuns = mergeTaskWorkflowRunCollections(
    localTask.workflowRuns,
    projectedTask.workflowRuns,
  );
  const timeline = mergeTaskTimelineCollections(
    localTask.timeline,
    localTask.meta?.timeline,
    projectedTask.meta?.timeline,
  );
  const statusHistory = mergeTaskStatusHistoryCollections(
    localTask.statusHistory,
    localTask.meta?.statusHistory,
    buildProjectedStatusHistory(projectedTask),
  );
  const assignees = mergeTaskStringLists(localTask.assignees, projectedTask.assignees);
  return {
    ...localTask,
    assignee: localTask.assignee || projectedTask.assignee || assignees[0] || null,
    assignees,
    projectId: localTask.projectId || projectedTask.projectId || "repo-mirror",
    workspace: localTask.workspace || projectedTask.workspace || null,
    repository: localTask.repository || projectedTask.repository || null,
    repositories: mergeTaskStringLists(localTask.repositories, projectedTask.repositories),
    tags: mergeTaskStringLists(localTask.tags, projectedTask.tags),
    draft: localTask.draft === true || projectedTask.draft === true,
    baseBranch: localTask.baseBranch || projectedTask.baseBranch || null,
    branchName: localTask.branchName || projectedTask.branchName || null,
    prNumber: localTask.prNumber ?? projectedTask.prNumber ?? null,
    prUrl: localTask.prUrl || projectedTask.prUrl || null,
    updatedAt: pickLatestTimestamp(localTask.updatedAt, projectedTask.updatedAt),
    lastActivityAt: pickLatestTimestamp(
      localTask.lastActivityAt,
      localTask.updatedAt,
      projectedTask.lastActivityAt,
      projectedTask.updatedAt,
    ),
    comments,
    attachments,
    workflowRuns,
    timeline,
    statusHistory,
    meta: {
      ...(localTask.meta || {}),
      timeline,
      statusHistory,
      comments,
      attachments,
      workflowRuns,
      evidence: projectedTask.meta?.evidence || localTask.meta?.evidence || {},
    },
  };
}

function looksLikeKanbanEntity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    "id" in value ||
    "project_id" in value ||
    "task_id" in value ||
    "name" in value ||
    "title" in value ||
    "status" in value ||
    "key" in value ||
    "number" in value
  );
}

function normalizeObjectCollection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const candidates = Object.entries(value)
    .filter(([, candidate]) => looksLikeKanbanEntity(candidate))
    .map(([key, candidate]) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return candidate;
      }
      const rawId = candidate.id ?? candidate.task_id ?? candidate.project_id;
      if (rawId != null && String(rawId).trim()) return candidate;
      const mapKey = String(key || "").trim();
      if (!mapKey) return candidate;
      return { ...candidate, id: mapKey };
    });
  if (candidates.length > 0) return candidates;
  if (looksLikeKanbanEntity(value)) return [value];
  return [];
}

function findNestedCollectionByKeys(node, keys, depth = 0, visited = new Set()) {
  if (!node || typeof node !== "object") return [];
  if (depth > 4) return [];
  if (visited.has(node)) return [];
  visited.add(node);

  if (Array.isArray(node)) {
    for (const entry of node) {
      const nested = findNestedCollectionByKeys(entry, keys, depth + 1, visited);
      if (nested.length > 0) return nested;
    }
    return [];
  }

  for (const key of keys) {
    const value = node[key];
    if (Array.isArray(value)) return value;
    const normalized = normalizeObjectCollection(value);
    if (normalized.length > 0) return normalized;
  }

  for (const value of Object.values(node)) {
    const nested = findNestedCollectionByKeys(value, keys, depth + 1, visited);
    if (nested.length > 0) return nested;
  }

  return [];
}

function extractArrayPayload(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
    const normalized = normalizeObjectCollection(payload[key]);
    if (normalized.length > 0) return normalized;
  }

  const data = payload.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const key of keys) {
      if (Array.isArray(data[key])) return data[key];
      const normalized = normalizeObjectCollection(data[key]);
      if (normalized.length > 0) return normalized;
    }
    const normalizedData = normalizeObjectCollection(data);
    if (normalizedData.length > 0) return normalizedData;
  }

  const nested = findNestedCollectionByKeys(payload, keys);
  if (nested.length > 0) return nested;

  const normalizedPayload = normalizeObjectCollection(payload);
  if (normalizedPayload.length > 0) return normalizedPayload;

  return [];
}

const UPSTREAM_LABEL_REGEX =
  /^(?:upstream|base|target)(?:_branch)?[:=]\s*([A-Za-z0-9._/-]+)$/i;

function normalizeBranchName(value) {
  if (!value) return null;
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed : null;
}

function isUpstreamLabel(label) {
  if (!label) return false;
  return UPSTREAM_LABEL_REGEX.test(String(label || "").trim());
}

function extractBaseBranchFromLabels(labels) {
  if (!Array.isArray(labels)) return null;
  for (const label of labels) {
    const match = String(label || "").trim().match(UPSTREAM_LABEL_REGEX);
    if (match?.[1]) return normalizeBranchName(match[1]);
  }
  return null;
}

function extractBaseBranchFromText(text) {
  if (!text) return null;
  const match = String(text || "").match(
    /\b(?:(?:upstream|base)(?:_branch| branch)?|target(?:_branch| branch))\s*[:=]\s*([A-Za-z0-9._/-]+)/i,
  );
  if (!match?.[1]) return null;
  return normalizeBranchName(match[1]);
}

function resolveBaseBranchInput(payload) {
  if (!payload) return null;
  const candidate =
    payload.base_branch ||
    payload.baseBranch ||
    payload.upstream_branch ||
    payload.upstreamBranch ||
    payload.upstream ||
    payload.target_branch ||
    payload.targetBranch ||
    payload.base;
  return normalizeBranchName(candidate);
}

function upsertBaseBranchMarker(text, baseBranch) {
  const branch = normalizeBranchName(baseBranch);
  if (!branch) return String(text || "");
  const source = String(text || "");
  const pattern =
    /\b(?:(?:upstream|base)(?:_branch| branch)?|target(?:_branch| branch))\s*[:=]\s*([A-Za-z0-9._/-]+)/i;
  if (pattern.test(source)) {
    return source.replace(pattern, `base_branch: ${branch}`);
  }
  const separator = source.trim().length ? "\n\n" : "";
  return `${source}${separator}base_branch: ${branch}`.trim();
}

function extractTagsFromLabels(labels, extraSystem = []) {
  const normalized = normalizeLabels(labels);
  const extra = new Set(normalizeLabels(extraSystem));
  return normalized.filter(
    (label) =>
      !SYSTEM_LABEL_KEYS.has(label) &&
      !extra.has(label) &&
      !isUpstreamLabel(label),
  );
}

// ---------------------------------------------------------------------------
// GitHub Issues Adapter
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SharedState
 * @property {string} ownerId - Workstation/agent identifier (e.g., "workstation-123/agent-456")
 * @property {string} attemptToken - Unique UUID for this claim attempt
 * @property {string} attemptStarted - ISO 8601 timestamp of claim start
 * @property {string} heartbeat - ISO 8601 timestamp of last heartbeat
 * @property {string} status - Current status: "claimed"|"working"|"stale"
 * @property {number} retryCount - Number of retry attempts
 */

class GitHubIssuesAdapter {
  constructor() {
    this.name = "github";
    const config = loadConfig();
    const slugInfo =
      parseRepoSlug(process.env.GITHUB_REPOSITORY) ||
      parseRepoSlug(config?.repoSlug) ||
      parseRepoSlug(
        process.env.GITHUB_REPO_OWNER && process.env.GITHUB_REPO_NAME
          ? `${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}`
          : "",
      );
    this._owner = process.env.GITHUB_REPO_OWNER || slugInfo?.owner || "unknown";
    this._repo = process.env.GITHUB_REPO_NAME || slugInfo?.repo || "unknown";

    // bosun label scheme
    this._codexLabels = {
      claimed: "codex:claimed",
      working: "codex:working",
      stale: "codex:stale",
      ignore: "codex:ignore",
    };

    this._canonicalTaskLabel =
      process.env.BOSUN_TASK_LABEL || "bosun";
    this._taskScopeLabels = normalizeLabels(
      process.env.BOSUN_TASK_LABELS ||
        `${this._canonicalTaskLabel},codex-monitor`,
    );
    this._enforceTaskLabel = parseBooleanEnv(
      process.env.BOSUN_ENFORCE_TASK_LABEL,
      true,
    );

    this._autoAssignCreator = parseBooleanEnv(
      process.env.GITHUB_AUTO_ASSIGN_CREATOR,
      true,
    );
    this._defaultAssignee =
      String(process.env.GITHUB_DEFAULT_ASSIGNEE || "").trim() || null;

    this._projectMode = String(process.env.GITHUB_PROJECT_MODE || "issues")
      .trim()
      .toLowerCase();
    this._projectOwner = process.env.GITHUB_PROJECT_OWNER || this._owner;
    this._projectTitle =
      process.env.GITHUB_PROJECT_TITLE ||
      process.env.PROJECT_NAME ||
      "Bosun";
    this._projectNumber =
      process.env.GITHUB_PROJECT_NUMBER ||
      process.env.GITHUB_PROJECT_ID ||
      null;
    this._cachedProjectNumber = this._projectNumber;

    // --- Caching infrastructure for GitHub Projects v2 ---
    /** @type {Map<string, string>} projectNumber → project node ID */
    this._projectNodeIdCache = new Map();
    /** @type {Map<string, string>} "projectNum:issueNum" → project item ID */
    this._projectItemCache = new Map();
    /** @type {Map<string, {fields: any, time: number}>} projectNumber → {fields, time} */
    this._projectFieldsCache = new Map();
    this._projectFieldsCacheTTL = 300_000; // 5 minutes
    /** @type {Set<string>} projects already warned for missing Status field */
    this._projectStatusFieldWarned = new Set();
    this._repositoryNodeId = null;

    // Auto-sync toggle: set GITHUB_PROJECT_AUTO_SYNC=false to disable project sync
    this._projectAutoSync = parseBooleanEnv(
      process.env.GITHUB_PROJECT_AUTO_SYNC,
      true,
    );

    // Rate limit retry delay (ms) — configurable for tests
    this._rateLimitRetryDelayMs = parseDelayMs(
      process.env.GH_RATE_LIMIT_RETRY_MS,
      60_000,
      0,
    );
    this._transientRetryDelayMs = parseDelayMs(
      process.env.GH_TRANSIENT_RETRY_MS,
      2_000,
      0,
    );
    this._transientRetryMax = Math.max(
      0,
      Number(process.env.GH_TRANSIENT_RETRY_MAX) || 2,
    );

    // Issue-list and shared-state caches (shared per repo namespace)
    const cacheBucket = getGitHubAdapterCacheBucket(this._owner, this._repo);
    /** @type {Map<string, {data: any, ts: number}>} state:limit → {data, ts} */
    this._issueListCache = cacheBucket.issueList;
    /** @type {Map<string, {data: object|null, ts: number}>} issueNum → {data, ts} */
    this._sharedStateCache = cacheBucket.sharedState;
    /** @type {Map<string, {owner:string, repo:string, repoKey:string, number:string, issueUrl:string, ts:number}>} */
    this._issueLocatorCache = cacheBucket.issueLocator;
    this._issueLocatorCacheTtlMs = parseDelayMs(
      process.env.GH_ISSUE_LOCATOR_CACHE_TTL_MS,
      GH_ISSUE_LOCATOR_CACHE_TTL_MS,
      0,
    );
    /** @type {Map<string, number>} repo#issueNum → last-seen-missing timestamp */
    this._missingIssueCache = cacheBucket.missingIssue;
    this._missingIssueCacheTtlMs = parseDelayMs(
      process.env.GH_MISSING_ISSUE_CACHE_TTL_MS,
      10 * 60 * 1000,
      5_000,
    );
    /** @type {Map<string, {data:any, ts:number}>} gh request key → parsed payload */
    this._ghReadCache = cacheBucket.ghRead;
    /** @type {Map<string, Promise<any>>} gh request key → in-flight promise */
    this._ghInflight = cacheBucket.ghInflight;
    /** @type {Map<string, {until:number, message:string, type:string|null}>} gh request key → cooldown metadata */
    this._ghErrorCooldown = cacheBucket.ghErrorCooldown;
    this._ghReadCacheTtlMs = parseDelayMs(
      process.env.GH_READ_CACHE_TTL_MS,
      GH_READ_CACHE_TTL_MS,
      0,
    );
    this._ghErrorCooldownMs = parseDelayMs(
      process.env.GH_ERROR_COOLDOWN_MS,
      GH_ERROR_COOLDOWN_MS,
      0,
    );
    this._ghNotFoundCooldownMs = parseDelayMs(
      process.env.GH_NOT_FOUND_COOLDOWN_MS,
      GH_NOT_FOUND_COOLDOWN_MS,
      0,
    );
    this._issueViewCacheTtlMs = parseDelayMs(
      process.env.GH_ISSUE_VIEW_CACHE_TTL_MS,
      GH_ISSUE_VIEW_CACHE_TTL_MS,
      0,
    );
    this._issueViewNegativeCacheTtlMs = parseDelayMs(
      process.env.GH_ISSUE_VIEW_NEGATIVE_CACHE_TTL_MS,
      GH_ISSUE_VIEW_NEGATIVE_CACHE_TTL_MS,
      5_000,
    );
    this._lastKnownTasks = [];
    this._taskListBackoffUntil = 0;
    this._taskListBackoffMs = parseDelayMs(
      process.env.GH_TASK_LIST_BACKOFF_MS,
      90_000,
      5_000,
    );
    this._taskListBackoffWarnAt = 0;
  }

  _cacheLastKnownTasks(tasks) {
    if (!Array.isArray(tasks)) return;
    this._lastKnownTasks = tasks.map((task) => ({
      ...task,
      meta: task?.meta ? { ...task.meta } : {},
    }));
    for (const task of this._lastKnownTasks) {
      const issueUrl = String(task?.taskUrl || task?.meta?.url || "").trim();
      if (!issueUrl) continue;
      this._rememberIssueLocator(task.id, issueUrl);
    }
    this._taskListBackoffUntil = 0;
    this._taskListBackoffWarnAt = 0;
  }

  _setTaskListBackoff() {
    const now = Date.now();
    this._taskListBackoffUntil = Math.max(
      this._taskListBackoffUntil || 0,
      now + this._taskListBackoffMs,
    );
  }

  _getBackoffTasks(filters = {}) {
    let fallback = this._lastKnownTasks.map((task) => ({
      ...task,
      meta: task?.meta ? { ...task.meta } : {},
    }));

    if (filters.status) {
      const normalizedFilter = normaliseStatus(filters.status);
      fallback = fallback.filter((task) => task.status === normalizedFilter);
    }

    return fallback;
  }

  _clearGhReadCaches() {
    this._ghReadCache.clear();
    this._ghErrorCooldown.clear();
    this._ghInflight.clear();
  }

  _rememberIssueLocator(issueNumber, issueUrl = "") {
    const locator = parseIssueRefLocator(
      issueNumber,
      this._owner,
      this._repo,
      issueUrl,
    );
    if (!/^\d+$/.test(locator.number) || !locator.owner || !locator.repo) return;
    const key = _issueLocatorCacheKey(
      locator.number,
      locator.repoKey,
      this._owner,
      this._repo,
    );
    const canonicalUrl =
      issueUrl ||
      `https://github.com/${locator.owner}/${locator.repo}/issues/${locator.number}`;
    this._issueLocatorCache.set(key, {
      ...locator,
      issueUrl: canonicalUrl,
      ts: Date.now(),
    });
  }

  _resolveIssueLocator(issueNumber, options = {}) {
    const issueUrl = String(options?.issueUrl || "").trim();
    const direct = parseIssueRefLocator(
      issueNumber,
      this._owner,
      this._repo,
      issueUrl,
    );
    if (!/^\d+$/.test(direct.number)) return direct;

    // Explicit URL/ref always wins and refreshes cache.
    if (issueUrl || String(issueNumber || "").includes("/")) {
      this._rememberIssueLocator(direct.number, issueUrl || String(issueNumber || ""));
      return {
        ...direct,
        issueUrl:
          issueUrl ||
          `https://github.com/${direct.owner}/${direct.repo}/issues/${direct.number}`,
      };
    }

    const key = _issueLocatorCacheKey(
      direct.number,
      direct.repoKey,
      this._owner,
      this._repo,
    );
    const cached = this._issueLocatorCache.get(key);
    if (cached) {
      if (Date.now() - cached.ts <= this._issueLocatorCacheTtlMs) {
        return { ...cached };
      }
      this._issueLocatorCache.delete(key);
    }

    // Cross-repo fallback: if an issue number was previously observed with a
    // different repo slug (e.g. project board rows), reuse that locator.
    const suffix = `#${direct.number}`;
    for (const [cacheKey, value] of this._issueLocatorCache.entries()) {
      if (!cacheKey.endsWith(suffix)) continue;
      if (Date.now() - value.ts > this._issueLocatorCacheTtlMs) {
        this._issueLocatorCache.delete(cacheKey);
        continue;
      }
      return { ...value };
    }

    // Fall back to last-known tasks (e.g., project item-list rows from other repos).
    const match = this._lastKnownTasks.find(
      (task) => String(task?.id || "") === String(direct.number),
    );
    const taskUrl = String(match?.taskUrl || match?.meta?.url || "").trim();
    if (taskUrl) {
      const resolved = parseIssueRefLocator(
        key,
        this._owner,
        this._repo,
        taskUrl,
      );
      if (/^\d+$/.test(resolved.number)) {
        const resolvedKey = _issueLocatorCacheKey(
          resolved.number,
          resolved.repoKey,
          this._owner,
          this._repo,
        );
        const value = {
          ...resolved,
          issueUrl: taskUrl,
          ts: Date.now(),
        };
        this._issueLocatorCache.set(resolvedKey, value);
        return value;
      }
    }

    return {
      ...direct,
      issueUrl: `https://github.com/${direct.owner}/${direct.repo}/issues/${direct.number}`,
    };
  }

  _isIssueKnownMissing(issueNumber, options = {}) {
    const locator = this._resolveIssueLocator(issueNumber, options);
    const key = _sharedStateCacheKey(locator.number, locator.repoKey);
    const seenAt = this._missingIssueCache.get(key);
    if (!seenAt) return false;
    if (Date.now() - seenAt > this._missingIssueCacheTtlMs) {
      this._missingIssueCache.delete(key);
      return false;
    }
    return true;
  }

  _markIssueMissing(issueNumber, options = {}) {
    const locator = this._resolveIssueLocator(issueNumber, options);
    const key = _sharedStateCacheKey(locator.number, locator.repoKey);
    this._missingIssueCache.set(key, Date.now());
  }

  _clearIssueMissing(issueNumber, options = {}) {
    const locator = this._resolveIssueLocator(issueNumber, options);
    const key = _sharedStateCacheKey(locator.number, locator.repoKey);
    this._missingIssueCache.delete(key);
  }

  /**
   * Get project fields with caching (private — returns legacy format for _syncStatusToProject).
   * Returns status field ID and options for project board.
   * @private
   * @param {string} projectNumber - GitHub project number
   * @returns {Promise<{statusFieldId: string, statusOptions: Array<{id: string, name: string}>}|null>}
   */
  async _getProjectFields(projectNumber) {
    if (!projectNumber) return null;

    // Return cached value if still valid
    const now = Date.now();
    const cacheKey = String(projectNumber);
    const cached = this._projectFieldsCache.get(cacheKey);
    if (cached && now - cached.time < this._projectFieldsCacheTTL) {
      return cached.fields;
    }

    try {
      const owner = String(this._projectOwner || this._owner).trim();
      const fields = await this._gh([
        "project",
        "field-list",
        String(projectNumber),
        "--owner",
        owner,
        "--format",
        "json",
      ]);

      const normalizedFields = Array.isArray(fields)
        ? fields
        : Array.isArray(fields?.fields)
          ? fields.fields
          : Array.isArray(fields?.data)
            ? fields.data
            : null;

      if (!Array.isArray(normalizedFields)) {
        console.warn(
          `${TAG} project field-list returned non-array for project ${projectNumber}`,
        );
        return null;
      }

      // Find the Status field
      const statusField = normalizedFields.find(
        (f) =>
          f.name === "Status" &&
          (f.type === "SINGLE_SELECT" || f.data_type === "SINGLE_SELECT"),
      );

      const result = {
        statusFieldId: statusField?.id || null,
        statusOptions: (statusField?.options || []).map((opt) => ({
          id: opt.id,
          name: opt.name,
        })),
      };

      // Cache the result (also cache the raw fields array for getProjectFields)
      this._projectFieldsCache.set(cacheKey, {
        fields: result,
        rawFields: normalizedFields,
        time: now,
      });

      return result;
    } catch (err) {
      console.warn(
        `${TAG} failed to fetch project fields for ${projectNumber}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Get full project fields map for a GitHub Project board.
   * Returns a Map keyed by lowercase field name with {id, name, type, options}.
   * @public
   * @param {string} projectNumber - GitHub project number
   * @returns {Promise<Map<string, {id: string, name: string, type: string, options: Array<{id: string, name: string}>}>>}
   */
  async getProjectFields(projectNumber) {
    if (!projectNumber) return new Map();
    const cacheKey = String(projectNumber);
    const now = Date.now();
    const cached = this._projectFieldsCache.get(cacheKey);

    let rawFields;
    if (
      cached &&
      cached.rawFields &&
      now - cached.time < this._projectFieldsCacheTTL
    ) {
      rawFields = cached.rawFields;
    } else {
      // Trigger a fresh fetch via _getProjectFields which populates both caches
      await this._getProjectFields(projectNumber);
      const freshCached = this._projectFieldsCache.get(cacheKey);
      rawFields = freshCached?.rawFields;
    }

    if (!Array.isArray(rawFields)) return new Map();

    /** @type {Map<string, {id: string, name: string, type: string, options: Array}>} */
    const fieldMap = new Map();
    for (const f of rawFields) {
      if (!f.name) continue;
      fieldMap.set(f.name.toLowerCase(), {
        id: f.id,
        name: f.name,
        type: f.type || f.data_type || "UNKNOWN",
        options: (f.options || []).map((opt) => ({
          id: opt.id,
          name: opt.name,
        })),
        raw: f,
      });
    }
    return fieldMap;
  }

  /**
   * Get the GraphQL node ID for a GitHub Project v2 board.
   * Resolves org or user project. Cached for session lifetime.
   * @public
   * @param {string} projectNumber - GitHub project number
   * @returns {Promise<string|null>} Project node ID or null
   */
  async getProjectNodeId(projectNumber) {
    if (!projectNumber) return null;
    const cacheKey = String(projectNumber);
    if (this._projectNodeIdCache.has(cacheKey)) {
      return this._projectNodeIdCache.get(cacheKey);
    }

    const owner = String(this._projectOwner || this._owner).trim();
    const query = `
      query {
        user(login: "${owner}") {
          projectV2(number: ${projectNumber}) {
            id
          }
        }
        organization(login: "${owner}") {
          projectV2(number: ${projectNumber}) {
            id
          }
        }
      }
    `;

    try {
      const data = await this._gh(["api", "graphql", "-f", `query=${query}`]);
      const nodeId =
        data?.data?.user?.projectV2?.id ||
        data?.data?.organization?.projectV2?.id ||
        null;
      if (nodeId) {
        this._projectNodeIdCache.set(cacheKey, nodeId);
      }
      return nodeId;
    } catch (err) {
      console.warn(
        `${TAG} failed to resolve project node ID for ${owner}/${projectNumber}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Normalize a GitHub Project v2 status name to internal codex status.
   * Also supports reverse mapping (internal → project).
   *
   * Bidirectional:
   *   - project → internal: _normalizeProjectStatus("In Progress") → "inprogress"
   *   - internal → project: _normalizeProjectStatus("inprogress", true) → "In Progress"
   *
   * @param {string} statusName - Status name to normalize
   * @param {boolean} [toProject=false] - If true, map internal→project; otherwise project→internal
   * @returns {string} Normalized status
   */
  _normalizeProjectStatus(statusName, toProject = false) {
    if (!statusName) return toProject ? PROJECT_STATUS_MAP.todo : "todo";

    if (toProject) {
      // internal → project
      const key = String(statusName).toLowerCase().trim();
      return PROJECT_STATUS_MAP[key] || PROJECT_STATUS_MAP.todo;
    }

    // project → internal: build reverse map from PROJECT_STATUS_MAP
    const lcInput = String(statusName).toLowerCase().trim();
    for (const [internal, projectName] of Object.entries(PROJECT_STATUS_MAP)) {
      if (String(projectName).toLowerCase() === lcInput) {
        return internal;
      }
    }
    // Fallback to standard normalisation
    return normaliseStatus(statusName);
  }

  /**
   * Normalize a project item (from `gh project item-list`) into KanbanTask format
   * without issuing individual issue fetches (fixes N+1 problem).
   * @private
   * @param {Object} projectItem - Raw project item from item-list
   * @returns {KanbanTask|null}
   */
  _normaliseProjectItem(projectItem) {
    if (!projectItem) return null;

    const content = projectItem.content || {};
    // content may have: number, title, body, url, type, repository, labels, assignees
    const issueNumber = content.number;
    if (!issueNumber && !content.url) return null; // skip draft items without info

    // Extract issue number from URL if not directly available
    const num =
      issueNumber || String(content.url || "").match(/\/issues\/(\d+)/)?.[1];
    if (!num) return null;

    // Extract labels
    const rawLabels = content.labels || projectItem.labels || [];
    const labels = rawLabels.map((l) =>
      typeof l === "string" ? l : l?.name || "",
    );
    const labelSet = new Set(
      labels.map((l) =>
        String(l || "")
          .trim()
          .toLowerCase(),
      ),
    );
    const labelStatus = statusFromLabels(labels);
    const tags = extractTagsFromLabels(labels, this._taskScopeLabels || []);
    const body = content.body || "";
    const baseBranch = normalizeBranchName(
      extractBaseBranchFromLabels(labels) || extractBaseBranchFromText(body),
    );

    // Determine status from project Status field value
    const projectStatus =
      projectItem.status || projectItem.fieldValues?.Status || null;
    let status;
    if (projectStatus) {
      status = this._normalizeProjectStatus(projectStatus);
    } else {
      // Fallback to content state + labels
      if (content.state === "closed" || content.state === "CLOSED") {
        status = "done";
      } else if (labelStatus) {
        status = labelStatus;
      } else {
        status = "todo";
      }
    }
    if (labelSet.has("draft")) status = "draft";

    // Codex meta flags
    const codexMeta = {
      isIgnored: labelSet.has("codex:ignore"),
      isClaimed: labelSet.has("codex:claimed"),
      isWorking: labelSet.has("codex:working"),
      isStale: labelSet.has("codex:stale"),
    };

    // Extract branch/PR from body if available
    const branchMatch = body.match(/branch:\s*`?([^\s`]+)`?/i);
    const prMatch = body.match(/pr:\s*#?(\d+)/i);

    // Assignees
    const assignees = content.assignees || [];
    const assignee =
      assignees.length > 0
        ? typeof assignees[0] === "string"
          ? assignees[0]
          : assignees[0]?.login
        : null;

    const issueUrl =
      content.url ||
      `https://github.com/${this._owner}/${this._repo}/issues/${num}`;
    const locator = parseIssueRefLocator(
      num,
      this._owner,
      this._repo,
      issueUrl,
    );
    const normalizedNum = /^\d+$/.test(locator.number)
      ? locator.number
      : String(num);
    const projectId = `${locator.owner}/${locator.repo}`;
    this._rememberIssueLocator(normalizedNum, issueUrl);

    return {
      id: String(normalizedNum),
      title: content.title || projectItem.title || "",
      description: body,
      status,
      assignee: assignee || null,
      priority: labelSet.has("critical")
        ? "critical"
        : labelSet.has("high")
          ? "high"
          : null,
      tags,
      draft: labelSet.has("draft") || status === "draft",
      projectId,
      baseBranch,
      branchName: branchMatch?.[1] || null,
      prNumber: prMatch?.[1] || null,
      meta: {
        number: Number(normalizedNum),
        title: content.title || projectItem.title || "",
        body,
        state: content.state || null,
        url: issueUrl,
        labels: rawLabels,
        assignees,
        task_url: issueUrl,
        tags,
        ...(baseBranch ? { base_branch: baseBranch, baseBranch } : {}),
        codex: codexMeta,
        projectNumber: null, // set by caller
        projectItemId: projectItem.id || null,
        projectStatus: projectStatus || null,
        projectFieldValues:
          projectItem.fieldValues && typeof projectItem.fieldValues === "object"
            ? { ...projectItem.fieldValues }
            : {},
      },
      taskUrl: issueUrl,
      backend: "github",
    };
  }

  _escapeGraphQLString(value) {
    return JSON.stringify(String(value == null ? "" : value));
  }

  _stringifyProjectFieldValue(field, value) {
    const fieldType = String(field?.type || "TEXT").toUpperCase();
    if (fieldType === "SINGLE_SELECT") {
      const option = (field.options || []).find((opt) => {
        const optionId = String(opt?.id || "").trim();
        const optionName = String(opt?.name || "")
          .trim()
          .toLowerCase();
        const input = String(value || "").trim().toLowerCase();
        return optionId === String(value || "").trim() || optionName === input;
      });
      if (!option) return null;
      return `{singleSelectOptionId: ${this._escapeGraphQLString(option.id)}}`;
    }
    if (fieldType === "ITERATION") {
      const rawIterations = field?.raw?.configuration?.iterations;
      const iterations = Array.isArray(rawIterations)
        ? rawIterations
        : Array.isArray(field?.options)
          ? field.options
          : [];
      const iteration = iterations.find((entry) => {
        const entryId = String(entry?.id || "").trim();
        const name = String(entry?.title || entry?.name || "")
          .trim()
          .toLowerCase();
        const input = String(value || "").trim().toLowerCase();
        return entryId === String(value || "").trim() || name === input;
      });
      if (!iteration?.id) return null;
      return `{iterationId: ${this._escapeGraphQLString(iteration.id)}}`;
    }
    if (fieldType === "NUMBER") {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return null;
      return `{number: ${numeric}}`;
    }
    if (fieldType === "DATE") {
      return `{date: ${this._escapeGraphQLString(value)}}`;
    }
    return `{text: ${this._escapeGraphQLString(value)}}`;
  }

  async _updateProjectItemFieldsBatch(projectId, itemId, updates = []) {
    if (!projectId || !itemId || updates.length === 0) return false;
    const operations = updates
      .map((update, index) => {
        const alias = `update_${index}`;
        return `
          ${alias}: updateProjectV2ItemFieldValue(
            input: {
              projectId: ${this._escapeGraphQLString(projectId)},
              itemId: ${this._escapeGraphQLString(itemId)},
              fieldId: ${this._escapeGraphQLString(update.fieldId)},
              value: ${update.value}
            }
          ) {
            projectV2Item {
              id
            }
          }
        `;
      })
      .join("\n");

    const mutation = `mutation { ${operations} }`;
    await this._gh(["api", "graphql", "-f", `query=${mutation}`]);
    return true;
  }

  _matchesProjectFieldFilters(task, projectFieldFilter) {
    if (!projectFieldFilter || typeof projectFieldFilter !== "object") {
      return true;
    }
    const values = task?.meta?.projectFieldValues;
    if (!values || typeof values !== "object") return false;
    const entries = Object.entries(projectFieldFilter);
    if (entries.length === 0) return true;

    return entries.every(([fieldName, expected]) => {
      const actualKey =
        Object.keys(values).find(
          (key) => key.toLowerCase() === String(fieldName).toLowerCase(),
        ) || fieldName;
      const actual = values[actualKey];
      if (Array.isArray(expected)) {
        const expectedSet = new Set(
          expected.map((entry) =>
            String(entry == null ? "" : entry)
              .trim()
              .toLowerCase(),
          ),
        );
        return expectedSet.has(
          String(actual == null ? "" : actual)
            .trim()
            .toLowerCase(),
        );
      }
      return (
        String(actual == null ? "" : actual)
          .trim()
          .toLowerCase() ===
        String(expected == null ? "" : expected)
          .trim()
          .toLowerCase()
      );
    });
  }

  async getRepositoryNodeId() {
    if (this._repositoryNodeId) return this._repositoryNodeId;
    const query = `
      query {
        repository(
          owner: ${this._escapeGraphQLString(this._owner)},
          name: ${this._escapeGraphQLString(this._repo)}
        ) {
          id
        }
      }
    `;
    const data = await this._gh(["api", "graphql", "-f", `query=${query}`]);
    const repoId = data?.data?.repository?.id || null;
    if (repoId) this._repositoryNodeId = repoId;
    return repoId;
  }

  /**
   * Get project item ID for an issue within a project (cached).
   * @private
   * @param {string} projectNumber - GitHub project number
   * @param {string|number} issueNumber - Issue number
   * @returns {Promise<string|null>} Project item ID or null
   */
  async _getProjectItemIdForIssue(projectNumber, issueNumber) {
    if (!projectNumber || !issueNumber) return null;
    const cacheKey = `${projectNumber}:${issueNumber}`;
    if (this._projectItemCache.has(cacheKey)) {
      return this._projectItemCache.get(cacheKey);
    }

    // Try GraphQL resource query
    const issueUrl = `https://github.com/${this._owner}/${this._repo}/issues/${issueNumber}`;
    const projectId = await this.getProjectNodeId(projectNumber);
    if (!projectId) return null;

    const query = `
      query {
        resource(url: "${issueUrl}") {
          ... on Issue {
            projectItems(first: 10) {
              nodes {
                id
                project {
                  id
                }
              }
            }
          }
        }
      }
    `;

    try {
      const data = await this._gh(["api", "graphql", "-f", `query=${query}`]);
      const items = data?.data?.resource?.projectItems?.nodes || [];
      const match = items.find((item) => item.project?.id === projectId);
      const itemId = match?.id || null;
      if (itemId) {
        this._projectItemCache.set(cacheKey, itemId);
      }
      return itemId;
    } catch (err) {
      console.warn(
        `${TAG} failed to get project item ID for issue #${issueNumber}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Update a generic field value on a project item via GraphQL mutation.
   * Supports text, number, date, and single_select field types.
   * @public
   * @param {string|number} issueNumber - Issue number
   * @param {string} projectNumber - GitHub project number
   * @param {string} fieldName - Field name (case-insensitive)
   * @param {string|number} value - Value to set
   * @returns {Promise<boolean>} Success status
   */
  async syncFieldToProject(issueNumber, projectNumber, fieldName, value) {
    if (!issueNumber || !projectNumber || !fieldName) return false;

    try {
      const projectId = await this.getProjectNodeId(projectNumber);
      if (!projectId) {
        console.warn(`${TAG} syncFieldToProject: cannot resolve project ID`);
        return false;
      }

      const fieldMap = await this.getProjectFields(projectNumber);
      const fieldKey = String(fieldName).toLowerCase().trim();
      const field = fieldMap.get(fieldKey);
      if (!field) {
        console.warn(
          `${TAG} syncFieldToProject: field "${fieldName}" not found in project`,
        );
        return false;
      }

      const itemId = await this._getProjectItemIdForIssue(projectNumber, issueNumber);
      if (!itemId) {
        console.warn(
          `${TAG} syncFieldToProject: issue #${issueNumber} not found in project`,
        );
        return false;
      }

      const valueJson = this._stringifyProjectFieldValue(field, value);
      if (!valueJson) {
        console.warn(
          `${TAG} syncFieldToProject: value "${value}" invalid for field "${fieldName}"`,
        );
        return false;
      }

      await this._updateProjectItemFieldsBatch(projectId, itemId, [
        {
          fieldId: field.id,
          value: valueJson,
        },
      ]);
      console.log(
        `${TAG} synced field "${fieldName}" = "${value}" for issue #${issueNumber}`,
      );
      return true;
    } catch (err) {
      console.warn(
        `${TAG} syncFieldToProject failed for issue #${issueNumber}: ${err.message}`,
      );
      return false;
    }
  }

  async syncIterationToProject(issueNumber, projectNumber, iterationName) {
    if (!issueNumber || !projectNumber || !iterationName) return false;
    return this.syncFieldToProject(
      issueNumber,
      projectNumber,
      "Iteration",
      iterationName,
    );
  }

  /**
   * List tasks from a GitHub Project board.
   * Fetches project items and normalizes them directly (no N+1 issue fetches).
   * @public
   * @param {string} projectNumber - GitHub project number
   * @returns {Promise<KanbanTask[]>}
   */
  async listTasksFromProject(projectNumber, filters = {}) {
    if (!projectNumber) return [];

    try {
      const owner = String(this._projectOwner || this._owner).trim();
      const itemListResponse = await this._gh([
        "project",
        "item-list",
        String(projectNumber),
        "--owner",
        owner,
        "--format",
        "json",
      ]);
      const items = Array.isArray(itemListResponse)
        ? itemListResponse
        : Array.isArray(itemListResponse?.items)
          ? itemListResponse.items
          : null;

      if (!Array.isArray(items)) {
        const shape =
          itemListResponse && typeof itemListResponse === "object"
            ? Object.keys(itemListResponse).join(",")
            : typeof itemListResponse;
        console.warn(
          `${TAG} project item-list returned unsupported shape for project ${projectNumber} (keys: ${shape || "none"})`,
        );
        return [];
      }

      const tasks = [];
      for (const item of items) {
        // Skip non-issue items (draft issues without content, PRs)
        if (item.content?.type === "PullRequest") continue;

        const task = this._normaliseProjectItem(item);
        if (task) {
          task.meta.projectNumber = projectNumber;
          if (!task.meta.projectFieldValues.Status && item.status) {
            task.meta.projectFieldValues.Status = item.status;
          }
          // Cache the project item ID for later lookups
          if (task.id && item.id) {
            this._projectItemCache.set(`${projectNumber}:${task.id}`, item.id);
          }
          if (this._matchesProjectFieldFilters(task, filters.projectField)) {
            tasks.push(task);
          }
        }
      }

      return tasks;
    } catch (err) {
      throw new Error(
        `project ${projectNumber} list failed: ${err?.message || err}`,
      );
    }
  }

  /**
   * Sync task status to GitHub Project board.
   * Maps codex status to project Status field and updates via GraphQL.
   * Uses configurable PROJECT_STATUS_MAP for status name resolution.
   * @private
   * @param {string} issueUrl - Full GitHub issue URL
   * @param {string} projectNumber - GitHub project number
   * @param {string} status - Normalized status (todo/inprogress/inreview/done)
   * @returns {Promise<boolean>}
   */
  async _syncStatusToProject(
    issueUrl,
    projectNumber,
    status,
    projectFields = {},
  ) {
    if (!issueUrl || !projectNumber || !status) return false;

    try {
      const owner = String(this._projectOwner || this._owner).trim();

      // Get project fields
      const fields = await this._getProjectFields(projectNumber);
      if (!fields || !fields.statusFieldId) {
        const projectKey = String(projectNumber || "");
        if (!this._projectStatusFieldWarned.has(projectKey)) {
          this._projectStatusFieldWarned.add(projectKey);
          console.warn(
            `${TAG} cannot sync to project ${projectKey}: no Status field found`,
          );
        }
        return false;
      }
      this._projectStatusFieldWarned.delete(String(projectNumber || ""));

      // Map codex status to project status option using configurable mapping
      const targetStatusName = this._normalizeProjectStatus(status, true);
      const normalizedTarget = normaliseStatus(status);
      let statusOption = fields.statusOptions.find(
        (opt) => opt.name.toLowerCase() === targetStatusName.toLowerCase(),
      );

      if (!statusOption) {
        statusOption = fields.statusOptions.find(
          (opt) => normaliseStatus(opt.name) === normalizedTarget,
        );
      }

      if (!statusOption) {
        console.warn(
          `${TAG} no matching project status for "${targetStatusName}"`,
        );
        return false;
      }

      // First, ensure issue is in the project
      try {
        await this._gh(
          [
            "project",
            "item-add",
            String(projectNumber),
            "--owner",
            owner,
            "--url",
            issueUrl,
          ],
          { parseJson: false },
        );
      } catch (err) {
        const text = String(err?.message || err).toLowerCase();
        if (!text.includes("already") && !text.includes("item")) {
          throw err;
        }
        // Item already in project, continue
      }

      const issueNum = issueUrl.match(/\/issues\/(\d+)/)?.[1];
      if (!issueNum) {
        console.warn(`${TAG} could not parse issue number from URL: ${issueUrl}`);
        return false;
      }

      const projectId = await this.getProjectNodeId(projectNumber);
      if (!projectId) {
        console.warn(
          `${TAG} could not resolve project ID for ${owner}/${projectNumber}`,
        );
        return false;
      }
      const itemId = await this._getProjectItemIdForIssue(projectNumber, issueNum);
      if (!itemId) {
        console.warn(
          `${TAG} issue not found in project ${owner}/${projectNumber}`,
        );
        return false;
      }
      const fieldMap = await this.getProjectFields(projectNumber);
      const updates = [];
      updates.push({
        fieldId: fields.statusFieldId,
        value: `{singleSelectOptionId: ${this._escapeGraphQLString(statusOption.id)}}`,
      });
      for (const [fieldName, fieldValue] of Object.entries(projectFields || {})) {
        if (!fieldName || /^status$/i.test(fieldName)) continue;
        const field = fieldMap.get(String(fieldName).toLowerCase().trim());
        if (!field) {
          console.warn(
            `${TAG} skipping unknown project field during status sync: ${fieldName}`,
          );
          continue;
        }
        const value = this._stringifyProjectFieldValue(field, fieldValue);
        if (!value) {
          console.warn(
            `${TAG} skipping invalid project field value during status sync: ${fieldName}`,
          );
          continue;
        }
        updates.push({
          fieldId: field.id,
          value,
        });
      }
      await this._updateProjectItemFieldsBatch(projectId, itemId, updates);

      console.log(
        `${TAG} synced issue ${issueUrl} to project status: ${targetStatusName}`,
      );
      return true;
    } catch (err) {
      console.warn(`${TAG} failed to sync status to project: ${err.message}`);
      return false;
    }
  }

  /** Execute a gh CLI command and return parsed JSON (with rate limit retry) */
  async _gh(args, options = {}) {
    const { parseJson = true } = options;
    const normalizedArgs = Array.isArray(args)
      ? args.map((entry) => String(entry ?? ""))
      : [String(args ?? "")];
    const readOnly = isGhReadOnlyCommand(normalizedArgs);
    const isIssueViewRead =
      readOnly &&
      String(normalizedArgs[0] || "").toLowerCase() === "issue" &&
      String(normalizedArgs[1] || "").toLowerCase() === "view";
    const readCacheTtlMs = isIssueViewRead
      ? this._issueViewCacheTtlMs
      : this._ghReadCacheTtlMs;
    const requestKey = buildGhRequestKey(normalizedArgs, parseJson);
    const now = Date.now();

    if (readOnly && readCacheTtlMs > 0) {
      const cached = this._ghReadCache.get(requestKey);
      if (cached && now - cached.ts < readCacheTtlMs) {
        return cached.data;
      }
      if (cached) this._ghReadCache.delete(requestKey);
    }

    if (readOnly && this._ghErrorCooldownMs > 0) {
      const cooldown = this._ghErrorCooldown.get(requestKey);
      if (cooldown && cooldown.until > now) {
        const cooldownError = new Error(
          `gh CLI request skipped during cooldown: ${cooldown.message}`,
        );
        cooldownError.isCooldown = true;
        cooldownError.isNotFound = cooldown.type === "not_found";
        throw cooldownError;
      }
      if (cooldown) this._ghErrorCooldown.delete(requestKey);
    }

    if (readOnly && this._ghInflight.has(requestKey)) {
      return this._ghInflight.get(requestKey);
    }

    const { execFile } = await import("node:child_process");

    const run = async () => {
      const attempt = async () => {
        try {
          const result = await new Promise((resolve, reject) => {
            execFile(
              "gh",
              normalizedArgs,
              {
                maxBuffer: 10 * 1024 * 1024,
                timeout: 30_000,
              },
              (err, stdout, stderr) => {
                const normalizeOutput = (value, fallback = "") => {
                  if (value == null) return String(fallback || "");
                  if (typeof value === "string") return value;
                  return String(value);
                };

                const outputFromStdoutObject =
                  stdout && typeof stdout === "object"
                    ? {
                        stdout: normalizeOutput(stdout.stdout),
                        stderr: normalizeOutput(stdout.stderr, stderr),
                      }
                    : null;

                const normalized = outputFromStdoutObject || {
                  stdout: normalizeOutput(stdout),
                  stderr: normalizeOutput(stderr),
                };

                if (err) {
                  err.stdout = normalizeOutput(err.stdout, normalized.stdout);
                  err.stderr = normalizeOutput(err.stderr, normalized.stderr);
                  reject(err);
                  return;
                }

                resolve(normalized);
              },
            );
          });
          return result;
        } catch (err) {
          const message = String(err?.message || err);
          const stdout = String(err?.stdout || "");
          const stderr = String(err?.stderr || "");
          const ghError = new Error(message);
          ghError.stdout = stdout;
          ghError.stderr = stderr;
          ghError.fullText = [message, stderr, stdout].filter(Boolean).join("\n");
          ghError.isRateLimit = isGhRateLimitError([message, stderr].join("\n"));
          ghError.isTransient = isGhTransientError([message, stderr, stdout].join("\n"));
          ghError.isNotFound = isGhNotFoundError([message, stderr, stdout].join("\n"));
          throw ghError;
        }
      };

      let usedRateLimitRetry = false;
      let transientRetries = 0;
      const maxTransientRetries = Math.max(0, Number(this._transientRetryMax) || 0);

      while (true) {
        let result;
        try {
          result = await attempt();
        } catch (err) {
          const message = String(err?.message || err);
          if (err?.isRateLimit && !usedRateLimitRetry) {
            usedRateLimitRetry = true;
            console.warn(
              `${TAG} rate limit detected, waiting ${this._rateLimitRetryDelayMs}ms before retry...`,
            );
            await sleepMs(this._rateLimitRetryDelayMs);
            continue;
          }
          if (err?.isTransient && transientRetries < maxTransientRetries) {
            transientRetries += 1;
            console.warn(
              `${TAG} transient gh failure (attempt ${transientRetries}/${maxTransientRetries}), retrying in ${this._transientRetryDelayMs}ms...`,
            );
            await sleepMs(this._transientRetryDelayMs);
            continue;
          }

          const fullText = String(err?.fullText || message);
          const deterministicClass = classifyGhDeterministicError(fullText);
          if (readOnly && deterministicClass) {
            const cooldownMs =
              deterministicClass === "not_found"
                ? isIssueViewRead
                  ? this._issueViewNegativeCacheTtlMs
                  : this._ghNotFoundCooldownMs
                : this._ghErrorCooldownMs;
            if (cooldownMs > 0) {
              this._ghErrorCooldown.set(requestKey, {
                until: Date.now() + cooldownMs,
                message,
                type: deterministicClass,
              });
            }
          }

          if (err?.isRateLimit && usedRateLimitRetry) {
            const wrapped = new Error(
              `gh CLI failed (after rate limit retry): ${message}`,
            );
            wrapped.cause = err;
            wrapped.isRateLimit = Boolean(err?.isRateLimit);
            wrapped.isTransient = Boolean(err?.isTransient);
            wrapped.isNotFound = Boolean(
              err?.isNotFound || deterministicClass === "not_found",
            );
            wrapped.isDeterministic = Boolean(deterministicClass);
            wrapped.deterministicClass = deterministicClass;
            throw wrapped;
          }
          const wrapped = new Error(`gh CLI failed: ${message}`);
          wrapped.cause = err;
          wrapped.isRateLimit = Boolean(err?.isRateLimit);
          wrapped.isTransient = Boolean(err?.isTransient);
          wrapped.isNotFound = Boolean(
            err?.isNotFound || deterministicClass === "not_found",
          );
          wrapped.isDeterministic = Boolean(deterministicClass);
          wrapped.deterministicClass = deterministicClass;
          throw wrapped;
        }

        const text = String(result?.stdout || "").trim();
        let parsed;
        if (!parseJson) {
          parsed = text;
        } else if (!text) {
          parsed = null;
        } else {
          try {
            parsed = JSON.parse(text);
          } catch (err) {
            const parseMessage = String(err?.message || err);
            const parseContext = [parseMessage, result?.stderr || "", text.slice(0, 512)]
              .filter(Boolean)
              .join("\n");
            if (
              isGhTransientError(parseContext) &&
              transientRetries < maxTransientRetries
            ) {
              transientRetries += 1;
              console.warn(
                `${TAG} transient gh JSON parse failure (attempt ${transientRetries}/${maxTransientRetries}), retrying in ${this._transientRetryDelayMs}ms...`,
              );
              await sleepMs(this._transientRetryDelayMs);
              continue;
            }
            throw new Error(`gh CLI returned invalid JSON: ${parseMessage}`);
          }
        }

        if (readOnly && readCacheTtlMs > 0) {
          this._ghReadCache.set(requestKey, { data: parsed, ts: Date.now() });
        } else if (!readOnly) {
          // A successful mutation invalidates all request-level read caches.
          this._clearGhReadCaches();
        }
        return parsed;
      }
    };

    const promise = run();
    if (readOnly) this._ghInflight.set(requestKey, promise);
    try {
      return await promise;
    } finally {
      if (readOnly) this._ghInflight.delete(requestKey);
    }
  }
  async _ensureLabelExists(label) {
    const name = String(label || "").trim();
    if (!name) return;
    const colorByLabel = {
      inprogress: "2563eb",
      "in-progress": "2563eb",
      inreview: "f59e0b",
      "in-review": "f59e0b",
      blocked: "dc2626",
    };
    const color = colorByLabel[name.toLowerCase()] || "94a3b8";
    try {
      await this._gh(
        [
          "label",
          "create",
          name,
          "--repo",
          `${this._owner}/${this._repo}`,
          "--color",
          color,
          "--description",
          `bosun status: ${name}`,
        ],
        { parseJson: false },
      );
    } catch (err) {
      const msg = String(err?.message || err).toLowerCase();
      if (
        msg.includes("already exists") ||
        msg.includes("label") && msg.includes("exists")
      ) {
        return;
      }
      console.warn(`${TAG} failed to ensure label "${name}": ${err?.message || err}`);
    }
  }

  async listProjects() {
    // GitHub doesn't have "projects" in the same sense — return repo as project
    return [
      {
        id: `${this._owner}/${this._repo}`,
        name: this._repo,
        meta: { owner: this._owner, repo: this._repo },
        backend: "github",
      },
    ];
  }

  async listTasks(_projectId, filters = {}) {
    const now = Date.now();
    if (this._taskListBackoffUntil > now) {
      const fallback = this._getBackoffTasks(filters);
      if (fallback.length > 0) {
        if (now - this._taskListBackoffWarnAt > 15_000) {
          this._taskListBackoffWarnAt = now;
          const sec = Math.max(
            1,
            Math.ceil((this._taskListBackoffUntil - now) / 1000),
          );
          console.warn(
            `${TAG} task list in backoff (${sec}s remaining) — serving ${fallback.length} cached task(s)`,
          );
        }
        return fallback;
      }
    }

    // If project mode is enabled, read from project board
    if (this._projectMode === "kanban" && this._projectNumber) {
      const projectNumber = await this._resolveProjectNumber();
      if (projectNumber) {
        try {
          const tasks = await this.listTasksFromProject(projectNumber, filters);

          // Apply filters
          let filtered = tasks;

          if (this._enforceTaskLabel) {
            filtered = filtered.filter((task) =>
              this._isTaskScopedForCodex(task),
            );
          }

          if (filters.status) {
            const normalizedFilter = normaliseStatus(filters.status);
            filtered = filtered.filter(
              (task) => task.status === normalizedFilter,
            );
          }

          // Enrich with shared state from comments
          for (const task of filtered) {
            try {
              const sharedState = normalizeSharedStatePayload(
                await this.readSharedStateFromIssue(task.id, null, {
                  issueUrl: task?.meta?.url || task?.taskUrl || null,
                }),
              );
              if (sharedState) {
                task.meta.sharedState = sharedState;
                task.sharedState = sharedState;
              }
            } catch (err) {
              console.warn(
                `[kanban] failed to read shared state for #${task.id}: ${err.message}`,
              );
            }
          }

          this._cacheLastKnownTasks(filtered);
          return filtered;
        } catch (err) {
          console.warn(
            `${TAG} failed to list tasks from project, falling back to issues: ${err.message}`,
          );
          // Fall through to regular issue listing
        }
      }
    }

    // Default: list from issues
    const limit =
      Number(filters.limit || process.env.GITHUB_ISSUES_LIST_LIMIT || 1000) ||
      1000;

    // Determine state filter for cache-key construction
    let stateFilter = "open";
    if (filters.status === "done") {
      stateFilter = "closed";
    } else if (filters.status && filters.status !== "todo") {
      stateFilter = `open:${filters.status}`;
    }

    // Check instance-level issue-list cache to avoid redundant gh API calls
    const listCacheKey = _issueListCacheKey(
      `${this._owner}/${this._repo}`,
      stateFilter,
      limit,
    );
    const nowMs = Date.now();
    const cachedList = this._issueListCache.get(listCacheKey);
    let rawIssues;
    if (cachedList && nowMs - cachedList.ts < GH_ISSUE_LIST_CACHE_TTL_MS) {
      rawIssues = cachedList.data;
    } else {
      const args = [
        "issue",
        "list",
        "--repo",
        `${this._owner}/${this._repo}`,
        "--json",
        "number,title,body,state,url,assignees,labels,milestone,comments",
        "--limit",
        String(limit),
      ];
      if (filters.status === "done") {
        args.push("--state", "closed");
      } else if (filters.status && filters.status !== "todo") {
        args.push("--state", "open");
        args.push("--label", filters.status);
      } else {
        args.push("--state", "open");
      }
      try {
        rawIssues = await this._gh(args);
        this._issueListCache.set(listCacheKey, { data: rawIssues, ts: nowMs });
      } catch (err) {
        this._setTaskListBackoff();
        const fallback = this._getBackoffTasks(filters);
        if (fallback.length > 0) {
          console.warn(
            `${TAG} failed to list issues (${err.message}); serving ${fallback.length} cached task(s)`,
          );
          return fallback;
        }
        throw err;
      }
    }

    let normalized = (Array.isArray(rawIssues) ? rawIssues : []).map((i) =>
      this._normaliseIssue(i),
    );

    if (this._enforceTaskLabel) {
      normalized = normalized.filter((task) =>
        this._isTaskScopedForCodex(task),
      );
    }

    // Build map of pre-fetched comments from the issue-list JSON payload.
    // gh issue list --json ... already includes comments, so we can pass them
    // directly to readSharedStateFromIssue to eliminate N extra API calls.
    const rawCommentsByNum = new Map();
    if (Array.isArray(rawIssues)) {
      for (const i of rawIssues) {
        if (i?.number != null && Array.isArray(i.comments)) {
          rawCommentsByNum.set(String(i.number), i.comments);
        }
      }
    }

    // Enrich with shared state – pass embedded comments to avoid extra API calls
    for (const task of normalized) {
      try {
        const embeddedComments = rawCommentsByNum.get(String(task.id));
        const sharedState = normalizeSharedStatePayload(
          await this.readSharedStateFromIssue(task.id, embeddedComments),
        );
        if (sharedState) {
          task.meta.sharedState = sharedState;
          task.sharedState = sharedState;
        }
      } catch (err) {
        // Non-critical - continue without shared state
        console.warn(
          `[kanban] failed to read shared state for #${task.id}: ${err.message}`,
        );
      }
    }

    this._cacheLastKnownTasks(normalized);
    return normalized;
  }

  async getTask(issueNumber, options = {}) {
    const locator = this._resolveIssueLocator(issueNumber, options);
    const num = String(locator.number || "").replace(/^#/, "");
    if (!/^\d+$/.test(num)) {
      throw new Error(
        `GitHub Issues: invalid issue number "${issueNumber}" — expected a numeric ID, got a UUID or non-numeric string`,
      );
    }
    const repoRef = `${locator.owner}/${locator.repo}`;
    const issueUrl =
      locator.issueUrl || `https://github.com/${repoRef}/issues/${num}`;
    if (this._isIssueKnownMissing(num, { issueUrl })) {
      return {
        id: String(num),
        title: "",
        description: "",
        status: "todo",
        assignee: null,
        priority: null,
        projectId: repoRef,
        branchName: null,
        prNumber: null,
        meta: { externalMissing: true, externalMissingReason: "issue_not_found" },
        taskUrl: issueUrl,
        backend: "github",
      };
    }
    let issue = null;
    try {
      issue = await this._gh([
        "issue",
        "view",
        num,
        "--repo",
        repoRef,
        "--json",
        "number,title,body,state,url,assignees,labels,milestone,comments",
      ]);
      this._rememberIssueLocator(num, issue?.url || issueUrl);
      this._clearIssueMissing(num, { issueUrl: issue?.url || issueUrl });
    } catch (err) {
      if (err?.isNotFound) {
        this._markIssueMissing(num, { issueUrl });
      } else if (!err?.isCooldown) {
        console.warn(
          `${TAG} failed to fetch issue #${num}: ${err.message || err}`,
        );
      }
    }
    const task = issue
      ? this._normaliseIssue(issue)
      : {
          id: String(num),
          title: "",
          description: "",
          status: "todo",
          assignee: null,
          priority: null,
          projectId: repoRef,
          branchName: null,
          prNumber: null,
          meta: {},
          taskUrl: issueUrl,
          backend: "github",
        };
    if (!issue) {
      task.meta.externalMissing = this._isIssueKnownMissing(num, { issueUrl });
      if (task.meta.externalMissing) {
        task.meta.externalMissingReason = "issue_not_found";
      }
    }

    if (issue && (!task.branchName || !task.prNumber)) {
      const comments = Array.isArray(issue?.comments) ? issue.comments : [];
      for (const comment of comments) {
        const body = comment?.body || comment?.bodyText || comment?.body_html || "";
        if (!task.branchName) {
          const branch = extractBranchFromText(body);
          if (branch) task.branchName = branch;
        }
        if (!task.prNumber) {
          const pr = extractPrFromText(body);
          if (pr) task.prNumber = pr;
        }
        if (task.branchName && task.prNumber) break;
      }
    }

    // Enrich with shared state from comments
    if (issue) {
      try {
        const embeddedComments = Array.isArray(issue?.comments)
          ? issue.comments
          : null;
        const sharedState = normalizeSharedStatePayload(
          await this.readSharedStateFromIssue(num, embeddedComments, {
            issueUrl: issue?.url || issueUrl,
          }),
        );
        if (sharedState) {
          task.meta.sharedState = sharedState;
          task.sharedState = sharedState;
        }
      } catch (err) {
        // Non-critical - continue without shared state
        console.warn(
          `[kanban] failed to read shared state for #${num}: ${err.message}`,
        );
      }
    }

    return task;
  }

  async updateTaskStatus(issueNumber, status, options = {}) {
    const locator = this._resolveIssueLocator(issueNumber, options);
    const num = String(locator.number || "").replace(/^#/, "");
    if (!/^\d+$/.test(num)) {
      throw new Error(
        `GitHub Issues: invalid issue number "${issueNumber}" — expected a numeric ID, got a UUID or non-numeric string`,
      );
    }
    const repoRef = `${locator.owner}/${locator.repo}`;

    // Invalidate the instance issue-list cache so the next listTasks() poll
    // sees fresh data rather than stale cache.
    this._issueListCache.clear();
    const normalised = normaliseStatus(status);
    if (normalised === "done" || normalised === "cancelled") {
      const closeArgs = [
        "issue",
        "close",
        num,
        "--repo",
        repoRef,
      ];
      if (normalised === "cancelled") {
        closeArgs.push("--reason", "not planned");
      }
      await this._gh(closeArgs, { parseJson: false });
    } else {
      await this._gh(
        ["issue", "reopen", num, "--repo", repoRef],
        { parseJson: false },
      );

      // Keep status labels in sync for open issues.
      const labelByStatus = {
        draft: "draft",
        inprogress: "inprogress",
        inreview: "inreview",
        blocked: "blocked",
      };
      const nextLabel = labelByStatus[normalised] || null;
      const statusLabels = [
        "draft",
        "inprogress",
        "in-progress",
        "inreview",
        "in-review",
        "blocked",
      ];
      const removeLabels = statusLabels.filter((label) => label !== nextLabel);
      const editArgs = [
        "issue",
        "edit",
        num,
        "--repo",
        repoRef,
      ];
      if (nextLabel) {
        editArgs.push("--add-label", nextLabel);
      }
      for (const label of removeLabels) {
        editArgs.push("--remove-label", label);
      }
      const applyStatusLabels = async () =>
        this._gh(editArgs, { parseJson: false });
      try {
        await applyStatusLabels();
      } catch (err) {
        if (nextLabel) {
          try {
            await this._ensureLabelExists(nextLabel);
            await applyStatusLabels();
          } catch {
            // Label might not exist — non-critical
          }
        }
      }
    }

    // Optionally sync shared state if provided
    if (options.sharedState) {
      try {
        await this.persistSharedStateToIssue(num, options.sharedState);
      } catch (err) {
        console.warn(
          `[kanban] failed to persist shared state for #${num}: ${err.message}`,
        );
      }
    }

    // Sync to project if configured and auto-sync is enabled
    if (
      this._projectMode === "kanban" &&
      this._projectNumber &&
      this._projectAutoSync
    ) {
      const projectNumber = await this._resolveProjectNumber();
      if (projectNumber) {
        const task = await this.getTask(num, { issueUrl: locator.issueUrl });
        if (task?.taskUrl) {
          try {
            await this._syncStatusToProject(
              task.taskUrl,
              projectNumber,
              normalised,
              options.projectFields,
            );
          } catch (err) {
            // Log but don't fail - issue update should still succeed
            console.warn(
              `${TAG} failed to sync status to project: ${err.message}`,
            );
          }
        }
      }
    }

    try {
      return await this.getTask(issueNumber, { issueUrl: locator.issueUrl });
    } catch (err) {
      console.warn(
        `${TAG} failed to fetch updated issue #${num} after status change: ${err.message}`,
      );
      return {
        id: num,
        title: "",
        description: "",
        status: normalised,
        assignee: null,
        priority: null,
        projectId: repoRef,
        branchName: null,
        prNumber: null,
        meta: {},
        taskUrl: locator.issueUrl || `https://github.com/${repoRef}/issues/${num}`,
        backend: "github",
      };
    }
  }

  async updateTask(issueNumber, patch = {}) {
    const locator = this._resolveIssueLocator(issueNumber);
    const num = String(locator.number || "").replace(/^#/, "");
    if (!/^\d+$/.test(num)) {
      throw new Error(
        `GitHub Issues: invalid issue number "${issueNumber}" — expected a numeric ID, got a UUID or non-numeric string`,
      );
    }
    const repoRef = `${locator.owner}/${locator.repo}`;
    const editArgs = [
      "issue",
      "edit",
      num,
      "--repo",
      repoRef,
    ];
    let hasEditArgs = false;
    if (typeof patch.title === "string") {
      editArgs.push("--title", patch.title);
      hasEditArgs = true;
    }
    if (typeof patch.description === "string") {
      editArgs.push("--body", patch.description);
      hasEditArgs = true;
    }
    if (hasEditArgs) {
      await this._gh(editArgs, { parseJson: false });
    }
    const baseBranch = resolveBaseBranchInput(patch);
    const wantsTags =
      Array.isArray(patch.tags) ||
      Array.isArray(patch.labels) ||
      typeof patch.tags === "string";
    if (wantsTags || baseBranch) {
      const issue = await this._gh([
        "issue",
        "view",
        num,
        "--repo",
        repoRef,
        "--json",
        "labels",
      ]);
      const currentLabels = normalizeLabels(
        (issue?.labels || []).map((l) => (typeof l === "string" ? l : l.name)),
      );
      const systemLabels = new Set([
        ...SYSTEM_LABEL_KEYS,
        ...normalizeLabels(this._taskScopeLabels || []),
      ]);
      const currentTags = currentLabels.filter(
        (label) => !systemLabels.has(label) && !isUpstreamLabel(label),
      );
      const desiredTags = wantsTags
        ? normalizeTags(patch.tags ?? patch.labels)
        : currentTags;
      const nextLabels = new Set(
        currentLabels.filter(
          (label) => systemLabels.has(label) || isUpstreamLabel(label),
        ),
      );
      for (const label of desiredTags) nextLabels.add(label);
      if (baseBranch) {
        const upstreamLabel = `base:${baseBranch}`.toLowerCase();
        for (const label of [...nextLabels]) {
          if (isUpstreamLabel(label)) nextLabels.delete(label);
        }
        nextLabels.add(upstreamLabel);
      }
      const desired = [...nextLabels];
      const desiredSet = new Set(desired);
      const toAdd = desired.filter((label) => !currentLabels.includes(label));
      const toRemove = currentLabels.filter(
        (label) => !desiredSet.has(label),
      );
      if (toAdd.length || toRemove.length) {
        const labelArgs = [
          "issue",
          "edit",
          num,
          "--repo",
          repoRef,
        ];
        for (const label of toAdd) {
          labelArgs.push("--add-label", label);
        }
        for (const label of toRemove) {
          labelArgs.push("--remove-label", label);
        }
        try {
          await this._gh(labelArgs, { parseJson: false });
        } catch (err) {
          for (const label of toAdd) {
            try {
              await this._ensureLabelExists(label);
            } catch {
              // ignore
            }
          }
          await this._gh(labelArgs, { parseJson: false });
        }
      }
    }
    if (typeof patch.draft === "boolean" && !patch.status) {
      await this.updateTaskStatus(num, patch.draft ? "draft" : "todo");
    }
    if (typeof patch.status === "string" && patch.status.trim()) {
      return this.updateTaskStatus(num, patch.status.trim());
    }
    return this.getTask(num);
  }

  async addProjectV2DraftIssue(projectNumber, title, body = "") {
    const normalizedTitle = String(title || "").trim();
    if (!normalizedTitle) {
      throw new Error("[kanban] github createTask requires non-empty title");
    }
    const projectId = await this.getProjectNodeId(projectNumber);
    if (!projectId) return null;
    const mutation = `
      mutation {
        addProjectV2DraftIssue(
          input: {
            projectId: ${this._escapeGraphQLString(projectId)},
            title: ${this._escapeGraphQLString(normalizedTitle)},
            body: ${this._escapeGraphQLString(body)}
          }
        ) {
          projectItem {
            id
          }
        }
      }
    `;
    const result = await this._gh(["api", "graphql", "-f", `query=${mutation}`]);
    return result?.data?.addProjectV2DraftIssue?.projectItem?.id || null;
  }

  async convertProjectV2DraftIssueItemToIssue(_projectNumber, projectItemId) {
    if (!projectItemId) return null;
    const repositoryId = await this.getRepositoryNodeId();
    if (!repositoryId) return null;
    const mutation = `
      mutation {
        convertProjectV2DraftIssueItemToIssue(
          input: {
            itemId: ${this._escapeGraphQLString(projectItemId)},
            repositoryId: ${this._escapeGraphQLString(repositoryId)}
          }
        ) {
          item {
            id
          }
          issue {
            number
            url
            title
          }
        }
      }
    `;
    const result = await this._gh(["api", "graphql", "-f", `query=${mutation}`]);
    return result?.data?.convertProjectV2DraftIssueItemToIssue?.issue || null;
  }

  async createTask(projectIdOrTaskData, taskDataArg = {}) {
    const { taskData } = resolveCreateTaskInput(projectIdOrTaskData, taskDataArg);
    const normalizedTitle = String(taskData?.title || "").trim();
    if (!normalizedTitle) {
      throw new Error("[kanban] github createTask requires non-empty title");
    }
    const wantsDraftCreate = Boolean(taskData?.draft || taskData?.createDraft);
    const shouldConvertDraft = Boolean(
      taskData?.convertDraft || taskData?.convertToIssue,
    );
    const requestedStatus = normaliseStatus(taskData.status || "todo");

    let projectNumber = null;
    if (this._projectMode === "kanban") {
      projectNumber = await this._resolveProjectNumber();
    }
    if (wantsDraftCreate && projectNumber) {
      const draftItemId = await this.addProjectV2DraftIssue(
        projectNumber,
        normalizedTitle,
        taskData.description || "",
      );
      if (!draftItemId) {
        throw new Error("[kanban] failed to create draft issue in project");
      }
      if (!shouldConvertDraft) {
        return {
          id: `draft:${draftItemId}`,
          title: normalizedTitle,
          description: taskData.description || "",
          status: requestedStatus,
          assignee: null,
          priority: null,
          projectId: `${this._owner}/${this._repo}`,
          branchName: null,
          prNumber: null,
          meta: {
            projectNumber,
            projectItemId: draftItemId,
            isDraft: true,
          },
          backend: "github",
        };
      }
      const converted = await this.convertProjectV2DraftIssueItemToIssue(
        projectNumber,
        draftItemId,
      );
      const convertedIssueNumber = String(converted?.number || "").trim();
      if (!/^\d+$/.test(convertedIssueNumber)) {
        throw new Error(
          "[kanban] failed to convert draft issue to repository issue",
        );
      }
    const requestedLabels = normalizeLabels([
      ...(taskData.labels || []),
      ...(taskData.tags || []),
    ]);
    const baseBranch = resolveBaseBranchInput(taskData);
    const labelsToApply = new Set(requestedLabels);
    labelsToApply.add(
      String(this._canonicalTaskLabel || "bosun").toLowerCase(),
    );
    if (requestedStatus === "draft") labelsToApply.add("draft");
    if (requestedStatus === "inprogress") labelsToApply.add("inprogress");
    if (requestedStatus === "inreview") labelsToApply.add("inreview");
    if (requestedStatus === "blocked") labelsToApply.add("blocked");
    if (baseBranch) labelsToApply.add(`base:${baseBranch}`.toLowerCase());
      for (const label of labelsToApply) {
        await this._ensureLabelExists(label);
      }
      const assignee =
        taskData.assignee ||
        (this._autoAssignCreator ? await this._resolveDefaultAssignee() : null);
      const editArgs = [
        "issue",
        "edit",
        convertedIssueNumber,
        "--repo",
        `${this._owner}/${this._repo}`,
      ];
      if (assignee) editArgs.push("--add-assignee", assignee);
      for (const label of labelsToApply) {
        editArgs.push("--add-label", label);
      }
      await this._gh(editArgs, { parseJson: false });
      return this.updateTaskStatus(convertedIssueNumber, requestedStatus, {
        projectFields: taskData.projectFields,
      });
    }

    const requestedLabels = normalizeLabels([
      ...(taskData.labels || []),
      ...(taskData.tags || []),
    ]);
    const baseBranch = resolveBaseBranchInput(taskData);
    const labelsToApply = new Set(requestedLabels);
    labelsToApply.add(
      String(this._canonicalTaskLabel || "bosun").toLowerCase(),
    );

    if (requestedStatus === "draft") labelsToApply.add("draft");
    if (requestedStatus === "inprogress") labelsToApply.add("inprogress");
    if (requestedStatus === "inreview") labelsToApply.add("inreview");
    if (requestedStatus === "blocked") labelsToApply.add("blocked");
    if (baseBranch) labelsToApply.add(`base:${baseBranch}`.toLowerCase());

    for (const label of labelsToApply) {
      await this._ensureLabelExists(label);
    }

    const assignee =
      taskData.assignee ||
      (this._autoAssignCreator ? await this._resolveDefaultAssignee() : null);

    const args = [
      "issue",
      "create",
      "--repo",
      `${this._owner}/${this._repo}`,
      "--title",
      normalizedTitle,
      "--body",
      taskData.description || "",
    ];
    if (assignee) args.push("--assignee", assignee);
    if (labelsToApply.size > 0) {
      for (const label of labelsToApply) {
        args.push("--label", label);
      }
    }
    const result = await this._gh(args, { parseJson: false });
    const issueUrl = String(result || "").match(/https?:\/\/\S+/)?.[0] || "";
    const issueNum = issueUrl.match(/\/issues\/(\d+)/)?.[1] || null;
    if (issueUrl) {
      await this._ensureIssueLinkedToProject(issueUrl);
    }
    if (
      issueUrl &&
      projectNumber &&
      this._projectAutoSync &&
      (requestedStatus !== "todo" ||
        (taskData.projectFields &&
          typeof taskData.projectFields === "object" &&
          Object.keys(taskData.projectFields).length > 0))
    ) {
      try {
        await this._syncStatusToProject(
          issueUrl,
          projectNumber,
          requestedStatus,
          taskData.projectFields,
        );
      } catch (err) {
        console.warn(
          `${TAG} failed to sync project fields for created issue: ${err.message}`,
        );
      }
    }
    if (issueNum) {
      return this.getTask(issueNum);
    }
    const numericFallback = String(result || "")
      .trim()
      .match(/^#?(\d+)$/)?.[1];
    if (numericFallback) {
      return this.getTask(numericFallback);
    }
    return { id: issueUrl || String(result || "").trim(), backend: "github" };
  }

  async deleteTask(issueNumber) {
    // GitHub issues can't be deleted — close with "not planned"
    const locator = this._resolveIssueLocator(issueNumber);
    const num = String(locator.number || "").replace(/^#/, "");
    if (!/^\d+$/.test(num)) {
      throw new Error(
        `GitHub Issues: invalid issue number "${issueNumber}" — expected a numeric ID`,
      );
    }
    const repoRef = `${locator.owner}/${locator.repo}`;
    await this._gh([
      "issue",
      "close",
      num,
      "--repo",
      repoRef,
      "--reason",
      "not planned",
    ]);
    return true;
  }

  async addComment(issueNumber, body) {
    const locator = this._resolveIssueLocator(issueNumber);
    const num = String(locator.number || "").replace(/^#/, "");
    if (!/^\d+$/.test(num) || !body) return false;
    const repoRef = `${locator.owner}/${locator.repo}`;
    try {
      await this._gh(
        [
          "issue",
          "comment",
          num,
          "--repo",
          repoRef,
          "--body",
          String(body).slice(0, 65536),
        ],
        { parseJson: false },
      );
      return true;
    } catch (err) {
      console.warn(
        `[kanban] failed to comment on issue #${num}: ${err.message}`,
      );
      return false;
    }
  }

  /**
   * Persist shared state to a GitHub issue using structured comments and labels.
   *
   * Creates or updates a bosun-state comment with JSON state and applies
   * appropriate labels (codex:claimed, codex:working, codex:stale).
   *
   * Error handling: Retries once on failure, logs and continues on second failure.
   *
   * @param {string|number} issueNumber - GitHub issue number
   * @param {SharedState} sharedState - State object to persist
   * @returns {Promise<boolean>} Success status
   *
   * @example
   * await adapter.persistSharedStateToIssue(123, {
   *   ownerId: "workstation-123/agent-456",
   *   attemptToken: "uuid-here",
   *   attemptStarted: "2026-02-14T17:00:00Z",
   *   heartbeat: "2026-02-14T17:30:00Z",
   *   status: "working",
   *   retryCount: 1
   * });
   */
  async persistSharedStateToIssue(issueNumber, sharedState) {
    const locator = this._resolveIssueLocator(issueNumber);
    const num = String(locator.number || "").replace(/^#/, "");
    if (!/^\d+$/.test(num)) {
      throw new Error(`Invalid issue number: ${issueNumber}`);
    }
    const repoRef = `${locator.owner}/${locator.repo}`;
    const issueUrl =
      locator.issueUrl || `https://github.com/${repoRef}/issues/${num}`;
    const normalizedState = normalizeSharedStatePayload(sharedState);
    if (!normalizedState) {
      throw new Error(`Invalid shared state payload for issue #${num}`);
    }

    const attemptWithRetry = async (fn, maxRetries = 1) => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await fn();
        } catch (err) {
          if (attempt === maxRetries) {
            console.error(
              `[kanban] persistSharedStateToIssue #${num} failed after ${maxRetries + 1} attempts: ${err.message}`,
            );
            return false;
          }
          console.warn(
            `[kanban] persistSharedStateToIssue #${num} attempt ${attempt + 1} failed, retrying: ${err.message}`,
          );
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    };

    // 1. Update labels based on status
    const labelsSuccess = await attemptWithRetry(async () => {
      const currentLabels = await this._getIssueLabels(num);
      const codexLabels = Object.values(this._codexLabels);
      const otherLabels = currentLabels.filter(
        (label) => !codexLabels.includes(label),
      );

      // Determine new codex label based on status
      let newCodexLabel = null;
      if (normalizedState.status === "claimed") {
        newCodexLabel = this._codexLabels.claimed;
      } else if (normalizedState.status === "working") {
        newCodexLabel = this._codexLabels.working;
      } else if (normalizedState.status === "stale") {
        newCodexLabel = this._codexLabels.stale;
      }

      // Build new label set
      const newLabels = [...otherLabels];
      if (newCodexLabel) {
        newLabels.push(newCodexLabel);
      }

      // Apply labels
      const editArgs = [
        "issue",
        "edit",
        num,
        "--repo",
        repoRef,
      ];

      // Remove old codex labels
      for (const label of codexLabels) {
        if (label !== newCodexLabel && currentLabels.includes(label)) {
          editArgs.push("--remove-label", label);
        }
      }

      // Add new codex label
      if (newCodexLabel && !currentLabels.includes(newCodexLabel)) {
        editArgs.push("--add-label", newCodexLabel);
      }

      if (editArgs.length > 6) {
        // Only run if we have label changes
        await this._gh(editArgs, { parseJson: false });
      }
      return true;
    });

    // Short-circuit: if labels failed, skip comment update to avoid hanging
    if (!labelsSuccess) return false;

    // 2. Create/update structured comment
    const commentSuccess = await attemptWithRetry(async () => {
      const comments = await this._getIssueComments(num, { issueUrl });
      const stateCommentIndex = comments.findIndex((c) =>
        c.body?.includes("<!-- bosun-state"),
      );

      const [agentId, workstationId] = normalizedState.ownerId
        .split("/")
        .reverse();
      const stateJson = JSON.stringify(normalizedState, null, 2);
      const commentBody = `<!-- bosun-state
${stateJson}
-->
**Bosun Status**: Agent \`${agentId}\` on \`${workstationId}\` is ${normalizedState.status === "working" ? "working on" : normalizedState.status === "claimed" ? "claiming" : "stale for"} this task.
*Last heartbeat: ${normalizedState.heartbeat || normalizedState.ownerHeartbeat}*`;

      if (stateCommentIndex >= 0) {
        // Update existing comment
        const commentId = comments[stateCommentIndex].id;
        await this._gh(
          [
            "api",
            `/repos/${locator.owner}/${locator.repo}/issues/comments/${commentId}`,
            "-X",
            "PATCH",
            "-f",
            `body=${commentBody}`,
          ],
          { parseJson: false },
        );
      } else {
        // Create new comment
        await this.addComment(num, commentBody);
      }
      return true;
    });

    // Invalidate the shared-state cache so the next read fetches fresh data
    if (commentSuccess) {
      this._sharedStateCache.delete(_sharedStateCacheKey(num, locator.repoKey));
    }

    return commentSuccess;
  }

  /**
   * Read shared state from a GitHub issue by parsing bosun-state comments.
   *
   * Searches for the latest comment containing the structured state JSON and
   * returns the parsed SharedState object, or null if not found.
   *
   * @param {string|number} issueNumber - GitHub issue number
   * @returns {Promise<SharedState|null>} Parsed shared state or null
   *
   * @example
   * const state = await adapter.readSharedStateFromIssue(123);
   * if (state) {
   *   console.log(`Task claimed by ${state.ownerId}`);
   * }
   */
  async readSharedStateFromIssue(issueNumber, cachedComments = null, options = {}) {
    const issueUrl = String(options?.issueUrl || "").trim();
    const locator = parseIssueRefLocator(
      issueNumber,
      this._owner,
      this._repo,
      issueUrl,
    );
    const num = locator.number;
    if (!/^\d+$/.test(num)) {
      throw new Error(`Invalid issue number: ${issueNumber}`);
    }
    if (issueUrl) {
      this._rememberIssueLocator(num, issueUrl);
    }

    // If no pre-fetched comments, check the instance-level shared-state cache
    // to avoid a separate API call per issue during bulk listTasks cycles.
    if (!cachedComments) {
      const cacheKey = _sharedStateCacheKey(num, locator.repoKey);
      const cached = this._sharedStateCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < GH_SHARED_STATE_CACHE_TTL_MS) {
        return cached.data;
      }
    }

    try {
      const comments =
        cachedComments ?? await this._getIssueComments(num, { issueUrl });
      const stateComment = Array.isArray(comments)
        ? comments
            .slice()
            .reverse()
            .find((c) => c.body?.includes("<!-- bosun-state"))
        : null;

      if (!stateComment) {
        // Cache the null result too so repeated calls within the TTL skip the API
        if (!cachedComments) {
          this._sharedStateCache.set(
            _sharedStateCacheKey(num, locator.repoKey),
            { data: null, ts: Date.now() },
          );
        }
        return null;
      }

      // Extract JSON from comment
      const match = stateComment.body.match(
        /<!-- bosun-state\s*\n([\s\S]*?)\n-->/,
      );
      if (!match) {
        return null;
      }

      const stateJson = match[1].trim();
      const state = normalizeSharedStatePayload(JSON.parse(stateJson));

      // Validate required fields
      if (
        !state?.ownerId ||
        !state?.attemptToken ||
        !state?.attemptStarted ||
        !(state?.heartbeat || state?.ownerHeartbeat) ||
        !state?.status
      ) {
        console.warn(
          `[kanban] invalid shared state in #${num}: missing required fields`,
        );
        return null;
      }

      // Cache the result for the TTL window
      if (!cachedComments) {
        this._sharedStateCache.set(
          _sharedStateCacheKey(num, locator.repoKey),
          { data: state, ts: Date.now() },
        );
      }

      return state;
    } catch (err) {
      console.warn(
        `[kanban] failed to read shared state for #${num}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Mark a task as ignored by bosun.
   *
   * Adds the `codex:ignore` label and posts a comment explaining why the task
   * is being ignored. This prevents bosun from repeatedly attempting
   * to claim or work on tasks that are not suitable for automation.
   *
   * @param {string|number} issueNumber - GitHub issue number
   * @param {string} reason - Human-readable reason for ignoring
   * @returns {Promise<boolean>} Success status
   *
   * @example
   * await adapter.markTaskIgnored(123, "Task requires manual security review");
   */
  async markTaskIgnored(issueNumber, reason) {
    const locator = this._resolveIssueLocator(issueNumber);
    const num = String(locator.number || "").replace(/^#/, "");
    if (!/^\d+$/.test(num)) {
      throw new Error(`Invalid issue number: ${issueNumber}`);
    }
    const repoRef = `${locator.owner}/${locator.repo}`;

    try {
      // Add codex:ignore label
      await this._gh(
        [
          "issue",
          "edit",
          num,
          "--repo",
          repoRef,
          "--add-label",
          this._codexLabels.ignore,
        ],
        { parseJson: false },
      );

      // Add comment explaining why
      const commentBody = `**Bosun**: This task has been marked as ignored.

**Reason**: ${reason}

To re-enable bosun for this task, remove the \`${this._codexLabels.ignore}\` label.`;

      await this.addComment(num, commentBody);

      return true;
    } catch (err) {
      console.error(
        `[kanban] failed to mark task #${num} as ignored: ${err.message}`,
      );
      return false;
    }
  }

  /**
   * Remove the ignored marker from a task.
   *
   * Removes the `codex:ignore` label so bosun automation can resume.
   *
   * @param {string|number} issueNumber - GitHub issue number
   * @returns {Promise<boolean>} Success status
   */
  async unmarkTaskIgnored(issueNumber) {
    const locator = this._resolveIssueLocator(issueNumber);
    const num = String(locator.number || "").replace(/^#/, "");
    if (!/^\d+$/.test(num)) {
      throw new Error(`Invalid issue number: ${issueNumber}`);
    }
    const repoRef = `${locator.owner}/${locator.repo}`;

    try {
      await this._gh(
        [
          "issue",
          "edit",
          num,
          "--repo",
          repoRef,
          "--remove-label",
          this._codexLabels.ignore,
        ],
        { parseJson: false },
      );
      return true;
    } catch (err) {
      console.error(
        `[kanban] failed to unmark task #${num} ignored: ${err.message}`,
      );
      return false;
    }
  }

  /**
   * Get all labels for an issue.
   * @private
   */
  async _getIssueLabels(issueNumber) {
    const locator = this._resolveIssueLocator(issueNumber);
    const num = String(locator.number || "").replace(/^#/, "");
    const repoRef = `${locator.owner}/${locator.repo}`;
    const issue = await this._gh([
      "issue",
      "view",
      num,
      "--repo",
      repoRef,
      "--json",
      "labels",
    ]);
    return (issue.labels || []).map((l) =>
      typeof l === "string" ? l : l.name,
    );
  }

  /**
   * Get all comments for an issue.
   * @private
   */
  async _getIssueComments(issueNumber, options = {}) {
    const issueUrl = String(options?.issueUrl || "").trim();
    const locator = parseIssueRefLocator(
      issueNumber,
      this._owner,
      this._repo,
      issueUrl,
    );
    const resolvedIssueUrl =
      issueUrl ||
      `https://github.com/${locator.owner}/${locator.repo}/issues/${locator.number}`;
    if (/^\d+$/.test(locator.number)) {
      this._rememberIssueLocator(locator.number, resolvedIssueUrl);
    }
    if (this._isIssueKnownMissing(locator.number, { issueUrl: resolvedIssueUrl })) {
      return [];
    }
    try {
      const result = await this._gh([
        "api",
        `/repos/${locator.owner}/${locator.repo}/issues/${locator.number}/comments`,
        "--jq",
        ".",
      ]);
      this._clearIssueMissing(locator.number, { issueUrl: resolvedIssueUrl });
      return Array.isArray(result) ? result : [];
    } catch (err) {
      if (err?.isNotFound) {
        this._markIssueMissing(locator.number, { issueUrl: resolvedIssueUrl });
      } else {
        console.warn(
          `[kanban] failed to fetch comments for ${locator.owner}/${locator.repo}#${locator.number}: ${err.message}`,
        );
      }
      return [];
    }
  }

  _isTaskScopedForCodex(task) {
    const labels = normalizeLabels(
      (task?.meta?.labels || []).map((entry) =>
        typeof entry === "string" ? entry : entry?.name,
      ),
    );
    if (labels.length === 0) return false;
    return this._taskScopeLabels.some((label) => labels.includes(label));
  }

  async _resolveDefaultAssignee() {
    if (this._defaultAssignee) return this._defaultAssignee;
    try {
      const login = await this._gh(["api", "user", "--jq", ".login"], {
        parseJson: false,
      });
      const normalized = String(login || "").trim();
      if (normalized) {
        this._defaultAssignee = normalized;
      }
    } catch {
      this._defaultAssignee = null;
    }
    return this._defaultAssignee;
  }

  async _ensureLabelExists(label) {
    const normalized = String(label || "").trim();
    if (!normalized) return;
    try {
      await this._gh(
        [
          "api",
          `/repos/${this._owner}/${this._repo}/labels`,
          "-X",
          "POST",
          "-f",
          `name=${normalized}`,
          "-f",
          "color=1D76DB",
          "-f",
          "description=Managed by bosun",
        ],
        { parseJson: false },
      );
    } catch (err) {
      const text = String(err?.message || err).toLowerCase();
      if (
        text.includes("already_exists") ||
        text.includes("already exists") ||
        text.includes("unprocessable") ||
        text.includes("422")
      ) {
        return;
      }
      console.warn(
        `[kanban] failed to ensure label "${normalized}": ${err.message || err}`,
      );
    }
  }

  _extractProjectNumber(value) {
    if (!value) return null;
    const text = String(value).trim();
    if (/^\d+$/.test(text)) return text;
    const match = text.match(/\/projects\/(\d+)(?:\b|$)/i);
    return match?.[1] || null;
  }

  async _resolveProjectNumber() {
    if (this._cachedProjectNumber) return this._cachedProjectNumber;
    const owner = String(this._projectOwner || "").trim();
    const title = String(this._projectTitle || "Bosun").trim();
    if (!owner || !title) return null;

    try {
      const projects = await this._gh(
        ["project", "list", "--owner", owner, "--format", "json"],
        { parseJson: true },
      );
      const list = Array.isArray(projects)
        ? projects
        : Array.isArray(projects?.projects)
          ? projects.projects
          : [];
      const existing = list.find(
        (project) =>
          String(project?.title || "")
            .trim()
            .toLowerCase() === title.toLowerCase(),
      );
      const existingNumber = this._extractProjectNumber(
        existing?.number || existing?.url,
      );
      if (existingNumber) {
        this._cachedProjectNumber = existingNumber;
        return existingNumber;
      }
    } catch {
      return null;
    }

    try {
      const output = await this._gh(
        ["project", "create", "--owner", owner, "--title", title],
        { parseJson: false },
      );
      const createdNumber = this._extractProjectNumber(output);
      if (createdNumber) {
        this._cachedProjectNumber = createdNumber;
        return createdNumber;
      }
    } catch {
      return null;
    }

    return null;
  }

  async _ensureIssueLinkedToProject(issueUrl) {
    if (this._projectMode !== "kanban") return;
    const owner = String(this._projectOwner || "").trim();
    if (!owner || !issueUrl) return;
    const projectNumber = await this._resolveProjectNumber();
    if (!projectNumber) return;

    try {
      await this._gh(
        [
          "project",
          "item-add",
          String(projectNumber),
          "--owner",
          owner,
          "--url",
          issueUrl,
        ],
        { parseJson: false },
      );
    } catch (err) {
      const text = String(err?.message || err).toLowerCase();
      if (text.includes("already") && text.includes("item")) {
        return;
      }
      console.warn(
        `[kanban] failed to add issue to project ${owner}/${projectNumber}: ${err.message || err}`,
      );
    }
  }

  _normaliseIssue(issue) {
    if (!issue) return null;
    const fallbackNum = String(issue.number || "").trim();
    const fallbackUrl = fallbackNum
      ? `https://github.com/${this._owner}/${this._repo}/issues/${fallbackNum}`
      : null;
    const locator = parseIssueRefLocator(
      fallbackNum,
      this._owner,
      this._repo,
      issue.url || fallbackUrl || "",
    );
    const issueNum = /^\d+$/.test(locator.number)
      ? locator.number
      : fallbackNum;
    const issueUrl = issue.url || fallbackUrl || null;
    const projectId = `${locator.owner}/${locator.repo}`;
    if (issueNum && issueUrl) {
      this._rememberIssueLocator(issueNum, issueUrl);
    }
    const labels = (issue.labels || []).map((l) =>
      typeof l === "string" ? l : l.name,
    );
    const labelSet = new Set(
      labels.map((l) =>
        String(l || "")
          .trim()
          .toLowerCase(),
      ),
    );
    const labelStatus = statusFromLabels(labels);
    const tags = extractTagsFromLabels(labels, this._taskScopeLabels || []);
    let status = "todo";
    if (issue.state === "closed" || issue.state === "CLOSED") {
      status = "done";
    } else if (labelStatus) {
      status = labelStatus;
    }
    if (labelSet.has("draft")) status = "draft";

    // Check for bosun labels
    const codexMeta = {
      isIgnored: labelSet.has("codex:ignore"),
      isClaimed: labelSet.has("codex:claimed"),
      isWorking: labelSet.has("codex:working"),
      isStale: labelSet.has("codex:stale"),
    };

    // Extract branch name from issue body if present
    const branchMatch = (issue.body || "").match(/branch:\s*`?([^\s`]+)`?/i);
    const prMatch = (issue.body || "").match(/pr:\s*#?(\d+)/i);
    const baseBranch = normalizeBranchName(
      extractBaseBranchFromLabels(labels) ||
        extractBaseBranchFromText(issue.body || ""),
    );
    const comments = normalizeCommentList(
      Array.isArray(issue.comments) ? issue.comments : [],
    );
    const descriptionAttachments = extractAttachmentsFromText(issue.body || "", {
      source: "github",
      sourceType: "issue",
      createdAt: issue.createdAt || issue.created_at || null,
    });
    const commentAttachments = comments.flatMap((comment) =>
      extractAttachmentsFromText(comment.body, {
        source: "github",
        sourceType: "comment",
        commentId: comment.id,
        author: comment.author,
        createdAt: comment.createdAt,
      }),
    );
    const localAttachments = listTaskAttachments(issueNum, "github");
    const mergedAttachments = mergeTaskAttachments(
      mergeTaskAttachments(descriptionAttachments, commentAttachments),
      localAttachments,
    );

    return {
      id: String(issueNum || ""),
      title: issue.title || "",
      description: issue.body || "",
      status,
      assignee: issue.assignees?.[0]?.login || null,
      priority: labelSet.has("critical")
        ? "critical"
        : labelSet.has("high")
          ? "high"
          : null,
      tags,
      draft: labelSet.has("draft") || status === "draft",
      projectId,
      baseBranch,
      branchName: branchMatch?.[1] || null,
      prNumber: prMatch?.[1] || null,
      attachments: mergedAttachments,
      comments,
      meta: {
        ...issue,
        task_url: issueUrl,
        tags,
        comments,
        attachments: mergedAttachments,
        ...(baseBranch ? { base_branch: baseBranch, baseBranch } : {}),
        codex: codexMeta,
      },
      taskUrl: issueUrl,
      backend: "github",
    };
  }
}

// ---------------------------------------------------------------------------
// Jira Adapter
// ---------------------------------------------------------------------------

class JiraAdapter {
  constructor() {
    this.name = "jira";
    this._baseUrl = String(process.env.JIRA_BASE_URL || "")
      .trim()
      .replace(/\/+$/, "");
    this._token = process.env.JIRA_API_TOKEN || null;
    this._email = process.env.JIRA_EMAIL || null;
    this._defaultProjectKey = String(process.env.JIRA_PROJECT_KEY || "")
      .trim()
      .toUpperCase();
    this._defaultIssueType = String(
      process.env.JIRA_ISSUE_TYPE || process.env.JIRA_DEFAULT_ISSUE_TYPE || "Task",
    ).trim();
    this._taskListLimit =
      Number(process.env.JIRA_ISSUES_LIST_LIMIT || 250) || 250;
    this._useAdfComments = parseBooleanEnv(process.env.JIRA_USE_ADF_COMMENTS, true);
    this._defaultAssignee = String(process.env.JIRA_DEFAULT_ASSIGNEE || "").trim();
    this._subtaskParentKey = String(
      process.env.JIRA_SUBTASK_PARENT_KEY || "",
    ).trim();
    this._canonicalTaskLabel = String(
      process.env.BOSUN_TASK_LABEL || "bosun",
    )
      .trim()
      .toLowerCase();
    this._taskScopeLabels = normalizeLabels(
      process.env.JIRA_TASK_LABELS ||
        process.env.BOSUN_TASK_LABELS ||
        `${this._canonicalTaskLabel},bosun`,
    ).map((label) => this._sanitizeJiraLabel(label));
    this._enforceTaskLabel = parseBooleanEnv(
      process.env.JIRA_ENFORCE_TASK_LABEL ?? process.env.BOSUN_ENFORCE_TASK_LABEL,
      true,
    );
    this._codexLabels = {
      claimed: this._sanitizeJiraLabel(
        process.env.JIRA_LABEL_CLAIMED ||
          process.env.JIRA_CODEX_LABEL_CLAIMED ||
          "codex-claimed",
      ),
      working: this._sanitizeJiraLabel(
        process.env.JIRA_LABEL_WORKING ||
          process.env.JIRA_CODEX_LABEL_WORKING ||
          "codex-working",
      ),
      stale: this._sanitizeJiraLabel(
        process.env.JIRA_LABEL_STALE ||
          process.env.JIRA_CODEX_LABEL_STALE ||
          "codex-stale",
      ),
      ignore: this._sanitizeJiraLabel(
        process.env.JIRA_LABEL_IGNORE ||
          process.env.JIRA_CODEX_LABEL_IGNORE ||
          "codex-ignore",
      ),
    };
    this._statusMap = {
      todo: process.env.JIRA_STATUS_TODO || "To Do",
      inprogress: process.env.JIRA_STATUS_INPROGRESS || "In Progress",
      inreview: process.env.JIRA_STATUS_INREVIEW || "In Review",
      done: process.env.JIRA_STATUS_DONE || "Done",
      cancelled: process.env.JIRA_STATUS_CANCELLED || "Cancelled",
    };
    this._sharedStateFields = {
      ownerId: process.env.JIRA_CUSTOM_FIELD_OWNER_ID || "",
      attemptToken: process.env.JIRA_CUSTOM_FIELD_ATTEMPT_TOKEN || "",
      attemptStarted: process.env.JIRA_CUSTOM_FIELD_ATTEMPT_STARTED || "",
      heartbeat: process.env.JIRA_CUSTOM_FIELD_HEARTBEAT || "",
      retryCount: process.env.JIRA_CUSTOM_FIELD_RETRY_COUNT || "",
      ignoreReason: process.env.JIRA_CUSTOM_FIELD_IGNORE_REASON || "",
      stateJson: process.env.JIRA_CUSTOM_FIELD_SHARED_STATE || "",
    };
    this._customFieldBaseBranch = String(
      process.env.JIRA_CUSTOM_FIELD_BASE_BRANCH || "",
    ).trim();
    this._jiraFieldByNameCache = null;
  }

  _requireConfigured() {
    if (!this._baseUrl || !this._email || !this._token) {
      throw new Error(
        `${TAG} Jira adapter requires JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN`,
      );
    }
  }

  _validateIssueKey(issueKey) {
    const key = String(issueKey || "")
      .trim()
      .toUpperCase();
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) {
      throw new Error(
        `Jira: invalid issue key "${issueKey}" — expected format PROJ-123`,
      );
    }
    return key;
  }

  _normalizeProjectKey(projectKey) {
    const key = String(projectKey || this._defaultProjectKey || "")
      .trim()
      .toUpperCase();
    return /^[A-Z][A-Z0-9]+$/.test(key) ? key : "";
  }

  _normalizeIssueKey(issueKey) {
    const key = String(issueKey || "").trim().toUpperCase();
    return /^[A-Z][A-Z0-9]+-\d+$/.test(key) ? key : "";
  }

  _sanitizeJiraLabel(value) {
    const raw = String(value || "").trim().toLowerCase();
    let normalized = raw.replace(/[^a-z0-9_-]+/g, "-");
    while (normalized.startsWith("-")) normalized = normalized.slice(1);
    while (normalized.endsWith("-")) normalized = normalized.slice(0, -1);
    return normalized;
  }

  _authHeaders() {
    const credentials = Buffer.from(`${this._email}:${this._token}`).toString(
      "base64",
    );
    return {
      Authorization: `Basic ${credentials}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  async _jira(path, options = {}) {
    this._requireConfigured();
    const method = options.method || "GET";
    const headers = {
      ...this._authHeaders(),
      ...(options.headers || {}),
    };
    const response = await fetchWithFallback(
      `${this._baseUrl}${path.startsWith("/") ? path : `/${path}`}`,
      {
        method,
        headers,
        body: options.body == null ? undefined : JSON.stringify(options.body),
      },
    );
    if (!response || typeof response.status !== "number") {
      throw new Error(`Jira API ${method} ${path} failed: no HTTP response`);
    }

    if (response.status === 204) return null;

    const contentType = String(response.headers.get("content-type") || "");
    let payload = null;
    if (contentType.includes("application/json")) {
      payload = await response.json().catch(() => null);
    } else {
      payload = await response.text().catch(() => "");
    }

    if (!response.ok) {
      const errorText =
        payload?.errorMessages?.join("; ") ||
        (payload?.errors ? Object.values(payload.errors || {}).join("; ") : "");
      const error = new Error(
        `Jira API ${method} ${path} failed (${response.status}): ${errorText || String(payload || response.statusText || "Unknown error")}`,
      );
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  _adfParagraph(text, marks = []) {
    return {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: String(text || ""),
          ...(Array.isArray(marks) && marks.length > 0 ? { marks } : {}),
        },
      ],
    };
  }

  _textToAdf(text) {
    const value = String(text || "");
    if (!value.trim()) {
      return { type: "doc", version: 1, content: [this._adfParagraph("")] };
    }
    const lines = value.split(/\r?\n/);
    return {
      type: "doc",
      version: 1,
      content: lines.map((line) => this._adfParagraph(line)),
    };
  }

  _adfToText(node) {
    if (!node) return "";
    if (typeof node === "string") return node;
    if (Array.isArray(node)) {
      return node.map((entry) => this._adfToText(entry)).join("");
    }
    if (node.type === "text") return String(node.text || "");
    const content = Array.isArray(node.content) ? node.content : [];
    const inner = content.map((entry) => this._adfToText(entry)).join("");
    if (node.type === "paragraph" || node.type === "heading") {
      return `${inner}\n`;
    }
    if (node.type === "hardBreak") return "\n";
    return inner;
  }

  _commentToText(commentBody) {
    if (typeof commentBody === "string") return commentBody;
    if (commentBody && typeof commentBody === "object") {
      return this._adfToText(commentBody).trim();
    }
    return "";
  }

  _normalizePriority(priorityName) {
    const value = String(priorityName || "")
      .trim()
      .toLowerCase();
    if (!value) return null;
    if (value.includes("highest") || value.includes("critical")) return "critical";
    if (value.includes("high")) return "high";
    if (value.includes("medium") || value.includes("normal")) return "medium";
    if (value.includes("low") || value.includes("lowest")) return "low";
    return null;
  }

  _normalizeJiraStatus(statusObj) {
    if (!statusObj) return "todo";
    const statusCategory = String(statusObj?.statusCategory?.key || "")
      .trim()
      .toLowerCase();
    if (statusCategory === "done") return "done";
    return normaliseStatus(statusObj.name || statusObj.statusCategory?.name || "");
  }

  _normaliseIssue(issue) {
    const fields = issue?.fields || {};
    const labels = normalizeLabels(fields.labels || []);
    const labelSet = new Set(labels);
    const tags = extractTagsFromLabels(labels, this._taskScopeLabels || []);
    const codexMeta = {
      isIgnored:
        labelSet.has(this._codexLabels.ignore) || labelSet.has("codex:ignore"),
      isClaimed:
        labelSet.has(this._codexLabels.claimed) || labelSet.has("codex:claimed"),
      isWorking:
        labelSet.has(this._codexLabels.working) || labelSet.has("codex:working"),
      isStale: labelSet.has(this._codexLabels.stale) || labelSet.has("codex:stale"),
    };
    const description = this._commentToText(fields.description);
    const branchMatch = description.match(/branch:\s*`?([^\s`]+)`?/i);
    const prMatch = description.match(/pr:\s*#?(\d+)/i);
    const baseBranchFromField = this._customFieldBaseBranch
      ? fields[this._customFieldBaseBranch]
      : null;
    const baseBranch = normalizeBranchName(
      extractBaseBranchFromLabels(labels) ||
        extractBaseBranchFromText(description) ||
        (typeof baseBranchFromField === "string"
          ? baseBranchFromField
          : baseBranchFromField?.value ||
            baseBranchFromField?.name ||
            baseBranchFromField),
    );
    const issueKey = String(issue?.key || "");
    let status = this._normalizeJiraStatus(fields.status);
    if (labelSet.has("draft")) status = "draft";
    const normalizedFieldValues = {};
    for (const [fieldKey, fieldValue] of Object.entries(fields || {})) {
      if (fieldValue == null) continue;
      const lcKey = String(fieldKey || "").toLowerCase();
      if (typeof fieldValue === "object") {
        if (typeof fieldValue.name === "string") {
          normalizedFieldValues[fieldKey] = fieldValue.name;
          normalizedFieldValues[lcKey] = fieldValue.name;
        } else if (typeof fieldValue.value === "string") {
          normalizedFieldValues[fieldKey] = fieldValue.value;
          normalizedFieldValues[lcKey] = fieldValue.value;
        } else {
          normalizedFieldValues[fieldKey] = this._commentToText(fieldValue);
          normalizedFieldValues[lcKey] = this._commentToText(fieldValue);
        }
      } else {
        normalizedFieldValues[fieldKey] = fieldValue;
        normalizedFieldValues[lcKey] = fieldValue;
      }
    }
    const rawComments = Array.isArray(fields.comment?.comments)
      ? fields.comment.comments
      : [];
    const comments = rawComments
      .map((comment) => {
        const body = this._commentToText(comment?.body).trim();
        if (!body || isBosunStateComment(body)) return null;
        return {
          id: comment?.id || null,
          author:
            comment?.author?.displayName ||
            comment?.author?.emailAddress ||
            comment?.author?.accountId ||
            null,
          createdAt: comment?.created || null,
          body,
          url: comment?.self || null,
        };
      })
      .filter(Boolean);
    const commentAttachments = comments.flatMap((comment) =>
      extractAttachmentsFromText(comment.body, {
        source: "jira",
        sourceType: "comment",
        commentId: comment.id,
        author: comment.author,
        createdAt: comment.createdAt,
      }),
    );
    const rawAttachments = Array.isArray(fields.attachment)
      ? fields.attachment
      : [];
    const jiraAttachments = rawAttachments
      .map((attachment) => {
        const name = attachment?.filename || attachment?.name || "attachment";
        const url = attachment?.content || attachment?.self || attachment?.thumbnail;
        if (!url) return null;
        const kind = guessAttachmentKind(
          url,
          name,
          String(attachment?.mimeType || "").startsWith("image/"),
        );
        return {
          id: attachment?.id || null,
          name,
          url,
          kind,
          contentType: attachment?.mimeType || guessContentType(name, kind),
          size: attachment?.size ?? null,
          source: "jira",
          sourceType: "attachment",
          createdAt: attachment?.created || null,
        };
      })
      .filter(Boolean);
    const localAttachments = listTaskAttachments(issueKey, "jira");
    const mergedAttachments = mergeTaskAttachments(
      mergeTaskAttachments(jiraAttachments, commentAttachments),
      localAttachments,
    );
    return {
      id: issueKey,
      title: fields.summary || "",
      description,
      status,
      assignee:
        fields.assignee?.displayName ||
        fields.assignee?.emailAddress ||
        fields.assignee?.accountId ||
        null,
      priority: this._normalizePriority(fields.priority?.name),
      tags,
      draft: labelSet.has("draft") || status === "draft",
      projectId: fields.project?.key || null,
      baseBranch,
      branchName: branchMatch?.[1] || null,
      prNumber: prMatch?.[1] || null,
      taskUrl: issueKey ? `${this._baseUrl}/browse/${issueKey}` : null,
      createdAt: fields.created || null,
      updatedAt: fields.updated || null,
      attachments: mergedAttachments,
      comments,
      meta: {
        ...issue,
        labels,
        fields: normalizedFieldValues,
        tags,
        comments,
        attachments: mergedAttachments,
        ...(baseBranch ? { base_branch: baseBranch, baseBranch } : {}),
        codex: codexMeta,
      },
      backend: "jira",
    };
  }

  _isTaskScopedForCodex(task) {
    const labels = normalizeLabels(task?.meta?.labels || []);
    if (labels.length === 0) return false;
    return this._taskScopeLabels.some((label) => labels.includes(label));
  }

  _statusCandidates(normalizedStatus) {
    switch (normalizedStatus) {
      case "todo":
        return ["to do", "todo", "selected for development", "open", "backlog"];
      case "inprogress":
        return ["in progress", "in development", "doing", "active"];
      case "inreview":
        return ["in review", "review", "code review", "qa", "testing"];
      case "done":
        return ["done", "resolved", "closed", "complete", "completed"];
      case "cancelled":
        return ["cancelled", "canceled", "won't do", "wont do", "declined"];
      default:
        return [String(normalizedStatus || "").trim().toLowerCase()];
    }
  }

  _normalizeIsoTimestamp(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return "";
    return date.toISOString();
  }

  async _getJiraFieldMap() {
    if (this._jiraFieldByNameCache) return this._jiraFieldByNameCache;
    const fields = await this._jira("/rest/api/3/field");
    const map = new Map();
    for (const field of Array.isArray(fields) ? fields : []) {
      const id = String(field?.id || "").trim();
      const name = String(field?.name || "")
        .trim()
        .toLowerCase();
      if (!id || !name) continue;
      map.set(name, id);
    }
    this._jiraFieldByNameCache = map;
    return map;
  }

  async _resolveJiraFieldId(fieldKeyOrName) {
    const raw = String(fieldKeyOrName || "").trim();
    if (!raw) return null;
    if (/^customfield_\d+$/i.test(raw)) return raw;
    const lc = raw.toLowerCase();
    if (
      [
        "summary",
        "description",
        "status",
        "assignee",
        "priority",
        "project",
        "labels",
      ].includes(lc)
    ) {
      return lc;
    }
    try {
      const map = await this._getJiraFieldMap();
      return map.get(lc) || null;
    } catch {
      return null;
    }
  }

  async _mapProjectFieldsInput(projectFields = {}) {
    const mapped = {};
    for (const [fieldName, value] of Object.entries(projectFields || {})) {
      const fieldId = await this._resolveJiraFieldId(fieldName);
      if (!fieldId || fieldId === "status") continue;
      mapped[fieldId] = value;
    }
    return mapped;
  }

  _matchesProjectFieldFilters(task, projectFieldFilter) {
    if (!projectFieldFilter || typeof projectFieldFilter !== "object") {
      return true;
    }
    const values = task?.meta?.fields;
    if (!values || typeof values !== "object") return false;
    const entries = Object.entries(projectFieldFilter);
    if (entries.length === 0) return true;
    return entries.every(([fieldName, expected]) => {
      const direct = values[fieldName];
      const custom = values[String(fieldName).toLowerCase()];
      const actual = direct ?? custom ?? null;
      if (Array.isArray(expected)) {
        const expectedSet = new Set(
          expected.map((entry) =>
            String(entry == null ? "" : entry)
              .trim()
              .toLowerCase(),
          ),
        );
        return expectedSet.has(
          String(actual == null ? "" : actual)
            .trim()
            .toLowerCase(),
        );
      }
      return (
        String(actual == null ? "" : actual)
          .trim()
          .toLowerCase() ===
        String(expected == null ? "" : expected)
          .trim()
          .toLowerCase()
      );
    });
  }

  async _getIssueTransitions(issueKey) {
    const data = await this._jira(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    );
    return Array.isArray(data?.transitions) ? data.transitions : [];
  }

  async _transitionIssue(issueKey, normalizedStatus) {
    const transitions = await this._getIssueTransitions(issueKey);
    const targetStatusName = String(this._statusMap[normalizedStatus] || "")
      .trim()
      .toLowerCase();
    const candidates = new Set(this._statusCandidates(normalizedStatus));
    const match = transitions.find((transition) => {
      const toName = String(transition?.to?.name || "")
        .trim()
        .toLowerCase();
      const toCategory = String(transition?.to?.statusCategory?.key || "")
        .trim()
        .toLowerCase();
      if (targetStatusName && toName === targetStatusName) return true;
      if (normalizedStatus === "done" && toCategory === "done") return true;
      return candidates.has(toName);
    });
    if (!match?.id) return false;
    await this._jira(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      body: { transition: { id: String(match.id) } },
    });
    return true;
  }

  async _fetchIssue(issueKey, fields = []) {
    const fieldList =
      fields.length > 0
        ? fields.join(",")
        : "summary,description,status,assignee,priority,project,labels,comment,attachment,created,updated";
    return this._jira(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(fieldList)}`,
    );
  }

  _jiraSearchParams(jql, maxResults, fields) {
    const params = new URLSearchParams();
    params.set("jql", jql);
    params.set("maxResults", String(Math.min(Number(maxResults) || 0, 1000)));
    if (fields) params.set("fields", fields);
    return params.toString();
  }

  async _searchIssues(jql, maxResults, fields) {
    const query = this._jiraSearchParams(jql, maxResults, fields);
    try {
      return await this._jira(`/rest/api/3/search/jql?${query}`);
    } catch (err) {
      const status = err?.status;
      const message = String(err?.message || "");
      const shouldFallback =
        status === 404 ||
        status === 410 ||
        message.includes("/search/jql") ||
        message.toLowerCase().includes("api has been removed");
      if (!shouldFallback) {
        throw err;
      }
      return this._jira(`/rest/api/3/search?${query}`);
    }
  }

  async _listIssueComments(issueKey) {
    const comments = [];
    let startAt = 0;
    const maxResults = 100;
    while (true) {
      const page = await this._jira(
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?startAt=${startAt}&maxResults=${maxResults}`,
      );
      const values = Array.isArray(page?.comments) ? page.comments : [];
      comments.push(...values);
      if (comments.length >= Number(page?.total || values.length)) break;
      if (values.length < maxResults) break;
      startAt += values.length;
    }
    return comments;
  }

  _extractSharedStateFromText(text) {
    const match = String(text || "").match(
      /<!-- bosun-state\s*\n([\s\S]*?)\n-->/,
    );
    if (!match) return null;
    try {
      const parsed = normalizeSharedStatePayload(
        JSON.parse(String(match[1] || "").trim()),
      );
      if (
        !parsed?.ownerId ||
        !parsed?.attemptToken ||
        !parsed?.attemptStarted ||
        !(parsed?.heartbeat || parsed?.ownerHeartbeat) ||
        !parsed?.status
      ) {
        return null;
      }
      if (!["claimed", "working", "stale"].includes(parsed.status)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async _setIssueLabels(issueKey, labelsToAdd = [], labelsToRemove = []) {
    const operations = [];
    for (const label of normalizeLabels(labelsToRemove).map((v) =>
      this._sanitizeJiraLabel(v),
    )) {
      operations.push({ remove: label });
    }
    for (const label of normalizeLabels(labelsToAdd).map((v) =>
      this._sanitizeJiraLabel(v),
    )) {
      operations.push({ add: label });
    }
    if (operations.length === 0) return true;
    await this._jira(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      method: "PUT",
      body: {
        update: {
          labels: operations,
        },
      },
    });
    return true;
  }

  _buildSharedStateComment(sharedState) {
    const normalized = normalizeSharedStatePayload(sharedState) || sharedState;
    const ownerParts = String(normalized?.ownerId || "").split("/");
    const workstationId = ownerParts[0] || "unknown-workstation";
    const agentId = ownerParts[1] || "unknown-agent";
    const json = JSON.stringify(normalized, null, 2);
    return (
      `<!-- bosun-state\n${json}\n-->\n` +
      `Bosun Status: Agent ${agentId} on ${workstationId} is ${normalized?.status} this task.\n` +
      `Last heartbeat: ${normalized?.heartbeat || normalized?.ownerHeartbeat || ""}`
    );
  }

  async _createOrUpdateSharedStateComment(issueKey, sharedState) {
    const commentBody = this._buildSharedStateComment(sharedState);
    const comments = await this._listIssueComments(issueKey);
    const existing = [...comments].reverse().find((comment) => {
      const text = this._commentToText(comment?.body);
      return text.includes("<!-- bosun-state");
    });
    if (existing?.id) {
      await this._jira(
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(String(existing.id))}`,
        {
          method: "PUT",
          body: this._useAdfComments
            ? { body: this._textToAdf(commentBody) }
            : { body: commentBody },
        },
      );
      return true;
    }
    return this.addComment(issueKey, commentBody);
  }

  async listProjects() {
    const data = await this._jira(
      "/rest/api/3/project/search?maxResults=1000&orderBy=name",
    );
    return (Array.isArray(data?.values) ? data.values : []).map((project) => ({
      id: String(project.key || project.id || ""),
      name: project.name || project.key || "Unnamed Jira Project",
      backend: "jira",
      meta: project,
    }));
  }

  async listTasks(projectId, filters = {}) {
    const projectKey = this._normalizeProjectKey(projectId);
    const clauses = [];
    if (projectKey) clauses.push(`project = "${projectKey}"`);
    else if (this._defaultProjectKey) clauses.push(`project = "${this._defaultProjectKey}"`);

    if (filters.status) {
      const normalized = normaliseStatus(filters.status);
      if (normalized === "draft") {
        clauses.push(`labels in ("draft")`);
      } else {
        const statusNames = this._statusCandidates(normalized)
          .map((name) => `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
          .join(", ");
        if (statusNames) clauses.push(`status in (${statusNames})`);
      }
    }

    if (this._enforceTaskLabel && this._taskScopeLabels.length > 0) {
      const labelsExpr = this._taskScopeLabels
        .map((label) => `"${label.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
        .join(", ");
      clauses.push(`labels in (${labelsExpr})`);
    }

    if (filters.assignee) {
      clauses.push(`assignee = "${String(filters.assignee).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    }

    const customJql = String(filters.jql || "").trim();
    if (customJql) clauses.push(`(${customJql})`);
    const jqlBase = clauses.length > 0 ? clauses.join(" AND ") : "updated IS NOT EMPTY";
    const jql = `${jqlBase} ORDER BY updated DESC`;

    const maxResults =
      Number(filters.limit || 0) > 0
        ? Number(filters.limit)
        : this._taskListLimit;
    const data = await this._searchIssues(
      jql,
      maxResults,
      "summary,description,status,assignee,priority,project,labels,comment,attachment,created,updated",
    );
    let tasks = (Array.isArray(data?.issues) ? data.issues : []).map((issue) =>
      this._normaliseIssue(issue),
    );

    if (this._enforceTaskLabel) {
      tasks = tasks.filter((task) => this._isTaskScopedForCodex(task));
    }
    if (filters?.projectField && typeof filters.projectField === "object") {
      tasks = tasks.filter((task) =>
        this._matchesProjectFieldFilters(task, filters.projectField),
      );
    }

    for (const task of tasks) {
      try {
        const sharedState = normalizeSharedStatePayload(
          await this.readSharedStateFromIssue(task.id),
        );
        if (sharedState) {
          task.meta.sharedState = sharedState;
          task.sharedState = sharedState;
        }
      } catch (err) {
        console.warn(
          `${TAG} failed to read shared state for ${task.id}: ${err.message}`,
        );
      }
    }
    return tasks;
  }

  async getTask(taskId) {
    const issueKey = this._validateIssueKey(taskId);
    const issue = await this._fetchIssue(issueKey);
    const task = this._normaliseIssue(issue);
    try {
      const sharedState = normalizeSharedStatePayload(
        await this.readSharedStateFromIssue(issueKey),
      );
      if (sharedState) {
        task.meta.sharedState = sharedState;
        task.sharedState = sharedState;
      }
    } catch (err) {
      console.warn(
        `${TAG} failed to read shared state for ${issueKey}: ${err.message}`,
      );
    }
    return task;
  }

  async updateTaskStatus(taskId, status, options = {}) {
    const issueKey = this._validateIssueKey(taskId);
    const normalized = normaliseStatus(status);
    if (normalized === "draft") {
      await this.updateTask(issueKey, { draft: true });
      if (options.sharedState) {
        await this.persistSharedStateToIssue(issueKey, options.sharedState);
      }
      return this.getTask(issueKey);
    }
    const current = await this.getTask(issueKey);
    if (current.status !== normalized) {
      const transitioned = await this._transitionIssue(issueKey, normalized);
      if (!transitioned) {
        throw new Error(
          `Jira: no transition available from "${current.status}" to "${normalized}" for ${issueKey}`,
        );
      }
    }
    if (options.sharedState) {
      await this.persistSharedStateToIssue(issueKey, options.sharedState);
    }
    if (current.status === "draft") {
      await this.updateTask(issueKey, { draft: false });
    }
    if (
      options.projectFields &&
      typeof options.projectFields === "object" &&
      Object.keys(options.projectFields).length > 0
    ) {
      await this.updateTask(issueKey, { projectFields: options.projectFields });
    }
    return this.getTask(issueKey);
  }

  async updateTask(taskId, patch = {}) {
    const issueKey = this._validateIssueKey(taskId);
    const fields = {};
    const baseBranch = resolveBaseBranchInput(patch);
    if (typeof patch.title === "string") {
      fields.summary = patch.title;
    }
    if (typeof patch.description === "string") {
      fields.description = this._textToAdf(patch.description);
    }
    if (typeof patch.priority === "string" && patch.priority.trim()) {
      fields.priority = { name: patch.priority.trim() };
    }
    const wantsTags =
      Array.isArray(patch.tags) ||
      Array.isArray(patch.labels) ||
      typeof patch.tags === "string";
    let fetchedIssue = null;
    if (wantsTags || typeof patch.draft === "boolean" || baseBranch) {
      fetchedIssue = await this._fetchIssue(issueKey);
    }
    if (wantsTags || typeof patch.draft === "boolean") {
      const currentLabels = normalizeLabels(fetchedIssue?.fields?.labels || []);
      const systemLabels = new Set([
        ...SYSTEM_LABEL_KEYS,
        ...normalizeLabels(this._taskScopeLabels || []),
      ]);
      const desiredTags = wantsTags
        ? normalizeTags(patch.tags ?? patch.labels)
        : currentLabels.filter(
            (label) => !systemLabels.has(label) && !isUpstreamLabel(label),
          );
      const nextLabels = new Set(
        currentLabels.filter(
          (label) => systemLabels.has(label) || isUpstreamLabel(label),
        ),
      );
      for (const label of desiredTags) nextLabels.add(label);
      if (typeof patch.draft === "boolean") {
        if (patch.draft) nextLabels.add("draft");
        else nextLabels.delete("draft");
      }
      fields.labels = [...nextLabels].map((label) => this._sanitizeJiraLabel(label));
    }
    if (baseBranch && !patch.description) {
      const currentDesc = this._commentToText(fetchedIssue?.fields?.description);
      const nextDesc = upsertBaseBranchMarker(currentDesc, baseBranch);
      fields.description = this._textToAdf(nextDesc);
    }
    if (baseBranch && this._customFieldBaseBranch) {
      fields[this._customFieldBaseBranch] = baseBranch;
    }
    if (patch.assignee) {
      fields.assignee = { accountId: String(patch.assignee) };
    }
    if (patch.projectFields && typeof patch.projectFields === "object") {
      const mappedProjectFields = await this._mapProjectFieldsInput(
        patch.projectFields,
      );
      Object.assign(fields, mappedProjectFields);
    }
    if (Object.keys(fields).length > 0) {
      await this._jira(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
        method: "PUT",
        body: { fields },
      });
    }
    if (typeof patch.status === "string" && patch.status.trim()) {
      return this.updateTaskStatus(issueKey, patch.status.trim());
    }
    return this.getTask(issueKey);
  }

  async createTask(projectIdOrTaskData, taskDataArg = {}) {
    const { projectId, taskData } = resolveCreateTaskInput(
      projectIdOrTaskData,
      taskDataArg,
    );
    const projectKey = this._normalizeProjectKey(projectId);
    if (!projectKey) {
      throw new Error(
        "Jira: createTask requires a project key (argument or JIRA_PROJECT_KEY)",
      );
    }
    const requestedStatus = normaliseStatus(taskData.status || "todo");
    const baseBranch = resolveBaseBranchInput(taskData);
    const issueTypeName =
      taskData.issueType ||
      taskData.issue_type ||
      this._defaultIssueType ||
      "Task";
    const isSubtask = /sub[-\\s]?task/.test(
      String(issueTypeName || "").toLowerCase(),
    );
    const parentKey = this._normalizeIssueKey(
      taskData.parentId ||
        taskData.parentKey ||
        this._subtaskParentKey ||
        "",
    );
    if (isSubtask && !parentKey) {
      throw new Error(
        "Jira: sub-task issue type requires a parent issue key (set JIRA_SUBTASK_PARENT_KEY or pass parentId)",
      );
    }
    const labels = normalizeLabels([
      ...(Array.isArray(this._taskScopeLabels) ? this._taskScopeLabels : []),
      ...normalizeLabels(taskData.labels || []),
      ...normalizeLabels(taskData.tags || []),
    ]).map((label) => this._sanitizeJiraLabel(label));
    if (!labels.includes(this._canonicalTaskLabel)) {
      labels.push(this._sanitizeJiraLabel(this._canonicalTaskLabel));
    }
    if (requestedStatus === "draft" && !labels.includes("draft")) {
      labels.push("draft");
    }
    const descriptionText = upsertBaseBranchMarker(
      taskData.description || "",
      baseBranch,
    );
    const fields = {
      project: { key: projectKey },
      summary: taskData.title || "New task",
      description: this._textToAdf(descriptionText),
      issuetype: {
        name: issueTypeName,
      },
      labels,
    };
    if (baseBranch && this._customFieldBaseBranch) {
      fields[this._customFieldBaseBranch] = baseBranch;
    }
    if (isSubtask && parentKey) {
      fields.parent = { key: parentKey };
    }
    if (taskData.priority) {
      fields.priority = { name: String(taskData.priority) };
    }
    const assigneeId = taskData.assignee || this._defaultAssignee;
    if (assigneeId) {
      fields.assignee = { accountId: String(assigneeId) };
    }
    const created = await this._jira("/rest/api/3/issue", {
      method: "POST",
      body: { fields },
    });
    const issueKey = this._validateIssueKey(created?.key || "");
    if (requestedStatus !== "todo" && requestedStatus !== "draft") {
      return this.updateTaskStatus(issueKey, requestedStatus, {
        sharedState: taskData.sharedState,
      });
    }
    if (taskData.sharedState) {
      await this.persistSharedStateToIssue(issueKey, taskData.sharedState);
    }
    return this.getTask(issueKey);
  }

  async deleteTask(taskId) {
    const issueKey = this._validateIssueKey(taskId);
    const issue = await this.getTask(issueKey);
    if (issue.status === "done" || issue.status === "cancelled") {
      return true;
    }
    const target = String(process.env.JIRA_DELETE_TRANSITION_STATUS || "done").trim();
    await this.updateTaskStatus(issueKey, target);
    return true;
  }

  async addComment(taskId, body) {
    const issueKey = this._validateIssueKey(taskId);
    const text = String(body || "").trim();
    if (!text) return false;
    try {
      await this._jira(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
        method: "POST",
        body: this._useAdfComments
          ? { body: this._textToAdf(text) }
          : { body: text },
      });
      return true;
    } catch (err) {
      if (this._useAdfComments) {
        // Fallback for Jira instances that accept only plain text payloads
        try {
          await this._jira(
            `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
            {
              method: "POST",
              body: { body: text },
            },
          );
          return true;
        } catch (fallbackErr) {
          console.warn(
            `${TAG} failed to add Jira comment on ${issueKey}: ${fallbackErr.message}`,
          );
          return false;
        }
      }
      console.warn(`${TAG} failed to add Jira comment on ${issueKey}: ${err.message}`);
      return false;
    }
  }

  /**
   * Persist shared state to a Jira issue.
   *
   * Implements the same shared state protocol as GitHubAdapter but using Jira-specific
   * mechanisms. The implementation should use a combination of:
   *
   * 1. **Jira Custom Fields** (preferred if available):
   *    - Create custom fields for bosun state (e.g., "Codex Owner ID", "Codex Attempt Token")
   *    - Store structured data as JSON in a text custom field
   *    - Use Jira API v3: `PUT /rest/api/3/issue/{issueKey}`
   *    - Custom field IDs are like `customfield_10042`
   *
   * 2. **Jira Labels** (for status flags):
   *    - Use labels: `codex:claimed`, `codex:working`, `codex:stale`, `codex:ignore`
   *    - Labels API: `PUT /rest/api/3/issue/{issueKey}` with `update.labels` field
   *    - Remove conflicting codex labels before adding new ones
   *
   * 3. **Structured Comments** (fallback if custom fields unavailable):
   *    - Similar to GitHub: embed JSON in HTML comment markers
   *    - Format: `<!-- bosun-state\n{json}\n-->`
   *    - Comments API: `POST /rest/api/3/issue/{issueKey}/comment`
   *    - Update via `PUT /rest/api/3/issue/{issueKey}/comment/{commentId}`
   *
   * **Jira API v3 Authentication**:
   * - Use Basic Auth with email + API token: `Authorization: Basic base64(email:token)`
   * - Token from: https://id.atlassian.com/manage-profile/security/api-tokens
   * - Base URL: `https://{domain}.atlassian.net`
   *
   * **Required Permissions**:
   * - Browse Projects
   * - Edit Issues
   * - Add Comments
   * - Manage Custom Fields (if using custom fields approach)
   *
   * @param {string} issueKey - Jira issue key (e.g., "PROJ-123")
   * @param {SharedState} sharedState - Agent state to persist
   * @param {string} sharedState.ownerId - Format: "workstation-id/agent-id"
   * @param {string} sharedState.attemptToken - Unique UUID for this attempt
   * @param {string} sharedState.attemptStarted - ISO 8601 timestamp
   * @param {string} sharedState.heartbeat - ISO 8601 timestamp
   * @param {string} sharedState.status - One of: "claimed", "working", "stale"
   * @param {number} sharedState.retryCount - Number of retry attempts
   * @returns {Promise<boolean>} Success status
   *
   * @example
   * await adapter.persistSharedStateToIssue("PROJ-123", {
   *   ownerId: "workstation-123/agent-456",
   *   attemptToken: "uuid-here",
   *   attemptStarted: "2026-02-14T17:00:00Z",
   *   heartbeat: "2026-02-14T17:30:00Z",
   *   status: "working",
   *   retryCount: 1
   * });
   *
   * @see {@link https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/}
   * @see GitHubIssuesAdapter.persistSharedStateToIssue for reference implementation
   */
  async persistSharedStateToIssue(issueKey, sharedState) {
    const key = this._validateIssueKey(issueKey);
    const normalizedState = normalizeSharedStatePayload(sharedState);
    if (
      !normalizedState?.ownerId ||
      !normalizedState?.attemptToken ||
      !normalizedState?.attemptStarted ||
      !(normalizedState?.heartbeat || normalizedState?.ownerHeartbeat) ||
      !["claimed", "working", "stale"].includes(normalizedState?.status)
    ) {
      throw new Error(
        `Jira: invalid shared state payload for ${key} (missing required fields)`,
      );
    }

    const allCodexLabels = [
      this._codexLabels.claimed,
      this._codexLabels.working,
      this._codexLabels.stale,
      "codex:claimed",
      "codex:working",
      "codex:stale",
    ];
    const targetLabel =
      normalizedState.status === "claimed"
        ? this._codexLabels.claimed
        : normalizedState.status === "working"
          ? this._codexLabels.working
          : this._codexLabels.stale;
    const labelsToRemove = allCodexLabels.filter((label) => label !== targetLabel);
    try {
      await this._setIssueLabels(key, [targetLabel], labelsToRemove);
      const stateFieldPayload = {};
      if (this._sharedStateFields.ownerId) {
        stateFieldPayload[this._sharedStateFields.ownerId] =
          normalizedState.ownerId;
      }
      if (this._sharedStateFields.attemptToken) {
        stateFieldPayload[this._sharedStateFields.attemptToken] =
          normalizedState.attemptToken;
      }
      if (this._sharedStateFields.attemptStarted) {
        const iso = this._normalizeIsoTimestamp(normalizedState.attemptStarted);
        if (iso) stateFieldPayload[this._sharedStateFields.attemptStarted] = iso;
      }
      if (this._sharedStateFields.heartbeat) {
        const iso = this._normalizeIsoTimestamp(
          normalizedState.heartbeat || normalizedState.ownerHeartbeat,
        );
        if (iso) stateFieldPayload[this._sharedStateFields.heartbeat] = iso;
      }
      if (this._sharedStateFields.retryCount) {
        const retryCount = Number(normalizedState.retryCount || 0);
        if (Number.isFinite(retryCount)) {
          stateFieldPayload[this._sharedStateFields.retryCount] = retryCount;
        }
      }
      if (this._sharedStateFields.stateJson) {
        stateFieldPayload[this._sharedStateFields.stateJson] = JSON.stringify(
          normalizedState,
        );
      }
      if (Object.keys(stateFieldPayload).length > 0) {
        await this._jira(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
          method: "PUT",
          body: { fields: stateFieldPayload },
        });
      }
      return this._createOrUpdateSharedStateComment(key, normalizedState);
    } catch (err) {
      console.warn(
        `${TAG} failed to persist shared state for ${key}: ${err.message}`,
      );
      return false;
    }
  }

  /**
   * Read shared state from a Jira issue.
   *
   * Retrieves agent state previously written by persistSharedStateToIssue().
   * Implementation should check multiple sources in order of preference:
   *
   * 1. **Jira Custom Fields** (if configured):
   *    - Read custom field values via `GET /rest/api/3/issue/{issueKey}`
   *    - Parse JSON from custom field (e.g., `fields.customfield_10042`)
   *    - Validate required fields before returning
   *
   * 2. **Structured Comments** (fallback):
   *    - Fetch comments via `GET /rest/api/3/issue/{issueKey}/comment`
   *    - Search for latest comment containing `<!-- bosun-state`
   *    - Extract and parse JSON from HTML comment markers
   *    - Return most recent valid state
   *
   * **Validation Requirements**:
   * - Must have: ownerId, attemptToken, attemptStarted, heartbeat, status
   * - Status must be one of: "claimed", "working", "stale"
   * - Timestamps must be valid ISO 8601 format
   * - Return null if state is missing, invalid, or corrupted
   *
   * **Jira API v3 Endpoints**:
   * - Issue details: `GET /rest/api/3/issue/{issueKey}?fields=customfield_*,comment`
   * - Comments only: `GET /rest/api/3/issue/{issueKey}/comment`
   *
   * @param {string} issueKey - Jira issue key (e.g., "PROJ-123")
   * @returns {Promise<SharedState|null>} Parsed shared state or null if not found
   *
   * @typedef {Object} SharedState
   * @property {string} ownerId - Workstation/agent identifier
   * @property {string} attemptToken - Unique UUID for this attempt
   * @property {string} attemptStarted - ISO 8601 timestamp
   * @property {string} heartbeat - ISO 8601 timestamp
   * @property {string} status - One of: "claimed", "working", "stale"
   * @property {number} retryCount - Number of retry attempts
   *
   * @example
   * const state = await adapter.readSharedStateFromIssue("PROJ-123");
   * if (state) {
   *   console.log(`Task claimed by ${state.ownerId}`);
   *   console.log(`Status: ${state.status}, Heartbeat: ${state.heartbeat}`);
   * } else {
   *   console.log("No shared state found - task is unclaimed");
   * }
   *
   * @see {@link https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/}
   * @see GitHubIssuesAdapter.readSharedStateFromIssue for reference implementation
   */
  async readSharedStateFromIssue(issueKey) {
    const key = this._validateIssueKey(issueKey);
    try {
      const fieldIds = [
        this._sharedStateFields.stateJson,
        this._sharedStateFields.ownerId,
        this._sharedStateFields.attemptToken,
        this._sharedStateFields.attemptStarted,
        this._sharedStateFields.heartbeat,
        this._sharedStateFields.retryCount,
      ].filter(Boolean);
      if (fieldIds.length > 0) {
        const issue = await this._fetchIssue(key, fieldIds);
        const rawFields = issue?.fields || {};
        if (this._sharedStateFields.stateJson) {
          const raw = rawFields[this._sharedStateFields.stateJson];
          if (typeof raw === "string" && raw.trim()) {
            try {
              const parsed = normalizeSharedStatePayload(JSON.parse(raw));
              if (
                parsed?.ownerId &&
                parsed?.attemptToken &&
                parsed?.attemptStarted &&
                (parsed?.heartbeat || parsed?.ownerHeartbeat) &&
                ["claimed", "working", "stale"].includes(parsed?.status)
              ) {
                return parsed;
              }
            } catch {
              // fall through to field-by-field and comment parsing
            }
          }
        }
        const fromFields = {
          ownerId: rawFields[this._sharedStateFields.ownerId],
          attemptToken: rawFields[this._sharedStateFields.attemptToken],
          attemptStarted: rawFields[this._sharedStateFields.attemptStarted],
          heartbeat: rawFields[this._sharedStateFields.heartbeat],
          status: null,
          retryCount: Number(rawFields[this._sharedStateFields.retryCount] || 0),
        };
        if (fromFields.ownerId) {
          const labels = normalizeLabels(rawFields.labels || []);
          if (labels.includes(this._codexLabels.working)) {
            fromFields.status = "working";
          } else if (labels.includes(this._codexLabels.claimed)) {
            fromFields.status = "claimed";
          } else if (labels.includes(this._codexLabels.stale)) {
            fromFields.status = "stale";
          }
        }
        if (
          fromFields.ownerId &&
          fromFields.attemptToken &&
          fromFields.attemptStarted &&
          fromFields.heartbeat &&
          fromFields.status
        ) {
          return normalizeSharedStatePayload(fromFields);
        }
      }
      const comments = await this._listIssueComments(key);
      const stateComment = [...comments].reverse().find((comment) => {
        const text = this._commentToText(comment?.body);
        return text.includes("<!-- bosun-state");
      });
      if (!stateComment) return null;
      const parsed = normalizeSharedStatePayload(
        this._extractSharedStateFromText(
          this._commentToText(stateComment.body),
        ),
      );
      return parsed || null;
    } catch (err) {
      console.warn(`${TAG} failed to read shared state for ${key}: ${err.message}`);
      return null;
    }
  }

  /**
   * Mark a Jira issue as ignored by bosun.
   *
   * Prevents bosun from repeatedly attempting to claim or work on tasks
   * that are not suitable for automation. Uses Jira-specific mechanisms:
   *
   * 1. **Add Label**: `codex:ignore`
   *    - Labels API: `PUT /rest/api/3/issue/{issueKey}`
   *    - Request body: `{"update": {"labels": [{"add": "codex:ignore"}]}}`
   *    - Labels are case-sensitive in Jira
   *
   * 2. **Add Comment**: Human-readable explanation
   *    - Comments API: `POST /rest/api/3/issue/{issueKey}/comment`
   *    - Request body: `{"body": {"type": "doc", "version": 1, "content": [...]}}`
   *    - Jira uses Atlassian Document Format (ADF) for rich text
   *    - For simple text: `{"body": "text content"}` (legacy format)
   *
   * 3. **Optional: Transition Issue** (if workflow supports it):
   *    - Get transitions: `GET /rest/api/3/issue/{issueKey}/transitions`
   *    - Transition to "Won't Do" or similar: `POST /rest/api/3/issue/{issueKey}/transitions`
   *    - Not required if labels are sufficient
   *
   * **Jira ADF Comment Example**:
   * ```json
   * {
   *   "body": {
   *     "type": "doc",
   *     "version": 1,
   *     "content": [
   *       {
   *         "type": "paragraph",
   *         "content": [
   *           {"type": "text", "text": "Bosun: Task marked as ignored."}
   *         ]
   *       }
   *     ]
   *   }
   * }
   * ```
   *
   * **Required Permissions**:
   * - Edit Issues (for labels)
   * - Add Comments
   * - Transition Issues (optional, if changing status)
   *
   * @param {string} issueKey - Jira issue key (e.g., "PROJ-123")
   * @param {string} reason - Human-readable reason for ignoring
   * @returns {Promise<boolean>} Success status
   *
   * @example
   * await adapter.markTaskIgnored("PROJ-123", "Task requires manual security review");
   * // Adds "codex:ignore" label and comment explaining why
   *
   * @example
   * await adapter.markTaskIgnored("PROJ-456", "Task dependencies not in automation scope");
   * // Prevents bosun from claiming this task in future iterations
   *
   * @see {@link https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/}
   * @see {@link https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/}
   * @see GitHubIssuesAdapter.markTaskIgnored for reference implementation
   */
  async markTaskIgnored(issueKey, reason) {
    const key = this._validateIssueKey(issueKey);
    const ignoreReason = String(reason || "").trim() || "No reason provided";
    try {
      await this._setIssueLabels(
        key,
        [this._codexLabels.ignore],
        ["codex:ignore"],
      );
      if (this._sharedStateFields.ignoreReason) {
        await this._jira(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
          method: "PUT",
          body: {
            fields: {
              [this._sharedStateFields.ignoreReason]: ignoreReason,
            },
          },
        });
      }
      const commentBody =
        `Bosun: This task has been marked as ignored.\n\n` +
        `Reason: ${ignoreReason}\n\n` +
        `To re-enable bosun for this task, remove the ${this._codexLabels.ignore} label.`;
      await this.addComment(key, commentBody);
      return true;
    } catch (err) {
      console.error(`${TAG} failed to mark Jira issue ${key} as ignored: ${err.message}`);
      return false;
    }
  }

  /**
   * Remove the ignored marker from a Jira task.
   *
   * @param {string} issueKey - Jira issue key (e.g., "PROJ-123")
   * @returns {Promise<boolean>} Success status
   */
  async unmarkTaskIgnored(issueKey) {
    const key = this._validateIssueKey(issueKey);
    try {
      await this._setIssueLabels(
        key,
        [],
        [this._codexLabels.ignore, "codex:ignore"],
      );
      if (this._sharedStateFields.ignoreReason) {
        await this._jira(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
          method: "PUT",
          body: {
            fields: {
              [this._sharedStateFields.ignoreReason]: "",
            },
          },
        });
      }
      return true;
    } catch (err) {
      console.error(`${TAG} failed to unmark Jira issue ${key} ignored: ${err.message}`);
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter Registry & Resolution
// ---------------------------------------------------------------------------

class RepoMirrorProjectionAdapter {
  constructor(config = {}) {
    this.name = "repo-mirror";
    this.backend = "repo-mirror";
    this._config = resolveRepoMirrorProjectionConfig(config);
    this._internal = new InternalAdapter();
  }

  async _ensureProjectionScaffold() {
    await ensureProjectionScaffold(this._config);
  }

  async _projectNormalizedTask(task, rawTask = null) {
    const normalizedTask = task || null;
    if (!normalizedTask?.id) return null;
    await this._ensureProjectionScaffold();
    const sourceTask = rawTask || getInternalTask(normalizedTask.id) || normalizedTask;
    const projectedTask = await this._loadProjectedTask(normalizedTask.id);
    const mergedTask = mergeProjectedTaskIntoLocal(normalizedTask, projectedTask);
    const mergedSourceTask = {
      ...(sourceTask && typeof sourceTask === "object" ? sourceTask : {}),
      comments: mergedTask.comments,
      attachments: mergedTask.attachments,
      workflowRuns: mergedTask.workflowRuns,
      timeline: mergedTask.timeline,
      statusHistory: mergedTask.statusHistory,
      assignees: mergedTask.assignees,
      repositories: mergedTask.repositories,
      tags: mergedTask.tags,
      meta: {
        ...(sourceTask?.meta || {}),
        ...(mergedTask.meta || {}),
        comments: mergedTask.comments,
        attachments: mergedTask.attachments,
        workflowRuns: mergedTask.workflowRuns,
        timeline: mergedTask.timeline,
        statusHistory: mergedTask.statusHistory,
      },
    };
    const projection = buildProjectedTaskDocument(
      mergedTask,
      mergedSourceTask,
      this._config,
    );
    await upsertProjectedTask(
      this._config,
      projection.task,
      projection.runs,
      projection.messages,
    );
    await rebuildAgentsRegistry(this._config);
    const projectedRecord = await readProjectedTaskRecord(this._config, normalizedTask.id);
    const runDocs = await listProjectedRunsForTask(this._config, normalizedTask.id);
    const messageDocs = await listProjectedMessagesForTask(this._config, normalizedTask.id);
    return materializeProjectedTask(
      projectedRecord?.doc || projection.task,
      projectedRecord?.filePath || null,
      runDocs,
      messageDocs,
    );
  }

  _buildInternalTaskPatch(projectedTask, projectedDoc = {}, filePath = null, options = {}) {
    if (!projectedTask?.id) return null;
    const existingTask = options.existingTask || null;
    const preferProjectedCanonical = options.preferProjectedCanonical !== false;
    const existingImported = existingTask?.meta?.repoMirror?.imported === true;
    const imported =
      existingImported ||
      !existingTask ||
      preferProjectedCanonical;
    const canonicalTask = preferProjectedCanonical ? projectedTask : (existingTask || projectedTask);
    const comments = mergeTaskCommentCollections(existingTask?.comments, projectedTask.comments);
    const attachments = mergeTaskAttachments(existingTask?.attachments, projectedTask.attachments);
    const workflowRuns = mergeTaskWorkflowRunCollections(
      existingTask?.workflowRuns,
      projectedTask.workflowRuns,
    );
    const timeline = mergeTaskTimelineCollections(
      existingTask?.timeline,
      existingTask?.meta?.timeline,
      projectedTask.meta?.timeline,
    );
    const statusHistory = mergeTaskStatusHistoryCollections(
      existingTask?.statusHistory,
      existingTask?.meta?.statusHistory,
      buildProjectedStatusHistory(projectedTask),
    );
    const assignees = mergeTaskStringLists(existingTask?.assignees, projectedTask.assignees);
    const repositories = mergeTaskStringLists(
      existingTask?.repositories,
      projectedTask.repositories,
    );
    const tags = mergeTaskStringLists(existingTask?.tags, projectedTask.tags);
    return {
      id: projectedTask.id,
      title: canonicalTask.title,
      description: canonicalTask.description,
      status: canonicalTask.status,
      assignee: canonicalTask.assignee || assignees[0] || null,
      assignees,
      priority: canonicalTask.priority,
      projectId: canonicalTask.projectId,
      workspace: canonicalTask.workspace,
      repository: canonicalTask.repository,
      repositories,
      tags,
      draft: canonicalTask.draft === true,
      baseBranch: canonicalTask.baseBranch,
      branchName: canonicalTask.branchName,
      prNumber: canonicalTask.prNumber,
      prUrl: canonicalTask.prUrl,
      createdAt: existingTask?.createdAt || projectedTask.createdAt,
      updatedAt: pickLatestTimestamp(existingTask?.updatedAt, projectedTask.updatedAt),
      lastActivityAt: pickLatestTimestamp(
        existingTask?.lastActivityAt,
        existingTask?.updatedAt,
        projectedTask.lastActivityAt,
        projectedTask.updatedAt,
      ),
      timeline,
      statusHistory,
      comments,
      attachments,
      workflowRuns,
      meta: {
        ...(existingTask?.meta || {}),
        ...(projectedTask.meta || {}),
        timeline,
        statusHistory,
        comments,
        attachments,
        workflowRuns,
        evidence: projectedTask.meta?.evidence || existingTask?.meta?.evidence || {},
        repoMirror: {
          ...(existingTask?.meta?.repoMirror || {}),
          ...(projectedTask.meta?.repoMirror || {}),
          imported,
          observed: true,
          projectionOnly: true,
          taskPath: filePath || projectedTask.meta?.repoMirror?.taskPath || null,
          syncMode: this._config.syncMode,
          upstreamUpdatedAt: String(projectedDoc?.updated_at || projectedTask.updatedAt || "").trim() || null,
        },
      },
    };
  }

  async _ingestProjectedTask(doc, filePath) {
    const taskId = String(doc?.task_id || "").trim();
    if (!taskId) return null;
    const runDocs = await listProjectedRunsForTask(this._config, taskId);
    const messageDocs = await listProjectedMessagesForTask(this._config, taskId);
    const projectedTask = materializeProjectedTask(doc, filePath, runDocs, messageDocs);
    const existing = this._internal._normalizeTask(getInternalTask(taskId));
    const projectedUpdatedMs = Date.parse(String(doc?.updated_at || projectedTask.updatedAt || "")) || 0;
    const existingUpdatedMs = Date.parse(String(existing?.updatedAt || existing?.lastActivityAt || "")) || 0;
    const existingImported =
      existing?.meta?.repoMirror?.imported === true
      || String(existing?.meta?.repoMirror?.taskPath || "").trim() === String(filePath || "").trim();
    const shouldApply = !existing || existingImported || projectedUpdatedMs >= existingUpdatedMs;
    const patch = this._buildInternalTaskPatch(projectedTask, doc, filePath, {
      existingTask: existing,
      preferProjectedCanonical: shouldApply,
    });
    if (!patch) return projectedTask;

    if (!existing) {
      addInternalTask(patch);
    } else {
      patchInternalTask(taskId, patch);
    }
    await waitForStoreWrites();
    return this._internal.getTask(taskId);
  }

  async _syncAllInternalTasks() {
    await this._ensureProjectionScaffold();
    const projectedTasks = await listProjectedTaskRecords(this._config);
    for (const { doc, filePath } of projectedTasks) {
      const projectedTaskId = String(doc?.task_id || "").trim();
      if (!projectedTaskId) continue;
      await this._ingestProjectedTask(doc, filePath);
    }
    const internalTasks = await this._internal.listTasks("internal");
    for (const task of internalTasks) {
      if (!task?.id) continue;
      await this._projectNormalizedTask(task);
    }
    await rebuildAgentsRegistry(this._config);
  }

  async _loadProjectedTask(taskId) {
    const normalizedId = String(taskId || "").trim();
    if (!normalizedId) return null;
    const taskRecord = await readProjectedTaskRecord(this._config, normalizedId);
    if (!taskRecord?.doc) return null;
    const runDocs = await listProjectedRunsForTask(this._config, normalizedId);
    const messageDocs = await listProjectedMessagesForTask(this._config, normalizedId);
    return materializeProjectedTask(
      taskRecord.doc,
      taskRecord.filePath,
      runDocs,
      messageDocs,
    );
  }

  async listProjects() {
    await this._ensureProjectionScaffold();
    return [
      {
        id: "repo-mirror",
        name: "RepoMirror Projection",
        backend: "repo-mirror",
        meta: {
          projectionOnly: true,
          ...this._config,
        },
      },
    ];
  }

  async listTasks(projectId, filters = {}) {
    await this._syncAllInternalTasks();
    const statusFilter = filters?.status ? normaliseStatus(filters.status) : null;
    const limit = Number(filters?.limit || 0);
    const normalizedProjectId = String(projectId || "").trim().toLowerCase();
    const records = await listProjectedTaskRecords(this._config);
    let tasks = [];
    for (const { doc, filePath } of records) {
      const taskId = String(doc?.task_id || "").trim();
      const runDocs = await listProjectedRunsForTask(this._config, taskId);
      const messageDocs = await listProjectedMessagesForTask(this._config, taskId);
      tasks.push(materializeProjectedTask(doc, filePath, runDocs, messageDocs));
    }
    if (normalizedProjectId && normalizedProjectId !== "repo-mirror") {
      tasks = tasks.filter(
        (task) =>
          String(task.projectId || "").trim().toLowerCase() === normalizedProjectId,
      );
    }
    if (statusFilter) {
      tasks = tasks.filter((task) => normaliseStatus(task.status) === statusFilter);
    }
    tasks.sort((left, right) =>
      String(right.lastActivityAt || right.updatedAt || "").localeCompare(
        String(left.lastActivityAt || left.updatedAt || ""),
      ),
    );
    if (Number.isFinite(limit) && limit > 0) {
      tasks = tasks.slice(0, limit);
    }
    return tasks;
  }

  async getTask(taskId) {
    const normalizedId = String(taskId || "").trim();
    if (!normalizedId) return null;
    const projectedRecord = await readProjectedTaskRecord(this._config, normalizedId);
    if (projectedRecord?.doc) {
      await this._ingestProjectedTask(projectedRecord.doc, projectedRecord.filePath);
    }
    const internalTask = await this._internal.getTask(normalizedId);
    if (internalTask) {
      await this._projectNormalizedTask(internalTask);
    }
    return this._loadProjectedTask(normalizedId);
  }

  async updateTaskStatus(taskId, status, options = {}) {
    const updated = await this._internal.updateTaskStatus(taskId, status, options);
    return this._projectNormalizedTask(updated);
  }

  async updateTask(taskId, patch = {}) {
    const updated = await this._internal.updateTask(taskId, patch);
    return this._projectNormalizedTask(updated);
  }

  async createTask(projectIdOrTaskData, taskDataArg = {}) {
    const { taskData } = resolveCreateTaskInput(projectIdOrTaskData, taskDataArg);
    const created = await this._internal.createTask(projectIdOrTaskData, taskDataArg);
    let normalizedTask = created;
    const needsLinkagePatch =
      typeof taskData?.branchName === "string" ||
      typeof taskData?.prUrl === "string" ||
      taskData?.prNumber != null ||
      Array.isArray(taskData?.prLinkage) ||
      Array.isArray(taskData?.meta?.prLinkage);
    if (needsLinkagePatch && created?.id) {
      normalizedTask = await this._internal.updateTask(created.id, taskData);
    }
    return this._projectNormalizedTask(normalizedTask);
  }

  async deleteTask(taskId) {
    const normalizedId = String(taskId || "").trim();
    if (!normalizedId) return false;
    const deleted = await this._internal.deleteTask(normalizedId);
    if (!deleted) return false;
    await deleteProjectedTask(this._config, normalizedId);
    await rebuildAgentsRegistry(this._config);
    return true;
  }

  async addComment(taskId, body) {
    const added = await this._internal.addComment(taskId, body);
    if (!added) return false;
    const updatedTask = await this._internal.getTask(taskId);
    if (updatedTask) {
      await this._projectNormalizedTask(updatedTask);
    }
    return true;
  }
}

const ADAPTERS = {
  internal: () => new InternalAdapter(),
  github: () => new GitHubIssuesAdapter(),
  jira: () => new JiraAdapter(),
  "repo-mirror": () => new RepoMirrorProjectionAdapter(loadConfig()?.repoMirror || {}),
};

/** @type {Object|null} Cached adapter instance */
let activeAdapter = null;
/** @type {string|null} Cached backend name */
let activeBackendName = null;

/**
 * Resolve which kanban backend to use (synchronous).
 *
 * Resolution order:
 *   1. Runtime override via setKanbanBackend()
 *   2. KANBAN_BACKEND env var
 *   3. bosun.config.json → kanban.backend field
 *   4. Default: "internal"
 *
 * @returns {string}
 */
function resolveBackendName() {
  if (activeBackendName) return activeBackendName;

  // 1. Env var
  const envBackend = (process.env.KANBAN_BACKEND || "").trim().toLowerCase();
  if (envBackend && ADAPTERS[envBackend]) return envBackend;

  // 2. Config file (loadConfig is imported statically — always sync-safe)
  try {
    const config = loadConfig();
    const configBackend = (config?.kanban?.backend || "").toLowerCase();
    if (configBackend && ADAPTERS[configBackend]) return configBackend;
  } catch {
    // Config not available — fall through to default
  }

  // 3. Default
  return "internal";
}

/**
 * Get the active kanban adapter.
 * @returns {InternalAdapter|GitHubIssuesAdapter|JiraAdapter|RepoMirrorProjectionAdapter} Adapter instance.
 */
export function getKanbanAdapter() {
  const name = resolveBackendName();
  if (activeAdapter && activeBackendName === name) return activeAdapter;
  if (name === "internal") activeAdapter = ADAPTERS.internal();
  else if (name === "github") activeAdapter = ADAPTERS.github();
  else if (name === "jira") activeAdapter = ADAPTERS.jira();
  else if (name === "repo-mirror") activeAdapter = ADAPTERS["repo-mirror"]();
  else throw new Error(`${TAG} unknown kanban backend: ${name}`);
  activeBackendName = name;
  console.log(`${TAG} using ${name} backend`);
  return activeAdapter;
}

/**
 * Switch the kanban backend at runtime.
 * @param {string} name Backend name ("internal", "github", "jira", "repo-mirror").
 */
export function setKanbanBackend(name) {
  const normalised = (name || "").trim().toLowerCase();
  if (!ADAPTERS[normalised]) {
    throw new Error(
      `${TAG} unknown kanban backend: "${name}". Valid: ${Object.keys(ADAPTERS).join(", ")}`,
    );
  }
  if (normalised === "github") {
    // Avoid carrying stale GH cache state across explicit backend switches.
    clearGitHubAdapterCacheBuckets();
  }
  activeBackendName = normalised;
  activeAdapter = null; // Force re-create on next getKanbanAdapter()
  console.log(`${TAG} switched to ${normalised} backend`);
}

/**
 * Get list of available kanban backends.
 * @returns {string[]}
 */
export function getAvailableBackends() {
  return Object.keys(ADAPTERS);
}

/**
 * Get the name of the active backend.
 * @returns {string}
 */
export function getKanbanBackendName() {
  return resolveBackendName();
}

// ---------------------------------------------------------------------------
// Convenience exports: direct task operations via active adapter
// ---------------------------------------------------------------------------

// ── Workflow Event Bridge ──────────────────────────────────────────────────
// The daemon injects its workflow-event queue. Standalone callers (like the
// task simulator) must not import monitor.mjs just to emit best-effort events.
let _kanbanQueueWorkflowEvent = null;
export function setKanbanWorkflowEventQueue(queueFn) {
  _kanbanQueueWorkflowEvent = typeof queueFn === "function" ? queueFn : null;
}
function emitKanbanEvent(eventType, eventData = {}) {
  if (!_kanbanQueueWorkflowEvent) return;
  _kanbanQueueWorkflowEvent(eventType, eventData);
}

export async function listProjects() {
  return getKanbanAdapter().listProjects();
}

export async function listTasks(projectId, filters) {
  return getKanbanAdapter().listTasks(projectId, filters);
}

export async function getTask(taskId) {
  return getKanbanAdapter().getTask(taskId);
}

export async function updateTaskStatus(taskId, status, options) {
  const result = await getKanbanAdapter().updateTaskStatus(taskId, status, options);
  emitKanbanEvent("task.status_updated", { taskId, status, options });
  return result;
}

export async function updateTask(taskId, patch) {
  const adapter = getKanbanAdapter();
  if (typeof adapter.updateTask === "function") {
    return adapter.updateTask(taskId, patch);
  }
  if (patch?.status) {
    return adapter.updateTaskStatus(taskId, patch.status);
  }
  return adapter.getTask(taskId);
}

export async function createTask(projectIdOrTaskData, taskDataArg = {}) {
  const { projectId, taskData } = resolveCreateTaskInput(
    projectIdOrTaskData,
    taskDataArg,
  );
  const result = await getKanbanAdapter().createTask(projectId, taskData);
  emitKanbanEvent("task.created", {
    projectId: projectId ?? result?.projectId ?? result?.project_id ?? null,
    taskId: result?.id || null,
    title: taskData?.title ?? result?.title ?? null,
  });
  return result;
}

export async function deleteTask(taskId) {
  const result = await getKanbanAdapter().deleteTask(taskId);
  emitKanbanEvent("task.deleted", { taskId });
  return result;
}

export async function addComment(taskId, body) {
  return getKanbanAdapter().addComment(taskId, body);
}

/**
 * Persist shared state to an issue (GitHub adapter only).
 * @param {string} taskId - Task identifier (issue number for GitHub)
 * @param {SharedState} sharedState - State to persist
 * @returns {Promise<boolean>} Success status
 */
export async function persistSharedStateToIssue(taskId, sharedState) {
  const adapter = getKanbanAdapter();
  if (typeof adapter.persistSharedStateToIssue === "function") {
    return adapter.persistSharedStateToIssue(taskId, sharedState);
  }
  console.warn(
    `[kanban] persistSharedStateToIssue not supported by ${adapter.name} backend`,
  );
  return false;
}

/**
 * Read shared state from an issue (GitHub adapter only).
 * @param {string} taskId - Task identifier (issue number for GitHub)
 * @returns {Promise<SharedState|null>} Shared state or null
 */
export async function readSharedStateFromIssue(taskId) {
  const adapter = getKanbanAdapter();
  if (typeof adapter.readSharedStateFromIssue === "function") {
    return adapter.readSharedStateFromIssue(taskId);
  }
  return null;
}

/**
 * Mark a task as ignored by bosun (GitHub adapter only).
 * @param {string} taskId - Task identifier (issue number for GitHub)
 * @param {string} reason - Human-readable reason for ignoring
 * @returns {Promise<boolean>} Success status
 */
export async function markTaskIgnored(taskId, reason) {
  const adapter = getKanbanAdapter();
  if (typeof adapter.markTaskIgnored === "function") {
    return adapter.markTaskIgnored(taskId, reason);
  }
  console.warn(
    `[kanban] markTaskIgnored not supported by ${adapter.name} backend`,
  );
  return false;
}

/**
 * Remove the ignore marker from a task (GitHub/Jira only).
 * @param {string} taskId - Task identifier
 * @returns {Promise<boolean>} Success status
 */
export async function unmarkTaskIgnored(taskId) {
  const adapter = getKanbanAdapter();
  if (typeof adapter.unmarkTaskIgnored === "function") {
    return adapter.unmarkTaskIgnored(taskId);
  }
  console.warn(
    `[kanban] unmarkTaskIgnored not supported by ${adapter.name} backend`,
  );
  return false;
}
