/**
 * task-store.mjs — Internal JSON kanban store (source of truth for all task state)
 *
 * Stores data in .cache/kanban-state.json relative to this file.
 * Provides an in-memory cache with auto-persist on every mutation.
 */

import { resolve, dirname, basename, posix as posixPath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
  statSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { syncTaskStoreToStateLedger } from "../lib/state-ledger-sqlite.mjs";
import {
  normalizeTaskRunJournalRef,
  persistTaskRunJournal,
} from "../workspace/execution-journal.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TAG = "[task-store]";
const IS_WINDOWS = process.platform === "win32";
const TEST_STORE_FILENAME_RE = /^kanban-state-vitest-\d+-\d+-[a-f0-9]+\.json$/i;

let testIsolatedStorePath = null;

function isLikelyTestRuntime() {
  if (process.env.VITEST) return true;
  if (process.env.NODE_TEST_CONTEXT) return true;
  if (process.env.BOSUN_TEST_CACHE_DIR) return true;
  return false;
}

function pathsEqual(a, b) {
  const left = resolve(String(a || ""));
  const right = resolve(String(b || ""));
  if (IS_WINDOWS) {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function isTestIsolatedStorePath(candidatePath) {
  return TEST_STORE_FILENAME_RE.test(basename(String(candidatePath || "")));
}

function sanitizePathToken(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "store";
}

function buildIsolatedTestStorePath(persistentStorePath) {
  return resolve(
    tmpdir(),
    "bosun-vitest",
    sanitizePathToken(dirname(persistentStorePath)),
    "kanban-state-vitest-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8) + ".json",
  );
}

function inferRepoRoot(startDir) {
  let current = resolve(startDir || process.cwd());
  while (true) {
    if (existsSync(resolve(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveBosunHomeDir() {
  const explicit = String(
    process.env.BOSUN_HOME || process.env.BOSUN_DIR || "",
  ).trim();
  if (explicit) return resolve(explicit);

  const base = String(
    process.env.APPDATA ||
      process.env.LOCALAPPDATA ||
      process.env.USERPROFILE ||
      process.env.HOME ||
      "",
  ).trim();
  if (!base) return null;
  if (/[/\\]bosun$/i.test(base)) return resolve(base);
  return resolve(base, "bosun");
}

function resolveExplicitRepoRoot() {
  const explicit = String(process.env.REPO_ROOT || "").trim();
  if (!explicit) return null;
  return resolve(explicit);
}

function resolvePersistentStorePath() {
  const explicitRepoRoot = resolveExplicitRepoRoot();
  if (explicitRepoRoot) {
    return resolve(explicitRepoRoot, ".bosun", ".cache", "kanban-state.json");
  }
  const repoRoot = inferRepoRoot(process.cwd());
  if (repoRoot) {
    return resolve(repoRoot, ".bosun", ".cache", "kanban-state.json");
  }
  const bosunHome = resolveBosunHomeDir();
  if (bosunHome) {
    return resolve(bosunHome, ".cache", "kanban-state.json");
  }
  return resolve(__dirname, "..", ".cache", "kanban-state.json");
}

function resolveStorePathForRuntime(candidatePath) {
  const resolvedPath = resolve(String(candidatePath || ""));
  if (!isLikelyTestRuntime()) return resolvedPath;
  if (isTestIsolatedStorePath(resolvedPath)) return resolvedPath;
  const persistentPath = resolvePersistentStorePath();
  if (!pathsEqual(resolvedPath, persistentPath)) return resolvedPath;
  if (!testIsolatedStorePath) {
    testIsolatedStorePath = buildIsolatedTestStorePath(persistentPath);
  }
  return testIsolatedStorePath;
}

function resolveDefaultStorePath() {
  return resolveStorePathForRuntime(resolvePersistentStorePath());
}

function maybeRefreshDefaultStorePathForRuntimeSignals() {
  if (_loaded) return;
  const nextPath = resolveDefaultStorePath();
  if (nextPath === storePath) return;
  storePath = nextPath;
  storeTmpPath = storePath + ".tmp";
  _didLogInitialLoad = false;
  _lastLoadedMtimeMs = 0;
  _lastLoadedSizeBytes = 0;
}

let storePath = resolveDefaultStorePath();
let storeTmpPath = storePath + ".tmp";
const MAX_STATUS_HISTORY = 50;
const MAX_AGENT_OUTPUT = 2000;
const MAX_ERROR_LENGTH = 1000;
const MAX_TASK_TIMELINE = 300;
const MAX_TASK_COMMENTS = 200;
const MAX_WORKFLOW_RUN_LINKS = 200;
const MAX_TASK_RUN_STEPS = 120;
const MAX_TASK_RUNS = 20;
const ATOMIC_RENAME_FALLBACK_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EXDEV"]);

/**
 * Returns true when `raw` is empty or consists entirely of NUL bytes
 * (the classic signature of a Windows post-crash zero-filled file: the OS
 * extended the file metadata for the rename target but never flushed the data
 * pages to disk before the crash). Kept tolerant of trailing/leading
 * whitespace because some editors strip BOMs or add a single newline.
 */
function isNulCorruption(raw) {
  if (raw == null) return false;
  if (typeof raw !== "string") return false;
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) !== 0) return false;
  }
  return true;
}

/**
 * Returns true when `raw` is the empty string or only whitespace. On Windows
 * this regularly happens for a brief window during concurrent rename-replace
 * writes (or when an AV scanner briefly holds the file): readFileSync returns
 * "" even though the underlying file on disk is intact and many MB long.
 * Treating such reads as transient (and retrying) prevents a runaway
 * "Corrupt store detected" loop that previously fired hundreds of times per
 * minute and forced the monitor to self-restart.
 */
function isEmptyTransientRead(raw) {
  return typeof raw === "string" && raw.trim().length === 0;
}

/**
 * Read the store file with a small retry budget for the empty-window case.
 * Synchronous because the surrounding load path is sync. Uses busy-wait
 * (Atomics.wait on a private SharedArrayBuffer is not available in all
 * runtimes; setTimeout is unusable in sync code). The total worst-case wait
 * is ~150 ms (3 × 50 ms), which is acceptable on a load path that already
 * blocks on disk I/O.
 */
function readStoreRawWithRetry(path) {
  let raw = readFileSync(path, "utf-8");
  if (!isEmptyTransientRead(raw)) return raw;
  const stat = (() => { try { return statSync(path); } catch { return null; } })();
  // If the file is genuinely empty on disk (size 0) there's nothing to retry.
  if (!stat || stat.size === 0) return raw;
  // File has bytes but the read returned empty — retry briefly.
  const waitDeadline = Date.now() + 150;
  while (Date.now() < waitDeadline) {
    const start = Date.now();
    while (Date.now() - start < 50) { /* spin */ }
    raw = readFileSync(path, "utf-8");
    if (!isEmptyTransientRead(raw)) return raw;
  }
  return raw;
}

function tryParseStoreFile(candidatePath) {
  try {
    if (!existsSync(candidatePath)) return null;
    const raw = readFileSync(candidatePath, "utf-8");
    if (isNulCorruption(raw)) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return { raw, parsed };
  } catch {
    return null;
  }
}

/**
 * Locate the most recent parseable backup of the kanban store. Searches the
 * companion `.bak`, `.monitor-backup-*`, `.manual-bak-*`, `.bak-sync-*`,
 * `.bak-*`, and `.backup-*` siblings. Returns `{ path, raw, parsed }` or null.
 */
function findLatestGoodBackup(primaryPath) {
  try {
    const dir = dirname(primaryPath);
    const base = basename(primaryPath);
    const entries = readdirSync(dir);
    const candidates = [];
    for (const entry of entries) {
      if (entry === base) continue;
      if (
        entry === `${base}.bak` ||
        entry.startsWith(`${base}.bak-`) ||
        entry.startsWith(`${base}.bak.`) ||
        entry.startsWith(`${base}.backup-`) ||
        entry.startsWith(`${base}.manual-bak-`) ||
        entry.startsWith(`${base}.monitor-backup-`)
      ) {
        const fullPath = resolve(dir, entry);
        try {
          const stat = statSync(fullPath);
          candidates.push({ path: fullPath, mtimeMs: stat.mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const candidate of candidates) {
      const parsed = tryParseStoreFile(candidate.path);
      if (parsed) return { path: candidate.path, ...parsed };
    }
  } catch {
    /* best effort */
  }
  return null;
}
const TERMINAL_TASK_STATUSES = new Set(["done", "cancelled"]);
const SPRINT_ORDER_MODES = new Set(["parallel", "sequential"]);

const TASK_TYPE_SET = new Set(["epic", "task", "subtask"]);
const LIFECYCLE_ACTION_TARGET = Object.freeze({
  start: "inprogress",
  pause: "paused",
  resume: "inprogress",
  complete: "done",
  cancel: "cancelled",
  block: "blocked",
});
const NORMALIZED_STATE_MAP = Object.freeze({
  draft: "backlog",
  backlog: "backlog",
  open: "backlog",
  new: "backlog",
  todo: "backlog",
  inprogress: "inprogress",
  "in-progress": "inprogress",
  assigned: "inprogress",
  working: "inprogress",
  running: "inprogress",
  paused: "paused",
  inreview: "inreview",
  "in-review": "inreview",
  review: "inreview",
  done: "done",
  completed: "done",
  cancelled: "cancelled",
  canceled: "cancelled",
  blocked: "blocked",
  error: "blocked",
});
const ALLOWED_STATE_TRANSITIONS = Object.freeze({
  backlog: new Set(["inprogress", "cancelled", "blocked"]),
  inprogress: new Set(["paused", "inreview", "done", "blocked", "cancelled", "backlog"]),
  paused: new Set(["inprogress", "cancelled", "blocked", "backlog"]),
  inreview: new Set(["done", "blocked", "cancelled", "paused"]),
  done: new Set([]),
  cancelled: new Set([]),
  blocked: new Set(["backlog", "inprogress", "cancelled", "paused"]),
});

function createWorkspaceStorageCollisionError(kind, canonicalKey, existingRaw, incomingRaw) {
  const err = new Error(
    `${kind} key collision after normalization: "${existingRaw}" conflicts with "${incomingRaw}" (canonical="${canonicalKey}")`,
  );
  err.code = "TASK_STORE_KEY_COLLISION";
  err.kind = kind;
  err.canonicalKey = canonicalKey;
  err.existingRaw = existingRaw;
  err.incomingRaw = incomingRaw;
  return err;
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let _store = null; // { _meta: {...}, tasks: { [id]: Task } }
let _loaded = false;
let _writeChain = Promise.resolve(); // simple write lock
let _writeScheduled = false;
let _writeDirty = false;
let _didLogInitialLoad = false;
let _lastLoadedMtimeMs = 0;
let _lastLoadedSizeBytes = 0;

export function configureTaskStore(options = {}) {
  const baseDir = options.baseDir ? resolve(options.baseDir) : null;
  const repoRoot = inferRepoRoot(process.cwd());
  const homeDir = resolveBosunHomeDir();
  const defaultBase = baseDir || repoRoot || homeDir || resolve(__dirname);
  const needsBosunSubdir = Boolean(baseDir || repoRoot);
  const configuredPath = options.storePath
    ? resolve(baseDir || process.cwd(), options.storePath)
    : resolve(
        defaultBase,
        needsBosunSubdir ? ".bosun" : "",
        ".cache",
        "kanban-state.json",
      );
  const nextPath = resolveStorePathForRuntime(configuredPath);

  if (nextPath !== storePath) {
    storePath = nextPath;
    storeTmpPath = storePath + ".tmp";
    _store = null;
    _loaded = false;
    _writeChain = Promise.resolve();
    _writeScheduled = false;
    _writeDirty = false;
    _didLogInitialLoad = false;
    _lastLoadedMtimeMs = 0;
    _lastLoadedSizeBytes = 0;
  }

  return storePath;
}

export async function _resetForTests() {
  await _writeChain.catch(() => null);
  _store = { _meta: defaultMeta(), tasks: {}, sprints: {} };
  _loaded = true;
  _writeChain = Promise.resolve();
  _writeScheduled = false;
  _writeDirty = false;
  _didLogInitialLoad = false;
  _lastLoadedMtimeMs = 0;
  _lastLoadedSizeBytes = 0;

  if (isLikelyTestRuntime() || isTestIsolatedStorePath(storePath)) {
    try {
      unlinkSync(storePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      unlinkSync(storeTmpPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now() {
  return new Date().toISOString();
}

function truncate(str, max) {
  if (str == null) return null;
  const s = String(str);
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeTags(raw) {
  if (!raw) return [];
  const values = Array.isArray(raw)
    ? raw
    : String(raw || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
  const seen = new Set();
  const tags = [];
  for (const value of values) {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  return tags;
}

function normalizeTaskType(rawType) {
  const value = String(rawType || "").trim().toLowerCase();
  if (TASK_TYPE_SET.has(value)) return value;
  return "task";
}

function normalizeSprintId(rawSprintId) {
  const value = String(rawSprintId || "").trim();
  return value || null;
}

function normalizeSprintOrder(rawSprintOrder) {
  if (rawSprintOrder == null || rawSprintOrder === "") return null;
  const numeric = Number(rawSprintOrder);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function resolveSprintOrderMode(rawMode) {
  const mode = String(rawMode || "").trim().toLowerCase();
  return SPRINT_ORDER_MODES.has(mode) ? mode : "parallel";
}

function normalizeTaskStatus(rawStatus) {
  const value = String(rawStatus || "").trim().toLowerCase();
  if (!value) return "todo";
  if (value === "in-progress") return "inprogress";
  if (value === "in-review") return "inreview";
  if (value === "completed") return "done";
  if (value === "canceled") return "cancelled";
  return value;
}

export function normalizeWorkspaceStorageKey(rawKey) {
  const value = String(rawKey ?? "").trim();
  if (!value) return "";
  const unifiedSeparators = value.replace(/[\\]+/g, "/");
  let normalized = posixPath.normalize(unifiedSeparators);
  if (normalized === ".") return "";
  normalized = normalized.replace(/^\.\/+/, "");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLikelyUrl(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(value || "").trim());
}

const PORTABLE_TASK_PATH_KEYS = Object.freeze([
  "archivePath",
  "archiveDir",
  "artifactPath",
  "artifactsDir",
  "attachmentPath",
  "attachmentsDir",
  "exportPath",
  "exportDir",
  "importPath",
  "importDir",
]);

export function normalizePortableTaskPath(rawPath) {
  if (rawPath == null) return "";
  const value = String(rawPath).trim();
  if (!value || isLikelyUrl(value)) return value;
  return normalizeWorkspaceStorageKey(value).toLowerCase();
}

function normalizePortablePathValue(rawPath) {
  return normalizePortableTaskPath(rawPath);
}

function normalizePortablePathList(rawPaths) {
  const values = Array.isArray(rawPaths) ? rawPaths : [rawPaths];
  const normalized = [];
  const seen = new Set();
  for (const entry of values) {
    const canonical = normalizePortablePathValue(entry);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    normalized.push(canonical);
  }
  return normalized;
}

export function getTaskAttachmentCanonicalKey(attachment = {}) {
  if (!attachment || typeof attachment !== "object") return "";
  const url = String(attachment.url || attachment.uri || "").trim();
  if (url) return `url:${url}`;
  const location = normalizePortablePathValue(
    attachment.filePath || attachment.path || attachment.localPath || "",
  );
  if (location) return `path:${location}`;
  if (attachment.id) return `id:${attachment.id}`;
  return `raw:${JSON.stringify(attachment)}`;
}

export function normalizeTaskAttachmentRecord(rawAttachment) {
  if (!rawAttachment || typeof rawAttachment !== "object") return null;
  const normalized = { ...rawAttachment };
  const canonicalLocation = normalizePortablePathValue(
    normalized.filePath || normalized.path || normalized.localPath || "",
  );
  if (canonicalLocation) {
    normalized.filePath = canonicalLocation;
    if (Object.prototype.hasOwnProperty.call(normalized, "path")) {
      normalized.path = canonicalLocation;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, "localPath")) {
      normalized.localPath = canonicalLocation;
    }
  }
  return normalized;
}

export function normalizeTaskAttachments(rawAttachments, options = {}) {
  const values = Array.isArray(rawAttachments) ? rawAttachments : [];
  const normalized = [];
  const seen = new Set();
  for (const value of values) {
    const attachment = normalizeTaskAttachmentRecord(value);
    if (!attachment) continue;
    const key = getTaskAttachmentCanonicalKey(attachment);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(attachment);
  }
  if (options.limit && normalized.length > options.limit) {
    return normalized.slice(0, options.limit);
  }
  return normalized;
}

function normalizeTaskPathPayload(rawPayload = {}, taskId = "", options = {}) {
  if (!isPlainObject(rawPayload)) return {};
  const normalized = { ...rawPayload };
  for (const key of PORTABLE_TASK_PATH_KEYS) {
    if (typeof normalized[key] === "string") {
      normalized[key] = normalizePortablePathValue(normalized[key]);
    }
  }
  if (options.includeWorkspace === true && typeof normalized.workspace === "string") {
    normalized.workspace = normalizeWorkspaceStorageKey(normalized.workspace) || null;
  }
  if (options.includeRepository === true && typeof normalized.repository === "string") {
    normalized.repository = normalizeWorkspaceStorageKey(normalized.repository) || null;
  }
  if (options.includeRepositories === true && normalized.repositories != null) {
    normalized.repositories = normalizeWorkspaceStorageKeys(normalized.repositories, {
      kind: `task:${taskId || "<unknown-task>"}:repositories`,
    });
  }
  if (normalized.attachments != null) {
    normalized.attachments = normalizeTaskAttachments(normalized.attachments, {
      kind: `task:${taskId || "<unknown-task>"}:${options.attachmentKind || "attachments"}`,
    });
  }
  if (normalized.filePaths != null) {
    normalized.filePaths = normalizePortablePathList(normalized.filePaths);
  }
  if (normalized.paths != null) {
    normalized.paths = normalizePortablePathList(normalized.paths);
  }
  return normalized;
}

function normalizeTaskMeta(rawMeta = {}, taskId = "") {
  return normalizeTaskPathPayload(rawMeta, taskId, {
    includeWorkspace: true,
    includeRepository: true,
    attachmentKind: "meta.attachments",
  });
}

export function normalizeWorkspaceStorageKeys(rawKeys, options = {}) {
  const kind = String(options.kind || "workspace-rooted storage").trim();
  const values = Array.isArray(rawKeys) ? rawKeys : [rawKeys];
  const seen = new Map();
  const normalized = [];
  for (const value of values) {
    const raw = String(value ?? "").trim();
    if (!raw) continue;
    const canonical = normalizeWorkspaceStorageKey(raw);
    if (!canonical) continue;
    const existingRaw = seen.get(canonical);
    if (existingRaw && existingRaw !== raw) {
      throw createWorkspaceStorageCollisionError(kind, canonical, existingRaw, raw);
    }
    if (!existingRaw) {
      seen.set(canonical, raw);
      normalized.push(canonical);
    }
  }
  return normalized;
}

function normalizeLifecycleState(rawStatus) {
  const key = normalizeTaskStatus(rawStatus);
  return NORMALIZED_STATE_MAP[key] || "backlog";
}

function uniqueStringList(raw, options = {}) {
  const allowEmpty = options.allowEmpty === true;
  const caseSensitive = options.caseSensitive === true;
  const values = Array.isArray(raw)
    ? raw
    : String(raw || "")
        .split(",")
        .map((entry) => entry.trim());
  const seen = new Set();
  const out = [];
  for (const entry of values) {
    const value = String(entry || "").trim();
    if (!value && !allowEmpty) continue;
    const key = caseSensitive ? value : value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function normalizeTaskComments(rawComments) {
  const values = Array.isArray(rawComments) ? rawComments : [];
  const normalized = [];
  for (const entry of values) {
    if (entry == null) continue;
    const bodyRaw = typeof entry === "string"
      ? entry
      : entry.body || entry.text || entry.content || "";
    const body = String(bodyRaw || "").trim();
    if (!body) continue;
    normalized.push({
      id: typeof entry === "object" && entry.id ? String(entry.id) : null,
      body,
      author: typeof entry === "object" && entry.author != null
        ? String(entry.author)
        : typeof entry === "object" && entry.user != null
          ? String(entry.user)
          : null,
      createdAt:
        typeof entry === "object" && entry.createdAt
          ? String(entry.createdAt)
          : typeof entry === "object" && entry.created_at
            ? String(entry.created_at)
            : now(),
      source: typeof entry === "object" && entry.source ? String(entry.source) : "task",
      kind: typeof entry === "object" && entry.kind ? String(entry.kind) : "comment",
      meta: typeof entry === "object" && entry.meta && typeof entry.meta === "object"
        ? { ...entry.meta }
        : {},
    });
  }
  if (normalized.length <= MAX_TASK_COMMENTS) return normalized;
  return normalized.slice(-MAX_TASK_COMMENTS);
}

function createTimelineEvent(event = {}) {
  const ts = String(event.at || event.timestamp || now());
  return {
    id: String(event.id || `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`),
    at: ts,
    type: String(event.type || "status.transition"),
    source: String(event.source || "task-store"),
    actor: event.actor != null ? String(event.actor) : null,
    action: event.action != null ? String(event.action) : null,
    status: event.status != null ? String(event.status) : null,
    fromStatus: event.fromStatus != null ? String(event.fromStatus) : null,
    toStatus: event.toStatus != null ? String(event.toStatus) : null,
    message: event.message != null ? String(event.message) : null,
    payload: event.payload && typeof event.payload === "object" ? { ...event.payload } : null,
  };
}

function normalizeTimelineEvents(rawEvents) {
  const values = Array.isArray(rawEvents) ? rawEvents : [];
  const normalized = values.map((event) => createTimelineEvent(event));
  if (normalized.length <= MAX_TASK_TIMELINE) return normalized;
  return normalized.slice(-MAX_TASK_TIMELINE);
}

function normalizeWorkflowRunLinks(rawRuns) {
  const values = Array.isArray(rawRuns) ? rawRuns : [];
  const normalized = [];
  for (const entry of values) {
    if (!entry || typeof entry !== "object") continue;
    const runId = String(entry.runId || entry.id || "").trim();
    if (!runId) continue;
    const meta = entry.meta && typeof entry.meta === "object" ? { ...entry.meta } : {};
    const parseDepth = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
    };
    normalized.push({
      runId,
      workflowId: entry.workflowId != null ? String(entry.workflowId) : null,
      workflowName: entry.workflowName != null ? String(entry.workflowName) : null,
      nodeId: entry.nodeId != null ? String(entry.nodeId) : null,
      status: entry.status != null ? String(entry.status) : null,
      outcome: entry.outcome != null ? String(entry.outcome) : null,
      startedAt: entry.startedAt != null ? String(entry.startedAt) : null,
      endedAt: entry.endedAt != null ? String(entry.endedAt) : null,
      summary: entry.summary != null ? String(entry.summary) : null,
      url: entry.url != null ? String(entry.url) : null,
      rootRunId: entry.rootRunId != null ? String(entry.rootRunId) : (meta.rootRunId != null ? String(meta.rootRunId) : null),
      parentRunId: entry.parentRunId != null ? String(entry.parentRunId) : (meta.parentRunId != null ? String(meta.parentRunId) : null),
      retryOf: entry.retryOf != null ? String(entry.retryOf) : (meta.retryOf != null ? String(meta.retryOf) : null),
      retryMode: entry.retryMode != null ? String(entry.retryMode) : (meta.retryMode != null ? String(meta.retryMode) : null),
      taskId: entry.taskId != null ? String(entry.taskId) : (meta.taskId != null ? String(meta.taskId) : null),
      rootTaskId: entry.rootTaskId != null ? String(entry.rootTaskId) : (meta.rootTaskId != null ? String(meta.rootTaskId) : null),
      parentTaskId: entry.parentTaskId != null ? String(entry.parentTaskId) : (meta.parentTaskId != null ? String(meta.parentTaskId) : null),
      sessionId: entry.sessionId != null ? String(entry.sessionId) : (meta.sessionId != null ? String(meta.sessionId) : null),
      rootSessionId: entry.rootSessionId != null ? String(entry.rootSessionId) : (meta.rootSessionId != null ? String(meta.rootSessionId) : null),
      parentSessionId: entry.parentSessionId != null ? String(entry.parentSessionId) : (meta.parentSessionId != null ? String(meta.parentSessionId) : null),
      delegationDepth: parseDepth(entry.delegationDepth ?? meta.delegationDepth),
      source: entry.source != null ? String(entry.source) : "workflow",
      meta,
    });
  }
  if (normalized.length <= MAX_WORKFLOW_RUN_LINKS) return normalized;
  return normalized.slice(-MAX_WORKFLOW_RUN_LINKS);
}

const TERMINAL_WORKFLOW_RUN_LINK_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "skipped",
  "paused",
  "stale",
]);

function parseWorkflowRunLinkTime(value) {
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const direct = Number(text);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasWorkflowRunLinkValue(value) {
  if (typeof value === "string") return value.length > 0;
  return value != null;
}

function scoreWorkflowRunLink(entry) {
  if (!entry || typeof entry !== "object") return 0;
  const status = String(entry.status || "").trim().toLowerCase();
  let score = 0;
  if (hasWorkflowRunLinkValue(entry.workflowId)) score += 1;
  if (hasWorkflowRunLinkValue(entry.workflowName)) score += 1;
  if (hasWorkflowRunLinkValue(entry.nodeId)) score += 1;
  if (hasWorkflowRunLinkValue(entry.status)) score += 2;
  if (hasWorkflowRunLinkValue(entry.outcome)) score += 1;
  if (hasWorkflowRunLinkValue(entry.startedAt)) score += 3;
  if (hasWorkflowRunLinkValue(entry.endedAt)) score += 4;
  if (hasWorkflowRunLinkValue(entry.summary)) score += 2;
  if (hasWorkflowRunLinkValue(entry.url)) score += 1;
  if (hasWorkflowRunLinkValue(entry.rootRunId)) score += 1;
  if (hasWorkflowRunLinkValue(entry.parentRunId)) score += 1;
  if (hasWorkflowRunLinkValue(entry.retryOf)) score += 1;
  if (hasWorkflowRunLinkValue(entry.retryMode)) score += 1;
  if (hasWorkflowRunLinkValue(entry.taskId)) score += 1;
  if (hasWorkflowRunLinkValue(entry.rootTaskId)) score += 1;
  if (hasWorkflowRunLinkValue(entry.parentTaskId)) score += 1;
  if (hasWorkflowRunLinkValue(entry.sessionId)) score += 1;
  if (hasWorkflowRunLinkValue(entry.rootSessionId)) score += 1;
  if (hasWorkflowRunLinkValue(entry.parentSessionId)) score += 1;
  if (Number.isFinite(Number(entry.delegationDepth)) && Number(entry.delegationDepth) > 0) score += 1;
  if (TERMINAL_WORKFLOW_RUN_LINK_STATUSES.has(status)) score += 2;
  return score;
}

function shouldPreferIncomingWorkflowRunLink(existing, incoming) {
  const existingEndedAt = parseWorkflowRunLinkTime(existing?.endedAt);
  const incomingEndedAt = parseWorkflowRunLinkTime(incoming?.endedAt);
  if (incomingEndedAt !== existingEndedAt) return incomingEndedAt > existingEndedAt;

  const existingLatestAt = Math.max(
    parseWorkflowRunLinkTime(existing?.startedAt),
    existingEndedAt,
  );
  const incomingLatestAt = Math.max(
    parseWorkflowRunLinkTime(incoming?.startedAt),
    incomingEndedAt,
  );
  if (incomingLatestAt !== existingLatestAt) return incomingLatestAt > existingLatestAt;

  const existingScore = scoreWorkflowRunLink(existing);
  const incomingScore = scoreWorkflowRunLink(incoming);
  if (incomingScore !== existingScore) return incomingScore > existingScore;

  return String(incoming?.runId || "").trim().localeCompare(String(existing?.runId || "").trim()) >= 0;
}

function mergeWorkflowRunLink(existingEntry, incomingEntry) {
  const existing = normalizeWorkflowRunLinks([existingEntry])[0] || null;
  const incoming = normalizeWorkflowRunLinks([incomingEntry])[0] || null;
  if (!existing) return incoming;
  if (!incoming) return existing;

  const preferIncoming = shouldPreferIncomingWorkflowRunLink(existing, incoming);
  const pick = (field) => {
    const existingValue = existing[field];
    const incomingValue = incoming[field];
    if (!hasWorkflowRunLinkValue(existingValue)) return incomingValue;
    if (!hasWorkflowRunLinkValue(incomingValue)) return existingValue;
    return preferIncoming ? incomingValue : existingValue;
  };

  const merged = {
    runId: pick("runId"),
    workflowId: pick("workflowId"),
    workflowName: pick("workflowName"),
    nodeId: pick("nodeId"),
    status: pick("status"),
    outcome: pick("outcome"),
    startedAt: pick("startedAt"),
    endedAt: pick("endedAt"),
    summary: pick("summary"),
    url: pick("url"),
    rootRunId: pick("rootRunId"),
    parentRunId: pick("parentRunId"),
    retryOf: pick("retryOf"),
    retryMode: pick("retryMode"),
    taskId: pick("taskId"),
    rootTaskId: pick("rootTaskId"),
    parentTaskId: pick("parentTaskId"),
    sessionId: pick("sessionId"),
    rootSessionId: pick("rootSessionId"),
    parentSessionId: pick("parentSessionId"),
    delegationDepth: preferIncoming
      ? incoming.delegationDepth
      : existing.delegationDepth,
    source: pick("source"),
    meta: preferIncoming
      ? { ...(existing.meta || {}), ...(incoming.meta || {}) }
      : { ...(incoming.meta || {}), ...(existing.meta || {}) },
  };
  return normalizeWorkflowRunLinks([merged])[0] || incoming || existing;
}

function shouldPromoteLatestWorkflowRun(task, run, workflowRuns = []) {
  const incomingRunId = String(run?.runId || "").trim();
  if (!incomingRunId) return false;
  const currentLatestRunId = String(
    task?.topology?.latestRunId ??
      task?.latestRunId ??
      "",
  ).trim();
  if (!currentLatestRunId || currentLatestRunId === incomingRunId) return true;
  const currentLatest = workflowRuns.find((entry) => String(entry?.runId || "").trim() === currentLatestRunId) || null;
  if (!currentLatest) return true;
  const currentStatus = String(currentLatest?.status || "").trim().toLowerCase();
  if (currentStatus === "running") return false;
  const incomingStartedAt = Math.max(
    parseWorkflowRunLinkTime(run?.startedAt),
    parseWorkflowRunLinkTime(run?.endedAt),
  );
  const currentStartedAt = Math.max(
    parseWorkflowRunLinkTime(currentLatest?.startedAt),
    parseWorkflowRunLinkTime(currentLatest?.endedAt),
  );
  if (incomingStartedAt !== currentStartedAt) return incomingStartedAt > currentStartedAt;
  return incomingRunId.localeCompare(currentLatestRunId) >= 0;
}

function resolveLatestWorkflowNodeId(task, run, shouldPromoteLatest) {
  const currentTopology =
    task?.topology && typeof task.topology === "object" && !Array.isArray(task.topology)
      ? task.topology
      : {};
  const currentLatestRunId = String(
    currentTopology.latestRunId ??
      task?.latestRunId ??
      "",
  ).trim();
  const incomingRunId = String(run?.runId || "").trim();
  const currentLatestNodeId = String(currentTopology.latestNodeId || "").trim() || null;
  const incomingNodeId = String(run?.nodeId || "").trim() || null;
  const updatesCurrentLatest = Boolean(
    incomingRunId &&
    currentLatestRunId &&
    incomingRunId === currentLatestRunId,
  );

  if (shouldPromoteLatest) {
    if (incomingNodeId) return incomingNodeId;
    return updatesCurrentLatest ? currentLatestNodeId : null;
  }

  if (updatesCurrentLatest) {
    return incomingNodeId || currentLatestNodeId;
  }

  return currentLatestNodeId;
}

function normalizeTaskTopology(rawTopology = {}, rawTask = {}) {
  const topology =
    rawTopology && typeof rawTopology === "object" && !Array.isArray(rawTopology)
      ? rawTopology
      : {};
  const taskId = String(rawTask?.id || topology.taskId || "").trim() || null;
  const graphParentTaskId = String(
    topology.graphParentTaskId ?? rawTask?.parentTaskId ?? "",
  ).trim() || null;
  const explicitPath = uniqueStringList(Array.isArray(topology.graphPath) ? topology.graphPath : []);
  const graphPath = explicitPath.length > 0
    ? [...explicitPath]
    : [...uniqueStringList([graphParentTaskId, taskId].filter(Boolean))];
  if (taskId && graphPath.length > 0 && graphPath[graphPath.length - 1] !== taskId) {
    graphPath.push(taskId);
  }
  const parseDepth = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
  };
  const graphDepthFallback = graphPath.length > 0 ? Math.max(0, graphPath.length - 1) : 0;
  const graphRootTaskId = String(
    topology.graphRootTaskId ??
      topology.rootTaskId ??
      graphPath[0] ??
      taskId ??
      "",
  ).trim() || taskId || null;
  const rootTaskId = String(
    topology.rootTaskId ??
      graphRootTaskId ??
      taskId ??
      "",
  ).trim() || taskId || null;
  const parentTaskId = String(
    topology.parentTaskId ??
      graphParentTaskId ??
      "",
  ).trim() || null;
  return {
    taskId,
    graphParentTaskId,
    graphRootTaskId,
    graphDepth: parseDepth(topology.graphDepth, graphDepthFallback),
    graphPath,
    workflowId: String(topology.workflowId || "").trim() || null,
    workflowName: String(topology.workflowName || "").trim() || null,
    latestNodeId: String(topology.latestNodeId || "").trim() || null,
    latestRunId: String(topology.latestRunId ?? topology.runId ?? "").trim() || null,
    rootRunId: String(topology.rootRunId || "").trim() || null,
    parentRunId: String(topology.parentRunId || "").trim() || null,
    latestSessionId: String(topology.latestSessionId ?? topology.sessionId ?? "").trim() || null,
    sessionId: String(topology.sessionId ?? topology.latestSessionId ?? "").trim() || null,
    rootSessionId: String(topology.rootSessionId || "").trim() || null,
    parentSessionId: String(topology.parentSessionId || "").trim() || null,
    rootTaskId,
    parentTaskId,
    delegationDepth: parseDepth(topology.delegationDepth, 0),
  };
}

function syncLegacyTaskTopologyFields(task) {
  if (!task || typeof task !== "object") return task;
  const topology = normalizeTaskTopology(task.topology, task);
  const pickString = (...values) => {
    for (const value of values) {
      const normalized = String(value ?? "").trim();
      if (normalized) return normalized;
    }
    return null;
  };
  task.topology = topology;
  task.workflowId = pickString(topology.workflowId, task.workflowId);
  task.workflowName = pickString(topology.workflowName, task.workflowName);
  task.latestRunId = pickString(topology.latestRunId, task.latestRunId);
  task.rootRunId = pickString(topology.rootRunId, task.rootRunId);
  task.parentRunId = pickString(topology.parentRunId, task.parentRunId);
  task.latestSessionId = pickString(topology.latestSessionId, task.latestSessionId);
  task.sessionId = pickString(topology.sessionId, task.sessionId, task.latestSessionId);
  task.rootSessionId = pickString(topology.rootSessionId, task.rootSessionId);
  task.parentSessionId = pickString(topology.parentSessionId, task.parentSessionId);
  task.worktreePath = pickString(task.worktreePath, task.meta?.worktreePath);
  return task;
}

function refreshTaskTopology(task) {
  if (!task || typeof task !== "object") return;
  syncLegacyTaskTopologyFields(task);
}

function refreshTaskGraphTopology(taskId, visited = new Set()) {
  if (!taskId || visited.has(taskId) || !_store?.tasks?.[taskId]) return;
  visited.add(taskId);
  const task = _store.tasks[taskId];
  const parent = task.parentTaskId ? _store.tasks[task.parentTaskId] : null;
  const parentPath =
    Array.isArray(parent?.topology?.graphPath) && parent.topology.graphPath.length > 0
      ? parent.topology.graphPath
      : (parent?.id ? [parent.id] : []);
  task.topology = normalizeTaskTopology(
    {
      ...(task.topology && typeof task.topology === "object" ? task.topology : {}),
      graphParentTaskId: parent?.id || null,
      graphRootTaskId: parent?.topology?.graphRootTaskId || parent?.id || task.id || null,
      graphDepth: parentPath.length,
      graphPath: task.id ? [...parentPath, task.id] : parentPath,
    },
    task,
  );
  syncLegacyTaskTopologyFields(task);
  for (const childId of uniqueStringList(task.childTaskIds || [])) {
    refreshTaskGraphTopology(childId, visited);
  }
}

function summarizeTrajectoryStepText(value, maxLength = 160) {
  const text = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!text) return null;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function buildTrajectoryStepSummary(step = {}) {
  const type = String(step?.type || "event").trim().toLowerCase();
  const payload = step?.payload && typeof step.payload === "object" ? step.payload : {};
  const event = step?.event && typeof step.event === "object" ? step.event : {};

  if (type === "thread") {
    const resumed = payload?.resumed === true || event?.resumed === true;
    const sdk = String(payload?.sdk || event?.sdk || "agent").trim() || "agent";
    return resumed ? `Resumed ${sdk} session.` : `Started ${sdk} session.`;
  }
  if (type === "assistant") {
    return summarizeTrajectoryStepText(
      payload?.summary || payload?.message || payload?.content || event?.summary || event?.content || "Assistant responded.",
    ) || "Assistant responded.";
  }
  if (type === "user") {
    return summarizeTrajectoryStepText(
      payload?.summary || payload?.message || payload?.content || event?.summary || event?.content || "User prompt recorded.",
    ) || "User prompt recorded.";
  }
  if (type === "tool_call") {
    const toolName = String(payload?.toolName || payload?.tool || event?.toolName || event?.tool || "tool").trim() || "tool";
    return `Called ${toolName}.`;
  }
  if (type === "tool_result") {
    const toolName = String(payload?.toolName || payload?.tool || event?.toolName || event?.tool || "tool").trim() || "tool";
    const status = String(payload?.status || event?.status || "ok").trim().toLowerCase();
    return status === "error" || status === "failed" ? `${toolName} returned an error.` : `${toolName} completed.`;
  }
  if (type === "reasoning") {
    return summarizeTrajectoryStepText(payload?.summary || payload?.text || event?.summary || event?.text || "Reasoning updated.") || "Reasoning updated.";
  }
  if (type === "status") {
    return summarizeTrajectoryStepText(payload?.summary || payload?.message || event?.summary || event?.message || "Run status changed.") || "Run status changed.";
  }
  return summarizeTrajectoryStepText(
    step?.summary || payload?.summary || payload?.message || event?.summary || event?.message || "Run event recorded.",
  ) || "Run event recorded.";
}

function normalizeTaskRunStep(step = {}, index = 0) {
  return {
    id: String(step?.id || `step-${Date.now()}-${index}-${Math.random().toString(16).slice(2, 8)}`),
    at: String(step?.at || step?.timestamp || now()),
    type: String(step?.type || "event"),
    summary: summarizeTrajectoryStepText(step?.summary || buildTrajectoryStepSummary(step)) || "Run event recorded.",
    payload: step?.payload && typeof step.payload === "object" ? { ...step.payload } : null,
    event: step?.event && typeof step.event === "object" ? { ...step.event } : null,
  };
}

function normalizeTaskRunSteps(rawSteps) {
  const values = Array.isArray(rawSteps) ? rawSteps : [];
  const normalized = values.map((step, index) => normalizeTaskRunStep(step, index)).filter(Boolean);
  if (normalized.length <= MAX_TASK_RUN_STEPS) return normalized;
  return normalized.slice(-MAX_TASK_RUN_STEPS);
}

function normalizeTaskRuns(rawRuns) {
  const values = Array.isArray(rawRuns) ? rawRuns : [];
  const normalized = [];
  for (const entry of values) {
    if (!entry || typeof entry !== "object") continue;
    const runId = String(entry.runId || entry.id || "").trim();
    if (!runId) continue;
    normalized.push({
      runId,
      startedAt: String(entry.startedAt || entry.createdAt || now()),
      endedAt: entry.endedAt != null ? String(entry.endedAt) : null,
      status: entry.status != null ? String(entry.status) : "running",
      taskKey: entry.taskKey != null ? String(entry.taskKey) : null,
      sdk: entry.sdk != null ? String(entry.sdk) : null,
      threadId: entry.threadId != null ? String(entry.threadId) : null,
      resumeThreadId: entry.resumeThreadId != null ? String(entry.resumeThreadId) : null,
      replayable: entry.replayable !== false,
      outcome: entry.outcome != null ? String(entry.outcome) : null,
      summary: summarizeTrajectoryStepText(entry.summary || entry.title || "") || null,
      steps: normalizeTaskRunSteps(entry.steps),
      journal: normalizeTaskRunJournalRef(entry.journal || entry.meta?.journal),
      meta: entry.meta && typeof entry.meta === "object" ? { ...entry.meta } : {},
    });
  }
  if (normalized.length <= MAX_TASK_RUNS) return normalized;
  return normalized.slice(-MAX_TASK_RUNS);
}

function persistTaskRunJournalRef(taskId, run) {
  if (!run || typeof run !== "object") return run;
  try {
    const journal = persistTaskRunJournal(taskId, run, { taskStorePath: storePath });
    const nextMeta = run.meta && typeof run.meta === "object" ? { ...run.meta } : {};
    nextMeta.journal = journal;
    delete nextMeta.journalError;
    return {
      ...run,
      journal,
      meta: nextMeta,
    };
  } catch (error) {
    const nextMeta = run.meta && typeof run.meta === "object" ? { ...run.meta } : {};
    nextMeta.journalError = String(error?.message || error);
    return {
      ...run,
      journal: normalizeTaskRunJournalRef(run.journal || run.meta?.journal),
      meta: nextMeta,
    };
  }
}

function backfillTaskRunJournalsForTask(task) {
  if (!task || !Array.isArray(task.runs) || task.runs.length === 0) {
    return false;
  }
  const nextRuns = normalizeTaskRuns(task.runs).map((run) => persistTaskRunJournalRef(task.id, run));
  const changed = JSON.stringify(nextRuns) !== JSON.stringify(task.runs);
  if (changed) {
    task.runs = normalizeTaskRuns(nextRuns);
  }
  return changed;
}

function validateTaskTransition(currentStatus, nextStatus, options = {}) {
  const fromStatus = normalizeTaskStatus(currentStatus);
  const toStatus = normalizeTaskStatus(nextStatus);
  const fromState = normalizeLifecycleState(fromStatus);
  const toState = normalizeLifecycleState(toStatus);
  if (fromStatus === toStatus) {
    return { valid: true, fromStatus, toStatus, fromState, toState, reason: "no_change" };
  }
  if (options.force === true) {
    return { valid: true, fromStatus, toStatus, fromState, toState, reason: "forced" };
  }
  const allowed = ALLOWED_STATE_TRANSITIONS[fromState] || new Set();
  if (allowed.has(toState)) {
    return { valid: true, fromStatus, toStatus, fromState, toState, reason: "allowed" };
  }
  return {
    valid: false,
    fromStatus,
    toStatus,
    fromState,
    toState,
    reason: `invalid_transition:${fromState}->${toState}`,
  };
}

function taskHasReviewReference(task) {
  if (!task || typeof task !== "object") return false;
  const prNumber = Number.parseInt(String(task.prNumber || task.pr_number || ""), 10);
  if (Number.isFinite(prNumber) && prNumber > 0) return true;
  if (String(task.prUrl || task.pr_url || "").trim()) return true;
  if (Array.isArray(task.links?.prs) && task.links.prs.some((value) => String(value || "").trim())) {
    return true;
  }
  return false;
}

function buildTaskCompletionGuardContext(task, overrides = {}) {
  const nextLinks = overrides.links && typeof overrides.links === "object"
    ? {
        ...(task?.links && typeof task.links === "object" ? task.links : {}),
        ...overrides.links,
      }
    : task?.links;
  const reviewIssues = Array.isArray(overrides.reviewIssues)
    ? overrides.reviewIssues
    : (Array.isArray(task?.reviewIssues) ? task.reviewIssues : []);
  const mergedTask = {
    ...(task && typeof task === "object" ? task : {}),
    ...(overrides && typeof overrides === "object" ? overrides : {}),
    links: nextLinks,
  };
  return {
    hasReviewReference: taskHasReviewReference(mergedTask),
    reviewStatus: String(
      overrides.reviewStatus ?? task?.reviewStatus ?? "",
    ).trim().toLowerCase() || null,
    reviewedAt: overrides.reviewedAt ?? task?.reviewedAt ?? null,
    reviewIssueCount: reviewIssues.length,
  };
}

function recordLifecycleGuardBlock(task, action, guard, options = {}) {
  if (!task || typeof task !== "object") return;
  pushTaskTimeline(task, {
    type: "lifecycle.blocked",
    source: options.source || "task-store",
    actor: options.actor != null ? String(options.actor) : null,
    action: action || "complete",
    fromStatus: task.status,
    toStatus: options.targetStatus || options.status || null,
    status: task.status,
    message: String(
      guard?.message || "Lifecycle action blocked by completion guard.",
    ),
    payload: {
      error: guard?.error || "completion_guard_blocked",
      reason: guard?.reason || null,
      reviewStatus: guard?.reviewStatus || null,
      hasReviewReference: guard?.hasReviewReference === true,
      requiredStatus: guard?.requiredStatus || null,
    },
  });
  markTaskTouched(task, options.source || "task-store");
  saveStore();
}

export function evaluateTaskCompletionGuard(taskOrId, options = {}) {
  ensureLoaded();
  const task = typeof taskOrId === "string" ? _store.tasks[taskOrId] : taskOrId;
  if (!task || typeof task !== "object") return null;
  if (
    options.force === true ||
    options.manualOverride === true ||
    options.allowCompletionOverride === true
  ) {
    return null;
  }

  const normalizedAction = String(options.action || "").trim().toLowerCase();
  const requestedStatus = normalizeTaskStatus(
    options.targetStatus ||
      options.status ||
      LIFECYCLE_ACTION_TARGET[normalizedAction] ||
      "",
  );
  if (requestedStatus !== "done") return null;

  const guardContext = buildTaskCompletionGuardContext(
    task,
    options.patch && typeof options.patch === "object" ? options.patch : {},
  );
  const hasReviewContext =
    normalizeTaskStatus(task.status) === "inreview" ||
    guardContext.hasReviewReference ||
    Boolean(guardContext.reviewStatus) ||
    Boolean(guardContext.reviewedAt) ||
    guardContext.reviewIssueCount > 0;
  if (!hasReviewContext) return null;
  if (guardContext.reviewStatus === "approved") return null;

  const reason =
    guardContext.reviewStatus === "changes_requested"
      ? "review_changes_requested"
      : "review_not_approved";
  const message =
    reason === "review_changes_requested"
      ? "Task review requested changes. Approve the review or force the completion override before marking this task done."
      : "Task completion requires an approved review before it can be marked done.";

  return {
    error: "completion_guard_blocked",
    reason,
    message,
    reviewStatus: guardContext.reviewStatus,
    reviewedAt: guardContext.reviewedAt,
    reviewIssueCount: guardContext.reviewIssueCount,
    hasReviewReference: guardContext.hasReviewReference,
    requiredStatus: "approved",
  };
}

function shouldKeepTaskInReview(task, requestedStatus, options = {}) {
  if (!task || options.force === true || options.allowReviewExit === true) return false;
  if (normalizeTaskStatus(task.status) !== "inreview") return false;
  if (!taskHasReviewReference(task)) return false;
  const nextStatus = normalizeTaskStatus(requestedStatus);
  return nextStatus === "todo" || nextStatus === "backlog" || nextStatus === "inprogress";
}

function resolveProtectedTaskStatus(task, requestedStatus, options = {}) {
  const nextStatus = normalizeTaskStatus(requestedStatus);
  if (shouldKeepTaskInReview(task, nextStatus, options)) {
    return "inreview";
  }
  return nextStatus;
}

function normalizeTaskStructure(rawTask = {}) {
  const base = defaultTask(rawTask);
  const taskId = String(base?.id || rawTask?.id || "").trim() || "<unknown-task>";
  const normalizedBase = normalizeTaskPathPayload(base, taskId, {
    attachmentKind: "attachments",
  });
  const workspaceKey = normalizeWorkspaceStorageKey(normalizedBase.workspace);
  const repositoryKey = normalizeWorkspaceStorageKey(normalizedBase.repository);
  const repositoryKeys = normalizeWorkspaceStorageKeys(normalizedBase.repositories || [], {
    kind: `task:${taskId}:repositories`,
  });
  const scopedRepositoryKeys = normalizeWorkspaceStorageKeys(
    [repositoryKey, ...repositoryKeys],
    { kind: `task:${taskId}:workspace-rooted` },
  );
  const attachments = normalizeTaskAttachments(normalizedBase.attachments, {
    kind: `task:${taskId}:attachments`,
  });
  const normalizedMeta = normalizeTaskMeta(normalizedBase.meta, taskId);
  const normalized = {
    ...normalizedBase,
    status: normalizeTaskStatus(normalizedBase.status),
    type: normalizeTaskType(normalizedBase.type),
    epicId: normalizedBase.epicId ? String(normalizedBase.epicId) : null,
    parentTaskId: normalizedBase.parentTaskId ? String(normalizedBase.parentTaskId) : null,
    childTaskIds: uniqueStringList(normalizedBase.childTaskIds || []),
    dependencyTaskIds: uniqueStringList(normalizedBase.dependencyTaskIds || []),
    blockedByTaskIds: uniqueStringList(normalizedBase.blockedByTaskIds || []),
    dependsOn: uniqueStringList(
      normalizedBase.dependsOn || normalizedBase.dependencyTaskIds || [],
    ),
    assignees: uniqueStringList(normalizedBase.assignees || []),
    watchers: uniqueStringList(normalizedBase.watchers || []),
    links: {
      branches: uniqueStringList(normalizedBase.links?.branches || []),
      prs: uniqueStringList(normalizedBase.links?.prs || []),
      workflows: uniqueStringList(normalizedBase.links?.workflows || []),
    },
    comments: normalizeTaskComments(
      Array.isArray(normalizedBase.comments) && normalizedBase.comments.length
        ? normalizedBase.comments
        : Array.isArray(normalizedBase.meta?.comments)
          ? normalizedBase.meta.comments
          : [],
    ),
    timeline: normalizeTimelineEvents(
      Array.isArray(normalizedBase.timeline)
        ? normalizedBase.timeline
        : Array.isArray(normalizedBase.meta?.timeline)
          ? normalizedBase.meta.timeline
          : [],
    ),
    workflowRuns: normalizeWorkflowRunLinks(
      Array.isArray(normalizedBase.workflowRuns)
        ? normalizedBase.workflowRuns
        : Array.isArray(normalizedBase.meta?.workflowRuns)
          ? normalizedBase.meta.workflowRuns
          : [],
    ),
    runs: normalizeTaskRuns(
      Array.isArray(normalizedBase.runs)
        ? normalizedBase.runs
        : Array.isArray(normalizedBase.meta?.runs)
          ? normalizedBase.meta.runs
          : [],
    ),
    topology: normalizeTaskTopology(normalizedBase.topology, normalizedBase),
    stateVersion: Number.isFinite(Number(normalizedBase.stateVersion))
      ? Number(normalizedBase.stateVersion)
      : 2,
    sprintId: normalizeSprintId(normalizedBase.sprintId),
    sprintOrder: normalizeSprintOrder(normalizedBase.sprintOrder),
    workspace: workspaceKey || null,
    repository: repositoryKey || null,
    repositories: scopedRepositoryKeys,
    attachments,
    meta: normalizedMeta,
  };
  if (normalized.status === "draft") {
    normalized.draft = true;
  }
  normalized.meta = {
    ...(normalized.meta || {}),
    draft: normalized.draft === true,
  };
  return syncLegacyTaskTopologyFields(normalized);
}

export function normalizeTaskStorageRecord(rawTask = {}) {
  return normalizeTaskStructure(rawTask);
}

function pushTaskTimeline(task, event = {}) {
  task.timeline = normalizeTimelineEvents([...(Array.isArray(task.timeline) ? task.timeline : []), event]);
}

function markTaskTouched(task, source = "task-store") {
  const ts = now();
  task.updatedAt = ts;
  task.lastActivityAt = ts;
  task.syncDirty = source !== "external";
}

function defaultMeta() {
  return {
    version: 1,
    projectId: null,
    lastFullSync: null,
    epicDependencies: {},
    sprintOrderMode: "parallel",
    taskCount: 0,
    stats: {
      draft: 0,
      todo: 0,
      inprogress: 0,
      inreview: 0,
      done: 0,
      blocked: 0,
    },
  };
}

function defaultTask(overrides = {}) {
  const ts = now();
  return {
    id: null,
    title: "",
    description: "",
    status: "todo",
    externalStatus: null,
    externalId: null,
    externalBackend: null,
    assignee: null,
    priority: null,
    tags: [],
    draft: false,
    projectId: null,
    workspace: null,
    repository: null,
    repositories: [],
    baseBranch: null,
    branchName: null,
    prNumber: null,
    prUrl: null,
    sprintId: null,
    sprintOrder: null,

    // Task State V2 graph/state fields
    type: "task",
    epicId: null,
    parentTaskId: null,
    childTaskIds: [],
    dependencyTaskIds: [],
    blockedByTaskIds: [],
    dependsOn: [],
    assignees: [],
    watchers: [],
    comments: [],
    timeline: [],
    workflowRuns: [],
    runs: [],
    topology: {},
    links: { branches: [], prs: [], workflows: [] },
    stateVersion: 2,

    createdAt: ts,
    updatedAt: ts,
    lastActivityAt: ts,
    statusHistory: [],

    agentAttempts: 0,
    consecutiveNoCommits: 0,
    lastAgentOutput: null,
    lastError: null,
    errorPattern: null,

    reviewStatus: null,
    reviewIssues: null,
    reviewedAt: null,

    cooldownUntil: null,
    blockedReason: null,

    lastSyncedAt: null,
    syncDirty: false,

    meta: {},
    ...overrides,
  };
}

function normalizeSprintStructure(rawSprint = {}, existingSprint = null) {
  const ts = now();
  const id = normalizeSprintId(rawSprint.id || existingSprint?.id);
  if (!id) return null;
  const createdAt = String(rawSprint.createdAt || existingSprint?.createdAt || ts);
  const updatedAt = String(rawSprint.updatedAt || ts);
  const executionMode = resolveSprintOrderMode(
    rawSprint.executionMode
      ?? rawSprint.taskOrderMode
      ?? existingSprint?.executionMode
      ?? existingSprint?.taskOrderMode
      ?? "parallel",
  );
  return {
    id,
    name: String(rawSprint.name || existingSprint?.name || id),
    goal: rawSprint.goal != null ? String(rawSprint.goal) : existingSprint?.goal ?? null,
    status: String(rawSprint.status || existingSprint?.status || "planned"),
    order: normalizeSprintOrder(rawSprint.order ?? existingSprint?.order),
    startDate:
      rawSprint.startDate != null
        ? String(rawSprint.startDate)
        : existingSprint?.startDate ?? null,
    endDate:
      rawSprint.endDate != null
        ? String(rawSprint.endDate)
        : existingSprint?.endDate ?? null,
    createdAt,
    updatedAt,
    meta: rawSprint.meta && typeof rawSprint.meta === "object"
      ? { ...rawSprint.meta }
      : existingSprint?.meta && typeof existingSprint.meta === "object"
        ? { ...existingSprint.meta }
        : {},
    executionMode,
    taskOrderMode: executionMode,
  };
}

function listTaskDependencyIds(task) {
  return uniqueStringList([...(task?.dependencyTaskIds || []), ...(task?.dependsOn || [])]);
}

function getSprintTaskOrderSequence(sprintId) {
  const normalizedSprintId = normalizeSprintId(sprintId);
  if (!normalizedSprintId) return [];
  return Object.values(_store.tasks)
    .filter((task) => task?.sprintId === normalizedSprintId)
    .sort(compareTaskDagOrder);
}

function getNextSprintTaskOrder(sprintId) {
  const sequence = getSprintTaskOrderSequence(sprintId);
  let maxOrder = 0;
  for (const task of sequence) {
    const order = normalizeSprintOrder(task?.sprintOrder);
    if (order != null && order > maxOrder) maxOrder = order;
  }
  return maxOrder + 1;
}

function isTaskTerminal(task) {
  return TERMINAL_TASK_STATUSES.has(normalizeTaskStatus(task?.status));
}

function compareTaskDagOrder(taskA, taskB) {
  const orderA = normalizeSprintOrder(taskA?.sprintOrder);
  const orderB = normalizeSprintOrder(taskB?.sprintOrder);
  if (orderA != null && orderB != null && orderA !== orderB) return orderA - orderB;
  if (orderA != null && orderB == null) return -1;
  if (orderA == null && orderB != null) return 1;
  const createdAtA = String(taskA?.createdAt || "");
  const createdAtB = String(taskB?.createdAt || "");
  if (createdAtA !== createdAtB) return createdAtA.localeCompare(createdAtB);
  return String(taskA?.id || "").localeCompare(String(taskB?.id || ""));
}

function compareSprintDagOrder(sprintA, sprintB) {
  const orderA = normalizeSprintOrder(sprintA?.order);
  const orderB = normalizeSprintOrder(sprintB?.order);
  if (orderA != null && orderB != null && orderA !== orderB) return orderA - orderB;
  if (orderA != null && orderB == null) return -1;
  if (orderA == null && orderB != null) return 1;
  return String(sprintA?.name || sprintA?.id || "").localeCompare(String(sprintB?.name || sprintB?.id || ""));
}

function topoSortIds(seedIds, incomingMap, outgoingMap, compareEntries) {
  const remaining = new Map();
  for (const id of seedIds) remaining.set(id, incomingMap.get(id) || 0);
  const ordered = [];
  const ready = [...seedIds].filter((id) => (remaining.get(id) || 0) === 0);

  while (ready.length > 0) {
    ready.sort(compareEntries);
    const current = ready.shift();
    ordered.push(current);
    for (const nextId of outgoingMap.get(current) || []) {
      if (!remaining.has(nextId)) continue;
      const nextCount = (remaining.get(nextId) || 0) - 1;
      remaining.set(nextId, nextCount);
      if (nextCount === 0) ready.push(nextId);
    }
    remaining.delete(current);
  }

  if (remaining.size > 0) {
    ordered.push(...[...remaining.keys()].sort(compareEntries));
  }

  return ordered;
}

function hasDependencyPath(taskMap, fromTaskId, targetTaskId, visited = new Set()) {
  const startId = String(fromTaskId || "").trim();
  const targetId = String(targetTaskId || "").trim();
  if (!startId || !targetId) return false;
  if (startId === targetId) return true;
  if (visited.has(startId)) return false;
  visited.add(startId);
  const task = taskMap.get(startId);
  if (!task) return false;
  for (const dependencyId of listTaskDependencyIds(task)) {
    if (dependencyId === targetId) return true;
    if (hasDependencyPath(taskMap, dependencyId, targetId, visited)) return true;
  }
  return false;
}

function collectDagRewriteSuggestions(taskMap, orderedTaskIds, sprint) {
  const suggestions = [];
  const sprintId = normalizeSprintId(sprint?.id);
  const sprintMode = resolveSprintOrderMode(sprint?.executionMode || sprint?.taskOrderMode || "parallel");

  // Cache for hasDependencyPath results to avoid repeated expensive traversals.
  const pathCache = new Map();
  function memoizedHasDependencyPath(fromTaskId, targetTaskId, initialVisited) {
    const fromId = String(fromTaskId || "").trim();
    const toId = String(targetTaskId || "").trim();
    if (!fromId || !toId) return false;
    const cacheKey = `${fromId}::${toId}`;
    if (pathCache.has(cacheKey)) {
      return pathCache.get(cacheKey);
    }
    const visited = initialVisited ? new Set(initialVisited) : new Set();
    const result = hasDependencyPath(taskMap, fromId, toId, visited);
    pathCache.set(cacheKey, result);
    return result;
  }

  if (sprintMode === "sequential") {
    for (let index = 1; index < orderedTaskIds.length; index += 1) {
      const previousTaskId = orderedTaskIds[index - 1];
      const currentTaskId = orderedTaskIds[index];
      const currentTask = taskMap.get(currentTaskId);
      if (!currentTask) continue;
      if (new Set(listTaskDependencyIds(currentTask)).has(previousTaskId)) continue;
      suggestions.push({
        type: "missing_sequential_dependency",
        sprintId,
        taskId: currentTaskId,
        dependencyTaskId: previousTaskId,
        message: `Add dependency ${previousTaskId} -> ${currentTaskId} to encode sequential sprint order.`,
      });
    }
  }

  for (const taskId of orderedTaskIds) {
    const task = taskMap.get(taskId);
    if (!task) continue;
    const directDependencies = listTaskDependencyIds(task);
    for (const dependencyId of directDependencies) {
      const redundant = directDependencies.some((otherDependencyId) => {
        if (otherDependencyId === dependencyId) return false;
        return memoizedHasDependencyPath(otherDependencyId, dependencyId, new Set([taskId]));
      });
      if (!redundant) continue;
      suggestions.push({
        type: "redundant_transitive_dependency",
        sprintId,
        taskId,
        dependencyTaskId: dependencyId,
        message: `Dependency ${dependencyId} -> ${taskId} is already implied transitively by another dependency.`,
      });
    }
  }

  return suggestions;
}

function getTaskEpicId(task) {
  return String(task?.epicId ?? task?.meta?.epicId ?? "").trim();
}

function normalizeRecoveredTaskMeta(task, recoveredAt) {
  const currentMeta = task?.meta && typeof task.meta === "object" ? task.meta : {};
  const currentRecovery = currentMeta.autoRecovery && typeof currentMeta.autoRecovery === "object"
    ? currentMeta.autoRecovery
    : {};
  const nextMeta = {
    ...currentMeta,
    autoRecovery: {
      ...currentRecovery,
      active: false,
      recoveredAt,
      recoveredStatus: "todo",
    },
  };
  delete nextMeta.worktreeFailure;
  delete nextMeta.blockedReason;
  return nextMeta;
}

function recalcStats() {
  const stats = {
    draft: 0,
    todo: 0,
    inprogress: 0,
    inreview: 0,
    done: 0,
    blocked: 0,
  };
  for (const t of Object.values(_store.tasks)) {
    if (t.status === "blocked") {
      stats.blocked++;
    } else if (stats[t.status] !== undefined) {
      stats[t.status]++;
    }
  }
  _store._meta.taskCount = Object.keys(_store.tasks).length;
  _store._meta.stats = stats;
}

function ensureLoaded() {
  maybeRefreshDefaultStorePathForRuntimeSignals();
  if (_loaded) {
    maybeReloadStoreFromDisk();
    return;
  }
  loadStore();
}

function getStoreFingerprint() {
  if (!existsSync(storePath)) {
    return { mtimeMs: 0, sizeBytes: 0 };
  }
  try {
    const stats = statSync(storePath);
    return {
      mtimeMs: stats.mtimeMs || 0,
      sizeBytes: Number.isFinite(stats.size) ? stats.size : 0,
    };
  } catch {
    return { mtimeMs: 0, sizeBytes: 0 };
  }
}

function maybeReloadStoreFromDisk() {
  const disk = getStoreFingerprint();
  const mtimeChanged = disk.mtimeMs > _lastLoadedMtimeMs;
  const sizeChanged = disk.sizeBytes !== _lastLoadedSizeBytes;
  if (!mtimeChanged && !sizeChanged) return;
  loadStore();
}

function buildCorruptBackupPath() {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `${storePath}.corrupt-${iso}.json`;
}

function backupCorruptStorePayload(raw, parseErr) {
  const backupPath = buildCorruptBackupPath();
  try {
    const dir = dirname(backupPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(backupPath, raw, "utf-8");
    console.error(
      TAG,
      `Detected corrupt store JSON at ${storePath}. Backed up payload to ${backupPath}.`,
      parseErr?.message || parseErr,
    );
  } catch (backupErr) {
    console.error(
      TAG,
      `Detected corrupt store JSON at ${storePath}, but failed to write backup:`,
      backupErr?.message || backupErr,
    );
  }
}

// ---------------------------------------------------------------------------
// Store management
// ---------------------------------------------------------------------------

/**
 * Load store from disk. Called automatically on first access.
 */
export function loadStore() {
  let didBackfillTaskRunJournals = false;
  try {
    if (existsSync(storePath)) {
      const raw = readStoreRawWithRetry(storePath);
      // If the file is on-disk-non-empty but our reads kept returning empty,
      // skip backup/quarantine entirely and either keep the in-memory store
      // (already loaded once) or recover from a known-good backup. This
      // prevents the runaway "Corrupt store detected" loop on Windows when
      // an AV scanner / concurrent rename briefly hides the file contents.
      if (isEmptyTransientRead(raw)) {
        let onDiskSize = 0;
        try { onDiskSize = statSync(storePath).size; } catch { /* ignore */ }
        if (onDiskSize > 0) {
          if (_loaded && _store) {
            // Best outcome: we already had a valid store loaded; just keep it.
            console.warn(
              TAG,
              `transient empty read of ${storePath} (size=${onDiskSize}B); keeping in-memory store`,
            );
            return;
          }
          const recovered = findLatestGoodBackup(storePath);
          if (recovered) {
            console.warn(
              TAG,
              `transient empty read of ${storePath} (size=${onDiskSize}B); recovered from ${recovered.path}`,
            );
            _store = {
              _meta: { ...defaultMeta(), ...(recovered.parsed._meta || {}) },
              tasks: recovered.parsed.tasks || {},
              sprints: recovered.parsed.sprints || {},
            };
            _loaded = true;
            return;
          }
          // Nothing recoverable — fall through and let JSON.parse throw so
          // we hit the existing "Failed to load store, starting fresh" path.
        }
      }
      let data;
      try {
        if (isNulCorruption(raw)) {
          throw new Error(
            `kanban-state.json is ${raw.length} bytes of NUL (zero-fill corruption from prior unflushed write)`,
          );
        }
        data = JSON.parse(raw);
      } catch (parseErr) {
        // Quarantine the corrupt copy with a unique timestamped suffix so we
        // never overwrite a previously-good `.bak`. Earlier versions of this
        // module wrote unconditionally to `${storePath}.bak`, which on a
        // second corrupt-load would replace the last known-good backup with
        // the same corrupt bytes.
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const quarantinePath = `${storePath}.bak.corrupt-${ts}`;
        try {
          writeFileSync(quarantinePath, raw, "utf-8");
          console.warn(
            TAG,
            `Corrupt store detected; quarantined original at ${quarantinePath}`,
          );
        } catch (quarantineErr) {
          console.warn(
            TAG,
            `Corrupt store detected; failed to quarantine at ${quarantinePath}: ${quarantineErr?.message || quarantineErr}`,
          );
        }
        // Only refresh `.bak` if the existing `.bak` is missing or itself
        // unparseable. Never clobber a parseable backup with corrupt content.
        const backupPath = `${storePath}.bak`;
        const existingBackup = tryParseStoreFile(backupPath);
        if (!existingBackup) {
          try {
            writeFileSync(backupPath, raw, "utf-8");
            console.warn(
              TAG,
              `Corrupt store detected; copied original bytes to ${backupPath}`,
            );
          } catch (bakErr) {
            console.warn(
              TAG,
              `Corrupt store detected; failed to write ${backupPath}: ${bakErr?.message || bakErr}`,
            );
          }
        } else {
          console.warn(
            TAG,
            `Preserving prior good ${backupPath} (not overwriting with corrupt bytes)`,
          );
        }
        // Auto-recover from the most recent parseable backup before falling
        // back to an empty store. This includes monitor-backup-*, manual-bak-*,
        // bak-sync-*, .bak, etc.
        const recovered = findLatestGoodBackup(storePath);
        if (recovered) {
          console.warn(
            TAG,
            `Auto-recovered from backup ${recovered.path}`,
          );
          data = recovered.parsed;
        } else {
          throw parseErr;
        }
      }
      const normalizedTasks = {};
      const sourceTasks = data && data.tasks && typeof data.tasks === "object" ? data.tasks : {};
      for (const [taskId, taskValue] of Object.entries(sourceTasks)) {
        const resolvedId = String(taskValue?.id || taskId || "").trim();
        if (!resolvedId) continue;
        normalizedTasks[resolvedId] = normalizeTaskStructure({ ...taskValue, id: resolvedId });
        if (backfillTaskRunJournalsForTask(normalizedTasks[resolvedId])) {
          didBackfillTaskRunJournals = true;
        }
      }
      _store = {
        _meta: { ...defaultMeta(), ...(data._meta || {}), sprintOrderMode: resolveSprintOrderMode(data && data._meta ? data._meta.sprintOrderMode : null) },
        tasks: normalizedTasks,
        sprints: {},
      };
      for (const taskId of Object.keys(normalizedTasks)) {
        refreshTaskGraphTopology(taskId);
      }
      const sourceSprints = data && data.sprints && typeof data.sprints === "object" ? data.sprints : {};
      for (const [sprintId, sprintValue] of Object.entries(sourceSprints)) {
        const normalizedSprint = normalizeSprintStructure({ ...sprintValue, id: sprintId }, _store.sprints[sprintId] || null);
        if (!normalizedSprint) continue;
        _store.sprints[normalizedSprint.id] = normalizedSprint;
      }
      if (!_didLogInitialLoad) {
        _didLogInitialLoad = true;
        console.log(
          TAG,
          `Loaded ${Object.keys(_store.tasks).length} tasks from disk`,
        );
      }
      const loadedFingerprint = getStoreFingerprint();
      _lastLoadedMtimeMs = loadedFingerprint.mtimeMs;
      _lastLoadedSizeBytes = loadedFingerprint.sizeBytes;
    } else {
      _store = { _meta: defaultMeta(), tasks: {}, sprints: {} };
      console.log(TAG, "No store file found — initialised empty store");
      _lastLoadedMtimeMs = 0;
      _lastLoadedSizeBytes = 0;
    }
  } catch (err) {
    console.error(TAG, "Failed to load store, starting fresh:", err.message);
    _store = { _meta: defaultMeta(), tasks: {}, sprints: {} };
    _lastLoadedMtimeMs = 0;
    _lastLoadedSizeBytes = 0;
  }
  _loaded = true;
  if (didBackfillTaskRunJournals) {
    saveStore();
  }
}

/**
 * Persist store to disk (atomic write via tmp+rename).
 */
export function saveStore() {
  ensureLoaded();
  recalcStats();
  _writeDirty = true;
  if (_writeScheduled) return;
  _writeScheduled = true;

  _writeChain = _writeChain
    .then(() => {
      while (_writeDirty) {
        _writeDirty = false;
        try {
          const dir = dirname(storePath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          const json = JSON.stringify(_store, null, 2);
          writeFileSync(storeTmpPath, json, "utf-8");
          // Force the tmp file's data to physical storage BEFORE the rename.
          // Without this, on Windows a system crash between the rename and the
          // OS write-back can leave the destination as a zero-filled file the
          // size of the original allocation (`writeFileSync` returns once the
          // bytes are buffered, not once they are durable).
          try {
            const fd = openSync(storeTmpPath, "r+");
            try {
              fsyncSync(fd);
            } finally {
              closeSync(fd);
            }
          } catch (fsyncErr) {
            // fsync can fail on some FUSE / network filesystems; that's not
            // fatal, the file is still written, we just lose the durability
            // guarantee. Log once at warn level.
            console.warn(
              TAG,
              `fsync of ${storeTmpPath} failed (${fsyncErr?.message || fsyncErr}); proceeding without durability barrier`,
            );
          }
          try {
            renameSync(storeTmpPath, storePath);
          } catch (renameErr) {
            if (!ATOMIC_RENAME_FALLBACK_CODES.has(renameErr?.code)) {
              throw renameErr;
            }
            writeFileSync(storePath, json, "utf-8");
            try {
              unlinkSync(storeTmpPath);
            } catch {
              /* best effort */
            }
            console.warn(
              TAG,
              `Atomic rename failed (${renameErr?.message || renameErr}); fell back to direct write.`,
            );
          }
          const loadedFingerprint = getStoreFingerprint();
          _lastLoadedMtimeMs = loadedFingerprint.mtimeMs;
          _lastLoadedSizeBytes = loadedFingerprint.sizeBytes;
          try {
            syncTaskStoreToStateLedger(_store, { anchorPath: storePath });
          } catch (ledgerErr) {
            console.warn(TAG, "State ledger sync failed:", ledgerErr?.message || ledgerErr);
          }
        } catch (err) {
          console.error(TAG, "Failed to save store:", err.message);
        }
      }
    })
    .catch((err) => {
      console.error(TAG, "Write chain error:", err.message);
    })
    .finally(() => {
      _writeScheduled = false;
      if (_writeDirty) saveStore();
    });
}

/**
 * Await all queued writes. Intended for deterministic tests and maintenance code.
 */
export async function waitForStoreWrites() {
  ensureLoaded();
  try {
    await _writeChain;
  } catch {
    // saveStore already logs failures; caller just needs chain drain semantics
  }
}

/**
 * Return the resolved path of the store file.
 */
export function getStorePath() {
  return storePath;
}

function ensureSprintsMap() {
  if (!_store.sprints || typeof _store.sprints !== "object") {
    _store.sprints = {};
  }
  return _store.sprints;
}

function ensureEpicDependenciesMap() {
  if (!_store._meta || typeof _store._meta !== "object") {
    _store._meta = defaultMeta();
  }
  if (!_store._meta.epicDependencies || typeof _store._meta.epicDependencies !== "object") {
    _store._meta.epicDependencies = {};
  }
  const map = _store._meta.epicDependencies;
  for (const [key, value] of Object.entries(map)) {
    const epicId = String(key || "").trim();
    if (!epicId) {
      delete map[key];
      continue;
    }
    map[epicId] = uniqueStringList(Array.isArray(value) ? value : []);
  }
  return map;
}

export function listSprints() {
  ensureLoaded();
  const sprints = Object.values(ensureSprintsMap());
  return sprints.sort((a, b) => {
    const orderA = normalizeSprintOrder(a?.order);
    const orderB = normalizeSprintOrder(b?.order);
    if (orderA != null && orderB != null && orderA !== orderB) return orderA - orderB;
    if (orderA != null && orderB == null) return -1;
    if (orderA == null && orderB != null) return 1;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });
}

export function getSprint(sprintId) {
  ensureLoaded();
  const normalizedSprintId = normalizeSprintId(sprintId);
  if (!normalizedSprintId) return null;
  return ensureSprintsMap()[normalizedSprintId] ?? null;
}

export function upsertSprint(sprintData = {}, options = {}) {
  ensureLoaded();
  const sprints = ensureSprintsMap();
  const normalizedSprintId = normalizeSprintId(sprintData.id || options.sprintId);
  if (!normalizedSprintId) return null;
  const existing = sprints[normalizedSprintId] || null;
  const normalized = normalizeSprintStructure({ ...sprintData, id: normalizedSprintId }, existing);
  if (!normalized) return null;
  sprints[normalizedSprintId] = normalized;

  const syncTaskOrder = options.syncTaskOrder === true;
  const sprintTasks = getSprintTaskOrderSequence(normalizedSprintId);
  for (const [index, task] of sprintTasks.entries()) {
    if (!task) continue;
    if (!syncTaskOrder && task.sprintOrder != null) continue;
    task.sprintOrder = index + 1;
    markTaskTouched(task, "task-sprint");
  }

  saveStore();
  return { ...normalized };
}


export function createSprint(sprintData = {}, options = {}) {
  return upsertSprint(sprintData, options);
}

export function updateSprint(sprintId, sprintPatch = {}, options = {}) {
  const normalizedSprintId = normalizeSprintId(sprintId);
  if (!normalizedSprintId) return null;
  const existing = getSprint(normalizedSprintId);
  if (!existing) return null;
  const merged = {
    ...existing,
    ...(sprintPatch && typeof sprintPatch === "object" ? sprintPatch : {}),
    id: normalizedSprintId,
  };
  return upsertSprint(merged, options);
}

export function deleteSprint(sprintId, options = {}) {
  ensureLoaded();
  const normalizedSprintId = normalizeSprintId(sprintId);
  if (!normalizedSprintId) return false;
  const sprints = ensureSprintsMap();
  if (!sprints[normalizedSprintId]) return false;
  delete sprints[normalizedSprintId];

  const detachTasks = options.detachTasks !== false;
  if (detachTasks) {
    for (const task of Object.values(_store.tasks)) {
      if (!task || task.sprintId !== normalizedSprintId) continue;
      const previousSprintOrder = task.sprintOrder;
      task.sprintId = null;
      task.sprintOrder = null;
      pushTaskTimeline(task, {
        type: "task.sprint.removed",
        source: options.source || "task-sprint",
        message: `Removed from deleted sprint ${normalizedSprintId}`,
        payload: {
          sprintId: normalizedSprintId,
          previousSprintOrder,
        },
      });
      markTaskTouched(task, options.source || "task-sprint");
    }
  }

  saveStore();
  return true;
}

export function setSprintOrderMode(mode = "parallel") {
  ensureLoaded();
  _store._meta.sprintOrderMode = resolveSprintOrderMode(mode);
  saveStore();
  return _store._meta.sprintOrderMode;
}

export function getSprintOrderMode() {
  ensureLoaded();
  return resolveSprintOrderMode(_store._meta?.sprintOrderMode || "parallel");
}
// ---------------------------------------------------------------------------
// Core CRUD
// ---------------------------------------------------------------------------

/**
 * Get a single task by ID. Returns null if not found.
 */
export function getTask(taskId) {
  ensureLoaded();
  if (!taskId) return null;
  return _store.tasks[taskId] ?? null;
}

/**
 * Get all tasks as an array.
 */
export function getAllTasks() {
  ensureLoaded();
  return Object.values(_store.tasks);
}

/**
 * Get tasks filtered by status.
 */
export function getTasksByStatus(status) {
  ensureLoaded();
  return Object.values(_store.tasks).filter((t) => t.status === status);
}

/**
 * Partial update of a task. Auto-sets updatedAt and syncDirty.
 * Returns the updated task or null if not found.
 */
export function updateTask(taskId, updates) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) {
    console.warn(TAG, `updateTask: task ${taskId} not found`);
    return null;
  }

  const previousStatus = task.status;
  const patch = updates && typeof updates === "object" ? updates : {};
  const blockedKeys = new Set(["__proto__", "constructor", "prototype"]);
  const directPatchSetters = {
    title: (next) => { task.title = next; },
    description: (next) => { task.description = next; },
    externalStatus: (next) => { task.externalStatus = next; },
    externalId: (next) => { task.externalId = next; },
    externalBackend: (next) => { task.externalBackend = next; },
    assignee: (next) => { task.assignee = next; },
    priority: (next) => { task.priority = next; },
    projectId: (next) => { task.projectId = next; },
    workspace: (next) => { task.workspace = next; },
    repository: (next) => { task.repository = next; },
    repositories: (next) => { task.repositories = next; },
    worktreePath: (next) => { task.worktreePath = next; },
    baseBranch: (next) => { task.baseBranch = next; },
    branchName: (next) => { task.branchName = next; },
    prLinkage: (next) => { task.prLinkage = next; },
    prNumber: (next) => { task.prNumber = next; },
    prUrl: (next) => { task.prUrl = next; },
    epicId: (next) => { task.epicId = next; },
    parentTaskId: (next) => { task.parentTaskId = next; },
    stateVersion: (next) => { task.stateVersion = next; },
    createdAt: (next) => { task.createdAt = next; },
    updatedAt: (next) => { task.updatedAt = next; },
    lastActivityAt: (next) => { task.lastActivityAt = next; },
    statusHistory: (next) => { task.statusHistory = next; },
    agentAttempts: (next) => { task.agentAttempts = next; },
    consecutiveNoCommits: (next) => { task.consecutiveNoCommits = next; },
    errorPattern: (next) => { task.errorPattern = next; },
    reviewStatus: (next) => { task.reviewStatus = next; },
    reviewIssues: (next) => { task.reviewIssues = next; },
    reviewedAt: (next) => { task.reviewedAt = next; },
    cooldownUntil: (next) => { task.cooldownUntil = next; },
    blockedReason: (next) => { task.blockedReason = next; },
    lastSyncedAt: (next) => { task.lastSyncedAt = next; },
    syncDirty: (next) => { task.syncDirty = next; },
    meta: (next) => { task.meta = next; },
    topology: (next) => {
      const patchValue =
        next && typeof next === "object" && !Array.isArray(next)
          ? next
          : {};
      task.topology = { ...(task.topology || {}), ...patchValue };
    },
  };

  for (const [key, value] of Object.entries(patch)) {
    if (key === "id") continue;
    if (blockedKeys.has(key)) continue;
    if (key === "lastAgentOutput") {
      task.lastAgentOutput = truncate(value, MAX_AGENT_OUTPUT);
      continue;
    }
    if (key === "lastError") {
      task.lastError = truncate(value, MAX_ERROR_LENGTH);
      continue;
    }
    if (key === "tags") {
      task.tags = normalizeTags(value);
      continue;
    }
    if (key === "attachments") {
      task.attachments = normalizeTaskAttachments(value, {
        kind: `task:${taskId}:attachments`,
      });
      continue;
    }
    if (key === "status") {
      task.status = resolveProtectedTaskStatus(task, value, patch);
      continue;
    }
    if (key === "type") {
      task.type = normalizeTaskType(value);
      continue;
    }
    if (key === "sprintId") {
      task.sprintId = normalizeSprintId(value);
      continue;
    }
    if (key === "sprintOrder") {
      task.sprintOrder = normalizeSprintOrder(value);
      continue;
    }
    if (key === "comments") {
      task.comments = normalizeTaskComments(value);
      continue;
    }
    if (key === "timeline") {
      task.timeline = normalizeTimelineEvents(value);
      continue;
    }
    if (key === "workflowRuns") {
      task.workflowRuns = normalizeWorkflowRunLinks(value);
      continue;
    }
    if (key === "runs") {
      task.runs = normalizeTaskRuns(value).map((run) => persistTaskRunJournalRef(taskId, run));
      continue;
    }
    if (key === "assignees") { task.assignees = uniqueStringList(value); continue; }
    if (key === "watchers") { task.watchers = uniqueStringList(value); continue; }
    if (key === "childTaskIds") { task.childTaskIds = uniqueStringList(value); continue; }
    if (key === "dependencyTaskIds") { task.dependencyTaskIds = uniqueStringList(value); continue; }
    if (key === "blockedByTaskIds") { task.blockedByTaskIds = uniqueStringList(value); continue; }
    if (key === "dependsOn") { task.dependsOn = uniqueStringList(value); continue; }
    if (key === "links") {
      const links = value && typeof value === "object" ? value : {};
      task.links = {
        branches: uniqueStringList(links.branches || task.links?.branches || []),
        prs: uniqueStringList(links.prs || task.links?.prs || []),
        workflows: uniqueStringList(links.workflows || task.links?.workflows || []),
      };
      continue;
    }
    const applyDirectPatch = directPatchSetters[key];
    if (typeof applyDirectPatch === "function") {
      applyDirectPatch(value);
    }
  }

  if (typeof patch.draft === "boolean") {
    task.draft = patch.draft;
    if (patch.draft && task.status !== "draft") {
      task.status = "draft";
    } else if (!patch.draft && task.status === "draft") {
      task.status = "todo";
    }
  }
  if (task.status === "draft") {
    task.draft = true;
  } else if (task.draft && patch.draft == null) {
    task.draft = false;
  }

  const normalizedTask = normalizeTaskStructure(task);
  _store.tasks[taskId] = normalizedTask;
  markTaskTouched(normalizedTask, "task-store");

  if (previousStatus !== normalizedTask.status) {
    normalizedTask.statusHistory.push({
      status: normalizedTask.status,
      timestamp: now(),
      source: "update",
    });
    if (normalizedTask.statusHistory.length > MAX_STATUS_HISTORY) {
      normalizedTask.statusHistory = normalizedTask.statusHistory.slice(-MAX_STATUS_HISTORY);
    }
    pushTaskTimeline(normalizedTask, {
      type: "status.transition",
      source: "updateTask",
      fromStatus: previousStatus,
      toStatus: normalizedTask.status,
      status: normalizedTask.status,
      action: "update",
      message: `Status updated ${previousStatus} -> ${normalizedTask.status}`,
    });
  }

  saveStore();
  return { ...normalizedTask };
}

/**
 * Add a new task to the store. Sets createdAt.
 * Returns the created task.
 */
export function addTask(taskData) {
  ensureLoaded();
  const task = normalizeTaskStructure(defaultTask(taskData));
  if (!task.id) {
    console.error(TAG, "addTask: task must have an id");
    return null;
  }

  task.tags = normalizeTags(task.tags);
  if (Array.isArray(task.runs) && task.runs.length > 0) {
    task.runs = normalizeTaskRuns(task.runs).map((run) => persistTaskRunJournalRef(task.id, run));
  }
  task.draft = Boolean(task.draft || task.status === "draft");
  if (task.draft) task.status = "draft";
  task.lastAgentOutput = truncate(task.lastAgentOutput, MAX_AGENT_OUTPUT);
  task.lastError = truncate(task.lastError, MAX_ERROR_LENGTH);
  pushTaskTimeline(task, {
    type: "task.created",
    source: "task-store",
    status: task.status,
    message: `Task created with status ${task.status}`,
  });

  _store.tasks[task.id] = task;

  if (task.parentTaskId && _store.tasks[task.parentTaskId]) {
    const parent = _store.tasks[task.parentTaskId];
    parent.childTaskIds = uniqueStringList([...(parent.childTaskIds || []), task.id]);
    markTaskTouched(parent, "task-graph");
  }
  refreshTaskGraphTopology(task.id);
  for (const dependencyId of task.dependencyTaskIds || []) {
    const dependency = _store.tasks[dependencyId];
    if (!dependency) continue;
    dependency.blockedByTaskIds = uniqueStringList([...(dependency.blockedByTaskIds || []), task.id]);
    markTaskTouched(dependency, "task-graph");
  }

  console.log(TAG, `Added task ${task.id}: ${task.title}`);

  saveStore();
  return { ...task };
}

/**
 * Remove a task from the store. Returns true if removed, false if not found.
 */
export function removeTask(taskId) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) return false;

  for (const candidate of Object.values(_store.tasks)) {
    if (!candidate || candidate.id === taskId) continue;
    const beforeChildren = candidate.childTaskIds?.length || 0;
    const beforeDeps = candidate.dependencyTaskIds?.length || 0;
    candidate.childTaskIds = uniqueStringList((candidate.childTaskIds || []).filter((id) => id !== taskId));
    candidate.dependencyTaskIds = uniqueStringList((candidate.dependencyTaskIds || []).filter((id) => id !== taskId));
    candidate.dependsOn = uniqueStringList((candidate.dependsOn || []).filter((id) => id !== taskId));
    if (beforeChildren !== candidate.childTaskIds.length || beforeDeps !== candidate.dependencyTaskIds.length) {
      markTaskTouched(candidate, "task-store");
      pushTaskTimeline(candidate, {
        type: "task.graph.updated",
        source: "task-store",
        message: `Removed references to deleted task ${taskId}`,
        payload: { removedTaskId: taskId },
      });
    }
  }

  delete _store.tasks[taskId];
  console.log(TAG, `Removed task ${taskId}`);
  saveStore();
  return true;
}

// ---------------------------------------------------------------------------
// Status management
// ---------------------------------------------------------------------------

/**
 * Set task status with source tracking. Appends to statusHistory.
 * source: "agent" | "orchestrator" | "external" | "review"
 */
export function setTaskStatus(taskId, status, source) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) {
    console.warn(TAG, `setTaskStatus: task ${taskId} not found`);
    return null;
  }

  const prev = normalizeTaskStatus(task.status);
  const next = resolveProtectedTaskStatus(task, status);
  const tsNow = now();
  task.status = next;
  task.updatedAt = tsNow;
  task.lastActivityAt = tsNow;

  // No-op transition: keep activity fresh without polluting history/logs.
  if (prev === next) {
    saveStore();
    return { ...task };
  }

  task.statusHistory.push({
    status: next,
    timestamp: tsNow,
    source: source || "unknown",
  });
  if (task.statusHistory.length > MAX_STATUS_HISTORY) {
    task.statusHistory = task.statusHistory.slice(-MAX_STATUS_HISTORY);
  }

  if (source !== "external") {
    task.syncDirty = true;
  }

  pushTaskTimeline(task, {
    type: "status.transition",
    source: source || "unknown",
    fromStatus: prev,
    toStatus: next,
    status: next,
    action: "set_status",
    message: `Task status changed ${prev} -> ${next}`,
  });

  console.log(
    TAG,
    `Task ${taskId} status: ${prev} → ${next} (source: ${source})`,
  );

  saveStore();
  return { ...task };
}

export function unblockTask(taskId, options = {}) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) {
    console.warn(TAG, `unblockTask: task ${taskId} not found`);
    return null;
  }

  const previousStatus = normalizeTaskStatus(task.status);
  const nextStatus = normalizeTaskStatus(
    options.status || options.targetStatus || "todo",
  );
  const timestamp = now();
  task.status = nextStatus;
  task.cooldownUntil = null;
  task.blockedReason = null;
  if (task.meta && typeof task.meta === "object") {
    const nextMeta = { ...task.meta };
    delete nextMeta.autoRecovery;
    delete nextMeta.worktreeFailure;
    delete nextMeta.blockedReason;
    task.meta = nextMeta;
  }
  task.updatedAt = timestamp;
  task.lastActivityAt = timestamp;
  task.syncDirty = options.source !== "external";

  if (previousStatus !== nextStatus) {
    task.statusHistory.push({
      status: nextStatus,
      timestamp,
      source: options.source || "manual-unblock",
    });
    if (task.statusHistory.length > MAX_STATUS_HISTORY) {
      task.statusHistory = task.statusHistory.slice(-MAX_STATUS_HISTORY);
    }
  }

  pushTaskTimeline(task, {
    type: "task.unblocked",
    source: options.source || "manual-unblock",
    fromStatus: previousStatus,
    toStatus: nextStatus,
    status: nextStatus,
    action: "unblock_task",
    message: `Cleared blocked state and moved task to ${nextStatus}`,
  });

  saveStore();
  return { ...task };
}

export function validateTaskStatusTransition(currentStatus, nextStatus, options = {}) {
  return validateTaskTransition(currentStatus, nextStatus, options);
}

export function transitionTaskLifecycle(taskId, action, options = {}) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) {
    console.warn(TAG, `transitionTaskLifecycle: task ${taskId} not found`);
    return { ok: false, error: "task_not_found", task: null };
  }

  const normalizedAction = String(action || "").trim().toLowerCase();
  const shouldGuardStart = normalizedAction === "start" || normalizedAction === "resume";
  const overrideStartGuard = options.force === true
    || options.forceStart === true
    || options.manualOverride === true
    || options.overrideStartGuard === true;
  if (shouldGuardStart && !overrideStartGuard) {
    const canStart = canTaskStart(taskId, options);
    if (!canStart.canStart) {
      return {
        ok: false,
        error: "start_guard_blocked",
        reason: canStart.reason,
        action: normalizedAction,
        canStart,
        task: { ...task },
      };
    }
  }
  const targetStatus =
    normalizeTaskStatus(options.targetStatus || options.status || LIFECYCLE_ACTION_TARGET[normalizedAction] || "");
  if (!targetStatus) {
    return { ok: false, error: "unknown_action", action: normalizedAction, task: { ...task } };
  }

  const completionGuard = evaluateTaskCompletionGuard(task, {
    action: normalizedAction,
    targetStatus,
    force: options.force === true,
    manualOverride: options.manualOverride === true,
    patch: options.patch && typeof options.patch === "object" ? options.patch : null,
  });
  if (completionGuard) {
    recordLifecycleGuardBlock(task, normalizedAction, completionGuard, {
      ...options,
      targetStatus,
    });
    return {
      ok: false,
      error: completionGuard.error,
      reason: completionGuard.reason,
      message: completionGuard.message,
      guard: completionGuard,
      action: normalizedAction,
      fromStatus: task.status,
      toStatus: targetStatus,
      task: { ...task },
    };
  }

  const validation = validateTaskTransition(task.status, targetStatus, options);
  if (!validation.valid) {
    return {
      ok: false,
      error: validation.reason,
      action: normalizedAction,
      fromStatus: validation.fromStatus,
      toStatus: validation.toStatus,
      task: { ...task },
    };
  }


  const previousStatus = task.status;
  const updated = setTaskStatus(taskId, targetStatus, options.source || "lifecycle");
  const resolved = _store.tasks[taskId];
  if (resolved) {
    pushTaskTimeline(resolved, {
      type: "lifecycle.transition",
      source: options.source || "lifecycle",
      action: normalizedAction || "transition",
      fromStatus: previousStatus,
      toStatus: targetStatus,
      status: targetStatus,
      message: options.reason ? String(options.reason) : `Lifecycle action ${normalizedAction || "transition"}`,
      actor: options.actor != null ? String(options.actor) : null,
      payload: options.payload && typeof options.payload === "object" ? options.payload : null,
    });
    saveStore();
  }

  return {
    ok: true,
    action: normalizedAction,
    fromStatus: previousStatus,
    toStatus: targetStatus,
    task: updated,
  };
}

export function startTask(taskId, options = {}) {
  return transitionTaskLifecycle(taskId, "start", options);
}

export function pauseTask(taskId, options = {}) {
  return transitionTaskLifecycle(taskId, "pause", options);
}

export function resumeTask(taskId, options = {}) {
  return transitionTaskLifecycle(taskId, "resume", options);
}

export function completeTask(taskId, options = {}) {
  return transitionTaskLifecycle(taskId, "complete", options);
}

export function cancelTask(taskId, options = {}) {
  return transitionTaskLifecycle(taskId, "cancel", options);
}

export function blockTask(taskId, options = {}) {
  return transitionTaskLifecycle(taskId, "block", options);
}

/**
 * Get the status history for a task.
 */
export function getTaskHistory(taskId) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) return [];
  return [...task.statusHistory];
}

export function getTaskTimeline(taskId) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) return [];
  return Array.isArray(task.timeline) ? [...task.timeline] : [];
}

export function appendTaskTimelineEvent(taskId, event = {}) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) return null;
  const normalizedEvent = createTimelineEvent(event);
  pushTaskTimeline(task, normalizedEvent);
  markTaskTouched(task, event?.source || "task-store");
  saveStore();
  return normalizedEvent;
}

export function getTaskRuns(taskId) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) return [];
  return Array.isArray(task.runs) ? [...task.runs] : [];
}

export function appendTaskRun(taskId, run = {}) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) return null;
  const nextRun = persistTaskRunJournalRef(taskId, normalizeTaskRuns([run])[0] || null);
  if (!nextRun) return null;
  task.runs = normalizeTaskRuns([...(Array.isArray(task.runs) ? task.runs : []), nextRun]);
  markTaskTouched(task, run?.source || "task-run");
  saveStore();
  return nextRun;
}

