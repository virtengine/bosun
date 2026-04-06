import { randomUUID } from "node:crypto";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function cloneValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function toPositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function normalizeStringArray(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [values])
      .map((entry) => toTrimmedString(entry))
      .filter(Boolean),
  ));
}

function normalizeContractSummary(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const toolPolicy = source.toolPolicy && typeof source.toolPolicy === "object" ? source.toolPolicy : {};
  const memoryPolicy = source.memoryPolicy && typeof source.memoryPolicy === "object" ? source.memoryPolicy : {};
  const reportingPolicy = source.reportingPolicy && typeof source.reportingPolicy === "object" ? source.reportingPolicy : {};
  const escalationPolicy = source.escalationPolicy && typeof source.escalationPolicy === "object" ? source.escalationPolicy : {};
  return {
    freshConversation: source.freshConversation !== false,
    toolPolicy: {
      allowedTools: normalizeStringArray(toolPolicy.allowedTools),
      deniedTools: normalizeStringArray(toolPolicy.deniedTools),
      allowNestedDelegation: toolPolicy.allowNestedDelegation === true,
    },
    memoryPolicy: {
      mode: toTrimmedString(memoryPolicy.mode || "read_only") || "read_only",
    },
    reportingPolicy: {
      mode: toTrimmedString(reportingPolicy.mode || "one_way_progress") || "one_way_progress",
      progressOnly: reportingPolicy.progressOnly !== false,
    },
    escalationPolicy: {
      mode: toTrimmedString(escalationPolicy.mode || "none") || "none",
      waitForResponse: escalationPolicy.waitForResponse === true,
    },
  };
}

function nowIso() {
  return new Date().toISOString();
}

