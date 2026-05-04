import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createThreadContract,
  normalizeThreadStatus,
} from "./thread-contract.mjs";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function cloneValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .map((entry) => toTrimmedString(entry))
      .filter(Boolean),
  )];
}

function nowIso() {
  return new Date().toISOString();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function createThreadId(prefix = "thread") {
  const normalized = toTrimmedString(prefix).replace(/[^a-z0-9_-]+/gi, "-").toLowerCase() || "thread";
  return `${normalized}-${randomUUID()}`;
}

export function createThreadRecord(input = {}, parentRecord = null) {
  const createdAt = nowIso();
  const parentThreadId = toTrimmedString(input.parentThreadId || parentRecord?.threadId || "");
  const parentSessionId = toTrimmedString(input.parentSessionId || parentRecord?.sessionId || "");
  const threadId = toTrimmedString(input.threadId || "") || createThreadId(parentThreadId ? "child-thread" : "thread");
  const sessionId = toTrimmedString(input.sessionId || input.ownerSessionId || "");
  const rootThreadId = toTrimmedString(input.rootThreadId || parentRecord?.rootThreadId || parentRecord?.threadId || threadId) || threadId;
  const rootSessionId = toTrimmedString(input.rootSessionId || parentRecord?.rootSessionId || parentRecord?.sessionId || sessionId || "") || null;
  const lineageDepth = parentRecord
    ? Number(parentRecord.lineageDepth || 0) + 1
    : Math.max(0, Number(input.lineageDepth || 0));
  return {
    threadId,
    sessionId: sessionId || null,
    status: normalizeThreadStatus(input.status || "idle"),
    role: toTrimmedString(input.role || (parentThreadId ? "subagent" : "primary")) || "primary",
    kind: toTrimmedString(input.kind || "session") || "session",
    taskKey: toTrimmedString(input.taskKey || "") || null,
    taskId: toTrimmedString(input.taskId || "") || null,
    taskTitle: toTrimmedString(input.taskTitle || "") || null,
    parentThreadId: parentThreadId || null,
    parentSessionId: parentSessionId || null,
    rootThreadId,
    rootSessionId,
    lineageDepth,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    completedAt: null,
    closedAt: null,
    lastUsedAt: createdAt,
    childThreadIds: uniqueStrings(input.childThreadIds || []),
    metadata: toPlainObject(input.metadata),
    lastError: toTrimmedString(input.lastError || "") || null,
  };
}

function mergeThreadRecord(record, patch = {}, parentRecord = null) {
  const createdAt = record.createdAt || nowIso();
  const next = {
    ...record,
    ...toPlainObject(patch),
    updatedAt: nowIso(),
    createdAt,
  };
  next.threadId = toTrimmedString(next.threadId || record.threadId);
  next.sessionId = toTrimmedString(next.sessionId || record.sessionId || "") || null;
  next.status = normalizeThreadStatus(next.status || record.status);
  next.role = toTrimmedString(next.role || record.role || "primary") || "primary";
  next.kind = toTrimmedString(next.kind || record.kind || "session") || "session";
  next.parentThreadId = toTrimmedString(next.parentThreadId || record.parentThreadId || parentRecord?.threadId || "") || null;
  next.parentSessionId = toTrimmedString(next.parentSessionId || record.parentSessionId || parentRecord?.sessionId || "") || null;
  next.rootThreadId = toTrimmedString(
    next.rootThreadId || record.rootThreadId || parentRecord?.rootThreadId || parentRecord?.threadId || next.threadId,
  ) || next.threadId;
  next.rootSessionId = toTrimmedString(
    next.rootSessionId || record.rootSessionId || parentRecord?.rootSessionId || parentRecord?.sessionId || next.sessionId || "",
  ) || null;
  next.lineageDepth = parentRecord
    ? Number(parentRecord.lineageDepth || 0) + 1
    : (Number.isFinite(Number(next.lineageDepth)) ? Math.max(0, Number(next.lineageDepth)) : Number(record.lineageDepth || 0));
  next.childThreadIds = uniqueStrings([...(record.childThreadIds || []), ...(next.childThreadIds || [])]);
  next.metadata = {
    ...(toPlainObject(record.metadata)),
    ...(toPlainObject(next.metadata)),
  };
  next.lastUsedAt = toTrimmedString(next.lastUsedAt || record.lastUsedAt || next.updatedAt) || next.updatedAt;
  next.lastError = toTrimmedString(next.lastError || record.lastError || "") || null;
  next.completedAt = toTrimmedString(next.completedAt || record.completedAt || "") || null;
  next.closedAt = toTrimmedString(next.closedAt || record.closedAt || "") || null;
  next.startedAt = toTrimmedString(next.startedAt || record.startedAt || "") || null;
  return next;
}

function createEventEmitter(hooks = []) {
  const listeners = [...new Set(hooks.filter((hook) => typeof hook === "function"))];
  return (payload) => {
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch {
      }
    }
  };
}

