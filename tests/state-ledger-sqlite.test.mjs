import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendKnowledgeEntryToStateLedger,
  appendPromotedStrategyToStateLedger,
  appendTaskTraceEventToStateLedger,
  appendArtifactRecordToStateLedger,
  appendOperatorActionToStateLedger,
  deleteSessionRecordFromStateLedger,
  getAgentActivityFromStateLedger,
  getActiveTaskClaimFromStateLedger,
  getRunAuditBundleFromStateLedger,
  getTaskAuditBundleFromStateLedger,
  getPromotedStrategyFromStateLedger,
  getSessionActivityFromStateLedger,
  getStateLedgerKeyValue,
  getStateLedgerInfo,
  getTaskSnapshotFromStateLedger,
  getTaskTopologyFromStateLedger,
  getHarnessRunFromStateLedger,
  getWorkflowRunDetailFromStateLedger,
  getWorkflowRunFromStateLedger,
  listHarnessRunEventsFromStateLedger,
  listHarnessRunsFromStateLedger,
  listAuditEventsFromStateLedger,
  listArtifactsFromStateLedger,
  listKnowledgeEntriesFromStateLedger,
  listSessionActivitiesFromStateLedger,
  listOperatorActionsFromStateLedger,
  listPromotedStrategiesFromStateLedger,
  listPromotedStrategyEventsFromStateLedger,
  listTaskAuditSummariesFromStateLedger,
  listTaskTraceEventsFromStateLedger,
  listTaskClaimEventsFromStateLedger,
  listTaskTopologiesFromStateLedger,
  listToolCallsFromStateLedger,
  listWorkflowRunSummariesPageFromStateLedger,
  listWorkflowEventsFromStateLedger,
  listWorkflowTaskRunEntriesFromStateLedger,
  resetStateLedgerCache,
  resolveStateLedgerPath,
  upsertSessionRecordToStateLedger,
  upsertStateLedgerKeyValue,
  writeHarnessRunToStateLedger,
  writeWorkflowRunDetailToStateLedger,
} from "../lib/state-ledger-sqlite.mjs";
import {
  listHarnessTelemetryEvents,
  resetHarnessObservabilitySpinesForTests,
} from "../infra/session-telemetry.mjs";
import { createReplayReader } from "../infra/replay-reader.mjs";

vi.mock("../infra/presence.mjs", () => ({
  getPresenceState: vi.fn(() => ({
    instance_id: "test-instance-1",
    coordinator_priority: 100,
  })),
  buildLocalPresence: vi.fn(() => ({
    instance_id: "test-instance-1",
    coordinator_priority: 100,
  })),
  notePresence: vi.fn(async () => ({})),
  listActiveInstances: vi.fn(() => []),
  selectCoordinator: vi.fn(() => ({ instance_id: "test-instance-1" })),
  initPresence: vi.fn(async () => ({})),
}));

vi.mock("../workspace/shared-state-manager.mjs", () => ({
  claimTaskInSharedState: vi.fn(async () => ({ success: true })),
  forceClaimTaskInSharedState: vi.fn(async () => ({ success: true })),
  renewSharedStateHeartbeat: vi.fn(async () => ({ success: true })),
  releaseSharedState: vi.fn(async () => ({ success: true })),
}));

const tempDirs = [];

