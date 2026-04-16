import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: process.platform === "win32" ? 45_000 : 15_000 });
const SLOW_SESSION_MANAGER_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 15_000;

import { createSessionReplayStore } from "../agent/session-replay.mjs";
import { createSessionSnapshotStore } from "../agent/session-snapshot-store.mjs";
import { createHarnessSessionManager } from "../agent/session-manager.mjs";
import {
  createHarnessObservabilitySpine,
  flushHarnessTelemetryRuntimeForTests,
  resetHarnessObservabilitySpinesForTests,
} from "../infra/session-telemetry.mjs";
import {
  beginWorkflowLinkedSessionExecution,
  finalizeWorkflowLinkedSessionExecution,
} from "../workflow/harness-session-node.mjs";
import { WorkflowExecutionLedger } from "../workflow/execution-ledger.mjs";

describe("session manager cutover", () => {
  it("keeps interactive, workflow, and subagent sessions on one canonical lineage graph", () => {
    const sessionManager = createHarnessSessionManager();

    sessionManager.beginExternalSession({
      sessionId: "chat-session-root",
      threadId: "chat-thread-root",
      scope: "primary",
      sessionType: "primary",
      taskKey: "TASK-CUTOVER",
      cwd: process.cwd(),
      metadata: {
        surface: "chat",
      },
      source: "chat",
    });
    sessionManager.registerExecution("chat-session-root", {
      sessionType: "primary",
      taskKey: "TASK-CUTOVER",
      threadId: "chat-thread-root",
      cwd: process.cwd(),
      status: "running",
      scope: "primary",
      metadata: {
        surface: "chat",
      },
    });

    const workflowContext = {
      id: "workflow-run-1",
      data: {
        _workflowId: "wf-cutover",
        _workflowName: "Harness Cutover",
        _workflowSessionId: "chat-session-root",
        _workflowRootSessionId: "chat-session-root",
        _workflowParentSessionId: "chat-session-root",
        _workflowRootRunId: "workflow-run-1",
        _workflowDelegationDepth: 0,
        taskId: "TASK-CUTOVER",
        taskTitle: "Cutover proof",
      },
    };
    const workflowNode = {
      id: "workflow-agent",
      label: "Workflow Agent",
    };

    const workflowLink = beginWorkflowLinkedSessionExecution(
      workflowContext,
      workflowNode,
      { services: { sessionManager } },
      {
        sessionId: "workflow-session-1",
        threadId: "workflow-thread-1",
        parentSessionId: "chat-session-root",
        rootSessionId: "chat-session-root",
        taskId: "TASK-CUTOVER",
        taskTitle: "Cutover proof",
        taskKey: "TASK-CUTOVER:workflow",
        cwd: process.cwd(),
        metadata: {
          surface: "workflow",
        },
      },
    );

    const child = sessionManager.createChildSession("workflow-session-1", {
      sessionId: "subagent-session-1",
      threadId: "subagent-thread-1",
      sessionType: "subagent",
      taskKey: "TASK-CUTOVER:subagent",
      metadata: {
        surface: "subagent",
      },
    });

    const finalized = finalizeWorkflowLinkedSessionExecution(workflowLink, {
      success: true,
      status: "completed",
      threadId: "workflow-thread-1",
      result: {
        ok: true,
        source: "workflow",
      },
    });
    sessionManager.finalizeExternalExecution("chat-session-root", {
      success: true,
      status: "completed",
      threadId: "chat-thread-root",
      result: {
        ok: true,
        source: "chat",
      },
    });

    const workflowSession = sessionManager.getSession("workflow-session-1");
    const subagentView = sessionManager.getLineageView("subagent-session-1");
    const workflowView = sessionManager.getLineageView("workflow-session-1");
    const replay = sessionManager.getReplaySnapshot("workflow-session-1");

    expect(child).toMatchObject({
      sessionId: "subagent-session-1",
      parentSessionId: "workflow-session-1",
      rootSessionId: "chat-session-root",
      lineageDepth: 2,
    });
    expect(workflowSession).toMatchObject({
      sessionId: "workflow-session-1",
      parentSessionId: "chat-session-root",
      rootSessionId: "chat-session-root",
      status: "completed",
      metadata: expect.objectContaining({
        surface: "workflow",
      }),
    });
    expect(workflowView).toEqual(
      expect.objectContaining({
        session: expect.objectContaining({
          sessionId: "workflow-session-1",
        }),
        parent: expect.objectContaining({
          sessionId: "chat-session-root",
        }),
        descendants: expect.arrayContaining([
          expect.objectContaining({
            sessionId: "subagent-session-1",
          }),
        ]),
      }),
    );
    expect(subagentView.parent).toEqual(
      expect.objectContaining({
        sessionId: "workflow-session-1",
      }),
    );
    expect(replay.lineage).toEqual(
      expect.objectContaining({
        parentSessionId: "chat-session-root",
        childSessionIds: expect.arrayContaining(["subagent-session-1"]),
      }),
    );
    expect(finalized).toEqual(
      expect.objectContaining({
        sessionId: "workflow-session-1",
        status: "completed",
        lineage: expect.objectContaining({
          workflowId: "wf-cutover",
          parentSessionId: "chat-session-root",
          rootSessionId: "chat-session-root",
          childSessionId: "workflow-session-1",
        }),
      }),
    );
  }, SLOW_SESSION_MANAGER_TEST_TIMEOUT_MS);

  it("keeps a durable overseer shell while swapping external workers across executions", () => {
    const sessionManager = createHarnessSessionManager();

    sessionManager.beginExternalSession({
      sessionId: "workflow-overseer-shell",
      scope: "workflow-task",
      sessionType: "workflow-overseer",
      taskKey: "TASK-OVERSEER",
      cwd: process.cwd(),
      metadata: {
        source: "workflow-engine-run",
      },
      source: "workflow-engine-run",
    });

    sessionManager.registerExecution("workflow-overseer-shell", {
      sessionType: "workflow-overseer",
      taskKey: "TASK-OVERSEER",
      threadId: "workflow-run-1",
      cwd: process.cwd(),
      status: "running",
      providerSelection: "codex",
      adapterName: "codex",
      metadata: {
        source: "workflow-engine-run",
      },
      scope: "workflow-task",
    });
    sessionManager.finalizeExternalExecution("workflow-overseer-shell", {
      success: true,
      status: "completed",
      threadId: "workflow-run-1",
      result: {
        runId: "workflow-run-1",
      },
    });

    sessionManager.registerExecution("workflow-overseer-shell", {
      sessionType: "workflow-overseer",
      taskKey: "TASK-OVERSEER",
      threadId: "workflow-run-2",
      cwd: process.cwd(),
      status: "running",
      providerSelection: "claude",
      adapterName: "claude",
      metadata: {
        source: "workflow-engine-run",
      },
      scope: "workflow-task",
    });

    const running = sessionManager.getSession("workflow-overseer-shell");
    expect(running).toMatchObject({
      sessionId: "workflow-overseer-shell",
      sessionType: "workflow-overseer",
      activeWorkerId: "workflow-overseer-shell:worker:2",
      executionCount: 2,
      workerGeneration: 2,
      workerSwapCount: 1,
      activeWorker: expect.objectContaining({
        threadId: "workflow-run-2",
        providerSelection: "claude",
        adapterName: "claude",
        status: "running",
      }),
    });
    expect(running.workerHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        threadId: "workflow-run-1",
        providerSelection: "codex",
        status: "completed",
      }),
      expect.objectContaining({
        threadId: "workflow-run-2",
        providerSelection: "claude",
        status: "running",
      }),
    ]));

    sessionManager.finalizeExternalExecution("workflow-overseer-shell", {
      success: true,
      status: "completed",
      threadId: "workflow-run-2",
      result: {
        runId: "workflow-run-2",
      },
    });

    const finalized = sessionManager.getSession("workflow-overseer-shell");
    const replay = sessionManager.getReplaySnapshot("workflow-overseer-shell");
    expect(finalized).toMatchObject({
      sessionId: "workflow-overseer-shell",
      status: "completed",
      activeThreadId: "workflow-run-2",
      activeWorkerId: null,
      activeWorker: null,
      executionCount: 2,
      workerGeneration: 2,
      workerSwapCount: 1,
    });
    expect(finalized.workerHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        threadId: "workflow-run-1",
        status: "completed",
      }),
      expect.objectContaining({
        threadId: "workflow-run-2",
        status: "completed",
      }),
    ]));
    expect(replay.workerHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        threadId: "workflow-run-1",
      }),
      expect.objectContaining({
        threadId: "workflow-run-2",
      }),
    ]));
  }, SLOW_SESSION_MANAGER_TEST_TIMEOUT_MS);

  it("derives explicit operator phases that stay meaningful across planning, staging, running, building, and editing", () => {
    const sessionManager = createHarnessSessionManager();

    const planning = sessionManager.beginExternalSession({
      sessionId: "phase-planning",
      sessionType: "primary",
      metadata: {
        phase: "planning",
        surface: "chat",
      },
    });
    const staging = sessionManager.ensureSession({
      sessionId: "phase-staging",
      sessionType: "task",
      status: "waiting_approval",
      metadata: {
        source: "workflow-engine-run",
      },
    });
    const building = sessionManager.ensureSession({
      sessionId: "phase-building",
      sessionType: "workflow-overseer",
      status: "idle",
      metadata: {
        source: "workflow-engine-run",
      },
    });
    const editing = sessionManager.ensureSession({
      sessionId: "phase-editing",
      sessionType: "primary",
      status: "running",
      metadata: {
        hasEdits: true,
      },
    });
    sessionManager.beginExternalSession({
      sessionId: "phase-running",
      sessionType: "workflow-overseer",
      scope: "workflow-task",
      metadata: {
        source: "workflow-engine-run",
      },
    });
    const running = sessionManager.registerExecution("phase-running", {
      sessionType: "workflow-overseer",
      scope: "workflow-task",
      status: "running",
      threadId: "phase-running-thread",
      metadata: {
        source: "workflow-engine-run",
      },
    });

    expect(planning.operatorPhase).toEqual(expect.objectContaining({
      id: "planning",
      label: "Planning",
      source: "explicit",
    }));
    expect(staging.operatorPhase).toEqual(expect.objectContaining({
      id: "staging",
      label: "Staging",
      source: "derived",
    }));
    expect(building.operatorPhase).toEqual(expect.objectContaining({
      id: "building",
      label: "Building",
      source: "derived",
    }));
    expect(editing.operatorPhase).toEqual(expect.objectContaining({
      id: "editing",
      label: "Editing",
      source: "derived",
    }));
    expect(running.operatorPhase).toEqual(expect.objectContaining({
      id: "running",
      label: "Running",
      source: "derived",
    }));
  }, 15000);

  it("writes through resumable checkpoints at each session boundary", async () => {
    const trackerMod = await import("../infra/session-tracker.mjs");
    trackerMod._resetSingleton();
    const tracker = trackerMod.getSessionTracker();
    const sessionManager = createHarnessSessionManager({ sessionTracker: tracker });

    sessionManager.beginExternalSession({
      sessionId: "checkpoint-session-1",
      threadId: "checkpoint-thread-1",
      scope: "workflow-task",
      sessionType: "task",
      taskKey: "TASK-CHECKPOINT",
      cwd: process.cwd(),
    });
    tracker.recordEvent("checkpoint-session-1", {
      role: "user",
      content: "resume from the last durable boundary",
      timestamp: "2026-04-05T09:00:00.000Z",
    });
    tracker.recordEvent("checkpoint-session-1", {
      type: "item.completed",
      timestamp: "2026-04-05T09:00:01.000Z",
      item: {
        id: "tool-result-1",
        type: "function_call_output",
        output: "saved tool output",
        _compressed: "tool_cache",
        _originalLength: 2048,
      },
    });

    sessionManager.registerExecution("checkpoint-session-1", {
      sessionType: "task",
      taskKey: "TASK-CHECKPOINT",
      threadId: "checkpoint-thread-1",
      providerSelection: "codex",
      adapterName: "codex",
      status: "running",
      scope: "workflow-task",
    });
    sessionManager.finalizeExternalExecution("checkpoint-session-1", {
      success: true,
      status: "completed",
      threadId: "checkpoint-thread-1",
      result: {
        output: "done",
      },
    });

    const session = sessionManager.getSession("checkpoint-session-1");
    const replayState = sessionManager.getReplayState("checkpoint-session-1");

    expect(session).toEqual(expect.objectContaining({
      replayCursor: expect.any(String),
      checkpointCursor: expect.any(String),
      messageCursor: 2,
      turnCursor: 1,
      spillCount: 1,
    }));
    expect(replayState.latestCheckpoint).toEqual(expect.objectContaining({
      checkpointId: session.checkpointCursor,
      replayCursor: session.replayCursor,
      threadId: "checkpoint-thread-1",
      status: "completed",
      boundaryType: "turn_boundary",
      messageCursor: 2,
      spillCount: 1,
      toolResultCount: 1,
    }));
    expect(replayState.resumeFrom).toEqual(expect.objectContaining({
      checkpointId: session.checkpointCursor,
      replayCursor: session.replayCursor,
      threadId: "checkpoint-thread-1",
      status: "completed",
      boundaryType: "turn_boundary",
      messageCursor: 2,
      spillCount: 1,
    }));
  }, SLOW_SESSION_MANAGER_TEST_TIMEOUT_MS);

  it("cold-restores persisted replay history and live execution status after restart", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "bosun-session-replay-restore-"));
    const configDir = join(repoRoot, ".bosun");
    const runsDir = join(configDir, "workflow-runs");
    const snapshotStore = createSessionSnapshotStore({
      filePath: join(configDir, ".cache", "session-snapshots.json"),
    });

    try {
      resetHarnessObservabilitySpinesForTests();
      const store = createSessionReplayStore({
        configDir,
        runsDir,
        snapshotStore,
      });
      const spine = createHarnessObservabilitySpine({
        persist: true,
        configDir,
        maxPersistBatchEvents: 2,
      });
      const ledger = new WorkflowExecutionLedger({ runsDir });

      store.recordEvent("cold-session-1", {
        type: "turn.persisted",
        timestamp: "2026-04-05T08:00:00.000Z",
        message: "persisted replay event",
      });
      store.captureSnapshot({
        sessionId: "cold-session-1",
        runId: "cold-run-1",
        threadId: "cold-thread-1",
        action: "session_continue_requested",
        eventType: "provider.turn.completed",
        status: "running",
        summary: "write-through checkpoint",
        checkpoint: {
          boundaryType: "turn_boundary",
          messageCursor: 5,
          turnCursor: 2,
          spillCount: 1,
          toolCallCount: 2,
          toolResultCount: 1,
          providerTurnId: "provider-turn-cold-1",
          updatedAt: "2026-04-05T08:00:00.500Z",
        },
      });
      spine.recordEvent({
        timestamp: "2026-04-05T08:00:01.000Z",
        eventType: "provider.turn.completed",
        source: "agent-event-bus",
        taskId: "task-cold-restore-1",
        sessionId: "cold-session-1",
        threadId: "cold-thread-1",
        runId: "cold-run-1",
        providerId: "openai-api",
        modelId: "gpt-5.4",
        status: "running",
      });
      ledger.ensureRun({
        runId: "cold-run-1",
        workflowId: "wf-cold-restore",
        workflowName: "Cold Restore",
        sessionId: "cold-session-1",
        threadId: "cold-thread-1",
        status: "running",
      });
      ledger.appendEvent({
        runId: "cold-run-1",
        workflowId: "wf-cold-restore",
        workflowName: "Cold Restore",
        sessionId: "cold-session-1",
        threadId: "cold-thread-1",
        eventType: "run.start",
        status: "running",
        timestamp: "2026-04-05T08:00:02.000Z",
        checkpoint: {
          boundaryType: "node_boundary",
          messageCursor: 6,
          turnCursor: 2,
          spillCount: 2,
          toolCallCount: 2,
          toolResultCount: 2,
          nodeId: "agent-node-1",
          nodeType: "agent",
          stageId: "agent-stage",
          providerTurnId: "provider-turn-cold-1",
          updatedAt: "2026-04-05T08:00:02.000Z",
        },
      });

      await flushHarnessTelemetryRuntimeForTests();
      resetHarnessObservabilitySpinesForTests();

      const restoredStore = createSessionReplayStore({
        configDir,
        runsDir,
        snapshotStore: createSessionSnapshotStore({
          filePath: join(configDir, ".cache", "session-snapshots.json"),
        }),
      });

      const replayState = restoredStore.buildResumeState("cold-session-1");

      expect(replayState.events).toEqual([
        expect.objectContaining({
          sessionId: "cold-session-1",
          type: "turn.persisted",
        }),
      ]);
      expect(replayState.coldRestore).toEqual(expect.objectContaining({
        restored: true,
        sources: expect.arrayContaining(["checkpoint", "telemetry", "execution-ledger"]),
        latestCheckpoint: expect.objectContaining({
          threadId: "cold-thread-1",
          runId: "cold-run-1",
          boundaryType: "turn_boundary",
          messageCursor: 5,
          turnCursor: 2,
          spillCount: 1,
        }),
        liveStatus: expect.objectContaining({
          sessionId: "cold-session-1",
          threadId: "cold-thread-1",
          runId: "cold-run-1",
          status: "running",
        }),
      }));
      expect(replayState.latestCheckpoint).toEqual(expect.objectContaining({
        threadId: "cold-thread-1",
        runId: "cold-run-1",
        boundaryType: "turn_boundary",
        messageCursor: 5,
        spillCount: 1,
      }));
      expect(replayState.resumeFrom).toEqual(expect.objectContaining({
        checkpointId: expect.any(String),
        replayCursor: expect.any(String),
        threadId: "cold-thread-1",
        runId: "cold-run-1",
        status: "running",
        boundaryType: "turn_boundary",
        messageCursor: 5,
        spillCount: 1,
      }));
      expect(replayState.resumeFrom?.action).toBe("session_continue_requested");
      expect(replayState.coldRestore.executionLedger).toEqual(expect.objectContaining({
        runCount: 1,
        status: "running",
        latestRun: expect.objectContaining({
          runId: "cold-run-1",
          threadId: "cold-thread-1",
        }),
        latestCheckpoint: expect.objectContaining({
          boundaryType: "node_boundary",
          nodeId: "agent-node-1",
          stageId: "agent-stage",
          messageCursor: 6,
          spillCount: 2,
        }),
      }));
      expect(replayState.coldRestore.telemetry).toEqual(expect.objectContaining({
        eventCount: 1,
        sessionCount: 1,
        runCount: 1,
      }));
    } finally {
      resetHarnessObservabilitySpinesForTests();
      try {
        rmSync(repoRoot, { recursive: true, force: true });
      } catch {
      }
    }
  });
});
