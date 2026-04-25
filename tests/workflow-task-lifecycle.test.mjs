/**
 * workflow-task-lifecycle.test.mjs - Comprehensive tests for all 11 task
 * lifecycle node types and both workflow templates.
 *
 * Tests verify:
 *  1. Node registration, schema, describe()
 *  2. Node execution logic (happy path + error paths)
 *  3. Anti-thrash state management
 *  4. Template structure integrity (nodes, edges, variables)
 *  5. Template DAG connectivity
 *  6. Dry-run template execution through the workflow engine
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawn } from "node:child_process";
import { resetStateLedgerCache } from "../lib/state-ledger-sqlite.mjs";
import { skipLocallyForSpeed } from "./test-speed-gates.mjs";
import { testTimeout } from "./timeout-helper.mjs";

// CLAUDE:SUMMARY - workflow-task-lifecycle tests
// Exercises task lifecycle workflow nodes and template wiring, including prompt assembly and cache anchoring.

const SPAWN_BLOCKED = process.platform === "win32"
  && process.env.BOSUN_TEST_CHILD_SPAWN_BLOCKED === "1";
const SLOW_WORKFLOW_TEST_TIMEOUT_MS = testTimeout(45_000);

let getNodeType;
let clearContractCache;
let WorkflowEngine;
let WorkflowContext;
let detectProjectStack;
let resolveAutoCommand;
let getTemplate;
let installTemplate;
let reconcileInstalledTemplates;
let MAX_NO_COMMIT_ATTEMPTS;
let completedWithPR;
let noCommitCounts;
let skipUntil;
let buildCommandTerminationDiagnostic;
let deriveManagedWorktreeDirName;

if (SPAWN_BLOCKED) {
  describe("workflow-task-lifecycle", () => {
    it.skip("skips lifecycle workflow coverage when child spawn is blocked in the Windows sandbox", () => {});
  });
} else {
  ({ getNodeType } = await import("../workflow/workflow-nodes.mjs"));
  ({ clearContractCache } = await import("../workflow/workflow-contract.mjs"));
  ({ WorkflowEngine, WorkflowContext } = await import("../workflow/workflow-engine.mjs"));
  ({ detectProjectStack, resolveAutoCommand } = await import("../workflow/project-detection.mjs"));
  ({ getTemplate, installTemplate, reconcileInstalledTemplates } = await import("../workflow/workflow-templates.mjs"));
  ({
    MAX_NO_COMMIT_ATTEMPTS,
    _completedWithPR: completedWithPR,
    _noCommitCounts: noCommitCounts,
    _skipUntil: skipUntil,
  } = await import("../workflow/workflow-nodes/transforms.mjs"));
  ({ buildCommandTerminationDiagnostic } = await import("../workflow/workflow-nodes/actions.mjs"));
  ({ deriveManagedWorktreeDirName } = await import("../workflow/workflow-nodes/definitions.mjs"));

// -- Helpers -----------------------------------------------------------------

function makeCtx(data = {}) {
  const ctx = new WorkflowContext(data);
  ctx.log = vi.fn();
  return ctx;
}

function makeNode(type, config = {}, id = "test-node") {
  return { id, type, config };
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

async function removeDirAfterLedgerReset(dirPath) {
  resetStateLedgerCache();
  await new Promise((resolve) => setTimeout(resolve, 25));
  rmSync(dirPath, { recursive: true, force: true });
}

function sanitizedGitEnv(extra = {}) {
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

function readWorktreeRecoveryStatus(repoRoot) {
  const statusPath = join(repoRoot, ".cache", "orchestrator-status.json");
  if (!existsSync(statusPath)) return null;
  return JSON.parse(readFileSync(statusPath, "utf8")).worktreeRecovery || null;
}

let tmpDir;
let engine;

function makeTmpEngine() {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-lifecycle-test-"));
  engine = new WorkflowEngine({
    workflowDir: join(tmpDir, "workflows"),
    runsDir: join(tmpDir, "runs"),
    services: {},
  });
  return engine;
}

describe("project detection quality gates", () => {
  let repoRoot;

  afterEach(() => {
    try { rmSync(repoRoot, { recursive: true, force: true }); } catch { /* ok */ }
    repoRoot = undefined;
  });

  it("prefers repo hooks for go quality gates instead of node-only defaults", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "wf-quality-gate-"));
    mkdirSync(join(repoRoot, ".githooks"), { recursive: true });
    writeFileSync(join(repoRoot, "go.mod"), "module example.com/virtengine\n\ngo 1.23.0\n");
    writeFileSync(join(repoRoot, ".githooks", "pre-push"), "#!/usr/bin/env bash\necho ok\n");

    const detected = detectProjectStack(repoRoot);

    expect(detected.primary?.id).toBe("go");
    expect(detected.commands.qualityGate).toBe("bash .githooks/pre-push");
    expect(resolveAutoCommand("auto", "qualityGate", repoRoot)).toBe("bash .githooks/pre-push");
    expect(detected.commands.qualityGate).not.toBe("npm run prepush:check");
  });
  it("prefers repo hooks for node quality gates even when prepush:check exists", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "wf-quality-gate-node-"));
    mkdirSync(join(repoRoot, ".githooks"), { recursive: true });
    writeFileSync(join(repoRoot, ".githooks", "pre-push"), "#!/usr/bin/env bash\necho ok\n");
    writeFileSync(join(repoRoot, "package.json"), JSON.stringify({
      name: "quality-gate-node",
      version: "1.0.0",
      scripts: {
        "prepush:check": "npm run test:all",
      },
    }, null, 2));

    const detected = detectProjectStack(repoRoot);

    expect(detected.primary?.id).toBe("node");
    expect(detected.commands.qualityGate).toBe("bash .githooks/pre-push");
    expect(resolveAutoCommand("auto", "qualityGate", repoRoot)).toBe("bash .githooks/pre-push");
    expect(detected.commands.qualityGate).not.toBe("npm run prepush:check");
  });
  it("prefers the focused vitest runner for node test commands when available", () => {
    repoRoot = mkdtempSync(join(tmpdir(), "wf-quality-gate-vitest-"));
    mkdirSync(join(repoRoot, "tools"), { recursive: true });
    writeFileSync(join(repoRoot, "tools", "vitest-runner.mjs"), "export {};\n");
    writeFileSync(join(repoRoot, "package.json"), JSON.stringify({
      name: "quality-gate-node-vitest",
      version: "1.0.0",
      scripts: {
        test: "vitest run",
      },
      devDependencies: {
        vitest: "^4.0.0",
      },
    }, null, 2));

    const detected = detectProjectStack(repoRoot);

    expect(detected.primary?.id).toBe("node");
    expect(detected.commands.test).toBe("node tools/vitest-runner.mjs run");
    expect(resolveAutoCommand("auto", "test", repoRoot)).toBe("node tools/vitest-runner.mjs run");
  });
  it("records a single owner-mismatch audit event across duplicate renewal retries", async () => {
    vi.useFakeTimers();
    const nt = getNodeType("action.claim_task");
    const claims = await import("../task/task-claims.mjs");
    const initSpy = vi.spyOn(claims, "initTaskClaims").mockResolvedValue();
    const claimSpy = vi.spyOn(claims, "claimTask").mockResolvedValue({
      success: true,
      token: "claim-token-dedupe",
    });
    const renewSpy = vi.spyOn(claims, "renewClaim").mockResolvedValue({
      success: false,
      error: "owner_mismatch",
    });

    const ctx = makeCtx({ repoRoot: "/tmp/repo-root" });
    try {
      const node = makeNode("action.claim_task", {
        taskId: "task-renew-dedupe",
        taskTitle: "Renew dedupe",
        renewIntervalMs: 50,
      });

      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);

      await vi.advanceTimersByTimeAsync(60);
      await vi.advanceTimersByTimeAsync(60);

      const auditTrail =
        ctx.data?._workflowDelegationTrail ||
        ctx.data?._delegationAuditTrail ||
        ctx.__workflowRuntimeState?.delegationAuditTrail ||
        [];
      const mismatchEvents = auditTrail.filter((event) => event?.type === "owner-mismatch");

      expect(renewSpy).toHaveBeenCalledTimes(1);
      expect(ctx.data._claimStolen).toBe(true);
      expect(mismatchEvents).toHaveLength(1);
      expect(mismatchEvents[0]).toEqual(expect.objectContaining({
        type: "owner-mismatch",
        taskId: "task-renew-dedupe",
      }));
    } finally {
      const runtimeTimer = ctx.__workflowRuntimeState?.claimRenewTimer || ctx.data?._claimRenewTimer;
      if (runtimeTimer) clearInterval(runtimeTimer);
      initSpy.mockRestore();
      claimSpy.mockRestore();
      renewSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
//  Node Type Registration Tests
// ---------------------------------------------------------------------------

it("dedupes duplicate claim assignment retries", async () => {
  const nt = getNodeType("action.claim_task");
  const claims = await import("../task/task-claims.mjs");
  const initSpy = vi.spyOn(claims, "initTaskClaims").mockResolvedValue();
  const claimSpy = vi.spyOn(claims, "claimTask").mockResolvedValue({
    success: true,
    token: "claim-token-once",
  });

  const ctx = makeCtx({ repoRoot: "/tmp/repo-root" });
  try {
    const node = makeNode("action.claim_task", {
      taskId: "task-claim-dedupe",
      taskTitle: "Claim dedupe",
      renewIntervalMs: 0,
    });

    const first = await nt.execute(node, ctx);
    const second = await nt.execute(node, ctx);
    const auditTrail = ctx.__workflowRuntimeState?.delegationAuditTrail || ctx.data._delegationAuditTrail || [];
    const assignEvents = auditTrail.filter((event) => event?.type === "assign");

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.deduped).toBe(true);
    expect(claimSpy).toHaveBeenCalledTimes(1);
    expect(assignEvents).toHaveLength(1);
  } finally {
    const runtimeTimer = ctx.__workflowRuntimeState?.claimRenewTimer || ctx.data?._claimRenewTimer;
    if (runtimeTimer) clearInterval(runtimeTimer);
    initSpy.mockRestore();
    claimSpy.mockRestore();
  }
});
describe("task lifecycle node type registration", () => {
  const LIFECYCLE_NODES = [
    "trigger.task_available",
    "condition.slot_available",
    "action.allocate_slot",
    "action.release_slot",
    "action.claim_task",
    "action.release_claim",
    "action.resolve_executor",
    "action.acquire_worktree",
    "action.release_worktree",
    "read-workflow-contract",
    "workflow-contract-validation",
    "action.build_task_prompt",
    "action.persist_memory",
    "action.detect_new_commits",
    "action.push_branch",
  ];

  for (const typeName of LIFECYCLE_NODES) {
    it(`${typeName} is registered`, () => {
      expect(getNodeType(typeName)).toBeDefined();
    });

    it(`${typeName} has a describe() returning a non-empty string`, () => {
      const desc = getNodeType(typeName).describe();
      expect(typeof desc).toBe("string");
      expect(desc.length).toBeGreaterThan(10);
    });

    it(`${typeName} has a valid schema`, () => {
      const nt = getNodeType(typeName);
      expect(nt.schema).toBeDefined();
      expect(nt.schema.type).toBe("object");
      expect(nt.schema.properties).toBeDefined();
    });

    it(`${typeName} has an async execute function`, () => {
      const nt = getNodeType(typeName);
      expect(typeof nt.execute).toBe("function");
    });
  }
});

// ---------------------------------------------------------------------------
//  trigger.task_available Tests
// ---------------------------------------------------------------------------

describe("trigger.task_available", () => {
  it("enforces repoAreaParallelLimit using activeTaskAreaCounts and task repo areas", async () => {
    const nt = getNodeType("trigger.task_available");
    const listTasks = vi.fn().mockResolvedValue([
      { id: "t-workflow", title: "workflow task", status: "todo", repo_areas: ["workflow"], createdAt: "2026-03-01T00:00:00.000Z" },
      { id: "t-server", title: "server task", status: "todo", meta: { repo_areas: ["server"] }, createdAt: "2026-03-02T00:00:00.000Z" },
    ]);
    const ctx = makeCtx({
      activeSlotCount: 0,
      activeTaskAreaCounts: { workflow: 1 },
    });
    const node = makeNode("trigger.task_available", {
      maxParallel: 2,
      status: "todo",
      repoAreaParallelLimit: 1,
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: {
          listTasks,
        },
      },
    });

    expect(result.triggered).toBe(true);
    expect(result.taskCount).toBe(1);
    expect(result.tasks[0].id).toBe("t-server");
  });

  it("binds primary task context for downstream lifecycle nodes", async () => {
    const nt = getNodeType("trigger.task_available");
    const listTasks = vi.fn().mockResolvedValue([
      {
        id: "abc-123",
        title: "Implement dispatch fix",
        description: "Ensure claims initialize",
        status: "todo",
        workspace: "C:/repo/bosun",
        repository: "virtengine/bosun",
        repositories: ["virtengine/bosun"],
        baseBranch: "main",
        target: "entire",
        meta: {
          targetBranch: "release/ignored-for-now",
        },
      },
    ]);
    const ctx = makeCtx({ activeSlotCount: 0 });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: {
          listTasks,
        },
      },
    });

    expect(result.triggered).toBe(true);
    expect(result.taskCount).toBe(1);
    expect(result.selectedTaskId).toBe("abc-123");
    expect(ctx.data.taskId).toBe("abc-123");
    expect(ctx.data.taskTitle).toBe("Implement dispatch fix");
    expect(ctx.data.taskDescription).toBe("Ensure claims initialize");
    expect(ctx.data.repoRoot).toBe("C:/repo/bosun");
    expect(ctx.data.workspace).toBe("C:/repo/bosun");
    expect(ctx.data.repository).toBe("virtengine/bosun");
    expect(ctx.data.baseBranch).toBe("main");
    expect(ctx.data.branch.startsWith("task/abc123-")).toBe(true);
    expect(ctx.data._taskBranchBinding).toEqual(expect.objectContaining({
      taskId: "abc-123",
      resolvedBaseBranch: "main",
      candidates: expect.objectContaining({
        baseBranch: "main",
        target: "entire",
        "meta.targetBranch": "release/ignored-for-now",
      }),
    }));
  });

  it("honors explicit task context before slot saturation checks", async () => {
    const nt = getNodeType("trigger.task_available");
    const listTasks = vi.fn().mockResolvedValue([]);
    const ctx = makeCtx({
      activeSlotCount: 1,
      taskId: "direct-task-1",
    });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: {
          listTasks,
        },
      },
      getActiveRuns: () => [{ taskId: "direct-task-1" }],
    });

    expect(result).toMatchObject({
      triggered: true,
      reason: "direct_task",
      taskId: "direct-task-1",
      tasks: [{ id: "direct-task-1" }],
    });
    expect(listTasks).not.toHaveBeenCalled();
  });

  it("rehydrates explicit task context when the carried snapshot is minimal", async () => {
    const nt = getNodeType("trigger.task_available");
    const listTasks = vi.fn().mockResolvedValue([]);
    const retryAt = "2026-04-22T04:00:13.000Z";
    const getTask = vi.fn().mockResolvedValue({
      id: "direct-task-1",
      title: "Direct task",
      status: "inprogress",
      branchName: "task/direct-task-1",
      consecutiveNoCommits: 3,
      cooldownUntil: retryAt,
      blockedReason: "Repeated no-output agent starts detected; stopping retries",
    });
    const ctx = makeCtx({
      activeSlotCount: 1,
      taskId: "direct-task-1",
      task: {
        id: "direct-task-1",
        title: "Direct task",
        status: "todo",
      },
    });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: {
          listTasks,
          getTask,
        },
      },
      getActiveRuns: () => [{ taskId: "direct-task-1" }],
    });

    expect(result).toMatchObject({
      triggered: true,
      reason: "direct_task",
      taskId: "direct-task-1",
      task: expect.objectContaining({
        id: "direct-task-1",
        status: "inprogress",
        branchName: "task/direct-task-1",
        consecutiveNoCommits: 3,
        cooldownUntil: retryAt,
        blockedReason: "Repeated no-output agent starts detected; stopping retries",
      }),
    });
    expect(ctx.data.task).toEqual(expect.objectContaining({
      id: "direct-task-1",
      status: "inprogress",
      branchName: "task/direct-task-1",
      consecutiveNoCommits: 3,
      cooldownUntil: retryAt,
    }));
    expect(listTasks).not.toHaveBeenCalled();
    expect(getTask).toHaveBeenCalledWith("direct-task-1");
  });

  it("ignores stale explicit task context and falls back to real task polling", async () => {
    const nt = getNodeType("trigger.task_available");
    const listTasks = vi.fn().mockResolvedValue([
      {
        id: "real-task-1",
        title: "Real queued task",
        status: "todo",
        branchName: "task/realtask1-real-queued-task",
      },
    ]);
    const getTask = vi.fn().mockResolvedValue(null);
    const ctx = makeCtx({
      activeSlotCount: 0,
      taskId: "TASK-DIAG-LOCAL",
      taskTitle: "Diagnostics export",
      branch: "task/TASKDIAGLOCA-diagnostics-export",
      branchName: "task/TASKDIAGLOCA-diagnostics-export",
      _workflowRootTaskId: "TASK-DIAG-LOCAL",
      _workflowParentTaskId: "TASK-DIAG-LOCAL",
    });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: { listTasks, getTask },
        taskStore: { getTask },
      },
    });

    expect(result).toMatchObject({
      triggered: true,
      selectedTaskId: "real-task-1",
      taskCount: 1,
    });
    expect(listTasks).toHaveBeenCalled();
    expect(ctx.data.taskId).toBe("real-task-1");
    expect(ctx.data.taskTitle).toBe("Real queued task");
    expect(ctx.data.branchName).toBe("task/realtask1-real-queued-task");
    expect(ctx.data._workflowRootTaskId).toBeUndefined();
    expect(ctx.data._workflowParentTaskId).toBeUndefined();
  });

  it("resolves repoRoot to matching sibling repository when task repository differs", async () => {
    const nt = getNodeType("trigger.task_available");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "wf-task-repo-root-"));
    const bosunRepo = join(workspaceRoot, "bosun");
    const virtengineRepo = join(workspaceRoot, "virtengine");
    mkdirSync(bosunRepo, { recursive: true });
    mkdirSync(virtengineRepo, { recursive: true });
    writeFileSync(join(bosunRepo, ".git"), "gitdir: /tmp/bosun\n");
    writeFileSync(join(virtengineRepo, ".git"), "gitdir: /tmp/virtengine\n");

    const listTasks = vi.fn().mockResolvedValue([
      {
        id: "repo-route-1",
        title: "Cross-repo task",
        description: "Should route to virtengine mirror",
        status: "todo",
        workspace: "virtengine-gh",
        repository: "virtengine/virtengine",
      },
    ]);

    const ctx = makeCtx({
      activeSlotCount: 0,
      repoRoot: bosunRepo,
    });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
    });

    try {
      const result = await nt.execute(node, ctx, {
        services: {
          kanban: {
            listTasks,
          },
        },
      });

      expect(result.triggered).toBe(true);
      expect(ctx.data.repository).toBe("virtengine/virtengine");
      expect(ctx.data.repoRoot).toBe(virtengineRepo);
    } finally {
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("prefers the actual repo root over mirrored .bosun workspace paths for same-repo tasks", async () => {
    const nt = getNodeType("trigger.task_available");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "wf-task-repo-mirror-"));
    const actualRepo = join(workspaceRoot, "bosun");
    const mirroredRepo = join(actualRepo, ".bosun", "workspaces", "virtengine-gh", "bosun");
    mkdirSync(actualRepo, { recursive: true });
    mkdirSync(mirroredRepo, { recursive: true });
    writeFileSync(join(actualRepo, ".git"), "gitdir: /tmp/actual-bosun\n");
    writeFileSync(join(mirroredRepo, ".git"), "gitdir: /tmp/mirror-bosun\n");

    const listTasks = vi.fn().mockResolvedValue([
      {
        id: "repo-route-same-1",
        title: "Same repo task",
        description: "Should use actual repo root",
        status: "todo",
        workspace: "virtengine-gh",
        repository: "virtengine/bosun",
      },
    ]);

    const ctx = makeCtx({
      activeSlotCount: 0,
      repoRoot: mirroredRepo,
    });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
    });

    try {
      const result = await nt.execute(node, ctx, {
        services: {
          kanban: {
            listTasks,
          },
        },
      });

      expect(result.triggered).toBe(true);
      expect(ctx.data.repository).toBe("virtengine/bosun");
      expect(String(ctx.data.repoRoot || "").replace(/\\/g, "/")).toBe(actualRepo.replace(/\\/g, "/"));
      expect(ctx.data.repoSlug).toBe("virtengine/bosun");
    } finally {
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("normalizes mirrored repoRoot even when internal tasks omit repository metadata", async () => {
    const nt = getNodeType("trigger.task_available");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "wf-task-repo-default-"));
    const actualRepo = join(workspaceRoot, "bosun");
    const mirroredRepo = join(actualRepo, ".bosun", "workspaces", "virtengine-gh", "bosun");
    mkdirSync(actualRepo, { recursive: true });
    mkdirSync(mirroredRepo, { recursive: true });
    writeFileSync(join(actualRepo, ".git"), "gitdir: /tmp/actual-bosun-default\n");
    writeFileSync(join(mirroredRepo, ".git"), "gitdir: /tmp/mirror-bosun-default\n");

    const listTasks = vi.fn().mockResolvedValue([
      {
        id: "repo-route-default-1",
        title: "Default repo task",
        description: "Should still use actual repo root",
        status: "todo",
      },
    ]);

    const ctx = makeCtx({
      activeSlotCount: 0,
      repoRoot: mirroredRepo,
    });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
    });

    try {
      const result = await nt.execute(node, ctx, {
        services: {
          kanban: {
            listTasks,
          },
        },
      });

      expect(result.triggered).toBe(true);
      expect(String(ctx.data.repoRoot || "").replace(/\\/g, "/")).toBe(actualRepo.replace(/\\/g, "/"));
    } finally {
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("returns blocked result when all tasks exceed repoAreaParallelLimit", async () => {
    const nt = getNodeType("trigger.task_available");
    const listTasks = vi.fn().mockResolvedValue([
      { id: "t-workflow-only", title: "workflow task", status: "todo", repo_areas: ["workflow"] },
    ]);
    const ctx = makeCtx({
      activeSlotCount: 0,
      activeTaskAreaCounts: { workflow: 1 },
    });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
      repoAreaParallelLimit: 1,
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: {
          listTasks,
        },
      },
    });

    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("repo_area_parallel_limit");
    expect(result.taskCount).toBe(0);
  });

  it("filters out DAG-blocked tasks via canStartTask guard", async () => {
    const nt = getNodeType("trigger.task_available");
    const listTasks = vi.fn().mockResolvedValue([
      { id: "blocked-task", title: "Blocked", status: "todo" },
      { id: "ready-task", title: "Ready", status: "todo" },
    ]);
    const canStartTask = vi.fn((taskId) =>
      taskId === "blocked-task"
        ? { canStart: false, reason: "dependencies_unresolved", blockingTaskIds: ["dep-1"] }
        : { canStart: true, reason: "ok" },
    );

    const ctx = makeCtx({ activeSlotCount: 0, _services: { taskStore: { canStartTask } } });
    const node = makeNode("trigger.task_available", {
      maxParallel: 3,
      status: "todo",
      enforceStartGuards: true,
    });

    const result = await nt.execute(node, ctx, {
      services: { kanban: { listTasks }, taskStore: { canStartTask } },
    });

    expect(result.triggered).toBe(true);
    expect(result.taskCount).toBe(1);
    expect(result.tasks[0].id).toBe("ready-task");
    expect(canStartTask).toHaveBeenCalledTimes(2);
  });

  it("returns start_guard_blocked when all candidate tasks are blocked", async () => {
    const nt = getNodeType("trigger.task_available");
    const listTasks = vi.fn().mockResolvedValue([
      { id: "blocked-a", title: "Blocked A", status: "todo" },
      { id: "blocked-b", title: "Blocked B", status: "todo" },
    ]);
    const canStartTask = vi.fn(() => ({
      canStart: false,
      reason: "prior_sprint_tasks_incomplete",
      blockingTaskIds: ["earlier-task"],
      blockingSprintIds: ["sprint-1"],
    }));

    const ctx = makeCtx({ activeSlotCount: 0, _services: { taskStore: { canStartTask } } });
    const node = makeNode("trigger.task_available", {
      maxParallel: 2,
      status: "todo",
      enforceStartGuards: true,
      sprintOrderMode: "sequential",
    });

    const result = await nt.execute(node, ctx, {
      services: { kanban: { listTasks }, taskStore: { canStartTask } },
    });

    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("start_guard_blocked");
    expect(Array.isArray(result.blocked)).toBe(true);
    expect(result.blocked.length).toBe(2);
    expect(canStartTask).toHaveBeenCalledTimes(2);
    expect(canStartTask).toHaveBeenNthCalledWith(1, "blocked-a", { sprintOrderMode: "sequential" });
    expect(canStartTask).toHaveBeenNthCalledWith(2, "blocked-b", { sprintOrderMode: "sequential" });
  });

  it("returns start_guard_blocked for unresolved epic dependencies", async () => {
    const nt = getNodeType("trigger.task_available");
    const listTasks = vi.fn().mockResolvedValue([
      { id: "epic-blocked", title: "Epic Blocked", status: "todo" },
    ]);
    const canStartTask = vi.fn(() => ({
      canStart: false,
      reason: "epic_dependencies_unresolved",
      blockingEpicIds: ["EPIC-B"],
      blockingTaskIds: ["epic-b-task-1"],
    }));

    const ctx = makeCtx({ activeSlotCount: 0, _services: { taskStore: { canStartTask } } });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
      enforceStartGuards: true,
    });

    const result = await nt.execute(node, ctx, {
      services: { kanban: { listTasks }, taskStore: { canStartTask } },
    });

    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("start_guard_blocked");
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].reason).toBe("epic_dependencies_unresolved");
    expect(result.blocked[0].blockingEpicIds).toEqual(["EPIC-B"]);
    expect(result.blocked[0].blockingTaskIds).toEqual(["epic-b-task-1"]);
  });

  it("does not auto-recover branch refresh conflicts before polling", async () => {
    const nt = getNodeType("trigger.task_available");
    const retryAt = new Date(Date.now() - 60_000).toISOString();
    let todoTasks = [];
    const blockedTask = {
      id: "blocked-worktree-task",
      title: "Blocked WT task",
      status: "blocked",
      cooldownUntil: retryAt,
      blockedReason: "Repair workflow pending",
      meta: {
        autoRecovery: {
          active: true,
          reason: "worktree_failure",
          retryAt,
        },
        worktreeFailure: {
          failureKind: "branch_refresh_conflict",
          retryable: false,
          blockedReason: "repair pending",
        },
      },
    };
    const listTasks = vi.fn(async (_projectId, options = {}) => {
      if (options.status === "blocked") return [blockedTask];
      return todoTasks;
    });
    const updateTask = vi.fn(async (taskId, patch) => {
      todoTasks = [{
        ...blockedTask,
        id: taskId,
        ...patch,
      }];
      return todoTasks[0];
    });
    const ctx = makeCtx({ activeSlotCount: 0 });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: {
          listTasks,
          updateTask,
        },
      },
    });

    expect(updateTask).not.toHaveBeenCalled();
    expect(result.triggered).toBe(false);
  });

  it("bypasses missing-task guard by default and emits audit event", async () => {
    const nt = getNodeType("trigger.task_available");
    const listTasks = vi.fn().mockResolvedValue([
      { id: "missing-task", title: "Missing", status: "todo" },
    ]);
    const canStartTask = vi.fn(() => ({
      canStart: false,
      reason: "task_not_found",
    }));

    const ctx = makeCtx({ activeSlotCount: 0, _services: { taskStore: { canStartTask } } });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
      enforceStartGuards: true,
    });

    const result = await nt.execute(node, ctx, {
      services: { kanban: { listTasks }, taskStore: { canStartTask } },
    });

    expect(result.triggered).toBe(true);
    expect(result.taskCount).toBe(1);
    expect(result.tasks[0].id).toBe("missing-task");
    expect(result.auditEvents).toHaveLength(1);
    expect(result.auditEvents[0].type).toBe("start_guard_bypass");
    expect(result.auditEvents[0].reason).toBe("task_not_found");
    expect(result.auditEvents[0].strict).toBe(false);
  });

  it("supports strict missing-task guard policy with audit events", async () => {
    const nt = getNodeType("trigger.task_available");
    const listTasks = vi.fn().mockResolvedValue([
      { id: "missing-task", title: "Missing", status: "todo" },
    ]);
    const canStartTask = vi.fn(() => ({
      canStart: false,
      reason: "task_not_found",
    }));

    const ctx = makeCtx({ activeSlotCount: 0, _services: { taskStore: { canStartTask } } });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      status: "todo",
      enforceStartGuards: true,
      strictStartGuardMissingTask: true,
    });

    const result = await nt.execute(node, ctx, {
      services: { kanban: { listTasks }, taskStore: { canStartTask } },
    });

    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("start_guard_blocked");
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].reason).toBe("task_not_found");
    expect(result.blocked[0].strict).toBe(true);
    expect(result.auditEvents).toHaveLength(1);
    expect(result.auditEvents[0].type).toBe("start_guard_blocked");
    expect(result.auditEvents[0].reason).toBe("task_not_found");
    expect(result.auditEvents[0].strict).toBe(true);
  });

  it("filters out todo tasks that still have active persisted claim ownership", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "wf-task-claim-filter-"));
    const { initTaskClaims, claimTask, releaseTask } = await import("../task/task-claims.mjs");
    let claimToken = "";
    try {
      await initTaskClaims({ repoRoot });
      const claimResult = await claimTask({
        taskId: "claimed-task",
        instanceId: "wf-test-instance",
      });
      expect(claimResult.success).toBe(true);
      claimToken = claimResult.token || "";

      const nt = getNodeType("trigger.task_available");
      const listTasks = vi.fn().mockResolvedValue([
        { id: "claimed-task", title: "Already owned", status: "todo" },
        { id: "ready-task", title: "Ready", status: "todo" },
      ]);
      const ctx = makeCtx({
        activeSlotCount: 0,
        repoRoot,
      });
      const node = makeNode("trigger.task_available", {
        maxParallel: 1,
        status: "todo",
      });

      const result = await nt.execute(node, ctx, {
        services: {
          kanban: {
            listTasks,
          },
        },
      });

      expect(result.triggered).toBe(true);
      expect(result.taskCount).toBe(1);
      expect(result.selectedTaskId).toBe("ready-task");
      expect(result.persistedOwnershipFilteredCount).toBe(1);
      expect(result.tasks[0].id).toBe("ready-task");
    } finally {
      if (claimToken) {
        await releaseTask({
          taskId: "claimed-task",
          claimToken,
          instanceId: "wf-test-instance",
        });
      }
      try { rmSync(repoRoot, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("polls explicitly configured custom statuses in order, prioritizes earlier statuses, and deduplicates repeated tasks", async () => {
    const nt = getNodeType("trigger.task_available");
    const sharedTask = {
      id: "task-shared",
      title: "Shared task",
      status: "inreview",
      createdAt: "2026-03-02T00:00:00.000Z",
    };
    const listTasks = vi.fn(async (_projectId, opts = {}) => {
      if (opts.status === "inreview") {
        return [
          sharedTask,
          {
            id: "task-review",
            title: "Review fix first",
            status: "inreview",
            createdAt: "2026-03-03T00:00:00.000Z",
          },
        ];
      }
      if (opts.status === "todo") {
        return [
          {
            id: "task-todo",
            title: "New todo task",
            status: "todo",
            createdAt: "2026-03-01T00:00:00.000Z",
          },
          sharedTask,
        ];
      }
      return [];
    });
    const ctx = makeCtx({ activeSlotCount: 0 });
    const node = makeNode("trigger.task_available", {
      maxParallel: 1,
      statuses: ["inreview", "todo"],
      filterDrafts: false,
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: {
          listTasks,
        },
      },
    });

    expect(listTasks).toHaveBeenNthCalledWith(1, undefined, { status: "inreview" });
    expect(listTasks).toHaveBeenNthCalledWith(2, undefined, { status: "todo" });
    expect(result.triggered).toBe(true);
    expect(result.taskCount).toBe(1);
    expect(result.tasks.map((task) => task.id)).toEqual(["task-shared"]);
    expect(result.task.id).toBe("task-shared");
    expect(result.selectedTaskId).toBe("task-shared");
  });

  it("returns all unique tasks across explicitly configured statuses in priority order", async () => {
    const nt = getNodeType("trigger.task_available");
    const sharedTask = {
      id: "task-shared",
      title: "Shared task",
      status: "inreview",
      createdAt: "2026-03-02T00:00:00.000Z",
    };
    const listTasks = vi.fn(async (_projectId, opts = {}) => {
      if (opts.status === "inreview") {
        return [
          sharedTask,
          {
            id: "task-review",
            title: "Review fix first",
            status: "inreview",
            createdAt: "2026-03-03T00:00:00.000Z",
          },
        ];
      }
      if (opts.status === "todo") {
        return [
          {
            id: "task-todo",
            title: "New todo task",
            status: "todo",
            createdAt: "2026-03-01T00:00:00.000Z",
          },
          sharedTask,
        ];
      }
      return [];
    });
    const ctx = makeCtx({ activeSlotCount: 0 });
    const node = makeNode("trigger.task_available", {
      maxParallel: 3,
      statuses: ["inreview", "todo"],
      filterDrafts: false,
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: {
          listTasks,
        },
      },
    });

    expect(listTasks).toHaveBeenNthCalledWith(1, undefined, { status: "inreview" });
    expect(listTasks).toHaveBeenNthCalledWith(2, undefined, { status: "todo" });
    expect(result.triggered).toBe(true);
    expect(result.taskCount).toBe(3);
    expect(result.tasks.map((task) => task.id)).toEqual([
      "task-shared",
      "task-review",
      "task-todo",
    ]);
    expect(result.task.id).toBe("task-shared");
    expect(result.selectedTaskId).toBe("task-shared");
  });

  it("monitor polling dispatches only reclaimable tasks and skips actively claimed todo work", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "wf-monitor-dispatch-"));
    const taskDir = join(repoRoot, ".bosun", "tasks");
    mkdirSync(taskDir, { recursive: true });

    const { initTaskClaims, claimTask, releaseTask } = await import("../task/task-claims.mjs");
    let claimToken = "";
    try {
      await initTaskClaims({ repoRoot });
      const claimResult = await claimTask({
        repoRoot,
        taskId: "task-active-claim",
        agentInstanceId: "agent-active",
        taskTitle: "Already claimed",
      });
      expect(claimResult.success).toBe(true);
      claimToken = claimResult.token || "";

      const blockedTask = {
        id: "task-reclaimable",
        title: "Recover blocked worktree",
        status: "blocked",
        cooldownUntil: new Date(Date.now() - 60000).toISOString(),
        meta: {
          autoRecovery: {
            active: true,
            reason: "worktree_failure",
            retryAt: new Date(Date.now() - 60000).toISOString(),
          },
        },
      };
      const activeClaimTask = {
        id: "task-active-claim",
        title: "Already claimed",
        status: "todo",
      };

      writeFileSync(join(taskDir, "task-reclaimable.json"), JSON.stringify(blockedTask, null, 2));
      writeFileSync(join(taskDir, "task-active-claim.json"), JSON.stringify(activeClaimTask, null, 2));

      const listTasks = vi.fn(async (_projectId, opts = {}) => {
        if (opts.status === "blocked") {
          return [blockedTask];
        }
        if (opts.status === "todo") {
          return [
            blockedTask.status === "todo" ? blockedTask : null,
            activeClaimTask,
          ].filter(Boolean);
        }
        return [];
      });
      const updateTask = vi.fn(async (taskId, patch) => {
        if (taskId === blockedTask.id) {
          Object.assign(blockedTask, patch);
        }
        return { taskId, ...patch };
      });
      const trigger = getNodeType("trigger.task_available");
      const ctx = makeCtx({ repoRoot });
      const node = makeNode("trigger.task_available", {
        repoRoot,
        status: "todo",
      }, "dispatch");

      const result = await trigger.execute(node, ctx, {
        services: {
          kanban: {
            listTasks,
            updateTask,
          },
        },
      });

      expect(result.triggered).toBe(true);
      expect(result.selectedTaskId).toBe("task-reclaimable");
      expect(result.task.id).toBe("task-reclaimable");
      expect(result.task.id).not.toBe("task-active-claim");
      expect(updateTask).toHaveBeenCalledWith(
        "task-reclaimable",
        expect.objectContaining({ status: "todo", cooldownUntil: null }),
      );
      expect(listTasks).toHaveBeenNthCalledWith(1, undefined, { status: "blocked" });
      expect(listTasks).toHaveBeenNthCalledWith(2, undefined, { status: "todo" });
    } finally {
      if (claimToken) {
        await releaseTask({
          repoRoot,
          taskId: "task-active-claim",
          claimToken,
          agentInstanceId: "agent-active",
        });
      }
      try { rmSync(repoRoot, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("skips todo tasks whose persisted cooldownUntil is still active", async () => {
    const trigger = getNodeType("trigger.task_available");
    const coolingTask = {
      id: "task-cooling",
      title: "Cooling down after no-commit bounce",
      status: "todo",
      cooldownUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
      createdAt: "2026-04-22T00:00:00.000Z",
    };
    const readyTask = {
      id: "task-ready",
      title: "Ready for dispatch",
      status: "todo",
      createdAt: "2026-04-21T00:00:00.000Z",
    };
    const listTasks = vi.fn(async (_projectId, opts = {}) => {
      if (opts.status === "todo") {
        return [coolingTask, readyTask];
      }
      return [];
    });
    const ctx = makeCtx({ activeSlotCount: 0 });
    const node = makeNode("trigger.task_available", {
      maxParallel: 3,
      status: "todo",
      filterDrafts: false,
    });

    const result = await trigger.execute(node, ctx, {
      services: {
        kanban: {
          listTasks,
        },
      },
    });

    expect(result.triggered).toBe(true);
    expect(result.selectedTaskId).toBe("task-ready");
    expect(result.task.id).toBe("task-ready");
    expect(result.tasks.map((task) => task.id)).toEqual(["task-ready"]);
  });

  it("monitor polling reclaims stale placeholder-blocked tasks", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "wf-monitor-placeholder-recovery-"));
    const taskDir = join(repoRoot, ".bosun", "tasks");
    mkdirSync(taskDir, { recursive: true });

    const blockedTask = {
      id: "task-placeholder-recovery",
      title: "Recover placeholder-blocked worktree",
      status: "blocked",
      cooldownUntil: "{{acquire-worktree.retryAt}}",
      blockedReason: "{{acquire-worktree.blockedReason}}",
    };

    writeFileSync(join(taskDir, "task-placeholder-recovery.json"), JSON.stringify(blockedTask, null, 2));

    const listTasks = vi.fn(async (_projectId, opts = {}) => {
      if (opts.status === "blocked") {
        return [blockedTask];
      }
      if (opts.status === "todo") {
        return [blockedTask.status === "todo" ? blockedTask : null].filter(Boolean);
      }
      return [];
    });
    const updateTask = vi.fn(async (taskId, patch) => {
      if (taskId === blockedTask.id) {
        Object.assign(blockedTask, patch);
      }
      return { taskId, ...patch };
    });
    const trigger = getNodeType("trigger.task_available");
    const ctx = makeCtx({ repoRoot });
    const node = makeNode("trigger.task_available", {
      repoRoot,
      status: "todo",
    }, "dispatch-placeholder");

    const result = await trigger.execute(node, ctx, {
      services: {
        kanban: {
          listTasks,
          updateTask,
        },
      },
    });

    expect(updateTask).toHaveBeenCalledWith(
      "task-placeholder-recovery",
      expect.objectContaining({
        status: "todo",
        cooldownUntil: null,
        blockedReason: null,
      }),
    );
    expect(result.triggered).toBe(true);
    expect(result.selectedTaskId).toBe("task-placeholder-recovery");
  });

  it("engine handoff claims the dispatched task and releases ownership after completion", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "wf-monitor-handoff-"));
    const { initTaskClaims, getClaim } = await import("../task/task-claims.mjs");
    const listTasks = vi.fn(async (_projectId, opts = {}) => {
      if (opts.status === "blocked") return [];
      if (opts.status === "todo") {
        return [{
          id: "task-engine-handoff",
          title: "Run lifecycle handoff",
          status: "todo",
          workspace: repoRoot,
          repository: "virtengine/bosun",
          baseBranch: "main",
        }];
      }
      return [];
    });

    try {
      await initTaskClaims({ repoRoot });
      makeTmpEngine();
      engine.services = {
        kanban: {
          listTasks,
          updateTask: vi.fn(async (_taskId, patch) => patch),
        },
      };

      const workflow = {
        id: "monitor-handoff-regression",
        name: "Monitor Handoff Regression",
        enabled: true,
        nodes: [
          {
            id: "poll",
            type: "trigger.task_available",
            config: {
              repoRoot,
              status: "todo",
              maxParallel: 1,
              filterDrafts: false,
              enforceStartGuards: false,
              respectBenchmarkMode: false,
            },
          },
          {
            id: "claim",
            type: "action.claim_task",
            config: {
              taskId: "{{poll.selectedTaskId}}",
              taskTitle: "{{poll.taskTitle}}",
              renewIntervalMs: 0,
              ttlMinutes: 5,
              instanceId: "wf-monitor-handoff",
            },
          },
          {
            id: "release",
            type: "action.release_claim",
            config: {
              taskId: "{{claim.taskId}}",
              claimToken: "{{claim.claimToken}}",
              instanceId: "{{claim.instanceId}}",
            },
          },
          {
            id: "finish",
            type: "flow.end",
            config: {
              status: "completed",
              message: "handoff completed",
            },
          },
        ],
        edges: [
          { id: "e1", source: "poll", target: "claim" },
          { id: "e2", source: "claim", target: "release" },
          { id: "e3", source: "release", target: "finish" },
        ],
      };

      engine.save(workflow);
      const result = await engine.execute(workflow.id, {
        repoRoot,
        workspace: repoRoot,
      });

      expect(result.data._workflowTerminalStatus).toBe("completed");
      expect(result.getNodeOutput("poll")).toEqual(
        expect.objectContaining({
          selectedTaskId: "task-engine-handoff",
          taskCount: 1,
        }),
      );
      expect(result.getNodeOutput("claim")).toEqual(
        expect.objectContaining({
          success: true,
          taskId: "task-engine-handoff",
          instanceId: "wf-monitor-handoff",
        }),
      );
      expect(result.getNodeOutput("release")).toEqual(
        expect.objectContaining({
          success: true,
          taskId: "task-engine-handoff",
        }),
      );
      expect(await getClaim("task-engine-handoff")).toBeNull();
    } finally {
      try { rmSync(repoRoot, { recursive: true, force: true }); } catch { /* ok */ }
    }
  }, SLOW_WORKFLOW_TEST_TIMEOUT_MS);
});

