import {
  cloneExecutionStateValue,
  createInheritedExecutionStateScopes,
  getExecutionStateScopeEntry,
  getExecutionStateScopeValue,
  mergeExecutionStateValues,
  normalizeExecutionStateScopes,
  updateExecutionStateScope,
} from "../workspace/shared-state-manager.mjs";

function ensureWorkflowRuntimeState(ctx) {
  if (!ctx || typeof ctx !== "object") return {};
  if (!ctx.__workflowRuntimeState || typeof ctx.__workflowRuntimeState !== "object") {
    ctx.__workflowRuntimeState = {};
  }
  return ctx.__workflowRuntimeState;
}

function normalizeLineageText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function collectLegacyGlobalScopeState(ctx) {
  return {
    workflowParentRunId: normalizeLineageText(ctx?.data?._workflowParentRunId),
    workflowRootRunId: normalizeLineageText(ctx?.data?._workflowRootRunId || ctx?.id),
    workflowSessionId: normalizeLineageText(ctx?.data?._workflowSessionId),
    workflowParentSessionId: normalizeLineageText(ctx?.data?._workflowParentSessionId),
    workflowRootSessionId: normalizeLineageText(ctx?.data?._workflowRootSessionId),
    workflowDelegationDepth: Number(ctx?.data?._workflowDelegationDepth || 0) || 0,
    delegatedSessionIds: Array.isArray(ctx?.data?._delegatedSessionIds)
      ? ctx.data._delegatedSessionIds.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [],
  };
}

