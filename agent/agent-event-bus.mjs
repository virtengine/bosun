/**
 * agent-event-bus.mjs — Real-time agent lifecycle event bus
 *
 * Bridges agent-endpoint self-reports, task-executor callbacks,
 * error-detector classifications, and agent-hooks results into a
 * single unified event stream that:
 *
 *   1. Pushes to WebSocket clients for instant UI updates (zero-polling)
 *   2. Triggers auto-actions (retry, review, cooldown, block)
 *   3. Maintains a queryable in-memory event log with error pattern tracking
 *   4. Monitors agent liveness via heartbeat staleness detection
 *   5. Provides hooks for external subscribers (Telegram, logging, etc.)
 *
 * This module is the "nervous system" connecting the back-end orchestrator
 * to the front-end UI in real time with no polling latency.
 *
 * EXPORTS:
 *   createAgentEventBus(options) → AgentEventBus instance
 *   AgentEventBus class
 *   AGENT_EVENT  — Frozen enum of all event types
 *
 * Canonical architecture note:
 * This bus is the canonical runtime ingress for live agent events into the
 * observability spine. Surfaces may subscribe or rebroadcast, but canonical
 * event normalization and harness telemetry recording must remain centralized
 * here plus `infra/session-telemetry.mjs`.
 */

import {
  createRetryQueueState,
  reduceRetryQueue,
  snapshotRetryQueue,
} from "./retry-queue.mjs";
import { addSpanEvent, recordAgentError, recordIntervention } from "../infra/tracing.mjs";
import {
  getHarnessTelemetrySummary,
  listHarnessTelemetryEvents,
  recordHarnessTelemetryEvent,
} from "../infra/session-telemetry.mjs";
import { normalizeCanonicalBusEvent } from "../infra/event-schema.mjs";

const TAG = "[agent-event-bus]";

// ── Event Types ─────────────────────────────────────────────────────────────

/**
 * All possible agent lifecycle event types.
 * These map 1:1 to WS message types the UI listens for.
 */
export const AGENT_EVENT = Object.freeze({
  // ── Task lifecycle ──
  TASK_QUEUED: "agent:task-queued",
  TASK_STARTED: "agent:task-started",
  TASK_COMPLETED: "agent:task-completed",
  TASK_FAILED: "agent:task-failed",
  TASK_BLOCKED: "agent:task-blocked",
  TASK_STATUS_CHANGE: "agent:task-status-change",
  SESSION_ACCUMULATED: "session-accumulated",

  // ── Agent self-reports (from agent-endpoint) ──
  AGENT_HEARTBEAT: "agent:heartbeat",
  AGENT_COMPLETE: "agent:complete",
  AGENT_ERROR: "agent:error",

  // ── Auto-actions ──
  AUTO_RETRY: "agent:auto-retry",
  AUTO_REVIEW: "agent:auto-review",
  AUTO_COOLDOWN: "agent:auto-cooldown",
  AUTO_BLOCK: "agent:auto-block",
  AUTO_NEW_SESSION: "agent:auto-new-session",
  RETRY_QUEUE_UPDATED: "agent:retry-queue-updated",
  EXECUTOR_PAUSED: "agent:executor-paused",
  EXECUTOR_RESUMED: "agent:executor-resumed",

  // ── Error tracking ──
  ERROR_CLASSIFIED: "agent:error-classified",
  ERROR_PATTERN_DETECTED: "agent:error-pattern-detected",
  ERROR_THRESHOLD_REACHED: "agent:error-threshold-reached",

  // ── Liveness ──
  AGENT_ALIVE: "agent:alive",
  AGENT_STALE: "agent:stale",

  // ── Hook results (from agent-hooks.mjs) ──
  HOOK_PASSED: "agent:hook-passed",
  HOOK_FAILED: "agent:hook-failed",
});

// ── Default config ──────────────────────────────────────────────────────────

const DEFAULTS = {
  /** Max events kept in the in-memory ring buffer */
  maxEventLogSize: 500,
  /** Heartbeat staleness threshold (ms) — if no heartbeat for this long, emit AGENT_STALE */
  staleThresholdMs: 90_000,
  /** How often to check for stale agents (ms) */
  staleCheckIntervalMs: 30_000,
  /** Max error pattern history per task */
  maxErrorPatternsPerTask: 50,
  /** Cooldown between duplicate event broadcasts (ms) — prevents event storms */
  dedupeWindowMs: 500,
  /** Max auto-action retries before blocking */
  maxAutoRetries: 5,
  /** Retry count threshold before routing to review workflow hook (0 disables) */
  retryReviewThreshold: 0,
  /** Default delay before next retry attempt appears due */
  retryDelayMs: 15_000,
};

