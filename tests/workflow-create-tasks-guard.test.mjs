import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NodeStatus,
  WorkflowEngine,
  WorkflowStatus,
  resetWorkflowEngine,
} from "../workflow/workflow-engine.mjs";
import "../workflow/workflow-nodes.mjs";
import { testTimeout } from "./timeout-helper.mjs";

vi.setConfig({ testTimeout: testTimeout(15_000) });

let tmpDir;
let engine;

function makeTmpEngine(services = {}) {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-create-tasks-guard-"));
  engine = new WorkflowEngine({
    workflowDir: join(tmpDir, "workflows"),
    runsDir: join(tmpDir, "runs"),
    services,
  });
  return engine;
}

function makeCreateTasksPendingWorkflow({ dedup = true } = {}) {
  return {
    id: `wf-create-tasks-pending-${dedup ? "dedup" : "unsafe"}-${Math.random().toString(36).slice(2, 8)}`,
    name: "Create Tasks Pending Workflow",
    description: "Workflow fixture for Create Tasks retry/resume guards",
    enabled: true,
    variables: {},
    nodes: [
      { id: "trigger", type: "trigger.manual", label: "Trigger", config: {} },
      { id: "plan", type: "transform.template", label: "Plan Work", config: { template: "planner-ready" } },
      {
        id: "create-tasks",
        type: "action.materialize_planner_tasks",
        label: "Create Tasks",
        config: {
          plannerNodeId: "run-planner",
          projectId: "proj-123",
          dedup,
          failOnZero: true,
          minCreated: 1,
        },
      },
      { id: "resume-work", type: "notify.log", label: "Resume Work", config: { message: "resume downstream" } },
    ],
    edges: [
      { id: "e1", source: "trigger", target: "plan" },
      { id: "e2", source: "plan", target: "create-tasks" },
      { id: "e3", source: "create-tasks", target: "resume-work" },
    ],
  };
}

function writePausedCreateTasksRun(runId, workflow, { taskId = "task-create-guard-1" } = {}) {
  const runsDir = join(tmpDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const startedAt = 1_000;
  const nodeStatuses = {
    trigger: NodeStatus.COMPLETED,
    plan: NodeStatus.COMPLETED,
    "create-tasks": NodeStatus.PENDING,
    "resume-work": NodeStatus.PENDING,
  };
  const dependenciesByNodeId = new Map();
  for (const edge of workflow.edges || []) {
    if (!dependenciesByNodeId.has(edge.target)) dependenciesByNodeId.set(edge.target, []);
    dependenciesByNodeId.get(edge.target).push(edge.source);
  }
  const dagNodes = Object.fromEntries(
    workflow.nodes.map((node) => [
      node.id,
      {
        nodeId: node.id,
        type: node.type,
        label: node.label,
        status: nodeStatuses[node.id] || NodeStatus.PENDING,
        dependencies: dependenciesByNodeId.get(node.id) || [],
        attempts: 0,
        lastError: null,
        outputSummary: null,
        issueFindings: [],
        completionEvidence: [],
        startedAt: null,
        endedAt: null,
        updatedAt: new Date(startedAt).toISOString(),
      },
    ]),
  );

  writeFileSync(
    join(runsDir, "index.json"),
    JSON.stringify({
      runs: [
        {
          runId,
          workflowId: workflow.id,
          workflowName: workflow.name,
          status: WorkflowStatus.PAUSED,
          startedAt,
          endedAt: null,
          resumable: true,
        },
      ],
    }, null, 2),
    "utf8",
  );

  writeFileSync(
    join(runsDir, `${runId}.json`),
    JSON.stringify({
      id: runId,
      startedAt,
      endedAt: null,
      data: {
        _workflowId: workflow.id,
        _workflowName: workflow.name,
        taskId,
      },
      nodeStatuses,
      nodeOutputs: {
        trigger: { triggered: true },
        plan: { template: "planner-ready" },
        "run-planner": {
          output: JSON.stringify({
            tasks: [
              {
                title: "Resume guarded planner task",
                description: "Resume safely without duplicate task creation.",
                acceptance_criteria: ["guard path stays idempotent"],
                verification: ["node tools/vitest-runner.mjs run tests/workflow-create-tasks-guard.test.mjs"],
                repo_areas: ["workflow"],
                impact: 0.9,
                confidence: 0.8,
                risk: 0.2,
              },
            ],
          }),
        },
      },
      nodeStatusEvents: [
        { nodeId: "trigger", status: NodeStatus.COMPLETED, timestamp: startedAt + 1 },
        { nodeId: "plan", status: NodeStatus.COMPLETED, timestamp: startedAt + 2 },
      ],
      logs: [],
      errors: [],
      issueAdvisor: {
        status: WorkflowStatus.PAUSED,
        summary: "Resume from Create Tasks.",
        recommendedAction: "resume_remaining",
        failedNodeCount: 0,
        pendingNodeCount: 2,
        completedNodeCount: 2,
        nextStepGuidance: "Preserve completed work and continue from the next pending node. Next step: Create Tasks.",
        dagRevisionCount: 0,
      },
      dagState: {
        version: 1,
        runId,
        workflowId: workflow.id,
        workflowName: workflow.name,
        rootRunId: runId,
        parentRunId: null,
        retryOf: null,
        retryMode: null,
        revisionReason: null,
        createdAt: new Date(startedAt).toISOString(),
        updatedAt: new Date(startedAt).toISOString(),
        status: WorkflowStatus.RUNNING,
        revisions: [],
        counts: {
          total: workflow.nodes.length,
          pending: 2,
          running: 0,
          completed: 2,
          failed: 0,
          skipped: 0,
        },
        edges: workflow.edges.map((edge) => ({
          edgeId: String(edge.id || `${edge.source}->${edge.target}`),
          source: edge.source,
          target: edge.target,
          label: edge.label || null,
          condition: edge.condition || null,
        })),
        nodes: dagNodes,
      },
    }, null, 2),
    "utf8",
  );

  writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");
}

async function removeDirWithRetries(dirPath) {
  if (!dirPath) return;
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== "EPERM") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  if (lastError?.code === "EPERM") return;
  throw lastError;
}

