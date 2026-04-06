import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
  });

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
  });

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
        sources: expect.arrayContaining(["telemetry", "execution-ledger"]),
        liveStatus: expect.objectContaining({
          sessionId: "cold-session-1",
          threadId: "cold-thread-1",
          runId: "cold-run-1",
          status: "running",
        }),
      }));
      expect(replayState.resumeFrom).toEqual(expect.objectContaining({
        threadId: "cold-thread-1",
        runId: "cold-run-1",
        status: "running",
      }));
      expect(String(replayState.resumeFrom?.action || "")).toContain("cold_restore");
      expect(replayState.coldRestore.executionLedger).toEqual(expect.objectContaining({
        runCount: 1,
        status: "running",
        latestRun: expect.objectContaining({
          runId: "cold-run-1",
          threadId: "cold-thread-1",
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