function matchesThreadFilters(record, filters = {}) {
  const sessionId = toTrimmedString(filters.sessionId);
  if (sessionId && toTrimmedString(record.sessionId) !== sessionId) return false;
  const parentThreadId = toTrimmedString(filters.parentThreadId);
  if (parentThreadId && toTrimmedString(record.parentThreadId) !== parentThreadId) return false;
  const status = toTrimmedString(filters.status).toLowerCase();
  if (status && normalizeThreadStatus(record.status) !== normalizeThreadStatus(status)) return false;
  const kind = toTrimmedString(filters.kind).toLowerCase();
  if (kind && toTrimmedString(record.kind).toLowerCase() !== kind) return false;
  const role = toTrimmedString(filters.role).toLowerCase();
  if (role && toTrimmedString(record.role).toLowerCase() !== role) return false;
  return true;
}

export const THREAD_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const MAX_THREAD_TURNS = 100;
export const THREAD_MAX_ABSOLUTE_AGE_MS = 24 * 60 * 60 * 1000;

export const threadRegistry = new Map();

const PERSISTENT_THREAD_SDKS = new Set(["codex", "claude", "copilot", "gemini", "opencode"]);
let threadRegistryLoaded = false;
let threadRegistryLoadPromise = null;

function resolveThreadRegistryFile() {
  const testCacheDir = toTrimmedString(process.env.BOSUN_TEST_CACHE_DIR || "");
  return testCacheDir
    ? resolve(testCacheDir, "thread-registry.json")
    : resolve(__dirname, "..", "logs", "thread-registry.json");
}

function normalizePersistedThreadRecord(taskKey, record = {}, now = Date.now()) {
  const sdk = toTrimmedString(record?.sdk || "").toLowerCase();
  const createdAt = Number(record?.createdAt || now);
  const lastUsedAt = Number(record?.lastUsedAt || createdAt || now);
  const threadId = toTrimmedString(record?.threadId || "");
  const turnCount = Number(record?.turnCount || 0);
  const alive = record?.alive !== false
    && !!threadId
    && sdkSupportsPersistentThreads(sdk);
  return {
    ...toPlainObject(record),
    sdk,
    taskKey: toTrimmedString(record?.taskKey || taskKey || "") || null,
    threadId: threadId || null,
    cwd: toTrimmedString(record?.cwd || "") || null,
    turnCount: Number.isFinite(turnCount) ? turnCount : 0,
    createdAt: Number.isFinite(createdAt) ? createdAt : now,
    lastUsedAt: Number.isFinite(lastUsedAt) ? lastUsedAt : now,
    lastError: toTrimmedString(record?.lastError || "") || null,
    alive,
  };
}

function shouldPersistThreadRecord(record = {}, now = Date.now()) {
  const normalized = normalizePersistedThreadRecord(record?.taskKey, record, now);
  if (!normalized.alive) return false;
  if (!normalized.threadId) return false;
  if (!sdkSupportsPersistentThreads(normalized.sdk)) return false;
  if (normalized.turnCount >= MAX_THREAD_TURNS) return false;
  if (now - normalized.createdAt > THREAD_MAX_ABSOLUTE_AGE_MS) return false;
  if (now - normalized.lastUsedAt > THREAD_MAX_AGE_MS) return false;
  return true;
}