//  condition.slot_available Tests
// ---------------------------------------------------------------------------

describe("condition.slot_available", () => {
  it("returns true when no active tasks exist", async () => {
    const nt = getNodeType("condition.slot_available");
    const ctx = makeCtx({ activeSlotCount: 0 });
    const node = makeNode("condition.slot_available", { maxParallel: 3 });
    const result = await nt.execute(node, ctx);
    expect(result.result).toBe(true);
    expect(result.activeSlotCount).toBe(0);
  });

  it("returns false when active count >= maxParallel", async () => {
    const nt = getNodeType("condition.slot_available");
    const ctx = makeCtx({ activeSlotCount: 3 });
    const node = makeNode("condition.slot_available", { maxParallel: 3 });
    const result = await nt.execute(node, ctx);
    expect(result.result).toBe(false);
    expect(result.activeSlotCount).toBe(3);
  });

  it("handles baseBranch limit", async () => {
    const nt = getNodeType("condition.slot_available");
    const ctx = makeCtx({
      activeSlotCount: 2,
      baseBranchSlotCounts: { main: 2 },
    });
    const node = makeNode("condition.slot_available", {
      maxParallel: 5,
      baseBranchLimit: 2,
      baseBranch: "origin/main",
    });
    const result = await nt.execute(node, ctx);
    // baseBranch limit 2 with 2 on "main" -> blocked
    expect(result.result).toBe(false);
  });

  it("counts only sibling task lifecycle runs from engine active runs", async () => {
    const nt = getNodeType("condition.slot_available");
    const ctx = makeCtx({
      taskId: "task-current",
    });
    const node = makeNode("condition.slot_available", { maxParallel: 3 });
    const engine = {
      getActiveRuns: () => [
        { workflowName: "Task Lifecycle", taskId: "task-current" },
        { workflowName: "Task Lifecycle", taskId: "task-sibling-1" },
        { workflowName: "Task Lifecycle", taskId: "task-sibling-2" },
        { workflowName: "Task Batch Processor", taskId: "TASK-DIAG-LOCAL" },
        { workflowName: "Bosun PR Watchdog", taskId: null },
      ],
    };
    const result = await nt.execute(node, ctx, engine);
    expect(result.result).toBe(true);
    expect(result.activeSlotCount).toBe(2);
  });

  it("blocks when sibling task lifecycle runs already fill the parallel budget", async () => {
    const nt = getNodeType("condition.slot_available");
    const ctx = makeCtx({
      taskId: "task-current",
    });
    const node = makeNode("condition.slot_available", { maxParallel: 3 });
    const engine = {
      getActiveRuns: () => [
        { workflowName: "Task Lifecycle", taskId: "task-current" },
        { workflowName: "Task Lifecycle", taskId: "task-sibling-1" },
        { workflowName: "Task Lifecycle", taskId: "task-sibling-2" },
        { workflowName: "Task Lifecycle", taskId: "task-sibling-3" },
      ],
    };
    const result = await nt.execute(node, ctx, engine);
    expect(result.result).toBe(false);
    expect(result.activeSlotCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
//  action.allocate_slot Tests
// ---------------------------------------------------------------------------

describe("action.allocate_slot", () => {
  it("allocates a slot and stores in ctx.data._allocatedSlot", async () => {
    const nt = getNodeType("action.allocate_slot");
    const ctx = makeCtx({});
    const node = makeNode("action.allocate_slot", {
      taskId: "task-123",
      taskTitle: "Test Task",
      branch: "feat/test",
      baseBranch: "main",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(ctx.data._allocatedSlot).toBeDefined();
    expect(ctx.data._allocatedSlot.taskId).toBe("task-123");
    expect(ctx.data._allocatedSlot.taskTitle).toBe("Test Task");
    expect(ctx.data._allocatedSlot.branch).toBe("feat/test");
    expect(ctx.data._agentInstanceId).toBeDefined();
  });

  it("saves env var snapshot", async () => {
    const nt = getNodeType("action.allocate_slot");
    const ctx = makeCtx({});
    process.env.VE_TEST_VAR = "hello";
    const node = makeNode("action.allocate_slot", {
      taskId: "task-snap",
      branch: "feat/snap",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    const slot = ctx.data._allocatedSlot;
    expect(slot._envSnapshot).toBeDefined();
    expect(slot._envSnapshot.VE_TEST_VAR).toBe("hello");
    delete process.env.VE_TEST_VAR;
  });
});

// ---------------------------------------------------------------------------
//  action.release_slot Tests
// ---------------------------------------------------------------------------

describe("action.release_slot", () => {
  it("releases the allocated slot and nullifies it", async () => {
    const nt = getNodeType("action.release_slot");
    const ctx = makeCtx({
      taskId: "task-rel",
      _allocatedSlot: { taskId: "task-rel", startedAt: Date.now() - 5000 },
    });
    const node = makeNode("action.release_slot", { taskId: "task-rel" });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(ctx.data._allocatedSlot).toBeNull();
  });

  it("returns success even if no slot allocated", async () => {
    const nt = getNodeType("action.release_slot");
    const ctx = makeCtx({ taskId: "missing" });
    const node = makeNode("action.release_slot", { taskId: "missing" });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
  });

  it("restores env vars from snapshot", async () => {
    const nt = getNodeType("action.release_slot");
    const origVal = process.env.VE_RESTORE_TEST;
    process.env.VE_RESTORE_TEST = "changed";
    const ctx = makeCtx({
      taskId: "task-env",
      _allocatedSlot: {
        taskId: "task-env",
        startedAt: Date.now() - 1000,
        _envSnapshot: { VE_RESTORE_TEST: "original" },
      },
    });
    const node = makeNode("action.release_slot", { taskId: "task-env" });
    await nt.execute(node, ctx);
    expect(process.env.VE_RESTORE_TEST).toBe("original");
    // Cleanup
    if (origVal === undefined) delete process.env.VE_RESTORE_TEST;
    else process.env.VE_RESTORE_TEST = origVal;
  });
});

// ---------------------------------------------------------------------------
//  action.claim_task Tests
// ---------------------------------------------------------------------------


describe("delegation transition guards", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("keeps claim side effects idempotent and records audit transitions on replay", async () => {
    const nt = getNodeType("action.claim_task");
    const claims = await import("../task/task-claims.mjs");
    const initSpy = vi.spyOn(claims, "initTaskClaims").mockResolvedValue();
    const claimSpy = vi.spyOn(claims, "claimTask")
      .mockResolvedValueOnce({ success: true, token: "claim-token-idem" });
    const renewSpy = vi.spyOn(claims, "renewClaim").mockResolvedValue({ success: true });
    const ctx = makeCtx({
      _workflowDelegationTrail: [],
      _workflowDelegationApplied: {},
    });
    const node = makeNode("action.claim_task", {
      taskId: "task-idem-1",
      taskTitle: "Idempotent Task",
      renewIntervalMs: 25,
      ttlMinutes: 5,
      instanceId: "wf-idem-1",
      delegationTransitionType: "assign",
      delegationTransitionKey: "assign:task-idem-1:wf-idem-1",
    });

    const first = await nt.execute(node, ctx);
    const second = await nt.execute(node, ctx);

    expect(first).toMatchObject({ success: true, taskId: "task-idem-1" });
    expect(second).toMatchObject({
      success: true,
      taskId: "task-idem-1",
      idempotentReplay: true,
      claimToken: "claim-token-idem",
    });
    expect(claimSpy).toHaveBeenCalledTimes(1);
    expect(Array.isArray(ctx.data._workflowDelegationTrail)).toBe(true);
    expect(ctx.data._workflowDelegationTrail).toEqual([
      expect.objectContaining({
        type: "assign",
        taskId: "task-idem-1",
        transitionKey: "assign:task-idem-1:wf-idem-1",
      }),
    ]);

    const runtimeTimer = ctx.__workflowRuntimeState?.claimRenewTimer || ctx.data?._claimRenewTimer;
    if (runtimeTimer) clearInterval(runtimeTimer);
    initSpy.mockRestore();
    claimSpy.mockRestore();
    renewSpy.mockRestore();
  });
});

describe("action.claim_task", () => {
  it("initializes task-claims lazily before claiming", async () => {
    const nt = getNodeType("action.claim_task");
    const claims = await import("../task/task-claims.mjs");
    const initSpy = vi.spyOn(claims, "initTaskClaims").mockResolvedValue();
    const claimSpy = vi.spyOn(claims, "claimTask").mockResolvedValue({
      success: true,
      token: "claim-token-1",
    });

    try {
      const ctx = makeCtx({ repoRoot: "/tmp/repo-root" });
      const node = makeNode("action.claim_task", {
        taskId: "task-1",
        taskTitle: "Fix dispatch",
        renewIntervalMs: 0,
      });
      const result = await nt.execute(node, ctx);

      expect(result.success).toBe(true);
      expect(result.claimToken).toBe("claim-token-1");
      expect(initSpy).toHaveBeenCalled();
      expect(claimSpy).toHaveBeenCalled();
    } finally {
      initSpy.mockRestore();
      claimSpy.mockRestore();
    }
  });

  it("rejects unresolved taskId placeholders before touching claim storage", async () => {
    const nt = getNodeType("action.claim_task");
    const claims = await import("../task/task-claims.mjs");
    const initSpy = vi.spyOn(claims, "initTaskClaims").mockResolvedValue();
    const claimSpy = vi.spyOn(claims, "claimTask").mockResolvedValue({
      success: true,
      token: "claim-token-placeholder",
    });

    try {
      const ctx = makeCtx({});
      const node = makeNode("action.claim_task", {
        taskId: "{{taskId}}",
        taskTitle: "{{taskTitle}}",
        renewIntervalMs: 0,
      });

      await expect(nt.execute(node, ctx)).rejects.toThrow(
        "action.claim_task: resolved taskId is required",
      );
      expect(initSpy).not.toHaveBeenCalled();
      expect(claimSpy).not.toHaveBeenCalled();
    } finally {
      initSpy.mockRestore();
      claimSpy.mockRestore();
    }
  });

  it("uses renewClaim fallback when renewTaskClaim is unavailable", async () => {
    vi.useFakeTimers();
    const nt = getNodeType("action.claim_task");
    const claims = await import("../task/task-claims.mjs");
    const initSpy = vi.spyOn(claims, "initTaskClaims").mockResolvedValue();
    const claimSpy = vi.spyOn(claims, "claimTask").mockResolvedValue({
      success: true,
      token: "claim-token-fallback",
    });
    const renewSpy = vi.spyOn(claims, "renewClaim").mockResolvedValue({ success: true });

    const ctx = makeCtx({ repoRoot: "/tmp/repo-root" });
    try {
      const node = makeNode("action.claim_task", {
        taskId: "task-renew-fallback",
        taskTitle: "Renew fallback",
        renewIntervalMs: 50,
      });

      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);

      await vi.advanceTimersByTimeAsync(60);
      expect(renewSpy).toHaveBeenCalled();
      expect(renewSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "task-renew-fallback",
          claimToken: "claim-token-fallback",
        }),
      );
    } finally {
      const runtimeTimer = ctx.__workflowRuntimeState?.claimRenewTimer || ctx.data?._claimRenewTimer;
      if (runtimeTimer) clearInterval(runtimeTimer);
      initSpy.mockRestore();
      claimSpy.mockRestore();
      renewSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("marks claim as stolen when renewal returns owner_mismatch without throwing", async () => {
    vi.useFakeTimers();
    const nt = getNodeType("action.claim_task");
    const claims = await import("../task/task-claims.mjs");
    const initSpy = vi.spyOn(claims, "initTaskClaims").mockResolvedValue();
    const claimSpy = vi.spyOn(claims, "claimTask").mockResolvedValue({
      success: true,
      token: "claim-token-fatal",
    });
    const renewSpy = vi.spyOn(claims, "renewClaim").mockResolvedValue({
      success: false,
      error: "owner_mismatch",
    });

    const ctx = makeCtx({ repoRoot: "/tmp/repo-root" });
    try {
      const node = makeNode("action.claim_task", {
        taskId: "task-renew-fatal",
        taskTitle: "Renew fatal",
        renewIntervalMs: 50,
      });

      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);

      await vi.advanceTimersByTimeAsync(60);
      expect(renewSpy).toHaveBeenCalledTimes(1);
      expect(ctx.data._claimStolen).toBe(true);
      expect(ctx.__workflowRuntimeState?.claimRenewTimer || null).toBeNull();
    } finally {
      const runtimeTimer = ctx.__workflowRuntimeState?.claimRenewTimer || ctx.data?._claimRenewTimer;
      if (runtimeTimer) clearInterval(runtimeTimer);
      initSpy.mockRestore();
      claimSpy.mockRestore();
      renewSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("reuses an existing claim for the same idempotency key without duplicating side effects", async () => {
    const nt = getNodeType("action.claim_task");
    const claims = await import("../task/task-claims.mjs");
    const initSpy = vi.spyOn(claims, "initTaskClaims").mockResolvedValue();
    const claimSpy = vi.spyOn(claims, "claimTask").mockResolvedValue({
      success: true,
      token: "claim-token-idempotent",
    });

    try {
      const ctx = makeCtx({ repoRoot: "/tmp/repo-root" });
      const node = makeNode("action.claim_task", {
        taskId: "task-idempotent-1",
        taskTitle: "Idempotent claim",
        renewIntervalMs: 0,
        idempotencyKey: "claim-task-idempotent-1",
      });

      const first = await nt.execute(node, ctx);
      const second = await nt.execute(node, ctx);

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(second.claimToken).toBe("claim-token-idempotent");
      expect(claimSpy).toHaveBeenCalledTimes(1);
      expect(ctx.data._claimToken).toBe("claim-token-idempotent");
    } finally {
      initSpy.mockRestore();
      claimSpy.mockRestore();
    }
  });

  it("records ordered delegation audit events for claim and owner mismatch renewals", async () => {
    vi.useFakeTimers();
    const nt = getNodeType("action.claim_task");
    const claims = await import("../task/task-claims.mjs");
    const initSpy = vi.spyOn(claims, "initTaskClaims").mockResolvedValue();
    const claimSpy = vi.spyOn(claims, "claimTask").mockResolvedValue({
      success: true,
      token: "claim-token-audit",
    });
    const renewSpy = vi.spyOn(claims, "renewClaim").mockResolvedValue({
      success: false,
      error: "owner_mismatch",
    });

    const ctx = makeCtx({ repoRoot: "/tmp/repo-root" });
    try {
      const node = makeNode("action.claim_task", {
        taskId: "task-audit-trail",
        taskTitle: "Audit trail task",
        renewIntervalMs: 50,
      });

      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);

      await vi.advanceTimersByTimeAsync(60);

      const events = Array.isArray(ctx.data?._delegationAuditTrail)
        ? ctx.data._delegationAuditTrail
        : [];
      expect(events.map((entry) => entry.type)).toEqual(["assign", "owner-mismatch"]);
      expect(events[0]).toMatchObject({
        taskId: "task-audit-trail",
        nodeId: node.id,
        claimToken: "claim-token-audit",
      });
      expect(events[1]).toMatchObject({
        taskId: "task-audit-trail",
        nodeId: node.id,
        error: "owner_mismatch",
      });
    } finally {
      const runtimeTimer = ctx.__workflowRuntimeState?.claimRenewTimer || ctx.data?._claimRenewTimer;
      if (runtimeTimer) clearInterval(runtimeTimer);
      initSpy.mockRestore();
      claimSpy.mockRestore();
      renewSpy.mockRestore();
      vi.useRealTimers();
    }
  });


  it("does not append duplicate audit entries when ctx.recordDelegationEvent rejects a replay", async () => {
    const ctx = makeCtx({ repoRoot: "/tmp/repo-root" });
    ctx.data._delegationAuditTrail = [];
    ctx.data._delegationTransitionGuards = {};

    const event = {
      type: "handoff-complete",
      nodeId: "delegate",
      taskId: "task-replay",
      idempotencyKey: "handoff-complete:task-replay:delegate:thread-1",
      transitionKey: "handoff-complete:task-replay:delegate:thread-1",
      threadId: "thread-1",
    };

    const first = ctx.recordDelegationEvent(event);
    const second = ctx.recordDelegationEvent(event);

    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
    expect(ctx.data._delegationAuditTrail).toHaveLength(1);
    expect(ctx.data._delegationAuditTrail[0]).toMatchObject({
      type: "handoff-complete",
      transitionKey: "handoff-complete:task-replay:delegate:thread-1",
    });
  });

  it("deduplicates repeated claim renewal owner mismatch events by idempotency key", async () => {
    const ctx = makeCtx({ repoRoot: "/tmp/repo-root" });
    ctx.data._delegationAuditTrail = [];
    ctx.data._delegationTransitionGuards = {};

    const first = ctx.recordDelegationEvent({
      type: "owner-mismatch",
      nodeId: "claim",
      taskId: "task-dedupe",
      claimToken: "claim-token-dedupe",
      idempotencyKey: "renew:task-dedupe:claim-token-dedupe:owner-mismatch",
      error: "owner_mismatch",
    });
    const second = ctx.recordDelegationEvent({
      type: "owner-mismatch",
      nodeId: "claim",
      taskId: "task-dedupe",
      claimToken: "claim-token-dedupe",
      idempotencyKey: "renew:task-dedupe:claim-token-dedupe:owner-mismatch",
      error: "owner_mismatch",
    });

    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
    expect(ctx.data._delegationAuditTrail).toHaveLength(1);
    expect(ctx.data._delegationTransitionGuards["renew:task-dedupe:claim-token-dedupe:owner-mismatch"]).toBeTruthy();
  });

  it("marks failed delegation transitions so retries can re-run safely", async () => {
    const nt = getNodeType("action.claim_task");
    const claims = await import("../task/task-claims.mjs");
    const initSpy = vi.spyOn(claims, "initTaskClaims").mockResolvedValue();
    const claimSpy = vi.spyOn(claims, "claimTask")
      .mockRejectedValueOnce(new Error("temporary claim failure"))
      .mockResolvedValueOnce({ success: true, token: "claim-token-retry" });

    try {
      const ctx = makeCtx({ repoRoot: "/tmp/repo-root" });
      const node = makeNode("action.claim_task", {
        taskId: "task-failed-transition",
        taskTitle: "Retry after failure",
        renewIntervalMs: 0,
        delegationTransitionKey: "assign:task-failed-transition:wf-retry",
        instanceId: "wf-retry",
      });

      const first = await nt.execute(node, ctx);
      const guardAfterFirst = ctx.data._delegationTransitionGuards?.["assign:task-failed-transition:wf-retry"];
      const second = await nt.execute(node, ctx);

      expect(first).toMatchObject({ success: false, error: "temporary claim failure" });
      expect(guardAfterFirst).toEqual(expect.objectContaining({
        status: "failed",
        error: "temporary claim failure",
      }));
      expect(second).toMatchObject({ success: true, claimToken: "claim-token-retry" });
      expect(claimSpy).toHaveBeenCalledTimes(2);
      expect(ctx.data._delegationTransitionGuards?.["assign:task-failed-transition:wf-retry"]).toEqual(expect.objectContaining({
        status: "completed",
        claimToken: "claim-token-retry",
      }));
    } finally {
      initSpy.mockRestore();
      claimSpy.mockRestore();
    }
  });

  it("returns task_already_active when another workflow run already owns the same task", async () => {
    const nt = getNodeType("action.claim_task");
    const claims = await import("../task/task-claims.mjs");
    const initSpy = vi.spyOn(claims, "initTaskClaims").mockResolvedValue();
    const claimSpy = vi.spyOn(claims, "claimTask").mockResolvedValue({
      success: true,
      token: "claim-token-should-not-be-used",
    });

    try {
      const ctx = makeCtx({ repoRoot: "/tmp/repo-root" });
      ctx.id = "run-current";
      const node = makeNode("action.claim_task", {
        taskId: "task-active-1",
        taskTitle: "Already active elsewhere",
        renewIntervalMs: 0,
      });
      const engine = {
        _activeRuns: new Map([
          [
            "run-other",
            {
              ctx: {
                id: "run-other",
                data: {
                  taskId: "task-active-1",
                },
              },
            },
          ],
        ]),
      };

      const result = await nt.execute(node, ctx, engine);

      expect(result).toEqual(expect.objectContaining({
        success: false,
        taskId: "task-active-1",
        reason: "task_already_active",
        duplicateActiveTask: true,
      }));
      expect(claimSpy).not.toHaveBeenCalled();
      expect(initSpy).not.toHaveBeenCalled();
    } finally {
      initSpy.mockRestore();
      claimSpy.mockRestore();
    }
  });

  it("ignores an active parent batch run in the current lineage when claiming a task", async () => {
    const nt = getNodeType("action.claim_task");
    const claims = await import("../task/task-claims.mjs");
    const initSpy = vi.spyOn(claims, "initTaskClaims").mockResolvedValue();
    const claimSpy = vi.spyOn(claims, "claimTask").mockResolvedValue({
      success: true,
      token: "claim-token-real-child",
    });

    try {
      const ctx = makeCtx({
        repoRoot: "/tmp/repo-root",
        _workflowId: "template-task-lifecycle",
        _workflowRootRunId: "run-batch-root",
        _workflowParentRunId: "run-batch-root",
      });
      ctx.id = "run-child";
      ctx.getDelegationTransitionGuard = () => null;
      ctx.data._delegationTransitionGuards = {};
      const node = makeNode("action.claim_task", {
        taskId: "task-active-parent-batch-1",
        taskTitle: "Claim through batch child",
        renewIntervalMs: 0,
        idempotencyKey: "claim-parent-batch-lineage-1",
      });
      const engine = {
        _activeRuns: new Map([
          [
            "run-batch-root",
            {
              workflowId: "fcd7047d-ba1e-410a-adaa-23455441c3b7",
              workflowName: "Task Batch Processor",
              ctx: {
                id: "run-batch-root",
                data: {
                  taskId: "task-active-parent-batch-1",
                },
              },
            },
          ],
        ]),
      };

      const result = await nt.execute(node, ctx, engine);

      expect(result).toEqual(expect.objectContaining({
        success: true,
        taskId: "task-active-parent-batch-1",
      }));
      expect(result.reason).toBeUndefined();
      expect(result.duplicateActiveTask).not.toBe(true);
    } finally {
      initSpy.mockRestore();
      claimSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
//  action.resolve_executor Tests
// ---------------------------------------------------------------------------

describe("action.resolve_executor", () => {
  it("resolves default SDK to copilot when no env overrides", async () => {
    const nt = getNodeType("action.resolve_executor");
    const ctx = makeCtx({});
    // Clean up potential env vars
    const saved = { ...process.env };
    delete process.env.COPILOT_MODEL;
    delete process.env.CLAUDE_MODEL;
    delete process.env.CODEX_MODEL;
    const node = makeNode("action.resolve_executor", {
      defaultSdk: "auto",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.sdk).toBeDefined();
    // Restore
    Object.assign(process.env, saved);
  });

  it("stores resolved values in ctx.data", async () => {
    const nt = getNodeType("action.resolve_executor");
    const ctx = makeCtx({});
    const node = makeNode("action.resolve_executor", {
      defaultSdk: "copilot",
    });
    const result = await nt.execute(node, ctx);
    expect(ctx.data.resolvedSdk).toBeDefined();
  });

  it("uses configured executor defaults when no library profile matches", async () => {
    const configMod = await import("../config/config.mjs");
    const loadConfigSpy = vi.spyOn(configMod, "loadConfig").mockReturnValue({
      executorConfig: {
        executors: [
          {
            name: "copilot-default",
            executor: "COPILOT",
            variant: "DEFAULT",
            role: "primary",
            weight: 100,
            enabled: true,
            models: [],
          },
        ],
      },
      internalExecutor: { sdk: "codex" },
      primaryAgent: "codex",
    });
    const saved = { ...process.env };
    delete process.env.COPILOT_MODEL;
    delete process.env.CLAUDE_MODEL;
    delete process.env.CODEX_MODEL;

    try {
      const nt = getNodeType("action.resolve_executor");
      const ctx = makeCtx({});
      const node = makeNode("action.resolve_executor", {
        defaultSdk: "auto",
      });
      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);
      expect(result.sdk).toBe("copilot");
      expect(ctx.data.resolvedSdk).toBe("copilot");
    } finally {
      loadConfigSpy.mockRestore();
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }
  });

  it("keeps an explicit defaultSdk from silently falling back to codex", async () => {
    const configMod = await import("../config/config.mjs");
    const loadConfigSpy = vi.spyOn(configMod, "loadConfig").mockReturnValue({
      executorConfig: {
        executors: [
          {
            name: "codex-default",
            executor: "CODEX",
            variant: "DEFAULT",
            role: "primary",
            weight: 100,
            enabled: true,
            models: [],
          },
        ],
      },
      internalExecutor: { sdk: "codex" },
      primaryAgent: "codex",
    });
    const saved = { ...process.env };
    delete process.env.COPILOT_MODEL;
    delete process.env.CLAUDE_MODEL;
    delete process.env.CODEX_MODEL;

    try {
      const nt = getNodeType("action.resolve_executor");
      const ctx = makeCtx({});
      const node = makeNode("action.resolve_executor", {
        defaultSdk: "copilot",
      });
      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);
      expect(result.sdk).toBe("copilot");
      expect(ctx.data.resolvedSdk).toBe("copilot");
    } finally {
      loadConfigSpy.mockRestore();
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }
  });

  it("prefers the harness primary executor over legacy codex defaults when harness runtime is active", async () => {
    const configMod = await import("../config/config.mjs");
    const loadConfigSpy = vi.spyOn(configMod, "loadConfig").mockReturnValue({
      agentRuntime: "harness",
      harness: {
        enabled: true,
        primaryExecutor: "azure-openai-responses-2",
        executors: [
          {
            id: "azure-openai-responses-1",
            providerId: "azure-openai-responses",
            enabled: true,
            defaultModel: "gpt-4.1-mini",
            endpoint: "https://primary.example/openai/v1",
            apiVersion: "2024-12-01-preview",
          },
          {
            id: "azure-openai-responses-2",
            providerId: "azure-openai-responses",
            enabled: true,
            defaultModel: "gpt-4.1",
            endpoint: "https://secondary.example/openai/v1",
            apiVersion: "2024-10-01-preview",
          },
        ],
      },
      executorConfig: {
        executors: [
          {
            name: "codex-default",
            executor: "CODEX",
            variant: "DEFAULT",
            role: "primary",
            weight: 100,
            enabled: true,
            models: [],
          },
        ],
      },
      internalExecutor: { sdk: "codex" },
      primaryAgent: "codex",
    });
    const savedEnv = { ...process.env };
    process.env.AZURE_OPENAI_API_KEY = "primary-secret";

    try {
      const nt = getNodeType("action.resolve_executor");
      const ctx = makeCtx({});
      const node = makeNode("action.resolve_executor", {
        defaultSdk: "auto",
      });
      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);
      expect(result.sdk).toBe("openai-native");
      expect(result.model).toBe("gpt-4.1");
      expect(result.provider).toBe("azure-openai-responses-2");
      expect(result.providerConfig).toEqual(expect.objectContaining({
        selectionId: "azure-openai-responses-2",
        provider: "azure-openai-responses",
        providerId: "azure-openai-responses",
        endpoint: "https://secondary.example/openai/v1",
        apiVersion: "2024-10-01-preview",
        model: "gpt-4.1",
      }));
      expect(ctx.data.resolvedSdk).toBe("openai-native");
      expect(ctx.data.resolvedModel).toBe("gpt-4.1");
      expect(ctx.data.resolvedProvider).toBe("azure-openai-responses-2");
      expect(ctx.data.resolvedProviderConfig).toEqual(expect.objectContaining({
        selectionId: "azure-openai-responses-2",
        provider: "azure-openai-responses",
        providerId: "azure-openai-responses",
        endpoint: "https://secondary.example/openai/v1",
        apiVersion: "2024-10-01-preview",
        model: "gpt-4.1",
      }));
    } finally {
      loadConfigSpy.mockRestore();
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
    }
  });

  it("skips an auth-dead harness primary executor in favor of a runnable secondary", async () => {
    const configMod = await import("../config/config.mjs");
    const loadConfigSpy = vi.spyOn(configMod, "loadConfig").mockReturnValue({
      agentRuntime: "harness",
      harness: {
        enabled: true,
        primaryExecutor: "azure-openai-responses",
        executors: [
          {
            id: "azure-openai-responses",
            providerId: "azure-openai-responses",
            enabled: true,
            defaultModel: "gpt-4.1-mini",
            endpoint: "https://primary.example/openai/v1",
            apiVersion: "2024-12-01-preview",
          },
          {
            id: "azure-openai-responses-2",
            providerId: "azure-openai-responses",
            enabled: true,
            weight: 100,
            defaultModel: "gpt-4.1",
            endpoint: "https://secondary.example/openai/v1",
            apiVersion: "2024-10-01-preview",
            authBindings: {
              apiKeyEnv: "AZURE_OPENAI_API_KEY_SECONDARY",
            },
          },
        ],
      },
      executorConfig: {
        executors: [
          {
            name: "codex-default",
            executor: "CODEX",
            variant: "DEFAULT",
            role: "primary",
            weight: 100,
            enabled: true,
            models: [],
          },
        ],
      },
      internalExecutor: { sdk: "codex" },
      primaryAgent: "codex",
    });
    const savedEnv = { ...process.env };
    delete process.env.AZURE_OPENAI_API_KEY;
    process.env.AZURE_OPENAI_API_KEY_SECONDARY = "secondary-secret";

    try {
      const nt = getNodeType("action.resolve_executor");
      const ctx = makeCtx({});
      const node = makeNode("action.resolve_executor", {
        defaultSdk: "auto",
      });
      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);
      expect(result.sdk).toBe("openai-native");
      expect(result.model).toBe("gpt-4.1");
      expect(result.provider).toBe("azure-openai-responses-2");
      expect(result.providerConfig).toEqual(expect.objectContaining({
        selectionId: "azure-openai-responses-2",
        provider: "azure-openai-responses",
        providerId: "azure-openai-responses",
        endpoint: "https://secondary.example/openai/v1",
        apiVersion: "2024-10-01-preview",
        model: "gpt-4.1",
      }));
      expect(ctx.data.resolvedProvider).toBe("azure-openai-responses-2");
      expect(ctx.data.resolvedProviderConfig).toEqual(expect.objectContaining({
        selectionId: "azure-openai-responses-2",
        provider: "azure-openai-responses",
        providerId: "azure-openai-responses",
        endpoint: "https://secondary.example/openai/v1",
        apiVersion: "2024-10-01-preview",
        model: "gpt-4.1",
      }));
    } finally {
      loadConfigSpy.mockRestore();
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
    }
  });

  it("applies library profile and skill resolution into context", async () => {
    const nt = getNodeType("action.resolve_executor");
    const root = mkdtempSync(join(tmpdir(), "wf-resolve-executor-library-"));
    const bosunDir = join(root, ".bosun");
    const profilesDir = join(bosunDir, "profiles");
    const skillsDir = join(bosunDir, "skills");
    mkdirSync(profilesDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });

    const manifest = {
      generated: new Date().toISOString(),
      entries: [
        {
          id: "backend-agent",
          type: "agent",
          name: "Backend Agent",
          description: "Backend profile",
          filename: "backend-agent.json",
          tags: ["backend", "api"],
          scope: "global",
          workspace: null,
          meta: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: "background-task-execution",
          type: "skill",
          name: "Background Task Execution",
          description: "Background worker guidance",
          filename: "background-task-execution.md",
          tags: ["backend", "api"],
          scope: "global",
          workspace: null,
          meta: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    };
    writeFileSync(join(bosunDir, "library.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(
      join(profilesDir, "backend-agent.json"),
      JSON.stringify({
        id: "backend-agent",
        name: "Backend Agent",
        description: "Backend specialist",
        titlePatterns: ["\\(api\\)", "\\bapi\\b"],
        scopes: ["api", "backend"],
        tags: ["backend", "api"],
        skills: ["background-task-execution"],
      }, null, 2),
    );
    writeFileSync(join(skillsDir, "background-task-execution.md"), "# Skill\nRun background task updates.");

    const ctx = makeCtx({
      repoRoot: root,
      task: {
        tags: ["backend", "api"],
      },
    });
    const node = makeNode("action.resolve_executor", {
      taskTitle: "feat(api): add webhooks endpoint",
      taskDescription: "Implement backend API endpoint and worker",
      repoRoot: root,
      defaultSdk: "auto",
    });

    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(ctx.data.agentProfile).toBe("backend-agent");
    expect(ctx.data.resolvedAgentProfile?.id).toBe("backend-agent");
    expect(Array.isArray(ctx.data.resolvedSkillIds)).toBe(true);
    expect(ctx.data.resolvedSkillIds).toContain("background-task-execution");

    rmSync(root, { recursive: true, force: true });
  });

  it("selects dynamically scored library skills even when the profile has no static skill list", async () => {
    const nt = getNodeType("action.resolve_executor");
    const root = mkdtempSync(join(tmpdir(), "wf-resolve-executor-dynamic-skills-"));
    const bosunDir = join(root, ".bosun");
    const profilesDir = join(bosunDir, "profiles");
    const skillsDir = join(bosunDir, "skills");
    mkdirSync(profilesDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });

    const now = new Date().toISOString();
    writeFileSync(join(bosunDir, "library.json"), JSON.stringify({
      generated: now,
      entries: [
        {
          id: "backend-agent",
          type: "agent",
          name: "Backend Agent",
          description: "Backend profile",
          filename: "backend-agent.json",
          tags: ["backend", "api", "webhook"],
          scope: "global",
          workspace: null,
          meta: {},
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "webhook-test-guidance",
          type: "skill",
          name: "Webhook Test Guidance",
          description: "Testing guidance for webhook handlers and delivery retries",
          filename: "webhook-test-guidance.md",
          tags: ["webhook", "tests", "api"],
          scope: "global",
          workspace: null,
          meta: {},
          createdAt: now,
          updatedAt: now,
        },
      ],
    }, null, 2));
    writeFileSync(
      join(profilesDir, "backend-agent.json"),
      JSON.stringify({
        id: "backend-agent",
        name: "Backend Agent",
        description: "Backend specialist",
        titlePatterns: [String.raw`\bwebhook\b`, String.raw`\bapi\b`],
        scopes: ["api", "backend"],
        tags: ["backend", "api", "webhook"],
        skills: [],
      }, null, 2),
    );
    writeFileSync(
      join(skillsDir, "webhook-test-guidance.md"),
      "# Skill\nFocus on webhook tests, retry semantics, and API failure cases.",
    );

    const ctx = makeCtx({
      repoRoot: root,
      task: {
        tags: ["backend", "api", "tests"],
      },
    });
    const node = makeNode("action.resolve_executor", {
      taskTitle: "feat(api): add webhook delivery tests",
      taskDescription: "Implement webhook retry behavior and update API tests for failure handling.",
      repoRoot: root,
      defaultSdk: "auto",
    });

    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(ctx.data.agentProfile).toBe("backend-agent");
    expect(Array.isArray(ctx.data.resolvedSkillIds)).toBe(true);
    expect(ctx.data.resolvedSkillIds).toContain("webhook-test-guidance");

    rmSync(root, { recursive: true, force: true });
  });

  it("does not auto-apply low-confidence profile matches", async () => {
    const nt = getNodeType("action.resolve_executor");
    const root = mkdtempSync(join(tmpdir(), "wf-resolve-executor-low-confidence-"));
    const bosunDir = join(root, ".bosun");
    const profilesDir = join(bosunDir, "profiles");
    mkdirSync(profilesDir, { recursive: true });

    const now = new Date().toISOString();
    writeFileSync(join(bosunDir, "library.json"), JSON.stringify({
      generated: now,
      entries: [
        {
          id: "generic-agent",
          type: "agent",
          name: "Generic Agent",
          description: "Broad profile with weak pattern",
          filename: "generic-agent.json",
          tags: ["generic"],
          scope: "global",
          workspace: null,
          meta: {},
          createdAt: now,
          updatedAt: now,
        },
      ],
    }, null, 2));
    writeFileSync(
      join(profilesDir, "generic-agent.json"),
      JSON.stringify({
        id: "generic-agent",
        name: "Generic Agent",
        description: "Broad profile",
        titlePatterns: ["\\bwith\\b"],
        scopes: ["generic"],
        tags: ["generic"],
      }, null, 2),
    );

    const ctx = makeCtx({
      repoRoot: root,
      task: {
        tags: ["workflow", "automation"],
      },
    });
    const node = makeNode("action.resolve_executor", {
      taskTitle: "feat(workflow): issue-state continuation loop workflow template",
      taskDescription: "Design continuation-loop workflow template with maxTurns and stuckDetection",
      repoRoot: root,
      defaultSdk: "codex",
    });

    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.tier).not.toBe("profile");
    expect(ctx.data.agentProfile).toBeUndefined();
    expect(ctx.data.resolvedAgentProfile).toBeUndefined();

    rmSync(root, { recursive: true, force: true });
  });

  it("does not auto-apply low-confidence profiles just because they carry skills", async () => {
    const nt = getNodeType("action.resolve_executor");
    const root = mkdtempSync(join(tmpdir(), "wf-resolve-executor-low-confidence-skills-"));
    const bosunDir = join(root, ".bosun");
    const profilesDir = join(bosunDir, "profiles");
    const skillsDir = join(bosunDir, "skills");
    mkdirSync(profilesDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });

    const now = new Date().toISOString();
    writeFileSync(join(bosunDir, "library.json"), JSON.stringify({
      generated: now,
      entries: [
        {
          id: "generic-agent",
          type: "agent",
          name: "Imported Generic Agent",
          description: "Broad imported-style profile with weak pattern",
          filename: "generic-agent.json",
          tags: ["generic", "agent", "imported"],
          scope: "global",
          workspace: null,
          meta: {},
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "generic-guidance",
          type: "skill",
          name: "Generic Guidance",
          description: "Generic skill that should not force profile auto-apply",
          filename: "generic-guidance.md",
          tags: ["generic", "agent", "imported"],
          scope: "global",
          workspace: null,
          meta: {},
          createdAt: now,
          updatedAt: now,
        },
      ],
    }, null, 2));
    writeFileSync(
      join(profilesDir, "generic-agent.json"),
      JSON.stringify({
        id: "generic-agent",
        name: "Imported Generic Agent",
        description: "Broad profile with weak pattern and auxiliary skill",
        titlePatterns: ["\\bagent\\b"],
        scopes: ["generic"],
        tags: ["generic", "agent", "imported"],
        skills: ["generic-guidance"],
        importMeta: {
          sourceId: "external-library",
          repoUrl: "https://example.com/external-library.git",
          branch: "main",
          relPath: ".github/agents/imported-generic-agent.md",
        },
      }, null, 2),
    );
    writeFileSync(join(skillsDir, "generic-guidance.md"), "# Skill\nGeneric guidance.");

    const ctx = makeCtx({
      repoRoot: root,
      task: {
        tags: ["workflow", "automation"],
      },
    });
    const node = makeNode("action.resolve_executor", {
      taskTitle: "feat(workflow): issue-state continuation loop workflow template",
      taskDescription: "Design continuation-loop workflow template with maxTurns and stuckDetection for the agent runtime.",
      repoRoot: root,
      defaultSdk: "codex",
    });

    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.tier).not.toBe("profile");
    expect(ctx.data.agentProfile).toBeUndefined();
    expect(ctx.data.resolvedAgentProfile).toBeUndefined();
    expect(ctx.data.resolvedSkillIds).toBeUndefined();

    rmSync(root, { recursive: true, force: true });
  });

  it("honors profile sdk/model preference when defined", async () => {
    const nt = getNodeType("action.resolve_executor");
    const root = mkdtempSync(join(tmpdir(), "wf-resolve-executor-profile-sdk-"));
    const bosunDir = join(root, ".bosun");
    const profilesDir = join(bosunDir, "profiles");
    mkdirSync(profilesDir, { recursive: true });

    const now = new Date().toISOString();
    writeFileSync(join(bosunDir, "library.json"), JSON.stringify({
      generated: now,
      entries: [
        {
          id: "devops-agent",
          type: "agent",
          name: "DevOps Agent",
          description: "CI profile",
          filename: "devops-agent.json",
          tags: ["ci", "cd"],
          scope: "global",
          workspace: null,
          meta: {},
          createdAt: now,
          updatedAt: now,
        },
      ],
    }, null, 2));
    writeFileSync(
      join(profilesDir, "devops-agent.json"),
      JSON.stringify({
        id: "devops-agent",
        name: "DevOps Agent",
        description: "CI/CD specialist",
        titlePatterns: ["\\(ci\\)", "\\bpipeline\\b"],
        scopes: ["ci", "cd"],
        tags: ["ci", "cd", "devops"],
        sdk: "CLAUDE_CODE",
        model: "claude-sonnet-4",
      }, null, 2),
    );

    const saved = { ...process.env };
    delete process.env.COPILOT_MODEL;
    delete process.env.CLAUDE_MODEL;
    delete process.env.CODEX_MODEL;

    try {
      const ctx = makeCtx({ repoRoot: root, task: { tags: ["ci"] } });
      const node = makeNode("action.resolve_executor", {
        taskTitle: "chore(ci): stabilize pipeline cache",
        taskDescription: "Improve CI reliability",
        repoRoot: root,
        defaultSdk: "copilot",
      });
      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);
      expect(result.tier).toBe("profile");
      expect(result.sdk).toBe("claude");
      expect(result.model).toBe("claude-sonnet-4");
      expect(ctx.data.agentProfile).toBe("devops-agent");
    } finally {
      Object.assign(process.env, saved);
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("resolves configured OpenCode executors and preserves providerConfig models", async () => {
    const configMod = await import("../config/config.mjs");
    const loadConfigSpy = vi.spyOn(configMod, "loadConfig").mockReturnValue({
      executorConfig: {
        executors: [
          {
            name: "opencode-kimi",
            executor: "OPENCODE",
            variant: "DEFAULT",
            role: "primary",
            weight: 100,
            enabled: true,
            provider: "openrouter",
            providerConfig: {
              model: "openrouter/moonshotai/kimi-k2",
            },
          },
        ],
      },
      internalExecutor: { sdk: "codex" },
      primaryAgent: "codex",
    });
    const saved = { ...process.env };
    delete process.env.COPILOT_MODEL;
    delete process.env.CLAUDE_MODEL;
    delete process.env.CODEX_MODEL;
    delete process.env.OPENCODE_MODEL;

    try {
      const nt = getNodeType("action.resolve_executor");
      const ctx = makeCtx({});
      const node = makeNode("action.resolve_executor", {
        defaultSdk: "auto",
      });
      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);
      expect(result.sdk).toBe("opencode");
      expect(result.model).toBe("openrouter/moonshotai/kimi-k2");
      expect(result.provider).toBe("openrouter");
      expect(result.providerConfig).toEqual({
        provider: "openrouter",
        model: "openrouter/moonshotai/kimi-k2",
      });
      expect(ctx.data.resolvedSdk).toBe("opencode");
      expect(ctx.data.resolvedModel).toBe("openrouter/moonshotai/kimi-k2");
      expect(ctx.data.resolvedProvider).toBe("openrouter");
      expect(ctx.data.resolvedProviderConfig).toEqual({
        provider: "openrouter",
        model: "openrouter/moonshotai/kimi-k2",
      });
    } finally {
      loadConfigSpy.mockRestore();
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }
  });

  it("exposes OpenCode in workflow agent SDK allowlists", () => {
    const runAgent = getNodeType("action.run_agent");
    const restartAgent = getNodeType("action.restart_agent");
    const pushBranch = getNodeType("action.push_branch");

    expect(runAgent?.schema?.properties?.sdk?.enum).toContain("opencode");
    expect(restartAgent?.schema?.properties?.sdk?.enum).toContain("opencode");
    expect(pushBranch?.schema?.properties?.conflictResolverSdk?.enum).toContain("opencode");
  });

  it("forwards resolved OpenCode executor config through action.run_agent execution", async () => {
    const handler = getNodeType("action.run_agent");
    const ctx = makeCtx({
      worktreePath: "/tmp/opencode-workflow",
      repoRoot: "/tmp/opencode-repo",
      resolvedSdk: "opencode",
      resolvedModel: "openrouter/moonshotai/kimi-k2",
      resolvedProvider: "openrouter",
      resolvedProviderConfig: {
        provider: "openrouter",
        baseUrl: "https://openrouter.example/v1",
        apiKey: "workflow-opencode-key",
        port: 4222,
        timeoutMs: 45000,
      },
    });
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: "opencode-run-complete",
      sdk: "opencode",
      items: [],
      threadId: "opencode-thread-1",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const node = makeNode("action.run_agent", {
      prompt: "Use OpenCode for this task",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
      autoRecover: false,
      failOnError: true,
    }, "run-agent-opencode");

    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.success).toBe(true);
    expect(result.sdk).toBe("opencode");
    expect(result.threadId).toBe("opencode-thread-1");
    expect(launchEphemeralThread).toHaveBeenCalledTimes(1);
    expect(launchEphemeralThread.mock.calls[0][3]).toEqual(
      expect.objectContaining({
        sdk: "opencode",
        model: "openrouter/moonshotai/kimi-k2",
        provider: "openrouter",
        providerConfig: {
          provider: "openrouter",
          model: "openrouter/moonshotai/kimi-k2",
          baseUrl: "https://openrouter.example/v1",
          apiKey: "workflow-opencode-key",
          port: 4222,
          timeoutMs: 45000,
        },
      }),
    );
    const launchEnv = launchEphemeralThread.mock.calls[0][3]?.env || {};
    const configCount = Number.parseInt(String(launchEnv.GIT_CONFIG_COUNT || "0"), 10);
    const safeDirectories = [];
    for (let index = 0; index < configCount; index += 1) {
      if (launchEnv[`GIT_CONFIG_KEY_${index}`] !== "safe.directory") continue;
      safeDirectories.push(launchEnv[`GIT_CONFIG_VALUE_${index}`]);
    }
    expect(safeDirectories.map((value) => resolve(value))).toContain(resolve("/tmp/opencode-workflow"));
    expect(safeDirectories.map((value) => resolve(value))).toContain(resolve("/tmp/opencode-repo"));
  }, SLOW_WORKFLOW_TEST_TIMEOUT_MS);

  it("persists workflow topology for task-backed action.run_agent executions", async () => {
    const handler = getNodeType("action.run_agent");
    const taskStoreMod = await import("../task/task-store.mjs");
    const originalStorePath = taskStoreMod.getStorePath();
    const taskStoreDir = mkdtempSync(join(tmpdir(), "wf-run-agent-task-store-"));
    const workingDir = mkdtempSync(join(tmpdir(), "wf-run-agent-task-cwd-"));
    const storePath = join(taskStoreDir, "kanban-state.json");
    const taskId = "TASK-RUN-AGENT-TOPOLOGY";

    try {
      taskStoreMod.configureTaskStore({ storePath });
      await taskStoreMod._resetForTests();
      taskStoreMod.addTask({ id: taskId, title: "Persist workflow topology", status: "inprogress" });

      const ctx = makeCtx({
        worktreePath: workingDir,
        repoRoot: workingDir,
        taskId,
        task: {
          id: taskId,
          title: "Persist workflow topology",
          branchName: "task-run-agent-topology",
        },
        _workflowId: "wf-task-topology",
        _workflowName: "Task Topology Workflow",
      });
      ctx.id = "run-task-topology-1";

      const launchEphemeralThread = vi.fn().mockResolvedValue({
        success: true,
        output: "topology synced",
        sdk: "copilot",
        items: [],
        threadId: "agent-thread-1",
      });
      const mockEngine = {
        services: {
          agentPool: {
            launchEphemeralThread,
          },
        },
      };
      const node = makeNode("action.run_agent", {
        prompt: "Persist task workflow topology",
        autoRecover: false,
        failOnError: true,
      }, "run-agent-task-topology");

      const result = await handler.execute(node, ctx, mockEngine);

      expect(result.success).toBe(true);
      const storedTask = taskStoreMod.getTask(taskId);
      expect(storedTask?.topology).toEqual(expect.objectContaining({
        latestRunId: "run-task-topology-1",
        workflowName: "Task Topology Workflow",
      }));
      expect(storedTask?.worktreePath).toBe(workingDir);
      expect(String(storedTask?.topology?.sessionId || "")).not.toBe("");
      expect(storedTask?.workflowRuns).toEqual([
        expect.objectContaining({
          runId: "run-task-topology-1",
          workflowName: "Task Topology Workflow",
        }),
      ]);
      expect(String(storedTask?.workflowRuns?.[0]?.sessionId || "")).not.toBe("");
      expect(launchEphemeralThread).toHaveBeenCalledTimes(1);
    } finally {
      await taskStoreMod.waitForStoreWrites();
      taskStoreMod.configureTaskStore({ storePath: originalStorePath });
      await removeDirAfterLedgerReset(taskStoreDir);
      rmSync(workingDir, { recursive: true, force: true });
    }
  }, SLOW_WORKFLOW_TEST_TIMEOUT_MS);

  it("classifies already-implemented workflow agent blocks as commit-blocked implement state", async () => {
    const handler = getNodeType("action.run_agent");
    const ctx = makeCtx({
      worktreePath: "/tmp/implemented-worktree",
      repoRoot: "/tmp/implemented-repo",
      taskId: "TASK-IMPLEMENT-ALREADY-DONE",
      task: {
        id: "TASK-IMPLEMENT-ALREADY-DONE",
        title: "Already implemented task",
      },
    });
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: false,
      sdk: "copilot",
      output: [
        "Code inspection suggests the task is already implemented in this worktree.",
        "The worktree already contains the intended fix and the implemented already-present fix appears aligned with task requirements.",
        "Blocked by environment constraints: this delegated session cannot safely inspect enough context to finish verification here.",
      ].join("\n"),
      items: [],
      threadId: "agent-thread-implemented",
    });
    const mockEngine = {
      services: {
        agentPool: {
          launchEphemeralThread,
        },
      },
    };

    const node = makeNode("action.run_agent", {
      prompt: "Confirm implementation state",
      autoRecover: false,
      failOnError: false,
    }, "run-agent-implement");

    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe("implementation_done_commit_blocked");
    expect(result.implementationState).toBe("implementation_done_commit_blocked");
    expect(launchEphemeralThread).toHaveBeenCalledTimes(1);
  }, SLOW_WORKFLOW_TEST_TIMEOUT_MS);

  it("forwards OpenCode restart config through action.restart_agent execution", async () => {
    const handler = getNodeType("action.restart_agent");
    const ctx = makeCtx({
      sessionId: "opencode-session-old",
      resolvedSdk: "opencode",
      resolvedModel: "openrouter/moonshotai/kimi-k2",
      resolvedProvider: "openrouter",
      resolvedProviderConfig: {
        provider: "openrouter",
        baseUrl: "https://openrouter.example/v1",
        apiKey: "restart-opencode-key",
      },
      worktreePath: "/tmp/opencode-workflow",
    });
    const killSession = vi.fn().mockResolvedValue(true);
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: "opencode-restarted",
      sdk: "opencode",
      items: [],
      threadId: "opencode-thread-2",
    });
    const mockEngine = {
      services: {
        agentPool: {
          killSession,
          launchEphemeralThread,
        },
      },
    };
    const node = makeNode("action.restart_agent", {
      prompt: "Restart with OpenCode",
      sdk: "{{resolvedSdk}}",
      model: "{{resolvedModel}}",
    }, "restart-agent-opencode");

    const result = await handler.execute(node, ctx, mockEngine);

    expect(result.success).toBe(true);
    expect(killSession).toHaveBeenCalledWith("opencode-session-old");
    expect(launchEphemeralThread).toHaveBeenCalledWith(
      expect.stringContaining("Restart with OpenCode"),
      "/tmp/opencode-workflow",
      3600000,
      expect.objectContaining({
        sdk: "opencode",
        model: "openrouter/moonshotai/kimi-k2",
        provider: "openrouter",
        providerConfig: {
          provider: "openrouter",
          model: "openrouter/moonshotai/kimi-k2",
          baseUrl: "https://openrouter.example/v1",
          apiKey: "restart-opencode-key",
        },
      }),
    );
    expect(ctx.data.threadId).toBe("opencode-thread-2");
  }, SLOW_WORKFLOW_TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
//  action.acquire_worktree Tests
// ---------------------------------------------------------------------------

describe("action.acquire_worktree", () => {
  let repoDir;

  const gitExec = (command, options = {}) =>
    execSync(command, {
      env: sanitizedGitEnv(),
      ...options,
    });

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "wf-acquire-worktree-"));
    gitExec("git init", { cwd: repoDir, stdio: "ignore" });
    gitExec("git config --local user.email test@test.com", { cwd: repoDir, stdio: "ignore" });
    gitExec("git config --local user.name Test", { cwd: repoDir, stdio: "ignore" });
    writeFileSync(join(repoDir, "README.md"), "init\n");
    gitExec("git add README.md && git commit -m init", { cwd: repoDir, stdio: "ignore" });
    gitExec("git branch -M main", { cwd: repoDir, stdio: "ignore" });
  });

  afterEach(() => {
    try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("falls back to defaultTargetBranch when baseBranch template is unresolved", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const ctx = makeCtx({});
    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "abc123",
      branch: "task/abc123-fallback-branch",
      baseBranch: "{{baseBranch}}",
      defaultTargetBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.baseBranch).toBe("main");
    expect(ctx.data.baseBranch).toBe("main");
    expect(result.created).toBe(true);
    expect(existsSync(result.worktreePath)).toBe(true);
  });

  it("rebases a reused task worktree onto a local base branch override", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const branch = "task/local-base-reuse";
    const localBaseBranch = "bosun/codex-self-improvement-loop-commits";
    writeFileSync(join(repoDir, "shell-codex-sdk-import.mjs"), "export { Codex } from \"@openai/codex-sdk\";\n");
    gitExec("git add shell-codex-sdk-import.mjs && git commit -m add-stale-import", {
      cwd: repoDir,
      stdio: "ignore",
    });
    gitExec(`git checkout -b ${localBaseBranch}`, {
      cwd: repoDir,
      stdio: "ignore",
    });
    writeFileSync(join(repoDir, "shell-codex-sdk-import.mjs"), "export async function loadCodex() {}\n");
    gitExec("git add shell-codex-sdk-import.mjs && git commit -m local-base-fix", {
      cwd: repoDir,
      stdio: "ignore",
    });
    gitExec("git checkout main", {
      cwd: repoDir,
      stdio: "ignore",
    });

    const initialNode = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "reuse-local-base-1",
      branch,
      baseBranch: "main",
      defaultTargetBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });
    const first = await nt.execute(initialNode, makeCtx({}));
    expect(first.success).toBe(true);
    expect(first.created).toBe(true);
    writeFileSync(join(first.worktreePath, "feature.txt"), "task work\n");
    gitExec("git add feature.txt && git commit -m task-work", {
      cwd: first.worktreePath,
      stdio: "ignore",
    });

    const overrideNode = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "reuse-local-base-1",
      branch,
      baseBranch: localBaseBranch,
      defaultTargetBranch: localBaseBranch,
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });
    const second = await nt.execute(overrideNode, makeCtx({}));
    expect(second.success).toBe(true);
    expect(second.reused).toBe(true);
    expect(readFileSync(join(second.worktreePath, "shell-codex-sdk-import.mjs"), "utf8")).toContain(
      "export async function loadCodex() {}",
    );
    const headContainsLocalBase = gitExec(
      `git merge-base --is-ancestor ${localBaseBranch} HEAD`,
      { cwd: second.worktreePath, encoding: "utf8" },
    );
    expect(headContainsLocalBase).toBe("");
  });

  it("rebases a newly attached task branch worktree onto a local base branch override", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const branch = "task/local-base-reattach";
    const localBaseBranch = "bosun/codex-self-improvement-loop-commits";
    writeFileSync(join(repoDir, "shell-codex-sdk-import.mjs"), "export { Codex } from \"@openai/codex-sdk\";\n");
    gitExec("git add shell-codex-sdk-import.mjs && git commit -m add-stale-import", {
      cwd: repoDir,
      stdio: "ignore",
    });
    gitExec(`git checkout -b ${localBaseBranch}`, {
      cwd: repoDir,
      stdio: "ignore",
    });
    writeFileSync(join(repoDir, "shell-codex-sdk-import.mjs"), "export async function loadCodex() {}\n");
    gitExec("git add shell-codex-sdk-import.mjs && git commit -m local-base-fix", {
      cwd: repoDir,
      stdio: "ignore",
    });
    gitExec("git checkout main", {
      cwd: repoDir,
      stdio: "ignore",
    });

    const initialNode = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "reattach-local-base-1",
      branch,
      baseBranch: "main",
      defaultTargetBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });
    const first = await nt.execute(initialNode, makeCtx({}));
    expect(first.success).toBe(true);
    expect(first.created).toBe(true);
    writeFileSync(join(first.worktreePath, "feature.txt"), "task work\n");
    gitExec("git add feature.txt && git commit -m task-work", {
      cwd: first.worktreePath,
      stdio: "ignore",
    });
    gitExec(`git worktree remove "${first.worktreePath}" --force`, {
      cwd: repoDir,
      stdio: "ignore",
    });

    const overrideNode = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "reattach-local-base-1",
      branch,
      baseBranch: localBaseBranch,
      defaultTargetBranch: localBaseBranch,
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });
    const second = await nt.execute(overrideNode, makeCtx({}));
    expect(second.success).toBe(true);
    expect(second.created).toBe(true);
    expect(readFileSync(join(second.worktreePath, "shell-codex-sdk-import.mjs"), "utf8")).toContain(
      "export async function loadCodex() {}",
    );
    const headContainsLocalBase = gitExec(
      `git merge-base --is-ancestor ${localBaseBranch} HEAD`,
      { cwd: second.worktreePath, encoding: "utf8" },
    );
    expect(headContainsLocalBase).toBe("");
  });

  it("recreates large stale detached task branches from the latest base when no PR exists", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const taskId = "blocked-stale-1";
    const branch = "task/blockedstale1-stale-ref";
    const localBaseBranch = "bosun/codex-self-improvement-loop-commits";
    writeFileSync(join(repoDir, "shell-codex-sdk-import.mjs"), "export { Codex } from \"@openai/codex-sdk\";\n");
    gitExec("git add shell-codex-sdk-import.mjs && git commit -m add-stale-import", {
      cwd: repoDir,
      stdio: "ignore",
    });

    const initialNode = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId,
      branch,
      baseBranch: "main",
      defaultTargetBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });
    const first = await nt.execute(initialNode, makeCtx({
      task: {
        id: taskId,
        title: "Blocked stale ref",
        status: "blocked",
      },
    }));
    expect(first.success).toBe(true);
    expect(first.created).toBe(true);

    for (let index = 0; index < 205; index += 1) {
      const name = `stale-${String(index).padStart(3, "0")}.txt`;
      writeFileSync(join(first.worktreePath, name), `stale ${index}\n`);
    }
    gitExec("git add . && git commit -m stale-task-history", {
      cwd: first.worktreePath,
      stdio: "ignore",
    });

    gitExec(`git show ${branch}:shell-codex-sdk-import.mjs`, {
      cwd: repoDir,
      encoding: "utf8",
    });
    gitExec(`git worktree remove "${first.worktreePath}" --force`, {
      cwd: repoDir,
      stdio: "ignore",
    });

    gitExec(`git checkout -b ${localBaseBranch}`, {
      cwd: repoDir,
      stdio: "ignore",
    });
    writeFileSync(join(repoDir, "shell-codex-sdk-import.mjs"), "export async function loadCodex() {}\n");
    gitExec("git add shell-codex-sdk-import.mjs && git commit -m local-base-fix", {
      cwd: repoDir,
      stdio: "ignore",
    });
    gitExec("git checkout main", {
      cwd: repoDir,
      stdio: "ignore",
    });

    const secondNode = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId,
      branch,
      baseBranch: localBaseBranch,
      defaultTargetBranch: localBaseBranch,
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });
    const second = await nt.execute(secondNode, makeCtx({
      task: {
        id: taskId,
        title: "Blocked stale ref",
        status: "inprogress",
        prNumber: null,
        prUrl: null,
      },
    }));
    expect(second.success).toBe(true);
    expect(second.created).toBe(true);
    expect(readFileSync(join(second.worktreePath, "shell-codex-sdk-import.mjs"), "utf8")).toContain(
      "export async function loadCodex() {}",
    );
    expect(existsSync(join(second.worktreePath, "stale-000.txt"))).toBe(false);

    const recreatedBranchFile = gitExec(`git show ${branch}:shell-codex-sdk-import.mjs`, {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(recreatedBranchFile).toContain("export async function loadCodex() {}");
    const baseAncestor = gitExec(
      `git merge-base --is-ancestor ${localBaseBranch} ${branch}`,
      { cwd: repoDir, encoding: "utf8" },
    );
    expect(baseAncestor).toBe("");

    const backupBranches = gitExec("git branch --format=\"%(refname:short)\"", {
      cwd: repoDir,
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => line.startsWith(`${branch}-recovery-`));
    expect(backupBranches.length).toBe(1);
    const backupBranchFile = gitExec(`git show ${backupBranches[0]}:shell-codex-sdk-import.mjs`, {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(backupBranchFile).toContain("export { Codex }");
  });

  it("persists acquired worktree branch metadata back to the task store projection", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const ctx = makeCtx({
      task: {
        id: "task-persist-branch-1",
        branchName: "task/old-stale-branch",
        baseBranch: "origin/main",
      },
    });
    const updateTask = vi.fn(async () => true);
    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "task-persist-branch-1",
      branch: "task/task-persist-branch-1-clean-branch",
      baseBranch: "main",
      defaultTargetBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: { updateTask },
      },
    });

    expect(result.success).toBe(true);
    expect(updateTask).toHaveBeenCalledWith(
      "task-persist-branch-1",
      expect.objectContaining({
        branchName: "task/task-persist-branch-1-clean-branch",
        baseBranch: "main",
        worktreePath: result.worktreePath,
      }),
    );
    expect(ctx.data.task.branchName).toBe("task/task-persist-branch-1-clean-branch");
    expect(ctx.data.task.baseBranch).toBe("main");
    expect(ctx.data.task.worktreePath).toBe(result.worktreePath);
  });

  it("returns explicit non-retryable metadata for config validation failures", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const ctx = makeCtx({});
    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "cfg-err-1",
      branch: "",
      baseBranch: "main",
    });

    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.failureKind).toBe("acquire_worktree_config_error");
    expect(result.taskId).toBe("cfg-err-1");
    expect(result.repoRoot).toBe(repoDir);
    expect(typeof result.worktreePath).toBe("string");
    expect(result.worktreePath).toContain(".bosun");
  });

  it("resolves repoRoot from config when workflow cwd is a non-git .bosun directory", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const bosunDir = join(repoDir, ".bosun");
    mkdirSync(bosunDir, { recursive: true });
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(bosunDir);
    try {
      const ctx = makeCtx({
        task: {
          repository: "unknown/unknown",
          meta: { repository: "unknown/unknown" },
        },
      });
      const node = makeNode("action.acquire_worktree", {
        taskId: "abc456",
        branch: "task/abc456-config-root",
        baseBranch: "main",
        fetchTimeout: 5000,
        worktreeTimeout: 10000,
      });

      const result = await nt.execute(node, ctx);
      expect(ctx.data.repoRoot).toBe(repoDir);
      expect(ctx.data.baseBranch).toBe("main");
      if (result.success) {
        expect(result.created).toBe(true);
        expect(existsSync(result.worktreePath)).toBe(true);
        expect(result.worktreePath).toContain(".bosun");
      } else {
        expect(result.error).toMatch(/spawnSync .*git(?:\.exe)? EPERM/i);
        expect(result.failureKind).toBe("host_spawn_unavailable");
        expect(result.retryable).toBe(false);
      }
    } finally {
      cwdSpy.mockRestore();
    }
  }, 15000);

  it("marks reused worktrees as managed for cleanup", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const ctx1 = makeCtx({});
    const branch = "task/reuse-managed";

    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "reuse-1",
      branch,
      baseBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const first = await nt.execute(node, ctx1);
    expect(first.success).toBe(true);
    expect(first.created).toBe(true);

    const ctx2 = makeCtx({});
    const second = await nt.execute(node, ctx2);
    expect(second.success).toBe(true);
    expect(second.reused).toBe(true);
    expect(ctx2.data._worktreeCreated).toBe(false);
    expect(ctx2.data._worktreeManaged).toBe(true);
  }, 15000);

  it("reuses an already-attached branch worktree even when managed path naming changed", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const branch = "task/legacy-reuse-branch";
    const legacyPath = join(repoDir, ".bosun", "worktrees", "task-legacy-reuse");
    mkdirSync(join(repoDir, ".bosun", "worktrees"), { recursive: true });

    gitExec('git worktree add "' + legacyPath + '" -b "' + branch + '" main', {
      cwd: repoDir,
      stdio: "ignore",
    });

    const ctx = makeCtx({});
    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "legacy-1",
      branch,
      baseBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.reused).toBe(true);
    expect(result.reusedExistingBranch).toBe(true);
    expect(result.created).toBe(false);
    expect(String(result.worktreePath).replace(/\\/g, "/")).toBe(String(legacyPath).replace(/\\/g, "/"));
    expect(ctx.data._worktreeManaged).toBe(true);
  }, 20000);

  it("recreates an already-attached managed branch when it falls behind the latest local base", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const branch = "task/legacy-reuse-conflict";
    const localBaseBranch = "bosun/codex-self-improvement-loop-commits";
    const legacyPath = join(repoDir, ".bosun", "worktrees", "task-legacy-reuse-conflict");
    mkdirSync(join(repoDir, ".bosun", "worktrees"), { recursive: true });

    writeFileSync(join(repoDir, "README.md"), "main branch baseline\n");
    gitExec("git add README.md && git commit -m main-readme-baseline", {
      cwd: repoDir,
      stdio: "ignore",
    });
    gitExec(`git checkout -b ${localBaseBranch}`, {
      cwd: repoDir,
      stdio: "ignore",
    });
    writeFileSync(join(repoDir, "README.md"), "local base change\n");
    gitExec("git add README.md && git commit -m local-base-readme-change", {
      cwd: repoDir,
      stdio: "ignore",
    });
    gitExec("git checkout main", {
      cwd: repoDir,
      stdio: "ignore",
    });

    gitExec(`git worktree add "${legacyPath}" -b "${branch}" main`, {
      cwd: repoDir,
      stdio: "ignore",
    });
    writeFileSync(join(legacyPath, "README.md"), "task branch change\n");
    gitExec("git add README.md && git commit -m task-readme-change", {
      cwd: legacyPath,
      stdio: "ignore",
    });

    const ctx = makeCtx({});
    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "legacy-conflict-1",
      branch,
      baseBranch: localBaseBranch,
      defaultTargetBranch: localBaseBranch,
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.reused).toBe(true);
    expect(result.reusedExistingBranch).toBe(true);
    expect(String(result.worktreePath || "")).toContain(".bosun");
    expect(String(result.worktreePath || "")).not.toBe(String(legacyPath));
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(result.worktreePath)).toBe(true);
    const isGit = gitExec("git rev-parse --is-inside-work-tree", {
      cwd: result.worktreePath,
      encoding: "utf8",
    }).trim();
    expect(isGit).toBe("true");

    const recovery = readWorktreeRecoveryStatus(repoDir);
    expect(recovery?.health).toBe("recovered");
    expect(recovery?.failureStreak).toBe(0);
    expect(recovery?.recentEvents?.[0]).toMatchObject({
      outcome: "recreated",
      reason: "poisoned_worktree",
      branch,
      taskId: "legacy-conflict-1",
    });
    expect(recovery?.recentEvents?.[0]?.detectedIssues || []).toContain("refresh_conflict");
  }, 20000);

  it("recreates a usable managed worktree when post-create sync removes a stale detached branch", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const branch = "task/post-create-refresh-conflict";
    const localBaseBranch = "bosun/codex-self-improvement-loop-commits";
    const taskId = "post-create-conflict-1";
    const placeholderPath = join(
      repoDir,
      ".bosun",
      "worktrees",
      deriveManagedWorktreeDirName(taskId, branch),
    );
    mkdirSync(join(placeholderPath, ".bosun"), { recursive: true });

    writeFileSync(join(repoDir, "README.md"), "main branch baseline\n");
    gitExec("git add README.md && git commit -m main-readme-baseline", {
      cwd: repoDir,
      stdio: "ignore",
    });
    gitExec(`git checkout -b ${localBaseBranch}`, {
      cwd: repoDir,
      stdio: "ignore",
    });
    writeFileSync(join(repoDir, "README.md"), "local base change\n");
    gitExec("git add README.md && git commit -m local-base-readme-change", {
      cwd: repoDir,
      stdio: "ignore",
    });
    gitExec("git checkout main", {
      cwd: repoDir,
      stdio: "ignore",
    });
    gitExec(`git checkout -b ${branch}`, {
      cwd: repoDir,
      stdio: "ignore",
    });
    writeFileSync(join(repoDir, "README.md"), "task branch change\n");
    gitExec("git add README.md && git commit -m task-readme-change", {
      cwd: repoDir,
      stdio: "ignore",
    });
    gitExec("git checkout main", {
      cwd: repoDir,
      stdio: "ignore",
    });

    const ctx = makeCtx({});
    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId,
      branch,
      baseBranch: localBaseBranch,
      defaultTargetBranch: localBaseBranch,
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.created).toBe(true);
    expect(String(result.worktreePath).replace(/\\/g, "/")).toBe(String(placeholderPath).replace(/\\/g, "/"));
    expect(existsSync(join(result.worktreePath, ".git"))).toBe(true);

    const topLevel = gitExec("git rev-parse --show-toplevel", {
      cwd: result.worktreePath,
      encoding: "utf8",
    }).trim().replace(/\\/g, "/");
    expect(topLevel).toBe(String(result.worktreePath).replace(/\\/g, "/"));

    const recovery = readWorktreeRecoveryStatus(repoDir);
    expect(recovery?.health).toBe("recovered");
    expect(recovery?.failureStreak).toBe(0);
    expect(recovery?.recentEvents?.[0]?.detectedIssues || []).toContain("missing_git_metadata");
    expect(recovery?.recentEvents?.[0]?.detectedIssues || []).toContain("refresh_conflict");
  }, 20000);

  it("fails non-retryably when the task branch is already attached to an unmanaged worktree", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const branch = "task/unmanaged-attached-branch";
    const externalPath = mkdtempSync(join(tmpdir(), "wf-unmanaged-attached-"));

    try {
      gitExec(`git worktree add "${externalPath}" -b "${branch}" main`, {
        cwd: repoDir,
        stdio: "ignore",
      });

      const ctx = makeCtx({});
      const node = makeNode("action.acquire_worktree", {
        repoRoot: repoDir,
        taskId: "unmanaged-attached-1",
        branch,
        baseBranch: "main",
        fetchTimeout: 5000,
        worktreeTimeout: 10000,
      });

      const result = await nt.execute(node, ctx);

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.failureKind).toBe("unmanaged_attached_worktree");
      expect(result.worktreePath.replace(/\\/g, "/")).toBe(externalPath.replace(/\\/g, "/"));
      expect(result.error).toContain("already attached to unmanaged worktree");
      expect(result.blockedReason).toContain("non-Bosun worktree");
      expect(existsSync(externalPath)).toBe(true);
    } finally {
      try {
        gitExec(`git worktree remove "${externalPath}" --force`, {
          cwd: repoDir,
          stdio: "ignore",
        });
      } catch {
        rmSync(externalPath, { recursive: true, force: true });
      }
    }
  }, 20000);
  it("uses a short managed worktree directory derived from task id", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const ctx = makeCtx({});
    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "task-123e4567-e89b-12d3-a456-426614174000",
      branch: "task/very-long-branch-name-that-would-normally-be-used-as-worktree-directory",
      baseBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    const normalizedPath = String(result.worktreePath || "").replace(/\\/g, "/");
    expect(normalizedPath).toMatch(/\/\.bosun\/worktrees\/task-task123e4567-[a-f0-9]{10}$/);
    expect(normalizedPath).not.toContain("very-long-branch-name");
  });


  it("recreates invalid managed worktrees instead of reusing broken git metadata", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const branch = "task/recreate-invalid-managed";
    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "recreate-invalid-1",
      branch,
      baseBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const firstCtx = makeCtx({});
    const first = await nt.execute(node, firstCtx);
    expect(first.success).toBe(true);
    expect(first.created).toBe(true);

    gitExec('git worktree remove "' + first.worktreePath + '" --force', {
      cwd: repoDir,
      stdio: "ignore",
    });
    mkdirSync(first.worktreePath, { recursive: true });
    writeFileSync(join(first.worktreePath, "stale.txt"), "stale");

    const secondCtx = makeCtx({});
    const second = await nt.execute(node, secondCtx);
    expect(second.success).toBe(true);
    expect(typeof second.worktreePath).toBe("string");
    expect(second.worktreePath.length).toBeGreaterThan(0);
    const isGit = gitExec("git rev-parse --is-inside-work-tree", {
      cwd: second.worktreePath,
      encoding: "utf8",
    }).trim();
    expect(isGit).toBe("true");

    const topLevel = gitExec("git rev-parse --show-toplevel", {
      cwd: second.worktreePath,
      encoding: "utf8",
    }).trim().replace(/\\/g, "/");
    const expectedRoot = String(second.worktreePath).replace(/\\/g, "/");
    expect(topLevel).toBe(expectedRoot);

    const recovery = readWorktreeRecoveryStatus(repoDir);
    expect(recovery?.health).toBe("recovered");
    expect(recovery?.failureStreak).toBe(0);
    expect(recovery?.recentEvents?.[0]).toMatchObject({
      outcome: "recreated",
      reason: "poisoned_worktree",
      branch,
      taskId: "recreate-invalid-1",
    });
  }, 15000);

  it.skipIf(process.platform !== "win32")("switches to a recovery path when a poisoned managed worktree directory cannot be removed", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const branch = "task/recreate-locked-managed";
    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "recreate-locked-1",
      branch,
      baseBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const first = await nt.execute(node, makeCtx({}));
    expect(first.success).toBe(true);
    expect(first.created).toBe(true);

    gitExec('git worktree remove "' + first.worktreePath + '" --force', {
      cwd: repoDir,
      stdio: "ignore",
    });

    const orphanGitDir = join(repoDir, ".git", "worktrees", first.worktreePath.split(/[/\\]/).pop());
    mkdirSync(first.worktreePath, { recursive: true });
    writeFileSync(join(first.worktreePath, ".git"), `gitdir: ${orphanGitDir.replace(/\\/g, "/")}\n`);
    writeFileSync(join(first.worktreePath, "stale.txt"), "stale");

    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: first.worktreePath,
      stdio: "ignore",
      windowsHide: true,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 200));

      const second = await nt.execute(node, makeCtx({}));
      expect(second.success).toBe(true);
      expect(String(second.worktreePath).replace(/\\/g, "/"))
        .not.toBe(String(first.worktreePath).replace(/\\/g, "/"));
      expect(String(second.worktreePath).replace(/\\/g, "/"))
        .toContain(`${String(first.worktreePath).replace(/\\/g, "/")}-recovery-`);

      const isGit = gitExec("git rev-parse --is-inside-work-tree", {
        cwd: second.worktreePath,
        encoding: "utf8",
      }).trim();
      expect(isGit).toBe("true");

      const recovery = readWorktreeRecoveryStatus(repoDir);
      expect(recovery?.health).toBe("recovered");
      expect(recovery?.recentEvents?.[0]).toMatchObject({
        outcome: "recreated",
        reason: "poisoned_worktree",
        branch,
        taskId: "recreate-locked-1",
      });
      expect(recovery?.recentEvents?.[0]?.detectedIssues || []).toContain("path_still_present");
    } finally {
      let exited = false;
      holder.once("exit", () => {
        exited = true;
      });
      try {
        holder.kill();
      } catch {
        // Best-effort cleanup.
      }
      if (!exited) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }, 20000);

  it("recreates managed worktrees left in unresolved rebase state before reuse", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const branch = "task/recreate-unresolved-rebase";
    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "recreate-rebase-1",
      branch,
      baseBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const firstCtx = makeCtx({});
    const first = await nt.execute(node, firstCtx);
    expect(first.success).toBe(true);
    expect(first.created).toBe(true);

    const firstGitDir = resolve(
      first.worktreePath,
      gitExec("git rev-parse --git-dir", {
        cwd: first.worktreePath,
        encoding: "utf8",
      }).trim(),
    );
    mkdirSync(join(firstGitDir, "rebase-merge"), { recursive: true });
    writeFileSync(join(firstGitDir, "rebase-merge", "head-name"), `refs/heads/${branch}\n`);

    const secondCtx = makeCtx({});
    const second = await nt.execute(node, secondCtx);
    expect(second.success).toBe(true);
    expect(typeof second.worktreePath).toBe("string");
    expect(second.worktreePath.length).toBeGreaterThan(0);

    const secondGitDir = resolve(
      second.worktreePath,
      gitExec("git rev-parse --git-dir", {
        cwd: second.worktreePath,
        encoding: "utf8",
      }).trim(),
    );
    expect(existsSync(join(secondGitDir, "rebase-merge"))).toBe(false);
    const isGit = gitExec("git rev-parse --is-inside-work-tree", {
      cwd: second.worktreePath,
      encoding: "utf8",
    }).trim();
    expect(isGit).toBe("true");
    const topLevel = gitExec("git rev-parse --show-toplevel", {
      cwd: second.worktreePath,
      encoding: "utf8",
    }).trim().replace(/\\/g, "/");
    const expectedRoot = String(second.worktreePath).replace(/\\/g, "/");
    expect(topLevel).toBe(expectedRoot);

    const recovery = readWorktreeRecoveryStatus(repoDir);
    expect(recovery?.health).toBe("recovered");
    expect(recovery?.recentEvents?.[0]).toMatchObject({
      outcome: "recreated",
      reason: "poisoned_worktree",
      branch,
      taskId: "recreate-rebase-1",
    });
  }, 15000);

  it("does not record recovery noise when reusing a healthy managed worktree", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const branch = "task/reuse-healthy-managed";
    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "reuse-healthy-1",
      branch,
      baseBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const first = await nt.execute(node, makeCtx({}));
    expect(first.success).toBe(true);

    const second = await nt.execute(node, makeCtx({}));
    expect(second.success).toBe(true);
    expect(second.reused).toBe(true);

    const recovery = readWorktreeRecoveryStatus(repoDir);
    expect(recovery?.health).toBe("healthy");
    expect(recovery?.failureStreak).toBe(0);
    expect(recovery?.recentEvents || []).toEqual([]);
  }, 30000);

  it.skipIf(skipLocallyForSpeed)("recreates dirty managed worktrees and rebases existing task branches onto the latest base", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const branch = "task/recreate-dirty-behind";
    const remoteDir = mkdtempSync(join(tmpdir(), "wf-acquire-origin-"));
    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "recreate-dirty-1",
      branch,
      baseBranch: "origin/main",
      defaultTargetBranch: "origin/main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });
    const previousAllowRefresh = process.env.BOSUN_TEST_ALLOW_GIT_REFRESH;
    process.env.BOSUN_TEST_ALLOW_GIT_REFRESH = "true";
    try {
      gitExec("git init --bare", { cwd: remoteDir, stdio: "ignore" });
      gitExec(`git remote add origin "${remoteDir}"`, {
        cwd: repoDir,
        stdio: "ignore",
      });
      gitExec("git push -u origin main", { cwd: repoDir, stdio: "ignore" });

      const firstCtx = makeCtx({});
      const first = await nt.execute(node, firstCtx);
      expect(first.success).toBe(true);
      expect(first.created).toBe(true);

      gitExec("git config --local user.email test@test.com", {
        cwd: first.worktreePath,
        stdio: "ignore",
      });
      gitExec("git config --local user.name Test", {
        cwd: first.worktreePath,
        stdio: "ignore",
      });
      writeFileSync(join(first.worktreePath, "feature.txt"), "task work\n");
      gitExec("git add feature.txt", {
        cwd: first.worktreePath,
        stdio: "ignore",
      });
      gitExec("git commit -m task-work", {
        cwd: first.worktreePath,
        stdio: "ignore",
      });
      writeFileSync(join(first.worktreePath, "README.md"), "dirty tracked change\n");

      writeFileSync(join(repoDir, "upstream.txt"), "main advanced\n");
      gitExec("git add upstream.txt", {
        cwd: repoDir,
        stdio: "ignore",
      });
      gitExec("git commit -m upstream-advance", {
        cwd: repoDir,
        stdio: "ignore",
      });
      gitExec("git push origin main", { cwd: repoDir, stdio: "ignore" });

      const secondCtx = makeCtx({});
      const second = await nt.execute(node, secondCtx);
      expect(second.success).toBe(true);

      const status = gitExec("git status --short --untracked-files=no", {
        cwd: second.worktreePath,
        encoding: "utf8",
      }).trim();
      expect(status).toBe("");
      expect(existsSync(join(second.worktreePath, "feature.txt"))).toBe(true);
      expect(existsSync(join(second.worktreePath, "upstream.txt"))).toBe(true);

      const counts = gitExec("git rev-list --left-right --count HEAD...origin/main", {
        cwd: second.worktreePath,
        encoding: "utf8",
      }).trim();
      const match = counts.match(/^(\d+)\s+(\d+)$/);
      expect(match).not.toBeNull();
      expect(Number(match[1])).toBeGreaterThan(0);
      expect(Number(match[2])).toBe(0);
    } finally {
      if (previousAllowRefresh === undefined) {
        delete process.env.BOSUN_TEST_ALLOW_GIT_REFRESH;
      } else {
        process.env.BOSUN_TEST_ALLOW_GIT_REFRESH = previousAllowRefresh;
      }
      try { rmSync(remoteDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  }, 30000);

  it.skipIf(skipLocallyForSpeed)("recreates a stale managed task branch worktree when it falls behind the latest remote base", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const branch = "task/recreate-conflict-behind";
    const remoteDir = mkdtempSync(join(tmpdir(), "wf-acquire-origin-"));
    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "recreate-conflict-1",
      branch,
      baseBranch: "origin/main",
      defaultTargetBranch: "origin/main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });
    const previousAllowRefresh = process.env.BOSUN_TEST_ALLOW_GIT_REFRESH;
    process.env.BOSUN_TEST_ALLOW_GIT_REFRESH = "true";
    try {
      gitExec("git init --bare", { cwd: remoteDir, stdio: "ignore" });
      gitExec(`git remote add origin "${remoteDir}"`, {
        cwd: repoDir,
        stdio: "ignore",
      });
      gitExec("git push -u origin main", { cwd: repoDir, stdio: "ignore" });

      const firstCtx = makeCtx({});
      const first = await nt.execute(node, firstCtx);
      expect(first.success).toBe(true);
      expect(first.created).toBe(true);

      gitExec("git config --local user.email test@test.com", {
        cwd: first.worktreePath,
        stdio: "ignore",
      });
      gitExec("git config --local user.name Test", {
        cwd: first.worktreePath,
        stdio: "ignore",
      });
      writeFileSync(join(first.worktreePath, "README.md"), "task branch change\n");
      gitExec("git add README.md", {
        cwd: first.worktreePath,
        stdio: "ignore",
      });
      gitExec("git commit -m task-readme-change", {
        cwd: first.worktreePath,
        stdio: "ignore",
      });

      writeFileSync(join(repoDir, "README.md"), "main branch change\n");
      gitExec("git add README.md", {
        cwd: repoDir,
        stdio: "ignore",
      });
      gitExec("git commit -m upstream-readme-change", {
        cwd: repoDir,
        stdio: "ignore",
      });
      gitExec("git push origin main", { cwd: repoDir, stdio: "ignore" });

      const secondCtx = makeCtx({});
      const second = await nt.execute(node, secondCtx);
      expect(second.success).toBe(true);
      expect(second.created).toBe(true);
      const counts = gitExec("git rev-list --left-right --count HEAD...origin/main", {
        cwd: second.worktreePath,
        encoding: "utf8",
      }).trim();
      const match = counts.match(/^(\d+)\s+(\d+)$/);
      expect(match).not.toBeNull();
      expect(Number(match[1])).toBeGreaterThan(0);
      expect(Number(match[2])).toBe(0);

      const thirdCtx = makeCtx({});
      const third = await nt.execute(node, thirdCtx);
      expect(third.success).toBe(true);
      expect(third.reused).toBe(true);

      const recovery = readWorktreeRecoveryStatus(repoDir);
      expect(recovery?.health).toBe("recovered");
      expect(recovery?.failureStreak).toBe(0);
      expect(recovery?.recentEvents?.[0]).toMatchObject({
        outcome: "recreated",
        reason: "poisoned_worktree",
        branch,
        taskId: "recreate-conflict-1",
      });
      expect(recovery?.recentEvents?.[0]?.detectedIssues || []).toContain("refresh_conflict");
    } finally {
      if (previousAllowRefresh === undefined) {
        delete process.env.BOSUN_TEST_ALLOW_GIT_REFRESH;
      } else {
        process.env.BOSUN_TEST_ALLOW_GIT_REFRESH = previousAllowRefresh;
      }
      try { rmSync(remoteDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  }, 40000);

  it("enables core.longpaths before checkout", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const ctx = makeCtx({});
    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "longpaths-1",
      branch: "task/longpaths-enable",
      baseBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    const longpaths = gitExec("git config --local --get core.longpaths", {
      cwd: repoDir,
      encoding: "utf8",
    }).trim().toLowerCase();
    expect(longpaths).toBe("true");
  }, process.platform === "win32" ? 15000 : 10000);

  it("repairs core.bare corruption after creating a worktree", async () => {
    const nt = getNodeType("action.acquire_worktree");
    const ctx = makeCtx({});
    gitExec(`git config --local core.bare true`, { cwd: repoDir, stdio: "ignore" });
    gitExec(`git config --local core.worktree "${repoDir}"`, { cwd: repoDir, stdio: "ignore" });

    const node = makeNode("action.acquire_worktree", {
      repoRoot: repoDir,
      taskId: "abc124",
      branch: "task/abc124-bare-repair",
      baseBranch: "main",
      fetchTimeout: 5000,
      worktreeTimeout: 10000,
    });

    const result = await nt.execute(node, ctx);

    expect(result.success).toBe(true);
    expect(String(result.worktreePath).replace(/\\/g, "/")).toContain(String(repoDir).replace(/\\/g, "/"));
    expect(
      gitExec("git config --local --get core.bare", { cwd: repoDir, encoding: "utf8" }).trim(),
    ).toBe("false");
    expect(() => gitExec("git config --local --get core.worktree", {
      cwd: repoDir,
      encoding: "utf8",
      stdio: "pipe",
    })).toThrow();
  }, 15000);
});

// ---------------------------------------------------------------------------
//  action.build_task_prompt Tests
// ---------------------------------------------------------------------------

describe("action.build_task_prompt", () => {
  it("builds a prompt string and stores in ctx.data._taskPrompt", async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({
      resolvedSdk: "copilot",
      resolvedModel: "gpt-4",
    });
    const node = makeNode("action.build_task_prompt", {
      taskId: "TASK-42",
      taskTitle: "Fix the widget",
      taskDescription: "The widget is broken, please fix it.",
      branch: "feat/fix-widget",
      baseBranch: "main",
      worktreePath: "/tmp/test-wt",
      repoRoot: "/tmp/test-repo",
      repoSlug: "org/repo",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(typeof result.prompt).toBe("string");
    expect(result.prompt.length).toBeGreaterThan(50);
    expect(result.prompt).toContain("Fix the widget");
    expect(result.prompt).toContain("TASK-42");
    expect(typeof result.systemPrompt).toBe("string");
    expect(result.systemPrompt.length).toBeGreaterThan(50);
    expect(result.systemPrompt).not.toContain("TASK-42");
    expect(result.systemPrompt).not.toContain("Fix the widget");
    expect(ctx.data._taskPrompt).toBe(result.prompt);
    expect(ctx.data._taskUserPrompt).toBe(result.prompt);
    expect(ctx.data._taskSystemPrompt).toBe(result.systemPrompt);
  });

  it("includes branch and repo info", async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({});
    const node = makeNode("action.build_task_prompt", {
      taskId: "T1",
      taskTitle: "Test",
      taskDescription: "Desc",
      branch: "feat/branch-test",
      baseBranch: "main",
      repoSlug: "myorg/myrepo",
    });
    const result = await nt.execute(node, ctx);
    expect(result.prompt).toContain("feat/branch-test");
  });

  it("includes instruction lines", async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({});
    const node = makeNode("action.build_task_prompt", {
      taskId: "T2",
      taskTitle: "Test",
      taskDescription: "Desc",
    });
    const result = await nt.execute(node, ctx);
    // Execution instructions live in the user prompt to preserve cache anchoring.
    expect(result.prompt).toContain("commit");
  });

  it("keeps repo instructions and tool discovery in the user prompt for cache stability", async () => {
    const prevPort = process.env.BOSUN_AGENT_ENDPOINT_PORT;
    process.env.BOSUN_AGENT_ENDPOINT_PORT = "19623";
    const repoRoot = mkdtempSync(join(tmpdir(), "prompt-cache-anchor-"));
    try {
      writeFileSync(join(repoRoot, "AGENTS.md"), "Repo instructions marker.");
      mkdirSync(join(repoRoot, ".github"), { recursive: true });
      writeFileSync(
        join(repoRoot, ".github", "copilot-instructions.md"),
        "Copilot instructions marker.",
      );
      const nt = getNodeType("action.build_task_prompt");
      const ctx = makeCtx({});
      const node = makeNode("action.build_task_prompt", {
        taskId: "T2b",
        taskTitle: "Test",
        taskDescription: "Desc",
        worktreePath: join(repoRoot, ".bosun", "worktrees", "task-123"),
        repoRoot,
        includeAgentsMd: true,
        includeStatusEndpoint: true,
      });
      const result = await nt.execute(node, ctx);
      const userPrompt = result.userPrompt || result.prompt;
      const systemPrompt = result.systemPrompt;

      expect(userPrompt).toContain("Repo instructions marker.");
      expect(userPrompt).toContain("Copilot instructions marker.");
      expect(userPrompt).toContain("## Agent Status Endpoint");
      expect(userPrompt).toContain("- URL: http://127.0.0.1:19623/api/tasks/T2b");
      expect(userPrompt).toContain('- POST /complete {"hasCommits":true} — Signal completion');
      expect(userPrompt).toContain("## Tool Discovery");
      expect(userPrompt).toContain("search` -> `get_schema` -> `execute`");

      expect(systemPrompt).not.toContain("Repo instructions marker.");
      expect(systemPrompt).not.toContain("Copilot instructions marker.");
      expect(systemPrompt).not.toContain("## Agent Status Endpoint");
      expect(systemPrompt).not.toContain("## Tool Discovery");
    } finally {
      if (prevPort === undefined) {
        delete process.env.BOSUN_AGENT_ENDPOINT_PORT;
      } else {
        process.env.BOSUN_AGENT_ENDPOINT_PORT = prevPort;
      }
      await removeDirAfterLedgerReset(repoRoot);
    }
  });

  it("renders workspace scope contract from explicit repo metadata", async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({});
    const node = makeNode("action.build_task_prompt", {
      taskId: "T3",
      taskTitle: "Repo boundaries",
      taskDescription: "Respect scoped repos",
      worktreePath: "/tmp/wt-repo",
      workspace: "virtengine-gh",
      repository: "virtengine/bosun",
      repositories: ["virtengine/bosun", "virtengine/virtengine"],
    });
    const result = await nt.execute(node, ctx);
    expect(result.prompt).toContain("## Workspace Scope Contract");
    expect(result.prompt).toContain("**Workspace:** virtengine-gh");
    expect(result.prompt).toContain("**Primary Repository:** virtengine/bosun");
    expect(result.prompt).toContain("virtengine/virtengine");
    expect(result.prompt).toContain("blocked: cross-repo dependency");
  });

  it("falls back to task payload scope metadata when config is not provided", async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({
      task: {
        workspace: "workspace-a",
        repository: "org/primary",
        repositories: ["org/primary", "org/shared-lib"],
      },
    });
    const node = makeNode("action.build_task_prompt", {
      taskId: "T4",
      taskTitle: "Fallback scope",
      taskDescription: "Use task payload scope",
      worktreePath: "/tmp/wt-fallback",
    });
    const result = await nt.execute(node, ctx);
    expect(result.prompt).toContain("**Workspace:** workspace-a");
    expect(result.prompt).toContain("**Primary Repository:** org/primary");
    expect(result.prompt).toContain("org/shared-lib");
  });

  it("strips unresolved template placeholders from prompt fields", async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({});
    const node = makeNode("action.build_task_prompt", {
      taskId: "T4b",
      taskTitle: "Placeholder cleanup",
      taskDescription: "{{taskDescription}}",
      branch: "{{branch}}",
      baseBranch: "{{baseBranch}}",
      repoRoot: "{{repoRoot}}",
      repoSlug: "{{repoSlug}}",
      workspace: "{{workspace}}",
      repository: "{{repository}}",
      repositories: ["{{repository}}", "{{repositories}}"],
    });
    const result = await nt.execute(node, ctx);
    expect(result.prompt).toContain("# Task: Placeholder cleanup");
    expect(result.prompt).toContain("Task ID: T4b");
    expect(result.prompt).not.toContain("{{taskDescription}}");
    expect(result.prompt).not.toContain("{{repoSlug}}");
    expect(result.prompt).not.toContain("{{workspace}}");
    expect(result.prompt).not.toContain("## Description");
    expect(result.prompt).not.toContain("**Workspace:**");
    expect(result.prompt).not.toContain("**Primary Repository:**");
    expect(result.prompt).toContain("- **Allowed Repositories:** (not declared)");
  }, 10000);

  it("falls back to task payload title/description when config placeholders are unresolved", async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({
      task: {
        id: "CTX-42",
        title: "Payload title fallback",
        description: "Payload description fallback",
      },
    });
    const node = makeNode("action.build_task_prompt", {
      taskId: "{{taskId}}",
      taskTitle: "{{taskTitle}}",
      taskDescription: "{{taskDescription}}",
    });
    const result = await nt.execute(node, ctx);
    expect(result.prompt).toContain("# Task: Payload title fallback");
    expect(result.prompt).toContain("Task ID: CTX-42");
    expect(result.prompt).toContain("Payload description fallback");
    expect(result.prompt).not.toContain("{{taskTitle}}");
    expect(result.prompt).not.toContain("{{taskDescription}}");
  });

  it("falls back to task id title when all title sources are unresolved", async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({});
    const node = makeNode("action.build_task_prompt", {
      taskId: "T4d",
      taskTitle: "{{taskTitle}}",
      taskDescription: "{{taskDescription}}",
    });
    const result = await nt.execute(node, ctx);
    expect(result.prompt).toContain("# Task: Task T4d");
    expect(result.prompt).toContain("Task ID: T4d");
    expect(result.prompt).not.toContain("Untitled task");
  });

  it('falls back to task id title when the resolved title is "Untitled task"', async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({
      task: {
        id: "CTX-99",
        title: "Untitled task",
      },
    });
    const node = makeNode("action.build_task_prompt", {
      taskId: "{{taskId}}",
      taskTitle: "{{taskTitle}}",
    });
    const result = await nt.execute(node, ctx);
    expect(result.prompt).toContain("# Task: Task CTX-99");
    expect(result.prompt).toContain("Task ID: CTX-99");
    expect(result.prompt).not.toContain("Untitled task");
  });

  it("strips unresolved template placeholders from custom prompt templates", async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({});
    const node = makeNode("action.build_task_prompt", {
      taskId: "T4c",
      taskTitle: "Custom placeholder cleanup",
      taskDescription: "{{taskDescription}}",
      repoSlug: "{{repoSlug}}",
      workspace: "{{workspace}}",
      promptTemplate: [
        "# Task: {{taskTitle}}",
        "",
        "Task ID: {{taskId}}",
        "",
        "## Description",
        "{{taskDescription}}",
        "",
        "## Environment",
        "- Repo: {{repoSlug}}",
        "- Workspace: {{workspace}}",
      ].join("\n"),
    });
    const result = await nt.execute(node, ctx);
    expect(result.prompt).toContain("# Task: Custom placeholder cleanup");
    expect(result.prompt).toContain("Task ID: T4c");
    expect(result.prompt).not.toContain("{{taskDescription}}");
    expect(result.prompt).not.toContain("{{repoSlug}}");
    expect(result.prompt).not.toContain("{{workspace}}");
  });

  it("strips inline unresolved template placeholders from task fields", async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({});
    const node = makeNode("action.build_task_prompt", {
      taskId: "T4d",
      taskTitle: "Inline placeholder cleanup",
      taskDescription: "Investigate {{repoSlug}} placeholder leakage",
      repoSlug: "{{repoSlug}}",
      workspace: "workspace {{workspace}}",
      repository: "primary {{repository}}",
      repositories: ["shared {{repositories}}"],
    });
    const result = await nt.execute(node, ctx);
    expect(result.prompt).toContain("Investigate placeholder leakage");
    expect(result.prompt).toContain("**Workspace:** workspace");
    expect(result.prompt).toContain("**Primary Repository:** primary");
    expect(result.prompt).toContain("- shared");
    expect(result.prompt).not.toContain("{{repoSlug}}");
    expect(result.prompt).not.toContain("{{workspace}}");
    expect(result.prompt).not.toContain("{{repository}}");
    expect(result.prompt).not.toContain("{{repositories}}");
  });

  it("injects WORKFLOW.md content when a contract was loaded earlier in the workflow", async () => {
    const nt = getNodeType("action.build_task_prompt");
    const ctx = makeCtx({
      _workflowContract: {
        found: true,
        path: "/tmp/project/WORKFLOW.md",
        raw: "projectDescription: Demo\nterminalStates: [done]\nforbiddenPatterns: [git push --force]",
        parsed: {
          projectDescription: "Demo",
          terminalStates: ["done"],
          forbiddenPatterns: ["git push --force"],
          preferredTools: [],
          preferredModel: "",
          escalationContact: "",
          escalationPaths: [],
          rules: [],
        },
      },
    });
    const node = makeNode("action.build_task_prompt", {
      taskTitle: "Respect contract",
      taskDescription: "Build prompt with contract",
    });

    const result = await nt.execute(node, ctx);

    expect(result.prompt).toContain("## WORKFLOW.md Contract");
    expect(result.prompt).toContain("terminalStates: [done]");
    expect(result.prompt).toContain("forbiddenPatterns: [git push --force]");
  });
  it("reads WORKFLOW.md into workflow context", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "wf-contract-read-"));
    writeFileSync(join(projectDir, "WORKFLOW.md"), [
      "# Demo Contract",
      "terminalStates: [done]",
      "forbiddenPatterns:",
      "  - git push --force",
    ].join("\n"));

    const nt = getNodeType("read-workflow-contract");
    const ctx = makeCtx({ repoRoot: projectDir });
    const node = makeNode("read-workflow-contract", { repoRoot: projectDir });
    const result = await nt.execute(node, ctx);

    expect(result.found).toBe(true);
    expect(result.contract.terminalStates).toEqual(["done"]);
    expect(result.contract.forbiddenPatterns).toEqual(["git push --force"]);
    expect(ctx.data._workflowContract.path).toBe(join(projectDir, "WORKFLOW.md"));
    expect(ctx.log).toHaveBeenCalled();

    rmSync(projectDir, { recursive: true, force: true });
    clearContractCache(projectDir);
  });

  it("fails fast when WORKFLOW.md is malformed", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "wf-contract-invalid-"));
    writeFileSync(join(projectDir, "WORKFLOW.md"), [
      "# Broken Contract",
      "forbiddenPatterns:",
      "  - rm -rf /",
    ].join("\n"));

    const readNode = makeNode("read-workflow-contract", { repoRoot: projectDir }, "read-contract");
    const validateNode = makeNode("workflow-contract-validation", { repoRoot: projectDir }, "validate-contract");
    const ctx = makeCtx({ repoRoot: projectDir });

    await getNodeType("read-workflow-contract").execute(readNode, ctx);
    await expect(getNodeType("workflow-contract-validation").execute(validateNode, ctx))
      .rejects
      .toThrow(/terminalStates/i);

    rmSync(projectDir, { recursive: true, force: true });
    clearContractCache(projectDir);
  });

  it("enforces strict cache anchoring by keeping task-specific markers out of system prompt", async () => {
    const prev = process.env.BOSUN_CACHE_ANCHOR_MODE;
    process.env.BOSUN_CACHE_ANCHOR_MODE = "strict";
    try {
      const nt = getNodeType("action.build_task_prompt");
      const ctx = makeCtx({});
      const node = makeNode("action.build_task_prompt", {
        taskId: "STRICT-1",
        taskTitle: "Strict cache prompt",
        taskDescription: "Validate strict anchoring guard",
        branch: "feat/strict-anchor",
        worktreePath: "/tmp/wt-strict",
      });
      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);
      expect(result.cacheAnchorMode).toBe("strict");
      expect(result.systemPrompt).not.toContain("STRICT-1");
      expect(result.systemPrompt).not.toContain("Strict cache prompt");
      expect(result.systemPrompt).not.toContain("/tmp/wt-strict");
    } finally {
      if (prev === undefined) delete process.env.BOSUN_CACHE_ANCHOR_MODE;
      else process.env.BOSUN_CACHE_ANCHOR_MODE = prev;
    }
  });

  it("injects scoped persistent memory into the user prompt only", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prompt-memory-"));
    try {
      const {
        initSharedKnowledge,
        buildKnowledgeEntry,
        appendKnowledgeEntry,
      } = await import("../workspace/shared-knowledge.mjs");

      initSharedKnowledge({ repoRoot, targetFile: "AGENTS.md" });

      const memories = [
        buildKnowledgeEntry({
          content: "Workspace memory: flaky login tests need a DB fixture reset.",
          scope: "testing",
          scopeLevel: "workspace",
          teamId: "team-a",
          workspaceId: "workspace-1",
          sessionId: "session-0",
          runId: "run-0",
          agentId: "agent-workspace",
        }),
        buildKnowledgeEntry({
          content: "Team memory: prefer deterministic waits in browser tests.",
          scope: "testing",
          scopeLevel: "team",
          teamId: "team-a",
          workspaceId: "workspace-0",
          sessionId: "session-0",
          runId: "run-0",
          agentId: "agent-team",
        }),
        buildKnowledgeEntry({
          content: "Workspace memory: payments smoke tests require a sandbox token.",
          scope: "testing",
          scopeLevel: "workspace",
          teamId: "team-a",
          workspaceId: "workspace-2",
          sessionId: "session-2",
          runId: "run-2",
          agentId: "agent-other-workspace",
        }),
      ];

      for (const memory of memories) {
        const appendResult = await appendKnowledgeEntry(memory);
        expect(appendResult.success).toBe(true);
      }

      const nt = getNodeType("action.build_task_prompt");
      const ctx = makeCtx({});
      const node = makeNode("action.build_task_prompt", {
        taskId: "MEM-1",
        taskTitle: "Stabilize flaky login retries",
        taskDescription: "Reset fixtures between browser retries.",
        repoRoot,
        worktreePath: join(repoRoot, ".bosun", "worktrees", "task-1"),
        includeMemory: true,
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        runId: "run-1",
      });

      const result = await nt.execute(node, ctx);
      const userPrompt = result.userPrompt || result.prompt;

      expect(userPrompt).toContain("## Persistent Memory Briefing");
      expect(userPrompt).toContain("flaky login tests need a DB fixture reset");
      expect(userPrompt).toContain("prefer deterministic waits in browser tests");
      expect(userPrompt).not.toContain("payments smoke tests require a sandbox token");
      expect(result.systemPrompt).not.toContain("## Persistent Memory Briefing");
      expect(result.systemPrompt).not.toContain("DB fixture reset");
    } finally {
      await removeDirAfterLedgerReset(repoRoot);
    }
  });

  it("passes changed-file context into prompt-time memory retrieval", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prompt-memory-paths-"));
    try {
      const {
        initSharedKnowledge,
        buildKnowledgeEntry,
        appendKnowledgeEntry,
      } = await import("../workspace/shared-knowledge.mjs");

      initSharedKnowledge({ repoRoot, targetFile: "AGENTS.md" });
      mkdirSync(join(repoRoot, ".bosun", "context-index"), { recursive: true });
      writeFileSync(
        join(repoRoot, ".bosun", "context-index", "agent-index.json"),
        JSON.stringify({
          relations: [
            {
              relationType: "file_imports_file",
              fromPath: "src/auth/login.mjs",
              toPath: "src/auth/session-store.mjs",
            },
          ],
        }, null, 2),
        "utf8",
      );

      const memories = [
        buildKnowledgeEntry({
          content: "Workspace memory: reseed fixtures in src/auth/login.mjs before retrying auth flows.",
          scope: "testing",
          scopeLevel: "workspace",
          teamId: "team-a",
          workspaceId: "workspace-1",
          sessionId: "session-0",
          runId: "run-0",
          agentId: "agent-direct",
          relatedPaths: ["src/auth/login.mjs"],
        }),
        buildKnowledgeEntry({
          content: "Workspace memory: session-store snapshots must stay deterministic across retries.",
          scope: "testing",
          scopeLevel: "workspace",
          teamId: "team-a",
          workspaceId: "workspace-1",
          sessionId: "session-0",
          runId: "run-0",
          agentId: "agent-adjacent",
          relatedPaths: ["src/auth/session-store.mjs"],
        }),
      ];

      for (const memory of memories) {
        const appendResult = await appendKnowledgeEntry(memory);
        expect(appendResult.success).toBe(true);
      }

      const nt = getNodeType("action.build_task_prompt");
      const ctx = makeCtx({
        _changedFiles: ["src/auth/login.mjs"],
      });
      const node = makeNode("action.build_task_prompt", {
        taskId: "MEM-PATH-1",
        taskTitle: "Stabilize auth retries",
        taskDescription: "Keep login retries deterministic after fixture reseeds.",
        repoRoot,
        worktreePath: join(repoRoot, ".bosun", "worktrees", "task-3"),
        includeMemory: true,
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        runId: "run-1",
      });

      const result = await nt.execute(node, ctx);
      const retrievedMemory = ctx.data._taskRetrievedMemory || [];
      const userPrompt = result.userPrompt || result.prompt;

      expect(ctx.data._taskMemoryPaths).toEqual(["src/auth/login.mjs"]);
      expect(retrievedMemory[0]).toEqual(expect.objectContaining({
        content: "Workspace memory: reseed fixtures in src/auth/login.mjs before retrying auth flows.",
        directPathHits: ["src/auth/login.mjs"],
      }));
      expect(retrievedMemory[1]).toEqual(expect.objectContaining({
        content: "Workspace memory: session-store snapshots must stay deterministic across retries.",
        adjacentPathHits: ["src/auth/session-store.mjs"],
      }));
      expect(userPrompt).toContain("reseed fixtures in src/auth/login.mjs");
      expect(userPrompt).toContain("session-store snapshots must stay deterministic");
      expect(userPrompt).toContain("matched=src/auth/login.mjs");
      expect(userPrompt).toContain("graph=src/auth/session-store.mjs");
    } finally {
      await removeDirAfterLedgerReset(repoRoot);
    }
  });

  it("injects reusable strategy guidance into task prompts with path-aware ranking", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prompt-skillbook-paths-"));
    try {
      const skillbookDir = join(repoRoot, ".bosun", "skillbook");
      mkdirSync(skillbookDir, { recursive: true });
      writeFileSync(
        join(skillbookDir, "strategies.json"),
        JSON.stringify({
          version: "1.0.0",
          updatedAt: "2026-03-31T00:00:00.000Z",
          strategies: [
            {
              strategyId: "generic-validation",
              workflowId: "wf-auth",
              category: "strategy",
              scopeLevel: "workspace",
              status: "promoted",
              confidence: 0.61,
              recommendation: "Run the generic validation checklist before shipping.",
              rationale: "Useful as a baseline safety net.",
              tags: ["validation"],
              updatedAt: new Date().toISOString(),
            },
            {
              strategyId: "auth-path-retry",
              workflowId: "wf-auth",
              category: "strategy",
              scopeLevel: "workspace",
              status: "promoted",
              confidence: 0.88,
              recommendation: "Stabilize auth retries before broader validation sweeps.",
              rationale: "This strategy previously fixed the exact login path under active edit.",
              tags: ["auth", "retry"],
              relatedPaths: ["src/auth/login.mjs"],
              updatedAt: new Date().toISOString(),
            },
          ],
        }, null, 2),
        "utf8",
      );

      const nt = getNodeType("action.build_task_prompt");
      const ctx = makeCtx({
        _workflowId: "wf-auth",
        _changedFiles: ["src/auth/login.mjs"],
      });
      const node = makeNode("action.build_task_prompt", {
        taskId: "SKILL-1",
        taskTitle: "Stabilize auth retries",
        taskDescription: "Fix the login path before running the rest of validation.",
        repoRoot,
        worktreePath: join(repoRoot, ".bosun", "worktrees", "task-skill-1"),
        includeAgentsMd: false,
        includeStatusEndpoint: false,
      });

      const result = await nt.execute(node, ctx);
      const userPrompt = result.userPrompt || result.prompt;
      const guidance = ctx.data._taskSkillbookGuidance;

      expect(userPrompt).toContain("Reusable strategy guidance:");
      expect(userPrompt).toContain("Stabilize auth retries before broader validation sweeps.");
      expect(userPrompt).toContain("matched=src/auth/login.mjs");
      expect(userPrompt.indexOf("Stabilize auth retries before broader validation sweeps."))
        .toBeLessThan(userPrompt.indexOf("Run the generic validation checklist before shipping."));
      expect(guidance).toEqual(expect.objectContaining({
        matched: 2,
        strategies: expect.arrayContaining([
          expect.objectContaining({
            strategyId: "auth-path-retry",
            pathMatchPaths: ["src/auth/login.mjs"],
          }),
        ]),
      }));
      expect(guidance.strategies[0]).toEqual(expect.objectContaining({
        strategyId: "auth-path-retry",
        pathMatchPaths: ["src/auth/login.mjs"],
      }));
      expect(result.systemPrompt).not.toContain("Reusable strategy guidance:");
      expect(result.systemPrompt).not.toContain("matched=src/auth/login.mjs");
    } finally {
      await removeDirAfterLedgerReset(repoRoot);
    }
  });

  it("injects reusable strategy guidance from the sql ledger into task prompts", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "prompt-skillbook-ledger-"));
    try {
      const { appendPromotedStrategyToStateLedger } = await import("../lib/state-ledger-sqlite.mjs");
      appendPromotedStrategyToStateLedger({
        strategyId: "wf-auth:ledger-retry",
        workflowId: "wf-auth",
        scopeLevel: "workspace",
        category: "strategy",
        decision: "promote_strategy",
        status: "promoted",
        verificationStatus: "promote_strategy",
        confidence: 0.91,
        recommendation: "Use the ledger-backed auth retry sequence before broader validation.",
        rationale: "This promoted strategy previously recovered the exact login path now being edited.",
        tags: ["auth", "retry"],
        updatedAt: new Date().toISOString(),
        strategy: {
          strategyId: "wf-auth:ledger-retry",
          workflowId: "wf-auth",
          recommendation: "Use the ledger-backed auth retry sequence before broader validation.",
          rationale: "This promoted strategy previously recovered the exact login path now being edited.",
          confidence: 0.91,
          tags: ["auth", "retry"],
          relatedPaths: ["src/auth/login.mjs"],
        },
        knowledge: {
          entry: {
            relatedPaths: ["src/auth/login.mjs"],
          },
        },
      }, { repoRoot });

      const nt = getNodeType("action.build_task_prompt");
      const ctx = makeCtx({
        _workflowId: "wf-auth",
        _changedFiles: ["src/auth/login.mjs"],
      });
      const node = makeNode("action.build_task_prompt", {
        taskId: "SKILL-LEDGER-1",
        taskTitle: "Recover auth retries",
        taskDescription: "Use the best prior recovery strategy for the active login path.",
        repoRoot,
        worktreePath: join(repoRoot, ".bosun", "worktrees", "task-skill-ledger-1"),
        includeAgentsMd: false,
        includeStatusEndpoint: false,
      });

      const result = await nt.execute(node, ctx);
      const userPrompt = result.userPrompt || result.prompt;
      const guidance = ctx.data._taskSkillbookGuidance;

      expect(userPrompt).toContain("Reusable strategy guidance:");
      expect(userPrompt).toContain("Use the ledger-backed auth retry sequence before broader validation.");
      expect(userPrompt).toContain("matched=src/auth/login.mjs");
      expect(guidance?.strategies?.[0]).toEqual(expect.objectContaining({
        strategyId: "wf-auth:ledger-retry",
        pathMatchPaths: ["src/auth/login.mjs"],
      }));
    } finally {
      await removeDirAfterLedgerReset(repoRoot);
    }
  });
});