export function addTaskComment(taskId, comment = {}) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) return null;
  const appended = normalizeTaskComments([comment]);
  if (appended.length === 0) return null;
  const nextComment = appended[0];
  task.comments = normalizeTaskComments([...(Array.isArray(task.comments) ? task.comments : []), nextComment]);
  pushTaskTimeline(task, {
    type: "task.comment",
    source: nextComment.source || "comment",
    actor: nextComment.author,
    message: nextComment.body,
    payload: { commentId: nextComment.id },
  });
  markTaskTouched(task, nextComment.source || "comment");
  saveStore();
  return nextComment;
}

export function getTaskComments(taskId) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) return [];
  return normalizeTaskComments(task.comments || []);
}

export function linkTaskWorkflowRun(taskId, workflowRun = {}) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) return null;
  const normalized = normalizeWorkflowRunLinks([workflowRun]);
  if (normalized.length === 0) return null;
  const incomingRun = normalized[0];
  const existing = Array.isArray(task.workflowRuns) ? task.workflowRuns : [];
  const current = existing.find((entry) => String(entry?.runId || "") === incomingRun.runId) || null;
  const run = current ? mergeWorkflowRunLink(current, incomingRun) : incomingRun;
  const dedup = existing.filter((entry) => String(entry?.runId || "") !== run.runId);
  const nextWorkflowRuns = normalizeWorkflowRunLinks([...dedup, run]);
  task.workflowRuns = nextWorkflowRuns;
  const shouldPromoteLatest = shouldPromoteLatestWorkflowRun(task, run, nextWorkflowRuns);
  const nextLatestNodeId = resolveLatestWorkflowNodeId(task, run, shouldPromoteLatest);
  task.topology = normalizeTaskTopology({
    ...(task.topology && typeof task.topology === "object" ? task.topology : {}),
    workflowId: shouldPromoteLatest ? (run.workflowId || task.topology?.workflowId || null) : (task.topology?.workflowId || run.workflowId || null),
    workflowName: shouldPromoteLatest ? (run.workflowName || task.topology?.workflowName || null) : (task.topology?.workflowName || run.workflowName || null),
    latestNodeId: nextLatestNodeId,
    latestRunId: shouldPromoteLatest ? run.runId : (task.topology?.latestRunId || task.latestRunId || run.runId),
    rootRunId: shouldPromoteLatest ? (run.rootRunId || task.topology?.rootRunId || null) : (task.topology?.rootRunId || run.rootRunId || null),
    parentRunId: shouldPromoteLatest ? (run.parentRunId || task.topology?.parentRunId || null) : (task.topology?.parentRunId || run.parentRunId || null),
    latestSessionId: shouldPromoteLatest ? (run.sessionId || task.topology?.latestSessionId || null) : (task.topology?.latestSessionId || run.sessionId || null),
    sessionId: shouldPromoteLatest ? (run.sessionId || task.topology?.sessionId || null) : (task.topology?.sessionId || run.sessionId || null),
    rootSessionId: shouldPromoteLatest ? (run.rootSessionId || task.topology?.rootSessionId || null) : (task.topology?.rootSessionId || run.rootSessionId || null),
    parentSessionId: shouldPromoteLatest ? (run.parentSessionId || task.topology?.parentSessionId || null) : (task.topology?.parentSessionId || run.parentSessionId || null),
    rootTaskId: shouldPromoteLatest ? (run.rootTaskId || task.topology?.rootTaskId || task.id || null) : (task.topology?.rootTaskId || run.rootTaskId || task.id || null),
    parentTaskId: shouldPromoteLatest ? (run.parentTaskId || task.topology?.parentTaskId || task.parentTaskId || null) : (task.topology?.parentTaskId || run.parentTaskId || task.parentTaskId || null),
    delegationDepth: Number.isFinite(Number(run.delegationDepth))
      ? Math.max(0, Math.trunc(Number(run.delegationDepth)))
      : (task.topology?.delegationDepth || 0),
  }, task);
  syncLegacyTaskTopologyFields(task);
  task.links = {
    branches: uniqueStringList(task.links?.branches || []),
    prs: uniqueStringList(task.links?.prs || []),
    workflows: uniqueStringList([...(task.links?.workflows || []), ...(run.workflowId ? [run.workflowId] : [])]),
  };
  pushTaskTimeline(task, {
    type: "workflow.run.linked",
    source: run.source || "workflow",
    status: run.status,
    message: run.summary || `Linked workflow run ${run.runId}`,
    payload: { runId: run.runId, workflowId: run.workflowId, outcome: run.outcome },
  });
  markTaskTouched(task, "workflow");
  saveStore();
  return run;
}

