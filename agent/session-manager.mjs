import { randomUUID } from "node:crypto";

/**
 * Canonical architecture note:
 * Session lifecycle, lineage, replay/resume state, and subagent-linked session
 * ownership are centralized here. Legacy entrypoints may delegate into this
 * manager, but they must not retain hidden lifecycle rules outside the session
 * manager, thread registry, and subagent-control control plane.
 */

import { createAgentLoop } from "./harness/agent-loop.mjs";
import { compileInternalHarnessProfile } from "./internal-harness-profile.mjs";
import { createInternalHarnessRuntime } from "./internal-harness-runtime.mjs";
import { getSessionTracker } from "../infra/session-tracker.mjs";
import { createLineageGraph } from "./lineage-graph.mjs";
import {
  canTransitionSessionStatus,
  createSessionContract,
  isTerminalSessionStatus,
  normalizeSessionStatus,
} from "./session-contract.mjs";
import { createSessionReplayStore } from "./session-replay.mjs";
import { createSubagentControl } from "./subagent-control.mjs";
import { createSubagentPool } from "./subagent-pool.mjs";
import { createThreadId, createThreadRegistry } from "./thread-registry.mjs";

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

function normalizeStatus(value, fallback = "idle") {
  return normalizeSessionStatus(value, fallback);
}

function toPositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function createSessionId(prefix = "session") {
  const normalized = toTrimmedString(prefix).replace(/[^a-z0-9_-]+/gi, "-").toLowerCase() || "session";
  return `${normalized}-${randomUUID()}`;
}

function formatHarnessValidationError(validationReport = {}) {
  const errors = Array.isArray(validationReport?.errors) ? validationReport.errors : [];
  if (errors.length === 0) return "Harness validation failed";
  return errors
    .map((issue) => String(issue?.message || issue?.code || "Harness validation failed").trim())
    .filter(Boolean)
    .join("; ");
}

function resolveTurnExecutor(options = {}) {
  if (typeof options.executeTurn === "function") return options.executeTurn;
  if (typeof options.turnExecutor === "function") return options.turnExecutor;
  if (typeof options.buildTurnExecutor === "function") return options.buildTurnExecutor(options);
  return async () => {
    throw new Error("Harness runtime requires an executeTurn function when dryRun is false");
  };
}