function loadThreadRegistryFromDisk() {
  const registryFile = resolveThreadRegistryFile();
  if (!existsSync(registryFile)) {
    return { pruned: 0, loaded: 0 };
  }
  const raw = readFileSync(registryFile, "utf8");
  const entries = JSON.parse(raw);
  const now = Date.now();
  let pruned = 0;
  let loaded = 0;
  threadRegistry.clear();
  for (const [taskKey, record] of Object.entries(entries || {})) {
    const normalized = normalizePersistedThreadRecord(taskKey, record, now);
    if (!shouldPersistThreadRecord(normalized, now)) {
      pruned += 1;
      continue;
    }
    threadRegistry.set(taskKey, normalized);
    loaded += 1;
  }
  return { pruned, loaded };
}

export function createThreadRegistry(options = {}) {
  const threads = new Map();
  const emitEvent = createEventEmitter([options.onEvent]);

  function registerThread(input = {}) {
    const requestedThreadId = toTrimmedString(input.threadId || "");
    const existing = requestedThreadId ? threads.get(requestedThreadId) : null;
    const parentRecord = toTrimmedString(input.parentThreadId || existing?.parentThreadId || "")
      ? threads.get(toTrimmedString(input.parentThreadId || existing?.parentThreadId || ""))
      : null;
    const next = existing
      ? mergeThreadRecord(existing, input, parentRecord)
      : createThreadRecord(input, parentRecord);
    threads.set(next.threadId, next);
    if (next.parentThreadId) {
      const parent = threads.get(next.parentThreadId);
      if (parent) {
        threads.set(parent.threadId, mergeThreadRecord(parent, {
          childThreadIds: [next.threadId],
          lastUsedAt: next.updatedAt,
        }));
      }
    }
    emitEvent({
      type: existing ? "thread:updated" : "thread:registered",
      threadId: next.threadId,
      sessionId: next.sessionId,
      parentThreadId: next.parentThreadId,
      status: next.status,
      timestamp: next.updatedAt,
    });
    return cloneValue(next);
  }

  function updateThread(threadId, patch = {}) {
    const normalizedThreadId = toTrimmedString(threadId);
    if (!normalizedThreadId || !threads.has(normalizedThreadId)) return null;
    return registerThread({
      ...patch,
      threadId: normalizedThreadId,
    });
  }

  function getThread(threadId) {
    const normalizedThreadId = toTrimmedString(threadId);
    return normalizedThreadId && threads.has(normalizedThreadId)
      ? cloneValue(threads.get(normalizedThreadId))
      : null;
  }

  function listThreads(filters = {}) {
    return [...threads.values()]
      .filter((record) => matchesThreadFilters(record, filters))
      .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")))
      .map((record) => cloneValue(record));
  }

  function registerChildThread(parentThreadId, input = {}) {
    const normalizedParentThreadId = toTrimmedString(parentThreadId);
    const parent = normalizedParentThreadId ? threads.get(normalizedParentThreadId) : null;
    if (!parent) {
      throw new Error(`Unknown parent thread "${parentThreadId}"`);
    }
    return registerThread({
      ...input,
      parentThreadId: parent.threadId,
      parentSessionId: input.parentSessionId || parent.sessionId || undefined,
      rootThreadId: input.rootThreadId || parent.rootThreadId || parent.threadId,
      rootSessionId: input.rootSessionId || parent.rootSessionId || parent.sessionId || undefined,
      role: input.role || "subagent",
      kind: input.kind || "subagent",
      status: input.status || "idle",
    });
  }

  function markThreadRunning(threadId, patch = {}) {
    const startedAt = toTrimmedString(patch.startedAt || "") || nowIso();
    return updateThread(threadId, {
      ...patch,
      status: "running",
      startedAt,
      lastUsedAt: startedAt,
    });
  }

  function markThreadCompleted(threadId, patch = {}) {
    const completedAt = toTrimmedString(patch.completedAt || "") || nowIso();
    return updateThread(threadId, {
      ...patch,
      status: "completed",
      completedAt,
      lastUsedAt: completedAt,
      lastError: null,
    });
  }

  function markThreadFailed(threadId, error, patch = {}) {
    const completedAt = toTrimmedString(patch.completedAt || "") || nowIso();
    return updateThread(threadId, {
      ...patch,
      status: "failed",
      completedAt,
      lastUsedAt: completedAt,
      lastError: toTrimmedString(error || patch.error || "thread_failed") || "thread_failed",
    });
  }

  function closeThread(threadId, patch = {}) {
    const closedAt = toTrimmedString(patch.closedAt || "") || nowIso();
    return updateThread(threadId, {
      ...patch,
      status: patch.status || "closed",
      closedAt,
      completedAt: patch.completedAt || closedAt,
      lastUsedAt: closedAt,
      lastError: toTrimmedString(patch.error || "") || null,
    });
  }

  function getActiveThread(sessionId) {
    const candidates = listThreads({ sessionId })
      .filter((record) => ["running", "ready", "idle", "waiting_approval", "dry_run"].includes(record.status))
      .sort((left, right) => String(right.lastUsedAt || "").localeCompare(String(left.lastUsedAt || "")));
    return candidates[0] || null;
  }

  function listChildren(parentThreadId) {
    return listThreads({ parentThreadId });
  }

  function getLineage(threadId) {
    const lineage = [];
    let current = toTrimmedString(threadId);
    while (current && threads.has(current)) {
      const record = threads.get(current);
      lineage.unshift(cloneValue(record));
      current = toTrimmedString(record.parentThreadId || "");
    }
    return lineage;
  }

  function snapshot() {
    return {
      threads: listThreads(),
    };
  }

  function hydrate(snapshot = {}) {
    threads.clear();
    for (const entry of Array.isArray(snapshot?.threads) ? snapshot.threads : []) {
      const parentRecord = toTrimmedString(entry?.parentThreadId || "") ? threads.get(toTrimmedString(entry.parentThreadId)) : null;
      const record = createThreadRecord(entry, parentRecord);
      const merged = mergeThreadRecord(record, entry, parentRecord);
      threads.set(merged.threadId, merged);
    }
    return snapshot();
  }

  return {
    createThread(input = {}) {
      if (toTrimmedString(input.threadId || "") && threads.has(toTrimmedString(input.threadId))) {
        throw new Error(`Thread "${input.threadId}" already exists`);
      }
      return registerThread(input);
    },
    registerThread,
    ensureThread: registerThread,
    updateThread,
    getThread,
    listThreads,
    registerChildThread,
    markThreadRunning,
    markThreadCompleted,
    markThreadFailed,
    closeThread,
    getActiveThread,
    listChildren,
    getLineage,
    snapshot,
    hydrate,
  };
}