export function setTaskParent(taskId, parentTaskId, options = {}) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) return null;
  const parentId = String(parentTaskId || "").trim() || null;
  if (parentId && !_store.tasks[parentId]) return null;

  const previousParentId = task.parentTaskId || null;
  if (previousParentId && _store.tasks[previousParentId]) {
    const previousParent = _store.tasks[previousParentId];
    previousParent.childTaskIds = uniqueStringList((previousParent.childTaskIds || []).filter((id) => id !== taskId));
    markTaskTouched(previousParent, "task-graph");
  }

  task.parentTaskId = parentId;
  if (parentId) {
    const parent = _store.tasks[parentId];
    parent.childTaskIds = uniqueStringList([...(parent.childTaskIds || []), taskId]);
    markTaskTouched(parent, "task-graph");
    if (task.type === "task") {
      task.type = "subtask";
    }
  }
  refreshTaskGraphTopology(taskId);

  pushTaskTimeline(task, {
    type: "task.graph.parent",
    source: options.source || "task-graph",
    message: parentId ? `Parent set to ${parentId}` : "Parent removed",
    payload: { previousParentId, parentTaskId: parentId },
  });
  markTaskTouched(task, options.source || "task-graph");
  saveStore();
  return { ...task };
}

export function addTaskDependency(taskId, dependencyTaskId, options = {}) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) return null;
  const dependencyId = String(dependencyTaskId || "").trim();
  if (!dependencyId || !_store.tasks[dependencyId] || dependencyId === taskId) return null;
  task.dependencyTaskIds = uniqueStringList([...(task.dependencyTaskIds || []), dependencyId]);
  task.dependsOn = uniqueStringList([...(task.dependsOn || []), dependencyId]);
  const dependency = _store.tasks[dependencyId];
  dependency.blockedByTaskIds = uniqueStringList([...(dependency.blockedByTaskIds || []), taskId]);
  pushTaskTimeline(task, {
    type: "task.graph.dependency",
    source: options.source || "task-graph",
    message: `Depends on ${dependencyId}`,
    payload: { dependencyTaskId: dependencyId },
  });
  markTaskTouched(task, options.source || "task-graph");
  markTaskTouched(dependency, options.source || "task-graph");
  saveStore();
  return { ...task };
}