function parseDelegationEventTime(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function normalizeDelegationEvent(event = {}) {
  return {
    ...event,
    type: String(event?.type || event?.eventType || "").trim() || "unknown",
    eventType: String(event?.eventType || event?.type || "").trim() || "unknown",
    at: Number(event?.at) || Date.now(),
    timestamp: event?.timestamp || new Date().toISOString(),
  };
}

function composeDelegationTrail(entry = {}) {
  return normalizeDelegationTrail([
    ...(Array.isArray(entry?.inherited?.delegationAuditTrail) ? entry.inherited.delegationAuditTrail : []),
    ...(Array.isArray(entry?.current?.delegationAuditTrail) ? entry.current.delegationAuditTrail : []),
  ]);
}

function composeDelegationGuardMap(entry = {}) {
  return normalizeDelegationGuardMap({
    ...(entry?.inherited?.delegationTransitionGuards || {}),
    ...(entry?.current?.delegationTransitionGuards || {}),
  });
}

function syncExecutionStateScopes(ctx, scopes) {
  const normalized = normalizeExecutionStateScopes(scopes);
  const runtimeState = ensureWorkflowRuntimeState(ctx);
  runtimeState.executionStateScopes = normalized;

  const streamEntry = getExecutionStateScopeEntry(normalized, "stream");
  const executionEntry = getExecutionStateScopeEntry(normalized, "execution");
  const globalView = getExecutionStateScopeValue(normalized, "global");
  const delegationTrail = composeDelegationTrail(streamEntry);
  const delegationTransitionGuards = composeDelegationGuardMap(streamEntry);
  const transitionResults =
    executionEntry?.current?.delegationTransitionResults && typeof executionEntry.current.delegationTransitionResults === "object"
      ? executionEntry.current.delegationTransitionResults
      : {};

  runtimeState.delegationAuditTrail = delegationTrail;
  runtimeState.delegationTransitionResults = transitionResults;

  if (ctx?.data && typeof ctx.data === "object") {
    ctx.data._executionStateScopes = cloneExecutionStateValue(normalized);
    ctx.data.executionStateScopes = cloneExecutionStateValue(normalized);
    ctx.data._delegationAuditTrail = delegationTrail.map((entry) => ({ ...entry }));
    ctx.data._workflowDelegationTrail = delegationTrail.map((entry) => ({ ...entry }));
    ctx.data._delegationTrail = delegationTrail.map((entry) => ({ ...entry }));
    ctx.data._delegationTransitionGuards = { ...delegationTransitionGuards };
    if (globalView.workflowParentRunId) ctx.data._workflowParentRunId = globalView.workflowParentRunId;
    if (globalView.workflowRootRunId) ctx.data._workflowRootRunId = globalView.workflowRootRunId;
    if (globalView.workflowSessionId) ctx.data._workflowSessionId = globalView.workflowSessionId;
    if (globalView.workflowParentSessionId) ctx.data._workflowParentSessionId = globalView.workflowParentSessionId;
    if (globalView.workflowRootSessionId) ctx.data._workflowRootSessionId = globalView.workflowRootSessionId;
    if (Number.isFinite(Number(globalView.workflowDelegationDepth))) {
      ctx.data._workflowDelegationDepth = Number(globalView.workflowDelegationDepth);
    }
    if (Array.isArray(globalView.delegatedSessionIds)) {
      ctx.data._delegatedSessionIds = globalView.delegatedSessionIds.map((entry) => String(entry || "").trim()).filter(Boolean);
    }
  }

  return normalized;
}

export function ensureExecutionStateScopes(ctx) {
  const runtimeState = ensureWorkflowRuntimeState(ctx);
  const hasSerializedScopes = Boolean(
    runtimeState.executionStateScopes
    || ctx?.data?._executionStateScopes
    || ctx?.data?.executionStateScopes,
  );
  let scopes = normalizeExecutionStateScopes(
    runtimeState.executionStateScopes ??
    ctx?.data?._executionStateScopes ??
    ctx?.data?.executionStateScopes ??
    {},
  );

  const currentTrail = composeDelegationTrail(getExecutionStateScopeEntry(scopes, "stream"));
  const runtimeTrail = normalizeDelegationTrail(runtimeState.delegationAuditTrail);
  const shouldImportRuntimeTrail =
    runtimeTrail.length > 0
    && JSON.stringify(runtimeTrail) !== JSON.stringify(currentTrail);
  const legacyTrail = normalizeDelegationTrail(
    shouldImportRuntimeTrail
      ? runtimeTrail
      : (
        hasSerializedScopes
          ? []
          : (
            ctx?.data?._delegationAuditTrail ??
            ctx?.data?._workflowDelegationTrail ??
            ctx?.data?._delegationTrail
          )
      ),
  );
  const legacyGuards = normalizeDelegationGuardMap(
    hasSerializedScopes ? {} : ctx?.data?._delegationTransitionGuards,
  );
  const legacyTransitionResults =
    runtimeState.delegationTransitionResults && typeof runtimeState.delegationTransitionResults === "object"
      ? runtimeState.delegationTransitionResults
      : {};
  const legacyGlobal = collectLegacyGlobalScopeState(ctx);

  const streamLegacyPatch = {};
  if (legacyTrail.length > 0) streamLegacyPatch.delegationAuditTrail = legacyTrail;
  if (Object.keys(legacyGuards).length > 0) streamLegacyPatch.delegationTransitionGuards = legacyGuards;
  if (Object.keys(streamLegacyPatch).length > 0) {
    scopes = updateExecutionStateScope(scopes, "stream", (current) => mergeExecutionStateValues(current, streamLegacyPatch), { merge: true });
  }
  if (Object.keys(legacyTransitionResults).length > 0) {
    scopes = updateExecutionStateScope(scopes, "execution", (current) => mergeExecutionStateValues(current, {
      delegationTransitionResults: legacyTransitionResults,
    }), { merge: true });
  }
  scopes = updateExecutionStateScope(scopes, "global", (current) => mergeExecutionStateValues(current, legacyGlobal), {
    merge: true,
    force: true,
  });

  return syncExecutionStateScopes(ctx, scopes);
}

function getDelegationStreamEntry(ctx) {
  return getExecutionStateScopeEntry(ensureExecutionStateScopes(ctx), "stream");
}

function getDelegationGlobalState(ctx) {
  return getExecutionStateScopeValue(ensureExecutionStateScopes(ctx), "global");
}

function getWritableDelegationTransitionStore(ctx) {
  const scopes = ensureExecutionStateScopes(ctx);
  const executionEntry = scopes.execution;
  if (!executionEntry.current.delegationTransitionResults || typeof executionEntry.current.delegationTransitionResults !== "object") {
    executionEntry.current.delegationTransitionResults = {};
  }
  return syncExecutionStateScopes(ctx, scopes).execution.current.delegationTransitionResults;
}

export function buildDelegatedExecutionStateSnapshot(ctx, options = {}) {
  const scopes = ensureExecutionStateScopes(ctx);
  const parentExecution = getExecutionStateScopeValue(scopes, "execution");
  const parentStreamEntry = getExecutionStateScopeEntry(scopes, "stream");
  const parentGlobal = getExecutionStateScopeValue(scopes, "global");
  const childGlobal = mergeExecutionStateValues(parentGlobal, {
    workflowParentRunId: normalizeLineageText(options.parentRunId || ctx?.id),
    workflowRootRunId: normalizeLineageText(options.rootRunId || parentGlobal.workflowRootRunId || ctx?.id),
    workflowSessionId: normalizeLineageText(options.childSessionId || parentGlobal.workflowSessionId),
    workflowParentSessionId: normalizeLineageText(options.parentSessionId || parentGlobal.workflowSessionId || ctx?.data?._workflowSessionId),
    workflowRootSessionId: normalizeLineageText(options.rootSessionId || parentGlobal.workflowRootSessionId || ctx?.data?._workflowRootSessionId),
    workflowDelegationDepth: Number(options.delegationDepth ?? ((Number(parentGlobal.workflowDelegationDepth || 0) || 0) + 1)) || 0,
    delegatedSessionIds: Array.from(new Set([
      ...(Array.isArray(parentGlobal.delegatedSessionIds) ? parentGlobal.delegatedSessionIds : []),
      normalizeLineageText(options.childSessionId),
    ].filter(Boolean))),
  });

  return createInheritedExecutionStateScopes(scopes, {
    execution: {
      current: {
        executionMetadata: {
          source: "workflow-delegation",
          workflowId: normalizeLineageText(options.workflowId),
          nodeId: normalizeLineageText(options.nodeId),
          childSessionId: normalizeLineageText(options.childSessionId),
        },
      },
      inherited: {
        parentExecution,
      },
      writable: true,
    },
    stream: {
      current: {
        delegationAuditTrail: [],
        delegationTransitionGuards: {},
      },
      inherited: {
        delegationAuditTrail: composeDelegationTrail(parentStreamEntry),
        delegationTransitionGuards: composeDelegationGuardMap(parentStreamEntry),
      },
      writable: true,
    },
    global: {
      current: childGlobal,
      inherited: {},
      writable: false,
      metadata: {
        source: "workflow-delegation",
        readOnlySnapshot: true,
      },
    },
  });
}

export function normalizeDelegationTrail(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({ ...entry }))
    .sort((left, right) => parseDelegationEventTime(left?.at || left?.timestamp) - parseDelegationEventTime(right?.at || right?.timestamp));
}