function makeTempDir(prefix = "state-ledger-test-") {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadTaskStoreModule() {
  await vi.resetModules();
  return import("../task/task-store.mjs");
}

async function loadTaskClaimsModule() {
  await vi.resetModules();
  return import("../task/task-claims.mjs");
}

afterEach(async () => {
  resetStateLedgerCache();
  resetHarnessObservabilitySpinesForTests();
  await vi.resetModules();
  while (tempDirs.length) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("state ledger sqlite workflow integration", () => {
  it("keeps standalone anchor paths isolated from the shared Bosun home ledger", () => {
    const standaloneRoot = makeTempDir("state-ledger-standalone-");
    const runsDir = join(standaloneRoot, "runs");
    mkdirSync(runsDir, { recursive: true });

    const resolvedPath = resolveStateLedgerPath({ anchorPath: runsDir });
    expect(resolvedPath).toBe(resolve(standaloneRoot, "state-ledger.sqlite"));
    expect(resolvedPath.includes(`${join("bosun", ".cache", "state-ledger.sqlite")}`)).toBe(false);
  });

  it("mirrors workflow execution ledgers into sqlite and falls back to sqlite reads", async () => {
    const repoRoot = makeTempDir("state-ledger-workflow-");
    const runsDir = join(repoRoot, ".bosun", "workflow-runs");
    mkdirSync(runsDir, { recursive: true });

    const { WorkflowExecutionLedger } = await import("../workflow/execution-ledger.mjs");
    const ledger = new WorkflowExecutionLedger({ runsDir });

    ledger.ensureRun({
      runId: "run-1",
      workflowId: "wf-1",
      workflowName: "Ledger Test Workflow",
      startedAt: "2026-03-31T01:00:00.000Z",
      status: "running",
    });
    ledger.appendEvent({
      runId: "run-1",
      workflowId: "wf-1",
      workflowName: "Ledger Test Workflow",
      eventType: "run.start",
      timestamp: "2026-03-31T01:00:00.000Z",
      status: "running",
      meta: {
        taskId: "task-1",
        taskTitle: "Ledger task",
        sessionId: "session-1",
        sessionType: "workflow",
      },
    });
    ledger.appendEvent({
      runId: "run-1",
      workflowId: "wf-1",
      workflowName: "Ledger Test Workflow",
      eventType: "run.end",
      timestamp: "2026-03-31T01:05:00.000Z",
      status: "completed",
      summary: "finished",
    });

    const dbPath = resolveStateLedgerPath({ anchorPath: runsDir });
    expect(existsSync(dbPath)).toBe(true);

    const info = getStateLedgerInfo({ anchorPath: runsDir });
    expect(info.schemaVersion).toBe(9);
    expect(info.tables).toEqual(
      expect.arrayContaining([
        "agent_activity",
        "artifacts",
        "key_values",
        "knowledge_entries",
        "operator_actions",
        "promoted_strategies",
        "promoted_strategy_events",
        "schema_meta",
        "session_activity",
        "task_claim_events",
        "task_claim_snapshots",
        "task_snapshots",
        "task_trace_events",
        "task_topology",
        "tool_calls",
        "workflow_events",
        "workflow_runs",
        "workflow_snapshots",
      ]),
    );

    const sqlRun = getWorkflowRunFromStateLedger("run-1", { anchorPath: runsDir });
    expect(sqlRun).toEqual(
      expect.objectContaining({
        runId: "run-1",
        workflowId: "wf-1",
        status: "completed",
      }),
    );
    expect(sqlRun.events).toHaveLength(2);

    const taskEntries = listWorkflowTaskRunEntriesFromStateLedger({ anchorPath: runsDir });
    expect(taskEntries).toEqual([
      expect.objectContaining({
        runId: "run-1",
        taskId: "task-1",
        taskTitle: "Ledger task",
        status: "completed",
      }),
    ]);

    const events = listWorkflowEventsFromStateLedger("run-1", { anchorPath: runsDir });
    expect(events.map((event) => event.eventType)).toEqual(["run.start", "run.end"]);

    const pagedSummaries = listWorkflowRunSummariesPageFromStateLedger({
      anchorPath: runsDir,
      offset: 0,
      limit: 10,
    });
    expect(pagedSummaries.total).toBe(1);
    expect(pagedSummaries.runs).toEqual([
      expect.objectContaining({
        runId: "run-1",
        workflowId: "wf-1",
        status: "completed",
        taskId: "task-1",
        sessionId: "session-1",
      }),
    ]);

    rmSync(join(runsDir, "execution-ledger", "run-1.json"), { force: true });

    const fallbackRun = ledger.getRunLedger("run-1");
    expect(fallbackRun).toEqual(
      expect.objectContaining({
        runId: "run-1",
        status: "completed",
      }),
    );
    expect(fallbackRun.events).toHaveLength(2);
  });

  it("writes objective-frame state through the ledger and restore summary", async () => {
    const repoRoot = makeTempDir("state-ledger-objectives-");
    const runsDir = join(repoRoot, ".bosun", "workflow-runs");
    mkdirSync(runsDir, { recursive: true });

    const { WorkflowExecutionLedger } = await import("../workflow/execution-ledger.mjs");
    const ledger = new WorkflowExecutionLedger({ runsDir });

    ledger.ensureRun({
      runId: "run-objective-1",
      workflowId: "wf-objective-1",
      workflowName: "Objective Ledger Workflow",
      startedAt: "2026-04-06T01:00:00.000Z",
      status: "running",
      objectiveFrame: {
        successCriteria: [
          { id: "criterion-1", title: "Draft report", status: "partial", blocking: true },
        ],
        goalProgress: {
          status: "in_progress",
          completedCriteriaCount: 1,
          totalCriteriaCount: 2,
          completionRatio: 0.5,
        },
        constraintState: {
          status: "blocked",
          blocked: true,
          violations: [
            {
              constraintId: "approval",
              message: "Operator approval pending",
              blocking: true,
            },
          ],
        },
        tokenBudget: {
          budgetTokens: 2000,
          totalTokens: 1800,
          remainingTokens: 200,
          status: "near_limit",
        },
      },
    });
    ledger.appendEvent({
      runId: "run-objective-1",
      workflowId: "wf-objective-1",
      workflowName: "Objective Ledger Workflow",
      eventType: "run.start",
      timestamp: "2026-04-06T01:00:00.000Z",
      status: "running",
      meta: {
        taskId: "task-objective-1",
        sessionId: "session-objective-1",
        objectiveFrame: {
          successCriteria: [
            { id: "criterion-1", title: "Draft report", status: "partial", blocking: true },
          ],
          goalProgress: {
            status: "in_progress",
            completedCriteriaCount: 1,
            totalCriteriaCount: 2,
            completionRatio: 0.5,
          },
          constraintState: {
            status: "blocked",
            blocked: true,
            violations: [
              {
                constraintId: "approval",
                message: "Operator approval pending",
                blocking: true,
              },
            ],
          },
          tokenBudget: {
            budgetTokens: 2000,
            totalTokens: 1800,
            remainingTokens: 200,
            status: "near_limit",
          },
        },
      },
    });

    const persisted = ledger.getRunLedger("run-objective-1");
    expect(persisted).toEqual(expect.objectContaining({
      objectiveFrame: expect.objectContaining({
        blocked: true,
      }),
      goalProgress: expect.objectContaining({
        status: "in_progress",
        completionRatio: 0.5,
      }),
      constraintState: expect.objectContaining({
        status: "blocked",
        blockingViolationCount: 1,
      }),
      tokenBudget: expect.objectContaining({
        status: "near_limit",
        totalTokens: 1800,
      }),
    }));

    const restore = ledger.buildRestoreState({ runId: "run-objective-1" });
    expect(restore).toEqual(expect.objectContaining({
      objectiveFrame: expect.objectContaining({
        blocked: true,
      }),
      goalProgress: expect.objectContaining({
        status: "in_progress",
      }),
      constraintState: expect.objectContaining({
        status: "blocked",
      }),
      tokenBudget: expect.objectContaining({
        status: "near_limit",
      }),
    }));
    expect(restore.runs).toEqual([
      expect.objectContaining({
        runId: "run-objective-1",
        objectiveFrame: expect.objectContaining({
          blocked: true,
        }),
        goalProgress: expect.objectContaining({
          status: "in_progress",
        }),
        constraintState: expect.objectContaining({
          status: "blocked",
        }),
        tokenBudget: expect.objectContaining({
          status: "near_limit",
        }),
      }),
    ]);
  });

  it("stores workflow run detail snapshots in sqlite for fileless reads", () => {
    const repoRoot = makeTempDir("state-ledger-workflow-detail-");
    const runsDir = join(repoRoot, ".bosun", "workflow-runs");
    mkdirSync(runsDir, { recursive: true });

    writeWorkflowRunDetailToStateLedger("run-detail-1", {
      id: "run-detail-1",
      startedAt: 1711846800000,
      endedAt: 1711846860000,
      data: {
        _workflowId: "wf-detail-1",
        _workflowName: "Workflow Detail Ledger",
        taskId: "task-detail-1",
      },
      nodeStatuses: {
        trigger: "completed",
      },
      logs: [],
      errors: [],
    }, { anchorPath: runsDir });

    const detail = getWorkflowRunDetailFromStateLedger("run-detail-1", { anchorPath: runsDir });
    expect(detail).toMatchObject({
      id: "run-detail-1",
      data: {
        _workflowId: "wf-detail-1",
        _workflowName: "Workflow Detail Ledger",
        taskId: "task-detail-1",
      },
      nodeStatuses: {
        trigger: "completed",
      },
    });
  });

  it("derives tool calls and artifacts from appended workflow events", async () => {
    const repoRoot = makeTempDir("state-ledger-derivations-");
    const runsDir = join(repoRoot, ".bosun", "workflow-runs");
    mkdirSync(runsDir, { recursive: true });

    const { WorkflowExecutionLedger } = await import("../workflow/execution-ledger.mjs");
    const ledger = new WorkflowExecutionLedger({ runsDir });

    ledger.ensureRun({
      runId: "run-derive-1",
      workflowId: "wf-derive",
      workflowName: "Derive Tool + Artifact",
      startedAt: "2026-03-31T03:00:00.000Z",
      status: "running",
    });
    ledger.appendEvent({
      id: "evt-tool-start",
      runId: "run-derive-1",
      workflowId: "wf-derive",
      workflowName: "Derive Tool + Artifact",
      eventType: "tool.started",
      timestamp: "2026-03-31T03:00:01.000Z",
      executionId: "tool:run-derive-1:scan",
      nodeId: "scan",
      toolId: "paper-qa",
      toolName: "paper-qa",
      status: "running",
      meta: {
        provider: "mcp",
        cwd: repoRoot,
        args: ["--query", "bosun"],
        taskId: "task-derive-1",
        sessionId: "session-derive-1",
      },
    });
    ledger.appendEvent({
      id: "evt-tool-done",
      runId: "run-derive-1",
      workflowId: "wf-derive",
      workflowName: "Derive Tool + Artifact",
      eventType: "tool.completed",
      timestamp: "2026-03-31T03:00:05.000Z",
      executionId: "tool:run-derive-1:scan",
      nodeId: "scan",
      toolId: "paper-qa",
      toolName: "paper-qa",
      status: "completed",
      durationMs: 4000,
      summary: "Collected 3 evidence snippets",
      meta: {
        provider: "mcp",
        cwd: repoRoot,
        taskId: "task-derive-1",
        sessionId: "session-derive-1",
      },
    });
    ledger.appendEvent({
      id: "evt-artifact",
      runId: "run-derive-1",
      workflowId: "wf-derive",
      workflowName: "Derive Tool + Artifact",
      eventType: "artifact.emitted",
      timestamp: "2026-03-31T03:00:06.000Z",
      executionId: "planner:run-derive-1:proof",
      nodeId: "proof",
      summary: "Saved evidence bundle",
      meta: {
        kind: "evidence_bundle",
        path: ".bosun/artifacts/evidence.json",
        taskId: "task-derive-1",
        sessionId: "session-derive-1",
      },
    });

    const toolCalls = listToolCallsFromStateLedger({ runId: "run-derive-1", anchorPath: runsDir });
    expect(toolCalls).toEqual([
      expect.objectContaining({
        callId: "tool:run-derive-1:scan",
        toolId: "paper-qa",
        provider: "mcp",
        status: "completed",
        durationMs: 4000,
      }),
    ]);

    const artifacts = listArtifactsFromStateLedger({ runId: "run-derive-1", anchorPath: runsDir });
    expect(artifacts).toEqual([
      expect.objectContaining({
        kind: "evidence_bundle",
        path: ".bosun/artifacts/evidence.json",
        sourceEventId: expect.any(String),
      }),
    ]);
  });

  it("stores harness runs and events in sqlite for SQL-first API reads", async () => {
    const repoRoot = makeTempDir("state-ledger-harness-");
    const harnessRunsDir = join(repoRoot, ".bosun", ".cache", "harness", "runs");
    mkdirSync(harnessRunsDir, { recursive: true });

    writeHarnessRunToStateLedger({
      runId: "harness-run-1",
      taskId: "task-h-1",
      taskKey: "harness:task-h-1",
      actor: "api",
      recordedAt: "2026-03-31T05:10:00.000Z",
      startedAt: "2026-03-31T05:00:00.000Z",
      finishedAt: "2026-03-31T05:10:00.000Z",
      mode: "run",
      dryRun: false,
      sourceOrigin: "file",
      sourcePath: "internal-harness.md",
      artifactId: "artifact-h-1",
      artifactPath: "artifact-h-1.json",
      compiledProfile: { agentId: "harness-agent", name: "Harness Agent" },
      result: { success: true, status: "completed" },
      events: [
        {
          id: "h1-e1",
          seq: 1,
          timestamp: "2026-03-31T05:00:00.000Z",
          type: "harness:stage-start",
          stageId: "plan",
          stageType: "plan",
          status: "running",
          category: "stage",
        },
        {
          id: "h1-e2",
          seq: 2,
          timestamp: "2026-03-31T05:09:00.000Z",
          type: "harness:approval-requested",
          stageId: "gate",
          stageType: "approval",
          status: "pending",
          reason: "Needs operator confirmation",
          category: "control",
        },
      ],
    }, { anchorPath: harnessRunsDir });

    const listed = listHarnessRunsFromStateLedger({ anchorPath: harnessRunsDir, limit: 10 });
    expect(listed).toEqual([
      expect.objectContaining({
        runId: "harness-run-1",
        taskId: "task-h-1",
        taskKey: "harness:task-h-1",
      }),
    ]);

    const stored = getHarnessRunFromStateLedger("harness-run-1", { anchorPath: harnessRunsDir });
    expect(stored).toEqual(expect.objectContaining({
      runId: "harness-run-1",
      taskId: "task-h-1",
      compiledProfile: expect.objectContaining({ agentId: "harness-agent" }),
      result: expect.objectContaining({ success: true, status: "completed" }),
    }));
    expect(stored.events).toHaveLength(2);

    const events = listHarnessRunEventsFromStateLedger("harness-run-1", { anchorPath: harnessRunsDir });
    expect(events.map((event) => event.type)).toEqual([
      "harness:stage-start",
      "harness:approval-requested",
    ]);
  });

  it("persists canonical harness observability events for replay-friendly projections", async () => {
    const repoRoot = makeTempDir("state-ledger-harness-observability-");
    const harnessRunsDir = join(repoRoot, ".bosun", ".cache", "harness", "runs");
    mkdirSync(harnessRunsDir, { recursive: true });

    writeHarnessRunToStateLedger({
      runId: "harness-run-observe-1",
      taskId: "task-observe-1",
      taskKey: "harness:task-observe-1",
      actor: "ui",
      recordedAt: "2026-03-31T05:15:00.000Z",
      startedAt: "2026-03-31T05:10:00.000Z",
      finishedAt: "2026-03-31T05:15:00.000Z",
      mode: "run",
      dryRun: false,
      sourceOrigin: "ui",
      sourcePath: "internal-harness-observe.json",
      artifactId: "artifact-observe-1",
      artifactPath: "artifact-observe-1.json",
      compiledProfile: { agentId: "observability-agent", name: "Observability Agent" },
      result: { success: true, status: "completed" },
      events: [
        {
          id: "observe-e1",
          seq: 1,
          timestamp: "2026-03-31T05:10:00.000Z",
          type: "tool_execution_start",
          category: "tool",
          stageId: "implement",
          stageType: "tool",
          status: "running",
          providerId: "openai-codex-subscription",
          toolId: "shell.exec",
          toolName: "shell.exec",
          sessionId: "session-observe-1",
          traceId: "11111111111111111111111111111111",
          spanId: "2222222222222222",
        },
        {
          id: "observe-e2",
          seq: 2,
          timestamp: "2026-03-31T05:11:00.000Z",
          type: "approval_requested",
          category: "control",
          stageId: "review",
          stageType: "approval",
          reason: "push_branch requires approval",
          status: "pending",
          actor: "operator",
          approvalId: "approval-observe-1",
          toolId: "push_branch",
        },
        {
          id: "observe-e3",
          seq: 3,
          timestamp: "2026-03-31T05:12:00.000Z",
          type: "patch_applied",
          category: "artifact",
          stageId: "implement",
          stageType: "mutation",
          status: "completed",
          filePath: "server/ui-server.mjs",
          patchHash: "patch-observe-1",
        },
        {
          id: "observe-e4",
          seq: 4,
          timestamp: "2026-03-31T05:13:00.000Z",
          type: "subagent_completed",
          category: "subagent",
          stageId: "delegate",
          stageType: "subagent",
          status: "completed",
          childSessionId: "session-observe-child-1",
          childTaskId: "task-observe-child-1",
        },
      ],
    }, { anchorPath: harnessRunsDir });

    const stored = getHarnessRunFromStateLedger("harness-run-observe-1", { anchorPath: harnessRunsDir });
    expect(stored).toEqual(expect.objectContaining({
      runId: "harness-run-observe-1",
      taskId: "task-observe-1",
      actor: "ui",
      compiledProfile: expect.objectContaining({ agentId: "observability-agent" }),
      result: expect.objectContaining({ success: true, status: "completed" }),
    }));
    expect(stored.events).toEqual([
      expect.objectContaining({
        id: "observe-e1",
        type: "tool_execution_start",
        category: "tool",
        providerId: "openai-codex-subscription",
        toolId: "shell.exec",
        traceId: "11111111111111111111111111111111",
      }),
      expect.objectContaining({
        id: "observe-e2",
        type: "approval_requested",
        category: "control",
        approvalId: "approval-observe-1",
        status: "pending",
      }),
      expect.objectContaining({
        id: "observe-e3",
        type: "patch_applied",
        category: "artifact",
        filePath: "server/ui-server.mjs",
        patchHash: "patch-observe-1",
      }),
      expect.objectContaining({
        id: "observe-e4",
        type: "subagent_completed",
        category: "subagent",
        childSessionId: "session-observe-child-1",
        childTaskId: "task-observe-child-1",
      }),
    ]);

    const replayEvents = listHarnessRunEventsFromStateLedger("harness-run-observe-1", { anchorPath: harnessRunsDir });
    expect(replayEvents).toEqual([
      expect.objectContaining({
        id: "observe-e1",
        seq: 1,
        type: "tool_execution_start",
        category: "tool",
      }),
      expect.objectContaining({
        id: "observe-e2",
        seq: 2,
        type: "approval_requested",
        category: "control",
        actor: "operator",
      }),
      expect.objectContaining({
        id: "observe-e3",
        seq: 3,
        type: "patch_applied",
        category: "artifact",
      }),
      expect.objectContaining({
        id: "observe-e4",
        seq: 4,
        type: "subagent_completed",
        category: "subagent",
      }),
    ]);

    const listed = listHarnessRunsFromStateLedger({ anchorPath: harnessRunsDir, limit: 10 });
    expect(listed).toEqual([
      expect.objectContaining({
        runId: "harness-run-observe-1",
        taskId: "task-observe-1",
        result: expect.objectContaining({ success: true, status: "completed" }),
        events: expect.arrayContaining([
          expect.objectContaining({ type: "tool_execution_start" }),
          expect.objectContaining({ type: "approval_requested" }),
          expect.objectContaining({ type: "patch_applied" }),
          expect.objectContaining({ type: "subagent_completed" }),
        ]),
      }),
    ]);
  });

  it("replays recorded harness run events into the canonical telemetry spine", async () => {
    const repoRoot = makeTempDir("state-ledger-harness-telemetry-replay-");
    const controlPlane = await import("../agent/internal-harness-control-plane.mjs");

    controlPlane.recordHarnessRun({
      runId: "harness-run-telemetry-1",
      taskId: "task-telemetry-1",
      actor: "ui",
      sourceOrigin: "ui",
      artifactId: "artifact-telemetry-1",
      artifactPath: "artifact-telemetry-1.json",
      compiledProfile: { agentId: "telemetry-agent", name: "Telemetry Agent" },
      result: { success: true, status: "completed" },
      events: [
        {
          id: "telemetry-e1",
          timestamp: "2026-04-03T10:00:00.000Z",
          type: "patch_applied",
          category: "artifact",
          stageId: "implement",
          stageType: "mutation",
          filePath: "server/ui-server.mjs",
          patchHash: "patch-telemetry-1",
          status: "completed",
        },
        {
          id: "telemetry-e2",
          timestamp: "2026-04-03T10:00:01.000Z",
          type: "subagent_completed",
          category: "subagent",
          stageId: "delegate",
          stageType: "subagent",
          childSessionId: "session-telemetry-child-1",
          childTaskId: "task-telemetry-child-1",
          subagentId: "subagent-telemetry-1",
          status: "completed",
        },
      ],
    }, { configDir: join(repoRoot, ".bosun") });

    const fileEvents = listHarnessTelemetryEvents({
      filePath: "server/ui-server.mjs",
    }, { configDir: join(repoRoot, ".bosun") });
    const childEvents = listHarnessTelemetryEvents({
      childSessionId: "session-telemetry-child-1",
    }, { configDir: join(repoRoot, ".bosun") });

    expect(fileEvents).toEqual([
      expect.objectContaining({
        eventType: "patch_applied",
        category: "artifact",
        artifactPath: "server/ui-server.mjs",
        patchHash: "patch-telemetry-1",
        runId: "harness-run-telemetry-1",
      }),
    ]);
    expect(childEvents).toEqual([
      expect.objectContaining({
        eventType: "subagent_completed",
        category: "subagent",
        childSessionId: "session-telemetry-child-1",
        childTaskId: "task-telemetry-child-1",
        subagentId: "subagent-telemetry-1",
        runId: "harness-run-telemetry-1",
      }),
    ]);
  });

  it("rebuilds converged live projections from sqlite workflow and harness events", async () => {
    const repoRoot = makeTempDir("state-ledger-replay-convergence-");
    const runsDir = join(repoRoot, ".bosun", "workflow-runs");
    const harnessRunsDir = join(repoRoot, ".bosun", ".cache", "harness", "runs");
    mkdirSync(runsDir, { recursive: true });
    mkdirSync(harnessRunsDir, { recursive: true });

    const { WorkflowExecutionLedger } = await import("../workflow/execution-ledger.mjs");
    const ledger = new WorkflowExecutionLedger({ runsDir });

    ledger.ensureRun({
      runId: "run-replay-converge-1",
      workflowId: "wf-replay-converge",
      workflowName: "Replay Converge Workflow",
      startedAt: "2026-04-03T11:00:00.000Z",
      status: "running",
    });
    ledger.appendEvent({
      id: "wf-replay-e1",
      runId: "run-replay-converge-1",
      workflowId: "wf-replay-converge",
      workflowName: "Replay Converge Workflow",
      eventType: "tool.completed",
      timestamp: "2026-04-03T11:00:01.000Z",
      sessionId: "session-replay-converge-1",
      rootSessionId: "session-root-converge-1",
      taskId: "task-replay-converge-1",
      rootTaskId: "task-root-converge-1",
      providerId: "openai-api",
      modelId: "gpt-5.4",
      toolId: "apply_patch",
      toolName: "apply_patch",
      status: "completed",
      tokenUsage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      },
      meta: {
        taskId: "task-replay-converge-1",
        sessionId: "session-replay-converge-1",
        rootSessionId: "session-root-converge-1",
      },
    });

    writeHarnessRunToStateLedger({
      runId: "harness-replay-converge-1",
      taskId: "task-replay-converge-1",
      actor: "ui",
      recordedAt: "2026-04-03T11:01:00.000Z",
      startedAt: "2026-04-03T11:01:00.000Z",
      finishedAt: "2026-04-03T11:02:00.000Z",
      mode: "run",
      dryRun: false,
      sourceOrigin: "ui",
      compiledProfile: { agentId: "replay-agent", name: "Replay Agent" },
      result: { success: true, status: "completed" },
      events: [
        {
          id: "h-replay-e1",
          seq: 1,
          timestamp: "2026-04-03T11:01:10.000Z",
          type: "approval.resolved",
          category: "approval",
          sessionId: "session-replay-converge-1",
          rootSessionId: "session-root-converge-1",
          runId: "harness-replay-converge-1",
          rootRunId: "run-root-converge-1",
          taskId: "task-replay-converge-1",
          approvalId: "approval-converge-1",
          toolId: "push_branch",
          toolName: "push_branch",
          actor: "operator",
          status: "approved",
        },
        {
          id: "h-replay-e2",
          seq: 2,
          timestamp: "2026-04-03T11:01:20.000Z",
          type: "subagent.completed",
          category: "subagent",
          sessionId: "session-replay-converge-1",
          rootSessionId: "session-root-converge-1",
          runId: "harness-replay-converge-1",
          rootRunId: "run-root-converge-1",
          taskId: "task-replay-converge-1",
          subagentId: "subagent-converge-1",
          childSessionId: "session-child-converge-1",
          childTaskId: "task-child-converge-1",
          childRunId: "run-child-converge-1",
          status: "completed",
        },
      ],
    }, { anchorPath: harnessRunsDir });

    const replay = createReplayReader({ anchorPath: runsDir }).readStateLedgerProjection({
      anchorPath: runsDir,
      workflowRunIds: ["run-replay-converge-1"],
      harnessRunIds: ["harness-replay-converge-1"],
      sessionId: "session-replay-converge-1",
    });

    expect(replay.events).toHaveLength(3);
    expect(replay.live.sessions[0]).toEqual(expect.objectContaining({
      sessionId: "session-replay-converge-1",
      rootSessionId: "session-root-converge-1",
      providerIds: ["openai-api"],
      toolNames: expect.arrayContaining(["apply_patch", "push_branch"]),
      approvalIds: ["approval-converge-1"],
      subagentIds: ["subagent-converge-1"],
      childSessionIds: ["session-child-converge-1"],
      childTaskIds: ["task-child-converge-1"],
      childRunIds: ["run-child-converge-1"],
    }));
    expect(replay.live.approvals).toEqual([
      expect.objectContaining({
        approvalId: "approval-converge-1",
        sessionId: "session-replay-converge-1",
        rootSessionId: "session-root-converge-1",
        toolName: "push_branch",
        status: "approved",
      }),
    ]);
    expect(replay.live.subagents).toEqual([
      expect.objectContaining({
        subagentId: "subagent-converge-1",
        childSessionId: "session-child-converge-1",
        childTaskId: "task-child-converge-1",
        childRunId: "run-child-converge-1",
        rootSessionId: "session-root-converge-1",
      }),
    ]);
    expect(replay.providers).toEqual([
      expect.objectContaining({
        providerId: "openai-api",
        modelId: "gpt-5.4",
        totalTokens: 30,
      }),
    ]);
  });

  it("records harness artifact compile and activation events into the canonical telemetry spine", async () => {
    const repoRoot = makeTempDir("state-ledger-harness-artifact-observability-");
    const controlPlane = await import("../agent/internal-harness-control-plane.mjs");
    const configDir = join(repoRoot, ".bosun");
    const source = [
      "# Internal Harness",
      "```json",
      JSON.stringify({
        name: "Observability Harness",
        entryStageId: "plan",
        stages: [
          {
            id: "plan",
            type: "prompt",
            prompt: "Plan the task.",
          },
        ],
      }),
      "```",
    ].join("\n");

    const compiled = controlPlane.compileHarnessSourceToArtifact(source, {
      configDir,
      sourceOrigin: "ui",
      actor: "operator",
    });
    const activeState = controlPlane.activateHarnessArtifact(compiled.artifactPath, {
      configDir,
      actor: "operator",
    });

    const artifactEvents = listHarnessTelemetryEvents({
      artifactId: compiled.artifactId,
    }, { configDir });

    expect(activeState.artifactId).toBe(compiled.artifactId);
    expect(artifactEvents).toEqual([
      expect.objectContaining({
        eventType: "harness.artifact.compiled",
        category: "artifact",
        artifactId: compiled.artifactId,
        artifactPath: compiled.artifactPath,
        actor: "operator",
      }),
      expect.objectContaining({
        eventType: "harness.artifact.activated",
        category: "artifact",
        artifactId: compiled.artifactId,
        artifactPath: compiled.artifactPath,
        actor: "operator",
      }),
    ]);
  });
});

describe("state ledger sqlite task-claims integration", () => {
  it("mirrors claim snapshots and audit events without blocking JSON claims flow", async () => {
    const repoRoot = makeTempDir("state-ledger-claims-");
    const taskClaims = await loadTaskClaimsModule();
    await taskClaims.initTaskClaims({ repoRoot });

    const claimResult = await taskClaims.claimTask({
      taskId: "task-claim-1",
      instanceId: "instance-1",
      ttlMinutes: 15,
      metadata: { branch: "feature/task-claim-1" },
    });
    expect(claimResult.success).toBe(true);

    const activeClaim = getActiveTaskClaimFromStateLedger("task-claim-1", { repoRoot });
    expect(activeClaim).toEqual(
      expect.objectContaining({
        task_id: "task-claim-1",
        instance_id: "instance-1",
      }),
    );

    const renewResult = await taskClaims.renewClaim({
      taskId: "task-claim-1",
      claimToken: claimResult.token,
      instanceId: "instance-1",
      ttlMinutes: 30,
    });
    expect(renewResult.success).toBe(true);

    const releaseResult = await taskClaims.releaseTask({
      taskId: "task-claim-1",
      claimToken: claimResult.token,
      instanceId: "instance-1",
    });
    expect(releaseResult.success).toBe(true);
    expect(getActiveTaskClaimFromStateLedger("task-claim-1", { repoRoot })).toBeNull();

    const claimEvents = listTaskClaimEventsFromStateLedger("task-claim-1", { repoRoot });
    expect(claimEvents.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(["claim", "renew", "release"]),
    );
  });
});

describe("state ledger sqlite task-store integration", () => {
  it("mirrors current task snapshots and hides deleted tasks from default queries", async () => {
    const repoRoot = makeTempDir("state-ledger-store-");
    const storePath = join(repoRoot, ".bosun", ".cache", "kanban-state.json");
    const taskStore = await loadTaskStoreModule();
    taskStore.configureTaskStore({ storePath });
    taskStore.loadStore();

    taskStore.addTask({
      id: "task-store-1",
      title: "Persist to sqlite",
      status: "todo",
      comments: [{ id: "comment-1", body: "hello" }],
      attachments: [{ id: "attachment-1", filePath: "artifacts/output.log" }],
      workflowRuns: [{ runId: "run-1", workflowId: "wf-1" }],
      runs: [{ startedAt: "2026-03-31T02:00:00.000Z" }],
    });
    taskStore.addTask({
      id: "task-store-2",
      title: "Delegated child",
      status: "todo",
    });
    taskStore.setTaskParent("task-store-2", "task-store-1", { source: "test" });
    taskStore.linkTaskWorkflowRun("task-store-2", {
      runId: "run-child-1",
      workflowId: "wf-delegate",
      workflowName: "Delegate child",
      nodeId: "delegate-node",
      status: "completed",
      rootRunId: "run-root-1",
      parentRunId: "run-parent-1",
      taskId: "task-store-2",
      rootTaskId: "task-store-1",
      parentTaskId: "task-store-2",
      sessionId: "session-child-1",
      rootSessionId: "session-root-1",
      parentSessionId: "session-parent-1",
      delegationDepth: 2,
    });
    await taskStore.waitForStoreWrites();

    expect(getTaskSnapshotFromStateLedger("task-store-1", { anchorPath: storePath })).toEqual(
      expect.objectContaining({
        id: "task-store-1",
        title: "Persist to sqlite",
        status: "todo",
      }),
    );
    expect(getTaskTopologyFromStateLedger("task-store-2", { anchorPath: storePath })).toEqual(
      expect.objectContaining({
        taskId: "task-store-2",
        graphRootTaskId: "task-store-1",
        graphParentTaskId: "task-store-1",
        graphDepth: 1,
        graphPath: ["task-store-1", "task-store-2"],
        workflowId: "wf-delegate",
        workflowName: "Delegate child",
        latestNodeId: "delegate-node",
        latestRunId: "run-child-1",
        rootRunId: "run-root-1",
        parentRunId: "run-parent-1",
        latestSessionId: "session-child-1",
        rootSessionId: "session-root-1",
        parentSessionId: "session-parent-1",
        rootTaskId: "task-store-1",
        parentTaskId: "task-store-2",
        delegationDepth: 2,
      }),
    );
    expect(listTaskTopologiesFromStateLedger({ rootTaskId: "task-store-1", anchorPath: storePath })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: "task-store-1" }),
        expect.objectContaining({ taskId: "task-store-2", latestRunId: "run-child-1" }),
      ]),
    );

    taskStore.updateTask("task-store-1", {
      title: "Persist to sqlite updated",
      status: "inprogress",
    });
    await taskStore.waitForStoreWrites();

    expect(getTaskSnapshotFromStateLedger("task-store-1", { anchorPath: storePath })).toEqual(
      expect.objectContaining({
        id: "task-store-1",
        title: "Persist to sqlite updated",
        status: "inprogress",
      }),
    );

    taskStore.removeTask("task-store-1");
    taskStore.removeTask("task-store-2");
    await taskStore.waitForStoreWrites();

    expect(getTaskSnapshotFromStateLedger("task-store-1", { anchorPath: storePath })).toBeNull();
    expect(getTaskTopologyFromStateLedger("task-store-2", { anchorPath: storePath })).toBeNull();
  });
});