export function removeTaskDependency(taskId, dependencyTaskId, options = {}) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) return null;
  const dependencyId = String(dependencyTaskId || "").trim();
  if (!dependencyId) return { ...task };
  task.dependencyTaskIds = uniqueStringList((task.dependencyTaskIds || []).filter((id) => id !== dependencyId));
  task.dependsOn = uniqueStringList((task.dependsOn || []).filter((id) => id !== dependencyId));
  const dependency = _store.tasks[dependencyId];
  if (dependency) {
    dependency.blockedByTaskIds = uniqueStringList((dependency.blockedByTaskIds || []).filter((id) => id !== taskId));
    markTaskTouched(dependency, options.source || "task-graph");
  }
  pushTaskTimeline(task, {
    type: "task.graph.dependency.removed",
    source: options.source || "task-graph",
    message: `Dependency removed ${dependencyId}`,
    payload: { dependencyTaskId: dependencyId },
  });
  markTaskTouched(task, options.source || "task-graph");
  saveStore();
  return { ...task };
}

export function assignTaskToSprint(taskId, sprintId, options = {}) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) return null;

  const sprints = ensureSprintsMap();
  const normalizedSprintId = normalizeSprintId(sprintId);
  if (normalizedSprintId && !sprints[normalizedSprintId]) {
    console.warn(TAG, `assignTaskToSprint: sprint ${normalizedSprintId} not found`);
    return null;
  }

  const previousSprintId = task.sprintId;
  const previousSprintOrder = task.sprintOrder;
  const explicitSprintOrder = normalizeSprintOrder(options.sprintOrder ?? options.order);

  task.sprintId = normalizedSprintId;
  if (!normalizedSprintId) {
    task.sprintOrder = null;
  } else if (explicitSprintOrder != null) {
    task.sprintOrder = explicitSprintOrder;
  } else if (previousSprintId === normalizedSprintId && task.sprintOrder != null) {
    task.sprintOrder = normalizeSprintOrder(task.sprintOrder);
  } else {
    task.sprintOrder = getNextSprintTaskOrder(normalizedSprintId);
  }

  pushTaskTimeline(task, {
    type: "task.sprint.assigned",
    source: options.source || "task-sprint",
    message: normalizedSprintId
      ? `Assigned to sprint ${normalizedSprintId}`
      : "Removed from sprint",
    payload: {
      previousSprintId,
      previousSprintOrder,
      sprintId: task.sprintId,
      sprintOrder: task.sprintOrder,
    },
  });

  markTaskTouched(task, options.source || "task-sprint");
  saveStore();
  return { ...task };
}

