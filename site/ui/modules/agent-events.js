/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Agent Event Bus Client
 *
 *  Real-time client-side layer that consumes WS events emitted
 *  by agent-event-bus.mjs on the server and exposes reactive
 *  Preact signals for UI components:
 *
 *    - agentEvents       — recent event feed (ring buffer)
 *    - agentErrors       — active error patterns per task
 *    - agentLiveness     — per-agent heartbeat / stale status
 *    - agentAutoActions  — latest auto-action notifications
 *    - eventBusStatus    — system-level event bus health
 *
 *  Also provides REST fetchers for historical queries and a hook
 *  that merges WS push + REST poll (stale-while-revalidate).
 *
 *  @module agent-events
 * ────────────────────────────────────────────────────────────── */

import { signal, computed } from "@preact/signals";
import { apiFetch, onWsMessage } from "../../../ui/modules/api.js";

/* ══════════════════════════════════════════════════════════════
 *  CONSTANTS
 * ══════════════════════════════════════════════════════════════ */

/** Max events kept in the client-side ring buffer */
const MAX_CLIENT_EVENTS = 200;

/** REST poll interval for fallback / initial hydration (ms) */
const POLL_INTERVAL = 30_000;

/** Liveness poll interval — augments WS heartbeats (ms) */
const LIVENESS_POLL_INTERVAL = 15_000;

/** All event type prefixes we listen for on the WS */
const AGENT_EVENT_PREFIX = "agent:";

/* ══════════════════════════════════════════════════════════════
 *  REACTIVE SIGNALS — single source of truth for UI components
 * ══════════════════════════════════════════════════════════════ */

/**
 * Recent agent events (newest first).
 * @type {import("@preact/signals").Signal<Array<{type:string,taskId:string,payload:object,ts:number}>>}
 */
export const agentEvents = signal([]);

/**
 * Active error patterns — { [pattern]: { count, lastSeen, tasks } }.
 * @type {import("@preact/signals").Signal<object>}
 */
export const agentErrors = signal({});

/**
 * Per-agent liveness status.
 * @type {import("@preact/signals").Signal<Array<{taskId:string,lastHeartbeat:number,alive:boolean,staleSinceMs:number|null}>>}
 */
export const agentLiveness = signal([]);

/**
 * Latest auto-action notifications (retry, review, cooldown, block, etc.).
 * @type {import("@preact/signals").Signal<Array<{type:string,taskId:string,payload:object,ts:number}>>}
 */
export const agentAutoActions = signal([]);

/**
 * Event bus system health.
 * @type {import("@preact/signals").Signal<object|null>}
 */
export const eventBusStatus = signal(null);

/**
 * Whether the event bus is connected and reporting.
 * @type {import("@preact/signals").ReadonlySignal<boolean>}
 */
export const eventBusConnected = computed(
  () => eventBusStatus.value?.started === true,
);

/**
 * Count of alive agents.
 * @type {import("@preact/signals").ReadonlySignal<number>}
 */
export const aliveAgentCount = computed(
  () => agentLiveness.value.filter((a) => a.alive).length,
);

/**
 * Count of stale agents.
 * @type {import("@preact/signals").ReadonlySignal<number>}
 */
export const staleAgentCount = computed(
  () => agentLiveness.value.filter((a) => !a.alive).length,
);

/**
 * Total error count across all patterns.
 * @type {import("@preact/signals").ReadonlySignal<number>}
 */
export const totalErrorCount = computed(() => {
  const patterns = agentErrors.value;
  let total = 0;
  for (const key of Object.keys(patterns)) {
    total += patterns[key].count || 0;
  }
  return total;
});

/* ══════════════════════════════════════════════════════════════
 *  INTERNAL STATE
 * ══════════════════════════════════════════════════════════════ */

let _wsUnsub = null;
let _pollTimer = null;
let _livenessPollTimer = null;
let _started = false;

/** Set of auto-action event types */
const AUTO_ACTION_TYPES = new Set([
  "agent:auto-retry",
  "agent:auto-review",
  "agent:auto-cooldown",
  "agent:auto-block",
  "agent:auto-new-session",
  "agent:executor-paused",
  "agent:executor-resumed",
]);

