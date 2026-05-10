import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname, tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  WorkflowEngine,
  WorkflowContext,
  NodeStatus,
  WorkflowStatus,
  getWorkflowEngine,
  resetWorkflowEngine,
} from "../workflow/workflow-engine.mjs";
import { createHarnessSessionManager, getBosunSessionManager } from "../agent/session-manager.mjs";
import {
  registerNodeType,
  getNodeType,
} from "../workflow/workflow-nodes.mjs";
import {
  getApprovalRequest,
  resolveApprovalRequest,
} from "../workflow/approval-queue.mjs";
import { _resetSingleton as resetSessionTracker, getSessionTracker } from "../infra/session-tracker.mjs";

import { testTimeout } from "./timeout-helper.mjs";

vi.setConfig({ testTimeout: testTimeout(45_000) });

const SLOW_WORKFLOW_ENGINE_LOOP_DISPATCH_TEST_TIMEOUT_MS = testTimeout(45_000);
const SLOW_WORKFLOW_ENGINE_EXECUTE_WORKFLOW_SYNC_TEST_TIMEOUT_MS = testTimeout(30_000);
const SLOW_WORKFLOW_ENGINE_RUN_HISTORY_PAGINATION_TEST_TIMEOUT_MS = testTimeout(45_000);
const SLOW_WORKFLOW_ENGINE_CONCURRENCY_TEST_TIMEOUT_MS = testTimeout(60_000);
const SLOW_WORKFLOW_ENGINE_SESSION_CHAINING_TEST_TIMEOUT_MS = testTimeout(30_000);
const FAST_WORKFLOW_ENGINE_TIMER_CLEANUP_ASSERTION_MS = testTimeout(15_000);
const SLOW_WORKFLOW_ENGINE_TRACE_TIMEOUT_MS = testTimeout(30_000);

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir;
let engine;

function makeTmpEngine(services = {}) {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-engine-test-"));
  engine = new WorkflowEngine({
    workflowDir: join(tmpDir, "workflows"),
    runsDir: join(tmpDir, "runs"),
    services,
  });
  return engine;
}

function makeSimpleWorkflow(nodes, edges, opts = {}) {
  return {
    id: opts.id || "test-wf-" + Math.random().toString(36).slice(2, 8),
    name: opts.name || "Test Workflow",
    description: opts.description || "Test workflow for engine tests",
    enabled: true,
    nodes,
    edges,
    variables: opts.variables || {},
    metadata: opts.metadata,
  };
}