// ── AgentEventBus Class ─────────────────────────────────────────────────────

export class AgentEventBus {
  /**
   * @param {object} options
   * @param {Function} [options.broadcastUiEvent]     — (channels, type, payload) => void
   * @param {object}   [options.errorDetector]        — ErrorDetector instance
   * @param {object}   [options.reviewAgent]          — ReviewAgent instance
   * @param {Function} [options.sendTelegram]         — (msg) => void
   * @param {Function} [options.getTask]              — (taskId) => task object
   * @param {Function} [options.setTaskStatus]        — (taskId, status, source) => void
   * @param {number}   [options.maxEventLogSize]
   * @param {number}   [options.staleThresholdMs]
   * @param {number}   [options.staleCheckIntervalMs]
   * @param {number}   [options.maxAutoRetries]
   */
  constructor(options = {}) {
    this._broadcastUiEvent = options.broadcastUiEvent || null;
    this._errorDetector = options.errorDetector || null;
    this._reviewAgent = options.reviewAgent || null;
    this._sendTelegram = options.sendTelegram || null;
    this._getTask = options.getTask || null;
    this._setTaskStatus = options.setTaskStatus || null;
    this._updateTask = options.updateTask || null;
    this._supervisor = options.supervisor || null;

    this._maxEventLogSize = options.maxEventLogSize || DEFAULTS.maxEventLogSize;
    this._staleThresholdMs =
      options.staleThresholdMs || DEFAULTS.staleThresholdMs;
    this._staleCheckIntervalMs =
      options.staleCheckIntervalMs || DEFAULTS.staleCheckIntervalMs;
    this._maxAutoRetries =
      options.maxAutoRetries ?? DEFAULTS.maxAutoRetries;
    this._dedupeWindowMs = options.dedupeWindowMs || DEFAULTS.dedupeWindowMs;
    this._retryReviewThreshold =
      Number.isFinite(Number(options.retryReviewThreshold))
        ? Math.max(0, Math.trunc(Number(options.retryReviewThreshold)))
        : DEFAULTS.retryReviewThreshold;
    this._retryDelayMs =
      Number.isFinite(Number(options.retryDelayMs))
        ? Math.max(0, Math.trunc(Number(options.retryDelayMs)))
        : DEFAULTS.retryDelayMs;
    this._onRetryThresholdExceeded =
      typeof options.onRetryThresholdExceeded === "function"
        ? options.onRetryThresholdExceeded
        : null;
    this._setRetryQueueData =
      typeof options.setRetryQueueData === "function"
        ? options.setRetryQueueData
        : (typeof globalThis.__bosun_setRetryQueueData === "function"
            ? globalThis.__bosun_setRetryQueueData
            : null);
    this._configDir = options.configDir || process.cwd();

    /** @type {Array<{type: string, taskId: string, payload: object, ts: number}>} ring buffer */
    this._eventLog = [];

    /** @type {Map<string, number>} taskId → last heartbeat timestamp */
    this._heartbeats = new Map();

    /** @type {Map<string, Array<{pattern:string, ts:number, action:string, confidence:number}>>} */
    this._errorHistory = new Map();

    /** @type {Map<string, {retryCount:number, lastRetryAt:number, cooldownUntil:number}>} */
    this._autoActionState = new Map();

    /** @type {Set<Function>} external listeners */
    this._listeners = new Set();

    /** @type {Map<string, number>} dedup key → last emit timestamp */
    this._recentEmits = new Map();
    this._retryQueueState = createRetryQueueState();

    /** @type {ReturnType<typeof setInterval>|null} */
    this._staleCheckTimer = null;

    /** @type {boolean} */
    this._started = false;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  start() {
    if (this._started) return;
    this._started = true;
    this._staleCheckTimer = setInterval(
      () => this._checkStaleAgents(),
      this._staleCheckIntervalMs,
    );
    console.log(
      `${TAG} started (stale-check=${this._staleCheckIntervalMs}ms, log-cap=${this._maxEventLogSize})`,
    );
  }

  stop() {
    this._started = false;
    if (this._staleCheckTimer) {
      clearInterval(this._staleCheckTimer);
      this._staleCheckTimer = null;
    }
    console.log(`${TAG} stopped`);
  }

  /**
   * Set the AgentSupervisor instance for integrated health scoring.
   * Call after both event bus and supervisor are created.
   * @param {object} supervisor - AgentSupervisor instance
   */
  setSupervisor(supervisor) {
    this._supervisor = supervisor || null;
  }

  // ── External Listener API ──────────────────────────────────────────────

  /**
   * Register a listener for all agent events.
   * @param {(event: {type:string,taskId:string,payload:object,ts:number}) => void} fn
   * @returns {() => void} unsubscribe
   */
  addListener(fn) {
    if (typeof fn !== "function") return () => {};
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  // ── Core Emit ──────────────────────────────────────────────────────────

  /**
   * Emit an agent lifecycle event.
   *
   * @param {string} type    — One of AGENT_EVENT values
   * @param {string} taskId
   * @param {object} payload
   * @param {object} [opts]
   * @param {boolean} [opts.skipBroadcast]
   */
  emit(type, taskId, payload = {}, opts = {}) {
    const ts = Date.now();
    const event = { type, taskId, payload, ts };
    addSpanEvent(type, { "bosun.task.id": taskId, ...payload });
    if (type === AGENT_EVENT.AGENT_ERROR) {
      recordAgentError(payload?.errorType || payload?.classification || "agent_error", {
        "bosun.task.id": taskId,
        "bosun.executor": payload?.executor,
        "bosun.agent.sdk": payload?.sdk,
      });
    }

    // ── Dedup
    const key = `${type}:${taskId}`;
    const last = this._recentEmits.get(key);
    if (typeof last === "number" && ts - last < this._dedupeWindowMs) return;
    this._recentEmits.set(key, ts);
    if (this._recentEmits.size > 200) {
      const cutoff = ts - this._dedupeWindowMs * 2;
      for (const [k, v] of this._recentEmits) {
        if (v < cutoff) this._recentEmits.delete(k);
      }
    }

    // ── Ring buffer
    this._eventLog.push(event);
    if (this._eventLog.length > this._maxEventLogSize) {
      this._eventLog.shift();
    }
    this._recordCanonicalEvent(event);

    // ── WS broadcast
    if (!opts.skipBroadcast) {
      this._broadcastToUi(event);
    }

    // ── External listeners
    for (const fn of this._listeners) {
      try {
        fn(event);
      } catch (err) {
        console.warn(`${TAG} listener error:`, err.message || err);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  HOOK METHODS — called from monitor.mjs / agent-endpoint callbacks
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Task started by executor.
   * @param {object} task
   * @param {object} slot — { sdk, agentInstanceId, branch, worktreePath }
   */
  onTaskStarted(task, slot) {
    const taskId = task?.id || task?.task_id || "unknown";
    this.emit(AGENT_EVENT.TASK_STARTED, taskId, {
      title: task?.title || "",
      sdk: slot?.sdk || "unknown",
      agentInstanceId: slot?.agentInstanceId ?? null,
      branch: slot?.branch || null,
      worktreePath: slot?.worktreePath || null,
    });
    if (!this._autoActionState.has(taskId)) {
      this._autoActionState.set(taskId, {
        retryCount: 0,
        lastRetryAt: 0,
        cooldownUntil: 0,
        taskTitle: String(task?.title || "").trim(),
      });
    } else {
      const state = this._autoActionState.get(taskId);
      if (state) {
        if (state.cooldownUntil > 0) {
          state.cooldownUntil = 0;
        }
        const startedTitle = String(task?.title || "").trim();
        if (startedTitle) {
          state.taskTitle = startedTitle;
        }
        this._autoActionState.set(taskId, state);
      }
    }
    this._updateRetryQueue(
      { type: "remove", taskId },
      { reason: "task-started", taskId },
    );
  }

  /**
   * Task completed by executor (post-execution).
   * @param {object} task
   * @param {object} result — { attempts, success, hasCommits, branch, prUrl, prNumber }
   */
  onTaskCompleted(task, result) {
    const taskId = task?.id || task?.task_id || "unknown";
    this.emit(AGENT_EVENT.TASK_COMPLETED, taskId, {
      title: task?.title || "",
      attempts: result?.attempts || 1,
      success: !!result?.success,
      hasCommits: !!result?.hasCommits,
      branch: result?.branch || task?.branchName || null,
      prUrl: result?.prUrl || null,
      prNumber: result?.prNumber || null,
    });
    this._autoActionState.delete(taskId);
    this._updateRetryQueue(
      { type: "remove", taskId },
      { reason: "task-completed", taskId },
    );

    // Auto-review
    if (result?.success && this._reviewAgent) {
      this._triggerAutoReview(task, result);
    }
  }

  /**
   * Task failed in executor.
   * @param {object} task
   * @param {Error|string} err
   */
  onTaskFailed(task, err) {
    const taskId = task?.id || task?.task_id || "unknown";
    const errorMsg =
      typeof err === "string" ? err : err?.message || String(err);

    this.emit(AGENT_EVENT.TASK_FAILED, taskId, {
      title: task?.title || "",
      error: errorMsg,
    });

    const failedTitle = String(task?.title || "").trim();
    if (failedTitle) {
      const state = this._autoActionState.get(taskId) || {
        retryCount: 0,
        lastRetryAt: 0,
        cooldownUntil: 0,
      };
      state.taskTitle = failedTitle;
      this._autoActionState.set(taskId, state);
    }

    if (this._errorDetector) {
      const cls = this._errorDetector.classify(errorMsg, "");
      this._handleClassification(taskId, cls, errorMsg);
    }
  }

  /**
   * Agent self-reported completion via /complete endpoint.
   * @param {string} taskId
   * @param {object} body — { hasCommits, branch, prUrl, prNumber, output }
   */
  onAgentComplete(taskId, body = {}) {
    this.emit(AGENT_EVENT.AGENT_COMPLETE, taskId, {
      hasCommits: !!body.hasCommits,
      branch: body.branch || null,
      prUrl: body.prUrl || null,
      prNumber: body.prNumber || null,
    });

    if (body.hasCommits && this._setTaskStatus) {
      try {
        this._setTaskStatus(taskId, "inreview", "agent-event-bus");
      } catch { /* best-effort */ }
    }

    if (this._reviewAgent) {
      const task = this._resolveTask(taskId);
      if (task) this._triggerAutoReview(task, body);
    }
  }

  /**
   * Agent self-reported error via /error endpoint.
   * @param {string} taskId
   * @param {object} body — { error, pattern, output }
   */
  onAgentError(taskId, body = {}) {
    const errorMsg = body.error || "Unknown error";
    const output = body.output || "";

    this.emit(AGENT_EVENT.AGENT_ERROR, taskId, {
      error: errorMsg,
      pattern: body.pattern || null,
    });

    if (this._errorDetector) {
      const cls = this._errorDetector.classify(output, errorMsg);
      this._handleClassification(taskId, cls, errorMsg);
    }
  }

  /**
   * Agent heartbeat.
   * @param {string} taskId
   * @param {object} body — { message }
   */
  onAgentHeartbeat(taskId, body = {}) {
    this._heartbeats.set(taskId, Date.now());
    this.emit(AGENT_EVENT.AGENT_HEARTBEAT, taskId, {
      message: body.message || null,
      alive: true,
    });
  }

  /**
   * Agent status changed via agent-endpoint /status.
   * @param {string} taskId
   * @param {string} newStatus
   * @param {string} [source]
   */
  onStatusChange(taskId, newStatus, source = "agent") {
    this.emit(AGENT_EVENT.TASK_STATUS_CHANGE, taskId, {
      status: newStatus,
      source,
    });

    if (this._setTaskStatus) {
      try {
        this._setTaskStatus(taskId, newStatus, source || "agent-event-bus");
      } catch { /* best-effort */ }
    }

    if (newStatus === "blocked") {
      this.emit(AGENT_EVENT.TASK_BLOCKED, taskId, { source });
      if (this._sendTelegram) {
        const task = this._resolveTask(taskId);
        const title = task?.title || taskId;
        this._sendTelegram(`:close: Task blocked: "${title}" (source: ${source})`);
      }
    }
    if (newStatus !== "error") {
      this._updateRetryQueue(
        { type: "remove", taskId },
        { reason: `status:${newStatus}`, taskId },
      );
    }
  }

  /**
   * Executor paused.
   * @param {string} [reason]
   */
  onExecutorPaused(reason) {
    this.emit(AGENT_EVENT.EXECUTOR_PAUSED, "system", {
      reason: reason || "manual",
    });
    if (this._sendTelegram) {
      this._sendTelegram(`:pause: Executor paused: ${reason || "manual"}`);
    }
  }

  /**
   * Executor resumed.
   */
  onExecutorResumed() {
    this.emit(AGENT_EVENT.EXECUTOR_RESUMED, "system", {});
  }

  /**
   * Hook execution result (from agent-hooks.mjs).
   * @param {string} taskId
   * @param {string} hookEvent — e.g. "PrePush"
   * @param {boolean} passed
   * @param {object} details — { hookId, output, durationMs }
   */
  onHookResult(taskId, hookEvent, passed, details = {}) {
    const type = passed ? AGENT_EVENT.HOOK_PASSED : AGENT_EVENT.HOOK_FAILED;
    this.emit(type, taskId, {
      hookEvent,
      hookId: details.hookId || null,
      output: details.output || null,
      durationMs: details.durationMs || null,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  QUERY API — used by UI routes to fetch state
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get event log with optional filters.
   * @param {object} [filter]
   * @param {string} [filter.taskId]
   * @param {string} [filter.type]
   * @param {number} [filter.since] — timestamp
   * @param {number} [filter.limit]
   * @returns {Array}
   */
  getEventLog(filter = {}) {
    let events = this._eventLog;
    if (filter.taskId) events = events.filter((e) => e.taskId === filter.taskId);
    if (filter.type) events = events.filter((e) => e.type === filter.type);
    if (filter.since) events = events.filter((e) => e.ts >= filter.since);
    if (filter.limit) events = events.slice(-filter.limit);
    return events;
  }

  /**
   * Get error history for a task.
   * @param {string} taskId
   * @returns {Array}
   */
  getErrorHistory(taskId) {
    return this._errorHistory.get(taskId) || [];
  }

  /**
   * Aggregated error pattern summary across all tasks.
   * @returns {object} { [pattern]: { count, lastSeen, tasks:string[] } }
   */
  getErrorPatternSummary() {
    const summary = {};
    for (const [taskId, errors] of this._errorHistory) {
      for (const err of errors) {
        if (!summary[err.pattern]) {
          summary[err.pattern] = { count: 0, lastSeen: 0, tasks: new Set() };
        }
        summary[err.pattern].count++;
        summary[err.pattern].lastSeen = Math.max(
          summary[err.pattern].lastSeen,
          err.ts,
        );
        summary[err.pattern].tasks.add(taskId);
      }
    }
    for (const key of Object.keys(summary)) {
      summary[key].tasks = Array.from(summary[key].tasks);
    }
    return summary;
  }

  /**
   * Agent liveness status.
   * @returns {Array<{taskId:string, lastHeartbeat:number, alive:boolean, staleSinceMs:number|null}>}
   */
  getAgentLiveness() {
    const now = Date.now();
    const result = [];
    for (const [taskId, lastHb] of this._heartbeats) {
      const elapsed = now - lastHb;
      result.push({
        taskId,
        lastHeartbeat: lastHb,
        alive: elapsed < this._staleThresholdMs,
        staleSinceMs: elapsed >= this._staleThresholdMs ? elapsed : null,
      });
    }
    return result;
  }

  /**
   * Full system status.
   * @returns {object}
   */
  getStatus() {
    const retryQueue = snapshotRetryQueue(this._retryQueueState);
    const observability = getHarnessTelemetrySummary({ configDir: this._configDir });
    return {
      started: this._started,
      eventLogSize: this._eventLog.length,
      trackedAgents: this._heartbeats.size,
      errorTrackedTasks: this._errorHistory.size,
      autoActionTasks: this._autoActionState.size,
      listenerCount: this._listeners.size,
      retryQueue,
      liveness: this.getAgentLiveness(),
      errorPatterns: this.getErrorPatternSummary(),
      observability: {
        eventCount: Number(observability?.eventCount || 0),
        lastEventAt: observability?.lastEventAt || null,
      },
    };
  }

  getRetryQueue() {
    return snapshotRetryQueue(this._retryQueueState);
  }

  getCanonicalEventLog(filter = {}) {
    return listHarnessTelemetryEvents({
      ...filter,
      source: filter.source || "agent-event-bus",
    }, { configDir: this._configDir });
  }

  clearRetryQueueTask(taskId, reason = "manual") {
    const id = String(taskId || "").trim();
    if (!id) return;
    const state = this._autoActionState.get(id);
    if (state && state.cooldownUntil > 0) {
      state.cooldownUntil = 0;
      this._autoActionState.set(id, state);
    }
    this._updateRetryQueue(
      { type: "remove", taskId: id },
      { reason, taskId: id },
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INTERNAL
  // ══════════════════════════════════════════════════════════════════════════

  _broadcastToUi(event) {
    if (!this._broadcastUiEvent) return;
    try {
      this._broadcastUiEvent(
        ["agents", "tasks", "overview"],
        event.type,
        { taskId: event.taskId, ...event.payload, ts: event.ts },
      );
    } catch (err) {
      console.warn(`${TAG} WS broadcast error:`, err.message || err);
    }
  }

  _recordCanonicalEvent(event) {
    recordHarnessTelemetryEvent(
      normalizeCanonicalBusEvent(event),
      { configDir: this._configDir },
    );
  }

  _updateRetryQueue(action, meta = {}) {
    this._retryQueueState = reduceRetryQueue(this._retryQueueState, action);
    const snapshot = snapshotRetryQueue(this._retryQueueState);
    if (!this._setRetryQueueData && typeof globalThis.__bosun_setRetryQueueData === "function") {
      this._setRetryQueueData = globalThis.__bosun_setRetryQueueData;
    }
    if (typeof this._setRetryQueueData === "function") {
      try {
        this._setRetryQueueData(snapshot);
      } catch {
        /* best effort */
      }
    }
    this.emit(AGENT_EVENT.RETRY_QUEUE_UPDATED, meta.taskId || "system", {
      reason: meta.reason || "retry-queue-updated",
      retryQueue: snapshot,
    });
  }

  _tryTriggerRetryThresholdReview(payload) {
    if (!this._onRetryThresholdExceeded) return;
    try {
      const maybePromise = this._onRetryThresholdExceeded(payload);
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.catch((err) => {
          console.warn(`${TAG} retry-threshold hook failed:`, err?.message || err);
        });
      }
    } catch (err) {
      console.warn(`${TAG} retry-threshold hook failed:`, err?.message || err);
    }
  }

  _handleClassification(taskId, classification, rawError) {
    const ts = Date.now();
    if (!this._errorHistory.has(taskId)) {
      this._errorHistory.set(taskId, []);
    }
    const history = this._errorHistory.get(taskId);

    let recovery = null;
    if (this._errorDetector) {
      recovery = this._errorDetector.recordError(taskId, classification);
    }

    const action = recovery?.action || "manual";
    history.push({
      pattern: classification.pattern,
      ts,
      action,
      confidence: classification.confidence,
      details: classification.details || "",
      rawMatch: classification.rawMatch || null,
    });

    // Trim
    if (history.length > DEFAULTS.maxErrorPatternsPerTask) {
      history.splice(0, history.length - DEFAULTS.maxErrorPatternsPerTask);
    }

    // Emit
    this.emit(
      AGENT_EVENT.ERROR_CLASSIFIED,
      taskId,
      {
        pattern: classification.pattern,
        confidence: classification.confidence,
        details: classification.details || "",
        action,
        errorCount: recovery?.errorCount || 0,
      },
      { skipBroadcast: false },
    );

    this._detectPatternTrend(taskId);
    this._executeAutoAction(taskId, action, recovery, classification, rawError);
  }

  /**
   * @param {string} taskId
   * @param {string} action
   * @param {object|null} recovery
   * @param {object} classification
   * @param {string} rawError
   */
  _executeAutoAction(taskId, action, recovery, classification, rawError) {
    const state = this._autoActionState.get(taskId) || {
      retryCount: 0,
      lastRetryAt: 0,
      cooldownUntil: 0,
    };
    const now = Date.now();
    const task = this._resolveTask(taskId);
    const taskTitle =
      String(task?.title || "").trim()
      || String(this._autoActionState.get(taskId)?.taskTitle || "").trim();

    if (state.cooldownUntil > now) {
      console.log(
        `${TAG} ${taskId} in cooldown until ${new Date(state.cooldownUntil).toISOString()}`,
      );
      return;
    }

    switch (action) {
      case "retry_with_prompt": {
        if (this._retryReviewThreshold > 0 && state.retryCount >= this._retryReviewThreshold) {
          const reason =
            recovery?.reason ||
            `retry threshold reached (${state.retryCount}/${this._retryReviewThreshold})`;
          this._updateRetryQueue(
            { type: "mark-exhausted", taskId },
            { reason: "retry-threshold-exceeded", taskId },
          );
          this.emit(AGENT_EVENT.AUTO_REVIEW, taskId, {
            reason,
            retryCount: state.retryCount,
            threshold: this._retryReviewThreshold,
            pattern: classification?.pattern || null,
            source: "retry-threshold",
          });
          this._tryTriggerRetryThresholdReview({
            taskId,
            reason,
            retryCount: state.retryCount,
            threshold: this._retryReviewThreshold,
            classification,
            recovery,
            rawError,
          });
          console.log(`${TAG} ${taskId} reached retry threshold (${state.retryCount}); routed to review workflow`);
          return;
        }
        if (state.retryCount >= this._maxAutoRetries) {
          console.log(`${TAG} ${taskId} exhausted retries (${state.retryCount})`);
          this._executeAutoAction(taskId, "block", recovery, classification, rawError);
          return;
        }
        state.retryCount++;
        state.lastRetryAt = now;
        this._autoActionState.set(taskId, state);
        const retryDelayMs =
          Number.isFinite(Number(recovery?.cooldownMs))
            ? Math.max(0, Math.trunc(Number(recovery.cooldownMs)))
            : this._retryDelayMs;
        const nextAttemptAt = now + retryDelayMs;
        this._updateRetryQueue(
          {
            type: "bump-count",
            taskId,
            retryCount: state.retryCount,
            item: {
              taskId,
              taskTitle,
              retryCount: state.retryCount,
              maxRetries: this._maxAutoRetries,
              reason: recovery?.reason || "error detected",
              lastError: rawError || recovery?.reason || "",
              nextAttemptAt,
              status: "scheduled",
            },
          },
          { reason: "auto-retry", taskId },
        );

        this.emit(AGENT_EVENT.AUTO_RETRY, taskId, {
          retryCount: state.retryCount,
          maxRetries: this._maxAutoRetries,
          reason: recovery?.reason || "error detected",
          prompt: recovery?.prompt || null,
          pattern: classification?.pattern,
          nextAttemptAt,
          retryDelayMs,
        });
        console.log(
          `${TAG} auto-retry #${state.retryCount}/${this._maxAutoRetries} for ${taskId} (${classification?.pattern || "?"})`,
        );
        break;
      }

      case "cooldown": {
        const cooldownMs = recovery?.cooldownMs || 60_000;
        state.cooldownUntil = now + cooldownMs;
        this._autoActionState.set(taskId, state);

        this.emit(AGENT_EVENT.AUTO_COOLDOWN, taskId, {
          cooldownMs,
          cooldownUntil: state.cooldownUntil,
          reason: recovery?.reason || "rate limited",
          pattern: classification?.pattern,
        });
        this._updateRetryQueue(
          {
            type: "upsert",
            item: {
              taskId,
              taskTitle,
              retryCount: state.retryCount,
              maxRetries: this._maxAutoRetries,
              reason: recovery?.reason || "rate limited",
              lastError: rawError || recovery?.reason || "",
              nextAttemptAt: state.cooldownUntil,
              status: "cooldown",
            },
          },
          { reason: "auto-cooldown", taskId },
        );
        console.log(
          `${TAG} cooldown ${cooldownMs}ms for ${taskId} (${classification?.pattern || "?"})`,
        );
        break;
      }

      case "block": {
        this._updateRetryQueue(
          { type: "mark-exhausted", taskId },
          { reason: "auto-block", taskId },
        );
        this.emit(AGENT_EVENT.AUTO_BLOCK, taskId, {
          reason: recovery?.reason || "too many errors",
          errorCount: recovery?.errorCount || 0,
          pattern: classification?.pattern,
        });

        if (this._setTaskStatus) {
          try {
            this._setTaskStatus(taskId, "blocked", "agent-event-bus");
          } catch { /* best-effort */ }
        }

        // Persist blocked metadata so auto-recovery can unblock after cooldown.
        if (this._updateTask) {
          try {
            const autoRecoverDelayMs = 30 * 60 * 1000; // 30 min cooldown
            const retryAt = new Date(now + autoRecoverDelayMs).toISOString();
            const blockedReason = String(recovery?.reason || "too many consecutive errors").trim();
            const existingTask = typeof this._getTask === "function" ? this._getTask(taskId) : null;
            const existingMeta = existingTask?.meta && typeof existingTask.meta === "object" ? existingTask.meta : {};
            this._updateTask(taskId, {
              blockedReason,
              cooldownUntil: retryAt,
              meta: {
                ...existingMeta,
                autoRecovery: {
                  active: true,
                  reason: "consecutive_errors",
                  errorCount: recovery?.errorCount || 0,
                  pattern: classification?.pattern || null,
                  retryAt,
                  recoveryDelayMs: autoRecoverDelayMs,
                  recordedAt: new Date(now).toISOString(),
                },
              },
            });
          } catch { /* best-effort */ }
        }

        if (this._sendTelegram) {
          const title = taskTitle || taskId;
          this._sendTelegram(
            `:close: Auto-blocked: "${title}" — ${recovery?.reason || "too many errors"}`,
          );
        }
        console.log(
          `${TAG} auto-blocked ${taskId}: ${recovery?.reason || "threshold"}`,
        );
        break;
      }

      case "new_session": {
        state.retryCount++;
        state.lastRetryAt = now;
        this._autoActionState.set(taskId, state);
        this._updateRetryQueue(
          {
            type: "bump-count",
            taskId,
            retryCount: state.retryCount,
            item: {
              taskId,
              taskTitle,
              retryCount: state.retryCount,
              maxRetries: this._maxAutoRetries,
              reason: recovery?.reason || "new session",
              lastError: rawError || recovery?.reason || "",
              nextAttemptAt: now + this._retryDelayMs,
              status: "new-session",
            },
          },
          { reason: "auto-new-session", taskId },
        );

        this.emit(AGENT_EVENT.AUTO_NEW_SESSION, taskId, {
          reason: recovery?.reason || "session expired / token overflow",
          retryCount: state.retryCount,
          pattern: classification?.pattern,
        });
        console.log(
          `${TAG} new-session for ${taskId}: ${recovery?.reason || "overflow"}`,
        );
        break;
      }

      case "pause_executor": {
        this.emit(AGENT_EVENT.EXECUTOR_PAUSED, "system", {
          reason: recovery?.reason || "rate limit flood",
          triggeredBy: taskId,
        });
        if (this._sendTelegram) {
          this._sendTelegram(
            `:pause: Executor auto-paused: ${recovery?.reason || "rate limit flood"}`,
          );
        }
        console.log(`${TAG} executor paused: ${recovery?.reason}`);
        break;
      }

      case "manual":
      default: {
        this._updateRetryQueue(
          { type: "remove", taskId },
          { reason: "manual-review", taskId },
        );
        console.log(
          `${TAG} manual review needed for ${taskId}: ${recovery?.reason || rawError}`,
        );
        if (this._sendTelegram && (recovery?.errorCount || 0) >= 3) {
          const title = taskTitle || taskId;
          this._sendTelegram(
            `:alert: "${title}" needs manual review: ${recovery?.reason || "repeated errors"}`,
          );
        }
        break;
      }
    }

    // ── Forward error context to supervisor for unified health scoring ──
    if (this._supervisor) {
      try {
        this._supervisor.assess(taskId, {
          error: rawError,
          errorPattern: classification?.pattern,
        });
      } catch { /* best-effort */ }
    }
  }

  _detectPatternTrend(taskId) {
    const history = this._errorHistory.get(taskId);
    if (!history || history.length < 3) return;

    const recent = history.slice(-5);
    const counts = {};
    for (const e of recent) counts[e.pattern] = (counts[e.pattern] || 0) + 1;

    for (const [pattern, count] of Object.entries(counts)) {
      if (count >= 3) {
        this.emit(AGENT_EVENT.ERROR_PATTERN_DETECTED, taskId, {
          pattern,
          frequency: count,
          window: recent.length,
          message: `"${pattern}" appeared ${count}/${recent.length} times recently`,
        });
      }
    }

    if (history.length >= DEFAULTS.maxAutoRetries) {
      const tail = history.slice(-DEFAULTS.maxAutoRetries);
      const allUnresolvable = tail.every(
        (e) => e.action === "block" || e.action === "manual",
      );
      if (allUnresolvable) {
        this.emit(AGENT_EVENT.ERROR_THRESHOLD_REACHED, taskId, {
          totalErrors: history.length,
          message: `${taskId}: ${history.length} errors, all recent unresolvable`,
        });
      }
    }
  }

  _checkStaleAgents() {
    const now = Date.now();
    const beforeSnapshot = snapshotRetryQueue(this._retryQueueState);
    this._retryQueueState = reduceRetryQueue(this._retryQueueState, {
      type: "expire",
      now,
    });
    const afterSnapshot = snapshotRetryQueue(this._retryQueueState);
    const queueChanged =
      beforeSnapshot.count !== afterSnapshot.count ||
      JSON.stringify(beforeSnapshot.items) !== JSON.stringify(afterSnapshot.items) ||
      JSON.stringify(beforeSnapshot.stats) !== JSON.stringify(afterSnapshot.stats);
    if (queueChanged && typeof this._setRetryQueueData === "function") {
      try {
        this._setRetryQueueData(afterSnapshot);
      } catch {
        /* best effort */
      }
    }
    if (queueChanged) {
      this.emit(AGENT_EVENT.RETRY_QUEUE_UPDATED, "system", {
        reason: "expire",
        retryQueue: afterSnapshot,
      });
    }
    for (const [taskId, lastHb] of this._heartbeats) {
      const elapsed = now - lastHb;
      if (elapsed >= this._staleThresholdMs) {
        this.emit(AGENT_EVENT.AGENT_STALE, taskId, {
          lastHeartbeat: lastHb,
          staleSinceMs: elapsed,
        });
        this._heartbeats.delete(taskId);
      }
    }
  }

  _triggerAutoReview(task, result) {
    if (!this._reviewAgent) return;
    const taskId = task?.id || task?.task_id || "unknown";
    try {
      this._reviewAgent.queueReview({
        id: taskId,
        title: task?.title || "",
        prNumber: result?.prNumber,
        branchName:
          result?.branch || task?.branchName || task?.meta?.branch_name,
        description: task?.description || "",
        taskContext: task?._taskContextBlock || task?.meta?.taskContextBlock || "",
      });
      this.emit(AGENT_EVENT.AUTO_REVIEW, taskId, {
        title: task?.title || "",
        branch: result?.branch || task?.branchName || null,
        prNumber: result?.prNumber || null,
      });
      console.log(`${TAG} auto-review queued for ${taskId}`);
    } catch (err) {
      console.warn(
        `${TAG} auto-review failed for ${taskId}: ${err.message || err}`,
      );
    }
  }

  _resolveTask(taskId) {
    if (!this._getTask) return null;
    try {
      return this._getTask(taskId) || null;
    } catch {
      return null;
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an AgentEventBus instance.
 * @param {object} [options] — Same as AgentEventBus constructor
 * @returns {AgentEventBus}
 */
export function createAgentEventBus(options) {
  return new AgentEventBus(options);
}