/* ══════════════════════════════════════════════════════════════
 *  WS HANDLER — processes all agent:* events from the server
 * ══════════════════════════════════════════════════════════════ */

/**
 * Process an incoming WS message that is an agent event.
 * @param {object} msg — raw WS message { type, payload }
 */
function _handleWsEvent(msg) {
  const type = msg.type || msg.payload?.type;
  if (!type || !type.startsWith(AGENT_EVENT_PREFIX)) return;

  const payload = msg.payload || {};
  const event = {
    type,
    taskId: payload.taskId || "unknown",
    payload,
    ts: payload.ts || Date.now(),
  };

  // ── Append to event ring buffer (newest first)
  const current = agentEvents.value;
  const updated = [event, ...current];
  if (updated.length > MAX_CLIENT_EVENTS) updated.length = MAX_CLIENT_EVENTS;
  agentEvents.value = updated;

  // ── Route to specific signal stores
  if (type === "agent:heartbeat") {
    _updateLivenessFromHeartbeat(event);
  } else if (type === "agent:stale") {
    _updateLivenessFromStale(event);
  } else if (type === "agent:error-classified") {
    _updateErrorPatterns(event);
  } else if (type === "agent:error-pattern-detected") {
    _updateErrorPatterns(event);
  } else if (AUTO_ACTION_TYPES.has(type)) {
    _appendAutoAction(event);
  }
}

/* ══════════════════════════════════════════════════════════════
 *  SIGNAL MUTATORS
 * ══════════════════════════════════════════════════════════════ */

function _updateLivenessFromHeartbeat(event) {
  const taskId = event.taskId;
  const now = Date.now();
  const current = agentLiveness.value;
  const existing = current.findIndex((a) => a.taskId === taskId);
  const entry = {
    taskId,
    lastHeartbeat: now,
    alive: true,
    staleSinceMs: null,
  };
  if (existing >= 0) {
    const updated = [...current];
    updated[existing] = entry;
    agentLiveness.value = updated;
  } else {
    agentLiveness.value = [...current, entry];
  }
}

function _updateLivenessFromStale(event) {
  const taskId = event.taskId;
  const current = agentLiveness.value;
  const existing = current.findIndex((a) => a.taskId === taskId);
  const entry = {
    taskId,
    lastHeartbeat: event.payload?.lastHeartbeat || 0,
    alive: false,
    staleSinceMs: event.payload?.staleSinceMs || null,
  };
  if (existing >= 0) {
    const updated = [...current];
    updated[existing] = entry;
    agentLiveness.value = updated;
  } else {
    agentLiveness.value = [...current, entry];
  }
}

function _updateErrorPatterns(event) {
  const pattern = event.payload?.pattern;
  if (!pattern) return;
  const current = { ...agentErrors.value };
  if (!current[pattern]) {
    current[pattern] = { count: 0, lastSeen: 0, tasks: [] };
  }
  current[pattern].count++;
  current[pattern].lastSeen = event.ts;
  if (event.taskId && !current[pattern].tasks.includes(event.taskId)) {
    current[pattern].tasks = [...current[pattern].tasks, event.taskId];
  }
  agentErrors.value = current;
}

function _appendAutoAction(event) {
  const current = agentAutoActions.value;
  const updated = [event, ...current];
  if (updated.length > 50) updated.length = 50;
  agentAutoActions.value = updated;
}

/* ══════════════════════════════════════════════════════════════
 *  REST FETCHERS — initial hydration + periodic sync
 * ══════════════════════════════════════════════════════════════ */

/**
 * Fetch recent events from the REST API (hydration / fallback).
 * @param {object} [filter] — { taskId, type, since, limit }
 */
export async function fetchAgentEvents(filter = {}) {
  try {
    const params = new URLSearchParams();
    if (filter.taskId) params.set("taskId", filter.taskId);
    if (filter.type) params.set("type", filter.type);
    if (filter.since) params.set("since", String(filter.since));
    if (filter.limit) params.set("limit", String(filter.limit));
    const qs = params.toString();
    const url = `/api/agents/events${qs ? "?" + qs : ""}`;
    const res = await apiFetch(url, { _silent: true });
    if (res.ok && Array.isArray(res.events)) {
      agentEvents.value = res.events.slice().reverse();
    }
    return res;
  } catch {
    return null;
  }
}