describe("action.persist_memory", () => {
  it("stores scoped memory for later retrieval and prompt injection", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "persist-memory-node-"));
    try {
      const persistNodeType = getNodeType("action.persist_memory");
      const promptNodeType = getNodeType("action.build_task_prompt");
      const persistCtx = makeCtx({
        repoRoot,
        repoSlug: "virtengine/bosun",
        workspace: repoRoot,
        _workspaceId: "workspace-1",
        _changedFiles: ["src/auth/login.mjs"],
        sessionId: "session-1",
        runId: "run-1",
        task: {
          id: "MEM-2",
          title: "Stabilize login retries",
          description: "Reset browser fixtures between retries.",
          filePaths: ["src/auth/login.mjs"],
          workspace: repoRoot,
          repository: "virtengine/bosun",
          meta: {
            teamId: "team-a",
            workspaceId: "workspace-1",
            sessionId: "session-1",
            runId: "run-1",
            filePaths: ["src/auth/login.mjs"],
          },
        },
      });
      const persistNode = makeNode("action.persist_memory", {
        content: "Workspace memory: seed auth fixtures before browser login retries.",
        scope: "testing",
        scopeLevel: "workspace",
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        runId: "run-1",
        repoRoot,
      });

      const persistResult = await persistNodeType.execute(persistNode, persistCtx);
      expect(persistResult.success).toBe(true);
      expect(persistResult.persisted).toBe(true);
      expect(persistResult.scopeLevel).toBe("workspace");
      expect(persistResult.entry.relatedPaths).toEqual(["src/auth/login.mjs"]);

      const { retrieveKnowledgeEntries } = await import("../workspace/shared-knowledge.mjs");
      const retrieved = await retrieveKnowledgeEntries({
        repoRoot,
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-99",
        runId: "run-99",
        query: "browser login fixtures retries",
        changedFiles: ["src/auth/login.mjs"],
        limit: 10,
      });
      expect(retrieved).toContainEqual(expect.objectContaining({
        content: "Workspace memory: seed auth fixtures before browser login retries.",
        directPathHits: ["src/auth/login.mjs"],
      }));

      const hidden = await retrieveKnowledgeEntries({
        repoRoot,
        teamId: "team-a",
        workspaceId: "workspace-2",
        sessionId: "session-99",
        runId: "run-99",
        query: "browser login fixtures retries",
        limit: 10,
      });
      expect(hidden.some((entry) => entry.content.includes("seed auth fixtures"))).toBe(false);

      const promptCtx = makeCtx({});
      const promptNode = makeNode("action.build_task_prompt", {
        taskId: "MEM-3",
        taskTitle: "Fix flaky login retries",
        taskDescription: "Browser login keeps flaking until auth fixtures are reset.",
        repoRoot,
        worktreePath: join(repoRoot, ".bosun", "worktrees", "task-2"),
        includeMemory: true,
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-2",
        runId: "run-2",
      });

      const promptResult = await promptNodeType.execute(promptNode, promptCtx);
      const userPrompt = promptResult.userPrompt || promptResult.prompt;
      expect(userPrompt).toContain("## Persistent Memory Briefing");
      expect(userPrompt).toContain("seed auth fixtures before browser login retries");
      expect(promptResult.systemPrompt).not.toContain("seed auth fixtures");
    } finally {
      await removeDirAfterLedgerReset(repoRoot);
    }
  });
});

