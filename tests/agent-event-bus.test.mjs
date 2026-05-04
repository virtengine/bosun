import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  AgentEventBus,
  createAgentEventBus,
  AGENT_EVENT,
} from "../agent/agent-event-bus.mjs";
import { resetHarnessObservabilitySpinesForTests } from "../infra/session-telemetry.mjs";

describe("agent-event-bus", () => {
  /** @type {AgentEventBus} */
  let bus;
  /** @type {Function[]} */
  let receivedEvents;
  /** @type {Function} */
  let mockBroadcast;

  beforeEach(() => {
    vi.useFakeTimers();
    receivedEvents = [];
    mockBroadcast = vi.fn();
    bus = createAgentEventBus({
      broadcastUiEvent: mockBroadcast,
      maxEventLogSize: 20,
      staleThresholdMs: 5000,
      staleCheckIntervalMs: 2000,
      maxAutoRetries: 3,
    });
  });

  afterEach(() => {
    bus.stop();
    resetHarnessObservabilitySpinesForTests();
    vi.useRealTimers();
  });

  // ── Factory ─────────────────────────────────────────────────────────

  describe("createAgentEventBus", () => {
    it("returns an AgentEventBus instance", () => {
      expect(bus).toBeInstanceOf(AgentEventBus);
    });

    it("has correct AGENT_EVENT constants", () => {
      expect(AGENT_EVENT.TASK_STARTED).toBe("agent:task-started");
      expect(AGENT_EVENT.TASK_COMPLETED).toBe("agent:task-completed");
      expect(AGENT_EVENT.AGENT_HEARTBEAT).toBe("agent:heartbeat");
      expect(AGENT_EVENT.AGENT_ERROR).toBe("agent:error");
      expect(AGENT_EVENT.AUTO_RETRY).toBe("agent:auto-retry");
      expect(AGENT_EVENT.RETRY_QUEUE_UPDATED).toBe("agent:retry-queue-updated");
      expect(AGENT_EVENT.ERROR_CLASSIFIED).toBe("agent:error-classified");
      expect(AGENT_EVENT.AGENT_STALE).toBe("agent:stale");
    });
  });

  // ── Lifecycle ───────────────────────────────────────────────────────

  describe("start / stop", () => {
    it("starts and reports status", () => {
      bus.start();
      const status = bus.getStatus();
      expect(status.started).toBe(true);
      expect(status.eventLogSize).toBe(0);
    });

    it("stops cleanly", () => {
      bus.start();
      bus.stop();
      const status = bus.getStatus();
      expect(status.started).toBe(false);
    });

    it("is idempotent — double start", () => {
      bus.start();
      bus.start(); // should not throw
      expect(bus.getStatus().started).toBe(true);
    });
  });

  // ── Core Emit ───────────────────────────────────────────────────────

  describe("emit", () => {
    it("records events in the log", () => {
      bus.emit(AGENT_EVENT.TASK_STARTED, "task-1", { title: "Test" });
      const log = bus.getEventLog();
      expect(log).toHaveLength(1);
      expect(log[0].type).toBe("agent:task-started");
      expect(log[0].taskId).toBe("task-1");
      expect(log[0].payload.title).toBe("Test");
    });

    it("broadcasts to UI via broadcastUiEvent", () => {
      bus.emit(AGENT_EVENT.TASK_STARTED, "task-1", { title: "Test" });
      expect(mockBroadcast).toHaveBeenCalledOnce();
      expect(mockBroadcast).toHaveBeenCalledWith(
        ["agents", "tasks", "overview"],
        "agent:task-started",
        expect.objectContaining({ taskId: "task-1", title: "Test" }),
      );
    });

    it("skips broadcast when opts.skipBroadcast is true", () => {
      bus.emit(AGENT_EVENT.TASK_STARTED, "task-1", {}, { skipBroadcast: true });
      expect(mockBroadcast).not.toHaveBeenCalled();
    });

    it("still records skipBroadcast events in the canonical telemetry log", () => {
      bus.emit(AGENT_EVENT.TASK_STARTED, "task-1", {
        sessionId: "session-1",
        runId: "run-1",
        providerId: "openai-api",
      }, { skipBroadcast: true });

      const events = bus.getCanonicalEventLog({ taskId: "task-1" });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(expect.objectContaining({
        source: "agent-event-bus",
        taskId: "task-1",
        sessionId: "session-1",
        runId: "run-1",
        providerId: "openai-api",
      }));
    });

    it("forwards artifact and subagent payload fields into canonical telemetry filters", () => {
      bus.emit(AGENT_EVENT.TASK_COMPLETED, "task-1", {
        sessionId: "session-1",
        rootSessionId: "session-root-1",
        runId: "run-1",
        rootRunId: "run-root-1",
        providerId: "openai-api",
        modelId: "gpt-5.4",
        toolId: "apply_patch",
        toolName: "apply_patch",
        approvalId: "approval-bus-1",
        filePath: "server/ui-server.mjs",
        patchHash: "patch-bus-1",
        childSessionId: "session-child-bus-1",
        childTaskId: "task-child-bus-1",
        subagentId: "subagent-bus-1",
      }, { skipBroadcast: true });

      const fileEvents = bus.getCanonicalEventLog({ filePath: "server/ui-server.mjs" });
      const childEvents = bus.getCanonicalEventLog({ childSessionId: "session-child-bus-1" });

      expect(fileEvents).toHaveLength(1);
      expect(fileEvents[0]).toEqual(expect.objectContaining({
        rootSessionId: "session-root-1",
        rootRunId: "run-root-1",
        providerId: "openai-api",
        modelId: "gpt-5.4",
        toolName: "apply_patch",
        approvalId: "approval-bus-1",
        filePath: "server/ui-server.mjs",
        patchHash: "patch-bus-1",
      }));
      expect(childEvents).toHaveLength(1);
      expect(childEvents[0]).toEqual(expect.objectContaining({
        childSessionId: "session-child-bus-1",
        childTaskId: "task-child-bus-1",
        subagentId: "subagent-bus-1",
      }));
    });

    it("deduplicates events within the dedup window", () => {
      bus.emit(AGENT_EVENT.AGENT_HEARTBEAT, "task-1", {});
      bus.emit(AGENT_EVENT.AGENT_HEARTBEAT, "task-1", {}); // duplicate
      const log = bus.getEventLog();
      expect(log).toHaveLength(1);
      expect(mockBroadcast).toHaveBeenCalledTimes(1);
    });

    it("allows same event type after dedup window expires", () => {
      bus.emit(AGENT_EVENT.AGENT_HEARTBEAT, "task-1", {});
      vi.advanceTimersByTime(600); // past 500ms dedup window
      bus.emit(AGENT_EVENT.AGENT_HEARTBEAT, "task-1", {});
      const log = bus.getEventLog();
      expect(log).toHaveLength(2);
    });

    it("enforces ring buffer max size", () => {
      for (let i = 0; i < 30; i++) {
        vi.advanceTimersByTime(600); // avoid dedup
        bus.emit(AGENT_EVENT.AGENT_HEARTBEAT, `task-${i}`, {});
      }
      const log = bus.getEventLog();
      expect(log.length).toBeLessThanOrEqual(20);
    });
  });

  // ── External Listeners ──────────────────────────────────────────────

  describe("addListener", () => {
    it("notifies external listeners", () => {
      const events = [];
      bus.addListener((e) => events.push(e));
      bus.emit(AGENT_EVENT.TASK_STARTED, "task-1", { title: "Hello" });
      expect(events).toHaveLength(1);
      expect(events[0].taskId).toBe("task-1");
    });

    it("allows unsubscribing", () => {
      const events = [];
      const unsub = bus.addListener((e) => events.push(e));
      bus.emit(AGENT_EVENT.TASK_STARTED, "task-1", {});
      unsub();
      vi.advanceTimersByTime(600);
      bus.emit(AGENT_EVENT.TASK_STARTED, "task-2", {});
      expect(events).toHaveLength(1);
    });

    it("handles listener errors gracefully", () => {
      bus.addListener(() => {
        throw new Error("listener boom");
      });
      // Should not throw
      expect(() =>
        bus.emit(AGENT_EVENT.TASK_STARTED, "task-1", {}),
      ).not.toThrow();
    });
  });

  // ── Hook Methods ────────────────────────────────────────────────────

  describe("onTaskStarted", () => {
    it("emits TASK_STARTED with task details", () => {
      bus.onTaskStarted(
        { id: "task-1", title: "Fix bug" },
        { sdk: "copilot-sdk", branch: "ve/test" },
      );
      const event = bus.getEventLog().find((e) => e.type === AGENT_EVENT.TASK_STARTED);
      expect(event).toBeTruthy();
      expect(event.payload.sdk).toBe("copilot-sdk");
    });
  });

  describe("onTaskCompleted", () => {
    it("emits TASK_COMPLETED", () => {
      bus.onTaskCompleted(
        { id: "task-1", title: "Fix bug" },
        { success: true, hasCommits: true, branch: "ve/test" },
      );
      const event = bus.getEventLog().find((e) => e.type === AGENT_EVENT.TASK_COMPLETED);
      expect(event).toBeTruthy();
      expect(event.payload.success).toBe(true);
    });

    it("triggers auto-review when review agent is available", () => {
      const mockReviewAgent = {
        queueReview: vi.fn(),
      };
      bus._reviewAgent = mockReviewAgent;

      bus.onTaskCompleted(
        { id: "task-1", title: "Fix bug" },
        { success: true, hasCommits: true, branch: "ve/test" },
      );

      expect(mockReviewAgent.queueReview).toHaveBeenCalledOnce();
      expect(mockReviewAgent.queueReview).toHaveBeenCalledWith(
        expect.objectContaining({ id: "task-1" }),
      );
    });

    it("does not trigger review on failure", () => {
      const mockReviewAgent = {
        queueReview: vi.fn(),
      };
      bus._reviewAgent = mockReviewAgent;

      bus.onTaskCompleted(
        { id: "task-1", title: "Fix bug" },
        { success: false },
      );

      expect(mockReviewAgent.queueReview).not.toHaveBeenCalled();
    });
  });

  describe("onTaskFailed", () => {
    it("emits TASK_FAILED with error message", () => {
      bus.onTaskFailed({ id: "task-1" }, new Error("build failed"));
      const log = bus.getEventLog();
      expect(log).toHaveLength(1);
      expect(log[0].type).toBe(AGENT_EVENT.TASK_FAILED);
      expect(log[0].payload.error).toBe("build failed");
    });

    it("classifies errors when errorDetector is available", () => {
      const mockDetector = {
        classify: vi.fn().mockReturnValue({
          pattern: "build_failure",
          confidence: 0.9,
          details: "compilation error",
        }),
        recordError: vi.fn().mockReturnValue({
          action: "retry_with_prompt",
          errorCount: 1,
          reason: "build failure",
        }),
      };
      bus._errorDetector = mockDetector;

      bus.onTaskFailed({ id: "task-1" }, "go build failed");
      expect(mockDetector.classify).toHaveBeenCalledWith("go build failed", "");
    });
  });

  describe("onAgentComplete", () => {
    it("emits AGENT_COMPLETE", () => {
      bus.onAgentComplete("task-1", {
        hasCommits: true,
        branch: "ve/test",
        prUrl: "https://github.com/test/pr/1",
      });
      const log = bus.getEventLog();
      expect(log).toHaveLength(1);
      expect(log[0].type).toBe(AGENT_EVENT.AGENT_COMPLETE);
      expect(log[0].payload.hasCommits).toBe(true);
    });

    it("sets task status to inreview when hasCommits", () => {
      const mockSetStatus = vi.fn();
      bus._setTaskStatus = mockSetStatus;

      bus.onAgentComplete("task-1", { hasCommits: true });
      expect(mockSetStatus).toHaveBeenCalledWith(
        "task-1",
        "inreview",
        "agent-event-bus",
      );
    });
  });

  describe("onAgentError", () => {
    it("emits AGENT_ERROR", () => {
      bus.onAgentError("task-1", { error: "rate limited", pattern: "rate_limit" });
      const log = bus.getEventLog();
      expect(log).toHaveLength(1);
      expect(log[0].type).toBe(AGENT_EVENT.AGENT_ERROR);
      expect(log[0].payload.error).toBe("rate limited");
    });
  });

  describe("onAgentHeartbeat", () => {
    it("emits AGENT_HEARTBEAT and updates heartbeats map", () => {
      bus.onAgentHeartbeat("task-1", { message: "alive" });
      const log = bus.getEventLog();
      expect(log).toHaveLength(1);
      expect(log[0].type).toBe(AGENT_EVENT.AGENT_HEARTBEAT);

      const liveness = bus.getAgentLiveness();
      expect(liveness).toHaveLength(1);
      expect(liveness[0].taskId).toBe("task-1");
      expect(liveness[0].alive).toBe(true);
    });
  });

  describe("onStatusChange", () => {
    it("emits TASK_STATUS_CHANGE", () => {
      bus.onStatusChange("task-1", "inprogress", "agent");
      const event = bus.getEventLog().find((e) => e.type === AGENT_EVENT.TASK_STATUS_CHANGE);
      expect(event).toBeTruthy();
      expect(event.payload.status).toBe("inprogress");
    });

    it("sends telegram on blocked status", () => {
      const mockTelegram = vi.fn();
      bus._sendTelegram = mockTelegram;
      bus._getTask = () => ({ title: "Test Task" });

      bus.onStatusChange("task-1", "blocked", "agent");
      expect(mockTelegram).toHaveBeenCalledWith(
        expect.stringContaining("Task blocked"),
      );
    });
  });

  describe("onExecutorPaused / onExecutorResumed", () => {
    it("emits EXECUTOR_PAUSED", () => {
      bus.onExecutorPaused("rate limit");
      const log = bus.getEventLog();
      expect(log).toHaveLength(1);
      expect(log[0].type).toBe(AGENT_EVENT.EXECUTOR_PAUSED);
    });

    it("emits EXECUTOR_RESUMED", () => {
      bus.onExecutorResumed();
      const log = bus.getEventLog();
      expect(log).toHaveLength(1);
      expect(log[0].type).toBe(AGENT_EVENT.EXECUTOR_RESUMED);
    });
  });

  describe("onHookResult", () => {
    it("emits HOOK_PASSED for passed hooks", () => {
      bus.onHookResult("task-1", "PrePush", true, { hookId: "lint", durationMs: 500 });
      const log = bus.getEventLog();
      expect(log).toHaveLength(1);
      expect(log[0].type).toBe(AGENT_EVENT.HOOK_PASSED);
      expect(log[0].payload.hookEvent).toBe("PrePush");
    });

    it("emits HOOK_FAILED for failed hooks", () => {
      bus.onHookResult("task-1", "PrePush", false, { hookId: "lint", output: "errors found" });
      const log = bus.getEventLog();
      expect(log).toHaveLength(1);
      expect(log[0].type).toBe(AGENT_EVENT.HOOK_FAILED);
    });
  });

  // ── Query API ───────────────────────────────────────────────────────

  describe("getEventLog", () => {
    it("returns all events with no filter", () => {
      bus.emit(AGENT_EVENT.TASK_STARTED, "t1", {});
      vi.advanceTimersByTime(600);
      bus.emit(AGENT_EVENT.TASK_COMPLETED, "t1", {});
      expect(bus.getEventLog()).toHaveLength(2);
    });

    it("filters by taskId", () => {
      bus.emit(AGENT_EVENT.TASK_STARTED, "t1", {});
      vi.advanceTimersByTime(600);
      bus.emit(AGENT_EVENT.TASK_STARTED, "t2", {});
      const log = bus.getEventLog({ taskId: "t1" });
      expect(log).toHaveLength(1);
      expect(log[0].taskId).toBe("t1");
    });

    it("filters by type", () => {
      bus.emit(AGENT_EVENT.TASK_STARTED, "t1", {});
      vi.advanceTimersByTime(600);
      bus.emit(AGENT_EVENT.TASK_COMPLETED, "t1", {});
      const log = bus.getEventLog({ type: AGENT_EVENT.TASK_COMPLETED });
      expect(log).toHaveLength(1);
      expect(log[0].type).toBe(AGENT_EVENT.TASK_COMPLETED);
    });

    it("limits results", () => {
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(600);
        bus.emit(AGENT_EVENT.AGENT_HEARTBEAT, `t-${i}`, {});
      }
      const log = bus.getEventLog({ limit: 3 });
      expect(log).toHaveLength(3);
    });
  });

  describe("getErrorHistory", () => {
    it("returns empty array for unknown task", () => {
      expect(bus.getErrorHistory("unknown")).toEqual([]);
    });

    it("records error history via classification", () => {
      const mockDetector = {
        classify: vi.fn().mockReturnValue({
          pattern: "build_failure",
          confidence: 0.9,
          details: "compilation error",
        }),
        recordError: vi.fn().mockReturnValue({
          action: "retry_with_prompt",
          errorCount: 1,
        }),
      };
      bus._errorDetector = mockDetector;

      bus.onTaskFailed({ id: "task-1" }, "go build failed");
      const history = bus.getErrorHistory("task-1");
      expect(history).toHaveLength(1);
      expect(history[0].pattern).toBe("build_failure");
      expect(history[0].action).toBe("retry_with_prompt");
    });
  });

  describe("getErrorPatternSummary", () => {
    it("returns empty when no errors", () => {
      expect(bus.getErrorPatternSummary()).toEqual({});
    });
  });

  describe("getAgentLiveness", () => {
    it("returns empty when no heartbeats", () => {
      expect(bus.getAgentLiveness()).toEqual([]);
    });

    it("reports alive agents", () => {
      bus.onAgentHeartbeat("task-1", {});
      const liveness = bus.getAgentLiveness();
      expect(liveness).toHaveLength(1);
      expect(liveness[0].alive).toBe(true);
    });

    it("reports stale agents after threshold", () => {
      bus.onAgentHeartbeat("task-1", {});
      vi.advanceTimersByTime(6000); // past 5000ms stale threshold
      const liveness = bus.getAgentLiveness();
      expect(liveness).toHaveLength(1);
      expect(liveness[0].alive).toBe(false);
      expect(liveness[0].staleSinceMs).toBeGreaterThanOrEqual(6000);
    });
  });

  describe("getStatus", () => {
    it("returns full system status", () => {
      bus.start();
      bus.onAgentHeartbeat("task-1", {});
      const status = bus.getStatus();
      expect(status.started).toBe(true);
      expect(status.eventLogSize).toBe(1);
      expect(status.trackedAgents).toBe(1);
      expect(status.listenerCount).toBe(0);
    });
  });

  // ── Stale Agent Detection ───────────────────────────────────────────

  describe("stale agent detection", () => {
    it("emits AGENT_STALE when heartbeat is overdue", () => {
      bus.start();
      bus.onAgentHeartbeat("task-1", {});

      // Advance past stale threshold + check interval
      vi.advanceTimersByTime(6000); // triggers stale check
      vi.advanceTimersByTime(2000); // next check

      // The stale check should have emitted AGENT_STALE
      const staleEvents = bus
        .getEventLog()
        .filter((e) => e.type === AGENT_EVENT.AGENT_STALE);
      expect(staleEvents.length).toBeGreaterThanOrEqual(1);
      expect(staleEvents[0].taskId).toBe("task-1");
    });

    it("does not emit retry queue updates when expire check makes no changes", () => {
      const setRetryQueueData = vi.fn();
      bus.stop();
      bus = createAgentEventBus({
        broadcastUiEvent: mockBroadcast,
        staleThresholdMs: 5000,
        staleCheckIntervalMs: 2000,
        setRetryQueueData,
      });

      bus._checkStaleAgents();

      const queueEvents = bus
        .getEventLog()
        .filter((e) => e.type === AGENT_EVENT.RETRY_QUEUE_UPDATED);
      expect(setRetryQueueData).not.toHaveBeenCalled();
      expect(queueEvents).toHaveLength(0);
    });

    it("emits retry queue updates when expire check removes queued tasks", () => {
      const setRetryQueueData = vi.fn();
      bus.stop();
      bus = createAgentEventBus({
        broadcastUiEvent: mockBroadcast,
        staleThresholdMs: 5000,
        staleCheckIntervalMs: 2000,
        setRetryQueueData,
      });

      bus._updateRetryQueue(
        {
          type: "add",
          item: {
            taskId: "task-1",
            retryCount: 1,
            nextAttemptAt: 0,
            expiresAt: 0,
          },
        },
        { reason: "seed", taskId: "task-1" },
      );
      setRetryQueueData.mockClear();

      bus._checkStaleAgents();

      const queueEvents = bus
        .getEventLog()
        .filter((e) => e.type === AGENT_EVENT.RETRY_QUEUE_UPDATED);
      expect(setRetryQueueData).toHaveBeenCalledTimes(1);
      expect(bus.getRetryQueue().count).toBe(0);
      expect(queueEvents.at(-1)?.payload?.reason).toBe("expire");
    });
  });

  // ── Auto-Actions ────────────────────────────────────────────────────

  describe("auto-actions", () => {
    let mockDetector;

    beforeEach(() => {
      mockDetector = {
        classify: vi.fn(),
        recordError: vi.fn(),
      };
      bus._errorDetector = mockDetector;
    });

    it("emits AUTO_RETRY when action is retry_with_prompt", () => {
      mockDetector.classify.mockReturnValue({
        pattern: "build_failure",
        confidence: 0.9,
      });
      mockDetector.recordError.mockReturnValue({
        action: "retry_with_prompt",
        errorCount: 1,
        reason: "build error",
      });

      // First start the task to initialize auto-action state
      bus.onTaskStarted({ id: "task-1", title: "Retry queue title test" }, {});
      vi.advanceTimersByTime(600);
      bus.onTaskFailed({ id: "task-1" }, "build error");

      const retryEvents = bus
        .getEventLog()
        .filter((e) => e.type === AGENT_EVENT.AUTO_RETRY);
      expect(retryEvents.length).toBe(1);
      expect(retryEvents[0].payload.retryCount).toBe(1);
      const queue = bus.getRetryQueue();
      expect(queue.count).toBe(1);
      expect(queue.items[0].taskId).toBe("task-1");
      expect(queue.items[0].taskTitle).toBe("Retry queue title test");
    });

    it("invokes threshold hook instead of retry when threshold is reached", () => {
      const thresholdHook = vi.fn();
      bus.stop();
      bus = createAgentEventBus({
        broadcastUiEvent: mockBroadcast,
        maxAutoRetries: 5,
        retryReviewThreshold: 2,
        onRetryThresholdExceeded: thresholdHook,
      });
      mockDetector.classify.mockReturnValue({
        pattern: "build_failure",
        confidence: 0.9,
      });
      mockDetector.recordError.mockReturnValue({
        action: "retry_with_prompt",
        errorCount: 1,
        reason: "build error",
      });
      bus._errorDetector = mockDetector;

      bus.onTaskStarted({ id: "task-1" }, {});
      vi.advanceTimersByTime(600);
      bus.onTaskFailed({ id: "task-1" }, "build error #1");
      vi.advanceTimersByTime(600);
      bus.onTaskFailed({ id: "task-1" }, "build error #2");
      vi.advanceTimersByTime(600);
      bus.onTaskFailed({ id: "task-1" }, "build error #3");

      expect(thresholdHook).toHaveBeenCalledOnce();
      const reviewEvents = bus
        .getEventLog()
        .filter((e) => e.type === AGENT_EVENT.AUTO_REVIEW);
      expect(reviewEvents.length).toBeGreaterThanOrEqual(1);
      const queue = bus.getRetryQueue();
      expect(queue.stats.exhaustedTaskIds).toContain("task-1");
    });

    it("emits AUTO_COOLDOWN when action is cooldown", () => {
      mockDetector.classify.mockReturnValue({
        pattern: "rate_limit",
        confidence: 0.95,
      });
      mockDetector.recordError.mockReturnValue({
        action: "cooldown",
        cooldownMs: 60000,
        reason: "rate limited",
      });

      bus.onTaskStarted({ id: "task-1" }, {});
      vi.advanceTimersByTime(600);
      bus.onTaskFailed({ id: "task-1" }, "rate limited");

      const cooldownEvents = bus
        .getEventLog()
        .filter((e) => e.type === AGENT_EVENT.AUTO_COOLDOWN);
      expect(cooldownEvents.length).toBe(1);
      expect(cooldownEvents[0].payload.cooldownMs).toBe(60000);
    });

    it("escalates to block after max retries exhausted", () => {
      mockDetector.classify.mockReturnValue({
        pattern: "build_failure",
        confidence: 0.9,
      });
      mockDetector.recordError.mockReturnValue({
        action: "retry_with_prompt",
        errorCount: 1,
      });

      bus.onTaskStarted({ id: "task-1" }, {});

      // Exhaust all retries (maxAutoRetries = 3)
      for (let i = 0; i < 4; i++) {
        vi.advanceTimersByTime(600);
        bus.onTaskFailed({ id: "task-1" }, `build error ${i}`);
      }

      const blockEvents = bus
        .getEventLog()
        .filter((e) => e.type === AGENT_EVENT.AUTO_BLOCK);
      expect(blockEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("sends telegram on auto-block", () => {
      const mockTelegram = vi.fn();
      bus._sendTelegram = mockTelegram;

      mockDetector.classify.mockReturnValue({
        pattern: "build_failure",
        confidence: 0.9,
      });
      mockDetector.recordError.mockReturnValue({
        action: "block",
        reason: "too many errors",
        errorCount: 5,
      });

      bus.onTaskStarted({ id: "task-1" }, {});
      vi.advanceTimersByTime(600);
      bus.onTaskFailed({ id: "task-1" }, "build error");

      expect(mockTelegram).toHaveBeenCalledWith(
        expect.stringContaining("Auto-blocked"),
      );
    });

    it("clears cooldown on manual retry queue clear", () => {
      mockDetector.classify.mockReturnValue({
        pattern: "rate_limit",
        confidence: 0.95,
      });
      mockDetector.recordError.mockReturnValue({
        action: "cooldown",
        cooldownMs: 60_000,
        reason: "rate limited",
      });

      bus.onTaskStarted({ id: "task-1" }, {});
      vi.advanceTimersByTime(600);
      bus.onTaskFailed({ id: "task-1" }, "rate limited");

      mockDetector.classify.mockReturnValue({
        pattern: "build_failure",
        confidence: 0.9,
      });
      mockDetector.recordError.mockReturnValue({
        action: "retry_with_prompt",
        errorCount: 1,
        reason: "build error",
      });

      bus.clearRetryQueueTask("task-1", "manual-retry-now");
      vi.advanceTimersByTime(600);
      bus.onTaskFailed({ id: "task-1" }, "build failed after manual retry");

      const retryEvents = bus
        .getEventLog()
        .filter((e) => e.type === AGENT_EVENT.AUTO_RETRY);
      expect(retryEvents.length).toBe(1);
    });
  });

  // ── Pattern Trend Detection ─────────────────────────────────────────

  describe("pattern trend detection", () => {
    it("detects repeated error patterns", () => {
      const mockDetector = {
        classify: vi.fn().mockReturnValue({
          pattern: "build_failure",
          confidence: 0.9,
        }),
        recordError: vi.fn().mockReturnValue({
          action: "manual",
          errorCount: 1,
        }),
      };
      bus._errorDetector = mockDetector;
      bus.onTaskStarted({ id: "task-1" }, {});

      // Trigger same error 4 times
      for (let i = 0; i < 4; i++) {
        vi.advanceTimersByTime(600);
        bus.onTaskFailed({ id: "task-1" }, `build error ${i}`);
      }

      const patternEvents = bus
        .getEventLog()
        .filter((e) => e.type === AGENT_EVENT.ERROR_PATTERN_DETECTED);
      expect(patternEvents.length).toBeGreaterThanOrEqual(1);
      expect(patternEvents[0].payload.pattern).toBe("build_failure");
    });
  });
});
