/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Bosun UI – Streaming & Real-Time UX Infrastructure
 *
 *  Browser-only ES module (Preact + HTM, no build step).
 *  Implements 8 Claudeman-inspired streaming/UX patterns:
 *
 *    1. Adaptive Message Batching
 *    2. Backpressure Detection (hysteresis)
 *    3. Light State Tracking & Digest Broadcasts
 *    4. Optimistic Message Rendering
 *    5. Offline Input Queue
 *    6. Chunked History Loading
 *    7. Agent Status Detection
 *    8. Flicker Filter
 *
 *  @module streaming
 * ────────────────────────────────────────────────────────────── */

import { signal, computed } from "@preact/signals";
import { wsConnected, onWsMessage, wsSend } from "./api.js";
import { apiFetch } from "./api.js";
import {
  buildCanonicalSessionApiPath,
  getSessionRuntimeState,
  normalizeSessionEventPayload,
  normalizeSessionsUpdatePayload,
  resolveSessionWorkspaceHint,
} from "./session-api.js";

/* ── Helpers ────────────────────────────────────────────── */

/** Fast 32-bit hash for dirty-checking (not cryptographic). */
function _fastHash(str) {
  let h = 0 | 0;
  for (let i = 0, len = str.length; i < len; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return h >>> 0;
}

/** rAF wrapper with setTimeout fallback. */
function _raf(fn) {
  return typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : setTimeout(fn, 0);
}
function _cancelRaf(h) {
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(h) : clearTimeout(h);
}
/* ═══ Pattern 1 — Adaptive Message Batching ═══════════════ */

/**
 * Creates an adaptive batcher that collects incoming items and
 * flushes them in batches. The batch window adapts based on
 * message frequency.
 *
 * @param {(items: any[]) => void} onFlush — called with the batch
 * @returns {{ push(item: any): void, flush(): void, destroy(): void, stats: import("@preact/signals").Signal }}
 */
export function createAdaptiveBatcher(onFlush) {
  let buffer = [];
  let handle = 0;
  let windowMs = 16;
  let totalFlushed = 0;

  const arrivals = [];
  const MAX_ARRIVALS = 100;
  let decayTimer = null;

  /** Reactive stats: batchWindow, buffered, totalFlushed, rate */
  const stats = signal({ batchWindow: 16, buffered: 0, totalFlushed: 0, rate: 0 });

  function _countInWindow(ms) {
    const cutoff = performance.now() - ms;
    let c = 0;
    for (let i = arrivals.length - 1; i >= 0; i--) {
      if (arrivals[i] < cutoff) break;
      c++;
    }
    return c;
  }

  function _adapt() {
    const in50 = _countInWindow(50);
    const in200 = _countInWindow(200);
    if (in200 > 50) windowMs = 100;
    else if (in50 > 10) windowMs = 50;
    else windowMs = 16;

    if (decayTimer) clearTimeout(decayTimer);
    decayTimer = setTimeout(() => { windowMs = 16; _syncStats(); }, 500);
  }

  function _syncStats() {
    stats.value = {
      batchWindow: windowMs,
      buffered: buffer.length,
      totalFlushed,
      rate: _countInWindow(1000),
    };
  }

  function _drain() {
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    totalFlushed += batch.length;
    _syncStats();
    try { onFlush(batch); } catch { /* consumer errors don't crash batcher */ }
  }

  function _schedule() {
    if (handle) return;
    if (windowMs <= 16) {
      handle = _raf(() => { handle = 0; _drain(); });
    } else {
      handle = setTimeout(() => { handle = 0; _drain(); }, windowMs);
    }
  }

  /**
   * Push an item into the current batch.
   * @param {any} item
   */
  function push(item) {
    arrivals.push(performance.now());
    if (arrivals.length > MAX_ARRIVALS) arrivals.splice(0, arrivals.length - MAX_ARRIVALS);
    _adapt();
    buffer.push(item);
    _syncStats();
    _schedule();
  }

  /** Force-flush the current buffer immediately. */
  function flush() {
    if (handle) { windowMs <= 16 ? _cancelRaf(handle) : clearTimeout(handle); handle = 0; }
    _drain();
  }

  /** Tear down all timers and flush remaining items. */
  function destroy() {
    flush();
    if (decayTimer) { clearTimeout(decayTimer); decayTimer = null; }
    arrivals.length = 0;
  }

  return { push, flush, destroy, stats };
}
/* ═══ Pattern 2 — Backpressure Detection ═══════════════════ */

const BACKPRESSURE_HIGH = 65536; // 64 KB
const BACKPRESSURE_LOW = 16384;  // 16 KB — hysteresis

/** Signal: true when WebSocket send buffer exceeds threshold. */
export const wsBackpressure = signal(false);

let _bpInterval = null;
let _bpSocket = null;

/**
 * Start monitoring a WebSocket's bufferedAmount.
 * Should be called once when WS connects.
 *
 * @param {WebSocket} socket
 * @returns {() => void} cleanup function
 */
export function startBackpressureMonitor(socket) {
  stopBackpressureMonitor();
  _bpSocket = socket;
  _bpInterval = setInterval(() => {
    if (!_bpSocket || _bpSocket.readyState !== WebSocket.OPEN) {
      wsBackpressure.value = false;
      return;
    }
    const amt = _bpSocket.bufferedAmount;
    if (wsBackpressure.value) {
      if (amt < BACKPRESSURE_LOW) wsBackpressure.value = false;
    } else {
      if (amt > BACKPRESSURE_HIGH) wsBackpressure.value = true;
    }
  }, 100);

  return stopBackpressureMonitor;
}

/** Stop backpressure polling. */
export function stopBackpressureMonitor() {
  if (_bpInterval) { clearInterval(_bpInterval); _bpInterval = null; }
  _bpSocket = null;
  wsBackpressure.value = false;
}

/**
 * Send data through WebSocket with backpressure awareness.
 * - "high" always sends
 * - "normal" sends unless backpressured
 * - "low" only sends when bufferedAmount < LOW threshold
 *
 * @param {WebSocket} socket
 * @param {any} data — will be JSON.stringified
 * @param {"high"|"normal"|"low"} priority
 * @returns {boolean} whether the message was actually sent
 */
export function sendWithBackpressure(socket, data, priority = "normal") {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  if (priority === "normal" && wsBackpressure.value) return false;
  if (priority === "low" && socket.bufferedAmount >= BACKPRESSURE_LOW) return false;

  socket.send(typeof data === "string" ? data : JSON.stringify(data));
  return true;
}
/* ═══ Pattern 3 — Light State Tracking ═════════════════════ */

/**
 * Creates a tracker that detects whether state has actually changed.
 * Uses a fast digest (JSON.stringify length + simple hash) for comparison.
 *
 * @param {string} key — identifier for this state group
 * @returns {{ checkDirty(newVal: any): boolean, getDigest(): string, lastValue: any }}
 */
export function createStateTracker(key) {
  let _hash = 0;
  let _len = 0;
  let _lastValue = undefined;

  return {
    /**
     * Check if newVal differs from last known value.
     * @param {any} newVal
     * @returns {boolean} true if changed
     */
    checkDirty(newVal) {
      const json = JSON.stringify(newVal);
      const h = _fastHash(json);
      const l = json.length;
      if (h === _hash && l === _len) return false;
      _hash = h;
      _len = l;
      _lastValue = newVal;
      return true;
    },
    /**
     * Returns the current hash string.
     * @returns {string}
     */
    getDigest() {
      return `${key}:${_hash}:${_len}`;
    },
    /** The last value that was tracked. */
    get lastValue() { return _lastValue; },
  };
}

/** In-memory store for full payloads keyed by type. */
const _fullPayloads = new Map();

/**
 * Broadcast only a digest to clients, unless they request full data.
 * Keeps fullPayload in memory for "request-full" responses.
 *
 * @param {Map<string, WebSocket>|WebSocket[]} channels — recipients
 * @param {string} type — message type identifier
 * @param {any} fullPayload — the complete data object
 */
export function broadcastLightState(channels, type, fullPayload) {
  const entry = _fullPayloads.get(type) || (() => {
    const e = { tracker: createStateTracker(type), data: null };
    _fullPayloads.set(type, e);
    return e;
  })();

  const dirty = entry.tracker.checkDirty(fullPayload);
  const digest = entry.tracker.getDigest();
  entry.data = fullPayload;

  const targets = channels instanceof Map ? Array.from(channels.values()) : channels;
  const payloadSize = JSON.stringify(fullPayload).length;

  for (const ws of targets) {
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    if (dirty) {
      sendWithBackpressure(ws, { type, payload: fullPayload, digest, payloadSize }, "high");
    } else {
      sendWithBackpressure(ws, { type, digest, payloadSize }, "low");
    }
  }
}

/**
 * Install a WS handler that responds to "request-full" messages.
 *
 * @param {Record<string, ReturnType<typeof createStateTracker>>} trackers
 * @returns {() => void} unsubscribe function
 */
export function installRequestFullHandler(trackers) {
  return onWsMessage((msg) => {
    if (msg?.type !== "request-full" || !msg.key) return;
    const tracker = trackers[msg.key];
    if (tracker) {
      const full = tracker.lastValue;
      if (full !== undefined) wsSend({ type: msg.key, payload: full, digest: tracker.getDigest() });
      return;
    }
    const stored = _fullPayloads.get(msg.key);
    if (stored?.data !== undefined) {
      wsSend({ type: msg.key, payload: stored.data, digest: stored.tracker.getDigest() });
    }
  });
}
/* ═══ Pattern 4 — Optimistic Message Rendering ════════════ */

/**
 * Array of messages awaiting server confirmation.
 * @type {import("@preact/signals").Signal<Array<{tempId:string,sessionId:string,content:string,role:string,status:string,createdAt:number,error:string|null,attachments?:any[]}>>}
 */
export const pendingMessages = signal([]);

/** Whether the agent is currently typing/generating. */
export const typingIndicator = signal({ active: false, adapter: "", startedAt: 0 });

let _pendingId = 0;

/**
 * Add a pending message (optimistic rendering before server confirms).
 * After 30 s without confirmation the message is marked "uncertain".
 *
 * @param {string} sessionId
 * @param {string} content
 * @returns {string} tempId
 */
export function addPendingMessage(sessionId, content, attachments = []) {
  const tempId = `pending-${++_pendingId}-${Date.now()}`;
  const msg = {
    tempId, sessionId, content, role: "user",
    status: "sending", createdAt: Date.now(), error: null,
    attachments,
  };
  pendingMessages.value = [...pendingMessages.value, msg];

  setTimeout(() => {
    const current = pendingMessages.value;
    const idx = current.findIndex((m) => m.tempId === tempId);
    if (idx >= 0 && current[idx].status === "sending") {
      const updated = [...current];
      updated[idx] = { ...updated[idx], status: "uncertain" };
      pendingMessages.value = updated;
    }
  }, 30000);

  return tempId;
}

/**
 * Remove a pending message upon server confirmation.
 * @param {string} tempId
 */
export function confirmMessage(tempId) {
  pendingMessages.value = pendingMessages.value.filter((m) => m.tempId !== tempId);
}

/**
 * Mark a pending message as failed.
 * @param {string} tempId
 * @param {string} error
 */
export function rejectMessage(tempId, error) {
  const current = pendingMessages.value;
  const idx = current.findIndex((m) => m.tempId === tempId);
  if (idx >= 0) {
    const updated = [...current];
    updated[idx] = { ...updated[idx], status: "failed", error };
    pendingMessages.value = updated;
  }
}

/**
 * Retry a failed/uncertain message. Removes the old entry and
 * creates a fresh pending message with a new tempId.
 *
 * @param {string} tempId
 * @returns {string|null} new tempId, or null if original not found
 */
export function retryPendingMessage(tempId) {
  const msg = pendingMessages.value.find((m) => m.tempId === tempId);
  if (!msg) return null;
  pendingMessages.value = pendingMessages.value.filter((m) => m.tempId !== tempId);
  return addPendingMessage(msg.sessionId, msg.content, msg.attachments || []);
}

/**
 * Clear pending messages, optionally filtered by sessionId.
 * @param {string} [sessionId]
 */
export function clearPendingMessages(sessionId) {
  if (sessionId) {
    pendingMessages.value = pendingMessages.value.filter((m) => m.sessionId !== sessionId);
  } else {
    pendingMessages.value = [];
  }
}
/* ═══ Pattern 5 — Offline Input Queue ══════════════════════ */

const MAX_QUEUE_BYTES = 65536; // 64 KB

/** Queued messages when offline. */
export const offlineQueue = signal([]);

/** Number of queued messages. */
export const offlineQueueSize = computed(() => offlineQueue.value.length);

/** Total bytes in queue. */
export const offlineQueueBytes = computed(() =>
  offlineQueue.value.reduce((sum, m) => sum + (m._bytes || 0), 0),
);

/**
 * Queue a message for later delivery when offline.
 *
 * @param {string} sessionId
 * @param {string} content
 */
export function queueMessage(sessionId, content) {
  const bytes = new TextEncoder().encode(content).length;
  const msg = { sessionId, content, _bytes: bytes, queuedAt: Date.now() };
  let queue = [...offlineQueue.value, msg];
  while (queue.length > 0 && queue.reduce((s, m) => s + (m._bytes || 0), 0) > MAX_QUEUE_BYTES) {
    queue.shift();
  }
  offlineQueue.value = queue;
}

/**
 * Flush the offline queue by sending all messages in order.
 * Re-queues messages that fail to send.
 *
 * @param {(sessionId: string, content: string) => Promise<void>} sendFn
 */
export async function flushOfflineQueue(sendFn) {
  const queue = [...offlineQueue.value];
  offlineQueue.value = [];
  for (const msg of queue) {
    try {
      await sendFn(msg.sessionId, msg.content);
    } catch {
      offlineQueue.value = [...offlineQueue.value, msg];
    }
  }
}

/**
 * Smart send: if connected, send directly; if offline, queue.
 *
 * @param {string} sessionId
 * @param {string} content
 * @param {(sessionId: string, content: string) => Promise<void>} sendFn
 * @returns {Promise<void>}
 */
export function sendOrQueue(sessionId, content, sendFn) {
  if (wsConnected.value) return sendFn(sessionId, content);
  queueMessage(sessionId, content);
  return Promise.resolve();
}

/**
 * Auto-flush queue when WS reconnects (false → true transition).
 *
 * @param {(sessionId: string, content: string) => Promise<void>} sendFn
 * @returns {() => void} unsubscribe
 */
export function installReconnectFlush(sendFn) {
  let wasConnected = wsConnected.value;
  const unsub = wsConnected.subscribe((connected) => {
    if (connected && !wasConnected && offlineQueue.value.length > 0) {
      flushOfflineQueue(sendFn);
    }
    wasConnected = connected;
  });
  return unsub;
}
/* ═══ Pattern 6 — Chunked History Loading ══════════════════ */

/** Whether a history load is in progress. */
export const historyLoading = signal(false);

/**
 * Load session history in chunks to avoid blocking the UI.
 *
 * @param {string} sessionId
 * @param {{ chunkSize?: number, onChunk?: (messages: any[]) => void }} [opts]
 * @returns {Promise<any[]>} all messages
 */
export async function loadHistoryChunked(sessionId, opts = {}) {
  const { chunkSize = 50, onChunk = null } = opts;
  historyLoading.value = true;
  const allMessages = [];
  let offset = 0;
  let hasMore = true;
  const workspace = resolveSessionWorkspaceHint(opts?.session, opts?.workspace || "active");

  try {
    while (hasMore) {
      const path = buildCanonicalSessionApiPath(sessionId, "", {
        workspace,
        query: { offset, limit: chunkSize },
      });
      const res = await apiFetch(
        path,
        { _silent: true },
      );
      const messages = res?.session?.messages || res?.messages || [];
      if (!messages.length) { hasMore = false; break; }

      allMessages.push(...messages);
      if (onChunk) onChunk(messages);
      offset += messages.length;
      if (messages.length < chunkSize) hasMore = false;

      if (hasMore) await new Promise((r) => _raf(r));
    }
  } finally {
    historyLoading.value = false;
  }
  return allMessages;
}
/* ═══ Pattern 7 — Agent Status Detection ═══════════════════ */

/**
 * Agent status tracked from WS events.
 * States: "idle" | "thinking" | "executing" | "streaming"
 * @type {import("@preact/signals").Signal<{state:string,adapter:string,sessionId:string,startedAt:number,lastEventAt:number}>}
 */
export const agentStatus = signal({
  state: "idle", adapter: "", sessionId: "", startedAt: 0, lastEventAt: 0,
});

/**
 * Human-readable status text.
 * @type {import("@preact/signals").ReadonlySignal<string>}
 */
export const agentStatusText = computed(() => {
  const s = agentStatus.value;
  const name = s.adapter ? s.adapter.replace("-sdk", "") : "Agent";
  const capitalize = (/** @type {string} */ str) => str.charAt(0).toUpperCase() + str.slice(1);
  switch (s.state) {
    case "thinking":  return `${capitalize(name)} is thinking...`;
    case "executing": return `${capitalize(name)} is running commands...`;
    case "streaming": return `${capitalize(name)} is responding...`;
    default:          return "Ready";
  }
});

let _idleTimer = null;
const IDLE_TIMEOUT = 120000;

function _clearIdleTimer() {
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
}

/**
 * Internal: transition agent state and reset idle timer.
 * Only updates the signal when the logical state actually changes
 * (state or adapter). This prevents WS event storms from creating
 * a new object on every event and triggering cascading re-renders.
 *
 * @param {string} state
 * @param {string} [adapter]
 * @param {string} [sessionId]
 */
function _setAgentState(state, adapter, sessionId) {
  const now = Date.now();
  const prev = agentStatus.value;
  const resolvedAdapter = adapter !== undefined ? adapter : prev.adapter;
  const resolvedSessionId = sessionId !== undefined ? sessionId : prev.sessionId;
  const stateChanged = state !== prev.state;
  const adapterChanged = resolvedAdapter !== prev.adapter;
  const sessionChanged = resolvedSessionId !== prev.sessionId;

  // Only update the signal (which triggers re-renders) when something
  // the UI actually cares about has changed.
  if (stateChanged || adapterChanged || sessionChanged) {
    agentStatus.value = {
      state,
      adapter: resolvedAdapter,
      sessionId: resolvedSessionId,
      startedAt: stateChanged || sessionChanged ? now : prev.startedAt,
      lastEventAt: now,
    };
  }

  // Always reset idle timer — even if we didn't update the signal,
  // we want to push back the "return to idle" deadline.
  _clearIdleTimer();
  if (state !== "idle") {
    _idleTimer = setTimeout(() => {
      if (agentStatus.value.state !== "idle") {
        agentStatus.value = {
          ...agentStatus.value,
          state: "idle",
          adapter: "",
          sessionId: "",
          lastEventAt: Date.now(),
        };
      }
    }, IDLE_TIMEOUT);
  }
}

function _isCompletionReason(reason) {
  const normalized = String(reason || "").trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("agent-response")
    || normalized.includes("agent-error")
    || normalized.includes("agent-stopped")
    || normalized.includes("session-turn-finished")
    || normalized.includes("session-completed")
    || normalized.includes("session-ended")
    || normalized.includes("session-archived")
    || normalized.includes("session-deleted")
    || normalized.includes("session-paused")
    || normalized.includes("session-resumed")
    || normalized.includes("completed")
    || normalized.includes("finished")
    || normalized.includes("archived")
    || normalized.includes("deleted")
    || normalized.includes("failed")
    || normalized.includes("error")
    || normalized.includes("stopped")
    || normalized.includes("ended")
  );
}

