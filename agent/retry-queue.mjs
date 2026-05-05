/**
 * retry-queue.mjs
 *
 * Pure reducer utilities for retry queue state.
 */

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

function isoDayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function normalizeItem(raw = {}, now = Date.now()) {
  const taskId = String(raw.taskId || "").trim();
  if (!taskId) return null;
  const retryCount = Number.isFinite(Number(raw.retryCount))
    ? Math.max(0, Math.trunc(Number(raw.retryCount)))
    : 0;
  const nextAttemptAt = Number.isFinite(Number(raw.nextAttemptAt))
    ? Math.max(0, Math.trunc(Number(raw.nextAttemptAt)))
    : now;
  const updatedAt = Number.isFinite(Number(raw.updatedAt))
    ? Math.max(0, Math.trunc(Number(raw.updatedAt)))
    : now;
  const expiresAt = Number.isFinite(Number(raw.expiresAt))
    ? Math.max(0, Math.trunc(Number(raw.expiresAt)))
    : nextAttemptAt + DEFAULT_RETENTION_MS;
  return {
    taskId,
    taskTitle: String(raw.taskTitle || "").trim() || "",
    lastError: String(raw.lastError || "").trim() || "",
    retryCount,
    maxRetries: Number.isFinite(Number(raw.maxRetries))
      ? Math.max(0, Math.trunc(Number(raw.maxRetries)))
      : null,
    nextAttemptAt,
    status: String(raw.status || "pending"),
    reason: String(raw.reason || "").trim() || "",
    fallbackReason: String(raw.fallbackReason || raw.fallback_reason || "").trim() || "",
    updatedAt,
    expiresAt,
  };
}

function materialize(itemsByTask) {
  return Array.from(itemsByTask.values()).sort((a, b) => {
    if (a.nextAttemptAt !== b.nextAttemptAt) return a.nextAttemptAt - b.nextAttemptAt;
    return a.updatedAt - b.updatedAt;
  });
}

function ensureDay(state, now) {
  const dayKey = isoDayKey(now);
  if (state.stats.dayKey === dayKey) return state.stats;
  return {
    ...state.stats,
    dayKey,
    totalRetriesToday: 0,
  };
}

export function createRetryQueueState(now = Date.now()) {
  return {
    itemsByTask: new Map(),
    stats: {
      dayKey: isoDayKey(now),
      totalRetriesToday: 0,
      peakRetryDepth: 0,
      exhaustedTaskIds: [],
    },
  };
}

export function reduceRetryQueue(state, action = {}) {
  const now = Number.isFinite(Number(action.now))
    ? Math.max(0, Math.trunc(Number(action.now)))
    : Date.now();
  const type = String(action.type || "").trim().toLowerCase();
  const nextItems = new Map(state?.itemsByTask || []);
  let stats = ensureDay(
    state && state.stats ? state : createRetryQueueState(now),
    now,
  );

  if (type === "add" || type === "upsert") {
    const item = normalizeItem(action.item, now);
    if (!item) return { itemsByTask: nextItems, stats };
    nextItems.set(item.taskId, item);
    if (item.retryCount > stats.peakRetryDepth) {
      stats = { ...stats, peakRetryDepth: item.retryCount };
    }
    return { itemsByTask: nextItems, stats };
  }

  if (type === "remove") {
    const taskId = String(action.taskId || "").trim();
    if (taskId) nextItems.delete(taskId);
    return { itemsByTask: nextItems, stats };
  }

  if (type === "bump-count") {
    const taskId = String(action.taskId || "").trim();
    if (!taskId) return { itemsByTask: nextItems, stats };
    const prev = nextItems.get(taskId) || normalizeItem({ taskId }, now);
    if (!prev) return { itemsByTask: nextItems, stats };
    const nextRetry = Number.isFinite(Number(action.retryCount))
      ? Math.max(0, Math.trunc(Number(action.retryCount)))
      : prev.retryCount + 1;
    const nextItem = normalizeItem({
      ...prev,
      ...action.item,
      taskId,
      retryCount: nextRetry,
      updatedAt: now,
    }, now);
    nextItems.set(taskId, nextItem);
    const peakRetryDepth = Math.max(stats.peakRetryDepth || 0, nextRetry);
    stats = {
      ...stats,
      totalRetriesToday: Math.max(0, (stats.totalRetriesToday || 0) + 1),
      peakRetryDepth,
    };
    return { itemsByTask: nextItems, stats };
  }

  if (type === "mark-exhausted") {
    const taskId = String(action.taskId || "").trim();
    if (!taskId) return { itemsByTask: nextItems, stats };
    const exhausted = new Set(stats.exhaustedTaskIds || []);
    exhausted.add(taskId);
    nextItems.delete(taskId);
    stats = { ...stats, exhaustedTaskIds: Array.from(exhausted) };
    return { itemsByTask: nextItems, stats };
  }

  if (type === "expire") {
    for (const [taskId, item] of nextItems) {
      if (!item) {
        nextItems.delete(taskId);
        continue;
      }
      if (item.expiresAt <= now) {
        nextItems.delete(taskId);
      }
    }
    return { itemsByTask: nextItems, stats };
  }

  return { itemsByTask: nextItems, stats };
}

export function snapshotRetryQueue(state) {
  const items = materialize(state?.itemsByTask || new Map());
  return {
    count: items.length,
    items,
    stats: {
      totalRetriesToday: Number(state?.stats?.totalRetriesToday || 0),
      peakRetryDepth: Number(state?.stats?.peakRetryDepth || 0),
      exhaustedTaskIds: Array.isArray(state?.stats?.exhaustedTaskIds)
        ? [...new Set(state.stats.exhaustedTaskIds.map((id) => String(id || "").trim()).filter(Boolean))]
        : [],
    },
  };
}