function makeCreateTasksPendingWorkflow({ dedup = true } = {}) {
  return makeSimpleWorkflow(
    [
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
    [
      { id: "e1", source: "trigger", target: "plan" },
      { id: "e2", source: "plan", target: "create-tasks" },
      { id: "e3", source: "create-tasks", target: "resume-work", condition: "approved" },
    ],
    {
      id: "pending-create-tasks",
      name: "Pending create tasks",
    }
  );
}

function buildStrictPlannerPayload(overrides = []) {
  const baseTasks = Array.from({ length: 8 }, (_, index) => ({
    title: `[m] fix(workflow): task ${index + 1}`,
    description: `Description ${index + 1}`,
    acceptance_criteria: [`AC ${index + 1}`],
    verification: [`Verify ${index + 1}`],
    repo_areas: ["workflow"],
    impact: 5 + index,
    confidence: 6 + index,
    risk: "low",
  }));
  for (const override of overrides) {
    if (override && typeof override === "object" && Number.isInteger(override.index) && baseTasks[override.index]) {
      baseTasks[override.index] = { ...baseTasks[override.index], ...override.patch };
      if (override.remove) {
        for (const field of override.remove) delete baseTasks[override.index][field];
      }
    }
  }
  return { tasks: baseTasks };
}

it("action.materialize_planner_tasks parses strict planner JSON and creates tasks", async () => {
  const handler = getNodeType("action.materialize_planner_tasks");
  expect(handler).toBeDefined();

  const payload = buildStrictPlannerPayload([{ index: 1, patch: { title: "[m] fix(workflow): duplicate title" } }]);
  const ctx = new WorkflowContext({
    workflowId: "wf-123",
    runId: "run-456",
  });
  ctx.setNodeOutput("run-planner", {
    output: [
      "Planner analysis complete.",
      "```json",
      JSON.stringify(payload, null, 2),
      "```",
    ].join("\n"),
  });

  const createTask = vi
    .fn(async function createTaskAdapter(projectId, taskData) {
      if (projectId && taskData) {
        return { id: `task-${taskData.title.split(" ").pop()}` };
      }
      return { id: "task-no-project" };
    });
  const listTasks = vi.fn().mockResolvedValue([
    { id: "existing-1", title: "[m] fix(workflow): duplicate title" },
  ]);
  const mockEngine = {
    services: {
      kanban: {
        createTask,
        listTasks,
      },
    },
  };

  const node = {
    id: "materialize",
    type: "action.materialize_planner_tasks",
    config: {
      plannerNodeId: "run-planner",
      projectId: "proj-123",
      status: "todo",
      failOnZero: true,
      dedup: true,
      minCreated: 1,
      exactTaskCount: 8,
      strictTaskPlannerSchema: true,
    },
  };
  const result = await handler.execute(node, ctx, mockEngine);

  expect(result.success).toBe(true);
  expect(result.parsedCount).toBe(8);
  expect(result.createdCount).toBe(7);
  expect(result.skippedCount).toBe(1);
  expect(result.created[0]).toEqual(expect.objectContaining({
    title: "[m] fix(workflow): task 1",
  }));
  expect(result.skipped).toEqual(expect.arrayContaining([
    expect.objectContaining({
      title: "[m] fix(workflow): duplicate title",
      reason: "duplicate_title",
      existingTaskId: "existing-1",
    }),
  ]));
  expect(listTasks).toHaveBeenCalledTimes(1);
  expect(createTask).toHaveBeenCalledTimes(7);
  expect(createTask).toHaveBeenNthCalledWith("1", "proj-123", expect.anything());
});

it("action.materialize_planner_tasks surfaces strict schema count errors before task creation", async () => {
  const handler = getNodeType("action.materialize_planner_tasks");
  const ctx = new WorkflowContext({});
  const invalidPayload = buildStrictPlannerPayload();
  invalidPayload.tasks.pop();
  ctx.setNodeOutput("run-planner", {
    output: JSON.stringify(invalidPayload),
  });

  const createTask = vi.fn();
  const listTasks = vi.fn();

  const node = {
    id: "materialize-invalid-count",
    type: "action.materialize_planner_tasks",
    config: {
      plannerNodeId: "run-planner",
      failOnZero: true,
      exactTaskCount: 8,
    },
  };

  await expect(handler.execute(node, ctx, { services: { kanban: { createTask, listTasks } } }))
    .rejects.toThrow(/requires exactly 8 tasks, but planner produced 7/i);
  expect(createTask).not.toHaveBeenCalled();
  expect(listTasks).not.toHaveBeenCalled();
  expect(ctx.logs.some((entry) => String(entry?.message || entry || "").includes("requires exactly 8 tasks"))).toBe(true);
});

it("action.materialize_planner_tasks surfaces strict schema field errors before task creation", async () => {
  const handler = getNodeType("action.materialize_planner_tasks");
  const ctx = new WorkflowContext({});
  const invalidPayload = buildStrictPlannerPayload([{ index: 3, remove: ["verification"] }]);
  ctx.setNodeOutput("run-planner", {
    output: JSON.stringify(invalidPayload),
  });

  const createTask = vi.fn();
  const listTasks = vi.fn();

  const node = {
    id: "materialize-invalid-field",
    type: "action.materialize_planner_tasks",
    config: {
      plannerNodeId: "run-planner",
      failOnZero: true,
      strictTaskPlannerSchema: true,
    },
  };

  await expect(handler.execute(node, ctx, { services: { kanban: { createTask, listTasks } } }))
    .rejects.toThrow(/tasks\[3\]\.verification is required/i);
  expect(createTask).not.toHaveBeenCalled();
  expect(listTasks).not.toHaveBeenCalled();
});

it("action.materialize_planner_tasks skips duplicate planner provenance on retry", async () => {
  const handler = getNodeType("action.materialize_planner_tasks");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({
    workflowId: "wf-dup",
    runId: "run-dup",
  });
  ctx.setNodeOutput("run-planner", {
    output: JSON.stringify({
      tasks: [
        {
          title: "[m] feat(workflow): duplicate from provenance",
          description: "Created in prior retry attempt",
          acceptance_criteria: ["ac1"],
          verification: ["v1"],
          repo_areas: ["workflow"],
          impact: 0.8,
          confidence: 0.7,
          risk: 0.2,
        },
      ],
    }),
  });

  const createTask = vi.fn();
  const listTasks = vi.fn().mockResolvedValue([
    {
      id: "existing-prov-1",
      title: "[m] feat(workflow): duplicate from provenance",
      meta: {
        planner: {
          dedupe_key: "wf-dup:run-dup:materialize:run-planner:0",
        },
      },
    },
  ]);

  const result = await handler.execute({
    id: "materialize",
    type: "action.materialize_planner_tasks",
    config: {
      plannerNodeId: "run-planner",
      dedup: true,
      failOnZero: false,
      minCreated: 0,
    },
  }, ctx, {
    services: {
      kanban: {
        createTask,
        listTasks,
      },
    },
  });

  expect(result.success).toBe(true);