function buildTaskDagGraph(options = {}) {
  ensureLoaded();
  const sprintFilter = normalizeSprintId(options.sprintId);
  const scopedTasks = Object.values(_store.tasks)
    .filter((task) => (sprintFilter ? task.sprintId === sprintFilter : true))
    .sort(compareTaskDagOrder);

  const nodeMap = new Map();
  const indegree = new Map();
  const adjacency = new Map();
  const externalDependencyMap = {};
  const missingDependencyMap = {};

  for (const task of scopedTasks) {
    nodeMap.set(task.id, task);
    indegree.set(task.id, 0);
    adjacency.set(task.id, []);
    externalDependencyMap[task.id] = [];
    missingDependencyMap[task.id] = [];
  }

  const edges = [];
  for (const task of scopedTasks) {
    const dependencyIds = listTaskDependencyIds(task);
    for (const dependencyId of dependencyIds) {
      if (!dependencyId || dependencyId === task.id) continue;
      if (nodeMap.has(dependencyId)) {
        edges.push({ from: dependencyId, to: task.id });
        adjacency.get(dependencyId).push(task.id);
        indegree.set(task.id, (indegree.get(task.id) || 0) + 1);
        continue;
      }
      if (_store.tasks[dependencyId]) {
        externalDependencyMap[task.id].push(dependencyId);
      } else {
        missingDependencyMap[task.id].push(dependencyId);
      }
    }
  }

  const visited = new Set();
  const levels = [];
  let frontier = [...indegree.entries()]
    .filter(([, value]) => value === 0)
    .map(([taskId]) => taskId)
    .sort((a, b) => compareTaskDagOrder(nodeMap.get(a), nodeMap.get(b)));

  while (frontier.length) {
    const level = [];
    const upcoming = [];
    for (const taskId of frontier) {
      if (visited.has(taskId)) continue;
      visited.add(taskId);
      level.push(taskId);
      for (const childId of adjacency.get(taskId) || []) {
        indegree.set(childId, (indegree.get(childId) || 0) - 1);
        if ((indegree.get(childId) || 0) === 0) {
          upcoming.push(childId);
        }
      }
    }
    if (level.length) {
      levels.push(level.sort((a, b) => compareTaskDagOrder(nodeMap.get(a), nodeMap.get(b))));
    }
    frontier = uniqueStringList(upcoming).filter((taskId) => !visited.has(taskId));
    frontier.sort((a, b) => compareTaskDagOrder(nodeMap.get(a), nodeMap.get(b)));
  }

  const cycleTaskIds = [...indegree.entries()]
    .filter(([, value]) => value > 0)
    .map(([taskId]) => taskId)
    .sort((a, b) => compareTaskDagOrder(nodeMap.get(a), nodeMap.get(b)));

  return {
    sprintId: sprintFilter,
    nodeCount: scopedTasks.length,
    edgeCount: edges.length,
    hasCycle: cycleTaskIds.length > 0,
    cycleTaskIds,
    levels,
    nodes: scopedTasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      sprintId: task.sprintId,
      sprintOrder: task.sprintOrder,
      dependencyTaskIds: listTaskDependencyIds(task),
      externalDependencyTaskIds: uniqueStringList(externalDependencyMap[task.id] || []),
      missingDependencyTaskIds: uniqueStringList(missingDependencyMap[task.id] || []),
    })),
    edges,
  };
}