export function normalizeDelegationGuardMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([key, value]) => String(key || "").trim() && value && typeof value === "object")
      .map(([key, value]) => [String(key).trim(), { ...value }]),
  );
}

export function getDelegationTransitionGuard(ctx, key) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return null;
  const guards = composeDelegationGuardMap(getDelegationStreamEntry(ctx));
  return guards[normalizedKey] ? { ...guards[normalizedKey] } : null;
}

export function setDelegationTransitionGuard(ctx, key, value = {}) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey || !ctx || typeof ctx !== "object") return null;
  if (!ctx.data || typeof ctx.data !== "object") ctx.data = {};
  const scopes = ensureExecutionStateScopes(ctx);
  const streamEntry = scopes.stream;
  const guards = normalizeDelegationGuardMap(streamEntry.current.delegationTransitionGuards);
  const nextValue = { ...value, transitionKey: value?.transitionKey || normalizedKey };
  guards[normalizedKey] = nextValue;
  streamEntry.current.delegationTransitionGuards = guards;
  syncExecutionStateScopes(ctx, scopes);
  return { ...nextValue };
}

export function extractDelegationGuardMap(detail, run = null) {
  return normalizeDelegationGuardMap(
    detail?.data?._delegationTransitionGuards ??
    run?.detail?.data?._delegationTransitionGuards ??
    run?.delegationTransitionGuards,
  );
}

export function getDelegationAuditTrail(ctx) {
  return composeDelegationTrail(getDelegationStreamEntry(ctx));
}

export function appendDelegationAuditEvent(ctx, event = {}) {
  if (!ctx || !event || typeof event !== "object") return [];
  const scopes = ensureExecutionStateScopes(ctx);
  const streamEntry = scopes.stream;
  const localTrail = normalizeDelegationTrail(streamEntry.current.delegationAuditTrail);
  const trail = composeDelegationTrail(streamEntry);
  const normalized = normalizeDelegationEvent(event);
  const transitionKey = String(normalized.transitionKey || normalized.idempotencyKey || "").trim();
  if (transitionKey) {
    const existing = trail.find((entry) => String(entry?.transitionKey || entry?.idempotencyKey || "").trim() === transitionKey);
    if (existing) return trail;
  }
  const ownerMismatchKey = `${normalized.type}:${normalized.taskId || ""}:${normalized.claimToken || ""}:${normalized.instanceId || ""}`;
  if (normalized.type === "owner-mismatch") {
    const exists = trail.some((entry) => `${entry?.type || "unknown"}:${entry?.taskId || ""}:${entry?.claimToken || ""}:${entry?.instanceId || ""}` === ownerMismatchKey);
    if (exists) return trail;
  }
  streamEntry.current.delegationAuditTrail = normalizeDelegationTrail([...localTrail, normalized]);
  const nextTrail = composeDelegationTrail(streamEntry);
  syncExecutionStateScopes(ctx, scopes);
  return nextTrail;
}