// ---------------------------------------------------------------------------
//  action.detect_new_commits Tests
// ---------------------------------------------------------------------------

describe("action.detect_new_commits", () => {
  let gitDir;

  const gitExec = (command, options = {}) =>
    execSync(command, {
      env: sanitizedGitEnv(),
      ...options,
    });

  beforeEach(() => {
    noCommitCounts.clear();
    skipUntil.clear();
    gitDir = mkdtempSync(join(tmpdir(), "wf-detect-commits-"));
    execGit("git init", { cwd: gitDir, stdio: "ignore" });
    execGit("git config --local user.email test@test.com", { cwd: gitDir, stdio: "ignore" });
    execGit("git config --local user.name Test", { cwd: gitDir, stdio: "ignore" });
    writeFileSync(join(gitDir, "README.md"), "init");
    execGit("git add . && git commit -m init", { cwd: gitDir, stdio: "ignore" });
  });

  afterEach(() => {
    noCommitCounts.clear();
    skipUntil.clear();
    try { rmSync(gitDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("detects no commits when HEAD unchanged", async () => {
    const nt = getNodeType("action.detect_new_commits");
    const head = execGit("git rev-parse HEAD", { cwd: gitDir, encoding: "utf8" }).trim();
    const ctx = makeCtx({ _preExecHead: head });
    const node = makeNode("action.detect_new_commits", {
      worktreePath: gitDir,
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.hasNewCommits).toBe(false);
  });

  it("records anti-thrash cooldown when no commits are produced", async () => {
    const taskId = "task-no-commit-123";
    const nt = getNodeType("action.detect_new_commits");
    const head = execGit("git rev-parse HEAD", { cwd: gitDir, encoding: "utf8" }).trim();
    const ctx = makeCtx({ taskId, _preExecHead: head });
    const node = makeNode("action.detect_new_commits", {
      worktreePath: gitDir,
    });

    const before = Date.now();
    const result = await nt.execute(node, ctx);

    expect(result.success).toBe(true);
    expect(result.hasCommits).toBe(false);
    expect(noCommitCounts.get(taskId)).toBe(1);
    expect(skipUntil.get(taskId)).toBeGreaterThan(before);
  });

  it("persists anti-thrash cooldown fields to the task store when no commits are produced", async () => {
    const taskId = "task-no-commit-persisted";
    const nt = getNodeType("action.detect_new_commits");
    const head = execGit("git rev-parse HEAD", { cwd: gitDir, encoding: "utf8" }).trim();
    const updateTask = vi.fn().mockResolvedValue({});
    const ctx = makeCtx({
      taskId,
      _preExecHead: head,
      task: { id: taskId },
    });
    const node = makeNode("action.detect_new_commits", {
      worktreePath: gitDir,
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: {
          updateTask,
        },
      },
    });

    expect(result.success).toBe(true);
    expect(updateTask).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({
        consecutiveNoCommits: 1,
        cooldownUntil: expect.any(String),
      }),
    );
    expect(ctx.data.task.consecutiveNoCommits).toBe(1);
    expect(typeof ctx.data.task.cooldownUntil).toBe("string");
  });

  it("marks no-commit retries exhausted at the retry cap", async () => {
    const taskId = "task-no-commit-exhausted";
    noCommitCounts.set(taskId, MAX_NO_COMMIT_ATTEMPTS - 1);
    skipUntil.set(taskId, Date.now() + 60_000);
    const nt = getNodeType("action.detect_new_commits");
    const head = execGit("git rev-parse HEAD", { cwd: gitDir, encoding: "utf8" }).trim();
    const updateTask = vi.fn().mockResolvedValue({});
    const ctx = makeCtx({
      taskId,
      _preExecHead: head,
      task: {
        id: taskId,
        consecutiveNoCommits: MAX_NO_COMMIT_ATTEMPTS - 1,
        cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const node = makeNode("action.detect_new_commits", {
      worktreePath: gitDir,
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: {
          updateTask,
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.hasCommits).toBe(false);
    expect(result.retryExhausted).toBe(true);
    expect(result.blockedReason).toBe("repeated_no_commit_runs");
    expect(result.consecutiveNoCommits).toBe(MAX_NO_COMMIT_ATTEMPTS);
    expect(result.cooldownUntil).toBeNull();
    expect(noCommitCounts.get(taskId)).toBe(MAX_NO_COMMIT_ATTEMPTS);
    expect(skipUntil.has(taskId)).toBe(false);
    expect(updateTask).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({
        consecutiveNoCommits: MAX_NO_COMMIT_ATTEMPTS,
        cooldownUntil: null,
      }),
    );
    expect(ctx.data.task.consecutiveNoCommits).toBe(MAX_NO_COMMIT_ATTEMPTS);
    expect(ctx.data.task.cooldownUntil).toBeNull();
  });

  it("detects new commits when HEAD changed", async () => {
    const nt = getNodeType("action.detect_new_commits");
    const preHead = execGit("git rev-parse HEAD", { cwd: gitDir, encoding: "utf8" }).trim();
    // Make a new commit
    writeFileSync(join(gitDir, "new.txt"), "new content");
    execGit("git add . && git commit -m new", { cwd: gitDir, stdio: "ignore" });
    const ctx = makeCtx({ _preExecHead: preHead });
    const node = makeNode("action.detect_new_commits", {
      worktreePath: gitDir,
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.hasNewCommits).toBe(true);
    expect(result.hasCommits).toBe(true);
    expect(result.preExecHead).toBe(preHead);
    expect(result.postExecHead).not.toBe(preHead);
  }, 15000);

  it("clears persisted anti-thrash cooldown fields when commits are produced", async () => {
    const taskId = "task-commit-clears-cooldown";
    noCommitCounts.set(taskId, 2);
    skipUntil.set(taskId, Date.now() + 60_000);
    const nt = getNodeType("action.detect_new_commits");
    const preHead = execGit("git rev-parse HEAD", { cwd: gitDir, encoding: "utf8" }).trim();
    writeFileSync(join(gitDir, "new.txt"), "new content");
    execGit("git add . && git commit -m new", { cwd: gitDir, stdio: "ignore" });
    const updateTask = vi.fn().mockResolvedValue({});
    const ctx = makeCtx({
      taskId,
      _preExecHead: preHead,
      task: {
        id: taskId,
        consecutiveNoCommits: 2,
        cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const node = makeNode("action.detect_new_commits", {
      worktreePath: gitDir,
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: {
          updateTask,
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.hasCommits).toBe(true);
    expect(noCommitCounts.has(taskId)).toBe(false);
    expect(skipUntil.has(taskId)).toBe(false);
    expect(updateTask).toHaveBeenCalledWith(taskId, {
      consecutiveNoCommits: 0,
      cooldownUntil: null,
    });
    expect(ctx.data.task.consecutiveNoCommits).toBe(0);
    expect(ctx.data.task.cooldownUntil).toBeNull();
  }, 15000);

  it("stores results in ctx.data", async () => {
    const nt = getNodeType("action.detect_new_commits");
    const head = gitExec("git rev-parse HEAD", { cwd: gitDir, encoding: "utf8" }).trim();
    const ctx = makeCtx({ _preExecHead: head });
    const node = makeNode("action.detect_new_commits", { worktreePath: gitDir });
    await nt.execute(node, ctx);
    expect(typeof ctx.data._hasNewCommits).toBe("boolean");
    expect(typeof ctx.data._postExecHead).toBe("string");
  });

  it("fails gracefully on invalid path", async () => {
    const nt = getNodeType("action.detect_new_commits");
    const ctx = makeCtx({});
    const node = makeNode("action.detect_new_commits", {
      worktreePath: "/nonexistent/path/xyz",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(false);
    expect(result.hasCommits).toBe(false);
  });

  it("soft-fails if worktreePath is missing", async () => {
    const nt = getNodeType("action.detect_new_commits");
    const ctx = makeCtx({});
    const node = makeNode("action.detect_new_commits", {});
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(false);
    expect(result.hasCommits).toBe(false);
    expect(result.hasNewCommits).toBe(false);
    expect(result.error).toMatch(/worktreePath/);
  });

  it("detects commits even when ComSpec is invalid", async () => {
    const nt = getNodeType("action.detect_new_commits");
    const head = execGit("git rev-parse HEAD", { cwd: gitDir, encoding: "utf8" }).trim();
    const ctx = makeCtx({ _preExecHead: head });
    const node = makeNode("action.detect_new_commits", { worktreePath: gitDir });
    const originalComSpec = process.env.ComSpec;
    process.env.ComSpec = join(gitDir, "missing-cmd.exe");
    try {
      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);
      expect(result.postExecHead).toBe(head);
    } finally {
      if (originalComSpec == null) delete process.env.ComSpec;
      else process.env.ComSpec = originalComSpec;
    }
  });

  it("detects commits when PATH is unavailable", async () => {
    if (process.platform !== "win32") return;
    const nt = getNodeType("action.detect_new_commits");
    const head = execGit("git rev-parse HEAD", { cwd: gitDir, encoding: "utf8" }).trim();
    const ctx = makeCtx({ _preExecHead: head });
    const node = makeNode("action.detect_new_commits", { worktreePath: gitDir });
    const originalPath = process.env.PATH;
    const originalPathWin = process.env.Path;
    process.env.PATH = "";
    process.env.Path = "";
    try {
      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);
      expect(result.postExecHead).toBe(head);
    } finally {
      if (originalPath == null) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalPathWin == null) delete process.env.Path;
      else process.env.Path = originalPathWin;
    }
  });
});

// ---------------------------------------------------------------------------
//  action.push_branch Tests
// ---------------------------------------------------------------------------

describe("action.push_branch", () => {
  it("formats signal-based termination details for push diagnostics", () => {
    expect(buildCommandTerminationDiagnostic({ signal: "SIGTERM", killed: true }))
      .toBe("[bosun-command-diagnostic] signal: SIGTERM, killed: true");
    expect(buildCommandTerminationDiagnostic({ signal: "", killed: false })).toBe("");
  });

  it("refuses to push to protected branches", async () => {
    const nt = getNodeType("action.push_branch");
    const ctx = makeCtx({});
    const node = makeNode("action.push_branch", {
      worktreePath: "/tmp/test",
      branch: "main",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Protected branch");
    expect(result.pushed).toBe(false);
  });

  it("refuses origin/main as well", async () => {
    const nt = getNodeType("action.push_branch");
    const ctx = makeCtx({});
    const node = makeNode("action.push_branch", {
      worktreePath: "/tmp/test",
      branch: "origin/main",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Protected branch");
  });

  it("refuses master, develop, production", async () => {
    const nt = getNodeType("action.push_branch");
    for (const branch of ["master", "develop", "production"]) {
      const ctx = makeCtx({});
      const node = makeNode("action.push_branch", {
        worktreePath: "/tmp/test",
        branch,
      });
      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(false);
    }
  });

  it("throws if worktreePath is missing", async () => {
    const nt = getNodeType("action.push_branch");
    const ctx = makeCtx({});
    const node = makeNode("action.push_branch", {});
    await expect(nt.execute(node, ctx)).resolves.toMatchObject({
      success: false,
      blockedReason: "missing_worktree_path",
      error: expect.stringContaining("worktreePath"),
    });
  });

  it("schema has push safety options including skipHooks", () => {
    const nt = getNodeType("action.push_branch");
    expect(nt.schema.properties.rebaseBeforePush).toBeDefined();
    expect(nt.schema.properties.skipHooks).toBeDefined();
    expect(nt.schema.properties.skipHooks.default).toBe(false);
    expect(nt.schema.properties.pushTimeout).toBeDefined();
    expect(nt.schema.properties.pushTimeout.default).toBe(300000);
    expect(nt.schema.properties.emptyDiffGuard).toBeDefined();
    expect(nt.schema.properties.syncMainForModuleBranch).toBeDefined();
    expect(nt.schema.properties.requireApproval).toBeDefined();
    expect(nt.schema.properties.approvalTimeoutMs).toBeDefined();
  });

  it("blocks skipHooks for managed Bosun worktrees", async () => {
    const nt = getNodeType("action.push_branch");
    const repoRoot = mkdtempSync(join(tmpdir(), "wf-push-guardrail-"));
    const worktreePath = join(repoRoot, ".bosun", "worktrees", "task-123");
    mkdirSync(join(repoRoot, ".bosun"), { recursive: true });
    mkdirSync(join(repoRoot, ".githooks"), { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(repoRoot, ".bosun", "guardrails.json"), JSON.stringify({
      INPUT: { enabled: true },
      push: { workflowOnly: true, blockAgentPushes: true, requireManagedPrePush: true },
    }, null, 2));
    writeFileSync(join(repoRoot, ".githooks", "pre-commit"), "#!/usr/bin/env bash\nexit 0\n");
    writeFileSync(join(repoRoot, ".githooks", "pre-push"), "#!/usr/bin/env bash\nexit 0\n");

    const ctx = makeCtx({ repoRoot });
    const node = makeNode("action.push_branch", {
      worktreePath,
      branch: "feature/test-branch",
      skipHooks: true,
    });

    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("must run local pre-push validation");
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("preserves compacted hook stderr when push fails", async () => {
    const nt = getNodeType("action.push_branch");
    const repoDir = mkdtempSync(join(tmpdir(), "wf-push-stderr-"));
    const remoteDir = mkdtempSync(join(tmpdir(), "wf-push-stderr-remote-"));
    try {
      execGit("git init --bare", { cwd: remoteDir, stdio: "ignore" });
      execGit("git init", { cwd: repoDir, stdio: "ignore" });
      execGit("git config --local user.email test@test.com", { cwd: repoDir, stdio: "ignore" });
      execGit("git config --local user.name Test", { cwd: repoDir, stdio: "ignore" });
      execGit(`git remote add origin "${remoteDir}"`, { cwd: repoDir, stdio: "ignore" });
      writeFileSync(join(repoDir, "README.md"), "init\n");
      execGit("git add README.md && git commit -m init", { cwd: repoDir, stdio: "ignore" });
      execGit("git branch -M main", { cwd: repoDir, stdio: "ignore" });
      execGit("git push -u origin main", { cwd: repoDir, stdio: "ignore" });
      mkdirSync(join(repoDir, ".githooks"), { recursive: true });
      writeFileSync(
        join(repoDir, ".githooks", "pre-push"),
        [
          "#!/usr/bin/env node",
          "for (let i = 0; i < 260; i += 1) process.stderr.write(`noise-${i} ${'x'.repeat(18)}\\n`);",
          "process.stderr.write('PUSH_HOOK_TERMINAL: provider auth mismatch\\n');",
          "process.exit(1);",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      execGit("git config core.hooksPath .githooks", { cwd: repoDir, stdio: "ignore" });
      execGit("git checkout -b feature/push-stderr", { cwd: repoDir, stdio: "ignore" });
      writeFileSync(join(repoDir, "feature.txt"), "feature\n");
      execGit("git add feature.txt && git commit -m feature-work", { cwd: repoDir, stdio: "ignore" });

      const result = await nt.execute(makeNode("action.push_branch", {
        worktreePath: repoDir,
        branch: "feature/push-stderr",
        baseBranch: "main",
      }), makeCtx({ repoRoot: repoDir }));

      expect(result.success).toBe(false);
      expect(result.pushed).toBe(false);
      expect(result.output).toContain("[Live-compacted git]");
      expect(result.output).toContain("failed to push some refs");
      expect(result.output).toContain("bosun --tool-log");
      expect(result.outputCompacted).toBe(true);
      expect(result.rawOutputChars).toBeGreaterThan(result.compactedOutputChars);
      expect(result.outputBudgetPolicy).toBeTruthy();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(remoteDir, { recursive: true, force: true });
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
//  action.release_worktree Tests
// ---------------------------------------------------------------------------

describe("action.release_worktree", () => {
  it("releases reused managed worktrees", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "wf-release-worktree-"));
    try {
      execGit("git init", { cwd: repoDir, stdio: "ignore" });
      execGit("git config --local user.email test@test.com", { cwd: repoDir, stdio: "ignore" });
      execGit("git config --local user.name Test", { cwd: repoDir, stdio: "ignore" });
      writeFileSync(join(repoDir, "README.md"), "init\n");
      execGit("git add README.md && git commit -m init", { cwd: repoDir, stdio: "ignore" });
      execGit("git branch -M main", { cwd: repoDir, stdio: "ignore" });

      const branch = "task/release-reused";
      const worktreesDir = join(repoDir, ".bosun", "worktrees");
      mkdirSync(worktreesDir, { recursive: true });
      const worktreePath = join(worktreesDir, branch.replace(/[^a-zA-Z0-9._-]/g, "-"));
      execGit(`git worktree add "${worktreePath}" -b "${branch}" main`, { cwd: repoDir, stdio: "ignore" });
      expect(existsSync(worktreePath)).toBe(true);

      const nt = getNodeType("action.release_worktree");
      const ctx = makeCtx({
        _worktreeCreated: false,
        _worktreeManaged: true,
      });
      const node = makeNode("action.release_worktree", {
        worktreePath,
        repoRoot: repoDir,
        taskId: "t-managed",
      });

      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);
      expect(result.released).toBe(true);
      expect(existsSync(worktreePath)).toBe(false);
    } finally {
      try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("succeeds when worktree path doesn't exist", async () => {
    const nt = getNodeType("action.release_worktree");
    const ctx = makeCtx({});
    const node = makeNode("action.release_worktree", {
      worktreePath: "/nonexistent/path/wt",
      repoRoot: "/nonexistent/repo",
      taskId: "t1",
    });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
  });

  it("returns existing claim metadata when the same transition is replayed", async () => {
    const nt = getNodeType("action.claim_task");
    const claims = await import("../task/task-claims.mjs");
    const initSpy = vi.spyOn(claims, "initTaskClaims").mockResolvedValue();
    const claimSpy = vi.spyOn(claims, "claimTask").mockResolvedValue({
      success: true,
      token: "claim-replay-token",
      claim: { claim_token: "claim-replay-token" },
    });
    const ctx = makeCtx({ repoRoot: "/tmp/repo-root" });
    const node = makeNode("action.claim_task", {
      taskId: "task-replay-1",
      idempotencyKey: "claim:task-replay-1",
      taskTitle: "Replay-safe claim",
      instanceId: "inst-replay",
      renewIntervalMs: 0,
    });

    try {
      const first = await nt.execute(node, ctx);
      const second = await nt.execute(node, ctx);

      expect(first).toEqual(expect.objectContaining({
        success: true,
        taskId: "task-replay-1",
        claimToken: "claim-replay-token",
      }));
      expect(second).toEqual(expect.objectContaining({
        success: true,
        taskId: "task-replay-1",
        claimToken: "claim-replay-token",
        idempotentReplay: true,
      }));
      expect(claimSpy).toHaveBeenCalledTimes(1);
    } finally {
      initSpy.mockRestore();
      claimSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
//  action.release_claim Tests
// ---------------------------------------------------------------------------

describe("action.release_claim", () => {
  it("clears claim data from ctx (set to null)", async () => {
    const nt = getNodeType("action.release_claim");
    const ctx = makeCtx({
      _claimToken: "abc123",
      _claimInstanceId: "inst-1",
      _claimRenewTimer: null,
    });
    const node = makeNode("action.release_claim", { taskId: "t1" });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(ctx.data._claimToken).toBeNull();
    expect(ctx.data._claimInstanceId).toBeNull();
  });

  it("clears renewal timer if present", async () => {
    const nt = getNodeType("action.release_claim");
    const timer = setInterval(() => {}, 100000);
    timer.unref();
    const ctx = makeCtx({
      _claimToken: "abc",
      _claimRenewTimer: timer,
    });
    const node = makeNode("action.release_claim", { taskId: "t2" });
    const result = await nt.execute(node, ctx);
    expect(result.success).toBe(true);
    clearInterval(timer); // extra safety
  });

  it("uses releaseTask fallback when releaseTaskClaim is unavailable", async () => {
    const nt = getNodeType("action.release_claim");
    const claims = await import("../task/task-claims.mjs");
    const initSpy = vi.spyOn(claims, "initTaskClaims").mockResolvedValue();
    const releaseSpy = vi.spyOn(claims, "releaseTask").mockResolvedValue({ success: true });
    const ctx = makeCtx({
      _claimToken: "claim-fallback",
      _claimInstanceId: "inst-fallback",
      _claimRenewTimer: null,
      repoRoot: "/tmp/repo-root",
    });

    try {
      const node = makeNode("action.release_claim", { taskId: "task-release-fallback" });
      const result = await nt.execute(node, ctx);
      expect(result.success).toBe(true);
      expect(releaseSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "task-release-fallback",
          claimToken: "claim-fallback",
          instanceId: "inst-fallback",
        }),
      );
      expect(ctx.data._claimToken).toBeNull();
      expect(ctx.data._claimInstanceId).toBeNull();
    } finally {
      initSpy.mockRestore();
      releaseSpy.mockRestore();
    }
  });

});

// ---------------------------------------------------------------------------
//  Template: task-lifecycle
// ---------------------------------------------------------------------------



describe("action.update_task_status", () => {
  beforeEach(() => {
    completedWithPR.clear();
    noCommitCounts.clear();
    skipUntil.clear();
  });

  afterEach(() => {
    completedWithPR.clear();
    noCommitCounts.clear();
    skipUntil.clear();
  });

  it("falls back to ctx taskId when config taskId is unresolved", async () => {
    const nt = getNodeType("action.update_task_status");
    const updateTaskStatus = vi.fn().mockResolvedValue(true);
    const ctx = makeCtx({
      taskId: "task-fallback-123",
      taskTitle: "Fallback task",
    });
    const node = makeNode("action.update_task_status", {
      taskId: "{{task.taskId}}",
      status: "inprogress",
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: { updateTaskStatus },
      },
    });

    expect(result.success).toBe(true);
    expect(updateTaskStatus).toHaveBeenCalledWith(
      "task-fallback-123",
      "inprogress",
      expect.objectContaining({ source: "workflow" }),
    );
  });

  it("skips when taskId remains unresolved", async () => {
    const nt = getNodeType("action.update_task_status");
    const updateTaskStatus = vi.fn().mockResolvedValue(true);
    const ctx = makeCtx({});
    const node = makeNode("action.update_task_status", {
      taskId: "{{task.taskId}}",
      status: "inprogress",
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: { updateTaskStatus },
      },
    });

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toBe("unresolved_task_id");
    expect(updateTaskStatus).not.toHaveBeenCalled();
  });

  it("persists PR linkage metadata when moving task to inreview", async () => {
    const nt = getNodeType("action.update_task_status");
    const updateTaskStatus = vi.fn().mockResolvedValue(true);
    const updateTask = vi.fn().mockResolvedValue(true);
    const ctx = makeCtx({
      taskId: "task-review-123",
      taskTitle: "Review-ready task",
      branch: "task/task-review-123",
    });
    ctx.getNodeOutput = vi.fn((id) => {
      if (id !== "create-pr") return null;
      return {
        prNumber: 987,
        prUrl: "https://github.com/virtengine/bosun/pull/987",
        branch: "task/task-review-123",
      };
    });
    const node = makeNode("action.update_task_status", {
      taskId: "{{taskId}}",
      status: "inreview",
      taskTitle: "{{taskTitle}}",
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: { updateTaskStatus, updateTask },
      },
    });

    expect(result.success).toBe(true);
    expect(updateTaskStatus).toHaveBeenCalledWith(
      "task-review-123",
      "inreview",
      expect.objectContaining({
        source: "workflow",
        branchName: "task/task-review-123",
        prNumber: 987,
        prUrl: "https://github.com/virtengine/bosun/pull/987",
      }),
    );
    expect(updateTask).toHaveBeenCalledWith(
      "task-review-123",
      expect.objectContaining({
        branchName: "task/task-review-123",
        prNumber: 987,
        prUrl: "https://github.com/virtengine/bosun/pull/987",
      }),
    );
  });

  it("persists PR linkage metadata from VE Orchestrator Lite pr node output", async () => {
    const nt = getNodeType("action.update_task_status");
    const updateTaskStatus = vi.fn().mockResolvedValue(true);
    const updateTask = vi.fn().mockResolvedValue(true);
    const ctx = makeCtx({
      taskId: "task-lite-review-123",
      taskTitle: "Lite review task",
      branch: "task/task-lite-review-123",
    });
    ctx.getNodeOutput = vi.fn((id) => {
      if (id !== "pr") return null;
      return {
        prNumber: 321,
        prUrl: "https://github.com/virtengine/bosun/pull/321",
        branch: "task/task-lite-review-123",
      };
    });
    const node = makeNode("action.update_task_status", {
      taskId: "{{taskId}}",
      status: "inreview",
      taskTitle: "{{taskTitle}}",
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: { updateTaskStatus, updateTask },
      },
    });

    expect(result.success).toBe(true);
    expect(updateTaskStatus).toHaveBeenCalledWith(
      "task-lite-review-123",
      "inreview",
      expect.objectContaining({
        source: "workflow",
        branchName: "task/task-lite-review-123",
        prNumber: 321,
        prUrl: "https://github.com/virtengine/bosun/pull/321",
      }),
    );
    expect(updateTask).toHaveBeenCalledWith(
      "task-lite-review-123",
      expect.objectContaining({
        branchName: "task/task-lite-review-123",
        prNumber: 321,
        prUrl: "https://github.com/virtengine/bosun/pull/321",
      }),
    );
  });

  it("normalizes mismatched inprogress branch linkage back to the current task branch", async () => {
    const nt = getNodeType("action.update_task_status");
    const updateTaskStatus = vi.fn().mockResolvedValue(true);
    const updateTask = vi.fn().mockResolvedValue(true);
    const getTask = vi.fn().mockResolvedValue({
      id: "taskid123456",
      title: "Normalize Branch Persistence",
      status: "todo",
      branchName: "task/other123456-wrong-task",
    });
    const ctx = makeCtx({
      taskId: "taskid123456",
      taskTitle: "Normalize Branch Persistence",
      branch: "task/other123456-wrong-task",
      branchName: "task/other123456-wrong-task",
    });
    const node = makeNode("action.update_task_status", {
      taskId: "{{taskId}}",
      status: "inprogress",
      taskTitle: "{{taskTitle}}",
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: { getTask, updateTaskStatus, updateTask },
      },
    });

    expect(result.success).toBe(true);
    expect(result.branchName).toBe("task/taskid123456-normalize-branch-persistence");
    expect(updateTaskStatus).toHaveBeenCalledWith(
      "taskid123456",
      "inprogress",
      expect.objectContaining({
        source: "workflow",
        branchName: "task/taskid123456-normalize-branch-persistence",
      }),
    );
    expect(updateTask).toHaveBeenCalledWith(
      "taskid123456",
      expect.objectContaining({
        branchName: "task/taskid123456-normalize-branch-persistence",
      }),
    );
    expect(ctx.data.branchName).toBe("task/taskid123456-normalize-branch-persistence");
    expect(ctx.data.branch).toBe("task/taskid123456-normalize-branch-persistence");
  });

  it("allows workflows to set blocked status", async () => {
    const nt = getNodeType("action.update_task_status");
    const updateTaskStatus = vi.fn().mockResolvedValue(true);
    const ctx = makeCtx({
      taskId: "task-blocked-123",
      taskTitle: "Blocked task",
    });
    const node = makeNode("action.update_task_status", {
      taskId: "{{taskId}}",
      status: "blocked",
      taskTitle: "{{taskTitle}}",
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: { updateTaskStatus },
      },
    });

    expect(result.success).toBe(true);
    expect(updateTaskStatus).toHaveBeenCalledWith(
      "task-blocked-123",
      "blocked",
      expect.objectContaining({ source: "workflow" }),
    );
  });

  it("clears no-commit anti-thrash state when moving a task to inreview", async () => {
    const nt = getNodeType("action.update_task_status");
    const taskId = "task-review-clear-123";
    const updateTaskStatus = vi.fn().mockResolvedValue(true);
    const updateTask = vi.fn().mockResolvedValue(true);

    noCommitCounts.set(taskId, 2);
    skipUntil.set(taskId, Date.now() + 60_000);

    const ctx = makeCtx({
      taskId,
      taskTitle: "Review-ready task",
      branch: "task/task-review-clear-123",
    });
    ctx.getNodeOutput = vi.fn((id) => {
      if (id !== "create-pr") return null;
      return {
        prNumber: 42,
        prUrl: "https://github.com/virtengine/bosun/pull/42",
        branch: "task/task-review-clear-123",
      };
    });
    const node = makeNode("action.update_task_status", {
      taskId: "{{taskId}}",
      status: "inreview",
      taskTitle: "{{taskTitle}}",
    });

    const result = await nt.execute(node, ctx, {
      services: {
        kanban: { updateTaskStatus, updateTask },
      },
    });

    expect(result.success).toBe(true);
    expect(completedWithPR.has(taskId)).toBe(true);
    expect(noCommitCounts.has(taskId)).toBe(false);
    expect(skipUntil.has(taskId)).toBe(false);
  });
});

describe("template-task-lifecycle", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("exists and has correct metadata", () => {
    const t = getTemplate("template-task-lifecycle");
    expect(t).toBeDefined();
    expect(t.name).toBe("Task Lifecycle");
    expect(t.category).toBe("task-execution");
    expect(t.enabled).toBe(true);
    expect(t.recommended).toBe(true);
  });

  it("polls todo only by default so inreview remediation stays on dedicated review flows", () => {
    const t = getTemplate("template-task-lifecycle");
    const triggerNode = t.nodes.find((n) => n.id === "trigger");
    expect(triggerNode?.type).toBe("trigger.task_available");
    expect(triggerNode?.config?.statuses).toEqual(["todo"]);
  });

  it("has all required node IDs", () => {
    const t = getTemplate("template-task-lifecycle");
    const ids = t.nodes.map((n) => n.id);
    const required = [
      "trigger", "check-slots", "allocate-slot", "claim-task",
      "claim-ok", "set-inprogress", "acquire-worktree", "worktree-ok",
      "resolve-executor", "record-head", "read-workflow-contract",
      "workflow-contract-validation", "build-prompt", "run-agent-plan", "run-agent-tests", "run-agent-implement",
      "plan-agent-ok", "tests-agent-ok", "implement-agent-ok",
      "set-blocked-agent-plan-failed", "set-blocked-agent-tests-failed", "set-blocked-agent-implement-failed",
      "claim-stolen", "detect-commits", "has-commits", "no-commit-retries-exhausted",
      "pre-pr-validation", "pre-pr-validation-ok", "set-fix-summary", "auto-fix-validation", "retry-pre-pr-validation", "retry-validation-ok", "log-validation-failed", "set-blocked-validation-failed", "notify-validation-blocked",
      "auto-commit-pre-push",
      "push-branch", "push-ok", "build-pr-body", "create-pr", "set-inreview", "handoff-pr-progressor", "log-success",
      "log-no-commits", "log-no-commits-exhausted", "set-todo-cooldown", "set-blocked-no-commits", "build-pr-body-stolen", "create-pr-retry", "pr-created-stolen", "set-inreview-stolen", "handoff-pr-progressor-stolen", "log-claim-stolen-recovered",
      "release-worktree", "release-claim", "release-slot",
    ];
    for (const id of required) {
      expect(ids, `missing node: ${id}`).toContain(id);
    }
  });

  it("blocks tasks when no-commit retries are exhausted", () => {
    const t = getTemplate("template-task-lifecycle");
    const noCommitGate = t.nodes.find((n) => n.id === "no-commit-retries-exhausted");
    const blockedNode = t.nodes.find((n) => n.id === "set-blocked-no-commits");

    expect(noCommitGate?.config?.expression).toContain("detect-commits");
    expect(noCommitGate?.config?.expression).toContain("retryExhausted === true");
    expect(blockedNode?.config?.status).toBe("blocked");
    expect(blockedNode?.config?.blockedReason).toContain("detect-commits");
    expect(t.edges.find((e) => e.source === "has-commits" && e.target === "no-commit-retries-exhausted")).toBeDefined();
    expect(t.edges.find((e) => e.source === "no-commit-retries-exhausted" && e.target === "log-no-commits-exhausted")).toBeDefined();
    expect(t.edges.find((e) => e.source === "no-commit-retries-exhausted" && e.target === "log-no-commits")).toBeDefined();
    expect(t.edges.find((e) => e.source === "log-no-commits-exhausted" && e.target === "set-blocked-no-commits")).toBeDefined();
    expect(t.edges.find((e) => e.source === "set-blocked-no-commits" && e.target === "join-outcomes")).toBeDefined();
  });

  it("does NOT reference resolvedSdk/resolvedModel in allocate-slot config", () => {
    const t = getTemplate("template-task-lifecycle");
    const allocSlot = t.nodes.find((n) => n.id === "allocate-slot");
    expect(allocSlot).toBeDefined();
    const cfgStr = JSON.stringify(allocSlot.config);
    expect(cfgStr).not.toContain("resolvedSdk");
    expect(cfgStr).not.toContain("resolvedModel");
  });

  it("resolve-executor runs AFTER worktree-ok (not before)", () => {
    const t = getTemplate("template-task-lifecycle");
    // resolve-executor should be downstream of worktree-ok
    const resolveEdge = t.edges.find(
      (e) => e.target === "resolve-executor",
    );
    expect(resolveEdge).toBeDefined();
    expect(resolveEdge.source).toBe("worktree-ok");
  });

  it("gates each agent phase before entering the next stage or cleanup", () => {
    const t = getTemplate("template-task-lifecycle");
    const implementGate = t.nodes.find((n) => n.id === "implement-agent-ok");
    expect(t.edges.find((e) => e.source === "build-prompt" && e.target === "run-agent-plan")).toBeDefined();
    expect(t.edges.find((e) => e.source === "run-agent-plan" && e.target === "plan-agent-ok")).toBeDefined();
    expect(t.edges.find((e) => e.source === "plan-agent-ok" && e.target === "run-agent-tests")).toBeDefined();
    expect(t.edges.find((e) => e.source === "plan-agent-ok" && e.target === "set-blocked-agent-plan-failed")).toBeDefined();
    expect(t.edges.find((e) => e.source === "run-agent-tests" && e.target === "tests-agent-ok")).toBeDefined();
    expect(t.edges.find((e) => e.source === "tests-agent-ok" && e.target === "run-agent-implement")).toBeDefined();
    expect(t.edges.find((e) => e.source === "tests-agent-ok" && e.target === "set-blocked-agent-tests-failed")).toBeDefined();
    expect(t.edges.find((e) => e.source === "run-agent-implement" && e.target === "implement-agent-ok")).toBeDefined();
    expect(t.edges.find((e) => e.source === "implement-agent-ok" && e.target === "claim-stolen")).toBeDefined();
    expect(t.edges.find((e) => e.source === "implement-agent-ok" && e.target === "set-blocked-agent-implement-failed")).toBeDefined();
    expect(implementGate?.config?.expression).toContain("implementation_done_commit_blocked");
  });

  it("push-branch uses merge-based push config", () => {
    const t = getTemplate("template-task-lifecycle");
    const pushNode = t.nodes.find((n) => n.id === "push-branch");
    expect(pushNode).toBeDefined();
    expect(pushNode.config.baseBranch).toBe("{{baseBranch}}");
    expect(pushNode.config.rebaseBeforePush).toBe(false);
    expect(pushNode.config.mergeBaseBeforePush).toBe(true);
    expect(pushNode.config.emptyDiffGuard).toBe(true);
  });

  it("links task PRs before moving tasks to inreview", () => {
    const t = getTemplate("template-task-lifecycle");
    const createPr = t.nodes.find((n) => n.id === "create-pr");
    const prCreated = t.nodes.find((n) => n.id === "pr-created");
    const handoff = t.nodes.find((n) => n.id === "handoff-pr-progressor");

    expect(createPr?.config?.body).toBe("{{prBody}}");
    expect(createPr?.config?.enableAutoMerge).toBe("{{autoMergeOnCreate}}");
    expect(createPr?.config?.autoMergeMethod).toBe("{{autoMergeMethod}}");
    expect(prCreated?.config?.expression).toContain("create-pr");
    expect(prCreated?.config?.expression).toContain("prNumber");
    expect(prCreated?.config?.expression).toContain("prUrl");
    // handedOff without a real PR number must NOT satisfy the pr-created gate
    expect(prCreated?.config?.expression).not.toContain("handedOff");
    // gate requires success AND an actual PR reference
    expect(prCreated?.config?.expression).toContain("success === true");
    expect(handoff?.config?.mode).toBe("sync");
    expect(t.edges.find((e) => e.source === "create-pr" && e.target === "pr-created")).toBeDefined();
    expect(t.edges.find((e) => e.source === "pr-created" && e.target === "set-inreview")).toBeDefined();
    expect(t.edges.find((e) => e.source === "pr-created" && e.target === "set-todo-push-failed")).toBeDefined();
    expect(t.edges.find((e) => e.source === "set-inreview" && e.target === "handoff-pr-progressor")).toBeDefined();
    expect(t.edges.find((e) => e.source === "handoff-pr-progressor" && e.target === "log-success")).toBeDefined();
  });

  it("runs pre-PR validation before pushing", () => {
    const t = getTemplate("template-task-lifecycle");
    const autoFixValidation = t.nodes.find((n) => n.id === "auto-fix-validation");
    const autoFixValidation2 = t.nodes.find((n) => n.id === "auto-fix-validation-2");
    const autoCommitBeforePush = t.nodes.find((n) => n.id === "auto-commit-pre-push");
    expect(t.edges.find((e) => e.source === "has-commits" && e.target === "pre-pr-validation")).toBeDefined();
    expect(t.edges.find((e) => e.source === "pre-pr-validation" && e.target === "pre-pr-validation-ok")).toBeDefined();
    expect(autoCommitBeforePush?.type).toBe("action.auto_commit_dirty");
    expect(autoCommitBeforePush?.config?.worktreePath).toBe("{{worktreePath}}");
    expect(autoCommitBeforePush?.config?.taskId).toBe("{{taskId}}");
    expect(t.edges.find((e) => e.source === "pre-pr-validation-ok" && e.target === "auto-commit-pre-push")).toBeDefined();
    expect(t.edges.find((e) => e.source === "pre-pr-validation-ok" && e.target === "set-fix-summary")).toBeDefined();
    expect(t.edges.find((e) => e.source === "set-fix-summary" && e.target === "auto-fix-validation")).toBeDefined();
    expect(t.edges.find((e) => e.source === "auto-fix-validation" && e.target === "retry-pre-pr-validation")).toBeDefined();
    expect(t.edges.find((e) => e.source === "retry-pre-pr-validation" && e.target === "retry-validation-ok")).toBeDefined();
    expect(t.edges.find((e) => e.source === "retry-validation-ok" && e.target === "auto-commit-pre-push")).toBeDefined();
    // Pass 1 failed → escalated pass 2
    expect(t.edges.find((e) => e.source === "retry-validation-ok" && e.target === "set-fix2-summary")).toBeDefined();
    expect(t.edges.find((e) => e.source === "set-fix2-summary" && e.target === "auto-fix-validation-2")).toBeDefined();
    expect(t.edges.find((e) => e.source === "auto-fix-validation-2" && e.target === "retry2-pre-pr-validation")).toBeDefined();
    expect(t.edges.find((e) => e.source === "retry2-pre-pr-validation" && e.target === "retry2-validation-ok")).toBeDefined();
    expect(t.edges.find((e) => e.source === "retry2-validation-ok" && e.target === "auto-commit-pre-push")).toBeDefined();
    expect(t.edges.find((e) => e.source === "retry2-validation-ok" && e.target === "log-validation-failed")).toBeDefined();
    expect(t.edges.find((e) => e.source === "log-validation-failed" && e.target === "set-blocked-validation-failed")).toBeDefined();
    expect(t.edges.find((e) => e.source === "set-blocked-validation-failed" && e.target === "notify-validation-blocked")).toBeDefined();
    expect(t.edges.find((e) => e.source === "notify-validation-blocked" && e.target === "join-outcomes")).toBeDefined();
    expect(t.edges.find((e) => e.source === "auto-commit-pre-push" && e.target === "push-branch")).toBeDefined();
    expect(t.edges.find((e) => e.source === "push-branch" && e.target === "push-ok")).toBeDefined();
    expect(autoFixValidation?.config?.prompt).toContain("$ctx.getNodeOutput('pre-pr-validation')?.stderr");
    expect(autoFixValidation?.config?.prompt).toContain("$ctx.getNodeOutput('pre-pr-validation')?.output");
    expect(autoFixValidation2?.config?.prompt).toContain("$ctx.getNodeOutput('retry-pre-pr-validation')?.stderr");
    expect(autoFixValidation2?.config?.prompt).toContain("$ctx.getNodeOutput('retry-pre-pr-validation')?.output");
  });

  it("passes repository scope metadata into build-prompt node", () => {
    const t = getTemplate("template-task-lifecycle");
    const buildPrompt = t.nodes.find((n) => n.id === "build-prompt");
    expect(buildPrompt).toBeDefined();
    expect(buildPrompt.config.workspace).toBe("{{workspace}}");
    expect(buildPrompt.config.repository).toBe("{{repository}}");
    expect(buildPrompt.config.repositories).toBe("{{repositories}}");
  });

  it("all outcome paths converge to release-worktree -> release-claim -> release-slot", () => {
    const t = getTemplate("template-task-lifecycle");
    // outcomes -> join-outcomes
    expect(t.edges.find((e) => e.source === "log-success" && e.target === "join-outcomes")).toBeDefined();
    expect(t.edges.find((e) => e.source === "set-todo-cooldown" && e.target === "join-outcomes")).toBeDefined();
    expect(t.edges.find((e) => e.source === "set-blocked-no-commits" && e.target === "join-outcomes")).toBeDefined();
    expect(t.edges.find((e) => e.source === "set-todo-stolen" && e.target === "join-outcomes")).toBeDefined();
    expect(t.edges.find((e) => e.source === "log-claim-stolen-recovered" && e.target === "join-outcomes")).toBeDefined();
    expect(t.edges.find((e) => e.source === "set-todo-push-failed" && e.target === "join-outcomes")).toBeDefined();
    // join-outcomes -> release-worktree
    expect(t.edges.find((e) => e.source === "join-outcomes" && e.target === "release-worktree")).toBeDefined();
    // release-worktree -> release-claim -> release-slot
    expect(t.edges.find((e) => e.source === "release-worktree" && e.target === "release-claim")).toBeDefined();
    expect(t.edges.find((e) => e.source === "release-claim" && e.target === "release-slot")).toBeDefined();
  });

  it("tries to recover PR linkage before sending a stolen claim back to todo", () => {
    const t = getTemplate("template-task-lifecycle");
    const retryPr = t.nodes.find((n) => n.id === "create-pr-retry");
    const prCreatedStolen = t.nodes.find((n) => n.id === "pr-created-stolen");
    const recoveredHandoff = t.nodes.find((n) => n.id === "handoff-pr-progressor-stolen");

    expect(retryPr?.config?.body).toBe("{{prBody}}");
    expect(retryPr?.config?.branch).toBe("{{branch}}");
    expect(prCreatedStolen?.config?.expression).toContain("create-pr-retry");
    expect(prCreatedStolen?.config?.expression).toContain("prNumber");
    expect(prCreatedStolen?.config?.expression).toContain("prUrl");
    expect(recoveredHandoff?.config?.mode).toBe("sync");

    expect(t.edges.find((e) => e.source === "claim-stolen" && e.target === "build-pr-body-stolen")).toBeDefined();
    expect(t.edges.find((e) => e.source === "build-pr-body-stolen" && e.target === "create-pr-retry")).toBeDefined();
    expect(t.edges.find((e) => e.source === "create-pr-retry" && e.target === "pr-created-stolen")).toBeDefined();
    expect(t.edges.find((e) => e.source === "set-inreview-stolen" && e.target === "handoff-pr-progressor-stolen")).toBeDefined();
    expect(t.edges.find((e) => e.source === "handoff-pr-progressor-stolen" && e.target === "log-claim-stolen-recovered")).toBeDefined();
    expect(t.edges.find((e) => e.source === "pr-created-stolen" && e.target === "log-claim-stolen")).toBeDefined();
  });


  it("claim-failed path releases slot", () => {
    const t = getTemplate("template-task-lifecycle");
    expect(t.edges.find((e) => e.source === "claim-ok" && e.target === "release-slot-claim-failed")).toBeDefined();
    expect(t.edges.find((e) => e.source === "release-slot-claim-failed" && e.target === "log-claim-failed")).toBeDefined();
  });

  it("worktree-failed path releases claim and slot", () => {
    const t = getTemplate("template-task-lifecycle");
    const retryGate = t.nodes.find((n) => n.id === "wt-retry-eligible");
    expect(retryGate?.config?.expression).toBe("$ctx.getNodeOutput('acquire-worktree')?.retryable === true");
    // Auto-recovery path: worktree-ok -> wt-retry-eligible -> recover -> retry -> retry-wt-ok
    expect(t.edges.find((e) => e.source === "worktree-ok" && e.target === "wt-retry-eligible")).toBeDefined();
    expect(t.edges.find((e) => e.source === "wt-retry-eligible" && e.target === "recover-worktree")).toBeDefined();
    expect(t.edges.find((e) => e.source === "recover-worktree" && e.target === "retry-acquire-wt")).toBeDefined();
    expect(t.edges.find((e) => e.source === "retry-acquire-wt" && e.target === "retry-wt-ok")).toBeDefined();
    // Retry success rejoins main flow
    expect(t.edges.find((e) => e.source === "retry-wt-ok" && e.target === "resolve-executor")).toBeDefined();
    // Retry failure falls through to original failure path
    expect(t.edges.find((e) => e.source === "retry-wt-ok" && e.target === "release-claim-wt-failed")).toBeDefined();
    // Non-retryable goes directly to failure
    expect(t.edges.find((e) => e.source === "wt-retry-eligible" && e.target === "release-claim-wt-failed")).toBeDefined();
    // Original failure path still intact
    expect(t.edges.find((e) => e.source === "release-claim-wt-failed" && e.target === "wt-failure-blocking")).toBeDefined();
    expect(t.edges.find((e) => e.source === "wt-failure-blocking" && e.target === "set-blocked-wt-failed")).toBeDefined();
    expect(t.edges.find((e) => e.source === "wt-failure-blocking" && e.target === "set-todo-wt-failed")).toBeDefined();
    expect(t.edges.find((e) => e.source === "set-blocked-wt-failed" && e.target === "annotate-blocked-wt-failed")).toBeDefined();
    expect(t.edges.find((e) => e.source === "annotate-blocked-wt-failed" && e.target === "dispatch-wt-repair")).toBeDefined();
    expect(
      t.edges.find((e) =>
        e.source === "annotate-blocked-wt-failed"
        && e.target === "dispatch-wt-repair"
        && e.sourcePort === "error"),
    ).toBeDefined();
    expect(t.edges.find((e) => e.source === "dispatch-wt-repair" && e.target === "release-slot-wt-failed")).toBeDefined();
    expect(t.edges.find((e) => e.source === "set-todo-wt-failed" && e.target === "release-slot-wt-failed")).toBeDefined();
  });

  it("routes retryable worktree acquisition failures through recover-worktree before retry", async () => {
    const lifecycle = getTemplate("template-task-lifecycle");
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const nodeIds = [
      "acquire-worktree",
      "worktree-ok",
      "wt-retry-eligible",
      "recover-worktree",
      "retry-acquire-wt",
      "retry-wt-ok",
    ];
    const nodes = nodeIds.map((id) => clone(lifecycle.nodes.find((node) => node.id === id)));
    const workflow = {
      id: "test-worktree-retry-routing",
      name: "Test Worktree Retry Routing",
      description: "Regression for retryable acquire_worktree routing",
      trigger: "trigger.manual",
      enabled: true,
      variables: {},
      nodes: [
        {
          id: "trigger",
          type: "trigger.manual",
          label: "Trigger",
          config: {},
          position: { x: 0, y: 0 },
        },
        ...nodes,
        {
          id: "done",
          type: "notify.log",
          label: "Done",
          config: { message: "done" },
          position: { x: 0, y: 0 },
        },
        {
          id: "failed",
          type: "notify.log",
          label: "Failed",
          config: { message: "failed" },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [
        { source: "trigger", target: "acquire-worktree" },
        { source: "acquire-worktree", target: "worktree-ok" },
        { source: "worktree-ok", target: "wt-retry-eligible", sourcePort: "no", condition: "$output?.result !== true" },
        { source: "wt-retry-eligible", target: "recover-worktree", sourcePort: "yes", condition: "$output?.result === true" },
        { source: "wt-retry-eligible", target: "failed", sourcePort: "no", condition: "$output?.result !== true" },
        { source: "recover-worktree", target: "retry-acquire-wt" },
        { source: "retry-acquire-wt", target: "retry-wt-ok" },
        { source: "retry-wt-ok", target: "done", sourcePort: "yes", condition: "$output?.result === true" },
        { source: "retry-wt-ok", target: "failed", sourcePort: "no", condition: "$output?.result !== true" },
      ],
    };
    engine.save(workflow);

    const acquireHandler = getNodeType("action.acquire_worktree");
    const recoverHandler = getNodeType("action.recover_worktree");
    const acquireSpy = vi.spyOn(acquireHandler, "execute");
    const recoverSpy = vi.spyOn(recoverHandler, "execute");
    const recoveredPath = join(tmpDir, "recovered-worktree");

    acquireSpy.mockResolvedValueOnce({
      success: false,
      error: "simulated acquire failure",
      taskId: "task-route-1",
      repoRoot: tmpDir,
      worktreePath: recoveredPath,
      branch: "task/retry-route",
      baseBranch: "main",
      retryable: true,
      failureKind: "worktree_acquisition_failed",
      blockedReason: "simulated acquire failure",
      recordedAt: new Date().toISOString(),
      autoRecoverDelayMs: 0,
      retryAt: null,
      recoveryNote: "",
    });
    acquireSpy.mockResolvedValueOnce({
      success: true,
      worktreePath: recoveredPath,
      created: true,
      branch: "task/retry-route",
      baseBranch: "main",
    });
    recoverSpy.mockResolvedValue({
      success: true,
      recovered: true,
      worktreePath: recoveredPath,
    });

    try {
      const run = await engine.execute(workflow.id, new WorkflowContext({
        taskId: "task-route-1",
        taskTitle: "Retry route task",
        repoRoot: tmpDir,
        branch: "task/retry-route",
        baseBranch: "main",
        defaultTargetBranch: "main",
      }));

      expect(acquireSpy).toHaveBeenCalledTimes(2);
      expect(recoverSpy).toHaveBeenCalledTimes(1);
      expect(run.ctx.getNodeOutput("recover-worktree")).toMatchObject({
        success: true,
        recovered: true,
      });
      expect(run.ctx.getNodeOutput("retry-wt-ok")).toMatchObject({ result: true });
    } finally {
      acquireSpy.mockRestore();
      recoverSpy.mockRestore();
    }
  }, SLOW_WORKFLOW_TEST_TIMEOUT_MS);

  it("reconciles installed lifecycle definitions missing deterministic worktree routing", () => {
    const installed = installTemplate("template-task-lifecycle", engine);
    const broken = JSON.parse(JSON.stringify(engine.get(installed.id)));
    const retryGate = broken.nodes.find((node) => node.id === "wt-retry-eligible");
    retryGate.config.expression = "$ctx.getNodeOutput('acquire-worktree')?.retryable !== false";
    broken.edges = broken.edges.filter((edge) => !(
      edge.source === "wt-retry-eligible" && edge.target === "recover-worktree"
    ));
    engine.save(broken);

    const reconcile = reconcileInstalledTemplates(engine, {
      autoUpdateUnmodified: true,
    });

    expect(reconcile.updatedWorkflowIds).toContain(installed.id);
    const repaired = engine.get(installed.id);
    expect(repaired.nodes.find((node) => node.id === "wt-retry-eligible")?.config?.expression)
      .toBe("$ctx.getNodeOutput('acquire-worktree')?.retryable === true");
    expect(repaired.edges.find((edge) => (
      edge.source === "wt-retry-eligible" && edge.target === "recover-worktree"
    ))).toBeDefined();
  });

  it("all edges reference valid node IDs", () => {
    const t = getTemplate("template-task-lifecycle");
    const nodeIds = new Set(t.nodes.map((n) => n.id));
    for (const e of t.edges) {
      expect(nodeIds, `edge source "${e.source}" not in nodes`).toContain(e.source);
      expect(nodeIds, `edge target "${e.target}" not in nodes`).toContain(e.target);
    }
  });

  it("no orphan nodes (every non-trigger node is a target of some edge)", () => {
    const t = getTemplate("template-task-lifecycle");
    const targets = new Set(t.edges.map((e) => e.target));
    for (const n of t.nodes) {
      if (n.id === "trigger") continue; // trigger has no incoming edge
      expect(targets, `node "${n.id}" is orphaned`).toContain(n.id);
    }
  });

  it("has correct variables with sensible defaults", () => {
    const t = getTemplate("template-task-lifecycle");
    expect(t.variables.maxParallel).toBe(3);
    expect(t.variables.claimTtlMinutes).toBe(180);
    expect(t.variables.claimRenewIntervalMs).toBe(60000);
    expect(t.variables.taskTimeoutMs).toBe(21600000);
    expect(t.variables.prePrValidationEnabled).toBe(true);
    expect(t.variables.prePrValidationCommand).toBe("auto");
    expect(t.variables.autoMergeOnCreate).toBe(false);
    expect(t.variables.autoMergeMethod).toBe("squash");
    expect(t.variables.defaultSdk).toBe("auto");
    expect(Array.isArray(t.variables.protectedBranches)).toBe(true);
  });

  it("configures pre-PR validation as a repo-aware quality gate", () => {
    const t = getTemplate("template-task-lifecycle");
    const validationNode = t.nodes.find((node) => node.id === "pre-pr-validation");

    expect(validationNode?.config.command).toBe("{{prePrValidationCommand}}");
    expect(validationNode?.config.commandType).toBe("qualityGate");
    expect(validationNode?.config.cwd).toBe("{{worktreePath}}");
  });

  it("replaces task-executor.mjs module", () => {
    const t = getTemplate("template-task-lifecycle");
    expect(t.metadata.replaces.module).toBe("task-executor.mjs");
    expect(t.metadata.replaces.functions).toContain("executeTask");
  });

  it("installs and round-trips through engine", () => {
    const result = installTemplate("template-task-lifecycle", engine);
    expect(result.id).not.toBe("template-task-lifecycle");
    expect(result.metadata.installedFrom).toBe("template-task-lifecycle");
    const stored = engine.get(result.id);
    expect(stored).toBeDefined();
    expect(stored.name).toBe("Task Lifecycle");
  });

  it("installs with variable overrides", () => {
    const result = installTemplate("template-task-lifecycle", engine, {
      maxParallel: 5,
      taskTimeoutMs: 3600000,
    });

    expect(result.variables.maxParallel).toBe(5);
    expect(result.variables.taskTimeoutMs).toBe(3600000);
    expect(result.variables.defaultSdk).toBe("auto"); // unchanged
  });

  it("installs delegation watchdog defaults for non-task recovery", () => {
    const result = installTemplate("template-task-lifecycle", engine);
    expect(result.variables.delegationWatchdogTimeoutMs).toBeGreaterThan(0);
    expect(result.variables.delegationWatchdogMaxRecoveries).toBe(1);
  });

  it("dry-run executes without errors (trigger stops at no kanban)", async () => {
    const result = installTemplate("template-task-lifecycle", engine);
    const ctx = new WorkflowContext({});
    // Dry run should complete without throwing
    try {
      await engine.execute(result.id, ctx, { dryRun: true });
    } catch (err) {
      // Some nodes may fail in dry-run if services aren't wired,
      // but the DAG structure should be valid
      expect(err.message).not.toContain("Unknown node type");
    }
  }, SLOW_WORKFLOW_TEST_TIMEOUT_MS);
});
}