export function getTaskDag(options = {}) {
  return buildTaskDagGraph(options);
}


export function getSprintDag(sprintId) {
  const normalizedSprintId = normalizeSprintId(sprintId);
  if (!normalizedSprintId) return buildTaskDagGraph({});
  return buildTaskDagGraph({ sprintId: normalizedSprintId });
}

export function getGlobalDagOfDags() {
  ensureLoaded();
  const sprintMap = ensureSprintsMap();
  const sprintNodes = new Map();

  for (const sprint of listSprints()) {
    sprintNodes.set(sprint.id, {
      id: sprint.id,
      label: sprint.name || sprint.id,
      sprintId: sprint.id,
      order: normalizeSprintOrder(sprint.order),
      executionMode: resolveSprintOrderMode(sprint.executionMode || sprint.taskOrderMode),
      status: sprint.status || "planned",
      taskIds: [],
      taskCount: 0,
      doneCount: 0,
      activeCount: 0,
      blockedCount: 0,
      completion: 0,
    });
  }

  for (const task of Object.values(_store.tasks)) {
    const sprintId = normalizeSprintId(task?.sprintId);
    if (!sprintId) continue;
    if (!sprintNodes.has(sprintId)) {
      sprintNodes.set(sprintId, {
        id: sprintId,
        label: sprintId,
        sprintId,
        order: null,
        executionMode: "parallel",
        status: "active",
        taskIds: [],
        taskCount: 0,
        doneCount: 0,
        activeCount: 0,
        blockedCount: 0,
        completion: 0,
      });
    }
    const node = sprintNodes.get(sprintId);
    node.taskIds.push(task.id);
    node.taskCount += 1;
    if (isTaskTerminal(task)) node.doneCount += 1;
    if (normalizeTaskStatus(task?.status) === "blocked") node.blockedCount += 1;
    if (normalizeLifecycleState(task?.status) === "inprogress") node.activeCount += 1;
  }

  const edgePairs = new Map();
  for (const task of Object.values(_store.tasks)) {
    const targetSprintId = normalizeSprintId(task?.sprintId);
    if (!targetSprintId) continue;
    for (const dependencyId of listTaskDependencyIds(task)) {
      const dependency = _store.tasks[dependencyId];
      const sourceSprintId = normalizeSprintId(dependency?.sprintId);
      if (!sourceSprintId || sourceSprintId === targetSprintId) continue;
      const key = `${sourceSprintId}->${targetSprintId}`;
      if (!edgePairs.has(key)) edgePairs.set(key, { from: sourceSprintId, to: targetSprintId, taskLinks: [] });
      edgePairs.get(key).taskLinks.push({ fromTaskId: dependencyId, toTaskId: task.id, type: "dependency" });
    }
  }

  const mode = resolveSprintOrderMode(_store._meta?.sprintOrderMode || "parallel");
  if (mode === "sequential") {
    const ordered = [...sprintNodes.values()]
      .filter((node) => node.order != null)
      .sort((a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id)));
    for (let i = 1; i < ordered.length; i += 1) {
      const from = ordered[i - 1];
      const to = ordered[i];
      const key = `${from.id}->${to.id}`;
      if (!edgePairs.has(key)) edgePairs.set(key, { from: from.id, to: to.id, taskLinks: [] });
      edgePairs.get(key).taskLinks.push({ type: "sequence" });
    }
  }

  const nodes = [...sprintNodes.values()]
    .map((node) => ({
      ...node,
      taskIds: uniqueStringList(node.taskIds),
      taskCount: node.taskCount,
      completion: node.taskCount > 0 ? Math.round((node.doneCount / node.taskCount) * 1000) / 1000 : 0,
    }))
    .sort((a, b) => {
      if (a.order != null && b.order != null && a.order !== b.order) return a.order - b.order;
      if (a.order != null && b.order == null) return -1;
      if (a.order == null && b.order != null) return 1;
      return String(a.id).localeCompare(String(b.id));
    });

  const edges = [...edgePairs.values()]
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      linkCount: edge.taskLinks.length,
      taskLinks: edge.taskLinks,
    }))
    .sort((a, b) => {
      const fromCmp = String(a.from).localeCompare(String(b.from));
      if (fromCmp !== 0) return fromCmp;
      return String(a.to).localeCompare(String(b.to));
    });

  const epicDependencies = getEpicDependencies();

  return {
    sprintOrderMode: mode,
    sprintCount: nodes.length,
    edgeCount: edges.length,
    epicDependencies,
    nodes,
    edges: edges.map((edge) => ({
      ...edge,
      kind: edge.taskLinks.some((link) => link?.type === 'sequence') ? 'sequential' : 'dependency',
    })),
  };
}