function _handleSessionMessageRecord({ sessionId = "", session = {}, message = null } = {}) {
  if (!message || typeof message !== "object") return false;

  const role = String(message.role || "").toLowerCase();
  const type = String(message.type || "").toLowerCase();
  const content = String(message.content || "").toLowerCase();
  const lifecycle = String(message?.meta?.lifecycle || "").toLowerCase();
  const adapter = String(session?.type || "").trim();
  const resolvedSessionId = String(session?.id || sessionId || "").trim();
  const sessionStatus = String(
    session?.status || session?.lifecycleStatus || session?.runtimeState || "active",
  ).trim().toLowerCase() || "active";

  if (sessionStatus !== "active") {
    if (!resolvedSessionId || agentStatus.value.sessionId === resolvedSessionId) {
      clearAgentStatus(resolvedSessionId);
    }
    return true;
  }

  const isCompletionEvent =
    type === "turn.completed" ||
    type === "session.completed" ||
    lifecycle === "turn_completed" ||
    lifecycle === "session_completed" ||
    content.includes("turn completed") ||
    content.includes("session completed") ||
    content.includes("evt[turn.completed]") ||
    content.includes("evt[session.completed]") ||
    content.includes("session.idle");

  if (isCompletionEvent) {
    clearAgentStatus(resolvedSessionId);
    return true;
  }

  if (role === "assistant" || type === "agent_message") {
    _setAgentState("streaming", adapter, resolvedSessionId);
  } else if (type === "tool_call") {
    _setAgentState("executing", adapter, resolvedSessionId);
  } else if (type === "tool_result") {
    _setAgentState("streaming", adapter, resolvedSessionId);
  } else if (type === "system") {
    if (
      content.includes("running:") ||
      content.includes("command done:") ||
      content.includes("command_execution")
    ) {
      _setAgentState("executing", adapter, resolvedSessionId);
    } else {
      _setAgentState("thinking", adapter, resolvedSessionId);
    }
  } else if (type === "error" || type === "stream_error") {
    clearAgentStatus(resolvedSessionId);
  } else {
    return false;
  }

  return true;
}