describe("WorkflowEngine - Create Tasks retry guard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    resetWorkflowEngine();
    await removeDirWithRetries(tmpDir);
    tmpDir = null;
    engine = null;
  });

  it("labels pending Create Tasks recovery as resume-first and exposes the guard context", () => {
    makeTmpEngine({
      kanban: {
        createTask: vi.fn(),
        listTasks: vi.fn(async () => []),
      },
    });

    const workflow = makeCreateTasksPendingWorkflow({ dedup: true });
    engine.save(workflow);
    writePausedCreateTasksRun("run-create-tasks-retry-options", workflow);

    const retryOptions = engine.getRetryOptions("run-create-tasks-retry-options");
    const resumeOption = retryOptions?.options?.find((entry) => entry.mode === "from_failed");
    const replanOption = retryOptions?.options?.find((entry) => entry.mode === "replan_from_failed");
    const subgraphOption = retryOptions?.options?.find((entry) => entry.mode === "replan_subgraph");
    const fromScratchOption = retryOptions?.options?.find((entry) => entry.mode === "from_scratch");

    expect(retryOptions?.guardedState).toMatchObject({
      code: "create_tasks_pending",
      nextNodeId: "create-tasks",
      nextNodeLabel: "Create Tasks",
      safeResume: true,
    });
    expect(retryOptions?.recommendedMode).toBe("from_failed");
    expect(retryOptions?.recommendedReason).toBe("create_tasks_pending.resume_only");
    expect(resumeOption?.label).toBe("Resume from next pending step");
    expect(String(resumeOption?.description || "")).toMatch(/manual retry/i);
    expect(resumeOption?.recommended).toBe(true);
    expect(replanOption?.available).toBe(false);
    expect(subgraphOption?.available).toBe(false);
    expect(fromScratchOption?.available).toBe(false);
    expect(String(fromScratchOption?.description || "")).toMatch(/manual restart is blocked/i);
  });

  it("blocks manual retry when Create Tasks is the next pending node", async () => {
    const createTask = vi.fn();
    makeTmpEngine({
      kanban: {
        createTask,
        listTasks: vi.fn(async () => []),
      },
    });

    const workflow = makeCreateTasksPendingWorkflow({ dedup: true });
    engine.save(workflow);
    writePausedCreateTasksRun("run-create-tasks-manual-retry", workflow);

    await expect(engine.retryRun("run-create-tasks-manual-retry", { mode: "from_failed" })).rejects.toThrow(
      /Create Tasks.*manual retry.*resume/i,
    );
    await expect(engine.retryRun("run-create-tasks-manual-retry", { mode: "from_scratch" })).rejects.toThrow(
      /Create Tasks.*manual retry.*resume/i,
    );
    expect(createTask).not.toHaveBeenCalled();
  });

  it("allows explicit operator resume when Create Tasks recovery is idempotent", async () => {
    makeTmpEngine({
      kanban: {
        createTask: vi.fn(async () => ({ id: "kanban-task-1" })),
        listTasks: vi.fn(async () => []),
      },
    });

    const workflow = makeCreateTasksPendingWorkflow({ dedup: true });
    engine.save(workflow);
    writePausedCreateTasksRun("run-create-tasks-operator-resume", workflow);

    const resolvedRetry = engine.resolveOperatorRetry("run-create-tasks-operator-resume", "from_failed");
    expect(resolvedRetry).toMatchObject({
      mode: "from_failed",
      operatorAction: "resume",
      decisionReason: "create_tasks_pending.resume_only",
      blocked: false,
      guardedState: {
        code: "create_tasks_pending",
        safeResume: true,
      },
    });

    const result = await engine.retryRun("run-create-tasks-operator-resume", resolvedRetry.retryArgs);
    expect(result.mode).toBe("from_failed");
    expect(result.retryRunId).toBeTruthy();
    expect(Array.isArray(result.ctx?.errors)).toBe(true);
  });

  it("falls back to from_scratch retry metadata when Create Tasks resume is unsafe", () => {
    makeTmpEngine({
      kanban: {
        createTask: vi.fn(),
      },
    });

    const workflow = makeCreateTasksPendingWorkflow({ dedup: false });
    engine.save(workflow);
    writePausedCreateTasksRun("run-create-tasks-restart-only", workflow);

    const retryOptions = engine.getRetryOptions("run-create-tasks-restart-only");
    const resumeOption = retryOptions?.options?.find((entry) => entry.mode === "from_failed");
    const replanOption = retryOptions?.options?.find((entry) => entry.mode === "replan_from_failed");
    const fromScratchOption = retryOptions?.options?.find((entry) => entry.mode === "from_scratch");

    expect(retryOptions?.guardedState).toMatchObject({
      code: "create_tasks_pending",
      safeResume: false,
    });
    expect(retryOptions?.recommendedMode).toBe("from_scratch");
    expect(retryOptions?.recommendedReason).toBe("create_tasks_pending.requires_restart");
    expect(resumeOption?.available).toBe(false);
    expect(replanOption?.available).toBe(false);
    expect(fromScratchOption?.recommended).toBe(true);
    expect(String(fromScratchOption?.description || "")).toMatch(/Verify whether Create Tasks already created tasks/i);
  });

  it("resumes interrupted Create Tasks runs only when idempotency checks pass", async () => {
    makeTmpEngine({
      kanban: {
        createTask: vi.fn(),
        listTasks: vi.fn(async () => []),
      },
    });

    const workflow = makeCreateTasksPendingWorkflow({ dedup: true });
    engine.save(workflow);
    writePausedCreateTasksRun("run-create-tasks-safe-resume", workflow);

    const retrySpy = vi.spyOn(engine, "retryRun").mockResolvedValue({
      retryRunId: "retry-create-tasks-safe",
      resumed: true,
      ctx: { id: "retry-create-tasks-safe" },
    });

    await engine.resumeInterruptedRuns();

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(retrySpy).toHaveBeenCalledWith(
      "run-create-tasks-safe-resume",
      expect.objectContaining({
        mode: "from_failed",
        _decisionReason: "issue_advisor.resume_remaining",
        _resumeInterrupted: true,
      }),
    );
  });

  it("skips interrupted Create Tasks resume when idempotency checks fail", async () => {
    const createTask = vi.fn();
    makeTmpEngine({
      kanban: {
        createTask,
      },
    });

    const workflow = makeCreateTasksPendingWorkflow({ dedup: false });
    engine.save(workflow);
    writePausedCreateTasksRun("run-create-tasks-unsafe-resume", workflow);

    const retrySpy = vi.spyOn(engine, "retryRun").mockResolvedValue({
      retryRunId: "retry-create-tasks-unsafe",
      resumed: true,
      ctx: { id: "retry-create-tasks-unsafe" },
    });

    await engine.resumeInterruptedRuns();

    expect(retrySpy).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();

    const index = JSON.parse(readFileSync(join(tmpDir, "runs", "index.json"), "utf8"));
    const interrupted = index.runs.find((entry) => entry.runId === "run-create-tasks-unsafe-resume");
    expect(interrupted).toBeTruthy();
    expect(interrupted.resumable).toBe(true);
    expect(String(interrupted.resumeResult || "")).toMatch(/create_tasks_pending_guard/i);
    expect(String(interrupted.resumeResultMessage || "")).toContain("Interrupted-run resume is blocked");
    expect(String(interrupted.resumeResultMessage || "")).toContain("dedup is disabled on the Create Tasks node");
  });
});