export function getDagOfDags() {
  return getGlobalDagOfDags();
}

export function getEpicDependencies() {
  ensureLoaded();
  const map = ensureEpicDependenciesMap();
  return Object.entries(map).map(([epicId, dependencies]) => ({
    epicId,
    dependencies: uniqueStringList(Array.isArray(dependencies) ? dependencies : []),
  }));
}

export function setEpicDependencies(epicId, dependencies = []) {
  ensureLoaded();
  const normalizedEpicId = String(epicId || '').trim();
  if (!normalizedEpicId) return null;
  const cleaned = uniqueStringList((Array.isArray(dependencies) ? dependencies : [])
    .map((entry) => String(entry || '').trim())
    .filter((entry) => entry && entry !== normalizedEpicId));
  const map = ensureEpicDependenciesMap();
  if (cleaned.length > 0) map[normalizedEpicId] = cleaned;
  else delete map[normalizedEpicId];
  saveStore();
  return { epicId: normalizedEpicId, dependencies: [...(map[normalizedEpicId] || [])] };
}

export function addEpicDependency(epicId, dependencyEpicId) {
  ensureLoaded();
  const normalizedEpicId = String(epicId || '').trim();
  const normalizedDependency = String(dependencyEpicId || '').trim();
  if (!normalizedEpicId || !normalizedDependency || normalizedEpicId === normalizedDependency) return null;
  const map = ensureEpicDependenciesMap();
  const next = uniqueStringList([...(map[normalizedEpicId] || []), normalizedDependency]);
  map[normalizedEpicId] = next;
  saveStore();
  return { epicId: normalizedEpicId, dependencies: [...next] };
}

export function removeEpicDependency(epicId, dependencyEpicId) {
  ensureLoaded();
  const normalizedEpicId = String(epicId || '').trim();
  const normalizedDependency = String(dependencyEpicId || '').trim();
  if (!normalizedEpicId || !normalizedDependency) return null;
  const map = ensureEpicDependenciesMap();
  const next = uniqueStringList((map[normalizedEpicId] || []).filter((entry) => entry !== normalizedDependency));
  if (next.length > 0) map[normalizedEpicId] = next;
  else delete map[normalizedEpicId];
  saveStore();
  return { epicId: normalizedEpicId, dependencies: [...(map[normalizedEpicId] || [])] };
}

export function canStartTask(taskId, options = {}) {
  return canTaskStart(taskId, options);
}
export function canTaskStart(taskId, options = {}) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  const sprintOrderMode = resolveSprintOrderMode(options.sprintOrderMode || _store._meta?.sprintOrderMode);

  if (!task) {
    return {
      canStart: false,
      reason: "task_not_found",
      blockingTaskIds: [],
      missingDependencyTaskIds: [],
      blockingSprintIds: [],
      blockingEpicIds: [],
      sprintOrderMode,
    };
  }

  if (isTaskTerminal(task)) {
    return {
      canStart: false,
      reason: "task_terminal",
      blockingTaskIds: [],
      missingDependencyTaskIds: [],
      blockingSprintIds: [],
      blockingEpicIds: [],
      sprintOrderMode,
    };
  }

  const blockingTaskIds = [];
  const missingDependencyTaskIds = [];
  for (const dependencyId of listTaskDependencyIds(task)) {
    const dependencyTask = _store.tasks[dependencyId];
    if (!dependencyTask) {
      missingDependencyTaskIds.push(dependencyId);
      continue;
    }
    if (!isTaskTerminal(dependencyTask)) {
      blockingTaskIds.push(dependencyId);
    }
  }

  if (blockingTaskIds.length || missingDependencyTaskIds.length) {
    return {
      canStart: false,
      reason: "dependencies_unresolved",
      blockingTaskIds: uniqueStringList(blockingTaskIds),
      missingDependencyTaskIds: uniqueStringList(missingDependencyTaskIds),
      blockingSprintIds: [],
      blockingEpicIds: [],
      sprintOrderMode,
    };
  }

  const blockingSprintIds = [];
  const sprintId = normalizeSprintId(task.sprintId);
  const sprint = sprintId ? ensureSprintsMap()[sprintId] : null;
  const sprintTaskOrderMode = resolveSprintOrderMode(
    sprint?.executionMode || sprint?.taskOrderMode || "parallel",
  );

  if (sprintTaskOrderMode === "sequential" && sprintId) {
    const taskSprintOrder = normalizeSprintOrder(task.sprintOrder);
    if (taskSprintOrder != null) {
      const incompleteEarlierTasks = Object.values(_store.tasks).filter((candidate) => {
        if (!candidate || candidate.id === task.id) return false;
        if (normalizeSprintId(candidate.sprintId) !== sprintId) return false;
        const candidateOrder = normalizeSprintOrder(candidate.sprintOrder);
        if (candidateOrder == null || candidateOrder >= taskSprintOrder) return false;
        return !isTaskTerminal(candidate);
      });
      if (incompleteEarlierTasks.length > 0) {
        for (const candidate of incompleteEarlierTasks) {
          blockingTaskIds.push(candidate.id);
        }
        return {
          canStart: false,
          reason: "prior_sprint_tasks_incomplete",
          blockingTaskIds: uniqueStringList(blockingTaskIds),
          missingDependencyTaskIds: [],
          blockingSprintIds: [sprintId],
          blockingEpicIds: [],
          sprintOrderMode,
          sprintTaskOrderMode,
        };
      }
    }
  }

  const taskEpicId = String(task?.epicId || task?.meta?.epicId || '').trim();
  if (taskEpicId) {
    const epicDependenciesMap = ensureEpicDependenciesMap();
    const requiredEpics = uniqueStringList(epicDependenciesMap[taskEpicId] || []);
    if (requiredEpics.length > 0) {
      const blockingEpicIds = [];
      const blockingEpicTaskIds = [];
      for (const requiredEpicId of requiredEpics) {
        let hasIncomplete = false;
        for (const candidate of Object.values(_store.tasks)) {
          if (!candidate) continue;
          const candidateEpicId = String(candidate?.epicId || candidate?.meta?.epicId || '').trim();
          if (candidateEpicId !== requiredEpicId) continue;
          if (!isTaskTerminal(candidate)) {
            hasIncomplete = true;
            blockingEpicTaskIds.push(candidate.id);
          }
        }
        if (hasIncomplete) blockingEpicIds.push(requiredEpicId);
      }
      if (blockingEpicIds.length > 0) {
        return {
          canStart: false,
          reason: "epic_dependencies_unresolved",
          blockingTaskIds: uniqueStringList(blockingEpicTaskIds),
          missingDependencyTaskIds: [],
          blockingSprintIds: [],
          blockingEpicIds: uniqueStringList(blockingEpicIds),
          sprintOrderMode,
          sprintTaskOrderMode,
        };
      }
    }
  }

  if (sprintOrderMode === "sequential" && sprintId) {
    const taskSprintOrder = normalizeSprintOrder(sprint?.order);
    if (taskSprintOrder != null) {
      const incompletePriorSprintTasks = Object.values(_store.tasks).filter((candidate) => {
        if (!candidate || candidate.id === task.id) return false;
        const candidateSprintId = normalizeSprintId(candidate.sprintId);
        if (!candidateSprintId || candidateSprintId === sprintId) return false;
        const candidateSprint = ensureSprintsMap()[candidateSprintId];
        const candidateSprintOrder = normalizeSprintOrder(candidateSprint?.order);
        if (candidateSprintOrder == null || candidateSprintOrder >= taskSprintOrder) return false;
        return !isTaskTerminal(candidate);
      });

      if (incompletePriorSprintTasks.length > 0) {
        for (const candidate of incompletePriorSprintTasks) {
          if (candidate.sprintId) blockingSprintIds.push(candidate.sprintId);
          blockingTaskIds.push(candidate.id);
        }
        return {
          canStart: false,
          reason: "prior_sprint_incomplete",
          blockingTaskIds: uniqueStringList(blockingTaskIds),
          missingDependencyTaskIds: [],
          blockingSprintIds: uniqueStringList(blockingSprintIds),
          blockingEpicIds: [],
          sprintOrderMode,
          sprintTaskOrderMode,
        };
      }
    }
  }

  return {
    canStart: true,
    reason: "ok",
    blockingTaskIds: [],
    missingDependencyTaskIds: [],
    blockingSprintIds: [],
    blockingEpicIds: [],
    sprintOrderMode,
  };
}