export function recordDelegationEvent(ctx, event = {}) {
  if (!ctx || typeof ctx !== "object") {
    return {
      ...normalizeDelegationEvent(event),
      recorded: false,
    };
  }
  if (!ctx.data || typeof ctx.data !== "object") ctx.data = {};
  const entry = normalizeDelegationEvent(event);
  const key = String(event?.transitionKey || event?.idempotencyKey || "").trim();
  if (key) {
    const existing = getDelegationTransitionGuard(ctx, key);
    if (existing) {
      return {
        ...existing,
        recorded: false,
      };
    }
    entry.transitionKey = entry.transitionKey || key;
    entry.idempotencyKey = entry.idempotencyKey || key;
    setDelegationTransitionGuard(ctx, key, entry);
  }
  appendDelegationAuditEvent(ctx, entry);
  return {
    ...entry,
    recorded: true,
  };
}

export function recordDelegationAuditEvent(ctx, event = {}) {
  if (typeof ctx?.recordDelegationEvent === "function") {
    const recorded = ctx.recordDelegationEvent(event);
    const key = String(event?.transitionKey || event?.idempotencyKey || "").trim();
    const normalizedType = String(event?.type || event?.eventType || "").trim();
    const existing = key ? getDelegationTransitionGuard(ctx, key) : null;
    if (
      recorded?.recorded === false
      && existing
      && String(existing?.type || existing?.eventType || "").trim() === "claim_task"
      && normalizedType
      && normalizedType !== "claim_task"
    ) {
      const entry = normalizeDelegationEvent({
        ...event,
        transitionKey: event?.transitionKey || key,
        idempotencyKey: event?.idempotencyKey || key,
      });
      appendDelegationAuditEvent(ctx, entry);
      return {
        ...entry,
        recorded: true,
      };
    }
    return recorded;
  }
  const entry = normalizeDelegationEvent({
    ...event,
    transitionKey: event?.transitionKey || event?.idempotencyKey,
    idempotencyKey: event?.idempotencyKey || event?.transitionKey,
  });
  appendDelegationAuditEvent(ctx, entry);
  return {
    ...entry,
    recorded: true,
  };
}

export function getDelegationTransitionStore(ctx) {
  return getWritableDelegationTransitionStore(ctx);
}

export function getExistingDelegationTransition(ctx, transitionKey) {
  const key = String(transitionKey || "").trim();
  if (!key) return null;
  return getDelegationTransitionStore(ctx)[key] || null;
}

export function setDelegationTransitionResult(ctx, transitionKey, value) {
  const key = String(transitionKey || "").trim();
  if (!key) return null;
  getDelegationTransitionStore(ctx)[key] = value;
  return value;
}

export function extractDelegationTrail(detail, run = null) {
  const candidates = [
    detail?.delegationAuditTrail,
    detail?.delegationTrail,
    detail?.data?._delegationAuditTrail,
    detail?.data?._workflowDelegationTrail,
    detail?.data?._delegationTrail,
    run?.detail?.delegationAuditTrail,
    run?.detail?.delegationTrail,
    run?.detail?.data?._delegationAuditTrail,
    run?.detail?.data?._workflowDelegationTrail,
    run?.detail?.data?._delegationTrail,
    run?.delegationTrail,
    run?.delegationAuditTrail,
  ];
  return normalizeDelegationTrail(candidates.find((value) => Array.isArray(value)) || []);
}

export function hydrateDelegationReadModel(detail, options = {}) {
  if (!detail || typeof detail !== "object") return detail;
  const delegationTrail = normalizeDelegationTrail(options.trail ?? extractDelegationTrail(detail, options.run || null));
  const delegationTransitionGuards = normalizeDelegationGuardMap(
    options.guards ?? extractDelegationGuardMap(detail, options.run || null),
  );
  if (delegationTrail.length === 0 && Object.keys(delegationTransitionGuards).length === 0) {
    return detail;
  }
  if (!detail.data || typeof detail.data !== "object") {
    detail.data = {};
  }
  if (delegationTrail.length > 0) {
    detail.data._delegationAuditTrail = delegationTrail.map((entry) => ({ ...entry }));
    detail.data._workflowDelegationTrail = delegationTrail.map((entry) => ({ ...entry }));
    detail.data._delegationTrail = delegationTrail.map((entry) => ({ ...entry }));
    detail.delegationAuditTrail = delegationTrail.map((entry) => ({ ...entry }));
    detail.delegationTrail = delegationTrail.map((entry) => ({ ...entry }));
  }
  if (Object.keys(delegationTransitionGuards).length > 0) {
    detail.data._delegationTransitionGuards = { ...delegationTransitionGuards };
    detail.delegationTransitionGuards = { ...delegationTransitionGuards };
  }
  return detail;
}

