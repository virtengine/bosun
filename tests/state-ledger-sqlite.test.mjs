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
  getWorkflowRunFromStateLedger,
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
  listWorkflowEventsFromStateLedger,
  listWorkflowTaskRunEntriesFromStateLedger,
  resetStateLedgerCache,
  resolveStateLedgerPath,
  upsertSessionRecordToStateLedger,
  upsertStateLedgerKeyValue,
} from "../lib/state-ledger-sqlite.mjs";

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
  await vi.resetModules();
  while (tempDirs.length) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("state ledger sqlite workflow integration", () => {
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
      key: "GNAP_ENABLED",
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
      targetId: "GNAP_ENABLED",
      request: { changes: { GNAP_ENABLED: "true" } },
      result: { updated: ["GNAP_ENABLED"] },
    }, { repoRoot });

    appendArtifactRecordToStateLedger({
      artifactId: "artifact:test:1",
      runId: "run-audit-1",
      kind: "shared_knowledge_entry",
      path: ".bosun/shared-knowledge/REVIEWED_RESEARCH.md",
      summary: "Stored reviewed finding",
      metadata: { hash: "abc123" },
    }, { repoRoot });

    expect(getStateLedgerKeyValue("settings", repoRoot, "GNAP_ENABLED", { repoRoot })).toEqual(
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
          targetId: "GNAP_ENABLED",
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
