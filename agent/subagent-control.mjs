import { randomUUID } from "node:crypto";
import {
  createSubagentContract,
  isTerminalSubagentStatus,
  normalizeSubagentStatus,
} from "./subagent-contract.mjs";

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

function normalizeStringArray(values) {
  return uniqueStrings(Array.isArray(values) ? values : [values]);
}

function extractContractInput(input = {}) {
  return toPlainObject(
    input.contract
    || input.subagentContract
    || input.metadata?.subagentContract,
  );
}

function normalizeToolPolicy(input = {}, fallback = {}) {
  const source = {
    ...toPlainObject(fallback),
    ...toPlainObject(input),
  };
  return {
    allowedTools: normalizeStringArray(source.allowedTools),
    deniedTools: normalizeStringArray(source.deniedTools),
    allowNestedDelegation: source.allowNestedDelegation === true,
  };
}

function normalizeMemoryPolicy(input = {}, fallback = {}) {
  const source = {
    ...toPlainObject(fallback),
    ...toPlainObject(input),
  };
  return {
    mode: toTrimmedString(source.mode || "read_only") || "read_only",
    inheritedState: cloneValue(toPlainObject(source.inheritedState)),
  };
}

function normalizeReportingPolicy(input = {}, fallback = {}) {
  const source = {
    ...toPlainObject(fallback),
    ...toPlainObject(input),
  };
  return {
    mode: toTrimmedString(source.mode || "one_way_progress") || "one_way_progress",
    progressOnly: source.progressOnly !== false,
  };
}

function normalizeEscalationPolicy(input = {}, fallback = {}) {
  const source = {
    ...toPlainObject(fallback),
    ...toPlainObject(input),
  };
  return {
    mode: toTrimmedString(source.mode || "none") || "none",
    waitForResponse: source.waitForResponse === true,
  };
}

function normalizeSubagentContract(input = {}, fallback = {}) {
  const source = {
    ...toPlainObject(fallback),
    ...extractContractInput(input),
  };
  return {
    schemaVersion: Number(source.schemaVersion) || 2,
    freshConversation: source.freshConversation !== false,
    toolPolicy: normalizeToolPolicy(source.toolPolicy, fallback.toolPolicy),
    memoryPolicy: normalizeMemoryPolicy(source.memoryPolicy, fallback.memoryPolicy),
    reportingPolicy: normalizeReportingPolicy(source.reportingPolicy, fallback.reportingPolicy),
    escalationPolicy: normalizeEscalationPolicy(source.escalationPolicy, fallback.escalationPolicy),
  };
}

function normalizeProgressEntry(input = {}, existing = []) {
  const source = toPlainObject(input);
  const next = {
    status: normalizeStatus(source.status || "running", "running"),
    message: toTrimmedString(source.message || source.summary || "") || null,
    timestamp: toTrimmedString(source.timestamp || source.createdAt || source.updatedAt || "") || nowIso(),
    details: cloneValue(toPlainObject(source.details || source.output)),
  };
  const sequence = Number(source.sequence);
  next.sequence = Number.isFinite(sequence) && sequence > 0 ? Math.trunc(sequence) : existing.length + 1;
  return next;
}