export function recoverAutoBlockedTasks(options = {}) {
  ensureLoaded();
  const recoveredAtMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const recoveredAt = new Date(recoveredAtMs).toISOString();
  const recoveredTaskIds = [];

  const isWorkflowPlaceholder = (value) => {
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    return trimmed.startsWith("{{") && trimmed.endsWith("}}");
  };

  const resolveRetryAtMs = (task, autoRecovery) => {
    const candidates = [
      autoRecovery?.retryAt,
      task?.cooldownUntil,
      task?.meta?.worktreeFailure?.retryAt,
    ];
    for (const candidate of candidates) {
      if (!candidate || isWorkflowPlaceholder(candidate)) continue;
      const parsed = Date.parse(String(candidate));
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  };

  const hasStaleWorktreePlaceholders = (task) => [
    task?.blockedReason,
    task?.cooldownUntil,
    task?.meta?.autoRecovery?.retryAt,
    task?.meta?.worktreeFailure?.retryAt,
    task?.meta?.worktreeFailure?.blockedReason,
  ].some((value) => isWorkflowPlaceholder(value));

  for (const task of Object.values(_store.tasks)) {
    if (!task || normalizeTaskStatus(task.status) !== "blocked") continue;
    const autoRecovery = task.meta?.autoRecovery;
    const worktreeFailure = task.meta?.worktreeFailure;
    const failureKind = String(worktreeFailure?.failureKind || autoRecovery?.failureKind || "").trim();
    const hasPlaceholder = hasStaleWorktreePlaceholders(task);
    const isWorktreeRecovery = (
      autoRecovery &&
      typeof autoRecovery === "object" &&
      autoRecovery.active !== false &&
      String(autoRecovery.reason || "").trim() === "worktree_failure"
    ) || (
      worktreeFailure &&
      typeof worktreeFailure === "object"
    ) || hasPlaceholder;
    if (!isWorktreeRecovery) continue;
    if (failureKind === "branch_refresh_conflict" && !hasPlaceholder) continue;

    const retryAtMs = resolveRetryAtMs(task, autoRecovery);
    if (Number.isFinite(retryAtMs) && retryAtMs > recoveredAtMs) continue;
    if (!Number.isFinite(retryAtMs) && !hasPlaceholder) continue;

    const previousStatus = normalizeTaskStatus(task.status);
    // If the task has a linked PR, recover to "inreview" instead of "todo"
    const hasPr = Boolean(
      task?.prNumber || task?.pr_number ||
      task?.prUrl || task?.pr_url,
    );
    const recoveryStatus = hasPr ? "inreview" : "todo";
    task.status = recoveryStatus;
    task.cooldownUntil = null;
    task.blockedReason = null;
    task.meta = normalizeRecoveredTaskMeta(task, recoveredAt);
    task.updatedAt = recoveredAt;
    task.lastActivityAt = recoveredAt;
    task.syncDirty = true;
    task.statusHistory.push({
      status: recoveryStatus,
      timestamp: recoveredAt,
      source: "auto-recovery",
    });
    if (task.statusHistory.length > MAX_STATUS_HISTORY) {
      task.statusHistory = task.statusHistory.slice(-MAX_STATUS_HISTORY);
    }
    pushTaskTimeline(task, {
      type: "status.transition",
      source: "auto-recovery",
      fromStatus: previousStatus,
      toStatus: recoveryStatus,
      status: recoveryStatus,
      action: "recover_blocked_task",
      message: `Recovered timed blocked task back to ${recoveryStatus}`,
    });
    markTaskTouched(task, "auto-recovery");
    recoveredTaskIds.push(task.id);
  }

  // --- Parent-task auto-unblock: unblock parents whose children are all done/cancelled ---
  const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
  for (const task of Object.values(_store.tasks)) {
    if (!task || normalizeTaskStatus(task.status) !== "blocked") continue;
    const childIds = task.childTaskIds || task.subtaskIds || [];
    if (childIds.length === 0) continue;
    const allChildrenTerminal = childIds.every((childId) => {
      const child = _store.tasks[childId];
      return child && TERMINAL_STATUSES.has(normalizeTaskStatus(child.status));
    });
    if (!allChildrenTerminal) continue;
    // All subtasks are done or cancelled — unblock the parent
    const previousStatus = normalizeTaskStatus(task.status);
    const hasPr = Boolean(
      task?.prNumber || task?.pr_number ||
      task?.prUrl || task?.pr_url,
    );
    const recoveryStatus = hasPr ? "inreview" : "todo";
    task.status = recoveryStatus;
    task.blockedReason = null;
    task.cooldownUntil = null;
    task.meta = normalizeRecoveredTaskMeta(task, recoveredAt);
    task.updatedAt = recoveredAt;
    task.lastActivityAt = recoveredAt;
    task.syncDirty = true;
    task.statusHistory = task.statusHistory || [];
    task.statusHistory.push({
      status: recoveryStatus,
      timestamp: recoveredAt,
      source: "auto-recovery",
    });
    if (task.statusHistory.length > MAX_STATUS_HISTORY) {
      task.statusHistory = task.statusHistory.slice(-MAX_STATUS_HISTORY);
    }
    pushTaskTimeline(task, {
      type: "status.transition",
      source: "auto-recovery",
      fromStatus: previousStatus,
      toStatus: recoveryStatus,
      status: recoveryStatus,
      action: "recover_parent_task",
      message: `Recovered parent task — all ${childIds.length} subtasks settled`,
    });
    markTaskTouched(task, "auto-recovery");
    recoveredTaskIds.push(task.id);
  }

  if (recoveredTaskIds.length > 0) saveStore();

  return {
    recoveredTaskIds,
    recoveredCount: recoveredTaskIds.length,
    recoveredAt,
  };
}

export function organizeTaskDag(options = {}) {
  ensureLoaded();
  const sprintFilter = normalizeSprintId(options.sprintId);
  const applyDependencySuggestions = options.applyDependencySuggestions !== false;
  const syncEpicDependencies = options.syncEpicDependencies !== false;
  const sprintMap = ensureSprintsMap();
  const allTasks = Object.values(_store.tasks);
  const taskMap = new Map(allTasks.map((task) => [task.id, task]));
  const targetSprintIds = sprintFilter
    ? (sprintMap[sprintFilter] ? [sprintFilter] : [])
    : listSprints().map((sprint) => sprint.id);

  const suggestions = [];
  const orderedTaskIdsBySprint = {};
  let updatedTaskCount = 0;
  let appliedDependencySuggestionCount = 0;
  let syncedEpicDependencyCount = 0;

  for (const sprintId of targetSprintIds) {
    const sprint = sprintMap[sprintId];
    if (!sprint) continue;
    const sprintTasks = allTasks
      .filter((task) => normalizeSprintId(task?.sprintId) === sprintId)
      .sort(compareTaskDagOrder);
    const incomingCounts = new Map();
    const outgoingMap = new Map();
    for (const task of sprintTasks) {
      incomingCounts.set(task.id, 0);
      outgoingMap.set(task.id, new Set());
    }
    for (const task of sprintTasks) {
      for (const dependencyId of listTaskDependencyIds(task)) {
        const dependencyTask = taskMap.get(dependencyId);
        if (!dependencyTask || normalizeSprintId(dependencyTask.sprintId) !== sprintId) continue;
        outgoingMap.get(dependencyId).add(task.id);
        incomingCounts.set(task.id, (incomingCounts.get(task.id) || 0) + 1);
      }
    }

    const orderedTaskIds = topoSortIds(
      sprintTasks.map((task) => task.id),
      incomingCounts,
      outgoingMap,
      (leftId, rightId) => compareTaskDagOrder(taskMap.get(leftId), taskMap.get(rightId)),
    );
    orderedTaskIdsBySprint[sprintId] = orderedTaskIds;
    const sprintSuggestions = collectDagRewriteSuggestions(taskMap, orderedTaskIds, sprint);
    for (const suggestion of sprintSuggestions) {
      if (applyDependencySuggestions !== true || suggestion?.type !== "missing_sequential_dependency") {
        suggestions.push(suggestion);
        continue;
      }
      const task = taskMap.get(suggestion.taskId);
      const dependencyTask = taskMap.get(suggestion.dependencyTaskId);
      if (!task || !dependencyTask) continue;
      const currentDependencies = listTaskDependencyIds(task);
      if (currentDependencies.includes(suggestion.dependencyTaskId)) continue;
      task.dependencyTaskIds = uniqueStringList([...(task.dependencyTaskIds || []), suggestion.dependencyTaskId]);
      task.dependsOn = uniqueStringList([...(task.dependsOn || []), suggestion.dependencyTaskId]);
      dependencyTask.blockedByTaskIds = uniqueStringList([...(dependencyTask.blockedByTaskIds || []), task.id]);
      markTaskTouched(task, "dag-organize");
      markTaskTouched(dependencyTask, "dag-organize");
      appliedDependencySuggestionCount += 1;
    }

    orderedTaskIds.forEach((taskId, index) => {
      const task = taskMap.get(taskId);
      if (!task) return;
      const nextOrder = index + 1;
      if (normalizeSprintOrder(task.sprintOrder) === nextOrder) return;
      task.sprintOrder = nextOrder;
      markTaskTouched(task, "dag-organize");
      updatedTaskCount += 1;
    });
  }

  const allSprintIds = listSprints().map((sprint) => sprint.id);
  const sprintIncoming = new Map();
  const sprintOutgoing = new Map();
  for (const sprintId of allSprintIds) {
    sprintIncoming.set(sprintId, 0);
    sprintOutgoing.set(sprintId, new Set());
  }
  for (const task of allTasks) {
    const taskSprintId = normalizeSprintId(task?.sprintId);
    if (!taskSprintId) continue;
    for (const dependencyId of listTaskDependencyIds(task)) {
      const dependencyTask = taskMap.get(dependencyId);
      const dependencySprintId = normalizeSprintId(dependencyTask?.sprintId);
      if (!dependencySprintId || dependencySprintId === taskSprintId) continue;
      if (!sprintOutgoing.get(dependencySprintId)?.has(taskSprintId)) {
        sprintOutgoing.get(dependencySprintId).add(taskSprintId);
        sprintIncoming.set(taskSprintId, (sprintIncoming.get(taskSprintId) || 0) + 1);
      }
    }
  }

  const orderedSprintIds = topoSortIds(
    allSprintIds,
    sprintIncoming,
    sprintOutgoing,
    (leftId, rightId) => compareSprintDagOrder(sprintMap[leftId], sprintMap[rightId]),
  );
  let updatedSprintCount = 0;
  if (!sprintFilter) {
    orderedSprintIds.forEach((sprintId, index) => {
      const sprint = sprintMap[sprintId];
      if (!sprint) return;
      const nextOrder = index + 1;
      if (normalizeSprintOrder(sprint.order) === nextOrder) return;
      sprint.order = nextOrder;
      sprint.updatedAt = now();
      updatedSprintCount += 1;
    });
  }

  if (syncEpicDependencies) {
    const epicDependencyMap = ensureEpicDependenciesMap();
    const relevantTasks = sprintFilter
      ? allTasks.filter((task) => targetSprintIds.includes(normalizeSprintId(task?.sprintId)))
      : allTasks;
    const nextDependenciesByEpic = new Map(
      Object.entries(epicDependencyMap).map(([epicId, dependencyIds]) => [epicId, uniqueStringList(dependencyIds)]),
    );

    for (const task of relevantTasks) {
      const taskEpicId = getTaskEpicId(task);
      if (!taskEpicId) continue;
      const currentDependencies = nextDependenciesByEpic.get(taskEpicId) || [];
      let nextDependencies = currentDependencies;
      for (const dependencyTaskId of listTaskDependencyIds(task)) {
        const dependencyTask = taskMap.get(dependencyTaskId);
        const dependencyEpicId = getTaskEpicId(dependencyTask);
        if (!dependencyEpicId || dependencyEpicId === taskEpicId) continue;
        if (nextDependencies.includes(dependencyEpicId)) continue;
        nextDependencies = uniqueStringList([...nextDependencies, dependencyEpicId]);
      }
      nextDependenciesByEpic.set(taskEpicId, nextDependencies);
    }

    for (const [epicId, nextDependencies] of nextDependenciesByEpic.entries()) {
      const currentDependencies = uniqueStringList(epicDependencyMap[epicId] || []);
      if (
        currentDependencies.length === nextDependencies.length &&
        currentDependencies.every((dependencyId, index) => dependencyId === nextDependencies[index])
      ) {
        continue;
      }
      if (nextDependencies.length > 0) {
        epicDependencyMap[epicId] = nextDependencies;
      } else {
        delete epicDependencyMap[epicId];
      }
      syncedEpicDependencyCount += 1;
    }
  }

  if (updatedTaskCount > 0 || updatedSprintCount > 0 || appliedDependencySuggestionCount > 0 || syncedEpicDependencyCount > 0) {
    saveStore();
  }

  return {
    sprintId: sprintFilter || null,
    orderedSprintIds,
    orderedTaskIdsBySprint,
    updatedSprintCount,
    updatedTaskCount,
    appliedDependencySuggestionCount,
    syncedEpicDependencyCount,
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// Agent tracking
// ---------------------------------------------------------------------------

/**
 * Record an agent attempt on a task.
 * @param {string} taskId
 * @param {{ output?: string, error?: string, hasCommits?: boolean }} info
 */
export function recordAgentAttempt(taskId, { output, error, hasCommits } = {}) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) {
    console.warn(TAG, `recordAgentAttempt: task ${taskId} not found`);
    return null;
  }

  task.agentAttempts = (task.agentAttempts || 0) + 1;
  task.lastActivityAt = now();
  task.updatedAt = now();

  if (output !== undefined) {
    task.lastAgentOutput = truncate(output, MAX_AGENT_OUTPUT);
  }
  if (error !== undefined) {
    task.lastError = truncate(error, MAX_ERROR_LENGTH);
  }

  if (hasCommits) {
    task.consecutiveNoCommits = 0;
  } else {
    task.consecutiveNoCommits = (task.consecutiveNoCommits || 0) + 1;
  }

  task.syncDirty = true;
  pushTaskTimeline(task, {
    type: "agent.attempt",
    source: "agent",
    status: task.status,
    message: error ? `Agent attempt failed: ${truncate(error, 160)}` : "Agent attempt recorded",
    payload: {
      hasCommits: Boolean(hasCommits),
      attempt: task.agentAttempts,
    },
  });
  saveStore();
  return { ...task };
}

/**
 * Record a classified error pattern on a task.
 * @param {string} taskId
 * @param {string|null} pattern - "plan_stuck" | "rate_limit" | "token_overflow" | "api_error" | null
 */
export function recordErrorPattern(taskId, pattern) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) {
    console.warn(TAG, `recordErrorPattern: task ${taskId} not found`);
    return null;
  }

  task.errorPattern = pattern;
  task.updatedAt = now();
  task.syncDirty = true;

  saveStore();
  return { ...task };
}

/**
 * Set a cooldown on a task (prevents re-scheduling until timestamp).
 */
export function setTaskCooldown(taskId, untilTimestamp, reason) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) {
    console.warn(TAG, `setTaskCooldown: task ${taskId} not found`);
    return null;
  }

  task.cooldownUntil = untilTimestamp;
  task.blockedReason = reason || null;
  task.updatedAt = now();
  task.syncDirty = true;

  console.log(
    TAG,
    `Task ${taskId} cooldown until ${untilTimestamp}: ${reason}`,
  );

  saveStore();
  return { ...task };
}

/**
 * Clear the cooldown on a task.
 */
export function clearTaskCooldown(taskId) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) {
    console.warn(TAG, `clearTaskCooldown: task ${taskId} not found`);
    return null;
  }

  task.cooldownUntil = null;
  task.blockedReason = null;
  task.updatedAt = now();
  task.syncDirty = true;

  saveStore();
  return { ...task };
}

/**
 * Check if a task is currently cooling down.
 */
export function isTaskCoolingDown(taskId) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task || !task.cooldownUntil) return false;
  return new Date(task.cooldownUntil) > new Date();
}

// ---------------------------------------------------------------------------
// Review tracking
// ---------------------------------------------------------------------------

/**
 * Set the review result for a task.
 * @param {string} taskId
 * @param {{ approved: boolean, issues?: Array<{severity: string, description: string}> }} result
 */
export function setReviewResult(taskId, { approved, issues } = {}) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) {
    console.warn(TAG, `setReviewResult: task ${taskId} not found`);
    return null;
  }

  const reviewTimestamp = now();

  task.reviewStatus = approved ? "approved" : "changes_requested";
  task.reviewIssues = issues || null;
  task.reviewedAt = reviewTimestamp;
  task.updatedAt = reviewTimestamp;
  task.lastActivityAt = reviewTimestamp;
  task.syncDirty = true;

  console.log(
    TAG,
    `Task ${taskId} review: ${task.reviewStatus}${issues ? ` (${issues.length} issues)` : ""}`,
  );

  saveStore();
  return { ...task };
}

/**
 * Get tasks that are pending review (status === "inreview").
 */
export function getTasksPendingReview() {
  ensureLoaded();
  return Object.values(_store.tasks).filter((t) => t.status === "inreview");
}

// ---------------------------------------------------------------------------
// Sync helpers
// ---------------------------------------------------------------------------

/**
 * Get all tasks that need syncing to external backend.
 */
export function getDirtyTasks() {
  ensureLoaded();
  return Object.values(_store.tasks).filter((t) => t.syncDirty);
}

/**
 * Mark a task as synced (clears syncDirty, sets lastSyncedAt).
 */
export function markSynced(taskId) {
  ensureLoaded();
  const task = _store.tasks[taskId];
  if (!task) return;

  task.syncDirty = false;
  task.lastSyncedAt = now();

  saveStore();
}

/**
 * Add or update a task from an external source.
 * Only overrides fields the external backend controls.
 * Sets syncDirty = false for the imported data.
 */
export function upsertFromExternal(externalTask) {
  ensureLoaded();
  if (!externalTask || !externalTask.id) {
    console.warn(TAG, "upsertFromExternal: task must have an id");
    return null;
  }

  const existing = _store.tasks[externalTask.id];

  if (existing) {
    const externalBaseBranch =
      externalTask.baseBranch ??
      externalTask.base_branch ??
      externalTask.meta?.base_branch ??
      externalTask.meta?.baseBranch;
    const previousStatus = normalizeTaskStatus(existing.status);

    // Update only externally-controlled fields
    if (externalTask.title !== undefined) existing.title = externalTask.title;
    if (externalTask.description !== undefined)
      existing.description = externalTask.description;
    if (externalTask.assignee !== undefined)
      existing.assignee = externalTask.assignee;
    if (externalTask.priority !== undefined)
      existing.priority = externalTask.priority;
    if (externalTask.projectId !== undefined)
      existing.projectId = externalTask.projectId;
    if (externalBaseBranch !== undefined)
      existing.baseBranch = externalBaseBranch;
    if (externalTask.branchName !== undefined)
      existing.branchName = externalTask.branchName;
    if (externalTask.prNumber !== undefined)
      existing.prNumber = externalTask.prNumber;
    if (externalTask.prUrl !== undefined) existing.prUrl = externalTask.prUrl;
    if (externalTask.meta !== undefined)
      existing.meta = { ...existing.meta, ...externalTask.meta };

    if (externalTask.externalId !== undefined)
      existing.externalId = externalTask.externalId;
    if (externalTask.externalBackend !== undefined)
      existing.externalBackend = externalTask.externalBackend;

    if (
      externalTask.status !== undefined &&
      externalTask.status !== existing.externalStatus
    ) {
      existing.externalStatus = externalTask.status;
      const nextStatus = normalizeTaskStatus(externalTask.status);
      if (nextStatus !== previousStatus) {
        existing.status = nextStatus;
        existing.statusHistory.push({
          status: nextStatus,
          timestamp: now(),
          source: "external",
        });
        if (existing.statusHistory.length > MAX_STATUS_HISTORY) {
          existing.statusHistory =
            existing.statusHistory.slice(-MAX_STATUS_HISTORY);
        }
        pushTaskTimeline(existing, {
          type: "status.transition",
          source: "external",
          fromStatus: previousStatus,
          toStatus: nextStatus,
          status: nextStatus,
          action: "external_sync",
          message: `External status sync ${previousStatus} -> ${nextStatus}`,
        });
      }
    } else if (externalTask.status !== undefined) {
      existing.externalStatus = externalTask.status;
    }

    const normalized = normalizeTaskStructure(existing);
    normalized.updatedAt = now();
    normalized.syncDirty = false;
    normalized.lastSyncedAt = now();
    _store.tasks[normalized.id] = normalized;

    saveStore();
    return { ...normalized };
  }

  // New task from external — create it
  const externalBaseBranch =
    externalTask.baseBranch ??
    externalTask.base_branch ??
    externalTask.meta?.base_branch ??
    externalTask.meta?.baseBranch;
  const task = normalizeTaskStructure(defaultTask({
    ...externalTask,
    ...(externalBaseBranch !== undefined ? { baseBranch: externalBaseBranch } : {}),
    externalStatus: externalTask.status || null,
    status: normalizeTaskStatus(externalTask.status || externalTask.externalStatus || externalTask.status || "todo"),
    syncDirty: false,
    lastSyncedAt: now(),
  }));
  task.lastAgentOutput = truncate(task.lastAgentOutput, MAX_AGENT_OUTPUT);
  task.lastError = truncate(task.lastError, MAX_ERROR_LENGTH);
  pushTaskTimeline(task, {
    type: "task.synced.external",
    source: "external",
    status: task.status,
    message: "Task imported from external backend",
  });

  _store.tasks[task.id] = task;
  console.log(TAG, `Upserted external task ${task.id}: ${task.title}`);

  saveStore();
  return { ...task };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Get aggregate stats across all tasks.
 */
export function getStats() {
  ensureLoaded();
  recalcStats();
  return {
    ..._store._meta.stats,
    total: _store._meta.taskCount,
  };
}

/**
 * Get tasks that have been "inprogress" for longer than maxAgeMs.
 */
export function getStaleInProgressTasks(maxAgeMs) {
  ensureLoaded();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  return Object.values(_store.tasks).filter(
    (t) => t.status === "inprogress" && t.lastActivityAt < cutoff,
  );
}

/**
 * Get tasks that have been "inreview" for longer than maxAgeMs.
 */
export function getStaleInReviewTasks(maxAgeMs) {
  ensureLoaded();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  return Object.values(_store.tasks).filter(
    (t) => t.status === "inreview" && t.lastActivityAt < cutoff,
  );
}
