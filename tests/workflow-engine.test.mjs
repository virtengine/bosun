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

function makeIsolatedGitEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
  ]) {
    delete env[key];
  }
  return env;
}

function execGit(command, options = {}) {
  return execSync(command, {
    ...options,
    env: makeIsolatedGitEnv(options.env),
  });
}

async function removeDirWithRetries(dirPath, options = {}) {
  if (!dirPath) return;
  const ignoreFinalEperm = options?.ignoreFinalEperm === true;
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
  if (ignoreFinalEperm && lastError?.code === "EPERM") return;
  throw lastError;
}

// ── WorkflowContext Tests ───────────────────────────────────────────────────

describe("WorkflowContext", () => {
  it("initializes with data and tracks node outputs", () => {
    const ctx = new WorkflowContext({ foo: "bar" });
    expect(ctx.data.foo).toBe("bar");
    expect(ctx.nodeOutputs.size).toBe(0);
    expect(ctx.nodeStatuses.size).toBe(0);
    expect(ctx.logs).toEqual([]);
    expect(ctx.errors).toEqual([]);
  });

  it("tracks retry attempts", () => {
    const ctx = new WorkflowContext();
    expect(ctx.getRetryCount("node-1")).toBe(0);
    expect(ctx.incrementRetry("node-1")).toBe(1);
    expect(ctx.incrementRetry("node-1")).toBe(2);
    expect(ctx.getRetryCount("node-1")).toBe(2);
    expect(ctx.getRetryCount("node-2")).toBe(0);
  });

  it("fork() creates independent clone with upstream data", () => {
    const ctx = new WorkflowContext({ shared: "original" });
    ctx.setNodeOutput("upstream-1", { result: 42 });
    ctx.variables.v1 = "hello";

    const forked = ctx.fork({ item: "apple", _loopIndex: 0 });

    expect(forked.data.shared).toBe("original");
    expect(forked.data.item).toBe("apple");
    expect(forked.data._loopIndex).toBe(0);
    expect(forked.variables.v1).toBe("hello");
    // Can access upstream node outputs
    expect(forked.getNodeOutput("upstream-1")).toEqual({ result: 42 });

    // Mutations on forked do NOT affect original
    forked.data.shared = "mutated";
    expect(ctx.data.shared).toBe("original");
  });

  it("toJSON() includes retryAttempts", () => {
    const ctx = new WorkflowContext();
    ctx.incrementRetry("n1");
    ctx.incrementRetry("n1");
    const json = ctx.toJSON();
    expect(json.retryAttempts).toEqual({ n1: 2 });
    expect(json.nodeOutputs).toBeDefined();
    expect(json.nodeStatuses).toBeDefined();
  });

  it("condition.expression resolves template placeholders as JS literals", async () => {
    const nt = getNodeType("condition.expression");
    const ctx = new WorkflowContext({ churnThreshold: 10, expectedLabel: "Truncated" });
    ctx.setNodeOutput("hot-files", { maxChurn: "Truncated" });

    const stringResult = await nt.execute({
      id: "string-guard",
      config: { expression: "{{hot-files.maxChurn}} === {{expectedLabel}}" },
    }, ctx, engine);

    expect(stringResult).toEqual({ result: true, value: true });

    const numericResult = await nt.execute({
      id: "numeric-guard",
      config: { expression: "{{hot-files.maxChurn}} > {{churnThreshold}}" },
    }, ctx, engine);

    expect(numericResult).toEqual({ result: false, value: false });
  });

  it("preserves condition.expression templates through engine config resolution", async () => {
    registerNodeType("test.emit-churn-label", {
      describe: () => "Emit a string churn label",
      schema: { type: "object", properties: {} },
      async execute() {
        return { maxChurn: "Truncated" };
      },
    });

    const integrationRoot = mkdtempSync(join(tmpdir(), "wf-condition-expression-"));
    const integrationEngine = new WorkflowEngine({
      workflowDir: join(integrationRoot, "workflows"),
      runsDir: join(integrationRoot, "runs"),
      services: {},
    });
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "hot-files", type: "test.emit-churn-label", label: "Emit Churn", config: {} },
        {
          id: "expr",
          type: "condition.expression",
          label: "String-safe Churn Check",
          config: { expression: "{{hot-files.maxChurn}} === {{expectedLabel}}" },
        },
        { id: "matched", type: "notify.log", label: "Matched", config: { message: "matched" } },
      ],
      [
        { source: "trigger", target: "hot-files" },
        { source: "hot-files", target: "expr" },
        { source: "expr", target: "matched", port: "true" },
      ],
      { id: "wf-condition-expression-config", name: "Condition Expression Config Resolution" },
    );

    try {
      integrationEngine.save(wf);
      const ctx = await integrationEngine.execute(wf.id, { expectedLabel: "Truncated" });

      expect(ctx.errors).toEqual([]);
      expect(ctx.getNodeStatus("expr")).toBe(NodeStatus.COMPLETED);
      expect(ctx.getNodeOutput("expr")).toEqual(expect.objectContaining({ result: true, value: true }));
      expect(ctx.getNodeStatus("matched")).toBe(NodeStatus.COMPLETED);
    } finally {
      try { rmSync(integrationRoot, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("condition.expression allows benign identifiers that contain eval as a substring", async () => {
    const nt = getNodeType("condition.expression");
    const ctx = new WorkflowContext({ createFollowupTasks: true });
    ctx.setNodeOutput("evaluate-fitness", { output: "FOLLOW_UP_ACTION: tighten queue telemetry" });

    const result = await nt.execute({
      id: "followup-guard",
      config: {
        expression: "($data?.createFollowupTasks === true) && (($ctx.getNodeOutput('evaluate-fitness')?.output || '').includes('FOLLOW_UP_ACTION:'))",
      },
    }, ctx, engine);

    expect(result).toEqual({ result: true, value: true });
  });

  it("resolve() interpolates templates from data and node outputs", () => {
    const ctx = new WorkflowContext({ name: "Alice" });
    ctx.setNodeOutput("step1", { count: 5 });
    expect(ctx.resolve("Hello {{name}}")).toBe("Hello Alice");
    expect(ctx.resolve("Count: {{step1.count}}")).toBe("Count: 5");
    expect(ctx.resolve("{{missing}}")).toBe("{{missing}}");
    expect(ctx.resolve(42)).toBe(42); // Non-strings pass through
  });

  it("resolve() interpolates node outputs with hyphenated node IDs", () => {
    const ctx = new WorkflowContext();
    ctx.setNodeOutput("materialize-tasks", { createdCount: 3, skippedCount: 2 });
    expect(
      ctx.resolve("Created {{materialize-tasks.createdCount}} tasks (skipped {{materialize-tasks.skippedCount}})."),
    ).toBe("Created 3 tasks (skipped 2).");
    expect(ctx.resolve("{{materialize-tasks.createdCount}}")).toBe(3);
  });

  it("resolve() preserves raw value types for exact placeholders", () => {
    const ctx = new WorkflowContext({
      maxRetries: 3,
      dryRun: false,
      payload: { ok: true },
    });
    expect(ctx.resolve("{{maxRetries}}")).toBe(3);
    expect(ctx.resolve("{{dryRun}}")).toBe(false);
    expect(ctx.resolve("{{payload}}")).toEqual({ ok: true });
    // Embedded placeholders still resolve to strings
    expect(ctx.resolve("retries={{maxRetries}}")).toBe("retries=3");
  });
});

// ── Engine Retry Tests ──────────────────────────────────────────────────────

describe("WorkflowEngine - retry logic", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("retries a failing node up to maxRetries then fails", async () => {
    let callCount = 0;
    registerNodeType("test.flaky_always_fail", {
      describe: () => "Always fails for testing",
      schema: { type: "object", properties: {} },
      async execute() {
        callCount++;
        throw new Error("always fails");
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "flaky", type: "test.flaky_always_fail", label: "Flaky", config: { maxRetries: 2, retryDelayMs: 0 } },
      ],
      [{ id: "e1", source: "trigger", target: "flaky" }]
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    // 1 initial attempt + 2 retries = 3 total calls
    expect(callCount).toBe(3);
    // execute() returns a WorkflowContext — check errors array for failure
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("resolves templates inside array config values before node execution", async () => {
    registerNodeType("test.capture_config", {
      describe: () => "Capture resolved config",
      schema: { type: "object", properties: {} },
      async execute(node) {
        return { config: node.config };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "capture",
          type: "test.capture_config",
          label: "Capture",
          config: {
            ops: [
              { name: "one", value: "{{v1}}" },
              { name: "two", enabled: "{{flag}}" },
            ],
          },
        },
      ],
      [{ id: "e1", source: "trigger", target: "capture" }],
      { variables: { v1: 7, flag: true } },
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, {});
    const output = ctx.getNodeOutput("capture");
    expect(output?.config?.ops).toEqual([
      { name: "one", value: 7 },
      { name: "two", enabled: true },
    ]);
  });

  it("resolves edge condition templates from workflow variables", async () => {
    const reached = [];
    registerNodeType("test.record_branch", {
      describe: () => "Records reached branch",
      schema: { type: "object", properties: {} },
      async execute(node) {
        reached.push(node.id);
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "true-branch", type: "test.record_branch", label: "True", config: {} },
        { id: "false-branch", type: "test.record_branch", label: "False", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "true-branch", condition: "{{shouldRun}} === true" },
        { id: "e2", source: "trigger", target: "false-branch", condition: "{{shouldRun}} === false" },
      ],
      { variables: { shouldRun: true } },
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, {});
    expect(ctx.errors).toEqual([]);
    expect(reached).toEqual(["true-branch"]);
  });

  it("supports exact-placeholder boolean edge conditions", async () => {
    const reached = [];
    registerNodeType("test.record_flagged", {
      describe: () => "Records reached node",
      schema: { type: "object", properties: {} },
      async execute(node) {
        reached.push(node.id);
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "branch", type: "test.record_flagged", label: "Branch", config: {} },
      ],
      [{ id: "e1", source: "trigger", target: "branch", condition: "{{enabled}}" }],
      { variables: { enabled: true } },
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, {});
    expect(ctx.errors).toEqual([]);
    expect(reached).toEqual(["branch"]);
  });

  it("propagates skipped branch dependencies so converging false-path nodes can still run", async () => {
    const reached = [];
    registerNodeType("test.record_path", {
      describe: () => "Records execution order",
      schema: { type: "object", properties: {} },
      async execute(node) {
        reached.push(node.id);
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "skipped-branch", type: "test.record_path", label: "Skipped Branch", config: {} },
        { id: "converge", type: "test.record_path", label: "Converge", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "skipped-branch", condition: "false" },
        { id: "e2", source: "trigger", target: "converge", condition: "true" },
        { id: "e3", source: "skipped-branch", target: "converge" },
      ],
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, {});

    expect(ctx.errors).toEqual([]);
    expect(ctx.getNodeStatus("skipped-branch")).toBe("skipped");
    expect(reached).toEqual(["converge"]);
  });

  it("retries then succeeds on second attempt", async () => {
    let callCount = 0;
    registerNodeType("test.flaky_second_try", {
      describe: () => "Fails first, succeeds second",
      schema: { type: "object", properties: {} },
      async execute() {
        callCount++;
        if (callCount < 2) throw new Error("first try fails");
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "retry-node", type: "test.flaky_second_try", label: "Retry Me", config: { maxRetries: 3, retryDelayMs: 0 } },
      ],
      [{ id: "e1", source: "trigger", target: "retry-node" }]
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(callCount).toBe(2);
    expect(result.errors.length).toBe(0);
  });

  it("skips retry when retryable is false", async () => {
    let callCount = 0;
    registerNodeType("test.no_retry", {
      describe: () => "Fails, no retry allowed",
      schema: { type: "object", properties: {} },
      async execute() {
        callCount++;
        throw new Error("no retry");
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "fail", type: "test.no_retry", label: "No Retry", config: { retryable: false } },
      ],
      [{ id: "e1", source: "trigger", target: "fail" }]
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(callCount).toBe(1);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("emits node:retry events", async () => {
    let retryEvents = [];
    let callCount = 0;
    registerNodeType("test.retry_events", {
      describe: () => "Fails twice then passes",
      schema: { type: "object", properties: {} },
      async execute() {
        callCount++;
        if (callCount <= 2) throw new Error("try again");
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "retry-node", type: "test.retry_events", label: "Retry", config: { maxRetries: 3, retryDelayMs: 0 } },
      ],
      [{ id: "e1", source: "trigger", target: "retry-node" }]
    );

    engine.save(wf);
    engine.on("node:retry", (ev) => retryEvents.push(ev));
    await engine.execute(wf.id, {});
    expect(retryEvents.length).toBe(2);
    expect(retryEvents[0].attempt).toBe(1);
    expect(retryEvents[1].attempt).toBe(2);
  });
});

// ── Engine Loop Iteration Tests ─────────────────────────────────────────────

describe("WorkflowEngine - loop.for_each", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("actually iterates downstream nodes per item", async () => {
    const executed = [];
    registerNodeType("test.collect_item", {
      describe: () => "Collects item from context",
      schema: { type: "object", properties: {} },
      async execute(node, ctx) {
        const item = ctx.data.item;
        executed.push(item);
        return { collected: item };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "loop", type: "loop.for_each", label: "Loop Items", config: { items: '["a","b","c"]', variable: "item" } },
        { id: "collect", type: "test.collect_item", label: "Collect", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "loop" },
        { id: "e2", source: "loop", target: "collect" },
      ]
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(result.errors.length).toBe(0);
    expect(executed).toEqual(["a", "b", "c"]);
  }, SLOW_WORKFLOW_ENGINE_LOOP_DISPATCH_TEST_TIMEOUT_MS);

  it("emits loop:iteration events", async () => {
    const iterations = [];
    registerNodeType("test.noop_loop", {
      describe: () => "Noop",
      schema: { type: "object", properties: {} },
      async execute() { return { ok: true }; },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "loop", type: "loop.for_each", label: "Loop", config: { items: '[1,2]', variable: "item" } },
        { id: "body", type: "test.noop_loop", label: "Body", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "loop" },
        { id: "e2", source: "loop", target: "body" },
      ]
    );

    engine.save(wf);
    engine.on("loop:iteration", (ev) => iterations.push(ev));
    await engine.execute(wf.id, {});
    expect(iterations.length).toBe(2);
    expect(iterations[0]).toEqual({ nodeId: "loop", index: 0, total: 2 });
    expect(iterations[1]).toEqual({ nodeId: "loop", index: 1, total: 2 });
  }, SLOW_WORKFLOW_ENGINE_LOOP_DISPATCH_TEST_TIMEOUT_MS);

  it("returns totalItems alongside count for batch summary templates", async () => {
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "loop", type: "loop.for_each", label: "Loop Items", config: { items: '["a","b","c"]', variable: "item" } },
      ],
      [{ id: "e1", source: "trigger", target: "loop" }],
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, {});
    expect(ctx.errors).toEqual([]);
    expect(ctx.getNodeOutput("loop")).toMatchObject({
      count: 3,
      totalItems: 3,
      successCount: 3,
      failCount: 0,
    });
  }, SLOW_WORKFLOW_ENGINE_LOOP_DISPATCH_TEST_TIMEOUT_MS);

  it("dispatches child workflows without waiting for completion when mode=dispatch", async () => {
    let releaseRuns;
    const blocker = new Promise((resolve) => {
      releaseRuns = resolve;
    });
    let startedCount = 0;
    let startedTwo;
    const twoStarted = new Promise((resolve) => {
      startedTwo = resolve;
    });

    registerNodeType("test.long_running_loop_child", {
      describe: () => "Long running child node for loop dispatch mode",
      schema: { type: "object", properties: {} },
      async execute(node, ctx) {
        ctx.log(node.id, "loop child entered");
        startedCount += 1;
        if (startedCount >= 2) startedTwo();
        await blocker;
        return { ok: true };
      },
    });

    const child = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Child Start", config: {} },
        { id: "wait", type: "test.long_running_loop_child", label: "Child Wait", config: {} },
      ],
      [{ id: "c1", source: "trigger", target: "wait" }],
      { id: "child-loop-dispatch", name: "Child Loop Dispatch" },
    );

    const parent = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "loop",
          type: "loop.for_each",
          label: "Dispatch Items",
          config: {
            items: "[1,2]",
            variable: "item",
            workflowId: child.id,
            mode: "dispatch",
            maxConcurrent: 2,
          },
        },
      ],
      [{ id: "p1", source: "trigger", target: "loop" }],
      { id: "parent-loop-dispatch", name: "Parent Loop Dispatch" },
    );

    engine.save(child);
    engine.save(parent);
    const ctx = await engine.execute(parent.id, {});
    expect(ctx.errors).toEqual([]);
    expect(ctx.getNodeOutput("loop")).toMatchObject({
      count: 2,
      successCount: 2,
      failCount: 0,
    });
    expect(ctx.getNodeOutput("loop").results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ queued: true, mode: "dispatch", workflowId: child.id }),
      ]),
    );

    await twoStarted;
    const history = engine.getRunHistory(child.id, 10);
    expect(history.filter((entry) => entry.status === WorkflowStatus.RUNNING).length).toBeGreaterThanOrEqual(2);

    releaseRuns();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }, SLOW_WORKFLOW_ENGINE_LOOP_DISPATCH_TEST_TIMEOUT_MS);

  it("promotes task identity from loop item payloads into dispatched child workflows", async () => {
    const observed = [];
    registerNodeType("test.capture_task_dispatch_context", {
      describe: () => "Capture dispatched child workflow task context",
      schema: { type: "object", properties: {} },
      async execute(_node, childCtx) {
        observed.push({
          taskId: childCtx.data?.taskId || null,
          taskTitle: childCtx.data?.taskTitle || null,
          branch: childCtx.data?.branch || null,
          repository: childCtx.data?.repository || null,
          workspace: childCtx.data?.workspace || null,
          currentTaskId: childCtx.data?.currentTask?.taskId || null,
          taskObjectId: childCtx.data?.task?.id || null,
          rootTaskId: childCtx.data?._workflowRootTaskId || null,
        });
        return { ok: true };
      },
    });

    const child = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Child Start", config: {} },
        { id: "capture", type: "test.capture_task_dispatch_context", label: "Capture", config: {} },
      ],
      [{ id: "c1", source: "trigger", target: "capture" }],
      { id: "child-loop-task-context", name: "Child Loop Task Context" },
    );

    const parent = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "loop",
          type: "loop.for_each",
          label: "Dispatch Task Items",
          config: {
            items: "$data.items",
            variable: "currentTask",
            workflowId: child.id,
            mode: "dispatch",
            maxConcurrent: 2,
          },
        },
      ],
      [{ id: "p1", source: "trigger", target: "loop" }],
      { id: "parent-loop-task-context", name: "Parent Loop Task Context" },
    );

    engine.save(child);
    engine.save(parent);

    const ctx = await engine.execute(parent.id, {
      items: [
        {
          taskId: "task-loop-1",
          taskTitle: "Loop Task 1",
          branch: "task/loop-1",
          repository: "virtengine/bosun",
          workspace: "virtengine-gh",
        },
      ],
    });
    expect(ctx.errors).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(observed).toEqual([
      expect.objectContaining({
        taskId: "task-loop-1",
        taskTitle: "Loop Task 1",
        branch: "task/loop-1",
        repository: "virtengine/bosun",
        workspace: "virtengine-gh",
        currentTaskId: "task-loop-1",
        taskObjectId: "task-loop-1",
        rootTaskId: "task-loop-1",
      }),
    ]);

    const history = engine.getRunHistory(child.id, 5);
    expect(history[0]).toMatchObject({
      taskId: "task-loop-1",
      taskTitle: "Loop Task 1",
    });
    expect(history[0]?.taskIds || []).toContain("task-loop-1");
  }, SLOW_WORKFLOW_ENGINE_LOOP_DISPATCH_TEST_TIMEOUT_MS);

  it("keeps task identity isolated across concurrent loop dispatch items", async () => {
    const observed = [];
    registerNodeType("test.capture_multi_task_dispatch_context", {
      describe: () => "Capture task context for concurrent loop dispatch",
      schema: { type: "object", properties: {} },
      async execute(_node, childCtx) {
        observed.push({
          taskId: childCtx.data?.taskId || null,
          taskTitle: childCtx.data?.taskTitle || null,
          currentTaskId: childCtx.data?.currentTask?.taskId || null,
          branch: childCtx.data?.branch || null,
          rootTaskId: childCtx.data?._workflowRootTaskId || null,
        });
        return { ok: true };
      },
    });

    const child = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Child Start", config: {} },
        { id: "capture", type: "test.capture_multi_task_dispatch_context", label: "Capture", config: {} },
      ],
      [{ id: "c1", source: "trigger", target: "capture" }],
      { id: "child-multi-task-context", name: "Child Multi Task Context" },
    );

    const parent = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "loop",
          type: "loop.for_each",
          label: "Dispatch Task Items",
          config: {
            items: "$data.items",
            variable: "currentTask",
            workflowId: child.id,
            mode: "dispatch",
            maxConcurrent: 2,
          },
        },
      ],
      [{ id: "p1", source: "trigger", target: "loop" }],
      { id: "parent-multi-task-context", name: "Parent Multi Task Context" },
    );

    engine.save(child);
    engine.save(parent);

    const ctx = await engine.execute(parent.id, {
      items: [
        {
          taskId: "task-loop-a",
          taskTitle: "Loop Task A",
          branch: "task/loop-a",
        },
        {
          taskId: "task-loop-b",
          taskTitle: "Loop Task B",
          branch: "task/loop-b",
        },
      ],
    });
    expect(ctx.errors).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: "task-loop-a",
        taskTitle: "Loop Task A",
        currentTaskId: "task-loop-a",
        branch: "task/loop-a",
        rootTaskId: "task-loop-a",
      }),
      expect.objectContaining({
        taskId: "task-loop-b",
        taskTitle: "Loop Task B",
        currentTaskId: "task-loop-b",
        branch: "task/loop-b",
        rootTaskId: "task-loop-b",
      }),
    ]));
  }, SLOW_WORKFLOW_ENGINE_LOOP_DISPATCH_TEST_TIMEOUT_MS);

  it("overrides inherited parent task context with per-item loop task identity", async () => {
    const observed = [];
    registerNodeType("test.capture_inherited_task_override", {
      describe: () => "Capture child task lineage when parent already has task context",
      schema: { type: "object", properties: {} },
      async execute(_node, childCtx) {
        observed.push({
          taskId: childCtx.data?.taskId || null,
          branchName: childCtx.data?.branchName || null,
          currentTaskId: childCtx.data?.currentTask?.taskId || null,
          rootTaskId: childCtx.data?._workflowRootTaskId || null,
          parentTaskId: childCtx.data?._workflowParentTaskId || null,
          parentSessionId: childCtx.data?._workflowParentSessionId || null,
          rootSessionId: childCtx.data?._workflowRootSessionId || null,
        });
        return { ok: true };
      },
    });

    const child = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Child Start", config: {} },
        { id: "capture", type: "test.capture_inherited_task_override", label: "Capture", config: {} },
      ],
      [{ id: "c1", source: "trigger", target: "capture" }],
      { id: "child-inherited-task-override", name: "Child Inherited Task Override" },
    );

    const parent = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "loop",
          type: "loop.for_each",
          label: "Dispatch Task Items",
          config: {
            items: "$data.items",
            variable: "currentTask",
            workflowId: child.id,
            mode: "dispatch",
            maxConcurrent: 2,
          },
        },
      ],
      [{ id: "p1", source: "trigger", target: "loop" }],
      { id: "parent-inherited-task-override", name: "Parent Inherited Task Override" },
    );

    engine.save(child);
    engine.save(parent);

    const ctx = await engine.execute(parent.id, {
      taskId: "parent-task",
      branchName: "task/parent-task",
      _workflowRootTaskId: "parent-task",
      _workflowParentTaskId: "parent-task",
      _workflowParentSessionId: "parent-task",
      _workflowRootSessionId: "parent-task",
      items: [
        {
          taskId: "child-task-1",
          taskTitle: "Child Task 1",
          branch: "task/child-task-1",
        },
      ],
    });
    expect(ctx.errors).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(observed).toEqual([
      expect.objectContaining({
        taskId: "child-task-1",
        branchName: "task/child-task-1",
        currentTaskId: "child-task-1",
        rootTaskId: "child-task-1",
        parentTaskId: "child-task-1",
        parentSessionId: "child-task-1",
        rootSessionId: "child-task-1",
      }),
    ]);

    const history = engine.getRunHistory(child.id, 5);
    expect(history[0]).toMatchObject({
      taskId: "child-task-1",
      taskTitle: "Child Task 1",
    });
  }, SLOW_WORKFLOW_ENGINE_LOOP_DISPATCH_TEST_TIMEOUT_MS);

  it("does not inherit parent branch context when loop child task omits branch metadata", async () => {
    const observed = [];
    registerNodeType("test.capture_child_branch_isolation", {
      describe: () => "Capture branch context for task-dispatched loop child",
      schema: { type: "object", properties: {} },
      async execute(_node, childCtx) {
        observed.push({
          taskId: childCtx.data?.taskId || null,
          branch: childCtx.data?.branch || null,
          branchName: childCtx.data?.branchName || null,
          rootTaskId: childCtx.data?._workflowRootTaskId || null,
        });
        return { ok: true };
      },
    });

    const child = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Child Start", config: {} },
        { id: "capture", type: "test.capture_child_branch_isolation", label: "Capture", config: {} },
      ],
      [{ id: "c1", source: "trigger", target: "capture" }],
      { id: "child-branch-isolation", name: "Child Branch Isolation" },
    );

    const parent = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "loop",
          type: "loop.for_each",
          label: "Dispatch Task Items",
          config: {
            items: "$data.items",
            variable: "currentTask",
            workflowId: child.id,
            mode: "dispatch",
            maxConcurrent: 1,
          },
        },
      ],
      [{ id: "p1", source: "trigger", target: "loop" }],
      { id: "parent-branch-isolation", name: "Parent Branch Isolation" },
    );

    engine.save(child);
    engine.save(parent);

    const ctx = await engine.execute(parent.id, {
      taskId: "parent-task",
      branch: "task/parent-task",
      branchName: "task/parent-task",
      _workflowRootTaskId: "parent-task",
      _workflowParentTaskId: "parent-task",
      items: [
        {
          taskId: "child-task-branchless",
          taskTitle: "Child Task Branchless",
        },
      ],
    });
    expect(ctx.errors).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(observed).toEqual([
      {
        taskId: "child-task-branchless",
        branch: null,
        branchName: null,
        rootTaskId: "child-task-branchless",
      },
    ]);
  }, SLOW_WORKFLOW_ENGINE_LOOP_DISPATCH_TEST_TIMEOUT_MS);

  it("counts only allocated task lifecycle slots during loop dispatch fan-out", async () => {
    let startedCount = 0;
    let releaseRuns;
    const twoStarted = new Promise((resolve) => {
      registerNodeType("test.slot_gate_wait", {
        describe: () => "Hold a workflow slot open until released",
        schema: { type: "object", properties: {} },
        async execute() {
          startedCount += 1;
          if (startedCount >= 2) resolve();
          await new Promise((innerResolve) => {
            releaseRuns = innerResolve;
          });
          return { ok: true };
        },
      });
    });

    const child = makeSimpleWorkflow(
      [
        {
          id: "trigger",
          type: "trigger.task_available",
          label: "Direct Task",
          config: { maxParallel: 2, status: "todo" },
        },
        {
          id: "check-slots",
          type: "condition.slot_available",
          label: "Slots Available?",
          config: { maxParallel: 2 },
        },
        {
          id: "allocate-slot",
          type: "action.allocate_slot",
          label: "Allocate Slot",
          config: {
            taskId: "{{taskId}}",
            taskTitle: "{{taskTitle}}",
            branch: "{{branch}}",
            baseBranch: "{{baseBranch}}",
          },
        },
        {
          id: "wait",
          type: "test.slot_gate_wait",
          label: "Wait",
          config: {},
        },
        {
          id: "release-slot",
          type: "action.release_slot",
          label: "Release Slot",
          config: { taskId: "{{taskId}}" },
        },
      ],
      [
        { id: "c1", source: "trigger", target: "check-slots" },
        {
          id: "c2",
          source: "check-slots",
          target: "allocate-slot",
          condition: "$output?.result === true",
        },
        { id: "c3", source: "allocate-slot", target: "wait" },
        { id: "c4", source: "wait", target: "release-slot" },
      ],
      { id: "child-slot-gate-workflow", name: "Task Lifecycle" },
    );

    const parent = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "loop",
          type: "loop.for_each",
          label: "Dispatch Tasks",
          config: {
            items: "$data.items",
            variable: "currentTask",
            workflowId: child.id,
            mode: "dispatch",
            maxConcurrent: 4,
          },
        },
      ],
      [{ id: "p1", source: "trigger", target: "loop" }],
      { id: "parent-slot-gate-workflow", name: "Parent Slot Gate Workflow" },
    );

    engine.save(child);
    engine.save(parent);

    const ctx = await engine.execute(parent.id, {
      items: [
        { taskId: "slot-task-1", taskTitle: "Slot Task 1", branch: "task/slot-1" },
        { taskId: "slot-task-2", taskTitle: "Slot Task 2", branch: "task/slot-2" },
        { taskId: "slot-task-3", taskTitle: "Slot Task 3", branch: "task/slot-3" },
        { taskId: "slot-task-4", taskTitle: "Slot Task 4", branch: "task/slot-4" },
      ],
    });
    expect(ctx.errors).toEqual([]);

    await twoStarted;

    const history = engine.getRunHistory(child.id, 10);
    const runningRuns = history.filter((entry) => entry.status === WorkflowStatus.RUNNING);
    const completedRuns = history.filter((entry) => entry.status === WorkflowStatus.COMPLETED);

    expect(runningRuns).toHaveLength(2);
    expect(completedRuns).toHaveLength(2);

    for (const entry of completedRuns) {
      const run = engine.getRunDetail(entry.runId);
      expect(run?.detail?.nodeOutputs?.["check-slots"]).toMatchObject({
        result: false,
        slotsAvailable: false,
        activeSlotCount: 2,
        maxParallel: 2,
      });
      expect(run?.detail?.nodeStatuses?.["allocate-slot"]).toBe(NodeStatus.SKIPPED);
    }

    releaseRuns();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }, SLOW_WORKFLOW_ENGINE_LOOP_DISPATCH_TEST_TIMEOUT_MS);

});

describe("WorkflowEngine - source port routing", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("routes only the selected switch port", async () => {
    const visited = [];
    registerNodeType("test.capture_port", {
      describe: () => "Capture reached branch",
      schema: { type: "object", properties: {} },
      async execute(node) {
        visited.push(node.id);
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "switch",
          type: "condition.switch",
          label: "Switch",
          config: {
            value: "'left'",
            cases: {
              left: "left-port",
              right: "right-port",
            },
          },
        },
        { id: "left", type: "test.capture_port", label: "Left", config: {} },
        { id: "right", type: "test.capture_port", label: "Right", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "switch" },
        { id: "e2", source: "switch", target: "left", sourcePort: "left-port" },
        { id: "e3", source: "switch", target: "right", sourcePort: "right-port" },
      ],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(result.errors).toEqual([]);
    expect(visited).toEqual(["left"]);
  });

  it("keeps shared downstream nodes runnable when one conditional edge is false", async () => {
    const visited = [];
    registerNodeType("test.capture_multi_edge", {
      describe: () => "Capture multi-edge convergence",
      schema: { type: "object", properties: {} },
      async execute(node) {
        visited.push(node.id);
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "branch", type: "notify.log", label: "Branch", config: { message: "branch" } },
        { id: "shared", type: "test.capture_multi_edge", label: "Shared", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "branch" },
        { id: "e2", source: "branch", target: "shared", condition: "false" },
        { id: "e3", source: "branch", target: "shared", condition: "true" },
      ],
      { name: "Conditional Convergence Workflow" },
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(result.errors).toEqual([]);
    expect(visited).toEqual(["shared"]);
    expect(result.getNodeStatus("shared")).toBe(NodeStatus.COMPLETED);
  });

  it("preserves mixed legacy and explicit port graphs during execution", async () => {
    const visited = [];
    registerNodeType("test.capture_mixed_ports", {
      describe: () => "Capture mixed legacy/explicit routing",
      schema: { type: "object", properties: {} },
      async execute(node) {
        visited.push(node.id);
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "switch",
          type: "condition.switch",
          label: "Switch",
          config: {
            value: "'left'",
            cases: {
              left: "left-port",
              right: "right-port",
            },
          },
        },
        { id: "left", type: "test.capture_mixed_ports", label: "Left", config: {} },
        { id: "audit", type: "test.capture_mixed_ports", label: "Audit", config: {} },
        { id: "right", type: "test.capture_mixed_ports", label: "Right", config: {} },
      ],
      [
        { id: "legacy-trigger", source: "trigger", target: "switch" },
        { id: "explicit-left", source: "switch", target: "left", sourcePort: "left-port" },
        { id: "legacy-audit", source: "trigger", target: "audit" },
        { id: "explicit-right", source: "switch", target: "right", sourcePort: "right-port" },
      ],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(result.errors).toEqual([]);
    expect(visited.sort()).toEqual(["audit", "left"]);
  });

  it("falls back to default edges when a node emits an unmatched custom port", async () => {
    const visited = [];

    registerNodeType("test.unmatched_port_source", {
      describe: () => "Emit a non-default port without a matching edge",
      schema: { type: "object", properties: {} },
      outputs: [
        { name: "default", type: "Any" },
        { name: "error", type: "JSON" },
      ],
      async execute() {
        visited.push("source");
        return {
          ok: false,
          matchedPort: "error",
          port: "error",
        };
      },
    });

    registerNodeType("test.unmatched_port_fallback", {
      describe: () => "Capture fallback routing from default edges",
      schema: { type: "object", properties: {} },
      async execute() {
        visited.push("fallback");
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "source", type: "test.unmatched_port_source", label: "Source", config: {} },
        { id: "fallback", type: "test.unmatched_port_fallback", label: "Fallback", config: {} },
      ],
      [
        { id: "start", source: "trigger", target: "source" },
        { id: "default-fallback", source: "source", target: "fallback" },
      ],
      { name: "Unmatched Custom Port Fallback Workflow" },
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});

    expect(result.errors).toEqual([]);
    expect(visited).toEqual(["source", "fallback"]);
    expect(result.getNodeStatus("fallback")).toBe(NodeStatus.COMPLETED);
  });

  it("rejects unknown explicit source and target ports before execution", () => {
    registerNodeType("test.port_source", {
      describe: () => "Source node with explicit ports",
      schema: { type: "object", properties: {} },
      outputs: [
        { name: "default", type: "Any" },
        { name: "success", type: "JSON" },
      ],
      async execute() {
        return { ok: true, matchedPort: "success", port: "success" };
      },
    });

    registerNodeType("test.port_target", {
      describe: () => "Target node with explicit ports",
      schema: { type: "object", properties: {} },
      inputs: [
        { name: "default", type: "Any" },
        { name: "payload", type: "JSON" },
      ],
      async execute() {
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "source", type: "test.port_source", label: "Source", config: {} },
        { id: "target", type: "test.port_target", label: "Target", config: {} },
      ],
      [
        { id: "legacy-start", source: "trigger", target: "source" },
        {
          id: "invalid-binding",
          source: "source",
          target: "target",
          sourcePort: "missing-output",
          targetPort: "missing-input",
        },
      ],
    );

    expect(() => engine.save(wf)).toThrow(/Workflow port validation failed/i);
    expect(() => engine.save(wf)).toThrow(/missing-output/i);
    expect(() => engine.save(wf)).toThrow(/missing-input/i);
  });

  it("honors explicit source port mappings across branch and back-edge retries", async () => {
    const visitLog = [];

    registerNodeType("test.branch_with_retry", {
      describe: () => "Branches between retry and done ports",
      schema: { type: "object", properties: {} },
      outputs: [
        { name: "retry", label: "Retry", type: "JSON" },
        { name: "done", label: "Done", type: "JSON" },
      ],
      async execute(_node, ctx) {
        const attempt = Number(ctx.data.branchAttempt || 0) + 1;
        ctx.data.branchAttempt = attempt;
        visitLog.push(`branch:${attempt}`);
        return {
          ok: true,
          attempt,
          matchedPort: attempt === 1 ? "retry" : "done",
          port: attempt === 1 ? "retry" : "done",
        };
      },
    });

    registerNodeType("test.capture_retry_branch", {
      describe: () => "Retry branch marker",
      schema: { type: "object", properties: {} },
      async execute() {
        visitLog.push("review");
        return { ok: true };
      },
    });

    registerNodeType("test.capture_done_branch", {
      describe: () => "Done branch marker",
      schema: { type: "object", properties: {} },
      async execute() {
        visitLog.push("complete");
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "branch", type: "test.branch_with_retry", label: "Branch", config: {} },
        { id: "review", type: "test.capture_retry_branch", label: "Review", config: {} },
        { id: "complete", type: "test.capture_done_branch", label: "Complete", config: {} },
      ],
      [
        { id: "start", source: "trigger", target: "branch" },
        { id: "retry-path", source: "branch", target: "review", sourcePort: "retry" },
        { id: "retry-loop", source: "review", target: "branch", backEdge: true },
        { id: "done-path", source: "branch", target: "complete", sourcePort: "done" },
      ],
      { name: "Explicit Port Back Edge Workflow" },
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});

    expect(result.errors).toEqual([]);
    expect(visitLog).toEqual(["branch:1", "review", "branch:2", "complete"]);
    expect(result.getNodeStatus("review")).toBe(NodeStatus.COMPLETED);
    expect(result.getNodeStatus("complete")).toBe(NodeStatus.COMPLETED);
  });
  it("accepts legacy condition port aliases alongside explicit yes/no routing", () => {
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "guard",
          type: "condition.expression",
          label: "Guard",
          config: { expression: "true" },
        },
        { id: "default-path", type: "notify.log", label: "Default", config: { message: "default" } },
        { id: "yes-path", type: "notify.log", label: "Yes", config: { message: "yes" } },
        { id: "no-path", type: "notify.log", label: "No", config: { message: "no" } },
      ],
      [
        { id: "e1", source: "trigger", target: "guard" },
        { id: "e2", source: "guard", target: "default-path" },
        { id: "e3", source: "guard", target: "yes-path", sourcePort: "true" },
        { id: "e4", source: "guard", target: "no-path", sourcePort: "false" },
      ],
    );

    expect(() => engine.save(wf)).not.toThrow();
  });

  it("infers transform.llm_parse ports from configured output fields", () => {
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "src", type: "transform.template", label: "Source", config: { template: "VERDICT: CORRECT" } },
        {
          id: "parse",
          type: "transform.llm_parse",
          label: "Parse Verdict",
          config: {
            input: "src",
            patterns: { verdict: "VERDICT:\\s*(CORRECT|MINOR|CRITICAL)" },
            outputPort: "verdict",
          },
        },
        { id: "done", type: "notify.log", label: "Done", config: { message: "done" } },
        { id: "retry", type: "notify.log", label: "Retry", config: { message: "retry" } },
      ],
      [
        { id: "e1", source: "trigger", target: "src" },
        { id: "e2", source: "src", target: "parse" },
        { id: "e3", source: "parse", target: "done", sourcePort: "correct" },
        { id: "e4", source: "parse", target: "retry", sourcePort: "minor" },
      ],
    );

    expect(() => engine.save(wf)).not.toThrow();
  });

  it("rejects executing loaded workflows that still carry invalid explicit ports", async () => {
    registerNodeType("test.execute_port_source", {
      describe: () => "Source node with explicit ports",
      schema: { type: "object", properties: {} },
      outputs: [{ name: "success", type: "JSON" }],
      async execute() {
        return { ok: true, matchedPort: "success", port: "success" };
      },
    });

    registerNodeType("test.execute_port_target", {
      describe: () => "Target node with explicit ports",
      schema: { type: "object", properties: {} },
      inputs: [{ name: "payload", type: "JSON" }],
      async execute() {
        return { ok: true };
      },
    });

    const workflowId = "wf-invalid-execute-port-bindings";
    const persisted = {
      id: workflowId,
      name: "Invalid Execute Port Bindings",
      enabled: true,
      nodes: [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "source", type: "test.execute_port_source", label: "Source", config: {} },
        { id: "target", type: "test.execute_port_target", label: "Target", config: {} },
      ],
      edges: [
        { id: "legacy-start", source: "trigger", target: "source" },
        {
          id: "invalid-binding",
          source: "source",
          target: "target",
          sourcePort: "missing-output",
          targetPort: "missing-input",
        },
      ],
      metadata: {},
      variables: {},
    };

    mkdirSync(join(tmpDir, "workflows"), { recursive: true });
    writeFileSync(join(tmpDir, "workflows", workflowId + ".json"), JSON.stringify(persisted, null, 2));
    engine.load();

    await expect(engine.execute(workflowId, {})).rejects.toThrow(/Workflow port validation failed/i);
    await expect(engine.execute(workflowId, {})).rejects.toThrow(/missing-output/i);
  });

});

// ── Run History / Detail Tests ──────────────────────────────────────────────

describe("WorkflowEngine - run history details", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("persists rich summary metadata and exposes detailed run payload", async () => {
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "log", type: "notify.log", label: "Log", config: { message: "hello from history test" } },
      ],
      [{ id: "e1", source: "trigger", target: "log" }],
      { name: "History Detail Workflow" }
    );

    engine.save(wf);
    await engine.execute(wf.id, {
      taskId: "task-history-1",
      taskTitle: "History Detail Task",
      sessionId: "session-history-1",
    });

    const history = engine.getRunHistory(wf.id, 5);
    expect(history.length).toBeGreaterThan(0);
    const latest = history[0];
    expect(latest.workflowName).toBe("History Detail Workflow");
    expect(typeof latest.endedAt).toBe("number");
    expect(typeof latest.logCount).toBe("number");
    expect(typeof latest.completedCount).toBe("number");
    expect(typeof latest.lastProgressAt).toBe("number");
    expect(typeof latest.lastLogAt).toBe("number");
    expect(typeof latest.activeNodeCount).toBe("number");
    expect(latest.isStuck).toBe(false);
    expect(latest.stuckMs).toBe(0);
    expect(latest.taskId).toBe("task-history-1");
    expect(latest.taskIds).toContain("task-history-1");
    expect(latest.taskTitle).toBe("History Detail Task");
    expect(latest.sessionId).toBe("session-history-1");
    expect(latest.primarySessionId).toBe("session-history-1");
    expect(latest.sessionIds).toContain("session-history-1");

    const run = engine.getRunDetail(latest.runId);
    expect(run).toBeTruthy();
    expect(run.workflowId).toBe(wf.id);
    expect(run.workflowName).toBe("History Detail Workflow");
    expect(run.detail).toBeTruthy();
    expect(run.detail.nodeStatuses.trigger).toBeDefined();
    expect(run.detail.nodeStatuses.log).toBeDefined();
    expect(Array.isArray(run.detail.logs)).toBe(true);
    expect(Array.isArray(run.detail.nodeStatusEvents)).toBe(true);
    expect(run.detail.dagState?.workflowId).toBe(wf.id);
    expect(run.detail.dagState?.counts?.completed).toBeGreaterThanOrEqual(2);
    expect(run.ledger?.events?.some((event) => event.eventType === "run.start")).toBe(true);
    expect(run.ledger?.events?.some((event) => event.eventType === "node.completed")).toBe(true);
    expect(run.ledger?.events?.some((event) => event.eventType === "run.end")).toBe(true);
  });

  it("allows notify.telegram to degrade gracefully when telegram service is missing", async () => {
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "notify", type: "notify.telegram", label: "Notify", config: { message: "hello" } },
      ],
      [{ id: "e1", source: "trigger", target: "notify" }],
      { name: "Telegram Fallback Workflow" },
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, {});

    expect(ctx.errors).toEqual([]);
    expect(ctx.getNodeStatus("notify")).toBe(NodeStatus.COMPLETED);
    expect(ctx.getNodeOutput("notify")).toEqual({
      sent: false,
      reason: "no_telegram",
    });
  });

  it("fails run persistence when task identity fields still contain unresolved template tokens", async () => {
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "log", type: "notify.log", label: "Log", config: { message: "identity validation" } },
      ],
      [{ id: "e1", source: "trigger", target: "log" }],
      { name: "Identity Validation Workflow" },
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, {
      taskId: "{{taskId}}",
      taskTitle: "{{taskTitle}}",
      branchName: "{{branch}}",
      task: {
        id: "{{taskId}}",
        title: "{{taskTitle}}",
        branchName: "{{branch}}",
      },
    });

    const historyEntry = engine.getRunHistory(wf.id, 1)[0];
    expect(historyEntry?.runId).toBe(ctx.id);
    expect(historyEntry?.status).toBe(WorkflowStatus.FAILED);
    expect(historyEntry?.invalidTaskIdentity).toBe(true);
    expect(historyEntry?.resumeResult).toBe("invalid_task_identity");
    expect(historyEntry?.taskId).toBeNull();
    expect(historyEntry?.taskIds || []).toEqual([]);
    expect(historyEntry?.identityValidation?.code).toBe("invalid_task_identity");

    const detail = engine.getRunDetail(ctx.id);
    expect(detail?.detail?.identityValidation?.code).toBe("invalid_task_identity");
    expect(detail?.detail?.errors || []).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_task_identity" }),
    ]));
    expect(detail?.detail?.data?.taskId).toBeUndefined();
    expect(detail?.detail?.data?.taskTitle).toBeUndefined();
    expect(detail?.detail?.data?.branchName).toBeUndefined();
    expect(detail?.detail?.data?.task?.id).toBeUndefined();
    expect(detail?.detail?.data?.task?.title).toBeUndefined();
    expect(detail?.detail?.data?.task?.branchName).toBeUndefined();

    const persisted = readFileSync(join(tmpDir, "runs", `${ctx.id}.json`), "utf8");
    expect(persisted).not.toContain("{{taskId}}");
    expect(persisted).not.toContain("{{taskTitle}}");
    expect(persisted).not.toContain("{{branch}}");
  });

  it("sanitizes legacy polluted run history so unresolved task tokens are ignored on read", () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-legacy-polluted-history", name: "Legacy Polluted History" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const runId = "run-legacy-polluted-history";
    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [{
          runId,
          workflowId: wf.id,
          workflowName: wf.name,
          status: WorkflowStatus.COMPLETED,
          startedAt: 1,
          endedAt: 2,
          taskId: "{{taskId}}",
          taskIds: ["{{taskId}}"],
          taskTitle: "{{taskTitle}}",
          delegationTopology: {
            taskId: "{{taskId}}",
            rootTaskId: "{{taskId}}",
          },
        }],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${runId}.json`),
      JSON.stringify({
        id: runId,
        startedAt: 1,
        endedAt: 2,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          taskId: "{{taskId}}",
          taskTitle: "{{taskTitle}}",
          branchName: "{{branch}}",
          task: {
            id: "{{taskId}}",
            title: "{{taskTitle}}",
            branchName: "{{branch}}",
          },
        },
        nodeStatuses: { trigger: NodeStatus.COMPLETED },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );

    const historyEntry = engine.getRunHistory(wf.id, 5).find((entry) => entry.runId === runId);
    expect(historyEntry).toBeTruthy();
    expect(historyEntry?.invalidTaskIdentity).toBe(true);
    expect(historyEntry?.taskId).toBeNull();
    expect(historyEntry?.taskIds || []).toEqual([]);
    expect(historyEntry?.identityValidation?.code).toBe("invalid_task_identity");

    const detail = engine.getRunDetail(runId);
    expect(detail?.detail?.identityValidation?.code).toBe("invalid_task_identity");
    expect(detail?.detail?.data?.taskId).toBeUndefined();
    expect(detail?.detail?.data?.taskTitle).toBeUndefined();
    expect(detail?.detail?.data?.branchName).toBeUndefined();
    expect(detail?.detail?.data?.task?.id).toBeUndefined();
    expect(detail?.detail?.data?.task?.title).toBeUndefined();
    expect(detail?.detail?.data?.task?.branchName).toBeUndefined();
  });

  it("persists governance metadata into run summary, detail, and execution ledger", async () => {
    const completions = [];
    engine.on("run:complete", (event) => completions.push(event));

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "log", type: "notify.log", label: "Log", config: { message: "governance coverage" } },
      ],
      [{ id: "e1", source: "trigger", target: "log" }],
      { name: "Governance History Workflow" }
    );

    engine.save(wf);
    await engine.execute(wf.id, {
      taskId: "task-governance-1",
      taskTitle: "Governance Task",
      goalAncestry: [
        { goalId: "goal-root", title: "Root Goal", depth: 0 },
        { goalId: "goal-child", title: "Refine Operator Workflow", depth: 1 },
      ],
      heartbeatRun: {
        runId: "hb-1",
        status: "waiting",
        sourceRunId: "run-parent",
        wakeAt: "2026-03-31T10:00:00.000Z",
      },
      wakeupRequest: {
        requestId: "wake-1",
        source: "scheduler",
        requestedAt: "2026-03-31T09:55:00.000Z",
      },
      budgetPolicy: {
        budgetWindow: "2026-Q2",
        budgetCents: 1000,
        spentCents: 920,
        reservedCents: 20,
        nearLimitThresholdCents: 100,
        currency: "USD",
      },
      executionPolicy: {
        mode: "strict",
        violations: [
          {
            ruleId: "review-proof",
            message: "Independent review proof still pending.",
            blocking: false,
            nodeId: "log",
          },
        ],
      },
    });

    const summary = engine.getRunHistory(wf.id, 1)[0];
    expect(summary.goalAncestry).toHaveLength(2);
    expect(summary.primaryGoalId).toBe("goal-child");
    expect(summary.primaryGoalTitle).toBe("Refine Operator Workflow");
    expect(summary.goalDepth).toBe(1);
    expect(summary.heartbeatRun).toEqual(expect.objectContaining({ runId: "hb-1" }));
    expect(summary.wakeupRequest).toEqual(expect.objectContaining({ requestId: "wake-1" }));
    expect(summary.budgetPolicy).toEqual(expect.objectContaining({
      budgetWindow: "2026-Q2",
      budgetCents: 1000,
      currency: "USD",
    }));
    expect(summary.budgetOutcome).toEqual(expect.objectContaining({ status: "near_limit", nearLimit: true }));
    expect(summary.policyOutcome).toEqual(expect.objectContaining({ status: "warning", violationCount: 1 }));

    const run = engine.getRunDetail(summary.runId);
    expect(run?.detail?.primaryGoalId).toBe("goal-child");
    expect(run?.detail?.budgetPolicy).toEqual(expect.objectContaining({
      budgetWindow: "2026-Q2",
      budgetCents: 1000,
      currency: "USD",
    }));
    expect(run?.detail?.budgetOutcome).toEqual(expect.objectContaining({ status: "near_limit" }));
    expect(run?.detail?.policyOutcome).toEqual(expect.objectContaining({ status: "warning" }));
    expect(run?.detail?.data?._primaryGoalId).toBe("goal-child");
    expect(run?.detail?.data?._budgetPolicy).toEqual(expect.objectContaining({
      budgetWindow: "2026-Q2",
      budgetCents: 1000,
      currency: "USD",
    }));
    expect(run?.detail?.data?._budgetOutcome).toEqual(expect.objectContaining({ status: "near_limit" }));
    expect(run?.detail?.data?._policyOutcome).toEqual(expect.objectContaining({ status: "warning" }));
    expect(run?.ledger).toEqual(expect.objectContaining({
      primaryGoalId: "goal-child",
      primaryGoalTitle: "Refine Operator Workflow",
      budgetPolicy: expect.objectContaining({
        budgetWindow: "2026-Q2",
        budgetCents: 1000,
        currency: "USD",
      }),
      budgetOutcome: expect.objectContaining({ status: "near_limit" }),
      policyOutcome: expect.objectContaining({ status: "warning" }),
      heartbeatRun: expect.objectContaining({ runId: "hb-1" }),
      wakeupRequest: expect.objectContaining({ requestId: "wake-1" }),
    }));
    expect(run?.ledger?.events?.some((event) => event.budgetStatus === "near_limit")).toBe(true);
    expect(run?.ledger?.events?.some((event) => event.policyStatus === "warning")).toBe(true);

    expect(completions).toHaveLength(1);
    expect(completions[0]?.summary).toEqual(expect.objectContaining({
      primaryGoalId: "goal-child",
      budgetOutcome: expect.objectContaining({ status: "near_limit" }),
      policyOutcome: expect.objectContaining({ status: "warning" }),
    }));
  });

  it("preserves task identity when completed run detail compaction truncates large data objects", async () => {
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "log", type: "notify.log", label: "Log", config: { message: "identity compaction coverage" } },
      ],
      [{ id: "e1", source: "trigger", target: "log" }],
      { id: "wf-identity-compaction", name: "Identity Compaction Workflow" },
    );

    engine.save(wf);

    const oversizedData = {};
    for (let index = 0; index < 50; index += 1) {
      oversizedData[`filler_${String(index).padStart(2, "0")}`] = `value-${index}`;
    }
    oversizedData.taskId = "task-identity-compaction-1";
    oversizedData.taskTitle = "Identity survives compaction";
    oversizedData.branchName = "task/identity-compaction";
    oversizedData.task = {
      id: "task-identity-compaction-1",
      title: "Identity survives compaction",
      branchName: "task/identity-compaction",
      status: "done",
    };

    const ctx = await engine.execute(wf.id, oversizedData);

    const summary = engine.getRunHistory(wf.id, 1)[0];
    expect(summary?.runId).toBe(ctx.id);
    expect(summary?.taskId).toBe("task-identity-compaction-1");
    expect(summary?.taskIds || []).toContain("task-identity-compaction-1");
    expect(summary?.taskTitle).toBe("Identity survives compaction");

    const detail = engine.getRunDetail(ctx.id);
    expect(detail?.detail?.data?._truncatedKeys).toBeGreaterThan(0);
    expect(detail?.detail?.data?.taskId).toBe("task-identity-compaction-1");
    expect(detail?.detail?.data?.taskTitle).toBe("Identity survives compaction");
    expect(detail?.detail?.data?.branchName).toBe("task/identity-compaction");
    expect(detail?.detail?.data?.task?.id).toBe("task-identity-compaction-1");
    expect(detail?.detail?.data?.task?.title).toBe("Identity survives compaction");
    expect(detail?.detail?.data?.task?.branch).toBe("task/identity-compaction");
  });

  it("preserves push action flags when completed run detail compaction summarizes node outputs", async () => {
    registerNodeType("test.push_branch_like_output", {
      describe: () => "Returns push-style output",
      schema: { type: "object", properties: {} },
      async execute() {
        return {
          branch: "task/persist-push-output",
          branchName: "task/persist-push-output",
          remote: "origin",
          pushed: false,
          success: false,
          error: "push rejected",
        };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "push-branch", type: "test.push_branch_like_output", label: "Push Branch", config: {} },
      ],
      [{ id: "e1", source: "trigger", target: "push-branch" }],
      { id: "wf-push-output-compaction", name: "Push Output Compaction Workflow" },
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, {});
    const detail = engine.getRunDetail(ctx.id);

    expect(detail?.detail?.nodeOutputs?.["push-branch"]).toEqual(expect.objectContaining({
      branch: "task/persist-push-output",
      branchName: "task/persist-push-output",
      remote: "origin",
      pushed: false,
      success: false,
      error: "push rejected",
    }));
  });

  it("preserves full-inline push command output beyond the generic string cap", async () => {
    const longOutput = "push-output-line\n".repeat(400);
    expect(longOutput.length).toBeGreaterThan(4000);

    registerNodeType("test.push_branch_long_output", {
      describe: () => "Returns long push-style output",
      schema: { type: "object", properties: {} },
      async execute() {
        return {
          branch: "task/persist-push-output-long",
          remote: "origin",
          pushed: false,
          success: false,
          error: "push rejected",
          output: longOutput,
          outputCompacted: false,
          rawOutputChars: longOutput.length,
          compactedOutputChars: longOutput.length,
          outputBudgetPolicy: "full-inline",
          outputBudgetReason: "Output fit the inline budget; no retrieval artifact was needed.",
        };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "push-branch", type: "test.push_branch_long_output", label: "Push Branch", config: {} },
      ],
      [{ id: "e1", source: "trigger", target: "push-branch" }],
      { id: "wf-push-output-long-preservation", name: "Push Output Long Preservation Workflow" },
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, {});
    const detail = engine.getRunDetail(ctx.id);
    const pushOutput = detail?.detail?.nodeOutputs?.["push-branch"];

    expect(pushOutput).toEqual(expect.objectContaining({
      success: false,
      pushed: false,
      outputCompacted: false,
      rawOutputChars: longOutput.length,
      compactedOutputChars: longOutput.length,
      outputBudgetPolicy: "full-inline",
    }));
    expect(pushOutput?.output).toBe(longOutput);
    expect(pushOutput?.output.length).toBe(longOutput.length);
  });

  it("stores issue-advisor and DAGState failure context for continuation", async () => {
    registerNodeType("test.always_fail_for_dag", {
      describe: () => "Fails for DAGState coverage",
      schema: { type: "object", properties: {} },
      async execute() {
        throw new Error("validation step failed");
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "fail", type: "test.always_fail_for_dag", label: "Fail Step", config: { maxRetries: 0 } },
      ],
      [{ id: "e1", source: "trigger", target: "fail" }],
      { name: "Issue Advisor Workflow" },
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, {});
    expect(ctx.errors.length).toBeGreaterThan(0);

    const detail = engine.getRunDetail(ctx.id);
    expect(detail?.status).toBe(WorkflowStatus.FAILED);
    expect(detail?.detail?.dagState?.counts?.failed).toBe(1);
    expect(detail?.detail?.issueAdvisor?.recommendedAction).toBe("replan_from_failed");
    expect(detail?.detail?.issueAdvisor?.failedNodes?.[0]?.nodeId).toBe("fail");
    expect(detail?.detail?.issueAdvisor?.summary).toContain("Fail Step");
    expect(detail?.detail?.issueAdvisor?.retryDecisionClass).toBe("replan_entire_subgraph");
    expect(detail?.detail?.issueAdvisor?.issueFindings?.[0]?.source).toBe("validation");
    expect(Array.isArray(detail?.detail?.dagState?.edges)).toBe(true);
    expect(detail?.detail?.dagState?.edges?.[0]?.source).toBe("trigger");
  });

  it("does not mark completed runs with skipped branches as resumable", () => {
    const ctx = new WorkflowContext({
      _dagState: {
        nodes: {
          trigger: { nodeId: "trigger", label: "Trigger", status: NodeStatus.COMPLETED },
          gate: { nodeId: "gate", label: "Gate", status: NodeStatus.SKIPPED },
          followup: { nodeId: "followup", label: "Follow Up", status: NodeStatus.PENDING },
        },
      },
    });

    const advisor = engine._refreshDagState(ctx, WorkflowStatus.COMPLETED);

    expect(advisor?.status).toBe(WorkflowStatus.COMPLETED);
    expect(advisor?.recommendedAction).toBe("continue");
    expect(advisor?.summary).toBe(
      "Workflow completed on the executed path; 1 node(s) remained pending on inactive branches.",
    );
    expect(advisor?.nextStepGuidance).toBe(
      "Workflow reached a terminal completed state; pending nodes remained on inactive or skipped branches, so no further action is required.",
    );
  });

  it("hydrates delegation audit trail and guard maps into run detail and history", async () => {
    const engine = new WorkflowEngine({ persistRuns: true, runRetention: 20 });
    const wf = makeSimpleWorkflow(
      [
        { id: "start", type: "trigger.manual", position: { x: 0, y: 0 } },
        { id: "log", type: "notify.log", position: { x: 180, y: 0 }, config: { message: "delegation detail" } },
      ],
      [{ source: "start", target: "log" }],
      { name: "Delegation Detail Workflow" },
    );
    engine.save(wf);

    const ctx = await engine.execute(wf.id, {
      taskId: "task-delegation-history",
      _delegationAuditTrail: [
        {
          type: "assign",
          eventType: "assign",
          taskId: "task-delegation-history",
          transitionKey: "assign:task-delegation-history:owner-a",
          at: 10,
          timestamp: new Date(10).toISOString(),
        },
        {
          type: "handoff-complete",
          eventType: "handoff-complete",
          taskId: "task-delegation-history",
          transitionKey: "handoff-complete:task-delegation-history:owner-b",
          at: 20,
          timestamp: new Date(20).toISOString(),
        },
      ],
      _delegationTransitionGuards: {
        "assign:task-delegation-history:owner-a": {
          transitionKey: "assign:task-delegation-history:owner-a",
          status: "completed",
          claimToken: "claim-history-1",
        },
      },
    });

    const detail = engine.getRunDetail(ctx.id);
    expect(detail.delegationAuditTrail).toHaveLength(2);
    expect(detail.delegationTrail).toHaveLength(2);
    expect(detail.latestDelegationEvent?.type).toBe("handoff-complete");
    expect(detail.delegationTransitionGuards["assign:task-delegation-history:owner-a"]).toEqual(
      expect.objectContaining({
        status: "completed",
        claimToken: "claim-history-1",
      }),
    );
    expect(detail.detail.delegationAuditTrail).toHaveLength(2);
    expect(detail.detail.delegationTrail).toHaveLength(2);
    expect(detail.detail.data._workflowDelegationTrail).toHaveLength(2);
    expect(detail.detail.data._delegationTrail).toHaveLength(2);
    expect(detail.detail.data._delegationTransitionGuards).toEqual(
      expect.objectContaining({
        "assign:task-delegation-history:owner-a": expect.objectContaining({
          status: "completed",
          claimToken: "claim-history-1",
        }),
      }),
    );

    const summary = engine.getRunHistory(wf.id, 5)[0];
    expect(summary.delegationAuditTrail).toHaveLength(2);
    expect(summary.delegationTrail).toHaveLength(2);
    expect(summary.latestDelegationEvent?.type).toBe("handoff-complete");
    expect(summary.delegationTransitionGuards["assign:task-delegation-history:owner-a"]).toEqual(
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("threads validation diagnostics into run detail and history summaries", async () => {
    makeTmpEngine({
      scheduler: {
        selectWorkflowLane: vi.fn().mockReturnValue({
          lane: "isolated",
          reason: "workflow_node:validation.tests",
          heavy: true,
        }),
      },
      isolatedRunner: {
        run: vi.fn().mockResolvedValue({
          status: "timeout",
          stdout: "",
          stderr: "validation exceeded limit",
          exitCode: null,
          duration: 1005,
          provider: "process",
          leaseId: "runner-timeout",
          failureDiagnostic: {
            category: "timeout",
            retryable: true,
            summary: "Validation timed out after 1000ms.",
            status: "timeout",
          },
        }),
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "validate", type: "validation.tests", label: "Validate", config: { command: "npm test", timeoutMs: 1000 } },
      ],
      [{ id: "e1", source: "trigger", target: "validate" }],
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, {});

    expect(ctx.getNodeOutput("validate")?.failureKind).toBe("timeout");
    expect(ctx.getNodeOutput("validate")?.retryable).toBe(true);

    const detail = engine.getRunDetail(ctx.id);
    expect(detail?.detail?.validationFailures).toEqual([
      expect.objectContaining({
        nodeId: "validate",
        nodeType: "validation.tests",
        failureKind: "timeout",
        retryable: true,
      }),
    ]);
    expect(detail?.latestValidationFailure).toEqual(
      expect.objectContaining({
        nodeId: "validate",
        failureKind: "timeout",
        retryable: true,
      }),
    );

    const summary = engine.getRunHistory(wf.id).at(-1);
    expect(summary?.validationFailures).toEqual([
      expect.objectContaining({
        nodeId: "validate",
        failureKind: "timeout",
        retryable: true,
      }),
    ]);
  });

  it("returns retry options with an issue-advisor recommendation", async () => {
    registerNodeType("test.fail_for_retry_options", {
      describe: () => "Completes once then fails",
      schema: { type: "object", properties: {} },
      async execute(node) {
        if (node.id === "fail") throw new Error("retry choice needed");
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "prepare", type: "test.fail_for_retry_options", label: "Prepare", config: {} },
        { id: "fail", type: "test.fail_for_retry_options", label: "Fail Step", config: { maxRetries: 0 } },
      ],
      [
        { id: "e1", source: "trigger", target: "prepare" },
        { id: "e2", source: "prepare", target: "fail" },
      ],
      { id: "wf-retry-options", name: "Retry Options Workflow" },
    );

    engine.save(wf);
    const failedCtx = await engine.execute(wf.id, {});
    const retryOptions = engine.getRetryOptions(failedCtx.id);

    expect(retryOptions?.recommendedMode).toBe("replan_from_failed");
    expect(retryOptions?.recommendedReason).toBe("issue_advisor.replan_from_failed");
    expect(retryOptions?.failedNodes).toContain("fail");
    expect(retryOptions?.options?.find((entry) => entry.mode === "replan_from_failed")?.recommended).toBe(true);
  });

  it("uses issue-advisor guidance to escalate first auto-retry attempt to replan_from_failed", async () => {
    registerNodeType("test.auto_retry_replan_step", {
      describe: () => "Succeeds once then fails",
      schema: { type: "object", properties: {} },
      async execute(node) {
        if (node.id === "fail") {
          throw new Error("retry needs replanning");
        }
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "prepare", type: "test.auto_retry_replan_step", label: "Prepare", config: {} },
        { id: "fail", type: "test.auto_retry_replan_step", label: "Fail Step", config: { maxRetries: 0 } },
      ],
      [
        { id: "e1", source: "trigger", target: "prepare" },
        { id: "e2", source: "prepare", target: "fail" },
      ],
      { id: "wf-auto-retry-replan", name: "Auto Retry Replan" },
    );

    engine.save(wf);
    const failedCtx = await engine.execute(wf.id, {});
    expect(failedCtx.errors.length).toBeGreaterThan(0);

    const retrySpy = vi.spyOn(engine, "retryRun").mockResolvedValue({
      retryRunId: "retry-1",
      ctx: { errors: [] },
    });

    await engine._autoRetryLoop(failedCtx.id, wf.id, {}, { maxAttempts: 1, cooldownMs: 0 }, {});

    expect(retrySpy).toHaveBeenCalledWith(
      failedCtx.id,
      expect.objectContaining({
        mode: "replan_from_failed",
        _decisionReason: "issue_advisor.replan_from_failed",
      }),
    );
  });

  it("returns runs in descending order and null for unknown run details", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { name: "Ordering Workflow" }
    );

    engine.save(wf);
    await engine.execute(wf.id, { run: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await engine.execute(wf.id, { run: 2 });

    const history = engine.getRunHistory(wf.id, 10);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0].startedAt).toBeGreaterThanOrEqual(history[1].startedAt);
    expect(engine.getRunDetail("does-not-exist")).toBeNull();
  }, SLOW_WORKFLOW_ENGINE_RUN_HISTORY_PAGINATION_TEST_TIMEOUT_MS);

  it("returns paginated run history metadata without dropping total counts", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { name: "Paged History Workflow" },
    );

    engine.save(wf);
    await engine.execute(wf.id, { run: 1 });
    await engine.execute(wf.id, { run: 2 });
    await engine.execute(wf.id, { run: 3 });

    const page = engine.getRunHistoryPage(wf.id, { offset: 1, limit: 1 });
    expect(page.total).toBeGreaterThanOrEqual(3);
    expect(page.offset).toBe(1);
    expect(page.limit).toBe(1);
    expect(page.count).toBe(1);
    expect(Array.isArray(page.runs)).toBe(true);
    expect(page.runs).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(2);
  }, SLOW_WORKFLOW_ENGINE_RUN_HISTORY_PAGINATION_TEST_TIMEOUT_MS);

  it("paginates run history from summaries without rereading each run detail", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { name: "Summary Only History Workflow" },
    );

    engine.save(wf);
    await engine.execute(wf.id, { run: 1 });
    await engine.execute(wf.id, { run: 2 });
    await engine.execute(wf.id, { run: 3 });

    const detailSpy = vi.spyOn(engine, "getRunDetail");
    const page = engine.getRunHistoryPage(wf.id, { offset: 1, limit: 1 });

    expect(page.count).toBe(1);
    expect(page.runs).toHaveLength(1);
    expect(detailSpy).not.toHaveBeenCalled();
  }, SLOW_WORKFLOW_ENGINE_RUN_HISTORY_PAGINATION_TEST_TIMEOUT_MS);

  it("uses SQL-backed page reads without invoking legacy index hydration", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { name: "Bounded History Hydration Workflow" },
    );

    engine.save(wf);
    await engine.execute(wf.id, { run: 1 });
    await engine.execute(wf.id, { run: 2 });
    await engine.execute(wf.id, { run: 3 });

    const hydrateSpy = vi.spyOn(engine, "_hydrateRunIndexFromDetails");
    engine.getRunHistoryPage(wf.id, { offset: 1, limit: 1 });

    expect(hydrateSpy).not.toHaveBeenCalled();
  }, SLOW_WORKFLOW_ENGINE_RUN_HISTORY_PAGINATION_TEST_TIMEOUT_MS);

  it("reads paged run history from SQL-backed summaries when the legacy index is missing", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { name: "SQL History Workflow" },
    );

    engine.save(wf);
    await engine.execute(wf.id, { run: 1 });
    await engine.execute(wf.id, { run: 2 });

    const indexPath = join(tmpDir, "runs", "index.json");
    unlinkSync(indexPath);

    const page = engine.getRunHistoryPage(wf.id, { offset: 0, limit: 10 });
    expect(page.total).toBeGreaterThanOrEqual(2);
    expect(page.runs).toHaveLength(2);
    expect(page.runs[0]).toEqual(expect.objectContaining({
      workflowId: wf.id,
      workflowName: "SQL History Workflow",
    }));
  }, SLOW_WORKFLOW_ENGINE_RUN_HISTORY_PAGINATION_TEST_TIMEOUT_MS);

  it("pages SQL-backed run history with offsets when the legacy index is missing", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { name: "SQL Offset History Workflow" },
    );

    engine.save(wf);
    await engine.execute(wf.id, { run: 1 });
    await engine.execute(wf.id, { run: 2 });
    await engine.execute(wf.id, { run: 3 });

    const hydrateSpy = vi.spyOn(engine, "_hydrateRunIndexFromDetails");
    const indexPath = join(tmpDir, "runs", "index.json");
    unlinkSync(indexPath);

    const page = engine.getRunHistoryPage(wf.id, { offset: 1, limit: 1 });
    expect(page.total).toBeGreaterThanOrEqual(3);
    expect(page.runs).toHaveLength(1);
    expect(page.offset).toBe(1);
    expect(page.limit).toBe(1);
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(2);
    expect(page.runs[0]).toEqual(expect.objectContaining({
      workflowId: wf.id,
      workflowName: "SQL Offset History Workflow",
    }));
    expect(hydrateSpy).not.toHaveBeenCalled();
  }, SLOW_WORKFLOW_ENGINE_RUN_HISTORY_PAGINATION_TEST_TIMEOUT_MS);

  it("backfills sparse paged run summaries from run detail files when summary fields are missing", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { name: "Sparse History Workflow" },
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, { taskId: "TASK-HISTORY-1" });
    const pageBefore = engine.getRunHistoryPage(wf.id, { offset: 0, limit: 1 });
    const runId = pageBefore.runs[0]?.runId;
    expect(runId).toBeTruthy();

    const indexPath = join(tmpDir, "runs", "index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    const nextIndex = (Array.isArray(index?.runs) ? index.runs : []).map((entry) => (
      entry?.runId === runId
        ? {
            ...entry,
            duration: null,
            endedAt: null,
            nodeCount: null,
            completedCount: null,
            failedCount: null,
            skippedCount: null,
            triggerEvent: null,
            triggerSource: null,
          }
        : entry
    ));
    writeFileSync(indexPath, JSON.stringify({ runs: nextIndex }, null, 2), "utf8");

    const page = engine.getRunHistoryPage(wf.id, { offset: 0, limit: 1 });
    expect(page.runs[0]).toEqual(expect.objectContaining({
      runId,
      duration: expect.any(Number),
      endedAt: expect.any(Number),
      nodeCount: expect.any(Number),
      triggerSource: "manual",
    }));
    expect(page.runs[0].duration).toBeGreaterThanOrEqual(0);
    expect(page.runs[0].nodeCount).toBeGreaterThanOrEqual(1);
    expect(page.runs[0].completedCount).toBeGreaterThanOrEqual(1);
  });

  it("paginates global run history beyond the initial page size", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { name: "Global Paged History Workflow" },
    );

    engine.save(wf);
    const runsDir = join(tmpDir, "runs");
    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: Array.from({ length: 35 }, (_unused, index) => ({
          runId: `run-global-page-${index + 1}`,
          workflowId: wf.id,
          workflowName: wf.name,
          status: WorkflowStatus.COMPLETED,
          startedAt: 35 - index,
          endedAt: 36 - index,
          triggerEvent: "manual",
          triggerSource: "manual",
          nodeCount: 1,
          completedCount: 1,
          failedCount: 0,
          skippedCount: 0,
          duration: 1,
        })),
      }, null, 2),
      "utf8",
    );

    const all = engine.getRunHistory();
    expect(all.length).toBeGreaterThanOrEqual(35);

    const page = engine.getRunHistoryPage(null, { offset: 20, limit: 10 });
    expect(page.total).toBeGreaterThanOrEqual(35);
    expect(page.offset).toBe(20);
    expect(page.limit).toBe(10);
    expect(page.count).toBe(10);
    expect(page.runs).toHaveLength(10);
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(30);
  }, 30000);

  it("repairs common mojibake in workflow run history and detail text fields", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { name: "Workflow run mojibake test" },
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, {
      taskTitle: "feat(tui): Session Detail modal ÔÇö full session drill-down",
      _workflowName: "PR watchdog ÔÇö repair loop",
      primaryGoalTitle: "Telemetry ÔÇö stabilize run history",
    });

    const historyEntry = engine.getRunHistory(wf.id, 10).find((entry) => entry.runId === ctx.id);
    const detail = engine.getRunDetail(ctx.id);

    expect(historyEntry?.taskTitle).toContain("—");
    expect(historyEntry?.taskTitle).not.toContain("ÔÇö");
    expect(historyEntry?.primaryGoalTitle).toContain("—");
    expect(historyEntry?.primaryGoalTitle).not.toContain("ÔÇö");
    expect(historyEntry?.workflowName).toBe("Workflow run mojibake test");
    expect(detail?.detail?.data?.taskTitle).toContain("—");
    expect(detail?.detail?.data?.primaryGoalTitle).toContain("—");
    expect(detail?.detail?.data?.taskTitle).not.toContain("ÔÇö");
    expect(detail?.detail?.data?._workflowName).toBe("Workflow run mojibake test");
  });

  it("includes active runs in history and exposes live run detail while executing", async () => {
    const prevThreshold = process.env.WORKFLOW_RUN_STUCK_THRESHOLD_MS;
    process.env.WORKFLOW_RUN_STUCK_THRESHOLD_MS = "20";
    try {
      let releaseRun;
      const blocker = new Promise((resolve) => { releaseRun = resolve; });
      let nodeEntered;
      const nodeStarted = new Promise((resolve) => { nodeEntered = resolve; });

      registerNodeType("test.long_running", {
        describe: () => "Long running node for active-run visibility",
        schema: { type: "object", properties: {} },
        async execute(node, ctx) {
          ctx.log(node.id, "long running node entered");
          nodeEntered();
          await blocker;
          return { ok: true };
        },
      });

      const wf = makeSimpleWorkflow(
        [
          { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
          { id: "wait", type: "test.long_running", label: "Wait", config: {} },
        ],
        [{ id: "e1", source: "trigger", target: "wait" }],
        { name: "Active Run Visibility Workflow" },
      );

      engine.save(wf);
      const runPromise = engine.execute(wf.id, {
        taskId: "task-active-1",
        taskTitle: "Active Run Task",
        sessionId: "session-active-1",
      });
      // Wait for the long-running node to actually start, then wait beyond
      // the stuck threshold (20ms) so isStuck is true when we query history
      await nodeStarted;
      await new Promise((resolve) => setTimeout(resolve, 30));

      const history = engine.getRunHistory(wf.id, 10);
      const active = history.find((entry) => entry.status === WorkflowStatus.RUNNING);
      expect(active).toBeTruthy();
      expect(active.workflowName).toBe("Active Run Visibility Workflow");
      expect(active.activeNodeCount).toBeGreaterThan(0);
      expect(typeof active.lastProgressAt).toBe("number");
      expect(typeof active.duration).toBe("number");
      expect(active.isStuck).toBe(true);
      expect(active.stuckMs).toBeGreaterThanOrEqual(20);
      expect(active.taskId).toBe("task-active-1");
      expect(active.taskIds).toContain("task-active-1");
      expect(active.taskTitle).toBe("Active Run Task");
      expect(active.primarySessionId).toBe("session-active-1");

      let activeRunEntry = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const activeRunsPath = join(tmpDir, "runs", "_active-runs.json");
        if (existsSync(activeRunsPath)) {
          const entries = JSON.parse(readFileSync(activeRunsPath, "utf8"));
          activeRunEntry = entries.find((entry) => entry.runId === active.runId) || null;
          if (activeRunEntry) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(activeRunEntry).toMatchObject({
        runId: active.runId,
        workflowId: wf.id,
        workflowName: "Active Run Visibility Workflow",
        taskId: "task-active-1",
        taskTitle: "Active Run Task",
        sessionId: "session-active-1",
      });
      expect(activeRunEntry?.taskIds).toContain("task-active-1");
      expect(activeRunEntry?.sessionIds).toContain("session-active-1");

      const detail = engine.getRunDetail(active.runId);
      expect(detail).toBeTruthy();
      expect(detail.status).toBe(WorkflowStatus.RUNNING);
      expect(detail.endedAt).toBeNull();
      expect(detail.detail.endedAt).toBeNull();
      expect(Array.isArray(detail.detail.logs)).toBe(true);
      expect(Array.isArray(detail.detail.nodeStatusEvents)).toBe(true);

      releaseRun();
      await runPromise;

      const latest = engine.getRunHistory(wf.id, 1)[0];
      expect(latest.status).toBe(WorkflowStatus.COMPLETED);
      expect(latest.isStuck).toBe(false);
    } finally {
      if (prevThreshold === undefined) delete process.env.WORKFLOW_RUN_STUCK_THRESHOLD_MS;
      else process.env.WORKFLOW_RUN_STUCK_THRESHOLD_MS = prevThreshold;
    }
  });


  it("skips checkpoint writes once a run is no longer active", async () => {
    const runId = "run-inactive-checkpoint";
    const runsDir = join(tmpDir, "runs");
    const detailPath = join(runsDir, `${runId}.json`);

    const ctx = new WorkflowContext(runId, {
      _workflowId: "wf-checkpoint-skip",
      _workflowName: "Checkpoint Skip",
    });

    // Simulate a debounced checkpoint firing for a run that was already removed.
    engine._checkpointRun(ctx);

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(existsSync(detailPath)).toBe(false);
  });

  it("persists active-run task identity without inherited parent task carryover", () => {
    const ctx = new WorkflowContext({
      taskId: "task-child-1",
      activeTaskId: "task-child-1",
      taskTitle: "Child Task",
      task: {
        id: "task-child-1",
        title: "Child Task",
      },
      _workflowRootTaskId: "task-parent-root",
      _workflowParentTaskId: "task-parent-root",
      _taskWorkflowEvents: [
        {
          runId: "parent-run-1",
          taskId: "task-parent-root",
          taskTitle: "Parent Root Task",
        },
        {
          runId: "child-run-1",
          taskId: "task-child-1",
          taskTitle: "Child Task",
        },
      ],
    });
    ctx.id = "child-run-1";
    ctx.startedAt = Date.now() - 500;

    engine._persistActiveRunState("child-run-1", "template-task-lifecycle", "Task Lifecycle", ctx);

    const activeRunsPath = join(tmpDir, "runs", "_active-runs.json");
    const entries = JSON.parse(readFileSync(activeRunsPath, "utf8"));
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: "child-run-1",
        workflowId: "template-task-lifecycle",
        workflowName: "Task Lifecycle",
        taskId: "task-child-1",
        taskTitle: "Child Task",
        taskIds: ["task-child-1"],
      }),
    ]));
  });

  it("preserves sibling active-runs entries when one run is cleared", () => {
    const firstCtx = new WorkflowContext({
      taskId: "task-one",
      taskTitle: "Task One",
      task: { id: "task-one", title: "Task One" },
    });
    firstCtx.id = "run-one";
    firstCtx.startedAt = Date.now() - 1000;

    const secondCtx = new WorkflowContext({
      taskId: "task-two",
      taskTitle: "Task Two",
      task: { id: "task-two", title: "Task Two" },
    });
    secondCtx.id = "run-two";
    secondCtx.startedAt = Date.now() - 500;

    engine._activeRuns.set("run-one", {
      ctx: firstCtx,
      workflowId: "template-task-lifecycle",
      workflowName: "Task Lifecycle",
      status: WorkflowStatus.RUNNING,
    });
    engine._persistActiveRunState("run-one", "template-task-lifecycle", "Task Lifecycle", firstCtx);

    engine._activeRuns.set("run-two", {
      ctx: secondCtx,
      workflowId: "template-task-lifecycle",
      workflowName: "Task Lifecycle",
      status: WorkflowStatus.RUNNING,
    });
    engine._persistActiveRunState("run-two", "template-task-lifecycle", "Task Lifecycle", secondCtx);

    engine._clearActiveRunState("run-one");
    engine._activeRuns.delete("run-one");

    const activeRunsPath = join(tmpDir, "runs", "_active-runs.json");
    const entries = JSON.parse(readFileSync(activeRunsPath, "utf8"));
    expect(entries).toEqual([
      expect.objectContaining({
        runId: "run-two",
        taskId: "task-two",
        taskIds: ["task-two"],
        taskTitle: "Task Two",
      }),
    ]);
  });

  it("preserves foreign task-claimed active-runs entries when another engine clears its run", async () => {
    const sharedTmpDir = mkdtempSync(join(tmpdir(), "wf-engine-cross-process-"));
    const workflowDir = join(sharedTmpDir, "workflows");
    const runsDir = join(sharedTmpDir, "runs");
    const claimsDir = join(sharedTmpDir, ".cache", "bosun");
    mkdirSync(claimsDir, { recursive: true });

    const liveEngine = new WorkflowEngine({
      workflowDir,
      runsDir,
    });
    const probeEngine = new WorkflowEngine({
      workflowDir,
      runsDir,
    });

    try {
      const liveCtx = new WorkflowContext({
        taskId: "task-live",
        taskTitle: "Live Task",
        task: { id: "task-live", title: "Live Task" },
      });
      liveCtx.id = "run-live";
      liveCtx.startedAt = Date.now() - 1000;
      liveEngine._activeRuns.set("run-live", {
        ctx: liveCtx,
        workflowId: "template-task-lifecycle",
        workflowName: "Task Lifecycle",
        status: WorkflowStatus.RUNNING,
      });
      liveEngine._persistActiveRunState(
        "run-live",
        "template-task-lifecycle",
        "Task Lifecycle",
        liveCtx,
      );

      writeFileSync(
        join(claimsDir, "task-claims.json"),
        JSON.stringify({
          version: 1,
          claims: {
            "task-live": {
              task_id: "task-live",
              instance_id: "wf-live",
              claim_token: "claim-live",
              metadata: {
                host: hostname(),
                pid: process.pid,
              },
            },
          },
          updated_at: new Date().toISOString(),
        }, null, 2),
        "utf8",
      );

      const probeCtx = new WorkflowContext({
        taskId: "task-probe",
        taskTitle: "Probe Task",
        task: { id: "task-probe", title: "Probe Task" },
      });
      probeCtx.id = "run-probe";
      probeCtx.startedAt = Date.now() - 500;
      probeEngine._activeRuns.set("run-probe", {
        ctx: probeCtx,
        workflowId: "template-task-lifecycle",
        workflowName: "Task Lifecycle",
        status: WorkflowStatus.RUNNING,
      });
      probeEngine._persistActiveRunState(
        "run-probe",
        "template-task-lifecycle",
        "Task Lifecycle",
        probeCtx,
      );

      const duringProbe = JSON.parse(readFileSync(join(runsDir, "_active-runs.json"), "utf8"));
      expect(duringProbe).toEqual(expect.arrayContaining([
        expect.objectContaining({
          runId: "run-live",
          taskId: "task-live",
        }),
        expect.objectContaining({
          runId: "run-probe",
          taskId: "task-probe",
        }),
      ]));

      probeEngine._clearActiveRunState("run-probe");
      probeEngine._activeRuns.delete("run-probe");

      const afterProbe = JSON.parse(readFileSync(join(runsDir, "_active-runs.json"), "utf8"));
      expect(afterProbe).toEqual([
        expect.objectContaining({
          runId: "run-live",
          taskId: "task-live",
          taskIds: ["task-live"],
          taskTitle: "Live Task",
        }),
      ]);
    } finally {
      await removeDirWithRetries(sharedTmpDir, { ignoreFinalEperm: true });
    }
  });

  it("links persisted active runs into task topology at run start", async () => {
    const taskStore = await import("../task/task-store.mjs");
    const originalStorePath = taskStore.getStorePath();
    const taskStoreDir = mkdtempSync(join(tmpdir(), "wf-engine-run-start-store-"));
    const storePath = join(taskStoreDir, "kanban-state.json");

    try {
      taskStore.configureTaskStore({ storePath });
      await taskStore._resetForTests();
      taskStore.addTask({ id: "task-run-start-link", title: "Run Start Link", status: "inprogress" });

      engine = makeTmpEngine({ kanban: {} });
      const ctx = new WorkflowContext({
        taskId: "task-run-start-link",
        taskTitle: "Run Start Link",
        task: {
          id: "task-run-start-link",
          title: "Run Start Link",
        },
        _workflowTaskId: "task-run-start-link",
        _workflowSessionId: "workflow-session-1",
        _workflowRootSessionId: "workflow-root-session-1",
        _workflowParentSessionId: "workflow-parent-session-1",
        _workflowRootRunId: "workflow-root-run-1",
        _workflowParentRunId: "workflow-parent-run-1",
      });
      ctx.id = "run-start-link-1";
      ctx.startedAt = Date.now() - 500;

      engine._persistActiveRunState("run-start-link-1", "template-task-lifecycle", "Task Lifecycle", ctx);
      await taskStore.waitForStoreWrites();

      const storedTask = taskStore.getTask("task-run-start-link");
      expect(storedTask?.latestRunId).toBe("run-start-link-1");
      expect(storedTask?.workflowName).toBe("Task Lifecycle");
      expect(storedTask?.sessionId).toBe("workflow-session-1");
      expect(storedTask?.topology).toEqual(expect.objectContaining({
        latestRunId: "run-start-link-1",
        workflowName: "Task Lifecycle",
        sessionId: "workflow-session-1",
        rootRunId: "workflow-root-run-1",
        parentRunId: "workflow-parent-run-1",
      }));
      expect(storedTask?.workflowRuns).toEqual(expect.arrayContaining([
        expect.objectContaining({
          runId: "run-start-link-1",
          workflowName: "Task Lifecycle",
          status: WorkflowStatus.RUNNING,
        }),
      ]));
    } finally {
      await taskStore.waitForStoreWrites();
      await taskStore._resetForTests();
      taskStore.configureTaskStore({ storePath: originalStorePath });
      await removeDirWithRetries(taskStoreDir, { ignoreFinalEperm: true });
    }
  });

  it("syncs persisted completed runs into task topology", async () => {
    const taskStore = await import("../task/task-store.mjs");
    const originalStorePath = taskStore.getStorePath();
    const taskStoreDir = mkdtempSync(join(tmpdir(), "wf-engine-run-complete-store-"));
    const storePath = join(taskStoreDir, "kanban-state.json");

    try {
      taskStore.configureTaskStore({ storePath });
      await taskStore._resetForTests();
      taskStore.addTask({ id: "task-run-complete-link", title: "Run Complete Link", status: "inprogress" });

      engine = makeTmpEngine({ kanban: {} });
      const ctx = new WorkflowContext({
        taskId: "task-run-complete-link",
        taskTitle: "Run Complete Link",
        task: {
          id: "task-run-complete-link",
          title: "Run Complete Link",
        },
        _workflowTaskId: "task-run-complete-link",
        _workflowSessionId: "workflow-session-complete",
        _workflowRootSessionId: "workflow-root-session-complete",
        _workflowRootRunId: "workflow-root-run-complete",
      });
      ctx.id = "run-complete-link-1";
      ctx.startedAt = Date.now() - 1000;
      ctx.endedAt = ctx.startedAt + 500;
      ctx.setNodeStatus("trigger", NodeStatus.COMPLETED);

      engine._persistRun("run-complete-link-1", "template-task-lifecycle", ctx);
      await taskStore.waitForStoreWrites();

      const storedTask = taskStore.getTask("task-run-complete-link");
      expect(storedTask?.latestRunId).toBe("run-complete-link-1");
      expect(storedTask?.workflowRuns).toEqual(expect.arrayContaining([
        expect.objectContaining({
          runId: "run-complete-link-1",
          status: WorkflowStatus.COMPLETED,
          endedAt: expect.any(String),
        }),
      ]));
    } finally {
      await taskStore.waitForStoreWrites();
      await taskStore._resetForTests();
      taskStore.configureTaskStore({ storePath: originalStorePath });
      await removeDirWithRetries(taskStoreDir, { ignoreFinalEperm: true });
    }
  });

  it("does not let older run status sync clobber the latest task run linkage", async () => {
    const taskStore = await import("../task/task-store.mjs");
    const originalStorePath = taskStore.getStorePath();
    const taskStoreDir = mkdtempSync(join(tmpdir(), "wf-engine-run-summary-store-"));
    const storePath = join(taskStoreDir, "kanban-state.json");

    try {
      taskStore.configureTaskStore({ storePath });
      await taskStore._resetForTests();
      taskStore.addTask({ id: "task-run-summary-link", title: "Run Summary Link", status: "inprogress" });

      engine = makeTmpEngine({ kanban: {} });
      const latestCtx = new WorkflowContext({
        taskId: "task-run-summary-link",
        taskTitle: "Run Summary Link",
        task: {
          id: "task-run-summary-link",
          title: "Run Summary Link",
        },
        _workflowTaskId: "task-run-summary-link",
        _workflowSessionId: "workflow-session-latest",
        _workflowRootSessionId: "workflow-root-session-latest",
        _workflowRootRunId: "workflow-root-run-latest",
      });
      latestCtx.id = "run-summary-latest";
      latestCtx.startedAt = Date.now();

      engine._persistActiveRunState("run-summary-latest", "backend-agent", "Backend Agent", latestCtx);
      await taskStore.waitForStoreWrites();

      engine._syncTaskProjectionFromRunSummary({
        runId: "run-summary-old",
        workflowId: "template-task-lifecycle",
        workflowName: "Task Lifecycle",
        status: WorkflowStatus.PAUSED,
        taskId: "task-run-summary-link",
        startedAt: latestCtx.startedAt - 5000,
        endedAt: latestCtx.startedAt - 1000,
        rootRunId: "workflow-root-run-old",
        parentRunId: null,
        sessionId: "workflow-session-old",
        delegationTopology: {
          runId: "run-summary-old",
          rootRunId: "workflow-root-run-old",
          taskId: "task-run-summary-link",
          rootTaskId: "task-run-summary-link",
          sessionId: "workflow-session-old",
          rootSessionId: "workflow-root-session-old",
        },
      });
      await taskStore.waitForStoreWrites();

      const storedTask = taskStore.getTask("task-run-summary-link");
      expect(storedTask?.latestRunId).toBe("run-summary-latest");
      expect(storedTask?.workflowRuns).toEqual(expect.arrayContaining([
        expect.objectContaining({
          runId: "run-summary-old",
          workflowName: "Task Lifecycle",
          status: WorkflowStatus.PAUSED,
        }),
        expect.objectContaining({
          runId: "run-summary-latest",
          workflowName: "Backend Agent",
          status: WorkflowStatus.RUNNING,
        }),
      ]));
    } finally {
      await taskStore.waitForStoreWrites();
      await taskStore._resetForTests();
      taskStore.configureTaskStore({ storePath: originalStorePath });
      await removeDirWithRetries(taskStoreDir, { ignoreFinalEperm: true });
    }
  });

  it("reconciles interrupted task families into task topology without clobbering a newer completed run", async () => {
    const taskStore = await import("../task/task-store.mjs");
    const originalStorePath = taskStore.getStorePath();
    const taskStoreDir = mkdtempSync(join(tmpdir(), "wf-engine-interrupted-task-family-store-"));
    const storePath = join(taskStoreDir, "kanban-state.json");

    try {
      taskStore.configureTaskStore({ storePath });
      await taskStore._resetForTests();
      taskStore.addTask({ id: "task-interrupted-family", title: "Interrupted Family", status: "inprogress" });
      taskStore.linkTaskWorkflowRun("task-interrupted-family", {
        runId: "run-family-parent",
        workflowId: "template-task-lifecycle",
        workflowName: "Task Lifecycle",
        status: WorkflowStatus.RUNNING,
        startedAt: new Date(1000).toISOString(),
      });
      taskStore.linkTaskWorkflowRun("task-interrupted-family", {
        runId: "run-family-latest",
        workflowId: "backend-agent",
        workflowName: "Backend Agent",
        status: WorkflowStatus.FAILED,
        startedAt: new Date(3000).toISOString(),
        endedAt: new Date(3500).toISOString(),
      });
      await taskStore.waitForStoreWrites();

      engine = makeTmpEngine({ kanban: {} });
      const runsDir = join(tmpDir, "runs");
      mkdirSync(runsDir, { recursive: true });
      writeFileSync(
        join(runsDir, "index.json"),
        JSON.stringify({
          runs: [
            {
              runId: "run-family-parent",
              workflowId: "template-task-lifecycle",
              workflowName: "Task Lifecycle",
              status: WorkflowStatus.RUNNING,
              startedAt: 1000,
              endedAt: null,
              taskId: "task-interrupted-family",
            },
            {
              runId: "run-family-latest",
              workflowId: "backend-agent",
              workflowName: "Backend Agent",
              status: WorkflowStatus.COMPLETED,
              startedAt: 3000,
              endedAt: 3500,
              taskId: "task-interrupted-family",
            },
          ],
        }, null, 2),
        "utf8",
      );
      writeFileSync(
        join(runsDir, "run-family-parent.json"),
        JSON.stringify({
          id: "run-family-parent",
          startedAt: 1000,
          data: {
            _workflowId: "template-task-lifecycle",
            _workflowName: "Task Lifecycle",
            taskId: "task-interrupted-family",
          },
          nodeStatuses: { trigger: NodeStatus.RUNNING },
          nodeStatusEvents: [],
          logs: [],
          errors: [],
        }, null, 2),
        "utf8",
      );
      writeFileSync(
        join(runsDir, "run-family-latest.json"),
        JSON.stringify({
          id: "run-family-latest",
          startedAt: 3000,
          endedAt: 3500,
          data: {
            _workflowId: "backend-agent",
            _workflowName: "Backend Agent",
            taskId: "task-interrupted-family",
          },
          nodeStatuses: { trigger: NodeStatus.COMPLETED },
          nodeStatusEvents: [],
          logs: [],
          errors: [],
        }, null, 2),
        "utf8",
      );
      writeFileSync(
        join(runsDir, "_active-runs.json"),
        JSON.stringify([
          {
            runId: "run-family-parent",
            workflowId: "template-task-lifecycle",
            workflowName: "Task Lifecycle",
            taskId: "task-interrupted-family",
          },
        ], null, 2),
        "utf8",
      );

      engine._detectInterruptedRuns();
      await taskStore.waitForStoreWrites();

      const storedTask = taskStore.getTask("task-interrupted-family");
      expect(storedTask?.latestRunId).toBe("run-family-latest");
      expect(storedTask?.workflowRuns).toEqual(expect.arrayContaining([
        expect.objectContaining({
          runId: "run-family-parent",
          workflowName: "Task Lifecycle",
          status: WorkflowStatus.PAUSED,
        }),
        expect.objectContaining({
          runId: "run-family-latest",
          workflowName: "Backend Agent",
          status: WorkflowStatus.COMPLETED,
        }),
      ]));
    } finally {
      await taskStore.waitForStoreWrites();
      await taskStore._resetForTests();
      taskStore.configureTaskStore({ storePath: originalStorePath });
      await removeDirWithRetries(taskStoreDir, { ignoreFinalEperm: true });
    }
  });

  it("keeps active-runs entries for locally claimed live task runs during interrupted-run detection", () => {
    engine = makeTmpEngine();
    const runsDir = join(tmpDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    mkdirSync(join(tmpDir, ".cache", "bosun"), { recursive: true });

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: "run-live-local",
            workflowId: "template-task-lifecycle",
            workflowName: "Task Lifecycle",
            status: WorkflowStatus.RUNNING,
            startedAt: 1000,
            endedAt: null,
            taskId: "task-live-local",
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, "run-live-local.json"),
      JSON.stringify({
        id: "run-live-local",
        startedAt: 1000,
        data: {
          _workflowId: "template-task-lifecycle",
          _workflowName: "Task Lifecycle",
          taskId: "task-live-local",
        },
        nodeStatuses: { trigger: NodeStatus.RUNNING },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, "_active-runs.json"),
      JSON.stringify([
        {
          runId: "run-live-local",
          workflowId: "template-task-lifecycle",
          workflowName: "Task Lifecycle",
          taskId: "task-live-local",
        },
      ], null, 2),
      "utf8",
    );
    writeFileSync(
      join(tmpDir, ".cache", "bosun", "task-claims.json"),
      JSON.stringify({
        version: 1,
        claims: {
          "task-live-local": {
            task_id: "task-live-local",
            instance_id: "wf-live-local",
            claim_token: "claim-live-local",
            metadata: {
              host: hostname(),
              pid: process.pid,
            },
          },
        },
        updated_at: new Date().toISOString(),
      }, null, 2),
      "utf8",
    );

    engine._detectInterruptedRuns();

    const activeEntries = JSON.parse(readFileSync(join(runsDir, "_active-runs.json"), "utf8"));
    expect(activeEntries).toEqual([
      expect.objectContaining({
        runId: "run-live-local",
        taskId: "task-live-local",
      }),
    ]);

    const runIndex = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const runEntry = runIndex.runs.find((run) => run.runId === "run-live-local");
    expect(runEntry?.status).toBe(WorkflowStatus.RUNNING);
    expect(runEntry?.resumable).not.toBe(true);
  });

  it("reconciles paused duplicate task families into task topology even without an active interrupted entry", async () => {
    const taskStore = await import("../task/task-store.mjs");
    const originalStorePath = taskStore.getStorePath();
    const taskStoreDir = mkdtempSync(join(tmpdir(), "wf-engine-duplicate-task-family-store-"));
    const storePath = join(taskStoreDir, "kanban-state.json");

    try {
      taskStore.configureTaskStore({ storePath });
      await taskStore._resetForTests();
      taskStore.addTask({ id: "task-duplicate-family", title: "Duplicate Family", status: "inprogress" });
      taskStore.linkTaskWorkflowRun("task-duplicate-family", {
        runId: "run-duplicate-parent",
        workflowId: "template-task-lifecycle",
        workflowName: "Task Lifecycle",
        status: WorkflowStatus.RUNNING,
        startedAt: new Date(1000).toISOString(),
      });
      taskStore.linkTaskWorkflowRun("task-duplicate-family", {
        runId: "run-duplicate-latest",
        workflowId: "backend-agent",
        workflowName: "Backend Agent",
        nodeId: "auto-fix",
        status: WorkflowStatus.FAILED,
        taskId: "task-duplicate-family",
        sessionId: "task-duplicate-family:agent:run-duplicate-latest:auto-fix:turn",
        rootSessionId: "task-duplicate-family",
        parentSessionId: "workflow:parent-session",
        delegationDepth: 1,
      });
      await taskStore.waitForStoreWrites();

      engine = makeTmpEngine({ kanban: {} });
      const runsDir = join(tmpDir, "runs");
      mkdirSync(runsDir, { recursive: true });
      writeFileSync(
        join(runsDir, "index.json"),
        JSON.stringify({
          runs: [
            {
              runId: "run-duplicate-parent",
              workflowId: "template-task-lifecycle",
              workflowName: "Task Lifecycle",
              status: WorkflowStatus.PAUSED,
              startedAt: 1000,
              endedAt: 1500,
              taskId: "task-duplicate-family",
              resumable: false,
              resumeResult: "duplicate_task_run",
            },
            {
              runId: "run-duplicate-latest",
              workflowId: "backend-agent",
              workflowName: "Backend Agent",
              status: WorkflowStatus.COMPLETED,
              startedAt: 3000,
              endedAt: 3500,
              taskId: "task-duplicate-family",
              rootRunId: "run-duplicate-root",
              parentRunId: "run-duplicate-parent",
              delegationTopology: {
                taskId: "task-duplicate-family",
                rootTaskId: "task-duplicate-family",
                sessionId: "workflow:root-session",
                rootSessionId: "workflow:root-session",
                parentSessionId: "workflow:parent-session",
              },
              issueAdvisorSummary: "Workflow completed successfully.",
            },
          ],
        }, null, 2),
        "utf8",
      );
      writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

      engine._detectInterruptedRuns();
      await taskStore.waitForStoreWrites();

      const storedTask = taskStore.getTask("task-duplicate-family");
      expect(storedTask?.latestRunId).toBe("run-duplicate-latest");
      expect(storedTask?.workflowRuns).toEqual(expect.arrayContaining([
        expect.objectContaining({
          runId: "run-duplicate-parent",
          workflowName: "Task Lifecycle",
          status: WorkflowStatus.PAUSED,
          endedAt: new Date(1500).toISOString(),
        }),
        expect.objectContaining({
          runId: "run-duplicate-latest",
          workflowName: "Backend Agent",
          status: WorkflowStatus.COMPLETED,
          startedAt: new Date(3000).toISOString(),
          endedAt: new Date(3500).toISOString(),
          summary: "Workflow completed successfully.",
          sessionId: "workflow:root-session",
          rootSessionId: "workflow:root-session",
        }),
      ]));
    } finally {
      await taskStore.waitForStoreWrites();
      await taskStore._resetForTests();
      taskStore.configureTaskStore({ storePath: originalStorePath });
      await removeDirWithRetries(taskStoreDir, { ignoreFinalEperm: true });
    }
  });

  it("scopes persisted run summaries to the current run identity", () => {
    const detail = {
      startedAt: 100,
      endedAt: 200,
      duration: 100,
      data: {
        _workflowRootRunId: "root-run-1",
        _workflowRootTaskId: "task-current",
        _workflowParentTaskId: "task-current",
        taskId: "task-current",
        taskTitle: "Current Task",
        sessionId: "session-current",
        _taskWorkflowEvents: [
          {
            runId: "run-current",
            taskId: "task-current",
            taskTitle: "Current Task",
            sessionId: "session-current",
          },
          {
            runId: "run-other",
            taskId: "task-other",
            taskTitle: "Other Task",
            sessionId: "session-other",
          },
        ],
      },
      nodeStatuses: {},
      nodeStatusEvents: [],
      logs: [],
      errors: [],
    };

    const summary = engine._buildSummaryFromDetail({
      runId: "run-current",
      workflowId: "template-task-lifecycle",
      workflowName: "Task Lifecycle",
      status: WorkflowStatus.COMPLETED,
      detail,
    });

    expect(summary.taskId).toBe("task-current");
    expect(summary.taskIds).toEqual(["task-current"]);
    expect(summary.taskTitle).toBe("Current Task");
    expect(summary.sessionId).toBe("session-current");
    expect(summary.sessionIds).toEqual(["session-current"]);
    expect(summary.delegationTopology).toEqual(expect.objectContaining({
      runId: "run-current",
      taskId: "task-current",
      taskIds: ["task-current"],
      sessionId: "session-current",
      sessionIds: ["session-current"],
    }));
  });

  it("sanitizes live timeout handles before checkpoint persistence", async () => {
    const runId = "run-timeout-checkpoint";
    const timer = setTimeout(() => {}, 60_000);
    if (typeof timer?.unref === "function") timer.unref();

    const ctx = new WorkflowContext({
      _workflowId: "wf-checkpoint-timeout",
      _workflowName: "Checkpoint Timeout",
      timeoutHandle: timer,
    });
    ctx.id = runId;

    engine._activeRuns.set(runId, {
      ctx,
      workflowId: "wf-checkpoint-timeout",
      workflowName: "Checkpoint Timeout",
      status: WorkflowStatus.RUNNING,
    });

    try {
      const detail = engine._serializeRunContext(ctx, true);
      expect(detail.data.timeoutHandle).toBe("[Timeout]");
    } finally {
      clearTimeout(timer);
      engine._activeRuns.delete(runId);
    }
  });

  it("compacts oversized completed run details for task-heavy loop outputs", () => {
    const timeline = Array.from({ length: 300 }, (_, index) => ({
      id: `timeline-${index}`,
      at: `2026-04-04T16:${String(index % 60).padStart(2, "0")}:00.000Z`,
      type: "workflow.node.complete",
      message: `event-${index}`,
    }));
    const taskPayload = {
      taskId: "task-compact-1",
      taskTitle: "Compact me",
      branch: "task/compact-me",
      repoRoot: "C:/repo",
      worktreePath: "C:/repo/.cache/worktrees/task-compact-me",
      repository: "virtengine/bosun",
      baseBranch: "main",
      defaultTargetBranch: "main",
      meta: {
        blockedReason: "worktree_failure",
        worktreeFailure: {
          branch: "task/compact-me",
          repoRoot: "C:/repo",
          worktreePath: "C:/repo/.cache/worktrees/task-compact-me",
          baseBranch: "main",
          defaultTargetBranch: "main",
        },
        timeline,
      },
    };

    const ctx = new WorkflowContext({
      _workflowId: "wf-compact",
      _workflowName: "Compact Workflow",
    });
    ctx.setNodeOutput("query-blocked", {
      success: true,
      output: [taskPayload, taskPayload, taskPayload],
    });
    ctx.setNodeOutput("recover-each", {
      count: 3,
      totalItems: 3,
      variable: "item",
      results: Array.from({ length: 3 }, (_, index) => ({
        index,
        item: taskPayload,
        success: true,
        mode: "dispatch",
        workflowId: "template-recover-blocked-task",
      })),
      successCount: 3,
      failCount: 0,
    });

    const detail = engine._serializeRunContext(ctx, false);
    expect(detail.nodeOutputs["query-blocked"].output[0]).toMatchObject({
      taskId: "task-compact-1",
      branch: "task/compact-me",
      meta: expect.objectContaining({
        blockedReason: "worktree_failure",
        timelineCount: 300,
      }),
    });
    expect(detail.nodeOutputs["query-blocked"].output[0].meta.timeline).toBeUndefined();
    expect(detail.nodeOutputs["recover-each"].results[0].item.meta.timeline).toBeUndefined();
    expect(detail.nodeOutputs["recover-each"].results[0].item.meta.timelineCount).toBe(300);
    expect(JSON.stringify(detail).length).toBeLessThan(60_000);
  });

  it("tasks.update can delete selected metadata keys without overwriting remaining meta", async () => {
    const kanban = {
      getTask: vi.fn(async () => ({
        id: "task-1",
        meta: {
          keepMe: "yes",
          autoRecovery: { active: true },
          worktreeFailure: { branch: "task/test" },
          blockedReason: "worktree_failure",
        },
      })),
      updateTask: vi.fn(async (_taskId, update) => update),
    };
    makeTmpEngine({ kanban });

    const workflow = makeSimpleWorkflow([
      { id: "start", type: "trigger.manual", label: "Start", config: {} },
      {
        id: "update",
        type: "action.bosun_function",
        label: "Update Task",
        config: {
          function: "tasks.update",
          args: {
            taskId: "task-1",
            metaDeleteKeys: ["autoRecovery", "worktreeFailure", "blockedReason"],
            fields: {
              blockedReason: null,
              cooldownUntil: null,
            },
          },
        },
      },
    ], [
      { id: "start-update", source: "start", target: "update" },
    ], {
      id: "wf-task-update-meta-delete",
      name: "Task Update Meta Delete",
    });

    engine.save(workflow);
    await engine.execute(workflow.id, {});

    expect(kanban.getTask).toHaveBeenCalledWith("task-1");
    expect(kanban.updateTask).toHaveBeenCalledWith("task-1", expect.objectContaining({
      blockedReason: null,
      cooldownUntil: null,
      meta: { keepMe: "yes" },
    }));
  });

  it("loads persisted run detail from sqlite when the detail file is missing", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-sql-detail", name: "SQL Detail Workflow" },
    );
    engine.save(wf);

    const ctx = await engine.execute(wf.id, {});
    const detailPath = join(engine.runsDir, `${ctx.id}.json`);
    const indexPath = join(engine.runsDir, "index.json");
    expect(existsSync(detailPath)).toBe(true);

    rmSync(detailPath, { force: true });
    writeFileSync(indexPath, JSON.stringify({ runs: [] }, null, 2), "utf8");

    const persisted = engine.getRunDetail(ctx.id);
    expect(persisted).toMatchObject({
      runId: ctx.id,
      workflowId: wf.id,
      status: WorkflowStatus.COMPLETED,
    });
    expect(persisted?.detail?.data?._workflowId).toBe(wf.id);
    expect(Array.isArray(persisted?.detail?.logs)).toBe(true);

    const history = engine.getRunHistory(wf.id, 1);
    expect(history[0]).toMatchObject({
      runId: ctx.id,
      workflowId: wf.id,
      status: WorkflowStatus.COMPLETED,
    });
  });

  it("rebuilds the legacy run index from sqlite summaries when index.json is missing", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-sql-index", name: "SQL Index Workflow" },
    );
    engine.save(wf);

    const ctx = await engine.execute(wf.id, {});
    const indexPath = join(engine.runsDir, "index.json");
    rmSync(indexPath, { force: true });

    const rebuilt = engine._readRunIndex();
    expect(rebuilt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: ctx.id,
          workflowId: wf.id,
          status: WorkflowStatus.COMPLETED,
        }),
      ]),
    );
  });

  it("reclassifies stale RUNNING index entries as interrupted on startup recovery", () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-interrupted-index", name: "Interrupted Index Workflow" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const runId = "run-interrupted-index";
    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [{
          runId,
          workflowId: wf.id,
          workflowName: wf.name,
          status: WorkflowStatus.RUNNING,
          startedAt: 1,
          endedAt: null,
        }],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${runId}.json`),
      JSON.stringify({
        id: runId,
        startedAt: 1,
        endedAt: null,
        data: { _workflowId: wf.id, _workflowName: wf.name },
        nodeStatuses: { trigger: NodeStatus.COMPLETED, dispatch: NodeStatus.RUNNING },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    engine._detectInterruptedRuns();

    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const recovered = index.runs.find((entry) => entry.runId === runId);
    expect(recovered).toBeTruthy();
    expect(recovered.status).toBe(WorkflowStatus.PAUSED);
    expect(recovered.resumable).toBe(true);
    expect(typeof recovered.interruptedAt).toBe("number");
  });

  it("hydrates orphan running detail files into paused resumable index entries", () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-interrupted-orphan", name: "Interrupted Orphan Workflow" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const runId = "run-interrupted-orphan";
    writeFileSync(join(runsDir, "index.json"), JSON.stringify({ runs: [] }, null, 2), "utf8");
    writeFileSync(
      join(runsDir, `${runId}.json`),
      JSON.stringify({
        id: runId,
        startedAt: 1,
        endedAt: null,
        data: { _workflowId: wf.id, _workflowName: wf.name },
        nodeStatuses: { trigger: NodeStatus.RUNNING },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    engine._detectInterruptedRuns();

    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const recovered = index.runs.find((entry) => entry.runId === runId);
    expect(recovered).toBeTruthy();
    expect(recovered.workflowId).toBe(wf.id);
    expect(recovered.status).toBe(WorkflowStatus.PAUSED);
    expect(recovered.resumable).toBe(true);
    expect(typeof recovered.endedAt).toBe("number");
    expect(recovered.activeNodeCount).toBe(0);
  });

  it("includes existing paused resumable runs in the startup interrupted cohort", () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-interrupted-startup-cohort", name: "Interrupted Startup Cohort Workflow" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const historicalPausedRunId = "run-paused-existing";
    const freshInterruptedRunId = "run-running-current";
    const interruptedEvents = [];

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: historicalPausedRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: 1500,
            interruptedAt: 1500,
            resumable: true,
          },
          {
            runId: freshInterruptedRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.RUNNING,
            startedAt: 2000,
            endedAt: null,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${historicalPausedRunId}.json`),
      JSON.stringify({
        id: historicalPausedRunId,
        startedAt: 1000,
        endedAt: 1500,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          taskId: "task-historical-existing",
        },
        nodeStatuses: { trigger: NodeStatus.COMPLETED },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${freshInterruptedRunId}.json`),
      JSON.stringify({
        id: freshInterruptedRunId,
        startedAt: 2000,
        endedAt: null,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          taskId: "task-current-running",
        },
        nodeStatuses: { trigger: NodeStatus.RUNNING },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, "_active-runs.json"),
      JSON.stringify([
        {
          runId: freshInterruptedRunId,
          workflowId: wf.id,
          workflowName: wf.name,
          taskId: "task-current-running",
        },
      ], null, 2),
      "utf8",
    );

    engine.on("runs:interrupted", (event) => interruptedEvents.push(event));

    engine._detectInterruptedRuns();

    expect(interruptedEvents).toHaveLength(1);
    expect(interruptedEvents[0]?.runs.map((entry) => entry.runId).sort()).toEqual(
      [freshInterruptedRunId, historicalPausedRunId].sort(),
    );
    expect(Array.from(engine._startupInterruptedRunIds || []).sort()).toEqual(
      [freshInterruptedRunId, historicalPausedRunId].sort(),
    );

    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const historical = index.runs.find((entry) => entry.runId === historicalPausedRunId);
    expect(historical).toBeTruthy();
    expect(historical.status).toBe(WorkflowStatus.PAUSED);
    expect(historical.resumable).toBe(true);
    expect(typeof historical.interruptedAt).toBe("number");
  });

  it("marks interrupted task-lifecycle shell runs with unresolved task placeholders as non-resumable", () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-interrupted-lifecycle-shell", name: "Task Lifecycle" },
    );
    wf.metadata = {
      ...(wf.metadata || {}),
      installedFrom: "template-task-lifecycle",
    };
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const runId = "run-lifecycle-shell";
    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [{
          runId,
          workflowId: wf.id,
          workflowName: wf.name,
          status: WorkflowStatus.RUNNING,
          startedAt: 1,
          endedAt: null,
        }],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${runId}.json`),
      JSON.stringify({
        id: runId,
        startedAt: 1,
        endedAt: null,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          taskId: "{{taskId}}",
          taskTitle: "{{taskTitle}}",
        },
        nodeStatuses: { trigger: NodeStatus.RUNNING },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    engine._detectInterruptedRuns();

    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const recovered = index.runs.find((entry) => entry.runId === runId);
    expect(recovered).toBeTruthy();
    expect(recovered.status).toBe(WorkflowStatus.PAUSED);
    expect(recovered.resumable).toBe(false);
    expect(recovered.resumeResult).toBe("invalid_task_identity");
  });

  it("skips retrying paused task-lifecycle shell runs with unresolved task placeholders", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-paused-lifecycle-shell", name: "Task Lifecycle" },
    );
    wf.metadata = {
      ...(wf.metadata || {}),
      installedFrom: "template-task-lifecycle",
    };
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const runId = "run-paused-lifecycle-shell";
    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [{
          runId,
          workflowId: wf.id,
          workflowName: wf.name,
          status: WorkflowStatus.PAUSED,
          startedAt: 1,
          endedAt: null,
          resumable: true,
        }],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${runId}.json`),
      JSON.stringify({
        id: runId,
        startedAt: 1,
        endedAt: null,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          taskId: "{{taskId}}",
          taskTitle: "{{taskTitle}}",
        },
        nodeStatuses: { trigger: NodeStatus.RUNNING },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    const retrySpy = vi.spyOn(engine, "retryRun").mockResolvedValue({ resumed: true });

    await engine.resumeInterruptedRuns();

    expect(retrySpy).not.toHaveBeenCalled();
    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const interrupted = index.runs.find((entry) => entry.runId === runId);
    expect(interrupted?.resumable).toBe(false);
    expect(interrupted?.resumeResult).toBe("invalid_task_identity");
  });

  it("does not resume an interrupted task run when a newer run already exists for the same task", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-superseded", name: "Resume Superseded Workflow" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const interruptedRunId = "run-interrupted-older";
    const newerRunId = "run-newer-active";
    const taskId = "task-shared-1";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: interruptedRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: null,
            resumable: true,
          },
          {
            runId: newerRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.RUNNING,
            startedAt: 2000,
            endedAt: null,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${interruptedRunId}.json`),
      JSON.stringify({
        id: interruptedRunId,
        startedAt: 1000,
        endedAt: null,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          taskId,
        },
        nodeStatuses: { trigger: NodeStatus.COMPLETED },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${newerRunId}.json`),
      JSON.stringify({
        id: newerRunId,
        startedAt: 2000,
        endedAt: null,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          taskId,
        },
        nodeStatuses: { trigger: NodeStatus.RUNNING },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    const retrySpy = vi.spyOn(engine, "retryRun").mockResolvedValue({ resumed: true });

    await engine.resumeInterruptedRuns();

    expect(retrySpy).not.toHaveBeenCalled();

    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const interrupted = index.runs.find((entry) => entry.runId === interruptedRunId);
    expect(interrupted).toBeTruthy();
    expect(interrupted.resumable).toBe(false);
    expect(interrupted.resumeResult).toBe("duplicate_task_run");
  });

  it("deduplicates interrupted runs from ledger task identity when detail files omit task ids", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-ledger-dedupe", name: "Resume Ledger Dedupe Workflow" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const olderRunId = "run-ledger-older";
    const newerRunId = "run-ledger-newer";
    const taskId = "task-ledger-identity-1";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: olderRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: null,
            resumable: true,
          },
          {
            runId: newerRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 2000,
            endedAt: null,
            resumable: true,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${olderRunId}.json`),
      JSON.stringify({
        id: olderRunId,
        startedAt: 1000,
        endedAt: null,
        data: { _workflowId: wf.id, _workflowName: wf.name },
        nodeStatuses: { trigger: NodeStatus.COMPLETED },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${newerRunId}.json`),
      JSON.stringify({
        id: newerRunId,
        startedAt: 2000,
        endedAt: null,
        data: { _workflowId: wf.id, _workflowName: wf.name },
        nodeStatuses: { trigger: NodeStatus.RUNNING },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    engine._executionLedger.appendEvent({
      eventType: "run.start",
      runId: olderRunId,
      workflowId: wf.id,
      workflowName: wf.name,
      status: WorkflowStatus.RUNNING,
      timestamp: new Date(1000).toISOString(),
      meta: { taskId, taskTitle: "Ledger Task" },
    });
    engine._executionLedger.appendEvent({
      eventType: "run.start",
      runId: newerRunId,
      workflowId: wf.id,
      workflowName: wf.name,
      status: WorkflowStatus.RUNNING,
      timestamp: new Date(2000).toISOString(),
      meta: { taskId, taskTitle: "Ledger Task" },
    });

    const retrySpy = vi.spyOn(engine, "retryRun").mockResolvedValue({ resumed: true });

    await engine.resumeInterruptedRuns();

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(retrySpy).toHaveBeenCalledWith(
      newerRunId,
      expect.objectContaining({ mode: expect.any(String) }),
    );

    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const older = index.runs.find((entry) => entry.runId === olderRunId);
    expect(older).toBeTruthy();
    expect(older.resumable).toBe(false);
    expect(older.resumeResult).toBe("duplicate_task_run");
  });

  it("prioritizes the current interrupted-run scan without starving older paused runs", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-current-scan-only", name: "Resume Current Scan Only" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const historicalPausedRunId = "run-paused-historical";
    const freshInterruptedRunId = "run-interrupted-current";
    const taskId = "task-current-scan-1";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: historicalPausedRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: 1500,
            interruptedAt: 1500,
            resumable: true,
          },
          {
            runId: freshInterruptedRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.RUNNING,
            startedAt: 2000,
            endedAt: null,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${historicalPausedRunId}.json`),
      JSON.stringify({
        id: historicalPausedRunId,
        startedAt: 1000,
        endedAt: 1500,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          taskId: "task-historical-1",
        },
        nodeStatuses: { trigger: NodeStatus.COMPLETED },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${freshInterruptedRunId}.json`),
      JSON.stringify({
        id: freshInterruptedRunId,
        startedAt: 2000,
        endedAt: null,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          taskId,
        },
        nodeStatuses: { trigger: NodeStatus.RUNNING },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, "_active-runs.json"),
      JSON.stringify([
        {
          runId: freshInterruptedRunId,
          workflowId: wf.id,
          workflowName: wf.name,
          taskId,
        },
      ], null, 2),
      "utf8",
    );

    engine._detectInterruptedRuns();

    const retrySpy = vi.spyOn(engine, "retryRun").mockResolvedValue({ resumed: true });

    await engine.resumeInterruptedRuns();

    expect(retrySpy).toHaveBeenCalledTimes(2);
    expect(retrySpy).toHaveBeenNthCalledWith(
      1,
      freshInterruptedRunId,
      expect.objectContaining({ mode: expect.any(String) }),
    );
    expect(retrySpy).toHaveBeenNthCalledWith(
      2,
      historicalPausedRunId,
      expect.objectContaining({ mode: expect.any(String) }),
    );

    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const historical = index.runs.find((entry) => entry.runId === historicalPausedRunId);
    const fresh = index.runs.find((entry) => entry.runId === freshInterruptedRunId);
    expect(historical).toBeTruthy();
    expect(historical.resumable).toBe(false);
    expect(historical.resumeResult).toBe("resumed");
    expect(fresh?.resumeResult).toBe("resumed");
  });

  it("does not block later interrupted resumes behind a long-running first retry", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-no-serial-block", name: "Resume Without Serial Blocking" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const firstRunId = "run-interrupted-first";
    const secondRunId = "run-interrupted-second";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: firstRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: 1500,
            interruptedAt: 2000,
            resumable: true,
            taskId: "task-resume-first",
          },
          {
            runId: secondRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 2000,
            endedAt: 2500,
            interruptedAt: 2100,
            resumable: true,
            taskId: "task-resume-second",
          },
        ],
      }, null, 2),
      "utf8",
    );
    for (const [runId, taskId, startedAt, endedAt] of [
      [firstRunId, "task-resume-first", 1000, 1500],
      [secondRunId, "task-resume-second", 2000, 2500],
    ]) {
      writeFileSync(
        join(runsDir, `${runId}.json`),
        JSON.stringify({
          id: runId,
          startedAt,
          endedAt,
          data: {
            _workflowId: wf.id,
            _workflowName: wf.name,
            taskId,
          },
          nodeStatuses: { trigger: NodeStatus.COMPLETED },
          nodeStatusEvents: [],
          logs: [],
          errors: [],
        }, null, 2),
        "utf8",
      );
    }

    let releaseFirstRetry;
    const firstRetryPending = new Promise((resolve) => {
      releaseFirstRetry = resolve;
    });
    const retrySpy = vi.spyOn(engine, "retryRun").mockImplementation((runId) => {
      if (runId === firstRunId) {
        return firstRetryPending.then(() => ({ resumed: true }));
      }
      return Promise.resolve({ resumed: true });
    });

    const resumePromise = engine.resumeInterruptedRuns();

    await vi.waitFor(() => {
      expect(retrySpy).toHaveBeenCalledTimes(2);
    });

    const resumedRunIds = retrySpy.mock.calls.map(([runId]) => runId).sort();
    expect(resumedRunIds).toEqual([firstRunId, secondRunId].sort());

    releaseFirstRetry();
    await resumePromise;

    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const first = index.runs.find((entry) => entry.runId === firstRunId);
    const second = index.runs.find((entry) => entry.runId === secondRunId);
    expect(first?.resumeResult).toBe("resumed");
    expect(second?.resumeResult).toBe("resumed");
  });

  it("does not load the full execution ledger during interrupted-run dedupe", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-no-ledger-sweep", name: "Resume Without Ledger Sweep" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const historicalPausedRunId = "run-ledger-old";
    const latestPausedRunId = "run-ledger-latest";
    const taskId = "task-ledger-scan-1";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: historicalPausedRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: 1500,
            interruptedAt: 1500,
            resumable: true,
            taskId,
          },
          {
            runId: latestPausedRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 2000,
            endedAt: 2500,
            interruptedAt: 2500,
            resumable: true,
            taskId,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${historicalPausedRunId}.json`),
      JSON.stringify({
        id: historicalPausedRunId,
        startedAt: 1000,
        endedAt: 1500,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          taskId,
        },
        nodeStatuses: { trigger: NodeStatus.COMPLETED },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${latestPausedRunId}.json`),
      JSON.stringify({
        id: latestPausedRunId,
        startedAt: 2000,
        endedAt: 2500,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          taskId,
        },
        nodeStatuses: { trigger: NodeStatus.COMPLETED },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    const ledgerSpy = vi.spyOn(engine._executionLedger, "listTaskRunEntries").mockImplementation(() => {
      throw new Error("full ledger sweep should not run during resume dedupe");
    });
    const retrySpy = vi.spyOn(engine, "retryRun").mockResolvedValue({ resumed: true });

    await engine.resumeInterruptedRuns();

    expect(ledgerSpy).not.toHaveBeenCalled();
    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(retrySpy).toHaveBeenCalledWith(
      latestPausedRunId,
      expect.objectContaining({ mode: expect.any(String) }),
    );
    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const historical = index.runs.find((entry) => entry.runId === historicalPausedRunId);
    expect(historical?.resumeResult).toBe("duplicate_task_run");
  });

  it("only resumes the most recently interrupted paused cohort when no startup queue is present", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-latest-interrupted-cohort", name: "Resume Latest Interrupted Cohort" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const historicalPausedRunId = "run-paused-old-cohort";
    const latestPausedRunId = "run-paused-latest-cohort";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: historicalPausedRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: 1500,
            interruptedAt: 1500,
            resumable: true,
          },
          {
            runId: latestPausedRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 2000,
            endedAt: 2500,
            interruptedAt: 2500,
            resumable: true,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${historicalPausedRunId}.json`),
      JSON.stringify({
        id: historicalPausedRunId,
        startedAt: 1000,
        endedAt: 1500,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          taskId: "task-old-cohort",
        },
        nodeStatuses: { trigger: NodeStatus.COMPLETED },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${latestPausedRunId}.json`),
      JSON.stringify({
        id: latestPausedRunId,
        startedAt: 2000,
        endedAt: 2500,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          taskId: "task-latest-cohort",
        },
        nodeStatuses: { trigger: NodeStatus.COMPLETED },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    const retrySpy = vi.spyOn(engine, "retryRun").mockResolvedValue({ resumed: true });

    await engine.resumeInterruptedRuns();

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(retrySpy).toHaveBeenCalledWith(
      latestPausedRunId,
      expect.objectContaining({ mode: expect.any(String) }),
    );

    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const historical = index.runs.find((entry) => entry.runId === historicalPausedRunId);
    expect(historical).toBeTruthy();
    expect(historical.resumable).toBe(true);
    expect(historical.resumeResult).toBeUndefined();
  });

  it("skips interrupted descendant runs when their root run is also being resumed", async () => {
    const root = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-root-family", name: "Resume Root Family" },
    );
    const child = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-child-family", name: "Resume Child Family" },
    );
    engine.save(root);
    engine.save(child);

    const runsDir = join(tmpDir, "runs");
    const rootRunId = "run-root-interrupted";
    const childRunId = "run-child-interrupted";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: rootRunId,
            workflowId: root.id,
            workflowName: root.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: 1500,
            interruptedAt: 1500,
            resumable: true,
            rootRunId,
            taskId: "task-family-root",
          },
          {
            runId: childRunId,
            workflowId: child.id,
            workflowName: child.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1100,
            endedAt: 1500,
            interruptedAt: 1500,
            resumable: true,
            rootRunId,
            taskId: "task-family-child",
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${rootRunId}.json`),
      JSON.stringify({
        id: rootRunId,
        startedAt: 1000,
        endedAt: 1500,
        data: {
          _workflowId: root.id,
          _workflowName: root.name,
          _workflowRootRunId: rootRunId,
          taskId: "task-family-root",
        },
        dagState: {
          rootRunId,
        },
        nodeStatuses: { trigger: NodeStatus.RUNNING },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${childRunId}.json`),
      JSON.stringify({
        id: childRunId,
        startedAt: 1100,
        endedAt: 1500,
        data: {
          _workflowId: child.id,
          _workflowName: child.name,
          _workflowRootRunId: rootRunId,
          taskId: "task-family-child",
        },
        dagState: {
          rootRunId,
        },
        nodeStatuses: { trigger: NodeStatus.RUNNING },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    const retrySpy = vi.spyOn(engine, "retryRun").mockResolvedValue({ resumed: true });

    await engine.resumeInterruptedRuns();

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(retrySpy).toHaveBeenCalledWith(
      rootRunId,
      expect.objectContaining({ mode: expect.any(String) }),
    );

    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const childEntry = index.runs.find((entry) => entry.runId === childRunId);
    expect(childEntry).toBeTruthy();
    expect(childEntry.resumable).toBe(false);
    expect(childEntry.resumeResult).toBe("covered_by_root_interrupted_run");
  });

  it("prefers the interrupted same-task ancestor run over a newer child workflow run", async () => {
    const parent = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-task-ancestor", name: "Resume Task Ancestor" },
    );
    const child = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-task-child", name: "Resume Task Child" },
    );
    engine.save(parent);
    engine.save(child);

    const runsDir = join(tmpDir, "runs");
    const parentRunId = "run-task-ancestor";
    const childRunId = "run-task-child";
    const sharedTaskId = "task-shared-family-1";
    const sharedRootRunId = "run-batch-root";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: parentRunId,
            workflowId: parent.id,
            workflowName: parent.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: 1500,
            interruptedAt: 1500,
            resumable: true,
            rootRunId: sharedRootRunId,
            taskId: sharedTaskId,
            activeNodeCount: 1,
          },
          {
            runId: childRunId,
            workflowId: child.id,
            workflowName: child.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1100,
            endedAt: 1500,
            interruptedAt: 1500,
            resumable: true,
            rootRunId: sharedRootRunId,
            parentRunId: parentRunId,
            taskId: sharedTaskId,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${parentRunId}.json`),
      JSON.stringify({
        id: parentRunId,
        startedAt: 1000,
        endedAt: 1500,
        data: {
          _workflowId: parent.id,
          _workflowName: parent.name,
          _workflowRootRunId: sharedRootRunId,
          taskId: sharedTaskId,
        },
        dagState: {
          rootRunId: sharedRootRunId,
        },
        nodeStatuses: { trigger: NodeStatus.RUNNING },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${childRunId}.json`),
      JSON.stringify({
        id: childRunId,
        startedAt: 1100,
        endedAt: 1500,
        data: {
          _workflowId: child.id,
          _workflowName: child.name,
          _workflowRootRunId: sharedRootRunId,
          _workflowParentRunId: parentRunId,
          taskId: sharedTaskId,
        },
        dagState: {
          rootRunId: sharedRootRunId,
          parentRunId: parentRunId,
        },
        nodeStatuses: { trigger: NodeStatus.RUNNING },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    const retrySpy = vi.spyOn(engine, "retryRun").mockResolvedValue({ resumed: true });

    await engine.resumeInterruptedRuns();

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(retrySpy).toHaveBeenCalledWith(
      parentRunId,
      expect.objectContaining({ mode: expect.any(String) }),
    );

    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const childEntry = index.runs.find((entry) => entry.runId === childRunId);
    expect(childEntry).toBeTruthy();
    expect(childEntry.resumable).toBe(false);
    expect(childEntry.resumeResult).toBe("duplicate_task_run");
  });

  it("keeps a newer paused descendant when an older completed ancestor stores startedAt as ISO text", async () => {
    const parent = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-completed-ancestor", name: "Resume Completed Ancestor" },
    );
    const child = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-newer-descendant", name: "Resume Newer Descendant" },
    );
    engine.save(parent);
    engine.save(child);

    const runsDir = join(tmpDir, "runs");
    const parentRunId = "run-completed-ancestor";
    const childRunId = "run-newer-descendant";
    const sharedTaskId = "task-mixed-started-at-1";
    const sharedRootRunId = "run-mixed-started-at-root";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: parentRunId,
            workflowId: parent.id,
            workflowName: parent.name,
            status: WorkflowStatus.COMPLETED,
            startedAt: "2026-04-23T13:50:14.346Z",
            endedAt: null,
            rootRunId: sharedRootRunId,
            taskId: sharedTaskId,
          },
          {
            runId: childRunId,
            workflowId: child.id,
            workflowName: child.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1776979844431,
            endedAt: null,
            interruptedAt: 1776979844432,
            resumable: true,
            rootRunId: sharedRootRunId,
            parentRunId: parentRunId,
            taskId: sharedTaskId,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${parentRunId}.json`),
      JSON.stringify({
        id: parentRunId,
        startedAt: "2026-04-23T13:50:14.346Z",
        endedAt: null,
        data: {
          _workflowId: parent.id,
          _workflowName: parent.name,
          _workflowRootRunId: sharedRootRunId,
          taskId: sharedTaskId,
        },
        dagState: {
          rootRunId: sharedRootRunId,
        },
        nodeStatuses: { trigger: NodeStatus.COMPLETED },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${childRunId}.json`),
      JSON.stringify({
        id: childRunId,
        startedAt: 1776979844431,
        endedAt: null,
        data: {
          _workflowId: child.id,
          _workflowName: child.name,
          _workflowRootRunId: sharedRootRunId,
          _workflowParentRunId: parentRunId,
          taskId: sharedTaskId,
        },
        dagState: {
          rootRunId: sharedRootRunId,
          parentRunId: parentRunId,
        },
        nodeStatuses: { trigger: NodeStatus.RUNNING },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    const retrySpy = vi.spyOn(engine, "retryRun").mockResolvedValue({ resumed: true });

    await engine.resumeInterruptedRuns();

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(retrySpy).toHaveBeenCalledWith(
      childRunId,
      expect.objectContaining({ mode: expect.any(String) }),
    );

    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const childEntry = index.runs.find((entry) => entry.runId === childRunId);
    expect(childEntry?.resumeResult).toBe("resumed");
  });

  it("keeps the newest same-workflow descendant over an older same-task ancestor run", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-same-workflow-descendant", name: "Resume Same Workflow Descendant" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const ancestorRunId = "run-same-workflow-ancestor";
    const descendantRunId = "run-same-workflow-descendant";
    const sharedTaskId = "task-same-workflow-family-1";
    const sharedRootRunId = "run-same-workflow-root";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: ancestorRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: 1500,
            interruptedAt: 1500,
            resumable: true,
            rootRunId: sharedRootRunId,
            taskId: sharedTaskId,
          },
          {
            runId: descendantRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1100,
            endedAt: 1500,
            interruptedAt: 1500,
            resumable: true,
            rootRunId: sharedRootRunId,
            parentRunId: ancestorRunId,
            taskId: sharedTaskId,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${ancestorRunId}.json`),
      JSON.stringify({
        id: ancestorRunId,
        startedAt: 1000,
        endedAt: 1500,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          _workflowRootRunId: sharedRootRunId,
          taskId: sharedTaskId,
        },
        dagState: {
          rootRunId: sharedRootRunId,
        },
        nodeStatuses: { trigger: NodeStatus.COMPLETED },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${descendantRunId}.json`),
      JSON.stringify({
        id: descendantRunId,
        startedAt: 1100,
        endedAt: 1500,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          _workflowRootRunId: sharedRootRunId,
          _workflowParentRunId: ancestorRunId,
          taskId: sharedTaskId,
        },
        dagState: {
          rootRunId: sharedRootRunId,
          parentRunId: ancestorRunId,
        },
        nodeStatuses: { trigger: NodeStatus.COMPLETED },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    const retrySpy = vi.spyOn(engine, "retryRun").mockResolvedValue({ resumed: true });

    await engine.resumeInterruptedRuns();

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(retrySpy).toHaveBeenCalledWith(
      descendantRunId,
      expect.objectContaining({ mode: expect.any(String) }),
    );

    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const ancestorEntry = index.runs.find((entry) => entry.runId === ancestorRunId);
    expect(ancestorEntry).toBeTruthy();
    expect(ancestorEntry.resumable).toBe(false);
    expect(ancestorEntry.resumeResult).toBe("duplicate_task_run");
  });

  it("re-activates a duplicate same-task ancestor when a newer interrupted descendant restarts", async () => {
    const parent = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-duplicate-ancestor", name: "Resume Duplicate Ancestor" },
    );
    const child = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-duplicate-child", name: "Resume Duplicate Child" },
    );
    const grandchild = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-duplicate-grandchild", name: "Resume Duplicate Grandchild" },
    );
    engine.save(parent);
    engine.save(child);
    engine.save(grandchild);

    const runsDir = join(tmpDir, "runs");
    const parentRunId = "run-duplicate-parent";
    const childRunId = "run-duplicate-child";
    const grandchildRunId = "run-duplicate-grandchild";
    const sharedTaskId = "task-duplicate-ancestor-retry";
    const sharedRootRunId = "run-duplicate-root";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: parentRunId,
            workflowId: parent.id,
            workflowName: parent.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: 1500,
            interruptedAt: 1500,
            resumable: false,
            resumeResult: "duplicate_task_run",
            rootRunId: sharedRootRunId,
            taskId: sharedTaskId,
            activeNodeCount: 1,
          },
          {
            runId: childRunId,
            workflowId: child.id,
            workflowName: child.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1100,
            endedAt: 1500,
            interruptedAt: 1500,
            resumable: false,
            resumeResult: "duplicate_task_run",
            rootRunId: sharedRootRunId,
            parentRunId: parentRunId,
            taskId: sharedTaskId,
            activeNodeCount: 1,
          },
          {
            runId: grandchildRunId,
            workflowId: grandchild.id,
            workflowName: grandchild.name,
            status: WorkflowStatus.RUNNING,
            startedAt: 1200,
            rootRunId: sharedRootRunId,
            parentRunId: childRunId,
            taskId: sharedTaskId,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${parentRunId}.json`),
      JSON.stringify({
        id: parentRunId,
        startedAt: 1000,
        endedAt: 1500,
        data: {
          _workflowId: parent.id,
          _workflowName: parent.name,
          _workflowRootRunId: sharedRootRunId,
          taskId: sharedTaskId,
        },
        dagState: {
          rootRunId: sharedRootRunId,
        },
        nodeStatuses: { trigger: NodeStatus.RUNNING },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${childRunId}.json`),
      JSON.stringify({
        id: childRunId,
        startedAt: 1100,
        endedAt: 1500,
        data: {
          _workflowId: child.id,
          _workflowName: child.name,
          _workflowRootRunId: sharedRootRunId,
          _workflowParentRunId: parentRunId,
          taskId: sharedTaskId,
        },
        dagState: {
          rootRunId: sharedRootRunId,
          parentRunId: parentRunId,
        },
        nodeStatuses: { trigger: NodeStatus.RUNNING },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${grandchildRunId}.json`),
      JSON.stringify({
        id: grandchildRunId,
        startedAt: 1200,
        data: {
          _workflowId: grandchild.id,
          _workflowName: grandchild.name,
          _workflowRootRunId: sharedRootRunId,
          _workflowParentRunId: childRunId,
          taskId: sharedTaskId,
        },
        dagState: {
          rootRunId: sharedRootRunId,
          parentRunId: childRunId,
        },
        nodeStatuses: { trigger: NodeStatus.RUNNING },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    engine._detectInterruptedRuns();

    const retrySpy = vi.spyOn(engine, "retryRun").mockResolvedValue({ resumed: true });

    await engine.resumeInterruptedRuns();

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(retrySpy).toHaveBeenCalledWith(
      parentRunId,
      expect.objectContaining({ mode: expect.any(String) }),
    );

    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const parentEntry = index.runs.find((entry) => entry.runId === parentRunId);
    const childEntry = index.runs.find((entry) => entry.runId === childRunId);
    const grandchildEntry = index.runs.find((entry) => entry.runId === grandchildRunId);
    expect(parentEntry?.resumeResult).toBe("resumed");
    expect(childEntry?.resumeResult).toBe("duplicate_task_run");
    expect(grandchildEntry?.resumeResult).toBe("duplicate_task_run");
  });

  it("does not re-activate a duplicate same-task ancestor without active nodes when a newer descendant is stale", async () => {
    const parent = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-inactive-ancestor", name: "Resume Inactive Ancestor" },
    );
    const child = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-inactive-child", name: "Resume Inactive Child" },
    );
    const grandchild = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-stale-descendant", name: "Resume Stale Descendant" },
    );
    engine.save(parent);
    engine.save(child);
    engine.save(grandchild);

    const runsDir = join(tmpDir, "runs");
    const parentRunId = "run-inactive-parent";
    const childRunId = "run-inactive-child";
    const grandchildRunId = "run-stale-grandchild";
    const sharedTaskId = "task-stale-descendant-holds-reset";
    const sharedRootRunId = "run-stale-descendant-root";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: parentRunId,
            workflowId: parent.id,
            workflowName: parent.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: 1500,
            interruptedAt: 1500,
            resumable: false,
            resumeResult: "duplicate_task_run",
            rootRunId: sharedRootRunId,
            taskId: sharedTaskId,
            activeNodeCount: 0,
          },
          {
            runId: childRunId,
            workflowId: child.id,
            workflowName: child.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1100,
            endedAt: 1500,
            interruptedAt: 1500,
            resumable: true,
            rootRunId: sharedRootRunId,
            parentRunId: parentRunId,
            taskId: sharedTaskId,
            activeNodeCount: 0,
          },
          {
            runId: grandchildRunId,
            workflowId: grandchild.id,
            workflowName: grandchild.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1200,
            endedAt: 1500,
            interruptedAt: 1500,
            resumable: false,
            resumeResult: "recovery_cap_exceeded",
            rootRunId: sharedRootRunId,
            parentRunId: childRunId,
            taskId: sharedTaskId,
            activeNodeCount: 0,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${parentRunId}.json`),
      JSON.stringify({
        id: parentRunId,
        startedAt: 1000,
        endedAt: 1500,
        data: {
          _workflowId: parent.id,
          _workflowName: parent.name,
          _workflowRootRunId: sharedRootRunId,
          taskId: sharedTaskId,
        },
        dagState: {
          rootRunId: sharedRootRunId,
        },
        nodeStatuses: { trigger: NodeStatus.COMPLETED },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${childRunId}.json`),
      JSON.stringify({
        id: childRunId,
        startedAt: 1100,
        endedAt: 1500,
        data: {
          _workflowId: child.id,
          _workflowName: child.name,
          _workflowRootRunId: sharedRootRunId,
          _workflowParentRunId: parentRunId,
          taskId: sharedTaskId,
        },
        dagState: {
          rootRunId: sharedRootRunId,
          parentRunId: parentRunId,
        },
        nodeStatuses: { trigger: NodeStatus.COMPLETED },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${grandchildRunId}.json`),
      JSON.stringify({
        id: grandchildRunId,
        startedAt: 1200,
        endedAt: 1500,
        data: {
          _workflowId: grandchild.id,
          _workflowName: grandchild.name,
          _workflowRootRunId: sharedRootRunId,
          _workflowParentRunId: childRunId,
          taskId: sharedTaskId,
        },
        dagState: {
          rootRunId: sharedRootRunId,
          parentRunId: childRunId,
        },
        nodeStatuses: {
          trigger: NodeStatus.COMPLETED,
          "write-tests": NodeStatus.PENDING,
        },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    engine._detectInterruptedRuns();

    const retrySpy = vi.spyOn(engine, "retryRun").mockResolvedValue({ resumed: true });

    await engine.resumeInterruptedRuns();

    expect(retrySpy).not.toHaveBeenCalled();

    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const parentEntry = index.runs.find((entry) => entry.runId === parentRunId);
    const childEntry = index.runs.find((entry) => entry.runId === childRunId);
    const grandchildEntry = index.runs.find((entry) => entry.runId === grandchildRunId);
    expect(parentEntry?.resumable).toBe(false);
    expect(parentEntry?.resumeResult).toBe("duplicate_task_run");
    expect(childEntry?.resumable).toBe(false);
    expect(childEntry?.resumeResult).toBe("duplicate_task_run");
    expect(grandchildEntry?.resumeResult).toBe("recovery_cap_exceeded");
  });

  it("retries a stranded failed latest descendant after its paused ancestor was already resumed", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-stranded-failed-descendant", name: "Stranded Failed Descendant" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const ancestorRunId = "run-stranded-ancestor";
    const failedRunId = "run-stranded-failed";
    const sharedTaskId = "task-stranded-failed-1";
    const sharedRootRunId = "run-stranded-root";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: ancestorRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: 1050,
            interruptedAt: 1050,
            resumable: false,
            resumeResult: "resumed",
            rootRunId: sharedRootRunId,
            taskId: sharedTaskId,
          },
          {
            runId: failedRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.FAILED,
            startedAt: 1100,
            endedAt: 1200,
            rootRunId: sharedRootRunId,
            parentRunId: ancestorRunId,
            retryOf: ancestorRunId,
            taskId: sharedTaskId,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${ancestorRunId}.json`),
      JSON.stringify({
        id: ancestorRunId,
        startedAt: 1000,
        endedAt: 1050,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          _workflowRootRunId: sharedRootRunId,
          taskId: sharedTaskId,
        },
        dagState: {
          rootRunId: sharedRootRunId,
        },
        issueAdvisor: {
          recommendedAction: "continue",
          summary: "Workflow is ready to continue.",
        },
        nodeStatuses: { trigger: NodeStatus.COMPLETED },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${failedRunId}.json`),
      JSON.stringify({
        id: failedRunId,
        startedAt: 1100,
        endedAt: 1200,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          _workflowRootRunId: sharedRootRunId,
          _workflowParentRunId: ancestorRunId,
          taskId: sharedTaskId,
        },
        dagState: {
          rootRunId: sharedRootRunId,
          parentRunId: ancestorRunId,
          counts: { completed: 1, failed: 1 },
        },
        issueAdvisor: {
          recommendedAction: "replan_from_failed",
          summary: "Retry requires replanning from the failed node",
        },
        nodeStatuses: {
          trigger: NodeStatus.COMPLETED,
          "write-tests": NodeStatus.FAILED,
        },
        nodeStatusEvents: [],
        logs: [],
        errors: [{ nodeId: "write-tests", error: "Invalid string length" }],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    const retrySpy = vi.spyOn(engine, "retryRun").mockResolvedValue({ resumed: true });

    await engine.resumeInterruptedRuns();

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(retrySpy).toHaveBeenCalledWith(
      failedRunId,
      expect.objectContaining({
        mode: "replan_from_failed",
        _decisionReason: "issue_advisor.replan_from_failed",
      }),
    );

    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const ancestorEntry = index.runs.find((entry) => entry.runId === ancestorRunId);
    const failedEntry = index.runs.find((entry) => entry.runId === failedRunId);
    expect(ancestorEntry?.resumeResult).toBe("resumed");
    expect(failedEntry?.resumable).toBe(false);
    expect(failedEntry?.resumeResult).toBe("resumed");
  });

  it("does not resume taskless scheduled workflows from interrupted startup state", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.schedule", label: "Poll", config: { intervalMs: 90000 } }],
      [],
      { id: "wf-scheduled-startup-resume-guard", name: "Bosun PR Watchdog" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const runId = "run-scheduled-taskless";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: 1500,
            interruptedAt: 1500,
            resumable: true,
            triggerSource: "schedule-poll",
            triggeredBy: "trigger",
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${runId}.json`),
      JSON.stringify({
        id: runId,
        startedAt: 1000,
        endedAt: 1500,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
        },
        nodeStatuses: { trigger: NodeStatus.COMPLETED },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    const retrySpy = vi.spyOn(engine, "retryRun").mockResolvedValue({ resumed: true });

    await engine.resumeInterruptedRuns();

    expect(retrySpy).not.toHaveBeenCalled();
    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const entry = index.runs.find((item) => item.runId === runId);
    expect(entry).toBeTruthy();
    expect(entry.resumable).toBe(false);
    expect(entry.resumeResult).toBe("scheduled_non_task_run");
  });

  it("refreshes migrated task-lifecycle defaults when retrying an interrupted run", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      {
        id: "wf-resume-migrated-default",
        name: "Resume Migrated Default",
        variables: { prePrValidationCommand: "auto" },
      },
    );
    wf.metadata = {
      ...(wf.metadata || {}),
      installedFrom: "template-task-lifecycle",
    };
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const interruptedRunId = "run-stale-quality-gate";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: interruptedRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: null,
            resumable: true,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${interruptedRunId}.json`),
      JSON.stringify({
        id: interruptedRunId,
        startedAt: 1000,
        endedAt: null,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          taskId: "task-shared-1",
          prePrValidationCommand: "npm run prepush:check",
        },
        nodeStatuses: { trigger: NodeStatus.COMPLETED },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    const executeDagSpy = vi.spyOn(engine, "_executeDag").mockResolvedValue();

    const { retryRunId } = await engine.retryRun(interruptedRunId, { mode: "from_failed" });

    expect(executeDagSpy).toHaveBeenCalledTimes(1);
    const resumedCtx = executeDagSpy.mock.calls[0][3];
    expect(resumedCtx.data.prePrValidationCommand).toBe("auto");

    const resumedRun = engine.getRunDetail(retryRunId);
    expect(resumedRun?.detail?.data?.prePrValidationCommand).toBe("auto");
  });

  it("replays only the satisfied branch when retrying from_failed", async () => {
    const executedNodes = [];
    registerNodeType("test.retry_resume_record", {
      describe: () => "Records retry-resume execution",
      schema: { type: "object", properties: {} },
      async execute(node) {
        executedNodes.push(node.id);
        return { ok: true, nodeId: node.id };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "branch", type: "condition.expression", label: "Branch", config: { expression: "true" } },
        { id: "success-path", type: "test.retry_resume_record", label: "Success Path", config: {} },
        { id: "wrong-path", type: "test.retry_resume_record", label: "Wrong Path", config: {} },
        { id: "resume-node", type: "test.retry_resume_record", label: "Resume Node", config: {} },
      ],
      [
        { id: "t-branch", source: "trigger", target: "branch" },
        { id: "branch-yes", source: "branch", target: "success-path", sourcePort: "yes", condition: "$output?.result === true" },
        { id: "branch-no", source: "branch", target: "wrong-path", sourcePort: "no", condition: "$output?.result !== true" },
        { id: "success-resume", source: "success-path", target: "resume-node" },
      ],
      { id: "wf-retry-resume-branching", name: "Retry Resume Branching" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const interruptedRunId = "run-retry-resume-branching";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: interruptedRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: null,
            resumable: true,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${interruptedRunId}.json`),
      JSON.stringify({
        id: interruptedRunId,
        startedAt: 1000,
        endedAt: null,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          taskId: "task-branching-1",
        },
        nodeStatuses: {
          trigger: NodeStatus.COMPLETED,
          branch: NodeStatus.COMPLETED,
          "success-path": NodeStatus.COMPLETED,
          "resume-node": NodeStatus.FAILED,
        },
        nodeOutputs: {
          trigger: { triggered: true },
          branch: { result: true },
          "success-path": { ok: true, nodeId: "success-path" },
        },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    const { retryRunId } = await engine.retryRun(interruptedRunId, { mode: "from_failed" });

    expect(retryRunId).toBeTruthy();
    expect(executedNodes).toEqual(["resume-node"]);
    const resumedRun = engine.getRunDetail(retryRunId);
    expect(resumedRun?.detail?.nodeStatuses?.["wrong-path"]).toBe(NodeStatus.SKIPPED);
    expect(resumedRun?.detail?.nodeStatuses?.["resume-node"]).toBe(NodeStatus.COMPLETED);
  });

  it("restarts task-lifecycle retries from claim-task when prior runtime state carried task resources", async () => {
    const executedNodes = [];
    registerNodeType("test.retry_resume_task_resource", {
      describe: () => "Records task-resource retry execution",
      schema: { type: "object", properties: {} },
      async execute(node, ctx) {
        executedNodes.push(node.id);
        if (node.id === "claim-task") {
          return { success: true, claimToken: "claim-new" };
        }
        if (node.id === "acquire-worktree") {
          const worktreePath = join(tmpDir, "retried-worktree");
          ctx.data.worktreePath = worktreePath;
          return { success: true, worktreePath };
        }
        return { ok: true, nodeId: node.id };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "claim-task", type: "test.retry_resume_task_resource", label: "Claim Task", config: {} },
        { id: "acquire-worktree", type: "test.retry_resume_task_resource", label: "Acquire Worktree", config: {} },
        { id: "detect-commits", type: "test.retry_resume_task_resource", label: "Detect Commits", config: {} },
      ],
      [
        { id: "t-claim", source: "trigger", target: "claim-task" },
        { id: "claim-acquire", source: "claim-task", target: "acquire-worktree" },
        { id: "acquire-detect", source: "acquire-worktree", target: "detect-commits" },
      ],
      {
        id: "wf-retry-reset-task-resources",
        name: "Retry Reset Task Resources",
        metadata: { installedFrom: "template-task-lifecycle" },
      },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const interruptedRunId = "run-retry-reset-task-resources";
    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: interruptedRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: null,
            resumable: true,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${interruptedRunId}.json`),
      JSON.stringify({
        id: interruptedRunId,
        startedAt: 1000,
        endedAt: null,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          _workflowSessionId: "workflow-session-old",
          taskId: "task-resource-reset-1",
          claimToken: "claim-old",
          worktreePath: join(tmpDir, "stale-worktree"),
        },
        nodeStatuses: {
          trigger: NodeStatus.COMPLETED,
          "claim-task": NodeStatus.COMPLETED,
          "acquire-worktree": NodeStatus.COMPLETED,
          "detect-commits": NodeStatus.FAILED,
        },
        nodeOutputs: {
          trigger: { triggered: true },
          "claim-task": { success: true, claimToken: "claim-old" },
          "acquire-worktree": { success: true, worktreePath: join(tmpDir, "stale-worktree") },
        },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    const { retryRunId } = await engine.retryRun(interruptedRunId, { mode: "from_failed" });

    expect(executedNodes).toEqual(["claim-task", "acquire-worktree", "detect-commits"]);
    const resumedRun = engine.getRunDetail(retryRunId);
    const [resumeRevision, replayRevision] = resumedRun.detail.dagState.revisions;
    expect(resumeRevision?.preservedCompletedNodeIds).toEqual(["trigger"]);
    expect(replayRevision?.focusNodeIds).toEqual(expect.arrayContaining([
      "claim-task",
      "acquire-worktree",
      "detect-commits",
    ]));
    expect(resumedRun?.detail?.data?._workflowSessionId).toBeUndefined();
  });

  it("retries a stalled non-task delegation run exactly once during interrupted-run recovery", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-stalled-delegation", name: "Stalled Delegation Workflow" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const interruptedRunId = "run-stalled-delegation";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: interruptedRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: null,
            resumable: true,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${interruptedRunId}.json`),
      JSON.stringify({
        id: interruptedRunId,
        startedAt: 1000,
        endedAt: null,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          delegationTarget: "template-bosun-pr-progressor",
          _delegationWatchdog: {
            nodeId: "handoff",
            state: "delegated",
            delegationType: "workflow",
            taskScoped: false,
            startedAt: 1000,
            timeoutMs: 50,
          },
        },
        nodeStatuses: {
          trigger: NodeStatus.COMPLETED,
          handoff: NodeStatus.RUNNING,
        },
        nodeStatusEvents: [{ nodeId: "handoff", status: NodeStatus.RUNNING, timestamp: 1000 }],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    const retryRunSpy = vi.spyOn(engine, "retryRun").mockResolvedValue({
      retryRunId: "retry-stalled-delegation",
      mode: "from_failed",
      originalRunId: interruptedRunId,
      ctx: { id: "retry-stalled-delegation" },
    });

    await engine.resumeInterruptedRuns();

    expect(retryRunSpy).toHaveBeenCalledTimes(1);
    expect(retryRunSpy).toHaveBeenCalledWith(interruptedRunId, expect.objectContaining({
      mode: "from_failed",
      _decisionReason: expect.stringContaining("delegation_watchdog"),
    }));
    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const interrupted = index.runs.find((entry) => entry.runId === interruptedRunId);
    expect(interrupted?.resumable).toBe(false);
    expect(interrupted?.resumeResult).toBe("resumed");
  });

  it("marks a repeatedly stalled non-task delegation run unresumable without looping", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-stalled-delegation-loop", name: "Stalled Delegation Loop Workflow" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const interruptedRunId = "run-stalled-delegation-loop";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: interruptedRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: null,
            resumable: true,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${interruptedRunId}.json`),
      JSON.stringify({
        id: interruptedRunId,
        startedAt: 1000,
        endedAt: null,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          _delegationWatchdog: {
            nodeId: "handoff",
            state: "delegated",
            delegationType: "workflow",
            taskScoped: false,
            startedAt: 1000,
            timeoutMs: 50,
            recoveryAttempted: true,
          },
        },
        nodeStatuses: {
          trigger: NodeStatus.COMPLETED,
          handoff: NodeStatus.RUNNING,
        },
        nodeStatusEvents: [{ nodeId: "handoff", status: NodeStatus.RUNNING, timestamp: 1000 }],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    const retryRunSpy = vi.spyOn(engine, "retryRun").mockResolvedValue({
      retryRunId: "retry-stalled-delegation-loop",
      mode: "from_scratch",
      originalRunId: interruptedRunId,
      ctx: { id: "retry-stalled-delegation-loop" },
    });

    await engine.resumeInterruptedRuns();

    expect(retryRunSpy).not.toHaveBeenCalled();

    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const interrupted = index.runs.find((entry) => entry.runId === interruptedRunId);
    expect(interrupted?.resumable).toBe(false);
    expect(interrupted?.resumeResult).toContain("delegation_watchdog_exhausted");
  });

  it("restarts interrupted task-scoped runs from scratch when no active claim remains", async () => {
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "claim-task", type: "action.claim_task", label: "Claim Task", config: {} },
        { id: "run-agent-tests", type: "action.run_agent", label: "Agent Tests", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "claim-task" },
        { id: "e2", source: "claim-task", target: "run-agent-tests" },
      ],
      { id: "wf-interrupted-task-claim", name: "Interrupted Task Claim Workflow" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const interruptedRunId = "run-interrupted-task-claim";
    const { initTaskClaims } = await import("../task/task-claims.mjs");
    await initTaskClaims({ repoRoot: tmpDir });

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: interruptedRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: null,
            resumable: true,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${interruptedRunId}.json`),
      JSON.stringify({
        id: interruptedRunId,
        startedAt: 1000,
        endedAt: null,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          taskId: "task-claim-missing-1",
        },
        nodeStatuses: {
          trigger: NodeStatus.COMPLETED,
          "claim-task": NodeStatus.COMPLETED,
          "run-agent-tests": NodeStatus.RUNNING,
        },
        nodeOutputs: {
          trigger: { triggered: true },
          "claim-task": { success: true, taskId: "task-claim-missing-1" },
        },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    const retryRunSpy = vi.spyOn(engine, "retryRun").mockResolvedValue({
      retryRunId: "retry-interrupted-task-claim",
      mode: "from_scratch",
      originalRunId: interruptedRunId,
      ctx: { id: "retry-interrupted-task-claim" },
    });

    await engine.resumeInterruptedRuns();

    expect(retryRunSpy).toHaveBeenCalledTimes(1);
    expect(retryRunSpy).toHaveBeenCalledWith(interruptedRunId, expect.objectContaining({
      mode: "from_scratch",
      _decisionReason: "task_claim_missing_on_resume",
    }));
  });

  it("keeps localized resume when interrupted run detail still carries a claim token", async () => {
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "claim-task", type: "action.claim_task", label: "Claim Task", config: {} },
        { id: "run-agent-tests", type: "action.run_agent", label: "Agent Tests", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "claim-task" },
        { id: "e2", source: "claim-task", target: "run-agent-tests" },
      ],
      { id: "wf-interrupted-task-claim-persisted", name: "Interrupted Task Claim Persisted Workflow" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const interruptedRunId = "run-interrupted-task-claim-persisted";
    const { initTaskClaims } = await import("../task/task-claims.mjs");
    await initTaskClaims({ repoRoot: tmpDir });

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: interruptedRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: null,
            resumable: true,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${interruptedRunId}.json`),
      JSON.stringify({
        id: interruptedRunId,
        startedAt: 1000,
        endedAt: null,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          taskId: "task-claim-persisted-1",
          _claimToken: "claim-token-persisted-1",
          _claimInstanceId: "wf-persisted-1",
        },
        nodeStatuses: {
          trigger: NodeStatus.COMPLETED,
          "claim-task": NodeStatus.COMPLETED,
          "run-agent-tests": NodeStatus.RUNNING,
        },
        nodeOutputs: {
          trigger: { triggered: true },
          "claim-task": {
            success: true,
            taskId: "task-claim-persisted-1",
            claimToken: "claim-token-persisted-1",
            instanceId: "wf-persisted-1",
          },
        },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    const retryRunSpy = vi.spyOn(engine, "retryRun").mockResolvedValue({
      retryRunId: "retry-interrupted-task-claim-persisted",
      mode: "from_failed",
      originalRunId: interruptedRunId,
      ctx: { id: "retry-interrupted-task-claim-persisted" },
    });

    await engine.resumeInterruptedRuns();

    expect(retryRunSpy).toHaveBeenCalledTimes(1);
    expect(retryRunSpy).toHaveBeenCalledWith(interruptedRunId, expect.objectContaining({
      mode: "from_failed",
      _decisionReason: "dag_state.localized_resume",
    }));
  });

  it("resumes interrupted runs with replan_from_failed when issue-advisor requests replanning", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-replan", name: "Resume Replan Workflow" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const interruptedRunId = "run-interrupted-replan";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: interruptedRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: null,
            resumable: true,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${interruptedRunId}.json`),
      JSON.stringify({
        id: interruptedRunId,
        startedAt: 1000,
        endedAt: null,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
        },
        dagState: {
          counts: { completed: 1, failed: 1 },
        },
        issueAdvisor: {
          recommendedAction: "replan_from_failed",
          summary: "Retry requires replanning from the failed node",
        },
        nodeStatuses: {
          trigger: NodeStatus.COMPLETED,
          fail: NodeStatus.FAILED,
        },
        nodeStatusEvents: [],
        logs: [],
        errors: [{ nodeId: "fail", error: "boom" }],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    const retrySpy = vi.spyOn(engine, "retryRun").mockResolvedValue({ resumed: true });

    await engine.resumeInterruptedRuns();

    expect(retrySpy).toHaveBeenCalledWith(
      interruptedRunId,
      expect.objectContaining({
        mode: "replan_from_failed",
        _decisionReason: "issue_advisor.replan_from_failed",
      }),
    );
  });

  it("does not resume an interrupted task run when a newer run already exists for the same task", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-resume-superseded", name: "Resume Superseded Workflow" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const interruptedRunId = "run-interrupted-older";
    const newerRunId = "run-newer-active";
    const taskId = "task-shared-1";

    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [
          {
            runId: interruptedRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.PAUSED,
            startedAt: 1000,
            endedAt: null,
            resumable: true,
          },
          {
            runId: newerRunId,
            workflowId: wf.id,
            workflowName: wf.name,
            status: WorkflowStatus.RUNNING,
            startedAt: 2000,
            endedAt: null,
          },
        ],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${interruptedRunId}.json`),
      JSON.stringify({
        id: interruptedRunId,
        startedAt: 1000,
        endedAt: null,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          taskId,
        },
        nodeStatuses: { trigger: NodeStatus.COMPLETED },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(runsDir, `${newerRunId}.json`),
      JSON.stringify({
        id: newerRunId,
        startedAt: 2000,
        endedAt: null,
        data: {
          _workflowId: wf.id,
          _workflowName: wf.name,
          taskId,
        },
        nodeStatuses: { trigger: NodeStatus.RUNNING },
        nodeStatusEvents: [],
        logs: [],
        errors: [],
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(runsDir, "_active-runs.json"), JSON.stringify([], null, 2), "utf8");

    const retrySpy = vi.spyOn(engine, "retryRun").mockResolvedValue({ resumed: true });

    await engine.resumeInterruptedRuns();

    expect(retrySpy).not.toHaveBeenCalled();

    const index = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const interrupted = index.runs.find((entry) => entry.runId === interruptedRunId);
    expect(interrupted).toBeTruthy();
    expect(interrupted.resumable).toBe(false);
    expect(interrupted.resumeResult).toBe("duplicate_task_run");
  });



  it("refreshes migrated task-lifecycle defaults for fresh task-lifecycle executions", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      {
        id: "wf-fresh-migrated-default",
        name: "Fresh Migrated Default",
        variables: { prePrValidationCommand: "npm run prepush:check" },
      },
    );
    wf.metadata = {
      ...(wf.metadata || {}),
      installedFrom: "template-task-lifecycle",
      templateState: {
        ...(wf.metadata?.templateState || {}),
        isCustomized: false,
      },
    };
    engine.save(wf);

    const ctx = await engine.execute(wf.id, {});

    expect(ctx.data.prePrValidationCommand).toBe("auto");

    const persisted = engine.getRunDetail(ctx.id);
    expect(persisted?.detail?.data?.prePrValidationCommand).toBe("auto");
  });

  it("prefers indexed history without hydrating detail files when index is present", () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "wf-hydrate-history", name: "Hydrate History Workflow" },
    );
    engine.save(wf);

    const runsDir = join(tmpDir, "runs");
    const indexedRunId = "run-indexed";
    writeFileSync(
      join(runsDir, "index.json"),
      JSON.stringify({
        runs: [{
          runId: indexedRunId,
          workflowId: wf.id,
          workflowName: wf.name,
          status: WorkflowStatus.COMPLETED,
          startedAt: 3000,
          endedAt: 3200,
          duration: 200,
          nodeCount: 1,
          logCount: 0,
          errorCount: 0,
          activeNodeCount: 0,
          completedCount: 1,
          failedCount: 0,
        }],
      }, null, 2),
      "utf8",
    );

    const detailRuns = [
      { runId: "run-hydrate-1", startedAt: 1000 },
      { runId: "run-hydrate-2", startedAt: 2000 },
    ];
    for (const entry of detailRuns) {
      writeFileSync(
        join(runsDir, `${entry.runId}.json`),
        JSON.stringify({
          id: entry.runId,
          startedAt: entry.startedAt,
          endedAt: entry.startedAt + 120,
          status: WorkflowStatus.COMPLETED,
          data: { _workflowId: wf.id, _workflowName: wf.name },
          nodeStatuses: { trigger: NodeStatus.COMPLETED },
          nodeStatusEvents: [],
          logs: [],
          errors: [],
        }, null, 2),
        "utf8",
      );
    }

    const history = engine.getRunHistory(wf.id, 5);
    const runIds = history.map((run) => run.runId);
    expect(runIds).toEqual([indexedRunId]);

    const reloadedIndex = JSON.parse(readFileSync(join(runsDir, "index.json"), "utf8"));
    const reloadedIds = (reloadedIndex.runs || []).map((run) => run.runId);
    expect(reloadedIds).toEqual([indexedRunId]);
  });
  it("supports cooperative cancellation for running runs", async () => {
    let releaseRun;
    const blocker = new Promise((resolve) => { releaseRun = resolve; });
    let nodeEntered;
    const nodeStarted = new Promise((resolve) => { nodeEntered = resolve; });

    registerNodeType("test.cancellable", {
      describe: () => "Cancellable long-running node",
      schema: { type: "object", properties: {} },
      async execute(node, ctx) {
        ctx.log(node.id, "entered cancellable node");
        nodeEntered();
        await blocker;
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "wait", type: "test.cancellable", label: "Wait", config: {} },
      ],
      [{ id: "e1", source: "trigger", target: "wait" }],
      { name: "Cancellable Workflow" },
    );

    engine.save(wf);
    const runPromise = engine.execute(wf.id, {});
    await nodeStarted;

    const history = engine.getRunHistory(wf.id, 10);
    const active = history.find((entry) => entry.status === WorkflowStatus.RUNNING);
    expect(active).toBeTruthy();

    const cancelResult = engine.cancelRun(active.runId, { reason: "test-stop" });
    expect(cancelResult.ok).toBe(true);
    expect(cancelResult.cancelRequested).toBe(true);

    releaseRun();
    await runPromise;

    const latest = engine.getRunHistory(wf.id, 1)[0];
    expect(latest.status).toBe(WorkflowStatus.CANCELLED);

    const detail = engine.getRunDetail(latest.runId);
    expect(detail.status).toBe(WorkflowStatus.CANCELLED);
    expect(String(detail?.detail?.data?._workflowTerminalMessage || "")).toContain("test-stop");
  });

});
// ── Node Type Tests ─────────────────────────────────────────────────────────

describe("New node types", () => {
  it("trigger.anomaly matches by type and severity", async () => {
    const handler = getNodeType("trigger.anomaly");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({
      anomalyType: "stuck_agent",
      severity: "high",
      agentId: "codex-1",
    });

    const node = { id: "t1", type: "trigger.anomaly", config: { anomalyType: "stuck_agent", minSeverity: "medium" } };
    const result = await handler.execute(node, ctx);
    expect(result.triggered).toBe(true);
    expect(result.anomalyType).toBe("stuck_agent");
  });

  it("trigger.anomaly rejects low severity when minSeverity is high", async () => {
    const handler = getNodeType("trigger.anomaly");
    const ctx = new WorkflowContext({ anomalyType: "stuck_agent", severity: "low" });
    const node = { id: "t1", type: "trigger.anomaly", config: { minSeverity: "high" } };
    const result = await handler.execute(node, ctx);
    expect(result.triggered).toBe(false);
  });

  it("trigger.anomaly filters by agent regex", async () => {
    const handler = getNodeType("trigger.anomaly");
    const ctx = new WorkflowContext({ anomalyType: "error_spike", severity: "critical", agentId: "frontend-agent-1" });
    const node = { id: "t1", type: "trigger.anomaly", config: { agentFilter: "frontend" } };
    const result = await handler.execute(node, ctx);
    expect(result.triggered).toBe(true);

    const node2 = { id: "t2", type: "trigger.anomaly", config: { agentFilter: "backend" } };
    const result2 = await handler.execute(node2, ctx);
    expect(result2.triggered).toBe(false);
  });

  it("trigger.meeting.wake_phrase matches transcript payload with session and role filters", async () => {
    const handler = getNodeType("trigger.meeting.wake_phrase");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({
      sessionId: "meeting-123",
      role: "user",
      content: "Hey team, hi Bosun Wake, can you summarize action items?",
    });
    const node = {
      id: "wake-phrase",
      type: "trigger.meeting.wake_phrase",
      config: {
        wakePhrase: "bosun wake",
        sessionId: "meeting-123",
        role: "user",
      },
    };
    const result = await handler.execute(node, ctx);
    expect(result.triggered).toBe(true);
    expect(result.matchedField).toBe("content");
    expect(result.wakePhrase).toBe("bosun wake");
  });

  it("trigger.meeting.wake_phrase soft-fails invalid regex mode", async () => {
    const handler = getNodeType("trigger.meeting.wake_phrase");
    const ctx = new WorkflowContext({
      content: "bosun wake and continue",
      role: "user",
      sessionId: "meeting-123",
    });
    const node = {
      id: "wake-regex",
      type: "trigger.meeting.wake_phrase",
      config: {
        wakePhrase: "(",
        mode: "regex",
      },
    };
    const result = await handler.execute(node, ctx);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("invalid_regex");
  });

  it("trigger.scheduled_once resolves relative time expressions", async () => {
    const handler = getNodeType("trigger.scheduled_once");
    const ctx = new WorkflowContext({});

    // Already past
    const node = { id: "t1", type: "trigger.scheduled_once", config: { runAt: new Date(Date.now() - 1000).toISOString() } };
    const result = await handler.execute(node, ctx);
    expect(result.triggered).toBe(true);
    expect(result.remainingMs).toBe(0);

    // Future
    const node2 = { id: "t2", type: "trigger.scheduled_once", config: { runAt: "+30m" } };
    const result2 = await handler.execute(node2, ctx);
    expect(result2.triggered).toBe(false);
    expect(result2.remainingMs).toBeGreaterThan(0);
  });

  it("action.delay supports seconds, minutes, hours", async () => {
    const handler = getNodeType("action.delay");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({});
    // Use very small values for fast test
    const node = { id: "d1", type: "action.delay", config: { ms: 10, reason: "test" } };
    const result = await handler.execute(node, ctx);
    expect(result.waited).toBeGreaterThanOrEqual(10);
    expect(result.reason).toBe("test");
  });

  it("action.delay supports legacy durationMs/message aliases", async () => {
    const handler = getNodeType("action.delay");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({});
    const node = {
      id: "d2",
      type: "action.delay",
      config: { durationMs: 10, message: "legacy" },
    };
    const result = await handler.execute(node, ctx);
    expect(result.waited).toBeGreaterThanOrEqual(10);
    expect(result.reason).toBe("legacy");
  });

  it("action.delay honors explicit zero delay without falling back to the default", async () => {
    const handler = getNodeType("action.delay");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({});
    const node = {
      id: "d3",
      type: "action.delay",
      config: { ms: 0, reason: "no-wait" },
    };
    const result = await handler.execute(node, ctx);
    expect(result.waited).toBe(0);
    expect(result.reason).toBe("no-wait");
  });

  it("flow.gate opens on condition", async () => {
    const handler = getNodeType("flow.gate");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ ready: true });
    const engine = { emit: vi.fn() };
    const node = {
      id: "g1",
      type: "flow.gate",
      config: { mode: "condition", condition: "$data.ready === true", timeoutMs: 1000, pollIntervalMs: 50 },
    };
    const result = await handler.execute(node, ctx, engine);
    expect(result.gateOpened).toBe(true);
    expect(result.mode).toBe("condition");
    expect(result.judgment).toBe("ACCEPT");
    expect(result.waited).toBeLessThan(1000);
  });

  it("flow.gate timeout mode waits then proceeds", async () => {
    const handler = getNodeType("flow.gate");
    const ctx = new WorkflowContext({});
    const engine = { emit: vi.fn() };
    const node = {
      id: "g2",
      type: "flow.gate",
      config: { mode: "timeout", timeoutMs: 50 },
    };
    const result = await handler.execute(node, ctx, engine);
    expect(result.gateOpened).toBe(true);
    expect(result.judgment).toBe("ACCEPT");
    expect(result.waited).toBe(50);
  });

  it("flow.gate manual mode persists and consumes durable approval queue decisions", async () => {
    const handler = getNodeType("flow.gate");
    expect(handler).toBeDefined();

    const repoRoot = mkdtempSync(join(tmpdir(), "bosun-manual-gate-"));
    const ctx = new WorkflowContext({
      repoRoot,
      _workflowId: "wf-manual-gate",
      _workflowName: "Manual Gate Workflow",
      taskId: "task-manual-gate",
      taskTitle: "Approve release",
    });
    ctx.data._dagState = { runId: ctx.id, workflowId: "wf-manual-gate", workflowName: "Manual Gate Workflow" };
    const engine = { emit: vi.fn(), _checkpointRun: vi.fn() };
    const node = {
      id: "gate-manual-1",
      type: "flow.gate",
      config: { mode: "manual", timeoutMs: 250, pollIntervalMs: 10, reason: "Approve deployment gate" },
    };

    const approvalScopeId = `${ctx.id}:${node.id}`;
    const approvalTask = (async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const request = getApprovalRequest("workflow-gate", approvalScopeId, { repoRoot });
        if (request) {
          resolveApprovalRequest(request.requestId, {
            repoRoot,
            decision: "approved",
            actorId: "test-operator",
            note: "approved in unit test",
          });
          return;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
      throw new Error("Approval request was not created");
    })();

    const result = await handler.execute(node, ctx, engine);
    await approvalTask;

    expect(result.gateOpened).toBe(true);
    expect(result.mode).toBe("manual");
    expect(result.approvalState).toBe("approved");
    expect(result.judgment).toBe("ACCEPT");
    expect(result.approvalRequestId).toBe(`workflow-gate:${approvalScopeId}`);
    const resolvedRequest = getApprovalRequest("workflow-gate", approvalScopeId, { repoRoot });
    expect(resolvedRequest).toMatchObject({
      requestId: `workflow-gate:${approvalScopeId}`,
      status: "approved",
      judgment: "ACCEPT",
      nodeId: "gate-manual-1",
      workflowId: "wf-manual-gate",
    });
    expect(engine._checkpointRun).toHaveBeenCalled();
  });

  it("flow.join reports joined=true when all listed sources are completed/skipped", async () => {
    const handler = getNodeType("flow.join");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({});
    ctx.setNodeStatus("branch-a", NodeStatus.COMPLETED);
    ctx.setNodeStatus("branch-b", NodeStatus.SKIPPED);
    const node = {
      id: "join-1",
      type: "flow.join",
      config: {
        mode: "all",
        sourceNodeIds: ["branch-a", "branch-b"],
      },
    };
    const result = await handler.execute(node, ctx);
    expect(result.joined).toBe(true);
    expect(result.arrivedCount).toBe(2);
    expect(result.pendingSources).toEqual([]);
  });

  it("flow.end returns explicit terminal signal", async () => {
    const handler = getNodeType("flow.end");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ taskId: "TASK-1" });
    const node = {
      id: "end-1",
      type: "flow.end",
      config: {
        status: "failed",
        message: "Stop now",
        output: { taskId: "{{taskId}}" },
      },
    };
    const result = await handler.execute(node, ctx);
    expect(result._workflowEnd).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.output).toEqual({ taskId: "TASK-1" });
  });

  it("flow.universal and flow.universial dispatch to child workflows", async () => {
    const canonical = getNodeType("flow.universal");
    const typoAlias = getNodeType("flow.universial");
    expect(canonical).toBeDefined();
    expect(typoAlias).toBeDefined();

    const ctx = new WorkflowContext({ _workflowId: "parent-wf", taskId: "TASK-42" });
    const mockEngine = {
      execute: vi.fn(async () => new WorkflowContext({ ok: true })),
      get: vi.fn(() => ({ id: "template-task-archiver" })),
    };

    const node = {
      id: "universal-1",
      type: "flow.universial",
      config: {
        workflowId: "template-task-archiver",
        mode: "sync",
        inheritContext: true,
      },
    };

    const result = await typoAlias.execute(node, ctx, mockEngine);
    expect(result.success).toBe(true);
    expect(result.mode).toBe("sync");
    expect(result.workflowId).toBe("template-task-archiver");
    expect(mockEngine.execute).toHaveBeenCalledWith(
      "template-task-archiver",
      expect.objectContaining({
        taskId: "TASK-42",
        _workflowParentRunId: ctx.id,
        _workflowRootRunId: ctx.id,
        _workflowStack: ["parent-wf", "template-task-archiver"],
      }),
      expect.objectContaining({
        _parentRunId: ctx.id,
        _rootRunId: ctx.id,
      }),
    );
    expect(canonical).toBe(typoAlias);
  });

  it("flow.universal dispatch mode accepts synchronous engine return values", async () => {
    const handler = getNodeType("flow.universal");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ _workflowId: "parent-wf", taskId: "TASK-42" });
    const mockEngine = {
      execute: vi.fn(() => new WorkflowContext({ ok: true })),
      get: vi.fn(() => ({ id: "template-task-archiver" })),
    };
    const node = {
      id: "universal-dispatch",
      type: "flow.universal",
      config: {
        workflowId: "template-task-archiver",
        mode: "dispatch",
        inheritContext: true,
      },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result).toMatchObject({
      success: true,
      queued: true,
      mode: "dispatch",
      workflowId: "template-task-archiver",
    });
    expect(mockEngine.execute).toHaveBeenCalledTimes(1);
  });

  it("flow.end hard-stops remaining nodes and marks run as failed", async () => {
    const testEngine = makeTmpEngine();
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "end-fail", type: "flow.end", label: "End", config: { status: "failed", message: "fail fast" } },
        { id: "after-end", type: "notify.log", label: "Should Skip", config: { message: "must not run" } },
      ],
      [
        { id: "e1", source: "trigger", target: "end-fail" },
        { id: "e2", source: "end-fail", target: "after-end" },
      ],
      { id: "wf-end-hard-stop", name: "WF End Hard Stop" },
    );

    testEngine.save(wf);
    const ctx = await testEngine.execute(wf.id, {});
    expect(ctx.getNodeStatus("end-fail")).toBe(NodeStatus.COMPLETED);
    expect(ctx.getNodeStatus("after-end")).toBe(NodeStatus.SKIPPED);
    expect(ctx.data._workflowTerminalStatus).toBe(WorkflowStatus.FAILED);

    const detail = testEngine.getRunDetail(ctx.id);
    expect(detail?.status).toBe(WorkflowStatus.FAILED);
  });
});

describe("action.execute_workflow", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("sync mode executes child workflow with resolved input and stores summary output", async () => {
    const childWorkflow = makeSimpleWorkflow(
      [
        { id: "child-trigger", type: "trigger.manual", label: "Start Child", config: {} },
      ],
      [],
      { id: "child-sync-wf", name: "Child Sync Workflow" },
    );
    const parentWorkflow = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start Parent", config: {} },
        {
          id: "invoke-child",
          type: "action.execute_workflow",
          label: "Invoke Child",
          config: {
            workflowId: "{{targetWorkflowId}}",
            input: {
              payload: "{{payload}}",
              nested: { value: "{{nestedValue}}" },
            },
            inheritContext: true,
            includeKeys: ["sharedValue"],
            outputVariable: "childSummary",
          },
        },
      ],
      [{ id: "e1", source: "trigger", target: "invoke-child" }],
      { id: "parent-sync-wf", name: "Parent Sync Workflow" },
    );

    engine.save(childWorkflow);
    engine.save(parentWorkflow);

    const parentCtx = await engine.execute(parentWorkflow.id, {
      targetWorkflowId: childWorkflow.id,
      payload: "payload-value",
      nestedValue: "nested-value",
      sharedValue: "inherit-me",
      ignoredValue: "do-not-inherit",
    });

    expect(parentCtx.errors).toEqual([]);
    const output = parentCtx.getNodeOutput("invoke-child");
    expect(output).toMatchObject({
      success: true,
      queued: false,
      mode: "sync",
      workflowId: childWorkflow.id,
      status: "completed",
      errorCount: 0,
    });
    expect(typeof output.runId).toBe("string");
    expect(parentCtx.data.childSummary).toEqual(output);

    const childDetail = engine.getRunDetail(output.runId);
    expect(childDetail).toBeTruthy();
    expect(childDetail.workflowId).toBe(childWorkflow.id);
    expect(childDetail.detail?.data?.payload).toBe("payload-value");
    expect(childDetail.detail?.data?.nested?.value).toBe("nested-value");
    expect(childDetail.detail?.data?.sharedValue).toBe("inherit-me");
    expect(childDetail.detail?.data?.ignoredValue).toBeUndefined();
    expect(childDetail.detail?.data?._workflowStack).toEqual([parentWorkflow.id, childWorkflow.id]);
    expect(childDetail.detail?.dagState?.parentRunId).toBe(parentCtx.id);
    expect(childDetail.detail?.dagState?.rootRunId).toBe(parentCtx.id);
    expect(childDetail.ledger?.parentRunId).toBe(parentCtx.id);
    expect(childDetail.ledger?.rootRunId).toBe(parentCtx.id);

    const parentDetail = engine.getRunDetail(parentCtx.id);
    expect(parentDetail?.executionTree?.runId).toBe(parentCtx.id);
    expect(parentDetail?.executionTree?.children?.map((entry) => entry.runId)).toContain(output.runId);
    expect(parentDetail?.runGraph?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "parent-child",
          parentRunId: parentCtx.id,
          childRunId: output.runId,
        }),
      ]),
    );
    expect(
      parentDetail?.runGraph?.timeline?.some(
        (entry) => entry?.runId === output.runId && entry?.eventType === "run.start",
      ),
    ).toBe(true);
  }, SLOW_WORKFLOW_ENGINE_EXECUTE_WORKFLOW_SYNC_TEST_TIMEOUT_MS);

  it("sync mode resolves installed template aliases via metadata.installedFrom", async () => {
    const childWorkflow = makeSimpleWorkflow(
      [
        { id: "child-trigger", type: "trigger.manual", label: "Start Child", config: {} },
      ],
      [],
      { id: "child-installed-uuid", name: "Installed Template Child" },
    );
    childWorkflow.metadata = {
      ...(childWorkflow.metadata || {}),
      installedFrom: "template-installed-child",
    };

    const parentWorkflow = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start Parent", config: {} },
        {
          id: "invoke-child",
          type: "action.execute_workflow",
          label: "Invoke Installed Child",
          config: {
            workflowId: "template-installed-child",
            outputVariable: "childSummary",
          },
        },
      ],
      [{ id: "e1", source: "trigger", target: "invoke-child" }],
      { id: "parent-template-alias", name: "Parent Template Alias Workflow" },
    );

    engine.save(childWorkflow);
    engine.save(parentWorkflow);

    expect(engine.get("template-installed-child")?.id).toBe(childWorkflow.id);

    const parentCtx = await engine.execute(parentWorkflow.id, {});

    expect(parentCtx.errors).toEqual([]);
    const output = parentCtx.getNodeOutput("invoke-child");
    expect(output).toMatchObject({
      success: true,
      queued: false,
      mode: "sync",
      workflowId: "template-installed-child",
      status: "completed",
      errorCount: 0,
    });
    expect(parentCtx.data.childSummary).toEqual(output);

    const childDetail = engine.getRunDetail(output.runId);
    expect(childDetail).toBeTruthy();
    expect(childDetail.workflowId).toBe("template-installed-child");
    expect(engine.get(childDetail.workflowId)?.id).toBe(childWorkflow.id);
  }, SLOW_WORKFLOW_ENGINE_EXECUTE_WORKFLOW_SYNC_TEST_TIMEOUT_MS);

  it("decorates run detail with planner timeline and proof bundle surfaces", () => {
    const runId = "run-proof-bundle-1";
    const workflowId = "wf-proof-bundle";
    const startedAt = Date.parse("2026-03-31T10:00:00.000Z");
    const endedAt = Date.parse("2026-03-31T10:02:00.000Z");
    mkdirSync(join(tmpDir, "runs"), { recursive: true });
    const detail = {
      startedAt,
      endedAt,
      duration: endedAt - startedAt,
      data: {
        _workflowId: workflowId,
        _workflowName: "Proof Bundle Workflow",
        taskId: "task-proof-1",
        taskTitle: "Proof surfaced task",
      },
      nodeStatuses: {
        planner: NodeStatus.COMPLETED,
      },
      nodeOutputs: {
        planner: {
          summary: "Planner produced materialization output.",
          artifactPointers: [
            {
              label: "planner-json",
              path: "/tmp/planner-output.json",
              retrieveCommand: "type /tmp/planner-output.json",
            },
          ],
        },
      },
      logs: [],
      errors: [],
      dagState: {
        rootRunId: runId,
        counts: {
          total: 1,
          completed: 1,
          failed: 0,
          skipped: 0,
          active: 0,
        },
        revisions: [],
        nodes: {
          planner: {
            nodeId: "planner",
            label: "Planner",
            status: NodeStatus.COMPLETED,
            completionEvidence: [
              {
                kind: "artifact",
                path: "/tmp/review-proof.json",
                summary: "Independent review proof",
              },
            ],
            issueFindings: [],
          },
        },
      },
      issueAdvisor: {
        recommendedAction: "continue",
        retryDecisionClass: "inspect_failure",
        summary: "Planner evidence is available for review.",
        nextStepGuidance: "Inspect proof artifacts before dispatch.",
      },
    };

    writeFileSync(join(tmpDir, "runs", `${runId}.json`), JSON.stringify(detail, null, 2), "utf8");
    engine._writeRunIndex([
      engine._buildSummaryFromDetail({
        runId,
        workflowId,
        workflowName: "Proof Bundle Workflow",
        status: WorkflowStatus.COMPLETED,
        detail,
      }),
    ]);
    engine._executionLedger.ensureRun({
      runId,
      workflowId,
      workflowName: "Proof Bundle Workflow",
      rootRunId: runId,
      status: WorkflowStatus.COMPLETED,
    });
    engine._executionLedger.appendEvent({
      runId,
      workflowId,
      workflowName: "Proof Bundle Workflow",
      eventType: "planner.plan_initialized",
      nodeId: "planner",
      nodeType: "agent.run_planner",
      nodeLabel: "Planner",
      status: "running",
      summary: "Planner initialized.",
      meta: { stepLabel: "run-planner", taskCount: 5 },
    });
    engine._executionLedger.appendEvent({
      runId,
      workflowId,
      workflowName: "Proof Bundle Workflow",
      eventType: "planner.post_attachment",
      nodeId: "planner",
      nodeType: "agent.run_planner",
      nodeLabel: "Planner",
      status: "completed",
      summary: "Planner output captured.",
      meta: {
        stepLabel: "planner-output",
        attachmentKind: "planner_output",
        path: "/tmp/planner-output.json",
        retrieveCommand: "type /tmp/planner-output.json",
      },
    });
    engine._executionLedger.appendEvent({
      runId,
      workflowId,
      workflowName: "Proof Bundle Workflow",
      eventType: "planner.plan_completed",
      nodeId: "planner",
      nodeType: "agent.run_planner",
      nodeLabel: "Planner",
      status: "completed",
      summary: "Planner completed with proof.",
      meta: { stepLabel: "run-planner", itemCount: 2 },
    });

    const run = engine.getRunDetail(runId);
    expect(run?.plannerTimeline?.map((entry) => entry.eventType)).toEqual([
      "planner.plan_initialized",
      "planner.post_attachment",
      "planner.plan_completed",
    ]);
    expect(run?.plannerTimeline?.map((entry) => entry.normalizedEventType)).toEqual([
      "plan",
      "step_result",
      "plan",
    ]);
    expect(run?.plannerTimeline?.[0]?.plan).toMatchObject({
      stepLabel: "run-planner",
      status: "running",
    });
    expect(run?.plannerTimeline?.[1]?.stepResult).toMatchObject({
      attachmentKind: "planner_output",
      status: "completed",
    });
    expect(run?.proofBundle?.summary).toMatchObject({
      plannerEventCount: 3,
      decisionCount: 4,
    });
    expect(run?.proofBundle?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/tmp/review-proof.json",
          source: "completion-evidence",
        }),
      ]),
    );
    expect(run?.proofBundle?.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/tmp/planner-output.json",
        }),
      ]),
    );

    const nodeForensics = engine.getNodeForensics(runId, "planner");
    expect(nodeForensics?.plannerTimeline).toHaveLength(3);
    expect(nodeForensics?.proofArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/tmp/planner-output.json",
        }),
      ]),
    );
  });

  it("reuses a single run detail lookup when building full run forensics", async () => {
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "step-a", type: "action.set_variable", label: "Step A", config: { key: "a", value: "1" } },
        { id: "step-b", type: "action.set_variable", label: "Step B", config: { key: "b", value: "2" } },
      ],
      [
        { source: "trigger", target: "step-a" },
        { source: "step-a", target: "step-b" },
      ],
      { name: "Forensics Reuse Workflow" },
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, {});
    const getRunDetailSpy = vi.spyOn(engine, "getRunDetail");

    const forensics = engine.getRunForensics(ctx.id);

    expect(forensics?.runId).toBe(ctx.id);
    expect(Object.keys(forensics?.nodes || {})).toEqual(
      expect.arrayContaining(["trigger", "step-a", "step-b"]),
    );
    expect(getRunDetailSpy).toHaveBeenCalledTimes(1);
    expect(getRunDetailSpy).toHaveBeenCalledWith(ctx.id, { decorate: false });
  });

  it("dispatch mode queues child workflow without waiting for completion", async () => {
    const handler = getNodeType("action.execute_workflow");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ _workflowId: "parent-dispatch-wf" });
    let releaseChild;
    const childRunPromise = new Promise((resolve) => {
      releaseChild = resolve;
    });
    const mockEngine = {
      execute: vi.fn().mockReturnValue(childRunPromise),
      get: vi.fn().mockReturnValue({ id: "child-dispatch-wf" }),
    };
    const node = {
      id: "dispatch-child",
      type: "action.execute_workflow",
      config: {
        workflowId: "child-dispatch-wf",
        mode: "dispatch",
        outputVariable: "dispatchSummary",
      },
    };

    try {
      const result = await handler.execute(node, ctx, mockEngine);
      expect(result).toMatchObject({
        success: true,
        queued: true,
        mode: "dispatch",
        workflowId: "child-dispatch-wf",
      });
      expect(ctx.data.dispatchSummary).toEqual(result);
      expect(mockEngine.execute).toHaveBeenCalledTimes(1);
      expect(mockEngine.execute).toHaveBeenCalledWith(
        "child-dispatch-wf",
        expect.objectContaining({
          _workflowParentRunId: ctx.id,
          _workflowRootRunId: ctx.id,
          _workflowStack: ["parent-dispatch-wf", "child-dispatch-wf"],
        }),
        expect.objectContaining({
          _parentRunId: ctx.id,
          _rootRunId: ctx.id,
        }),
      );
    } finally {
      releaseChild?.(new WorkflowContext({}));
      await childRunPromise;
    }
  });

  it("hydrates delegation audit trail from persisted run detail into history and detail views", async () => {
    const wf = makeSimpleWorkflow(
      [{ id: "trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "delegation-audit-hydration", name: "Delegation Audit Hydration" },
    );
    engine.save(wf);

    const runId = "delegation-audit-run-1";
    const startedAt = Date.now() - 5000;
    const endedAt = startedAt + 1000;
    const detailPath = join(engine.runsDir, `${runId}.json`);
    const detail = {
      startedAt,
      endedAt,
      duration: endedAt - startedAt,
      status: "completed",
      data: {
        _workflowId: wf.id,
        _workflowName: wf.name,
        _delegationAuditTrail: [
          { type: "assign", idempotencyKey: "k1", taskId: "task-1", at: startedAt + 10 },
          { type: "claim-renew", idempotencyKey: "k2", taskId: "task-1", at: startedAt + 20 },
          { type: "owner-mismatch", idempotencyKey: "k3", taskId: "task-1", at: startedAt + 30 },
          { type: "handoff-complete", idempotencyKey: "k4", taskId: "task-1", at: startedAt + 40 },
        ],
      },
      logs: [],
      errors: [],
      nodeStatuses: {},
      nodeStatusEvents: [],
      dagState: {},
    };
    writeFileSync(detailPath, JSON.stringify(detail, null, 2), "utf8");

    const historyEntry = engine.getRunHistory(wf.id, 10).find((entry) => entry.runId === runId);
    expect(historyEntry).toBeTruthy();
    expect(historyEntry.delegationAuditTrail).toEqual(detail.data._delegationAuditTrail);

    const runDetail = engine.getRunDetail(runId);
    expect(runDetail).toBeTruthy();
    expect(runDetail.delegationAuditTrail).toEqual(detail.data._delegationAuditTrail);
    expect(runDetail.detail?.data?._delegationAuditTrail).toEqual(detail.data._delegationAuditTrail);
  });
  it("dispatch mode accepts synchronous engine return values", async () => {
    const handler = getNodeType("action.execute_workflow");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ _workflowId: "parent-dispatch-wf" });
    const mockEngine = {
      execute: vi.fn(() => new WorkflowContext({ ok: true })),
      get: vi.fn().mockReturnValue({ id: "child-dispatch-wf" }),
    };
    const node = {
      id: "dispatch-child-sync-return",
      type: "action.execute_workflow",
      config: {
        workflowId: "child-dispatch-wf",
        mode: "dispatch",
        outputVariable: "dispatchSummary",
      },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result).toMatchObject({
      success: true,
      queued: true,
      mode: "dispatch",
      workflowId: "child-dispatch-wf",
    });
    expect(ctx.data.dispatchSummary).toEqual(result);
    expect(mockEngine.execute).toHaveBeenCalledTimes(1);
  });

  it("blocks recursive workflow loops unless allowRecursive is true", async () => {
    const handler = getNodeType("action.execute_workflow");
    expect(handler).toBeDefined();

    const recursiveCtx = new WorkflowContext({
      _workflowId: "wf-current",
      _workflowStack: ["wf-root", "wf-current"],
    });
    const blockingEngine = {
      execute: vi.fn(),
      get: vi.fn().mockReturnValue({ id: "wf-root" }),
    };
    const recursiveNode = {
      id: "recursive-call",
      type: "action.execute_workflow",
      config: { workflowId: "wf-root" },
    };

    await expect(handler.execute(recursiveNode, recursiveCtx, blockingEngine))
      .rejects
      .toThrow(/recursive workflow call blocked/i);
    expect(blockingEngine.execute).not.toHaveBeenCalled();

    const allowEngine = {
      execute: vi.fn().mockResolvedValue(new WorkflowContext({})),
      get: vi.fn().mockReturnValue({ id: "wf-root" }),
    };
    const allowedNode = {
      id: "recursive-allowed",
      type: "action.execute_workflow",
      config: { workflowId: "wf-root", allowRecursive: true, failOnChildError: false },
    };

    const allowedResult = await handler.execute(allowedNode, recursiveCtx, allowEngine);
    expect(allowEngine.execute).toHaveBeenCalledTimes(1);
    expect(allowedResult.success).toBe(true);
  });

  it("sync mode honors failOnChildError", async () => {
    const handler = getNodeType("action.execute_workflow");
    expect(handler).toBeDefined();

    const failedChildCtx = new WorkflowContext({});
    failedChildCtx.error("child-node", new Error("child exploded"));

    const mockEngine = {
      execute: vi.fn().mockResolvedValue(failedChildCtx),
      get: vi.fn().mockReturnValue({ id: "child-failing-wf" }),
    };

    const throwingNode = {
      id: "throw-on-child-fail",
      type: "action.execute_workflow",
      config: { workflowId: "child-failing-wf", mode: "sync" },
    };
    await expect(
      handler.execute(throwingNode, new WorkflowContext({ _workflowId: "parent-wf" }), mockEngine),
    ).rejects.toThrow(/child workflow "child-failing-wf" failed/i);

    const softFailNode = {
      id: "soft-child-fail",
      type: "action.execute_workflow",
      config: {
        workflowId: "child-failing-wf",
        mode: "sync",
        failOnChildError: false,
        outputVariable: "childResult",
      },
    };
    const softCtx = new WorkflowContext({ _workflowId: "parent-wf" });
    const softResult = await handler.execute(softFailNode, softCtx, mockEngine);
    expect(softResult).toMatchObject({
      success: false,
      queued: false,
      mode: "sync",
      workflowId: "child-failing-wf",
      status: WorkflowStatus.FAILED,
      errorCount: 1,
    });
    expect(softResult.errors[0]).toMatchObject({
      nodeId: "child-node",
      error: "child exploded",
    });
    expect(softCtx.data.childResult).toEqual(softResult);
  }, SLOW_WORKFLOW_ENGINE_EXECUTE_WORKFLOW_SYNC_TEST_TIMEOUT_MS);

  it("sync mode reuses the parent run slot under saturation", async () => {
    const saturatedEngine = makeTmpEngine();
    const baselineActiveRuns = saturatedEngine.getConcurrencyStats().maxConcurrentRuns - 1;
    saturatedEngine._runSlots = baselineActiveRuns;

    const childWorkflow = makeSimpleWorkflow(
      [
        { id: "child-trigger", type: "trigger.workflow_call", label: "Child Trigger", config: {} },
        { id: "child-log", type: "notify.log", label: "Child Log", config: { message: "child completed" } },
      ],
      [{ id: "child-edge", source: "child-trigger", target: "child-log" }],
      { id: "child-slot-share", name: "Child Slot Share" },
    );

    const parentWorkflow = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Parent Trigger", config: {} },
        {
          id: "invoke-child",
          type: "action.execute_workflow",
          label: "Invoke Child",
          config: {
            workflowId: childWorkflow.id,
            mode: "sync",
            outputVariable: "childSummary",
          },
        },
      ],
      [{ id: "parent-edge", source: "trigger", target: "invoke-child" }],
      { id: "parent-slot-share", name: "Parent Slot Share" },
    );

    saturatedEngine.save(childWorkflow);
    saturatedEngine.save(parentWorkflow);

    const parentCtx = await Promise.race([
      saturatedEngine.execute(parentWorkflow.id, {}),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("workflow execution timed out")), 1500);
      }),
    ]);

    expect(parentCtx.data.childSummary).toMatchObject({
      success: true,
      mode: "sync",
      workflowId: childWorkflow.id,
    });

    const stats = saturatedEngine.getConcurrencyStats();
    expect(stats.activeRuns).toBe(baselineActiveRuns);
    expect(stats.queuedRuns).toBe(0);
    expect(stats.sharedRootRuns).toBe(0);
  }, SLOW_WORKFLOW_ENGINE_EXECUTE_WORKFLOW_SYNC_TEST_TIMEOUT_MS);

  it("sync mode includes child terminal output in the returned summary", async () => {
    const childWorkflow = {
      id: "child-terminal-wf",
      name: "Child Terminal Workflow",
      trigger: "trigger.workflow_call",
      nodes: [
        {
          id: "trigger",
          type: "trigger.workflow_call",
          label: "Trigger",
          config: { inputs: { payload: { type: "string", required: false } } },
        },
        {
          id: "finish",
          type: "flow.end",
          label: "Finish",
          config: {
            status: "completed",
            message: "done",
            output: {
              nodeOutputs: {
                finish: "{{payload}}",
              },
            },
          },
        },
      ],
      edges: [{ id: "edge-trigger-finish", source: "trigger", target: "finish" }],
    };

    const parentWorkflow = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start Parent", config: {} },
        {
          id: "invoke-child",
          type: "action.execute_workflow",
          label: "Invoke Child",
          config: {
            workflowId: "child-terminal-wf",
            mode: "sync",
            input: { payload: "{{payload}}" },
          },
        },
      ],
      [{ id: "edge-parent-child", source: "trigger", target: "invoke-child" }],
      { id: "parent-terminal-wf", name: "Parent Terminal Workflow" },
    );

    engine.save(childWorkflow);
    engine.save(parentWorkflow);

    const parentCtx = await engine.execute(parentWorkflow.id, { payload: "hello child" });
    const output = parentCtx.getNodeOutput("invoke-child");
    expect(output).toMatchObject({
      success: true,
      status: "completed",
      message: "done",
      output: {
        nodeOutputs: {
          finish: "hello child",
        },
      },
    });
  }, SLOW_WORKFLOW_ENGINE_EXECUTE_WORKFLOW_SYNC_TEST_TIMEOUT_MS);
});

describe("action.inline_workflow and executeDefinition", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("executeDefinition runs an ephemeral workflow without saving it", async () => {
    const inlineDefinition = {
      name: "Ephemeral Inline Workflow",
      trigger: "trigger.workflow_call",
      nodes: [
        {
          id: "trigger",
          type: "trigger.workflow_call",
          label: "Start",
          config: { inputs: { message: { type: "string", required: false } } },
        },
        {
          id: "set-reply",
          type: "action.set_variable",
          label: "Set Reply",
          config: { key: "reply", value: "{{message}}" },
        },
        {
          id: "finish",
          type: "flow.end",
          label: "Finish",
          config: {
            status: "completed",
            output: {
              reply: "{{reply}}",
            },
          },
        },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "set-reply" },
        { id: "e2", source: "set-reply", target: "finish" },
      ],
    };

    const ctx = await engine.executeDefinition(inlineDefinition, { message: "hello" }, {
      inlineWorkflowId: "inline:ephemeral-test",
    });

    expect(ctx.errors).toEqual([]);
    expect(ctx.data.reply).toBe("hello");
    expect(engine.get("inline:ephemeral-test")).toBeNull();
    const detail = engine.getRunDetail(ctx.id);
    expect(detail?.workflowId).toBe("inline:ephemeral-test");
  });

  it("sync mode executes embedded workflows and unwraps flow.end output", async () => {
    const parentWorkflow = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start Parent", config: {} },
        {
          id: "inline-child",
          type: "action.inline_workflow",
          label: "Inline Child",
          config: {
            mode: "sync",
            inheritContext: true,
            includeKeys: ["sharedValue"],
            input: { payload: "{{payload}}" },
            outputVariable: "inlineSummary",
            workflow: {
              trigger: "trigger.workflow_call",
              nodes: [
                {
                  id: "trigger",
                  type: "trigger.workflow_call",
                  label: "Start Child",
                  config: { inputs: { payload: { type: "string", required: false } } },
                },
                {
                  id: "finish",
                  type: "flow.end",
                  label: "Finish Child",
                  config: {
                    status: "completed",
                    output: {
                      echoed: "{{payload}}",
                      shared: "{{sharedValue}}",
                    },
                  },
                },
              ],
              edges: [{ id: "e1", source: "trigger", target: "finish" }],
            },
          },
        },
      ],
      [{ id: "e1", source: "trigger", target: "inline-child" }],
      { id: "parent-inline-sync", name: "Parent Inline Sync" },
    );

    engine.save(parentWorkflow);

    const parentCtx = await engine.execute(parentWorkflow.id, {
      payload: "payload-value",
      sharedValue: "inherit-me",
      ignoredValue: "do-not-inherit",
    });

    expect(parentCtx.errors).toEqual([]);
    const output = parentCtx.getNodeOutput("inline-child");
    expect(output).toMatchObject({
      success: true,
      dispatched: false,
      mode: "sync",
      status: "completed",
      echoed: "payload-value",
      shared: "inherit-me",
    });
    expect(typeof output.runId).toBe("string");
    expect(parentCtx.data.inlineSummary).toEqual(output);

    const childDetail = engine.getRunDetail(output.runId);
    expect(childDetail?.detail?.data?.payload).toBe("payload-value");
    expect(childDetail?.detail?.data?.sharedValue).toBe("inherit-me");
    expect(childDetail?.detail?.data?.ignoredValue).toBeUndefined();
    expect(childDetail?.detail?.dagState?.parentRunId).toBe(parentCtx.id);
    expect(childDetail?.detail?.dagState?.rootRunId).toBe(parentCtx.id);
    expect(childDetail?.ledger?.parentRunId).toBe(parentCtx.id);
    expect(childDetail?.ledger?.rootRunId).toBe(parentCtx.id);
  });

  it("persists the workflow definition snapshot with each historical run", async () => {
    const workflow = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Trigger", config: {} },
        {
          id: "finish",
          type: "flow.end",
          label: "Finish",
          config: { status: "completed", output: { ok: true } },
        },
      ],
      [{ id: "edge-trigger-finish", source: "trigger", target: "finish" }],
      { id: "snapshot-wf", name: "Snapshot Workflow" },
    );

    engine.save(workflow);
    const ctx = await engine.execute(workflow.id, {});

    const updatedWorkflow = {
      ...workflow,
      name: "Snapshot Workflow Updated",
      description: "changed after run",
    };
    engine.save(updatedWorkflow);

    const detail = engine.getRunDetail(ctx.id);
    expect(detail?.detail?.workflowDefinition).toMatchObject({
      id: "snapshot-wf",
      name: "Snapshot Workflow",
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: "trigger", type: "trigger.manual" }),
        expect.objectContaining({ id: "finish", type: "flow.end" }),
      ]),
      edges: [expect.objectContaining({ id: "edge-trigger-finish", source: "trigger", target: "finish" })],
    });
    expect(detail?.detail?.workflowDefinition?.name).not.toBe("Snapshot Workflow Updated");
  });

  it("dispatch mode queues embedded workflows without waiting for completion", async () => {
    const handler = getNodeType("action.inline_workflow");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ _workflowId: "parent-inline-dispatch" });
    let releaseChild;
    const childRunPromise = new Promise((resolve) => {
      releaseChild = resolve;
    });
    const mockEngine = {
      executeDefinition: vi.fn().mockReturnValue(childRunPromise),
    };
    const node = {
      id: "dispatch-inline-child",
      type: "action.inline_workflow",
      config: {
        mode: "dispatch",
        outputVariable: "inlineDispatchSummary",
        workflow: {
          id: "inline-child-dispatch",
          trigger: "trigger.workflow_call",
          nodes: [{ id: "trigger", type: "trigger.workflow_call", label: "Start", config: {} }],
          edges: [],
        },
      },
    };

    try {
      const result = await handler.execute(node, ctx, mockEngine);
      expect(result).toMatchObject({
        success: true,
        dispatched: true,
        mode: "dispatch",
        workflowId: "inline-child-dispatch",
      });
      expect(ctx.data.inlineDispatchSummary).toEqual(result);
      expect(mockEngine.executeDefinition).toHaveBeenCalledTimes(1);
      const [definition, childInput, childOpts] = mockEngine.executeDefinition.mock.calls[0];
      expect(definition.id).toBe("inline-child-dispatch");
      expect(childInput._workflowParentRunId).toBe(ctx.id);
      expect(childInput._workflowRootRunId).toBe(ctx.id);
      expect(childOpts._parentRunId).toBe(ctx.id);
      expect(childOpts._rootRunId).toBe(ctx.id);
    } finally {
      releaseChild?.(new WorkflowContext({}));
      await childRunPromise;
    }
  });
});

// ── Session Chaining Tests ──────────────────────────────────────────────────

describe("meeting workflow nodes", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("executes meeting.start -> meeting.send -> meeting.transcript -> meeting.finalize with service wiring", async () => {
    const meetingService = {
      startMeeting: vi.fn(async (opts = {}) => ({
        sessionId: opts.sessionId || "meeting-auto",
        created: true,
        session: { id: opts.sessionId || "meeting-auto", status: "active" },
        voice: { available: true, provider: "openai" },
      })),
      sendMeetingMessage: vi.fn(async (sessionId, content) => ({
        ok: true,
        sessionId,
        messageId: "msg-1",
        status: "sent",
        responseText: `ACK:${content}`,
        adapter: "mock-agent",
        observedEventCount: 1,
      })),
      fetchMeetingTranscript: vi.fn(async (sessionId, opts = {}) => ({
        sessionId,
        status: "active",
        page: opts.page || 1,
        pageSize: opts.pageSize || 200,
        totalMessages: 2,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        messages: [
          { role: "user", content: "hi bosun" },
          { role: "assistant", content: "hello there" },
        ],
      })),
      stopMeeting: vi.fn(async (sessionId, opts = {}) => ({
        ok: true,
        sessionId,
        status: opts.status || "completed",
        session: { id: sessionId, status: opts.status || "completed" },
      })),
    };
    engine.services.meeting = meetingService;

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "start",
          type: "meeting.start",
          label: "Meeting Start",
          config: {
            sessionId: "{{meetingId}}",
            wakePhrase: "{{wakePhrase}}",
          },
        },
        {
          id: "send",
          type: "meeting.send",
          label: "Meeting Send",
          config: {
            message: "{{openingMessage}}",
          },
        },
        {
          id: "transcript",
          type: "meeting.transcript",
          label: "Meeting Transcript",
          config: {
            includeMessages: false,
          },
        },
        {
          id: "finalize",
          type: "meeting.finalize",
          label: "Meeting Finalize",
          config: {
            status: "archived",
            note: "{{finalNote}}",
          },
        },
      ],
      [
        { id: "e1", source: "trigger", target: "start" },
        { id: "e2", source: "start", target: "send" },
        { id: "e3", source: "send", target: "transcript" },
        { id: "e4", source: "transcript", target: "finalize" },
      ],
      { id: "meeting-nodes-wf", name: "Meeting Node Flow" },
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, {
      meetingId: "meeting-123",
      wakePhrase: "hi bosun",
      openingMessage: "Please summarize this meeting.",
      finalNote: "Workflow archived meeting session.",
    });

    expect(ctx.errors).toEqual([]);
    expect(ctx.getNodeOutput("start")).toMatchObject({
      success: true,
      sessionId: "meeting-123",
    });
    expect(ctx.getNodeOutput("send")).toMatchObject({
      success: true,
      sessionId: "meeting-123",
      messageId: "msg-1",
    });
    expect(ctx.getNodeOutput("transcript")).toMatchObject({
      success: true,
      sessionId: "meeting-123",
      totalMessages: 2,
      transcript: "user: hi bosun\nassistant: hello there",
    });
    expect(ctx.getNodeOutput("finalize")).toMatchObject({
      success: true,
      sessionId: "meeting-123",
      status: "archived",
    });

    expect(meetingService.startMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "meeting-123",
        metadata: expect.objectContaining({ wakePhrase: "hi bosun" }),
      }),
    );
    expect(meetingService.sendMeetingMessage).toHaveBeenCalledWith(
      "meeting-123",
      "Please summarize this meeting.",
      expect.any(Object),
    );
    expect(meetingService.fetchMeetingTranscript).toHaveBeenCalledWith(
      "meeting-123",
      expect.objectContaining({ page: 1, pageSize: 200 }),
    );
    expect(meetingService.stopMeeting).toHaveBeenCalledWith(
      "meeting-123",
      expect.objectContaining({
        status: "archived",
        note: "Workflow archived meeting session.",
      }),
    );
  });

  it("meeting.vision forwards frame analysis options and stores summary in context", async () => {
    const handler = getNodeType("meeting.vision");
    expect(handler).toBeDefined();

    const analyzeMeetingFrame = vi.fn(async (sessionId) => ({
      ok: true,
      sessionId,
      analyzed: true,
      skipped: false,
      summary: "Presenter is showing CI failures in terminal output.",
      provider: "mock-vision",
      model: "mock-vision-model",
      frameHash: "abc123",
    }));
    const ctx = new WorkflowContext({
      meetingSessionId: "meeting-vision-123",
      frameDataUrl: "data:image/png;base64,dGVzdA==",
    });
    const node = {
      id: "meeting-vision",
      type: "meeting.vision",
      config: {
        source: "camera",
        prompt: "Describe what is on screen",
        visionModel: "gpt-vision-test",
        minIntervalMs: "1500",
        forceAnalyze: true,
        width: 1280,
        height: 720,
        executor: "codex",
        mode: "agent",
        model: "gpt-5",
      },
    };
    const mockEngine = {
      services: {
        meeting: {
          analyzeMeetingFrame,
        },
      },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result).toMatchObject({
      success: true,
      sessionId: "meeting-vision-123",
      analyzed: true,
      summary: "Presenter is showing CI failures in terminal output.",
      provider: "mock-vision",
      model: "mock-vision-model",
      frameHash: "abc123",
    });
    expect(analyzeMeetingFrame).toHaveBeenCalledWith(
      "meeting-vision-123",
      "data:image/png;base64,dGVzdA==",
      expect.objectContaining({
        source: "camera",
        prompt: "Describe what is on screen",
        visionModel: "gpt-vision-test",
        minIntervalMs: 1500,
        forceAnalyze: true,
        width: 1280,
        height: 720,
        executor: "codex",
        mode: "agent",
        model: "gpt-5",
      }),
    );
    expect(ctx.data.meetingVisionSummary).toBe(
      "Presenter is showing CI failures in terminal output.",
    );
  });

  it("meeting.send returns soft failure when failOnError=false", async () => {
    const handler = getNodeType("meeting.send");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ meetingSessionId: "meeting-soft-fail" });
    const engineWithFailure = {
      services: {
        meeting: {
          sendMeetingMessage: vi.fn(async () => {
            throw new Error("dispatch failed");
          }),
        },
      },
    };
    const node = {
      id: "meeting-send-soft",
      type: "meeting.send",
      config: {
        message: "hello",
        failOnError: false,
      },
    };

    const result = await handler.execute(node, ctx, engineWithFailure);
    expect(result).toMatchObject({
      success: false,
      error: "dispatch failed",
    });
  });
});

describe("WorkflowEngine trigger evaluation", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("includes trigger.meeting.wake_phrase for meeting transcript events", async () => {
    const wf = makeSimpleWorkflow(
      [
        {
          id: "wake-trigger",
          type: "trigger.meeting.wake_phrase",
          label: "Wake Phrase Trigger",
          config: {
            wakePhrase: "hi bosun",
          },
        },
      ],
      [],
      { id: "wake-trigger-workflow", name: "Wake Trigger Workflow" },
    );

    engine.save(wf);

    const hits = await engine.evaluateTriggers("meeting.transcript", {
      sessionId: "meeting-1",
      role: "user",
      content: "Hi bosun can you capture this task?",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      workflowId: "wake-trigger-workflow",
      triggeredBy: "wake-trigger",
    });

    const nonMeetingHits = await engine.evaluateTriggers("task.completed", {
      sessionId: "meeting-1",
      role: "user",
      content: "Hi bosun can you capture this task?",
    });
    expect(nonMeetingHits).toHaveLength(0);
  });

  it("evaluateScheduleTriggers fires workflows whose interval has elapsed", () => {
    const wf = makeSimpleWorkflow(
      [
        {
          id: "sched-trigger",
          type: "trigger.schedule",
          label: "Every 5min",
          config: { intervalMs: 300000 },
        },
        {
          id: "act",
          type: "action.set_variable",
          label: "Set",
          config: { key: "ran", value: "yes" },
        },
      ],
      [{ source: "sched-trigger", target: "act" }],
      { id: "sched-wf", name: "Scheduled Workflow" },
    );
    engine.save(wf);

    // No previous runs → should trigger
    const hits = engine.evaluateScheduleTriggers();
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      workflowId: "sched-wf",
      triggeredBy: "sched-trigger",
    });
  });

  it("evaluateScheduleTriggers resolves templated schedule interval from workflow variables", async () => {
    const wf = makeSimpleWorkflow(
      [
        {
          id: "sched-trigger",
          type: "trigger.schedule",
          label: "Every 5min (templated)",
          config: { intervalMs: "{{intervalMs}}" },
        },
      ],
      [],
      {
        id: "sched-wf-templated-interval",
        name: "Scheduled Workflow Templated Interval",
        variables: { intervalMs: 300000 },
      },
    );
    engine.save(wf);

    await engine.execute("sched-wf-templated-interval");
    const indexPath = join(engine.runsDir, "index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    const run = (index.runs || []).find((entry) => entry.workflowId === "sched-wf-templated-interval");
    expect(run).toBeTruthy();
    run.startedAt = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf8");

    const hits = engine.evaluateScheduleTriggers();
    expect(hits.some((h) => h.workflowId === "sched-wf-templated-interval")).toBe(true);
  });
  it("evaluateScheduleTriggers polls trigger.task_available workflows", () => {
    const wf = makeSimpleWorkflow(
      [
        {
          id: "task-trigger",
          type: "trigger.task_available",
          label: "Task Poll",
          config: { pollIntervalMs: 30000 },
        },
      ],
      [],
      { id: "task-poll-wf", name: "Task Poll Workflow" },
    );
    engine.save(wf);

    const hits = engine.evaluateScheduleTriggers();
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      workflowId: "task-poll-wf",
      triggeredBy: "task-trigger",
    });
  });

  it("evaluateScheduleTriggers uses pollIntervalMs for trigger.task_available", async () => {
    const wf = makeSimpleWorkflow(
      [
        {
          id: "task-trigger",
          type: "trigger.task_available",
          label: "Task Poll",
          config: { pollIntervalMs: 60000 },
        },
      ],
      [],
      { id: "task-poll-interval-wf", name: "Task Poll Interval Workflow" },
    );
    engine.save(wf);

    await engine.execute("task-poll-interval-wf");
    const hits = engine.evaluateScheduleTriggers();
    expect(hits.some((h) => h.workflowId === "task-poll-interval-wf")).toBe(false);
  });

  it("evaluateScheduleTriggers suppresses installed task lifecycle polls when batch dispatcher is enabled", () => {
    const lifecycle = makeSimpleWorkflow(
      [
        {
          id: "task-trigger",
          type: "trigger.task_available",
          label: "Task Poll",
          config: { pollIntervalMs: 30000 },
        },
      ],
      [],
      { id: "installed-lifecycle-uuid", name: "Task Lifecycle" },
    );
    lifecycle.metadata = {
      ...(lifecycle.metadata || {}),
      installedFrom: "template-task-lifecycle",
    };

    const batch = makeSimpleWorkflow(
      [
        {
          id: "batch-trigger",
          type: "trigger.task_available",
          label: "Task Batch Poll",
          config: { pollIntervalMs: 15000 },
        },
      ],
      [],
      { id: "installed-batch-uuid", name: "Task Batch Processor" },
    );
    batch.metadata = {
      ...(batch.metadata || {}),
      installedFrom: "template-task-batch-processor",
    };

    engine.save(lifecycle);
    engine.save(batch);

    const hits = engine.evaluateScheduleTriggers();
    expect(hits.some((h) => h.workflowId === lifecycle.id)).toBe(false);
    expect(hits.some((h) => h.workflowId === batch.id)).toBe(true);
  });

  it("evaluateScheduleTriggers uses the latest run timestamp per workflow", () => {
    const wf = makeSimpleWorkflow(
      [
        {
          id: "sched-trigger-latest",
          type: "trigger.schedule",
          label: "Every minute",
          config: { intervalMs: 60000 },
        },
      ],
      [],
      { id: "sched-wf-latest-run", name: "Scheduled Workflow Latest Run" },
    );
    engine.save(wf);

    const now = Date.now();
    const readRunIndexSpy = vi.spyOn(engine, "_readRunIndex").mockReturnValue([
      {
        runId: "sched-run-latest-older",
        workflowId: "sched-wf-latest-run",
        startedAt: now - (10 * 60 * 1000),
      },
      {
        runId: "sched-run-latest-newer",
        workflowId: "sched-wf-latest-run",
        startedAt: now - 15_000,
      },
      {
        runId: "sched-run-other",
        workflowId: "other-workflow",
        startedAt: now - (20 * 60 * 1000),
      },
    ]);

    const hits = engine.evaluateScheduleTriggers();

    expect(readRunIndexSpy).toHaveBeenCalled();
    expect(hits.some((h) => h.workflowId === "sched-wf-latest-run")).toBe(false);

    readRunIndexSpy.mockRestore();
  });

  it("does not traverse downstream nodes when a trigger returns triggered: false", async () => {
    registerNodeType("test.should_not_run", {
      describe: () => "Fails if executed",
      schema: { type: "object", properties: {} },
      async execute() {
        throw new Error("downstream should not execute when trigger is false");
      },
    });

    const wf = makeSimpleWorkflow(
      [
        {
          id: "low-trigger",
          type: "trigger.task_low",
          label: "Task Low",
          config: { threshold: 3 },
        },
        {
          id: "should-not-run",
          type: "test.should_not_run",
          label: "Should Not Run",
          config: {},
        },
      ],
      [{ source: "low-trigger", target: "should-not-run" }],
      { id: "task-low-skip-wf", name: "Task Low Skip Workflow" },
    );
    engine.save(wf);

    const run = await engine.execute("task-low-skip-wf", { todoCount: 10 });
    expect(run.errors).toHaveLength(0);
    expect(run.getNodeStatus("low-trigger")).toBe(NodeStatus.COMPLETED);
    expect(run.getNodeStatus("should-not-run")).toBe(NodeStatus.SKIPPED);
  });
  it("propagates skipped multi-input branches so alternate satisfied edges can continue", async () => {
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "fix-needed",
          type: "condition.expression",
          label: "Fix Needed?",
          config: { expression: "false" },
        },
        {
          id: "pause-task-spawning",
          type: "notify.log",
          label: "Pause Task Spawning",
          config: { message: "pause" },
        },
        {
          id: "security-fix-needed",
          type: "condition.expression",
          label: "Security Fix Needed?",
          config: { expression: "false" },
        },
        {
          id: "dispatch-security-fix-agents",
          type: "notify.log",
          label: "Dispatch Security Fix Agents",
          config: { message: "dispatch security" },
        },
        {
          id: "generic-fix-needed",
          type: "condition.expression",
          label: "Generic Fix Needed?",
          config: { expression: "false" },
        },
        {
          id: "review-needed",
          type: "condition.expression",
          label: "Review Needed?",
          config: { expression: "false" },
        },
        {
          id: "resume-task-spawning",
          type: "notify.log",
          label: "Resume Task Spawning",
          config: { message: "resume" },
        },
      ],
      [
        { id: "e1", source: "trigger", target: "fix-needed" },
        { id: "e2", source: "fix-needed", target: "pause-task-spawning", condition: "$output?.result === true" },
        { id: "e3", source: "fix-needed", target: "review-needed", condition: "$output?.result !== true" },
        { id: "e4", source: "pause-task-spawning", target: "security-fix-needed" },
        { id: "e5", source: "pause-task-spawning", target: "dispatch-security-fix-agents" },
        { id: "e6", source: "security-fix-needed", target: "generic-fix-needed", condition: "$output?.result !== true" },
        { id: "e7", source: "dispatch-security-fix-agents", target: "generic-fix-needed" },
        { id: "e8", source: "generic-fix-needed", target: "review-needed", condition: "$output?.result !== true" },
        { id: "e9", source: "review-needed", target: "resume-task-spawning", condition: "$output?.result !== true" },
      ],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});

    expect(result.getNodeStatus("fix-needed")).toBe(NodeStatus.COMPLETED);
    expect(result.getNodeStatus("pause-task-spawning")).toBe(NodeStatus.SKIPPED);
    expect(result.getNodeStatus("security-fix-needed")).toBe(NodeStatus.SKIPPED);
    expect(result.getNodeStatus("dispatch-security-fix-agents")).toBe(NodeStatus.SKIPPED);
    expect(result.getNodeStatus("generic-fix-needed")).toBe(NodeStatus.SKIPPED);
    expect(result.getNodeStatus("review-needed")).toBe(NodeStatus.COMPLETED);
    expect(result.getNodeStatus("resume-task-spawning")).toBe(NodeStatus.COMPLETED);
  });

  it("evaluateScheduleTriggers skips disabled workflows", () => {
    const wf = {
      id: "sched-disabled",
      name: "Disabled Sched",
      enabled: false,
      nodes: [
        {
          id: "sched-trigger",
          type: "trigger.schedule",
          label: "Every 5min",
          config: { intervalMs: 300000 },
        },
      ],
      edges: [],
      variables: {},
    };
    engine.save(wf);

    const hits = engine.evaluateScheduleTriggers();
    expect(hits.some((h) => h.workflowId === "sched-disabled")).toBe(false);
  });
});

describe("Session chaining - action.run_agent", () => {
  beforeEach(() => {
    makeTmpEngine();
    resetSessionTracker({ persistDir: null });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    resetSessionTracker({ persistDir: null });
  });

  it("keeps a workflow overseer session stable while swapping run workers across executions", async () => {
    const sessionManager = createHarnessSessionManager();
    engine = new WorkflowEngine({
      workflowDir: join(tmpDir, "workflows"),
      runsDir: join(tmpDir, "runs"),
      services: { sessionManager },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "end",
          type: "flow.end",
          label: "End",
          config: {
            status: "completed",
            output: { ok: true },
          },
        },
      ],
      [{ id: "edge-1", source: "trigger", target: "end" }],
      {
        id: "workflow-overseer-reuse",
        name: "Workflow Overseer Reuse",
      },
    );

    engine.save(wf);
    const first = await engine.execute(wf.id, {
      taskId: "TASK-OVERSEER-REUSE",
      task: { id: "TASK-OVERSEER-REUSE", title: "Overseer reuse" },
    });
    const second = await engine.execute(wf.id, {
      taskId: "TASK-OVERSEER-REUSE",
      task: { id: "TASK-OVERSEER-REUSE", title: "Overseer reuse" },
    });

    const overseer = sessionManager.getSession("TASK-OVERSEER-REUSE");
    const replay = sessionManager.getReplaySnapshot("TASK-OVERSEER-REUSE");

    expect(first.data._workflowSessionId).toBe("TASK-OVERSEER-REUSE");
    expect(second.data._workflowSessionId).toBe("TASK-OVERSEER-REUSE");
    expect(first.data._workflowRootSessionId).toBe("TASK-OVERSEER-REUSE");
    expect(second.data._workflowRootSessionId).toBe("TASK-OVERSEER-REUSE");
    expect(overseer).toMatchObject({
      sessionId: "TASK-OVERSEER-REUSE",
      sessionType: "workflow-overseer",
      scope: "workflow-task",
      status: "completed",
      activeWorkerId: null,
      activeWorker: null,
      executionCount: 2,
      workerGeneration: 2,
      workerSwapCount: 1,
      rootSessionId: "TASK-OVERSEER-REUSE",
    });
    expect(overseer.workerHistory).toHaveLength(2);
    expect(new Set(overseer.workerHistory.map((entry) => entry.threadId)).size).toBe(2);
    expect(overseer.workerHistory.every((entry) => entry.status === "completed")).toBe(true);
    expect(replay.workerHistory).toHaveLength(2);
  }, SLOW_WORKFLOW_ENGINE_SESSION_CHAINING_TEST_TIMEOUT_MS);

  it("propagates threadId to context and streams agent events into run logs", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const launchEphemeralThread = vi.fn().mockImplementation(
      async (_prompt, _cwd, _timeoutMs, extra) => {
        extra?.onEvent?.({
          type: "tool_call",
          tool_name: "apply_patch",
        });
        extra?.onEvent?.({
          type: "agent_message",
          message: { content: "Implemented the requested changes." },
        });
        return {
          success: true,
          output: "done",
          sdk: "codex",
          items: [],
          threadId: "thread-abc-123",
        };
      },
    );
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const node = {
      id: "a1",
      type: "action.run_agent",
      config: { prompt: "Test prompt", autoRecover: false, failOnError: true },
    };
    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.threadId).toBe("thread-abc-123");
    expect(result.sessionId).toBe("thread-abc-123");
    expect(ctx.data.sessionId).toBe("thread-abc-123");
    expect(ctx.data.threadId).toBe("thread-abc-123");
    expect(launchEphemeralThread).toHaveBeenCalledTimes(1);
    expect(launchEphemeralThread.mock.calls[0][3]).toEqual(
      expect.objectContaining({
        onEvent: expect.any(Function),
        systemPrompt: expect.any(String),
      }),
    );
    const runLogText = ctx.logs.map((entry) => String(entry?.message || "")).join("\n");
    expect(runLogText).toMatch(/Tool call: apply_patch/);
    expect(runLogText).toMatch(/Agent: Implemented the requested changes\./);
  });

  it("logs native session tool events and step-finish summaries into run logs", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const launchEphemeralThread = vi.fn().mockImplementation(async (_prompt, _cwd, _timeoutMs, extra) => {
      extra?.onEvent?.({
        type: "session.tool.start",
        toolName: "run_workspace_command",
        callId: "call-1",
      });
      extra?.onEvent?.({
        type: "session.tool.complete",
        toolName: "run_workspace_command",
        callId: "call-1",
      });
      extra?.onEvent?.({
        type: "session.step.finish",
        toolCalls: [
          { callId: "call-2", name: "read_file_content" },
          { callId: "call-3", name: "edit_file" },
        ],
        toolResults: [
          { callId: "call-2", output: "ok" },
          { callId: "call-3", output: "ok" },
        ],
      });
      return {
        success: true,
        output: "Native adapter turn completed.",
        sdk: "openai-native",
        items: [],
        threadId: "thread-native-session",
      };
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const node = {
      id: "native-1",
      type: "action.run_agent",
      config: { prompt: "Test prompt", autoRecover: false, failOnError: true },
    };
    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.threadId).toBe("thread-native-session");
    const runLogText = ctx.logs.map((entry) => String(entry?.message || "")).join("\n");
    expect(runLogText).toMatch(/Tool call: run_workspace_command/);
    expect(runLogText).toMatch(/Tool result: run_workspace_command/);
    expect(runLogText).toMatch(/Tool result: read_file_content, edit_file/);
    expect(runLogText).toMatch(/Agent completed: success=true streamEvents=3/);
  });

  it("stores action.run_agent output in the requested outputVariable", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: "Concrete implementation plan",
      sdk: "codex",
      items: [],
      threadId: "thread-output-variable",
    });

    const result = await handler.execute({
      id: "plan-agent",
      type: "action.run_agent",
      config: {
        prompt: "Plan the work",
        mode: "plan",
        executionRole: "architect",
        outputVariable: "plan",
        autoRecover: false,
      },
    }, ctx, {
      services: {
        agentPool: { launchEphemeralThread },
      },
    });

    expect(result.success).toBe(true);
    expect(ctx.data.plan).toBe("Concrete implementation plan");
  });

  it("marks action.run_agent as waiting until a shared agent slot is acquired", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const originalSetNodeStatus = ctx.setNodeStatus.bind(ctx);
    ctx.setNodeStatus = vi.fn((nodeId, status) => originalSetNodeStatus(nodeId, status));
    const launchEphemeralThread = vi.fn().mockImplementation(async (_prompt, _cwd, _timeoutMs, extra) => {
      extra?.onSlotQueued?.({
        ownerKey: "slot-owner",
        activeSlots: 1,
        queuedSlots: 1,
        queueDepth: 1,
        maxParallel: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      extra?.onSlotAcquired?.({
        slotId: "agent-slot-test",
        ownerKey: "slot-owner",
        activeSlots: 1,
        queuedSlots: 0,
        maxParallel: 1,
        waitedMs: 10,
      });
      return {
        success: true,
        output: "done",
        sdk: "codex",
        items: [],
        threadId: "thread-slot-test",
      };
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const node = {
      id: "a-slot-wait",
      type: "action.run_agent",
      config: { prompt: "Test prompt", autoRecover: false, failOnError: true },
    };

    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.success).toBe(true);
    expect(launchEphemeralThread).toHaveBeenCalledTimes(1);
    expect(launchEphemeralThread.mock.calls[0][3]).toEqual(
      expect.objectContaining({
        slotOwnerKey: expect.stringContaining(":a-slot-wait"),
        onSlotQueued: expect.any(Function),
        onSlotAcquired: expect.any(Function),
      }),
    );
    expect(ctx.setNodeStatus.mock.calls).toEqual(
      expect.arrayContaining([
        ["a-slot-wait", "waiting"],
        ["a-slot-wait", "running"],
      ]),
    );
    const runLogText = ctx.logs.map((entry) => String(entry?.message || "")).join("\n");
    expect(runLogText).toMatch(/waiting for shared agent slot/i);
    expect(runLogText).toMatch(/acquired shared agent slot/i);
  });

  it("aborts silent agent launches when no events arrive after slot acquisition", async () => {
    vi.useFakeTimers();
    try {
      const handler = getNodeType("action.run_agent");
      expect(handler).toBeDefined();

      const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
      let capturedAbortController = null;
      const launchEphemeralThread = vi.fn().mockImplementation(
        async (_prompt, _cwd, _timeoutMs, extra) => {
          capturedAbortController = extra?.abortController || null;
          extra?.onSlotAcquired?.({
            slotId: "agent-slot-silent",
            ownerKey: "slot-owner-silent",
            activeSlots: 1,
            queuedSlots: 0,
            maxParallel: 1,
            waitedMs: 0,
          });
          return await new Promise(() => {});
        },
      );
      const mockEngine = {
        services: {
          agentPool: {
            launchEphemeralThread,
          },
        },
      };

      const pending = handler.execute({
        id: "a-silent-launch",
        type: "action.run_agent",
        config: {
          prompt: "Test prompt",
          autoRecover: false,
          failOnError: false,
          firstEventTimeoutMs: 25,
        },
      }, ctx, mockEngine);

      await vi.advanceTimersByTimeAsync(30);
      const result = await pending;

      expect(result.success).toBe(false);
      expect(String(result.error || "")).toMatch(/first_event_timeout/i);
      expect(capturedAbortController?.signal?.aborted).toBe(true);
      expect(capturedAbortController?.signal?.reason).toBe("first_event_timeout");
      const runLogText = ctx.logs.map((entry) => String(entry?.message || "")).join("\n");
      expect(runLogText).toMatch(/no events within 25ms; aborting run/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not clear the silent launch guard for non-meaningful lifecycle events", async () => {
    vi.useFakeTimers();
    try {
      const handler = getNodeType("action.run_agent");
      expect(handler).toBeDefined();

      const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
      let capturedAbortController = null;
      const launchEphemeralThread = vi.fn().mockImplementation(
        async (_prompt, _cwd, _timeoutMs, extra) => {
          capturedAbortController = extra?.abortController || null;
          extra?.onSlotAcquired?.({
            slotId: "agent-slot-lifecycle-only",
            ownerKey: "slot-owner-lifecycle-only",
            activeSlots: 1,
            queuedSlots: 0,
            maxParallel: 1,
            waitedMs: 0,
          });
          extra?.onEvent?.({
            type: "session.stream.start",
            sessionId: "test-native-session",
          });
          extra?.onEvent?.({
            type: "session.turn.start",
            sessionId: "test-native-session",
          });
          extra?.onEvent?.({
            type: "session.stream.complete",
            sessionId: "test-native-session",
            text: "",
          });
          extra?.onEvent?.({
            type: "session.step.finish",
            sessionId: "test-native-session",
            toolCalls: [],
            toolResults: [],
          });
          return await new Promise(() => {});
        },
      );
      const mockEngine = {
        services: {
          agentPool: {
            launchEphemeralThread,
          },
        },
      };

      const pending = handler.execute({
        id: "a-lifecycle-only-launch",
        type: "action.run_agent",
        config: {
          prompt: "Test prompt",
          autoRecover: false,
          failOnError: false,
          firstEventTimeoutMs: 25,
        },
      }, ctx, mockEngine);

      await vi.advanceTimersByTimeAsync(30);
      const result = await pending;

      expect(result.success).toBe(false);
      expect(String(result.error || "")).toMatch(/first_event_timeout/i);
      expect(capturedAbortController?.signal?.aborted).toBe(true);
      expect(capturedAbortController?.signal?.reason).toBe("first_event_timeout");
      const runLogText = ctx.logs.map((entry) => String(entry?.message || "")).join("\n");
      expect(runLogText).toMatch(/no events within 25ms; aborting run/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let workflow heartbeats mask a missing first agent event", async () => {
    vi.useFakeTimers();
    try {
      const handler = getNodeType("action.run_agent");
      expect(handler).toBeDefined();

      const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
      let capturedAbortController = null;
      const launchEphemeralThread = vi.fn().mockImplementation(
        async (_prompt, _cwd, _timeoutMs, extra) => {
          capturedAbortController = extra?.abortController || null;
          extra?.onSlotAcquired?.({
            slotId: "agent-slot-heartbeat-only",
            ownerKey: "slot-owner-heartbeat-only",
            activeSlots: 1,
            queuedSlots: 0,
            maxParallel: 1,
            waitedMs: 0,
          });
          return await new Promise(() => {});
        },
      );
      const mockEngine = {
        services: {
          agentPool: {
            launchEphemeralThread,
          },
        },
      };

      const pending = handler.execute({
        id: "a-heartbeat-only-launch",
        type: "action.run_agent",
        config: {
          prompt: "Test prompt",
          autoRecover: false,
          failOnError: false,
          firstEventTimeoutMs: 35_000,
        },
      }, ctx, mockEngine);

      await vi.advanceTimersByTimeAsync(30_010);
      await vi.advanceTimersByTimeAsync(5_500);
      const result = await pending;

      expect(result.success).toBe(false);
      expect(String(result.error || "")).toMatch(/first_event_timeout/i);
      expect(capturedAbortController?.signal?.aborted).toBe(true);
      expect(capturedAbortController?.signal?.reason).toBe("first_event_timeout");
      const runLogText = ctx.logs.map((entry) => String(entry?.message || "")).join("\n");
      expect(runLogText).toMatch(/still running/i);
      expect(runLogText).toMatch(/no events within 35000ms; aborting run/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not trip the silent launch guard while waiting in the shared slot queue", async () => {
    vi.useFakeTimers();
    try {
      const handler = getNodeType("action.run_agent");
      expect(handler).toBeDefined();

      const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
      const launchEphemeralThread = vi.fn().mockImplementation(
        async (_prompt, _cwd, _timeoutMs, extra) => await new Promise((resolve) => {
          extra?.onSlotQueued?.({
            ownerKey: "slot-owner-queued",
            activeSlots: 1,
            queuedSlots: 1,
            queueDepth: 1,
            maxParallel: 1,
          });
          setTimeout(() => {
            extra?.onSlotAcquired?.({
              slotId: "agent-slot-queued",
              ownerKey: "slot-owner-queued",
              activeSlots: 1,
              queuedSlots: 0,
              maxParallel: 1,
              waitedMs: 50,
            });
            extra?.onEvent?.({
              type: "agent_message",
              message: { content: "Agent is now running." },
            });
            resolve({
              success: true,
              output: "done",
              sdk: "codex",
              items: [],
              threadId: "thread-slot-guard",
            });
          }, 50);
        }),
      );
      const mockEngine = {
        services: {
          agentPool: {
            launchEphemeralThread,
          },
        },
      };

      const pending = handler.execute({
        id: "a-slot-guard",
        type: "action.run_agent",
        config: {
          prompt: "Test prompt",
          autoRecover: false,
          failOnError: false,
          firstEventTimeoutMs: 25,
        },
      }, ctx, mockEngine);

      await vi.advanceTimersByTimeAsync(60);
      const result = await pending;

      expect(result.success).toBe(true);
      expect(result.threadId).toBe("thread-slot-guard");
      const runLogText = ctx.logs.map((entry) => String(entry?.message || "")).join("\n");
      expect(runLogText).toMatch(/waiting for shared agent slot/i);
      expect(runLogText).toMatch(/acquired shared agent slot after 1s/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats success-shaped delegate no-output summaries as blocked_by_env", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const blockedSummary = "session.turn.complete: Blocked: execution environment / stalled delegated agent. The delegated coding session is still running but hasn’t emitted output yet. Status: `no_output`.";
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      summary: blockedSummary,
      narrative: blockedSummary,
      sdk: "openai-native",
      threadId: "thread-blocked-summary",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-blocked-summary",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/no_output|stalled|no output/i);
  });

  it("treats summary-only delegated no-output implement blockers as blocked_by_env", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const blockedSummary = "session.turn.complete: Blocked: delegated session produced no output; insufficient direct write-capable inspection in current session.";
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      summary: blockedSummary,
      narrative: blockedSummary,
      sdk: "openai-native",
      threadId: "thread-read-only-summary",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-read-only-summary",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/delegated session produced no output/i);
  });

  it("treats digest-only delegated no-output blockers as blocked_by_env", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const launchEphemeralThread = vi.fn().mockImplementation(async (_prompt, _cwd, _timeoutMs, extra) => {
      extra?.onEvent?.({
        type: "agent_message",
        message: {
          content: "Blocked: delegated session produced no output; insufficient direct write-capable inspection in current session.",
        },
      });
      return {
        success: true,
        output: "",
        sdk: "openai-native",
        threadId: "thread-digest-only-blocked",
      };
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-digest-only-blocked",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/delegated session produced no output/i);
  });

  it("treats delegated inspection stalls with a clean workspace as blocked_by_env", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      summary: "session.turn.complete: Started a fresh implementation attempt. New session: `delegate-live-123`.",
      narrative: "session.turn.complete: Started a fresh implementation attempt. New session: `delegate-live-123`.",
      stream: [
        "session.turn.complete: I can’t retrieve the delegated run from the available session APIs yet. Current state: - The live delegate was started as `delegate-live-123`.",
        "session.turn.complete: No implementation landed in the workspace. Verified state: - `git status --short`: clean - no modified files.",
        "session.turn.complete: Still no implementation present. Verified again: - Working tree: clean.",
      ],
      sdk: "openai-native",
      threadId: "thread-delegation-stall",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-delegation-stall",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/retrieve the delegated run/i);
  });

  it("treats delegate failure fallback patch summaries as blocked_by_env", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: "I’m still blocked from applying changes in this environment, but here is the exact patch I’d make.",
      summary: "I’m still blocked from applying changes in this environment, but here is the exact patch I’d make.",
      narrative: "I’m still blocked from applying changes in this environment, but here is the exact patch I’d make.",
      stream: [
        "session.turn.complete: The delegated coding session failed immediately without producing output. Session: `delegate-live-123`",
        "session.turn.complete: I’m blocked on execution in this session. - The write-capable delegated agent failed: `delegate-live-123` - Direct workspace mutation/test execution is restricted here.",
        "session.turn.complete: I can’t complete the implementation from this session because the environment is repeating the same read-only inspection loop and every write-capable path has failed or is blocked.",
      ],
      sdk: "openai-native",
      threadId: "thread-delegate-failure-fallback",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-delegate-failure-fallback",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/failed immediately without producing output|blocked on execution/i);
  });

  it("treats tooling-session write path fallbacks as blocked_by_env", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const blockedOutput = `Blocked: tooling/session write path unavailable.

I could not implement because:
- edit_file is unusable in this session
- run_workspace_command is restricted from non-read-only editing workflows
- delegated code session \`delegate-live-123\` failed immediately with no transcript

Status:
- blocked: tooling/session write path unavailable`;
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: blockedOutput,
      summary: blockedOutput,
      narrative: blockedOutput,
      sdk: "openai-native",
      threadId: "thread-write-path-blocked",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-write-path-blocked",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/tooling\/session write path unavailable|no transcript/i);
  });

  it("treats truthfully-cannot-claim-implemented summaries as blocked_by_env", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const blockedOutput = "I can’t truthfully claim this task is implemented in the current session. Final status: - No code changes made - No tests run - No build run - No commit created.";
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: blockedOutput,
      summary: blockedOutput,
      narrative: blockedOutput,
      sdk: "openai-native",
      threadId: "thread-truthful-blocked",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-truthful-blocked",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/truthfully claim this task is implemented|no commit created/i);
  });

  it("treats insufficient write-execute capability summaries as blocked_by_env", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const blockedOutput = "blocked: insufficient write/execute capability in current session I can inspect files, but I cannot safely modify them or run verification commands here. The write tool calls failed, and workspace shell execution is restricted.";
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: blockedOutput,
      summary: blockedOutput,
      narrative: blockedOutput,
      sdk: "openai-native",
      threadId: "thread-insufficient-write-exec",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-insufficient-write-exec",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/insufficient write\/execute capability|workspace shell execution is restricted/i);
  });

  it("treats blocked write-capable tooling summaries as blocked_by_env", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const blockedOutput = "I’m blocked in this session because I don’t have usable write-capable tooling here. Summary: - I inspected the target area and found the relevant write path in `workspace/shared-knowledge.mjs`. - The right fix is to move from a single gate to scoped throttling.";
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: blockedOutput,
      summary: blockedOutput,
      narrative: blockedOutput,
      sdk: "openai-native",
      threadId: "thread-write-capable-tooling-blocked",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-write-capable-tooling-blocked",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/write-capable tooling/i);
  });

  it("treats delegated session before-work-start failures as blocked_by_env", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const blockedOutput = "The delegated session is failing before any work starts: - Session: `delegate-live-123` - Error: `Codex Exec exited with code 1: Reading prompt from stdin...` So this is not a task-logic failure in the target module.";
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: blockedOutput,
      summary: blockedOutput,
      narrative: blockedOutput,
      sdk: "openai-native",
      threadId: "thread-delegate-before-work-start",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-delegate-before-work-start",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/failing before any work starts|reading prompt from stdin/i);
  });

  it("treats read-only shell access blocker streams as blocked_by_env even when summary looks successful", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      summary: "Tool result: list_sessions",
      narrative: "Tool result: list_sessions",
      stream: [
        "Tool call: edit_file",
        "Tool result: edit_file",
        "session.turn.complete: I’m blocked from completing this task in the current session because the workspace only permits read-only shell access, and the file-edit tools available here require exact replacement payloads I can’t safely construct here.",
        "Tool call: delegate_to_agent",
        "Tool result: delegate_to_agent",
      ],
      sdk: "openai-native",
      threadId: "thread-read-only-shell-access",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-read-only-shell-access",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/read-only shell access|exact replacement payloads/i);
  });

  it("treats tool-capability blocked summaries as blocked_by_env", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const blockedOutput = "Still blocked: no usable write-capable tool path in this session. Verified - Target: `workspace/shared-knowledge.mjs` - Tests: `tests/fleet-coordinator.test.mjs` - this session does not expose a working file-edit path, and I cannot truthfully claim implementation. Final status: blocked: tool capability issue in current session.";
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: blockedOutput,
      summary: blockedOutput,
      narrative: blockedOutput,
      sdk: "openai-native",
      threadId: "thread-tool-capability-blocked",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-tool-capability-blocked",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/write-capable tool path|tool capability issue|truthfully claim implementation/i);
  });

  it("treats active delegated-agent summaries as blocked_by_env", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const blockedOutput = "Background agent is still running. - Session: `delegate-live-123` - Status: active - Latest output: none yet If you want, I can keep polling and report back when it finishes.";
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: blockedOutput,
      summary: blockedOutput,
      narrative: blockedOutput,
      sdk: "openai-native",
      threadId: "thread-active-delegate-blocked",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-active-delegate-blocked",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/still running|status:\s*active|none yet/i);
  });

  it("treats read-only analysis blockers as blocked_by_env", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const blockedOutput = "Still blocked. I cannot advance beyond analysis because the session remains read-only for writes and all attempted code-edit paths fail.";
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: blockedOutput,
      summary: blockedOutput,
      narrative: blockedOutput,
      sdk: "openai-native",
      threadId: "thread-read-only-analysis-blocked",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-read-only-analysis-blocked",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/read-only for writes|advance beyond analysis/i);
  });

  it("treats environment-constraint fallback summaries as blocked_by_env", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const blockedOutput = "I’m still blocked by environment constraints, not by uncertainty in the task. Current state: - Direct session: read-only / cannot run non-read-only workspace commands - Writable delegation attempt: failed immediately - No code changes were applied, so there is nothing real to validate. Blocker: blocked: environment constraints.";
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: blockedOutput,
      summary: blockedOutput,
      narrative: blockedOutput,
      sdk: "openai-native",
      threadId: "thread-env-constraints-blocked",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-env-constraints-blocked",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/environment constraints|writable delegation attempt failed immediately/i);
  });

  it("treats failing delegated executor path summaries as blocked_by_env", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const blockedOutput = "No change from prior status: still blocked by lack of writable access in this session and failing delegated executor path.";
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: blockedOutput,
      summary: blockedOutput,
      narrative: blockedOutput,
      sdk: "openai-native",
      threadId: "thread-delegated-executor-blocked",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-delegated-executor-blocked",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/writable access in this session|delegated executor path/i);
  });

  it("treats read-only workspace session summaries as blocked_by_env", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const blockedOutput = "blocked: read-only workspace session I confirmed: - implementation target: `workspace/shared-knowledge.mjs` - test target: `tests/fleet-coordinator.test.mjs` - direct write/test/commit operations are denied in this session";
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: blockedOutput,
      summary: blockedOutput,
      narrative: blockedOutput,
      sdk: "openai-native",
      threadId: "thread-read-only-workspace-session",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-read-only-workspace-session",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/read-only workspace session|write\/test\/commit operations are denied/i);
  });

  it("treats recursive delegation stall summaries as blocked_by_env", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const blockedSummary = "session.turn.complete: Delegation did not progress normally: the live delegate session appears to be repeatedly spawning nested sessions instead of producing code/output. Current state: - Delegate root session: `delegate-live-123`";
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      summary: blockedSummary,
      narrative: blockedSummary,
      stream: [
        "session.turn.complete: I’m blocked on tool-side file modification, not on code understanding.",
      ],
      sdk: "openai-native",
      threadId: "thread-recursive-delegation-stall",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-recursive-delegation-stall",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/delegation did not progress normally|tool-side file modification/i);
  });

  it("treats stuck delegated-session summaries as blocked_by_env", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const blockedOutput = "The delegated session still appears stuck, so the best next step is to cancel and re-delegate or switch executor. Right now I cannot truthfully report completion. Current facts: - Relevant implementation file: `workspace/shared-knowledge.mjs`";
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: blockedOutput,
      summary: blockedOutput,
      narrative: blockedOutput,
      sdk: "openai-native",
      threadId: "thread-stuck-delegated-session",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-stuck-delegated-session",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/delegated session still appears stuck|truthfully report completion/i);
  });

  it("treats delegated child no-output summaries as blocked_by_env", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const blockedOutput = "session.turn.complete: The delegated child session still has no output yet. Status: - parent: `delegate-live-parent` - child: `delegate-live-child` - child transcript/messages: 0 - overall: still active, but no agent output.";
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: blockedOutput,
      summary: blockedOutput,
      narrative: blockedOutput,
      sdk: "openai-native",
      threadId: "thread-delegated-child-no-output",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const result = await handler.execute({
      id: "a-delegated-child-no-output",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        autoRecover: false,
        failOnError: false,
      },
    }, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("blocked_by_env");
    expect(String(result.error || "")).toMatch(/delegated child session still has no output yet|no agent output/i);
  });

  it("ignores unresolved model placeholders when launching an agent", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: "done",
      sdk: "codex",
      items: [],
      threadId: "thread-no-model",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const node = {
      id: "a-unresolved-model",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        model: "{{resolvedModel}}",
        autoRecover: false,
      },
    };

    await handler.execute(node, ctx, mockEngine);

    expect(launchEphemeralThread).toHaveBeenCalledTimes(1);
    expect(launchEphemeralThread.mock.calls[0][3]).not.toHaveProperty("model");
  });

  it("falls back to the bound runtime worktree when cwd resolves to an unresolved template", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/runtime-worktree" });
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: "done",
      sdk: "codex",
      items: [],
      threadId: "thread-runtime-cwd",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const node = {
      id: "a-unresolved-cwd",
      type: "action.run_agent",
      config: {
        prompt: "Test prompt",
        cwd: "{{worktreePath}}",
        autoRecover: false,
      },
    };

    await handler.execute(node, ctx, mockEngine);

    expect(launchEphemeralThread).toHaveBeenCalledTimes(1);
    expect(launchEphemeralThread.mock.calls[0][1]).toBe("/tmp/runtime-worktree");
  });

  it("fails fast in strict cache anchor mode when system prompt includes task markers", async () => {
    const previous = process.env.BOSUN_CACHE_ANCHOR_MODE;
    process.env.BOSUN_CACHE_ANCHOR_MODE = "strict";
    try {
      const handler = getNodeType("action.run_agent");
      expect(handler).toBeDefined();

      const ctx = new WorkflowContext({
        taskId: "STRICT-42",
        taskTitle: "Strict title",
        worktreePath: "/tmp/strict-cache",
      });
      const launchEphemeralThread = vi.fn().mockResolvedValue({
        success: true,
        output: "done",
        sdk: "codex",
        items: [],
        threadId: "thread-strict",
      });
      const mockEngine = {
        services: {
          agentPool: {
            launchEphemeralThread,
          },
        },
      };
      const node = {
        id: "a-strict",
        type: "action.run_agent",
        config: {
          prompt: "Do work",
          systemPrompt: "System prompt for {{taskTitle}}",
          autoRecover: false,
        },
      };

      await expect(handler.execute(node, ctx, mockEngine)).rejects.toThrow(
        /BOSUN_CACHE_ANCHOR_MODE=strict/,
      );
      expect(launchEphemeralThread).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.BOSUN_CACHE_ANCHOR_MODE;
      else process.env.BOSUN_CACHE_ANCHOR_MODE = previous;
    }
  });

  it("resolves templated timeoutMs before launching agent", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({
      worktreePath: "/tmp/test",
      taskTimeoutMs: 21600000,
    });
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: "done",
      sdk: "codex",
      items: [],
      threadId: "thread-timeout-resolve",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const node = {
      id: "a-timeout",
      type: "action.run_agent",
      config: {
        prompt: "timeout test",
        timeoutMs: "{{taskTimeoutMs}}",
        autoRecover: false,
      },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(true);
    expect(launchEphemeralThread).toHaveBeenCalledTimes(1);
    expect(launchEphemeralThread.mock.calls[0][2]).toBe(21600000);
  });

  it("propagates threadId to context from execWithRetry", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();
  });

  it("ignores noisy delta stream events while keeping meaningful agent updates", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const launchEphemeralThread = vi.fn().mockImplementation(
      async (_prompt, _cwd, _timeoutMs, extra) => {
        extra?.onEvent?.({ type: "assistant.reasoning_delta", data: { content: "test" } });
        extra?.onEvent?.({ type: "assistant.reasoning_delta", data: { content: ":" } });
        extra?.onEvent?.({ type: "assistant.message", data: { content: "Added regression coverage." } });
        return {
          success: true,
          output: "ok",
          sdk: "codex",
          items: [],
          threadId: "thread-delta-filter",
        };
      },
    );
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const node = { id: "a-delta", type: "action.run_agent", config: { prompt: "delta test" } };
    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.success).toBe(true);
    expect(result.threadId).toBe("thread-delta-filter");
    const runLogText = ctx.logs.map((entry) => String(entry?.message || "")).join("\n");
    expect(runLogText).not.toContain("assistant.reasoning_delta");
    expect(runLogText).toMatch(/Agent: Added regression coverage\./);
  });

  it("condenses noisy assistant events into narrative summaries", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const launchEphemeralThread = vi.fn().mockImplementation(
      async (_prompt, _cwd, _timeoutMs, extra) => {
        extra?.onEvent?.({
          type: "item.completed",
          item: {
            type: "reasoning",
            summary: "Tracing noisy completion logs and extracting only meaningful context.",
          },
        });
        extra?.onEvent?.({
          type: "assistant.message",
          data: {
            content: "",
            detailedContent:
              "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:16:function getLocalLanIp() {\n" +
              "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:133:function ensureLibraryInitialized() {\n" +
              "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:161:async function getWorkflowEngineModule() {\n" +
              "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:7394:export function stopTelegramUiServer() {",
          },
        });
        extra?.onEvent?.({
          type: "assistant.message",
          data: {
            content: "",
            toolRequests: [{ name: "view" }, { name: "find" }, { name: "view" }],
          },
        });
        extra?.onEvent?.({
          type: "assistant.usage",
          data: {
            model: "claude-sonnet-4.6",
            inputTokens: 5170,
            outputTokens: 484,
            duration: 7899,
          },
        });
        return {
          success: true,
          output:
            "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:16:function getLocalLanIp() {\n" +
            "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:133:function ensureLibraryInitialized() {\n" +
            "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:161:async function getWorkflowEngineModule() {",
          sdk: "copilot",
          items: [
            {
              type: "assistant.message",
              data: {
                content: "",
                detailedContent:
                  "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:16:function getLocalLanIp() {\n" +
                  "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:133:function ensureLibraryInitialized() {\n" +
                  "C:\\Users\\jON\\AppData\\Roaming\\bosun\\workspaces\\virtengine-gh\\bosun\\ui-server.mjs:161:async function getWorkflowEngineModule() {",
              },
            },
            {
              type: "assistant.message",
              data: { content: "", toolRequests: [{ name: "view" }, { name: "find" }] },
            },
            {
              type: "item.completed",
              item: {
                type: "reasoning",
                summary: "Tracing noisy completion logs and extracting only meaningful context.",
              },
            },
            {
              type: "assistant.usage",
              data: { model: "claude-sonnet-4.6", inputTokens: 100, outputTokens: 50 },
            },
          ],
          threadId: "thread-noise-test",
        };
      },
    );

    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const node = {
      id: "a2",
      type: "action.run_agent",
      config: { prompt: "parse noisy logs", maxRetainedEvents: 20 },
    };
    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.summary).toMatch(/Indexed \d+ code references/);
    expect(result.narrative).toContain("Thought process:");
    expect(result.narrative).toContain("Actions:");
    expect(result.stream).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Thinking:/),
        expect.stringMatching(/^Agent detail:/),
        expect.stringMatching(/^Agent requested tools:/),
      ]),
    );
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.itemCount).toBe(4);
    expect(result.omittedItemCount).toBe(0);
    expect(result.threadId).toBe("thread-noise-test");

    const runLogText = ctx.logs.map((entry) => String(entry?.message || "")).join("\n");
    expect(runLogText).toMatch(/Agent detail: Indexed/);
    expect(runLogText).toMatch(/Agent requested tools: view, find/);
    expect(runLogText).toMatch(/Usage:/);
  });

  it("propagates threadId to context from execWithRetry when autoRecover=true", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread: vi.fn().mockResolvedValue({
            success: true,
            output: "done",
            sdk: "codex",
            items: [],
            threadId: "thread-fallback-unused",
          }),
          execWithRetry: vi.fn().mockResolvedValue({
            success: true,
            output: "done",
            sdk: "codex",
            items: [],
            threadId: "thread-abc-123",
            attempts: 2,
            continues: 1,
            resumed: true,
          }),
        },
      },
    };
    const node = { id: "a1b", type: "action.run_agent", config: { prompt: "Test prompt", autoRecover: true } };
    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.threadId).toBe("thread-abc-123");
    expect(result.sessionId).toBe("thread-abc-123");
    expect(ctx.data.sessionId).toBe("thread-abc-123");
    expect(ctx.data.threadId).toBe("thread-abc-123");
    expect(result.attempts).toBe(2);
    expect(mockEngine.services.agentPool.execWithRetry).toHaveBeenCalledTimes(1);
    expect(mockEngine.services.agentPool.execWithRetry.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        sessionType: "flow",
        onEvent: expect.any(Function),
        systemPrompt: expect.any(String),
      }),
    );
  });

  it("invalidates a stale task-key thread before retrying with a fresh managed session", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({
      _workflowId: "template-task-lifecycle",
      _workflowName: "Task Lifecycle",
      worktreePath: "/tmp/test",
      taskId: "TASK-STALE-1",
      taskTitle: "Recover stale session",
      task: {
        id: "TASK-STALE-1",
        title: "Recover stale session",
        branchName: "feat/recover-stale-session",
      },
      _workflowParentSessionId: "TASK-STALE-1",
      _workflowRootSessionId: "TASK-STALE-1",
    });
    ctx.id = "retry-run-1";

    const invalidateThread = vi.fn();
    const launchOrResumeThread = vi.fn()
      .mockRejectedValueOnce(new Error("Cannot read properties of null (reading 'sessionId')"))
      .mockResolvedValueOnce({
        success: true,
        output: "fresh retry succeeded",
        sdk: "openai-native",
        items: [],
        threadId: "thread-fresh-1",
      });
    const mockEngine = {
      services: {
        agentPool: {
          invalidateThread,
          launchOrResumeThread,
        },
      },
    };
    const node = {
      id: "run-agent-plan",
      type: "action.run_agent",
      config: { prompt: "Recover the task", autoRecover: true },
    };

    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.success).toBe(true);
    expect(result.threadId).toBe("thread-fresh-1");
    expect(result.sessionId).toBe("thread-fresh-1");
    expect(ctx.data.sessionId).toBe("thread-fresh-1");
    expect(ctx.data.threadId).toBe("thread-fresh-1");
    expect(invalidateThread).toHaveBeenCalledTimes(1);
    expect(invalidateThread).toHaveBeenCalledWith("template-task-lifecycle:retry-run-1:run-agent-plan");
    expect(launchOrResumeThread).toHaveBeenCalledTimes(2);
    expect(launchOrResumeThread.mock.calls[0][3]).toEqual(
      expect.objectContaining({
        taskKey: "template-task-lifecycle:retry-run-1:run-agent-plan",
      }),
    );
    expect(launchOrResumeThread.mock.calls[1][3]).toEqual(
      expect.objectContaining({
        taskKey: "template-task-lifecycle:retry-run-1:run-agent-plan",
      }),
    );
    expect(String(launchOrResumeThread.mock.calls[1][3]?.sessionId || "")).toContain(":fresh-");
    expect(invalidateThread.mock.invocationCallOrder[0]).toBeLessThan(
      launchOrResumeThread.mock.invocationCallOrder[1],
    );
  });

  it("creates and completes task sessions for task-backed agent runs", async () => {
    const handler = getNodeType("action.run_agent");
    const ctx = new WorkflowContext({
      worktreePath: "/tmp/test",
      taskId: "TASK-SESSION-1",
      task: { id: "TASK-SESSION-1", title: "Task-backed run", branchName: "feat/task-session" },
      workspaceId: "virtengine-gh",
    });
    const execWithRetry = vi.fn().mockImplementation(async (_prompt, opts) => {
      opts?.onEvent?.({
        type: "assistant.message",
        data: { content: "Task run completed." },
      });
      return {
        success: true,
        output: "done",
        sdk: "codex",
        items: [],
        threadId: "thread-task-1",
      };
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread: vi.fn(),
          execWithRetry,
        },
      },
    };

    const node = { id: "task-agent", type: "action.run_agent", config: { prompt: "Do task work", autoRecover: true } };
    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.success).toBe(true);
    expect(execWithRetry).toHaveBeenCalledTimes(1);
    expect(execWithRetry.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        sessionType: "task",
        onEvent: expect.any(Function),
        systemPrompt: expect.any(String),
      }),
    );

    const tracker = getSessionTracker();
    const session = tracker.getSessionById("TASK-SESSION-1");
    const childSession = tracker.listAllSessions({ includePersisted: false })
      .find((entry) => entry.taskId === "TASK-SESSION-1" && entry.type === "delegate");
    expect(session).toBeTruthy();
    expect(session.type).toBe("task");
    expect(session.status).toBe("completed");
    expect(session.metadata.workspaceId).toBe("virtengine-gh");
    expect(session.metadata.workspaceDir).toBe("/tmp/test");
    expect(session.metadata.branch).toBe("feat/task-session");
    expect(childSession).toBeTruthy();
    expect((tracker.getSessionById(childSession.id)?.messages || []).some((msg) => String(msg.content || "").includes("Task run completed."))).toBe(true);
  });

  it("prepends architect/editor framing and repo maps for workflow agent runs", async () => {
    const handler = getNodeType("action.run_agent");
    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: "done",
      sdk: "codex",
      items: [],
      threadId: "thread-architect-editor",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const node = {
      id: "run-agent-architect-editor",
      type: "action.run_agent",
      config: {
        prompt: "Apply the approved plan",
        autoRecover: false,
        executionRole: "editor",
        architectPlan: "1. Update prompt framing\n2. Validate runtime tests",
        repoMap: {
          root: "C:/repo",
          files: [
            { path: "agent/primary-agent.mjs", summary: "primary agent runtime", symbols: ["execPrimaryPrompt"] },
          ],
        },
      },
    };

    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.success).toBe(true);
    const sentPrompt = String(launchEphemeralThread.mock.calls[0][0] || "");
    expect(sentPrompt).toContain("## Architect/Editor Execution");
    expect(sentPrompt).toContain("You are the editor phase.");
    expect(sentPrompt).toContain("## Architect Plan");
    expect(sentPrompt).toContain("Root: C:/repo");
    expect(sentPrompt).toContain("agent/primary-agent.mjs");
    expect(sentPrompt).toContain("Apply the approved plan");
  });

  it("throws when agent execution returns success=false when failOnError=true", async () => {
    const handler = getNodeType("action.run_agent");
    const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread: vi.fn().mockResolvedValue({
            success: false,
            error: "agent crashed",
          }),
        },
      },
    };
    const node = {
      id: "a2",
      type: "action.run_agent",
      config: { prompt: "Test prompt", autoRecover: false, failOnError: true },
    };
    await expect(handler.execute(node, ctx, mockEngine)).rejects.toThrow(/agent crashed/i);
  });

  it("continues existing session before retrying fresh", async () => {
    const handler = getNodeType("action.run_agent");
    const ctx = new WorkflowContext({
      worktreePath: "/tmp/test",
      sessionId: "thread-existing-1",
    });
    const continueSession = vi.fn().mockResolvedValue({
      success: true,
      output: "continued",
      threadId: "thread-existing-1",
      sdk: "copilot",
    });
    const execWithRetry = vi.fn().mockResolvedValue({
      success: true,
      output: "should-not-be-used",
      threadId: "thread-new",
      sdk: "copilot",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread: vi.fn().mockResolvedValue({
            success: true,
            output: "fallback",
            sdk: "copilot",
            threadId: "thread-fallback",
          }),
          continueSession,
          execWithRetry,
        },
      },
    };
    const node = { id: "a3", type: "action.run_agent", config: { prompt: "Continue work", continueOnSession: true } };
    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(true);
    expect(result.threadId).toBe("thread-existing-1");
    expect(continueSession).toHaveBeenCalledTimes(1);
    expect(execWithRetry).not.toHaveBeenCalled();
  });

  it("treats continue-session fallback to launchEphemeralThread as a fresh ephemeral turn", async () => {
    const handler = getNodeType("action.run_agent");
    const ctx = new WorkflowContext({
      worktreePath: "/tmp/test",
      sessionId: "thread-ephemeral-fallback-1",
    });
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: "fresh fallback",
      threadId: "thread-ephemeral-fallback-new",
      sdk: "codex",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };
    const node = {
      id: "a-ephemeral-fallback",
      type: "action.run_agent",
      config: { prompt: "Continue work", continueOnSession: true, autoRecover: true },
    };

    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.success).toBe(true);
    expect(result.threadId).toBe("thread-ephemeral-fallback-new");
    expect(launchEphemeralThread).toHaveBeenCalledTimes(1);
    expect(launchEphemeralThread.mock.calls[0][3]).not.toHaveProperty("sessionId");
    expect(launchEphemeralThread.mock.calls[0][3]).not.toHaveProperty("taskKey");
    expect(launchEphemeralThread.mock.calls[0][3]).not.toHaveProperty("resumeThreadId");
  });

  it("skips continuing a stored session from a different run_agent node", async () => {
    const handler = getNodeType("action.run_agent");
    const ctx = new WorkflowContext({
      worktreePath: "/tmp/test",
      sessionId: "thread-tests-1",
      _agentSessionNodeId: "run-agent-tests",
    });
    const continueSession = vi.fn().mockResolvedValue({
      success: true,
      output: "should-not-be-used",
      threadId: "thread-tests-1",
      sdk: "copilot",
    });
    const execWithRetry = vi.fn().mockResolvedValue({
      success: true,
      output: "implemented",
      threadId: "thread-implement-1",
      sdk: "copilot",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread: vi.fn().mockResolvedValue({
            success: true,
            output: "fallback",
            sdk: "copilot",
            threadId: "thread-fallback",
          }),
          continueSession,
          execWithRetry,
        },
      },
    };
    const node = {
      id: "run-agent-implement",
      type: "action.run_agent",
      config: { prompt: "Implement work", continueOnSession: true },
    };

    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.success).toBe(true);
    expect(result.threadId).toBe("thread-implement-1");
    expect(continueSession).not.toHaveBeenCalled();
    expect(execWithRetry).toHaveBeenCalledTimes(1);
    expect(execWithRetry.mock.calls[0][1].taskKey).not.toBe("thread-tests-1");
    expect(execWithRetry.mock.calls[0][1].taskKey).toContain(":run-agent-implement");
    expect(ctx.data._agentSessionNodeId).toBe("run-agent-implement");
  });

  it("runs multi-candidate selector mode when candidateCount > 1 and restores selected branch", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const repoDir = mkdtempSync(join(tmpdir(), "wf-agent-candidates-"));
    try {
      execGit("git init", { cwd: repoDir, stdio: "ignore" });
      execGit('git config --local user.email "bot@example.com"', { cwd: repoDir, stdio: "ignore" });
      execGit('git config --local user.name "Bosun Bot"', { cwd: repoDir, stdio: "ignore" });
      writeFileSync(join(repoDir, "README.md"), "base\n", "utf8");
      execGit("git add README.md", { cwd: repoDir, stdio: "ignore" });
      execGit('git commit -m "base"', { cwd: repoDir, stdio: "ignore" });
      execGit("git checkout -b feature/candidate-test", { cwd: repoDir, stdio: "ignore" });

      let runCount = 0;
      const launchEphemeralThread = vi.fn().mockImplementation(async (_prompt, runCwd) => {
        runCount += 1;
        writeFileSync(join(runCwd, `candidate-${runCount}.txt`), `candidate-${runCount}\n`, "utf8");
        execGit("git add .", { cwd: runCwd, stdio: "ignore" });
        execGit(`git commit -m "candidate-${runCount}"`, { cwd: runCwd, stdio: "ignore" });
        return {
          success: true,
          output:
            runCount === 1
              ? "candidate one output"
              : "candidate two output with additional verification context",
          sdk: "codex",
          items: [],
          threadId: `thread-${runCount}`,
        };
      });
      const mockEngine = {
        services: {
          agentPool: {
            launchEphemeralThread,
          },
        },
      };

      const ctx = new WorkflowContext({
        worktreePath: repoDir,
        taskId: "task-candidate-mode",
      });
      const node = {
        id: "agent-candidates",
        type: "action.run_agent",
        config: {
          prompt: "Fix task",
          cwd: repoDir,
          autoRecover: false,
          candidateCount: 2,
          candidateSelector: "last_success",
        },
      };
      const result = await handler.execute(node, ctx, mockEngine);

      expect(launchEphemeralThread).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
      expect(result.threadId).toBe("thread-2");
      expect(result.candidateSelection).toMatchObject({
        candidateCount: 2,
        selector: "last_success",
        selectedIndex: 2,
      });
      expect(Array.isArray(result.candidates)).toBe(true);
      expect(result.candidates.length).toBe(2);

      const currentBranch = execGit("git rev-parse --abbrev-ref HEAD", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();
      const latestCommitMessage = execGit("git log -1 --pretty=%s", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();
      expect(currentBranch).toBe("feature/candidate-test");
      expect(latestCommitMessage).toBe("candidate-2");
    } finally {
      try {
        rmSync(repoDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }, 60000);

  it("delegates using full trigger.task_assigned semantics", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({
      taskId: "TASK-DELEGATE-1",
      taskTitle: "Add API endpoint",
      agentType: "backend",
      task: {
        id: "TASK-DELEGATE-1",
        title: "Add API endpoint",
        tags: ["backend", "api"],
        branchName: "feat/api-endpoint",
      },
    });

    const execute = vi.fn().mockResolvedValue({ errors: [] });
    const launchEphemeralThread = vi.fn();
    const mockEngine = {
      list: vi.fn().mockReturnValue([
        {
          id: "wf-frontend",
          name: "Frontend Agent",
          enabled: true,
          metadata: { replaces: { module: "primary-agent.mjs" } },
          nodes: [
            {
              id: "trigger",
              type: "trigger.task_assigned",
              config: { agentType: "frontend", taskPattern: "ui|css" },
            },
          ],
        },
        {
          id: "wf-backend",
          name: "Backend Agent",
          enabled: true,
          metadata: { replaces: { module: "primary-agent.mjs" } },
          nodes: [
            {
              id: "trigger",
              type: "trigger.task_assigned",
              config: {
                agentType: "backend",
                taskPattern: "api",
                filter: "task.tags?.includes('backend')",
              },
            },
          ],
        },
      ]),
      execute,
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const node = {
      id: "delegated-agent",
      type: "action.run_agent",
      config: { prompt: "Handle task" },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result).toMatchObject({
      success: true,
      delegated: true,
      subWorkflowId: "wf-backend",
      subWorkflowName: "Backend Agent",
      subStatus: "completed",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      "wf-backend",
      expect.objectContaining({
        _agentWorkflowActive: true,
        eventType: "task.assigned",
        taskId: "TASK-DELEGATE-1",
        taskTitle: "Add API endpoint",
      }),
      expect.objectContaining({
        _parentRunId: ctx.id,
        _rootRunId: ctx.id,
      }),
    );
    expect(launchEphemeralThread).not.toHaveBeenCalled();
  }, SLOW_WORKFLOW_ENGINE_SESSION_CHAINING_TEST_TIMEOUT_MS);

  it("runs task-backed agents locally when delegateTaskWorkflow=false", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({
      taskId: "TASK-LOCAL-1",
      taskTitle: "Run lifecycle phase locally",
      worktreePath: "/tmp/task-local",
      task: {
        id: "TASK-LOCAL-1",
        title: "Run lifecycle phase locally",
        tags: ["backend"],
      },
    });

    const execute = vi.fn().mockResolvedValue({ errors: [] });
    const execWithRetry = vi.fn().mockResolvedValue({
      success: true,
      output: "local execution",
      threadId: "thread-local-1",
      sdk: "openai-native",
      items: [],
    });
    const launchEphemeralThread = vi.fn();
    const mockEngine = {
      list: vi.fn().mockReturnValue([
        {
          id: "wf-backend",
          name: "Backend Agent",
          enabled: true,
          metadata: { replaces: { module: "primary-agent.mjs" } },
          nodes: [
            {
              id: "trigger",
              type: "trigger.task_assigned",
              config: {
                taskPattern: "lifecycle",
                filter: "task.tags?.includes('backend')",
              },
            },
          ],
        },
      ]),
      execute,
      services: {
        agentPool: {
          launchEphemeralThread,
          execWithRetry,
        },
      },
    };

    const node = {
      id: "run-agent-tests",
      type: "action.run_agent",
      config: { prompt: "Run tests", delegateTaskWorkflow: false, autoRecover: true },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(true);
    expect(result.output).toBe("local execution");
    expect(execute).not.toHaveBeenCalled();
    expect(execWithRetry).toHaveBeenCalledTimes(1);
    expect(launchEphemeralThread).not.toHaveBeenCalled();
  });

  it("runs task-backed agents locally when delegateTaskWorkflow is the string false", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({
      taskId: "TASK-LOCAL-STRING-FALSE-1",
      taskTitle: "Run lifecycle phase locally",
      worktreePath: "/tmp/task-local-string-false",
      task: {
        id: "TASK-LOCAL-STRING-FALSE-1",
        title: "Run lifecycle phase locally",
        tags: ["backend"],
      },
    });

    const execute = vi.fn().mockResolvedValue({ errors: [] });
    const execWithRetry = vi.fn().mockResolvedValue({
      success: true,
      output: "local execution",
      threadId: "thread-local-string-false-1",
      sdk: "openai-native",
      items: [],
    });
    const launchEphemeralThread = vi.fn();
    const mockEngine = {
      list: vi.fn().mockReturnValue([
        {
          id: "wf-backend-string-false",
          name: "Backend Agent",
          enabled: true,
          metadata: { replaces: { module: "primary-agent.mjs" } },
          nodes: [
            {
              id: "trigger",
              type: "trigger.task_assigned",
              config: {
                taskPattern: "lifecycle",
                filter: "task.tags?.includes('backend')",
              },
            },
          ],
        },
      ]),
      execute,
      services: {
        agentPool: {
          launchEphemeralThread,
          execWithRetry,
        },
      },
    };

    const node = {
      id: "auto-fix-validation",
      type: "action.run_agent",
      config: { prompt: "Fix validation", delegateTaskWorkflow: "false", autoRecover: true },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(true);
    expect(result.output).toBe("local execution");
    expect(execute).not.toHaveBeenCalled();
    expect(execWithRetry).toHaveBeenCalledTimes(1);
    expect(launchEphemeralThread).not.toHaveBeenCalled();
  });

  it("marks delegated task sessions as failed when the delegated workflow fails", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({
      taskId: "TASK-DELEGATE-FAIL",
      taskTitle: "Backend migration failed",
      workspaceId: "virtengine-gh",
      task: {
        id: "TASK-DELEGATE-FAIL",
        title: "Backend migration failed",
        tags: ["backend"],
        branchName: "feat/backend-failure",
      },
    });

    const mockEngine = {
      list: vi.fn().mockReturnValue([
        {
          id: "wf-backend-fail",
          name: "Backend Agent",
          enabled: true,
          metadata: { replaces: { module: "primary-agent.mjs" } },
          nodes: [
            {
              id: "trigger",
              type: "trigger.task_assigned",
              config: {
                taskPattern: "backend",
                filter: "task.tags?.includes('backend')",
              },
            },
          ],
        },
      ]),
      execute: vi.fn().mockResolvedValue({
        errors: [new Error("delegated workflow crashed")],
        status: "failed",
        message: "delegated workflow crashed",
      }),
      services: {
        agentPool: {
          launchEphemeralThread: vi.fn(),
        },
      },
    };

    const node = {
      id: "delegated-session-fail-node",
      type: "action.run_agent",
      config: { prompt: "Handle task via delegated workflow", failOnError: false },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(false);
    expect(result.delegated).toBe(true);

    const tracker = getSessionTracker();
    const session = tracker.getSessionById("TASK-DELEGATE-FAIL");
    expect(session).toBeTruthy();
    expect(session.type).toBe("task");
    expect(session.status).toBe("failed");
    expect(session.metadata.branch).toBe("feat/backend-failure");

    const messages = Array.isArray(session.messages) ? session.messages : [];
    expect(messages.some((msg) => String(msg?.content || "").includes("Delegating to agent workflow"))).toBe(true);
    expect(messages.some((msg) => String(msg?.content || "").toLowerCase().includes("failed"))).toBe(true);
  });

  it("persists ordered delegation audit trail in run detail and history", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const workflowDir = mkdtempSync(join(tmpdir(), "wf-delegation-audit-defs-"));
    const runsDir = mkdtempSync(join(tmpdir(), "wf-delegation-audit-runs-"));
    const auditEngine = new WorkflowEngine({ workflowDir, runsDir, detectInterruptedRuns: false });

    try {
      const delegatedWorkflow = {
        id: "wf-audit-child",
        name: "Audit Child",
        enabled: true,
        metadata: { replaces: { module: "primary-agent.mjs" } },
        nodes: [
          { id: "trigger", type: "trigger.task_assigned", config: { taskPattern: "audit" } },
          { id: "end", type: "flow.end", config: { status: "completed", message: "done" } },
        ],
        edges: [],
      };
      auditEngine.save(delegatedWorkflow);

      const ctx = new WorkflowContext({
        taskId: "TASK-DELEGATE-AUDIT",
        taskTitle: "Audit delegation history",
        task: { id: "TASK-DELEGATE-AUDIT", title: "Audit delegation history" },
        _workflowId: "wf-parent-audit",
        _workflowName: "Parent Audit Workflow",
      });

      const node = {
        id: "delegated-agent-audit",
        type: "action.run_agent",
        config: { prompt: "Delegate for audit" },
      };

      const result = await handler.execute(node, ctx, auditEngine);
      expect(result).toMatchObject({
        success: true,
        delegated: true,
        subWorkflowId: "wf-audit-child",
      });

      auditEngine._persistRun(ctx.id, "wf-parent-audit", ctx);
      const detail = auditEngine.getRunDetail(ctx.id);
      expect(Array.isArray(detail?.delegationTrail)).toBe(true);

      const eventTypes = detail.delegationTrail.map((entry) => entry?.eventType);
      expect(eventTypes).toEqual(["assign", "handoff-complete"]);
      expect(detail.delegationTrail[0]).toEqual(expect.objectContaining({
        taskId: "TASK-DELEGATE-AUDIT",
        workflowNodeId: "delegated-agent-audit",
        delegatedWorkflowId: "wf-audit-child",
      }));

      const historyEntry = auditEngine.getRunHistory("wf-parent-audit", 1)[0];
      expect(Array.isArray(historyEntry?.delegationTrail)).toBe(true);
      expect(historyEntry.delegationTrail.map((entry) => entry?.eventType)).toEqual(["assign", "handoff-complete"]);
    } finally {
      try { rmSync(workflowDir, { recursive: true, force: true }); } catch {}
      try { rmSync(runsDir, { recursive: true, force: true }); } catch {}
    }
  });


  it("exposes delegation audit trail in run history and run detail", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "workflow-delegation-history-"));
    const engine = new WorkflowEngine({
      workflowsDir: join(tmpRoot, "workflows"),
      runsDir: join(tmpRoot, "runs"),
    });

    const workflow = {
      id: "wf-delegation-history",
      name: "Delegation History Workflow",
      trigger: "manual",
      nodes: [
        { id: "start", type: "trigger.manual", config: {} },
      ],
      edges: [],
    };

    engine.save(workflow);
    const ctx = new WorkflowContext({
      _workflowId: workflow.id,
      _workflowName: workflow.name,
    });
    ctx.recordDelegationEvent({
      type: "assign",
      nodeId: "delegated-agent",
      taskId: "TASK-HISTORY-1",
      workflowId: workflow.id,
      workflowName: workflow.name,
      idempotencyKey: "assign:TASK-HISTORY-1",
    });
    ctx.recordDelegationEvent({
      type: "handoff-complete",
      nodeId: "delegated-agent",
      taskId: "TASK-HISTORY-1",
      workflowId: workflow.id,
      workflowName: workflow.name,
      idempotencyKey: "handoff:TASK-HISTORY-1",
    });

    engine._persistRun(ctx.id, workflow.id, ctx);
    const historyEntry = engine.getRunHistory(workflow.id, 10)[0];
    const detail = engine.getRunDetail(ctx.id);

    expect(historyEntry.delegationAuditTrail.map((entry) => entry.type)).toEqual(["assign", "handoff-complete"]);
    expect(detail.delegationAuditTrail.map((entry) => entry.type)).toEqual(["assign", "handoff-complete"]);
    expect(detail.detail.delegationAuditTrail.map((entry) => entry.type)).toEqual(["assign", "handoff-complete"]);
  });

  it("records assign and handoff delegation events for delegated agent runs", async () => {
    const handler = getNodeType("action.run_agent");
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      threadId: "thread-delegation-1",
      output: "ok",
    });
    const ctx = new WorkflowContext({
      taskId: "TASK-DELEGATION-AUDIT",
      taskTitle: "Delegation audit",
      task: { id: "TASK-DELEGATION-AUDIT", title: "Delegation audit" },
    });
    const engine = {
      services: { agentPool: { launchEphemeralThread } },
      workflows: new Map(),
    };
    const node = {
      id: "delegate-agent",
      type: "action.run_agent",
      config: { prompt: "do the thing", sdk: "codex", model: "gpt-5" },
    };

    const result = await handler.execute(node, ctx, engine);
    const trail = ctx.getDelegationAuditTrail();

    expect(result.success).toBe(true);
    expect(launchEphemeralThread).toHaveBeenCalledTimes(1);
    expect(trail.map((entry) => entry.type)).toEqual(expect.arrayContaining(["assign", "handoff-complete"]));
    expect(trail.find((entry) => entry.type === "handoff-complete")).toEqual(expect.objectContaining({
      taskId: "TASK-DELEGATION-AUDIT",
      threadId: "thread-delegation-1",
    }));
  });
  it("records delegated runs in session tracker for task visibility", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({
      taskId: "TASK-DELEGATE-SESSION",
      taskTitle: "Backend migration",
      workspaceId: "virtengine-gh",
      task: {
        id: "TASK-DELEGATE-SESSION",
        title: "Backend migration",
        tags: ["backend"],
        branchName: "feat/backend-migration",
      },
    });

    const mockEngine = {
      list: vi.fn().mockReturnValue([
        {
          id: "wf-backend",
          name: "Backend Agent",
          enabled: true,
          metadata: { replaces: { module: "primary-agent.mjs" } },
          nodes: [
            {
              id: "trigger",
              type: "trigger.task_assigned",
              config: {
                taskPattern: "backend",
                filter: "task.tags?.includes('backend')",
              },
            },
          ],
        },
      ]),
      execute: vi.fn().mockResolvedValue({ errors: [] }),
      services: {
        agentPool: {
          launchEphemeralThread: vi.fn(),
        },
      },
    };

    const node = {
      id: "delegated-session-node",
      type: "action.run_agent",
      config: { prompt: "Handle task via delegated workflow", failOnError: true },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(true);
    expect(result.delegated).toBe(true);
    expect(result.childSessionId).toContain("TASK-DELEGATE-SESSION:delegate:");

    const tracker = getSessionTracker();
    const taskSession = tracker.getSessionById("TASK-DELEGATE-SESSION");
    const childSession = tracker.getSessionById(result.childSessionId);
    expect(taskSession).toBeTruthy();
    expect(taskSession.type).toBe("task");
    expect(taskSession.status).toBe("completed");
    expect(taskSession.metadata.branch).toBe("feat/backend-migration");
    expect(childSession).toBeTruthy();
    expect(childSession.type).toBe("delegate");
    expect(childSession.taskId).toBe("TASK-DELEGATE-SESSION");
    expect(childSession.status).toBe("completed");
    expect(childSession.metadata).toEqual(expect.objectContaining({
      workflowId: "wf-backend",
      rootTaskId: "TASK-DELEGATE-SESSION",
      parentTaskId: "TASK-DELEGATE-SESSION",
      rootSessionId: "TASK-DELEGATE-SESSION",
      parentSessionId: "TASK-DELEGATE-SESSION",
      rootRunId: ctx.id,
      parentRunId: ctx.id,
      delegationDepth: 1,
    }));

    const messages = Array.isArray(taskSession.messages) ? taskSession.messages : [];
    expect(messages.some((msg) => String(msg?.content || "").includes("Delegating to agent workflow"))).toBe(true);
  });

  it("marks stalled delegated workflows retryable and recovers only once", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({
      taskId: "TASK-WATCHDOG-1",
      taskTitle: "Backend watchdog test",
      workspaceId: "virtengine-gh",
      task: { id: "TASK-WATCHDOG-1", title: "Backend watchdog test", tags: ["backend"] },
      delegationWatchdogTimeoutMs: 25,
    });

    const stalledRun = {
      runId: "delegated-stalled-run",
      status: WorkflowStatus.RUNNING,
      isStuck: true,
      stuckMs: 50,
    };

    const mockEngine = {
      list: vi.fn().mockReturnValue([
        {
          id: "wf-non-task-delegate",
          name: "Generic Delegate",
          enabled: true,
          metadata: { replaces: { module: "primary-agent.mjs" } },
          nodes: [{ id: "trigger", type: "trigger.task_assigned", config: { taskPattern: "backend" } }],
        },
      ]),
      execute: vi.fn()
        .mockResolvedValueOnce({ runId: stalledRun.runId, status: WorkflowStatus.RUNNING, delegated: true })
        .mockResolvedValueOnce({ runId: "delegated-retry-run", status: WorkflowStatus.COMPLETED, delegated: true, outputs: { ok: true } }),
      getRunHistory: vi.fn().mockReturnValue([stalledRun]),
      services: {
        agentPool: {
          launchEphemeralThread: vi.fn(),
        },
      },
    };

    const node = {
      id: "delegated-watchdog-node",
      type: "action.run_agent",
      config: {
        prompt: "Handle generic delegated workflow",
        failOnError: false,
        delegationWatchdogTimeoutMs: 25,
      },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(true);
    expect(result.delegated).toBe(true);
    expect(result.recoveredFromStall).toBe(true);
    expect(result.watchdogRecovered).toBe(true);
    expect(result.watchdogRetryCount).toBe(1);
    expect(mockEngine.execute).toHaveBeenCalledTimes(2);
  });

  it("does not retry delegated workflows more than once after watchdog recovery", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({
      taskId: "TASK-WATCHDOG-2",
      taskTitle: "Backend watchdog loop test",
      task: { id: "TASK-WATCHDOG-2", title: "Backend watchdog loop test", tags: ["backend"] },
      workspaceId: "virtengine-gh",
    });

    const mockEngine = {
      list: vi.fn().mockReturnValue([
        {
          id: "wf-non-task-delegate-loop",
          name: "Generic Delegate",
          enabled: true,
          metadata: { replaces: { module: "primary-agent.mjs" } },
          nodes: [{ id: "trigger", type: "trigger.task_assigned", config: { taskPattern: "backend" } }],
        },
      ]),
      execute: vi.fn()
        .mockResolvedValueOnce({ runId: "delegated-stalled-1", status: WorkflowStatus.RUNNING, delegated: true })
        .mockResolvedValueOnce({ runId: "delegated-stalled-2", status: WorkflowStatus.RUNNING, delegated: true }),
      getRunHistory: vi.fn()
        .mockReturnValueOnce([{ runId: "delegated-stalled-1", status: WorkflowStatus.RUNNING, isStuck: true, stuckMs: 75 }])
        .mockReturnValueOnce([{ runId: "delegated-stalled-2", status: WorkflowStatus.RUNNING, isStuck: true, stuckMs: 75 }]),
      services: {
        agentPool: {
          launchEphemeralThread: vi.fn(),
        },
      },
    };

    const node = {
      id: "delegated-watchdog-node-once",
      type: "action.run_agent",
      config: {
        prompt: "Handle generic delegated workflow",
        failOnError: false,
        delegationWatchdogTimeoutMs: 25,
      },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.failureKind).toBe("stalled_delegation");
    expect(result.watchdogRetryCount).toBe(1);
    expect(mockEngine.execute).toHaveBeenCalledTimes(2);
  });

  it("records delegated session as completed when child workflow succeeds", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({
      taskId: "TASK-DELEGATE-COMPLETED",
      taskTitle: "Backend migration completed",
      workspaceId: "virtengine-gh",
      task: {
        id: "TASK-DELEGATE-COMPLETED",
        title: "Backend migration completed",
        tags: ["backend"],
        branchName: "feat/backend-migration",
      },
    });

    const mockEngine = {
      list: vi.fn().mockReturnValue([
        {
          id: "wf-backend-completed",
          name: "Backend Agent",
          enabled: true,
          metadata: { replaces: { module: "primary-agent.mjs" } },
          nodes: [
            {
              id: "trigger",
              type: "trigger.task_assigned",
              config: {
                taskPattern: "backend",
                filter: "task.tags?.includes('backend')",
              },
            },
          ],
        },
      ]),
      execute: vi.fn().mockResolvedValue({ errors: [] }),
      services: {
        agentPool: {
          launchEphemeralThread: vi.fn(),
        },
      },
    };

    const node = {
      id: "delegated-session-node-completed",
      type: "action.run_agent",
      config: { prompt: "Handle task via delegated workflow" },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(true);
    expect(result.delegated).toBe(true);

    const tracker = getSessionTracker();
    const session = tracker.getSessionById("TASK-DELEGATE-COMPLETED");
    expect(session).toBeTruthy();
    expect(session.type).toBe("task");
    expect(session.status).toBe("completed");
    expect(session.metadata.workspaceId).toBe("virtengine-gh");
    expect(session.metadata.branch).toBe("feat/backend-migration");

    const messages = Array.isArray(session.messages) ? session.messages : [];
    expect(messages.some((msg) => String(msg?.content || "").includes("Delegating to agent workflow"))).toBe(true);
    expect(messages.some((msg) => String(msg?.content || "").includes("Backend Agent\" completed"))).toBe(true);
  });
  it("keeps delegated completion visible even when the child workflow ends without explicit output", async () => {
    const childWorkflow = {
      id: "child-visible-without-output",
      name: "Child Visible Without Output",
      enabled: true,
      nodes: [
        { id: "start", type: "trigger.manual", config: {} },
        { id: "finish", type: "flow.end", config: { status: "completed", message: "child done" } },
      ],
      edges: [{ id: "e1", source: "start", target: "finish" }],
    };

    const parentWorkflow = {
      id: "parent-visible-without-output",
      name: "Parent Visible Without Output",
      enabled: true,
      nodes: [
        { id: "trigger", type: "trigger.manual", config: {} },
        {
          id: "delegate",
          type: "flow.universal",
          config: {
            workflowId: childWorkflow.id,
            mode: "sync",
            inheritContext: true,
          },
        },
        {
          id: "finish",
          type: "flow.end",
          config: {
            status: "{{delegate.status || 'completed'}}",
            message: "{{delegate.message || 'delegated workflow completed'}}",
          },
        },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "delegate" },
        { id: "e2", source: "delegate", target: "finish" },
      ],
    };

    engine.save(childWorkflow);
    engine.save(parentWorkflow);

    await engine.execute(parentWorkflow.id, {
      taskId: "task-visible-no-output",
      taskTitle: "Visible without output",
      workspaceId: "virtengine-gh",
      task: {
        id: "task-visible-no-output",
        title: "Visible without output",
        branchName: "feat/visible-no-output",
      },
    });

    const tracker = getSessionTracker();
    const session = tracker.getSessionById("task-visible-no-output");
    expect(session).toBeTruthy();
    expect(session.status).toBe("completed");
    expect(session.metadata.branch).toBe("feat/visible-no-output");
    expect(Array.isArray(session.messages)).toBe(true);
    expect(session.messages.some((msg) => String(msg?.content || "").includes("completed"))).toBe(true);
  }, SLOW_WORKFLOW_ENGINE_SESSION_CHAINING_TEST_TIMEOUT_MS);

  it("marks delegated task session failed when delegated workflow returns errors", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({
      taskId: "TASK-DELEGATE-FAIL",
      taskTitle: "Backend migration failed",
      workspaceId: "virtengine-gh",
      task: {
        id: "TASK-DELEGATE-FAIL",
        title: "Backend migration failed",
        tags: ["backend"],
        branchName: "feat/backend-fail",
      },
    });

    const mockEngine = {
      list: vi.fn().mockReturnValue([
        {
          id: "wf-backend",
          name: "Backend Agent",
          enabled: true,
          metadata: { replaces: { module: "primary-agent.mjs" } },
          nodes: [
            {
              id: "trigger",
              type: "trigger.task_assigned",
              config: {
                taskPattern: "backend",
                filter: "task.tags?.includes('backend')",
              },
            },
          ],
        },
      ]),
      execute: vi.fn().mockResolvedValue({
        errors: [new Error("delegated workflow failed")],
      }),
      services: {
        agentPool: {
          launchEphemeralThread: vi.fn(),
        },
      },
    };

    const node = {
      id: "delegated-session-failed-node",
      type: "action.run_agent",
      config: { prompt: "Handle task via delegated workflow" },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(false);
    expect(result.delegated).toBe(true);
    expect(result.subStatus).toBe("failed");

    const tracker = getSessionTracker();
    const session = tracker.getSessionById("TASK-DELEGATE-FAIL");
    expect(session).toBeTruthy();
    expect(session.status).toBe("failed");

    const messages = Array.isArray(session.messages) ? session.messages : [];
    expect(messages.some((msg) => String(msg?.content || "").includes("Delegating to agent workflow"))).toBe(true);
    expect(messages.some((msg) => String(msg?.content || "").includes("failed"))).toBe(true);
  });

  it("preserves existing task session visibility when delegated workflow reuses current session id", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({
      taskId: "TASK-DELEGATE-REUSE",
      taskTitle: "Reuse visible session",
      sessionId: "TASK-DELEGATE-REUSE",
      workspaceId: "virtengine-gh",
      worktreePath: "/tmp/test",
      task: {
        id: "TASK-DELEGATE-REUSE",
        title: "Reuse visible session",
        tags: ["backend"],
        branchName: "feat/reuse-session",
      },
    });

    const mockEngine = {
      list: vi.fn().mockReturnValue([
        {
          id: "wf-backend",
          name: "Backend Agent",
          enabled: true,
          metadata: { replaces: { module: "primary-agent.mjs" } },
          nodes: [
            {
              id: "trigger",
              type: "trigger.task_assigned",
              config: {
                taskPattern: "backend",
                filter: "task.tags?.includes('backend')",
              },
            },
          ],
        },
      ]),
      execute: vi.fn().mockResolvedValue({ errors: [] }),
      services: {
        agentPool: {
          launchEphemeralThread: vi.fn(),
        },
      },
    };

    const node = {
      id: "delegated-session-visible-node",
      type: "action.run_agent",
      config: { prompt: "Handle task via delegated workflow" },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(true);
    expect(result.delegated).toBe(true);

    const tracker = getSessionTracker();
    const session = tracker.getSessionById("TASK-DELEGATE-REUSE");
    expect(session).toBeTruthy();
    expect(session.id).toBe("TASK-DELEGATE-REUSE");
    expect(session.status).toBe("completed");
    expect(session.metadata.workspaceDir).toBe("/tmp/test");
  });

  it("records delegation audit trail in run detail and history summaries", async () => {
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "delegate", type: "action.run_agent", label: "Delegate", config: { prompt: "Handle task" } },
      ],
      [{ id: "e1", source: "trigger", target: "delegate" }],
      { id: "delegation-audit-workflow", name: "Delegation Audit Workflow" },
    );

    const delegated = makeSimpleWorkflow(
      [
        {
          id: "task-trigger",
          type: "trigger.task_assigned",
          label: "Task Assigned",
          config: { taskPattern: "api", filter: "task.tags?.includes('backend')" },
        },
        { id: "done", type: "notify.log", label: "Done", config: { message: "delegated workflow done" } },
      ],
      [{ id: "e1", source: "task-trigger", target: "done" }],
      {
        id: "delegated-audit-child",
        name: "Delegated Audit Child",
        metadata: { replaces: { module: "primary-agent.mjs" } },
      },
    );

    engine.save(wf);
    engine.save(delegated);

    const ctx = await engine.execute(wf.id, {
      taskId: "TASK-AUDIT-1",
      taskTitle: "API delegation audit",
      agentType: "backend",
      task: { id: "TASK-AUDIT-1", title: "API delegation audit", tags: ["backend", "api"] },
    });

    expect(ctx.errors).toEqual([]);
    const detail = engine.getRunDetail(ctx.id);
    const persistedTrail =
      detail?.detail?.data?._delegationAuditTrail ??
      detail?.detail?.delegationAuditTrail ??
      detail?.delegationAuditTrail;
    expect(Array.isArray(persistedTrail)).toBe(true);
    expect(persistedTrail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "assign" }),
        expect.objectContaining({ type: "handoff-complete", status: "completed" }),
      ]),
    );

    const summary = engine.getRunHistory(wf.id, 1)[0];
    expect(Array.isArray(summary?.delegationAuditTrail)).toBe(true);
    expect(summary?.latestDelegationEvent).toEqual(
      expect.objectContaining({ type: "handoff-complete", status: "completed" }),
    );
  }, SLOW_WORKFLOW_ENGINE_SESSION_CHAINING_TEST_TIMEOUT_MS);

  it("keeps delegation transition side effects idempotent across duplicate transition keys", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const execute = vi.fn().mockResolvedValue({ id: "child-run-1", errors: [] });
    const mockEngine = {
      list: vi.fn().mockReturnValue([
        {
          id: "wf-backend-idempotent",
          name: "Backend Agent",
          enabled: true,
          metadata: { replaces: { module: "primary-agent.mjs" } },
          nodes: [
            {
              id: "trigger",
              type: "trigger.task_assigned",
              config: { taskPattern: "api", filter: "task.tags?.includes('backend')" },
            },
          ],
        },
      ]),
      execute,
      services: {
        agentPool: {
          launchEphemeralThread: vi.fn(),
        },
      },
    };

    const node = {
      id: "delegated-idempotent-node",
      type: "action.run_agent",
      config: { prompt: "Handle task" },
    };

    const data = {
      taskId: "TASK-IDEMPOTENT-1",
      taskTitle: "API idempotency",
      agentType: "backend",
      task: { id: "TASK-IDEMPOTENT-1", title: "API idempotency", tags: ["backend", "api"] },
      _delegationTransitionKey: "transition-key-1",
    };

    const first = await handler.execute(node, new WorkflowContext(data), mockEngine);
    const second = await handler.execute(node, new WorkflowContext(data), mockEngine);

    expect(first.delegated).toBe(true);
    expect(second.delegated).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(second.runId).toBe(first.runId);
  });

  it("records autonomous agent recovery attempts in the execution ledger", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({
      _workflowId: "workflow-ledger-parent",
      _workflowName: "Workflow Ledger Parent",
      taskId: "TASK-LEDGER-AGENT",
      taskTitle: "Ledger agent task",
      sessionId: "session-ledger-1",
      worktreePath: "/tmp/ledger-agent",
    });

    const recordLedgerEvent = vi.fn();
    const continueSession = vi.fn().mockResolvedValue({ success: false, error: "session expired" });
    const execWithRetry = vi.fn().mockResolvedValue({
      success: true,
      output: "done",
      sdk: "codex",
      items: [],
      threadId: "thread-ledger-1",
      attempts: 2,
      continues: 1,
      resumed: true,
    });
    const mockEngine = {
      list: vi.fn().mockReturnValue([]),
      _recordLedgerEvent: recordLedgerEvent,
      services: {
        agentPool: {
          continueSession,
          execWithRetry,
          launchEphemeralThread: vi.fn(),
        },
      },
    };

    const node = {
      id: "agent-ledger-node",
      type: "action.run_agent",
      config: { prompt: "Do task work", autoRecover: true, continueOnSession: true },
    };

    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.success).toBe(true);
    expect(continueSession).toHaveBeenCalledTimes(1);
    expect(execWithRetry).toHaveBeenCalledTimes(1);
    expect(recordLedgerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "agent.started",
        executionKind: "agent",
        executionKey: "agent:agent-ledger-node:auto",
      }),
    );
    expect(recordLedgerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "recovery.attempted",
        executionKind: "recovery",
        meta: expect.objectContaining({ strategy: "continue_session" }),
      }),
    );
    expect(recordLedgerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "recovery.failed",
        executionKind: "recovery",
        meta: expect.objectContaining({ strategy: "continue_session" }),
      }),
    );
    expect(recordLedgerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "agent.completed",
        executionKind: "agent",
        meta: expect.objectContaining({
          threadId: "thread-ledger-1",
          resumed: true,
        }),
      }),
    );
  });

  it("does not delegate agent workflows when task context is missing", async () => {
    const handler = getNodeType("action.run_agent");
    expect(handler).toBeDefined();

    const ctx = new WorkflowContext({
      eventType: "schedule-poll",
      taskId: "",
      taskTitle: "",
    });

    const execute = vi.fn().mockResolvedValue({ errors: [] });
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: "done",
      sdk: "codex",
      items: [],
      threadId: "thread-no-delegation",
    });
    const mockEngine = {
      list: vi.fn().mockReturnValue([
        {
          id: "wf-backend",
          name: "Backend Agent",
          enabled: true,
          metadata: { replaces: { module: "primary-agent.mjs" } },
          nodes: [
            {
              id: "trigger",
              type: "trigger.task_assigned",
              config: {},
            },
          ],
        },
      ]),
      execute,
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const node = {
      id: "generic-agent",
      type: "action.run_agent",
      config: { prompt: "Generic non-task run", autoRecover: false },
    };

    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.success).toBe(true);
    expect(result.delegated).not.toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(launchEphemeralThread).toHaveBeenCalledTimes(1);
  });
  it("trigger.task_assigned applies agentType, taskPattern, and filter together", async () => {
    const trigger = getNodeType("trigger.task_assigned");
    expect(trigger).toBeDefined();

    const node = {
      id: "trigger-assigned",
      type: "trigger.task_assigned",
      config: {
        agentType: "backend",
        taskPattern: "api",
        filter: "task.tags?.includes('backend')",
      },
    };

    const matchingCtx = new WorkflowContext({
      eventType: "task.assigned",
      taskTitle: "Build API endpoint",
      agentType: "backend",
      task: { tags: ["backend", "api"] },
    });
    const matchingResult = await trigger.execute(node, matchingCtx);
    expect(matchingResult.triggered).toBe(true);

    const agentMismatchCtx = new WorkflowContext({
      eventType: "task.assigned",
      taskTitle: "Build API endpoint",
      agentType: "frontend",
      task: { tags: ["backend", "api"] },
    });
    const agentMismatchResult = await trigger.execute(node, agentMismatchCtx);
    expect(agentMismatchResult.triggered).toBe(false);
  });
});

describe("trigger.pr_event normalization", () => {
  it("treats ready_for_review and synchronize aliases as opened", async () => {
    const trigger = getNodeType("trigger.pr_event");
    expect(trigger).toBeDefined();

    const node = {
      id: "pr-trigger",
      type: "trigger.pr_event",
      config: { event: "opened" },
    };

    const readyCtx = new WorkflowContext({
      eventType: "pr.ready_for_review",
      prEvent: "ready_for_review",
      branch: "feature/one",
    });
    const readyResult = await trigger.execute(node, readyCtx);
    expect(readyResult.triggered).toBe(true);
    expect(readyResult.prEvent).toBe("opened");

    const syncCtx = new WorkflowContext({
      eventType: "pr.synchronize",
      prEvent: "synchronize",
      branch: "feature/two",
    });
    const syncResult = await trigger.execute(node, syncCtx);
    expect(syncResult.triggered).toBe(true);
    expect(syncResult.prEvent).toBe("opened");
  });

  it("supports config.events list for merge strategy triggers", async () => {
    const trigger = getNodeType("trigger.pr_event");
    expect(trigger).toBeDefined();

    const node = {
      id: "pr-trigger-events",
      type: "trigger.pr_event",
      config: { events: ["review_requested", "approved", "opened"] },
    };

    const approvedCtx = new WorkflowContext({
      eventType: "pr.approved",
      prEvent: "approved",
      branch: "feature/approved",
    });
    const approvedResult = await trigger.execute(node, approvedCtx);
    expect(approvedResult.triggered).toBe(true);

    const mergedCtx = new WorkflowContext({
      eventType: "pr.merged",
      prEvent: "merged",
      branch: "feature/merged",
    });
    const mergedResult = await trigger.execute(node, mergedCtx);
    expect(mergedResult.triggered).toBe(false);
  });
});

it("agent.run_planner streams planner events and propagates threadId", async () => {
  const handler = getNodeType("agent.run_planner");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({});
  const launchEphemeralThread = vi.fn().mockImplementation(
    async (_prompt, _cwd, _timeoutMs, extra) => {
      extra?.onEvent?.({
        type: "item.completed",
        item: { type: "reasoning", summary: "Reviewing backlog gaps." },
      });
      extra?.onEvent?.({
        type: "tool_call",
        tool_name: "create_task",
      });
      extra?.onEvent?.({
        type: "item.completed",
        item: { type: "agent_message", text: "Generated 3 tasks." },
      });
      return {
        success: true,
        output: "planned output",
        sdk: "codex",
        items: [],
        threadId: "planner-thread-123",
      };
    },
  );
  const mockEngine = {
    services: {
      agentPool: {
        launchEphemeralThread,
      },
      prompts: {
        planner: "Planner prompt",
      },
    },
  };

  const node = {
    id: "planner-1",
    type: "agent.run_planner",
    config: {
      taskCount: 3,
      context: "Focus on reliability",
      outputVariable: "plannerOutput",
    },
  };
  const result = await handler.execute(node, ctx, mockEngine);

  expect(result.success).toBe(true);
  expect(result.taskCount).toBe(3);
  expect(result.threadId).toBe("planner-thread-123");
  expect(result.sessionId).toBe("planner-thread-123");
  expect(ctx.data.threadId).toBe("planner-thread-123");
  expect(ctx.data.sessionId).toBe("planner-thread-123");
  expect(ctx.data.plannerOutput).toBe("planned output");
  expect(launchEphemeralThread).toHaveBeenCalledTimes(1);
  expect(launchEphemeralThread.mock.calls[0][3]).toEqual(
    expect.objectContaining({ onEvent: expect.any(Function) }),
  );
  const runLogText = ctx.logs.map((entry) => String(entry?.message || "")).join("\n");
  expect(runLogText).toMatch(/Thinking: Reviewing backlog gaps\./);
  expect(runLogText).toMatch(/Tool call: create_task/);
  expect(runLogText).toMatch(/Agent: Generated 3 tasks\./);
  expect(runLogText).toMatch(/Planner completed: success=true streamEvents=3/);
  });

it("agent.run_planner appends output requirements to explicit prompts and honors templated taskCount", async () => {
  const handler = getNodeType("agent.run_planner");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({
    taskCount: 10,
    prompt: "Analyze reliability gaps in the repo.",
  });
  const launchEphemeralThread = vi.fn().mockResolvedValue({
    success: true,
    output: '{"tasks":[]}',
    sdk: "codex",
    items: [],
    threadId: "planner-thread-explicit",
  });
  const mockEngine = {
    services: {
      agentPool: {
        launchEphemeralThread,
      },
      prompts: {
        planner: "unused fallback planner prompt",
      },
    },
  };

  const node = {
    id: "planner-explicit",
    type: "agent.run_planner",
    config: {
      taskCount: "{{taskCount}}",
      prompt: "{{prompt}}",
    },
  };
  const result = await handler.execute(node, ctx, mockEngine);

  expect(result.success).toBe(true);
  expect(result.taskCount).toBe(10);
  expect(launchEphemeralThread).toHaveBeenCalledTimes(1);

  const sentPrompt = String(launchEphemeralThread.mock.calls[0][0] || "");
  expect(sentPrompt).toContain("Analyze reliability gaps in the repo.");
  expect(sentPrompt).toContain("Generate exactly 10 new tasks.");
  expect(sentPrompt).toContain("single fenced JSON block");
});

it("agent.run_planner appends planner feedback context from workflow data", async () => {
  const handler = getNodeType("agent.run_planner");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({
    _plannerFeedback: "Previous run skipped high-risk tasks in workflow area.",
  });
  const launchEphemeralThread = vi.fn().mockResolvedValue({
    success: true,
    output: '{"tasks":[]}',
    sdk: "codex",
    items: [],
    threadId: "planner-thread-feedback",
  });
  const mockEngine = {
    services: {
      agentPool: {
        launchEphemeralThread,
      },
      prompts: {
        planner: "Planner prompt",
      },
    },
  };

  const node = {
    id: "planner-feedback",
    type: "agent.run_planner",
    config: {
      taskCount: 2,
    },
  };

  await handler.execute(node, ctx, mockEngine);
  const sentPrompt = String(launchEphemeralThread.mock.calls[0][0] || "");
  expect(sentPrompt).toContain("Planner feedback context:");
  expect(sentPrompt).toContain("Previous run skipped high-risk tasks in workflow area.");
});

it("agent.run_planner avoids duplicating planner feedback already present in the prompt context", async () => {
  const handler = getNodeType("agent.run_planner");
  expect(handler).toBeDefined();

  const feedback = "Previous run skipped high-risk tasks in workflow area.";
  const ctx = new WorkflowContext({
    _plannerFeedback: feedback,
  });
  const launchEphemeralThread = vi.fn().mockResolvedValue({
    success: true,
    output: '{"tasks":[]}',
    sdk: "codex",
    items: [],
    threadId: "planner-thread-feedback-dedupe",
  });
  const mockEngine = {
    services: {
      agentPool: {
        launchEphemeralThread,
      },
      prompts: {
        planner: `Planner prompt\n\nPlanner feedback context:\n${feedback}`,
      },
    },
  };

  const node = {
    id: "planner-feedback-dedupe",
    type: "agent.run_planner",
    config: {
      taskCount: 2,
    },
  };

  await handler.execute(node, ctx, mockEngine);
  const sentPrompt = String(launchEphemeralThread.mock.calls[0][0] || "");
  expect(sentPrompt.split("Planner feedback context:").length - 1).toBe(1);
  expect(sentPrompt.split(feedback).length - 1).toBe(1);
});
it("agent.run_planner injects compact repo topology when enabled", async () => {
  const handler = getNodeType("agent.run_planner");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({
    taskTitle: "Improve workflow planning",
    taskDescription: "Inject repo topology into planner prompts",
    repoMap: {
      root: "C:/repo",
      files: [
        { path: "workflow/workflow-engine.mjs", summary: "workflow runtime" },
        { path: "workflow/workflow-nodes.mjs", summary: "workflow nodes" },
        { path: "tests/workflow-engine.test.mjs", summary: "workflow runtime coverage" },
      ],
    },
  });
  const launchEphemeralThread = vi.fn().mockResolvedValue({
    success: true,
    output: '{"tasks":[]}',
    sdk: "codex",
    items: [],
    threadId: "planner-thread-topology",
  });
  const mockEngine = {
    services: {
      agentPool: {
        launchEphemeralThread,
      },
      prompts: {
        planner: "Planner prompt",
      },
    },
  };

  const node = {
    id: "planner-topology",
    type: "agent.run_planner",
    config: {
      taskCount: 2,
      repoMapQuery: "{{taskTitle}} {{taskDescription}}",
      repoMapFileLimit: 3,
    },
  };

  await handler.execute(node, ctx, mockEngine);
  const sentPrompt = String(launchEphemeralThread.mock.calls[0][0] || "");
  expect(sentPrompt).toContain("## Repo Topology");
  expect(sentPrompt).toContain("Areas: workflow (2), tests (1)");
  expect(sentPrompt).toContain("owner: workflow");
  expect(sentPrompt).toContain("adjacent: workflow/workflow-nodes.mjs, tests/workflow-engine.test.mjs");
}, 30000);

it("agent.run_planner avoids duplicating repo topology blocks", async () => {
  const handler = getNodeType("agent.run_planner");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({
    repoMap: {
      root: "C:/repo",
      files: [{ path: "workflow/workflow-engine.mjs", summary: "workflow runtime" }],
    },
  });
  const launchEphemeralThread = vi.fn().mockResolvedValue({
    success: true,
    output: '{"tasks":[]}',
    sdk: "codex",
    items: [],
    threadId: "planner-thread-no-dup",
  });

  await handler.execute({
    id: "planner-no-dup",
    type: "agent.run_planner",
    config: {
      taskCount: 1,
      prompt: "## Repo Topology\n- Root: C:/repo\n\nPlan carefully.",
      repoMapQuery: "workflow planning",
    },
  }, ctx, {
    services: {
      agentPool: { launchEphemeralThread },
      prompts: { planner: "Planner prompt" },
    },
  });

  const sentPrompt = String(launchEphemeralThread.mock.calls[0][0] || "");
  expect((sentPrompt.match(/## Repo Topology/g) || [])).toHaveLength(1);
});

it("action.run_agent avoids duplicating repo topology in architect/editor framing", async () => {
  const handler = getNodeType("action.run_agent");
  const ctx = new WorkflowContext({ worktreePath: "/tmp/test" });
  const launchEphemeralThread = vi.fn().mockResolvedValue({
    success: true,
    output: "done",
    sdk: "codex",
    items: [],
    threadId: "thread-repo-topology-dedupe",
  });

  await handler.execute({
    id: "run-agent-topology-dedupe",
    type: "action.run_agent",
    config: {
      prompt: "## Repo Topology\n- Root: C:/repo\n\nApply the approved plan",
      autoRecover: false,
      executionRole: "editor",
      architectPlan: "1. Update prompt framing\n2. Validate runtime tests",
      repoMap: {
        root: "C:/repo",
        files: [
          { path: "workflow/workflow-engine.mjs", summary: "workflow runtime" },
          { path: "workflow/workflow-nodes.mjs", summary: "workflow nodes" },
        ],
      },
    },
  }, ctx, {
    services: {
      agentPool: { launchEphemeralThread },
    },
  });

  const sentPrompt = String(launchEphemeralThread.mock.calls[0][0] || "");
  expect(sentPrompt).toContain("## Architect/Editor Execution");
  expect((sentPrompt.match(/## Repo Topology/g) || [])).toHaveLength(1);
});

it("agent.run_planner fails immediately when planner dependencies are unavailable", async () => {
  const handler = getNodeType("agent.run_planner");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({});
  const node = {
    id: "planner-missing-deps",
    type: "agent.run_planner",
    config: {
      taskCount: 3,
    },
  };

  await expect(handler.execute(node, ctx, { services: {} })).resolves.toMatchObject({
    success: false,
    error: expect.stringMatching(/Agent pool or planner prompt not available/i),
  });
});

it("action.materialize_planner_tasks parses fenced JSON and creates tasks", async () => {
  const handler = getNodeType("action.materialize_planner_tasks");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({});
  ctx.setNodeOutput("run-planner", {
    output: [
      "Planner analysis complete.",
      "```json",
      "{",
      '  "tasks": [',
      '    { "title": "[m] fix(workflow): create tasks", "description": "A", "acceptance_criteria": ["ac1"], "verification": ["v1"], "repo_areas": ["workflow"], "impact": 0.8, "confidence": 0.7, "risk": 0.2 },',
      '    { "title": "[m] fix(workflow): duplicate title", "description": "B" }',
      "  ]",
      "}",
      "```",
    ].join("\n"),
  });

  const createTask = vi
    .fn(async function createTaskAdapter(projectId, taskData) {
      if (projectId && taskData) {
        return { id: "task-1001" };
      }
      return { id: "task-1002" };
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
    },
  };
  const result = await handler.execute(node, ctx, mockEngine);

  expect(result.success).toBe(true);
  expect(result.parsedCount).toBe(2);
  expect(result.createdCount).toBe(1);
  expect(result.skippedCount).toBe(1);
  expect(result.created[0]).toEqual({
    id: "task-1001",
    title: "[m] fix(workflow): create tasks",
  });
  expect(listTasks).toHaveBeenCalledTimes(1);
  expect(createTask).toHaveBeenCalledTimes(1);
  expect(createTask).toHaveBeenCalledWith("proj-123", expect.objectContaining({
    title: "[m] fix(workflow): create tasks",
    description: "A\n\n## Acceptance Criteria\n- ac1\n\n## Verification\n- v1",
    status: "todo",
    repo_areas: ["workflow"],
    meta: expect.objectContaining({
      repo_areas: ["workflow"],
      planner: expect.objectContaining({
        impact: 8,
        confidence: 7,
        risk: "low",
        repo_areas: ["workflow"],
      }),
    }),
  }));
});

it("action.materialize_planner_tasks fails when all parsed tasks are skipped and minCreated is not met", async () => {
  const handler = getNodeType("action.materialize_planner_tasks");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({});
  ctx.setNodeOutput("run-planner", {
    output: [
      "```json",
      "{",
      '  "tasks": [',
      '    { "title": "[m] fix(workflow): duplicate only", "description": "A" }',
      "  ]",
      "}",
      "```",
    ].join("\n"),
  });

  const createTask = vi.fn();
  const listTasks = vi.fn().mockResolvedValue([
    { id: "existing-1", title: "[m] fix(workflow): duplicate only" },
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
      failOnZero: true,
      dedup: true,
      minCreated: 1,
    },
  };

  await expect(handler.execute(node, ctx, mockEngine)).rejects.toThrow(
    /created 0 tasks/i,
  );
  expect(listTasks).toHaveBeenCalledTimes(1);
  expect(createTask).not.toHaveBeenCalled();
});

it("action.materialize_planner_tasks passes two args to createTask even with default-param adapters", async () => {
  const handler = getNodeType("action.materialize_planner_tasks");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({});
  ctx.setNodeOutput("run-planner", {
    output: [
      "```json",
      "{",
      '  "tasks": [',
      '    { "title": "[m] fix(materialize): preserve payload", "description": "A", "acceptance_criteria": ["ac"], "verification": ["verify"], "repo_areas": ["workflow"], "workspace": "virtengine-gh", "repository": "virtengine/virtengine" }',
      "  ]",
      "}",
      "```",
    ].join("\n"),
  });

  const createTask = vi.fn(async function createTaskAdapter(projectId, taskData = {}) {
    if (typeof taskData?.title !== "string" || !taskData.title.trim()) {
      throw new Error("missing title payload");
    }
    return { id: "task-regression-1" };
  });
  const mockEngine = {
    services: {
      kanban: {
        createTask,
      },
    },
  };

  const node = {
    id: "materialize",
    type: "action.materialize_planner_tasks",
    config: {
      plannerNodeId: "run-planner",
      status: "draft",
      failOnZero: true,
      dedup: false,
      minCreated: 1,
    },
  };

  const result = await handler.execute(node, ctx, mockEngine);
  expect(result.success).toBe(true);
  expect(result.createdCount).toBe(1);
  expect(createTask).toHaveBeenCalledTimes(1);
  expect(createTask).toHaveBeenCalledWith("", expect.objectContaining({
    title: "[m] fix(materialize): preserve payload",
    workspace: "virtengine-gh",
    repository: "virtengine/virtengine",
    status: "draft",
    draft: true,
  }));
});

it("action.materialize_planner_tasks supports payload-only createTask adapters", async () => {
  const handler = getNodeType("action.materialize_planner_tasks");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({});
  ctx.setNodeOutput("run-planner", {
    output: [
      "```json",
      "{",
      '  "tasks": [',
      '    { "title": "[m] fix(materialize): payload-only adapter", "description": "A", "acceptance_criteria": ["ac"], "verification": ["verify"], "repo_areas": ["workflow"] }',
      "  ]",
      "}",
      "```",
    ].join("\n"),
  });

  let payloadOnlyCreateCalls = 0;
  let payloadOnlyCreateArg = null;
  const createTask = async function createTaskPayloadOnly(taskData = {}) {
    payloadOnlyCreateCalls += 1;
    payloadOnlyCreateArg = taskData;
    if (typeof taskData?.title !== "string" || !taskData.title.trim()) {
      throw new Error("missing title payload");
    }
    if (taskData.projectId !== "proj-payload") {
      throw new Error("missing project id payload");
    }
    return { id: "task-payload-only-1" };
  };

  const mockEngine = {
    services: {
      kanban: {
        createTask,
      },
    },
  };

  const node = {
    id: "materialize-payload-only",
    type: "action.materialize_planner_tasks",
    config: {
      plannerNodeId: "run-planner",
      projectId: "proj-payload",
      status: "todo",
      failOnZero: true,
      dedup: false,
      minCreated: 1,
    },
  };

  const result = await handler.execute(node, ctx, mockEngine);
  expect(result.success).toBe(true);
  expect(result.createdCount).toBe(1);
  expect(payloadOnlyCreateCalls).toBe(1);
  expect(payloadOnlyCreateArg).toEqual(expect.objectContaining({
    title: "[m] fix(materialize): payload-only adapter",
    status: "todo",
    projectId: "proj-payload",
  }));
});

it("action.materialize_planner_tasks applies workspace defaults from workflow context when planner output omits them", async () => {
  const handler = getNodeType("action.materialize_planner_tasks");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({
    workspaceId: "workspace-alpha",
    _targetRepo: "repo-alpha",
  });
  ctx.setNodeOutput("run-planner", {
    output: [
      "```json",
      "{",
      '  "tasks": [',
      '    { "title": "[m] feat(workflow): apply defaults", "description": "A", "acceptance_criteria": ["ac"], "verification": ["verify"], "repo_areas": ["workflow"] }',
      "  ]",
      "}",
      "```",
    ].join("\n"),
  });

  const createTask = vi.fn(async () => ({ id: "task-defaults-1" }));
  const mockEngine = {
    services: {
      kanban: {
        createTask,
      },
    },
  };

  const node = {
    id: "materialize",
    type: "action.materialize_planner_tasks",
    config: {
      plannerNodeId: "run-planner",
      status: "draft",
      dedup: false,
      failOnZero: true,
      minCreated: 1,
    },
  };

  const result = await handler.execute(node, ctx, mockEngine);
  expect(result.success).toBe(true);
  expect(result.createdCount).toBe(1);
  expect(createTask).toHaveBeenCalledWith("", expect.objectContaining({
    title: "[m] feat(workflow): apply defaults",
    workspace: "workspace-alpha",
    repository: "repo-alpha",
    meta: expect.objectContaining({
      workspace: "workspace-alpha",
      repository: "repo-alpha",
    }),
  }));
});

it("action.materialize_planner_tasks enforces planner quality gates and persists planner metadata", async () => {
  const handler = getNodeType("action.materialize_planner_tasks");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({});
  ctx.setNodeOutput("run-planner", {
    output: [
      "```json",
      "{",
      '  "tasks": [',
      '    { "title": "[m] fix(workflow): missing acceptance", "description": "A", "verification": ["v1"], "repo_areas": ["workflow"], "impact": 0.9, "risk": 0.2 },',
      '    { "title": "[m] fix(workflow): low impact", "description": "B", "acceptance_criteria": ["ac"], "verification": ["v"], "repo_areas": ["workflow"], "impact": 0.1, "risk": 0.2 },',
      '    { "title": "[m] fix(workflow): high risk", "description": "C", "acceptance_criteria": ["ac"], "verification": ["v"], "repo_areas": ["workflow"], "impact": 0.9, "risk": 9.5 },',
      '    { "title": "[m] fix(workflow): area saturated", "description": "D", "acceptance_criteria": ["ac"], "verification": ["v"], "repo_areas": ["workflow"], "impact": 0.9, "risk": 0.2 },',
      '    { "title": "[m] fix(server): valid candidate", "description": "E", "acceptance_criteria": ["ac-server"], "verification": ["v-server"], "repo_areas": ["server"], "impact": 0.9, "confidence": 0.8, "risk": 0.2, "estimated_effort": "M", "why_now": "blocking incidents", "kill_criteria": ["if flaky"] }',
      "  ]",
      "}",
      "```",
    ].join("\n"),
  });

  const createTask = vi.fn(async () => ({ id: "task-quality-1" }));
  const listTasks = vi.fn().mockResolvedValue([
    { id: "existing-1", title: "existing workflow task", status: "todo", meta: { repo_areas: ["workflow"] } },
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
    id: "materialize-quality",
    type: "action.materialize_planner_tasks",
    config: {
      plannerNodeId: "run-planner",
      projectId: "proj-123",
      failOnZero: true,
      dedup: true,
      minCreated: 1,
      minImpactScore: 0.5,
      maxRiskWithoutHuman: "medium",
      maxConcurrentRepoAreaTasks: 1,
    },
  };

  const result = await handler.execute(node, ctx, mockEngine);
  expect(result.success).toBe(true);
  expect(result.createdCount).toBe(1);
  expect(result.skippedCount).toBe(4);
  expect(result.skipped).toEqual(expect.arrayContaining([
    expect.objectContaining({ title: "[m] fix(workflow): missing acceptance", reason: "missing_acceptance_criteria" }),
    expect.objectContaining({ title: "[m] fix(workflow): low impact", reason: "below_min_impact" }),
    expect.objectContaining({ title: "[m] fix(workflow): high risk", reason: "risk_above_threshold" }),
    expect.objectContaining({ title: "[m] fix(workflow): area saturated", reason: "repo_area_saturated" }),
  ]));
  expect(createTask).toHaveBeenCalledTimes(1);
  expect(createTask).toHaveBeenCalledWith("proj-123", expect.objectContaining({
    title: "[m] fix(server): valid candidate",
    repo_areas: ["server"],
    meta: expect.objectContaining({
      repo_areas: ["server"],
      planner: expect.objectContaining({
        impact: 9,
        confidence: 8,
        risk: "low",
        estimated_effort: "m",
        repo_areas: ["server"],
        why_now: "blocking incidents",
        kill_criteria: ["if flaky"],
      }),
    }),
  }));
});

it("action.materialize_planner_tasks applies planner task graph links after creation", async () => {
  const handler = getNodeType("action.materialize_planner_tasks");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({});
  ctx.setNodeOutput("run-planner", {
    output: JSON.stringify({
      root_task_id: "root-parent",
      tasks: [
        {
          title: "Foundation task",
          task_key: "foundation",
          description: "Create the base graph node",
          acceptance_criteria: ["foundation exists"],
          verification: ["node --test tests/workflow-engine.test.mjs"],
          repo_areas: ["workflow"],
          impact: 0.9,
          confidence: 0.8,
          risk: 0.2,
        },
        {
          title: "Validation task",
          task_key: "validation",
          description: "Validate after foundation",
          depends_on_task_keys: ["foundation"],
          acceptance_criteria: ["validation depends on foundation"],
          verification: ["node --test tests/workflow-engine.test.mjs"],
          repo_areas: ["tests"],
          impact: 0.8,
          confidence: 0.8,
          risk: 0.2,
        },
        {
          title: "Docs child",
          task_key: "docs_child",
          parent_task_key: "foundation",
          description: "Nested under foundation",
          acceptance_criteria: ["child parent assigned"],
          verification: ["node --test tests/workflow-engine.test.mjs"],
          repo_areas: ["docs"],
          impact: 0.7,
          confidence: 0.7,
          risk: 0.2,
        },
      ],
    }),
  });

  const storeDir = mkdtempSync(join(tmpdir(), "wf-engine-graph-store-"));
  process.env.BOSUN_STORE_PATH = join(storeDir, "kanban-state.json");
  try {
    const taskStore = await import("../task/task-store.mjs");
    taskStore.configureTaskStore({ storePath: process.env.BOSUN_STORE_PATH });
    taskStore.loadStore();
    taskStore.addTask({ id: "root-parent", title: "Parent Task", status: "todo" });
    await taskStore.waitForStoreWrites();

    let nextId = 1;
    const createTask = vi.fn(async (_projectId, payload) => {
      const id = `graph-task-${nextId++}`;
      taskStore.addTask({
        id,
        title: payload.title,
        description: payload.description,
        status: payload.status,
        workspace: payload.workspace || null,
        repository: payload.repository || null,
        meta: payload.meta || {},
      });
      await taskStore.waitForStoreWrites();
      return { id };
    });

    const result = await handler.execute(
      {
        id: "materialize-graph",
        type: "action.materialize_planner_tasks",
        config: {
          plannerNodeId: "run-planner",
          failOnZero: true,
          dedup: false,
          minCreated: 3,
          maxTasks: 3,
          minImpactScore: 0,
        },
      },
      ctx,
      {
        services: {
          kanban: {
            createTask,
            listTasks: vi.fn(async () => []),
          },
        },
      },
    );

    await taskStore.waitForStoreWrites();
    const foundation = taskStore.getTask("graph-task-1");
    const validation = taskStore.getTask("graph-task-2");
    const docsChild = taskStore.getTask("graph-task-3");

    expect(result.success).toBe(true);
    expect(result.graphMaterialization.appliedParentLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ childTaskId: "graph-task-1", parentTaskId: "root-parent" }),
      expect.objectContaining({ childTaskId: "graph-task-2", parentTaskId: "root-parent" }),
      expect.objectContaining({ childTaskId: "graph-task-3", parentTaskId: "graph-task-1" }),
    ]));
    expect(result.graphMaterialization.appliedDependencyLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: "graph-task-2", dependencyTaskId: "graph-task-1" }),
    ]));
    expect(foundation?.parentTaskId).toBe("root-parent");
    expect(validation?.parentTaskId).toBe("root-parent");
    expect(validation?.dependencyTaskIds).toContain("graph-task-1");
    expect(docsChild?.parentTaskId).toBe("graph-task-1");
    expect(docsChild?.type).toBe("subtask");
  } finally {
    delete process.env.BOSUN_STORE_PATH;
    try { rmSync(storeDir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

it("action.materialize_planner_tasks reorders candidates using replayed executor feedback priors", async () => {
  const handler = getNodeType("action.materialize_planner_tasks");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({});
  ctx.setNodeOutput("run-planner", {
    output: [
      "```json",
      "{",
      '  "tasks": [',
      '    { "title": "[m] fix(workflow): repeat offender", "description": "A", "acceptance_criteria": ["ac-a"], "verification": ["verify-a"], "repo_areas": ["workflow"], "impact": 0.9, "confidence": 0.9, "risk": 0.2 },',
      '    { "title": "[m] chore(workflow): stable follow-up", "description": "B", "acceptance_criteria": ["ac-b"], "verification": ["verify-b"], "repo_areas": ["workflow"], "impact": 0.7, "confidence": 0.8, "risk": 0.2 }',
      "  ]",
      "}",
      "```",
    ].join("\n"),
  });

  const createTask = vi
    .fn()
    .mockResolvedValueOnce({ id: "task-rank-1" })
    .mockResolvedValueOnce({ id: "task-rank-2" });
  const listTasks = vi.fn().mockResolvedValue([
    {
      id: "hist-1",
      title: "[m] fix(workflow): failed attempt 1",
      status: "todo",
      agentAttempts: 3,
      consecutiveNoCommits: 2,
      blockedReason: "merge conflict",
      meta: { repo_areas: ["workflow"] },
    },
    {
      id: "hist-2",
      title: "[m] fix(workflow): failed attempt 2",
      status: "todo",
      agentAttempts: 2,
      consecutiveNoCommits: 1,
      blockedReason: "tests failing",
      meta: { repo_areas: ["workflow"] },
    },
    {
      id: "hist-3",
      title: "[m] chore(workflow): baseline success",
      status: "done",
      hasCommits: true,
      agentAttempts: 1,
      consecutiveNoCommits: 0,
      meta: { repo_areas: ["workflow"] },
    },
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
    id: "materialize-ranked",
    type: "action.materialize_planner_tasks",
    config: {
      plannerNodeId: "run-planner",
      failOnZero: true,
      dedup: false,
      minCreated: 2,
      failurePriorThreshold: 2,
      failurePriorStep: 2,
      feedbackSignalScale: 0.2,
    },
  };

  const result = await handler.execute(node, ctx, mockEngine);
  expect(result.success).toBe(true);
  expect(result.createdCount).toBe(2);
  const createdTitles = createTask.mock.calls.map((call) => call?.[1]?.title);
  expect(createdTitles).toEqual([
    "[m] chore(workflow): stable follow-up",
    "[m] fix(workflow): repeat offender",
  ]);
  expect(result.rankedTasks?.[0]?.title).toBe("[m] chore(workflow): stable follow-up");
});

it("action.materialize_planner_tasks reorders candidates from planner feedback replay when historical rows lack signals", async () => {
  const handler = getNodeType("action.materialize_planner_tasks");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({
    _plannerFeedback: {
      rankingSignals: {
        failureThreshold: 2.5,
        weights: {
          agentAttempts: 0.35,
          consecutiveNoCommits: 1.25,
          blockedReason: 1.5,
          debtTrend: 0.4,
        },
        patterns: [
          {
            key: "workflow::fix",
            repoArea: "workflow",
            archetype: "fix",
            failureCounter: 6.2,
            failures: 4,
            successes: 0,
            negativePrior: 2.2,
          },
        ],
      },
      taskStore: {
        hotTasks: [
          {
            taskId: "hist-hot-1",
            title: "[m] fix(workflow): repeat offender",
            status: "blocked",
            agentAttempts: 3,
            consecutiveNoCommits: 2,
            blockedReason: "merge conflict",
            archetype: "fix",
            repoAreas: ["workflow"],
          },
        ],
      },
    },
  });
  ctx.setNodeOutput("run-planner", {
    output: [
      "```json",
      "{",
      '  "tasks": [',
      '    { "title": "[m] fix(workflow): repeat offender", "description": "A", "acceptance_criteria": ["ac-a"], "verification": ["verify-a"], "repo_areas": ["workflow"], "impact": 0.9, "confidence": 0.9, "risk": 0.2 },',
      '    { "title": "[m] chore(workflow): stable follow-up", "description": "B", "acceptance_criteria": ["ac-b"], "verification": ["verify-b"], "repo_areas": ["workflow"], "impact": 0.7, "confidence": 0.8, "risk": 0.2 }',
      "  ]",
      "}",
      "```",
    ].join("\n"),
  });

  const createTask = vi
    .fn()
    .mockResolvedValueOnce({ id: "task-feedback-rank-1" })
    .mockResolvedValueOnce({ id: "task-feedback-rank-2" });
  const listTasks = vi.fn().mockResolvedValue([
    {
      id: "hist-empty-1",
      title: "[m] fix(workflow): old task without executor metadata",
      status: "todo",
      meta: { repo_areas: ["workflow"] },
    },
  ]);

  const node = {
    id: "materialize-feedback-ranked",
    type: "action.materialize_planner_tasks",
    config: {
      plannerNodeId: "run-planner",
      failOnZero: true,
      dedup: false,
      minCreated: 2,
      failurePriorThreshold: 2,
      failurePriorStep: 2,
      feedbackSignalScale: 0.2,
    },
  };

  const result = await handler.execute(node, ctx, {
    services: {
      kanban: {
        createTask,
        listTasks,
      },
    },
  });
  expect(result.success).toBe(true);
  const createdTitles = createTask.mock.calls.map((call) => call?.[1]?.title);
  expect(createdTitles).toEqual([
    "[m] chore(workflow): stable follow-up",
    "[m] fix(workflow): repeat offender",
  ]);
});

it("action.materialize_planner_tasks avoids over-penalizing patterns after transient failures recover", async () => {
  const handler = getNodeType("action.materialize_planner_tasks");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({});
  ctx.setNodeOutput("run-planner", {
    output: [
      "```json",
      "{",
      '  "tasks": [',
      '    { "title": "[m] fix(workflow): recovered pattern", "description": "A", "acceptance_criteria": ["ac-a"], "verification": ["verify-a"], "repo_areas": ["workflow"], "impact": 0.9, "confidence": 0.9, "risk": 0.2 },',
      '    { "title": "[m] chore(workflow): fallback task", "description": "B", "acceptance_criteria": ["ac-b"], "verification": ["verify-b"], "repo_areas": ["workflow"], "impact": 0.8, "confidence": 0.85, "risk": 0.2 }',
      "  ]",
      "}",
      "```",
    ].join("\n"),
  });

  const createTask = vi
    .fn()
    .mockResolvedValueOnce({ id: "task-recovered-1" })
    .mockResolvedValueOnce({ id: "task-recovered-2" });
  const listTasks = vi.fn().mockResolvedValue([
    {
      id: "hist-recovered-failure",
      title: "[m] fix(workflow): temporary failure",
      status: "todo",
      agentAttempts: 2,
      consecutiveNoCommits: 2,
      blockedReason: "merge conflict",
      meta: { repo_areas: ["workflow"] },
    },
    {
      id: "hist-recovered-success-1",
      title: "[m] fix(workflow): merged follow-up",
      status: "done",
      hasCommits: true,
      agentAttempts: 1,
      consecutiveNoCommits: 0,
      meta: { repo_areas: ["workflow"] },
    },
    {
      id: "hist-recovered-success-2",
      title: "[m] fix(workflow): merged stabilization",
      status: "done",
      hasCommits: true,
      agentAttempts: 1,
      consecutiveNoCommits: 0,
      meta: { repo_areas: ["workflow"] },
    },
  ]);

  const result = await handler.execute(
    {
      id: "materialize-recovered",
      type: "action.materialize_planner_tasks",
      config: {
        plannerNodeId: "run-planner",
        failOnZero: true,
        dedup: false,
        minCreated: 2,
        failurePriorThreshold: 2,
        failurePriorStep: 2,
        feedbackSignalScale: 0.2,
      },
    },
    ctx,
    {
      services: {
        kanban: {
          createTask,
          listTasks,
        },
      },
    },
  );

  expect(result.success).toBe(true);
  const createdTitles = createTask.mock.calls.map((call) => call?.[1]?.title);
  expect(createdTitles).toEqual([
    "[m] fix(workflow): recovered pattern",
    "[m] chore(workflow): fallback task",
  ]);
  expect(result.rankedTasks?.[0]?._ranking?.penalty ?? 0).toBeLessThan(0.4);
});

it("agent.run_planner injects resume guidance once and preserves next-step context", async () => {
  const handler = getNodeType("agent.run_planner");
  expect(handler).toBeDefined();

  const launchEphemeralThread = vi.fn(async (prompt) => ({
    success: true,
    output: JSON.stringify({
      tasks: Array.from({ length: 5 }, (_, index) => ({
        title: `[m] task ${index + 1}`,
        description: `Task ${index + 1}`,
        acceptance_criteria: ["criterion"],
        verification: ["verify"],
        repo_areas: ["workflow"],
        impact: 0.8,
        confidence: 0.8,
        risk: 0.2,
      })),
    }),
    sdk: "mock",
    threadId: "planner-thread-1",
  }));

  const plannerFeedback = {
    issueAdvisorSummary: "Preserve completed DAG progress and resume the current run.",
    recommendedAction: "Resume from the next pending implementation stage.",
    nextStepGuidance: "Continue from Write Tests First and keep completed nodes untouched.",
    dagStateSummary: {
      completedNodes: [
        { id: "trigger", label: "Trigger", status: "completed" },
      ],
      currentNode: { id: "plan-work", label: "Plan Work", status: "running" },
      pendingNodes: [
        { id: "write-tests", label: "Write Tests First", status: "pending" },
        { id: "implement", label: "Implement", status: "pending" },
      ],
    },
  };

  const ctx = new WorkflowContext({
    _plannerFeedback: plannerFeedback,
    repoRoot: process.cwd(),
  });

  const result = await handler.execute(
    {
      id: "run-planner",
      type: "agent.run_planner",
      config: {
        taskCount: 5,
        prompt: "Plan exactly five remaining implementation tasks.",
      },
    },
    ctx,
    {
      services: {
        agentPool: { launchEphemeralThread },
      },
    },
  );

  expect(result.success).toBe(true);
  expect(launchEphemeralThread).toHaveBeenCalledTimes(1);
  const plannerPrompt = launchEphemeralThread.mock.calls[0][0];
  expect(plannerPrompt).toContain("Planner feedback context:");
  expect(plannerPrompt).toContain("Write Tests First");
  expect(plannerPrompt.match(/Write Tests First/g) ?? []).toHaveLength(1);
  expect(plannerPrompt).toContain("issueAdvisorSummary");
  expect(plannerPrompt).toContain("recommendedAction");
  expect(plannerPrompt).toContain("nextStepGuidance");
  expect(plannerPrompt).toContain("Generate exactly 5 new tasks.");
});

it("action.materialize_planner_tasks preserves resumed DAG ordering and caps to five tasks", async () => {
  const handler = getNodeType("action.materialize_planner_tasks");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({
    _plannerFeedback: {
      issueAdvisor: {
        nextStepLabel: "Write Tests First",
      },
      dagStateSummary: {
        completedNodes: [
          { id: "trigger", label: "Trigger", status: "completed" },
        ],
        currentNode: { id: "plan-work", label: "Plan Work", status: "running" },
        pendingNodes: [
          { id: "write-tests", label: "Write Tests First", status: "pending" },
          { id: "implement", label: "Implement", status: "pending" },
          { id: "validation-build", label: "Build", status: "pending" },
          { id: "validation-tests", label: "Tests", status: "pending" },
          { id: "validation-lint", label: "Lint", status: "pending" },
          { id: "create-pr", label: "Create PR", status: "pending" },
        ],
      },
    },
  });

  ctx.setNodeOutput("run-planner", {
    output: JSON.stringify({
      tasks: [
        { title: "Write Tests First", description: "Resume from tests", acceptance_criteria: ["tests added"], verification: ["node --test tests/workflow-engine.test.mjs"], repo_areas: ["workflow"], impact: 0.95, confidence: 0.9, risk: 0.2 },
        { title: "Implement planner resume handling", description: "Preserve DAG state", acceptance_criteria: ["completed nodes preserved"], verification: ["node --test tests/workflow-engine.test.mjs"], repo_areas: ["workflow"], impact: 0.9, confidence: 0.85, risk: 0.2 },
        { title: "Validate build stage", description: "Keep build gate intact", acceptance_criteria: ["build task prepared"], verification: ["npm run build"], repo_areas: ["workflow"], impact: 0.7, confidence: 0.8, risk: 0.2 },
        { title: "Validate tests stage", description: "Keep tests gate intact", acceptance_criteria: ["tests task prepared"], verification: ["npm test"], repo_areas: ["tests"], impact: 0.7, confidence: 0.8, risk: 0.2 },
        { title: "Create PR handoff", description: "Prepare PR path", acceptance_criteria: ["PR task prepared"], verification: ["manual review"], repo_areas: ["workflow"], impact: 0.6, confidence: 0.75, risk: 0.2 },
        { title: "Extra task that should be ignored", description: "ignored", acceptance_criteria: ["ignored"], verification: ["ignored"], repo_areas: ["workflow"], impact: 0.5, confidence: 0.7, risk: 0.2 }
      ],
    }),
  });

  const createTask = vi.fn(async (_projectId, payload) => ({ id: payload.title }));
  const listTasks = vi.fn(async () => []);

  const result = await handler.execute(
    {
      id: "materialize-resume",
      type: "action.materialize_planner_tasks",
      config: {
        plannerNodeId: "run-planner",
        projectId: "proj-123",
        failOnZero: true,
        dedup: false,
        minCreated: 5,
        maxTasks: 5,
        minImpactScore: 0,
      },
    },
    ctx,
    {
      services: {
        kanban: { createTask, listTasks },
      },
    },
  );

  expect(result.success).toBe(true);
  expect(result.createdCount).toBe(5);
  expect(createTask).toHaveBeenCalledTimes(5);
  const createdTitles = createTask.mock.calls.map((call) => call[1].title);
  expect(createdTitles).toEqual([
    "Write Tests First",
    "Implement planner resume handling",
    "Validate build stage",
    "Validate tests stage",
    "Create PR handoff",
  ]);
  expect(createdTitles).not.toContain("Extra task that should be ignored");
  expect(result.parsedCount).toBe(6);
  expect(result.rankedTasks).toHaveLength(5);
  expect(result.rankedTasks.map((task) => task.title)).toEqual(createdTitles);
});

it("action.materialize_planner_tasks skips completed DAG nodes while keeping the next pending node first", async () => {
  const handler = getNodeType("action.materialize_planner_tasks");
  expect(handler).toBeDefined();

  const ctx = new WorkflowContext({
    _plannerFeedback: {
      issueAdvisor: {
        nextStepLabel: "Write Tests First",
      },
      dagStateSummary: {
        completedNodes: [
          { id: "trigger", label: "Trigger", status: "completed" },
          { id: "plan-work", label: "Plan Work", status: "completed" },
        ],
        currentNode: { id: "materialize", label: "Materialize Tasks", status: "running" },
        pendingNodes: [
          { id: "write-tests", label: "Write Tests First", status: "pending" },
          { id: "implement", label: "Implement", status: "pending" },
          { id: "validation-build", label: "Build", status: "pending" },
          { id: "validation-tests", label: "Tests", status: "pending" },
          { id: "create-pr", label: "Create PR", status: "pending" },
          { id: "follow-up", label: "Follow Up", status: "pending" },
        ],
      },
    },
  });

  ctx.setNodeOutput("run-planner", {
    output: JSON.stringify({
      tasks: [
        { title: "Plan Work", description: "already completed and must stay out", acceptance_criteria: ["ignored"], verification: ["ignored"], repo_areas: ["workflow"], impact: 0.99, confidence: 0.9, risk: 0.1 },
        { title: "Implement planner resume handling", description: "Preserve DAG state", acceptance_criteria: ["completed nodes preserved"], verification: ["node --test tests/workflow-engine.test.mjs"], repo_areas: ["workflow"], impact: 0.92, confidence: 0.88, risk: 0.2 },
        { title: "Write Tests First", description: "Resume from tests", acceptance_criteria: ["tests added"], verification: ["node --test tests/workflow-engine.test.mjs"], repo_areas: ["workflow"], impact: 0.95, confidence: 0.9, risk: 0.2 },
        { title: "Build validation coverage", description: "Keep build gate intact", acceptance_criteria: ["build task prepared"], verification: ["npm run build"], repo_areas: ["workflow"], impact: 0.7, confidence: 0.8, risk: 0.2 },
        { title: "Test validation coverage", description: "Keep tests gate intact", acceptance_criteria: ["tests task prepared"], verification: ["npm test"], repo_areas: ["tests"], impact: 0.7, confidence: 0.8, risk: 0.2 },
        { title: "Create PR handoff", description: "Prepare PR path", acceptance_criteria: ["PR task prepared"], verification: ["manual review"], repo_areas: ["workflow"], impact: 0.6, confidence: 0.75, risk: 0.2 },
        { title: "Follow Up task", description: "Final pending task", acceptance_criteria: ["follow-up prepared"], verification: ["manual review"], repo_areas: ["workflow"], impact: 0.5, confidence: 0.7, risk: 0.2 }
      ],
    }),
  });

  const createTask = vi.fn(async (_projectId, payload) => ({ id: payload.title }));
  const listTasks = vi.fn(async () => []);

  const result = await handler.execute(
    {
      id: "materialize-resume-completed-filter",
      type: "action.materialize_planner_tasks",
      config: {
        plannerNodeId: "run-planner",
        projectId: "proj-123",
        failOnZero: true,
        dedup: false,
        minCreated: 5,
        maxTasks: 5,
        minImpactScore: 0,
      },
    },
    ctx,
    {
      services: {
        kanban: { createTask, listTasks },
      },
    },
  );

  expect(result.success).toBe(true);
  expect(result.createdCount).toBe(5);
  const createdTitles = createTask.mock.calls.map((call) => call[1].title);
  expect(createdTitles[0]).toBe("Write Tests First");
  expect(createdTitles).toEqual([
    "Write Tests First",
    "Implement planner resume handling",
    "Build validation coverage",
    "Test validation coverage",
    "Create PR handoff",
  ]);
  expect(createdTitles).not.toContain("Plan Work");
  expect(createdTitles).not.toContain("Follow Up task");
  expect(result.rankedTasks.map((task) => task.title)).toEqual(createdTitles);
});
describe("WorkflowEngine singleton services", () => {
  beforeEach(() => {
    resetWorkflowEngine();
  });

  afterEach(() => {
    resetWorkflowEngine();
  });

  it("merges injected services when getWorkflowEngine is called after initialization", () => {
    const first = getWorkflowEngine({
      services: {
        kanban: { createTask: () => ({ id: "1" }) },
      },
    });
    expect(first.services.kanban).toBeDefined();
    expect(first.services.agentPool).toBeUndefined();

    const second = getWorkflowEngine({
      services: {
        agentPool: { launchEphemeralThread: async () => ({ success: true, output: "" }) },
        prompts: { planner: "Planner prompt" },
      },
    });

    expect(second).toBe(first);
    expect(second.services.kanban).toBeDefined();
    expect(second.services.agentPool).toBeDefined();
    expect(second.services.prompts?.planner).toBe("Planner prompt");
  }, 20000);

  it("reinitializes the singleton when explicit workflow directories change", () => {
    const workflowDirA = join(tmpDir, "singleton-workflows-a");
    const runsDirA = join(tmpDir, "singleton-runs-a");
    const configDirA = join(tmpDir, "singleton-config-a");
    const workflowDirB = join(tmpDir, "singleton-workflows-b");
    const runsDirB = join(tmpDir, "singleton-runs-b");
    const configDirB = join(tmpDir, "singleton-config-b");

    const first = getWorkflowEngine({
      workflowDir: workflowDirA,
      runsDir: runsDirA,
      configDir: configDirA,
      services: {
        kanban: { createTask: () => ({ id: "1" }) },
      },
    });
    const second = getWorkflowEngine({
      workflowDir: workflowDirB,
      runsDir: runsDirB,
      configDir: configDirB,
      services: {
        agentPool: { launchEphemeralThread: async () => ({ success: true, output: "" }) },
      },
    });

    expect(second).not.toBe(first);
    expect(second.workflowDir).toBe(resolve(workflowDirB));
    expect(second.runsDir).toBe(resolve(runsDirB));
    expect(second.services.kanban).toBeDefined();
    expect(second.services.agentPool).toBeDefined();
  });
});

// ── Anomaly Detector Integration Tests ──────────────────────────────────────

describe("Anomaly → Workflow bridge", () => {
  it("wrapAnomalyCallback fires workflow triggers", async () => {
    const { wrapAnomalyCallback, setWorkflowEngine } = await import("../infra/anomaly-detector.mjs");

    const mockEvaluate = vi.fn();
    setWorkflowEngine({ evaluateTriggers: mockEvaluate });

    const originalCb = vi.fn();
    const wrapped = wrapAnomalyCallback(originalCb);

    const anomaly = {
      type: "stuck_agent",
      severity: "high",
      processId: "proc-123",
      shortId: "proc-1",
      message: "Agent stuck for 10m",
      action: "kill",
      taskTitle: "Fix the bug",
      data: { foo: "bar" },
    };

    wrapped(anomaly);

    // Original callback still called
    expect(originalCb).toHaveBeenCalledWith(anomaly);

    // Workflow engine gets trigger
    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(mockEvaluate).toHaveBeenCalledWith("anomaly", expect.objectContaining({
      anomalyType: "stuck_agent",
      severity: "high",
      agentId: "proc-123",
    }));

    // Clean up
    setWorkflowEngine(null);
  });
});

// ── Template Dedup Tests ────────────────────────────────────────────────────

describe("Template dedup on install", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("rejects installing a template that is already installed", async () => {
    const { installTemplate } = await import("../workflow/workflow-templates.mjs");

    // Install once - should succeed
    const wf = installTemplate("template-pr-merge-strategy", engine);
    expect(wf).toBeDefined();
    expect(wf.metadata.installedFrom).toBe("template-pr-merge-strategy");

    // Install again - should throw
    expect(() => installTemplate("template-pr-merge-strategy", engine)).toThrow(/already installed/i);
  });
});

// ── Retry Backoff Configuration Tests ───────────────────────────────────────

describe("WorkflowEngine - configurable retry backoff", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("uses custom retryDelayMs for backoff base", async () => {
    const backoffs = [];
    let callCount = 0;
    registerNodeType("test.custom_delay_fail", {
      describe: () => "Fails with custom delay",
      schema: { type: "object", properties: {} },
      async execute() {
        callCount++;
        throw new Error("fail");
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "node", type: "test.custom_delay_fail", label: "Fail", config: { maxRetries: 2, retryDelayMs: 0 } },
      ],
      [{ id: "e1", source: "trigger", target: "node" }]
    );

    engine.save(wf);
    engine.on("node:retry", (ev) => backoffs.push(ev.backoffMs));
    await engine.execute(wf.id, {});

    expect(callCount).toBe(3);
    // With retryDelayMs=0, backoff should be 0ms (0*2^0=0, 0*2^1=0)
    expect(backoffs).toEqual([0, 0]);
  });

  it("defaults to 1000ms base when retryDelayMs not set", async () => {
    const backoffs = [];
    let callCount = 0;
    registerNodeType("test.default_delay_fail", {
      describe: () => "Fails with default delay",
      schema: { type: "object", properties: {} },
      async execute() {
        callCount++;
        throw new Error("fail");
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "node", type: "test.default_delay_fail", label: "Fail", config: { maxRetries: 1 } },
      ],
      [{ id: "e1", source: "trigger", target: "node" }]
    );

    engine.save(wf);
    engine.on("node:retry", (ev) => backoffs.push(ev.backoffMs));
    await engine.execute(wf.id, {});

    expect(callCount).toBe(2);
    // Default backoff = 1000 * 2^0 = 1000ms
    expect(backoffs).toEqual([1000]);
  });
});

// ── Timer Cleanup Tests ─────────────────────────────────────────────────────

describe("WorkflowEngine - timeout timer cleanup", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("does not leak timers when node completes before timeout", async () => {
    registerNodeType("test.fast_node", {
      describe: () => "Completes instantly",
      schema: { type: "object", properties: {} },
      async execute() {
        return { fast: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "fast", type: "test.fast_node", label: "Fast", config: { timeout: 60000 } },
      ],
      [{ id: "e1", source: "trigger", target: "fast" }]
    );

    engine.save(wf);
    // If timers leaked, the 60s timeout timer would keep the process alive.
    // The assertion only needs to prove we finish comfortably before that
    // deadline, not within an arbitrarily small wall-clock budget for this
    // heavyweight isolated suite on Windows.
    const start = Date.now();
    const result = await engine.execute(wf.id, {});
    expect(Date.now() - start).toBeLessThan(FAST_WORKFLOW_ENGINE_TIMER_CLEANUP_ASSERTION_MS);
    expect(result.errors.length).toBe(0);
    const output = result.getNodeOutput("fast");
    expect(output.fast).toBe(true);
  });

  it("honors timeoutMs from node config", async () => {
    registerNodeType("test.slow_node_for_timeout_ms", {
      describe: () => "Sleeps long enough to trigger timeoutMs",
      schema: { type: "object", properties: {} },
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return { done: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "slow",
          type: "test.slow_node_for_timeout_ms",
          label: "Slow",
          config: { timeoutMs: 1000, maxRetries: 0, retryDelayMs: 0 },
        },
      ],
      [{ id: "e1", source: "trigger", target: "slow" }]
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(result.errors.length).toBeGreaterThan(0);
    expect(String(result.errors[0]?.error || "")).toContain("timed out after 1000ms");
  });
});

// ── Concurrency & Scalability ──────────────────────────────────────────────

describe("Concurrency limiter", () => {
  beforeEach(() => {
    engine = makeTmpEngine();
    engine.load();
  });

  afterEach(async () => {
    const dirToRemove = tmpDir;
    engine = null;
    tmpDir = null;
    resetWorkflowEngine();
    resetSessionTracker({ persistDir: null });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await removeDirWithRetries(dirToRemove, { ignoreFinalEperm: true });
  });

  it("getConcurrencyStats returns defaults", () => {
    const stats = engine.getConcurrencyStats();
    expect(stats.activeRuns).toBe(0);
    expect(stats.queuedRuns).toBe(0);
    expect(stats.maxConcurrentRuns).toBeGreaterThanOrEqual(1);
    expect(stats.maxConcurrentBranches).toBeGreaterThanOrEqual(1);
  });

  it("getConcurrencyStats reports harness subagent pool occupancy", async () => {
    const pool = getBosunSessionManager().getSubagentPool();
    const lease = await pool.acquire({
      poolId: "workflow-test-pool",
      sessionId: "workflow-test-session",
      maxConcurrent: 2,
    });
    let queuedPromise = null;
    let queuedLease = null;
    try {
      queuedPromise = pool.acquire({
        poolId: "workflow-test-pool",
        sessionId: "workflow-test-session-2",
        maxConcurrent: 1,
      });
      const stats = engine.getConcurrencyStats();
      expect(stats.agentSlots).toEqual({
        active: 1,
        max: 1,
        queued: 1,
      });
      pool.release(lease, { status: "completed" });
      queuedLease = await queuedPromise;
    } finally {
      pool.release(lease, { status: "completed" });
      if (!queuedLease && queuedPromise) {
        queuedLease = await queuedPromise;
      }
      if (queuedLease) {
        pool.release(queuedLease, { status: "completed" });
      }
    }
  });

  it("tracks activeRuns count during execution", async () => {
    let capturedStats = null;
    if (!getNodeType("test.capture_stats")) {
      registerNodeType("test.capture_stats", {
        describe: () => "Capture concurrency stats during execution",
        schema: { type: "object", properties: {} },
        async execute(_node, _ctx) {
          capturedStats = engine.getConcurrencyStats();
          return { captured: true };
        },
      });
    }

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "stats", type: "test.capture_stats", label: "Stats", config: {} },
      ],
      [{ id: "e1", source: "trigger", target: "stats" }]
    );

    engine.save(wf);
    await engine.execute(wf.id, {});
    expect(capturedStats).toBeDefined();
    expect(capturedStats.activeRuns).toBe(1);
  });

  it("concurrent runs track correctly", async () => {
    let maxSeen = 0;
    if (!getNodeType("test.concurrent_track")) {
      registerNodeType("test.concurrent_track", {
        describe: () => "Track concurrent runs",
        schema: { type: "object", properties: {} },
        async execute(_node, _ctx) {
          const stats = engine.getConcurrencyStats();
          if (stats.activeRuns > maxSeen) maxSeen = stats.activeRuns;
          // Small delay to overlap with other runs
          await new Promise((r) => setTimeout(r, 50));
          return { ok: true };
        },
      });
    }

    const wfs = [];
    for (let i = 0; i < 4; i++) {
      const wf = makeSimpleWorkflow(
        [
          { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
          { id: "track", type: "test.concurrent_track", label: "Track", config: {} },
        ],
        [{ id: "e1", source: "trigger", target: "track" }],
        { id: `concurrent-wf-${i}` }
      );
      engine.save(wf);
      wfs.push(wf);
    }

    // Launch all 4 concurrently
    const results = await Promise.all(wfs.map((wf) => engine.execute(wf.id, {})));
    for (const r of results) {
      expect(r.errors).toEqual([]);
    }
    // At some point, multiple runs should have been active simultaneously
    expect(maxSeen).toBeGreaterThanOrEqual(2);
    // After all complete, slots should be released
    expect(engine.getConcurrencyStats().activeRuns).toBe(0);
  }, SLOW_WORKFLOW_ENGINE_CONCURRENCY_TEST_TIMEOUT_MS);
});


describe("WorkflowEngine task traceability hooks", () => {
  beforeEach(() => {
    makeTmpEngine();
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("does not emit task trace events when task context is absent", async () => {
    registerNodeType("test.trace.no_task", {
      describe: () => "No task trace node",
      schema: { type: "object", properties: {} },
      async execute() {
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "work", type: "test.trace.no_task", label: "Work", config: {} },
      ],
      [{ id: "e1", source: "trigger", target: "work" }],
      { id: "wf-task-trace-no-task" },
    );
    engine.save(wf);

    const collected = [];
    const unsubscribe = engine.registerTaskTraceHook((event) => {
      collected.push(event);
    });
    const emitted = [];
    engine.on("task:trace", (event) => emitted.push(event));

    const ctx = await engine.execute(wf.id, {});
    unsubscribe();

    expect(ctx.errors).toEqual([]);
    expect(collected).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    expect(Array.isArray(ctx.data._taskWorkflowEvents)).toBe(false);
  });

  it("collects task-linked run and node trace summaries when taskId exists", async () => {
    registerNodeType("test.trace.with_task", {
      describe: () => "Task trace node",
      schema: { type: "object", properties: {} },
      async execute() {
        return { ok: true, message: "completed traced node" };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "work", type: "test.trace.with_task", label: "Work", config: {} },
      ],
      [{ id: "e1", source: "trigger", target: "work" }],
      { id: "wf-task-trace-with-task" },
    );
    engine.save(wf);

    const collected = [];
    engine.registerTaskTraceHook((event) => {
      collected.push(event);
    });

    const ctx = await engine.execute(wf.id, {
      taskId: "TASK-TRACE-1",
      taskTitle: "Trace this task",
      workspaceId: "workspace-trace-1",
      sessionId: "session-trace-1",
      agentId: "agent-trace-1",
    });

    expect(ctx.errors).toEqual([]);
    expect(collected.length).toBeGreaterThanOrEqual(4);
    expect(collected.every((event) => event.taskId === "TASK-TRACE-1")).toBe(true);
    expect(collected.some((event) => event.eventType === "workflow.run.start")).toBe(true);
    expect(collected.some((event) => event.eventType === "workflow.node.start")).toBe(true);
    expect(collected.some((event) => event.eventType === "workflow.node.complete")).toBe(true);
    expect(collected.some((event) => event.eventType === "workflow.run.end")).toBe(true);
    expect(collected.every((event) => event.workspaceId === "workspace-trace-1")).toBe(true);
    expect(collected.every((event) => event.sessionId === "session-trace-1")).toBe(true);
    expect(collected.every((event) => event.agentId === "agent-trace-1")).toBe(true);

    expect(Array.isArray(ctx.data._taskWorkflowEvents)).toBe(true);
    expect(ctx.data._taskWorkflowEvents.length).toBe(collected.length);
    expect(ctx.data._taskWorkflowEvents[0].runId).toBe(ctx.id);
  });

  it("derives task context from action.create_task output for downstream traceability", async () => {
    const createTask = vi.fn(async (_projectId, taskData) => ({
      id: "TASK-CREATED-42",
      title: taskData?.title || "Generated task",
      status: taskData?.status || "todo",
    }));

    const traceEvents = [];
    engine = makeTmpEngine({
      kanban: { createTask },
      onTaskWorkflowEvent: (event) => {
        traceEvents.push(event);
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "create",
          type: "action.create_task",
          label: "Create task",
          config: {
            title: "Auto-created task",
            description: "Created during workflow execution",
            status: "todo",
          },
        },
      ],
      [{ id: "e1", source: "trigger", target: "create" }],
      { id: "wf-task-trace-create-task" },
    );
    engine.save(wf);

    const ctx = await engine.execute(wf.id, {});

    expect(ctx.errors).toEqual([]);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(ctx.data.taskId).toBe("TASK-CREATED-42");
    expect(ctx.data.taskTitle).toBe("Auto-created task");

    const nodeComplete = traceEvents.find((event) =>
      event.eventType === "workflow.node.complete" && event.nodeId === "create",
    );
    expect(nodeComplete).toBeDefined();
    expect(nodeComplete.taskId).toBe("TASK-CREATED-42");
    expect(nodeComplete.summary).toContain("taskId");

    const runEnd = traceEvents.find((event) => event.eventType === "workflow.run.end");
    expect(runEnd).toBeDefined();
    expect(runEnd.taskId).toBe("TASK-CREATED-42");
  });
});


describe("WorkflowEngine.getTaskTraceEvents", () => {
  beforeEach(async () => {
    makeTmpEngine();
    const tracing = await import("../infra/tracing.mjs");
    await tracing.resetTracingForTests();
  });

  afterEach(async () => {
    const tracing = await import("../infra/tracing.mjs");
    await tracing.resetTracingForTests();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("returns cloned task trace events from persisted run detail", async () => {
    registerNodeType("test.trace.fetch_events", {
      describe: () => "Fetch task trace events",
      schema: { type: "object", properties: {} },
      async execute() {
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "work", type: "test.trace.fetch_events", label: "Work", config: {} },
      ],
      [{ id: "e1", source: "trigger", target: "work" }],
      { id: "wf-task-trace-readback" },
    );
    engine.save(wf);

    const ctx = await engine.execute(wf.id, { taskId: "TASK-TRACE-READBACK" });
    const events = engine.getTaskTraceEvents(ctx.id);

    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.taskId === "TASK-TRACE-READBACK")).toBe(true);

    events[0].taskId = "mutated";
    const reread = engine.getTaskTraceEvents(ctx.id);
    expect(reread[0].taskId).toBe("TASK-TRACE-READBACK");
  });

  it("reads task trace events from lightweight run detail", () => {
    const getRunDetailSpy = vi.spyOn(engine, "getRunDetail").mockReturnValue({
      runId: "run-lightweight-trace",
      detail: {
        data: {
          _taskWorkflowEvents: [{ eventType: "workflow.run.start", taskId: "TASK-LIGHTWEIGHT" }],
        },
      },
    });

    const events = engine.getTaskTraceEvents("run-lightweight-trace");

    expect(events).toEqual([{ eventType: "workflow.run.start", taskId: "TASK-LIGHTWEIGHT" }]);
    expect(getRunDetailSpy).toHaveBeenCalledWith("run-lightweight-trace", { decorate: false });
  });

  it("includes benchmark hints on workflow end events after in-run evaluation", async () => {
    registerNodeType("test.trace.evaluate_current_run", {
      describe: () => "Evaluate current run",
      schema: { type: "object", properties: {} },
      async execute(node, ctx, engineRef) {
        const handler = getNodeType("action.evaluate_run");
        return handler.execute({
          id: node.id,
          type: "action.evaluate_run",
          config: { outputVariable: "inRunEvaluation" },
        }, ctx, engineRef);
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "eval", type: "test.trace.evaluate_current_run", label: "Evaluate", config: {} },
      ],
      [{ id: "e1", source: "trigger", target: "eval" }],
      { id: "wf-task-trace-benchmark" },
    );
    engine.save(wf);

    const ctx = await engine.execute(wf.id, {
      taskId: "TASK-TRACE-BENCHMARK",
      taskTitle: "Benchmark current run",
    });
    const runEndEvent = engine.getTaskTraceEvents(ctx.id).find((event) => event.eventType === "workflow.run.end");
    expect(runEndEvent).toBeDefined();
    expect(runEndEvent.benchmarkHint).toEqual(expect.objectContaining({
      traceEventCount: expect.any(Number),
      traceCoverage: expect.any(Number),
    }));
  });

  it("emits nested task and agent spans for task-backed agent nodes", async () => {
    const tracing = await import("../infra/tracing.mjs");
    await tracing.setupTracing("http://collector.example/v1/traces");

    const workflow = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "agent", type: "action.run_agent", label: "Run Agent", config: { prompt: "Ship the fix" } },
      ],
      [{ id: "e1", source: "trigger", target: "agent" }],
      { id: "wf-agent-task-trace", name: "Agent Task Trace" },
    );

    engine.save(workflow);
    engine.services.agentPool = {
      launchEphemeralThread: vi.fn(async () => ({
        success: true,
        output: "done",
        threadId: "thread-trace-1",
      })),
    };

    await engine.execute(workflow.id, {
      taskId: "TASK-AGENT-TRACE",
      task: { id: "TASK-AGENT-TRACE", title: "Trace agent task", assignee: "agent-primary" },
    });

    const finishedSpans = tracing.getFinishedSpans();
    const nodeSpan = finishedSpans.find(
      (span) => span.name === "bosun.workflow.node" && span.attributes["bosun.workflow.node.id"] === "agent",
    );
    const taskSpan = finishedSpans.find(
      (span) => span.name === "bosun.task.execute" && span.attributes["bosun.task.id"] === "TASK-AGENT-TRACE",
    );
    const agentSpan = finishedSpans.find(
      (span) => span.name === "bosun.agent.session" && span.attributes["bosun.task.id"] === "TASK-AGENT-TRACE",
    );

    expect(nodeSpan).toBeDefined();
    expect(taskSpan).toBeDefined();
    expect(agentSpan).toBeDefined();
    expect(taskSpan.traceId).toBe(nodeSpan.traceId);
    expect(taskSpan.parentSpanId).toBe(nodeSpan.spanId);
    expect(agentSpan.parentSpanId).toBe(taskSpan.spanId);
    expect(taskSpan.attributes).toEqual(expect.objectContaining({
      "bosun.workflow.id": workflow.id,
      "bosun.task.id": "TASK-AGENT-TRACE",
      "bosun.agent.id": "agent",
    }));
  });

  it("preserves a single trace across parent and child workflow execution", async () => {
    const tracing = await import("../infra/tracing.mjs");
    await tracing.setupTracing("http://collector.example/v1/traces");

    const child = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
      ],
      [],
      { id: "wf-child-trace", name: "Child Trace Workflow" },
    );

    const parent = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "child",
          type: "flow.universal",
          label: "Child",
          config: { workflowId: child.id, mode: "sync", inheritContext: true },
        },
      ],
      [{ id: "e1", source: "trigger", target: "child" }],
      { id: "wf-parent-trace", name: "Parent Trace Workflow" },
    );

    engine.save(child);
    engine.save(parent);

    const parentCtx = await engine.execute(parent.id, { taskId: "TASK-WF-TRACE" });

    const finishedSpans = tracing.getFinishedSpans();
    const workflowSpans = finishedSpans.filter((span) => span.name === "bosun.workflow.run");
    const nodeSpans = finishedSpans.filter((span) => span.name === "bosun.workflow.node");
    const parentSpan = workflowSpans.find((span) => span.attributes["bosun.workflow.id"] === parent.id);
    const childSpan = workflowSpans.find((span) => span.attributes["bosun.workflow.id"] === child.id);
    const childNodeSpan = nodeSpans.find((span) => span.attributes["bosun.workflow.node.id"] === "child");

    expect(parentCtx.errors).toEqual([]);
    expect(parentSpan).toBeDefined();
    expect(childSpan).toBeDefined();
    expect(childNodeSpan).toBeDefined();
    expect(childSpan.traceId).toBe(parentSpan.traceId);
    expect(childSpan.parentSpanId).toBe(childNodeSpan.spanId);
    expect(parentSpan.attributes["bosun.task.id"]).toBe("TASK-WF-TRACE");
    expect(childSpan.attributes["bosun.task.id"]).toBe("TASK-WF-TRACE");
    expect(childSpan.attributes["bosun.workflow.parent_run_id"]).toBe(parentCtx.id);
  }, SLOW_WORKFLOW_ENGINE_TRACE_TIMEOUT_MS);
  it("records DAGState revisions and preserves completed nodes when replanning from a failed boundary", async () => {
    let attempts = 0;
    registerNodeType("test.replan_once", {
      describe: () => "Fails once so retry planning can revise the active DAG",
      schema: { type: "object", properties: {} },
      async execute() {
        attempts += 1;
        if (attempts === 1) throw new Error("validation failed: tests red");
        return { ok: true };
      },
    });

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "build", type: "test.replan_once", label: "Build", config: { maxRetries: 0 } },
        { id: "verify", type: "test.replan_once", label: "Verify", config: { maxRetries: 0 } },
      ],
      [
        { id: "e1", source: "trigger", target: "build" },
        { id: "e2", source: "build", target: "verify" },
      ],
      { autoRetry: { enabled: false } },
    );

    engine.save(wf);
    const firstCtx = await engine.execute(wf.id, {});
    expect(firstCtx.errors.length).toBeGreaterThan(0);
    const firstRun = engine.getRunHistory(wf.id).at(-1);
    expect(firstRun?.detail?.dagState?.status).toBe("failed");
    expect(firstRun?.detail?.issueAdvisor?.recommendedAction).toBe("replan_from_failed");

    const retry = await engine.retryRun(firstRun.runId, { mode: "from_failed" });
    expect(retry.mode).toBe("from_failed");

    const runs = engine.getRunHistory(wf.id);
    const retriedRun = runs.find((entry) => entry.runId === retry.retryRunId);
    expect(retriedRun?.detail?.dagState?.retryOf).toBe(firstRun.runId);
    expect(retriedRun?.detail?.dagState?.retryMode).toBe("from_failed");
    expect(retriedRun?.detail?.dagState?.revisions?.length).toBeGreaterThanOrEqual(2);

    const [initialRevision, replanRevision] = retriedRun.detail.dagState.revisions;
    expect(initialRevision.reason).toBe("retry_resume");
    expect(replanRevision.reason).toBe("retry_replan_from_failed");
    expect(initialRevision.counts.completed).toBe(1);
    expect(replanRevision.counts.completed).toBe(1);
    expect(replanRevision.preservedCompletedNodeIds).toContain("trigger");
    expect(replanRevision.focusNodeIds).toContain("build");
    expect(Array.isArray(replanRevision.graphAfter?.nodes)).toBe(true);
    expect(Array.isArray(replanRevision.graphAfter?.edges)).toBe(true);
    expect(replanRevision.graphAfter?.edges?.[0]?.source).toBe("trigger");
    expect(retriedRun.detail.issueAdvisor.recommendedAction).toBe("continue");

    const diff = engine.diffRunGraphs(firstRun.runId, retry.retryRunId);
    expect(diff?.baseRunId).toBe(firstRun.runId);
    expect(diff?.comparisonRunId).toBe(retry.retryRunId);
    expect(diff?.executionDelta?.changed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionKey: "node:build",
          executionKind: "node",
          nodeId: "build",
          baseStatus: NodeStatus.FAILED,
          comparisonStatus: NodeStatus.COMPLETED,
        }),
      ]),
    );
  });
  it("hydrates delegation audit trail into run detail and history read models", async () => {
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
      ],
      [],
      { id: "wf-delegation-audit", name: "Delegation Audit Workflow" },
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, { taskId: "TASK-DELEGATION-AUDIT" });
    ctx.data._workflowRootTaskId = "TASK-DELEGATION-AUDIT";
    ctx.data._workflowParentTaskId = "TASK-DELEGATION-AUDIT";
    ctx.data._workflowSessionId = "TASK-DELEGATION-AUDIT:delegate:run-1";
    ctx.data._workflowRootSessionId = "TASK-DELEGATION-AUDIT";
    ctx.data._workflowParentSessionId = "TASK-DELEGATION-AUDIT";
    ctx.data._workflowDelegationDepth = 1;
    ctx.data._delegatedSessionIds = ["TASK-DELEGATION-AUDIT:delegate:run-1"];
    ctx.__workflowRuntimeState = ctx.__workflowRuntimeState || {};
    ctx.__workflowRuntimeState.delegationAuditTrail = [
      {
        type: "assign",
        key: "assign:TASK-DELEGATION-AUDIT:agent-1",
        taskId: "TASK-DELEGATION-AUDIT",
        agentId: "agent-1",
        timestamp: 1710000000000,
      },
      {
        type: "handoff-complete",
        key: "handoff-complete:TASK-DELEGATION-AUDIT:agent-1",
        taskId: "TASK-DELEGATION-AUDIT",
        agentId: "agent-1",
        timestamp: 1710000001000,
      },
    ];

    engine._persistRun(ctx.id, wf.id, ctx);

    const detail = engine.getRunDetail(ctx.id);
    const historyEntry = engine.getRunHistory(wf.id).find((entry) => entry.runId === ctx.id);

    expect(detail?.detail?.delegationAuditTrail).toEqual([
      expect.objectContaining({ type: "assign", taskId: "TASK-DELEGATION-AUDIT" }),
      expect.objectContaining({ type: "handoff-complete", taskId: "TASK-DELEGATION-AUDIT" }),
    ]);
    expect(detail?.delegationTopology).toEqual(expect.objectContaining({
      runId: ctx.id,
      rootRunId: ctx.id,
      taskId: "TASK-DELEGATION-AUDIT",
      rootTaskId: "TASK-DELEGATION-AUDIT",
      parentTaskId: "TASK-DELEGATION-AUDIT",
      sessionId: "TASK-DELEGATION-AUDIT:delegate:run-1",
      rootSessionId: "TASK-DELEGATION-AUDIT",
      parentSessionId: "TASK-DELEGATION-AUDIT",
      delegationDepth: 1,
      sessionIds: expect.arrayContaining(["TASK-DELEGATION-AUDIT:delegate:run-1", "TASK-DELEGATION-AUDIT"]),
    }));
    expect(detail?.detail?.data?._delegationTopology).toEqual(expect.objectContaining({
      taskId: "TASK-DELEGATION-AUDIT",
      sessionId: "TASK-DELEGATION-AUDIT:delegate:run-1",
    }));
    expect(historyEntry?.delegationAuditTrail).toEqual([
      expect.objectContaining({ type: "assign", taskId: "TASK-DELEGATION-AUDIT" }),
      expect.objectContaining({ type: "handoff-complete", taskId: "TASK-DELEGATION-AUDIT" }),
    ]);
    expect(historyEntry?.delegationTopology).toEqual(expect.objectContaining({
      taskId: "TASK-DELEGATION-AUDIT",
      rootTaskId: "TASK-DELEGATION-AUDIT",
      sessionId: "TASK-DELEGATION-AUDIT:delegate:run-1",
      rootSessionId: "TASK-DELEGATION-AUDIT",
      parentSessionId: "TASK-DELEGATION-AUDIT",
      delegationDepth: 1,
    }));
  });

  it("compacts run detail when direct serialization throws invalid string length", () => {
    const detail = {
      id: "run-invalid-string-length",
      startedAt: Date.now(),
      status: WorkflowStatus.RUNNING,
      data: {
        taskId: "TASK-INVALID-STRING-LENGTH",
        branchName: "task/TASK-INVALID-STRING-LENGTH",
        hugeContext: "x".repeat(4096),
      },
      nodeStatuses: {
        trigger: NodeStatus.COMPLETED,
        "write-tests": NodeStatus.RUNNING,
      },
      nodeOutputs: {
        "write-tests": {
          logs: ["log entry"],
          result: {
            hugePayload: "y".repeat(4096),
          },
        },
      },
      errors: [],
      issueAdvisor: {
        summary: "Resume from Write Tests First.",
      },
    };
    const realStringify = JSON.stringify.bind(JSON);
    const stringifySpy = vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
      if (value === detail) {
        throw new RangeError("Invalid string length");
      }
      return realStringify(value, replacer, space);
    });

    try {
      const trimmed = engine._trimOversizedRunDetail(detail);

      expect(trimmed).toEqual(expect.objectContaining({
        id: "run-invalid-string-length",
        status: WorkflowStatus.RUNNING,
        data: expect.objectContaining({
          taskId: "TASK-INVALID-STRING-LENGTH",
          branchName: "task/TASK-INVALID-STRING-LENGTH",
        }),
        _truncated: expect.objectContaining({
          notes: expect.arrayContaining(["detail: compacted after serialization failure"]),
        }),
      }));
      expect(trimmed).not.toBe(detail);
    } finally {
      stringifySpy.mockRestore();
    }
  });

  it("hydrates workflow team state into run detail and history read models", async () => {
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "team-init",
          type: "action.team_init",
          config: {
            teamId: "workflow-team-1",
            leadId: "lead-1",
            members: [{ memberId: "dev-1", role: "worker" }],
          },
        },
        {
          id: "publish",
          type: "action.team_task_publish",
          config: {
            title: "Review API contract",
            description: "Coordinate the API review inside the workflow team.",
            createdBy: "lead-1",
          },
        },
        {
          id: "claim",
          type: "action.team_task_claim",
          config: {
            taskId: "{{publish.publishedTasks.0.taskId}}",
            memberId: "dev-1",
          },
        },
        {
          id: "message",
          type: "action.team_message",
          config: {
            fromMemberId: "dev-1",
            toMemberId: "lead-1",
            taskId: "{{publish.publishedTasks.0.taskId}}",
            content: "Claimed the review task and started work.",
          },
        },
        {
          id: "inbox",
          type: "action.team_inbox",
          config: {
            memberId: "lead-1",
            markRead: true,
          },
        },
        {
          id: "complete",
          type: "action.team_task_complete",
          config: {
            taskId: "{{publish.publishedTasks.0.taskId}}",
            memberId: "dev-1",
          },
        },
        { id: "snapshot", type: "action.team_snapshot", config: {} },
      ],
      [
        { source: "trigger", target: "team-init" },
        { source: "team-init", target: "publish" },
        { source: "publish", target: "claim" },
        { source: "claim", target: "message" },
        { source: "message", target: "inbox" },
        { source: "inbox", target: "complete" },
        { source: "complete", target: "snapshot" },
      ],
      { id: "wf-team-coordination", name: "Workflow Team Coordination" },
    );

    engine.save(wf);
    const ctx = await engine.execute(wf.id, {});
    const snapshot = ctx.getNodeOutput("snapshot");
    expect(ctx.errors).toEqual([]);
    expect(ctx.getNodeOutput("claim")).toEqual(expect.objectContaining({ claimed: true }));
    expect(ctx.getNodeOutput("inbox").messages).toHaveLength(1);
    expect(snapshot.teamSummary.completedTaskCount).toBe(1);
    expect(snapshot.state.messages).toHaveLength(1);

    const detail = engine.getRunDetail(ctx.id);
    expect(detail?.workflowTeamState).toEqual(expect.objectContaining({
      teamId: "workflow-team-1",
      leadId: "lead-1",
    }));
    expect(detail?.teamSummary).toEqual(expect.objectContaining({
      rosterCount: 2,
      completedTaskCount: 1,
      messageCount: 1,
    }));
    expect(detail?.detail?.data?._workflowTeamState?.tasks?.[0]).toEqual(
      expect.objectContaining({
        status: "completed",
        claimedBy: "dev-1",
        completedBy: "dev-1",
      }),
    );
    expect(detail?.detail?.data?._workflowTeamState?.messages?.[0]).toEqual(
      expect.objectContaining({
        kind: "direct",
        fromMemberId: "dev-1",
      }),
    );

    const historyEntry = engine.getRunHistory(wf.id).find((entry) => entry.runId === ctx.id);
    expect(historyEntry?.teamSummary).toEqual(expect.objectContaining({
      teamId: "workflow-team-1",
      completedTaskCount: 1,
      messageCount: 1,
    }));
  });

  it("distinguishes rerun, fix-step, and subgraph replan retry decisions", () => {
    const rerun = engine._chooseRetryModeFromDetail({
      issueAdvisor: { recommendedAction: "resume_remaining", summary: "Resume from verify." },
      dagState: { counts: { completed: 2, failed: 0, pending: 1 } },
    });
    expect(rerun.mode).toBe("from_failed");
    expect(rerun.reason).toBe("issue_advisor.resume_remaining");
    expect(rerun.suggestedRetryMode).toBe("from_failed");

    const rerunSameStep = engine._chooseRetryModeFromDetail({
      issueAdvisor: { recommendedAction: "rerun_same_step", summary: "Rerun the timed out test step." },
      dagState: { counts: { completed: 2, failed: 1, pending: 0 } },
    });
    expect(rerunSameStep.mode).toBe("from_failed");
    expect(rerunSameStep.reason).toBe("issue_advisor.rerun_same_step");

    const fixStep = engine._chooseRetryModeFromDetail({
      issueAdvisor: {
        recommendedAction: "spawn_fix_step",
        summary: "Add a targeted fix step before retrying verify.",
      },
      dagState: { counts: { completed: 2, failed: 1, pending: 0 } },
    });
    expect(fixStep.mode).toBe("from_failed");
    expect(fixStep.reason).toBe("issue_advisor.spawn_fix_step");

    const replan = engine._chooseRetryModeFromDetail({
      issueAdvisor: { recommendedAction: "replan_subgraph", summary: "Replan downstream nodes." },
      dagState: { counts: { completed: 1, failed: 1, pending: 2 } },
    });
    expect(replan.mode).toBe("replan_subgraph");
    expect(replan.reason).toBe("issue_advisor.replan_subgraph");
  });
});





describe("delegation audit trail hydration", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("hydrates persisted delegation trail into run detail and history", async () => {
    const runId = "delegation-hydration-run";
    const detailPath = join(tmpDir, "runs", `${runId}.json`);
    mkdirSync(join(tmpDir, "runs"), { recursive: true });
    writeFileSync(detailPath, JSON.stringify({
      data: {
        _workflowId: "wf-delegation-history",
        _workflowName: "Delegation History Workflow",
        _workflowDelegationTrail: [
          {
            type: "assign",
            nodeId: "delegate",
            workflowId: "child-wf",
            workflowName: "Child Workflow",
            transitionKey: "assign:delegate:child-wf:task-1",
            timestamp: "2026-03-25T00:00:00.000Z",
          },
          {
            type: "handoff-complete",
            nodeId: "delegate",
            workflowId: "child-wf",
            workflowName: "Child Workflow",
            childRunId: "child-run-1",
            transitionKey: "handoff-complete:delegate:child-run-1",
            timestamp: "2026-03-25T00:00:02.000Z",
          },
        ],
        _delegationTransitionGuards: {
          "assign:delegate:child-wf:task-1": {
            transitionKey: "assign:delegate:child-wf:task-1",
            type: "assign",
            status: "completed",
            claimToken: "claim-history",
          },
        },
      },
      nodeStatuses: {},
      nodeOutputs: {},
      errors: [],
      status: "completed",
      startedAt: 1742860800000,
      endedAt: 1742860802000,
    }, null, 2));

    const detail = engine.getRunDetail(runId);
    expect(detail?.delegationTrail).toEqual([
      expect.objectContaining({ type: "assign", transitionKey: "assign:delegate:child-wf:task-1" }),
      expect.objectContaining({ type: "handoff-complete", transitionKey: "handoff-complete:delegate:child-run-1" }),
    ]);
    expect(detail?.delegationAuditTrail).toEqual(detail?.delegationTrail);
    expect(detail?.latestDelegationEvent).toEqual(expect.objectContaining({ type: "handoff-complete" }));
    expect(detail?.detail?.data?._workflowDelegationTrail).toHaveLength(2);
    expect(detail?.delegationTransitionGuards).toMatchObject({
      "assign:delegate:child-wf:task-1": expect.objectContaining({
        type: "assign",
        claimToken: "claim-history",
      }),
    });
    expect(detail?.detail?.data?._delegationTransitionGuards).toMatchObject({
      "assign:delegate:child-wf:task-1": expect.objectContaining({
        type: "assign",
        claimToken: "claim-history",
      }),
    });

    const history = engine.getRunHistory(null, 20);
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId,
        delegationTrail: expect.arrayContaining([
          expect.objectContaining({ type: "assign" }),
          expect.objectContaining({ type: "handoff-complete" }),
        ]),
        delegationAuditTrail: expect.arrayContaining([
          expect.objectContaining({ type: "assign" }),
          expect.objectContaining({ type: "handoff-complete" }),
        ]),
        latestDelegationEvent: expect.objectContaining({ type: "handoff-complete" }),
        delegationTransitionGuards: expect.objectContaining({
          "assign:delegate:child-wf:task-1": expect.objectContaining({ type: "assign" }),
        }),
      }),
    ]));
  });
});