function createPoolId(value = "default") {
  return toTrimmedString(value).replace(/[^a-z0-9_-]+/gi, "-").toLowerCase() || "default";
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

function createLeaseRecord(input = {}) {
  const queuedAt = nowIso();
  const contract = normalizeContractSummary(input.contract || input.metadata?.subagentContract || {});
  return {
    leaseId: toTrimmedString(input.leaseId || "") || `subagent-lease-${randomUUID()}`,
    poolId: createPoolId(input.poolId),
    sessionId: toTrimmedString(input.sessionId || "") || null,
    threadId: toTrimmedString(input.threadId || "") || null,
    parentSessionId: toTrimmedString(input.parentSessionId || "") || null,
    rootSessionId: toTrimmedString(input.rootSessionId || "") || null,
    taskKey: toTrimmedString(input.taskKey || "") || null,
    role: toTrimmedString(input.role || "subagent") || "subagent",
    metadata: input.metadata && typeof input.metadata === "object" ? { ...input.metadata } : {},
    contract,
    maxConcurrent: toPositiveInteger(input.maxConcurrent, 1) || 1,
    queuedAt,
    acquiredAt: null,
    releasedAt: null,
    status: "queued",
  };
}

function createPoolState(input = {}) {
  return {
    poolId: createPoolId(input.poolId),
    maxConcurrent: toPositiveInteger(input.maxConcurrent, 1) || 1,
    active: new Map(),
    queued: [],
  };
}

export function createSubagentPool(options = {}) {
  const pools = new Map();
  const emitEvent = createEventEmitter([options.onEvent]);

  function serializeLease(lease) {
    return cloneValue({
      ...lease,
      metadata: lease.metadata && typeof lease.metadata === "object" ? { ...lease.metadata } : {},
      contract: normalizeContractSummary(lease.contract),
    });
  }

  function ensurePool(poolId, maxConcurrent = 1) {
    const normalizedPoolId = createPoolId(poolId);
    const normalizedMaxConcurrent = toPositiveInteger(maxConcurrent, 1) || 1;
    const existing = pools.get(normalizedPoolId);
    if (existing) {
      existing.maxConcurrent = normalizedMaxConcurrent;
      return existing;
    }
    const created = createPoolState({
      poolId: normalizedPoolId,
      maxConcurrent: normalizedMaxConcurrent,
    });
    pools.set(normalizedPoolId, created);
    return created;
  }

  function emitPoolEvent(type, lease, extra = {}) {
    emitEvent({
      type,
      poolId: lease.poolId,
      leaseId: lease.leaseId,
      sessionId: lease.sessionId,
      threadId: lease.threadId,
      parentSessionId: lease.parentSessionId,
      rootSessionId: lease.rootSessionId,
      taskKey: lease.taskKey,
      contract: normalizeContractSummary(lease.contract),
      maxConcurrent: lease.maxConcurrent,
      queuedAt: lease.queuedAt,
      acquiredAt: lease.acquiredAt,
      releasedAt: lease.releasedAt,
      timestamp: nowIso(),
      ...extra,
    });
  }

  function tryDrainQueue(pool) {
    while (pool.active.size < pool.maxConcurrent && pool.queued.length > 0) {
      const next = pool.queued.shift();
      if (!next) continue;
      next.status = "running";
      next.acquiredAt = nowIso();
      pool.active.set(next.leaseId, next);
      emitPoolEvent("subagent_pool_acquired", next, {
        queueDepth: pool.queued.length,
        activeCount: pool.active.size,
      });
      try {
        next.resolve(serializeLease(next));
      } catch {
      }
    }
  }

  async function acquire(input = {}) {
    const lease = createLeaseRecord(input);
    const pool = ensurePool(lease.poolId, input.maxConcurrent || lease.maxConcurrent);

    if (pool.active.size < pool.maxConcurrent) {
      lease.status = "running";
      lease.acquiredAt = nowIso();
      pool.active.set(lease.leaseId, lease);
      emitPoolEvent("subagent_pool_acquired", lease, {
        queueDepth: pool.queued.length,
        activeCount: pool.active.size,
      });
      return serializeLease(lease);
    }

    emitPoolEvent("subagent_pool_queued", lease, {
      queueDepth: pool.queued.length + 1,
      activeCount: pool.active.size,
    });
    if (typeof input.onQueued === "function") {
      try {
        input.onQueued(serializeLease(lease));
      } catch {
      }
    }

    return await new Promise((resolve) => {
      pool.queued.push({
        ...lease,
        resolve,
      });
    });
  }

  function release(leaseIdOrLease, patch = {}) {
    const normalizedLeaseId = toTrimmedString(leaseIdOrLease?.leaseId || leaseIdOrLease);
    if (!normalizedLeaseId) return false;
    for (const pool of pools.values()) {
      if (!pool.active.has(normalizedLeaseId)) continue;
      const lease = pool.active.get(normalizedLeaseId);
      pool.active.delete(normalizedLeaseId);
      lease.status = "released";
      lease.releasedAt = nowIso();
      emitPoolEvent("subagent_pool_released", lease, {
        queueDepth: pool.queued.length,
        activeCount: pool.active.size,
        status: patch.status || null,
        error: patch.error || null,
      });
      tryDrainQueue(pool);
      return true;
    }
    return false;
  }

  function getPool(poolId) {
    const normalizedPoolId = createPoolId(poolId);
    const pool = pools.get(normalizedPoolId);
    if (!pool) return null;
    return {
      poolId: pool.poolId,
      maxConcurrent: pool.maxConcurrent,
      activeCount: pool.active.size,
      queueDepth: pool.queued.length,
      active: [...pool.active.values()].map((lease) => serializeLease(lease)),
      queued: pool.queued.map((lease) => serializeLease(lease)),
    };
  }

  function listPools() {
    return [...pools.values()]
      .map((pool) => getPool(pool.poolId))
      .filter(Boolean)
      .sort((left, right) => String(left.poolId).localeCompare(String(right.poolId)));
  }

  function snapshot() {
    return {
      pools: listPools(),
    };
  }

  return {
    acquire,
    release,
    getPool,
    listPools,
    snapshot,
  };
}

export default createSubagentPool;