function _handleCanonicalSessionEvent(payload) {
  const normalized = normalizeSessionEventPayload(payload);
  const session = normalized.session || {};
  const event = normalized.event || {};
  const sessionId = String(normalized.sessionId || normalized.taskId || "").trim();

  if (event.kind === "state") {
    const reason = String(event.reason || "").trim().toLowerCase();
    const sessionStatus = String(
      session?.status || session?.lifecycleStatus || session?.runtimeState || "",
    ).trim().toLowerCase();
    if (_isCompletionReason(reason) || (sessionStatus && sessionStatus !== "active")) {
      clearAgentStatus(sessionId);
    }
    return true;
  }

  if (event.kind === "message" && event.message && typeof event.message === "object") {
    return _handleSessionMessageRecord({
      sessionId,
      session: session && typeof session === "object"
        ? { ...session, id: session.id || sessionId }
        : { id: sessionId },
      message: event.message,
    });
  }

  return false;
}

function _handleSessionSnapshot(payload) {
  const currentSessionId = String(agentStatus.value.sessionId || "").trim();
  if (!currentSessionId) return false;

  const sessions = normalizeSessionsUpdatePayload(payload);
  const currentSession = sessions.find((session) => {
    const sessionId = String(session?.id || session?.sessionId || "").trim();
    const taskId = String(session?.taskId || "").trim();
    return sessionId === currentSessionId || taskId === currentSessionId;
  });
  if (!currentSession) return false;

  const lifecycle = String(
    currentSession?.lifecycleStatus || currentSession?.status || "",
  ).trim().toLowerCase();
  const runtime = getSessionRuntimeState(currentSession);
  if (lifecycle && lifecycle !== "active") {
    clearAgentStatus(currentSessionId);
    return true;
  }
  if (runtime.key === "stopped" || runtime.key === "failed" || runtime.key === "error") {
    clearAgentStatus(currentSessionId);
    return true;
  }
  return false;
}