export function getExecutionStateScopeView(ctx, scopeName) {
  if (!ctx || typeof ctx !== "object") return {};
  const scopes = ensureExecutionStateScopes(ctx);
  if (String(scopeName || "").trim().toLowerCase() === "stream") {
    const streamEntry = getExecutionStateScopeEntry(scopes, "stream");
    return {
      ...cloneExecutionStateValue(streamEntry.inherited),
      ...cloneExecutionStateValue(streamEntry.current),
      delegationAuditTrail: composeDelegationTrail(streamEntry),
      delegationTransitionGuards: composeDelegationGuardMap(streamEntry),
    };
  }
  return getExecutionStateScopeValue(scopes, scopeName);
}

export function persistDelegationTransitionGuard(ctx, transitionKey, value = {}) {
  const key = String(transitionKey || "").trim();
  if (!key || typeof ctx?.setDelegationTransitionGuard !== "function") return null;
  return ctx.setDelegationTransitionGuard(key, {
    ...value,
    transitionKey: value?.transitionKey || key,
    idempotencyKey: value?.idempotencyKey || key,
  });
}

function parseWatchdogTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function buildDelegationWatchdogDecision(detail = {}, options = {}) {
  const watchdog = detail?.data?._delegationWatchdog;
  if (!watchdog || typeof watchdog !== "object") return null;

  const delegationType = String(watchdog.delegationType || "").trim().toLowerCase();
  if (watchdog.taskScoped === true || delegationType === "task") return null;

  const state = String(watchdog.state || "").trim().toLowerCase();
  if (state && state !== "delegated" && state !== "running" && state !== "stalled") {
    return null;
  }

  const startedAt = parseWatchdogTimestamp(watchdog.startedAt)
    ?? parseWatchdogTimestamp(watchdog.updatedAt)
    ?? parseWatchdogTimestamp(detail?.startedAt);
  if (!Number.isFinite(startedAt)) return null;

  const minTimeoutMs = Number.isFinite(Number(options.minTimeoutMs)) ? Number(options.minTimeoutMs) : 1000;
  const maxTimeoutMs = Number.isFinite(Number(options.maxTimeoutMs)) ? Number(options.maxTimeoutMs) : Number.MAX_SAFE_INTEGER;
  const defaultTimeoutMs = Number.isFinite(Number(options.defaultTimeoutMs)) ? Number(options.defaultTimeoutMs) : 300000;
  const defaultMaxRecoveries = Number.isFinite(Number(options.defaultMaxRecoveries)) ? Number(options.defaultMaxRecoveries) : 1;

  const timeoutMs = Math.max(
    minTimeoutMs,
    Math.min(
      maxTimeoutMs,
      Number(watchdog.timeoutMs ?? watchdog.delegationWatchdogTimeoutMs ?? defaultTimeoutMs) || defaultTimeoutMs,
    ),
  );
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs < timeoutMs) return null;

  const maxRecoveries = Math.max(
    0,
    Math.trunc((() => {
      const raw = watchdog.maxRecoveries
        ?? watchdog.delegationWatchdogMaxRecoveries
        ?? detail?.data?.delegationWatchdogMaxRecoveries
        ?? defaultMaxRecoveries;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : defaultMaxRecoveries;
    })()),
  );
  const recoveryAttempts = Math.max(
    0,
    Math.trunc((() => {
      const parsed = Number(watchdog.recoveryAttempts);
      if (Number.isFinite(parsed)) return parsed;
      return watchdog.recoveryAttempted === true ? 1 : 0;
    })()),
  );

  const reasonBase = `delegation_watchdog:${watchdog.nodeId || "unknown"}:${elapsedMs}ms>${timeoutMs}ms`;
  if (recoveryAttempts >= maxRecoveries) {
    return {
      type: "exhausted",
      reason: `delegation_watchdog_exhausted:${watchdog.nodeId || "unknown"}:${recoveryAttempts}/${maxRecoveries}`,
      nodeId: watchdog.nodeId || null,
      elapsedMs,
      timeoutMs,
      recoveryAttempts,
      maxRecoveries,
    };
  }

  return {
    type: "retry",
    mode: "from_failed",
    reason: `${reasonBase}:retryable`,
    nodeId: watchdog.nodeId || null,
    elapsedMs,
    timeoutMs,
    recoveryAttempts,
    maxRecoveries,
  };
}