/**
 * Fetch error pattern summary or per-task error history.
 * @param {string} [taskId] — if provided, gets error history for that task
 */
export async function fetchAgentErrors(taskId) {
  try {
    const url = taskId
      ? `/api/agents/events/errors?taskId=${encodeURIComponent(taskId)}`
      : "/api/agents/events/errors";
    const res = await apiFetch(url, { _silent: true });
    if (res.ok && !taskId && res.patterns) {
      agentErrors.value = res.patterns;
    }
    return res;
  } catch {
    return null;
  }
}

/**
 * Fetch agent liveness status.
 */
export async function fetchAgentLiveness() {
  try {
    const res = await apiFetch("/api/agents/events/liveness", {
      _silent: true,
    });
    if (res.ok && Array.isArray(res.agents)) {
      agentLiveness.value = res.agents;
    }
    return res;
  } catch {
    return null;
  }
}

/**
 * Fetch event bus system status.
 */
export async function fetchEventBusStatus() {
  try {
    const res = await apiFetch("/api/agents/events/status", {
      _silent: true,
    });
    if (res.ok) {
      eventBusStatus.value = res;
    }
    return res;
  } catch {
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
 *  LIFECYCLE — start/stop WS tracking + REST polling
 * ══════════════════════════════════════════════════════════════ */

/**
 * Start listening for agent events (WS + REST polling).
 * Call once at app startup. Returns a cleanup function.
 * @returns {() => void} stop function
 */
export function startAgentEventTracking() {
  if (_started) return stopAgentEventTracking;
  _started = true;

  // ── Subscribe to WS
  _wsUnsub = onWsMessage(_handleWsEvent);

  // ── Initial hydration from REST
  fetchAgentEvents({ limit: 100 });
  fetchAgentErrors();
  fetchAgentLiveness();
  fetchEventBusStatus();

  // ── Periodic fallback polling
  _pollTimer = setInterval(() => {
    fetchAgentErrors();
    fetchEventBusStatus();
  }, POLL_INTERVAL);

  _livenessPollTimer = setInterval(() => {
    fetchAgentLiveness();
  }, LIVENESS_POLL_INTERVAL);

  return stopAgentEventTracking;
}

/**
 * Stop all agent event tracking (WS + REST).
 */
export function stopAgentEventTracking() {
  _started = false;
  if (_wsUnsub) {
    _wsUnsub();
    _wsUnsub = null;
  }
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  if (_livenessPollTimer) {
    clearInterval(_livenessPollTimer);
    _livenessPollTimer = null;
  }
}

/* ══════════════════════════════════════════════════════════════
 *  UTILITY — helpers for UI components
 * ══════════════════════════════════════════════════════════════ */

/**
 * Get the most recent event for a specific task.
 * @param {string} taskId
 * @returns {object|null}
 */
export function getLatestEventForTask(taskId) {
  return agentEvents.value.find((e) => e.taskId === taskId) || null;
}

/**
 * Get all events of a specific type.
 * @param {string} type — e.g. "agent:task-completed"
 * @returns {Array}
 */
export function getEventsByType(type) {
  return agentEvents.value.filter((e) => e.type === type);
}

/**
 * Format an event type into a human-readable label.
 * @param {string} type — e.g. "agent:task-completed"
 * @returns {string} — e.g. "Task Completed"
 */
export function formatEventType(type) {
  if (!type) return "Unknown";
  return type
    .replace("agent:", "")
    .replace(/-/g, " ")
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Get a severity level for event type (for badge coloring).
 * @param {string} type
 * @returns {"info"|"success"|"warning"|"error"|"neutral"}
 */
export function getEventSeverity(type) {
  if (!type) return "neutral";
  if (type.includes("complete") || type.includes("passed") || type.includes("resumed"))
    return "success";
  if (type.includes("fail") || type.includes("error") || type.includes("block"))
    return "error";
  if (type.includes("retry") || type.includes("cooldown") || type.includes("stale") || type.includes("pattern"))
    return "warning";
  if (type.includes("started") || type.includes("heartbeat") || type.includes("review"))
    return "info";
  return "neutral";
}

/**
 * Relative time label (e.g., "2m ago", "just now").
 * @param {number} ts — timestamp
 * @returns {string}
 */
export function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 5000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