export function clearAgentStatus(sessionId = "") {
  const current = agentStatus.value || {};
  const targetSessionId = String(sessionId || "").trim();
  const currentSessionId = String(current.sessionId || "").trim();
  if (targetSessionId && currentSessionId && currentSessionId !== targetSessionId) {
    return;
  }
  _clearIdleTimer();
  agentStatus.value = {
    state: "idle",
    adapter: "",
    sessionId: "",
    startedAt: 0,
    lastEventAt: Date.now(),
  };
}

/**
 * Call when user sends a message — sets state to "thinking".
 * @param {string} [adapter]
 * @param {string} [sessionId]
 */
export function markUserMessageSent(adapter, sessionId) {
  _setAgentState("thinking", adapter, sessionId);
}

/**
 * Start tracking agent status from WebSocket session-message events.
 *
 * @returns {() => void} cleanup function
 */
export function startAgentStatusTracking() {
  return onWsMessage((msg) => {
    if (msg.type === "session:event") {
      if (_handleCanonicalSessionEvent(msg.payload)) return;
    }

    if (msg.type === "sessions:update") {
      if (_handleSessionSnapshot(msg.payload)) return;
    }

    if (msg.type === "invalidate") {
      const payload = msg.payload || {};
      const reason = String(payload.reason || "").toLowerCase();
      const sessionId = String(payload.sessionId || payload.taskId || "");
      const isCompletionSignal = _isCompletionReason(reason);
      if (isCompletionSignal) {
        if (!sessionId || agentStatus.value.sessionId === sessionId) {
          clearAgentStatus(sessionId);
        }
      }
      return;
    }

    if (msg.type !== "session-message") return;
    _handleSessionMessageRecord({
      sessionId: msg?.payload?.session?.id || msg?.payload?.sessionId || msg?.payload?.taskId || "",
      session: msg?.payload?.session || {},
      message: msg?.payload?.message || msg?.payload || null,
    });
  });
}
/* ═══ Pattern 8 — Flicker Filter ═══════════════════════════ */

/**
 * Creates a filter that prevents rapid visual updates from causing
 * flicker. Holds updates for minDurationMs before releasing. If a
 * newer update arrives before the timer fires, it replaces the
 * pending update (only latest is shown).
 *
 * @param {(item: any) => void} onRelease — callback when item is released
 * @param {number} [minDurationMs=50] — minimum hold time
 * @returns {{ push(item: any): void, flush(): void, destroy(): void }}
 */
export function createFlickerFilter(onRelease, minDurationMs = 50) {
  let pending = null;
  let timer = null;

  function release() {
    if (pending !== null) {
      onRelease(pending);
      pending = null;
    }
    timer = null;
  }

  return {
    /** @param {any} item */
    push(item) {
      pending = item;
      if (!timer) timer = setTimeout(release, minDurationMs);
    },
    /** Immediately release the pending item (if any). */
    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      release();
    },
    /** Clean up timers and release references. */
    destroy() {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = null;
    },
  };
}