export function sdkSupportsPersistentThreads(sdk) {
  return PERSISTENT_THREAD_SDKS.has(toTrimmedString(sdk).toLowerCase());
}

export async function ensureThreadRegistryLoaded() {
  if (threadRegistryLoaded) return threadRegistry;
  if (!threadRegistryLoadPromise) {
    threadRegistryLoadPromise = Promise.resolve()
      .then(() => {
        try {
          const { pruned } = loadThreadRegistryFromDisk();
          if (pruned > 0) {
            return persistThreadRegistry();
          }
        } catch {
          threadRegistry.clear();
        }
        return null;
      })
      .finally(() => {
        threadRegistryLoaded = true;
      });
  }
  await threadRegistryLoadPromise;
  return threadRegistry;
}

export async function persistThreadRegistry() {
  const registryFile = resolveThreadRegistryFile();
  mkdirSync(dirname(registryFile), { recursive: true });
  const now = Date.now();
  const persistedEntries = Object.fromEntries(
    [...threadRegistry.entries()]
      .map(([taskKey, record]) => [taskKey, normalizePersistedThreadRecord(taskKey, record, now)])
      .filter(([, record]) => shouldPersistThreadRecord(record, now)),
  );
  writeFileSync(registryFile, JSON.stringify(persistedEntries, null, 2), "utf8");
  return {
    ok: true,
    count: threadRegistry.size,
    filePath: registryFile,
  };
}