function normalizeEscalationState(input = {}, fallback = {}) {
  const source = {
    ...toPlainObject(fallback),
    ...toPlainObject(input),
  };
  const type = toTrimmedString(source.type || "") || null;
  if (!type && source.waitForResponse !== true && !toTrimmedString(source.message || source.reason || "")) {
    return null;
  }
  return {
    type: type || (source.waitForResponse === true ? "wait_for_response" : "escalation"),
    status: toTrimmedString(source.status || "waiting") || "waiting",
    waitForResponse: source.waitForResponse === true || type === "wait_for_response",
    message: toTrimmedString(source.message || source.reason || "") || null,
    details: cloneValue(toPlainObject(source.details || source.output)),
    requestedAt: toTrimmedString(source.requestedAt || source.timestamp || "") || nowIso(),
    resolvedAt: toTrimmedString(source.resolvedAt || "") || null,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function createSpawnId() {
  return `spawn-${randomUUID()}`;
}

function normalizeStatus(value, fallback = "pending") {
  return normalizeSubagentStatus(value, fallback);
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

function buildSubagentRecord(input = {}) {
  const createdAt = nowIso();
  const contract = normalizeSubagentContract(input);
  const latestProgress = input.latestProgress
    ? normalizeProgressEntry(input.latestProgress)
    : null;
  const progressHistory = Array.isArray(input.progressHistory)
    ? input.progressHistory.map((entry, index, items) => normalizeProgressEntry({
      ...toPlainObject(entry),
      sequence: entry?.sequence ?? index + 1,
    }, items.slice(0, index)))
    : (latestProgress ? [latestProgress] : []);
  return {
    spawnId: toTrimmedString(input.spawnId || "") || createSpawnId(),
    parentSessionId: toTrimmedString(input.parentSessionId || "") || null,
    parentThreadId: toTrimmedString(input.parentThreadId || "") || null,
    childSessionId: toTrimmedString(input.childSessionId || "") || null,
    childThreadId: toTrimmedString(input.childThreadId || "") || null,
    taskKey: toTrimmedString(input.taskKey || "") || null,
    role: toTrimmedString(input.role || "subagent") || "subagent",
    status: normalizeStatus(input.status || "pending"),
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    lastError: toTrimmedString(input.lastError || "") || null,
    metadata: toPlainObject(input.metadata),
    lastEventType: toTrimmedString(input.lastEventType || "") || null,
    contract,
    latestProgress,
    progressHistory,
    escalation: normalizeEscalationState(input.escalation),
  };
}

function mergeSubagentRecord(record, patch = {}) {
  const next = {
    ...record,
    ...toPlainObject(patch),
    updatedAt: nowIso(),
  };
  next.spawnId = toTrimmedString(next.spawnId || record.spawnId);
  next.parentSessionId = toTrimmedString(next.parentSessionId || record.parentSessionId || "") || null;
  next.parentThreadId = toTrimmedString(next.parentThreadId || record.parentThreadId || "") || null;
  next.childSessionId = toTrimmedString(next.childSessionId || record.childSessionId || "") || null;
  next.childThreadId = toTrimmedString(next.childThreadId || record.childThreadId || "") || null;
  next.taskKey = toTrimmedString(next.taskKey || record.taskKey || "") || null;
  next.role = toTrimmedString(next.role || record.role || "subagent") || "subagent";
  next.status = normalizeStatus(next.status || record.status);
  next.lastError = toTrimmedString(next.lastError || record.lastError || "") || null;
  next.lastEventType = toTrimmedString(next.lastEventType || record.lastEventType || "") || null;
  next.metadata = {
    ...(toPlainObject(record.metadata)),
    ...(toPlainObject(next.metadata)),
  };
  next.contract = normalizeSubagentContract(next, record.contract);
  next.latestProgress = next.latestProgress
    ? normalizeProgressEntry(next.latestProgress, Array.isArray(record.progressHistory) ? record.progressHistory : [])
    : (record.latestProgress ? cloneValue(record.latestProgress) : null);
  const incomingHistory = Array.isArray(next.progressHistory) ? next.progressHistory : null;
  next.progressHistory = incomingHistory
    ? incomingHistory.map((entry, index) => normalizeProgressEntry(entry, incomingHistory.slice(0, index)))
    : (Array.isArray(record.progressHistory) ? cloneValue(record.progressHistory) : []);
  if (next.latestProgress) {
    const lastSequence = Number(next.progressHistory[next.progressHistory.length - 1]?.sequence || 0);
    if (!next.progressHistory.some((entry) => Number(entry?.sequence || 0) === Number(next.latestProgress.sequence || 0))) {
      next.latestProgress.sequence = Number(next.latestProgress.sequence || 0) > lastSequence
        ? Number(next.latestProgress.sequence || 0)
        : lastSequence + 1;
      next.progressHistory = [...next.progressHistory, cloneValue(next.latestProgress)].slice(-25);
    }
  }
  next.escalation = Object.prototype.hasOwnProperty.call(next, "escalation")
    ? normalizeEscalationState(next.escalation, record.escalation)
    : (record.escalation ? cloneValue(record.escalation) : null);
  if (["completed", "failed", "aborted"].includes(next.status)) {
    next.completedAt = toTrimmedString(next.completedAt || record.completedAt || "") || next.updatedAt;
  } else {
    next.completedAt = toTrimmedString(next.completedAt || record.completedAt || "") || null;
  }
  return next;
}

function matchesFilters(record, filters = {}) {
  const parentSessionId = toTrimmedString(filters.parentSessionId);
  if (parentSessionId && toTrimmedString(record.parentSessionId) !== parentSessionId) return false;
  const parentThreadId = toTrimmedString(filters.parentThreadId);
  if (parentThreadId && toTrimmedString(record.parentThreadId) !== parentThreadId) return false;
  const childSessionId = toTrimmedString(filters.childSessionId);
  if (childSessionId && toTrimmedString(record.childSessionId) !== childSessionId) return false;
  const status = toTrimmedString(filters.status);
  if (status && normalizeStatus(record.status) !== normalizeStatus(status)) return false;
  return true;
}

const activeSessions = new Map();
const ACTIVE_SESSION_LISTENERS = new Set();

function notifyActiveSessionListeners(event, taskKey) {
  const payload = {
    event,
    taskKey,
    timestamp: nowIso(),
  };
  for (const listener of ACTIVE_SESSION_LISTENERS) {
    try {
      listener(payload);
    } catch {
    }
  }
}

function normalizeWaitTargets(options_ = {}) {
  const requested = normalizeStringArray(options_.returnOn);
  return requested.length > 0 ? requested.map((entry) => normalizeStatus(entry, entry)) : ["completed", "failed", "aborted"];
}

function shouldResolveWaiter(record, returnOn = []) {
  const targets = new Set(normalizeWaitTargets({ returnOn }));
  const status = normalizeStatus(record?.status || "pending");
  if (targets.has(status)) return true;
  if (targets.has("waiting") && normalizeStatus(record?.escalation?.status || "") === "waiting") return true;
  return false;
}

export function createSubagentControl(options = {}) {
  const records = new Map();
  const waiters = new Map();
  const emitEvent = createEventEmitter([options.onEvent]);

  function buildWaitKey(childSessionIdOrSpawnId) {
    return toTrimmedString(childSessionIdOrSpawnId || "");
  }

  function resolveWaiters(record) {
    const keys = uniqueStrings([record.spawnId, record.childSessionId]);
    for (const key of keys) {
      const bucket = waiters.get(key);
      if (!bucket) continue;
      const remaining = [];
      for (const waiter of bucket) {
        if (!shouldResolveWaiter(record, waiter?.returnOn)) {
          remaining.push(waiter);
          continue;
        }
        if (waiter?.timer) clearTimeout(waiter.timer);
        waiter.resolve(cloneValue(record));
      }
      if (remaining.length > 0) waiters.set(key, remaining);
      else waiters.delete(key);
    }
  }

  function persist(record, eventType) {
    records.set(record.spawnId, record);
    emitEvent({
      type: eventType,
      spawnId: record.spawnId,
      parentSessionId: record.parentSessionId,
      childSessionId: record.childSessionId,
      childThreadId: record.childThreadId,
      status: record.status,
      timestamp: record.updatedAt,
      contract: cloneValue(record.contract),
      latestProgress: cloneValue(record.latestProgress),
      escalation: cloneValue(record.escalation),
    });
    if (isTerminalSubagentStatus(record.status) || normalizeStatus(record.status) === "waiting") {
      resolveWaiters(record);
    }
    return cloneValue(record);
  }

  function registerSubagent(input = {}) {
    const normalizedChildSessionId = toTrimmedString(input.childSessionId || "");
    const existing = normalizedChildSessionId
      ? [...records.values()].find((record) => record.childSessionId === normalizedChildSessionId) || null
      : null;
    const record = existing
      ? mergeSubagentRecord(existing, input)
      : buildSubagentRecord(input);
    if (record.parentThreadId && record.childThreadId && options.threadRegistry?.registerChildThread) {
      try {
        options.threadRegistry.registerChildThread(record.parentThreadId, {
          threadId: record.childThreadId,
          sessionId: record.childSessionId || undefined,
          parentSessionId: record.parentSessionId || undefined,
          role: record.role,
          kind: "subagent",
          status: record.status,
          taskKey: record.taskKey || undefined,
          metadata: record.metadata,
        });
      } catch {
        if (options.threadRegistry?.registerThread) {
          options.threadRegistry.registerThread({
            threadId: record.childThreadId,
            sessionId: record.childSessionId || undefined,
            parentThreadId: record.parentThreadId,
            parentSessionId: record.parentSessionId || undefined,
            role: record.role,
            kind: "subagent",
            status: record.status,
            taskKey: record.taskKey || undefined,
            metadata: record.metadata,
          });
        }
      }
    } else if (record.childThreadId && options.threadRegistry?.registerThread) {
      options.threadRegistry.registerThread({
        threadId: record.childThreadId,
        sessionId: record.childSessionId || undefined,
        parentThreadId: record.parentThreadId || undefined,
        parentSessionId: record.parentSessionId || undefined,
        role: record.role,
        kind: "subagent",
        status: record.status,
        taskKey: record.taskKey || undefined,
        metadata: record.metadata,
      });
    }
    return persist(record, existing ? "subagent:updated" : "subagent:registered");
  }

  function updateSubagent(childSessionIdOrSpawnId, patch = {}) {
    const normalized = toTrimmedString(childSessionIdOrSpawnId);
    const existing = [...records.values()].find((record) => {
      return record.spawnId === normalized || record.childSessionId === normalized;
    }) || null;
    if (!existing) return null;
    const record = mergeSubagentRecord(existing, patch);
    return persist(record, "subagent:updated");
  }

  function getSubagent(childSessionIdOrSpawnId) {
    const normalized = toTrimmedString(childSessionIdOrSpawnId);
    if (!normalized) return null;
    const record = [...records.values()].find((entry) => {
      return entry.spawnId === normalized || entry.childSessionId === normalized;
    }) || null;
    return record ? cloneValue(record) : null;
  }

  function listChildren(filters = {}) {
    return [...records.values()]
      .filter((record) => matchesFilters(record, filters))
      .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")))
      .map((record) => cloneValue(record));
  }

  function getParent(childSessionIdOrSpawnId) {
    const record = getSubagent(childSessionIdOrSpawnId);
    if (!record) return null;
    return {
      parentSessionId: record.parentSessionId,
      parentThreadId: record.parentThreadId,
      role: record.role,
    };
  }

  function planSubagentSpawn(input = {}) {
    const spawn = buildSubagentRecord({
      ...input,
      status: input.status || "pending",
      childSessionId: input.childSessionId || null,
      childThreadId: input.childThreadId || null,
    });
    records.set(spawn.spawnId, spawn);
    emitEvent({
      type: "subagent:planned",
      spawnId: spawn.spawnId,
      parentSessionId: spawn.parentSessionId,
      parentThreadId: spawn.parentThreadId,
      status: spawn.status,
      timestamp: spawn.updatedAt,
    });
    return cloneValue(spawn);
  }

  function completeSubagent(childSessionIdOrSpawnId, patch = {}) {
    return updateSubagent(childSessionIdOrSpawnId, {
      ...patch,
      status: "completed",
      completedAt: patch.completedAt || nowIso(),
      lastError: null,
      escalation: null,
    });
  }

  function failSubagent(childSessionIdOrSpawnId, error, patch = {}) {
    return updateSubagent(childSessionIdOrSpawnId, {
      ...patch,
      status: "failed",
      completedAt: patch.completedAt || nowIso(),
      lastError: toTrimmedString(error || patch.lastError || patch.error || "subagent_failed") || "subagent_failed",
    });
  }

  function abortSubagent(childSessionIdOrSpawnId, reason = "aborted", patch = {}) {
    return updateSubagent(childSessionIdOrSpawnId, {
      ...patch,
      status: "aborted",
      completedAt: patch.completedAt || nowIso(),
      lastError: toTrimmedString(reason || patch.lastError || patch.error || "aborted") || "aborted",
    });
  }

  function recordSubagentProgress(childSessionIdOrSpawnId, progress = {}) {
    const existing = getSubagent(childSessionIdOrSpawnId);
    if (!existing) return null;
    return updateSubagent(childSessionIdOrSpawnId, {
      status: progress.status || existing.status || "running",
      latestProgress: normalizeProgressEntry(progress, existing.progressHistory),
      lastEventType: toTrimmedString(progress.eventType || "subagent:progress") || "subagent:progress",
    });
  }

  function escalateSubagent(childSessionIdOrSpawnId, escalation = {}) {
    const existing = getSubagent(childSessionIdOrSpawnId);
    if (!existing) return null;
    const normalized = normalizeEscalationState(escalation, existing.escalation);
    return updateSubagent(childSessionIdOrSpawnId, {
      status: "waiting",
      escalation: normalized,
      latestProgress: normalizeProgressEntry({
        status: "waiting",
        message: normalized?.message || "Subagent requested operator input.",
        details: normalized?.details || {},
      }, existing.progressHistory),
      lastEventType: "subagent:escalated",
    });
  }

  function resumeSubagent(childSessionIdOrSpawnId, patch = {}) {
    const existing = getSubagent(childSessionIdOrSpawnId);
    if (!existing) return null;
    const resolvedAt = nowIso();
    return updateSubagent(childSessionIdOrSpawnId, {
      ...patch,
      status: patch.status || "running",
      escalation: existing.escalation
        ? { ...existing.escalation, status: "resolved", resolvedAt }
        : null,
      latestProgress: patch.latestProgress || {
        status: patch.status || "running",
        message: toTrimmedString(patch.message || "Subagent resumed."),
        details: toPlainObject(patch.details),
      },
      lastEventType: toTrimmedString(patch.lastEventType || "subagent:resumed") || "subagent:resumed",
    });
  }

  function waitForSubagent(childSessionIdOrSpawnId, options_ = {}) {
    const key = buildWaitKey(childSessionIdOrSpawnId);
    if (!key) {
      return Promise.reject(new Error("waitForSubagent requires a child session id or spawn id"));
    }
    const existing = getSubagent(key);
    const returnOn = normalizeWaitTargets(options_);
    if (existing && shouldResolveWaiter(existing, returnOn)) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null, returnOn };
      if (!waiters.has(key)) {
        waiters.set(key, []);
      }
      waiters.get(key).push(waiter);
      const timeoutMs = Number.isFinite(Number(options_.timeoutMs)) ? Math.max(1, Number(options_.timeoutMs)) : 0;
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const bucket = waiters.get(key) || [];
          waiters.set(key, bucket.filter((entry) => entry !== waiter));
          reject(new Error(`Timed out waiting for subagent "${key}"`));
        }, timeoutMs);
      }
    });
  }

  function snapshot() {
    return {
      records: listChildren(),
      parentSessionIds: uniqueStrings(listChildren().map((record) => record.parentSessionId)),
    };
  }

  function hydrate(snapshot = {}) {
    records.clear();
    for (const entry of Array.isArray(snapshot?.records) ? snapshot.records : []) {
      const record = mergeSubagentRecord(buildSubagentRecord(entry), entry);
      records.set(record.spawnId, record);
    }
    return snapshot();
  }

  return {
    createSubagentContract,
    planSubagentSpawn,
    registerSubagent,
    updateSubagent,
    recordSubagentProgress,
    escalateSubagent,
    resumeSubagent,
    completeSubagent,
    failSubagent,
    abortSubagent,
    waitForSubagent,
    getSubagent,
    getParent,
    getSpawnState: getSubagent,
    listSpawnRecords: listChildren,
    listChildren,
    snapshot,
    hydrate,
  };
}