describe("state ledger sqlite audit helpers", () => {
  it("stores key-values, operator actions, and ad hoc artifact records", () => {
    const repoRoot = makeTempDir("state-ledger-audit-");

    upsertStateLedgerKeyValue({
      scope: "settings",
      scopeId: repoRoot,
      key: "REPO_MIRROR_ENABLED",
      value: "true",
      source: "test",
      metadata: { updatedBy: "vitest" },
    }, { repoRoot });

    appendOperatorActionToStateLedger({
      actionId: "settings-update-1",
      actionType: "settings.update",
      actorId: "vitest",
      actorType: "operator",
      scope: "settings",
      scopeId: repoRoot,
      targetId: "REPO_MIRROR_ENABLED",
      request: { changes: { REPO_MIRROR_ENABLED: "true" } },
      result: { updated: ["REPO_MIRROR_ENABLED"] },
    }, { repoRoot });

    appendArtifactRecordToStateLedger({
      artifactId: "artifact:test:1",
      runId: "run-audit-1",
      kind: "shared_knowledge_entry",
      path: ".bosun/shared-knowledge/REVIEWED_RESEARCH.md",
      summary: "Stored reviewed finding",
      metadata: { hash: "abc123" },
    }, { repoRoot });

    expect(getStateLedgerKeyValue("settings", repoRoot, "REPO_MIRROR_ENABLED", { repoRoot })).toEqual(
      expect.objectContaining({
        value: "true",
        source: "test",
      }),
    );
    expect(listOperatorActionsFromStateLedger({ scope: "settings", repoRoot })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionId: "settings-update-1",
          actionType: "settings.update",
          targetId: "REPO_MIRROR_ENABLED",
        }),
      ]),
    );
    expect(listArtifactsFromStateLedger({ runId: "run-audit-1", repoRoot })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: "artifact:test:1",
          kind: "shared_knowledge_entry",
          path: ".bosun/shared-knowledge/REVIEWED_RESEARCH.md",
        }),
      ]),
    );
  });

  it("stores task trace events and projects session plus agent activity", () => {
    const repoRoot = makeTempDir("state-ledger-trace-");

    appendTaskTraceEventToStateLedger({
      eventId: "trace-event-1",
      taskId: "task-trace-1",
      taskTitle: "Trace me",
      workflowId: "wf-trace-1",
      workflowName: "Trace Workflow",
      runId: "run-trace-1",
      eventType: "workflow.run.end",
      status: "completed",
      summary: "Workflow finished with trace context",
      durationMs: 4200,
      branch: "feature/trace",
      prNumber: 42,
      prUrl: "https://example.test/pr/42",
      workspaceId: "ws-trace",
      sessionId: "session-trace-1",
      sessionType: "task",
      agentId: "agent.trace",
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      parentSpanId: "cccccccccccccccc",
      benchmarkHint: { throughputPerMinute: 8.5 },
      meta: { phase: "complete" },
    }, { repoRoot });

    expect(listTaskTraceEventsFromStateLedger({ repoRoot, taskId: "task-trace-1" })).toEqual([
      expect.objectContaining({
        eventId: "trace-event-1",
        taskId: "task-trace-1",
        sessionId: "session-trace-1",
        agentId: "agent.trace",
        traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        benchmarkHint: { throughputPerMinute: 8.5 },
      }),
    ]);
    expect(listTaskTraceEventsFromStateLedger({ repoRoot, runId: "run-trace-1" })).toEqual([
      expect.objectContaining({
        eventId: "trace-event-1",
        runId: "run-trace-1",
      }),
    ]);

    expect(getSessionActivityFromStateLedger("session-trace-1", { repoRoot })).toEqual(
      expect.objectContaining({
        sessionId: "session-trace-1",
        latestTaskId: "task-trace-1",
        latestRunId: "run-trace-1",
        latestEventType: "workflow.run.end",
        latestStatus: "completed",
        agentId: "agent.trace",
        traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        eventCount: 1,
      }),
    );

    expect(getAgentActivityFromStateLedger("agent.trace", { repoRoot })).toEqual(
      expect.objectContaining({
        agentId: "agent.trace",
        latestTaskId: "task-trace-1",
        latestSessionId: "session-trace-1",
        latestRunId: "run-trace-1",
        latestEventType: "workflow.run.end",
        latestStatus: "completed",
        traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        eventCount: 1,
      }),
    );
  });

  it("stores tracker-backed session summaries and lists them newest-first", () => {
    const repoRoot = makeTempDir("state-ledger-session-record-");

    upsertSessionRecordToStateLedger({
      sessionId: "session-manual-1",
      type: "manual",
      workspaceId: "workspace-a",
      taskId: "task-manual-1",
      taskTitle: "Manual session",
      latestEventType: "assistant",
      status: "completed",
      updatedAt: "2026-03-31T06:05:00.000Z",
      startedAt: "2026-03-31T06:00:00.000Z",
      eventCount: 3,
      preview: "Completed the manual run.",
      document: {
        id: "session-manual-1",
        taskId: "task-manual-1",
        taskTitle: "Manual session",
        type: "manual",
        status: "completed",
        lifecycleStatus: "completed",
        workspaceId: "workspace-a",
        createdAt: "2026-03-31T06:00:00.000Z",
        lastActiveAt: "2026-03-31T06:05:00.000Z",
        totalEvents: 3,
        turnCount: 1,
        messages: [
          { role: "assistant", content: "Completed the manual run.", timestamp: "2026-03-31T06:05:00.000Z" },
        ],
      },
    }, { repoRoot });

    upsertSessionRecordToStateLedger({
      sessionId: "session-manual-2",
      type: "manual",
      workspaceId: "workspace-a",
      taskId: "task-manual-2",
      taskTitle: "Latest manual session",
      latestEventType: "assistant",
      status: "active",
      updatedAt: "2026-03-31T06:10:00.000Z",
      startedAt: "2026-03-31T06:08:00.000Z",
      eventCount: 1,
      preview: "Still running",
      document: {
        id: "session-manual-2",
        taskId: "task-manual-2",
        taskTitle: "Latest manual session",
        type: "manual",
        status: "active",
        lifecycleStatus: "active",
        workspaceId: "workspace-a",
        createdAt: "2026-03-31T06:08:00.000Z",
        lastActiveAt: "2026-03-31T06:10:00.000Z",
        totalEvents: 1,
        messages: [],
      },
    }, { repoRoot });

    expect(getSessionActivityFromStateLedger("session-manual-1", { repoRoot })).toEqual(
      expect.objectContaining({
        sessionId: "session-manual-1",
        latestTaskId: "task-manual-1",
        latestStatus: "completed",
        eventCount: 3,
        document: expect.objectContaining({
          id: "session-manual-1",
          totalEvents: 3,
        }),
      }),
    );

    expect(listSessionActivitiesFromStateLedger({ repoRoot, workspaceId: "workspace-a" })).toEqual([
      expect.objectContaining({
        sessionId: "session-manual-2",
        latestTaskId: "task-manual-2",
        latestStatus: "active",
      }),
      expect.objectContaining({
        sessionId: "session-manual-1",
        latestTaskId: "task-manual-1",
        latestStatus: "completed",
      }),
    ]);
  });

  it("deletes durable session activity rows", () => {
    const repoRoot = makeTempDir("state-ledger-session-delete-");

    upsertSessionRecordToStateLedger({
      sessionId: "session-delete-1",
      type: "manual",
      workspaceId: "workspace-delete",
      taskId: "task-delete-1",
      taskTitle: "Delete me",
      status: "completed",
      latestEventType: "assistant",
      updatedAt: "2026-03-31T06:05:00.000Z",
      startedAt: "2026-03-31T06:00:00.000Z",
      eventCount: 1,
      document: {
        id: "session-delete-1",
        taskId: "task-delete-1",
        type: "manual",
        status: "completed",
      },
    }, { repoRoot });

    expect(getSessionActivityFromStateLedger("session-delete-1", { repoRoot })).toEqual(
      expect.objectContaining({
        sessionId: "session-delete-1",
        latestTaskId: "task-delete-1",
      }),
    );

    expect(deleteSessionRecordFromStateLedger("session-delete-1", { repoRoot })).toEqual({
      sessionId: "session-delete-1",
      deleted: true,
    });
    expect(getSessionActivityFromStateLedger("session-delete-1", { repoRoot })).toBeNull();
    expect(listSessionActivitiesFromStateLedger({ repoRoot, workspaceId: "workspace-delete" })).toEqual([]);
  });

  it("stores promoted strategy snapshots and audit events", () => {
    const repoRoot = makeTempDir("state-ledger-strategy-");

    appendPromotedStrategyToStateLedger({
      strategyId: "wf-1:promote:global:quality",
      workflowId: "wf-1",
      runId: "run-1",
      taskId: "task-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      scope: "workflow-reliability",
      scopeLevel: "workspace",
      category: "strategy",
      decision: "promote_strategy",
      status: "promoted",
      verificationStatus: "promote_strategy",
      confidence: 0.84,
      recommendation: "Preserve the current workflow pattern as the reliability baseline.",
      rationale: "The run met quality thresholds without retries.",
      tags: ["self-improvement", "baseline"],
      evidence: ["grade:A", "score:92"],
      provenance: ["run:run-1", "workflow:wf-1"],
      benchmark: { throughputPerMinute: 9.2 },
      metrics: { failedNodes: 0, retriedNodes: 0 },
      evaluation: { score: 92, grade: "A" },
      knowledge: { hash: "knowledge-hash-1", registryPath: "persistent-memory.json" },
      promotedAt: "2026-03-31T05:00:00.000Z",
    }, { repoRoot });

    expect(getPromotedStrategyFromStateLedger("wf-1:promote:global:quality", { repoRoot })).toEqual(
      expect.objectContaining({
        strategyId: "wf-1:promote:global:quality",
        workflowId: "wf-1",
        runId: "run-1",
        decision: "promote_strategy",
        status: "promoted",
        knowledgeHash: "knowledge-hash-1",
      }),
    );
    expect(listPromotedStrategiesFromStateLedger({ repoRoot, workflowId: "wf-1" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          strategyId: "wf-1:promote:global:quality",
          decision: "promote_strategy",
          status: "promoted",
        }),
      ]),
    );
    expect(listPromotedStrategiesFromStateLedger({ repoRoot, runId: "run-1" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          strategyId: "wf-1:promote:global:quality",
          runId: "run-1",
        }),
      ]),
    );
    expect(listPromotedStrategyEventsFromStateLedger({ repoRoot, strategyId: "wf-1:promote:global:quality" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          strategyId: "wf-1:promote:global:quality",
          workflowId: "wf-1",
          runId: "run-1",
          knowledgeHash: "knowledge-hash-1",
        }),
      ]),
    );
    expect(listPromotedStrategyEventsFromStateLedger({ repoRoot, runId: "run-1" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          strategyId: "wf-1:promote:global:quality",
          runId: "run-1",
        }),
      ]),
    );
  });

  it("stores persistent knowledge entries in the state ledger with scope filtering", () => {
    const repoRoot = makeTempDir("state-ledger-knowledge-");

    appendKnowledgeEntryToStateLedger({
      hash: "knowledge-workspace-1",
      content: "Workspace memory: reset database fixtures before retrying login flows.",
      scope: "testing",
      scopeLevel: "workspace",
      teamId: "team-a",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      runId: "run-1",
      workflowId: "wf-knowledge",
      agentId: "agent-a",
      tags: ["testing", "login"],
      provenance: ["run:run-1"],
      evidence: ["fixture-reset"],
      timestamp: "2026-03-31T10:00:00.000Z",
    }, { repoRoot });
    appendKnowledgeEntryToStateLedger({
      hash: "knowledge-team-1",
      content: "Team memory: deterministic waits beat sleep-based polling.",
      scope: "testing",
      scopeLevel: "team",
      teamId: "team-a",
      workspaceId: "workspace-9",
      sessionId: "session-9",
      runId: "run-9",
      workflowId: "wf-knowledge",
      agentId: "agent-b",
      tags: ["testing"],
      timestamp: "2026-03-31T09:00:00.000Z",
    }, { repoRoot });

    expect(listKnowledgeEntriesFromStateLedger({ repoRoot, workspaceId: "workspace-1" })).toEqual([
      expect.objectContaining({
        hash: "knowledge-workspace-1",
        scopeLevel: "workspace",
        workspaceId: "workspace-1",
      }),
    ]);
    expect(listKnowledgeEntriesFromStateLedger({ repoRoot, teamId: "team-a" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hash: "knowledge-team-1", scopeLevel: "team" }),
      ]),
    );
  });

  it("builds normalized audit bundles and mixed audit timelines", async () => {
    const repoRoot = makeTempDir("state-ledger-audit-bundle-");
    const runsDir = join(repoRoot, ".bosun", "workflow-runs");
    mkdirSync(runsDir, { recursive: true });

    const { WorkflowExecutionLedger } = await import("../workflow/execution-ledger.mjs");
    const ledger = new WorkflowExecutionLedger({ runsDir });
    ledger.ensureRun({
      runId: "run-audit-bundle-1",
      workflowId: "wf-audit-bundle-1",
      workflowName: "Audit Bundle Workflow",
      taskId: "task-audit-bundle-1",
      taskTitle: "Audit bundle task",
      startedAt: "2026-03-31T09:00:00.000Z",
      status: "running",
    });
    ledger.appendEvent({
      runId: "run-audit-bundle-1",
      workflowId: "wf-audit-bundle-1",
      workflowName: "Audit Bundle Workflow",
      eventType: "run.start",
      timestamp: "2026-03-31T09:00:00.000Z",
      status: "running",
      meta: {
        taskId: "task-audit-bundle-1",
        taskTitle: "Audit bundle task",
        sessionId: "session-audit-bundle-1",
      },
    });

    const taskStore = await loadTaskStoreModule();
    const storePath = join(repoRoot, ".bosun", ".cache", "kanban-state.json");
    taskStore.configureTaskStore({ storePath });
    taskStore.loadStore();
    taskStore.addTask({
      id: "task-audit-bundle-1",
      title: "Audit bundle task",
      status: "inprogress",
      workflowRuns: [{ runId: "run-audit-bundle-1", workflowId: "wf-audit-bundle-1", status: "running" }],
    });
    await taskStore.waitForStoreWrites();

    appendTaskTraceEventToStateLedger({
      eventId: "trace-audit-bundle-1",
      taskId: "task-audit-bundle-1",
      taskTitle: "Audit bundle task",
      workflowId: "wf-audit-bundle-1",
      workflowName: "Audit Bundle Workflow",
      runId: "run-audit-bundle-1",
      eventType: "workflow.node.completed",
      status: "completed",
      summary: "Planner node completed",
      sessionId: "session-audit-bundle-1",
      agentId: "agent.audit.bundle",
      timestamp: "2026-03-31T09:01:00.000Z",
    }, { repoRoot });

    appendOperatorActionToStateLedger({
      actionId: "operator-audit-bundle-1",
      actionType: "task.override",
      actorId: "vitest",
      actorType: "operator",
      taskId: "task-audit-bundle-1",
      runId: "run-audit-bundle-1",
      sessionId: "session-audit-bundle-1",
      status: "completed",
      createdAt: "2026-03-31T09:02:00.000Z",
      result: { status: "noted" },
    }, { repoRoot });

    appendArtifactRecordToStateLedger({
      artifactId: "artifact:audit-bundle:1",
      taskId: "task-audit-bundle-1",
      runId: "run-audit-bundle-1",
      sessionId: "session-audit-bundle-1",
      kind: "planner_output",
      path: ".bosun/workflow-runs/audit-bundle.json",
      summary: "Planner output captured",
      createdAt: "2026-03-31T09:03:00.000Z",
    }, { repoRoot });

    appendPromotedStrategyToStateLedger({
      strategyId: "wf-audit-bundle-1:promote:quality",
      workflowId: "wf-audit-bundle-1",
      runId: "run-audit-bundle-1",
      taskId: "task-audit-bundle-1",
      sessionId: "session-audit-bundle-1",
      decision: "promote_strategy",
      status: "promoted",
      verificationStatus: "promote_strategy",
      recommendation: "Keep the planner path that completed cleanly.",
      rationale: "Planner node completed with no retries.",
      promotedAt: "2026-03-31T09:04:00.000Z",
    }, { repoRoot });

    const taskAudit = getTaskAuditBundleFromStateLedger("task-audit-bundle-1", { repoRoot });
    expect(taskAudit).toEqual(expect.objectContaining({
      taskId: "task-audit-bundle-1",
      workflowRuns: expect.arrayContaining([
        expect.objectContaining({ runId: "run-audit-bundle-1" }),
      ]),
      toolCalls: expect.any(Array),
      artifacts: expect.arrayContaining([
        expect.objectContaining({ artifactId: "artifact:audit-bundle:1" }),
      ]),
      operatorActions: expect.arrayContaining([
        expect.objectContaining({ actionId: "operator-audit-bundle-1" }),
      ]),
      promotedStrategies: expect.arrayContaining([
        expect.objectContaining({ strategyId: "wf-audit-bundle-1:promote:quality" }),
      ]),
      auditEvents: expect.arrayContaining([
        expect.objectContaining({ auditType: "artifact" }),
        expect.objectContaining({ auditType: "operator_action" }),
        expect.objectContaining({ auditType: "promoted_strategy" }),
        expect.objectContaining({ auditType: "task_trace" }),
        expect.objectContaining({ auditType: "workflow_event" }),
      ]),
    }));

    const runAudit = getRunAuditBundleFromStateLedger("run-audit-bundle-1", { repoRoot });
    expect(runAudit).toEqual(expect.objectContaining({
      runId: "run-audit-bundle-1",
      taskTraceEvents: expect.arrayContaining([
        expect.objectContaining({ eventId: "trace-audit-bundle-1" }),
      ]),
      auditEvents: expect.arrayContaining([
        expect.objectContaining({ auditType: "workflow_event" }),
      ]),
    }));

    expect(listAuditEventsFromStateLedger({ repoRoot, taskId: "task-audit-bundle-1", limit: 10 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ auditType: "artifact" }),
        expect.objectContaining({ auditType: "operator_action" }),
        expect.objectContaining({ auditType: "promoted_strategy" }),
      ]),
    );

    expect(listTaskAuditSummariesFromStateLedger({ repoRoot, limit: 10 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "task-audit-bundle-1",
          summary: expect.objectContaining({
            runCount: expect.any(Number),
            eventCount: expect.any(Number),
          }),
        }),
      ]),
    );
  });
});