function compileProfileSource(profileSource, options = {}) {
  if (typeof options.compileHarnessSource === "function") {
    return options.compileHarnessSource(profileSource, options);
  }
  return compileInternalHarnessProfile(profileSource, options.compileOptions || options);
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

function buildSessionRecord(compiledProfile, options = {}, parentRecord = null) {
  const createdAt = nowIso();
  const sessionId = toTrimmedString(options.sessionId || options.id || options.logicalSessionId || "")
    || createSessionId(compiledProfile?.name || compiledProfile?.agentId || "harness");
  const threadId = toTrimmedString(options.threadId || "") || createThreadId(parentRecord ? "subthread" : "thread");
  const rootSessionId = parentRecord?.rootSessionId || parentRecord?.sessionId || sessionId;
  return {
    sessionId,
    runId: toTrimmedString(options.runId || sessionId) || sessionId,
    scope: toTrimmedString(options.scope || (parentRecord?.scope || "default")) || (parentRecord?.scope || "default"),
    taskKey: toTrimmedString(options.taskKey || compiledProfile?.taskKey || compiledProfile?.agentId || sessionId),
    taskId: toTrimmedString(options.taskId || compiledProfile?.taskId || ""),
    taskTitle: toTrimmedString(options.taskTitle || compiledProfile?.taskTitle || compiledProfile?.name || ""),
    sessionType: toTrimmedString(options.sessionType || (parentRecord ? "subagent" : "primary")) || "primary",
    status: normalizeStatus(options.status || "idle"),
    createdAt,
    updatedAt: createdAt,
    lastActiveAt: createdAt,
    startedAt: null,
    completedAt: null,
    lastError: null,
    activeThreadId: threadId,
    threadIds: [threadId],
    childSessionIds: [],
    parentSessionId: parentRecord?.sessionId || toTrimmedString(options.parentSessionId || "") || null,
    parentThreadId: parentRecord?.activeThreadId || toTrimmedString(options.parentThreadId || "") || null,
    rootSessionId,
    lineageDepth: parentRecord ? Number(parentRecord.lineageDepth || 0) + 1 : 0,
    agentId: toTrimmedString(compiledProfile?.agentId || ""),
    profileName: toTrimmedString(compiledProfile?.name || compiledProfile?.agentId || compiledProfile?.taskKey || "harness-session"),
    entryStageId: toTrimmedString(compiledProfile?.entryStageId || ""),
    replayCursor: null,
    executionCount: 0,
    workerGeneration: 0,
    workerSwapCount: 0,
    activeWorkerId: null,
    activeWorker: null,
    workerHistory: [],
    metadata: {
      ...(toPlainObject(compiledProfile?.metadata)),
      ...(toPlainObject(options.metadata)),
    },
  };
}

function mergeSessionRecord(record, patch = {}) {
  const next = {
    ...record,
    ...toPlainObject(patch),
    updatedAt: nowIso(),
  };
  const hasActiveWorkerIdPatch = Object.prototype.hasOwnProperty.call(patch, "activeWorkerId");
  const hasActiveWorkerPatch = Object.prototype.hasOwnProperty.call(patch, "activeWorker");
  const hasWorkerHistoryPatch = Object.prototype.hasOwnProperty.call(patch, "workerHistory");
  next.status = normalizeStatus(next.status || record.status);
  next.threadIds = uniqueStrings([...(record.threadIds || []), ...(next.threadIds || [])]);
  next.childSessionIds = uniqueStrings([...(record.childSessionIds || []), ...(next.childSessionIds || [])]);
  next.activeThreadId = toTrimmedString(next.activeThreadId || record.activeThreadId || "") || null;
  next.parentSessionId = toTrimmedString(next.parentSessionId || record.parentSessionId || "") || null;
  next.parentThreadId = toTrimmedString(next.parentThreadId || record.parentThreadId || "") || null;
  next.rootSessionId = toTrimmedString(next.rootSessionId || record.rootSessionId || next.sessionId) || next.sessionId;
  next.metadata = {
    ...(toPlainObject(record.metadata)),
    ...(toPlainObject(next.metadata)),
  };
  next.executionCount = Math.max(0, Number.isFinite(Number(next.executionCount)) ? Math.trunc(Number(next.executionCount)) : Number(record.executionCount || 0));
  next.workerGeneration = Math.max(0, Number.isFinite(Number(next.workerGeneration)) ? Math.trunc(Number(next.workerGeneration)) : Number(record.workerGeneration || 0));
  next.workerSwapCount = Math.max(0, Number.isFinite(Number(next.workerSwapCount)) ? Math.trunc(Number(next.workerSwapCount)) : Number(record.workerSwapCount || 0));
  next.activeWorkerId = hasActiveWorkerIdPatch
    ? (toTrimmedString(patch.activeWorkerId || "") || null)
    : (toTrimmedString(next.activeWorkerId || record.activeWorkerId || "") || null);
  next.activeWorker = hasActiveWorkerPatch
    ? (patch.activeWorker && typeof patch.activeWorker === "object" ? cloneValue(patch.activeWorker) : null)
    : (next.activeWorker && typeof next.activeWorker === "object"
      ? cloneValue(next.activeWorker)
      : (record.activeWorker && typeof record.activeWorker === "object" ? cloneValue(record.activeWorker) : null));
  next.workerHistory = hasWorkerHistoryPatch
    ? (Array.isArray(patch.workerHistory) ? patch.workerHistory.map((entry) => cloneValue(entry)) : [])
    : (Array.isArray(next.workerHistory)
      ? next.workerHistory.map((entry) => cloneValue(entry))
      : (Array.isArray(record.workerHistory) ? record.workerHistory.map((entry) => cloneValue(entry)) : []));
  next.lastActiveAt = toTrimmedString(next.lastActiveAt || record.lastActiveAt || next.updatedAt) || next.updatedAt;
  return next;
}

function normalizeWorkerDescriptor(value = {}) {
  const metadata = toPlainObject(value.metadata);
  const workerId = toTrimmedString(value.workerId || "");
  const threadId = toTrimmedString(value.threadId || "");
  const providerSelection = toTrimmedString(
    value.providerSelection
    || metadata.providerSelection
    || "",
  ) || null;
  const adapterName = toTrimmedString(
    value.adapterName
    || metadata.adapterName
    || providerSelection
    || "",
  ) || providerSelection;
  const profileName = toTrimmedString(
    value.profileName
    || metadata.profileName
    || metadata.workerProfileName
    || "",
  ) || null;
  const entryStageId = toTrimmedString(
    value.entryStageId
    || metadata.entryStageId
    || "",
  ) || null;
  return {
    workerId: workerId || null,
    threadId: threadId || null,
    status: normalizeStatus(value.status || "running"),
    source: toTrimmedString(value.source || metadata.source || "") || null,
    scope: toTrimmedString(value.scope || metadata.scope || "") || null,
    sessionType: toTrimmedString(value.sessionType || metadata.sessionType || "") || null,
    providerSelection,
    adapterName,
    profileName,
    entryStageId,
    attachedAt: toTrimmedString(value.attachedAt || "") || null,
    detachedAt: toTrimmedString(value.detachedAt || "") || null,
    lastError: toTrimmedString(value.lastError || value.error || "") || null,
    result: value.result ? cloneValue(value.result) : null,
    metadata,
  };
}

function createWorkerFingerprint(worker = {}) {
  const normalized = normalizeWorkerDescriptor(worker);
  return [
    normalized.threadId || "",
    normalized.providerSelection || "",
    normalized.adapterName || "",
    normalized.profileName || "",
    normalized.entryStageId || "",
    normalized.scope || "",
    normalized.sessionType || "",
  ].join("|");
}

function createLifecyclePatch(event = {}, sessionRecord = {}) {
  const type = toTrimmedString(event.type).toLowerCase();
  if (type === "harness:session-start" || type === "harness:stage-start") {
    return {
      status: "running",
      startedAt: sessionRecord.startedAt || event.timestamp || nowIso(),
      currentStageId: toTrimmedString(event.stageId || sessionRecord.currentStageId || "") || null,
      lastActiveAt: event.timestamp || nowIso(),
    };
  }
  if (type === "harness:approval-requested") {
    return {
      status: "waiting_approval",
      currentStageId: toTrimmedString(event.stageId || sessionRecord.currentStageId || "") || null,
      approvalRequestId: toTrimmedString(event.requestId || "") || null,
      lastActiveAt: event.timestamp || nowIso(),
    };
  }
  if (type === "harness:approval-resolved") {
    return {
      status: event.decision === "approved" ? "running" : normalizeStatus(event.decision || "blocked"),
      approvalRequestId: null,
      lastActiveAt: event.timestamp || nowIso(),
    };
  }
  if (type === "harness:completed") {
    return {
      status: "completed",
      completedAt: event.timestamp || nowIso(),
      currentStageId: toTrimmedString(event.stageId || sessionRecord.currentStageId || "") || null,
      lastError: null,
      lastActiveAt: event.timestamp || nowIso(),
    };
  }
  if (type === "harness:failed") {
    return {
      status: normalizeStatus(event?.result?.status || "failed"),
      completedAt: event.timestamp || nowIso(),
      lastError: toTrimmedString(event?.result?.error || "") || null,
      currentStageId: toTrimmedString(event.stageId || sessionRecord.currentStageId || "") || null,
      lastActiveAt: event.timestamp || nowIso(),
    };
  }
  if (type === "harness:aborted") {
    return {
      status: "aborted",
      completedAt: event.timestamp || nowIso(),
      lastError: toTrimmedString(event.reason || "aborted"),
      lastActiveAt: event.timestamp || nowIso(),
    };
  }
  return {
    lastActiveAt: event.timestamp || nowIso(),
  };
}

function createInternalSessionManager(defaultOptions = {}) {
  const sessions = new Map();
  const activeSessions = new Map();
  const sessionControllers = new Map();
  let managerApi = null;
  const threadRegistry = defaultOptions.threadRegistry || createThreadRegistry();
  const replayStore = defaultOptions.replayStore || createSessionReplayStore(defaultOptions);
  const subagentControl = defaultOptions.subagentControl || createSubagentControl({ threadRegistry });
  const subagentPool = defaultOptions.subagentPool || createSubagentPool({
    onEvent: defaultOptions.onEvent,
  });
  const emitManagerEvent = createEventEmitter([
    defaultOptions.onEvent,
    defaultOptions.onHarnessEvent,
    defaultOptions.onSessionEvent,
  ]);

  function getSessionRecord(sessionId) {
    const normalized = toTrimmedString(sessionId);
    return normalized && sessions.has(normalized) ? cloneValue(sessions.get(normalized)) : null;
  }

  function storeSession(record, patch = {}) {
    const next = mergeSessionRecord(record, patch);
    sessions.set(next.sessionId, next);
    return next;
  }

  function replaceWorkerHistoryEntry(workerHistory = [], workerId, nextWorker) {
    const normalizedWorkerId = toTrimmedString(workerId);
    const normalizedNext = normalizeWorkerDescriptor(nextWorker);
    const entries = Array.isArray(workerHistory) ? workerHistory : [];
    let replaced = false;
    const nextHistory = entries.map((entry) => {
      if (toTrimmedString(entry?.workerId || "") !== normalizedWorkerId) {
        return cloneValue(entry);
      }
      replaced = true;
      return normalizedNext;
    });
    if (!replaced && normalizedNext.workerId) {
      nextHistory.push(normalizedNext);
    }
    return nextHistory;
  }

  function finalizeActiveWorkerRecord(sessionRecord, options = {}) {
    if (!sessionRecord?.activeWorker || !sessionRecord.activeWorkerId) {
      return sessionRecord;
    }
    const currentWorker = normalizeWorkerDescriptor(sessionRecord.activeWorker);
    const detachedAt = toTrimmedString(options.detachedAt || "") || nowIso();
    const finalizedWorker = {
      ...currentWorker,
      status: normalizeStatus(options.status || currentWorker.status || sessionRecord.status || "completed"),
      detachedAt,
      lastError: toTrimmedString(options.lastError || currentWorker.lastError || "") || null,
      result: options.result ? cloneValue(options.result) : currentWorker.result,
      metadata: {
        ...(toPlainObject(currentWorker.metadata)),
        ...(toPlainObject(options.metadata)),
      },
    };
    return storeSession(sessionRecord, {
      activeWorkerId: null,
      activeWorker: null,
      workerHistory: replaceWorkerHistoryEntry(
        sessionRecord.workerHistory,
        currentWorker.workerId,
        finalizedWorker,
      ),
      lastActiveAt: detachedAt,
    });
  }

  function attachExecutionWorker(sessionRecord, execution = {}) {
    if (!sessionRecord) return null;
    const normalizedExecution = normalizeWorkerDescriptor({
      ...execution,
      metadata: {
        ...(toPlainObject(sessionRecord.metadata)),
        ...(toPlainObject(execution.metadata)),
      },
    });
    if (!normalizedExecution.threadId) {
      return {
        sessionRecord,
        worker: sessionRecord.activeWorker ? normalizeWorkerDescriptor(sessionRecord.activeWorker) : null,
        attached: false,
        swapped: false,
      };
    }
    const previousWorker = sessionRecord.activeWorker
      ? normalizeWorkerDescriptor(sessionRecord.activeWorker)
      : null;
    const lastHistoricalWorker = Array.isArray(sessionRecord.workerHistory) && sessionRecord.workerHistory.length > 0
      ? normalizeWorkerDescriptor(sessionRecord.workerHistory[sessionRecord.workerHistory.length - 1])
      : null;
    const comparisonWorker = previousWorker || lastHistoricalWorker;
    const previousFingerprint = comparisonWorker ? createWorkerFingerprint(comparisonWorker) : "";
    const nextFingerprint = createWorkerFingerprint(normalizedExecution);
    const shouldSwap = Boolean(comparisonWorker && previousFingerprint !== nextFingerprint);
    let nextSessionRecord = sessionRecord;
    if (shouldSwap) {
      nextSessionRecord = finalizeActiveWorkerRecord(nextSessionRecord, {
        status: "swapped",
        detachedAt: nowIso(),
        metadata: {
          reason: "worker_swap",
        },
      });
    }
    const generation = Math.max(0, Number(nextSessionRecord.workerGeneration || 0)) + 1;
    const attachedAt = nowIso();
    const worker = {
      ...normalizedExecution,
      workerId: normalizedExecution.workerId || `${nextSessionRecord.sessionId}:worker:${generation}`,
      attachedAt,
      detachedAt: null,
      status: normalizeStatus(execution.status || nextSessionRecord.status || "running"),
      metadata: {
        ...(toPlainObject(nextSessionRecord.metadata)),
        ...(toPlainObject(normalizedExecution.metadata)),
      },
    };
    nextSessionRecord = storeSession(nextSessionRecord, {
      activeWorkerId: worker.workerId,
      activeWorker: worker,
      activeThreadId: worker.threadId || nextSessionRecord.activeThreadId,
      threadIds: worker.threadId ? [worker.threadId] : nextSessionRecord.threadIds,
      executionCount: Math.max(0, Number(nextSessionRecord.executionCount || 0)) + 1,
      workerGeneration: generation,
      workerSwapCount: Math.max(0, Number(nextSessionRecord.workerSwapCount || 0)) + (shouldSwap ? 1 : 0),
      workerHistory: [
        ...(Array.isArray(nextSessionRecord.workerHistory) ? nextSessionRecord.workerHistory.map((entry) => cloneValue(entry)) : []),
        worker,
      ],
      lastActiveAt: attachedAt,
    });
    return {
      sessionRecord: nextSessionRecord,
      worker,
      attached: true,
      swapped: shouldSwap,
    };
  }

  function setSessionController(sessionId, controller = null) {
    const normalizedSessionId = toTrimmedString(sessionId);
    if (!normalizedSessionId) return null;
    if (!controller) {
      sessionControllers.delete(normalizedSessionId);
      return null;
    }
    sessionControllers.set(normalizedSessionId, controller);
    return controller;
  }

  function getSessionController(sessionId) {
    const normalizedSessionId = toTrimmedString(sessionId);
    return normalizedSessionId ? (sessionControllers.get(normalizedSessionId) || null) : null;
  }

  function updateThreadLifecycle(sessionRecord, status, patch = {}) {
    if (!sessionRecord?.activeThreadId) return;
    const normalizedStatus = normalizeStatus(status || sessionRecord.status);
    if (normalizedStatus === "completed") {
      threadRegistry.markThreadCompleted(sessionRecord.activeThreadId, patch);
      return;
    }
    if (normalizedStatus === "aborted") {
      threadRegistry.closeThread(sessionRecord.activeThreadId, {
        status: "aborted",
        error: patch.error || sessionRecord.lastError || "aborted",
        ...patch,
      });
      return;
    }
    if (normalizedStatus === "failed" || normalizedStatus.startsWith("approval_")) {
      threadRegistry.markThreadFailed(
        sessionRecord.activeThreadId,
        patch.error || sessionRecord.lastError || "session_failed",
        patch,
      );
      return;
    }
    threadRegistry.markThreadRunning(sessionRecord.activeThreadId, patch);
  }

  function updateSubagentLifecycle(sessionRecord, status, patch = {}) {
    if (!sessionRecord?.parentSessionId) return;
    const normalizedStatus = normalizeStatus(status || sessionRecord.status);
    if (normalizedStatus === "completed") {
      subagentControl.completeSubagent(sessionRecord.sessionId, {
        childThreadId: sessionRecord.activeThreadId,
        ...patch,
      });
      return;
    }
    if (normalizedStatus === "failed") {
      subagentControl.failSubagent(sessionRecord.sessionId, patch.lastError || sessionRecord.lastError || "session_failed", {
        childThreadId: sessionRecord.activeThreadId,
        ...patch,
      });
      return;
    }
    if (normalizedStatus === "aborted") {
      subagentControl.abortSubagent(sessionRecord.sessionId, patch.lastError || sessionRecord.lastError || "aborted", {
        childThreadId: sessionRecord.activeThreadId,
        ...patch,
      });
      return;
    }
    subagentControl.updateSubagent(sessionRecord.sessionId, {
      status: normalizedStatus,
      childThreadId: sessionRecord.activeThreadId,
      lastError: patch.lastError || sessionRecord.lastError,
      ...patch,
    });
  }

  function captureLifecycleReplay(sessionRecord, action, payload = {}) {
    return captureReplay(sessionRecord, action, payload);
  }

  function applyLifecycleState(sessionId, nextStatus, patch = {}, replay = null) {
    const current = sessions.get(toTrimmedString(sessionId));
    if (!current) return null;
    const normalizedStatus = normalizeStatus(nextStatus || current.status);
    const previousStatus = normalizeStatus(current.status);
    if (!canTransitionSessionStatus(previousStatus, normalizedStatus)) {
      patch = {
        ...patch,
        metadata: {
          ...(toPlainObject(current.metadata)),
          ...(toPlainObject(patch.metadata)),
          lifecycleTransitionOverride: `${previousStatus}->${normalizedStatus}`,
        },
      };
    }
    let next = storeSession(current, {
      ...patch,
      status: normalizedStatus,
    });
    updateThreadLifecycle(next, normalizedStatus, {
      error: patch.lastError || next.lastError,
      result: replay?.result,
      lastStageId: patch.currentStageId,
    });
    updateSubagentLifecycle(next, normalizedStatus, {
      lastError: patch.lastError || next.lastError,
      lastEventType: replay?.eventType || replay?.action || null,
    });
    if (replay?.action) {
      next = captureLifecycleReplay(next, replay.action, {
        status: normalizedStatus,
        summary: replay.summary || patch.lastError || next.lastError || null,
        result: replay.result,
        threadId: patch.activeThreadId || next.activeThreadId,
        eventType: replay.eventType || null,
        meta: replay.meta,
      });
    }
    if (isTerminalSessionStatus(normalizedStatus)) {
      setSessionController(next.sessionId, null);
    }
    return cloneValue(next);
  }

  function captureReplay(sessionRecord, action, payload = {}) {
    const snapshot = replayStore.captureSnapshot({
      sessionId: sessionRecord.sessionId,
      runId: sessionRecord.runId,
      threadId: payload.threadId || sessionRecord.activeThreadId,
      parentSessionId: sessionRecord.parentSessionId,
      parentThreadId: sessionRecord.parentThreadId,
      rootSessionId: sessionRecord.rootSessionId,
      action,
      eventType: payload.eventType || null,
      status: payload.status || sessionRecord.status,
      summary: toTrimmedString(payload.summary || payload?.result?.error || payload?.result?.status || "") || null,
      state: {
        session: sessionRecord,
        thread: sessionRecord.activeThreadId ? threadRegistry.getThread(sessionRecord.activeThreadId) : null,
        meta: toPlainObject(payload.meta),
      },
      result: payload.result ? cloneValue(payload.result) : undefined,
    });
    return storeSession(sessionRecord, { replayCursor: snapshot.snapshotId });
  }

  function createManagedCompiledSession(compiledProfile, options = {}) {
    if (!compiledProfile || typeof compiledProfile !== "object" || !Array.isArray(compiledProfile.stages)) {
      throw new Error("Compiled harness profile is required");
    }
    const mergedOptions = { ...defaultOptions, ...options };
    const parentRecord = toTrimmedString(mergedOptions.parentSessionId || "")
      ? sessions.get(toTrimmedString(mergedOptions.parentSessionId))
      : null;
    let sessionRecord = buildSessionRecord(compiledProfile, mergedOptions, parentRecord);
    const eventHook = createEventEmitter([emitManagerEvent, mergedOptions.onHarnessEvent, mergedOptions.onEvent]);
    const threadRecord = threadRegistry.registerThread({
      threadId: sessionRecord.activeThreadId,
      sessionId: sessionRecord.sessionId,
      parentThreadId: sessionRecord.parentThreadId || undefined,
      parentSessionId: sessionRecord.parentSessionId || undefined,
      rootSessionId: sessionRecord.rootSessionId,
      role: parentRecord ? "subagent" : "primary",
      kind: sessionRecord.sessionType,
      status: sessionRecord.status,
      taskKey: sessionRecord.taskKey,
      taskId: sessionRecord.taskId || undefined,
      taskTitle: sessionRecord.taskTitle || undefined,
      metadata: { sessionType: sessionRecord.sessionType, agentId: sessionRecord.agentId },
    });
    sessionRecord = storeSession(sessionRecord, { activeThreadId: threadRecord.threadId, threadIds: [threadRecord.threadId] });
    activeSessions.set(sessionRecord.sessionType || "default", sessionRecord.sessionId);
    if (parentRecord) {
      storeSession(parentRecord, { childSessionIds: [sessionRecord.sessionId] });
      subagentControl.registerSubagent({
        parentSessionId: parentRecord.sessionId,
        parentThreadId: parentRecord.activeThreadId,
        childSessionId: sessionRecord.sessionId,
        childThreadId: sessionRecord.activeThreadId,
        taskKey: sessionRecord.taskKey,
        status: sessionRecord.status,
        metadata: mergedOptions.metadata,
      });
    }
    sessionRecord = captureReplay(sessionRecord, "session_created", {
      status: sessionRecord.status,
      meta: { entryStageId: compiledProfile.entryStageId || null },
    });

    const harnessRuntime = createInternalHarnessRuntime(compiledProfile, {
      onEvent: (event) => {
        eventHook(event);
        const current = sessions.get(sessionRecord.sessionId) || sessionRecord;
        const patch = createLifecyclePatch(event, current);
        const resultThreadId = toTrimmedString(event?.result?.threadId || event?.threadId || current.activeThreadId || "");
        if (resultThreadId) {
          threadRegistry.registerThread({
            threadId: resultThreadId,
            sessionId: current.sessionId,
            parentThreadId: current.parentThreadId || undefined,
            parentSessionId: current.parentSessionId || undefined,
            rootSessionId: current.rootSessionId,
            status: patch.status || current.status,
            taskKey: current.taskKey,
            taskId: current.taskId || undefined,
            taskTitle: current.taskTitle || undefined,
            metadata: { eventType: event.type, sessionType: current.sessionType },
          });
        }
        sessionRecord = storeSession(current, {
          ...patch,
          activeThreadId: resultThreadId || current.activeThreadId,
          threadIds: resultThreadId ? [resultThreadId] : current.threadIds,
        });
        updateThreadLifecycle(sessionRecord, sessionRecord.status, { result: event.result, lastStageId: event.stageId || undefined });
        updateSubagentLifecycle(sessionRecord, sessionRecord.status, {
          childThreadId: sessionRecord.activeThreadId,
          lastError: sessionRecord.lastError,
          lastEventType: event.type,
        });
        sessionRecord = captureReplay(sessionRecord, event.type, {
          eventType: event.type,
          status: sessionRecord.status,
          result: event.result,
          threadId: resultThreadId || sessionRecord.activeThreadId,
          meta: { stageId: event.stageId || null, toStageId: event.toStageId || null, requestId: event.requestId || null },
        });
      },
      runId: mergedOptions.runId || sessionRecord.runId,
      dryRun: mergedOptions.dryRun === true,
      abortController: mergedOptions.abortController || null,
      taskKey: sessionRecord.taskKey,
      taskId: sessionRecord.taskId,
      taskTitle: sessionRecord.taskTitle,
      artifactId: mergedOptions.artifactId,
      sourceOrigin: mergedOptions.sourceOrigin,
      sourcePath: mergedOptions.sourcePath,
      approvalRepoRoot: mergedOptions.approvalRepoRoot,
      requestedBy: mergedOptions.requestedBy,
      emitApprovalResolutionEvent: mergedOptions.emitApprovalResolutionEvent,
      steerActiveTurn: typeof mergedOptions.steerActiveTurn === "function" ? mergedOptions.steerActiveTurn : undefined,
      executeTurn: resolveTurnExecutor(mergedOptions),
      extensions: mergedOptions.extensions,
      extensionRegistry: mergedOptions.extensionRegistry,
      sessionManager: mergedOptions.sessionManager || managerApi || null,
    });
    const runtimeController = harnessRuntime.session;

    let running = null;
    let subagentLease = null;
    const subagentPoolId = toTrimmedString(
      mergedOptions.subagentPoolId
      || sessionRecord.rootSessionId
      || parentRecord?.sessionId
      || sessionRecord.sessionId,
    ) || sessionRecord.sessionId;
    const subagentMaxParallel = toPositiveInteger(
      mergedOptions.subagentMaxParallel
      ?? mergedOptions.maxParallel
      ?? parentRecord?.metadata?.subagentMaxParallel
      ?? defaultOptions.subagentMaxParallel,
      0,
    ) || 0;
    const shouldUseSubagentPool =
      mergedOptions.useSubagentPool !== false
      && (
        sessionRecord.sessionType === "subagent"
        || sessionRecord.sessionType === "workflow-subagent"
        || sessionRecord.lineageDepth > 0
      );
    const agentLoop = {
      canSteer: () => runtimeController.canSteer?.() === true,
      steer: (prompt, meta = {}) => runtimeController.steer?.(prompt, meta) || {
        ok: false,
        delivered: false,
        reason: "not_steerable",
        interventionType: toTrimmedString(meta?.kind || meta?.type || "nudge") || "nudge",
        stageId: null,
        targetTaskKey: null,
      },
      abort: (reason = "aborted") => runtimeController.abort?.(reason),
      run: async () => await runtimeController.run(),
    };
    const agentLoopController = createAgentLoop({ runtimeSession: agentLoop });
    const controller = {
      abort(reason = "aborted") {
        agentLoopController.abort(reason);
        sessionRecord = storeSession(sessions.get(sessionRecord.sessionId) || sessionRecord, {
          status: "aborted",
          completedAt: nowIso(),
          lastError: toTrimmedString(reason) || "aborted",
        });
        if (sessionRecord.activeThreadId) {
          threadRegistry.closeThread(sessionRecord.activeThreadId, { status: "aborted", error: sessionRecord.lastError });
        }
        if (sessionRecord.parentSessionId) {
          subagentControl.updateSubagent(sessionRecord.sessionId, { status: "aborted", lastError: sessionRecord.lastError });
        }
        sessionRecord = captureReplay(sessionRecord, "session_aborted", { status: "aborted", summary: sessionRecord.lastError });
      },
      canSteer() {
        return agentLoopController.canSteer();
      },
      steer(prompt, meta = {}) {
        const response = agentLoopController.steer(prompt, meta);
        sessionRecord = storeSession(sessions.get(sessionRecord.sessionId) || sessionRecord, { lastActiveAt: nowIso() });
        sessionRecord = captureReplay(sessionRecord, response.delivered ? "steer_delivered" : "steer_rejected", {
          status: sessionRecord.status,
          summary: response.reason,
          meta: { prompt, ...toPlainObject(meta), delivered: response.delivered === true },
        });
        return response;
      },
      async run(runRequest = {}) {
        if (running) return running;
        if (shouldUseSubagentPool && subagentMaxParallel > 0 && !subagentLease) {
          const queuedAt = nowIso();
          subagentLease = await subagentPool.acquire({
            poolId: subagentPoolId,
            maxConcurrent: subagentMaxParallel,
            sessionId: sessionRecord.sessionId,
            threadId: sessionRecord.activeThreadId,
            parentSessionId: sessionRecord.parentSessionId,
            rootSessionId: sessionRecord.rootSessionId,
            taskKey: sessionRecord.taskKey,
            metadata: {
              sessionType: sessionRecord.sessionType,
            },
            onQueued: (lease) => {
              sessionRecord = storeSession(sessions.get(sessionRecord.sessionId) || sessionRecord, {
                status: "waiting",
                startedAt: sessionRecord.startedAt || queuedAt,
              });
              if (sessionRecord.parentSessionId) {
                subagentControl.updateSubagent(sessionRecord.sessionId, { status: "waiting" });
              }
              sessionRecord = captureReplay(sessionRecord, "subagent_slot_queued", {
                status: "waiting",
                meta: {
                  leaseId: lease.leaseId,
                  poolId: lease.poolId,
                  maxConcurrent: lease.maxConcurrent,
                },
              });
            },
          });
          sessionRecord = captureReplay(sessionRecord, "subagent_slot_acquired", {
            status: sessionRecord.status,
            meta: {
              leaseId: subagentLease.leaseId,
              poolId: subagentLease.poolId,
              maxConcurrent: subagentLease.maxConcurrent,
              queuedAt: subagentLease.queuedAt,
              acquiredAt: subagentLease.acquiredAt,
            },
          });
        }
        sessionRecord = storeSession(sessions.get(sessionRecord.sessionId) || sessionRecord, {
          status: mergedOptions.dryRun === true ? "dry_run" : "running",
          startedAt: sessionRecord.startedAt || nowIso(),
        });
        if (sessionRecord.activeThreadId) {
          threadRegistry.markThreadRunning(sessionRecord.activeThreadId);
        }
        if (sessionRecord.parentSessionId) {
          subagentControl.updateSubagent(sessionRecord.sessionId, { status: sessionRecord.status });
        }
        sessionRecord = captureReplay(sessionRecord, "session_run_requested", { status: sessionRecord.status });
        running = agentLoopController.run(runRequest)
          .then((result) => {
            const nextStatus = normalizeStatus(result?.status || (result?.success === false ? "failed" : "completed"));
            sessionRecord = storeSession(sessions.get(sessionRecord.sessionId) || sessionRecord, {
              status: nextStatus,
              completedAt: nowIso(),
              lastError: toTrimmedString(result?.error || "") || null,
            });
            if (sessionRecord.activeThreadId) {
              if (result?.success === false) {
                threadRegistry.markThreadFailed(sessionRecord.activeThreadId, result?.error || nextStatus, { result });
              } else {
                threadRegistry.markThreadCompleted(sessionRecord.activeThreadId, { result });
              }
            }
            if (sessionRecord.parentSessionId) {
              subagentControl.updateSubagent(sessionRecord.sessionId, { status: nextStatus, lastError: sessionRecord.lastError });
            }
            sessionRecord = captureReplay(sessionRecord, result?.success === false ? "session_failed" : "session_completed", {
              status: nextStatus,
              result,
            });
            return result;
          })
          .catch((error) => {
            sessionRecord = storeSession(sessions.get(sessionRecord.sessionId) || sessionRecord, {
              status: "failed",
              completedAt: nowIso(),
              lastError: String(error?.message || error || "Harness session failed"),
            });
            if (sessionRecord.activeThreadId) {
              threadRegistry.markThreadFailed(sessionRecord.activeThreadId, sessionRecord.lastError);
            }
            if (sessionRecord.parentSessionId) {
              subagentControl.updateSubagent(sessionRecord.sessionId, { status: "failed", lastError: sessionRecord.lastError });
            }
            sessionRecord = captureReplay(sessionRecord, "session_failed", { status: "failed", summary: sessionRecord.lastError });
            throw error;
          })
          .finally(() => {
            if (subagentLease) {
              subagentPool.release(subagentLease, {
                status: sessionRecord.status,
                error: sessionRecord.lastError,
              });
              sessionRecord = captureReplay(sessionRecord, "subagent_slot_released", {
                status: sessionRecord.status,
                summary: sessionRecord.lastError,
                meta: {
                  leaseId: subagentLease.leaseId,
                  poolId: subagentLease.poolId,
                },
              });
              subagentLease = null;
            }
            running = null;
          });
        return running;
      },
    };

    const managedSession = {
      agentId: compiledProfile.agentId || "",
      sessionId: sessionRecord.sessionId,
      threadId: sessionRecord.activeThreadId,
      compiledProfile,
      compiledProfileJson: JSON.stringify(compiledProfile, null, 2),
      validationReport: { errors: [], warnings: [], stats: compiledProfile.metadata || {} },
      isValid: true,
      controller,
      runtimeController,
      get session() {
        return getSessionRecord(sessionRecord.sessionId);
      },
      get replay() {
        return replayStore.buildResumeState(sessionRecord.sessionId);
      },
      get sessionContract() {
        return createSessionContract(sessions.get(sessionRecord.sessionId) || sessionRecord);
      },
      canSteer: () => controller.canSteer(),
      steer: (prompt, meta = {}) => controller.steer(prompt, meta),
      abort: (reason = "aborted") => controller.abort(reason),
      run: (runRequest = {}) => controller.run(runRequest),
      getSessionRecord: () => getSessionRecord(sessionRecord.sessionId),
      listReplaySnapshots: (replayOptions = {}) => replayStore.listSnapshots(sessionRecord.sessionId, replayOptions),
      getReplayState: (replayOptions = {}) => replayStore.buildResumeState(sessionRecord.sessionId, replayOptions),
      listChildSessions: () => subagentControl.listChildren({ parentSessionId: sessionRecord.sessionId }),
    };
    setSessionController(sessionRecord.sessionId, managedSession);
    return managedSession;
  }

  function createManagedSession(profileSource, options = {}) {
    const compiled = compileProfileSource(profileSource, options);
    if (!compiled?.isValid || !compiled?.compiledProfile) {
      const error = new Error(formatHarnessValidationError(compiled?.validationReport));
      error.validationReport = compiled?.validationReport || { errors: [], warnings: [], stats: {} };
      throw error;
    }
    return {
      ...createManagedCompiledSession(compiled.compiledProfile, options),
      ...compiled,
    };
  }

  managerApi = {
    createCompiledSession: createManagedCompiledSession,
    createSession: createManagedSession,
    async runCompiledSession(compiledProfile, options = {}) {
      const session = createManagedCompiledSession(compiledProfile, options);
      const result = await session.run();
      return { ...session, result };
    },
    async runSession(profileSource, options = {}) {
      const session = createManagedSession(profileSource, options);
      const result = await session.run();
      return { ...session, result };
    },
    getSession(sessionId) {
      return getSessionRecord(sessionId);
    },
    listSessions(filters = {}) {
      return [...sessions.values()]
        .filter((record) => {
          if (toTrimmedString(filters.scope) && toTrimmedString(record.scope) !== toTrimmedString(filters.scope)) return false;
          if (toTrimmedString(filters.status) && normalizeStatus(record.status) !== normalizeStatus(filters.status)) return false;
          if (toTrimmedString(filters.sessionType) && toTrimmedString(record.sessionType) !== toTrimmedString(filters.sessionType)) return false;
          if (toTrimmedString(filters.taskKey) && toTrimmedString(record.taskKey) !== toTrimmedString(filters.taskKey)) return false;
          if (toTrimmedString(filters.parentSessionId) && toTrimmedString(record.parentSessionId) !== toTrimmedString(filters.parentSessionId)) return false;
          return true;
        })
        .map((record) => cloneValue(record));
    },
    switchSession(sessionId, scope = "default") {
      const normalized = toTrimmedString(sessionId);
      if (!normalized) return null;
      const scopeOptions = typeof scope === "object" && scope !== null ? scope : { scope };
      const normalizedScope = toTrimmedString(scopeOptions.scope || "default") || "default";
      if (!sessions.has(normalized)) {
        this.ensureSession({
          ...scopeOptions,
          sessionId: normalized,
        });
      }
      activeSessions.set(normalizedScope, normalized);
      return getSessionRecord(normalized);
    },
    setActiveSession(sessionId, scope = "default") {
      return this.switchSession(sessionId, scope);
    },
    getActiveSession(scope = "default") {
      const sessionId = activeSessions.get(toTrimmedString(scope || "default") || "default");
      return sessionId ? getSessionRecord(sessionId) : null;
    },
    getActiveSessionId(scope = "default") {
      return this.getActiveSession(scope)?.sessionId || null;
    },
    clearActiveSession(scope = "default") {
      activeSessions.delete(toTrimmedString(scope || "default") || "default");
      return true;
    },
    createSubagentSession(profileSourceOrCompiled, options = {}) {
      const nextOptions = { ...options, sessionType: options.sessionType || "subagent" };
      if (profileSourceOrCompiled && Array.isArray(profileSourceOrCompiled.stages)) {
        return createManagedCompiledSession(profileSourceOrCompiled, nextOptions);
      }
      return createManagedSession(profileSourceOrCompiled, nextOptions);
    },
    ensureSession(input = {}) {
      const sessionId = toTrimmedString(input.sessionId || input.id || "");
      if (sessionId && sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        const patched = storeSession(existing, {
          scope: input.scope || existing.scope || "default",
          sessionType: input.sessionType || existing.sessionType || "primary",
          taskKey: input.taskKey || existing.taskKey,
          status: input.status || existing.status || "idle",
          activeThreadId: toTrimmedString(input.threadId || existing.activeThreadId || "") || null,
          threadIds: input.threadId ? [input.threadId] : existing.threadIds,
          metadata: {
            ...(toPlainObject(existing.metadata)),
            ...(toPlainObject(input.metadata)),
            cwd: input.cwd || existing.metadata?.cwd || "",
            providerSelection: input.providerSelection || existing.metadata?.providerSelection || "",
            adapterName: input.adapterName || existing.metadata?.adapterName || "",
          },
        });
        if (patched.activeThreadId) {
          threadRegistry.registerThread({
            threadId: patched.activeThreadId,
            sessionId: patched.sessionId,
            parentThreadId: patched.parentThreadId || undefined,
            parentSessionId: patched.parentSessionId || undefined,
            rootSessionId: patched.rootSessionId,
            status: patched.status,
            kind: patched.sessionType,
            taskKey: patched.taskKey || undefined,
            metadata: patched.metadata,
          });
        }
        return cloneValue(patched);
      }
      const createdAt = nowIso();
      const record = {
        sessionId: sessionId || createSessionId(input.sessionType || "session"),
        runId: sessionId || createSessionId("run"),
        scope: toTrimmedString(input.scope || "default") || "default",
        taskKey: toTrimmedString(input.taskKey || sessionId || ""),
        taskId: null,
        taskTitle: null,
        sessionType: toTrimmedString(input.sessionType || "primary") || "primary",
        status: normalizeStatus(input.status || "idle"),
        createdAt,
        updatedAt: createdAt,
        lastActiveAt: createdAt,
        startedAt: null,
        completedAt: null,
        lastError: null,
        activeThreadId: toTrimmedString(input.threadId || "") || null,
        threadIds: uniqueStrings(input.threadId ? [input.threadId] : []),
        childSessionIds: [],
        parentSessionId: null,
        parentThreadId: null,
        rootSessionId: sessionId || null,
        lineageDepth: 0,
        agentId: "",
        profileName: toTrimmedString(input.scope || input.sessionType || "session") || "session",
        entryStageId: "",
        replayCursor: null,
        executionCount: 0,
        workerGeneration: 0,
        workerSwapCount: 0,
        activeWorkerId: null,
        activeWorker: null,
        workerHistory: [],
        metadata: {
          ...(toPlainObject(input.metadata)),
          cwd: input.cwd || "",
          providerSelection: input.providerSelection || "",
          adapterName: input.adapterName || "",
          scope: input.scope || "default",
        },
      };
      sessions.set(record.sessionId, record);
      if (record.activeThreadId) {
        threadRegistry.registerThread({
          threadId: record.activeThreadId,
          sessionId: record.sessionId,
          status: record.status,
          kind: record.sessionType,
          taskKey: record.taskKey || undefined,
          metadata: record.metadata,
        });
      }
      return cloneValue(record);
    },
    createChildSession(parentSessionId, input = {}) {
      const parent = toTrimmedString(parentSessionId) ? sessions.get(toTrimmedString(parentSessionId)) : null;
      if (!parent) return null;
      const child = this.ensureSession({
        ...input,
        parentSessionId: parent.sessionId,
        sessionType: input.sessionType || "subagent",
      });
      const patchedChild = storeSession(sessions.get(child.sessionId) || child, {
        parentSessionId: parent.sessionId,
        parentThreadId: toTrimmedString(input.parentThreadId || parent.activeThreadId || "") || null,
        rootSessionId: parent.rootSessionId || parent.sessionId,
        lineageDepth: Number(parent.lineageDepth || 0) + 1,
      });
      storeSession(parent, { childSessionIds: [patchedChild.sessionId] });
      subagentControl.registerSubagent({
        parentSessionId: parent.sessionId,
        parentThreadId: parent.activeThreadId,
        childSessionId: patchedChild.sessionId,
        childThreadId: patchedChild.activeThreadId,
        taskKey: patchedChild.taskKey,
        status: patchedChild.status,
        metadata: input.metadata,
      });
      captureLifecycleReplay(sessions.get(patchedChild.sessionId) || patchedChild, "child_session_created", {
        status: patchedChild.status,
        threadId: patchedChild.activeThreadId,
        meta: {
          parentSessionId: parent.sessionId,
          parentThreadId: parent.activeThreadId,
        },
      });
      return cloneValue(patchedChild);
    },
    beginExternalSession(input = {}) {
      const normalizedSessionId = toTrimmedString(input.sessionId || input.id || input.taskKey || "");
      if (!normalizedSessionId) {
        throw new Error("beginExternalSession requires a sessionId or taskKey");
      }
      const record = input.parentSessionId
        ? this.createChildSession(input.parentSessionId, {
            ...input,
            sessionId: normalizedSessionId,
            sessionType: input.sessionType || "task",
          })
        : this.ensureSession({
            ...input,
            sessionId: normalizedSessionId,
            sessionType: input.sessionType || "task",
          });
      const current = sessions.get(record.sessionId) || record;
      const next = captureLifecycleReplay(current, "external_session_bound", {
        status: current.status,
        threadId: current.activeThreadId,
        meta: {
          source: input.source || "external",
          scope: input.scope || "task",
        },
      });
      return cloneValue(next);
    },
    registerExecution(sessionId, execution = {}) {
      const existing = this.ensureSession({
        sessionId,
        sessionType: execution.sessionType || "primary",
        taskKey: execution.taskKey || sessionId,
        threadId: execution.threadId || null,
        metadata: {
          ...(toPlainObject(execution.metadata)),
          cwd: execution.cwd || "",
          providerSelection: execution.providerSelection || "",
          adapterName: execution.adapterName || "",
          scope: execution.scope || "default",
        },
      });
      let next = storeSession(sessions.get(existing.sessionId) || existing, {
        status: normalizeStatus(execution.status || existing.status || "active"),
        lastError: toTrimmedString(execution.error || existing.lastError || "") || null,
        lastActiveAt: nowIso(),
      });
      const workerAttachment = attachExecutionWorker(next, execution);
      next = workerAttachment?.sessionRecord || next;
      if (next.activeThreadId) {
        threadRegistry.registerThread({
          threadId: next.activeThreadId,
          sessionId: next.sessionId,
          parentThreadId: next.parentThreadId || undefined,
          parentSessionId: next.parentSessionId || undefined,
          rootSessionId: next.rootSessionId,
          status: next.status,
          kind: next.sessionType,
          taskKey: next.taskKey || undefined,
          metadata: {
            ...(toPlainObject(next.metadata)),
            providerSelection: execution.providerSelection || "",
            adapterName: execution.adapterName || "",
          },
        });
      }
      const recorded = captureLifecycleReplay(next, "execution_registered", {
        status: next.status,
        threadId: next.activeThreadId,
        meta: {
          workerId: workerAttachment?.worker?.workerId || next.activeWorkerId || null,
          workerAttached: workerAttachment?.attached === true,
          workerSwapped: workerAttachment?.swapped === true,
          providerSelection: execution.providerSelection || "",
          adapterName: execution.adapterName || "",
        },
      });
      return cloneValue(recorded);
    },
    continueSession(sessionId, input = {}) {
      const normalizedSessionId = toTrimmedString(sessionId);
      const managed = sessions.get(normalizedSessionId);
      if (!managed) {
        throw new Error(`Unknown session "${sessionId}"`);
      }
      const lifecycleState = input.lifecycleState || "running";
      const next = applyLifecycleState(normalizedSessionId, lifecycleState, {
        lastActiveAt: nowIso(),
      }, {
        action: "session_continue_requested",
        meta: { action: input.action || "continue" },
      });
      const controller = getSessionController(normalizedSessionId);
      const runPrompt = toTrimmedString(
        input?.runRequest?.prompt
        || input?.runRequest?.message
        || input?.runRequest?.userMessage
        || "",
      );
      if (controller?.run && runPrompt) {
        return controller.run({
          ...(toPlainObject(input.runRequest)),
          sessionId: normalizedSessionId,
          action: input.action || "continue",
          lifecycleState,
        });
      }
      return next || cloneValue(managed);
    },
    retrySession(sessionId, input = {}) {
      return this.continueSession(sessionId, {
        ...input,
        lifecycleState: "retrying",
        action: "retry",
      });
    },
    resumeSession(sessionId, input = {}) {
      return this.continueSession(sessionId, {
        ...input,
        lifecycleState: "resuming",
        action: "resume",
      });
    },
    cancelSession(sessionId, reason = "aborted") {
      const normalizedSessionId = toTrimmedString(sessionId);
      const controller = getSessionController(normalizedSessionId);
      if (controller?.abort) {
        controller.abort(reason);
      }
      return applyLifecycleState(normalizedSessionId, "aborted", {
        completedAt: nowIso(),
        lastError: toTrimmedString(reason) || "aborted",
      }, {
        action: "session_aborted",
        summary: reason,
      });
    },
    finalizeExternalExecution(sessionId, execution = {}) {
      const normalizedSessionId = toTrimmedString(sessionId);
      const managed = sessions.get(normalizedSessionId);
      if (!managed) {
        throw new Error(`Unknown session "${sessionId}"`);
      }
      const nextStatus = normalizeStatus(
        execution.status || (execution.success === false ? "failed" : "completed"),
        execution.success === false ? "failed" : "completed",
      );
      let finalizedWorkerSession = finalizeActiveWorkerRecord(managed, {
        status: nextStatus,
        detachedAt: nowIso(),
        lastError: execution.success === false
          ? toTrimmedString(execution.error || managed.lastError || "execution_failed") || "execution_failed"
          : null,
        result: execution.result || null,
        metadata: {
          completionStatus: nextStatus,
        },
      });
      if (!finalizedWorkerSession) {
        finalizedWorkerSession = managed;
      }
      const next = applyLifecycleState(normalizedSessionId, nextStatus, {
        activeThreadId: toTrimmedString(execution.threadId || managed.activeThreadId || "") || managed.activeThreadId,
        threadIds: execution.threadId ? [execution.threadId] : finalizedWorkerSession.threadIds,
        completedAt: isTerminalSessionStatus(nextStatus) ? nowIso() : managed.completedAt,
        lastError: execution.success === false ? toTrimmedString(execution.error || managed.lastError || "execution_failed") || "execution_failed" : null,
        lastActiveAt: nowIso(),
        activeWorkerId: null,
        activeWorker: null,
        workerHistory: finalizedWorkerSession.workerHistory,
        executionCount: finalizedWorkerSession.executionCount,
        workerGeneration: finalizedWorkerSession.workerGeneration,
        workerSwapCount: finalizedWorkerSession.workerSwapCount,
      }, {
        action: execution.success === false ? "external_execution_failed" : "external_execution_completed",
        summary: execution.error || execution.status || null,
        result: execution.result || null,
        meta: {
          workerId: managed.activeWorkerId || null,
        },
      });
      return next;
    },
    waitForSubagent(childSessionIdOrSpawnId, options = {}) {
      return subagentControl.waitForSubagent(childSessionIdOrSpawnId, options);
    },
    getSessionController(sessionId) {
      return getSessionController(sessionId);
    },
    bindExternalController(sessionId, controller = {}) {
      const normalizedSessionId = toTrimmedString(sessionId);
      if (!normalizedSessionId) return null;
      const normalizedController = {
        ...(typeof controller === "object" && controller !== null ? controller : {}),
      };
      if (
        typeof normalizedController.run !== "function"
        && typeof normalizedController.abort !== "function"
        && typeof normalizedController.steer !== "function"
      ) {
        throw new Error("bindExternalController requires at least one run, abort, or steer function");
      }
      setSessionController(normalizedSessionId, normalizedController);
      const managed = sessions.get(normalizedSessionId);
      if (!managed) {
        return normalizedController;
      }
      const next = captureLifecycleReplay(managed, "external_controller_bound", {
        status: managed.status,
        threadId: managed.activeThreadId,
        meta: {
          capabilities: {
            run: typeof normalizedController.run === "function",
            abort: typeof normalizedController.abort === "function",
            steer: typeof normalizedController.steer === "function",
          },
        },
      });
      return cloneValue(next);
    },
    clearSessionController(sessionId) {
      const normalizedSessionId = toTrimmedString(sessionId);
      if (!normalizedSessionId) return false;
      setSessionController(normalizedSessionId, null);
      return true;
    },
    spawnSubagent(profileSourceOrCompiled, options = {}) {
      return this.createSubagentSession(profileSourceOrCompiled, options);
    },
    getThreadRegistry() {
      return threadRegistry;
    },
    getReplayStore() {
      return replayStore;
    },
    getSubagentControl() {
      return subagentControl;
    },
    getSubagentPool() {
      return subagentPool;
    },
    getLineageGraph() {
      return createLineageGraph({
        sessions: this.listSessions(),
        threads: threadRegistry.listThreads ? threadRegistry.listThreads() : [],
        subagents: subagentControl.listSpawnRecords ? subagentControl.listSpawnRecords() : subagentControl.listChildren(),
      });
    },
    getLineageView(sessionId) {
      return this.getLineageGraph().describe(sessionId);
    },
    getReplaySnapshot(sessionId, options = {}) {
      const session = sessionId ? this.getSession(sessionId) : null;
      const tracker = getSessionTracker();
      const tracked = sessionId && typeof tracker?.getSession === "function"
        ? tracker.getSession(sessionId)
        : null;
      const replayState = replayStore.buildResumeState(sessionId, options);
      const childSessions = session?.sessionId
        ? subagentControl.listChildren({ parentSessionId: session.sessionId })
        : [];
      const thread = session?.activeThreadId
        ? threadRegistry.getThread(session.activeThreadId)
        : null;
      return {
        sessionId: toTrimmedString(session?.sessionId || sessionId || "") || null,
        taskKey: toTrimmedString(session?.taskKey || tracked?.taskId || sessionId || "") || null,
        status: session?.status || tracked?.status || replayState?.latestSnapshot?.status || "idle",
        createdAt: session?.createdAt || tracked?.createdAt || null,
        lastActiveAt: session?.lastActiveAt || tracked?.lastActiveAt || null,
        replayable: true,
        thread,
        activeWorker: session?.activeWorker ? cloneValue(session.activeWorker) : null,
        workerHistory: Array.isArray(session?.workerHistory) ? session.workerHistory.map((entry) => cloneValue(entry)) : [],
        lineage: {
          parentSessionId: session?.parentSessionId || null,
          childSessionIds: childSessions
            .map((entry) => toTrimmedString(entry?.childSessionId || ""))
            .filter(Boolean),
        },
        messages: Array.isArray(tracked?.messages)
          ? tracked.messages.map((message, index) => ({
              index,
              role: toTrimmedString(message?.role || message?.type || "message") || "message",
              type: toTrimmedString(message?.type || message?.role || "message") || "message",
              content: String(message?.content || message?.summary || message?.text || ""),
              timestamp: toTrimmedString(message?.timestamp || message?.createdAt || "") || null,
              meta: toPlainObject(message?.meta),
            }))
          : [],
        replayState,
        sessionContract: session?.sessionId ? createSessionContract(session) : null,
      };
    },
    getReplayState(sessionId, options = {}) {
      return replayStore.buildResumeState(sessionId, options);
    },
    snapshot() {
      return {
        sessions: this.listSessions(),
        activeSessions: Object.fromEntries(activeSessions.entries()),
        threadRegistry: threadRegistry.snapshot(),
        replayStore: replayStore.snapshot(),
        subagentControl: subagentControl.snapshot(),
        subagentPool: subagentPool.snapshot(),
      };
    },
  };
  return managerApi;
}

const defaultHarnessSessionManager = createInternalSessionManager();

export function getDefaultHarnessSessionManager() {
  return defaultHarnessSessionManager;
}

export function getBosunSessionManager() {
  return defaultHarnessSessionManager;
}

export function createCompiledHarnessSession(compiledProfile, options = {}) {
  return (options.sessionManager || defaultHarnessSessionManager).createCompiledSession(compiledProfile, options);
}

export function createHarnessSession(profileSource, options = {}) {
  return (options.sessionManager || defaultHarnessSessionManager).createSession(profileSource, options);
}

export async function runCompiledHarnessSession(compiledProfile, options = {}) {
  return (options.sessionManager || defaultHarnessSessionManager).runCompiledSession(compiledProfile, options);
}

export async function runHarnessSession(profileSource, options = {}) {
  return (options.sessionManager || defaultHarnessSessionManager).runSession(profileSource, options);
}

export function createHarnessSessionManager(defaultOptions = {}) {
  return createInternalSessionManager(defaultOptions);
}

export const createBosunSessionManager = createHarnessSessionManager;

export default createHarnessSessionManager;