export function registerActiveSession(taskKey, sdk, threadId, sendFn, metadata = {}) {
  const normalizedTaskKey = toTrimmedString(taskKey);
  if (!normalizedTaskKey || typeof sendFn !== "function") return false;
  activeSessions.set(normalizedTaskKey, {
    sdk: toTrimmedString(sdk || "") || "unknown",
    threadId: toTrimmedString(threadId || "") || null,
    send: sendFn,
    metadata: toPlainObject(metadata),
    registeredAt: Date.now(),
  });
  notifyActiveSessionListeners("start", normalizedTaskKey);
  return true;
}

export function unregisterActiveSession(taskKey) {
  const normalizedTaskKey = toTrimmedString(taskKey);
  if (!normalizedTaskKey) return false;
  const existed = activeSessions.delete(normalizedTaskKey);
  if (existed) notifyActiveSessionListeners("end", normalizedTaskKey);
  return existed;
}

export function steerActiveThread(taskKey, prompt) {
  const normalizedTaskKey = toTrimmedString(taskKey);
  const session = normalizedTaskKey ? activeSessions.get(normalizedTaskKey) : null;
  if (!session || typeof session.send !== "function") return false;
  try {
    session.send(prompt);
    return true;
  } catch {
    return false;
  }
}

export function hasActiveSession(taskKey) {
  return activeSessions.has(toTrimmedString(taskKey));
}

export function addActiveSessionListener(listener) {
  if (typeof listener !== "function") return () => {};
  ACTIVE_SESSION_LISTENERS.add(listener);
  return () => ACTIVE_SESSION_LISTENERS.delete(listener);
}

export function getActiveSessions() {
  const now = Date.now();
  return [...activeSessions.entries()].map(([taskKey, session]) => ({
    id: taskKey,
    taskId: taskKey,
    taskKey,
    sdk: session.sdk,
    threadId: session.threadId,
    age: Math.max(0, now - Number(session.registeredAt || now)),
    metadata: cloneValue(session.metadata || {}),
  }));
}

export default createSubagentControl;
