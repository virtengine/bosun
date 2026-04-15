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
import { apiFetch, onWsMessage } from "./api.js";
import { buildHarnessTelemetryPath } from "./harness-client.js";
import {
  buildSessionsApiPath,
  getSessionRuntimeState,
  normalizeSessionEventPayload,
  normalizeSessionsUpdatePayload,
} from "./session-api.js";

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
const HARNESS_EVENTS_PATH = buildHarnessTelemetryPath("events");
const HARNESS_LIVE_PATH = buildHarnessTelemetryPath("live");
const HARNESS_SUMMARY_PATH = buildHarnessTelemetryPath("summary");

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

function _normalizeTimestamp(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function _normalizeEventType(value, fallback = "event") {
  const text = String(value || "").trim();
  return text || fallback;
}

function _normalizeTrackedEvent(raw = {}, overrides = {}) {
  const payload =
    raw && typeof raw === "object"
      ? { ...raw }
      : {};
  const type = _normalizeEventType(
    overrides.type || payload.eventType || payload.type || payload.kind,
  );
  const sessionId = String(
    overrides.sessionId || payload.sessionId || payload.id || payload.runId || "",
  ).trim();
  const taskId = String(
    overrides.taskId || payload.taskId || payload.sessionId || payload.id || "unknown",
  ).trim() || "unknown";
  const ts = _normalizeTimestamp(overrides.ts ?? payload.ts ?? payload.timestamp ?? payload.updatedAt);
  const id = String(
    overrides.id || payload.id || `${type}:${taskId}:${sessionId}:${ts}`,
  ).trim();
  return {
    id,
    type,
    taskId,
    sessionId,
    payload,
    ts,
  };
}

function _dedupeEvents(events = []) {
  const seen = new Set();
  const deduped = [];
  for (const event of events) {
    const id = String(event?.id || "").trim();
    const key = id || `${event?.type || ""}:${event?.taskId || ""}:${event?.sessionId || ""}:${event?.ts || 0}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  deduped.sort((left, right) => Number(right?.ts || 0) - Number(left?.ts || 0));
  if (deduped.length > MAX_CLIENT_EVENTS) deduped.length = MAX_CLIENT_EVENTS;
  return deduped;
}

function _isErrorLikeEvent(event) {
  const type = String(event?.type || "").trim().toLowerCase();
  const status = String(
    event?.payload?.status || event?.payload?.payload?.status || "",
  ).trim().toLowerCase();
  const reason = String(
    event?.payload?.reason || event?.payload?.summary || event?.payload?.message || "",
  ).trim().toLowerCase();
  return (
    type.includes("error")
    || type.includes("fail")
    || type.includes("stale")
    || status === "error"
    || status === "failed"
    || status === "stale"
    || reason.includes("error")
    || reason.includes("fail")
  );
}

function _resolveErrorPattern(event) {
  return String(
    event?.payload?.pattern
      || event?.payload?.reason
      || event?.payload?.eventType
      || event?.payload?.type
      || event?.type
      || "error",
  ).trim() || "error";
}

function _isAutoActionEvent(event) {
  const type = String(event?.type || "").trim().toLowerCase();
  const reason = String(event?.payload?.reason || "").trim().toLowerCase();
  if (AUTO_ACTION_TYPES.has(event?.type)) return true;
  return (
    type.includes("retry")
    || type.includes("review")
    || type.includes("cooldown")
    || type.includes("block")
    || type.includes("resume")
    || type.includes("pause")
    || reason.includes("retry")
    || reason.includes("review")
    || reason.includes("cooldown")
    || reason.includes("block")
  );
}

function _rebuildDerivedSignalsFromEvents(events = []) {
  const patterns = {};
  const autoActions = [];
  for (const event of events) {
    if (_isErrorLikeEvent(event)) {
      const pattern = _resolveErrorPattern(event);
      if (!patterns[pattern]) {
        patterns[pattern] = { count: 0, lastSeen: 0, tasks: [] };
      }
      patterns[pattern].count += 1;
      patterns[pattern].lastSeen = Math.max(patterns[pattern].lastSeen, Number(event.ts || 0));
      if (event.taskId && !patterns[pattern].tasks.includes(event.taskId)) {
        patterns[pattern].tasks = [...patterns[pattern].tasks, event.taskId];
      }
    }
    if (_isAutoActionEvent(event)) {
      autoActions.push(event);
    }
  }
  agentErrors.value = patterns;
  agentAutoActions.value = autoActions.slice(0, 50);
}

function _setTrackedEvents(events = []) {
  const normalized = _dedupeEvents(events);
  agentEvents.value = normalized;
  _rebuildDerivedSignalsFromEvents(normalized);
}

function _appendTrackedEvent(event) {
  if (!event || typeof event !== "object") return;
  _setTrackedEvents([event, ...agentEvents.value]);
}

function _upsertLivenessEntries(entries = []) {
  const byTaskId = new Map(
    Array.isArray(agentLiveness.value)
      ? agentLiveness.value.map((entry) => [String(entry?.taskId || "").trim(), entry])
      : [],
  );
  for (const entry of entries) {
    const taskId = String(entry?.taskId || "").trim();
    if (!taskId) continue;
    byTaskId.set(taskId, entry);
  }
  agentLiveness.value = Array.from(byTaskId.values()).sort((left, right) =>
    Number(right?.lastHeartbeat || 0) - Number(left?.lastHeartbeat || 0),
  );
}

function _updateLivenessFromSessions(sessions = []) {
  const now = Date.now();
  const entries = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const taskId = String(session?.taskId || session?.id || "").trim();
    if (!taskId) continue;
    const runtime = getSessionRuntimeState(session, { now });
    const lastHeartbeat = _normalizeTimestamp(
      session?.runtimeUpdatedAt || session?.lastActiveAt || session?.updatedAt || session?.createdAt,
    );
    entries.push({
      taskId,
      lastHeartbeat,
      alive: runtime.isLive === true,
      staleSinceMs:
        runtime.isStale && lastHeartbeat > 0
          ? Math.max(0, now - lastHeartbeat)
          : null,
    });
  }
  _upsertLivenessEntries(entries);
}

function _setHarnessStatus(summary = {}) {
  const liveSessions = Array.isArray(summary?.live?.sessions) ? summary.live.sessions.length : 0;
  eventBusStatus.value = {
    started: true,
    source: "harness-telemetry",
    eventCount: Number(summary?.eventCount || 0),
    lastEventAt: summary?.lastEventAt || null,
    liveSessionCount: liveSessions,
    metrics: summary?.metrics || null,
    providers: summary?.providers || null,
  };
}

function _buildHarnessEventsPath(filter = {}) {
  const params = new URLSearchParams();
  for (const key of ["taskId", "sessionId", "runId", "type", "category", "source", "since", "limit"]) {
    const value = filter?.[key];
    if (value == null) continue;
    const stringValue = String(value).trim();
    if (!stringValue) continue;
    params.set(key, stringValue);
  }
  const qs = params.toString();
  return qs ? `${HARNESS_EVENTS_PATH}?${qs}` : HARNESS_EVENTS_PATH;
}

/* ══════════════════════════════════════════════════════════════
 *  WS HANDLER — processes all agent:* events from the server
 * ══════════════════════════════════════════════════════════════ */

/**
 * Process an incoming WS message that is an agent event.
 * @param {object} msg — raw WS message { type, payload }
 */
function _handleWsEvent(msg) {
  if (msg?.type === "sessions:update") {
    _updateLivenessFromSessions(normalizeSessionsUpdatePayload(msg.payload));
    return;
  }

  if (msg?.type === "session:event") {
    const normalized = normalizeSessionEventPayload(msg.payload);
    if (normalized.session && typeof normalized.session === "object") {
      _updateLivenessFromSessions([normalized.session]);
    }
    const eventKind = String(normalized?.event?.kind || "").trim().toLowerCase();
    const eventType = eventKind === "message"
      ? `session:${String(normalized?.event?.message?.type || normalized?.event?.message?.role || "message").trim().toLowerCase()}`
      : `session:${String(normalized?.event?.reason || eventKind || "event").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    _appendTrackedEvent(_normalizeTrackedEvent({
      ...normalized.session,
      ...normalized.event,
      kind: eventKind,
      message: normalized?.event?.message || null,
      reason: normalized?.event?.reason || null,
      status: normalized?.session?.status || normalized?.session?.lifecycleStatus || null,
    }, {
      id: `${eventType}:${normalized.taskId || normalized.sessionId}:${_normalizeTimestamp(normalized?.event?.timestamp || normalized?.session?.updatedAt)}`,
      type: eventType,
      taskId: normalized.taskId,
      sessionId: normalized.sessionId,
      ts: _normalizeTimestamp(normalized?.event?.timestamp || normalized?.session?.updatedAt),
    }));
    return;
  }

  const type = msg.type || msg.payload?.type;
  if (!type || !type.startsWith(AGENT_EVENT_PREFIX)) return;
  const payload = msg.payload || {};
  const event = _normalizeTrackedEvent(payload, {
    type,
    taskId: payload.taskId || "unknown",
    sessionId: payload.sessionId || payload.taskId || "",
    ts: payload.ts || Date.now(),
  });
  _appendTrackedEvent(event);

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
    const url = _buildHarnessEventsPath(filter);
    const res = await apiFetch(url, { _silent: true });
    if (res?.ok && Array.isArray(res.events)) {
      _setTrackedEvents(res.events.map((entry) => _normalizeTrackedEvent(entry)));
      return res;
    }
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
    const res = await apiFetch(_buildHarnessEventsPath({
      taskId,
      limit: taskId ? 100 : 200,
    }), { _silent: true });
    if (res?.ok && Array.isArray(res.events)) {
      const events = res.events.map((entry) => _normalizeTrackedEvent(entry));
      const patterns = {};
      for (const event of events) {
        if (!_isErrorLikeEvent(event)) continue;
        const pattern = _resolveErrorPattern(event);
        if (!patterns[pattern]) {
          patterns[pattern] = { count: 0, lastSeen: 0, tasks: [] };
        }
        patterns[pattern].count += 1;
        patterns[pattern].lastSeen = Math.max(patterns[pattern].lastSeen, Number(event.ts || 0));
        if (event.taskId && !patterns[pattern].tasks.includes(event.taskId)) {
          patterns[pattern].tasks = [...patterns[pattern].tasks, event.taskId];
        }
      }
      if (!taskId) {
        agentErrors.value = patterns;
      }
      return {
        ok: true,
        patterns,
        events,
      };
    }
  } catch {
    return null;
  }
}

/**
 * Fetch agent liveness status.
 */
export async function fetchAgentLiveness() {
  try {
    const res = await apiFetch(buildSessionsApiPath({ workspace: "active" }), {
      _silent: true,
    });
    if (res?.ok && Array.isArray(res.sessions)) {
      _updateLivenessFromSessions(res.sessions);
      return res;
    }
  } catch {
    // Fall through to harness live projection below.
  }

  try {
    const res = await apiFetch(HARNESS_LIVE_PATH, { _silent: true });
    if (res?.ok && Array.isArray(res?.data?.sessions)) {
      const sessions = res.data.sessions.map((entry) => ({
        id: entry?.sessionId || entry?.id || entry?.taskId,
        taskId: entry?.taskId || entry?.id || entry?.sessionId,
        status: entry?.status || "active",
        lifecycleStatus: entry?.status || "active",
        runtimeState: entry?.status || "active",
        runtimeIsLive: !["completed", "failed", "archived", "stopped"].includes(
          String(entry?.status || "").trim().toLowerCase(),
        ),
        lastActiveAt: entry?.updatedAt || null,
        runtimeUpdatedAt: entry?.updatedAt || null,
      }));
      _updateLivenessFromSessions(sessions);
      return res;
    }
  } catch {
    return null;
  }
}

/**
 * Fetch event bus system status.
 */
export async function fetchEventBusStatus() {
  try {
    const res = await apiFetch(HARNESS_SUMMARY_PATH, {
      _silent: true,
    });
    if (res?.ok && res?.data && typeof res.data === "object") {
      _setHarnessStatus(res.data);
      return res;
    }
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
    fetchAgentEvents({ limit: 100 });
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