export function clearThreadRegistry() {
  threadRegistry.clear();
  persistThreadRegistry().catch(() => {});
  return true;
}

export function getThreadRecord(taskKey) {
  const normalized = toTrimmedString(taskKey);
  return normalized && threadRegistry.has(normalized)
    ? cloneValue(threadRegistry.get(normalized))
    : null;
}

export function listTaskThreadRecords() {
  return [...threadRegistry.entries()].map(([taskKey, record]) => ({
    taskKey,
    ...cloneValue(record),
  }));
}

export function setThreadRecord(taskKey, record = {}) {
  const normalizedTaskKey = toTrimmedString(taskKey);
  if (!normalizedTaskKey) {
    throw new Error("setThreadRecord requires a taskKey");
  }
  const existing = getThreadRecord(normalizedTaskKey) || {};
  const next = normalizePersistedThreadRecord(normalizedTaskKey, {
    ...existing,
    ...toPlainObject(record),
    taskKey: normalizedTaskKey,
  });
  threadRegistry.set(normalizedTaskKey, next);
  persistThreadRegistry().catch(() => {});
  return cloneValue(next);
}

export function deleteThreadRecord(taskKey) {
  const normalizedTaskKey = toTrimmedString(taskKey);
  if (!normalizedTaskKey) return false;
  const deleted = threadRegistry.delete(normalizedTaskKey);
  if (deleted) {
    persistThreadRegistry().catch(() => {});
  }
  return deleted;
}

export function createThreadRecordContract(input = {}) {
  const normalizedTaskKey = toTrimmedString(input.taskKey || "");
  const record = normalizedTaskKey ? getThreadRecord(normalizedTaskKey) : null;
  return createThreadContract({
    ...(record || {}),
    ...toPlainObject(input),
  });
}

export function invalidateThread(taskKey) {
  const normalized = toTrimmedString(taskKey);
  if (!normalized || !threadRegistry.has(normalized)) return false;
  const record = toPlainObject(threadRegistry.get(normalized));
  threadRegistry.set(normalized, {
    ...record,
    alive: false,
    lastError: toTrimmedString(record.lastError || "invalidated") || "invalidated",
    lastUsedAt: Date.now(),
  });
  persistThreadRegistry().catch(() => {});
  return true;
}

export async function invalidateThreadAsync(taskKey) {
  return invalidateThread(taskKey);
}

export function getActiveThreads() {
  return [...threadRegistry.entries()]
    .map(([taskKey, record]) => ({
      id: taskKey,
      taskId: taskKey,
      taskKey,
      ...(cloneValue(record) || {}),
    }))
    .filter((record) => record.alive !== false);
}

export function pruneAllExhaustedThreads() {
  let pruned = 0;
  const now = Date.now();
  for (const [taskKey, record] of threadRegistry.entries()) {
    const turnCount = Number(record?.turnCount || 0);
    const createdAt = Number(record?.createdAt || now);
    const lastUsedAt = Number(record?.lastUsedAt || now);
    if (
      turnCount >= MAX_THREAD_TURNS ||
      now - createdAt > THREAD_MAX_ABSOLUTE_AGE_MS ||
      now - lastUsedAt > THREAD_MAX_AGE_MS
    ) {
      invalidateThread(taskKey);
      pruned += 1;
    }
  }
  if (pruned > 0) {
    persistThreadRegistry().catch(() => {});
  }
  return pruned;
}

export default createThreadRegistry;
